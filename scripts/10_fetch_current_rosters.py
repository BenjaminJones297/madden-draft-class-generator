"""
Script 10 — Fetch current NFL rosters and contract data.

Sources:
  - nflverse weekly rosters (GitHub releases) → current team + status
  - nflverse OTC contracts (GitHub releases)  → contract AAV + years

Output:
  data/current_rosters.json — one entry per active player:
    {
      "firstName":     "Patrick",
      "lastName":      "Mahomes",
      "fullName":      "Patrick Mahomes II",
      "position":      "QB",
      "team":          "KC",           <- nflverse abbreviation
      "contractYears": 10,
      "contractAAV":   45000000,       <- full dollars
      "contractTotal": 450000000
    }

Run:
  python scripts/10_fetch_current_rosters.py
"""

import csv
import gzip
import importlib.util
import io
import json
import os
import re
import sys

import requests

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------
SCRIPT_DIR   = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(SCRIPT_DIR)
DATA_DIR     = os.path.join(PROJECT_ROOT, "data")
OUTPUT_FILE  = os.path.join(DATA_DIR, "current_rosters.json")

CURRENT_YEAR = 2026
REQUEST_TIMEOUT = 30

# Try current season first, fall back to previous (offseason data may still be under prior year)
ROSTER_URLS = [
    f"https://github.com/nflverse/nflverse-data/releases/download/weekly_rosters/roster_weekly_{CURRENT_YEAR}.csv",
    f"https://github.com/nflverse/nflverse-data/releases/download/weekly_rosters/roster_weekly_{CURRENT_YEAR - 1}.csv",
]
CONTRACTS_URL = (
    "https://github.com/nflverse/nflverse-data/releases/download/contracts/historical_contracts.csv.gz"
)

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    ),
}

# Statuses we exclude.  Anything not in this set (including IR, NON, EXE, SUS,
# RET, TRN) is kept — if a player's latest weekly row lists a team, we want
# them in the roster.  Previously-tight filter was dropping stars like Penei
# Sewell / Nico Collins who had non-ACT status on their latest week.
EXCLUDE_STATUSES = {"CUT", "TRD"}

# nflverse raw position → canonical Madden position
POSITION_MAP = {
    "QB":   "QB",
    "HB":   "HB",  "RB":   "HB",
    "FB":   "FB",
    "WR":   "WR",
    "TE":   "TE",
    "T":    "T",   "OT":  "T",   "LT":  "T",   "RT":  "T",
    "G":    "G",   "OG":  "G",   "LG":  "G",   "RG":  "G",
    "C":    "C",   "OL":  "G",
    "DE":   "DE",  "EDGE": "DE",
    "DT":   "DT",  "NT":  "DT",
    "OLB":  "OLB", "LB":  "OLB",
    "MLB":  "MLB", "ILB": "MLB",
    "CB":   "CB",  "DB":  "CB",
    "FS":   "FS",  "S":   "FS",
    "SS":   "SS",
    "K":    "K",   "PK":  "K",
    "P":    "P",
    "LS":   "LS",
}

MIN_SALARY = 870_000  # 2026 NFL minimum (full dollars)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def norm_name(name: str) -> str:
    """Lowercase, strip everything but letters for fuzzy matching."""
    return re.sub(r"[^a-z]", "", (name or "").lower().strip())


def download_raw(url: str, label: str) -> bytes | None:
    print(f"\n→ Downloading {label} …")
    print(f"  {url}")
    try:
        resp = requests.get(url, stream=True, timeout=REQUEST_TIMEOUT, headers=HEADERS)
        if resp.status_code == 200:
            data = resp.content
            print(f"  {len(data):,} bytes")
            return data
        print(f"  HTTP {resp.status_code} — skipping")
        return None
    except Exception as exc:
        print(f"  Error: {exc}")
        return None


