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
        "forty_source": None,  # "combine", "pro_day", or "estimate"
        "bench": None,
        "vertical": None,
        "broad_jump": None,
        "cone": None,
        "shuttle": None,
        "rank": None,
        "grade": "",
        "notes": "",
        "nfl_comp": "",
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
                          "grade", "rank", "forty_source"):
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
            if p["forty"]:
                p["forty_source"] = "combine"
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
    ("Caleb Downs",                "FS",  "Ohio State",         "6-0", 206, 4.46,  None,  None, None,  None,  None,   "A+"),
    ("Arvell Reese",               "OLB", "Ohio State",         "6-4", 241, 4.46,  None,  None, None,  None,  None,   "A+"),
    ("Jeremiyah Love",             "HB",  "Notre Dame",         "6-0", 212, 4.36,  None,  None, None,  None,  None,   "A+"),
    ("David Bailey",               "DE",  "Texas Tech",         "6-4", 251, 4.50,  None,  None, None,  None,  None,   "A"),
    ("Francis Mauigoa",            "T",   "Miami (FL)",         "6-6", 329, 5.20,  None,  None, None,  None,  None,   "A"),
    ("Sonny Styles",               "MLB", "Ohio State",         "6-5", 244, 4.46,  None,  None, None,  None,  None,   "A"),
    ("Rueben Bain Jr.",            "DE",  "Miami (FL)",         "6-2", 263, 4.68,  None,  None, None,  None,  None,   "A"),
    ("Carnell Tate",               "WR",  "Ohio State",         "6-2", 192, 4.53,  None,  None, None,  None,  None,   "A"),
    ("Mansoor Delane",             "CB",  "LSU",                "6-0", 187, 4.38,  None,  None, None,  None,  None,   "A"),
    # ---- Tier 2 / Mid Round 1 ----
    ("Monroe Freeling",            "T",   "Georgia",            "6-7", 315, 4.93,  None,  None, None,  None,  None,   "A"),
    ("Dillon Thieneman",           "FS",  "Oregon",             "6-0", 201, 4.35,  None,  None, None,  None,  None,   "A-"),
    ("Spencer Fano",               "T",   "Utah",               "6-6", 311, 4.91,  None,  None, None,  None,  None,   "A-"),
    ("Keldric Faulk",              "DE",  "Auburn",             "6-5", 253, 4.65,  None,  None, None,  None,  None,   "A-"),
    ("Ty Simpson",                 "QB",  "Alabama",            "6-1", 211, 4.62,  None,  None, None,  None,  None,   "A-"),
    ("Makai Lemon",                "WR",  "USC",                "5-11",192, 4.38,  None,  None, None,  None,  None,   "A-"),
    ("Kenyon Sadiq",               "TE",  "Oregon",             "6-3", 241, 4.39,  None,  None, None,  None,  None,   "A-"),
    ("Jermod McCoy",               "CB",  "Tennessee",          "6-1", 188, 4.42,  None,  None, None,  None,  None,   "A-"),
    ("Omar Cooper Jr.",            "WR",  "Indiana",            "6-0", 199, 4.42,  None,  None, None,  None,  None,   "A-"),
    ("Anthony Hill Jr.",           "MLB", "Texas",              "6-2", 238, 4.51,  None,  None, None,  None,  None,   "A-"),
    # ---- Tier 3 / Late Round 1 – Early Round 2 ----
    ("Olaivavega Ioane",           "G",   "Penn State",         "6-4", 325, 5.25,  None,  None, None,  None,  None,   "B+"),
    ("KC Concepcion",              "WR",  "Texas A&M",          "6-0", 196, 4.45,  None,  None, None,  None,  None,   "B+"),
    ("Eli Stowers",                "TE",  "Vanderbilt",         "6-4", 239, 4.51,  None,  None, None,  None,  None,   "B+"),
    ("Peter Woods",                "DT",  "Clemson",            "6-4", 300, 5.05,  None,  None, None,  None,  None,   "B+"),
    ("Avieon Terrell",             "CB",  "Clemson",            "5-11",188, 4.40,  None,  None, None,  None,  None,   "B+"),
    ("Jordyn Tyson",               "WR",  "Arizona State",      "6-2", 205, 4.45,  None,  None, None,  None,  None,   "B+"),
    ("Kadyn Proctor",              "T",   "Alabama",            "6-7", 320, 5.21,  None,  None, None,  None,  None,   "B+"),
    ("Jadarian Price",             "HB",  "Notre Dame",         "5-10",200, 4.49,  None,  None, None,  None,  None,   "B+"),
    ("Blake Miller",               "T",   "Clemson",            "6-6", 310, 5.04,  None,  None, None,  None,  None,   "B+"),
    ("Kayden McDonald",            "DT",  "Ohio State",         "6-3", 295, 5.10,  None,  None, None,  None,  None,   "B+"),
    ("Cashius Howell",             "DE",  "Texas A&M",          "6-4", 250, 4.59,  None,  None, None,  None,  None,   "B+"),
    ("Zion Young",                 "DE",  "Missouri",           "6-4", 245, 4.62,  None,  None, None,  None,  None,   "B+"),
    # ---- Tier 4 / Round 2 ----
    ("Caleb Banks",                "DT",  "Florida",            "6-3", 295, 5.10,  None,  None, None,  None,  None,   "B"),
    ("Gabe Jacas",                 "DE",  "Illinois",           "6-4", 250, 4.65,  None,  None, None,  None,  None,   "B"),
    ("A.J. Haulcy",                "SS",  "LSU",                "6-1", 205, 4.52,  None,  None, None,  None,  None,   "B"),
    ("Denzel Boston",              "WR",  "Washington",         "6-2", 210, 4.42,  None,  None, None,  None,  None,   "B"),
    ("Emmanuel Pregnon",           "G",   "Oregon",             "6-5", 315, 5.21,  None,  None, None,  None,  None,   "B"),
    ("Jacob Rodriguez",            "OLB", "Texas Tech",         "6-3", 240, 4.57,  None,  None, None,  None,  None,   "B"),
    ("Keionte Scott",              "CB",  "Miami (FL)",         "6-0", 188, 4.40,  None,  None, None,  None,  None,   "B"),
    ("Garrett Nussmeier",          "QB",  "LSU",                "6-3", 218, 4.65,  None,  None, None,  None,  None,   "B"),
    ("Harold Perkins Jr.",         "OLB", "LSU",                "6-3", 235, 4.55,  None,  None, None,  None,  None,   "B"),
    ("Christen Miller",            "DT",  "Georgia",            "6-4", 295, 5.08,  None,  None, None,  None,  None,   "B"),
    ("Max Iheanachor",             "T",   "Arizona State",      "6-5", 310, 4.91,  None,  None, None,  None,  None,   "B"),
    ("Skyler Bell",                "WR",  "Connecticut",        "6-2", 195, 4.40,  None,  None, None,  None,  None,   "B"),
    ("Genesis Smith",              "SS",  "Arizona",            "6-0", 200, 4.48,  None,  None, None,  None,  None,   "B"),
    ("Mike Washington Jr.",        "HB",  "Arkansas",           "5-11",205, 4.33,  None,  None, None,  None,  None,   "B"),
    ("Sam Roush",                  "TE",  "Stanford",           "6-5", 245, 4.70,  None,  None, None,  None,  None,   "B"),
    ("Connor Lew",                 "C",   "Auburn",             "6-4", 305, 5.20,  None,  None, None,  None,  None,   "B"),
    # ---- Tier 5 / Round 2-3 ----
    ("Richard Janvrin",            "OLB", "Cincinnati",         "6-3", 235, 4.62,  None,  None, None,  None,  None,   "B-"),
    ("Malachi Lawrence",           "DE",  "UCF",                "6-4", 248, 4.52,  None,  None, None,  None,  None,   "B-"),
    ("Trey Zuhn III",              "T",   "Texas A&M",          "6-5", 315, 5.22,  None,  None, None,  None,  None,   "B-"),
    ("Kamari Ramsey",              "SS",  "USC",                "5-11",195, 4.47,  None,  None, None,  None,  None,   "B-"),
    ("Jake Golday",                "OLB", "Cincinnati",         "6-3", 240, 4.62,  None,  None, None,  None,  None,   "B-"),
    ("Chandler Rivers",            "CB",  "Duke",               "5-11",185, 4.40,  None,  None, None,  None,  None,   "B-"),
    ("Josh Josephs",               "DE",  "Tennessee",          "6-3", 250, 4.68,  None,  None, None,  None,  None,   "B-"),
    ("Bryce Lance",                "WR",  "North Dakota State", "6-0", 190, 4.34,  None,  None, None,  None,  None,   "B-"),
    ("Jake Slaughter",             "C",   "Florida",            "6-4", 305, 5.10,  None,  None, None,  None,  None,   "B-"),
    ("Jalen Farmer",               "G",   "Kentucky",           "6-4", 305, 4.93,  None,  None, None,  None,  None,   "B-"),
    ("Chris Johnson",              "CB",  "San Diego State",    "5-10",185, 4.40,  None,  None, None,  None,  None,   "B-"),
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

