// SPDX-License-Identifier: GPL-3.0-or-later
import { FighterState } from "./state.js";

export function createActionTiming(def, actionName) {
  const action = def[actionName];
  const t = action.timing;
  return {
    startupMs: t.startupMs,
    activeMs: t.activeMs,
    recoveryMs: t.recoveryMs,
    cooldownSec: action.cooldown,
  };
}

export function setFighterState(fighter, stateName, nowMs, durationMs = 0) {
  fighter.state = stateName;
  fighter.stateUntil = durationMs > 0 ? nowMs + durationMs : 0;
}

export function tickFighterState(fighter, nowMs) {
  if (fighter.stateUntil > 0 && nowMs >= fighter.stateUntil) {
    fighter.state = FighterState.IDLE;
    fighter.stateUntil = 0;
  }
}

export function isFighterLocked(fighter) {
  return (
    fighter.state === FighterState.ATTACK_STARTUP ||
    fighter.state === FighterState.ATTACK_ACTIVE ||
    fighter.state === FighterState.SPECIAL_STARTUP ||
    fighter.state === FighterState.SPECIAL_ACTIVE ||
    fighter.state === FighterState.STUNNED ||
    fighter.state === FighterState.DEAD
  );
}
