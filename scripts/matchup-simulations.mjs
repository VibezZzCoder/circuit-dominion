// SPDX-License-Identifier: GPL-3.0-or-later
// Additional terms under GPL-3.0 section 7 apply; see NOTICE.md.
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import {
  applyEmergencyRelay,
  applyFieldRepair,
  applyGridLock,
  applyDuelResolutionToBoard,
  checkCommandWinner,
  checkPowerNodeWinner,
  createBoardGrid,
  getUnitAt,
  moveUnitTo,
  nextTurn,
  spawnInitialUnits,
  tryBoardAbility,
} from "../src/board.js";
import { chooseBoardAiAction, estimateDuelOdds, getDuelAiIntent } from "../src/ai.js";
import { startCombat, updateCombat } from "../src/combat.js";
import { createInitialState } from "../src/state.js";
import { UNIT_DEFS } from "../src/units.js";
import { ENERGY, FACTIONS, unitFaction } from "../src/utils.js";

global.document = {
  getElementById: () => ({ checked: false }),
};

const audio = { beep() {} };
const SOLAR_TYPES = Object.values(UNIT_DEFS)
  .filter((def) => def.faction === FACTIONS.SOLAR)
  .map((def) => def.id);
const VOID_TYPES = Object.values(UNIT_DEFS)
  .filter((def) => def.faction === FACTIONS.VOID)
  .map((def) => def.id);
const ENERGIES = [ENERGY.NEUTRAL, ENERGY.LIGHT, ENERGY.DARK];
const REPETITIONS = Math.max(1, Number(process.env.CD_SIM_REPS || 16));
const DT = 1 / 30;
const MAX_DUEL_SECONDS = 72;

function seededRng(seed) {
  let state = seed >>> 0 || 0x9e3779b9;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 4294967296;
  };
}

function percentile(values, fraction) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * fraction))];
}

function makeUnit(type, prefix) {
  const def = UNIT_DEFS[type];
  return {
    id: `${prefix}-${type}`,
    type,
    row: 4,
    col: 4,
    hp: def.maxHp,
    maxHp: def.maxHp,
    weakTurns: 0,
    alive: true,
    lastAbilityTurn: -1,
  };
}

// This matrix measures AI versus AI, not assisted human controls versus AI.
// Solar used to travel through P1's action fields, which inherited human aim
// assist when controls improved and silently made the comparison asymmetric.
export function stepAiDuel(game, { solarDifficulty, voidDifficulty, nowMs, rng, deltaSec = DT }) {
  const combat = game.combat;
  const solar = combat.fighters.find((fighter) => UNIT_DEFS[fighter.unit.type].faction === FACTIONS.SOLAR);
  const voidFighter = combat.fighters.find((fighter) => fighter !== solar);
  solar.controller = "ai";
  voidFighter.controller = "ai";
  game.difficulty = voidDifficulty;
  combat.difficulty = voidDifficulty;
  combat.rng = rng;
  // Prime Solar's normal cached AI decision using its own difficulty. The
  // runtime then consumes that same intent through its AI path; Void uses the
  // default difficulty. Solar-first RNG ordering matches historical samples.
  getDuelAiIntent(solar, voidFighter, combat, nowMs, solarDifficulty, rng);
  return updateCombat(game, {}, deltaSec, nowMs, audio);
}

