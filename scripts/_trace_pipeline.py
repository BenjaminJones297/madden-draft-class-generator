"""
Trace a prospect's ratings through every post-processing step.
Shows whether profile bumps + combine corrections are actually firing or
being washed out by other layers.
"""
import json, sys, os, importlib.util

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, PROJECT_ROOT)

spec = importlib.util.spec_from_file_location("s5", "scripts/5_generate_ratings.py")
s5 = importlib.util.module_from_spec(spec); spec.loader.exec_module(s5)

prospects   = json.load(open("data/prospects_2026.json", encoding="utf-8"))
calibration = json.load(open("data/calibration_set.json", encoding="utf-8"))
profiles    = json.load(open("data/prospect_profiles.json", encoding="utf-8"))
from utils.enums import POSITION_KEY_FIELDS, ALL_RATING_FIELDS

TARGETS = ["Julian Neal", "Chase Bisontis", "Carson Beck",
           "Jeremiyah Love", "Carnell Tate", "Mansoor Delane"]

def diff(d1, d2, fields):
    return {f: (d1.get(f), d2.get(f)) for f in fields if d1.get(f) != d2.get(f)}

for p in prospects:
    name = f"{p.get('firstName','')} {p.get('lastName','')}"
    if name not in TARGETS: continue
    pos = p["pos"]
    canon = s5.canonical_pos(pos)
    key_fields = POSITION_KEY_FIELDS.get(canon, POSITION_KEY_FIELDS["QB"])

    print(f"\n{'='*70}")
    print(f"  {name} ({pos})  pick={p.get('actual_draft_pick','UDFA')}")
    print(f"  forty={p.get('forty')}  bench={p.get('bench')}  vert={p.get('vertical')}  cone={p.get('cone')}  shuttle={p.get('shuttle')}")
    print(f"  has scouting profile: {bool(p.get('notes'))}  ({len(p.get('notes') or '')} chars)")
    print(f"{'='*70}")

    # 1. Sample baseline (centroid)
    canon_key_fields = set(key_fields) | {"overall", "devTrait"}
    baseline = s5.sample_baseline_ratings(p, calibration, ALL_RATING_FIELDS, key_fields=canon_key_fields)

    # Track each step
    steps = [("baseline (centroid)", dict(baseline))]
    cleaned, _ = s5.validate_ratings(baseline, canon)
    steps.append(("validate", dict(cleaned)))
    cleaned = s5.apply_position_corrections(cleaned, pos, p.get("forty"))
    steps.append(("apply_position_corrections", dict(cleaned)))
    cleaned = s5.apply_profile_corrections(cleaned, pos, p.get("notes"))
    steps.append(("apply_profile_corrections", dict(cleaned)))
    cleaned = s5.apply_position_overshoot_dampener(cleaned, pos)
    steps.append(("apply_position_overshoot_dampener", dict(cleaned)))
    cleaned = s5.apply_dev_trait_by_pick(cleaned, p.get("actual_draft_pick"))
    steps.append(("apply_dev_trait_by_pick", dict(cleaned)))
    cleaned = s5.apply_combine_corrections(
        cleaned, pos,
        bench=p.get("bench"), vertical=p.get("vertical"),
        cone=p.get("cone"), shuttle=p.get("shuttle"),
        ten_split=p.get("ten_split"))
    steps.append(("apply_combine_corrections", dict(cleaned)))

    # Show key field values across each step
    show_fields = [f for f in key_fields if f != "overall" and f != "devTrait"][:10]
    print(f"  Key fields evolution:")
    print(f"    {'step':<36}  " + "  ".join(f"{f[:8]:>8}" for f in show_fields))
    for label, ratings in steps:
        vals = [str(ratings.get(f, '-')) for f in show_fields]
        print(f"    {label:<36}  " + "  ".join(f"{v:>8}" for v in vals))

    # Show diffs across steps that DID change anything
    print(f"\n  Step-to-step diffs (any field that changed):")
    for i in range(1, len(steps)):
        prev_label, prev_r = steps[i-1]
        cur_label, cur_r = steps[i]
        changed = {f: (prev_r.get(f), cur_r.get(f)) for f in cur_r if prev_r.get(f) != cur_r.get(f)}
        if changed:
            print(f"    [{cur_label}]:")
            for f in sorted(changed):
                a, b = changed[f]
                print(f"      {f:<24}  {a} -> {b}")
        else:
            print(f"    [{cur_label}]: no changes")
