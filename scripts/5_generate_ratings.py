"""
Script 5: Generate Madden 26 ratings for 2026 NFL Draft prospects using Ollama.

For each prospect, builds a calibrated prompt using 2025 calibration examples + optional current
player benchmarks, calls Ollama llama3:8b locally to generate all Madden 26 rating fields,
validates the output, and saves data/prospects_rated.json.

Usage:
    python scripts/5_generate_ratings.py [--model llama3:8b] [--resume]
"""

import argparse
import json
import os
import re
import sys

# Force UTF-8 stdout on Windows so unicode in print statements doesn't crash.
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

from dotenv import load_dotenv
from tqdm import tqdm

# ── Path setup ──────────────────────────────────────────────────────────────
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(SCRIPT_DIR)

sys.path.insert(0, PROJECT_ROOT)

from utils.enums import ALL_RATING_FIELDS, POSITION_KEY_FIELDS, POSITION_TO_ENUM
from utils.defaults import get_defaults
from scripts.lib.neighbor_sampler import sample_baseline_ratings

# ── Load .env ────────────────────────────────────────────────────────────────
load_dotenv(os.path.join(PROJECT_ROOT, ".env"))

OLLAMA_HOST = os.getenv("OLLAMA_HOST", "http://localhost:11434")
DEFAULT_MODEL = os.getenv("OLLAMA_MODEL", "llama3:8b")

# Set OLLAMA_HOST so the ollama package picks it up
os.environ["OLLAMA_HOST"] = OLLAMA_HOST

# ── File paths ────────────────────────────────────────────────────────────────
DATA_DIR = os.path.join(PROJECT_ROOT, "data")
PROSPECTS_FILE = os.path.join(DATA_DIR, "prospects_2026.json")
CALIBRATION_FILE = os.path.join(DATA_DIR, "calibration_set.json")
CURRENT_RATINGS_FILE = os.path.join(DATA_DIR, "current_player_ratings.json")
ROSTER_PLAYERS_FILE  = os.path.join(DATA_DIR, "roster_players_rated.json")
REFERENCE_CLASS_FILE = os.path.join(DATA_DIR, "reference_draft_class.json")
PROFILES_FILE        = os.path.join(DATA_DIR, "prospect_profiles.json")
OUTPUT_FILE = os.path.join(DATA_DIR, "prospects_rated.json")
CHECKPOINT_FILE = os.path.join(DATA_DIR, "prospects_rated_checkpoint.json")

# ── Position fallback mapping (for positions with no calibration examples) ───
POSITION_FALLBACKS = {
    # DE/edge rushers often flip between DE and OLB scheme-to-scheme;
    # the calibration 'DE' group is misaligned (contains OL), so always
    # blend with OLB + MLB where the real pass-rushers actually live.
    "DE":   ["OLB", "MLB"],
    "EDGE": ["OLB", "MLB", "DE"],
    # The calibration 'CB' group is misaligned (contains DTs), so route
    # CBs to the safety groups where real coverage players exist.
    "CB":   ["FS", "SS"],
    "FS":   ["SS"],
    "SS":   ["FS"],
    "S":    ["FS", "SS"],
    "DB":   ["CB", "FS"],
    "OT":   ["T"],
    "LT":   ["T"],
    "RT":   ["T"],
    "OG":   ["G"],
    "LG":   ["G"],
    "RG":   ["G"],
    "NT":   ["DT"],
    "ILB":  ["MLB", "OLB"],
    "LB":   ["OLB", "MLB"],
    "OLB":  ["MLB", "DE"],
    "RB":   ["HB"],
    "PK":   ["K"],
}

# ── Normalise position to canonical key-field key ────────────────────────────
def canonical_pos(pos: str) -> str:
    """Return the POSITION_KEY_FIELDS key that best represents this position."""
    if pos in POSITION_KEY_FIELDS:
        return pos
    for fallback in POSITION_FALLBACKS.get(pos, []):
        if fallback in POSITION_KEY_FIELDS:
            return fallback
    return "QB"  # last-resort default (shouldn't happen)


# ── Similarity scoring for calibration examples ──────────────────────────────
def similarity_score(prospect: dict, example_profile: dict) -> float:
    """
    Score how similar a calibration example's profile is to the prospect.
    Higher is better.
    """
    score = 0.0

    # Draft round similarity (most important)
    p_round = prospect.get("draftRound") or 7
    e_round = example_profile.get("draft_round") or 7
    score += max(0, 10 - abs(p_round - e_round) * 3)

    # Weight similarity
    p_wt = prospect.get("wt") or 220
    e_wt = example_profile.get("wt") or 220
    score += max(0, 5 - abs(p_wt - e_wt) / 10)

    # 40-yard dash similarity (if both available)
    p_forty = prospect.get("forty")
    e_forty = example_profile.get("forty")
    if p_forty and e_forty:
        score += max(0, 5 - abs(p_forty - e_forty) * 10)

    return score


def get_calibration_examples(pos: str, prospect: dict, calibration: dict, max_examples: int = 5) -> list:
    """
    Return up to max_examples calibration entries for this position,
    ranked by similarity to the prospect.
    Falls back to related positions if none found.
    """
    candidates = []
    positions_to_try = [pos] + POSITION_FALLBACKS.get(pos, [])

    # Gather unique examples from primary + fallback positions (always try all)
    seen_names = set()
    for p in positions_to_try:
        for entry in calibration.get(p, []):
            name = entry.get("profile", {}).get("name", "")
            if name not in seen_names:
                seen_names.add(name)
                candidates.append(entry)

    # If still empty, pool all positions
    if not candidates:
        for entries in calibration.values():
            candidates.extend(entries)

    # Sort by similarity
    candidates.sort(key=lambda e: similarity_score(prospect, e.get("profile", {})), reverse=True)
    return candidates[:max_examples]


# ── Roster players loader ─────────────────────────────────────────────────────
def load_roster_players(path: str) -> dict:
    """
    Load roster_players_rated.json (flat player array) and return a
    position-grouped dict compatible with get_current_anchors().

    The 'overall' field in that file is unreliable (all ~67-68), so we compute
    a pseudo-overall by averaging the position's key rating fields, then store
    it back under 'overall' for ranking.  Top 10 per position are kept.
    """
    with open(path, "r", encoding="utf-8") as f:
        players: list = json.load(f)

    # Fields to exclude when computing pseudo-overall
    _SKIP = {"overall", "devTrait", "morale", "personality", "injury",
             "stamina", "toughness", "kickReturn", "unkRating1"}

    grouped: dict = {}
    for player in players:
        pos      = player.get("pos", "")
        ratings  = player.get("ratings")
        raw_name = player.get("playerName") or player.get("name", "")
        if not ratings or not raw_name or not pos:
            continue

        canon      = canonical_pos(pos)
        key_fields = [f for f in POSITION_KEY_FIELDS.get(canon, [])
                      if f not in _SKIP and f in ratings]
        vals       = [ratings[f] for f in key_fields]
        pseudo_ovr = round(sum(vals) / len(vals)) if vals else 60

        entry = {
            "name":    raw_name,
            "ratings": {**ratings, "overall": pseudo_ovr},
        }
        grouped.setdefault(pos, []).append(entry)

    # Sort each position by pseudo-overall desc, keep top 10
    for pos in grouped:
        grouped[pos].sort(key=lambda p: p["ratings"]["overall"], reverse=True)
        grouped[pos] = grouped[pos][:10]

    return grouped


# ── Reference draft class loader ──────────────────────────────────────────────
def load_reference_class(path: str) -> dict:
    """
    Load reference_draft_class.json — a community-created 2026 draft class.
    Returns a dict keyed by normalized player name (lowercase, letters+spaces only).
    """
    if not os.path.exists(path):
        return {}
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def get_reference_ratings(prospect: dict, reference_class: dict) -> dict | None:
    """
    Look up a prospect in the reference draft class by name.
    Returns the rating dict if found, else None.
    """
    first = prospect.get("firstName", "")
    last  = prospect.get("lastName", "")
    full  = prospect.get("name", f"{first} {last}".strip())
    key   = full.lower().replace(r"[^a-z ]", "").strip()
    import re
    key   = re.sub(r"[^a-z ]", "", full.lower()).strip()
    return reference_class.get(key)


def norm_name(name: str) -> str:
    """Lowercase, strip Jr/Sr/III suffixes and non-letters for profile lookup."""
    n = (name or "").lower().strip()
    n = re.sub(r"\s+(ii|iii|iv|v|jr|sr)\.?$", "", n)
    n = re.sub(r"[^a-z ]", "", n).strip()
    n = re.sub(r"\s+", " ", n)
    return n


# ── Tier anchor selection ───────────────────────────────────────────────────
# For each prospect, find the 2025 rookie at the same position whose actual
# draft pick is closest to this prospect's projected rank.  This is the
# strongest signal for "what OVR should this player be?" — it pins the model
# to the actual OVR distribution of last year's class at the same tier.

def get_tier_anchor(prospect: dict, calibration: dict) -> dict | None:
    """
    Return the calibration entry at the same position whose actual
    `draft_pick` is closest to this prospect's real-life draft pick (preferred)
    or internal rank (fallback).
    Falls back to POSITION_FALLBACKS when no entries exist at the primary pos.
    Returns the raw calibration entry (with 'profile' and 'ratings' keys) or None.
    """
    pos  = prospect.get("pos", "")
    # Prefer the real 2026 draft pick (overall) over our internal rank — it's a
    # much stronger signal for comparable-tier calibration. Falls back to rank.
    # Both are treated as "overall pick numbers" (1..~260).
    rank = prospect.get("actual_draft_pick") or prospect.get("rank") or 9999

    # Gather candidate entries across primary + fallback positions.
    # Calibration uses ILB for MLB-style inside LBs, so add MLB→ILB explicitly.
    _extra_fb = {"MLB": ["ILB"], "ILB": ["MLB"]}
    positions_to_try = [pos] + POSITION_FALLBACKS.get(pos, []) + _extra_fb.get(pos, [])
    candidates: list = []
    seen_names: set = set()
    for p in positions_to_try:
        for entry in calibration.get(p, []):
            name = entry.get("profile", {}).get("name", "")
            if name in seen_names:
                continue
            seen_names.add(name)
            prof      = entry.get("profile", {})
            pick      = prof.get("draft_pick")
            rnd       = prof.get("draft_round")
            if pick is None or rnd is None:
                continue
            # Calibration stores pick-within-round; convert to overall so
            # cross-round comparisons vs. prospect's overall pick work.
            overall_pick = (int(rnd) - 1) * 32 + int(pick)
            candidates.append((abs(overall_pick - int(rank)), entry))
        if candidates:
            break  # primary-position candidates are strictly preferred

    if not candidates:
        return None
    candidates.sort(key=lambda t: t[0])
    return candidates[0][1]


# ── Deterministic OVR from calibration ──────────────────────────────────────
# Fit a tiny per-position linear regression (intercept + weights on key fields)
# against the 2025 calibration set so that OVR is reproducible from attributes.
# This replaces the LLM's self-reported "overall" (which frequently violates its
# own attribute outputs) with a deterministic value.

def _fit_linear(X: list[list[float]], y: list[float]) -> tuple[list[float], float]:
    """
    Ordinary least squares with no external dependencies.
    Returns (weights, intercept).  Weights are aligned with columns of X.
    Falls back to mean-of-y as intercept and zero weights if fit is degenerate.
    """
    try:
        import numpy as np
    except ImportError:
        # Degenerate fallback: intercept = mean(y), w = 0
        mean_y = sum(y) / len(y) if y else 60.0
        return [0.0] * (len(X[0]) if X else 0), mean_y

    A = np.array(X, dtype=float)
    b = np.array(y, dtype=float)
    # Prepend ones column for intercept
    A1 = np.hstack([np.ones((A.shape[0], 1)), A])
    try:
        coef, *_ = np.linalg.lstsq(A1, b, rcond=None)
        intercept = float(coef[0])
        weights   = [float(c) for c in coef[1:]]
        return weights, intercept
    except Exception:
        mean_y = float(b.mean()) if len(b) else 60.0
        return [0.0] * A.shape[1], mean_y


