"""Wake-word gate for the local LLM path.

When a session enables wake mode (an ``s2s_wake`` object carried on the
Realtime session config), a user turn is only answered if it addresses the
assistant by one of its wake words, or arrives inside the awake window that
follows a reply. A sleep phrase ends the window early. A wake word that
belongs to another persona (``others``) is not answered either: the client
switches persona and asks for the response itself.

The gate runs where the transcript is already available (the LLM handlers:
mlx-lm and the OpenAI-compatible backends), so detection costs nothing extra.
"""

from __future__ import annotations

import re
import time
from dataclasses import dataclass, field
from typing import Any, Iterable, Optional

DEFAULT_WINDOW_S = 45.0
DEFAULT_SLEEP_PHRASES = ("go to sleep", "that's all", "that is all", "thanks, that's all", "goodbye", "never mind")
_WORD_RE = re.compile(r"[a-z0-9']+")


@dataclass
class WakeConfig:
    enabled: bool = False
    words: list[str] = field(default_factory=list)  # wake words for the current persona
    others: dict[str, list[str]] = field(default_factory=dict)  # persona id -> its wake words
    # "leading": another persona wakes only when addressed at the start of the turn;
    # "anywhere": its name anywhere in the turn; "off": never (hand-offs by request only).
    others_mode: str = "leading"
    window_s: float = DEFAULT_WINDOW_S
    sleep_phrases: list[str] = field(default_factory=lambda: list(DEFAULT_SLEEP_PHRASES))


@dataclass
class WakeDecision:
    answer: bool
    reason: str
    other_persona: Optional[str] = None
    # Remove the turn from the history: only for overheard talk. A turn addressed
    # to another persona is re-requested by the client after it switches, and a
    # sleep phrase is an instruction worth keeping.
    drop: bool = False


# The page injects bookkeeping as user-role items (hand-off notes, "mic is on
# again"). They are not speech and must never be gated or matched as phrases.
CLIENT_NOTE_MARKER = "not spoken by the user"


def is_client_note(text: str) -> bool:
    t = (text or "").strip()
    return t.startswith("(") and CLIENT_NOTE_MARKER in t


def parse_wake_config(session: Any) -> Optional[WakeConfig]:
    """Read ``s2s_wake`` from a session config (kept as a pydantic extra), or None."""
    extra = getattr(session, "model_extra", None) or {}
    raw = extra.get("s2s_wake")
    if not isinstance(raw, dict):
        return None
    cfg = WakeConfig(enabled=bool(raw.get("enabled", False)))
    cfg.words = [str(w) for w in raw.get("words", []) or [] if str(w).strip()]
    others = raw.get("others") or {}
    if isinstance(others, dict):
        cfg.others = {str(k): [str(w) for w in v or [] if str(w).strip()] for k, v in others.items()}
    mode = str(raw.get("others_mode") or "leading").lower()
    cfg.others_mode = mode if mode in ("leading", "anywhere", "off") else "leading"
    try:
        cfg.window_s = float(raw.get("window_s", DEFAULT_WINDOW_S))
    except (TypeError, ValueError):
        cfg.window_s = DEFAULT_WINDOW_S
    sleep = raw.get("sleep_phrases")
    if isinstance(sleep, list) and sleep:
        cfg.sleep_phrases = [str(p) for p in sleep if str(p).strip()]
    return cfg


def _tokens(text: str) -> list[str]:
    return _WORD_RE.findall(text.lower().replace("-", " "))


def _edit_distance(a: str, b: str, limit: int) -> int:
    if abs(len(a) - len(b)) > limit:
        return limit + 1
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb)))
        if min(cur) > limit:
            return limit + 1
        prev = cur
    return prev[-1]


def _slack(word: str) -> int:
    """How many letters a transcription may get wrong and still count.

    Only long, name-like words get slack: with one letter of slack a short
    word collides with everyday speech ("witch" would match "with").
    """
    if len(word) >= 9:
        return 2
    if len(word) >= 7:
        return 1
    return 0


