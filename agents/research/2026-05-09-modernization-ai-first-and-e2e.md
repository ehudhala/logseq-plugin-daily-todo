---
topic: modernization-ai-first-and-e2e
date: 2026-05-09
status: reference
tags:
  - modernization
  - ai-first
  - tooling
  - logseq-libs
  - e2e
  - testing
  - playwright
summary: >
  Reference document covering Logseq's plugin loading model, the
  @logseq/libs SDK breakages waiting in this plugin's code, the
  functional testing strategy (Vitest unit + headless Playwright E2E),
  the technical layer of the headless E2E setup, and the AI-first repo
  conventions used here. Describes how the world looks and why, not
  what was done when.
---

# Plugin loading, modernization, testing, and AI-first conventions

A reference for anyone — agent or human — touching this plugin in a
load-sensitive, SDK-sensitive, or test-sensitive way. Each section is
self-contained.

---

## 1. How Logseq loads plugins (the 6-second warning)

When Logseq displays "this plugin takes too long to load, affecting
the application startup time and potentially causing other plugins to
fail to load," the metric is iframe-append → Postmate handshake-reply
exceeding 6000 ms.

**Source of truth:**

- The threshold check is at `src/main/frontend/handler/plugin.cljs:1276`
  in the `logseq/logseq` repo, fired on the `LSPluginCore` `'ready'`
  event.
- The interval is captured in `libs/src/LSPlugin.core.ts:1504-1509`:

  ```ts
  const perfInfo = { o: pluginLocal, s: performance.now(), e: 0 }
  await pluginLocal.load({ indicator: readyIndicator })
  perfInfo.e = performance.now()
  ```

- `pluginLocal.load()` ends when Postmate's `handshake-reply` reaches
  the parent.

**Plugins load serially** in a `for ... of` loop. A slow plugin
genuinely blocks every plugin queued behind it.

### What does NOT count toward the 6s metric

By the time Logseq stops the timer, the plugin has only:

1. Loaded its iframe HTML
2. Downloaded and parsed every statically imported JS chunk
3. Created `window.logseq` (a side effect of `import '@logseq/libs'`)
4. Called `logseq.ready(...)`, which triggers `sendHandshakeReply`

Anything inside the `ready(callback)` body — `registerCommandPalette`,
`DB.onChanged`, `datascriptQuery`, `updateSettings` — runs *after* the
host has stopped the timer. **If you see the warning, do not optimize
inside `main()`.** Look at the bundle.

### What DOES count

- iframe HTML fetch
- Each chained ES module import (every `lsp://` fetch is a main-process
  Electron IPC roundtrip)
- Bundle parse + execute
- The Postmate handshake roundtrip itself

### Why this plugin uses `inlineDynamicImports: true`

`vite.config.ts` sets `output.inlineDynamicImports: true`, producing a
single ~78KB chunk. The earlier `manualChunks: { logseq: ['@logseq/libs'] }`
config split the bundle into an entry chunk that did
`import './logseq.xxx.js'` — two chained `lsp://` fetches before the
iframe could call `logseq.ready()`. Same gzip size, half the per-startup
IPC roundtrips.

**Do not switch back to `manualChunks`.** It looks like a vendor-cache
optimization, but plugin assets aren't shared across plugins; every
chunk is its own `lsp://` IPC roundtrip on every plugin load on every
Logseq startup.

### How to measure load time without Logseq

`perf-test/host.html` is a Postmate-protocol-correct browser harness:
it creates an iframe pointing at the plugin's built `index.html`, sends
`{postmate: 'handshake', type: 'application/x-postmate-v1+json'}` every
500ms after iframe `load`, and times the `handshake-reply`. From the
DevTools console:

```js
await runHarnessN('http://localhost:8765/dist/index.html', 'current', 10)
```

Loopback HTTP makes absolute milliseconds meaningless — there's no
`lsp://` IPC overhead — but the **resource count** is the structural
invariant. The single-chunk build always reports 1 fetch; the split
build always reports 2.

### How to measure load time inside Logseq

In Logseq's own DevTools console:

```js
__debugPluginsPerfInfo()
```

`console.table`s every loaded plugin with its load time in ms (the
same `e - s` Logseq uses for the 6s threshold). For verbose handshake
logs, set `localStorage.debug = '*'` and reload Logseq.

---

