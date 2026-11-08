import assert from "node:assert/strict";
import test from "node:test";
import { COMPOSER_ACTIVE_INTERVAL_MS } from "../src/composer.ts";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { accentPalette, EMBER_PALETTE, Mascot, MASCOT_FRAME_MS, mascotPose, mascotPoseDelay, rgbTo256, MASCOT_FACE_WIDTH, MASCOT_TIP_WIDTH, MASCOT_SPRITE_WIDTH, MASCOT_SPRITE_HEIGHT, SLEEPY_AFTER_MS, mascotFace, mascotPixels, mascotSprite, mascotPerch, mascotTip, mascotSpark, paintFace, paintTip, type MascotMood } from "../src/mascot.ts";

test("idle mascot schedules exact state transitions instead of polling", () => {
  const mascot = new Mascot(0, () => 0);
  assert.equal(mascot.nextTransitionDelay(0), 3000);
  assert.equal(mascot.mood(3000), "blink");
  assert.equal(mascot.nextTransitionDelay(3000), 180);
  assert.equal(mascot.mood(3180), "idle");
  assert.equal(mascot.nextTransitionDelay(3180), 3000);
  mascot.flash("poke", 500, 4000);
  const first = mascot.nextTransitionDelay(4000)!;
  assert.ok(first >= 16 && first <= 240, "an idle reaction schedules its next pose, not just its expiry");
  assert.equal(mascot.nextTransitionDelay(4400), 100, "the last pose is bounded by flash expiry");
  assert.ok((mascot.nextTransitionDelay(4500) ?? 0) > 600, "expired reactions return to sparse idle deadlines");
  mascot.setPhase("generating", 5000);
  assert.equal(mascot.nextTransitionDelay(5000), undefined, "active phases are driven by the activity clock");
  mascot.setPhase("idle", 6000);
  assert.ok((mascot.nextTransitionDelay(6000) ?? 0) > 0);
  assert.equal(mascot.nextTransitionDelay(6000 + SLEEPY_AFTER_MS), undefined, "sleepy idle mascot stops scheduling work");
});
test("hops use uneven anticipation, airborne and landing holds instead of a uniform metronome", () => {
  const changes: Array<[number, number]> = [];
  let previous = -1;
  for (let now = 0; now < 1500; now += 10) {
    const pose = mascotPose("happy", now);
    if (pose !== previous) { changes.push([now, pose]); previous = pose; }
  }
  assert.deepEqual(changes.map(([, pose]) => pose), [0, 1, 2, 1, 0]);
  const holds = changes.slice(1).map(([at], index) => at - changes[index]![0]);
  assert.ok(new Set(holds).size > 2, `holds vary: ${holds.join(",")}`);
  assert.ok(Math.min(...holds) >= MASCOT_FRAME_MS, "no pose is shorter than the frame floor");
  for (const now of [0, 650, 900, 5000]) assert.ok(mascotPoseDelay("thinking", now) > 0);
});
test("accent palette recolors Ember while keeping silhouette, contrast order and warm expressions", () => {
  const teal = accentPalette([69, 221, 209]);
  const luminance = (rgb: readonly number[]) => rgb[0]! * 0.2126 + rgb[1]! * 0.7152 + rgb[2]! * 0.0722;
  assert.deepEqual(teal.b, [69, 221, 209]);
  assert.ok(luminance(teal.o!) < luminance(teal.s!) && luminance(teal.s!) < luminance(teal.b!)
    && luminance(teal.b!) < luminance(teal.f!) && luminance(teal.f!) < luminance(teal.h!));
  assert.ok(teal.c![0]! > teal.c![2]!, "blush stays warm on cool accents");
  const plain = (rows: string[]) => rows.map(stripTerminalSequences);
  for (const truecolor of [true, false]) {
    const accented = mascotSprite("happy", 0, truecolor, teal);
    assert.deepEqual(plain(accented), plain(mascotSprite("happy", 0, truecolor)), "same silhouette");
    assert.notDeepEqual(accented, mascotSprite("happy", 0, truecolor), "different colors");
  }
  assert.match(mascotSprite("idle", 0, true, teal).join(""), /38;2;69;221;209/);
  assert.match(paintFace(mascotFace("idle"), "idle", undefined, true, teal), /38;2;69;221;209/);
  assert.equal(rgbTo256([0, 0, 0]), 16);
  assert.equal(rgbTo256([255, 255, 255]), 231);
});
test("mascot poses never redraw faster than the frame floor", () => {
  assert.equal(COMPOSER_ACTIVE_INTERVAL_MS, MASCOT_FRAME_MS);
  assert.ok(MASCOT_FRAME_MS >= 100);
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