def build_ovr_formulas(calibration: dict) -> dict:
    """
    For each position in calibration, fit OVR = intercept + Σ w_i · rating_i
    where rating_i are the position's key non-overall fields.
    Returns { pos: { 'fields': [..], 'weights': [..], 'intercept': float } }.
    """
    formulas: dict = {}
    for pos, entries in calibration.items():
        canon = canonical_pos(pos)
        key_fields = [
            f for f in POSITION_KEY_FIELDS.get(canon, POSITION_KEY_FIELDS["QB"])
            if f != "overall"
        ]
        X, y = [], []
        for e in entries:
            r = e.get("ratings", {})
            ovr = r.get("overall")
            if ovr is None or ovr <= 0:
                continue
            row = [float(r.get(f, 0) or 0) for f in key_fields]
            if any(v > 0 for v in row):
                X.append(row)
                y.append(float(ovr))
        if len(X) < 4:
            # Too few samples to fit — use simple mean of key fields
            formulas[pos] = {"fields": key_fields, "weights": None, "intercept": None}
            continue
        weights, intercept = _fit_linear(X, y)
        formulas[pos] = {
            "fields":    key_fields,
            "weights":   weights,
            "intercept": intercept,
        }
    return formulas


def _key_avg(ratings: dict, pos: str) -> float:
    """Mean of the position's key non-overall ratings (used as an OVR proxy)."""
    canon = canonical_pos(pos)
    fields = [f for f in POSITION_KEY_FIELDS.get(canon, POSITION_KEY_FIELDS["QB"])
              if f != "overall" and f != "devTrait"]
    vals = [float(ratings.get(f, 0) or 0) for f in fields if ratings.get(f, 0)]
    return sum(vals) / len(vals) if vals else 0.0


def pick_slot_floor(actual_pick: int | None) -> int:
    """Minimum OVR tier by real-life 2026 draft position.

    Ensures top picks can't sink below a reasonable floor even when their
    tier anchor was undervalued by Madden at launch.
    """
    if not actual_pick:
        return 0
    if actual_pick <= 5:   return 76
    if actual_pick <= 12:  return 74
    if actual_pick <= 22:  return 72
    if actual_pick <= 32:  return 70
    return 0


# NOTE: An earlier iteration applied a per-position OVR BIAS here to push the
# computed OVR down for over-rated positions. That approach was wrong — Madden
# recomputes the displayed OVR from attributes via per-archetype formulas on
# load, so bias-ing the OverallRating field alone does nothing in-game. The
# correct fix lives in apply_position_overshoot_dampener() (called from
# apply_position_corrections) which lowers KEY ATTRIBUTES by a small amount
# for over-rated positions, so Madden's recompute lands at the calibrated
# value naturally.


def compute_ovr(
    ratings: dict,
    pos: str,
    formulas: dict,
    tier_anchor: dict | None = None,
    actual_pick: int | None = None,
    prior_ovr: int | None = None,
    clamp_window: int = 2,
) -> int:
    """
    Deterministic OVR.

    Strategy (in order of preference):
    1. If a tier anchor is provided, use its actual Madden OVR as the reference
       point and adjust by the delta between this prospect's key-rating average
       and the anchor's key-rating average.  This is the most reliable method
       because it pins the output to the 2025 rookie OVR distribution at the
       same draft tier.
    2. Otherwise, fall back to the fitted linear formula.
    3. Last resort: unweighted mean of the position's key fields.

    Clamped to [40, 99].
    """
    # ── Primary: anchor-relative delta ────────────────────────────────────────
    if tier_anchor:
        anchor_rats = tier_anchor.get("ratings", {})
        anchor_ovr  = anchor_rats.get("overall")
        if anchor_ovr:
            prospect_avg = _key_avg(ratings,    pos)
            anchor_avg   = _key_avg(anchor_rats, pos)
            if prospect_avg > 0 and anchor_avg > 0:
                delta = prospect_avg - anchor_avg
                # Dampen meaningfully — draft position should carry more weight
                # than raw attribute deltas (per user feedback). 0.6 keeps the
                # anchor's tier while letting strong/weak attributes nudge OVR.
                # Hard cap at 80 — Madden launch rookies don't exceed that.
                # Floor by draft position so top picks can't sink below tier.
                ovr = round(anchor_ovr + delta * 0.6)
                floor = pick_slot_floor(actual_pick)
                ovr = max(40, floor, min(80, ovr))
                # Stability clamp — don't swing the OVR more than ±clamp_window
                # from the prior rating (prevents profile tweaks from moving
                # numbers dramatically between runs).
                if prior_ovr is not None:
                    ovr = max(prior_ovr - clamp_window, min(prior_ovr + clamp_window, ovr))
                return ovr

    # ── Fallback: fitted formula ─────────────────────────────────────────────
    canon   = canonical_pos(pos)
    formula = formulas.get(pos) or formulas.get(canon)
    if not formula:
        for fb in POSITION_FALLBACKS.get(pos, []):
            formula = formulas.get(fb)
            if formula:
                break

    if formula:
        fields    = formula["fields"]
        weights   = formula.get("weights")
        intercept = formula.get("intercept")
        if weights and intercept is not None and any(abs(w) > 1e-6 for w in weights):
            ovr = intercept + sum(
                w * float(ratings.get(f, 0) or 0) for w, f in zip(weights, fields)
            )
            return max(40, min(80, round(ovr)))

    # ── Last resort: mean of key fields ──────────────────────────────────────
    avg = _key_avg(ratings, pos)
    return max(40, min(80, round(avg))) if avg > 0 else 60


# ── Current player anchor selection ──────────────────────────────────────────
def get_current_anchors(pos: str, current_ratings: dict, max_anchors: int = 3) -> list:
    """
    Return up to max_anchors top-rated current players at this position (or fallback positions).
    """
    positions_to_try = [pos] + POSITION_FALLBACKS.get(pos, [])
    players = []
    seen = set()

    for p in positions_to_try:
        for player in current_ratings.get(p, []):
            name = player.get("name", "")
            if name not in seen:
                seen.add(name)
                players.append(player)

    # Sort by overall descending
    players.sort(key=lambda p: p.get("ratings", {}).get("overall", 0), reverse=True)
    return players[:max_anchors]


# ── Prompt builder ────────────────────────────────────────────────────────────
def _fmt_val(val, default="N/A"):
    """Return a display string for a possibly-None value."""
    return str(val) if val is not None else default


def _key_ratings_str(ratings: dict, pos: str) -> str:
    """Return a compact 'key=val, ...' string for the position's key fields."""
    key_fields = POSITION_KEY_FIELDS.get(canonical_pos(pos), POSITION_KEY_FIELDS["QB"])
    parts = [f"{f}={ratings[f]}" for f in key_fields if f in ratings]
    return ", ".join(parts)


