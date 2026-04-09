"""
Script 7 — Fetch current NFL roster and contract data.

Downloads:
  - Current NFL rosters from nflverse → data/raw/roster_current.csv
  - Contract data from nflverse (contracts) or Over The Cap (scraping fallback)

Outputs:
  data/nfl_rosters_2026.json  — merged player + contract data, one object per player

Run:
  python scripts/7_fetch_nfl_roster_and_contracts.py
"""

import csv
import io
import json
import os
import re
import sys
import time

import requests
from bs4 import BeautifulSoup
from tqdm import tqdm

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(SCRIPT_DIR)
DATA_DIR = os.path.join(PROJECT_ROOT, "data")
RAW_DIR = os.path.join(DATA_DIR, "raw")

# ---------------------------------------------------------------------------
# Source URLs
# ---------------------------------------------------------------------------
ROSTER_URL = (
    "https://github.com/nflverse/nflverse-data/releases/download/rosters/roster_current.csv"
)
# nflverse contract data (sourced from Over The Cap)
CONTRACTS_URL = (
    "https://github.com/nflverse/nflverse-data/releases/download/contracts/contracts_current.csv"
)
# Over The Cap scraping fallback
OTC_CONTRACTS_URL = "https://overthecap.com/contracts"

# ---------------------------------------------------------------------------
# Position normalisation: raw nflverse position → canonical Madden position
# ---------------------------------------------------------------------------
POSITION_MAP = {
    "QB": "QB",
    "HB": "HB", "RB": "HB",
    "FB": "FB",
    "WR": "WR",
    "TE": "TE",
    "T": "T", "OT": "T", "LT": "T", "RT": "T",
    "G": "G", "OG": "G", "LG": "G", "RG": "G",
    "C": "C", "OL": "G",
    "DE": "DE", "EDGE": "DE",
    "DT": "DT", "NT": "DT",
    "OLB": "OLB",
    "MLB": "MLB", "ILB": "MLB",
    "LB": "OLB",
    "CB": "CB",
    "FS": "FS",
    "SS": "SS",
    "S": "FS", "DB": "CB",
    "K": "K", "PK": "K",
    "P": "P",
    "LS": "LS",
}

# ---------------------------------------------------------------------------
# Scraping headers (browser-like, to avoid 403s)
# ---------------------------------------------------------------------------
HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/124.0.0.0 Safari/537.36"
    ),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
}

REQUEST_TIMEOUT = 30  # seconds


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def download_csv(url: str, label: str, headers: dict | None = None) -> list[dict] | None:
    """
    Download a CSV from *url* and return its rows as a list of dicts.
    Returns None on any error (allows callers to fall back gracefully).
    """
    print(f"\n→ Downloading {label} …")
    print(f"  {url}")

    try:
        resp = requests.get(url, stream=True, timeout=REQUEST_TIMEOUT,
                            headers=headers or {})
        resp.raise_for_status()
    except requests.exceptions.HTTPError as exc:
        print(f"  ⚠  HTTP {exc.response.status_code}: {exc}", file=sys.stderr)
        return None
    except requests.exceptions.RequestException as exc:
        print(f"  ⚠  Request failed: {exc}", file=sys.stderr)
        return None

    total = int(resp.headers.get("content-length", 0)) or None
    chunks = []
    with tqdm(
        total=total,
        unit="B",
        unit_scale=True,
        unit_divisor=1024,
        desc=f"  {label}",
        leave=False,
    ) as bar:
        for chunk in resp.iter_content(chunk_size=65536):
            chunks.append(chunk)
            bar.update(len(chunk))

    text = b"".join(chunks).decode("utf-8-sig")
    reader = csv.DictReader(io.StringIO(text))
    rows = list(reader)
    print(f"  ✓ {len(rows):,} rows")
    return rows


def parse_money(raw: str) -> float:
    """
    Parse a money string like '$12,500,000' or '12.5M' → float (dollars).
    Returns 0.0 if parsing fails.
    """
    if not raw:
        return 0.0
    s = str(raw).strip().replace("$", "").replace(",", "").upper()
    try:
        if "M" in s:
            return float(s.replace("M", "")) * 1_000_000
        if "K" in s:
            return float(s.replace("K", "")) * 1_000
        return float(s)
    except ValueError:
        return 0.0


