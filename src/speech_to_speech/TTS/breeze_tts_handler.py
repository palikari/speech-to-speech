"""
Breeze TTS 2 Handler (Apple Silicon, mlx-audio)

Runs BreezeBlue/Breeze-TTS-2 through mlx-audio. The voice comes either from a
reference clip (voice clone) or, when no clip is given, from a text
description: one clip is designed at startup with a fixed seed and then
cloned for every utterance, so the voice does not drift between sentences.
"""

from __future__ import annotations

import logging
import tempfile
from pathlib import Path
from sys import platform
from threading import Event
from time import perf_counter
from typing import Any, Iterator, Optional, cast

import numpy as np
from openai.types.realtime.realtime_response_create_params import RealtimeResponseCreateParams
from rich.console import Console

from speech_to_speech.api.openai_realtime.runtime_config import RuntimeConfig
from speech_to_speech.baseHandler import BaseHandler
from speech_to_speech.pipeline.cancel_scope import CancelScope
from speech_to_speech.pipeline.control import SESSION_END, is_control_message
from speech_to_speech.pipeline.events import AssistantOutputEvent
from speech_to_speech.pipeline.handler_types import TTSIn, TTSOut
from speech_to_speech.pipeline.messages import (
    AUDIO_RESPONSE_DONE,
    PIPELINE_END,
    AssistantTextPart,
    EndOfResponse,
    TTSInput,
)
from speech_to_speech.pipeline.speculative_turns import SpeculativeTurnTracker
from speech_to_speech.pipeline.transcript_logging import log_exception
from speech_to_speech.utils.mlx_lock import MLXLockContext

logger = logging.getLogger(__name__)
console = Console()

DEFAULT_MODEL = "mlx-community/Breeze-TTS-2-mlx"
DEFAULT_INSTRUCT = "A calm, clear adult voice with a natural conversational pace and a friendly, neutral tone."
DEFAULT_CFG_SCALE = 4.0
DEFAULT_STREAMING_INTERVAL = 0.4
DEFAULT_MAX_TOKENS = 750
PIPELINE_SR = 16000
# Spoken once at startup to design the voice; its audio becomes the clone
# reference and this text is the reference transcript.
BOOTSTRAP_TEXT = (
    "Hello, I'm the voice of this assistant. I'll keep my answers short and clear, "
    "and I'm happy to go into more detail whenever you ask."
)
MIN_DESCRIPTION_WORDS = 3


