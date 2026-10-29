// SPDX-License-Identifier: GPL-3.0-or-later
// Additional terms under GPL-3.0 section 7 apply; see NOTICE.md.
import { getUnitAt } from "./board.js";
import { BoardRenderer, boardGeometry } from "./board-render.js";
import { ArenaRenderer } from "./combat-render.js";
import { UNIT_DEFS } from "./units.js";
import { POWER_NODES, energyLabel, unitFaction } from "./utils.js";

export class Renderer {
  constructor(boardCanvas, arenaCanvas, assets = null) {
    this.boardCanvas = boardCanvas;
    this.boardCtx = boardCanvas.getContext("2d");
    this.arenaCanvas = arenaCanvas;
    this.arenaCtx = arenaCanvas.getContext("2d");
    this.assets = assets;
    this.board = new BoardRenderer(assets);
    this.arena = new ArenaRenderer(assets);
  }

  pixelRatio() {
    return typeof window !== "undefined" ? Math.min(2, window.devicePixelRatio || 1) : 1;
  }

  resizeBoard() {
    const rect = this.boardCanvas.getBoundingClientRect();
    if (!rect.width || !rect.height) {
      return;
    }
    const dpr = this.pixelRatio();
    const width = Math.round(rect.width * dpr);
    const height = Math.round(rect.height * dpr);
    if (this.boardCanvas.width === width && this.boardCanvas.height === height) return false;
    this.boardCanvas.width = width;
    this.boardCanvas.height = height;
    this.boardCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return true;
  }

  resizeArena() {
    const rect = this.arenaCanvas.getBoundingClientRect();
    if (!rect.width || !rect.height) {
      return;
    }
    const dpr = this.pixelRatio();
    const width = Math.round(rect.width * dpr);
    const height = Math.round(rect.height * dpr);
    if (this.arenaCanvas.width === width && this.arenaCanvas.height === height) return false;
    this.arenaCanvas.width = width;
    this.arenaCanvas.height = height;
    this.arenaCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return true;
  }

  arenaPoint(event) {
    const rect = this.arenaCanvas.getBoundingClientRect();
    const scale = Math.min(rect.width / 960, rect.height / 520);
    if (scale <= 0) return null;
    const x = (event.clientX - rect.left - (rect.width - 960 * scale) / 2) / scale;
    const y = (event.clientY - rect.top - (rect.height - 520 * scale) / 2) / scale;
    return x >= 0 && x <= 960 && y >= 0 && y <= 520 ? {x, y} : null;
  }

  drawBoard(game) {
    const canvas = this.boardCanvas;
    this.board.draw(this.boardCtx, game, game.presentation, canvas.clientWidth, canvas.clientHeight, this.pixelRatio());
  }

  drawCombat(game) {
    const combat = game.combat;
    const ctx = this.arenaCtx;
    const width = this.arenaCanvas.clientWidth;
    const height = this.arenaCanvas.clientHeight;

    ctx.clearRect(0, 0, width, height);
    if (!combat) return;
    const scale = Math.min(width / 960, height / 520);
    // A collapsed layout row gives a zero-size arena; draw again once it has room.
    if (!(scale > 0) || !Number.isFinite(scale)) return;
    const dpr = this.pixelRatio();

    const ox = (width - 960 * scale) / 2;
    const oy = (height - 520 * scale) / 2;
    ctx.save();
    ctx.translate(ox, oy);
    ctx.scale(scale, scale);
    // Letterbox space shows extended arena art; gameplay stays in 960x520.
    this.arena.draw(ctx, combat, game, {
      pixelScale: scale * dpr,
      bounds: { x: -ox / scale, y: -oy / scale, width: width / scale, height: height / scale },
      drawCover: (obstacle, energy) => this.drawCover(obstacle, energy),
    });
    ctx.restore();
  }

