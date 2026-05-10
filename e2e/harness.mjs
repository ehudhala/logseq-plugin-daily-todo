// E2E test harness for logseq-plugin-daily-todo.
//
// Drives a single Logseq instance for many cases. Each case resets state
// by manipulating journal markdown files on disk; Logseq's fs-watcher
// picks up the changes. The plugin's DB.onChanged listener fires only
// on the file-deletion → create-today-journal! path.
//
// See agents/research/2026-05-09-modernization-ai-first-and-e2e.md
// §4 for the technical layer (macOS patch, isolation, Flow A trigger).

import { _electron as electron } from 'playwright';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const FIXTURE = path.join(__dirname, 'fixtures/test-graph');
const PLUGIN_DIST = path.join(ROOT, 'dist');
const PATCHED_APP = '/tmp/LogseqPatched.app';
const EXEC = `${PATCHED_APP}/Contents/MacOS/Logseq`;

// Real-system-clock dates so Logseq's create-today-journal! lines up
function fmtFile(d) {
  return `${d.getFullYear()}_${String(d.getMonth()+1).padStart(2, '0')}_${String(d.getDate()).padStart(2, '0')}`;
}
function ord(n) {
  if (n >= 11 && n <= 13) return `${n}th`;
  return `${n}${['th', 'st', 'nd', 'rd', 'th', 'th', 'th', 'th', 'th', 'th'][n%10]}`;
}
function fmtPretty(d) {
  return `${d.toLocaleString('en-US', { month: 'long' })} ${ord(d.getDate())}, ${d.getFullYear()}`;
}

const TODAY_D = new Date();
const YDAY_D = new Date(TODAY_D.getTime() - 86400_000);
export const TODAY_FILE = fmtFile(TODAY_D);
export const YDAY_FILE = fmtFile(YDAY_D);
export const TODAY_PRETTY = fmtPretty(TODAY_D);
export const YDAY_PRETTY = fmtPretty(YDAY_D);

function log(msg, ...rest) { console.log(`[harness] ${msg}`, ...rest); }
function logCase(name, msg) { console.log(`  [${name}] ${msg}`); }

async function waitFor(predicate, { timeoutMs = 10000, intervalMs = 200, label = 'condition' } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const ok = await predicate();
    if (ok) return;
    await new Promise(r => setTimeout(r, intervalMs));
  }
  throw new Error(`timed out waiting for ${label} after ${timeoutMs}ms`);
}

async function readFileEventually(p, predicate, { timeoutMs = 10000, label } = {}) {
  await waitFor(() => fs.existsSync(p) && predicate(fs.readFileSync(p, 'utf8')),
    { timeoutMs, label: label || `${path.basename(p)} content` });
  return fs.readFileSync(p, 'utf8');
}

