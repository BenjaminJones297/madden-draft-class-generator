"""
Per-prospect: did apply_profile_corrections actually change ANY attribute?
Reports the % of drafted prospects whose ratings were touched by profile bumps,
broken down by position.
"""
import json, os, sys, importlib.util
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

spec = importlib.util.spec_from_file_location("s5", "scripts/5_generate_ratings.py")
s5 = importlib.util.module_from_spec(spec); spec.loader.exec_module(s5)

prospects = json.load(open("data/prospects_2026.json", encoding="utf-8"))
calibration = json.load(open("data/calibration_set.json", encoding="utf-8"))

from utils.enums import POSITION_KEY_FIELDS, ALL_RATING_FIELDS
from collections import defaultdict, Counter

# Track per-position: how many prospects had profile/combine bumps?
counts = defaultdict(lambda: {"total": 0, "profile_fired": 0, "combine_fired": 0,
                              "profile_total_bumps": 0, "combine_total_bumps": 0})

for p in prospects:
    if not p.get("actual_draft_pick"): continue
    pos = p["pos"]; counts[pos]["total"] += 1
    canon = s5.canonical_pos(pos)
    key = set(POSITION_KEY_FIELDS.get(canon, [])) | {"overall", "devTrait"}
    baseline = s5.sample_baseline_ratings(p, calibration, ALL_RATING_FIELDS, key_fields=key)
    cleaned, _ = s5.validate_ratings(baseline, canon)
    cleaned = s5.apply_position_corrections(cleaned, pos, p.get("forty"))
    before_profile = dict(cleaned)
    after_profile  = s5.apply_profile_corrections(dict(cleaned), pos, p.get("notes"))
    profile_bumps = sum(1 for f in after_profile if before_profile.get(f) != after_profile.get(f))
    if profile_bumps > 0:
        counts[pos]["profile_fired"] += 1
        counts[pos]["profile_total_bumps"] += profile_bumps

    before_combine = dict(after_profile)
    after_combine = s5.apply_combine_corrections(
        dict(after_profile), pos,
        bench=p.get("bench"), vertical=p.get("vertical"),
        cone=p.get("cone"), shuttle=p.get("shuttle"), ten_split=p.get("ten_split"))
    combine_bumps = sum(1 for f in after_combine if before_combine.get(f) != after_combine.get(f))
    if combine_bumps > 0:
        counts[pos]["combine_fired"] += 1
        counts[pos]["combine_total_bumps"] += combine_bumps

print(f"\nDraft-class profile + combine bump coverage (drafted only)")
print(f"{'pos':<5} {'n':>4} {'%prof_fires':>12} {'avg_prof_bumps':>15} {'%comb_fires':>12} {'avg_comb_bumps':>15}")
print("-"*70)
total = 0; prof_fired = 0; comb_fired = 0
for pos in sorted(counts):
    c = counts[pos]; total += c["total"]; prof_fired += c["profile_fired"]; comb_fired += c["combine_fired"]
    pct_prof = 100 * c["profile_fired"] / c["total"]
    pct_comb = 100 * c["combine_fired"] / c["total"]
    avg_prof = c["profile_total_bumps"] / max(1, c["profile_fired"])
    avg_comb = c["combine_total_bumps"] / max(1, c["combine_fired"])
    print(f"{pos:<5} {c['total']:>4} {pct_prof:>11.0f}% {avg_prof:>15.1f} {pct_comb:>11.0f}% {avg_comb:>15.1f}")
print("-"*70)
print(f"{'ALL':<5} {total:>4} {100*prof_fired/total:>11.0f}% {'':<15} {100*comb_fired/total:>11.0f}%")

# How many prospects have measurables?
print(f"\nMeasurable presence (drafted):")
for f in ("forty","bench","vertical","broad_jump","cone","shuttle"):
    n = sum(1 for p in prospects if p.get("actual_draft_pick") and p.get(f))
    print(f"  {f:<12} {n}/{total}  ({100*n/total:.0f}%)")
