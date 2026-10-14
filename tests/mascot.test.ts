import assert from "node:assert/strict";
import test from "node:test";
import { COMPOSER_ACTIVE_INTERVAL_MS } from "../src/composer.ts";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { EMBER_PALETTE, Mascot, MASCOT_FACE_WIDTH, MASCOT_TIP_WIDTH, MASCOT_SPRITE_WIDTH, MASCOT_SPRITE_HEIGHT, SLEEPY_AFTER_MS, mascotFace, mascotPixels, mascotSprite, mascotPerch, mascotTip, mascotSpark, paintFace, paintTip, type MascotMood } from "../src/mascot.ts";

test("idle mascot schedules exact state transitions instead of polling", () => {
  const mascot = new Mascot(0, () => 0);
  assert.equal(mascot.nextTransitionDelay(0), 3000);
  assert.equal(mascot.mood(3000), "blink");
  assert.equal(mascot.nextTransitionDelay(3000), 180);
  assert.equal(mascot.mood(3180), "idle");
  assert.equal(mascot.nextTransitionDelay(3180), 3000);

  mascot.flash("poke", 500, 4000);
  assert.equal(mascot.nextTransitionDelay(4000), 200, "an idle reaction schedules its next pose, not just its expiry");
  assert.equal(mascot.nextTransitionDelay(4200), 300, "the last pose is bounded by flash expiry");
  assert.notEqual(mascot.key(4000), mascot.key(4200), "hop poses participate in change detection");
  assert.ok((mascot.nextTransitionDelay(4500) ?? 0) > 600, "expired reactions return to sparse idle deadlines");

  mascot.setPhase("generating", 5000);
  assert.equal(mascot.nextTransitionDelay(5000), undefined, "active phases are driven by the composer clock");
  mascot.setPhase("idle", 6000);
  assert.ok((mascot.nextTransitionDelay(6000) ?? 0) > 0);
  assert.equal(mascot.nextTransitionDelay(6000 + SLEEPY_AFTER_MS), undefined, "sleepy idle mascot stops scheduling work");
});

test("active composer animation is deliberately low frequency", () => {
  assert.equal(COMPOSER_ACTIVE_INTERVAL_MS, 600);
});

const moods: MascotMood[] = ["idle", "blink", "happy", "thinking", "tool", "waiting", "sleepy", "error", "complete", "poke"];

test("full Ember is a shaded pixel raster with distinct expressions and bounded half-block output", () => {
  assert.equal(new Set(moods.map(mood => mascotPixels(mood).join("\n"))).size, moods.length);
  for (const mood of moods) for (const frame of [0, 1, 2, -1]) {
    const pixels = mascotPixels(mood, frame);
    assert.equal(pixels.length, MASCOT_SPRITE_HEIGHT);
    assert.ok(pixels.every(row => row.length === MASCOT_SPRITE_WIDTH));
    assert.ok([...pixels.join("")].every(pixel => pixel === "." || pixel in EMBER_PALETTE));
    for (const truecolor of [true, false]) {
      const sprite = mascotSprite(mood, frame, truecolor);
      assert.equal(sprite.length, 5);
      assert.ok(sprite.every(row => visibleWidth(row) === 11));
      assert.match(sprite.join(""), truecolor ? /\x1b\[48;2;/ : /\x1b\[48;5;/, "pixel pairs must have a painted lower half, not gaps");
      assert.ok(sprite.every(row => /^[ ▀▄]*$/.test(stripTerminalSequences(row))), "the full pet is pixel cells, not an ASCII face");
    }
  }
  assert.deepEqual(mascotPixels("idle", 0), mascotPixels("idle", 1), "idle stays calm between blink deadlines");
  assert.notDeepEqual(mascotPixels("tool", 0), mascotPixels("tool", 1), "active flame tip sways without moving its face");
});

test("tiny eyes and expressive poses stay inside the existing six-row perch", () => {
  const idle = mascotPixels("idle");
  assert.equal(idle[5]![3], "k");
  assert.equal(idle[5]![7], "k");
  assert.equal(idle.join("").split("k").length - 1, 5, "idle has two 1×2 bean eyes and one mouth pixel");
  for (const mood of moods) for (const frame of [0, 1, 2, 3, -1]) {
    const perch = mascotPerch(mood, frame, undefined, false);
    assert.equal(perch.length, 6, "bounce must not move the editor or its mouse origin");
    assert.ok(perch.every(row => visibleWidth(row) === 11));
  }
  for (const mood of ["happy", "complete", "poke"] as const) {
    assert.notDeepEqual(mascotPixels(mood, 0), mascotPixels(mood, 1), "anticipation squashes the tip");
    assert.deepEqual(mascotPerch(mood, 2, undefined, false).slice(0, 5), mascotSprite(mood, 2, false), "the hop occupies the spare spark row");
    assert.equal(mascotPerch(mood, 2).at(-1)?.trim(), "");
  }
  assert.notDeepEqual(mascotPixels("error", 0), mascotPixels("error", 1), "the pout has a grounded huff");
  assert.notDeepEqual(mascotPixels("thinking", 0), mascotPixels("thinking", 2), "thinking glances sideways");
});

test("mood sparks stay above the small pet without changing its width", () => {
  assert.match(mascotSpark("sleepy"), /zzz/);
  assert.match(mascotSpark("complete"), /✦/);
  assert.match(mascotSpark("waiting"), /\?/);
  assert.equal(mascotSpark("idle").trim(), "");
  for (const mood of moods) for (const frame of [0, 1, -1]) {
    assert.equal(visibleWidth(mascotSpark(mood, frame)), MASCOT_SPRITE_WIDTH);
  }
});

test("pixel Ember keeps both sprite rows at five columns for every mood and frame", () => {
  assert.equal(new Set(moods.map(mascotFace)).size, moods.length, "every expression is distinct");
  for (const mood of moods) {
    const face = mascotFace(mood);
    assert.equal(visibleWidth(face), MASCOT_FACE_WIDTH);
    assert.match(face, /^▐.{3}▌$/);
    for (const frame of [-3, -1, 0, 1, 2, 3, 4, 5]) {
      const crown = mascotTip(mood, frame);
      assert.equal(visibleWidth(crown), MASCOT_TIP_WIDTH, `${mood} frame ${frame}`);
      assert.match(crown, /[█▄▀]/);
      for (const truecolor of [true, false]) {
        const paint = (_color: string, text: string) => `\x1b[33m${text}\x1b[39m`;
        const paintedFace = paintFace(face, mood, paint, truecolor);
        const paintedCrown = paintTip(crown, mood, paint, truecolor);
        assert.equal(stripTerminalSequences(paintedFace), face);
        assert.equal(stripTerminalSequences(paintedCrown), crown);
        assert.equal(visibleWidth(paintedFace), MASCOT_FACE_WIDTH);
        assert.equal(visibleWidth(paintedCrown), MASCOT_TIP_WIDTH);
      }
    }
  }
});

test("theme fallback retains pixel silhouettes and distinguishes errors and sleepy crowns", () => {
  const calls: string[] = [];
  const paint = (color: string, text: string) => { calls.push(color); return text; };
  assert.equal(paintFace(mascotFace("error"), "error", paint, false), "▐×_×▌");
  assert.equal(paintTip(mascotTip("sleepy"), "sleepy", paint, false), " ▄zzz");
  assert.deepEqual(calls, ["error", "dim"]);
  assert.equal(mascotTip("idle", 0), " ▄█▄ ");
});
