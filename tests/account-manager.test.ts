import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Model, Provider, OAuthCredential } from "@earendil-works/pi-ai";
import { Accounts } from "../src/accounts.ts";
import type { AccountRoutingSettings } from "../src/account-settings.ts";
import { openAccountManager } from "../src/account-ui.ts";
import { promptText } from "../src/dialogs.ts";

const mockTheme = { fg: (_color: string, text: string) => text };
const mockTui = { requestRender() {}, terminal: { rows: 24 } };

test("interactive account manager can change routing policy and return to the menu", async () => {
  const actions = [2, 1, 4]; // routing row, sticky, Done
  let policy: AccountRoutingSettings = { mode: "off", accounts: [] };
  const accounts = {
    store: { list: () => [] },
    router: { status: () => [] },
    policy: () => policy,
    routing: async (mode: AccountRoutingSettings["mode"]) => { policy = { ...policy, mode }; }
  };
  const ctx = {
    hasUI: true, mode: "tui",
    ui: {
      notify() {},
      custom: async (factory: Function) => new Promise(resolve => {
        const view = factory(mockTui, mockTheme, {}, resolve);
        assert.ok(view.render(80).length > 0);
        const choice = actions.shift();
        assert.notEqual(choice, undefined);
        for (let index = 0; index < choice!; index++) view.handleInput("\x1b[B");
        view.handleInput("\r");
      })
    }
  };
  await openAccountManager(ctx as never, accounts as never);
  assert.equal(policy.mode, "sticky");
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
