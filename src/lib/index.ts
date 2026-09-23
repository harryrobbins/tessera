/**
 * Tessera as a library. Consumers bundle this TypeScript source directly
 * (esbuild or Vite); there is no separate build step.
 *
 *     import { mountTessera, datasetFromTable } from 'tessera';
 *     import css from 'tessera/style.css';          // however your bundler loads CSS
 *     const tessera = mountTessera(document.body, { storage: null, urlSync: false, tour: false, bench: false });
 *
 * Nothing reachable from here uses import-meta URLs or bundler worker syntax: the
 * layout worker is built by the caller (`layoutWorker`) from `tessera/worker`.
 */
export { mountTessera } from './mount';
export type { TesseraOptions, TesseraHandle } from './mount';
export { datasetFromTable } from '../data/fromTable';
export type { TableData, TableColumn, FromTableOptions } from '../data/fromTable';
export type { Dataset, Column, NumericColumn, CategoryColumn, TextColumn } from '../data/columnar';
export { numeric, category, text } from '../data/columnar';
export type { ViewState, FilterEntry } from '../ui/deepLink';
export { computeLayout } from '../layout/layouts';
export { InlineLayoutEngine, ResilientLayoutEngine } from '../layout/engine';
export type { FetchAsset } from '../data/registry';
export { FAMILIES, DEFAULT_DATASET_KEY } from '../data/registry';
