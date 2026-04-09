"""
Script 8 — Generate deterministic Madden 26 ratings for current NFL roster players.

For each player in data/nfl_rosters_2026.json, computes Madden-style attribute ratings
using a fully deterministic algorithm (no LLM required):

  1. Overall rating  — calibrated from contract AAV using a position-aware log curve.
     Players with no contract data are rated from position defaults + experience.
  2. Position-key attributes — scaled proportionally around position defaults.
  3. Non-position attributes — kept at position defaults.
  4. Dev trait — determined by overall rating tier.
  5. Contract fields — mapped to Madden format (cap hit, years left, etc.).

Output:
  data/roster_players_rated.json

Run:
  python scripts/8_generate_roster_ratings.py
"""

import json
import math
import os
import sys
from collections import Counter

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(SCRIPT_DIR)
DATA_DIR = os.path.join(PROJECT_ROOT, "data")

sys.path.insert(0, PROJECT_ROOT)
from utils.defaults import get_defaults
from utils.enums import POSITION_KEY_FIELDS, ALL_RATING_FIELDS

INPUT_FILE  = os.path.join(DATA_DIR, "nfl_rosters_2026.json")
OUTPUT_FILE = os.path.join(DATA_DIR, "roster_players_rated.json")

# ---------------------------------------------------------------------------
# Per-position salary benchmarks (2025-26 NFL market values in USD)
# Format: (min_rookie_aav, top_starter_aav, elite_aav)
#   min_rookie_aav   -> ~58 OVR  (practice-squad / UDFA)
#   top_starter_aav  -> ~88 OVR  (Pro Bowl starter)
#   elite_aav        -> ~97 OVR  (top 3 in NFL at position)
# ---------------------------------------------------------------------------
POSITION_SALARY_BENCHMARKS: dict = {
    "QB":  (  800_000,  35_000_000,  65_000_000),
    "HB":  (  800_000,   8_000_000,  18_000_000),
    "FB":  (  800_000,   2_000_000,   5_000_000),
    "WR":  (  800_000,  15_000_000,  35_000_000),
    "TE":  (  800_000,  12_000_000,  25_000_000),
    "T":   (  800_000,  14_000_000,  28_000_000),
    "G":   (  800_000,  12_000_000,  22_000_000),
    "C":   (  800_000,  10_000_000,  20_000_000),
    "DE":  (  800_000,  18_000_000,  32_000_000),
    "DT":  (  800_000,  12_000_000,  24_000_000),
    "OLB": (  800_000,  16_000_000,  30_000_000),
    "MLB": (  800_000,  12_000_000,  22_000_000),
    "CB":  (  800_000,  14_000_000,  28_000_000),
    "FS":  (  800_000,  10_000_000,  20_000_000),
    "SS":  (  800_000,  10_000_000,  20_000_000),
    "K":   (  800_000,   2_500_000,   7_000_000),
    "P":   (  800_000,   2_000_000,   5_500_000),
    "LS":  (  800_000,   1_200_000,   3_000_000),
}

# Fields that are always fixed (never scaled with overall)
FIXED_FIELDS: set = {
    "kickReturn", "stamina", "toughness", "injury", "morale",
    "personality", "devTrait", "unkRating1",
}

# Fields eligible for scaling when they are key fields for the position
SCALABLE_FIELDS: set = {
    "speed", "acceleration", "agility", "strength", "awareness",
    "throwPower", "throwAccuracy", "throwAccuracyShort", "throwAccuracyMid",
    "throwAccuracyDeep", "throwOnTheRun", "throwUnderPressure", "playAction",
    "breakSack", "tackle", "hitPower", "blockShedding", "finesseMoves",
    "powerMoves", "pursuit", "zoneCoverage", "manCoverage", "pressCoverage",
    "playRecognition", "jumping", "catching", "catchInTraffic", "spectacularCatch",
    "shortRouteRunning", "mediumRouteRunning", "deepRouteRunning", "release",
    "runBlock", "passBlock", "runBlockPower", "runBlockFinesse",
    "passBlockPower", "passBlockFinesse", "impactBlocking", "leadBlock",
    "jukeMove", "spinMove", "stiffArm", "trucking", "breakTackle",
    "ballCarrierVision", "changeOfDirection", "carrying",
    "kickPower", "kickAccuracy",
}


