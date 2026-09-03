# Options — a collection whose cards carry real photographs

Written 2026-09-03. Research only: nothing in `src/` was edited to produce it,
every claim about today's behaviour carries a `file:line`, and every figure
below is either computed from the repo's own code or measured against a live
endpoint on the date given. Where I could not verify something I say so rather
than rounding it into a fact.

The request: a Tessera collection in which each card shows a real image —
"animals by kingdom / habitat / diet" was the example — and specifically,
whether something like DBpedia could supply the data and the pictures.

The short answer to the DBpedia question is no, and for three separate reasons
(§3.3). The longer answer is that the engine's own texture budget, not the
availability of open data, is what decides the shape of this collection, so
§1 comes first.

---

## 1. What the atlas can actually hold

Card art lives in one Canvas2D texture (`src/gl/atlas.ts:128` `CardAtlas`),
sized `Math.min(4096, MAX_TEXTURE_SIZE)` (`src/gl/renderer.ts:113`), with four
pixels of bleed each side (`src/app.ts:44`). Two thresholds follow from that
arithmetic and they are the whole design constraint.

**The per-item ceiling is 3,136 rows.** `src/app.ts:365` decides per-item art by
`ds.n <= hiResCapacity(atlasSize, 64, ATLAS_PAD)`, and `hiResCapacity`
(`src/gl/atlas.ts:78`) is `floor(4096 / 72)² = 56² = 3136`. Above it every row
of a category shares one *cover* — a label, not a record — and no photograph of
an individual row is drawn at all until the hi-res pass engages. A photographic
collection therefore wants to sit **at or under 3,136 rows**, or accept that its
far view is category tiles rather than a mosaic of pictures.

**The base slot falls from 128 px to 64 px at exactly 901 rows.** `slotFor`
(`src/gl/atlas.ts:88`) takes `cols = ceil(sqrt(n))` and the largest power-of-two
slot fitting `floor(4096 / cols)`. Stepping it row by row:

| rows | base slot |
|---|---|
| 1–9 | 1024 px |
| 10–49 | 512 px |
| 50–225 | 256 px |
| 226–900 | 128 px |
| 901–3,136 | 64 px |

So a 900-row collection paints each card at 128 px and its photograph is legible
in the fitted view without touching the camera. A 3,000-row collection paints
each card at 64 px, which for a photograph means a recognisable colour blob —
and *that is the good outcome*, because it is exactly the mosaic Tessera exists
to draw. Uniqueness above that comes back on zoom: `hiResWorthwhile`
(`src/gl/hires.ts:130`) turns the hi-res pass on as soon as a card exceeds its
own base slot, so at a 64 px slot the photographs sharpen after the mildest
zoom.

