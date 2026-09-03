# Credits

## Images

All three image files are faithful photographic reproductions of two-dimensional works in
the **public domain** (author died more than 100 years ago), sourced from
Wikimedia Commons.

| File | Work | Author | Source |
|---|---|---|---|
| `starry-night.jpg` | *Starry Night Over the Rhône* (1888) | Vincent van Gogh (1853–1890) | [Commons](https://commons.wikimedia.org/wiki/File:Vincent_van_Gogh_-_Starry_Night_-_Google_Art_Project.jpg) |
| `great-wave.jpg` | *The Great Wave off Kanagawa* (c. 1831) | Katsushika Hokusai (1760–1849) | [Commons](https://commons.wikimedia.org/wiki/File:Great_Wave_off_Kanagawa2.jpg) |
| `millot-papillons.jpg` | *Papillons*, plate from *Le Larousse pour tous* | Adolphe Millot (1857–1921) | [Commons](https://commons.wikimedia.org/wiki/File:Adolphe_Millot_papillons-pour_tous.jpg) |

They are used here only as sample data for the pixel collection.

`millot-papillons.jpg` additionally ships a SAM-generated segmentation mask
(`millot-papillons.segments.png` + `.segments.json`, produced by `pipeline/`)
identifying 58 discrete specimens on the plate.

## Data

`titanic.csv` is the **`titanic3`** dataset: the 1,309 passengers of the RMS
Titanic — crew excluded — with the lifeboat they left in and the body number
of those recovered. It was compiled by Thomas Cason of the University of
Virginia from the [Encyclopedia Titanica](https://www.encyclopedia-titanica.org/)
records, and is distributed for teaching and research by Frank Harrell's
Vanderbilt biostatistics dataset repository:

| File | Dataset | Compiled by | Source |
|---|---|---|---|
| `titanic.csv` | `titanic3` | Thomas Cason, from Encyclopedia Titanica | [hbiostat.org/data](https://hbiostat.org/data/repo/titanic3.csv) |

It is the only collection in Tessera that is not synthetic, and the only one
that names real people — a public historical record of the disaster, which is
the point of showing it. Every other collection invents its people (see
`src/data/taxCases.ts`), and none of them draws on this file.

## Bird images and traits

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
or with no author was dropped. Pulled 2026-09-03:

- 11,009 AVONET species, 9,882 joined to a Wikidata taxon carrying an image (89.8%)
- 12,338 distinct Commons files resolved; 2,400 of them public domain or CC0 (19.5%)
- 82 of those dropped for having no `Artist`
- 2,262 species left with a usable image

| Collection | Rows | Committed |
|---|---|---|
| `birds-2000.json` + 2 sheets | 2,000 | 3.86 MB |
| `birds-900.json` + 1 sheet | 900 | 2.81 MB |

**These are mostly not photographs.** A public-domain-only filter over
Wikimedia Commons does not select modern wildlife photography — almost all of
that is CC BY-SA — it selects work old enough for copyright to have expired.
What survives is largely nineteenth-century ornithological lithography, plus
a minority of modern photographs (chiefly US federal-government work) and a
few museum specimen scans. Six credited authors account for
39 % of the 2,000 rows:

| Author | Rows |
|---|---|
| John Gerrard Keulemans | 363 |
| Joseph Smit | 217 |
| Joseph Wolf | 56 |
| Henrik Grønvold | 51 |
| John Gould | 44 |
| Nicolas Huet / Jean Gabriel Prêtre | 43 |

That is a fair description of the collection, and the cards should be read as
plates from a bird atlas rather than as photographs.

Licences actually seen across the 2,000 shipped rows (the smaller
collection is a strict subset):

| `extmetadata.LicenseShortName` | Files |
|---|---|
| Public domain | 1,650 |
| CC0 | 324 |
| No restrictions | 26 |

No attribution is legally required for any of these, but the build records
what it saw: `birds-<n>.json` carries a `credits` array, row-aligned with the
data, giving the Commons filename, the licence string and the author for every
image in the sheet. 598 distinct authors are named there.
