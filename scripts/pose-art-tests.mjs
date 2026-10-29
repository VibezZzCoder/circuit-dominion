// SPDX-License-Identifier: GPL-3.0-or-later
// Additional terms under GPL-3.0 section 7 apply; see NOTICE.md.
// Attack-pose and top-down floor art contracts: manifest/WebP metadata, the
// timed idle→attack sprite swap, facing correction, and fallbacks (no DOM).
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { ART_FACING, ATTACK_POSE_MS, ArenaRenderer } from "../src/combat-render.js";
import { pushCombatEvent } from "../src/combat.js";

let passed = 0;
async function test(name, fn) {
  await fn();
  passed += 1;
  console.log(`ok ${passed} - ${name}`);
}

const manifest = JSON.parse(await readFile(new URL("../assets/live/manifest.json", import.meta.url)));
const units = manifest.assets.filter((asset) => asset.type === "unit-sprite");
const poses = manifest.assets.filter((asset) => asset.type === "unit-pose");

await test("every unit has one attack pose WebP that shares its idle canvas, baseline and facing", async () => {
  assert.equal(units.length, 12);
  assert.equal(poses.length, units.length);
  for (const unit of units) {
    const pose = poses.find((asset) => asset.id === `unit.${unit.unitId}.attack`);
    assert.ok(pose, `missing attack pose for ${unit.unitId}`);
    assert.deepEqual([pose.unitId, pose.faction, pose.pose], [unit.unitId, unit.faction, "attack"]);
    assert.deepEqual(pose.anchor, unit.anchor, "pose feet baseline must match the idle sprite");
    assert.equal(pose.facing, ART_FACING[unit.unitId] || 1, `${unit.unitId} pose must strike the way its idle art faces`);
    // Extended WebP header: VP8X chunk, alpha flag, 24-bit (size - 1) dimensions.
    const webp = await readFile(new URL(`../${pose.path}`, import.meta.url));
    assert.deepEqual([webp.toString("ascii", 0, 4), webp.toString("ascii", 8, 16)], ["RIFF", "WEBPVP8X"]);
    assert.ok(webp[20] & 0x10, "pose must keep its alpha channel");
    assert.deepEqual([webp.readUIntLE(24, 3) + 1, webp.readUIntLE(27, 3) + 1], [512, 512]);
  }
});

await test("arena floor is a 1920x1040 WebP (2x the 960x520 duel area)", async () => {
  const floor = manifest.assets.find((asset) => asset.id === "background.combat-arena");
  assert.deepEqual([floor.nativeWidth, floor.nativeHeight], [1920, 1040]);
  const bytes = await readFile(new URL(`../${floor.path}`, import.meta.url));
  assert.deepEqual([bytes.toString("ascii", 0, 4), bytes.toString("ascii", 8, 12)], ["RIFF", "WEBP"]);
});

// Canvas stand-in: records calls; gradients and text metrics return stubs.
function recordingContext() {
  const calls = [];
  const stub = { addColorStop() {}, width: 10 };
  const ctx = new Proxy({}, {
    get: (target, name) => (name in target ? target[name] : (...args) => { calls.push([name, ...args]); return stub; }),
    set: (target, name, value) => { target[name] = value; return true; },
  });
  return { ctx, calls };
}

const idle = { id: "idle" };
const attack = { id: "attack" };
function fakeAssets({ pose = attack, facing } = {}) {
  return {
    getUnitImage: () => idle,
    getUnitPoseImage: () => pose,
    getAsset: (id) => (id.endsWith(".attack") ? { anchor: { y: 0.92 }, facing } : { anchor: { y: 0.92 } }),
    getImage: () => null,
  };
}
function duel() {
  const fighter = (slot, type) => ({ unit: { type }, slot, x: slot ? 700 : 200, y: 260, facingX: slot ? -1 : 1, facingY: 0,
    radius: 24, hp: 50, maxHp: 50, speed: 180, controller: "ai", state: "idle", invisUntil: 0, hurtUntil: 0, shieldUntil: 0 });
  return { nowMs: 5000, state: "combatActive", events: [], eventSeq: 0, fighters: [fighter(0, "CC"), fighter(1, "GB")], projectiles: [], countdown: 0 };
}
function drawn(arena, combat, slot = 0) {
  const { ctx, calls } = recordingContext();
  arena.drawFighter(ctx, combat, combat.fighters[slot], combat.nowMs, null, { pixelScale: 1 });
  const image = calls.find((call) => call[0] === "drawImage")?.[1];
  const scale = calls.find((call) => call[0] === "scale");
  return { image, flipX: Math.sign(scale[1]) };
}

await test("swing, shot and special swap in the attack pose for ATTACK_POSE_MS of duel time, per slot", () => {
  for (const type of ["swing", "shot", "special"]) {
    const arena = new ArenaRenderer(fakeAssets());
    const combat = duel();
    arena.sync(combat);
    assert.equal(drawn(arena, combat).image, idle);
    pushCombatEvent(combat, type, { slot: 0, x: 200, y: 260, angle: 0, faction: "S", kind: "basic" });
    arena.sync(combat);
    assert.equal(drawn(arena, combat).image, attack, `${type} shows the pose`);
    assert.equal(drawn(arena, combat, 1).image, idle, "the other fighter keeps its idle sprite");
    combat.nowMs += ATTACK_POSE_MS - 10;
    arena.sync(combat);
    assert.equal(drawn(arena, combat).image, attack, "pose holds while duel time is short of the window");
    combat.nowMs += 20;
    arena.sync(combat);
    assert.equal(drawn(arena, combat).image, idle, "pose ends after the window");
  }
});

await test("pause freezes the pose; KO and missing art fall back to the idle sprite", () => {
  const arena = new ArenaRenderer(fakeAssets());
  const combat = duel();
  arena.sync(combat);
  pushCombatEvent(combat, "shot", { slot: 0, x: 200, y: 260, angle: 0, faction: "S" });
  arena.sync(combat);
  for (let i = 0; i < 5; i += 1) arena.sync(combat); // paused frames: nowMs does not move
  assert.equal(drawn(arena, combat).image, attack);
  combat.fighters[0].hp = 0;
  assert.equal(drawn(arena, combat).image, idle, "a KO'd fighter never strikes a pose");

  const noPose = new ArenaRenderer(fakeAssets({ pose: null }));
  const other = duel();
  noPose.sync(other);
  pushCombatEvent(other, "swing", { slot: 0, x: 200, y: 260, angle: 0, faction: "S" });
  noPose.sync(other);
  assert.equal(drawn(noPose, other).image, idle, "unloaded or absent pose keeps the idle sprite");
});

await test("a pose that strikes opposite to its idle art is mirrored; matching poses are not", () => {
  for (const [facing, expected] of [[1, 1], [undefined, 1], [-1, -1]]) {
    const arena = new ArenaRenderer(fakeAssets({ facing }));
    const combat = duel();
    arena.sync(combat);
    const before = drawn(arena, combat).flipX;
    pushCombatEvent(combat, "swing", { slot: 0, x: 200, y: 260, angle: 0, faction: "S" });
    arena.sync(combat);
    assert.equal(drawn(arena, combat).flipX, before * expected, `facing ${facing}`);
  }
});

console.log(`pose-art-tests: ${passed}/${passed} passed (manifest/WebP, floor, timed swap, pause/KO/fallback, facing)`);
