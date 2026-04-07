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

from dotenv import load_dotenv
from tqdm import tqdm

# ── Path setup ──────────────────────────────────────────────────────────────
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(SCRIPT_DIR)

sys.path.insert(0, PROJECT_ROOT)

from utils.enums import ALL_RATING_FIELDS, POSITION_KEY_FIELDS, POSITION_TO_ENUM
from utils.defaults import get_defaults

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
OUTPUT_FILE = os.path.join(DATA_DIR, "prospects_rated.json")
CHECKPOINT_FILE = os.path.join(DATA_DIR, "prospects_rated_checkpoint.json")

# ── Position fallback mapping (for positions with no calibration examples) ───
POSITION_FALLBACKS = {
    # DE/edge rushers often flip between DE and OLB scheme-to-scheme;
    # the calibration 'DE' group is misaligned (contains OL), so always
    # blend with OLB + MLB where the real pass-rushers actually live.
    "DE":   ["OLB", "MLB"],
    "EDGE": ["OLB", "MLB", "DE"],
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

    # ── Rules ──
    lines.append("Rules:")
    lines.append("- All rating values must be integers between 0 and 99")
    lines.append("- devTrait: 0=Normal, 1=Impact, 2=Star, 3=XFactor (top 5 picks can be Star/XFactor)")
    lines.append("- Ratings should reflect a ROOKIE — do not inflate. Compare to the calibration examples above.")
    lines.append("- Non-relevant ratings for this position should be low (28-40 range)")
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


# ── Rate a single prospect ────────────────────────────────────────────────────
def rate_prospect(
    prospect: dict,
    model: str,
    calibration: dict,
    current_ratings: dict,
    verbose: bool = False,
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
    anchors = get_current_anchors(pos, current_ratings) if current_ratings else []

    # Build primary prompt
    prompt = build_prompt(prospect, cal_examples, anchors)

    text = ""
    ratings_raw = None

    # ── First attempt ──
    try:
        text = call_ollama(model, prompt)
    except Exception as e:
        if "Connection" in type(e).__name__ or "ConnectionRefused" in str(e) or "connect" in str(e).lower():
            raise ConnectionError(
                f"Cannot reach Ollama at {OLLAMA_HOST}. "
                "Please start Ollama with: ollama serve"
            ) from e
        print(f"  ⚠ Ollama error on first attempt: {e}")

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
            text2 = call_ollama(model, correction_prompt)
            ratings_raw2 = extract_json(text2)
            if ratings_raw2 is not None:
                ratings_raw = ratings_raw2
                text = text2
        except ConnectionError:
            raise
        except Exception as e:
            print(f"  ⚠ Ollama error on retry: {e}")

    # ── Final fallback: use defaults entirely ──
    if ratings_raw is None:
        print(f"  ✗ Could not parse ratings for {prospect.get('name')} — using defaults")
        return dict(defaults)

    # ── Validate / clamp ──
    cleaned, issues = validate_ratings(ratings_raw, canon)

    if verbose and issues:
        print(f"  ↳ Fixed {len(issues)} field(s): {', '.join(issues[:5])}"
              + (" ..." if len(issues) > 5 else ""))

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
    args = parser.parse_args()

    model = args.model or DEFAULT_MODEL

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

    # ── Check Ollama connectivity early ──
    try:
        import ollama
        # Quick connectivity test — list models
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
        # Non-connection error (e.g. API version mismatch) — warn but continue
        print(f"  ⚠ Ollama connectivity check warning: {e}")

    # ── Resume / checkpoint logic ──
    rated_list: list[dict] = []
    completed_names: set[str] = set()

    if args.resume and os.path.exists(CHECKPOINT_FILE):
        rated_list = load_checkpoint()
        completed_names = {p["name"] for p in rated_list}
        print(f"  ↳ Resuming from checkpoint: {len(rated_list)} prospects already rated.")

    remaining = [p for p in prospects if p.get("name", "") not in completed_names]
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
                    verbose=args.verbose,
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
