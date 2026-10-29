// SPDX-License-Identifier: GPL-3.0-or-later
// Additional terms under GPL-3.0 section 7 apply; see NOTICE.md.
import { clamp } from "./utils.js";

const ROLES = ["p1", "p2"];
const BUFFER_MS = { attack: 180, special: 220 };
const POINTER_AIM_IDLE_MS = 1600;
const PLAY_KEYS = new Set(["Space", "KeyF", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Enter", "Slash", "ShiftLeft", "ShiftRight", "KeyW", "KeyA", "KeyS", "KeyD"]);
const COMBAT_STATES = new Set(["combatIntro", "combatCountdown", "combatActive", "combatResolving"]);
const DIRECTION_KEYS = { ArrowLeft: [-1, 0], KeyA: [-1, 0], ArrowRight: [1, 0], KeyD: [1, 0], ArrowUp: [0, -1], KeyW: [0, -1], ArrowDown: [0, 1], KeyS: [0, 1] };

function vector(x = 0, y = 0, deadzone = 0) {
  x = Number.isFinite(x) ? x : 0;
  y = Number.isFinite(y) ? y : 0;
  const length = Math.hypot(x, y);
  if (length <= deadzone) return { x: 0, y: 0 };
  const scale = Math.min(1, (length - deadzone) / (1 - deadzone)) / length;
  return { x: x * scale, y: y * scale };
}

function strongest(...vectors) {
  return vectors.reduce((best, next) => Math.hypot(next.x, next.y) > Math.hypot(best.x, best.y) ? next : best, { x: 0, y: 0 });
}

function nativeKeyOwner(event) {
  const target = event.target;
  if (!target) return false;
  const tag = target.tagName?.toUpperCase();
  if (target.isContentEditable || tag === "TEXTAREA") return true;
  if (tag === "INPUT") {
    const type = (target.type || "text").toLowerCase();
    if (!["checkbox", "radio", "range", "button", "submit", "reset"].includes(type)) return true;
    if (["checkbox", "radio"].includes(type)) return event.code === "Space" || event.code.startsWith("Arrow");
    if (type === "range") return event.code.startsWith("Arrow") || ["Home", "End", "PageUp", "PageDown"].includes(event.code);
  }
  if (tag === "SELECT") return event.code.startsWith("Arrow") || ["Space", "Enter", "Home", "End"].includes(event.code);
  return (tag === "BUTTON" || tag === "A") && ["Space", "Enter"].includes(event.code);
}

export class InputManager {
  constructor({ getTopState = () => "title", getMode = () => "ai", clock = () => performance.now(), getGamepads, onDeviceChange } = {}) {
    this.getTopState = getTopState;
    this.getMode = getMode;
    this.clock = clock;
    this.readGamepads = getGamepads || (() => typeof navigator !== "undefined" && navigator.getGamepads ? navigator.getGamepads() : []);
    this.onDeviceChange = onDeviceChange;
    this.lastDevice = window.matchMedia?.("(pointer: coarse)").matches ? "touch" : "keyboard";
    this.keys = {};
    this.blockedKeys = new Set();
    this.touch = { p1: { x: 0, y: 0 }, p2: { x: 0, y: 0 } };
    this.touchStickActive = { p1: false, p2: false };
    this.touchAim = { p1: { x: 0, y: 0 }, p2: { x: 0, y: 0 } };
    this.bufferedAim = { p1: null, p2: null };
    this.pointerAim = { p1: null, p2: null };
    this.touchHeld = { p1: { attack: new Set(), special: new Set() }, p2: { attack: new Set(), special: new Set() } };
    this.pointerAttackHeld = { p1: false, p2: false };
    this.buffers = { p1: { attack: -Infinity, special: -Infinity }, p2: { attack: -Infinity, special: -Infinity } };
    this.bufferOwners = { p1: { attack: null, special: null }, p2: { attack: null, special: null } };
    this.edge = {};
    this.menuPress = { x: 0, y: 0 };
    this.menuRepeat = { x: 0, y: 0, at: 0 };
    this.gamepads = new Map();
    this.bindings = new WeakMap();
    this.stickResets = [];
    this.actions = this.defaultActions();
    window.addEventListener("keydown", (event) => this.onKeyDown(event));
    window.addEventListener("keyup", (event) => this.onKeyUp(event));
    window.addEventListener("pointerdown", (event) => {
      this.noteDevice(event.pointerType === "touch" || event.pointerType === "pen" ? "touch" : "keyboard");
    });
    window.addEventListener("blur", () => this.resetAll());
    document.addEventListener("visibilitychange", () => { if (document.hidden) this.resetAll(); });
  }

  defaultActions() {
    const actions = { pause: false, restart: false, toggleHelp: false, toggleDebug: false, menuX: 0, menuY: 0, confirm: false, cancel: false, focusNext: false, gamepadDisconnected: false };
    for (const role of ROLES) Object.assign(actions, { [`${role}MoveX`]: 0, [`${role}MoveY`]: 0, [`${role}Attack`]: false, [`${role}Special`]: false, [`${role}AimX`]: 0, [`${role}AimY`]: 0, [`${role}ManualAim`]: false, [`${role}AimPoint`]: null });
    return actions;
  }

  isCombat() { return COMBAT_STATES.has(this.getTopState()); }

  noteDevice(device) {
    if (this.lastDevice === device) return;
    this.lastDevice = device;
    if (device !== "keyboard") this.pointerAim = { p1: null, p2: null };
    this.onDeviceChange?.(device);
  }

  bufferAction(role, kind, owner = null) {
    if (this.buffers[role] && kind in BUFFER_MS) {
      this.buffers[role][kind] = this.clock() + BUFFER_MS[kind];
      this.bufferOwners[role][kind] = owner;
    }
  }

  // Combat owns legality. Call this only after scheduling the action, not on poll.
  consumeCombatAction(role, kind) {
    if (this.buffers[role] && kind in BUFFER_MS) {
      this.buffers[role][kind] = -Infinity;
      this.bufferOwners[role][kind] = null;
      if (kind === "attack") this.bufferedAim[role] = null;
    }
  }

  onKeyDown(event) {
    if (nativeKeyOwner(event)) return;
    const state = this.getTopState();
    if ((this.isCombat() || state === "board" || state === "boardAnimating") && PLAY_KEYS.has(event.code)) event.preventDefault();
    if (event.repeat || this.keys[event.code]) return;
    // A non-repeating keydown is a fresh press, including after a keyup was lost
    // while another application had focus. OS repeat alone cannot revive a reset.
    this.blockedKeys.delete(event.code);
    this.keys[event.code] = true;
    this.noteDevice("keyboard");
    if (event.code === "Escape") { this.edge.pause = true; this.edge.cancel = true; }
    if (event.code === "KeyR") this.edge.restart = true;
    if (event.code === "KeyH") this.edge.toggleHelp = true;
    if (event.code === "Backquote") this.edge.toggleDebug = true;
    if (!this.isCombat()) {
      const direction = DIRECTION_KEYS[event.code];
      if (direction) this.menuPress = { x: direction[0], y: direction[1] };
      if (["Enter", "Space"].includes(event.code)) this.edge.confirm = true;
      return;
    }
    if (["Space", "KeyF"].includes(event.code)) this.bufferAction("p1", "attack");
    if (event.code === "ShiftLeft") this.bufferAction("p1", "special");
    if (["Enter", "Slash"].includes(event.code)) this.bufferAction("p2", "attack");
    if (event.code === "ShiftRight") this.bufferAction("p2", "special");
  }

  onKeyUp(event) { this.keys[event.code] = false; this.blockedKeys.delete(event.code); }

  pollGamepads() {
    let connected = [];
    try { connected = Array.from(this.readGamepads() || []).filter((pad) => pad && pad.connected !== false); } catch { /* Browser policy may deny the API. Keyboard and touch remain usable. */ }
    const indices = new Set(connected.map((pad) => pad.index));
    for (const [index, state] of this.gamepads) {
      if (!indices.has(index)) {
        this.gamepads.delete(index);
        for (const kind of ["attack", "special"]) {
          if (this.bufferOwners[state.role][kind] === `pad:${index}`) this.consumeCombatAction(state.role, kind);
        }
        this.edge.gamepadDisconnected = true;
      }
    }
    const result = { p1: { move: vector(), aim: vector(), attack: false }, p2: { move: vector(), aim: vector(), attack: false }, menu: vector() };
    for (const pad of connected.sort((a, b) => a.index - b.index)) {
      let state = this.gamepads.get(pad.index);
      if (!state) {
        const role = ROLES.find((candidate) => !Array.from(this.gamepads.values()).some((existing) => existing.role === candidate));
        if (!role) continue;
        state = { role, index: pad.index, id: pad.id || "Controller", mapping: pad.mapping || "unmapped", blocked: true, previous: [] };
        this.gamepads.set(pad.index, state);
      }
      const buttons = Array.from(pad.buttons || [], (button) => typeof button === "number" ? button > 0.35 : Boolean(button?.pressed || button?.value > 0.35));
      const axes = Array.from(pad.axes || [], (axis) => Number.isFinite(axis) ? clamp(axis, -1, 1) : 0);
      const neutral = buttons.every((pressed) => !pressed) && axes.every((axis) => Math.abs(axis) < 0.22);
      if (state.blocked) {
        state.previous = buttons;
        if (neutral) state.blocked = false;
        continue;
      }
      const pressed = (index) => Boolean(buttons[index] && !state.previous[index]);
      const move = vector((axes[0] || 0) + (buttons[15] ? 1 : 0) - (buttons[14] ? 1 : 0), (axes[1] || 0) + (buttons[13] ? 1 : 0) - (buttons[12] ? 1 : 0), 0.18);
      const aim = vector(axes[2] || 0, axes[3] || 0, 0.22);
      const attack = Boolean(buttons[0] || buttons[7]);
      if (!neutral) this.noteDevice("gamepad");
      result[state.role] = { move, aim, attack };
      if (pressed(9)) this.edge.pause = true;
      if (pressed(1)) this.edge.cancel = true;
      if (pressed(3)) this.edge.toggleHelp = true;
      if (this.isCombat()) {
        if (pressed(0) || pressed(7)) this.bufferAction(state.role, "attack", `pad:${pad.index}`);
        if (pressed(2) || pressed(4)) this.bufferAction(state.role, "special", `pad:${pad.index}`);
      } else {
        if (pressed(0)) this.edge.confirm = true;
        if (pressed(5)) this.edge.focusNext = true;
        result.menu = strongest(result.menu, move);
      }
      state.previous = buttons;
    }
    return result;
  }

  update() {
    const now = this.clock();
    const pad = this.pollGamepads();
    const keyMoves = {
      p1: vector((this.keys.KeyD ? 1 : 0) - (this.keys.KeyA ? 1 : 0), (this.keys.KeyS ? 1 : 0) - (this.keys.KeyW ? 1 : 0)),
      p2: vector((this.keys.ArrowRight ? 1 : 0) - (this.keys.ArrowLeft ? 1 : 0), (this.keys.ArrowDown ? 1 : 0) - (this.keys.ArrowUp ? 1 : 0)),
    };
    this.actions = this.defaultActions();
    for (const role of ROLES) {
      const move = strongest(keyMoves[role], this.touch[role], pad[role].move);
      const bufferedAim = this.bufferedAim[role];
      const aim = strongest(this.touchAim[role], pad[role].aim, bufferedAim?.until >= now ? bufferedAim : vector());
      const keyboardAttack = role === "p1" ? this.keys.Space || this.keys.KeyF : this.keys.Enter || this.keys.Slash;
      this.actions[`${role}MoveX`] = move.x;
      this.actions[`${role}MoveY`] = move.y;
      this.actions[`${role}Attack`] = Boolean(keyboardAttack || this.touchHeld[role].attack.size || this.pointerAttackHeld[role] || pad[role].attack || this.buffers[role].attack >= now);
      this.actions[`${role}Special`] = this.buffers[role].special >= now;
      this.actions[`${role}AimX`] = aim.x;
      this.actions[`${role}AimY`] = aim.y;
      // A resting mouse stops overriding aim assist; holding the button keeps it.
      const pointer = this.pointerAim[role];
      if (pointer && !this.pointerAttackHeld[role] && now - (pointer.at ?? now) > POINTER_AIM_IDLE_MS) this.pointerAim[role] = null;
      this.actions[`${role}AimPoint`] = this.pointerAim[role] ? { x: this.pointerAim[role].x, y: this.pointerAim[role].y } : null;
      this.actions[`${role}ManualAim`] = Math.hypot(aim.x, aim.y) > 0 || Boolean(this.pointerAim[role]);
    }
    if (!this.isCombat()) {
      const keyboardMenu = strongest(keyMoves.p1, keyMoves.p2);
      const menu = strongest(keyboardMenu, pad.menu);
      const x = Math.abs(menu.x) >= 0.5 ? Math.sign(menu.x) : 0;
      const y = Math.abs(menu.y) >= 0.5 ? Math.sign(menu.y) : 0;
      if (x !== this.menuRepeat.x || y !== this.menuRepeat.y) {
        this.menuRepeat = { x, y, at: now + 320 };
        this.actions.menuX = x;
        this.actions.menuY = y;
      } else if ((x || y) && now >= this.menuRepeat.at) {
        this.actions.menuX = x;
        this.actions.menuY = y;
        this.menuRepeat.at = now + 120;
      }
      if (this.menuPress.x || this.menuPress.y) {
        this.actions.menuX = this.menuPress.x;
        this.actions.menuY = this.menuPress.y;
      }
    } else this.menuRepeat = { x: 0, y: 0, at: 0 };
    this.menuPress = { x: 0, y: 0 };
    for (const name of Object.keys(this.edge)) this.actions[name] = this.consumeEdge(name);
    return this.actions;
  }

  consumeEdge(name) { const value = Boolean(this.edge[name]); this.edge[name] = false; return value; }
  axis(keyAxis, touchAxis) { return clamp(keyAxis + touchAxis, -1, 1); }

  setTouchVector(role, x, y) {
    if (!this.touch[role]) return;
    this.touch[role] = vector(clamp(x, -1, 1), clamp(y, -1, 1));
  }
  clearTouchVector(role) { if (this.touch[role]) this.touch[role] = { x: 0, y: 0 }; }
  triggerTouchAction(role, kind) { this.bufferAction(role, kind); }

  setPointerAim(role, x, y) {
    if (!ROLES.includes(role) || !Number.isFinite(x) || !Number.isFinite(y)) return;
    this.noteDevice("keyboard");
    this.pointerAim[role] = { x, y, at: this.clock() };
  }
  clearPointerAim(role) { if (ROLES.includes(role)) this.pointerAim[role] = null; }
  setPointerAttack(role, held) {
    if (!ROLES.includes(role)) return;
    if (held && !this.pointerAttackHeld[role]) this.bufferAction(role, "attack");
    this.pointerAttackHeld[role] = Boolean(held);
  }

  bindArenaPointer(element, role, { pointFromEvent } = {}) {
    if (!element || !ROLES.includes(role)) return;
    let pointerId = null;
    const aim = (event) => {
      if (event.pointerType !== "mouse" || !this.isCombat()) return;
      const point = pointFromEvent?.(event);
      if (point) this.setPointerAim(role, point.x, point.y);
    };
    const reset = () => {
      const old = pointerId;
      pointerId = null;
      this.pointerAttackHeld[role] = false;
      this.clearPointerAim(role);
      this.safeRelease(element, old);
    };
    element.addEventListener("pointerdown", (event) => {
      if (event.pointerType !== "mouse" || !this.isCombat()) return;
      event.preventDefault();
      aim(event);
      if (event.button === 0 && pointerId === null) {
        pointerId = event.pointerId;
        this.pointerAttackHeld[role] = true;
        this.bufferAction(role, "attack", element);
        this.safeCapture(element, pointerId);
      }
    }, { passive: false });
    // Pointerdown only fires for the first mouse button. Mousedown is required
    // to accept right-click Special while left Fire is already held.
    element.addEventListener("mousedown", (event) => {
      if (event.button !== 2 || !this.isCombat()) return;
      event.preventDefault();
      const point = pointFromEvent?.(event);
      if (point) this.setPointerAim(role, point.x, point.y);
      this.bufferAction(role, "special", element);
    });
    element.addEventListener("pointermove", aim);
    window.addEventListener("pointermove", (event) => { if (event.pointerId === pointerId) aim(event); });
    element.addEventListener("pointerleave", () => { if (pointerId === null) this.clearPointerAim(role); });
    const release = (event) => {
      if (event.pointerId !== pointerId) return;
      if (event.type !== "pointerup" && this.bufferOwners[role].attack === element) this.consumeCombatAction(role, "attack");
      reset();
      if (event.type === "pointerup") aim(event);
    };
    for (const name of ["pointerup", "pointercancel", "lostpointercapture"]) element.addEventListener(name, release);
    for (const name of ["pointerup", "pointercancel"]) window.addEventListener(name, release);
    element.addEventListener("contextmenu", (event) => { if (this.isCombat()) event.preventDefault(); });
    this.stickResets.push(reset);
  }

  safeCapture(element, id) { try { element.setPointerCapture?.(id); } catch { /* Window release/move listeners keep control usable without capture. */ } }
  safeRelease(element, id) { try { if (id !== null && element.hasPointerCapture?.(id)) element.releasePointerCapture?.(id); } catch { /* Capture may already be reclaimed. */ } }
  setStyle(element, name, value) { element.style?.setProperty?.(name, value); }

  bindStick(element, role) {
    if (!element || !ROLES.includes(role) || this.bindings.has(element)) return;
    let pointerId = null;
    let origin = { x: 0, y: 0 };
    let radius = 28;
    const reset = () => {
      const old = pointerId;
      pointerId = null;
      this.clearTouchVector(role);
      this.touchStickActive[role] = false;
      element.classList?.remove("is-active");
      this.setStyle(element, "--stick-x", "0px");
      this.setStyle(element, "--stick-y", "0px");
      this.setStyle(element, "--stick-origin-x", "50%");
      this.setStyle(element, "--stick-origin-y", "50%");
      this.safeRelease(element, old);
    };
    const move = (event) => {
      if (event.pointerId !== pointerId) return;
      event.preventDefault();
      const dx = event.clientX - origin.x;
      const dy = event.clientY - origin.y;
      // At a glass edge use only the reachable throw in that direction.
      const viewportWidth = window.innerWidth || Infinity;
      const viewportHeight = window.innerHeight || Infinity;
      const throwX = Math.max(8, Math.min(radius, dx < 0 ? origin.x - 2 : viewportWidth - origin.x - 2));
      const throwY = Math.max(8, Math.min(radius, dy < 0 ? origin.y - 2 : viewportHeight - origin.y - 2));
      const v = vector(dx / throwX, dy / throwY, 0.1);
      this.setTouchVector(role, v.x, v.y);
      this.setStyle(element, "--stick-x", `${v.x * Math.min(radius, throwX)}px`);
      this.setStyle(element, "--stick-y", `${v.y * Math.min(radius, throwY)}px`);
    };
    element.addEventListener("pointerdown", (event) => {
      if (pointerId !== null || (event.pointerType === "mouse" && event.button !== 0)) return;
      event.preventDefault();
      pointerId = event.pointerId;
      this.touchStickActive[role] = true;
      const rect = element.getBoundingClientRect();
      radius = Math.max(12, Math.min(38, Math.min(rect.width, rect.height) * 0.3));
      origin = { x: event.clientX, y: event.clientY };
      this.clearTouchVector(role);
      this.noteDevice(event.pointerType === "mouse" ? "keyboard" : "touch");
      element.classList?.add("is-active");
      this.setStyle(element, "--stick-origin-x", `${origin.x - rect.left}px`);
      this.setStyle(element, "--stick-origin-y", `${origin.y - rect.top}px`);
      this.safeCapture(element, pointerId);
    }, { passive: false });
    element.addEventListener("pointermove", move, { passive: false });
    window.addEventListener("pointermove", move, { passive: false });
    const release = (event) => { if (event.pointerId === pointerId) reset(); };
    for (const name of ["pointerup", "pointercancel", "lostpointercapture"]) element.addEventListener(name, release);
    for (const name of ["pointerup", "pointercancel"]) window.addEventListener(name, release);
    this.bindings.set(element, { type: "stick", reset });
    this.stickResets.push(reset);
  }

  bindTouchButton(element, role, kind, { aim = kind === "attack" } = {}) {
    if (!element || !ROLES.includes(role) || !(kind in BUFFER_MS)) return;
    if (this.bindings.has(element)) return;
    const binding = { type: "button", aim, role, kind };
    let pointerId = null;
    let origin = { x: 0, y: 0 };
    let suppressClickUntil = -Infinity;
    const reset = () => {
      const old = pointerId;
      pointerId = null;
      this.touchHeld[role][kind].delete(element);
      if (binding.aim) this.touchAim[role] = vector();
      element.classList?.remove("is-active");
      element.setAttribute?.("aria-pressed", "false");
      this.setStyle(element, "--aim-x", "0px");
      this.setStyle(element, "--aim-y", "0px");
      this.safeRelease(element, old);
    };
    element.addEventListener("pointerdown", (event) => {
      if (pointerId !== null || element.disabled || (event.pointerType === "mouse" && event.button !== 0)) return;
      event.preventDefault();
      pointerId = event.pointerId;
      origin = { x: event.clientX, y: event.clientY };
      suppressClickUntil = this.clock() + 800;
      this.touchHeld[role][kind].add(element);
      this.bufferAction(role, kind, element);
      this.noteDevice(event.pointerType === "mouse" ? "keyboard" : "touch");
      element.classList?.add("is-active");
      element.setAttribute?.("aria-pressed", "true");
      this.safeCapture(element, pointerId);
    }, { passive: false });
    const move = (event) => {
      if (event.pointerId !== pointerId || !binding.aim) return;
      event.preventDefault();
      const dx = event.clientX - origin.x;
      const dy = event.clientY - origin.y;
      const length = Math.hypot(dx, dy);
      this.touchAim[role] = length > 9 ? { x: dx / length, y: dy / length } : vector();
      this.setStyle(element, "--aim-x", `${length > 9 ? dx / length * Math.min(length, 22) : 0}px`);
      this.setStyle(element, "--aim-y", `${length > 9 ? dy / length * Math.min(length, 22) : 0}px`);
    };
    element.addEventListener("pointermove", move, { passive: false });
    window.addEventListener("pointermove", move, { passive: false });
    const release = (event) => {
      if (event.pointerId !== pointerId) return;
      suppressClickUntil = this.clock() + 500;
      if (event.type !== "pointerup" && this.bufferOwners[role][kind] === element) this.consumeCombatAction(role, kind);
      if (event.type === "pointerup" && binding.aim && this.bufferOwners[role][kind] === element && Math.hypot(this.touchAim[role].x, this.touchAim[role].y) > 0) {
        this.bufferedAim[role] = { ...this.touchAim[role], until: this.buffers[role][kind] };
      }
      reset();
    };
    for (const name of ["pointerup", "pointercancel", "lostpointercapture"]) element.addEventListener(name, release);
    for (const name of ["pointerup", "pointercancel"]) window.addEventListener(name, release);
    element.addEventListener("click", (event) => {
      // Pointer down already handled it. detail=0 is keyboard/assistive activation.
      if (event.detail !== 0 || this.clock() < suppressClickUntil || element.disabled) return;
      event.preventDefault();
      this.bufferAction(role, kind);
    });
    binding.reset = reset;
    this.bindings.set(element, binding);
    this.stickResets.push(reset);
  }

  bindAimPad(element, role) {
    const binding = this.bindings.get(element);
    if (binding?.type === "button" && binding.role === role && binding.kind === "attack") binding.aim = true;
    else this.bindTouchButton(element, role, "attack", { aim: true });
  }

  resetAll() {
    for (const code of Object.keys(this.keys)) if (this.keys[code]) this.blockedKeys.add(code);
    this.keys = {};
    this.stickResets.forEach((reset) => reset());
    for (const role of ROLES) {
      this.clearTouchVector(role);
      this.touchStickActive[role] = false;
      this.touchAim[role] = vector();
      this.bufferedAim[role] = null;
      this.pointerAim[role] = null;
      this.pointerAttackHeld[role] = false;
      for (const kind of ["attack", "special"]) {
        this.touchHeld[role][kind].clear();
        this.buffers[role][kind] = -Infinity;
        this.bufferOwners[role][kind] = null;
      }
    }
    for (const state of this.gamepads.values()) state.blocked = true;
    this.edge = {};
    this.menuPress = { x: 0, y: 0 };
    this.menuRepeat = { x: 0, y: 0, at: 0 };
    this.actions = this.defaultActions();
  }

  getSnapshot() {
    return {
      actions: { ...this.actions },
      keysPressed: Object.keys(this.keys).filter((key) => this.keys[key]),
      touch: { p1: { ...this.touch.p1 }, p2: { ...this.touch.p2 } },
      touchButtons: Object.fromEntries(ROLES.map((role) => [role, { attack: this.touchHeld[role].attack.size > 0, special: this.touchHeld[role].special.size > 0 }])),
      touchActive: Object.fromEntries(ROLES.map((role) => [role, { move: this.touchStickActive[role], attack: this.touchHeld[role].attack.size > 0, special: this.touchHeld[role].special.size > 0 }])),
      lastDevice: this.lastDevice,
      gamepads: Array.from(this.gamepads.values(), ({ index, id, role, mapping, blocked }) => ({ index, id, role, mapping, blocked, connected: true })),
    };
  }
}
