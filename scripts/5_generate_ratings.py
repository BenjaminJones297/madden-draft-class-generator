"""
Script 5: Generate Madden 26 ratings for 2026 NFL Draft prospects.

For each prospect, builds a calibrated prompt using 2025 calibration examples + optional current
player benchmarks, then calls an LLM to generate all Madden 26 rating fields, validates the
output, and saves data/prospects_rated.json.

Supported LLM providers (set via --provider or LLM_PROVIDER in .env):
  ollama           — Direct Ollama call (default, no extra deps)
  ollama-langchain — Ollama via LangChain (requires langchain-ollama)
  openai           — OpenAI API via LangChain (requires langchain-openai + OPENAI_API_KEY)
  multi-chain      — 3-chain decomposition strategy via LangChain (best quality)
                     Breaks the problem into focused sub-tasks:
                       Chain 1 (Athleticism LLM): combine measurables → physical ratings
                       Chain 2 (Skills LLM):      position context → skill ratings   [parallel]
                       Chain 3 (Skills LLM):      merged context → overall + devTrait [sequential]

Usage:
    python scripts/5_generate_ratings.py [--model llama3:8b] [--resume]
    python scripts/5_generate_ratings.py --provider openai [--model gpt-4o-mini]
    python scripts/5_generate_ratings.py --provider ollama-langchain
    python scripts/5_generate_ratings.py --provider multi-chain --athleticism-model llama3:8b --model llama3:70b
"""

import argparse
import json
import os
import re
import sys

from dotenv import load_dotenv
from tqdm import tqdm

# ── Path setup ──────────────────────────────────────────────────────────────
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(SCRIPT_DIR)

sys.path.insert(0, PROJECT_ROOT)

from utils.enums import ALL_RATING_FIELDS, POSITION_KEY_FIELDS, POSITION_TO_ENUM
from utils.defaults import get_defaults

# Physical/athletic fields resolved by the athleticism chain in multi-chain mode.
# These map almost directly from combine measurables and are independent of football IQ.
ATHLETICISM_FIELDS = [
    "speed", "acceleration", "agility", "jumping",
    "strength", "stamina", "toughness", "injury",
]

# ── Load .env ────────────────────────────────────────────────────────────────
load_dotenv(os.path.join(PROJECT_ROOT, ".env"))

OLLAMA_HOST = os.getenv("OLLAMA_HOST", "http://localhost:11434")
DEFAULT_MODEL = os.getenv("OLLAMA_MODEL", "llama3:8b")
DEFAULT_PROVIDER = os.getenv("LLM_PROVIDER", "ollama")
OPENAI_MODEL = os.getenv("OPENAI_MODEL", "gpt-4o-mini")
# For multi-chain: optionally use a smaller/faster model for the athleticism chain
ATHLETICISM_MODEL = os.getenv("ATHLETICISM_MODEL", "")  # falls back to DEFAULT_MODEL when empty

# Set OLLAMA_HOST so the ollama package picks it up
os.environ["OLLAMA_HOST"] = OLLAMA_HOST

# ── File paths ────────────────────────────────────────────────────────────────
DATA_DIR = os.path.join(PROJECT_ROOT, "data")
PROSPECTS_FILE = os.path.join(DATA_DIR, "prospects_2026.json")
CALIBRATION_FILE = os.path.join(DATA_DIR, "calibration_set.json")
CURRENT_RATINGS_FILE = os.path.join(DATA_DIR, "current_player_ratings.json")
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


def build_prompt(prospect: dict, calibration_examples: list, current_anchors: list) -> str:
    pos = prospect["pos"]
    canon = canonical_pos(pos)
    key_fields = POSITION_KEY_FIELDS.get(canon, POSITION_KEY_FIELDS["QB"])
    all_fields_str = ", ".join(ALL_RATING_FIELDS)

    lines = []

    # ── Header ──
    lines.append("You are a Madden NFL 26 ratings expert calibrating a 2026 NFL Draft class.")
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
        lines.append("")
    elif pos in ("DE", "OLB") and pos not in ("T", "G", "C"):
        lines.append(f"IMPORTANT for {pos} (edge/pass rusher):")
        lines.append("- blockShedding, powerMoves, finesseMoves are KEY pass-rush stats — these should be HIGH (65-85)")
        lines.append("- passBlock, runBlock, impactBlocking should be LOW (15-30) — those are offensive stats")
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