**The hi-res tiers decide how large the source image has to be.** `planTier`
(`src/gl/hires.ts:86`) steps down until the whole viewport fits, and
`hiResCapacity(4096, t, 4)` gives the capacity per tier: 128 px → 900 cards,
256 px → 225, 512 px → 49, 1024 px → 9. In practice a browser window showing a
few hundred cards settles on tier 128 or 256. **A 128 px source thumbnail is
pixel-honest at tier 128 and a 2× upscale at tier 256**; anything above that is
soft. Tessera already accepts up to a 1.5× upscale by design (README, "the tier
is fitted to the viewport"), so 128 px source is defensible and 192 px is
comfortable — but see the memory column below before reaching for 192.

### 1.1 What 30 MB of committed assets buys

I measured this rather than estimating it. The script cut 1,024 random square
crops out of the three JPEGs already in `public/data/`, resized each to the tile
size, tiled them into one sheet and encoded it. Painting plates and photographs
are not identical subject matter, so treat these as within ±25 % of what real
wildlife thumbnails will cost — but the *ratios* between sizes and between
formats are sound.

| tile | tiles per 4096² sheet | WebP q70 per tile | JPEG q75 per tile | rows in 30 MB (WebP) | decoded sheet |
|---|---|---|---|---|---|
| 64 px | 4,096 | 1.0 kB | 1.1 kB | ~29,700 | 67 MB |
| 96 px | 1,764 | 2.2 kB | 2.5 kB | ~13,600 | 67 MB |
| 128 px | 1,024 | 3.7 kB | 4.4 kB | ~8,000 | 67 MB |
| 192 px | 441 | 8.0 kB | 9.6 kB | ~3,700 | 67 MB |
| 256 px | 256 | 13.1 kB | 16.2 kB | ~2,280 | 67 MB |

WebP q70 beat JPEG q75 by 12–20 % at every size and looked no worse; q80 costs
about 27 % more bytes. AVIF was not tested — Pillow's encoder is not installed
here — and would likely save a further 20–30 % at the cost of a slower build.

> **Correction, measured while implementing this plan.** AVIF was tested, and
> both halves of that last sentence are wrong. Pillow 12.3.0 on this machine has
> AVIF built in (the plugin registers on `from PIL import AvifImagePlugin`), and
> the saving is **5–7 %, not 20–30 %**.
>
> The 20–30 % guess came from comparing quality *labels*, which do not mean the
> same thing across codecs — AVIF q70 is in fact 18 % **larger** than WebP q70.
> Matched instead on SSIM measured against the uncompressed sheet, on the same
> 4096² sheets of 128 px tiles this section used:
>
> | encode | bytes | SSIM | decode (headless Chromium) |
> |---|---|---|---|
> | WebP q70 | 4,300 kB | 0.9596 | 342 ms |
> | **AVIF q65** | **4,077 kB** | **0.9604** | **258 ms** |
>
> The build switched to AVIF q65 anyway, but for a reason this section did not
> anticipate: **decode is ~25 % faster**, and decode is what lands in the load
> budget, because `buildCards` is synchronous and cannot start until every sheet
> is decoded. Chromium's AVIF decoder (dav1d) is multithreaded; libwebp's is not.
> Encoding costs ~3.5 s per sheet at `speed=6` against ~2 s for WebP — paid once,
> at build time, and not the "slower build" worth worrying about. (`speed=4` is
> 4–8× slower and not worth the marginal bytes.)
>
> Decode was timed with `createImageBitmap` on a Blob in headless Chromium;
> the harness is `scratch/decode-probe.mjs`. AVIF via `createImageBitmap` needs
> Chrome 85+, Firefox 93+ or Safari 16.4+; older browsers fail the decode, which
> the painter degrades to plain quiet cards rather than a crash.

**One sheet does not beat N files on bytes.** This surprised me and it is worth
recording: summing 1,024 individually-encoded WebP files came to 1,109 kB
against 1,010 kB for the same tiles in one sheet at 64 px, and 3,813 kB against
3,728 kB at 128 px — a 2–9 % saving, not the 2× that intuition suggests.
Photographic tiles share almost nothing across their boundaries, so there is
little for the encoder to exploit.

**The sheet still wins, for two reasons that are not about bytes.** First,
`buildCards` (`src/app.ts:345`) is synchronous: the painter is called once per
row inside a `for` loop and cannot await anything, so every image must already
be decoded before it runs. One `fetch` plus one `createImageBitmap` is a
tractable prologue; 3,000 of them is not, on GitHub Pages or through a Posit
Connect proxy. Second, `drawImage(bitmap, sx, sy, sw, sh, …)` out of one bitmap
is the same call `pixels.ts` already makes (`src/data/pixels.ts:484`), so the
loader pattern already exists in the repo.

**Cap each sheet at 4096²** — not because of the GL texture limit (the sheet is
never uploaded as a texture, only blitted from) but because iOS Safari
downsamples large decodes, and 4096² is the size this codebase already treats as
the safe ceiling everywhere else.

**The real cost is decoded memory, not disk.** Each 4096² sheet held as an
`ImageBitmap` is 67 MB of RGBA, and the hi-res pass needs the tiles again long
after `buildCards` has finished. Today the app holds roughly a 4032² base atlas
plus a 4096² hi-res atlas — call it 130 MB of texture. Three sheets would add
200 MB on top of that, which is not acceptable; one or two is.

That gives the two sizes worth shipping:

| key | rows | tile | sheets | committed | decoded | base slot |
|---|---|---|---|---|---|---|
| `…:900` | 900 | 128 px | 1 | ~3.4 MB | 67 MB | 128 px — photographs legible unzoomed |
| `…:3000` | 3,000 | 96 px | 2 | ~6.6 MB | 134 MB | 64 px — a mosaic that resolves on zoom |

Both fit inside 30 MB several times over, and together they cost about 10 MB
against the 3.4 MB `public/` holds today. Disk is not the binding constraint;
3,136 rows and 134 MB of `ImageBitmap` are. If the decoded figure proves too
high on a weak GPU, the fix is to `close()` the sheets after `buildCards` and
re-`fetch`/re-decode lazily for the hi-res pass — the browser HTTP cache makes
the re-fetch free and the hi-res pass already commits atomically
(`src/gl/hires.ts:65` `planReady`), so it can tolerate waiting a frame or two
for a decode. `scripts/perf-probe.mjs` already reports bytes handed to textures
and buffers, so this is measurable rather than arguable.

---

## 2. The sources

Assessed against what this engine actually needs: several good facets, a bulk
route to both the data and the images, a licence that survives redistribution in
a public repo, and an offline runtime. An API that must be called at runtime is
disqualifying — the app ships to GitHub Pages and to an airgapped Posit Connect
mount with a CSP that blocks every external browser resource (`posit-connect`
skill, "Harry's prod is AIRGAPPED"). A build-time API call is fine: `pipeline/`
already establishes Python-with-network as a build step.

> **Correction, added while implementing this plan.** The Posit Connect half of
> that sentence is wrong. Connect is one of the environments Harry deploys to
> for his day job; it is not where Tessera is going, and the `posit-connect`
> skill's airgapped-prod description was imported here as a background fact
> rather than because anyone had said it applied. Tessera ships to GitHub Pages.
>
> Nothing downstream of the error had to change, because every constraint it
> imported is independently required by a static host: relative asset paths are
> needed for Pages' `/tessera/` project-page base (`vite.config.ts` already sets
> `base: './'`, and `scripts/_verify-subpath.mjs` predates this plan), and an
> API called at runtime is just as disqualifying on Pages, so no source in the
> table below was rejected for a reason that has since evaporated.
>
> The one decision the CSP claim *could* have changed is §1's sprite sheets: with
> no CSP forbidding it, the app could have hotlinked Commons thumbnails at
> runtime instead of committing prebaked sheets. That design still stands on its
> own, and §1 makes the argument without needing the airgap — `buildCards`
> (`src/app.ts:345`) is synchronous, so every image must already be decoded
> before it runs, and 3,000 individual fetches are untenable whatever the CSP
> permits.
>
> Kept rather than edited away, because the rest of this document is a dated
> record of what was believed and measured on 2026-09-03, and a premise that
> silently drove design decisions is worth being able to find later.

