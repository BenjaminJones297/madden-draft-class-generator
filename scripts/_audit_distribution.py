"""
Audit rookie OVR distribution: 2026 (current rated) vs 2025 (calibration ground truth).

Reports:
  1. Per-round OVR distribution (mean, median, max, percentiles)
  2. Per-position OVR distribution comparing both sets
  3. Top-N OVR distribution
  4. Where we're high or low and by how much

Both classes are real 2026 NFL rookies vs. real 2025 NFL rookies WITH their
ACTUAL Madden 26 launch ratings.  This is the cleanest apples-to-apples
calibration possible.
"""
import json
import statistics
from collections import defaultdict


def round_for_pick(p: int) -> int:
    """Convert overall pick number to round (handle compensatory variance)."""
    if not p: return 0
    if p <= 32:  return 1
    if p <= 64:  return 2
    if p <= 100: return 3
    if p <= 138: return 4
    if p <= 180: return 5
    if p <= 220: return 6
    return 7


def main() -> None:
    new = json.load(open("data/prospects_rated.json", encoding="utf-8"))
    cal = json.load(open("data/calibration_set.json", encoding="utf-8"))

    # Flatten 2025 calibration into a single list with overall pick computed.
    cal_flat = []
    for pos, entries in cal.items():
        for e in entries:
            prof = e.get("profile") or {}
            ratings = e.get("ratings") or {}
            ovr = ratings.get("overall")
            if not ovr: continue
            rnd = prof.get("draft_round")
            pk_in_rnd = prof.get("draft_pick")
            overall_pick = ((rnd or 0) - 1) * 32 + (pk_in_rnd or 0) if rnd and pk_in_rnd else None
            cal_flat.append({"pos": pos, "ovr": ovr, "round": rnd, "pick": overall_pick})

    new_flat = []
    for p in new:
        r = p.get("ratings") or {}
        ovr = r.get("overall")
        pk  = p.get("actual_draft_pick")
        if not ovr: continue
        new_flat.append({
            "pos": p.get("pos"),
            "ovr": ovr,
            "round": p.get("actual_draft_round") or (round_for_pick(pk) if pk else None),
            "pick": pk,
            "name": f"{p.get('firstName','')} {p.get('lastName','')}".strip(),
        })

    # Drafted only (compare rookie classes that actually got drafted)
    new_drafted = [x for x in new_flat if x["round"]]
    cal_drafted = [x for x in cal_flat if x["round"]]

    print(f"Counts: 2026 drafted={len(new_drafted)}  2025 drafted={len(cal_drafted)}")

    # ── 1. Per-round OVR distribution ────────────────────────────────────────
    print("\n=== Per-round OVR distribution ===")
    print(f"{'rnd':<4} {'2025_n':>6} {'25_med':>6} {'25_mean':>7} {'25_max':>6}    {'2026_n':>6} {'26_med':>6} {'26_mean':>7} {'26_max':>6}    {'mean_delta':>10}")
    for rnd in range(1, 8):
        cal_r = [x["ovr"] for x in cal_drafted if x["round"] == rnd]
        new_r = [x["ovr"] for x in new_drafted if x["round"] == rnd]
        if not cal_r or not new_r:
            continue
        cm = statistics.mean(cal_r); nm = statistics.mean(new_r)
        delta = nm - cm
        print(f"{rnd:<4} {len(cal_r):>6} {statistics.median(cal_r):>6.0f} {cm:>7.1f} {max(cal_r):>6}    "
              f"{len(new_r):>6} {statistics.median(new_r):>6.0f} {nm:>7.1f} {max(new_r):>6}    {delta:>+10.2f}")

    # ── 2. Per-position OVR (drafted) ────────────────────────────────────────
    print("\n=== Per-position OVR distribution (drafted only) ===")
    cal_by_pos = defaultdict(list); new_by_pos = defaultdict(list)
    for x in cal_drafted: cal_by_pos[x["pos"]].append(x["ovr"])
    for x in new_drafted: new_by_pos[x["pos"]].append(x["ovr"])

    print(f"{'pos':<5} {'2025_n':>6} {'25_med':>6} {'25_mean':>7}   {'2026_n':>6} {'26_med':>6} {'26_mean':>7}   {'delta':>7}")
    for pos in sorted(set(list(cal_by_pos.keys()) + list(new_by_pos.keys()))):
        cv = cal_by_pos.get(pos, [])
        nv = new_by_pos.get(pos, [])
        if not cv or not nv: continue
        cm = statistics.mean(cv); nm = statistics.mean(nv)
        delta = nm - cm
        marker = ""
        if abs(delta) >= 3: marker = " ***" if delta > 0 else " ---"
        elif abs(delta) >= 2: marker = "  *" if delta > 0 else "  -"
        print(f"{pos:<5} {len(cv):>6} {statistics.median(cv):>6.0f} {cm:>7.1f}   "
              f"{len(nv):>6} {statistics.median(nv):>6.0f} {nm:>7.1f}   {delta:>+7.2f}{marker}")

    # ── 3. Top-N comparison ──────────────────────────────────────────────────
    print("\n=== Top-N OVR comparison ===")
    cal_sorted = sorted([x["ovr"] for x in cal_drafted], reverse=True)
    new_sorted = sorted([x["ovr"] for x in new_drafted], reverse=True)
    for n in (1, 5, 10, 32, 64, 100):
        cv = cal_sorted[:n]; nv = new_sorted[:n]
        cm = statistics.mean(cv) if cv else 0
        nm = statistics.mean(nv) if nv else 0
        print(f"  top-{n:<3}  2025 mean={cm:>5.1f}  2026 mean={nm:>5.1f}  delta={nm-cm:>+5.2f}")

    # ── 4. Top-10 actual list comparison ─────────────────────────────────────
    print("\n=== Top 10 by OVR ===")
    new_top = sorted(new_drafted, key=lambda x: -x["ovr"])[:10]
    cal_top_lookup = {(e.get("pos"), e.get("ratings",{}).get("overall")): e.get("profile",{}).get("name","")
                      for pos, lst in cal.items() for e in lst}
    print(f"{'2026':<60}  {'2025':<40}")
    cal_sorted2 = []
    for pos, lst in cal.items():
        for e in lst:
            r = e.get("ratings") or {}
            p = e.get("profile") or {}
            if r.get("overall") and p.get("name"):
                cal_sorted2.append((p["name"], pos, r["overall"], p.get("draft_round"), p.get("draft_pick")))
    cal_sorted2.sort(key=lambda x: -x[2])
    for i in range(10):
        n_str = ""
        if i < len(new_top):
            x = new_top[i]
            n_str = f"{x['name']:<24} {x['pos']:<3} OVR {x['ovr']} R{x.get('round','-')}#{x.get('pick','-')}"
        c_str = ""
        if i < len(cal_sorted2):
            nm, ps, ov, rd, pk = cal_sorted2[i]
            c_str = f"{nm[:22]:<22} {ps:<3} OVR {ov} R{rd}#{pk}"
        print(f"  {n_str:<60}  {c_str}")


if __name__ == "__main__":
    main()