def parse_csv(raw_bytes: bytes, compressed: bool = False) -> list[dict] | None:
    try:
        data = gzip.decompress(raw_bytes) if compressed else raw_bytes
        rows = list(csv.DictReader(io.StringIO(data.decode("utf-8", errors="replace"))))
        print(f"  {len(rows):,} rows parsed")
        return rows
    except Exception as exc:
        print(f"  Parse error: {exc}")
        return None


# ---------------------------------------------------------------------------
# Step 1 — Fetch rosters
# ---------------------------------------------------------------------------

def fetch_rosters() -> list[dict] | None:
    rows = None
    for url in ROSTER_URLS:
        label = f"roster_weekly ({url.split('/')[-1]})"
        raw = download_raw(url, label)
        if raw:
            rows = parse_csv(raw)
            if rows:
                print(f"  Season source: {url.split('/')[-1]}")
                break

    if not rows:
        print("ERROR: Could not fetch any roster data.")
        return None

    # Keep only regular-season rows; take the LATEST week per player
    player_latest: dict[str, dict] = {}
    for row in rows:
        if row.get("season_type", "REG") not in ("REG", ""):
            continue
        pid = row.get("player_id") or row.get("gsis_id")
        if not pid:
            pid = norm_name(row.get("full_name", ""))
        if not pid:
            continue
        try:
            week = int(row.get("week") or 0)
        except ValueError:
            week = 0
        existing = player_latest.get(pid)
        if not existing or week > existing.get("_week", -1):
            row["_week"] = week
            player_latest[pid] = row

    result = list(player_latest.values())
    print(f"  Unique players (latest week): {len(result):,}")
    return result


# ---------------------------------------------------------------------------
# Step 2 — Fetch contracts
# ---------------------------------------------------------------------------

def fetch_contracts() -> dict[str, dict]:
    raw = download_raw(CONTRACTS_URL, "OTC contracts (.csv.gz)")
    if not raw:
        print("WARNING: No contract data — will use minimum salary for all players.")
        return {}

    rows = parse_csv(raw, compressed=True)
    if not rows:
        return {}

    # Keep the most recent contract per player (highest year_signed)
    contracts: dict[str, dict] = {}
    for row in rows:
        name_key = norm_name(row.get("player", ""))
        if not name_key:
            continue
        # Prefer active contracts; fall back to most recently signed
        is_active = row.get("is_active", "").upper() == "TRUE"
        try:
            year   = int(row.get("year_signed") or 0)
            aav    = int(float(row.get("apy")   or 0))   # APY = annual payment
            years  = int(row.get("years")        or 1)
            total  = int(float(row.get("value")  or 0))
        except (ValueError, TypeError):
            continue

        existing = contracts.get(name_key)
        # Prefer active over inactive; within same status prefer newer
        existing_active = existing.get("is_active", False) if existing else False
        if existing and existing_active and not is_active:
            continue
        if existing and existing_active == is_active and year <= existing["year_signed"]:
            continue

        contracts[name_key] = {
            "year_signed":    year,
            "is_active":      is_active,
            "contractYears":  max(1, years),
            "contractAAV":    max(MIN_SALARY, aav),
            "contractTotal":  max(0, total),
            "yearSigned":     year,
        }

    print(f"  Unique player contracts: {len(contracts):,}")
    return contracts


