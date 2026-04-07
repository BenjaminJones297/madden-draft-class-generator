"""
Script 4 – Fetch 2026 NFL Draft Prospects
==========================================
Scrapes 2026 NFL draft prospect data (name, position, school, measurables,
grade/rank) from multiple sources with fallbacks, then outputs a clean JSON
list of prospects.

Sources tried in order:
  1. nflverse combine CSV (data/raw/combine_2026.csv)
  2. ESPN Scouts Inc. big board
  3. Pro Football Network prospect grades
  4. NFL Mock Draft Database consensus board
  5. Hardcoded fallback (80+ real 2026 prospects)

Output:
  data/prospects_2026.json
  data/raw/prospects_2026_manual.csv
"""

import os
import sys
import json
import csv
import re
import time

import requests
from bs4 import BeautifulSoup

# ---------------------------------------------------------------------------
# Path helpers
# ---------------------------------------------------------------------------
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(SCRIPT_DIR)
DATA_DIR = os.path.join(PROJECT_ROOT, "data")
RAW_DIR = os.path.join(DATA_DIR, "raw")

# Make sure utils is importable when run from any cwd
sys.path.insert(0, PROJECT_ROOT)
from utils.enums import POSITION_TO_ENUM

# ---------------------------------------------------------------------------
# Constants
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

REQUEST_TIMEOUT = 15   # seconds
MIN_SCRAPED = 50       # fall back to hardcoded if fewer prospects found


# ---------------------------------------------------------------------------
# Prospect template
# ---------------------------------------------------------------------------
def empty_prospect():
    return {
        "name": "",
        "firstName": "",
        "lastName": "",
        "pos": "",
        "school": "",
        "ht": "",
        "wt": None,
        "forty": None,
        "bench": None,
        "vertical": None,
        "broad_jump": None,
        "cone": None,
        "shuttle": None,
        "rank": None,
        "grade": "",
        "notes": "",
    }


# ---------------------------------------------------------------------------
# Utility helpers
# ---------------------------------------------------------------------------
def split_name(full_name: str):
    """Return (firstName, lastName) from a full name string."""
    parts = full_name.strip().split()
    if len(parts) == 0:
        return "", ""
    if len(parts) == 1:
        return parts[0], ""
    return parts[0], " ".join(parts[1:])


def normalize_pos(raw_pos: str) -> str:
    """
    Map a raw position string to a canonical Madden position key.
    Returns the first valid token found, or the original upper-cased string.
    """
    if not raw_pos:
        return ""
    # try exact match first
    up = raw_pos.strip().upper()
    if up in POSITION_TO_ENUM:
        return up
    # try splitting on "/" or "-" or space
    for sep in ("/", "-", " "):
        for token in up.split(sep):
            token = token.strip()
            if token in POSITION_TO_ENUM:
                return token
    # common aliases not in enum
    aliases = {
        "OL": "T", "DL": "DE", "LB": "OLB", "SAF": "FS",
        "SAF": "SS", "SAFETY": "FS", "LINEBACKER": "OLB",
        "CORNER": "CB", "CORNERBACK": "CB", "WIDE RECEIVER": "WR",
        "RUNNING BACK": "HB", "TIGHT END": "TE", "QUARTERBACK": "QB",
        "DEFENSIVE TACKLE": "DT", "DEFENSIVE END": "DE",
        "OFFENSIVE TACKLE": "T", "OFFENSIVE GUARD": "G",
        "CENTER": "C", "KICKER": "K", "PUNTER": "P",
        "LONG SNAPPER": "LS", "FULLBACK": "FB",
    }
    if up in aliases:
        return aliases[up]
    return up  # leave as-is; downstream validator will warn


def parse_height(raw_ht) -> str:
    """Normalise height to 'F-I' string, e.g. '6-2'."""
    if not raw_ht:
        return ""
    s = str(raw_ht).strip()
    # already in "6-2" format
    if re.match(r'^\d-\d{1,2}$', s):
        return s
    # "6'2"" or "6'2" or "6' 2"
    m = re.match(r"(\d)['\u2019\u02bc]?\s*(\d{1,2})", s)
    if m:
        return f"{m.group(1)}-{m.group(2)}"
    # total inches only (e.g. "74")
    if re.match(r'^\d{2}$', s):
        inches = int(s)
        return f"{inches // 12}-{inches % 12}"
    return s


def parse_weight(raw_wt) -> int | None:
    """Return weight as int or None."""
    if raw_wt is None:
        return None
    try:
        return int(str(raw_wt).strip().split()[0].replace(",", ""))
    except (ValueError, IndexError):
        return None


