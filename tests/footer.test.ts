import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { renderFooter, type FooterView } from "../src/footer.ts";
import { DEFAULT_FOOTER_SETTINGS } from "../src/footer-settings.ts";
import { roleFrame } from "../src/animations.ts";
import { createDemoRoles } from "../src/roles.ts";
import { collectStatuses } from "../src/status.ts";

const plain = { fg: (_color: string, text: string) => text };
const base: FooterView = {
  model: "claude-sonnet", context: "ctx 58%", branch: "feature/testing",
  roles: [], extras: [], demo: false, animations: false, frame: 0
};

test("footer fits 16, 40, 80 and 120 terminal cells with critical role visible", () => {
  const role = { id: "gareng", label: "GAR", name: "Gareng", state: "failed" as const, task: "analysis" };
  for (const width of [16, 40, 80, 120]) {
    const lines = renderFooter({ ...base, roles: [role], extras: ["provider: busy"] }, width, plain);
    assert.ok(lines.length <= (width >= 32 ? 5 : 2));
    if (width >= 32) {
      assert.match(lines[0] ?? "", /^╭─/);
      assert.match(lines.at(-1) ?? "", /╯$/);
      assert.ok(lines.every((line) => visibleWidth(line) === width));
    }
    assert.ok(lines.every((line) => visibleWidth(line) <= width));
    if (width >= 40) assert.ok(lines.join(" ").includes("GAR ×"));
  }
});

test("footer shows the session name, truncates it, and preserves narrow-screen priorities", () => {
  const name = "A very long named session with many extra words that will not fit";
  const named = { ...base, sessionName: name };
  const wide = renderFooter(named, 120, plain);
  assert.ok(wide[1]?.includes(name));
  const medium = renderFooter(named, 80, plain);
  assert.match(medium[1] ?? "", /A very long named session.*…/);
  assert.match(medium[1] ?? "", /ctx 58%/);
  const urgent = { ...named, roles: [{ id: "gareng", label: "GAR", name: "Gareng", state: "failed" as const }] };
  const compact = renderFooter(urgent, 40, plain);
  assert.match(compact[1] ?? "", /GAR ×/);
  assert.match(compact[1] ?? "", /ctx 58%/);
  assert.ok(compact.every((line) => visibleWidth(line) <= 40));
  const sanitized = renderFooter({ ...base, sessionName: "Work\n\x1b[31mred\x1b[0m" }, 80, plain);
  assert.match(sanitized[1] ?? "", /Work red/);
  assert.ok(!sanitized.join("").includes("\x1b[31m"));
});

test("footer visibility toggles suppress fields and long CJK names and paths fit", () => {
  const view: FooterView = {
    ...base, sessionName: "日本語の長いセッション名を表示する", cwd: "/some/very/long/working/directory/with/a/project",
    cost: "$1", quota: { fiveHour: { used: 50 } } as FooterView["quota"],
    extras: ["advisor: busy"], roles: [{ id: "role", label: "ROL", name: "Role", state: "working" }]
  };
  for (const width of [16, 40, 80, 120]) {
    const lines = renderFooter(view, width, plain);
    assert.ok(lines.every((line) => visibleWidth(line) <= width));
    if (width >= 32) assert.ok(lines.every((line) => visibleWidth(line) === width));
  }
  assert.match(renderFooter(view, 80, plain)[1] ?? "", /日本/);
  assert.match(renderFooter(view, 80, plain)[1] ?? "", /…[^ ]*project/);
  const hidden = renderFooter({ ...view, settings: {
    ...DEFAULT_FOOTER_SETTINGS, model: false, sessionName: false, cwd: false, context: false,
    cost: false, quota: false, roles: false, extras: false, branch: false
  } }, 120, plain);
  assert.deepEqual(hidden, []);
  const contextOnly = renderFooter({ ...view, settings: {
    ...DEFAULT_FOOTER_SETTINGS, model: false, sessionName: false, cwd: false,
    cost: false, quota: false, roles: false, extras: false, branch: false
  } }, 120, plain).join(" ");
  assert.match(contextOnly, /ctx 58%/);
  assert.doesNotMatch(contextOnly, /claude-sonnet|日本|project|\$1|ROL|advisor|git/);
  const narrow = renderFooter({ ...view, settings: { ...DEFAULT_FOOTER_SETTINGS, roles: false, extras: false } }, 24, plain).join(" ");
  assert.match(narrow, /ctx 58%/);
  assert.doesNotMatch(narrow, /ROL/);
  const branchOnly = renderFooter({ ...view, settings: {
    ...DEFAULT_FOOTER_SETTINGS, model: false, sessionName: false, cwd: false, context: false,
    cost: false, quota: false, roles: false, extras: false
  } }, 80, plain).join(" ");
  assert.match(branchOnly, /git feature\/testing/);
});

