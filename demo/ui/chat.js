// @ts-check
/**
 * ChatView — owns the whole conversation surface: the slide-in history panel,
 * the ephemeral on-orb bubbles, and all the transcript/tool/streaming
 * and user-audio bookkeeping. main.js wires the realtime client's events
 * straight to the `on*` methods here and otherwise doesn't touch chat state.
 *
 * Two parallel surfaces share one shape (see `_buildMessageEl`):
 *   - ephemeral bubbles  (`.bubble` / `.bubble-*`)  fade on a timer
 *   - persistent history (`.hist-msg` / `.hist-*`)  the durable panel log
 *
 * Keying:
 *   - user transcripts by the server's `item_id`; each item owns one row and
 *     receives cumulative UI updates assembled from incremental wire deltas.
 *   - assistant transcripts by `response_id`, so a cancelled speculative reply
 *     can be marked interrupted without erasing what was already shown.
 */

import { $, escHtml, DEBUG } from "./dom.js";

/** One restaurant's contact card: phone (tap to call), website, hours.
 *  @param {unknown} cards */
function renderDetailsCard(cards) {
  const d = /** @type {any} */ (Array.isArray(cards) ? cards[0] : null);
  if (!d || !d.name) return "";
  const phone = d.phone
    ? `<div class="det-row"><span class="det-label">Phone</span><a class="det-call" href="tel:${escHtml(d.phone_dial || d.phone)}">${escHtml(d.phone)}</a></div>`
    : `<div class="det-row"><span class="det-label">Phone</span><span class="det-muted">not listed</span></div>`;
  const site = d.website
    ? `<div class="det-row"><span class="det-label">Web</span><a class="det-link" href="${escHtml(d.website)}" target="_blank" rel="noopener">${escHtml(String(d.website).replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, ""))}</a></div>`
    : "";
  const open = d.open_now === true ? `<span class="det-open">open now</span>` : d.open_now === false ? `<span class="det-closed">closed now</span>` : "";
  const hours = Array.isArray(d.hours) && d.hours.length
    ? `<ul class="det-hours">${d.hours.map((h) => `<li>${escHtml(String(h))}</li>`).join("")}</ul>`
    : "";
  const title = d.maps_url
    ? `<a class="rest-name" href="${escHtml(d.maps_url)}" target="_blank" rel="noopener">${escHtml(d.name)}</a>`
    : `<span class="rest-name">${escHtml(d.name)}</span>`;
  return `<div class="det-card">${title} ${open}<div class="rest-addr">${escHtml(String(d.address || "").split(",")[0])}</div>${phone}${site}${hours}${placeActions({ ...d, website: "", phone: "" })}</div>`;
}

/** One restaurant's recent inspections: a score timeline plus the latest violations.
 *  @param {unknown} cards */
function renderInspectionCard(cards) {
  const h = /** @type {any} */ (Array.isArray(cards) ? cards[0] : null);
  if (!h || !Array.isArray(h.inspections) || h.inspections.length === 0) return "";
  const grade = (s) => (s >= 90 ? "good" : s >= 80 ? "fair" : "poor");
  const scores = h.inspections.map((i) => `<li><span class="rest-score ${grade(Number(i.score))}">${escHtml(String(i.score ?? "—"))}</span><span class="insp-date">${escHtml(i.date || "")}</span><span class="insp-purpose">${escHtml(String(i.purpose || "").toLowerCase())}</span></li>`);
  const latest = (h.inspections[0].violations || []).slice(0, 4);
  const violations = latest.length
    ? `<ul class="insp-violations">${latest.map((v) => `<li>${escHtml(v.description || "violation")}${v.points ? ` <span class="insp-pts">${v.points} pts</span>` : ""}${v.repeat ? ` <span class="insp-repeat">repeat</span>` : ""}</li>`).join("")}</ul>`
    : `<div class="insp-none">No violations at the latest inspection.</div>`;
  return `<div class="insp-card"><div class="rest-name">${escHtml(h.name || "")}</div><div class="rest-addr">${escHtml(h.address || "")}</div><ul class="insp-scores">${scores.join("")}</ul>${violations}</div>`;
}

/** Result cards for tools that return structured rows (find_restaurants).
 *  @param {string} name @param {unknown} cards */
/** Action links shown on place cards: reviews and directions (and the website when known).
 *  @param {any} r */
function placeActions(r) {
  const links = [];
  if (r.website) links.push(`<a href="${escHtml(r.website)}" target="_blank" rel="noopener">Website</a>`);
  if (r.reviews_url) links.push(`<a href="${escHtml(r.reviews_url)}" target="_blank" rel="noopener">Reviews</a>`);
  if (r.directions_url) links.push(`<a href="${escHtml(r.directions_url)}" target="_blank" rel="noopener">Directions</a>`);
  if (r.phone) links.push(`<a href="tel:${escHtml(r.phone_dial || r.phone)}">Call</a>`);
  return links.length ? `<div class="rest-actions">${links.join("")}</div>` : "";
}

/** A single link the model opened (or tried to): tap to open it yourself.
 *  @param {unknown} cards */
