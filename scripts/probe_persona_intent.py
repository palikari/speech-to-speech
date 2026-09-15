"""Manual check: does the model infer which persona a nickname refers to?

Runs against a live server (default ws://127.0.0.1:8765/v1/realtime) with the
demo's real persona prompts and switch_persona tool definition, starting each
case from a given persona, and reports which persona the model switched to.

    .venv/bin/python scripts/probe_persona_intent.py
"""

from __future__ import annotations

import asyncio
import json
import re
import sys
from pathlib import Path

import websockets

URL = sys.argv[1] if len(sys.argv) > 1 else "ws://127.0.0.1:8765/v1/realtime"
MAIN_JS = Path(__file__).resolve().parents[1] / "demo" / "main.js"
SRC = MAIN_JS.read_text()

CASES = [  # (start persona, what the user says, expected persona)
    ("robot", "Put me through to that utter madman.", "villain"),
    ("robot", "I'd like a word with Hecate's acolyte.", "witch"),
    ("witch", "Fetch the old sea dog for me.", "captain"),
    ("captain", "Get me the tin can.", "robot"),
    ("villain", "Let me talk to the regular assistant, please.", "assistant"),
    ("assistant", "Is the lady with the cauldron around?", "witch"),
    ("captain", "Put me through to Sam, would you?", "samantha"),
    ("samantha", "Hey Sam, what's the weather like today?", None),  # her own name: no switch
    ("witch", "What's the weather like today?", None),  # no switch expected
]


def _js(block: str) -> str:
    return "".join(re.findall(r'"((?:[^"\\]|\\.)*)"', block)).replace('\\"', '"')


def _const(name: str) -> str:
    i = SRC.index(f"const {name} =")
    return _js(SRC[i : SRC.index(";\n", i)])


def persona_prompt(pid: str) -> str:
    blk = SRC[SRC.index(f"  {pid}: {{") :]
    blk = blk[: blk.index("\n  },")]
    body = blk[blk.index("instructions:") :]
    text = _js(body)
    if "VOCAL_CUES" in body:
        text += _const("VOCAL_CUES")
    if "PERSONA_HANDOFF" in body:
        text += _const("PERSONA_HANDOFF")
    return text


def tool_description() -> str:
    i = SRC.index('  switch_persona: {\n    type: "function"')
    blk = SRC[i : SRC.index("\n  },", i)]
    return _js(blk[blk.index("description:") : blk.index("parameters:")])


TOOL = {
    "type": "function",
    "name": "switch_persona",
    "description": tool_description(),
    "parameters": {
        "type": "object",
        "properties": {"persona": {"type": "string", "enum": ["assistant", "samantha", "witch", "captain", "villain", "robot"]}},
        "required": ["persona"],
    },
}


async def run_case(start: str, text: str) -> tuple[str | None, str]:
    for _ in range(10):
        try:
            ws = await websockets.connect(URL, max_size=None)
            break
        except Exception:
            await asyncio.sleep(1.5)
    else:
        raise RuntimeError("no session slot available (is the browser still connected?)")
    try:
        await ws.send(
            json.dumps(
                {
                    "type": "session.update",
                    "session": {
                        "type": "realtime",
                        "instructions": persona_prompt(start),
                        "tools": [TOOL],
                        "tool_choice": "auto",
                        "audio": {"input": {"turn_detection": {"type": "server_vad"}}, "output": {"voice": start}},
                    },
                }
            )
        )
        await ws.send(
            json.dumps(
                {
                    "type": "conversation.item.create",
                    "item": {"type": "message", "role": "user", "content": [{"type": "input_text", "text": text}]},
                }
            )
        )
        await ws.send(json.dumps({"type": "response.create"}))
        switched, spoken = None, []
        async for raw in ws:
            ev = json.loads(raw)
            t = ev.get("type", "")
            if t == "response.output_item.done" and ev.get("item", {}).get("type") == "function_call":
                if ev["item"]["name"] == "switch_persona":
                    switched = json.loads(ev["item"].get("arguments") or "{}").get("persona")
            elif t == "response.output_audio_transcript.delta":
                spoken.append(ev.get("delta", ""))
            elif t in ("response.done", "error"):
                break
        return switched, "".join(spoken).strip()
    finally:
        await ws.close()
        await asyncio.sleep(3)  # let the server release the slot


async def main() -> int:
    failures = 0
    for start, text, expected in CASES:
        switched, spoken = await run_case(start, text)
        ok = switched == expected
        failures += not ok
        print(
            f"{'OK  ' if ok else 'FAIL'} from {start:9s} {text!r:52s} -> {switched!s:9s} (expected {expected!s:9s}) | {spoken[:60]}"
        )
    print(f"{len(CASES) - failures}/{len(CASES)} as expected")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
