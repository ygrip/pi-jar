import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Model, Provider, OAuthCredential } from "@earendil-works/pi-ai";
import { Accounts } from "../src/accounts.ts";
import type { AccountRoutingSettings } from "../src/account-settings.ts";
import { openAccountManager } from "../src/account-ui.ts";
import { openAccountHub } from "../src/account-hub.ts";
import { visibleWidth } from "@earendil-works/pi-tui";
import { promptText } from "../src/dialogs.ts";

const mockTheme = { fg: (_color: string, text: string) => text };
const mockTui = { requestRender() {}, terminal: { rows: 24 } };

test("interactive account manager can change routing policy and return to the menu", async () => {
  const actions: Array<string | number> = ["r", 1, "esc"]; // hub shortcut, sticky, close hub
  let policy: AccountRoutingSettings = { mode: "off", accounts: [] };
  const accounts = {
    store: { list: () => [] },
    router: { status: () => [] },
    policy: () => policy,
    routing: async (mode: AccountRoutingSettings["mode"]) => { policy = { ...policy, mode }; }
  };
  const ctx = {
    hasUI: true, mode: "tui",
    modelRegistry: { getAll: () => [], getProvider: () => undefined },
    ui: {
      notify() {},
      custom: async (factory: Function) => new Promise(resolve => {
        const view = factory(mockTui, mockTheme, {}, resolve);
        assert.ok(view.render(80).length > 0);
        const choice = actions.shift();
        assert.notEqual(choice, undefined);
        if (choice === "r" || choice === "s") view.handleInput(choice);
        else if (choice === "esc") view.handleInput("\x1b");
        else {
          if (typeof choice === "number") for (let index = 0; index < choice; index++) view.handleInput("\x1b[B");
          view.handleInput("\r");
        }
      })
    }
  };
  await openAccountManager(ctx as never, accounts as never);
  assert.equal(policy.mode, "sticky");
  assert.deepEqual(actions, []);
});

test("OMP-style provider switching only pins the chosen provider", async () => {
  const actions: Array<string | number> = ["s", 1, "esc"]; // hub switch on selected Anthropic provider, pin team, close hub
  const members = [
    { version: 1, name: "personal", provider: "openai-codex", auth: "oauth" },
    { version: 1, name: "work", provider: "openai-codex", auth: "oauth" },
    { version: 1, name: "team", provider: "anthropic", auth: "oauth" }
  ];
  let policy: AccountRoutingSettings = { mode: "sticky", accounts: [] };
  const accounts = {
    store: { list: () => members },
    router: { status: () => members.map(account => ({ name: account.name, provider: account.provider })) },
    policy: () => policy,
    pin: (provider: string, name: string | undefined) => {
      policy = { ...policy, pinned: { ...policy.pinned, ...(name ? { [provider]: name } : {}) } };
    }
  };
  const ctx = {
    hasUI: true, mode: "tui",
    modelRegistry: { getAll: () => [], getProvider: (id: string) => ({ id, auth: { oauth: {} } }) },
    ui: {
      notify() {},
      custom: async (factory: Function) => new Promise(resolve => {
        const view = factory(mockTui, mockTheme, {}, resolve);
        const choice = actions.shift();
        assert.notEqual(choice, undefined);
        if (choice === "r" || choice === "s") view.handleInput(choice);
        else if (choice === "esc") view.handleInput("\x1b");
        else {
          if (typeof choice === "number") for (let index = 0; index < choice; index++) view.handleInput("\x1b[B");
          view.handleInput("\r");
        }
      })
    }
  };
  await openAccountManager(ctx as never, accounts as never);
  assert.deepEqual(policy.pinned, { anthropic: "team" }, "Codex accounts remain on automatic routing");
  assert.deepEqual(actions, []);
});

test("native manual-code popup closes when Pi's OAuth callback wins", async () => {
  const controller = new AbortController();
  const ctx = {
    hasUI: true, mode: "tui",
    ui: {
      custom: async (factory: Function) => new Promise(resolve => {
        const view = factory(mockTui, mockTheme, {}, resolve);
        view.render(80);
        controller.abort();
      })
    }
  };
  const value = await promptText(ctx as never, "OAuth", "Paste callback URL", "", controller.signal);
  assert.equal(value, undefined);
});

