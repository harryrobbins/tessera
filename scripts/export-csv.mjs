/**
 * Export the synthetic collections as CSV, for looking at the data outside the
 * engine (DuckDB, pandas, a spreadsheet). The columnar store is built to be
 * handed to a GPU, not to be read.
 *
 *   node scripts/export-csv.mjs [outDir] [key ...]
 *
 * With no keys it writes the default set below. The output is gitignored
 * (scratch/): a 100k-row collection is a 20 MB file that is a pure function of
 * the generator, its seed, and nothing else.
 */
import { mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'vite';

const DEFAULT_KEYS = [
  'tax-cases:900', 'tax-cases:3000', 'tax-cases:20000', 'tax-cases:100000',
  'titanic', 'tax-returns:10000', 'payments:10000', 'invoices:10000', 'products:1000',
];

/**
 * Collections that read a committed asset (Titanic) call `fetch` with a
 * document-relative URL, which means nothing to Node. Serve `public/` to them
 * rather than teaching the loaders about two environments.
 */
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = String(input);
  if (!/^[a-z]+:/i.test(url)) {
    const body = await readFile(resolve('public', url));
    return new Response(body, { status: 200 });
  }
  return realFetch(input, init);
};

/** RFC 4180: quote anything holding a comma, quote, newline or edge whitespace. */
function csvCell(s) {
  if (s === '') return '';
  return /[",\n\r]|^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * One CSV row per record. Numeric columns write the raw value — a column's
 * formatter is for axis ticks and cards, not for a file another tool will
 * parse — and NaN, which is how the store spells "not applicable to this row",
 * writes as an empty field: the CSV spelling of null.
 */
function toCsv(ds) {
  const names = Object.keys(ds.columns);
  const cell = names.map((name) => {
    const c = ds.columns[name];
    // Values are stored as float32, so printing one at full float64 precision
    // spells 4.24 as 4.239999771118164. Seven significant digits is all a
    // float32 carries, and it round-trips.
    if (c.kind === 'number') return (i) => (Number.isFinite(c.values[i]) ? String(Number(c.values[i].toPrecision(7))) : '');
    if (c.kind === 'category') return (i) => c.categories[c.codes[i]] ?? '';
    return (i) => c.at(i);
  });
  const out = [names.map(csvCell).join(',')];
  const row = new Array(cell.length);
  for (let i = 0; i < ds.n; i++) {
    for (let k = 0; k < cell.length; k++) row[k] = csvCell(cell[k](i));
    out.push(row.join(','));
  }
  return out.join('\n') + '\n';
}

/**
 * Bundle the registry to a temporary ESM file and import that. `vite build` is
 * used rather than a dev server's `ssrLoadModule` deliberately: a dev server
 * watches its config file, and inotify is a scarce resource on this box.
 */
async function loadRegistry() {
  const outDir = resolve('node_modules/.tmp/export-csv');
  await build({
    configFile: false,
    logLevel: 'error',
    build: {
      ssr: resolve('src/data/registry.ts'),
      outDir,
      emptyOutDir: true,
      target: 'node20',
      rollupOptions: { output: { entryFileNames: 'registry.mjs' } },
    },
  });
  const mod = await import(pathToFileURL(join(outDir, 'registry.mjs')).href);
  await rm(outDir, { recursive: true, force: true });
  return mod;
}

const [, , outArg, ...keyArgs] = process.argv;
const outDir = resolve(outArg ?? 'scratch/sample-data');
const keys = keyArgs.length ? keyArgs : DEFAULT_KEYS;

const { resolveDataset } = await loadRegistry();
await mkdir(outDir, { recursive: true });
for (const key of keys) {
  const ds = await resolveDataset(key);
  const file = join(outDir, `${key.replace(/:/g, '-')}.csv`);
  const csv = toCsv(ds);
  await writeFile(file, csv);
  const cols = Object.keys(ds.columns).length;
  console.log(`${file}  ${ds.n.toLocaleString()} rows x ${cols} cols  ${(csv.length / 1e6).toFixed(1)} MB`);
}
