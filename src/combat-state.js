// SPDX-License-Identifier: GPL-3.0-or-later
import { FighterState } from "./state.js";

export function createActionTiming(def, actionName) {
  const t = def.timings;
  if (actionName === "attack") {
    return {
      startupMs: t.attackStartup,
      activeMs: t.attackActive,
      recoveryMs: t.attackRecovery,
      cooldownSec: def.attackCooldown,
    };
  }
  return {
    startupMs: t.specialStartup,
    activeMs: t.specialActive,
    recoveryMs: t.specialRecovery,
    cooldownSec: def.specialCooldown,
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