def load_fa_moves() -> dict:
    """Load FA_MOVES_2026 dict from script 7 via importlib (safe — has __main__ guard)."""
    script7 = os.path.join(SCRIPT_DIR, "7_fetch_nfl_roster_and_contracts.py")
    if not os.path.exists(script7):
        print("WARNING: script 7 not found — skipping 2026 FA overrides")
        return {}
    spec = importlib.util.spec_from_file_location("script7", script7)
    mod  = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    moves = getattr(mod, "FA_MOVES_2026", {})
    print(f"  FA_MOVES_2026  : {len(moves)} entries loaded from script 7")
    return moves


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> None:
    os.makedirs(DATA_DIR, exist_ok=True)

    roster_rows = fetch_rosters()
    if not roster_rows:
        sys.exit(1)

    contracts = fetch_contracts()
    fa_moves  = load_fa_moves()

    # Build normalized FA_MOVES lookup (handles name variants like
    # "Travis Etienne Jr." and "Travis Etienne" pointing to the same move)
    fa_lookup: dict[str, dict] = {}
    for raw_name, move in fa_moves.items():
        fa_lookup[norm_name(raw_name)] = move

    print(f"\n  Contracts loaded: {len(contracts):,}")
    print(f"  FA overrides    : {len(fa_lookup):,} unique normalized keys")

    players     = []
    skipped     = 0
    fa_override = 0
    fa_expired  = 0

    for row in roster_rows:
        # Filter by status — keep everyone except cut/traded
        status = (row.get("status") or "").upper()
        if status in EXCLUDE_STATUSES:
            skipped += 1
            continue

        team = (row.get("team") or "").upper().strip()
        if not team or team in ("FA", ""):
            skipped += 1
            continue

        full_name  = (row.get("full_name")   or "").strip()
        first_name = (row.get("first_name")  or "").strip()
        last_name  = (row.get("last_name")   or "").strip()

        if not full_name and first_name:
            full_name = f"{first_name} {last_name}".strip()
        if not full_name:
            skipped += 1
            continue

        raw_pos  = (row.get("depth_chart_position") or row.get("position") or "").upper()
        position = POSITION_MAP.get(raw_pos, raw_pos or "QB")

        key      = norm_name(full_name)
        contract = contracts.get(key, {})

        # ── Apply 2026 FA move override ───────────────────────────────────────
        move = fa_lookup.get(key)
        if move:
            fa_override += 1
            team  = move["team"]
            years = move.get("contract_years", 0)
            total = move.get("total_contract_value", 0)
            if years > 0 and total > 0:
                aav = total // years
            elif years > 0:
                aav = contract.get("contractAAV", MIN_SALARY)
            else:
                years = 1
                aav   = contract.get("contractAAV", MIN_SALARY)
            contract = {
                "contractYears": max(1, years),
                "contractAAV":   max(MIN_SALARY, aav),
                "contractTotal": total,
                "yearSigned":    CURRENT_YEAR,
            }
        else:
            # Contract data from nflverse is often stale (doesn't include 2022-2024 extensions).
            # Do NOT infer FA from contract expiry dates — too many false positives.
            # FA_MOVES_2026 is the authoritative source for 2026 FA/re-signings.
            pass

        players.append({
            "firstName":     first_name or full_name.split()[0],
            "lastName":      last_name  or " ".join(full_name.split()[1:]),
            "fullName":      full_name,
            "position":      position,
            "team":          team,
            "contractYears": contract.get("contractYears", 1),
            "contractAAV":   contract.get("contractAAV",   MIN_SALARY),
            "contractTotal": contract.get("contractTotal", MIN_SALARY),
            "yearSigned":    contract.get("yearSigned",    CURRENT_YEAR),
        })

    players.sort(key=lambda p: (p["team"], p["position"], p["lastName"]))

    active = [p for p in players if p["team"] != "FA"]
    fa     = [p for p in players if p["team"] == "FA"]

    print(f"\n{'='*50}")
    print(f"  Active players  : {len(active):,}")
    print(f"  Free agents     : {len(fa):,}  ({fa_expired} expired contract)")
    print(f"  2026 FA moves   : {fa_override:,} players updated to new teams")
    print(f"  Skipped         : {skipped:,}")

    from collections import Counter
    pos_counts = Counter(p["position"] for p in active)
    for pos, count in sorted(pos_counts.items()):
        print(f"    {pos:<6} {count}")

    with open(OUTPUT_FILE, "w", encoding="utf-8") as fh:
        json.dump(players, fh, indent=2)

    print(f"\n✓ Written: {OUTPUT_FILE}  ({len(players):,} total including FAs)")
    print(  "  Next: node custom-scripts/roster/applyRosters.mjs")


if __name__ == "__main__":
    main()
