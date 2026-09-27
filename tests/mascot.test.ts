import assert from "node:assert/strict";
import test from "node:test";
import { COMPOSER_ACTIVE_INTERVAL_MS } from "../src/composer.ts";
import { Mascot, SLEEPY_AFTER_MS } from "../src/mascot.ts";

test("idle mascot schedules exact state transitions instead of polling", () => {
  const mascot = new Mascot(0, () => 0);
  assert.equal(mascot.nextTransitionDelay(0), 3000);
  assert.equal(mascot.mood(3000), "blink");
  assert.equal(mascot.nextTransitionDelay(3000), 180);
  assert.equal(mascot.mood(3180), "idle");
  assert.equal(mascot.nextTransitionDelay(3180), 3000);

  mascot.flash("poke", 500, 4000);
  assert.equal(mascot.nextTransitionDelay(4000), 500);

  mascot.setPhase("generating", 5000);
  assert.equal(mascot.nextTransitionDelay(5000), undefined, "active phases are driven by the composer clock");
  mascot.setPhase("idle", 6000);
  assert.ok((mascot.nextTransitionDelay(6000) ?? 0) > 0);
  assert.equal(mascot.nextTransitionDelay(6000 + SLEEPY_AFTER_MS), undefined, "sleepy idle mascot stops scheduling work");
});

test("active composer animation is deliberately low frequency", () => {
  assert.equal(COMPOSER_ACTIVE_INTERVAL_MS, 600);
});
