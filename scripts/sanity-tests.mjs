// SPDX-License-Identifier: GPL-3.0-or-later
// Additional terms under GPL-3.0 section 7 apply; see NOTICE.md.
import assert from "node:assert/strict";
import {
  advanceFluxPhase,
  applyEmergencyRelay,
  applyFieldRepair,
  applyGridLock,
  awardRoundCommandCharge,
  checkCommandWinner,
  checkPowerNodeWinner,
  createBoardGrid,
  createUnit,
  energyModifierForFaction,
  healFactionPowerNodes,
  legalMovesForUnit,
  moveUnitTo,
  nextTurn,
  spawnInitialUnits,
  tryBoardAbility,
} from "../src/board.js";
import { chooseBoardAiAction } from "../src/ai.js";
import {
  circleIntersectsRect,
  damageFighter,
  directionalMeleeHit,
  getOvertimeMultiplier,
  projectileHitsObstacle,
  resolveFighterObstacles,
  startCombat,
  sweptCircleHit,
  updateCombat,
} from "../src/combat.js";
import { createInitialState } from "../src/state.js";
import { UIController } from "../src/ui.js";
import { UNIT_DEFS } from "../src/units.js";
import { ENERGY, FACTIONS, FLUX_PHASES, POWER_NODES } from "../src/utils.js";

global.document = {
  getElementById: () => ({ checked: false }),
};

const audio = { beep() {} };
const idleActions = {
  p1MoveX: 0,
  p1MoveY: 0,
  p1Attack: false,
  p1Special: false,
  p2MoveX: 0,
  p2MoveY: 0,
  p2Attack: false,
  p2Special: false,
  pause: false,
  restart: false,
  toggleHelp: false,
  toggleDebug: false,
};

function makeGame(mode = "ai", difficulty = "standard") {
  const game = createInitialState(mode, difficulty);
  game.board = createBoardGrid();
  spawnInitialUnits(game);
  return game;
}

function unit(type, row, col, options = {}) {
  const created = createUnit(type, row, col);
  Object.assign(created, options);
  return created;
}

function countBoardEnergies(board) {
  const counts = { fixedLight: 0, fixedDark: 0, flux: 0 };
  for (const row of board) {
    for (const square of row) {
      if (square.flux) {
        counts.flux += 1;
      } else if (square.energy === ENERGY.LIGHT) {
        counts.fixedLight += 1;
      } else if (square.energy === ENERGY.DARK) {
        counts.fixedDark += 1;
      }
    }
  }
  return counts;
}

function testBoardFoundation() {
  const board = createBoardGrid();
  assert.equal(board.length, 9);
  assert.equal(board[0].length, 9);
  assert.deepEqual(countBoardEnergies(board), {
    fixedLight: 27,
    fixedDark: 27,
    flux: 27,
  });
  for (let row = 0; row < 9; row += 1) {
    for (let col = 0; col < 9; col += 1) {
      assert.equal(board[row][col].flux, ((row - col) % 3 + 3) % 3 === 0);
    }
  }
  assert.deepEqual(
    POWER_NODES.filter(([row, col]) => board[row][col].node),
    POWER_NODES,
  );

  const game = makeGame("pvp");
  const solarCommand = game.units.find((candidate) => candidate.type === "CC");
  const voidCommand = game.units.find((candidate) => candidate.type === "NO");
  assert.deepEqual([solarCommand.row, solarCommand.col], [8, 4]);
  assert.deepEqual([voidCommand.row, voidCommand.col], [0, 4]);
}

function testFluxRoundTimingAndLocks() {
  const game = makeGame("pvp");
  game.commandCharge.S = 1;
  const locked = applyGridLock(game, FACTIONS.SOLAR, 3, 3);
  assert.equal(locked.applied, true);
  assert.equal(game.board[3][3].energy, ENERGY.LIGHT);
  assert.equal(game.board[3][3].lockFaction, FACTIONS.SOLAR);

  const solarEnd = nextTurn(game);
  assert.equal(solarEnd.shifted, false);
  assert.equal(game.fluxPhase, 0);
  assert.equal(game.roundCount, 1);
  assert.equal(game.board[3][3].lockFaction, FACTIONS.SOLAR);

  const voidEnd = nextTurn(game);
  assert.equal(voidEnd.shifted, true);
  assert.equal(game.fluxPhase, 1);
  assert.equal(game.roundCount, 2);
  assert.equal(game.board[3][3].lockFaction, null);
  assert.equal(game.board[3][3].energy, ENERGY.LIGHT);

  for (let index = 0; index < FLUX_PHASES.length; index += 1) {
    assert.equal(game.board[0][0].energy, FLUX_PHASES[game.fluxPhase]);
    advanceFluxPhase(game);
  }
  assert.equal(game.fluxPhase, 1);
}

