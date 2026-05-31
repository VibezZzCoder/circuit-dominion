// SPDX-License-Identifier: GPL-3.0-or-later
import { legalMovesForUnit, getUnitAt } from "./board.js";
import { UNIT_DEFS } from "./units.js";
import { FACTIONS, POWER_NODES, dist2d, unitFaction } from "./utils.js";

export function chooseBoardAiMove(game) {
  const units = game.units.filter((unit) => unit.alive && unitFaction(unit, UNIT_DEFS) === FACTIONS.VOID);
  let best = null;
  let bestScore = -Infinity;

  for (const unit of units) {
    const moves = legalMovesForUnit(game, unit);
    for (const move of moves) {
      // scoreBoardMove already adds Math.random() * 4 jitter for variety, so we
      // always keep the highest-scoring move and never discard a clear capture.
      const score = scoreBoardMove(game, unit, move);
      if (score > bestScore) {
        best = { unitId: unit.id, move, score };
        bestScore = score;
      }
    }
  }

  if (best) {
    game.debug.lastAiDecision = `${UNIT_DEFS[best.unitId?.slice(0, 2)]?.name || "Void"} -> (${best.move.row},${best.move.col}) score=${best.score.toFixed(2)}`;
  }

  return best;
}

function scoreBoardMove(game, unit, move) {
  const def = UNIT_DEFS[unit.type];
  const sq = game.board[move.row][move.col];
  let score = Math.random() * 4;

  if (sq.energy === "D") {
    score += 7;
  }
  if (sq.energy === "L") {
    score -= 4;
  }

  if (POWER_NODES.some(([r, c]) => r === move.row && c === move.col)) {
    score += 24;
  }

  const ownCommand = game.units.find((u) => u.alive && u.type === "NO");
  if (def.isCommandUnit && ownCommand) {
    const commandDist = Math.abs(move.row - ownCommand.row) + Math.abs(move.col - ownCommand.col);
    if (commandDist > 2) {
      score -= 9;
    }
  }

  const enemyCommand = game.units.find((u) => u.alive && u.type === "CC");
  if (enemyCommand) {
    const d = Math.abs(move.row - enemyCommand.row) + Math.abs(move.col - enemyCommand.col);
    score += (12 - d) * 0.85;
  }

  if (move.attack) {
    const target = getUnitAt(game, move.row, move.col);
    if (target) {
      const targetDef = UNIT_DEFS[target.type];
      score += targetDef.isCommandUnit ? 999 : 35;
      score += (unit.hp * def.attackDamage * def.attackRange) / 1000;
      score -= (target.hp * targetDef.attackDamage * targetDef.attackRange) / 1200;
      if (sq.energy === "D") {
        score += 8;
      }
      if (sq.energy === "L") {
        score -= 8;
      }
    }
  }

  return score;
}

export function getDuelAiIntent(fighter, opponent, combat) {
  const def = UNIT_DEFS[fighter.unit.type];
  const range = def.attackRange;
  const angle = Math.atan2(opponent.y - fighter.y, opponent.x - fighter.x);
  const d = dist2d(fighter, opponent);

  let moveX = 0;
  let moveY = 0;

  if (range < 130) {
    moveX = Math.cos(angle);
    moveY = Math.sin(angle);
    if (d < range * 0.85) {
      moveX *= 0.25;
      moveY *= 0.25;
    }
  } else {
    if (d < 170) {
      moveX = -Math.cos(angle);
      moveY = -Math.sin(angle);
    } else if (d > 360) {
      moveX = Math.cos(angle);
      moveY = Math.sin(angle);
    }
    moveX += Math.sin(performance.now() / 530 + fighter.slot) * 0.4;
    moveY += Math.cos(performance.now() / 670 + fighter.slot) * 0.32;
  }

  for (const projectile of combat.projectiles) {
    if (projectile.ownerId === fighter.id) {
      continue;
    }
    if (Math.hypot(projectile.x - fighter.x, projectile.y - fighter.y) < 92) {
      moveX += -projectile.vy * 0.003;
      moveY += projectile.vx * 0.003;
    }
  }

  const useAttack = Math.random() < 0.08 && ((range < 130 && d < range * 1.35) || range >= 130);
  const useSpecial = Math.random() < 0.013;

  return { moveX, moveY, useAttack, useSpecial };
}
