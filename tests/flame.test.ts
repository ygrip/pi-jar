import assert from "node:assert/strict";
import test from "node:test";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { FLAME_ROWS, FLAME_WIDTH, FlameSim, MAX_PARTICLES, flameFrame, prng, supportsTruecolor } from "../src/flame.ts";

const plain = (_color: string, text: string) => text;

test("flame rows keep a fixed footprint in truecolor and shaded fallbacks", () => {
  for (const truecolor of [true, false]) {
    for (let frame = 0; frame < 40; frame++) {
      const rows = flameFrame(frame, 3, plain, truecolor);
      assert.equal(rows.length, FLAME_ROWS);
      assert.ok(rows.every((row) => visibleWidth(row) === FLAME_WIDTH), `frame ${frame} width`);
    }
  }
});

test("flame is deterministic per seed and frame, and animates over time", () => {
  const sim = new FlameSim(5);
  while (sim.frame < 12) sim.step();
  assert.deepEqual(flameFrame(12, 5, plain, true), sim.render(plain, true));
  assert.deepEqual(flameFrame(7, 9, plain, true), flameFrame(7, 9, plain, true));
  const frames = new Set(Array.from({ length: 12 }, (_, frame) => flameFrame(frame, 9, plain, true).join("\n")));
  assert.ok(frames.size > 6, "adjacent frames differ");
  assert.notDeepEqual(flameFrame(4, 1, plain, true), flameFrame(4, 2, plain, true), "seeds give different fires");
});

test("flame reads as a torch: hot base, empty edges, embers above", () => {
  let sawParticle = false;
  const sim = new FlameSim(11);
  for (let frame = 0; frame < 60; frame++) {
    sim.step();
    assert.ok(sim.particleCount() <= MAX_PARTICLES, "particle cap");
    const rows = sim.render(plain, false).map(stripTerminalSequences);
    assert.match(rows.at(-1)!, /█/, "bright core at the base");
    assert.ok(rows.every((row) => row[0] === " " && row.at(-1) === " "), "edges stay transparent");
    if (rows.some((row) => /[•∙·✦*]/.test(row))) sawParticle = true;
  }
  assert.ok(sawParticle, "embers or sparks rise from the flame");
  assert.ok(flameFrame(0, 1, plain, true).join("").includes("\x1b[38;2;255;243;196m"), "pale-gold core color");
});

test("flame breaks into several protruding tongues that reach the top", () => {
  const sim = new FlameSim(7);
  let forked = 0, tall = 0;
  for (let frame = 0; frame < 60; frame++) {
    sim.step();
    const rows = sim.render(plain, false).map(stripTerminalSequences).map((row) => row.replace(/[•∙·✦*]/g, " "));
    // Separate lit runs in the upper half mean distinct spikes, not one smooth teardrop.
    if (rows.slice(2, 6).some((row) => (row.trim().match(/[░▒▓█]+/g) ?? []).length >= 3)) forked++;
    if (/[░▒▓█]/.test(rows.slice(0, 2).join(""))) tall++;
  }
  assert.ok(forked > 30, `forked in ${forked}/60 frames`);
  assert.ok(tall > 20, `reached the top in ${tall}/60 frames`);
});

test("prng and truecolor detection are stable", () => {
  const a = prng(42), b = prng(42);
  for (let index = 0; index < 5; index++) assert.equal(a(), b());
  assert.equal(supportsTruecolor({ COLORTERM: "truecolor" }), true);
  assert.equal(supportsTruecolor({ COLORTERM: "", TERM: "xterm-256color" }), false);
});
