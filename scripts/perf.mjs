// Headless perf gate — drives perf-test/host.html via Playwright and
// asserts on load-time invariants:
//
//   1. resourceCount === 1   — the 0.0.8 single-chunk invariant. Catches
//      re-introduction of manualChunks automatically.
//   2. median elapsed < THRESHOLD_MS — catches gross regressions
//      (import-heavy refactors, polyfill bloat, etc.).
//
// Loopback HTTP makes absolute milliseconds meaningless against the
// `lsp://` protocol handler Logseq uses, so the threshold is generous.
// The structural assertion (resourceCount) is what really matters.

import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

const PORT = 8765;
const RUNS = 10;
const THRESHOLD_MS = 800;

function staticServer(rootDir, port) {
  const types = {
    '.html': 'text/html',
    '.js': 'application/javascript',
    '.mjs': 'application/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.png': 'image/png',
  };
  const server = http.createServer((req, res) => {
    let urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
    if (urlPath.endsWith('/')) urlPath += 'index.html';
    const filePath = path.join(rootDir, urlPath);
    // Prevent path-traversal — must stay under rootDir
    if (!filePath.startsWith(rootDir)) {
      res.writeHead(403); res.end('Forbidden'); return;
    }
    fs.readFile(filePath, (err, data) => {
      if (err) { res.writeHead(404); res.end('Not found: ' + urlPath); return; }
      const ext = path.extname(filePath);
      res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream' });
      res.end(data);
    });
  });
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

async function main() {
  if (!fs.existsSync(path.join(ROOT, 'dist/index.html'))) {
    console.error('dist/index.html missing — run pnpm build first');
    process.exit(2);
  }

  const server = await staticServer(ROOT, PORT);
  console.log(`[perf] static server listening on :${PORT}`);

  const browser = await chromium.launch({ headless: true });
  let exitCode = 0;
  try {
    const page = await browser.newPage();
    await page.goto(`http://localhost:${PORT}/perf-test/host.html`);
    await page.waitForFunction(() => typeof window.runHarnessN === 'function', { timeout: 5000 });

    const result = await page.evaluate(async ({ pluginUrl, runs }) => {
      return await window.runHarnessN(pluginUrl, 'perf-gate', runs);
    }, { pluginUrl: `http://localhost:${PORT}/dist/index.html`, runs: RUNS });

    console.log('[perf] result:', JSON.stringify({
      median: result.median,
      min: result.min,
      max: result.max,
      runs: result.runs,
      resourceCount: result.resourceCount,
    }, null, 2));

    if (result.resourceCount !== 1) {
      console.error(`[perf] FAIL: expected 1 resource fetch, got ${result.resourceCount}.`);
      console.error('[perf] resources:', JSON.stringify(result.resources0, null, 2));
      console.error('[perf] If this is intentional, the manualChunks-no-friends gotcha may need updating.');
      exitCode = 1;
    } else {
      console.log('[perf] OK: single-chunk invariant holds (1 resource fetch).');
    }

    if (result.median !== null && result.median > THRESHOLD_MS) {
      console.error(`[perf] FAIL: median load ${result.median}ms exceeds threshold ${THRESHOLD_MS}ms.`);
      exitCode = 1;
    } else if (result.median !== null) {
      console.log(`[perf] OK: median load ${result.median}ms (threshold ${THRESHOLD_MS}ms).`);
    }
  } finally {
    await browser.close();
    server.close();
  }
  process.exit(exitCode);
}

main().catch(e => { console.error('[perf] THREW:', e); process.exit(99); });