| Source | Rows with an image | Facets | Images | Data licence | Image licence | Bulk? |
|---|---|---|---|---|---|---|
| **AVONET × Wikidata × Commons** | ~9–10k joinable; ~2.9k after a PD/CC0 filter | 6 categorical + 8 numeric + coordinates, all measured below | Commons, one fetch per file | CC BY 4.0 (AVONET) + CC0 (Wikidata) | mixed; 24 % PD/CC0 in my sample | traits yes (21.5 MB); images no |
| **Art Institute of Chicago** | 132,733 artworks, `is_public_domain` filter | department, classification, type, place, date, medium, plus dominant-colour HSL | IIIF, arbitrary width | CC0 | CC0 for public-domain works | 120 MB tarball (stale — see below) |
| **iNaturalist open data** | >70 M photos, ~monthly snapshot | taxon + rank + quality grade; traits must be joined | one S3 host, six fixed sizes | CC0 metadata | CC0 / CC-BY / CC-BY-NC only | yes, but 33 GB of CSV |
| **Met Museum** | 248,472 public-domain objects | 54 columns | API per object, two fixed sizes | CC0 | CC0 for public-domain works | CSV yes (318 MB); images no |
| **Open Food Facts** | ~3–4 M products | categories, brands, countries, Nutri-Score, NOVA, full nutrients | 200 px derivative; AWS bucket | ODbL | CC-BY-SA 3.0 | yes |
| **GBIF** | 154.9 M animal occurrences with a still image | occurrence fields; traits need a join | third-party hosts | per-dataset CC0/BY/BY-NC | free text, per record | DwC-A yes |
| **EOL TraitBank** | 1.7 M taxa, 11 M trait records | rich, but schema is URI soup | manifest of URLs only | per-object CC | per-object CC | Zenodo, 592 MB |
| **IUCN Red List** | ~172,600 assessments | category, trend, habitat, threats | none | **redistribution prohibited** | — | no |
| **DBpedia** | infobox-derived | thin and inconsistent | `foaf:depiction` → Commons | CC BY-SA 3.0 + GFDL | as Commons | dumps, but ~4 years stale |
| **NASA / ESA** | large | caption and date; no structured facets | yes | PD / CC BY 4.0 | PD / CC BY 4.0 | partial |
| **PokéAPI sprites** | 1,351 | type, stats — an excellent shape | GitHub repo | — | **Pokémon Company copyright** | yes |

### 2.1 Wikidata, Wikimedia Commons and the bird-trait join — measured today

