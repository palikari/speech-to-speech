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
- 2026-09-14 (later): Breeze reliability work. Found and fixed three things:
  (1) the model sometimes emits silence instead of end-of-speech and runs to
  max_tokens (60 s of dead air while the mic stays closed); (2) a designed
  reference clip that hit that failure poisoned every later clone (the voice
  went quiet after one sentence); (3) an early trailing-silence guard at 1.5 s
  cut replies at the sentence boundary because inter-sentence pauses in the
  server ran 1.5 s+. Now: text is synthesized sentence by sentence, each with
  a text-based frame budget and a 1.2 s trailing-silence cutoff; a runaway
  sentence is cut and the next one still plays; voice design is budgeted,
  trimmed, requires 6 s of speech and retries with the next seed. Verified
  with STT-transcribed replies: 10/10 complete over 15 sentences (was 2/10).
  Measured pauses: inside a sentence <= 0.9 s (comma); before end-of-speech
  up to ~1.7 s. Demo voice field now takes a Breeze description.
- Explained: the "lab never fails, server does" gap was the lab's fault:
  fixed seeds 0-5 reused everywhere, i.e. six identical random streams.
  Unseeded, the model fails at the same rate everywhere. Lesson for any
  future Breeze measurement: never pass a seed; run 10+ unseeded trials.
- Michael's browser test: "Born ready." came out as a held "borrrrr" (5 s
  for two words). Same mechanism as the silence runaway: one codec token
  repeated. Unseeded measurement over 80 sentences: 5 runaways at
  repetition_penalty 1.0, 2 at 1.1, 0 at 1.2 with all transcripts complete.
  Default is now 1.2 (`--breeze_tts_repetition_penalty`); per-sentence
  synthesis keeps the penalised history short. Live: 12/12 complete
  including one-word answers, 0 guard firings.
- 2026-09-14 (demo UI): "Getting ready…" warm-up state on the orb from the
  tap until the first audible assistant word (steps: Connecting / Waking the
  model / Warming up the voice; 25 s fail-safe), and assistant bubbles now
  stay while speaker output is audible (client emits `output-level`; chat
  view bumps the bubble's expiry, fades 3 s after the last word). Assets are
  cache-busted with `?v=audio-24k-v24` (one shared string: index.html, main.js imports, AUDIO_WORKLET_VERSION in the client; two tests pin it) in index.html/main.js; bump it when
  editing demo JS/CSS or browsers keep the old files.
- 2026-09-14 (tools): the LLM handler now parses the model's native
  `<tool_call><function=…><parameter=…>` XML blocks as well as the prompted
  `<code>func()</code>` form (`LLM/tool_call/function_call.py:parse_xml_tool_calls`,
  `LLM/language_model.py:_find_tool_block_start`). Qwen3.8 follows the prompt
  for the first call and drifts to its native format afterwards; before this
  the drifted calls were spoken aloud. Verified live: 3 consecutive searches
  parsed. demo/server.py now logs each search's query and top results.
- 2026-09-14 (demo UI 2): assistant "thinking" bubble with pulsing dots from
  the moment the user's turn ends (client status `processing`, outside
  warm-up) until the transcript fills it in; dropped on barge-in, cancel or a
  tool-only response (kept across a tool follow-up); 30 s fail-safe.
