"""Georgia DPH restaurant inspection scores (ga.healthinspections.us).

Async port of Michael's ``~/Documents/Apps/gahealth/ga_health_scores.py``: the
undocumented JSON API behind the statewide portal (Tyler Technologies DHD).
Search parameter values are base64-encoded and the JSON object is URL-encoded
into the path. Gwinnett, Newton and Rockdale counties publish elsewhere and are
not here. Unofficial: cache, go easy on it, expect it to change.

The portal's keyword search is a name-prefix match and its city filter uses
mailing cities, so callers match by street number instead (see restaurants.py).
"""

from __future__ import annotations

import asyncio
import base64
import json
import urllib.parse
from typing import Any

import httpx

BASE = "https://ga.healthinspections.us/stateofgeorgia/API/index.cfm"
UA = {"User-Agent": "speech-to-speech-demo/1.0 (personal use)"}
PAGE_DELAY_S = 0.3

_COLUMN_LABELS = {
    "Phone Number": "phone",
    "Permit Type": "permit_type",
    "Permit Number": "permit_number",
    "Last Inspection Score": "score",
    "Last Inspection Date": "inspection_date",  # MM-DD-YYYY
    "For More Information Call": "county_office_phone",
}


def _b64(value: Any) -> str:
    return base64.b64encode(str(value).encode()).decode()


def parse_row(row: dict) -> dict:
    out: dict[str, Any] = {
        "id": row.get("id", ""),
        "name": row.get("name", ""),
        "address": " ".join(str(row.get("mapAddress", "")).split()),
    }
    for value in (row.get("columns") or {}).values():
        label, _, rest = str(value).partition(":")
        field = _COLUMN_LABELS.get(label.strip())
        if field:
            out[field] = rest.strip()
    try:
        out["score"] = int(out["score"]) if "score" in out else None
    except ValueError:
        out["score"] = None
    return out


def search_path(keyword: str, city: str = "", county: str = "", page: int = 0) -> str:
    """The portal's search URL for a minimal keyword/city/county payload."""
    candidates = {"city": city, "county": county}
    payload = {k: _b64(v) for k, v in candidates.items() if v}
    payload["keyword"] = _b64(keyword)  # mandatory, even when empty
    return f"{BASE}/search/{urllib.parse.quote(json.dumps(payload, separators=(',', ':')))}/{page}"


async def search(
    client: httpx.AsyncClient, keyword: str, city: str = "", county: str = "", max_pages: int = 2
) -> list[dict]:
    """Establishments whose name starts with ``keyword``: name, address, latest score and date."""
    results: list[dict] = []
    for page in range(max_pages):
        resp = await client.get(search_path(keyword, city, county, page), headers=UA, timeout=15.0)
        if resp.status_code != 200:
            break
        try:
            rows = resp.json()
        except ValueError:
            break
        if not rows:
            break
        results.extend(parse_row(r) for r in rows)
        if len(rows) < 10:  # a short page is the last page
            break
        await asyncio.sleep(PAGE_DELAY_S)
    return results


# ── Inspection history ────────────────────────────────────────────────────────

_INSPECTION_LABELS = {
    "Date": "date",  # MM-DD-YYYY
    "Inspection Purpose": "purpose",  # Routine, Follow-up, ...
    "Score": "score",
    "Inspector": "inspector",
}


def parse_violation(lines: list) -> dict:
    """One violation entry (a list of strings) -> item, description, points, repeat, notes."""
    out: dict[str, Any] = {}
    unmatched: list[str] = []
    for raw in lines:
        line = str(raw).strip()
        if line.startswith("Points:"):
            try:
                out["points"] = int(line.partition(":")[2])
            except ValueError:
                out["points"] = None
        elif line.startswith("Corrected during inspection?:"):
            out["corrected"] = line.partition(":")[2].strip() == "Yes"
        elif line.startswith("Repeat:"):
            out["repeat"] = line.partition(":")[2].strip() == "Yes"
        elif line.startswith("Inspector Notes"):
            out["notes"] = line[len("Inspector Notes") :].strip()
        else:
            unmatched.append(line)
    if unmatched:
        code, _, desc = unmatched[0].partition(" - ")
        out["item"] = code.strip()
        out["description"] = desc.strip() or code.strip()
    if len(unmatched) > 1:
        cite, _, title = unmatched[1].partition(" - ")
        out["regulation"] = cite.strip()
        out["regulation_title"] = title.strip()
    return out


def parse_inspection(row: dict) -> dict:
    out: dict[str, Any] = {
        "inspection_id": row.get("inspectionId"),
        "violations": [parse_violation(v) for v in (row.get("violations") or {}).values()],
    }
    for value in (row.get("columns") or {}).values():
        label, _, rest = str(value).partition(":")
        field = _INSPECTION_LABELS.get(label.strip())
        if field:
            out[field] = rest.strip()
    try:
        out["score"] = int(out["score"]) if "score" in out else None
    except ValueError:
        out["score"] = None
    path = row.get("printablePath", "")
    out["report_url"] = urllib.parse.urljoin(f"{BASE.rsplit('/', 1)[0]}/", path) if path else ""
    return out


async def get_inspections(client: httpx.AsyncClient, est_id: str) -> list[dict]:
    """Inspection history for one establishment (``id`` from a search row), newest first as the portal lists them."""
    resp = await client.get(f"{BASE}/inspectionsData/{est_id}", headers=UA, timeout=15.0)
    if resp.status_code != 200:
        return []
    try:
        rows = resp.json()
    except ValueError:
        return []
    return [parse_inspection(r) for r in rows or []]