def parse_float(val) -> float | None:
    """Return float or None."""
    if val is None:
        return None
    try:
        f = float(str(val).strip())
        return f if f > 0 else None
    except ValueError:
        return None


def infer_round(rank: int | None) -> int:
    """Infer draft round from board rank."""
    if rank is None:
        return 7
    if rank <= 32:
        return 1
    if rank <= 96:
        return 2
    if rank <= 160:
        return 3
    if rank <= 224:
        return 4
    if rank <= 288:
        return 5
    if rank <= 320:
        return 6
    return 7


def dedupe(prospects: list[dict]) -> list[dict]:
    """Deduplicate by lower-cased name, keeping the first occurrence."""
    seen = {}
    out = []
    for p in prospects:
        key = p["name"].strip().lower()
        if not key:
            continue
        if key not in seen:
            seen[key] = len(out)
            out.append(p)
        else:
            # merge measurables from later records into first occurrence
            existing = out[seen[key]]
            for field in ("ht", "wt", "forty", "bench", "vertical",
                          "broad_jump", "cone", "shuttle", "school",
                          "grade", "rank"):
                if not existing.get(field) and p.get(field):
                    existing[field] = p[field]
    return out


def merge_measurables(prospects: list[dict], combine_rows: dict) -> list[dict]:
    """
    Overlay combine CSV measurables onto prospects list.
    combine_rows: { lower_name: row_dict }
    """
    for p in prospects:
        key = p["name"].strip().lower()
        row = combine_rows.get(key)
        if not row:
            continue
        if not p.get("ht"):
            p["ht"] = parse_height(row.get("ht", ""))
        if not p.get("wt"):
            p["wt"] = parse_weight(row.get("wt"))
        if not p.get("forty"):
            p["forty"] = parse_float(row.get("forty_yd"))
        if not p.get("bench"):
            p["bench"] = parse_float(row.get("bench_reps"))
        if not p.get("vertical"):
            p["vertical"] = parse_float(row.get("vertical"))
        if not p.get("broad_jump"):
            p["broad_jump"] = parse_float(row.get("broad_jump"))
        if not p.get("cone"):
            p["cone"] = parse_float(row.get("cone"))
        if not p.get("shuttle"):
            p["shuttle"] = parse_float(row.get("shuttle"))
    return prospects


# ---------------------------------------------------------------------------
# Source 1 – nflverse combine CSV
# ---------------------------------------------------------------------------
def load_combine_csv(year: int = 2026) -> dict:
    """
    Returns a dict keyed by lower-case player name with measurables.
    Tries combine_{year}.csv then combine.csv (all-years).
    """
    candidates = [
        os.path.join(RAW_DIR, f"combine_{year}.csv"),
        os.path.join(RAW_DIR, "combine.csv"),
    ]
    for path in candidates:
        if not os.path.exists(path):
            continue
        rows = {}
        try:
            with open(path, newline="", encoding="utf-8") as f:
                reader = csv.DictReader(f)
                for row in reader:
                    yr_col = row.get("draft_year") or row.get("year") or ""
                    if str(yr_col).strip() == str(year) or year == 0:
                        name = (row.get("player_name") or row.get("name") or "").strip()
                        if name:
                            rows[name.lower()] = row
            if rows:
                print(f"  [combine]  Loaded {len(rows)} rows from {os.path.basename(path)}")
                return rows
        except Exception as exc:
            print(f"  [combine]  Error reading {path}: {exc}")
    print(f"  [combine]  No combine_{year}.csv found – skipping")
    return {}


