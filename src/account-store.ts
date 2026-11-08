import { lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
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
  saveHealth(name: string, health: AccountHealth): void {
    privatePath(this.root, true); privatePath(this.directory(name), true);
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
