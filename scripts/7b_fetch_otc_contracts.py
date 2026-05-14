"""
Script 7b — Fetch current NFL contracts from Over The Cap (OTC).

Two-stage scrape, ~60 min total at 1.5s sleep:
  1. Discovery: 32 /salary-cap/<team-slug>/ pages → extract /player/.../<id>/
     URLs for the full active roster (~70 players per team).
  2. Detail: each /player/<slug>/<id>/ page → parse the Contract History table.
     Pick the row with Status == "Active" (fallback: most recent Year Signed).

Output: data/raw/otc_contracts.json keyed by stable otc_id. Each entry:

  {
    "otc_id": "5594",
    "slug": "patrick-mahomes",
    "full_name": "Patrick Mahomes",
    "team_slug": "kansas-city-chiefs",
    "team_abbr": "KC",
    "position": "QB",
    "year_signed": 2020,
    "contract_years": 10,
    "free_agent_year": 2030,
    "total_contract_value": 450000000,
    "aav": 45000000,
    "guaranteed": 63081905,
    "contract_status": "Active",
    "source_url": "https://overthecap.com/player/patrick-mahomes/5594/"
  }

Resumable: persists output after every team and every N players (default 25).
Run again with --resume to skip already-fetched players.

Run:
  python scripts/7b_fetch_otc_contracts.py
  python scripts/7b_fetch_otc_contracts.py --teams kansas-city-chiefs,buffalo-bills
  python scripts/7b_fetch_otc_contracts.py --resume
  python scripts/7b_fetch_otc_contracts.py --max-players 10  # quick sanity run
"""

import argparse
import json
import os
import re
import sys
import time
from urllib.parse import urljoin

import requests
from bs4 import BeautifulSoup
from tqdm import tqdm

# ---------------------------------------------------------------------------
# Paths + constants
# ---------------------------------------------------------------------------
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(SCRIPT_DIR)
DATA_DIR = os.path.join(PROJECT_ROOT, "data")
RAW_DIR = os.path.join(DATA_DIR, "raw")
OUTPUT_FILE = os.path.join(RAW_DIR, "otc_contracts.json")

BASE_URL = "https://overthecap.com"
SLEEP_SECONDS = 1.5  # Conservative per robots.txt (CCBot has Crawl-delay: 2)
REQUEST_TIMEOUT = 30
MAX_RETRIES = 4
BACKOFF_BASE = 2.0  # 2s, 4s, 8s, 16s on consecutive failures
HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (compatible; Madden-modder/1.0; "
        "https://github.com/anthropics/claude-code)"
    ),
    "Accept": "text/html,application/xhtml+xml",
}

# OTC team slug → nflverse abbreviation (matches NFLVERSE_TO_TEAM_INDEX in 9g/9c).
# 32 NFL teams. Confirmed slugs via WebFetch live probes (otc-scrape-research.md).
TEAM_SLUGS = {
    "arizona-cardinals":    "ARI",
    "atlanta-falcons":      "ATL",
    "baltimore-ravens":     "BAL",
    "buffalo-bills":        "BUF",
    "carolina-panthers":    "CAR",
    "chicago-bears":        "CHI",
    "cincinnati-bengals":   "CIN",
    "cleveland-browns":     "CLE",
    "dallas-cowboys":       "DAL",
    "denver-broncos":       "DEN",
    "detroit-lions":        "DET",
    "green-bay-packers":    "GB",
    "houston-texans":       "HOU",
    "indianapolis-colts":   "IND",
    "jacksonville-jaguars": "JAX",
    "kansas-city-chiefs":   "KC",
    "las-vegas-raiders":    "LV",
    "los-angeles-chargers": "LAC",
    "los-angeles-rams":     "LA",
    "miami-dolphins":       "MIA",
    "minnesota-vikings":    "MIN",
    "new-england-patriots": "NE",
    "new-orleans-saints":   "NO",
    "new-york-giants":      "NYG",
    "new-york-jets":        "NYJ",
    "philadelphia-eagles":  "PHI",
    "pittsburgh-steelers":  "PIT",
    "san-francisco-49ers":  "SF",
    "seattle-seahawks":     "SEA",
    "tampa-bay-buccaneers": "TB",
    "tennessee-titans":     "TEN",
    "washington-commanders": "WAS",
}

