// SPDX-License-Identifier: GPL-3.0-or-later
import { setBoardTurnState } from "./state.js";
import { INITIAL_SOLAR_ROW, INITIAL_VOID_ROW, UNIT_DEFS } from "./units.js";
import {
  COMMAND_POWER_COSTS,
  ENERGY,
  FACTIONS,
  FLUX_PHASES,
  POWER_NODES,
  clamp,
  enemyFaction,
  factionEnergy,
  inBounds,
  randId,
  unitFaction,
} from "./utils.js";

const BOARD_SIZE = 9;
const NODE_HEAL_FRACTION = 0.12;

function modulo(value, divisor) {
  return ((value % divisor) + divisor) % divisor;
}

export function isFluxCoordinate(row, col) {
  return modulo(row - col, 3) === 0;
}

function fixedEnergyForCoordinate(row, col) {
  const darkHalf = row < 4 || (row === 4 && col < 4);
  return darkHalf ? ENERGY.DARK : ENERGY.LIGHT;
}

export function createBoardGrid(fluxPhase = 0) {
  const board = [];
  for (let row = 0; row < BOARD_SIZE; row += 1) {
    board[row] = [];
    for (let col = 0; col < BOARD_SIZE; col += 1) {
      const flux = isFluxCoordinate(row, col);
      const baseEnergy = flux ? ENERGY.NEUTRAL : fixedEnergyForCoordinate(row, col);
      board[row][col] = {
        energy: flux ? FLUX_PHASES[fluxPhase % FLUX_PHASES.length] : baseEnergy,
        baseEnergy,
        flux,
        shift: flux,
        lockFaction: null,
        node: false,
      };
    }
  }

  POWER_NODES.forEach(([row, col]) => {
    board[row][col].node = true;
  });

  return board;
}

