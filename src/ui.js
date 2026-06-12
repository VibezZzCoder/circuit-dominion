// SPDX-License-Identifier: GPL-3.0-or-later
import { FACTION_NAMES } from "./utils.js";

export class UIController {
  constructor(root) {
    this.root = root;
    this.refs = this.collectRefs(root);
  }

  collectRefs(root) {
    const byId = (id) => root.getElementById(id);
    return {
      titleScreen: byId("titleScreen"),
      boardScreen: byId("boardScreen"),
      combatScreen: byId("combatScreen"),
      endScreen: byId("endScreen"),
      helpOverlay: byId("helpOverlay"),
      debugOverlay: byId("debugOverlay"),
      winnerTitle: byId("winnerTitle"),
      winnerReason: byId("winnerReason"),
      turnBadge: byId("turnBadge"),
      modeLabel: byId("modeLabel"),
      roundInfo: byId("roundInfo"),
      chargeInfo: byId("chargeInfo"),
      threatInfo: byId("threatInfo"),
      selectedInfo: byId("selectedInfo"),
      nodeInfo: byId("nodeInfo"),
      commandInfo: byId("commandInfo"),
      gridLockBtn: byId("gridLockBtn"),
      fieldRepairBtn: byId("fieldRepairBtn"),
      relayBtn: byId("relayBtn"),
      cancelCommandBtn: byId("cancelCommandBtn"),
      log: byId("log"),
      p1Name: byId("p1Name"),
      p2Name: byId("p2Name"),
      p1HP: byId("p1HP"),
      p2HP: byId("p2HP"),
      p1CD: byId("p1CD"),
      p2CD: byId("p2CD"),
      p1AttackCD: byId("p1AttackCD"),
      p2AttackCD: byId("p2AttackCD"),
      p1SpecialName: byId("p1SpecialName"),
      p2SpecialName: byId("p2SpecialName"),
      p1SpecialInfo: byId("p1SpecialInfo"),
      p2SpecialInfo: byId("p2SpecialInfo"),
      p1Hint: byId("p1Hint"),
      p2Hint: byId("p2Hint"),
      modText: byId("modText"),
      combatMsg: byId("combatMsg"),
      countdown: byId("countdown"),
      pauseBtn: byId("pauseBtn"),
      touchControls: byId("touchControls"),
      stick2: byId("stick2"),
      atk1: byId("atk1"),
      sp1: byId("sp1"),
      atk2: byId("atk2"),
      sp2: byId("sp2"),
      muteBtn: byId("muteBtn"),
      debugText: byId("debugText"),
    };
  }

  showScreen(screenId) {
    ["titleScreen", "boardScreen", "combatScreen", "endScreen"].forEach((id) => {
      this.refs[id].classList.toggle("active", id === screenId);
    });
  }

  toggleHelp(on) {
    this.refs.helpOverlay.classList.toggle("active", on);
  }

  toggleDebug(on) {
    this.refs.debugOverlay.classList.toggle("active", on);
  }

  setLog(text, kind = "info") {
    this.refs.log.textContent = text;
    this.refs.log.style.color = kind === "bad" ? "#ff8aa0" : "#ffdc63";
  }

  updateBoardHud(game, selectedText, nodeLabels) {
    const isSolarTurn = game.turn === "S";
    this.refs.turnBadge.innerHTML = `<span class="${isSolarTurn ? "solarText" : "voidText"}">${FACTION_NAMES[game.turn]}</span>`;
    this.refs.modeLabel.textContent = game.mode === "ai" ? `Player vs AI · ${game.difficulty}` : "Player vs Player";
    const fluxNames = ["Neutral", "Light", "Neutral", "Dark"];
    this.refs.roundInfo.textContent = `Round ${game.roundCount} · Flux: ${fluxNames[game.fluxPhase]}`;
    this.refs.chargeInfo.textContent = `Command: Solar ${game.commandCharge.S}/3 · Void ${game.commandCharge.V}/3`;
    const control = game.nodeControl || { S: 0, V: 0 };
    this.refs.threatInfo.textContent =
      control.S === 4 ? "Warning: Solar controls four nodes." :
      control.V === 4 ? "Warning: Void controls four nodes." : "";
    this.refs.selectedInfo.textContent = selectedText;
    this.refs.nodeInfo.innerHTML = nodeLabels.map((n) => `<span class="pill">${n}</span>`).join(" ");
    const actionName = game.boardAction?.type
      ? {
          gridLock: "Grid Lock: choose a Flux cell.",
          fieldRepair: "Field Repair: choose a damaged non-command ally.",
          emergencyRelay: game.boardAction.sourceUnitId
            ? "Emergency Relay: choose a highlighted adjacent destination."
            : "Emergency Relay: choose a non-command ally.",
        }[game.boardAction.type]
      : "Nodes charge tactical powers each round.";
    this.refs.commandInfo.textContent = actionName;
    const humanTurn = !(game.mode === "ai" && game.turn === "V");
    const commanderAlive = game.commanderAlive?.[game.turn] !== false;
    this.refs.gridLockBtn.disabled = !humanTurn || !commanderAlive || game.commandCharge[game.turn] < 1;
    this.refs.fieldRepairBtn.disabled = !humanTurn || !commanderAlive || game.commandCharge[game.turn] < 1;
    this.refs.relayBtn.disabled = !humanTurn || !commanderAlive || game.commandCharge[game.turn] < 2;
    this.refs.cancelCommandBtn.disabled = !game.boardAction;
  }

