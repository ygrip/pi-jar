import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ACCOUNT_ROUTING_MODES, validAccountName } from "./account-settings.ts";
import type { AccountDefinition } from "./account-store.ts";
import type { Accounts } from "./accounts.ts";
import { promptChoice, promptText } from "./dialogs.ts";
import { openAccountHub, type AccountHubState } from "./account-hub.ts";

/**
 * OMP-style provider-first account management, backed by Pi's native provider
 * registry and login. All dialogs are searchable and support keyboard/mouse.
 * No account-specific OAuth logic, model aliases or credential copies live here.
 */
export async function openAccountManager(ctx: ExtensionContext, accounts: Accounts): Promise<void> {
  if (!ctx.hasUI || ctx.mode !== "tui") {
    ctx.ui.notify("Account manager requires an interactive Pi terminal; use /jar accounts list for status.", "warning");
    return;
  }

  let loginCompleted = false;
  const definitions = (): AccountDefinition[] => accounts.store.list();
  const providers = (): string[] => [...new Set([
    ...ctx.modelRegistry.getAll().map(model => model.provider),
    ...definitions().map(account => account.provider)
  ])].sort();
  const notifyError = (error: unknown) => ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");

  const chooseProvider = async (type?: "oauth" | "apiKey", configuredOnly = false): Promise<string | undefined> => {
    const configured = new Set(definitions().map(account => account.provider));
    const ids = providers().filter(id => !!ctx.modelRegistry.getProvider(id)
      && (!configuredOnly || configured.has(id))
      && (!type || !!ctx.modelRegistry.getProvider(id)?.auth[type]));
    if (!ids.length) {
      ctx.ui.notify(configuredOnly ? "No accounts configured yet" : "No eligible Pi providers in the model registry", "warning");
      return undefined;
    }
    const options = ids.map(id => {
      const count = definitions().filter(account => account.provider === id).length;
      return `${id} · ${count} account${count === 1 ? "" : "s"}`;
    });
    const index = await promptChoice(ctx, "Choose provider", "Accounts only switch within the same Pi provider; models and roles remain unchanged.", options);
    return index === undefined ? undefined : ids[index];
  };

  const add = async (providerId?: string, type?: "oauth" | "apiKey"): Promise<void> => {
    const id = providerId ?? await chooseProvider();
    if (!id) return;
    const provider = ctx.modelRegistry.getProvider(id);
    if (!provider) throw new Error("Unknown Pi provider: " + id);
    let authType = type;
    if (!authType) {
      const choices = [
        ...(provider.auth.oauth ? ["Sign in with provider (Pi OAuth)"] : []),
        ...(provider.auth.apiKey ? ["Reference an environment variable (API key)"] : [])
      ];
      if (!choices.length) throw new Error("Provider has no supported interactive authentication");
      const choice = await promptChoice(ctx, `Connect ${id}`, "Pi's native provider manages login; each named account has private credentials.", choices);
      if (choice === undefined) return;
      authType = choices[choice]!.startsWith("Sign in") ? "oauth" : "apiKey";
    }
    if (!provider.auth[authType]) throw new Error("This provider doesn't support that credential type");
    const name = await promptText(ctx, "Account label", "Use lowercase letters, digits and hyphens (e.g. personal, work-2). Names are unique across providers.");
    if (!name) return;
    if (!validAccountName(name)) throw new Error("Account label must start with a lowercase letter and be at most 32 characters");
    if (authType === "apiKey") {
      const env = await promptText(ctx, "Existing key environment variable", "Enter its variable name, not the secret value. It must already be set when Pi starts.");
      if (!env) return;
      await accounts.command(`add ${id} ${name} ${env}`, ctx);
    } else await signIn(id, name);
  };

  const signIn = async (providerId: string, name: string): Promise<void> => {
    // Match Pi's /login: let the registered provider choose its own browser,
    // device-code and fallback methods, without a duplicate Codex-specific picker.
    await accounts.command(`login ${providerId} ${name}`, ctx);
    loginCompleted = true;
  };

  const switchAccount = async (providerId?: string): Promise<void> => {
    const id = providerId ?? await chooseProvider(undefined, true);
    if (!id) return;
    const members = definitions().filter(account => account.provider === id);
    if (!members.length) return;
    const selected = accounts.policy().pinned?.[id];
    const allow = accounts.policy().accounts;
    const choices = [
      `Automatic (${accounts.policy().mode})${selected ? "" : " · active"}`,
      ...members.map(account => `${account.name}${selected === account.name ? " · pinned" : ""}${allow.length && !allow.includes(account.name) ? " · excluded by profile" : ""}`)
    ];
    const pinnedIndex = members.findIndex(account => account.name === selected);
    const choice = await promptChoice(ctx, `Switch account · ${id}`,
      "Only this provider changes. Automatic mode preserves same-provider 429 failover; pinning intentionally disables account failover.", choices,
      pinnedIndex + 1);
    if (choice === undefined) return;
    accounts.pin(id, choice === 0 ? undefined : members[choice - 1]!.name, ctx);
  };

  const routingPolicy = async (): Promise<void> => {
    const modes = [...ACCOUNT_ROUTING_MODES];
    const choice = await promptChoice(ctx, "Routing policy",
      "Sticky keeps prompt-cache affinity; round-robin rotates; quota-first uses known remaining quota. Off restores Pi authentication.",
      modes.map(mode => mode === accounts.policy().mode ? `${mode} · current` : mode),
      Math.max(0, modes.indexOf(accounts.policy().mode)));
    if (choice !== undefined) await accounts.routing(modes[choice]!, ctx);
  };

  const allowlist = async (): Promise<void> => {
    while (true) {
      const all = definitions();
      if (!all.length) return;
      const selected = accounts.policy().accounts;
      const unrestricted = selected.length === 0;
      const choices = [
        unrestricted ? "[x] All accounts · unrestricted" : "[ ] All accounts · remove restrictions",
        ...all.map(account => unrestricted
          ? `Restrict to ${account.provider} / ${account.name} (only this identity)`
          : `${selected.includes(account.name) ? "[x]" : "[ ]"} ${account.provider} / ${account.name}`),
        "Back"
      ];
      const choice = await promptChoice(ctx, "Profile account access",
        unrestricted ? "All configured and future accounts are permitted. Select Restrict to explicitly limit this profile to one identity."
          : "Only checked identities are permitted. Select All accounts to remove restrictions; excluding a pin clears it.", choices);
      if (choice === undefined || choice === choices.length - 1) return;
      if (choice === 0) await accounts.command("use all", ctx);
      else {
        const name = all[choice - 1]!.name;
        const next = unrestricted ? [name] : selected.includes(name) ? selected.filter(item => item !== name) : [...selected, name];
        if (next.length) await accounts.command(`use ${next.join(",")}`, ctx);
        else ctx.ui.notify("Choose All accounts to clear the profile allowlist.", "info");
      }
    }
  };

  const showLimits = async (providerId?: string): Promise<void> => {
    const id = providerId ?? await chooseProvider(undefined, true);
    if (!id) return;
    const members = definitions().filter(account => account.provider === id);
    const summaries = members.map(account => {
      const health = accounts.store.health(account.name);
      const status = accounts.router.status().find(item => item.name === account.name);
      const windowLabel = (label: string, window: { used: number; resetsAt?: number } | undefined) =>
        window ? `${label}: ${Math.max(0, Math.round(100 - window.used))}% left${window.resetsAt ? " · reset " + new Date(window.resetsAt).toLocaleString() : ""}` : `${label}: unknown`;
      const cooldown = (status?.blockedUntil ?? 0) > Date.now() ? " · cooldown " + new Date(status!.blockedUntil!).toLocaleString() : "";
      return `${account.name} · ${windowLabel("5h", health.quota?.fiveHour)} · ${windowLabel("week", health.quota?.week)}${cooldown}${status?.warning ? " · warning" : ""}`;
    });
    await promptChoice(ctx, `Quota & limits · ${id}`,
      "Cached provider values only; API keys and unsupported providers have unknown limits. Select Back to return.",
      [...summaries, "Back"]);
  };

  const manageAccount = async (account: AccountDefinition): Promise<void> => {
    if (!ctx.modelRegistry.getProvider(account.provider)) {
      if (account.source === "native") {
        ctx.ui.notify("Pi's native account is linked but the provider is unavailable. The primary credential is never removed by Pi Jar.", "warning");
        return;
      }
      const confirmation = await promptChoice(ctx, `${account.provider} / ${account.name} · unavailable provider`,
        "The provider plugin is not registered. Authentication and pinning are disabled, but local credentials can be removed.",
        ["Keep account", "Remove local account & credentials…"]);
      if (confirmation === 1) await accounts.remove(account.name, ctx);
      return;
    }
    if (account.source === "native") {
      const choices = ["Make active for this provider (pin)", "Reconnect / renew native Pi login", "View quota & cooldown", "Back"];
      const choice = await promptChoice(ctx, `${account.provider} / ${account.name} · linked Pi login`,
        "Uses Pi's primary OAuth credentials and refresh lock. Sign out with native Pi /logout; Pi Jar cannot delete this credential.", choices);
      if (choice === 0) accounts.pin(account.provider, account.name, ctx);
      else if (choice === 1) await signIn(account.provider, account.name);
      else if (choice === 2) await showLimits(account.provider);
      return;
    }
    const choices = [
      "Make active for this provider (pin)",
      ...(account.auth === "oauth" ? ["Reconnect / renew Pi OAuth login", "Sign out (keep label)"] : []),
      "View quota & cooldown",
      "Remove local account credentials…",
      "Back"
    ];
    const choice = await promptChoice(ctx, `${account.provider} / ${account.name}`,
      `${account.auth === "oauth" ? "Pi native OAuth" : "Environment: " + account.env} · ${accounts.policy().pinned?.[account.provider] === account.name ? "Pinned" : "Automatic routing"}`,
      choices);
    if (choice === undefined || choice === choices.length - 1) return;
    if (choice === 0) return accounts.pin(account.provider, account.name, ctx);
    const offset = account.auth === "oauth" ? 2 : 0;
    if (account.auth === "oauth" && choice === 1) { await signIn(account.provider, account.name); return; }
    if (account.auth === "oauth" && choice === 2) {
      const confirm = await promptChoice(ctx, "Sign out?", `Remove ${account.name}'s local OAuth credential but keep the account label for future login?`, ["Keep signed in", "Sign out locally"]);
      if (confirm === 1) await accounts.logout(account.name, ctx);
      return;
    }
    if (choice === offset + 1) { await showLimits(account.provider); return; }
    if (choice === offset + 2) {
      const confirmation = await promptChoice(ctx, "Remove this account?", `Delete ${account.name}'s local credential files? The provider session is not revoked.`, [
        "Keep account", "Delete local account & credentials"
      ]);
      if (confirmation === 1) await accounts.remove(account.name, ctx);
    }
  };

  const hubState: AccountHubState = { provider: ctx.model?.provider };
  while (true) {
    // Keep provider and pane selection when returning from a native Pi login,
    // submenu or account mutation, instead of rebuilding a chain of pickers.
    let action;
    try { action = await openAccountHub(ctx, accounts, hubState); }
    catch (error) { notifyError(error); return; }
    if (action.kind === "close") return;
    try {
      if (action.kind === "add") await add(action.provider);
      else if (action.kind === "switch") await switchAccount(action.provider);
      else if (action.kind === "routing") await routingPolicy();
      else if (action.kind === "allowlist") await allowlist();
      else if (action.kind === "limits") await showLimits(action.provider);
      else if (action.kind === "account") {
        const account = definitions().find(item => item.provider === action.provider && item.name === action.name);
        if (account) await manageAccount(account);
      } else if (action.kind === "auto") accounts.pin(action.provider, undefined, ctx);
      if (loginCompleted) return;
    } catch (error) { notifyError(error); }
  }
}