def build_prompt(prospect: dict, calibration_examples: list, current_anchors: list, reference_ratings: dict | None = None, tier_anchor: dict | None = None, profile: dict | None = None) -> str:
    pos = prospect["pos"]
    canon = canonical_pos(pos)
    key_fields = POSITION_KEY_FIELDS.get(canon, POSITION_KEY_FIELDS["QB"])
    all_fields_str = ", ".join(ALL_RATING_FIELDS)

    lines = []

    # ── Header ──
    lines.append("You are a Madden NFL 26 ratings expert calibrating a 2026 NFL Draft class.")
    lines.append("")

    # ── Tier anchor (strongest signal — pin OVR to the same-pick 2025 rookie) ──
    if tier_anchor:
        ta_prof = tier_anchor.get("profile", {})
        ta_rats = tier_anchor.get("ratings", {})
        ta_name = ta_prof.get("name", "Unknown")
        ta_ovr  = ta_rats.get("overall", "?")
        ta_rnd  = _fmt_val(ta_prof.get("draft_round"), "?")
        ta_pk   = _fmt_val(ta_prof.get("draft_pick"), "?")
        ta_wt   = _fmt_val(ta_prof.get("wt"), "N/A")
        ta_forty = _fmt_val(ta_prof.get("forty"), "N/A")
        actual_pk = prospect.get("actual_draft_pick")
        slot_str  = (f"actual 2026 pick #{actual_pk}"
                     if actual_pk else
                     f"projected board rank #{_fmt_val(prospect.get('rank'),'?')}")
        lines.append(f"TIER ANCHOR — the 2025 rookie at {pos} drafted closest to this prospect's slot:")
        lines.append(
            f"• {ta_name} | Round {ta_rnd}, Pick {ta_pk} | {ta_wt}lbs, 40yd: {ta_forty} | "
            f"**Madden 26 Overall: {ta_ovr}**"
        )
        lines.append(
            "  (Anchor's per-attribute numbers are intentionally withheld — derive "
            "this prospect's specific attributes from the SCOUTING PROFILE and "
            "measurables, not by mimicking the anchor.)"
        )
        lines.append(
            f"This prospect's {slot_str} places them in the same tier as the anchor. "
            f"Their overall rating should typically be within ±5 of {ta_ovr}, but "
            "real-world draft position (earlier pick = higher OVR) and measurables "
            "take precedence. Do NOT compress toward the median."
        )
        lines.append("")

    # ── Scouting profile (hand-curated traits from NFL.com/ESPN/PFF) ──
    if profile:
        lines.append("SCOUTING PROFILE — use these traits to set specific attribute values:")
        ps = profile.get("play_style")
        if ps:
            lines.append(f"Play style: {ps}")
        strengths = profile.get("strengths") or []
        if strengths:
            lines.append("Strengths (bump the relevant attributes UP):")
            for s in strengths:
                lines.append(f"  + {s}")
        weaknesses = profile.get("weaknesses") or []
        if weaknesses:
            lines.append("Weaknesses (mark the relevant attributes DOWN):")
            for w in weaknesses:
                lines.append(f"  - {w}")
        comp = profile.get("nfl_comp")
        if comp:
            lines.append(f"NFL comp / archetype: {comp}")
        lines.append("Your attribute outputs MUST reflect these scouting notes — e.g. if "
                     "'elite accuracy' is a strength, throw-accuracy fields should be high; "
                     "if 'pocket presence concerns' is a weakness, PAC/throw-under-pressure "
                     "should be lower.")
        lines.append("")

    # ── Calibration examples ──
    if calibration_examples:
        lines.append(f"CALIBRATION — 2025 rookies at {pos} with their actual Madden 26 launch ratings:")
        for ex in calibration_examples:
            prof = ex.get("profile", {})
            rats = ex.get("ratings", {})
            name = prof.get("name", "Unknown")
            school = prof.get("school", "N/A")
            ht = prof.get("ht", "N/A")
            wt = _fmt_val(prof.get("wt"), "N/A")
            forty = _fmt_val(prof.get("forty"), "N/A")
            draft_round = _fmt_val(prof.get("draft_round"), "?")
            draft_pick = _fmt_val(prof.get("draft_pick"), "?")
            key_str = _key_ratings_str(rats, pos)
            lines.append(
                f"• {name} | {school} | {ht}, {wt}lbs | 40yd: {forty} | "
                f"Round {draft_round}, Pick {draft_pick}"
            )
            lines.append(f"  Ratings: {key_str}")
        lines.append("")

    # ── Current player anchors ──
    if current_anchors:
        lines.append(f"CURRENT NFL {pos} ANCHORS (for scale reference):")
        for player in current_anchors:
            name = player.get("name", "Unknown")
            rats = player.get("ratings", {})
            ovr = rats.get("overall", "N/A")
            key_str = _key_ratings_str(rats, pos)
            lines.append(f"• {name} | OVR {ovr} | {key_str}")
        lines.append("")

    # ── Community reference ratings ──
    if reference_ratings:
        ref_pos = reference_ratings.get("pos", pos)
        ref_name = reference_ratings.get("name", "")
        ref_ovr = reference_ratings.get("overall", "?")
        key_fields = POSITION_KEY_FIELDS.get(canonical_pos(pos), POSITION_KEY_FIELDS["QB"])
        ref_key_str = ", ".join(
            f"{f}={reference_ratings[f]}" for f in key_fields if f in reference_ratings
        )
        lines.append(f"COMMUNITY REFERENCE — Another Madden creator rated this same prospect:")
        lines.append(f"• {ref_name} | pos: {ref_pos} | OVR {ref_ovr} | {ref_key_str}")
        lines.append("Use this as a directional reference — adjust if your calibration examples or NFL comp suggest otherwise.")
        lines.append("")

    # ── Prospect to rate ──
    name = prospect.get("name", f"{prospect.get('firstName','')} {prospect.get('lastName','')}".strip())
    ht = prospect.get("ht", "N/A")
    wt = _fmt_val(prospect.get("wt"), "N/A")
    forty = _fmt_val(prospect.get("forty"), "N/A")
    bench = _fmt_val(prospect.get("bench"), "N/A")
    vertical = _fmt_val(prospect.get("vertical"), "N/A")
    rank = _fmt_val(prospect.get("rank"), "N/A")
    grade = prospect.get("grade", "N/A")
    draft_round = _fmt_val(prospect.get("draftRound"), "?")
    notes = (prospect.get("notes") or "").strip()

    lines.append("TASK — Generate Madden 26 ratings for this 2026 prospect:")
    lines.append(
        f"Name: {name} | Position: {pos} | School: {prospect.get('school','N/A')} | "
        f"{ht}, {wt}lbs"
    )
    lines.append(
        f"40yd: {forty} | Bench: {bench} | Vertical: {vertical}"
    )
    lines.append(f"Board rank: #{rank} | Grade: {grade} | Draft round: {draft_round}")
    if notes:
        lines.append(f"Notes: {notes}")
    lines.append("")

    # ── NFL Comparison ──
    nfl_comp = prospect.get("nfl_comp", "")
    if nfl_comp:
        lines.append(f"NFL Comparison: {nfl_comp}")
        lines.append("Use this comparison player's rating PROFILE (not exact values) to inform the attribute distribution.")
        lines.append("")

    # ── Rules ──
    lines.append("Rules:")
    lines.append("- All rating values must be integers between 0 and 99")
    lines.append("- devTrait: 0=Normal, 1=Impact, 2=Star, 3=XFactor (top 5 picks can be Star/XFactor)")
    lines.append("- Ratings should reflect a ROOKIE — do not inflate. Compare to the calibration examples above.")
    lines.append("- Non-relevant ratings for this position should be low (28-40 range)")
    lines.append("")

    # Position-specific rules
    if pos in ("T", "G", "C"):
        lines.append(f"IMPORTANT for {pos} (offensive lineman):")
        lines.append("- blockShedding, powerMoves, finesseMoves are DEFENSIVE LINE stats — keep them 15-35")
        lines.append("- passBlock, passBlockPower, passBlockFinesse, runBlock, runBlockPower, runBlockFinesse, impactBlocking are the KEY stats")
        lines.append("- acceleration should be 65-78 (NOT 30)")
        lines.append("- tackle, hitPower, pursuit should be 20-35 (not OL stats)")
        lines.append("")
    elif pos in ("FS", "SS"):
        lines.append(f"IMPORTANT for {pos} (safety):")
        lines.append("- zoneCoverage, manCoverage, playRecognition, awareness are the KEY coverage stats — do NOT leave these low")
        lines.append("- A Day-1 starter safety should have zoneCoverage 70-85, playRecognition 74-86")
        lines.append("- strength should be 60-75 (NOT 28)")
        lines.append("- Note: the calibration examples may be unreliable for this position; rely more on the NFL comp and round/pick")
        lines.append("")
    elif pos == "CB":
        lines.append("IMPORTANT for CB:")
        lines.append("- manCoverage and zoneCoverage are the KEY stats — a first-round CB should be 75-88")
        lines.append("- playRecognition and awareness should be 70-82 for a starter")
        lines.append("- blockShedding, powerMoves, finesseMoves are DL stats — keep them 10-25 for a CB")
        lines.append("- speed and acceleration are critical — use 40 time as primary guide")
        lines.append("- Note: the calibration examples may be unreliable; rely on NFL comp, round, and athleticism")
        lines.append("")
    elif pos == "WR":
        lines.append("IMPORTANT for WR:")
        lines.append("- Calibration WR speed reference: 4.30→96, 4.37→93, 4.40→92, 4.44→91, 4.46→90, 4.48→90, 4.51→89, 4.59→86, 4.61→85")
        lines.append("- Use the table above to set speed; do NOT apply a blanket bonus — fast WRs (sub-4.40) get no extra bump")
        lines.append("- shortRouteRunning, mediumRouteRunning, deepRouteRunning are all KEY stats — do not leave any below 70 for a starter")
        lines.append("- blockShedding, powerMoves, finesseMoves are PASS RUSH stats for DL — keep them 15-35 for a WR")
        lines.append("- tackle, hitPower, pursuit are DEFENSIVE stats — keep them 20-38 for a WR")
        lines.append("- zoneCoverage, manCoverage, pressCoverage are DB stats — keep them 20-38 for a WR")
        lines.append("")
    elif pos in ("HB", "FB"):
        lines.append(f"IMPORTANT for {pos}:")
        lines.append("- blockShedding, powerMoves, finesseMoves are PASS RUSH stats for DL — keep them 15-40 for a RB")
        lines.append("- zoneCoverage, manCoverage, pressCoverage are DB coverage stats — keep them 20-40 for a RB")
        lines.append("")
    elif pos in ("DE", "OLB") and pos not in ("T", "G", "C"):
        lines.append(f"IMPORTANT for {pos} (edge/pass rusher):")
        lines.append("- blockShedding, powerMoves, finesseMoves are KEY pass-rush stats — these should be HIGH (65-85)")
        lines.append("- passBlock, runBlock, impactBlocking should be LOW (15-30) — those are offensive stats")
        lines.append("")
    elif pos in ("DT", "NT"):
        lines.append("IMPORTANT for DT (interior defensive lineman):")
        lines.append("- speed should be 60-82: even the biggest DTs have speed 60+; do NOT set below 60")
        lines.append("- acceleration should be 62-82: do NOT set below 62")
        lines.append("- agility should be 55-82: do NOT set below 55")
        lines.append("- blockShedding, powerMoves, finesseMoves, tackle, hitPower are KEY stats")
        lines.append("- passBlock, runBlock, catching, route running are offensive stats — keep them 15-35")
        lines.append("")

    lines.append(f"Return ONLY a valid JSON object with ALL of these exact keys, no extra text:")
    lines.append(all_fields_str)

    return "\n".join(lines)


def build_correction_prompt(all_fields_str: str, prev_text: str) -> str:
    return (
        "Your previous response was not valid JSON or was missing fields. "
        "Return ONLY a JSON object with these exact keys: "
        f"{all_fields_str}. "
        f"Previous attempt: {prev_text[:200]}"
    )


# ── JSON parsing ──────────────────────────────────────────────────────────────
def extract_json(text: str) -> dict | None:
    """
    Try multiple strategies to extract a JSON object from LLM output.
    Returns a dict or None if all strategies fail.
    """
    # 1. Strip markdown code fences
    stripped = re.sub(r"```(?:json)?\s*", "", text).strip()
    stripped = re.sub(r"```\s*$", "", stripped).strip()

    # 2. Direct parse of stripped text
    try:
        return json.loads(stripped)
    except json.JSONDecodeError:
        pass

    # 3. Find first {...} block (greedy, handles nested braces)
    brace_match = re.search(r"\{[\s\S]*\}", stripped)
    if brace_match:
        try:
            return json.loads(brace_match.group())
        except json.JSONDecodeError:
            pass

    # 4. Non-greedy block (for shorter objects)
    brace_match2 = re.search(r"\{[^{}]*\}", text)
    if brace_match2:
        try:
            return json.loads(brace_match2.group())
        except json.JSONDecodeError:
            pass

    return None


# ── Validation and clamping ───────────────────────────────────────────────────
def validate_ratings(ratings: dict, pos: str) -> tuple[dict, list]:
    """
    Validate and fix ratings dict.
    Returns (cleaned_ratings, list_of_issues).
    """
    defaults = get_defaults(pos)
    cleaned = {}
    issues = []

    for field in ALL_RATING_FIELDS:
        raw = ratings.get(field)

        # Missing field → use default
        if raw is None:
            cleaned[field] = defaults.get(field, 50)
            issues.append(f"missing:{field}")
            continue

        # Coerce to int
        try:
            val = int(float(raw))
        except (TypeError, ValueError):
            cleaned[field] = defaults.get(field, 50)
            issues.append(f"non-numeric:{field}={raw!r}")
            continue

        # devTrait must be 0-3
        if field == "devTrait":
            val = max(0, min(3, val))
        else:
            # Clamp 0-99; treat 0 as invalid — use default minimum
            val = max(0, min(99, val))
            if val == 0:
                val = defaults.get(field, 15)

        cleaned[field] = val

    return cleaned, issues


# ── Ollama call ───────────────────────────────────────────────────────────────
def call_ollama(model: str, prompt: str) -> str:
    """Call Ollama and return the response text. Raises on connection error."""
    import ollama  # imported here so import error is clear

    response = ollama.chat(
        model=model,
        messages=[{"role": "user", "content": prompt}],
        options={"temperature": 0.2, "num_predict": 1024},
    )
    return response["message"]["content"]


def _lerp(x: float, table: list[tuple]) -> int:
    """Linear-interpolate x against a sorted (x, y) table. Clamps to edges."""
    xs = [pt[0] for pt in table]
    ys = [pt[1] for pt in table]
    if x <= xs[0]:
        return ys[0]
    if x >= xs[-1]:
        return ys[-1]
    for i in range(len(xs) - 1):
        if xs[i] <= x <= xs[i + 1]:
            frac = (x - xs[i]) / (xs[i + 1] - xs[i])
            return round(ys[i] + frac * (ys[i + 1] - ys[i]))
    return ys[-1]


def _anchor(r: dict, field: str, expected: int, band: int = 4) -> None:
    """
    Anchor an attribute to within ±band of expected.  Unlike a floor, this
    will LOWER the rating if the centroid produced a value implausibly high
    relative to the combine measurement (e.g. centroid speed=92 but the
    prospect ran 4.65 → speed should be ~84).
    """
    cur = r.get(field, 0) or 0
    if cur < expected - band:
        r[field] = expected - band
    elif cur > expected + band:
        r[field] = expected + band


