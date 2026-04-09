#!/usr/bin/env python3
"""
roster_run.py — Madden 26 Roster Generator · Pipeline Orchestrator

Builds a complete Madden 26 roster file from:
  1. Current active NFL roster data + contract information (from nflverse)
  2. Official Madden 26 player ratings from your .ros file

Pipeline steps:
  7. scripts/7_fetch_nfl_roster_and_contracts.py  (Python) — download NFL rosters + contracts
  3. scripts/3_extract_roster_ratings.js          (Node)   — extract official Madden ratings
  8. scripts/8_generate_roster_ratings.py         (Python) — merge ratings + contracts

Prerequisites:
  - A Madden 26 .ros roster file (--ros flag or ROSTER_FILE in .env)
    Without this, step 3 is skipped and player ratings fall back to position defaults.
  - Internet access for step 7 (nflverse data download)

Usage:
  python3 roster_run.py [--ros PATH] [--skip-fetch] [--skip-extract]

Run  python3 roster_run.py --help  for full usage.
"""

import argparse
import os
import shutil
import subprocess
import sys
import time

PROJECT_ROOT = os.path.dirname(os.path.abspath(__file__))


# ---------------------------------------------------------------------------
# .env loader (same minimal parser used in run.py)
# ---------------------------------------------------------------------------

def load_dotenv(env_path: str) -> dict:
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
        prog="roster_run.py",
        description="Madden 26 Roster Generator — pipeline orchestrator",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Full pipeline with a Madden .ros file (recommended — uses official ratings)
  python3 roster_run.py --ros ~/Documents/Madden\\ NFL\\ 26/saves/ROSTER_FILE.ros

  # Re-run merging step only (data already downloaded)
  python3 roster_run.py --ros ROSTER.ros --skip-fetch

  # Fetch only (no .ros file — ratings will use position defaults)
  python3 roster_run.py --skip-extract
""",
    )
    parser.add_argument(
        "--ros",
        metavar="PATH",
        default=None,
        help=(
            "Path to Madden 26 .ros roster file. "
            "Required for official Madden ratings. "
            "Without it, player ratings fall back to position defaults."
        ),
    )
    parser.add_argument(
        "--skip-fetch",
        action="store_true",
        default=False,
        help="Skip step 7 — reuse existing data/nfl_rosters_2026.json",
    )
    parser.add_argument(
        "--skip-extract",
        action="store_true",
        default=False,
        help=(
            "Skip step 3 — reuse existing data/current_player_ratings_full.json. "
            "If that file does not exist, script 8 will use position defaults."
        ),
    )
    return parser


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def find_node() -> str:
    node = shutil.which("node")
    if node is None:
        raise RuntimeError(
            "node not found on PATH.\n"
            "  Install Node.js >= 18 from https://nodejs.org/"
        )
    return node


def fmt_elapsed(seconds: float) -> str:
    minutes = int(seconds) // 60
    secs    = int(seconds) % 60
    return f"{minutes}m {secs}s" if minutes else f"{secs}s"


def run_step(label: str, cmd: list, step_num: int, optional: bool = False, hint: str = "", cwd: str = PROJECT_ROOT) -> bool:
    print(f"  Running: {' '.join(cmd)}")
    result = subprocess.run(cmd, cwd=cwd)
    if result.returncode != 0:
        if optional:
            print(f"  ⚠  Step {step_num} exited {result.returncode} (optional — continuing)")
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
    parser = build_parser()
    args   = parser.parse_args()

    env_path = os.path.join(PROJECT_ROOT, ".env")
    dotenv   = load_dotenv(env_path)
    if os.path.isfile(env_path):
        print(f"  Loaded .env from {env_path}")

    ros_path = args.ros or dotenv.get("ROSTER_FILE") or None
    if ros_path:
        ros_path = os.path.expanduser(ros_path)

    python = sys.executable
    try:
        node = find_node()
    except RuntimeError as exc:
        print(f"\n✗  {exc}")
        return 1

    print("\n" + "=" * 60)
    print("  Madden 26 — Current NFL Roster Generator")
    print("=" * 60)
    print(f"  Python : {python}")
    print(f"  Node   : {node}")
    if ros_path:
        print(f"  Roster : {ros_path}")
    else:
        print("  Roster : (none — ratings will use position defaults)")
    if args.skip_fetch:
        print("  --skip-fetch: step 7 skipped")
    if args.skip_extract:
        print("  --skip-extract: step 3 skipped")

    pipeline_start = time.time()

    # ─── Step 7: Fetch NFL rosters + contracts ────────────────────────────────
    if not args.skip_fetch:
        print("\n=== Step 7/3: Fetch current NFL roster & contract data ===")
        ok = run_step(
            label="fetch rosters",
            cmd=[python, os.path.join(PROJECT_ROOT, "scripts", "7_fetch_nfl_roster_and_contracts.py")],
            step_num=7,
            hint="Check your internet connection and try again.",
        )
        if not ok:
            return 1
    else:
        print("\n--- Step 7/3: Skipped (--skip-fetch) ---")

    # ─── Step 3: Extract official Madden ratings from .ros file ───────────────
    if not args.skip_extract:
        if not ros_path:
            print("\n--- Step 3/3: Skipped (no --ros file provided) ---")
            print("  Tip: provide --ros /path/to/file.ros for official Madden ratings.")
        else:
            print("\n=== Step 3/3: Extract official Madden ratings from .ros file ===")
            if not os.path.isfile(ros_path):
                print(f"  ⚠  .ros file not found: {ros_path}")
                print("  Skipping — ratings will fall back to position defaults.")
            else:
                ok = run_step(
                    label="extract ratings",
                    cmd=[node, os.path.join(PROJECT_ROOT, "scripts", "3_extract_roster_ratings.js"),
                         "--ros", ros_path],
                    step_num=3,
                    optional=True,
                    hint="Ensure the file is a valid Madden 26 .ros roster file.",
                )
                if not ok:
                    return 1
    else:
        print("\n--- Step 3/3: Skipped (--skip-extract) ---")

    # ─── Step 8: Merge ratings + contract data ────────────────────────────────
    print("\n=== Step 8/3: Merge official ratings + contract data ===")
    ok = run_step(
        label="merge ratings",
        cmd=[python, os.path.join(PROJECT_ROOT, "scripts", "8_generate_roster_ratings.py")],
        step_num=8,
        hint=(
            "Ensure step 7 completed and data/nfl_rosters_2026.json exists.\n"
            "  For official ratings, also run step 3 with a valid .ros file."
        ),
    )
    if not ok:
        return 1

    # ─── Done ─────────────────────────────────────────────────────────────────
    elapsed     = time.time() - pipeline_start
    output_file = os.path.join(PROJECT_ROOT, "data", "roster_players_rated.json")

    print("\n" + "=" * 60)
    print("  ✓  Roster pipeline complete!")
    print(f"  Output : {output_file}")
    print(f"  Time   : {fmt_elapsed(elapsed)}")
    print("=" * 60)
    print()
    print("  data/roster_players_rated.json contains every active NFL player")
    print("  with their official Madden 26 ratings and current contract data.")
    print()

    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        print("\n\n  Interrupted by user (Ctrl+C).  Exiting.")
        sys.exit(130)
