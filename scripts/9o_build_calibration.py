"""
Script 9o_build_calibration — Fit L* → skinTone (1-8) calibration on vet truth.

Inputs:
  data/calibration_vets.json         (firstName, lastName, trueSkinTone, ...)
  data/raw/vet_skin_measurements.json (firstName, lastName, l_star, ...)

Output:
  data/skin_tone_calibration.json:
    {
      method: "anchor" | "quantile_nfl",
      anchors:        { "1": <mean L*>, "2": ..., ... },     # per-tone mean
      quantile_edges: [e1, e2, ..., e7],                     # 7 thresholds
                                                              # tone 1 = L* >= e1,
                                                              # tone 8 = L* < e7
      agreement: { anchor: <0-1>, quantile_nfl: <0-1> },     # of N vets
      raw_pairs: [ {name, trueSkinTone, l_star}, ... ],      # debug
    }

NFL vet skinTone distribution (from project sample of 2592 vets):
  tone 1: 17%, 2: 18%, 3: 2%, 4: 6%, 5: 7%, 6: 12%, 7: 36%, 8: 2%

Run:
  python scripts/9o_build_calibration.py
"""

from __future__ import annotations

import argparse
import json
import os
import sys

import numpy as np

SCRIPT_DIR   = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(SCRIPT_DIR)
DATA_DIR     = os.path.join(PROJECT_ROOT, "data")

DEFAULT_VETS         = os.path.join(DATA_DIR, "calibration_vets.json")
DEFAULT_MEASUREMENTS = os.path.join(DATA_DIR, "raw", "vet_skin_measurements.json")
DEFAULT_OUT          = os.path.join(DATA_DIR, "skin_tone_calibration.json")

# Empirical NFL vet skinTone distribution (cumulative fractions, lightest first).
# Tones 1..8 = 17/18/2/6/7/12/36/2 %. Edges are between successive buckets,
# computed left-to-right as cumulative fractions. We invert L* (higher L* = lighter
# = lower tone), so the lowest tone (1, lightest) uses the HIGHEST L* range and
# the highest tone (8) uses the LOWEST L*.
NFL_BUCKET_FRACTIONS = [0.17, 0.18, 0.02, 0.06, 0.07, 0.12, 0.36, 0.02]


def norm_name(s: str) -> str:
    return "".join(c for c in (s or "").lower() if c.isalnum())