# ── Multi-chain prompt builders ───────────────────────────────────────────────
# These three focused prompts replace the single monolithic prompt when the
# 'multi-chain' provider is used. Each LLM call has a narrow responsibility:
#   Chain 1 — physical/athletic ratings from combine measurables
#   Chain 2 — position-specific skill ratings from football context
#   Chain 3 — overall OVR + devTrait from draft capital + merged ratings

def build_athleticism_prompt(prospect: dict) -> str:
    """
    Chain 1 prompt: translate combine measurables into athletic ratings.

    Intended for a fast/cheap model — the mapping from 40-time, bench press,
    vertical etc. to Madden ratings is nearly deterministic and does not
    require any football domain knowledge or calibration examples.

    Output fields: speed, acceleration, agility, jumping, strength,
                   stamina, toughness, injury
    """
    pos = prospect["pos"]
    wt = _fmt_val(prospect.get("wt"), "N/A")
    ht = prospect.get("ht", "N/A")
    forty = _fmt_val(prospect.get("forty"), "N/A")
    bench = _fmt_val(prospect.get("bench"), "N/A")
    vertical = _fmt_val(prospect.get("vertical"), "N/A")
    broad = _fmt_val(prospect.get("broadJump"), "N/A")
    cone = _fmt_val(prospect.get("cone"), "N/A")
    shuttle = _fmt_val(prospect.get("shuttle"), "N/A")

    fields_str = ", ".join(ATHLETICISM_FIELDS)
    return f"""You are a Madden NFL 26 ratings expert converting NFL Combine measurables to in-game athletic ratings.

PROSPECT:
Position: {pos} | {ht}, {wt} lbs
40-yard dash: {forty}s | Bench press reps: {bench} | Vertical: {vertical} in
Broad jump: {broad} in | 3-cone: {cone}s | Shuttle: {shuttle}s

CONVERSION GUIDE (apply to the position norms below):
- speed: 40-yard dash is the primary driver
    4.30s→96, 4.34→94, 4.37→93, 4.40→92, 4.44→91, 4.46→90, 4.48→90,
    4.51→89, 4.59→86, 4.61→85, 4.65→83, 4.70→80, 4.75→77, 4.80→74
  Adjust ±2 for position norms (OL/DT skew lower, WR/CB skew higher).
- acceleration: correlates with 10-yard split; typically within 2 pts of speed.
- agility: 3-cone and shuttle primary (lower time = higher rating).
    3-cone 6.50s→90, 6.70→86, 6.90→82, 7.10→77, 7.30→72, 7.50→65
- jumping: vertical jump primary.
    40in→96, 38in→92, 36in→87, 34in→82, 32in→77, 30in→72, 28in→66, 26in→60
- strength: bench press reps (225 lbs) primary.
    30+reps→82, 25→76, 20→70, 15→62, 10→55, N/A→55 (use wt as secondary signal)
- stamina: 70–88 range; higher for skill positions and lighter players.
- toughness: 62–82 range; higher for bigger/heavier players.
- injury: 70–88 range (lower = more durable in Madden; heavier players often higher).

Return ONLY a valid JSON object with these exact keys, no extra text:
{fields_str}"""