function simulateDuel({
  solarType,
  voidType,
  energy,
  voidStarts,
  solarDifficulty = "standard",
  voidDifficulty = "standard",
  seed,
}) {
  const rng = seededRng(seed);
  const priorRandom = Math.random;
  Math.random = rng;
  try {
    const game = createInitialState("ai", voidDifficulty);
    game.board = createBoardGrid();
    game.board[4][4].energy = energy;
    const solar = makeUnit(solarType, "S");
    const voidUnit = makeUnit(voidType, "V");
    game.units = [solar, voidUnit];
    startCombat(
      game,
      voidStarts ? voidUnit : solar,
      voidStarts ? solar : voidUnit,
      4,
      4,
    );
    game.combat.countdown = 0;
    game.combat.state = "combatActive";

    let result = null;
    let nowMs = 0;
    while (!result && nowMs < MAX_DUEL_SECONDS * 1000) {
      result = stepAiDuel(game, { solarDifficulty, voidDifficulty, nowMs, rng });
      nowMs += DT * 1000;
    }

    const solarFighter = game.combat.fighters.find(
      (fighter) => UNIT_DEFS[fighter.unit.type].faction === FACTIONS.SOLAR,
    );
    const voidFighter = game.combat.fighters.find((fighter) => fighter !== solarFighter);
    let winner = null;
    if (result) {
      const winningId =
        result.winner === "attacker" ? result.attackerId :
        result.winner === "defender" ? result.defenderId : null;
      if (winningId) {
        winner = winningId === solar.id ? FACTIONS.SOLAR : FACTIONS.VOID;
      }
    } else if (solarFighter.hp !== voidFighter.hp) {
      winner =
        solarFighter.hp / solarFighter.maxHp > voidFighter.hp / voidFighter.maxHp
          ? FACTIONS.SOLAR
          : FACTIONS.VOID;
    }

    return {
      winner,
      duration: game.combat.elapsedSec,
      timedOut: !result,
      solarType,
      voidType,
      energy,
      voidStarts,
      solarDifficulty,
      voidDifficulty,
    };
  } finally {
    Math.random = priorRandom;
  }
}

function runCombatMatrix() {
  const results = [];
  let seed = 1000;
  for (const solarType of SOLAR_TYPES) {
    for (const voidType of VOID_TYPES) {
      for (const energy of ENERGIES) {
        for (const voidStarts of [false, true]) {
          for (let repetition = 0; repetition < REPETITIONS; repetition += 1) {
            results.push(
              simulateDuel({
                solarType,
                voidType,
                energy,
                voidStarts,
                seed: seed++,
              }),
            );
          }
        }
      }
    }
  }
  return results;
}

function summarizeCombat(results) {
  const decisive = results.filter((result) => result.winner);
  const neutral = decisive.filter((result) => result.energy === ENERGY.NEUTRAL);
  const solarNeutralRate =
    neutral.filter((result) => result.winner === FACTIONS.SOLAR).length /
    Math.max(1, neutral.length);
  const aligned = decisive.filter(
    (result) =>
      (result.energy === ENERGY.LIGHT && result.winner === FACTIONS.SOLAR) ||
      (result.energy === ENERGY.DARK && result.winner === FACTIONS.VOID),
  );
  const alignedRate = aligned.length / Math.max(
    1,
    decisive.filter((result) => result.energy !== ENERGY.NEUTRAL).length,
  );
  const light = decisive.filter((result) => result.energy === ENERGY.LIGHT);
  const dark = decisive.filter((result) => result.energy === ENERGY.DARK);
  const unitRates = {};
  for (const type of [...SOLAR_TYPES, ...VOID_TYPES]) {
    const faction = UNIT_DEFS[type].faction;
    const relevant = neutral.filter((result) =>
      faction === FACTIONS.SOLAR ? result.solarType === type : result.voidType === type,
    );
    unitRates[type] =
      relevant.filter((result) => result.winner === faction).length /
      Math.max(1, relevant.length);
  }
  const durations = results.map((result) => result.duration);
  const alignedExpectedOdds = [];
  for (const solarType of SOLAR_TYPES) {
    for (const voidType of VOID_TYPES) {
      const solar = makeUnit(solarType, "expected-S");
      const voidUnit = makeUnit(voidType, "expected-V");
      alignedExpectedOdds.push(estimateDuelOdds(solar, voidUnit, ENERGY.LIGHT));
      alignedExpectedOdds.push(estimateDuelOdds(voidUnit, solar, ENERGY.DARK));
    }
  }
  return {
    solarNeutralRate,
    alignedRate,
    alignedExpectedRate:
      alignedExpectedOdds.reduce((sum, value) => sum + value, 0) /
      alignedExpectedOdds.length,
    solarLightRate:
      light.filter((result) => result.winner === FACTIONS.SOLAR).length /
      Math.max(1, light.length),
    voidDarkRate:
      dark.filter((result) => result.winner === FACTIONS.VOID).length /
      Math.max(1, dark.length),
    unitRates,
    medianDuration: percentile(durations, 0.5),
    p95Duration: percentile(durations, 0.95),
    timeoutRate: results.filter((result) => result.timedOut).length / results.length,
  };
}