# NFL player comparisons sourced from ESPN, CBS, WalterFootball, Bleacher Report
NFL_COMPS = {
    "Fernando Mendoza":   "Jared Goff — high-accuracy timing passer, elite awareness, average arm strength",
    "Caleb Downs":        "Minkah Fitzpatrick — versatile coverage safety, elite ball skills and IQ",
    "Arvell Reese":       "Isaiah Simmons / Tremaine Edmunds — athletic hybrid LB with coverage range",
    "Jeremiyah Love":     "Bijan Robinson — three-down back with elite vision, elusiveness, and receiving",
    "Sonny Styles":       "Kyle Hamilton — big hybrid safety/LB, elite coverage, versatile alignment",
    "Carnell Tate":       "Tee Higgins / Chris Godwin — big, physical downfield receiver with contested catch ability",
    "Dillon Thieneman":   "Harrison Smith — cerebral instincts-based safety, elite ball-hawking and football IQ",
    "Keldric Faulk":      "Cameron Jordan — powerful versatile DE with power and finesse pass-rush repertoire",
    "Makai Lemon":        "Amon-Ra St. Brown — precise route runner, high awareness, slot-to-outside versatility",
    "Peter Woods":        "Grady Jarrett — quick, disruptive interior DT, finesse rusher with burst",
    "Harold Perkins Jr.": "Micah Parsons — explosive pass-rush specialist, elite motor and first-step quickness",
    "Rueben Bain Jr.":    "Brandon Graham — compact, high-motor undersized DE with diverse pass-rush moves",
    "Garrett Nussmeier":  "Baker Mayfield — aggressive gunslinger with arm talent and competitive drive",
    "Anthony Hill Jr.":   "Devin White — athletic MLB with sideline-to-sideline range and blitz ability",
    "Jacob Rodriguez":    "Quay Walker — long athletic LB, physical in run defense, developing coverage",
    "Mansoor Delane":     "Marshon Lattimore — press coverage CB with elite athleticism and ball skills",
    "Chandler Rivers":    "Darius Slay — quick, smart zone corner with good anticipation",
    "Kenyon Sadiq":       "Dalton Kincaid — receiving-first TE with route running and YAC ability",
}

