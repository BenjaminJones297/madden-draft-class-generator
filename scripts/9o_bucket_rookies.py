"""
Script 9o_bucket — Apply calibration to rookie L* measurements → skinTone 1-8.

Inputs:
  data/raw/skin_tone_measurements.json (l_star per rookie)
  data/skin_tone_calibration.json      (anchors + quantile_edges)

Output:
  data/rookie_appearances.json
    [{firstName, lastName, skinTone (1-8), confidence, l_star, headshotUrl,
      calibrationMethod, manualReview: bool}, ...]

The skinTone written here is what 9p_apply_visuals.js will inject into the
franchise: CharacterVisuals.RawData.skinTone + GenericHeadAssetName=gen_<N>_*.

Run:
  python scripts/9o_bucket_rookies.py
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from collections import Counter

SCRIPT_DIR   = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(SCRIPT_DIR)
DATA_DIR     = os.path.join(PROJECT_ROOT, "data")

DEFAULT_MEASUREMENTS = os.path.join(DATA_DIR, "raw", "skin_tone_measurements.json")
DEFAULT_CALIBRATION  = os.path.join(DATA_DIR, "skin_tone_calibration.json")
DEFAULT_MANIFEST     = os.path.join(DATA_DIR, "raw", "headshot_manifest.json")
DEFAULT_OUT          = os.path.join(DATA_DIR, "rookie_appearances.json")

CONFIDENCE_REVIEW = 0.5   # below this → flag for manual review


def classify_anchor(l_star: float, anchors: dict[int, float]) -> int:
    return min(anchors, key=lambda t: abs(l_star - anchors[t]))


def classify_quantile(l_star: float, edges: list[float]) -> int:
    for i, edge in enumerate(edges):
        if l_star >= edge:
            return i + 1
    return 8


def main() -> int:
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

    ap = argparse.ArgumentParser()
    ap.add_argument("--measurements", default=DEFAULT_MEASUREMENTS)
    ap.add_argument("--calibration",  default=DEFAULT_CALIBRATION)
    ap.add_argument("--manifest",     default=DEFAULT_MANIFEST,
                    help="Optional headshot manifest for url info")
    ap.add_argument("--out",          default=DEFAULT_OUT)
    args = ap.parse_args()

    with open(args.measurements, "r", encoding="utf-8") as fh:
        measurements = json.load(fh)
    with open(args.calibration, "r", encoding="utf-8") as fh:
        cal = json.load(fh)

    method  = cal["method"]
    anchors = {int(k): float(v) for k, v in cal["anchors"].items()}
    edges   = [float(e) for e in cal["quantile_edges"]]

    url_by_file: dict[str, dict] = {}
    if os.path.exists(args.manifest):
        with open(args.manifest, "r", encoding="utf-8") as fh:
            for e in json.load(fh):
                if e.get("file"):
                    url_by_file[e["file"]] = e

    out: list[dict] = []
    dist: Counter[int]   = Counter()
    review              = 0
    no_measurement      = 0

    for m in measurements:
        if m.get("l_star") is None:
            no_measurement += 1
            continue
        l_star     = float(m["l_star"])
        confidence = float(m.get("confidence", 0.0))
        if method == "anchor":
            tone = classify_anchor(l_star, anchors)
        else:
            tone = classify_quantile(l_star, edges)

        manifest = url_by_file.get(m.get("file") or "", {})

        manual = bool(confidence < CONFIDENCE_REVIEW)
        if manual:
            review += 1

        out.append({
            "firstName":         m["firstName"],
            "lastName":          m["lastName"],
            "skinTone":          tone,
            "confidence":        confidence,
            "l_star":            l_star,
            "headshotUrl":       manifest.get("url"),
            "file":              m.get("file"),
            "notes":             m.get("notes"),
            "calibrationMethod": method,
            "manualReview":      manual,
        })
        dist[tone] += 1

    out.sort(key=lambda r: (r["confidence"], r["lastName"], r["firstName"]))

    with open(args.out, "w", encoding="utf-8") as fh:
        json.dump(out, fh, indent=2)

    print("=" * 64)
    print(f"  Method            : {method}")
    print(f"  Anchors           : {anchors}")
    print(f"  Quantile edges    : {edges}")
    print(f"  Measurements      : {len(measurements)}")
    print(f"  Bucketed rookies  : {len(out)}")
    print(f"  No measurement    : {no_measurement}")
    print(f"  Flagged for review: {review}")
    print()
    print("  Tone distribution (rookies):")
    total = sum(dist.values()) or 1
    nfl_dist = {1: 0.17, 2: 0.18, 3: 0.02, 4: 0.06, 5: 0.07, 6: 0.12, 7: 0.36, 8: 0.02}
    for t in range(1, 9):
        rookie_pct = 100 * dist[t] / total
        nfl_pct    = 100 * nfl_dist[t]
        print(f"    {t}: {dist[t]:>3} ({rookie_pct:>5.1f}%)   NFL: {nfl_pct:>5.1f}%")

    print(f"\nWritten: {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
