"""
Script 4f — Fetch prospect birth dates from Wikipedia.

NFL.com's prospect API doesn't expose DOB. Wikipedia infoboxes do, in a
predictable form (`<span class="bday">YYYY-MM-DD</span>`). We resolve each
prospect to a Wikipedia title via the opensearch endpoint, fetch the
parsed HTML, and pull the bday span.

Output:
  data/prospect_birthdates.json   — keyed by NFL.com nfl_id:
      {
        "<nfl_id>": {
          "name":       "Fernando Mendoza",
          "dob":        "2003-12-14",
          "source":     "wikipedia",
          "page_title": "Fernando Mendoza (American football)"
        },
        ...
      }

Idempotent + incremental: results already in the cache are skipped, so
re-running just fills in gaps. To force re-fetch a prospect, delete their
entry from the JSON.

Run:
    python scripts/4f_fetch_prospect_birthdates.py
"""

import json
import os
import re
import sys
import time
from urllib.parse import quote

import requests

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

SCRIPT_DIR     = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT   = os.path.dirname(SCRIPT_DIR)
DATA_DIR       = os.path.join(PROJECT_ROOT, "data")
PROSPECTS_FILE = os.path.join(DATA_DIR, "prospects_2026.json")
CACHE_FILE     = os.path.join(DATA_DIR, "prospect_birthdates.json")

WIKI_OPENSEARCH = "https://en.wikipedia.org/w/api.php"
WIKI_PARSE      = "https://en.wikipedia.org/w/api.php"
USER_AGENT      = "MaddenDraftClassGenerator/1.0 (https://github.com/BenjaminJones297/madden-draft-class-generator)"

# Wikipedia is generous, but be polite — 250ms between requests.
REQUEST_DELAY_S = 0.25

# Map our canonical Madden positions to Wikipedia disambiguation hints.
# Used to bias search and to verify a candidate page is the right person.
POS_DISAMBIG = {
    "QB":   ["quarterback"],
    "HB":   ["running back"],
    "FB":   ["fullback", "running back"],
    "WR":   ["wide receiver"],
    "TE":   ["tight end"],
    "LT":   ["offensive tackle", "offensive lineman"],
    "RT":   ["offensive tackle", "offensive lineman"],
    "T":    ["offensive tackle", "offensive lineman"],
    "LG":   ["offensive guard", "offensive lineman"],
    "RG":   ["offensive guard", "offensive lineman"],
    "G":    ["offensive guard", "offensive lineman"],
    "C":    ["center", "offensive lineman"],
    "LE":   ["defensive end", "defensive lineman"],
    "RE":   ["defensive end", "defensive lineman"],
    "DE":   ["defensive end", "defensive lineman"],
    "DT":   ["defensive tackle", "defensive lineman"],
    "NT":   ["nose tackle", "defensive lineman"],
    "LOLB": ["linebacker"],
    "ROLB": ["linebacker"],
    "OLB":  ["linebacker"],
    "MLB":  ["linebacker"],
    "ILB":  ["linebacker"],
    "CB":   ["cornerback"],
    "FS":   ["safety"],
    "SS":   ["safety"],
    "S":    ["safety"],
    "K":    ["placekicker", "kicker"],
    "P":    ["punter"],
    "LS":   ["long snapper"],
}

# Title disambiguation suffixes to try, in priority order. Bare name first
# (most prospects' Wikipedia pages aren't yet disambiguated), then the most
# common disambiguators. Position-specific suffix is added per-prospect.
TITLE_SUFFIXES_BASE = [
    "",                    # Bare name — most common for current prospects
    "(American football)", # Common disambiguator
]


def http_get_json(session: requests.Session, url: str, params: dict) -> dict | None:
    try:
        r = session.get(url, params=params, timeout=15)
        if r.status_code != 200:
            return None
        return r.json()
    except Exception:
        return None


def http_get_text(session: requests.Session, url: str, params: dict) -> str | None:
    try:
        r = session.get(url, params=params, timeout=15)
        if r.status_code != 200:
            return None
        return r.text
    except Exception:
        return None


def opensearch_titles(session: requests.Session, query: str, limit: int = 6) -> list[str]:
    """Return a list of Wikipedia titles best-matching the query."""
    data = http_get_json(session, WIKI_OPENSEARCH, {
        "action": "opensearch",
        "search": query,
        "limit":  limit,
        "namespace": 0,
        "format": "json",
    })
    if not data or len(data) < 2:
        return []
    return data[1] or []


def fetch_parsed_html(session: requests.Session, title: str) -> tuple[str | None, str | None]:
    """Return (resolved_title, html). Resolves redirects via the API."""
    data = http_get_json(session, WIKI_PARSE, {
        "action": "parse",
        "page":   title,
        "prop":   "text",
        "redirects": 1,
        "format": "json",
    })
    if not data or "parse" not in data:
        return None, None
    p = data["parse"]
    return p.get("title"), (p.get("text") or {}).get("*")


def looks_like_football_page(html: str, pos_keywords: list[str]) -> bool:
    """Heuristic: page must mention 'football' and a relevant position keyword
    in the first ~6KB. Filters out unrelated namesakes (musicians, mayors)."""
    head = html[:6000].lower()
    if "football" not in head:
        return False
    for kw in pos_keywords:
        if kw in head:
            return True
    # Generic fallback — if the page mentions NFL or college football,
    # accept even without an exact position match (positions get re-named).
    return ("nfl" in head) or ("college football" in head)


