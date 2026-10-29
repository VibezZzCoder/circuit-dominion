// SPDX-License-Identifier: GPL-3.0-or-later
// Additional terms under GPL-3.0 section 7 apply; see NOTICE.md.
// Arena presentation. Reads the duel state and its visual event log; owns only
// visual memory (particles, flip easing, afterimages). Every timed visual is
// driven by combat.nowMs so Pause and Help freeze the whole scene.
import { ARENA } from "./combat.js";
import { UNIT_DEFS } from "./units.js";
import { FACTION_NAMES, clamp } from "./utils.js";
import {
  PALETTE,
  ParticleSystem,
  ScreenShake,
  easeOutBack,
  easeOutCubic,
  factionColor,
  glowSprite,
  roundRectPath,
  scaledSprite,
  tintedSprite,
  withAlpha,
} from "./fx.js";

const NULL_PARTICLES = { add() {}, burst() {} };

// combat-arena.webp is a top-down floor at 2x the 960x520 arena. A slight zoom
// pushes its raised rim (about 44 logical px) just outside the walkable bounds.
const ARENA_FLOOR_ZOOM = 1.06;

export const ARENA_WIDTH = 960;
export const ARENA_HEIGHT = 520;

// Direction the generated art already faces (+1 right, -1 left). Sprites are
// mirrored so weapons point toward the current aim.
export const ART_FACING = { AS: 1, PS: -1, EC: -1, RC: -1, GW: -1 };
// How long the attack pose replaces the idle sprite after a swing/shot/special.
export const ATTACK_POSE_MS = 190;
// Units that visibly float; they bob more and keep a detached shadow.
const HOVERING = new Set(["SD", "PM", "GW", "CB"]);
const TAG_VISIBLE_AFTER_FIGHT_MS = 2600;

function spriteSizeFor(def) {
  return def.radius * 3.9;
}

export class ArenaRenderer {
  constructor(assets) {
    this.assets = assets;
    this.particles = new ParticleSystem(560);
    this.shake = new ScreenShake();
    this.reset(null);
  }

  reset(combat) {
    this.combatRef = combat;
    this.lastSeq = 0;
    this.lastNow = combat ? combat.nowMs : 0;
    this.particles.clear();
    this.shake.trauma = 0;
    this.decals = [];
    this.slashes = [];
    this.flash = null;
    this.banner = null;
    this.fightAt = null;
    this.fighterVisuals = [this.newVisual(), this.newVisual()];
    this.quietDamage = [0, 0];
    this.quietShownAt = [0, 0];
    if (combat) {
      combat.fighters.forEach((fighter, slot) => {
        const visual = this.fighterVisuals[slot];
        const art = ART_FACING[fighter.unit.type] || 1;
        visual.flip = Math.sign(fighter.facingX || (slot ? -1 : 1)) * art;
        visual.flipTarget = visual.flip;
        visual.lastX = fighter.x;
        visual.lastY = fighter.y;
      });
    }
  }

  newVisual() {
    return {
      flip: 1,
      flipTarget: 1,
      lastX: 0,
      lastY: 0,
      vx: 0,
      vy: 0,
      afterimages: [],
      lastAfterimageAt: -1e9,
      koAt: null,
      healAt: -1e9,
      poseAt: -1e9,
    };
  }

  // Called once per drawn frame before painting.
  sync(combat) {
    if (combat !== this.combatRef) this.reset(combat);
    const now = combat.nowMs;
    const gap = (now - this.lastNow) / 1000;
    if (gap > 0.25) this.particles.clear();
    const dt = clamp(gap, 0, 0.05);
    this.lastNow = now;
    for (const event of combat.events || []) {
      if (event.seq <= this.lastSeq) continue;
      this.lastSeq = event.seq;
      this.handleEvent(combat, event);
    }
    this.updateVisuals(combat, dt, now);
    this.particles.update(dt);
    this.shake.update(dt);
    this.decals = this.decals.filter((decal) => now - decal.t < decal.life);
    return dt;
  }

