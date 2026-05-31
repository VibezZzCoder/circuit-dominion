// SPDX-License-Identifier: GPL-3.0-or-later
import { energyModifierForFaction } from "./board.js";
import { createActionTiming, setFighterState, tickFighterState } from "./combat-state.js";
import { FighterState } from "./state.js";
import { getDuelAiIntent } from "./ai.js";
import { UNIT_DEFS } from "./units.js";
import { FACTION_NAMES, clamp, dist2d } from "./utils.js";

const ARENA = {
  minX: 26,
  maxX: 934,
  minY: 28,
  maxY: 492,
};

export function startCombat(game, attacker, defender, row, col) {
  const energy = game.board[row][col].energy;

  const attackerFighter = makeFighter(attacker, 0, energy);
  const defenderFighter = makeFighter(defender, 1, energy);

  const combat = {
    attackerId: attacker.id,
    defenderId: defender.id,
    targetRow: row,
    targetCol: col,
    energy,
    state: "combatIntro",
    paused: false,
    countdown: 3,
    message: `Duel begins on ${String.fromCharCode(65 + col)}${row + 1}. Controls unlock after countdown.`,
    modText: "",
    fighters: [attackerFighter, defenderFighter],
    projectiles: [],
    effects: [],
    beams: [],
    resolveTimer: 0,
    touch: {
      p1AttackLabel: "P1",
      p1SpecialLabel: "P1",
      p2AttackLabel: "P2",
      p2SpecialLabel: "P2",
    },
  };

  assignControllers(game, combat);
  combat.modText = `${energyLabel(energy)} · ${attackerFighter.unit.type} ${shortModifierText(attackerFighter.mod)} · ${defenderFighter.unit.type} ${shortModifierText(defenderFighter.mod)}`;
  game.combat = combat;
  return combat;
}

function makeFighter(unit, slot, energy) {
  const def = UNIT_DEFS[unit.type];
  const mod = energyModifierForFaction(def.faction, energy);
  const maxHp = def.maxHp * mod.hp;
  const currentHp = Math.min(maxHp, unit.hp * mod.hp);

  return {
    id: `${unit.id}-${slot}`,
    unit,
    slot,
    x: slot ? 760 : 200,
    y: 260,
    vx: 0,
    vy: 0,
    radius: 22,
    hp: currentHp,
    maxHp,
    damage: def.attackDamage * mod.damage * (unit.weakTurns > 0 ? 0.88 : 1),
    speed: def.speed,
    range: def.attackRange,
    attackCooldown: 0,
    specialCooldown: 0,
    specialCooldownMax: def.specialCooldown,
    shieldUntil: 0,
    auraUntil: 0,
    pullUntil: 0,
    invisUntil: 0,
    state: FighterState.IDLE,
    stateUntil: 0,
    mod,
    controller: "ai",
    label: `${def.name} · ${FACTION_NAMES[def.faction]}`,
    controlHint: "",
  };
}

function energyLabel(energy) {
  if (energy === "L") {
    return "☀ Light Grid";
  }
  if (energy === "D") {
    return "◆ Dark Grid";
  }
  return "◇ Neutral Grid";
}

function shortModifierText(mod) {
  if (mod.hp > 1 || mod.damage > 1) {
    return "+15% HP/damage";
  }
  if (mod.damage < 1) {
    return "-10% damage";
  }
  return "no bonus";
}

function assignControllers(game, combat) {
  const mode = game.mode;
  const aiVoidInPvp = Boolean(document.getElementById("duelAIToggle")?.checked);

  for (const fighter of combat.fighters) {
    const faction = UNIT_DEFS[fighter.unit.type].faction;
    if (mode === "ai") {
      fighter.controller = faction === "S" ? "p1" : "ai";
    } else if (aiVoidInPvp && faction === "V") {
      fighter.controller = "ai";
    } else {
      fighter.controller = faction === "S" ? "p1" : "p2";
    }

    if (fighter.controller === "ai") {
      fighter.controlHint = `${FACTION_NAMES[faction]} · AI controls this robot`;
    } else if (fighter.controller === "p1") {
      fighter.controlHint = `${FACTION_NAMES[faction]} · WASD move · Space/F attack · Left Shift special`;
    } else {
      fighter.controlHint = `${FACTION_NAMES[faction]} · Arrows move · Enter or / attack · Right Shift special`;
    }
  }

  const p1 = combat.fighters.find((f) => f.controller === "p1");
  const p2 = combat.fighters.find((f) => f.controller === "p2");
  combat.touch.p1AttackLabel = p1 ? UNIT_DEFS[p1.unit.type].visual.abbr : "P1";
  combat.touch.p1SpecialLabel = p1 ? UNIT_DEFS[p1.unit.type].visual.abbr : "P1";
  combat.touch.p2AttackLabel = p2 ? UNIT_DEFS[p2.unit.type].visual.abbr : "P2";
  combat.touch.p2SpecialLabel = p2 ? UNIT_DEFS[p2.unit.type].visual.abbr : "P2";
}

