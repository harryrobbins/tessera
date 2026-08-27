import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import checker from 'vite-plugin-checker';

const ROOT = path.dirname(fileURLToPath(import.meta.url));

/**
 * WSL2: watch source only, as an allow-list.
 *
 * A deny-list is the wrong default here — it watches every directory nobody
 * has thought to exclude yet, and this repo grows them (`pipeline/` alone is
 * 19,000 files, `node_modules/` 26,000; several vite servers run at once
 * during the verification scripts). Chokidar calls this for every candidate
 * path and does not descend into a directory it ignores, so returning true for
 * a top-level directory prunes the whole tree in one test.
 *
 * Everything the browser actually loads lives under `src/`, `public/` or
 * `index.html`; the three config files are single files and are kept watched
 * so editing them still restarts the server.
 */
const WATCHED = new Set(['src', 'public', 'index.html', 'vite.config.ts', 'tsconfig.json', 'package.json']);

function ignoreOutsideSource(file: string): boolean {
  const rel = path.relative(ROOT, file);
  if (!rel || rel.startsWith('..')) return false; // the project root itself
  return !WATCHED.has(rel.split(path.sep)[0]);
}

export default defineConfig({
  // GitHub Pages serves the built demo at /tessera/, not the domain root.
  // Relative base works for every asset kind this app uses, including the
  // layout worker: `new URL('./worker.ts', import.meta.url)` resolves
  // against the *emitting chunk's* import.meta.url, which the browser always
  // sets to its real served location regardless of `base` — verified by
  // building and serving dist/ under a /tessera/ mount with Playwright
  // (worker loads, the public/data JPEGs resolve, first
  // layout completes). Also leaves `pnpm dev` at root untouched.
  base: './',
  // Vite strips types without checking them; this runs tsc alongside and surfaces
  // type errors as a browser overlay. Cheap static analysis, no lint ceremony.
  plugins: [checker({ typescript: true })],
  server: {
    port: 5180,
    // Never poll on the Linux fs; see `ignoreOutsideSource` for the scope.
    watch: { ignored: ignoreOutsideSource },
  },
  build: { target: 'es2022' },
  worker: { format: 'es' },
});