  updateCombatHud(game) {
    const combat = game.combat;
    if (!combat) {
      return;
    }

    const hudP1 = combat.fighters.find((fighter) => fighter.controller === "p1") || combat.fighters[0];
    const hudP2 = combat.fighters.find((fighter) => fighter !== hudP1 && (fighter.controller === "p2" || fighter.controller === "ai")) || combat.fighters.find((fighter) => fighter !== hudP1) || hudP1;

    this.refs.p1HP.style.width = `${Math.max(0, (hudP1.hp / hudP1.maxHp) * 100)}%`;
    this.refs.p2HP.style.width = `${Math.max(0, (hudP2.hp / hudP2.maxHp) * 100)}%`;

    this.refs.p1CD.style.width = `${(1 - Math.min(1, hudP1.specialCooldown / hudP1.specialCooldownMax)) * 100}%`;
    this.refs.p2CD.style.width = `${(1 - Math.min(1, hudP2.specialCooldown / hudP2.specialCooldownMax)) * 100}%`;
    this.refs.p1AttackCD.style.width = `${(1 - Math.min(1, hudP1.attackCooldown / hudP1.attackCooldownMax)) * 100}%`;
    this.refs.p2AttackCD.style.width = `${(1 - Math.min(1, hudP2.attackCooldown / hudP2.attackCooldownMax)) * 100}%`;

    this.refs.countdown.textContent = combat.countdown > 0 ? String(Math.ceil(combat.countdown)) : "";
    this.refs.combatMsg.textContent = combat.message;
    this.refs.modText.textContent = combat.modText;
    this.refs.pauseBtn.textContent = combat.paused ? "Resume" : "Pause";
    this.refs.p1Name.textContent = hudP1.label;
    this.refs.p2Name.textContent = hudP2.label;
    this.refs.p1Hint.textContent = hudP1.controlHint;
    this.refs.p2Hint.textContent = hudP2.controlHint;
    this.refs.p1SpecialName.textContent = hudP1.specialLabel.split(":")[0];
    this.refs.p2SpecialName.textContent = hudP2.specialLabel.split(":")[0];
    this.refs.p1SpecialInfo.textContent = hudP1.specialLabel;
    this.refs.p2SpecialInfo.textContent = hudP2.specialLabel;
    this.refs.atk1.textContent = `${combat.touch.p1AttackLabel} Attack`;
    this.refs.sp1.textContent = `${combat.touch.p1SpecialLabel} Special`;
    this.refs.atk2.textContent = `${combat.touch.p2AttackLabel} Attack`;
    this.refs.sp2.textContent = `${combat.touch.p2SpecialLabel} Special`;

    const hasHumanP2 = combat.fighters.some((fighter) => fighter.controller === "p2");
    this.refs.touchControls.classList.toggle("singlePlayer", !hasHumanP2);
    this.refs.stick2.hidden = !hasHumanP2;
    this.refs.atk2.hidden = !hasHumanP2;
    this.refs.sp2.hidden = !hasHumanP2;
  }

  updateEndScreen(game) {
    if (game.winner === "draw") {
      this.refs.winnerTitle.textContent = "Mutual Shutdown";
      this.refs.winnerTitle.className = "";
      this.refs.winnerReason.textContent = `No network prevails: ${game.winReason}.`;
      return;
    }

    this.refs.winnerTitle.textContent = `${FACTION_NAMES[game.winner]} Wins`;
    this.refs.winnerTitle.className = game.winner === "S" ? "solarText" : "voidText";
    this.refs.winnerReason.textContent = `Victory reason: ${game.winReason}.`;
  }

  setMuted(muted) {
    this.refs.muteBtn.textContent = muted ? "Unmute" : "Mute";
  }

  updateDebugText(text) {
    this.refs.debugText.textContent = text;
  }
}
