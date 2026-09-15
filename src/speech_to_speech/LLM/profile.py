"""What the model may know about the user, and what it must not assume.

The page sends a self-described profile as the session extra ``s2s_user``
(``{name, pronouns, birthday, area, notes}``); both LLM handlers append
:func:`profile_lines` to the session instructions at every generation, next
to the clock line. The full home address never comes here: the page keeps it
and passes it only to the restaurant search when location is not shared.
Without a profile the block is the no-assumptions rule alone.
"""

from __future__ import annotations

import re
from typing import Any, Optional

NO_ASSUMPTIONS = (
    "Do not assume the user's gender, age, name or location beyond what is stated here; "
    "when something is not stated, use neutral wording and ask if you need to know."
)
_MONTHS = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
]


def parse_user_profile(session: Any) -> dict[str, str]:
    extra = getattr(session, "model_extra", None) or {}
    raw = extra.get("s2s_user")
    if not isinstance(raw, dict):
        return {}
    out: dict[str, str] = {}
    for key in ("name", "pronouns", "birthday", "area", "notes"):
        value = raw.get(key)
        if isinstance(value, str) and value.strip():
            out[key] = " ".join(value.split())[:400]
    return out


def format_birthday(raw: str) -> Optional[str]:
    """'1975-03-12' -> '12 March 1975'; '03-12' or '--03-12' -> '12 March'; else the text as given."""
    m = re.fullmatch(r"(?:(\d{4})-)?(\d{1,2})-(\d{1,2})", raw.strip().lstrip("-"))  # "--03-12" is the ISO no-year form
    if not m:
        return raw.strip() or None
    year, month, day = m.group(1), int(m.group(2)), int(m.group(3))
    if not (1 <= month <= 12 and 1 <= day <= 31):
        return None
    text = f"{day} {_MONTHS[month - 1]}"
    return f"{text} {year}" if year else text


def profile_lines(profile: dict[str, str]) -> str:
    facts = []
    if profile.get("name"):
        facts.append(f"Name: {profile['name']} (address them by it when natural).")
    if profile.get("pronouns"):
        facts.append(f"Pronouns: {profile['pronouns']}.")
    birthday = format_birthday(profile["birthday"]) if profile.get("birthday") else None
    if birthday:
        facts.append(f"Birthday: {birthday}.")
    if profile.get("area"):
        facts.append(f"Home area: {profile['area']}.")
    if profile.get("notes"):
        facts.append(f"Notes from the user: {profile['notes']}")
    if not facts:
        return f"Nothing is known about the user. {NO_ASSUMPTIONS}"
    return (
        "About the user, in their own words (use exactly this, nothing more): " + " ".join(facts) + " " + NO_ASSUMPTIONS
    )


def with_profile(instructions: Optional[str], session: Any) -> str:
    """The session instructions with the profile block appended; empty stays empty."""
    base = (instructions or "").strip()
    if not base:
        return ""
    return f"{base}\n\n{profile_lines(parse_user_profile(session))}"
