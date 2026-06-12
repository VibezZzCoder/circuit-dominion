// SPDX-License-Identifier: GPL-3.0-or-later
import { energyModifierForFaction } from "./board.js";
import { getDuelAiIntent } from "./ai.js";
import { createActionTiming, isFighterLocked, setFighterState, tickFighterState } from "./combat-state.js";
import { FighterState } from "./state.js";
import { UNIT_DEFS } from "./units.js";
import { FACTION_NAMES, clamp, dist2d } from "./utils.js";

export const ARENA = {
  minX: 28,
  maxX: 932,
  minY: 30,
  maxY: 490,
};

const COMBAT_HP_SCALE = 1.2;

export function buildArenaObstacles(energy) {
  if (energy === "L") {
    return [
      { x: 315, y: 190, width: 92, height: 54 },
      { x: 553, y: 276, width: 92, height: 54 },
    ];
  }
  if (energy === "D") {
    return [
      { x: 315, y: 276, width: 92, height: 54 },
      { x: 553, y: 190, width: 92, height: 54 },
    ];
  }
  return [
    { x: 442, y: 92, width: 76, height: 112 },
    { x: 442, y: 316, width: 76, height: 112 },
  ];
}

export function circleIntersectsRect(circle, rect, padding = 0) {
  const nearestX = clamp(circle.x, rect.x - padding, rect.x + rect.width + padding);
  const nearestY = clamp(circle.y, rect.y - padding, rect.y + rect.height + padding);
  return Math.hypot(circle.x - nearestX, circle.y - nearestY) < circle.radius + padding;
}

function resolveCircleRect(circle, rect) {
  const expanded = {
    x: rect.x - circle.radius,
    y: rect.y - circle.radius,
    width: rect.width + circle.radius * 2,
    height: rect.height + circle.radius * 2,
  };
  if (
    circle.x <= expanded.x ||
    circle.x >= expanded.x + expanded.width ||
    circle.y <= expanded.y ||
    circle.y >= expanded.y + expanded.height
  ) {
    return false;
  }

  const distances = [
    { axis: "x", value: expanded.x, distance: Math.abs(circle.x - expanded.x) },
    { axis: "x", value: expanded.x + expanded.width, distance: Math.abs(circle.x - (expanded.x + expanded.width)) },
    { axis: "y", value: expanded.y, distance: Math.abs(circle.y - expanded.y) },
    { axis: "y", value: expanded.y + expanded.height, distance: Math.abs(circle.y - (expanded.y + expanded.height)) },
  ].sort((a, b) => a.distance - b.distance);
  const nearest = distances[0];
  circle[nearest.axis] = nearest.value;
  if (nearest.axis === "x") {
    circle.vx = 0;
  } else {
    circle.vy = 0;
  }
  return true;
}

export function resolveFighterObstacles(fighter, obstacles) {
  let collided = false;
  for (const obstacle of obstacles) {
    collided = resolveCircleRect(fighter, obstacle) || collided;
  }
  return collided;
}

