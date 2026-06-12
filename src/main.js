// SPDX-License-Identifier: GPL-3.0-or-later
import {
  applyEmergencyRelay,
  applyFieldRepair,
  applyGridLock,
  applyDuelResolutionToBoard,
  canSelectUnit,
  canUseCommandPower,
  checkCommandWinner,
  checkPowerNodeWinner,
  clearSelection,
  createBoardGrid,
  getLivingCommandUnit,
  getPowerNodeControl,
  getPowerNodeThreat,
  getUnitAt,
  getUnitById,
  legalMovesForUnit,
  markWinner,
  moveUnitTo,
  nextTurn,
  relayDestinationsForUnit,
  spawnInitialUnits,
  tryBoardAbility,
} from "./board.js";
import { updateCombat, startCombat } from "./combat.js";
import { updateDebugSnapshot, fpsMeter } from "./debug.js";
import { InputManager } from "./input.js";
import { AudioManager } from "./audio.js";
import { AssetManager } from "./assets.js";
import { installPlatformGuards } from "./platform.js";
import { Renderer } from "./render.js";
import { BoardTurnState, TopLevelState, createInitialState, pushLog, setBoardTurnState, transitionTopState } from "./state.js";
import { chooseBoardAiAction } from "./ai.js";
import { UIController } from "./ui.js";
import { DIFFICULTY_SETTINGS, FACTION_NAMES, POWER_NODES, normalizeDifficulty } from "./utils.js";
import { UNIT_DEFS } from "./units.js";

const ui = new UIController(document);
const boardCanvas = document.getElementById("board");
const arenaCanvas = document.getElementById("arena");
const assets = new AssetManager();
assets.ready.then(() => assets.applyTitleBackgrounds());
const renderer = new Renderer(boardCanvas, arenaCanvas, assets);
const platform = installPlatformGuards(document.getElementById("gameRoot"));

let game = createInitialState("ai");
const audio = new AudioManager(() => game.muted);
const unlockAudio = (event) => {
  if (!event.isTrusted) {
    return;
  }
  audio.unlock();
  window.removeEventListener("pointerdown", unlockAudio, true);
  window.removeEventListener("keydown", unlockAudio, true);
};
window.addEventListener("pointerdown", unlockAudio, true);
window.addEventListener("keydown", unlockAudio, true);
const fpsTick = fpsMeter();
let helpReturnState = TopLevelState.TITLE;
let helpPausedCombat = false;

const input = new InputManager({
  getTopState: () => game.topState,
});

input.bindStick(document.getElementById("stick1"), "p1");
input.bindStick(document.getElementById("stick2"), "p2");
input.bindTouchButton(document.getElementById("atk1"), "p1", "attack");
input.bindTouchButton(document.getElementById("sp1"), "p1", "special");
input.bindTouchButton(document.getElementById("atk2"), "p2", "attack");
input.bindTouchButton(document.getElementById("sp2"), "p2", "special");

function selectedDifficulty() {
  return normalizeDifficulty(document.getElementById("difficultySelect")?.value || game.difficulty);
}

function startNewGame(mode, difficulty = selectedDifficulty()) {
  game = createInitialState(mode, normalizeDifficulty(difficulty));
  game.board = createBoardGrid(game.fluxPhase);
  spawnInitialUnits(game);
  transitionTopState(game, TopLevelState.BOARD, "start game");
  setBoardTurnState(game, BoardTurnState.AWAITING_SELECTION, "new game");
  pushLog(game, "Solar Protocol begins. Select a robot.", "info");
  helpReturnState = TopLevelState.BOARD;
  input.resetAll();
  syncUi();
  platform.focusGame();
}

function returnToTitle() {
  game = createInitialState("ai", selectedDifficulty());
  transitionTopState(game, TopLevelState.TITLE, "return title");
  helpReturnState = TopLevelState.TITLE;
  input.resetAll();
  syncUi();
}

function setHelpVisible(on) {
  if (on) {
    helpReturnState = game.topState;
    // Freeze an active duel behind the overlay so the fight does not keep
    // dealing damage (and so the combat-state sync does not flip topState off HELP).
    helpPausedCombat = Boolean(game.combat && !game.combat.paused);
    if (helpPausedCombat) {
      game.combat.paused = true;
    }
    ui.toggleHelp(true);
    transitionTopState(game, TopLevelState.HELP, "open help");
  } else {
    ui.toggleHelp(false);
    transitionTopState(game, helpReturnState, "close help");
    if (helpPausedCombat && game.combat) {
      game.combat.paused = false;
    }
    helpPausedCombat = false;
  }
}

