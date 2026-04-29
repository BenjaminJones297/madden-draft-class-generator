"""
Statistical baseline rating generator: nearest-neighbor sampling from the
M26 2025 calibration set.

For each prospect we build a candidate pool of 2025 rookies at the same
position (with positional fallbacks for sparse pools), score each candidate
by similarity (draft pick + measurables), keep the top-k, and produce a
similarity-weighted centroid.  The centroid becomes the starting attribute
vector for that prospect.  Light deterministic jitter on non-key fields
preserves variance across the class.

Replaces the LLM (Ollama llama3:8b) raw-rating call in script 5.  All
existing post-processing (apply_position_corrections, apply_combine_corrections,
apply_profile_corrections, apply_dev_trait_by_pick, compute_ovr) still runs
on top of this baseline unchanged.
"""

import random
import re
from typing import Iterable, Sequence

# ── Position fallback chains ─────────────────────────────────────────────────
# Mirrors POSITION_FALLBACKS in scripts/5_generate_ratings.py.  Some
# calibration position groups are mis-labelled (the "CB" group reportedly
# contains DTs, "DE" contains OL) — these chains route around that.
POSITION_FALLBACKS: dict[str, list[str]] = {
    "QB":  [],
    "HB":  ["RB"],
    "FB":  ["HB"],
    "WR":  [],
    "TE":  [],
    "T":   ["G", "C"],
    "G":   ["C", "T"],
    "C":   ["G"],
    "DE":  ["OLB", "DT"],
    "DT":  ["DE"],
    "OLB": ["MLB", "DE"],
    "MLB": ["OLB", "ILB"],
    "ILB": ["MLB", "OLB"],
    "CB":  ["FS", "SS"],
    "FS":  ["SS", "CB"],
    "SS":  ["FS"],
    "K":   ["P"],
    "P":   ["K"],
    "LS":  ["C"],
}

# k-NN k by pool size — small pools shouldn't average over too many, large
# pools benefit from a bigger sample.
K_BY_POOL = (
    (8,  3),    # pool < 8 -> k=3
    (16, 5),    # pool < 16 -> k=5
    (10**9, 8), # otherwise -> k=8
)

# Maximum synthetic pick number.  Undrafted prospects (rank 258..422) collapse
# to UDFA tier (last 30 picks of R7) rather than producing wildly out-of-range
# pick numbers that break pick-distance similarity.
SYNTHETIC_PICK_CAP = 257
UDFA_PICK_OFFSET   = 150   # rank + offset, then capped


def parse_height_inches(ht) -> int:
    """'6-2' -> 74, 74 -> 74, None -> 72."""
    if isinstance(ht, (int, float)):
        return int(ht)
    if not ht:
        return 72
    m = re.match(r"^(\d+)[-'](\d+)", str(ht))
    if m:
        return int(m.group(1)) * 12 + int(m.group(2))
    try:
        return int(ht)
    except (TypeError, ValueError):
        return 72


def synthetic_pick_for(prospect: dict) -> int:
    """Return a 1..257 pick number even for undrafted prospects."""
    pk = prospect.get("actual_draft_pick")
    if pk:
        return int(pk)
    rank = prospect.get("rank") or 200
    return min(SYNTHETIC_PICK_CAP, int(rank) + UDFA_PICK_OFFSET)


def _candidate_overall_pick(entry: dict) -> int:
    """Compute the overall pick number from a calibration entry's profile.
    Calibration stores draft_pick as WITHIN-round (1..32+ for comp picks)."""
    prof = entry.get("profile", {})
    rnd = prof.get("draft_round") or 0
    pk  = prof.get("draft_pick")  or 0
    if not rnd or not pk:
        return 9999    # unknown -> treat as low-tier UDFA
    return (int(rnd) - 1) * 32 + int(pk)


def build_candidate_pool(
    pos: str,
    calibration: dict,
    *,
    min_pool: int = 8,
) -> list[dict]:
    """
    Build a candidate pool for `pos`.  Each entry is the raw calibration dict
    with an added `_overall_pick` integer field for distance computation.
    """
    pool: list[dict] = []
    seen_names: set[str] = set()

    def extend(group_pos: str) -> None:
        for entry in calibration.get(group_pos, []):
            name = (entry.get("profile") or {}).get("name", "")
            if name in seen_names:
                continue
            seen_names.add(name)
            decorated = dict(entry)
            decorated["_overall_pick"] = _candidate_overall_pick(entry)
            pool.append(decorated)

    extend(pos)
    if len(pool) < min_pool:
        for fb in POSITION_FALLBACKS.get(pos, []):
            extend(fb)
            if len(pool) >= min_pool:
                break
    return pool