function testNodeHealingChargeAndVictory() {
  const game = makeGame("pvp");
  game.units = [
    unit("CC", 8, 4, { hp: 65 }),
    unit("PS", 0, 4, { hp: 42 }),
    unit("AS", 4, 0),
    unit("SD", 4, 4),
    unit("PM", 4, 8),
    unit("NO", 0, 0),
  ];
  const healed = healFactionPowerNodes(game, FACTIONS.SOLAR);
  assert.equal(healed.length, 2);
  const striker = game.units.find((candidate) => candidate.type === "PS");
  assert.equal(striker.hp, 42 + UNIT_DEFS.PS.maxHp * 0.12);

  const gained = awardRoundCommandCharge(game);
  assert.equal(gained.S, 2);
  assert.equal(gained.V, 0);
  assert.equal(game.commandCharge.S, 2);
  assert.equal(checkPowerNodeWinner(game), FACTIONS.SOLAR);
}

function testCommandPowersAndCosts() {
  const game = makeGame("pvp");
  const striker = game.units.find((candidate) => candidate.type === "PS");
  striker.hp = 40;
  game.commandCharge.S = 3;

  const repair = applyFieldRepair(game, FACTIONS.SOLAR, striker);
  assert.equal(repair.applied, true);
  assert.equal(striker.hp, 40 + UNIT_DEFS.PS.maxHp * 0.2);
  assert.equal(game.commandCharge.S, 2);

  const invalidCommandRepair = applyFieldRepair(
    game,
    FACTIONS.SOLAR,
    game.units.find((candidate) => candidate.type === "CC"),
  );
  assert.equal(invalidCommandRepair.applied, false);
  assert.equal(game.commandCharge.S, 2);

  const original = { row: striker.row, col: striker.col };
  const relay = applyEmergencyRelay(game, FACTIONS.SOLAR, striker, 7, 0);
  assert.equal(relay.applied, true);
  assert.deepEqual([striker.row, striker.col], [7, 0]);
  assert.equal(game.commandCharge.S, 0);

  game.commandCharge.S = 1;
  assert.equal(applyGridLock(game, FACTIONS.SOLAR, 0, 1).applied, false);
  assert.equal(game.commandCharge.S, 1);
  assert.deepEqual(original, { row: 8, col: 1 });
}

function testCorruptorWeaknessDuration() {
  const game = makeGame("pvp");
  const corruptor = unit("CB", 4, 4);
  const striker = unit("PS", 5, 4);
  game.units = [corruptor, striker, unit("NO", 0, 4), unit("CC", 8, 4)];
  game.turn = FACTIONS.VOID;

  const weakened = tryBoardAbility(game, corruptor, striker);
  assert.equal(weakened.applied, true);
  assert.equal(striker.weakTurns, 2);

  nextTurn(game);
  assert.equal(striker.weakTurns, 2, "enemy turn ending must not consume weakness");
  nextTurn(game);
  assert.equal(striker.weakTurns, 1, "first affected faction turn should consume one turn");
  nextTurn(game);
  assert.equal(striker.weakTurns, 1);
  nextTurn(game);
  assert.equal(striker.weakTurns, 0, "weakness should expire after two affected turns");
}

function testMovementAndWinRules() {
  const game = makeGame("pvp");
  game.units = [
    unit("GW", 4, 1),
    unit("SD", 4, 2),
    unit("PS", 4, 3),
  ];
  const moves = legalMovesForUnit(game, game.units[0]);
  assert.ok(moves.some((move) => move.row === 4 && move.col === 3 && move.attack));

  game.units = [
    unit("CC", 8, 4, { hp: 0, alive: false }),
    unit("NO", 0, 4, { hp: 20 }),
  ];
  assert.equal(checkCommandWinner(game).winner, FACTIONS.VOID);
}