export async function launch() {
  if (!fs.existsSync(EXEC)) {
    throw new Error(`Patched Logseq not found at ${EXEC}. Run 'bash e2e/run.sh' which patches it on first call.`);
  }
  if (!fs.existsSync(path.join(PLUGIN_DIST, 'index.html'))) {
    throw new Error(`Plugin dist missing at ${PLUGIN_DIST}. Run 'pnpm build' first.`);
  }

  const tmpHome = fs.mkdtempSync('/tmp/logseq-e2e-');
  const userData = path.join(tmpHome, 'userData');
  const graphDir = path.join(tmpHome, 'test-graph');
  fs.mkdirSync(userData, { recursive: true });
  fs.cpSync(FIXTURE, graphDir, { recursive: true });

  const journalsDir = path.join(graphDir, 'journals');
  fs.mkdirSync(journalsDir, { recursive: true });
  for (const f of fs.readdirSync(journalsDir)) {
    if (f.endsWith('.md')) fs.unlinkSync(path.join(journalsDir, f));
  }

  fs.mkdirSync(path.join(tmpHome, '.logseq'), { recursive: true });
  fs.writeFileSync(path.join(tmpHome, '.logseq/preferences.json'), JSON.stringify({
    theme: null,
    themes: { mode: 'light', light: null, dark: null },
    externals: [PLUGIN_DIST],
  }, null, 2));

  // Snapshot user's real ~/.logseq/settings to verify isolation
  const realSettings = path.join(process.env.HOME, '.logseq/settings');
  const beforeSnapshot = new Map();
  if (fs.existsSync(realSettings)) {
    for (const f of fs.readdirSync(realSettings)) {
      beforeSnapshot.set(f, fs.statSync(path.join(realSettings, f)).mtimeMs);
    }
  }

  log('tmpHome:', tmpHome);
  log('today:', TODAY_PRETTY, `(${TODAY_FILE})`);
  log('yesterday:', YDAY_PRETTY, `(${YDAY_FILE})`);
  const t0 = Date.now();

  const app = await electron.launch({
    executablePath: EXEC,
    args: [`--user-data-dir=${userData}`],
    env: { ...process.env, LOGSEQ_FAKE_HOME: tmpHome },
    timeout: 30000,
  });

  await app.evaluate(({ dialog }, p) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [p] });
  }, graphDir);

  const page = await app.firstWindow({ timeout: 30000 });
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(2000);

  const consoleLines = [];
  page.on('console', m => consoleLines.push(`[+${Date.now()-t0}ms ${m.type()}] ${m.text().slice(0, 300)}`));

  // Open the fixture graph via welcome screen
  await page.goto(page.url().split('#')[0] + '#/repo/add').catch(() => {});
  await page.waitForTimeout(1500);
  await page.click('.action-input', { timeout: 10000 });

  // Wait for graph + plugin
  await waitFor(async () => {
    const r = await page.evaluate(() => {
      try { return $APP.$frontend$state$get_current_repo$$(); } catch { return null; }
    });
    return r && r.startsWith('logseq_local_');
  }, { timeoutMs: 20000, label: 'graph open' });

  await waitFor(async () => {
    return await page.evaluate(dist => {
      const core = globalThis.LSPluginCore;
      if (!core) return false;
      const ps = Array.from(core.registeredPlugins?.entries?.() || []);
      return ps.some(([, v]) => v?.status === 'loaded' &&
        (v?.options?.entry?.includes(dist) || v?.options?.url?.includes(dist)));
    }, PLUGIN_DIST);
  }, { timeoutMs: 30000, label: 'plugin loaded' });

  log(`launched + plugin loaded in ${Date.now() - t0}ms`);
  await page.waitForTimeout(3000); // settle cold-load

  return new HarnessSession({
    app, page, tmpHome, graphDir, journalsDir,
    consoleLines, beforeSnapshot, realSettings,
  });
}

class HarnessSession {
  constructor(opts) {
    Object.assign(this, opts);
    this.todayPath = path.join(opts.journalsDir, `${TODAY_FILE}.md`);
    this.ydayPath = path.join(opts.journalsDir, `${YDAY_FILE}.md`);
    this.results = [];
  }

  // Set Logseq's preferred-workflow on the graph. The plugin re-reads
  // logseq.App.getUserConfigs() on every shortcut press, so changes
  // here take effect on the next mod+1 — no plugin reload needed.
  // We rewrite config.edn and let Logseq's fs-watcher reload it.
  async setPreferredWorkflow(workflow) {
    const configPath = path.join(this.graphDir, 'logseq', 'config.edn');
    const current = fs.readFileSync(configPath, 'utf8');
    const next = current.replace(/:preferred-workflow\s+:\w+/, `:preferred-workflow :${workflow}`);
    if (next === current) {
      // Nothing changed — config already matches.
      return;
    }
    fs.writeFileSync(configPath, next);
    // Logseq picks up config.edn changes via the fs-watcher; getUserConfigs()
    // reflects the new value within ~1s.
    await this.page.waitForTimeout(1500);
  }