export function createUnit(type, row, col) {
  const def = UNIT_DEFS[type];
  return {
    id: randId(type),
    type,
    row,
    col,
    previousRow: null,
    previousCol: null,
    recentSquares: [],
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

export function moveUnitTo(unit, row, col) {
  if (!unit) {
    return;
  }
  const previousKey = `${unit.row},${unit.col}`;
  unit.previousRow = unit.row;
  unit.previousCol = unit.col;
  unit.recentSquares = [...(unit.recentSquares || []), previousKey].slice(-4);
  unit.row = row;
  unit.col = col;
}

export function getUnitAt(game, row, col) {
  return game.units.find((unit) => unit.alive && unit.row === row && unit.col === col);
}

export function getLivingFactionUnits(game, faction) {
  return game.units.filter((unit) => unit.alive && unitFaction(unit, UNIT_DEFS) === faction);
}

export function getLivingCommandUnit(game, faction) {
  return game.units.find(
    (unit) =>
      unit.alive &&
      UNIT_DEFS[unit.type].isCommandUnit &&
      UNIT_DEFS[unit.type].faction === faction,
  );
}

export function canSelectUnit(game, unit) {
  if (!unit || !unit.alive || unitFaction(unit, UNIT_DEFS) !== game.turn) {
    return false;
  }
  return !(game.mode === "ai" && game.turn === FACTIONS.VOID);
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
  return pattern === "ortho" ? d8.slice(0, 4) : d8;
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
      if (!inBounds(row, col, BOARD_SIZE)) {
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
    for (const [dr, dc] of [
      [1, 1],
      [1, -1],
      [-1, 1],
      [-1, -1],
    ]) {
      const row = unit.row + dr;
      const col = unit.col + dc;
      if (!inBounds(row, col, BOARD_SIZE)) {
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
  if (!actor || !target || !actor.alive || !target.alive || !adjacent(actor, target)) {
    return { applied: false };
  }
  if (actor.lastAbilityTurn === game.turnCount) {
    return { applied: false, reason: "Ability already used this turn." };
  }

  const actorDef = UNIT_DEFS[actor.type];
  const targetDef = UNIT_DEFS[target.type];
  if (actor.type === "PM" && targetDef.faction === actorDef.faction && target.hp < target.maxHp) {
    const restored = Math.min(18, target.maxHp - target.hp);
    target.hp = clamp(target.hp + restored, 0, target.maxHp);
    actor.lastAbilityTurn = game.turnCount;
    setBoardTurnState(game, "applyingBoardAbility", "Pulse Medic repair");
    return { applied: true, message: `Pulse Medic restored ${Math.round(restored)} HP to ${targetDef.name}.` };
  }

  if (actor.type === "CB" && targetDef.faction !== actorDef.faction) {
    target.hp = Math.max(1, target.hp - 8);
    target.weakTurns = 2;
    actor.lastAbilityTurn = game.turnCount;
    setBoardTurnState(game, "applyingBoardAbility", "Corruptor weaken");
    return { applied: true, message: `Corruptor Bot weakened ${targetDef.name} for two turns.` };
  }

  return { applied: false };
}

export function getPowerNodeControl(game) {
  const owners = POWER_NODES.map(([row, col]) => {
    const unit = getUnitAt(game, row, col);
    return unit ? unitFaction(unit, UNIT_DEFS) : null;
  });
  return {
    owners,
    [FACTIONS.SOLAR]: owners.filter((owner) => owner === FACTIONS.SOLAR).length,
    [FACTIONS.VOID]: owners.filter((owner) => owner === FACTIONS.VOID).length,
  };
}

export function checkPowerNodeWinner(game) {
  const control = getPowerNodeControl(game);
  if (control[FACTIONS.SOLAR] === POWER_NODES.length) {
    return FACTIONS.SOLAR;
  }
  if (control[FACTIONS.VOID] === POWER_NODES.length) {
    return FACTIONS.VOID;
  }
  return null;
}

export function getPowerNodeThreat(game) {
  const control = getPowerNodeControl(game);
  if (control[FACTIONS.SOLAR] === POWER_NODES.length - 1) {
    return FACTIONS.SOLAR;
  }
  if (control[FACTIONS.VOID] === POWER_NODES.length - 1) {
    return FACTIONS.VOID;
  }
  return null;
}

export function healFactionPowerNodes(game, faction) {
  const healed = [];
  for (const [row, col] of POWER_NODES) {
    const unit = getUnitAt(game, row, col);
    if (!unit || unitFaction(unit, UNIT_DEFS) !== faction || unit.hp >= unit.maxHp) {
      continue;
    }
    const amount = Math.min(unit.maxHp - unit.hp, unit.maxHp * NODE_HEAL_FRACTION);
    unit.hp = clamp(unit.hp + amount, 0, unit.maxHp);
    healed.push({ unitId: unit.id, amount });
  }
  return healed;
}

export function awardRoundCommandCharge(game) {
  const control = getPowerNodeControl(game);
  const gained = { [FACTIONS.SOLAR]: 0, [FACTIONS.VOID]: 0 };
  for (const faction of [FACTIONS.SOLAR, FACTIONS.VOID]) {
    let amount = control[faction] > 0 ? 1 : 0;
    if (control[faction] >= 3) {
      amount += 1;
    }
    const before = game.commandCharge[faction];
    game.commandCharge[faction] = clamp(before + amount, 0, 3);
    gained[faction] = game.commandCharge[faction] - before;
  }
  return gained;
}

export function advanceFluxPhase(game) {
  game.fluxPhase = (game.fluxPhase + 1) % FLUX_PHASES.length;
  for (const row of game.board) {
    for (const square of row) {
      if (!square.flux) {
        continue;
      }
      square.lockFaction = null;
      square.energy = FLUX_PHASES[game.fluxPhase];
    }
  }
  return FLUX_PHASES[game.fluxPhase];
}

export function canUseCommandPower(game, faction, powerName) {
  const cost = COMMAND_POWER_COSTS[powerName];
  return Boolean(
    cost &&
      getLivingCommandUnit(game, faction) &&
      game.commandCharge[faction] >= cost,
  );
}

function spendCommandCharge(game, faction, powerName) {
  if (!canUseCommandPower(game, faction, powerName)) {
    return false;
  }
  game.commandCharge[faction] -= COMMAND_POWER_COSTS[powerName];
  return true;
}

export function applyGridLock(game, faction, row, col) {
  const square = game.board[row]?.[col];
  if (!square?.flux || !spendCommandCharge(game, faction, "gridLock")) {
    return { applied: false };
  }
  square.lockFaction = faction;
  square.energy = factionEnergy(faction);
  return { applied: true, message: `Grid Lock aligned ${String.fromCharCode(65 + col)}${row + 1}.` };
}

export function applyFieldRepair(game, faction, target) {
  const def = target ? UNIT_DEFS[target.type] : null;
  if (
    !target ||
    !target.alive ||
    !def ||
    def.faction !== faction ||
    def.isCommandUnit ||
    target.hp >= target.maxHp ||
    !spendCommandCharge(game, faction, "fieldRepair")
  ) {
    return { applied: false };
  }
  const amount = Math.min(target.maxHp - target.hp, target.maxHp * 0.2);
  target.hp = clamp(target.hp + amount, 0, target.maxHp);
  return { applied: true, message: `Field Repair restored ${Math.round(amount)} HP to ${def.name}.` };
}

export function relayDestinationsForUnit(game, unit) {
  if (!unit?.alive || UNIT_DEFS[unit.type].isCommandUnit) {
    return [];
  }
  const destinations = [];
  for (let dr = -1; dr <= 1; dr += 1) {
    for (let dc = -1; dc <= 1; dc += 1) {
      if ((!dr && !dc) || !inBounds(unit.row + dr, unit.col + dc, BOARD_SIZE)) {
        continue;
      }
      const row = unit.row + dr;
      const col = unit.col + dc;
      if (!getUnitAt(game, row, col) && !game.board[row][col].node) {
        destinations.push({ row, col });
      }
    }
  }
  return destinations;
}

export function applyEmergencyRelay(game, faction, unit, row, col) {
  const def = unit ? UNIT_DEFS[unit.type] : null;
  const legal = relayDestinationsForUnit(game, unit).some(
    (destination) => destination.row === row && destination.col === col,
  );
  if (
    !unit ||
    !def ||
    def.faction !== faction ||
    def.isCommandUnit ||
    !legal ||
    !spendCommandCharge(game, faction, "emergencyRelay")
  ) {
    return { applied: false };
  }
  moveUnitTo(unit, row, col);
  return { applied: true, message: `Emergency Relay repositioned ${def.name}.` };
}

export function decayWeakEffects(game, faction) {
  for (const unit of game.units) {
    if (
      unit.alive &&
      unitFaction(unit, UNIT_DEFS) === faction &&
      unit.weakTurns > 0
    ) {
      unit.weakTurns -= 1;
    }
  }
}

export function checkCommandWinner(game) {
  const solarAlive = Boolean(getLivingCommandUnit(game, FACTIONS.SOLAR));
  const voidAlive = Boolean(getLivingCommandUnit(game, FACTIONS.VOID));

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
      moveUnitTo(attacker, targetRow, targetCol);
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
  const aligned = factionEnergy(faction) === energy;
  return aligned
    ? { hp: 1.08, damage: 1.08, text: "+8% HP and damage on aligned grid" }
    : { hp: 1, damage: 0.94, text: "-6% damage on hostile grid" };
}

export function nextTurn(game) {
  const endingFaction = game.turn;
  const healed = healFactionPowerNodes(game, endingFaction);
  decayWeakEffects(game, endingFaction);
  game.turn = enemyFaction(game.turn);
  game.turnCount += 1;

  let shifted = false;
  let gained = { [FACTIONS.SOLAR]: 0, [FACTIONS.VOID]: 0 };
  if (game.turn === FACTIONS.SOLAR) {
    game.roundCount += 1;
    advanceFluxPhase(game);
    gained = awardRoundCommandCharge(game);
    shifted = true;
  }

  return { shifted, healed, gained };
}

export function markWinner(game, winner, reason) {
  game.winner = winner;
  game.winReason = reason;
}

export function clearSelection(game) {
  game.selectedUnitId = null;
  game.legalMoves = [];
  game.boardAction = null;
}
