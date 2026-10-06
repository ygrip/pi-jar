#!/usr/bin/env node
// Cost/shape report for one Pi session JSONL: model calls, cost split, context buckets, tool counts,
// repeated reads, cache misses and injected-message overhead. A regression baseline for the
// session-cost work in docs/EFFICIENCY_PLAN.md; it only reads the file and never changes the session.
//
//   node scripts/session-cost.mjs <session.jsonl | session-id> [--json]
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
const json = args.includes("--json");
const target = args.find((arg) => !arg.startsWith("--"));
if (!target) {
  console.error("usage: node scripts/session-cost.mjs <session.jsonl | session-id> [--json]");
  process.exit(2);
}

/** A bare id is looked up under Pi's session directory (one level of project folders). */
function resolveSession(value) {
  if (existsSync(value)) return value;
  const root = join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), "sessions");
  for (const project of existsSync(root) ? readdirSync(root) : []) {
    let names;
    try { names = readdirSync(join(root, project)); } catch { continue; }
    const match = names.find((name) => name.endsWith(".jsonl") && name.includes(value));
    if (match) return join(root, project, match);
  }
  console.error(`session not found: ${value}`);
  process.exit(2);
}

const file = resolveSession(target);
const entries = [];
readFileSync(file, "utf8").split("\n").forEach((line, index) => {
  if (!line.trim()) return;
  try { entries.push(JSON.parse(line)); } catch (error) { console.error(`line ${index + 1}: ${error.message}`); }
});

const BUCKETS = [[0, 50_000], [50_000, 100_000], [100_000, 125_000], [125_000, 200_000], [200_000, Infinity]];
const IDLE_MS = 5 * 60_000;
/** Uncached input above this on a non-first call means the provider cache did not hit. */
const MISS_TOKENS = 20_000;

const textLength = (content) => typeof content === "string" ? content.length
  : Array.isArray(content) ? content.reduce((sum, part) => sum + (typeof part?.text === "string" ? part.text.length : 0), 0) : 0;
const round = (value) => Math.round(value * 1000) / 1000;
const kTokens = (value) => `${Math.round(value / 1000)}k`;

const report = {
  file, userPrompts: 0, calls: 0, singleToolCalls: 0, compactions: 0,
  cost: { total: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
  context: { first: 0, avg: 0, max: 0, buckets: BUCKETS.map(([from, to]) => ({ from, to, calls: 0, cost: 0 })) },
  tools: {}, actions: {},
  reads: { calls: 0, bytes: 0, withoutLimit: 0, repeated: [] },
  cacheMisses: { calls: 0, cost: 0, idleGaps: [] },
  injected: {}
};

const pendingReads = new Map();
const readPaths = new Map();
let contextSum = 0;
let lastAssistantAt;
for (const entry of entries) {
  if (entry.type === "compaction") { report.compactions++; continue; }
  if (entry.type === "custom_message") {
    const item = report.injected[entry.customType ?? "?"] ??= { count: 0, chars: 0 };
    item.count++; item.chars += textLength(entry.content);
    continue;
  }
  if (entry.type !== "message" || !entry.message) continue;
  const message = entry.message;
  if (message.role === "user") {
    report.userPrompts++;
    const at = Number(message.timestamp);
    if (lastAssistantAt && at - lastAssistantAt > IDLE_MS) report.cacheMisses.idleGaps.push({ at: new Date(at).toISOString(), idleMinutes: Math.round((at - lastAssistantAt) / 60_000) });
    continue;
  }
  if (message.role === "toolResult") {
    const call = pendingReads.get(message.toolCallId);
    if (call) { report.reads.bytes += textLength(message.content); pendingReads.delete(message.toolCallId); }
    continue;
  }
  if (message.role !== "assistant") continue;
  const usage = message.usage ?? {};
  const cost = usage.cost ?? {};
  report.calls++;
  for (const key of Object.keys(report.cost)) report.cost[key] += Number(cost[key]) || 0;
  for (const key of Object.keys(report.tokens)) report.tokens[key] += Number(usage[key]) || 0;
  const context = (Number(usage.input) || 0) + (Number(usage.cacheRead) || 0) + (Number(usage.cacheWrite) || 0);
  if (report.calls === 1) report.context.first = context;
  else if ((Number(usage.input) || 0) > MISS_TOKENS) { report.cacheMisses.calls++; report.cacheMisses.cost += Number(cost.total) || 0; }
  contextSum += context;
  report.context.max = Math.max(report.context.max, context);
  const bucket = report.context.buckets.find((item) => context >= item.from && context < item.to);
  if (bucket) { bucket.calls++; bucket.cost += Number(cost.total) || 0; }
  lastAssistantAt = Number(message.timestamp) || lastAssistantAt;
  const calls = (Array.isArray(message.content) ? message.content : []).filter((part) => part?.type === "toolCall");
  if (calls.length === 1) report.singleToolCalls++;
  for (const call of calls) {
    const name = call.name ?? "?";
    report.tools[name] = (report.tools[name] ?? 0) + 1;
    const input = call.arguments ?? {};
    if (typeof input.action === "string") {
      const key = `${name} ${input.action}`;
      report.actions[key] = (report.actions[key] ?? 0) + 1;
    }
    if (name === "read") {
      report.reads.calls++;
      if (input.limit == null) report.reads.withoutLimit++;
      if (typeof input.path === "string") readPaths.set(input.path, (readPaths.get(input.path) ?? 0) + 1);
      pendingReads.set(call.id, true);
    }
  }
}
report.context.avg = report.calls ? Math.round(contextSum / report.calls) : 0;
report.reads.repeated = [...readPaths].filter(([, count]) => count > 1).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([path, count]) => ({ path, count }));
for (const key of Object.keys(report.cost)) report.cost[key] = round(report.cost[key]);
report.cacheMisses.cost = round(report.cacheMisses.cost);
for (const bucket of report.context.buckets) bucket.cost = round(bucket.cost);

