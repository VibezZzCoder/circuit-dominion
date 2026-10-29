// SPDX-License-Identifier: GPL-3.0-or-later
// Additional terms under GPL-3.0 section 7 apply; see NOTICE.md.
import assert from "node:assert/strict";
import { InputManager } from "../src/input.js";
import { AudioManager } from "../src/audio.js";
import { Renderer } from "../src/render.js";

global.window = new EventTarget();
global.document = new EventTarget();
const input = new InputManager({ getTopState: () => "combatActive" });
const stick = new EventTarget();
const captured = new Set();
stick.getBoundingClientRect = () => ({ left: 0, top: 0, width: 100, height: 100 });
stick.setPointerCapture = (id) => captured.add(id);
stick.hasPointerCapture = (id) => captured.has(id);
stick.releasePointerCapture = (id) => captured.delete(id);
input.bindStick(stick, "p1");
function pointer(type, id, x = 88, y = 50) {
  const event = new Event(type, { cancelable: true });
  Object.assign(event, { pointerId: id, clientX: x, clientY: y });
  stick.dispatchEvent(event);
}
pointer("pointerdown", 1);
assert.equal(input.update().p1MoveX, 0, "Floating joystick starts neutral at the actual contact point");
pointer("pointermove", 1, 118);
assert.equal(input.update().p1MoveX, 1);
pointer("pointerdown", 2, 12);
assert.equal(input.update().p1MoveX, 1, "A second finger must not steal an active stick");
pointer("pointerup", 2);
assert.equal(input.update().p1MoveX, 1, "Unrelated pointer release must not stop movement");
input.resetAll();
pointer("pointermove", 1);
assert.equal(input.update().p1MoveX, 0, "Paused/reset stick must not reactivate from the old finger");
assert.equal(captured.size, 0);
pointer("pointerdown", 3, 12);
pointer("pointermove", 3, -18);
assert.equal(input.update().p1MoveX, -1, "A new gesture works after reset");
pointer("pointercancel", 3);
assert.equal(input.update().p1MoveX, 0);

let created = 0;
let resumeCalls = 0;
let rejectResume = true;
window.AudioContext = class {
  constructor() { created += 1; this.state = "suspended"; }
  resume() {
    resumeCalls += 1;
    if (rejectResume) return Promise.reject(new Error("gesture rejected"));
    this.state = "running";
    return Promise.resolve();
  }
};
const audio = new AudioManager(() => false);
audio.beep("move");
assert.equal(created, 0, "Programmatic gameplay must not create audio before unlock");
audio.unlock();
await Promise.resolve();
assert.equal(resumeCalls, 1);
rejectResume = false;
audio.unlock();
assert.equal(audio.ctx.state, "running", "A later gesture retries a rejected resume");
audio.ctx.state = "interrupted";
audio.unlock();
assert.equal(resumeCalls, 3, "A later gesture resumes an interrupted Safari context");
audio.unlock();
assert.equal(resumeCalls, 3, "Running audio needs no repeated resume");
audio.ctx.state = "closed";
audio.unlock();
assert.equal(created, 2, "A closed context is recreated on a later gesture");
const arcs = [];
const context = new Proxy({}, {
  get(target, key) {
    if (key === "arc") return (...args) => arcs.push(args);
    if (key === "createLinearGradient" || key === "createRadialGradient") return () => ({ addColorStop() {} });
    if (key === "measureText") return () => ({ width: 20 });
    return key in target ? target[key] : () => {};
  },
  set(target, key, value) { target[key] = value; return true; },
});
const canvas = {getContext: () => context, clientWidth: 960, clientHeight: 520};
const renderer = new Renderer(canvas, canvas);
// No sprite assets: the procedural fallback body draws timed visuals with arcs
// whose radii identify them (hurt flash r+4, shield bubble r*1.75).
const fighter = {unit:{type:"AS"}, slot:0, radius:20, hp:50, maxHp:50, speed:180, x:100, y:100,
  facingX:1, facingY:0, hurtUntil:200, shieldUntil:200, state:"idle", controller:"ai"};
const combat = {nowMs:100, state:"combatActive", obstacles:[], barriers:[], projectiles:[], beams:[],
  effects:[], events:[], fighters:[fighter, {...fighter, slot:1, x:600, hurtUntil:0, shieldUntil:0}]};
renderer.drawCombat({combat,debug:{showRanges:false}});
assert.ok(arcs.some((arc) => arc[2] === 24), "Hit flash uses the paused combat clock");
assert.ok(arcs.some((arc) => Math.abs(arc[2] - 35) < 1e-9), "Shield uses the paused combat clock");
arcs.length = 0;
combat.nowMs = 201;
renderer.drawCombat({combat,debug:{showRanges:false}});
assert.ok(!arcs.some((arc) => arc[2] === 24 || Math.abs(arc[2] - 35) < 1e-9), "Timed fighter visuals expire on simulation time");
console.log("platform-tests: ok (floating pointer/reset, audio retry/resume, combat visual clock)");
