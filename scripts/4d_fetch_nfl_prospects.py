"""
Script 4d — Fetch NFL.com's 2026 prospect database.

Uses the same API that powers nfl.com/draft/tracker/2026/prospects.
Pulls Lance Zierlein's structured scouting profiles (overview, strengths,
weaknesses, NFL comparison, grade) plus the full combine measurables and
ACTUAL draft results (team + overall pick).

Outputs:
  data/prospects_2026.json      — full prospect list (~400), including all
                                  existing hand-curated entries
  data/prospect_profiles.json   — structured strengths/weaknesses/nfl_comp
                                  keyed by normalized name, consumed by
                                  script 5's LLM prompt builder

Replaces the hand-coded tables in `4c_apply_actual_draft.py` and the
handwritten profiles previously maintained in `prospect_profiles.json`.

Run:
    python scripts/4d_fetch_nfl_prospects.py
"""

import html as htmllib
import io
import json
import os
import re
import sys
import uuid

import requests

# Force UTF-8 stdout on Windows so unicode in comments/strings doesn't crash.
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

SCRIPT_DIR   = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(SCRIPT_DIR)
DATA_DIR     = os.path.join(PROJECT_ROOT, "data")
PROSPECTS_FILE = os.path.join(DATA_DIR, "prospects_2026.json")
PROFILES_FILE  = os.path.join(DATA_DIR, "prospect_profiles.json")

# Public web client credentials used by nfl.com/draft/tracker. These are
# baked into the published JS bundle (not a secret).
NFL_CLIENT_KEY    = "4cFUW6DmwJpzT9L7LrG3qRAcABG5s04g"
NFL_CLIENT_SECRET = "CZuvCL49d9OwfGsR"
TOKEN_URL         = "https://api.nfl.com/identity/v3/token"
PROFILES_URL      = "https://api.nfl.com/football/v2/prospects/profiles?limit=1000&year=2026"
REPORT_URL        = "https://api.nfl.com/football/v2/prospects/draft/report?limit=1000&year=2026"

BROWSER_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)

# NFL.com position code > our Madden canonical position
POS_MAP = {
    "QB":  "QB",
    "RB":  "HB",
    "FB":  "FB",
    "WR":  "WR",
    "TE":  "TE",
    "OT":  "T",
    "T":   "T",
    "G":   "G",
    "OG":  "G",
    "C":   "C",
    "OL":  "G",     # generic — won't know T/G without more signal; default G
    "EDGE":"DE",
    "DE":  "DE",
    "DT":  "DT",
    "NT":  "DT",
    "LB":  "OLB",   # default outside linebacker; MLB split below by positionGroup
    "OLB": "OLB",
    "ILB": "MLB",
    "MLB": "MLB",
    "CB":  "CB",
    "SAF": "FS",    # default free safety; heavy-box safety handled by weight below
    "S":   "FS",
    "FS":  "FS",
    "SS":  "SS",
    "K":   "K",
    "P":   "P",
    "LS":  "LS",
}

NFL_TEAM_ID_TO_ABBR = {
    # Team IDs used in api.nfl.com draft responses (32-bit hex prefix "100" per team)
    # We only need them to populate draft results; missing IDs are fine.
}


# ── Auth ─────────────────────────────────────────────────────────────────────
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


def fetch_json(url: str, token: str) -> dict:
    headers = {
        "User-Agent": BROWSER_UA,
        "Accept": "application/json",
        "Origin": "https://www.nfl.com",
        "Referer": "https://www.nfl.com/",
        "Authorization": f"Bearer {token}",
    }
    r = requests.get(url, headers=headers, timeout=30)
    r.raise_for_status()
    return r.json()


# ── Parsing helpers ──────────────────────────────────────────────────────────
def strip_html(s: str | None) -> str:
    if not s:
        return ""
    # NFL.com wraps strengths/weaknesses/overview in HTML. Convert <li> > "- ",
    # collapse tags, decode entities, squeeze whitespace.
    s = re.sub(r"</li>", "\n", s, flags=re.I)
    s = re.sub(r"<li[^>]*>", "- ", s, flags=re.I)
    s = re.sub(r"</?(?:p|br|div|span|ul|ol|em|strong)[^>]*>", " ", s, flags=re.I)
    s = re.sub(r"<[^>]+>", " ", s)
    s = htmllib.unescape(s)
    s = re.sub(r"[ \t]+", " ", s)
    s = re.sub(r"\n\s*\n+", "\n", s)
    return s.strip()