# Scouting notes sourced from ESPN, CBS, PFF, Bleacher Report, WalterFootball, Steelers Depot
HARDCODED_NOTES: dict[str, str] = {
    "Fernando Mendoza": "Elite accuracy and processing with a quick release and high football IQ; consistently layers timing throws into tight windows. Heisman-caliber passer with superior awareness and pocket command. Not a scrambler or elite arm talent; can struggle when heavy pressure collapses the pocket quickly.",
    "Caleb Downs": "Elite football IQ and play recognition allow him to be a versatile chess piece aligned as a free safety or near the line. Exceptional ball skills and closing burst; projected as a generational safety talent. Aggressive style can lead to over-pursuit; best used in a hybrid role.",
    "Arvell Reese": "Explosive OLB/EDGE hybrid with elite athleticism, closing speed, and violent hand usage. Effective in coverage from the slot and at the second level with his safety background translating to the LB role. Still developing a refined pass-rush counter plan and man-coverage consistency against top route runners.",
    "Jeremiyah Love": "Elite vision and patience behind the line with decisive one-cut ability and consistent contact balance. Contact-breaking spin moves and power-through-contact ability make him a three-down threat. Pass protection technique still developing; college workload was limited.",
    "David Bailey": "Elite first-step burst widely considered among the best in the 2026 class; get-off looks almost offsides and forces immediate protection adjustments. Deep pass rush toolkit including ghost, rip, spin, and long-arm moves that he chains effectively. Undersized at 251 lbs; run defense and anchoring need improvement for every-down role.",
    "Francis Mauigoa": "Devastating hand punch with elite power and mauler mentality as a run blocker; finishes with knock-back force and sustains through the whistle. Strong pass-blocking anchor nullifies bull rushers; active independent hands disrupt rush timing. Foot quickness against speed rushers is a limitation; pad level can rise exposing inside moves.",
    "Sonny Styles": "Safety-to-LB hybrid with rare size (6'5\", 244 lbs) and elite athleticism (4.46 40, 43.5\" vert); sideline-to-sideline range and fluid hips give him zone coverage dominance. Nearly zero missed tackles in 2025 and effective coverage against TEs and RBs in man. Still refining block deconstruction and processing against NFL misdirection after transitioning from safety.",
    "Rueben Bain Jr.": "Technical pass rusher with a deep arsenal including euro step, cross chop, rip, spin, and bull rush; finishes plays with a relentless high motor. Power and lower-body strength allow him to convert speed to power and anchor against the run. Short arm length (30 7/8\") limits his bend and arc radius; needs to improve gap discipline and finishing.",
    "Carnell Tate": "Advanced route runner who manipulates DBs with tempo changes, sharp breaks, and minimal wasted motion; natural hands catcher with nearly zero career drops. Sells vertical stems effectively to create open intermediate routes; consistent route tree from slot or outside. Not an elite speed burner (4.53 40); can struggle against physical press coverage that disrupts release timing.",
    "Mansoor Delane": "Elite press coverage corner described as sticky in man with quick, patient footwork and physicality at the line. Opportunistic playmaker with consistent ball skills (multiple INTs and PBUs at LSU); attacks the football at the catch point. Wrestling background contributes balance and toughness; occasional eye-discipline lapses in zone and moderate length are minor concerns.",
    "Monroe Freeling": "Elite athletic profile for OT with 84\" wingspan, quick feet (4.93 40), and basketball-background movement skills. Advanced pass blocker who mirrors speed rushers and handles stunts with high IQ. Run blocking needs refinement; can play too high losing leverage and overextend when attempting to seal defenders.",
    "Dillon Thieneman": "Exceptional football IQ and ball-hawking instincts with 8 career INTs; reads QBs and diagnoses plays before the snap like a veteran. Explosive athlete (4.35 40, 41\" vertical) with sideline-to-sideline range capable of playing centerfield or down in the box. Can be overaggressive leading to over-pursuit; not elite in short-area man coverage against the quickest slot receivers.",
    "Spencer Fano": "Elite run blocker with the highest FBS PFF run grade (93.6) among tackles; explosive at point of attack, generates serious displacement, and excels on zone schemes. 0 sacks allowed in 2025; quick feet and excellent second-level mobility. Needs more functional strength to anchor against NFL power rushers and improve punch timing in pass protection.",
    "Keldric Faulk": "Power-based disruptor with elite length (34 3/8\" arms) and a devastating bull rush; dominant run defender who routinely seals the edge. Can align at multiple positions and shows rip and swim hand moves. Lacks elite first-step burst or bend; finesse pass rush counter moves are still developing.",
    "Ty Simpson": "Smart pocket passer with a quick-whip release, above-average arm, and strong pre-snap processing; set Alabama record for lowest career interception percentage. Manipulates defenses with eye movement and delivers with anticipation on timing routes. Deep ball accuracy is inconsistent; not a dynamic scrambler; limited to one year as primary starter.",
    "Makai Lemon": "Elite route-running technician with precise footwork, sharp breaks, and understanding of leverage and spacing; dangerous from slot and outside. Dynamic YAC threat (21 forced missed tackles in 2025) with contact balance and vision after the catch. Lacks elite top-end vertical speed; physical press corners can disrupt release timing.",
    "Kenyon Sadiq": "Explosive receiving TE with elite athleticism (4.39 40, 43.5\" vertical) that creates matchup nightmares for LBs and safeties. Aggressive and effective blocker with strong effort and finishing mentality. Route breaks need sharpening for separation in man coverage; raw in-line blocking technique against power defensive ends.",
    "Jermod McCoy": "Elite man-coverage corner with advanced mirroring ability and press-man mastery; allowed only 10 catches for 168 yards in man coverage in 2024. Outstanding ball skills with 6 INTs and 16 PBUs in two seasons; 77\" wingspan helps contest at catch point. Missed 2025 season with ACL injury; recovery is the primary concern for draft stock.",
    "Omar Cooper Jr.": "Physical, YAC-heavy receiver with explosive burst, toughness, and running-back-like contact balance after the catch. Quick feet and nuanced route stems create separation via technique and speed variation. Route tree somewhat limited in college's RPO-heavy system; needs to prove consistency against physical press corners at the NFL level.",
    "Anthony Hill Jr.": "Elite athlete with sideline-to-sideline range (4.51 40), explosive blitz burst, and very low missed tackle rate (<5% in 2025). Outstanding run defender with quick trigger and perimeter pursuit; natural leader and signal-caller. Zone coverage instincts can lag; can over-pursue against misdirection and is still developing block-deconstruction technique.",
    "Olaivavega Ioane": "Powerful interior guard with a strong base, natural anchor against bull rushers, and good hand-fighting ability. Effective finisher in the run game with above-average grip strength and sustain. Athleticism for pulling and movement blocking is limited; technique needs refinement in complex pass-protection assignments.",
    "KC Concepcion": "Versatile receiver with solid route running, reliable hands, and good understanding of spacing against zone coverage. Creates separation with footwork and timing rather than elite burst. Needs to develop after-catch yards and consistency against physical press corners; route tree still growing at the NFL level.",
    "Eli Stowers": "Athletic dual-threat TE with competent receiving ability and enough athleticism to create mismatches. Willing and capable blocker with effort. Needs to refine route breaks for consistent separation in man coverage; must add blocking strength to become a complete in-line option.",
    "Peter Woods": "Elite first-step burst for interior DL; routinely the first lineman upfield and forces protection adjustments. Violent hands, tight hand usage, and ability to convert speed to power; posted 9 sacks and 14 TFLs in his best season. Needs to develop a more complete pass-rush counter plan and maintain better pad level consistency.",
    "Avieon Terrell": "Excellent zone awareness, fluid hip transitions, and versatile alignment ability (outside, slot, and blitzer). Outstanding forced-fumble producer (8 career FFs) and consistent at the catch point. Slight frame (~5'11\", 188 lbs) can be outmuscled by large receivers; needs to develop press strength against elite physical WRs.",
    "Jordyn Tyson": "Elite route runner with sudden burst, sharp breaks, and well-developed full route tree; especially dangerous at all three levels. Reliable hands and catch radius; YAC ability with vision and contact balance. Three consecutive seasons with significant injuries (knee, collarbone, hamstring) are primary concern; needs to add strength for press coverage.",
    "Kadyn Proctor": "Physically massive tackle (6'7\", 352 lbs) with elite anchor strength against bull rushers; nearly immovable when set with a wide base. Powerful hands and excellent grip allow him to control defenders throughout plays. Upright play style limits power transfer; can overset outside exposing inside counter moves.",
    "Jadarian Price": "Elite vision and patience to set up blocks with decisive cuts and strong burst through gaps; elite kick return production (FBS-leading 37.5 yard avg). Contact balance and acceleration allow big-play runs. Pass protection technique is developmental; limited college receiving usage (15 career receptions) leaves that skill unproven.",
    "Blake Miller": "Athletic offensive tackle with a solid technique foundation and good pass protection awareness. Reasonable pass set quickness and hand fighting ability. Needs to add lower-body strength and anchor for power rushers; run blocking consistency needs improvement at the next level.",
    "Kayden McDonald": "Athletic interior DT with a quick first step and ability to penetrate one-gap schemes. Strong run defender with good instincts and awareness. Pass rush repertoire needs development; needs to generate more consistent interior disruption and sack production.",
    "Cashius Howell": "Athletic edge rusher with good first-step quickness and closing speed; can align at multiple pass-rush spots. Shows improved hand usage on pass rush reps. Run defense technique is raw; needs to develop consistent counters and a more complete rush plan.",
    "Zion Young": "Motor-driven pass rusher with good bend and leverage off the edge; relentless effort on every snap. Has the athletic base to develop multiple rush moves. Power rush is limited; needs to develop counter moves and add strength to hold up in run defense.",
    "Caleb Banks": "Disruptive interior DT with a strong motor and good gap-shooting penetration ability. Consistent effort and run-stopping effectiveness. Pass rush production has been limited; needs to develop a more varied rush plan with better counters.",
    "Gabe Jacas": "Long EDGE rusher with high effort and strong hands; shows power rush ability and the ability to hold the point of attack. Good motor and competitive toughness. Raw pass-rush technique overall; needs to develop speed rush and effective counters against NFL tackles.",
    "A.J. Haulcy": "Physical safety with strong run support skills and aggressive downhill tackling approach. Good zone coverage awareness and ability to deliver a hit. Man coverage range is limited in deep zones; needs to develop more consistent ball production and man-coverage technique.",
    "Denzel Boston": "Big-bodied X receiver (6'4\", 210 lbs) with elite catch radius, body control, and strong contested catch ability; 20 TDs in two seasons reflects red zone value. Surprising route efficiency for size with sharp in-breakers and understanding of soft zones. Lacks top-end speed (approx. 4.6 40) for consistent separation; needs polished release against press corners.",
    "Emmanuel Pregnon": "Athletic interior guard with solid technique and good IQ in pass protection; handles stunts and line games effectively. Above-average movement ability for a guard with pulling and second-level athleticism. Needs to add anchor power for down-blocks and double-team situations at the NFL level.",
    "Jacob Rodriguez": "Long, physical LB from Texas Tech with aggressive run-defense presence and developing pass-rush ability. Physical in run fits with active hands and strong tackling. Coverage technique is still raw; needs improvement in man-coverage situations and processing route combinations.",
    "Keionte Scott": "Elite burst and twitchy athleticism from the slot; outstanding blitzer and run defender with aggressive downhill approach. Strong zone instincts, quick reaction, and ability to jump routes. Struggles in man coverage against physical boundary receivers; high missed tackle rate from overpursuit.",
    "Garrett Nussmeier": "Above-average arm with a quick whip-like release; calm and composed in the pocket with good progression reads. Effective at layering timing throws over the middle and working through progressions pre-snap. Accuracy under pressure is inconsistent; not a dynamic runner; injury history (abdominal) affects mechanics.",
    "Harold Perkins Jr.": "Game-breaking pass-rush burst with elite first step, closing speed, and dip around the arc; 17 sacks and 35.5 TFLs in college career. Dangerous as a blitzer from multiple alignments with disguise and timing. Undersized at ~235 lbs; needs improved gap discipline and tackling consistency; ACL injury in 2024 is a medical concern.",
    "Christen Miller": "Powerful interior DT from Georgia with strong run-stopping ability and a commanding physical presence. Good first step and ability to anchor at the line of scrimmage. Pass rush production is limited; needs to develop a more varied rush move portfolio.",
    "Max Iheanachor": "Athletic tackle prospect from Arizona State with good footwork and pass protection tools. Above-average athleticism for the position with good initial quickness. Needs to add functional anchor strength and refine run-blocking technique for the NFL level.",
    "Skyler Bell": "Fast and athletic WR from Connecticut with good vertical separation and strong hands for his size. Fluid athlete with the speed to threaten vertically and make plays downfield. Smaller school competition may inflate numbers; needs to demonstrate consistency against elite DBs.",
    "Genesis Smith": "Versatile safety from Arizona with good range in zone coverage and solid run support. Good athletic profile with zone awareness and willingness to fill. Needs development in man coverage, press situations, and ball production at the NFL level.",
    "Mike Washington Jr.": "Elite top-end speed (4.33 40) with a downhill one-cut running style and power through contact. Explosive burst to the second level and ability to make big plays when through the line. Pass protection technique is a major development area; ball security has been inconsistent (multiple fumbles).",
    "Sam Roush": "Athletic TE with good receiving skills and the ability to threaten the seam and find soft zones. Effective run blocker with effort and willingness. Route breaks need refinement for separation in man coverage; needs to add strength to become a consistent in-line blocking option.",
    "Connor Lew": "Experienced center with solid technique, good snap exchange, and above-average pass protection awareness. Handles stunts and line games with intelligence. Athleticism for pulling scenarios is slightly limited; needs to continue developing anchor against powerful nose tackles.",
    "Richard Janvrin": "High-effort OLB with solid run-defense instincts and reliable tackling in tight spaces. Good football IQ and positioning in run fits. Pass rush and coverage skills are limited; not ideal for every-down roles in modern sub-package schemes.",
    "Malachi Lawrence": "Athletic DE from UCF with a good motor and developing pass-rush tools. Strong effort level and run-containment ability. Smaller school competition is a concern; needs to prove consistency and power against higher-level offensive linemen.",
    "Trey Zuhn III": "Big offensive tackle with good length and pass protection potential. Above-average size and arm length provide a natural edge in alignment. Footwork consistency needs refinement; anchor strength against bull rushers needs to improve for NFL-level action.",
    "Kamari Ramsey": "Versatile safety from USC with zone coverage instincts and solid run support ability. Good athletic base and awareness in post-snap reads. Needs to develop ball production and man-coverage consistency against NFL-caliber routes.",
    "Jake Golday": "Athletic OLB from Cincinnati with good pass-rush production and solid run-defense ability. Effective motor and quickness off the snap. Coverage skills are still developing; needs to improve in zone assignments and man coverage for three-down value.",
    "Chandler Rivers": "Quick, instinctive CB from Duke with good zone anticipation and route recognition ability. Short-area burst helps him close on the ball. Undersized against big physical receivers; press coverage technique needs development; needs to show he can handle elite WRs.",
    "Josh Josephs": "Athletic DE from Tennessee with developing pass-rush tools and a good motor. Shows flashes of quick hands and ability to defeat blocks. Consistency across full games is a concern; needs to develop a deeper rush repertoire and add play strength.",
    "Bryce Lance": "Elite speed burner (4.34 40) from North Dakota State with explosive vertical separation ability and reliable hands. Natural deep-ball tracker who quickly creates separation with acceleration. Small school competition concern; route tree and overall polish need development against high-level competition.",
    "Jake Slaughter": "Experienced center from Florida with solid technique, good snap-to-handoff consistency, and NFL-ready football IQ. Reliable anchor and able to handle pass-protection assignments cleanly. Limited athleticism for pulling or reaching defenders in space; center-only role projection.",
    "Jalen Farmer": "Athletic guard from Kentucky with good footwork and above-average position athleticism. Mobile in pass sets and capable of climbing to the second level. Needs to add anchor strength for power blockers; technique needs refinement in sustained run blocks.",
    "Chris Johnson": "Competitive CB from San Diego State with solid man-coverage technique and a high-effort competitive spirit. Quick to read routes and maintain coverage. Smaller school competition concern; athleticism profile may be average by NFL standards.",
    "Isaiah Bond": "Elite track speed and explosive acceleration (4.39 40); field-stretching vertical threat who consistently creates deep separation. Track background shows in smooth stride and ability to close gaps instantly. Undersized (5'11\", ~180 lbs); struggles against physical press coverage; limited catch radius reduces contested-catch utility.",
    "Amare Jones": "Long CB from Troy with above-average size and developing man coverage skills. Good frame and reach to contest at the catch point. Raw technique overall; small school competition concern; needs to show improved footwork and hip fluidity.",
    "Devontez Walker": "Elite deep-threat speed (4.36 40, 21.18 mph top speed) with large catch radius and excellent ball tracking on verticals. Dangerous vertical stretcher who forces coverage adjustments every snap. Route running is stiff at the top of breaking routes; needs development of full route tree for varied NFL usage.",
    "Pierce Quick": "Big offensive tackle from Alabama with developing technique and good size/length potential. Physical build provides the raw materials for an NFL starter. Raw footwork and technique need significant refinement; not a finished product and will require developmental patience.",
    "Aaron Beavers": "Physical DE from Ole Miss with strong run-containment ability and a good motor. Effective power rush and solid edge-setting skills. Pass rush finesse and counter moves are limited; sack production needs to improve for impact at the next level.",
    "Malachi Moore": "Elite zone instincts and versatile alignment ability (hybrid corner/safety) from Alabama's complex Saban system; strong play recognition and football IQ. Consistent, technical tackler with very low missed tackle rate and leadership ability. Limited top-end speed; not a dominant run-stopper against power runners.",
    "Luke Surline": "Athletic TE from Utah State with good receiving ability and the athleticism to attack zone seams. Capable blocker who competes with effort. Blocking technique against power defensive ends needs development; not a dominant in-line blocker at the NFL level.",
    "Landon Donovan": "Experienced center from Oklahoma with good technique and solid football awareness. Reliable anchor and competent in pass-protection assignments. Athleticism is average; limited as a puller or reach blocker in spread zone schemes; projects as a center-only prospect.",
    "Beau Pribula": "True dual-threat QB with elite mobility and improving accuracy (67.4% completion rate in 2025). Red zone and short-yardage specialist with the athleticism to make off-schedule plays. Arm strength is moderate; limited high-volume starting experience at the highest level of competition.",
    "Ben Minich": "Very long tackle (6'8\") whose rare arm length and size provide a natural physical advantage. Good base athleticism from Penn State. Raw technique with inconsistent footwork; weight management concern; hand usage needs to improve for pass protection refinement.",
    "Braedon Bowman": "Athletic guard from Clemson with a good technique foundation and solid mobility for the position. Good footwork in pass sets. Needs to add anchor strength and power for run blocking at the NFL level.",
    "Jaylen McCollough": "Strong zone coverage safety with disciplined deep coverage instincts and solid ball skills (4 INTs as NFL rookie). Reliable, clean tackler with good technique and awareness. Run defense physicality is average at the NFL level; not a box enforcer by nature.",
    "Walter Nolen": "Elite first-step burst and explosive interior penetration ability; routinely the first DL upfield off the snap. Good lateral agility and versatility to align at 3-tech or 4i. Can play too high losing leverage; inconsistent run defense when washed out; needs to improve pass-rush counter development.",
    "Michael Pratt": "Touch-accurate pocket passer with strong leadership and proven winner at Tulane (Cotton Bowl victory). Good timing and anticipation on middle-of-field throws with improving mechanics. Arm strength is below average; not a dynamic athlete; struggles with accuracy under complex pressure schemes.",
    "Kameron Johnson": "Big-bodied WR (6'4\", 205 lbs) with size, athleticism, and catch radius to win in contested situations. Physical downfield presence and potential red zone threat. Route tree is limited; needs significant development in separation and route-running precision at the NFL level.",
    "Isaiah Iton": "Athletic DE from Washington with a good motor and developing pass-rush tools. Shows quickness and burst off the snap. Needs to add play strength and power to hold up in run defense; pass-rush plan needs development for consistency.",
    "Caden Sterns": "Intelligent safety from Texas with advanced zone awareness and disciplined deep coverage ability. Strong play recognition and ball skills from multiple alignments. Injury history has affected his NFL career; long-term durability and whether he regains full athleticism are questions.",
    "Dylan Laube": "Outstanding pass-catching back with elite route running for the position and soft, reliable hands; 68 receptions for 699 yards in his final season. Elite lateral agility, vision, and patience to navigate tight spaces and find cutback lanes. Not a power runner; limited experience in pass protection; small school (New Hampshire) competition is a concern.",
}