# How far into a turn another persona's name may sit to count as addressing it:
# "Hey Bob, are you there?" yes; "I told Bob about the roof" no.
OTHERS_LEADING_TOKENS = 3
_ADDRESS_FILLERS = {"hey", "hi", "hello", "ok", "okay", "yo", "um", "uh", "so"}


def _find_wake_word(tokens: list[str], words: Iterable[str]) -> Optional[tuple[str, int, int]]:
    """(word, start index, length in tokens) of the first wake word in *tokens*, or None."""
    for word in words:
        parts = _tokens(word)
        if not parts:
            continue
        n = len(parts)
        for i in range(len(tokens) - n + 1):
            window = tokens[i : i + n]
            if all(_edit_distance(t, p, _slack(p)) <= _slack(p) for t, p in zip(window, parts)):
                return word, i, n
    return None


def addressed_wake_word(text: str, words: Iterable[str]) -> Optional[str]:
    """A wake word used as an address, not a mention: the first word after
    fillers ("Hey Bob, ...", "Okay Unit Seven, status?"), or within the first
    four words when a pause follows it ("Good morning, Bob, ...") or it ends
    the turn ("You there Bob?"). "The robot vacuum broke", "I told Bob about
    it" and "boo boo bob boo" do not count.
    """
    raw = (text or "").strip()
    tokens = _tokens(raw)
    dropped = 0
    while tokens and tokens[0] in _ADDRESS_FILLERS:
        tokens = tokens[1:]
        dropped += 1
    hit = _find_wake_word(tokens, words)
    if hit is None:
        return None
    word, i, n = hit
    if i == 0:
        return word
    if i < 4:
        # Is the matched word followed by punctuation (or the end)? Look at the
        # raw text after the (i+n)-th word.
        spans = list(re.finditer(r"[A-Za-z0-9']+", raw))
        end_idx = dropped + i + n - 1
        if end_idx < len(spans):
            tail = raw[spans[end_idx].end() :].lstrip()
            if not tail or tail[0] in ",.!?;:":
                return word
    return None


def contains_wake_word(text: str, words: Iterable[str], leading: Optional[int] = None) -> Optional[str]:
    """Return the first wake word found in *text* (whole words, transcription-tolerant).

    ``leading`` (any value) switches to the address-only rule of :func:`addressed_wake_word`.
    """
    if leading is not None:
        return addressed_wake_word(text, words)
    tokens = _tokens(text)
    if not tokens:
        return None
    for word in words:
        parts = _tokens(word)
        if not parts:
            continue
        n = len(parts)
        for i in range(len(tokens) - n + 1):
            window = tokens[i : i + n]
            if all(_edit_distance(t, p, _slack(p)) <= _slack(p) for t, p in zip(window, parts)):
                return word
    return None


def is_sleep_phrase(text: str, phrases: Iterable[str]) -> bool:
    norm = " ".join(_tokens(text))
    return any(" ".join(_tokens(p)) and " ".join(_tokens(p)) in norm for p in phrases)


def decide(cfg: WakeConfig, text: str, awake_until: float, now: Optional[float] = None) -> WakeDecision:
    """Decide whether the current persona should answer *text*."""
    now = time.monotonic() if now is None else now
    if not cfg.enabled:
        return WakeDecision(True, "wake mode off")
    if is_sleep_phrase(text, cfg.sleep_phrases):
        return WakeDecision(False, "sleep phrase")
    word = contains_wake_word(text, cfg.words)
    if word:
        return WakeDecision(True, f"addressed as {word!r}")
    if cfg.others_mode != "off":
        leading = OTHERS_LEADING_TOKENS if cfg.others_mode == "leading" else None
        for persona, words in cfg.others.items():
            other = contains_wake_word(text, words, leading=leading)
            if other:
                return WakeDecision(False, f"addressed to {persona!r} as {other!r}", other_persona=persona)
    if now < awake_until:
        return WakeDecision(True, f"awake for {awake_until - now:.0f}s more")
    return WakeDecision(False, "asleep: not addressed", drop=True)


