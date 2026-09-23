import { describe, it, expect } from 'vitest';
import { build } from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The library is consumed as TypeScript source and bundled by the embedder's
 * esbuild. It must bundle cleanly and carry no bundler-only syntax: an
 * import-meta URL survives esbuild as-is and breaks inside a `data:` module.
 */
describe('library bundle (esbuild)', () => {
  it('bundles src/lib/index.ts with no import.meta and no worker URL', async () => {
    const out = await build({
      entryPoints: [path.join(ROOT, 'src/lib/index.ts')],
      bundle: true,
      format: 'esm',
      platform: 'browser',
      write: false,
      logLevel: 'silent',
      metafile: true,
    });
    const code = out.outputFiles[0].text;
    expect(code).not.toMatch(/import\.meta/);
    expect(code).not.toMatch(/new URL\([^)]*worker/);
    // main.ts (the Vite demo) is not part of the library graph.
    expect(Object.keys(out.metafile!.inputs).some((f) => f.endsWith('src/main.ts'))).toBe(false);
  }, 60_000);

  it('bundles the worker entry on its own', async () => {
    const out = await build({
      entryPoints: [path.join(ROOT, 'src/layout/worker.ts')],
      bundle: true, format: 'esm', write: false, logLevel: 'silent',
    });
    expect(out.outputFiles[0].text).toMatch(/onmessage/);
  }, 60_000);
});
