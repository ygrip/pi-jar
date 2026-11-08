import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ACCOUNT_ROUTING_MODES, validAccountName } from "./account-settings.ts";
import type { AccountDefinition } from "./account-store.ts";
import type { Accounts } from "./accounts.ts";
import { promptChoice, promptText } from "./dialogs.ts";

/** Interactive account manager built on Pi-Jar's searchable, keyboard/mouse friendly dialogs. */
export async function openAccountManager(ctx: ExtensionContext, accounts: Accounts): Promise<void> {
  if (!ctx.hasUI || ctx.mode !== "tui") {
    ctx.ui.notify("Account manager requires the interactive Pi terminal. Use /jar accounts list for status.", "warning");
    return;
  }

  const signIn = async (providerId: string, name: string): Promise<void> => {
    let action = "login";
    if (providerId === "openai-codex") {
      const method = await promptChoice(ctx, "Pi OAuth sign-in", "The native device-code flow works without a localhost browser callback.", [
        "Device code (recommended for SSH, remote and containers)",
        "Browser login (or paste the redirect URL)"
      ]);
      if (method === undefined) return;
      if (method === 0) action = "login-device";
    }
    await accounts.command(`${action} ${providerId} ${name}`, ctx);
  };

  const chooseProvider = async (type: "oauth" | "apiKey"): Promise<string | undefined> => {
    const ids = [...new Set(ctx.modelRegistry.getAll().map(model => model.provider))]
      .filter(id => !!ctx.modelRegistry.getProvider(id)?.auth[type])
      .sort();
    if (!ids.length) {
      ctx.ui.notify("No providers with " + (type === "oauth" ? "OAuth" : "API-key") + " authentication are available in Pi.", "warning");
      return undefined;
    }
    const choice = await promptChoice(ctx, "Choose a Pi provider", "Pi's built-in provider handles authentication; Pi-Jar keeps each account's credentials separate.", ids);
    return choice === undefined ? undefined : ids[choice];
  };

  const addOAuth = async (): Promise<void> => {
    const id = await chooseProvider("oauth");
    if (!id) return;
    const name = await promptText(ctx, "New subscription account", "Account name (lowercase letters, digits, hyphens; 1–32 characters)");
    if (!name) return;
    if (!validAccountName(name)) throw new Error("Account names must start with a lowercase letter and contain only lowercase letters, digits, or hyphens");
    await signIn(id, name);
  };

  const addKey = async (): Promise<void> => {
    const id = await chooseProvider("apiKey");
    if (!id) return;
    const name = await promptText(ctx, "New API-key account", "Account name (lowercase letters, digits, hyphens; 1–32 characters)");
    if (!name) return;
    if (!validAccountName(name)) throw new Error("Invalid account name");
    const env = await promptText(ctx, "Existing environment variable", "Name of an already-exported key variable (never paste the secret itself)");
    if (!env) return;
    await accounts.command(`add ${id} ${name} ${env}`, ctx);
  };

  const chooseMode = async (): Promise<void> => {
    const modes = [...ACCOUNT_ROUTING_MODES];
    const selected = await promptChoice(ctx, "Account routing policy", "Sticky preserves prompt-cache affinity. Quota-first uses known subscription quota; unknown quotas are not unlimited.", modes,
      Math.max(0, modes.indexOf(accounts.policy().mode)));
    if (selected !== undefined) await accounts.routing(modes[selected]!, ctx);
  };

  const editAllowlist = async (): Promise<void> => {
    while (true) {
      const definitions = accounts.store.list();
      const selected = accounts.policy().accounts;
      if (!definitions.length) { ctx.ui.notify("Add an account first", "warning"); return; }
      const choices = [
        `Use all configured accounts ${!selected.length ? "(current)" : ""}`,
        ...definitions.map(account => `${selected.includes(account.name) ? "[x]" : "[ ]"} ${account.name} · ${account.provider}`),
        "Done"
      ];
      const choice = await promptChoice(ctx, "Profile account allowlist", "Select an account to toggle it, or choose all. Allowlist applies to this Pi-Jar profile.", choices);
      if (choice === undefined || choice === choices.length - 1) return;
      if (choice === 0) await accounts.command("use all", ctx);
      else {
        const name = definitions[choice - 1]!.name;
        const next = selected.includes(name) ? selected.filter(item => item !== name) : [...selected, name];
        if (!next.length) {
          ctx.ui.notify("To allow all accounts, select the Use all option above.", "info");
        } else await accounts.command(`use ${next.join(",")}`, ctx);
      }
    }
  };

  const manageAccount = async (account: AccountDefinition): Promise<void> => {
    const choices = [
      ...(account.auth === "oauth" ? ["Sign in again / renew this account"] : []),
      "Show status",
      "Remove local account and credentials",
      "Back"
    ];
    const choice = await promptChoice(ctx, `Account: ${account.name}`, `${account.provider} · ${account.auth === "oauth" ? "Native Pi OAuth" : "Environment variable " + account.env}`, choices);
    if (choice === undefined || choice === choices.length - 1) return;
    if (account.auth === "oauth" && choice === 0) { await signIn(account.provider, account.name); return; }
    const adjusted = account.auth === "oauth" ? choice - 1 : choice;
    if (adjusted === 0) { await accounts.command("list", ctx); return; }
    if (adjusted === 1) {
      const confirm = await promptChoice(ctx, "Remove local account?", `Delete local credentials for ${account.name}? This does NOT revoke the provider's token.`, [
        "Cancel", "Remove account and local credentials"
      ]);
      if (confirm === 1) await accounts.remove(account.name, ctx);
    }
  };

  while (true) {
    let definitions: AccountDefinition[];
    try { definitions = accounts.store.list(); }
    catch (error) {
      ctx.ui.notify("Cannot load private account storage: " + (error instanceof Error ? error.message : String(error)), "error");
      return;
    }
    const policy = accounts.policy();
    const health = accounts.router.status();
    const rows = definitions.map(account => {
      const status = health.find(row => row.name === account.name);
      const remaining = status?.remaining === undefined ? "quota unknown" : `${status.remaining}% remaining`;
      const cooldown = (status?.blockedUntil ?? 0) > Date.now() ? " · cooling down" : "";
      return `${account.name} · ${account.provider} · ${remaining}${cooldown}`;
    });
    const choices = [
      "Add subscription account (Pi OAuth)",
      "Add API-key account (environment variable)",
      `Routing policy: ${policy.mode}`,
      `Profile allowlist: ${policy.accounts.length ? policy.accounts.join(", ") : "all"}`,
      ...rows,
      "Done"
    ];
    const choice = await promptChoice(ctx, "Pi-Jar account manager", `${definitions.length} account(s) · routing: ${policy.mode} · no credentials are shown`, choices);
    if (choice === undefined || choice === choices.length - 1) return;
    try {
      if (choice === 0) await addOAuth();
      else if (choice === 1) await addKey();
      else if (choice === 2) await chooseMode();
      else if (choice === 3) await editAllowlist();
      else await manageAccount(definitions[choice - 4]!);
    } catch (error) {
      ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
    }
  }
}