def html_list_to_bullets(s: str | None) -> list[str]:
    """Extract individual bullet points from an HTML <ul> block."""
    if not s:
        return []
    items = re.findall(r"<li[^>]*>(.*?)</li>", s, flags=re.I | re.S)
    out: list[str] = []
    for item in items:
        txt = strip_html(item).lstrip("- ").strip()
        if txt:
            out.append(txt)
    return out


def inches_to_ht(decimal_inches: float | None) -> str:
    if not decimal_inches:
        return ""
    inches = int(round(decimal_inches))
    ft, rem = divmod(inches, 12)
    return f"{ft}-{rem}"


def extract_forty(profile: dict) -> tuple[float | None, str | None]:
    """Return (seconds, source) preferring OFFICIAL combine time over pro day."""
    fd = profile.get("fortyYardDash") or {}
    pd = profile.get("proFortyYardDash") or {}
    if isinstance(fd, dict) and fd.get("seconds"):
        src = "combine" if (fd.get("designation") or "").upper() == "OFFICIAL" else "estimate"
        return float(fd["seconds"]), src
    if isinstance(pd, dict) and pd.get("seconds"):
        return float(pd["seconds"]), "pro_day"
    return None, None


def _num(x):
    """Return the inner seconds/inches/repetitions value from the API's designated measurements."""
    if x is None:
        return None
    if isinstance(x, dict):
        return x.get("seconds") or x.get("inches") or x.get("repetitions") or x.get("value")
    return x


def canonical_pos(nfl_pos: str, pg: str, weight: int | None) -> str:
    """Map NFL.com's position code to Madden's canonical position."""
    mp = POS_MAP.get((nfl_pos or "").upper())
    if not mp:
        mp = POS_MAP.get((pg or "").upper(), (nfl_pos or "").upper())
    # Refine SAF > SS if the prospect is a heavier box safety
    if mp == "FS" and weight and weight >= 210:
        mp = "SS"
    return mp


def norm_name(name: str) -> str:
    n = (name or "").lower().strip()
    n = re.sub(r"\s+(ii|iii|iv|v|jr|sr)\.?$", "", n)
    n = re.sub(r"[^a-z ]", "", n).strip()
    return n


# ── Transform NFL.com profile > our prospect schema ──────────────────────────
def build_prospect(p: dict, picks_by_pid: dict) -> dict:
    person     = p.get("person") or {}
    pid        = person.get("id")
    first_name = person.get("firstName") or ""
    last_name  = person.get("lastName") or ""
    disp       = person.get("displayName") or f"{first_name} {last_name}".strip()
    schools    = person.get("collegeNames") or []
    school     = schools[0] if schools else ""

    weight     = p.get("weight") or None
    height_str = inches_to_ht(p.get("height"))
    pos        = canonical_pos(p.get("position"), p.get("positionGroup"), weight)

    forty, forty_src = extract_forty(p)

    strengths  = html_list_to_bullets(p.get("strengths"))
    weaknesses = html_list_to_bullets(p.get("weaknesses"))
    overview   = strip_html(p.get("overview"))
    nfl_comp   = strip_html(p.get("nflComparison"))
    sources    = strip_html(p.get("sourcesTellUs"))

    # Build the free-text `notes` the LLM consumes. Mirror the old format:
    # "Strength summary. Weakness summary." — but here use Zierlein's own prose.
    note_parts = []
    if overview:
        note_parts.append(overview)
    if sources:
        note_parts.append(f"Sources: {sources}")
    notes = " ".join(note_parts).strip()

    # Actual draft result (populated when the prospect has been picked)
    actual_pick  = p.get("draftOverallPick")
    actual_round = p.get("draftRound")
    actual_team  = p.get("draftTeamId")
    # Cross-reference with the draft report's picks list when missing
    if (not actual_pick or not actual_round or not actual_team) and pid in picks_by_pid:
        pk = picks_by_pid[pid]
        actual_pick  = actual_pick  or pk.get("overallPick") or pk.get("draftOverallPick")
        actual_round = actual_round or pk.get("round")       or pk.get("draftRound")
        actual_team  = actual_team  or pk.get("teamId")      or pk.get("draftTeamId")

    entry = {
        "name":         disp,
        "firstName":    first_name or disp.split()[0],
        "lastName":     last_name  or " ".join(disp.split()[1:]),
        "pos":          pos,
        "school":       school,
        "ht":           height_str,
        "wt":           weight,
        "forty":        forty,
        "forty_source": forty_src or ("estimate" if forty is None else None),
        "bench":        _num(p.get("benchPress")),
        "vertical":     _num(p.get("verticalJump")),
        "broad_jump":   _num(p.get("broadJump")),
        "cone":         _num(p.get("threeConeDrill")),
        "shuttle":      _num(p.get("twentyYardShuttle")) or _num(p.get("sixtyYardShuttle")),
        "ten_split":    _num(p.get("tenYardSplit")),
        "rank":         None,       # filled in after sorting by grade
        "grade":        p.get("grade"),   # numeric, e.g. 6.29
        "notes":        notes,
        "nfl_comp":     nfl_comp,
        "college_class": p.get("collegeClass"),   # 'Senior', 'R-Junior', etc. — fallback age signal
        # Derived from NFL.com
        "draftRound":   actual_round,
        "nfl_id":       pid,
        "nfl_draft_projection": p.get("draftProjection"),
    }
    if actual_pick:
        entry["actual_draft_pick"]  = actual_pick
        entry["actual_draft_round"] = actual_round
    if actual_team:
        entry["draftTeamId"] = actual_team
    return entry, {
        "pos":         pos,
        "play_style":  p.get("draftProjection") or "",
        "strengths":   strengths,
        "weaknesses":  weaknesses,
        "nfl_comp":    nfl_comp,
        "source":      "nfl.com/lance-zierlein",
    }