def scrape_otc_contracts() -> dict[str, dict]:
    """
    Scrape Over The Cap contracts page as a last-resort fallback.
    Returns a dict keyed by lowercase player name.
    """
    print(f"\n→ Scraping Over The Cap contracts page (fallback) …")
    print(f"  {OTC_CONTRACTS_URL}")

    contracts: dict[str, dict] = {}

    try:
        resp = requests.get(
            OTC_CONTRACTS_URL, headers=HEADERS, timeout=REQUEST_TIMEOUT
        )
        resp.raise_for_status()
    except requests.exceptions.RequestException as exc:
        print(f"  ⚠  OTC scraping failed: {exc}", file=sys.stderr)
        return contracts

    soup = BeautifulSoup(resp.text, "lxml")

    # OTC renders a <table id="contracts"> or similar; try several selectors
    table = (
        soup.find("table", {"id": "contracts"})
        or soup.find("table", {"class": re.compile(r"contract", re.I)})
        or soup.find("table")
    )
    if not table:
        print("  ⚠  No contracts table found in OTC HTML", file=sys.stderr)
        return contracts

    tbody = table.find("tbody") or table
    rows = tbody.find_all("tr")

    for row in rows:
        cells = row.find_all(["td", "th"])
        if len(cells) < 5:
            continue

        # Best-guess column order: Player | Team | Pos | Years | Total | APY | GTD | ...
        player_name = cells[0].get_text(strip=True)
        if not player_name or player_name.lower() in ("player", "name"):
            continue  # header row

        team_text   = cells[1].get_text(strip=True) if len(cells) > 1 else ""
        pos_text    = cells[2].get_text(strip=True) if len(cells) > 2 else ""
        years_text  = cells[3].get_text(strip=True) if len(cells) > 3 else ""
        total_text  = cells[4].get_text(strip=True) if len(cells) > 4 else ""
        apy_text    = cells[5].get_text(strip=True) if len(cells) > 5 else ""
        gtd_text    = cells[6].get_text(strip=True) if len(cells) > 6 else ""

        total = parse_money(total_text)
        apy   = parse_money(apy_text)
        gtd   = parse_money(gtd_text)

        try:
            years = int(re.sub(r"[^\d]", "", years_text)) if years_text else 0
        except ValueError:
            years = 0

        if apy > 0 or total > 0:
            contracts[player_name.lower()] = {
                "aav": apy or (total / max(years, 1)),
                "total_value": total,
                "guaranteed": gtd,
                "contract_years": years,
                "team": team_text,
                "position": pos_text,
            }

    print(f"  ✓ {len(contracts):,} player contracts scraped from OTC")
    return contracts


def build_contracts_from_nflverse(rows: list[dict]) -> dict[str, dict]:
    """
    Build a lookup dict from nflverse contracts CSV rows.
    Returns a dict keyed by lowercase player_name.

    Expected nflverse contracts columns (may vary by version):
      player, team, pos, year_signed, years, value, apy, gtd, apy_cap_pct, ...
    """
    contracts: dict[str, dict] = {}

    for row in rows:
        # Try several possible name column keys
        name = (
            row.get("player")
            or row.get("player_name")
            or row.get("name")
            or ""
        ).strip()
        if not name:
            continue

        apy   = parse_money(row.get("apy")   or row.get("aav")   or "0")
        total = parse_money(row.get("value")  or row.get("total") or "0")
        gtd   = parse_money(row.get("gtd")    or row.get("guaranteed") or "0")

        try:
            years = int(float(row.get("years") or row.get("length") or 0))
        except (ValueError, TypeError):
            years = 0

        if apy > 0 or total > 0:
            contracts[name.lower()] = {
                "aav": apy or (total / max(years, 1)),
                "total_value": total,
                "guaranteed": gtd,
                "contract_years": years,
                "team": row.get("team", ""),
                "position": row.get("pos", row.get("position", "")),
            }

    return contracts


def normalize_height(raw_ht: str) -> str:
    """
    Normalise height strings to '6-2' format.
    Accepts '6-2', '6\'2"', '74', etc.
    """
    if not raw_ht:
        return ""
    s = str(raw_ht).strip()
    # Already in '6-2' format
    if re.match(r"^\d-\d{1,2}$", s):
        return s
    # Feet/inches: 6'2" or 6'2
    m = re.match(r"^(\d)[\'\"](\d{1,2})", s)
    if m:
        return f"{m.group(1)}-{m.group(2)}"
    # Total inches: e.g. '74'
    m = re.match(r"^(\d{2,3})$", s)
    if m:
        inches = int(m.group(1))
        feet = inches // 12
        rem  = inches % 12
        return f"{feet}-{rem}"
    return s


