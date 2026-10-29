// SPDX-License-Identifier: GPL-3.0-or-later
// Additional terms under GPL-3.0 section 7 apply; see NOTICE.md.
/**
 * Circuit Dominion audio: an original, fully procedural chiptune engine.
 *
 * Sound model (2A03-inspired, Web Audio only, no samples or files):
 * two pulse voices (12.5 / 25 / 50 % duty PeriodicWaves), a 4-bit stepped
 * triangle bass, LFSR noise (long + short "metallic" mode) for percussion,
 * and a light tempo-synced echo on the music melody voices.
 *
 * Graph:  voices -> per-track gain -> music bus --\
 *         sfx voices -> (panner) -> sfx bus ------+-> master -> compressor -> out
 * The music bus sits about 14 dB under the SFX bus.
 *
 * Public API (class AudioManager):
 *   new AudioManager(getMuted)     getMuted(): boolean, polled every update/beep.
 *   .ctx, .unlocked                AudioContext (null until unlock) and flag.
 *   .unlock()                      Call from trusted gestures. Creates/resumes
 *                                  the context; a no-op while already running.
 *   .update()                      Call once per frame from the main loop.
 *                                  Lookahead scheduler (~0.25 s) on
 *                                  ctx.currentTime; no timers of its own. After
 *                                  a long gap it skips ahead (no backlog burst).
 *   .beep(kind, opts?)             One-shot SFX. opts: {faction:'S'|'V',
 *                                  intensity:0..1, pan:-1..1, pitch:semitones,
 *                                  volume:0..2}. Unknown kinds play a soft blip.
 *   .playMusic(trackId, opts?)     'title' | 'board' | 'duel' | 'victory' |
 *                                  'defeat'. opts: {faction, intensity, fade,
 *                                  restart}. Same track => only opts update
 *                                  (board re-voices per faction, no restart).
 *                                  Track change => crossfade (default 0.6 s,
 *                                  0.25 s into stingers). Safe to call every
 *                                  frame; works before unlock (starts later).
 *   .stopMusic(fadeSec = 0.6)
 *   .setMusicIntensity(0..2)       Duel layering (1 = overtime, 2 = critical).
 *   .setMusicEnabled(bool), .musicEnabled   Music toggle independent of mute.
 *   .setVolumes({music, sfx})      User volumes 0..1.
 *   .setMusicDuck(0..1)            Optional music level scale (pause/help).
 *   .currentTrack, .getDebugState()
 *
 * SFX kinds: see SFX_KINDS below. Legacy kinds move, bad, attack, hit,
 * special, win, countdown keep working ('countdown' is the GO stab).
 *
 * Every entry point swallows errors: audio failure never affects gameplay.
 * Nothing is created before unlock() and nothing is scheduled unless the
 * context state is "running".
 */

const LOOKAHEAD = 0.25;
const START_LATENCY = 0.06;
const BEHIND_TOLERANCE = 0.03;
const MAX_STEPS_PER_UPDATE = 48;
const MASTER_LEVEL = 1.0;
const MUSIC_BASE = 0.25; // -14 dB relative to the SFX bus
const SFX_BASE = 1.25;
const MUSIC_VOICE_CAP = 28;
const SFX_VOICE_CAP = 20;
const CH_LEAD = 0;
const CH_HARM = 1;
const CH_BASS = 2;
const CH_DRUM = 3;
const CHANNELS = ["lead", "harm", "bass", "drum"];
const MAX_INTENSITY = 2;

const clamp = (value, lo, hi) => Math.min(hi, Math.max(lo, value));
const mtof = (midi) => 440 * Math.pow(2, (midi - 69) / 12);
const NOTE_PC = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

