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

Cloud LLM through Ollama (same STT/TTS; only the LLM stage changes). Needs the
Ollama app running and signed in (`ollama signin`; Michael has Ollama Pro on
the Studio). The key is a dummy for the local server, which forwards `:cloud`
models to ollama.com under the signed-in account:

```bash
.venv/bin/speech-to-speech serve --stt parakeet-tdt --llm_backend chat-completions \
  --responses_api_base_url http://127.0.0.1:11434/v1 --responses_api_api_key ollama \
  --model_name glm-5.3-flash:cloud --responses_api_reasoning_effort minimal \
  --tts breeze --breeze_tts_voice_path voices/assistant.wav --enable_live_transcription
```

`--responses_api_reasoning_effort` matters per model (see Current state,
2026-09-14 Ollama). To talk to ollama.com directly instead of the local
server, use `--responses_api_base_url https://ollama.com/v1` and pass a real
key from an environment variable (`--responses_api_api_key "$OLLAMA_API_KEY"`),
never on the command line or in chat.

Web search for the model: with `OLLAMA_API_KEY` in the environment (Michael
keeps it in `~/.zshrc`; never in the repo or in chat) the demo server's
`/api/search` uses Ollama's web search (page passages, usage from the Ollama
Pro allowance) and offers `/api/fetch` for whole pages; without it, Serper via
`SERPER_API_KEY` or the user's own Serper key from Settings.

