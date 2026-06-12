// SPDX-License-Identifier: GPL-3.0-or-later
import {
  canUseCommandPower,
  getLivingFactionUnits,
  getPowerNodeControl,
  getUnitAt,
  legalMovesForUnit,
  relayDestinationsForUnit,
} from "./board.js";
import { UNIT_DEFS } from "./units.js";
import {
  DIFFICULTY_SETTINGS,
  ENERGY,
  FACTIONS,
  POWER_NODES,
  dist2d,
  enemyFaction,
  factionEnergy,
  normalizeDifficulty,
  unitFaction,
} from "./utils.js";

function isPowerNode(row, col) {
  return POWER_NODES.some(([nodeRow, nodeCol]) => nodeRow === row && nodeCol === col);
}

function manhattan(a, b) {
  return Math.abs(a.row - b.row) + Math.abs(a.col - b.col);
}

function nearestNodeDistance(row, col) {
  return Math.min(
    ...POWER_NODES.map(([nodeRow, nodeCol]) => Math.abs(row - nodeRow) + Math.abs(col - nodeCol)),
  );
}

export function estimateDuelOdds(attacker, defender, energy) {
  const attackerDef = UNIT_DEFS[attacker.type];
  const defenderDef = UNIT_DEFS[defender.type];
  const attackerAligned = factionEnergy(attackerDef.faction) === energy;
  const defenderAligned = factionEnergy(defenderDef.faction) === energy;
  const attackerHpModifier = attackerAligned ? 1.08 : 1;
  const defenderHpModifier = defenderAligned ? 1.08 : 1;
  const attackerDamageModifier = attackerAligned ? 1.08 : energy === ENERGY.NEUTRAL ? 1 : 0.94;
  const defenderDamageModifier = defenderAligned ? 1.08 : energy === ENERGY.NEUTRAL ? 1 : 0.94;
  const attackerDps = attackerDef.attack.damage / attackerDef.attack.cooldown;
  const defenderDps = defenderDef.attack.damage / defenderDef.attack.cooldown;
  const attackerRangeValue = Math.min(attackerDef.attack.range, 520) / 520;
  const defenderRangeValue = Math.min(defenderDef.attack.range, 520) / 520;
  const attackerScore =
    attacker.hp * attackerHpModifier *
    (attackerDps * attackerDamageModifier) *
    (1 + attackerDef.speed / 900 + attackerRangeValue * 0.18);
  const defenderScore =
    defender.hp * defenderHpModifier *
    (defenderDps * defenderDamageModifier) *
    (1 + defenderDef.speed / 900 + defenderRangeValue * 0.18);
  return attackerScore / Math.max(1, attackerScore + defenderScore);
}

function projectedNodeCount(game, unit, move, faction) {
  let count = 0;
  for (const [row, col] of POWER_NODES) {
    let occupant = getUnitAt(game, row, col);
    if (unit.row === row && unit.col === col) {
      occupant = null;
    }
    if (move.row === row && move.col === col) {
      occupant = unit;
    }
    if (occupant && unitFaction(occupant, UNIT_DEFS) === faction) {
      count += 1;
    }
  }
  return count;
}

function cloneGameForSearch(game, turn = game.turn) {
  return {
    ...game,
    turn,
    units: game.units.map((unit) => ({
      ...unit,
      recentSquares: [...(unit.recentSquares || [])],
    })),
  };
}

function moveProjectedUnit(unit, row, col) {
  const previousKey = `${unit.row},${unit.col}`;
  unit.previousRow = unit.row;
  unit.previousCol = unit.col;
  unit.recentSquares = [...(unit.recentSquares || []), previousKey].slice(-4);
  unit.row = row;
  unit.col = col;
}

function projectBoardMove(game, unitId, move) {
  const projected = cloneGameForSearch(game);
  const actor = projected.units.find((unit) => unit.id === unitId && unit.alive);
  if (!actor) {
    return projected;
  }

  const target = getUnitAt(projected, move.row, move.col);
  if (target && target.id !== actor.id) {
    const odds = estimateDuelOdds(actor, target, projected.board[move.row][move.col].energy);
    if (odds >= 0.5) {
      target.alive = false;
      moveProjectedUnit(actor, move.row, move.col);
    } else {
      actor.alive = false;
    }
    projected.units = projected.units.filter((unit) => unit.alive);
  } else {
    moveProjectedUnit(actor, move.row, move.col);
  }
  projected.turn = enemyFaction(game.turn);
  return projected;
}

