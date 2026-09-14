import logging
from queue import Queue
from threading import Event
from types import SimpleNamespace

import numpy as np
import pytest
import soundfile as sf

import speech_to_speech.TTS.breeze_tts_handler as breeze_module
from speech_to_speech.arguments_classes.breeze_tts_arguments import BreezeTTSHandlerArguments
from speech_to_speech.backend_registry import TTS_BACKENDS
from speech_to_speech.pipeline.messages import AUDIO_RESPONSE_DONE, EndOfResponse, TTSInput
from speech_to_speech.TTS.breeze_tts_handler import (
    BOOTSTRAP_TEXT,
    DEFAULT_INSTRUCT,
    PIPELINE_SR,
    BreezeTTSHandler,
)


class _FakeModel:
    sample_rate = 24000

    def __init__(self, design_audio_by_seed=None):
        self.calls = []
        # seed -> float32 array returned for design passes (stream=False)
        self.design_audio_by_seed = design_audio_by_seed or {}

    def generate(self, **kwargs):
        self.calls.append(kwargs)
        if kwargs.get("stream") is False and kwargs.get("seed") in self.design_audio_by_seed:
            yield SimpleNamespace(audio=self.design_audio_by_seed[kwargs["seed"]], sample_rate=24000)
            return
        yield SimpleNamespace(audio=np.full(2400, 0.1, dtype=np.float32), sample_rate=24000)
        yield SimpleNamespace(audio=np.full(2400, -0.1, dtype=np.float32), sample_rate=24000)


def _make_handler(monkeypatch, tmp_path, design_audio_by_seed=None, **setup_kwargs):
    fake = _FakeModel(design_audio_by_seed)
    monkeypatch.setattr(breeze_module, "platform", "darwin")
    monkeypatch.setattr(BreezeTTSHandler, "_load_model", lambda self, name: fake)
    handler = object.__new__(BreezeTTSHandler)
    handler.queue_in = Queue()
    handler.queue_out = Queue()
    setup_kwargs.setdefault("voice_path", str(tmp_path / "voice.wav"))
    handler.setup(should_listen=Event(), **setup_kwargs)
    return handler, fake


def _write_clip(path, seconds=1.0):
    sf.write(str(path), np.zeros(int(24000 * seconds), dtype=np.float32), 24000, subtype="PCM_16")
    return str(path)


def test_setup_designs_voice_once_then_clones_it(monkeypatch, tmp_path):
    handler, fake = _make_handler(monkeypatch, tmp_path)

    design, warmup = fake.calls[0], fake.calls[-1]
    assert design["text"] == BOOTSTRAP_TEXT
    assert design["instruct"] == DEFAULT_INSTRUCT
    assert design["seed"] == 0
    assert design["stream"] is False

    voice_file = tmp_path / "voice.wav"
    assert voice_file.is_file()
    audio, sr = sf.read(str(voice_file))
    assert sr == 24000
    assert len(audio) == 4800

    assert handler.ref_audio == str(voice_file)
    assert handler.ref_text == BOOTSTRAP_TEXT
    assert warmup["ref_audio"] == str(voice_file)
    assert warmup["ref_text"] == BOOTSTRAP_TEXT
    assert warmup["stream"] is True
    assert "instruct" not in warmup
    assert design["max_tokens"] < handler.max_tokens  # budgeted, never the 60 s cap


def test_setup_reuses_saved_designed_voice(monkeypatch, tmp_path):
    saved = _write_clip(tmp_path / "voice.wav")
    handler, fake = _make_handler(monkeypatch, tmp_path, voice_path=saved)

    assert len(fake.calls) == 1  # warmup only, no design pass
    assert fake.calls[0]["ref_audio"] == saved
    assert handler.ref_text == BOOTSTRAP_TEXT