def apply_combine_corrections(r: dict, pos: str, bench, vertical, cone, shuttle, ten_split=None, forty=None) -> dict:
    """
    Combine measurements anchor the relevant attributes to within ±band of
    expected.  Anchor (not floor) — combine results are objective measurements
    and SHOULD lower an inflated centroid value when the measurement disagrees.

    Mappings:
      forty     → speed + acceleration  (universal, primary signal)
      ten_split → acceleration
      vertical  → jumping
      bench     → strength               (position-grouped)
      cone      → changeOfDirection
      shuttle   → agility
      broad jump (not used currently — would map to jumping/strength composite)
    """
    r = dict(r)

    # ── 40-yard dash → Speed + Acceleration (universal anchor) ───────────────
    # The strongest combine signal.  Centroid often overshoots speed for slower
    # combine attendees because similar-pick neighbors had faster times.
    if forty is not None:
        FORTY_SPEED_TABLE = [
            (4.30, 96), (4.35, 94), (4.40, 92), (4.45, 90), (4.50, 88),
            (4.55, 86), (4.60, 84), (4.65, 82), (4.70, 80), (4.75, 77),
            (4.80, 74), (4.90, 70), (5.00, 67), (5.10, 64), (5.20, 60),
            (5.30, 57),
        ]
        expected = _lerp(float(forty), FORTY_SPEED_TABLE)
        _anchor(r, "speed", expected, band=3)
        # Acceleration tracks speed closely (within ±2 typically).
        _anchor(r, "acceleration", expected, band=4)

    # ── 10-yard split → Acceleration (overrides forty-derived if present) ────
    if ten_split is not None:
        TEN_TABLE = [(1.48, 98), (1.50, 96), (1.52, 94), (1.54, 92),
                     (1.56, 90), (1.58, 88), (1.60, 85), (1.62, 82),
                     (1.65, 78), (1.68, 74), (1.72, 68), (1.78, 62),
                     (1.84, 55)]
        _anchor(r, "acceleration", _lerp(float(ten_split), TEN_TABLE), band=3)

    # ── Vertical → Jumping ────────────────────────────────────────────────────
    if vertical is not None:
        VERT_TABLE = [(27.0, 62), (31.0, 72), (33.0, 78), (35.0, 82),
                      (37.0, 86), (39.0, 89), (41.0, 92), (43.5, 95), (45.5, 97)]
        _anchor(r, "jumping", _lerp(float(vertical), VERT_TABLE), band=4)

    # ── Bench → Strength ─────────────────────────────────────────────────────
    if bench is not None:
        HEAVY = {"T", "G", "C", "DT"}
        MID   = {"TE", "HB", "FB", "MLB", "OLB", "DE"}
        if pos in HEAVY:
            BENCH_TABLE = [(10, 63), (15, 70), (20, 76), (25, 81), (30, 86), (35, 90)]
        elif pos in MID:
            BENCH_TABLE = [(9, 58), (13, 64), (17, 70), (21, 75), (25, 79), (30, 84)]
        else:
            BENCH_TABLE = [(8, 54), (12, 59), (15, 64), (20, 70), (25, 75)]
        _anchor(r, "strength", _lerp(int(bench), BENCH_TABLE), band=4)

    # ── 3-cone → changeOfDirection ───────────────────────────────────────────
    if cone is not None:
        CONE_TABLE = [(6.70, 94), (6.90, 90), (7.00, 87), (7.10, 84),
                      (7.20, 81), (7.40, 77), (7.60, 73), (8.00, 66)]
        _anchor(r, "changeOfDirection", _lerp(float(cone), CONE_TABLE), band=4)

    # ── Shuttle → Agility ────────────────────────────────────────────────────
    if shuttle is not None:
        SHUTTLE_TABLE = [(4.10, 95), (4.18, 91), (4.25, 88), (4.30, 86),
                         (4.35, 84), (4.40, 82), (4.50, 78), (4.60, 74),
                         (4.70, 70), (5.00, 62)]
        _anchor(r, "agility", _lerp(float(shuttle), SHUTTLE_TABLE), band=4)

    return r


# Per-position attribute dampener — lowers KEY ATTRIBUTES (the ones that
# drive Madden's archetype OVR formula) by a small amount for positions
# where the centroid + post-processing produces too-high values vs the
# 2025 calibration distribution.  Lowering attributes (not just the OVR
# field) is required so Madden's in-game archetype recompute lands at the
# calibrated value too, not just our stored OverallRating.
#
# Magnitudes were tuned empirically from scripts/_audit_distribution.py:
# the per-position OVR delta vs 2025 calibration is the target reduction.
ATTRIBUTE_DAMPENER: dict[str, int] = {
    "CB":  -2,    # was +3.35 OVR overshoot pre-fix
    "DE":  -2,    # was +3.21
    "FS":  -2,    # was +3.48
    "T":   -2,    # was +3.18
    "C":   -2,    # was +2.81
    "QB":  -2,    # was +2.69
    "G":   -1,    # was +2.19
    "SS":  -1,    # was +2.10
    "TE":  -1,    # was +1.98
    "WR":  -1,    # was +1.88
}


def apply_top_pick_awareness_floor(ratings: dict, pos: str, actual_pick: int | None) -> dict:
    """
    Top picks need elite awareness / decision-making to register correctly
    in Madden's archetype formulas (especially QB_FieldGeneral, MLB_FieldGeneral,
    S_Zone, CB_Zone — all of which weight Awareness heavily).

    The centroid pulls awareness from similar 2025 rookies, but rookie AWR
    has high variance and the average tends low. Result: top-pick QBs like
    Mendoza ended up with AWR=61, capping their displayed OVR around 65.

    Per-pick floor structure:
      Pick 1-3:    AWR floor 80  ("smart stats" floor 75)
      Pick 4-12:   AWR floor 76  (75/70)
      Pick 13-32:  AWR floor 72  (--)
    QBs get a stricter AWR floor (FieldGeneral weights it most).
    """
    if not actual_pick:
        return ratings
    r = dict(ratings)

    if actual_pick <= 3:
        awr_floor = 82 if pos == "QB" else 78
        smart_floor = 76
    elif actual_pick <= 12:
        awr_floor = 78 if pos == "QB" else 74
        smart_floor = 72
    elif actual_pick <= 32:
        awr_floor = 74 if pos == "QB" else 70
        smart_floor = 70
    else:
        return r

    if r.get("awareness", 0) < awr_floor:
        r["awareness"] = awr_floor
    # Position-specific "smart" stats — those that drive archetype formulas
    # for thinking-positions.
    smart_stats = {
        "QB":  ("playRecognition", "throwUnderPressure", "playAction"),
        "MLB": ("playRecognition",),
        "FS":  ("playRecognition", "zoneCoverage"),
        "SS":  ("playRecognition",),
        "CB":  ("playRecognition",),
        "C":   ("playRecognition",),
    }.get(pos, ())
    for f in smart_stats:
        if r.get(f, 0) < smart_floor:
            r[f] = smart_floor

    return r


def apply_top_pick_ol_floor(ratings: dict, pos: str, actual_pick: int | None) -> dict:
    """
    Top OL picks need elevated run/pass blocking and impact blocking to
    register correctly in Madden's archetype-OVR formulas. The centroid
    pulls them toward the average rookie OL, leaving high picks like Chase
    Bisontis (#34, ARI) at runBlock=75 / passBlock=73 — too low for a R2 OL.

    Per-pick floors for OL canonical positions (T, G, C):
      Pick 1-15:  blocks 78,  impact 76
      Pick 16-32: blocks 75,  impact 73
      Pick 33-50: blocks 73,  impact 71
      Pick 51-100: blocks 70, impact 68
    """
    if not actual_pick:
        return ratings
    if pos not in ("T", "G", "C", "LT", "RT", "LG", "RG", "OG", "OT"):
        return ratings

    if actual_pick <= 15:
        block_floor, impact_floor, awr_floor = 82, 80, 76
    elif actual_pick <= 32:
        block_floor, impact_floor, awr_floor = 79, 77, 73
    elif actual_pick <= 50:
        block_floor, impact_floor, awr_floor = 77, 75, 72
    elif actual_pick <= 100:
        block_floor, impact_floor, awr_floor = 73, 71, 70
    else:
        return ratings

    r = dict(ratings)
    for f in ("runBlock", "passBlock", "runBlockPower", "runBlockFinesse",
              "passBlockPower", "passBlockFinesse"):
        if r.get(f, 0) < block_floor:
            r[f] = block_floor
    for f in ("impactBlocking", "leadBlock"):
        if r.get(f, 0) < impact_floor:
            r[f] = impact_floor
    if r.get("awareness", 0) < awr_floor:
        r["awareness"] = awr_floor
    return r


def apply_late_pick_dampener(ratings: dict, pos: str, actual_pick: int | None) -> dict:
    """
    Subtract a small amount from key attributes for late-round picks.
    Applied AFTER position-overshoot dampener so they stack.

    Pick 181-220 (R6 range): -1 to key fields
    Pick 221-260 (R7 range): -2 to key fields

    Madden's archetype recompute on inflated late-pick attributes lifts the
    in-game OVR above what the tier should hit (we observed Andre Fuller
    R7#236 CB go 69 -> 72 post-Madden because SPD=90, PUR=84, PRESS=81).
    Trimming key attributes by 1-2 brings the recomputed OVR back into the
    66-70 band typical of late R7 picks.
    """
    if not actual_pick or actual_pick <= 180:
        return ratings
    if actual_pick <= 220:
        delta = -1
    else:
        delta = -2

    canon = canonical_pos(pos)
    key_fields = POSITION_KEY_FIELDS.get(canon, POSITION_KEY_FIELDS["QB"])
    r = dict(ratings)
    for f in key_fields:
        if f in ("overall", "devTrait"):
            continue
        v = r.get(f)
        if not isinstance(v, (int, float)):
            continue
        r[f] = max(40, min(99, int(v) + delta))
    return r


def apply_position_overshoot_dampener(ratings: dict, pos: str) -> dict:
    """
    Subtract a per-position N from KEY attributes (the ones the position's
    archetype formula weights heavily).  This lowers Madden's recomputed
    in-game OVR for positions that were systematically over-rated relative
    to the 2025 calibration.  Non-key fields are left untouched so the
    player's overall attribute profile still reflects their archetype.
    """
    delta = ATTRIBUTE_DAMPENER.get(pos)
    if not delta:
        return ratings
    canon = canonical_pos(pos)
    key_fields = POSITION_KEY_FIELDS.get(canon, POSITION_KEY_FIELDS["QB"])
    r = dict(ratings)
    for f in key_fields:
        if f in ("overall", "devTrait"):
            continue
        v = r.get(f)
        if not isinstance(v, (int, float)):
            continue
        r[f] = max(40, min(99, int(v) + delta))
    return r


