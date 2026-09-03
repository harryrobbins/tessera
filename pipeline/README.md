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

---

# Birds pipeline

`birds.py` builds the `birds:<n>` collections — AVONET traits joined to
Wikidata's image index, with the pictures themselves pulled from Wikimedia
Commons. Output is `public/data/birds-<n>.json` plus one or more
`public/data/birds-<n>-<k>.avif` sheets. (They are mostly *not* photographs;
see "What the join and the filter actually measured" below, because that
matters more than anything else on this page.)

It is a **separate script with its own environment**. `pyproject.toml` in this
directory belongs to `segment.py` and pins torch; `birds.py` needs pandas,
openpyxl, requests and Pillow, so it carries PEP 723 inline script metadata
instead and `uv run` resolves a tiny env for it. Do not merge the two.

## Run it

```bash
cd pipeline
uv run birds.py --out-dir ../public/data
```

Flags:

- `--stats-only` — stop after the join and the licence filter, write nothing.
  This is the cheap way to re-measure the yield.
- `--large N` — force the large collection size instead of picking the largest
  of 3000 / 2500 / 2000 / 1500 that the yield supports.
- `--format {avif,webp}` (default `avif`) and `--quality N` — the sheet
  encoder; defaults are AVIF q65 (`speed=6`) and WebP q70. Everything upstream
  of the encode is cached and format-agnostic, so switching format is one flag
  and a re-run off the warm cache, with nothing re-downloaded. Switching also
  deletes the previous encoder's sheets so a stale pair cannot ship.

Both collections are always written together, and the 900 is drawn from the
large collection's own selection — a strict subset, so the two stay
consistent. The per-order quota is re-applied at 900, because a cap set for
3,000 rows would let one order take 83 % of the smaller collection.

## The cache