Restaurant search (`find_restaurants` tool): with `GOOGLE_PLACES_API_KEY` in
the environment (Michael's Google Cloud project; key restricted to Places API
(New), per-day quotas, budget alerts) the demo server's `/api/restaurants`
combines Google Places (Pro-tier fields only: rating, price, address, location)
with Georgia DPH health scores from ga.healthinspections.us (`demo/ga_health.py`,
an async port of `~/Documents/Apps/gahealth/ga_health_scores.py`).

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
  cache-busted with `?v=audio-24k-v36` (one shared string: index.html, main.js imports, AUDIO_WORKLET_VERSION in the client; two tests pin it) in index.html/main.js; bump it when
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
  (gleeful old witch, designed here, seed 23 of 5 takes; Michael's pick) and
  `samantha` (Sam, a warm capable everyday assistant, designed here 2026-09-15,
  seed 27 of 5 takes; Michael's pick; takes made with the handler's own design
  settings and STT-checked for full script coverage).
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
- 2026-09-14 (nicknames): the model infers personas from nicknames on its
  own ("that utter madman" -> Karloff, "Hecate's acolyte" -> Esmerelda, "the
  old sea dog" -> Barnaby; "the tin can" was not understood). Repeatable check
  against a live server: `scripts/probe_persona_intent.py` (needs the
  session slot free). The page's own phrase detector is unit-tested in
  `demo/tests/persona-phrases.test.mjs` (wrapped by pytest); it only knows
  names, roles and two nicknames (madman, sorceress); everything else is the
  model's job.
- 2026-09-14 (Ollama cloud LLM): the `chat-completions` backend now works
  for the demo: `base_openai_compatible_language_model.py` gained the same
  wake gate and per-response voice stamp as the mlx-lm handler (shared
  helpers `LLM/wake_gate.py` `gate_turn`/`extend_awake_window` and
  `LLM/utils.py` `voice_snapshot`). Probed through Ollama 0.34 local server
  (`http://127.0.0.1:11434/v1`): `glm-5.3-flash:cloud` gives ~0.5-0.9 s to
  first content versus 2-3 s for the local 27B, nickname inference 7/7
  (local 27B: 6/7), web_search and switch_persona calls correct, no think
  leaks. Reasoning flag per model on Ollama's OpenAI endpoint:
  `reasoning_effort=none` makes GLM think *inline in content* with only a
  bare `</think>` close (the pipeline speaks it), so GLM needs `minimal`
  (or `low`); `qwen3.5:397b-cloud` needs `none` (10-15 s of thinking
  otherwise); `gpt-oss:120b-cloud` always reasons a little but puts it in
  the `reasoning` field and is fastest (~0.3 s). `chat_template_kwargs` and
  `think:false` are ignored by Ollama. Retired/absent there: deepseek-v3.2,
  minimax-m2.5, kimi-k2.7, gemini. LM Studio's Secure Cloud subscription is
  app-only (its local server, port 1234, exposes only downloaded models), so
  it is not a serving option. The OpenAI-compatible handler still has no
  `<think>` filter; if a provider leaks think text into content, fix the
  reasoning flag rather than the handler.
- 2026-09-14 (barge-in starved STT): with the fast cloud LLM a whole long
  reply reaches Breeze at once and is coalesced into one synthesis job.
  `_stream` read the *live* cancel generation at the start of each sentence,
  so after an interruption only the sentence in flight stopped; the rest of
  the job (up to 49 s of audio, discarded downstream) kept the MLX lock for
  30 s, Parakeet's final transcription lost its 5 s wait, and the user's
  words during that time never became a turn. That is also why a persona
  "persisted" with a cancelled recipe: the request was still open in the
  history and no "stop" ever arrived. Fix: `_generate` takes the generation
  stamped on the TTSInput, judges every sentence against it and drops the
  remaining sentences when it goes stale. Probe (cancel mid-reply, then ask
  a one-word question): follow-up first audio 30 s -> ~1 s. The local 27B
  never showed this because it produced sentences slower than Breeze spoke
  them. Note the OpenAI client also logged one 20 s "Retrying request" to
  Ollama in that session; cloud hiccups exist and are not this bug.
- 2026-09-14 (interrupted replies stay in history): a cancelled reply used
  to be removed from the conversation entirely (upstream design, so an
  unseen tool call cannot poison the next turn). The model then saw
  "recipe?" followed by "Stop." with no trace it had started answering, and
  answered the still-open request again, a new recipe every time. Now
  `ResponseHandler._record_interrupted_reply` keeps the transcript delivered
  so far as the assistant's turn with the marker `[interrupted by the user]`
  (mirrors OpenAI Realtime, where the truncated item stays); tool calls of a
  cancelled reply are still discarded, failed/incomplete replies are still
  rolled back whole. Probe (Karloff recipe, cancel, "Stop."): 3/3
  acknowledged and dropped the recipe, versus 0/3 before.
- 2026-09-14 (hand-offs lost their goodbye on the cloud LLM): two causes
  in the browser logs. (1) The page's phrase detector switched the session
  before the model's reply had started (0.7 s ahead with the fast LLM), so
  the model answered as the new persona with nobody left to say goodbye; the
  earlier "switch right away, stamping protects the farewell" reasoning only
  holds for a reply already in flight. Outside wake mode the page now sets
  `pendingPersona` and lets the current persona answer (it calls
  switch_persona itself, with a goodbye, ~15/16 directly); if the model did
  not switch, the switch is applied when the reply ends and the new persona
  is asked to reply. Wake mode keeps the immediate switch (the server
  declines the turn anyway). (2) GLM occasionally makes the switch_persona
  call with no spoken text (3/3 in the browser, 1/16 directly). The page now
  holds such a switch: the tool result asks for a one-line goodbye now and
  says the switch happens when that reply ends (`heldPersona`; model obeys
  8/8, no second call); after the goodbye the page applies the persona and
  requests the greeting. `switchAndReply` waits for `client.updateSession`'s
  promise (now returned) before `requestResponse`, so the greeting cannot
  race the session update. Promised hand-offs now also get a greeting.
  Pipeline flow verified with a scripted browser role (villain goodbye in
  the villain voice, captain greeting in the captain voice); the page state
  machine itself is not unit-tested and was checked by reading, so watch
  the console (`[persona] hold`, `[persona] pending`) on the first tries.
- 2026-09-14 (hand-off follow-up, Michael's browser test): every hand-off
  took the hold path (GLM called switch_persona silently 5/5 in the
  browser). Two leftovers: the goodbye reply sometimes went on to greet as
  the *next* persona in the old voice (Bob: "The witch returns, my dear"),
  and the new persona's first reply was sometimes a second farewell in the
  new voice, because the history it saw ended with a hand-off and a goodbye
  and nothing said the switch had happened. Fixes in demo/main.js: the hold
  result now says "only the goodbye, do not speak as or for X" (8/8 clean);
  `switchAndReply` sends a user-role hand-off note item after the goodbye
  (`client.sendUserNote`, not rendered; the page's initial greeting uses
  the same mechanism) and requests the greeting with per-response
  `instructions` (`client.requestResponse({instructions})`, persona prompt
  plus a note). Measured directly with the exact post-goodbye history: the
  instructions note alone 1-3/8 farewell-style greetings, plus the note item
  0/8; pipeline 4/4. A system-role conversation item cannot carry the note:
  `Chat._add_item_locked` treats it as a replacement session prompt and the
  LLM handler re-applies the session instructions at each generation.
- 2026-09-14 (hand-off pause): the greeting was requested on the goodbye's
  response-finished, which the server reaches while the browser is still
  playing the goodbye, so the two ran together. `switchAndReply` now waits
  (`waitForQuietOutput`) until the speaker level has been quiet for
  `HANDOFF_PAUSE_MS` (700 ms, capped at 8 s) before sending the note and
  requesting the greeting; a user turn during the wait abandons the
  greeting (their turn gets the new persona's reply anyway). Page-only,
  checked by reading; Michael's browser is the test.
- 2026-09-15 (Ollama web search): the Serper tool gave the model one
  150-char snippet per result, so answers came from teasers. `/api/search`
  now prefers Ollama's `web_search` when `OLLAMA_API_KEY` is set (5 results,
  each a 700-char passage of the page, `PASSAGE_CHARS`), and a new
  `/api/fetch` (`web_fetch` tool, page text capped at `FETCH_CHARS` 8000,
  http(s) only) lets the model read a page when the passages are not
  enough. `/api/config` reports `searchProvider` and `fetch`; the page adds
  the `web_fetch` tool only when the server can fetch. Ollama's endpoints
  live on ollama.com (the local server does not proxy them; 404) and need
  the account key. Measured: search 0.6-0.7 s, ~1000-1300 prompt tokens;
  fetch 0.8 s, ~2000 tokens; GLM answers correctly where snippets failed
  (chili simmer time came from the fetched recipe page). Tests in
  `tests/test_demo_server.py` fake the ollama.com client and assert the key
  is sent only as the Authorization header and never logged.
- 2026-09-15 (clock + date tools): Esmerelda said "sixteen days until
  Halloween" (46 was right), then defended it: the model has no clock (the
  only date it had seen was a search-result header), counts days badly at
  minimal reasoning effort, and anchors on its own earlier answer, so a
  "verify" search confirmed the date but never redid the sum. Now:
  `LLM/clock.py` `with_clock` appends "Current date and time: ..." to the
  session instructions at every generation in both LLM handlers, in the
  zone the page sends as session extra `s2s_clock` `{tz}` (with the wake
  config), else the server's local zone; empty instructions stay empty so
  the "nothing to send" guard holds. The page adds two deterministic,
  keyless, always-on tools from `demo/tools/local-tools.js`: `date_math`
  (days_between / add_days / weekday, DST-safe, YYYY-MM-DD) and `calculate`
  (allowlisted arithmetic), and the persona prompt says to use them and to
  trust the tool over an earlier answer. Tests: `tests/test_clock.py`, a
  chat-completions test for the system prompt, `demo/tests/local-tools.test.mjs`
  (pytest-wrapped). Live: correct date/time, Christmas = 101 days via the
  tool, held firm against a wrong "sixty", weekday and arithmetic right.
- 2026-09-15 (restaurants): `demo/restaurants.py` + `/api/restaurants`
  + page tool `find_restaurants` (Settings > Tools > Restaurants; result
  cards in the history with a health-score badge and a maps link). Flow:
  Places text search biased to the browser's geolocation (asked on first
  use, cached 5 min, never stored; without it the query's own area is used),
  cuisine words map to Places types with strict filtering (so "Thai, open
  now" at breakfast returns nothing rather than any open cafe), results
  beyond twice the radius dropped, then a health lookup per place (3 in
  parallel): the portal's keyword search is a name-prefix match and its
  city filter uses mailing cities, so lookups use the first two significant
  name words without a city and match on street number + street word;
  hits cached 24 h, misses 1 h. Sorts: rating (Bayesian, 20 phantom
  reviews at 4.0, so a 5.0 from one review does not top the list), health
  (unscored last), distance, price; filters open_now / min_rating /
  min_health_score. Live from Johns Creek: 6/6 Thai places matched to
  scores, 1.3 s cold, 0.6 s cached; Bob reads out rating + score. GLM tends
  to invent filters and call twice; the tool description now says one call
  and no filters unless asked (1 call on the plain question after that).
  Tests: `tests/test_demo_restaurants.py` (fakes for Places and the portal).
- 2026-09-15 (Samantha): sixth persona, `samantha` (name Samantha, aliases
  samantha/sam, wake words the same; "sam" is short so the wake gate matches
  it exactly). Added to PERSONAS, the switch_persona enum and description,
  the hand-off roster sentence, the Settings dropdown, the phrase test and
  the intent probe. Take recipe used: scratch script loading the Breeze
  model with the handler's own kwargs, 5 seeds, Parakeet (mlx-audio
  `generate`) coverage check, takes in the breeze-tts lab's outputs folder.
- 2026-09-15 (cards in the live chat): a tool result with structured rows
  (find_restaurants) now also appears as a `bubble cards` in the bubble
  stack on the assistant's side, with the same card renderer as the history
  panel and a dismiss button. It lingers 45 s, extended to 25 s after the
  last spoken word while the reply plays (`onAssistantAudible`), one at a
  time, and is evicted like any bubble when three newer ones arrive.
- 2026-09-15 (inspection history): `restaurant_inspections` tool +
  `/api/restaurant_inspections` (no key needed; Georgia portal only). Ported
  the portal's `inspectionsData/<id>` endpoint (`ga_health.get_inspections`,
  `parse_inspection`, `parse_violation`). Resolution: rows cached by
  find_restaurants first, else a portal name-prefix search; every word of
  the asked name must appear in the portal name (a made-up "Nowhere Grill"
  no longer matches "Nowhere Bar"); `area` matches street, city or zip in
  the portal address (the portal files Johns Creek places under Duluth or
  Suwanee mailing cities, so the model is told to pass the street from an
  earlier result). Text: last N scores with dates and purpose, a trend
  word, the latest violations by points with repeat flags, and a count of
  other same-name locations; the page shows a "Health inspections" card
  (score timeline + violations) in the history and as a live bubble.
  Inspections cached 24 h per establishment.
- Open threads: the LLM stage is the latency floor. `LLM/language_model.py`
  has no mlx-lm prompt cache across turns and logs no TTFT, so each turn
  re-processes the system prompt + history. Next: add a KV prompt cache
  (mlx_lm make_prompt_cache) and TTFT logging, then consider a smaller or
  4-bit LLM if still slow. Breeze `streaming_interval` 0.2 would trim ~0.15 s
  of TTFA at some per-chunk overhead; untested. Voice design for some
  descriptions ("slow, weathered") is unreliable; a real reference clip is
  the robust path once Michael's clips are on this machine.
