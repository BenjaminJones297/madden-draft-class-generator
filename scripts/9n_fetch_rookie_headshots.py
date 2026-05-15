"""
Script 9n — Fetch headshots for 2026 rookies via ESPN CDN.

Inputs  : data/rookie_ratings_post_fix.json  (265 rookies)
          nflverse players.csv               (espn_id lookup, fetched on demand)
Outputs : data/raw/headshots/{first}_{last}.png         (one PNG per rookie)
          data/raw/headshot_manifest.json               (status per rookie)

URL ladder per rookie:
  1. nflverse players.csv → espn_id → /i/headshots/nfl/players/full/{id}.png
  2. on 404, retry under /i/headshots/college-football/players/full/{id}.png
  3. for prospects with no espn_id in nflverse, hit ESPN search API
     site.web.api.espn.com/apis/common/v3/search and use items[0].id

Run:
  python scripts/9n_fetch_rookie_headshots.py [--force]
  python scripts/9n_fetch_rookie_headshots.py --input <path> [--out-dir <dir>]
"""

from __future__ import annotations

import argparse
import csv
import io
import json
import os
import re
import sys
import time
from typing import Optional

import requests

SCRIPT_DIR   = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(SCRIPT_DIR)
DATA_DIR     = os.path.join(PROJECT_ROOT, "data")

DEFAULT_INPUT     = os.path.join(DATA_DIR, "rookie_ratings_post_fix.json")
DEFAULT_OUT_DIR   = os.path.join(DATA_DIR, "raw", "headshots")
DEFAULT_MANIFEST  = os.path.join(DATA_DIR, "raw", "headshot_manifest.json")

NFLVERSE_PLAYERS_CSV = (
    "https://github.com/nflverse/nflverse-data/releases/download/players/players.csv"
)
ESPN_CDN_NFL    = "https://a.espncdn.com/i/headshots/nfl/players/full/{id}.png"
ESPN_CDN_CFB    = "https://a.espncdn.com/i/headshots/college-football/players/full/{id}.png"
ESPN_SEARCH_API = "https://site.web.api.espn.com/apis/common/v3/search"

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    ),
}
REQUEST_TIMEOUT  = 30
THROTTLE_SECONDS = 0.20

# Heuristic — discard responses smaller than this. ESPN serves a 1-byte placeholder
# on cache-miss for unknown players, real headshots are >> 50 KB.
MIN_VALID_BYTES = 10_000


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def norm_name(name: str) -> str:
    return re.sub(r"[^a-z]", "", (name or "").lower().strip())


def safe_filename(first: str, last: str) -> str:
    base = f"{first}_{last}".lower()
    return re.sub(r"[^a-z0-9_]", "", base) + ".png"


def get(url: str, *, expect_binary: bool = False) -> Optional[bytes]:
    """GET with retry-once on 5xx + throttle. Returns body on 200, else None."""
    for attempt in range(2):
        try:
            resp = requests.get(url, headers=HEADERS, timeout=REQUEST_TIMEOUT, stream=expect_binary)
            if resp.status_code == 200:
                return resp.content
            if 500 <= resp.status_code < 600 and attempt == 0:
                time.sleep(0.5)
                continue
            return None
        except Exception:
            if attempt == 0:
                time.sleep(0.5)
                continue
            return None
        finally:
            time.sleep(THROTTLE_SECONDS)
    return None


# ---------------------------------------------------------------------------
# nflverse players.csv → {norm(first, last): espn_id} for 2026 rookies
# ---------------------------------------------------------------------------

def fetch_nflverse_lookup() -> dict[str, str]:
    print(f"\n→ Fetching nflverse players.csv …")
    raw = get(NFLVERSE_PLAYERS_CSV)
    if not raw:
        print("  ERROR: nflverse players.csv unreachable — espn_id fallback only.")
        return {}
    rows = list(csv.DictReader(io.StringIO(raw.decode("utf-8", errors="replace"))))
    print(f"  Parsed {len(rows):,} player rows")

    # We want any row matching a 2026 rookie name. Filter for rookie_season 2026
    # to disambiguate duplicates like "David Bailey".
    lookup: dict[str, str] = {}
    matched_2026 = 0
    for r in rows:
        first = (r.get("first_name") or "").strip()
        last  = (r.get("last_name")  or "").strip()
        if not first or not last:
            full = (r.get("full_name") or r.get("display_name") or "").strip()
            if not full:
                continue
            parts = full.split()
            if len(parts) < 2:
                continue
            first, last = parts[0], " ".join(parts[1:])
        espn_id = (r.get("espn_id") or "").strip()
        if not espn_id:
            continue
        key = norm_name(first + last)
        # Prefer 2026 rookies on collision; otherwise first-seen wins.
        rookie_season = (r.get("rookie_season") or "").strip()
        if rookie_season == "2026":
            lookup[key] = espn_id
            matched_2026 += 1
        elif key not in lookup:
            lookup[key] = espn_id
    print(f"  espn_id entries: {len(lookup):,}  (2026 rookies: {matched_2026:,})")
    return lookup


# ---------------------------------------------------------------------------
# ESPN search API for prospects without espn_id in nflverse
# ---------------------------------------------------------------------------