function scoreImmediateMoveThreat(game, unit, move, faction) {
  const opponent = enemyFaction(faction);
  const square = game.board[move.row][move.col];
  const control = getPowerNodeControl(game);
  let score = 0;

  if (isPowerNode(move.row, move.col)) {
    score += 8;
    const projected = projectedNodeCount(game, unit, move, faction);
    if (projected === POWER_NODES.length) {
      score += 5000;
    } else if (projected === POWER_NODES.length - 1) {
      score += 75;
    }
  }

  if (control[opponent] === POWER_NODES.length - 1) {
    const target = getUnitAt(game, move.row, move.col);
    if (
      target &&
      isPowerNode(move.row, move.col) &&
      unitFaction(target, UNIT_DEFS) === opponent
    ) {
      score += 900;
    }
  }

  if (move.attack) {
    const target = getUnitAt(game, move.row, move.col);
    if (target) {
      const targetDef = UNIT_DEFS[target.type];
      const odds = estimateDuelOdds(unit, target, square.energy);
      if (targetDef.isCommandUnit) {
        score += 2500 + odds * 7500;
      } else {
        score += Math.max(0, (odds - 0.45) * 90);
        score += (1 - target.hp / target.maxHp) * 15;
        if (isPowerNode(target.row, target.col)) {
          score += 24;
        }
      }
    }
  }
  return Math.max(0, score);
}

function collectImmediateReplies(game, faction) {
  const searchGame = cloneGameForSearch(game, faction);
  const replies = [];
  for (const unit of getLivingFactionUnits(searchGame, faction)) {
    for (const move of legalMovesForUnit(searchGame, unit)) {
      replies.push({
        unitId: unit.id,
        move,
        score: scoreImmediateMoveThreat(searchGame, unit, move, faction),
      });
    }
  }
  replies.sort((a, b) => b.score - a.score);
  return replies;
}

function opponentReplyPenalty(game, unit, move, settings) {
  if (settings.replyDepth <= 0) {
    return 0;
  }

  const faction = unitFaction(unit, UNIT_DEFS);
  const opponent = enemyFaction(faction);
  const projected = projectBoardMove(game, unit.id, move);
  const replies = collectImmediateReplies(projected, opponent);
  if (!replies.length) {
    return 0;
  }

  if (settings.replyDepth === 1) {
    return replies[0].score * 0.46;
  }

  let worstNetThreat = 0;
  for (const reply of replies.slice(0, 3)) {
    const afterReply = projectBoardMove(
      cloneGameForSearch(projected, opponent),
      reply.unitId,
      reply.move,
    );
    const counters = collectImmediateReplies(afterReply, faction);
    const bestCounter = counters[0]?.score || 0;
    worstNetThreat = Math.max(worstNetThreat, reply.score - bestCounter * 0.42);
  }
  return Math.max(0, worstNetThreat) * 0.56;
}

function scoreBoardMove(game, unit, move, settings, rng) {
  const faction = unitFaction(unit, UNIT_DEFS);
  const opponent = enemyFaction(faction);
  const def = UNIT_DEFS[unit.type];
  const square = game.board[move.row][move.col];
  const control = getPowerNodeControl(game);
  let score = rng() * (settings.id === "easy" ? 8 : settings.id === "standard" ? 2.5 : 0.8);

  const aligned = square.energy === factionEnergy(faction);
  const hostile = square.energy !== ENERGY.NEUTRAL && !aligned;
  score += aligned ? 8 : hostile ? -5 : 1;
  score += Math.max(0, 7 - nearestNodeDistance(move.row, move.col)) * 1.65;
  if (move.row === unit.previousRow && move.col === unit.previousCol) {
    score -= 24;
  }
  const destinationKey = `${move.row},${move.col}`;
  const recentIndex = (unit.recentSquares || []).lastIndexOf(destinationKey);
  if (recentIndex >= 0) {
    const recency = (unit.recentSquares.length || 0) - recentIndex;
    score -= Math.max(8, 22 - recency * 3);
  }

  if (isPowerNode(move.row, move.col)) {
    score += 34;
    const projected = projectedNodeCount(game, unit, move, faction);
    if (projected === POWER_NODES.length) {
      score += 5000;
    } else if (projected === POWER_NODES.length - 1) {
      score += 80;
    }
  }

  if (control[opponent] === POWER_NODES.length - 1) {
    const target = getUnitAt(game, move.row, move.col);
    if (
      isPowerNode(move.row, move.col) &&
      target &&
      unitFaction(target, UNIT_DEFS) === opponent
    ) {
      score += 900;
    }
  }

  const ownCommand = getLivingFactionUnits(game, faction).find(
    (candidate) => UNIT_DEFS[candidate.type].isCommandUnit,
  );
  if (def.isCommandUnit && ownCommand) {
    const home = faction === FACTIONS.VOID ? { row: 0, col: 4 } : { row: 8, col: 4 };
    score -= Math.max(0, manhattan(move, home) - 2) * 11;
  }

  const enemyCommand = getLivingFactionUnits(game, opponent).find(
    (candidate) => UNIT_DEFS[candidate.type].isCommandUnit,
  );
  if (enemyCommand) {
    score += Math.max(0, 12 - manhattan(move, enemyCommand)) * 1.6;
  }

  if (move.attack) {
    const target = getUnitAt(game, move.row, move.col);
    if (target) {
      const targetDef = UNIT_DEFS[target.type];
      const odds = estimateDuelOdds(unit, target, square.energy);
      score += targetDef.isCommandUnit ? 10000 : 50;
      score += (odds - 0.5) * 80;
      score += (1 - target.hp / target.maxHp) * 20;
      if (odds < 0.32 && !targetDef.isCommandUnit) {
        score -= 45;
      }
    }
  }

  if (settings.replyDepth > 0) {
    score -= opponentReplyPenalty(game, unit, move, settings);
  }

  return score;
}

