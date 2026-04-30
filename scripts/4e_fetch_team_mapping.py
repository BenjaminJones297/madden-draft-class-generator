"""
Script 4e — Fetch NFL.com team UUID → abbreviation map.

NFL.com's prospect API references drafting teams by UUID (`draftTeamId`).  The
Madden franchise pipeline keys teams by 3-letter abbreviation (CHI, CIN, ...).
This script fetches https://api.nfl.com/experience/v1/teams once and writes
data/nfl_team_id_to_abbr.json so downstream scripts can resolve UUIDs without
re-hitting the network.

Run:
    python scripts/4e_fetch_team_mapping.py
"""

import json
import os
import sys
import uuid

import requests

SCRIPT_DIR    = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT  = os.path.dirname(SCRIPT_DIR)
DATA_DIR      = os.path.join(PROJECT_ROOT, "data")
OUTPUT_FILE   = os.path.join(DATA_DIR, "nfl_team_id_to_abbr.json")

NFL_CLIENT_KEY    = "4cFUW6DmwJpzT9L7LrG3qRAcABG5s04g"
NFL_CLIENT_SECRET = "CZuvCL49d9OwfGsR"
TOKEN_URL    = "https://api.nfl.com/identity/v3/token"
TEAMS_URL    = "https://api.nfl.com/experience/v1/teams?season=2026"

BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")


def fetch_token() -> str:
    body = {
        "clientKey":    NFL_CLIENT_KEY,
        "clientSecret": NFL_CLIENT_SECRET,
        "deviceId":     str(uuid.uuid4()),
        "deviceInfo":   "eyJtb2RlbCI6ImRlc2t0b3AiLCJvc05hbWUiOiJXaW5kb3dzIiwib3NWZXJzaW9uIjoiMTAiLCJ2ZXJzaW9uIjoiV2ViS2l0In0=",
        "networkType":  "other",
    }
    headers = {
        "User-Agent": BROWSER_UA,
        "Content-Type": "application/json",
        "Accept": "application/json",
        "Origin": "https://www.nfl.com",
        "Referer": "https://www.nfl.com/",
    }
    r = requests.post(TOKEN_URL, json=body, headers=headers, timeout=20)
    r.raise_for_status()
    return r.json()["accessToken"]


def main() -> None:
    print("> Fetching token ...")
    token = fetch_token()

    print("> Fetching team list ...")
    r = requests.get(TEAMS_URL, headers={
        "User-Agent": BROWSER_UA,
        "Accept": "application/json",
        "Origin": "https://www.nfl.com",
        "Referer": "https://www.nfl.com/",
        "Authorization": f"Bearer {token}",
    }, timeout=20)
    r.raise_for_status()
    j = r.json()
    teams = j.get("teams") or j.get("data") or []
    print(f"  {len(teams)} teams returned")

    # Build mapping: { uuid: "ABBR" }.  Try the obvious key candidates first.
    mapping: dict = {}
    for t in teams:
        # Possible places for the UUID
        uid = (t.get("id") or t.get("teamId") or t.get("uuid")
               or (t.get("team") or {}).get("id"))
        # Possible places for the 2-3 letter abbreviation
        abbr = (t.get("abbr") or t.get("teamAbbr") or t.get("abbreviation")
                or t.get("nickName") or (t.get("team") or {}).get("abbreviation"))
        if uid and abbr:
            mapping[uid] = abbr.upper()

    if not mapping:
        # Couldn't auto-detect — dump first record so user can iterate
        print("  WARN: no UUID/abbr fields auto-detected; sample first team:")
        if teams:
            print(json.dumps(teams[0], indent=2)[:1500])
        sys.exit(1)

    # Madden uses 'AZ' (not 'ARI') and 'LAR' (not 'LA') — normalise here so
    # everything downstream sees Madden-native abbrs.
    NFL_TO_MADDEN = {"ARI": "AZ", "LA": "LAR"}
    mapping = {k: NFL_TO_MADDEN.get(v, v) for k, v in mapping.items()}

    print(f"\n  built {len(mapping)} UUID -> abbreviation entries")
    for uid, abbr in sorted(mapping.items(), key=lambda kv: kv[1])[:5]:
        print(f"    {abbr:<4} <- {uid}")
    print("    ...")

    with open(OUTPUT_FILE, "w", encoding="utf-8") as fh:
        json.dump(mapping, fh, indent=2, sort_keys=True)
    print(f"\n  wrote {OUTPUT_FILE}")


if __name__ == "__main__":
    main()