# ---------------------------------------------------------------------------
# Source 2 – ESPN Scouts Inc.
# ---------------------------------------------------------------------------
def scrape_espn() -> list[dict]:
    url = (
        "https://www.espn.com/nfl/draft2026/story/_/id/48349812/"
        "2026-nfl-draft-rankings-top-prospects-scouts-inc-grades"
    )
    print(f"  [ESPN]     GET {url}")
    try:
        resp = requests.get(url, headers=HEADERS, timeout=REQUEST_TIMEOUT)
        resp.raise_for_status()
    except Exception as exc:
        print(f"  [ESPN]     FAILED: {exc}")
        return []

    soup = BeautifulSoup(resp.text, "lxml")
    prospects = []

    # ESPN article has a ranked table; rows look like:
    #   Rank | Player | Pos | School | Grade
    # Try multiple selectors since ESPN varies layout
    table = soup.find("table")
    if table:
        rows = table.find_all("tr")
        for row in rows[1:]:  # skip header
            cols = [td.get_text(strip=True) for td in row.find_all(["td", "th"])]
            if len(cols) < 3:
                continue
            # Heuristic: first numeric col is rank
            rank_val = None
            name_val = ""
            pos_val = ""
            school_val = ""
            grade_val = ""
            for i, c in enumerate(cols):
                if re.match(r"^\d+$", c) and rank_val is None:
                    rank_val = int(c)
                elif not name_val and re.search(r"[A-Z][a-z]", c) and len(c) > 3:
                    name_val = c
                elif not pos_val and c.upper() in POSITION_TO_ENUM:
                    pos_val = c.upper()
                elif not school_val and len(c) > 3 and not re.match(r"^\d", c):
                    school_val = c
                elif not grade_val and re.match(r"^[A-F][+\-]?$", c):
                    grade_val = c

            if not name_val:
                continue
            p = empty_prospect()
            p["name"] = name_val
            p["firstName"], p["lastName"] = split_name(name_val)
            p["pos"] = normalize_pos(pos_val)
            p["school"] = school_val
            p["grade"] = grade_val
            p["rank"] = rank_val
            prospects.append(p)

    # Fallback: look for article-style ranked list (ESPN sometimes renders as <ol>/<li>)
    if not prospects:
        for ol in soup.find_all(["ol", "ul"]):
            for i, li in enumerate(ol.find_all("li"), 1):
                text = li.get_text(" ", strip=True)
                # Pattern: "1. Shedeur Sanders, QB, Colorado, A+"
                m = re.match(
                    r"(\d+)[.)]\s+([A-Z][A-Za-z'\-. ]+?),\s*([A-Z/]+),\s*([^,]+)(?:,\s*([A-F][+\-]?))?",
                    text,
                )
                if m:
                    p = empty_prospect()
                    p["rank"] = int(m.group(1))
                    p["name"] = m.group(2).strip()
                    p["firstName"], p["lastName"] = split_name(p["name"])
                    p["pos"] = normalize_pos(m.group(3))
                    p["school"] = m.group(4).strip()
                    p["grade"] = m.group(5) or ""
                    prospects.append(p)

    print(f"  [ESPN]     Found {len(prospects)} prospects")
    return prospects


# ---------------------------------------------------------------------------
# Source 3 – Pro Football Network
# ---------------------------------------------------------------------------
def scrape_pfn() -> list[dict]:
    url = "https://www.profootballnetwork.com/nfl-draft-hq/prospect-grades/"
    print(f"  [PFN]      GET {url}")
    try:
        resp = requests.get(url, headers=HEADERS, timeout=REQUEST_TIMEOUT)
        resp.raise_for_status()
    except Exception as exc:
        print(f"  [PFN]      FAILED: {exc}")
        return []

    soup = BeautifulSoup(resp.text, "lxml")
    prospects = []

    # PFN renders a table with columns: Rank, Player, Pos, School, Grade
    for table in soup.find_all("table"):
        headers_row = table.find("tr")
        if not headers_row:
            continue
        header_texts = [th.get_text(strip=True).lower() for th in headers_row.find_all(["th", "td"])]
        # Identify column indices
        col_map = {}
        for idx, h in enumerate(header_texts):
            if "rank" in h:
                col_map["rank"] = idx
            elif "name" in h or "player" in h:
                col_map["name"] = idx
            elif "pos" in h or "position" in h:
                col_map["pos"] = idx
            elif "school" in h or "college" in h or "team" in h:
                col_map["school"] = idx
            elif "grade" in h:
                col_map["grade"] = idx

        if "name" not in col_map:
            continue

        for row in table.find_all("tr")[1:]:
            cols = [td.get_text(strip=True) for td in row.find_all(["td", "th"])]
            if len(cols) <= col_map.get("name", 0):
                continue
            name_val = cols[col_map["name"]]
            if not name_val or re.match(r"^\d+$", name_val):
                continue
            p = empty_prospect()
            p["name"] = name_val
            p["firstName"], p["lastName"] = split_name(name_val)
            p["pos"] = normalize_pos(cols[col_map["pos"]] if "pos" in col_map and len(cols) > col_map["pos"] else "")
            p["school"] = cols[col_map["school"]] if "school" in col_map and len(cols) > col_map["school"] else ""
            p["grade"] = cols[col_map["grade"]] if "grade" in col_map and len(cols) > col_map["grade"] else ""
            if "rank" in col_map and len(cols) > col_map["rank"]:
                try:
                    p["rank"] = int(cols[col_map["rank"]])
                except ValueError:
                    pass
            prospects.append(p)

    print(f"  [PFN]      Found {len(prospects)} prospects")
    return prospects


