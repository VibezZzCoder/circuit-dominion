// SPDX-License-Identifier: GPL-3.0-or-later
// Additional terms under GPL-3.0 section 7 apply; see NOTICE.md.
// Visual-only effects shared by the board and arena renderers. Nothing here
// reads or writes gameplay rules; callers advance it with a presentation or
// simulation clock so pausing the duel also freezes its effects.

export const PALETTE = {
  solar: "#6dfcff",
  solarHot: "#e9ffff",
  solarGold: "#ffd36b",
  void: "#d56bff",
  voidHot: "#ffd2ff",
  voidDeep: "#7a2cff",
  gold: "#ffdc63",
  danger: "#ff5f7a",
  heal: "#7dff96",
};

export function factionColor(faction, hot = false) {
  if (faction === "S") return hot ? PALETTE.solarHot : PALETTE.solar;
  return hot ? PALETTE.voidHot : PALETTE.void;
}

export function easeInOutCubic(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

export function easeOutCubic(t) {
  return 1 - Math.pow(1 - t, 3);
}

export function easeOutBack(t) {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
}

export function prefersReducedMotion() {
  try {
    return Boolean(globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches);
  } catch {
    return false;
  }
}

function makeCanvas(width, height) {
  if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(width, height);
  if (typeof document !== "undefined" && typeof document.createElement === "function") {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    return canvas;
  }
  return null;
}

const glowCache = new Map();

// Soft radial sprite reused for every glow particle of a color. Drawing a
// cached bitmap is far cheaper on phones than per-particle gradients/shadows.
export function glowSprite(color) {
  if (glowCache.has(color)) return glowCache.get(color);
  const size = 64;
  const canvas = makeCanvas(size, size);
  const ctx = canvas?.getContext?.("2d");
  if (!ctx || typeof ctx.createRadialGradient !== "function") {
    glowCache.set(color, null);
    return null;
  }
  const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  gradient.addColorStop(0, color);
  gradient.addColorStop(0.35, withAlpha(color, 0.55));
  gradient.addColorStop(1, withAlpha(color, 0));
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);
  glowCache.set(color, canvas);
  return canvas;
}

