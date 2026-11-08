import type { AuthInteraction, Provider } from "@earendil-works/pi-ai";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { AccountStore, type AccountDefinition } from "./account-store.ts";
import { AccountRouter } from "./account-router.ts";
import { QUOTA_PREFIX, QUOTA_TTL_MS } from "./quota.ts";
import { promptText } from "./dialogs.ts";
import { cleanText } from "./status.ts";
import { ACCOUNT_ROUTING_ENV, ACCOUNT_ROUTING_MODES, parseAccountRouting, type AccountRoutingSettings } from "./account-settings.ts";

/** Parent settings are captured at each child launch; no secrets travel in the environment. */
export function inheritedAccountRouting(): AccountRoutingSettings | undefined {
  const value = process.env[ACCOUNT_ROUTING_ENV];
  if (!value) return undefined;
  try { return parseAccountRouting(JSON.parse(value)); }
  catch { throw new Error("Invalid inherited account-routing settings"); }
}
export class Accounts {
  readonly store: AccountStore;
  readonly router: AccountRouter;
  private originals = new Map<string, Provider>();
  private pi: ExtensionAPI;
  private settings: () => AccountRoutingSettings;
  private update: (settings: AccountRoutingSettings, ctx: ExtensionContext) => void;
  constructor(pi: ExtensionAPI, settings: () => AccountRoutingSettings,
    update: (settings: AccountRoutingSettings, ctx: ExtensionContext) => void, directory = getAgentDir()) {
    this.pi = pi;
    this.settings = settings;
    this.update = update;
    this.store = new AccountStore(directory);
    this.router = new AccountRouter(this.store, settings);
  }
  environment(): Record<string, string> { return { [ACCOUNT_ROUTING_ENV]: JSON.stringify(this.settings()) }; }
  policy(): AccountRoutingSettings { return this.settings(); }
  /**
   * Credential variables a subagent must not inherit: keys of environment-backed accounts the
   * routing allowlist excludes. Variables also used by an allowed account stay. With routing off
   * or no allowlist nothing is withheld, because the child may need them for Pi's own login.
   */
  withheldEnvironment(): string[] {
    const settings = this.settings();
    if (settings.mode === "off" || !settings.accounts.length) return [];
    let definitions: AccountDefinition[];
    try { definitions = this.store.list(); }
    catch (error) {
      // The child reads the same storage and fails closed on it; it cannot route with these keys.
      console.error("pi-jar: cannot read account storage to scope subagent credentials", error);
      return [];
    }
    const allowed = new Set(settings.accounts);
    const kept = new Set(definitions.filter(account => allowed.has(account.name)).map(account => account.env));
    const withheld = definitions
      .filter(account => account.auth === "env" && !allowed.has(account.name) && !kept.has(account.env))
      .map(account => account.env!);
    return [...new Set(withheld)];
  }
  sync(ctx: ExtensionContext): void {
    this.router.onRoute = (name, provider, health) => {
      if (!ctx.hasUI || typeof ctx.ui.setStatus !== "function") return;
      ctx.ui.setStatus("pi-jar.account", `account:${name}`);
      let status: string | undefined;
      if (health.quota && health.checkedAt && health.checkedAt + QUOTA_TTL_MS > Date.now()) {
        status = JSON.stringify({ ...health.quota, expiresAt: health.checkedAt + QUOTA_TTL_MS });
      }
      ctx.ui.setStatus(QUOTA_PREFIX + provider, status);
    };
    if (this.settings().mode === "off") {
      if (ctx.hasUI && this.originals.size && typeof ctx.ui.setStatus === "function") {
        ctx.ui.setStatus("pi-jar.account", undefined);
        for (const id of this.originals.keys()) ctx.ui.setStatus(QUOTA_PREFIX + id, undefined);
      }
      for (const provider of this.originals.values()) this.pi.registerProvider(provider);
      this.originals.clear();
      this.router.configurationError = undefined;
      return;
    }
    let definitions: AccountDefinition[];
    try { definitions = this.store.list(); }
    catch (error) {
      // Startup event errors must not silently send a prompt using Pi's unrelated primary login.
      this.router.configurationError = "Account configuration is unsafe or malformed; fix storage or turn routing off";
      this.installProviders(ctx, new Set(ctx.modelRegistry.getAll().map(model => model.provider)));
      throw error;
    }
    this.router.configurationError = undefined;
    const providers = new Set(definitions.map(account => account.provider));
    for (const [id, original] of this.originals) {
      if (providers.has(id)) continue;
      this.pi.registerProvider(original);
      this.originals.delete(id);
    }
    this.installProviders(ctx, providers);
  }
  private installProviders(ctx: ExtensionContext, providers: ReadonlySet<string>): void {
    for (const id of providers) {
      if (this.originals.has(id)) continue;
      const provider = ctx.modelRegistry.getProvider(id);
      if (!provider) continue;
      this.originals.set(id, provider);
      this.pi.registerProvider(this.router.wrap(provider));
    }
  }
  async ready(ctx: ExtensionContext): Promise<void> {
    this.sync(ctx);
    if (this.settings().mode === "off" || !this.originals.size) return;
    // Publish account-backed availability before default/profile role activation; no catalog IO.
    await ctx.modelRegistry.refresh({ providers: [...this.originals.keys()], allowNetwork: false });
  }
  private interaction(ctx: ExtensionContext, preferDeviceCode = false): AuthInteraction {
    return {
      prompt: async prompt => {
        prompt.signal?.throwIfAborted();
        if (prompt.type === "secret") throw new Error("Use an environment-backed account for API keys");
        let value: string | undefined;
        if (prompt.type === "select") {
          // The provider owns the available login methods. In headless/SSH terminals,
          // prefer its native device-code flow instead of a localhost browser callback.
          if (preferDeviceCode) {
            const device = prompt.options.find(option => option.id === "device_code");
            if (!device) throw new Error("This provider does not offer a native device-code login");
            value = device.id;
          } else {
            const labels = prompt.options.map(option => option.label);
            const selected = await ctx.ui.select(prompt.message, labels);
            value = prompt.options.find(option => option.label === selected)?.id;
          }
        } else if (prompt.type === "manual_code") {
          // Unlike ctx.ui.input(), this popup can close itself when Pi's local OAuth
          // callback wins the race. The native provider parses the pasted redirect URL.
          value = await promptText(ctx, "Complete provider sign-in", prompt.message, "", prompt.signal);
        } else value = await ctx.ui.input(prompt.message, prompt.placeholder);
        prompt.signal?.throwIfAborted();
        if (value === undefined) throw new Error("Account login cancelled");
        return value;
      },
      notify: event => {
        if (event.type === "auth_url") ctx.ui.notify(
          `Open this login URL in your browser: ${event.url}\nIf the localhost callback is not reachable (SSH/container), paste the full redirected URL in the next prompt, or retry using device-code login.`, "info");
        else if (event.type === "device_code") ctx.ui.notify(
          `Open ${event.verificationUri} and enter code ${event.userCode}. Pi is waiting for confirmation.`, "info");
        else if (event.type === "info" || event.type === "progress") ctx.ui.notify(event.message, "info");
      }
    };
  }
  /** Pin a named account for one provider, or restore automatic routing for that provider. */
  pin(providerId: string, name: string | undefined, ctx: ExtensionContext): void {
    const current = this.settings();
    if (name) {
      const account = this.store.list().find(item => item.name === name);
      if (!account || account.provider !== providerId) {
        throw new Error(`Account ${name} is not configured for provider ${providerId}`);
      }
      if (!this.store.hasCredentials(account)) {
        throw new Error(`Account ${name} has no available credentials. Sign in again or restore its environment variable first`);
      }
      if (current.accounts.length && !current.accounts.includes(name)) {
        throw new Error(`Account ${name} is excluded by this profile's allowlist`);
      }
    } else if (!this.store.list().some(account => account.provider === providerId)) {
      throw new Error(`No configured accounts for ${providerId}`);
    }
    const nextPinned = { ...current.pinned };
    if (name) nextPinned[providerId] = name;
    else delete nextPinned[providerId];
    const { pinned: _previous, ...rest } = current;
    this.update(Object.keys(nextPinned).length ? { ...rest, pinned: nextPinned } : rest, ctx);
    ctx.ui.notify(name ? `Pinned ${providerId} to ${name} (no automatic failover to another account for this provider)`
      : `Automatic account selection restored for ${providerId}`, "info");
  }