def apply_profile_corrections(ratings: dict, pos: str, notes: str | None) -> dict:
    """
    Position-aware keyword bumps from the Lance Zierlein scouting prose.

    The LLM systematically under-rates stats it considers "off-position" even
    when the scouting profile explicitly highlights them.  This pass scans
    `notes` for position-relevant phrases and pushes the matching attributes
    UPWARD (never down).

    Examples this fixes:
      - CB Julian Neal's profile says "talent as a run defender and tackler"
        AND "size NFL teams desire for a press corner" — but the LLM left
        him at tackle=53 / press=62.
      - Safety profiles that mention "thumper" / "in-the-box" stay at
        hitPower=55 unless we bump them.
    """
    if not notes:
        return ratings
    r = dict(ratings)
    text = notes.lower()

    def bump(stat: str, delta: int, ceil: int = 95):
        cur = r.get(stat, 0)
        new = min(ceil, cur + delta)
        if new > cur:
            r[stat] = new

    def has_any(*phrases):
        return any(p in text for p in phrases)

    # ─── Universal qualitative bumps (any position) ───────────────────────
    # These look for general scouting tone keywords and bump common attributes.
    # Apply BEFORE the position-specific block so per-position keywords can
    # stack on top.
    if has_any("explosive", "explosiveness", "dynamic", "elite athlete",
               "twitch", "twitchy", "burst", "bursty", "first step",
               "elite burst", "elite athleticism"):
        bump("acceleration", 3)
        bump("agility", 2)
    if has_any("instincts", "instinctive", "high football iq",
               "football iq", "smart player", "cerebral", "high-iq",
               "play recognition", "diagnoses", "pre-snap", "anticipation",
               "advanced processor", "processor", "reads the field"):
        bump("awareness", 4)
        bump("playRecognition", 4)
    if has_any("physical", "physicality", "toughness", "tough",
               "violent", "punishing", "punishes", "punisher", "thumper",
               "hits like a truck", "intimidator", "enforcer", "demolishes"):
        bump("hitPower", 5)
        bump("tackle", 2)
    if has_any("durable", "rarely missed", "ironman", "iron man",
               "no injury history", "available", "tough-as-nails"):
        bump("toughness", 5)
        bump("injury", 3)
    if has_any("leader", "leadership", "team captain", "captain",
               "commands the huddle", "alpha"):
        bump("awareness", 3)
    if has_any("nfl-ready", "nfl ready", "pro-ready", "polished",
               "refined", "advanced technician", "technician"):
        bump("awareness", 3)
        bump("playRecognition", 2)

    if pos == "CB":
        if has_any("tackler", "tackling", "tackle", "run defender",
                   "run support", "willing tackler", "open-field tackler",
                   "sure-tackler", "wraps up", "form tackler"):
            bump("tackle",   10)
            bump("hitPower",  6)
            bump("pursuit",   5)
        if has_any("press", "press-coverage", "press corner",
                   "weighted blanket", "jam at the line", "hand-fight",
                   "physical press", "disrupts release"):
            bump("pressCoverage", 10)
            bump("hitPower",       3)
        if has_any("closing speed", "closes well", "rangy", "long stride",
                   "sideline-to-sideline", "make-up speed", "recovery speed"):
            bump("pursuit", 7)
            bump("speed",   2)
        if has_any("ball-hawk", "ball skills", "ball production",
                   "ballhawk", "interceptions", "picks", "takeaway",
                   "playmaker", "splash plays", "ball production"):
            bump("zoneCoverage", 5)
            bump("playRecognition", 3)
        if has_any("man coverage", "mirror", "mirrors", "sticky in coverage",
                   "lockdown", "shadow"):
            bump("manCoverage", 6)
        if has_any("zone", "zone awareness", "deep zone", "off-coverage",
                   "deep middle"):
            bump("zoneCoverage", 5)
        if has_any("strength", "strong corner", "shed perimeter blocks",
                   "sheds blocks", "stack and shed", "physical at line"):
            bump("hitPower", 4)
            bump("blockShedding", 3)
        if has_any("size", "length", "long arms", "wingspan", "tall", "frame"):
            bump("pressCoverage", 4)
            bump("jumping", 3)

    elif pos in ("FS", "SS"):
        if has_any("tackler", "tackling", "tackle", "run support",
                   "willing tackler", "form tackler", "sure tackler"):
            bump("tackle", 6)
            bump("hitPower", 3)
        if has_any("thumper", "punisher", "violent", "physical hitter",
                   "explosive hits", "in-the-box", "in the box",
                   "smashes", "delivers blows", "knockout hits"):
            bump("hitPower", 7)
            bump("tackle", 3)
        if has_any("ball-hawk", "ballhawk", "ball skills", "centerfield",
                   "center field", "rangy", "deep middle", "interceptions",
                   "picks"):
            bump("zoneCoverage", 5)
            bump("playRecognition", 3)
        if has_any("range", "long stride", "covers ground", "sideline-to-sideline"):
            bump("pursuit", 5)
            bump("speed", 2)
        if has_any("blitzer", "blitz", "pressure"):
            bump("pursuit", 3)

    elif pos in ("OLB", "MLB"):
        if has_any("tackler", "tackling", "tackle", "willing tackler",
                   "downhill tackler", "form tackler", "sure tackler"):
            bump("tackle", 6)
            bump("pursuit", 3)
        if has_any("thumper", "explosive hits", "punishing", "violent",
                   "knockout hits", "delivers blows"):
            bump("hitPower", 6)
        if has_any("blitzer", "blitz", "pass rush", "rusher",
                   "pass-rush", "edge setter", "sack artist"):
            bump("powerMoves", 5)
            bump("finesseMoves", 5)
        if has_any("coverage", "drops in coverage", "covers tight ends",
                   "covers backs", "man coverage", "zone awareness"):
            bump("manCoverage", 5)
            bump("zoneCoverage", 5)
        if has_any("sideline-to-sideline", "rangy", "covers ground", "range"):
            bump("pursuit", 5)
            bump("speed", 2)
        if has_any("sheds blocks", "shed", "stack and shed",
                   "block destruction", "takes on blocks"):
            bump("blockShedding", 6)

    elif pos == "DE":
        if has_any("bend", "bender", "dip", "ghost", "pass-rush",
                   "pass rush moves", "swim", "rip", "long-arm",
                   "speed rush", "speed-rush"):
            bump("finesseMoves", 7)
            bump("acceleration", 2)
        if has_any("bull rush", "speed-to-power", "powerful", "violent hands",
                   "power rush", "long-arm", "drives blockers"):
            bump("powerMoves", 7)
            bump("strength", 2)
        if has_any("run defender", "stout against the run", "anchor",
                   "edge setter", "sets the edge", "strong against the run",
                   "sheds blocks"):
            bump("blockShedding", 6)
            bump("tackle", 4)
            bump("strength", 2)
        if has_any("relentless", "high motor", "motor", "non-stop",
                   "never-quit"):
            bump("pursuit", 5)
            bump("stamina", 4)
        if has_any("hand usage", "hand fighter", "active hands",
                   "violent hands", "club", "swat"):
            bump("blockShedding", 4)
            bump("powerMoves", 3)

    elif pos == "DT":
        if has_any("bull rush", "speed-to-power", "powerful",
                   "violent hands", "powerful hands", "drives blockers",
                   "forklift"):
            bump("powerMoves", 7)
            bump("strength", 3)
        if has_any("first step", "burst", "quick first step", "penetrator",
                   "gap-shooter", "shoots gaps", "explosive get-off"):
            bump("finesseMoves", 5)
            bump("acceleration", 3)
        if has_any("anchor", "stout against the run", "two-gap",
                   "stack and shed", "immovable", "block-eater",
                   "strength", "powerful", "leverage"):
            bump("blockShedding", 6)
            bump("strength", 3)
        if has_any("relentless", "motor", "high motor", "constantly working"):
            bump("pursuit", 5)
            bump("stamina", 3)

    elif pos == "WR":
        if has_any("sure-handed", "reliable hands", "natural hands",
                   "soft hands", "snatches", "few drops", "low drop rate"):
            bump("catching", 5)
        if has_any("contested-catch", "contested catch", "high-pointer",
                   "physical receiver", "go up and get it", "jump ball",
                   "back-shoulder", "wins 50-50"):
            bump("spectacularCatch", 6)
            bump("catchInTraffic", 5)
            bump("jumping", 3)
        if has_any("route runner", "route running", "precise routes",
                   "savvy route runner", "sharp routes", "route tree",
                   "creates separation", "separation", "footwork"):
            bump("shortRouteRunning", 5)
            bump("mediumRouteRunning", 4)
            bump("release", 3)
        if has_any("yac", "after the catch", "after-the-catch", "elusive",
                   "shifty", "make-you-miss", "broken tackle", "broken tackles"):
            bump("changeOfDirection", 5)
            bump("breakTackle", 4)
            bump("jukeMove", 3)
        if has_any("deep threat", "deep-threat", "field stretcher",
                   "vertical threat", "track speed", "long speed", "burner"):
            bump("deepRouteRunning", 5)
            bump("speed", 3)
        if has_any("slot", "shifty slot", "slot receiver", "quick separator"):
            bump("shortRouteRunning", 4)
            bump("agility", 3)
        if has_any("size", "big-bodied", "tall", "frame", "physical at the catch"):
            bump("strength", 3)
            bump("catchInTraffic", 3)
        if has_any("blocker", "willing blocker", "physical blocker"):
            bump("runBlock", 4)
            bump("impactBlocking", 3)

    elif pos == "TE":
        if has_any("blocker", "willing blocker", "in-line blocker",
                   "drive blocker", "Y-tight end", "lead blocker"):
            bump("runBlock", 7)
            bump("impactBlocking", 5)
            bump("passBlock", 3)
        if has_any("seam", "vertical threat", "mismatch", "field stretcher",
                   "speed", "athletic tight end", "f-tight end"):
            bump("mediumRouteRunning", 5)
            bump("deepRouteRunning", 5)
            bump("speed", 2)
        if has_any("contested-catch", "high-pointer", "wins 50-50",
                   "go up and get it"):
            bump("spectacularCatch", 5)
            bump("catchInTraffic", 4)
        if has_any("route", "route runner", "route running", "precise routes",
                   "creates separation"):
            bump("shortRouteRunning", 5)
            bump("release", 3)
        if has_any("hands", "soft hands", "reliable hands", "sure-handed"):
            bump("catching", 4)
        if has_any("after the catch", "yac", "shifty"):
            bump("breakTackle", 3)
            bump("changeOfDirection", 3)

    elif pos == "HB":
        if has_any("vision", "patient runner", "decisive cuts",
                   "patient", "sets up blocks", "find the cutback",
                   "follows blocks", "field vision"):
            bump("ballCarrierVision", 5)
            bump("awareness", 2)
        if has_any("contact balance", "tough runner", "powerful",
                   "punishing", "runs through tackles", "lowers the boom"):
            bump("trucking", 5)
            bump("breakTackle", 5)
            bump("strength", 2)
        if has_any("shifty", "elusive", "make-you-miss", "elusiveness",
                   "jump cut", "ankle breaker", "jukes", "spin",
                   "lateral agility"):
            bump("jukeMove", 6)
            bump("spinMove", 4)
            bump("changeOfDirection", 3)
        if has_any("speed", "burner", "track speed", "home-run hitter",
                   "big-play", "explosive runner", "breakaway speed"):
            bump("speed", 3)
            bump("acceleration", 2)
        # Receiving-back signals — base bumps fire on any receiving keyword.
        receives = has_any("receiving", "pass-catching back", "third-down back",
                           "receiving threat", "soft hands", "checkdown",
                           "screen game", "pass-catching", "pass catcher",
                           "split out wide", "lined up out wide")
        routes   = has_any("route runner", "route running", "talented route runner",
                           "precise routes", "savvy route runner", "sharp routes",
                           "route tree", "from the slot", "slot back",
                           "mismatch linebackers")
        if receives or routes:
            bump("catching", 6)
            bump("shortRouteRunning", 6)        # leads the route trio for HBs
            bump("mediumRouteRunning", 2)       # HBs run mostly short routes
            bump("release", 4)
            bump("catchInTraffic", 3)
        # Strong receiving back — both pass-catching AND route-running cited.
        # Set FLOORS so the HB_ReceivingBack archetype score
        # (avg(catching, shortRouteRunning, release)) lands ~80 — matching
        # NFL receiving backs like Kamara/Ekeler. floor(s, v) = max(r[s], v).
        if receives and routes:
            r["catching"]          = max(r.get("catching", 0), 82)
            r["shortRouteRunning"] = max(r.get("shortRouteRunning", 0), 78)
            r["release"]           = max(r.get("release", 0), 76)
            r["catchInTraffic"]    = max(r.get("catchInTraffic", 0), 65)
        # HB route-running cascade: short >= medium >= deep. RBs run more
        # short routes than medium and rarely run deep ones — so a higher
        # mediumRouteRunning than shortRouteRunning is unrealistic.
        if "shortRouteRunning" in r:
            short = r["shortRouteRunning"]
            if r.get("mediumRouteRunning", 0) > short:
                r["mediumRouteRunning"] = short
            mid = r.get("mediumRouteRunning", short)
            if r.get("deepRouteRunning", 0) > mid:
                r["deepRouteRunning"] = mid
        if has_any("pass blocker", "pass protection", "blitz pickup"):
            bump("passBlock", 4)
            bump("impactBlocking", 3)
        if has_any("ball security", "no fumbles", "rarely fumbles"):
            bump("carrying", 4)
        if has_any("bell-cow", "workhorse", "feature back", "every-down back"):
            bump("stamina", 5)
            bump("toughness", 3)

    elif pos == "QB":
        if has_any("accuracy", "accurate", "accurate passer",
                   "ball placement", "pinpoint", "precision",
                   "puts the ball where it needs to be"):
            bump("throwAccuracyShort", 4)
            bump("throwAccuracyMid", 4)
            bump("throwAccuracyDeep", 3)
        if has_any("arm strength", "live arm", "cannon", "big arm",
                   "drives the ball", "fastball"):
            bump("throwPower", 5)
            bump("throwAccuracyDeep", 3)
        if has_any("anticipation", "anticipates", "throws receivers open",
                   "throws with timing", "rhythm passer"):
            bump("throwAccuracyMid", 3)
            bump("throwUnderPressure", 3)
        if has_any("mobile", "athletic qb", "dual-threat", "scrambler",
                   "mobility", "extends plays", "extends the play",
                   "off-script", "improviser"):
            bump("throwOnTheRun", 5)
            bump("breakSack", 4)
            bump("speed", 2)
        if has_any("pocket presence", "navigates the pocket",
                   "moves in the pocket", "stands in"):
            bump("throwUnderPressure", 5)
            bump("breakSack", 3)
        if has_any("playaction", "play-action", "play action", "boot"):
            bump("playAction", 5)
        if has_any("decision-maker", "good decisions", "limits turnovers",
                   "low interception"):
            bump("awareness", 3)

    elif pos in ("T", "G", "C"):
        if has_any("mauler", "powerful", "drive blocker",
                   "finishes blocks", "lowers the boom", "punisher",
                   "tone-setter"):
            bump("runBlockPower", 6)
            bump("impactBlocking", 5)
            bump("leadBlock", 4)
            bump("strength", 2)
        if has_any("anchor", "anchors", "stout", "rock-solid",
                   "absorbs the bull rush", "immovable"):
            bump("passBlockPower", 5)
            bump("strength", 2)
        if has_any("agile", "light feet", "quick feet", "athletic",
                   "moves well", "dancing feet", "fluid", "quick set"):
            bump("passBlockFinesse", 5)
            bump("agility", 3)
        if has_any("technician", "refined technique", "great hands",
                   "hand placement", "polished"):
            bump("passBlock", 4)
            bump("runBlock", 3)
        if has_any("zone blocker", "zone scheme", "second level",
                   "climbs to second level", "pulls", "puller", "pulling"):
            bump("runBlockFinesse", 5)
            bump("agility", 3)
        if has_any("smart", "intelligent", "communicates", "calls protections"):
            bump("awareness", 4)
            bump("playRecognition", 3)

    elif pos == "K":
        if has_any("strong leg", "big leg", "long-range"):
            bump("kickPower", 6)
        if has_any("accurate", "consistent", "automatic", "high accuracy"):
            bump("kickAccuracy", 6)

    elif pos == "P":
        if has_any("strong leg", "big leg", "boomer"):
            bump("kickPower", 6)
        if has_any("directional", "pin-deep", "coffin corner", "place punter"):
            bump("kickAccuracy", 6)

    return r


