import type { AuthInteraction, Provider } from "@earendil-works/pi-ai";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { AccountStore, type AccountDefinition } from "./account-store.ts";
import { AccountRouter } from "./account-router.ts";
import { QUOTA_PREFIX, QUOTA_TTL_MS } from "./quota.ts";
import { promptText } from "./dialogs.ts";
import { cleanText } from "./status.ts";
import { openLoginBrowser } from "./login-browser.ts";
import { ACCOUNT_ROUTING_ENV, ACCOUNT_ROUTING_MODES, isUnsafeRouting, parseAccountRouting, unsafeAccountRouting, withRoutingMode, type AccountRoutingSettings } from "./account-settings.ts";

/** Parent settings are captured at each child launch; no secrets travel in the environment. */
export function inheritedAccountRouting(): AccountRoutingSettings | undefined {
  const value = process.env[ACCOUNT_ROUTING_ENV];
  if (!value) return undefined;
  // A child that cannot read its parent's policy must refuse requests, not start unrouted on Pi's own login.
  try { return parseAccountRouting(JSON.parse(value)); }
  catch { return unsafeAccountRouting("inherited account-routing settings are not valid JSON"); }
}
export class Accounts {
  readonly store: AccountStore;
  readonly router: AccountRouter;
  private originals = new Map<string, Provider>();
  private pi: ExtensionAPI;
  private settings: () => AccountRoutingSettings;
  private update: (settings: AccountRoutingSettings, ctx: ExtensionContext) => void;
  private openBrowser: (url: string) => void;
  onQuotaChange?: () => void;
  constructor(pi: ExtensionAPI, settings: () => AccountRoutingSettings,
    update: (settings: AccountRoutingSettings, ctx: ExtensionContext) => void, directory = getAgentDir(),
    openBrowser: (url: string) => void = openLoginBrowser) {
    this.pi = pi;
    this.settings = settings;
    this.update = update;
    this.openBrowser = openBrowser;
    this.store = new AccountStore(directory);
    this.router = new AccountRouter(this.store, settings);
  }
  environment(): Record<string, string> { return { [ACCOUNT_ROUTING_ENV]: JSON.stringify(this.settings()) }; }
  policy(): AccountRoutingSettings { return this.settings(); }
  routesProvider(provider: string | undefined): boolean {
    return provider !== undefined && this.settings().mode !== "off" && this.originals.has(provider);
  }
  clearQuotaStatuses(ctx: ExtensionContext, keepProvider?: string): void {
    if (!ctx.hasUI || typeof ctx.ui.setStatus !== "function") return;
    let providers: string[] = [];
    try { providers = [...new Set(this.store.list().map(account => account.provider))]; }
    catch { providers = [...new Set(ctx.modelRegistry.getAll().map(model => model.provider))]; }
    for (const provider of providers) {
      if (provider !== keepProvider) ctx.ui.setStatus(QUOTA_PREFIX + provider, undefined);
    }
  }
  async refreshQuota(provider?: string): Promise<void> {
    if (this.settings().mode === "off" || isUnsafeRouting(this.settings())) return;
    await this.router.refreshActiveQuota(provider);
  }
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
      // Launching without knowing which credentials are excluded would expose every key to the child.
      console.error("pi-jar: cannot read account storage to scope subagent credentials", error);
      throw new Error("Cannot safely launch subagent: account storage is unreadable");
    }
    const allowed = new Set(settings.accounts);
    const kept = new Set(definitions.filter(account => allowed.has(account.name)).map(account => account.env));
    const withheld = definitions
      .filter(account => account.auth === "env" && !allowed.has(account.name) && !kept.has(account.env))
      .map(account => account.env!);
    return [...new Set(withheld)];
  }
  sync(ctx: ExtensionContext): void {
    this.clearQuotaStatuses(ctx);
    this.router.onRoute = (name, provider, health) => {
      if (!ctx.hasUI || typeof ctx.ui.setStatus !== "function") return;
      ctx.ui.setStatus("pi-jar.account", `account:${name}`);
      let status: string | undefined;
      if (health.quota && health.checkedAt && health.checkedAt + QUOTA_TTL_MS > Date.now()) {
        status = JSON.stringify({ ...health.quota, expiresAt: health.checkedAt + QUOTA_TTL_MS });
      }
      ctx.ui.setStatus(QUOTA_PREFIX + provider, status);
      this.onQuotaChange?.();
    };
    const policy = this.settings();
    if (isUnsafeRouting(policy)) {
      this.blockUnsafePolicy(ctx, policy.invalid!);
      return;
    }
    if (policy.mode === "off") {
      this.restoreNativeProviders(ctx);
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
  private restoreNativeProviders(ctx: ExtensionContext): void {
    if (ctx.hasUI && this.originals.size && typeof ctx.ui.setStatus === "function") {
      ctx.ui.setStatus("pi-jar.account", undefined);
      for (const id of this.originals.keys()) ctx.ui.setStatus(QUOTA_PREFIX + id, undefined);
    }
    for (const provider of this.originals.values()) this.pi.registerProvider(provider);
    this.originals.clear();
    this.router.configurationError = undefined;
  }
  /**
   * The configured policy is present but unreadable or malformed. Block every provider so no request
   * silently falls back to Pi's own login. With no accounts configured there is nothing a policy could
   * restrict, so Pi is left alone rather than locked out of its only credentials.
   */
  private blockUnsafePolicy(ctx: ExtensionContext, reason: string): void {
    let hasAccounts = true;
    try { hasAccounts = this.store.list().length > 0; }
    catch { /* unreadable account storage counts as "has accounts": fail closed */ }
    if (!hasAccounts) {
      this.restoreNativeProviders(ctx);
      return;
    }
    this.router.configurationError = `Account routing policy is unsafe (${reason}); requests are blocked so Pi's main login is not used. ` +
      "Reset it with /jar accounts mode off|sticky|round-robin|quota-first";
    this.installProviders(ctx, new Set(ctx.modelRegistry.getAll().map(model => model.provider)));
    if (ctx.hasUI) ctx.ui.notify(this.router.configurationError, "error");
  }
  private requireTrustedPolicy(): AccountRoutingSettings {
    const policy = this.settings();
    if (isUnsafeRouting(policy)) {
      throw new Error(`Account routing policy is unsafe (${policy.invalid}). Reset it first with /jar accounts mode off|sticky|round-robin|quota-first`);
    }
    return policy;
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
    // Discover native Pi OAuth before provider routing is installed, including while routing is off.
    // Recheck on account manager open so a recent native /login is detected without a restart.
    await this.store.discoverNativeAccounts(id => Boolean(ctx.modelRegistry.getProvider(id)?.auth.oauth));
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
        if (event.type === "auth_url") {
          ctx.ui.notify(`Open this login URL in your browser: ${event.url}\nIf the localhost callback is not reachable (SSH/container), paste the full redirected URL in the next prompt, or retry using device-code login.`, "info");
          this.openBrowser(event.url);
        }
        else if (event.type === "device_code") ctx.ui.notify(
          `Open ${event.verificationUri} and enter code ${event.userCode}. Pi is waiting for confirmation.`, "info");
        else if (event.type === "info" || event.type === "progress") ctx.ui.notify(event.message, "info");
      }
    };
  }
  /** Pin a named account for one provider, or restore automatic routing for that provider. */
  pin(providerId: string, name: string | undefined, ctx: ExtensionContext): void {
    const current = this.requireTrustedPolicy();
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
    // Explicitly pinning an account turns routing on. Unpinning / choosing
    // Automatic while routing is off must preserve native Pi authentication.
    const active = { ...rest, mode: name && rest.mode === "off" ? "sticky" as const : rest.mode };
    this.update(Object.keys(nextPinned).length ? { ...active, pinned: nextPinned } : active, ctx);
    ctx.ui.notify(name ? `Pinned ${providerId} to ${name} (no automatic failover to another account for this provider)`
      : `Automatic account selection restored for ${providerId}`, "info");
  }

  /** Sign out without touching another provider or Pi's primary credentials. */
  async logout(name: string, ctx: ExtensionContext): Promise<void> {
    if (!ctx.isIdle()) throw new Error("Finish the current model request before signing out");
    // Stop old background quota probes before touching credential/health files.
    this.router.invalidate(name);
    await this.store.logout(name);
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
    const current = this.settings();
    // An empty allowlist means ALL accounts, not NONE. Removing its last
    // member must not silently grant access to every other provider account.
    if (current.accounts.length === 1 && current.accounts[0] === name) {
      throw new Error("Removing the last allowed account would enable other accounts. Choose a different profile allowlist or explicitly 'use all' first");
    }
    // Same order as logout(): stop background quota probes before touching account files.
    this.router.invalidate(name);
    this.store.remove(name);
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
      if (mode === "off" || isUnsafeRouting(this.settings())) mode = "sticky";
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
      await this.ready(ctx);
      const rows = this.router.status().map(account => {
        let quota = "quota unknown";
        if (account.remaining !== undefined) quota = `${account.remaining}% remaining`;
        if ((account.blockedUntil ?? 0) > Date.now()) quota = `cooldown until ${new Date(account.blockedUntil!).toISOString()}`;
        let warning = "";
        if (account.warning) warning = ` · ${account.warning}`;
        return `${account.name}: ${account.provider} · ${quota}${account.lastUsed ? " · last used" : ""}${warning}`;
      });
      const policy = this.settings();
      const state = isUnsafeRouting(policy) ? `BLOCKED, unsafe policy (${policy.invalid}); reset with /jar accounts mode off|sticky|round-robin|quota-first` : policy.mode;
      ctx.ui.notify(`Account routing: ${state}\n${rows.join("\n") || "No accounts configured"}`, "info");
      return;
    }
    if (action === "logout" && providerId && !name) {
      await this.logout(providerId, ctx);
      return;
    }
    // Allow cleanup even when the provider plugin is no longer registered.
    if (action === "remove" && providerId && !name) {
      await this.remove(providerId, ctx);
      return;
    }
    if (action === "recover" && providerId && !name) {
      if (!ctx.isIdle()) throw new Error("Finish active model work before recovering an incomplete reservation");
      this.store.discardEmptyReservation(providerId);
      ctx.ui.notify(`Empty reservation ${providerId} cleared; you can retry login with this label`, "info");
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
      this.update(withRoutingMode(this.settings(), providerId as AccountRoutingSettings["mode"]), ctx);
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
      const current = this.requireTrustedPolicy();
      // An allowlist should not silently strand a pin on an excluded account.
      const pins = Object.fromEntries(Object.entries(current.pinned ?? {})
        .filter(([, account]) => !accounts.length || accounts.includes(account)));
      const { pinned: _previous, ...rest } = current;
      this.update(Object.keys(pins).length ? { ...rest, accounts, pinned: pins } : { ...rest, accounts }, ctx);
      return;
    }
    if (!["add", "login", "login-device"].includes(action) || !providerId || !name || extra.length
      || (action === "add" && (!env || !/^[A-Z_][A-Z0-9_]{0,127}$/.test(env))) || (action !== "add" && env)) {
      throw new Error("Usage: /jar accounts [manage|list|logout NAME|remove NAME|recover NAME|mode off/sticky/round-robin/quota-first|use all/name1,name2|pin PROVIDER NAME|auto PROVIDER|add PROVIDER NAME ENV_VAR|login PROVIDER NAME|login-device PROVIDER NAME]");
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
    // The reservation prevents competing processes from claiming this name.
    // On failed first OAuth login, only an entirely empty private directory is
    // automatically released. Any credential/lock/unknown file remains intact.
    if (!existing) this.store.reserve(name);
    if (action !== "add") {
      try {
        const models = await this.store.models(existing ?? account, provider);
        // Use Pi's native OAuth flow, not a second credential implementation.
        await models.login(providerId, "oauth", this.interaction(ctx, action === "login-device"),
          { getDeviceId: () => this.store.deviceId() });
      } catch (error) {
        let recovery = "";
        if (!existing) {
          try {
            this.store.discardEmptyReservation(name);
            recovery = " The empty reservation was cleared; you can retry with the same label.";
          } catch {
            recovery = ` Reservation files were retained for safety; inspect them before using /jar accounts recover ${name} (only empty reservations may be removed).`;
          }
        }
        const reason = cleanText(error instanceof Error ? error.message : String(error), 220);
        throw new Error(`Account login failed (${name}): ${reason}. The main Pi login was not modified.${recovery} If browser authorization fails, retry with /jar accounts login-device ${providerId} ${name}.`);
      }
    }
    if (!existing) this.store.save(account);
    this.router.invalidate(name);
    // Existing OAuth labels can be reconnected to a different subscription.
    // Rotate the on-disk epoch so stale in-flight quota probes cannot revive
    // the previous identity's limits (including probes in other Pi processes).
    if (existing && action !== "add") this.store.resetHealthForCredentialChange(name);
    await this.ready(ctx);
    ctx.ui.notify(`Account ${name} added for ${providerId}. Choose routing in /jar settings → Pi, or /jar accounts mode sticky`, "info");
  }
}