export function updateCombat(game, actions, deltaSec, nowMs, audio) {
  const combat = game.combat;
  if (!combat || combat.paused) {
    return null;
  }

  if (combat.state === "combatIntro" || combat.state === "combatCountdown") {
    combat.state = "combatCountdown";
    combat.countdown = Math.max(0, combat.countdown - deltaSec);
    if (combat.countdown <= 0) {
      combat.message = "Fight!";
      combat.state = "combatActive";
      audio.beep("countdown");
    }
    return null;
  }

  if (combat.state === "combatResolving") {
    combat.resolveTimer -= deltaSec;
    if (combat.resolveTimer <= 0) {
      return resolveCombat(combat);
    }
    return null;
  }

  for (const fighter of combat.fighters) {
    fighter.attackCooldown = Math.max(0, fighter.attackCooldown - deltaSec);
    fighter.specialCooldown = Math.max(0, fighter.specialCooldown - deltaSec);
    tickFighterState(fighter, nowMs);
  }

  const [f0, f1] = combat.fighters;
  controlFighter(game, combat, f0, f1, actions, deltaSec, nowMs, audio);
  controlFighter(game, combat, f1, f0, actions, deltaSec, nowMs, audio);

  for (const fighter of combat.fighters) {
    fighter.x = clamp(fighter.x + fighter.vx * deltaSec, ARENA.minX, ARENA.maxX);
    fighter.y = clamp(fighter.y + fighter.vy * deltaSec, ARENA.minY, ARENA.maxY);
    fighter.vx *= 0.86;
    fighter.vy *= 0.86;

    if (fighter.auraUntil > nowMs && dist2d(fighter, combat.fighters[1 - fighter.slot]) < 105) {
      damageFighter(combat.fighters[1 - fighter.slot], 10 * deltaSec, fighter, combat, audio);
    }
    if (fighter.pullUntil > nowMs) {
      const other = combat.fighters[1 - fighter.slot];
      const angle = Math.atan2(fighter.y - other.y, fighter.x - other.x);
      other.vx += Math.cos(angle) * 105 * deltaSec;
      other.vy += Math.sin(angle) * 105 * deltaSec;
    }
  }

  updateProjectiles(combat, deltaSec, nowMs, audio);

  if (combat.fighters.some((fighter) => fighter.hp <= 0)) {
    for (const fighter of combat.fighters) {
      if (fighter.hp <= 0) {
        fighter.state = FighterState.DEAD;
      }
    }
    combat.state = "combatResolving";
    combat.resolveTimer = 0.35;
  }

  return null;
}

function controlFighter(game, combat, fighter, opponent, actions, dt, nowMs, audio) {
  let intent = null;
  if (fighter.controller === "p1") {
    intent = {
      moveX: actions.p1MoveX,
      moveY: actions.p1MoveY,
      useAttack: actions.p1Attack,
      useSpecial: actions.p1Special,
    };
  } else if (fighter.controller === "p2") {
    intent = {
      moveX: actions.p2MoveX,
      moveY: actions.p2MoveY,
      useAttack: actions.p2Attack,
      useSpecial: actions.p2Special,
    };
  } else {
    intent = getDuelAiIntent(fighter, opponent, combat);
  }

  let { moveX, moveY } = intent;

  const mag = Math.hypot(moveX, moveY);
  if (mag > 1) {
    moveX /= mag;
    moveY /= mag;
  }

  fighter.vx += moveX * fighter.speed * 5 * dt;
  fighter.vy += moveY * fighter.speed * 5 * dt;
  fighter.state = mag > 0.05 ? FighterState.MOVE : FighterState.IDLE;

  if (intent.useAttack) {
    attemptAttack(fighter, opponent, combat, nowMs, audio);
  }
  if (intent.useSpecial) {
    attemptSpecial(fighter, opponent, combat, nowMs, audio);
  }
}

