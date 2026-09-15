// Persona ambience: a quiet looping bed per persona, ducked while the assistant
// speaks, plus one-shots the persona can cue. Files come from /api/sfx (see
// demo/sfx/README.md); nothing here runs unless that manifest has entries.

const BED_GAIN = 0.16;      // bed level at rest, relative to full scale
const DUCK_GAIN = 0.35;     // multiplier while the assistant is audible
const DUCK_RELEASE_MS = 1200; // quiet this long before the bed comes back up
const XFADE_S = 1.6;        // crossfade at persona changes and loop seams
const ONESHOT_GAIN = 0.7;

/** @typedef {{ bed: string | null, sounds: Record<string, string> }} PersonaSfx */

export class Ambience {
  constructor() {
    /** @type {AudioContext | null} */
    this._ctx = null;
    /** @type {GainNode | null} */
    this._master = null;
    /** @type {Record<string, PersonaSfx>} */
    this._manifest = {};
    /** @type {Map<string, Promise<AudioBuffer | null>>} */
    this._buffers = new Map();
    /** @type {{ persona: string, gain: GainNode, stop: () => void } | null} */
    this._bed = null;
    this._enabled = true;
    this._volume = 1;
    this._ducked = false;
    this._duckTimer = 0;
    this._persona = "";
    /** @type {AnalyserNode | null} */
    this._analyser = null;
    this._levelBuf = new Uint8Array(1024);
  }

  /** Whether a bed is playing right now. */
  isPlaying() { return !!this._bed; }

  /** The persona whose bed is playing, or "" when none is. */
  bedPersona() { return this._bed?.persona ?? ""; }

  /** Whether the bed is currently ducked under the assistant's voice. */
  isDucked() { return this._ducked; }

  /** Whether a bed should be playing (enabled, and the current persona has one), even if still loading. */
  expectsBed() { return this._enabled && !!this._manifest[this._persona]?.bed; }