test("login-device selects the provider's native OAuth device-code method without touching Pi's primary login", async t => {
  const directory = mkdtempSync(join(tmpdir(), "pi-jar-login-device-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const model: Model<Api> = { id: "test", name: "Test", provider: "openai-codex",
    api: "openai-completions", baseUrl: "https://example.invalid", reasoning: false,
    input: ["text"], contextWindow: 10000, maxTokens: 100,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  const visited: string[] = [];
  const deviceIds: string[] = [];
  const provider: Provider = {
    id: "openai-codex", name: "Codex", getModels: () => [model],
    auth: { oauth: {
      name: "Sign in with ChatGPT",
      login: async (interaction, options) => {
        deviceIds.push(options?.getDeviceId?.() ?? "missing");
        const method = await interaction.prompt({ type: "select", message: "Login method", options: [
          { id: "browser", label: "Browser login" }, { id: "device_code", label: "Device-code login" }
        ] });
        visited.push(method);
        return { type: "oauth", access: "test-access", refresh: "test-refresh", expires: Date.now() + 60_000 } satisfies OAuthCredential;
      },
      refresh: async credential => credential,
      toAuth: async credential => ({ apiKey: credential.access })
    } },
    stream: () => { throw new Error("unused"); },
    streamSimple: () => { throw new Error("unused"); }
  };
  let mode: AccountRoutingSettings = { mode: "off", accounts: [] };
  const notifications: string[] = [];
  const ctx = {
    isIdle: () => true, hasUI: true, mode: "tui",
    ui: { notify: (message: string) => notifications.push(message), select: () => { throw new Error("Native device choice should not prompt"); } },
    modelRegistry: { getProvider: () => provider, getAll: () => [model], refresh: async () => {} }
  };
  const accounts = new Accounts({ registerProvider() {} } as never, () => mode, next => { mode = next; }, directory);
  await accounts.command("login-device openai-codex work", ctx as never);
  await accounts.command("login-device openai-codex work", ctx as never);
  assert.deepEqual(visited, ["device_code", "device_code"]);
  assert.equal(deviceIds[0], deviceIds[1]);
  assert.notEqual(deviceIds[0], "missing");
  assert.equal(accounts.store.list().length, 1);
  assert.ok(notifications.some(text => text.includes("Account work added")));
});

test("OMP-style account hub shows native provider pools, quota flags and respects narrow terminals", async () => {
  const definitions = [
    { version: 1, name: "personal", provider: "openai-codex", auth: "oauth" },
    { version: 1, name: "work", provider: "openai-codex", auth: "oauth" },
    { version: 1, name: "team", provider: "anthropic", auth: "oauth" }
  ];
  const ctx = { hasUI: true, mode: "tui", model: { provider: "openai-codex" },
    modelRegistry: { getAll: () => [{ provider: "openai-codex" }, { provider: "anthropic" }],
      getProvider: (id: string) => ({ id, name: id }) },
    ui: { custom: async (factory: Function) => new Promise(resolve => {
      const view = factory(mockTui, mockTheme, {}, resolve);
      const wide = view.render(88).join("\n");
      assert.match(wide, /PROVIDERS/);
      assert.match(wide, /ACCOUNTS/);
      assert.match(wide, /personal/);
      assert.match(wide, /70% left/);
      assert.match(wide, /LAST USED/, "last automatically selected provider account is visible");
      assert.match(wide, /COOLDOWN/);
      const compact = view.render(42);
      assert.ok(compact.every((line: string) => visibleWidth(line) <= 42));
      // Returning to wide layout, a click on the right column selects the
      // account, not the provider row occupying the same Y-coordinate.
      view.render(88);
      view.handleMouse({ type: "click", button: "left", x: 40, y: 6 });
    }) } };
  const accounts = { store: { list: () => definitions, hasCredentials: () => true },
    policy: () => ({ mode: "sticky", accounts: [], pinned: {} }),
    router: { status: () => [
      { name: "personal", provider: "openai-codex", remaining: 70, lastUsed: true },
      { name: "work", provider: "openai-codex", remaining: 0, blockedUntil: Date.now() + 60_000 },
      { name: "team", provider: "anthropic", remaining: 40 }
    ] } };
  const result = await openAccountHub(ctx as never, accounts as never, { provider: "openai-codex" });
  assert.deepEqual(result, { kind: "account", provider: "openai-codex", name: "personal" });
});


test("profile access clearly distinguishes All from restricted checkboxes", { timeout: 10000 }, async () => {
  const members = [
    { version: 1, name: "work", provider: "openai", auth: "env" },
    { version: 1, name: "personal", provider: "openai", auth: "env" }
  ];
  let policy: AccountRoutingSettings = { mode: "sticky", accounts: [] };
  const seen: string[] = [];
  let step = 0;
  const accounts = {
    store: { list: () => members, hasCredentials: () => true },
    router: { status: () => [] },
    policy: () => policy,
    command: async (command: string) => {
      if (command === "use all") policy = { ...policy, accounts: [] };
      else if (command.startsWith("use ")) policy = { ...policy, accounts: command.slice(4).split(",") };
    }
  };
  const ctx = { hasUI: true, mode: "tui", model: { provider: "openai" },
    modelRegistry: { getAll: () => [{ provider: "openai" }], getProvider: () => ({ id: "openai", name: "OpenAI" }) },
    ui: { notify() {}, custom: async (factory: Function) => new Promise(resolve => {
      const view = factory(mockTui, mockTheme, {}, resolve);
      const output = view.render(110).join("\n");
      if (step === 0) view.handleInput("p"); // Enter the profile access dialog.
      else if (step === 1) {
        seen.push(output);
        view.handleInput("\x1b[B"); view.handleInput("\r"); // Restrict to work
      } else if (step === 2) {
        // The access dialog stays open so multiple identities can be toggled.
        seen.push(output);
        view.handleInput("\r"); // Explicitly restore All
      } else if (step === 3) {
        view.handleInput("\x1b"); // Leave the access dialog.
      } else view.handleInput("\x1b"); // Close the parent account hub.
      step++;
    }) } };
  await openAccountManager(ctx as never, accounts as never);
  assert.deepEqual(policy.accounts, [], "returning to All explicitly removes restrictions");
  assert.match(seen[0]!, /\[x\] All accounts · unrestricted/);
  assert.match(seen[0]!, /Restrict to openai \/ work/);
  assert.doesNotMatch(seen[0]!, /\[ \] openai \/ work/, "unrestricted accounts are never misleadingly unchecked");
  assert.match(seen[1]!, /\[ \] All accounts · remove restrictions/);
  assert.match(seen[1]!, /\[x\] openai \/ work/);
  assert.deepEqual(step, 5);
});

test("offline provider accounts remain visible and can be removed through the UI", { timeout: 10000 }, async () => {
  let members = [{ version: 1, name: "old-work", provider: "disabled-plugin", auth: "oauth" }];
  const removed: string[] = [];
  const policy: AccountRoutingSettings = { mode: "sticky", accounts: [] };
  let step = 0;
  const accounts = {
    store: { list: () => members, hasCredentials: () => true },
    router: { status: () => [] },
    policy: () => policy,
    remove: async (name: string) => { removed.push(name); members = []; }
  };
  const ctx = { hasUI: true, mode: "tui",
    modelRegistry: { getAll: () => [], getProvider: () => undefined },
    ui: { notify() {}, custom: async (factory: Function) => new Promise(resolve => {
      const view = factory(mockTui, mockTheme, {}, resolve);
      const content = view.render(100).join("\n");
      if (step === 0) {
        assert.match(content, /disabled-plugin.*OFFLINE/);
        assert.match(content, /old-work/);
        assert.doesNotMatch(content, /Switch \/ pin provider account/);
        view.handleInput("\t"); view.handleInput("\r");
      } else if (step === 1) {
        assert.match(content, /unavailable provider/);
        view.handleInput("\x1b[B"); view.handleInput("\r"); // Confirm local remove
      } else view.handleInput("\x1b");
      step++;
    }) } };
  await openAccountManager(ctx as never, accounts as never);
  assert.deepEqual(removed, ["old-work"]);
  assert.deepEqual(members, []);
  assert.equal(step, 3);
});

test("hub search filters same-provider account rows, retaining provider-name search", { timeout: 10000 }, async () => {
  const members = [
    { version: 1, name: "work", provider: "openai-codex", auth: "oauth" },
    { version: 1, name: "personal", provider: "openai-codex", auth: "oauth" }
  ];
  const accounts = {
    store: { list: () => members, hasCredentials: () => true },
    router: { status: () => [] },
    policy: () => ({ mode: "sticky", accounts: [] })
  };
  const ctx = { hasUI: true, mode: "tui", model: { provider: "openai-codex" },
    modelRegistry: { getAll: () => [{ provider: "openai-codex" }], getProvider: () => ({ id: "openai-codex", name: "Codex" }) },
    ui: { custom: async (factory: Function) => new Promise(resolve => {
      const view = factory(mockTui, mockTheme, {}, resolve);
      view.render(100);
      view.handleInput("/");
      for (const c of "work") view.handleInput(c);
      view.handleInput("\r");
      const matched = view.render(100).join("\n");
      assert.match(matched, /work · OAuth/);
      assert.doesNotMatch(matched, /personal · OAuth/);
      view.handleInput("/");
      for (let i = 0; i < 4; i++) view.handleInput("\x7f"); // Clear search
      for (const c of "codex") view.handleInput(c);
      view.handleInput("\r");
      const byProvider = view.render(100).join("\n");
      assert.match(byProvider, /work · OAuth/);
      assert.match(byProvider, /personal · OAuth/);
      view.handleInput("\x1b");
    }) } };
  const result = await openAccountHub(ctx as never, accounts as never);
  assert.deepEqual(result, { kind: "close" });
});


test("failed native OAuth login releases an empty reservation and retries with same label", { timeout: 10000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), "pi-jar-failed-login-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const model: Model<Api> = { id: "test", name: "Test", provider: "openai-codex",
    api: "openai-completions", baseUrl: "https://example.invalid", reasoning: false,
    input: ["text"], contextWindow: 10000, maxTokens: 100,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  let calls = 0;
  const provider: Provider = {
    id: "openai-codex", name: "Codex", getModels: () => [model],
    auth: { oauth: {
      name: "Native OAuth",
      login: async () => {
        if (++calls === 1) throw new Error("simulated browser callback rejection");
        return { type: "oauth", access: "new-token", refresh: "new-refresh",
          expires: Date.now() + 60_000 } satisfies OAuthCredential;
      },
      refresh: async credential => credential,
      toAuth: async credential => ({ apiKey: credential.access })
    } },
    stream: () => { throw new Error("unused"); },
    streamSimple: () => { throw new Error("unused"); }
  };
  let policy: AccountRoutingSettings = { mode: "off", accounts: [] };
  const ctx = { isIdle: () => true, hasUI: true, mode: "tui",
    ui: { notify() {} },
    modelRegistry: { getProvider: () => provider, getAll: () => [model], refresh: async () => {} } };
  const accounts = new Accounts({ registerProvider() {} } as never, () => policy, next => { policy = next; }, directory);
  await assert.rejects(
    () => accounts.command("login-device openai-codex work", ctx as never),
    /simulated browser callback rejection.*empty reservation was cleared/
  );
  const path = join(accounts.store.root, "work");
  assert.equal(existsSync(path), false, "failed login releases its own unused reservation");
  assert.deepEqual(accounts.store.list(), []);
  await accounts.command("login-device openai-codex work", ctx as never);
  assert.equal(calls, 2);
  assert.equal(accounts.store.list()[0]?.name, "work");
  assert.equal(accounts.store.hasCredentials(accounts.store.list()[0]!), true);
});

test("explicit recovery only removes empty abandoned account reservations", { timeout: 10000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), "pi-jar-recover-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  let policy: AccountRoutingSettings = { mode: "off", accounts: [] };
  const accounts = new Accounts({} as never, () => policy, next => { policy = next; }, directory);
  const ctx = { isIdle: () => true, ui: { notify() {} } };
  accounts.store.reserve("previous");
  await accounts.command("recover previous", ctx as never);
  assert.equal(existsSync(join(accounts.store.root, "previous")), false);
  accounts.store.reserve("previous"); // Name is reusable.
  const protectedPath = join(accounts.store.root, "previous", "auth.json");
  writeFileSync(protectedPath, "keep-secret-safe", { mode: 0o600 });
  await assert.rejects(() => accounts.command("recover previous", ctx as never), /contains files/);
  assert.equal(existsSync(protectedPath), true, "never delete partial OAuth credentials without inspection");
  await assert.rejects(() => accounts.command("recover ..\\/escaped", ctx as never), /names must/);
});
