"""
Audit per-position calibration pool sizes — used to design the neighbor-sampler
fallback strategy.  Reports:
  1. raw calibration[pos] entry count for every position the prospects file uses
  2. expanded count after applying POSITION_FALLBACKS
  3. expanded count after vet mix-in (filtered to YearsPro<=2 and OVR 58..72)
  4. flag positions with final pool < 5 — those are sparsity risks for k-NN.
"""
import json
import os
import sys
from collections import Counter

SCRIPT_DIR   = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(SCRIPT_DIR)
sys.path.insert(0, PROJECT_ROOT)

# Reuse the canonical fallbacks from script 5
from utils.enums import POSITION_TO_ENUM

# Mirror the POSITION_FALLBACKS map in script 5_generate_ratings.py
# (not exported as a module yet; keep in sync if it changes).
POSITION_FALLBACKS = {
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

VET_FALLBACK_POSITIONS = {"FB", "P", "LS", "K"}
VET_OVR_MIN, VET_OVR_MAX = 58, 72
VET_YEARS_PRO_MAX = 2


def main() -> None:
    cal_path = os.path.join(PROJECT_ROOT, "data", "calibration_set.json")
    pros_path = os.path.join(PROJECT_ROOT, "data", "prospects_2026.json")
    vet_path  = os.path.join(PROJECT_ROOT, "data", "roster_players_rated.json")

    calibration = json.load(open(cal_path, encoding="utf-8"))
    prospects   = json.load(open(pros_path, encoding="utf-8"))
    vets        = json.load(open(vet_path, encoding="utf-8"))

    # Positions used in our prospect class
    positions = sorted(set(p.get("pos", "") for p in prospects if p.get("pos")))

    # Vet pool by canonical position (filtered)
    vets_by_pos: dict[str, int] = Counter()
    for v in vets:
        ratings = v.get("ratings") or {}
        ovr = ratings.get("overall") or 0
        yrs = v.get("yearsPro") if "yearsPro" in v else v.get("YearsPro", 99)
        if not isinstance(yrs, (int, float)):
            yrs = 99
        if not (VET_OVR_MIN <= ovr <= VET_OVR_MAX):
            continue
        if yrs > VET_YEARS_PRO_MAX:
            continue
        pos = v.get("pos") or v.get("position") or ""
        if pos:
            vets_by_pos[pos] += 1

    print(f"{'pos':<5} {'cal':>5} {'+fbk':>5} {'+vet':>5} {'final':>6}  fallbacks         risk")
    print("-" * 70)
    for pos in positions:
        raw = len(calibration.get(pos, []))
        fbk_total = raw
        fbk_chain = []
        for fb in POSITION_FALLBACKS.get(pos, []):
            n = len(calibration.get(fb, []))
            if n > 0:
                fbk_total += n
                fbk_chain.append(f"{fb}={n}")
        vet_n = vets_by_pos.get(pos, 0) if pos in VET_FALLBACK_POSITIONS else 0
        final = fbk_total + vet_n
        risk = "OK"
        if final < 5:
            risk = "*** SPARSE"
        elif final < 8:
            risk = "thin"
        chain_str = ",".join(fbk_chain) if fbk_chain else "-"
        vet_str = f"+{vet_n}" if vet_n else "-"
        print(f"{pos:<5} {raw:>5} {fbk_total:>5} {vet_str:>5} {final:>6}  {chain_str:<18} {risk}")

    print("\nVet pool counts by raw position label (OVR 58-72, YearsPro <= 2):")
    for pos, n in sorted(vets_by_pos.items()):
        print(f"  {pos:<5} {n}")


if __name__ == "__main__":
    main()
