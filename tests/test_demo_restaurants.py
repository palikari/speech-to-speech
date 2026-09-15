"""Restaurant search: Places parsing, health-score matching, sorting, formatting (no network)."""

import base64
import importlib
import json
import sys
import urllib.parse
from pathlib import Path

import httpx
import pytest

DEMO_DIR = Path(__file__).resolve().parents[1] / "demo"
sys.path.insert(0, str(DEMO_DIR))
ga_health = importlib.import_module("ga_health")
restaurants = importlib.import_module("restaurants")


def _place(
    name,
    number,
    route,
    locality="Johns Creek",
    rating=4.2,
    count=100,
    price="PRICE_LEVEL_MODERATE",
    lat=34.03,
    lng=-84.20,
):
    return {
        "id": f"id-{name}",
        "displayName": {"text": name},
        "formattedAddress": f"{number} {route}, {locality}, GA 30097, USA",
        "addressComponents": [
            {"longText": number, "types": ["street_number"]},
            {"longText": route, "types": ["route"]},
            {"longText": locality, "types": ["locality"]},
            {"longText": "30097", "types": ["postal_code"]},
        ],
        "location": {"latitude": lat, "longitude": lng},
        "rating": rating,
        "userRatingCount": count,
        "priceLevel": price,
        "googleMapsUri": "https://maps.google.com/?cid=1",
        "primaryTypeDisplayName": {"text": "Thai Restaurant"},
        "businessStatus": "OPERATIONAL",
    }


def _row(name, address, score, date="05-26-2026"):
    return {
        "id": "abc",
        "name": name,
        "mapAddress": address,
        "columns": {"1": f"Last Inspection Score: {score}", "2": f"Last Inspection Date: {date}"},
    }


def test_parse_place_and_portal_row():
    p = restaurants.parse_place(_place("Thoom Thai & Sushi", "11030", "Medlock Bridge Rd"))
    assert p["street_number"] == "11030" and p["route"] == "Medlock Bridge Rd" and p["price_level"] == 2
    r = ga_health.parse_row(_row("THOOM THAI", "11030 MEDLOCK BRIDGE STE 150\r\n JOHNS CREEK, GA 30097", 87))
    assert r["score"] == 87 and r["inspection_date"] == "05-26-2026" and "\r" not in r["address"]


def test_name_keywords_skip_generic_words_and_prefer_two_words():
    assert restaurants.name_keywords("Chaba Thai Restaurant") == ["chaba thai", "chaba"]
    assert restaurants.name_keywords("The Kitchen") == ["kitchen"]  # stopwords only: fall back to the first word
    assert restaurants.name_keywords("FIN Sushi Thai Johns Creek") == ["fin sushi", "fin"]


def test_match_row_requires_the_same_street_number_and_street():
    place = restaurants.parse_place(_place("Thai Squared", "6955", "McGinnis Ferry Rd"))
    rows = [
        ga_health.parse_row(_row("Thai Squared", "5530 WINDWARD PKWY STE 140A ALPHARETTA, GA", 92)),
        ga_health.parse_row(_row("Thai Squared", "6955 MCGINNIS FERRY RD STE 115 SUWANEE, GA", 92)),
    ]
    assert restaurants.match_row(place, rows)["address"].startswith("6955 MCGINNIS")
    other = restaurants.parse_place(_place("Alessio's", "6955", "Medlock Bridge Rd"))
    assert restaurants.match_row(other, rows) is None  # same number, different street


def test_sorting_puts_unscored_last_for_health_and_orders_by_each_key():
    rows = [
        {"name": "A", "rating": 4.6, "rating_count": 10, "price_level": 3, "distance_mi": 5.0, "health_score": None},
        {"name": "B", "rating": 4.2, "rating_count": 800, "price_level": 1, "distance_mi": 1.0, "health_score": 92},
        {"name": "C", "rating": 4.4, "rating_count": 100, "price_level": 2, "distance_mi": 2.0, "health_score": 87},
    ]
    order = lambda key: [r["name"] for r in restaurants.sort_results(rows, key)]  # noqa: E731
    assert order("rating") == ["C", "A", "B"]  # review-weighted: 4.4 from 100 beats 4.6 from 10
    assert order("health") == ["B", "C", "A"]
    assert order("distance") == ["B", "C", "A"]
    assert order("price") == ["B", "C", "A"]


