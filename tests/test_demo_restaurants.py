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


def test_inspection_parsing_and_history_text():
    row = {
        "inspectionId": "i1",
        "columns": {"1": "Date: 05-26-2026", "2": "Inspection Purpose: Routine", "3": "Score: 87"},
        "violations": {
            "a": [
                "3 - proper cold holding temperatures",
                "511-6-1-.04(6)(f) - Time/Temperature",
                "Points: 9",
                "Corrected during inspection?: Yes",
                "Repeat: No",
            ],
            "b": [
                "17 - insects, rodents, and animals not present",
                "511-6-1-.07(5)(k)",
                "Points: 3",
                "Repeat: Yes",
                "Inspector NotesObserved flies.",
            ],
        },
        "printablePath": "../../_templates/report.cfm?id=1",
    }
    insp = ga_health.parse_inspection(row)
    assert insp["score"] == 87 and insp["purpose"] == "Routine" and insp["date"] == "05-26-2026"
    assert insp["violations"][0]["points"] == 9 and insp["violations"][0]["corrected"] is True
    assert insp["violations"][1]["repeat"] is True and insp["violations"][1]["notes"] == "Observed flies."
    assert insp["report_url"].startswith("https://ga.healthinspections.us/")

    older = {"date": "11-25-2025", "score": 90, "purpose": "Routine", "violations": [{}] * 3}
    oldest = {"date": "05-01-2025", "score": 95, "purpose": "Routine", "violations": [{}] * 2}
    text = restaurants.format_history(
        {"name": "THOOM THAI & SUSHI", "address": "11030 MEDLOCK BRIDGE STE 150 JOHNS CREEK, GA 30097"},
        [insp, older, oldest],
        [],
    )
    assert text.startswith(
        "Thoom Thai & Sushi (11030 Medlock Bridge Ste 150 Johns Creek, GA 30097), Georgia DPH scores, newest first: 87 on 26 May 2026 (routine, 2 violations); 90 on 25 Nov 2025"
    )
    assert "Trend: slipping." in text and "proper cold holding temperatures (9 pts)" in text and "(repeat)" in text


def test_name_matching_rejects_lookalikes_and_area_prefers_street_or_zip():
    assert restaurants.name_matches("Thoom Thai", "THOOM THAI & SUSHI")
    assert restaurants.name_matches("Thai Squared", "Thai Squared")
    assert not restaurants.name_matches("Nowhere Grill", "Nowhere Bar")
    assert not restaurants.name_matches("", "Anything")
    # One letter of slack on long words only: speech recognition spelled it "Bullock".
    assert restaurants.name_matches("Bullock House", "Bulloch House")
    assert restaurants.name_matches("Bulloch", "BULLOCH HOUSE RESTAURANT")
    assert not restaurants.name_matches("Thao Squared", "Thai Squared")  # short words stay exact
    assert not restaurants.name_matches("Bullocks Steakhouse", "Bulloch House")


