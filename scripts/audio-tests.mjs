// SPDX-License-Identifier: GPL-3.0-or-later
// Additional terms under GPL-3.0 section 7 apply; see NOTICE.md.
//
// Procedural audio engine tests (no dependencies). A recording fake
// AudioContext captures every node, connection, automation event and
// scheduled start so the scheduler, mute/music toggles, crossfades, stingers
// and failure isolation can be verified without a browser.
//
// Run: node scripts/audio-tests.mjs

import assert from "node:assert/strict";

const timerCalls = { setTimeout: 0, setInterval: 0, requestAnimationFrame: 0 };
for (const name of Object.keys(timerCalls)) {
  const original = globalThis[name];
  globalThis[name] = (...args) => {
    timerCalls[name] += 1;
    return original ? original(...args) : 0;
  };
}

globalThis.window = globalThis.window || {};
const { AudioManager, AUDIO_TRACKS, SFX_KINDS } = await import("../src/audio.js");

const LOOKAHEAD = 0.25;
const EPS = 1e-9;
let created = 0;
let crossContextErrors = 0;
let apiErrors = 0;

function check(condition, message) {
  if (!condition) {
    apiErrors += 1;
    throw new TypeError(message);
  }
}

class FakeParam {
  constructor(value = 0) {
    this.value = value;
    this.events = [];
  }
  _push(type, v, t, extra = {}) {
    check(Number.isFinite(v), `${type}: non-finite value ${v}`);
    check(Number.isFinite(t) && t >= 0, `${type}: bad time ${t}`);
    this.events.push({ type, v, t, ...extra });
    return this;
  }
  setValueAtTime(v, t) {
    return this._push("set", v, t);
  }
  linearRampToValueAtTime(v, t) {
    return this._push("linear", v, t);
  }
  exponentialRampToValueAtTime(v, t) {
    check(v > 0, `exponentialRamp needs a positive value, got ${v}`);
    return this._push("exp", v, t);
  }
  setTargetAtTime(v, t, c) {
    check(c > 0, `setTargetAtTime needs a positive time constant, got ${c}`);
    return this._push("target", v, t, { c });
  }
  setValueCurveAtTime(curve, t, d) {
    check(curve.length >= 2 && d > 0, "setValueCurveAtTime needs >=2 points and duration");
    for (const value of curve) check(Number.isFinite(value), "curve value not finite");
    return this._push("curve", curve[curve.length - 1], t, { d });
  }
  cancelScheduledValues(t) {
    check(Number.isFinite(t), "cancelScheduledValues needs a time");
    this.events = this.events.filter((event) => event.t < t);
    return this;
  }
  get last() {
    return this.events[this.events.length - 1];
  }
}

class FakeNode {
  constructor(ctx, kind) {
    this.ctx = ctx;
    this.kind = kind;
    this.outputs = new Set();
    this.disconnected = false;
    ctx.nodes.push(this);
  }
  connect(dest) {
    if (!dest) throw new TypeError("connect without destination");
    if (dest.ctx && dest.ctx !== this.ctx) {
      crossContextErrors += 1;
      throw new Error("InvalidAccessError: cross-context connect");
    }
    this.outputs.add(dest);
    return dest;
  }
  disconnect() {
    this.outputs.clear();
    this.disconnected = true;
  }
}

class FakeSource extends FakeNode {
  start(t = 0, offset = 0) {
    if (this.started) throw new Error("InvalidStateError: start called twice");
    check(Number.isFinite(t) && t >= 0, `start: bad time ${t}`);
    this.started = true;
    this.startTime = t;
    this.offset = offset;
    this.ctx.starts.push({ node: this, t, at: this.ctx.currentTime });
  }
  stop(t = 0) {
    if (!this.started) throw new Error("InvalidStateError: stop before start");
    check(Number.isFinite(t) && t >= this.startTime, `stop: bad time ${t}`);
    this.stopTime = t;
  }
}