  handleEvent(combat, event) {
    // Time visuals from the event itself; after an undrawn gap, only the
    // lasting state (KO, banners) is restored, not a backlog of particles.
    const now = event.t;
    const stale = combat.nowMs - event.t > 400;
    const p = stale ? NULL_PARTICLES : this.particles;
    const color = factionColor(event.faction || event.sourceFaction);
    if ((event.type === "swing" || event.type === "shot" || event.type === "special") && this.fighterVisuals[event.slot]) {
      this.fighterVisuals[event.slot].poseAt = now;
    }
    switch (event.type) {
      case "shot": {
        const big = event.kind === "shell" || event.kind === "lance";
        p.burst(event.x, event.y, {
          count: big ? 14 : 6,
          speed: big ? 260 : 180,
          angle: event.angle,
          spread: big ? 1.1 : 0.8,
          color: event.faction === "S" ? PALETTE.solarHot : PALETTE.voidHot,
          life: 0.22,
          size: big ? 3.4 : 2.4,
          drag: 9,
        });
        p.add({ type: "glow", x: event.x, y: event.y, size: big ? 34 : 20, life: 0.12, color });
        if (event.kind === "shell") this.shake.add(0.18);
        if (event.kind === "lance") this.shake.add(0.12);
        break;
      }
      case "swing": {
        if (!stale) this.addSlash(event, now);
        break;
      }
      case "hit": {
        const target = combat.fighters[event.slot];
        const hitColor = factionColor(event.sourceFaction);
        if (event.quiet) {
          this.quietDamage[event.slot] += event.amount;
          if (now - this.quietShownAt[event.slot] > 450 && this.quietDamage[event.slot] >= 1) {
            this.addDamageNumber(event.x, event.y - 40, this.quietDamage[event.slot], withAlpha(hitColor, 0.9), 15);
            this.quietDamage[event.slot] = 0;
            this.quietShownAt[event.slot] = now;
          }
          if (Math.random() < 0.3) {
            p.add({ type: "glow", x: event.x + (Math.random() - 0.5) * 30, y: event.y + (Math.random() - 0.5) * 30, size: 10, life: 0.3, color: hitColor });
          }
          break;
        }
        p.burst(event.x, event.y, { count: 14, speed: 300, color: hitColor, life: 0.38, size: 2.8, drag: 6 });
        p.burst(event.x, event.y, { count: 5, speed: 120, color: "#ffffff", life: 0.2, size: 2, drag: 8 });
        p.add({ type: "glow", x: event.x, y: event.y, size: 46, life: 0.16, color: "#ffffff", alpha: 0.75 });
        p.add({ type: "ring", x: event.x, y: event.y, size: 10, grow: 220, life: 0.24, color: hitColor, width: 3 });
        if (event.amount >= 0.5) this.addDamageNumber(event.x, (target?.y ?? event.y) - 46, event.amount, "#ffffff", 18 + Math.min(10, event.amount / 4));
        this.shake.add(clamp(event.amount / 70, 0.06, 0.32));
        break;
      }
      case "block": {
        const speed = Math.hypot(event.vx || 0, event.vy || 0) || 1;
        const back = Math.atan2(-(event.vy || 0) / speed, -(event.vx || 0) / speed);
        p.burst(event.x, event.y, { count: event.kind === "shell" ? 20 : 9, speed: 240, angle: back, spread: 2.2, color, life: 0.3, size: 2.4, drag: 7 });
        p.add({ type: "glow", x: event.x, y: event.y, size: event.kind === "shell" ? 50 : 24, life: 0.15, color });
        if (event.kind === "shell") {
          this.shake.add(0.2);
          p.burst(event.x, event.y, { type: "smoke", count: 6, speed: 50, color: "#1b1026", life: 0.9, size: 18, grow: 26, drag: 2 });
        }
        break;
      }
      case "fizzle": {
        p.add({ type: "ring", x: event.x, y: event.y, size: 3, grow: 60, life: 0.22, color, width: 2 });
        p.burst(event.x, event.y, { count: 4, speed: 60, color, life: 0.25, size: 1.8 });
        if (event.kind === "shell") this.decals.push({ x: event.x, y: event.y, r: 18, t: now, life: 3500, color: "#120818" });
        break;
      }
      case "special": {
        if (!stale) this.handleSpecialEvent(combat, event, now);
        break;
      }
      case "gravityImpact": {
        if (!stale) this.addSlash({ ...event, arcDeg: 80, range: event.range, faction: "V", heavy: true }, now);
        p.add({ type: "ring", x: event.x, y: event.y, size: 20, grow: 420, life: 0.32, color: PALETTE.void, width: 5 });
        this.shake.add(0.3);
        break;
      }
      case "heal": {
        this.fighterVisuals[event.slot].healAt = now;
        for (let i = 0; i < 10; i += 1) {
          p.add({ type: "glow", x: event.x + (Math.random() - 0.5) * 44, y: event.y + 10 - Math.random() * 30, vy: -60 - Math.random() * 50, drag: 1.5, size: 9, life: 0.7, color: PALETTE.heal });
        }
        if (event.amount >= 0.5) this.addDamageNumber(event.x, event.y - 50, event.amount, PALETTE.heal, 18, "+");
        break;
      }
      case "blink": {
        p.burst(event.fromX, event.fromY, { type: "shard", count: 14, speed: 140, color: PALETTE.void, life: 0.45, size: 4, spin: 10, drag: 4 });
        p.add({ type: "ring", x: event.fromX, y: event.fromY, size: 30, grow: -50, life: 0.25, color: PALETTE.voidHot, width: 2 });
        p.add({ type: "ring", x: event.toX, y: event.toY, size: 4, grow: 160, life: 0.3, color: PALETTE.void, width: 3 });
        p.add({ type: "glow", x: event.toX, y: event.toY, size: 60, life: 0.22, color: PALETTE.void });
        break;
      }
      case "ko": {
        this.fighterVisuals[event.slot].koAt = now;
        const koColor = factionColor(event.faction);
        p.burst(event.x, event.y, { count: 34, speed: 420, color: koColor, life: 0.8, size: 3.4, drag: 3 });
        p.burst(event.x, event.y, { count: 18, speed: 260, color: "#ffffff", life: 0.5, size: 2.4, drag: 4 });
        p.burst(event.x, event.y, { type: "shard", count: 16, speed: 300, color: event.faction === "S" ? "#d9c38a" : "#3a2350", life: 1.1, size: 5, spin: 14, drag: 2.2, gravity: 140 });
        p.burst(event.x, event.y, { type: "smoke", count: 10, speed: 70, color: "#140c1c", life: 1.4, size: 22, grow: 30, drag: 1.6 });
        p.add({ type: "ring", x: event.x, y: event.y, size: 16, grow: 520, life: 0.5, color: "#ffffff", width: 6 });
        p.add({ type: "ring", x: event.x, y: event.y, size: 10, grow: 300, life: 0.7, color: koColor, width: 4 });
        p.add({ type: "glow", x: event.x, y: event.y, size: 150, life: 0.4, color: koColor });
        this.decals.push({ x: event.x, y: event.y + 18, r: 34, t: now, life: 6000, color: "#0a0610" });
        this.shake.add(0.75);
        this.flash = { t: now, life: 260, color: "#ffffff", alpha: 0.42 };
        this.setKoBanner(combat, now);
        break;
      }
      case "specialReady": {
        const fighter = combat.fighters[event.slot];
        if (fighter) p.add({ type: "ring", x: fighter.x, y: fighter.y + fighter.radius * 0.7, size: fighter.radius, grow: 90, life: 0.35, color: PALETTE.gold, width: 2.5, layer: "ground" });
        break;
      }
      case "fight": {
        this.fightAt = now;
        this.flash = { t: now, life: 220, color: "#ffffff", alpha: 0.18 };
        break;
      }
      case "overtime": {
        this.banner = { t: now, life: 1600, text: event.stage === 2 ? "CRITICAL OVERTIME" : "OVERTIME", sub: event.stage === 2 ? "All damage +50%" : "All damage +25%", color: PALETTE.danger };
        this.flash = { t: now, life: 420, color: PALETTE.danger, alpha: 0.16 };
        break;
      }
      default:
        break;
    }
  }

  handleSpecialEvent(combat, event, now) {
    const p = this.particles;
    const color = factionColor(event.faction);
    const fighter = combat.fighters[event.slot];
    const def = UNIT_DEFS[fighter.unit.type];
    p.add({ type: "text", text: def.special.name.toUpperCase(), x: event.x, y: event.y - 70, vy: -28, drag: 1.5, life: 0.9, size: 15, color });
    p.add({ type: "glow", x: event.x, y: event.y, size: 70, life: 0.25, color });
    if (event.kind === "radialBlast") {
      const radius = def.special.radius;
      p.add({ type: "ring", x: event.x, y: event.y, size: 20, grow: radius * 5.2, life: 0.26, color: PALETTE.solarGold, width: 8 });
      p.add({ type: "ring", x: event.x, y: event.y, size: 10, grow: radius * 3.6, life: 0.4, color: "#ffffff", width: 3 });
      p.burst(event.x, event.y, { count: 40, speed: 520, color: PALETTE.solarGold, life: 0.4, size: 3, drag: 5 });
      this.decals.push({ x: event.x, y: event.y + 14, r: radius * 0.7, t: now, life: 2600, color: "#2a1f08" });
      this.shake.add(0.5);
      this.flash = { t: now, life: 200, color: PALETTE.solarGold, alpha: 0.2 };
    } else if (event.kind === "shield") {
      p.add({ type: "ring", x: event.x, y: event.y - 8, size: 20, grow: 120, life: 0.3, color: PALETTE.solarHot, width: 4 });
    } else if (event.kind === "dash") {
      p.burst(event.x, event.y, { count: 16, speed: 260, angle: event.angle + Math.PI, spread: 1.2, color, life: 0.3, size: 2.6 });
      this.shake.add(0.12);
    } else if (event.kind === "aura") {
      p.add({ type: "ring", x: event.x, y: event.y, size: 10, grow: def.special.radius * 3.5, life: 0.3, color: PALETTE.voidHot, width: 4 });
    } else if (event.kind === "barrier") {
      p.burst(event.x + Math.cos(event.angle) * def.special.distance, event.y + Math.sin(event.angle) * def.special.distance, { count: 18, speed: 160, color: PALETTE.solarHot, life: 0.35, size: 2.2 });
    } else if (event.kind === "gravityCone") {
      p.add({ type: "ring", x: event.x, y: event.y, size: 60, grow: -160, life: 0.35, color: PALETTE.void, width: 4 });
    }
  }

  addSlash(event, now) {
    const color = factionColor(event.faction);
    this.slashes = (this.slashes || []).filter((slash) => now >= slash.t && now - slash.t < slash.life);
    this.slashes.push({
      slot: event.slot,
      x: event.x,
      y: event.y,
      angle: event.angle,
      range: event.range,
      arc: ((event.arcDeg || 90) * Math.PI) / 180,
      color,
      t: now,
      life: event.heavy ? 260 : 190,
      heavy: Boolean(event.heavy),
    });
    const tipX = event.x + Math.cos(event.angle) * event.range * 0.8;
    const tipY = event.y + Math.sin(event.angle) * event.range * 0.8;
    this.particles.burst(tipX, tipY, { count: 7, speed: 170, angle: event.angle, spread: 1.6, color, life: 0.22, size: 2.2 });
  }

