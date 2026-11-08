import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Input, Key, matchesKey, truncateToWidth, visibleWidth, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { popup } from "./popup.ts";
import type { Accounts } from "./accounts.ts";

export type AccountHubAction =
  | { kind: "close" | "add" | "routing" | "allowlist" | "switch" | "limits"; provider?: string }
  | { kind: "account"; provider: string; name: string }
  | { kind: "auto"; provider: string };

export interface AccountHubState {
  provider?: string;
  pane?: "providers" | "accounts";
  accountIndex?: number;
}

/**
 * OMP-style provider/account hub, using Pi's own TUI components rather than
 * importing OMP runtime, credentials or providers. A single reusable overlay
 * shows provider pools and account health; submenus run only after it closes.
 */
export async function openAccountHub(ctx: ExtensionContext, accounts: Accounts, state: AccountHubState = {}): Promise<AccountHubAction> {
  return popup<AccountHubAction>(ctx, (tui, theme, _keys, done) => {
    let pane: "providers" | "accounts" = state.pane ?? "providers";
    let accountIndex = state.accountIndex ?? 0;
    let searching = false;
    const search = new Input({ prompt: "/ ", placeholder: "Search providers and accounts" });
    let providerHits: Array<{ y: number; id: string }> = [];
    let accountHits: Array<{ y: number; index: number }> = [];
    let columnSplit = -1;

    const groups = () => {
      const known = ctx.modelRegistry.getAll().map(model => model.provider);
      const configured = accounts.store.list().map(account => account.provider);
      // Stored accounts stay visible when their provider plugin is uninstalled.
      return [...new Set([...known, ...configured])]
        .sort((a, b) => a.localeCompare(b));
    };
    const matching = () => {
      const query = search.getValue().trim().toLocaleLowerCase();
      if (!query) return groups();
      const words = query.split(/\s+/);
      return groups().filter(id => {
        const provider = ctx.modelRegistry.getProvider(id);
        const members = accounts.store.list().filter(account => account.provider === id);
        const terms = [id, provider?.name ?? "", ...members.map(member => member.name)].join(" ").toLocaleLowerCase();
        return words.every(word => terms.includes(word));
      });
    };
    const currentProvider = (): string | undefined => {
      const ids = matching();
      if (!ids.length) return undefined;
      if (state.provider && ids.includes(state.provider)) return state.provider;
      const preferred = ctx.model?.provider;
      state.provider = preferred && ids.includes(preferred) ? preferred : ids[0];
      return state.provider;
    };
    const choices = () => {
      const provider = currentProvider();
      if (!provider) return [{ kind: "add" as const, label: "Connect provider account…" }];
      const registered = ctx.modelRegistry.getProvider(provider);
      const query = search.getValue().trim().toLocaleLowerCase();
      const words = query.split(/\s+/).filter(Boolean);
      const providerTerms = `${provider} ${registered?.name ?? ""}`.toLocaleLowerCase();
      const providerMatch = words.every(word => providerTerms.includes(word));
      const members = accounts.store.list().filter(account => account.provider === provider
        && (providerMatch || words.every(word => `${providerTerms} ${account.name}`.toLocaleLowerCase().includes(word))));
      const pinned = accounts.policy().pinned?.[provider];
      const statuses = accounts.router.status();
      const allow = accounts.policy().accounts;
      return [
        ...(registered ? [{ kind: "auto" as const, label: `Automatic selection · ${accounts.policy().mode}${pinned ? "" : " · current"}` }] : []),
        ...members.map(account => {
          const status = statuses.find(item => item.name === account.name);
          const quota = status?.remaining === undefined ? "quota ?" : `${Math.round(status.remaining)}% left`;
          const blocked = (status?.blockedUntil ?? 0) > Date.now();
          const missing = !accounts.store.hasCredentials(account);
          const excluded = allow.length > 0 && !allow.includes(account.name);
          const flags = [pinned === account.name ? "PINNED" : "", !pinned && status?.lastUsed ? "LAST USED" : "", blocked ? "COOLDOWN" : "",
            missing ? "SIGN IN" : "", excluded ? "EXCLUDED" : ""].filter(Boolean).join(" · ");
          return { kind: "account" as const, name: account.name,
            label: `${account.name} · ${account.auth === "oauth" ? "OAuth" : "API"} · ${quota}${flags ? " · " + flags : ""}` };
        }),
        ...(registered ? [
          { kind: "add" as const, label: "＋ Add account to this provider" },
          { kind: "switch" as const, label: "Switch / pin provider account…" },
          { kind: "limits" as const, label: "Quota and cooldown details…" }
        ] : [{ kind: "close" as const, label: "Provider unavailable · select account to remove" }])
      ];
    };

    const act = (kind: "close" | "add" | "routing" | "allowlist" | "switch" | "limits", provider?: string) => {
      state.pane = pane;
      state.accountIndex = accountIndex;
      done(provider ? { kind, provider } : { kind });
    };
    const openSelected = () => {
      const provider = currentProvider();
      state.pane = pane;
      state.accountIndex = accountIndex;
      if (pane === "providers" && provider) { pane = "accounts"; accountIndex = 0; return; }
      const selected = choices()[accountIndex];
      if (!selected) return;
      if (selected.kind === "auto" && provider) {
        done({ kind: "auto", provider });
        return;
      }
      if (selected.kind === "account" && provider) {
        done({ kind: "account", provider, name: selected.name });
        return;
      }
      if (selected.kind === "add" || selected.kind === "switch" || selected.kind === "limits") act(selected.kind, provider);
    };
    const selectProvider = (delta: number) => {
      const all = matching();
      if (!all.length) return;
      const next = (all.indexOf(currentProvider()!) + delta + all.length) % all.length;
      state.provider = all[next];
      accountIndex = 0;
    };
    const move = (delta: number) => {
      if (pane === "providers") selectProvider(delta);
      else accountIndex = (accountIndex + delta + choices().length) % choices().length;
    };
    const header = (label: string, max: number) => theme.fg("accent", truncateToWidth(label, Math.max(1, max)));
    const normal = (value: string, max: number) => truncateToWidth(value, Math.max(1, max), "…");
    const pad = (value: string, max: number) => normal(value, max) + " ".repeat(Math.max(0, max - visibleWidth(normal(value, max))));

    return {
      invalidate() { search.invalidate(); },
      handleInput(data: string) {
        if (searching) {
          if (matchesKey(data, Key.escape)) { searching = false; search.setValue(""); }
          else if (matchesKey(data, Key.enter)) searching = false;
          else { search.handleInput(data); accountIndex = 0; }
          tui.requestRender(); return;
        }
        if (data === "/") { searching = true; search.focused = true; tui.requestRender(); return; }
        if (matchesKey(data, Key.escape)) { act("close"); return; }
        if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) {
          pane = "accounts";
        } else if (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left)) {
          pane = "providers";
        } else if (matchesKey(data, Key.up)) move(-1);
        else if (matchesKey(data, Key.down)) move(1);
        else if (matchesKey(data, Key.enter) || data === " ") openSelected();
        else if (data === "a") act("add", currentProvider());
        else if (data === "s") act("switch", currentProvider());
        else if (data === "r") act("routing");
        else if (data === "p") act("allowlist");
        else if (data === "q") act("limits", currentProvider());
        tui.requestRender();
      },
      handleMouse(event: TuiMouseEvent) {
        if (event.type === "wheel" && event.wheelDelta) { move(Math.sign(event.wheelDelta) * 3); tui.requestRender(); return { handled: true }; }
        if (event.type !== "click" || event.button !== "left") return;
        const provider = providerHits.find(hit => hit.y === event.y);
        if (provider && (columnSplit < 0 || event.x < columnSplit)) { state.provider = provider.id; pane = "accounts"; accountIndex = 0; tui.requestRender(); return { handled: true }; }
        const account = accountHits.find(hit => hit.y === event.y);
        if (account && (columnSplit < 0 || event.x >= columnSplit)) { pane = "accounts"; accountIndex = account.index; openSelected(); tui.requestRender(); return { handled: true }; }
      },
      render(width: number): string[] {
        const available = Math.max(1, width);
        const providers = matching();
        const provider = currentProvider();
        const allAccounts = accounts.store.list();
        const rows = choices();
        accountIndex = Math.max(0, Math.min(accountIndex, rows.length - 1));
        providerHits = []; accountHits = []; columnSplit = -1;
        const policy = accounts.policy();
        const headerLine = header(" pi-jar  /  Accounts", available);
        const summary = normal(` Pi native providers · ${allAccounts.length} accounts · ${policy.mode.toUpperCase()} · selected: ${provider ?? "none"}`, available);
        const searchLine = searching ? search.render(Math.max(1, available))[0]! : theme.fg("dim", " / search · Tab switch pane · Enter open · Esc close");
        const out = [headerLine, summary, normal(searchLine, available), theme.fg("dim", "─".repeat(available))];
        const detail = (item: (typeof rows)[number], index: number, max: number): string => {
          const selected = pane === "accounts" && accountIndex === index;
          return (selected ? theme.fg("accent", "❯ ") : "  ") + normal(item.label, Math.max(1, max - 2));
        };
        if (available >= 72) {
          const leftWidth = Math.min(30, Math.max(20, Math.floor(available * 0.32)));
          const rightWidth = Math.max(1, available - leftWidth - 3);
          columnSplit = leftWidth + 2;
          out.push(pad(header(" PROVIDERS", leftWidth), leftWidth) + theme.fg("dim", " │ ") + header(` ACCOUNTS · ${provider ?? "no provider"}`, rightWidth));
          const count = Math.max(providers.length, rows.length, 2);
          for (let index = 0; index < count; index++) {
            const id = providers[index];
            const countAccounts = id ? allAccounts.filter(account => account.provider === id).length : 0;
            const focused = pane === "providers" && id === provider;
            const left = id ? `${focused ? "❯" : " "} ${id} (${countAccounts})${ctx.modelRegistry.getProvider(id) ? "" : " OFFLINE"}` : "";
            const right = rows[index] ? detail(rows[index]!, index, rightWidth) : "";
            const y = out.length;
            if (id) providerHits.push({ y, id });
            if (rows[index]) accountHits.push({ y, index });
            out.push(pad(left, leftWidth) + theme.fg("dim", " │ ") + normal(right, rightWidth));
          }
        } else {
          out.push(header(" PROVIDERS", available));
          for (const id of providers) {
            providerHits.push({ y: out.length, id });
            const selected = pane === "providers" && id === provider;
            out.push(normal(` ${selected ? "❯" : " "} ${id} · ${allAccounts.filter(account => account.provider === id).length} accounts${ctx.modelRegistry.getProvider(id) ? "" : " · OFFLINE"}`, available));
          }
          if (!providers.length) out.push(theme.fg("dim", " No provider accounts. Press A to connect."));
          out.push(header(` ACCOUNTS · ${provider ?? "none"}`, available));
          rows.forEach((item, index) => {
            accountHits.push({ y: out.length, index });
            out.push(normal(detail(item, index, available), available));
          });
        }
        out.push(theme.fg("dim", "─".repeat(available)));
        out.push(normal(" A add · S switch · R routing · P profile · Q quota · / search", available));
        return out.map(line => truncateToWidth(line, available));
      }
    };
  }, { filter: false });
}
