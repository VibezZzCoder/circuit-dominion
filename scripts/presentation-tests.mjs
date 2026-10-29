// SPDX-License-Identifier: GPL-3.0-or-later
// Additional terms under GPL-3.0 section 7 apply; see NOTICE.md.
// Board presentation timeline and combat FX clock contracts (no DOM needed).
import assert from "node:assert/strict";
import {
  advancePresentation,
  createPresentation,
  deployUnits,
  isBoardBusy,
  moveDurationMs,
  noteUnitMove,
  pushBoardEffect,
  showBoardBanner,
  tweenEndsAt,
  unitTweenPosition,
} from "../src/presentation.js";
import { ArenaRenderer } from "../src/combat-render.js";
import { pushCombatEvent } from "../src/combat.js";

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`ok ${passed} - ${name}`);
}

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b}`);

test("move tween interpolates from origin to the committed square and ends at rest", () => {
  const p = createPresentation();
  const unit = { id: "u1", row: 4, col: 0 };
  const tween = noteUnitMove(p, unit, { row: 8, col: 0 }, { row: 4, col: 0 }, "move", "S");
  assert.equal(tween.duration, moveDurationMs({ row: 8, col: 0 }, { row: 4, col: 0 }));
  assert.ok(isBoardBusy(p), "an active glide keeps the AI waiting");
  const start = unitTweenPosition(p, unit, p.clockMs);
  near(start.row, 8);
  const mid = unitTweenPosition(p, unit, p.clockMs + tween.duration / 2);
  assert.ok(mid.row < 8 && mid.row > 4 && mid.hop > 0, "mid-glide is between squares and lifted");
  const end = unitTweenPosition(p, unit, tweenEndsAt(tween) + 1);
  assert.deepEqual([end.row, end.col, end.moving], [4, 0, false]);
  advancePresentation(p, (tween.duration + 1) / 1000);
  assert.equal(isBoardBusy(p), false);
  assert.deepEqual(p.lastMove.from, { row: 8, col: 0 });
});

test("a stale tween never overrides a unit whose logical square changed again", () => {
  const p = createPresentation();
  const unit = { id: "u2", row: 2, col: 2 };
  noteUnitMove(p, unit, { row: 0, col: 2 }, { row: 2, col: 2 });
  unit.row = 3;
  const position = unitTweenPosition(p, unit, p.clockMs + 10);
  assert.deepEqual([position.row, position.col], [3, 2]);
});

test("approach holds short of the target until the duel opens and is not a busy glide", () => {
  const p = createPresentation();
  const unit = { id: "u3", row: 8, col: 1 };
  const tween = noteUnitMove(p, unit, { row: 8, col: 1 }, { row: 5, col: 1 }, "approach", "S");
  const held = unitTweenPosition(p, unit, tweenEndsAt(tween) + 500);
  assert.ok(held.row > 5 && held.row < 8, "attacker stops between the squares");
  assert.equal(isBoardBusy(p), false, "approach alone does not gate; pendingDuel does");
  p.pendingDuel = { at: tweenEndsAt(tween) + 400 };
  assert.ok(isBoardBusy(p));
});

test("deployment march slides units in from their edge and fades them in", () => {
  const p = createPresentation();
  const solar = { id: "s", row: 8, col: 3 };
  const voidUnit = { id: "v", row: 0, col: 3 };
  deployUnits(p, [solar, voidUnit], (unit) => (unit.id === "s" ? "S" : "V"));
  const early = unitTweenPosition(p, solar, p.clockMs);
  assert.ok(early.row > 8 && early.alpha === 0, "Solar starts below the board, invisible");
  assert.ok(unitTweenPosition(p, voidUnit, p.clockMs).row < 0, "Void starts above the board");
  assert.ok(isBoardBusy(p));
  advancePresentation(p, 3);
  const done = unitTweenPosition(p, solar, p.clockMs);
  assert.deepEqual([done.row, done.alpha], [8, 1]);
});

test("instant mode (QA) records no tweens, effects, or banners", () => {
  const p = createPresentation();
  p.instant = true;
  const unit = { id: "u4", row: 1, col: 1 };
  assert.equal(noteUnitMove(p, unit, { row: 0, col: 1 }, { row: 1, col: 1 }), null);
  pushBoardEffect(p, "land", { row: 1, col: 1 });
  showBoardBanner(p, "ROUND 2");
  deployUnits(p, [unit], () => "S");
  assert.equal(p.tweens.size, 0);
  assert.equal(p.effects.length, 0);
  assert.equal(p.banner, null);
  p.pendingDuel = {};
  assert.equal(isBoardBusy(p), false);
});

test("effects can be scheduled for when a glide lands and expire from history", () => {
  const p = createPresentation();
  pushBoardEffect(p, "land", { row: 2, col: 3, delay: 300 });
  assert.equal(p.effects[0].t, 300);
  assert.equal(p.effects[0].delay, undefined, "delay is folded into the timestamp");
  advancePresentation(p, 5);
  assert.equal(p.effects.length, 0);
});

test("presentation clock only advances by the loop delta", () => {
  const p = createPresentation();
  advancePresentation(p, 1 / 60);
  advancePresentation(p, -5);
  near(p.clockMs, 1000 / 60);
});

test("arena particles and shake follow combat.nowMs: pause freezes, stale events skip FX", () => {
  const arena = new ArenaRenderer(null);
  const fighter = (slot) => ({ unit: { type: slot ? "EC" : "AS" }, slot, x: slot ? 700 : 200, y: 260, facingX: slot ? -1 : 1, facingY: 0,
    radius: 20, hp: 50, maxHp: 50, speed: 180, controller: "ai" });
  const combat = { nowMs: 1000, state: "combatActive", events: [], eventSeq: 0, fighters: [fighter(0), fighter(1)], projectiles: [] };
  arena.sync(combat);
  pushCombatEvent(combat, "hit", { slot: 1, x: 700, y: 260, amount: 20, sourceFaction: "S", quiet: false });
  arena.sync(combat);
  const count = arena.particles.items.length;
  assert.ok(count > 0, "a hit spawns sparks");
  const ages = arena.particles.items.map((item) => item.age);
  arena.sync(combat);
  assert.deepEqual(arena.particles.items.map((item) => item.age), ages, "no simulation time, no particle aging");
  combat.nowMs += 16;
  arena.sync(combat);
  assert.ok(arena.particles.items.every((item, index) => item.age > ages[index] || index >= ages.length));
  combat.nowMs += 5000;
  pushCombatEvent(combat, "ko", { slot: 1, x: 700, y: 260, faction: "V" });
  combat.events[combat.events.length - 1].t = combat.nowMs - 2000;
  arena.sync(combat);
  assert.equal(arena.particles.items.length, 0, "an undrawn gap clears FX and stale events add none");
  assert.notEqual(arena.fighterVisuals[1].koAt, null, "stale KO still restores lasting state");
});

console.log(`presentation-tests: ${passed}/${passed} passed (tweens, approach, deploy, instant QA, effect delays, FX clock)`);