// 72 pairings alone give a ~5.5-point standard error against a 10-point
// acceptance band; seeded repeats measure the rate instead of one stream.
const DIFFICULTY_REPEATS = 6;

function runDifficultyComparison(stronger, weaker) {
  const results = [];
  let seed = stronger === "standard" ? 81000 : 91000;
  for (let repeat = 0; repeat < DIFFICULTY_REPEATS; repeat += 1) {
    for (const solarType of SOLAR_TYPES) {
      for (const voidType of VOID_TYPES) {
        for (const strongerIsSolar of [true, false]) {
          const result = simulateDuel({
            solarType,
            voidType,
            energy: ENERGY.NEUTRAL,
            voidStarts: !strongerIsSolar,
            solarDifficulty: strongerIsSolar ? stronger : weaker,
            voidDifficulty: strongerIsSolar ? weaker : stronger,
            seed: seed++,
          });
          results.push({
            ...result,
            strongerWon:
              result.winner === (strongerIsSolar ? FACTIONS.SOLAR : FACTIONS.VOID),
          });
        }
      }
    }
  }
  return results.filter((result) => result.winner).reduce(
    (sum, result) => sum + Number(result.strongerWon),
    0,
  ) / Math.max(1, results.filter((result) => result.winner).length);
}

function executeBoardAction(game, action, rng) {
  if (!action) return { duelDuration: 0 };
  if (action.kind === "ability") {
    const actor = game.units.find((unit) => unit.id === action.unitId);
    const target = game.units.find((unit) => unit.id === action.targetId);
    tryBoardAbility(game, actor, target);
    return { duelDuration: 0 };
  }
  if (action.kind === "command") {
    if (action.power === "fieldRepair") {
      applyFieldRepair(
        game,
        game.turn,
        game.units.find((unit) => unit.id === action.targetId),
      );
    } else if (action.power === "gridLock") {
      applyGridLock(game, game.turn, action.row, action.col);
    } else if (action.power === "emergencyRelay") {
      applyEmergencyRelay(
        game,
        game.turn,
        game.units.find((unit) => unit.id === action.unitId),
        action.row,
        action.col,
      );
    }
    return { duelDuration: 0 };
  }

  const attacker = game.units.find((unit) => unit.id === action.unitId);
  const target = getUnitAt(game, action.move.row, action.move.col);
  if (!attacker) return { duelDuration: 0 };
  if (!target) {
    moveUnitTo(attacker, action.move.row, action.move.col);
    return { duelDuration: 0 };
  }

  const odds = estimateDuelOdds(attacker, target, game.board[action.move.row][action.move.col].energy);
  const attackerWins = rng() < odds;
  const duration = 8 + rng() * 12;
  const winner = attackerWins ? "attacker" : "defender";
  const survivor = attackerWins ? attacker : target;
  const survivorHp = Math.max(1, survivor.hp * (0.38 + rng() * 0.47));
  applyDuelResolutionToBoard(game, {
    attackerId: attacker.id,
    defenderId: target.id,
    targetRow: action.move.row,
    targetCol: action.move.col,
    winner,
    survivorHp,
  });
  return { duelDuration: duration };
}

export function simulateBoardMatch(seed, { trace = false } = {}) {
  const rng = seededRng(seed);
  const priorRandom = Math.random;
  Math.random = rng;
  try {
    const game = createInitialState("pvp", "hard");
    game.board = createBoardGrid();
    spawnInitialUnits(game);
    let elapsed = 0;
    let turns = 0;
    const actions = [];
    while (turns < 260) {
      const action = chooseBoardAiAction(game, rng);
      if (trace) actions.push({ turn: turns + 1, faction: game.turn, action, units: game.units.map(({type,row,col,hp}) => ({type,row,col,hp})) });
      const { duelDuration } = executeBoardAction(game, action, rng);
      elapsed += 28 + duelDuration;
      turns += 1;
      const commandWin = checkCommandWinner(game);
      const nodeWin = checkPowerNodeWinner(game);
      if (commandWin || nodeWin) {
        return { seed, turns, elapsed, winner: commandWin?.winner || nodeWin, ...(trace ? { actions } : {}) };
      }
      nextTurn(game);
    }
    return { seed, turns, elapsed, winner: null, ...(trace ? { actions } : {}) };
  } finally {
    Math.random = priorRandom;
  }
}

