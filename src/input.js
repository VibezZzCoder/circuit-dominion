// SPDX-License-Identifier: GPL-3.0-or-later
import { clamp } from "./utils.js";

const KEY_BLOCKLIST = new Set([
  "Space",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Enter",
  "Slash",
  "ShiftLeft",
  "ShiftRight",
  "KeyW",
  "KeyA",
  "KeyS",
  "KeyD",
]);

export class InputManager {
  constructor({ getTopState }) {
    this.getTopState = getTopState;
    this.keys = {};
    this.touch = {
      p1: { x: 0, y: 0 },
      p2: { x: 0, y: 0 },
    };
    this.touchAttackLatch = { p1: false, p2: false };
    this.touchSpecialLatch = { p1: false, p2: false };
    this.edge = {
      pause: false,
      restart: false,
      toggleHelp: false,
      toggleDebug: false,
    };

    this.actions = this.defaultActions();

    window.addEventListener("keydown", (event) => this.onKeyDown(event));
    window.addEventListener("keyup", (event) => this.onKeyUp(event));
    window.addEventListener("blur", () => this.resetAll());
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) {
        this.resetAll();
      }
    });
  }

  defaultActions() {
    return {
      p1MoveX: 0,
      p1MoveY: 0,
      p1Attack: false,
      p1Special: false,
      p2MoveX: 0,
      p2MoveY: 0,
      p2Attack: false,
      p2Special: false,
      pause: false,
      restart: false,
      toggleHelp: false,
      toggleDebug: false,
    };
  }

  onKeyDown(event) {
    this.keys[event.code] = true;

    if (event.code === "Escape") {
      this.edge.pause = true;
    }
    if (event.code === "KeyR") {
      this.edge.restart = true;
    }
    if (event.code === "KeyH") {
      this.edge.toggleHelp = true;
    }
    if (event.code === "Backquote") {
      this.edge.toggleDebug = true;
    }

    const topState = this.getTopState();
    const inPlay = topState && topState !== "title";
    if (inPlay && KEY_BLOCKLIST.has(event.code)) {
      event.preventDefault();
    }
  }

  onKeyUp(event) {
    this.keys[event.code] = false;
  }

  update() {
    this.actions = this.defaultActions();

    this.actions.p1MoveX = this.axis((this.keys.KeyD ? 1 : 0) - (this.keys.KeyA ? 1 : 0), this.touch.p1.x);
    this.actions.p1MoveY = this.axis((this.keys.KeyS ? 1 : 0) - (this.keys.KeyW ? 1 : 0), this.touch.p1.y);
    this.actions.p2MoveX = this.axis((this.keys.ArrowRight ? 1 : 0) - (this.keys.ArrowLeft ? 1 : 0), this.touch.p2.x);
    this.actions.p2MoveY = this.axis((this.keys.ArrowDown ? 1 : 0) - (this.keys.ArrowUp ? 1 : 0), this.touch.p2.y);

    this.actions.p1Attack = Boolean(this.keys.Space || this.keys.KeyF || this.touchAttackLatch.p1);
    this.actions.p1Special = Boolean(this.keys.ShiftLeft || this.touchSpecialLatch.p1);
    this.actions.p2Attack = Boolean(this.keys.Enter || this.keys.Slash || this.touchAttackLatch.p2);
    this.actions.p2Special = Boolean(this.keys.ShiftRight || this.touchSpecialLatch.p2);

    this.actions.pause = this.consumeEdge("pause");
    this.actions.restart = this.consumeEdge("restart");
    this.actions.toggleHelp = this.consumeEdge("toggleHelp");
    this.actions.toggleDebug = this.consumeEdge("toggleDebug");

    // Touch attack/special are edge-like, not held, to avoid auto-firing on mobile.
    this.touchAttackLatch.p1 = false;
    this.touchAttackLatch.p2 = false;
    this.touchSpecialLatch.p1 = false;
    this.touchSpecialLatch.p2 = false;

    return this.actions;
  }

  axis(keyAxis, touchAxis) {
    return clamp(keyAxis + touchAxis, -1, 1);
  }

  consumeEdge(name) {
    const value = this.edge[name];
    this.edge[name] = false;
    return value;
  }

  setTouchVector(role, x, y) {
    if (!this.touch[role]) {
      return;
    }
    this.touch[role].x = clamp(x, -1, 1);
    this.touch[role].y = clamp(y, -1, 1);
  }

  clearTouchVector(role) {
    if (!this.touch[role]) {
      return;
    }
    this.touch[role].x = 0;
    this.touch[role].y = 0;
  }

  triggerTouchAction(role, kind) {
    if (kind === "attack") {
      this.touchAttackLatch[role] = true;
    }
    if (kind === "special") {
      this.touchSpecialLatch[role] = true;
    }
  }

  bindStick(element, role) {
    let pointerId = null;
    let cx = 0;
    let cy = 0;

    const move = (event) => {
      if (pointerId !== event.pointerId) {
        return;
      }
      event.preventDefault();
      let dx = (event.clientX - cx) / 38;
      let dy = (event.clientY - cy) / 38;
      const mag = Math.hypot(dx, dy);
      if (mag > 1) {
        dx /= mag;
        dy /= mag;
      }
      this.setTouchVector(role, dx, dy);
    };

    element.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      pointerId = event.pointerId;
      element.setPointerCapture(pointerId);
      const rect = element.getBoundingClientRect();
      cx = rect.left + rect.width / 2;
      cy = rect.top + rect.height / 2;
      move(event);
    });

    element.addEventListener("pointermove", move);

    ["pointerup", "pointercancel", "lostpointercapture"].forEach((name) => {
      element.addEventListener(name, () => {
        pointerId = null;
        this.clearTouchVector(role);
      });
    });
  }

  bindTouchButton(element, role, kind) {
    const activate = (event) => {
      event.preventDefault();
      this.triggerTouchAction(role, kind);
    };
    element.addEventListener("click", activate);
    element.addEventListener("pointerdown", activate, { passive: false });
  }

  resetAll() {
    this.keys = {};
    this.clearTouchVector("p1");
    this.clearTouchVector("p2");
    this.touchAttackLatch.p1 = false;
    this.touchAttackLatch.p2 = false;
    this.touchSpecialLatch.p1 = false;
    this.touchSpecialLatch.p2 = false;
    this.edge.pause = false;
    this.edge.restart = false;
    this.edge.toggleHelp = false;
    this.edge.toggleDebug = false;
    this.actions = this.defaultActions();
  }

  getSnapshot() {
    return {
      actions: { ...this.actions },
      keysPressed: Object.keys(this.keys).filter((k) => this.keys[k]),
      touch: {
        p1: { ...this.touch.p1 },
        p2: { ...this.touch.p2 },
      },
    };
  }
}