test("status contract rejects stale, malformed and unsafe input without inventing live roles", () => {
  const now = 10_000;
  const statuses = new Map([
    ["pi-jar.role.gareng", JSON.stringify({ name: "Gareng", state: "working", expiresAt: now + 20_000 })],
    ["pi-jar.role.petruk", JSON.stringify({ name: "Petruk", state: "working", expiresAt: now - 1 })],
    ["pi-jar.role.bagong", "{not json"],
    ["advisor", "\u001b[31mconsulting\u001b[0m\nnow"]
  ]);
  const result = collectStatuses(statuses, now);
  assert.deepEqual(result.roles.map((role) => role.name), ["Gareng"]);
  assert.ok(result.extras.includes("petruk: unavailable"));
  assert.ok(result.extras.includes("bagong: unavailable"));
  assert.ok(result.extras.includes("advisor: consulting now"));
  const expiredDone = new Map([["pi-jar.role.gareng", JSON.stringify({ name: "Gareng", state: "done", expiresAt: now - 1 })]]);
  assert.deepEqual(collectStatuses(expiredDone, now).roles, []);
  assert.deepEqual(collectStatuses(expiredDone, now).extras, ["gareng: unavailable"]);
});

test("live teammate names and labels are publisher-controlled; generic demo stays synthetic", () => {
  const now = Date.now();
  const live = collectStatuses(new Map([
    ["pi-jar.role.release-42", JSON.stringify({ name: "Release lead", label: "REL", state: "reviewing", expiresAt: now + 5_000 })]
  ]), now);
  assert.deepEqual(live.roles.map((role) => [role.id, role.name, role.label]), [["release-42", "Release lead", "REL"]]);
  assert.match(renderFooter({ ...base, ...live }, 80, plain).join(" "), /REL/);
  assert.deepEqual(createDemoRoles().map((role) => role.name), ["Explorer", "Builder", "Reviewer"]);
  assert.match(renderFooter({ ...base, roles: createDemoRoles(), demo: true }, 80, plain)[1] ?? "", /DEMO/);
});

test("failed role is prioritized over other roles on compact layouts", () => {
  const view: FooterView = {
    ...base,
    roles: [
      { id: "gareng", label: "GAR", name: "Gareng", state: "working" },
      { id: "bagong", label: "BAG", name: "Bagong", state: "failed" }
    ]
  };
  assert.match(renderFooter(view, 40, plain)[1] ?? "", /BAG ×/);
  assert.match(renderFooter(view, 80, plain)[2] ?? "", /BAG ×/);
});

test("animation off is static, demo marked and ordinary Unicode doesn't overrun", () => {
  const view: FooterView = {
    ...base, demo: true, model: "測試 model", roles: [{ id: "petruk", name: "Petruk", label: "PET", state: "working" }]
  };
  const before = renderFooter({ ...view, frame: 0 }, 80, plain);
  const after = renderFooter({ ...view, frame: 7 }, 80, plain);
  assert.deepEqual(before, after);
  assert.ok(before[1]?.includes("DEMO"));
  assert.ok(before.every((line) => visibleWidth(line) <= 80));
  assert.notEqual(roleFrame("thinking", 0, false), roleFrame("idle", 0, false));
  const motion = renderFooter({ ...view, animations: true, frame: 1 }, 80, plain);
  assert.notEqual(motion[0], renderFooter({ ...view, animations: true, frame: 2 }, 80, plain)[0]);
  assert.deepEqual(motion.slice(1), renderFooter({ ...view, animations: true, frame: 1 }, 80, plain).slice(1));
});