export function withAlpha(hex, alpha) {
  const value = hex.replace("#", "").slice(0, 6);
  const r = parseInt(value.slice(0, 2), 16);
  const g = parseInt(value.slice(2, 4), 16);
  const b = parseInt(value.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${Math.max(0, Math.min(1, alpha)).toFixed(3)})`;
}

const spriteCache = new WeakMap();

// High-quality downscaled copy of a large sprite. Generated art is 512px while
// pieces draw at 40-110px; one stepped downscale avoids per-frame shimmer.
export function scaledSprite(image, targetPx) {
  if (!image || !image.width) return image;
  const bucket = Math.max(16, Math.min(512, Math.ceil(targetPx / 16) * 16));
  if (bucket >= image.width) return image;
  let entry = spriteCache.get(image);
  if (!entry) {
    entry = new Map();
    spriteCache.set(image, entry);
  }
  if (entry.has(bucket)) return entry.get(bucket);
  let source = image;
  let size = image.width;
  while (size / 2 >= bucket) {
    const next = makeCanvas(Math.round(size / 2), Math.round(size / 2));
    const ctx = next?.getContext?.("2d");
    if (!ctx) return image;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(source, 0, 0, next.width, next.height);
    source = next;
    size = next.width;
  }
  const final = makeCanvas(bucket, bucket);
  const finalCtx = final?.getContext?.("2d");
  if (!finalCtx) return image;
  finalCtx.imageSmoothingEnabled = true;
  finalCtx.imageSmoothingQuality = "high";
  finalCtx.drawImage(source, 0, 0, bucket, bucket);
  entry.set(bucket, final);
  return final;
}

const tintCache = new WeakMap();

// Solid-color silhouette of a sprite for hit flashes and materialize effects.
export function tintedSprite(image, color) {
  if (!image || !image.width) return null;
  let entry = tintCache.get(image);
  if (!entry) {
    entry = new Map();
    tintCache.set(image, entry);
  }
  if (entry.has(color)) return entry.get(color);
  const canvas = makeCanvas(image.width, image.height);
  const ctx = canvas?.getContext?.("2d");
  if (!ctx) return null;
  ctx.drawImage(image, 0, 0);
  ctx.globalCompositeOperation = "source-in";
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, image.width, image.height);
  entry.set(color, canvas);
  return canvas;
}

export class ParticleSystem {
  constructor(max = 520) {
    this.items = [];
    this.max = max;
  }

  clear() {
    this.items.length = 0;
  }

  add(particle) {
    if (this.items.length >= this.max) this.items.shift();
    this.items.push({
      age: 0,
      life: 0.5,
      vx: 0,
      vy: 0,
      drag: 3,
      gravity: 0,
      size: 4,
      grow: 0,
      alpha: 1,
      rotation: 0,
      spin: 0,
      ...particle,
    });
  }

  burst(x, y, options = {}) {
    const count = options.count ?? 12;
    const speed = options.speed ?? 220;
    const spread = options.spread ?? Math.PI * 2;
    const angle = options.angle ?? 0;
    for (let index = 0; index < count; index += 1) {
      const a = angle + (Math.random() - 0.5) * spread;
      const s = speed * (0.35 + Math.random() * 0.75);
      this.add({
        type: options.type || "spark",
        x: x + (Math.random() - 0.5) * (options.jitter ?? 4),
        y: y + (Math.random() - 0.5) * (options.jitter ?? 4),
        vx: Math.cos(a) * s,
        vy: Math.sin(a) * s,
        life: (options.life ?? 0.42) * (0.6 + Math.random() * 0.6),
        size: (options.size ?? 3) * (0.6 + Math.random() * 0.8),
        color: options.color || "#ffffff",
        drag: options.drag ?? 4,
        gravity: options.gravity ?? 0,
        grow: options.grow ?? 0,
        spin: (Math.random() - 0.5) * (options.spin ?? 0),
        alpha: options.alpha ?? 1,
        layer: options.layer || "top",
      });
    }
  }

  update(dt) {
    if (dt <= 0) return;
    const items = this.items;
    let write = 0;
    for (let read = 0; read < items.length; read += 1) {
      const p = items[read];
      p.age += dt;
      if (p.age >= p.life) continue;
      const damping = Math.exp(-p.drag * dt);
      p.vx *= damping;
      p.vy = p.vy * damping + p.gravity * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.size = Math.max(0, p.size + p.grow * dt);
      p.rotation += p.spin * dt;
      items[write] = p;
      write += 1;
    }
    items.length = write;
  }

  draw(ctx, layer = "top") {
    for (const p of this.items) {
      if ((p.layer || "top") !== layer) continue;
      const t = p.age / p.life;
      const fade = p.fadeIn ? Math.min(1, t / p.fadeIn) * (1 - t) : 1 - t;
      const alpha = Math.max(0, fade * p.alpha);
      if (alpha <= 0.005) continue;
      ctx.globalAlpha = alpha;
      if (p.type === "spark") {
        const speed = Math.hypot(p.vx, p.vy);
        const length = Math.min(26, 2 + speed * 0.035);
        const nx = speed ? p.vx / speed : 1;
        const ny = speed ? p.vy / speed : 0;
        ctx.globalCompositeOperation = "lighter";
        ctx.strokeStyle = p.color;
        ctx.lineWidth = Math.max(0.6, p.size * 0.55);
        ctx.lineCap = "round";
        ctx.beginPath();
        ctx.moveTo(p.x - nx * length, p.y - ny * length);
        ctx.lineTo(p.x, p.y);
        ctx.stroke();
      } else if (p.type === "glow") {
        const sprite = glowSprite(p.color);
        const size = p.size * 2;
        ctx.globalCompositeOperation = "lighter";
        if (sprite) ctx.drawImage(sprite, p.x - size / 2, p.y - size / 2, size, size);
      } else if (p.type === "smoke") {
        ctx.globalCompositeOperation = "source-over";
        const sprite = glowSprite(p.color);
        const size = p.size * 2;
        if (sprite) ctx.drawImage(sprite, p.x - size / 2, p.y - size / 2, size, size);
      } else if (p.type === "ring") {
        ctx.globalCompositeOperation = "lighter";
        ctx.strokeStyle = p.color;
        ctx.lineWidth = Math.max(0.5, (p.width ?? 3) * (1 - t));
        ctx.beginPath();
        ctx.arc(p.x, p.y, Math.max(0, p.size), 0, Math.PI * 2);
        ctx.stroke();
      } else if (p.type === "shard") {
        ctx.globalCompositeOperation = "source-over";
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rotation);
        ctx.fillStyle = p.color;
        ctx.beginPath();
        ctx.moveTo(-p.size, -p.size * 0.4);
        ctx.lineTo(p.size, 0);
        ctx.lineTo(-p.size * 0.6, p.size * 0.5);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
      } else if (p.type === "text") {
        ctx.globalCompositeOperation = "source-over";
        const pop = t < 0.15 ? 0.7 + (t / 0.15) * 0.45 : 1.15 - Math.min(0.15, (t - 0.15) * 0.3);
        ctx.font = `900 ${Math.round(p.size * pop)}px "Trebuchet MS", Arial, sans-serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.lineWidth = 3;
        ctx.strokeStyle = "rgba(2,6,14,0.85)";
        ctx.strokeText(p.text, p.x, p.y);
        ctx.fillStyle = p.color;
        ctx.fillText(p.text, p.x, p.y);
      }
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
  }
}

