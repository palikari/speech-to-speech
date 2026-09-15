from openai.types.realtime.realtime_session_create_request import RealtimeSessionCreateRequest

from speech_to_speech.LLM.wake_gate import WakeConfig, contains_wake_word, decide, is_sleep_phrase, parse_wake_config


def _cfg(**kw):
    base = dict(
        enabled=True,
        words=["bob", "hey bob"],
        others={"witch": ["esmerelda", "esmer"], "captain": ["barnaby", "captain"]},
    )
    base.update(kw)
    return WakeConfig(**base)


def test_wake_word_matches_whole_words_and_tolerates_transcription_slips():
    assert contains_wake_word("Hey Bob, what time is it?", ["hey bob"]) == "hey bob"
    assert contains_wake_word("Esmeralda, what's brewing?", ["esmerelda"]) == "esmerelda"  # one letter off
    assert contains_wake_word("Ezmerelda are you there", ["esmerelda"]) == "esmerelda"
    assert contains_wake_word("Tell me about bobsled racing.", ["bob"]) is None
    assert contains_wake_word("Who am I speaking with?", ["witch"]) is None  # short names: exact only
    assert contains_wake_word("Barnabi, are you there?", ["barnaby"]) == "barnaby"  # one slip on a long name
    assert contains_wake_word("I bought a robot vacuum.", ["robot"]) == "robot"  # whole word: caller decides context
    assert contains_wake_word("Unit 7, status report.", ["unit seven"]) is None  # digits are not spelled out
    assert contains_wake_word("unit seven status", ["unit seven"]) == "unit seven"


def test_sleep_phrases():
    assert is_sleep_phrase("Okay, go to sleep now.", ["go to sleep"])
    assert not is_sleep_phrase("I could not sleep last night.", ["go to sleep"])


def test_decide_gate_logic():
    cfg = _cfg()
    assert decide(cfg, "Hey Bob, what's the weather?", awake_until=0, now=100).answer
    assert not decide(cfg, "What's the weather?", awake_until=0, now=100).answer
    assert decide(cfg, "What's the weather?", awake_until=130, now=100).answer  # inside the window
    d = decide(cfg, "Esmerelda, what's brewing?", awake_until=130, now=100)
    assert not d.answer and d.other_persona == "witch"
    assert not decide(cfg, "Thanks Bob, go to sleep.", awake_until=130, now=100).answer
    assert decide(WakeConfig(enabled=False), "anything", awake_until=0, now=100).answer


def test_parse_wake_config_from_session_extra():
    session = RealtimeSessionCreateRequest.model_validate(
        {
            "type": "realtime",
            "s2s_wake": {"enabled": True, "words": ["Hey Bob"], "others": {"witch": ["Esmerelda"]}, "window_s": 30},
        }
    )
    cfg = parse_wake_config(session)
    assert (
        cfg
        and cfg.enabled
        and cfg.words == ["Hey Bob"]
        and cfg.others == {"witch": ["Esmerelda"]}
        and cfg.window_s == 30
    )
    assert parse_wake_config(RealtimeSessionCreateRequest(type="realtime")) is None


def test_handler_gate_reads_the_latest_user_turn_and_extends_the_window(monkeypatch):
    from openai.types.realtime.realtime_conversation_item_user_message import (
        Content as UserContent,
    )
    from openai.types.realtime.realtime_conversation_item_user_message import (
        RealtimeConversationItemUserMessage,
    )

    from speech_to_speech.api.openai_realtime.runtime_config import RuntimeConfig
    from speech_to_speech.LLM.language_model import LanguageModelHandler

    handler = object.__new__(LanguageModelHandler)
    cfg = RuntimeConfig()
    assert handler._wake_gate(cfg) is None  # wake mode not configured

    cfg.apply_session_update(
        RealtimeSessionCreateRequest.model_validate(
            {
                "type": "realtime",
                "s2s_wake": {"enabled": True, "words": ["bob"], "others": {"witch": ["esmerelda"]}, "window_s": 45},
            }
        )
    )

    def say(text):
        cfg.chat.add_item(
            RealtimeConversationItemUserMessage(
                type="message", role="user", content=[UserContent(type="input_text", text=text)]
            )
        )

    say("What's the weather?")
    assert handler._wake_gate(cfg).answer is False
    say("Hey Bob, what's the weather?")
    assert handler._wake_gate(cfg).answer is True
    handler._extend_awake_window(cfg)
    say("And tomorrow?")
    assert handler._wake_gate(cfg).answer is True  # inside the window
    say("Esmerelda, are you there?")
    d = handler._wake_gate(cfg)
    assert d.answer is False and d.other_persona == "witch"
    say("Okay, go to sleep.")
    assert handler._wake_gate(cfg).answer is False