function setGameOver(winner, reason) {
  markWinner(game, winner, reason);
  transitionTopState(game, TopLevelState.GAME_OVER, "win condition");
  pushLog(game, reason, "info");
  audio.beep("win");
  syncUi();
}

function endTurnFlow() {
  clearSelection(game);
  const nodeWinner = checkPowerNodeWinner(game);
  if (nodeWinner) {
    setGameOver(nodeWinner, "all Power Nodes were occupied at the end of the turn");
    return;
  }

  const commandWinner = checkCommandWinner(game);
  if (commandWinner) {
    setGameOver(commandWinner.winner, commandWinner.reason);
    return;
  }

  const endingFaction = game.turn;
  const result = nextTurn(game);
  setBoardTurnState(game, BoardTurnState.AWAITING_SELECTION, "turn switched");
  const updates = [];
  if (result.healed.length) {
    updates.push(`${FACTION_NAMES[endingFaction]} node repair activated`);
  }
  if (result.shifted) {
    updates.push("Flux grid advanced");
    const solarGain = result.gained.S;
    const voidGain = result.gained.V;
    if (solarGain || voidGain) {
      updates.push(`Command +${solarGain} Solar / +${voidGain} Void`);
    }
  }
  const threat = getPowerNodeThreat(game);
  if (threat) {
    updates.push(`${FACTION_NAMES[threat]} controls four Power Nodes`);
  }
  if (updates.length) {
    pushLog(game, `${updates.join(" · ")}.`, threat ? "bad" : "info");
  }

  if (game.mode === "ai" && game.turn === "V") {
    game.aiDelayTicks = Math.round(DIFFICULTY_SETTINGS[game.difficulty].reactionMs / 16);
    setBoardTurnState(game, BoardTurnState.AI_THINKING, "void ai turn");
    pushLog(game, "Void Core calculating...", "info");
  }
}

function beginCommandPower(power) {
  if (
    game.topState !== TopLevelState.BOARD ||
    (game.mode === "ai" && game.turn === "V") ||
    !canUseCommandPower(game, game.turn, power)
  ) {
    pushLog(game, "That Command power is not available.", "bad");
    audio.beep("bad");
    return;
  }
  game.selectedUnitId = null;
  game.legalMoves = [];
  game.boardAction = { type: power, sourceUnitId: null };
  const instructions = {
    gridLock: "Grid Lock: choose any dashed Flux square.",
    fieldRepair: "Field Repair: choose a damaged non-command ally.",
    emergencyRelay: "Emergency Relay: choose a non-command ally.",
  };
  pushLog(game, instructions[power], "info");
  audio.beep("special");
}

function handleBoardCommandClick(row, col, clickedUnit) {
  const action = game.boardAction;
  if (!action) {
    return false;
  }
  let result = { applied: false };
  if (action.type === "gridLock") {
    result = applyGridLock(game, game.turn, row, col);
  } else if (action.type === "fieldRepair") {
    result = applyFieldRepair(game, game.turn, clickedUnit);
  } else if (action.type === "emergencyRelay") {
    if (!action.sourceUnitId) {
      const source = clickedUnit;
      if (
        !source ||
        !source.alive ||
        UNIT_DEFS[source.type].faction !== game.turn ||
        UNIT_DEFS[source.type].isCommandUnit
      ) {
        pushLog(game, "Choose one of your non-command robots.", "bad");
        audio.beep("bad");
        return true;
      }
      action.sourceUnitId = source.id;
      game.legalMoves = relayDestinationsForUnit(game, source);
      pushLog(game, "Emergency Relay: choose a highlighted adjacent empty non-node square.", "info");
      return true;
    }
    result = applyEmergencyRelay(
      game,
      game.turn,
      getUnitById(game, action.sourceUnitId),
      row,
      col,
    );
  }

  if (!result.applied) {
    pushLog(game, "Invalid target for that Command power.", "bad");
    audio.beep("bad");
    return true;
  }
  pushLog(game, result.message, "info");
  audio.beep("special");
  endTurnFlow();
  return true;
}

