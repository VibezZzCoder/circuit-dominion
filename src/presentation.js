// SPDX-License-Identifier: GPL-3.0-or-later
// Additional terms under GPL-3.0 section 7 apply; see NOTICE.md.
// Board presentation timeline: movement tweens, board effects, and banners.
// Gameplay positions always update immediately; this only describes how the
// change is shown. The clock advances from the main loop's simulation delta,
// so QA stepFrames drives it deterministically and Help freezes it.

const EFFECT_HISTORY_MS = 4000;

export function createPresentation() {
  return {
    clockMs: 0,
    instant: false,
    tweens: new Map(),
    effects: [],
    effectSeq: 0,
    banner: null,
    lastMove: null,
    hover: null,
    showLabels: false,
    pendingDuel: null,
    pendingGameOver: null,
    settleUntil: 0,
  };
}

export function advancePresentation(presentation, deltaSec) {
  presentation.clockMs += Math.max(0, deltaSec) * 1000;
  const now = presentation.clockMs;
  for (const [id, tween] of presentation.tweens) {
    if (tween.kind !== "approach" && now > tween.start + tween.duration + 400) presentation.tweens.delete(id);
  }
  if (presentation.effects.some((effect) => effect.t < now - EFFECT_HISTORY_MS)) {
    presentation.effects = presentation.effects.filter((effect) => effect.t >= now - EFFECT_HISTORY_MS);
  }
  if (presentation.banner && now > presentation.banner.t + presentation.banner.life) presentation.banner = null;
}

function distanceSquares(from, to) {
  return Math.max(Math.abs(from.row - to.row), Math.abs(from.col - to.col));
}

export function moveDurationMs(from, to) {
  return Math.min(640, 200 + distanceSquares(from, to) * 95);
}

// Start a visual move. `from` may be fractional (e.g. returning from a clash).
export function noteUnitMove(presentation, unit, from, to, kind = "move", faction = null) {
  if (!presentation || !unit) return null;
  if (presentation.instant) {
    presentation.tweens.delete(unit.id);
    return null;
  }
  const duration = kind === "teleport" ? 460 : kind === "settle" ? 300 : moveDurationMs(from, to);
  const tween = {
    unitId: unit.id,
    kind,
    from: { row: from.row, col: from.col },
    to: { row: to.row, col: to.col },
    start: presentation.clockMs,
    duration,
    hold: kind === "approach" ? 0.56 : 1,
  };
  presentation.tweens.set(unit.id, tween);
  if (kind === "move" || kind === "teleport") {
    presentation.lastMove = { from: { row: Math.round(from.row), col: Math.round(from.col) }, to: { ...to }, faction, t: presentation.clockMs };
  }
  return tween;
}

// Opening march: both armies slide in from their home edges, column by column.
export function deployUnits(presentation, units, factionOf) {
  if (!presentation || presentation.instant) return;
  const start = presentation.clockMs + 250;
  for (const unit of units) {
    const solar = factionOf(unit) === "S";
    presentation.tweens.set(unit.id, {
      unitId: unit.id,
      kind: "deploy",
      from: { row: unit.row + (solar ? 1.7 : -1.7), col: unit.col },
      to: { row: unit.row, col: unit.col },
      start: start + unit.col * 70 + (solar ? 35 : 0),
      duration: 520,
      hold: 1,
    });
  }
}

export function tweenEndsAt(tween) {
  return tween ? tween.start + tween.duration : 0;
}

export function clearTween(presentation, unitId) {
  presentation?.tweens.delete(unitId);
}

// `delay` (ms) schedules the effect, e.g. a landing ring when a glide ends.
export function pushBoardEffect(presentation, type, data = {}) {
  if (!presentation || presentation.instant) return;
  const { delay = 0, ...rest } = data;
  presentation.effectSeq += 1;
  presentation.effects.push({ seq: presentation.effectSeq, t: presentation.clockMs + Math.max(0, delay), type, ...rest });
}

export function showBoardBanner(presentation, text, sub = "", faction = null, life = 1300) {
  if (!presentation || presentation.instant) return;
  presentation.banner = { text, sub, faction, t: presentation.clockMs, life };
}

export function isBoardBusy(presentation) {
  if (!presentation || presentation.instant) return false;
  const now = presentation.clockMs;
  if (presentation.pendingDuel || presentation.pendingGameOver) return true;
  if (now < presentation.settleUntil) return true;
  for (const tween of presentation.tweens.values()) {
    if (tween.kind !== "approach" && now < tween.start + tween.duration) return true;
  }
  return false;
}

function smooth(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

// Visual board position (in cells) for a unit at the presentation clock.
export function unitTweenPosition(presentation, unit, clock = presentation?.clockMs ?? 0) {
  const resting = { row: unit.row, col: unit.col, hop: 0, moving: false, alpha: 1, tween: null };
  const tween = presentation?.tweens.get(unit.id);
  if (!tween) return resting;
  const raw = Math.max(0, Math.min(1, (clock - tween.start) / Math.max(1, tween.duration)));
  if (tween.kind === "approach") {
    if (unit.row !== tween.from.row || unit.col !== tween.from.col) return resting;
    const k = smooth(raw) * tween.hold;
    const shake = raw >= 1 ? Math.sin(clock / 22) * 0.025 : 0;
    return {
      row: tween.from.row + (tween.to.row - tween.from.row) * k + shake,
      col: tween.from.col + (tween.to.col - tween.from.col) * k - shake,
      hop: Math.sin(Math.min(1, raw) * Math.PI) * 0.08,
      moving: raw < 1,
      alpha: 1,
      tween: { ...tween, flash: (now) => (raw >= 1 ? Math.max(0, 0.6 - ((now - tween.start - tween.duration) / 400)) : 0) },
    };
  }
  if (unit.row !== tween.to.row || unit.col !== tween.to.col) return resting;
  if (raw >= 1) return resting;
  if (tween.kind === "deploy") {
    const k = 1 - Math.pow(1 - raw, 3);
    return {
      row: tween.from.row + (tween.to.row - tween.from.row) * k,
      col: tween.to.col,
      hop: 0,
      moving: raw > 0,
      alpha: Math.min(1, raw * 2.5),
      tween,
    };
  }
  if (tween.kind === "teleport") {
    const out = raw < 0.5;
    const at = out ? tween.from : tween.to;
    return { row: at.row, col: at.col, hop: 0, moving: true, alpha: out ? 1 - raw * 2 : (raw - 0.5) * 2, tween };
  }
  const k = smooth(raw);
  const squares = Math.max(1, distanceSquares(tween.from, tween.to));
  return {
    row: tween.from.row + (tween.to.row - tween.from.row) * k,
    col: tween.from.col + (tween.to.col - tween.from.col) * k,
    hop: Math.sin(raw * Math.PI) * 0.1 + Math.abs(Math.sin(raw * Math.PI * squares)) * 0.04,
    moving: true,
    alpha: 1,
    tween,
  };
}