function attemptAttack(fighter, opponent, combat, nowMs, audio) {
  if (fighter.attackCooldown > 0 || combat.countdown > 0 || combat.state !== "combatActive") {
    return;
  }

  const def = UNIT_DEFS[fighter.unit.type];
  const timing = createActionTiming(def, "attack");
  fighter.attackCooldown = def.attackCooldown;
  setFighterState(fighter, FighterState.ATTACK_STARTUP, nowMs, timing.startupMs);
  audio.beep("attack");

  const distance = dist2d(fighter, opponent);
  if (def.attackRange < 130) {
    if (distance < def.attackRange + opponent.radius) {
      setFighterState(fighter, FighterState.ATTACK_ACTIVE, nowMs, timing.activeMs);
      damageFighter(opponent, fighter.damage, fighter, combat, audio);
      setFighterState(fighter, FighterState.ATTACK_RECOVERY, nowMs, timing.recoveryMs);
    } else {
      const angle = Math.atan2(opponent.y - fighter.y, opponent.x - fighter.x);
      fighter.vx += Math.cos(angle) * 210;
      fighter.vy += Math.sin(angle) * 210;
    }
  } else {
    fireProjectile(fighter, opponent, fighter.damage, combat, 360, 5, 0);
  }
}

function attemptSpecial(fighter, opponent, combat, nowMs, audio) {
  if (fighter.specialCooldown > 0 || combat.countdown > 0 || combat.state !== "combatActive") {
    return;
  }

  const def = UNIT_DEFS[fighter.unit.type];
  const timing = createActionTiming(def, "special");
  fighter.specialCooldown = def.specialCooldown;
  fighter.specialCooldownMax = def.specialCooldown;
  setFighterState(fighter, FighterState.SPECIAL_STARTUP, nowMs, timing.startupMs);
  audio.beep("special");

  const t = fighter.unit.type;
  if (t === "CC" || t === "SD") {
    fighter.shieldUntil = nowMs + 2200;
    spawnFx(combat, fighter.x, fighter.y, "#6dfcff", 18);
  } else if (t === "PS" || t === "RC") {
    const angle = Math.atan2(opponent.y - fighter.y, opponent.x - fighter.x);
    fighter.vx += Math.cos(angle) * 520;
    fighter.vy += Math.sin(angle) * 520;
    if (dist2d(fighter, opponent) < 145) {
      damageFighter(opponent, fighter.damage * 1.65, fighter, combat, audio);
    }
    spawnFx(combat, opponent.x, opponent.y, "#ffdc63", 18);
  } else if (t === "AS") {
    if (dist2d(fighter, opponent) < 540) {
      damageFighter(opponent, fighter.damage * 2.05, fighter, combat, audio);
    }
    combat.beams.push({ from: fighter, to: opponent, until: nowMs + 170, color: "#cfffff" });
  } else if (t === "PM") {
    fighter.hp = clamp(fighter.hp + 18, 0, fighter.maxHp);
    fireProjectile(fighter, opponent, fighter.damage * 0.8, combat, 390, 4, 0.35);
    fireProjectile(fighter, opponent, fighter.damage * 0.8, combat, 390, 4, 0.35);
    spawnFx(combat, fighter.x, fighter.y, "#7dff96", 12);
  } else if (t === "NW") {
    if (dist2d(fighter, opponent) < 150) {
      damageFighter(opponent, fighter.damage * 1.55, fighter, combat, audio);
    }
    spawnFx(combat, fighter.x, fighter.y, "#ffdc63", 35);
  } else if (t === "NO") {
    fighter.auraUntil = nowMs + 3000;
    spawnFx(combat, fighter.x, fighter.y, "#d56bff", 25);
  } else if (t === "EC") {
    fireProjectile(fighter, opponent, fighter.damage * 2.05, combat, 230, 11, 0.05);
  } else if (t === "GW") {
    const angle = Math.random() * Math.PI * 2;
    fighter.x = clamp(fighter.x + Math.cos(angle) * 115, 40, 920);
    fighter.y = clamp(fighter.y + Math.sin(angle) * 115, 40, 480);
    fighter.invisUntil = nowMs + 1600;
    setFighterState(fighter, FighterState.PHASING, nowMs, 200);
    spawnFx(combat, fighter.x, fighter.y, "#d56bff", 18);
  } else if (t === "CB") {
    for (let i = 0; i < 3; i += 1) {
      fireProjectile(fighter, opponent, fighter.damage * 0.85, combat, 340, 4, 0.7);
    }
  } else if (t === "GB") {
    fighter.pullUntil = nowMs + 2500;
    if (dist2d(fighter, opponent) < 120) {
      damageFighter(opponent, fighter.damage * 0.75, fighter, combat, audio);
    }
    spawnFx(combat, fighter.x, fighter.y, "#d56bff", 24);
  }

  setFighterState(fighter, FighterState.SPECIAL_ACTIVE, nowMs, timing.activeMs);
}