  addDamageNumber(x, y, amount, color, size, prefix = "") {
    this.particles.add({
      type: "text",
      text: `${prefix}${Math.max(1, Math.round(amount))}`,
      x: x + (Math.random() - 0.5) * 16,
      y,
      vy: -70,
      drag: 2.4,
      life: 0.85,
      size,
      color,
    });
  }

  setKoBanner(combat, now) {
    const [first, second] = combat.fighters;
    const alive = combat.fighters.filter((fighter) => fighter.hp > 0);
    if (alive.length === 1) {
      const winner = alive[0];
      const def = UNIT_DEFS[winner.unit.type];
      const attackerWon = winner === first;
      this.banner = {
        t: now,
        life: 1300,
        text: `${def.name.toUpperCase()} WINS`,
        sub: attackerWon ? "Square captured" : "Square defended",
        color: factionColor(def.faction, false),
        faction: def.faction,
      };
    } else if (!first.hp && !second.hp) {
      this.banner = { t: now, life: 1300, text: "DOUBLE KO", sub: "Both robots destroyed", color: PALETTE.gold };
    }
  }

  updateVisuals(combat, dt, now) {
    combat.fighters.forEach((fighter, slot) => {
      const visual = this.fighterVisuals[slot];
      if (dt > 0) {
        const vx = (fighter.x - visual.lastX) / dt;
        const vy = (fighter.y - visual.lastY) / dt;
        const blend = 1 - Math.exp(-dt * 14);
        visual.vx += (clamp(vx, -900, 900) - visual.vx) * blend;
        visual.vy += (clamp(vy, -900, 900) - visual.vy) * blend;
      }
      visual.lastX = fighter.x;
      visual.lastY = fighter.y;
      const art = ART_FACING[fighter.unit.type] || 1;
      if (Math.abs(fighter.facingX) > 0.25) visual.flipTarget = Math.sign(fighter.facingX) * art;
      const step = dt / 0.11;
      if (visual.flip < visual.flipTarget) visual.flip = Math.min(visual.flipTarget, visual.flip + step * 2);
      else if (visual.flip > visual.flipTarget) visual.flip = Math.max(visual.flipTarget, visual.flip - step * 2);
      if (fighter.dash && now - visual.lastAfterimageAt > 22) {
        visual.afterimages.push({ x: fighter.x, y: fighter.y, flip: visual.flip, t: now });
        visual.lastAfterimageAt = now;
      }
      visual.afterimages = visual.afterimages.filter((image) => now - image.t < 220).slice(-8);
      // Ambient particles that make specials read as ongoing effects.
      if (dt > 0) {
        const def = UNIT_DEFS[fighter.unit.type];
        if (fighter.auraUntil > now && Math.random() < dt * 40) {
          const a = Math.random() * Math.PI * 2;
          const r = def.special.radius * (0.6 + Math.random() * 0.4);
          this.particles.add({ type: "glow", x: fighter.x + Math.cos(a) * r, y: fighter.y + Math.sin(a) * r,
            vx: -Math.cos(a) * 80, vy: -Math.sin(a) * 80, drag: 0.5, size: 7, life: 0.5, color: PALETTE.void, layer: "ground" });
        }
        if (fighter.pullUntil > now && Math.random() < dt * 70) {
          const angle = Math.atan2(fighter.facingY, fighter.facingX) + (Math.random() - 0.5) * ((def.special.arcDeg || 70) * Math.PI / 180);
          const r = (def.special.range || 260) * (0.45 + Math.random() * 0.55);
          this.particles.add({ type: "spark", x: fighter.x + Math.cos(angle) * r, y: fighter.y + Math.sin(angle) * r,
            vx: -Math.cos(angle) * 420, vy: -Math.sin(angle) * 420, drag: 0.8, size: 2.2, life: 0.32, color: PALETTE.voidHot });
        }
        if (fighter.dash && Math.random() < dt * 60) {
          this.particles.add({ type: "glow", x: fighter.x + (Math.random() - 0.5) * 18, y: fighter.y + (Math.random() - 0.5) * 18, size: 12, life: 0.25, color: factionColor(def.faction), layer: "ground" });
        }
      }
    });
    for (const projectile of combat.projectiles) {
      if (dt <= 0) break;
      if (projectile.kind === "shell" && Math.random() < dt * 34) {
        this.particles.add({ type: "smoke", x: projectile.x, y: projectile.y, vx: (Math.random() - 0.5) * 30, vy: (Math.random() - 0.5) * 30,
          size: projectile.radius * 1.2, grow: 22, life: 0.6, drag: 2, color: "#1d0f2c", alpha: 0.7, layer: "ground" });
      } else if (Math.random() < dt * 22) {
        this.particles.add({ type: "glow", x: projectile.x, y: projectile.y, size: projectile.radius * 2.2, life: 0.22,
          color: factionColor(projectile.faction), alpha: 0.5 });
      }
    }
  }

  draw(ctx, combat, game, viewport) {
    this.sync(combat);
    const now = combat.nowMs;
    const shake = this.shake.offset(9);

    const bounds = viewport.bounds || { x: 0, y: 0, width: ARENA_WIDTH, height: ARENA_HEIGHT };
    ctx.save();
    ctx.translate(shake.x, shake.y);
    this.drawBackground(ctx, combat, bounds);
    this.drawDecals(ctx, now);
    this.drawGroundLayer(ctx, combat, now);
    this.particles.draw(ctx, "ground");

    for (const obstacle of combat.obstacles) {
      drawCoverShadow(ctx, obstacle);
      viewport.drawCover(obstacle, combat.energy);
    }
    for (const barrier of combat.barriers) this.drawBarrier(ctx, barrier, now);

    const order = [...combat.fighters].sort((a, b) => a.y - b.y);
    for (const fighter of order) this.drawFighter(ctx, combat, fighter, now, game, viewport);
    this.drawSlashes(ctx, now);
    for (const projectile of combat.projectiles) this.drawProjectile(ctx, projectile, now);
    this.particles.draw(ctx, "top");
    ctx.restore();

    this.drawOverlays(ctx, combat, game, now, bounds);
  }