def build_skills_prompt(
    prospect: dict,
    athleticism: dict,
    calibration_examples: list,
    current_anchors: list,
) -> str:
    """
    Chain 2 prompt: generate position-specific skill ratings.

    Athletic attributes (speed, strength, etc.) are already resolved by
    Chain 1 and shown as context. This prompt focuses exclusively on
    football-skill ratings (route running, coverage, pass rush, etc.)
    and uses calibration examples + NFL comp for grounding.

    Output fields: position key fields excluding ATHLETICISM_FIELDS
                   and excluding overall/devTrait (handled by Chain 3).
    """
    pos = prospect["pos"]
    canon = canonical_pos(pos)
    key_fields = POSITION_KEY_FIELDS.get(canon, POSITION_KEY_FIELDS["QB"])

    # Skill target = position key fields minus what's already resolved
    exclude = set(ATHLETICISM_FIELDS) | {"overall", "devTrait"}
    skill_fields = [f for f in key_fields if f not in exclude]
    # Fall back to all key fields if nothing is left (e.g. K/P positions)
    if not skill_fields:
        skill_fields = [f for f in key_fields if f not in {"devTrait"}]
    skill_fields_str = ", ".join(skill_fields)

    name = prospect.get("name", f"{prospect.get('firstName','')} {prospect.get('lastName','')}".strip())
    forty = _fmt_val(prospect.get("forty"), "N/A")
    wt = _fmt_val(prospect.get("wt"), "N/A")
    rank = _fmt_val(prospect.get("rank"), "N/A")
    grade = prospect.get("grade", "N/A")
    draft_round = _fmt_val(prospect.get("draftRound"), "?")
    notes = (prospect.get("notes") or "").strip()

    lines = []
    lines.append(
        f"You are a Madden NFL 26 ratings expert. Generate ONLY the position-specific SKILL "
        f"ratings for this {pos} prospect."
    )
    lines.append(
        "Physical/athletic ratings are already resolved — focus only on football skills."
    )
    lines.append("")

    # Athletic context already resolved by Chain 1
    if athleticism:
        athl_str = ", ".join(f"{k}={v}" for k, v in sorted(athleticism.items()))
        lines.append(f"RESOLVED ATHLETICISM: {athl_str}")
        lines.append("")

    if calibration_examples:
        lines.append(f"CALIBRATION — 2025 {pos} rookies with actual Madden 26 launch ratings:")
        for ex in calibration_examples:
            prof = ex.get("profile", {})
            rats = ex.get("ratings", {})
            n = prof.get("name", "Unknown")
            dr = _fmt_val(prof.get("draft_round"), "?")
            dp = _fmt_val(prof.get("draft_pick"), "?")
            key_str = _key_ratings_str(rats, pos)
            lines.append(f"• {n} | Round {dr}, Pick {dp} | {key_str}")
        lines.append("")

    if current_anchors:
        lines.append(f"CURRENT NFL {pos} ANCHORS (for scale reference):")
        for player in current_anchors:
            n = player.get("name", "?")
            rats = player.get("ratings", {})
            ovr = rats.get("overall", "?")
            key_str = _key_ratings_str(rats, pos)
            lines.append(f"• {n} | OVR {ovr} | {key_str}")
        lines.append("")

    lines.append(
        f"PROSPECT: {name} | {pos} | 40yd: {forty} | {wt} lbs | "
        f"Rank: #{rank} | Grade: {grade} | Draft round: {draft_round}"
    )
    nfl_comp = prospect.get("nfl_comp", "")
    if nfl_comp:
        lines.append(
            f"NFL Comparison: {nfl_comp} — use this player's SKILL PROFILE "
            "(not exact values) to inform the attribute distribution."
        )
    if notes:
        lines.append(f"Notes: {notes}")
    lines.append("")
    lines.append("Rules:")
    lines.append("- All values: integers 0–99")
    lines.append("- Ratings should reflect a ROOKIE — do not inflate")
    lines.append("")
    lines.append(f"Return ONLY a valid JSON object with these exact keys, no extra text:")
    lines.append(skill_fields_str)

    return "\n".join(lines)


def build_dev_trait_prompt(prospect: dict, athleticism: dict, skills: dict) -> str:
    """
    Chain 3 prompt: set overall OVR and devTrait from draft capital + merged ratings.

    This is a tiny, highly-focused prompt. Chains 1 and 2 have already resolved
    all individual attributes; this chain just needs to decide how good the player
    is as a whole and what their development trajectory looks like.

    Output fields: overall, devTrait
    """
    pos = prospect["pos"]
    canon = canonical_pos(pos)
    rank = _fmt_val(prospect.get("rank"), "N/A")
    grade = prospect.get("grade", "N/A")
    draft_round = _fmt_val(prospect.get("draftRound"), "?")
    nfl_comp = prospect.get("nfl_comp", "")

    key_fields = POSITION_KEY_FIELDS.get(canon, POSITION_KEY_FIELDS["QB"])
    combined = {**athleticism, **skills}
    key_summary = ", ".join(
        f"{k}={combined[k]}"
        for k in key_fields
        if k in combined and k not in ("devTrait", "overall")
    )

    lines = []
    lines.append(
        "You are a Madden NFL 26 ratings expert. "
        "Set ONLY the overall rating and development trait for this prospect."
    )
    lines.append("")
    lines.append(
        f"PROSPECT: {pos} | Board rank: #{rank} | Grade: {grade} | Draft round: {draft_round}"
    )
    if nfl_comp:
        lines.append(f"NFL Comparison: {nfl_comp}")
    lines.append(f"Key ratings already set: {key_summary}")
    lines.append("")
    lines.append("RULES:")
    lines.append(
        "- overall: weighted average of key position ratings (0–99); "
        "typical rookie ranges: Round 1→72–82, Round 2→68–75, Round 3-4→65–72, Round 5-7→60–68"
    )
    lines.append(
        "- devTrait: 0=Normal, 1=Impact, 2=Star, 3=XFactor. "
        "Round 1 top picks→Impact/Star. Top 5 generational talents→Star/XFactor. "
        "Round 2-3→Normal/Impact. Round 4-7→Normal."
    )
    lines.append("")
    lines.append('Return ONLY a valid JSON object with exactly these two keys:')
    lines.append('overall, devTrait')

    return "\n".join(lines)


