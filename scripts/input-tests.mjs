// SPDX-License-Identifier: GPL-3.0-or-later
// Additional terms under GPL-3.0 section 7 apply; see NOTICE.md.
import assert from "node:assert/strict";
import { InputManager } from "../src/input.js";

class Control extends EventTarget {
  constructor({ left = 0, top = 0, width = 100, height = 100, captureFails = false } = {}) {
    super();
    this.rect = { left, top, width, height };
    this.captureFails = captureFails;
    this.captured = new Set();
    this.classes = new Set();
    this.styles = new Map();
    this.attrs = new Map();
    this.style = { setProperty: (name, value) => this.styles.set(name, value) };
    this.classList = { add: (name) => this.classes.add(name), remove: (name) => this.classes.delete(name) };
  }
  getBoundingClientRect() { return this.rect; }
  setPointerCapture(id) { if (this.captureFails) throw new Error("capture unavailable"); this.captured.add(id); }
  hasPointerCapture(id) { return this.captured.has(id); }
  releasePointerCapture(id) { this.captured.delete(id); }
  setAttribute(name, value) { this.attrs.set(name, value); }
}

function setup(state = "combatActive") {
  global.window = new EventTarget();
  window.innerWidth = 390;
  window.innerHeight = 844;
  global.document = new EventTarget();
  let now = 1000;
  let currentState = state;
  let pads = [];
  const input = new InputManager({ getTopState: () => currentState, clock: () => now, getGamepads: () => pads });
  return { input, tick: (ms = 0) => { now += ms; return input.update(); }, state: (value) => { currentState = value; }, pads: (value) => { pads = value; } };
}

function key(input, code, { up = false, repeat = false, target } = {}) {
  const event = { code, repeat, target, prevented: false, preventDefault() { this.prevented = true; } };
  if (up) input.onKeyUp(event); else input.onKeyDown(event);
  return event;
}

function pointer(target, type, id = 1, x = 50, y = 50, options = {}) {
  const event = new Event(type, { cancelable: true });
  Object.assign(event, { pointerId: id, clientX: x, clientY: y, pointerType: "touch", button: 0, ...options });
  target.dispatchEvent(event);
  return event;
}

function pad(index = 0) {
  return { index, id: `Test standard pad ${index}`, connected: true, mapping: "standard", axes: [0, 0, 0, 0], buttons: Array.from({ length: 17 }, () => ({ pressed: false, value: 0 })) };
}
function button(pad, index, pressed) { pad.buttons[index] = { pressed, value: pressed ? 1 : 0 }; }

let tests = 0;
function test(name, fn) { fn(); tests += 1; console.log(`ok ${tests} - ${name}`); }

test("quick keyboard taps survive a frame and consume only on accepted attack", () => {
  const { input, tick } = setup();
  key(input, "Space"); key(input, "Space", { up: true });
  assert.equal(tick().p1Attack, true);
  assert.equal(tick(120).p1Attack, true, "Polling must not consume an unavailable attack");
  input.consumeCombatAction("p1", "attack");
  assert.equal(tick().p1Attack, false);
  key(input, "Space"); key(input, "Space", { up: true });
  assert.equal(tick(181).p1Attack, false, "An old tap must expire");
});

test("basic fire holds but special is one buffered press", () => {
  const { input, tick } = setup();
  key(input, "Space"); key(input, "ShiftLeft");
  assert.equal(tick().p1Special, true);
  input.consumeCombatAction("p1", "special");
  input.consumeCombatAction("p1", "attack");
  assert.equal(tick(500).p1Special, false);
  assert.equal(tick().p1Attack, true);
  key(input, "ShiftLeft", { repeat: true });
  assert.equal(tick().p1Special, false);
  key(input, "Space", { up: true });
  assert.equal(tick().p1Attack, false);
  key(input, "ShiftRight");
  assert.equal(tick().p2Special, true, "Right Shift belongs to P2 only");
  assert.equal(input.actions.p1Special, false);
});