def test_a_sleep_request_does_not_reopen_the_window_and_declined_turns_leave_the_history():
    from openai.types.realtime.realtime_conversation_item_user_message import (
        Content as UserContent,
    )
    from openai.types.realtime.realtime_conversation_item_user_message import (
        RealtimeConversationItemUserMessage,
    )

    from speech_to_speech.api.openai_realtime.runtime_config import RuntimeConfig
    from speech_to_speech.LLM.wake_gate import drop_last_user_turn, extend_awake_window, gate_turn

    cfg = RuntimeConfig()
    cfg.apply_session_update(
        RealtimeSessionCreateRequest.model_validate(
            {
                "type": "realtime",
                "s2s_wake": {"enabled": True, "words": ["sam"], "sleep_phrases": ["go on standby", "go to sleep"]},
            }
        )
    )

    def say(text):
        return cfg.chat.add_item(
            RealtimeConversationItemUserMessage(
                type="message", role="user", content=[UserContent(type="input_text", text=text)]
            )
        )

    say("Sam, what's the weather?")
    extend_awake_window(cfg)
    assert cfg.wake_awake_until > 0  # a normal reply opens the window
    say("Sam, go on standby.")
    extend_awake_window(cfg)
    assert cfg.wake_awake_until == 0  # the acknowledgement of a sleep request does not

    overheard = say("So anyway, I told him the roof needs fixing.")
    assert gate_turn(cfg).answer is False
    assert drop_last_user_turn(cfg) == overheard.id
    assert all(getattr(i, "id", None) != overheard.id for i in cfg.chat.buffer)
    assert [i.content[0].text for i in cfg.chat.buffer if getattr(i, "role", None) == "user"][
        -1
    ] == "Sam, go on standby."


def test_tool_follow_ups_are_not_gated():
    from openai.types.realtime.conversation_item import (
        RealtimeConversationItemFunctionCall,
        RealtimeConversationItemFunctionCallOutput,
    )
    from openai.types.realtime.realtime_conversation_item_user_message import (
        Content as UserContent,
    )
    from openai.types.realtime.realtime_conversation_item_user_message import (
        RealtimeConversationItemUserMessage,
    )

    from speech_to_speech.api.openai_realtime.runtime_config import RuntimeConfig
    from speech_to_speech.LLM.wake_gate import gate_turn

    cfg = RuntimeConfig()
    cfg.apply_session_update(
        RealtimeSessionCreateRequest.model_validate(
            {"type": "realtime", "s2s_wake": {"enabled": True, "words": ["sam"], "sleep_phrases": ["go on standby"]}}
        )
    )
    cfg.chat.add_item(
        RealtimeConversationItemUserMessage(
            type="message", role="user", content=[UserContent(type="input_text", text="Sam, go on standby.")]
        )
    )
    assert gate_turn(cfg).answer is False  # the sleep phrase itself, as a fresh turn
    cfg.chat.add_item(
        RealtimeConversationItemFunctionCall(
            type="function_call", call_id="call_1", name="set_listening", arguments='{"mode":"standby"}'
        )
    )
    cfg.chat.add_item(
        RealtimeConversationItemFunctionCallOutput(
            type="function_call_output", call_id="call_1", output="Standby is on."
        )
    )
    decision = gate_turn(cfg)
    assert decision.answer is True and decision.reason == "tool follow-up"  # the acknowledgement goes through


def test_a_standby_tool_call_closes_the_window_whatever_the_user_said():
    from openai.types.realtime.conversation_item import (
        RealtimeConversationItemFunctionCall,
        RealtimeConversationItemFunctionCallOutput,
    )
    from openai.types.realtime.realtime_conversation_item_user_message import (
        Content as UserContent,
    )
    from openai.types.realtime.realtime_conversation_item_user_message import (
        RealtimeConversationItemUserMessage,
    )

    from speech_to_speech.api.openai_realtime.runtime_config import RuntimeConfig
    from speech_to_speech.LLM.wake_gate import extend_awake_window, gate_turn

    cfg = RuntimeConfig()
    cfg.apply_session_update(
        RealtimeSessionCreateRequest.model_validate(
            {"type": "realtime", "s2s_wake": {"enabled": True, "words": ["sam"]}}
        )
    )
    cfg.chat.add_item(
        RealtimeConversationItemUserMessage(
            type="message", role="user", content=[UserContent(type="input_text", text="Sam, only answer to your name.")]
        )
    )
    cfg.chat.add_item(
        RealtimeConversationItemFunctionCall(
            type="function_call", call_id="call_2", name="set_listening", arguments='{"mode":"standby"}'
        )
    )
    cfg.chat.add_item(
        RealtimeConversationItemFunctionCallOutput(
            type="function_call_output", call_id="call_2", output="Standby is on."
        )
    )
    extend_awake_window(cfg)  # after the acknowledgement reply
    assert cfg.wake_awake_until == 0
    cfg.chat.add_item(
        RealtimeConversationItemUserMessage(
            type="message",
            role="user",
            content=[UserContent(type="input_text", text="Testing, testing, one two three.")],
        )
    )
    assert gate_turn(cfg).answer is False