## 2. The `@logseq/libs` SDK breakages waiting in `src/main.ts`

The plugin pins `@logseq/libs@0.0.9`. Three call sites break against
any modern SDK (`>= 0.0.17`). **Do not bump the SDK without fixing
all three.**

### 2.1 `block.left.id` is gone

`BlockEntity.left: IEntityID` was removed and replaced with
`parent: IEntityID` and `order: string`. The plugin uses
`block.left.id` at `src/main.ts:180-184` to walk left siblings and
delete empty separator blocks in the source journal:

```ts
let leftBlock = await logseq.Editor.getBlock(block.left.id, {includeChildren: true});
while (leftBlock?.content === '' && leftBlock?.children?.length === 0) {
  await logseq.Editor.removeBlock(leftBlock.uuid);
  leftBlock = await logseq.Editor.getBlock(leftBlock.left.id, {includeChildren: true});
}
```

Two viable rewrites:

1. **Walk via the parent's `children` array.** Get the parent block
   (or page) including children, find the index of the current block,
   walk backward through `children[i-1], children[i-2]...` deleting
   empty leaf blocks until non-empty.
2. **Drop the cosmetic empty-separator cleanup on DB graphs.** It's
   nice-to-have, not load-bearing — group separators are visual
   structure, not semantic. A simple version-gate (file vs DB graph)
   keeps option 1 for file graphs and skips on DB graphs.

### 2.2 `block.content` is deprecated

Read sites should use `block.title ?? block.content`. Write paths
(`updateBlock(uuid, content)`, `insertBlock(parent, content, opts)`)
still accept content strings — no change there.

Sites in `src/main.ts` that read `.content` (and need the fallback):
`isHighlighted`, `extractTodoState`, `recursiveCopyBlocks` (multiple
reads), `recursivelyCheckForRegexInBlock`, the group-split loop in
`updateNewJournalWithAllTODOs`, the `lastEmptyBlock` cleanup loop.

### 2.3 `journal?` and `journalDay` moved to `PageEntity`

These properties moved from `BlockEntity` to `PageEntity`. The runtime
values still appear in `DB.onChanged` payloads for journal pages — the
plugin's existing dual-key check (`block['journal?']` vs
`'block/journal?'`) stays defensively correct — but the static type
should tighten.

The block returned by `blocks.find(...)` in `updateNewJournalWithAllTODOs`
is conceptually a page entity; type it as
`PageEntity & { 'journal?'?: boolean; journalDay?: number }` or use a
dedicated narrowing helper.

### 2.4 The `DB.onChanged` filter is correct — do not relax it

The current filter requires `createdAt === updatedAt && journal? === true`
in a **single transaction**. That shape is what Logseq's in-app
`create-today-journal!` flow emits — used by:

- The today-link click in the sidebar
- The day-rollover timer when the app is running across midnight
- The fs-watcher when today's journal file is deleted (Logseq detects
  the deletion and re-runs `create-today-journal!`)

The filter does **not** match file-import shapes (e.g. dropping a
markdown file into the journals directory, or sync arriving from
another device). That is correct: triggering migration on import would
re-fire on every Logseq startup as it parses existing journals,
duplicating content and corrupting the source journal.

If you encounter a "but the filter doesn't fire on X" report, the fix
is almost always to use a different trigger that goes through
`create-today-journal!`, not to loosen the filter.

### 2.5 What stays stable across SDK versions

These all work the same in 0.0.9 and 0.0.17:

`logseq.ready`, `logseq.settings`, `logseq.updateSettings`,
`App.registerCommandPalette`, `Editor.getSelectedBlocks`,
`Editor.getCurrentBlock`, `Editor.getBlock` (with `includeChildren`),
`Editor.updateBlock`, `Editor.insertBlock` (with `sibling` option),
`Editor.appendBlockInPage`, `Editor.getPageBlocksTree`,
`Editor.removeBlock`, `DB.datascriptQuery`, `DB.onChanged`.

The `txData`/`txMeta` shape from `DB.onChanged` is also stable — the
defensive dual-key reads in `updateNewJournalWithAllTODOs` (handling
both legacy `'createdAt'` and namespaced `'block/created-at'`) work
across versions.

---

## 3. Functional testing strategy

Three layers were considered; two are used.

### 3.1 Layer 1 — pure-logic unit tests (Vitest)

