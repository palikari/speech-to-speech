"""A note the model writes to itself at the start of a reply is not spoken."""

from speech_to_speech.LLM.asides import ASIDE_MAX_CHARS, LeadingAsideFilter


def _run(parts: list[str]) -> str:
    f = LeadingAsideFilter()
    out = "".join(f.feed(p) for p in parts)
    return out + f.flush()


def test_drops_a_tool_note_split_across_deltas():
    parts = ["(play_", "sound not needed here — a request, so speak) Hmm, a ", "delicious potion you say."]
    assert _run(parts) == "Hmm, a delicious potion you say."


def test_drops_a_note_that_merely_mentions_tools():
    assert _run(["(no tool call needed) ", "Sure thing."]) == "Sure thing."


def test_keeps_an_ordinary_parenthetical_opening():
    assert _run(["(cackles) ", "Come closer, dearie."]) == "(cackles) Come closer, dearie."


def test_ordinary_replies_pass_through_untouched_and_unbuffered():
    f = LeadingAsideFilter()
    assert f.feed("Hello") == "Hello"
    assert not f.holding
    assert f.feed(" (play_sound) there") == " (play_sound) there"
    assert f.flush() == ""


def test_leading_whitespace_before_the_note_is_fine():
    assert _run(["  \n(play_sound skipped)", "  Yes."]).strip() == "Yes."


def test_holds_only_until_the_close_then_streams():
    f = LeadingAsideFilter()
    assert f.feed("(play_sound no") == ""
    assert f.holding
    assert f.feed("t needed) Right") == "Right"
    assert f.feed(" away.") == " away."


def test_gives_up_on_an_aside_that_never_closes():
    f = LeadingAsideFilter()
    text = "(" + "x" * ASIDE_MAX_CHARS
    assert f.feed(text) == text
    f2 = LeadingAsideFilter()
    assert f2.feed("(unclosed") == ""
    assert f2.flush() == "(unclosed"


def test_a_newline_inside_the_parenthesis_releases_the_text():
    assert _run(["(a\nb) rest"]) == "(a\nb) rest"