def test_setup_clones_reference_clip(monkeypatch, tmp_path):
    clip = _write_clip(tmp_path / "me.wav")
    handler, fake = _make_handler(monkeypatch, tmp_path, ref_audio=clip, ref_text="This is me talking.")

    assert len(fake.calls) == 1
    assert fake.calls[0]["ref_audio"] == clip
    assert fake.calls[0]["ref_text"] == "This is me talking."
    assert not (tmp_path / "voice.wav").exists()


def test_setup_requires_transcript_for_reference_clip(monkeypatch, tmp_path):
    clip = _write_clip(tmp_path / "me.wav")
    with pytest.raises(ValueError, match="breeze_tts_ref_text"):
        _make_handler(monkeypatch, tmp_path, ref_audio=clip)


def test_setup_rejects_missing_reference_clip(monkeypatch, tmp_path):
    with pytest.raises(FileNotFoundError):
        _make_handler(monkeypatch, tmp_path, ref_audio=str(tmp_path / "nope.wav"), ref_text="x")


def test_direction_adds_instruct_and_guidance_to_each_utterance(monkeypatch, tmp_path):
    _handler, fake = _make_handler(monkeypatch, tmp_path, direction="Speak slowly and seriously.", cfg_scale=3.0)

    warmup = fake.calls[-1]
    assert warmup["instruct"] == "Speak slowly and seriously."
    assert warmup["cfg_scale"] == 3.0


def test_setup_refuses_off_darwin(monkeypatch, tmp_path):
    monkeypatch.setattr(breeze_module, "platform", "linux")
    handler = object.__new__(BreezeTTSHandler)
    with pytest.raises(RuntimeError, match="Apple Silicon"):
        handler.setup(should_listen=Event())


def test_stream_resamples_to_pipeline_rate_in_fixed_blocks(monkeypatch, tmp_path, caplog):
    handler, _fake = _make_handler(monkeypatch, tmp_path, blocksize=512)

    chunks = [
        SimpleNamespace(audio=np.full(2400, 0.1, dtype=np.float32), sample_rate=24000),
        SimpleNamespace(audio=np.full(2400, -0.1, dtype=np.float32), sample_rate=24000),
    ]
    with caplog.at_level(logging.INFO, logger="speech_to_speech.TTS.breeze_tts_handler"):
        blocks = list(handler._stream(iter(chunks), label="test"))

    # 4800 samples at 24 kHz -> 3200 at 16 kHz -> 6 full blocks + 1 padded block
    assert len(blocks) == 7
    assert all(block.dtype == np.int16 and len(block) == 512 for block in blocks)
    assert PIPELINE_SR == 16000
    assert "Breeze-TTS TTFA" in caplog.text
    assert "RTF" in caplog.text


def test_process_end_of_response_emits_done():
    handler = object.__new__(BreezeTTSHandler)
    assert list(handler.process(EndOfResponse())) == [AUDIO_RESPONSE_DONE]


def test_process_streams_blocks_and_logs_first_audio_latency(monkeypatch, tmp_path, caplog):
    handler, _fake = _make_handler(monkeypatch, tmp_path)
    handler.cancel_scope = None
    handler.speculative_turns = None
    handler._generate = lambda text: iter([np.zeros(512, dtype=np.int16), np.zeros(512, dtype=np.int16)])
    monkeypatch.setattr(breeze_module.console, "print", lambda *args, **kwargs: None)

    with caplog.at_level(logging.INFO, logger="speech_to_speech.TTS.breeze_tts_handler"):
        outputs = list(
            handler.process(TTSInput(text="Hello there.", speech_stopped_at_s=breeze_module.perf_counter() - 1.0))
        )

    assert len(outputs) == 2
    assert "Last speech detected to first speech out:" in caplog.text


def test_process_swallows_generation_errors(monkeypatch, tmp_path):
    handler, _fake = _make_handler(monkeypatch, tmp_path)
    handler.cancel_scope = None
    handler.speculative_turns = None

    def _boom(text):
        raise RuntimeError("boom")
        yield  # pragma: no cover

    handler._generate = _boom
    monkeypatch.setattr(breeze_module.console, "print", lambda *args, **kwargs: None)

    assert list(handler.process(TTSInput(text="Hello there."))) == []