  drawBackground(ctx, combat, bounds) {
    // Cover the whole visible canvas (including letterbox) around the arena center.
    const pad = 14;
    const bx = bounds.x - pad;
    const by = bounds.y - pad;
    const bw = bounds.width + pad * 2;
    const bh = bounds.height + pad * 2;
    const arenaImage = this.assets?.getImage("background.combat-arena");
    if (arenaImage) {
      // Centered on the arena; grows further only to cover a wider letterbox.
      const s = Math.max(ARENA_FLOOR_ZOOM, bw / ARENA_WIDTH, bh / ARENA_HEIGHT);
      const w = ARENA_WIDTH * s;
      const h = ARENA_HEIGHT * s;
      ctx.drawImage(arenaImage, ARENA_WIDTH / 2 - w / 2, ARENA_HEIGHT / 2 - h / 2, w, h);
    } else {
      const gradient = ctx.createLinearGradient(0, 0, ARENA_WIDTH, ARENA_HEIGHT);
      gradient.addColorStop(0, combat.energy === "L" ? "#0c3240" : combat.energy === "D" ? "#210c30" : "#101924");
      gradient.addColorStop(1, "#02060c");
      ctx.fillStyle = gradient;
      ctx.fillRect(bx, by, bw, bh);
    }
    // Polarity wash: Light warms the floor, Dark deepens it; Neutral stays clean.
    const wash = combat.energy === "L" ? "rgba(120,230,255,0.10)" : combat.energy === "D" ? "rgba(120,40,190,0.16)" : "rgba(8,14,24,0.18)";
    ctx.fillStyle = wash;
    ctx.fillRect(bx, by, bw, bh);
    const vignette = ctx.createRadialGradient(480, 260, 200, 480, 260, Math.max(620, bw * 0.62));
    vignette.addColorStop(0, "rgba(2,6,12,0)");
    vignette.addColorStop(1, "rgba(2,6,12,0.62)");
    ctx.fillStyle = vignette;
    ctx.fillRect(bx, by, bw, bh);

    if (combat.onNode) this.drawNodeEmblem(ctx, combat.nowMs);

    // Arena boundary: the walls fighters collide with.
    const edge = combat.energy === "L" ? PALETTE.solar : combat.energy === "D" ? PALETTE.void : "#b9d4e6";
    const w = ARENA.maxX - ARENA.minX;
    const h = ARENA.maxY - ARENA.minY;
    ctx.save();
    ctx.strokeStyle = withAlpha(edge, 0.22);
    ctx.lineWidth = 2;
    roundRectPath(ctx, ARENA.minX, ARENA.minY, w, h, 14);
    ctx.stroke();
    ctx.strokeStyle = withAlpha(edge, 0.75);
    ctx.lineWidth = 3;
    ctx.lineCap = "round";
    const c = 30;
    for (const [x, y, sx, sy] of [[ARENA.minX, ARENA.minY, 1, 1], [ARENA.maxX, ARENA.minY, -1, 1], [ARENA.minX, ARENA.maxY, 1, -1], [ARENA.maxX, ARENA.maxY, -1, -1]]) {
      ctx.beginPath();
      ctx.moveTo(x + sx * c, y);
      ctx.lineTo(x + sx * 8, y);
      ctx.quadraticCurveTo(x, y, x, y + sy * 8);
      ctx.lineTo(x, y + sy * c);
      ctx.stroke();
    }
    ctx.restore();
  }

