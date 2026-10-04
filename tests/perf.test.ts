import assert from "node:assert/strict";
import test from "node:test";
import { CONTEXT_SAMPLE_MAX_MS, CONTEXT_SAMPLE_MS, ContextSampler, formatPerf, LARGE_SESSION_ENTRIES, processRss, RENDER_TIERS, RenderScheduler, renderTier, type RenderKind } from "../src/perf.ts";

/** 100 synchronous deltas, then 100 more spread one per 10 ms over a second, then a long quiet tail. */
function backgroundWorkload(tick: (ms: number) => void, entries: number) {
  let renders = 0;
  const scheduler = new RenderScheduler(() => { renders++; return true; });
  scheduler.setEntries(entries);
  for (let index = 0; index < 100; index++) scheduler.request("subagents");
  tick(0);
  const burst = renders;
  for (let index = 0; index < 100; index++) { scheduler.request(index % 2 ? "shells" : "subagents"); tick(10); }
  tick(5000);
  const stats = scheduler.stats();
  scheduler.dispose();
  return { burst, renders, stats };
}

test("background bursts coalesce to one repaint per tier interval, and larger sessions repaint less", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const tick = (ms: number) => t.mock.timers.tick(ms);
  const small = backgroundWorkload(tick, 0);
  assert.equal(small.burst, 1, "100 synchronous updates are one frame");
  // Spread deltas repaint at most every 250 ms: 250, 500, 750 and 1000 after the burst's frame at 0.
  assert.equal(small.renders, 5);
  assert.equal(small.stats.requested, 200);
  assert.equal(small.stats.actual, 5);
  assert.equal(small.stats.coalesced, 195, "every request is either drawn or folded into a frame");
  assert.deepEqual(small.stats.sources, [["subagents", 150], ["shells", 50]]);
  assert.deepEqual(small.stats.recent.at(-1)?.split("+").sort(), ["shells", "subagents"], "a coalesced frame names every source it covers");

  const medium = backgroundWorkload(tick, 300);
  assert.equal(medium.renders, 3);
  const large = backgroundWorkload(tick, LARGE_SESSION_ENTRIES);
  assert.equal(large.renders, 2, "the large tier waits a full second between background frames");
  assert.equal(large.stats.tier, "large");
  assert.equal(large.stats.intervalMs, 1000);

  const veryLarge = backgroundWorkload(tick, 5000);
  assert.equal(veryLarge.renders, 0, "very large sessions leave background deltas to the next frame");
  assert.equal(veryLarge.stats.deferred, 200);
  assert.equal(veryLarge.stats.dirty, true);
  assert.equal(veryLarge.stats.intervalMs, undefined);
});

test("very large sessions still render transitions; foreground renders are synchronous and absorb pending work", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  let renders = 0;
  const scheduler = new RenderScheduler(() => { renders++; return true; });
  scheduler.setEntries(2500);
  scheduler.request("subagents");
  scheduler.request("subagents", "transition");
  assert.equal(renders, 1, "a state transition renders at once even in a very large session");
  assert.equal(scheduler.stats().dirty, false);

  scheduler.setEntries(10);
  scheduler.request("subagents");
  assert.equal(scheduler.stats().pending, true);
  scheduler.request("settings", "foreground");
  assert.equal(renders, 2, "user actions render synchronously");
  t.mock.timers.tick(1000);
  assert.equal(renders, 2, "the foreground frame already showed the pending background delta");
  const kinds: Record<RenderKind, number> = { foreground: 1, transition: 1, background: 2 };
  assert.deepEqual(scheduler.stats().kinds, kinds);
  scheduler.dispose();
});