def test_session_voice_description_designs_new_voice_once(monkeypatch, tmp_path):
    good = np.full(24000 * 9, 0.1, dtype=np.float32)
    handler, fake = _make_handler(monkeypatch, tmp_path, design_audio_by_seed={0: good})
    calls_before = len(fake.calls)
    runtime = SimpleNamespace(
        session=SimpleNamespace(audio=SimpleNamespace(output=SimpleNamespace(voice="a gruff old sea captain")))
    )

    handler._apply_session_voice_override(runtime, None)
    first_voice = handler.ref_audio
    handler._apply_session_voice_override(runtime, None)

    assert len(fake.calls) == calls_before + 1
    assert fake.calls[-1]["instruct"] == "a gruff old sea captain"
    assert handler.ref_audio == first_voice != str(tmp_path / "voice.wav")

    handler.on_session_end()
    assert handler.ref_audio == str(tmp_path / "voice.wav")


def test_session_voice_short_name_is_ignored(monkeypatch, tmp_path):
    handler, fake = _make_handler(monkeypatch, tmp_path)
    calls_before = len(fake.calls)
    runtime = SimpleNamespace(session=SimpleNamespace(audio=SimpleNamespace(output=SimpleNamespace(voice="alloy"))))

    handler._apply_session_voice_override(runtime, None)

    assert len(fake.calls) == calls_before
    assert handler.ref_audio == str(tmp_path / "voice.wav")


def test_registry_exposes_breeze_with_stripped_prefix():
    spec = TTS_BACKENDS["breeze"]
    config = spec.normalize(BreezeTTSHandlerArguments(breeze_tts_instruct="A test voice."))

    assert config["instruct"] == "A test voice."
    assert config["model_name"] == "mlx-community/Breeze-TTS-2-mlx"
    assert not any(key.startswith("breeze_tts_") for key in config)


def test_stream_stops_after_sustained_trailing_silence(monkeypatch, tmp_path, caplog):
    handler, _fake = _make_handler(monkeypatch, tmp_path, blocksize=512, max_trailing_silence=1.0)
    pulled = []

    def chunks():
        # 0.5 s of speech, then silence forever (the model failed to emit EOS)
        items = [SimpleNamespace(audio=np.full(12000, 0.1, dtype=np.float32), sample_rate=24000)]
        items += [SimpleNamespace(audio=np.zeros(9600, dtype=np.float32), sample_rate=24000)] * 50
        for i, item in enumerate(items):
            pulled.append(i)
            yield item

    with caplog.at_level(logging.INFO, logger="speech_to_speech.TTS.breeze_tts_handler"):
        blocks = list(handler._stream(chunks(), label="test"))

    total_seconds = sum(len(b) for b in blocks) / PIPELINE_SR
    assert 0.5 <= total_seconds <= 1.5  # speech + a short silent tail, not 20 s
    assert len(pulled) < 10  # generation was abandoned early, not drained
    assert "stopped after 1.0s of trailing silence" in caplog.text


def test_stream_keeps_natural_pauses_shorter_than_the_limit(monkeypatch, tmp_path):
    handler, _fake = _make_handler(monkeypatch, tmp_path, blocksize=512, max_trailing_silence=1.0)
    speech = SimpleNamespace(audio=np.full(9600, 0.1, dtype=np.float32), sample_rate=24000)
    pause = SimpleNamespace(audio=np.zeros(9600, dtype=np.float32), sample_rate=24000)  # 0.4 s

    blocks = list(handler._stream(iter([speech, pause, speech, pause, speech]), label="test"))

    total_seconds = sum(len(b) for b in blocks) / PIPELINE_SR
    assert total_seconds >= 1.9  # all five chunks (2.0 s at 24 kHz) survived


