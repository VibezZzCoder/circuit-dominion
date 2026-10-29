// SPDX-License-Identifier: GPL-3.0-or-later
// Additional terms under GPL-3.0 section 7 apply; see NOTICE.md.
import { UNIT_DEFS } from "./units.js";
import { FACTION_NAMES, FLUX_PHASES, POWER_NODES, energyLabel } from "./utils.js";

const FLUX_PIPS = { N: "◇", L: "☀", D: "◆" };
const FLUX_WORDS = { N: "Neutral", L: "Light", D: "Dark" };
const DIFFICULTY_WORDS = { easy: "Easy", standard: "Standard", hard: "Hard" };
const ROLE_LINES = {
  CC: "Commander · durable melee, damage shield",
  PS: "Striker · fast melee, piercing dash",
  AS: "Sniper · long range, charged lance",
  SD: "Guardian · ranged, deploys barrier walls",
  PM: "Support · ranged, self-repair; repairs allies",
  NW: "Heavy · slow melee, radial nova blast",
  NO: "Commander · durable melee, draining aura",
  RC: "Striker · fast melee, knockback leap",
  EC: "Artillery · slow heavy shells",
  GW: "Phantom · ranged, phase blink; moves through robots",
  CB: "Support · spread shot; corrupts enemies",
  GB: "Heavy · slow melee, gravity pull cone",
};
const MOVE_WORDS = {
  king: "1 square, any direction",
  runner: "Up to 3, any direction",
  phase: "Up to 3, phases through one robot",
  line: "Up to 4, any direction",
  heavy: "2 orthogonal or 1 diagonal",
  ortho: "Up to 2 orthogonal",
};

export class UIController {
  constructor(root) {
    this.root = root;
    this.refs = this.collectRefs(root);
    this.cache = new Map();
    this.assets = null;
  }