function pcOf(name) {
  const match = /^([A-G])([#b]?)$/.exec(name);
  if (!match) return null;
  return (NOTE_PC[match[1]] + (match[2] === "#" ? 1 : match[2] === "b" ? -1 : 0) + 12) % 12;
}

function noteToMidi(token) {
  const match = /^([A-G])([#b]?)(\d)$/.exec(token);
  if (!match) return null;
  return 12 * (Number(match[3]) + 1) + NOTE_PC[match[1]] + (match[2] === "#" ? 1 : match[2] === "b" ? -1 : 0);
}

// ---------------------------------------------------------------------------
// Pattern language (compiled once at module load; pure data, no Web Audio).
//   Melody: "E5:8 A5:4 G5" -> note:length-in-16ths (length persists), "-" rest,
//           "|" is a readable bar separator.
//   Drums:  one char per 16th: k kick, s snare, h hat, o open hat, c crash,
//           g gong swell, t tom, "." rest.
//   Chords: "Am F:8 G:8" (default one bar each) feed generated styles.
// ---------------------------------------------------------------------------

function parseSeq(text, errors, label) {
  const events = [];
  let step = 0;
  let len = 4;
  for (const token of String(text).split(/[\s|]+/)) {
    if (!token) continue;
    const [name, lenText] = token.split(":");
    if (lenText !== undefined) {
      const value = Number(lenText);
      if (!(value > 0) || !Number.isInteger(value)) errors.push(`${label}: bad length in ${token}`);
      else len = value;
    }
    if (name !== "-") {
      const midi = noteToMidi(name);
      if (midi === null) errors.push(`${label}: bad note ${token}`);
      else events.push([step, midi, len]);
    }
    step += len;
  }
  return { events, steps: step };
}

const DRUM_CODES = "kshocgt";
function parseDrums(text, errors, label) {
  const events = [];
  let step = 0;
  for (const char of String(text)) {
    if (char === " " || char === "|" || char === "\n") continue;
    if (char !== "." && !DRUM_CODES.includes(char)) errors.push(`${label}: bad drum ${char}`);
    else if (char !== ".") events.push([step, char, 1]);
    step += 1;
  }
  return { events, steps: step };
}

const CHORD_QUALITY = {
  "": [0, 4, 7],
  m: [0, 3, 7],
  "7": [0, 4, 7, 10],
  m7: [0, 3, 7, 10],
  maj7: [0, 4, 7, 11],
  sus4: [0, 5, 7],
  sus2: [0, 2, 7],
  dim: [0, 3, 6],
};

function parseChords(text, errors, label) {
  const chords = [];
  let step = 0;
  for (const token of String(text).split(/[\s|]+/)) {
    if (!token) continue;
    const [name, lenText] = token.split(":");
    const len = lenText ? Number(lenText) : 16;
    const match = /^([A-G][#b]?)(m7|maj7|m|7|sus4|sus2|dim)?$/.exec(name);
    if (!match || !(len > 0)) {
      errors.push(`${label}: bad chord ${token}`);
      step += len > 0 ? len : 16;
      continue;
    }
    const rootPc = pcOf(match[1]);
    const intervals = CHORD_QUALITY[match[2] || ""];
    chords.push({ step, len, rootPc, intervals, pcs: intervals.map((iv) => (rootPc + iv) % 12) });
    step += len;
  }
  return { chords, steps: step };
}

// Accompaniment styles. idx: chord-tone index (0 root, 1 third, 2 fifth,
// 3 upper root...). semi: semitones above the root (bass styles).
const STYLES = {
  arp16: { idx: [0, 2, 3, 4, 5, 4, 3, 2], len: [1] },
  arpUp16: { idx: [0, 1, 2, 3], len: [1] },
  arp8: { idx: [0, 1, 2, 1], len: [2] },
  alberti: { idx: [0, 2, 1, 2], len: [2] },
  gallop: { idx: [1, 2, 2], len: [2, 1, 1] },
  octave8: { semi: [0, 12], len: [2] },
  octave16: { semi: [0, 12], len: [1] },
  march: { semi: [0, 7], len: [4] },
  pad: { pad: true },
};

function generateFromChords(chords, spec, errors, label) {
  const style = STYLES[spec.style];
  const events = [];
  if (!style) {
    errors.push(`${label}: unknown style ${spec.style}`);
    return events;
  }
  const lo = spec.lo ?? 52;
  for (const chord of chords) {
    const root = lo + ((((chord.rootPc - lo) % 12) + 12) % 12);
    if (style.pad) {
      const center = spec.center ?? 62;
      const tones = [];
      for (let midi = center - 12; midi <= center + 12; midi += 1) {
        if (chord.pcs.includes(((midi % 12) + 12) % 12)) tones.push(midi);
      }
      tones.sort((a, b) => Math.abs(a - center) - Math.abs(b - center) || a - b);
      const pair = tones.slice(0, 2).sort((a, b) => a - b);
      const half = Math.floor(chord.len / 2);
      events.push([chord.step, pair[0], half], [chord.step + half, pair[1] ?? pair[0], chord.len - half]);
      continue;
    }
    let offset = 0;
    let index = 0;
    while (offset < chord.len) {
      const len = Math.min(style.len[index % style.len.length], chord.len - offset);
      let midi;
      if (style.semi) {
        midi = root + style.semi[index % style.semi.length];
      } else {
        const k = style.idx[index % style.idx.length];
        const n = chord.intervals.length;
        midi = root + chord.intervals[k % n] + 12 * Math.floor(k / n);
      }
      events.push([chord.step + offset, midi, len]);
      offset += len;
      index += 1;
    }
  }
  return events;
}

const VOICE_DEFAULTS = {
  lead: { wave: "p25", vol: 0.3, atk: 0.006, sus: 0.72, decay: 0.09, rel: 0.05, gate: 0.92, vib: 14, vibRate: 5.5, echo: true },
  harm: { wave: "p12", vol: 0.16, atk: 0.004, sus: 0.5, decay: 0.07, rel: 0.04, gate: 0.86, vib: 0, vibRate: 5.5, echo: true },
  bass: { wave: "tri", vol: 0.42, atk: 0.003, sus: 1, decay: 0.1, rel: 0.012, gate: 0.94, vib: 0, vibRate: 5.5, echo: false },
  drum: { vol: 0.5 },
};

function mergeVoices(base, extra = {}) {
  const out = {};
  for (const name of CHANNELS) out[name] = { ...base[name], ...(extra[name] || {}) };
  return out;
}

function compileTrack(id, def) {
  const errors = [];
  const stepDur = 60 / def.bpm / 4;
  const compiled = {};
  for (const [name, spec] of Object.entries(def.sections)) {
    const label = `${id}.${name}`;
    const steps = spec.bars * 16;
    const chordData = spec.chords ? parseChords(spec.chords, errors, `${label}.chords`) : { chords: [], steps };
    if (spec.chords && chordData.steps !== steps) errors.push(`${label}.chords: ${chordData.steps} steps, expected ${steps}`);
    const channels = {};
    for (const [key, value] of Object.entries(spec)) {
      const base = key.split("@")[0];
      if (!CHANNELS.includes(base)) continue;
      const chLabel = `${label}.${key}`;
      if (typeof value === "string") {
        const parsed = base === "drum" ? parseDrums(value, errors, chLabel) : parseSeq(value, errors, chLabel);
        if (parsed.steps !== steps) errors.push(`${chLabel}: ${parsed.steps} steps, expected ${steps}`);
        channels[key] = parsed.events;
      } else if (value && typeof value === "object") {
        if (!spec.chords) errors.push(`${chLabel}: style without chords`);
        channels[key] = generateFromChords(chordData.chords, value, errors, chLabel);
      }
    }
    compiled[name] = { name, steps, chords: chordData.chords, channels };
  }

  const timeline = [];
  let cursor = 0;
  let introSteps = 0;
  def.order.forEach((name, index) => {
    const section = compiled[name];
    if (!section) {
      errors.push(`${id}: missing section ${name}`);
      return;
    }
    if (index === (def.loopFrom || 0)) introSteps = cursor;
    timeline.push({ name, start: cursor, steps: section.steps, chords: section.chords, channels: section.channels });
    cursor += section.steps;
  });
  const totalSteps = cursor;

  const tables = [];
  for (let level = 0; level <= MAX_INTENSITY; level += 1) {
    const table = new Array(totalSteps).fill(null);
    for (const part of timeline) {
      for (let ch = 0; ch < CHANNELS.length; ch += 1) {
        let chosen = null;
        let best = -1;
        for (const key of Object.keys(part.channels)) {
          const [base, levelText] = key.split("@");
          const keyLevel = levelText ? Number(levelText) : 0;
          if (base === CHANNELS[ch] && keyLevel <= level && keyLevel > best) {
            best = keyLevel;
            chosen = key;
          }
        }
        if (!chosen) continue;
        for (const [step, value, len] of part.channels[chosen]) {
          const at = part.start + step;
          if (at >= totalSteps) continue;
          (table[at] || (table[at] = [])).push([ch, value, len]);
        }
      }
    }
    tables.push(table);
  }

  const voices = mergeVoices(VOICE_DEFAULTS, def.voices);
  return {
    id,
    bpm: def.bpm,
    loop: def.loop !== false,
    stepDur,
    introSteps: def.loop === false ? 0 : introSteps,
    bodySteps: totalSteps - (def.loop === false ? 0 : introSteps),
    totalSteps,
    tables,
    timeline,
    voices,
    voicesV: def.voicesV ? mergeVoices(voices, def.voicesV) : voices,
    modal: def.modal || null,
    echo: { send: 0.2, feedback: 0.25, ...(def.echo || {}) },
    scale: def.scale || null,
    errors,
  };
}

const rep = (text, count) => Array.from({ length: count }, () => text).join(" | ");

// ---------------------------------------------------------------------------
// Original compositions (Circuit Dominion, GPL-3.0-or-later).
// ---------------------------------------------------------------------------

// TITLE: A minor, 88 bpm. Majestic and mysterious: wide 12.5 % arpeggios,
// a slow 25 % pulse theme, half-time drums. intro | A B A' C (28-bar loop).
const TITLE_A_LEAD =
  "E5:8 A5:4 G5:2 E5:2 | F5:6 E5:2 C5:8 | E5:4 D5:2 C5:2 G5:8 | G5:6 F5:2 D5:8 | " +
  "E5:8 A5:4 B5:2 C6:2 | C6:6 B5:2 A5:4 F5:4 | D5:4 F5:4 A5:6 G5:2 | G#5:8 B5:4 E5:4";
const TITLE_A_BASS =
  "A2:12 E2:4 | F2:12 C3:4 | C3:12 G2:4 | G2:12 D3:4 | A2:12 E2:4 | F2:12 C3:4 | D3:12 A2:4 | E2:8 B2:4 E2:4";
const TITLE_FILL = "k...s...s.s.ssss";

const TITLE_DEF = {
  bpm: 88,
  order: ["intro", "A", "B", "A2", "C"],
  loopFrom: 1,
  scale: [9, 11, 0, 2, 4, 5, 7, 8, 10],
  echo: { send: 0.34, feedback: 0.32 },
  voices: {
    lead: { wave: "p25", vol: 0.34, sus: 0.75, vib: 14 },
    harm: { wave: "p12", vol: 0.18, sus: 0.6 },
    drum: { vol: 0.42 },
  },
  sections: {
    intro: {
      bars: 2,
      chords: "Am Am",
      harm: { style: "arp16", lo: 52 },
      bass: "A2:16 | A2:16",
      drum: "g............... | ................",
    },
    A: {
      bars: 8,
      chords: "Am F C G Am F Dm E",
      lead: TITLE_A_LEAD,
      harm: { style: "arp16", lo: 52 },
      bass: TITLE_A_BASS,
      drum: `${rep("k.......s.......", 3)} | k.......s...k.k. | ${rep("k.......s.......", 3)} | ${TITLE_FILL}`,
    },
    B: {
      bars: 8,
      chords: "F G Em Am Dm G C E",
      lead:
        "A5:4 C6:4 A5:2 G5:2 F5:4 | G5:4 B5:4 D6:6 C6:2 | B5:8 G5:4 E5:4 | A5:10 G5:2 A5:2 B5:2 | " +
        "D6:4 A5:4 F5:4 A5:4 | B5:6 A5:2 G5:4 D5:4 | E5:4 G5:4 C6:6 B5:2 | B5:8 G#5:8",
      harm: { style: "pad", center: 62 },
      bass: "F2:8 C3:8 | G2:8 D3:8 | E2:8 B2:8 | A2:8 E2:8 | D3:8 A2:8 | G2:8 D3:8 | C3:8 G2:8 | E2:8 E3:8",
      drum: `${rep("k...h...s...h...", 3)} | k...h...s..sk... | ${rep("k...h...s...h...", 3)} | ${TITLE_FILL}`,
    },
    A2: {
      bars: 8,
      chords: "Am F C G Am F Dm E",
      lead: TITLE_A_LEAD,
      harm:
        "C5:8 E5:4 E5:2 C5:2 | A4:6 G4:2 A4:8 | C5:4 B4:2 A4:2 E5:8 | D5:6 D5:2 B4:8 | " +
        "C5:8 E5:4 G5:2 A5:2 | A5:6 G5:2 F5:4 C5:4 | A4:4 D5:4 F5:6 E5:2 | E5:8 G#5:4 B4:4",
      bass: TITLE_A_BASS,
      drum: `${rep("k.h.h.h.s.h.h.h.", 7)} | ${TITLE_FILL}`,
    },
    C: {
      bars: 4,
      chords: "F Dm Bb E",
      lead: "C6:8 A5:8 | D6:8 A5:4 F5:4 | F5:8 D5:4 Bb4:4 | B4:8 G#4:4 B4:4",
      harm: { style: "arp16", lo: 52 },
      bass: "F2:16 | D2:16 | Bb1:16 | E2:8 B1:4 E2:4",
      drum: `g............... | k............... | k.......k....... | ${TITLE_FILL}`,
    },
  },
};

// BOARD: D, 104 bpm, a thoughtful march. Written in D Mixolydian (Solar,
// bright 25 %/12.5 % pulses). For Void the same skeleton is re-voiced to
// D Aeolian (F# -> F, B -> Bb) on hollow 50 %/25 % pulses, so a turn change
// only changes colour. A B A' D (28-bar loop).
const BOARD_A_LEAD =
  "D5:3 D5:1 A5:4 F#5:4 E5:2 D5:2 | E5:3 E5:1 G5:4 C5:6 -:2 | D5:3 D5:1 B5:4 G5:4 A5:2 B5:2 | A5:8 F#5:4 D5:4 | " +
  "D5:3 D5:1 A5:4 D6:4 C6:2 A5:2 | G5:3 G5:1 E5:4 C5:4 E5:2 G5:2 | F#5:4 D5:4 B4:4 D5:4 | E5:6 C#5:2 A4:8";
const BOARD_FILL = "k.h.s.h.k.s.ssss";

const BOARD_DEF = {
  bpm: 104,
  order: ["A", "B", "A2", "D"],
  scale: [2, 4, 6, 7, 9, 11, 0, 1],
  modal: [6, 11],
  echo: { send: 0.2, feedback: 0.24 },
  voices: {
    lead: { wave: "p25", vol: 0.32, gate: 0.86, sus: 0.7, vib: 12 },
    harm: { wave: "p12", vol: 0.19, sus: 0.5 },
    drum: { vol: 0.46 },
  },
  voicesV: {
    lead: { wave: "p50", vol: 0.27, vib: 18, vibRate: 4.8 },
    harm: { wave: "p25", vol: 0.16 },
  },
  sections: {
    A: {
      bars: 8,
      chords: "D C G D D C Bm A",
      lead: BOARD_A_LEAD,
      harm: { style: "alberti", lo: 55 },
      bass: { style: "march", lo: 38 },
      drum: `${rep("k.h.s.h.k.h.s.hs | k.h.s.h.k.k.s.h.", 3)} | k.h.s.h.k.h.s.hs | ${BOARD_FILL}`,
    },
    B: {
      bars: 8,
      chords: "G A Bm D G A Bm A",
      lead:
        "B5:6 A5:2 G5:8 | A5:6 G5:2 E5:8 | F#5:6 E5:2 D5:8 | A5:8 F#5:4 D5:4 | " +
        "G5:4 B5:4 D6:6 C6:2 | C#6:6 B5:2 A5:8 | D6:4 B5:4 F#5:4 B5:4 | A5:4 E5:4 C#5:8",
      harm: { style: "pad", center: 62 },
      bass: "G2:8 D3:8 | A2:8 E3:8 | B2:8 F#2:8 | D2:8 A2:8 | G2:8 D3:8 | A2:8 C#3:8 | B2:8 F#2:8 | A2:8 A1:8",
      drum: `${rep("k.......h.......", 3)} | k.......h...k... | ${rep("k.......h.......", 3)} | k...h...s.s.ssss`,
    },
    A2: {
      bars: 8,
      chords: "D C G D D C Bm A",
      lead: BOARD_A_LEAD,
      harm: { style: "arp16", lo: 47 },
      bass: { style: "march", lo: 38 },
      drum: `${rep("k.h.s.o.k.h.s.hs | k.h.s.h.k.k.s.h.", 3)} | k.h.s.o.k.h.s.hs | ${BOARD_FILL}`,
    },
    D: {
      bars: 4,
      chords: "D C G A",
      lead: "-:8 A5:2 G5:2 F#5:2 E5:2 | E5:8 -:8 | -:8 B4:2 C5:2 D5:2 E5:2 | C#5:8 E5:8",
      harm: { style: "arp8", lo: 55 },
      bass: "D2:16 | C3:16 | G2:16 | A2:8 E2:4 C#2:4",
      drum: `${rep("k...h...k...h...", 3)} | k...s...s.s.ssss`,
    },
  },
};

// DUEL: E minor, 150 bpm, driving 3+3+2 figures over octave bass.
// Intensity 1 (overtime): 16th arps and hats. Intensity 2 (critical): crash
// accents and 16th octave bass. A B A C1 C2 (32-bar loop).
const DUEL_P = "k.h.s.h.k.hks.h. | k.h.s.h.kkh.s.hs";
const DUEL_F = "k.h.s.h.k.s.ssss";
const DUEL_H = "khhhshhhkhhkshhh | khhhshhhkkhhshss";
const DUEL_HF = "khhhshhhk.s.ssss";
const DUEL_C = "chhhshhhkhhkshhh";
const duelDrums = (bars) => {
  const pairs = bars / 2;
  return {
    drum: `${rep(DUEL_P, pairs - 1)} | k.h.s.h.k.hks.h. | ${DUEL_F}`,
    "drum@1": `${rep(DUEL_H, pairs - 1)} | khhhshhhkhhkshhh | ${DUEL_HF}`,
    "drum@2": `${rep(`${DUEL_C} | khhhshhhkkhhshss`, pairs - 1)} | ${DUEL_C} | ${DUEL_HF}`,
  };
};
const DUEL_LAYERS = {
  harm: { style: "gallop", lo: 57 },
  "harm@1": { style: "arpUp16", lo: 57 },
  bass: { style: "octave8", lo: 35 },
  "bass@2": { style: "octave16", lo: 35 },
};
const DUEL_A_LEAD =
  "E5:3 E5:3 G5:2 B5:3 A5:3 G5:2 | E6:3 D6:3 B5:2 G5:4 A5:4 | G5:3 E5:3 C5:2 E5:3 G5:3 C6:2 | D6:3 C6:3 A5:2 F#5:8 | " +
  "E5:3 E5:3 G5:2 B5:3 A5:3 G5:2 | E6:3 D6:3 B5:2 G5:4 B5:4 | C6:3 B5:3 G5:2 E5:3 G5:3 C6:2 | B5:6 A5:2 F#5:4 D#5:4";

const DUEL_DEF = {
  bpm: 150,
  order: ["A", "B", "A", "C1", "C2"],
  scale: [4, 6, 7, 9, 11, 0, 2, 3],
  echo: { send: 0.12, feedback: 0.18 },
  voices: {
    lead: { wave: "p25", vol: 0.31, gate: 0.88, sus: 0.7, vib: 10, vibRate: 6.5 },
    harm: { wave: "p12", vol: 0.17, sus: 0.4, gate: 0.7 },
    bass: { gate: 0.8 },
    drum: { vol: 0.6 },
  },
  sections: {
    A: {
      bars: 8,
      chords: "Em Em C D Em Em C B",
      lead: DUEL_A_LEAD,
      ...DUEL_LAYERS,
      ...duelDrums(8),
    },
    B: {
      bars: 8,
      chords: "Am Em Am B C D B B7",
      lead:
        "E5:2 A5:4 B5:2 C6:8 | B5:6 A5:2 G5:8 | A5:4 C6:4 E6:6 D6:2 | D#6:8 B5:4 F#5:4 | " +
        "E6:6 D6:2 C6:4 G5:4 | D6:6 C6:2 A5:4 F#5:4 | B5:3 D#6:3 B5:2 F#6:8 | E6:4 D#6:4 B5:2 A5:2 F#5:2 D#5:2",
      ...DUEL_LAYERS,
      ...duelDrums(8),
    },
    C1: {
      bars: 4,
      chords: "C D Bm Em",
      lead: "E5:4 G5:12 | A5:16 | B5:8 F#5:8 | G5:8 E5:8",
      harm: { style: "pad", center: 64 },
      "harm@1": { style: "arpUp16", lo: 57 },
      bass: "C2:16 | D2:16 | B1:16 | E2:16",
      "bass@1": { style: "octave8", lo: 35 },
      drum: `${rep("k.......s.......", 3)} | k...s...s.s.ssss`,
      "drum@1": `${rep("k.h.s.h.k.h.s.h.", 3)} | ${DUEL_F}`,
      "drum@2": `${DUEL_C} | khhhshhhkkhhshss | khhhshhhkhhkshhh | ${DUEL_HF}`,
    },
    C2: {
      bars: 4,
      chords: "C D B B",
      lead: "E6:4 C6:4 G5:4 C6:4 | F#6:4 D6:4 A5:4 D6:4 | D#6:4 B5:4 F#5:4 B5:4 | D#6:2 E6:2 F#6:2 E6:2 D#6:2 C6:2 B5:2 A5:2",
      ...DUEL_LAYERS,
      ...duelDrums(4),
    },
  },
};

// VICTORY: D major fanfare, 132 bpm, plays once. With faction 'V' it is
// re-voiced to D minor (the Void's triumph).
const VICTORY_DEF = {
  bpm: 132,
  loop: false,
  order: ["S"],
  scale: [2, 4, 6, 7, 9, 11, 1],
  modal: [6, 11],
  echo: { send: 0.28, feedback: 0.3 },
  voices: {
    lead: { wave: "p25", vol: 0.32, vib: 18, gate: 0.95 },
    harm: { wave: "p12", vol: 0.18, sus: 0.7, gate: 0.95 },
    drum: { vol: 0.5 },
  },
  voicesV: { lead: { wave: "p50", vol: 0.27 }, harm: { wave: "p25", vol: 0.15 } },
  sections: {
    S: {
      bars: 3,
      chords: "D G:8 A:8 D",
      lead: "A4:2 D5:2 F#5:2 A5:2 F#5:2 A5:2 D6:4 | B5:4 D6:4 C#6:4 E6:4 | D6:12 -:4",
      harm: "F#4:2 A4:2 D5:2 F#5:2 D5:2 F#5:2 A5:4 | G5:4 B5:4 A5:4 C#6:4 | F#5:12 -:4",
      bass: "D2:4 A2:4 D3:4 A2:4 | G2:8 A2:8 | D2:12 -:4",
      drum: "k...s...k.k.s.s. | k...s...k.s.ssss | c...............",
    },
  },
};

// DEFEAT: D minor, 72 bpm, a short somber cadence (bVI - V - i). Plays once.
const DEFEAT_DEF = {
  bpm: 72,
  loop: false,
  order: ["S"],
  scale: [2, 4, 5, 7, 9, 10, 1],
  echo: { send: 0.32, feedback: 0.34 },
  voices: {
    lead: { wave: "p50", vol: 0.25, vib: 20, vibRate: 4.5, gate: 0.95 },
    harm: { wave: "p25", vol: 0.15, sus: 0.7, gate: 0.95 },
    drum: { vol: 0.42 },
  },
  sections: {
    S: {
      bars: 2,
      chords: "Bb:8 A:8 Dm",
      lead: "F5:4 D5:4 E5:4 C#5:4 | D5:12 -:4",
      harm: "D5:4 Bb4:4 C#5:4 A4:4 | A4:12 -:4",
      bass: "Bb2:8 A2:8 | D2:12 -:4",
      drum: "k.......k....... | g...............",
    },
  },
};

export const AUDIO_TRACKS = {
  title: compileTrack("title", TITLE_DEF),
  board: compileTrack("board", BOARD_DEF),
  duel: compileTrack("duel", DUEL_DEF),
  victory: compileTrack("victory", VICTORY_DEF),
  defeat: compileTrack("defeat", DEFEAT_DEF),
};

// ---------------------------------------------------------------------------
// Sound effects. Each recipe receives (engine, time, opts, destination).
// Solar leans on thin bright pulses and upward motion, Void on hollow 50 %
// squares, lower pitches and downward motion.
// ---------------------------------------------------------------------------

const isVoid = (o) => o.faction === "V";

const SFX = {
  move(a, t, o, d) {
    const v = isVoid(o);
    a.notes(d, t, v ? "p50" : "p25", v ? [62, 69] : [74, 81], 0.045, v ? 0.11 : 0.12, o);
    a.noise(d, t, { mode: "short", rate: 1.6, dur: 0.02, vol: 0.035 }, o);
  },
  step(a, t, o, d) {
    const v = isVoid(o);
    a.tone(d, t, { wave: "tri", f0: v ? 180 : 260, f1: v ? 90 : 150, dur: 0.05, vol: 0.2 }, o);
    a.noise(d, t, { mode: "long", rate: v ? 0.35 : 0.8, dur: 0.025, vol: 0.05 }, o);
  },
  select(a, t, o, d) {
    const v = isVoid(o);
    a.notes(d, t, v ? "p25" : "p12", v ? [60, 67, 72] : [72, 79, 84], 0.035, 0.12, o);
  },
  deselect(a, t, o, d) {
    a.tone(d, t, { wave: "p25", f0: 880, f1: 600, dur: 0.07, vol: 0.08 }, o);
  },
  cancel(a, t, o, d) {
    a.notes(d, t, "p50", [76, 69], 0.05, 0.11, o);
  },
  bad(a, t, o, d) {
    a.notes(d, t, "p50", [55, 50], 0.075, 0.12, o);
    a.tone(d, t, { wave: "tri", f0: mtof(43), dur: 0.15, vol: 0.18 }, o);
  },
  uiHover(a, t, o, d) {
    a.tone(d, t, { wave: "p12", f0: mtof(91), dur: 0.02, vol: 0.03 }, o);
  },
  uiConfirm(a, t, o, d) {
    a.notes(d, t, "p25", [79, 86], 0.045, 0.11, o);
    a.notes(d, t + 0.09, "p12", [79, 86], 0.045, 0.035, o);
  },
  pause(a, t, o, d) {
    a.notes(d, t, "p25", [79, 72], 0.05, 0.08, o);
  },
  resume(a, t, o, d) {
    a.notes(d, t, "p25", [72, 79], 0.05, 0.08, o);
  },
  attack(a, t, o, d) {
    if (o.faction === "S") return SFX.shootSolar(a, t, o, d);
    if (o.faction === "V") return SFX.shootVoid(a, t, o, d);
    a.tone(d, t, { wave: "p25", f0: 900, f1: 420, dur: 0.08, vol: 0.11, jitter: 0.03 }, o);
  },
  hit(a, t, o, d) {
    a.noise(d, t, { mode: "long", rate: 0.7, rate1: 0.18, dur: 0.09, vol: 0.2 }, o);
    a.tone(d, t, { wave: "p50", f0: 190, f1: 80, dur: 0.07, vol: 0.09, jitter: 0.05 }, o);
  },
  special(a, t, o, d) {
    if (isVoid(o)) {
      a.tone(d, t, { wave: "p50", f0: 300, f1: 900, dur: 0.22, vol: 0.09 }, o);
      a.noise(d, t, { mode: "short", rate: 0.6, dur: 0.15, vol: 0.05 }, o);
    } else {
      a.tone(d, t, { wave: "p12", f0: 420, f1: 1700, dur: 0.2, vol: 0.11 }, o);
      a.notes(d, t + 0.08, "p25", [84, 88, 91], 0.03, 0.07, o);
    }
  },
  ready(a, t, o, d) {
    // Faction-pitched "weapon ready" chirp: play by ear in couch duels.
    if (isVoid(o)) a.notes(d, t, "p50", [55, 62], 0.04, 0.08, o);
    else a.notes(d, t, "p12", [91, 98], 0.035, 0.08, o);
  },
  win(a, t, o, d) {
    a.notes(d, t, "p25", [72, 76, 79], 0.06, 0.11, o);
    a.tone(d, t + 0.18, { wave: "p25", f0: mtof(84), dur: 0.4, vol: 0.11, vib: 18 }, o);
  },
  countTick(a, t, o, d) {
    a.tone(d, t, { wave: "p25", f0: mtof(76), dur: 0.08, vol: 0.11 }, o);
    a.tone(d, t, { wave: "tri", f0: mtof(64), dur: 0.05, vol: 0.15 }, o);
  },
  fight(a, t, o, d) {
    a.tone(d, t, { wave: "p50", f0: mtof(69), f1: mtof(71), slide: 0.04, dur: 0.42, vol: 0.08 }, o);
    a.tone(d, t, { wave: "p25", f0: mtof(76), f1: mtof(78), slide: 0.04, dur: 0.42, vol: 0.065 }, o);
    a.tone(d, t, { wave: "tri", f0: mtof(47), f1: mtof(35), dur: 0.35, vol: 0.24 }, o);
    a.noise(d, t, { mode: "long", rate: 0.8, rate1: 0.3, dur: 0.35, vol: 0.1 }, o);
  },
  clash(a, t, o, d) {
    a.noise(d, t, { mode: "long", rate: 0.9, rate1: 0.08, dur: 0.6, vol: 0.16 }, o);
    a.tone(d, t, { wave: "p50", f0: mtof(84), f1: mtof(48), dur: 0.35, vol: 0.08 }, o);
    a.tone(d, t, { wave: "tri", f0: 160, f1: 45, dur: 0.45, vol: 0.26 }, o);
    if (isVoid(o)) a.notes(d, t + 0.2, "p50", [59, 58, 53], 0.06, 0.07, o);
    else a.notes(d, t + 0.2, "p12", [71, 78, 83], 0.05, 0.08, o);
  },
  shootSolar(a, t, o, d) {
    a.tone(d, t, { wave: "p12", f0: 1900, f1: 650, dur: 0.075, vol: 0.1, jitter: 0.04 }, o);
    a.noise(d, t, { mode: "short", rate: 2, dur: 0.02, vol: 0.025 }, o);
  },
  shootVoid(a, t, o, d) {
    a.tone(d, t, { wave: "p50", f0: 560, f1: 150, dur: 0.1, vol: 0.11, jitter: 0.04 }, o);
    a.noise(d, t, { mode: "long", rate: 0.3, dur: 0.05, vol: 0.06 }, o);
  },
  meleeSolar(a, t, o, d) {
    a.noise(d, t, { mode: "long", rate: 1.4, rate1: 0.5, dur: 0.08, vol: 0.11 }, o);
    a.tone(d, t, { wave: "p25", f0: mtof(88), dur: 0.035, vol: 0.06, jitter: 0.03 }, o);
  },
  meleeVoid(a, t, o, d) {
    a.noise(d, t, { mode: "long", rate: 0.6, rate1: 0.16, dur: 0.11, vol: 0.13 }, o);
    a.tone(d, t, { wave: "p50", f0: 120, f1: 70, dur: 0.09, vol: 0.09, jitter: 0.03 }, o);
  },
  heavyShot(a, t, o, d) {
    a.noise(d, t, { mode: "long", rate: 0.22, rate1: 0.05, dur: 0.4, vol: 0.16 }, o);
    a.tone(d, t, { wave: "tri", f0: 150, f1: 42, dur: 0.3, vol: 0.24 }, o);
    a.tone(d, t, { wave: "p50", f0: 320, f1: 80, dur: 0.16, vol: 0.05 }, o);
  },
  lance(a, t, o, d) {
    a.tone(d, t, { wave: "p12", f0: 600, f1: 2400, slide: 0.1, dur: 0.32, vol: 0.1 }, o);
    a.tone(d, t, { wave: "p25", f0: 900, f1: 3600, slide: 0.1, dur: 0.26, vol: 0.045 }, o);
    a.noise(d, t, { mode: "short", rate: 2.5, dur: 0.18, vol: 0.03 }, o);
  },
  dash(a, t, o, d) {
    a.noise(d, t, { mode: "long", rate: 0.25, rate1: 1.4, dur: 0.16, vol: 0.11 }, o);
    a.tone(d, t, { wave: "p25", f0: 300, f1: 950, dur: 0.12, vol: 0.06 }, o);
  },
  blink(a, t, o, d) {
    a.notes(d, t, "p12", [84, 91, 79, 96, 83, 90], 0.022, 0.08, o);
    a.noise(d, t, { mode: "short", rate: 3, dur: 0.06, vol: 0.04 }, o);
  },
  shield(a, t, o, d) {
    a.notes(d, t, "p25", [64, 71, 76, 83], 0.04, 0.09, o);
    a.tone(d, t + 0.16, { wave: "p12", f0: mtof(88), dur: 0.3, vol: 0.06, vib: 25 }, o);
    a.tone(d, t, { wave: "tri", f0: mtof(52), dur: 0.3, vol: 0.18 }, o);
  },
  nova(a, t, o, d) {
    a.noise(d, t, { mode: "long", rate: 0.15, rate1: 0.03, dur: 0.7, vol: 0.21 }, o);
    a.tone(d, t, { wave: "p50", f0: 900, f1: 55, dur: 0.45, vol: 0.075 }, o);
    a.tone(d, t, { wave: "tri", f0: 220, f1: 38, dur: 0.4, vol: 0.26 }, o);
  },
  aura(a, t, o, d) {
    a.tone(d, t, { wave: "p50", f0: mtof(43), dur: 0.45, vol: 0.1, vib: 70, vibRate: 9 }, o);
    a.tone(d, t, { wave: "p25", f0: mtof(50) * 1.006, dur: 0.35, vol: 0.05, vib: 40, vibRate: 9 }, o);
  },
  gravity(a, t, o, d) {
    a.notes(d, t, "p50", [67, 63, 60, 55, 51], 0.045, 0.07, o);
    a.tone(d, t, { wave: "tri", f0: 320, f1: 55, dur: 0.32, vol: 0.2 }, o);
    a.noise(d, t, { mode: "long", rate: 0.1, dur: 0.3, vol: 0.06 }, o);
  },
  heal(a, t, o, d) {
    a.notes(d, t, "p25", [72, 76, 79, 84, 88], 0.045, 0.09, o);
    a.notes(d, t + 0.07, "p12", [72, 76, 79, 84, 88], 0.045, 0.035, o);
  },
  corrupt(a, t, o, d) {
    a.notes(d, t, "p50", [70, 66, 69, 63], 0.035, 0.08, o);
    a.noise(d, t, { mode: "short", rate: 0.9, dur: 0.12, vol: 0.04 }, o);
  },
  barrier(a, t, o, d) {
    a.noise(d, t, { mode: "short", rate: 1.2, dur: 0.04, vol: 0.08 }, o);
    a.notes(d, t, "p50", [52, 59], 0.05, 0.08, o);
    a.tone(d, t + 0.1, { wave: "p25", f0: mtof(64), f1: mtof(76), dur: 0.18, vol: 0.07 }, o);
  },
  block(a, t, o, d) {
    a.noise(d, t, { mode: "long", rate: 0.4, dur: 0.045, vol: 0.11 }, o);
    a.tone(d, t, { wave: "tri", f0: 170, f1: 90, dur: 0.06, vol: 0.18 }, o);
  },
  ko(a, t, o, d) {
    a.noise(d, t, { mode: "long", rate: 0.3, rate1: 0.02, dur: 0.95, vol: 0.22 }, o);
    a.tone(d, t, { wave: "p50", f0: 420, f1: 40, dur: 0.6, vol: 0.075 }, o);
    a.tone(d, t, { wave: "tri", f0: 130, f1: 30, dur: 0.55, vol: 0.26 }, o);
    a.noise(d, t + 0.13, { mode: "long", rate: 0.16, rate1: 0.03, dur: 0.6, vol: 0.13 }, o);
  },
  victory(a, t, o, d) {
    const third = isVoid(o) ? 75 : 76;
    a.notes(d, t, "p25", [72, third, 79], 0.07, 0.1, o);
    a.notes(d, t, "p12", [67, 72, third], 0.07, 0.05, o);
    a.tone(d, t + 0.21, { wave: "p25", f0: mtof(84), dur: 0.45, vol: 0.1, vib: 18 }, o);
    a.tone(d, t + 0.21, { wave: "tri", f0: mtof(48), dur: 0.45, vol: 0.22 }, o);
  },
  defeat(a, t, o, d) {
    a.notes(d, t, "p50", [67, 63, 60], 0.12, 0.08, o);
    a.tone(d, t + 0.36, { wave: "p50", f0: mtof(55), dur: 0.5, vol: 0.08, vib: 20 }, o);
    a.tone(d, t, { wave: "tri", f0: mtof(55), f1: mtof(43), dur: 0.8, vol: 0.2 }, o);
  },
  nodeCapture(a, t, o, d) {
    const v = isVoid(o);
    const pair = v ? [79, 86] : [84, 91];
    a.notes(d, t, v ? "p50" : "p25", pair, 0.05, v ? 0.08 : 0.1, o, 0.25);
    a.notes(d, t + 0.1, "p12", pair, 0.05, 0.035, o, 0.2);
  },
  nodeLost(a, t, o, d) {
    a.notes(d, t, "p50", [79, 72], 0.08, 0.08, o, 0.22);
    a.notes(d, t, "tri", [55, 48], 0.08, 0.16, o, 0.22);
  },
  fluxShift(a, t, o, d) {
    const notes = o.faction === "V" ? [72, 75, 79, 84, 87, 91] : o.faction === "S" ? [72, 76, 79, 84, 88, 91] : [72, 74, 79, 84, 86, 91];
    a.notes(d, t, "p12", notes, 0.026, 0.05, o);
    a.notes(d, t + 0.12, "p12", notes, 0.026, 0.018, o);
  },
  turnSolar(a, t, o, d) {
    a.notes(d, t, "p25", [69, 74, 78], 0.08, 0.1, o, 0.26);
    a.tone(d, t, { wave: "tri", f0: mtof(50), dur: 0.4, vol: 0.16 }, o);
    a.notes(d, t + 0.12, "p12", [69, 74, 78], 0.08, 0.03, o, 0.2);
  },
  turnVoid(a, t, o, d) {
    a.notes(d, t, "p50", [57, 62, 65], 0.08, 0.09, o, 0.26);
    a.tone(d, t, { wave: "tri", f0: mtof(38), dur: 0.45, vol: 0.2 }, o);
    a.notes(d, t + 0.12, "p25", [57, 62, 65], 0.08, 0.03, o, 0.2);
  },
  command(a, t, o, d) {
    a.notes(d, t, "p25", [60, 64, 67, 72, 76, 79, 84], 0.028, 0.08, o);
    a.tone(d, t, { wave: "p12", f0: 400, f1: 1600, dur: 0.25, vol: 0.04 }, o);
    a.noise(d, t, { mode: "short", rate: 1.4, dur: 0.1, vol: 0.03 }, o);
  },
  warning(a, t, o, d) {
    a.notes(d, t, "p50", [81, 76, 81, 76, 81, 76], 0.09, 0.14, o);
  },
  overtime(a, t, o, d) {
    a.notes(d, t, "p25", [76, 83, 76, 83], 0.07, 0.1, o);
    a.noise(d, t, { mode: "long", rate: 0.7, rate1: 0.2, dur: 0.4, vol: 0.13 }, o);
    a.tone(d, t, { wave: "tri", f0: 110, f1: 55, dur: 0.4, vol: 0.25 }, o);
  },
  _fallback(a, t, o, d) {
    a.tone(d, t, { wave: "p25", f0: mtof(84), dur: 0.04, vol: 0.05 }, o);
  },
};
SFX.countdown = SFX.fight; // legacy name: the GO stab when a duel goes live

const SFX_ALIASES = { repair: "heal", pull: "gravity", spread: "shootVoid", explode: "ko", capture: "nodeCapture" };

export const SFX_KINDS = Object.keys(SFX).filter((kind) => !kind.startsWith("_"));

const RATE_LIMIT = {
  hit: 0.05,
  block: 0.06,
  uiHover: 0.06,
  step: 0.05,
  move: 0.04,
  shootSolar: 0.04,
  shootVoid: 0.04,
  meleeSolar: 0.05,
  meleeVoid: 0.05,
  attack: 0.04,
  aura: 0.3,
  gravity: 0.15,
  countTick: 0.12,
  fluxShift: 0.2,
  warning: 0.5,
  ready: 0.08,
  _fallback: 0.05,
};
const DEFAULT_RATE_LIMIT = 0.03;

// ---------------------------------------------------------------------------
// Waveforms
// ---------------------------------------------------------------------------

function pulseCoefficients(duty, harmonics = 64) {
  const real = new Float32Array(harmonics);
  const imag = new Float32Array(harmonics);
  // 0/1 pulse with DC removed: narrower duty is quieter, like the hardware.
  for (let k = 1; k < harmonics; k += 1) real[k] = (2 / (k * Math.PI)) * Math.sin(k * Math.PI * duty);
  return { real, imag };
}

function triangleCoefficients(harmonics = 32) {
  // 32-step, 4-bit triangle (15..0, 0..15) scaled to +/-0.5.
  const levels = [];
  for (let j = 0; j < 32; j += 1) levels.push(((j < 16 ? 15 - j : j - 16) / 15 - 0.5));
  const real = new Float32Array(harmonics);
  const imag = new Float32Array(harmonics);
  for (let k = 1; k < harmonics; k += 1) {
    let a = 0;
    let b = 0;
    for (let j = 0; j < 32; j += 1) {
      const t0 = j / 32;
      const t1 = (j + 1) / 32;
      a += levels[j] * (Math.sin(2 * Math.PI * k * t1) - Math.sin(2 * Math.PI * k * t0));
      b += levels[j] * (Math.cos(2 * Math.PI * k * t0) - Math.cos(2 * Math.PI * k * t1));
    }
    real[k] = (2 * a) / (2 * Math.PI * k);
    imag[k] = (2 * b) / (2 * Math.PI * k);
  }
  return { real, imag };
}

function lfsrNoise(length, tapBit) {
  const data = new Float32Array(length);
  let reg = 1;
  for (let i = 0; i < length; i += 1) {
    const feedback = (reg & 1) ^ ((reg >> tapBit) & 1);
    reg = (reg >> 1) | (feedback << 14);
    data[i] = reg & 1 ? -0.5 : 0.5;
  }
  return data;
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

export class AudioManager {
  constructor(getMuted) {
    this.getMuted = getMuted;
    this.ctx = null;
    this.unlocked = false;
    this._graph = null;
    this._graphFailedFor = null;
    this._players = [];
    this._current = null;
    this._wanted = null;
    this._stopFade = 0.6;
    this._musicEnabled = true;
    this._volumes = { music: 1, sfx: 1 };
    this._duck = 1;
    this._intensity = 0;
    this._lastMuted = null;
    this._lastKind = Object.create(null);
    this._voiceEnds = { music: [], sfx: [] };
    this._temp = [];
    this.stats = { musicNotes: 0, sfxVoices: 0, skippedSteps: 0, droppedVoices: 0, rateLimited: 0 };
  }

  unlock() {
    if (this.ctx?.state === "running") {
      return;
    }

    try {
      if (!this.ctx || this.ctx.state === "closed") {
        // Resolve lazily: hosts (and tests) may install window after import.
        const scope = typeof window !== "undefined" ? window : globalThis;
        const AudioContextClass = scope.AudioContext || scope.webkitAudioContext;
        this.ctx = new AudioContextClass();
      }
      this.unlocked = true;
      if (this.ctx.state !== "running") {
        const pending = this.ctx.resume();
        if (pending && typeof pending.catch === "function") pending.catch(() => {});
      }
    } catch (_err) {
      // Audio failure must never affect gameplay.
    }
  }

  get musicEnabled() {
    return this._musicEnabled;
  }

  get currentTrack() {
    return this._wanted?.id || null;
  }

  /** Per-frame tick: mute ramps, track crossfades and the lookahead scheduler. */
  update() {
    try {
      if (!this._ready()) return;
      const now = this.ctx.currentTime;
      const muted = this._isMuted();
      if (muted !== this._lastMuted) {
        this._lastMuted = muted;
        this._rampParam(this._graph.master.gain, muted ? 0 : MASTER_LEVEL, 0.012);
      }
      this._reconcile(now);
      const audible = !muted && this._musicEnabled;
      const horizon = now + LOOKAHEAD;
      for (const player of this._players) this._advance(player, now, horizon, audible);
      this._reap(now);
    } catch (_err) {
      // Audio failure must never affect gameplay.
    }
  }

  beep(kind, opts = {}) {
    if (!this.unlocked || this._isMuted()) {
      return;
    }

    try {
      if (!this._ready()) return;
      const now = this.ctx.currentTime;
      let name = typeof kind === "string" ? kind : "";
      if (SFX_ALIASES[name]) name = SFX_ALIASES[name];
      if (!Object.prototype.hasOwnProperty.call(SFX, name) || name.startsWith("_")) name = "_fallback";
      const gap = RATE_LIMIT[name] ?? DEFAULT_RATE_LIMIT;
      // Faction-pitched ready chirps may coincide (mirrored cooldowns): both must sound.
      const faction = opts && (opts.faction === "S" || opts.faction === "V") ? opts.faction : "";
      const key = name === "ready" && faction ? `ready:${faction}` : name;
      const last = this._lastKind[key];
      if (last !== undefined && now >= last && now - last < gap) {
        this.stats.rateLimited += 1;
        return;
      }
      this._lastKind[key] = now;

      const o = this._sfxOptions(opts);
      let dest = this._graph.sfx;
      if (o.pan !== 0 && typeof this.ctx.createStereoPanner === "function") {
        const panner = this.ctx.createStereoPanner();
        panner.pan.setValueAtTime(o.pan, now);
        panner.connect(dest);
        dest = panner;
        this._temp.push({ node: panner, until: now + 2.5 });
      }
      SFX[name](this, now + 0.005, o, dest);
    } catch (_err) {
      // Audio failure must never affect gameplay.
    }
  }

  playMusic(trackId, opts = {}) {
    try {
      const track = AUDIO_TRACKS[trackId];
      if (!track) return false;
      const o = opts || {};
      const same = this._wanted && this._wanted.id === trackId;
      const faction = o.faction === "V" || o.faction === "S" ? o.faction : same ? this._wanted.faction : "S";
      if (o.intensity !== undefined) this.setMusicIntensity(o.intensity);
      if (same && !o.restart) {
        this._wanted.faction = faction;
        if (this._current && this._current.track.id === trackId) this._current.faction = faction;
      } else {
        const fade = clamp(Number(o.fade ?? (track.loop ? 0.6 : 0.25)) || 0, 0, 4);
        this._wanted = { id: trackId, faction, fade, restart: Boolean(o.restart) };
      }
      if (this._ready()) this._reconcile(this.ctx.currentTime);
      return true;
    } catch (_err) {
      return false;
    }
  }

  stopMusic(fadeSec = 0.6) {
    try {
      this._wanted = null;
      this._stopFade = clamp(Number(fadeSec) || 0, 0, 4);
      if (this._ready()) this._reconcile(this.ctx.currentTime);
    } catch (_err) {
      // Audio failure must never affect gameplay.
    }
  }

  setMusicIntensity(level) {
    const value = Math.round(Number(level));
    this._intensity = Number.isFinite(value) ? clamp(value, 0, MAX_INTENSITY) : 0;
  }

  setMusicEnabled(enabled) {
    this._musicEnabled = Boolean(enabled);
    this._applyLevels();
  }

  setVolumes(volumes = {}) {
    for (const key of ["music", "sfx"]) {
      const value = Number(volumes?.[key]);
      if (Number.isFinite(value)) this._volumes[key] = clamp(value, 0, 1);
    }
    this._applyLevels();
  }

  setMusicDuck(amount = 1) {
    const value = Number(amount);
    this._duck = Number.isFinite(value) ? clamp(value, 0, 1) : 1;
    this._applyLevels();
  }

  getDebugState() {
    const player = this._current;
    return {
      ready: Boolean(this._graph && this._graph.ctx === this.ctx && this.ctx?.state === "running"),
      track: player?.track.id || null,
      wanted: this._wanted?.id || null,
      step: player?.step ?? 0,
      faction: player?.faction || null,
      done: Boolean(player?.done),
      intensity: this._intensity,
      musicEnabled: this._musicEnabled,
      players: this._players.length,
      voices: { music: this._voiceEnds.music.length, sfx: this._voiceEnds.sfx.length },
      stats: { ...this.stats },
    };
  }

  // ----- internals -----

  _isMuted() {
    try {
      return Boolean(typeof this.getMuted === "function" && this.getMuted());
    } catch (_err) {
      return false;
    }
  }

  _ready() {
    const ctx = this.ctx;
    if (!this.unlocked || !ctx || ctx.state !== "running") return false;
    return this._ensureGraph();
  }

  _musicLevel() {
    return MUSIC_BASE * this._volumes.music * this._duck * (this._musicEnabled ? 1 : 0);
  }

  _sfxLevel() {
    return SFX_BASE * this._volumes.sfx;
  }

  _applyLevels() {
    try {
      const graph = this._graph;
      if (!graph || graph.ctx !== this.ctx || this.ctx?.state !== "running") return;
      this._rampParam(graph.music.gain, this._musicLevel(), 0.05);
      this._rampParam(graph.sfx.gain, this._sfxLevel(), 0.03);
    } catch (_err) {
      // Audio failure must never affect gameplay.
    }
  }

  _rampParam(param, target, tau) {
    const now = this.ctx.currentTime;
    if (typeof param.cancelScheduledValues === "function") param.cancelScheduledValues(now);
    param.setValueAtTime(param.value, now);
    param.setTargetAtTime(target, now, tau);
  }

  _ensureGraph() {
    const ctx = this.ctx;
    if (this._graph && this._graph.ctx === ctx) return true;
    if (this._graphFailedFor === ctx) return false;
    try {
      const required = ["createGain", "createOscillator"];
      if (required.some((name) => typeof ctx[name] !== "function") || !ctx.destination) {
        this._graphFailedFor = ctx;
        return false;
      }
      const muted = this._isMuted();
      const graph = { ctx };
      graph.master = ctx.createGain();
      graph.master.gain.value = muted ? 0 : MASTER_LEVEL;
      if (typeof ctx.createDynamicsCompressor === "function") {
        const comp = ctx.createDynamicsCompressor();
        const set = (param, value) => {
          if (param) param.value = value;
        };
        set(comp.threshold, -12);
        set(comp.knee, 10);
        set(comp.ratio, 3.5);
        set(comp.attack, 0.004);
        set(comp.release, 0.2);
        graph.master.connect(comp);
        comp.connect(ctx.destination);
        graph.comp = comp;
      } else {
        graph.master.connect(ctx.destination);
      }
      graph.music = ctx.createGain();
      graph.music.gain.value = this._musicLevel();
      graph.music.connect(graph.master);
      graph.sfx = ctx.createGain();
      graph.sfx.gain.value = this._sfxLevel();
      graph.sfx.connect(graph.master);

      graph.echoIn = null;
      if (typeof ctx.createDelay === "function") {
        const echoIn = ctx.createGain();
        const delay = ctx.createDelay(1.5);
        const feedback = ctx.createGain();
        const echoOut = ctx.createGain();
        delay.delayTime.value = 0.4;
        feedback.gain.value = 0.25;
        echoOut.gain.value = 1;
        echoIn.connect(delay);
        let tail = delay;
        if (typeof ctx.createBiquadFilter === "function") {
          const tone = ctx.createBiquadFilter();
          tone.type = "lowpass";
          tone.frequency.value = 2600;
          delay.connect(tone);
          tail = tone;
        }
        tail.connect(feedback);
        feedback.connect(delay);
        tail.connect(echoOut);
        echoOut.connect(graph.music);
        Object.assign(graph, { echoIn, delay, feedback, echoOut });
      }

      graph.waves = {};
      if (typeof ctx.createPeriodicWave === "function") {
        for (const [name, duty] of [["p12", 0.125], ["p25", 0.25], ["p50", 0.5]]) {
          const { real, imag } = pulseCoefficients(duty);
          graph.waves[name] = ctx.createPeriodicWave(real, imag, { disableNormalization: true });
        }
        const tri = triangleCoefficients();
        graph.waves.tri = ctx.createPeriodicWave(tri.real, tri.imag, { disableNormalization: true });
      }

      graph.noise = null;
      if (typeof ctx.createBuffer === "function" && typeof ctx.createBufferSource === "function") {
        const rate = ctx.sampleRate || 44100;
        const longData = lfsrNoise(32767, 1);
        const shortPeriod = lfsrNoise(93, 6);
        const shortData = new Float32Array(93 * 48);
        for (let i = 0; i < shortData.length; i += 1) shortData[i] = shortPeriod[i % 93];
        const toBuffer = (data) => {
          const buffer = ctx.createBuffer(1, data.length, rate);
          buffer.getChannelData(0).set(data);
          return buffer;
        };
        graph.noise = { long: toBuffer(longData), short: toBuffer(shortData) };
      }

      this._graph = graph;
      this._graphFailedFor = null;
      this._players = [];
      this._current = null;
      this._voiceEnds = { music: [], sfx: [] };
      this._lastKind = Object.create(null);
      this._temp = [];
      this._lastMuted = muted;
      return true;
    } catch (_err) {
      this._graph = null;
      this._graphFailedFor = ctx;
      return false;
    }
  }

  _reconcile(now) {
    const want = this._wanted;
    const current = this._current;
    if (!want) {
      if (current) this._fadeOut(current, now, this._stopFade);
      this._current = null;
      return;
    }
    if (current && current.track.id === want.id && !want.restart) {
      current.faction = want.faction;
      return;
    }
    want.restart = false;
    const track = AUDIO_TRACKS[want.id];
    if (!track) return;
    if (current) this._fadeOut(current, now, want.fade);
    this._current = this._startPlayer(track, now, want, current ? want.fade : 0);
  }

  _startPlayer(track, now, want, fadeIn) {
    const ctx = this.ctx;
    const graph = this._graph;
    const out = ctx.createGain();
    out.connect(graph.music);
    let wet = null;
    if (graph.echoIn) {
      wet = ctx.createGain();
      wet.connect(graph.echoIn);
    }
    const startAt = now + START_LATENCY;
    if (fadeIn > 0) {
      out.gain.setValueAtTime(0.0001, now);
      out.gain.linearRampToValueAtTime(1, startAt + fadeIn);
      if (wet) {
        wet.gain.setValueAtTime(0.0001, now);
        wet.gain.linearRampToValueAtTime(track.echo.send, startAt + fadeIn);
      }
    } else {
      out.gain.value = 1;
      if (wet) wet.gain.value = track.echo.send;
    }
    if (graph.delay) {
      // Dotted-eighth echo, synced to the incoming track's tempo.
      this._rampParam(graph.delay.delayTime, track.stepDur * 3, 0.08);
      this._rampParam(graph.feedback.gain, track.echo.feedback, 0.1);
    }
    const player = {
      track,
      out,
      wet,
      step: 0,
      nextTime: startAt,
      faction: want.faction,
      stopAt: null,
      disposeAt: null,
      done: false,
    };
    this._players.push(player);
    return player;
  }

  _fadeOut(player, now, fade) {
    if (player.stopAt !== null) return;
    const seconds = Math.max(0.02, fade);
    player.stopAt = now + seconds;
    player.disposeAt = now + seconds + 1;
    for (const node of [player.out, player.wet]) {
      if (!node) continue;
      const param = node.gain;
      if (typeof param.cancelScheduledValues === "function") param.cancelScheduledValues(now);
      param.setValueAtTime(param.value, now);
      param.linearRampToValueAtTime(0, now + seconds);
    }
  }

  _advance(player, now, horizon, audible) {
    const track = player.track;
    if (player.done || (player.stopAt !== null && now >= player.stopAt)) return;
    const dt = track.stepDur;
    if (player.nextTime > now + 2) player.nextTime = now + START_LATENCY;
    if (player.nextTime < now - BEHIND_TOLERANCE) {
      // Frames stopped (background tab, debugger): jump to the musical
      // position for "now" instead of bursting the backlog.
      const behind = Math.ceil((now - player.nextTime) / dt);
      player.step += behind;
      player.nextTime += behind * dt;
      this.stats.skippedSteps += behind;
    }
    let count = 0;
    while (player.nextTime < horizon && count < MAX_STEPS_PER_UPDATE) {
      if (player.stopAt !== null && player.nextTime >= player.stopAt) break;
      if (!track.loop && player.step >= track.totalSteps) break;
      if (audible) this._playStep(player, player.step, player.nextTime);
      player.step += 1;
      player.nextTime += dt;
      count += 1;
    }
    if (!track.loop && player.step >= track.totalSteps) player.done = true;
  }

  _playStep(player, step, time) {
    const track = player.track;
    const index = !track.loop || step < track.introSteps
      ? step
      : track.introSteps + ((step - track.introSteps) % track.bodySteps);
    const table = track.tables[this._intensity] || track.tables[0];
    const events = table[index];
    if (!events) return;
    const voiceVoid = player.faction === "V";
    const voices = voiceVoid ? track.voicesV : track.voices;
    for (const [channel, value, len] of events) {
      if (channel === CH_DRUM) {
        this._drum(player, value, time, voices.drum.vol);
        continue;
      }
      const voice = voices[CHANNELS[channel]];
      let midi = value;
      if (voiceVoid && track.modal && track.modal.includes(((midi % 12) + 12) % 12)) midi -= 1;
      midi += voice.xpose || 0;
      this._musicNote(player, voice, midi, time, len * track.stepDur);
    }
  }

  _claimVoice(bus, end) {
    const now = this.ctx.currentTime;
    const list = this._voiceEnds[bus];
    let write = 0;
    for (let read = 0; read < list.length; read += 1) {
      if (list[read] > now) list[write++] = list[read];
    }
    list.length = write;
    if (list.length >= (bus === "music" ? MUSIC_VOICE_CAP : SFX_VOICE_CAP)) {
      this.stats.droppedVoices += 1;
      return false;
    }
    list.push(end);
    return true;
  }

  _applyWave(osc, name) {
    const wave = this._graph.waves[name];
    if (wave && typeof osc.setPeriodicWave === "function") osc.setPeriodicWave(wave);
    else osc.type = name === "tri" ? "triangle" : "square";
  }

  _cleanup(source, ...nodes) {
    source.onended = () => {
      for (const node of [source, ...nodes]) {
        try {
          node.disconnect();
        } catch (_err) {
          // Already disconnected.
        }
      }
    };
  }

  _vibrato(osc, time, dur, depth, rate = 5.5) {
    const delay = Math.min(0.2, dur * 0.35);
    const len = dur - delay;
    if (len < 0.08 || !osc.detune || typeof osc.detune.setValueCurveAtTime !== "function") return;
    const points = Math.max(2, Math.min(400, Math.ceil(len * 50)));
    const curve = new Float32Array(points);
    for (let i = 0; i < points; i += 1) {
      const t = (i / (points - 1)) * len;
      curve[i] = depth * Math.min(1, t / 0.25) * Math.sin(2 * Math.PI * rate * t);
    }
    try {
      osc.detune.setValueCurveAtTime(curve, time + delay, len);
    } catch (_err) {
      // Vibrato is decoration only.
    }
  }

  _musicNote(player, voice, midi, time, len) {
    const gate = Math.max(0.03, len * voice.gate);
    const end = time + gate + voice.rel * 6;
    if (!this._claimVoice("music", end)) return;
    const ctx = this.ctx;
    const osc = ctx.createOscillator();
    this._applyWave(osc, voice.wave);
    osc.frequency.setValueAtTime(mtof(midi), time);
    const env = ctx.createGain();
    const peak = voice.vol;
    env.gain.setValueAtTime(0, time);
    env.gain.linearRampToValueAtTime(peak, time + voice.atk);
    if (voice.sus < 1) env.gain.setTargetAtTime(peak * voice.sus, time + voice.atk, voice.decay);
    env.gain.setTargetAtTime(0, time + gate, voice.rel);
    if (voice.vib && gate > 0.3) this._vibrato(osc, time, gate, voice.vib, voice.vibRate);
    osc.connect(env);
    env.connect(player.out);
    if (voice.echo && player.wet) env.connect(player.wet);
    this._cleanup(osc, env);
    osc.start(time);
    osc.stop(end);
    this.stats.musicNotes += 1;
  }

  _drum(player, code, time, vol) {
    const out = player.out;
    switch (code) {
      case "k":
        this._tone(out, time, { wave: "tri", f0: 150, f1: 46, slide: 0.07, dur: 0.14, vol: vol * 1.0, atk: 0.002 }, "music");
        this._noise(out, time, { mode: "long", rate: 0.35, dur: 0.03, vol: vol * 0.25 }, "music");
        break;
      case "s":
        this._noise(out, time, { mode: "long", rate: 0.55, dur: 0.13, vol: vol * 0.6 }, "music");
        this._tone(out, time, { wave: "tri", f0: 240, f1: 150, dur: 0.05, vol: vol * 0.35 }, "music");
        break;
      case "h":
        this._noise(out, time, { mode: "long", rate: 1, dur: 0.035, vol: vol * 0.2 }, "music");
        break;
      case "o":
        this._noise(out, time, { mode: "long", rate: 1, dur: 0.16, vol: vol * 0.17 }, "music");
        break;
      case "c":
        this._noise(out, time, { mode: "long", rate: 0.75, dur: 0.8, vol: vol * 0.3 }, "music");
        break;
      case "g":
        this._noise(out, time, { mode: "long", rate: 0.1, rate1: 0.06, dur: 1.5, vol: vol * 0.3, atk: 0.08 }, "music");
        this._tone(out, time, { wave: "tri", f0: 82, f1: 78, dur: 1.0, vol: vol * 0.35, atk: 0.02 }, "music");
        break;
      case "t":
        this._tone(out, time, { wave: "tri", f0: 220, f1: 95, dur: 0.16, vol: vol * 0.8 }, "music");
        break;
      default:
        break;
    }
  }

  /** One enveloped oscillator with optional exponential pitch sweep. */
  _tone(dest, time, spec, bus) {
    const dur = Math.max(0.01, spec.dur);
    const end = time + dur + 0.03;
    if (!this._claimVoice(bus, end)) return false;
    const ctx = this.ctx;
    const osc = ctx.createOscillator();
    this._applyWave(osc, spec.wave || "p50");
    osc.frequency.setValueAtTime(spec.f0, time);
    if (spec.f1 && spec.f1 !== spec.f0) {
      osc.frequency.exponentialRampToValueAtTime(spec.f1, time + Math.min(dur, spec.slide || dur));
    }
    const env = ctx.createGain();
    const atk = Math.min(spec.atk ?? 0.004, dur * 0.5);
    env.gain.setValueAtTime(0.0001, time);
    env.gain.linearRampToValueAtTime(Math.max(0.0002, spec.vol), time + atk);
    env.gain.exponentialRampToValueAtTime(0.0001, time + dur);
    if (spec.vib) this._vibrato(osc, time, dur, spec.vib, spec.vibRate || 6);
    osc.connect(env);
    env.connect(dest);
    this._cleanup(osc, env);
    osc.start(time);
    osc.stop(end);
    if (bus === "sfx") this.stats.sfxVoices += 1;
    return true;
  }

  /** Looping LFSR noise with an optional playback-rate sweep. */
  _noise(dest, time, spec, bus) {
    const buffer = this._graph.noise?.[spec.mode || "long"];
    if (!buffer) return false;
    const dur = Math.max(0.01, spec.dur);
    const end = time + dur + 0.03;
    if (!this._claimVoice(bus, end)) return false;
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.loop = true;
    src.playbackRate.setValueAtTime(spec.rate, time);
    if (spec.rate1 && spec.rate1 !== spec.rate) src.playbackRate.exponentialRampToValueAtTime(spec.rate1, time + dur);
    const env = ctx.createGain();
    const atk = Math.min(spec.atk ?? 0.002, dur * 0.5);
    env.gain.setValueAtTime(0.0001, time);
    env.gain.linearRampToValueAtTime(Math.max(0.0002, spec.vol), time + atk);
    env.gain.exponentialRampToValueAtTime(0.0001, time + dur);
    src.connect(env);
    env.connect(dest);
    this._cleanup(src, env);
    const offset = (buffer.duration || 0) * Math.random() * 0.9;
    src.start(time, offset);
    src.stop(end);
    if (bus === "sfx") this.stats.sfxVoices += 1;
    return true;
  }

  // Helpers used by SFX recipes (opts applied: pitch, volume, intensity).
  tone(dest, time, spec, o) {
    const jitter = spec.jitter ? 1 + (Math.random() * 2 - 1) * spec.jitter : 1;
    const factor = o.pitchFactor * jitter;
    return this._tone(dest, time, {
      ...spec,
      f0: spec.f0 * factor,
      f1: spec.f1 ? spec.f1 * factor : 0,
      vol: spec.vol * o.gain,
    }, "sfx");
  }

  noise(dest, time, spec, o) {
    return this._noise(dest, time, {
      ...spec,
      rate: spec.rate * o.pitchFactor,
      rate1: spec.rate1 ? spec.rate1 * o.pitchFactor : 0,
      vol: spec.vol * o.gain,
    }, "sfx");
  }

  notes(dest, time, wave, midis, stepSec, vol, o, lastDur = 0) {
    midis.forEach((midi, index) => {
      const last = index === midis.length - 1;
      const dur = last && lastDur ? lastDur : stepSec * 1.25;
      this.tone(dest, time + index * stepSec, { wave, f0: mtof(midi), dur, vol }, o);
    });
  }

  _sfxOptions(opts) {
    const o = opts && typeof opts === "object" ? opts : {};
    const intensity = Number.isFinite(Number(o.intensity)) ? clamp(Number(o.intensity), 0, 1) : null;
    const volume = Number.isFinite(Number(o.volume)) ? clamp(Number(o.volume), 0, 2) : 1;
    const pitch = Number.isFinite(Number(o.pitch)) ? clamp(Number(o.pitch), -24, 24) : 0;
    const pan = Number.isFinite(Number(o.pan)) ? clamp(Number(o.pan), -1, 1) : 0;
    return {
      faction: o.faction === "S" || o.faction === "V" ? o.faction : null,
      intensity,
      pan: Math.abs(pan) < 0.01 ? 0 : pan,
      pitchFactor: Math.pow(2, pitch / 12),
      gain: volume * (intensity === null ? 1 : 0.55 + 0.45 * intensity),
    };
  }

  _reap(now) {
    if (this._players.length > 1 || this._players.some((p) => p.disposeAt !== null)) {
      this._players = this._players.filter((player) => {
        if (player.disposeAt === null || now < player.disposeAt) return true;
        for (const node of [player.out, player.wet]) {
          try {
            node?.disconnect();
          } catch (_err) {
            // Already disconnected.
          }
        }
        return false;
      });
    }
    if (this._temp.length) {
      this._temp = this._temp.filter((entry) => {
        if (now < entry.until) return true;
        try {
          entry.node.disconnect();
        } catch (_err) {
          // Already disconnected.
        }
        return false;
      });
    }
  }
}
