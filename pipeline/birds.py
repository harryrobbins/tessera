#!/usr/bin/env python3
# /// script
# requires-python = ">=3.11"
# dependencies = [
#   "pandas>=2.0",
#   "openpyxl>=3.1",
#   "requests>=2.31",
#   "pillow>=10.0",
# ]
# ///
"""
Build the `birds:<n>` collections: AVONET traits x Wikidata images x Commons files.

Emits, into ../public/data/ :

    birds-<n>.json        columns + sheet manifest + credit manifest
    birds-<n>-<k>.<ext>   picture sheet k, at most 4096x4096 (--format avif|webp)

See README.md ("Birds pipeline") for the contract, the licence filter and the
selection rule. Usage:

    uv run birds.py --out-dir ../public/data

Everything downloaded is cached under pipeline/.cache/birds/ (gitignored), so a
second run with a warm cache makes no network calls at all.

NOTE: this script deliberately does NOT live in pipeline/pyproject.toml — that
project pins torch for segment.py, and this one needs pandas and Pillow. The
PEP 723 header above gives `uv run` its own tiny environment.
"""

from __future__ import annotations

import argparse
import hashlib
import html
import json
import math
import re
import sys
import time
import unicodedata
from pathlib import Path
from urllib.parse import unquote

import pandas as pd
import requests
from PIL import Image

PIPELINE_DIR = Path(__file__).resolve().parent
CACHE = PIPELINE_DIR / ".cache" / "birds"

# Wikimedia enforces its User-Agent policy; a contact address is mandatory.
# https://foundation.wikimedia.org/wiki/Policy:Wikimedia_Foundation_User-Agent_Policy
UA = "Tessera-build/0.1 (https://github.com/; harryrobbins@gmail.com)"

SPARQL = "https://query.wikidata.org/sparql"
COMMONS_API = "https://commons.wikimedia.org/w/api.php"

# AVONET Supplementary dataset 1 (Tobias et al. 2022), Figshare 16586228 v7.
# CC BY 4.0. 21,524,673 bytes, md5 1445afdcfb6df784010c2ca034544bc8.
AVONET_URL = "https://ndownloader.figshare.com/files/34480856"
AVONET_MD5 = "1445afdcfb6df784010c2ca034544bc8"
AVONET_SHEET = "AVONET1_BirdLife"

# Commons rounds thumbnail requests up to standard buckets: asking for 128
# returns a 250px file anyway, so ask for 250 and downscale here.
THUMB_W = 250

# Politeness. extmetadata is documented as expensive; go serial with a delay
# rather than parallel (this box is also heat-sensitive).
API_DELAY = 0.35        # between imageinfo batches
THUMB_DELAY = 0.12      # between thumbnail fetches
BATCH = 25              # titles per imageinfo call

ATLAS_MAX = 4096        # the ceiling this codebase treats as safe everywhere

# Sheet encoders. AVIF q65 is the default, chosen on a measured SSIM match
# against the uncompressed sheet rather than on a matched quality number
# (quality scales are not comparable across codecs; AVIF q70 is *larger* than
# WebP q70). At equal quality AVIF saves only 5-7% of the bytes, not the
# 20-30% plan section 6 guessed — the real win is decode, which is ~25%
# faster because dav1d is multithreaded in Chromium and libwebp's decoder is
# not. That is the number that matters: `buildCards` is synchronous and
# cannot start until every sheet has decoded. Encode costs ~3.5s a sheet at
# speed=6 against ~2s for WebP, which is nothing.
#
# `--format webp` stays as the escape hatch: AVIF in `createImageBitmap`
# needs Chrome 85+, Firefox 93+ or Safari 16.4+. Everything upstream of the
# encode - the thumbnail cache, the crop, the Lanczos resize, the tiling and
# the mean-RGB pass - is format-agnostic and cached, so switching formats is
# one flag and a re-run off the warm cache, with no re-downloading.
FORMATS = {
    "avif": {"ext": "avif", "pil": "AVIF", "quality": 65,
             "opts": {"speed": 6}},
    "webp": {"ext": "webp", "pil": "WEBP", "quality": 70,
             "opts": {"method": 6}},
}
DEFAULT_FORMAT = "avif"

# Sizes we are willing to build for the large collection, largest first.
# See plan section 1: 3,136 rows is the atlas's per-item ceiling and 900 is
# where the base slot falls from 128px to 64px.
LARGE_CANDIDATES = [3000, 2500, 2000, 1500]
SMALL_N = 900
TILE_FOR = {SMALL_N: 128}       # everything else gets 96
LARGE_TILE = 96

# Per-order quota (selection, step 5). No single taxonomic order may take more
# than this share of the collection while any other order still has an
# unselected eligible species. Passeriformes is 60% of AVONET, so without this
# the mosaic is one enormous blob of songbirds.
ORDER_QUOTA_SHARE = 0.25


def log(msg: str) -> None:
    print(msg, flush=True)


# --------------------------------------------------------------------------
# 0. cache
# --------------------------------------------------------------------------