function testEnergyModifiers() {
  assert.deepEqual(energyModifierForFaction(FACTIONS.SOLAR, ENERGY.LIGHT), {
    hp: 1.08,
    damage: 1.08,
    text: "+8% HP and damage on aligned grid",
  });
  assert.deepEqual(energyModifierForFaction(FACTIONS.SOLAR, ENERGY.DARK), {
    hp: 1,
    damage: 0.94,
    text: "-6% damage on hostile grid",
  });
  assert.deepEqual(energyModifierForFaction(FACTIONS.SOLAR, ENERGY.NEUTRAL), {
    hp: 1,
    damage: 1,
    text: "Neutral: no bonus",
  });
}

function testDirectionalCombatGeometry() {
  const attacker = { x: 100, y: 100, facingX: 1, facingY: 0 };
  const front = { x: 160, y: 100, radius: 20 };
  const behind = { x: 40, y: 100, radius: 20 };
  assert.equal(directionalMeleeHit(attacker, front, 70, 90), true);
  assert.equal(directionalMeleeHit(attacker, behind, 70, 90), false);

  assert.equal(
    sweptCircleHit({ x: 80, y: 100 }, { x: 240, y: 100 }, { x: 160, y: 112 }, 30),
    true,
  );
  assert.equal(
    sweptCircleHit({ x: 80, y: 100 }, { x: 240, y: 100 }, { x: 160, y: 160 }, 30),
    false,
  );

  const obstacle = { x: 140, y: 80, width: 80, height: 40 };
  assert.equal(circleIntersectsRect({ x: 130, y: 100, radius: 12 }, obstacle), true);
  assert.equal(projectileHitsObstacle({ x: 160, y: 100, radius: 5 }, [obstacle]), true);
  const fighter = { x: 165, y: 100, radius: 18, vx: 40, vy: 0 };
  assert.equal(resolveFighterObstacles(fighter, [obstacle]), true);
  assert.equal(circleIntersectsRect(fighter, obstacle), false);
}

function testProjectileRange() {
  const game = makeGame("pvp");
  const sniper = unit("AS", 4, 4);
  const cannon = unit("EC", 4, 5);
  game.units = [sniper, cannon];
  startCombat(game, sniper, cannon, 4, 4);
  game.combat.countdown = 0;
  game.combat.state = "combatActive";
  game.combat.obstacles = [];
  const sniperFighter = game.combat.fighters[0];
  const cannonFighter = game.combat.fighters[1];
  sniperFighter.x = 100;
  sniperFighter.y = 100;
  cannonFighter.x = 850;
  cannonFighter.y = 430;

  updateCombat(game, { ...idleActions, p1Attack: true }, 0.016, 0, audio);
  updateCombat(game, idleActions, 0.14, 140, audio);
  assert.equal(game.combat.projectiles.length, 1);
  const maxRange = UNIT_DEFS.AS.attack.range;
  for (let step = 1; step <= 20 && game.combat.projectiles.length; step += 1) {
    updateCombat(game, idleActions, 0.1, 140 + step * 100, audio);
  }
  assert.equal(game.combat.projectiles.length, 0);
  assert.equal(maxRange, 520);
}

function testCorruptorSpreadSpecial() {
  const game = makeGame("pvp");
  const corruptor = unit("CB", 4, 4);
  const sniper = unit("AS", 4, 5);
  game.units = [corruptor, sniper];
  startCombat(game, corruptor, sniper, 4, 4);
  game.combat.countdown = 0;
  game.combat.state = "combatActive";
  game.combat.obstacles = [];
  const corruptorFighter = game.combat.fighters[0];
  corruptorFighter.specialCooldown = 0;
  corruptorFighter.facingX = 1;
  corruptorFighter.facingY = 0;

  updateCombat(game, { ...idleActions, p2Special: true }, 0.016, 0, audio);
  updateCombat(game, idleActions, 0.016, 130, audio);

  assert.equal(game.combat.projectiles.length, 3);
  assert.ok(new Set(game.combat.projectiles.map((projectile) => projectile.vy.toFixed(3))).size > 1);
}