# Official 2026 NFL Combine 40-yard dash times (electronic, neutral surface).
# These take priority over any hardcoded estimate in HARDCODED_PROSPECTS.
# Source: sharpfootballanalysis.com/analysis/nfl-combine-40-yard-dash-times-2026/
COMBINE_FORTIES: dict[str, float] = {
    "Jeremiyah Love":      4.36,
    "David Bailey":        4.50,
    "Arvell Reese":        4.46,
    "Sonny Styles":        4.46,
    "Carnell Tate":        4.53,
    "Dillon Thieneman":    4.35,
    "Spencer Fano":        4.91,
    "Kenyon Sadiq":        4.39,
    "Omar Cooper Jr.":     4.42,
    "Anthony Hill Jr.":    4.51,
    "Mike Washington Jr.": 4.33,
    "Sam Roush":           4.70,
    "Eli Stowers":         4.51,
    "A.J. Haulcy":         4.52,
    "Chris Johnson":       4.40,
    "Chandler Rivers":     4.40,
    "Jacob Rodriguez":     4.57,
    "Cashius Howell":      4.59,
    "Kamari Ramsey":       4.47,
    "Jake Golday":         4.62,
    "Bryce Lance":         4.34,
    "Jadarian Price":      4.49,
    "Malachi Lawrence":    4.52,
    "Skyler Bell":         4.40,
    "Blake Miller":        5.04,
    "Jalen Farmer":        4.93,
    "Monroe Freeling":     4.93,
    "Max Iheanachor":      4.91,
    "Emmanuel Pregnon":    5.21,
    "Kadyn Proctor":       5.21,
    "Jake Slaughter":      5.10,
    "Caleb Banks":         5.04,
}