function renderLinkCard(cards) {
  const c = /** @type {any} */ (Array.isArray(cards) ? cards[0] : null);
  if (!c || !c.url) return "";
  const label = c.kind === "website" ? "Website" : c.kind === "reviews" ? "Google reviews" : "Directions";
  return `<div class="link-card">${c.opened ? "Opened in a new tab: " : "Tap to open: "}<a href="${escHtml(c.url)}" target="_blank" rel="noopener">${escHtml(label)} for ${escHtml(c.name || "")}</a></div>`;
}

function renderToolCards(name, cards) {
  if (name === "restaurant_inspections") return renderInspectionCard(cards);
  if (name === "open_page") return renderLinkCard(cards);
  if (name === "restaurant_details") return renderDetailsCard(cards);
  if (name !== "find_restaurants" || !Array.isArray(cards) || cards.length === 0) return "";
  const price = (n) => (typeof n === "number" ? "$".repeat(Math.max(1, n)) : "");
  const grade = (s) => (s >= 90 ? "good" : s >= 80 ? "fair" : "poor");
  const rows = cards.map((c) => {
    const r = /** @type {any} */ (c);
    const rating = typeof r.rating === "number" ? `★ ${r.rating.toFixed(1)} <span class="rest-count">(${r.rating_count ?? 0})</span>` : "";
    const dist = typeof r.distance_mi === "number" ? `${r.distance_mi.toFixed(1)} mi` : "";
    const score = typeof r.health_score === "number"
      ? `<span class="rest-score ${grade(r.health_score)}" title="Georgia DPH inspection ${escHtml(r.health_date || "")}">${r.health_score}</span>`
      : `<span class="rest-score none" title="No inspection on file">—</span>`;
    const title = r.maps_url
      ? `<a class="rest-name" href="${escHtml(r.maps_url)}" target="_blank" rel="noopener">${escHtml(r.name || "")}</a>`
      : `<span class="rest-name">${escHtml(r.name || "")}</span>`;
    const meta = [rating, price(r.price_level), dist, r.open_now ? "open now" : ""].filter(Boolean).join(" · ");
    return `<li class="rest-card">${score}<div class="rest-main">${title}<div class="rest-meta">${meta}</div><div class="rest-addr">${escHtml(String(r.address || "").split(",")[0])}</div>${placeActions(r)}</div></li>`;
  });
  return `<ul class="rest-list">${rows.join("")}</ul>`;
}

// How long an assistant bubble stays after the last audible word.
const ASSISTANT_LINGER_AFTER_SPEECH_MS = 3000;
/** A cards bubble (restaurant results) is something to look at, not just read: it stays
 *  while the reply is spoken and well after, unless the user dismisses it. */
const CARDS_LINGER_MS = 45000;
const CARDS_LINGER_AFTER_SPEECH_MS = 25000;
// Breeze vocal cues the model may emit; spoken, but not worth showing as text.
const VOCAL_CUE_RE = /\((?:laugh|chuckle|sigh|clears throat|cough)\)\s*/gi;
/** @param {string} text */
function stripVocalCues(text) {
  return typeof text === "string" ? text.replace(VOCAL_CUE_RE, "").trim() : text;
}
// Upper bound on a thinking placeholder that never got a reply or an end event.
const THINKING_FAILSAFE_MS = 30000;

const WRENCH_PATH = `<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>`;
const CHAT_BUBBLE_SVG = `<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>`;
const EMPTY_STATE_HTML = `<div id="chat-empty" class="chat-empty">${CHAT_BUBBLE_SVG}<span class="chat-empty-title">No messages yet</span><span class="chat-empty-hint">Tap the orb and start talking</span></div>`;

