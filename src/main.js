// SPDX-License-Identifier: GPL-3.0-or-later
import {
  applyDuelResolutionToBoard,
  canSelectUnit,
  checkCommandWinner,
  checkPowerNodeWinner,
  clearSelection,
  createBoardGrid,
  getUnitAt,
  getUnitById,
  legalMovesForUnit,
  markWinner,
  nextTurn,
  spawnInitialUnits,
  tryBoardAbility,
  decayWeakEffects,
} from "./board.js";
import { updateCombat, startCombat } from "./combat.js";
import { updateDebugSnapshot, fpsMeter } from "./debug.js";
import { InputManager } from "./input.js";
import { AudioManager } from "./audio.js";
import { installPlatformGuards } from "./platform.js";
import { Renderer } from "./render.js";
import { BoardTurnState, TopLevelState, createInitialState, pushLog, setBoardTurnState, transitionTopState } from "./state.js";
import { chooseBoardAiMove } from "./ai.js";
import { UIController } from "./ui.js";
import { FACTION_NAMES, POWER_NODES, enemyFaction } from "./utils.js";

const ui = new UIController(document);
const boardCanvas = document.getElementById("board");
const arenaCanvas = document.getElementById("arena");
const renderer = new Renderer(boardCanvas, arenaCanvas);
const platform = installPlatformGuards(document.getElementById("gameRoot"));

let game = createInitialState("ai");
const audio = new AudioManager(() => game.muted);
const fpsTick = fpsMeter();
let helpReturnState = TopLevelState.TITLE;

const input = new InputManager({
  getTopState: () => game.topState,
});

input.bindStick(document.getElementById("stick1"), "p1");
input.bindStick(document.getElementById("stick2"), "p2");
input.bindTouchButton(document.getElementById("atk1"), "p1", "attack");
input.bindTouchButton(document.getElementById("sp1"), "p1", "special");
input.bindTouchButton(document.getElementById("atk2"), "p2", "attack");
input.bindTouchButton(document.getElementById("sp2"), "p2", "special");

function startNewGame(mode) {
  game = createInitialState(mode);
  game.board = createBoardGrid();
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
  game = createInitialState("ai");
  transitionTopState(game, TopLevelState.TITLE, "return title");
  helpReturnState = TopLevelState.TITLE;
  input.resetAll();
  syncUi();
}

function setHelpVisible(on) {
  if (on) {
    helpReturnState = game.topState;
    ui.toggleHelp(true);
    transitionTopState(game, TopLevelState.HELP, "open help");
  } else {
    ui.toggleHelp(false);
    transitionTopState(game, helpReturnState, "close help");
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

  const result = nextTurn(game);
  decayWeakEffects(game);
  setBoardTurnState(game, BoardTurnState.AWAITING_SELECTION, "turn switched");
  if (result.shifted) {
    pushLog(game, "Some unstable grid squares shifted polarity.", "info");
  }

  if (game.mode === "ai" && game.turn === "V") {
    game.aiDelayTicks = 25;
    setBoardTurnState(game, BoardTurnState.AI_THINKING, "void ai turn");
    pushLog(game, "Void Core calculating...", "info");
  }
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
    selected.row = row;
    selected.col = col;
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

  const choice = chooseBoardAiMove(game);
  if (!choice) {
    game.turn = enemyFaction(game.turn);
    pushLog(game, "Void Core skipped turn.", "info");
    return;
  }

  const actor = getUnitById(game, choice.unitId);
  if (!actor) {
    return;
  }

  if (choice.move.attack) {
    const target = getUnitById(game, choice.move.targetId);
    if (!target) {
      return;
    }
    startDuelFromBoard(actor, target, choice.move.row, choice.move.col);
    return;
  }

  actor.row = choice.move.row;
  actor.col = choice.move.col;
  pushLog(game, `Void Core moved ${actor.type}.`, "info");
  audio.beep("move");
  endTurnFlow();
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
    startNewGame(game.mode);
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
  ui.updateBoardHud(game, renderer.buildSelectedInfo(game), renderer.buildPowerNodeInfo(game));
  syncQaBridge();
}

function draw() {
  if (game.topState === TopLevelState.BOARD || game.topState === TopLevelState.HELP) {
    renderer.drawBoard(game);
  }
  if (game.combat) {
    renderer.drawCombat(game);
  }

  if (game.debug.enabled) {
    const summary = [
      `Top: ${game.topState}`,
      `Board Turn: ${game.boardTurnState}`,
      `Turn: ${FACTION_NAMES[game.turn]} (${game.turnCount})`,
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
  document.getElementById("newAI2").addEventListener("click", () => startNewGame("ai"));
  document.getElementById("newPVP").addEventListener("click", () => startNewGame("pvp"));

  document.getElementById("endRestartAI").addEventListener("click", () => startNewGame("ai"));
  document.getElementById("endRestartPVP").addEventListener("click", () => startNewGame("pvp"));

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
      startNewGame(game.mode);
    }
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
    turn: game.turn,
    turnName: FACTION_NAMES[game.turn],
    turnCount: game.turnCount,
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
            attackCooldown: fighter.attackCooldown,
            specialCooldown: fighter.specialCooldown,
            specialCooldownMax: fighter.specialCooldownMax,
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
      POWER_NODES.forEach(([row, col], index) => {
        if (units[index]) {
          units[index].row = row;
          units[index].col = col;
        }
      });
      game.turn = faction;
      return qaFlush();
    },
    forceEndTurn() {
      endTurnFlow();
      return qaFlush();
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