Most of the regression-prone logic is pure once extracted from
`logseq.Editor.*` calls. Targets in `src/main.ts`:

- The regex helpers (`todoRegex`, `doneRegex`, `todoDoneRegex`,
  `highlightRegex`, `isUnderlineRegex`)
- `getNextTodoState`, `extractTodoState`, `isHighlighted`
- The group-split loop in `updateNewJournalWithAllTODOs` (lift to
  `splitBlocksIntoGroups(blocks)`)
- The decision branches in `recursiveCopyBlocks` (factor out
  `decideCopyAction(srcBlock, lastDestBlock, hasAnyDoneTask)`
  returning a tagged enum: `skip-done | insert-sibling |
  update-content | remove-source`)

Tests live in `src/lib.test.ts` (or `src/__tests__/`). Cost: <1s per
run. Catches state-machine and regex bugs.

### 3.2 Layer 2 — mocked-SDK orchestration tests (rejected)

Building an in-memory mock of `@logseq/libs` (`Editor.*`, `DB.*`)
faithful enough to model block trees and `parent`/`order` relationships,
then running the migration against it, was considered and rejected.

Reason: the mock's value depends entirely on its fidelity, and a
faithful mock has to be updated every time the SDK changes — exactly
the situation the test exists to catch. Layer 3 hits the real SDK and
catches the same bugs without the maintenance tax.

### 3.3 Layer 3 — headless Logseq E2E (Playwright)

Drive real Logseq.app via Playwright with an isolated temp profile,
against a file-based fixture graph. Catches: real SDK behavior, real
`DB.onChanged` transaction shapes, real journal-creation flow, real
fs-watcher timing.

Run cost: ~13s end-to-end, dominated by Logseq startup. Technical
reference in §4.

### 3.4 Verification surface

| Command | Covers | Cost | CI-friendly |
|---|---|---|---|
| `pnpm check` | TypeScript type errors | <2s | yes |
| `pnpm test` | Pure logic regressions (Layer 1) | <1s | yes |
| `pnpm build` | Bundle parses, single-chunk invariant | ~1s | yes |
| `pnpm perf` | Load-time invariants (`resourceCount === 1`, median threshold under 800ms loopback) | ~15s | yes |
| `pnpm verify` | All four above | ~20s | yes |
| `pnpm test:e2e` | Real SDK behavior, journal migration end-to-end (Layer 3) | ~13s | **no** — needs macOS + Logseq.app |

`pnpm verify` is the agent-runnable umbrella. `pnpm test:e2e` runs
locally against Logseq.app; it's not in CI because GitHub Actions
runners would need to download a Logseq AppImage and replicate the
profile-isolation pattern (the macOS-specific patch in §4.2 wouldn't
apply on Linux but the Linux equivalent still needs writing).

---

## 4. Headless E2E technical reference

This is the runbook for the headless test (`e2e-poc/`, eventually
promoted to `e2e/`). It runs on macOS against `/Applications/Logseq.app`.

### 4.1 What the test does

1. Build the plugin (`pnpm build` if `dist/` is stale).
2. Hard-link-clone Logseq.app to `/tmp/LogseqPatched.app` and patch
   `electron.js` to honor `LOGSEQ_FAKE_HOME` (see §4.2).
3. Create a fresh temp dir for the test profile and graph.
4. Pre-seed yesterday's journal markdown file with mixed
   TODO/DONE/title content; pre-seed today's journal as a placeholder.
   Both filenames are derived from the **system clock** because
   Logseq's `create-today-journal!` looks for today by date.
5. Pre-seed `$TMP_HOME/.logseq/preferences.json` with
   `externals: ["<plugin dist>"]` so the plugin auto-loads.
6. Launch the patched Logseq via `_electron.launch`.
7. Mock `dialog.showOpenDialog` from the main process to return the
   fixture graph path.
8. Click `.action-input` on the welcome screen → graph loads (~5s).
9. Wait for plugin status `loaded` (~5.5s from launch).
10. Wait 4s for cold-load journal parsing to settle.
11. **Trigger the migration: delete today's journal markdown file.**
    Logseq's fs-watcher detects the deletion, runs
    `create-today-journal!`, plugin's filter matches, migration runs.
12. Poll the recreated today file until it shows yesterday's TODOs
    (typically <1s after deletion).