function fireProjectile(fighter, target, damage, combat, speed, radius, spread) {
  const angle = Math.atan2(target.y - fighter.y, target.x - fighter.x) + (Math.random() - 0.5) * spread;
  combat.projectiles.push({
    x: fighter.x + Math.cos(angle) * 24,
    y: fighter.y + Math.sin(angle) * 24,
    vx: Math.cos(angle) * speed,
    vy: Math.sin(angle) * speed,
    damage,
    ownerId: fighter.id,
    ownerSlot: fighter.slot,
    radius,
    life: 1.8,
    color: UNIT_DEFS[fighter.unit.type].faction === "S" ? "#6dfcff" : "#d56bff",
  });
}

function damageFighter(target, amount, source, combat, audio) {
  let dmg = amount;
  if (target.invisUntil > performance.now()) {
    dmg *= 0.25;
  }
  if (target.shieldUntil > performance.now()) {
    dmg *= 0.45;
  }

  target.hp -= dmg;
  setFighterState(target, FighterState.HURT, performance.now(), 90);
  audio.beep("hit");
  spawnFx(combat, target.x, target.y, UNIT_DEFS[source.unit.type].faction === "S" ? "#6dfcff" : "#d56bff", 6);
}

function updateProjectiles(combat, dt, nowMs, audio) {
  for (const p of combat.projectiles) {
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.life -= dt;

    const opponent = combat.fighters[1 - p.ownerSlot];
    if (opponent.hp > 0 && Math.hypot(p.x - opponent.x, p.y - opponent.y) < p.radius + opponent.radius) {
      const owner = combat.fighters[p.ownerSlot];
      damageFighter(opponent, p.damage, owner, combat, audio);
      p.life = -1;
    }
  }

  combat.projectiles = combat.projectiles.filter((p) => p.life > 0 && p.x > -30 && p.x < 990 && p.y > -30 && p.y < 550);
  combat.effects = combat.effects.filter((fx) => fx.until > nowMs);
  combat.beams = combat.beams.filter((beam) => beam.until > nowMs);
}

function spawnFx(combat, x, y, color, count = 10) {
  const now = performance.now();
  for (let i = 0; i < count; i += 1) {
    combat.effects.push({
      x: x + (Math.random() - 0.5) * 18,
      y: y + (Math.random() - 0.5) * 18,
      radius: 8 + Math.random() * 35,
      until: now + 250 + Math.random() * 350,
      life: 400,
      color,
    });
  }
}

function resolveCombat(combat) {
  const [a, b] = combat.fighters;
  const aAlive = a.hp > 0;
  const bAlive = b.hp > 0;

  if (aAlive && !bAlive) {
    return {
      attackerId: combat.attackerId,
      defenderId: combat.defenderId,
      targetRow: combat.targetRow,
      targetCol: combat.targetCol,
      winner: "attacker",
      survivorHp: a.hp / a.mod.hp,
      reason: `${UNIT_DEFS[a.unit.type].name} won the duel.`,
    };
  }

  if (bAlive && !aAlive) {
    return {
      attackerId: combat.attackerId,
      defenderId: combat.defenderId,
      targetRow: combat.targetRow,
      targetCol: combat.targetCol,
      winner: "defender",
      survivorHp: b.hp / b.mod.hp,
      reason: `${UNIT_DEFS[b.unit.type].name} held the square.`,
    };
  }

  return {
    attackerId: combat.attackerId,
    defenderId: combat.defenderId,
    targetRow: combat.targetRow,
    targetCol: combat.targetCol,
    winner: "draw",
    survivorHp: 0,
    reason: "Both robots were destroyed.",
  };
}