  // Reset all journal state. After this returns, the graph has no
  // journal pages in datascript and no .md files on disk in journals/.
  // Critical: poll until Logseq stops re-creating today's file —
  // otherwise a delayed create-today-journal! races with the next
  // seed and clobbers content.
  async resetGraph() {
    const journals = fs.readdirSync(this.journalsDir).filter(f => f.endsWith('.md'));
    for (const f of journals) fs.unlinkSync(path.join(this.journalsDir, f));
    // Logseq's fs-watcher needs time to drop pages from datascript and
    // potentially fire create-today-journal! once or twice in response.
    // Loop deletion until Logseq stops re-creating today.
    for (let attempt = 0; attempt < 5; attempt++) {
      await this.page.waitForTimeout(2000);
      if (fs.existsSync(this.todayPath)) {
        fs.unlinkSync(this.todayPath);
      } else {
        // One more wait to make sure no late create-today-journal! is in flight
        await this.page.waitForTimeout(1500);
        if (!fs.existsSync(this.todayPath)) return;
      }
    }
  }

  // Seed journal files. `journals` is an object map of date-slug → markdown content.
  // Date slugs use the 'YYYY_MM_DD' format. Special keys 'today' and 'yesterday' are
  // resolved to TODAY_FILE / YDAY_FILE.
  async seedJournals(journals) {
    for (const [key, content] of Object.entries(journals)) {
      const slug = key === 'today' ? TODAY_FILE : key === 'yesterday' ? YDAY_FILE : key;
      const p = path.join(this.journalsDir, `${slug}.md`);
      fs.writeFileSync(p, content);
    }
    // Wait for Logseq to parse the files into datascript.
    await this.page.waitForTimeout(3500);
    // Sanity: ensure on-disk content matches what we seeded. Logseq sometimes
    // re-creates today's file via create-today-journal! racing our seed.
    for (const [key, content] of Object.entries(journals)) {
      const slug = key === 'today' ? TODAY_FILE : key === 'yesterday' ? YDAY_FILE : key;
      const p = path.join(this.journalsDir, `${slug}.md`);
      const actual = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '<missing>';
      if (actual !== content) {
        console.log(`  [seed] WARN ${slug}.md drift after parse:\n    expected:\n${content.replace(/^/gm, '      ')}    actual:\n${actual.replace(/^/gm, '      ')}`);
      }
    }
  }

  // Trigger create-today-journal! by deleting today's file. If today doesn't
  // exist yet, write a placeholder first and wait long enough for Logseq's
  // fs-watcher to debounce.
  //
  // After deletion we poll for a few seconds for Logseq to recreate today
  // (its create-today-journal! responds to the deletion). If the recreation
  // doesn't happen within the poll window we explicitly re-write a placeholder
  // and re-delete — sometimes the first deletion is coalesced into a no-op
  // by Logseq's fs-watcher when datascript still has today's page from a
  // recent prior reset.
  async triggerMigration() {
    if (!fs.existsSync(this.todayPath)) {
      fs.writeFileSync(this.todayPath, '-\n');
      await this.page.waitForTimeout(4000); // fs-watcher debounce; <4s is flaky
    }
    fs.unlinkSync(this.todayPath);
    // Poll for up to 5s; if Logseq doesn't recreate today, retry the delete.
    for (let attempt = 0; attempt < 3; attempt++) {
      const start = Date.now();
      while (Date.now() - start < 4000) {
        if (fs.existsSync(this.todayPath)) return;
        await this.page.waitForTimeout(200);
      }
      // Logseq didn't recreate. Re-seed + re-delete to force the trigger.
      fs.writeFileSync(this.todayPath, '-\n');
      await this.page.waitForTimeout(2500);
      if (!fs.existsSync(this.todayPath)) {
        // The placeholder we wrote got swallowed; bail and let the wait
        // logic in waitForMigration handle the timeout.
        return;
      }
      fs.unlinkSync(this.todayPath);
    }
  }

