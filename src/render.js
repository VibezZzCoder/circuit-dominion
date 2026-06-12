// SPDX-License-Identifier: GPL-3.0-or-later
import { getUnitAt } from "./board.js";
import { UNIT_DEFS } from "./units.js";
import { ENERGY, POWER_NODES, clamp, energyLabel, unitFaction } from "./utils.js";

export class Renderer {
  constructor(boardCanvas, arenaCanvas, assets = null) {
    this.boardCanvas = boardCanvas;
    this.boardCtx = boardCanvas.getContext("2d");
    this.arenaCanvas = arenaCanvas;
    this.arenaCtx = arenaCanvas.getContext("2d");
    this.assets = assets;
  }

  resizeBoard() {
    const rect = this.boardCanvas.getBoundingClientRect();
    if (!rect.width || !rect.height) {
      return;
    }
    const dpr = window.devicePixelRatio || 1;
    this.boardCanvas.width = rect.width * dpr;
    this.boardCanvas.height = rect.height * dpr;
    this.boardCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  resizeArena() {
    const rect = this.arenaCanvas.getBoundingClientRect();
    if (!rect.width || !rect.height) {
      return;
    }
    const dpr = window.devicePixelRatio || 1;
    this.arenaCanvas.width = rect.width * dpr;
    this.arenaCanvas.height = rect.height * dpr;
    this.arenaCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  drawBoard(game) {
    const ctx = this.boardCtx;
    const canvas = this.boardCanvas;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    const cell = Math.min(width, height) / 9;

    ctx.clearRect(0, 0, width, height);
    ctx.save();

    const ox = (width - cell * 9) / 2;
    const oy = (height - cell * 9) / 2;
    ctx.translate(ox, oy);

    this.drawBoardBackground(ctx, game, cell);
    this.drawLegalMoves(ctx, game, cell);
    this.drawBoardActionTargets(ctx, game, cell);
    this.drawSelectedUnitFrame(ctx, game, cell);
    this.drawBoardUnits(ctx, game, cell);

    ctx.restore();
  }

  drawBoardBackground(ctx, game, cell) {
    const boardImage = this.assets?.getImage("background.board-grid");
    if (boardImage) {
      ctx.save();
      ctx.globalAlpha = 0.58;
      ctx.drawImage(boardImage, 0, 0, cell * 9, cell * 9);
      ctx.globalAlpha = 1;
      ctx.fillStyle = "#02081466";
      ctx.fillRect(0, 0, cell * 9, cell * 9);
      ctx.restore();
    }

    for (let row = 0; row < 9; row += 1) {
      for (let col = 0; col < 9; col += 1) {
        const square = game.board[row][col];
        const x = col * cell;
        const y = row * cell;

        const grad = ctx.createLinearGradient(x, y, x + cell, y + cell);
        if (square.energy === ENERGY.LIGHT) {
          grad.addColorStop(0, "#113345");
          grad.addColorStop(1, "#1aefff22");
        } else if (square.energy === ENERGY.DARK) {
          grad.addColorStop(0, "#1a0d27");
          grad.addColorStop(1, "#b43cff26");
        } else {
          grad.addColorStop(0, "#14202d");
          grad.addColorStop(1, "#11151c");
        }

        ctx.fillStyle = boardImage ? overlayTileFill(square.energy) : grad;
        ctx.fillRect(x, y, cell, cell);

        ctx.strokeStyle = "#ffffff18";
        ctx.strokeRect(x + 0.5, y + 0.5, cell - 1, cell - 1);

        if (square.energy !== ENERGY.NEUTRAL) {
          ctx.fillStyle = square.energy === ENERGY.LIGHT ? "#9effff88" : "#f0a0ff88";
          ctx.font = `${Math.max(10, cell * 0.16)}px Arial`;
          ctx.fillText(square.energy, x + 6, y + 16);
        }

        if (square.flux) {
          ctx.strokeStyle = square.lockFaction ? "#fff0a0dd" : "#ffdc6377";
          ctx.setLineDash([4, 4]);
          ctx.strokeRect(x + 5, y + 5, cell - 10, cell - 10);
          ctx.setLineDash([]);
          ctx.fillStyle = square.lockFaction ? "#fff0a0" : "#ffdc6399";
          ctx.font = `${Math.max(8, cell * 0.11)}px Arial`;
          ctx.fillText(square.lockFaction ? "LOCK" : "F", x + cell - cell * 0.28, y + 15);
        }

        if (square.node) {
          ctx.beginPath();
          ctx.arc(x + cell * 0.5, y + cell * 0.5, cell * 0.16, 0, Math.PI * 2);
          ctx.fillStyle = "#ffdc6344";
          ctx.fill();
          ctx.strokeStyle = "#ffdc63";
          ctx.stroke();
          ctx.fillStyle = "#fff0a0";
          ctx.font = `${cell * 0.26}px Arial`;
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillText("⚡", x + cell * 0.5, y + cell * 0.5);
          const occupant = getUnitAt(game, row, col);
          if (occupant) {
            ctx.strokeStyle = unitFaction(occupant, UNIT_DEFS) === "S" ? "#6dfcff" : "#d56bff";
            ctx.lineWidth = 3;
            ctx.beginPath();
            ctx.arc(x + cell * 0.5, y + cell * 0.5, cell * 0.21, 0, Math.PI * 2);
            ctx.stroke();
            ctx.lineWidth = 1;
          }
          ctx.textAlign = "left";
          ctx.textBaseline = "alphabetic";
        }
      }
    }
  }

  drawLegalMoves(ctx, game, cell) {
    if (!game.debug.showLegal) {
      return;
    }

    for (const move of game.legalMoves) {
      ctx.fillStyle = move.attack ? "#ff5f7a66" : "#7dff9655";
      ctx.beginPath();
      ctx.arc(move.col * cell + cell / 2, move.row * cell + cell / 2, cell * 0.31, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = move.attack ? "#ffb0bf" : "#baffc7";
      ctx.lineWidth = 2;
      ctx.stroke();
    }
  }

  drawBoardActionTargets(ctx, game, cell) {
    const action = game.boardAction;
    if (!action) {
      return;
    }
    if (action.type === "gridLock") {
      for (let row = 0; row < 9; row += 1) {
        for (let col = 0; col < 9; col += 1) {
          if (game.board[row][col].flux) {
            drawTargetRing(ctx, row, col, cell, "#ffdc6388", "#fff0a0");
          }
        }
      }
      return;
    }
    if (action.type === "fieldRepair" || (action.type === "emergencyRelay" && !action.sourceUnitId)) {
      for (const unit of game.units) {
        const def = UNIT_DEFS[unit.type];
        const validRepair =
          action.type === "fieldRepair" &&
          def.faction === game.turn &&
          !def.isCommandUnit &&
          unit.hp < unit.maxHp;
        const validRelay =
          action.type === "emergencyRelay" &&
          def.faction === game.turn &&
          !def.isCommandUnit;
        if (unit.alive && (validRepair || validRelay)) {
          drawTargetRing(ctx, unit.row, unit.col, cell, "#ffdc6388", "#fff0a0");
        }
      }
    }
  }

  drawSelectedUnitFrame(ctx, game, cell) {
    if (!game.selectedUnitId) {
      return;
    }

    const unit = game.units.find((u) => u.id === game.selectedUnitId);
    if (!unit || !unit.alive) {
      return;
    }

    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 3;
    ctx.shadowColor = "#ffffff";
    ctx.shadowBlur = 12;
    ctx.strokeRect(unit.col * cell + 3, unit.row * cell + 3, cell - 6, cell - 6);
    ctx.shadowBlur = 0;
  }

  drawBoardUnits(ctx, game, cell) {
    for (const unit of game.units) {
      if (!unit.alive) {
        continue;
      }
      this.drawUnitShape(ctx, unit, unit.col * cell + cell / 2, unit.row * cell + cell / 2, cell * 0.36, cell);
    }
  }

  drawUnitShape(ctx, unit, x, y, radius, cell) {
    const def = UNIT_DEFS[unit.type];
    const solar = def.faction === "S";
    const sprite = this.assets?.getUnitImage(unit.type);
    ctx.save();
    ctx.translate(x, y);

    if (sprite) {
      const size = cell * 0.86;
      ctx.shadowColor = solar ? "#6dfcff" : "#d56bff";
      ctx.shadowBlur = 10;
      ctx.drawImage(sprite, -size / 2, -size * 0.53, size, size);
      ctx.shadowBlur = 0;
      this.drawUnitStatus(ctx, unit, def, solar, radius, cell);
      ctx.restore();
      return;
    }

    ctx.shadowColor = solar ? "#6dfcff" : "#d56bff";
    ctx.shadowBlur = 12;
    ctx.fillStyle = solar ? "#102e3b" : "#241032";
    ctx.strokeStyle = solar ? "#6dfcff" : "#d56bff";
    ctx.lineWidth = 2;

    if (unit.type === "PS" || unit.type === "RC") {
      this.drawPolygon(ctx, radius, 5, Math.PI / 2);
    } else if (unit.type === "AS" || unit.type === "EC") {
      ctx.rotate(Math.PI / 4);
      ctx.fillRect(-radius * 0.8, -radius * 0.8, radius * 1.6, radius * 1.6);
      ctx.strokeRect(-radius * 0.8, -radius * 0.8, radius * 1.6, radius * 1.6);
      ctx.rotate(-Math.PI / 4);
    } else if (unit.type === "SD" || unit.type === "GB" || unit.type === "NW") {
      this.drawRoundRect(ctx, -radius, -radius * 0.72, radius * 2, radius * 1.44, 8);
      ctx.fill();
      ctx.stroke();
    } else if (unit.type === "PM" || unit.type === "CB" || unit.type === "GW") {
      ctx.beginPath();
      ctx.arc(0, 0, radius, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    } else {
      this.drawPolygon(ctx, radius, 6, Math.PI / 6);
    }

    this.drawUnitStatus(ctx, unit, def, solar, radius, cell);

    ctx.restore();
  }

  drawUnitStatus(ctx, unit, def, solar, radius, cell) {
    const healthWidth = radius * 1.8;
    const healthY = radius + 4;
    ctx.fillStyle = "#000d";
    ctx.fillRect(-healthWidth / 2, healthY, healthWidth, 4);
    ctx.fillStyle = solar ? "#7dff96" : "#ff7aa0";
    ctx.fillRect(-healthWidth / 2, healthY, healthWidth * Math.max(0, unit.hp / unit.maxHp), 4);

    ctx.fillStyle = "#e9fbff";
    ctx.font = `bold ${Math.max(10, cell * 0.16)}px Arial`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.shadowColor = "#000";
    ctx.shadowBlur = 4;
    ctx.fillText(def.visual.abbr, 0, radius * 0.08);
    ctx.shadowBlur = 0;

    if (unit.weakTurns > 0) {
      ctx.fillStyle = "#ffdc63";
      ctx.font = `${Math.max(9, cell * 0.13)}px Arial`;
      ctx.fillText("WEAK", 0, -radius - 7);
    }
  }

  drawCombat(game) {
    const combat = game.combat;
    const ctx = this.arenaCtx;
    const width = this.arenaCanvas.clientWidth;
    const height = this.arenaCanvas.clientHeight;

    ctx.clearRect(0, 0, width, height);
    const sx = width / 960;
    const sy = height / 520;

    ctx.save();
    ctx.scale(sx, sy);

    const arenaImage = this.assets?.getImage("background.combat-arena");
    if (arenaImage) {
      ctx.drawImage(arenaImage, 0, 0, 960, 520);
      ctx.fillStyle = "#02060c66";
      ctx.fillRect(0, 0, 960, 520);
    } else {
      const gradient = ctx.createLinearGradient(0, 0, 960, 520);
      gradient.addColorStop(0, combat?.energy === "L" ? "#0c3240" : combat?.energy === "D" ? "#210c30" : "#101924");
      gradient.addColorStop(1, "#02060c");
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, 960, 520);
    }

    ctx.strokeStyle = "#ffffff12";
    for (let x = 0; x < 960; x += 40) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, 520);
      ctx.stroke();
    }
    for (let y = 0; y < 520; y += 40) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(960, y);
      ctx.stroke();
    }

    if (combat) {
      for (const obstacle of combat.obstacles) {
        ctx.fillStyle = "#07111ddd";
        ctx.strokeStyle = combat.energy === "L" ? "#6dfcffaa" : combat.energy === "D" ? "#d56bffaa" : "#b9d4e6aa";
        ctx.lineWidth = 2;
        ctx.fillRect(obstacle.x, obstacle.y, obstacle.width, obstacle.height);
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

      for (const barrier of combat.barriers) {
        ctx.fillStyle = barrier.ownerSlot === 0 ? "#6dfcff33" : "#d56bff33";
        ctx.strokeStyle = barrier.ownerSlot === 0 ? "#6dfcff" : "#d56bff";
        ctx.lineWidth = 3;
        ctx.fillRect(barrier.x, barrier.y, barrier.width, barrier.height);
        ctx.strokeRect(barrier.x, barrier.y, barrier.width, barrier.height);
        ctx.fillStyle = "#e9fbffdd";
        ctx.font = "bold 9px Arial";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText("BARRIER", barrier.x + barrier.width / 2, barrier.y + barrier.height / 2);
      }

      for (const projectile of combat.projectiles) {
        ctx.strokeStyle = projectile.color;
        ctx.lineWidth = 3;
        ctx.globalAlpha = 0.45;
        ctx.beginPath();
        ctx.moveTo(projectile.x - projectile.vx * 0.04, projectile.y - projectile.vy * 0.04);
        ctx.lineTo(projectile.x, projectile.y);
        ctx.stroke();
        ctx.globalAlpha = 1;
        ctx.fillStyle = projectile.color;
        ctx.beginPath();
        ctx.arc(projectile.x, projectile.y, projectile.radius, 0, Math.PI * 2);
        ctx.fill();
      }

      for (const beam of combat.beams) {
        ctx.strokeStyle = beam.color;
        ctx.lineWidth = 6;
        ctx.shadowColor = beam.color;
        ctx.shadowBlur = 18;
        ctx.beginPath();
        ctx.moveTo(beam.from.x, beam.from.y);
        ctx.lineTo(beam.to.x, beam.to.y);
        ctx.stroke();
        ctx.shadowBlur = 0;
      }

      const now = performance.now();
      for (const fx of combat.effects) {
        const k = clamp((fx.until - now) / fx.life, 0, 1);
        ctx.globalAlpha = Math.max(0, k);
        ctx.strokeStyle = fx.color;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(fx.x, fx.y, Math.max(0, fx.radius * (1 - k + 0.2)), 0, Math.PI * 2);
        ctx.stroke();
        ctx.globalAlpha = 1;
      }

      for (const fighter of combat.fighters) {
        this.drawFighter(ctx, fighter, game.debug.showRanges);
      }
    }

    ctx.restore();
  }

  drawFighter(ctx, fighter, showRanges) {
    const def = UNIT_DEFS[fighter.unit.type];
    const solar = def.faction === "S";
    const now = performance.now();

    ctx.save();
    ctx.translate(fighter.x, fighter.y);
    if (fighter.invisUntil > now) {
      ctx.globalAlpha = 0.42;
    }

    const sprite = this.assets?.getUnitImage(fighter.unit.type);
    if (sprite) {
      const size = 78;
      ctx.shadowColor = solar ? "#6dfcff" : "#d56bff";
      ctx.shadowBlur = 18;
      ctx.drawImage(sprite, -size / 2, -size * 0.55, size, size);
      ctx.shadowBlur = 0;
      ctx.fillStyle = "#fff";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.font = "bold 13px Arial";
      ctx.shadowColor = "#000";
      ctx.shadowBlur = 4;
      ctx.fillText(def.visual.abbr, 0, 6);
      ctx.shadowBlur = 0;
    } else {
      ctx.shadowColor = solar ? "#6dfcff" : "#d56bff";
      ctx.shadowBlur = 18;
      ctx.fillStyle = solar ? "#11313e" : "#2b1038";
      ctx.strokeStyle = solar ? "#6dfcff" : "#d56bff";
      ctx.lineWidth = 3;

      if (fighter.unit.type === "SD" || fighter.unit.type === "GB" || fighter.unit.type === "NW") {
        this.drawRoundRect(ctx, -28, -20, 56, 40, 10);
        ctx.fill();
        ctx.stroke();
      } else if (def.attack.kind === "melee") {
        // Pentagon for all melee fighters to match the board-piece silhouette.
        this.drawPolygon(ctx, 26, 5, Math.PI / 2);
      } else {
        ctx.beginPath();
        ctx.arc(0, 0, 25, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }

      ctx.shadowBlur = 0;
      ctx.fillStyle = "#fff";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.font = "bold 15px Arial";
      ctx.fillText(def.visual.abbr, 0, 0);
    }

    ctx.strokeStyle = solar ? "#6dfcffcc" : "#d56bffcc";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(fighter.facingX * 18, fighter.facingY * 18);
    ctx.lineTo(fighter.facingX * 37, fighter.facingY * 37);
    ctx.stroke();

    if (fighter.state === "attackStartup" || fighter.state === "specialStartup") {
      ctx.strokeStyle = "#ffdc63cc";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(0, 0, 32, -Math.PI / 2, Math.PI * 1.5);
      ctx.stroke();
      this.drawActionTelegraph(ctx, fighter, def);
    }

    if (fighter.hurtUntil > now) {
      ctx.fillStyle = "#ff5f7a55";
      ctx.beginPath();
      ctx.arc(0, 0, 30, 0, Math.PI * 2);
      ctx.fill();
    }

    if (fighter.shieldUntil > now) {
      ctx.strokeStyle = "#fff";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(0, 0, 35, 0, Math.PI * 2);
      ctx.stroke();
    }

    if (fighter.auraUntil > now || fighter.pullUntil > now) {
      ctx.strokeStyle = solar ? "#6dfcff88" : "#d56bff88";
      ctx.beginPath();
      ctx.arc(0, 0, 60 + Math.sin(now / 90) * 5, 0, Math.PI * 2);
      ctx.stroke();
    }

    if (showRanges) {
      ctx.strokeStyle = "#ffffff33";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(0, 0, clamp(def.attack.range, 20, 520), 0, Math.PI * 2);
      ctx.stroke();
    }

    ctx.restore();
  }

  drawActionTelegraph(ctx, fighter, def) {
    const action = fighter.pendingAction;
    if (!action) {
      return;
    }
    const facingX = action.facingX;
    const facingY = action.facingY;
    if (action.kind === "attack") {
      const length = def.attack.kind === "melee" ? def.attack.range : Math.min(def.attack.range, 280);
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(facingX * length, facingY * length);
      ctx.stroke();
      return;
    }

    const special = def.special;
    if (special.kind === "radialBlast") {
      ctx.beginPath();
      ctx.arc(0, 0, special.radius, 0, Math.PI * 2);
      ctx.stroke();
      return;
    }
    if (special.kind === "gravityCone") {
      const angle = Math.atan2(facingY, facingX);
      const half = (special.arcDeg * Math.PI) / 360;
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.arc(0, 0, special.range, angle - half, angle + half);
      ctx.closePath();
      ctx.stroke();
      return;
    }
    const length =
      special.range ||
      special.distance ||
      (special.kind === "dash" ? 180 : def.attack.range);
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(facingX * Math.min(length, 760), facingY * Math.min(length, 760));
    ctx.stroke();
  }

  drawPolygon(ctx, radius, points, rotation) {
    ctx.beginPath();
    for (let i = 0; i < points; i += 1) {
      const a = rotation + (i * 2 * Math.PI) / points;
      ctx.lineTo(Math.cos(a) * radius, Math.sin(a) * radius);
    }
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  }

  drawRoundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  boardPointToCell(event) {
    const rect = this.boardCanvas.getBoundingClientRect();
    const width = this.boardCanvas.clientWidth;
    const height = this.boardCanvas.clientHeight;
    const cell = Math.min(width, height) / 9;
    const ox = (width - cell * 9) / 2;
    const oy = (height - cell * 9) / 2;
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

function drawTargetRing(ctx, row, col, cell, fill, stroke) {
  ctx.fillStyle = fill;
  ctx.strokeStyle = stroke;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(col * cell + cell / 2, row * cell + cell / 2, cell * 0.37, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.lineWidth = 1;
}

function overlayTileFill(energy) {
  if (energy === ENERGY.LIGHT) {
    return "#1aefff24";
  }
  if (energy === ENERGY.DARK) {
    return "#b43cff2c";
  }
  return "#07121d66";
}

function moveText(type) {
  if (type === "king") return "1 any direction";
  if (type === "runner") return "up to 3 any direction";
  if (type === "phase") return "up to 3, phases through one robot";
  if (type === "line") return "up to 4 any direction";
  if (type === "heavy") return "2 orthogonal or 1 diagonal";
  return "up to 2 orthogonal";
}