function startDuelFromBoard(attacker, defender, row, col) {
  transitionTopState(game, TopLevelState.COMBAT_INTRO, "duel started");
  setBoardTurnState(game, BoardTurnState.STARTING_COMBAT, "move into attack");
  startCombat(game, attacker, defender, row, col);
  input.resetAll();
  audio.beep("attack");
  renderer.resizeArena();
}

function handleBoardClick(row, col) {
  if (game.topState !== TopLevelState.BOARD) {
    return;
  }
  if (game.mode === "ai" && game.turn === "V") {
    return;
  }

  const clickedUnit = getUnitAt(game, row, col);
  if (handleBoardCommandClick(row, col, clickedUnit)) {
    return;
  }
  const selected = getUnitById(game, game.selectedUnitId);

  if (!selected) {
    if (canSelectUnit(game, clickedUnit)) {
      game.selectedUnitId = clickedUnit.id;
      game.legalMoves = legalMovesForUnit(game, clickedUnit);
      setBoardTurnState(game, BoardTurnState.UNIT_SELECTED, "unit selected");
      pushLog(game, `${clickedUnit.type} selected. Choose highlighted move.`, "info");
      audio.beep("move");
      return;
    }

    pushLog(game, "Select one of your active robots.", "bad");
    audio.beep("bad");
    return;
  }

  if (clickedUnit && canSelectUnit(game, clickedUnit) && clickedUnit.id !== selected.id) {
    game.selectedUnitId = clickedUnit.id;
    game.legalMoves = legalMovesForUnit(game, clickedUnit);
    setBoardTurnState(game, BoardTurnState.UNIT_SELECTED, "switch selected unit");
    return;
  }

  const boardAbility = tryBoardAbility(game, selected, clickedUnit);
  if (boardAbility.applied) {
    pushLog(game, boardAbility.message, "info");
    audio.beep("special");
    endTurnFlow();
    return;
  }

  const legal = game.legalMoves.find((m) => m.row === row && m.col === col);
  if (!legal) {
    pushLog(game, `Invalid move for ${selected.type}. Highlighted squares are legal.`, "bad");
    audio.beep("bad");
    return;
  }

  setBoardTurnState(game, BoardTurnState.RESOLVING_MOVE, "legal move chosen");
  if (legal.attack) {
    const defender = getUnitById(game, legal.targetId);
    if (!defender) {
      pushLog(game, "Target unit no longer exists.", "bad");
      return;
    }
    startDuelFromBoard(selected, defender, row, col);
  } else {
    moveUnitTo(selected, row, col);
    pushLog(game, `${selected.type} moved.`, "info");
    audio.beep("move");
    endTurnFlow();
  }
}

function runBoardAiTick() {
  if (game.mode !== "ai" || game.turn !== "V" || game.topState !== TopLevelState.BOARD) {
    return;
  }

  if (game.aiDelayTicks > 0) {
    game.aiDelayTicks -= 1;
    return;
  }

  const choice = chooseBoardAiAction(game);
  executeBoardAiChoice(choice);
}

function executeBoardAiChoice(choice) {
  const factionName = FACTION_NAMES[game.turn];
  if (!choice) {
    pushLog(game, `${factionName} skipped turn.`, "info");
    endTurnFlow();
    return "turn";
  }

  if (choice.kind === "ability") {
    const actor = getUnitById(game, choice.unitId);
    const target = getUnitById(game, choice.targetId);
    const result = tryBoardAbility(game, actor, target);
    if (result.applied) {
      pushLog(game, result.message, "info");
      audio.beep("special");
      endTurnFlow();
      return "turn";
    }
  }

  if (choice.kind === "command") {
    let result = { applied: false };
    if (choice.power === "gridLock") {
      result = applyGridLock(game, game.turn, choice.row, choice.col);
    } else if (choice.power === "fieldRepair") {
      result = applyFieldRepair(game, game.turn, getUnitById(game, choice.targetId));
    } else if (choice.power === "emergencyRelay") {
      result = applyEmergencyRelay(
        game,
        game.turn,
        getUnitById(game, choice.unitId),
        choice.row,
        choice.col,
      );
    }
    if (result.applied) {
      pushLog(game, `${factionName} used ${result.message}`, "info");
      audio.beep("special");
      endTurnFlow();
      return "turn";
    }
  }

  const actor = getUnitById(game, choice.unitId);
  if (!actor || choice.kind !== "move") {
    pushLog(game, `${factionName} held position.`, "info");
    endTurnFlow();
    return "turn";
  }

  if (choice.move.attack) {
    const target = getUnitById(game, choice.move.targetId);
    if (!target) {
      endTurnFlow();
      return "turn";
    }
    startDuelFromBoard(actor, target, choice.move.row, choice.move.col);
    return "combat";
  }

  moveUnitTo(actor, choice.move.row, choice.move.col);
  pushLog(game, `${factionName} moved ${actor.type}.`, "info");
  audio.beep("move");
  endTurnFlow();
  return "turn";
}