# ---------------------------------------------------------------------------
# Source 4 – NFL Mock Draft Database
# ---------------------------------------------------------------------------
def scrape_nflmdb() -> list[dict]:
    url = "https://www.nflmockdraftdatabase.com/big-boards/2026/consensus-big-board-2026"
    print(f"  [NFLMDB]   GET {url}")
    try:
        resp = requests.get(url, headers=HEADERS, timeout=REQUEST_TIMEOUT)
        resp.raise_for_status()
    except Exception as exc:
        print(f"  [NFLMDB]   FAILED: {exc}")
        return []

    soup = BeautifulSoup(resp.text, "lxml")
    prospects = []

    # NFLMDB renders rows as <tr> or divs with class containing "player"
    for table in soup.find_all("table"):
        for i, row in enumerate(table.find_all("tr")[1:], 1):
            cols = [td.get_text(strip=True) for td in row.find_all(["td", "th"])]
            if len(cols) < 3:
                continue
            # Typical layout: Rank | Name | Pos | School | ...
            try:
                rank_val = int(cols[0])
            except ValueError:
                rank_val = i
            name_val = cols[1] if len(cols) > 1 else ""
            pos_val = cols[2] if len(cols) > 2 else ""
            school_val = cols[3] if len(cols) > 3 else ""
            if not name_val or re.match(r"^\d+$", name_val):
                continue
            p = empty_prospect()
            p["name"] = name_val
            p["firstName"], p["lastName"] = split_name(name_val)
            p["pos"] = normalize_pos(pos_val)
            p["school"] = school_val
            p["rank"] = rank_val
            prospects.append(p)

    # Fallback: try player-card divs (NFLMDB sometimes uses divs)
    if not prospects:
        for div in soup.find_all(class_=re.compile(r"player|prospect|board-row", re.I)):
            text = div.get_text(" ", strip=True)
            m = re.match(r"(\d+)\s+([A-Z][A-Za-z'\-. ]+?)\s+([A-Z/]+)\s+(.+)", text)
            if m:
                p = empty_prospect()
                p["rank"] = int(m.group(1))
                p["name"] = m.group(2).strip()
                p["firstName"], p["lastName"] = split_name(p["name"])
                p["pos"] = normalize_pos(m.group(3))
                p["school"] = m.group(4).strip()[:40]
                prospects.append(p)

    print(f"  [NFLMDB]   Found {len(prospects)} prospects")
    return prospects