def apply_dev_trait_by_pick(ratings: dict, actual_pick: int | None) -> dict:
    """
    Deterministic devTrait floor based on actual draft slot. The LLM tends to
    park everyone at Normal/Impact, so we anchor elite picks upward.

    Encoding: 0=Normal, 1=Impact, 2=Star, 3=XFactor.
    """
    r = dict(ratings)
    if not actual_pick:
        return r
    cur = int(r.get("devTrait", 0) or 0)
    if actual_pick == 1:
        floor = 3                          # XFactor for #1 overall
    elif actual_pick <= 5:
        floor = 2                          # Star for top-5
    elif actual_pick <= 12:
        floor = 2                          # Star for rest of top-12
    elif actual_pick <= 32:
        floor = 1                          # Impact for R1
    else:
        floor = 0
    if cur < floor:
        r["devTrait"] = floor
    return r


def apply_position_corrections(ratings: dict, pos: str, forty: float | None) -> dict:
    """
    Apply rule-based post-processing to fix known LLM systematic errors:
    - OL: cap DL stats, fix acceleration floor
    - WR: apply speed position bonus
    - FS/SS: ensure coverage stats aren't at defaults
    """
    r = dict(ratings)

    OL_DL_CAPS = {
        "T": {"blockShedding": 33, "powerMoves": 30, "finesseMoves": 23, "tackle": 32, "hitPower": 35, "pursuit": 28},
        "G": {"blockShedding": 38, "powerMoves": 34, "finesseMoves": 30, "tackle": 33, "hitPower": 37, "pursuit": 33},
        "C": {"blockShedding": 30, "powerMoves": 22, "finesseMoves": 17, "tackle": 30, "hitPower": 31, "pursuit": 31},
    }
    OL_ACC_FLOOR = {"T": 68, "G": 68, "C": 70}
    # Speed/agility floors derived from calibration (DE group = OL players).
    # Speed table: (forty, speed) pairs from real M26 OL ratings.
    OL_SPEED_TABLE = [(4.95, 74), (5.11, 69), (5.20, 67), (5.38, 60)]
    OL_SPD_FLOOR  = {"T": 60, "G": 58, "C": 60}
    OL_AGI_FLOOR  = {"T": 63, "G": 62, "C": 63}

    if pos in OL_DL_CAPS:
        caps = OL_DL_CAPS[pos]
        for stat, cap in caps.items():
            if r.get(stat, 0) > cap:
                r[stat] = cap
        # Acceleration floor
        floor = OL_ACC_FLOOR.get(pos, 68)
        if r.get("acceleration", 0) < floor:
            r["acceleration"] = floor
        # Speed floor: interpolate from forty time, fall back to position floor
        spd = r.get("speed", 0)
        spd_floor = OL_SPD_FLOOR.get(pos, 58)
        if forty is not None:
            t_vals = [t for t, _ in OL_SPEED_TABLE]
            s_vals = [s for _, s in OL_SPEED_TABLE]
            if forty <= t_vals[0]:
                expected_spd = s_vals[0]
            elif forty >= t_vals[-1]:
                expected_spd = s_vals[-1]
            else:
                for i in range(len(t_vals) - 1):
                    if t_vals[i] <= forty <= t_vals[i + 1]:
                        frac = (forty - t_vals[i]) / (t_vals[i + 1] - t_vals[i])
                        expected_spd = round(s_vals[i] + frac * (s_vals[i + 1] - s_vals[i]))
                        break
            spd_floor = max(spd_floor, expected_spd - 2)
        if spd < spd_floor:
            r["speed"] = spd_floor
        # Agility floor
        agi_floor = OL_AGI_FLOOR.get(pos, 55)
        if r.get("agility", 0) < agi_floor:
            r["agility"] = agi_floor
        # leadBlock floor — the LLM consistently undershoots this stat for OL
        # (treats it as FB-only).  Real M26 starting OL sit in 80-95 lead-block;
        # rookies typically 65-80.  Madden's OVR formula weights leadBlock for
        # G/T/C, so leaving it at 20-30 collapses the displayed OVR.
        ovr = r.get("overall", 0)
        lb_floor = max(62, ovr - 6) if ovr else 62
        if r.get("leadBlock", 0) < lb_floor:
            r["leadBlock"] = lb_floor
        # impactBlocking cap — the LLM consistently OVER-rates this for OL,
        # producing 80-90s on rookies (which is starter-grade).  Real M26
        # OL rookies live in the OVR-12 .. OVR+0 band.  Cap to OVR.
        ib_cap = ovr if ovr else 75
        if r.get("impactBlocking", 0) > ib_cap:
            r["impactBlocking"] = ib_cap
        # OL accel/speed should track closely (usually within ~4). If the LLM
        # produced a wide gap (e.g. spd=63 / acc=72), pull them together.
        spd = r.get("speed", 0)
        acc = r.get("acceleration", 0)
        if spd and acc and acc - spd > 4:
            r["acceleration"] = spd + 4
        elif spd and acc and spd - acc > 4:
            r["speed"] = acc + 4

    # WR speed correction: use calibration-derived table; only correct upward when
    # the LLM undershot the expected WR speed for a given forty time.
    if pos == "WR":
        WR_SPEED_TABLE = [
            (4.30, 96), (4.34, 94), (4.37, 93), (4.40, 92),
            (4.42, 92), (4.44, 91), (4.46, 90), (4.48, 90),
            (4.51, 89), (4.59, 86), (4.61, 85),
        ]
        spd = r.get("speed", 0)
        if forty is not None and spd > 0:
            # Interpolate expected WR speed from forty time
            table_forties = [t for t, _ in WR_SPEED_TABLE]
            table_speeds = [s for _, s in WR_SPEED_TABLE]
            if forty <= table_forties[0]:
                expected = table_speeds[0]
            elif forty >= table_forties[-1]:
                expected = table_speeds[-1]
            else:
                for i in range(len(table_forties) - 1):
                    if table_forties[i] <= forty <= table_forties[i + 1]:
                        t0, t1 = table_forties[i], table_forties[i + 1]
                        s0, s1 = table_speeds[i], table_speeds[i + 1]
                        frac = (forty - t0) / (t1 - t0)
                        expected = round(s0 + frac * (s1 - s0))
                        break
            if spd < expected:
                r["speed"] = expected

    # CB tackle / hitPower / pursuit floor.  The LLM defaults all three to
    # ~30 across every CB, treating them as non-CB stats.  Real M26 CB rookies
    # tackle 50-65, hit-power 45-60, pursuit 60-75.
    if pos == "CB":
        ovr = r.get("overall", 0)
        tk_floor = max(48, ovr - 16)
        hp_floor = max(42, ovr - 22)
        pu_floor = max(60, ovr - 8)
        if r.get("tackle", 0) < tk_floor:
            r["tackle"] = tk_floor
        if r.get("hitPower", 0) < hp_floor:
            r["hitPower"] = hp_floor
        if r.get("pursuit", 0) < pu_floor:
            r["pursuit"] = pu_floor

    # QB ball-carrier floor.  Even pocket QBs aren't single-digit-stiff-arm.
    # Real M26 QBs sit in stiff-arm 40-60, juke/spin 35-55, trucking 35-55,
    # change-of-direction 55-75 (mobile QBs higher).  The LLM zeroes them.
    if pos == "QB":
        ovr  = r.get("overall", 0)
        spd  = r.get("speed", 0)
        # Mobile QB bonus when high speed
        mobile = 1 if spd >= 80 else 0
        for stat, base in (
            ("stiffArm", 40), ("trucking", 35),
            ("spinMove", 35), ("jukeMove", 35),
            ("changeOfDirection", 55),
        ):
            floor = base + (5 * mobile)
            if r.get(stat, 0) < floor:
                r[stat] = floor
        # carrying floor for QBs (ball security as a runner)
        if r.get("carrying", 0) < 55:
            r["carrying"] = 55
        # breakTackle floor
        if r.get("breakTackle", 0) < 35 + (10 * mobile):
            r["breakTackle"] = 35 + (10 * mobile)

    # TE shortRouteRunning / release floor.  The LLM under-rates pass-catching
    # TEs' route-running, treating them as primarily blockers.  Real M26 TE
    # rookies short-route-run 60-75 and release 55-70.
    if pos == "TE":
        ovr = r.get("overall", 0)
        sr_floor = max(58, ovr - 12)
        rl_floor = max(52, ovr - 18)
        if r.get("shortRouteRunning", 0) < sr_floor:
            r["shortRouteRunning"] = sr_floor
        if r.get("release", 0) < rl_floor:
            r["release"] = rl_floor

    # QB throwAccuracy aggregate sync.  Madden's display logic sometimes uses
    # the aggregate `throwAccuracy` instead of the individual short/mid/deep,
    # and the LLM frequently sets the aggregate lower than the avg of the
    # three (unclear why — token-prediction bias).  Force the aggregate to be
    # the mean so the displayed OVR reflects the per-range stats.
    if pos == "QB":
        s = r.get("throwAccuracyShort", 0)
        m = r.get("throwAccuracyMid",   0)
        d = r.get("throwAccuracyDeep",  0)
        if s and m and d:
            avg = round((s + m + d) / 3)
            cur = r.get("throwAccuracy", 0)
            # Only correct upward — don't lower a self-rated high aggregate.
            if cur < avg:
                r["throwAccuracy"] = avg

    # TE speed correction: modern TEs are trending faster; only correct upward.
    # Anchored so a 4.39 (Kenyon Sadiq) yields 92, tapering to calibration range
    # (~87) by 4.50 and below 80 for true blocking TEs.
    if pos == "TE":
        TE_SPEED_TABLE = [
            (4.39, 92), (4.44, 90), (4.50, 87), (4.60, 83), (4.70, 80),
        ]
        spd = r.get("speed", 0)
        if forty is not None and spd > 0:
            table_forties = [t for t, _ in TE_SPEED_TABLE]
            table_speeds  = [s for _, s in TE_SPEED_TABLE]
            if forty <= table_forties[0]:
                expected = table_speeds[0]
            elif forty >= table_forties[-1]:
                expected = table_speeds[-1]
            else:
                for i in range(len(table_forties) - 1):
                    if table_forties[i] <= forty <= table_forties[i + 1]:
                        t0, t1 = table_forties[i], table_forties[i + 1]
                        s0, s1 = table_speeds[i], table_speeds[i + 1]
                        frac = (forty - t0) / (t1 - t0)
                        expected = round(s0 + frac * (s1 - s0))
                        break
            if spd < expected:
                r["speed"] = expected

    # DE / OLB / DT speed ceiling from forty — LLM systematically over-rates
    # edge speed (e.g. 4.5 forty → 92 spd, but calibration shows ~88).
    # Applies both ways: floor to avoid over-penalizing, cap to prevent LLM inflation.
    EDGE_SPEED_TABLE = [
        (4.35, 94), (4.40, 92), (4.45, 90), (4.50, 88),
        (4.55, 86), (4.60, 84), (4.65, 82), (4.70, 80),
        (4.80, 77), (4.90, 73),
    ]
    DT_SPEED_TABLE = [
        (4.70, 85), (4.80, 82), (4.90, 78), (5.00, 74),
        (5.10, 70), (5.20, 67),
    ]
    if forty is not None and pos in ("DE", "OLB", "DT"):
        table = DT_SPEED_TABLE if pos == "DT" else EDGE_SPEED_TABLE
        expected = _lerp(float(forty), table)
        spd = r.get("speed", 0)
        # Cap at expected + 1 (allow minor LLM deviation upward)
        if spd > expected + 1:
            r["speed"] = expected + 1
        # Also floor at expected - 3 (don't under-sell clear testers)
        elif spd < expected - 3:
            r["speed"] = expected - 3
        # Acceleration: cap ~3 above speed (calibration pattern for front 7)
        acc = r.get("acceleration", 0)
        if acc > r["speed"] + 4:
            r["acceleration"] = r["speed"] + 4

    # Agility floor for skill positions: calibration shows no TE/WR/HB/etc has
    # agility more than ~15 points below their speed. Floor = max(65, speed - 15).
    SKILL_AGI_POSITIONS = {"QB", "HB", "FB", "WR", "TE", "CB", "FS", "SS", "MLB", "OLB", "DE"}
    if pos in SKILL_AGI_POSITIONS:
        spd = r.get("speed", 0)
        agi = r.get("agility", 0)
        agi_floor = max(65, spd - 15) if spd > 65 else 65
        if agi < agi_floor:
            r["agility"] = agi_floor

    # Safety coverage floor: if coverage stats look like defaults, bump them
    if pos in ("FS", "SS"):
        if r.get("zoneCoverage", 0) < 60:
            r["zoneCoverage"] = max(r.get("zoneCoverage", 0), 65)
        if r.get("strength", 0) < 50:
            r["strength"] = 65
        if r.get("playRecognition", 0) < 55:
            r["playRecognition"] = max(r.get("playRecognition", 0), 65)
        if r.get("awareness", 0) < 62:
            r["awareness"] = max(r.get("awareness", 0), 65)

    # CB: cap TRUE DL stats only (calibration group is misaligned — contains
    # DTs, not CBs).  tackle/hitPower/pursuit USED to be on this list but
    # they're legitimate CB stats — capping them at 30 collapsed run support.
    if pos == "CB":
        for stat in ("blockShedding", "powerMoves", "finesseMoves"):
            if r.get(stat, 0) > 30:
                r[stat] = 30
        if r.get("manCoverage", 0) < 55:
            r["manCoverage"] = max(r.get("manCoverage", 0), 60)
        if r.get("zoneCoverage", 0) < 55:
            r["zoneCoverage"] = max(r.get("zoneCoverage", 0), 60)
        if r.get("playRecognition", 0) < 62:
            r["playRecognition"] = max(r.get("playRecognition", 0), 65)

    # MLB: zone coverage and awareness floor
    if pos == "MLB":
        if r.get("zoneCoverage", 0) < 58:
            r["zoneCoverage"] = max(r.get("zoneCoverage", 0), 62)
        if r.get("awareness", 0) < 60:
            r["awareness"] = max(r.get("awareness", 0), 63)

    # Offensive skill positions: cap defensive-specific stats the LLM inflates.
    # blockShedding/finesseMoves/powerMoves are DL pass-rush stats.
    # tackle/hitPower/pursuit/coverage are defensive stats.
    PASS_RUSH_STATS  = ("blockShedding", "finesseMoves", "powerMoves")
    DEF_SKILL_STATS  = ("tackle", "hitPower", "pursuit")
    COVERAGE_STATS   = ("zoneCoverage", "manCoverage", "pressCoverage")

    if pos in ("QB", "WR"):
        for stat in PASS_RUSH_STATS:
            r[stat] = min(r.get(stat, 28), 38)
        for stat in DEF_SKILL_STATS:
            r[stat] = min(r.get(stat, 28), 42)
        for stat in COVERAGE_STATS:
            r[stat] = min(r.get(stat, 28), 42)

    elif pos in ("HB", "FB"):
        for stat in PASS_RUSH_STATS:
            r[stat] = min(r.get(stat, 28), 42)
        for stat in DEF_SKILL_STATS:
            r[stat] = min(r.get(stat, 28), 50)
        for stat in COVERAGE_STATS:
            r[stat] = min(r.get(stat, 28), 42)
        # Cap ball-carry stats: even elite rookie HBs rarely exceed 88-90
        for stat in ("carrying", "breakTackle", "stiffArm", "trucking"):
            if r.get(stat, 0) > 90:
                r[stat] = 90

    elif pos == "TE":
        for stat in PASS_RUSH_STATS:
            r[stat] = min(r.get(stat, 28), 42)

    # DT/NT athletic floors: calibration min is speed=60, accel≈62, agility=51.
    # Any value below these is a ghost/fallback the LLM invented.
    if pos in ("DT", "NT"):
        if r.get("speed", 0) < 60:
            r["speed"] = 60
        if r.get("acceleration", 0) < 62:
            r["acceleration"] = 62
        spd = r.get("speed", 0)
        agi_floor = max(55, spd - 15)
        if r.get("agility", 0) < agi_floor:
            r["agility"] = agi_floor

    # Acceleration floor: calibration shows accel is almost always >= speed for
    # skill positions. For all non-OL/K/P/LS, never allow accel to be more than
    # 5 points below speed. For pure skill positions, accel should be >= speed.
    SKILL_POSITIONS = {"QB", "HB", "FB", "WR", "TE", "CB", "FS", "SS", "MLB", "OLB", "DE"}
    HEAVY_POSITIONS = {"DT", "DE"}  # slightly more lenient
    NON_SKILL = {"T", "G", "C", "K", "P", "LS"}
    spd = r.get("speed", 0)
    acc = r.get("acceleration", 0)
    if spd > 0 and acc > 0 and pos not in NON_SKILL:
        if pos in SKILL_POSITIONS:
            # Skill players: accel should be >= speed (calibration shows accel >= spd)
            if acc < spd:
                r["acceleration"] = spd
        else:
            # DT and others: accel never more than 5 below speed
            if acc < spd - 5:
                r["acceleration"] = spd - 5

    return r


