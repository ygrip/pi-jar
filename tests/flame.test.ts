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

test("flame is one continuous body with a rounded base and a moving tip", () => {
  const sim = new FlameSim(7);
  const tips = new Set<string>();
  let tall = 0;
  for (let frame = 0; frame < 60; frame++) {
    sim.step();
    const rows = sim.render(plain, false).map(stripTerminalSequences).map((row) => row.replace(/[•∙·✦*]/g, " "));
    const lit = rows.filter((row) => /[░▒▓█]/.test(row));
    // No gaps inside the body: every lit row below the tip is a single run.
    assert.ok(lit.slice(2).every((row) => (row.trim().match(/[░▒▓█]+/g) ?? []).length === 1), `frame ${frame}: continuous body`);
    const span = (row: string) => row.trimEnd().length - row.search(/\S/);
    assert.ok(span(rows.at(-1)!) < span(rows.at(-4)!), `frame ${frame}: rounded, narrower base`);
    tips.add(lit.slice(0, 3).join("\n"));
    if (/[░▒▓█]/.test(rows.slice(0, 4).join(""))) tall++;
  }
  assert.ok(tips.size > 20, "the tip keeps changing shape");
  assert.ok(tall > 30, `reaches the upper rows in ${tall}/60 frames`);
});

test("flame is centered on its middle column and narrower at the base than the belly", () => {
  for (const seed of [1, 7, 42]) {
    const sim = new FlameSim(seed);
    let sum = 0, weight = 0;
    const span = new Array(FLAME_ROWS).fill(0);
    for (let frame = 0; frame < 300; frame++) {
      sim.step();
      sim.render(plain, false).map(stripTerminalSequences).forEach((row, index) => {
        const fire = row.replace(/[•∙·✦*]/g, " ");
        const start = fire.search(/\S/);
        if (start < 0) return;
        span[index] += fire.trimEnd().length - start;
        for (let x = start; x < fire.length; x++) if (fire[x] !== " ") { sum += x; weight++; }
      });
    }
    const centroid = sum / weight;
    assert.ok(Math.abs(centroid - (FLAME_WIDTH - 1) / 2) < 0.15, `seed ${seed}: centroid ${centroid.toFixed(2)}`);
    const belly = Math.max(...span);
    assert.ok(span.at(-1)! < belly * 0.7, `seed ${seed}: base ${span.at(-1)} vs belly ${belly}`);
  }
  assert.equal(FLAME_WIDTH % 2, 1, "odd width keeps a true center column");
});

test("prng and truecolor detection are stable", () => {
  const a = prng(42), b = prng(42);
  for (let index = 0; index < 5; index++) assert.equal(a(), b());
  assert.equal(supportsTruecolor({ COLORTERM: "truecolor" }), true);
  assert.equal(supportsTruecolor({ COLORTERM: "", TERM: "xterm-256color" }), false);
});