@pytest.mark.asyncio
async def test_find_restaurants_end_to_end_with_fakes(monkeypatch):
    calls = []

    class FakeClient:
        def __init__(self, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            pass

        async def post(self, url, headers=None, json=None, timeout=None):
            calls.append(("places", json))
            assert headers["X-Goog-Api-Key"] == "places-key" and "places.rating" in headers["X-Goog-FieldMask"]
            assert "currentOpeningHours" not in headers["X-Goog-FieldMask"]  # stay on the Pro tier
            return httpx.Response(
                200,
                json={
                    "places": [
                        _place("Thoom Thai & Sushi", "11030", "Medlock Bridge Rd", rating=4.4, count=106),
                        _place("Chaba Thai Restaurant", "9700", "Medlock Bridge Rd", rating=4.2, count=416),
                        _place("Closed Place", "1", "Nowhere Rd") | {"businessStatus": "CLOSED_PERMANENTLY"},
                        _place(
                            "Far Thai", "1", "Faraway Rd", lat=33.75, lng=-84.39, rating=4.9
                        ),  # ~25 mi: outside twice the radius
                    ]
                },
            )

        async def get(self, url, headers=None, timeout=None):
            calls.append(("portal", url))
            payload = json.loads(urllib.parse.unquote(url.split("/search/")[1].rsplit("/", 1)[0]))
            keyword = base64.b64decode(payload["keyword"]).decode()
            if keyword in ("thoom thai", "thoom"):
                return httpx.Response(
                    200, json=[_row("THOOM THAI & SUSHI", "11030 MEDLOCK BRIDGE STE 150 JOHNS CREEK, GA", 87)]
                )
            return httpx.Response(200, json=[])

    monkeypatch.setattr(restaurants, "PLACES_KEY", "places-key")
    monkeypatch.setattr(restaurants.httpx, "AsyncClient", FakeClient)
    monkeypatch.setattr(restaurants, "health_cache", restaurants.HealthCache())
    monkeypatch.setattr(ga_health, "PAGE_DELAY_S", 0)

    out = await restaurants.find_restaurants(
        restaurants.RestaurantsRequest(query="thai", lat=34.0289, lng=-84.1986, sort_by="health")
    )
    names = [r["name"] for r in out["results"]]
    assert names == ["Thoom Thai & Sushi", "Chaba Thai Restaurant"]  # closed and far-away places dropped, scored first
    assert out["results"][0]["health_score"] == 87 and out["results"][1]["health_score"] is None
    assert out["results"][0]["distance_mi"] is not None
    assert "health score 87 (26 May 2026)" in out["text"] and "no health score on file" in out["text"]
    assert calls[0][1]["locationBias"]["circle"]["radius"] == restaurants.DEFAULT_RADIUS_M
    assert calls[0][1]["includedType"] == "thai_restaurant" and calls[0][1]["strictTypeFiltering"] is True

    # Second run: the score comes from the cache, the portal is not asked again.
    before = len([c for c in calls if c[0] == "portal"])
    await restaurants.find_restaurants(restaurants.RestaurantsRequest(query="thai"))
    assert len([c for c in calls if c[0] == "portal"]) == before  # hits and misses are both cached


def test_cuisine_detection_and_weighted_rating():
    assert restaurants.cuisine_type("really good Thai restaurants") == ("thai", "thai_restaurant")
    assert restaurants.cuisine_type("cheap pizza in Alpharetta") == ("pizza", "pizza_restaurant")
    assert restaurants.cuisine_type("middle eastern food") == ("middle eastern", "middle_eastern_restaurant")
    assert restaurants.cuisine_type("somewhere nice for dinner") is None
    # a 5.0 from one review ranks below a 4.7 from 700
    assert restaurants.weighted_rating(5.0, 1) < restaurants.weighted_rating(4.7, 700)
    rows = [
        {
            "name": "Counter",
            "rating": 5.0,
            "rating_count": 1,
            "price_level": 1,
            "distance_mi": 1.0,
            "health_score": None,
        },
        {
            "name": "Favourite",
            "rating": 4.7,
            "rating_count": 700,
            "price_level": 2,
            "distance_mi": 2.0,
            "health_score": 95,
        },
    ]
    assert [r["name"] for r in restaurants.sort_results(rows, "rating")] == ["Favourite", "Counter"]
