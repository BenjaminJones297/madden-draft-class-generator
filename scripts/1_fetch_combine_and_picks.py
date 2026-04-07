"""
Script 1 — Fetch nflverse combine and draft_picks CSVs.

Downloads:
  - combine.csv      → filtered to draft_year 2025 → data/raw/combine_2025.csv
                     → filtered to draft_year 2026 → data/raw/combine_2026.csv
                     → full unfiltered             → data/raw/combine_full.csv
  - draft_picks.csv  → filtered to season 2025     → data/raw/draft_picks_2025.csv

Run:
  python scripts/1_fetch_combine_and_picks.py
"""

import csv
import io
import os
import sys

import requests
from tqdm import tqdm

# ---------------------------------------------------------------------------
# Paths — resolved relative to this script so it works from any cwd
# ---------------------------------------------------------------------------
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(SCRIPT_DIR)
RAW_DIR = os.path.join(PROJECT_ROOT, "data", "raw")

# ---------------------------------------------------------------------------
# Source URLs
# ---------------------------------------------------------------------------
COMBINE_URL = (
    "https://github.com/nflverse/nflverse-data/releases/download/combine/combine.csv"
)
DRAFT_PICKS_URL = (
    "https://github.com/nflverse/nflverse-data/releases/download/draft_picks/draft_picks.csv"
)

# ---------------------------------------------------------------------------
# Combine CSV columns (in order, for reference)
# ---------------------------------------------------------------------------
COMBINE_COLUMNS = [
    "season", "draft_year", "draft_team", "draft_round", "draft_ovr",
    "pfr_id", "cfb_id", "player_name", "pos", "school",
    "ht", "wt", "forty", "bench", "vertical", "broad_jump", "cone", "shuttle",
]


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def download_csv(url: str, label: str) -> list[dict]:
    """
    Download a CSV from *url* and return its rows as a list of dicts.
    Streams the response and shows a tqdm progress bar.
    Raises SystemExit on HTTP or network errors.
    """
    print(f"\n→ Downloading {label} …")
    print(f"  {url}")

    try:
        response = requests.get(url, stream=True, timeout=60)
        response.raise_for_status()
    except requests.exceptions.HTTPError as exc:
        print(f"  ✗ HTTP error {exc.response.status_code}: {exc}", file=sys.stderr)
        sys.exit(1)
    except requests.exceptions.ConnectionError as exc:
        print(f"  ✗ Connection error: {exc}", file=sys.stderr)
        sys.exit(1)
    except requests.exceptions.Timeout:
        print(f"  ✗ Request timed out after 60 s", file=sys.stderr)
        sys.exit(1)
    except requests.exceptions.RequestException as exc:
        print(f"  ✗ Request failed: {exc}", file=sys.stderr)
        sys.exit(1)

    # Buffer the streamed content, showing progress if Content-Length is known
    total = int(response.headers.get("content-length", 0)) or None
    chunks = []
    with tqdm(
        total=total,
        unit="B",
        unit_scale=True,
        unit_divisor=1024,
        desc=f"  {label}",
        leave=False,
    ) as bar:
        for chunk in response.iter_content(chunk_size=65536):
            chunks.append(chunk)
            bar.update(len(chunk))

    raw_bytes = b"".join(chunks)
    text = raw_bytes.decode("utf-8-sig")  # strip BOM if present

    reader = csv.DictReader(io.StringIO(text))
    rows = list(reader)
    print(f"  ✓ Downloaded {len(rows):,} rows")
    return rows


def write_csv(path: str, rows: list[dict], fieldnames: list[str] | None = None) -> int:
    """
    Write *rows* to *path* as CSV. If *rows* is empty, writes only the header
    row (using *fieldnames* if provided). Returns the number of data rows written.
    """
    os.makedirs(os.path.dirname(path), exist_ok=True)

    if not rows and fieldnames:
        with open(path, "w", newline="", encoding="utf-8") as fh:
            writer = csv.DictWriter(fh, fieldnames=fieldnames)
            writer.writeheader()
        return 0

    if not rows:
        # Nothing to write and no schema provided — write empty file
        open(path, "w").close()
        return 0

    actual_fields = list(rows[0].keys()) if not fieldnames else fieldnames

    with open(path, "w", newline="", encoding="utf-8") as fh:
        writer = csv.DictWriter(fh, fieldnames=actual_fields, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(rows)

    return len(rows)


def filter_rows(rows: list[dict], column: str, value: str) -> list[dict]:
    """Return rows where rows[column] == value (string comparison)."""
    return [r for r in rows if str(r.get(column, "")).strip() == value]


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> None:
    print("=" * 60)
    print("Script 1 — Fetch combine & draft picks data")
    print("=" * 60)

    # ------------------------------------------------------------------ #
    # 1. Combine CSV                                                       #
    # ------------------------------------------------------------------ #
    combine_rows = download_csv(COMBINE_URL, "combine.csv")

    combine_2025 = filter_rows(combine_rows, "draft_year", "2025")
    combine_2026 = filter_rows(combine_rows, "draft_year", "2026")

    print(f"\n  Combine rows — 2025: {len(combine_2025):,}, "
          f"2026: {len(combine_2026):,}, full: {len(combine_rows):,}")

    # Determine the actual column order from the downloaded data; fall back
    # to the expected schema if the file is empty/malformed.
    combine_fieldnames = list(combine_rows[0].keys()) if combine_rows else COMBINE_COLUMNS

    out_combine_2025 = os.path.join(RAW_DIR, "combine_2025.csv")
    out_combine_2026 = os.path.join(RAW_DIR, "combine_2026.csv")
    out_combine_full = os.path.join(RAW_DIR, "combine_full.csv")

    n_c25 = write_csv(out_combine_2025, combine_2025)
    # For 2026: write empty file with headers if no data exists yet
    n_c26 = write_csv(out_combine_2026, combine_2026, fieldnames=combine_fieldnames)
    n_cf  = write_csv(out_combine_full,  combine_rows)

    # ------------------------------------------------------------------ #
    # 2. Draft picks CSV                                                   #
    # ------------------------------------------------------------------ #
    picks_rows = download_csv(DRAFT_PICKS_URL, "draft_picks.csv")

    picks_2025 = filter_rows(picks_rows, "season", "2025")
    print(f"\n  Draft pick rows — 2025: {len(picks_2025):,}, full: {len(picks_rows):,}")

    out_picks_2025 = os.path.join(RAW_DIR, "draft_picks_2025.csv")
    n_p25 = write_csv(out_picks_2025, picks_2025)

    # ------------------------------------------------------------------ #
    # 3. Summary                                                           #
    # ------------------------------------------------------------------ #
    print("\n" + "=" * 60)
    print("Summary — rows saved per file")
    print("=" * 60)
    rows_summary = [
        (out_combine_2025, n_c25),
        (out_combine_2026, n_c26),
        (out_combine_full,  n_cf),
        (out_picks_2025,   n_p25),
    ]
    for path, count in rows_summary:
        rel = os.path.relpath(path, PROJECT_ROOT)
        note = "  (header-only — no 2026 data yet)" if path == out_combine_2026 and count == 0 else ""
        print(f"  {rel:<45} {count:>6,} rows{note}")

    print("\n✓ Done.")


if __name__ == "__main__":
    main()