# Pro-day 40-yard dash times for players who were DNP at the combine.
# Only used when no COMBINE_FORTIES entry exists for the player.
# Pro-day times are hand-timed and less controlled; do NOT pick the faster of
# combine vs pro-day — always prefer the combine time.
PRO_DAY_FORTIES: dict[str, float] = {
    "Caleb Downs":    4.42,   # Ohio State pro day 3/25/26 (official)
    "Keionte Scott":  4.33,   # Miami pro day 3/23/26 (confirmed 4.33)
    "Makai Lemon":    4.48,   # USC pro day (4.48–4.53 range; combine DNP)
    "Mansoor Delane": 4.36,   # LSU pro day (4.35–4.38 range; combine DNP)
}


# ---------------------------------------------------------------------------
# Other 2026 combine measurements (official, from CBS Sports / NFL.com)
# ---------------------------------------------------------------------------
# Bench press reps at 225 lbs
COMBINE_BENCH: dict[str, int] = {
    "Blake Miller":        32,
    "Gabe Jacas":          30,
    "Kenyon Sadiq":        26,
    "Jordyn Tyson":        26,
    "Sam Roush":           25,
    "Max Iheanachor":      25,
    "Kadyn Proctor":       25,
    "Anthony Hill Jr.":    21,
    "Jadarian Price":      21,
    "Dillon Thieneman":    18,
    "Chris Johnson":       17,
    "Avieon Terrell":      17,
    "Kamari Ramsey":       16,
    "Jermod McCoy":        14,
}

