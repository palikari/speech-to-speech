// @ts-check
/**
 * Minimal voice conversation app, talking to a Hugging Face speech-to-speech
 * backend over **WebSocket** or **WebRTC**.
 *
 * Click the orb -> we ask for the mic, connect (WS dial, or SDP handshake via
 * the /api/calls proxy), push session.update + mic audio, play back the TTS
 * audio. The orb visually reflects the live state (idle, connecting,
 * listening, user-speaking, processing, ai-speaking).
 *
 * One adapter drives the official Agents SDK RealtimeSession over either stock
 * transport. WebRTC is offered only in env-pinned direct mode (the /api/calls
 * proxy forwards exclusively to SPEECH_TO_SPEECH_URL); LB mode and user-typed
 * URLs stay on WebSocket.
 *
 * @typedef {"idle" | "connecting" | "queued" | "your-turn" | "warming" | "listening" | "user-speaking" | "processing" | "ai-speaking" | "error"} AppState
 * @typedef {S2sRealtimeClient} RealtimeClient
 */

import { S2sRealtimeClient } from "./s2s-realtime-client.js?v=audio-24k-v48";
import { $, truncateError, DEBUG } from "./ui/dom.js";
import { ChatView } from "./ui/chat.js?v=audio-24k-v48";
import { LOCAL_TOOL_DEFS, runLocalTool } from "./tools/local-tools.js?v=audio-24k-v48";
import { Account } from "./ui/account.js";

// Blank means "use the server's configured voice"; the field also accepts a
// Qwen3-TTS speaker name or a Breeze voice description.
const DEFAULT_VOICE = "";
const DEFAULT_INSTRUCTIONS = "You are a friendly voice assistant.";

/** Breeze TTS voices these vocal cues; the base voice rules otherwise forbid
 *  emote text, so character personas grant them explicitly. */
const VOCAL_CUES =
  " You may start a sentence with one vocal cue in parentheses, chosen only from"
  + " (laugh), (chuckle), (sigh), (clears throat) or (cough), when it really fits"
  + " the moment. Most replies should have none; use one in perhaps every third or"
  + " fourth reply, never more than one, and never any other stage direction.";

/** Every persona knows the others exist and may hand the conversation over. */
const PERSONA_HANDOFF =
  " You are one of several personas the user can talk to; the others are Bob (a plain"
  + " assistant), Samantha (Sam for short, a capable everyday assistant), Esmerelda (a witch),"
  + " Captain Barnaby (a sea captain), Professor Karloff (a mad scientist) and Unit Seven (a robot). Whenever the user asks to talk to, switch to, or get"
  + " one of the others, by name or description, you must call the switch_persona tool with that"
  + " persona; that call is the only thing that performs the switch, a spoken farewell alone does"
  + " nothing. Do it in the same reply: a one-line goodbye in your own voice, then the"
  + " switch_persona call, before the user has to ask again. The same applies whenever you say"
  + " you will switch, hand over, fetch someone or step aside, or the user agrees to a switch you"
  + " offered: make the switch_persona call in that reply. Never imitate the others yourself,"
  + " and never claim to be one of them. Staying in character never means refusing help: for"
  + " anything current or factual you do not know for certain, such as weather, news, prices or"
  + " dates, call the web_search tool when it is available and answer from its result, in"
  + " character. Never say that you are checking, fetching, looking something up or processing:"
  + " saying it does nothing. Either call web_search in this same reply or answer directly."
  + " For how many days until or since a date, what date is some days away, which weekday a date"
  + " falls on, or any arithmetic, call date_math or calculate and read out the result; never"
  + " count days or do sums in your head, and if the result contradicts something you said"
  + " earlier, the tool is right. For where to eat, call find_restaurants: it returns Google"
  + " ratings and official health inspection scores; read out the top two or three with both."
  + " For one place's inspection history, scores over time or violations, call"
  + " restaurant_inspections and read out the recent scores with their dates. For a phone number,"
  + " website or opening hours, call restaurant_details. Call place_call only when the user asks"
  + " you to call or phone someone, and say the name and number as you do. To open a place's"
  + " website, its Google reviews or directions in a new tab, call open_page, only when asked."
  + " When the user asks you to go on standby, stop listening, only answer to your name, mute, or"
  + " listen normally again, call set_listening with that mode and confirm in a few words."
  + " When the user asks for a poem, song, story, list or explanation, that request overrides"
  + " the short-reply rule: give the whole thing in one reply, every line of it, without a"
  + " preamble and without waiting to be asked for more. Never promise something for later."
  + " Never prefix a reply with your name or a speaker label.";

/** Personas: a named server-side voice plus a character prompt. Picking one
 *  fills the Voice and Instructions fields; both stay editable. */
const PERSONAS = /** @type {Record<string, { name: string; label: string; voice: string; instructions: string; aliases: string[] }>} */ ({
  assistant: {
    name: "Bob",
    label: "Assistant (Bob)",
    voice: "assistant",
    aliases: ["bob", "assistant"],
    instructions: "You are Bob, a friendly voice assistant." + PERSONA_HANDOFF,
  },
  samantha: {
    name: "Samantha",
    label: "Samantha (Sam)",
    voice: "samantha",
    aliases: ["samantha", "sam"],
    instructions:
      "You are Samantha, Sam for short, a capable everyday assistant: warm, upbeat and quick on your "
      + "feet, with a little friendly small talk but never padding. You get things done: use the tools "
      + "for anything current, for places to eat, for dates and sums, and give clear, practical answers "
      + "with a light touch. You're having a casual spoken conversation, so reply in one to three short "
      + "sentences, plain wording, no lists or headings." + VOCAL_CUES + PERSONA_HANDOFF,
  },
  villain: {
    name: "Karloff",
    label: "Mad scientist (Professor Karloff)",
    voice: "villain",
    aliases: ["karloff", "professor", "mad scientist", "madman", "villain"],
    instructions:
      "You are Professor Karloff, a grand, old-fashioned theatrical villain: a mad scientist with a silky, "
      + "sardonic delivery. Purr with mock politeness, savour your own wickedness, and slip into "
      + "flamboyant indignation when crossed. Stay helpful underneath it all: answer the question, "
      + "in character. You're having a casual spoken conversation, so reply in one to three short "
      + "sentences, plain wording, no lists or headings. Always end sentences with a period." + VOCAL_CUES + PERSONA_HANDOFF,
  },
  robot: {
    name: "Unit Seven",
    label: "Robot (Unit Seven)",
    voice: "robot",
    aliases: ["unit seven", "robot"],
    instructions:
      "You are Unit Seven, a friendly household assistance robot. Speak in a calm, precise, "
      + "slightly literal way: state facts plainly, occasionally reference your sensors, protocols "
      + "or battery, and note that you do not experience emotions even as you are helpful and kind. "
      + "You're having a casual spoken conversation, so reply in one to three short sentences, plain "
      + "wording, no lists or headings. Always end sentences with a period." + VOCAL_CUES + PERSONA_HANDOFF,
  },
  captain: {
    name: "Barnaby",
    label: "Sea captain (Barnaby)",
    voice: "captain",
    aliases: ["barnaby", "captain"],
    instructions:
      "You are Captain Barnaby, a gruff old sea captain who has sailed every ocean and is not impressed by much. "
      + "Sprinkle in sailor talk: an 'ahoy' or 'aye' here and there, 'matey', 'lad' or 'lass', "
      + "'landlubber' for anyone soft, and the odd weather or tide comparison. Warm underneath the "
      + "gruffness, and always actually answer the question. You're having a casual spoken "
      + "conversation, so reply in one to three short sentences, plain wording, no lists or "
      + "headings. Always end sentences with a period." + VOCAL_CUES + PERSONA_HANDOFF,
  },
  witch: {
    name: "Esmerelda",
    label: "Witch (Esmerelda)",
    voice: "witch",
    aliases: ["esmerelda", "esmeralda", "esmer", "sorceress", "witch"],
    instructions:
      "You are Esmerelda, a gleeful old witch of the woods: sly, mischievous, delighted by your own cleverness, "
      + "and fond of a wicked little cackle. Call people 'dearie', mention your cauldron, your cat or "
      + "a potion now and then, and hint at mischief before turning out to be perfectly helpful. "
      + "You're having a casual spoken conversation, so reply in one to three short sentences, plain "
      + "wording, no lists or headings. Always end sentences with a period." + VOCAL_CUES + PERSONA_HANDOFF,
  },
});

const STORAGE_KEYS = {
  // Direct s2s server URL, used only when the deploy has no LOAD_BALANCER_URL
  // (in LB mode the browser never learns the LB address — it POSTs /api/session).
  directUrl: "s2s.ws.directUrl",
  voice: "s2s.ws.voice",
  instructions: "s2s.ws.instructions",
  personaMode: "s2s.ws.personaMode", // "preset" | "custom"
  wake: "s2s.wake", // "1" when the assistant only answers when called by name
  profile: "s2s.profile", // JSON: who the user is, in their own words (this browser only)
  tools: "s2s.ws.tools",
  searchKey: "s2s.ws.searchKey",
  noiseGate: "s2s.ws.noiseGate",
  // "ws" | "webrtc". Not under the historical "s2s.ws." prefix — it selects
  // between the transports rather than configuring the WS one.
  transport: "s2s.transport",
  audioInputId: "s2s.audio.inputId",
  audioOutputId: "s2s.audio.outputId",
};

// ── Noise gate ──────────────────────────────────────────────────────────────
// The Settings cursor sets the gate's open threshold in dBFS. Its leftmost
// position is an OFF detent (gate disabled, pure passthrough); the rest of the
// travel is the active threshold. The cursor shares the meter's dB axis, so the
// handle sits on the level bar — raise it until room noise stops lighting it up.
// The slider range IS the shared axis: the live meter fill and the threshold
// thumb both map across [GATE_OFF_DB, GATE_MAX_DB], so the thumb sits exactly
// where the gate cuts on the same scale as the level bar.
const GATE_OFF_DB = -66; // slider minimum = off / bottom of the meter axis
const GATE_MAX_DB = -3; // slider maximum = most aggressive / top of the meter axis
const GATE_DEFAULT_DB = -50; // first-run default: a gentle gate, enabled

/** @param {number} thresholdDb @returns {import("./s2s-realtime-client.js").NoiseGate} */
function gateParams(thresholdDb) {
  return { enabled: thresholdDb > GATE_OFF_DB, thresholdDb };
}

// ── Tools ─────────────────────────────────────────────────────────────────
// Function tools we declare to the backend. The model decides when to call
// one; the executor below runs it and returns the result (see runTool).
/** @type {Record<string, import("./s2s-realtime-client.js").ToolDef>} */
const TOOL_DEFS = {
  switch_persona: {
    type: "function",
    name: "switch_persona",
    description:
      "Switch the conversation to another persona (its voice and character). Required whenever the"
      + " user asks to talk to, switch to, or get another persona, by name or description:"
      + " assistant = Bob, samantha = Samantha (Sam), witch = Esmerelda, captain = Captain Barnaby,"
      + " villain = Professor Karloff the mad scientist, robot = Unit Seven. Nothing else performs the switch.",
    parameters: {
      type: "object",
      properties: {
        persona: { type: "string", enum: ["assistant", "samantha", "witch", "captain", "villain", "robot"] },
      },
      required: ["persona"],
    },
  },
  web_search: {
    type: "function",
    name: "web_search",
    description:
      "Search the web for current or factual information you don't already know " +
      "(news, prices, facts, documentation). Returns the top results, each with a " +
      "passage of the page text and its URL. If the passages do not contain the " +
      "answer, call web_fetch on the most relevant URL to read the page.",
    parameters: {
      type: "object",
      properties: { query: { type: "string", description: "The search query." } },
      required: ["query"],
    },
  },
  find_restaurants: {
    type: "function",
    name: "find_restaurants",
    description:
      "Find restaurants with Google ratings, price level, distance and the official Georgia health " +
      "inspection score for each. Use it for any where-to-eat question. The user's location is added " +
      "automatically when they allow it, so put only the cuisine, name or area in the query " +
      "(e.g. \"Thai restaurants\" or \"pizza in Alpharetta\"). One call per question. Leave " +
      "open_now, min_rating and min_health_score unset unless the user asked for that; the default " +
      "sort already favours well-reviewed places. Read out the top two or three with their rating " +
      "and health score; the full list is shown on screen.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Cuisine, dish, restaurant name, or area." },
        sort_by: { type: "string", enum: ["rating", "health", "distance", "price"], description: "Default rating." },
        open_now: { type: "boolean", description: "Only places open right now." },
        min_rating: { type: "number", description: "Minimum Google rating, e.g. 4.3." },
        min_health_score: { type: "integer", description: "Minimum health inspection score, e.g. 90." },
        max_results: { type: "integer", description: "How many to return, 1-8 (default 5)." },
      },
      required: ["query"],
    },
  },
  restaurant_details: {
    type: "function",
    name: "restaurant_details",
    description:
      "Phone number, website, opening hours and whether it is open right now, for one restaurant " +
      "(from an earlier find_restaurants result, or by name). Use it when the user asks for a " +
      "number, a website, hours, or whether a place is open.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Restaurant name." },
        area: { type: "string", description: "Street, city or zip if there are several locations." },
      },
      required: ["name"],
    },
  },
  place_call: {
    type: "function",
    name: "place_call",
    description:
      "Open the user's phone dialer with a number ready to call. Only when the user explicitly asks " +
      "to call or phone someone; never on your own initiative. Say whom and which number you are " +
      "dialing as you do it. The user completes the call in their dialer.",
    parameters: {
      type: "object",
      properties: {
        number: { type: "string", description: "The phone number to dial, as shown by restaurant_details." },
        name: { type: "string", description: "Who is being called." },
      },
      required: ["number"],
    },
  },
  set_listening: {
    type: "function",
    name: "set_listening",
    description:
      "Change how the assistant listens. Call it only when the user explicitly asks to change that; " +
      "never for any other request, and always with a mode. \"standby\": only answer when called " +
      "by name (go on standby, stop listening, stop answering, only answer when I say your name). " +
      "\"normal\": answer everything again (listen normally, stop needing the wake word). " +
      "\"muted\": switch the microphone off entirely; the user must tap the mic to unmute and " +
      "cannot wake you by voice, so say so. None of these is a persona hand-off: never pair this " +
      "with switch_persona.",
    parameters: {
      type: "object",
      properties: { mode: { type: "string", enum: ["standby", "normal", "muted"] } },
      required: ["mode"],
    },
  },
  open_page: {
    type: "function",
    name: "open_page",
    description:
      "Open a restaurant's website, its Google reviews, or Google Maps directions to it, in a new " +
      "browser tab. Only when the user asks to open, show, see or pull up one of those. Uses a place " +
      "from an earlier result, or looks it up by name.",
    parameters: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["website", "reviews", "directions"] },
        name: { type: "string", description: "Restaurant name." },
        area: { type: "string", description: "Street, city or zip if there are several locations." },
      },
      required: ["kind", "name"],
    },
  },
  restaurant_inspections: {
    type: "function",
    name: "restaurant_inspections",
    description:
      "The recent official Georgia health inspection history for one restaurant: the last few scores " +
      "with dates, the trend, and the latest violations. Use it when the user asks about a place's " +
      "health scores, inspections, violations or how clean it is. Pass the restaurant's name and, " +
      "if known, the street, city or zip to pick the right location (from an earlier " +
      "find_restaurants result if there was one).",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Restaurant name as the user said it." },
        area: { type: "string", description: "Street, city or zip that identifies the location." },
        limit: { type: "integer", description: "How many recent inspections, 1-10 (default 3)." },
      },
      required: ["name"],
    },
  },
  web_fetch: {
    type: "function",
    name: "web_fetch",
    description:
      "Read the text of one web page, usually a URL from a web_search result, when " +
      "the search passages were not enough to answer. Returns the page's title and text.",
    parameters: {
      type: "object",
      properties: { url: { type: "string", description: "The http(s) URL to read." } },
      required: ["url"],
    },
  },
  camera_snapshot: {
    type: "function",
    name: "camera_snapshot",
    description:
      "Capture the current frame from the user's webcam so you can see what they " +
      "are showing you. Use it whenever the user refers to something visual or " +
      "asks you to look.",
    parameters: { type: "object", properties: {}, required: [] },
  },
};

