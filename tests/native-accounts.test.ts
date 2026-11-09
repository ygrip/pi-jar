import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAssistantMessageEventStream, normalizeContext,
  type Api, type AssistantMessage, type Model, type OAuthCredential, type Provider } from "@earendil-works/pi-ai";
import { AccountStore } from "../src/account-store.ts";
import { AccountRouter } from "../src/account-router.ts";
import { Accounts } from "../src/accounts.ts";
import { loginBrowserCommand } from "../src/login-browser.ts";
import type { AccountRoutingSettings } from "../src/account-settings.ts";

const oauth = (value: string): OAuthCredential => ({
  type: "oauth", access: value, refresh: "refresh-" + value, expires: Date.now() + 3600_000
});

function fixture(t: Parameters<typeof test>[1] extends never ? never : { after: (fn: () => void) => void }) {
  const dir = mkdtempSync(join(tmpdir(), "jar-native-login-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function provider(id: "openai-codex" | "anthropic", keys: string[]): { model: Model<Api>; provider: Provider } {
  const model: Model<Api> = {
    id: "test", name: "Test", provider: id,
    api: id === "anthropic" ? "anthropic-messages" : "openai-codex-responses",
    baseUrl: "https://example.invalid", reasoning: false, input: ["text"],
    contextWindow: 10000, maxTokens: 100,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  };
  const definition: Provider = {
    id, name: id, getModels: () => [model],
    auth: { oauth: {
      name: "Provider OAuth",
      login: async interaction => {
        if (id === "openai-codex") {
          const selected = await interaction.prompt({ type: "select", message: "Login method", options: [
            { id: "browser", label: "Browser login" }, { id: "device_code", label: "Device code" }
          ] });
          assert.equal(selected, "browser");
        }
        interaction.notify({ type: "auth_url", url: "https://auth.example.test/login?state=a&scope=b" });
        return oauth(id + "-fresh");
      },
      refresh: async current => current,
      toAuth: async current => ({ apiKey: current.access })
    } },
    stream: () => { throw new Error("unused"); },
    streamSimple: (_model, _context, options) => {
      keys.push(id + ":" + (options?.apiKey ?? "missing"));
      const output = createAssistantMessageEventStream();
      const message: AssistantMessage = {
        role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
        stopReason: "stop", timestamp: Date.now(),
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }
      };
      output.push({ type: "done", reason: "stop", message }); output.end();
      return output;
    }
  };
  return { model, provider: definition };
}

test("native Pi OAuth auto-links Codex and Anthropic without copying or deleting secrets", async t => {
  const dir = fixture(t);
  const primaryPath = join(dir, "auth.json");
  const primary = JSON.stringify({ "openai-codex": oauth("native-codex"), anthropic: oauth("native-anthropic") });
  writeFileSync(primaryPath, primary, { mode: 0o600 });
  const store = new AccountStore(dir);
  const registered = await store.discoverNativeAccounts(id => id === "openai-codex" || id === "anthropic");
  assert.deepEqual(registered.map(a => a.name).sort(), ["pi-anthropic", "pi-openai-codex"]);
  assert.equal((await store.discoverNativeAccounts(() => true)).length, 2, "repeated startup is idempotent");
  for (const account of store.list()) {
    assert.equal(account.source, "native");
    assert.equal(account.auth, "oauth");
    assert.equal(store.hasCredentials(account), true);
    assert.equal(existsSync(join(store.root, account.name, "auth.json")), false, "native tokens are not copied");
    const metadata = readFileSync(join(store.root, account.name, "account.json"), "utf8");
    assert.doesNotMatch(metadata, /native-codex|native-anthropic|refresh-native/);
    await assert.rejects(store.logout(account.name), /primary login/);
    assert.throws(() => store.remove(account.name), /native login/);
  }
  assert.equal(readFileSync(primaryPath, "utf8"), primary, "auto-link and UI actions cannot modify Pi auth");
  const secrets = JSON.parse(primary);
  delete secrets.anthropic;
  writeFileSync(primaryPath, JSON.stringify(secrets), { mode: 0o600 });
  const disconnected = store.list().find(a => a.provider === "anthropic")!;
  assert.equal(store.hasCredentials(disconnected), false, "native logout is immediately recognized");
});

test("native linked Codex and Anthropic routes use their own provider OAuth credentials", async t => {
  const dir = fixture(t);
  writeFileSync(join(dir, "auth.json"), JSON.stringify({
    "openai-codex": oauth("native-codex"),
    anthropic: oauth("native-anthropic")
  }), { mode: 0o600 });
  const store = new AccountStore(dir);
  await store.discoverNativeAccounts(() => true);
  const keys: string[] = [];
  const codex = provider("openai-codex", keys);
  const anthropic = provider("anthropic", keys);
  const settings: AccountRoutingSettings = { mode: "sticky", accounts: [], pinned: {
    "openai-codex": "pi-openai-codex", anthropic: "pi-anthropic"
  } };
  const router = new AccountRouter(store, () => settings, Date.now, async () => undefined);
  const context = normalizeContext({ messages: [] });
  assert.equal((await router.wrap(codex.provider).streamSimple(codex.model, context).result()).stopReason, "stop");
  assert.equal((await router.wrap(anthropic.provider).streamSimple(anthropic.model, context).result()).stopReason, "stop");
  assert.deepEqual(keys, ["openai-codex:native-codex", "anthropic:native-anthropic"]);
  assert.ok(router.status().every(item => item.inFlight === 0));
});

test("native login opens the browser for Codex and Anthropic while keeping provider method selection", async t => {
  const dir = fixture(t);
  const opened: string[] = [];
  const seen: string[] = [];
  const keys: string[] = [];
  const providers = [provider("openai-codex", keys), provider("anthropic", keys)].map(p => p.provider);
  const policy: AccountRoutingSettings = { mode: "off", accounts: [] };
  const ctx = {
    hasUI: true, mode: "tui", isIdle: () => true,
    ui: {
      notify: (message: string) => seen.push(message),
      select: async () => "Browser login",
      input: async () => "unused"
    },
    modelRegistry: {
      getProvider: (id: string) => providers.find(p => p.id === id),
      getAll: () => [], refresh: async () => {}
    }
  };
  const accounts = new Accounts({ registerProvider() {} } as never, () => policy, () => {}, dir, url => opened.push(url));
  await accounts.command("login openai-codex personal", ctx as never);
  await accounts.command("login anthropic work", ctx as never);
  assert.deepEqual(opened, ["https://auth.example.test/login?state=a&scope=b", "https://auth.example.test/login?state=a&scope=b"]);
  assert.ok(seen.some(text => text.includes("Open this login URL")));
  assert.deepEqual(accounts.store.list().map(a => a.name), ["personal", "work"]);
  assert.equal(existsSync(join(dir, "auth.json")), false, "separate accounts do not overwrite native auth");
});

test("browser opener is shell-free, cross-platform and rejects unsafe URL schemes", () => {
  const url = "https://example.test/oauth?redirect=a&state=x|z";
  assert.deepEqual(loginBrowserCommand(url, "darwin"), ["open", [url]]);
  assert.deepEqual(loginBrowserCommand(url, "linux"), ["xdg-open", [url]]);
  assert.deepEqual(loginBrowserCommand(url, "win32"), ["rundll32", ["url.dll,FileProtocolHandler", url]]);
  for (const bad of ["javascript:alert(1)", "file:///etc/passwd", "ftp://example.com", "https://test.com\ncommand", "not a URL"]) {
    assert.equal(loginBrowserCommand(bad), undefined);
  }
});