  /** Sign out without touching another provider or Pi's primary credentials. */
  async logout(name: string, ctx: ExtensionContext): Promise<void> {
    if (!ctx.isIdle()) throw new Error("Finish the current model request before signing out");
    this.store.logout(name);
    this.router.invalidate(name);
    const current = this.settings();
    const pins = Object.fromEntries(Object.entries(current.pinned ?? {})
      .filter(([, account]) => account !== name));
    const { pinned: _previous, ...rest } = current;
    this.update(Object.keys(pins).length ? { ...rest, pinned: pins } : rest, ctx);
    await this.ready(ctx);
    ctx.ui.notify(`Signed out ${name} locally. The account label remains available for reconnecting.`, "info");
  }

  /** Remove only the selected account's private storage; never touch Pi's primary login. */
  async remove(name: string, ctx: ExtensionContext): Promise<void> {
    if (!ctx.isIdle()) throw new Error("Wait until the current model request finishes before removing an account");
    this.store.remove(name);
    this.router.invalidate(name);
    const current = this.settings();
    const pins = Object.fromEntries(Object.entries(current.pinned ?? {}).filter(([, account]) => account !== name));
    const { pinned: _previous, ...rest } = current;
    this.update(Object.keys(pins).length
      ? { ...rest, accounts: current.accounts.filter(item => item !== name), pinned: pins }
      : { ...rest, accounts: current.accounts.filter(item => item !== name) }, ctx);
    await this.ready(ctx);
    ctx.ui.notify(`Account ${name} removed locally. Revoke its OAuth session at the provider if you also want to revoke access.`, "info");
  }

