"""Restaurant search for the model: Google Places (New) for candidates, ratings
and price, the Georgia DPH portal for official health scores, one terse line
per place for the spoken reply and structured rows for the page's cards.
"""

from __future__ import annotations

import asyncio
import logging
import math
import os
import re
import time
import urllib.parse
from typing import Any, Optional

import ga_health
import httpx
from pydantic import BaseModel, Field

logger = logging.getLogger("s2s.restaurants")

PLACES_KEY = os.environ.get("GOOGLE_PLACES_API_KEY", "").strip()
PLACES_SEARCH_URL = "https://places.googleapis.com/v1/places:searchText"
# Pro-tier fields only (rating, price, address, location); no opening hours or
# phone, which would bill the call at the Enterprise tier.
PLACES_FIELD_MASK = ",".join(
    f"places.{f}"
    for f in (
        "id",
        "displayName",
        "formattedAddress",
        "addressComponents",
        "location",
        "rating",
        "userRatingCount",
        "priceLevel",
        "googleMapsUri",
        "primaryTypeDisplayName",
        "businessStatus",
        "types",
    )
)
# Cuisine words the user may say -> Places (New) place types. When one is
# recognised the search is type-restricted, so "Thai, open now" at breakfast
# time returns no Thai places rather than whatever else is open.
CUISINE_TYPES = {
    "thai": "thai_restaurant",
    "pizza": "pizza_restaurant",
    "sushi": "sushi_restaurant",
    "mexican": "mexican_restaurant",
    "italian": "italian_restaurant",
    "chinese": "chinese_restaurant",
    "indian": "indian_restaurant",
    "korean": "korean_restaurant",
    "japanese": "japanese_restaurant",
    "vietnamese": "vietnamese_restaurant",
    "greek": "greek_restaurant",
    "french": "french_restaurant",
    "mediterranean": "mediterranean_restaurant",
    "middle eastern": "middle_eastern_restaurant",
    "lebanese": "lebanese_restaurant",
    "turkish": "turkish_restaurant",
    "spanish": "spanish_restaurant",
    "brazilian": "brazilian_restaurant",
    "american": "american_restaurant",
    "bbq": "barbecue_restaurant",
    "barbecue": "barbecue_restaurant",
    "barbeque": "barbecue_restaurant",
    "burger": "hamburger_restaurant",
    "burgers": "hamburger_restaurant",
    "seafood": "seafood_restaurant",
    "steak": "steak_house",
    "steakhouse": "steak_house",
    "breakfast": "breakfast_restaurant",
    "brunch": "brunch_restaurant",
    "coffee": "coffee_shop",
    "bakery": "bakery",
    "vegan": "vegan_restaurant",
    "vegetarian": "vegetarian_restaurant",
    "ramen": "ramen_restaurant",
    "fast food": "fast_food_restaurant",
    "ice cream": "ice_cream_shop",
    "sandwich": "sandwich_shop",
    "sandwiches": "sandwich_shop",
    "diner": "diner",
    "cafe": "cafe",
}
# Bayesian prior for the rating sort: a 5.0 from three reviews should not beat
# a 4.7 from seven hundred. Twenty phantom reviews at 4.0.
RATING_PRIOR_MEAN = 4.0
RATING_PRIOR_COUNT = 20
DEFAULT_RADIUS_M = 8000
MAX_RESULTS = 8
HEALTH_CACHE_TTL_S = 24 * 3600
HEALTH_MISS_TTL_S = 3600
HEALTH_CONCURRENCY = 3
SORTS = ("rating", "health", "distance", "price")
_PRICE = {
    "PRICE_LEVEL_FREE": 0,
    "PRICE_LEVEL_INEXPENSIVE": 1,
    "PRICE_LEVEL_MODERATE": 2,
    "PRICE_LEVEL_EXPENSIVE": 3,
    "PRICE_LEVEL_VERY_EXPENSIVE": 4,
}
_PRICE_WORDS = {0: "free", 1: "inexpensive", 2: "moderate", 3: "expensive", 4: "very expensive"}
# Words that never identify a restaurant in a name-prefix search, and generic
# words that are dropped only when something more specific remains.
_JOINERS = {"the", "a", "an", "and", "of", "at", "in", "on", "by"}
_GENERIC = {
    "restaurant",
    "restaurants",
    "cafe",
    "café",
    "grill",
    "bar",
    "kitchen",
    "bistro",
    "eatery",
    "diner",
    "house",
    "place",
    "company",
    "co",
    "inc",
    "llc",
    "johns",
    "creek",
    "alpharetta",
    "atlanta",
    "duluth",
    "suwanee",
    "roswell",
    "cumming",
    "marietta",
}


