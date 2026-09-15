# Bringing the fork up on a second Mac

A checklist for a machine that has the repo but has not run this branch's
latest state (the MacBook Pro after the Studio session of 2026-09-15; the Mac
mini later). Hand this file to Claude Code on that machine and work through it
top to bottom. Everything here is safe to re-run.

Paths are the same on every Mac: `~/Documents/apps/s2s/speech-to-speech`
(the folder may display as `Documents/Apps`).

## 1. Code

```bash
cd ~/Documents/apps/s2s/speech-to-speech
git fetch origin && git checkout breeze-tts && git pull --ff-only
git log --oneline -1        # expect ce5c0c6 or newer
```

If `uv` is missing: `curl -LsSf https://astral.sh/uv/install.sh | sh`, then
open a new shell.

```bash
uv sync --python 3.12 --extra mlx-lm --group demo --group dev
npm ci --prefix demo
.venv/bin/python -m pytest -q      # expect ~1724 passed, a few skipped; ~2 min
```

The tests need `node` on the PATH (three of them run `node --test`); they skip
if it is missing, which is fine but worth knowing.

## 2. Keys and accounts (never in the repo, never in chat)

Add to `~/.zshrc` on this machine, with the values from the password manager
or from the Studio's `~/.zshrc`:

```bash
export OLLAMA_API_KEY="..."          # ollama.com account key: web search + page fetch
export GOOGLE_PLACES_API_KEY="..."   # Places API (New) key: restaurants
```

Then `source ~/.zshrc` and check `echo ${OLLAMA_API_KEY:+set}` prints `set`
(never echo the key itself).

Ollama app: installed, running, signed in (`ollama signin`), and the cloud tag
registered once:

```bash
ollama pull glm-5.3-flash:cloud
ollama list | grep glm             # the tag should be listed
```

## 3. Licensed sound clips (not in git)

Copy the two folders from the Studio by AirDrop or a Finder share (Remote
Login is off on the Studio, so no rsync/scp):

- `demo/sfx/witch/`  (8.7 MB: bed.mp3, spell-cast, cauldron-bubbles, cat-purring)
- `demo/sfx/villain/` (10 MB: bed.mp3, electricity-sparks, potion-bubbling,
  ray-gun, monster-groan, electric-hum)

Drop them at the same paths here. `demo/sfx/README.md` lists what belongs
where; `demo/sfx/*` is gitignored so nothing can leak into a commit. The
masters live only on the Studio in `~/Documents/Sound Effects`.

## 4. First start (downloads models; give it a few minutes)

Terminal 1, the pipeline (Parakeet `nvidia/parakeet-tdt-0.6b-v3` and
`mlx-community/Breeze-TTS-2-mlx` download to the Hugging Face cache on first
run; the voices in `voices/` are committed and need nothing):

```bash
cd ~/Documents/apps/s2s/speech-to-speech
.venv/bin/speech-to-speech serve --stt parakeet-tdt --llm_backend chat-completions \
  --responses_api_base_url http://127.0.0.1:11434/v1 --responses_api_api_key ollama \
  --model_name glm-5.3-flash:cloud --responses_api_reasoning_effort minimal \
  --tts breeze --breeze_tts_voice_path voices/assistant.wav --enable_live_transcription
```

Terminal 2, the demo (from a shell that has sourced `~/.zshrc`, so the keys
are in its environment):

```bash
cd ~/Documents/apps/s2s/speech-to-speech
SPEECH_TO_SPEECH_URL=ws://localhost:8765/v1/realtime \
  .venv/bin/uvicorn --app-dir demo server:app --port 7860
```

Open http://localhost:7860/ in Chrome.

## 5. Browser checks (five minutes)

- Footer stamp reads `build v65` (or newer) and the short SHA of HEAD.
- Settings > Tools: web search says it runs on Ollama, Restaurants is
  enabled, the ambience block lists Esmerelda and Karloff. Settings > About
  you: fill in name etc. (stored per browser, so it is empty here).
- Tap the orb: Sam greets. Ask the date and the days until Christmas
  (date_math). Ask for the news (web search). Ask for Thai places nearby
  (restaurants card with health scores; allow location when asked).
- "Esmerelda, are you there?" Hand-off with goodbye; the bottom-right meter
  reads "Esmerelda's ambience" with moving bars. Ask her to stir the
  cauldron: one sound, not announced. "Karloff, ..." likewise, lab hum.
- "Show me the previous card." The restaurants card comes back, pinned.
- Toggle standby under the orb; a sentence without a name is dimmed "Not
  addressed"; "Sam, ..." answers.
- Camera: allow it when asked; "what am I holding?".

## 6. Differences to expect on this machine

- Browser-side settings (persona, ambience volume 15% default, profile,
  standby toggle, Serper key if any) are per browser and start fresh.
- Places quotas and the key's restrictions are per key, shared with the
  Studio; the daily cap is 300 requests.
- `tel:` links open whatever handles phone links in this browser (Google
  Voice on the Studio's Chrome).
- The first Breeze synthesis after start is slower (warm-up); the page shows
  "Getting ready" until the first word.

When everything above passes, note it in CLAUDE.md under Current state with
the date and this machine's name, and push.