# ── Multi-chain rating function ───────────────────────────────────────────────

def rate_prospect_multi_chain(
    prospect: dict,
    skills_llm,
    athleticism_llm,
    calibration: dict,
    current_ratings: dict,
    verbose: bool = False,
) -> dict:
    """
    Rate a prospect using a 3-chain decomposition strategy via LangChain LCEL.

    The problem is split into three focused, sequential sub-tasks.  Each chain
    receives the output of the previous chain as context, so later chains can
    build on earlier results.

    Architecture::

        prospect context
              │
              ▼
        Chain 1 (athleticism_llm) — fast model
          combine measurables → speed, accel, agility, jumping, strength, stamina, toughness, injury
              │ athleticism ratings
              ▼
        Chain 2 (skills_llm) — main model
          position context + calibration + NFL comp + Chain 1 athleticism → skill ratings
              │ skill ratings
              ▼
        Chain 3 (skills_llm) — main model
          draft capital + merged Chain 1+2 ratings → overall + devTrait

    ``athleticism_llm`` may be a smaller/cheaper model (e.g. ``llama3:8b``)
    while ``skills_llm`` uses a more capable model (e.g. ``llama3:70b`` or
    ``gpt-4o-mini``).

    Each step uses LangChain's LCEL chain pattern::

        prompt_template | llm | StrOutputParser() | parse_fn

    This keeps each LLM call modular and easily swappable.  If two chains
    have no data dependency (e.g. rating different prospects simultaneously),
    they can be wrapped in ``RunnableParallel`` for concurrent execution::

        from langchain_core.runnables import RunnableParallel
        parallel = RunnableParallel(prospect_a=chain, prospect_b=chain)
    """
    from langchain_core.prompts import ChatPromptTemplate
    from langchain_core.output_parsers import StrOutputParser
    from langchain_core.runnables import RunnableLambda

    pos = prospect["pos"]
    canon = canonical_pos(pos)
    defaults = get_defaults(canon)

    cal_examples = get_calibration_examples(pos, prospect, calibration)
    anchors = get_current_anchors(pos, current_ratings)

    # Shared prompt template (single human turn; same for all chains)
    prompt_tmpl = ChatPromptTemplate.from_messages([("human", "{input}")])

    def _parse(text: str) -> dict:
        return extract_json(text) or {}

    # ── Define the three LCEL chains ─────────────────────────────────────────

    # Chain 1: combine measurables → athletic ratings (fast model)
    athleticism_chain = (
        RunnableLambda(lambda ctx: {"input": build_athleticism_prompt(ctx["prospect"])})
        | prompt_tmpl
        | athleticism_llm
        | StrOutputParser()
        | RunnableLambda(_parse)
    )

    # Chain 2: calibration context + NFL comp + Chain 1 output → position skill ratings (main model)
    # Receives athleticism ratings from Chain 1 via ctx["athleticism"]
    skills_chain = (
        RunnableLambda(lambda ctx: {"input": build_skills_prompt(
            ctx["prospect"], ctx["athleticism"], ctx["cal_examples"], ctx["anchors"]
        )})
        | prompt_tmpl
        | skills_llm
        | StrOutputParser()
        | RunnableLambda(_parse)
    )

    # Chain 3: merged Chain 1+2 context → overall OVR + devTrait (sequential after chains 1+2)
    dev_trait_chain = (
        RunnableLambda(lambda ctx: {"input": build_dev_trait_prompt(
            ctx["prospect"], ctx["athleticism"], ctx["skills"]
        )})
        | prompt_tmpl
        | skills_llm
        | StrOutputParser()
        | RunnableLambda(_parse)
    )

    # ── Execute chains sequentially: each step passes its output to the next ──
    try:
        # Step 1: resolve physical/athletic ratings
        athleticism_raw: dict = athleticism_chain.invoke({"prospect": prospect})

        # Step 2: resolve position-specific skill ratings (informed by Step 1)
        skills_raw: dict = skills_chain.invoke({
            "prospect": prospect,
            "athleticism": athleticism_raw,
            "cal_examples": cal_examples,
            "anchors": anchors,
        })

        # Step 3: resolve overall OVR + devTrait (informed by Steps 1 and 2)
        dev_raw: dict = dev_trait_chain.invoke({
            "prospect": prospect,
            "athleticism": athleticism_raw,
            "skills": skills_raw,
        })
    except Exception as exc:
        if "connect" in str(exc).lower() or "refused" in str(exc).lower():
            raise ConnectionError(str(exc)) from exc
        raise

    if verbose:
        print(
            f"  ↳ Athleticism: {sorted(athleticism_raw)}, "
            f"Skills: {sorted(skills_raw)}, "
            f"Dev: overall={dev_raw.get('overall')}, devTrait={dev_raw.get('devTrait')}"
        )

    # ── Merge: defaults → athleticism → skills → dev ─────────────────────────
    merged: dict = dict(defaults)
    merged.update({k: v for k, v in athleticism_raw.items() if k in ATHLETICISM_FIELDS})
    merged.update({k: v for k, v in skills_raw.items() if k in ALL_RATING_FIELDS})
    if "overall" in dev_raw:
        merged["overall"] = dev_raw["overall"]
    if "devTrait" in dev_raw:
        merged["devTrait"] = dev_raw["devTrait"]

    # ── Validate and apply rule-based corrections ─────────────────────────────
    cleaned, issues = validate_ratings(merged, canon)
    if verbose and issues:
        print(
            f"  ↳ Fixed {len(issues)} field(s): {', '.join(issues[:5])}"
            + (" ..." if len(issues) > 5 else "")
        )
    cleaned = apply_position_corrections(cleaned, pos, prospect.get("forty"))

    return cleaned


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
            # Clamp 0-99
            val = max(0, min(99, val))

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


