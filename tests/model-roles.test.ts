import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRoleManager } from "../src/model-roles.ts";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

test("roles rejects incomplete assignment, persists valid role and activates authenticated model", async () => {
  const original = process.env.PI_CODING_AGENT_DIR;
  const directory = mkdtempSync(join(tmpdir(), "pi-jar-roles-"));
  process.env.PI_CODING_AGENT_DIR = directory;
  try {
    const commands = new Map<string, (args: string, ctx: ExtensionContext) => Promise<void>>();
    const notices: string[] = [];
    const models: string[] = [];
    const pi = {
      on() {},
      registerCommand(name: string, spec: { handler: (args: string, ctx: ExtensionContext) => Promise<void> }) { commands.set(name, spec.handler); },
      async setModel(model: { id: string }) { models.push(model.id); return true; },
      setThinkingLevel() {}
    } as unknown as ExtensionAPI;
    const ctx = {
      ui: { notify(message: string) { notices.push(message); }, setStatus() {}, theme: { fg: (_: string, value: string) => value } },
      modelRegistry: { find: (_provider: string, id: string) => ({ provider: "test", id }) }
    } as unknown as ExtensionContext;
    const manager = new ModelRoleManager(pi);
    manager.register();
    await commands.get("roles")!("set plan test/", ctx);
    assert.equal(manager.get("plan"), undefined);
    await commands.get("roles")!("set plan test/model high", ctx);
    assert.deepEqual(manager.get("plan"), { provider: "test", model: "model", thinking: "high" });
    assert.match(readFileSync(join(directory, "pi-jar-roles.json"), "utf8"), /"plan"/);
    await commands.get("roles")!("plan", ctx);
    assert.deepEqual(models, ["model"]);
    assert.ok(notices.some((notice) => notice.includes("Usage:")));
  } finally {
    if (original === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = original;
    rmSync(directory, { recursive: true, force: true });
  }
});