class RestaurantsRequest(BaseModel):
    query: str
    lat: Optional[float] = None
    lng: Optional[float] = None
    # A place to search around when the browser shared no coordinates (the
    # user's home address from their profile); geocoded once and cached.
    near: Optional[str] = None
    radius_m: int = Field(default=DEFAULT_RADIUS_M, ge=500, le=50000)
    open_now: bool = False
    sort_by: str = "rating"
    min_rating: Optional[float] = None
    min_health_score: Optional[int] = None
    max_results: int = Field(default=5, ge=1, le=MAX_RESULTS)


# ── Google Places ────────────────────────────────────────────────────────────


def place_links(place_id: str, name: str, address: str) -> dict:
    """Google review and directions links for a place (Maps URLs API; no key needed to open)."""
    if not place_id:
        return {"reviews_url": "", "directions_url": ""}
    dest = urllib.parse.quote(f"{name} {address}".strip())
    return {
        "reviews_url": f"https://search.google.com/local/reviews?placeid={place_id}",
        "directions_url": f"https://www.google.com/maps/dir/?api=1&destination={dest}&destination_place_id={place_id}",
    }


def parse_place(p: dict) -> dict:
    comps = {t: c.get("longText", "") for c in p.get("addressComponents") or [] for t in c.get("types") or []}
    loc = p.get("location") or {}
    price = _PRICE.get(str(p.get("priceLevel") or ""), None)
    return {
        "id": p.get("id", ""),
        "name": (p.get("displayName") or {}).get("text", ""),
        "address": p.get("formattedAddress", ""),
        "street_number": comps.get("street_number", ""),
        "route": comps.get("route", ""),
        "locality": comps.get("locality", ""),
        "postal_code": comps.get("postal_code", ""),
        "lat": loc.get("latitude"),
        "lng": loc.get("longitude"),
        "rating": p.get("rating"),
        "rating_count": p.get("userRatingCount"),
        "price_level": price,
        "maps_url": p.get("googleMapsUri", ""),
        "kind": (p.get("primaryTypeDisplayName") or {}).get("text", ""),
        "types": list(p.get("types") or []),
        "operational": p.get("businessStatus", "OPERATIONAL") == "OPERATIONAL",
        **place_links(p.get("id", ""), (p.get("displayName") or {}).get("text", ""), p.get("formattedAddress", "")),
    }


def cuisine_type(query: str) -> Optional[tuple[str, str]]:
    """(word, place type) for the first cuisine word found in the query, else None."""
    q = " " + re.sub(r"[^a-z ]+", " ", query.lower()) + " "
    for word, ptype in sorted(CUISINE_TYPES.items(), key=lambda kv: -len(kv[0])):
        if f" {word} " in q:
            return word, ptype
    return None


def weighted_rating(rating: Optional[float], count: Optional[int]) -> float:
    n = count or 0
    r = rating or 0.0
    return (r * n + RATING_PRIOR_MEAN * RATING_PRIOR_COUNT) / (n + RATING_PRIOR_COUNT)


