import assert from "node:assert/strict";
import test from "node:test";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { contextBreakdown, contextLines } from "../src/context-view.ts";
import { openPanel, tokens } from "../src/panel.ts";
import { collectUsage, usageLines } from "../src/usage-view.ts";

const plain = (_color: string, text: string) => text;
const assistant = (model: string, input: number, output: number, cost: number, at: string) => ({ type: "message", timestamp: at,
  message: { role: "assistant", provider: "anthropic", model, usage: { input, output, cacheRead: 1000, cacheWrite: 0, cost: { total: cost } } } });

test("usage totals the session per model, adds side calls and shows limit bars", () => {
  const entries = [
    { type: "message", timestamp: "2026-09-25T10:00:00Z", message: { role: "user", content: "hi" } },
    assistant("opus", 12_000, 800, 0.5, "2026-09-25T10:01:00Z"),
    assistant("opus", 2_000, 200, 0.25, "2026-09-25T10:02:00Z"),
    { type: "custom", timestamp: "2026-09-25T10:03:00Z" }
  ];
  const stats = collectUsage(entries, [{ role: "advisor", model: "anthropic/opus", input: 500, output: 100, cacheRead: 0, cacheWrite: 0, cost: 0.1, at: 0 }]);
  assert.equal(stats.prompts, 1);
  assert.equal(stats.responses, 2);
  assert.equal(stats.models[0]!.calls, 2);
  assert.ok(Math.abs(stats.total.cost - 0.85) < 1e-9);
  const now = Date.parse("2026-09-25T10:42:00Z");
  const lines = usageLines({ stats, provider: "anthropic", quotaEnabled: true, now,
    quota: { fiveHour: { used: 38, resetsAt: now + 2 * 3_600_000 }, week: { used: 92 } } }, 80, plain);
  const text = lines.join("\n");
  assert.match(text, /Total cost\s+\$0\.85/);
  assert.match(text, /Total duration\s+42m/);
  assert.match(text, /Tokens\s+14\.5k in · 1000 out · 2\.0k cache read|Tokens\s+15k in/);
  assert.match(text, /anthropic\/opus\s+\$0\.75/);
  assert.match(text, /advisor → anthropic\/opus\s+\$0\.10[\s\S]*1 call/);
  assert.match(text, /Current session \(5h\)\n\s+█+░+ 38% used\n\s+Resets .* \(in 2h 0m\)/);
  assert.match(text, /Current week\n\s+█+░* 92% used/);
  assert.ok(lines.every((line) => visibleWidth(line) <= 80));
  assert.match(usageLines({ stats, provider: "openai", quotaEnabled: true, now }, 80, plain).join("\n"), /available for anthropic and openai-codex/);
  assert.match(usageLines({ stats, provider: "anthropic", quotaEnabled: false, now }, 80, plain).join("\n"), /\/jar quota on/);
});

test("context breakdown splits categories, scales to the reported total and draws a 10×10 grid", () => {
  const view = contextBreakdown({
    model: "anthropic/opus", window: 200_000, reported: 40_000, reserve: 16_384,
    systemPrompt: "s".repeat(8000) + "AGENTS".repeat(1000),
    contextFiles: [{ path: "/p/AGENTS.md", content: "AGENTS".repeat(1000) }],
    skills: [{ name: "deploy", description: "Deploy things", filePath: "/s/deploy/SKILL.md" }],
    tools: [{ name: "read", description: "Read a file", parameters: { type: "object" } }],
    messages: [
      { role: "user", content: "u".repeat(4000) },
      { role: "assistant", content: [{ type: "text", text: "a".repeat(2000) }, { type: "toolCall", arguments: { path: "x" } }] },
      { role: "toolResult", content: [{ type: "text", text: "t".repeat(20_000) }] },
      { role: "compactionSummary", summary: "c".repeat(1000) },
      { role: "custom", content: "x".repeat(400) }
    ]
  });
  const total = view.parts.reduce((sum, part) => sum + part.tokens, 0);
  assert.ok(Math.abs(total - 40_000) <= view.parts.length, "scaled to the reported tokens");
  assert.deepEqual(view.parts.map((part) => part.key), ["system", "tools", "files", "skills", "summary", "user", "assistant", "tool", "custom"]);
  const lines = contextLines(view, 90, plain);
  const grid = lines.slice(0, 10).map((line) => line.slice(0, 19));
  assert.ok(grid.every((line) => /^([⛁⛀⛶⛝] ){9}[⛁⛀⛶⛝]$/.test(line)), "ten rows of ten cells");
  const cells = grid.join("").replace(/ /g, "");
  assert.equal([...cells].filter((cell) => cell === "⛝").length, 8, "autocompact buffer ≈ 8%");
  const text = lines.join("\n");
  assert.match(text, /anthropic\/opus · 40k\/200k tokens \(20%\)/);
  assert.match(text, /Tool results: \d+(\.\d)?k/);
  assert.match(text, /Free space: 144k/);
  assert.match(text, /Context files\n\s+\/p\/AGENTS\.md/);
  assert.ok(lines.every((line) => visibleWidth(line) <= 90));
  const narrow = contextLines(view, 40, plain);
  assert.ok(narrow.indexOf("") === 10, "narrow widths stack the legend under the grid");
  assert.match(contextLines({ ...view, window: 0 }, 90, plain).join("\n"), /context window unknown[\s\S]*System prompt: [\d.]+k$/m);
  assert.equal(tokens(1500), "1.5k");
  assert.equal(tokens(2_500_000), "2.5M");
});

test("panel switches tabs with Tab and a click, scrolls and closes", async () => {
  let component: any;
  const ctx = { hasUI: true, mode: "tui", ui: { custom(factory: Function) {
    return new Promise<void>((resolve) => { component = factory({ requestRender() {} }, { fg: plain, bold: (t: string) => t }, {}, resolve); });
  } } };
  const done = openPanel(ctx as never, [{ name: "Usage", render: () => ["usage body"] }, { name: "Context", render: () => Array.from({ length: 200 }, (_, i) => "ctx " + i) }]);
  const text = () => component.render(80).map(stripTerminalSequences).join("\n");
  assert.match(text(), /\[Usage\]  Context [\s\S]*usage body/);
  component.handleInput("\t");
  assert.match(text(), /\[Context\][\s\S]*ctx 0/);
  component.handleInput("j");
  assert.doesNotMatch(text(), /ctx 0\b/);
  component.handleMouse({ type: "click", button: "left", x: 3, y: 1 });
  assert.match(text(), /\[Usage\]/);
  component.handleInput("\x1b");
  await done;
});