export function runBoardMatches() {
  const results = [];
  const count = Math.max(1, Number(process.env.CD_SIM_BOARD_COUNT || 48));
  const firstSeed = Number(process.env.CD_SIM_BOARD_SEED || 120000);
  for (let index = 0; index < count; index += 1) {
    results.push(simulateBoardMatch(firstSeed + index));
  }
  return {
    medianMinutes: percentile(results.map((result) => result.elapsed / 60), 0.5),
    medianTurns: percentile(results.map((result) => result.turns), 0.5),
    completionRate: results.filter((result) => result.winner).length / results.length,
    unresolvedSeeds: results.filter((result) => !result.winner).map((result) => result.seed),
    count,
  };
}

function percentage(value) {
  return `${(value * 100).toFixed(1)}%`;
}

function run() {
  const combatResults = runCombatMatrix();
  const combat = summarizeCombat(combatResults);
  const standardVsEasy = runDifficultyComparison("standard", "easy");
  const hardVsStandard = runDifficultyComparison("hard", "standard");
  const board = runBoardMatches();

  console.log(`matchup-simulations: ${combatResults.length} seeded duels`);
  console.log(`- neutral Solar aggregate: ${percentage(combat.solarNeutralRate)}`);
  console.log(`- aligned expected duel advantage: ${percentage(combat.alignedExpectedRate)}`);
  console.log(`- aligned AI-vs-AI outcome rate: ${percentage(combat.alignedRate)}`);
  console.log(`  Solar on Light / Void on Dark: ${percentage(combat.solarLightRate)} / ${percentage(combat.voidDarkRate)}`);
  console.log(`- duel duration median/p95: ${combat.medianDuration.toFixed(1)}s / ${combat.p95Duration.toFixed(1)}s`);
  console.log(`- unresolved by ${MAX_DUEL_SECONDS}s: ${percentage(combat.timeoutRate)}`);
  console.log(`- Standard over Easy: ${percentage(standardVsEasy)}`);
  console.log(`- Hard over Standard: ${percentage(hardVsStandard)}`);
  console.log(`- projected full match median: ${board.medianMinutes.toFixed(1)} min / ${board.medianTurns} turns`);
  console.log(`- board simulation completion: ${percentage(board.completionRate)}`);
  console.log(`- unresolved board seeds: ${board.unresolvedSeeds.join(", ") || "none"} (${board.count} matches)`);
  console.log(
    `- neutral unit rates: ${Object.entries(combat.unitRates)
      .map(([type, rate]) => `${type} ${percentage(rate)}`)
      .join(", ")}`,
  );

  assert.ok(combat.timeoutRate <= 0.05, "At least 95% of duels should resolve inside the simulation limit.");
  assert.ok(combat.solarNeutralRate >= 0.47 && combat.solarNeutralRate <= 0.53, "Neutral faction aggregate should remain 47-53%.");
  assert.ok(combat.alignedExpectedRate >= 0.55 && combat.alignedExpectedRate <= 0.65, "Aligned expected advantage should remain 55-65%.");
  assert.ok(Math.max(...Object.values(combat.unitRates)) <= 0.75, "No unit should beat the full opposing roster over 75% on Neutral.");
  assert.ok(standardVsEasy >= 0.65 && standardVsEasy <= 0.75, "Standard should defeat Easy 65-75%.");
  assert.ok(hardVsStandard >= 0.6 && hardVsStandard <= 0.7, "Hard should defeat Standard 60-70%.");
  assert.ok(combat.medianDuration >= 8 && combat.medianDuration <= 20, "Median duel should be 8-20 seconds.");
  assert.ok(combat.p95Duration <= 60, "95% of duels should resolve before 60 seconds.");
  assert.ok(board.medianMinutes >= 15 && board.medianMinutes <= 25, "Projected median match should be 15-25 minutes.");
  assert.ok(board.completionRate >= 0.98, "Board AI should complete at least 98% of simulated matches.");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.env.CD_SIM_BOARD_ONLY === "1") {
    const board = runBoardMatches();
    console.log(JSON.stringify(board, null, 2));
    assert.ok(board.completionRate >= 0.98, "Board AI should complete at least 98% of simulated matches.");
  }
  else run();
}
