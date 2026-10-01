import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { ChangeTracker, diffHunkOffsets, diffRows, diffRowsWindow, lineDiff, MAX_REVIEW_DIFF_LINES, MAX_TRACKED_BYTES, MAX_TRACKED_TOTAL_BYTES } from "../src/changes.ts";
import { CHILD_BASELINE_ENV, readChildBaseline, writeChildBaseline } from "../src/child-baselines.ts";
import { filterChanges, fullReviewRequired, fullReviewSupported, openDiffView, registerChangeReview, renderDiff, safeLine } from "../src/diff-view.ts";

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
  const largeBefore = Array.from({ length: 800 }, (_, i) => "old-" + i).join("\n");
  const largeAfter = Array.from({ length: 800 }, (_, i) => "new-" + i).join("\n");
  assert.equal(lineDiff(largeBefore, largeAfter), undefined, "large quadratic diffs fall back to a summary");
  const window = diffRowsWindow(ops, 3, 2, 4);
  assert.deepEqual(window, diffRows(ops).slice(2, 6), "windowed rows match the full unified hunk output");
  assert.deepEqual(diffHunkOffsets(ops), [0, 8], "hunks can be navigated without building a preview row array");
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
    tracker.markDirty("keep.ts");
    tracker.markDirty("new.ts");
    tracker.markDirty("gone.ts");
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
    tracker.markDirty("keep.ts");
    tracker.accept("keep.ts");
    assert.equal(tracker.count(), 0);
    assert.throws(() => tracker.revert("keep.ts"), /not a tracked change/);
    mkdirSync(join(root, "bin"));
    writeFileSync(join(root, "bin", "blob"), Buffer.from([0, 1, 2]));
    assert.equal(tracker.capture("bin/blob"), false, "binary files are skipped");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("tracker caps total retained baseline bytes", () => {
  const root = workspace();
  try {
    const tracker = new ChangeTracker(() => root);
    const chunk = "x".repeat(1024 * 1024 - 16);
    let captured = 0;
    for (let i = 0; i < 12; i++) {
      const name = `large-${i}.txt`;
      writeFileSync(join(root, name), chunk);
      if (tracker.capture(name)) captured++;
      else break;
    }
    assert.ok(captured > 0);
    assert.ok(tracker.trackedBytes() <= MAX_TRACKED_TOTAL_BYTES);
    assert.ok(captured < 12, "aggregate cap stops retaining more baselines");
    tracker.clear();
    assert.equal(tracker.trackedBytes(), 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("child baselines round trip, keep the first write and ignore malformed records", () => {
  const dir = workspace();
  try {
    const file = join(dir, "project", "a.ts");
    assert.equal(readChildBaseline(dir, file), undefined, "absent");
    writeChildBaseline(dir, file, "old\n");
    writeChildBaseline(dir, file, "newer\n");
    assert.equal(readChildBaseline(dir, file), "old\n", "first write wins");
    writeChildBaseline(dir, join(dir, "project", "created.ts"), null);
    assert.equal(readChildBaseline(dir, join(dir, "project", "created.ts")), null, "null = file did not exist");
    assert.equal(readdirSync(dir).filter((name) => name.endsWith(".tmp")).length, 0, "no temp files left behind");
    const records = readdirSync(dir).filter((name) => name.endsWith(".json"));
    for (const name of records) writeFileSync(join(dir, name), "{not json");
    assert.equal(readChildBaseline(dir, file), undefined);
    for (const name of records) writeFileSync(join(dir, name), JSON.stringify({ path: "/elsewhere", content: "x" }));
    assert.equal(readChildBaseline(dir, file), undefined, "record for another path");
    for (const name of records) writeFileSync(join(dir, name), JSON.stringify({ path: file, content: 3 }));
    assert.equal(readChildBaseline(dir, file), undefined, "non-string content");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("adopt keeps the older baseline, dedupes counts and rejects untrackable files", () => {
  const root = workspace();
  try {
    writeFileSync(join(root, "a.ts"), "a\n");
    const tracker = new ChangeTracker(() => root);
    tracker.capture("a.ts");
    writeFileSync(join(root, "a.ts"), "A\n");
    tracker.markDirty("a.ts");
    assert.equal(tracker.adopt(join(root, "a.ts"), "A-by-child\n"), true);
    assert.equal(tracker.count(), 1, "same absolute path counts once");
    assert.equal(tracker.baseline("a.ts"), "a\n", "older parent baseline wins");
    writeFileSync(join(root, "b.ts"), "B\n");
    writeFileSync(join(root, "c.ts"), "made by child\n");
    assert.equal(tracker.adopt(join(root, "b.ts"), "b\n"), true);
    assert.equal(tracker.adopt("c.ts", null), true);
    assert.equal(tracker.adopt(join(root, "b.ts"), "later\n"), true);
    assert.equal(tracker.count(), 3);
    assert.deepEqual(tracker.changes().map((change) => [change.rel, change.status, change.before, change.after]),
      [["a.ts", "modified", "a\n", "A\n"], ["b.ts", "modified", "b\n", "B\n"], ["c.ts", "added", "", "made by child\n"]]);
    assert.equal(tracker.adopt(join(tmpdir(), "outside.ts"), "x"), false, "outside the project");
    assert.equal(tracker.adopt("huge.ts", "x".repeat(MAX_TRACKED_BYTES + 1)), false, "over the per-file limit");
    assert.equal(tracker.count(), 3);
    assert.equal(tracker.baseline("huge.ts"), undefined);
    tracker.revert("c.ts");
    assert.equal(existsSync(join(root, "c.ts")), false, "reverting an adopted created file removes it");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("in a subagent the tool_call hook shares first-edit baselines with the parent", () => {
  const root = workspace();
  const dir = workspace();
  const previous = process.env[CHILD_BASELINE_ENV];
  const error = console.error;
  try {
    process.env[CHILD_BASELINE_ENV] = dir;
    writeFileSync(join(root, "a.ts"), "a\n");
    const child = new ChangeTracker(() => root);
    const events = new Map<string, Function>();
    registerChangeReview({ on: (name: string, handler: Function) => events.set(name, handler), registerCommand() {}, registerShortcut() {} } as never, () => child, () => {});
    events.get("tool_call")!({ toolName: "edit", toolCallId: "1", input: { path: "a.ts" } });
    events.get("tool_call")!({ toolName: "write", toolCallId: "2", input: { path: "new.ts" } });
    events.get("tool_call")!({ toolName: "edit", toolCallId: "3", input: { path: join(tmpdir(), "outside.ts") } });
    writeFileSync(join(root, "a.ts"), "A\n");
    writeFileSync(join(root, "new.ts"), "n\n");
    events.get("tool_call")!({ toolName: "edit", toolCallId: "4", input: { path: "a.ts" } });
    assert.equal(readChildBaseline(dir, join(root, "a.ts")), "a\n");
    assert.equal(readChildBaseline(dir, join(root, "new.ts")), null);
    assert.equal(readdirSync(dir).length, 2, "untracked files are not shared");
    const parent = new ChangeTracker(() => root);
    for (const name of ["a.ts", "new.ts"]) parent.adopt(join(root, name), readChildBaseline(dir, join(root, name))!);
    assert.deepEqual(parent.changes().map((change) => [change.rel, change.status]), [["a.ts", "modified"], ["new.ts", "added"]]);

    const errors: unknown[] = [];
    console.error = (...args: unknown[]) => { errors.push(args); };
    process.env[CHILD_BASELINE_ENV] = join(root, "a.ts"); // a file, so every write fails
    const broken = new ChangeTracker(() => root);
    registerChangeReview({ on: (name: string, handler: Function) => events.set(name, handler), registerCommand() {}, registerShortcut() {} } as never, () => broken, () => {});
    events.get("tool_call")!({ toolName: "edit", toolCallId: "5", input: { path: "a.ts" } });
    events.get("tool_call")!({ toolName: "edit", toolCallId: "6", input: { path: "a.ts" } });
    events.get("tool_result")!({ toolName: "edit", toolCallId: "5" });
    assert.equal(errors.length, 1, "write failures are reported once per path");
    assert.equal(broken.count(), 1, "the tool call itself is still tracked");
  } finally {
    console.error = error;
    if (previous === undefined) delete process.env[CHILD_BASELINE_ENV];
    else process.env[CHILD_BASELINE_ENV] = previous;
    rmSync(root, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test("search filters file paths/status without mutating the source list", () => {
  const files = [
    { path: "/repo/src/auth.ts", rel: "src/auth.ts", status: "modified" as const, before: "needle", after: "", added: 0, removed: 1 },
    { path: "/repo/docs/guide.md", rel: "docs/guide.md", status: "added" as const, before: "", after: "needle", added: 1, removed: 0 }
  ];
  assert.deepEqual(filterChanges(files, "AUTH").files.map(item => item.rel), ["src/auth.ts"]);
  assert.deepEqual(filterChanges(files, "added").files.map(item => item.rel), ["docs/guide.md"]);
  assert.deepEqual(filterChanges(files, "missing").files, []);
  assert.deepEqual(filterChanges(files, "").files, files);
  assert.equal(files.length, 2);
});

test("large diffs default to a summary and permit an explicitly chosen bounded full preview", () => {
  const before = Array.from({ length: 1800 }, (_, index) => `old ${index}`).join("\n");
  const after = Array.from({ length: 1800 }, (_, index) => `new ${index}`).join("\n");
  const change = { path: "/repo/large.ts", rel: "large.ts", status: "modified" as const, before, after, added: 1800, removed: 1800, diff: null };
  assert.equal(fullReviewRequired(change), true);
  assert.equal(fullReviewSupported(change), true);
  const summary = renderDiff(change, 100, plain);
  assert.match(summary.join("\n"), /Summary preview/);
  assert.match(summary.join("\n"), /Press v/);
  const full = renderDiff(change, 100, plain, { fullReview: true, scroll: 500, rows: 20 });
  assert.ok(full.length <= 22, "the viewport renderer returns a bounded page, not the entire diff");
  assert.match(full.join("\n"), /Coarse preview/);
  assert.match(full.join("\n"), /old 4/);
  const tooMany = { ...change, before: "x\n".repeat(MAX_REVIEW_DIFF_LINES), after: "y\n".repeat(1) };
  assert.equal(fullReviewSupported(tooMany), false);
  assert.match(renderDiff(tooMany, 100, plain, { fullReview: true }).join("\n"), /Full review unavailable/);
});

test("rendered diff keeps indentation, strips escapes and fits the pane", () => {
  const change = { path: "/x/a.ts", rel: "a.ts", status: "modified" as const, before: "  a\n", after: "  a\n\tb\x1b[31mred\n", added: 1, removed: 0 };
  const lines = renderDiff(change, 30, plain).map(stripTerminalSequences);
  assert.ok(lines.every((line) => visibleWidth(line) <= 30));
  assert.ok(lines.some((line) => line.includes("   a")), "context keeps indentation");
  assert.ok(lines.some((line) => line.includes("+  bred")));
  const sideBySide = renderDiff(change, 60, plain, { unified: false });
  assert.ok(sideBySide.some(line => line.includes("│")), "split view separates original and updated columns");
  assert.ok(sideBySide.some(line => line.includes("+")));
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
    events.get("tool_call")!({ toolName: "edit", toolCallId: "a", input: { path: "a.ts" } });
    events.get("tool_call")!({ toolName: "write", toolCallId: "b", input: { path: join(root, "b.ts") } });
    events.get("tool_call")!({ toolName: "read", toolCallId: "c", input: { path: "c.ts" } });
    writeFileSync(join(root, "a.ts"), "A\n");
    writeFileSync(join(root, "b.ts"), "B\n");
    events.get("tool_result")!({ toolName: "edit", toolCallId: "a" });
    assert.equal(changed, 1);
    assert.equal(tracker.count(), 1, "only the completed edit is marked dirty");
    events.get("tool_result")!({ toolName: "write", toolCallId: "b" });
    assert.equal(tracker.count(), 2);
    events.get("tool_call")!({ toolName: "edit", toolCallId: "failed", input: { path: "a.ts" } });
    events.get("tool_result")!({ toolName: "edit", toolCallId: "failed", isError: true });
    assert.equal(tracker.count(), 2, "failed edits do not add dirty work");
    let component: any;
    let closed = false;
    const ctx = { hasUI: true, mode: "tui", ui: { notify() {}, custom(factory: Function) {
      return new Promise<void>((resolve) => { component = factory({ requestRender() {} }, { fg: plain, bold: (t: string) => t }, {}, () => { closed = true; resolve(); }); });
    } } };
    const view = openDiffView(ctx as never, tracker);
    const rendered = component.render(160).map(stripTerminalSequences).join("\n");
    assert.match(rendered, /± CHANGES · 2\/2 files · \+2 −2/);
    assert.match(rendered, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "/a\\.ts"), "full absolute path heads the right column");
    assert.match(rendered, /-a/);
    assert.match(rendered, /\+A/);
    component.handleInput("/");
    for (const key of "b.ts") component.handleInput(key);
    const searched = component.render(100).map(stripTerminalSequences).join("\n");
    assert.match(searched, /1\/2 files/);
    assert.match(searched, /b\.ts/);
    component.handleInput("\r");
    component.handleInput("\u001b"); // clear the filter
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

test("review actions are a vertical list and clicking one runs it", async () => {
  const root = workspace();
  try {
    writeFileSync(join(root, "a.ts"), "a\n");
    const tracker = new ChangeTracker(() => root);
    tracker.capture("a.ts");
    writeFileSync(join(root, "a.ts"), "A\n");
    tracker.markDirty("a.ts");
    let component: any;
    const ctx = { hasUI: true, mode: "tui", ui: { notify() {}, custom(factory: Function) {
      return new Promise<void>((resolve) => { component = factory({ requestRender() {} }, { fg: plain, bold: (t: string) => t }, {}, resolve); });
    } } };
    const view = openDiffView(ctx as never, tracker);
    const lines = component.render(100).map(stripTerminalSequences);
    const rows = ["a  Accept this file", "r  Revert this file", "A  Accept all files", "R  Revert all files"].map((label) => lines.findIndex((line: string) => line.includes(label)));
    assert.ok(rows.every((row, index) => row > 0 && (index === 0 || row === rows[index - 1]! + 1)), "one action per row");
    component.handleMouse({ type: "click", button: "left", x: 6, y: rows[2] });
    await view;
    assert.equal(tracker.count(), 0, "Accept all ran");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
