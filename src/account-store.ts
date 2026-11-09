import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { Provider } from "@earendil-works/pi-ai";
import { validAccountName, validProviderId } from "./account-settings.ts";

export interface AccountDefinition {
  version: 1;
  name: string;
  provider: string;
  /** Named OAuth credentials are private unless source is the linked Pi login. */
  auth: "oauth" | "env";
  env?: string;
  /** Reuse Pi's primary auth.json and refresh lock; never duplicate its OAuth tokens. */
  source?: "native";
}
export interface AccountHealth { blockedUntil?: number; quota?: import("./quota.ts").Quota; checkedAt?: number; credentialGeneration?: string }
const ENV_NAME = /^[A-Z_][A-Z0-9_]{0,127}$/;
/** Health updates hold the lock for one small read and write; anything older crashed mid-update. */
const HEALTH_LOCK_STALE_MS = 10_000;
const HEALTH_LOCK_TIMEOUT_MS = 2_000;
const HEALTH_LOCK_RETRY_MS = 5;
const lockWait = new Int32Array(new SharedArrayBuffer(4));

/**
 * Combine a proposed health record with the one on disk. Cooldowns only extend: a stale quota
 * refresh must never clear a 429 cooldown another process recorded meanwhile.
 */
export function mergeHealth(current: AccountHealth, next: AccountHealth): AccountHealth {
  const merged: AccountHealth = { ...current, ...next };
  const blockedUntil = Math.max(current.blockedUntil ?? 0, next.blockedUntil ?? 0);
  if (blockedUntil > 0) merged.blockedUntil = blockedUntil;
  else delete merged.blockedUntil;
  if ((current.checkedAt ?? 0) > (next.checkedAt ?? 0)) {
    merged.quota = current.quota;
    merged.checkedAt = current.checkedAt;
  }
  return merged;
}

function privatePath(path: string, directory: boolean): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || (directory && !stat.isDirectory()) || (!directory && !stat.isFile())) {
    throw new Error("Account storage must contain regular files and directories, not links");
  }
  if (process.platform !== "win32" && ((stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid()))) {
    throw new Error("Account storage must be owned by you and private (directories 700, files 600)");
  }
}
function missing(error: unknown): boolean { return (error as NodeJS.ErrnoException).code === "ENOENT"; }