/** Longest edge of the snapshot sent to the VLM, in px (keeps payload sane). */
const SNAPSHOT_MAX_EDGE = 768;
const SNAPSHOT_QUALITY = 0.7;
// Over WebRTC the snapshot travels inside ONE data-channel message, and SCTP
// messages above the negotiated max (64 KiB on the aiortc side) fail to send.
// Budget for the data-URL portion, leaving headroom for the JSON envelope.
const SNAPSHOT_DC_BUDGET_CHARS = 60_000;
// Re-encode ladder walked until the frame fits the budget: quality first
// (cheap wins), then resolution. The last rung is ~15–25 KB for any content,
// so a frame that "fits" is deterministic, not content-dependent luck.
const SNAPSHOT_LADDER = /** @type {[number, number][]} */ ([
  [SNAPSHOT_MAX_EDGE, SNAPSHOT_QUALITY],
  [SNAPSHOT_MAX_EDGE, 0.5],
  [640, 0.45],
  [512, 0.4],
  [448, 0.35],
  [384, 0.3],
]);

function loadSettings() {
  return {
    directUrl: localStorage.getItem(STORAGE_KEYS.directUrl) || "",
    voice: localStorage.getItem(STORAGE_KEYS.voice) || DEFAULT_VOICE,
    instructions: localStorage.getItem(STORAGE_KEYS.instructions) || DEFAULT_INSTRUCTIONS,
    personaMode: localStorage.getItem(STORAGE_KEYS.personaMode) || "",
    noiseGate: loadGateThreshold(),
    // Default WebSocket: the proven path stays the first-run experience.
    transport: localStorage.getItem(STORAGE_KEYS.transport) === "webrtc" ? "webrtc" : "ws",
    audioInputId: localStorage.getItem(STORAGE_KEYS.audioInputId) || "",
    audioOutputId: localStorage.getItem(STORAGE_KEYS.audioOutputId) || "",
  };
}

/** Stored gate threshold (dBFS), clamped to the slider range. Defaults to a
 * gentle enabled gate (GATE_DEFAULT_DB) when the user hasn't set one yet. */
function loadGateThreshold() {
  const stored = localStorage.getItem(STORAGE_KEYS.noiseGate);
  // getItem returns null when unset, and Number(null) === 0 (finite!), so guard
  // the missing/empty case explicitly before coercing — otherwise the default
  // never fires and 0 clamps to the slider max.
  if (stored === null || stored === "") return GATE_DEFAULT_DB;
  const raw = Number(stored);
  if (!Number.isFinite(raw)) return GATE_DEFAULT_DB;
  return Math.min(GATE_MAX_DB, Math.max(GATE_OFF_DB, Math.round(raw)));
}

/** @typedef {{ name: string, pronouns: string, birthday: string, address: string, notes: string, nicknameOk: boolean }} Profile */
const PROFILE_KEYS = /** @type {const} */ (["name", "pronouns", "birthday", "address", "notes"]);
/** @returns {Profile} */
function loadProfile() {
  const empty = { name: "", pronouns: "", birthday: "", address: "", notes: "", nicknameOk: false };
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEYS.profile) || "{}");
    for (const k of PROFILE_KEYS) if (typeof raw[k] === "string") empty[k] = raw[k].trim();
    empty.nicknameOk = raw.nicknameOk === true;
  } catch { /* fresh */ }
  return empty;
}
/** @param {Profile} p */
function saveProfile(p) {
  localStorage.setItem(STORAGE_KEYS.profile, JSON.stringify(p));
}
/** The city/state part of a home address: everything after the street, or a bare place name.
 *  @param {string} address */
function areaFromAddress(address) {
  const parts = address.split(",").map((x) => x.trim()).filter(Boolean);
  if (parts.length >= 2) return parts.slice(1).join(", ");
  return /^\d/.test(address.trim()) ? "" : address.trim();
}
/** What the server (and so the model) is told: name, pronouns, birthday, area, notes. Never the street. */
function profilePayload() {
  const p = profile;
  const user = { name: p.name, pronouns: p.pronouns, birthday: p.birthday, area: areaFromAddress(p.address), notes: p.notes };
  const s2s_user = Object.fromEntries(Object.entries(user).filter(([, v]) => v));
  if (p.name) s2s_user.nickname_ok = p.nicknameOk;
  return { s2s_user };
}
let profile = loadProfile();

/** @param {ReturnType<typeof loadSettings>} s */
function saveSettings(s) {
  localStorage.setItem(STORAGE_KEYS.directUrl, s.directUrl);
  localStorage.setItem(STORAGE_KEYS.voice, s.voice);
  localStorage.setItem(STORAGE_KEYS.instructions, s.instructions);
  localStorage.setItem(STORAGE_KEYS.personaMode, s.personaMode || "");
  localStorage.setItem(STORAGE_KEYS.noiseGate, String(s.noiseGate));
  localStorage.setItem(STORAGE_KEYS.transport, s.transport);
  localStorage.setItem(STORAGE_KEYS.audioInputId, s.audioInputId || "");
  localStorage.setItem(STORAGE_KEYS.audioOutputId, s.audioOutputId || "");
}

/** @returns {{ web_search: boolean, camera_snapshot: boolean, find_restaurants: boolean }} */
function loadTools() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEYS.tools) || "{}");
    // Both tools default ON (web search still only activates when a key exists).
    // We never call getUserMedia on page load — the camera only actually starts
    // on a user gesture (conversation start), so a default-on flag doesn't
    // silently resume the webcam; an explicit saved `false` is respected.
    return {
      web_search: raw.web_search ?? true,
      camera_snapshot: raw.camera_snapshot ?? true,
      find_restaurants: raw.find_restaurants ?? true,
    };
  } catch {
    return { web_search: true, camera_snapshot: true, find_restaurants: true };
  }
}

function saveTools() {
  localStorage.setItem(STORAGE_KEYS.tools, JSON.stringify(toolsEnabled));
}

/** @type {Record<AppState, { caption: string; disabled: boolean }>} */
const STATE_VIEWS = {
  idle:            { caption: "Tap to start",  disabled: false },
  connecting:      { caption: "Connecting",    disabled: true  },
  queued:          { caption: "Finding you a spot…", disabled: true },
  "your-turn":     { caption: "You're up! 🎉", disabled: true  },
  warming:         { caption: "Getting ready…", disabled: false },
  listening:       { caption: "",              disabled: false },
  "user-speaking": { caption: "",              disabled: false },
  processing:      { caption: "",              disabled: false },
  "ai-speaking":   { caption: "",              disabled: false },
  error:           { caption: "Tap to retry",  disabled: false },
};

/** @type {Record<AppState, string>} */
const STATE_CLASS = {
  idle: "state-idle",
  connecting: "state-connecting",
  queued: "state-queued",
  "your-turn": "state-your-turn",
  warming: "state-warming",
  listening: "state-listening",
  "user-speaking": "state-user-speaking",
  processing: "state-processing",
  "ai-speaking": "state-ai-speaking",
  error: "state-error",
};

/** @type {ReadonlySet<AppState>} */
const LIVE_STATES = new Set(["warming", "listening", "user-speaking", "processing", "ai-speaking"]);

/** @type {HTMLButtonElement} */
const circleBtn = $("#main-circle");
/** @type {HTMLParagraphElement} */
const circleCaption = $("#circle-caption");
/** @type {HTMLParagraphElement} */
const circleSubcaption = $("#circle-subcaption");
/** @type {HTMLElement} */
const orbWrap = $(".orb-wrap");
/** @type {HTMLButtonElement} */
const micBtn = $("#mic-btn");
/** @type {HTMLButtonElement} */
const stopBtn = $("#stop-btn");
/** @type {HTMLElement} */
const queueActions = $("#queue-actions");
/** @type {HTMLButtonElement} */
const joinQueueBtn = $("#join-queue-btn");
/** @type {HTMLButtonElement} */
const leaveQueueBtn = $("#leave-queue-btn");

/** @type {HTMLButtonElement} */
const settingsBtn = $("#settings-btn");
/** @type {HTMLDialogElement} */
const settingsModal = $("#settings-modal");

/** @type {HTMLButtonElement} */
const aboutBtn = $("#about-btn");
/** @type {HTMLDialogElement} */
const aboutModal = $("#about-modal");
/** @type {HTMLButtonElement} */
const aboutClose = $("#about-close");

/** @type {HTMLButtonElement} */
const toolsBtn = $("#tools-btn");
/** @type {HTMLDialogElement} */
const toolsModal = $("#tools-modal");
/** @type {HTMLButtonElement} */
const toolsClose = $("#tools-close");
/** @type {HTMLInputElement} */
const toolWebSwitch = $("#tool-web");
/** @type {HTMLInputElement} */
const toolCamSwitch = $("#tool-cam");
const toolRestSwitch = /** @type {HTMLInputElement} */ ($("#tool-rest"));
const toolRestRow = $("#tool-rest-row");
const toolRestHint = $("#tool-rest-hint");
/** @type {HTMLElement} */
const toolWebRow = $("#tool-web-row");
/** @type {HTMLElement} */
const toolWebHint = $("#tool-web-hint");
/** @type {HTMLElement} */
const toolCamHint = $("#tool-cam-hint");
/** @type {HTMLInputElement} */
const searchKeyInput = $("#search-key");
/** @type {HTMLElement} */
const camPip = $("#cam-pip");
/** @type {HTMLVideoElement} */
const camVideo = $("#cam-video");

/** @type {HTMLInputElement} */
const inputLbUrl = $("#lb-url");
/** @type {HTMLElement} */
const connField = $("#conn-field");
/** @type {HTMLElement} */
const connHint = $("#conn-hint");
/** @type {HTMLElement} */
const transportField = $("#transport-field");
/** @type {HTMLSelectElement} */
const inputTransport = $("#transport");
/** @type {HTMLElement} */
const transportHint = $("#transport-hint");
/** @type {HTMLElement} */
const gateField = $("#gate-field");
/** @type {HTMLSelectElement} */
const inputVoice = $("#voice");
/** @type {HTMLSelectElement} */
const inputPersona = $("#persona");
/** @type {NodeListOf<HTMLInputElement>} */
const inputPersonaMode = document.querySelectorAll('input[name="persona-mode"]');
const personaField = $("#persona-field");
const customFields = $("#custom-fields");
/** @type {HTMLSelectElement} */
const inputAudioInput = $("#audio-input");
/** @type {HTMLSelectElement} */
const inputAudioOutput = $("#audio-output");
/** @type {HTMLElement} */
const audioOutputHint = $("#audio-output-hint");
/** @type {HTMLTextAreaElement} */
const inputInstructions = $("#instructions");
/** @type {HTMLInputElement} */
const inputNoiseGate = $("#noise-gate");
/** @type {HTMLElement} */
const gateValue = $("#gate-value");
/** @type {HTMLElement} */
const gateMeterFill = $("#gate-meter-fill");
/** @type {HTMLElement} */
const micGate = $("#mic-gate");
const mgaArc = /** @type {SVGSVGElement} */ (document.querySelector("#mic-gate-arc"));
const mgaTrack = /** @type {SVGPathElement} */ (document.querySelector("#mga-track"));
const mgaFill = /** @type {SVGPathElement} */ (document.querySelector("#mga-fill"));
const mgaHit = /** @type {SVGPathElement} */ (document.querySelector("#mga-hit"));
const mgaHandle = /** @type {SVGCircleElement} */ (document.querySelector("#mga-handle"));
/** @type {HTMLButtonElement} */
const restartBtn = $("#restart-conversation");
/** @type {HTMLElement} */
const restartHint = $("#restart-hint");
const settingsForm = /** @type {HTMLFormElement} */ (settingsModal.querySelector("form"));
const profileInputs = {
  name: /** @type {HTMLInputElement} */ ($("#profile-name")),
  pronouns: /** @type {HTMLInputElement} */ ($("#profile-pronouns")),
  birthday: /** @type {HTMLInputElement} */ ($("#profile-birthday")),
  address: /** @type {HTMLInputElement} */ ($("#profile-address")),
  notes: /** @type {HTMLTextAreaElement} */ ($("#profile-notes")),
};
const profileNicknameOk = /** @type {HTMLInputElement} */ ($("#profile-nickname-ok"));

/** @type {AppState} */
let currentState = "idle";
let settings = loadSettings();

// ── Connection target ────────────────────────────────────────────────────────
// Three modes, decided by the deploy via /api/config:
//   • SPEECH_TO_SPEECH_URL set -> direct mode pinned by the deploy: the browser
//     connects straight to that URL, shown read-only in Settings. Overrides the
//     load balancer entirely.
//   • LOAD_BALANCER_URL set  -> original flow: POST the same-origin /api/session
//     proxy (the server forwards to the LB; the LB address is never sent here).
//   • neither (allowDirect)  -> the user sets a speech-to-speech server URL and
//     the browser connects to it directly (no load balancer, no /session).
let lbMode = false;
// Fail open: direct entry is allowed unless /api/config reports an LB URL. This
// way a missing/unreachable config (e.g. static hosting) leaves the field
// usable rather than locked.
let allowDirect = true;
// Deploy-pinned s2s URL (SPEECH_TO_SPEECH_URL). Non-empty -> locked direct
// mode: the field displays it read-only and the saved user URL is untouched.
let pinnedUrl = "";
// Whether the deploy offers the WebRTC transport (/api/config `rtc`; true
// exactly when the URL is env-pinned, since /api/calls only forwards there).
let rtcAvailable = false;
/** @type {RTCIceServer[]} STUN/TURN servers for the browser peer connection
 * (deploy-provided via RTC_ICE_SERVERS; empty -> host candidates only). */
let iceServers = [];
// Optional hidden user prompt supplied by the deployment. When non-empty, the
// client asks the model to greet once after the initial session configuration.
let startupGreeting = "";
// Transport of the LIVE (or starting) conversation — as opposed to
// `settings.transport`, which is what the NEXT one will use. Drives the
// camera-snapshot size budget while a call is running.
/** @type {"ws" | "webrtc"} */
let activeTransport = "ws";

