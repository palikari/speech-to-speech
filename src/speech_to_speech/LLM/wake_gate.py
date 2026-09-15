"""Wake-word gate for the local LLM path.

When a session enables wake mode (an ``s2s_wake`` object carried on the
Realtime session config), a user turn is only answered if it addresses the
assistant by one of its wake words, or arrives inside the awake window that
follows a reply. A sleep phrase ends the window early. A wake word that
belongs to another persona (``others``) is not answered either: the client
switches persona and asks for the response itself.

The gate runs where the transcript is already available (the LLM handler),
so detection costs nothing extra.
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
    window_s: float = DEFAULT_WINDOW_S
    sleep_phrases: list[str] = field(default_factory=lambda: list(DEFAULT_SLEEP_PHRASES))


@dataclass
class WakeDecision:
    answer: bool
    reason: str
    other_persona: Optional[str] = None


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


def contains_wake_word(text: str, words: Iterable[str]) -> Optional[str]:
    """Return the first wake word found in *text* (whole words, transcription-tolerant)."""
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
    for persona, words in cfg.others.items():
        other = contains_wake_word(text, words)
        if other:
            return WakeDecision(False, f"addressed to {persona!r} as {other!r}", other_persona=persona)
    if now < awake_until:
        return WakeDecision(True, f"awake for {awake_until - now:.0f}s more")
    return WakeDecision(False, "asleep: not addressed")