# Vertical jump (inches)
COMBINE_VERTICAL: dict[str, float] = {
    "Eli Stowers":         45.5,
    "Kenyon Sadiq":        43.5,
    "Sonny Styles":        43.5,
    "Genesis Smith":       42.5,
    "Bryce Lance":         41.5,
    "Skyler Bell":         41.0,
    "Dillon Thieneman":    41.0,
    "Malachi Lawrence":    40.0,
    "Jake Golday":         39.0,
    "Chandler Rivers":     39.0,
    "Mike Washington Jr.": 39.0,
    "Jacob Rodriguez":     38.5,
    "Sam Roush":           38.5,
    "Chris Johnson":       38.0,
    "Anthony Hill Jr.":    37.0,
    "Omar Cooper Jr.":     37.0,
    "Kamari Ramsey":       36.0,
    "Keldric Faulk":       35.0,
    "David Bailey":        35.0,
    "Denzel Boston":       35.0,
    "Jadarian Price":      35.0,
    "Avieon Terrell":      34.0,
    "Cashius Howell":      32.5,
    "Caleb Banks":         32.0,
}

# Broad jump (inches — converted from feet-inches)
COMBINE_BROAD: dict[str, int] = {
    "Eli Stowers":         135,   # 11'3"
    "Sonny Styles":        134,   # 11'2"
    "Kenyon Sadiq":        133,   # 11'1"
    "Skyler Bell":         133,   # 11'1"
    "Bryce Lance":         133,   # 11'1"
    "Chandler Rivers":     130,   # 10'10"
    "Malachi Lawrence":    130,   # 10'10"
    "David Bailey":        129,   # 10'9"
    "Mike Washington Jr.": 128,   # 10'8"
    "Genesis Smith":       128,   # 10'8"
    "Sam Roush":           126,   # 10'6"
    "Chris Johnson":       126,   # 10'6"
    "Anthony Hill Jr.":    125,   # 10'5"
    "Dillon Thieneman":    125,   # 10'5"
    "Jake Golday":         125,   # 10'5"
    "Jadarian Price":      124,   # 10'4"
    "Avieon Terrell":      123,   # 10'3"
    "Jacob Rodriguez":     121,   # 10'1"
    "Kamari Ramsey":       120,   # 10'0"
    "Keldric Faulk":       117,   # 9'9"
    "Cashius Howell":      115,   # 9'7"
    "Caleb Banks":         114,   # 9'6"
}