function commandActionCandidates(game, faction) {
  const candidates = [];
  if (canUseCommandPower(game, faction, "fieldRepair")) {
    for (const unit of getLivingFactionUnits(game, faction)) {
      const def = UNIT_DEFS[unit.type];
      if (!def.isCommandUnit && unit.hp < unit.maxHp * 0.8) {
        candidates.push({
          kind: "command",
          power: "fieldRepair",
          targetId: unit.id,
          score: 35 + (1 - unit.hp / unit.maxHp) * 55,
        });
      }
    }
  }

  if (canUseCommandPower(game, faction, "gridLock")) {
    for (let row = 0; row < game.board.length; row += 1) {
      for (let col = 0; col < game.board[row].length; col += 1) {
        const square = game.board[row][col];
        if (!square.flux || square.energy === factionEnergy(faction)) {
          continue;
        }
        const occupant = getUnitAt(game, row, col);
        const nodeValue = square.node ? 22 : 0;
        const occupantValue = occupant && unitFaction(occupant, UNIT_DEFS) === faction ? 18 : 0;
        if (nodeValue || occupantValue) {
          candidates.push({
            kind: "command",
            power: "gridLock",
            row,
            col,
            score: 26 + nodeValue + occupantValue,
          });
        }
      }
    }
  }

  if (canUseCommandPower(game, faction, "emergencyRelay")) {
    for (const unit of getLivingFactionUnits(game, faction)) {
      if (UNIT_DEFS[unit.type].isCommandUnit) {
        continue;
      }
      const before = nearestNodeDistance(unit.row, unit.col);
      for (const destination of relayDestinationsForUnit(game, unit)) {
        const after = nearestNodeDistance(destination.row, destination.col);
        if (after < before) {
          candidates.push({
            kind: "command",
            power: "emergencyRelay",
            unitId: unit.id,
            row: destination.row,
            col: destination.col,
            score: 18 + (before - after) * 7,
          });
        }
      }
    }
  }
  return candidates;
}

function supportActionCandidates(game, faction) {
  const candidates = [];
  for (const unit of getLivingFactionUnits(game, faction)) {
    if (unit.type === "CB") {
      for (const target of getLivingFactionUnits(game, enemyFaction(faction))) {
        if (Math.max(Math.abs(unit.row - target.row), Math.abs(unit.col - target.col)) === 1) {
          candidates.push({
            kind: "ability",
            unitId: unit.id,
            targetId: target.id,
            score: 70 + (UNIT_DEFS[target.type].isCommandUnit ? 120 : 0) + target.hp / 12,
          });
        }
      }
    }
    if (unit.type === "PM") {
      for (const target of getLivingFactionUnits(game, faction)) {
        if (
          target.hp < target.maxHp &&
          Math.max(Math.abs(unit.row - target.row), Math.abs(unit.col - target.col)) === 1
        ) {
          candidates.push({
            kind: "ability",
            unitId: unit.id,
            targetId: target.id,
            score: 50 + (1 - target.hp / target.maxHp) * 65,
          });
        }
      }
    }
  }
  return candidates;
}

