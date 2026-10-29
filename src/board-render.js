// SPDX-License-Identifier: GPL-3.0-or-later
// Additional terms under GPL-3.0 section 7 apply; see NOTICE.md.
// Tactical board presentation. Reads gameplay state plus the presentation
// timeline (src/presentation.js); never changes rules or unit positions.
import { getUnitAt } from "./board.js";
import { unitTweenPosition } from "./presentation.js";
import { UNIT_DEFS } from "./units.js";
import { ENERGY, POWER_NODES, clamp } from "./utils.js";
import {
  PALETTE,
  ParticleSystem,
  drawFluxGlyph,
  drawLockGlyph,
  drawSunGlyph,
  drawVoidGlyph,
  easeOutCubic,
  factionColor,
  glowSprite,
  prefersReducedMotion,
  roundRectPath,
  scaledSprite,
  tintedSprite,
  withAlpha,
} from "./fx.js";

const FRAME_RATIO = 0.46;
const HOVERING = new Set(["SD", "PM", "GW", "CB"]);
const COLUMN_LABELS = "ABCDEFGHI";

// One geometry contract for drawing and for pointer hit-testing.
export function boardGeometry(width, height) {
  const cell = Math.min(width, height) / (9 + FRAME_RATIO * 2);
  const size = cell * 9;
  return {
    cell,
    size,
    frame: cell * FRAME_RATIO,
    ox: (width - size) / 2,
    oy: (height - size) / 2,
  };
}

function hashPhase(id) {
  let h = 0;
  for (let i = 0; i < id.length; i += 1) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return (h % 1000) / 1000 * Math.PI * 2;
}

function makeCanvas(width, height) {
  if (typeof document === "undefined" || typeof document.createElement !== "function") return null;
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  return canvas;
}

const TILE_STYLES = {
  [ENERGY.LIGHT]: { top: "#3e9fb0", bottom: "#164656", rim: "rgba(214,255,255,0.45)", edge: "rgba(4,26,34,0.85)", glyph: "rgba(255,246,214,0.2)", trace: "rgba(190,255,255,0.14)" },
  [ENERGY.DARK]: { top: "#3f1d5a", bottom: "#170926", rim: "rgba(236,170,255,0.34)", edge: "rgba(10,2,20,0.9)", glyph: "rgba(240,180,255,0.18)", trace: "rgba(220,150,255,0.12)" },
  [ENERGY.NEUTRAL]: { top: "#40506a", bottom: "#1a2232", rim: "rgba(210,226,245,0.32)", edge: "rgba(4,8,14,0.9)", glyph: "rgba(220,232,250,0.16)", trace: "rgba(200,220,245,0.1)" },
};

export class BoardRenderer {
  constructor(assets) {
    this.assets = assets;
    this.tileCache = new Map();
    this.cacheCell = 0;
    this.particles = new ParticleSystem(360);
    this.lastClock = null;
    this.consumed = new Set();
    this.lastPresentation = null;
    this.energyMemory = null;
    this.reduceMotion = prefersReducedMotion();
  }