if (json) {
  console.log(JSON.stringify(report, null, 2));
} else {
  const share = (value) => report.cost.total ? ` (${Math.round(value / report.cost.total * 100)}%)` : "";
  const sorted = (record) => Object.entries(record).sort((a, b) => b[1] - a[1]).map(([key, count]) => `${key} ${count}`).join(", ");
  console.log(`session      ${file}`);
  console.log(`prompts      ${report.userPrompts} user · ${report.calls} model calls (${report.singleToolCalls} with exactly one tool call) · ${report.compactions} compaction(s)`);
  console.log(`cost         $${report.cost.total.toFixed(2)} · cache read $${report.cost.cacheRead.toFixed(2)}${share(report.cost.cacheRead)} · output $${report.cost.output.toFixed(2)}${share(report.cost.output)} (${kTokens(report.tokens.reasoning)} reasoning) · input $${report.cost.input.toFixed(2)}${share(report.cost.input)} · cache write $${report.cost.cacheWrite.toFixed(2)}`);
  console.log(`context      first ${kTokens(report.context.first)} · avg ${kTokens(report.context.avg)} · peak ${kTokens(report.context.max)}`);
  for (const bucket of report.context.buckets) {
    const label = bucket.to === Infinity ? `>${kTokens(bucket.from)}` : `${kTokens(bucket.from)}–${kTokens(bucket.to)}`;
    console.log(`  ${label.padEnd(10)} ${String(bucket.calls).padStart(4)} calls  $${bucket.cost.toFixed(2)}`);
  }
  console.log(`tools        ${sorted(report.tools)}`);
  if (Object.keys(report.actions).length) console.log(`actions      ${sorted(report.actions)}`);
  console.log(`reads        ${report.reads.calls} calls · ${Math.round(report.reads.bytes / 1024)} KB returned · ${report.reads.withoutLimit} without limit`);
  for (const item of report.reads.repeated) console.log(`  ×${item.count} ${item.path}`);
  console.log(`cache misses ${report.cacheMisses.calls} calls with >${kTokens(MISS_TOKENS)} uncached input · $${report.cacheMisses.cost.toFixed(2)}` +
    (report.cacheMisses.idleGaps.length ? ` · idle gaps ${report.cacheMisses.idleGaps.map((gap) => `${gap.at.slice(11, 16)} (${gap.idleMinutes}m)`).join(", ")}` : ""));
  const injected = Object.entries(report.injected).sort((a, b) => b[1].chars - a[1].chars);
  if (injected.length) console.log(`injected     ${injected.map(([type, item]) => `${type} ${item.count}× ${Math.round(item.chars / 1024)} KB`).join(", ")}`);
}