class BreezeTTSHandler(BaseHandler[TTSIn, TTSOut]):
    """
    Handles Text-to-Speech using Breeze TTS 2 via mlx-audio.

    Voice selection, in order:
      - ref_audio + ref_text: clone that clip.
      - voice_path pointing at an existing file: reuse a previously designed clip.
      - otherwise: design a clip from `instruct` (seeded), save it, clone it.

    `direction` optionally adds a delivery instruction on top of the clone.
    """

    def setup(
        self,
        should_listen: Event,
        model_name: str = DEFAULT_MODEL,
        instruct: Optional[str] = DEFAULT_INSTRUCT,
        direction: Optional[str] = None,
        ref_audio: Optional[str] = None,
        ref_text: Optional[str] = None,
        voice_path: Optional[str] = None,
        cfg_scale: float = DEFAULT_CFG_SCALE,
        streaming_interval: float = DEFAULT_STREAMING_INTERVAL,
        max_tokens: int = DEFAULT_MAX_TOKENS,
        temperature: float = 0.9,
        top_k: int = 50,
        seed: int = 0,
        blocksize: int = 512,
        gen_kwargs: dict[str, Any] | None = None,
        cancel_scope: CancelScope | None = None,
        speculative_turns: SpeculativeTurnTracker | None = None,
    ) -> None:
        if platform != "darwin":
            raise RuntimeError("Breeze TTS runs on Apple Silicon via mlx-audio only.")
        if streaming_interval <= 0:
            raise ValueError("breeze_tts_streaming_interval must be positive.")
        if max_tokens <= 0:
            raise ValueError("breeze_tts_max_tokens must be positive.")

        self.should_listen = should_listen
        self.cancel_scope = cancel_scope
        self.speculative_turns = speculative_turns
        self.model_name = model_name or DEFAULT_MODEL
        self.instruct = (instruct or "").strip() or None
        self.direction = (direction or "").strip() or None
        self.ref_audio: Optional[str] = ref_audio
        self.ref_text: Optional[str] = ref_text
        self.voice_path = self._normalize_optional_path(voice_path)
        self.cfg_scale = float(cfg_scale)
        self.streaming_interval = float(streaming_interval)
        self.max_tokens = int(max_tokens)
        self.temperature = float(temperature)
        self.top_k = int(top_k)
        self.seed = int(seed)
        self.blocksize = int(blocksize)
        self.gen_kwargs = gen_kwargs or {}
        self._temp_files: set[str] = set()
        self._designed_voices: dict[str, tuple[str, str]] = {}

        logger.info("Loading Breeze TTS model: %s via mlx-audio", self.model_name)
        self.model = self._load_model(self.model_name)
        self.sample_rate = int(getattr(self.model, "sample_rate", 24000))
        logger.info("Breeze TTS model loaded (sample rate %d)", self.sample_rate)

        self._resolve_voice()
        self._initial_ref_audio = self.ref_audio
        self._initial_ref_text = self.ref_text

        logger.info(
            "Breeze TTS streaming %.2fs of audio per chunk%s",
            self.streaming_interval,
            f", direction: {self.direction!r}" if self.direction else "",
        )
        self.warmup()

    # ------------------------------------------------------------------ setup

    def _load_model(self, model_name: str) -> Any:
        try:
            from mlx_audio.tts.utils import load_model
        except ImportError as e:
            raise ImportError(
                "Breeze TTS requires mlx-audio with Breeze support. "
                "Install the project on Apple Silicon (uv sync) so the pinned mlx-audio fork is used."
            ) from e
        return load_model(model_name)

    def _normalize_optional_path(self, value: Any) -> Path | None:
        if value is None or not str(value).strip():
            return None
        return Path(value).expanduser().resolve()

    def _resolve_audio_path(self, audio: Any) -> Path | None:
        if not isinstance(audio, (str, Path)) or not str(audio).strip():
            return None
        candidate = Path(audio).expanduser()
        repo_root = Path(__file__).resolve().parents[1]
        search_paths = [candidate] if candidate.is_absolute() else [Path.cwd() / candidate, repo_root / candidate]
        for path in search_paths:
            if path.is_file():
                return path.resolve()
        return None

    def _resolve_voice(self) -> None:
        if self.ref_audio:
            if not (self.ref_text or "").strip():
                raise ValueError(
                    "breeze_tts_ref_text (the exact transcript of breeze_tts_ref_audio) is required for voice cloning."
                )
            path = self._resolve_audio_path(self.ref_audio)
            if path is None:
                raise FileNotFoundError(f"breeze_tts_ref_audio does not point to a readable file: {self.ref_audio!r}")
            self.ref_audio = str(path)
            logger.info("Breeze TTS voice: cloning %s", path)
            return

        if self.voice_path is not None and self.voice_path.is_file():
            self.ref_audio = str(self.voice_path)
            self.ref_text = (self.ref_text or "").strip() or BOOTSTRAP_TEXT
            logger.info("Breeze TTS voice: reusing designed clip %s", self.voice_path)
            return

        if not self.instruct:
            raise ValueError(
                "Breeze TTS needs a voice: set breeze_tts_ref_audio and breeze_tts_ref_text, "
                "or breeze_tts_instruct to design one."
            )
        self.ref_audio, self.ref_text = self._design_voice(self.instruct, self.voice_path)

    def _design_voice(self, description: str, save_to: Path | None) -> tuple[str, str]:
        """Generate one clip from a description and return (path, transcript)."""
        logger.info("Breeze TTS voice: designing from description (seed %d): %s", self.seed, description)
        started = perf_counter()
        with MLXLockContext(handler_name="BreezeTTS", timeout=60.0) as acquired:
            if not acquired:
                raise TimeoutError("Timed out waiting for MLX lock")
            results = list(
                self.model.generate(
                    text=BOOTSTRAP_TEXT,
                    instruct=description,
                    cfg_scale=self.cfg_scale,
                    max_tokens=self.max_tokens,
                    temperature=self.temperature,
                    top_k=self.top_k,
                    seed=self.seed,
                    stream=False,
                    split_pattern=None,
                    verbose=False,
                )
            )
        pieces: list[np.ndarray] = []
        for result in results:
            piece = self._to_numpy(getattr(result, "audio", None))
            if piece is not None and piece.size > 0:
                pieces.append(piece)
        if not pieces:
            raise RuntimeError("Breeze TTS produced no audio while designing the voice.")
        audio: np.ndarray = np.concatenate(pieces)

        if save_to is not None:
            save_to.parent.mkdir(parents=True, exist_ok=True)
            path = str(save_to)
        else:
            with tempfile.NamedTemporaryFile(prefix="breeze_voice_", suffix=".wav", delete=False) as tmp:
                path = tmp.name
            self._temp_files.add(path)

        import soundfile as sf

        sf.write(path, audio, self.sample_rate, format="WAV", subtype="PCM_16")
        logger.info(
            "Breeze TTS voice: designed %.1fs clip in %.1fs, saved to %s%s",
            audio.size / self.sample_rate,
            perf_counter() - started,
            path,
            "" if save_to is not None else " (pass --breeze_tts_voice_path to keep it)",
        )
        return path, BOOTSTRAP_TEXT

    # ------------------------------------------------------------ generation

    def warmup(self) -> None:
        logger.info("Warming up %s", self.__class__.__name__)
        try:
            for _ in self._generate("Hello, this is a warmup."):
                pass
            logger.info("%s warmed up", self.__class__.__name__)
        except Exception as e:
            logger.warning("Warmup generation failed: %s", e)

    def _generation_kwargs(self, text: str) -> dict[str, Any]:
        kwargs: dict[str, Any] = {
            "text": text,
            "ref_audio": self.ref_audio,
            "ref_text": self.ref_text,
            "max_tokens": self.max_tokens,
            "temperature": self.temperature,
            "top_k": self.top_k,
            "stream": True,
            "streaming_interval": self.streaming_interval,
            "split_pattern": None,
            "verbose": False,
        }
        if self.direction:
            kwargs["instruct"] = self.direction
            kwargs["cfg_scale"] = self.cfg_scale
        kwargs.update(self.gen_kwargs)
        return kwargs

    def _generate(self, text: str) -> Iterator[np.ndarray]:
        with MLXLockContext(handler_name="BreezeTTS", timeout=10.0) as acquired:
            if not acquired:
                raise TimeoutError("Timed out waiting for MLX lock")
            label = "clone+direction" if self.direction else "clone"
            yield from self._stream(self.model.generate(**self._generation_kwargs(text)), label=label)

    @staticmethod
    def _to_numpy(audio: Any) -> np.ndarray | None:
        if audio is None:
            return None
        if not isinstance(audio, np.ndarray):
            try:
                import mlx.core as mx

                if isinstance(audio, mx.array):
                    audio = np.array(audio.astype(mx.float32))
            except ImportError:
                pass
        return np.asarray(audio, dtype=np.float32).reshape(-1)

    def _prepare_audio_chunk(self, item: Any) -> tuple[np.ndarray | None, int | None]:
        if isinstance(item, tuple):
            audio_chunk, sr = item[0], item[1]
            return self._to_numpy(audio_chunk), int(sr)
        audio = self._to_numpy(getattr(item, "audio", None))
        if audio is None:
            return None, None
        sr = getattr(item, "sample_rate", None) or self.sample_rate
        return audio, int(sr)

    def _resample_to_pipeline_sr(self, audio: np.ndarray, sr: int) -> np.ndarray:
        if sr == PIPELINE_SR:
            return audio
        from scipy.signal import resample_poly

        gcd = np.gcd(PIPELINE_SR, sr)
        return resample_poly(audio, up=PIPELINE_SR // gcd, down=sr // gcd)

    def _to_int16(self, audio: np.ndarray) -> np.ndarray:
        return np.clip(audio * 32768, -32768, 32767).astype(np.int16)

    def _stream(self, gen: Any, label: str) -> Iterator[np.ndarray]:
        """Common streaming loop: log TTFA and RTF, yield int16 blocks at PIPELINE_SR."""
        cancel_gen = self.cancel_scope.generation if self.cancel_scope else None
        start = perf_counter()
        total_samples = 0
        first_chunk = True
        found_speech = False
        leftover = np.array([], dtype=np.int16)

        for item in gen:
            if cancel_gen is not None and self.cancel_scope is not None and self.cancel_scope.is_stale(cancel_gen):
                logger.info("TTS generation cancelled (interruption)")
                return

            audio_chunk, sr = self._prepare_audio_chunk(item)
            if audio_chunk is None or sr is None or audio_chunk.size == 0:
                continue

            if first_chunk:
                logger.info(f"Breeze-TTS TTFA: {perf_counter() - start:.2f}s ({label})")
                first_chunk = False

            audio_chunk = self._resample_to_pipeline_sr(audio_chunk, sr)
            audio_chunk = self._to_int16(audio_chunk)

            # Trim the initial silent ramp-up but keep 40 ms of preroll so soft
            # initial phonemes are not shaved off.
            if not found_speech:
                threshold = int(32768 * 0.01)
                above = np.abs(audio_chunk) > threshold
                if not np.any(above):
                    continue
                start_idx = max(0, int(np.argmax(above)) - int(PIPELINE_SR * 0.040))
                audio_chunk = audio_chunk[start_idx:]
                found_speech = True

            audio_chunk = np.concatenate([leftover, audio_chunk])
            n = (len(audio_chunk) // self.blocksize) * self.blocksize
            for i in range(0, n, self.blocksize):
                yield audio_chunk[i : i + self.blocksize]
                total_samples += self.blocksize
            leftover = audio_chunk[n:]

        if len(leftover) > 0:
            yield np.pad(leftover, (0, self.blocksize - len(leftover)))
            total_samples += len(leftover)

        generation_time = perf_counter() - start
        audio_duration = total_samples / PIPELINE_SR
        rtf = audio_duration / generation_time if generation_time > 0 else 0
        logger.info(
            f"Breeze-TTS generated {audio_duration:.2f}s audio in {generation_time:.2f}s (RTF: {rtf:.2f}, {label})"
        )

    # --------------------------------------------------------------- session

    def _apply_session_voice_override(
        self,
        runtime_config: RuntimeConfig | None = None,
        response: RealtimeResponseCreateParams | None = None,
    ) -> None:
        session_voice: Optional[str] = None
        if response and response.audio and response.audio.output:
            resp_voice = response.audio.output.voice
            session_voice = str(resp_voice) if resp_voice else None
        if not session_voice and runtime_config is not None:
            audio = runtime_config.session.audio
            output = audio.output if audio is not None else None
            sess_voice = output.voice if output is not None else None
            session_voice = str(sess_voice) if sess_voice else None
        if not session_voice:
            return

        if self._resolve_audio_path(session_voice) is not None:
            logger.warning(
                "Ignoring Breeze-TTS session voice %r: cloning a clip needs its transcript; "
                "start the server with breeze_tts_ref_audio and breeze_tts_ref_text instead.",
                session_voice,
            )
            return

        # A multi-word voice string is treated as a description: design it once
        # per server process and clone it for the rest of the session.
        if len(session_voice.split()) < MIN_DESCRIPTION_WORDS:
            logger.warning(
                "Ignoring Breeze-TTS session voice %r: Breeze has no named speakers; "
                "pass a voice description of at least %d words to design one.",
                session_voice,
                MIN_DESCRIPTION_WORDS,
            )
            return

        designed = self._designed_voices.get(session_voice)
        if designed is None:
            try:
                designed = self._design_voice(session_voice, None)
            except Exception as exc:
                log_exception(logger, "Failed to design Breeze-TTS session voice", exc)
                return
            self._designed_voices[session_voice] = designed
        self.ref_audio, self.ref_text = designed

    def on_session_end(self) -> None:
        self.ref_audio = self._initial_ref_audio
        self.ref_text = self._initial_ref_text
        logger.debug("Breeze-TTS session state reset")

    def _coalesce_pending_tts_input(self, current_input: TTSInput) -> tuple[str, Optional[str]]:
        """Combine already-queued text chunks before the next TTS synthesis call."""
        if not hasattr(self.queue_in, "mutex") or not hasattr(self.queue_in, "queue"):
            return current_input.text, current_input.language_code

        text = current_input.text
        language_code = current_input.language_code

        parts = [text.strip()] if text and text.strip() else []
        text_events: list[AssistantOutputEvent] = []

        def same_response(item: TTSInput | AssistantOutputEvent) -> bool:
            return (
                item.turn_id == current_input.turn_id
                and item.turn_revision == current_input.turn_revision
                and item.cancel_generation == current_input.cancel_generation
                and item.response_key == current_input.response_key
            )

        with self.queue_in.mutex:
            while self.queue_in.queue:
                next_item = self.queue_in.queue[0]
                if is_control_message(next_item, SESSION_END.kind):
                    break
                if isinstance(next_item, bytes) and next_item == PIPELINE_END:
                    break
                if isinstance(next_item, EndOfResponse):
                    break
                if isinstance(next_item, AssistantOutputEvent):
                    if not same_response(next_item) or any(
                        not isinstance(part, AssistantTextPart) for part in next_item.parts
                    ):
                        break
                    text_events.append(self.queue_in.queue.popleft())
                    continue
                if not isinstance(next_item, TTSInput):
                    break
                if not same_response(next_item):
                    break
                if (
                    language_code is not None
                    and next_item.language_code is not None
                    and next_item.language_code != language_code
                ):
                    break

                self.queue_in.queue.popleft()
                if next_item.text.strip():
                    parts.append(next_item.text.strip())
                if language_code is None:
                    language_code = next_item.language_code

        # Forward the text events absorbed above before synthesis so protocol
        # ordering remains text -> audio.
        for event in text_events:
            self.queue_out.put(cast(TTSOut, event))

        combined_text = " ".join(parts).strip()
        return combined_text, language_code

    def process(self, tts_input: TTSIn) -> Iterator[TTSOut]:
        speculative_turns = getattr(self, "speculative_turns", None)
        if isinstance(tts_input, EndOfResponse):
            if speculative_turns and not speculative_turns.is_latest_after_reopen_grace(
                tts_input.turn_id,
                tts_input.turn_revision,
            ):
                if tts_input.response_key is None:
                    return
                tts_input.cleanup_only = True
            yield AUDIO_RESPONSE_DONE
            return

        if speculative_turns and not speculative_turns.is_latest_after_reopen_grace(
            tts_input.turn_id,
            tts_input.turn_revision,
        ):
            logger.debug("Dropping stale TTS input for turn=%s rev=%s", tts_input.turn_id, tts_input.turn_revision)
            return
        if speculative_turns:
            speculative_turns.commit(tts_input.turn_id, tts_input.turn_revision)

        coalesced_text, _language_code = self._coalesce_pending_tts_input(tts_input)
        text = coalesced_text or "Hello."

        self._apply_session_voice_override(tts_input.runtime_config, tts_input.response)

        console.print(f"[green]ASSISTANT: {text}")

        try:
            first_audio = True
            for audio_chunk in self._generate(text):
                if first_audio:
                    self._log_first_audio_latency(tts_input)
                    first_audio = False
                yield audio_chunk
        except Exception as exc:
            log_exception(logger, "Error during Breeze-TTS generation", exc)

    def _log_first_audio_latency(self, tts_input: TTSInput) -> None:
        if tts_input.speech_stopped_at_s is None:
            return
        latency_s = perf_counter() - tts_input.speech_stopped_at_s
        if latency_s < 0:
            return
        logger.info(
            "Last speech detected to first speech out: %.3fs (turn=%s rev=%s)",
            latency_s,
            tts_input.turn_id,
            tts_input.turn_revision,
        )

    def cleanup(self) -> None:
        try:
            del self.model
            for path in list(getattr(self, "_temp_files", set())):
                try:
                    Path(path).unlink(missing_ok=True)
                except Exception:
                    pass
            try:
                import mlx.core as mx

                mx.clear_cache()
            except Exception:
                pass
            logger.info("Breeze-TTS handler cleaned up")
        except Exception as e:
            logger.warning(f"Cleanup error: {e}")
