"""
Script 9o — Extract per-photo skin-tone metric (Lab L*) from headshots.

Inputs : data/raw/headshots/*.png  (one PNG per rookie, from 9n)
         data/raw/headshot_manifest.json  (firstName/lastName ↔ file mapping)
Outputs: data/raw/skin_tone_measurements.json
         data/raw/headshots_debug/*.png  (overlay PNGs for first 20, optional)

Algorithm (per photo):
  1. MediaPipe Face Mesh — detect 468 landmarks.
  2. Build 3 skin polygons:
       Forehead: {10, 151, 108, 337}
       Left cheek:  {50, 205, 187}
       Right cheek: {280, 425, 411}
  3. For each polygon's pixels:
       - YCbCr skin filter: 77 <= Cb <= 127, 133 <= Cr <= 173 (Hsu et al.)
       - Drop highlights: Lab L* > 240
       - Median Lab L* over surviving pixels
  4. Final l_star = median across the 3 regions that produced valid samples.
  5. Confidence = (regions_with_samples / 3) * mean(per-region skin_ratio).

Output per photo:
  {
    firstName, lastName, file,
    l_star,                   # 0-255 in OpenCV's 8-bit Lab, lower = darker
    confidence,               # 0-1
    regions: {
      forehead: {l_star, skin_ratio},
      cheek_l:  {l_star, skin_ratio},
      cheek_r:  {l_star, skin_ratio},
    },
    notes  # "ok" | "no_face" | "no_skin"
  }

Run:
  python scripts/9o_extract_skin_tones.py
  python scripts/9o_extract_skin_tones.py --debug-overlays 20
  python scripts/9o_extract_skin_tones.py --photo-dir data/raw/headshots_calibration --out data/raw/vet_skin_measurements.json
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from typing import Optional

import urllib.request

import cv2
import numpy as np
import mediapipe as mp
from mediapipe.tasks.python import BaseOptions
from mediapipe.tasks.python.vision import (
    FaceLandmarker, FaceLandmarkerOptions, RunningMode,
)

SCRIPT_DIR   = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(SCRIPT_DIR)
DATA_DIR     = os.path.join(PROJECT_ROOT, "data")

DEFAULT_PHOTO_DIR = os.path.join(DATA_DIR, "raw", "headshots")
DEFAULT_MANIFEST  = os.path.join(DATA_DIR, "raw", "headshot_manifest.json")
DEFAULT_OUT       = os.path.join(DATA_DIR, "raw", "skin_tone_measurements.json")
DEFAULT_DEBUG_DIR = os.path.join(DATA_DIR, "raw", "headshots_debug")
DEFAULT_MODEL     = os.path.join(DATA_DIR, "raw", "face_landmarker.task")
MODEL_URL         = "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task"

# Landmark indices into MediaPipe Face Mesh's 468-point output.
# Picked to cover skin patches that are typically (a) unobstructed by helmets,
# (b) shadowless (no nose-shadow on cheek apex), (c) bare skin (no eyebrows).
FOREHEAD_IDX = [108, 10, 337, 151]   # quad: top-left, top, top-right, mid
CHEEK_L_IDX  = [50, 205, 187]        # left cheek triangle
CHEEK_R_IDX  = [280, 425, 411]       # right cheek triangle

# YCbCr skin range — Hsu et al. classic. Rejects helmet chrome, jersey,
# background, eye/eyebrow pixels that bleed into the sampled polygon.
YCC_CB_MIN, YCC_CB_MAX = 77, 127
YCC_CR_MIN, YCC_CR_MAX = 133, 173

# Lab L* highlight cap — drop overexposed pixels that inflate L* on fair skin.
LAB_L_HIGHLIGHT_CAP = 240


# ---------------------------------------------------------------------------
def sample_polygon(img_bgr: np.ndarray, points: list[tuple[int, int]]) -> tuple[Optional[float], float]:
    """Median Lab L* over skin-filtered pixels inside `points`.

    Returns (l_star_median, skin_ratio) where skin_ratio is the fraction of
    polygon pixels that survived the YCbCr skin gate and the L*<=240 cap.
    If the polygon has no surviving pixels, returns (None, 0.0).
    """
    h, w = img_bgr.shape[:2]
    mask = np.zeros((h, w), dtype=np.uint8)
    pts  = np.array(points, dtype=np.int32)
    cv2.fillPoly(mask, [pts], 255)
    rows, cols = np.where(mask > 0)
    if rows.size == 0:
        return None, 0.0

    bgr   = img_bgr[rows, cols]                   # (N, 3) BGR
    bgr_r = bgr.reshape(-1, 1, 3)
    ycc   = cv2.cvtColor(bgr_r, cv2.COLOR_BGR2YCrCb).reshape(-1, 3)
    lab   = cv2.cvtColor(bgr_r, cv2.COLOR_BGR2LAB ).reshape(-1, 3)

    cr, cb = ycc[:, 1], ycc[:, 2]
    l_chan = lab[:, 0]

    skin_gate = (cb >= YCC_CB_MIN) & (cb <= YCC_CB_MAX) \
              & (cr >= YCC_CR_MIN) & (cr <= YCC_CR_MAX) \
              & (l_chan <= LAB_L_HIGHLIGHT_CAP)
    if not np.any(skin_gate):
        return None, 0.0

    skin_ratio = float(np.sum(skin_gate) / skin_gate.size)
    median_l   = float(np.median(l_chan[skin_gate]))
    return median_l, skin_ratio


def measure(landmarker: FaceLandmarker, img_bgr: np.ndarray) -> dict:
    """Run face detection + region sampling on a single image."""
    rgb      = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2RGB)
    mp_image = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb)
    result   = landmarker.detect(mp_image)
    if not result.face_landmarks:
        return {"l_star": None, "confidence": 0.0, "regions": {}, "notes": "no_face"}

    h, w = img_bgr.shape[:2]
    landmarks = result.face_landmarks[0]   # list of NormalizedLandmark

    def coord(i: int) -> tuple[int, int]:
        return (int(landmarks[i].x * w), int(landmarks[i].y * h))

    regions = {
        "forehead": [coord(i) for i in FOREHEAD_IDX],
        "cheek_l":  [coord(i) for i in CHEEK_L_IDX ],
        "cheek_r":  [coord(i) for i in CHEEK_R_IDX ],
    }

    sampled: dict[str, dict] = {}
    l_stars: list[float] = []
    for name, pts in regions.items():
        l_star, ratio = sample_polygon(img_bgr, pts)
        sampled[name] = {"l_star": l_star, "skin_ratio": ratio, "polygon": pts}
        if l_star is not None and ratio > 0.3:
            l_stars.append(l_star)

    if not l_stars:
        return {"l_star": None, "confidence": 0.0, "regions": sampled, "notes": "no_skin"}

    final_l       = float(np.median(l_stars))
    region_count  = len(l_stars)
    mean_ratio    = float(np.mean([r["skin_ratio"] for r in sampled.values() if r["l_star"] is not None]))
    confidence    = min(1.0, region_count / 3.0) * mean_ratio
    return {"l_star": final_l, "confidence": confidence, "regions": sampled, "notes": "ok"}


def draw_overlay(img_bgr: np.ndarray, result: dict, label: str) -> np.ndarray:
    out = img_bgr.copy()
    palette = {"forehead": (0, 200, 255), "cheek_l": (50, 220, 50), "cheek_r": (255, 80, 80)}
    for name, info in result.get("regions", {}).items():
        poly = info.get("polygon")
        if not poly:
            continue
        cv2.polylines(out, [np.array(poly, np.int32)], True, palette.get(name, (200, 200, 200)), 2)
        cv2.putText(out, f"{name} L*={info.get('l_star', 0):.1f} sr={info.get('skin_ratio', 0):.2f}",
                    (poly[0][0], poly[0][1] - 6), cv2.FONT_HERSHEY_SIMPLEX, 0.4,
                    palette.get(name, (200, 200, 200)), 1)
    txt = f"{label}  L*={result.get('l_star')}  conf={result.get('confidence', 0):.2f}  {result.get('notes','')}"
    cv2.putText(out, txt, (8, out.shape[0] - 8), cv2.FONT_HERSHEY_SIMPLEX, 0.45, (0, 0, 0), 3)
    cv2.putText(out, txt, (8, out.shape[0] - 8), cv2.FONT_HERSHEY_SIMPLEX, 0.45, (255, 255, 255), 1)
    return out


# ---------------------------------------------------------------------------
def main() -> None:
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

    ap = argparse.ArgumentParser()
    ap.add_argument("--photo-dir",      default=DEFAULT_PHOTO_DIR)
    ap.add_argument("--manifest",       default=DEFAULT_MANIFEST,
                    help="Optional headshot manifest (for firstName/lastName mapping)")
    ap.add_argument("--out",            default=DEFAULT_OUT)
    ap.add_argument("--debug-overlays", type=int, default=20,
                    help="Write debug overlay PNGs for the first N images (0 = none)")
    ap.add_argument("--debug-dir",      default=DEFAULT_DEBUG_DIR)
    args = ap.parse_args()

    print("=" * 64)
    print("Script 9o — extract skin-tone metric")
    print("=" * 64)
    print(f"  Photo dir : {args.photo_dir}")
    print(f"  Manifest  : {args.manifest}")
    print(f"  Output    : {args.out}")
    print(f"  Overlays  : {args.debug_overlays} → {args.debug_dir}")

    # Load manifest to map file → (firstName, lastName); fall back to filename.
    name_by_file: dict[str, dict] = {}
    if os.path.exists(args.manifest):
        with open(args.manifest, "r", encoding="utf-8") as fh:
            for entry in json.load(fh):
                if entry.get("file"):
                    name_by_file[entry["file"]] = entry
        print(f"  Manifest entries: {len(name_by_file)}")
    else:
        print("  Manifest not found — using filenames as names")

    files = sorted(f for f in os.listdir(args.photo_dir) if f.lower().endswith(".png"))
    print(f"  Photo files     : {len(files)}")

    if args.debug_overlays > 0:
        os.makedirs(args.debug_dir, exist_ok=True)

    if not os.path.exists(DEFAULT_MODEL):
        print(f"\n  Downloading face_landmarker.task …")
        os.makedirs(os.path.dirname(DEFAULT_MODEL), exist_ok=True)
        urllib.request.urlretrieve(MODEL_URL, DEFAULT_MODEL)
        print(f"  Saved {os.path.getsize(DEFAULT_MODEL):,} bytes")

    options = FaceLandmarkerOptions(
        base_options=BaseOptions(model_asset_path=DEFAULT_MODEL),
        running_mode=RunningMode.IMAGE,
        num_faces=1,
        min_face_detection_confidence=0.3,
    )
    landmarker = FaceLandmarker.create_from_options(options)

    results: list[dict] = []
    note_counts = {"ok": 0, "no_face": 0, "no_skin": 0}
    overlays_written = 0

    for i, fname in enumerate(files, 1):
        fpath = os.path.join(args.photo_dir, fname)
        img   = cv2.imread(fpath)
        if img is None:
            print(f"  [{i:3d}/{len(files)}] {fname}: read failed")
            continue

        manifest_entry = name_by_file.get(fname, {})
        first = manifest_entry.get("firstName") or fname.split("_")[0]
        last  = manifest_entry.get("lastName")  or fname.split("_", 1)[1].rsplit(".", 1)[0] if "_" in fname else ""

        r = measure(landmarker, img)
        note_counts[r["notes"]] = note_counts.get(r["notes"], 0) + 1
        l_str = f"{r['l_star']:.1f}" if r["l_star"] is not None else "----"
        print(f"  [{i:3d}/{len(files)}] {first} {last:<22} L*={l_str:>6}  conf={r['confidence']:.2f}  {r['notes']}")

        # Strip polygon arrays before serializing (debug-only data)
        regions_out = {name: {k: v for k, v in info.items() if k != "polygon"}
                       for name, info in r.get("regions", {}).items()}

        results.append({
            "firstName":  first,
            "lastName":   last,
            "file":       fname,
            "l_star":     r["l_star"],
            "confidence": r["confidence"],
            "regions":    regions_out,
            "notes":      r["notes"],
        })

        if overlays_written < args.debug_overlays:
            overlay = draw_overlay(img, r, f"{first} {last}")
            cv2.imwrite(os.path.join(args.debug_dir, fname), overlay)
            overlays_written += 1

    landmarker.close()

    with open(args.out, "w", encoding="utf-8") as fh:
        json.dump(results, fh, indent=2)

    print()
    print("=" * 64)
    print(f"  Total processed : {len(results)}")
    print(f"  OK              : {note_counts.get('ok', 0)}")
    print(f"  No face         : {note_counts.get('no_face', 0)}")
    print(f"  No skin         : {note_counts.get('no_skin', 0)}")
    print(f"  Debug overlays  : {overlays_written}")
    ok_l_stars = [r['l_star'] for r in results if r['l_star'] is not None]
    if ok_l_stars:
        print(f"  L* distribution : min={min(ok_l_stars):.1f}  median={np.median(ok_l_stars):.1f}  max={max(ok_l_stars):.1f}")
    print(f"\nWritten: {args.out}")


if __name__ == "__main__":
    sys.exit(main() or 0)
