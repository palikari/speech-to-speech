// Unit test for the page's persona phrase detector (main.js), run with node --test.
// It extracts the regexes and alias table from main.js so the test never drifts
// from the shipped code. Model-inferred nicknames ("the old salt") are out of
// scope here: see scripts/probe_persona_intent.py.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "main.js"), "utf8");
const grab = (name) => {
  const m = src.match(new RegExp(`const ${name} =\\s*([\\s\\S]*?);\\n`));
  if (!m) throw new Error(`${name} not found in main.js`);
  return eval(m[1]);
};
const REQUEST_RE = grab("PERSONA_REQUEST_RE");
const ADDRESS_RE = grab("PERSONA_ADDRESS_RE");
// aliases: [ ... ] lines inside PERSONAS, keyed by the persona id two lines above
const aliases = {};
for (const m of src.matchAll(/  (\w+): \{\n(?:.*\n){0,3}?\s+aliases: (\[[^\]]*\]),/g)) aliases[m[1]] = eval(m[2]);

const resolve = (q) => {
  q = String(q || "").trim().toLowerCase();
  if (aliases[q]) return q;
  for (const [id, as] of Object.entries(aliases)) {
    if (as.some((a) => q === a || new RegExp(`(?:^|\\W)${a}(?:$|\\W)`).test(q))) return id;
  }
  return null;
};
const requested = (t) => {
  const m = REQUEST_RE.exec(t);
  if (m) { const id = resolve(m[1]); if (id) return id; }
  const a = ADDRESS_RE.exec(t);
  if (a) { const id = resolve(a[1]); if (id) return id; }
  return null;
};

test("alias table covers all five personas", () => {
  assert.deepEqual(Object.keys(aliases).sort(), ["assistant", "captain", "robot", "villain", "witch"]);
});

test("requests by name or role switch", () => {
  const cases = [
    ["I want to speak to Esmerelda please.", "witch"],
    ["Switch to the professor.", "villain"],
    ["Can I talk to Barnaby?", "captain"],
    ["Get me the robot.", "robot"],
    ["Let me talk to Unit Seven.", "robot"],
    ["Put me through to that utter madman.", "villain"],
    ["I'd like a word with the sorceress.", "witch"],
    ["Bring back Bob.", "assistant"],
  ];
  for (const [text, want] of cases) assert.equal(requested(text), want, text);
});

test("a leading address switches", () => {
  assert.equal(requested("Esmerelda, what is brewing tonight?"), "witch");
  assert.equal(requested("Hey Bob, what time is it?"), "assistant");
  assert.equal(requested("Captain, are you still there?"), "captain");
});

test("ordinary sentences do not switch", () => {
  const cases = [
    "The professor said the bridge is out.",
    "I bought a new robot vacuum.",
    "Tell me about bobsled racing.",
    "Who am I speaking with?",
    "Can I speak with the old salt?", // a nickname: left to the model
  ];
  for (const text of cases) assert.equal(requested(text), null, text);
});
