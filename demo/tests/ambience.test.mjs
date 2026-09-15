// Unit tests for the persona ambience player (demo/ui/ambience.js) against a
// fake Web Audio context, run with node --test.
import { test } from "node:test";
import assert from "node:assert/strict";

class FakeParam {
  constructor(v) { this.value = v; }
  setValueAtTime(v) { this.value = v; }
  exponentialRampToValueAtTime(v) { this.value = v; }
  setTargetAtTime(v) { this.value = v; }
  cancelScheduledValues() {}
}
class FakeNode {
  constructor(ctx) { this.ctx = ctx; this.gain = new FakeParam(1); this.stopped = false; }
  connect(n) { return n; }
  disconnect() {}
  start() { this.ctx.started.push(this); }
  stop(at) { if (at === undefined || at <= this.ctx.currentTime) this.stopped = true; else this.stopAt = at; }
}
class FakeContext {
  constructor() { this.currentTime = 0; this.state = "running"; this.destination = {}; this.started = []; FakeContext.instances.push(this); }
  createGain() { return new FakeNode(this); }
  createBufferSource() { return new FakeNode(this); }
  createAnalyser() { const n = new FakeNode(this); n.getByteTimeDomainData = (b) => b.fill(128); return n; }
  async decodeAudioData() { await new Promise((r) => setTimeout(r, 5)); return { duration: 120 }; }
  async close() { this.state = "closed"; }
  async resume() { this.state = "running"; }
}
FakeContext.instances = [];

const unref = (t) => { t.unref?.(); return t; };
globalThis.window = { AudioContext: FakeContext, setTimeout: (fn, ms) => unref(setTimeout(fn, ms)), clearTimeout };
globalThis.fetch = async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) });
const { Ambience } = await import("../ui/ambience.js");

const MANIFEST = { witch: { bed: "sfx/witch/bed.mp3", sounds: { purr: "sfx/witch/purr.wav" } }, samantha: { bed: null, sounds: {} } };
const settle = () => new Promise((r) => setTimeout(r, 20));
/** Sources still sounding: started and not stopped. */
const sounding = (ctx) => ctx.started.filter((s) => !s.stopped).length;

test("a persona without a bed plays nothing; a switch away stops the bed", async () => {
  const a = new Ambience();
  a.setManifest(MANIFEST);
  a.start("samantha");
  await settle();
  assert.equal(a.isPlaying(), false);
  assert.equal(a.expectsBed(), false);
  a.setPersona("witch");
  assert.equal(a.expectsBed(), true);
  await settle();
  assert.equal(a.isPlaying(), true);
  assert.equal(a.bedPersona(), "witch");
  a.setPersona("samantha");
  assert.equal(a.isPlaying(), false);
  assert.equal(a.bedPersona(), "");
  assert.equal(a.persona(), "samantha");
});

test("a bed whose load finishes after a switch never starts", async () => {
  const a = new Ambience();
  a.setManifest(MANIFEST);
  a.start("witch");
  a.setPersona("samantha"); // before the decode resolves
  await settle();
  assert.equal(a.isPlaying(), false);
  assert.equal(sounding(FakeContext.instances.at(-1)), 0);
});

test("re-selecting the same persona while its bed loads yields one bed, not a leaked second one", async () => {
  const a = new Ambience();
  a.setManifest(MANIFEST);
  a.start("witch");
  a.setEnabled(true); // forces setPersona(witch, true) while the first load is pending
  await settle();
  assert.equal(a.isPlaying(), true);
  const ctx = FakeContext.instances.at(-1);
  assert.equal(sounding(ctx), 1, "one looping source");
  a.setPersona("samantha");
  await new Promise((r) => setTimeout(r, 1800)); // past the 1.6 s fade-out
  assert.equal(sounding(ctx), 0, "nothing keeps looping after the switch");
});

test("disabling stops the bed and enabling brings it back", async () => {
  const a = new Ambience();
  a.setManifest(MANIFEST);
  a.start("witch");
  await settle();
  a.setEnabled(false);
  assert.equal(a.isPlaying(), false);
  assert.equal(a.expectsBed(), false);
  a.setEnabled(true);
  await settle();
  assert.equal(a.isPlaying(), true);
});
