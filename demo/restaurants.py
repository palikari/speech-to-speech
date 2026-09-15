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
    radius_m: int = Field(default=DEFAULT_RADIUS_M, ge=500, le=50000)
    open_now: bool = False
    sort_by: str = "rating"
    min_rating: Optional[float] = None
    min_health_score: Optional[int] = None
    max_results: int = Field(default=5, ge=1, le=MAX_RESULTS)


# ── Google Places ────────────────────────────────────────────────────────────


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
    where = " near you" if req.lat is not None else ""
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


async def find_restaurants(req: RestaurantsRequest) -> dict:
    if not PLACES_KEY:
        raise RuntimeError("Restaurant search is not configured.")
    sort_by = req.sort_by if req.sort_by in SORTS else "rating"
    req = req.model_copy(update={"sort_by": sort_by})
    async with httpx.AsyncClient() as client:
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
    logger.info(
        "find_restaurants %r -> %d results (%s); scores matched %d/%d",
        req.query,
        len(results),
        sort_by,
        sum(r["health_score"] is not None for r in results),
        len(results),
    )
    return {"query": req.query, "sort_by": sort_by, "text": format_text(req, results), "results": results}