  // Wait for Logseq to recreate today's file (signals migration completed).
  async waitForMigration({ todayMatch, timeoutMs = 15000 } = {}) {
    return await readFileEventually(this.todayPath, todayMatch, { timeoutMs, label: 'migrated today' });
  }

  // Read journal markdown files synchronously after migration settled.
  readJournals() {
    const out = {};
    for (const f of fs.readdirSync(this.journalsDir)) {
      if (f.endsWith('.md')) {
        out[f.replace(/\.md$/, '')] = fs.readFileSync(path.join(this.journalsDir, f), 'utf8');
      }
    }
    return out;
  }

  // Focus a block by entering edit mode on it. Logseq enters edit mode
  // when a `.block-content` is clicked while the page is otherwise idle,
  // but only if the click happens on a real text node (not a wrapping
  // div). We use Playwright's element-handle.click() with a precise
  // CSS path so the synthetic event mirrors what Logseq's React handlers
  // listen for.
  async focusBlockByText(text) {
    try {
      // Locate the matching block, get its index among .block-content
      const idx = await this.page.evaluate(t => {
        const all = [...document.querySelectorAll('.block-content')];
        return all.findIndex(el => el.textContent && el.textContent.includes(t));
      }, text);
      if (idx < 0) {
        // Wait for it to render
        await waitFor(async () => {
          return await this.page.evaluate(t => {
            return [...document.querySelectorAll('.block-content')].some(
              el => el.textContent && el.textContent.includes(t)
            );
          }, text);
        }, { timeoutMs: 5000, intervalMs: 200, label: `block with text "${text}"` });
      }
      // Use Playwright's click for proper synthetic events
      const locator = this.page.locator('.block-content').filter({ hasText: text }).first();
      await locator.click({ timeout: 3000 });
      // Wait until editor activates
      await waitFor(async () => {
        return await this.page.evaluate(() => !!document.querySelector('.editor-inner'));
      }, { timeoutMs: 3000, intervalMs: 100, label: 'editor activation' });
    } catch (e) {
      const diag = await this.page.evaluate(() => ({
        hash: location.hash,
        blockContents: [...document.querySelectorAll('.block-content')].map(el => el.textContent?.slice(0, 60)),
        editing: !!document.querySelector('.editor-inner'),
        active: document.activeElement?.tagName + (document.activeElement?.className ? '.' + document.activeElement.className.split(' ')[0] : ''),
      }));
      console.log('  [diag] focusBlockByText timeout. State:');
      console.log('  hash:', diag.hash);
      console.log('  rendered block-contents:', JSON.stringify(diag.blockContents));
      console.log('  editing:', diag.editing, ' active:', diag.active);
      console.log('  --- on-disk journals ---');
      for (const f of fs.readdirSync(this.journalsDir)) {
        if (f.endsWith('.md')) {
          console.log(`  ${f}:\n${fs.readFileSync(path.join(this.journalsDir, f), 'utf8').replace(/^/gm, '    ')}`);
        }
      }
      throw e;
    }
  }