test("held global shortcuts do not retrigger and reset requires key release", () => {
  const { input, tick } = setup();
  key(input, "Escape");
  assert.equal(tick().pause, true);
  key(input, "Escape", { repeat: true });
  assert.equal(tick().pause, false);
  key(input, "KeyD");
  assert.equal(tick().p1MoveX, 1);
  input.resetAll();
  key(input, "KeyD", { repeat: true });
  assert.equal(tick().p1MoveX, 0);
  key(input, "KeyD", { up: true }); key(input, "KeyD");
  assert.equal(tick().p1MoveX, 1);
  input.resetAll();
  key(input, "KeyD");
  assert.equal(tick().p1MoveX, 1, "A fresh physical press works even when a prior keyup was lost outside the app");
});

test("diagonal normalization and hybrid release preserve the other device", () => {
  const { input, tick } = setup();
  key(input, "KeyW"); key(input, "KeyD");
  const action = tick();
  assert.ok(Math.abs(Math.hypot(action.p1MoveX, action.p1MoveY) - 1) < 1e-9);
  input.setTouchVector("p1", -1, 0);
  key(input, "KeyW", { up: true }); key(input, "KeyD", { up: true });
  assert.equal(tick().p1MoveX, -1);
  key(input, "KeyD"); input.clearTouchVector("p1");
  assert.equal(tick().p1MoveX, 1);
});

test("floating joystick has neutral landing, deadzone, visible motion, and ownership", () => {
  const { input, tick } = setup();
  const stick = new Control({ left: 20, top: 700, width: 120, height: 100 });
  input.bindStick(stick, "p1");
  pointer(stick, "pointerdown", 1, 35, 735);
  assert.equal(tick().p1MoveX, 0, "Landing away from the center must not lurch");
  assert.equal(input.getSnapshot().touchActive.p1.move, true, "Lifecycle owner sees a held but neutral stick");
  pointer(stick, "pointermove", 1, 37, 735);
  assert.equal(tick().p1MoveX, 0);
  pointer(stick, "pointermove", 1, 65, 735);
  assert.equal(tick().p1MoveX, 1);
  assert.equal(stick.styles.get("--stick-origin-x"), "15px");
  assert.equal(stick.styles.get("--stick-x"), "30px");
  pointer(stick, "pointerdown", 2, 70, 770); pointer(stick, "pointerup", 2);
  assert.equal(tick().p1MoveX, 1);
  pointer(window, "pointerup", 1);
  assert.equal(tick().p1MoveX, 0);
  assert.equal(stick.classes.has("is-active"), false);
});

test("short landscape and near-glass-edge throws reach full movement", () => {
  const { input, tick } = setup();
  window.innerWidth = 844; window.innerHeight = 390;
  const stick = new Control({ left: 20, top: 340, width: 180, height: 44 });
  input.bindStick(stick, "p1");
  pointer(stick, "pointerdown", 1, 100, 380);
  pointer(stick, "pointermove", 1, 100, 388);
  assert.equal(tick().p1MoveY, 1, "Reachable eight-pixel throw at screen edge is sufficient");
  pointer(window, "pointerup", 1);
  pointer(stick, "pointerdown", 2, 100, 365);
  pointer(stick, "pointermove", 2, 100, 350);
  assert.equal(tick().p1MoveY, -1);
});

test("capture failures retain movement and window cancel clears ownership", () => {
  const { input, tick } = setup();
  const stick = new Control({ captureFails: true });
  input.bindStick(stick, "p1");
  pointer(stick, "pointerdown"); pointer(window, "pointermove", 1, 90, 50);
  assert.equal(tick().p1MoveX, 1);
  pointer(window, "pointercancel");
  assert.equal(tick().p1MoveX, 0);
  pointer(stick, "pointerdown"); pointer(stick, "pointermove", 1, 90, 50);
  assert.equal(tick().p1MoveX, 1, "Same pointer identifier can be reused after cancellation");
  input.resetAll(); // The main lifecycle owner resets after measuring a changed layout.
  pointer(window, "pointermove", 1, 100, 50);
  assert.equal(tick().p1MoveX, 0);
});

