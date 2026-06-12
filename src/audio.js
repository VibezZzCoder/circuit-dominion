// SPDX-License-Identifier: GPL-3.0-or-later
export class AudioManager {
  constructor(getMuted) {
    this.getMuted = getMuted;
    this.ctx = null;
    this.unlocked = false;
  }

  unlock() {
    if (this.unlocked) {
      return;
    }

    this.unlocked = true;
    try {
      this.ctx = this.ctx || new (window.AudioContext || window.webkitAudioContext)();
      if (this.ctx.state === "suspended") {
        this.ctx.resume().catch(() => {});
      }
    } catch (_err) {
      // Audio failure must never affect gameplay.
    }
  }

  beep(kind) {
    if (this.getMuted() || !this.unlocked || !this.ctx) {
      return;
    }

    try {
      const now = this.ctx.currentTime;
      const oscillator = this.ctx.createOscillator();
      const gain = this.ctx.createGain();

      oscillator.type = kind === "bad" ? "sawtooth" : kind === "hit" ? "square" : "sine";
      const baseFreq = {
        move: 440,
        bad: 130,
        attack: 620,
        hit: 210,
        special: 780,
        win: 880,
        countdown: 520,
      }[kind] || 440;

      oscillator.frequency.setValueAtTime(baseFreq, now);
      if (kind === "win") {
        oscillator.frequency.exponentialRampToValueAtTime(baseFreq * 1.5, now + 0.35);
      }

      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(0.08, now + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + (kind === "win" ? 0.45 : 0.12));

      oscillator.connect(gain);
      gain.connect(this.ctx.destination);
      oscillator.start(now);
      oscillator.stop(now + (kind === "win" ? 0.5 : 0.15));
    } catch (_err) {
      // Audio failure must never affect gameplay.
    }
  }
}
