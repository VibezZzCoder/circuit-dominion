// SPDX-License-Identifier: GPL-3.0-or-later
export const FACTIONS = {
  SOLAR: "S",
  VOID: "V",
};

export const FACTION_NAMES = {
  [FACTIONS.SOLAR]: "Solar Protocol",
  [FACTIONS.VOID]: "Void Core",
};

export const ALIGNMENTS = {
  [FACTIONS.SOLAR]: "Light",
  [FACTIONS.VOID]: "Dark",
};

export const ENERGY = {
  NEUTRAL: "N",
  LIGHT: "L",
  DARK: "D",
};

export const ENERGY_ORDER = [ENERGY.NEUTRAL, ENERGY.LIGHT, ENERGY.DARK];

export const POWER_NODES = [
  [0, 4],
  [4, 0],
  [4, 4],
  [4, 8],
  [8, 4],
];

export const FLUX_PHASES = [
  ENERGY.NEUTRAL,
  ENERGY.LIGHT,
  ENERGY.NEUTRAL,
  ENERGY.DARK,
];

export const COMMAND_POWER_COSTS = {
  gridLock: 1,
  fieldRepair: 1,
  emergencyRelay: 2,
};

export const DIFFICULTY_SETTINGS = {
  easy: {
    id: "easy",
    label: "Easy",
    reactionMs: 280,
    aimErrorRad: 0.24,
    boardCandidates: 3,
    replyDepth: 0,
    specialBias: 0.68,
  },
  standard: {
    id: "standard",
    label: "Standard",
    reactionMs: 170,
    aimErrorRad: 0.13,
    boardCandidates: 1,
    replyDepth: 1,
    specialBias: 0.88,
  },
  hard: {
    id: "hard",
    label: "Hard",
    reactionMs: 90,
    aimErrorRad: 0.05,
    boardCandidates: 1,
    replyDepth: 2,
    specialBias: 0.96,
  },
};

export function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

export function inBounds(row, col, size = 9) {
  return row >= 0 && row < size && col >= 0 && col < size;
}

export function enemyFaction(faction) {
  return faction === FACTIONS.SOLAR ? FACTIONS.VOID : FACTIONS.SOLAR;
}

export function factionEnergy(faction) {
  return faction === FACTIONS.SOLAR ? ENERGY.LIGHT : ENERGY.DARK;
}

export function normalizeDifficulty(value) {
  return DIFFICULTY_SETTINGS[value] ? value : "standard";
}

export function coordLabel(row, col) {
  return `${String.fromCharCode(65 + col)}${row + 1}`;
}

export function energyLabel(energy) {
  if (energy === ENERGY.LIGHT) {
    return "☀ Light Grid";
  }
  if (energy === ENERGY.DARK) {
    return "◆ Dark Grid";
  }
  return "◇ Neutral Grid";
}

export function nowMs() {
  return performance.now();
}

export function randId(prefix) {
  return `${prefix}${Math.random().toString(36).slice(2, 8)}`;
}

export function dist2d(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function unitFaction(unit, defs) {
  return defs[unit.type].faction;
}