test("two thumbs move and fire independently, drag aims, and held fire repeats", () => {
  const { input, tick } = setup();
  const stick = new Control(); const fire = new Control();
  input.bindStick(stick, "p1"); input.bindAimPad(fire, "p1");
  pointer(stick, "pointerdown", 1); pointer(stick, "pointermove", 1, 10, 50);
  pointer(fire, "pointerdown", 2);
  assert.equal(tick().p1Attack, true); assert.equal(input.actions.p1MoveX, -1);
  assert.equal(input.actions.p1ManualAim, false);
  pointer(fire, "pointermove", 2, 70, 30);
  assert.ok(tick().p1AimX > 0); assert.ok(input.actions.p1AimY < 0);
  input.consumeCombatAction("p1", "attack");
  assert.equal(tick(1000).p1Attack, true);
  pointer(window, "pointerup", 1);
  assert.equal(tick().p1MoveX, 0); assert.equal(input.actions.p1Attack, true);
  pointer(window, "pointerup", 2);
  assert.equal(tick().p1Attack, false); assert.equal(input.actions.p1ManualAim, false);
});

test("button cancellation drops its tap and does not erase a different device press", () => {
  const { input, tick } = setup();
  const fire = new Control({ captureFails: true });
  input.bindTouchButton(fire, "p1", "attack");
  pointer(fire, "pointerdown", 1); pointer(window, "pointercancel", 1);
  assert.equal(tick().p1Attack, false);
  pointer(fire, "pointerdown", 2);
  key(input, "Space"); key(input, "Space", { up: true });
  pointer(window, "pointercancel", 2);
  assert.equal(tick().p1Attack, true);
});

test("special touch holds once; compatibility clicks never double fire", () => {
  const { input, tick } = setup(); const special = new Control();
  input.bindTouchButton(special, "p1", "special");
  pointer(special, "pointerdown"); assert.equal(tick().p1Special, true);
  input.consumeCombatAction("p1", "special");
  assert.equal(tick(400).p1Special, false);
  pointer(special, "pointerup"); pointer(special, "click", 1, 0, 0, { detail: 1 });
  assert.equal(tick().p1Special, false);
  tick(600); pointer(special, "click", 1, 0, 0, { detail: 0 });
  assert.equal(tick().p1Special, true, "Keyboard/assistive click remains operable");
});

test("reset removes old fingers and visuals while allowing fresh controls", () => {
  const { input, tick } = setup(); const fire = new Control();
  input.bindAimPad(fire, "p1");
  pointer(fire, "pointerdown"); pointer(fire, "pointermove", 1, 80, 50);
  input.resetAll(); pointer(fire, "pointermove", 1, 100, 50);
  assert.equal(tick().p1Attack, false); assert.equal(input.actions.p1ManualAim, false);
  assert.equal(fire.classes.has("is-active"), false); assert.equal(fire.captured.size, 0);
  pointer(fire, "pointerdown", 2); assert.equal(tick().p1Attack, true);
});

test("mouse arena has aim, held basic, right-click special, and ignores touch", () => {
  const { input, tick } = setup(); const arena = new Control();
  input.bindArenaPointer(arena, "p1", { pointFromEvent: (event) => ({ x: event.clientX * 2, y: event.clientY * 2 }) });
  pointer(arena, "pointerdown", 1, 50, 60);
  assert.equal(tick().p1Attack, false);
  pointer(arena, "pointermove", 2, 60, 70, { pointerType: "mouse" });
  assert.deepEqual(tick().p1AimPoint, { x: 120, y: 140 });
  pointer(arena, "pointerdown", 2, 60, 70, { pointerType: "mouse" });
  input.consumeCombatAction("p1", "attack"); assert.equal(tick(500).p1Attack, true);
  pointer(arena, "mousedown", 2, 60, 70, { pointerType: "mouse", button: 2 });
  assert.equal(tick().p1Special, true);
  pointer(window, "pointerup", 2, 60, 70, { pointerType: "mouse" });
  assert.equal(tick().p1Attack, false);
  assert.deepEqual(input.actions.p1AimPoint, { x: 120, y: 140 });
});

test("quick aim-and-release keeps the buffered shot's direction until accepted", () => {
  const { input, tick } = setup(); const fire = new Control();
  input.bindAimPad(fire, "p1");
  pointer(fire, "pointerdown", 1); pointer(fire, "pointermove", 1, 50, 10); pointer(window, "pointerup", 1);
  assert.equal(tick().p1Attack, true); assert.equal(input.actions.p1AimY, -1);
  input.consumeCombatAction("p1", "attack");
  assert.equal(tick().p1ManualAim, false);
});

