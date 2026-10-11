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
      endRestartAI: byId("endRestartAI"),
      endRestartPVP: byId("endRestartPVP"),
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
      p1Role: byId("p1Role"),
      p2Role: byId("p2Role"),
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
      p1TouchGroup: byId("p1TouchGroup"),
      p2TouchGroup: byId("p2TouchGroup"),
      stick2: byId("stick2"),
      atk1: byId("atk1"),
      sp1: byId("sp1"),
      atk2: byId("atk2"),
      sp2: byId("sp2"),
      muteBtn: byId("muteBtn"),
      combatMute: byId("combatMute"),
      combatControlHint: byId("combatControlHint"),
      inputStatus: byId("inputStatus"),
      boardControlHint: byId("boardControlHint"),
      debugText: byId("debugText"),
    };
  }

  showScreen(screenId) {
    const changed = this.currentScreen !== screenId;
    ["titleScreen", "boardScreen", "combatScreen", "endScreen"].forEach((id) => {
      this.refs[id].classList.toggle("active", id === screenId);
    });
    if (changed) {
      this.currentScreen = screenId;
      this.root.defaultView?.scrollTo(0, 0);
      this.refs[screenId].scrollTop = 0;
    }
  }

  toggleHelp(on) {
    this.refs.helpOverlay.classList.toggle("active", on);
    for (const id of ["titleScreen", "boardScreen", "combatScreen", "endScreen"]) this.refs[id].inert = on;
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

  updateInputStatus(snapshot = {}) {
    const device = snapshot.lastDevice || "keyboard";
    const pads = snapshot.gamepads || [];
    const deviceName = device === "touch" ? "Touch" : device === "gamepad" ? "Controller" : "Keyboard + mouse";
    if (this.root.documentElement) this.root.documentElement.dataset.input = device;
    if (this.refs.inputStatus) {
      this.refs.inputStatus.textContent = pads.length
        ? `${deviceName} · ${pads.length} controller${pads.length === 1 ? "" : "s"} connected. Combat Practice is ready.`
        : `${deviceName} ready. Controller: press a button to connect. Try Combat Practice.`;
    }
    if (this.refs.boardControlHint) {
      this.refs.boardControlHint.textContent = device === "gamepad"
        ? "D-pad / left stick: choose square · A: select / move · B: cancel · Start: actions"
        : device === "touch"
          ? "Tap a robot, then a highlighted square. Red squares begin a duel."
          : "Click a robot, then a square. Or use arrows + Enter; Esc cancels. Tab reaches commands.";
    }
  }

  updateCombatHud(game, inputSnapshot = {}) {
    const combat = game.combat;
    if (!combat) {
      return;
    }

    const hudP1 = combat.fighters.find((fighter) => fighter.controller === "p1") || combat.fighters[0];
    const hudP2 = combat.fighters.find((fighter) => fighter !== hudP1 && (fighter.controller === "p2" || fighter.controller === "ai")) || combat.fighters.find((fighter) => fighter !== hudP1) || hudP1;
    const hasHumanP2 = combat.fighters.some((fighter) => fighter.controller === "p2");
    const device = inputSnapshot.lastDevice || "keyboard";
    this.updateInputStatus(inputSnapshot);

    this.refs.p1HP.style.width = `${Math.max(0, (hudP1.hp / hudP1.maxHp) * 100)}%`;
    this.refs.p2HP.style.width = `${Math.max(0, (hudP2.hp / hudP2.maxHp) * 100)}%`;

    this.refs.p1CD.style.width = `${(1 - Math.min(1, hudP1.specialCooldown / hudP1.specialCooldownMax)) * 100}%`;
    this.refs.p2CD.style.width = `${(1 - Math.min(1, hudP2.specialCooldown / hudP2.specialCooldownMax)) * 100}%`;
    this.refs.p1AttackCD.style.width = `${(1 - Math.min(1, hudP1.attackCooldown / hudP1.attackCooldownMax)) * 100}%`;
    this.refs.p2AttackCD.style.width = `${(1 - Math.min(1, hudP2.attackCooldown / hudP2.attackCooldownMax)) * 100}%`;

    this.refs.countdown.textContent = combat.countdown > 0 ? String(Math.ceil(combat.countdown)) : "";
    this.refs.combatMsg.textContent = combat.message;
    this.refs.combatMsg.title = combat.message;
    this.refs.modText.textContent = combat.modText;
    this.refs.modText.title = combat.modText;
    this.refs.pauseBtn.textContent = combat.paused ? "Resume" : "Pause";
    this.refs.p1Name.textContent = hudP1.label.split(" · ")[0];
    this.refs.p2Name.textContent = hudP2.label.split(" · ")[0];
    this.refs.p1Role.textContent = `${hasHumanP2 ? "P1" : "YOU"} · SOLAR`;
    this.refs.p2Role.textContent = `${hasHumanP2 ? "P2" : "AI"} · VOID`;
    this.refs.p1Hint.textContent = hudP1.controlHint;
    this.refs.p2Hint.textContent = hudP2.controlHint;
    this.refs.p1SpecialName.textContent = hudP1.specialLabel.split(":")[0];
    this.refs.p2SpecialName.textContent = hudP2.specialLabel.split(":")[0];
    this.refs.p1SpecialInfo.textContent = hudP1.specialLabel;
    this.refs.p2SpecialInfo.textContent = hudP2.specialLabel;
    for (const [fighter, fire, special, role] of [
      [hudP1, this.refs.atk1, this.refs.sp1, "Solar"],
      [hudP2, this.refs.atk2, this.refs.sp2, "Void"],
    ]) {
      const ready = fighter.specialCooldown <= 0;
      const name = fighter.specialLabel.split(":")[0];
      const readiness = ready ? "Ready" : `${fighter.specialCooldown.toFixed(1)}s`;
      special.querySelector(".actionName").textContent = name;
      special.querySelector(".actionHint").textContent = readiness;
      special.classList.toggle("is-ready", ready);
      special.setAttribute("aria-label", `${role} special: ${fighter.specialLabel}. ${readiness}`);
      special.title = fighter.specialLabel;
      fire.querySelector(".actionName").textContent = role === "Solar" ? "HOLD FIRE" : "P2 FIRE";
      fire.setAttribute("aria-label", `${role}: hold to fire with aim assist, drag to aim manually`);
    }

    this.refs.touchControls.classList.toggle("singlePlayer", !hasHumanP2);
    this.refs.p2TouchGroup.hidden = !hasHumanP2;
    this.refs.stick2.hidden = !hasHumanP2;
    this.refs.atk2.hidden = !hasHumanP2;
    this.refs.sp2.hidden = !hasHumanP2;
    const manualAim = inputSnapshot.actions?.p1ManualAim;
    this.refs.combatControlHint.textContent = device === "touch"
      ? "Drag MOVE · Hold FIRE for aim assist · Drag FIRE to aim · Tap Special"
      : device === "gamepad"
        ? "Left stick: move · Right stick: aim · A / RT: fire · X / LB: special · Start: pause"
        : hasHumanP2
          ? "P1 WASD + Space/F + L Shift · P2 arrows + Enter + R Shift · Aim assist unless manually aiming"
          : `WASD move · Hold Space/F fire · Left Shift special · ${manualAim ? "Mouse aim active" : "Aim assist; point in arena for manual aim"}`;
  }

  updateEndScreen(game) {
    this.refs.endRestartAI.textContent = game.practice ? "Retry Practice" : "Restart vs AI";
    this.refs.endRestartPVP.hidden = Boolean(game.practice);
    if (game.practice) {
      this.refs.winnerTitle.textContent = game.winner === "S" ? "Practice Complete" : game.winner === "draw" ? "Mutual Shutdown" : "Try Again";
      this.refs.winnerTitle.className = game.winner === "S" ? "solarText" : "";
      this.refs.winnerReason.textContent = "Move and aim independently. Retry to practice another duel, or return to the menu for a full match.";
      return;
    }
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
    if (this.refs.combatMute) this.refs.combatMute.textContent = muted ? "Unmute" : "Mute";
  }

  updateDebugText(text) {
    this.refs.debugText.textContent = text;
  }
}