# ── Merge with existing prospects (preserve our better data) ─────────────────
def merge_existing(new_entries: list[dict]) -> list[dict]:
    """
    Overlay new NFL.com data onto existing hand-curated entries, preferring the
    existing value for a handful of fields where we know our hand-curation is
    more accurate than the API (40-yard estimates for non-combine attendees,
    etc.). For every other field, prefer NFL.com (the API is authoritative).
    """
    existing: list[dict] = []
    if os.path.exists(PROSPECTS_FILE):
        with open(PROSPECTS_FILE, "r", encoding="utf-8") as fh:
            existing = json.load(fh)

    by_name_existing = {norm_name(p.get("name", "")): p for p in existing}

    out: list[dict] = []
    added_new = 0
    updated   = 0
    for ne in new_entries:
        key = norm_name(ne["name"])
        ex  = by_name_existing.pop(key, None)
        if ex is None:
            out.append(ne)
            added_new += 1
            continue

        merged = dict(ne)
        # Prefer existing hand-curated estimate when NFL.com has no time
        if merged.get("forty") is None and ex.get("forty") is not None:
            merged["forty"]        = ex["forty"]
            merged["forty_source"] = ex.get("forty_source") or "estimate"
        # Keep existing grade if API lacks one
        if merged.get("grade") in (None, "") and ex.get("grade"):
            merged["grade"] = ex["grade"]
        # Preserve any bespoke NFL comp we already wrote when API has none
        if not merged.get("nfl_comp") and ex.get("nfl_comp"):
            merged["nfl_comp"] = ex["nfl_comp"]
        out.append(merged)
        updated += 1

    # Prospects in our old file that NFL.com doesn't have (edge cases: small
    # school UDFAs we pre-loaded). Keep them unchanged.
    kept = 0
    for leftover in by_name_existing.values():
        out.append(leftover)
        kept += 1

    print(f"  added (new from NFL.com)   : {added_new}")
    print(f"  updated (merged with ours) : {updated}")
    print(f"  kept (not on NFL.com)      : {kept}")
    return out


def assign_ranks(entries: list[dict]) -> list[dict]:
    """
    Rank 1..N by NFL.com grade DESC, then by actual_draft_pick ASC when grade
    ties. Prospects without a grade go to the end.
    """
    def sort_key(p):
        g = p.get("grade")
        try:
            g = -float(g) if g not in (None, "") else 999
        except (TypeError, ValueError):
            g = 999   # legacy letter grades ("B+") sort to the end
        pk = p.get("actual_draft_pick") or 99999
        return (g, pk)
    entries.sort(key=sort_key)
    for i, p in enumerate(entries, 1):
        p["rank"] = i
        # Infer draft round from rank when no actual draft info
        if not p.get("draftRound"):
            if   i <= 32:  rnd = 1
            elif i <= 64:  rnd = 2
            elif i <= 96:  rnd = 3
            elif i <= 138: rnd = 4
            elif i <= 180: rnd = 5
            elif i <= 220: rnd = 6
            else:          rnd = 7
            p["draftRound"] = rnd
    return entries