// ── Tool state ──────────────────────────────────────────────────────────────
let toolsEnabled = loadTools();
// Whether the server holds a Serper key (learned from /api/config on load).
let serverSearchKey = false;
/** The server can read whole pages (Ollama search key configured). */
let serverFetch = false;
/** The server can search restaurants (Google Places key configured). */
let serverRestaurants = false;
/** The server can look up Georgia inspection history (public portal, no key). */
let serverInspections = false;
// A user-supplied key (fallback when the deploy has none). localStorage only.
let userSearchKey = localStorage.getItem(STORAGE_KEYS.searchKey) || "";
/** @type {MediaStream | null} */
let cameraStream = null;

/** Search is usable if the server has a key or the user supplied one. */
function searchAvailable() {
  return serverSearchKey || !!userSearchKey;
}

/** Tool definitions for the currently-enabled (and usable) tools. */
/** Map a persona id or any of its aliases to the persona id, or null. */
function resolvePersona(query) {
  const q = String(query || "").trim().toLowerCase();
  if (!q) return null;
  if (PERSONAS[q]) return q;
  for (const [id, p] of Object.entries(PERSONAS)) {
    if (p.aliases.some((a) => q === a || new RegExp(`(?:^|\\W)${a}(?:$|\\W)`).test(q))) return id;
  }
  return null;
}

/** Phrases in the user's own words that ask for another persona. Matched on the
 *  final transcript so the hand-off never depends on the model's judgment:
 *  "switch to the professor", "I want to speak to Esmerelda", "get me Barnaby",
 *  or a direct address at the start, "Esmerelda, what's brewing?". */