def main() -> int:
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

    ap = argparse.ArgumentParser()
    ap.add_argument("--vets",         default=DEFAULT_VETS)
    ap.add_argument("--measurements", default=DEFAULT_MEASUREMENTS)
    ap.add_argument("--out",          default=DEFAULT_OUT)
    args = ap.parse_args()

    with open(args.vets, "r", encoding="utf-8") as fh:
        vets = json.load(fh)
    with open(args.measurements, "r", encoding="utf-8") as fh:
        measurements = json.load(fh)

    # Join by normalized name
    meas_by_name = {}
    for m in measurements:
        if m.get("l_star") is None:
            continue
        meas_by_name[norm_name(m["firstName"] + m["lastName"])] = m

    pairs: list[dict] = []
    missing = 0
    for v in vets:
        key = norm_name(v["firstName"] + v["lastName"])
        m   = meas_by_name.get(key)
        if not m:
            missing += 1
            continue
        pairs.append({
            "name":          f"{v['firstName']} {v['lastName']}",
            "trueSkinTone":  int(v["trueSkinTone"]),
            "l_star":        float(m["l_star"]),
            "confidence":    float(m.get("confidence", 0.0)),
            "position":      v.get("position", ""),
        })

    print(f"  Vet truth records       : {len(vets)}")
    print(f"  Measurements joined     : {len(pairs)}")
    print(f"  Missing measurements    : {missing}")

    if not pairs:
        print("ERROR: no joined pairs.")
        return 1

    # Per-tone mean L*  (anchors)
    by_tone: dict[int, list[float]] = {}
    for p in pairs:
        by_tone.setdefault(p["trueSkinTone"], []).append(p["l_star"])

    print("\n  Per-tone L* stats (truth → measured):")
    print(f"    {'tone':>4} {'n':>3} {'min':>6} {'mean':>6} {'median':>6} {'max':>6}")
    anchors: dict[int, float] = {}
    for tone in sorted(by_tone):
        vals = by_tone[tone]
        anchors[tone] = float(np.mean(vals))
        print(f"    {tone:>4} {len(vals):>3} {min(vals):>6.1f} {np.mean(vals):>6.1f} {np.median(vals):>6.1f} {max(vals):>6.1f}")

    # ── Anchor-based classifier ────────────────────────────────────────────
    sorted_tones = sorted(anchors.keys())
    def classify_anchor(l_star: float) -> int:
        return min(sorted_tones, key=lambda t: abs(l_star - anchors[t]))

    # ── Quantile-NFL classifier ────────────────────────────────────────────
    # Sort all measurements descending by L* (lightest first); cut at NFL bucket
    # fractions. Edges are the L* at each cut point.
    all_l = sorted((p["l_star"] for p in pairs), reverse=True)
    n     = len(all_l)
    cuts: list[float] = []
    cum = 0.0
    for frac in NFL_BUCKET_FRACTIONS[:-1]:
        cum += frac
        idx = max(0, min(n - 1, int(round(cum * n))))
        cuts.append(all_l[idx])
    # cuts has 7 values: index of boundary from lightest to darkest

    def classify_quantile(l_star: float) -> int:
        for i, edge in enumerate(cuts):
            if l_star >= edge:
                return i + 1   # tone 1 = lightest
        return 8

    # ── Agreement on calibration set ───────────────────────────────────────
    anchor_correct   = sum(1 for p in pairs if classify_anchor(p["l_star"])   == p["trueSkinTone"])
    quantile_correct = sum(1 for p in pairs if classify_quantile(p["l_star"]) == p["trueSkinTone"])

    # Off-by-one metric (cosmetic mismatch is usually fine ±1)
    anchor_off1   = sum(1 for p in pairs if abs(classify_anchor(p["l_star"])   - p["trueSkinTone"]) <= 1)
    quantile_off1 = sum(1 for p in pairs if abs(classify_quantile(p["l_star"]) - p["trueSkinTone"]) <= 1)

    print(f"\n  Classifier agreement (n={len(pairs)}):")
    print(f"    Anchor:       {anchor_correct:>3}/{len(pairs)} exact ({100*anchor_correct/len(pairs):.0f}%) | "
          f"{anchor_off1}/{len(pairs)} within ±1 ({100*anchor_off1/len(pairs):.0f}%)")
    print(f"    Quantile-NFL: {quantile_correct:>3}/{len(pairs)} exact ({100*quantile_correct/len(pairs):.0f}%) | "
          f"{quantile_off1}/{len(pairs)} within ±1 ({100*quantile_off1/len(pairs):.0f}%)")

    # Anchor monotonicity check
    anchor_vals = [anchors[t] for t in sorted_tones]
    monotonic = all(anchor_vals[i] >= anchor_vals[i+1] for i in range(len(anchor_vals)-1))
    print(f"\n  Anchor monotonic (lightest tone = highest L*): {monotonic}")

    # Pick the method that's better at exact (with off-by-one as tiebreaker)
    method = "anchor" if anchor_correct >= quantile_correct else "quantile_nfl"
    if anchor_correct == quantile_correct:
        method = "anchor" if anchor_off1 >= quantile_off1 else "quantile_nfl"
    print(f"\n  Recommended method: {method}")

    out = {
        "method":         method,
        "anchors":        {str(t): float(v) for t, v in anchors.items()},
        "quantile_edges": cuts,
        "agreement": {
            "anchor": {
                "exact": anchor_correct, "off1": anchor_off1, "n": len(pairs),
            },
            "quantile_nfl": {
                "exact": quantile_correct, "off1": quantile_off1, "n": len(pairs),
            },
        },
        "raw_pairs": pairs,
    }

    with open(args.out, "w", encoding="utf-8") as fh:
        json.dump(out, fh, indent=2)
    print(f"\nWritten: {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