function handleGlobalActions(actions) {
  if (actions.toggleHelp) {
    const willOpen = !document.getElementById("helpOverlay").classList.contains("active");
    setHelpVisible(willOpen);
    input.resetAll();
  }

  if (actions.toggleDebug) {
    game.debug.enabled = !game.debug.enabled;
    ui.toggleDebug(game.debug.enabled);
    input.resetAll();
  }

  if (actions.restart && game.topState !== TopLevelState.TITLE) {
    startNewGame(game.mode, game.difficulty);
  }

  if (actions.pause && game.combat) {
    game.combat.paused = !game.combat.paused;
    if (game.combat.paused) {
      transitionTopState(game, TopLevelState.PAUSED, "combat pause");
      game.combat.message = "Paused";
    } else {
      transitionTopState(game, TopLevelState.COMBAT_ACTIVE, "combat resume");
      game.combat.message = "Fight!";
    }
    input.resetAll();
  }
}

function updateGame(deltaSec) {
  const actions = input.update();
  handleGlobalActions(actions);

  if (game.topState === TopLevelState.BOARD) {
    runBoardAiTick();
  }

  if (game.combat) {
    const result = updateCombat(game, actions, game.debug.slowMo ? deltaSec * 0.4 : deltaSec, performance.now(), audio);

    if (game.combat?.state === "combatCountdown") {
      transitionTopState(game, TopLevelState.COMBAT_COUNTDOWN, "combat countdown");
    } else if (game.combat?.state === "combatActive") {
      transitionTopState(game, TopLevelState.COMBAT_ACTIVE, "combat active");
    } else if (game.combat?.state === "combatResolving") {
      transitionTopState(game, TopLevelState.COMBAT_RESOLVING, "combat resolving");
    }

    if (result) {
      applyDuelResolutionToBoard(game, result);
      game.combat = null;
      transitionTopState(game, TopLevelState.BOARD, "combat ended");
      pushLog(game, result.reason, "info");
      input.resetAll();

      const commandWinner = checkCommandWinner(game);
      if (commandWinner) {
        setGameOver(commandWinner.winner, commandWinner.reason);
      } else {
        endTurnFlow();
      }
    }
  }

  const frame = fpsTick();
  game.debug.fps = frame.fps;
  game.debug.frameMs = frame.frameMs;
  updateDebugSnapshot(game, input, game.combat);
}

function syncUi() {
  if (game.topState === TopLevelState.HELP) {
    // Help is a modal overlay: keep whatever screen is underneath and do not
    // touch board/combat HUD (the board grid may be empty at the title).
    syncQaBridge();
    return;
  }

  if (game.topState === TopLevelState.TITLE) {
    ui.showScreen("titleScreen");
    syncQaBridge();
    return;
  }

  if (game.topState === TopLevelState.GAME_OVER) {
    ui.showScreen("endScreen");
    ui.updateEndScreen(game);
    syncQaBridge();
    return;
  }

  if (game.combat) {
    ui.showScreen("combatScreen");
    renderer.resizeArena();
    ui.updateCombatHud(game);
    syncQaBridge();
    return;
  }

  ui.showScreen("boardScreen");
  renderer.resizeBoard();
  ui.setLog(game.message, game.messageKind);
  game.nodeControl = getPowerNodeControl(game);
  game.commanderAlive = {
    S: Boolean(getLivingCommandUnit(game, "S")),
    V: Boolean(getLivingCommandUnit(game, "V")),
  };
  ui.updateBoardHud(game, renderer.buildSelectedInfo(game), renderer.buildPowerNodeInfo(game));
  syncQaBridge();
}