# Position normalisation — OTC uses long-form (Quarterback, Wide Receiver, etc.).
# Map to the canonical Madden short forms used elsewhere in the pipeline.
POSITION_NORMALIZE = {
    "quarterback":             "QB",
    "running back":            "HB",
    "halfback":                "HB",
    "fullback":                "FB",
    "wide receiver":           "WR",
    "tight end":               "TE",
    "left tackle":             "T",
    "right tackle":            "T",
    "offensive tackle":        "T",
    "tackle":                  "T",
    "left guard":              "G",
    "right guard":             "G",
    "offensive guard":         "G",
    "guard":                   "G",
    "center":                  "C",
    "defensive end":           "DE",
    "defensive tackle":        "DT",
    "nose tackle":             "DT",
    "edge":                    "DE",
    "edge rusher":             "DE",
    "outside linebacker":      "OLB",
    "inside linebacker":       "MLB",
    "middle linebacker":       "MLB",
    "linebacker":              "OLB",
    "cornerback":              "CB",
    "free safety":             "FS",
    "strong safety":           "SS",
    "safety":                  "FS",
    "defensive back":          "CB",
    "kicker":                  "K",
    "punter":                  "P",
    "long snapper":            "LS",
}

# ---------------------------------------------------------------------------
# HTTP with retry / backoff
# ---------------------------------------------------------------------------
session = requests.Session()
session.headers.update(HEADERS)


def fetch(url: str) -> str | None:
    """GET with retry+backoff. Returns HTML text or None on permanent failure."""
    for attempt in range(MAX_RETRIES):
        try:
            resp = session.get(url, timeout=REQUEST_TIMEOUT)
            if resp.status_code == 200:
                return resp.text
            if resp.status_code in (429, 503):
                wait = BACKOFF_BASE ** (attempt + 1)
                print(f"  ⚠  {resp.status_code} on {url}; sleeping {wait:.1f}s",
                      file=sys.stderr)
                time.sleep(wait)
                continue
            if resp.status_code == 404:
                return None
            print(f"  ⚠  HTTP {resp.status_code} on {url}", file=sys.stderr)
            return None
        except requests.exceptions.RequestException as exc:
            wait = BACKOFF_BASE ** (attempt + 1)
            print(f"  ⚠  Request failed on {url}: {exc}; sleeping {wait:.1f}s",
                  file=sys.stderr)
            time.sleep(wait)
    print(f"  ✗ Gave up on {url} after {MAX_RETRIES} retries", file=sys.stderr)
    return None


# ---------------------------------------------------------------------------
# Parsing helpers
# ---------------------------------------------------------------------------
PLAYER_HREF_RE = re.compile(r"^/player/([a-z0-9\-]+)/(\d+)/?$", re.I)


def parse_money(text: str) -> int:
    """Parse '$45,000,000' → 45000000. Empty/junk → 0."""
    if not text:
        return 0
    cleaned = re.sub(r"[^\d.]", "", text)
    if not cleaned:
        return 0
    try:
        return int(float(cleaned))
    except (ValueError, TypeError):
        return 0


def parse_int(text: str) -> int:
    if not text:
        return 0
    cleaned = re.sub(r"[^\d]", "", text)
    if not cleaned:
        return 0
    try:
        return int(cleaned)
    except (ValueError, TypeError):
        return 0


# ---------------------------------------------------------------------------
# Phase 1: team-page discovery
# ---------------------------------------------------------------------------
def discover_players_for_team(team_slug: str) -> list[dict]:
    """
    Fetch /salary-cap/<team-slug>/ and return list of
      {otc_id, slug, full_name, team_slug, team_abbr}
    one per player link found in the roster table.
    """
    url = f"{BASE_URL}/salary-cap/{team_slug}/"
    html = fetch(url)
    if not html:
        return []
    soup = BeautifulSoup(html, "lxml")

    out: list[dict] = []
    seen_ids: set[str] = set()

    # Collect every anchor that points at /player/<slug>/<id>/
    for a in soup.find_all("a", href=True):
        m = PLAYER_HREF_RE.match(a["href"].strip())
        if not m:
            continue
        slug, otc_id = m.group(1), m.group(2)
        if otc_id in seen_ids:
            continue
        seen_ids.add(otc_id)
        full_name = a.get_text(strip=True) or slug.replace("-", " ").title()
        out.append({
            "otc_id":    otc_id,
            "slug":      slug,
            "full_name": full_name,
            "team_slug": team_slug,
            "team_abbr": TEAM_SLUGS[team_slug],
        })
    return out


# ---------------------------------------------------------------------------
# Phase 2: player-profile detail
# ---------------------------------------------------------------------------
CONTRACT_TABLE_COLS = [
    "team", "contract_type", "status", "year_signed", "yrs",
    "total", "apy", "guarantees", "amount_earned", "pct_earned", "effective_apy",
]


