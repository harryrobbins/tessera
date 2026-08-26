I want to recreate Microsoft Pivot for a modern web browser using webgl, unless it already exits. 

It used Microsoft Silver light I believe, and maybe some kind of sea dragon style tiling to make zooming smooth.

The killer feature was that you could sort items into a grid and then re-sort them into various graphs.

What exists already, what was the feature list, what would the best modern stack look like?

###

**Microsoft Live Labs Pivot** (and its embeddable counterpart, **PivotViewer**) was a landmark in data visualization. It combined **Deep Zoom** (multi-resolution image pyramids from the Seadragon acquisition) with **Unit Visualizations**—where every dataset record is rendered as an interactive visual object.

---

### What Exists Already

* **Microsoft SandDance:** The official spiritual successor built by Microsoft Research VIDA. It is open source, built on **Deck.gl** and **Vega**, and renders millions of data points into morphing 2D/3D charts, grids, and scatter plots. *Limitation:* It focuses heavily on colored geometry marks/cubes rather than Deep Zoom image cards.
* **HTML5 PivotViewer (LobsterPot / OpenLink):** Early 2010s HTML5 Canvas ports of PivotViewer. *Limitation:* Built with jQuery and standard Canvas 2D context; they struggle with modern frame rates and large datasets.
* **OpenSeadragon:** The modern open-source standard for Deep Zoom image viewing in JavaScript. *Limitation:* Handles single images or static tiled collections well, but lacks the dynamic charting, sorting, and layout engine.

*There is currently no polished, modern WebGL/WebGPU clone that combines true Deep Zoom image tiling with SandDance-style dynamic fluid chart-morphing.*

---

### The Original Feature List

* **Unit Visualization / Object Permanence:** Every row in a dataset is represented by an individual image card. During transitions, cards smoothly tween between spatial coordinates rather than disappearing.
* **Multi-Resolution Deep Zoom:** Images load at low resolutions for macroscopic overviews (thousands of tiny dots) and dynamically stream high-resolution mip levels as the user zooms into a single card.
* **Dynamic Faceted Filtering:** A left-hand facet browser (histograms, categorical checkboxes, range sliders) with instant visual subset filtering.
* **Visual Re-Sorting & Layout Modes:**
* **Grid / Mosaic:** Packed alphabetical or numerical matrix.
* **Categorical Buckets (Bar/Histogram):** Stacking cards vertically into column buckets by attribute.
* **Scatter / Cross-Tabs:** 2D grid matrix along X and Y axes.
* **Timeline / Time Strip:** Arranging items along a continuous date axis.


* **Hierarchical Zoom & Detail Pane:** Clicking an item centers it and zooms to 1:1 resolution, sliding out metadata properties, URLs, and related actions.
* **Collection XML (CXML) & Deep Zoom Collections (DZC):** A standardized format pairing structured item metadata with an image pyramid manifest.

---

### The Best Modern Stack

Building this with modern web standards allows handling $100{,}000+$ items at 60–120 FPS.

#### 1. Rendering Layer: WebGPU / WebGL2 Instancing

* **Deck.gl or Custom Three.js/PixiJS:** Deck.gl excels at GPU-accelerated instanced data layers with built-in camera transitions.
* **GPU Vertex Morphing:** Do not animate card coordinates via CPU JavaScript. Pass the `startPosition` and `targetPosition` as vertex attributes and let a vertex shader interpolate using a single `u_transitionProgress` uniform ($t \in [0, 1]$).

#### 2. Image Pipeline: Texture Streaming & Tile Atlases

* **Texture Format:** Use **KTX2 / Basis Universal** supercompressed textures for fast GPU decompression and tiny network payloads, or standard WebP/AVIF tiles.
* **Dynamic Texture Atlas / Virtual Texturing:**
* Far zoom: A single compressed sprite sheet / mipmap containing $10{,}000$ tiny $32\times32\text{ px}$ thumbnails.
* Mid zoom: Stream higher-res tiles into dynamic GPU texture arrays.
* Near zoom: Seamlessly transition the focused card into an HTML/SVG DOM overlay or high-res texture plane.



#### 3. Data & Query Engine: In-Browser Analytics

* **DuckDB-WASM or Apache Arrow:** Run queries and aggregations directly in the browser across Web Workers.
* Calculating bucket coordinates, categorical groupings, and facet histograms on $100\text{k}$ items takes under $5\text{ms}$ in DuckDB-WASM.

#### 4. Architecture Blueprint

```
┌─────────────────────────────────────────────────────────┐
│                    UI & DOM Layer                       │
│  (React / Svelte: Facet Sidebar, Details Drawer, Search)│
└────────────────────────────┬────────────────────────────┘
                             │ Filters / Layout Changes
                             ▼
┌─────────────────────────────────────────────────────────┐
│              Web Worker: Compute Engine                 │
│  - DuckDB-WASM (Faceted Filtering & Bucketing)          │
│  - Layout Solver (Calculates X, Y, Scale per Item ID)   │
└────────────────────────────┬────────────────────────────┘
                             │ ArrayBuffers (Float32Array)
                             ▼
┌─────────────────────────────────────────────────────────┐
│               GPU Render Engine (WebGPU)                │
│  - Vertex Shader: Animates Pos(A) ➔ Pos(B) over easing  │
│  - Fragment Shader: Samples Texture Atlas / Tile Stream │
│  - Instanced Quads (1 Quad per Data Unit)               │
└─────────────────────────────────────────────────────────┘

```