# ── LangChain helpers ─────────────────────────────────────────────────────────

def build_langchain_llm(provider: str, model: str):
    """
    Build and return a LangChain chat model for *provider*.

    Supported providers:
      - ``ollama-langchain``: ChatOllama (requires langchain-ollama)
      - ``openai``:           ChatOpenAI (requires langchain-openai + OPENAI_API_KEY)

    The returned object exposes a ``.invoke(messages)`` method compatible with
    LangChain's LCEL (LangChain Expression Language) chain syntax.
    """
    if provider == "ollama-langchain":
        try:
            from langchain_ollama import ChatOllama
        except ImportError as exc:
            raise ImportError(
                "langchain-ollama is required for the 'ollama-langchain' provider.\n"
                "  Install it with:  pip install langchain-ollama"
            ) from exc
        return ChatOllama(
            model=model,
            base_url=OLLAMA_HOST,
            temperature=0.2,
            num_predict=1024,
        )

    if provider == "openai":
        try:
            from langchain_openai import ChatOpenAI
        except ImportError as exc:
            raise ImportError(
                "langchain-openai is required for the 'openai' provider.\n"
                "  Install it with:  pip install langchain-openai"
            ) from exc
        api_key = os.getenv("OPENAI_API_KEY")
        if not api_key:
            raise ValueError(
                "OPENAI_API_KEY is not set.\n"
                "  Add it to your .env file or set it as an environment variable."
            )
        return ChatOpenAI(
            model=model,
            temperature=0.2,
            max_tokens=1024,
            api_key=api_key,
        )

    raise ValueError(
        f"Unknown LangChain provider: {provider!r}. "
        "Valid options: 'ollama-langchain', 'openai'."
    )