async def places_search(client: httpx.AsyncClient, req: RestaurantsRequest) -> list[dict]:
    body: dict[str, Any] = {"textQuery": req.query, "maxResultCount": MAX_RESULTS}
    cuisine = cuisine_type(req.query)
    if cuisine:
        body["includedType"] = cuisine[1]
        body["strictTypeFiltering"] = True
    else:
        body["includedType"] = "restaurant"
    if req.open_now:
        body["openNow"] = True
    if req.lat is not None and req.lng is not None:
        body["locationBias"] = {
            "circle": {"center": {"latitude": req.lat, "longitude": req.lng}, "radius": req.radius_m}
        }
    headers = {"Content-Type": "application/json", "X-Goog-Api-Key": PLACES_KEY, "X-Goog-FieldMask": PLACES_FIELD_MASK}
    resp = await client.post(PLACES_SEARCH_URL, headers=headers, json=body, timeout=15.0)
    if resp.status_code != 200:
        detail = ""
        try:
            detail = (resp.json().get("error") or {}).get("message", "")[:200]
        except ValueError:
            pass
        raise RuntimeError(f"Places error {resp.status_code}: {detail}")
    return [parse_place(p) for p in resp.json().get("places") or []]


# ── Health scores ────────────────────────────────────────────────────────────


def name_keywords(name: str) -> list[str]:
    """Prefix keywords to try on the portal, most specific first: the first
    two significant words, then the first one."""
    tokens = [w for w in re.findall(r"[a-z0-9']+", name.lower()) if w not in _JOINERS]
    words = [w for w in tokens if w not in _GENERIC] or tokens
    out: list[str] = []
    if len(words) >= 2:
        out.append(" ".join(words[:2]))
    if words:
        out.append(words[0])
    return out


def match_row(place: dict, rows: list[dict]) -> Optional[dict]:
    """The portal row at the same street number and street, else None."""
    number = place.get("street_number") or ""
    if not number:
        return None
    street_word = (place.get("route") or "").lower().split()
    street_word = street_word[0] if street_word else ""
    for row in rows:
        addr = row.get("address", "").lower()
        if re.search(rf"\b{re.escape(number)}\b", addr) and (not street_word or street_word in addr):
            return row
    return None


class HealthCache:
    def __init__(self) -> None:
        self._rows: dict[str, tuple[float, Optional[dict]]] = {}

    def get(self, place_id: str) -> tuple[bool, Optional[dict]]:
        hit = self._rows.get(place_id)
        if hit is None:
            return False, None
        stamp, row = hit
        ttl = HEALTH_CACHE_TTL_S if row is not None else HEALTH_MISS_TTL_S
        if time.monotonic() - stamp > ttl:
            self._rows.pop(place_id, None)
            return False, None
        return True, row

    def put(self, place_id: str, row: Optional[dict]) -> None:
        self._rows[place_id] = (time.monotonic(), row)


health_cache = HealthCache()


async def health_for(client: httpx.AsyncClient, place: dict) -> Optional[dict]:
    cached, row = health_cache.get(place["id"])
    if cached:
        return row
    row = None
    for keyword in name_keywords(place["name"]):
        try:
            rows = await ga_health.search(client, keyword)
        except (httpx.HTTPError, ValueError) as exc:
            logger.warning("health portal lookup failed for %r: %r", keyword, exc)
            return None  # do not cache a transport failure
        row = match_row(place, rows)
        if row is not None:
            break
    health_cache.put(place["id"], row)
    return row


# ── Assembly ─────────────────────────────────────────────────────────────────