function draw() {
  const boardReady = Array.isArray(game.board) && game.board.length === 9;
  if (boardReady && (game.topState === TopLevelState.BOARD || game.topState === TopLevelState.HELP)) {
    renderer.drawBoard(game);
  }
  if (game.combat) {
    renderer.drawCombat(game);
  }

  if (game.debug.enabled) {
    const summary = [
      `Top: ${game.topState}`,
      `Board Turn: ${game.boardTurnState}`,
      `Turn: ${FACTION_NAMES[game.turn]} (${game.turnCount}) · Round ${game.roundCount}`,
      `Flux: ${game.fluxPhase} · Command S${game.commandCharge.S}/V${game.commandCharge.V}`,
      `FPS: ${game.debug.fps.toFixed(1)} (${game.debug.frameMs.toFixed(2)}ms)`,
      `AI: ${game.debug.lastAiDecision || "n/a"}`,
      `Input: ${JSON.stringify(game.debug.inputSnapshot.actions || {})}`,
      `Keys: ${(game.debug.inputSnapshot.keysPressed || []).join(", ") || "none"}`,
      `Recent transitions:`,
      ...(game.debug.transitions.slice(-6) || []),
    ];
    ui.updateDebugText(summary.join("\n"));
  }
}

let last = performance.now();
function loop(now) {
  const deltaSec = Math.min(0.033, (now - last) / 1000);
  last = now;
  updateGame(deltaSec);
  syncUi();
  draw();
  requestAnimationFrame(loop);
}

function bindUiButtons() {
  document.getElementById("newAI").addEventListener("click", () => startNewGame("ai"));
  document.getElementById("newAI2").addEventListener("click", () => {
    document.getElementById("difficultySelect").value = "hard";
    startNewGame("ai", "hard");
  });
  document.getElementById("newPVP").addEventListener("click", () => startNewGame("pvp"));

  document.getElementById("endRestartAI").addEventListener("click", () => startNewGame("ai", game.difficulty));
  document.getElementById("endRestartPVP").addEventListener("click", () => startNewGame("pvp", game.difficulty));

  document.getElementById("howBtn").addEventListener("click", () => {
    setHelpVisible(true);
  });
  document.getElementById("boardHelp").addEventListener("click", () => {
    setHelpVisible(true);
  });
  document.getElementById("endHelp").addEventListener("click", () => {
    setHelpVisible(true);
  });
  document.getElementById("closeHelp").addEventListener("click", () => {
    setHelpVisible(false);
  });

  document.getElementById("muteBtn").addEventListener("click", () => {
    game.muted = !game.muted;
    ui.setMuted(game.muted);
  });

  document.getElementById("restartBtn").addEventListener("click", () => {
    if (game.topState !== TopLevelState.TITLE) {
      startNewGame(game.mode, game.difficulty);
    }
  });

  document.getElementById("gridLockBtn").addEventListener("click", () => beginCommandPower("gridLock"));
  document.getElementById("fieldRepairBtn").addEventListener("click", () => beginCommandPower("fieldRepair"));
  document.getElementById("relayBtn").addEventListener("click", () => beginCommandPower("emergencyRelay"));
  document.getElementById("cancelCommandBtn").addEventListener("click", () => {
    game.boardAction = null;
    game.legalMoves = [];
    pushLog(game, "Command targeting cancelled.", "info");
  });

  document.getElementById("pauseBtn").addEventListener("click", () => {
    if (!game.combat) {
      return;
    }
    game.combat.paused = !game.combat.paused;
    if (game.combat.paused) {
      transitionTopState(game, TopLevelState.PAUSED, "combat pause button");
      game.combat.message = "Paused";
    } else {
      transitionTopState(game, TopLevelState.COMBAT_ACTIVE, "combat resume button");
      game.combat.message = "Fight!";
    }
    input.resetAll();
  });

  boardCanvas.addEventListener("pointerdown", (event) => {
    const { row, col } = renderer.boardPointToCell(event);
    if (row < 0 || row > 8 || col < 0 || col > 8) {
      return;
    }
    handleBoardClick(row, col);
  });

  window.addEventListener("resize", () => {
    renderer.resizeBoard();
    renderer.resizeArena();
  });
}