test("any footer paint satisfies pending background work; a focused Activity view takes over live updates", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  let renders = 0;
  const scheduler = new RenderScheduler(() => { renders++; return true; });
  scheduler.request("subagents");
  scheduler.painted(); // Pi drew a frame of its own (streaming, typing) before the repaint was due.
  t.mock.timers.tick(1000);
  assert.equal(renders, 0);
  assert.equal(scheduler.stats().frames, 1);
  // The next repaint is budgeted from that frame, not from our last one.
  t.mock.timers.tick(100);
  scheduler.painted();
  scheduler.request("shells");
  t.mock.timers.tick(249);
  assert.equal(renders, 0);
  t.mock.timers.tick(1);
  assert.equal(renders, 1);

  scheduler.setFocused(true);
  for (let index = 0; index < 50; index++) scheduler.request("subagents");
  t.mock.timers.tick(1000);
  assert.equal(renders, 1, "the open Activity view repaints itself and the footer with it");
  assert.equal(scheduler.stats().deferred, 50);
  assert.deepEqual(RENDER_TIERS.map((tier) => tier.focusedMs), [100, 150, 250, 500]);
  assert.equal(scheduler.focusedMs(), 100);
  scheduler.setEntries(5000);
  assert.equal(scheduler.focusedMs(), 500, "the focused cadence still slows down as the transcript beneath grows");
  scheduler.setFocused(false);
  scheduler.dispose();
});

test("dispose clears the pending repaint and ignores late requests", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  let renders = 0;
  const scheduler = new RenderScheduler(() => { renders++; return true; });
  scheduler.request("subagents");
  assert.equal(scheduler.stats().pending, true);
  scheduler.dispose();
  assert.equal(scheduler.stats().pending, false);
  scheduler.request("shells");
  scheduler.request("quota", "transition");
  t.mock.timers.tick(10_000);
  assert.equal(renders, 0);
  assert.equal(scheduler.stats().requested, 1);
});

test("tiers follow the branch entry count; frames without a view are not counted as renders", () => {
  assert.deepEqual([0, 299, 300, 799, 800, 1999, 2000, 50_000].map((entries) => renderTier(entries).name),
    ["small", "small", "medium", "medium", "large", "large", "very large", "very large"]);
  const scheduler = new RenderScheduler(() => false);
  scheduler.addEntries(3);
  scheduler.request("settings", "foreground");
  const stats = scheduler.stats();
  assert.equal(stats.entries, 3);
  assert.equal(stats.actual, 0);
  assert.equal(stats.skipped, 1);
  scheduler.dispose();
});

test("context usage is cached, sampled once per window during message bursts, refreshed at boundaries", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  let calls = 0;
  let percent = 10;
  let changed = 0;
  const read = () => { calls++; return { percent }; };
  const sampler = new ContextSampler(() => { changed++; });
  assert.equal(sampler.label, "ctx ?");
  sampler.refresh(read); // session_start
  assert.equal(calls, 1);
  assert.equal(sampler.label, "ctx 10%");
  // A tool-heavy turn: 50 tool-result message ends 10 ms apart.
  for (let index = 0; index < 50; index++) {
    percent = 11 + index;
    sampler.markDirty(read);
    t.mock.timers.tick(10);
  }
  assert.equal(calls, 1, "message ends inside the throttle window do not recompute");
  assert.equal(sampler.label, "ctx 10%", "the cached value stays available between samples");
  assert.equal(sampler.dirty, true);
  t.mock.timers.tick(250);
  assert.equal(calls, 2, "one sample for the whole burst once the window allows");
  assert.equal(sampler.label, "ctx 60%");
  assert.equal(changed, 1, "a changed label asks for a background repaint");
  percent = 3;
  sampler.refresh(read); // session_compact, inside the next window
  assert.equal(calls, 3, "lifecycle boundaries recompute immediately");
  assert.equal(sampler.label, "ctx 3%");
  assert.equal(changed, 1, "boundary refreshes leave repainting to the caller");
  sampler.markDirty(read);
  sampler.markDirty(() => { throw new Error("no model"); });
  t.mock.timers.tick(750);
  assert.equal(sampler.label, "ctx ?", "a failing computation shows unknown rather than a stale value");
  const stats = sampler.stats();
  assert.equal(stats.calls, 4);
  assert.equal(stats.errors, 1);
  assert.equal(stats.marks, 52);
  assert.equal(stats.lastSampleAgeMs, 0);
  assert.equal(typeof stats.medianMs, "number");
  sampler.markDirty(read);
  assert.equal(sampler.stats().pending, true);
  sampler.dispose(); // session_shutdown
  assert.equal(sampler.stats().pending, false);
  t.mock.timers.tick(10_000);
  assert.equal(calls, 3, "no sample after shutdown");
});