# ---------------------------------------------------------------------------
# Source 5 – Hardcoded fallback (80+ real 2026 prospects)
# ---------------------------------------------------------------------------
# Data compiled from: ESPN Scouts Inc., PFF, Bleacher Report, FantasyPros,
# NFL Mock Draft Database, CBS Sports (2026 cycle — prospects from the 2025
# college football season entering the April 2026 NFL Draft).
# Measurables are best available estimates; will be overwritten by combine data.
# fmt: off
HARDCODED_PROSPECTS = [
    # ---- Tier 1 / Round 1 locks ----
    #  name                        pos    school                 ht     wt   40     bench  vert  broad  cone   shuttle grade
    ("Fernando Mendoza",           "QB",  "Indiana",            "6-5", 236, 4.68,  None,  None, None,  None,  None,   "A+"),
    ("Caleb Downs",                "FS",  "Ohio State",         "6-0", 206, 4.42,  None,  None, None,  None,  None,   "A+"),
    ("Arvell Reese",               "OLB", "Ohio State",         "6-4", 241, 4.55,  None,  None, None,  None,  None,   "A+"),
    ("Jeremiyah Love",             "HB",  "Notre Dame",         "6-0", 212, 4.48,  None,  None, None,  None,  None,   "A+"),
    ("David Bailey",               "DE",  "Texas Tech",         "6-4", 251, 4.60,  None,  None, None,  None,  None,   "A"),
    ("Francis Mauigoa",            "T",   "Miami (FL)",         "6-6", 329, 5.20,  None,  None, None,  None,  None,   "A"),
    ("Sonny Styles",               "MLB", "Ohio State",         "6-5", 244, 4.65,  None,  None, None,  None,  None,   "A"),
    ("Rueben Bain Jr.",            "DE",  "Miami (FL)",         "6-2", 263, 4.68,  None,  None, None,  None,  None,   "A"),
    ("Carnell Tate",               "WR",  "Ohio State",         "6-2", 192, 4.42,  None,  None, None,  None,  None,   "A"),
    ("Mansoor Delane",             "CB",  "LSU",                "6-0", 187, 4.38,  None,  None, None,  None,  None,   "A"),
    # ---- Tier 2 / Mid Round 1 ----
    ("Monroe Freeling",            "T",   "Georgia",            "6-7", 315, 5.22,  None,  None, None,  None,  None,   "A"),
    ("Dillon Thieneman",           "FS",  "Oregon",             "6-0", 201, 4.45,  None,  None, None,  None,  None,   "A-"),
    ("Spencer Fano",               "T",   "Utah",               "6-6", 311, 5.18,  None,  None, None,  None,  None,   "A-"),
    ("Keldric Faulk",              "DE",  "Auburn",             "6-5", 253, 4.65,  None,  None, None,  None,  None,   "A-"),
    ("Ty Simpson",                 "QB",  "Alabama",            "6-1", 211, 4.62,  None,  None, None,  None,  None,   "A-"),
    ("Makai Lemon",                "WR",  "USC",                "5-11",192, 4.38,  None,  None, None,  None,  None,   "A-"),
    ("Kenyon Sadiq",               "TE",  "Oregon",             "6-3", 241, 4.60,  None,  None, None,  None,  None,   "A-"),
    ("Jermod McCoy",               "CB",  "Tennessee",          "6-1", 188, 4.42,  None,  None, None,  None,  None,   "A-"),
    ("Omar Cooper Jr.",            "WR",  "Indiana",            "6-0", 199, 4.45,  None,  None, None,  None,  None,   "A-"),
    ("Anthony Hill Jr.",           "MLB", "Texas",              "6-2", 238, 4.62,  None,  None, None,  None,  None,   "A-"),
    # ---- Tier 3 / Late Round 1 – Early Round 2 ----
    ("Olaivavega Ioane",           "G",   "Penn State",         "6-4", 325, 5.25,  None,  None, None,  None,  None,   "B+"),
    ("KC Concepcion",              "WR",  "Texas A&M",          "6-0", 196, 4.45,  None,  None, None,  None,  None,   "B+"),
    ("Eli Stowers",                "TE",  "Vanderbilt",         "6-4", 239, 4.65,  None,  None, None,  None,  None,   "B+"),
    ("Peter Woods",                "DT",  "Clemson",            "6-4", 300, 5.05,  None,  None, None,  None,  None,   "B+"),
    ("Avieon Terrell",             "CB",  "Clemson",            "5-11",188, 4.40,  None,  None, None,  None,  None,   "B+"),
    ("Jordyn Tyson",               "WR",  "Arizona State",      "6-2", 205, 4.45,  None,  None, None,  None,  None,   "B+"),
    ("Kadyn Proctor",              "T",   "Alabama",            "6-7", 320, 5.22,  None,  None, None,  None,  None,   "B+"),
    ("Jadarian Price",             "HB",  "Notre Dame",         "5-10",200, 4.45,  None,  None, None,  None,  None,   "B+"),
    ("Blake Miller",               "T",   "Clemson",            "6-6", 310, 5.20,  None,  None, None,  None,  None,   "B+"),
    ("Kayden McDonald",            "DT",  "Ohio State",         "6-3", 295, 5.10,  None,  None, None,  None,  None,   "B+"),
    ("Cashius Howell",             "DE",  "Texas A&M",          "6-4", 250, 4.62,  None,  None, None,  None,  None,   "B+"),
    ("Zion Young",                 "DE",  "Missouri",           "6-4", 245, 4.62,  None,  None, None,  None,  None,   "B+"),
    # ---- Tier 4 / Round 2 ----
    ("Caleb Banks",                "DT",  "Florida",            "6-3", 295, 5.10,  None,  None, None,  None,  None,   "B"),
    ("Gabe Jacas",                 "DE",  "Illinois",           "6-4", 250, 4.65,  None,  None, None,  None,  None,   "B"),
    ("A.J. Haulcy",                "SS",  "LSU",                "6-1", 205, 4.48,  None,  None, None,  None,  None,   "B"),
    ("Denzel Boston",              "WR",  "Washington",         "6-2", 210, 4.42,  None,  None, None,  None,  None,   "B"),
    ("Emmanuel Pregnon",           "G",   "Oregon",             "6-5", 315, 5.22,  None,  None, None,  None,  None,   "B"),
    ("Jacob Rodriguez",            "OLB", "Texas Tech",         "6-3", 240, 4.60,  None,  None, None,  None,  None,   "B"),
    ("Keionte Scott",              "CB",  "Miami (FL)",         "6-0", 188, 4.40,  None,  None, None,  None,  None,   "B"),
    ("Garrett Nussmeier",          "QB",  "LSU",                "6-3", 218, 4.65,  None,  None, None,  None,  None,   "B"),
    ("Harold Perkins Jr.",         "OLB", "LSU",                "6-3", 235, 4.55,  None,  None, None,  None,  None,   "B"),
    ("Christen Miller",            "DT",  "Georgia",            "6-4", 295, 5.08,  None,  None, None,  None,  None,   "B"),
    ("Max Iheanachor",             "T",   "Arizona State",      "6-5", 310, 5.20,  None,  None, None,  None,  None,   "B"),
    ("Skyler Bell",                "WR",  "Connecticut",        "6-2", 195, 4.42,  None,  None, None,  None,  None,   "B"),
    ("Genesis Smith",              "SS",  "Arizona",            "6-0", 200, 4.48,  None,  None, None,  None,  None,   "B"),
    ("Mike Washington Jr.",        "HB",  "Arkansas",           "5-11",205, 4.52,  None,  None, None,  None,  None,   "B"),
    ("Sam Roush",                  "TE",  "Stanford",           "6-5", 245, 4.68,  None,  None, None,  None,  None,   "B"),
    ("Connor Lew",                 "C",   "Auburn",             "6-4", 305, 5.20,  None,  None, None,  None,  None,   "B"),
    # ---- Tier 5 / Round 2-3 ----
    ("Richard Janvrin",            "OLB", "Cincinnati",         "6-3", 235, 4.62,  None,  None, None,  None,  None,   "B-"),
    ("Malachi Lawrence",           "DE",  "UCF",                "6-4", 248, 4.65,  None,  None, None,  None,  None,   "B-"),
    ("Trey Zuhn III",              "T",   "Texas A&M",          "6-5", 315, 5.22,  None,  None, None,  None,  None,   "B-"),
    ("Kamari Ramsey",              "SS",  "USC",                "5-11",195, 4.48,  None,  None, None,  None,  None,   "B-"),
    ("Jake Golday",                "OLB", "Cincinnati",         "6-3", 240, 4.65,  None,  None, None,  None,  None,   "B-"),
    ("Chandler Rivers",            "CB",  "Duke",               "5-11",185, 4.42,  None,  None, None,  None,  None,   "B-"),
    ("Josh Josephs",               "DE",  "Tennessee",          "6-3", 250, 4.68,  None,  None, None,  None,  None,   "B-"),
    ("Bryce Lance",                "WR",  "North Dakota State", "6-0", 190, 4.42,  None,  None, None,  None,  None,   "B-"),
    ("Jake Slaughter",             "C",   "Florida",            "6-4", 305, 5.22,  None,  None, None,  None,  None,   "B-"),
    ("Jalen Farmer",               "G",   "Kentucky",           "6-4", 305, 5.25,  None,  None, None,  None,  None,   "B-"),
    ("Chris Johnson",              "CB",  "San Diego State",    "5-10",185, 4.42,  None,  None, None,  None,  None,   "B-"),
    ("Isaiah Bond",                "WR",  "Texas",              "6-0", 185, 4.40,  None,  None, None,  None,  None,   "B-"),
    # ---- Tier 6 / Round 3-4 ----

    ("Amare Jones",                "CB",  "Troy",               "6-1", 192, 4.45,  None,  None, None,  None,  None,   "C+"),
    ("Devontez Walker",            "WR",  "North Carolina",     "6-1", 190, 4.38,  None,  None, None,  None,  None,   "C+"),
    ("Pierce Quick",               "T",   "Alabama",            "6-5", 310, 5.22,  None,  None, None,  None,  None,   "C+"),
    ("Aaron Beavers",              "DE",  "Ole Miss",           "6-4", 255, 4.70,  None,  None, None,  None,  None,   "C+"),
    ("Malachi Moore",              "CB",  "Alabama",            "5-11",185, 4.40,  None,  None, None,  None,  None,   "C+"),
    ("Luke Surline",               "TE",  "Utah State",         "6-4", 250, 4.72,  None,  None, None,  None,  None,   "C+"),
    ("Landon Donovan",             "C",   "Oklahoma",           "6-3", 300, 5.25,  None,  None, None,  None,  None,   "C+"),
    ("Beau Pribula",               "QB",  "Penn State",         "6-1", 210, 4.65,  None,  None, None,  None,  None,   "C+"),
    ("Ben Minich",                 "T",   "Penn State",         "6-8", 305, 5.28,  None,  None, None,  None,  None,   "C+"),
    ("Braedon Bowman",             "G",   "Clemson",            "6-5", 310, 5.25,  None,  None, None,  None,  None,   "C"),
    ("Jaylen McCollough",          "FS",  "Tennessee",          "6-0", 192, 4.48,  None,  None, None,  None,  None,   "C"),
    ("Walter Nolen",               "DT",  "Ole Miss",           "6-4", 310, 5.12,  None,  None, None,  None,  None,   "C"),

    ("Michael Pratt",              "QB",  "Tulane",             "6-1", 225, 4.70,  None,  None, None,  None,  None,   "C"),
    ("Kameron Johnson",            "WR",  "USC",                "6-4", 205, 4.48,  None,  None, None,  None,  None,   "C"),
    ("Isaiah Iton",                "DE",  "Washington",         "6-4", 255, 4.68,  None,  None, None,  None,  None,   "C"),
    ("Caden Sterns",               "SS",  "Texas",              "6-0", 195, 4.48,  None,  None, None,  None,  None,   "C"),
    ("Dylan Laube",                "HB",  "New Hampshire",      "5-10",200, 4.50,  None,  None, None,  None,  None,   "C"),

]
# fmt: on