def _safe_float(x):
    try:
        if x is None:
            return None
        return float(x)
    except (TypeError, ValueError):
        return None


def score_candidate(prospect: dict, candidate: dict) -> float:
    """
    Similarity in [0, 1].  Weights:
      pick      35%   (draft tier)
      weight    25%   (frame / archetype)
      forty     25%   (athleticism)
      height    15%   (frame)

    Missing measurables on either side -> 0.5 neutral for that signal.
    """
    p_pick = synthetic_pick_for(prospect)
    c_pick = candidate.get("_overall_pick", 9999)
    pick_sim = 1.0 - min(1.0, abs(p_pick - c_pick) / 64.0)

    p_wt = _safe_float(prospect.get("wt"))
    c_wt = _safe_float((candidate.get("profile") or {}).get("wt"))
    if p_wt and c_wt:
        wt_sim = 1.0 - min(1.0, abs(p_wt - c_wt) / 30.0)
    else:
        wt_sim = 0.5

    p_forty = _safe_float(prospect.get("forty"))
    c_forty = _safe_float((candidate.get("profile") or {}).get("forty"))
    if p_forty and c_forty:
        forty_sim = 1.0 - min(1.0, abs(p_forty - c_forty) * 5.0)
    else:
        forty_sim = 0.5

    p_ht = parse_height_inches(prospect.get("ht"))
    c_ht = parse_height_inches((candidate.get("profile") or {}).get("ht"))
    if p_ht and c_ht:
        ht_sim = 1.0 - min(1.0, abs(p_ht - c_ht) / 6.0)
    else:
        ht_sim = 0.5

    return (
        0.35 * pick_sim +
        0.25 * wt_sim +
        0.25 * forty_sim +
        0.15 * ht_sim
    )


def select_neighbors(
    prospect: dict,
    pool: list[dict],
) -> list[tuple[dict, float]]:
    """Top-k candidates with weights summing to 1.0."""
    if not pool:
        return []
    k = next(k for thresh, k in K_BY_POOL if len(pool) < thresh)
    scored = [(c, score_candidate(prospect, c)) for c in pool]
    scored.sort(key=lambda t: t[1], reverse=True)
    top = scored[:k]
    total = sum(w for _, w in top)
    if total <= 0:
        # Defensive: equal weights if all candidates score 0
        return [(c, 1.0 / len(top)) for c, _ in top]
    return [(c, w / total) for c, w in top]


def compute_position_stats(calibration: dict) -> dict:
    """
    Per-(pos, attribute) mean + standard deviation across calibration entries.

    Used by centroid_attributes() to apply variance-weighted blending: for
    low-SD attributes (where everyone at the position clusters tightly), the
    similarity-weighted neighbor centroid passes through unchanged. For
    high-SD attributes (where individual prospects differ widely), the
    centroid is partially regressed toward the position mean — leaving more
    room for individual signals (profile keyword bumps, combine measurements)
    to drive the final value.

    Returns: {pos: {field: (mean, sd)}}
    """
    import statistics as _st
    out: dict = {}
    for pos, entries in calibration.items():
        stats: dict = {}
        # Collect all values per field
        per_field: dict[str, list[float]] = {}
        for e in entries:
            r = e.get("ratings") or {}
            for f, v in r.items():
                if isinstance(v, (int, float)):
                    per_field.setdefault(f, []).append(float(v))
        for f, vals in per_field.items():
            if len(vals) < 2:
                stats[f] = (vals[0] if vals else 60.0, 0.0)
            else:
                stats[f] = (_st.mean(vals), _st.pstdev(vals))
        out[pos] = stats
    return out


# SD threshold below which the centroid passes through unchanged. Above this,
# centroid is partially regressed toward the position mean. Calibration SDs
# typically range 1-15; 4 is roughly the median across (pos, field) pairs.
SD_LOW_THRESHOLD = 4.0
# Maximum regression strength: at very high SD, centroid is still 50% of final
# (50% mean) so individual differentiation isn't lost entirely.
MAX_REGRESS = 0.5