function buildQaSnapshot() {
  return {
    topState: game.topState,
    boardTurnState: game.boardTurnState,
    mode: game.mode,
    difficulty: game.difficulty,
    turn: game.turn,
    turnName: FACTION_NAMES[game.turn],
    turnCount: game.turnCount,
    roundCount: game.roundCount,
    fluxPhase: game.fluxPhase,
    commandCharge: { ...game.commandCharge },
    boardAction: game.boardAction ? { ...game.boardAction } : null,
    winner: game.winner,
    winReason: game.winReason,
    message: game.message,
    messageKind: game.messageKind,
    selectedUnitId: game.selectedUnitId,
    legalMoves: game.legalMoves.map((move) => ({
      row: move.row,
      col: move.col,
      attack: Boolean(move.attack),
      targetId: move.targetId || null,
    })),
    board: game.board.map((row) =>
      row.map((square) => ({
        energy: square.energy,
        flux: square.flux,
        node: square.node,
        lockFaction: square.lockFaction,
      })),
    ),
    boardCanvas: {
      width: boardCanvas.width,
      height: boardCanvas.height,
      clientWidth: boardCanvas.clientWidth,
      clientHeight: boardCanvas.clientHeight,
    },
    arenaCanvas: {
      width: arenaCanvas.width,
      height: arenaCanvas.height,
      clientWidth: arenaCanvas.clientWidth,
      clientHeight: arenaCanvas.clientHeight,
    },
    units: game.units.map((unit) => ({
      id: unit.id,
      type: unit.type,
      row: unit.row,
      col: unit.col,
      hp: unit.hp,
      maxHp: unit.maxHp,
      alive: unit.alive,
      weakTurns: unit.weakTurns,
    })),
    combat: game.combat
      ? {
          state: game.combat.state,
          countdown: game.combat.countdown,
          message: game.combat.message,
          modText: game.combat.modText,
          elapsedSec: game.combat.elapsedSec,
          overtimeMultiplier: game.combat.overtimeMultiplier,
          obstacles: game.combat.obstacles.map((obstacle) => ({ ...obstacle })),
          barriers: game.combat.barriers.map((barrier) => ({ ...barrier })),
          fighters: game.combat.fighters.map((fighter) => ({
            id: fighter.id,
            type: fighter.unit.type,
            controller: fighter.controller,
            label: fighter.label,
            controlHint: fighter.controlHint,
            x: fighter.x,
            y: fighter.y,
            hp: fighter.hp,
            maxHp: fighter.maxHp,
            facingX: fighter.facingX,
            facingY: fighter.facingY,
            attackCooldown: fighter.attackCooldown,
            attackCooldownMax: fighter.attackCooldownMax,
            specialCooldown: fighter.specialCooldown,
            specialCooldownMax: fighter.specialCooldownMax,
            specialLabel: fighter.specialLabel,
            invulnerableUntil: fighter.invulnerableUntil,
          })),
        }
      : null,
  };
}

function qaFlush() {
  syncUi();
  draw();
  const snapshot = buildQaSnapshot();
  writeQaBridge(snapshot);
  return snapshot;
}

function ensureQaBridge() {
  let host = document.getElementById("cdTestBridge");
  if (!host) {
    host = document.createElement("div");
    host.id = "cdTestBridge";
    host.setAttribute("aria-hidden", "true");
    Object.assign(host.style, {
      position: "fixed",
      left: "-9999px",
      top: "0",
      width: "1px",
      height: "1px",
      overflow: "hidden",
      opacity: "0",
      pointerEvents: "none",
      zIndex: "-1",
    });

    host.innerHTML = [
      '<textarea id="cdTestCommand" aria-label="Circuit Dominion QA command" style="width:12px;height:12px;padding:0;margin:0;border:0;"></textarea>',
      '<button id="cdTestRun" type="button" style="width:12px;height:12px;padding:0;margin:0;border:0;">Run QA</button>',
      '<script id="cdTestState" type="application/json"></script>',
    ].join("");

    document.body.appendChild(host);
  }

  let bridge = document.getElementById("cdTestState");
  if (!bridge) {
    bridge = document.createElement("script");
    bridge.id = "cdTestState";
    bridge.type = "application/json";
    bridge.hidden = true;
    host.appendChild(bridge);
  }
  return bridge;
}