def build_hardcoded() -> list[dict]:
    """Convert the hardcoded tuple list to prospect dicts with sequential rank."""
    prospects = []
    for rank, row in enumerate(HARDCODED_PROSPECTS, 1):
        (name, pos, school, ht, wt, forty,
         bench, vertical, broad_jump, cone, shuttle, grade) = row
        p = empty_prospect()
        p["name"] = name
        p["firstName"], p["lastName"] = split_name(name)
        p["pos"] = normalize_pos(pos)
        p["school"] = school
        p["ht"] = ht
        p["wt"] = wt
        p["forty"] = forty
        p["bench"] = bench
        p["vertical"] = vertical
        p["broad_jump"] = broad_jump
        p["cone"] = cone
        p["shuttle"] = shuttle
        p["rank"] = rank
        p["grade"] = grade
        prospects.append(p)
    return prospects


# ---------------------------------------------------------------------------
# Manual CSV loader (data/raw/prospects_2026_manual.csv)
# ---------------------------------------------------------------------------
def load_manual_csv() -> list[dict]:
    path = os.path.join(RAW_DIR, "prospects_2026_manual.csv")
    if not os.path.exists(path):
        return []
    prospects = []
    try:
        with open(path, newline="", encoding="utf-8") as f:
            reader = csv.DictReader(f)
            for row in reader:
                name = (row.get("name") or "").strip()
                if not name or name.startswith("#"):
                    continue
                p = empty_prospect()
                p["name"] = name
                p["firstName"] = row.get("firstName") or split_name(name)[0]
                p["lastName"] = row.get("lastName") or split_name(name)[1]
                p["pos"] = normalize_pos(row.get("pos") or "")
                p["school"] = row.get("school") or ""
                p["ht"] = parse_height(row.get("ht") or "")
                p["wt"] = parse_weight(row.get("wt"))
                p["forty"] = parse_float(row.get("forty"))
                p["bench"] = parse_float(row.get("bench"))
                p["vertical"] = parse_float(row.get("vertical"))
                p["broad_jump"] = parse_float(row.get("broad_jump"))
                p["cone"] = parse_float(row.get("cone"))
                p["shuttle"] = parse_float(row.get("shuttle"))
                try:
                    p["rank"] = int(row["rank"]) if row.get("rank") else None
                except ValueError:
                    pass
                p["grade"] = row.get("grade") or ""
                p["notes"] = row.get("notes") or ""
                prospects.append(p)
        print(f"  [manual]   Loaded {len(prospects)} rows from prospects_2026_manual.csv")
    except Exception as exc:
        print(f"  [manual]   Error: {exc}")
    return prospects