- 2026-09-14 (personas): named voices. `voices/<name>.json` next to each clip
  ({ref_audio, ref_text, direction?, cfg_scale?}) is loaded at startup from
  `--breeze_tts_voice_dir` (defaults to the folder of `--breeze_tts_voice_path`);
  a session selects one by sending its name as the Realtime `voice`;
  `--breeze_tts_voice NAME` makes one the startup default. Current voices:
  `assistant` (designed here) and `villain` (Michael's 41 s "mad scientist"
  clip designed on the MacBook, seed 9; the clip is the voice, never re-roll)
  `robot` (Unit Seven, designed here, seed 2 of 5 takes; Michael picked it) and
  `captain` (gruff old sea captain, designed here, seed 12) and `witch`
  (gleeful old witch, designed here, seed 23 of 5 takes; Michael's pick).
  The demo Settings has a Persona picker that sets the voice name and the
  character prompt (`PERSONAS` in demo/main.js). Planned: witch, once its clip is picked (recipe: design 5 seeds of a 60-word script in the lab,
  STT-check completeness, send takes, install the pick as voices/<name>.{wav,json}).
- 2026-09-14 (browser bugs): (1) a captain reply arrived wrapped in
  `<think>…</think>` despite enable_thinking=False; the LLM handler now strips
  think spans while streaming (`_strip_think`, token-boundary safe). (2) the
  witch held a vowel for the rest of a sentence; the silence guard cannot see
  a loud stuck frame, so `_stream` now has a held-sound guard (frozen
  spectrum for 0.8 s -> cut, `--breeze_tts_max_held_sound`).
- 2026-09-14 (root cause of every "server vs lab" gap): mlx-lm's compiled
  sampler (`mx.compile` capturing `mx.random.state`) returns the same token
  on every call on any non-main thread and ignores `mx.random.seed`. The
  pipeline runs TTS on a worker thread, so identical text always produced
  identical audio and a stuck sentence stuck on every run (the witch's
  "whooo"). Fixed in the mlx-audio fork (keyed plain-op sampler, commit
  9af51fb, pulled in via uv.lock). Verified: the forced witch greeting now
  varies run to run and completes 5/5. Two related facts: a key must be
  created on the thread that uses it, and the first array evaluation in a
  process must happen on the main thread. The LLM path is unaffected only
  because upstream generates greedily (no sampler passed to stream_generate).
- Guards kept as belt-and-braces: trailing silence 1.2 s, held sound 0.8 s
  (spectrum anchored to the run start, one dip tolerated, threshold 0.95),
  per-sentence frame budget, repetition penalty 1.2.
- 2026-09-14 (persona switching): personas have names (Bob, Esmerelda,
  Captain Barnaby, Professor Karloff, Unit Seven). Two paths switch them:
  (1) a client-side `switch_persona` tool the model calls (prompt insists the
  call is the only thing that switches and to do it in the same reply, which
  Qwen3.8 follows: goodbye in the old voice, then the new persona greets);
  (2) a deterministic fallback in demo/main.js that matches "speak to /
  switch to / get me X" or a leading address "Esmerelda, ..." in the user's
  final transcript and applies the persona for the next response. Both go
  through `applyPersona()`, which updates settings, the Settings form and the
  live session. The assistant persona's voice is now the named `assistant`
  clip so switching back works within a session.
- 2026-09-14 (persona fixes from browser testing): the phrase-based
  hand-off is now applied on `response-finished`, not at transcript time (the
  in-flight reply's voice is read at synthesis, so switching early put the
  farewell in the new voice). Bubbles/history are labeled with the speaking
  persona's name (`chat.setAssistantName`). Persona prompts now say that
  staying in character never means refusing tools (web_search for current
  facts); the captain had been answering weather questions from his head.
- 2026-09-14 (settings form): Character block with a Preset / Custom source
  switch. Preset enables the persona dropdown and greys the Voice +
  Instructions fields (they mirror the preset for reference); Custom greys
  the dropdown and enables them. Mode persists (`s2s.ws.personaMode`);
  hand-offs and the switch_persona tool put the form back in Preset.
- 2026-09-14 (wake words): server-side gate in `LLM/wake_gate.py`, called
  from `LanguageModelHandler.process` before generation. Config rides on the
  Realtime session as an extra field `s2s_wake` {enabled, words, others,
  window_s, sleep_phrases} (pydantic keeps extras; the deep-merge preserves
  them). Rules: answer if the turn names the current persona (whole words,
  1-2 letters of transcription slack for long names) or arrives within
  window_s (45) after the last reply; a sleep phrase ends the window; a
  turn naming another persona is not answered by the server, the page
  switches persona and requests the reply (`requestResponse`). Toggle
  under the orb (`#wake-btn`, persisted `s2s.wake`); the page sends the
  config on connect, on toggle, on persona change and on Save. Wake words
  are the persona aliases: Bob/assistant, Esmerelda/Esmeralda/Esmer/witch,
  Barnaby/captain, Karloff/professor/mad scientist/villain, Unit Seven/robot.
- 2026-09-14 (wake-word fixes from browser testing): short wake words match
  exactly (slack only from 7 letters; "witch" had matched "with"); in wake
  mode the reply for a newly addressed persona is requested after the
  declined response ends (requesting during it raised "another response is
  in progress"); `updateSession` now also sends instructions + voice as an
  explicit session.update after the SDK's agent update, because a live
  persona switch changed the voice but the server kept the old prompt.
- 2026-09-14 (build stamp): footer shows `build vN · <commit> · updated
  <time>` from `/api/config.build` (asset version parsed from index.html,
  git short SHA, newest demo file mtime). The page compares the served asset
  version with its own (`import.meta.url`) on load and every 60 s; a
  mismatch turns the stamp into a "newer build served, click to reload"
  link. This exists because a tab running stale JS reproduced an already
  fixed bug.
- 2026-09-14 (voice stamping): each response is stamped with the session
  voice at generation start (`LLMResponseChunk.voice` -> `TTSInput.voice`,
  preferred by the Breeze handler over the live session config). A
  session.update arriving mid-response, which is exactly what a persona
  hand-off does, changes the next response's voice, never the farewell
  already being spoken. Verified by sending the switch the instant the tool
  call appeared. The client now applies a phrase-based switch immediately
  in both modes (the deferral is no longer needed).
- 2026-09-14 (speaker labels): the stamped voice now also rides on the
  Realtime transcript events as an s2s extra field `voice`
  (`AssistantOutputEvent.voice` -> `response.output_audio_transcript.delta/done`).
  The page maps it to a persona name and labels each bubble/history row by
  who actually spoke it, not by the current persona; a thinking bubble keeps
  its provisional name until the text lands.
- 2026-09-14 (stray </think>): Qwen3.8 sometimes treats the template's
  pre-filled empty think block as open, "thinks" in plain text (already
  streamed and spoken), emits `</think>`, then restates the answer. The
  handler now drops a stray closing tag and suppresses the restatement
  while it matches what was already emitted (`_suppress_restatement`).
- Open threads: the LLM stage is the latency floor. `LLM/language_model.py`
  has no mlx-lm prompt cache across turns and logs no TTFT, so each turn
  re-processes the system prompt + history. Next: add a KV prompt cache
  (mlx_lm make_prompt_cache) and TTFT logging, then consider a smaller or
  4-bit LLM if still slow. Breeze `streaming_interval` 0.2 would trim ~0.15 s
  of TTFA at some per-chunk overhead; untested. Voice design for some
  descriptions ("slow, weathered") is unreliable; a real reference clip is
  the robust path once Michael's clips are on this machine.