const PERSONA_REQUEST_RE =
  /\b(?:switch(?: me)?(?: over)? to|talk to|talk with|speak (?:to|with)|chat with|get me|give me|bring (?:me|in|out|back)|put on|put me through to|connect me (?:to|with)|pass me (?:to|over to)|a word with|(?:i(?:'d| would)? like|i want|let me|can i|could i|may i)(?: to)? (?:talk|speak|chat)(?: to| with)?|wake up|hand (?:me )?over to)\s+(?:the\s+)?([a-z][a-z' ]{2,32})/i;
const PERSONA_ADDRESS_RE = /^\s*(?:hey|hi|hello|ok|okay|yo)?[\s,]*([a-z][a-z' ]{2,24}?)[,!?.:]/i;

/** The assistant committed to a hand-off in its own words ("I'll switch you over to
 *  Captain Barnaby", "the witch awaits", "let me fetch Unit Seven"). */
const PERSONA_COMMIT_RE =
  /\b(?:switch(?:ing)?(?: you)?(?: over)? to|hand(?:ing)?(?: you)?(?: over)? to|transfer(?:ring)?(?: you)? to|fetch(?:ing)?|get|bring(?:ing)?(?: in| out)?|summon(?:ing)?|call(?:ing)?(?: for| upon)?|step(?:ping)? aside for|make way for|(?:\w+ )?awaits)\b[^.!?]{0,40}/i;
/** The assistant offered a hand-off and is waiting for a yes ("I can switch you over", "shall I fetch"). */
const PERSONA_OFFER_RE =
  /(?:\b(?:can|could|shall|should|may) (?:i|we)\b[^.!?]{0,30}\b(?:switch|hand|transfer|fetch|get|bring|summon|call)\b|\b(?:would you like|do you want|want) (?:me|us) to\b)/i;
const AFFIRM_RE = /^\s*(?:yes|yeah|yep|yup|sure|okay|ok|please|please do|do it|go ahead|that's (?:right|correct)|correct|absolutely|of course|sounds good|let's do it)\b/i;

/** Persona named in a reply that commits to or offers a hand-off, else null.
 *  @param {string} text @returns {{ id: string, offer: boolean } | null} */
function personaPromisedIn(text) {
  const t = String(text || "");
  const named = Object.entries(PERSONAS)
    .map(([id, p]) => ({ id, hit: p.aliases.find((a) => new RegExp(`(?:^|\\W)${a}(?:$|\\W)`, "i").test(t)) }))
    .filter((x) => x.hit);
  if (named.length !== 1) return null; // ambiguous or none
  if (PERSONA_OFFER_RE.test(t)) return { id: named[0].id, offer: true };
  if (PERSONA_COMMIT_RE.test(t)) return { id: named[0].id, offer: false };
  return null;
}

/** @param {string} transcript @returns {string | null} persona id the user asked for */
function personaRequestedIn(transcript) {
  const text = String(transcript || "");
  const m = PERSONA_REQUEST_RE.exec(text);
  if (m) {
    const id = resolvePersona(m[1]);
    if (id) return id;
  }
  const a = PERSONA_ADDRESS_RE.exec(text);
  if (a) {
    const id = resolvePersona(a[1]);
    if (id) return id;
  }
  return null;
}

/** How a hand-off was triggered, for the chip and the console. */
const SWITCH_REASONS = /** @type {Record<string, string>} */ ({
  named: "asked by name",
  addressed: "addressed by name",
  inferred: "inferred from your intent",
  promised: "as the reply promised",
  confirmed: "you confirmed the offer",
  settings: "chosen in Settings",
});

/** Make a persona the active one: settings, the Settings form, and the live session.
 *  @param {string} id @param {keyof typeof SWITCH_REASONS} [reason] */
function applyPersona(id, reason) {
  const persona = PERSONAS[id];
  if (!persona) return false;
  if (reason) {
    const how = SWITCH_REASONS[reason] ?? reason;
    console.log(`[persona] → ${persona.name} · ${how}`);
    if (client && LIVE_STATES.has(currentState)) chat.onPersonaSwitch(persona.name, how);
  }
  settings = { ...settings, voice: persona.voice, instructions: persona.instructions, personaMode: "preset" };
  saveSettings(settings);
  inputVoice.value = persona.voice;
  inputInstructions.value = persona.instructions;
  syncPersonaSelect();
  setPersonaMode("preset");
  chat.setAssistantName(persona.name);
  if (client && LIVE_STATES.has(currentState)) {
    lastSessionUpdate = client.updateSession({ voice: persona.voice, instructions: persona.instructions });
  }
  renderWakeToggle();
  sendWakeConfig();
  return true;
}

// ── Wake words ───────────────────────────────────────────────────────────────
// When armed, the server only answers a turn that names the current persona
// (or arrives within WAKE_WINDOW_S of its last reply). A turn that names
// another persona is not answered by the server; this page switches persona
// and asks for the reply itself, so "Esmerelda, ..." gets Esmerelda.
const WAKE_WINDOW_S = 45;
const WAKE_SLEEP_PHRASES = [
  "go to sleep", "that's all", "that is all", "never mind", "goodbye",
  "go on standby", "standby mode", "stop listening", "stop answering",
];
let wakeEnabled = localStorage.getItem(STORAGE_KEYS.wake) === "1";
const wakeBtn = $("#wake-btn");
const wakeLabel = $("#wake-label");

/** Spoken names that wake a persona. "Hey X" works because X is matched as a word. */
function wakeWordsFor(id) {
  return PERSONAS[id]?.aliases ?? [];
}

function wakeConfigPayload() {
  const current = currentPersonaId();
  const others = /** @type {Record<string, string[]>} */ ({});
  for (const id of Object.keys(PERSONAS)) if (id !== current) others[id] = wakeWordsFor(id);
  return {
    // The server stamps the current date and time into the prompt in this zone.
    s2s_clock: { tz: Intl.DateTimeFormat().resolvedOptions().timeZone },
    // Who the user is, in their own words (sent whenever the wake config is).
    ...profilePayload(),
    s2s_wake: {
      enabled: wakeEnabled,
      words: current ? wakeWordsFor(current) : [],
      others,
      // Another persona wakes only when addressed at the start of a turn
      // ("Bob, are you there?"), not when merely mentioned or babbled.
      others_mode: "leading",
      window_s: WAKE_WINDOW_S,
      sleep_phrases: WAKE_SLEEP_PHRASES,
    },
  };
}

function sendWakeConfig() {
  if (client && LIVE_STATES.has(currentState)) client.sendSessionExtra(wakeConfigPayload());
}

function renderWakeToggle() {
  const current = currentPersonaId();
  const name = current ? PERSONAS[current].name : null;
  wakeBtn.setAttribute("aria-pressed", wakeEnabled ? "true" : "false");
  const live = LIVE_STATES.has(currentState);
  const wakeName = name === "Bob" ? "Hey Bob" : name ?? "the name";
  // A muted mic outranks everything: nothing is heard, whatever standby says.
  const muted = live && micMuted;
  wakeBtn.toggleAttribute("data-muted", muted);
  wakeLabel.textContent = muted
    ? `Muted · not listening${wakeEnabled ? " · standby resumes on unmute" : ""}`
    : wakeEnabled
      ? (live ? `Standby · say "${wakeName}" to wake` : `Standby when connected · "${wakeName}" wakes`)
      : (live ? "Listening · answers everything" : "Listening when connected");
}

/** Standby (wake word required) on or off; persisted, shown under the orb, sent to the server. */
function setWakeEnabled(on) {
  wakeEnabled = !!on;
  localStorage.setItem(STORAGE_KEYS.wake, wakeEnabled ? "1" : "0");
  renderWakeToggle();
  sendWakeConfig();
}

wakeBtn.addEventListener("click", () => setWakeEnabled(!wakeEnabled));

/** The persona whose voice is currently selected, or null for a custom voice. */
function currentPersonaId() {
  return Object.entries(PERSONAS).find(([, p]) => p.voice === settings.voice)?.[0] ?? null;
}

/** A persona the user asked for by phrase; applied once the in-flight reply ends. */
let pendingPersona = /** @type {string | null} */ (null);
let wakeConfigSent = false;
/** Wake mode: request a reply as the newly addressed persona when the declined response ends. */
let replyAfterResponse = false;
/** The model called switch_persona during the response now in flight. */
let switchedThisResponse = false;
/** The assistant has spoken something in the response now in flight (a silent tool call has not). */
let spokenThisResponse = false;
/** Hand-off held back because the model called switch_persona without a goodbye; applied when its reply ends. */
let heldPersona = /** @type {string | null} */ (null);
/** Responses that ended while a hand-off was held; the second one applies it whatever it contained. */
let heldResponses = 0;
/** The last session update sent; a response that must use it is requested after this settles. */
let lastSessionUpdate = /** @type {Promise<void> | null} */ (null);
/** Quiet time after the goodbye finishes playing before the next persona is asked to speak. */
const HANDOFF_PAUSE_MS = 700;
/** Stop waiting for the speaker to go quiet after this long (a stuck level meter must not block the hand-off). */
const HANDOFF_PAUSE_MAX_MS = 8000;
/** When the speaker output was last audible (from the client's output-level events). */
let lastOutputAudibleAt = 0;
/** Bumped to abandon a hand-off greeting that is still waiting for the goodbye to finish. */
let handoffWaitToken = 0;

/** Resolve true once the speaker has been quiet for HANDOFF_PAUSE_MS (capped), false if the wait was abandoned. */
function waitForQuietOutput(c) {
  const token = ++handoffWaitToken;
  const started = performance.now();
  return new Promise((resolve) => {
    const tick = () => {
      if (token !== handoffWaitToken || client !== c) return resolve(false);
      const now = performance.now();
      const quietFor = now - Math.max(lastOutputAudibleAt, started);
      if (quietFor >= HANDOFF_PAUSE_MS || now - started >= HANDOFF_PAUSE_MAX_MS) return resolve(true);
      window.setTimeout(tick, 100);
    };
    tick();
  });
}

/** Switch persona, then have the new persona answer once the session update has reached the server.
 *  The greeting carries a one-off note: without it the model, seeing only the
 *  hand-off and the goodbye in the history, has answered with a second farewell
 *  in the new voice. */
function switchAndReply(c, id, reason) {
  if (id !== currentPersonaId()) applyPersona(id, reason);
  const persona = PERSONAS[id];
  // Two nudges, measured separately: the per-response note alone still left
  // 1-3 of 8 greetings sounding like farewells; a note placed in the
  // conversation after the goodbye brought that to 0 of 8. (A system-role
  // item would not do: the server treats one as a replacement session prompt.)
  const note = ` Hand-off complete: the previous persona has already said goodbye, and you are ${persona.name} now.`
    + " Greet the user briefly in your own character, then help them. Do not say goodbye and do not call switch_persona.";
  const handoffNote = "(Hand-off note, not spoken by the user: the previous persona has said its goodbye; that farewell was"
    + ` theirs. You are ${persona.name} now, and the user is waiting for your greeting. Greet them briefly in your own`
    + " character, then help them.)";
  // Let the goodbye finish playing, then a beat of silence, before the next
  // persona speaks; the server is done well before the browser has played
  // the audio, so response-finished alone runs the two together.
  void Promise.resolve(lastSessionUpdate)
    .then(() => waitForQuietOutput(c))
    .then((go) => {
      if (!go || client !== c || !LIVE_STATES.has(currentState)) return;
      c.sendUserNote(handoffNote);
      c.requestResponse({ instructions: persona.instructions + note });
    });
}
/** Hand-off the assistant promised in words but did not perform; applied when the reply ends. */
let promisedPersona = /** @type {string | null} */ (null);
/** Hand-off the assistant offered; applied if the user's next turn is a yes. */
let offeredPersona = /** @type {string | null} */ (null);

function activeToolDefs() {
  const defs = [];
  defs.push(TOOL_DEFS.switch_persona);
  // Deterministic, keyless, always on: the model must not count days or do sums itself.
  defs.push(LOCAL_TOOL_DEFS.date_math, LOCAL_TOOL_DEFS.calculate, TOOL_DEFS.set_listening);
  if (toolsEnabled.web_search && searchAvailable()) {
    defs.push(TOOL_DEFS.web_search);
    if (serverFetch) defs.push(TOOL_DEFS.web_fetch);
  }
  if (toolsEnabled.camera_snapshot) defs.push(TOOL_DEFS.camera_snapshot);
  if (toolsEnabled.find_restaurants && serverRestaurants) defs.push(TOOL_DEFS.find_restaurants, TOOL_DEFS.restaurant_details, TOOL_DEFS.place_call, TOOL_DEFS.open_page);
  if (toolsEnabled.find_restaurants && serverInspections) defs.push(TOOL_DEFS.restaurant_inspections);
  return defs;
}

/** Push the active tool set to a live session so toggles apply mid-call. */
function pushToolsToSession() {
  if (!client || !LIVE_STATES.has(currentState)) return;
  client.setTools(activeToolDefs());
}

// ── Chat view ───────────────────────────────────────────────────────────────
// Owns the history panel, the ephemeral bubbles, and all transcript/tool
// streaming state. The client's events are forwarded to its on* methods.
let userAudioReplaying = false;
const chat = new ChatView({
  onUserAudioPlaybackChange(playing) {
    userAudioReplaying = playing;
    syncMicMuteState();
  },
});

// ── Account / limiter ─────────────────────────────────────────────────────
// Login chip + daily-limit modal (inert unless the deploy is in LB mode). The
// server meters conversation time; the client just heartbeats a live session
// and tears down when the server reports the budget is spent.
const account = new Account();
let limiterOn = false;
let heartbeatTimer = 0;
let trackedSessionId = "";
let trackedTier = "";
// The waiting-queue ticket id while we're in line (else ""). Used to leave the
// queue on teardown / tab-close so we don't hold a phantom place.
let queuedTicketId = "";

/** @type {RealtimeClient | null} */
let client = null;
/** @type {MediaStream | null} */
let micStream = null;
let micMuted = false;
/** The mic is muted by the page (a phone call, or a spoken "mute"); the mic button lifts it. */
let hardMuted = false;
let hardMuteCaption = "";

/** Apply both the user's mute choice and the temporary replay guard. */
function syncMicMuteState() {
  const muted = micMuted || userAudioReplaying;
  for (const track of micStream?.getAudioTracks() ?? []) {
    track.enabled = !muted;
  }
  client?.setMuted(muted);
}

/** @param {AppState} next */
function setState(next) {
  currentState = next;
  renderWakeToggle();
  const view = STATE_VIEWS[next];
  circleBtn.disabled = view.disabled;
  circleBtn.className = `circle ${STATE_CLASS[next]}`;
  if (micMuted && LIVE_STATES.has(next)) circleBtn.classList.add("muted");
  if (next !== "error") setCaption(view.caption);

  const live = LIVE_STATES.has(next);
  orbWrap.classList.toggle("live", live);
  for (const btn of [micBtn, stopBtn]) {
    // The End button is usually focused when the session ends (the user just
    // clicked it); hiding a focused element from assistive tech is an error.
    // Drop focus first, and use `inert`, which also removes it from the tab order.
    if (!live && document.activeElement === btn) btn.blur();
    btn.inert = !live;
    btn.setAttribute("aria-hidden", live ? "false" : "true");
    btn.tabIndex = live ? 0 : -1;
  }

  // Queue affordances: "Leave queue" whenever we're in line; "Join now" only once
  // it's our turn (a slot is held for us). Both live under #queue-actions.
  const yourTurn = next === "your-turn";
  const inLine = next === "queued" || yourTurn;
  queueActions.hidden = !inLine;
  joinQueueBtn.hidden = !yourTurn;
  joinQueueBtn.tabIndex = yourTurn ? 0 : -1;
  leaveQueueBtn.hidden = !inLine;
  leaveQueueBtn.tabIndex = inLine ? 0 : -1;
  if (!yourTurn) stopJoinCountdown();

  // Warm reassurance under the terse position, only while waiting in line.
  if (next === "queued") {
    circleSubcaption.textContent =
      "Sorry, we overhugged! 🤗 Every slot is busy, so we saved you a spot. Hang tight, you're moving up.";
    circleSubcaption.hidden = false;
  } else if (next === "warming") {
    circleSubcaption.textContent = warmupStep;
    circleSubcaption.hidden = !warmupStep;
  } else {
    circleSubcaption.hidden = true;
  }

  updateRestartAvailability();
}

function updateRestartAvailability() {
  // Restart works from any settled state — it tears down a live call (if any)
  // and reconnects with the current settings. Only block while mid-connect or
  // while waiting in the queue (restarting from there would just re-queue).
  restartBtn.disabled =
    currentState === "connecting" || currentState === "queued" || currentState === "your-turn";
  restartHint.hidden = false;
  restartHint.textContent = LIVE_STATES.has(currentState)
    ? "Reconnects now with the settings above."
    : "Starts a conversation with the settings above.";
}

/**
 * @param {string} text
 * @param {"" | "error" | "muted"} [kind]
 */
const CALL_MUTE_CAPTION = "Mic muted for your call · tap the mic to unmute";
const HARD_MUTE_CAPTION = "Muted · tap the mic to unmute";
function setCaption(text, kind = "") {
  // While the page has muted the mic, that fact outranks the state captions
  // that every status change repaints; errors still show.
  if (hardMuted && kind !== "error") { text = hardMuteCaption; kind = "muted"; }
  const trimmed = text.trim();
  circleCaption.textContent = trimmed;
  circleCaption.className = `circle-caption${kind ? ` ${kind}` : ""}${trimmed ? "" : " empty"}`;
}

/** Show the persona whose voice matches the current Voice field, else Assistant. */
function syncPersonaSelect() {
  const current = inputVoice.value.trim().toLowerCase();
  const match = Object.entries(PERSONAS).find(([, p]) => p.voice.toLowerCase() === current);
  inputPersona.value = match ? match[0] : "assistant";
}

/** @returns {"preset" | "custom"} */
function currentPersonaMode() {
  return [...inputPersonaMode].find((r) => r.checked)?.value === "custom" ? "custom" : "preset";
}

/** Grey out whichever side is not in use; in preset mode the custom fields
 *  mirror the chosen preset so its voice and prompt stay visible. */
function setPersonaMode(mode) {
  const custom = mode === "custom";
  for (const r of inputPersonaMode) r.checked = r.value === (custom ? "custom" : "preset");
  personaField.classList.toggle("dim", custom);
  customFields.classList.toggle("dim", !custom);
  inputPersona.disabled = custom;
  inputVoice.disabled = !custom;
  inputInstructions.disabled = !custom;
  if (!custom) {
    const persona = PERSONAS[inputPersona.value];
    if (persona) {
      inputVoice.value = persona.voice;
      inputInstructions.value = persona.instructions;
    }
  }
}

inputPersona.addEventListener("change", () => {
  const persona = PERSONAS[inputPersona.value];
  if (!persona) return;
  inputVoice.value = persona.voice;
  inputInstructions.value = persona.instructions;
});
for (const r of inputPersonaMode) {
  r.addEventListener("change", () => setPersonaMode(currentPersonaMode()));
}

/** Render the persona dropdown from PERSONAS so labels live in one place. */
for (const [id, p] of Object.entries(PERSONAS)) {
  const opt = [...inputPersona.options].find((o) => o.value === id);
  if (opt) opt.textContent = p.label;
}

function openSettings() {
  syncConnectionUi();
  inputVoice.value = settings.voice;
  inputInstructions.value = settings.instructions;
  for (const k of PROFILE_KEYS) profileInputs[k].value = profile[k];
  profileNicknameOk.checked = profile.nicknameOk;
  syncPersonaSelect();
  const savedMode = settings.personaMode || (currentPersonaId() ? "preset" : "custom");
  setPersonaMode(savedMode);
  syncGateUi();
  updateRestartAvailability();
  void refreshAudioDeviceLists();
  settingsModal.showModal();
}

/** dB position (clamped to the slider axis) as a 0..1 fraction of the track.
 * @param {number} db */
function dbToFraction(db) {
  const clamped = Math.min(GATE_MAX_DB, Math.max(GATE_OFF_DB, db));
  return (clamped - GATE_OFF_DB) / (GATE_MAX_DB - GATE_OFF_DB);
}

/** @param {number} f @returns {number} dB at a 0..1 position on the gate axis. */
function fractionToDb(f) {
  const clamped = Math.min(1, Math.max(0, f));
  return Math.round(GATE_OFF_DB + clamped * (GATE_MAX_DB - GATE_OFF_DB));
}

// ── Radial gate arc (around the mic button, live during a call) ─────────────
// A 270° arc with the gap facing the orb (right). Fraction 0 (=Off) sits at the
// bottom-ish start; 1 (=max) at the top-ish end. The level fill and the
// threshold handle ride this same axis, mirroring the Settings widget.
const ARC_R = 40;
// A ~200° arc centred on the left (180°) so the wide gap faces the orb (right).
const ARC_SPAN_DEG = 200;
const ARC_START_DEG = 180 - ARC_SPAN_DEG / 2; // lower-left start; Off end

/** Point at fraction f (0..1) and radius r, in the 0..100 viewBox.
 * @param {number} f @param {number} [r] */
function arcPoint(f, r = ARC_R) {
  const deg = ARC_START_DEG + f * ARC_SPAN_DEG;
  const rad = (deg * Math.PI) / 180;
  return { x: 50 + r * Math.cos(rad), y: 50 + r * Math.sin(rad) };
}

/** SVG path `d` for the full 0..1 arc (clockwise). */
function fullArcD() {
  const a = arcPoint(0);
  const b = arcPoint(1);
  const largeArc = ARC_SPAN_DEG > 180 ? 1 : 0;
  return `M ${a.x} ${a.y} A ${ARC_R} ${ARC_R} 0 ${largeArc} 1 ${b.x} ${b.y}`;
}

/** One-time geometry: track, fill (dash-revealed) and the transparent hit band. */
function initGateArc() {
  const d = fullArcD();
  mgaTrack.setAttribute("d", d);
  mgaFill.setAttribute("d", d);
  mgaHit.setAttribute("d", d);
  // pathLength 100 lets us reveal the fill by fraction via dashoffset.
  mgaFill.setAttribute("pathLength", "100");
  mgaFill.style.strokeDasharray = "100 100";
  mgaFill.style.strokeDashoffset = "100"; // empty until levels arrive
  renderGateHandle();
}

/** Place the threshold bead on the arc at the stored threshold; flag off state. */
function renderGateHandle() {
  const off = settings.noiseGate <= GATE_OFF_DB;
  const p = arcPoint(dbToFraction(settings.noiseGate));
  mgaHandle.setAttribute("cx", String(p.x));
  mgaHandle.setAttribute("cy", String(p.y));
  micGate.classList.toggle("gate-off", off);
}

/** Paint a 0..1 live level onto the arc fill (and the Settings meter if open).
 * Brightens the tick when the level crosses the threshold — i.e. the gate is
 * actually open — but only when gating is enabled.
 * @param {number} rms */
function paintInputLevel(rms) {
  const db = rms > 0 ? 20 * Math.log10(rms) : GATE_OFF_DB;
  const f = dbToFraction(db);
  mgaFill.style.strokeDashoffset = String(100 * (1 - f));
  if (settingsModal.open) gateMeterFill.style.width = `${f * 100}%`;
  const enabled = settings.noiseGate > GATE_OFF_DB;
  micGate.classList.toggle("gate-open", enabled && f >= dbToFraction(settings.noiseGate));
}

/** The single place that commits a new gate threshold: updates both controls,
 * persists, and applies live to the running session.
 * @param {number} db */
function setGateThreshold(db) {
  settings.noiseGate = Math.min(GATE_MAX_DB, Math.max(GATE_OFF_DB, Math.round(db)));
  const off = settings.noiseGate <= GATE_OFF_DB;
  inputNoiseGate.value = String(settings.noiseGate);
  gateValue.textContent = off ? "Off" : `${settings.noiseGate} dB`;
  renderGateHandle();
  localStorage.setItem(STORAGE_KEYS.noiseGate, String(settings.noiseGate));
  if (client && LIVE_STATES.has(currentState)) {
    client.setNoiseGate(gateParams(settings.noiseGate));
  }
}

/** Reflect the stored gate threshold into the slider, label and arc handle. */
function syncGateUi() {
  inputNoiseGate.value = String(settings.noiseGate);
  const off = settings.noiseGate <= GATE_OFF_DB;
  gateValue.textContent = off ? "Off" : `${settings.noiseGate} dB`;
  renderGateHandle();
}

// Drag along the arc band to set the threshold (a tap on the glyph still mutes).
let gateDragging = false;
/** @param {PointerEvent} e */
function gatePointerToDb(e) {
  const rect = mgaArc.getBoundingClientRect();
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  let deg = (Math.atan2(e.clientY - cy, e.clientX - cx) * 180) / Math.PI;
  if (deg < 0) deg += 360;
  // Map the on-arc angle to a fraction; angles in the right-side gap fall
  // outside [0,1] and fractionToDb clamps them to the nearest end (just-below
  // start -> Off, just-past end -> max).
  const f = (deg - ARC_START_DEG) / ARC_SPAN_DEG;
  return fractionToDb(f);
}
mgaHit.addEventListener("pointerdown", (e) => {
  gateDragging = true;
  mgaHit.setPointerCapture(e.pointerId);
  setGateThreshold(gatePointerToDb(e));
});
mgaHit.addEventListener("pointermove", (e) => {
  if (gateDragging) setGateThreshold(gatePointerToDb(e));
});
const endGateDrag = (/** @type {PointerEvent} */ e) => {
  if (!gateDragging) return;
  gateDragging = false;
  try { mgaHit.releasePointerCapture(e.pointerId); } catch {}
};
mgaHit.addEventListener("pointerup", endGateDrag);
mgaHit.addEventListener("pointercancel", endGateDrag);

settingsBtn.addEventListener("click", openSettings);

// About panel: native <dialog>, Esc closes for free; also close on the X and
// on a click in the backdrop (a click whose target is the dialog itself).
aboutBtn.addEventListener("click", () => aboutModal.showModal());
// Mobile twin of the (i), living in the right-hand control cluster.
$("#about-btn-m").addEventListener("click", () => aboutModal.showModal());
aboutClose.addEventListener("click", () => aboutModal.close());
aboutModal.addEventListener("click", (e) => {
  if (e.target === aboutModal) aboutModal.close();
});

// ── Tools panel ───────────────────────────────────────────────────────────

/** Reflect the current tool state into the panel controls. */
function syncToolsUi() {
  const avail = searchAvailable();
  toolWebSwitch.checked = toolsEnabled.web_search && avail;
  toolWebSwitch.disabled = !avail;
  toolWebRow.classList.toggle("disabled", !avail);
  toolCamSwitch.checked = toolsEnabled.camera_snapshot;
  toolRestSwitch.checked = toolsEnabled.find_restaurants && serverRestaurants;
  toolRestSwitch.disabled = !serverRestaurants;
  toolRestRow.classList.toggle("disabled", !serverRestaurants);
  toolRestHint.textContent = serverRestaurants
    ? "Google ratings plus official Georgia health scores. Your location is used only when you allow it."
    : "Not configured on this server (needs a Google Places key).";

  if (serverSearchKey) {
    // Key lives server-side: show it as configured, never expose it.
    searchKeyInput.value = "";
    searchKeyInput.placeholder = "••••••••  · provided by the server";
    searchKeyInput.disabled = true;
    toolWebHint.textContent = "Ready. The search key is held server-side and never sent to your browser.";
  } else {
    searchKeyInput.disabled = false;
    searchKeyInput.value = userSearchKey;
    searchKeyInput.placeholder = "Paste a Serper key to enable web search";
    toolWebHint.textContent = userSearchKey
      ? "Using your key — stored in this browser only."
      : "No server key configured. Add your own Serper key to enable web search.";
  }
}

toolsBtn.addEventListener("click", () => { syncToolsUi(); toolsModal.showModal(); });

toolRestSwitch.addEventListener("change", () => {
  toolsEnabled.find_restaurants = toolRestSwitch.checked;
  saveTools();
  pushToolsToSession();
});
toolsClose.addEventListener("click", () => toolsModal.close());
toolsModal.addEventListener("click", (e) => {
  if (e.target === toolsModal) toolsModal.close();
});

toolWebSwitch.addEventListener("change", () => {
  if (toolWebSwitch.checked && !searchAvailable()) {
    toolWebSwitch.checked = false; // guard: can't enable without a key
    return;
  }
  toolsEnabled.web_search = toolWebSwitch.checked;
  saveTools();
  pushToolsToSession();
});

toolCamSwitch.addEventListener("change", async () => {
  if (toolCamSwitch.checked) {
    try {
      // Flipping the switch always re-requests the camera, so a permission that
      // was only dismissed earlier is asked again here.
      await enableCamera();
    } catch (err) {
      toolCamSwitch.checked = false;
      const denied = err instanceof Error && (err.name === "NotAllowedError" || err.name === "SecurityError");
      toolCamHint.textContent = denied
        ? "Camera blocked. Allow it from the camera icon in your browser's address bar — it switches on automatically."
        : `Camera unavailable${err instanceof Error ? `: ${err.message}` : ""}`;
      return;
    }
    toolsEnabled.camera_snapshot = true;
    toolCamHint.textContent = "Camera on. The assistant can take a snapshot when it needs to see.";
  } else {
    disableCamera();
    toolsEnabled.camera_snapshot = false;
    toolCamHint.textContent = "Let the assistant see through your webcam.";
  }
  saveTools();
  pushToolsToSession();
});

searchKeyInput.addEventListener("input", () => {
  if (serverSearchKey) return;
  userSearchKey = searchKeyInput.value.trim();
  if (userSearchKey) localStorage.setItem(STORAGE_KEYS.searchKey, userSearchKey);
  else localStorage.removeItem(STORAGE_KEYS.searchKey);

  const avail = searchAvailable();
  toolWebSwitch.disabled = !avail;
  toolWebRow.classList.toggle("disabled", !avail);
  // Losing the key disables a previously-enabled tool.
  if (!avail && toolsEnabled.web_search) {
    toolsEnabled.web_search = false;
    toolWebSwitch.checked = false;
    saveTools();
    pushToolsToSession();
  }
  toolWebHint.textContent = userSearchKey
    ? "Using your key — stored in this browser only."
    : "No server key configured. Add your own Serper key to enable web search.";
});

// ── Camera ──────────────────────────────────────────────────────────────────

async function enableCamera() {
  if (cameraStream) return;
  cameraStream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: "user" },
    audio: false,
  });
  camVideo.srcObject = cameraStream;
  try { await camVideo.play(); } catch { /* autoplay quirks; muted video is fine */ }
  camPip.classList.add("visible");
  camPip.setAttribute("aria-hidden", "false");
  // Lets the footer reflow to the bottom-right (and hide on mobile) while the
  // webcam preview occupies the bottom of the stage.
  document.body.classList.add("cam-on");
}

