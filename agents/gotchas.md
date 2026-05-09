# Gotchas

Non-obvious things that will trip you up. Each one cost real time to
discover; they're documented here so the next person doesn't repeat the
investigation.

## The 6s warning is about iframe load, not your code

Code inside `main()` (which is your `logseq.ready()` callback) does **not**
count toward the 6s threshold. The metric is captured on the host side and
stops the moment the Postmate handshake is replied to — which happens when
`logseq.ready()` is *called*, not when its callback finishes.

If you see the warning, do **not** start optimizing the journal-migration
logic, the `DB.onChanged` handler, or anything in `main()`. Look at the
build output: bundle structure, chunk count, and what the iframe fetches
before reaching `ready()`.

Full mechanics in [`logseq-plugin-loading.md`](./logseq-plugin-loading.md).

## `DB.onChanged` does not replay past transactions

It only fires for transactions that happen **after** the listener is
registered. Don't worry about it being expensive at startup — it isn't.
And don't add &quot;catch up on missed events&quot; logic; there's nothing to
catch up.

## Migration only fires on a *fresh* journal creation

The plugin's filter requires `createdAt === updatedAt && journal? === true`
on a single transaction. That shape is what Logseq's in-app
`create-today-journal!` emits when today's journal does not yet exist
in datascript — used by the day-rollover timer, by the today-link click
on a new day, and by the fs-watcher reacting to today's file being
deleted.

A consequence: **today's journal is always empty at the moment migration
runs**. There is no real-world scenario where the listener fires while
today's journal has pre-existing content:

- **File deletion**: Logseq's `create-today-journal!` re-creates today
  as a fresh empty page; any prior file content is gone before the
  migration's `getPageBlocksTree` runs.
- **UI navigation to today / sidebar Journals click**: if today already
  exists in datascript (with or without content), Logseq doesn't fire
  a creation transaction, so the listener doesn't fire at all.
- **Day rollover at midnight**: today is freshly created — no content yet.
- **Cold start on a new day**: same — Logseq creates today empty before
  the listener runs.

In `recursiveCopyBlocks` the branch at `lastDestBlock.content !== ''`
exists for the &quot;today has its own existing content&quot; case in the
abstract, but in practice that branch is unreachable through real
triggers — `getLastBlock(newJournalBlock.name)` always returns the
freshly-created empty placeholder bullet. Don't &quot;optimize&quot; that
branch away assuming it's dead code; if Logseq's create-today behavior
ever changes, it could become live again.

The E2E suite does not cover the &quot;today has pre-existing content&quot;
scenario for this reason.

## Logseq writes to your unpacked `package.json`

When you `Load unpacked plugin`, Logseq adds a randomly-generated
`logseq.id` field to `dist/package.json` so the install has a unique
identifier. This is expected and is local to that unpacked install.

**Do not copy this `id` back into the source `package.json`.** It belongs
only in the unpacked folder. The build script regenerates `dist/package.json`
from source on every `pnpm build`, so the id is rewritten on each build —
which means it changes every time you load unpacked, which is fine. The
plugin's stable identity in the Marketplace comes from the GitHub repo
slug, not from this id.

## Versions can drift between tag and `package.json`

The publish workflow fires on tag push and bundles `dist/package.json`
into the release. But `package.json`'s `&quot;version&quot;` is independent from
the tag name — the workflow doesn't enforce that they match. We've seen
a real instance where tag `0.0.7` was pushed but `package.json` still
said `&quot;0.0.6&quot;`, and the Marketplace card showed `0.0.7` while the
unpacked card showed `0.0.6` for over a year.

**Always bump `package.json` *before* tagging.** See
[`build-and-release.md`](./build-and-release.md) for the checklist.

## `manualChunks` is not your friend here

Bundle splitting is good for web apps with shared CDN caching. It is
**not** good for Logseq plugins. Plugin assets aren't shared across
plugins, and every chunk is a separate fetch through Logseq's `lsp://`
Electron protocol handler — which is per-request IPC, not free. Splitting
adds roundtrips before `logseq.ready()` can fire. Keep
`inlineDynamicImports: true`.

## Loopback HTTP ≠ `lsp://`

The local perf harness uses `python3 -m http.server` over loopback. That's
much faster than how Logseq actually serves plugin assets (each `lsp://`
fetch is an Electron IPC roundtrip via a `registerFileProtocol` handler).
Numbers from the harness are useful for **relative** comparison only —
chunk count, presence of new requests, regression detection. For real
absolute numbers, install the build into Logseq and use
`__debugPluginsPerfInfo()`.

## `@logseq/libs` v0.0.9 vs newer

This plugin pins `@logseq/libs@0.0.9`. v0.2/v0.3 changed enough APIs that
upgrading isn't a drop-in — at minimum, sanity-check that `Editor`, `DB`,
`App`, and `DB.onChanged` still match what `src/main.ts` uses. If you do
upgrade, retest the journal-migration flow end-to-end against a real
journal — the block-traversal API has been the most volatile area between
versions.

The size delta is also against you: 0.3.3's `lsplugin.user.js` is ~103KB
vs 0.0.9's ~75KB. Don't upgrade for perf reasons alone.

## The plugin's keyboard shortcuts are global

`mod+1` and `mod+4` fire whether or not the user is editing a block. The
handlers gracefully no-op when there's no current block or selection.
Don't add code paths that throw in that case.

## CommonJS-style `flat()` requires Node ≥ 11

`queryCurrentRepoRangeJournals` calls `(journals || []).flat()`. This
exists for older Logseq builds that returned nested arrays from
`datascriptQuery`. Don't &quot;simplify&quot; it away unless you've confirmed
the current Logseq returns a flat result for this query shape.