class RichContext {
  constructor() {
    created += 1;
    this.state = "suspended";
    this.currentTime = 0;
    this.sampleRate = 48000;
    this.nodes = [];
    this.starts = [];
    this.waves = [];
    this.resumeCalls = 0;
    this.blockResume = RichContext.blockResume;
    this.destination = new FakeNode(this, "destination");
    RichContext.instances.push(this);
  }
  resume() {
    this.resumeCalls += 1;
    if (this.blockResume) return Promise.reject(new Error("gesture rejected"));
    this.state = "running";
    return Promise.resolve();
  }
  createGain() {
    const node = new FakeNode(this, "gain");
    node.gain = new FakeParam(1);
    return node;
  }
  createOscillator() {
    const node = new FakeSource(this, "osc");
    node.frequency = new FakeParam(440);
    node.detune = new FakeParam(0);
    node.type = "sine";
    node.setPeriodicWave = (wave) => {
      if (wave.ctx !== this) throw new Error("PeriodicWave from another context");
      node.wave = wave;
    };
    return node;
  }
  createBufferSource() {
    const node = new FakeSource(this, "buffer");
    node.playbackRate = new FakeParam(1);
    node.buffer = null;
    node.loop = false;
    return node;
  }
  createBuffer(channels, length, sampleRate) {
    const data = new Float32Array(length);
    return { numberOfChannels: channels, length, sampleRate, duration: length / sampleRate, getChannelData: () => data };
  }
  createPeriodicWave(real, imag, options) {
    check(real.length === imag.length && real.length >= 2, "PeriodicWave arrays");
    const wave = { ctx: this, real, imag, options };
    this.waves.push(wave);
    return wave;
  }
  createDynamicsCompressor() {
    const node = new FakeNode(this, "compressor");
    for (const key of ["threshold", "knee", "ratio", "attack", "release"]) node[key] = new FakeParam(0);
    return node;
  }
  createDelay(max = 1) {
    const node = new FakeNode(this, "delay");
    node.delayTime = new FakeParam(0);
    node.maxDelay = max;
    return node;
  }
  createBiquadFilter() {
    const node = new FakeNode(this, "biquad");
    node.type = "lowpass";
    node.frequency = new FakeParam(350);
    node.Q = new FakeParam(1);
    node.gain = new FakeParam(0);
    return node;
  }
  createStereoPanner() {
    const node = new FakeNode(this, "panner");
    node.pan = new FakeParam(0);
    return node;
  }
}
RichContext.instances = [];
RichContext.blockResume = false;

function reaches(node, target) {
  const seen = new Set();
  const queue = [node];
  while (queue.length) {
    const current = queue.shift();
    if (current === target) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    for (const next of current.outputs) queue.push(next);
  }
  return false;
}

const musicStarts = (audio, entries) => entries.filter((entry) => reaches(entry.node, audio._graph.music));
const sfxStarts = (audio, entries) => entries.filter((entry) => reaches(entry.node, audio._graph.sfx));
const midiOf = (node) => Math.round(69 + 12 * Math.log2(node.frequency.events[0].v / 440));
const pulseWaves = (audio) => new Set([audio._graph.waves.p12, audio._graph.waves.p25, audio._graph.waves.p50]);

/** Advance the fake clock frame by frame, checking every new start lies in the lookahead window. */
function run(audio, ctx, seconds, frameDt = () => 1 / 60) {
  const end = ctx.currentTime + seconds;
  while (ctx.currentTime < end - EPS) {
    ctx.currentTime = Math.min(end, ctx.currentTime + frameDt());
    const before = ctx.starts.length;
    audio.update();
    for (const entry of ctx.starts.slice(before)) {
      assert.ok(entry.t <= ctx.currentTime + LOOKAHEAD + EPS, `start ${entry.t} beyond lookahead at ${ctx.currentTime}`);
      assert.ok(entry.t >= ctx.currentTime - 0.031, `start ${entry.t} in the past at ${ctx.currentTime}`);
    }
  }
}

const results = [];
function test(name, fn) {
  fn();
  results.push(name);
}

// ---------------------------------------------------------------------------