def call_llm_langchain(llm, prompt: str) -> str:
    """
    Invoke a LangChain chat model with *prompt* and return the response text.

    Uses LangChain's LCEL (LangChain Expression Language) chain:
        ChatPromptTemplate | llm | StrOutputParser
    This makes it trivial to swap LLM providers without changing calling code.
    """
    from langchain_core.prompts import ChatPromptTemplate
    from langchain_core.output_parsers import StrOutputParser

    chat_prompt = ChatPromptTemplate.from_messages([("human", "{input}")])
    chain = chat_prompt | llm | StrOutputParser()
    return chain.invoke({"input": prompt})


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

    if pos in OL_DL_CAPS:
        caps = OL_DL_CAPS[pos]
        for stat, cap in caps.items():
            if r.get(stat, 0) > cap:
                r[stat] = cap
        floor = OL_ACC_FLOOR.get(pos, 68)
        if r.get("acceleration", 0) < floor:
            r["acceleration"] = floor

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

    # Safety coverage floor: if coverage stats look like defaults, bump them
    if pos in ("FS", "SS"):
        if r.get("zoneCoverage", 0) < 60:
            r["zoneCoverage"] = max(r.get("zoneCoverage", 0), 65)
        if r.get("strength", 0) < 50:
            r["strength"] = 65
        if r.get("playRecognition", 0) < 55:
            r["playRecognition"] = max(r.get("playRecognition", 0), 65)

    # CB: cap DL stats (calibration group is misaligned — contains DTs, not CBs)
    if pos == "CB":
        for stat in ("blockShedding", "powerMoves", "finesseMoves", "tackle", "hitPower", "pursuit"):
            if r.get(stat, 0) > 30:
                r[stat] = 30
        if r.get("manCoverage", 0) < 55:
            r["manCoverage"] = max(r.get("manCoverage", 0), 60)
        if r.get("zoneCoverage", 0) < 55:
            r["zoneCoverage"] = max(r.get("zoneCoverage", 0), 60)

    return r