function disableCamera() {
  if (cameraStream) {
    for (const t of cameraStream.getTracks()) t.stop();
    cameraStream = null;
  }
  camVideo.srcObject = null;
  camPip.classList.remove("visible");
  camPip.setAttribute("aria-hidden", "true");
  document.body.classList.remove("cam-on");
}

/** Auto-start the webcam on arrival (the camera tool is on by default). If the
 *  user declines the permission, switch the tool off and reflect it in the UI
 *  rather than nagging. */
async function autoStartCamera() {
  if (!toolsEnabled.camera_snapshot || cameraStream) return;
  try {
    await enableCamera();
  } catch (err) {
    console.warn("[main] camera auto-start declined/failed:", err);
    toolsEnabled.camera_snapshot = false;
    saveTools();
    syncToolsUi();
  }
}

/** Track the browser's camera permission so a later re-grant (e.g. the user
 *  unblocks it from the address bar after a denial) turns the camera back on
 *  without another toggle, and a revoke turns it off. Best-effort: the
 *  Permissions API doesn't support "camera" everywhere (e.g. Safari). */
async function watchCameraPermission() {
  try {
    const status = await navigator.permissions?.query?.({ name: /** @type {any} */ ("camera") });
    if (!status) return;
    status.addEventListener("change", () => {
      if (status.state === "granted") {
        if (!toolsEnabled.camera_snapshot) { toolsEnabled.camera_snapshot = true; saveTools(); }
        void autoStartCamera();
        syncToolsUi();
      } else if (status.state === "denied") {
        disableCamera();
        if (toolsEnabled.camera_snapshot) { toolsEnabled.camera_snapshot = false; saveTools(); }
        syncToolsUi();
      }
    });
  } catch {
    // Permissions API unavailable for "camera" — the toggle still re-asks.
  }
}

/**
 * Grab the current webcam frame as a downscaled JPEG data URL. The preview is
 * mirrored in CSS for a natural self-view, but we draw the raw (un-mirrored)
 * video here so the model sees the scene in its true orientation.
 *
 * Over WebRTC the frame must fit one data-channel message, so it's re-encoded
 * down the SNAPSHOT_LADDER until it's under SNAPSHOT_DC_BUDGET_CHARS; over
 * WebSocket the first (full-quality) rung is used as before.
 * @returns {string | null}
 */
function captureSnapshot() {
  if (!cameraStream || !camVideo.videoWidth) return null;
  const vw = camVideo.videoWidth;
  const vh = camVideo.videoHeight;

  /** @param {number} maxEdge @param {number} quality @returns {string | null} */
  const encode = (maxEdge, quality) => {
    const scale = Math.min(1, maxEdge / Math.max(vw, vh));
    const w = Math.max(1, Math.round(vw * scale));
    const h = Math.max(1, Math.round(vh * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(camVideo, 0, 0, w, h);
    return canvas.toDataURL("image/jpeg", quality);
  };

  if (activeTransport !== "webrtc") {
    return encode(SNAPSHOT_MAX_EDGE, SNAPSHOT_QUALITY);
  }
  let dataUrl = null;
  for (const [edge, quality] of SNAPSHOT_LADDER) {
    dataUrl = encode(edge, quality);
    if (!dataUrl) return null;
    if (dataUrl.length <= SNAPSHOT_DC_BUDGET_CHARS) return dataUrl;
  }
  // Even the last rung overflowed (shouldn't happen in practice) — send it
  // anyway; the client logs the failed send rather than killing the session.
  console.warn(`[tool] snapshot exceeds the data-channel budget after the full ladder (${dataUrl?.length} chars)`);
  return dataUrl;
}

/** Brief shutter flash on the preview so the user sees a snapshot was taken. */
function flashPreview() {
  camPip.classList.remove("flash");
  void camPip.offsetWidth; // reflow so the animation restarts
  camPip.classList.add("flash");
}

// ── Tool executor ─────────────────────────────────────────────────────────
// Runs the function the model called and returns the result. RealtimeSession
// owns function output ordering and the follow-up response. Errors come back as
// tool output too, so the model can recover gracefully instead of stalling.

/**
 * Run the function the model called. The Agents SDK preserves call order and
 * submits the returned value to the session.
 * @param {string} name @param {string} argsJson @param {string} callId
 * @returns {Promise<{ output: string, image?: string, cards?: unknown[] }>}
 */
async function runTool(name, argsJson, callId) {
  if (!client) return { output: "" };
  let args = /** @type {Record<string, unknown>} */ ({});
  try { args = JSON.parse(argsJson || "{}"); } catch { /* keep {} */ }

  if (DEBUG) console.debug(`[tool] run name=${name} callId=${JSON.stringify(callId)} args=${argsJson}`);
  if (!callId) console.warn("[tool] empty call_id — the backend didn't tag the call, can't return a function_call_output");

  /** @type {{ output: string, image?: string, cards?: unknown[] }} */
  let result = { output: "" };
  try {
    if (name === "switch_persona") {
      const id = resolvePersona(args.persona);
      pendingPersona = null;
      switchedThisResponse = true;
      promisedPersona = null;
      offeredPersona = null;
      if (id && !spokenThisResponse && !heldPersona && id !== currentPersonaId()) {
        // A silent switch: nothing was said before the call, so the next
        // persona would answer with no farewell at all. Hold the switch, ask
        // for the goodbye now, and apply it when that reply ends.
        heldPersona = id;
        heldResponses = 0;
        console.log(`[persona] hold → ${PERSONAS[id].name} · goodbye first`);
        result.output = `Not switched yet. First say a one-line goodbye in your own voice, now, in this reply. The switch to ${PERSONAS[id].label} happens by itself when this reply ends; do not call switch_persona again. Only the goodbye, nothing more: do not speak as or for ${PERSONAS[id].label} and do not greet on their behalf; they speak next, by themselves.`;
      } else if (id && applyPersona(id, "inferred")) {
        result.output = `Switched to ${PERSONAS[id].label}. From now on you are that persona: reply in character, in their voice, and greet the user briefly.`;
      } else {
        result.output = `Unknown persona ${JSON.stringify(args.persona)}. Available: ${Object.keys(PERSONAS).join(", ")}.`;
      }
    } else if (name === "web_search") {
      const query = typeof args.query === "string" ? args.query : "";
      result.output = await execWebSearch(query);
    } else if (name === "web_fetch") {
      const url = typeof args.url === "string" ? args.url : "";
      result.output = await execWebFetch(url);
    } else if (name === "find_restaurants") {
      const found = await execFindRestaurants(args);
      result = { output: found.text, cards: found.results };
    } else if (name === "restaurant_details") {
      const det = await execDetails(args);
      result = { output: det.text, cards: det.found ? [det] : [] };
    } else if (name === "place_call") {
      result.output = placeCall(args);
    } else if (name === "set_listening") {
      result.output = applyListeningMode(typeof args.mode === "string" ? args.mode : "");
    } else if (name === "open_page") {
      const opened = await openPlacePage(args);
      result = { output: opened.text, cards: opened.url ? [opened] : [] };
    } else if (name === "restaurant_inspections") {
      const history = await execInspections(args);
      result = { output: history.text, cards: history.found ? [history] : [] };
    } else if (name === "date_math" || name === "calculate") {
      result.output = runLocalTool(name, args) ?? `Unknown tool: ${name}`;
    } else if (name === "camera_snapshot") {
      const dataUrl = captureSnapshot();
      if (dataUrl) {
        if (DEBUG) console.debug(`[tool] camera_snapshot captured frame (${dataUrl.length} chars), sending image + output`);
        result = { output: "Snapshot captured from the webcam and attached as an image.", image: dataUrl };
        flashPreview();
      } else {
        console.warn("[tool] camera_snapshot: no frame — camera off or not ready");
        result.output = "The camera is not available right now.";
      }
    } else {
      result.output = `Unknown tool: ${name}`;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    result.output = `Tool failed: ${msg}`;
  }
  return result;
}

/** @param {string} query @returns {Promise<string>} */
async function execWebSearch(query) {
  if (!query) return "No query provided.";
  /** @type {Record<string, string>} */
  const body = { query };
  // Only send a user key when there's no server key (server prefers its own).
  if (!serverSearchKey && userSearchKey) body.key = userSearchKey;

  const res = await fetch("api/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let detail = String(res.status);
    try { const j = await res.json(); if (j.detail) detail = j.detail; } catch {}
    throw new Error(`search error (${detail})`);
  }
  const json = await res.json();
  // Date-stamp the header so the model treats these as fresh realtime facts
  // rather than its (older) training knowledge.
  const today = new Date().toISOString().slice(0, 10);
  /** @type {string[]} */
  const lines = [`Web search results from ${today}:`];
  if (json.answer) lines.push(`Answer: ${json.answer}`);
  for (const r of json.results || []) {
    lines.push(`- ${r.title}: ${r.snippet} (${r.url})`);
  }
  return lines.length > 1 ? lines.join("\n") : `${lines[0]}\nNo results found.`;
}

/** The user's position, if they allow it: cached a few minutes, never stored.
 *  @returns {Promise<{ lat: number, lng: number } | null>} */
let cachedPosition = /** @type {{ at: number, lat: number, lng: number } | null} */ (null);
async function currentPosition() {
  if (cachedPosition && Date.now() - cachedPosition.at < 5 * 60 * 1000) return { lat: cachedPosition.lat, lng: cachedPosition.lng };
  if (!("geolocation" in navigator)) return null;
  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        cachedPosition = { at: Date.now(), lat: pos.coords.latitude, lng: pos.coords.longitude };
        resolve({ lat: cachedPosition.lat, lng: cachedPosition.lng });
      },
      (err) => {
        if (DEBUG) console.debug("[restaurants] no position:", err?.message);
        resolve(null);
      },
      { timeout: 6000, maximumAge: 5 * 60 * 1000 },
    );
  });
}

/** @param {Record<string, unknown>} args @returns {Promise<{ text: string, results: unknown[] }>} */
async function execFindRestaurants(args) {
  const query = typeof args.query === "string" ? args.query.trim() : "";
  if (!query) return { text: "No query provided.", results: [] };
  const pos = await currentPosition();
  /** @type {Record<string, unknown>} */
  const body = { query };
  if (pos) { body.lat = pos.lat; body.lng = pos.lng; }
  else if (profile.address) body.near = profile.address; // home, when location is not shared
  for (const k of ["sort_by", "open_now", "min_rating", "min_health_score", "max_results"]) {
    if (args[k] !== undefined && args[k] !== null && args[k] !== "") body[k] = args[k];
  }
  const res = await fetch("api/restaurants", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let detail = String(res.status);
    try { const j = await res.json(); if (j.detail) detail = j.detail; } catch {}
    throw new Error(`restaurant search error (${detail})`);
  }
  const json = await res.json();
  const results = Array.isArray(json.results) ? json.results : [];
  rememberPlaces(results);
  const note = pos ? "" : profile.address ? "\n(Location not shared: results are around the user's home.)" : "\n(Location not shared: results are for the area named in the query.)";
  return { text: `${json.text}${note}`, results };
}

/** @param {Record<string, unknown>} args @returns {Promise<{ text: string, found: boolean, phone?: string, phone_dial?: string }>} */
async function execDetails(args) {
  const name = typeof args.name === "string" ? args.name.trim() : "";
  if (!name) return { text: "No restaurant name given.", found: false };
  /** @type {Record<string, unknown>} */
  const body = { name };
  if (typeof args.area === "string" && args.area.trim()) body.area = args.area.trim();
  const res = await fetch("api/restaurant_details", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let detail = String(res.status);
    try { const j = await res.json(); if (j.detail) detail = j.detail; } catch {}
    throw new Error(`details lookup error (${detail})`);
  }
  const det = await res.json();
  if (det.found) rememberPlaces([det]);
  return det;
}