# ── Rate a single prospect ────────────────────────────────────────────────────
def rate_prospect(
    prospect: dict,
    model: str,
    calibration: dict,
    current_ratings: dict,
    reference_class: dict | None = None,
    ovr_formulas: dict | None = None,
    profiles: dict | None = None,
    prior_ovrs: dict | None = None,
    verbose: bool = False,
    use_llm: bool = False,
) -> dict:
    """
    Generate Madden 26 ratings for a single prospect.
    Returns the ratings dict (fully validated).
    """
    pos = prospect["pos"]
    canon = canonical_pos(pos)
    all_fields_str = ", ".join(ALL_RATING_FIELDS)
    defaults = get_defaults(canon)

    # Gather context
    cal_examples = get_calibration_examples(pos, prospect, calibration)
    anchors      = get_current_anchors(pos, current_ratings) if current_ratings else []
    ref_ratings  = get_reference_ratings(prospect, reference_class) if reference_class else None
    tier_anchor  = get_tier_anchor(prospect, calibration)

    # Hand-curated scouting profile (strengths/weaknesses) — keyed by normalized name
    profile = None
    if profiles:
        pkey = norm_name(prospect.get("name") or f"{prospect.get('firstName','')} {prospect.get('lastName','')}")
        profile = profiles.get(pkey)

    if use_llm:
        # Legacy LLM path — kept for comparison / fallback.
        prompt = build_prompt(prospect, cal_examples, anchors, ref_ratings, tier_anchor, profile)

        text = ""
        ratings_raw = None
        try:
            text = call_ollama(model, prompt)
        except Exception as e:
            if "Connection" in type(e).__name__ or "ConnectionRefused" in str(e) or "connect" in str(e).lower():
                raise ConnectionError(
                    f"Cannot reach Ollama at {OLLAMA_HOST}. "
                    "Please start Ollama with: ollama serve"
                ) from e
            print(f"  [WARN] Ollama error on first attempt: {e}")

        if text:
            ratings_raw = extract_json(text)

        missing_count = 0
        if ratings_raw:
            missing_count = sum(1 for f in ALL_RATING_FIELDS if f not in ratings_raw)

        if ratings_raw is None or missing_count > 10:
            correction_prompt = build_correction_prompt(all_fields_str, text)
            try:
                text2 = call_ollama(model, correction_prompt)
                ratings_raw2 = extract_json(text2)
                if ratings_raw2 is not None:
                    ratings_raw = ratings_raw2
                    text = text2
            except ConnectionError:
                raise
            except Exception as e:
                print(f"  [WARN] Ollama error on retry: {e}")

        if ratings_raw is None:
            print(f"  [ERR] Could not parse ratings for {prospect.get('name')} — using defaults")
            return dict(defaults)

        cleaned, issues = validate_ratings(ratings_raw, canon)

        if verbose and issues:
            print(f"  ↳ Fixed {len(issues)} field(s): {', '.join(issues[:5])}"
                  + (" ..." if len(issues) > 5 else ""))
    else:
        # ── Statistical baseline (default): centroid of nearest 2025 rookies ──
        # Pulls a similarity-weighted attribute vector from calibration_set.json
        # so we start from REAL M26 rookie distributions instead of LLM
        # hallucinations.  Post-processing (position/profile/combine/dev) still
        # runs on top.
        canon_key_fields = set(POSITION_KEY_FIELDS.get(canon, [])) | {"overall", "devTrait"}
        baseline = sample_baseline_ratings(
            prospect, calibration, ALL_RATING_FIELDS,
            key_fields=canon_key_fields,
        )
        # Fill any field that the centroid couldn't produce (rare — only when
        # NO neighbors had the field) with the position default.
        for f in ALL_RATING_FIELDS:
            if f not in baseline:
                baseline[f] = defaults.get(f, 50)
        # validate_ratings is still useful as a safety net (clamp into [0,99],
        # devTrait into [0,3], handle non-numeric).
        cleaned, issues = validate_ratings(baseline, canon)
        if verbose and issues:
            print(f"  ↳ Fixed {len(issues)} field(s): {', '.join(issues[:5])}"
                  + (" ..." if len(issues) > 5 else ""))

    cleaned = apply_position_corrections(cleaned, pos, prospect.get("forty"))
    cleaned = apply_profile_corrections(cleaned, pos, prospect.get("notes"))
    cleaned = apply_position_overshoot_dampener(cleaned, pos)
    cleaned = apply_top_pick_awareness_floor(cleaned, pos, prospect.get("actual_draft_pick"))
    cleaned = apply_top_pick_ol_floor(cleaned, pos, prospect.get("actual_draft_pick"))
    cleaned = apply_late_pick_dampener(cleaned, pos, prospect.get("actual_draft_pick"))
    cleaned = apply_dev_trait_by_pick(cleaned, prospect.get("actual_draft_pick"))
    cleaned = apply_combine_corrections(
        cleaned, pos,
        bench     = prospect.get("bench"),
        vertical  = prospect.get("vertical"),
        cone      = prospect.get("cone"),
        shuttle   = prospect.get("shuttle"),
        ten_split = prospect.get("ten_split"),
        forty     = prospect.get("forty"),
    )

    # ── Deterministic OVR ────────────────────────────────────────────────────
    # The LLM's self-reported 'overall' is often inconsistent with its own
    # attribute output.  Recompute deterministically, anchored to the 2025
    # rookie at the same draft tier when available.
    if ovr_formulas is not None:
        pkey_ovr = norm_name(prospect.get("name") or f"{prospect.get('firstName','')} {prospect.get('lastName','')}")
        prior = (prior_ovrs or {}).get(pkey_ovr)
        cleaned["overall"] = compute_ovr(
            cleaned, pos, ovr_formulas, tier_anchor,
            actual_pick=prospect.get("actual_draft_pick"),
            prior_ovr=prior,
        )

    return cleaned


