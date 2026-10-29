// SPDX-License-Identifier: GPL-3.0-or-later
// Additional terms under GPL-3.0 section 7 apply; see NOTICE.md.
import assert from "node:assert/strict";
import { createBoardGrid, createUnit } from "../src/board.js";
import { startCombat, updateCombat } from "../src/combat.js";
import { InputManager } from "../src/input.js";
import { createInitialState, FighterState } from "../src/state.js";
import { UNIT_DEFS } from "../src/units.js";
import { DIFFICULTY_SETTINGS } from "../src/utils.js";
import { stepAiDuel } from "./matchup-simulations.mjs";

const audio = { beep() {} };
function fixture({ reverse = false } = {}) {
  global.window = new EventTarget();
  global.document = new EventTarget();
  document.getElementById = () => ({ checked: false });
  let clock = 1000;
  const game = createInitialState("pvp");
  game.board = createBoardGrid();
  const solar = createUnit("AS", 8, 0);
  const voidUnit = createUnit("EC", 0, 0);
  startCombat(game, reverse ? voidUnit : solar, reverse ? solar : voidUnit, 4, 4);
  game.combat.state = "combatActive";
  game.combat.countdown = 0;
  game.combat.obstacles = [];
  const input = new InputManager({ getTopState: () => game.combat.paused ? "paused" : game.combat.state, clock: () => clock, getGamepads: () => [] });
  const p1 = game.combat.fighters.find((fighter) => fighter.controller === "p1");
  const p2 = game.combat.fighters.find((fighter) => fighter.controller === "p2");
  const key = (code, up = false) => {
    const event = { code, preventDefault() {} };
    if (up) input.onKeyUp(event); else input.onKeyDown(event);
  };
  const step = (dt = 1 / 60, overrides = {}) => {
    clock += dt * 1000;
    const actions = { ...input.update(), ...overrides };
    const now = game.combat.nowMs + (game.combat.paused ? 0 : dt * 1000);
    updateCombat(game, actions, dt, now, audio);
    const accepted = game.combat.acceptedActions.map((action) => ({ ...action }));
    for (const action of accepted) input.consumeCombatAction(action.role, action.kind);
    return accepted;
  };
  return { game, input, p1, p2, step, key };
}

let tests = 0;
function test(name, fn) { fn(); tests += 1; console.log(`ok ${tests} - ${name}`); }
function near(actual, expected) { assert.ok(Math.abs(actual - expected) < 1e-6, `${actual} should equal ${expected}`); }

test("assisted fire tracks the enemy while the player retreats", () => {
  for (const reverse of [false, true]) {
    const { p1, p2, step } = fixture({ reverse });
    const enemyDirection = Math.sign(p2.x - p1.x);
    const accepted = step(1 / 60, { p1MoveX: -enemyDirection, p1Attack: true });
    assert.deepEqual(accepted, [{ role: "p1", kind: "attack" }]);
    near(p1.pendingAction.facingX, enemyDirection);
    near(p1.pendingAction.facingY, 0);
    assert.equal(p1.aimMode, "assist");
    assert.ok(p1.vx * enemyDirection < 0, "Retreat movement remains independent of attack facing");
  }
});

test("manual directional and world-point aims override assist", () => {
  let state = fixture();
  state.step(1 / 60, { p1MoveX: -1, p1Attack: true, p1ManualAim: true, p1AimX: 0, p1AimY: -1 });
  near(state.p1.pendingAction.facingX, 0); near(state.p1.pendingAction.facingY, -1);
  assert.equal(state.p1.aimMode, "manual");
  state = fixture();
  const point = { x: state.p1.x - 50, y: state.p1.y + 50 };
  state.step(1 / 60, { p1Attack: true, p1AimPoint: point });
  near(state.p1.pendingAction.facingX, -Math.SQRT1_2); near(state.p1.pendingAction.facingY, Math.SQRT1_2);
});

test("an unavailable special cannot starve legal basic fire", () => {
  const { p1, step } = fixture();
  p1.specialCooldown = 2;
  assert.deepEqual(step(1 / 60, { p1Attack: true, p1Special: true }), [{ role: "p1", kind: "attack" }]);
  assert.equal(p1.pendingAction.kind, "attack");
  near(p1.attackCooldown, UNIT_DEFS.AS.attack.cooldown);
  assert.ok(p1.specialCooldown > 1.9);
});

test("a legal special has priority and reports exactly one accepted action", () => {
  const { p1, step } = fixture();
  p1.specialCooldown = 0;
  assert.deepEqual(step(1 / 60, { p1Attack: true, p1Special: true }), [{ role: "p1", kind: "special" }]);
  assert.equal(p1.pendingAction.kind, "special");
  near(p1.specialCooldown, UNIT_DEFS.AS.special.cooldown);
  assert.equal(p1.attackCooldown, 0);
  assert.deepEqual(step(1 / 60, { p1Attack: true, p1Special: true }), [], "Busy animation must not falsely acknowledge either action");
});

