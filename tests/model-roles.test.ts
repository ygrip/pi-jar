import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRoleManager, normalizeSpec, parseRoleConfig, resolveRole } from "../src/model-roles.ts";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

function withAgentDir(run: (directory: string) => Promise<void>) {
  return async () => {
    const original = process.env.PI_CODING_AGENT_DIR;
    const directory = mkdtempSync(join(tmpdir(), "pi-jar-roles-"));
    process.env.PI_CODING_AGENT_DIR = directory;
    try { await run(directory); }
    finally {
      if (original === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = original;
      rmSync(directory, { recursive: true, force: true });
    }
  };
}

function harness() {
  const commands = new Map<string, (args: string, ctx: ExtensionContext) => Promise<void>>();
  const events = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<void>>();
  const notices: string[] = [];
  const models: string[] = [];
  const thinking: string[] = [];
  const pi = {
    on(name: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<void>) { events.set(name, handler); },
    registerCommand(name: string, spec: { handler: (args: string, ctx: ExtensionContext) => Promise<void> }) { commands.set(name, spec.handler); },
    async setModel(model: { id: string }) { models.push(model.id); return true; },
    setThinkingLevel(level: string) { thinking.push(level); },
    getThinkingLevel: () => "off"
  } as unknown as ExtensionAPI;
  const ctx = {
    hasUI: false, mode: "print", cwd: undefined as string | undefined,
    ui: { notify(message: string) { notices.push(message); }, setStatus() {}, theme: { fg: (_: string, value: string) => value } },
    modelRegistry: { find: (_provider: string, id: string) => ({ provider: "test", id }) }
  } as unknown as ExtensionContext & { cwd?: string };
  const manager = new ModelRoleManager(pi);
  manager.register();
  return { commands, events, notices, models, thinking, ctx, manager };
}

test("roles rejects incomplete assignment, persists valid role and activates authenticated model", withAgentDir(async (directory) => {
  const h = harness();
  await h.commands.get("roles")!("set plan test/", h.ctx);
  assert.equal(h.manager.get("plan"), undefined);
  await h.commands.get("roles")!("set plan test/model high", h.ctx);
  assert.deepEqual(h.manager.get("plan"), { provider: "test", model: "model", thinking: "high" });
  const saved = JSON.parse(readFileSync(join(directory, "pi-jar-roles.json"), "utf8"));
  assert.deepEqual(saved, { version: 2, roles: { plan: "test/model:high" } });
  await h.commands.get("roles")!("plan", h.ctx);
  assert.deepEqual(h.models, ["model"]);
  assert.ok(h.notices.some((notice) => notice.includes("Usage:")));
}));

test("specs normalize models, aliases, effort suffixes and the default wildcard", () => {
  assert.equal(normalizeSpec("anthropic/claude-opus-5-5:high"), "anthropic/claude-opus-5-5:high");
  assert.equal(normalizeSpec("@slow"), "@slow");
  assert.equal(normalizeSpec("*"), "@default");
  assert.equal(normalizeSpec("openrouter/meta/llama:free"), "openrouter/meta/llama:free", "unknown suffix stays in the model id");
  for (const bad of ["", "model", "/x", "x/", "@Bad", "a b/c"]) assert.equal(normalizeSpec(bad), undefined, bad);
});

test("aliases resolve through chains; referring effort wins; cycles and missing targets are errors", () => {
  const roles = { default: "p/base:low", slow: "p/big:medium", plan: "@slow:high", advisor: "@plan", loop1: "@loop2", loop2: "@loop1", ghost: "@nobody" };
  assert.deepEqual(resolveRole(roles, "plan"), { provider: "p", model: "big", thinking: "high", via: ["plan", "slow"] });
  assert.deepEqual(resolveRole(roles, "advisor"), { provider: "p", model: "big", thinking: "high", via: ["advisor", "plan", "slow"] });
  assert.match((resolveRole(roles, "loop1") as { error: string }).error, /cycle/);
  assert.match((resolveRole(roles, "ghost") as { error: string }).error, /not assigned/);
  assert.equal(resolveRole(roles, "commit"), undefined);
});

test("v1 files migrate in memory; invalid entries are dropped", () => {
  const config = parseRoleConfig({ version: 1, roles: {
    plan: { provider: "p", model: "m", thinking: "high" }, smol: { provider: "p" }, "Bad Name": { provider: "p", model: "m" }
  } });
  assert.deepEqual(config, { version: 2, roles: { plan: "p/m:high" } });
  assert.deepEqual(parseRoleConfig({ version: 3, roles: { plan: "p/m" } }).roles, {});
  const full = parseRoleConfig({ version: 2, roles: { review: "p/r" }, cycleOrder: ["smol", "smol", "BAD"], tags: { review: { name: "Reviewer", color: "accent" } } });
  assert.deepEqual(full.cycleOrder, ["smol"]);
  assert.deepEqual(full.tags, { review: { name: "Reviewer", color: "accent" } });
});

test("project roles override global ones, custom roles list after built-ins, and cycling follows the order", withAgentDir(async (directory) => {
  writeFileSync(join(directory, "pi-jar-roles.json"), JSON.stringify({ version: 2, roles: { default: "p/global", smol: "p/small", review: "@default" }, cycleOrder: ["smol", "default"] }));
  const project = mkdtempSync(join(tmpdir(), "pi-jar-project-"));
  try {
    mkdirSync(join(project, ".pi"));
    writeFileSync(join(project, ".pi", "pi-jar-roles.json"), JSON.stringify({ version: 2, roles: { default: "p/project:low" } }));
    const h = harness();
    (h.ctx as { cwd?: string }).cwd = project;
    await h.events.get("session_start")!({}, h.ctx);
    assert.deepEqual(h.models, ["project"], "session starts on the project default role");
    assert.equal(h.manager.scopeOf("default"), "project");
    assert.deepEqual(h.manager.get("review"), { provider: "p", model: "project", thinking: "low" });
    const list = h.manager.list();
    assert.deepEqual(list.slice(0, 7).map((row) => row.role), ["default", "smol", "slow", "plan", "advisor", "task", "commit"]);
    assert.equal(list.at(-1)?.role, "review");
    assert.equal(list.at(-1)?.custom, true);
    assert.equal(await h.manager.cycle(h.ctx), "smol");
    assert.equal(await h.manager.cycle(h.ctx), "default");
    h.manager.update("smol", "p/tiny", "project");
    assert.match(readFileSync(join(project, ".pi", "pi-jar-roles.json"), "utf8"), /p\/tiny/);
    assert.match(h.manager.summary(), /default→project/);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
}));

test("temporary activation restores the previous model and effort", withAgentDir(async () => {
  const h = harness();
  h.manager.update("advisor", "p/auditor:xhigh");
  (h.ctx as { model?: unknown }).model = { provider: "p", id: "previous" };
  const restore = await h.manager.activateTemporary("advisor", h.ctx);
  assert.equal(h.manager.activeRole(), "advisor");
  await restore();
  assert.deepEqual(h.models, ["auditor", "previous"]);
  assert.deepEqual(h.thinking, ["xhigh", "off"]);
  assert.equal(h.manager.activeRole(), undefined);
}));