# ── Checkpoint helpers ────────────────────────────────────────────────────────
def load_checkpoint() -> list:
    if os.path.exists(CHECKPOINT_FILE):
        with open(CHECKPOINT_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    return []


def save_checkpoint(rated: list) -> None:
    with open(CHECKPOINT_FILE, "w", encoding="utf-8") as f:
        json.dump(rated, f, indent=2)


# ── Main ──────────────────────────────────────────────────────────────────────
def main():
    parser = argparse.ArgumentParser(description="Generate Madden 26 ratings for 2026 prospects via Ollama.")
    parser.add_argument("--model", default=None, help="Ollama model name (default: from .env or llama3:8b)")
    parser.add_argument("--resume", action="store_true", help="Resume from checkpoint if available")
    parser.add_argument("--verbose", action="store_true", help="Print field-fix details")
    parser.add_argument("--max-prospects", type=int, default=None, help="Limit number of prospects to rate (for testing)")
    parser.add_argument("--only", default=None,
        help="Only regenerate ratings for these names (comma-separated). "
             "Matches by normalized name, last-name, or first+last substring. "
             "All other existing ratings are preserved.")
    parser.add_argument("--positions", default=None,
        help="Only regenerate ratings for these positions (comma-separated, e.g. DE,OLB,DT). "
             "All other existing ratings are preserved.")
    parser.add_argument("--use-llm", action="store_true",
        help="Use the legacy Ollama LLM pipeline. Default is statistical "
             "neighbor sampling from data/calibration_set.json (no LLM, ~instant).")
    parser.add_argument("--no-prior-clamp", action="store_true",
        help="Bypass the prior_ovr ±2 stability clamp. Use this for a clean "
             "baseline regen (e.g. when switching from LLM to statistical).")
    args = parser.parse_args()

    model = args.model or DEFAULT_MODEL
    use_llm = bool(args.use_llm)

    # ── Load input data ──
    print(f"Loading prospects from {PROSPECTS_FILE} ...")
    with open(PROSPECTS_FILE, "r", encoding="utf-8") as f:
        prospects: list[dict] = json.load(f)
    print(f"  {len(prospects)} prospects loaded.")

    print(f"Loading calibration set from {CALIBRATION_FILE} ...")
    with open(CALIBRATION_FILE, "r", encoding="utf-8") as f:
        calibration: dict = json.load(f)

    # Fit per-position OVR formulas from the 2025 calibration.  These give us
    # a deterministic, reproducible OVR in place of the LLM's self-reported value.
    print("Fitting OVR formulas from calibration ...")
    ovr_formulas = build_ovr_formulas(calibration)
    print(f"  Fitted {len(ovr_formulas)} position formulas.")

    # Hand-curated scouting profiles (strengths/weaknesses from NFL.com/ESPN/PFF)
    profiles: dict = {}
    if os.path.exists(PROFILES_FILE):
        try:
            with open(PROFILES_FILE, "r", encoding="utf-8") as f:
                profiles = json.load(f)
            print(f"Loaded {len(profiles)} scouting profiles from {PROFILES_FILE}")
        except Exception as e:
            print(f"  WARN: could not load profiles: {e}")

    # Prior OVRs (for stability clamp — prevents large swings between runs).
    # Skipped when --no-prior-clamp is set (used for from-scratch baseline regen).
    prior_ovrs: dict = {}
    if not args.no_prior_clamp and os.path.exists(OUTPUT_FILE):
        try:
            with open(OUTPUT_FILE, "r", encoding="utf-8") as f:
                prior_rated = json.load(f)
            for p in prior_rated:
                nm = norm_name(p.get("name") or f"{p.get('firstName','')} {p.get('lastName','')}")
                ovr = p.get("ratings", {}).get("overall")
                if nm and ovr:
                    prior_ovrs[nm] = ovr
            print(f"Loaded {len(prior_ovrs)} prior OVRs from {OUTPUT_FILE} (stability clamp ±2)")
        except Exception as e:
            print(f"  WARN: could not load prior ratings: {e}")
    elif args.no_prior_clamp:
        print("--no-prior-clamp set: skipping prior_ovr stability clamp.")

    current_ratings: dict = {}
    if os.path.exists(CURRENT_RATINGS_FILE):
        print(f"Loading current player ratings from {CURRENT_RATINGS_FILE} ...")
        with open(CURRENT_RATINGS_FILE, "r", encoding="utf-8") as f:
            current_ratings = json.load(f)
    elif os.path.exists(ROSTER_PLAYERS_FILE):
        print(f"Loading roster anchors from {ROSTER_PLAYERS_FILE} ...")
        current_ratings = load_roster_players(ROSTER_PLAYERS_FILE)
        pos_counts = {p: len(v) for p, v in current_ratings.items()}
        print(f"  {sum(pos_counts.values())} players loaded across {len(pos_counts)} positions.")
    else:
        print("  (No current_player_ratings.json or roster_players_rated.json found — skipping anchors)")

    # ── Load community reference draft class ──
    reference_class: dict = load_reference_class(REFERENCE_CLASS_FILE)
    if reference_class:
        print(f"Loaded reference draft class: {len(reference_class)} prospects from {REFERENCE_CLASS_FILE}")
    else:
        print("  (No reference_draft_class.json found — skipping community reference)")

    # ── Check Ollama connectivity early (only when LLM mode is requested) ──
    if use_llm:
        try:
            import ollama
            # Quick connectivity test — list models
            ollama.list()
        except Exception as e:
            err_str = str(e).lower()
            if "connection" in err_str or "refused" in err_str or "connect" in err_str:
                print(
                    f"\n[X]  Cannot connect to Ollama at {OLLAMA_HOST}.\n"
                    "    Please start Ollama first:\n"
                    "        ollama serve\n"
                    "    Or set OLLAMA_HOST in your .env file.\n"
                )
                sys.exit(1)
            # Non-connection error (e.g. API version mismatch) — warn but continue
            print(f"  [WARN] Ollama connectivity check warning: {e}")
    else:
        print("Using statistical neighbor sampling (no Ollama). Pass --use-llm for legacy.")

    # ── Resume / checkpoint logic ──
    rated_list: list[dict] = []
    completed_names: set[str] = set()

    if args.resume and os.path.exists(CHECKPOINT_FILE):
        rated_list = load_checkpoint()
        completed_names = {p["name"] for p in rated_list}
        print(f"  ↳ Resuming from checkpoint: {len(rated_list)} prospects already rated.")

    remaining = [p for p in prospects if p.get("name", "") not in completed_names]

    # ── Selective-regeneration filters (--only / --positions) ──────────────
    # When either filter is set, preserve prior rated entries for everyone
    # NOT in the filter, and only re-rate the matching subset.
    preserved_records: list[dict] = []
    filter_active = bool(args.only or args.positions)
    if filter_active:
        only_tokens = [norm_name(x) for x in (args.only or "").split(",") if x.strip()]
        pos_tokens  = [p.strip().upper()  for p in (args.positions or "").split(",") if p.strip()]

        def _matches(p: dict) -> bool:
            if pos_tokens and (p.get("pos") or "").upper() in pos_tokens:
                return True
            if only_tokens:
                nm = norm_name(p.get("name") or f"{p.get('firstName','')} {p.get('lastName','')}")
                last = norm_name(p.get("lastName",""))
                for tok in only_tokens:
                    if not tok:
                        continue
                    if tok == nm or tok == last or tok in nm or nm in tok:
                        return True
            return False

        matched = [p for p in remaining if _matches(p)]
        matched_keys = {
            norm_name(p.get("name") or f"{p.get('firstName','')} {p.get('lastName','')}")
            for p in matched
        }

        # Preserve every prior-rated prospect NOT in the matched set
        if os.path.exists(OUTPUT_FILE):
            try:
                with open(OUTPUT_FILE, "r", encoding="utf-8") as f:
                    prior_rated = json.load(f)
                for p in prior_rated:
                    k = norm_name(p.get("name") or f"{p.get('firstName','')} {p.get('lastName','')}")
                    if k not in matched_keys:
                        preserved_records.append(p)
                print(f"  Selective mode: preserving {len(preserved_records)} prior-rated records.")
            except Exception as e:
                print(f"  WARN: could not preload prior ratings for preservation: {e}")

        remaining = matched
        print(f"  Filter matched {len(remaining)} prospect(s) "
              f"(only={args.only!r}, positions={args.positions!r})")

    if args.max_prospects and args.max_prospects < len(remaining):
        remaining = remaining[:args.max_prospects]
    print(f"\nGenerating ratings for {len(remaining)} prospect(s) using model '{model}' ...")
    print(f"  Ollama host: {OLLAMA_HOST}\n")

    # ── Process each prospect ──
    with tqdm(total=len(remaining), desc="Generating ratings", unit="prospect") as pbar:
        for prospect in remaining:
            name = prospect.get("name", "Unknown")
            pbar.set_postfix_str(name[:35])

            try:
                ratings = rate_prospect(
                    prospect=prospect,
                    model=model,
                    calibration=calibration,
                    current_ratings=current_ratings,
                    reference_class=reference_class,
                    ovr_formulas=ovr_formulas,
                    profiles=profiles,
                    prior_ovrs=prior_ovrs,
                    verbose=args.verbose,
                    use_llm=use_llm,
                )
            except ConnectionError as ce:
                print(f"\n[X]  {ce}")
                print("Saving progress to checkpoint before exit ...")
                save_checkpoint(rated_list)
                sys.exit(1)
            except Exception as exc:
                print(f"\n  [ERR] Unexpected error for {name}: {exc} — using defaults")
                ratings = get_defaults(canonical_pos(prospect.get("pos", "QB")))

            # Build output record (all original fields + inferred draftPick + ratings)
            rank = prospect.get("rank") or 0
            output_record = {
                **{k: v for k, v in prospect.items() if k != "name"},  # keep structured fields
                "draftPick": rank,  # rank → pick number
                "ratings": ratings,
            }
            # Ensure firstName/lastName/name consistency
            if "name" in prospect:
                # Keep name for internal use; schema uses firstName/lastName
                pass

            rated_list.append(output_record)
            save_checkpoint(rated_list)
            pbar.update(1)

    # ── Merge preserved (non-filtered) records back in ──
    if filter_active and preserved_records:
        rated_list = preserved_records + rated_list
        print(f"  Merged {len(preserved_records)} preserved records with "
              f"{len(rated_list) - len(preserved_records)} newly-rated = {len(rated_list)} total.")

    # ── Write final output ──
    print(f"\nSaving {len(rated_list)} rated prospects to {OUTPUT_FILE} ...")
    with open(OUTPUT_FILE, "w", encoding="utf-8") as f:
        json.dump(rated_list, f, indent=2)

    # Remove checkpoint on successful completion
    if os.path.exists(CHECKPOINT_FILE):
        os.remove(CHECKPOINT_FILE)
        print("  Checkpoint removed (run complete).")

    print(f"\n[OK]  Done! {OUTPUT_FILE} written with {len(rated_list)} records.")


if __name__ == "__main__":
    main()