13. Assert: today has all unfinished TODOs (including child blocks),
    today has the duplicated `<ins>` title block, yesterday lost the
    unfinished TODOs, yesterday kept its DONEs, yesterday kept its
    title.
14. Verify the user's real `~/.logseq/settings/` directory wasn't
    touched (mtime snapshot before/after).

### 4.2 The macOS patch — why and what

Setting `HOME=$TMP` is **not** sufficient on macOS to isolate Logseq:

- Node's `os.homedir()` reads `process.env.HOME` — fine.
- Electron's `app.getPath('home')` calls `getpwuid(getuid())->pw_dir`
  and **ignores `HOME`**.

Logseq's `electron.js` mixes both APIs. An unpatched run reads/writes
the user's *real* `~/.logseq/`. Verified empirically: an unpatched
probe wrote `~/.logseq/settings/_<hash>*.json` files into the user's
real profile during a single 8-second run.

The workaround:

1. Hard-link-clone `/Applications/Logseq.app` to
   `/tmp/LogseqPatched.app` via `pax -rwl`. ~3 seconds, ~0 disk
   because hardlinks.
2. Break the hardlink on `Contents/Resources/app/electron.js` only,
   then rewrite it: replace every `app.getPath("home")` and
   `os.homedir()` with `(process.env.LOGSEQ_FAKE_HOME || <original>)`.
   Five total occurrences in current Logseq.
3. Spawn the patched binary with `LOGSEQ_FAKE_HOME=$TMP_HOME` and
   `--user-data-dir=$TMP_HOME/userData`. The latter isolates
   Electron's singleton lock, so the user's running Logseq and the
   test instance coexist.

After the patch, every `~/.logseq/...` read/write goes to `$TMP_HOME`.
Reversible with `rm -rf /tmp/LogseqPatched.app`. The original
`/Applications/Logseq.app` is **never modified**.

### 4.3 Why Flow A (delete today's file) is the right trigger

Trigger paths considered:

| Path | Outcome |
|---|---|
| Click "Choose a folder" then navigate to `#/page/<today>` | Doesn't create the journal — Logseq just shows an empty page. |
| Call `apis.doAction(['openDir'])` directly | Returns the file list to renderer but doesn't go through `create-today-journal!`. |
| Eval the renderer's closure-private `create-today-journal!` | The function isn't reachable from `window`; it lives inside an IIFE. |
| Write today's journal file to disk after launch | Logseq parses it as content-import; `DB.onChanged` tx shape doesn't match the plugin's filter. |
| **Pre-seed yesterday + today, delete today after launch** | **Works.** Logseq's fs-watcher detects the deletion, runs `create-today-journal!`, single tx with `createdAt === updatedAt && journal? === true` — plugin's filter matches first try. |

Flow A mirrors a real-world manual reproduction: open Logseq, delete
today's file, watch Logseq re-create it with migrated content. It
exercises the same code path as the in-app "Today" link click, the
day-rollover timer, and any other UI path that triggers
`create-today-journal!`.

### 4.4 Disk reads as the assertion target

The test reads the migrated `<today>.md` and `<yesterday>.md` markdown
files and runs regex assertions. Disk is ground truth; the SDK is the
system under test, so asserting via `getPageBlocksTree` from the
renderer would be circular. Disk reads also avoid any need for SDK
access from Playwright's evaluation context.

### 4.5 Bug surfaced on the first end-to-end run

On cold-load Logseq parses journals serially. The plugin's
`DB.onChanged` listener can fire on yesterday's journal **before**
yesterday is in datascript, making `prevJournals` empty and
`prevJournals.reduce(...)` throw "Reduce of empty array with no initial
value." Silently swallowed in the async listener.

Defensive fix: early-return when `prevJournals.length === 0`. That
case is also semantically correct — there's nothing to migrate from a
graph with no prior journals.

### 4.6 Extending the test

When unit tests land alongside in `src/lib.test.ts`, the E2E suite
should move from `e2e-poc/` to `e2e/` and gain a `pnpm test:e2e`
script. Adjacent improvements worth doing then:

- Multiple test cases per Logseq instance (avoid the ~6s startup
  per-case overhead). Pre-seed a fixture, run, swap fixtures, run
  again. Need a way to reset plugin state between cases — either
  delete-and-repeat, or expose `Editor.createPage` via a tiny
  test-helper plugin.
