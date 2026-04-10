#!/usr/bin/env python3
"""
run.py — Madden 26 Draft Class Generator · Pipeline Orchestrator

Runs all 7 pipeline scripts in order:
  1. scripts/1_fetch_combine_and_picks.py    (Python)  — download nflverse CSVs
  2. scripts/2_extract_calibration.js        (Node)    — build calibration set
  3. scripts/3_extract_roster_ratings.js     (Node)    — extract roster ratings [OPTIONAL]
  4. scripts/4_fetch_2026_prospects.py       (Python)  — fetch 2026 prospects
  5. scripts/5_generate_ratings.py           (Python)  — generate ratings via Ollama
  6. scripts/polish_ratings{4..11}.js        (Node)    — apply calibration polish passes
  7. scripts/6_create_draft_class.js         (Node)    — write .draftclass file

Usage:
  python3 run.py [options]

Run  python3 run.py --help  for full usage.
"""

import argparse
import os
import shutil
import subprocess
import sys
import time

# ---------------------------------------------------------------------------
# Project root is the directory this file lives in
# ---------------------------------------------------------------------------
PROJECT_ROOT = os.path.dirname(os.path.abspath(__file__))


# ---------------------------------------------------------------------------
# .env loader — simple KEY=VALUE parser; no dotenv package required
# ---------------------------------------------------------------------------

def load_dotenv(env_path: str) -> dict:
    """
    Parse a .env file into a dict.  Handles:
      - Blank lines and lines starting with # (comments)
      - Optional surrounding quotes on values
      - Inline comments after the value (preceded by ' #' or '\t#')
    Returns a dict of {KEY: value}.  Does NOT mutate os.environ.
    """
    env = {}
    if not os.path.isfile(env_path):
        return env
    with open(env_path, "r", encoding="utf-8") as fh:
        for raw_line in fh:
            line = raw_line.strip()
            if not line or line.startswith("#"):
                continue
            if "=" not in line:
                continue
            key, _, rest = line.partition("=")
            key = key.strip()
            # Strip inline comment
            for sep in (" #", "\t#"):
                if sep in rest:
                    rest = rest[: rest.index(sep)]
            value = rest.strip().strip('"').strip("'")
            env[key] = value
    return env


# ---------------------------------------------------------------------------
# Argument parser
# ---------------------------------------------------------------------------

def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="run.py",
        description="Madden 26 Draft Class Generator — pipeline orchestrator",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Full pipeline — no roster file
  python3 run.py

  # Full pipeline with roster file for better calibration
  python3 run.py --ros ~/Documents/Madden\\ NFL\\ 26/saves/ROSTER_FILE.ros

  # Use a different Ollama model
  python3 run.py --model llama3:70b

  # Skip slow fetch steps when data already exists
  python3 run.py --skip-fetch --skip-calibration

  # Resume an interrupted rating generation run
  python3 run.py --skip-fetch --skip-calibration --resume

  # Limit to 50 prospects (fast test run)
  python3 run.py --prospects 50

  # Jump straight to step 5 (all earlier data already present)
  python3 run.py --start-from 5 --resume

  # Re-apply polish passes and rebuild (skip LLM generation)
  python3 run.py --start-from 6
