"""
Script 10 — Fetch 2025 NFL Game Results (SportsData.io)

Pulls the full 2025 NFL schedule + final scores from SportsData.io and writes
a JSON file in the format expected by scripts/11_apply_game_results.js.

Requires SPORTSDATA_API_KEY in .env (the SchedulesBasic endpoint is on the
free tier).

Output:
  data/game_results_2025.json — list of completed game objects:
  {
    "season":     2025,
    "week":       1,            // 1-18 regular, 19-22 playoffs
    "game_type":  "REG",        // REG | WC | DIV | CON | SB
    "home_team":  "ARI",        // nflverse-style abbreviation
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
import time

import requests
from dotenv import load_dotenv

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------
SCRIPT_DIR   = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(SCRIPT_DIR)
DATA_DIR     = os.path.join(PROJECT_ROOT, "data")
OUTPUT_FILE  = os.path.join(DATA_DIR, "game_results_2025.json")

load_dotenv(os.path.join(PROJECT_ROOT, ".env"))

# ---------------------------------------------------------------------------
# SportsData.io
# ---------------------------------------------------------------------------
SEASON_YEAR = 2025
API_KEY     = os.getenv("SPORTSDATA_API_KEY")
BASE_URL    = "https://api.sportsdata.io/v3/nfl/scores/json/Scores"
FINAL_STATUSES = {"Final", "F/OT"}

# Postseason round (Week field, 1-4) → game_type + nflverse-style absolute week
POSTSEASON = {
    1: ("WC",  19),
    2: ("DIV", 20),
    3: ("CON", 21),
    4: ("SB",  22),
}

# SportsData.io abbreviations → nflverse abbreviations (only deltas)
# nflverse uses "LA" for the Rams; SportsData.io uses "LAR".
SPORTSDATA_TO_NFLVERSE = {
    "LAR": "LA",
}


def require_api_key() -> None:
    if not API_KEY:
        print("[!] No SPORTSDATA_API_KEY found.")
        print("  Add it to your .env file:")
        print("    SPORTSDATA_API_KEY=your_key_here")
        sys.exit(1)


def fetch_schedule(season_label: str, retries: int = 3) -> list[dict]:
    """Fetch a Scores response for e.g. '2025REG' or '2025POST'."""
    base = f"{BASE_URL}/{season_label}"
    url  = f"{base}?key={API_KEY}"
    for attempt in range(1, retries + 1):
        try:
            print(f"  Fetching: {base}")
            resp = requests.get(url, timeout=30)
            resp.raise_for_status()
            return resp.json()
        except requests.RequestException as exc:
            print(f"  Attempt {attempt}/{retries} failed: {exc}")
            if attempt < retries:
                time.sleep(2)
    raise RuntimeError(f"Failed to fetch {base} after {retries} attempts")


def to_nflverse_team(abbr: str) -> str:
    return SPORTSDATA_TO_NFLVERSE.get(abbr, abbr)


def process_rows(rows: list[dict], is_postseason: bool) -> tuple[list[dict], int, int]:
    """Returns (games, unfinished_count, other_skipped_count)."""
    games: list[dict] = []
    unfinished = 0
    other_skipped = 0

    for row in rows:
        week_raw   = row.get("Week")
        home_abbr  = (row.get("HomeTeam") or "").strip().upper()
        away_abbr  = (row.get("AwayTeam") or "").strip().upper()
        home_score = row.get("HomeScore")
        away_score = row.get("AwayScore")
        status     = (row.get("Status") or "").strip()

        if not home_abbr or not away_abbr or week_raw is None:
            other_skipped += 1
            continue

        if home_score is None or away_score is None or status not in FINAL_STATUSES:
            unfinished += 1
            continue

        if is_postseason:
            mapping = POSTSEASON.get(int(week_raw))
            if not mapping:
                other_skipped += 1
                continue
            game_type, nfl_week = mapping
        else:
            game_type = "REG"
            nfl_week  = int(week_raw)

        games.append({
            "season":     SEASON_YEAR,
            "week":       nfl_week,
            "game_type":  game_type,
            "home_team":  to_nflverse_team(home_abbr),
            "away_team":  to_nflverse_team(away_abbr),
            "home_score": int(home_score),
            "away_score": int(away_score),
            "home_won":   int(home_score) > int(away_score),
        })

    return games, unfinished, other_skipped


def dedupe(games: list[dict]) -> tuple[list[dict], int]:
    """Collapse rescheduled duplicates — same matchup in same week appears
    once. Last occurrence wins (typically the played/rescheduled record)."""
    seen: dict[tuple, dict] = {}
    duplicates = 0
    for g in games:
        key = (g["game_type"], g["week"], g["home_team"], g["away_team"])
        if key in seen:
            duplicates += 1
        seen[key] = g
    return list(seen.values()), duplicates


def main() -> None:
    print("=" * 60)
    print(f"Script 10 - Fetch {SEASON_YEAR} NFL Game Results (SportsData.io)")
    print("=" * 60)

    require_api_key()

    reg_rows  = fetch_schedule(f"{SEASON_YEAR}REG")
    post_rows = fetch_schedule(f"{SEASON_YEAR}POST")
    print(f"  Regular-season records : {len(reg_rows):,}")
    print(f"  Postseason records     : {len(post_rows):,}")

    reg_games,  reg_unfin,  reg_other  = process_rows(reg_rows,  is_postseason=False)
    post_games, post_unfin, post_other = process_rows(post_rows, is_postseason=True)

    games, dup_count = dedupe(reg_games + post_games)
    games.sort(key=lambda g: (g["week"], g["home_team"]))

    os.makedirs(DATA_DIR, exist_ok=True)
    with open(OUTPUT_FILE, "w", encoding="utf-8") as fh:
        json.dump(games, fh, indent=2)

    by_type: dict[str, int] = {}
    for g in games:
        by_type[g["game_type"]] = by_type.get(g["game_type"], 0) + 1

    print("\n" + "=" * 60)
    print("Summary")
    print("=" * 60)
    print(f"  Total completed games : {len(games)}")
    for gtype in ["REG", "WC", "DIV", "CON", "SB"]:
        if gtype in by_type:
            print(f"    {gtype:<5}: {by_type[gtype]}")
    print(f"  Unfinished skipped    : {reg_unfin + post_unfin}")
    print(f"  Reschedule duplicates : {dup_count}")
    other = reg_other + post_other
    if other:
        print(f"  Other skipped         : {other}")
    print(f"\n  Output -> {os.path.relpath(OUTPUT_FILE, PROJECT_ROOT)}")
    print("\nDone.")


if __name__ == "__main__":
    main()
