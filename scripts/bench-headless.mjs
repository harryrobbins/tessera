#!/usr/bin/env node
// Offline benchmark runner: boots a real dev server + real Chromium (WSL2/WSLg,
// GPU passthrough via /dev/dxg where available), drives the app's bench API,
// and writes a machine-comparable JSON result plus a human-readable summary.
//
// Contract with the page (src/bench/bench.ts, not this file):
//   - navigate to /?bench=1
//   - wait for window.pivotBenchReady === true
//   - call window.runPivotBench() -> JSON-serialisable { env, runs: [...] }
//
// Usage: pnpm bench [--port 5181] [--out bench-results/] [--label name]
//                    [--swiftshader] [--headed] [--keep-server]

import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs/promises';
import fssync from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// -- args ---------------------------------------------------------------

const { values: args } = parseArgs({
  options: {
    port: { type: 'string', default: '5181' },
    out: { type: 'string', default: 'bench-results/' },
    label: { type: 'string' },
    swiftshader: { type: 'boolean', default: false },
    headed: { type: 'boolean', default: false },
    'keep-server': { type: 'boolean', default: false },
  },
});

const port = Number(args.port);
const label = args.label || os.hostname();
const outDir = path.isAbsolute(args.out) ? args.out : path.resolve(PROJECT_ROOT, args.out);
const useSwiftshader = args.swiftshader;
const headed = args.headed;
const keepServer = args['keep-server'];

// -- helpers --------------------------------------------------------------

// Poll the dev server root until it answers 200, or throw after timeoutMs.
async function waitForServer(targetPort, timeoutMs) {
  const url = `http://127.0.0.1:${targetPort}/`;
  const start = Date.now();
  let lastErr;
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.status === 200) return;
    } catch (err) {
      lastErr = err;
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(
    `timed out after ${timeoutMs}ms waiting for ${url}${lastErr ? ` (last error: ${lastErr.message})` : ''}`,
  );
}

