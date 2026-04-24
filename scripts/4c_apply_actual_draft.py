"""
Script 4c — Stamp actual 2026 NFL Draft results onto prospects_2026.json.

Reads prospects_2026.json, matches by name against ACTUAL_PICKS below, and
adds `actual_draft_pick` and `actual_draft_round` fields to matched prospects.
This lets script 5's tier-anchor use the true draft slot instead of our
projected rank.

Source: Wikipedia "2026 NFL draft" as of April 24, 2026 (end of Round 1).
Update this file as later rounds finalize.

Usage:
    python scripts/4c_apply_actual_draft.py
"""

import json
import os
import re
import sys

SCRIPT_DIR   = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(SCRIPT_DIR)
DATA_DIR     = os.path.join(PROJECT_ROOT, "data")
INPUT_FILE   = os.path.join(DATA_DIR, "prospects_2026.json")

# ── Actual 2026 NFL Draft picks (Round 1 — Pittsburgh, April 23 2026) ───────
# Keys are name variants that might appear in our prospects list.
# Values are (draft_pick, draft_round).
ACTUAL_PICKS: dict[str, tuple[int, int]] = {
    "fernando mendoza":       (1,  1),
    "david bailey":           (2,  1),
    "jeremiyah love":         (3,  1),
    "carnell tate":           (4,  1),
    "arvell reese":           (5,  1),
    "mansoor delane":         (6,  1),
    "sonny styles":           (7,  1),
    "jordyn tyson":           (8,  1),
    "spencer fano":           (9,  1),
    "francis mauigoa":        (10, 1),
    "caleb downs":            (11, 1),
    "kadyn proctor":          (12, 1),
    "ty simpson":             (13, 1),
    "olaivavega ioane":       (14, 1),   # Wikipedia lists him as "Vega Ioane"
    "rueben bain":            (15, 1),   # handles "Rueben Bain Jr."
    "kenyon sadiq":           (16, 1),
    "blake miller":           (17, 1),
    "caleb banks":            (18, 1),
    "monroe freeling":        (19, 1),
    "makai lemon":            (20, 1),
    "max iheanachor":         (21, 1),
    "malachi lawrence":       (23, 1),
    "kc concepcion":          (24, 1),
    "dillon thieneman":       (25, 1),
    "chris johnson":          (27, 1),
    "peter woods":            (29, 1),
    "omar cooper":            (30, 1),   # handles "Omar Cooper Jr."
    "keldric faulk":          (31, 1),
    "jadarian price":         (32, 1),
}


def norm_name(name: str) -> str:
    """Lowercase, strip Jr./Sr./III suffixes and punctuation for matching."""
    n = (name or "").lower().strip()
    n = re.sub(r"\s+(ii|iii|iv|v|jr|sr)\.?$", "", n)
    n = re.sub(r"[^a-z ]", "", n).strip()
    return n


def main() -> None:
    with open(INPUT_FILE, "r", encoding="utf-8") as fh:
        prospects = json.load(fh)

    matched = 0
    for p in prospects:
        key = norm_name(p.get("name", ""))
        pick = ACTUAL_PICKS.get(key)
        if pick is None:
            # Try last-name + first-name reverse lookup for edge cases
            for ap_key in ACTUAL_PICKS:
                if ap_key in key or key in ap_key:
                    pick = ACTUAL_PICKS[ap_key]
                    break
        if pick is not None:
            p["actual_draft_pick"]  = pick[0]
            p["actual_draft_round"] = pick[1]
            matched += 1

    with open(INPUT_FILE, "w", encoding="utf-8") as fh:
        json.dump(prospects, fh, indent=2)

    print(f"  Stamped actual draft picks onto {matched} prospects "
          f"(of {len(ACTUAL_PICKS)} known picks).")

    # Report any known picks we couldn't map
    keys_in_file = {norm_name(p.get("name","")) for p in prospects}
    missing = [k for k in ACTUAL_PICKS if k not in keys_in_file
               and not any(k in pk or pk in k for pk in keys_in_file)]
    if missing:
        print(f"  WARN: {len(missing)} actual picks not found in prospects_2026.json:")
        for k in missing:
            print(f"    - {k}  (pick #{ACTUAL_PICKS[k][0]})")


if __name__ == "__main__":
    main()
