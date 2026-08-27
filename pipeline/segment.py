#!/usr/bin/env python3
"""
Offline SAM-family segmentation pipeline for Tessera pixel collections.

Runs an automatic mask generator over an image and emits the two-file
contract documented in ../src/data/pixels.ts:

    <image>.segments.png   colour-indexed mask, id = (r<<16)|(g<<8)|b, id 0 = unsegmented
    <image>.segments.json  {"segments": [{id, label, area, bbox, centroid, meanColor}, ...]}

See README.md in this directory for model choice, runtime, and how to add
a new image. Usage:

    uv run segment.py <image-path> --out-dir ../public/data
"""

from __future__ import annotations

import argparse
import os
import sys
import time
from pathlib import Path

# Keep ultralytics' own config/telemetry state inside this project instead of
# ~/.config — self-contained, and .gitignore'd alongside the model weights.
PIPELINE_DIR = Path(__file__).resolve().parent
os.environ.setdefault("YOLO_CONFIG_DIR", str(PIPELINE_DIR / ".cache" / "ultralytics"))

import numpy as np
from PIL import Image

# NMS threshold for FastSAM's own box proposals, ahead of our own mask-level
# dedup below. 0.7 keeps close-but-distinct specimens as separate proposals.
FASTSAM_IOU = 0.7
FASTSAM_CONF = 0.3
FASTSAM_IMGSZ = 1024

# Two raw masks are the same object detected twice (dedup) if their IoU
# clears this, OR if the smaller is almost entirely inside the larger.
DEDUP_IOU_THRESH = 0.5
DEDUP_CONTAIN_THRESH = 0.8
# IoU/containment above is computed on a downsampled copy of the masks
# (every STRIDE-th pixel) — exact overlap fraction isn't needed to decide
# "same object", and this keeps the O(kept^2) dedup pass under a second.
DEDUP_STRIDE = 4

# Default min-area as a fraction of total image pixels, used when --min-area
# is not given. Small enough to keep genuinely small specimens (a moth a
# tenth the size of the plate's largest butterfly), large enough to drop
# printed-caption glyphs and single-pixel noise.
DEFAULT_MIN_AREA_FRAC = 0.0006


def log(msg: str) -> None:
    print(msg, flush=True)


def load_fastsam():
    """Import ultralytics lazily (slow import) and return a FastSAM model,
    downloading weights to a cached, gitignored location on first run."""
    from ultralytics import FastSAM

    weights_dir = PIPELINE_DIR / ".cache" / "weights"
    weights_dir.mkdir(parents=True, exist_ok=True)
    weights_path = weights_dir / "FastSAM-s.pt"
    return FastSAM(str(weights_path))


def run_mask_generator(model, image_path: Path, imgsz: int, conf: float, iou: float):
    """Return (masks: bool[N,H,W], scores: float[N]) at native image resolution."""
    results = model(
        str(image_path),
        device="cpu",
        retina_masks=True,
        imgsz=imgsz,
        conf=conf,
        iou=iou,
        verbose=False,
    )
    r = results[0]
    if r.masks is None:
        return np.zeros((0, 0, 0), dtype=bool), np.zeros((0,), dtype=np.float32)
    masks = r.masks.data.numpy() > 0.5
    scores = r.boxes.conf.numpy() if r.boxes is not None else np.ones(len(masks), dtype=np.float32)
    return masks, scores


def dedup(masks: np.ndarray, scores: np.ndarray, areas: np.ndarray, strided: bool = False) -> list[int]:
    """Greedy NMS over masks: process highest-confidence first, drop any
    mask that overlaps a kept one too much (same object proposed twice) or
    that is almost entirely contained in a kept one at a similar scale.

    Pass `strided=True` when `masks` is already downsampled by DEDUP_STRIDE
    (the caller does that before selecting a subset, so the full-resolution
    stack is never copied)."""
    if strided:
        small = masks.reshape(masks.shape[0], -1)
    else:
        small = masks[:, ::DEDUP_STRIDE, ::DEDUP_STRIDE].reshape(masks.shape[0], -1)
    small_areas = small.sum(axis=1)
    order = np.argsort(-scores)

    kept: list[int] = []
    for i in order:
        ai = small_areas[i]
        if ai == 0:
            continue
        is_dup = False
        for j in kept:
            inter = np.logical_and(small[i], small[j]).sum()
            if inter == 0:
                continue
            union = ai + small_areas[j] - inter
            iou = inter / union if union > 0 else 0.0
            contain = inter / min(ai, small_areas[j])
            if iou > DEDUP_IOU_THRESH or contain > DEDUP_CONTAIN_THRESH:
                is_dup = True
                break
        if not is_dup:
            kept.append(int(i))
    return kept


def paint_canvas(masks: np.ndarray, kept: list[int], areas: np.ndarray, h: int, w: int) -> np.ndarray:
    """Rasterise kept masks to one id per pixel. Painted largest-first so
    smaller masks (specimens) overwrite larger ones (background regions
    they sit inside) on overlap — "smaller area wins", deterministically."""
    canvas = np.zeros((h, w), dtype=np.int32)
    paint_order = sorted(kept, key=lambda i: -areas[i])
    for rank, i in enumerate(paint_order, start=1):
        canvas[masks[i]] = rank
    return canvas


