"""Drop a note the model wrote to itself at the start of a spoken reply.

At minimal reasoning effort a model sometimes deliberates in the content
itself before answering, e.g. "(play_sound not needed here, a request, so
speak) Hmm, a delicious potion you say ..." and the pipeline speaks the
whole thing. The filter is streaming-safe and costs nothing on ordinary
replies: it only buffers while the reply starts with an opening parenthesis,
and once the closing one arrives it drops the aside if it reads like a note
about tools (a snake_case identifier such as a tool name, or the word
"tool"). Anything else is released verbatim, so a persona that opens with a
parenthetical stays intact.
"""

from __future__ import annotations

import logging
import re

logger = logging.getLogger(__name__)

# Longest aside we will hold back before giving up and releasing the text.
ASIDE_MAX_CHARS = 240
_TOOLISH = re.compile(r"\b[A-Za-z]+_[A-Za-z_]+\b|\btools?\b", re.IGNORECASE)


class LeadingAsideFilter:
    """Feed streamed text through ``feed``; call ``flush`` when the stream ends."""

    def __init__(self) -> None:
        self._buf = ""
        self._decided = False

    @property
    def holding(self) -> bool:
        """Text is buffered while the opening parenthesis awaits its close."""
        return not self._decided and bool(self._buf)

    def feed(self, text: str) -> str:
        if self._decided:
            return text
        self._buf += text
        stripped = self._buf.lstrip()
        if not stripped:
            return ""
        if not stripped.startswith("("):
            return self._release()
        close = stripped.find(")")
        if close == -1:
            if len(stripped) > ASIDE_MAX_CHARS or "\n" in stripped:
                return self._release()
            return ""
        inner = stripped[1:close]
        self._decided = True
        self._buf = ""
        if _TOOLISH.search(inner):
            logger.info("Dropped a leading aside from the reply: %r", inner)
            return stripped[close + 1 :].lstrip()
        return stripped

    def flush(self) -> str:
        """Release whatever is still held (an aside that never closed)."""
        return self._release() if not self._decided else ""

    def _release(self) -> str:
        self._decided = True
        out, self._buf = self._buf, ""
        return out
