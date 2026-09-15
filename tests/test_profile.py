from openai.types.realtime.realtime_session_create_request import RealtimeSessionCreateRequest

from speech_to_speech.LLM.profile import (
    NO_ASSUMPTIONS,
    format_birthday,
    parse_user_profile,
    profile_lines,
    with_profile,
)


def _session(extra=None):
    return RealtimeSessionCreateRequest.model_validate(
        {"type": "realtime", "instructions": "Be brief.", **(extra or {})}
    )


def test_profile_block_states_only_what_the_user_gave():
    session = _session(
        {
            "s2s_user": {
                "name": "Michael",
                "pronouns": "he/him",
                "birthday": "1975-03-12",
                "area": "Alpharetta, GA",
                "notes": "Vegetarian.",
                "email": "x@y",
            }
        }
    )
    profile = parse_user_profile(session)
    assert "email" not in profile  # only known keys pass
    text = profile_lines(profile)
    assert "Name: Michael" in text and "Pronouns: he/him" in text and "Birthday: 12 March 1975" in text
    assert "Home area: Alpharetta, GA" in text and "Notes from the user: Vegetarian." in text and NO_ASSUMPTIONS in text
    assert with_profile("Be brief.", session).startswith("Be brief.\n\nAbout the user")
    assert with_profile("", session) == ""


def test_no_profile_means_the_no_assumptions_rule_alone():
    text = profile_lines(parse_user_profile(_session()))
    assert text.startswith("Nothing is known about the user.") and NO_ASSUMPTIONS in text


def test_birthday_formats():
    assert format_birthday("1975-03-12") == "12 March 1975"
    assert format_birthday("03-12") == "12 March"
    assert format_birthday("--03-12") == "12 March"
    assert format_birthday("13-40") is None
    assert format_birthday("mid March") == "mid March"