test("pattern data compiles, fits bars, stays in key/range and lands on chord tones", () => {
  const ranges = { lead: [57, 93], harm: [45, 88], bass: [28, 64] };
  for (const [id, track] of Object.entries(AUDIO_TRACKS)) {
    assert.deepEqual(track.errors, [], `${id} pattern errors`);
    assert.equal(track.totalSteps % 16, 0, `${id} is bar aligned`);
    if (track.loop) {
      assert.ok(track.bodySteps >= 16 * 16, `${id} loop is at least 16 bars`);
      const names = new Set(track.timeline.filter((part) => part.start >= track.introSteps).map((part) => part.name));
      assert.ok(names.size >= 2, `${id} loop has A/B sections`);
    }
    let strong = 0;
    let chordTones = 0;
    for (const part of track.timeline) {
      for (const [key, events] of Object.entries(part.channels)) {
        const base = key.split("@")[0];
        for (const [step, value, len] of events) {
          assert.ok(step + len <= part.steps, `${id}.${part.name}.${key} note overruns its section`);
          if (base === "drum") continue;
          const [lo, hi] = ranges[base];
          assert.ok(value >= lo && value <= hi, `${id}.${part.name}.${key} midi ${value} outside ${lo}-${hi}`);
          if (track.scale) assert.ok(track.scale.includes(value % 12), `${id}.${part.name}.${key} pitch ${value} off-scale`);
          if (base === "lead" && step % 8 === 0) {
            const chord = part.chords.find((c) => step >= c.step && step < c.step + c.len);
            if (!chord) continue;
            strong += 1;
            if (chord.pcs.includes(value % 12)) chordTones += 1;
          }
        }
      }
    }
    if (strong) assert.ok(chordTones / strong >= 0.9, `${id} strong beats on chord tones ${chordTones}/${strong}`);
  }
  assert.equal(AUDIO_TRACKS.victory.loop, false);
  assert.equal(AUDIO_TRACKS.defeat.loop, false);
});

test("API surface and SFX kind list", () => {
  const audio = new AudioManager(() => false);
  for (const method of ["unlock", "update", "beep", "playMusic", "stopMusic", "setMusicIntensity", "setMusicEnabled", "setVolumes"]) {
    assert.equal(typeof audio[method], "function", method);
  }
  assert.equal(audio.musicEnabled, true);
  assert.equal(audio.ctx, null);
  assert.equal(audio.unlocked, false);
  const required = [
    "move", "bad", "attack", "hit", "special", "win", "countdown", "select", "cancel", "deselect", "clash",
    "fight", "countTick", "shootSolar", "shootVoid", "meleeSolar", "meleeVoid", "heavyShot", "lance", "dash",
    "blink", "shield", "nova", "aura", "gravity", "heal", "barrier", "block", "ko", "victory", "defeat",
    "nodeCapture", "nodeLost", "fluxShift", "turnSolar", "turnVoid", "command", "warning", "overtime",
    "uiHover", "uiConfirm",
  ];
  for (const kind of required) assert.ok(SFX_KINDS.includes(kind), `missing SFX kind ${kind}`);
});

const muted = { value: false };
// Like platform-tests: the host installs window only after the module import.
globalThis.window = {};
window.AudioContext = RichContext;
const audio = new AudioManager(() => muted.value);

test("no context or graph before unlock", () => {
  audio.beep("hit");
  audio.beep("no-such-kind");
  audio.playMusic("board", { faction: "S" });
  audio.update();
  audio.setMusicIntensity(2);
  audio.setMusicIntensity(0);
  audio.setVolumes({ music: 1, sfx: 1 });
  audio.setMusicEnabled(true);
  audio.setMusicDuck(1);
  assert.equal(created, 0, "nothing may create an AudioContext before unlock()");
  assert.equal(audio.ctx, null);
  assert.equal(audio.currentTrack, "board", "the wanted track is remembered for later");
});

let ctx;
test("suspended context: unlock creates it, nothing is built or scheduled", () => {
  RichContext.blockResume = true;
  audio.unlock();
  ctx = audio.ctx;
  assert.equal(created, 1);
  assert.equal(ctx.state, "suspended");
  assert.equal(ctx.resumeCalls, 1);
  audio.update();
  audio.beep("hit");
  audio.beep("clash");
  audio.playMusic("board", { faction: "S" });
  ctx.currentTime = 1;
  audio.update();
  assert.equal(ctx.starts.length, 0, "nothing scheduled while suspended");
  assert.equal(ctx.nodes.length, 1, "no graph nodes while suspended (destination only)");
});