@pytest.mark.asyncio
async def test_inspection_history_picks_the_location_in_the_asked_area(monkeypatch):
    class FakeClient:
        def __init__(self, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            pass

        async def get(self, url, headers=None, timeout=None):
            if "/inspectionsData/" in url:
                est = url.rsplit("/", 1)[1]
                score = 92 if est == "jc" else 80
                return httpx.Response(
                    200,
                    json=[
                        {
                            "inspectionId": est,
                            "columns": {
                                "1": "Date: 06-29-2026",
                                "2": "Inspection Purpose: Routine",
                                "3": f"Score: {score}",
                            },
                            "violations": {},
                        }
                    ],
                )
            return httpx.Response(
                200,
                json=[
                    {
                        "id": "alp",
                        "name": "Thai Squared",
                        "mapAddress": "5530 WINDWARD PKWY STE 140A ALPHARETTA, GA 30004",
                        "columns": {"1": "Last Inspection Score: 80"},
                    },
                    {
                        "id": "jc",
                        "name": "Thai Squared",
                        "mapAddress": "6955 MCGINNIS FERRY RD STE 115 SUWANEE, GA 30024",
                        "columns": {"1": "Last Inspection Score: 92"},
                    },
                ],
            )

    monkeypatch.setattr(restaurants.httpx, "AsyncClient", FakeClient)
    monkeypatch.setattr(restaurants, "health_cache", restaurants.HealthCache())
    restaurants._inspection_cache.clear()
    out = await restaurants.inspection_history(
        restaurants.InspectionsRequest(name="Thai Squared", area="McGinnis Ferry")
    )
    assert out["found"] and "6955 Mcginnis Ferry" in out["address"] and out["inspections"][0]["score"] == 92
    assert "Other locations with a similar name: 1" in out["text"]
    missing = await restaurants.inspection_history(restaurants.InspectionsRequest(name="Nowhere Grill"))
    assert missing["found"] is False and "No Georgia inspection record" in missing["text"]


@pytest.mark.asyncio
async def test_place_details_uses_recent_results_then_one_details_call(monkeypatch):
    calls = []

    class FakeClient:
        def __init__(self, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            pass

        async def post(self, url, headers=None, json=None, timeout=None):
            calls.append(("search", json))
            return httpx.Response(
                200,
                json={
                    "places": [
                        {
                            "id": "pid-dee",
                            "displayName": {"text": "Dee Thai"},
                            "formattedAddress": "10945 State Bridge Rd, Alpharetta, GA",
                        }
                    ]
                },
            )

        async def get(self, url, headers=None, timeout=None):
            calls.append(("details", url))
            assert headers["X-Goog-FieldMask"] == restaurants.DETAILS_FIELD_MASK
            return httpx.Response(
                200,
                json={
                    "id": "pid-dee",
                    "displayName": {"text": "Dee Thai"},
                    "formattedAddress": "10945 State Bridge Rd, Alpharetta, GA 30022",
                    "nationalPhoneNumber": "(770) 754-6222",
                    "internationalPhoneNumber": "+1 770-754-6222",
                    "websiteUri": "https://deethairestaurants.com/",
                    "currentOpeningHours": {"openNow": False},
                    "regularOpeningHours": {
                        "weekdayDescriptions": [
                            "Monday: 11:30\u202fAM\u2009\u2013\u20093:00\u202fPM",
                            "Tuesday: 11:30\u202fAM\u2009\u2013\u20099:30\u202fPM",
                        ]
                    },
                    "googleMapsUri": "https://maps.google.com/?cid=2",
                },
            )

    monkeypatch.setattr(restaurants, "PLACES_KEY", "places-key")
    monkeypatch.setattr(restaurants.httpx, "AsyncClient", FakeClient)
    restaurants._details_cache.clear()
    restaurants._recent_places.clear()
    restaurants.remember_places(
        [{"id": "pid-dee", "name": "Dee Thai", "address": "10945 State Bridge Rd, Alpharetta, GA 30022"}]
    )

    out = await restaurants.place_details(restaurants.DetailsRequest(name="Dee Thai"), today="Tuesday")
    assert out["found"] and out["phone"] == "(770) 754-6222" and out["phone_dial"] == "+17707546222"
    assert out["hours"][1] == "Tuesday: 11:30 AM - 9:30 PM"  # thin spaces and dashes normalised
    assert (
        out["text"]
        == "Dee Thai (10945 State Bridge Rd), phone (770) 754-6222, website deethairestaurants.com, closed right now, hours today, Tuesday: 11:30 AM - 9:30 PM."
    )
    assert [c[0] for c in calls] == ["details"]  # recent result resolved the id: no search call

    again = await restaurants.place_details(restaurants.DetailsRequest(name="Dee Thai"), today="Tuesday")
    assert again["phone"] == out["phone"] and len(calls) == 1  # cached

    restaurants._recent_places.clear()
    restaurants._details_cache.clear()
    await restaurants.place_details(restaurants.DetailsRequest(name="Dee Thai", area="Alpharetta"), today="Tuesday")
    assert [c[0] for c in calls][1:] == ["search", "details"]  # cold: an id lookup, then details


def test_places_carry_review_and_directions_links():
    p = restaurants.parse_place(_place("Dee Thai", "10945", "State Bridge Rd"))
    assert p["reviews_url"] == "https://search.google.com/local/reviews?placeid=id-Dee%20Thai".replace("%20", " ") or p[
        "reviews_url"
    ].startswith("https://search.google.com/local/reviews?placeid=")
    assert p["directions_url"].startswith("https://www.google.com/maps/dir/?api=1&destination=Dee%20Thai%2010945")
    assert p["directions_url"].endswith("&destination_place_id=id-Dee Thai")
    assert restaurants.place_links("", "x", "y") == {"reviews_url": "", "directions_url": ""}


@pytest.mark.asyncio
async def test_home_address_is_geocoded_when_no_location_was_shared(monkeypatch):
    calls = []

    class FakeClient:
        def __init__(self, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            pass

        async def post(self, url, headers=None, json=None, timeout=None):
            calls.append(json)
            if headers["X-Goog-FieldMask"] == "places.location":
                return httpx.Response(200, json={"places": [{"location": {"latitude": 34.07, "longitude": -84.27}}]})
            return httpx.Response(
                200, json={"places": [_place("Dee Thai", "10945", "State Bridge Rd", lat=34.03, lng=-84.20)]}
            )

        async def get(self, url, headers=None, timeout=None):
            return httpx.Response(200, json=[])

    monkeypatch.setattr(restaurants, "PLACES_KEY", "places-key")
    monkeypatch.setattr(restaurants.httpx, "AsyncClient", FakeClient)
    monkeypatch.setattr(restaurants, "health_cache", restaurants.HealthCache())
    restaurants._geocode_cache.clear()
    out = await restaurants.find_restaurants(
        restaurants.RestaurantsRequest(query="thai", near="10945 State Bridge Rd, Alpharetta, GA")
    )
    assert (
        calls[0]["textQuery"].startswith("10945 State Bridge Rd")
        and calls[1]["locationBias"]["circle"]["center"]["latitude"] == 34.07
    )
    assert out["results"][0]["distance_mi"] is not None and "near home" in out["text"]


@pytest.mark.asyncio
async def test_an_asked_about_area_overrides_the_users_location(monkeypatch):
    """ "Restaurants near the Little White House" from 100 miles away: the area
    is geocoded and becomes the search centre and the distance fence, so the
    user's own coordinates neither bias nor fence the results."""
    calls = []

    class FakeClient:
        def __init__(self, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            pass

        async def post(self, url, headers=None, json=None, timeout=None):
            calls.append(json)
            if headers["X-Goog-FieldMask"] == "places.location":
                return httpx.Response(200, json={"places": [{"location": {"latitude": 32.88, "longitude": -84.68}}]})
            return httpx.Response(
                200, json={"places": [_place("Bulloch House", "70", "Broad St", lat=32.89, lng=-84.68, rating=4.4)]}
            )

        async def get(self, url, headers=None, timeout=None):
            return httpx.Response(200, json=[])

    monkeypatch.setattr(restaurants, "PLACES_KEY", "places-key")
    monkeypatch.setattr(restaurants.httpx, "AsyncClient", FakeClient)
    monkeypatch.setattr(restaurants, "health_cache", restaurants.HealthCache())
    restaurants._geocode_cache.clear()
    out = await restaurants.find_restaurants(
        restaurants.RestaurantsRequest(query="lunch", lat=34.03, lng=-84.20, area="Warm Springs, GA")
    )
    assert calls[0]["textQuery"] == "Warm Springs, GA"
    assert calls[1]["locationBias"]["circle"]["center"]["latitude"] == 32.88
    assert len(out["results"]) == 1 and out["results"][0]["distance_mi"] < 2
    assert "near Warm Springs, GA" in out["text"]


def test_details_carry_rating_and_review_count():
    det = restaurants.parse_details(
        {
            "id": "p1",
            "displayName": {"text": "Bulloch House"},
            "formattedAddress": "70 Broad St, Warm Springs, GA 31830",
            "rating": 4.4,
            "userRatingCount": 1650,
            "regularOpeningHours": {"weekdayDescriptions": ["Tuesday: 11:00 AM - 2:30 PM"]},
        }
    )
    assert det["rating"] == 4.4 and det["rating_count"] == 1650
    assert "rated 4.4 from 1650 reviews" in restaurants.format_details(det, "Tuesday")
