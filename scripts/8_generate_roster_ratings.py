"""
Script 8 — Build Madden 26 roster using official ratings + real contract data.

Reads:
  data/current_player_ratings_full.json  — official Madden 26 player ratings
      extracted from the user's .ros file by script 3 (node scripts/3_extract_roster_ratings.js).
  data/nfl_rosters_2026.json             — current active NFL roster + contract data
      fetched from nflverse by script 7.

For every active NFL player:
  - Looks up the player's official Madden ratings by name match.
  - Uses those ratings EXACTLY as they appear in the official Madden roster.
  - Adds real-world contract information (AAV, total value, years) from nflverse/OTC.
  - Falls back to position defaults ONLY for players not present in the Madden file
    (e.g. UDFA signings, IR players added after the last roster update).

Output:
  data/roster_players_rated.json

Run:
  python scripts/8_generate_roster_ratings.py
  (Requires script 3 to have been run first with a valid .ros file.)
"""

import json
import os
import re
import sys
from collections import Counter

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------
SCRIPT_DIR   = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(SCRIPT_DIR)
DATA_DIR     = os.path.join(PROJECT_ROOT, "data")

sys.path.insert(0, PROJECT_ROOT)
from utils.defaults import get_defaults
from utils.enums import ALL_RATING_FIELDS

ROSTER_FILE          = os.path.join(DATA_DIR, "nfl_rosters_2026.json")
MADDEN_RATINGS_FILE  = os.path.join(DATA_DIR, "current_player_ratings_full.json")
OUTPUT_FILE          = os.path.join(DATA_DIR, "roster_players_rated.json")


# ---------------------------------------------------------------------------
# Name normalisation helpers for fuzzy matching
# ---------------------------------------------------------------------------

def _norm(name: str) -> str:
    """Lower-case, strip punctuation, collapse spaces."""
    return re.sub(r"[^a-z0-9 ]", "", name.lower()).strip()


def build_name_lookup(madden_ratings: dict) -> dict:
    """
    Build a lookup dict from normalised player name -> Madden rating object.
    Creates multiple keys per player to handle common name variations:
      - Exact lowercase key (stored natively)
      - Normalised key (strips punctuation / extra spaces)
      - Last-name-first swap  ("Allen Josh" -> "josh allen")
    """
    lookup: dict = {}
    for raw_name, obj in madden_ratings.items():
        norm = _norm(raw_name)
        lookup[raw_name.lower()] = obj  # exact lowercase
        lookup[norm] = obj              # normalised
    return lookup


def find_madden_ratings(player_name: str, lookup: dict) -> dict | None:
    """
    Try to find official Madden ratings for *player_name* in *lookup*.
    Attempts:
      1. Exact lowercase match
      2. Normalised match (strips punctuation)
      3. Last-name-first swap  ("C.J. Stroud" -> "cj stroud")
    Returns the ratings dict, or None if no match found.
    """
    # 1. Exact lowercase
    candidate = player_name.lower()
    if candidate in lookup:
        return lookup[candidate]

    # 2. Normalised
    norm = _norm(player_name)
    if norm in lookup:
        return lookup[norm]

    # 3. Handle suffix (Jr., Sr., III …)
    clean = re.sub(r"\b(jr|sr|ii|iii|iv|v)\.?$", "", norm).strip()
    if clean and clean in lookup:
        return lookup[clean]

    return None


# ---------------------------------------------------------------------------
# Contract helpers
# ---------------------------------------------------------------------------

def map_contract_fields(player: dict) -> dict:
    """
    Convert real-world contract values to Madden contract field equivalents.
    """
    aav        = player.get("aav", 0) or 0
    total      = player.get("total_contract_value", 0) or 0
    guaranteed = player.get("guaranteed", 0) or 0
    years      = int(player.get("contract_years", 0) or 0)

    if years <= 0:
        years = 1

    # Approximate years remaining (heuristic: assume deal was signed ~2 yrs ago)
    years_left = max(1, years - min(years - 1, 2))

    # Signing bonus ~ 50 % of guaranteed
    signing_bonus = int(guaranteed * 0.5) if guaranteed else 0

    # Base salary for current year
    pro_rated_bonus = signing_bonus // max(years, 1)
    base_salary = int(max(800_000, aav - pro_rated_bonus))

    return {
        "contractLength":    years,
        "contractYearsLeft": years_left,
        "contractBonus":     signing_bonus,
        "contractSalary":    base_salary,
    }


# ---------------------------------------------------------------------------
# Fallback ratings (used only when player is not in the Madden file)
# ---------------------------------------------------------------------------

def fallback_ratings(pos: str) -> dict:
    """Return position defaults for a player not found in the Madden file."""
    return dict(get_defaults(pos))


# ---------------------------------------------------------------------------
# Build one rated player record
# ---------------------------------------------------------------------------