function testBlinkInvulnerabilityAndOvertime() {
  const game = makeGame("pvp");
  const wraith = unit("GW", 4, 4);
  const sniper = unit("AS", 4, 5);
  game.units = [wraith, sniper];
  startCombat(game, wraith, sniper, 4, 4);
  game.combat.countdown = 0;
  game.combat.state = "combatActive";
  game.combat.obstacles = [];
  const wraithFighter = game.combat.fighters[0];
  const sniperFighter = game.combat.fighters[1];
  wraithFighter.specialCooldown = 0;
  wraithFighter.facingX = 1;
  wraithFighter.facingY = 0;
  const startingX = wraithFighter.x;

  updateCombat(game, { ...idleActions, p2Special: true }, 0.016, 0, audio);
  updateCombat(game, idleActions, 0.1, 100, audio);
  assert.ok(wraithFighter.x > startingX);
  assert.ok(wraithFighter.invulnerableUntil > 100);
  const beforeHp = wraithFighter.hp;
  game.combat.nowMs = 100;
  damageFighter(wraithFighter, 30, sniperFighter, game.combat, audio);
  assert.equal(wraithFighter.hp, beforeHp);

  assert.equal(getOvertimeMultiplier(44.99), 1);
  assert.equal(getOvertimeMultiplier(45), 1.25);
  assert.equal(getOvertimeMultiplier(60), 1.5);
}

function testInitialCombatStateAndOwnership() {
  const game = makeGame("ai");
  const solar = game.units.find((candidate) => candidate.type === "PS");
  const voidUnit = game.units.find((candidate) => candidate.type === "RC");
  startCombat(game, voidUnit, solar, 4, 4);

  const solarFighter = game.combat.fighters.find((fighter) => fighter.unit.type === "PS");
  const voidFighter = game.combat.fighters.find((fighter) => fighter.unit.type === "RC");
  assert.equal(solarFighter.controller, "p1");
  assert.equal(voidFighter.controller, "ai");
  assert.equal(
    solarFighter.specialCooldown,
    UNIT_DEFS.PS.special.cooldown * 0.5,
  );

  const preCooldown = solarFighter.attackCooldown;
  updateCombat(game, { ...idleActions, p1Attack: true }, 0.016, 0, audio);
  assert.equal(solarFighter.attackCooldown, preCooldown);
}

function testBoardAiPriorities() {
  const immediateWin = makeGame("ai", "hard");
  immediateWin.turn = FACTIONS.VOID;
  immediateWin.units = [
    unit("NO", 0, 4),
    unit("EC", 4, 0),
    unit("GW", 4, 4),
    unit("CB", 4, 8),
    unit("RC", 7, 4),
  ];
  let action = chooseBoardAiAction(immediateWin, () => 0);
  assert.equal(action.kind, "move");
  assert.deepEqual([action.move.row, action.move.col], [8, 4]);

  const block = makeGame("ai", "hard");
  block.turn = FACTIONS.VOID;
  block.units = [
    unit("NO", 0, 0),
    unit("RC", 7, 4),
    unit("CC", 0, 4),
    unit("PS", 4, 0),
    unit("AS", 4, 4),
    unit("SD", 4, 8),
  ];
  action = chooseBoardAiAction(block, () => 0);
  assert.equal(action.kind, "move");
  assert.deepEqual([action.move.row, action.move.col], [4, 4]);
  assert.equal(action.move.attack, true);

  const commandCapture = makeGame("ai", "standard");
  commandCapture.turn = FACTIONS.VOID;
  commandCapture.units = [
    unit("NO", 0, 0),
    unit("EC", 0, 4),
    unit("CC", 4, 4),
  ];
  action = chooseBoardAiAction(commandCapture, () => 0);
  assert.equal(action.kind, "move");
  assert.deepEqual([action.move.row, action.move.col], [4, 4]);

  const support = makeGame("ai", "standard");
  support.turn = FACTIONS.VOID;
  support.units = [
    unit("NO", 0, 4),
    unit("CB", 4, 4),
    unit("PS", 5, 4, { hp: 60 }),
    unit("CC", 8, 4),
  ];
  action = chooseBoardAiAction(support, () => 0);
  assert.equal(action.kind, "ability");
  assert.equal(action.unitId, support.units[1].id);

  const medicSupport = makeGame("pvp", "standard");
  medicSupport.turn = FACTIONS.SOLAR;
  medicSupport.units = [
    unit("CC", 8, 4),
    unit("PM", 4, 4),
    unit("PS", 5, 4, { hp: 20 }),
    unit("NO", 0, 4),
  ];
  action = chooseBoardAiAction(medicSupport, () => 0);
  assert.equal(action.kind, "ability");
  assert.equal(action.unitId, medicSupport.units[1].id);
  assert.equal(action.targetId, medicSupport.units[2].id);

  const commandPower = makeGame("ai", "standard");
  commandPower.turn = FACTIONS.VOID;
  commandPower.commandCharge.V = 1;
  commandPower.units = [
    unit("NO", 0, 4),
    unit("RC", 3, 3, { hp: 30 }),
    unit("CC", 8, 4),
  ];
  action = chooseBoardAiAction(commandPower, () => 0);
  assert.equal(action.kind, "command");
  assert.equal(action.power, "fieldRepair");
}