  // Duels for a Power Node are fought over its reactor.
  drawNodeEmblem(ctx, now) {
    ctx.save();
    ctx.globalAlpha = 0.55;
    ctx.strokeStyle = withAlpha(PALETTE.gold, 0.7);
    ctx.lineWidth = 3;
    for (let index = 0; index < 8; index += 1) {
      const a = now / 2400 + (index * Math.PI) / 4;
      ctx.beginPath();
      ctx.ellipse(480, 262, 120, 52, 0, a, a + 0.5);
      ctx.stroke();
    }
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = withAlpha(PALETTE.gold, 0.45);
    ctx.beginPath();
    ctx.ellipse(480, 262, 86, 37, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  drawDecals(ctx, now) {
    for (const decal of this.decals) {
      const k = 1 - (now - decal.t) / decal.life;
      ctx.save();
      ctx.globalAlpha = 0.55 * k;
      ctx.fillStyle = decal.color;
      ctx.beginPath();
      ctx.ellipse(decal.x, decal.y, decal.r, decal.r * 0.45, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  }

  drawGroundLayer(ctx, combat, now) {
    for (const fighter of combat.fighters) {
      const def = UNIT_DEFS[fighter.unit.type];
      const visual = this.fighterVisuals[fighter.slot];
      if (visual.koAt !== null && now - visual.koAt > 700) continue;
      const color = factionColor(def.faction);
      const r = fighter.radius;
      const gx = fighter.x;
      const gy = fighter.y + r * 0.62;
      const hover = HOVERING.has(fighter.unit.type);
      const bob = hover ? Math.sin(now / 340 + fighter.slot * 2) : 0;

      // Contact shadow.
      ctx.save();
      ctx.fillStyle = "rgba(0,0,0,0.42)";
      ctx.beginPath();
      ctx.ellipse(gx, gy, r * (1.05 - bob * 0.06), r * (0.42 - bob * 0.03), 0, 0, Math.PI * 2);
      ctx.fill();

      // Faction ground ring with an aim notch: the persistent facing indicator.
      const alive = fighter.hp > 0;
      ctx.globalAlpha = alive ? 0.85 : 0.3;
      ctx.strokeStyle = withAlpha(color, 0.55);
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.ellipse(gx, gy, r * 1.32, r * 0.56, 0, 0, Math.PI * 2);
      ctx.stroke();
      if (alive) {
        const angle = Math.atan2(fighter.facingY, fighter.facingX);
        const rx = r * 1.32;
        const ry = r * 0.56;
        const px = gx + Math.cos(angle) * rx;
        const py = gy + Math.sin(angle) * ry;
        const nx = Math.cos(angle) / rx;
        const ny = Math.sin(angle) / ry;
        const nl = Math.hypot(nx, ny) || 1;
        const ox = nx / nl;
        const oy = ny / nl;
        ctx.fillStyle = color;
        ctx.globalAlpha = 0.95;
        ctx.beginPath();
        ctx.moveTo(px + ox * 9, py + oy * 9);
        ctx.lineTo(px - oy * 6 - ox * 1, py + ox * 6 - oy * 1);
        ctx.lineTo(px + oy * 6 - ox * 1, py - ox * 6 - oy * 1);
        ctx.closePath();
        ctx.fill();
      }
      ctx.restore();

      this.drawGroundTelegraph(ctx, combat, fighter, def, now);

      if (fighter.auraUntil > now) {
        const radius = def.special.radius;
        const remaining = clamp((fighter.auraUntil - now) / 300, 0, 1);
        ctx.save();
        ctx.globalAlpha = 0.9 * remaining;
        const gradient = ctx.createRadialGradient(fighter.x, fighter.y, radius * 0.2, fighter.x, fighter.y, radius);
        gradient.addColorStop(0, "rgba(60,10,90,0.05)");
        gradient.addColorStop(0.75, "rgba(150,50,220,0.16)");
        gradient.addColorStop(1, "rgba(213,107,255,0.32)");
        ctx.fillStyle = gradient;
        ctx.beginPath();
        ctx.arc(fighter.x, fighter.y, radius, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = withAlpha(PALETTE.void, 0.8);
        ctx.lineWidth = 2;
        ctx.setLineDash([10, 8]);
        ctx.lineDashOffset = -now / 30;
        ctx.beginPath();
        ctx.arc(fighter.x, fighter.y, radius, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.restore();
      }

      if (fighter.pullUntil > now) {
        const angle = Math.atan2(fighter.facingY, fighter.facingX);
        const half = (def.special.arcDeg * Math.PI) / 360;
        const range = def.special.range;
        ctx.save();
        const gradient = ctx.createRadialGradient(fighter.x, fighter.y, 10, fighter.x, fighter.y, range);
        gradient.addColorStop(0, "rgba(213,107,255,0.30)");
        gradient.addColorStop(1, "rgba(122,44,255,0.02)");
        ctx.fillStyle = gradient;
        ctx.beginPath();
        ctx.moveTo(fighter.x, fighter.y);
        ctx.arc(fighter.x, fighter.y, range, angle - half, angle + half);
        ctx.closePath();
        ctx.fill();
        ctx.strokeStyle = withAlpha(PALETTE.void, 0.55);
        ctx.lineWidth = 1.5;
        for (let i = 0; i < 3; i += 1) {
          const k = ((now / 420 + i / 3) % 1);
          ctx.globalAlpha = k;
          ctx.beginPath();
          ctx.arc(fighter.x, fighter.y, range * (1 - k * 0.85), angle - half, angle + half);
          ctx.stroke();
        }
        ctx.restore();
      }
    }
  }

  // Committed geometry for slow, high-impact specials stays readable, but drawn
  // as in-world energy (charge rings, laser sight, ground arrows) - not lines.
  drawGroundTelegraph(ctx, combat, fighter, def, now) {
    const action = fighter.pendingAction;
    if (!action || action.executed) return;
    const timing = action.kind === "attack" ? def.attack.timing : def.special.timing;
    const startAt = action.activeAt - timing.startupMs;
    const progress = clamp((now - startAt) / Math.max(1, timing.startupMs), 0, 1);
    const angle = Math.atan2(action.facingY, action.facingX);
    const color = factionColor(def.faction);
    ctx.save();
    if (action.kind === "attack" && def.attack.kind === "melee") {
      const half = (def.attack.arcDeg * Math.PI) / 360;
      ctx.globalAlpha = 0.1 + progress * 0.18;
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.moveTo(fighter.x, fighter.y);
      ctx.arc(fighter.x, fighter.y, def.attack.range * (0.55 + progress * 0.45), angle - half, angle + half);
      ctx.closePath();
      ctx.fill();
    } else if (action.kind === "special") {
      const special = def.special;
      if (special.kind === "radialBlast") {
        const radius = special.radius;
        ctx.globalAlpha = 0.25 + progress * 0.35;
        const gradient = ctx.createRadialGradient(fighter.x, fighter.y, 0, fighter.x, fighter.y, radius);
        gradient.addColorStop(0, withAlpha(PALETTE.solarGold, 0.04));
        gradient.addColorStop(0.92, withAlpha(PALETTE.solarGold, 0.18 + progress * 0.25));
        gradient.addColorStop(1, withAlpha(PALETTE.solarGold, 0));
        ctx.fillStyle = gradient;
        ctx.beginPath();
        ctx.arc(fighter.x, fighter.y, radius, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 0.85;
        ctx.strokeStyle = PALETTE.solarGold;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(fighter.x, fighter.y, radius * progress, 0, Math.PI * 2);
        ctx.stroke();
        ctx.globalAlpha = 0.45;
        ctx.beginPath();
        ctx.arc(fighter.x, fighter.y, radius, 0, Math.PI * 2);
        ctx.stroke();
      } else if (special.kind === "gravityCone") {
        const half = (special.arcDeg * Math.PI) / 360;
        ctx.globalAlpha = 0.18 + progress * 0.2;
        ctx.fillStyle = PALETTE.void;
        ctx.beginPath();
        ctx.moveTo(fighter.x, fighter.y);
        ctx.arc(fighter.x, fighter.y, special.range * progress, angle - half, angle + half);
        ctx.closePath();
        ctx.fill();
      } else if (special.kind === "chargedProjectile") {
        // Laser sight: thin, flickering, intensifying as the lance charges.
        const length = Math.min(special.range, 900);
        const sx = fighter.x + Math.cos(angle) * (fighter.radius + 8);
        const sy = fighter.y + Math.sin(angle) * (fighter.radius + 8);
        const gradient = ctx.createLinearGradient(sx, sy, sx + Math.cos(angle) * length, sy + Math.sin(angle) * length);
        gradient.addColorStop(0, withAlpha("#ffffff", 0.75));
        gradient.addColorStop(0.15, withAlpha(color, 0.55));
        gradient.addColorStop(1, withAlpha(color, 0));
        ctx.globalAlpha = (0.35 + progress * 0.6) * (0.75 + Math.sin(now / 18) * 0.25);
        ctx.strokeStyle = gradient;
        ctx.lineWidth = 1 + progress * 1.6;
        ctx.beginPath();
        ctx.moveTo(sx, sy);
        ctx.lineTo(sx + Math.cos(angle) * length, sy + Math.sin(angle) * length);
        ctx.stroke();
      } else if (special.kind === "dash") {
        // Ground chevrons preview the committed dash direction.
        ctx.fillStyle = color;
        for (let i = 0; i < 3; i += 1) {
          const d = 34 + i * 26;
          const k = clamp(progress * 3 - i, 0, 1);
          ctx.globalAlpha = 0.18 + k * 0.4;
          const cx = fighter.x + Math.cos(angle) * d;
          const cy = fighter.y + Math.sin(angle) * d;
          ctx.save();
          ctx.translate(cx, cy);
          ctx.rotate(angle);
          ctx.beginPath();
          ctx.moveTo(8, 0);
          ctx.lineTo(-6, -9);
          ctx.lineTo(-2, 0);
          ctx.lineTo(-6, 9);
          ctx.closePath();
          ctx.fill();
          ctx.restore();
        }
      }
    }
    ctx.restore();
  }

  drawBarrier(ctx, barrier, now) {
    const solar = barrier.ownerSlot === 0 ? true : false;
    const color = solar ? PALETTE.solar : PALETTE.void;
    const remaining = barrier.until - now;
    const flicker = remaining < 600 ? 0.55 + 0.45 * Math.abs(Math.sin(now / 45)) : 1;
    ctx.save();
    ctx.globalAlpha = flicker;
    const gradient = ctx.createLinearGradient(barrier.x, barrier.y, barrier.x + barrier.width, barrier.y + barrier.height);
    gradient.addColorStop(0, withAlpha(color, 0.18));
    gradient.addColorStop(0.5, withAlpha(color, 0.36));
    gradient.addColorStop(1, withAlpha(color, 0.18));
    ctx.fillStyle = gradient;
    roundRectPath(ctx, barrier.x, barrier.y, barrier.width, barrier.height, 6);
    ctx.fill();
    ctx.save();
    roundRectPath(ctx, barrier.x, barrier.y, barrier.width, barrier.height, 6);
    ctx.clip();
    ctx.strokeStyle = withAlpha("#ffffff", 0.22);
    ctx.lineWidth = 1;
    const step = 10;
    const vertical = barrier.height > barrier.width;
    const offset = (now / 40) % step;
    if (vertical) {
      for (let y = barrier.y - step + offset; y < barrier.y + barrier.height; y += step) {
        ctx.beginPath();
        ctx.moveTo(barrier.x, y);
        ctx.lineTo(barrier.x + barrier.width, y + 6);
        ctx.stroke();
      }
    } else {
      for (let x = barrier.x - step + offset; x < barrier.x + barrier.width; x += step) {
        ctx.beginPath();
        ctx.moveTo(x, barrier.y);
        ctx.lineTo(x + 6, barrier.y + barrier.height);
        ctx.stroke();
      }
    }
    ctx.restore();
    ctx.shadowColor = color;
    ctx.shadowBlur = 14;
    ctx.strokeStyle = withAlpha(color, 0.95);
    ctx.lineWidth = 2;
    roundRectPath(ctx, barrier.x, barrier.y, barrier.width, barrier.height, 6);
    ctx.stroke();
    ctx.restore();
  }

  drawFighter(ctx, combat, fighter, now, game, viewport) {
    const def = UNIT_DEFS[fighter.unit.type];
    const visual = this.fighterVisuals[fighter.slot];
    const color = factionColor(def.faction);
    const size = spriteSizeFor(def);
    const hover = HOVERING.has(fighter.unit.type);
    const idleSprite = this.assets?.getUnitImage(fighter.unit.type);
    const pose = fighter.hp > 0 && now - visual.poseAt < ATTACK_POSE_MS ? this.assets?.getUnitPoseImage?.(fighter.unit.type, "attack") : null;
    const sprite = pose || idleSprite;
    // A pose whose strike points the other way from the idle art is mirrored.
    const art = ART_FACING[fighter.unit.type] || 1;
    const poseFlip = pose && (this.assets?.getAsset?.(`unit.${fighter.unit.type}.attack`)?.facing ?? art) !== art ? -1 : 1;
    // Feet rest on the ground ring; anchor.y is the art's feet baseline.
    const anchorY = this.assets?.getAsset?.(`unit.${fighter.unit.type}`)?.anchor?.y ?? 0.9;
    const top = fighter.radius * 0.7 - anchorY * size;
    const speed = Math.hypot(visual.vx, visual.vy);
    const moving = speed > 30 && fighter.hp > 0;
    const t = now / 1000;

    let alpha = 1;
    let scale = 1;
    let lift = 0;
    if (visual.koAt !== null) {
      const k = clamp((now - visual.koAt) / 520, 0, 1);
      alpha = 1 - k;
      scale = 1 + k * 0.25;
      lift = k * 10;
      if (alpha <= 0) return;
    }
    // Countdown beam-in.
    if (combat.state === "combatCountdown" || combat.state === "combatIntro") {
      const elapsed = (3 - combat.countdown) * 1000 - fighter.slot * 120;
      const k = clamp(elapsed / 650, 0, 1);
      if (k < 1) this.drawBeamIn(ctx, fighter, color, k, size);
      alpha *= easeOutCubic(k);
      scale *= 0.7 + easeOutBack(k) * 0.3;
    }
    if (fighter.invisUntil > now) alpha *= 0.4 + Math.sin(now / 30) * 0.12;

    const bob = hover ? Math.sin(t * 2.6 + fighter.slot * 2) * 4 : moving ? -Math.abs(Math.sin(t * 13)) * 3 : Math.sin(t * 2.1 + fighter.slot) * 1.2;
    const tilt = clamp(visual.vx / Math.max(1, fighter.speed), -1, 1) * 0.07;
    let squashX = 1;
    let squashY = 1;
    if (fighter.state === "attackStartup" || fighter.state === "specialStartup") {
      squashX = 1.05;
      squashY = 0.95;
    } else if (fighter.state === "attackActive" || fighter.state === "specialActive" || fighter.dash) {
      squashX = 0.96;
      squashY = 1.05;
    }

    for (const image of visual.afterimages) {
      const k = 1 - (now - image.t) / 220;
      const ghost = idleSprite ? tintedSprite(scaledSprite(idleSprite, size * viewport.pixelScale), color) : null;
      if (!ghost) continue;
      ctx.save();
      ctx.globalAlpha = k * 0.35 * alpha;
      ctx.globalCompositeOperation = "lighter";
      ctx.translate(image.x, image.y + bob);
      ctx.scale(image.flip, 1);
      ctx.drawImage(ghost, -size / 2, top, size, size);
      ctx.restore();
    }

    ctx.save();
    ctx.translate(fighter.x, fighter.y + bob - lift);
    ctx.rotate(tilt);
    ctx.scale(visual.flip * poseFlip * squashX * scale, squashY * scale);
    ctx.globalAlpha = alpha;

    if (sprite) {
      const image = scaledSprite(sprite, size * viewport.pixelScale);
      if (fighter.invisUntil > now) {
        // Glitch slices while phased.
        const slices = 4;
        for (let i = 0; i < slices; i += 1) {
          const sy = (image.height / slices) * i;
          const sh = image.height / slices;
          const offset = Math.sin(now / 23 + i * 1.7) * 6;
          ctx.drawImage(image, 0, sy, image.width, sh, -size / 2 + offset, top + (size / slices) * i, size, size / slices);
        }
      } else {
        ctx.drawImage(image, -size / 2, top, size, size);
      }
      const hurt = fighter.hurtUntil > now ? clamp((fighter.hurtUntil - now) / 110, 0, 1) : 0;
      const healGlow = clamp(1 - (now - visual.healAt) / 400, 0, 1);
      const koFlash = visual.koAt !== null ? clamp(1 - (now - visual.koAt) / 160, 0, 1) : 0;
      const flash = Math.max(hurt * 0.85, koFlash);
      if (flash > 0) {
        const white = tintedSprite(image, "#ffffff");
        if (white) {
          ctx.globalAlpha = alpha * flash;
          ctx.drawImage(white, -size / 2, top, size, size);
        }
      } else if (healGlow > 0) {
        const green = tintedSprite(image, PALETTE.heal);
        if (green) {
          ctx.globalAlpha = alpha * healGlow * 0.5;
          ctx.globalCompositeOperation = "lighter";
          ctx.drawImage(green, -size / 2, top, size, size);
        }
      }
    } else {
      this.drawFallbackBody(ctx, fighter, def, color);
      if (fighter.hurtUntil > now) {
        ctx.fillStyle = "rgba(255,255,255,0.6)";
        ctx.beginPath();
        ctx.arc(0, 0, fighter.radius + 4, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.restore();

    if (fighter.hp <= 0 && visual.koAt !== null) return;
    this.drawChargeGlow(ctx, fighter, def, color, now);
    if (fighter.shieldUntil > now) this.drawShield(ctx, fighter, now);
    this.drawRoleTag(ctx, combat, fighter, def, color, now, size);
    if (game?.debug?.showRanges) {
      ctx.save();
      ctx.strokeStyle = "#ffffff33";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(fighter.x, fighter.y, clamp(def.attack.range, 20, 520), 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
  }

  drawBeamIn(ctx, fighter, color, k, size) {
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    const width = size * (0.55 - k * 0.35);
    const gradient = ctx.createLinearGradient(fighter.x - width / 2, 0, fighter.x + width / 2, 0);
    gradient.addColorStop(0, withAlpha(color, 0));
    gradient.addColorStop(0.5, withAlpha(color, 0.55 * (1 - k)));
    gradient.addColorStop(1, withAlpha(color, 0));
    ctx.fillStyle = gradient;
    ctx.fillRect(fighter.x - width / 2, fighter.y - 420, width, 420 + fighter.radius);
    ctx.restore();
  }

  drawFallbackBody(ctx, fighter, def, color) {
    ctx.shadowColor = color;
    ctx.shadowBlur = 18;
    ctx.fillStyle = def.faction === "S" ? "#11313e" : "#2b1038";
    ctx.strokeStyle = color;
    ctx.lineWidth = 3;
    if (fighter.unit.type === "SD" || fighter.unit.type === "GB" || fighter.unit.type === "NW") {
      roundRectPath(ctx, -28, -20, 56, 40, 10);
      ctx.fill();
      ctx.stroke();
    } else if (def.attack.kind === "melee") {
      ctx.beginPath();
      for (let i = 0; i < 5; i += 1) {
        const a = Math.PI / 2 + (i * 2 * Math.PI) / 5;
        ctx.lineTo(Math.cos(a) * 26, Math.sin(a) * 26);
      }
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    } else {
      ctx.beginPath();
      ctx.arc(0, 0, 25, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
    ctx.shadowBlur = 0;
    ctx.fillStyle = "#fff";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = "bold 15px Arial";
    ctx.fillText(def.visual.abbr, 0, 0);
  }

  // Basic shots and specials gather energy at the muzzle instead of drawing
  // an aim line; the ground notch already shows the committed direction.
  drawChargeGlow(ctx, fighter, def, color, now) {
    const action = fighter.pendingAction;
    if (!action || action.executed) return;
    const timing = action.kind === "attack" ? def.attack.timing : def.special.timing;
    const progress = clamp((now - (action.activeAt - timing.startupMs)) / Math.max(1, timing.startupMs), 0, 1);
    const angle = Math.atan2(action.facingY, action.facingX);
    const ranged = action.kind === "attack" ? def.attack.kind === "projectile" : ["chargedProjectile", "heavyProjectile", "spread", "repairBurst"].includes(def.special.kind);
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    if (ranged) {
      const mx = fighter.x + Math.cos(angle) * (fighter.radius + 6);
      const my = fighter.y + Math.sin(angle) * (fighter.radius + 6) - 4;
      const big = action.kind === "special";
      const radius = (big ? 8 : 4) + progress * (big ? 14 : 7);
      const sprite = glowSprite(color);
      if (sprite) {
        ctx.globalAlpha = 0.5 + progress * 0.5;
        ctx.drawImage(sprite, mx - radius * 2, my - radius * 2, radius * 4, radius * 4);
      }
      ctx.fillStyle = "#ffffff";
      ctx.globalAlpha = 0.6 + progress * 0.4;
      ctx.beginPath();
      ctx.arc(mx, my, Math.max(1.5, radius * 0.32), 0, Math.PI * 2);
      ctx.fill();
    } else {
      const sprite = glowSprite(color);
      const radius = fighter.radius * (1.6 + progress * 0.5);
      if (sprite) {
        ctx.globalAlpha = 0.18 + progress * 0.3;
        ctx.drawImage(sprite, fighter.x - radius, fighter.y - radius - 10, radius * 2, radius * 2);
      }
    }
    ctx.restore();
  }

  drawShield(ctx, fighter, now) {
    const remaining = fighter.shieldUntil - now;
    const flicker = remaining < 500 ? 0.5 + 0.5 * Math.abs(Math.sin(now / 50)) : 1;
    const radius = fighter.radius * 1.75;
    const cx = fighter.x;
    const cy = fighter.y - 8;
    ctx.save();
    ctx.globalAlpha = flicker;
    const gradient = ctx.createRadialGradient(cx, cy, radius * 0.4, cx, cy, radius);
    gradient.addColorStop(0, "rgba(233,255,255,0.02)");
    gradient.addColorStop(0.8, "rgba(109,252,255,0.14)");
    gradient.addColorStop(1, "rgba(233,255,255,0.4)");
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = withAlpha(PALETTE.solarHot, 0.85);
    ctx.lineWidth = 2;
    for (let i = 0; i < 6; i += 1) {
      const a = now / 600 + (i * Math.PI) / 3;
      ctx.beginPath();
      ctx.arc(cx, cy, radius, a, a + 0.62);
      ctx.stroke();
    }
    ctx.restore();
  }

  drawRoleTag(ctx, combat, fighter, def, color, now, size) {
    if (fighter.controller !== "p1" && fighter.controller !== "p2") return;
    let alpha = 1;
    if (combat.state === "combatActive" || combat.state === "combatResolving") {
      const since = this.fightAt === null ? TAG_VISIBLE_AFTER_FIGHT_MS : now - this.fightAt;
      alpha = clamp(1 - (since - TAG_VISIBLE_AFTER_FIGHT_MS + 500) / 500, 0, 1);
    }
    if (alpha <= 0) return;
    const pvp = combat.fighters.some((candidate) => candidate.controller === "p2");
    const text = fighter.controller === "p1" ? (pvp ? "P1" : "YOU") : "P2";
    const anchorY = this.assets?.getAsset?.(`unit.${fighter.unit.type}`)?.anchor?.y ?? 0.9;
    const y = fighter.y + fighter.radius * 0.7 - anchorY * size - 4 + Math.sin(now / 200) * 2;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.font = "800 12px \"Trebuchet MS\", Arial, sans-serif";
    const width = ctx.measureText(text).width + 16;
    ctx.fillStyle = def.faction === "S" ? "rgba(6,34,43,0.92)" : "rgba(36,13,53,0.92)";
    roundRectPath(ctx, fighter.x - width / 2, y - 10, width, 18, 9);
    ctx.fill();
    ctx.strokeStyle = withAlpha(color, 0.9);
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(fighter.x - 5, y + 8);
    ctx.lineTo(fighter.x + 5, y + 8);
    ctx.lineTo(fighter.x, y + 14);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = "#f4feff";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(text, fighter.x, y);
    ctx.restore();
  }

  drawSlashes(ctx, now) {
    if (!this.slashes) return;
    for (const slash of this.slashes) {
      const k = (now - slash.t) / slash.life;
      if (k < 0 || k > 1) continue;
      const sweep = easeOutCubic(Math.min(1, k * 1.6));
      const half = slash.arc / 2;
      const start = slash.angle - half;
      const end = start + slash.arc * sweep;
      const radius = slash.range * 0.82;
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      ctx.globalAlpha = 1 - k;
      ctx.lineCap = "round";
      ctx.strokeStyle = withAlpha(slash.color, 0.55);
      ctx.lineWidth = slash.heavy ? 22 : 14;
      ctx.beginPath();
      ctx.arc(slash.x, slash.y, radius, start, end);
      ctx.stroke();
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = slash.heavy ? 6 : 3.5;
      ctx.beginPath();
      ctx.arc(slash.x, slash.y, radius, Math.max(start, end - 0.7), end);
      ctx.stroke();
      ctx.restore();
    }
  }

  drawProjectile(ctx, projectile, now) {
    const speed = Math.hypot(projectile.vx, projectile.vy) || 1;
    const nx = projectile.vx / speed;
    const ny = projectile.vy / speed;
    const solar = projectile.faction === "S";
    const color = solar ? PALETTE.solar : PALETTE.void;
    const r = projectile.radius;
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    const trail = projectile.kind === "lance" ? 74 : projectile.kind === "shell" ? 26 : Math.min(42, speed * 0.075);
    const tailX = projectile.x - nx * trail;
    const tailY = projectile.y - ny * trail;
    const gradient = ctx.createLinearGradient(tailX, tailY, projectile.x, projectile.y);
    gradient.addColorStop(0, withAlpha(color, 0));
    gradient.addColorStop(1, withAlpha(color, 0.85));
    ctx.strokeStyle = gradient;
    ctx.lineCap = "round";
    ctx.lineWidth = projectile.kind === "lance" ? r * 1.4 : r * 1.5;
    ctx.beginPath();
    ctx.moveTo(tailX, tailY);
    ctx.lineTo(projectile.x, projectile.y);
    ctx.stroke();
    const glow = glowSprite(projectile.kind === "spread" ? "#9dff7a" : color);
    const glowSize = r * (projectile.kind === "shell" ? 5.2 : 4.4);
    if (glow) ctx.drawImage(glow, projectile.x - glowSize / 2, projectile.y - glowSize / 2, glowSize, glowSize);
    ctx.globalCompositeOperation = "source-over";
    if (solar) {
      ctx.fillStyle = projectile.kind === "pulse" ? "#d8fff0" : "#ffffff";
      ctx.beginPath();
      ctx.arc(projectile.x, projectile.y, r * 0.75, 0, Math.PI * 2);
      ctx.fill();
    } else {
      // Void ordnance has a dark core and a bright rim: distinct beyond color.
      const pulse = projectile.kind === "shell" ? 1 + Math.sin(now / 60) * 0.08 : 1;
      ctx.fillStyle = "#1a0526";
      ctx.beginPath();
      ctx.arc(projectile.x, projectile.y, r * 0.8 * pulse, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = projectile.kind === "spread" ? "#b8ff8a" : PALETTE.voidHot;
      ctx.lineWidth = Math.max(1.5, r * 0.3);
      ctx.stroke();
      if (projectile.kind === "shell") {
        ctx.strokeStyle = withAlpha(PALETTE.void, 0.9);
        ctx.lineWidth = 1.5;
        for (let i = 0; i < 3; i += 1) {
          const a = now / 90 + (i * Math.PI * 2) / 3;
          ctx.beginPath();
          ctx.arc(projectile.x, projectile.y, r * 1.25, a, a + 0.9);
          ctx.stroke();
        }
      }
    }
    ctx.restore();
  }

  drawOverlays(ctx, combat, game, now, bounds) {
    if (this.flash) {
      const k = 1 - (now - this.flash.t) / this.flash.life;
      if (k > 0) {
        ctx.save();
        ctx.globalAlpha = this.flash.alpha * k;
        ctx.fillStyle = this.flash.color;
        ctx.fillRect(bounds.x, bounds.y, bounds.width, bounds.height);
        ctx.restore();
      } else {
        this.flash = null;
      }
    }

    if (combat.overtimeStage > 0 && combat.state === "combatActive") {
      const pulse = 0.5 + 0.5 * Math.sin(now / (combat.overtimeStage === 2 ? 110 : 220));
      ctx.save();
      const gradient = ctx.createRadialGradient(480, 260, 260, 480, 260, 620);
      gradient.addColorStop(0, "rgba(255,95,122,0)");
      gradient.addColorStop(1, `rgba(255,95,122,${(0.1 + 0.12 * pulse) * combat.overtimeStage})`);
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, ARENA_WIDTH, ARENA_HEIGHT);
      ctx.restore();
    }

    if (combat.state === "combatCountdown" || combat.state === "combatIntro") this.drawVersus(ctx, combat);

    if (this.fightAt !== null) {
      const k = (now - this.fightAt) / 750;
      if (k >= 0 && k < 1) {
        ctx.save();
        ctx.globalAlpha = 1 - Math.pow(k, 3);
        const scale = 0.8 + easeOutBack(Math.min(1, k * 3)) * 0.35;
        ctx.translate(480, 250);
        ctx.scale(scale, scale);
        drawBigText(ctx, "FIGHT!", 0, 0, 92, "#ffffff", PALETTE.gold);
        ctx.restore();
      }
    }

    if (this.banner) {
      const k = (now - this.banner.t) / this.banner.life;
      if (k >= 0 && k < 1) {
        const enter = easeOutCubic(Math.min(1, k * 5));
        const exit = k > 0.85 ? 1 - (k - 0.85) / 0.15 : 1;
        ctx.save();
        ctx.globalAlpha = exit;
        const bandHeight = 92 * enter;
        const gradient = ctx.createLinearGradient(0, 0, ARENA_WIDTH, 0);
        gradient.addColorStop(0, "rgba(2,6,14,0)");
        gradient.addColorStop(0.2, "rgba(2,6,14,0.82)");
        gradient.addColorStop(0.8, "rgba(2,6,14,0.82)");
        gradient.addColorStop(1, "rgba(2,6,14,0)");
        ctx.fillStyle = gradient;
        ctx.fillRect(0, 250 - bandHeight / 2, ARENA_WIDTH, bandHeight);
        ctx.fillStyle = withAlpha(this.banner.color, 0.9);
        ctx.fillRect(ARENA_WIDTH * 0.2, 250 - bandHeight / 2, ARENA_WIDTH * 0.6 * enter, 2);
        ctx.fillRect(ARENA_WIDTH * 0.8 - ARENA_WIDTH * 0.6 * enter, 250 + bandHeight / 2 - 2, ARENA_WIDTH * 0.6 * enter, 2);
        drawBigText(ctx, this.banner.text, 480 + (1 - enter) * -60, 238, 44, "#ffffff", this.banner.color);
        ctx.font = "700 16px \"Trebuchet MS\", Arial, sans-serif";
        ctx.textAlign = "center";
        ctx.fillStyle = withAlpha("#e9fbff", 0.85);
        ctx.fillText(this.banner.sub, 480, 278);
        ctx.restore();
      } else if (k >= 1) {
        this.banner = null;
      }
    }

    if (combat.paused) {
      ctx.save();
      ctx.fillStyle = "rgba(2,6,14,0.5)";
      ctx.fillRect(bounds.x, bounds.y, bounds.width, bounds.height);
      drawBigText(ctx, "PAUSED", 480, 150, 50, "#ffffff", PALETTE.solar);
      ctx.restore();
    }
  }

  drawVersus(ctx, combat) {
    const elapsed = 3 - combat.countdown;
    const enter = easeOutCubic(clamp(elapsed / 0.45, 0, 1));
    const exit = clamp((elapsed - 1.9) / 0.4, 0, 1);
    if (exit >= 1) return;
    const [left, right] = [...combat.fighters].sort((a, b) => a.x - b.x);
    ctx.save();
    ctx.globalAlpha = 1 - exit;
    const plates = [
      { fighter: left, x: 40 - (1 - enter) * 400, align: "left" },
      { fighter: right, x: ARENA_WIDTH - 40 + (1 - enter) * 400, align: "right" },
    ];
    for (const plate of plates) {
      const def = UNIT_DEFS[plate.fighter.unit.type];
      const color = factionColor(def.faction);
      const width = 330;
      const x = plate.align === "left" ? plate.x : plate.x - width;
      const y = 26;
      const gradient = ctx.createLinearGradient(x, 0, x + width, 0);
      const strong = def.faction === "S" ? "rgba(6,40,52,0.92)" : "rgba(40,12,58,0.92)";
      gradient.addColorStop(plate.align === "left" ? 0 : 1, strong);
      gradient.addColorStop(plate.align === "left" ? 1 : 0, "rgba(2,6,14,0.15)");
      ctx.fillStyle = gradient;
      ctx.beginPath();
      if (plate.align === "left") {
        ctx.moveTo(x, y);
        ctx.lineTo(x + width, y);
        ctx.lineTo(x + width - 26, y + 66);
        ctx.lineTo(x, y + 66);
      } else {
        ctx.moveTo(x + width, y);
        ctx.lineTo(x, y);
        ctx.lineTo(x + 26, y + 66);
        ctx.lineTo(x + width, y + 66);
      }
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = color;
      ctx.fillRect(plate.align === "left" ? x : x + width - 5, y, 5, 66);
      ctx.textAlign = plate.align;
      ctx.textBaseline = "alphabetic";
      const tx = plate.align === "left" ? x + 18 : x + width - 18;
      ctx.font = "700 12px \"Trebuchet MS\", Arial, sans-serif";
      ctx.fillStyle = withAlpha(color, 0.95);
      const role = plate.fighter.controller === "ai" ? "AI" : plate.fighter.controller === "p1" ? (combat.fighters.some((f) => f.controller === "p2") ? "P1" : "YOU") : "P2";
      const attacking = plate.fighter.slot === 0 ? "ATTACKER" : "DEFENDER";
      ctx.fillText(`${FACTION_NAMES[def.faction].toUpperCase()} · ${role} · ${attacking}`, tx, y + 22);
      ctx.font = "900 26px \"Trebuchet MS\", Arial, sans-serif";
      ctx.fillStyle = "#ffffff";
      ctx.fillText(def.name.toUpperCase(), tx, y + 52);
    }
    const vsScale = 0.6 + easeOutBack(clamp((elapsed - 0.2) / 0.4, 0, 1)) * 0.4;
    ctx.translate(480, 58);
    ctx.scale(vsScale, vsScale);
    drawBigText(ctx, "VS", 0, 0, 46, "#ffffff", PALETTE.gold);
    ctx.restore();
  }
}

function drawCoverShadow(ctx, obstacle) {
  ctx.save();
  ctx.fillStyle = "rgba(0,0,0,0.38)";
  roundRectPath(ctx, obstacle.x + 6, obstacle.y + 9, obstacle.width, obstacle.height, 6);
  ctx.fill();
  ctx.restore();
}

export function drawBigText(ctx, text, x, y, size, fill, glow) {
  ctx.save();
  ctx.font = `900 ${size}px "Trebuchet MS", "Arial Black", Arial, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.lineJoin = "round";
  ctx.shadowColor = glow;
  ctx.shadowBlur = size * 0.4;
  ctx.lineWidth = Math.max(3, size * 0.09);
  ctx.strokeStyle = "rgba(2,6,14,0.9)";
  ctx.strokeText(text, x, y);
  ctx.fillStyle = fill;
  ctx.fillText(text, x, y);
  ctx.shadowBlur = 0;
  ctx.restore();
}