test("running: unknown kinds are a safe soft blip", () => {
  ctx.blockResume = false;
  RichContext.blockResume = false;
  audio.unlock();
  assert.equal(ctx.state, "running");
  audio.unlock();
  assert.equal(ctx.resumeCalls, 2, "no repeated resume while running");
  for (const kind of [undefined, null, 42, {}, "", "constructor", "__proto__", "toString", "_fallback", "zzz"]) {
    assert.doesNotThrow(() => audio.beep(kind, { faction: "Q", pan: "x", intensity: NaN, pitch: Infinity }));
    ctx.currentTime += 0.1;
  }
  const blips = sfxStarts(audio, ctx.starts);
  assert.ok(blips.length >= 1, "unknown kinds still give feedback");
  assert.ok(blips.length <= 10, "unknown kinds are rate limited soft blips");
  assert.equal(audio.playMusic("no-such-track"), false);
});

test("playMusic + update schedules only inside the lookahead window", () => {
  const before = ctx.starts.length;
  run(audio, ctx, 4);
  const notes = musicStarts(audio, ctx.starts.slice(before));
  assert.ok(notes.length > 30, `board music scheduled (${notes.length} sources in 4 s)`);
  const state = audio.getDebugState();
  assert.equal(state.track, "board");
  assert.equal(state.faction, "S");
});

test("frame jitter does not change what is scheduled", () => {
  const counts = [];
  for (const jitter of [false, true]) {
    let seed = 7;
    const random = () => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    };
    const fake = new RichContext();
    fake.state = "running";
    const local = new AudioManager(() => false);
    local.ctx = fake;
    local.unlocked = true;
    local.playMusic("duel");
    local.update();
    run(local, fake, 12, jitter ? () => 0.004 + random() * 0.06 : () => 1 / 60);
    counts.push(musicStarts(local, fake.starts).map((entry) => entry.t.toFixed(6)).sort().join(","));
  }
  assert.equal(counts[0], counts[1], "same notes at the same times regardless of frame timing");
});

test("same-track playMusic does not restart", () => {
  const player = audio._current;
  const step = player.step;
  audio.playMusic("board", { faction: "S" });
  audio.update();
  assert.equal(audio._current, player);
  assert.ok(player.step >= step);
  assert.equal(player.stopAt, null);
  assert.equal(audio._players.length, 1);
});

test("faction change re-voices the board without restarting", () => {
  const player = audio._current;
  const waves = pulseWaves(audio);
  // Collect one full loop of Solar first.
  let mark = ctx.starts.length;
  run(audio, ctx, AUDIO_TRACKS.board.bodySteps * AUDIO_TRACKS.board.stepDur);
  const solar = musicStarts(audio, ctx.starts.slice(mark)).filter((entry) => waves.has(entry.node.wave));
  assert.ok(solar.some((entry) => midiOf(entry.node) % 12 === 6), "Solar board uses F# (Mixolydian)");
  assert.ok(!solar.some((entry) => entry.node.wave === audio._graph.waves.p50), "Solar pulses are thin (no 50%)");

  const stepAtSwitch = player.step;
  audio.playMusic("board", { faction: "V" });
  assert.equal(audio._current, player, "same player");
  assert.equal(player.faction, "V");
  mark = ctx.starts.length;
  run(audio, ctx, AUDIO_TRACKS.board.bodySteps * AUDIO_TRACKS.board.stepDur);
  assert.ok(player.step > stepAtSwitch, "position continued");
  const dark = musicStarts(audio, ctx.starts.slice(mark)).filter((entry) => waves.has(entry.node.wave));
  assert.ok(dark.length > 100);
  const pcs = new Set(dark.map((entry) => midiOf(entry.node) % 12));
  assert.ok(!pcs.has(6) && !pcs.has(11), "Void board drops F#/B to F/Bb (Aeolian)");
  assert.ok(pcs.has(5) && pcs.has(10), "Void board uses F and Bb");
  assert.ok(dark.some((entry) => entry.node.wave === audio._graph.waves.p50), "Void lead is a hollow 50% pulse");
  assert.ok(!dark.some((entry) => entry.node.wave === audio._graph.waves.p12), "Void drops the 12.5% shimmer");

  audio.playMusic("board", { faction: "S" });
  audio.playMusic("board");
  assert.equal(player.faction, "S", "omitting faction keeps the last one");
  assert.equal(audio._players.length, 1);
});

