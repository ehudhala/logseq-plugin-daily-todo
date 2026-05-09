// E2E test runner. Launches one Logseq instance, runs cases against
// it via fs-based reset, prints summary, exits non-zero on any failure.
//
// Usage:
//   node e2e/runner.mjs              # full migration suite (~2min)
//   node e2e/runner.mjs --quick      # mega-migration sanity case (~15s)
//   node e2e/runner.mjs --shortcuts  # shortcut cases only (work in progress)

import { launch } from './harness.mjs';
import { migrationCases } from './cases/migration.mjs';
import { shortcutCases } from './cases/shortcuts.mjs';
import { sanityCase } from './cases/sanity.mjs';

const QUICK = process.argv.includes('--quick');
const SHORTCUTS_ONLY = process.argv.includes('--shortcuts');

async function main() {
  const session = await launch();
  let exitCode = 0;
  try {
    if (QUICK) {
      console.log('=== Quick sanity ===');
      await session.runMigrationCase(sanityCase);
    } else if (SHORTCUTS_ONLY) {
      console.log('=== Shortcut cases ===');
      for (const c of shortcutCases) {
        await session.runShortcutCase(c);
      }
    } else {
      console.log('=== Sanity ===');
      await session.runMigrationCase(sanityCase);
      console.log('=== Migration cases ===');
      for (const c of migrationCases) {
        await session.runMigrationCase(c);
      }
    }
    const ok = session.printSummary();
    if (!ok) exitCode = 1;
    const touched = session.verifyIsolation();
    console.log(touched.length === 0
      ? 'real ~/.logseq/settings touched: NONE'
      : `WARNING — real ~/.logseq/settings touched: ${touched.join(', ')}`);
    if (touched.length > 0) exitCode = 2;
  } finally {
    await session.close();
  }
  process.exit(exitCode);
}

main().catch(e => { console.error('THREW:', e); process.exit(99); });