function pointSegmentDistance(point, start, end) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSq = dx * dx + dy * dy;
  if (!lengthSq) {
    return Math.hypot(point.x - start.x, point.y - start.y);
  }
  const t = clamp(((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSq, 0, 1);
  return Math.hypot(point.x - (start.x + dx * t), point.y - (start.y + dy * t));
}

export function sweptCircleHit(start, end, target, combinedRadius) {
  return pointSegmentDistance(target, start, end) <= combinedRadius;
}

export function directionalMeleeHit(attacker, target, range, arcDeg) {
  const dx = target.x - attacker.x;
  const dy = target.y - attacker.y;
  const distance = Math.hypot(dx, dy);
  if (distance > range + target.radius) {
    return false;
  }
  const dot = (dx * attacker.facingX + dy * attacker.facingY) / Math.max(1, distance);
  return dot >= Math.cos((arcDeg * Math.PI) / 360);
}

export function projectileHitsObstacle(projectile, obstacles) {
  return obstacles.some((obstacle) =>
    circleIntersectsRect(
      { x: projectile.x, y: projectile.y, radius: projectile.radius },
      obstacle,
    ),
  );
}

export function getOvertimeMultiplier(elapsedSec) {
  if (elapsedSec >= 60) {
    return 1.5;
  }
  if (elapsedSec >= 45) {
    return 1.25;
  }
  return 1;
}

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
    difficulty: game.difficulty,
    state: "combatIntro",
    paused: false,
    countdown: 3,
    elapsedSec: 0,
    overtimeMultiplier: 1,
    overtimeStage: 0,
    nowMs: 0,
    rng: Math.random,
    message: `Duel begins on ${String.fromCharCode(65 + col)}${row + 1}. Move to aim; controls unlock after countdown.`,
    modText: "",
    fighters: [attackerFighter, defenderFighter],
    projectiles: [],
    effects: [],
    beams: [],
    barriers: [],
    obstacles: buildArenaObstacles(energy),
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
  const maxHp = def.maxHp * mod.hp * COMBAT_HP_SCALE;
  return {
    id: `${unit.id}-${slot}`,
    unit,
    slot,
    x: slot ? 760 : 200,
    y: 260,
    vx: 0,
    vy: 0,
    radius: def.radius,
    hp: Math.min(maxHp, unit.hp * mod.hp * COMBAT_HP_SCALE),
    maxHp,
    damage: def.attack.damage * mod.damage * (unit.weakTurns > 0 ? 0.88 : 1),
    speed: def.speed,
    attackCooldown: 0,
    attackCooldownMax: def.attack.cooldown,
    specialCooldown: def.special.cooldown * 0.5,
    specialCooldownMax: def.special.cooldown,
    facingX: slot ? -1 : 1,
    facingY: 0,
    shieldUntil: 0,
    shieldDamageScale: 1,
    auraUntil: 0,
    pullUntil: 0,
    pullImpactAt: 0,
    pullImpacted: false,
    invisUntil: 0,
    invulnerableUntil: 0,
    hurtUntil: 0,
    state: FighterState.IDLE,
    stateUntil: 0,
    pendingAction: null,
    dash: null,
    mod,
    controller: "ai",
    label: `${def.name} · ${FACTION_NAMES[def.faction]}`,
    controlHint: "",
    specialLabel: `${def.special.name}: ${def.special.description}`,
    aiIntent: null,
    aiNextDecisionAt: 0,
  };
}

function energyLabel(energy) {
  if (energy === "L") return "☀ Light Grid";
  if (energy === "D") return "◆ Dark Grid";
  return "◇ Neutral Grid";
}

function shortModifierText(mod) {
  if (mod.hp > 1 || mod.damage > 1) return "+8% HP/damage";
  if (mod.damage < 1) return "-6% damage";
  return "no bonus";
}