Wikidata's structured data is CC0: "All structured data in the main, property
and lexeme namespaces is made available under the Creative Commons CC0 License"
(<https://www.wikidata.org/wiki/Wikidata:Licensing>, fetched 2026-09-01). Text in
other namespaces is CC BY-SA 4.0, which does not affect statement values.

I ran the counts rather than guessing them, against
<https://query.wikidata.org/sparql> on 2026-09-01 with a compliant User-Agent
(the policy at
<https://foundation.wikimedia.org/wiki/Policy:Wikimedia_Foundation_User-Agent_Policy>
is enforced, and the endpoint times out at 60 s):

| query | count |
|---|---|
| bird species (`P105`=species, `P171+`→Aves) with an image (`P18`) | **12,027** |
| …also with an English common name (`P1843`) | **11,120** |
| …also with an IUCN status (`P141`) | **10,214** |
| mammal species with an image | **4,970** |
| …also with an IUCN status | **3,310** |
| …also with a mass (`P2067`) | **191** |

That last row is the finding that shapes everything. **Wikidata gives you the
picture and the classification; it does not give you the numbers.** Mass is
present on 3.8 % of imaged mammal species. A Tessera collection with no numeric
column has no Scatter and no Cross-tab, so Wikidata cannot be the whole source —
it is the image index and nothing more.

Two further traps. Adding `OPTIONAL` clauses to the counting queries above
pushed them past the 60 s ceiling and returned 502; the working pattern is one
narrow query per figure. And `P171+ wd:Q5113` sweeps in extinct taxa — the first
two rows of a `LIMIT 200` sample were a pterosaur and *Jeholornis*, whose `P18`
is palaeoart, not a photograph. Any pipeline built on Wikidata's taxonomy alone
must exclude fossil taxa; joining against a list of extant species does it for
free.

**Commons thumbnails.** There is no bulk media dump — Commons has not published
one since about 2013 (`Commons:Dumps_and_backups`, phab T298394) — so images are
fetched one file at a time. The correct route is the `imageinfo` API with
`iiurlwidth`, which returns the thumbnail URL directly and saves reimplementing
the MD5 path bucketing:

```
https://commons.wikimedia.org/w/api.php?action=query&format=json&prop=imageinfo
  &titles=File:A.jpg|File:B.jpg…            (25–50 titles per call)
  &iiprop=extmetadata|url&iiurlwidth=250
  &iiextmetadatafilter=LicenseShortName|Artist|AttributionRequired|LicenseUrl|Credit
```

Asking for 128 px returns a **250 px** file: production thumbnails are rounded
up to standard buckets, so request 250 and downscale in the build step. The
`extmetadata` property is documented as expensive — batch it and go serial, per
<https://www.mediawiki.org/wiki/API:Etiquette>.

**The licence mix, measured.** I pulled 200 bird `P18` filenames from Wikidata
and read `extmetadata` for all of them (199 resolved), on 2026-09-01:

| licence | files |
|---|---|
| CC BY-SA (2.0 / 2.5 / 3.0 / 3.0-de / 4.0) | 117 (59 %) |
| Public domain / CC0 / "No restrictions" | 48 (24 %) |
| CC BY (2.0 / 2.5 / 3.0 / 4.0) | 34 (17 %) |

`AttributionRequired` was `true` for 151 of 199 (76 %), and 11 files (5.5 %)
carried no `Artist` field at all — a file you cannot attribute is a file you
cannot ship under CC-BY, so those must be dropped.

The 24 % figure is load-bearing. Filtering 12,027 imaged bird species down to
public-domain and CC0 files leaves **roughly 2,900** — which is, by coincidence,
almost exactly the atlas's 3,136-row per-item ceiling. A collection built only
from PD/CC0 Commons photographs needs no attribution column at all and is
exactly the size the engine wants.

**AVONET supplies the numbers.** Tobias et al. 2022, on Figshare at
<https://figshare.com/articles/dataset/16586228>. The Figshare API reports
`"license": {"name": "CC BY 4.0"}`, version 7, published 2022-12-05,
`AVONET Supplementary dataset 1.xlsx` at 21.5 MB — verified by fetching
`https://api.figshare.com/v2/articles/16586228` directly. I downloaded the
workbook and read the `AVONET1_BirdLife` sheet:

- **11,009 rows**, one per extant bird species.
- Categorical: `Order1` (36 levels), `Family1` (243), `Habitat` (12 — Forest
  6,319; Shrubland 1,385; Woodland 948; Grassland 800; Wetland 649; Marine 273;
  Rock 129; Human Modified 121; Coastal 113; Riverine 104; Desert 70; 98 NA),
  `Trophic.Niche` (11 — Invertivore 5,311; Omnivore 1,921; Frugivore 1,202;
  Aquatic predator 797; Granivore 694; Nectarivore 555; Vertivore 319; two
  Herbivore classes; Scavenger 22), `Trophic.Level` (5), `Primary.Lifestyle`
  (5 — Insessorial 6,572; Terrestrial 2,351; Generalist 972; Aerial 832;
  Aquatic 282), `Migration` (3 levels, coded 1–3), `Habitat.Density`
  (3, coded 1–3).
- Numeric, **complete for all 11,009 rows**: `Mass` (1.9 g to 111 kg, median
  35.5 g), `Wing.Length`, `Beak.Length_Culmen`, `Beak.Depth`, `Beak.Width`,
  `Tarsus.Length`, `Tail.Length`, `Hand-Wing.Index` (0.1–74.3).
- `Range.Size` km² for 10,952 rows, and `Centroid.Latitude` /
  `Centroid.Longitude` for 10,950.

Those last two matter more than they look. `Dataset.geo`
(`src/data/columnar.ts`) already turns a lon/lat pair into an equal-aspect map
layout, and the night-lights renderer already exists. **AVONET gives Tessera a
world map of birds for nothing.**

`Mass` needs handling: equal-width binning over [1.9, 111000] would put
essentially every row in the first of the twelve bins the Bars and Cross-tab
layouts use. The repo's own rule is that heavy-tailed numerics get clipped at
generation; here the right move is to ship `Mass` for the Scatter axis *and* an
ordered `Mass band` category (`categoryFromCodes` preserves the order you pass)
so bucketing reads.

### 2.2 Art Institute of Chicago

The strongest non-biological candidate, and the one whose images are easiest to
get at the size we want. I confirmed against
`https://api.artic.edu/api/v1/artworks/27992` on 2026-09-03 that a single
response carries `is_public_domain`, `department_title`, `classification_title`,
`artwork_type_title`, `place_of_origin`, `date_end`, `medium_display`,
`image_id` — and a dominant-colour object, `"color": {"h": 59, "l": 52,
"s": 12, "percentage": …, "population": …}`. The response's own `info.license_text`
states that "All other data in this response is licensed under a Creative
Commons Zero (CC0) 1.0" with the `description` field carved out as CC-BY 4.0.
132,733 artworks in total (from `pagination.total`), of which over 50,000 images
are open access.

The HSL colour field is a genuinely unusual facet and it pairs with machinery
this repo already has: `Dataset.rgb` and the True-colour mode were built for the
pixel collections, and a collection of paintings sorted and coloured by their
own dominant hue would use them for the first time on card data.

Two caveats I verified and one I could not. The bulk tarball at
`https://artic-api-data.s3.amazonaws.com/artic-api-data.tar.bz2` is **120 MB**
(`Content-Length: 119891546`) with `Last-Modified: Sun, 16 Feb 2025` — so the
"refreshed monthly" claim in their README is not currently true, and the dump is
eighteen months stale. The API itself is current, keyless, and rate-limited to
60 requests a minute anonymously, which is 50 minutes for a 3,000-row prebake —
tedious but a one-off. What I could **not** verify is the IIIF thumbnail: both
`https://www.artic.edu/iiif/2/<image_id>/full/128,/0/default.jpg` requests I made
from this machine returned HTTP 403 with an HTML body, which looks like bot
protection rather than a wrong URL. The syntax is standard IIIF Image API 2.0
and is what AIC documents, but I have not fetched a byte through it and someone
should before committing to it.

### 2.3 iNaturalist open data

The cleanest photograph source of all, and the only one where the images live on
a single host with a documented URL scheme. From the README at
<https://github.com/inaturalist/inaturalist-open-data> (fetched 2026-09-01):
the path is
`https://inaturalist-open-data.s3.amazonaws.com/photos/[photo_id]/medium.[extension]`,
with sizes `original` 2048 px, `large` 1024, `medium` 500, `small` 240,
`thumb` 100 and `square` exactly 75×75 cropped. Only Creative Commons and
public-domain photos are in the bucket. The required attribution strings are
given verbatim: `"[observer name, or observer login], no rights reserved (CC0)"`
for CC0, and `"© [observer], some rights reserved ([license])"` otherwise.

`photos.csv.gz` carries `photo_id, observation_uuid, observer_id, extension,
license, width, height, position` — `position` 0 is the primary photo and
`license` is per photo, so the CC-BY-NC subset can be excluded cleanly.
`observations.csv.gz` carries `quality_grade`, so research-grade filtering is
possible offline.

I took the file sizes myself with HTTP HEAD on 2026-09-03, against a snapshot
dated 27 August 2026:

| file | size |
|---|---|
| `photos.csv.gz` | 20.15 GB |
| `observations.csv.gz` | 13.08 GB |
| `taxa.csv.gz` | 39.8 MB |
| `observers.csv.gz` | 17.0 MB |

33 GB of streaming decompression is a real build cost, though a single pass with
`zcat | awk` is enough and the taxa table is trivially small. The deeper problem
is that iNaturalist gives you a taxon and a photograph and almost nothing else —
no mass, no diet, no habitat. Any facets beyond taxonomy still have to be joined
from a trait source, which puts you back at §2.1 with a much larger download.

### 2.4 The Met

248,472 objects flagged `Is Public Domain = True` out of 484,956 rows, across 54
columns including Department, Object Name, Culture, Period, Medium,
Classification, Object Begin/End Date, Artist Nationality and Artist Gender.
`MetObjects.csv` is 317,650,992 bytes — I confirmed the length against the
git-LFS media URL. Data is CC0.

It loses to AIC on one practical point. The CSV carries no image URL, so you
call `/objects/{id}` per row, and `images.metmuseum.org` serves only `original`
and `web-large` — there is no arbitrary resize. Fetching 3,000 web-large JPEGs
to make 3,000 128 px thumbnails means downloading on the order of a gigabyte to
throw 99 % of it away. AIC's IIIF endpoint, if it works, asks for 128 px and
sends 8 kB.

### 2.5 The ones that do not survive contact

**IUCN Red List** is the clearest rejection and it is worth stating plainly
because conservation status is exactly the facet one reaches for first. Their
terms prohibit redistribution: "All forms of reposting, and any sub-licensing,
reselling, or other forms of redistribution of IUCN Red List Data in their
original format, either whole or in part, alone or combined with other data,
including within Derivative Works, are strictly prohibited without the prior
written permission of IUCN." Baking IUCN categories into a committed asset is
precisely the prohibited act. *I could not fetch
<https://www.iucnredlist.org/terms/terms-of-use> directly — it returns 403 to
automated clients — so this quotation reached me through search results
reproducing that page, and someone should read it in a browser before relying on
my reading of it.* Note that Wikidata's `P141` is a separate CC0 statement about
a species rather than a copy of the Red List database; whether that distinction
holds up is a question for a person, not for me.

**DBpedia** fails on three independent grounds. Its licence is CC BY-SA 3.0 plus
GFDL — share-alike, where Wikidata is CC0. Its flagship Snapshot release appears
to have stalled at 2022-12, which is close to four years stale, and the project's
own Wikipedia infobox still cites 2016-10. And `dbpedia.org/sparql` is a single
community-run Virtuoso instance against Wikidata's WMF-operated service. Since
DBpedia's images are `foaf:depiction` pointers at the same Commons files
Wikidata's `P18` points at, it offers nothing Wikidata does not, at a worse
licence and a worse freshness. **Skip it.**

**GBIF** has the occurrences — 154,887,398 animal occurrences carry a still
image — but GBIF hosts none of them. The multimedia extension stores a URL and
the licence field is, in GBIF's own words, essentially free text, so a build
would dereference thousands of third-party hosts and then have to parse
freeform licence strings. That is a lot of moving parts for a demo. The
GBIF Backbone Taxonomy (hosted-datasets.gbif.org) is a fine name-resolution
service if a join needs one.

**EOL** may still be the richest trait source — TraitBank claims 1.7 M taxa and
11 M trait records, and the archive is on Zenodo (record 13305577, ~592 MB) —
but the accompanying image manifest (record 13136202) is listed on Zenodo as
"License Not Specified", and I could not fetch eol.org's own terms page (403).
Its maintenance status in 2026 is unclear to me. Too many unknowns to build on
without a human checking.

**Open Food Facts** has the best numeric facets of anything here — Nutri-Score,
NOVA group and a full per-100 g nutrient block are made for Cross-tab and
Scatter — and there is an AWS image bucket. But the images are CC-BY-SA 3.0,
which is share-alike, and OFF themselves caution that a product photograph
contains packaging design and logos they do not own. A sprite sheet of a few
thousand supermarket packets is a licensing conversation, not a data pipeline.

**NASA and ESA** are licence-clean (US public domain and CC BY 4.0 respectively,
per <https://esahubble.org/copyright/>) and facet-poor: title, caption, date,
centre and free-text keywords. You would be inventing the facets yourself. The
NASA Exoplanet Archive has superb numerics and no images at all.

**Pokémon** should be stated bluntly because the shape is so tempting — 1,351
rows, types, stats, one sprite each. The sprites repo's own `LICENSE.txt` says
"All image contents within are Copyright The Pokémon Company. This repository is
distributed under CC0 1.0 Universal", which is self-contradictory: the
maintainers cannot CC0 rights they do not hold. Kaggle mirrors carrying a CC0
badge do not change who owns the artwork. Do not ship it. The same reasoning
disposes of BoardGameGeek box art (non-commercial terms, publisher copyright)
and of any Star Wars imagery bolted onto SWAPI's MIT-licensed text.

---

## 3. Attribution

The repo already has the pattern: `public/data/CREDITS.md` is a table of file,
work, author and source link, with an "## Images" section and now a "## Data"
section. It scales to three files. It does not scale to three thousand, and more
to the point a per-image credit belongs *on the record*, not in a file nobody
opens.

Three tiers, in increasing order of nuisance:

**Public domain and CC0 only.** No attribution is legally required. `CREDITS.md`
gains a paragraph naming the source, the filter applied, and the date of the
pull; the collection needs no extra columns. §2.1 measured what this costs —
about 24 % of Commons bird photographs survive it, roughly 2,900 species, which
happens to be the number the atlas wants. **This is the option I would take.**

**CC-BY.** Each image needs its author and licence carried per row and shown to
the viewer. In Tessera that is two `text` columns (`Photographer`, from
`extmetadata.Artist` with its HTML stripped) and one `category` column
(`Photo licence`, over the six or so distinct values), plus a `derivedText`
column for the Commons file URL — derived, not stored, because it is a formula
over the filename (`src/data/columnar.ts` `derivedText`, and see the README on
why identity columns are not materialised). The credit then appears in the record
modal as a `DetailSection` — the `detail` template already supports exactly this
(`src/data/card.ts` `DetailTemplate.sections`) — and `CREDITS.md` gains a
pointer saying that per-image credit lives in the data and is shown on every
record. A file with no `Artist` field is dropped at build time; 5.5 % of my
sample would have been.

**CC-BY-SA.** Everything CC-BY requires, plus an argument about whether a sprite
sheet of share-alike images is a collection (no obligation on the sheet) or an
adaptation (the sheet itself must be CC-BY-SA). The safe reading is the second,
which means the sheet ships with its own licence notice and cannot be quietly
absorbed into the repo's licence. That is survivable — the asset carries a
licence, the code does not — but it is a decision someone has to take
deliberately, and it is the reason I would rather filter to PD/CC0 and not have
the conversation.

Whatever the tier, the build step must write the licence and author it actually
saw into a committed manifest, so the credit in the shipped data is reproducible
rather than remembered.

---

## 4. Ranked recommendation

### First — *Birds of the world*: AVONET traits, Wikidata images, Commons files

Everything the request asked for, with better facets than the "animals by
kingdom / habitat / diet" sketch would have produced. Habitat and trophic niche
are real, curated, complete columns rather than something scraped out of prose;
mass, wing length and hand-wing index give the Scatter and Cross-tab layouts
genuine numeric axes; order and family give the Bars layout a hierarchy; and the
range centroids light up the map layout that already exists. Trophic niche
against hand-wing index is a chart with an actual finding in it — aerial
insectivores separate from terrestrial granivores along the wing axis — which is
the kind of thing the guided tour is built to narrate.

**Main risk: the join, and then the licence filter.** AVONET is keyed on
BirdLife taxonomy; Wikidata is keyed on `P225` and is inconsistent about
synonyms. I have not run the join, so I do not know the hit rate — my estimate
is 80–90 % on binomials with a synonym pass, and it could be worse. Applying the
PD/CC0 filter on top takes ~12,000 imaged species to roughly 2,900. If both go
badly the collection lands under a thousand rows, which is still a good `:900`
collection but not a mosaic. **Run the join before committing to the plan**; it
is an hour of Python and it settles the question.

### Second — Art Institute of Chicago

CC0 data and CC0 images from one institution, no licence filtering, no join, and
a dominant-colour HSL field that would light up the True-colour mode built for
the pixel collections. Sorting 3,000 paintings by their own hue is a picture this
engine should be able to draw, and nothing else in the list offers it.

**Main risk: the images.** The IIIF endpoint returned 403 to every request I made
from this machine, so the one thing that makes AIC better than the Met is the
thing I could not verify. The bulk tarball is also eighteen months stale, which
pushes you onto the 60-requests-a-minute API. And artwork thumbnails are a
harder visual problem than wildlife: aspect ratios run from a coin to a
twelve-foot canvas, and a square crop of *La Grande Jatte* is a patch of grass.
Letterboxing onto the card's accent is the honest answer and it costs card area.

### Third — iNaturalist open data joined to AVONET

The best photographs, on one host, with a per-photo licence column that makes the
CC0-only filter trivial, and 500 px sources so the hi-res tiers are properly fed.
If the Commons licence filter in option one turns out to bite harder than 24 %,
this is where the images should come from instead, with AVONET still supplying
every facet.

**Main risk: cost and yield.** 33 GB of CSV to stream for what ends up as 3,000
rows, and no guarantee that a research-grade CC0 photograph exists for each of
the species AVONET describes — commonly-photographed European and North American
birds will be over-represented and the long tail will be empty. That skew is
itself visible in the collection, which is arguably interesting and arguably a
defect.

---

## 5. Sketch of the first choice

**Keys.** `birds:900` and `birds:3000`, registered in `src/data/registry.ts` as
a family with a `load` that is `async` (like `pixels`), because it fetches.
`labelColumn` is `Common name`.

**Columns**, in the order the facet list should declare them — facet order
drives the default colour, sort, bucket and axes (`src/app.ts`, and plan B's
note on the same):

| column | kind | notes |
|---|---|---|
| `Common name` | text | Wikidata `P1843` @en, falling back to `rdfs:label` |
| `Scientific name` | text | AVONET `Species1`; the join key |
| `Order` | category (36) | AVONET `Order1` |
| `Family` | category (243) | AVONET `Family1` — too many for the 8-slot palette, so a facet and a bucket, never the colour-by |
| `Habitat` | category (11 + NA) | Forest, Shrubland, Woodland, Grassland, Wetland, Marine, Rock, Human Modified, Coastal, Riverine, Desert |
| `Diet` | category (11) | AVONET `Trophic.Niche`, relabelled: Invertivore → *Insects*, Frugivore → *Fruit*, and so on |
| `Trophic level` | category (4) | Carnivore, Herbivore, Omnivore, Scavenger |
| `Lifestyle` | category (5) | Insessorial → *Perching*, plus Terrestrial, Aerial, Aquatic, Generalist |
| `Migration` | category (3, ordered) | Sedentary → Partial → Migratory; AVONET codes 1–3 |
| `Habitat density` | category (3, ordered) | Dense → Semi-open → Open |
| `Mass band` | category (7, ordered) | derived from `Mass`: under 10 g, 10–25, 25–60, 60–150, 150–500, 500 g–2 kg, over 2 kg |
| `Mass` | number (g) | 1.9–111,000; `format` as g or kg |
| `Wing length` | number (mm) | complete |
| `Beak length` | number (mm) | `Beak.Length_Culmen` |
| `Tail length` | number (mm) | complete |
| `Hand-wing index` | number | 0.1–74.3; the dispersal-ability axis, and the most interesting one |
| `Range size` | number (km²) | 10,952 of 11,009 |
| `Longitude`, `Latitude` | number | `Centroid.*`, declared as `geo` |

**Facet order:** `['Order', 'Habitat', 'Diet', 'Trophic level', 'Lifestyle',
'Migration', 'Habitat density', 'Mass band', 'Family', 'Mass',
'Hand-wing index', 'Wing length', 'Beak length', 'Tail length', 'Range size']`.
That makes the default colour-by `Order` — which has 36 levels and would fold
past the eighth into "Other" (`src/core/palette.ts`), so either `Dataset.colors`
pins the twelve largest orders, or `Habitat` leads instead and `Order` moves
down. `Habitat` leading is probably right: eleven levels, semantically obvious,
and it makes the opening map read as a habitat map of the world.

**Card template** (`src/data/card.ts`): `topic` = `Order`, `title` =
`Common name`, `blurb` = `Scientific name`, `tags` = `Habitat` (pill) and `Diet`
(dot), `metric` = `Mass` with a unit label, and a new `custom: 'photo'` painter.
`detail` adds a *Measurements* section (the five morphometrics), a *Where* section
(range size, centroids, migration) and `context: ['Habitat', 'Diet', 'Order']`.

**The build pipeline**, as a second `uv` script alongside `pipeline/segment.py`
— the precedent is established, and this needs pandas, `openpyxl`, `requests`
and Pillow, none of which belong in the web app:

1. Read `AVONET1_BirdLife` from the workbook (21.5 MB, committed to the pipeline
   directory or fetched once). 11,009 rows.
2. One SPARQL query to `query.wikidata.org` for every species-rank bird taxon
   with `P18`, returning taxon name, English common name and image filename as
   CSV. Keep it to one narrow query — `OPTIONAL`s time the endpoint out.
3. Join on binomial, with a synonym pass through `P1420` (taxon synonym) for the
   misses. **Report the hit rate; this is the number the whole plan rests on.**
4. Batch the surviving filenames through the Commons `imageinfo` API, 25 titles
   per call, serial, with a contact-bearing User-Agent, asking for
   `iiurlwidth=250` and `extmetadata`. Keep only files whose `LicenseShortName`
   is public domain or CC0; drop any with no `Artist`.
5. Take the top 3,000 by data completeness with a per-order quota so the
   taxonomy is not all passerines, then the top 900 of those for the small
   collection.
6. Fetch each 250 px thumbnail, centre-crop to square, resize to 128 px (900) or
   96 px (3,000) with Lanczos, and tile into 4096² sheets in row order —
   `public/data/birds-<n>-<sheet>.webp` at q70.
7. Write `public/data/birds-<n>.json`: the columns as plain arrays, plus the
   sheet manifest (tile size, tiles per row, row → sheet index) and the credit
   manifest. Roughly 300 kB for 3,000 rows before gzip; the images are the
   payload, the data is a rounding error.
8. Write `public/data/CREDITS.md`'s new section from what step 4 actually saw,
   not from what the plan assumed.

**What changes in `src/gl/cards/`.** Less than it sounds, because the painter
architecture already anticipates this.

- `src/data/card.ts:41` — `export type CustomCard = 'taxCase' | 'photo';`
- `src/gl/cards/index.ts:13` — register `photo: photoPainter` in `CUSTOM`.
- A new `src/gl/cards/sheet.ts`: a module-level `Map<string, PhotoSheets>`
  holding the decoded `ImageBitmap`s and the tile geometry, set by the loader
  before `buildCards` runs and keyed by `Dataset.kind`. It goes here rather than
  on `Dataset` because a dataset must stay cloneable for the worker transfer,
  and because the map is renderer state, not data.
- A new `src/gl/cards/photo.ts`: `photoPainter(ds)` looks the sheets up by
  `ds.kind`, and for a spec with a `row` draws
  `ctx.drawImage(sheet, sx, sy, tile, tile, 0, 0, w, photoH)` into the top band
  of the card, then calls the existing `paintFace` (`src/gl/atlas.ts:239`) for
  the text below it with the header band suppressed. Everything else — the
  accent, the tags, the metric, the clipping, the mip bleed — is unchanged.
  A spec with no `row` still falls through to `drawCover` (`src/gl/atlas.ts:286`),
  so the above-3,136 path keeps working untouched.
- `src/data/birds.ts`: `loadBirds(size)` fetches `data/birds-<n>.json` and the
  sheets with relative paths (the same shape as `src/data/pixels.ts:481`, which
  is what keeps the sub-path mount working), `createImageBitmap`s each sheet,
  registers them in `sheet.ts`, and returns the `Dataset`. It must resolve
  before `buildCards` is called, which `resolveDataset` already guarantees since
  it is awaited.
- Optionally, a `Dataset.rgb` of each bird's mean thumbnail colour, computed in
  the build step for a few kB. True colour on a mosaic of 3,000 birds is a
  picture worth having, and the mode already exists.

**What to check afterwards.** `tests/card-template.test.ts` already asserts that
every declared slot names a column that exists at every size, so the template is
covered for free. `scripts/perf-probe.mjs` reports texture bytes, which is where
the 67-or-134 MB of `ImageBitmap` shows up and where the decision about
releasing the sheets gets made on evidence. And `scripts/_verify-subpath.mjs`
switches to a pixel collection to prove `public/data` resolves under a
`/tessera/` mount — it should be taught to switch to `birds:900` too, since that
is now a second thing the app fetches at runtime.

---

## 6. What I could not verify

- **The AVONET ↔ Wikidata join hit rate.** Estimated at 80–90 %, not measured.
  It is the single number that decides whether option one is a 3,000-row
  collection or a 900-row one.
- **The AIC IIIF thumbnail endpoint.** Two requests, two 403s with HTML bodies,
  from this machine. The API itself works; the image server did not answer me.
- **The IUCN terms-of-use page**, which 403s to automated clients. The quoted
  prohibition reached me second-hand and should be read in a browser before
  anyone relies on my reading of it. The same applies to the Met's open-access
  terms page (429 on every attempt) and EOL's terms page (403) — in all three
  cases the licence claims above rest on corroborating sources, not on the
  primary page.
- ~~**AVIF encoding**, not tested here; likely 20–30 % smaller than the WebP
  figures in §1.1, at some build cost.~~ **Settled during implementation: 5–7 %
  smaller at matched quality, not 20–30 %, and ~25 % faster to decode — see the
  correction in §1.1. The build now ships AVIF q65.**
- ~~**`createImageBitmap` decode time for a 4096² WebP**, which needs a browser to
  measure and which lands directly in the load-time budget `perf-probe` reports.~~
  **Measured during implementation: ~342 ms for a 4096² WebP q70 sheet, ~258 ms
  for the AVIF q65 that replaced it, in headless Chromium (`scratch/decode-probe.mjs`).
  Both figures are on the synthetic sheets of §1.1, so they carry that section's
  ±25 % caveat until re-run against the real bird sheets.**
- **Whether Wikidata's `P141` is a lawful restatement of an IUCN category or a
  copy of restricted data.** That is a question for a person.
- The thumbnail size figures in §1.1 are measured on crops of the three
  paintings in `public/data/`, not on wildlife photographs. The ratios are
  reliable; the absolute per-tile bytes are within about ±25 %.