- Test the cross-day-rollover scenario (today's journal pre-exists
  with content, isn't replaced — only new tasks arrive).
- Test the empty-graph case directly.
- Test the keyboard shortcuts (`mod+1` toggle TODO, `mod+4` toggle
  highlight). These need synthetic keyboard events through Playwright;
  `App.registerCommandPalette` bindings should be reachable through
  the command-palette UI.

### 4.7 What to NOT do

- **Don't relax the `DB.onChanged` filter.** It correctly matches the
  in-app journal-creation path. Loosening it would re-fire migration
  on every Logseq startup as it parses existing journals.
- **Don't replace the macOS patch with a plain `HOME` override.**
  Electron's `app.getPath('home')` ignores `HOME`. Without the patch
  the test writes to the user's real `~/.logseq/`.
- **Don't ship `e2e/` to the marketplace dist.** It's a dev tool;
  exclude from the build.
- **Don't assert via the SDK from the renderer when disk reads work.**
  Disk is ground truth.

---

## 5. Modernization landscape

Pinned target stack for any future toolchain bump:

| Area | Target | Notes |
|---|---|---|
| `@logseq/libs` | `0.0.17` | `latest` dist-tag. `0.2.x`/`0.3.x` are `next`. The maintained-plugin tail sits at `^0.0.17`. Don't bump until the §2 SDK breakages are fixed. |
| TypeScript | `^5.9` | No code-side migration cost. |
| Vite | `^7.1` | Active plugin `vipzhicheng/logseq-plugin-vim-shortcuts` is on Vite 7. Skip 8.x — beta only. |
| Node engine | `>=20.19` | Vite 7 requires this. CI is at Node 20. |
| pnpm | pinned via `packageManager: pnpm@10.x` | Drops `npm install -g pnpm` from CI; corepack handles. |
| `@types/node` | `^22` | Match Node 20+ runtime. |
| ESLint + `@typescript-eslint/*` | **delete** | Never had a `lint` script wired up. If a linter is needed later, reach for Biome. |
| Vitest | `^3` | Unit test runner. |
| Playwright | `^1.59` | E2E driver. |

### `tsconfig.json` cleanup

The current file is a Microsoft template with ~70 lines of dead
commented options and `"module": "commonjs"` (wrong; only "works"
because Vite ignores the field for bundling). A clean replacement is
~15 lines:

```jsonc
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ESNext", "DOM"],
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "sourceMap": true
  },
  "include": ["src"]
}
```

`noEmit: true` makes TS a type-checker only; Vite handles emit.
`pnpm check` then runs `tsc --noEmit`.

### Workflow modernization (`.github/workflows/publish.yml`)

The current workflow has known bit-rot:

- `actions/checkout@v2` → bump to `@v4`
- `actions/upload-release-asset@v1` is archived → use
  `softprops/action-gh-release@v3`, which handles release creation and
  asset upload in one step (also drops `ncipollo/release-action` —
  redundant)
- `set-output` deprecated syntax → use `$GITHUB_OUTPUT`
- Add a tag-vs-`package.json`-version gate at the top of the job. The
  0.0.7 release shipped with `package.json` still saying `0.0.6`; the
  Marketplace card and unpacked card disagreed for over a year. The
  gate prevents the recurrence:

  ```yaml
  - name: Verify package.json version matches tag
    run: |
      PKG_VERSION=$(node -p "require('./package.json').version")
      TAG_VERSION="${GITHUB_REF_NAME#v}"
      [ "$PKG_VERSION" = "$TAG_VERSION" ] || {
        echo "version mismatch: pkg=$PKG_VERSION tag=$TAG_VERSION"
        exit 1
      }
  ```

### Marketplace metadata

`package.json` `logseq` block currently has only `icon`. Add:

```json
"logseq": {
  "id": "logseq-plugin-daily-todo",
  "icon": "./icon.png",
  "title": "Daily TODO"
}
```

`logseq.id` is required per the SDK skill. The Marketplace
`manifest.json` (in the `logseq/marketplace` repo, not this one)
should declare `"supportsDB": false` until DB graph mode is
smoke-tested.

### Why not scratch-rebuild from a current template

Surveyed templates as of 2026-05:

- `pengx17/logseq-plugin-template-react`: recently updated, but stack
  is Vite 4 + TS 4.9 + `@logseq/libs ^0.0.17`. Stale toolchain. Adds
  React for no reason — this plugin has no UI.
- `vipzhicheng/logseq-plugin-vue3-template`: 404.
- `logseq/logseq-plugin-template-react` in the official org: 404.
- `YU000jp/logseq-plugin-sample-kit-typescript`: linked from the SDK
  SKILL.md; usable as reference but not as a starting point.

A scratch rebuild buys nothing concrete here. In-place upgrade
preserves git history, npm package identity, marketplace listing
slug, existing user `settings.json` (`settingsVersion: 'v1'`), and
the investigated journal-migration edge cases.

---

## 6. AI-first repo conventions

This is a 300-LOC leaf project. The minimum viable AI-first kit is:

1. **Root `AGENTS.md`** — front door; decision-table for "what you're
   doing → which `agents/*.md` to read." Lists the verification
   commands.
2. **Root `CLAUDE.md`** — short redirect to `AGENTS.md` plus any
   Claude-Code-specific notes.
3. **`agents/`** — topic-named markdown files for stable knowledge:
   `overview.md`, `logseq-plugin-loading.md`, `build-and-release.md`,
   `perf-testing.md`, `gotchas.md`. Topic guides answer "how does
   this work today."
4. **`agents/research/YYYY-MM-DD-topic.md`** — dated investigation
   logs. Research answers "how did we figure this out and what else
   did we consider."
5. **`package.json` scripts as the verb surface.** Every action an
   agent might want is a named script with a stable name (`check`,
   `test`, `test:e2e`, `perf`, `verify`).

### Patterns worth using

1. **Two-tier doc index.** Root `AGENTS.md` as front door; detailed
   TOC in `agents/README.md`. Keyword-friendly for LLMs.
2. **Decision-table phrasing in the index.** "What you're doing |
   Read this first" beats prose.
3. **Dated research logs separate from topic guides.** Mixing them
   rots the topic guides.
4. **Scripts as the verb surface.** Stable names, agent-discoverable
   through `package.json`.
5. **Umbrella verification command.** One canonical "did I break it?"
6. **Don't-do items inline with rationale.** State the prohibition
   and the *why* in the same paragraph (we already do this in
   `agents/gotchas.md`).
7. **`agents/STATUS.md` for in-flight efforts.** Multi-session work
   drops a STATUS, deletes it when the work lands. Don't keep
   permanently.

### Patterns deliberately skipped at this size

- `.claude/commands/` — slash command authoring is overkill at this size
- `.claude/scripts/` — no integrations to wrap
- `agents/skills/` — skills are a workspace-wide concept
- `agents/prompts/` — no agent flows complex enough to template
- `agents/plans/` — plans for a 300-LOC repo are commit messages
- ADRs / `docs/decisions/` — `gotchas.md` + research log already
  serve the decision-record role
- `docs/` directory — `agents/` already serves that purpose
- `.cursor/rules/` and `.clinerules/` — only ship if those tools are
  actively used

### Cross-tool standards (May 2026)

`AGENTS.md` is converging as the cross-tool standard. The pragmatic
minimum-universal kit is `AGENTS.md` + `CLAUDE.md` (one-line
redirect). `.github/copilot-instructions.md` only if Copilot is in
scope; Cursor's `.cursor/rules/` only if Cursor is actively used.

---

## 7. Out of scope (with reasons)

- **Scratch rebuild.** No template combines a clean toolchain with the
  right scope (no UI, no React); rebuilding loses the journal-migration
  edge cases.
- **`@logseq/libs@0.3.x`.** Still on `next` dist-tag, larger bundle
  (~103KB vs ~75KB) — moves the wrong way for the load-time concern.
  Revisit if/when DB-graph features are needed.
- **Headless Logseq in CI.** Requires Linux AppImage download, profile
  isolation pattern that doesn't need the macOS patch, and a fake
  system clock for date-rollover tests. Punted.
- **A companion test-helper plugin.** Was considered to expose
  `Editor.createPage` to the test; turned out unnecessary because Flow
  A (delete today, let Logseq re-create) gives the same trigger via
  the public file-watcher path.
- **Layer 2 mocked-SDK tests.** Maintenance tax outweighs the value
  given Layer 3 hits the real SDK.