  async routing(args: string, ctx: ExtensionContext): Promise<void> {
    const choice = args.trim().toLowerCase();
    if (!choice || choice === "status") return this.command("list", ctx);
    let mode = choice;
    if (choice === "on") {
      mode = this.settings().mode;
      if (mode === "off") mode = "sticky";
    }
    if (!ACCOUNT_ROUTING_MODES.includes(mode as never)) {
      throw new Error("Usage: /jar routing [on|off|status|sticky|round-robin|quota-first]");
    }
    await this.command(`mode ${mode}`, ctx);
    ctx.ui.notify(`Account routing: ${mode}`, "info");
  }
  async command(args: string, ctx: ExtensionContext): Promise<void> {
    const [action, providerId, name, env, ...extra] = args.trim().split(/\s+/);
    if (!action || action === "list") {
      const rows = this.router.status().map(account => {
        let quota = "quota unknown";
        if (account.remaining !== undefined) quota = `${account.remaining}% remaining`;
        if ((account.blockedUntil ?? 0) > Date.now()) quota = `cooldown until ${new Date(account.blockedUntil!).toISOString()}`;
        let warning = "";
        if (account.warning) warning = ` · ${account.warning}`;
        return `${account.name}: ${account.provider} · ${quota}${warning}`;
      });
      ctx.ui.notify(`Account routing: ${this.settings().mode}\n${rows.join("\n") || "No accounts configured"}`, "info");
      return;
    }
    if (action === "logout" && providerId && !name) {
      await this.logout(providerId, ctx);
      return;
    }
    if (action === "pin" && providerId && name && !env && !extra.length) {
      this.pin(providerId, name, ctx);
      return;
    }
    if (action === "auto" && providerId && !name) {
      this.pin(providerId, undefined, ctx);
      return;
    }
    if (action === "mode" && ACCOUNT_ROUTING_MODES.includes(providerId as never) && !name) {
      this.update({ ...this.settings(), mode: providerId as AccountRoutingSettings["mode"] }, ctx);
      await this.ready(ctx);
      return;
    }
    if (action === "use" && providerId && !name) {
      let accounts: string[] = [];
      if (providerId !== "all") {
        accounts = providerId.split(",");
        const known = new Set(this.store.list().map(account => account.name));
        if (!accounts.every(account => known.has(account))) throw new Error("Unknown account in profile allowlist");
      }
      const current = this.settings();
      // An allowlist should not silently strand a pin on an excluded account.
      const pins = Object.fromEntries(Object.entries(current.pinned ?? {})
        .filter(([, account]) => !accounts.length || accounts.includes(account)));
      const { pinned: _previous, ...rest } = current;
      this.update(Object.keys(pins).length ? { ...rest, accounts, pinned: pins } : { ...rest, accounts }, ctx);
      return;
    }
    if (!["add", "login", "login-device"].includes(action) || !providerId || !name || extra.length
      || (action === "add" && (!env || !/^[A-Z_][A-Z0-9_]{0,127}$/.test(env))) || (action !== "add" && env)) {
      throw new Error("Usage: /jar accounts [manage|list|logout NAME|mode off/sticky/round-robin/quota-first|use all/name1,name2|pin PROVIDER NAME|auto PROVIDER|add PROVIDER NAME ENV_VAR|login PROVIDER NAME|login-device PROVIDER NAME]");
    }
    if (!ctx.isIdle()) throw new Error("Wait for active model work before adding an account");
    const provider = this.originals.get(providerId) ?? ctx.modelRegistry.getProvider(providerId);
    if (!provider) throw new Error("Unknown provider");
    if (action !== "add" && (!ctx.hasUI || ctx.mode !== "tui")) throw new Error("OAuth account login requires an interactive Pi terminal");
    if (action !== "add" && !provider.auth.oauth) throw new Error("This provider has no OAuth login; use an environment-backed account");
    if (action === "add" && !provider.auth.apiKey) throw new Error("This provider does not support API-key accounts");
    if (env && !process.env[env]) throw new Error("Set the account environment variable before adding it");
    const account: AccountDefinition = { version: 1, name, provider: providerId, auth: "oauth" };
    if (action === "add") { account.auth = "env"; account.env = env; }
    const existing = this.store.list().find(item => item.name === name);
    if (existing && (action === "add" || existing.provider !== providerId || existing.auth !== "oauth")) {
      throw new Error("Account name already belongs to another account");
    }
    // Leave an unactivated private directory after interrupted first login; never delete credentials implicitly.
    if (!existing) this.store.reserve(name);
    if (action !== "add") {
      const models = await this.store.models(account, provider);
      try {
        // Reuse Pi's public login API and the provider's own OAuth flow, credential
        // persistence, refresh handling, and installation identity.
        await models.login(providerId, "oauth", this.interaction(ctx, action === "login-device"),
          { getDeviceId: () => this.store.deviceId() });
      } catch (error) {
        const reason = cleanText(error instanceof Error ? error.message : String(error), 220);
        throw new Error(`Account login failed (${name}): ${reason}. The main Pi login was not modified. If browser authorization fails, retry with /jar accounts login-device ${providerId} ${name}.`);
      }
    }
    if (!existing) this.store.save(account);
    if (existing) this.store.saveHealth(name, {});
    this.router.invalidate(name);
    await this.ready(ctx);
    ctx.ui.notify(`Account ${name} added for ${providerId}. Choose routing in /jar settings → Pi, or /jar accounts mode sticky`, "info");
  }
}
