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

    def __init__(self):
        self.calls = []

    def generate(self, **kwargs):
        self.calls.append(kwargs)
        yield SimpleNamespace(audio=np.full(2400, 0.1, dtype=np.float32), sample_rate=24000)
        yield SimpleNamespace(audio=np.full(2400, -0.1, dtype=np.float32), sample_rate=24000)


def _make_handler(monkeypatch, tmp_path, **setup_kwargs):
    fake = _FakeModel()
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

    design, warmup = fake.calls
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
    handler, fake = _make_handler(monkeypatch, tmp_path)
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