def session() -> requests.Session:
    s = requests.Session()
    s.headers.update({"User-Agent": UA, "Accept-Encoding": "gzip"})
    return s


def cached_get(s: requests.Session, url: str, path: Path, *, params=None, binary=True,
               timeout=180, tries=4) -> bytes:
    """GET into `path` unless it already exists. Returns the bytes."""
    if path.exists():
        return path.read_bytes()
    path.parent.mkdir(parents=True, exist_ok=True)
    last = None
    for attempt in range(tries):
        try:
            r = s.get(url, params=params, timeout=timeout)
            if r.status_code in (429, 500, 502, 503, 504):
                raise requests.HTTPError(f"HTTP {r.status_code}")
            r.raise_for_status()
            tmp = path.with_suffix(path.suffix + ".part")
            tmp.write_bytes(r.content)
            tmp.replace(path)
            return r.content
        except Exception as e:  # noqa: BLE001 - retry anything transient
            last = e
            wait = 2 ** attempt
            log(f"    retry {attempt + 1}/{tries} after {wait}s ({e})")
            time.sleep(wait)
    raise RuntimeError(f"failed to fetch {url}: {last}")


# --------------------------------------------------------------------------
# 1. AVONET
# --------------------------------------------------------------------------

def load_avonet(s: requests.Session) -> pd.DataFrame:
    path = CACHE / "avonet.xlsx"
    if not path.exists():
        log(f"Downloading AVONET workbook (21.5 MB) from {AVONET_URL}")
    blob = cached_get(s, AVONET_URL, path, timeout=600)
    digest = hashlib.md5(blob).hexdigest()
    if digest != AVONET_MD5:
        raise RuntimeError(f"AVONET md5 mismatch: got {digest}, expected {AVONET_MD5}")
    df = pd.read_excel(path, sheet_name=AVONET_SHEET)
    df["Species1"] = df["Species1"].astype(str).str.strip()
    log(f"  AVONET {AVONET_SHEET}: {len(df):,} rows, md5 verified")
    return df


# --------------------------------------------------------------------------
# 2. Wikidata
# --------------------------------------------------------------------------

# One narrow query per figure: adding OPTIONALs pushes the endpoint past its
# 60s ceiling and it answers 502 (plan section 2.1).
Q_IMAGES = """SELECT ?item ?name ?img WHERE {
  ?item wdt:P105 wd:Q7432 ; wdt:P171+ wd:Q5113 ; wdt:P225 ?name ; wdt:P18 ?img .
}"""

Q_COMMON = """SELECT ?item ?common WHERE {
  ?item wdt:P105 wd:Q7432 ; wdt:P171+ wd:Q5113 ; wdt:P18 ?i ; wdt:P1843 ?common .
  FILTER(LANG(?common) = "en")
}"""

Q_LABEL = """SELECT ?item ?label WHERE {
  ?item wdt:P105 wd:Q7432 ; wdt:P171+ wd:Q5113 ; wdt:P18 ?i ; rdfs:label ?label .
  FILTER(LANG(?label) = "en")
}"""

Q_SYNONYM = """SELECT ?item ?syn WHERE {
  ?item wdt:P105 wd:Q7432 ; wdt:P171+ wd:Q5113 ; wdt:P18 ?i ; wdt:P1420 ?synT .
  ?synT wdt:P225 ?syn .
}"""


def sparql_csv(query: str, name: str) -> pd.DataFrame:
    """One narrow query, cached as CSV. The endpoint times out at 60s."""
    path = CACHE / f"wd-{name}.csv"
    if not path.exists():
        log(f"  SPARQL: {name}")
    s = requests.Session()
    s.headers.update({"User-Agent": UA, "Accept": "text/csv"})
    cached_get(s, SPARQL, path, params={"query": query}, timeout=240)
    return pd.read_csv(path)


def commons_filename(url: str) -> str:
    """`http://commons.wikimedia.org/wiki/Special:FilePath/A%20b.jpg` -> `A b.jpg`"""
    return unquote(url.rsplit("/", 1)[-1]).replace("_", " ")


def pick_common_name(names: list[str]) -> str:
    """P1843 is multi-valued and unranked here. Pick deterministically: the
    alphabetically first, which prefers 'Barn owl' over 'Common barn owl'."""
    return sorted(names)[0]


def titlecase_first(name: str) -> str:
    """Commons/Wikidata common names arrive in mixed case ('White-tailed
    Ptarmigan', 'barn owl'). Normalise to sentence case, keeping any
    capitals that are not simply the start of a word (proper nouns are
    lost either way, so prefer the form the rest of the app uses)."""
    name = name.strip()
    if not name:
        return name
    words = name.split(" ")
    out = [words[0][:1].upper() + words[0][1:]]
    for w in words[1:]:
        out.append(w[:1].lower() + w[1:] if w[:2].upper() != w[:2] else w)
    return " ".join(out)


# --------------------------------------------------------------------------
# 3. licence filter
# --------------------------------------------------------------------------

_ALNUM = re.compile(r"[^a-z0-9]+")

# Never admit anything share-alike or non-commercial, whatever it calls itself.
_FORBIDDEN_TOKENS = {"sa", "nc", "nd", "sharealike", "noncommercial", "noderivs"}