function testDifficultyReplySearch() {
  function makeSearchGame(difficulty) {
    const game = makeGame("ai", difficulty);
    game.turn = FACTIONS.VOID;
    game.units = [
      unit("NO", 8, 3, { id: "NO" }),
      unit("RC", 6, 2, { id: "RC" }),
      unit("EC", 8, 8, { id: "EC" }),
      unit("CC", 3, 3, { id: "CC" }),
      unit("AS", 3, 0, { id: "AS" }),
      unit("PS", 5, 6, { id: "PS" }),
    ];
    return game;
  }

  const easy = chooseBoardAiAction(makeSearchGame("easy"), () => 0);
  const standard = chooseBoardAiAction(makeSearchGame("standard"), () => 0);
  const exposesCommand = (difficulty, action) => {
    const game = makeSearchGame(difficulty);
    moveUnitTo(game.units.find((unit) => unit.id === action.unitId), action.move.row, action.move.col);
    return game.units.filter((unit) => UNIT_DEFS[unit.type].faction === FACTIONS.SOLAR)
      .some((unit) => legalMovesForUnit(game, unit).some((move) => move.targetId === "NO"));
  };
  assert.equal(exposesCommand("easy", easy), true, "Greedy Easy move leaves a command capture");
  assert.equal(exposesCommand("standard", standard), false,
    "Standard reply search must prevent a command capture, by interposing or escaping");
}

function testBoardAiProgress() {
  const game = makeGame("ai", "hard");
  spawnInitialUnits(game);
  game.commandCharge = { S: 3, V: 3 };
  for (const faction of [FACTIONS.SOLAR, FACTIONS.VOID]) {
    game.turn = faction;
    const action = chooseBoardAiAction(game, () => 0);
    assert.notEqual(action.power, "gridLock", "AI must not lock an empty or uncontested square");
  }
  game.units = [unit("CC", 8, 4), unit("NO", 0, 4)];
  for (const faction of [FACTIONS.SOLAR, FACTIONS.VOID]) {
    game.turn = faction;
    const action = chooseBoardAiAction(game, () => 0);
    assert.equal(action.kind, "move");
    assert.equal(action.move.col, 4);
    assert.equal(action.move.row, faction === FACTIONS.SOLAR ? 7 : 1,
      "Lone commanders must advance toward the only possible win condition");
  }
  game.turn = FACTIONS.SOLAR;
  game.turnCount += 1;
  game.units = [unit("CC", 4, 4), unit("NO", 2, 4)];
  const approach = chooseBoardAiAction(game, () => 0);
  assert.equal(approach.move.row, 3,
    "Two-commander endgame must accept entering duel range instead of circling forever");
}

function testFactionAggregateBalance() {
  const totals = {};
  for (const faction of [FACTIONS.SOLAR, FACTIONS.VOID]) {
    const defs = Object.values(UNIT_DEFS).filter((def) => def.faction === faction);
    totals[faction] = {
      hp: defs.reduce((sum, def) => sum + def.maxHp, 0),
      dps: defs.reduce((sum, def) => sum + def.attack.damage / def.attack.cooldown, 0),
      speed: defs.reduce((sum, def) => sum + def.speed, 0),
      boardMobility: defs.reduce((sum, def) => sum + def.boardMovement.maxSteps, 0),
    };
  }

  for (const key of ["hp", "dps", "speed", "boardMobility"]) {
    const ratio = totals.S[key] / totals.V[key];
    assert.ok(ratio >= 0.9 && ratio <= 1.1, `${key} aggregate should remain within 10%`);
  }
}

function makeFakeUiDocument() {
  const refs = new Map();
  const makeRef = () => {
    const children = new Map();
    const attributes = new Map();
    const classes = new Set();
    return {
      classList: {
        toggle(name, enabled) { if (enabled) classes.add(name); else classes.delete(name); },
        contains(name) { return classes.has(name); },
      },
      querySelector(selector) { if (!children.has(selector)) children.set(selector, makeRef()); return children.get(selector); },
      setAttribute(name, value) { attributes.set(name, value); },
      getAttribute(name) { return attributes.get(name); },
      innerHTML: "",
      style: {},
      textContent: "",
      hidden: false,
      disabled: false,
    };
  };

  return {
    getElementById(id) {
      if (!refs.has(id)) {
        refs.set(id, makeRef());
      }
      return refs.get(id);
    },
  };
}