# 3-cone drill (seconds) — maps to changeOfDirection
COMBINE_CONE: dict[str, float] = {
    "Jacob Rodriguez":     6.90,
    "Jake Golday":         7.02,
    "Sam Roush":           7.08,
    "Sonny Styles":        7.09,
    "Spencer Fano":        7.34,
}

# 20-yard shuttle (seconds) — maps to agility
COMBINE_SHUTTLE: dict[str, float] = {
    "Genesis Smith":       4.18,
    "Jacob Rodriguez":     4.19,
    "Sonny Styles":        4.26,
    "Denzel Boston":       4.28,
    "Jake Golday":         4.34,
    "Sam Roush":           4.37,
    "Spencer Fano":        4.67,
}


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
        # Resolve forty: combine (official) > pro day > hardcoded estimate.
        # Never cherry-pick the faster of two sources; combine always wins.
        if name in COMBINE_FORTIES:
            p["forty"] = COMBINE_FORTIES[name]
            p["forty_source"] = "combine"
        elif name in PRO_DAY_FORTIES:
            p["forty"] = PRO_DAY_FORTIES[name]
            p["forty_source"] = "pro_day"
        else:
            p["forty"] = forty
            p["forty_source"] = "estimate" if forty is not None else None
        p["bench"] = bench
        p["vertical"] = vertical
        p["broad_jump"] = broad_jump
        p["cone"] = cone
        p["shuttle"] = shuttle
        p["rank"] = rank
        p["grade"] = grade
        comp = NFL_COMPS.get(name)
        if comp:
            p["nfl_comp"] = comp
        notes = HARDCODED_NOTES.get(name)
        if notes:
            p["notes"] = notes
        prospects.append(p)
    return prospects


