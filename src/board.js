// SPDX-License-Identifier: GPL-3.0-or-later
import { setBoardTurnState } from "./state.js";
import { INITIAL_SOLAR_ROW, INITIAL_VOID_ROW, UNIT_DEFS } from "./units.js";
import {
  ENERGY,
  ENERGY_ORDER,
  FACTIONS,
  POWER_NODES,
  clamp,
  enemyFaction,
  inBounds,
  randId,
  unitFaction,
} from "./utils.js";

export function createBoardGrid() {
  const board = [];
  for (let row = 0; row < 9; row += 1) {
    board[row] = [];
    for (let col = 0; col < 9; col += 1) {
      let energy = ENERGY.NEUTRAL;
      if (row < 3 && ((row + col) % 2 || col === 4)) {
        energy = ENERGY.DARK;
      }
      if (row > 5 && ((row + col) % 2 || col === 4)) {
        energy = ENERGY.LIGHT;
      }
      if ((row === 4 || col === 4) && (row + col) % 2 === 0) {
        energy = ENERGY.NEUTRAL;
      }
      board[row][col] = {
        energy,
        baseEnergy: energy,
        shift: (row * 7 + col * 5) % 8 === 0,
        node: false,
      };
    }
  }

  POWER_NODES.forEach(([row, col]) => {
    board[row][col].node = true;
  });

  return board;
}

function createUnit(type, row, col) {
  const def = UNIT_DEFS[type];
  return {
    id: randId(type),
    type,
    row,
    col,
    hp: def.maxHp,
    maxHp: def.maxHp,
    weakTurns: 0,
    alive: true,
    lastAbilityTurn: -1,
  };
}

export function spawnInitialUnits(game) {
  game.units = [];
  INITIAL_VOID_ROW.forEach((type, col) => {
    game.units.push(createUnit(type, 0, col));
  });
  INITIAL_SOLAR_ROW.forEach((type, col) => {
    game.units.push(createUnit(type, 8, col));
  });
}

export function getUnitById(game, unitId) {
  return game.units.find((unit) => unit.id === unitId && unit.alive);
}

export function getUnitAt(game, row, col) {
  return game.units.find((unit) => unit.alive && unit.row === row && unit.col === col);
}

export function getLivingFactionUnits(game, faction) {
  return game.units.filter((unit) => unit.alive && unitFaction(unit, UNIT_DEFS) === faction);
}

export function canSelectUnit(game, unit) {
  if (!unit || !unit.alive) {
    return false;
  }
  const faction = unitFaction(unit, UNIT_DEFS);
  if (faction !== game.turn) {
    return false;
  }
  if (game.mode === "ai" && game.turn === FACTIONS.VOID) {
    return false;
  }
  return true;
}

function dirsForPattern(pattern) {
  const d8 = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
    [1, 1],
    [1, -1],
    [-1, 1],
    [-1, -1],
  ];
  const d4 = d8.slice(0, 4);
  if (pattern === "ortho") {
    return d4;
  }
  return d8;
}

export function legalMovesForUnit(game, unit) {
  if (!unit || !unit.alive) {
    return [];
  }

  const def = UNIT_DEFS[unit.type];
  const pattern = def.boardMovement.type;
  let directions = pattern === "line" ? dirsForPattern("all") : dirsForPattern(pattern);
  let maxSteps = def.boardMovement.maxSteps;
  const canPhase = pattern === "phase";

  if (pattern === "king") {
    maxSteps = 1;
  }

  if (pattern === "heavy") {
    directions = dirsForPattern("ortho");
    maxSteps = 2;
  }

  const moves = [];
  for (const [dr, dc] of directions) {
    let phasedOnce = false;
    for (let step = 1; step <= maxSteps; step += 1) {
      const row = unit.row + dr * step;
      const col = unit.col + dc * step;
      if (!inBounds(row, col, 9)) {
        break;
      }
      const occupant = getUnitAt(game, row, col);
      if (occupant) {
        if (unitFaction(occupant, UNIT_DEFS) !== unitFaction(unit, UNIT_DEFS)) {
          moves.push({ row, col, attack: true, targetId: occupant.id });
        }
        if (canPhase && !phasedOnce) {
          phasedOnce = true;
          continue;
        }
        break;
      }
      moves.push({ row, col, attack: false });
    }
  }

  if (pattern === "heavy") {
    const diagonals = [
      [1, 1],
      [1, -1],
      [-1, 1],
      [-1, -1],
    ];
    for (const [dr, dc] of diagonals) {
      const row = unit.row + dr;
      const col = unit.col + dc;
      if (!inBounds(row, col, 9)) {
        continue;
      }
      const occupant = getUnitAt(game, row, col);
      if (!occupant) {
        moves.push({ row, col, attack: false });
      } else if (unitFaction(occupant, UNIT_DEFS) !== unitFaction(unit, UNIT_DEFS)) {
        moves.push({ row, col, attack: true, targetId: occupant.id });
      }
    }
  }

  return moves;
}

function adjacent(a, b) {
  return Math.max(Math.abs(a.row - b.row), Math.abs(a.col - b.col)) === 1;
}

