# What leaves this machine

This fork can run as a fully local voice assistant, or with a cloud language
model for faster replies. The choice is made when the server is started, and
it decides what data leaves the machine.

## Cloud configuration (the default on the Mac Studio)

Language model: a cloud model through Ollama (`--llm_backend chat-completions`
against the local Ollama server, which forwards `:cloud` models to ollama.com).
Web search and page fetches: Ollama's search service.

Sent to the language-model provider, with every turn:

- the persona prompt, including the "About you" profile fields you filled in
  (name, pronouns, birthday, city and state, notes), never the street address;
- your transcribed speech and the conversation so far;
- tool results: web search passages, fetched page text, restaurant search
  results and Georgia health-inspection data;
- a camera frame, when a persona takes a snapshot to answer a visual question.

Sent to the search provider: web search queries and fetched URLs.

Not sent anywhere: the street address (used locally to centre "nearby"
searches when your location is not shared, geocoded through Google Places),
and, in standby, anything said without the wake word, which is dropped before
it reaches the model.

Ollama's privacy policy (March 2026) states that cloud requests are processed
transiently and not stored beyond fulfilling them, that inputs and outputs are
not used to train models, and that only usage metadata is collected. It names
infrastructure and inference providers as subprocessors without detailing what
they see. Read it yourself at https://ollama.com/privacy before relying on it
for anyone else's data.

Google Places (restaurant search, phone numbers, hours) sees the search text
and, when shared, your coordinates or home address. The Georgia health
portal sees restaurant names.

## Fully local configuration

Everything stays on this machine: speech recognition (Parakeet), the language
model (Qwen3.8-27B under mlx-lm) and the voice (Breeze TTS) all run locally.
Replies are slower (2-3 s to the first sentence instead of under 1 s).

```bash
.venv/bin/speech-to-speech serve --stt parakeet-tdt --llm_backend mlx-lm \
  --model_name mlx-community/Qwen3.8-27B-8bit \
  --tts breeze --breeze_tts_voice_path voices/assistant.wav --enable_live_transcription
```

Then, in the browser's Settings > Tools, switch off Web search and Restaurants
(or leave them on: those tools still call Google Places and the search
provider, but the conversation itself never leaves the machine). Do not set
`OLLAMA_API_KEY` or `GOOGLE_PLACES_API_KEY` in the environment if you want
those services unavailable altogether.

## Where your profile lives

In this browser only (`localStorage`), until an account system exists. Clearing
site data removes it. Nothing about you is stored on the server between
sessions.