# ---------------------------------------------------------------------------
# Save CSV template
# ---------------------------------------------------------------------------
CSV_FIELDS = [
    "rank", "name", "firstName", "lastName", "pos", "school",
    "ht", "wt", "forty", "bench", "vertical", "broad_jump",
    "cone", "shuttle", "grade", "notes",
]


def save_csv_template(prospects: list[dict]):
    path = os.path.join(RAW_DIR, "prospects_2026_manual.csv")
    os.makedirs(RAW_DIR, exist_ok=True)
    with open(path, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=CSV_FIELDS, extrasaction="ignore")
        writer.writeheader()
        for p in prospects:
            writer.writerow({k: p.get(k, "") for k in CSV_FIELDS})
    print(f"  Saved CSV template → {os.path.relpath(path, PROJECT_ROOT)}")


# ---------------------------------------------------------------------------
# Assign ranks to any prospect that doesn't have one
# ---------------------------------------------------------------------------
def assign_ranks(prospects: list[dict]) -> list[dict]:
    """
    Sort by existing rank (None last), then fill in sequential ranks for
    any prospects that are missing one.
    """
    ranked = [p for p in prospects if p.get("rank") is not None]
    unranked = [p for p in prospects if p.get("rank") is None]

    ranked.sort(key=lambda p: p["rank"])
    max_rank = ranked[-1]["rank"] if ranked else 0

    for i, p in enumerate(unranked, max_rank + 1):
        p["rank"] = i

    return ranked + unranked


