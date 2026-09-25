import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { ChangeTracker, diffRows, lineDiff } from "../src/changes.ts";
import { openDiffView, registerChangeReview, renderDiff, safeLine } from "../src/diff-view.ts";

const plain = (_color: string, text: string) => text;
const workspace = () => realpathSync(mkdtempSync(join(tmpdir(), "pi-jar-changes-")));

test("line diff finds minimal edits and groups them into unified hunks", () => {
  const before = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k"].join("\n") + "\n";
  const after = ["a", "b", "C", "d", "e", "f", "g", "h", "i", "j", "k", "l"].join("\n") + "\n";
  const ops = lineDiff(before, after)!;
  assert.deepEqual(ops.filter((op) => op.op !== " "), [{ op: "-", text: "c" }, { op: "+", text: "C" }, { op: "+", text: "l" }]);
  const rows = diffRows(ops);
  assert.deepEqual(rows.filter((row) => row.kind === "hunk").map((row) => row.text), ["@@ -1,6 +1,6 @@", "@@ -9,3 +9,4 @@"]);
  assert.deepEqual(rows.find((row) => row.kind === "add" && row.text === "l"), { kind: "add", text: "l", newLine: 12 });
  assert.deepEqual(lineDiff("same\n", "same\n")!.every((op) => op.op === " "), true);
  assert.deepEqual(lineDiff("", "new\n"), [{ op: "+", text: "new" }]);
});

test("tracker captures once, reports added/modified/deleted, accepts and reverts", () => {
  const root = workspace();
  try {
    writeFileSync(join(root, "keep.ts"), "one\ntwo\n");
    writeFileSync(join(root, "gone.ts"), "bye\n");
    const tracker = new ChangeTracker(() => root);
    assert.equal(tracker.capture("keep.ts"), true);
    assert.equal(tracker.capture("new.ts"), true);
    assert.equal(tracker.capture("gone.ts"), true);
    assert.equal(tracker.capture(join(tmpdir(), "outside.md")), false, "files outside the project are not tracked");
    writeFileSync(join(root, "keep.ts"), "one\n2\n");
    tracker.capture("keep.ts"); // a second capture keeps the original baseline
    writeFileSync(join(root, "new.ts"), "hello\n");
    rmSync(join(root, "gone.ts"));
    assert.deepEqual(tracker.changes().map((change) => [change.rel, change.status, change.added, change.removed]),
      [["gone.ts", "deleted", 0, 1], ["keep.ts", "modified", 1, 1], ["new.ts", "added", 1, 0]]);
    tracker.revert("keep.ts");
    assert.equal(readFileSync(join(root, "keep.ts"), "utf8"), "one\ntwo\n");
    tracker.revert("new.ts");
    assert.equal(existsSync(join(root, "new.ts")), false, "reverting an added file removes it");
    tracker.revert("gone.ts");
    assert.equal(readFileSync(join(root, "gone.ts"), "utf8"), "bye\n");
    assert.equal(tracker.count(), 0);
    writeFileSync(join(root, "keep.ts"), "changed\n");
    assert.equal(tracker.count(), 0, "reverted files are no longer tracked");
    tracker.capture("keep.ts");
    writeFileSync(join(root, "keep.ts"), "again\n");
    tracker.accept("keep.ts");
    assert.equal(tracker.count(), 0);
    assert.throws(() => tracker.revert("keep.ts"), /not a tracked change/);
    mkdirSync(join(root, "bin"));
    writeFileSync(join(root, "bin", "blob"), Buffer.from([0, 1, 2]));
    assert.equal(tracker.capture("bin/blob"), false, "binary files are skipped");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("rendered diff keeps indentation, strips escapes and fits the pane", () => {
  const change = { path: "/x/a.ts", rel: "a.ts", status: "modified" as const, before: "  a\n", after: "  a\n\tb\x1b[31mred\n", added: 1, removed: 0 };
  const lines = renderDiff(change, 30, plain).map(stripTerminalSequences);
  assert.ok(lines.every((line) => visibleWidth(line) <= 30));
  assert.ok(lines.some((line) => line.includes("   a")), "context keeps indentation");
  assert.ok(lines.some((line) => line.includes("+  bred")));
  assert.equal(safeLine("a\x07b"), "a·b");
});

test("review overlay accepts, confirms reverts and closes when nothing is left; tool calls are captured", async () => {
  const root = workspace();
  try {
    writeFileSync(join(root, "a.ts"), "a\n");
    writeFileSync(join(root, "b.ts"), "b\n");
    const tracker = new ChangeTracker(() => root);
    const events = new Map<string, Function>();
    const commands = new Map<string, Function>();
    let changed = 0;
    registerChangeReview({ on: (name: string, handler: Function) => events.set(name, handler), registerCommand: (name: string, command: { handler: Function }) => commands.set(name, command.handler),
      registerShortcut() {} } as never, () => tracker, () => { changed++; });
    events.get("tool_call")!({ toolName: "edit", input: { path: "a.ts" } });
    events.get("tool_call")!({ toolName: "write", input: { path: join(root, "b.ts") } });
    events.get("tool_call")!({ toolName: "read", input: { path: "c.ts" } });
    writeFileSync(join(root, "a.ts"), "A\n");
    writeFileSync(join(root, "b.ts"), "B\n");
    events.get("tool_result")!({ toolName: "edit" });
    assert.equal(changed, 1);
    assert.equal(tracker.count(), 2);
    let component: any;
    let closed = false;
    const ctx = { hasUI: true, mode: "tui", ui: { notify() {}, custom(factory: Function) {
      return new Promise<void>((resolve) => { component = factory({ requestRender() {} }, { fg: plain, bold: (t: string) => t }, {}, () => { closed = true; resolve(); }); });
    } } };
    const view = openDiffView(ctx as never, tracker);
    const rendered = component.render(100).map(stripTerminalSequences).join("\n");
    assert.match(rendered, /± CHANGES · 2 files · \+2 −2/);
    assert.match(rendered, /-a/);
    assert.match(rendered, /\+A/);
    component.handleInput("a"); // accept a.ts
    assert.equal(tracker.count(), 1);
    component.handleInput("r");
    assert.match(component.render(100).map(stripTerminalSequences).join("\n"), /revert b\.ts\? press r or y/);
    assert.equal(readFileSync(join(root, "b.ts"), "utf8"), "B\n", "revert needs confirmation");
    component.handleInput("y");
    assert.equal(readFileSync(join(root, "b.ts"), "utf8"), "b\n");
    await view;
    assert.equal(closed, true, "closes when nothing is left to review");
    assert.equal(readFileSync(join(root, "a.ts"), "utf8"), "A\n", "accepted change kept");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