  // Press a keyboard shortcut. Use Meta on macOS for `mod`.
  //
  // After firing, poll the on-disk file for content changes. The plugin
  // writes via Logseq's `Editor.updateBlock`, which round-trips through
  // the iframe + Logseq main + fs writer. On a slow runner that can
  // exceed a fixed 400ms wait, producing false "keystroke didn't fire"
  // failures. We poll instead, with a fallback timeout.
  //
  // After we detect the change (or time out), press Escape to exit edit
  // mode so the next .block-content click can find the block again.
  async pressShortcut(combo, { watchFile, timeoutMs = 4000 } = {}) {
    const before = watchFile && fs.existsSync(watchFile)
      ? fs.readFileSync(watchFile, 'utf8') : null;
    await this.page.keyboard.press(combo);
    if (watchFile) {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        if (fs.existsSync(watchFile)) {
          const now = fs.readFileSync(watchFile, 'utf8');
          if (now !== before) break;
        }
        await this.page.waitForTimeout(100);
      }
    } else {
      // No file to watch — fall back to the fixed-wait behavior
      await this.page.waitForTimeout(500);
    }
    await this.page.keyboard.press('Escape');
    await this.page.waitForTimeout(200);
  }

  // Navigate to a specific page
  async navigateToPage(pageName) {
    await this.page.evaluate(name => {
      location.hash = '#/page/' + encodeURIComponent(name);
    }, pageName);
    await this.page.waitForTimeout(1500);
  }

  // Run a single migration test case. The case object:
  //   { name, journals: { yesterday, today?, [historic dates] }, expect: (result) => string|null }
  // expect returns null on PASS or a failure message string on FAIL.
  async runMigrationCase(c) {
    const t0 = Date.now();
    logCase(c.name, 'starting');
    await this.resetGraph();
    await this.seedJournals(c.journals);
    await this.triggerMigration();

    if (c.noMigrationExpected) {
      // No migration expected — just give Logseq time to do nothing, then assert.
      await this.page.waitForTimeout(c.settleMs || 4000);
    } else {
      const todayWaitMatch = c.todayWaitMatch || (() => true);
      try {
        await this.waitForMigration({ todayMatch: todayWaitMatch, timeoutMs: c.timeoutMs || 15000 });
      } catch (e) {
        logCase(c.name, `migration timeout: ${e.message}`);
      }
      // Settle final writes
      await this.page.waitForTimeout(1500);
    }

    const journals = this.readJournals();
    const failure = c.expect(journals);
    const dt = Date.now() - t0;

    const status = failure === null || failure === undefined
      ? (c.knownFailing ? 'unexpected-pass' : 'pass')
      : (c.knownFailing ? 'known-fail' : 'fail');

    const tag = {
      'pass': 'PASS',
      'fail': 'FAIL',
      'known-fail': 'KNOWN-FAIL',
      'unexpected-pass': 'UNEXPECTED-PASS (known-fail flag should be removed)',
    }[status];

    if (status === 'pass') {
      logCase(c.name, `${tag} (${dt}ms)`);
    } else if (status === 'known-fail') {
      logCase(c.name, `${tag}: ${failure} (${dt}ms)`);
    } else {
      logCase(c.name, `${tag}: ${failure} (${dt}ms)`);
      logCase(c.name, `journals on disk: ${JSON.stringify(Object.keys(journals))}`);
      for (const [name, content] of Object.entries(journals)) {
        console.log(`    --- ${name} ---\n${content.replace(/^/gm, '    ')}`);
      }
    }
    this.results.push({ name: c.name, status, failure, duration: dt });
  }

  // Run a single shortcut test case. The case object:
  //   {
  //     name,
  //     journals,
  //     focusText,
  //     actions: [{ press: 'Meta+1' }, ...],
  //     preferredWorkflow?: 'todo' | 'now',  // default 'todo'
  //     expect: (journals) => string|null,
  //   }
  // Shortcut cases use yesterday's journal as the test page because
  // Logseq's create-today-journal! races our seed for today.
  async runShortcutCase(c) {
    const t0 = Date.now();
    logCase(c.name, 'starting');
    // Defensive: if a previous case left the editor open, close it first
    await this.page.keyboard.press('Escape').catch(() => {});
    await this.page.waitForTimeout(200);
    // Pin the workflow before each case so a prior case's setting can't
    // leak in. Defaults to 'todo' (Logseq's default).
    await this.setPreferredWorkflow(c.preferredWorkflow || 'todo');
    await this.resetGraph();
    // Always seed content under 'yesterday' regardless of what the case
    // declares — gives us a stable page Logseq won't auto-rewrite.
    const remapped = {};
    for (const [k, v] of Object.entries(c.journals)) {
      const newKey = k === 'today' ? 'yesterday' : k;
      remapped[newKey] = v;
    }
    await this.seedJournals(remapped);
    // Navigate to yesterday's journal
    await this.navigateToPage(YDAY_PRETTY);
    await this.page.waitForTimeout(1500);

    let runError = null;
    try {
      if (c.focusText) {
        await this.focusBlockByText(c.focusText);
      }
      if (process.env.E2E_DEBUG) {
        const focus = await this.page.evaluate(() => ({
          active: document.activeElement?.tagName + (document.activeElement?.className ? '.' + document.activeElement.className.split(' ')[0] : ''),
          editing: !!document.querySelector('.editor-inner'),
        }));
        console.log(`  [diag] before keystroke: ${JSON.stringify(focus)}`);
      }
      for (const action of c.actions) {
        if (action.press) {
          // Watch yesterday's file: shortcut tests assert on its content.
          // pressShortcut polls for the file to change after the press,
          // so a slow CI runner doesn't miss the disk flush.
          await this.pressShortcut(action.press, { watchFile: this.ydayPath });
        }
        if (action.focusText) {
          await this.focusBlockByText(action.focusText);
        }
      }
    } catch (e) {
      runError = e.message;
    }
    // Settle writes
    await this.page.waitForTimeout(800);

    const journals = this.readJournals();
    const failure = runError
      ? `harness error before assertion: ${runError}`
      : c.expect(journals);
    const dt = Date.now() - t0;

    const status = failure === null || failure === undefined
      ? (c.knownFailing ? 'unexpected-pass' : 'pass')
      : (c.knownFailing ? 'known-fail' : 'fail');

    if (status === 'pass') {
      logCase(c.name, `PASS (${dt}ms)`);
    } else if (status === 'known-fail') {
      logCase(c.name, `KNOWN-FAIL: ${failure} (${dt}ms)`);
    } else {
      logCase(c.name, `${status === 'unexpected-pass' ? 'UNEXPECTED-PASS' : 'FAIL'}: ${failure || ''} (${dt}ms)`);
      for (const [name, content] of Object.entries(journals)) {
        console.log(`    --- ${name} ---\n${content.replace(/^/gm, '    ')}`);
      }
    }
    this.results.push({ name: c.name, status, failure, duration: dt });
  }

  printSummary() {
    const buckets = {
      pass: this.results.filter(r => r.status === 'pass'),
      fail: this.results.filter(r => r.status === 'fail'),
      'known-fail': this.results.filter(r => r.status === 'known-fail'),
      'unexpected-pass': this.results.filter(r => r.status === 'unexpected-pass'),
    };
    const total = this.results.length;
    console.log('---');
    console.log(`SUMMARY: ${buckets.pass.length}/${total} passed, ` +
      `${buckets.fail.length} failed, ${buckets['known-fail'].length} known-fail, ` +
      `${buckets['unexpected-pass'].length} unexpected-pass`);
    if (buckets.fail.length) {
      console.log('failures:');
      for (const r of buckets.fail) console.log(`  - ${r.name}: ${r.failure}`);
    }
    if (buckets['known-fail'].length) {
      console.log('known failures (not blocking):');
      for (const r of buckets['known-fail']) console.log(`  - ${r.name}: ${r.failure}`);
    }
    if (buckets['unexpected-pass'].length) {
      console.log('unexpected passes (drop the knownFailing flag):');
      for (const r of buckets['unexpected-pass']) console.log(`  - ${r.name}`);
    }
    // Suite is "green" when there are no real failures and no surprises.
    return buckets.fail.length === 0 && buckets['unexpected-pass'].length === 0;
  }

  verifyIsolation() {
    if (!fs.existsSync(this.realSettings)) return [];
    const touched = [];
    for (const f of fs.readdirSync(this.realSettings)) {
      const m = fs.statSync(path.join(this.realSettings, f)).mtimeMs;
      if (!this.beforeSnapshot.has(f)) touched.push(`NEW ${f}`);
      else if (this.beforeSnapshot.get(f) !== m) touched.push(`MOD ${f}`);
    }
    return touched;
  }

  async close() {
    await this.app.close();
  }
}