# Generous about the many spellings of public domain, strict about everything
# else. Matched against the licence string with all punctuation removed.
_PD_EXACT = {
    "cc0", "cczero", "cc010", "cc01", "publicdomain", "pd", "pdm", "norestrictions",
    "nocopyright", "publicdomainmark", "publicdomainmark10",
}
_PD_PREFIX = ("cc0", "cczero", "pd", "publicdomain", "norestrictions")


def _norm(v: str) -> str:
    return _ALNUM.sub("", (v or "").lower())


def _tokens(v: str) -> set[str]:
    return {t for t in _ALNUM.sub(" ", (v or "").lower()).split() if t}


def is_public_domain(short_name: str, license_code: str) -> bool:
    """True iff the file is public domain or CC0 and carries no SA/NC/ND term.

    Judged from extmetadata.LicenseShortName ('Public domain', 'CC0',
    'PD-US', 'No restrictions', ...) plus extmetadata.License, the machine
    code from the licence template ('cc0', 'pd-old-100', 'cc-by-sa-3.0')."""
    for v in (short_name, license_code):
        if _tokens(v) & _FORBIDDEN_TOKENS:
            return False
    for v in (short_name, license_code):
        n = _norm(v)
        if not n:
            continue
        if n in _PD_EXACT or n.startswith(_PD_PREFIX):
            return True
        if "publicdomain" in n:
            return True
    return False


_TAG = re.compile(r"<[^>]+>")


def strip_html(v: str) -> str:
    """extmetadata.Artist is a fragment of HTML ('<a href=...>Jane Doe</a>')."""
    txt = html.unescape(_TAG.sub(" ", v or ""))
    txt = unicodedata.normalize("NFC", txt)
    return re.sub(r"\s+", " ", txt).strip()


def fetch_imageinfo(s: requests.Session, titles: list[str]) -> dict[str, dict]:
    """Batch `titles` through the Commons imageinfo API, caching per title.

    The cache is a single JSON dict written back every few batches, so an
    interrupted run resumes where it stopped and a warm run costs nothing."""
    path = CACHE / "imageinfo.json"
    store: dict[str, dict] = json.loads(path.read_text()) if path.exists() else {}
    todo = [t for t in titles if t not in store]
    log(f"  imageinfo: {len(titles):,} files, {len(store):,} cached, {len(todo):,} to fetch")

    batches = [todo[i:i + BATCH] for i in range(0, len(todo), BATCH)]
    for bi, batch in enumerate(batches):
        params = {
            "action": "query",
            "format": "json",
            "formatversion": "2",
            "prop": "imageinfo",
            "iiprop": "extmetadata|url|size",
            "iiurlwidth": str(THUMB_W),
            "iiextmetadatafilter": "LicenseShortName|License|Artist|AttributionRequired|LicenseUrl|Credit",
            "titles": "|".join(f"File:{t}" for t in batch),
        }
        data = None
        for attempt in range(4):
            try:
                r = s.get(COMMONS_API, params=params, timeout=120)
                r.raise_for_status()
                data = r.json()
                break
            except Exception as e:  # noqa: BLE001
                log(f"    retry {attempt + 1}/4 ({e})")
                time.sleep(2 ** attempt)
        if data is None:
            raise RuntimeError("imageinfo batch failed after 4 tries")

        seen = set()
        for page in data.get("query", {}).get("pages", []):
            title = page.get("title", "")
            key = title[5:] if title.startswith("File:") else title
            seen.add(key)
            info = (page.get("imageinfo") or [None])[0]
            if page.get("missing") or not info:
                store[key] = {"missing": True}
                continue
            em = info.get("extmetadata", {}) or {}

            def meta(k: str) -> str:
                return (em.get(k) or {}).get("value", "") or ""

            store[key] = {
                "thumb": info.get("thumburl", ""),
                "tw": info.get("thumbwidth", 0),
                "th": info.get("thumbheight", 0),
                "w": info.get("width", 0),
                "h": info.get("height", 0),
                "short": meta("LicenseShortName"),
                "code": meta("License"),
                "artist": strip_html(meta("Artist")),
                "attrib": meta("AttributionRequired"),
                "url": info.get("descriptionurl", ""),
            }
        # Normalisation (underscores, capitalisation) can rename a title.
        for t in batch:
            store.setdefault(t, {"missing": True})

        if bi % 10 == 9 or bi == len(batches) - 1:
            path.write_text(json.dumps(store))
            log(f"    batch {bi + 1}/{len(batches)}")
        time.sleep(API_DELAY)

    if todo:
        path.write_text(json.dumps(store))
    return store


# --------------------------------------------------------------------------
# 4. columns
# --------------------------------------------------------------------------

