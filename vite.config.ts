import { defineConfig } from 'vite';
import checker from 'vite-plugin-checker';

export default defineConfig({
  // GitHub Pages serves the built demo at /tessara/, not the domain root.
  // Relative base works for every asset kind this app uses, including the
  // layout worker: `new URL('./worker.ts', import.meta.url)` resolves
  // against the *emitting chunk's* import.meta.url, which the browser always
  // sets to its real served location regardless of `base` — verified by
  // building and serving dist/ under a /tessara/ mount with Playwright
  // (worker loads, titanic.csv and public/data JPEGs both resolve, first
  // layout completes). Also leaves `pnpm dev` at root untouched.
  base: './',
  // Vite strips types without checking them; this runs tsc alongside and surfaces
  // type errors as a browser overlay. Cheap static analysis, no lint ceremony.
  plugins: [checker({ typescript: true })],
  server: {
    port: 5180,
    // WSL2: source-only watching. node_modules is ignored by default; never poll on the Linux fs.
    watch: { ignored: ['**/node_modules/**', '**/bench-results/**', '**/.git/**'] },
  },
  build: { target: 'es2022' },
  worker: { format: 'es' },
});