# ── Main ─────────────────────────────────────────────────────────────────────
def main() -> None:
    print("> Fetching NFL identity token ...")
    token = fetch_token()
    print(f"  got token (len {len(token)})")

    print("\n> Fetching prospect profiles (Lance Zierlein) ...")
    profiles_json = fetch_json(PROFILES_URL, token)
    profiles = profiles_json.get("profiles") or profiles_json.get("data") or []
    print(f"  {len(profiles)} profiles")

    print("\n> Fetching draft report (actual picks) ...")
    report_json = fetch_json(REPORT_URL, token)
    picks_by_pid: dict = {}
    # Picks live either at top level or nested in days[].picks[]
    all_picks = list(report_json.get("picks", []))
    for day in report_json.get("days", []):
        all_picks.extend(day.get("picks", []))
    for pk in all_picks:
        person = pk.get("person") or {}
        pid = person.get("id")
        if pid:
            picks_by_pid[pid] = pk
    print(f"  {len(picks_by_pid)} actual picks indexed")

    print("\n> Transforming profiles ...")
    new_entries: list[dict]     = []
    new_profiles_map: dict      = {}
    skipped                     = 0
    for p in profiles:
        try:
            entry, prof = build_prospect(p, picks_by_pid)
        except Exception as exc:
            skipped += 1
            continue
        if not entry.get("name") or not entry.get("pos"):
            skipped += 1
            continue
        new_entries.append(entry)
        new_profiles_map[norm_name(entry["name"])] = prof
    print(f"  built {len(new_entries)} entries, skipped {skipped}")

    print("\n> Merging with existing prospects_2026.json ...")
    merged = merge_existing(new_entries)

    print("\n> Assigning consensus ranks (by grade) ...")
    merged = assign_ranks(merged)

    print(f"\n> Writing {PROSPECTS_FILE}")
    with open(PROSPECTS_FILE, "w", encoding="utf-8") as fh:
        json.dump(merged, fh, indent=2)

    # Merge new profiles with any existing profile file (preserve hand-curated
    # entries for names NFL.com didn't cover)
    existing_profiles: dict = {}
    if os.path.exists(PROFILES_FILE):
        with open(PROFILES_FILE, "r", encoding="utf-8") as fh:
            try:
                existing_profiles = json.load(fh)
            except Exception:
                existing_profiles = {}
    for k, v in new_profiles_map.items():
        existing_profiles[k] = v     # overwrite with NFL.com (more consistent)
    print(f"\n> Writing {PROFILES_FILE}  ({len(existing_profiles)} entries)")
    with open(PROFILES_FILE, "w", encoding="utf-8") as fh:
        json.dump(existing_profiles, fh, indent=2)

    # Backfill the latest team / identity fields into an existing
    # prospects_rated.json so downstream scripts (franchise pipeline) don't
    # need a full re-rate just to pick up post-draft data.
    rated_path = os.path.join(DATA_DIR, "prospects_rated.json")
    if os.path.exists(rated_path):
        with open(rated_path, "r", encoding="utf-8") as fh:
            try:
                rated = json.load(fh)
            except Exception:
                rated = []
        merged_by_pick = {p["actual_draft_pick"]: p for p in merged
                          if p.get("actual_draft_pick")}
        team_added = 0
        renamed    = 0
        for p in rated:
            pk = p.get("actual_draft_pick")
            if not pk:
                continue
            src_p = merged_by_pick.get(pk)
            if not src_p:
                continue
            if src_p.get("draftTeamId") and not p.get("draftTeamId"):
                p["draftTeamId"] = src_p["draftTeamId"]
                team_added += 1
            for field in ("firstName", "lastName", "name", "nfl_id"):
                if src_p.get(field) and src_p[field] != p.get(field):
                    p[field] = src_p[field]
                    if field == "firstName":
                        renamed += 1
        with open(rated_path, "w", encoding="utf-8") as fh:
            json.dump(rated, fh, indent=2)
        print(f"\n> Backfilled prospects_rated.json: +{team_added} draftTeamId, "
              f"{renamed} renamed (matched by actual_draft_pick).")

    # Summary
    from collections import Counter
    pc = Counter(p["pos"] for p in merged)
    picked = sum(1 for p in merged if p.get("actual_draft_pick"))
    graded = sum(1 for p in merged if p.get("grade"))
    print(f"\n{'='*60}")
    print(f"  total prospects       : {len(merged)}")
    print(f"  with NFL.com grade    : {graded}")
    print(f"  actually drafted      : {picked}")
    print(f"  by position           : {dict(sorted(pc.items()))}")
    print(f"\n  Next: python scripts/5_generate_ratings.py")


if __name__ == "__main__":
    main()