function testCombatHudUsesControllerOwnership() {
  const ui = new UIController(makeFakeUiDocument());
  const game = {
    combat: {
      countdown: 0,
      message: "Fight!",
      modText: "◇ Neutral Grid",
      paused: false,
      touch: {
        p1AttackLabel: "AS",
        p1SpecialLabel: "AS",
        p2AttackLabel: "EC",
        p2SpecialLabel: "EC",
      },
      fighters: [
        {
          controller: "p2",
          hp: 76,
          label: "Entropy Cannon · Void Core",
          controlHint: "Void Core · Arrows aim/move",
          maxHp: 92,
          attackCooldown: 0.5,
          attackCooldownMax: 1,
          specialCooldown: 3,
          specialCooldownMax: 6,
          specialLabel: "Entropy Shell: Heavy projectile.",
        },
        {
          controller: "p1",
          hp: 70,
          label: "Arc Sniper · Solar Protocol",
          controlHint: "Solar Protocol · WASD aim/move",
          maxHp: 70,
          attackCooldown: 0,
          attackCooldownMax: 0.8,
          specialCooldown: 0,
          specialCooldownMax: 6,
          specialLabel: "Arc Lance: Charged shot.",
        },
      ],
    },
  };

  ui.updateCombatHud(game);

  assert.equal(ui.refs.p1Name.textContent, "Arc Sniper");
  assert.equal(ui.refs.p2Name.textContent, "Entropy Cannon");
  assert.equal(ui.refs.p1Role.textContent, "P1 · SOLAR");
  assert.equal(ui.refs.p2Role.textContent, "P2 · VOID");
  assert.equal(ui.refs.p1SpecialName.textContent, "Arc Lance");
  assert.equal(ui.refs.p2SpecialName.textContent, "Entropy Shell");
  assert.equal(ui.refs.atk1.querySelector(".actionName").textContent, "HOLD FIRE");
  assert.equal(ui.refs.atk2.querySelector(".actionName").textContent, "P2 FIRE");
  assert.match(ui.refs.atk1.getAttribute("aria-label"), /^Solar:/);
  assert.match(ui.refs.atk2.getAttribute("aria-label"), /^Void:/);
  assert.equal(ui.refs.sp1.querySelector(".actionName").textContent, "Arc Lance");
  assert.equal(ui.refs.sp2.querySelector(".actionName").textContent, "Entropy Shell");
  assert.equal(ui.refs.sp1.querySelector(".actionHint").textContent, "Ready");
  assert.equal(ui.refs.sp2.querySelector(".actionHint").textContent, "3.0s");
  assert.equal(ui.refs.sp1.classList.contains("is-ready"), true);
  assert.equal(ui.refs.sp2.classList.contains("is-ready"), false);
  assert.equal(ui.refs.p1HP.style.width, "100%");
  assert.equal(ui.refs.p2HP.style.width, `${(76 / 92) * 100}%`);
  assert.equal(ui.refs.p1AttackCD.style.width, "100%");
  assert.equal(ui.refs.p2AttackCD.style.width, "50%");
  game.combat.fighters[0].controller = "ai";
  ui.updateCombatHud(game, {lastDevice: "touch"});
  assert.equal(ui.refs.p1Name.textContent, "Arc Sniper", "Solar ownership must not swap with attacker order");
  assert.equal(ui.refs.p1Role.textContent, "YOU · SOLAR");
  assert.equal(ui.refs.p2Role.textContent, "AI · VOID");
  assert.equal(ui.refs.p2TouchGroup.hidden, true);
  assert.equal(ui.refs.stick2.hidden, true);
}

function run() {
  testBoardFoundation();
  testFluxRoundTimingAndLocks();
  testNodeHealingChargeAndVictory();
  testCommandPowersAndCosts();
  testCorruptorWeaknessDuration();
  testMovementAndWinRules();
  testEnergyModifiers();
  testDirectionalCombatGeometry();
  testProjectileRange();
  testCorruptorSpreadSpecial();
  testBlinkInvulnerabilityAndOvertime();
  testInitialCombatStateAndOwnership();
  testBoardAiPriorities();
  testDifficultyReplySearch();
  testBoardAiProgress();
  testFactionAggregateBalance();
  testCombatHudUsesControllerOwnership();
  console.log("sanity-tests: ok");
}

run();