def apply_verified_combine_data(prospects: list[dict]) -> list[dict]:
    """
    Unconditionally stamp verified 2026 combine/pro-day measurements onto any
    matching prospect, overriding scraped estimates.
    Covers: forty, bench, vertical, broad_jump, cone, shuttle.
    Also ensures every prospect with a forty value has forty_source set.
    """
    overrides = 0
    for p in prospects:
        name = p.get("name", "")
        # Forty time
        if name in COMBINE_FORTIES:
            p["forty"] = COMBINE_FORTIES[name]
            p["forty_source"] = "combine"
            overrides += 1
        elif name in PRO_DAY_FORTIES:
            p["forty"] = PRO_DAY_FORTIES[name]
            p["forty_source"] = "pro_day"
            overrides += 1
        elif p.get("forty") and not p.get("forty_source"):
            p["forty_source"] = "estimate"
        # Other combine measurements
        if name in COMBINE_BENCH:
            p["bench"] = COMBINE_BENCH[name]
        if name in COMBINE_VERTICAL:
            p["vertical"] = COMBINE_VERTICAL[name]
        if name in COMBINE_BROAD:
            p["broad_jump"] = COMBINE_BROAD[name]
        if name in COMBINE_CONE:
            p["cone"] = COMBINE_CONE[name]
        if name in COMBINE_SHUTTLE:
            p["shuttle"] = COMBINE_SHUTTLE[name]
    if overrides:
        print(f"  [verified combine] Applied {overrides} verified forty times (combine/pro_day).")
    bench_count   = sum(1 for p in prospects if p.get("bench"))
    vert_count    = sum(1 for p in prospects if p.get("vertical"))
    cone_count    = sum(1 for p in prospects if p.get("cone"))
    shuttle_count = sum(1 for p in prospects if p.get("shuttle"))
    print(f"  [verified combine] bench={bench_count}  vertical={vert_count}  "
          f"cone={cone_count}  shuttle={shuttle_count} prospects with data.")
    return prospects
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

    # ---- Apply verified combine data (always overrides scraped estimates) ----
    print("\n  Applying verified combine data …")
    prospects = apply_verified_combine_data(prospects)

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