def relabel_by_final_area(canvas: np.ndarray, n_temp_ids: int) -> tuple[np.ndarray, np.ndarray]:
    """Some temp ids may own zero pixels after paint_canvas's overlap
    resolution (fully occluded by smaller masks on top). Drop those, then
    renumber the survivors 1..K by their actual post-paint area, descending
    — this is the ordering the JSON labels follow, so it must be computed
    from the same canvas the PNG encodes, not the raw (pre-overlap) masks."""
    final_areas = np.bincount(canvas.ravel(), minlength=n_temp_ids + 1)
    survivors = [i for i in range(1, n_temp_ids + 1) if final_areas[i] > 0]
    survivors.sort(key=lambda i: -final_areas[i])

    lut = np.zeros(n_temp_ids + 1, dtype=np.int32)
    for new_id, old_id in enumerate(survivors, start=1):
        lut[old_id] = new_id
    remapped = lut[canvas]
    new_areas = np.array([final_areas[old_id] for old_id in survivors], dtype=np.int64)
    return remapped, new_areas


def segment_stats(canvas: np.ndarray, rgb: np.ndarray, ids: range) -> list[dict]:
    """bbox / centroid / meanColor per id, computed from the final canvas
    so every number in the JSON matches what the PNG actually encodes."""
    h, w = canvas.shape
    rows, cols = np.indices((h, w))
    out = []
    for i in ids:
        m = canvas == i
        ys = rows[m]
        xs = cols[m]
        area = int(m.sum())
        mean_rgb = rgb[m].mean(axis=0)
        out.append(
            {
                "id": i,
                "area": area,
                "bbox": [int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max())],
                "centroid": [round(float(xs.mean()), 1), round(float(ys.mean()), 1)],
                "meanColor": [int(round(c)) for c in mean_rgb],
            }
        )
    return out


def id_to_rgb(ids: np.ndarray) -> np.ndarray:
    """Colour-encode ids as (r<<16)|(g<<8)|b for the segments.png contract."""
    r = (ids >> 16) & 0xFF
    g = (ids >> 8) & 0xFF
    b = ids & 0xFF
    return np.stack([r, g, b], axis=-1).astype(np.uint8)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("image", type=Path, help="input image (jpg/png)")
    parser.add_argument("--out-dir", type=Path, default=Path("../public/data"), help="where to write <stem>.segments.{png,json}")
    parser.add_argument("--max-masks", type=int, default=200, help="cap on output segments, largest-area first")
    parser.add_argument("--min-area", type=int, default=None, help="drop masks smaller than this many pixels (default: %.4f%% of image area)" % (DEFAULT_MIN_AREA_FRAC * 100))
    args = parser.parse_args()

    if not args.image.exists():
        print(f"error: {args.image} does not exist", file=sys.stderr)
        return 1

    t_start = time.time()

    log(f"Loading image: {args.image}")
    img = Image.open(args.image).convert("RGB")
    w, h = img.size
    rgb = np.asarray(img)  # (h, w, 3)
    total_px = w * h
    log(f"  {w}x{h} = {total_px:,} px")

    min_area = args.min_area if args.min_area is not None else max(64, int(DEFAULT_MIN_AREA_FRAC * total_px))
    log(f"  min-area = {min_area:,} px")

    log("Loading FastSAM-s (downloads on first run, then cached offline)...")
    t0 = time.time()
    model = load_fastsam()
    log(f"  model ready in {time.time() - t0:.1f}s")

    log("Running automatic mask generation (CPU)...")
    t0 = time.time()
    masks, scores = run_mask_generator(model, args.image, FASTSAM_IMGSZ, FASTSAM_CONF, FASTSAM_IOU)
    log(f"  {len(masks)} raw proposals in {time.time() - t0:.1f}s")

    if len(masks) == 0:
        log("No masks found — writing an all-unsegmented mask.")
        canvas = np.zeros((h, w), dtype=np.int32)
        segments: list[dict] = []
    else:
        areas = masks.reshape(masks.shape[0], -1).sum(axis=1)

        big_enough = np.where(areas >= min_area)[0]
        log(f"  {len(big_enough)} survive the min-area filter")

        t0 = time.time()
        # `masks[big_enough]` would copy the full N×H×W bool stack (~900 MB for
        # 300 proposals on a plate); downsample first, then select.
        small = masks[:, ::DEDUP_STRIDE, ::DEDUP_STRIDE][big_enough]
        kept = dedup(small, scores[big_enough], areas[big_enough], strided=True)
        kept = [int(big_enough[i]) for i in kept]
        log(f"  {len(kept)} survive dedup ({time.time() - t0:.1f}s)")

        if len(kept) > args.max_masks:
            kept.sort(key=lambda i: -areas[i])
            kept = kept[: args.max_masks]
            log(f"  capped to --max-masks {args.max_masks}")

        canvas = paint_canvas(masks, kept, areas, h, w)
        canvas, final_areas = relabel_by_final_area(canvas, len(kept))
        n = len(final_areas)
        log(f"  {n} segments after overlap resolution (smaller area wins)")

        stats = segment_stats(canvas, rgb, range(1, n + 1))
        label_width = max(2, len(str(n)))
        segments = []
        for s in stats:
            s["label"] = f"Specimen {s['id']:0{label_width}d}"
            segments.append(s)

        segmented_frac = (canvas != 0).sum() / total_px
        log(f"  segmented pixel fraction: {segmented_frac:.3f}")

    args.out_dir.mkdir(parents=True, exist_ok=True)
    stem = args.image.stem
    png_path = args.out_dir / f"{stem}.segments.png"
    json_path = args.out_dir / f"{stem}.segments.json"

    log(f"Writing {png_path}")
    mask_rgb = id_to_rgb(canvas)
    Image.fromarray(mask_rgb, "RGB").save(png_path)  # lossless, no resampling

    log(f"Writing {json_path}")
    import json

    with open(json_path, "w") as f:
        json.dump({"segments": segments}, f, indent=2)

    log(f"Done in {time.time() - t_start:.1f}s total.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