export function chooseBoardAiAction(game, rng = Math.random) {
  const difficulty = normalizeDifficulty(game.difficulty);
  const settings = DIFFICULTY_SETTINGS[difficulty];
  const faction = game.turn;
  const candidates = [
    ...commandActionCandidates(game, faction),
    ...supportActionCandidates(game, faction),
  ];

  for (const unit of getLivingFactionUnits(game, faction)) {
    for (const move of legalMovesForUnit(game, unit)) {
      candidates.push({
        kind: "move",
        unitId: unit.id,
        move,
        score: scoreBoardMove(game, unit, move, settings, rng),
      });
    }
  }

  candidates.sort((a, b) => b.score - a.score);
  if (!candidates.length) {
    return null;
  }

  const poolSize = Math.min(settings.boardCandidates, candidates.length);
  const choice = candidates[Math.floor(rng() * poolSize)];
  game.debug.lastAiDecision = `${choice.kind}:${choice.power || choice.unitId || "n/a"} score=${choice.score.toFixed(2)}`;
  return choice;
}

export function chooseBoardAiMove(game, rng = Math.random) {
  const action = chooseBoardAiAction(game, rng);
  return action?.kind === "move" ? action : null;
}

function projectileDanger(fighter, combat) {
  return combat.projectiles.some((projectile) => {
    if (projectile.ownerId === fighter.id) {
      return false;
    }
    const distance = Math.hypot(projectile.x - fighter.x, projectile.y - fighter.y);
    return distance < 125;
  });
}

function shouldUseSpecial(fighter, opponent, combat, settings, distance, danger, rng) {
  if (fighter.specialCooldown > 0 || fighter.pendingAction) {
    return false;
  }
  const special = UNIT_DEFS[fighter.unit.type].special;
  let useful = false;
  if (special.kind === "shield") useful = fighter.hp < fighter.maxHp * 0.72 || danger;
  if (special.kind === "dash") useful = distance > 75 && distance < 260;
  if (special.kind === "chargedProjectile") useful = distance > 170;
  if (special.kind === "barrier") useful = danger || distance > 230;
  if (special.kind === "repairBurst") useful = fighter.hp < fighter.maxHp * 0.8;
  if (special.kind === "radialBlast") useful = distance < special.radius * 0.9;
  if (special.kind === "aura") useful = distance < special.radius * 1.2;
  if (special.kind === "heavyProjectile") useful = distance > 120;
  if (special.kind === "blink") useful = danger || fighter.hp < fighter.maxHp * 0.48;
  if (special.kind === "spread") useful = distance < 390;
  if (special.kind === "gravityCone") useful = distance < special.range;
  return useful && rng() < settings.specialBias;
}

export function getDuelAiIntent(
  fighter,
  opponent,
  combat,
  nowMs = performance.now(),
  difficulty = combat.difficulty || "standard",
  rng = Math.random,
) {
  const settings = DIFFICULTY_SETTINGS[normalizeDifficulty(difficulty)];
  if (fighter.aiIntent && nowMs < fighter.aiNextDecisionAt) {
    return fighter.aiIntent;
  }

  const def = UNIT_DEFS[fighter.unit.type];
  const dx = opponent.x - fighter.x;
  const dy = opponent.y - fighter.y;
  const distance = Math.max(1, dist2d(fighter, opponent));
  const baseAngle = Math.atan2(dy, dx);
  const aimAngle = baseAngle + (rng() - 0.5) * settings.aimErrorRad * 2;
  const aimX = Math.cos(aimAngle);
  const aimY = Math.sin(aimAngle);
  const danger = projectileDanger(fighter, combat);
  const useSpecial = shouldUseSpecial(fighter, opponent, combat, settings, distance, danger, rng);
  const melee = def.attack.kind === "melee";
  const inAttackRange = melee
    ? distance <= def.attack.range + opponent.radius + 12
    : distance <= def.attack.range;
  const useAttack = !useSpecial && fighter.attackCooldown <= 0 && inAttackRange;

  let moveX = aimX;
  let moveY = aimY;
  if (danger && !useAttack && !useSpecial) {
    moveX = -aimY * (fighter.slot ? -1 : 1);
    moveY = aimX * (fighter.slot ? -1 : 1);
  } else if (!melee && !useAttack && !useSpecial) {
    const preferred = Math.min(350, def.attack.range * 0.7);
    if (distance < preferred * 0.65) {
      moveX = -aimX;
      moveY = -aimY;
    } else if (distance <= preferred * 1.15) {
      const direction = fighter.slot ? -1 : 1;
      moveX = -aimY * direction * 0.75 + aimX * 0.2;
      moveY = aimX * direction * 0.75 + aimY * 0.2;
    }
  } else if (melee && distance < def.attack.range * 0.62 && !useAttack && !useSpecial) {
    moveX *= 0.2;
    moveY *= 0.2;
  }

  fighter.aiIntent = { moveX, moveY, useAttack, useSpecial };
  fighter.aiNextDecisionAt = nowMs + settings.reactionMs;
  return fighter.aiIntent;
}