test("held basic fire repeats only when its cooldown and action lock permit", () => {
  const { p1, key, step } = fixture();
  key("Space");
  let accepted = 0;
  for (let frame = 0; frame < 100; frame += 1) accepted += step().filter((action) => action.kind === "attack").length;
  assert.ok(accepted >= 2, "Held fire should keep firing without a fresh press");
  assert.equal(accepted, p1.attackCount);
  assert.ok(accepted <= 3, "No frame may bypass the unit's normal reload");
  key("Space", true);
  const count = p1.attackCount;
  for (let frame = 0; frame < 60; frame += 1) step();
  assert.equal(p1.attackCount, count);
});

test("a quick tap near reload completion is retained until combat accepts it", () => {
  const { input, p1, key, step } = fixture();
  p1.attackCooldown = 0.1;
  key("Space"); key("Space", true);
  assert.deepEqual(step(0.03), []);
  assert.equal(input.update().p1Attack, true, "An illegal attempt must retain the fresh tap");
  assert.deepEqual(step(0.03), []); assert.deepEqual(step(0.03), []);
  assert.deepEqual(step(0.03), [{ role: "p1", kind: "attack" }]);
  assert.equal(input.update().p1Attack, false, "Accepted action acknowledges the tap exactly once");
});

test("an old tap cannot fire long after its buffer expires", () => {
  const { p1, key, step } = fixture();
  p1.attackCooldown = 0.35;
  key("Space"); key("Space", true);
  for (let frame = 0; frame < 30; frame += 1) assert.deepEqual(step(), []);
  assert.equal(p1.attackCount, 0);
  assert.equal(p1.attackCooldown, 0);
});

test("special taps are buffered but never repeat while the key remains held", () => {
  const { p1, key, step } = fixture();
  p1.specialCooldown = 0.1;
  key("ShiftLeft");
  assert.deepEqual(step(0.05), []);
  assert.deepEqual(step(0.06), [{ role: "p1", kind: "special" }]);
  for (let frame = 0; frame < 30; frame += 1) step();
  p1.specialCooldown = 0;
  for (let frame = 0; frame < 30; frame += 1) assert.deepEqual(step(), []);
  assert.equal(p1.specialCount, 1);
});

test("pause and countdown do not accept actions or leave stale acceptance records", () => {
  let state = fixture();
  state.step(1 / 60, { p1Attack: true });
  const { nowMs } = state.game.combat;
  state.game.combat.paused = true;
  assert.deepEqual(state.step(0.1, { p1Attack: true, p1Special: true }), []);
  assert.equal(state.game.combat.nowMs, nowMs);
  state = fixture();
  state.game.combat.state = "combatCountdown"; state.game.combat.countdown = 0.01;
  state.key("Space"); state.key("Space", true);
  assert.deepEqual(state.step(), [], "Final countdown frame itself is not an active combat step");
  assert.equal(state.game.combat.state, "combatActive");
  assert.deepEqual(state.step(), [{ role: "p1", kind: "attack" }], "Fresh buffered tap crosses the countdown boundary");
});

test("stun and unexpired cooldown cannot falsely acknowledge a buffered action", () => {
  const { p1, step } = fixture();
  p1.state = FighterState.STUNNED; p1.stateUntil = 1000;
  assert.deepEqual(step(0.03, { p1Attack: true, p1Special: true }), []);
  p1.state = FighterState.IDLE; p1.stateUntil = 0;
  p1.attackCooldown = 0.2; p1.specialCooldown = 0.2;
  assert.deepEqual(step(0.03, { p1Attack: true, p1Special: true }), []);
  assert.equal(p1.attackCount, 0); assert.equal(p1.specialCount, 0);
});

test("AI balance harness excludes human assistance and preserves separate difficulties", () => {
  for (const reverse of [false, true]) {
    const { game, p1: solar, p2: voidFighter } = fixture({ reverse });
    solar.x = 200; solar.y = 260;
    voidFighter.x = 350; voidFighter.y = 260;
    stepAiDuel(game, { solarDifficulty: "easy", voidDifficulty: "hard", nowMs: 0, rng: () => 0.75 });
    assert.equal(solar.controller, "ai"); assert.equal(voidFighter.controller, "ai");
    assert.equal(solar.aimMode, "move", "Solar must not enter human assisted aiming");
    assert.equal(voidFighter.aimMode, "move", "Void must use the same AI aiming semantics");
    assert.equal(solar.aiNextDecisionAt, DIFFICULTY_SETTINGS.easy.reactionMs);
    assert.equal(voidFighter.aiNextDecisionAt, DIFFICULTY_SETTINGS.hard.reactionMs);
    assert.ok(solar.pendingAction?.kind === "attack");
    assert.ok(Math.abs(solar.pendingAction.facingY) > 0.01, "The AI's nonzero aim error must not be replaced with perfect human assist");
    const length = Math.hypot(solar.aiIntent.moveX, solar.aiIntent.moveY);
    near(solar.pendingAction.facingX, solar.aiIntent.moveX / length);
    near(solar.pendingAction.facingY, solar.aiIntent.moveY / length);
    assert.ok(game.combat.acceptedActions.every((action) => action.role === "ai"));
  }
});

console.log(`combat-control-tests: ${tests}/${tests} passed (aim, repeat, buffering, acceptance, lifecycle)`);
