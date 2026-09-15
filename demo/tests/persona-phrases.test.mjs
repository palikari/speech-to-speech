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
const COMMIT_RE = grab("PERSONA_COMMIT_RE");
const OFFER_RE = grab("PERSONA_OFFER_RE");
const AFFIRM_RE = grab("AFFIRM_RE");
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

test("alias table covers all six personas", () => {
  assert.deepEqual(Object.keys(aliases).sort(), ["assistant", "captain", "robot", "samantha", "villain", "witch"]);
});

test("requests by name or role switch", () => {
  const cases = [
    ["I want to speak to Esmerelda please.", "witch"],
    ["Switch to the professor.", "villain"],
    ["Can I talk to Barnaby?", "captain"],
    ["Get me the robot.", "robot"],
    ["Can I speak to Sam?", "samantha"],
    ["Let me talk to Samantha, please.", "samantha"],
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
    "It's the same thing every time.",
    "Tell me about bobsled racing.",
    "Who am I speaking with?",
    "Can I speak with the old salt?", // a nickname: left to the model
  ];
  for (const text of cases) assert.equal(requested(text), null, text);
});

const promised = (t) => {
  const named = Object.entries(aliases).filter(([, as]) => as.some((a) => new RegExp(`(?:^|\\W)${a}(?:$|\\W)`, "i").test(t)));
  if (named.length !== 1) return null;
  if (OFFER_RE.test(t)) return { id: named[0][0], offer: true };
  if (COMMIT_RE.test(t)) return { id: named[0][0], offer: false };
  return null;
};

test("a reply that promises a hand-off names the persona", () => {
  assert.deepEqual(promised("Shall I fetch Captain Barnaby for you?"), { id: "captain", offer: true });
  assert.deepEqual(promised("Would you like me to switch you to Unit Seven?"), { id: "robot", offer: true });
  // a statement of intent counts as a commitment, not an offer
  assert.deepEqual(promised("I can switch you over to Captain Barnaby right now."), { id: "captain", offer: false });
  assert.deepEqual(promised("Very well, I shall fetch Esmerelda for you."), { id: "witch", offer: false });
  assert.deepEqual(promised("Understood. Transferring you to Professor Karloff."), { id: "villain", offer: false });
  assert.deepEqual(promised("(chuckle) Very well, the witch awaits."), { id: "witch", offer: false });
});

test("mere mentions are not promises", () => {
  assert.equal(promised("Barnaby would love this weather."), null);
  assert.equal(promised("Esmerelda and Barnaby are both busy, dearie."), null); // ambiguous
  assert.equal(promised("I am Unit Seven, ready to help."), null);
});

test("affirmations", () => {
  for (const t of ["Okay.", "Yes please.", "That's correct.", "Sure, go ahead.", "Do it."]) assert.ok(AFFIRM_RE.test(t), t);
  for (const t of ["No thanks.", "What's the weather?", "Not right now."]) assert.ok(!AFFIRM_RE.test(t), t);
});
