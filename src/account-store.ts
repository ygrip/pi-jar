import { closeSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { Provider } from "@earendil-works/pi-ai";
import { validAccountName } from "./account-settings.ts";

export interface AccountDefinition {
  version: 1;
  name: string;
  provider: string;
  /** OAuth credentials stay in the account's private auth.json, never in settings/profiles. */
  auth: "oauth" | "env";
  env?: string;
}
export interface AccountHealth { blockedUntil?: number; quota?: import("./quota.ts").Quota; checkedAt?: number }
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
  constructor(directory: string) { this.root = join(directory, "pi-jar-accounts"); }
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
        || (raw.auth === "env" && (typeof raw.env !== "string" || !ENV_NAME.test(raw.env)))) {
        throw new Error(`Invalid account metadata: ${name}`);
      }
      this.credentialPath(name);
      accounts.push({ version: 1, name, provider: raw.provider, auth: raw.auth!, env: raw.env });
    }
    return accounts;
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

  /** Check credential presence without reading or exposing secret values. */
  hasCredentials(account: AccountDefinition): boolean {
    if (account.auth === "env") return Boolean(account.env && process.env[account.env]);
    const path = this.credentialPath(account.name);
    try { privatePath(path, false); return true; }
    catch (error) { if (missing(error)) return false; throw error; }
  }

  /** Sign out one OAuth account while keeping its label for reconnect. */
  logout(name: string): void {
    const account = this.list().find(item => item.name === name);
    if (!account) throw new Error("Unknown account: " + name);
    if (account.auth !== "oauth") throw new Error("API-key accounts must be removed or their environment changed");
    const path = this.credentialPath(name);
    try { privatePath(path, false); unlinkSync(path); }
    catch (error) { if (!missing(error)) throw error; }
    this.saveHealth(name, {});
  }

  /** Remove one account's private credentials, never Pi's main login or arbitrary files. */
  remove(name: string): void {
    if (!this.list().some(account => account.name === name)) throw new Error("Unknown account: " + name);
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

  /** Reserve the name before login so two sessions cannot silently overwrite an account. */
  reserve(name: string): void {
    this.ensureRoot();
    mkdirSync(this.directory(name), { mode: 0o700 });
  }
  save(account: AccountDefinition): void {
    privatePath(this.directory(account.name), true);
    writeFileSync(join(this.directory(account.name), "account.json"), JSON.stringify(account) + "\n", { flag: "wx", mode: 0o600 });
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
    const models = await ModelRuntime.create({ authPath: this.credentialPath(account.name), modelsPath: null, refreshOnCreate: false });
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