function startDevServer(targetPort) {
  // detached so the whole process group (vite + any children it forks) can be
  // killed together on teardown, SIGINT, or failure.
  const child = spawn('pnpm', ['exec', 'vite', '--port', String(targetPort), '--strictPort'], {
    cwd: PROJECT_ROOT,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => process.stdout.write(`[vite] ${chunk}`));
  child.stderr.on('data', (chunk) => process.stderr.write(`[vite] ${chunk}`));
  return child;
}

function killDevServer(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  try {
    // negative pid = kill the whole process group started with detached:true.
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    // already gone
  }
}

function gpuLaunchArgs(swiftshader) {
  if (swiftshader) {
    // Forced CPU-only baseline: reproducible across machines regardless of GPU.
    return ['--use-gl=swiftshader', '--disable-dev-shm-usage'];
  }
  // Best chance of a real GPU under WSL2's /dev/dxg passthrough.
  return [
    '--use-angle=vulkan',
    '--enable-features=Vulkan',
    '--ignore-gpu-blocklist',
    '--enable-gpu-rasterization',
    '--enable-zero-copy',
    '--disable-dev-shm-usage',
    '--use-gl=angle',
  ];
}

function fmtNum(n, decimals = 1) {
  return typeof n === 'number' && Number.isFinite(n) ? n.toFixed(decimals) : String(n ?? '');
}

// Renders the dataset x phase results as an aligned text table, with a loud
// warning if the renderer looks like a software rasterizer.
function printReport(output) {
  const { result, node, browser } = output;
  const softwareRendererProbe = JSON.stringify({ env: result?.env, browser }).toLowerCase();
  const isSoftware = browser.gpuMode === 'swiftshader' || /swiftshader|llvmpipe|software/i.test(softwareRendererProbe);

  console.log('');
  console.log('='.repeat(72));
  console.log(`Benchmark: ${output.label}  (${output.timestamp})`);
  console.log(
    `Host: ${node.hostname} | ${node.cpuModel} x${node.cpuCount} | ${node.totalMemGB} GB RAM | node ${node.nodeVersion} | /dev/dxg: ${node.hasDxg ? 'present' : 'absent'}`,
  );
  console.log(`Browser: chromium ${browser.version} | headless=${browser.headless} | gpuMode=${browser.gpuMode}`);
  if (result?.env) console.log(`Page env: ${JSON.stringify(result.env)}`);
  if (isSoftware) {
    console.log('');
    console.log('*** WARNING: renderer looks like a SOFTWARE rasterizer (SwiftShader/llvmpipe). ***');
    console.log('*** THESE NUMBERS ARE CPU-RASTERISED AND NOT REPRESENTATIVE.                  ***');
  }
  console.log('='.repeat(72));

  const header = ['dataset', 'n', 'phase', 'frames', 'fps', 'p50 ms', 'p95 ms', 'worst ms'];
  const numericCol = [false, true, false, true, true, true, true, true];
  const rows = [];
  for (const run of result?.runs ?? []) {
    for (const phase of run.phases ?? []) {
      rows.push([
        String(run.dataset ?? ''),
        String(run.n ?? ''),
        String(phase.name ?? ''),
        String(phase.frames ?? ''),
        fmtNum(phase.fps),
        fmtNum(phase.p50),
        fmtNum(phase.p95),
        fmtNum(phase.worst),
      ]);
    }
  }

  const allRows = [header, ...rows];
  const widths = header.map((_, i) => Math.max(...allRows.map((r) => r[i].length)));
  const printRow = (r) =>
    console.log(r.map((cell, i) => (numericCol[i] ? cell.padStart(widths[i]) : cell.padEnd(widths[i]))).join('  '));

  printRow(header);
  printRow(widths.map((w) => '-'.repeat(w)));
  if (rows.length === 0) {
    console.log('(no runs in result)');
  } else {
    for (const r of rows) printRow(r);
  }
  console.log('');
}

// -- main -------------------------------------------------------------------

async function main() {
  await fs.mkdir(outDir, { recursive: true });

  let serverChild = null;
  let browser = null;
  let cleanedUp = false;

  const cleanup = async () => {
    if (cleanedUp) return;
    cleanedUp = true;
    if (browser) {
      try {
        await browser.close();
      } catch {
        // ignore
      }
    }
    if (serverChild && !keepServer) killDevServer(serverChild);
  };

  const onSigint = async () => {
    console.log('\nSIGINT received, tearing down...');
    await cleanup();
    process.exit(130);
  };
  process.on('SIGINT', onSigint);

  try {
    if (keepServer) {
      console.log(`--keep-server: expecting a server already running at http://127.0.0.1:${port}/`);
      try {
        await waitForServer(port, 60_000);
      } catch (err) {
        throw new Error(`--keep-server was set but nothing answered at http://127.0.0.1:${port}/ (${err.message})`);
      }
    } else {
      console.log(`Starting dev server: pnpm exec vite --port ${port} --strictPort`);
      serverChild = startDevServer(port);
      await waitForServer(port, 60_000);
    }
    console.log(`Dev server is up on port ${port}.`);

    const launchArgs = gpuLaunchArgs(useSwiftshader);
    console.log(
      `Launching chromium: ${headed ? 'headed (WSLg)' : 'headless'}, gpu mode: ${
        useSwiftshader ? 'forced swiftshader (CPU baseline)' : 'attempted real GPU (ANGLE/Vulkan via /dev/dxg)'
      }`,
    );
    browser = await chromium.launch({
      headless: !headed,
      args: launchArgs,
      env: headed ? { ...process.env, DISPLAY: process.env.DISPLAY || ':0' } : process.env,
    });

    const page = await browser.newPage();
    page.setDefaultTimeout(600_000); // the bench run itself can take up to 10 minutes
    page.on('console', (msg) => console.log(`[page] ${msg.text()}`));
    page.on('pageerror', (err) => console.error(`[page:error] ${err}`));

    const url = `http://127.0.0.1:${port}/?bench=1`;
    console.log(`Navigating to ${url}`);
    await page.goto(url, { waitUntil: 'load' });

    console.log('Waiting for window.pivotBenchReady...');
    await page.waitForFunction(() => window.pivotBenchReady === true, null, { timeout: 60_000 });

    console.log('Running benchmark (window.runPivotBench(), can take up to 10 minutes)...');
    const result = await page.evaluate(() => window.runPivotBench());
    console.log('Benchmark finished.');

    const timestamp = new Date().toISOString();
    const output = {
      label,
      timestamp,
      node: {
        hostname: os.hostname(),
        cpuModel: os.cpus()[0]?.model ?? 'unknown',
        cpuCount: os.cpus().length,
        totalMemBytes: os.totalmem(),
        totalMemGB: +(os.totalmem() / 1024 ** 3).toFixed(1),
        nodeVersion: process.version,
        platform: os.platform(),
        arch: os.arch(),
        hasDxg: fssync.existsSync('/dev/dxg'),
      },
      browser: {
        name: 'chromium',
        version: browser.version(),
        headless: !headed,
        gpuMode: useSwiftshader ? 'swiftshader' : 'attempted-real-gpu',
        launchArgs,
      },
      result,
    };

    const fileSafeTimestamp = timestamp.replace(/:/g, '-');
    const outPath = path.join(outDir, `${label}-${fileSafeTimestamp}.json`);
    const latestPath = path.join(outDir, 'latest.json');
    const json = JSON.stringify(output, null, 2);
    await fs.writeFile(outPath, json);
    await fs.writeFile(latestPath, json);
    console.log(`Wrote ${outPath}`);
    console.log(`Wrote ${latestPath}`);

    printReport(output);
    process.exitCode = 0;
  } catch (err) {
    console.error('Benchmark run failed:', err);
    process.exitCode = 1;
  } finally {
    process.off('SIGINT', onSigint);
    await cleanup();
  }
}

main();
