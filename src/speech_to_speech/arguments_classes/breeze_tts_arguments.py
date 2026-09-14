from dataclasses import dataclass, field
from typing import Optional


@dataclass
class BreezeTTSHandlerArguments:
    breeze_tts_model_name: str = field(
        default="mlx-community/Breeze-TTS-2-mlx",
        metadata={
            "help": "Breeze TTS 2 MLX model (HuggingFace Hub ID or local path). Default is the bf16 conversion 'mlx-community/Breeze-TTS-2-mlx'; '-8bit' and '-4bit' variants also exist."
        },
    )
    breeze_tts_instruct: str = field(
        default="A calm, clear adult voice with a natural conversational pace and a friendly, neutral tone.",
        metadata={
            "help": "Voice description used when no reference clip is given. One clip is designed from it at startup (fixed seed) and then cloned for every utterance so the voice stays consistent."
        },
    )
    breeze_tts_direction: Optional[str] = field(
        default=None,
        metadata={
            "help": "Optional delivery instruction applied to every utterance on top of the cloned voice, e.g. 'Speak slowly with a serious tone.' Costs nothing extra in speed but uses classifier-free guidance (breeze_tts_cfg_scale)."
        },
    )
    breeze_tts_ref_audio: Optional[str] = field(
        default=None,
        metadata={
            "help": "Path to a clean reference clip (5-15 s, 24 kHz mono WAV preferred) for voice cloning. Requires breeze_tts_ref_text. When unset, a voice is designed from breeze_tts_instruct."
        },
    )
    breeze_tts_ref_text: Optional[str] = field(
        default=None,
        metadata={"help": "Exact transcript of breeze_tts_ref_audio. Required for voice cloning."},
    )
    breeze_tts_voice_path: Optional[str] = field(
        default=None,
        metadata={
            "help": "Where to save the clip designed from breeze_tts_instruct. If the file already exists it is reused instead of designing again, so the assistant keeps the same voice across restarts. Unset uses a temporary file."
        },
    )
    breeze_tts_cfg_scale: float = field(
        default=4.0,
        metadata={
            "help": "Classifier-free guidance scale for voice design and direction. Default is 4.0; 1.0 disables guidance."
        },
    )
    breeze_tts_streaming_interval: float = field(
        default=0.4,
        metadata={
            "help": "Seconds of audio per streamed chunk. Smaller values lower time-to-first-audio; larger values reduce per-chunk overhead. Default is 0.4."
        },
    )
    breeze_tts_max_tokens: int = field(
        default=750,
        metadata={
            "help": "Hard cap on codec frames per utterance (12.5 frames per second of audio, so 750 is 60 s). Each utterance also gets a budget estimated from its text, so this only matters for very long replies."
        },
    )
    breeze_tts_max_trailing_silence: float = field(
        default=1.2,
        metadata={
            "help": "Stop a sentence once the model has produced this many seconds of silence after speech. Guards against the model emitting silence instead of end-of-speech; text is synthesized sentence by sentence so only pauses within a sentence count. Measured: pauses inside a sentence stay under 1 s; the model's silence before end-of-speech runs up to ~1.7 s and sometimes never ends. 0 disables. Default is 1.2."
        },
    )
    breeze_tts_temperature: float = field(
        default=0.9,
        metadata={"help": "Sampling temperature. Default is 0.9."},
    )
    breeze_tts_top_k: int = field(
        default=50,
        metadata={"help": "Top-k sampling cutoff. Default is 50."},
    )
    breeze_tts_repetition_penalty: float = field(
        default=1.2,
        metadata={
            "help": "Penalty on repeating a codec token within an utterance. 1.0 disables. Suppresses held sounds ('borrrr') and silence-instead-of-end-of-speech; measured 0/80 runaways at 1.2 vs 5/80 at 1.0. Default is 1.2."
        },
    )
    breeze_tts_seed: int = field(
        default=0,
        metadata={
            "help": "Seed used when designing the startup voice clip, so the same description yields the same voice."
        },
    )
    breeze_tts_blocksize: int = field(
        default=512,
        metadata={"help": "Audio chunk size in samples for streaming output. Default is 512."},
    )
