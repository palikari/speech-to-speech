# Persona ambience

Sound files live here, one folder per persona id (`witch/`, `captain/`, ...),
and are **not committed**: they come from licensed libraries (Envato Elements,
Epidemic Sound, Adobe Stock) whose terms allow use in a project but not
redistribution. Copy them between machines by hand.

Layout, discovered by the demo server (`/api/sfx`) at request time:

- `bed.mp3` or `bed.wav` : the background loop for that persona, played quietly
  under the conversation and ducked while the assistant speaks.
- any other `.wav` / `.mp3` : a one-shot the persona can cue with the
  `play_sound` tool; its name is the file stem with dashes as spaces
  (`spell-cast.wav` -> "spell cast").

Keep one-shots short (a few seconds) and beds loopable (no obvious events).