def extract_position_from_profile(soup: BeautifulSoup) -> str:
    """Page header is something like 'Patrick Mahomes — Quarterback'."""
    # Try common heading locations.
    for tag in ("h1", "h2", "h3"):
        for el in soup.find_all(tag):
            txt = el.get_text(" ", strip=True)
            if "—" in txt or "-" in txt or "•" in txt:
                # Split on the various delimiters OTC uses.
                parts = re.split(r"[—\-•|]", txt, maxsplit=1)
                if len(parts) == 2:
                    pos_raw = parts[1].strip().lower()
                    norm = POSITION_NORMALIZE.get(pos_raw)
                    if norm:
                        return norm
    # Fallback: look for a "Position:" label
    for el in soup.find_all(["span", "div", "p"]):
        txt = el.get_text(" ", strip=True)
        m = re.match(r"^\s*Position\s*:\s*(.+)$", txt, re.I)
        if m:
            pos_raw = m.group(1).strip().lower()
            return POSITION_NORMALIZE.get(pos_raw, "")
    return ""


def parse_contract_history_table(soup: BeautifulSoup) -> dict | None:
    """
    Find the Contract History table and return the Active row (or most recent).
    Returns dict with keys matching CONTRACT_TABLE_COLS plus parsed numerics.
    Returns None if no usable row found.
    """
    # Find a table whose header contains "Year Signed" + "Yrs" + "APY".
    target_table = None
    for table in soup.find_all("table"):
        head = table.find("thead") or table
        head_text = head.get_text(" ", strip=True).lower()
        if "year signed" in head_text and "yrs" in head_text and "apy" in head_text:
            target_table = table
            break
    if not target_table:
        return None

    # Build column-index map from the header row.
    header_row = target_table.find("thead")
    if header_row:
        header_cells = header_row.find_all(["th", "td"])
    else:
        first_tr = target_table.find("tr")
        header_cells = first_tr.find_all(["th", "td"]) if first_tr else []
    col_index: dict[str, int] = {}
    for i, c in enumerate(header_cells):
        name = c.get_text(" ", strip=True).lower().strip()
        # Normalise OTC's column names
        name = name.replace("guarantees", "guarantees")
        if "year signed" in name:        col_index["year_signed"] = i
        elif name == "yrs":              col_index["yrs"] = i
        elif name == "total":            col_index["total"] = i
        elif name == "apy":              col_index["apy"] = i
        elif "guarantees" in name:       col_index["guarantees"] = i
        elif name == "status":           col_index["status"] = i
        elif name == "team":             col_index["team"] = i
        elif "contract type" in name:    col_index["contract_type"] = i

    if "year_signed" not in col_index or "yrs" not in col_index or "apy" not in col_index:
        return None

    # Iterate body rows; track Active + most-recent fallback.
    tbody = target_table.find("tbody") or target_table
    rows = tbody.find_all("tr")
    active_row = None
    most_recent = None
    most_recent_year = -1

    for tr in rows:
        cells = tr.find_all(["td", "th"])
        if len(cells) < max(col_index.values()) + 1:
            continue
        # Skip the header row itself if no <thead>
        if not header_row and tr is rows[0]:
            continue

        def cell(name: str) -> str:
            i = col_index.get(name)
            if i is None or i >= len(cells):
                return ""
            return cells[i].get_text(" ", strip=True)

        status = cell("status") or ""
        year_signed = parse_int(cell("year_signed"))
        if status.lower() == "active":
            active_row = cells
            break  # active is authoritative; stop
        if year_signed > most_recent_year:
            most_recent_year = year_signed
            most_recent = cells

    pick = active_row if active_row is not None else most_recent
    if pick is None:
        return None

    def cell(name: str) -> str:
        i = col_index.get(name)
        if i is None or i >= len(pick):
            return ""
        return pick[i].get_text(" ", strip=True)

    return {
        "team":                 cell("team"),
        "contract_type":        cell("contract_type"),
        "contract_status":      cell("status"),
        "year_signed":          parse_int(cell("year_signed")),
        "contract_years":       parse_int(cell("yrs")),
        "total_contract_value": parse_money(cell("total")),
        "aav":                  parse_money(cell("apy")),
        "guaranteed":           parse_money(cell("guarantees")),
    }


