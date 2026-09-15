from datetime import datetime, timezone

from openai.types.realtime.realtime_session_create_request import RealtimeSessionCreateRequest

from speech_to_speech.LLM.clock import clock_line, clock_timezone, with_clock


def _session(extra=None):
    return RealtimeSessionCreateRequest.model_validate(
        {"type": "realtime", "instructions": "Be brief.", **(extra or {})}
    )


def test_clock_uses_the_zone_the_client_sent():
    session = _session({"s2s_clock": {"tz": "America/New_York"}})
    assert clock_timezone(session) == "America/New_York"
    now = datetime(2026, 9, 15, 12, 5, tzinfo=timezone.utc)  # 08:05 in New York (EDT)
    line = clock_line(session, now)
    assert line.startswith("Current date and time: Tuesday, 15 September 2026, 08:05 (America/New_York).")
    assert "count days with a tool" in line


def test_clock_falls_back_to_local_time_without_or_with_a_bad_zone():
    now = datetime(2026, 12, 25, 0, 30, tzinfo=timezone.utc)
    for session in (_session(), _session({"s2s_clock": {"tz": "Mars/Olympus_Mons"}})):
        line = clock_line(session, now)
        assert line.startswith("Current date and time: ") and "2026" in line


def test_with_clock_appends_to_instructions_or_stands_alone():
    session = _session({"s2s_clock": {"tz": "UTC"}})
    now = datetime(2026, 9, 15, 7, 0, tzinfo=timezone.utc)
    assert with_clock("You are Bob.", session, now) == "You are Bob.\n\n" + clock_line(session, now)
    assert with_clock("", session, now) == ""  # keeps the "nothing to send" guard intact