test("mute ramps the master to ~0 and stops new music notes", () => {
  muted.value = true;
  audio.update();
  const master = audio._graph.master.gain;
  assert.equal(master.last.type, "target");
  assert.ok(master.last.v <= 0.001, "master ramps to silence");
  const step = audio._current.step;
  const mark = ctx.starts.length;
  audio.beep("hit");
  audio.beep("ko");
  run(audio, ctx, 2);
  assert.equal(ctx.starts.length - mark, 0, "nothing scheduled while muted");
  const expected = 2 / AUDIO_TRACKS.board.stepDur;
  assert.ok(Math.abs(audio._current.step - step - expected) <= 2, "position keeps tracking time while muted");

  muted.value = false;
  audio.update();
  assert.ok(master.last.v > 0.5, "master ramps back up");
  const after = ctx.starts.length;
  run(audio, ctx, 1);
  assert.ok(musicStarts(audio, ctx.starts.slice(after)).length > 5, "music resumes at the current position");
});

test("setMusicEnabled(false) stops music but SFX still play", () => {
  audio.setMusicEnabled(false);
  assert.equal(audio.musicEnabled, false);
  assert.ok(audio._graph.music.gain.last.v <= 0.001, "music bus ramps down");
  const mark = ctx.starts.length;
  run(audio, ctx, 2);
  assert.equal(musicStarts(audio, ctx.starts.slice(mark)).length, 0, "no music notes while disabled");
  const sfxMark = ctx.starts.length;
  audio.beep("shootSolar");
  assert.ok(sfxStarts(audio, ctx.starts.slice(sfxMark)).length > 0, "SFX unaffected");
  audio.setMusicEnabled(true);
  assert.ok(audio._graph.music.gain.last.v > 0.1);
  const again = ctx.starts.length;
  run(audio, ctx, 1);
  assert.ok(musicStarts(audio, ctx.starts.slice(again)).length > 0, "music returns");
});

test("volumes scale the buses; music sits well under SFX", () => {
  const musicLevel = audio._graph.music.gain.last.v;
  const sfxLevel = audio._graph.sfx.gain.last?.v ?? audio._graph.sfx.gain.value;
  const db = 20 * Math.log10(musicLevel / sfxLevel);
  assert.ok(db < -12 && db > -16, `music bus ${db.toFixed(1)} dB relative to SFX`);
  audio.setVolumes({ music: 0.5, sfx: 0.25 });
  assert.ok(Math.abs(audio._graph.music.gain.last.v - musicLevel * 0.5) < 1e-9);
  assert.ok(Math.abs(audio._graph.sfx.gain.last.v - sfxLevel * 0.25) < 1e-9);
  audio.setVolumes({ music: 7, sfx: -1 });
  assert.ok(Math.abs(audio._graph.sfx.gain.last.v) < 1e-9, "volumes clamp to 0..1");
  audio.setVolumes({ music: 1, sfx: 1 });
});

test("a long gap between updates skips ahead instead of bursting", () => {
  const player = audio._current;
  const step = player.step;
  ctx.currentTime += 12;
  const mark = ctx.starts.length;
  audio.update();
  const burst = ctx.starts.slice(mark);
  assert.ok(burst.length <= 24, `only the lookahead window is scheduled (${burst.length})`);
  for (const entry of burst) assert.ok(entry.t >= ctx.currentTime - EPS, "nothing scheduled in the past");
  const jumped = player.step - step;
  const expected = 12 / AUDIO_TRACKS.board.stepDur;
  assert.ok(Math.abs(jumped - expected) <= 3, `position jumped ${jumped} steps (~${expected.toFixed(0)})`);
});

test("track change crossfades and disposes the old track", () => {
  const old = audio._current;
  audio.playMusic("duel");
  assert.notEqual(audio._current, old);
  assert.ok(old.stopAt !== null, "old track is fading");
  assert.equal(old.out.gain.last.type, "linear");
  assert.equal(old.out.gain.last.v, 0);
  const fadeIn = audio._current.out.gain.last;
  assert.equal(fadeIn.type, "linear");
  assert.ok(fadeIn.t - ctx.currentTime >= 0.4 && fadeIn.t - ctx.currentTime <= 0.9, "~0.4-0.8 s crossfade");
  const stopAt = old.stopAt;
  run(audio, ctx, 2);
  assert.ok(!ctx.starts.some((entry) => entry.t >= stopAt && reaches(entry.node, old.out)), "old stops scheduling after the fade");
  assert.equal(audio._players.length, 1, "old player disposed");
  assert.ok(old.out.disconnected);
});