def search_espn_id(first: str, last: str) -> Optional[str]:
    full = f"{first} {last}".strip()
    url  = f"{ESPN_SEARCH_API}?query={requests.utils.quote(full)}&limit=5&type=player"
    body = get(url)
    if not body:
        return None
    try:
        j = json.loads(body)
    except Exception:
        return None
    # API shape: {results: [{contents: [{...id, name}], ...}, ...]} OR {items: [...]}
    candidates: list[dict] = []
    for top in (j.get("results") or []):
        for c in (top.get("contents") or []):
            candidates.append(c)
    for c in (j.get("items") or []):
        candidates.append(c)
    target = norm_name(full)
    for c in candidates:
        cid  = str(c.get("id") or "").strip()
        name = (c.get("displayName") or c.get("name") or "").strip()
        if not cid:
            continue
        if norm_name(name) == target:
            return cid
    # No exact match — return the first non-empty id as a best-effort hint
    for c in candidates:
        cid = str(c.get("id") or "").strip()
        if cid:
            return cid
    return None


# ---------------------------------------------------------------------------
# Download a single rookie's headshot
# ---------------------------------------------------------------------------

def download_headshot(espn_id: str, out_path: str) -> tuple[Optional[str], int]:
    """Try NFL CDN first, then college-football. Returns (source_tag, bytes)."""
    for source_tag, template in (("nfl", ESPN_CDN_NFL), ("cfb", ESPN_CDN_CFB)):
        body = get(template.format(id=espn_id), expect_binary=True)
        if body and len(body) >= MIN_VALID_BYTES:
            with open(out_path, "wb") as fh:
                fh.write(body)
            return source_tag, len(body)
    return None, 0


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> None:
    # Windows default stdout is cp1252 which can't encode the unicode arrow
    # used in progress messages. Force UTF-8 with replacement.
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

    ap = argparse.ArgumentParser()
    ap.add_argument("--input",   default=DEFAULT_INPUT,    help="Path to rookies JSON")
    ap.add_argument("--out-dir", default=DEFAULT_OUT_DIR,  help="Headshot cache dir")
    ap.add_argument("--manifest",default=DEFAULT_MANIFEST, help="Manifest JSON output")
    ap.add_argument("--force",   action="store_true",      help="Re-download cached photos")
    args = ap.parse_args()

    os.makedirs(args.out_dir, exist_ok=True)
    os.makedirs(os.path.dirname(args.manifest), exist_ok=True)

    print("=" * 64)
    print("Script 9n — fetch rookie headshots")
    print("=" * 64)
    print(f"  Input    : {args.input}")
    print(f"  Out dir  : {args.out_dir}")
    print(f"  Manifest : {args.manifest}")
    print(f"  Force    : {args.force}")

    with open(args.input, "r", encoding="utf-8") as fh:
        rookies = json.load(fh)
    print(f"  Rookies  : {len(rookies):,}")

    nflverse = fetch_nflverse_lookup()

    manifest: list[dict] = []
    counts = {"cached": 0, "from_nflverse": 0, "from_search": 0,
              "no_espn_id": 0, "download_failed": 0, "ok": 0}

    for i, p in enumerate(rookies, 1):
        first = (p.get("firstName") or "").strip()
        last  = (p.get("lastName")  or "").strip()
        if not first or not last:
            continue
        key   = norm_name(first + last)
        fname = safe_filename(first, last)
        out   = os.path.join(args.out_dir, fname)

        if os.path.exists(out) and not args.force and os.path.getsize(out) >= MIN_VALID_BYTES:
            counts["cached"] += 1
            counts["ok"]     += 1
            manifest.append({
                "firstName": first, "lastName": last, "espnId": None,
                "url": None, "status": "cached", "bytes": os.path.getsize(out),
                "source": "cache", "file": fname,
            })
            print(f"  [{i:3d}/{len(rookies)}] {first} {last}: cached")
            continue

        # Resolve espn_id
        espn_id = nflverse.get(key)
        source  = "nflverse"
        if not espn_id:
            espn_id = search_espn_id(first, last)
            source  = "search"
        if not espn_id:
            counts["no_espn_id"] += 1
            print(f"  [{i:3d}/{len(rookies)}] {first} {last}: NO espn_id")
            manifest.append({
                "firstName": first, "lastName": last, "espnId": None,
                "url": None, "status": "no_espn_id", "bytes": 0,
                "source": source, "file": None,
            })
            continue

        counts["from_nflverse" if source == "nflverse" else "from_search"] += 1

        cdn_source, bytes_ = download_headshot(espn_id, out)
        if cdn_source is None:
            counts["download_failed"] += 1
            print(f"  [{i:3d}/{len(rookies)}] {first} {last}: espn_id={espn_id} FAILED both CDNs")
            manifest.append({
                "firstName": first, "lastName": last, "espnId": espn_id,
                "url": ESPN_CDN_NFL.format(id=espn_id),
                "status": "download_failed", "bytes": 0,
                "source": source, "file": None,
            })
            continue

        counts["ok"] += 1
        used_url = (ESPN_CDN_NFL if cdn_source == "nfl" else ESPN_CDN_CFB).format(id=espn_id)
        print(f"  [{i:3d}/{len(rookies)}] {first} {last}: espn_id={espn_id} src={cdn_source} {bytes_:,}B")
        manifest.append({
            "firstName": first, "lastName": last, "espnId": espn_id,
            "url": used_url, "status": "ok", "bytes": bytes_,
            "source": source, "cdnPath": cdn_source, "file": fname,
        })

    with open(args.manifest, "w", encoding="utf-8") as fh:
        json.dump(manifest, fh, indent=2)

    print()
    print("=" * 64)
    print(f"  OK              : {counts['ok']:>4}")
    print(f"    cached        : {counts['cached']:>4}")
    print(f"    from nflverse : {counts['from_nflverse']:>4}")
    print(f"    from search   : {counts['from_search']:>4}")
    print(f"  No espn_id      : {counts['no_espn_id']:>4}")
    print(f"  Download failed : {counts['download_failed']:>4}")
    print(f"\nManifest: {args.manifest}")


if __name__ == "__main__":
    sys.exit(main() or 0)