""",
    )
    parser.add_argument(
        "--ros",
        metavar="PATH",
        default=None,
        help="Path to Madden 26 .ros roster file (optional, for player rating benchmarks)",
    )
    parser.add_argument(
        "--model",
        metavar="MODEL",
        default=None,
        help="Ollama model to use (default: llama3:8b, or OLLAMA_MODEL from .env)",
    )
    parser.add_argument(
        "--out",
        metavar="DIR",
        default=None,
        help="Output directory for the .draftclass file (default: data/output)",
    )
    parser.add_argument(
        "--prospects",
        metavar="N",
        type=int,
        default=None,
        help="Maximum number of prospects to generate ratings for (default: all)",
    )
    parser.add_argument(
        "--skip-fetch",
        action="store_true",
        default=False,
        help="Skip steps 1 & 4 — use existing data/raw/ and prospects_2026.json",
    )
    parser.add_argument(
        "--skip-calibration",
        action="store_true",
        default=False,
        help="Skip step 2 — use existing calibration_set.json",
    )
    parser.add_argument(
        "--skip-polish",
        action="store_true",
        default=False,
        help="Skip step 6 — do not apply calibration polish passes",
    )
    parser.add_argument(
        "--resume",
        action="store_true",
        default=False,
        help="Pass --resume to step 5 to continue an interrupted rating generation run",
    )
    parser.add_argument(
        "--start-from",
        metavar="N",
        type=int,
        default=1,
        choices=range(1, 8),
        help="Start from step N (1–7), skipping all earlier steps (default: 1)",
    )
    return parser


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def find_node() -> str:
    """Return the path to the node executable, or raise RuntimeError."""
    node = shutil.which("node")
    if node is None:
        raise RuntimeError(
            "node not found on PATH.\n"
            "  Install Node.js >= 18 from https://nodejs.org/\n"
            "  macOS:  brew install node\n"
            "  Linux:  sudo apt install nodejs  (or use nvm)\n"
            "  Windows: download from https://nodejs.org/"
        )
    return node


def fmt_elapsed(seconds: float) -> str:
    """Format seconds as '2m 14s' or '45s'."""
    minutes = int(seconds) // 60
    secs = int(seconds) % 60
    if minutes:
        return f"{minutes}m {secs}s"
    return f"{secs}s"


def print_step_header(step: int, total: int, description: str) -> None:
    print(f"\n=== Step {step}/{total}: {description} ===")


def run_step(
    label: str,
    cmd: list,
    step_num: int,
    optional: bool = False,
    hint: str = "",
    cwd: str = PROJECT_ROOT,
    env: dict = None,
) -> bool:
    """
    Run a subprocess command.  Returns True on success.

    If optional=True, a non-zero exit code is logged but does NOT abort.
    If optional=False, a non-zero exit code prints an error + optional hint
    and returns False, signalling the caller to abort.
    """
    print(f"  Running: {' '.join(cmd)}")
    result = subprocess.run(cmd, cwd=cwd, env=env)
    if result.returncode != 0:
        if optional:
            print(f"  ⚠  Step {step_num} exited with code {result.returncode} (optional — continuing)")
            return True
        print(f"\n✗  Step {step_num} failed (exit code {result.returncode}).")
        if hint:
            print(f"  Hint: {hint}")
        return False
    return True


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> int:
    # ── Parse args ──────────────────────────────────────────────────────────
    parser = build_parser()
    args = parser.parse_args()

    # ── Load .env ────────────────────────────────────────────────────────────
    env_path = os.path.join(PROJECT_ROOT, ".env")
    dotenv = load_dotenv(env_path)

    if os.path.isfile(env_path):
        print(f"  Loaded .env from {env_path}")

    # ── Resolve configuration (CLI > .env > built-in defaults) ───────────────
    ros_path = args.ros or dotenv.get("ROSTER_FILE") or None
    if ros_path:
        ros_path = os.path.expanduser(ros_path)

    model = args.model or dotenv.get("OLLAMA_MODEL") or "llama3:8b"
    output_dir = args.out or dotenv.get("OUTPUT_DIR") or os.path.join(PROJECT_ROOT, "data", "output")
    output_dir = os.path.expanduser(output_dir)

    # NUM_PROSPECTS from .env is a fallback for --prospects
    if args.prospects is None and dotenv.get("NUM_PROSPECTS"):
        try:
            args.prospects = int(dotenv["NUM_PROSPECTS"])
        except ValueError:
            pass

    ollama_host = dotenv.get("OLLAMA_HOST", "http://localhost:11434")

    # ── Locate executables ───────────────────────────────────────────────────
    python = sys.executable

    try:
        node = find_node()
    except RuntimeError as exc:
        print(f"\n✗  {exc}")
        return 1

    # ── Print run configuration ──────────────────────────────────────────────
    print("\n" + "=" * 60)
    print("  Madden 26 — 2026 Draft Class Generator")
    print("=" * 60)
    print(f"  Python   : {python}")
    print(f"  Node     : {node}")
    print(f"  Model    : {model}")
    print(f"  Ollama   : {ollama_host}")
    print(f"  Output   : {output_dir}")
    if ros_path:
        print(f"  Roster   : {ros_path}")
    if args.prospects:
        print(f"  Prospects: {args.prospects} (max)")
    if args.skip_fetch:
        print("  --skip-fetch active: skipping steps 1 & 4")
    if args.skip_calibration:
        print("  --skip-calibration active: skipping step 2")
    if args.skip_polish:
        print("  --skip-polish active: skipping step 6")
    if args.resume:
        print("  --resume active: step 5 will continue from last checkpoint")
    if args.start_from > 1:
        print(f"  --start-from {args.start_from}: skipping steps 1–{args.start_from - 1}")

    # ── Ensure output directory exists ──────────────────────────────────────
    os.makedirs(output_dir, exist_ok=True)

    pipeline_start = time.time()
    TOTAL_STEPS = 7

    # ═══════════════════════════════════════════════════════════════════════
    # Step 1 — Fetch nflverse combine + draft picks CSVs
    # ═══════════════════════════════════════════════════════════════════════
    step = 1
    if args.start_from <= step and not args.skip_fetch:
        print_step_header(step, TOTAL_STEPS, "Fetch nflverse combine & draft-picks CSVs")
        cmd = [python, os.path.join(PROJECT_ROOT, "scripts", "1_fetch_combine_and_picks.py")]
        ok = run_step(
            label="fetch combine/picks",
            cmd=cmd,
            step_num=step,
            hint="Check your internet connection and try again.",
        )
        if not ok:
            return 1
    elif args.skip_fetch:
        print(f"\n--- Step 1/7: Skipped (--skip-fetch) ---")
    else:
        print(f"\n--- Step 1/7: Skipped (--start-from {args.start_from}) ---")

    # ═══════════════════════════════════════════════════════════════════════
    # Step 2 — Build calibration set from M26 2025 draft class
    # ═══════════════════════════════════════════════════════════════════════
    step = 2
    if args.start_from <= step and not args.skip_calibration:
        print_step_header(step, TOTAL_STEPS, "Extract M26 2025 calibration set")
        cmd = [node, os.path.join(PROJECT_ROOT, "scripts", "2_extract_calibration.js")]
        ok = run_step(
            label="extract calibration",
            cmd=cmd,
            step_num=step,
            hint="Check your internet connection; the script downloads the M26 2025 draft class.",
        )
        if not ok:
            return 1
    elif args.skip_calibration:
        print(f"\n--- Step 2/7: Skipped (--skip-calibration) ---")
    else:
        print(f"\n--- Step 2/7: Skipped (--start-from {args.start_from}) ---")

    # ═══════════════════════════════════════════════════════════════════════
    # Step 3 — Extract current roster ratings (OPTIONAL)
    # ═══════════════════════════════════════════════════════════════════════
    step = 3
    if args.start_from <= step:
        if not ros_path:
            print(f"\n--- Step 3/7: Skipped (no --ros provided) ---")
            print("  Tip: provide --ros /path/to/file.ros for better rating benchmarks.")
        else:
            print_step_header(step, TOTAL_STEPS, "Extract current roster ratings from .ros file")
            if not os.path.isfile(ros_path):
                print(f"  ⚠  Warning: .ros file not found at: {ros_path}")
                print("  Skipping step 3 and continuing without roster benchmarks.")
            else:
                cmd = [
                    node,
                    os.path.join(PROJECT_ROOT, "scripts", "3_extract_roster_ratings.js"),
                    "--ros",
                    ros_path,
                ]
                # Optional: non-zero exit does not abort the pipeline
                run_step(
                    label="extract roster ratings",
                    cmd=cmd,
                    step_num=step,
                    optional=True,
                    hint="Ensure the file is a valid Madden 26 .ros roster file.",
                )
    else:
        print(f"\n--- Step 3/7: Skipped (--start-from {args.start_from}) ---")

    # ═══════════════════════════════════════════════════════════════════════
    # Step 4 — Fetch 2026 prospects
    # ═══════════════════════════════════════════════════════════════════════
    step = 4
    if args.start_from <= step and not args.skip_fetch:
        print_step_header(step, TOTAL_STEPS, "Fetch 2026 NFL draft prospects")
        cmd = [python, os.path.join(PROJECT_ROOT, "scripts", "4_fetch_2026_prospects.py")]
        ok = run_step(
            label="fetch 2026 prospects",
            cmd=cmd,
            step_num=step,
            hint=(
                "Web scraping may be blocked. "
                "Edit data/raw/prospects_2026_manual.csv and re-run with --skip-fetch."
            ),
        )
        if not ok:
            return 1
    elif args.skip_fetch:
        print(f"\n--- Step 4/7: Skipped (--skip-fetch) ---")
    else:
        print(f"\n--- Step 4/7: Skipped (--start-from {args.start_from}) ---")

    # ═══════════════════════════════════════════════════════════════════════
    # Step 5 — Generate ratings via Ollama
    # ═══════════════════════════════════════════════════════════════════════
    step = 5
    if args.start_from <= step:
        print_step_header(step, TOTAL_STEPS, f"Generate ratings via Ollama ({model})")
        print("  This is the longest step — each prospect requires an LLM call.")
        cmd = [
            python,
            os.path.join(PROJECT_ROOT, "scripts", "5_generate_ratings.py"),
            "--model", model,
        ]
        if args.resume:
            cmd.append("--resume")
        if args.prospects:
            cmd.extend(["--max-prospects", str(args.prospects)])
        env = None

        ok = run_step(
            label="generate ratings",
            cmd=cmd,
            step_num=step,
            env=env,
            hint=(
                "Is Ollama running?  Try: ollama serve\n"
                f"  Is the model pulled?  Try: ollama pull {model}\n"
                "  To continue an interrupted run, add --resume"
            ),
        )
        if not ok:
            return 1
    else:
        print(f"\n--- Step 5/7: Skipped (--start-from {args.start_from}) ---")

    # ═══════════════════════════════════════════════════════════════════════
    # Step 6 — Apply calibration polish passes
    # ═══════════════════════════════════════════════════════════════════════
    step = 6
    POLISH_SCRIPTS = [
        "polish_ratings4.js",
        "polish_ratings5.js",
        "polish_ratings6.js",
        "polish_ratings7.js",
        "polish_ratings8.js",
        "polish_ratings9.js",
        "polish_ratings10.js",
        "polish_ratings11.js",
        "polish_ratings12.js",
    ]
    if args.start_from <= step and not args.skip_polish:
        print_step_header(step, TOTAL_STEPS, "Apply calibration polish passes")
        for script in POLISH_SCRIPTS:
            script_path = os.path.join(PROJECT_ROOT, "scripts", script)
            if not os.path.isfile(script_path):
                print(f"  ⚠  {script} not found — skipping")
                continue
            ok = run_step(
                label=script,
                cmd=[node, script_path, "--fix"],
                step_num=step,
                hint=f"Check {script} for errors.",
            )
            if not ok:
                return 1
    elif args.skip_polish:
        print(f"\n--- Step 6/7: Skipped (--skip-polish) ---")
    else:
        print(f"\n--- Step 6/7: Skipped (--start-from {args.start_from}) ---")

    # ═══════════════════════════════════════════════════════════════════════
    # Step 7 — Write .draftclass file
    # ═══════════════════════════════════════════════════════════════════════
    step = 7
    if args.start_from <= step:
        print_step_header(step, TOTAL_STEPS, "Write .draftclass file")
        cmd = [
            node,
            os.path.join(PROJECT_ROOT, "scripts", "6_create_draft_class.js"),
            "--out", os.path.join(output_dir, "2026_draft_class.draftclass"),
        ]
        ok = run_step(
            label="create draft class",
            cmd=cmd,
            step_num=step,
            hint=(
                "Ensure step 5 completed successfully and data/prospects_rated.json exists.\n"
                "  Then re-run: python3 run.py --start-from 7"
            ),
        )
        if not ok:
            return 1
    else:
        print(f"\n--- Step 7/7: Skipped (--start-from {args.start_from}) ---")

    # ── Success ─────────────────────────────────────────────────────────────
    elapsed = time.time() - pipeline_start
    output_file = os.path.join(output_dir, "2026_draft_class.draftclass")

    print("\n" + "=" * 60)
    print("  ✓  Pipeline complete!")
    print(f"  Output : {output_file}")
    print(f"  Time   : {fmt_elapsed(elapsed)}")
    print("=" * 60)
    print()
    print("  How to use in Madden 26:")
    print("  1. Copy the .draftclass file to your Madden 26 saves folder:")
    print("       Windows : C:\\Users\\<user>\\Documents\\Madden NFL 26\\saves\\")
    print("       macOS   : ~/Documents/Madden NFL 26/saves/")
    print("  2. Start a new franchise, choose 'Custom Draft Class', and")
    print("       select '2026_draft_class' from the list.")
    print()

    return 0


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        print("\n\n  Interrupted by user (Ctrl+C).  Exiting.")
        print("  Tip: re-run with --resume to continue rating generation from where it left off.")
        sys.exit(130)