# ── Handler-side helpers (shared by the mlx-lm and OpenAI-compatible handlers) ──


def _user_item_text(item: Any) -> str:
    parts = getattr(item, "content", None) or []
    texts = [p.text for p in parts if getattr(p, "type", None) == "input_text" and getattr(p, "text", None)]
    return " ".join(texts).strip()


def last_user_text(runtime_config: Any, *, skip_notes: bool = True) -> str:
    """Text of the newest user message (transcript or typed), skipping client notes by default."""
    for item in reversed(list(runtime_config.chat.buffer)):
        if getattr(item, "role", None) == "user":
            text = _user_item_text(item)
            if skip_notes and is_client_note(text):
                continue
            return text
    return ""


def _newest_is_user_turn(runtime_config: Any) -> bool:
    """True when the newest history item is a user message (a fresh turn to judge).

    A tool follow-up ends in a function_call_output: the user turn it belongs to
    was already admitted, so its reply must not be re-judged (or "go on standby"
    would silence its own acknowledgement).
    """
    buffer = list(runtime_config.chat.buffer)
    return bool(buffer) and getattr(buffer[-1], "role", None) == "user"


def gate_turn(runtime_config: Any) -> Optional[WakeDecision]:
    """None when wake mode is not configured on the session; else whether to answer this turn."""
    cfg = parse_wake_config(runtime_config.session)
    if cfg is None or not cfg.enabled:
        return None
    if not _newest_is_user_turn(runtime_config):
        return WakeDecision(True, "tool follow-up")
    if is_client_note(last_user_text(runtime_config, skip_notes=False)):
        return WakeDecision(True, "client note")
    return decide(cfg, last_user_text(runtime_config), runtime_config.wake_awake_until)


def extend_awake_window(runtime_config: Any) -> None:
    """After a reply, keep answering without a wake word for the configured window.

    Not when the user's turn was itself a request to sleep ("go on standby"):
    the reply that acknowledges it must not reopen the window.
    """
    cfg = parse_wake_config(runtime_config.session)
    if cfg is None or not cfg.enabled:
        return
    if is_sleep_phrase(last_user_text(runtime_config), cfg.sleep_phrases) or turn_put_assistant_to_sleep(
        runtime_config
    ):
        runtime_config.wake_awake_until = 0.0
        return
    runtime_config.wake_awake_until = time.monotonic() + cfg.window_s


def turn_put_assistant_to_sleep(runtime_config: Any) -> bool:
    """True when this user turn led to a set_listening call for standby or muted.

    Phrasing-independent: "only answer to your name" is not a sleep phrase, but
    the tool call it produced is in the history right after the user message.
    """
    for item in reversed(list(runtime_config.chat.buffer)):
        if getattr(item, "role", None) == "user":
            return False
        if getattr(item, "type", None) == "function_call" and getattr(item, "name", None) == "set_listening":
            args = str(getattr(item, "arguments", "") or "").lower()
            if "standby" in args or "muted" in args:
                return True
    return False


def drop_last_user_turn(runtime_config: Any) -> Optional[str]:
    """Remove the newest user message from the history (a turn the wake gate declined).

    Overheard talk that the persona did not answer must not stay in the model's
    context. Returns the removed item id, or None.
    """
    for item in reversed(list(runtime_config.chat.buffer)):
        if getattr(item, "role", None) == "user":
            if is_client_note(_user_item_text(item)):
                return None
            item_id = getattr(item, "id", None)
            if item_id:
                runtime_config.chat.rollback_generation(item_id, item_ids=set(), call_ids=set())
            return item_id
    return None