function assignControllers(game, combat) {
  const aiVoidInPvp =
    typeof document !== "undefined" &&
    Boolean(document.getElementById("duelAIToggle")?.checked);

  for (const fighter of combat.fighters) {
    const faction = UNIT_DEFS[fighter.unit.type].faction;
    if (game.mode === "ai") {
      fighter.controller = faction === "S" ? "p1" : "ai";
    } else if (aiVoidInPvp && faction === "V") {
      fighter.controller = "ai";
    } else {
      fighter.controller = faction === "S" ? "p1" : "p2";
    }

    if (fighter.controller === "ai") {
      fighter.controlHint = `${FACTION_NAMES[faction]} · ${game.difficulty} AI · movement controls facing`;
    } else if (fighter.controller === "p1") {
      fighter.controlHint = `${FACTION_NAMES[faction]} · WASD aim/move · Space/F attack · Left Shift special`;
    } else {
      fighter.controlHint = `${FACTION_NAMES[faction]} · Arrows aim/move · Enter or / attack · Right Shift special`;
    }
  }

  const p1 = combat.fighters.find((fighter) => fighter.controller === "p1");
  const p2 = combat.fighters.find((fighter) => fighter.controller === "p2");
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
  combat.nowMs = nowMs;

  if (combat.state === "combatIntro" || combat.state === "combatCountdown") {
    combat.state = "combatCountdown";
    combat.countdown = Math.max(0, combat.countdown - deltaSec);
    if (combat.countdown <= 0) {
      combat.message = "Fight! Movement controls facing.";
      combat.state = "combatActive";
      audio.beep("countdown");
    }
    return null;
  }

  if (combat.state === "combatResolving") {
    combat.resolveTimer -= deltaSec;
    return combat.resolveTimer <= 0 ? resolveCombat(combat) : null;
  }

  combat.elapsedSec += deltaSec;
  combat.overtimeMultiplier = getOvertimeMultiplier(combat.elapsedSec);
  const overtimeStage = combat.elapsedSec >= 60 ? 2 : combat.elapsedSec >= 45 ? 1 : 0;
  if (overtimeStage > combat.overtimeStage) {
    combat.overtimeStage = overtimeStage;
    combat.message = overtimeStage === 1 ? "Overtime: all damage +25%." : "Critical overtime: all damage +50%.";
    audio.beep("special");
  }

  for (const fighter of combat.fighters) {
    fighter.attackCooldown = Math.max(0, fighter.attackCooldown - deltaSec);
    fighter.specialCooldown = Math.max(0, fighter.specialCooldown - deltaSec);
    if (!fighter.pendingAction) {
      tickFighterState(fighter, nowMs);
    }
  }

  const [first, second] = combat.fighters;
  controlFighter(game, combat, first, second, actions, deltaSec, nowMs, audio);
  controlFighter(game, combat, second, first, actions, deltaSec, nowMs, audio);
  moveFighter(first, second, combat, deltaSec, nowMs, audio);
  moveFighter(second, first, combat, deltaSec, nowMs, audio);
  resolveFighterCollision(first, second);
  updatePersistentSpecials(combat, deltaSec, nowMs, audio);
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

function intentForFighter(game, fighter, opponent, combat, actions, nowMs) {
  if (fighter.controller === "p1") {
    return {
      moveX: actions.p1MoveX,
      moveY: actions.p1MoveY,
      useAttack: actions.p1Attack,
      useSpecial: actions.p1Special,
    };
  }
  if (fighter.controller === "p2") {
    return {
      moveX: actions.p2MoveX,
      moveY: actions.p2MoveY,
      useAttack: actions.p2Attack,
      useSpecial: actions.p2Special,
    };
  }
  return getDuelAiIntent(fighter, opponent, combat, nowMs, game.difficulty, combat.rng);
}

function controlFighter(game, combat, fighter, opponent, actions, dt, nowMs, audio) {
  const intent = intentForFighter(game, fighter, opponent, combat, actions, nowMs);
  progressAction(fighter, opponent, combat, nowMs, audio);
  if (fighter.state === FighterState.DEAD) {
    return;
  }

  let moveX = intent.moveX;
  let moveY = intent.moveY;
  const magnitude = Math.hypot(moveX, moveY);
  if (magnitude > 1) {
    moveX /= magnitude;
    moveY /= magnitude;
  }
  if (magnitude > 0.08 && !fighter.pendingAction && !fighter.dash) {
    fighter.facingX = moveX / Math.max(0.001, Math.hypot(moveX, moveY));
    fighter.facingY = moveY / Math.max(0.001, Math.hypot(moveX, moveY));
  }

  const busy = Boolean(fighter.pendingAction);
  const hardLocked = isFighterLocked(fighter);
  const movementScale = hardLocked ? 0.12 : busy ? 0.5 : 1;
  const targetVx = moveX * fighter.speed * movementScale;
  const targetVy = moveY * fighter.speed * movementScale;
  const response = Math.min(1, dt * 12);
  fighter.vx += (targetVx - fighter.vx) * response;
  fighter.vy += (targetVy - fighter.vy) * response;

  if (!busy && !fighter.dash && fighter.state !== FighterState.STUNNED) {
    fighter.state = magnitude > 0.05 ? FighterState.MOVE : FighterState.IDLE;
  }
  if (!busy && !hardLocked && !fighter.dash) {
    if (intent.useSpecial) {
      beginSpecial(fighter, combat, nowMs, audio);
    } else if (intent.useAttack) {
      beginAttack(fighter, combat, nowMs, audio);
    }
  }
}

function scheduleAction(fighter, kind, timing, nowMs) {
  const activeAt = nowMs + timing.startupMs;
  const recoverAt = activeAt + timing.activeMs;
  fighter.pendingAction = {
    kind,
    executed: false,
    activeAt,
    recoverAt,
    endAt: recoverAt + timing.recoveryMs,
    facingX: fighter.facingX,
    facingY: fighter.facingY,
  };
}

function progressAction(fighter, opponent, combat, nowMs, audio) {
  const action = fighter.pendingAction;
  if (!action) {
    return;
  }
  if (!action.executed && nowMs >= action.activeAt) {
    action.executed = true;
    fighter.facingX = action.facingX;
    fighter.facingY = action.facingY;
    if (action.kind === "attack") {
      setFighterState(fighter, FighterState.ATTACK_ACTIVE, nowMs, Math.max(0, action.recoverAt - nowMs));
      executeAttack(fighter, opponent, combat, audio);
    } else {
      setFighterState(fighter, FighterState.SPECIAL_ACTIVE, nowMs, Math.max(0, action.recoverAt - nowMs));
      executeSpecial(fighter, opponent, combat, nowMs, audio);
    }
  }
  if (action.executed && nowMs >= action.recoverAt && nowMs < action.endAt) {
    const recovery = action.kind === "attack" ? FighterState.ATTACK_RECOVERY : FighterState.SPECIAL_RECOVERY;
    if (fighter.state !== recovery) {
      setFighterState(fighter, recovery, nowMs, Math.max(0, action.endAt - nowMs));
    }
  }
  if (nowMs >= action.endAt) {
    fighter.pendingAction = null;
    if (!fighter.dash) {
      fighter.state = FighterState.IDLE;
      fighter.stateUntil = 0;
    }
  }
}

function beginAttack(fighter, combat, nowMs, audio) {
  if (fighter.attackCooldown > 0 || combat.state !== "combatActive") {
    return;
  }
  const def = UNIT_DEFS[fighter.unit.type];
  const actionTiming = createActionTiming(def, "attack");
  fighter.attackCooldown = def.attack.cooldown;
  scheduleAction(fighter, "attack", actionTiming, nowMs);
  setFighterState(fighter, FighterState.ATTACK_STARTUP, nowMs, actionTiming.startupMs);
  audio.beep("attack");
}

function executeAttack(fighter, opponent, combat, audio) {
  const attack = UNIT_DEFS[fighter.unit.type].attack;
  if (attack.kind === "melee") {
    if (directionalMeleeHit(fighter, opponent, attack.range, attack.arcDeg)) {
      damageFighter(opponent, fighter.damage, fighter, combat, audio);
      applyKnockback(opponent, fighter.facingX, fighter.facingY, attack.knockback);
    }
    return;
  }
  fireProjectile(fighter, fighter.damage, combat, {
    speed: attack.projectileSpeed,
    radius: attack.projectileRadius,
    range: attack.range,
  });
}

function beginSpecial(fighter, combat, nowMs, audio) {
  if (fighter.specialCooldown > 0 || combat.state !== "combatActive") {
    return;
  }
  const def = UNIT_DEFS[fighter.unit.type];
  const actionTiming = createActionTiming(def, "special");
  fighter.specialCooldown = def.special.cooldown;
  fighter.specialCooldownMax = def.special.cooldown;
  scheduleAction(fighter, "special", actionTiming, nowMs);
  setFighterState(fighter, FighterState.SPECIAL_STARTUP, nowMs, actionTiming.startupMs);
  combat.message = `${def.name}: ${def.special.name}`;
  audio.beep("special");
}

function executeSpecial(fighter, opponent, combat, nowMs, audio) {
  const def = UNIT_DEFS[fighter.unit.type];
  const special = def.special;
  if (special.kind === "shield") {
    fighter.shieldUntil = nowMs + special.durationMs;
    fighter.shieldDamageScale = special.damageScale;
    spawnFx(combat, fighter.x, fighter.y, "#6dfcff", 18);
  } else if (special.kind === "dash") {
    fighter.dash = {
      vx: fighter.facingX * special.dashSpeed,
      vy: fighter.facingY * special.dashSpeed,
      until: nowMs + special.timing.activeMs,
      damage: fighter.damage * special.damageMultiplier,
      knockback: special.knockback,
      hit: false,
    };
    fighter.state = FighterState.DASHING;
  } else if (special.kind === "chargedProjectile") {
    fireProjectile(fighter, fighter.damage * special.damageMultiplier, combat, {
      speed: special.projectileSpeed,
      radius: special.projectileRadius,
      range: special.range,
    });
  } else if (special.kind === "barrier") {
    deployBarrier(fighter, combat, special, nowMs);
  } else if (special.kind === "repairBurst") {
    fighter.hp = clamp(fighter.hp + special.heal, 0, fighter.maxHp);
    fireSpread(fighter, fighter.damage * special.damageMultiplier, combat, 2, special.spreadRad);
    spawnFx(combat, fighter.x, fighter.y, "#7dff96", 14);
  } else if (special.kind === "radialBlast") {
    if (dist2d(fighter, opponent) <= special.radius + opponent.radius) {
      damageFighter(opponent, fighter.damage * special.damageMultiplier, fighter, combat, audio);
      const distance = Math.max(1, dist2d(fighter, opponent));
      applyKnockback(
        opponent,
        (opponent.x - fighter.x) / distance,
        (opponent.y - fighter.y) / distance,
        special.knockback,
      );
    }
    spawnFx(combat, fighter.x, fighter.y, "#ffdc63", 36);
  } else if (special.kind === "aura") {
    fighter.auraUntil = nowMs + special.durationMs;
    spawnFx(combat, fighter.x, fighter.y, "#d56bff", 24);
  } else if (special.kind === "heavyProjectile") {
    fireProjectile(fighter, fighter.damage * special.damageMultiplier, combat, {
      speed: special.projectileSpeed,
      radius: special.projectileRadius,
      range: special.range,
    });
  } else if (special.kind === "blink") {
    blinkFighter(fighter, combat, special, nowMs);
  } else if (special.kind === "spread") {
    fireSpread(fighter, fighter.damage * special.damageMultiplier, combat, special.count, special.spreadRad);
  } else if (special.kind === "gravityCone") {
    fighter.pullUntil = nowMs + special.timing.activeMs;
    fighter.pullImpactAt = fighter.pullUntil - 90;
    fighter.pullImpacted = false;
    spawnFx(combat, fighter.x, fighter.y, "#d56bff", 24);
  }
}

function moveFighter(fighter, opponent, combat, dt, nowMs, audio) {
  const start = { x: fighter.x, y: fighter.y };
  if (fighter.dash && nowMs < fighter.dash.until) {
    fighter.x += fighter.dash.vx * dt;
    fighter.y += fighter.dash.vy * dt;
  } else {
    fighter.dash = null;
    fighter.x += fighter.vx * dt;
    fighter.y += fighter.vy * dt;
  }
  fighter.x = clamp(fighter.x, ARENA.minX + fighter.radius, ARENA.maxX - fighter.radius);
  fighter.y = clamp(fighter.y, ARENA.minY + fighter.radius, ARENA.maxY - fighter.radius);
  const collided = resolveFighterObstacles(fighter, combat.obstacles);

  if (fighter.dash) {
    if (
      !fighter.dash.hit &&
      sweptCircleHit(start, fighter, opponent, fighter.radius + opponent.radius)
    ) {
      fighter.dash.hit = true;
      damageFighter(opponent, fighter.dash.damage, fighter, combat, audio);
      applyKnockback(opponent, fighter.facingX, fighter.facingY, fighter.dash.knockback);
    }
    if (collided) {
      fighter.dash.until = nowMs;
    }
  }
}

function resolveFighterCollision(first, second) {
  const dx = second.x - first.x;
  const dy = second.y - first.y;
  const distance = Math.hypot(dx, dy);
  const overlap = first.radius + second.radius - distance;
  if (overlap <= 0) {
    return;
  }
  const nx = distance > 0 ? dx / distance : 1;
  const ny = distance > 0 ? dy / distance : 0;
  first.x -= nx * overlap * 0.5;
  first.y -= ny * overlap * 0.5;
  second.x += nx * overlap * 0.5;
  second.y += ny * overlap * 0.5;
  first.vx *= 0.65;
  first.vy *= 0.65;
  second.vx *= 0.65;
  second.vy *= 0.65;
}

function updatePersistentSpecials(combat, dt, nowMs, audio) {
  for (const fighter of combat.fighters) {
    const opponent = combat.fighters[1 - fighter.slot];
    const special = UNIT_DEFS[fighter.unit.type].special;
    if (fighter.auraUntil > nowMs && dist2d(fighter, opponent) <= special.radius + opponent.radius) {
      damageFighter(opponent, special.dps * dt, fighter, combat, audio, true);
    }
    if (fighter.pullUntil > nowMs) {
      const dx = opponent.x - fighter.x;
      const dy = opponent.y - fighter.y;
      const distance = Math.max(1, Math.hypot(dx, dy));
      if (directionalMeleeHit(fighter, opponent, special.range, special.arcDeg)) {
        opponent.vx -= (dx / distance) * special.pullForce * dt;
        opponent.vy -= (dy / distance) * special.pullForce * dt;
      }
      if (!fighter.pullImpacted && nowMs >= fighter.pullImpactAt) {
        fighter.pullImpacted = true;
        if (directionalMeleeHit(fighter, opponent, special.impactRange, special.arcDeg)) {
          damageFighter(opponent, fighter.damage * special.damageMultiplier, fighter, combat, audio);
          applyKnockback(opponent, fighter.facingX, fighter.facingY, 170);
        }
      }
    }
  }
}

function deployBarrier(fighter, combat, special, nowMs) {
  const horizontalFacing = Math.abs(fighter.facingX) >= Math.abs(fighter.facingY);
  const centerX = fighter.x + fighter.facingX * special.distance;
  const centerY = fighter.y + fighter.facingY * special.distance;
  const width = horizontalFacing ? special.width : special.height;
  const height = horizontalFacing ? special.height : special.width;
  combat.barriers.push({
    x: centerX - width / 2,
    y: centerY - height / 2,
    width,
    height,
    ownerSlot: fighter.slot,
    until: nowMs + special.durationMs,
  });
}

function blinkFighter(fighter, combat, special, nowMs) {
  let distance = special.distance;
  const origin = { x: fighter.x, y: fighter.y };
  while (distance > 20) {
    const candidate = {
      ...fighter,
      x: clamp(origin.x + fighter.facingX * distance, ARENA.minX + fighter.radius, ARENA.maxX - fighter.radius),
      y: clamp(origin.y + fighter.facingY * distance, ARENA.minY + fighter.radius, ARENA.maxY - fighter.radius),
    };
    if (!combat.obstacles.some((obstacle) => circleIntersectsRect(candidate, obstacle))) {
      fighter.x = candidate.x;
      fighter.y = candidate.y;
      break;
    }
    distance -= 15;
  }
  fighter.invisUntil = nowMs + special.invulnerableMs;
  fighter.invulnerableUntil = nowMs + special.invulnerableMs;
  setFighterState(fighter, FighterState.PHASING, nowMs, special.invulnerableMs);
  spawnFx(combat, origin.x, origin.y, "#d56bff", 14);
  spawnFx(combat, fighter.x, fighter.y, "#d56bff", 18);
}

function fireSpread(fighter, damage, combat, count, totalSpread) {
  if (count <= 1) {
    fireProjectile(fighter, damage, combat);
    return;
  }
  for (let index = 0; index < count; index += 1) {
    const offset = -totalSpread / 2 + (totalSpread * index) / (count - 1);
    fireProjectile(fighter, damage, combat, { angleOffset: offset });
  }
}

function fireProjectile(fighter, damage, combat, overrides = {}) {
  const attack = UNIT_DEFS[fighter.unit.type].attack;
  const angle = Math.atan2(fighter.facingY, fighter.facingX) + (overrides.angleOffset || 0);
  const speed = overrides.speed || attack.projectileSpeed || 360;
  const radius = overrides.radius || attack.projectileRadius || 5;
  const range = overrides.range || attack.range;
  combat.projectiles.push({
    x: fighter.x + Math.cos(angle) * (fighter.radius + radius + 2),
    y: fighter.y + Math.sin(angle) * (fighter.radius + radius + 2),
    vx: Math.cos(angle) * speed,
    vy: Math.sin(angle) * speed,
    damage,
    ownerId: fighter.id,
    ownerSlot: fighter.slot,
    radius,
    traveled: 0,
    maxDistance: range,
    color: UNIT_DEFS[fighter.unit.type].faction === "S" ? "#6dfcff" : "#d56bff",
  });
}

function updateProjectiles(combat, dt, nowMs, audio) {
  combat.barriers = combat.barriers.filter((barrier) => barrier.until > nowMs);
  for (const projectile of combat.projectiles) {
    const startX = projectile.x;
    const startY = projectile.y;
    projectile.x += projectile.vx * dt;
    projectile.y += projectile.vy * dt;
    projectile.traveled += Math.hypot(projectile.x - startX, projectile.y - startY);

    const blockingBarriers = combat.barriers.filter(
      (barrier) => barrier.ownerSlot !== projectile.ownerSlot,
    );
    if (
      projectileHitsObstacle(projectile, combat.obstacles) ||
      projectileHitsObstacle(projectile, blockingBarriers)
    ) {
      projectile.traveled = projectile.maxDistance + 1;
      spawnFx(combat, projectile.x, projectile.y, projectile.color, 5);
      continue;
    }

    const opponent = combat.fighters[1 - projectile.ownerSlot];
    if (
      opponent.hp > 0 &&
      Math.hypot(projectile.x - opponent.x, projectile.y - opponent.y) <
        projectile.radius + opponent.radius
    ) {
      const owner = combat.fighters[projectile.ownerSlot];
      damageFighter(opponent, projectile.damage, owner, combat, audio);
      projectile.traveled = projectile.maxDistance + 1;
    }
  }

  combat.projectiles = combat.projectiles.filter(
    (projectile) =>
      projectile.traveled <= projectile.maxDistance &&
      projectile.x > -30 &&
      projectile.x < 990 &&
      projectile.y > -30 &&
      projectile.y < 550,
  );
  combat.effects = combat.effects.filter((effect) => effect.until > nowMs);
  combat.beams = combat.beams.filter((beam) => beam.until > nowMs);
}

function applyKnockback(target, x, y, amount) {
  target.vx += x * amount;
  target.vy += y * amount;
}

export function damageFighter(target, amount, source, combat, audio, quiet = false) {
  if (target.invulnerableUntil > combat.nowMs) {
    return 0;
  }
  let damage = amount * combat.overtimeMultiplier;
  if (target.shieldUntil > combat.nowMs) {
    damage *= target.shieldDamageScale;
  }
  target.hp -= damage;
  target.hurtUntil = combat.nowMs + 110;
  if (!quiet) {
    audio.beep("hit");
    spawnFx(
      combat,
      target.x,
      target.y,
      UNIT_DEFS[source.unit.type].faction === "S" ? "#6dfcff" : "#d56bff",
      6,
    );
  }
  return damage;
}

function spawnFx(combat, x, y, color, count = 10) {
  const now = combat.nowMs;
  for (let index = 0; index < count; index += 1) {
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
  const [attacker, defender] = combat.fighters;
  const attackerAlive = attacker.hp > 0;
  const defenderAlive = defender.hp > 0;
  if (attackerAlive && !defenderAlive) {
    return {
      attackerId: combat.attackerId,
      defenderId: combat.defenderId,
      targetRow: combat.targetRow,
      targetCol: combat.targetCol,
      winner: "attacker",
      survivorHp: attacker.hp / (attacker.mod.hp * COMBAT_HP_SCALE),
      reason: `${UNIT_DEFS[attacker.unit.type].name} won the duel.`,
    };
  }
  if (defenderAlive && !attackerAlive) {
    return {
      attackerId: combat.attackerId,
      defenderId: combat.defenderId,
      targetRow: combat.targetRow,
      targetCol: combat.targetCol,
      winner: "defender",
      survivorHp: defender.hp / (defender.mod.hp * COMBAT_HP_SCALE),
      reason: `${UNIT_DEFS[defender.unit.type].name} held the square.`,
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