def safe_int(val: str | None, default: int = 0) -> int:
    """Parse an integer, returning *default* on failure."""
    try:
        return int(float(str(val).strip()))
    except (ValueError, TypeError, AttributeError):
        return default


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> None:
    print("=" * 60)
    print("Script 7 — Fetch NFL roster & contract data")
    print("=" * 60)

    os.makedirs(RAW_DIR, exist_ok=True)

    # ------------------------------------------------------------------
    # 1. Download current NFL rosters from nflverse
    # ------------------------------------------------------------------
    roster_rows = download_csv(ROSTER_URL, "roster_current.csv")
    if not roster_rows:
        print("\n✗ Could not download roster data. Exiting.", file=sys.stderr)
        sys.exit(1)

    # Save raw roster CSV
    raw_roster_path = os.path.join(RAW_DIR, "roster_current.csv")
    with open(raw_roster_path, "w", newline="", encoding="utf-8") as fh:
        writer = csv.DictWriter(fh, fieldnames=list(roster_rows[0].keys()))
        writer.writeheader()
        writer.writerows(roster_rows)
    print(f"  Saved → {os.path.relpath(raw_roster_path, PROJECT_ROOT)}")

    # ------------------------------------------------------------------
    # 2. Download / scrape contract data
    # ------------------------------------------------------------------
    contracts: dict[str, dict] = {}

    # Try nflverse contracts CSV first (most reliable)
    contract_rows = download_csv(CONTRACTS_URL, "contracts_current.csv")
    if contract_rows:
        raw_contracts_path = os.path.join(RAW_DIR, "contracts_current.csv")
        with open(raw_contracts_path, "w", newline="", encoding="utf-8") as fh:
            writer = csv.DictWriter(fh, fieldnames=list(contract_rows[0].keys()))
            writer.writeheader()
            writer.writerows(contract_rows)
        print(f"  Saved → {os.path.relpath(raw_contracts_path, PROJECT_ROOT)}")
        contracts = build_contracts_from_nflverse(contract_rows)
        print(f"  ✓ Loaded {len(contracts):,} contracts from nflverse")
    else:
        print("  nflverse contracts not available — trying Over The Cap scraping …")
        time.sleep(1)  # polite delay before scraping
        contracts = scrape_otc_contracts()

    if not contracts:
        print("  ⚠  No contract data found — proceeding with empty contracts")
        print("  Ratings will be estimated from position defaults only.")

    # ------------------------------------------------------------------
    # 3. Merge roster + contract data
    # ------------------------------------------------------------------
    print("\n→ Merging roster and contract data …")

    players: list[dict] = []
    seen: set[tuple] = set()

    for row in roster_rows:
        player_name = (row.get("player_name") or row.get("full_name") or "").strip()
        if not player_name:
            continue

        # Status filter: keep active, practice squad, injured reserve
        status = (row.get("status") or "").strip().upper()
        if status in ("", "RET", "UNK", "EXE"):
            continue

        # De-duplicate: same player on same team in same season
        team   = (row.get("team") or row.get("team_abbr") or "").strip()
        season = (row.get("season") or "").strip()
        key    = (player_name.lower(), team.lower(), season)
        if key in seen:
            continue
        seen.add(key)

        # Normalise position
        raw_pos = (
            row.get("position")
            or row.get("depth_chart_position")
            or ""
        ).strip().upper()
        pos = POSITION_MAP.get(raw_pos, raw_pos) if raw_pos else "QB"

        # Contract lookup — try exact name, then last+first swap
        contract = contracts.get(player_name.lower(), {})
        if not contract:
            # Try "Last, First" format that OTC sometimes uses
            parts = player_name.split()
            if len(parts) >= 2:
                alt = f"{parts[-1]}, {' '.join(parts[:-1])}"
                contract = contracts.get(alt.lower(), {})

        # Parse physical attributes
        height = normalize_height(row.get("height") or row.get("ht") or "")
        weight_raw = row.get("weight") or row.get("wt") or ""
        weight = safe_int(weight_raw) if weight_raw else None

        player = {
            "player_name":        player_name,
            "first_name":         (row.get("first_name") or "").strip(),
            "last_name":          (row.get("last_name")  or "").strip(),
            "team":               team,
            "position":           pos,
            "depth_chart_position": (row.get("depth_chart_position") or raw_pos).strip(),
            "jersey_number":      safe_int(row.get("jersey_number") or row.get("number")),
            "status":             status,
            "birth_date":         (row.get("birth_date") or row.get("dob") or "").strip(),
            "height":             height,
            "weight":             weight,
            "college":            (row.get("college") or row.get("college_name") or "").strip(),
            "experience":         safe_int(row.get("years_exp") or row.get("experience")),
            "season":             season,
            # Contract fields
            "aav":                contract.get("aav", 0.0),
            "total_contract_value": contract.get("total_value", 0.0),
            "guaranteed":         contract.get("guaranteed", 0.0),
            "contract_years":     contract.get("contract_years", 0),
        }

        players.append(player)

    print(f"  ✓ Merged {len(players):,} players")

    # ------------------------------------------------------------------
    # 4. Save output
    # ------------------------------------------------------------------
    out_path = os.path.join(DATA_DIR, "nfl_rosters_2026.json")
    with open(out_path, "w", encoding="utf-8") as fh:
        json.dump(players, fh, indent=2)

    print(f"\n  Saved → {os.path.relpath(out_path, PROJECT_ROOT)}")

    # ------------------------------------------------------------------
    # 5. Summary
    # ------------------------------------------------------------------
    from collections import Counter
    pos_counts = Counter(p["position"] for p in players)
    teams_with_contracts = sum(1 for p in players if p["aav"] > 0)

    print("\n" + "=" * 60)
    print("Summary")
    print("=" * 60)
    print(f"  Total players : {len(players):,}")
    print(f"  With contracts: {teams_with_contracts:,}")
    print(f"  Positions     : {dict(sorted(pos_counts.items()))}")
    print("\n✓ Done.")


if __name__ == "__main__":
    main()