/** Only global, private account files are trusted. No project credentials, commands or custom endpoints. */
export class AccountStore {
  readonly root: string;
  readonly agentDirectory: string;
  constructor(directory: string) { this.agentDirectory = directory; this.root = join(directory, "pi-jar-accounts"); }
  private directory(name: string): string {
    if (!validAccountName(name)) throw new Error("Account names must be lowercase letters, digits and hyphens (1–32 characters)");
    return join(this.root, name);
  }
  private ensureRoot(): void {
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    privatePath(this.root, true);
  }
  list(): AccountDefinition[] {
    try { privatePath(this.root, true); }
    catch (error) { if (missing(error)) return []; throw error; }
    const accounts: AccountDefinition[] = [];
    for (const name of readdirSync(this.root).sort()) {
      if (!validAccountName(name)) continue;
      const directory = this.directory(name);
      privatePath(directory, true);
      const path = join(directory, "account.json");
      try { privatePath(path, false); }
      catch (error) { if (missing(error)) continue; throw error; }
      let value: unknown;
      try { value = JSON.parse(readFileSync(path, "utf8")); }
      catch { throw new Error(`Invalid account metadata: ${name}`); }
      const raw = value as Partial<AccountDefinition> | undefined;
      if (!raw || raw.version !== 1 || raw.name !== name || typeof raw.provider !== "string"
        || raw.provider.length === 0 || raw.provider.length > 256 || /[\u0000-\u001f\u007f]/.test(raw.provider) || !["oauth", "env"].includes(raw.auth ?? "")
        || (raw.auth === "env" && (typeof raw.env !== "string" || !ENV_NAME.test(raw.env)))
        || (raw.source !== undefined && (raw.source !== "native" || raw.auth !== "oauth"))) {
        throw new Error(`Invalid account metadata: ${name}`);
      }
      this.credentialPath(name);
      accounts.push({ version: 1, name, provider: raw.provider, auth: raw.auth!, env: raw.env, source: raw.source });
    }
    return accounts;
  }
  /**
   * Auto-link OAuth logins already held by native Pi. Only the credential metadata
   * (provider and type) is enumerated via Pi's public ModelRuntime API. Never read,
   * copy, or persist the native access/refresh tokens in an account directory.
   *
   * Registration is idempotent, preserves user-created names, and is safe when
   * multiple Pi processes start at once. A Pi sign-out leaves the linked label
   * disconnected until native Pi signs in again.
   */
  async discoverNativeAccounts(supportsOAuth: (providerId: string) => boolean): Promise<AccountDefinition[]> {
    const authPath = join(this.agentDirectory, "auth.json");
    if (!existsSync(authPath)) return [];
    const runtime = await ModelRuntime.create({ authPath, modelsPath: null, refreshOnCreate: false });
    const known = this.list();
    for (const credential of await runtime.listCredentials()) {
      const provider = credential.providerId;
      if (credential.type !== "oauth" || !validProviderId(provider) || !supportsOAuth(provider)) continue;
      if (known.some(account => account.source === "native" && account.provider === provider)) continue;
      const simple = "pi-" + provider.toLowerCase().replace(/[^a-z0-9-]/g, "-");
      const hash = createHash("sha256").update(provider).digest("hex").slice(0, 8);
      const fallback = "pi-" + provider.toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 20) + "-" + hash;
      const name = validAccountName(simple) && !known.some(account => account.name === simple) ? simple : fallback;
      if (!validAccountName(name) || known.some(account => account.name === name)) continue;
      try { this.reserve(name); }
      catch (error) {
        // Another Pi process may have registered the same native account first.
        if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
        throw error;
      }
      const account: AccountDefinition = { version: 1, name, provider, auth: "oauth", source: "native" };
      try { this.save(account); }
      catch (error) {
        // A failed registration is never allowed to delete existing credentials.
        try { this.discardEmptyReservation(name); } catch { /* retain unexpected files for manual inspection */ }
        throw error;
      }
      known.push(account);
    }
    return known.filter(account => account.source === "native");
  }
  /**
   * Share Pi's installation identity when its global settings already have one.
   * Otherwise persist a private stable ID for native provider login flows that need it.
   * Never modify Pi's own settings or primary credentials.
   */
  deviceId(): string {
    try {
      const raw = JSON.parse(readFileSync(join(this.root, "..", "settings.json"), "utf8")) as { deviceId?: unknown };
      if (typeof raw?.deviceId === "string" && /^[\da-f-]{36}$/i.test(raw.deviceId)) return raw.deviceId;
    } catch { /* Pi has not assigned an installation ID yet. */ }
    this.ensureRoot();
    const path = join(this.root, ".device-id");
    try {
      privatePath(path, false);
      const id = readFileSync(path, "utf8").trim();
      if (!/^[\da-f-]{36}$/i.test(id)) throw new Error("Invalid private account device ID");
      return id;
    } catch (error) { if (!missing(error)) throw error; }
    const id = randomUUID();
    try { writeFileSync(path, id + "\n", { flag: "wx", mode: 0o600 }); return id; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return this.deviceId();
      throw error;
    }
  }

  /**
   * Check that a usable credential exists without exposing secret values. An OAuth account counts only
   * if its private auth file holds an OAuth entry for this account's provider: Pi creates an empty
   * `{}` file on first use, and a file for another provider proves nothing.
   */
  hasCredentials(account: AccountDefinition): boolean {
    if (account.auth === "env") return Boolean(account.env && process.env[account.env]);
    const path = account.source === "native" ? join(this.agentDirectory, "auth.json") : this.credentialPath(account.name);
    let raw: string;
    try { privatePath(path, false); raw = readFileSync(path, "utf8"); }
    catch (error) { if (missing(error)) return false; throw error; }
    return this.holdsOAuthEntry(raw, account);
  }
  /** Read an optional email claim locally; no profile request or identity is persisted. */
  email(account: AccountDefinition): string | undefined {
    if (account.auth !== "oauth" || account.provider !== "openai-codex") return undefined;
    const path = account.source === "native" ? join(this.agentDirectory, "auth.json") : this.credentialPath(account.name);
    let raw: string;
    try { privatePath(path, false); raw = readFileSync(path, "utf8"); }
    catch (error) { if (missing(error)) return undefined; throw error; }
    let data: Record<string, unknown>;
    try { data = JSON.parse(raw) as Record<string, unknown>; }
    catch { throw new Error(`Account ${account.name} has an unreadable credential file`); }
    const entry = data?.[account.provider];
    if (!entry || typeof entry !== "object") return undefined;
    const credential = entry as Record<string, unknown>;
    if (credential.type !== "oauth") return undefined;
    const token = credential.access;
    if (typeof token !== "string" || token.length > 32768) return undefined;
    const parts = token.split(".");
    if (parts.length !== 3 || !parts[1]) return undefined;
    let claims: Record<string, unknown>;
    try { claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as Record<string, unknown>; }
    catch { return undefined; }
    const profile = claims?.["https://api.openai.com/profile"];
    let email = claims?.email;
    if (profile && typeof profile === "object") email = (profile as Record<string, unknown>).email ?? email;
    if (typeof email !== "string" || email.length > 254 || !/^[\x21-\x3f\x41-\x7e]+@[\x21-\x3f\x41-\x7e]+$/.test(email)) return undefined;
    return email;
  }
  private holdsOAuthEntry(raw: string, account: AccountDefinition): boolean {
    let stored: unknown;
    try { stored = JSON.parse(raw); }
    catch { throw new Error(`Account ${account.name} has an unreadable credential file`); }
    if (!stored || typeof stored !== "object" || Array.isArray(stored)) return false;
    const entry = (stored as Record<string, unknown>)[account.provider];
    if (!entry || typeof entry !== "object") return false;
    // The structure Pi's own credential loader requires; anything less cannot sign a request.
    const { type, access, refresh, expires } = entry as Record<string, unknown>;
    return type === "oauth" && typeof access === "string" && typeof refresh === "string"
      && typeof expires === "number" && Number.isFinite(expires);
  }

  /**
   * Sign out one OAuth account while keeping its label for reconnect. The credential is deleted
   * through Pi's own credential store, under the same auth-file lock a native OAuth refresh holds:
   * another Pi process that is mid-refresh finishes first, so its write can never bring the
   * credential back after sign-out.
   */
  async logout(name: string): Promise<void> {
    const account = this.list().find(item => item.name === name);
    if (!account) throw new Error("Unknown account: " + name);
    if (account.source === "native") throw new Error("This is Pi\'s primary login; use Pi /logout to sign out, not /jar accounts logout");
    if (account.auth !== "oauth") throw new Error("API-key accounts must be removed or their environment changed");
    const runtime = await ModelRuntime.create({ authPath: this.credentialPath(name), modelsPath: null, refreshOnCreate: false });
    await runtime.logout(account.provider);
    this.resetHealthForCredentialChange(name);
  }

  /** Remove one account's private credentials, never Pi's main login or arbitrary files. */
  remove(name: string): void {
    const account = this.list().find(account => account.name === name);
    if (!account) throw new Error("Unknown account: " + name);
    if (account.source === "native") throw new Error("Pi\'s native login cannot be removed here; sign out through Pi /logout");
    const directory = this.directory(name);
    privatePath(directory, true);
    const files = readdirSync(directory);
    const expected = new Set(["account.json", "auth.json", "health.json"]);
    for (const file of files) {
      if (!expected.has(file)) throw new Error(`Account ${name} has unexpected files or active locks; close other Pi sessions before removing it`);
      privatePath(join(directory, file), false);
    }
    for (const file of files) unlinkSync(join(directory, file));
    rmdirSync(directory);
  }

  /**
   * Reserve the name before login so another session cannot silently reuse it.
   * Incomplete older reservations must be explicitly recovered, never overwritten.
   */
  reserve(name: string): void {
    this.ensureRoot();
    mkdirSync(this.directory(name), { mode: 0o700 });
  }
  /**
   * Remove only an empty, private, incomplete reservation. Never delete a
   * credential, account metadata, lock or other file left by a partial login.
   * This is safe for automatic cleanup after an unsuccessful first login and
   * explicit /jar accounts recover NAME for older interrupted attempts.
   */
  discardEmptyReservation(name: string): void {
    this.ensureRoot();
    const directory = this.directory(name);
    privatePath(directory, true);
    const files = readdirSync(directory);
    // Pi ModelRuntime creates an empty auth.json as part of initialization,
    // even when browser authorization fails before any credential is issued.
    // Only an empty JSON object is provably credential-free. Never remove
    // populated/malformed auth files, metadata, locks or unknown files.
    if (files.length === 1 && files[0] === "auth.json") {
      const path = join(directory, "auth.json");
      privatePath(path, false);
      const raw = readFileSync(path, "utf8");
      let auth: unknown;
      try { auth = JSON.parse(raw); }
      catch { throw new Error(`Reservation ${name} contains an unreadable auth file; no credentials were removed`); }
      if (!auth || typeof auth !== "object" || Array.isArray(auth) || Object.keys(auth).length > 0) {
        throw new Error(`Reservation ${name} contains credential data; inspect it manually before reuse (nothing deleted)`);
      }
      unlinkSync(path);
    } else if (files.length > 0) {
      throw new Error(`Reservation ${name} contains files; inspect it manually before reuse (no credentials were removed)`);
    }
    rmdirSync(directory);
  }
  /** Advance an identity epoch when OAuth changes, invalidating old quota probes across processes. */
  resetHealthForCredentialChange(name: string): void {
    this.saveHealth(name, { credentialGeneration: randomUUID() });
  }
  save(account: AccountDefinition): void {
    privatePath(this.directory(account.name), true);
    writeFileSync(join(this.directory(account.name), "account.json"), JSON.stringify(account) + "\n", { flag: "wx", mode: 0o600 });
    // Every new account gets its own identity epoch. Without one, a label removed and re-created
    // (even for the same provider) would look identical to a stale in-flight quota probe or 429.
    this.resetHealthForCredentialChange(account.name);
  }
  /** Give an account created before identity epochs existed one, without touching its other health data. */
  ensureCredentialGeneration(name: string): void {
    this.updateHealth(name, current => current.credentialGeneration ? current : { ...current, credentialGeneration: randomUUID() });
  }
  private credentialPath(name: string): string {
    privatePath(this.root, true);
    privatePath(this.directory(name), true);
    const path = join(this.directory(name), "auth.json");
    try { privatePath(path, false); }
    catch (error) { if (!missing(error)) throw error; }
    return path;
  }
  async models(account: AccountDefinition, provider: Provider): Promise<ModelRuntime> {
    // Pi 1.5's public runtime owns file locking and rotated OAuth-token persistence.
    // Disable catalog IO and models.json: only this account's captured provider is used.
    const authPath = account.source === "native" ? join(this.agentDirectory, "auth.json") : this.credentialPath(account.name);
    const models = await ModelRuntime.create({ authPath, modelsPath: null, refreshOnCreate: false });
    if (account.auth === "env") {
      models.registerNativeProvider({ ...provider, auth: { apiKey: {
        name: "Account environment key",
        resolve: async () => {
          const key = process.env[account.env!];
          if (!key) throw new Error(`Missing environment variable for account ${account.name}`);
          return { auth: { apiKey: key }, source: account.env };
        }
      } } });
    } else models.registerNativeProvider({ ...provider, auth: { oauth: provider.auth.oauth } });
    return models;
  }
  health(name: string): AccountHealth {
    const path = join(this.directory(name), "health.json");
    try {
      privatePath(this.root, true); privatePath(this.directory(name), true); privatePath(path, false);
      const raw = JSON.parse(readFileSync(path, "utf8")) as AccountHealth;
      if (!raw || typeof raw !== "object") throw new Error("Invalid account health cache");
      return raw;
    } catch (error) { if (missing(error)) return {}; throw error; }
  }
  /**
   * Read, change and write `health.json` under a per-account lock file, so concurrent Pi
   * processes (main session and subagents) cannot overwrite each other's quota or cooldown.
   */
  updateHealth(name: string, change: (current: AccountHealth) => AccountHealth): AccountHealth {
    privatePath(this.root, true); privatePath(this.directory(name), true);
    const release = this.lockHealth(name);
    try {
      const current = this.health(name);
      const next = mergeHealth(current, change(current));
      this.writeHealth(name, next);
      return next;
    } finally { release(); }
  }
  private lockHealth(name: string): () => void {
    const path = join(this.directory(name), "health.lock");
    const deadline = Date.now() + HEALTH_LOCK_TIMEOUT_MS;
    while (true) {
      try {
        closeSync(openSync(path, "wx", 0o600));
        return () => {
          try { unlinkSync(path); } catch (error) { if (!missing(error)) throw error; }
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      this.removeStaleLock(path);
      if (Date.now() > deadline) throw new Error(`Account health is locked by another process: ${name}`);
      Atomics.wait(lockWait, 0, 0, HEALTH_LOCK_RETRY_MS);
    }
  }
  private removeStaleLock(path: string): void {
    let age: number;
    try { age = Date.now() - statSync(path).mtimeMs; }
    catch (error) { if (missing(error)) return; throw error; }
    if (age < HEALTH_LOCK_STALE_MS) return;
    try { unlinkSync(path); } catch (error) { if (!missing(error)) throw error; }
  }
  /** Replace health outright (e.g. clear a cooldown after re-login), still serialized by the lock. */
  saveHealth(name: string, health: AccountHealth): void {
    privatePath(this.root, true); privatePath(this.directory(name), true);
    const release = this.lockHealth(name);
    try { this.writeHealth(name, health); } finally { release(); }
  }
  private writeHealth(name: string, health: AccountHealth): void {
    const path = join(this.directory(name), "health.json");
    const temporary = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify(health) + "\n", { flag: "wx", mode: 0o600 });
      renameSync(temporary, path);
    } catch (error) {
      try { unlinkSync(temporary); } catch (cleanup) { if (!missing(cleanup)) throw cleanup; }
      throw error;
    }
  }
}
