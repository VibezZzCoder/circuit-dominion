// SPDX-License-Identifier: GPL-3.0-or-later
import { FACTIONS } from "./utils.js";

export const TopLevelState = {
  TITLE: "title",
  BOARD: "board",
  BOARD_ANIMATING: "boardAnimating",
  COMBAT_INTRO: "combatIntro",
  COMBAT_COUNTDOWN: "combatCountdown",
  COMBAT_ACTIVE: "combatActive",
  COMBAT_RESOLVING: "combatResolving",
  PAUSED: "paused",
  HELP: "help",
  GAME_OVER: "gameOver",
};

export const BoardTurnState = {
  AWAITING_SELECTION: "awaitingSelection",
  UNIT_SELECTED: "unitSelected",
  AWAITING_DESTINATION: "awaitingDestination",
  RESOLVING_MOVE: "resolvingMove",
  STARTING_COMBAT: "startingCombat",
  APPLYING_BOARD_ABILITY: "applyingBoardAbility",
  CHECKING_WIN: "checkingWin",
  AI_THINKING: "aiThinking",
};

export const FighterState = {
  IDLE: "idle",
  MOVE: "move",
  ATTACK_STARTUP: "attackStartup",
  ATTACK_ACTIVE: "attackActive",
  ATTACK_RECOVERY: "attackRecovery",
  SPECIAL_STARTUP: "specialStartup",
  SPECIAL_ACTIVE: "specialActive",
  SPECIAL_RECOVERY: "specialRecovery",
  SHIELDED: "shielded",
  PHASING: "phasing",
  STUNNED: "stunned",
  HURT: "hurt",
  DEAD: "dead",
};

export function createInitialState(mode = "ai") {
  return {
    mode,
    turn: FACTIONS.SOLAR,
    topState: TopLevelState.TITLE,
    boardTurnState: BoardTurnState.AWAITING_SELECTION,
    previousTopState: null,
    turnCount: 1,
    board: [],
    units: [],
    selectedUnitId: null,
    legalMoves: [],
    message: "Ready.",
    messageKind: "info",
    muted: false,
    winner: null,
    winReason: "",
    combat: null,
    aiDelayTicks: 0,
    logs: [],
    debug: {
      enabled: false,
      showRanges: false,
      showLegal: true,
      showAiScores: false,
      slowMo: false,
      forceDuel: false,
      fps: 0,
      frameMs: 0,
      transitions: [],
      inputSnapshot: {},
      lastAiDecision: "",
    },
  };
}

export function pushLog(game, text, kind = "info") {
  game.message = text;
  game.messageKind = kind;
  game.logs.push({ time: Date.now(), text, kind });
  if (game.logs.length > 80) {
    game.logs.shift();
  }
}

export function transitionTopState(game, nextState, reason) {
  if (game.topState === nextState) {
    return;
  }
  const prev = game.topState;
  game.previousTopState = prev;
  game.topState = nextState;
  const entry = `${prev} -> ${nextState}${reason ? ` (${reason})` : ""}`;
  game.debug.transitions.push(entry);
  if (game.debug.transitions.length > 50) {
    game.debug.transitions.shift();
  }
}

export function setBoardTurnState(game, nextState, reason) {
  if (game.boardTurnState === nextState) {
    return;
  }
  const prev = game.boardTurnState;
  game.boardTurnState = nextState;
  const entry = `board:${prev} -> ${nextState}${reason ? ` (${reason})` : ""}`;
  game.debug.transitions.push(entry);
  if (game.debug.transitions.length > 50) {
    game.debug.transitions.shift();
  }
}