def build_rated_player(player: dict, madden_obj: dict | None) -> dict:
    """
    Combine an nflverse roster player with (optionally) their official Madden ratings.

    If *madden_obj* is None the player was not found in the Madden file; position
    defaults are used instead and a 'ratingsSource' flag is set to 'fallback'.
    """
    pos        = player.get("position", "QB")
    experience = int(player.get("experience", 0) or 0)

    # ── Ratings ─────────────────────────────────────────────────────────────
    if madden_obj is not None:
        # Official Madden ratings — use as-is, fill any missing fields from defaults
        defaults = get_defaults(pos)
        ratings: dict = {}
        for field in ALL_RATING_FIELDS:
            if field in madden_obj:
                ratings[field] = madden_obj[field]
            else:
                ratings[field] = defaults.get(field, 0)
        ratings_source = "madden"
    else:
        ratings = fallback_ratings(pos)
        ratings_source = "fallback"

    # ── Contract fields ──────────────────────────────────────────────────────
    contract_fields = map_contract_fields(player)

    # ── Name fields ──────────────────────────────────────────────────────────
    first_name = player.get("first_name", "").strip()
    last_name  = player.get("last_name", "").strip()
    if not first_name and not last_name:
        parts      = player.get("player_name", "").split()
        first_name = parts[0] if parts else ""
        last_name  = " ".join(parts[1:]) if len(parts) > 1 else ""

    aav = player.get("aav", 0) or 0

    return {
        "firstName":          first_name,
        "lastName":           last_name,
        "playerName":         player.get("player_name", ""),
        "team":               player.get("team", ""),
        "pos":                pos,
        "jerseyNumber":       int(player.get("jersey_number", 0) or 0),
        "status":             player.get("status", ""),
        "birthDate":          player.get("birth_date", ""),
        "ht":                 player.get("height", ""),
        "wt":                 int(player.get("weight", 0) or 0),
        "college":            player.get("college", ""),
        "experience":         experience,
        "season":             player.get("season", ""),
        # Real-world contract data
        "aav":                aav,
        "totalContractValue": player.get("total_contract_value", 0) or 0,
        "guaranteed":         player.get("guaranteed", 0) or 0,
        # Madden contract fields
        **contract_fields,
        # Official Madden ratings (or fallback)
        "ratingsSource":      ratings_source,
        "ratings":            ratings,
    }


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> None:
    print("=" * 60)
    print("Script 8 — Build roster with official Madden ratings")
    print("=" * 60)

    # ── Load inputs ──────────────────────────────────────────────────────────
    if not os.path.isfile(ROSTER_FILE):
        print(f"\n✗ Roster file not found: {ROSTER_FILE}", file=sys.stderr)
        print("  Run script 7 first: python scripts/7_fetch_nfl_roster_and_contracts.py")
        sys.exit(1)

    with open(ROSTER_FILE, encoding="utf-8") as fh:
        roster_players = json.load(fh)

    if not os.path.isfile(MADDEN_RATINGS_FILE):
        print(f"  ⚠  Madden ratings file not found: {MADDEN_RATINGS_FILE}")
        print("  Continuing with position-default ratings for all players.")
        print("  Tip: run step 3 with a .ros file for official Madden ratings.")
        madden_ratings_raw = {}
    else:
        with open(MADDEN_RATINGS_FILE, encoding="utf-8") as fh:
            madden_ratings_raw = json.load(fh)

    print(f"\n  Roster players : {len(roster_players):,}")
    print(f"  Madden ratings : {len(madden_ratings_raw):,} players in file")

    # ── Build name lookup ─────────────────────────────────────────────────────
    lookup = build_name_lookup(madden_ratings_raw)

    # ── Rate every player ─────────────────────────────────────────────────────
    rated:      list = []
    matched:    int  = 0
    fallbacks:  int  = 0
    unmatched_names: list = []

    for player in roster_players:
        try:
            name       = player.get("player_name", "")
            madden_obj = find_madden_ratings(name, lookup)

            if madden_obj is not None:
                matched += 1
            else:
                fallbacks += 1
                unmatched_names.append(
                    f"  {name} ({player.get('position', '?')}, {player.get('team', '?')})"
                )

            rated.append(build_rated_player(player, madden_obj))
        except Exception as exc:
            n = player.get("player_name", "?")
            print(f"  ⚠  Skipped {n}: {exc}", file=sys.stderr)

    # ── Sort: team → position → overall descending ────────────────────────────
    rated.sort(key=lambda p: (
        p.get("team", ""),
        p.get("pos", ""),
        -(p["ratings"].get("overall", 0)),
    ))

    # ── Save output ───────────────────────────────────────────────────────────
    os.makedirs(os.path.dirname(OUTPUT_FILE) if os.path.dirname(OUTPUT_FILE) else DATA_DIR,
                exist_ok=True)
    with open(OUTPUT_FILE, "w", encoding="utf-8") as fh:
        json.dump(rated, fh, indent=2)

    # ── Print summary ─────────────────────────────────────────────────────────
    print("\n" + "=" * 60)
    print("Summary")
    print("=" * 60)
    print(f"  Total players processed : {len(rated):,}")
    print(f"  Official Madden ratings : {matched:,} (exact match from .ros file)")
    print(f"  Fallback (pos defaults) : {fallbacks:,} (not found in Madden file)")

    if unmatched_names:
        print(f"\n  Players using fallback ratings ({len(unmatched_names)}):")
        for line in unmatched_names[:30]:
            print(line)
        if len(unmatched_names) > 30:
            print(f"  … and {len(unmatched_names) - 30} more")

    # Per-position rating overview (from Madden-sourced players only)
    ovr_by_pos: dict = {}
    for p in rated:
        if p["ratingsSource"] == "madden":
            pos = p["pos"]
            ovr = p["ratings"].get("overall", 0)
            ovr_by_pos.setdefault(pos, []).append(ovr)

    if ovr_by_pos:
        print("\n  Official-rating overview by position (Madden-sourced only):")
        for pos in sorted(ovr_by_pos):
            ovrs = ovr_by_pos[pos]
            avg  = sum(ovrs) / len(ovrs)
            top  = max(ovrs)
            print(f"    {pos:<4}  n={len(ovrs):<4}  avg={avg:5.1f}  top={top}")

    print(f"\n  Output → {os.path.relpath(OUTPUT_FILE, PROJECT_ROOT)}")
    print("\n✓ Done.")


if __name__ == "__main__":
    main()