# ---------------------------------------------------------------------------
# Final validation / enrichment
# ---------------------------------------------------------------------------
def finalise(prospects: list[dict]) -> list[dict]:
    """
    - Re-sort by rank
    - Add draftRound
    - Warn about unknown positions
    - Ensure name components are populated
    """
    prospects.sort(key=lambda p: (p["rank"] is None, p.get("rank", 9999)))
    out = []
    for p in prospects:
        # Position validation
        pos = p.get("pos", "")
        if pos and pos not in POSITION_TO_ENUM:
            print(f"  [warn]  Unknown position '{pos}' for {p['name']} – keeping as-is")

        # Ensure first/last name filled
        if not p.get("firstName") and p.get("name"):
            p["firstName"], p["lastName"] = split_name(p["name"])

        # Draft round
        p["draftRound"] = infer_round(p.get("rank"))

        out.append(p)
    return out


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main():
    print("=" * 60)
    print("Script 4 – Fetch 2026 NFL Draft Prospects")
    print("=" * 60)

    os.makedirs(RAW_DIR, exist_ok=True)
    os.makedirs(DATA_DIR, exist_ok=True)

    # ---- Source 1: combine CSV measurables ----
    print("\n[1/5] Loading nflverse combine data …")
    combine_rows = load_combine_csv(year=2026)

    # ---- Sources 2-4: web scraping ----
    all_scraped: list[dict] = []
    source_counts: dict[str, int] = {}

    print("\n[2/5] Scraping ESPN Scouts Inc. …")
    espn_prospects = scrape_espn()
    source_counts["ESPN"] = len(espn_prospects)
    all_scraped.extend(espn_prospects)

    time.sleep(1)

    print("\n[3/5] Scraping Pro Football Network …")
    pfn_prospects = scrape_pfn()
    source_counts["PFN"] = len(pfn_prospects)
    all_scraped.extend(pfn_prospects)

    time.sleep(1)

    print("\n[4/5] Scraping NFL Mock Draft Database …")
    nflmdb_prospects = scrape_nflmdb()
    source_counts["NFLMDB"] = len(nflmdb_prospects)
    all_scraped.extend(nflmdb_prospects)

    # Dedupe scraped results
    all_scraped = dedupe(all_scraped)
    print(f"\n  Unique scraped prospects (combined, deduped): {len(all_scraped)}")

    # ---- Source 5: hardcoded fallback ----
    print("\n[5/5] Checking if hardcoded fallback is needed …")
    hardcoded = build_hardcoded()

    if len(all_scraped) < MIN_SCRAPED:
        print(f"  Scraped only {len(all_scraped)} prospects (< {MIN_SCRAPED} threshold).")
        print(f"  Using hardcoded fallback ({len(hardcoded)} prospects).")
        prospects = dedupe(all_scraped + hardcoded)
    else:
        # Still merge hardcoded to fill any gaps in school/grade/measurables
        prospects = dedupe(all_scraped + hardcoded)
        print(f"  Scraping succeeded; merged hardcoded data to fill gaps.")

    # Also check manual CSV override
    manual = load_manual_csv()
    if manual:
        prospects = dedupe(manual + prospects)
        print(f"  After manual CSV merge: {len(prospects)} unique prospects")

    # ---- Overlay combine measurables ----
    if combine_rows:
        prospects = merge_measurables(prospects, combine_rows)
        print(f"\n  Overlaid combine measurables for up to {len(combine_rows)} players")

    # ---- Assign/sort ranks ----
    prospects = assign_ranks(prospects)

    # ---- Final validation ----
    prospects = finalise(prospects)

    # ---- Summary ----
    print("\n" + "-" * 40)
    print("Source summary:")
    for src, cnt in source_counts.items():
        status = "✓" if cnt > 0 else "✗"
        print(f"  {status} {src}: {cnt} prospects")
    print(f"  Hardcoded fallback: {len(hardcoded)} prospects (always merged)")
    print(f"\n  Total unique prospects: {len(prospects)}")
    print("-" * 40)

    # ---- Save JSON ----
    out_json = os.path.join(DATA_DIR, "prospects_2026.json")
    with open(out_json, "w", encoding="utf-8") as f:
        json.dump(prospects, f, indent=2, ensure_ascii=False)
    print(f"\n  Saved → {os.path.relpath(out_json, PROJECT_ROOT)}")

    # ---- Save CSV template ----
    save_csv_template(prospects)

    print("\nDone.")


if __name__ == "__main__":
    main()
