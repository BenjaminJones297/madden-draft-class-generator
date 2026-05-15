"""
Script 7c — Merge OTC contract data into nfl_rosters_2026.json.

Overlays current contract fields from `data/raw/otc_contracts.json` (produced
by 7b) onto the existing rosters file. Match key is normalised name; team is
used as a secondary disambiguator + sanity check (warn on mismatch, don't
force).

What it overwrites on a match:
    aav, total_contract_value, guaranteed, contract_years, year_signed

What it adds (informational):
    free_agent_year, otc_contract_status, otc_contract_type, otc_id

What it preserves verbatim:
    team, position, depth_chart_position, jersey_number, status, birth_date,
    height, weight, college, experience, season, player_name, first_name,
    last_name (and any other roster-only fields).

Match policy:
- Only merge when OTC has aav > 0 (real contract data) AND status == "Active"
  or the entry exists at all (we trust OTC's pick of the right row).
- Warn on team mismatch; keep the nflverse team (the player may have been
  cut/traded between nflverse's weekly_rosters snapshot and OTC's update).
- Leave unmatched roster entries entirely untouched — they keep stale data
  but at least don't get wiped.

Run:
  python scripts/7c_merge_otc_into_rosters.py
  python scripts/7c_merge_otc_into_rosters.py --in data/raw/otc_contracts.json
  python scripts/7c_merge_otc_into_rosters.py --dry-run
"""

import argparse
import json
import os
import re
import sys

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(SCRIPT_DIR)
DATA_DIR = os.path.join(PROJECT_ROOT, "data")

OTC_DEFAULT = os.path.join(DATA_DIR, "raw", "otc_contracts.json")
ROSTERS_DEFAULT = os.path.join(DATA_DIR, "nfl_rosters_2026.json")

# OTC team_abbr → nflverse abbr (handle the few naming divergences). 9g's
# ABBR_NORMALIZE handles the inverse map; we mirror it here so OTC's
# `team_abbr` (already normalised) matches nflverse's roster `team` field.
OTC_TO_NFLVERSE_TEAM = {
    # OTC uses LA / OTC uses LV / OTC uses LAC — these match nflverse already.
    # No remaps currently known, but keep the dict for future divergences.
}


def normalize_name(s: str) -> str:
    """Lowercase, strip punctuation and Jr./Sr./II/III suffixes."""
    if not s:
        return ""
    s = s.lower().strip()
    # Drop common suffixes (must be standalone word)
    s = re.sub(r"\s+(jr|sr|ii|iii|iv|v)\.?$", "", s)
    # Strip punctuation, collapse whitespace
    s = re.sub(r"[^\w\s-]", "", s)
    s = re.sub(r"\s+", " ", s)
    return s.strip()


def split_full_name(full: str) -> tuple[str, str]:
    parts = (full or "").strip().split(" ", 1)
    if len(parts) == 1:
        return parts[0], ""
    return parts[0], parts[1]


def main() -> int:
    ap = argparse.ArgumentParser(description="Merge OTC contracts into rosters file.")
    ap.add_argument("--otc-in", default=OTC_DEFAULT, dest="otc_in",
                    help=f"OTC scrape output (default: {OTC_DEFAULT})")
    ap.add_argument("--rosters", default=ROSTERS_DEFAULT,
                    help=f"Rosters file to update in place (default: {ROSTERS_DEFAULT})")
    ap.add_argument("--dry-run", action="store_true",
                    help="Print what would change; don't write the rosters file.")
    args = ap.parse_args()

    if not os.path.exists(args.otc_in):
        print(f"✗ OTC scrape file not found: {args.otc_in}\n  Run scripts/7b_fetch_otc_contracts.py first.",
              file=sys.stderr)
        return 1
    if not os.path.exists(args.rosters):
        print(f"✗ Rosters file not found: {args.rosters}", file=sys.stderr)
        return 1

    with open(args.otc_in, encoding="utf-8") as fh:
        otc = json.load(fh)
    with open(args.rosters, encoding="utf-8") as fh:
        rosters = json.load(fh)

    print(f"Loaded {len(otc)} OTC entries; {len(rosters)} roster entries.")

    # Build OTC index: normalized_name → list of entries (in case of duplicates)
    otc_by_name: dict[str, list[dict]] = {}
    for entry in otc.values():
        if entry.get("aav", 0) <= 0:
            continue
        key = normalize_name(entry.get("full_name", ""))
        if not key:
            continue
        otc_by_name.setdefault(key, []).append(entry)

    print(f"OTC entries with aav > 0: {sum(len(v) for v in otc_by_name.values())}")

    # Iterate rosters; merge in OTC contract data where matched.
    stats = {
        "merged": 0,
        "team_mismatch_warn": 0,
        "no_otc_match": 0,
        "otc_duplicate_resolved": 0,
        "skipped_inactive_otc": 0,
    }
    sample_changes: list[str] = []

    for r in rosters:
        first = r.get("first_name") or split_full_name(r.get("player_name", ""))[0]
        last = r.get("last_name") or split_full_name(r.get("player_name", ""))[1]
        key = normalize_name(f"{first} {last}")
        if not key:
            stats["no_otc_match"] += 1
            continue

        candidates = otc_by_name.get(key, [])
        if not candidates:
            stats["no_otc_match"] += 1
            continue

        # Prefer a candidate whose team matches the rosters team_abbr.
        roster_team = (r.get("team") or "").upper()
        match = None
        if len(candidates) == 1:
            match = candidates[0]
        else:
            stats["otc_duplicate_resolved"] += 1
            for c in candidates:
                if (c.get("team_abbr") or "").upper() == roster_team:
                    match = c
                    break
            if not match:
                match = candidates[0]   # arbitrary; warn below

        otc_team = (match.get("team_abbr") or "").upper()
        if roster_team and otc_team and roster_team != otc_team:
            stats["team_mismatch_warn"] += 1
            if stats["team_mismatch_warn"] <= 10:
                print(f"  WARN team mismatch: {first} {last} - rosters={roster_team}, "
                      f"otc={otc_team} (keeping rosters team, applying contract)")

        # Capture a sample for the change log.
        before_aav = r.get("aav")
        before_years = r.get("contract_years")

        r["aav"] = int(match.get("aav") or 0)
        r["total_contract_value"] = int(match.get("total_contract_value") or 0)
        r["guaranteed"] = int(match.get("guaranteed") or 0)
        r["contract_years"] = int(match.get("contract_years") or 0)
        r["year_signed"] = int(match.get("year_signed") or 0)
        r["free_agent_year"] = int(match.get("free_agent_year") or 0)
        r["otc_id"] = match.get("otc_id")
        r["otc_contract_status"] = match.get("contract_status")
        r["otc_contract_type"] = match.get("contract_type")
        stats["merged"] += 1

        if len(sample_changes) < 15 and (
            before_aav != r["aav"] or before_years != r["contract_years"]
        ):
            sample_changes.append(
                f"  {first} {last} ({roster_team}): "
                f"aav {before_aav} -> {r['aav']}, "
                f"yrs {before_years} -> {r['contract_years']}"
            )

    print(f"\nMerge stats:")
    for k, v in stats.items():
        print(f"  {k}: {v}")
    if sample_changes:
        print(f"\nSample of changes:")
        for line in sample_changes:
            print(line)

    if args.dry_run:
        print("\n(dry-run; no file written)")
        return 0

    # Write back. Atomic swap.
    tmp = args.rosters + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(rosters, fh, indent=2)
    os.replace(tmp, args.rosters)
    print(f"\nOK Wrote merged rosters to {args.rosters}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