export class ScreenShake {
  constructor() {
    this.trauma = 0;
    this.time = 0;
    this.enabled = !prefersReducedMotion();
  }

  add(amount) {
    if (!this.enabled) return;
    this.trauma = Math.min(1, this.trauma + amount);
  }

  update(dt) {
    this.time += dt;
    this.trauma = Math.max(0, this.trauma - dt * 1.8);
  }

  offset(scale = 10) {
    if (!this.trauma) return { x: 0, y: 0 };
    const power = this.trauma * this.trauma * scale;
    return {
      x: Math.sin(this.time * 71.3) * power + Math.sin(this.time * 23.1) * power * 0.4,
      y: Math.cos(this.time * 63.7) * power + Math.sin(this.time * 31.9) * power * 0.4,
    };
  }
}

export function roundRectPath(ctx, x, y, w, h, r) {
  const radius = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

// Procedural polarity glyphs keep Light/Dark readable without relying on color
// or on font glyph availability.
export function drawSunGlyph(ctx, x, y, r) {
  ctx.beginPath();
  ctx.arc(x, y, r * 0.42, 0, Math.PI * 2);
  ctx.fill();
  ctx.lineCap = "round";
  for (let index = 0; index < 8; index += 1) {
    const a = (index * Math.PI) / 4;
    ctx.beginPath();
    ctx.moveTo(x + Math.cos(a) * r * 0.62, y + Math.sin(a) * r * 0.62);
    ctx.lineTo(x + Math.cos(a) * r, y + Math.sin(a) * r);
    ctx.stroke();
  }
}

export function drawVoidGlyph(ctx, x, y, r) {
  ctx.beginPath();
  ctx.moveTo(x, y - r);
  ctx.lineTo(x + r * 0.78, y);
  ctx.lineTo(x, y + r);
  ctx.lineTo(x - r * 0.78, y);
  ctx.closePath();
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(x, y, r * 0.28, 0, Math.PI * 2);
  ctx.fill();
}

export function drawFluxGlyph(ctx, x, y, r) {
  ctx.beginPath();
  ctx.moveTo(x, y - r);
  ctx.lineTo(x + r, y);
  ctx.lineTo(x, y + r);
  ctx.lineTo(x - r, y);
  ctx.closePath();
  ctx.stroke();
}

export function drawLockGlyph(ctx, x, y, r) {
  ctx.lineWidth = Math.max(1, r * 0.22);
  ctx.beginPath();
  ctx.arc(x, y - r * 0.2, r * 0.42, Math.PI, 0);
  ctx.stroke();
  roundRectPath(ctx, x - r * 0.62, y - r * 0.15, r * 1.24, r * 0.95, r * 0.18);
  ctx.fill();
}