# ── Rate a single prospect ────────────────────────────────────────────────────
def rate_prospect(
    prospect: dict,
    model: str,
    calibration: dict,
    current_ratings: dict,
    verbose: bool = False,
    provider: str = "ollama",
    langchain_llm=None,
    athleticism_llm=None,
) -> dict:
    """
    Generate Madden 26 ratings for a single prospect.
    Returns the ratings dict (fully validated).

    When *provider* is ``"ollama"`` (the default) the existing direct Ollama
    call path is used.  For any LangChain-backed provider pass *langchain_llm*
    (built with :func:`build_langchain_llm`) and the appropriate *provider*
    string; the call is then routed through LangChain.

    For ``"multi-chain"`` pass both *langchain_llm* (skills model) and
    *athleticism_llm* (fast model for Chain 1).  The three-chain LCEL pipeline
    is used instead of a single monolithic prompt.
    """
    # Multi-chain: delegate to the specialised function
    if provider == "multi-chain":
        return rate_prospect_multi_chain(
            prospect=prospect,
            skills_llm=langchain_llm,
            athleticism_llm=athleticism_llm,
            calibration=calibration,
            current_ratings=current_ratings,
            verbose=verbose,
        )

    pos = prospect["pos"]
    canon = canonical_pos(pos)
    all_fields_str = ", ".join(ALL_RATING_FIELDS)
    defaults = get_defaults(canon)

    # Gather context
    cal_examples = get_calibration_examples(pos, prospect, calibration)
    anchors = get_current_anchors(pos, current_ratings) if current_ratings else []

    # Build primary prompt
    prompt = build_prompt(prospect, cal_examples, anchors)

    text = ""
    ratings_raw = None

    # ── First attempt ──
    try:
        if provider == "ollama":
            text = call_ollama(model, prompt)
        else:
            text = call_llm_langchain(langchain_llm, prompt)
    except Exception as e:
        if "Connection" in type(e).__name__ or "ConnectionRefused" in str(e) or "connect" in str(e).lower():
            raise ConnectionError(
                f"Cannot reach Ollama at {OLLAMA_HOST}. "
                "Please start Ollama with: ollama serve"
            ) from e
        print(f"  ⚠ LLM error on first attempt: {e}")

    if text:
        ratings_raw = extract_json(text)

    # ── Count missing fields ──
    missing_count = 0
    if ratings_raw:
        missing_count = sum(1 for f in ALL_RATING_FIELDS if f not in ratings_raw)

    # ── Retry if parse failed or too many missing fields ──
    if ratings_raw is None or missing_count > 10:
        correction_prompt = build_correction_prompt(all_fields_str, text)
        try:
            if provider == "ollama":
                text2 = call_ollama(model, correction_prompt)
            else:
                text2 = call_llm_langchain(langchain_llm, correction_prompt)
            ratings_raw2 = extract_json(text2)
            if ratings_raw2 is not None:
                ratings_raw = ratings_raw2
                text = text2
        except ConnectionError:
            raise
        except Exception as e:
            print(f"  ⚠ LLM error on retry: {e}")

    # ── Final fallback: use defaults entirely ──
    if ratings_raw is None:
        print(f"  ✗ Could not parse ratings for {prospect.get('name')} — using defaults")
        return dict(defaults)

    # ── Validate / clamp ──
    cleaned, issues = validate_ratings(ratings_raw, canon)

    if verbose and issues:
        print(f"  ↳ Fixed {len(issues)} field(s): {', '.join(issues[:5])}"
              + (" ..." if len(issues) > 5 else ""))

    cleaned = apply_position_corrections(cleaned, pos, prospect.get("forty"))

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
    parser = argparse.ArgumentParser(description="Generate Madden 26 ratings for 2026 prospects.")
    parser.add_argument("--model", default=None, help="LLM model name (default: from .env or llama3:8b / gpt-4o-mini)")
    parser.add_argument(
        "--provider",
        default=None,
        choices=["ollama", "ollama-langchain", "openai", "multi-chain"],
        help=(
            "LLM provider to use (default: from LLM_PROVIDER in .env, or 'ollama').\n"
            "  ollama           — Direct Ollama call (no extra deps)\n"
            "  ollama-langchain — Ollama via LangChain (requires langchain-ollama)\n"
            "  openai           — OpenAI API via LangChain (requires langchain-openai + OPENAI_API_KEY)\n"
            "  multi-chain      — 3-chain decomposition strategy (best quality, requires langchain-ollama or langchain-openai)\n"
            "                     Chain 1 (athleticism_llm): combine measurables → physical ratings\n"
            "                     Chain 2 (skills_llm):      position context → skill ratings   [parallel]\n"
            "                     Chain 3 (skills_llm):      merged context → overall + devTrait [sequential]"
        ),
    )
    parser.add_argument(
        "--athleticism-model",
        metavar="MODEL",
        default=None,
        help=(
            "Model for the athleticism chain in multi-chain mode (default: same as --model). "
            "Use a smaller/faster model here to reduce cost — physical attributes are nearly "
            "deterministic from combine measurables and do not require a large model."
        ),
    )
    parser.add_argument("--resume", action="store_true", help="Resume from checkpoint if available")
    parser.add_argument("--verbose", action="store_true", help="Print field-fix details")
    parser.add_argument("--prospects", metavar="N", type=int, default=None, help="Max prospects to process")
    args = parser.parse_args()

    provider = args.provider or DEFAULT_PROVIDER

    # Resolve the model default based on provider
    if args.model:
        model = args.model
    elif provider == "openai":
        model = OPENAI_MODEL
    else:
        model = DEFAULT_MODEL

    # ── Load input data ──
    print(f"Loading prospects from {PROSPECTS_FILE} ...")
    with open(PROSPECTS_FILE, "r", encoding="utf-8") as f:
        prospects: list[dict] = json.load(f)
    print(f"  {len(prospects)} prospects loaded.")

    print(f"Loading calibration set from {CALIBRATION_FILE} ...")
    with open(CALIBRATION_FILE, "r", encoding="utf-8") as f:
        calibration: dict = json.load(f)

    current_ratings: dict = {}
    if os.path.exists(CURRENT_RATINGS_FILE):
        print(f"Loading current player ratings from {CURRENT_RATINGS_FILE} ...")
        with open(CURRENT_RATINGS_FILE, "r", encoding="utf-8") as f:
            current_ratings = json.load(f)
    else:
        print("  (No current_player_ratings.json found — skipping anchors)")

    # ── Provider-specific setup and connectivity check ────────────────────────
    langchain_llm = None
    athleticism_llm_obj = None

    if provider == "ollama":
        # Check Ollama connectivity early
        try:
            import ollama
            ollama.list()
        except Exception as e:
            err_str = str(e).lower()
            if "connection" in err_str or "refused" in err_str or "connect" in err_str:
                print(
                    f"\n❌  Cannot connect to Ollama at {OLLAMA_HOST}.\n"
                    "    Please start Ollama first:\n"
                    "        ollama serve\n"
                    "    Or set OLLAMA_HOST in your .env file.\n"
                )
                sys.exit(1)
            print(f"  ⚠ Ollama connectivity check warning: {e}")

    elif provider in ("ollama-langchain", "openai"):
        try:
            langchain_llm = build_langchain_llm(provider, model)
            print(f"  LangChain provider '{provider}' initialised with model '{model}'.")
        except (ImportError, ValueError) as exc:
            print(f"\n❌  {exc}")
            sys.exit(1)

        # Quick connectivity check via a minimal invoke
        if provider == "ollama-langchain":
            try:
                from langchain_core.messages import HumanMessage
                langchain_llm.invoke([HumanMessage(content="ping")])
            except Exception as e:
                err_str = str(e).lower()
                if "connection" in err_str or "refused" in err_str or "connect" in err_str:
                    print(
                        f"\n❌  Cannot connect to Ollama at {OLLAMA_HOST} (LangChain path).\n"
                        "    Please start Ollama first:\n"
                        "        ollama serve\n"
                    )
                    sys.exit(1)
                print(f"  ⚠ LangChain/Ollama connectivity check warning: {e}")

    elif provider == "multi-chain":
        # Determine which LangChain backend to use (ollama-langchain or openai)
        # If OPENAI_API_KEY is set we default to the openai backend, else ollama-langchain.
        mc_backend = "openai" if os.getenv("OPENAI_API_KEY") else "ollama-langchain"

        # Skills LLM (main model)
        try:
            langchain_llm = build_langchain_llm(mc_backend, model)
            print(f"  Multi-chain skills LLM: backend='{mc_backend}' model='{model}'.")
        except (ImportError, ValueError) as exc:
            print(f"\n❌  {exc}")
            sys.exit(1)

        # Athleticism LLM (may be a different, smaller model)
        athl_model = args.athleticism_model or ATHLETICISM_MODEL or model
        if athl_model != model:
            try:
                athleticism_llm_obj = build_langchain_llm(mc_backend, athl_model)
                print(f"  Multi-chain athleticism LLM: backend='{mc_backend}' model='{athl_model}'.")
            except (ImportError, ValueError) as exc:
                print(f"\n❌  {exc}")
                sys.exit(1)
        else:
            # Reuse the same LLM instance
            athleticism_llm_obj = langchain_llm
            print(f"  Multi-chain athleticism LLM: same as skills LLM ('{model}').")

    # ── Resume / checkpoint logic ──
    rated_list: list[dict] = []
    completed_names: set[str] = set()

    if args.resume and os.path.exists(CHECKPOINT_FILE):
        rated_list = load_checkpoint()
        completed_names = {p["name"] for p in rated_list}
        print(f"  ↳ Resuming from checkpoint: {len(rated_list)} prospects already rated.")

    remaining = [p for p in prospects if p.get("name", "") not in completed_names]
    if args.prospects:
        remaining = remaining[:args.prospects]
    print(f"\nGenerating ratings for {len(remaining)} prospect(s) using provider '{provider}', model '{model}' ...")
    if provider == "ollama":
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
                    verbose=args.verbose,
                    provider=provider,
                    langchain_llm=langchain_llm,
                    athleticism_llm=athleticism_llm_obj,
                )
            except ConnectionError as ce:
                print(f"\n❌  {ce}")
                print("Saving progress to checkpoint before exit ...")
                save_checkpoint(rated_list)
                sys.exit(1)
            except Exception as exc:
                print(f"\n  ✗ Unexpected error for {name}: {exc} — using defaults")
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

    # ── Write final output ──
    print(f"\nSaving {len(rated_list)} rated prospects to {OUTPUT_FILE} ...")
    with open(OUTPUT_FILE, "w", encoding="utf-8") as f:
        json.dump(rated_list, f, indent=2)

    # Remove checkpoint on successful completion
    if os.path.exists(CHECKPOINT_FILE):
        os.remove(CHECKPOINT_FILE)
        print("  Checkpoint removed (run complete).")

    print(f"\n✅  Done! {OUTPUT_FILE} written with {len(rated_list)} records.")


if __name__ == "__main__":
    main()
