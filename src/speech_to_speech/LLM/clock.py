"""Tell the model what time it is.

A language model has no clock: asked "how many days until Halloween" it
guesses today's date from whatever the conversation happens to contain. Both
LLM handlers append :func:`clock_line` to the session instructions at every
generation, in the user's time zone when the client sends one as the session
extra ``s2s_clock`` (``{"tz": "America/New_York"}``), else the server's local
zone. Arithmetic on dates is still the model's weak spot; the demo pairs this
with deterministic ``date_math`` and ``calculate`` tools.
"""

from __future__ import annotations

from datetime import datetime, tzinfo
from typing import Any, Optional
from zoneinfo import ZoneInfo

CLOCK_HINT = (
    "Use this whenever a question involves today's date, the time, or how long until or since an event; "
    "count days with a tool if one is available rather than in your head."
)


def clock_timezone(session: Any) -> Optional[str]:
    """The IANA zone name the client sent as ``s2s_clock.tz``, or None."""
    extra = getattr(session, "model_extra", None) or {}
    raw = extra.get("s2s_clock")
    tz = raw.get("tz") if isinstance(raw, dict) else None
    return str(tz).strip() or None if tz else None


def _resolve_zone(name: Optional[str]) -> tuple[Optional[tzinfo], str]:
    if name:
        try:
            return ZoneInfo(name), name
        except Exception:  # unknown or malformed zone name: fall back to local time
            pass
    local = datetime.now().astimezone().tzinfo
    return local, (local.tzname(None) if local else None) or "local time"


def clock_line(session: Any, now: Optional[datetime] = None) -> str:
    zone, label = _resolve_zone(clock_timezone(session))
    moment = now.astimezone(zone) if now is not None else datetime.now(zone)
    stamp = f"{moment:%A}, {moment.day} {moment:%B %Y}, {moment:%H:%M}"
    return f"Current date and time: {stamp} ({label}). {CLOCK_HINT}"


def with_clock(instructions: Optional[str], session: Any, now: Optional[datetime] = None) -> str:
    """The session instructions with the clock line appended.

    Empty instructions stay empty: a session with no prompt and no input must
    still fail fast without a provider call, as upstream guarantees.
    """
    base = (instructions or "").strip()
    if not base:
        return ""
    return f"{base}\n\n{clock_line(session, now)}"
