import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { installCompactBuiltinTools } from "../src/compact-tools.ts";

type Result = { content: { type: string; text?: string }[]; details?: unknown };
type Tool = { name: string; parameters: { properties: Record<string, unknown> }; execute(...args: unknown[]): Promise<Result> };

/** Pi's built-in tools as pi-jar registers them, over a temp directory, with session hooks. */
function harness(readCache = true) {
  const cwd = mkdtempSync(join(tmpdir(), "pi-jar-read-"));
  const tools = new Map<string, Tool>();
  const hooks = new Map<string, () => void>();
  const settings = { readCache };
  installCompactBuiltinTools({
    registerTool: (tool: Tool) => { tools.set(tool.name, tool); },
    on: (event: string, handler: () => void) => { hooks.set(event, handler); }
  } as never, { readCache: () => settings.readCache });
  const run = (name: string, params: object) => tools.get(name)!.execute("call", params, undefined, undefined, { cwd });
  const read = async (params: object) => (await run("read", params)).content.map((part) => part.text).join("");
  return { cwd, settings, tools, hooks, run, read, cleanup: () => rmSync(cwd, { recursive: true, force: true }) };
}

test("an unchanged repeated read returns a stub; force, another range or a changed file returns content", async (t) => {
  const h = harness();
  t.after(h.cleanup);
  const file = join(h.cwd, "a.ts");
  writeFileSync(file, "one\ntwo\nthree");
  assert.ok(h.tools.get("read")!.parameters.properties.force, "read accepts force");

  assert.equal(await h.read({ path: "a.ts" }), "one\ntwo\nthree");
  const stub = await h.run("read", { path: "a.ts" });
  assert.equal(stub.content[0]!.text, "[unchanged since read #1 (3 lines); pass force: true to re-read]");
  assert.deepEqual(stub.details, { unchangedSinceRead: 1 });
  assert.match(await h.read({ path: file }), /unchanged since read #1 /, "relative and absolute paths share a mark");

  assert.equal(await h.read({ path: "a.ts", force: true }), "one\ntwo\nthree");
  assert.match(await h.read({ path: "a.ts" }), /unchanged since read #4 \(3 lines\)/, "the forced read is the newest copy");
  assert.equal(await h.read({ path: "a.ts", offset: 2 }), "two\nthree", "another range is read");
  assert.match(await h.read({ path: "a.ts", offset: 2 }), /unchanged since read #6 \(2 lines\)/);

  const { mtime } = statSync(file);
  utimesSync(file, mtime, new Date(mtime.getTime() + 5000));
  assert.equal(await h.read({ path: "a.ts" }), "one\ntwo\nthree", "a changed mtime returns content");
  assert.match(await h.read({ path: "a.ts" }), /unchanged/);
  writeFileSync(file, "one\ntwo\nthree\nfour");
  assert.equal(await h.read({ path: "a.ts" }), "one\ntwo\nthree\nfour", "a changed file returns content");
});

test("the read cache is opt-in and follows the live setting", async (t) => {
  const h = harness(false);
  t.after(h.cleanup);
  writeFileSync(join(h.cwd, "a.ts"), "one");
  assert.equal(await h.read({ path: "a.ts" }), "one");
  assert.equal(await h.read({ path: "a.ts" }), "one");
  h.settings.readCache = true;
  assert.equal(await h.read({ path: "a.ts" }), "one");
  assert.match(await h.read({ path: "a.ts" }), /unchanged since read #1 \(1 line\)/);
  h.settings.readCache = false;
  assert.equal(await h.read({ path: "a.ts" }), "one");
});

test("an edit or write forgets the file's reads, even a failed edit", async (t) => {
  const h = harness();
  t.after(h.cleanup);
  writeFileSync(join(h.cwd, "a.ts"), "one\ntwo\nthree");
  await h.read({ path: "a.ts" });
  assert.match(await h.read({ path: "a.ts" }), /unchanged/);

  await h.run("edit", { path: "a.ts", edits: [{ oldText: "two", newText: "TWO" }] });
  assert.equal(await h.read({ path: "a.ts" }), "one\nTWO\nthree");
  assert.match(await h.read({ path: "a.ts" }), /unchanged/);
  // Nothing changes on disk, but a failed edit shows the model misremembers the file.
  await assert.rejects(h.run("edit", { path: "a.ts", edits: [{ oldText: "missing", newText: "x" }] }));
  assert.equal(await h.read({ path: "a.ts" }), "one\nTWO\nthree");
  assert.match(await h.read({ path: "a.ts" }), /unchanged/);

  await h.run("write", { path: join(h.cwd, "a.ts"), content: "fresh" });
  assert.equal(await h.read({ path: "a.ts" }), "fresh");
});

test("compaction, tree navigation and a new session forget every read", async (t) => {
  const h = harness();
  t.after(h.cleanup);
  writeFileSync(join(h.cwd, "a.ts"), "one");
  for (const event of ["session_compact", "session_tree", "session_start"]) {
    await h.read({ path: "a.ts" });
    assert.match(await h.read({ path: "a.ts" }), /unchanged/);
    h.hooks.get(event)!();
    assert.equal(await h.read({ path: "a.ts" }), "one", `${event} drops the output from context`);
  }
  assert.match(await h.read({ path: "a.ts" }), /unchanged since read #1 /, "a new session restarts read numbering");
});

test("a file over 50 KB read without offset/limit returns 400 lines and says how to read more", async (t) => {
  const h = harness();
  t.after(h.cleanup);
  writeFileSync(join(h.cwd, "big.txt"), Array.from({ length: 1000 }, (_, index) => `${index + 1} ${"x".repeat(80)}`).join("\n"));
  writeFileSync(join(h.cwd, "small.txt"), "small");

  const capped = await h.read({ path: "big.txt" });
  const lines = capped.split("\n\n")[0]!.split("\n");
  assert.equal(lines.length, 400);
  assert.match(lines[399]!, /^400 x/);
  assert.match(capped.slice(capped.lastIndexOf("\n\n")), /400 lines.*offset/, "a note says it was limited and how to read more");
  assert.match(await h.read({ path: "big.txt" }), /unchanged since read #1 \(400 lines\)/, "notices are not counted as file lines");

  const explicit = await h.read({ path: "big.txt", limit: 1000 });
  assert.ok(explicit.split("\n\n")[0]!.split("\n").length > 400, "an explicit limit is honored");
  const offset = await h.read({ path: "big.txt", offset: 401 });
  assert.match(offset, /^401 x/);
  assert.ok(offset.split("\n\n")[0]!.split("\n").length > 400, "an explicit offset is not capped");
  assert.equal(await h.read({ path: "small.txt" }), "small");
});