def haversine_mi(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    r = 3958.8
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dphi, dl = math.radians(lat2 - lat1), math.radians(lng2 - lng1)
    a = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def sort_results(results: list[dict], sort_by: str) -> list[dict]:
    big = 10**9
    if sort_by == "health":
        key = lambda r: (-(r["health_score"] if r["health_score"] is not None else -1), -(r["rating"] or 0))  # noqa: E731
    elif sort_by == "distance":
        key = lambda r: (r["distance_mi"] if r["distance_mi"] is not None else big, -(r["rating"] or 0))  # noqa: E731
    elif sort_by == "price":
        key = lambda r: (r["price_level"] if r["price_level"] is not None else big, -(r["rating"] or 0))  # noqa: E731
    else:
        key = lambda r: (-weighted_rating(r["rating"], r["rating_count"]), -(r["rating_count"] or 0))  # noqa: E731
    return sorted(results, key=key)


def _inspection_date(raw: str) -> str:
    m = re.match(r"(\d{2})-(\d{2})-(\d{4})", raw or "")
    if not m:
        return raw or ""
    months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
    return f"{int(m.group(2))} {months[int(m.group(1)) - 1]} {m.group(3)}"


def format_line(i: int, r: dict) -> str:
    parts = [f"{i}. {r['name']}"]
    if r["rating"] is not None:
        parts.append(f"{r['rating']} stars ({r['rating_count'] or 0} reviews)")
    if r["price_level"] is not None:
        parts.append(_PRICE_WORDS.get(r["price_level"], "") + " price")
    if r["distance_mi"] is not None:
        parts.append(f"{r['distance_mi']:.1f} mi away")
    if r["health_score"] is not None:
        parts.append(f"health score {r['health_score']} ({_inspection_date(r['health_date'])})")
    else:
        parts.append("no health score on file")
    if r["open_now"]:
        parts.append("open now")
    street = r["address"].split(",")[0]
    return ", ".join(parts) + f" — {street}, {r['locality']}".rstrip(", ")


def format_text(req: RestaurantsRequest, results: list[dict]) -> str:
    where = " near home" if req.near and req.lat is not None else " near you" if req.lat is not None else ""
    head = f"Restaurants for {req.query!r}{where}, sorted by {req.sort_by}"
    filters = []
    if req.open_now:
        filters.append("open now")
    if req.min_rating is not None:
        filters.append(f"rating at least {req.min_rating}")
    if req.min_health_score is not None:
        filters.append(f"health score at least {req.min_health_score}")
    if filters:
        head += " (" + ", ".join(filters) + ")"
    if not results:
        cuisine = cuisine_type(req.query)
        what = f"{cuisine[0].title()} places" if cuisine else "matching restaurants"
        why = " open right now" if req.open_now else ""
        return head + f":\nNo {what}{why} found within about {req.radius_m * 2 / 1609.344:.0f} miles."
    lines = [head + ". Health scores are official Georgia DPH inspection scores (out of 100):"]
    lines += [format_line(i, r) for i, r in enumerate(results, 1)]
    return "\n".join(lines)


# ── Place details: phone, website, hours (on demand, one place at a time) ────
# These fields bill at the Enterprise tier (1,000 free a month), so they are
# fetched only for the place the user asks about and cached for a day.

PLACES_DETAILS_URL = "https://places.googleapis.com/v1/places/{id}"
DETAILS_FIELD_MASK = ",".join(
    (
        "id",
        "displayName",
        "formattedAddress",
        "nationalPhoneNumber",
        "internationalPhoneNumber",
        "websiteUri",
        "regularOpeningHours",
        "currentOpeningHours",
        "googleMapsUri",
    )
)
RECENT_PLACES_TTL_S = 3600
DETAILS_CACHE_TTL_S = 24 * 3600
_recent_places: dict[str, tuple[float, dict]] = {}  # place id -> (stamp, parsed place) from find_restaurants
_details_cache: dict[str, tuple[float, dict]] = {}


class DetailsRequest(BaseModel):
    name: str
    area: Optional[str] = None


def remember_places(places: list[dict]) -> None:
    now = time.monotonic()
    for p in places:
        if p.get("id"):
            _recent_places[p["id"]] = (now, p)
    for pid, (stamp, _p) in list(_recent_places.items()):
        if now - stamp > RECENT_PLACES_TTL_S:
            _recent_places.pop(pid, None)


def _recent_place_matching(name: str, area: Optional[str]) -> Optional[dict]:
    candidates = [p for _stamp, p in _recent_places.values() if name_matches(name, p.get("name", ""))]
    if area:
        a_words = [w for w in re.findall(r"[a-z0-9]+", area.lower()) if w not in _JOINERS]
        preferred = [p for p in candidates if all(w in p.get("address", "").lower() for w in a_words)]
        candidates = preferred or candidates
    return candidates[0] if candidates else None


def _clean_hours(text: str) -> str:
    return " ".join(text.replace("\u202f", " ").replace("\u2009", " ").replace("\u2013", "-").split())


def parse_details(d: dict) -> dict:
    hours = [_clean_hours(h) for h in (d.get("regularOpeningHours") or {}).get("weekdayDescriptions") or []]
    intl = d.get("internationalPhoneNumber") or ""
    return {
        "id": d.get("id", ""),
        "name": (d.get("displayName") or {}).get("text", ""),
        "address": d.get("formattedAddress", ""),
        "phone": d.get("nationalPhoneNumber") or intl or "",
        "phone_dial": re.sub(r"[^\d+]", "", intl) if intl else "",
        "website": d.get("websiteUri") or "",
        "open_now": (d.get("currentOpeningHours") or {}).get("openNow"),
        "hours": hours,
        "maps_url": d.get("googleMapsUri", ""),
        **place_links(d.get("id", ""), (d.get("displayName") or {}).get("text", ""), d.get("formattedAddress", "")),
    }


def format_details(det: dict, today: str) -> str:
    street = det["address"].split(",")[0]
    parts = [f"{det['name']} ({street})"]
    parts.append(f"phone {det['phone']}" if det["phone"] else "no phone number listed")
    if det["website"]:
        site = re.sub(r"^https?://(www\.)?", "", det["website"]).rstrip("/")
        parts.append(f"website {site}")
    if det["open_now"] is not None:
        parts.append("open right now" if det["open_now"] else "closed right now")
    todays = next((h for h in det["hours"] if h.lower().startswith(today.lower())), None)
    if todays:
        parts.append(f"hours today, {todays}")
    elif det["hours"]:
        parts.append("hours: " + "; ".join(det["hours"]))
    return ", ".join(parts) + "."


async def place_details(req: DetailsRequest, today: str) -> dict:
    if not PLACES_KEY:
        raise RuntimeError("Restaurant search is not configured.")
    async with httpx.AsyncClient() as client:
        place = _recent_place_matching(req.name, req.area)
        if place is None:
            body = {
                "textQuery": f"{req.name} {req.area or ''}".strip(),
                "maxResultCount": 3,
                "includedType": "restaurant",
            }
            headers = {
                "Content-Type": "application/json",
                "X-Goog-Api-Key": PLACES_KEY,
                "X-Goog-FieldMask": "places.id,places.displayName,places.formattedAddress",
            }
            resp = await client.post(PLACES_SEARCH_URL, headers=headers, json=body, timeout=15.0)
            if resp.status_code != 200:
                raise RuntimeError(f"Places error {resp.status_code}")
            for raw in resp.json().get("places") or []:
                cand = {
                    "id": raw.get("id", ""),
                    "name": (raw.get("displayName") or {}).get("text", ""),
                    "address": raw.get("formattedAddress", ""),
                }
                if name_matches(req.name, cand["name"]):
                    place = cand
                    break
        if place is None:
            return {"found": False, "name": req.name, "text": f"No place found for {req.name!r}."}
        hit = _details_cache.get(place["id"])
        if hit and time.monotonic() - hit[0] < DETAILS_CACHE_TTL_S:
            det = hit[1]
        else:
            resp = await client.get(
                PLACES_DETAILS_URL.format(id=place["id"]),
                headers={"X-Goog-Api-Key": PLACES_KEY, "X-Goog-FieldMask": DETAILS_FIELD_MASK},
                timeout=15.0,
            )
            if resp.status_code != 200:
                raise RuntimeError(f"Places details error {resp.status_code}")
            det = parse_details(resp.json())
            _details_cache[place["id"]] = (time.monotonic(), det)
    logger.info("restaurant_details %r -> %s phone=%s", req.name, det["name"], "yes" if det["phone"] else "no")
    return {**det, "found": True, "text": format_details(det, today)}


# ── Inspection history ───────────────────────────────────────────────────────


class InspectionsRequest(BaseModel):
    name: str
    area: Optional[str] = None
    limit: int = Field(default=3, ge=1, le=10)


_inspection_cache: dict[str, tuple[float, list[dict]]] = {}
INSPECTION_CACHE_TTL_S = 24 * 3600


def _date_key(raw: str) -> tuple:
    m = re.match(r"(\d{2})-(\d{2})-(\d{4})", raw or "")
    return (int(m.group(3)), int(m.group(1)), int(m.group(2))) if m else (0, 0, 0)


def name_matches(asked: str, portal_name: str) -> bool:
    """Every word of the asked name (joiners aside) appears in the portal name, as a word prefix."""
    asked_words = [w for w in re.findall(r"[a-z0-9']+", asked.lower()) if w not in _JOINERS]
    portal_words = re.findall(r"[a-z0-9']+", portal_name.lower())
    return bool(asked_words) and all(any(pw.startswith(aw) for pw in portal_words) for aw in asked_words)


def _cached_rows_matching(name: str) -> list[dict]:
    """Portal rows already fetched for a place (from find_restaurants) whose name matches."""
    return [row for _stamp, row in health_cache._rows.values() if row and name_matches(name, row.get("name", ""))]


async def _resolve_establishment(
    client: httpx.AsyncClient, name: str, area: Optional[str]
) -> tuple[Optional[dict], list[dict]]:
    """Best portal row for a spoken restaurant name, plus the other candidates."""
    rows = _cached_rows_matching(name)
    if not rows:
        for keyword in name_keywords(name):
            rows = [r for r in await ga_health.search(client, keyword) if name_matches(name, r.get("name", ""))]
            if rows:
                break
    if not rows:
        return None, []
    if area:
        # City, street or zip: the portal files places under mailing cities, so
        # "Johns Creek" may not appear in a Johns Creek address, but the street will.
        a_words = [w for w in re.findall(r"[a-z0-9]+", area.lower()) if w not in _JOINERS]
        preferred = [r for r in rows if all(w in r.get("address", "").lower() for w in a_words)]
        if preferred:
            rows = preferred + [r for r in rows if r not in preferred]
    return rows[0], rows[1:]


def _title_address(addr: str) -> str:
    return re.sub(
        r"\b(Ga|Ne|Nw|Se|Sw|Ste)\b", lambda m: m.group(1).upper() if m.group(1) != "Ste" else "Ste", addr.title()
    )


def format_history(row: dict, inspections: list[dict], others: list[dict]) -> str:
    head = f"{row['name'].title()} ({_title_address(row['address'])})"
    if not inspections:
        return f"{head}: no inspections on file."
    parts = []
    for insp in inspections:
        n = len(insp.get("violations") or [])
        purpose = (insp.get("purpose") or "inspection").lower()
        parts.append(
            f"{insp.get('score')} on {_inspection_date(insp.get('date', ''))} ({purpose}, {n} violation{'s' if n != 1 else ''})"
        )
    text = f"{head}, Georgia DPH scores, newest first: " + "; ".join(parts) + "."
    scores = [i.get("score") for i in inspections if isinstance(i.get("score"), int)]
    if len(scores) >= 2:
        trend = "improving" if scores[0] > scores[-1] else "slipping" if scores[0] < scores[-1] else "steady"
        text += f" Trend: {trend}."
    latest = inspections[0].get("violations") or []
    notable = sorted(latest, key=lambda v: -(v.get("points") or 0))[:3]
    if notable:
        text += (
            " Latest violations: "
            + "; ".join(
                f"{v.get('description', v.get('item', 'violation'))}"
                + (f" ({v['points']} pts)" if v.get("points") else "")
                + (" (repeat)" if v.get("repeat") else "")
                for v in notable
            )
            + "."
        )
    if others:
        text += f" Other locations with a similar name: {len(others)}."
    return text


async def inspection_history(req: InspectionsRequest) -> dict:
    async with httpx.AsyncClient() as client:
        row, others = await _resolve_establishment(client, req.name, req.area)
        if row is None:
            return {
                "name": req.name,
                "found": False,
                "text": f"No Georgia inspection record found for {req.name!r}.",
                "inspections": [],
            }
        est_id = row.get("id", "")
        hit = _inspection_cache.get(est_id)
        if hit and time.monotonic() - hit[0] < INSPECTION_CACHE_TTL_S:
            inspections = hit[1]
        else:
            inspections = await ga_health.get_inspections(client, est_id)
            inspections.sort(key=lambda i: _date_key(i.get("date", "")), reverse=True)
            _inspection_cache[est_id] = (time.monotonic(), inspections)
    recent = inspections[: req.limit]
    logger.info("restaurant_inspections %r -> %s, %d inspections", req.name, row.get("name"), len(inspections))
    return {
        "name": row.get("name", "").title(),
        "address": _title_address(row.get("address", "")),
        "found": True,
        "text": format_history(row, recent, others),
        "inspections": [
            {
                "date": _inspection_date(i.get("date", "")),
                "score": i.get("score"),
                "purpose": i.get("purpose", ""),
                "violations": [
                    {
                        "description": v.get("description", ""),
                        "points": v.get("points"),
                        "repeat": bool(v.get("repeat")),
                    }
                    for v in (i.get("violations") or [])
                ],
                "report_url": i.get("report_url", ""),
            }
            for i in recent
        ],
    }


_geocode_cache: dict[str, tuple[float, Optional[tuple[float, float]]]] = {}
GEOCODE_CACHE_TTL_S = 7 * 24 * 3600


async def geocode(client: httpx.AsyncClient, address: str) -> Optional[tuple[float, float]]:
    """Coordinates for an address via a Places text search (location only)."""
    key = " ".join(address.lower().split())
    hit = _geocode_cache.get(key)
    if hit and time.monotonic() - hit[0] < GEOCODE_CACHE_TTL_S:
        return hit[1]
    headers = {"Content-Type": "application/json", "X-Goog-Api-Key": PLACES_KEY, "X-Goog-FieldMask": "places.location"}
    resp = await client.post(
        PLACES_SEARCH_URL, headers=headers, json={"textQuery": address, "maxResultCount": 1}, timeout=15.0
    )
    loc = None
    if resp.status_code == 200:
        places = resp.json().get("places") or []
        if places and places[0].get("location"):
            loc = (places[0]["location"]["latitude"], places[0]["location"]["longitude"])
    _geocode_cache[key] = (time.monotonic(), loc)
    return loc


async def find_restaurants(req: RestaurantsRequest) -> dict:
    if not PLACES_KEY:
        raise RuntimeError("Restaurant search is not configured.")
    sort_by = req.sort_by if req.sort_by in SORTS else "rating"
    req = req.model_copy(update={"sort_by": sort_by})
    async with httpx.AsyncClient() as client:
        if (req.lat is None or req.lng is None) and req.near:
            loc = await geocode(client, req.near)
            if loc:
                req = req.model_copy(update={"lat": loc[0], "lng": loc[1]})
        places = [p for p in await places_search(client, req) if p["operational"]]
        sem = asyncio.Semaphore(HEALTH_CONCURRENCY)

        async def lookup(p: dict) -> Optional[dict]:
            async with sem:
                return await health_for(client, p)

        health = await asyncio.gather(*(lookup(p) for p in places))
    results = []
    for p, row in zip(places, health):
        dist = None
        if req.lat is not None and req.lng is not None and p["lat"] is not None and p["lng"] is not None:
            dist = haversine_mi(req.lat, req.lng, p["lat"], p["lng"])
        results.append(
            {
                **p,
                "distance_mi": dist,
                "health_score": row.get("score") if row else None,
                "health_date": row.get("inspection_date", "") if row else "",
                "health_name": row.get("name", "") if row else "",
                "open_now": bool(req.open_now),  # Places filtered on it; not re-verified per place
            }
        )
    if req.lat is not None and req.lng is not None:
        # Places treats the location as a bias, not a fence: a 15-mile hit can
        # outrank a 2-mile one. Keep "nearby" honest at twice the asked radius.
        limit_mi = req.radius_m * 2 / 1609.344
        results = [r for r in results if r["distance_mi"] is None or r["distance_mi"] <= limit_mi]
    if req.min_rating is not None:
        results = [r for r in results if (r["rating"] or 0) >= req.min_rating]
    if req.min_health_score is not None:
        results = [r for r in results if r["health_score"] is not None and r["health_score"] >= req.min_health_score]
    results = sort_results(results, sort_by)[: req.max_results]
    remember_places(results)
    logger.info(
        "find_restaurants %r -> %d results (%s); scores matched %d/%d",
        req.query,
        len(results),
        sort_by,
        sum(r["health_score"] is not None for r in results),
        len(results),
    )
    return {"query": req.query, "sort_by": sort_by, "text": format_text(req, results), "results": results}