def extract_bday(html: str) -> str | None:
    """Pull '<span class="bday">YYYY-MM-DD</span>' from infobox HTML.
    Rejects pre-1996 DOBs (no plausible 30+yo NFL rookie — signals namesake)."""
    m = re.search(r'<span\s+class="bday">(\d{4})-(\d{2})-(\d{2})</span>', html)
    if not m:
        return None
    year = int(m.group(1))
    if year < 1996:
        return None
    return f"{m.group(1)}-{m.group(2)}-{m.group(3)}"


def title_matches_name(title: str, prospect_last: str) -> bool:
    """Resolved Wikipedia title must contain the prospect's last name (case-
    insensitive). Filters out e.g. 'Anthony Johnson' resolving to
    'Chris Johnson (running back)'."""
    if not title or not prospect_last:
        return True   # No verification possible; accept by default.
    return prospect_last.lower() in title.lower()


def resolve_prospect(session: requests.Session, prospect: dict) -> dict | None:
    """Try several strategies to find the prospect's Wikipedia page and DOB.
    Includes prospect.college_class in the result as a fallback age signal."""
    name = prospect.get("name") or f"{prospect.get('firstName','')} {prospect.get('lastName','')}".strip()
    pos  = (prospect.get("pos") or "").upper()
    pos_keywords = POS_DISAMBIG.get(pos, [])
    cls  = prospect.get("college_class")

    # Strategy 1 — direct title with a small set of common disambiguators.
    # Position-specific suffix added per-prospect (e.g. "(quarterback)").
    suffixes = list(TITLE_SUFFIXES_BASE)
    for kw in pos_keywords:
        suffixes.append(f"({kw})")
    for suffix in suffixes:
        title = f"{name} {suffix}".strip()
        time.sleep(REQUEST_DELAY_S)
        resolved, html = fetch_parsed_html(session, title)
        if not html:
            continue
        if not looks_like_football_page(html, pos_keywords):
            continue
        if not title_matches_name(resolved or title, prospect.get("lastName") or ""):
            continue
        bday = extract_bday(html)
        if bday:
            return {"name": name, "dob": bday, "source": "wikipedia", "page_title": resolved or title, "college_class": cls}

    # Strategy 2 — opensearch, then verify each candidate.
    school = prospect.get("school") or ""
    queries = [
        f"{name} {' '.join(pos_keywords[:1])} {school}".strip(),
        f"{name} {' '.join(pos_keywords[:1])} football".strip(),
        f"{name} American football".strip(),
        name,
    ]
    seen_titles = set()
    for q in queries:
        time.sleep(REQUEST_DELAY_S)
        for title in opensearch_titles(session, q):
            if title in seen_titles:
                continue
            seen_titles.add(title)
            time.sleep(REQUEST_DELAY_S)
            resolved, html = fetch_parsed_html(session, title)
            if not html:
                continue
            if not looks_like_football_page(html, pos_keywords):
                continue
            bday = extract_bday(html)
            if bday:
                return {"name": name, "dob": bday, "source": "wikipedia", "page_title": resolved or title, "college_class": cls}

    return None


def load_cache() -> dict:
    if not os.path.exists(CACHE_FILE):
        return {}
    with open(CACHE_FILE, "r", encoding="utf-8") as fh:
        return json.load(fh)


def save_cache(cache: dict) -> None:
    os.makedirs(os.path.dirname(CACHE_FILE), exist_ok=True)
    with open(CACHE_FILE, "w", encoding="utf-8") as fh:
        json.dump(cache, fh, indent=2, sort_keys=True)


def main():
    if not os.path.exists(PROSPECTS_FILE):
        print(f"ERROR: {PROSPECTS_FILE} not found. Run script 4d first.")
        sys.exit(1)

    with open(PROSPECTS_FILE, "r", encoding="utf-8") as fh:
        prospects = json.load(fh)

    cache = load_cache()
    print(f"Loaded {len(prospects)} prospects; {len(cache)} already in cache.")

    session = requests.Session()
    session.headers.update({"User-Agent": USER_AGENT})

    # Process drafted first (priority), then undrafted. Saves cache periodically
    # so a network blip doesn't lose progress.
    drafted   = [p for p in prospects if p.get("actual_draft_pick")]
    undrafted = [p for p in prospects if not p.get("actual_draft_pick")]
    drafted.sort(key=lambda p: (p.get("actual_draft_round") or 99, p.get("actual_draft_pick") or 999))
    ordered = drafted + undrafted

    fetched   = 0
    not_found = 0
    skipped   = 0
    t0        = time.time()

    for i, p in enumerate(ordered, 1):
        nfl_id = p.get("nfl_id") or p.get("name")
        if not nfl_id:
            continue
        if nfl_id in cache and cache[nfl_id].get("dob"):
            skipped += 1
            continue
        result = resolve_prospect(session, p)
        if result:
            cache[nfl_id] = result
            fetched += 1
            print(f"  [{i:>3}/{len(ordered)}] {p.get('name','?'):<28} {p.get('pos','?'):<5} -> {result['dob']}  ({result['page_title']})")
        else:
            cache[nfl_id] = {"name": p.get("name"), "dob": None, "source": "not_found", "college_class": p.get("college_class")}
            not_found += 1
            print(f"  [{i:>3}/{len(ordered)}] {p.get('name','?'):<28} {p.get('pos','?'):<5} -> NOT FOUND")

        # Periodic save (every 25 results) for resilience.
        if (fetched + not_found) % 25 == 0:
            save_cache(cache)

    save_cache(cache)
    elapsed = time.time() - t0
    print()
    print(f"Done in {elapsed:.0f}s.")
    print(f"  Fetched : {fetched}")
    print(f"  Not found: {not_found}")
    print(f"  Skipped (already cached): {skipped}")
    print(f"  Cache file: {CACHE_FILE}")


if __name__ == "__main__":
    main()