export function tryBoardAbility(game, actor, target) {
  if (!actor || !target || !actor.alive || !target.alive) {
    return { applied: false };
  }
  if (!adjacent(actor, target)) {
    return { applied: false };
  }
  if (actor.lastAbilityTurn === game.turnCount) {
    return { applied: false, reason: "Ability already used this turn." };
  }

  const actorDef = UNIT_DEFS[actor.type];
  const targetDef = UNIT_DEFS[target.type];
  if (actor.type === "PM" && targetDef.faction === actorDef.faction && target.hp < target.maxHp) {
    target.hp = clamp(target.hp + 18, 0, target.maxHp);
    actor.lastAbilityTurn = game.turnCount;
    setBoardTurnState(game, "applyingBoardAbility", "Pulse Medic repair");
    return { applied: true, message: `Pulse Medic repaired ${targetDef.name}.` };
  }

  if (actor.type === "CB" && targetDef.faction !== actorDef.faction) {
    target.hp = Math.max(1, target.hp - 10);
    target.weakTurns = 2;
    actor.lastAbilityTurn = game.turnCount;
    setBoardTurnState(game, "applyingBoardAbility", "Corruptor weaken");
    return { applied: true, message: `Corruptor Bot weakened ${targetDef.name}.` };
  }

  return { applied: false };
}

export function rotatePolaritySquares(game) {
  for (let row = 0; row < 9; row += 1) {
    for (let col = 0; col < 9; col += 1) {
      const sq = game.board[row][col];
      if (!sq.shift) {
        continue;
      }
      const idx = ENERGY_ORDER.indexOf(sq.energy);
      sq.energy = ENERGY_ORDER[(idx + 1) % ENERGY_ORDER.length];
    }
  }
}

export function decayWeakEffects(game) {
  for (const unit of game.units) {
    if (!unit.alive) {
      continue;
    }
    if (unit.weakTurns > 0) {
      unit.weakTurns -= 1;
    }
  }
}

export function checkPowerNodeWinner(game) {
  let owner = null;
  for (const [row, col] of POWER_NODES) {
    const unit = getUnitAt(game, row, col);
    if (!unit) {
      return null;
    }
    const faction = unitFaction(unit, UNIT_DEFS);
    if (!owner) {
      owner = faction;
      continue;
    }
    if (owner !== faction) {
      return null;
    }
  }
  return owner;
}

export function checkCommandWinner(game) {
  const solarAlive = game.units.some((unit) => unit.alive && unit.type === "CC");
  const voidAlive = game.units.some((unit) => unit.alive && unit.type === "NO");

  if (!solarAlive && !voidAlive) {
    return { winner: "draw", reason: "both Command Units were destroyed" };
  }
  if (!solarAlive) {
    return { winner: FACTIONS.VOID, reason: "the Core Commander was destroyed" };
  }
  if (!voidAlive) {
    return { winner: FACTIONS.SOLAR, reason: "the Null Overlord was destroyed" };
  }
  return null;
}

export function applyDuelResolutionToBoard(game, resolution) {
  const { attackerId, defenderId, targetRow, targetCol, winner, survivorHp } = resolution;
  const attacker = getUnitById(game, attackerId);
  const defender = getUnitById(game, defenderId);

  if (winner === "attacker") {
    if (defender) {
      defender.alive = false;
      defender.hp = 0;
    }
    if (attacker) {
      attacker.row = targetRow;
      attacker.col = targetCol;
      attacker.hp = Math.max(1, Math.round(survivorHp));
    }
  } else if (winner === "defender") {
    if (attacker) {
      attacker.alive = false;
      attacker.hp = 0;
    }
    if (defender) {
      defender.hp = Math.max(1, Math.round(survivorHp));
    }
  } else {
    if (attacker) {
      attacker.alive = false;
      attacker.hp = 0;
    }
    if (defender) {
      defender.alive = false;
      defender.hp = 0;
    }
  }

  game.units = game.units.filter((unit) => unit.alive);
}

export function energyModifierForFaction(faction, energy) {
  if (energy === ENERGY.NEUTRAL) {
    return { hp: 1, damage: 1, text: "Neutral: no bonus" };
  }

  const aligned =
    (faction === FACTIONS.SOLAR && energy === ENERGY.LIGHT) ||
    (faction === FACTIONS.VOID && energy === ENERGY.DARK);

  if (aligned) {
    return { hp: 1.15, damage: 1.15, text: "+15% HP and damage on aligned grid" };
  }

  return { hp: 1, damage: 0.9, text: "-10% damage on hostile grid" };
}

export function nextTurn(game) {
  game.turn = enemyFaction(game.turn);
  game.turnCount += 1;
  if (game.turnCount % 3 === 0) {
    rotatePolaritySquares(game);
    return { shifted: true };
  }
  return { shifted: false };
}

export function markWinner(game, winner, reason) {
  game.winner = winner;
  game.winReason = reason;
}

export function clearSelection(game) {
  game.selectedUnitId = null;
  game.legalMoves = [];
}