HABITAT_FIX = {"Human Modified": "Human modified"}
DIET = {
    "Invertivore": "Insects",
    "Frugivore": "Fruit",
    "Granivore": "Seeds",
    "Nectarivore": "Nectar",
    "Vertivore": "Vertebrates",
    "Aquatic predator": "Aquatic prey",
    "Herbivore aquatic": "Aquatic plants",
    "Herbivore terrestrial": "Plants",
    "Omnivore": "Omnivore",
    "Scavenger": "Scavenger",
}
LIFESTYLE = {"Insessorial": "Perching"}
MIGRATION = {1: "Sedentary", 2: "Partial", 3: "Migratory"}
MIGRATION_ORDER = ["Sedentary", "Partial", "Migratory"]
DENSITY = {1: "Dense", 2: "Semi-open", 3: "Open"}
DENSITY_ORDER = ["Dense", "Semi-open", "Open"]

# Mass bands, in display order. Equal-width binning over [1.9 g, 111 kg] would
# put every row in the first bin, so the boundaries are the contract's.
MASS_BANDS = [
    (10, "Under 10 g"),
    (25, "10-25 g"),
    (60, "25-60 g"),
    (150, "60-150 g"),
    (500, "150-500 g"),
    (2000, "500 g - 2 kg"),
    (math.inf, "Over 2 kg"),
]
MASS_BAND_ORDER = [label for _, label in MASS_BANDS]

UNKNOWN = "Unknown"


def mass_band(m: float) -> str:
    if m is None or (isinstance(m, float) and math.isnan(m)):
        return UNKNOWN
    for hi, label in MASS_BANDS:
        if m < hi:
            return label
    return MASS_BANDS[-1][1]


def category_column(name: str, values: list[str], order: list[str] | None) -> dict:
    """Emit `{categories, codes}`. Unordered categories are ordered by
    descending frequency (so the 8-slot palette lands on the biggest groups);
    ordered ones keep the display order the contract fixes."""
    counts: dict[str, int] = {}
    for v in values:
        counts[v] = counts.get(v, 0) + 1
    if order is None:
        cats = sorted(counts, key=lambda c: (-counts[c], c))
    else:
        cats = [c for c in order if c in counts]
        cats += sorted(c for c in counts if c not in order)
    index = {c: i for i, c in enumerate(cats)}
    return {"name": name, "kind": "category", "categories": cats,
            "codes": [index[v] for v in values]}


def number_column(name: str, values) -> dict:
    out = []
    for v in values:
        if v is None or (isinstance(v, float) and math.isnan(v)):
            out.append(None)
        else:
            out.append(round(float(v), 4))
    return {"name": name, "kind": "number", "values": out}


# --------------------------------------------------------------------------
# 5. tiles
# --------------------------------------------------------------------------

def square_tile(img: Image.Image, tile: int) -> Image.Image:
    """Centre-crop to square, then Lanczos to `tile`."""
    img = img.convert("RGB")
    w, h = img.size
    side = min(w, h)
    left = (w - side) // 2
    top = (h - side) // 2
    return img.crop((left, top, left + side, top + side)).resize((tile, tile), Image.LANCZOS)


def sheet_geometry(n: int, tile: int) -> dict:
    cols = ATLAS_MAX // tile
    rows = cols
    per = cols * rows
    return {"tile": tile, "cols": cols, "rows": rows, "perSheet": per,
            "sheets": math.ceil(n / per)}


def encoder(fmt: str, quality: int | None) -> dict:
    """Resolve `--format`/`--quality` to a Pillow save spec, importing the
    AVIF plugin if needed (Pillow 12.3 ships it but only registers the codec
    on `from PIL import AvifImagePlugin`)."""
    if fmt not in FORMATS:
        raise SystemExit(f"unknown --format {fmt!r}; choose from {sorted(FORMATS)}")
    spec = dict(FORMATS[fmt])
    if quality is not None:
        spec["quality"] = quality
    if fmt == "avif":
        from PIL import AvifImagePlugin  # noqa: F401  (registers the codec)
    return spec