  drawCover(obstacle, energy) {
    const ctx = this.arenaCtx;
    const id = obstacle.width >= obstacle.height ? "environment.cover-horizontal" : "environment.cover-vertical";
    const sprite = this.assets?.getImage(id);
    const source = this.assets?.getAsset(id)?.sourceRect;
    ctx.save();
    ctx.fillStyle = "#07111ddd";
    ctx.strokeStyle = energy === "L" ? "#6dfcffaa" : energy === "D" ? "#d56bffaa" : "#b9d4e6aa";
    ctx.lineWidth = 2;
    ctx.fillRect(obstacle.x, obstacle.y, obstacle.width, obstacle.height);
    if (sprite && source) {
      // Crop transparent source padding, never expand the gameplay footprint.
      ctx.drawImage(sprite, source.x, source.y, source.width, source.height,
        obstacle.x, obstacle.y, obstacle.width, obstacle.height);
      ctx.lineWidth = 1;
      ctx.strokeRect(obstacle.x + 0.5, obstacle.y + 0.5, obstacle.width - 1, obstacle.height - 1);
    } else {
      // Readable cover remains available while optional art loads or fails.
      ctx.strokeRect(obstacle.x, obstacle.y, obstacle.width, obstacle.height);
      ctx.save();
      ctx.beginPath();
      ctx.rect(obstacle.x, obstacle.y, obstacle.width, obstacle.height);
      ctx.clip();
      ctx.globalAlpha = 0.28;
      ctx.lineWidth = 1;
      for (let offset = -obstacle.height; offset < obstacle.width + obstacle.height; offset += 12) {
        ctx.beginPath();
        ctx.moveTo(obstacle.x + offset, obstacle.y + obstacle.height);
        ctx.lineTo(obstacle.x + offset + obstacle.height, obstacle.y);
        ctx.stroke();
      }
      ctx.restore();
      ctx.fillStyle = "#e9fbffcc";
      ctx.font = "bold 10px Arial";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("COVER", obstacle.x + obstacle.width / 2, obstacle.y + obstacle.height / 2);
    }
    ctx.restore();
  }

  boardGeometry() {
    return boardGeometry(this.boardCanvas.clientWidth, this.boardCanvas.clientHeight);
  }

  boardPointToCell(event) {
    const rect = this.boardCanvas.getBoundingClientRect();
    const { cell, ox, oy } = this.boardGeometry();
    const col = Math.floor((event.clientX - rect.left - ox) / cell);
    const row = Math.floor((event.clientY - rect.top - oy) / cell);
    return { row, col };
  }

  buildPowerNodeInfo(game) {
    return POWER_NODES.map(([row, col], idx) => {
      const unit = getUnitAt(game, row, col);
      const owner = unit ? unitFaction(unit, UNIT_DEFS) : "-";
      return `⚡${idx + 1} ${owner === "S" ? "Solar" : owner === "V" ? "Void" : "Open"}`;
    });
  }

  buildSelectedInfo(game) {
    const unit = game.units.find((u) => u.id === game.selectedUnitId && u.alive);
    if (!unit) {
      return "Select one of your robots.";
    }
    const def = UNIT_DEFS[unit.type];
    const energy = game.board[unit.row][unit.col].energy;
    return `${def.name} (${def.visual.abbr})\n${def.faction === "S" ? "Solar" : "Void"} · ${def.alignment} align · HP ${Math.max(0, Math.ceil(unit.hp))}/${def.maxHp}\nMove: ${moveText(def.boardMovement.type)}\nAttack ${def.attack.damage} · ${def.attack.kind === "melee" ? "Melee" : "Ranged"} · CD ${def.attack.cooldown}s\nSpecial: ${def.special.name}\nSquare: ${energyLabel(energy)}${game.board[unit.row][unit.col].flux ? " · Flux" : ""}${unit.type === "PM" ? "\nAbility: click adjacent ally to repair." : ""}${unit.type === "CB" ? "\nAbility: click adjacent enemy to weaken." : ""}`;
  }
}

function moveText(type) {
  if (type === "king") return "1 any direction";
  if (type === "runner") return "up to 3 any direction";
  if (type === "phase") return "up to 3, phases through one robot";
  if (type === "line") return "up to 4 any direction";
  if (type === "heavy") return "2 orthogonal or 1 diagonal";
  return "up to 2 orthogonal";
}