def fetch_player_detail(player: dict) -> dict | None:
    """Fetch and parse one /player/<slug>/<id>/ page."""
    url = f"{BASE_URL}/player/{player['slug']}/{player['otc_id']}/"
    html = fetch(url)
    if not html:
        return None
    soup = BeautifulSoup(html, "lxml")

    contract = parse_contract_history_table(soup)
    if not contract:
        return None

    pos = extract_position_from_profile(soup)
    fa_year = (contract["year_signed"] + contract["contract_years"]
               if contract["year_signed"] and contract["contract_years"] else 0)

    return {
        "otc_id":     player["otc_id"],
        "slug":       player["slug"],
        "full_name":  player["full_name"],
        "team_slug":  player["team_slug"],
        "team_abbr":  player["team_abbr"],
        "position":   pos,
        **contract,
        "free_agent_year": fa_year,
        "source_url": url,
    }


# ---------------------------------------------------------------------------
# Resumable I/O
# ---------------------------------------------------------------------------
def load_existing(path: str) -> dict[str, dict]:
    if not os.path.exists(path):
        return {}
    try:
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)
    except (json.JSONDecodeError, OSError) as exc:
        print(f"  ⚠  Could not load existing {path}: {exc}", file=sys.stderr)
        return {}


def save_output(path: str, data: dict[str, dict]) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(data, fh, indent=2, sort_keys=True)
    os.replace(tmp, path)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main() -> int:
    ap = argparse.ArgumentParser(description="Scrape Over The Cap contracts.")
    ap.add_argument("--teams", help="Comma-separated subset of team slugs.")
    ap.add_argument("--resume", action="store_true",
                    help="Skip players already in the output file.")
    ap.add_argument("--max-players", type=int, default=0,
                    help="Cap total players (for smoke tests; 0 = no limit).")
    ap.add_argument("--out", default=OUTPUT_FILE,
                    help=f"Output JSON path (default: {OUTPUT_FILE})")
    ap.add_argument("--save-every", type=int, default=25,
                    help="Persist output every N players (default: 25).")
    ap.add_argument("--sleep", type=float, default=SLEEP_SECONDS,
                    help=f"Sleep seconds between requests (default: {SLEEP_SECONDS})")
    args = ap.parse_args()

    sleep_s = args.sleep
    teams = list(TEAM_SLUGS.keys())
    if args.teams:
        wanted = [t.strip() for t in args.teams.split(",") if t.strip()]
        unknown = [t for t in wanted if t not in TEAM_SLUGS]
        if unknown:
            print(f"✗ Unknown team slugs: {unknown}", file=sys.stderr)
            return 1
        teams = wanted

    existing = load_existing(args.out) if args.resume or os.path.exists(args.out) else {}
    if args.resume and existing:
        print(f"Resuming with {len(existing)} existing entries in {args.out}")

    # Phase 1: discovery
    print(f"\n=== Phase 1 — discovery ({len(teams)} teams) ===")
    discovery_list: list[dict] = []
    seen_ids = set()
    for team_slug in tqdm(teams, desc="teams", unit="team"):
        players = discover_players_for_team(team_slug)
        new_count = 0
        for p in players:
            if p["otc_id"] in seen_ids:
                continue
            seen_ids.add(p["otc_id"])
            discovery_list.append(p)
            new_count += 1
        tqdm.write(f"  {team_slug}: {len(players)} links ({new_count} new)")
        time.sleep(sleep_s)
    print(f"\n  Discovered {len(discovery_list)} unique players across {len(teams)} teams.")

    if args.max_players and args.max_players > 0:
        discovery_list = discovery_list[: args.max_players]
        print(f"  Limited to first {len(discovery_list)} players (--max-players).")

    # Phase 2: detail
    print(f"\n=== Phase 2 — detail ({len(discovery_list)} players) ===")
    output = existing.copy()
    fetched = 0
    skipped = 0
    failed = 0

    for player in tqdm(discovery_list, desc="players", unit="player"):
        otc_id = player["otc_id"]
        if args.resume and otc_id in existing:
            skipped += 1
            continue
        detail = fetch_player_detail(player)
        if detail:
            output[otc_id] = detail
            fetched += 1
        else:
            failed += 1
        if (fetched + failed) % max(1, args.save_every) == 0:
            save_output(args.out, output)
        time.sleep(sleep_s)

    save_output(args.out, output)

    print(f"\n=== Done ===")
    print(f"  Fetched : {fetched}")
    print(f"  Skipped : {skipped} (already had)")
    print(f"  Failed  : {failed}")
    print(f"  Total in {args.out}: {len(output)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