test("duel intensity layers add density without restarting", () => {
  const player = audio._current;
  const density = (level) => {
    audio.setMusicIntensity(level);
    const mark = ctx.starts.length;
    run(audio, ctx, AUDIO_TRACKS.duel.stepDur * 64);
    return musicStarts(audio, ctx.starts.slice(mark)).length;
  };
  const calm = density(0);
  const critical = density(2);
  assert.ok(critical > calm * 1.3, `intensity 2 is denser (${calm} -> ${critical})`);
  assert.equal(audio._current, player);
  audio.setMusicIntensity(9);
  assert.equal(audio._intensity, 2, "intensity clamps");
  audio.setMusicIntensity(0);
});

test("stingers play once and do not loop or restart", () => {
  for (const [id, faction] of [["victory", "S"], ["victory", "V"], ["defeat", "S"]]) {
    audio.playMusic("title");
    run(audio, ctx, 1);
    audio.playMusic(id, { faction });
    const player = audio._current;
    const begin = player.nextTime;
    const length = AUDIO_TRACKS[id].totalSteps * AUDIO_TRACKS[id].stepDur;
    const mark = ctx.starts.length;
    run(audio, ctx, length + 6);
    const own = ctx.starts.slice(mark).filter((entry) => reaches(entry.node, player.out));
    assert.ok(own.length > 10, `${id} played`);
    assert.ok(own.every((entry) => entry.t < begin + length + EPS), `${id} does not loop`);
    assert.ok(player.done);
    const pcs = new Set(own.filter((entry) => pulseWaves(audio).has(entry.node.wave)).map((entry) => midiOf(entry.node) % 12));
    if (id === "victory") assert.equal(pcs.has(6), faction === "S", `victory ${faction} colour`);
    audio.playMusic(id, { faction });
    const quiet = ctx.starts.length;
    run(audio, ctx, 3);
    assert.equal(audio._current, player, "same stinger is not restarted by repeated calls");
    assert.equal(ctx.starts.length, quiet, "silence after a finished stinger");
  }
  audio.playMusic("victory", { restart: true });
  const mark = ctx.starts.length;
  run(audio, ctx, 1);
  assert.ok(ctx.starts.length > mark, "restart:true replays a stinger on purpose");
});

test("stopMusic fades out and schedules nothing more", () => {
  audio.playMusic("title");
  run(audio, ctx, 2);
  const player = audio._current;
  audio.stopMusic(0.5);
  assert.equal(audio.currentTrack, null);
  const stopAt = player.stopAt;
  run(audio, ctx, 3);
  assert.ok(!ctx.starts.some((entry) => entry.t >= stopAt && reaches(entry.node, audio._graph.music)));
  assert.equal(audio._players.length, 0);
});

test("every SFX kind schedules safely with every option shape", () => {
  const optionSets = [{}, { faction: "S" }, { faction: "V", intensity: 1, pan: -0.8 }, { intensity: 0, pan: 1, pitch: -5, volume: 2 }];
  for (const kind of SFX_KINDS) {
    for (const opts of optionSets) {
      ctx.currentTime += 1;
      audio.update();
      const mark = ctx.starts.length;
      assert.doesNotThrow(() => audio.beep(kind, opts));
      assert.ok(sfxStarts(audio, ctx.starts.slice(mark)).length >= 1, `${kind} ${JSON.stringify(opts)} made sound`);
    }
  }
  assert.ok(ctx.nodes.some((node) => node.kind === "panner"), "pan uses a StereoPanner when available");
  for (const alias of ["repair", "pull", "spread", "explode", "capture"]) {
    ctx.currentTime += 1;
    const mark = ctx.starts.length;
    audio.beep(alias);
    assert.ok(ctx.starts.length > mark, `alias ${alias}`);
  }
});