Everything downloaded lands in `pipeline/.cache/birds/` (gitignored, alongside
`segment.py`'s model weights):

| file | what |
|---|---|
| `avonet.xlsx` | the 21.5 MB Figshare workbook, md5-verified on every run |
| `wd-images.csv` | SPARQL: every species-rank bird taxon with a `P18` |
| `wd-common.csv` | SPARQL: `P1843` English common names |
| `wd-label.csv` | SPARQL: `rdfs:label` @en, the common-name fallback |
| `wd-synonyms.csv` | SPARQL: `P1420` → `P225`, the synonym pass |
| `imageinfo.json` | one record per Commons file, keyed by filename |
| `thumbs/` | the 250 px Commons thumbnails, keyed by a hash of the filename |

**A re-run with a warm cache makes no network calls** — the full build takes
about 11 minutes cold (dominated by 2,000 serial thumbnail fetches) and
**12 seconds warm**, reproducing byte-identical sheets. `imageinfo.json` is
flushed every ten batches, so an interrupted run resumes where it stopped.
Deleting a single file re-fetches only that stage.

## The eight steps

1. **AVONET.** `AVONET1_BirdLife`, 11,009 extant species. CC BY 4.0.
2. **Wikidata.** Four narrow SPARQL queries. They must stay narrow: adding an
   `OPTIONAL` pushes the endpoint past its 60 s ceiling and it answers 502.
   A contact-bearing User-Agent is mandatory — Wikimedia enforces its UA policy.
3. **Join** on the binomial (`Species1` ↔ `P225`), then a synonym pass through
   `P1420` → `P225` for the misses. The script prints the hit rate; it is the
   number the whole collection rests on.
4. **Commons `imageinfo`**, 25 titles per call, serial, `iiurlwidth=250`
   (Commons rounds thumbnail requests up to standard buckets, so asking for 128
   returns a 250 px file anyway — ask for 250 and downscale here).
   Then the **licence filter**: keep only files whose `LicenseShortName` /
   `License` say public domain or CC0, reject anything carrying an `SA`, `NC`
   or `ND` token whatever it calls itself, and drop any file with no `Artist`.
   Where a species has several candidate pictures, the one with the largest
   short side wins (a 250 px thumbnail of a panorama gives a small square once
   it is centre-cropped).
5. **Selection.** Rows are ranked by *data completeness* — one point for each
   of the nine AVONET fields that can be missing (`Habitat`, `Habitat.Density`,
   `Migration`, `Trophic.Level`, `Trophic.Niche`, `Primary.Lifestyle`,
   `Range.Size`, `Centroid.Latitude`, `Centroid.Longitude`), plus two for a
   Wikidata `P1843` common name or one for an `rdfs:label` fallback — then by
   thumbnail short side, then by range size, then by binomial so a re-run
   reproduces the same collection exactly.

   On top of that sits a **per-order quota**: *no taxonomic order may take more
   than 25 % of the collection while any other order still has an unselected
   eligible species.* Passeriformes is 60 % of AVONET, so without the quota the
   mosaic is one enormous blob of songbirds. A second pass fills any shortfall
   from the rows the cap displaced, which only bites if the eligible pool is
   itself dominated by one order. The quota is applied twice — once to pick
   the large collection out of the eligible pool, and again to pick the 900 out
   of the large collection.
6. **Tiles.** Each 250 px thumbnail is centre-cropped to square and Lanczos-
   resized to 128 px (the 900) or 96 px (the large collection), then tiled in
   row order into sheets capped at 4096². The last sheet is cropped to the rows
   it actually fills. Each tile's mean RGB goes into the JSON's `rgb` array,
   which is what the app's True-colour mode reads.
7. **JSON.** Columns in declaration order, the sheet manifest, the `rgb` array
   and a row-aligned `credits` array recording the Commons filename, the licence
   string and the author the build actually saw.
8. **`CREDITS.md`.** The `## Bird images and traits` section in
   `public/data/CREDITS.md` is regenerated from what step 4 saw — the counts,
   the licence mix and the date are measured, not remembered. The script
   replaces only that section and leaves the others alone.

## What the join and the filter actually measured

Run 2026-09-03. These are the numbers plan §6 lists as unverified, and the
second one is worse than the plan's estimate:

| step | count |
|---|---|
| AVONET species | 11,009 |
| matched to a Wikidata taxon with a `P18`, on the binomial alone | 9,799 (**89.0 %**) |
| …plus the `P1420` synonym pass | 9,882 (**89.8 %**) — the synonym pass adds 83 |
| distinct Commons files behind those species | 12,338 (0 failed to resolve) |
| public domain or CC0 | 2,400 (**19.5 %**) |
| …dropped for having no `Artist` | 82 |
| usable files | 2,318 |
| **species with a usable image** | **2,262** (20.5 % of AVONET) |

The join landed at the top of the plan's 80–90 % guess. **The licence filter
did not**: plan §2.1 measured 24 % public domain / CC0 on a 200-file sample and
projected ~2,900 species; the full 12,338-file population is 19.5 %, and 2,262
species survive. That is why the large collection is **2,000 rows, not 3,000** —
below the atlas's 3,136-row per-item ceiling with room to spare, but not the
mosaic the plan hoped for.

The `P1420` synonym pass is worth its one extra query but only just: it
recovers 83 species, 0.8 percentage points.

**And they are mostly not photographs.** This is the finding that matters most
and the plan did not anticipate it. A public-domain-only filter over Commons
does not select modern wildlife photography — almost all of that is CC BY-SA —
it selects work old enough for copyright to have expired. What comes back is
largely nineteenth-century ornithological lithography: six credited authors
(Keulemans, Smit, Wolf, Grønvold, Gould, Huet/Prêtre) account for **39 % of
the 2,000 rows**, and eyeballing a random 100-tile contact sheet puts the split
at roughly **four fifths plates, one fifth photographs** — the photographs
being chiefly US federal-government work, plus a scattering of museum specimen
scans (83 rows, 4 %, are Naturalis skins on graph paper).

That is not a defect of the pipeline, it is what the licence asks for, and the
result is a handsome atlas of Victorian bird plates. But it should be described
as one: the mean tile colour is a warm paper tone (174, 169, 152), so the app's
True-colour mode will read pale rather than as a field of plumage, and the
`photo` card painter is drawing plates. Wanting actual photographs means either
accepting CC BY (§3 of the plan, an author column per row) or switching the
image source to iNaturalist's CC0 subset (§2.3).

**The quota cannot bite at 2,000.** Only about 1,100 of the 2,262 eligible
species are non-passerine, so a 25 % cap is unsatisfiable for any collection
above ~1,400 rows and the second pass fills the rest: `birds-2000` ends up
57 % Passeriformes, which is roughly what the eligible pool is. `birds-900`
has room and lands on the cap exactly — 25 % Passeriformes across 30 orders.
The quota is a ceiling, not a guarantee, and the script prints the real mix
for both collections on every run.

## Why AVIF, and what it actually buys

The two settings are matched on SSIM against the uncompressed sheet, not on a
matched quality *number* — quality scales are not comparable across codecs,
and AVIF q70 is in fact **larger** than WebP q70.

Measured on the real bird sheets (headless Chromium, `createImageBitmap` on a
Blob, median of five — `scratch/decode-probe.mjs`, run from the repo root):

| sheet | AVIF q65 | WebP q70 | AVIF decode | WebP decode |
|---|---|---|---|---|
| `birds-900-0` (4096×3712) | 2,666 kB | 2,600 kB | **174 ms** | 223 ms |
| `birds-2000-0` (4032×4032) | 3,079 kB | 3,110 kB | **204 ms** | 254 ms |
| `birds-2000-1` (4032×576) | 410 kB | 404 kB | **30 ms** | 35 ms |

**On bytes, AVIF wins nothing here** — ±2 %, and on the 900 it is 2.5 %
*larger*. Plan §6's guess of 20–30 % is wrong, and so is the 5–7 % measured on
crops of the paintings in `public/data/`: lithographic plates on flat paper are
not the same compression problem as a photograph. **On decode it wins about
20 %**, consistently, because dav1d is multithreaded in Chromium and libwebp's
decoder is not — and that is the number that matters, since `buildCards`
(`src/app.ts`) is synchronous and cannot start until every sheet has decoded.
The whole `birds:2000` pair decodes in 234 ms against 289 ms as WebP.

Encoding costs 2.3–2.9 s a sheet at `speed=6` against 3.9–4.8 s for WebP
`method=6`, so AVIF is actually the faster build here too.

AVIF in `createImageBitmap` needs **Chrome 85+, Firefox 93+ or Safari 16.4+**.
Older browsers fail the decode, which the engine degrades to plain quiet cards
rather than a crash — and `--format webp` re-encodes the whole thing off the
warm cache if that ever needs to change.

## Sizes, and why

`public/data/birds-900.json` paints each card at a 128 px atlas slot;
above 900 rows the base slot halves to 64 px (`src/gl/atlas.ts` `slotFor`) and
above 3,136 rows per-item art is replaced by category covers
(`hiResCapacity`). So 900 and "as close to 3,000 as the licence filter allows"
are the two sizes worth shipping, and the script picks the largest of
3000 / 2500 / 2000 / 1500 the post-filter yield supports. If the yield falls
below 1,500 it builds only the 900 and says so.

What the 2026-09-03 build actually committed:

| collection | rows | tile | sheets | sheet bytes | per tile | JSON | total |
|---|---|---|---|---|---|---|---|
| `birds-900` | 900 | 128 px | 1 × 4096×3712 | 2,666 kB | 3.0 kB | 209 kB | **2.81 MB** |
| `birds-2000` | 2,000 | 96 px | 4032×4032 + 4032×576 | 3,490 kB | 1.8 kB | 467 kB | **3.86 MB** |

6.67 MB for both, against the 30 MB budget plan §1 works to. The per-tile
figures come in 18–19 % under plan §1.1's estimates (3.7 kB at 128 px, 2.2 kB
at 96 px) — inside its stated ±25 %, and helped by lithographic plates
compressing better than photographs would.