function writeQaBridge(payload) {
  ensureQaBridge().textContent = JSON.stringify(payload);
}

function syncQaBridge() {
  const bridge = document.getElementById("cdTestState");
  if (bridge) {
    bridge.textContent = JSON.stringify(buildQaSnapshot());
  }
}

function qaMatchUnit(unit, match = {}) {
  if (!unit) {
    return false;
  }
  if (match.id && unit.id !== match.id) {
    return false;
  }
  if (match.type && unit.type !== match.type) {
    return false;
  }
  if (match.row !== undefined && unit.row !== match.row) {
    return false;
  }
  if (match.col !== undefined && unit.col !== match.col) {
    return false;
  }
  return true;
}

function createQaRng(seed = 1) {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 4294967296;
  };
}

function simulateQaCombat(rng) {
  if (!game.combat) {
    return false;
  }
  game.combat.rng = rng;
  for (const fighter of game.combat.fighters) {
    fighter.controller = "ai";
    fighter.aiIntent = null;
    fighter.aiNextDecisionAt = 0;
  }
  game.combat.countdown = 0;
  game.combat.state = "combatActive";

  const actions = {
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
  let now = game.combat.nowMs || 0;
  let result = null;
  for (let frame = 0; frame < 2700 && !result; frame += 1) {
    now += 1000 / 30;
    result = updateCombat(game, actions, 1 / 30, now, audio);
  }
  if (!result) {
    return false;
  }

  applyDuelResolutionToBoard(game, result);
  game.combat = null;
  transitionTopState(game, TopLevelState.BOARD, "QA combat ended");
  pushLog(game, result.reason, "info");
  input.resetAll();
  const commandWinner = checkCommandWinner(game);
  if (commandWinner) {
    setGameOver(commandWinner.winner, commandWinner.reason);
  } else {
    endTurnFlow();
  }
  return true;
}

function runQaAutomatedMatch(maxTurns = 180, seed = 24681357) {
  startNewGame("ai", "standard");
  const rng = createQaRng(seed);
  let turns = 0;
  let duels = 0;

  while (!game.winner && turns < maxTurns) {
    const choice = chooseBoardAiAction(game, rng);
    const outcome = executeBoardAiChoice(choice);
    turns += 1;
    if (outcome === "combat") {
      duels += 1;
      if (!simulateQaCombat(rng)) {
        break;
      }
    }
  }

  const snapshot = qaFlush();
  snapshot.qaAutoPlay = {
    turns,
    duels,
    completed: Boolean(game.winner),
  };
  return snapshot;
}

function installQaTestHook() {
  if (typeof window === "undefined") {
    return;
  }

  document.documentElement.dataset.cdTestReady = "1";
  window.__CD_TEST__ = {
    version: 1,
    getSnapshot: () => buildQaSnapshot(),
    startGame(mode = "ai") {
      startNewGame(mode);
      return qaFlush();
    },
    returnToTitle() {
      returnToTitle();
      return qaFlush();
    },
    setDuelAiEnabled(enabled) {
      document.getElementById("duelAIToggle").checked = Boolean(enabled);
      return buildQaSnapshot();
    },
    setDifficulty(difficulty) {
      game.difficulty = normalizeDifficulty(difficulty);
      return qaFlush();
    },
    setCommandCharge(faction, amount) {
      game.commandCharge[faction] = Math.max(0, Math.min(3, amount));
      return qaFlush();
    },
    beginCommand(power) {
      beginCommandPower(power);
      return qaFlush();
    },
    clickBoard(row, col) {
      handleBoardClick(row, col);
      return qaFlush();
    },
    selectUnit(match) {
      const unit = game.units.find((candidate) => qaMatchUnit(candidate, match) && candidate.alive);
      if (!unit) {
        return null;
      }
      handleBoardClick(unit.row, unit.col);
      return qaFlush();
    },
    moveSelectedTo(row, col) {
      handleBoardClick(row, col);
      return qaFlush();
    },
    setUnit(match, updates) {
      const unit = game.units.find((candidate) => qaMatchUnit(candidate, match));
      if (!unit) {
        return null;
      }
      Object.assign(unit, updates);
      return qaFlush();
    },
    setTurn(faction) {
      game.turn = faction;
      return qaFlush();
    },
    stepFrames(frames = 1, deltaSec = 1 / 60) {
      for (let i = 0; i < frames; i += 1) {
        updateGame(deltaSec);
      }
      return qaFlush();
    },
    startCombatByMatch(attackerMatch, defenderMatch, row, col) {
      const attacker = game.units.find((unit) => qaMatchUnit(unit, attackerMatch) && unit.alive);
      const defender = game.units.find((unit) => qaMatchUnit(unit, defenderMatch) && unit.alive);
      if (!attacker || !defender) {
        return null;
      }
      startDuelFromBoard(attacker, defender, row, col);
      return qaFlush();
    },
    resolveCombat(winner = "attacker") {
      if (!game.combat) {
        return null;
      }
      const [attacker, defender] = game.combat.fighters;
      attacker.hp = winner === "attacker" ? Math.max(1, attacker.hp) : 0;
      defender.hp = winner === "defender" ? Math.max(1, defender.hp) : 0;
      if (winner === "draw") {
        attacker.hp = 0;
        defender.hp = 0;
      }
      game.combat.countdown = 0;
      game.combat.state = "combatResolving";
      game.combat.resolveTimer = 0;
      return this.stepFrames(2, 1 / 60);
    },
    evaluateCurrentWinners() {
      const commandWinner = checkCommandWinner(game);
      if (commandWinner) {
        setGameOver(commandWinner.winner, commandWinner.reason);
        return qaFlush();
      }
      const nodeWinner = checkPowerNodeWinner(game);
      if (nodeWinner) {
        setGameOver(nodeWinner, "all Power Nodes were occupied at the end of the turn");
        return qaFlush();
      }
      return qaFlush();
    },
    occupyPowerNodes(faction) {
      const units = game.units.filter((unit) => unit.alive && ((faction === "S" && !["NO", "RC", "EC", "GW", "CB", "GB"].includes(unit.type)) || (faction === "V" && !["CC", "PS", "AS", "SD", "PM", "NW"].includes(unit.type))));
      const selected = units.slice(0, POWER_NODES.length);
      const selectedIds = new Set(selected.map((unit) => unit.id));
      const nodeKeys = new Set(POWER_NODES.map(([row, col]) => `${row},${col}`));
      for (const occupant of game.units) {
        if (
          !occupant.alive ||
          selectedIds.has(occupant.id) ||
          !nodeKeys.has(`${occupant.row},${occupant.col}`)
        ) {
          continue;
        }
        let destination = null;
        for (let row = 0; row < 9 && !destination; row += 1) {
          for (let col = 0; col < 9; col += 1) {
            if (!nodeKeys.has(`${row},${col}`) && !getUnitAt(game, row, col)) {
              destination = { row, col };
              break;
            }
          }
        }
        if (destination) {
          moveUnitTo(occupant, destination.row, destination.col);
        }
      }
      POWER_NODES.forEach(([row, col], index) => {
        if (selected[index]) {
          moveUnitTo(selected[index], row, col);
        }
      });
      game.turn = faction;
      return qaFlush();
    },
    forceEndTurn() {
      endTurnFlow();
      return qaFlush();
    },
    autoPlayFullMatch(maxTurns = 180, seed = 24681357) {
      return runQaAutomatedMatch(maxTurns, seed);
    },
  };

  ensureQaBridge();
  const runButton = document.getElementById("cdTestRun");
  const commandField = document.getElementById("cdTestCommand");

  runButton.addEventListener("click", () => {
    let payload = {};
    try {
      payload = JSON.parse(commandField.value || "{}");
    } catch (error) {
      writeQaBridge({ error: `Invalid QA command JSON: ${error}` });
      return;
    }

    const { action, args = [] } = payload;
    const fn = window.__CD_TEST__?.[action];

    try {
      const result = typeof fn === "function" ? fn(...args) : { error: `Unknown QA action: ${action}` };
      writeQaBridge({ action, result });
    } catch (error) {
      writeQaBridge({ action, error: String(error) });
    }
  });

  writeQaBridge(buildQaSnapshot());
}

bindUiButtons();
installQaTestHook();
renderer.resizeBoard();
renderer.resizeArena();
returnToTitle();
requestAnimationFrame(loop);
