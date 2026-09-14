# speech-to-speech (palikari fork) — working notes for Claude

This is Michael's fork of huggingface/speech-to-speech. Upstream's own rules in
AGENTS.md apply here too (no merges to main without explicit confirmation, no
history rewrites on open PRs, no committed build artifacts). README.md is the
usage reference; this file is the project state and the hand-off between his
two Macs. Keep it short and current.

## Purpose

Local voice assistant on Apple Silicon, intended as the base for a "Jarvis"
style agent. The TTS is being switched to Breeze TTS 2 with the inference
speed-ups from `~/Documents/apps/breeze-tts` (see that repo's README and
CLAUDE.md).

## Repos and machines

- `origin` = github.com/palikari/speech-to-speech (this fork). Work happens on
  branch `breeze-tts`. `main` tracks upstream and is only ever fast-forwarded.
- `upstream` = github.com/huggingface/speech-to-speech. Pull their changes with
  `git fetch upstream && git checkout main && git merge --ff-only upstream/main`,
  then rebase or merge `breeze-tts` onto it.
- mlx-audio comes from the palikari fork, branch `breeze-speedups`, via
  `[tool.uv.sources]` in pyproject.toml. `uv.lock` is committed (upstream
  ignores it; this fork does not) so both machines resolve the same commit.
  To pick up a new library commit: `uv lock --upgrade-package mlx-audio && uv sync`.
- Same path on both Macs: `~/Documents/apps/s2s/speech-to-speech`
  (case-insensitive FS; may show as `Documents/Apps`).
  MacBook Pro = M4 Max 128 GB, Mac Studio = M3 Ultra 512 GB.

## Environment

```bash
uv sync --python 3.12 --extra mlx-lm --group demo --group dev   # after pull
npm ci --prefix demo                                             # browser demo
.venv/bin/python -m pytest -q                                    # tests
```

Always use `.venv/bin/...` from this folder. There is an older conda env named
`s2s` with the PyPI 0.2.12 package; it is the pre-fork fallback, not used here.

## Running

Server (port 8765) with the chosen defaults:

```bash
.venv/bin/speech-to-speech serve --stt parakeet-tdt --llm_backend mlx-lm \
  --model_name mlx-community/Qwen3.8-27B-8bit \
  --tts breeze --breeze_tts_voice_path voices/assistant.wav --enable_live_transcription
```

`voices/assistant.wav` is the designed assistant voice (committed, so both Macs
sound the same). Delete it and change `--breeze_tts_instruct` to design a new
one; it is regenerated on the next start with seed 0.

Browser demo (port 7860), in a second terminal:

```bash
SPEECH_TO_SPEECH_URL=ws://localhost:8765/v1/realtime \
  .venv/bin/uvicorn --app-dir demo server:app --port 7860
```

Then open http://localhost:7860/. oMLX on port 8000 is an unrelated app; leave it.

## Decisions

- LLM: `mlx-community/Qwen3.8-27B-8bit`. Thinking is already disabled for the
  mlx-lm backend (`enable_thinking=False` in the chat template, LLM/language_model.py).
  Perceived "thinking" delay is time-to-first-token plus the sentence boundary
  before TTS; measure both before changing anything.
- TTS: Breeze TTS 2 bf16 via `--tts breeze` (`TTS/breeze_tts_handler.py`,
  `arguments_classes/breeze_tts_arguments.py`, registered in
  `backend_registry.py`). Breeze's design mode samples a new voice identity per
  call, so the handler designs one clip at startup (seeded) and clones it for
  every utterance; `--breeze_tts_direction` adds a delivery instruction on top.
  A multi-word `voice` in the Realtime session config is treated as a new
  description and designed once per process.

## Current state

_Update at the end of a session that changed something._

- 2026-09-14: Forked, remotes re-pointed, `main` fast-forwarded to upstream
  v1.0.0, branch `breeze-tts` created. mlx-audio switched to the palikari fork
  (0.5.3 + speed-ups); all handlers import, test suite passes, server starts
  with the previous Qwen3-TTS config.
- 2026-09-14: Breeze handler done and live-tested (synthetic client, 3 turns,
  1632 tests pass). Per turn on the M3 Ultra: VAD+STT ~0.1 s, LLM 1.95-2.5 s
  to the first sentence, Breeze TTFA 0.33-0.40 s; last-speech-to-first-audio
  2.3-3.0 s. TTS steady state ~1.8x real time.
- Open threads: the LLM stage is the latency floor. `LLM/language_model.py`
  has no mlx-lm prompt cache across turns and logs no TTFT, so each turn
  re-processes the system prompt + history. Next: add a KV prompt cache
  (mlx_lm make_prompt_cache) and TTFT logging, then consider a smaller or
  4-bit LLM if still slow. Breeze `streaming_interval` 0.2 would trim ~0.15 s
  of TTFA at some per-chunk overhead; untested.