# ---------------------------------------------------------------------------
# Deterministic rating algorithms
# ---------------------------------------------------------------------------

def aav_to_overall(aav: float, pos: str) -> int:
    """
    Map a contract AAV (average annual value in USD) to a Madden overall rating
    using a logarithmic curve calibrated per position.

    Returns an integer in [55, 99].
    """
    benchmarks = POSITION_SALARY_BENCHMARKS.get(pos, POSITION_SALARY_BENCHMARKS["QB"])
    min_aav, _starter_aav, elite_aav = benchmarks

    aav = max(min_aav * 0.5, min(aav, elite_aav * 1.5))

    log_min   = math.log(max(min_aav, 1))
    log_elite = math.log(max(elite_aav, 1))
    log_aav   = math.log(max(aav, 1))

    t = (log_aav - log_min) / max(log_elite - log_min, 1e-9)
    t = max(0.0, min(1.0, t))

    # Map [0, 1] -> [55, 99]
    overall = 55 + t * (99 - 55)
    return int(round(overall))


def experience_bonus(experience: int) -> int:
    """Small overall bonus for veteran experience when no contract data exists."""
    if experience <= 0:
        return 0
    if experience <= 3:
        return experience * 2       # +2, +4, +6
    if experience <= 7:
        return 6 + (experience - 3) # +7 ... +10
    if experience <= 12:
        return 10 - (experience - 7) # +9 ... +5
    return max(0, 5 - (experience - 12))


def estimate_overall_no_contract(pos: str, experience: int) -> int:
    """Fallback overall when no contract data is available."""
    defaults = get_defaults(pos)
    base  = defaults.get("overall", 65)
    bonus = experience_bonus(experience)
    return min(99, max(55, base + bonus))


def dev_trait_from_overall(overall: int) -> int:
    """Assign dev trait from overall rating tier."""
    if overall >= 92:
        return 3  # XFactor
    if overall >= 86:
        return 2  # Star
    if overall >= 79:
        return 1  # Impact
    return 0      # Normal


def scale_ratings(pos: str, overall: int) -> dict:
    """
    Build a complete Madden rating dict for a player at *pos* with *overall*.

    Key position attributes are scaled proportionally (0.8x multiplier) around
    position defaults.  Secondary attributes scale gently (0.3x). Fixed fields
    are kept at the position default.
    """
    defaults   = get_defaults(pos)
    key_fields = set(POSITION_KEY_FIELDS.get(pos, []))
    default_overall = defaults.get("overall", 65)
    delta = overall - default_overall

    ratings: dict = {}
    for field in ALL_RATING_FIELDS:
        if field == "overall":
            ratings[field] = overall
            continue

        if field in FIXED_FIELDS:
            ratings[field] = defaults.get(field, 0)
            continue

        base = defaults.get(field, 0)

        if field in key_fields and field in SCALABLE_FIELDS:
            scaled = base + int(round(delta * 0.8))
            ratings[field] = max(28, min(99, scaled))
        elif base >= 40 and field in SCALABLE_FIELDS:
            # Non-key but meaningful field: small adjustment
            adjusted = base + int(round(delta * 0.3))
            ratings[field] = max(28, min(99, adjusted))
        else:
            ratings[field] = base

    ratings["devTrait"] = dev_trait_from_overall(overall)
    return ratings


