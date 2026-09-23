/**
 * The public demo: the library with every feature on — deep links, the guided
 * tour, the benchmark and its window globals, and localStorage — and the
 * layout worker built by Vite from bundler syntax the library itself must not
 * contain.
 */
import './ui/style.css';
import { mountTessera } from './lib';

mountTessera(document.getElementById('tessera')!, {
  urlSync: true,
  tour: true,
  bench: true,
  layoutWorker: () => new Worker(new URL('./layout/worker.ts', import.meta.url), { type: 'module' }),
});