def build_sheets(tiles: list[Image.Image], geo: dict, out_dir: Path, stem: str,
                 spec: dict) -> list[str]:
    cols, rows, per, tile = geo["cols"], geo["rows"], geo["perSheet"], geo["tile"]
    n = len(tiles)
    files = []
    for k in range(geo["sheets"]):
        chunk = tiles[k * per:(k + 1) * per]
        # The last sheet is cropped to the rows it actually fills; cols is
        # always full, which is what the addressing in the contract assumes.
        sheet_rows = math.ceil(len(chunk) / cols)
        canvas = Image.new("RGB", (cols * tile, sheet_rows * tile), (0, 0, 0))
        for i, t in enumerate(chunk):
            canvas.paste(t, ((i % cols) * tile, (i // cols) * tile))
        name = f"{stem}-{k}.{spec['ext']}"
        t0 = time.time()
        canvas.save(out_dir / name, spec["pil"], quality=spec["quality"], **spec["opts"])
        files.append(name)
        log(f"    {name}: {cols * tile}x{sheet_rows * tile}, {len(chunk):,} tiles, "
            f"{(out_dir / name).stat().st_size / 1024:.0f} kB, "
            f"{time.time() - t0:.1f}s to encode")
    return files


def mean_rgb(t: Image.Image) -> list[int]:
    px = t.resize((1, 1), Image.BOX).getpixel((0, 0))
    return [int(px[0]), int(px[1]), int(px[2])]


# --------------------------------------------------------------------------
# main
# --------------------------------------------------------------------------

def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out-dir", type=Path, default=PIPELINE_DIR / ".." / "public" / "data")
    ap.add_argument("--large", type=int, default=None,
                    help="force the large collection size instead of picking from the yield")
    ap.add_argument("--format", default=DEFAULT_FORMAT, choices=sorted(FORMATS),
                    help=f"sheet encoder (default {DEFAULT_FORMAT})")
    ap.add_argument("--quality", type=int, default=None,
                    help="override the format's default quality "
                         + ", ".join(f"{k}={v['quality']}" for k, v in sorted(FORMATS.items())))
    ap.add_argument("--stats-only", action="store_true",
                    help="stop after the join and the licence filter; write nothing")
    args = ap.parse_args()

    out_dir = args.out_dir.resolve()
    spec = encoder(args.format, args.quality)
    CACHE.mkdir(parents=True, exist_ok=True)
    s = session()
    t_start = time.time()

    # -- 1. AVONET ---------------------------------------------------------
    log("1. AVONET")
    av = load_avonet(s)

    # -- 2. Wikidata -------------------------------------------------------
    log("2. Wikidata (one narrow query each; OPTIONALs time the endpoint out)")
    wd_img = sparql_csv(Q_IMAGES, "images")
    wd_common = sparql_csv(Q_COMMON, "common")
    wd_label = sparql_csv(Q_LABEL, "label")
    wd_syn = sparql_csv(Q_SYNONYM, "synonyms")
    log(f"  {len(wd_img):,} (item, image) pairs over {wd_img['item'].nunique():,} taxa")

    # -- 3. join -----------------------------------------------------------
    log("3. Join AVONET <-> Wikidata on the binomial")
    wd_img["name"] = wd_img["name"].astype(str).str.strip()
    by_name: dict[str, list[tuple[str, str]]] = {}
    for item, name, img in wd_img[["item", "name", "img"]].itertuples(index=False):
        by_name.setdefault(name, []).append((item, commons_filename(img)))

    n_av = len(av)
    direct = sum(1 for sp in av["Species1"] if sp in by_name)
    log(f"  binomial join: {direct:,}/{n_av:,} = {direct / n_av * 100:.1f}%")

    # Synonym pass: AVONET is BirdLife taxonomy, Wikidata is inconsistent
    # about synonyms. P1420 (taxon synonym) -> P225 recovers a few hundred.
    syn_map: dict[str, list[tuple[str, str]]] = {}
    for item, syn in wd_syn[["item", "syn"]].dropna().itertuples(index=False):
        syn_map.setdefault(str(syn).strip(), []).append((item, None))
    item_imgs: dict[str, list[str]] = {}
    for item, _n, img in wd_img[["item", "name", "img"]].itertuples(index=False):
        item_imgs.setdefault(item, []).append(commons_filename(img))

    matched: dict[str, list[tuple[str, str]]] = {}
    via_syn = 0
    for sp in av["Species1"]:
        if sp in by_name:
            matched[sp] = by_name[sp]
        elif sp in syn_map:
            cands = [(it, f) for it, _ in syn_map[sp] for f in item_imgs.get(it, [])]
            if cands:
                matched[sp] = cands
                via_syn += 1
    total = len(matched)
    log(f"  synonym pass (P1420): +{via_syn:,}")
    log(f"  JOIN HIT RATE: {total:,}/{n_av:,} = {total / n_av * 100:.1f}% "
        f"({sum(len(v) for v in matched.values()):,} candidate files)")

    # Common names, keyed by Wikidata item.
    common: dict[str, list[str]] = {}
    for item, c in wd_common[["item", "common"]].dropna().itertuples(index=False):
        common.setdefault(item, []).append(str(c))
    labels: dict[str, str] = {}
    for item, l in wd_label[["item", "label"]].dropna().itertuples(index=False):
        labels.setdefault(item, str(l))

    # -- 4. Commons imageinfo + licence filter ----------------------------
    log("4. Commons imageinfo, then the PD/CC0 filter")
    titles = sorted({f for v in matched.values() for _it, f in v})
    store = fetch_imageinfo(s, titles)

    n_files = n_missing = n_pd = n_no_artist = 0
    ok_files: dict[str, dict] = {}
    for t in titles:
        rec = store.get(t) or {"missing": True}
        n_files += 1
        if rec.get("missing") or not rec.get("thumb"):
            n_missing += 1
            continue
        if not is_public_domain(rec.get("short", ""), rec.get("code", "")):
            continue
        n_pd += 1
        if not rec.get("artist"):
            n_no_artist += 1
            continue
        ok_files[t] = rec
    log(f"  {n_files:,} distinct files; {n_missing:,} missing/no thumbnail")
    log(f"  public domain or CC0: {n_pd:,} ({n_pd / max(1, n_files - n_missing) * 100:.1f}% of resolved)")
    log(f"  dropped for no Artist: {n_no_artist:,}")
    log(f"  usable files: {len(ok_files):,}")

    # One file per species: the PD/CC0 candidate with the largest short side
    # (a 250px thumbnail of a panorama gives a small square after cropping).
    species_file: dict[str, tuple[str, dict, str]] = {}
    for sp, cands in matched.items():
        best = None
        for item, f in cands:
            rec = ok_files.get(f)
            if not rec:
                continue
            score = min(rec.get("tw", 0) or 0, rec.get("th", 0) or 0)
            if best is None or score > best[0]:
                best = (score, f, rec, item)
        if best:
            species_file[sp] = (best[1], best[2], best[3])
    log(f"  SPECIES WITH A USABLE PHOTO: {len(species_file):,} "
        f"({len(species_file) / n_av * 100:.1f}% of AVONET, "
        f"{len(species_file) / max(1, total) * 100:.1f}% of the join)")

    # -- 5. selection -----------------------------------------------------
    log("5. Selection: completeness score, then the per-order quota")
    av_idx = av.set_index("Species1", drop=False)
    rows = []
    for sp, (fname, rec, item) in species_file.items():
        r = av_idx.loc[sp]
        if isinstance(r, pd.DataFrame):
            r = r.iloc[0]
        optional = ["Habitat", "Habitat.Density", "Migration", "Trophic.Level",
                    "Trophic.Niche", "Primary.Lifestyle", "Range.Size",
                    "Centroid.Latitude", "Centroid.Longitude"]
        score = sum(0 if pd.isna(r[c]) else 1 for c in optional)
        names = common.get(item)
        if names:
            cname, score = titlecase_first(pick_common_name(names)), score + 2
        elif item in labels:
            cname, score = titlecase_first(labels[item]), score + 1
        else:
            cname = sp
        rows.append({
            "sp": sp, "row": r, "file": fname, "rec": rec, "common": cname,
            "score": score,
            "short_side": min(rec.get("tw", 0) or 0, rec.get("th", 0) or 0),
            "range": 0.0 if pd.isna(r["Range.Size"]) else float(r["Range.Size"]),
            "order": str(r["Order1"]).strip(),
        })
    # Deterministic ordering: completeness, then thumbnail size, then range
    # size (a widespread bird is likelier to have a good photograph), then
    # the binomial so a re-run reproduces the same collection exactly.
    rows.sort(key=lambda d: (-d["score"], -d["short_side"], -d["range"], d["sp"]))
    log(f"  {len(rows):,} eligible rows")

    def select(pool: list[dict], n: int) -> list[dict]:
        """Top-n of `pool` by completeness, but no order may exceed
        ORDER_QUOTA_SHARE of the collection while any other order still has an
        unselected eligible species. Pass 1 applies the cap; pass 2 fills any
        shortfall from the rows the cap displaced, which can only bite if the
        pool is itself dominated by one order."""
        cap = math.ceil(ORDER_QUOTA_SHARE * n)
        taken: dict[str, int] = {}
        chosen, spill = [], []
        for d in pool:
            if len(chosen) >= n:
                break
            if taken.get(d["order"], 0) < cap:
                chosen.append(d)
                taken[d["order"]] = taken.get(d["order"], 0) + 1
            else:
                spill.append(d)
        if len(chosen) < n:
            chosen.extend(spill[:n - len(chosen)])
        return chosen

    def order_mix(sel: list[dict]) -> str:
        counts: dict[str, int] = {}
        for d in sel:
            counts[d["order"]] = counts.get(d["order"], 0) + 1
        top = sorted(counts.items(), key=lambda kv: -kv[1])[:5]
        return (f"{len(counts)} orders; "
                + ", ".join(f"{o} {c} ({c / len(sel) * 100:.0f}%)" for o, c in top))

    if args.large is not None:
        large_n = args.large
    else:
        large_n = next((c for c in LARGE_CANDIDATES if len(rows) >= c), None)
    if large_n is None:
        log(f"  yield {len(rows):,} is under {LARGE_CANDIDATES[-1]:,} — "
            f"building only the {SMALL_N}")
    else:
        log(f"  large collection: {large_n:,} (largest of "
            f"{LARGE_CANDIDATES} the yield supports)")

    if args.stats_only:
        log(f"\nStats only. {time.time() - t_start:.0f}s")
        return 0

    sizes = [SMALL_N] + ([large_n] if large_n else [])
    if len(rows) < SMALL_N:
        log(f"error: only {len(rows)} eligible rows, fewer than the {SMALL_N} minimum")
        return 1

    # The 900 is drawn from the large collection's own selection, so it is a
    # strict subset and the two stay consistent — but the quota is re-applied
    # at 900, otherwise a 25% cap set for 3,000 rows would allow one order
    # 83% of the 900.
    largest = select(rows, max(sizes))
    selections = {max(sizes): largest}
    for n in sizes:
        if n != max(sizes):
            selections[n] = select(largest, n)
    for n in sorted(sizes, reverse=True):
        log(f"  birds-{n}: {order_mix(selections[n])}")

    # -- 6/7. tiles and JSON ----------------------------------------------
    out_dir.mkdir(parents=True, exist_ok=True)
    thumbs_dir = CACHE / "thumbs"
    report = {}

    for n in sorted(sizes, reverse=True):
        sel = selections[n]
        tile = TILE_FOR.get(n, LARGE_TILE)
        geo = sheet_geometry(n, tile)
        log(f"6. birds-{n}: {tile}px tiles, {geo['cols']}x{geo['rows']} "
            f"= {geo['perSheet']:,} per sheet, {geo['sheets']} sheet(s), "
            f"{args.format} q{spec['quality']}")

        tiles, rgb = [], []
        for i, d in enumerate(sel):
            # Keyed by the Commons filename, not by row index, so the cache
            # survives a change of selection.
            path = thumbs_dir / hashlib.sha1(d["file"].encode()).hexdigest()[:20]
            if not path.exists():
                cached_get(s, d["rec"]["thumb"], path, timeout=120)
                time.sleep(THUMB_DELAY)
                if i % 200 == 0:
                    log(f"    thumbnails {i:,}/{n:,}")
            with Image.open(path) as im:
                t = square_tile(im, tile)
            tiles.append(t)
            rgb.extend(mean_rgb(t))

        stem = f"birds-{n}"
        # A format switch must not leave the previous encoder's sheets behind.
        for stale in out_dir.glob(f"{stem}-*.*"):
            if stale.suffix.lstrip(".") != spec["ext"]:
                stale.unlink()
        files = build_sheets(tiles, geo, out_dir, stem, spec)

        log(f"7. birds-{n}.json")
        sub = [d["row"] for d in sel]
        get = lambda c: [None if pd.isna(r[c]) else r[c] for r in sub]  # noqa: E731

        def cat(c, mapping=None, order=None, coerce=None):
            vals = []
            for r in sub:
                v = r[c]
                if pd.isna(v):
                    vals.append(UNKNOWN)
                    continue
                if coerce:
                    v = coerce(v)
                v = str(v).strip() if not isinstance(v, str) else v.strip()
                vals.append((mapping or {}).get(v, v))
            return vals

        mig = [UNKNOWN if pd.isna(r["Migration"]) else MIGRATION[int(r["Migration"])] for r in sub]
        den = [UNKNOWN if pd.isna(r["Habitat.Density"]) else DENSITY[int(r["Habitat.Density"])] for r in sub]
        bands = [mass_band(r["Mass"]) for r in sub]

        columns = [
            {"name": "Common name", "kind": "text", "values": [d["common"] for d in sel]},
            {"name": "Scientific name", "kind": "text", "values": [d["sp"] for d in sel]},
            category_column("Order", cat("Order1"), None),
            category_column("Family", cat("Family1"), None),
            category_column("Habitat", cat("Habitat", HABITAT_FIX), None),
            category_column("Diet", cat("Trophic.Niche", DIET), None),
            category_column("Trophic level", cat("Trophic.Level"), None),
            category_column("Lifestyle", cat("Primary.Lifestyle", LIFESTYLE), None),
            category_column("Migration", mig, MIGRATION_ORDER),
            category_column("Habitat density", den, DENSITY_ORDER),
            category_column("Mass band", bands, MASS_BAND_ORDER),
            number_column("Mass", get("Mass")),
            number_column("Wing length", get("Wing.Length")),
            number_column("Beak length", get("Beak.Length_Culmen")),
            number_column("Tail length", get("Tail.Length")),
            number_column("Hand-wing index", get("Hand-Wing.Index")),
            number_column("Range size", get("Range.Size")),
            number_column("Longitude", get("Centroid.Longitude")),
            number_column("Latitude", get("Centroid.Latitude")),
        ]

        credits = [{"file": d["file"],
                    "licence": d["rec"]["short"] or d["rec"]["code"],
                    "artist": d["rec"]["artist"]} for d in sel]

        doc = {
            "name": "Birds of the world",
            "n": n,
            "generated": time.strftime("%Y-%m-%d"),
            "sheet": {"tile": tile, "cols": geo["cols"], "rows": geo["rows"],
                      "perSheet": geo["perSheet"], "files": files},
            "columns": columns,
            "rgb": rgb,
            "credits": credits,
        }
        jpath = out_dir / f"{stem}.json"
        jpath.write_text(json.dumps(doc, separators=(",", ":")))
        sheet_bytes = sum((out_dir / f).stat().st_size for f in files)
        log(f"    {jpath.name}: {jpath.stat().st_size / 1024:.0f} kB; "
            f"sheets {sheet_bytes / 1024:.0f} kB "
            f"({sheet_bytes / n:.0f} B/tile); total "
            f"{(sheet_bytes + jpath.stat().st_size) / 1024 / 1024:.2f} MB")
        report[n] = {"json": jpath.stat().st_size, "sheets": sheet_bytes,
                     "credits": credits, "files": files}

    # -- 8. CREDITS.md -----------------------------------------------------
    log("8. CREDITS.md")
    write_credits(out_dir / "CREDITS.md", report, sizes, n_files - n_missing, n_pd,
                  n_no_artist, len(species_file), n_av, total)

    log(f"\nDone in {time.time() - t_start:.0f}s.")
    return 0


CREDITS_MARKER = "## Bird images and traits"


def write_credits(path: Path, report: dict, sizes: list[int], resolved: int, n_pd: int,
                  n_no_artist: int, n_species: int, n_av: int, joined: int) -> None:
    """Append (or replace) our own section. Never rewrite the others."""
    # The smaller collections are strict subsets of the largest, so count the
    # licences and authors over the largest alone rather than double-counting.
    biggest = max(n for n in sizes if n in report)
    creds = report[biggest]["credits"]
    licences: dict[str, int] = {}
    authors: dict[str, int] = {}
    for c in creds:
        licences[c["licence"]] = licences.get(c["licence"], 0) + 1
        authors[c["artist"]] = authors.get(c["artist"], 0) + 1
    lic_rows = "\n".join(
        f"| {lic} | {cnt:,} |" for lic, cnt in sorted(licences.items(), key=lambda kv: -kv[1]))
    top = sorted(authors.items(), key=lambda kv: -kv[1])[:6]
    top_rows = "\n".join(f"| {a} | {c:,} |" for a, c in top)
    top_share = sum(c for _a, c in top) / len(creds) * 100
    size_rows = "\n".join(
        f"| `birds-{n}.json` + {len(report[n]['files'])} "
        f"sheet{'' if len(report[n]['files']) == 1 else 's'} | {n:,} | "
        f"{(report[n]['sheets'] + report[n]['json']) / 1024 / 1024:.2f} MB |"
        for n in sorted(sizes, reverse=True) if n in report)

    section = f"""{CREDITS_MARKER}

The `birds:*` collections join three sources, all of them redistributable:

| Source | What it supplies | Licence |
|---|---|---|
| [AVONET](https://doi.org/10.6084/m9.figshare.16586228) (`AVONET1_BirdLife`) | every trait and measurement | CC BY 4.0 |
| [Wikidata](https://www.wikidata.org/wiki/Wikidata:Licensing) | the species-to-image index and the English common names | CC0 |
| [Wikimedia Commons](https://commons.wikimedia.org/) | the pictures themselves | public domain / CC0 only (see below) |

AVONET is Tobias, J. A., Sheard, C., Pigot, A. L., *et al.* (2022),
"AVONET: morphological, ecological and geographical data for all birds",
*Ecology Letters* 25, 581-597, <https://doi.org/10.1111/ele.13898>. The
workbook itself is Figshare item 16586228 (v7, published 2022-12-05),
<https://doi.org/10.6084/m9.figshare.16586228>, used under CC BY 4.0.

**The filter.** Every Commons file behind a Wikidata `P18` statement for a
joined species was read through the `imageinfo` API and kept only if
`extmetadata` said **public domain or CC0**, with no share-alike and no
non-commercial term, *and* carried a named `Artist`. Anything CC BY, CC BY-SA
or with no author was dropped. Pulled {time.strftime("%Y-%m-%d")}:

- {n_av:,} AVONET species, {joined:,} joined to a Wikidata taxon carrying an image ({joined / n_av * 100:.1f}%)
- {resolved:,} distinct Commons files resolved; {n_pd:,} of them public domain or CC0 ({n_pd / max(1, resolved) * 100:.1f}%)
- {n_no_artist:,} of those dropped for having no `Artist`
- {n_species:,} species left with a usable image

| Collection | Rows | Committed |
|---|---|---|
{size_rows}

**These are mostly not photographs.** A public-domain-only filter over
Wikimedia Commons does not select modern wildlife photography — almost all of
that is CC BY-SA — it selects work old enough for copyright to have expired.
What survives is largely nineteenth-century ornithological lithography, plus
a minority of modern photographs (chiefly US federal-government work) and a
few museum specimen scans. Six credited authors account for
{top_share:.0f} % of the {biggest:,} rows:

| Author | Rows |
|---|---|
{top_rows}

That is a fair description of the collection, and the cards should be read as
plates from a bird atlas rather than as photographs.

Licences actually seen across the {biggest:,} shipped rows (the smaller
collection is a strict subset):

| `extmetadata.LicenseShortName` | Files |
|---|---|
{lic_rows}

No attribution is legally required for any of these, but the build records
what it saw: `birds-<n>.json` carries a `credits` array, row-aligned with the
data, giving the Commons filename, the licence string and the author for every
image in the sheet. {len(authors):,} distinct authors are named there.
"""

    existing = path.read_text() if path.exists() else "# Credits\n"
    if CREDITS_MARKER in existing:
        head = existing[:existing.index(CREDITS_MARKER)].rstrip("\n")
        tail = existing[existing.index(CREDITS_MARKER):]
        nxt = tail.find("\n## ", 1)
        rest = tail[nxt:] if nxt != -1 else ""
        path.write_text(f"{head}\n\n{section.rstrip()}\n{rest}")
    else:
        path.write_text(f"{existing.rstrip()}\n\n{section.rstrip()}\n")
    log(f"  {path}")


if __name__ == "__main__":
    sys.exit(main())