test("frequent kinds are rate limited; simultaneous voices are capped", () => {
  ctx.currentTime += 2;
  audio.update();
  let mark = ctx.starts.length;
  for (let i = 0; i < 10; i += 1) audio.beep("hit", { intensity: 1 });
  const single = ctx.starts.length - mark;
  assert.ok(single > 0 && single <= 2, `hit stacked ${single} sources`);
  ctx.currentTime += 0.06;
  mark = ctx.starts.length;
  audio.beep("hit");
  assert.ok(ctx.starts.length > mark, "hit allowed again after its gap");
  for (let i = 0; i < 20; i += 1) audio.beep("uiHover");
  ctx.currentTime += 3;
  audio.update();
  for (const kind of SFX_KINDS) audio.beep(kind);
  assert.ok(audio.getDebugState().voices.sfx <= 20, `sfx voices capped (${audio.getDebugState().voices.sfx})`);
  assert.ok(audio.stats.droppedVoices > 0, "excess voices were dropped, not stacked");
});

test("finished sources disconnect; failures inside the graph never throw", () => {
  for (const { node } of ctx.starts) assert.doesNotThrow(() => node.onended && node.onended());
  assert.ok(ctx.starts.every(({ node }) => node.disconnected), "every source disconnects on end");
  const original = ctx.createOscillator;
  ctx.createOscillator = () => {
    throw new Error("boom");
  };
  ctx.currentTime += 1;
  assert.doesNotThrow(() => audio.beep("ko"));
  audio.playMusic("duel");
  assert.doesNotThrow(() => run(audio, ctx, 1));
  ctx.createOscillator = original;
  const throwingMute = new AudioManager(() => {
    throw new Error("bad getter");
  });
  throwingMute.ctx = ctx;
  throwingMute.unlocked = true;
  assert.doesNotThrow(() => {
    throwingMute.update();
    throwingMute.beep("hit");
  });
  assert.equal(apiErrors, 0, "no invalid Web Audio calls (bad ramps/times/values)");
});

test("closed context is recreated and the graph rebuilt on the new one", () => {
  audio.playMusic("board", { faction: "V" });
  run(audio, ctx, 1);
  ctx.state = "closed";
  assert.doesNotThrow(() => audio.update());
  audio.unlock();
  const fresh = audio.ctx;
  assert.notEqual(fresh, ctx);
  assert.equal(fresh.state, "running");
  run(audio, fresh, 2);
  assert.ok(musicStarts(audio, fresh.starts).length > 0, "music continues on the new context");
  assert.equal(audio._current.faction, "V", "faction survives the rebuild");
  assert.equal(crossContextErrors, 0, "no node crosses contexts");
});

test("mute before unlock: graph starts silent", () => {
  const local = new AudioManager(() => true);
  window.AudioContext = RichContext;
  local.unlock();
  local.update();
  assert.equal(local._graph.master.gain.value, 0);
  local.beep("hit");
  assert.equal(local.ctx.starts.length, 0);
});

test("minimal platform-tests fake (state + resume only) never throws", () => {
  let minimalCreated = 0;
  window.AudioContext = class {
    constructor() {
      minimalCreated += 1;
      this.state = "suspended";
    }
    resume() {
      this.state = "running";
      return Promise.resolve();
    }
  };
  const minimal = new AudioManager(() => false);
  assert.doesNotThrow(() => {
    minimal.beep("move");
    minimal.playMusic("title");
    minimal.update();
    minimal.unlock();
    for (const kind of [...SFX_KINDS, "nope", undefined]) minimal.beep(kind, { faction: "V", pan: 0.5 });
    for (const id of Object.keys(AUDIO_TRACKS)) minimal.playMusic(id, { faction: "V", intensity: 2 });
    for (let i = 0; i < 30; i += 1) minimal.update();
    minimal.setMusicIntensity(1);
    minimal.setMusicEnabled(false);
    minimal.setMusicEnabled(true);
    minimal.setVolumes({ music: 0.3, sfx: 0.9 });
    minimal.setMusicDuck(0.5);
    minimal.stopMusic(0.3);
    minimal.getDebugState();
    minimal.unlock();
  });
  assert.equal(minimalCreated, 1);
  assert.equal(minimal.getDebugState().ready, false);
  window.AudioContext = undefined;
  const none = new AudioManager(() => false);
  assert.doesNotThrow(() => {
    none.unlock();
    none.update();
    none.beep("hit");
    none.playMusic("duel");
  });
});

test("no timers or animation loops of its own", () => {
  assert.deepEqual(timerCalls, { setTimeout: 0, setInterval: 0, requestAnimationFrame: 0 });
});

console.log(`audio-tests: ok (${results.length} groups)`);
for (const name of results) console.log(`- ${name}`);