export class ChatView {
  /**
   * @param {{ onUserAudioPlaybackChange?: (playing: boolean) => void }} [options]
   */
  constructor(options = {}) {
    /** @type {HTMLButtonElement} */
    this._chatBtn = $("#chat-btn");
    /** @type {HTMLSpanElement} */
    this._chatBadge = $("#chat-badge");
    /** @type {HTMLDivElement} */
    this._chatPanel = $("#chat-panel");
    /** @type {HTMLDivElement} */
    this._chatPanelBackdrop = $("#chat-panel-backdrop");
    /** @type {HTMLButtonElement} */
    this._chatPanelClose = $("#chat-panel-close");
    /** @type {HTMLDivElement} */
    this._chatHistory = $("#chat-history");
    /** @type {HTMLDivElement} */
    this._bubbleStack = $("#bubble-stack");

    this._panelOpen = false;
    this._scrollQueued = false;

    // ── User transcript state (keyed by item_id) ───────────────────────────
    /** @type {Map<string, HTMLElement>} */
    this._userHistByItem = new Map();
    /** @type {Map<string, { audio: HTMLAudioElement, url: string }>} */
    this._userAudioByItem = new Map();
    /** @type {Set<string>} */
    this._audioUrls = new Set();
    /** @type {HTMLAudioElement | null} */
    this._activeUserAudio = null;
    this._onUserAudioPlaybackChange = options.onUserAudioPlaybackChange ?? (() => {});
    /** @type {HTMLElement | null} */
    this._activeUserBubble = null;
    this._activeUserItemId = "";
    // RTC media and data-channel events are not ordered relative to each other.
    // Remember the item whose placeholder assistant activity dismissed so a
    // later speech_stopped event cannot recreate it as "Sending voice...".
    this._assistantDismissedUserItemId = "";
    // Monotonic counter for synthesizing unique keys when the server omits an
    // item_id / response_id, so id-less messages never collapse onto each other.
    this._anonSeq = 0;

    // ── Assistant transcript state (keyed by response_id) ──────────────────
    /** @type {Map<string, { bubble: HTMLElement, hist: HTMLElement }>} */
    this._asstByResp = new Map();
    /** The assistant bubble currently being spoken; kept alive while audio plays.
     *  @type {HTMLElement | null} */
    this._latestAsstBubble = null;
    /** Placeholder shown while the assistant is composing; the transcript
     *  fills it in rather than stacking a second bubble.
     *  @type {HTMLElement | null} */
    this._thinkingBubble = null;
    /** A tool ran during the current thinking spell: the reply is still coming
     *  in a follow-up response, so keep the dots across the response boundary. */
    this._thinkingSawTool = false;
    /** Label for assistant bubbles and history rows: the speaking persona's name. */
    this._assistantName = "Assistant";
    /** Tool chips shown during the current reply; dismissed when its text arrives.
     *  @type {HTMLElement[]} */
    this._toolBubbles = [];
    /** The live cards bubble (tool results with structured rows), if one is showing.
     *  @type {HTMLElement | null} */
    this._cardsBubble = null;

    // ── Ephemeral bubble auto-dismiss ──────────────────────────────────────
    // Per-element expiry (epoch ms). A bubble fades once its expiry passes —
    // but only in stack order (see _reapBubbles). Refreshing the expiry keeps a
    // bubble alive while it updates (e.g. the live user utterance).
    /** @type {WeakMap<HTMLElement, number>} */
    this._bubbleExpiry = new WeakMap();
    // Single pending reaper handle: one timer for the whole stack (not one per
    // bubble) so dismissal is strictly oldest-first regardless of per-bubble delays.
    this._reaperHandle = 0;

    this._chatBtn.addEventListener("click", () => (this._panelOpen ? this._closePanel() : this._openPanel()));
    this._chatPanelClose.addEventListener("click", () => this._closePanel());
    this._chatPanelBackdrop.addEventListener("click", () => this._closePanel());
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && this._panelOpen) this._closePanel();
    });
  }

  // ── Panel ───────────────────────────────────────────────────────────────

  _openPanel() {
    this._panelOpen = true;
    this._chatPanel.classList.add("open");
    this._chatBadge.classList.remove("visible");
    this._scrollToBottom();
  }

  _closePanel() {
    this._panelOpen = false;
    this._chatPanel.classList.remove("open");
  }

  // Coalesce scroll-to-bottom: a burst of cumulative transcript deltas would
  // otherwise queue one rAF per delta, all writing the same scrollTop.
  _scrollToBottom() {
    if (!this._panelOpen || this._scrollQueued) return;
    this._scrollQueued = true;
    requestAnimationFrame(() => {
      this._scrollQueued = false;
      this._chatHistory.scrollTop = this._chatHistory.scrollHeight;
    });
  }

  _markUnread() {
    if (this._panelOpen) {
      this._scrollToBottom();
      return;
    }
    this._chatBadge.classList.add("visible");
  }

  // ── Shared rendering ──────────────────────────────────────────────────────

  /**
   * Build a role-labelled message element. Ephemeral bubbles and persistent
   * history rows share the same shape and differ only in their class prefix
   * (`bubble`/`bubble-*` vs `hist-msg`/`hist-*`).
   * @param {{ container: string, prefix: string, role: "user"|"assistant", text: string, partial?: boolean }} o
   * @returns {HTMLElement}
   */
  /** @param {string} name */
  setAssistantName(name) {
    this._assistantName = (name || "").trim() || "Assistant";
  }

  /** @param {HTMLElement} el @param {string} [name] */
  _relabel(el, name) {
    const role = el.querySelector(".bubble-role, .hist-role");
    if (role) role.textContent = name || this._assistantName;
  }

  _buildMessageEl({ container, prefix, role, text, partial = false }) {
    text = stripVocalCues(text);
    const el = document.createElement("div");
    el.className = `${container} ${role}`;
    const label = role === "user" ? "You" : this._assistantName;
    el.innerHTML = `<div class="${prefix}-role">${label}</div><div class="${prefix}-body${partial ? " partial" : ""}"${text ? "" : " hidden"}>${escHtml(text)}</div>`;
    return el;
  }

  // ── Ephemeral bubbles ───────────────────────────────────────────────────

  /** @param {"user"|"assistant"|"tool"} role @param {string} text @returns {HTMLElement} */
  _spawnBubble(role, text) {
    let el;
    if (role === "cards") {
      // `text` is pre-rendered, escaped HTML (see renderToolCards).
      el = document.createElement("div");
      el.className = "bubble cards";
      el.innerHTML = text;
    } else if (role === "tool") {
      el = document.createElement("div");
      el.className = "bubble tool";
      el.innerHTML = `<svg class="bubble-tool-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${WRENCH_PATH}</svg><span class="bubble-tool-text">${escHtml(text)}</span>`;
    } else {
      el = this._buildMessageEl({ container: "bubble", prefix: "bubble", role, text });
    }
    this._bubbleStack.appendChild(el);
    // Cap the stack at 3, but never evict the bubble the caller is still
    // actively updating (the live user bubble) — drop the next-oldest instead.
    const visible = /** @type {HTMLElement[]} */ ([...this._bubbleStack.querySelectorAll(".bubble:not(.out)")]);
    if (visible.length > 3) {
      this._dismissBubble(visible.find((b) => b !== this._activeUserBubble) ?? visible[0]);
    }
    requestAnimationFrame(() => el.classList.add("in"));
    return el;
  }

  /**
   * Show an immediate placeholder for a user voice turn. It occupies the same
   * bubble as a transcript would, so a late STT event can replace the animation
   * in place instead of adding a second user message.
   * @param {"listening"|"sending"} state
   * @returns {HTMLElement}
   */
  _spawnVoiceBubble(state) {
    const el = this._spawnBubble("user", "");
    el.classList.add("voice");
    el.setAttribute("role", "status");
    el.setAttribute("aria-live", "polite");
    const body = /** @type {HTMLElement | null} */ (el.querySelector(".bubble-body"));
    if (body) {
      body.hidden = false;
      body.innerHTML = `
        <span class="voice-turn-wave" aria-hidden="true">
          <i></i><i></i><i></i><i></i><i></i>
        </span>
        <span class="voice-turn-state"></span>
      `;
    }
    this._setVoiceBubbleState(el, state);
    return el;
  }

  /** @param {HTMLElement} el @param {"listening"|"sending"} state */
  _setVoiceBubbleState(el, state) {
    el.classList.toggle("listening", state === "listening");
    el.classList.toggle("sending", state === "sending");
    const label = el.querySelector(".voice-turn-state");
    if (label) label.textContent = state === "listening" ? "Listening…" : "Sending voice…";
  }

  /** @param {HTMLElement} el @param {string} text */
  _updateBubbleText(el, text) {
    text = stripVocalCues(text);
    el.classList.remove("voice", "listening", "sending");
    el.removeAttribute("role");
    el.removeAttribute("aria-live");
    const t = /** @type {HTMLElement | null} */ (el.querySelector(".bubble-body"));
    if (t) {
      t.textContent = text;
      t.hidden = !text;
    }
  }

  /** @param {HTMLElement} el */
  _dismissBubble(el) {
    if (!el || el.classList.contains("out")) return; // idempotent
    this._bubbleExpiry.delete(el);
    el.classList.remove("in");
    el.classList.add("out");
    const remove = () => el.remove();
    el.addEventListener("transitionend", remove, { once: true });
    // Fallback: transitionend never fires if the bubble's visual state didn't
    // change (dismissed pre-paint) or the tab is backgrounded. The transition
    // is 0.3s, so force removal a little after.
    setTimeout(remove, 400);
  }

  /**
   * Fade bubbles whose expiry has passed — strictly oldest-first. We walk the
   * stack top (oldest) to bottom (newest) and stop at the first bubble still
   * alive: nothing newer may leave while an older bubble is still on screen. A
   * bubble that keeps updating pushes its own expiry forward, so it (and
   * everything behind it) stays put until it finally goes quiet.
   */
  _reapBubbles() {
    this._reaperHandle = 0;
    const now = Date.now();
    const visible = /** @type {HTMLElement[]} */ ([...this._bubbleStack.querySelectorAll(".bubble:not(.out)")]);
    let nextWake = Infinity;
    for (const el of visible) {
      const exp = this._bubbleExpiry.get(el) ?? now; // no expiry recorded → treat as due
      if (exp <= now) {
        this._dismissBubble(el);
      } else {
        // Oldest survivor isn't due yet; stop so nothing newer leaves before it.
        nextWake = exp;
        break;
      }
    }
    if (nextWake !== Infinity) {
      this._reaperHandle = setTimeout(() => this._reapBubbles(), Math.max(50, nextWake - Date.now()));
    }
  }

  /**
   * Point the shared reaper at the current oldest bubble. This must run when an
   * expiry moves earlier as well as later: a listening bubble starts with a
   * long fail-safe, then gets a much shorter deadline once speech stops.
   */
  _scheduleBubbleReaper() {
    if (this._reaperHandle) clearTimeout(this._reaperHandle);
    this._reaperHandle = 0;
    const oldest = /** @type {HTMLElement | null} */ (
      this._bubbleStack.querySelector(".bubble:not(.out)")
    );
    if (!oldest) return;
    const expiry = this._bubbleExpiry.get(oldest) ?? Date.now();
    this._reaperHandle = setTimeout(
      () => this._reapBubbles(),
      Math.max(50, expiry - Date.now()),
    );
  }

  /**
   * (Re)arm a bubble's auto-dismiss by pushing its expiry out by `delay`.
   * Calling it again resets the countdown — so a bubble that keeps updating
   * stays on screen and only fades once it goes quiet. Removal is ordered by the
   * shared reaper, so the oldest bubble always disappears first.
   * @param {HTMLElement} el @param {number} [delay]
   */
  _bumpDismiss(el, delay = 4000) {
    this._bubbleExpiry.set(el, Date.now() + delay);
    this._scheduleBubbleReaper();
  }

  /**
   * Remove a pending voice placeholder once the assistant has visibly started
   * answering. A transcript can arrive before audible output, while direct
   * audio models may only trigger the ai-speaking status, so both call here.
   */
  onAssistantActivity() {
    const bubble = this._activeUserBubble;
    if (!bubble?.isConnected || !bubble.classList.contains("voice")) return;
    this._assistantDismissedUserItemId = this._activeUserItemId;
    this._dismissBubble(bubble);
    this._activeUserBubble = null;
    this._scheduleBubbleReaper();
  }

  // ── History ───────────────────────────────────────────────────────────────

  /** Render the empty-state placeholder into the history panel. */
  renderEmptyState() {
    this._chatHistory.innerHTML = EMPTY_STATE_HTML;
  }

  /** Reset the panel to the empty state and clear the unread badge. */
  clear() {
    this._stopUserAudioPlayback();
    for (const url of this._audioUrls) URL.revokeObjectURL(url);
    this._audioUrls.clear();
    this._userAudioByItem.clear();
    this._userHistByItem.clear();
    this.renderEmptyState();
    this._chatBadge.classList.remove("visible");
  }

  /** @param {"user"|"assistant"} role @param {string} text @param {boolean} partial @returns {HTMLElement} */
  _appendHistMsg(role, text, partial) {
    const empty = this._chatHistory.querySelector(".chat-empty");
    if (empty) empty.remove();
    const el = this._buildMessageEl({ container: "hist-msg", prefix: "hist", role, text, partial });
    this._chatHistory.appendChild(el);
    this._scrollToBottom();
    return el;
  }

  /** @param {HTMLElement | null} el @param {string} text @param {boolean} partial */
  _updateHistMsg(el, text, partial) {
    text = stripVocalCues(text);
    if (!el) return;
    const body = /** @type {HTMLElement | null} */ (el.querySelector(".hist-body"));
    if (!body) return;
    body.textContent = text;
    body.hidden = !text;
    body.classList.toggle("partial", partial);
    this._scrollToBottom();
  }

  /** @param {string} itemId */
  _ensureUserHist(itemId) {
    let hist = this._userHistByItem.get(itemId);
    if (!hist) {
      hist = this._appendHistMsg("user", "", false);
      this._userHistByItem.set(itemId, hist);
    }
    return hist;
  }

  _stopUserAudioPlayback() {
    const active = this._activeUserAudio;
    this._activeUserAudio = null;
    if (active && !active.paused) active.pause();
    this._onUserAudioPlaybackChange(false);
  }

  /**
   * Append a tool-call row to the conversation. We only add it once the tool
   * has run, so the expandable toggle carries BOTH the call input and its result.
   * @param {string} name @param {string} argsJson @param {string} output
   */
  _appendHistTool(name, argsJson, output, cards) {
    const empty = this._chatHistory.querySelector(".chat-empty");
    if (empty) empty.remove();
    let pretty = argsJson;
    try { pretty = JSON.stringify(JSON.parse(argsJson), null, 2); } catch {}
    const el = document.createElement("div");
    el.className = "hist-msg tool";
    el.innerHTML = `
      <div class="hist-role">Tool call</div>
      <button class="hist-tool-header" aria-expanded="false">
        <svg class="hist-tool-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${WRENCH_PATH}</svg>
        <span class="hist-tool-name">${escHtml(name)}</span>
        <svg class="hist-tool-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
      </button>
      ${renderToolCards(name, cards)}
      <div class="hist-tool-body">
        <div class="hist-tool-label">Input</div>
        <div class="hist-tool-block">${escHtml(pretty)}</div>
        <div class="hist-tool-label">Output</div>
        <div class="hist-tool-block hist-tool-output">${escHtml(output || "(no output)")}</div>
      </div>
    `;
    const header = /** @type {HTMLButtonElement} */ (el.querySelector(".hist-tool-header"));
    const body = /** @type {HTMLDivElement} */ (el.querySelector(".hist-tool-body"));
    header.addEventListener("click", () => {
      const expanded = header.getAttribute("aria-expanded") === "true";
      header.setAttribute("aria-expanded", String(!expanded));
      body.classList.toggle("open", !expanded);
    });
    this._chatHistory.appendChild(el);
    this._scrollToBottom();
  }

  /** Tag an assistant history row as interrupted (user barged in mid-reply).
   *  @param {HTMLElement | null} hist */
  _markHistInterrupted(hist) {
    if (!hist || hist.querySelector(".hist-note")) return;
    hist.classList.add("interrupted");
    const note = document.createElement("div");
    note.className = "hist-note";
    note.textContent = "Interrupted";
    hist.appendChild(note);
  }

  /** Render a captured webcam frame in the transcript (the camera tool result).
   *  @param {string} dataUrl */
  _appendHistImage(dataUrl) {
    const empty = this._chatHistory.querySelector(".chat-empty");
    if (empty) empty.remove();
    const el = document.createElement("div");
    el.className = "hist-msg tool";
    el.innerHTML = `<div class="hist-role">Snapshot</div><img class="hist-image" alt="Webcam snapshot sent to the model" />`;
    const img = /** @type {HTMLImageElement} */ (el.querySelector("img"));
    img.src = dataUrl;
    this._chatHistory.appendChild(el);
    this._scrollToBottom();
  }

  /**
   * Reset all streaming bookkeeping for session start / teardown. Pass
   * `dismiss` to also fade any bubbles still on screen.
   * @param {{ dismiss?: boolean }} [opts]
   */
  reset(opts) {
    if (opts?.dismiss) {
      if (this._activeUserBubble) this._dismissBubble(this._activeUserBubble);
      for (const { bubble } of this._asstByResp.values()) this._dismissBubble(bubble);
    }
    this._userHistByItem.clear();
    this._activeUserBubble = null;
    this._activeUserItemId = "";
    this._assistantDismissedUserItemId = "";
    this._asstByResp.clear();
    if (opts?.dismiss) { this.dismissThinking(); this._dismissToolBubbles(); }
    else { this._thinkingBubble = null; this._thinkingSawTool = false; this._toolBubbles = []; }
    this._cardsBubble = null;
  }

  // ── Client event handlers ─────────────────────────────────────────────────

  /**
   * Show a voice bubble as soon as backend VAD recognizes speech.
   * @param {{ itemId?: string }} [detail]
   */
  onUserTurnStarted(detail = {}) {
    this.dismissThinking();
    const id = detail.itemId || `_u${++this._anonSeq}`;
    // A speculative continuation can reuse an incomplete item, so a fresh
    // start supersedes any tombstone left by prior assistant activity.
    this._assistantDismissedUserItemId = "";
    const reusable = this._activeUserItemId === id
      && this._activeUserBubble?.isConnected
      && !this._activeUserBubble.classList.contains("out");
    if (!reusable) {
      if (this._activeUserBubble?.classList.contains("voice")) {
        this._dismissBubble(this._activeUserBubble);
      }
      this._activeUserBubble = this._spawnVoiceBubble("listening");
      this._activeUserItemId = id;
    } else if (this._activeUserBubble.classList.contains("voice")) {
      this._setVoiceBubbleState(this._activeUserBubble, "listening");
    }
    // Fail-safe for a lost speech_stopped event; the normal stop path shortens
    // this to a few seconds.
    this._bumpDismiss(this._activeUserBubble, 30000);
  }

  /**
   * Transition the active voice bubble while the closed turn is in flight.
   * If speech_started was missed, create the sending state directly.
   * @param {{ itemId?: string }} [detail]
   */
  onUserTurnStopped(detail = {}) {
    const id = detail.itemId || this._activeUserItemId || `_u${++this._anonSeq}`;
    const reusable = this._activeUserItemId === id
      && this._activeUserBubble?.isConnected
      && !this._activeUserBubble.classList.contains("out");
    if (!reusable && this._assistantDismissedUserItemId === id) return;
    if (!reusable) {
      this._activeUserBubble = this._spawnVoiceBubble("sending");
      this._activeUserItemId = id;
    } else if (this._activeUserBubble.classList.contains("voice")) {
      this._setVoiceBubbleState(this._activeUserBubble, "sending");
    }
    this._bumpDismiss(this._activeUserBubble, 6000);
  }

  /**
   * A streamed transcript delta (user or assistant).
   * @param {{ role: "user" | "assistant"; text: string; partial: boolean; itemId?: string; responseId?: string }} d
   */
  onTranscript(d) {
    if (DEBUG) console.debug(`[ui] transcript role=${d.role} partial=${d.partial} item=${d.itemId} resp=${d.responseId} text=${JSON.stringify(d.text)}`);

    if (d.role === "user") {
      // Group by item_id. A missing id falls back to the active item or a fresh
      // unique key, never a shared sentinel that would collapse distinct turns.
      const id = d.itemId || this._activeUserItemId || `_u${++this._anonSeq}`;
      const text = d.text;

      const hist = this._ensureUserHist(id);
      this._updateHistMsg(hist, text, d.partial);

      // One ephemeral bubble per active item. Purely timer-based: the timer is
      // refreshed on every delta, so it stays while the user keeps talking and
      // fades a few seconds after they stop — no dependency on a response ever
      // arriving, so it can never get stuck.
      if (
        this._activeUserItemId !== id
        || !this._activeUserBubble?.isConnected
        || this._activeUserBubble.classList.contains("out")
      ) {
        this._activeUserBubble = this._spawnBubble("user", text);
        this._activeUserItemId = id;
      } else {
        this._updateBubbleText(this._activeUserBubble, text);
      }
      this._bumpDismiss(this._activeUserBubble, 6000);
      this._markUnread();
    } else if (d.role === "assistant") {
      this.onAssistantActivity();
      // The reply is here, so any tool chips from this turn are done. Fade
      // them now: the reaper alone would hold them behind the reply bubble,
      // which stays up while the words are spoken.
      this._dismissToolBubbles();
      // Assistant transcript arrives once, as the full text, keyed by
      // response_id so a cancelled speculative response can be removed later. A
      // missing id gets a unique key so two id-less replies never collide.
      const rid = d.responseId || `_a${++this._anonSeq}`;
      const entry = this._asstByResp.get(rid);
      const speaker = d.speaker || this._assistantName;
      if (!entry) {
        const bubble = this._claimThinkingBubble(d.text, speaker) ?? this._spawnBubble("assistant", d.text);
        this._relabel(bubble, speaker);
        const hist = this._appendHistMsg("assistant", d.text, false);
        this._relabel(hist, speaker);
        this._asstByResp.set(rid, { bubble, hist });
        this._latestAsstBubble = bubble;
        this._bumpDismiss(bubble);
      } else {
        this._updateBubbleText(entry.bubble, d.text);
        this._updateHistMsg(entry.hist, d.text, false);
        this._latestAsstBubble = entry.bubble;
        this._bumpDismiss(entry.bubble);
      }
      this._markUnread();
    }
  }

  /**
   * Attach the browser-local recording to its user turn. This also creates an
   * audio-only row when STT is disabled and no transcript events arrive.
   * Speculative continuations can reuse an incomplete item ID; their
   * accumulated replacement WAV keeps one player on that item's row.
   * @param {{ itemId?: string, audio: Blob, durationMs?: number, truncated?: boolean }} detail
   */
  onUserAudio(detail) {
    const id = detail.itemId || `_u${++this._anonSeq}`;
    const hist = this._ensureUserHist(id);
    let container = /** @type {HTMLElement | null} */ (hist.querySelector(".hist-audio"));
    const isNewPlayer = !container;
    if (!container) {
      container = document.createElement("div");
      container.className = "hist-audio";
      container.innerHTML = `
        <div class="hist-audio-label">Audio sent to the model</div>
        <audio controls preload="metadata" aria-label="Replay your audio"></audio>
      `;
      hist.appendChild(container);
    }

    const audio = /** @type {HTMLAudioElement} */ (container.querySelector("audio"));
    const previous = this._userAudioByItem.get(id);
    if (previous) {
      if (this._activeUserAudio === previous.audio) this._stopUserAudioPlayback();
      URL.revokeObjectURL(previous.url);
      this._audioUrls.delete(previous.url);
    }

    const url = URL.createObjectURL(detail.audio);
    this._audioUrls.add(url);
    this._userAudioByItem.set(id, { audio, url });
    audio.src = url;
    audio.title = detail.truncated
      ? "Replay your audio (the beginning was no longer buffered)"
      : "Replay the audio sent to the model";
    const label = container.querySelector(".hist-audio-label");
    if (label) {
      label.textContent = detail.truncated
        ? "Audio sent to the model · beginning unavailable"
        : "Audio sent to the model";
    }

    if (isNewPlayer) {
      audio.addEventListener("play", () => {
        if (this._activeUserAudio && this._activeUserAudio !== audio) {
          this._activeUserAudio.pause();
        }
        this._activeUserAudio = audio;
        this._onUserAudioPlaybackChange(true);
      });
      const stopped = () => {
        if (this._activeUserAudio !== audio) return;
        this._activeUserAudio = null;
        this._onUserAudioPlaybackChange(false);
      };
      audio.addEventListener("pause", stopped);
      audio.addEventListener("ended", stopped);
      audio.addEventListener("error", stopped);
    }
    this._scrollToBottom();
    this._markUnread();
  }

  /**
   * The pipeline is composing a reply (your turn ended). Show an assistant
   * bubble with pulsing dots; the transcript will fill it in when it arrives.
   */
  onAssistantThinking() {
    const live = this._thinkingBubble;
    if (live?.isConnected && !live.classList.contains("out")) return;
    const el = this._spawnBubble("assistant", "");
    el.classList.add("thinking");
    el.setAttribute("role", "status");
    el.setAttribute("aria-live", "polite");
    const body = /** @type {HTMLElement | null} */ (el.querySelector(".bubble-body"));
    if (body) {
      body.hidden = false;
      body.innerHTML = '<span class="thinking-dots" aria-hidden="true"><i></i><i></i><i></i></span>';
    }
    this._thinkingBubble = el;
    this._thinkingSawTool = false;
    // Fail-safe only: normal removal is by the transcript, response end, or barge-in.
    this._bumpDismiss(el, THINKING_FAILSAFE_MS);
  }

  _dismissToolBubbles() {
    for (const chip of this._toolBubbles) {
      if (chip.isConnected && !chip.classList.contains("out")) this._dismissBubble(chip);
    }
    this._toolBubbles = [];
    this._scheduleBubbleReaper();
  }

  /** Drop the thinking placeholder without a reply (barge-in, cancel, tool-only turn). */
  dismissThinking() {
    const el = this._thinkingBubble;
    this._thinkingBubble = null;
    this._thinkingSawTool = false;
    if (el?.isConnected && !el.classList.contains("out")) this._dismissBubble(el);
  }

  /**
   * Turn the live thinking bubble into the real reply bubble.
   * @param {string} text @returns {HTMLElement | null}
   */
  _claimThinkingBubble(text, speaker) {
    const el = this._thinkingBubble;
    this._thinkingBubble = null;
    this._thinkingSawTool = false;
    if (!el?.isConnected || el.classList.contains("out")) return null;
    el.classList.remove("thinking");
    this._relabel(el, speaker);
    this._updateBubbleText(el, text);
    return el;
  }

  /**
   * Speaker output is audible right now. The transcript arrives before playback
   * starts, so a fixed timer would fade the bubble mid-sentence; instead keep
   * pushing its expiry out while the words are actually being spoken, and let
   * it fade a few seconds after the last one. Falls back to the plain timer if
   * this never fires, so a bubble can never get stuck.
   */
  onAssistantAudible() {
    const cards = this._cardsBubble;
    if (cards?.isConnected && !cards.classList.contains("out")) this._bumpDismiss(cards, CARDS_LINGER_AFTER_SPEECH_MS);
    const bubble = this._latestAsstBubble;
    if (!bubble?.isConnected || bubble.classList.contains("out")) return;
    this._bumpDismiss(bubble, ASSISTANT_LINGER_AFTER_SPEECH_MS);
  }

  /** Show a tool's structured rows as a live bubble on the assistant's side, with a dismiss button.
   *  @param {string} title @param {string} html */
  _spawnCardsBubble(title, html) {
    if (this._cardsBubble?.isConnected) this._dismissBubble(this._cardsBubble); // one at a time
    const el = this._spawnBubble("cards", `<div class="bubble-cards-head"><span class="bubble-role">${escHtml(title)}</span><button class="bubble-close" type="button" aria-label="Dismiss">×</button></div>${html}`);
    el.querySelector(".bubble-close")?.addEventListener("click", () => this._dismissBubble(el));
    this._cardsBubble = el;
    this._bumpDismiss(el, CARDS_LINGER_MS);
    return el;
  }

  /**
   * A response closed (completed or cancelled).
   * @param {{ responseId: string; status: string; audible?: boolean; transcript?: string }} detail
   */
  onResponseFinished(detail) {
    const { responseId, status, audible, transcript } = detail;
    if (DEBUG) console.debug(`[ui] response-finished resp=${responseId} status=${status} audible=${audible} known=${this._asstByResp.has(responseId)}`);
    this.onAssistantActivity();
    if (this._thinkingSawTool && status !== "cancelled") {
      this._thinkingSawTool = false; // the reply arrives in the follow-up response
    } else {
      this.dismissThinking();
    }
    // Without an id we can't target a specific response; the bubble will
    // auto-dismiss on its own timer regardless.
    if (!responseId) return;
    const entry = this._asstByResp.get(responseId);

    if (status === "cancelled") {
      // Keep every transcript that was received — mark it interrupted rather
      // than erasing it. If the `*.transcript.done` never fired, build the row
      // from the text carried in response.done.
      let hist = entry?.hist ?? null;
      if (!hist && transcript) {
        hist = this._appendHistMsg("assistant", transcript, false);
      } else if (hist && transcript) {
        this._updateHistMsg(hist, transcript, false);
      }
      if (hist) this._markHistInterrupted(hist);
      this._asstByResp.delete(responseId);
      return;
    }

    // Any other terminal close (completed / failed / incomplete / …): just
    // release the map entry. The bubble already auto-dismisses on its timer and
    // the history row persists as the conversation log. Crucially we do NOT
    // touch user state here — that lifecycle is fully independent.
    this._asstByResp.delete(responseId);
  }

  /** A persona hand-off happened — show who and how (e.g. "→ Barnaby · inferred from your intent").
   *  @param {string} name @param {string} how */
  onPersonaSwitch(name, how) {
    if (this._thinkingBubble) this._thinkingSawTool = true;
    const chip = this._spawnBubble("tool", `→ ${name} · ${how}`);
    chip.classList.add("persona-switch");
    this._toolBubbles.push(chip);
    this._bumpDismiss(chip, 6000);
    this._appendHistNote(`Switched to ${name} (${how})`);
  }

  /** @param {string} text */
  _appendHistNote(text) {
    const row = document.createElement("div");
    row.className = "hist-msg hist-note";
    row.textContent = text;
    this._chatHistory.appendChild(row);
    this._chatHistory.scrollTop = this._chatHistory.scrollHeight;
  }

  /** The model called a tool — show an ephemeral "running" bubble.
   *  @param {string} name */
  onToolCall(name) {
    if (this._thinkingBubble) this._thinkingSawTool = true;
    const chip = this._spawnBubble("tool", name);
    this._toolBubbles.push(chip);
    this._bumpDismiss(chip);
    this._markUnread();
  }

  /** The tool finished — append its call+result row (and any captured image).
   *  @param {string} name @param {string} argsJson @param {string} output @param {string} [image] */
  onToolResult(name, argsJson, output, image, cards) {
    this._appendHistTool(name, argsJson, output, cards);
    if (image) this._appendHistImage(image); // show the captured frame below the call
    const html = renderToolCards(name, cards);
    const titles = { find_restaurants: "Restaurants", restaurant_inspections: "Health inspections", restaurant_details: "Details", open_page: "Link" };
    if (html) this._spawnCardsBubble(titles[name] ?? name, html);
    this._markUnread();
  }
}