  tileTexture(energy, cell, pixelRatio) {
    const key = `${energy}:${Math.round(cell * pixelRatio)}`;
    if (this.tileCache.has(key)) return this.tileCache.get(key);
    const px = Math.max(8, Math.round(cell * pixelRatio));
    const canvas = makeCanvas(px, px);
    const ctx = canvas?.getContext("2d");
    if (!ctx) {
      this.tileCache.set(key, null);
      return null;
    }
    const style = TILE_STYLES[energy];
    const inset = px * 0.035;
    const radius = px * 0.12;
    const w = px - inset * 2;
    const gradient = ctx.createLinearGradient(0, inset, 0, px - inset);
    gradient.addColorStop(0, style.top);
    gradient.addColorStop(1, style.bottom);
    ctx.fillStyle = style.edge;
    roundRectPath(ctx, inset * 0.5, inset * 0.9, w + inset, w + inset * 0.6, radius);
    ctx.fill();
    ctx.fillStyle = gradient;
    roundRectPath(ctx, inset, inset, w, w, radius);
    ctx.fill();
    // Soft inner sheen toward the top-left.
    const sheen = ctx.createRadialGradient(px * 0.28, px * 0.2, 0, px * 0.28, px * 0.2, px * 0.8);
    sheen.addColorStop(0, "rgba(255,255,255,0.12)");
    sheen.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = sheen;
    roundRectPath(ctx, inset, inset, w, w, radius);
    ctx.fill();
    // Circuit traces etched into the panel.
    ctx.save();
    roundRectPath(ctx, inset, inset, w, w, radius);
    ctx.clip();
    ctx.strokeStyle = style.trace;
    ctx.lineWidth = Math.max(1, px * 0.012);
    ctx.beginPath();
    ctx.moveTo(inset, px * 0.3);
    ctx.lineTo(px * 0.22, px * 0.3);
    ctx.lineTo(px * 0.3, px * 0.22);
    ctx.lineTo(px * 0.3, inset);
    ctx.moveTo(px - inset, px * 0.7);
    ctx.lineTo(px * 0.78, px * 0.7);
    ctx.lineTo(px * 0.7, px * 0.78);
    ctx.lineTo(px * 0.7, px - inset);
    ctx.stroke();
    ctx.fillStyle = style.trace;
    for (const [x, y] of [[px * 0.3, px * 0.22], [px * 0.7, px * 0.78]]) {
      ctx.beginPath();
      ctx.arc(x, y, Math.max(1.2, px * 0.022), 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
    // Bevel rim.
    ctx.strokeStyle = style.rim;
    ctx.lineWidth = Math.max(1, px * 0.016);
    roundRectPath(ctx, inset + 0.5, inset + 0.5, w - 1, w - 1, radius);
    ctx.stroke();
    // Polarity glyph: readable without color.
    ctx.fillStyle = style.glyph;
    ctx.strokeStyle = style.glyph;
    ctx.lineWidth = Math.max(1, px * 0.03);
    if (energy === ENERGY.LIGHT) drawSunGlyph(ctx, px / 2, px / 2, px * 0.17);
    else if (energy === ENERGY.DARK) drawVoidGlyph(ctx, px / 2, px / 2, px * 0.17);
    this.tileCache.set(key, canvas);
    return canvas;
  }

  draw(ctx, game, presentation, width, height, pixelRatio) {
    const geometry = boardGeometry(width, height);
    const { cell, ox, oy } = geometry;
    if (Math.abs(cell - this.cacheCell) > 0.5) {
      this.tileCache.clear();
      this.cacheCell = cell;
    }
    if (presentation !== this.lastPresentation) {
      this.lastPresentation = presentation;
      this.lastClock = presentation?.clockMs ?? 0;
      this.consumed = new Set();
      this.particles.clear();
      this.energyMemory = null;
    }
    const clock = presentation?.clockMs ?? 0;
    const gap = (clock - (this.lastClock ?? clock)) / 1000;
    // After a long undrawn gap every short-lived particle would have expired.
    if (gap > 0.25) this.particles.clear();
    const dt = clamp(gap, 0, 0.05);
    this.lastClock = clock;
    if (this.consumed.size > 200 && presentation) {
      const live = new Set(presentation.effects.map((effect) => effect.seq));
      for (const seq of this.consumed) if (!live.has(seq)) this.consumed.delete(seq);
    }
    this.consumeEffects(game, presentation, cell);
    this.trackEnergyChanges(game, clock);
    this.spawnAmbient(game, presentation, cell, dt, clock);
    this.particles.update(dt);
    const t = clock / 1000;

    ctx.clearRect(0, 0, width, height);
    ctx.save();
    ctx.translate(ox, oy);
    // Signature transition: the contested square swells to fill the screen.
    const zoom = duelZoom(presentation, clock);
    // Reduced motion keeps the color crossfade but skips the 4x zoom.
    if (zoom && !this.reduceMotion) {
      const zx = zoom.col * cell + cell / 2;
      const zy = zoom.row * cell + cell / 2;
      const scale = 1 + zoom.k * zoom.k * 3.2;
      ctx.translate(zx, zy);
      ctx.scale(scale, scale);
      ctx.translate(-zx + (geometry.size / 2 - zx) * zoom.k * 0.25 / scale, -zy + (geometry.size / 2 - zy) * zoom.k * 0.25 / scale);
    }
    this.drawFrame(ctx, game, geometry, t);
    this.drawTiles(ctx, game, cell, pixelRatio, clock);
    this.drawFluxOverlay(ctx, game, cell, t);
    this.drawPowerNodes(ctx, game, cell, t);
    this.drawLastMove(ctx, presentation, cell, clock);
    this.drawCommandTargets(ctx, game, cell, t);
    this.drawLegalMoves(ctx, game, presentation, cell, t);
    this.particles.draw(ctx, "ground");
    this.drawUnits(ctx, game, presentation, cell, pixelRatio, t, clock);
    this.particles.draw(ctx, "top");
    this.drawCursor(ctx, game, cell, t);
    this.drawThreat(ctx, game, geometry, t);
    this.drawBanner(ctx, presentation, geometry, clock);
    ctx.restore();
    if (zoom) {
      ctx.save();
      ctx.globalAlpha = Math.min(1, zoom.k * zoom.k * 1.1);
      ctx.fillStyle = zoom.energy === "L" ? "#dffcff" : zoom.energy === "D" ? "#2a0d3f" : "#e8f0ff";
      ctx.fillRect(0, 0, width, height);
      ctx.restore();
    }
  }

  drawFrame(ctx, game, geometry, t) {
    const { cell, size, frame } = geometry;
    const solarTurn = game.turn === "S";
    ctx.save();
    // Plate behind the frame.
    const plate = ctx.createLinearGradient(0, -frame, 0, size + frame);
    plate.addColorStop(0, "#160a24");
    plate.addColorStop(0.5, "#0a0f1c");
    plate.addColorStop(1, "#061823");
    ctx.fillStyle = plate;
    roundRectPath(ctx, -frame, -frame, size + frame * 2, size + frame * 2, frame * 0.9);
    ctx.fill();
    ctx.strokeStyle = "rgba(160,190,230,0.18)";
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // Rim glow: Void across the top, Solar across the bottom; the side to move breathes.
    const pulse = 0.55 + 0.45 * Math.sin(t * 2.4);
    const rim = ctx.createLinearGradient(0, 0, 0, size);
    rim.addColorStop(0, withAlpha(PALETTE.void, solarTurn ? 0.35 : 0.55 + pulse * 0.4));
    rim.addColorStop(0.48, "rgba(150,140,220,0.25)");
    rim.addColorStop(1, withAlpha(PALETTE.solar, solarTurn ? 0.55 + pulse * 0.4 : 0.35));
    ctx.strokeStyle = rim;
    ctx.lineWidth = Math.max(2, cell * 0.045);
    roundRectPath(ctx, -frame * 0.28, -frame * 0.28, size + frame * 0.56, size + frame * 0.56, frame * 0.5);
    ctx.stroke();

    // Coordinates match the in-game square names (A1 is top-left).
    ctx.fillStyle = "rgba(200,225,255,0.5)";
    ctx.font = `700 ${Math.max(9, Math.round(cell * 0.2))}px "Trebuchet MS", Arial, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    for (let index = 0; index < 9; index += 1) {
      const c = index * cell + cell / 2;
      ctx.fillText(COLUMN_LABELS[index], c, -frame * 0.62);
      ctx.fillText(COLUMN_LABELS[index], c, size + frame * 0.62);
      ctx.fillText(String(index + 1), -frame * 0.62, c);
      ctx.fillText(String(index + 1), size + frame * 0.62, c);
    }
    // Corner studs.
    for (const [x, y, color] of [[-frame * 0.28, -frame * 0.28, PALETTE.void], [size + frame * 0.28, -frame * 0.28, PALETTE.void], [-frame * 0.28, size + frame * 0.28, PALETTE.solar], [size + frame * 0.28, size + frame * 0.28, PALETTE.solar]]) {
      const glow = glowSprite(color);
      if (glow) ctx.drawImage(glow, x - frame * 0.7, y - frame * 0.7, frame * 1.4, frame * 1.4);
      ctx.fillStyle = "#e8f6ff";
      ctx.beginPath();
      ctx.arc(x, y, Math.max(1.5, frame * 0.12), 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  trackEnergyChanges(game, clock) {
    // Remember previous polarity per square so Flux shifts crossfade in a wave.
    if (!this.energyMemory) {
      this.energyMemory = game.board.map((row) => row.map((square) => ({ from: square.energy, to: square.energy, at: -1e9 })));
      return;
    }
    for (let row = 0; row < 9; row += 1) {
      for (let col = 0; col < 9; col += 1) {
        const memory = this.energyMemory[row][col];
        const energy = game.board[row][col].energy;
        if (energy !== memory.to) {
          memory.from = memory.to;
          memory.to = energy;
          memory.at = clock + (row + col) * 34;
        }
      }
    }
  }

  drawTiles(ctx, game, cell, pixelRatio, clock) {
    for (let row = 0; row < 9; row += 1) {
      for (let col = 0; col < 9; col += 1) {
        const square = game.board[row][col];
        const x = col * cell;
        const y = row * cell;
        const memory = this.energyMemory?.[row]?.[col];
        const k = memory ? clamp((clock - memory.at) / 520, 0, 1) : 1;
        const current = this.tileTexture(square.energy, cell, pixelRatio);
        if (k < 1 && memory) {
          const previous = this.tileTexture(memory.from, cell, pixelRatio);
          if (previous) ctx.drawImage(previous, x, y, cell, cell);
          if (current) {
            ctx.globalAlpha = easeOutCubic(k);
            ctx.drawImage(current, x, y, cell, cell);
            ctx.globalAlpha = 1;
          }
          if (k > 0) {
            ctx.save();
            ctx.globalCompositeOperation = "lighter";
            ctx.globalAlpha = Math.sin(k * Math.PI) * 0.5;
            ctx.fillStyle = square.energy === ENERGY.LIGHT ? PALETTE.solar : square.energy === ENERGY.DARK ? PALETTE.void : "#b9d4e6";
            roundRectPath(ctx, x + cell * 0.05, y + cell * 0.05, cell * 0.9, cell * 0.9, cell * 0.12);
            ctx.fill();
            ctx.restore();
          }
        } else if (current) {
          ctx.drawImage(current, x, y, cell, cell);
        } else {
          ctx.fillStyle = square.energy === ENERGY.LIGHT ? "#1d6273" : square.energy === ENERGY.DARK ? "#2b1340" : "#263142";
          ctx.fillRect(x + 1, y + 1, cell - 2, cell - 2);
        }
      }
    }
  }

  drawFluxOverlay(ctx, game, cell, t) {
    ctx.save();
    const dash = cell * 0.12;
    ctx.setLineDash([dash, dash * 0.7]);
    ctx.lineDashOffset = -t * cell * 0.35;
    for (let row = 0; row < 9; row += 1) {
      for (let col = 0; col < 9; col += 1) {
        const square = game.board[row][col];
        if (!square.flux) continue;
        const x = col * cell;
        const y = row * cell;
        const locked = square.lockFaction;
        ctx.strokeStyle = locked ? withAlpha(factionColor(locked, true), 0.95) : "rgba(255,220,99,0.62)";
        ctx.lineWidth = Math.max(1.2, cell * (locked ? 0.04 : 0.026));
        if (locked) ctx.setLineDash([]);
        roundRectPath(ctx, x + cell * 0.1, y + cell * 0.1, cell * 0.8, cell * 0.8, cell * 0.09);
        ctx.stroke();
        if (locked) ctx.setLineDash([dash, dash * 0.7]);
        const gx = x + cell * 0.82;
        const gy = y + cell * 0.18;
        if (locked) {
          ctx.save();
          ctx.setLineDash([]);
          ctx.fillStyle = factionColor(locked, true);
          ctx.strokeStyle = factionColor(locked, true);
          drawLockGlyph(ctx, gx, gy + cell * 0.01, cell * 0.1);
          ctx.restore();
        } else {
          ctx.save();
          ctx.setLineDash([]);
          ctx.strokeStyle = "rgba(255,226,130,0.85)";
          ctx.lineWidth = Math.max(1, cell * 0.022);
          drawFluxGlyph(ctx, gx, gy, cell * 0.065);
          ctx.restore();
        }
      }
    }
    ctx.restore();
  }

  drawPowerNodes(ctx, game, cell, t) {
    for (const [row, col] of POWER_NODES) {
      const cx = col * cell + cell / 2;
      const cy = row * cell + cell / 2;
      const occupant = getUnitAt(game, row, col);
      const owner = occupant ? UNIT_DEFS[occupant.type].faction : null;
      const color = owner ? factionColor(owner) : PALETTE.gold;
      const pulse = 0.5 + 0.5 * Math.sin(t * 3 + row + col);
      ctx.save();
      const glow = glowSprite(color);
      if (glow) {
        ctx.globalAlpha = 0.35 + pulse * 0.25;
        ctx.globalCompositeOperation = "lighter";
        ctx.drawImage(glow, cx - cell * 0.5, cy - cell * 0.5, cell, cell);
        ctx.globalCompositeOperation = "source-over";
        ctx.globalAlpha = 1;
      }
      ctx.fillStyle = "rgba(8,10,18,0.72)";
      ctx.beginPath();
      ctx.arc(cx, cy, cell * 0.3, 0, Math.PI * 2);
      ctx.fill();
      // Rotating segmented reactor ring.
      ctx.strokeStyle = withAlpha(color, 0.9);
      ctx.lineWidth = Math.max(1.5, cell * 0.04);
      const segments = 6;
      for (let index = 0; index < segments; index += 1) {
        const a = t * 0.8 + (index * Math.PI * 2) / segments;
        ctx.beginPath();
        ctx.arc(cx, cy, cell * 0.33, a, a + Math.PI / segments * 1.2);
        ctx.stroke();
      }
      ctx.strokeStyle = withAlpha(color, 0.45);
      ctx.lineWidth = Math.max(1, cell * 0.015);
      ctx.beginPath();
      ctx.arc(cx, cy, cell * 0.24, 0, Math.PI * 2);
      ctx.stroke();
      // Core with a bolt glyph (visible when unoccupied).
      if (!occupant) {
        ctx.fillStyle = withAlpha(PALETTE.gold, 0.25 + pulse * 0.25);
        ctx.beginPath();
        ctx.arc(cx, cy, cell * 0.17, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = "#fff3b0";
        const s = cell * 0.13;
        ctx.beginPath();
        ctx.moveTo(cx + s * 0.2, cy - s);
        ctx.lineTo(cx - s * 0.55, cy + s * 0.12);
        ctx.lineTo(cx - s * 0.05, cy + s * 0.12);
        ctx.lineTo(cx - s * 0.25, cy + s);
        ctx.lineTo(cx + s * 0.55, cy - s * 0.15);
        ctx.lineTo(cx + s * 0.05, cy - s * 0.15);
        ctx.closePath();
        ctx.fill();
      }
      ctx.restore();
    }
  }

  drawLastMove(ctx, presentation, cell, clock) {
    const move = presentation?.lastMove;
    if (!move) return;
    const age = clock - move.t;
    const fadeIn = clamp(age / 300, 0, 1);
    const color = factionColor(move.faction);
    const fx = move.from.col * cell + cell / 2;
    const fy = move.from.row * cell + cell / 2;
    const tx = move.to.col * cell + cell / 2;
    const ty = move.to.row * cell + cell / 2;
    ctx.save();
    ctx.globalAlpha = 0.55 * fadeIn;
    ctx.strokeStyle = withAlpha(color, 0.7);
    ctx.lineWidth = Math.max(1, cell * 0.025);
    ctx.setLineDash([cell * 0.05, cell * 0.08]);
    ctx.beginPath();
    ctx.arc(fx, fy, cell * 0.2, 0, Math.PI * 2);
    ctx.stroke();
    const distance = Math.hypot(tx - fx, ty - fy);
    if (distance > cell * 0.6) {
      const ux = (tx - fx) / distance;
      const uy = (ty - fy) / distance;
      ctx.beginPath();
      ctx.moveTo(fx + ux * cell * 0.24, fy + uy * cell * 0.24);
      ctx.lineTo(tx - ux * cell * 0.42, ty - uy * cell * 0.42);
      ctx.stroke();
    }
    ctx.restore();
  }

  drawCommandTargets(ctx, game, cell, t) {
    this.drawAbilityTargets(ctx, game, cell, t);
    const action = game.boardAction;
    if (!action || action.type === "corrupt" || action.type === "repairAlly") return;
    const targets = [];
    if (action.type === "gridLock") {
      for (let row = 0; row < 9; row += 1) {
        for (let col = 0; col < 9; col += 1) {
          if (game.board[row][col].flux) targets.push([row, col]);
        }
      }
    } else if (action.type === "fieldRepair" || (action.type === "emergencyRelay" && !action.sourceUnitId)) {
      for (const unit of game.units) {
        const def = UNIT_DEFS[unit.type];
        const validRepair = action.type === "fieldRepair" && def.faction === game.turn && !def.isCommandUnit && unit.hp < unit.maxHp;
        const validRelay = action.type === "emergencyRelay" && def.faction === game.turn && !def.isCommandUnit;
        if (unit.alive && (validRepair || validRelay)) targets.push([unit.row, unit.col]);
      }
    }
    const pulse = 0.5 + 0.5 * Math.sin(t * 5);
    ctx.save();
    for (const [row, col] of targets) {
      const cx = col * cell + cell / 2;
      const cy = row * cell + cell / 2;
      ctx.fillStyle = withAlpha(PALETTE.gold, 0.12 + pulse * 0.1);
      roundRectPath(ctx, col * cell + cell * 0.08, row * cell + cell * 0.08, cell * 0.84, cell * 0.84, cell * 0.12);
      ctx.fill();
      ctx.strokeStyle = withAlpha(PALETTE.gold, 0.65 + pulse * 0.35);
      ctx.lineWidth = Math.max(1.5, cell * 0.035);
      drawBrackets(ctx, cx, cy, cell * (0.42 + pulse * 0.03), cell * 0.16);
    }
    ctx.restore();
  }

  // Pulse Medic repair and Corruptor targets: a plus or a corruption sigil.
  drawAbilityTargets(ctx, game, cell, t) {
    const targets = game.abilityTargets || [];
    if (!targets.length) return;
    const source = game.units.find((unit) => unit.id === (game.boardAction?.sourceUnitId || game.selectedUnitId));
    const repair = source?.type === "PM";
    const color = repair ? PALETTE.heal : "#b8ff8a";
    const pulse = 0.5 + 0.5 * Math.sin(t * 4);
    ctx.save();
    for (const { row, col } of targets) {
      const cx = col * cell + cell / 2;
      const cy = row * cell + cell * 0.18;
      ctx.fillStyle = withAlpha(color, 0.12 + pulse * 0.1);
      roundRectPath(ctx, col * cell + cell * 0.08, row * cell + cell * 0.08, cell * 0.84, cell * 0.84, cell * 0.12);
      ctx.fill();
      ctx.strokeStyle = withAlpha(color, 0.6 + pulse * 0.4);
      ctx.lineWidth = Math.max(1.5, cell * 0.03);
      drawBrackets(ctx, col * cell + cell / 2, row * cell + cell / 2, cell * 0.42, cell * 0.14);
      ctx.fillStyle = "rgba(2,10,6,0.85)";
      ctx.beginPath();
      ctx.arc(cx, cy, cell * 0.13, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = color;
      ctx.lineWidth = Math.max(1.5, cell * 0.035);
      ctx.beginPath();
      if (repair) {
        ctx.moveTo(cx - cell * 0.07, cy);
        ctx.lineTo(cx + cell * 0.07, cy);
        ctx.moveTo(cx, cy - cell * 0.07);
        ctx.lineTo(cx, cy + cell * 0.07);
      } else {
        ctx.moveTo(cx - cell * 0.06, cy - cell * 0.06);
        ctx.lineTo(cx + cell * 0.06, cy + cell * 0.06);
        ctx.moveTo(cx + cell * 0.06, cy - cell * 0.06);
        ctx.lineTo(cx - cell * 0.06, cy + cell * 0.06);
      }
      ctx.stroke();
    }
    ctx.restore();
  }

  drawLegalMoves(ctx, game, presentation, cell, t) {
    if (!game.debug?.showLegal || !game.legalMoves.length) return;
    const selected = game.units.find((unit) => unit.id === game.selectedUnitId && unit.alive);
    const relaySource = game.boardAction?.type === "emergencyRelay" ? game.units.find((unit) => unit.id === game.boardAction.sourceUnitId) : null;
    const mover = selected || relaySource;
    const faction = mover ? UNIT_DEFS[mover.type].faction : game.turn;
    const color = factionColor(faction);
    const hover = presentation?.hover;
    const pulse = 0.5 + 0.5 * Math.sin(t * 4.2);
    ctx.save();
    let hovered = null;
    for (const move of game.legalMoves) {
      const cx = move.col * cell + cell / 2;
      const cy = move.row * cell + cell / 2;
      const isHover = hover && hover.row === move.row && hover.col === move.col;
      if (isHover) hovered = move;
      if (move.attack) {
        // Attack reticle around the defender.
        ctx.fillStyle = `rgba(255,70,100,${0.14 + pulse * 0.12 + (isHover ? 0.12 : 0)})`;
        roundRectPath(ctx, move.col * cell + cell * 0.06, move.row * cell + cell * 0.06, cell * 0.88, cell * 0.88, cell * 0.14);
        ctx.fill();
        ctx.strokeStyle = isHover ? "#ffd0d8" : "#ff6f8a";
        ctx.lineWidth = Math.max(1.5, cell * (isHover ? 0.05 : 0.035));
        ctx.save();
        ctx.translate(cx, cy);
        ctx.rotate(Math.sin(t * 1.6) * 0.08);
        drawBrackets(ctx, 0, 0, cell * (0.4 + pulse * 0.03), cell * 0.15);
        ctx.restore();
      } else {
        const glow = glowSprite(color);
        if (glow) {
          ctx.globalCompositeOperation = "lighter";
          ctx.globalAlpha = isHover ? 0.85 : 0.35 + pulse * 0.2;
          const size = cell * (isHover ? 0.75 : 0.5);
          ctx.drawImage(glow, cx - size / 2, cy - size / 2, size, size);
          ctx.globalCompositeOperation = "source-over";
          ctx.globalAlpha = 1;
        }
        ctx.fillStyle = isHover ? "#ffffff" : withAlpha(color, 0.95);
        ctx.beginPath();
        ctx.arc(cx, cy, cell * (isHover ? 0.085 : 0.065), 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = withAlpha(color, isHover ? 0.95 : 0.45);
        ctx.lineWidth = Math.max(1, cell * 0.02);
        ctx.beginPath();
        ctx.arc(cx, cy, cell * (0.2 + (isHover ? 0.03 : pulse * 0.02)), 0, Math.PI * 2);
        ctx.stroke();
      }
    }
    // Path preview and destination ghost for the hovered square.
    if (hovered && mover) {
      const sx = mover.col * cell + cell / 2;
      const sy = mover.row * cell + cell / 2;
      const ex = hovered.col * cell + cell / 2;
      const ey = hovered.row * cell + cell / 2;
      ctx.strokeStyle = withAlpha(hovered.attack ? "#ff8aa0" : color, 0.8);
      ctx.lineWidth = Math.max(1.5, cell * 0.035);
      ctx.setLineDash([cell * 0.06, cell * 0.07]);
      ctx.lineDashOffset = -t * cell * 0.4;
      ctx.beginPath();
      ctx.moveTo(sx, sy);
      ctx.lineTo(ex, ey);
      ctx.stroke();
      ctx.setLineDash([]);
      if (!hovered.attack) {
        const sprite = this.assets?.getUnitImage(mover.type);
        if (sprite) {
          const size = cell * 0.98;
          const ghost = tintedSprite(scaledSprite(sprite, size * 2), color);
          if (ghost) {
            ctx.globalAlpha = 0.28;
            ctx.drawImage(ghost, ex - size / 2, ey + cell * 0.36 - size * 0.9, size, size);
            ctx.globalAlpha = 1;
          }
        }
      }
    }
    ctx.restore();
  }

  drawUnits(ctx, game, presentation, cell, pixelRatio, t, clock) {
    const positioned = game.units.filter((unit) => unit.alive).map((unit) => {
      const position = unitTweenPosition(presentation, unit, clock);
      return { unit, ...position };
    });
    positioned.sort((a, b) => a.row - b.row || a.col - b.col);
    const selectedId = game.selectedUnitId;
    const humanTurn = !(game.mode === "ai" && game.turn === "V") && !game.boardAction;
    const showLabels = Boolean(presentation?.showLabels);
    for (const item of positioned) {
      this.drawUnit(ctx, game, item, cell, pixelRatio, t, clock, {
        selected: item.unit.id === selectedId,
        movable: humanTurn && !selectedId && UNIT_DEFS[item.unit.type].faction === game.turn,
        showLabels,
        hovered: presentation?.hover && presentation.hover.row === item.unit.row && presentation.hover.col === item.unit.col,
      });
    }
  }

  drawUnit(ctx, game, item, cell, pixelRatio, t, clock, flags) {
    const { unit, row, col, hop, moving, alpha: tweenAlpha = 1, tween } = item;
    const def = UNIT_DEFS[unit.type];
    const faction = def.faction;
    const color = factionColor(faction);
    const cx = col * cell + cell / 2;
    const cy = row * cell + cell / 2;
    const phase = hashPhase(unit.id);
    const hover = HOVERING.has(unit.type);
    const bob = hover ? Math.sin(t * 2.4 + phase) * cell * 0.03 : Math.sin(t * 1.7 + phase) * cell * 0.006;
    const lift = (flags.selected ? cell * 0.07 : 0) + hop * cell + (hover ? cell * 0.04 : 0);
    const baseY = cy + cell * 0.27;

    ctx.save();
    ctx.globalAlpha = tweenAlpha;
    // Shadow + faction base ring.
    ctx.fillStyle = "rgba(0,0,0,0.45)";
    ctx.beginPath();
    ctx.ellipse(cx, baseY, cell * (0.3 - lift / cell * 0.3), cell * (0.11 - lift / cell * 0.1), 0, 0, Math.PI * 2);
    ctx.fill();
    const ringPulse = flags.movable ? 0.55 + 0.45 * Math.sin(t * 3 + phase) : 0;
    const glow = glowSprite(color);
    if (glow) {
      ctx.globalCompositeOperation = "lighter";
      ctx.globalAlpha = tweenAlpha * (0.22 + ringPulse * 0.2 + (flags.selected ? 0.35 : 0));
      ctx.drawImage(glow, cx - cell * 0.42, baseY - cell * 0.18, cell * 0.84, cell * 0.36);
      ctx.globalCompositeOperation = "source-over";
      ctx.globalAlpha = tweenAlpha;
    }
    ctx.strokeStyle = withAlpha(color, 0.55 + ringPulse * 0.3 + (flags.selected ? 0.4 : 0));
    ctx.lineWidth = Math.max(1.2, cell * (flags.selected ? 0.035 : 0.022));
    ctx.beginPath();
    ctx.ellipse(cx, baseY, cell * 0.34, cell * 0.125, 0, 0, Math.PI * 2);
    ctx.stroke();
    if (def.isCommandUnit) {
      // Command units wear a crown notch on their base ring.
      ctx.fillStyle = PALETTE.gold;
      const s = cell * 0.07;
      const bx = cx;
      const by = baseY + cell * 0.125;
      ctx.beginPath();
      ctx.moveTo(bx - s, by + s * 0.5);
      ctx.lineTo(bx - s, by - s * 0.4);
      ctx.lineTo(bx - s * 0.45, by + s * 0.05);
      ctx.lineTo(bx, by - s * 0.6);
      ctx.lineTo(bx + s * 0.45, by + s * 0.05);
      ctx.lineTo(bx + s, by - s * 0.4);
      ctx.lineTo(bx + s, by + s * 0.5);
      ctx.closePath();
      ctx.fill();
    }

    // Sprite.
    const sprite = this.assets?.getUnitImage(unit.type);
    const size = cell * 1.1;
    const footY = cy + cell * 0.34 + bob - lift;
    const anchorY = this.assets?.getAsset?.(`unit.${unit.type}`)?.anchor?.y ?? 0.9;
    const top = footY - anchorY * size;
    if (sprite) {
      const image = scaledSprite(sprite, size * pixelRatio);
      if (unit.type === "GW" && moving) ctx.globalAlpha = tweenAlpha * 0.6;
      ctx.drawImage(image, cx - size / 2, top, size, size);
      if (tween?.flash) {
        const white = tintedSprite(image, "#ffffff");
        const k = tween.flash(clock);
        if (white && k > 0) {
          ctx.globalAlpha = tweenAlpha * k;
          ctx.drawImage(white, cx - size / 2, top, size, size);
        }
      }
      ctx.globalAlpha = tweenAlpha;
    } else {
      this.drawFallbackPiece(ctx, unit, def, cx, footY - cell * 0.36, cell * 0.33, color);
    }

    // HP when damaged, selected, or hovered.
    const ratio = clamp(unit.hp / unit.maxHp, 0, 1);
    if (ratio < 0.999 || flags.selected || flags.hovered) {
      const w = cell * 0.58;
      const h = Math.max(3, cell * 0.06);
      const x = cx - w / 2;
      const y = cy + cell * 0.41;
      ctx.fillStyle = "rgba(2,6,14,0.85)";
      roundRectPath(ctx, x - 1, y - 1, w + 2, h + 2, h);
      ctx.fill();
      ctx.fillStyle = ratio > 0.6 ? (faction === "S" ? "#7dff96" : "#c2ff7d") : ratio > 0.3 ? "#ffd36b" : "#ff5f7a";
      roundRectPath(ctx, x, y, Math.max(h, w * ratio), h, h / 2);
      ctx.fill();
    }

    if (unit.weakTurns > 0) {
      const wx = cx;
      const wy = cy - cell * 0.44;
      ctx.font = `800 ${Math.max(8, Math.round(cell * 0.13))}px "Trebuchet MS", Arial, sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      const width = ctx.measureText("WEAK").width + cell * 0.1;
      ctx.fillStyle = "rgba(40,10,50,0.9)";
      roundRectPath(ctx, wx - width / 2, wy - cell * 0.08, width, cell * 0.16, cell * 0.08);
      ctx.fill();
      ctx.fillStyle = "#e3ff8a";
      ctx.fillText("WEAK", wx, wy + 0.5);
    }

    if (flags.showLabels || flags.selected) {
      const label = def.visual.abbr;
      ctx.font = `800 ${Math.max(8, Math.round(cell * 0.15))}px "Trebuchet MS", Arial, sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      const width = ctx.measureText(label).width + cell * 0.12;
      const lx = col * cell + cell * 0.2;
      const ly = row * cell + cell * 0.16;
      ctx.fillStyle = faction === "S" ? "rgba(4,30,40,0.88)" : "rgba(30,8,44,0.88)";
      roundRectPath(ctx, lx - width / 2, ly - cell * 0.09, width, cell * 0.18, cell * 0.06);
      ctx.fill();
      ctx.fillStyle = color;
      ctx.fillText(label, lx, ly + 0.5);
    }

    if (flags.selected) {
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = Math.max(1.5, cell * 0.035);
      const pulse = 0.5 + 0.5 * Math.sin(t * 5);
      drawBrackets(ctx, col * cell + cell / 2, row * cell + cell / 2, cell * (0.46 + pulse * 0.02), cell * 0.16);
    }
    ctx.restore();
  }

  drawFallbackPiece(ctx, unit, def, x, y, radius, color) {
    ctx.save();
    ctx.translate(x, y);
    ctx.fillStyle = def.faction === "S" ? "#102e3b" : "#241032";
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    const sides = unit.type === "PS" || unit.type === "RC" ? 5 : def.isCommandUnit ? 6 : 0;
    if (sides) {
      for (let i = 0; i < sides; i += 1) {
        const a = -Math.PI / 2 + (i * Math.PI * 2) / sides;
        ctx.lineTo(Math.cos(a) * radius, Math.sin(a) * radius);
      }
      ctx.closePath();
    } else {
      ctx.arc(0, 0, radius, 0, Math.PI * 2);
    }
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "#e9fbff";
    ctx.font = `bold ${Math.max(10, radius * 0.7)}px Arial`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(def.visual.abbr, 0, 0);
    ctx.restore();
  }

  drawCursor(ctx, game, cell, t) {
    if (!game.boardCursor?.visible) return;
    const { row, col } = game.boardCursor;
    ctx.save();
    ctx.strokeStyle = PALETTE.gold;
    ctx.shadowColor = PALETTE.gold;
    ctx.shadowBlur = 10;
    ctx.lineWidth = Math.max(2, cell * 0.045);
    const pulse = 0.5 + 0.5 * Math.sin(t * 6);
    drawBrackets(ctx, col * cell + cell / 2, row * cell + cell / 2, cell * (0.47 + pulse * 0.025), cell * 0.18);
    ctx.restore();
  }

  drawThreat(ctx, game, geometry, t) {
    const control = game.nodeControl;
    if (!control) return;
    const threat = control.S === 4 ? "S" : control.V === 4 ? "V" : null;
    if (!threat) return;
    const pulse = 0.5 + 0.5 * Math.sin(t * 6);
    ctx.save();
    ctx.strokeStyle = `rgba(255,95,122,${0.35 + pulse * 0.45})`;
    ctx.lineWidth = Math.max(3, geometry.cell * 0.06);
    roundRectPath(ctx, -geometry.frame * 0.12, -geometry.frame * 0.12, geometry.size + geometry.frame * 0.24, geometry.size + geometry.frame * 0.24, geometry.frame * 0.4);
    ctx.stroke();
    ctx.restore();
  }

  drawBanner(ctx, presentation, geometry, clock) {
    const banner = presentation?.banner;
    if (!banner) return;
    const k = (clock - banner.t) / banner.life;
    if (k < 0 || k >= 1) return;
    const { size, cell } = geometry;
    const enter = easeOutCubic(Math.min(1, k * 4));
    const exit = k > 0.75 ? 1 - (k - 0.75) / 0.25 : 1;
    const color = banner.faction ? factionColor(banner.faction) : PALETTE.gold;
    const cy = size / 2;
    const band = cell * 1.25 * enter;
    ctx.save();
    ctx.globalAlpha = exit;
    const gradient = ctx.createLinearGradient(0, 0, size, 0);
    gradient.addColorStop(0, "rgba(2,6,14,0)");
    gradient.addColorStop(0.18, "rgba(2,6,14,0.78)");
    gradient.addColorStop(0.82, "rgba(2,6,14,0.78)");
    gradient.addColorStop(1, "rgba(2,6,14,0)");
    ctx.fillStyle = gradient;
    ctx.fillRect(0, cy - band / 2, size, band);
    ctx.fillStyle = withAlpha(color, 0.95);
    ctx.fillRect(size * 0.15, cy - band / 2, size * 0.7 * enter, Math.max(1.5, cell * 0.03));
    ctx.fillRect(size * 0.85 - size * 0.7 * enter, cy + band / 2 - Math.max(1.5, cell * 0.03), size * 0.7 * enter, Math.max(1.5, cell * 0.03));
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = `900 ${Math.round(cell * 0.46)}px "Trebuchet MS", "Arial Black", Arial, sans-serif`;
    ctx.shadowColor = color;
    ctx.shadowBlur = cell * 0.25;
    ctx.fillStyle = "#ffffff";
    ctx.fillText(banner.text, size / 2 + (1 - enter) * -cell, cy - cell * 0.12);
    ctx.shadowBlur = 0;
    if (banner.sub) {
      ctx.font = `700 ${Math.max(10, Math.round(cell * 0.2))}px "Trebuchet MS", Arial, sans-serif`;
      ctx.fillStyle = withAlpha(color, 0.95);
      ctx.fillText(banner.sub, size / 2, cy + cell * 0.32);
    }
    ctx.restore();
  }

  consumeEffects(game, presentation, cell) {
    if (!presentation) return;
    const clock = presentation.clockMs;
    for (const effect of presentation.effects) {
      if (this.consumed.has(effect.seq) || effect.t > clock) continue;
      this.consumed.add(effect.seq);
      if (clock - effect.t > 600) continue;
      const x = effect.col * cell + cell / 2;
      const y = effect.row * cell + cell / 2;
      const color = factionColor(effect.faction || "S");
      const p = this.particles;
      if (effect.type === "land") {
        p.add({ type: "ring", x, y: y + cell * 0.27, size: cell * 0.12, grow: cell * 1.3, life: 0.32, color, width: Math.max(1.5, cell * 0.03), layer: "ground" });
        p.burst(x, y + cell * 0.27, { count: 6, speed: cell * 1.2, color, life: 0.3, size: Math.max(1.2, cell * 0.03), drag: 6, layer: "ground" });
      } else if (effect.type === "node") {
        p.add({ type: "ring", x, y, size: cell * 0.2, grow: cell * 2.2, life: 0.55, color, width: Math.max(2, cell * 0.05) });
        p.add({ type: "glow", x, y, size: cell * 1.3, life: 0.4, color });
        for (let i = 0; i < 10; i += 1) {
          p.add({ type: "glow", x: x + (Math.random() - 0.5) * cell * 0.5, y: y + (Math.random() - 0.5) * cell * 0.3, vy: -cell * (1 + Math.random()), drag: 1.2, size: cell * 0.12, life: 0.7, color: PALETTE.gold });
        }
      } else if (effect.type === "destroyed") {
        p.burst(x, y, { count: 26, speed: cell * 5, color, life: 0.6, size: Math.max(1.5, cell * 0.045), drag: 3 });
        p.burst(x, y, { type: "shard", count: 12, speed: cell * 3.4, color: effect.faction === "S" ? "#d9c38a" : "#3a2350", life: 0.9, size: cell * 0.06, spin: 12, drag: 2.5, gravity: cell * 3 });
        p.burst(x, y, { type: "smoke", count: 8, speed: cell * 0.8, color: "#120a1a", life: 1.2, size: cell * 0.3, grow: cell * 0.4, drag: 1.5, layer: "ground" });
        p.add({ type: "ring", x, y, size: cell * 0.2, grow: cell * 3.2, life: 0.45, color: "#ffffff", width: Math.max(2, cell * 0.06) });
        p.add({ type: "glow", x, y, size: cell * 1.8, life: 0.35, color });
      } else if (effect.type === "clash") {
        p.burst(x, y, { count: 30, speed: cell * 6, color: "#ffffff", life: 0.45, size: Math.max(1.5, cell * 0.05), drag: 4 });
        p.burst(x, y, { count: 16, speed: cell * 4, color: PALETTE.solar, life: 0.4, size: Math.max(1.5, cell * 0.04), drag: 4 });
        p.burst(x, y, { count: 16, speed: cell * 4, color: PALETTE.void, life: 0.4, size: Math.max(1.5, cell * 0.04), drag: 4 });
        p.add({ type: "glow", x, y, size: cell * 2.4, life: 0.3, color: "#ffffff" });
        p.add({ type: "ring", x, y, size: cell * 0.1, grow: cell * 4, life: 0.35, color: PALETTE.gold, width: Math.max(2, cell * 0.06) });
      } else if (effect.type === "repair") {
        for (let i = 0; i < 12; i += 1) {
          p.add({ type: "glow", x: x + (Math.random() - 0.5) * cell * 0.6, y: y + cell * 0.2 - Math.random() * cell * 0.3, vy: -cell * (0.8 + Math.random() * 0.8), drag: 1.2, size: cell * 0.12, life: 0.8, color: PALETTE.heal });
        }
      } else if (effect.type === "weaken") {
        p.burst(x, y, { type: "shard", count: 14, speed: cell * 2, color: "#b8ff8a", life: 0.6, size: cell * 0.05, spin: 10, drag: 3 });
        p.add({ type: "ring", x, y, size: cell * 0.6, grow: -cell * 1.2, life: 0.4, color: PALETTE.void, width: Math.max(2, cell * 0.04) });
      } else if (effect.type === "lock") {
        p.add({ type: "ring", x, y, size: cell * 0.1, grow: cell * 2, life: 0.45, color, width: Math.max(2, cell * 0.05) });
        p.burst(x, y, { count: 14, speed: cell * 2.4, color, life: 0.45, size: Math.max(1.2, cell * 0.035), drag: 4 });
      } else if (effect.type === "teleportOut" || effect.type === "teleportIn") {
        p.add({ type: "glow", x, y, size: cell * 1.4, life: 0.35, color });
        for (let i = 0; i < 12; i += 1) {
          p.add({ type: "spark", x: x + (Math.random() - 0.5) * cell * 0.5, y: y + cell * 0.3, vy: -cell * (2 + Math.random() * 2), drag: 1, size: Math.max(1, cell * 0.03), life: 0.5, color });
        }
      }
    }
  }

  spawnAmbient(game, presentation, cell, dt, clock) {
    if (dt <= 0 || !presentation) return;
    for (const [id, tween] of presentation.tweens) {
      const unit = game.units.find((candidate) => candidate.id === id);
      if (!unit || clock >= tween.start + tween.duration || clock < tween.start) continue;
      if (Math.random() > dt * 45) continue;
      const position = unitTweenPosition(presentation, unit, clock);
      const color = factionColor(UNIT_DEFS[unit.type].faction);
      this.particles.add({
        type: "glow",
        x: position.col * cell + cell / 2 + (Math.random() - 0.5) * cell * 0.3,
        y: position.row * cell + cell * 0.72 + (Math.random() - 0.5) * cell * 0.1,
        size: cell * 0.16,
        life: 0.45,
        color,
        alpha: 0.7,
        layer: "ground",
      });
    }
    for (const unit of game.units) {
      if (!unit.alive || unit.hp / unit.maxHp >= 0.35 || Math.random() > dt * 2.2) continue;
      this.particles.add({
        type: "spark",
        x: unit.col * cell + cell / 2 + (Math.random() - 0.5) * cell * 0.35,
        y: unit.row * cell + cell * 0.35,
        vx: (Math.random() - 0.5) * cell * 1.2,
        vy: -cell * (0.6 + Math.random() * 0.8),
        gravity: cell * 3,
        drag: 1,
        size: Math.max(1, cell * 0.025),
        life: 0.45,
        color: "#ffb35c",
      });
    }
    for (const unit of game.units) {
      if (!unit.alive || unit.weakTurns <= 0 || Math.random() > dt * 3) continue;
      this.particles.add({
        type: "glow",
        x: unit.col * cell + cell / 2 + (Math.random() - 0.5) * cell * 0.4,
        y: unit.row * cell + cell * 0.6,
        vy: -cell * 0.5,
        drag: 0.5,
        size: cell * 0.09,
        life: 0.9,
        color: "#b8ff8a",
      });
    }
  }
}

function duelZoom(presentation, clock) {
  const pending = presentation?.pendingDuel;
  if (!pending || !pending.clashed) return null;
  const start = pending.clashAt + 80;
  const k = Math.max(0, Math.min(1, (clock - start) / Math.max(1, pending.at - start)));
  return k > 0 ? { k, row: pending.row, col: pending.col, energy: pending.energy } : null;
}

export function drawBrackets(ctx, cx, cy, half, arm) {
  ctx.lineCap = "round";
  for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
    const x = cx + sx * half;
    const y = cy + sy * half;
    ctx.beginPath();
    ctx.moveTo(x - sx * arm, y);
    ctx.lineTo(x, y);
    ctx.lineTo(x, y - sy * arm);
    ctx.stroke();
  }
}
