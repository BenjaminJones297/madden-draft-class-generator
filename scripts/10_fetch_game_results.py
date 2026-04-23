"""
Script 10 — Fetch 2025 NFL Game Results

Downloads the nflverse schedules CSV and extracts completed game results for
the 2025 NFL season (regular season + playoffs).

Output:
  data/game_results_2025.json  — list of completed game objects:
  {
    "season":     2025,
    "week":       1,            // NFL week (1-18 regular, 19+ playoffs)
    "game_type":  "REG",        // REG | WC | DIV | CON | SB
    "home_team":  "ARI",        // nflverse team abbreviation
    "away_team":  "ATL",
    "home_score": 27,
    "away_score": 14,
    "home_won":   true
  }

Run:
  python scripts/10_fetch_game_results.py
"""

import json
import os
import sys
import io
import csv
import time

import requests

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------
SCRIPT_DIR   = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(SCRIPT_DIR)
DATA_DIR     = os.path.join(PROJECT_ROOT, "data")
OUTPUT_FILE  = os.path.join(DATA_DIR, "game_results_2025.json")

# ---------------------------------------------------------------------------
# nflverse schedules URL
# ---------------------------------------------------------------------------
SCHEDULES_URL = (
    "https://github.com/nflverse/nflverse-data/releases/download/"
    "schedules/schedules.csv"
)

SEASON_YEAR = 2025

# nflverse game_type values we want
VALID_GAME_TYPES = {"REG", "WC", "DIV", "CON", "SB"}


def download_csv(url: str, retries: int = 3) -> list[dict]:
    """Download a CSV from url and return rows as list of dicts."""
    for attempt in range(1, retries + 1):
        try:
            print(f"  Downloading: {url}")
            resp = requests.get(url, timeout=60)
            resp.raise_for_status()
            reader = csv.DictReader(io.StringIO(resp.text))
            return list(reader)
        except requests.RequestException as exc:
            print(f"  Attempt {attempt}/{retries} failed: {exc}")
            if attempt < retries:
                time.sleep(2)
    raise RuntimeError(f"Failed to download {url} after {retries} attempts")


def safe_int(val: str) -> int | None:
    """Convert string to int, return None if not possible."""
    try:
        return int(float(val))
    except (ValueError, TypeError):
        return None


def main() -> None:
    print("=" * 60)
    print("Script 10 — Fetch 2025 NFL Game Results")
    print("=" * 60)

    # ── Download schedules ────────────────────────────────────────────────
    rows = download_csv(SCHEDULES_URL)
    print(f"  Total rows downloaded: {len(rows):,}")

    # ── Filter for 2025 season ────────────────────────────────────────────
    games: list[dict] = []
    skipped = 0

    for row in rows:
        try:
            season = safe_int(row.get("season", ""))
            if season != SEASON_YEAR:
                continue

            game_type = row.get("game_type", "").strip().upper()
            if game_type not in VALID_GAME_TYPES:
                skipped += 1
                continue

            week_val = safe_int(row.get("week", ""))
            if week_val is None:
                skipped += 1
                continue

            home_team  = row.get("home_team", "").strip().upper()
            away_team  = row.get("away_team", "").strip().upper()
            home_score = safe_int(row.get("home_score", ""))
            away_score = safe_int(row.get("away_score", ""))

            # Skip games that haven't been played yet (no scores)
            if home_score is None or away_score is None:
                skipped += 1
                continue

            if not home_team or not away_team:
                skipped += 1
                continue

            games.append({
                "season":     season,
                "week":       week_val,
                "game_type":  game_type,
                "home_team":  home_team,
                "away_team":  away_team,
                "home_score": home_score,
                "away_score": away_score,
                "home_won":   home_score > away_score,
            })
        except Exception as exc:
            skipped += 1
            print(f"  ⚠  Skipped row: {exc}", file=sys.stderr)

    # ── Sort games by week, then home team ───────────────────────────────
    games.sort(key=lambda g: (g["week"], g["home_team"]))

    # ── Save ─────────────────────────────────────────────────────────────
    os.makedirs(DATA_DIR, exist_ok=True)
    with open(OUTPUT_FILE, "w", encoding="utf-8") as fh:
        json.dump(games, fh, indent=2)

    # ── Summary ──────────────────────────────────────────────────────────
    print("\n" + "=" * 60)
    print("Summary")
    print("=" * 60)
    by_type: dict[str, int] = {}
    for g in games:
        by_type[g["game_type"]] = by_type.get(g["game_type"], 0) + 1

    print(f"  Total completed games : {len(games)}")
    for gtype in ["REG", "WC", "DIV", "CON", "SB"]:
        if gtype in by_type:
            print(f"    {gtype:<5}: {by_type[gtype]}")
    print(f"  Skipped/future        : {skipped}")
    print(f"\n  Output → {os.path.relpath(OUTPUT_FILE, PROJECT_ROOT)}")
    print("\n✓ Done.")


if __name__ == "__main__":
    main()