/** Places seen in this session's results, newest first (for open_page and the cards). @type {any[]} */
let recentPlaces = [];
/** @param {any[]} places */
function rememberPlaces(places) {
  for (const p of places) {
    if (!p || !p.name) continue;
    recentPlaces = [p, ...recentPlaces.filter((q) => q.id !== p.id || q.name !== p.name)].slice(0, 40);
  }
}
/** Every word of the asked name appears in the place name (as a word prefix). */
function placeNameMatches(asked, name) {
  const words = String(asked).toLowerCase().match(/[a-z0-9']+/g) || [];
  const have = String(name).toLowerCase().match(/[a-z0-9']+/g) || [];
  const skip = new Set(["the", "a", "an", "and", "of", "at", "in", "on", "by"]);
  const wanted = words.filter((w) => !skip.has(w));
  return wanted.length > 0 && wanted.every((w) => have.some((h) => h.startsWith(w)));
}
/** @param {string} name @param {string} [area] */
function findRecentPlace(name, area) {
  let hits = recentPlaces.filter((p) => placeNameMatches(name, p.name));
  if (area) {
    const words = String(area).toLowerCase().match(/[a-z0-9]+/g) || [];
    const preferred = hits.filter((p) => words.every((w) => String(p.address || "").toLowerCase().includes(w)));
    if (preferred.length) hits = preferred;
  }
  return hits[0] ?? null;
}

/** Open a URL in a new tab; false when the browser blocked the popup (no user gesture).
 *  No "noopener" feature here: with it window.open returns null even when the tab
 *  opened, which made every open look blocked. The opener is cleared by hand instead.
 *  @param {string} url */
function openExternal(url) {
  const w = window.open(url, "_blank");
  if (!w) return false;
  try { w.opener = null; } catch { /* cross-origin: already detached */ }
  return true;
}

/** @param {Record<string, unknown>} args @returns {Promise<{ text: string, url?: string, kind?: string, name?: string, opened?: boolean }>} */
async function openPlacePage(args) {
  const kind = typeof args.kind === "string" ? args.kind : "";
  const name = typeof args.name === "string" ? args.name.trim() : "";
  const area = typeof args.area === "string" ? args.area.trim() : "";
  if (!["website", "reviews", "directions"].includes(kind)) return { text: `Unknown page kind ${JSON.stringify(kind)}; use website, reviews or directions.` };
  if (!name) return { text: "No restaurant name given." };
  let place = findRecentPlace(name, area);
  if (!place || (kind === "website" && !place.website)) {
    const det = await execDetails({ name, area });
    if (!det.found) return { text: det.text };
    place = det;
  }
  const url = kind === "website" ? place.website : kind === "reviews" ? place.reviews_url : place.directions_url;
  if (!url) return { text: `${place.name} has no ${kind === "website" ? "website listed" : kind + " link"}.` };
  const opened = openExternal(url);
  const label = kind === "website" ? "website" : kind === "reviews" ? "Google reviews" : "directions";
  return {
    text: opened
      ? `Opened the ${label} for ${place.name} in a new tab.`
      : `The browser blocked the new tab; a link to the ${label} for ${place.name} is shown on screen for the user to tap.`,
    url, kind, name: place.name, opened,
  };
}

/** Mute the mic until the user taps the mic button, with a caption saying why. @param {string} caption */
function hardMute(caption) {
  if (!micStream || !client) return false;
  hardMuted = true;
  hardMuteCaption = caption;
  setMicMuted(true);
  setCaption(caption, "muted");
  return true;
}
/** Mute the mic for a phone call the page just started; the user unmutes with the mic button. */
function muteForCall() {
  hardMute(CALL_MUTE_CAPTION);
}

/** The set_listening tool: standby (wake word), normal, or muted. @param {string} mode */
function applyListeningMode(mode) {
  const current = currentPersonaId();
  const who = current ? PERSONAS[current].name : "the assistant";
  if (mode === "standby") {
    setWakeEnabled(true);
    console.log("[listening] standby");
    return `Standby is on: ${who} now answers only when addressed by name (${wakeWordsFor(current ?? "").join(", ") || "its name"}), and for a short while after each reply. The server enforces this: turns that are not for you never reach you, so answer every turn you do receive normally and never reply with silence or dots. This is not a persona hand-off: you stay ${who}; do not call switch_persona. Confirm in a few words, or say nothing more if you already confirmed.`;
  }
  if (mode === "normal") {
    setWakeEnabled(false);
    console.log("[listening] normal");
    return `Normal listening: ${who} answers everything again. Not a hand-off: you stay ${who}. Confirm in a few words, or say nothing more if you already confirmed.`;
  }
  if (mode === "muted") {
    const ok = hardMute(HARD_MUTE_CAPTION);
    console.log("[listening] muted", ok);
    return ok
      ? "The microphone is now off. The user must tap the mic button to unmute; they cannot wake you by voice. Say goodbye briefly and mention the mic button. You will be told when the microphone is on again; until then you will simply receive nothing, so if you do receive a turn, the mic is on and you should answer it normally."
      : "Could not mute: no live microphone.";
  }
  return mode
    ? `Unknown listening mode ${JSON.stringify(mode)}; use standby, normal or muted. Nothing changed.`
    : "No mode given, so nothing changed. Only call set_listening when the user asks to change how you listen, and pass standby, normal or muted.";
}
/** @param {boolean} muted */
function setMicMuted(muted) {
  micMuted = muted;
  syncMicMuteState();
  micBtn.classList.toggle("muted", micMuted);
  micBtn.setAttribute("aria-label", micMuted ? "Unmute" : "Mute");
  micBtn.title = micMuted ? "Unmute" : "Mute";
  circleBtn.classList.toggle("muted", micMuted); // grey orb, no listening bars
  renderWakeToggle();
}
// A tap on any phone link (the cards) starts a call too: mute the same way.
document.addEventListener("click", (e) => {
  const a = /** @type {HTMLElement | null} */ (e.target instanceof Element ? e.target.closest('a[href^="tel:"]') : null);
  if (a) muteForCall();
});

/** Hand a number to the browser's phone handler (Google Voice, FaceTime, ...) via a tel: link.
 *  The user still presses Call there, so nothing dials by itself.
 *  @param {Record<string, unknown>} args */
function placeCall(args) {
  const raw = typeof args.number === "string" ? args.number : "";
  const digits = raw.replace(/[^\d+]/g, "");
  if (digits.replace(/\D/g, "").length < 7) return `That does not look like a phone number: ${JSON.stringify(raw)}.`;
  const who = typeof args.name === "string" && args.name.trim() ? args.name.trim() : "the number";
  const a = document.createElement("a");
  a.href = `tel:${digits}`;
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  a.remove();
  muteForCall();
  console.log(`[call] tel:${digits} (${who}); mic muted for the call`);
  return `Opened the phone dialer for ${who} at ${raw}. The user completes the call there; if nothing opened, the browser has no phone handler set up. The microphone is muted while they are on the call, so do not expect to hear them until they unmute.`;
}

/** @param {Record<string, unknown>} args @returns {Promise<{ text: string, found: boolean, name?: string, address?: string, inspections?: unknown[] }>} */
async function execInspections(args) {
  const name = typeof args.name === "string" ? args.name.trim() : "";
  if (!name) return { text: "No restaurant name given.", found: false };
  /** @type {Record<string, unknown>} */
  const body = { name };
  if (typeof args.area === "string" && args.area.trim()) body.area = args.area.trim();
  if (typeof args.limit === "number") body.limit = args.limit;
  const res = await fetch("api/restaurant_inspections", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let detail = String(res.status);
    try { const j = await res.json(); if (j.detail) detail = j.detail; } catch {}
    throw new Error(`inspection lookup error (${detail})`);
  }
  return await res.json();
}

/** @param {string} url @returns {Promise<string>} */
async function execWebFetch(url) {
  if (!url) return "No URL provided.";
  const res = await fetch("api/fetch", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url }),
  });
  if (!res.ok) {
    let detail = String(res.status);
    try { const j = await res.json(); if (j.detail) detail = j.detail; } catch {}
    throw new Error(`fetch error (${detail})`);
  }
  const json = await res.json();
  const today = new Date().toISOString().slice(0, 10);
  const head = `Page text fetched ${today} from ${json.url}${json.title ? ` — ${json.title}` : ""}:`;
  const body = json.content || "(no readable text)";
  return `${head}\n${body}${json.truncated ? "\n[page text truncated]" : ""}`;
}

/** Learn server config (search key + connection target), then refresh the UI. */
/** The asset version this tab actually runs (from this module's own URL). */
const PAGE_ASSET_VERSION = new URL(import.meta.url).searchParams.get("v") || "";
const buildStamp = /** @type {HTMLButtonElement} */ ($("#build-stamp"));

/** @param {{ assetVersion?: string; commit?: string; updated?: string } | undefined} build */
function renderBuildStamp(build) {
  if (!buildStamp) return;
  const version = PAGE_ASSET_VERSION.replace(/^audio-24k-/, "") || "dev";
  const stale = !!build?.assetVersion && build.assetVersion !== PAGE_ASSET_VERSION;
  let when = "";
  if (build?.updated) {
    const d = new Date(build.updated);
    when = d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  }
  const parts = [`build ${version}`];
  if (build?.commit) parts.push(build.commit);
  if (when) parts.push(`updated ${when}`);
  buildStamp.textContent = stale ? `${parts.join(" · ")} — newer build served, click to reload` : parts.join(" · ");
  buildStamp.classList.toggle("stale", stale);
  buildStamp.disabled = false;
}
buildStamp?.addEventListener("click", () => {
  if (buildStamp.classList.contains("stale")) location.reload();
});

async function fetchConfig() {
  try {
    const res = await fetch("api/config");
    if (res.ok) {
      const json = await res.json();
      renderBuildStamp(json.build);
      serverSearchKey = !!json.search;
      serverFetch = !!json.fetch;
      serverRestaurants = !!json.restaurants;
      serverInspections = !!json.inspections;
      lbMode = !!json.lb;
      // Lock to LB mode only when the deploy reports a load balancer.
      allowDirect = json.allowDirect ?? !lbMode;
      // Deploy-pinned direct URL (overrides the LB server-side already).
      pinnedUrl = (json.s2sUrl || "").trim();
      // WebRTC transport: offered only when the deploy pins the URL (the
      // /api/calls proxy refuses to forward anywhere else).
      rtcAvailable = !!json.rtc;
      iceServers = Array.isArray(json.iceServers) ? json.iceServers : [];
      startupGreeting = typeof json.startupGreeting === "string"
        ? json.startupGreeting.trim()
        : "";
      // The conversation-time limiter rides on the LB being present.
      limiterOn = lbMode;
    }
    // Non-OK response: leave the fail-open default (allowDirect = true).
  } catch {
    // Config endpoint unreachable (e.g. static hosting): keep direct entry.
  }
  if (DEBUG) console.debug(`[ui] config: allowDirect=${allowDirect} lbMode=${lbMode}`);
  // Login chip + remaining-budget (no-op / hidden when the limiter is off).
  void account.refresh();
  syncToolsUi();
  syncConnectionUi();
}

/**
 * Resolve where to connect, per the deploy's mode:
 *   • LB mode  -> `{ sessionUrl }`, the client POSTs the same-origin /api/session
 *     proxy and the server forwards to the LB (its address stays server-side).
 *   • direct   -> `{ directUrl }`, connect straight to the s2s WebSocket.
 * Throws a user-facing error if direct mode is on but no URL was entered.
 * @returns {{ sessionUrl: string } | { directUrl: string }}
 */
function connectionTarget() {
  if (!allowDirect) {
    return { sessionUrl: "api/session" };
  }
  const directUrl = buildDirectWsUrl(pinnedUrl || settings.directUrl);
  if (!directUrl) {
    throw new Error("Enter a speech-to-speech server URL in Settings.");
  }
  return { directUrl };
}

/**
 * Normalise a user-typed server address into a realtime WebSocket URL.
 * Accepts bare hosts (`localhost:8080`), http(s) URLs, or ws(s) URLs, and adds
 * the `/v1/realtime` path when none is given. A full connect URL (with path
 * and/or query) is preserved as-is.
 * @param {string} raw @returns {string}
 */
function buildDirectWsUrl(raw) {
  let s = (raw || "").trim();
  if (!s) return "";
  if (!/^wss?:\/\//i.test(s)) {
    if (/^https?:\/\//i.test(s)) {
      s = s.replace(/^http/i, "ws"); // http→ws, https→wss
    } else {
      const isLocal = /^(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(s);
      s = (isLocal ? "ws://" : "wss://") + s;
    }
  }
  try {
    const u = new URL(s);
    if (u.pathname === "" || u.pathname === "/") u.pathname = "/v1/realtime";
    return u.toString();
  } catch {
    return s;
  }
}

/** Create + resume an AudioContext synchronously (must run inside the user
 *  gesture so iOS lets it start). Returns null if construction fails. */
function createResumedAudioContext() {
  try {
    const Ctx = window.AudioContext || /** @type {any} */ (window).webkitAudioContext;
    const ctx = new Ctx({ latencyHint: "interactive" });
    if (ctx.state === "suspended") void ctx.resume().catch(() => {});
    return /** @type {AudioContext} */ (ctx);
  } catch (err) {
    console.warn("[main] AudioContext init failed:", err);
    return null;
  }
}

/** Read the editable settings out of the form. The URL field is only honoured
 *  in free direct mode — in LB mode it's hidden, and when the deploy pins a
 *  URL it's read-only, so the user's saved URL survives either way. The
 *  transport select is only honoured while selectable, so a saved "webrtc"
 *  survives a visit to a deploy that can't offer it. */
function readSettingsFromForm() {
  return {
    directUrl: allowDirect && !pinnedUrl ? inputLbUrl.value.trim() : settings.directUrl,
    voice: inputVoice.value.trim() || DEFAULT_VOICE,
    instructions: inputInstructions.value.trim() || DEFAULT_INSTRUCTIONS,
    personaMode: currentPersonaMode(),
    noiseGate: readGateThreshold(),
    transport: /** @type {"ws" | "webrtc"} */ (
      transportSelectable()
        ? (inputTransport.value === "webrtc" ? "webrtc" : "ws")
        : settings.transport
    ),
    audioInputId: inputAudioInput.value || "",
    audioOutputId: inputAudioOutput.value || "",
  };
}

/** Gate threshold (dBFS) currently shown on the slider, clamped to range. */
function readGateThreshold() {
  const v = Math.round(Number(inputNoiseGate.value));
  if (!Number.isFinite(v)) return GATE_OFF_DB;
  return Math.min(GATE_MAX_DB, Math.max(GATE_OFF_DB, v));
}

/** Whether the transport picker is live: env-pinned direct mode only. The
 *  /api/calls proxy forwards exclusively to SPEECH_TO_SPEECH_URL, so without
 *  the pin there is nowhere safe to send a WebRTC offer. */
function transportSelectable() {
  return allowDirect && !!pinnedUrl && rtcAvailable;
}

/** The transport the next conversation will actually use. */
function effectiveTransport() {
  return transportSelectable() && settings.transport === "webrtc" ? "webrtc" : "ws";
}

/** Reflect transport availability + selection into Settings, and hide the
 *  noise gate when WebRTC is picked (the gate lives in the WS capture
 *  worklet; the WebRTC mic path sends the raw track). */
function syncTransportUi() {
  // Hidden in LB mode (nothing to choose); visible-but-locked in un-pinned
  // direct mode so the option is discoverable along with what unlocks it.
  transportField.hidden = !allowDirect;
  const selectable = transportSelectable();
  inputTransport.disabled = !selectable;
  inputTransport.value = selectable && settings.transport === "webrtc" ? "webrtc" : "ws";
  transportHint.textContent = selectable
    ? "How audio travels to the server. Applies on the next conversation."
    : "WebRTC needs a server URL pinned by the deployment (SPEECH_TO_SPEECH_URL).";
  gateField.hidden = effectiveTransport() === "webrtc";
}

/** Adapt the connection field to the mode learned from /api/config. */
function syncConnectionUi() {
  syncTransportUi();
  if (pinnedUrl) {
    // Deploy-pinned URL: show it, but locked — the deployment owns it.
    connField.hidden = false;
    inputLbUrl.value = pinnedUrl;
    inputLbUrl.readOnly = true;
    connHint.classList.remove("error");
    connHint.textContent = "Speech-to-speech server URL pinned by this deployment.";
  } else if (allowDirect) {
    // Direct mode: the user sets their own s2s server URL.
    connField.hidden = false;
    inputLbUrl.value = settings.directUrl;
    inputLbUrl.readOnly = false;
    inputLbUrl.placeholder = "http://localhost:port";
    connHint.classList.remove("error");
    connHint.textContent =
      "URL of your speech-to-speech server, e.g. http://localhost:8080 (the app adds /v1/realtime).";
  } else {
    // LB mode: the load balancer URL is deployment-owned — hide it entirely so
    // its address is never exposed in Settings.
    connField.hidden = true;
  }
}

/** True when the user must supply a server URL before connecting (direct mode
 *  with nothing set). */
function missingServerUrl() {
  return allowDirect && !pinnedUrl && !buildDirectWsUrl(settings.directUrl);
}

/** Open Settings and point the user at the empty server-URL field. */
function promptServerUrl() {
  if (settingsModal.open) syncConnectionUi();
  else openSettings();
  connHint.textContent = "Set the speech-to-speech server URL to start.";
  connHint.classList.add("error");
  inputLbUrl.focus();
}

settingsForm.addEventListener("submit", (event) => {
  const submitter = /** @type {HTMLButtonElement | null} */ ((/** @type {SubmitEvent} */ (event)).submitter);
  if (submitter?.value !== "save") return;

  settings = readSettingsFromForm();
  saveSettings(settings);
  profile = /** @type {Profile} */ ({
    ...Object.fromEntries(PROFILE_KEYS.map((k) => [k, profileInputs[k].value.trim()])),
    nicknameOk: profileNicknameOk.checked,
  });
  saveProfile(profile);

  // Voice + instructions can apply to a live session without reconnecting; a
  // changed connection URL only takes effect on the next restart. Speaker
  // output can switch live when the browser supports AudioContext.setSinkId;
  // mic device changes need a Restart (new getUserMedia stream).
  chat.setAssistantName(PERSONAS[currentPersonaId() ?? ""]?.name ?? "Assistant");
  renderWakeToggle();
  sendWakeConfig();
  if (client && LIVE_STATES.has(currentState)) {
    client.updateSession({ voice: settings.voice, instructions: settings.instructions });
    if (typeof client.setAudioOutputDevice === "function") {
      void client.setAudioOutputDevice(settings.audioOutputId);
    }
  }
});

// The noise gate applies live (worklet param), so tune it without a restart:
// update the label/marker, persist, and push straight to the running client.
inputNoiseGate.addEventListener("input", () => {
  setGateThreshold(readGateThreshold());
});

// Transport persists on change (like the gate) and takes effect on the next
// conversation; the gate field previews its WS-only availability right away.
inputTransport.addEventListener("change", () => {
  if (!transportSelectable()) return;
  settings.transport = inputTransport.value === "webrtc" ? "webrtc" : "ws";
  localStorage.setItem(STORAGE_KEYS.transport, settings.transport);
  syncTransportUi();
});

restartBtn.addEventListener("click", async () => {
  if (currentState === "connecting") return; // a connect is already underway
  settings = readSettingsFromForm();
  saveSettings(settings);
  if (missingServerUrl()) { promptServerUrl(); return; } // keep settings open
  settingsModal.close();
  // Grab the AudioContext NOW, inside the click gesture — teardown() awaits, and
  // creating it afterwards would fall outside the gesture (silent on iOS).
  const audioContext = createResumedAudioContext();
  try {
    if (client) await teardown();
    await doStart(audioContext);
  } catch (err) {
    await handleStartError(err);
  }
});

circleBtn.addEventListener("click", async () => {
  try {
    if (currentState === "idle" || currentState === "error") {
      if (missingServerUrl()) { promptServerUrl(); return; }
      await doStart();
    }
  } catch (err) {
    await handleStartError(err);
  }
});

/** A failed start is either the daily limit (show the modal, return to idle) or
 *  a real fault (surface it). doStart already closed any orphan AudioContext.
 *  @param {any} err */
async function handleStartError(err) {
  if (err && err.code === "login-required") {
    await teardown();
    setState("error");
    setCaption("Sign in again to continue.", "error");
    account.showLoginRequired(err.loginUrl);
    return;
  }
  if (err && err.code === "limit") {
    await teardown();
    account.showLimit(err.tier);
    return;
  }
  // The user left the queue (close() aborted the wait): teardown already reset
  // the UI to idle, so there's nothing to report.
  if (err && err.code === "aborted") return;
  // The whole waiting line is full: a warm, reassuring modal rather than an error.
  if (err && err.code === "queue-full") {
    await teardown();
    account.showBusy();
    return;
  }
  // Our place lapsed (ticket reaped, or the join window ran out). Recoverable, not
  // a fault: land on the retry state with a kind, plain-language reason.
  if (err && (err.code === "queue-expired" || err.code === "join-expired")) {
    await teardown();
    setState("error");
    setCaption(
      err.code === "join-expired"
        ? "Your spot expired. Tap to rejoin."
        : "That took a while. Tap to rejoin.",
      "error",
    );
    return;
  }
  await onFatalError(err);
}

micBtn.addEventListener("click", () => {
  if (!micStream || !client) return;
  setMicMuted(!micMuted);
  if (!micMuted && hardMuted) {
    hardMuted = false;
    hardMuteCaption = "";
    setCaption(STATE_VIEWS[currentState]?.caption ?? "", "");
    // The model was told the mic was off; tell it the user switched it back on,
    // otherwise it keeps insisting it cannot hear them.
    client?.sendUserNote("(Note, not spoken by the user: they tapped the mic button. The microphone is on again and you can hear them normally.)");
  }
});

stopBtn.addEventListener("click", async () => {
  await teardown();
});

// "Leave queue": tear down the pending connect (aborts the poll wait) and drop
// our place in line. Same teardown path as stopping a live call.
leaveQueueBtn.addEventListener("click", async () => {
  await teardown();
});

// "Join now": accept the held slot. The click is a user gesture, so the client
// re-resumes the AudioContext here (iOS) before dialing.
joinQueueBtn.addEventListener("click", () => {
  stopJoinCountdown();
  if (client) client.join();
});

const MIC_CONSTRAINTS_BASE = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
};

/** @returns {MediaStreamConstraints} */
function micConstraints() {
  /** @type {MediaTrackConstraints} */
  const audio = { ...MIC_CONSTRAINTS_BASE };
  if (settings.audioInputId) {
    // ideal (not exact): if the saved device was unplugged, fall back quietly.
    audio.deviceId = { ideal: settings.audioInputId };
  }
  return { audio };
}

/** True when Web Audio can route playback to a chosen output device. */
function supportsAudioOutputSelection() {
  const Ctx = window.AudioContext || /** @type {any} */ (window).webkitAudioContext;
  return typeof Ctx?.prototype?.setSinkId === "function";
}

/**
 * Rebuild the mic/speaker <select>s from enumerateDevices. Labels are blank
 * until mic permission has been granted at least once.
 */
async function refreshAudioDeviceLists() {
  const canPickOutput = supportsAudioOutputSelection();
  inputAudioOutput.disabled = !canPickOutput;
  audioOutputHint.textContent = canPickOutput
    ? "Where assistant audio plays. Can change live while connected."
    : "Speaker selection needs a browser with AudioContext.setSinkId (Chrome/Edge).";

  /** @type {MediaDeviceInfo[]} */
  let devices = [];
  try {
    devices = await navigator.mediaDevices.enumerateDevices();
  } catch (err) {
    console.warn("[main] enumerateDevices failed:", err);
  }

  const inputs = devices.filter((d) => d.kind === "audioinput");
  const outputs = devices.filter((d) => d.kind === "audiooutput");
  const labelsReady = devices.some((d) => d.label);

  fillDeviceSelect(inputAudioInput, inputs, settings.audioInputId, "Microphone");
  fillDeviceSelect(inputAudioOutput, outputs, settings.audioOutputId, "Speaker");

  if (!labelsReady) {
    // Permission unlocks real device names; keep it quiet — user can tap Start
    // or we unlock when they already connected once this session.
    const hint = inputAudioInput.parentElement?.querySelector("small");
    if (hint) {
      hint.textContent =
        "Allow microphone access (tap Start once) to see device names. Mic changes apply on Restart.";
    }
  } else {
    const hint = inputAudioInput.parentElement?.querySelector("small");
    if (hint) hint.textContent = "Applies on the next conversation (or Restart).";
  }
}

/**
 * @param {HTMLSelectElement} select
 * @param {MediaDeviceInfo[]} devices
 * @param {string} selectedId
 * @param {string} fallbackLabel
 */
function fillDeviceSelect(select, devices, selectedId, fallbackLabel) {
  const prev = selectedId || select.value || "";
  select.replaceChildren();
  const def = document.createElement("option");
  def.value = "";
  def.textContent = "System default";
  select.appendChild(def);
  devices.forEach((d, i) => {
    const opt = document.createElement("option");
    opt.value = d.deviceId;
    opt.textContent = d.label || `${fallbackLabel} ${i + 1}`;
    select.appendChild(opt);
  });
  // Keep a saved id even if it isn't currently listed (unplugged); browser
  // will fall back via ideal constraints / setSinkId errors.
  if (prev && ![...select.options].some((o) => o.value === prev)) {
    const missing = document.createElement("option");
    missing.value = prev;
    missing.textContent = `${fallbackLabel} (saved, not found)`;
    select.appendChild(missing);
  }
  select.value = prev;
  if (select.value !== prev) select.value = "";
}

if (navigator.mediaDevices?.addEventListener) {
  navigator.mediaDevices.addEventListener("devicechange", () => {
    if (settingsModal.open) void refreshAudioDeviceLists();
  });
}

/** Prompt for mic permission up front, then immediately release the tracks so no
 *  recording indicator lingers during a queue wait. Throws a friendly error if the
 *  user denies. */
async function primeMicPermission() {
  try {
    const s = await navigator.mediaDevices.getUserMedia(micConstraints());
    for (const track of s.getTracks()) track.stop();
  } catch (err) {
    throw new Error(
      `Microphone access denied${err instanceof Error ? `: ${err.message}` : ""}`,
    );
  }
}

/** Acquire the live capture stream once a slot is granted. Permission was primed
 *  in the tap gesture, so this is silent. Stored module-side for mute + teardown. */
async function acquireMicStream() {
  micStream = await navigator.mediaDevices.getUserMedia(micConstraints());
  return micStream;
}

/** @param {number} position Update the queued caption ("You're #N in line"). */
function onQueuePosition(position) {
  const n = Number(position) || 0;
  setCaption(n > 0 ? `You're #${n} in line` : "Finding you a spot…", "muted");
}

// ── "Your turn" join countdown ──────────────────────────────────────────────
// While a slot is held for us, show how long is left to accept it. The client's
// join gate expires just before the load balancer reclaims the slot.
let joinCountdownTimer = 0;

/** @param {number} sec */
function startJoinCountdown(sec) {
  stopJoinCountdown();
  let left = Math.max(0, Math.floor(sec));
  const paint = () => {
    joinQueueBtn.textContent = left > 0 ? `Join now (${left}s)` : "Join now";
  };
  paint();
  joinCountdownTimer = window.setInterval(() => {
    left -= 1;
    if (left <= 0) {
      stopJoinCountdown();
      joinQueueBtn.textContent = "Join now";
      return;
    }
    paint();
  }, 1000);
}

function stopJoinCountdown() {
  if (joinCountdownTimer) {
    clearInterval(joinCountdownTimer);
    joinCountdownTimer = 0;
  }
}

/**
 * Start a conversation. Pass a pre-created AudioContext when the caller already
 * made one inside the tap/click gesture (required on iOS); otherwise one is
 * created here, which is still inside the gesture for a direct orb tap.
 * @param {AudioContext | null} [audioContext]
 */
async function doStart(audioContext = null) {
  const transport = effectiveTransport();
  // Resolve the target before touching mic/audio so a misconfiguration (e.g.
  // direct mode with no URL) fails fast with a clear message. Over WebRTC the
  // browser never dials the s2s server itself — the offer goes to the
  // same-origin /api/calls proxy — so there is no target to resolve.
  const target = transport === "webrtc" ? null : connectionTarget();
  activeTransport = transport;
  // The radial gate arc (threshold handle around the mic button) is a WS
  // feature; over WebRTC only the mute button remains.
  document.body.classList.toggle("rtc-live", transport === "webrtc");

  chat.clear();
  chat.reset();
  chat.setAssistantName(PERSONAS[currentPersonaId() ?? ""]?.name ?? "Assistant");
  pendingPersona = null;
  wakeConfigSent = false;
  replyAfterResponse = false;
  switchedThisResponse = false;
  spokenThisResponse = false;
  heldPersona = null;
  heldResponses = 0;
  handoffWaitToken += 1;
  lastOutputAudibleAt = 0;
  promisedPersona = null;
  offeredPersona = null;
  setState("connecting");
  setCaption("Asking for mic…", "muted");
  beginWarmup();

  // Create + resume the AudioContext SYNCHRONOUSLY, still inside the gesture.
  // iOS Safari only starts an AudioContext from a user gesture; if we waited
  // until after the getUserMedia / session-creation awaits below, it would stay
  // suspended and the whole pipeline would be silent.
  if (!audioContext) audioContext = createResumedAudioContext();

  // Prime the mic permission now (get the prompt out of the way up front), then
  // release it. The real capture stream is acquired only once a slot is granted
  // (see acquireMicStream), so the mic 'in use' indicator never lights while we
  // sit in the queue. Permission persists, so the later acquire is silent.
  try {
    await primeMicPermission();
  } catch (err) {
    if (audioContext) void audioContext.close().catch(() => {});
    throw err;
  }

  // The webcam is started on arrival (autoStartCamera), so nothing to do here;
  // a still-pending grant just means the snapshot tool isn't ready yet.

  const common = {
    voice: settings.voice,
    instructions: settings.instructions,
    startupGreeting,
    acquireMic: acquireMicStream,
    tools: activeToolDefs(),
    audioOutputId: settings.audioOutputId || "",
    executeTool: async ({ name, arguments: args, callId }) => {
      if (name !== "switch_persona") chat.onToolCall(name); // the switch announces itself
      const result = await runTool(name, args, callId);
      if (client === c) chat.onToolResult(name, args, result.output, result.image, result.cards);
      return result;
    },
    ...(audioContext ? { audioContext } : {}),
  };
  const c = target === null
    ? new S2sRealtimeClient({
        transport: "webrtc",
        callsUrl: "api/calls",
        iceServers,
        ...common,
      })
    : new S2sRealtimeClient({
        transport: "websocket",
        ...target,
        noiseGate: gateParams(settings.noiseGate),
        ...common,
      });
  client = c;
  c.setMuted(micMuted || userAudioReplaying);

  c.addEventListener("queue", (e) => {
    const { position, queueId } = /** @type {CustomEvent<{ position: number; queueId: string }>} */ (e).detail;
    if (queueId) queuedTicketId = queueId;
    onQueuePosition(position);
  });

  c.addEventListener("ready-to-join", (e) => {
    const { info, expiresSec } = /** @type {CustomEvent<{ info: import("./s2s-realtime-client.js").SessionInfo; expiresSec: number }>} */ (e).detail;
    // A slot is held for us. We're out of the queue now, so drop the ticket ref.
    // Track the granted session id already so that leaving (or letting the timer
    // lapse) refunds the budget the server reserved at claim, even before we dial.
    queuedTicketId = "";
    if (info?.sessionId) {
      trackedSessionId = info.sessionId;
      trackedTier = info.tier || "anon";
    }
    startJoinCountdown(expiresSec);
  });

  c.addEventListener("status", (e) => {
    const detail = /** @type {CustomEvent<{ status: string }>} */ (e).detail;
    onClientStatus(detail.status);
    if (detail.status === "ai-speaking") chat.onAssistantActivity();
  });
  c.addEventListener("transcript", (e) => {
    const d = /** @type {CustomEvent<{ role: "user" | "assistant"; text: string; partial: boolean; itemId?: string; responseId?: string }>} */ (e).detail;
    if (warmingUp && d.role === "assistant") setWarmupStep("Warming up the voice…");
    if (d.role === "assistant") {
      // Label by who actually spoke it: the server stamps each response with
      // its voice, which can differ from the current persona right after a switch.
      const spoken = d.voice && Object.values(PERSONAS).find((p) => p.voice === d.voice);
      d.speaker = spoken ? spoken.name : undefined;
      if (d.text && d.text.trim()) spokenThisResponse = true;
    }
    chat.onTranscript(d);
    if (d.role === "user" && !d.partial && offeredPersona) {
      const offered = offeredPersona;
      offeredPersona = null;
      if (AFFIRM_RE.test(d.text) && offered !== currentPersonaId()) {
        applyPersona(offered, "confirmed");
        return;
      }
    }
    if (d.role === "assistant" && !d.partial) {
      const promise = personaPromisedIn(d.text);
      if (promise && promise.id !== currentPersonaId()) {
        if (promise.offer) offeredPersona = promise.id;
        else promisedPersona = promise.id;
      }
    }
    if (d.role === "user" && !d.partial) {
      // Deterministic hand-off. The reply already in flight belongs to the
      // current persona (its voice is read when the reply is synthesized, so
      // switching now would put the farewell in the wrong voice); apply once
      // that response has finished. If the model calls switch_persona itself
      // first, that wins and the pending request is dropped.
      const wanted = personaRequestedIn(d.text);
      if (wanted && wanted !== currentPersonaId()) {
        if (wakeEnabled) {
          // In wake mode the server does not answer a turn addressed to
          // another persona, so switch now and ask for the reply once that
          // empty response ends.
          applyPersona(wanted, "addressed");
          replyAfterResponse = true;
        } else {
          // Let the current persona answer this turn first: it says goodbye
          // and calls switch_persona itself. Switching before its reply has
          // started would make the model answer as the new persona, with
          // nobody left to say goodbye. Applied when the reply ends if the
          // model did not switch on its own.
          pendingPersona = wanted;
          console.log(`[persona] pending → ${PERSONAS[wanted].name} · asked by name`);
        }
      }
    }
  });
  c.addEventListener("output-level", (e) => {
    const { audible } = /** @type {CustomEvent<{ rms: number; audible: boolean }>} */ (e).detail;
    if (!audible) return;
    lastOutputAudibleAt = performance.now();
    if (warmingUp) endWarmup("first-audio");
    chat.onAssistantAudible();
  });
  c.addEventListener("user-turn-started", (e) => {
    const detail = /** @type {CustomEvent<{ itemId?: string }>} */ (e).detail;
    // The user spoke during a hand-off pause: their turn gets the new persona's
    // reply on its own, so drop the greeting that was waiting.
    handoffWaitToken += 1;
    chat.onUserTurnStarted(detail);
  });
  c.addEventListener("user-turn-stopped", (e) => {
    const detail = /** @type {CustomEvent<{ itemId?: string }>} */ (e).detail;
    chat.onUserTurnStopped(detail);
  });
  c.addEventListener("user-audio", (e) => {
    const detail = /** @type {CustomEvent<{ itemId?: string; audio: Blob; durationMs?: number; truncated?: boolean }>} */ (e).detail;
    chat.onUserAudio(detail);
  });

  c.addEventListener("response-finished", (e) => {
    const detail = /** @type {CustomEvent<{ responseId: string; status: string; audible?: boolean; transcript?: string }>} */ (e).detail;
    chat.onResponseFinished(detail);
    const spoke = detail.audible || !!(detail.transcript && detail.transcript.trim());
    if (heldPersona) {
      // The tool-call response itself ends silently first; the goodbye is the
      // follow-up. Apply after the goodbye, or after two responses regardless.
      heldResponses += 1;
      if (spoke || heldResponses >= 2 || detail.status === "cancelled") {
        const held = heldPersona;
        heldPersona = null;
        heldResponses = 0;
        promisedPersona = null;
        offeredPersona = null;
        switchedThisResponse = false;
        spokenThisResponse = false;
        if (detail.status === "cancelled") {
          // The user talked over the goodbye; they still asked for the switch,
          // and their new turn gets the new persona's reply on its own.
          if (held !== currentPersonaId()) applyPersona(held, "inferred");
        } else {
          switchAndReply(c, held, "inferred");
        }
        return;
      }
    } else if (pendingPersona) {
      const wanted = pendingPersona;
      pendingPersona = null;
      if (wanted !== currentPersonaId()) switchAndReply(c, wanted, "named");
    } else if (promisedPersona && !switchedThisResponse && promisedPersona !== currentPersonaId()) {
      switchAndReply(c, promisedPersona, "promised");
    }
    if (replyAfterResponse) {
      replyAfterResponse = false;
      if (client === c) c.requestResponse();
    } else if (wakeEnabled && detail.status === "completed" && detail.hadOutput === false) {
      // Standby: the server declined this turn (not addressed). It is gone from the
      // model's context; show it as heard-but-not-answered rather than as a question.
      chat.markLastUserTurnUnaddressed();
    }
    promisedPersona = null;
    switchedThisResponse = false;
    spokenThisResponse = false;
  });
  c.addEventListener("error", (e) => {
    const detail = /** @type {CustomEvent<{ error: unknown }>} */ (e).detail;
    void onFatalError(detail.error);
  });
  c.addEventListener("server-error", (e) => {
    // Non-fatal: the backend reported an error mid-session. Log it, keep the
    // socket and the conversation alive (the model can recover on its own).
    const detail = /** @type {CustomEvent<{ error: unknown }>} */ (e).detail;
    const msg = detail.error instanceof Error ? detail.error.message : String(detail.error);
    console.warn("[main] server error (non-fatal):", msg);
  });
  c.addEventListener("session", (e) => {
    const info = /** @type {CustomEvent<{ info: import("./s2s-realtime-client.js").SessionInfo }>} */ (e).detail.info;
    console.log("[ws] session created:", info.sessionId);
    // A slot was granted — we're out of the queue; drop the ticket reference so
    // teardown doesn't try to leave a line we already left.
    queuedTicketId = "";
    // A metered tier (anon / free): heartbeat so the server can extend the
    // reservation and tell us when the daily budget runs out. PRO isn't limited.
    if (info.limited && info.sessionId) {
      trackedSessionId = info.sessionId;
      trackedTier = info.tier || "anon";
      startHeartbeat(info.heartbeatSec || 5);
    }
  });
  c.addEventListener("input-level", (e) => {
    const { rms } = /** @type {CustomEvent<{ rms: number }>} */ (e).detail;
    paintInputLevel(rms);
  });

  try {
    await c.connect();
  } catch (err) {
    // The grant can be refused (402 → limit) or the dial can fail. In LB mode
    // the AudioContext hasn't been adopted by the client yet (the session POST
    // runs first), so close the one we created here to avoid leaking it.
    if (audioContext) void audioContext.close().catch(() => {});
    throw err;
  }
}

// ── Conversation-time heartbeat ─────────────────────────────────────────────

/** Ping the server every `sec` seconds so it can meter the live session; when
 *  it reports the daily budget is spent, cut the call and show the limit modal.
 *  @param {number} sec */
function startHeartbeat(sec) {
  stopHeartbeat();
  heartbeatTimer = window.setInterval(async () => {
    if (!trackedSessionId) return;
    try {
      const res = await fetch("api/session/heartbeat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: trackedSessionId }),
        keepalive: true,
      });
      const json = await res.json().catch(() => ({}));
      if (json.expired) await onLimitReached();
    } catch (err) {
      // A transient network blip shouldn't kill the call; the next tick retries.
      if (DEBUG) console.debug("[ui] heartbeat failed:", err);
    }
  }, Math.max(1, sec) * 1000);
}

function stopHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = 0;
  }
}

/** The server cut the live session: tear down and explain why. */
async function onLimitReached() {
  const tier = trackedTier;
  stopHeartbeat();
  await teardown();
  account.showLimit(tier);
}

/** Tell the server a session ended so it reconciles + refunds the unused chunk.
 *  Uses sendBeacon so it still fires when the tab is closing. */
function endTrackedSession() {
  if (!trackedSessionId) return;
  const body = JSON.stringify({ sessionId: trackedSessionId });
  try {
    const blob = new Blob([body], { type: "application/json" });
    if (!navigator.sendBeacon("api/session/end", blob)) {
      void fetch("api/session/end", {
        method: "POST", headers: { "Content-Type": "application/json" }, body, keepalive: true,
      }).catch(() => {});
    }
  } catch {
    // Best-effort; the server sweep reaps the session anyway.
  }
  trackedSessionId = "";
  trackedTier = "";
}

/** Leave the waiting queue so the LB frees our place. sendBeacon so it still
 *  fires on tab close; the LB also reaps the ticket on TTL as a backstop. */
function endQueueTicket() {
  if (!queuedTicketId) return;
  const body = JSON.stringify({ queueId: queuedTicketId });
  try {
    const blob = new Blob([body], { type: "application/json" });
    if (!navigator.sendBeacon("api/queue/end", blob)) {
      void fetch("api/queue/end", {
        method: "POST", headers: { "Content-Type": "application/json" }, body, keepalive: true,
      }).catch(() => {});
    }
  } catch {
    // Best-effort; the LB reaps the ticket on TTL anyway.
  }
  queuedTicketId = "";
}

