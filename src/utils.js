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
  [2, 2],
  [2, 6],
  [4, 4],
  [6, 2],
  [6, 6],
];

export function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

export function inBounds(row, col, size = 9) {
  return row >= 0 && row < size && col >= 0 && col < size;
}

export function enemyFaction(faction) {
  return faction === FACTIONS.SOLAR ? FACTIONS.VOID : FACTIONS.SOLAR;
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
