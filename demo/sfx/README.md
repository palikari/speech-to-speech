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

Installed on Michael's machines (masters in `~/Documents/Sound Effects`;
levels matched with ffmpeg so every bed sits near -20 dB mean and every
one-shot near -25 dB):

- `witch/`: `bed.mp3` (Halloween night, 2 min), `spell-cast.wav`,
  `cauldron-bubbles.wav` (8 s), `cat-purring.wav` (6 s).
- `villain/` (Professor Karloff): `bed.mp3` (mad scientist's lab, 2 min,
  +30 dB from the master), `electricity-sparks.wav` (Jacob's ladder, first
  8 s), `potion-bubbling.wav` (8 s), `power-surge.wav` (9 s),
  `monster-groan.wav` (3.5 s), `crazy-scientist.wav` (4 s).
