# Segmentation pipeline

Offline SAM-family automatic mask generator that produces the
`<image>.segments.png` + `<image>.segments.json` pair `src/data/pixels.ts`
knows how to load. Self-contained — separate venv, separate lockfile, never
imported by the web app.

## Run it

```bash
cd pipeline
uv run segment.py ../public/data/millot-papillons.jpg --out-dir ../public/data
```

`uv` resolves Python 3.12 (pinned via `.python-version` / `requires-python`,
torch has no CPU wheels for 3.14) and the venv on first run, so nothing needs
installing by hand first. Optional flags:

- `--max-masks N` — cap the number of output segments (largest area first). Default 200.
- `--min-area N` — drop raw mask proposals smaller than N pixels. Default is
  0.06% of the image's pixel count, which in practice keeps genuinely small
  specimens and drops printed-caption glyphs / single-pixel noise.

## Model choice

This machine (Intel Core Ultra 7 155H, 22GB RAM) has no usable discrete GPU,
so the automatic mask generator has to run on CPU in a reasonable time.
**FastSAM-s** (Ultralytics' `ultralytics` package, `FastSAM-s.pt`, ~23MB) was
chosen over SAM ViT-B/ViT-H and MobileSAM:

- It's a genuine PyPI install (`ultralytics`) with weights auto-downloaded on
  first run — MobileSAM is GitHub-only (`pip install git+...`), not on PyPI.
- It's fast: on the 1400x2131 `millot-papillons.jpg` plate, mask generation
  ("everything" mode, no prompts) takes **~2 seconds** at `imgsz=1024`,
  `conf=0.3`, `iou=0.7`. Total pipeline runtime including model load,
  post-processing, and writing both output files is **~4-5 seconds**. SAM
  ViT-B's transformer image encoder would be at least an order of magnitude
  slower on CPU for comparable quality.
- Mask quality on discrete, high-contrast objects against a plain ground
  (exactly this plate) is good — most specimens come out as one clean mask.

`torch`/`torchvision` are pinned to the CPU-only wheel index
(`https://download.pytorch.org/whl/cpu`, versions 2.6.0 / 0.21.0 — the newest
pair that index actually publishes for cp312/linux) via `[tool.uv.sources]`
in `pyproject.toml`. Without that pin, `uv`/pip resolve the default PyPI
`torch` build, which declares CUDA (`nvidia-*`, `cuda-*`) runtime
dependencies even though they're never used here — a ~2.5GB wasted download
on a box with no CUDA GPU. **Do not remove the `[tool.uv.sources]` /
`[[tool.uv.index]]` blocks** or that download comes back.

Weights (`FastSAM-s.pt`, ~23MB) download on first run to
`pipeline/.cache/weights/` and are reused (offline) on every subsequent run.
Ultralytics' own settings/telemetry state is redirected to
`pipeline/.cache/ultralytics/` via `YOLO_CONFIG_DIR` so nothing leaks into
`~/.config`. Both `.cache/` and `.venv/` are gitignored.

## Post-processing (why raw masks aren't the output)

FastSAM's "everything" mode over-proposes: the same specimen is often
detected 2-3 times at slightly different boundaries, and low-confidence
fragments (a wing tip, a caption glyph) show up as separate masks. The
pipeline cleans this up before writing anything:

1. **Min-area filter** — drop raw masks below `--min-area` pixels.
2. **Dedup (greedy NMS)** — process surviving masks highest-confidence
   first; drop any mask whose IoU with an already-kept mask exceeds 0.5, or
   that is >80% contained within an already-kept mask of similar scale
   (same object proposed twice). IoU/containment is computed on a 4x
   downsampled copy of each mask — the exact overlap fraction doesn't matter
   for "is this a duplicate", and it keeps this pass under a second even
   with 100+ candidate masks.
3. **`--max-masks` cap** — if more than N masks survive, keep the N largest.
4. **Deterministic overlap resolution** — paint the output canvas
   largest-mask-first, so smaller masks painted later overwrite larger ones
   they sit inside. This is "smaller area wins": a specimen mask always beats
   a coarse background-region mask that happens to contain it. Every output
   pixel ends up with exactly one id (or 0, unsegmented).
5. **Relabel by final (post-paint) area** — a mask's *painted* footprint can
   be smaller than its raw proposal once smaller masks are painted over it;
   ids with zero surviving pixels are dropped, and the rest are renumbered
   1..K by actual final area, descending. `bbox` / `centroid` / `meanColor`
   in the JSON are computed from this same final canvas, so every number in
   `segments.json` is consistent with what `segments.png` actually encodes
   (checked directly: decoding the PNG and re-counting pixels per id
   reproduces every `area` in the JSON exactly).

## Output contract

- `<stem>.segments.png` — RGB (no alpha), native resolution, `id =
  (r<<16)|(g<<8)|b`. Written directly from an id-per-pixel array with PIL's
  default (nearest/no-resampling) `Image.fromarray` — no scaling, no JPEG.
  `id = 0` means unsegmented.
- `<stem>.segments.json` — `{"segments": [{id, label, area, bbox, centroid,
  meanColor}, ...]}`, a superset of the documented `{id, label}` shape.
  `label` is `"Specimen NN"`, zero-padded, assigned in the same final-area
  descending order as the ids (id 1 = largest specimen on the plate) — so
  re-running the pipeline against the same image is deterministic.
  - `area`: pixel count at native resolution (post overlap-resolution).
  - `bbox`: `[xmin, ymin, xmax, ymax]`, pixel coords, top-left origin.
  - `centroid`: `[cx, cy]`, mean pixel coords.
  - `meanColor`: `[r, g, b]`, 0-255, mean of the source image's pixels under
    this segment.

## Adding another image

```bash
uv run segment.py ../public/data/<name>.jpg --out-dir ../public/data
```

then add `<name>` to `PIXEL_IMAGES` in `../src/data/pixels.ts` and a row to
`../public/data/CREDITS.md`. Tune `--min-area` / `--max-masks` if the
subject has very different scale characteristics from the butterfly plate
this was built for — check the result by decoding the PNG and counting
unique ids, and by eye (bucket the collection by `Segment` in the app),
before trusting the defaults.