  /** The bed's current loudness, 0..1 (post-duck, pre-master), for a meter. */
  level() {
    if (!this._analyser || !this._bed) return 0;
    const buf = this._levelBuf;
    this._analyser.getByteTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) { const v = (buf[i] - 128) / 128; sum += v * v; }
    return Math.sqrt(sum / buf.length);
  }

  /** @param {Record<string, PersonaSfx>} manifest */
  setManifest(manifest) { this._manifest = manifest || {}; }

  /** Sound names the given persona can cue. @param {string} persona */
  soundsFor(persona) { return Object.keys(this._manifest[persona]?.sounds ?? {}); }

  hasAnything() { return Object.keys(this._manifest).length > 0; }

  /** @param {boolean} on */
  setEnabled(on) {
    this._enabled = on;
    if (!on) this._stopBed();
    else if (this._persona) this.setPersona(this._persona, true);
  }

  /** @param {number} v 0..1 */
  setVolume(v) {
    this._volume = Math.max(0, Math.min(1, v));
    if (this._master && this._ctx) this._master.gain.setTargetAtTime(this._volume, this._ctx.currentTime, 0.05);
  }

  /** Start (needs a user gesture to have happened) and play the persona's bed. @param {string} persona */
  start(persona) {
    this._ensureContext();
    this.setPersona(persona, true);
  }

  stop() {
    this._stopBed();
    this._persona = "";
    if (this._ctx) { void this._ctx.close().catch(() => {}); this._ctx = null; this._master = null; this._analyser = null; }
  }

  /** Crossfade to another persona's bed (or silence). @param {string} persona @param {boolean} [force] */
  setPersona(persona, force = false) {
    if (persona === this._persona && !force) return;
    this._persona = persona;
    if (!this._enabled || !this._ctx || !this._master) return;
    const url = this._manifest[persona]?.bed;
    this._stopBed();
    if (!url) return;
    const ctx = this._ctx;
    const master = this._master;
    void this._load(url).then((buffer) => {
      if (!buffer || this._persona !== persona || !this._enabled || this._ctx !== ctx) return;
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0.0001, ctx.currentTime);
      gain.connect(this._analyser ?? master); // the analyser feeds the master (wired in _ensureContext)
      let stopped = false;
      /** @type {AudioBufferSourceNode[]} */
      const sources = [];
      // Seamless loop: overlapping copies with a crossfade at the seam, so an
      // mp3's encoder padding never clicks.
      const schedule = (at) => {
        if (stopped) return;
        const src = ctx.createBufferSource();
        src.buffer = buffer;
        const seg = ctx.createGain();
        seg.gain.setValueAtTime(0.0001, at);
        seg.gain.exponentialRampToValueAtTime(1, at + XFADE_S);
        const end = at + buffer.duration;
        seg.gain.setValueAtTime(1, end - XFADE_S);
        seg.gain.exponentialRampToValueAtTime(0.0001, end);
        src.connect(seg).connect(gain);
        src.start(at);
        src.stop(end + 0.05);
        sources.push(src);
        src.onended = () => { const i = sources.indexOf(src); if (i >= 0) sources.splice(i, 1); };
        window.setTimeout(() => schedule(end - XFADE_S), Math.max(0, (end - XFADE_S - ctx.currentTime) * 1000 - 200));
      };
      schedule(ctx.currentTime + 0.05);
      gain.gain.exponentialRampToValueAtTime(this._restLevel(), ctx.currentTime + XFADE_S);
      this._bed = {
        persona,
        gain,
        stop: () => {
          stopped = true;
          const t = ctx.currentTime;
          gain.gain.cancelScheduledValues(t);
          gain.gain.setValueAtTime(Math.max(gain.gain.value, 0.0001), t);
          gain.gain.exponentialRampToValueAtTime(0.0001, t + XFADE_S);
          window.setTimeout(() => { for (const s of sources) { try { s.stop(); } catch { /* done */ } } gain.disconnect(); }, XFADE_S * 1000 + 100);
        },
      };
    });
  }

  /** The assistant's voice is audible (or not): duck the bed under it. @param {boolean} audible */
  setSpeaking(audible) {
    if (!this._ctx || !this._bed) return;
    if (audible) {
      if (this._duckTimer) { window.clearTimeout(this._duckTimer); this._duckTimer = 0; }
      if (!this._ducked) { this._ducked = true; this._bed.gain.gain.setTargetAtTime(this._restLevel(), this._ctx.currentTime, 0.08); }
      return;
    }
    if (this._ducked && !this._duckTimer) {
      this._duckTimer = window.setTimeout(() => {
        this._duckTimer = 0;
        this._ducked = false;
        if (this._ctx && this._bed) this._bed.gain.gain.setTargetAtTime(this._restLevel(), this._ctx.currentTime, 0.4);
      }, DUCK_RELEASE_MS);
    }
  }

  /** Cue a one-shot for the current persona by name. Resolves to whether it played. @param {string} name */
  async play(name) {
    const url = this._manifest[this._persona]?.sounds?.[String(name).trim().toLowerCase()];
    if (!url || !this._enabled) return false;
    this._ensureContext();
    const ctx = this._ctx;
    const master = this._master;
    if (!ctx || !master) return false;
    const buffer = await this._load(url);
    if (!buffer) return false;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    const g = ctx.createGain();
    g.gain.value = ONESHOT_GAIN;
    src.connect(g).connect(master);
    src.start();
    return true;
  }

  _restLevel() { return BED_GAIN * (this._ducked ? DUCK_GAIN : 1); }

  _stopBed() {
    if (this._bed) { this._bed.stop(); this._bed = null; }
    this._ducked = false;
    if (this._duckTimer) { window.clearTimeout(this._duckTimer); this._duckTimer = 0; }
  }

  _ensureContext() {
    if (this._ctx) { if (this._ctx.state === "suspended") void this._ctx.resume(); return; }
    const Ctor = /** @type {any} */ (window).AudioContext || /** @type {any} */ (window).webkitAudioContext;
    if (!Ctor) return;
    this._ctx = new Ctor();
    this._master = this._ctx.createGain();
    this._master.gain.value = this._volume;
    this._master.connect(this._ctx.destination);
    this._analyser = this._ctx.createAnalyser();
    this._analyser.fftSize = 1024;
    this._analyser.smoothingTimeConstant = 0.6;
    this._analyser.connect(this._master);
  }

  /** @param {string} url */
  _load(url) {
    let p = this._buffers.get(url);
    if (!p) {
      p = (async () => {
        try {
          const res = await fetch(url);
          if (!res.ok) return null;
          const data = await res.arrayBuffer();
          if (!this._ctx) return null;
          return await this._ctx.decodeAudioData(data);
        } catch (err) {
          console.warn("[ambience] could not load", url, err);
          return null;
        }
      })();
      this._buffers.set(url, p);
    }
    return p;
  }
}