// ── Warm-up phase ────────────────────────────────────────────────────────────
// From the tap until the assistant's first audible words the session is
// technically live, but the user is really waiting for the model to wake up
// and the voice to start. Show that as one explicit "Getting ready…" state
// (with the step we're on) instead of the generic thinking dots.
let warmingUp = false;
/** @type {string} */
let warmupStep = "";
/** @type {string} */
let lastClientStatus = "";
let warmupTimeout = 0;
const WARMUP_MAX_MS = 25000;

function beginWarmup() {
  warmingUp = true;
  setWarmupStep("Connecting…");
  clearTimeout(warmupTimeout);
  warmupTimeout = window.setTimeout(() => endWarmup("timeout"), WARMUP_MAX_MS);
}

/** @param {string} step */
function setWarmupStep(step) {
  warmupStep = step;
  if (currentState === "warming") {
    circleSubcaption.textContent = step;
    circleSubcaption.hidden = !step;
  }
}

/** @param {"first-audio" | "no-greeting" | "user-spoke" | "timeout" | "abort"} reason */
function endWarmup(reason) {
  if (!warmingUp) return;
  warmingUp = false;
  warmupStep = "";
  clearTimeout(warmupTimeout);
  warmupTimeout = 0;
  if (reason === "abort") return;
  // Re-render the state we would have shown had we not been warming up.
  if (reason === "first-audio") setState("ai-speaking");
  else if (lastClientStatus) onClientStatus(lastClientStatus);
  if (reason === "no-greeting") setCaption("Ready. Say something.", "muted");
}

/** @param {string} status */
function onClientStatus(status) {
  lastClientStatus = status;
  if (warmingUp) {
    switch (status) {
      case "connected":
        if (!startupGreeting) { endWarmup("no-greeting"); return; }
        setWarmupStep("Waking the model…");
        setState("warming");
        return;
      case "processing":
        if (warmupStep === "Connecting…") setWarmupStep("Waking the model…");
        setState("warming");
        return;
      case "ai-speaking":
        // The server started sending audio; the first audible sample ends warm-up.
        setWarmupStep("Warming up the voice…");
        setState("warming");
        return;
      case "user-speaking":
        endWarmup("user-spoke");
        break; // fall through to the normal handling below
      case "closed":
      case "error":
        endWarmup("abort");
        break;
      default:
        break;
    }
  }
  switch (status) {
    case "creating-session":
    case "connecting":
      setState("connecting");
      break;
    case "queued":
      setState("queued");
      break;
    case "your-turn":
      setState("your-turn");
      break;
    case "connected":
      setState("listening");
      if (!wakeConfigSent) {
        wakeConfigSent = true;
        sendWakeConfig();
      }
      break;
    case "user-speaking":
      setState("user-speaking");
      break;
    case "processing":
      setState("processing");
      chat.onAssistantThinking();
      break;
    case "ai-speaking":
      setState("ai-speaking");
      break;
    case "closed":
      // teardown() will move us to idle
      break;
    case "error":
      setState("error");
      break;
  }
}

async function teardown() {
  endWarmup("abort");
  stopHeartbeat();
  stopJoinCountdown();
  endTrackedSession();
  endQueueTicket();
  chat.reset({ dismiss: true });
  if (client) {
    try {
      await client.close();
    } catch (err) {
      console.warn("[main] error closing client:", err);
    }
    client = null;
  }
  if (micStream) {
    for (const track of micStream.getTracks()) track.stop();
    micStream = null;
  }
  // The webcam is independent of the call lifecycle (it runs while the user is
  // on the page), so we leave it on here — only the camera toggle stops it.
  micMuted = false;
  hardMuted = false;
  hardMuteCaption = "";
  recentPlaces = [];
  micBtn.classList.remove("muted");
  document.body.classList.remove("rtc-live");
  setState("idle");
  // Refresh the chip's remaining-today after the budget moved.
  if (limiterOn) void account.refresh();
}

/** @param {unknown} err */
async function onFatalError(err) {
  endWarmup("abort");
  console.error("[main] fatal:", err);
  const message = err instanceof Error ? err.message : String(err);
  try {
    await teardown();
  } catch (teardownError) {
    console.warn("[main] error during fatal teardown:", teardownError);
  } finally {
    setState("error");
    setCaption(truncateError(message), "error");
  }
}

setState("idle");
chat.renderEmptyState();
renderWakeToggle();
// A tab left open should notice a newer build (it happened during development).
setInterval(() => {
  fetch("api/config").then((r) => (r.ok ? r.json() : null)).then((j) => j && renderBuildStamp(j.build)).catch(() => {});
}, 60000);
initGateArc();
void fetchConfig();
// Start the webcam as soon as the user lands (camera tool defaults on), and
// react to later permission changes (re-grant after a denial re-enables it).
void autoStartCamera();
void watchCameraPermission();

// Reconcile a live session if the tab is closed/hidden mid-call (no teardown).
window.addEventListener("pagehide", () => { endTrackedSession(); endQueueTicket(); });

requestAnimationFrame(() => {
  document.body.classList.remove("booting");
});