test("context sampling widens its mid-turn window with the measured sample cost", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  let calls = 0;
  // A large session: each usage walk costs ~20 ms of real time.
  const slow = () => { calls++; const until = performance.now() + 20; while (performance.now() < until) { /* busy */ } return { percent: 50 }; };
  const sampler = new ContextSampler(() => {});
  assert.equal(sampler.stats().windowMs, CONTEXT_SAMPLE_MS, "no measurement keeps the base window");
  sampler.refresh(slow);
  const window = sampler.stats().windowMs;
  assert.ok(window >= 2000 && window <= CONTEXT_SAMPLE_MAX_MS, `window ${window} follows ~1% duty cycle`);
  sampler.markDirty(slow);
  t.mock.timers.tick(1500);
  assert.equal(calls, 1, "a costly session does not resample at the base 750 ms cadence");
  t.mock.timers.tick(CONTEXT_SAMPLE_MAX_MS);
  assert.equal(calls, 2, "the widened window still samples within the cap");
  sampler.refresh(slow);
  assert.equal(calls, 3, "boundaries refresh immediately regardless of cost");
  sampler.dispose();
});

test("/jar perf formats every section from on-demand stats", () => {
  const text = formatPerf({
    entries: 1142, context: "ctx 78%", rssBytes: 612 * 1048576, now: 100_000,
    render: (() => {
      const scheduler = new RenderScheduler(() => true, () => 0);
      scheduler.setEntries(1142);
      scheduler.request("subagents", "transition");
      const stats = scheduler.stats();
      scheduler.dispose();
      return stats;
    })(),
    sampling: { label: "ctx 78%", calls: 12, errors: 0, marks: 340, totalMs: 4.5, maxMs: 1.25, medianMs: 0.3, lastSampleAgeMs: 3200, windowMs: 750, dirty: false, pending: false },
    subagents: { retained: 4, live: 2, hibernated: 2, recovery: 1, recoveryLimit: 4, pids: [101, 202] },
    childRssBytes: 300 * 1048576,
    shells: { live: 2, finished: 8, retainedChars: 2_400_000, budgetChars: 8_000_000, services: 1, oldestLiveStartedAt: 40_000,
      jobs: [] },
    discussion: { transport: "broker", listening: true, agents: 3, messages: 31, maxMessages: 128, bytes: 12_288, maxBytes: 65_536,
      unanswered: 2, unread: 1, oldestId: 4, newestId: 34, requests: 120, errors: 0 },
    quota: { enabled: true, requests: 3, failures: 1, providers: [{ provider: "anthropic", pending: false, failures: 1, ok: false, ageMs: 120_000, retryInMs: 180_000 }] },
    sideCalls: 7
  });
  for (const section of ["session", "subagents", "render", "context sampling", "shells", "discussion", "quota"]) {
    assert.match(text, new RegExp(`^${section}$`, "m"), section);
  }
  assert.match(text, /branch entries\s+1,142/);
  assert.match(text, /parent rss\s+612 MiB/);
  assert.match(text, /live children\s+2 \(pid 101, 202\)/);
  assert.match(text, /child rss\s+300 MiB/);
  assert.match(text, /recovery worktrees\s+1 \/ 4/);
  assert.match(text, /tier\s+large · background ≥ 1000 ms/);
  assert.match(text, /last sources\s+subagents/);
  assert.match(text, /dirty marks\s+340/);
  assert.match(text, /last sample age\s+3\.2 s/);
  assert.match(text, /output retained\s+2\.4M \/ 8\.0M chars/);
  assert.match(text, /oldest live\s+1m 0s/);
  assert.match(text, /messages\s+31 \/ 128 \(#4–#34\)/);
  assert.match(text, /unanswered\s+2 \(1 unread\)/);
  assert.match(text, /anthropic\s+cached 2m 0s ago · failed ×1 · next in 3m 0s/);
  assert.match(text, /side calls\s+7/);
  const bare = formatPerf({ entries: 0, context: "ctx ?", rssBytes: 1048576, now: 0 });
  assert.doesNotMatch(bare, /^(subagents|render|shells|discussion|quota)$/m, "sections without data are omitted");
});

test("child RSS comes from one ps call and is skipped when unavailable", { skip: process.platform === "win32" }, async () => {
  assert.equal(await processRss([]), undefined);
  assert.equal(await processRss([-1, 0, Number.NaN]), undefined);
  const own = await processRss([process.pid]);
  assert.ok(own !== undefined && own > 1048576, "this process has a measurable RSS");
});
