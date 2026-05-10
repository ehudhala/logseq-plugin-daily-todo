# Testing

Five gates, each with its own command:

1. **Type check** (`pnpm check`) — `tsc --noEmit` against `src/` and
   `scripts/`. Fast (<2s) and the most specific failure signal — a TS
   error usually points at a single line.
2. **Lint** (`pnpm lint`) — ESLint 9 (flat config) for mechanical
   style + the typescript-eslint recommended rules. ~5s.
3. **Unit tests** (`pnpm test`) — Vitest on the pure helpers in
   `src/lib.ts`. <1s. Ideal inner loop while iterating on regex /
   state-machine / group-split logic.
4. **Build** (`pnpm build`) — Vite. Confirms the bundle still emits
   and stays single-chunk.
5. **Perf gate** (`pnpm perf`) — drives `perf-test/host.html`
   headlessly and asserts: 1 resource fetch (no chunk splitting),
   median load < 800ms over loopback.

Plus the slow E2E gate:

6. **End-to-end tests** (`pnpm test:e2e`) — drives real Logseq.app
   via Playwright with an isolated temp profile. Seeds markdown
   fixtures, triggers `create-today-journal!` via file deletion,
   asserts on resulting markdown content.

## Commands

```bash
pnpm check                 # tsc --noEmit (<2s)
pnpm lint                  # ESLint 9 (~5s)
pnpm lint --fix            # auto-fix mechanical issues
pnpm test                  # Vitest unit tests (<1s)
pnpm test:watch            # Vitest in watch mode
pnpm build                 # Vite build (~1s)
pnpm perf                  # Headless perf gate (~5s)
pnpm verify                # check + lint + test + build + perf — the umbrella gate
pnpm test:e2e:quick        # one mega-migration sanity case (~17s)
pnpm test:e2e              # full E2E suite — migration + shortcuts (~3m30s)
pnpm test:e2e:shortcuts    # shortcut cases only (~1m30s)
```

`pnpm verify` is the canonical "did I break it?" agent gate. It does NOT
run `pnpm test:e2e` because that needs Logseq.app installed and is
slower; run E2E separately before opening a PR.

### Dev loop

While iterating on `src/main.ts`, run `pnpm test:e2e:quick` after each
change. The mega-fixture exercises every migration rule in one shot
(group migration, DONE retention, title duplication, recursion,
multiple groups, separators) so a single PASS gives high signal that
nothing broadly regressed.

### Before opening a PR

Run `pnpm verify` (the fast gate, ~30s) and `pnpm test:e2e` (the full
suite, ~3m30s). The suite is fully green: no `KNOWN-FAIL` cases.

## How it works (short version)

- `e2e/run.sh` — entry script. Hard-link-clones `Logseq.app` to
  `/tmp/LogseqPatched.app`, patches `electron.js` to honor
  `LOGSEQ_FAKE_HOME` (a macOS-specific workaround — see
  [`agents/research/2026-05-09-modernization-ai-first-and-e2e.md`](./research/2026-05-09-modernization-ai-first-and-e2e.md)
  §4.2), then invokes the runner.
- `e2e/runner.mjs` — orchestrates the suite. Selects which cases run
  based on `--quick` / `--shortcuts` / no-flag.
- `e2e/harness.mjs` — launches Logseq via Playwright's
  `_electron.launch`, opens the fixture graph, waits for the plugin to
  load, and exposes per-case helpers (`runMigrationCase`,
  `runShortcutCase`, `resetGraph`, `seedJournals`, `triggerMigration`).
- `e2e/cases/migration.mjs` — the rule-based migration cases.
- `e2e/cases/sanity.mjs` — the one mega-fixture case for `--quick`.
- `e2e/cases/shortcuts.mjs` — keyboard shortcut cases (Meta+1 cycle
  TODO state; Meta+4 toggle highlight).
- `e2e/fixtures/test-graph/` — minimal Logseq graph: just
  `logseq/config.edn`. Journals are written at test time using real
  system dates.

## Constraints

- **macOS only.** The patch in `run.sh` is macOS-specific. Linux/Windows
  would need an equivalent isolation pattern (likely simpler — Linux
  Electron honors `HOME`).
- **Real `~/.logseq/` is never touched** by patched runs. The harness
  snapshots `~/.logseq/settings/` mtimes before/after and reports any
  drift; the runner fails non-zero if anything was touched.
- **Logseq.app must be installed at `/Applications/Logseq.app`.**

## Authoring a new migration case

Add an entry to the array in `e2e/cases/migration.mjs`:

```js
{
  name: 'descriptive-case-name',
  journals: {
    yesterday: `- TODO Some task\n`,   // pre-state
    today: '-\n',                      // pre-state (placeholder)
    // optional: '2024_01_15': `...`,  // historical journals
  },
  todayWaitMatch: c => /TODO Some task/.test(c),  // wait predicate
  expect: (j) => allOf(
    contains(j[TODAY_FILE], /TODO Some task/, 'today must have task'),
    notContains(j[YDAY_FILE], /TODO Some task/, 'yday must not retain'),
  ),
}
```

For cases where no migration should fire, set `noMigrationExpected: true`
instead of providing a `todayWaitMatch` — the harness will skip the
~15s wait and use a brief settle delay.

## Authoring a new shortcut case

Shortcut cases run against `yesterday`'s journal (Logseq's
`create-today-journal!` races on-disk seeds for today's file, so the
harness remaps any case that declares content under `today` to
`yesterday`). After each keystroke the harness sends `Escape` to commit
the edit and close the editor; without that, Logseq keeps the editor
open over the just-edited block, hiding `.block-content` for that block
and making subsequent re-focus calls miss.

```js
{
  name: 'descriptive-case-name',
  journals: { today: `- Buy groceries\n- Pay bills\n` },
  focusText: 'Buy groceries',          // substring match on .block-content
  actions: [{ press: 'Meta+1' }],      // mod = Meta on macOS
  expect: (j) => contains(j[YDAY_FILE], /^- TODO Buy groceries$/m, '...'),
}
```

Multiple presses on the same block work too — re-pass `focusText` in
each action object so the harness re-locates the block after each
keystroke (the editor closes on Escape after every press, so the block
re-renders in `.block-content`):

```js
actions: [
  { press: 'Meta+1' },                                    // → TODO
  { focusText: 'Buy groceries', press: 'Meta+1' },        // → DONE
  { focusText: 'Buy groceries', press: 'Meta+1' },        // → blank
],
```