def map_contract_fields(player: dict) -> dict:
    """
    Convert real-world contract values to Madden contract fields.

    Returns a dict with:
      contractLength    (total contract years)
      contractYearsLeft (approximate years remaining)
      contractBonus     (portion of signing bonus, in dollars)
      contractSalary    (base salary for current year, in dollars)
    """
    aav         = player.get("aav", 0) or 0
    total_value = player.get("total_contract_value", 0) or 0
    guaranteed  = player.get("guaranteed", 0) or 0
    years       = int(player.get("contract_years", 0) or 0)
    experience  = int(player.get("experience", 0) or 0)

    if years <= 0:
        years = 1

    # Estimate years remaining (heuristic: assume contract signed ~2 years ago)
    years_left = max(1, years - min(years - 1, 2))

    # Signing bonus ~ 50% of guaranteed
    signing_bonus = int(guaranteed * 0.5) if guaranteed else 0

    # Base salary for current year ~ (AAV - pro-rated bonus spread)
    pro_rated_bonus = signing_bonus // max(years, 1)
    base_salary = int(max(800_000, aav - pro_rated_bonus))

    return {
        "contractLength":    years,
        "contractYearsLeft": years_left,
        "contractBonus":     signing_bonus,
        "contractSalary":    base_salary,
    }


# ---------------------------------------------------------------------------
# Build a rated player record
# ---------------------------------------------------------------------------

def rate_player(player: dict) -> dict:
    """
    Given a raw player dict from nfl_rosters_2026.json, return a fully rated
    player dict suitable for use in Madden 26.
    """
    pos        = player.get("position", "QB")
    aav        = player.get("aav", 0) or 0
    experience = int(player.get("experience", 0) or 0)

    # 1. Determine overall
    if aav > 0:
        overall = aav_to_overall(aav, pos)
    else:
        overall = estimate_overall_no_contract(pos, experience)

    # 2. Scale all attribute ratings
    ratings = scale_ratings(pos, overall)

    # 3. Contract Madden fields
    contract_fields = map_contract_fields(player)

    # 4. Parse first/last name
    first_name = player.get("first_name", "").strip()
    last_name  = player.get("last_name", "").strip()
    if not first_name and not last_name:
        parts = player.get("player_name", "").split()
        first_name = parts[0] if parts else ""
        last_name  = " ".join(parts[1:]) if len(parts) > 1 else ""

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
        # Madden ratings
        "ratings":            ratings,
    }


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> None:
    print("=" * 60)
    print("Script 8 — Generate deterministic roster ratings")
    print("=" * 60)

    if not os.path.isfile(INPUT_FILE):
        print(f"\n✗ Input file not found: {INPUT_FILE}", file=sys.stderr)
        print("  Run script 7 first: python scripts/7_fetch_nfl_roster_and_contracts.py")
        sys.exit(1)

    with open(INPUT_FILE, encoding="utf-8") as fh:
        players = json.load(fh)

    print(f"\n  Loaded {len(players):,} players from {os.path.relpath(INPUT_FILE, PROJECT_ROOT)}")

    # Rate every player
    rated: list = []
    for player in players:
        try:
            rated.append(rate_player(player))
        except Exception as exc:
            name = player.get("player_name", "?")
            print(f"  ⚠  Skipped {name}: {exc}", file=sys.stderr)

    # Sort: by team, then position, then overall descending
    rated.sort(key=lambda p: (
        p.get("team", ""),
        p.get("pos", ""),
        -(p["ratings"].get("overall", 0)),
    ))

    # Save output
    os.makedirs(os.path.dirname(OUTPUT_FILE), exist_ok=True)
    with open(OUTPUT_FILE, "w", encoding="utf-8") as fh:
        json.dump(rated, fh, indent=2)

    print(f"  Saved {len(rated):,} rated players → {os.path.relpath(OUTPUT_FILE, PROJECT_ROOT)}")

    # Summary by position
    pos_counts = Counter(p["pos"] for p in rated)
    ovr_by_pos: dict = {}
    for p in rated:
        pos = p["pos"]
        ovr = p["ratings"]["overall"]
        if pos not in ovr_by_pos:
            ovr_by_pos[pos] = []
        ovr_by_pos[pos].append(ovr)

    print("\n" + "=" * 60)
    print("Rating summary by position")
    print("=" * 60)
    for pos in sorted(ovr_by_pos):
        ovrs = ovr_by_pos[pos]
        avg  = sum(ovrs) / len(ovrs)
        top  = max(ovrs)
        n    = len(ovrs)
        print(f"  {pos:<4}  n={n:<4}  avg={avg:5.1f}  top={top}")

    print(f"\n  Total: {len(rated):,} players rated")
    print("\n✓ Done.")


if __name__ == "__main__":
    main()
