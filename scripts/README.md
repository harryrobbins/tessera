# Benchmark runner

`scripts/bench-headless.mjs` drives the app in a real Chromium (via Playwright)
and records FPS for each dataset size / phase the page-side bench exposes.

## Run it

```
pnpm bench
```

That's `node scripts/bench-headless.mjs` under the hood. Flags:

| flag              | default            | meaning                                                                 |
|--------------------|--------------------|--------------------------------------------------------------------------|
| `--port`           | `5181`             | port for the dev server (and the URL the browser navigates to)          |
| `--out`            | `bench-results/`   | directory results are written to (relative paths resolve from repo root)|
| `--label`           | `os.hostname()`    | machine/run label used in the output filename and JSON                  |
| `--swiftshader`     | off                | force `--use-gl=swiftshader` for a reproducible CPU-only baseline       |
| `--headed`          | off                | run a visible Chromium via WSLg instead of headless                     |
| `--keep-server`     | off                | attach to an already-running dev server at `--port` instead of spawning one |

Examples:

```
pnpm bench --label my-laptop
pnpm bench --swiftshader --label my-laptop-cpu-baseline
pnpm bench --headed
pnpm exec vite --port 5181 --strictPort &   # in one terminal
pnpm bench --keep-server --port 5181        # in another
```

The script starts `pnpm exec vite --port <port> --strictPort` itself (unless
`--keep-server` is given), waits for it to answer, navigates to
`http://127.0.0.1:<port>/?bench=1`, waits for `window.pivotBenchReady`, then
calls `window.runPivotBench()` and waits for it to resolve (this can take up
to ~10 minutes for large datasets). The dev server's own stdout/stderr is
forwarded prefixed with `[vite]`, and the page's console output is forwarded
prefixed with `[page]`, so a hang is diagnosable from the terminal. The dev
server's whole process group is always killed on exit, on failure, and on
Ctrl-C — unless you passed `--keep-server`, in which case it's left running.

## GPU vs. software rendering (WSL2)

This box has `/dev/dxg` (WSL2 GPU passthrough). By default the script launches
Chromium with `--use-angle=vulkan --enable-features=Vulkan
--ignore-gpu-blocklist --enable-gpu-rasterization --enable-zero-copy
--use-gl=angle`, which gives Chromium the best chance of picking up the real
GPU instead of falling back to SwiftShader. There's no hard guarantee it
succeeds, so **always check the printed report**: the `Browser:` line shows
`gpuMode`, the `Page env:` line includes whatever WebGL-renderer string the
page reports, and if either looks like a software rasterizer
(`swiftshader` / `llvmpipe` / `software`) the report prints a loud warning:

```
*** WARNING: renderer looks like a SOFTWARE rasterizer (SwiftShader/llvmpipe). ***
*** THESE NUMBERS ARE CPU-RASTERISED AND NOT REPRESENTATIVE.                  ***
```

Numbers produced under software rendering are not comparable to numbers from
real GPU rendering — don't put them side by side as if they were.

Pass `--swiftshader` when you *want* the CPU-only path deliberately — e.g. to
get a reproducible baseline that doesn't depend on which GPU a given machine
has. That forces `--use-gl=swiftshader` and the report will (correctly) show
the same warning; that's expected in this mode, not a bug.

### Headed mode on WSLg

`--headed` runs a visible Chromium window via WSLg (`DISPLAY=:0`) instead of
headless. Headed mode sometimes gets a more reliable real-GPU path than
headless does on WSL2, so if the headless run keeps landing on SwiftShader,
try:

```
pnpm bench --headed --label my-laptop
```

A Chromium window will appear on the Windows desktop while the benchmark
runs. Everything else (server lifecycle, output, teardown) works the same as
headless.

## Comparing two machines

Every run writes two files into `--out` (default `bench-results/`):

- `<label>-<timestamp>.json` — a permanent, timestamped record of that run.
  `<timestamp>` is `new Date().toISOString()` with `:` replaced by `-` (so
  it's filesystem/Windows-safe), e.g. `my-laptop-2026-08-26T10-15-30.123Z.json`.
- `latest.json` — overwritten every run, always the most recent result
  (regardless of label) for quick access.

Each JSON file has the shape:

```
{
  "label": "...",
  "timestamp": "2026-08-26T10:15:30.123Z",
  "node": { hostname, cpuModel, cpuCount, totalMemBytes, totalMemGB, nodeVersion, platform, arch, hasDxg },
  "browser": { name, version, headless, gpuMode, launchArgs },
  "result": { env, runs: [ { dataset, n, phases: [ { name, frames, ms, fps, p50, p95, worst } ], layoutSolveMs } ] }
}
```

To compare two machines (or two configs on the same machine), run
`pnpm bench --label <name>` on each, then diff/inspect the resulting
`<label>-<timestamp>.json` files in `bench-results/` — same dataset/phase
rows, different `node`/`browser`/`fps` numbers. Keep `--label` distinct per
machine (and per GPU-vs-swiftshader run) so files don't collide and so it's
obvious at a glance which file is which; `bench-results/` is intentionally
untouched by the dev server's file watcher (see `vite.config.ts`) so runs
don't trigger reloads.