test("native controls retain keyboard activation and text editing", () => {
  const { input, tick } = setup("board");
  for (const target of [{ tagName: "BUTTON" }, { tagName: "SELECT" }, { tagName: "INPUT", type: "checkbox" }, { tagName: "INPUT", type: "text" }]) {
    assert.equal(key(input, "Space", { target }).prevented, false);
    assert.equal(tick().confirm, false);
  }
  assert.equal(key(input, "ArrowDown", { target: { tagName: "SELECT" } }).prevented, false);
  assert.equal(tick().menuY, 0);
  assert.equal(key(input, "Tab").prevented, false);
  key(input, "ArrowDown"); key(input, "ArrowDown", { up: true });
  assert.equal(tick().menuY, 1, "A quick board navigation tap survives the frame");
  key(input, "Enter"); key(input, "Enter", { up: true }); assert.equal(tick().confirm, true);
});

test("gamepad starts neutral-gated and supports held fire, one-shot special and aim", () => {
  const { input, tick, pads } = setup(); const controller = pad();
  button(controller, 0, true); pads([controller]);
  assert.equal(tick().p1Attack, false);
  button(controller, 0, false); tick();
  controller.axes = [1, 1, -1, 0]; button(controller, 0, true); button(controller, 2, true);
  let actions = tick();
  assert.ok(Math.abs(Math.hypot(actions.p1MoveX, actions.p1MoveY) - 1) < 1e-9);
  assert.equal(actions.p1AimX, -1); assert.equal(actions.p1ManualAim, true);
  assert.equal(actions.p1Attack, true); assert.equal(actions.p1Special, true);
  input.consumeCombatAction("p1", "special"); input.consumeCombatAction("p1", "attack");
  actions = tick(500); assert.equal(actions.p1Special, false); assert.equal(actions.p1Attack, true);
  input.resetAll(); assert.equal(tick().p1Attack, false); assert.equal(input.actions.p1MoveX, 0);
  controller.axes = [0, 0, 0, 0]; button(controller, 0, false); button(controller, 2, false); tick();
  button(controller, 7, true); assert.equal(tick().p1Attack, true);
  assert.equal(input.getSnapshot().lastDevice, "gamepad");
});

test("gamepad menus repeat directional steps but confirm and pause stay edged", () => {
  const { input, tick, pads } = setup("title"); const controller = pad(); pads([controller]); tick();
  controller.axes[1] = 1;
  assert.equal(tick().menuY, 1); assert.equal(tick(200).menuY, 0); assert.equal(tick(121).menuY, 1);
  button(controller, 0, true); assert.equal(tick().confirm, true); assert.equal(tick().confirm, false);
  button(controller, 9, true); assert.equal(tick().pause, true); assert.equal(tick().pause, false);
  button(controller, 1, true); button(controller, 3, true); button(controller, 5, true);
  const actions = tick(); assert.equal(actions.cancel, true); assert.equal(actions.toggleHelp, true); assert.equal(actions.focusNext, true);
});

test("pad roles survive disconnect and neutral-gated reconnect", () => {
  const { input, tick, pads } = setup(); const first = pad(0); const second = pad(3); pads([first, second]); tick();
  first.axes[0] = 1; second.axes[0] = -1;
  assert.equal(tick().p1MoveX, 1); assert.equal(input.actions.p2MoveX, -1);
  pads([second]); let actions = tick();
  assert.equal(actions.gamepadDisconnected, true); assert.equal(actions.p1MoveX, 0); assert.equal(actions.p2MoveX, -1);
  assert.equal(tick().gamepadDisconnected, false);
  pads([first, second]); assert.equal(tick().p1MoveX, 0);
  first.axes[0] = 0; tick(); first.axes[0] = 1; assert.equal(tick().p1MoveX, 1);
  assert.deepEqual(input.getSnapshot().gamepads.map(({ index, role }) => [index, role]), [[3, "p2"], [0, "p1"]]);
});

test("sparse gamepad shape and denied API cannot break keyboard or touch", () => {
  const { input, tick, pads } = setup(); pads([{ index: 0, id: "Sparse", connected: true, mapping: "standard", axes: [0], buttons: [] }]);
  assert.doesNotThrow(() => tick());
  input.readGamepads = () => { throw new Error("policy denied"); };
  key(input, "KeyD"); assert.equal(tick().p1MoveX, 1);
});

console.log(`input-tests: ${tests}/${tests} passed (buffers, pointer ownership, keyboard, mouse, gamepad, lifecycle)`);