def test_client_notes_are_never_gated_and_only_overheard_turns_are_dropped():
    from openai.types.realtime.realtime_conversation_item_user_message import (
        Content as UserContent,
    )
    from openai.types.realtime.realtime_conversation_item_user_message import (
        RealtimeConversationItemUserMessage,
    )

    from speech_to_speech.api.openai_realtime.runtime_config import RuntimeConfig
    from speech_to_speech.LLM.wake_gate import drop_last_user_turn, extend_awake_window, gate_turn

    cfg = RuntimeConfig()
    cfg.apply_session_update(
        RealtimeSessionCreateRequest.model_validate(
            {
                "type": "realtime",
                "s2s_wake": {
                    "enabled": True,
                    "words": ["bob"],
                    "others": {"samantha": ["sam"]},
                    "sleep_phrases": ["goodbye"],
                },
            }
        )
    )

    def say(text):
        return cfg.chat.add_item(
            RealtimeConversationItemUserMessage(
                type="message", role="user", content=[UserContent(type="input_text", text=text)]
            )
        )

    # A hand-off note mentions "goodbye" and is a user-role item: it must pass the gate untouched.
    say("(Hand-off note, not spoken by the user: the previous persona has said its goodbye. You are Bob now.)")
    d = gate_turn(cfg)
    assert d.answer is True and d.reason == "client note"
    extend_awake_window(cfg)
    assert cfg.wake_awake_until > 0  # the note is not a sleep phrase
    assert drop_last_user_turn(cfg) is None  # notes are never dropped

    cfg.wake_awake_until = 0
    # Addressed to another persona: declined, but kept so the client can re-request it after switching.
    say("Hey Sam, you there?")
    d = gate_turn(cfg)
    assert d.answer is False and d.other_persona == "samantha" and d.drop is False
    # A sleep phrase is an instruction: declined, kept.
    say("Goodbye.")
    assert gate_turn(cfg).drop is False
    # Overheard talk: declined and dropped.
    say("So anyway, the roof.")
    d = gate_turn(cfg)
    assert d.answer is False and d.drop is True


def test_other_personas_wake_only_when_addressed_at_the_start():
    from speech_to_speech.LLM.wake_gate import contains_wake_word

    cfg = WakeConfig(
        enabled=True, words=["sam", "samantha"], others={"assistant": ["bob"], "robot": ["unit seven", "robot"]}
    )
    # Addressed: at the start, fillers allowed, or a little later with a pause after the name.
    for text in (
        "Bob, are you there?",
        "Hey Bob, what time is it?",
        "Okay, Unit Seven, status?",
        "Good morning, Bob, how are you?",
        "You there Bob?",
    ):
        d = decide(cfg, text, awake_until=0)
        assert d.answer is False and d.other_persona in ("assistant", "robot"), text
    # Mentioned or babbled mid-sentence: not a hand-off; overheard and dropped.
    for text in (
        "Boo boo bob boo lala",
        "I told Bob about the roof",
        "The robot vacuum broke again",
        "Boo boo bob lala boo",
    ):
        d = decide(cfg, text, awake_until=0)
        assert d.answer is False and d.other_persona is None and d.drop is True, text
    # The current persona still wakes from anywhere in the turn.
    assert decide(cfg, "I wonder if Sam knows", awake_until=0).answer is True
    # Modes.
    cfg.others_mode = "anywhere"
    assert decide(cfg, "I told Bob about the roof", awake_until=0).other_persona == "assistant"
    cfg.others_mode = "off"
    assert decide(cfg, "Bob, are you there?", awake_until=0).other_persona is None
    assert contains_wake_word("hey unit seven status", ["unit seven"], leading=3) == "unit seven"


def test_parse_wake_config_reads_others_mode():
    session = RealtimeSessionCreateRequest.model_validate(
        {"type": "realtime", "s2s_wake": {"enabled": True, "words": ["sam"], "others_mode": "off"}}
    )
    assert parse_wake_config(session).others_mode == "off"
    session = RealtimeSessionCreateRequest.model_validate(
        {"type": "realtime", "s2s_wake": {"enabled": True, "words": ["sam"], "others_mode": "bogus"}}
    )
    assert parse_wake_config(session).others_mode == "leading"