def centroid_attributes(
    neighbors: Sequence[tuple[dict, float]],
    rating_fields: Iterable[str],
    position_stats: dict | None = None,
    pos: str | None = None,
) -> dict:
    """Weighted mean per attribute, with optional variance-weighted regression
    toward position mean for high-SD attributes.

    devTrait clamped [0, 3]; everything else clamped [40, 99].
    """
    pos_attr_stats = (position_stats or {}).get(pos, {}) if pos else {}

    out: dict = {}
    for field in rating_fields:
        acc = 0.0
        wsum = 0.0
        for cand, w in neighbors:
            v = (cand.get("ratings") or {}).get(field)
            if v is None:
                continue
            try:
                acc += float(v) * w
                wsum += w
            except (TypeError, ValueError):
                continue
        if wsum <= 0:
            continue   # skip fields nobody has
        avg = acc / wsum

        # Variance-weighted regression: high-SD attributes get pulled toward
        # the position mean so individual signals (profile/combine) have room
        # to differentiate.
        if pos_attr_stats and field not in ("overall", "devTrait"):
            stat = pos_attr_stats.get(field)
            if stat:
                pos_mean, pos_sd = stat
                if pos_sd > SD_LOW_THRESHOLD and pos_mean > 0:
                    # regress strength scales 0..MAX_REGRESS as sd scales
                    # SD_LOW_THRESHOLD..(2*SD_LOW_THRESHOLD)
                    excess = min(1.0, (pos_sd - SD_LOW_THRESHOLD) / SD_LOW_THRESHOLD)
                    regress = MAX_REGRESS * excess
                    avg = avg * (1.0 - regress) + pos_mean * regress

        if field == "devTrait":
            out[field] = max(0, min(3, int(round(avg))))
        else:
            out[field] = max(40, min(99, int(round(avg))))
    return out


def _name_seed(prospect_name: str) -> int:
    # Stable across Python versions: sum of character codes mod 2^32
    return sum(ord(c) for c in (prospect_name or "")) & 0xFFFFFFFF


def jitter_attributes(
    ratings: dict,
    prospect_name: str,
    key_fields: set[str] | None = None,
    non_key_jitter: int = 2,
    key_jitter: int = 0,
) -> dict:
    """
    Deterministic per-field nudge (±non_key_jitter for non-key fields, ±key_jitter
    for key fields).  Skips 'overall' and 'devTrait' regardless of key set.
    Values are clamped [40, 99].
    """
    rng = random.Random(_name_seed(prospect_name))
    key_fields = key_fields or set()
    out = dict(ratings)
    for field, val in ratings.items():
        if field in ("overall", "devTrait"):
            continue
        if not isinstance(val, (int, float)):
            continue
        amp = key_jitter if field in key_fields else non_key_jitter
        if amp <= 0:
            continue
        delta = rng.randint(-amp, amp)
        new = int(val) + delta
        out[field] = max(40, min(99, new))
    return out


_POS_STATS_CACHE: dict | None = None


def sample_baseline_ratings(
    prospect: dict,
    calibration: dict,
    rating_fields: Iterable[str],
    *,
    key_fields: set[str] | None = None,
) -> dict:
    """
    Top-level entry: take a prospect dict, return a starting `ratings` dict.

    The returned dict feeds straight into the existing post-processing chain
    (apply_position_corrections / apply_profile_corrections / apply_combine_corrections
    / apply_dev_trait_by_pick / compute_ovr).
    """
    global _POS_STATS_CACHE
    if _POS_STATS_CACHE is None:
        _POS_STATS_CACHE = compute_position_stats(calibration)

    pos = prospect.get("pos") or "QB"
    pool = build_candidate_pool(pos, calibration)
    if not pool:
        # No calibration data at all — return an empty dict; downstream defaults
        # will fill from get_defaults().
        return {}
    neighbors = select_neighbors(prospect, pool)
    # Use the prospect's actual position for variance lookup so the regression
    # uses the true distribution (not the fallback pool's).
    ratings = centroid_attributes(
        neighbors, rating_fields,
        position_stats=_POS_STATS_CACHE,
        pos=pos,
    )
    name = prospect.get("name") or f"{prospect.get('firstName','')} {prospect.get('lastName','')}".strip()
    ratings = jitter_attributes(ratings, name, key_fields=key_fields)
    return ratings