def test_utterance_frame_budget_scales_with_text(monkeypatch, tmp_path):
    handler, fake = _make_handler(monkeypatch, tmp_path)

    short = handler._estimate_max_tokens("Hello there.")
    medium = handler._estimate_max_tokens(
        "Honestly, it's the endless horizon. There's something grounding about the ocean."
    )
    huge = handler._estimate_max_tokens("word " * 2000)

    assert 60 <= short < medium < huge == handler.max_tokens
    assert medium < 200  # two sentences never get the 60 s cap
    list(handler._generate("Hello there."))
    assert fake.calls[-1]["max_tokens"] == short


def _speech(seconds):
    return np.full(int(24000 * seconds), 0.1, dtype=np.float32)


def test_design_retries_with_next_seed_when_clip_is_mostly_silence(monkeypatch, tmp_path, caplog):
    poisoned = np.concatenate([_speech(1.0), np.zeros(24000 * 59, dtype=np.float32)])  # 1 s speech, 59 s silence
    good = np.concatenate([_speech(9.0), np.zeros(24000 * 3, dtype=np.float32)])

    with caplog.at_level(logging.WARNING, logger="speech_to_speech.TTS.breeze_tts_handler"):
        handler, fake = _make_handler(monkeypatch, tmp_path, design_audio_by_seed={0: poisoned, 1: good})

    seeds = [c["seed"] for c in fake.calls if c.get("stream") is False]
    assert seeds == [0, 1]
    assert "produced only 1.3s of speech; retrying" in caplog.text  # 1 s speech + 0.3 s kept tail
    audio, sr = sf.read(str(tmp_path / "voice.wav"))
    assert 9.0 <= len(audio) / sr <= 9.5  # trailing silence trimmed to a short tail
    assert handler.ref_audio == str(tmp_path / "voice.wav")


def test_design_caps_reference_clip_length(monkeypatch, tmp_path):
    _handler, _fake = _make_handler(monkeypatch, tmp_path, design_audio_by_seed={0: _speech(40.0)})

    audio, sr = sf.read(str(tmp_path / "voice.wav"))
    assert len(audio) / sr == 15.0


def test_design_keeps_best_attempt_when_all_are_short(monkeypatch, tmp_path):
    _handler, fake = _make_handler(
        monkeypatch, tmp_path, design_audio_by_seed={0: _speech(0.5), 1: _speech(2.0), 2: _speech(1.0)}
    )

    seeds = [c["seed"] for c in fake.calls if c.get("stream") is False]
    assert seeds == [0, 1, 2]
    audio, sr = sf.read(str(tmp_path / "voice.wav"))
    assert abs(len(audio) / sr - 2.0) < 0.05


def test_generate_synthesizes_sentence_by_sentence(monkeypatch, tmp_path):
    handler, fake = _make_handler(monkeypatch, tmp_path)
    calls_before = len(fake.calls)

    blocks = list(handler._generate("Why did the robot break up with the toaster? Because it was too hot.\nReally."))

    texts = [c["text"] for c in fake.calls[calls_before:]]
    assert texts == ["Why did the robot break up with the toaster?", "Because it was too hot.", "Really."]
    assert len(blocks) == 3 * 7  # each fake sentence yields the same 7 blocks


def test_runaway_sentence_does_not_lose_the_next_one(monkeypatch, tmp_path):
    handler, fake = _make_handler(monkeypatch, tmp_path, max_trailing_silence=1.0)

    def generate(**kwargs):
        fake.calls.append(kwargs)
        yield SimpleNamespace(audio=np.full(12000, 0.1, dtype=np.float32), sample_rate=24000)
        if kwargs["text"].startswith("First"):
            for _ in range(50):  # runaway silence instead of end-of-speech
                yield SimpleNamespace(audio=np.zeros(9600, dtype=np.float32), sample_rate=24000)

    fake.generate = generate
    calls_before = len(fake.calls)
    blocks = list(handler._generate("First sentence runs away. Second sentence is fine."))

    assert [c["text"] for c in fake.calls[calls_before:]] == ["First sentence runs away.", "Second sentence is fine."]
    assert 1.3 <= sum(len(b) for b in blocks) / PIPELINE_SR <= 3.0