  setAssets(assets) {
    this.assets = assets;
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
      winnerEyebrow: byId("winnerEyebrow"),
      winnerPortrait: byId("winnerPortrait"),
      matchStats: byId("matchStats"),
      endRestartAI: byId("endRestartAI"),
      endRestartPVP: byId("endRestartPVP"),
      turnBadge: byId("turnBadge"),
      modeLabel: byId("modeLabel"),
      roundInfo: byId("roundInfo"),
      fluxTrack: byId("fluxTrack"),
      chargeInfo: byId("chargeInfo"),
      threatInfo: byId("threatInfo"),
      selectedInfo: byId("selectedInfo"),
      selectedName: byId("selectedName"),
      selectedRole: byId("selectedRole"),
      selectedHp: byId("selectedHp"),
      selectedPortrait: byId("selectedPortrait"),
      abilityBtn: byId("abilityBtn"),
      duelPreview: byId("duelPreview"),
      nodeInfo: byId("nodeInfo"),
      nodeMap: byId("nodeMap"),
      commandInfo: byId("commandInfo"),
      gridLockBtn: byId("gridLockBtn"),
      fieldRepairBtn: byId("fieldRepairBtn"),
      relayBtn: byId("relayBtn"),
      cancelCommandBtn: byId("cancelCommandBtn"),
      log: byId("log"),
      logHistory: byId("logHistory"),
      p1Name: byId("p1Name"),
      p2Name: byId("p2Name"),
      p1Role: byId("p1Role"),
      p2Role: byId("p2Role"),
      p1HP: byId("p1HP"),
      p2HP: byId("p2HP"),
      p1HPTrail: byId("p1HPTrail"),
      p2HPTrail: byId("p2HPTrail"),
      p1Portrait: byId("p1Portrait"),
      p2Portrait: byId("p2Portrait"),
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
      titleMute: byId("titleMute"),
      combatControlHint: byId("combatControlHint"),
      inputStatus: byId("inputStatus"),
      boardControlHint: byId("boardControlHint"),
      debugText: byId("debugText"),
      unitRoster: byId("unitRoster"),
    };
  }

  // Write DOM only when a value changes; the HUD syncs every frame.
  set(ref, key, value) {
    if (!ref) return;
    // Text and HTML share one slot so switching between them never goes stale.
    const id = key === "text" || key === "html" ? "content" : key;
    if (id === "content") value = `${key}:${value}`;
    let entry = this.cache.get(ref);
    if (!entry) {
      entry = {};
      this.cache.set(ref, entry);
    }
    if (entry[id] === value) return;
    entry[id] = value;
    if (key === "html") ref.innerHTML = value.slice(5);
    else if (key === "text") ref.textContent = value.slice(5);
    else if (key === "width") ref.style.width = value;
    else if (key === "hidden") ref.hidden = value;
    else if (key === "disabled") ref.disabled = value;
    else if (key === "class") ref.className = value;
    else ref.setAttribute(key, value);
  }

  portraitFor(ref, type) {
    if (!ref) return;
    this.set(ref, "data-unit", type || "");
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
    if (on) this.buildUnitRoster();
  }

  toggleDebug(on) {
    this.refs.debugOverlay.classList.toggle("active", on);
  }

  setLog(text, kind = "info", logs = []) {
    this.set(this.refs.log, "text", text);
    this.set(this.refs.log, "class", kind === "bad" ? "isBad" : "");
    if (this.refs.logHistory) {
      const recent = logs.slice(-5, -1).reverse();
      this.set(this.refs.logHistory, "html", recent.map((entry) => `<li class="${entry.kind === "bad" ? "isBad" : ""}">${escapeHtml(entry.text)}</li>`).join(""));
    }
  }

  updateBoardHud(game, selectedText, nodeLabels) {
    const isSolarTurn = game.turn === "S";
    const factionClass = isSolarTurn ? "solarText" : "voidText";
    const pvp = game.mode === "pvp";
    const aiTurn = game.mode === "ai" && game.turn === "V";
    this.set(this.refs.turnBadge, "html", `<span class="${factionClass}">${FACTION_NAMES[game.turn]}</span>`);
    this.set(this.refs.modeLabel, "text", pvp
      ? (isSolarTurn ? "Player 1 to move" : "Player 2 to move")
      : aiTurn ? `${DIFFICULTY_WORDS[game.difficulty] || game.difficulty} AI is moving` : `Your move · vs ${DIFFICULTY_WORDS[game.difficulty] || game.difficulty} AI`);
    const phase = FLUX_PHASES[game.fluxPhase];
    const next = FLUX_PHASES[(game.fluxPhase + 1) % FLUX_PHASES.length];
    this.set(this.refs.roundInfo, "text", `Round ${game.roundCount} · Flux ${FLUX_WORDS[phase]} → next ${FLUX_WORDS[next]}`);
    if (this.refs.fluxTrack) {
      this.set(this.refs.fluxTrack, "html", FLUX_PHASES.map((energy, index) =>
        `<span class="fluxPip flux${energy}${index === game.fluxPhase ? " isNow" : ""}${index === (game.fluxPhase + 1) % FLUX_PHASES.length ? " isNext" : ""}">${FLUX_PIPS[energy]}</span>`).join(""));
    }
    const pips = (count) => [0, 1, 2].map((index) => `<span class="pip${index < count ? " on" : ""}"></span>`).join("");
    this.set(this.refs.chargeInfo, "html",
      `<span class="chargeSide solarSide" title="Solar Command charge">Solar ${pips(game.commandCharge.S)}</span><span class="chargeSide voidSide" title="Void Command charge">${pips(game.commandCharge.V)} Void</span>`);
    const control = game.nodeControl || { S: 0, V: 0, owners: [] };
    this.set(this.refs.threatInfo, "text",
      control.S === 4 ? "Warning: Solar holds four Power Nodes." :
      control.V === 4 ? "Warning: Void holds four Power Nodes." : "");

    this.updateSelectedCard(game, selectedText);

    this.set(this.refs.nodeInfo, "html",
      `<span class="nodeCount solarText">${control.S} Solar</span><span class="nodeCount">${5 - control.S - control.V} open</span><span class="nodeCount voidText">${control.V} Void</span>`);
    if (this.refs.nodeMap) {
      const owners = control.owners || [];
      this.set(this.refs.nodeMap, "html", POWER_NODES.map(([row, col], index) => {
        const owner = owners[index];
        return `<span class="nodePip ${owner === "S" ? "ownS" : owner === "V" ? "ownV" : ""}" style="grid-row:${Math.round(row / 4) + 1};grid-column:${Math.round(col / 4) + 1}" title="${nodeLabels?.[index] || ""}"></span>`;
      }).join(""));
    }

    const actionName = game.boardAction?.type
      ? {
          gridLock: "Grid Lock: choose a Flux cell to lock to your polarity.",
          fieldRepair: "Field Repair: choose a damaged non-command ally.",
          emergencyRelay: game.boardAction.sourceUnitId
            ? "Emergency Relay: choose a highlighted adjacent destination."
            : "Emergency Relay: choose a non-command ally.",
          corrupt: "Corrupt: choose a highlighted adjacent enemy.",
          repairAlly: "Repair: choose a highlighted damaged ally.",
        }[game.boardAction.type]
      : "Nodes charge tactical powers each round.";
    this.set(this.refs.commandInfo, "text", actionName);
    const humanTurn = !aiTurn;
    const commanderAlive = game.commanderAlive?.[game.turn] !== false;
    const charge = game.commandCharge[game.turn];
    this.set(this.refs.gridLockBtn, "disabled", !humanTurn || !commanderAlive || charge < 1);
    this.set(this.refs.fieldRepairBtn, "disabled", !humanTurn || !commanderAlive || charge < 1);
    this.set(this.refs.relayBtn, "disabled", !humanTurn || !commanderAlive || charge < 2);
    this.set(this.refs.cancelCommandBtn, "disabled", !game.boardAction);
    this.set(this.refs.cancelCommandBtn, "hidden", !game.boardAction);
    const disabledWhy = !commanderAlive ? "Your commander is destroyed." : !humanTurn ? "Wait for your turn." : "Not enough Command charge.";
    for (const [ref, cost] of [[this.refs.gridLockBtn, 1], [this.refs.fieldRepairBtn, 1], [this.refs.relayBtn, 2]]) {
      this.set(ref, "title", ref?.disabled ? disabledWhy : `Costs ${cost} Command charge and ends your turn.`);
    }
  }

  updateSelectedCard(game, fallbackText) {
    const unit = game.units?.find((candidate) => candidate.id === game.selectedUnitId && candidate.alive);
    const refs = this.refs;
    if (!unit) {
      this.portraitFor(refs.selectedPortrait, "");
      this.set(refs.selectedName, "text", "No robot selected");
      this.set(refs.selectedRole, "text", game.mode === "ai" && game.turn === "V" ? "Void Core is moving." : "Select one of your robots.");
      this.set(refs.selectedHp, "width", "0%");
      const touch = this.root.documentElement?.dataset?.input === "touch";
      this.set(refs.selectedInfo, "text", touch
        ? "Glowing rings mark robots that can move this turn. Tap one, then tap a highlighted square."
        : "Glowing rings mark robots that can move this turn. Hover a destination to preview the path.");
      this.set(refs.abilityBtn, "hidden", true);
      this.set(refs.duelPreview, "hidden", true);
      return;
    }
    const def = UNIT_DEFS[unit.type];
    const square = game.board?.[unit.row]?.[unit.col];
    const energy = square?.energy;
    const aligned = energy && energy !== "N" && (energy === "L") === (def.faction === "S");
    const ground = !energy || energy === "N" ? "Neutral ground: no bonus" : aligned ? `${energyLabel(energy)}: +8% HP and damage here` : `${energyLabel(energy)}: −6% damage here`;
    this.portraitFor(refs.selectedPortrait, unit.type);
    this.set(refs.selectedName, "html", `<span class="${def.faction === "S" ? "solarText" : "voidText"}">${def.name}</span>${def.isCommandUnit ? ' <span class="crown" title="Command unit">♛</span>' : ""}`);
    this.set(refs.selectedRole, "text", ROLE_LINES[unit.type] || def.name);
    this.set(refs.selectedHp, "width", `${Math.max(0, Math.min(100, (unit.hp / unit.maxHp) * 100))}%`);
    this.set(refs.selectedHp, "class", unit.hp / unit.maxHp > 0.6 ? "" : unit.hp / unit.maxHp > 0.3 ? "isHurt" : "isCritical");
    const lines = [
      `HP ${Math.max(0, Math.ceil(unit.hp))} / ${unit.maxHp} · ${def.attack.kind === "melee" ? "Melee" : "Ranged"} ${def.attack.damage}`,
      `Move: ${MOVE_WORDS[def.boardMovement.type] || def.boardMovement.type}`,
      `Special: ${def.special.name}`,
      `${ground}${square?.flux ? " · Flux cell" : ""}`,
    ];
    if (unit.weakTurns > 0) lines.push(`Corrupted: −12% damage for ${unit.weakTurns} more turn${unit.weakTurns === 1 ? "" : "s"}`);
    this.set(refs.selectedInfo, "text", lines.join("\n") || fallbackText);
    this.updateDuelPreview(game, unit, def);
    const ability = unit.type === "PM" ? "Repair adjacent ally" : unit.type === "CB" ? "Corrupt adjacent enemy" : "";
    this.set(refs.abilityBtn, "hidden", !ability || !game.abilityAvailable);
    if (ability) {
      this.set(refs.abilityBtn, "text", `${ability} · ends turn`);
    }
  }

  // Hovering an attack target previews who fights, at what health, on which ground.
  updateDuelPreview(game, unit, def) {
    const ref = this.refs.duelPreview;
    if (!ref) return;
    const hover = game.presentation?.hover;
    const move = hover && game.legalMoves?.find((candidate) => candidate.attack && candidate.row === hover.row && candidate.col === hover.col);
    const target = move && game.units.find((candidate) => candidate.id === move.targetId && candidate.alive);
    if (!target) {
      this.set(ref, "hidden", true);
      return;
    }
    const enemy = UNIT_DEFS[target.type];
    const energy = game.board?.[target.row]?.[target.col]?.energy;
    const edge = energy === "L" ? (def.faction === "S" ? "you +8%" : "rival +8%, you −6%")
      : energy === "D" ? (def.faction === "V" ? "you +8%" : "rival +8%, you −6%") : "no bonus";
    const hp = (candidate) => Math.max(0, Math.ceil(candidate.hp));
    this.set(ref, "hidden", false);
    this.set(ref, "html",
      `<b>Duel preview</b><span>${escapeHtml(def.name)} <em>${hp(unit)} HP</em> vs ${escapeHtml(enemy.name)} <em>${hp(target)} HP</em></span><span>${escapeHtml(energyLabel(energy))}: ${edge}</span>`);
  }

  updateInputStatus(snapshot = {}) {
    const device = snapshot.lastDevice || "keyboard";
    const pads = snapshot.gamepads || [];
    const deviceName = device === "touch" ? "Touch" : device === "gamepad" ? "Controller" : "Keyboard and mouse";
    if (this.root.documentElement && this.root.documentElement.dataset) this.root.documentElement.dataset.input = device;
    if (this.refs.inputStatus) {
      this.set(this.refs.inputStatus, "text", pads.length
        ? `${deviceName} · ${pads.length} controller${pads.length === 1 ? "" : "s"} connected. The second controller plays P2.`
        : `${deviceName} ready. Controllers: press any button to connect.`);
    }
    if (this.refs.boardControlHint) {
      this.set(this.refs.boardControlHint, "text", device === "gamepad"
        ? "D-pad: choose square · A: select / move · B: cancel · Start: actions"
        : device === "touch"
          ? "Tap a robot, then a glowing square. Red brackets start a duel."
          : "Click a robot, then a glowing square. Arrows + Enter also work; Esc cancels.");
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

    const p1Width = `${Math.max(0, (hudP1.hp / hudP1.maxHp) * 100)}%`;
    const p2Width = `${Math.max(0, (hudP2.hp / hudP2.maxHp) * 100)}%`;
    this.refs.p1HP.style.width = p1Width;
    this.refs.p2HP.style.width = p2Width;
    this.set(this.refs.p1HPTrail, "width", p1Width);
    this.set(this.refs.p2HPTrail, "width", p2Width);
    this.portraitFor(this.refs.p1Portrait, hudP1.unit?.type);
    this.portraitFor(this.refs.p2Portrait, hudP2.unit?.type);

    this.refs.p1CD.style.width = `${(1 - Math.min(1, hudP1.specialCooldown / hudP1.specialCooldownMax)) * 100}%`;
    this.refs.p2CD.style.width = `${(1 - Math.min(1, hudP2.specialCooldown / hudP2.specialCooldownMax)) * 100}%`;
    this.refs.p1AttackCD.style.width = `${(1 - Math.min(1, hudP1.attackCooldown / hudP1.attackCooldownMax)) * 100}%`;
    this.refs.p2AttackCD.style.width = `${(1 - Math.min(1, hudP2.attackCooldown / hudP2.attackCooldownMax)) * 100}%`;

    const countdownText = combat.countdown > 0 && !combat.paused ? String(Math.ceil(combat.countdown)) : "";
    if (this.refs.countdown.textContent !== countdownText) this.refs.countdown.textContent = countdownText;
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
    this.refs.p1SpecialName.parentElement?.classList?.toggle("is-ready", hudP1.specialCooldown <= 0);
    this.refs.p2SpecialName.parentElement?.classList?.toggle("is-ready", hudP2.specialCooldown <= 0);

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
          ? "P1: WASD · Space/F fire · L Shift special   |   P2: Arrows · Enter or / fire · R Shift special"
          : `WASD move · Hold Space/F fire · Left Shift special · ${manualAim ? "Mouse aim active" : "Aim assist on; move the mouse in the arena to aim"}`;
  }

  updateEndScreen(game) {
    // Synced every frame: route writes through the change cache so the DOM
    // (and a screen reader's position in it) stays stable on the end card.
    const refs = this.refs;
    this.set(refs.endRestartAI, "text", game.practice ? "Retry Training" : "Rematch");
    this.set(refs.endRestartPVP, "hidden", Boolean(game.practice));
    this.set(refs.endRestartPVP, "text", game.mode === "pvp" ? "Play vs AI" : "2-Player Match");
    const stats = game.stats || { duels: 0, draws: 0, upsets: 0, wins: { S: 0, V: 0 }, captures: { S: 0, V: 0 } };
    if (game.practice) {
      this.set(refs.winnerTitle, "text", game.winner === "S" ? "Training Complete" : game.winner === "draw" ? "Mutual Shutdown" : "Try Again");
      this.set(refs.winnerTitle, "class", game.winner === "S" ? "solarText" : "");
      this.set(refs.winnerEyebrow, "text", "Training duel");
      this.set(refs.winnerReason, "text", "Move and aim independently: hold Fire to track your rival while you dodge. Retry, or return to the menu for a full match.");
      this.portraitFor(refs.winnerPortrait, game.winner === "S" ? "AS" : "EC");
      this.set(refs.matchStats, "html", "");
      return;
    }
    const reason = game.winReason || "";
    const how = /Power Nodes/i.test(reason) ? "Grid Dominion" : /Command Units? were destroyed|both/i.test(reason) ? "Mutual Destruction" : "Commander Destroyed";
    if (game.winner === "draw") {
      this.set(refs.winnerTitle, "text", "Mutual Shutdown");
      this.set(refs.winnerTitle, "class", "");
      this.set(refs.winnerEyebrow, "text", how);
      this.set(refs.winnerReason, "text", `No network prevails: ${reason}.`);
      this.portraitFor(refs.winnerPortrait, "");
    } else {
      this.set(refs.winnerTitle, "text", `${FACTION_NAMES[game.winner]} Wins`);
      this.set(refs.winnerTitle, "class", game.winner === "S" ? "solarText" : "voidText");
      this.set(refs.winnerEyebrow, "text", `Victory · ${how}`);
      this.set(refs.winnerReason, "text", `${reason.charAt(0).toUpperCase()}${reason.slice(1)}.`);
      this.portraitFor(refs.winnerPortrait, game.winner === "S" ? "CC" : "NO");
    }
    const survivors = { S: 0, V: 0 };
    for (const unit of game.units || []) if (unit.alive) survivors[UNIT_DEFS[unit.type].faction] += 1;
    this.set(refs.matchStats, "html", [
      ["Rounds", game.roundCount],
      ["Duels", stats.duels],
      ["Duels won", `<span class="solarText">${stats.wins.S}</span> · <span class="voidText">${stats.wins.V}</span>`],
      ["Robots left", `<span class="solarText">${survivors.S}</span> · <span class="voidText">${survivors.V}</span>`],
      ["Upsets", stats.upsets],
    ].map(([label, value]) => `<div><dt>${label}</dt><dd>${value}</dd></div>`).join(""));
  }

  buildUnitRoster() {
    const roster = this.refs.unitRoster;
    if (!roster || roster.dataset?.built === "1") return;
    const order = ["CC", "PS", "AS", "SD", "PM", "NW", "NO", "RC", "EC", "GW", "CB", "GB"];
    roster.innerHTML = order.map((type) => {
      const def = UNIT_DEFS[type];
      const side = def.faction === "S" ? "solar" : "void";
      return `<article class="rosterCard ${side}Card"><div class="portrait" data-unit="${type}" aria-hidden="true"></div><div><h4 class="${side}Text">${def.name}${def.isCommandUnit ? " ♛" : ""}</h4><p class="small">${ROLE_LINES[type]}</p><p class="small">Move: ${MOVE_WORDS[def.boardMovement.type]} · HP ${def.maxHp} · ${def.attack.kind === "melee" ? "Melee" : "Ranged"}</p><p class="small"><b>${def.special.name}:</b> ${def.special.description}</p></div></article>`;
    }).join("");
    if (roster.dataset) roster.dataset.built = "1";
  }

  setLabels(on) {
    const button = this.root.getElementById("labelsBtn");
    if (!button) return;
    this.set(button, "text", on ? "Labels: On" : "Labels");
    this.set(button, "aria-pressed", on ? "true" : "false");
  }

  setMuted(muted) {
    this.set(this.refs.muteBtn, "text", muted ? "Unmute" : "Mute");
    if (this.refs.combatMute) this.set(this.refs.combatMute, "text", muted ? "Unmute" : "Mute");
    // Visible On/Off text carries the state; no aria-pressed on changing labels.
    if (this.refs.titleMute) this.set(this.refs.titleMute, "text", muted ? "Sound: Off" : "Sound: On");
  }

  // Every volume slider (title and Help) mirrors the same stored levels.
  setVolumes(levels) {
    for (const input of this.root.querySelectorAll("input[data-volume]")) {
      const level = levels[input.dataset.volume];
      if (!Number.isFinite(level)) continue;
      if (Number(input.value) !== level) input.value = String(level);
      this.set(input, "aria-valuetext", level ? `${level}%` : "Off");
      const label = input.parentElement?.querySelector(".volumeValue");
      if (label) this.set(label, "text", level ? `${level}%` : "Off");
    }
  }

  updateDebugText(text) {
    this.refs.debugText.textContent = text;
  }
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[char]);
}
