---
topic: logseq-sync-implications
date: 2026-05-09
status: reference
tags:
  - sync
  - multi-device
  - db-onchanged
  - migration
  - duplication
summary: >
  How Logseq Sync (paid beta, file-graph era — pre-DB-graph pivot)
  interacts with the plugin's `DB.onChanged` listener. Sync transmits
  files, not transactions; pulled files arrive via the fs-watcher path.
  Each device has its own `create-today-journal!` 5-second poll, with
  no cross-device coordination. The "mobile fires migration the next
  morning" phenomenon is local-cache behavior, not sync magic. The
  multi-device duplication risk is real but bounded.
---

# Logseq Sync — implications for the plugin

A reference for anyone reasoning about the plugin's behavior in a
multi-device setup. All Logseq source references are against tag
`0.10.9` (the last stable file-graph release before the DB-graph
pivot). DB graphs use a different sync stack (`deps/db-sync/`,
`src/main/frontend/worker/sync.cljs`) and are out of scope here — see
§7.

## 1. What Sync transmits

**Whole files, not datascript transactions.** Logseq Sync is a deltaful
S3-style file sync delegating heavy lifting to a Rust binary (the
`rsapi` — Rust Sync API).

Source: `src/main/frontend/fs/sync.cljs:735-771` defines the `IRSAPI`
protocol — `<update-local-files`, `<update-remote-files`,
`<delete-local-files`, `<rename-local-file`, `<fetch-remote-files`,
`<encrypt-fnames`, `<decrypt-fnames`. The actual implementation goes
through Electron IPC (`ipc/ipc "update-local-files" ...` at lines
871-877) and Capacitor on mobile (line 973+).

Server-side state is `[user-uuid graph-uuid transaction-id]` (sync.cljs
lines 47-49). Each remote commit produces a `FileTxn` (sync.cljs ~1700,
`apply-filetxns`) with one of `renamed?`, `updated?`, `deleted?`. Local
clients pull the diff of `FileTxn`s since their last txid and apply by
writing files to disk.

**There is no datascript transaction wire format.** The transmission
unit is whole-file content keyed by encrypted filename.

### Encryption

End-to-end via [age](https://github.com/FiloSottile/age). Per-graph
keypair: server stores the public key plus an encrypted private key;
the user's passphrase decrypts the private key locally (sync.cljs:850-856,
2023-2028). Both file contents and filenames are encrypted.

This is the **paid tier**'s only sync. There is no free-tier file
sync; free users have plugin-based git sync or nothing.

## 2. Boot sequence on a freshly-opened device

The plugin's listener fires very early — *before* sync has had a chance
to do anything. Order from `events.cljs handle :graph/ready` and
`restore-and-setup!` in `handler.cljs`:

1. **`db/restore!`** — hydrate DataScript from the local IndexedDB
   cache. The DB is **fully populated from the last session** before
   any sync I/O.
2. **`:graph/ready` event fires.**
3. **`preload-graph-homepage-files!`** (`watcher_handler.cljs:139-190`)
   — reads today's journal file from disk if it exists, compares to
   db-content, calls `handle-add-and-change!` if different. One-shot
   disk read, NOT a sync pull.
4. **`load-graph-files!`** — full disk reconciliation against db.
5. **`watch-for-date!`** interval starts (`handler.cljs:61-72`) — every
   5 seconds calls `create-today-journal!`. Runs even offline. Acts as
   the "cron".
6. **Sync** runs in a background go-loop, pulling remote `FileTxn`s and
   writing files via `<update-local-files`. Each successful file write
   goes through Electron's chokidar (or Capacitor on mobile) and IPCs
   `change`/`add` events to `frontend.fs.watcher-handler/handle-changed!`.

The 5s poll typically fires **before** sync converges. That ordering
matters for the duplication risk in §6.

## 3. Per-device `create-today-journal!` — no coordination

There is **no primary device, no midnight cron, no cross-device
coordination**.

Every device has its own `watch-for-date!` 5-second poll
(`handler.cljs:72`) that calls `create-today-journal!`. The function
(`page.cljs:823-852`) only acts when `db/page-empty? repo today-page`
returns true, then:

- Calls `create!` (`page.cljs:125-178`) which produces a single
  `db/transact!` with `:outliner-op :create-page`. This tx has the
  page entity with `:block/created-at == :block/updated-at` and
  `:block/journal? true`.
- Immediately calls `editor-handler/api-insert-new-block!` to create a
  first empty block under the new page.

**The plugin's `DB.onChanged` filter (`createdAt === updatedAt &&
journal? === true` on a single tx) targets exactly this page-creation
transaction.**

`db/page-empty?` is a **local-DB-only** check. It does not consult the
filesystem or the sync pipeline. There is no atomic "if remote has no
today's journal yet, create one" coordination.

## 4. Sync conflict resolution

**Default: last-writer-wins on the server, with a versioned-file backup
on the loser.** Before overwriting a local file whose content differs
from incoming server content, the local client writes the previous
content to `logseq/version-files/local/...` (`<add-new-version` at
sync.cljs:926; invocation at sync.cljs:1739-1746). The user can browse
"Page History" to recover.

**Optional three-way merge.** `state/enable-sync-diff-merge?` toggles
between plain overwrite (`<update-local-files`) and
`<fetch-remote-and-update-local-files` which performs a block-aware
three-way text merge using the `@logseq/diff-merge` npm module
(`fs/diff_merge.cljs:170` `three-way-merge`). The merge is keyed by
block UUIDs.

**No `<<<<<<<` / `>>>>>>>` conflict markers are written into markdown.**
The version-files directory is the only conflict artifact.

If two devices both create today's journal independently before sync
converges, they produce **different page UUIDs** (squuid in
`block.cljs:313`). Default mode: whichever uploads second wins on the
server; the loser's version lives in `version-files/local/`. With
diff-merge: the merge keys by UUID, and since the two pages have
different UUIDs they will not deduplicate cleanly — the user is likely
to see concatenated blocks or two same-named pages.

## 5. The observed phenomenon — laptop asleep, mobile fires migration

> "Even when the laptop is asleep and disconnected, opening Logseq on
> mobile for the first time on a new day fires the plugin and migrates
> tasks to the latest journal."

**This is local-cache behavior, not sync magic.** Walking through what
happens when mobile opens the next morning:

1. App boots. `db/restore!` rehydrates DataScript from mobile's
   IndexedDB cache. **Mobile already has yesterday's journal in its
   DB** because mobile had it open at some point yesterday (or pulled
   it via a previous sync). The DB cache survives across app restarts
   on each device.
2. `:graph/ready` fires. Sync starts pulling remote `FileTxn`s. For
   the migration to work, sync does not need to deliver anything new
   — yesterday's content is already in mobile's local DB.
3. The 5s `watch-for-date!` poll runs. `db/page-empty? repo "today"`
   returns true. `create-today-journal!` produces a single page-creation
   tx.
4. The plugin's `DB.onChanged` matches.
   `queryCurrentRepoRangeJournals(newJournalBlock.journalDay)` returns
   yesterday's journal **from the local DataScript DB** — that data
   was already there before sync did anything. Migration runs.
5. Sync now pushes today's newly-created journal file to the server.

**Key insight: sync is not on the critical path of the migration.** The
plugin works because mobile's local DB held yesterday's journal from
before the laptop slept. Whether sync had time to pull updates or not
is irrelevant. The migration would happen even if mobile were entirely
offline, as long as yesterday's journal is in the IndexedDB cache.

## 6. When the laptop wakes — does it re-fire migration?

Yes for `create-today-journal!`, no for sync ingestion.

Sequence when the laptop wakes:

1. JS event loop resumes. `watch-for-date!` poll runs.
2. **Today's page is empty in laptop's DB.** Laptop fires
   `create-today-journal!` *before sync has had a chance to pull*.
   Laptop creates its own today's journal (different page UUID from
   mobile's, possibly different content). **Plugin fires on laptop
   too.** Migration happens a second time using laptop's local view of
   yesterday's TODOs.
3. Sync starts. Pulls remote `FileTxn`s from the server. Server has
   mobile's today's journal.
4. Sync writes the remote today's journal file to disk (overwrite or
   three-way merge). File watcher fires `change` →
   `handle-changed!` → `alter-file` → `reset-file!` → `parse-file` →
   `db/transact!`.

**The sync-driven transaction looks structurally different from
`create-today-journal!`'s tx**:

- It is a parser-output multi-block tx with `:from-disk? true` and
  `:fs/event :fs/local-file-change` in tx-meta
  (`file_handler.cljs:158-160`).
- The page entity reuses the existing entity if present
  (`page-name->map` short-circuits via `page-entity` when
  `(d/entity [:block/name page-name])` is non-nil — `block.cljs:305-312`).
- Even on a fresh page, `with-timestamp?` only adds `created-at`/
  `updated-at` `(when (and with-timestamp? (not page-entity)))`
  (`block.cljs:319`), and explicit timestamps come from
  `created-at::`/`updated-at::` properties if present —
  not freshly-stamped equal values.

**Result**: the fs-watcher sync ingestion path **does not produce a tx
with `createdAt === updatedAt && journal? === true`**. The plugin
filter does not match. **Sync delivery does not re-fire migration.**

This generalizes the earlier rule-11 finding ("file-watcher additions
don't trigger the plugin"): sync goes through the same fs-watcher path,
and the plugin's filter is robust against it.

## 7. Multi-device duplication — the real risk

The plugin **can** double-migrate in two scenarios:

### Scenario A: both devices boot offline / before sync converges

Each device sees "today is empty in my local DB", each runs
`create-today-journal!`, each fires the plugin, each runs migration
locally. When they meet via sync, default last-writer-wins picks one;
the other lives in `version-files/local/`. With diff-merge enabled,
both pages have different UUIDs so the merge concatenates them, giving
duplicated TODOs in today.

### Scenario B: race on already-online devices

Device A creates today's journal at 08:00:00; sync push starts. Before
push completes, device B's 5s poll fires (08:00:03). B's DB is still
empty for today. B creates its own today's journal. Both run migration
locally. After sync converges, same outcome as Scenario A.

### Yesterday's journal also gets touched twice

Migration is destructive on the source side: it removes migrated TODOs
from yesterday's journal. If both devices run migration, both modify
yesterday too. Last-writer-wins on yesterday's file means whichever
device's modified yesterday lands on the server first wins; the other
device's view of yesterday gets overwritten. Whichever DONE/title
blocks happened to differ between the two devices' migration
executions can be lost.

### Severity in practice

- Probability is bounded: requires both devices to be active around
  midnight-or-first-open of a new day.
- Impact when it happens: duplicated TODOs in today + potentially lost
  blocks in yesterday.
- The user has at least observed the "mobile migrates" behavior, which
  means the mobile-then-laptop ordering is real. If laptop opens later
  and yesterday's journal has already been mutated by mobile, laptop
  sees a yesterday with **fewer TODOs to migrate**, so its second
  migration run produces less content. But the page-creation race for
  today still produces two competing today-journal files.

## 8. What this means for the plugin design

We are not changing the plugin in this doc. But if/when sync-aware
behavior is added, the design constraints are:

1. **Idempotent-by-design migration is the most defensible approach.**
   Two devices migrating the same yesterday should converge to the
   same today. Currently the plugin removes blocks from yesterday and
   appends to today; doing this twice produces different state because
   the second run sees a different yesterday. An idempotent design
   would need a marker (e.g. `:migrated-from <yday-page-uuid>` on
   today's blocks) to detect "already done" and no-op.
2. **A persisted "last migrated journal-day" in `logseq.settings` is
   not enough by itself in a multi-device world.** Each device has its
   own settings; both can independently fire and both believe they
   "own" the migration. The marker has to live on the data
   (today/yesterday's content) to survive sync.
3. **Don't depend on the fs-watcher tx shape from sync to fire the
   listener.** Sync ingestion goes through the parser path with
   `:from-disk? true` and the page-entity short-circuit. The
   `create-today-journal!` shape is reliable; the parser-path shape is
   not.
4. **The `:today-journal-created` plugin app-hook** (`page.cljs:851`,
   `plugin-handler/hook-plugin-app`) is more semantically correct than
   tx-shape filtering — but it is only emitted by the in-app
   `create-today-journal!`, not by sync ingestion, so it inherits the
   same per-device-fire problem. Using it would simplify the trigger
   filter without solving the duplication risk.

## 9. What we don't know — needs empirical testing

1. **Exact tx shape on sync ingestion of a fresh today's journal
   authored by another device.** The 0.10.9 code path strongly implies
   the parser path produces a multi-block tx with `:from-disk? true`
   and no fresh equal-timestamps on the page entity. But: (a)
   `preload-graph-homepage-files!` runs before the watcher, and (b) if
   the page entity does not yet exist in the receiving device's DB,
   `page-name->map` may produce a brand-new entity with `created-at ==
   updated-at`. Test: device A creates today, syncs; device B with a
   wiped DB receives the file via sync; inspect the actual tx in
   `DB.onChanged` (add `console.log({datums: txData})` temporarily).
2. **Mobile sync pull timing relative to `watch-for-date!`.** Whether
   mobile typically completes its initial sync pull before the 5s poll
   fires would determine whether the pull-first ordering ever happens
   in practice. If sync usually finishes first, mobile sees today's
   journal already in DB after sync ingestion, and `create-today-journal!`
   no-ops.
3. **Default value of `enable-sync-diff-merge?`.** Most users probably
   have it off (default), but the plugin's behavior under each mode
   for duplicated migrations differs.
4. **DB-graph era.** The user is on file graphs. If they migrate to a
   DB graph, sync becomes RTC-based (`deps/db-sync/`) and transmits
   datascript-level ops. Plugin behavior under that stack is a
   separate research question and almost certainly different.
5. **Whether `:today-journal-created` ever fires twice on the same
   device.** Per-session state, but worth confirming: does a stale
   poller across hibernate/sleep ever double-invoke?

## 10. Source references

`logseq/logseq` at tag `0.10.9`:

- `src/main/frontend/handler.cljs:61-72` — 5s `watch-for-date!` poll
- `src/main/frontend/handler/page.cljs:823-852` — `create-today-journal!`
- `src/main/frontend/handler/page.cljs:125-178` — `create!` and the
  page-creation transaction
- `deps/graph-parser/src/logseq/graph_parser/block.cljs:287-326` —
  `page-name->map`, source of `created-at == updated-at` on page
  creation
- `src/main/frontend/fs/sync.cljs:735-771` — `IRSAPI` protocol
- `src/main/frontend/fs/sync.cljs:850-856, 2023-2028` — age encryption
- `src/main/frontend/fs/sync.cljs:1700-1761` — `apply-filetxns`
- `src/main/frontend/fs/sync.cljs:1735-1737` — diff-merge vs plain
  overwrite branch
- `src/main/frontend/fs/diff_merge.cljs:170` — `three-way-merge`
- `src/main/frontend/fs/watcher_handler.cljs:58-137` — `handle-changed!`
- `src/main/frontend/handler/file.cljs:142-196` — `alter-file`
- `src/main/frontend/handler/common/file.cljs:95-113` — `reset-file!`
  (calls `graph-parser/parse-file`)
- `src/main/frontend/handler/file_sync.cljs` — high-level sync
  orchestration
- `src/main/frontend/handler/events.cljs:368, 440, 632, 672` — call
  sites for `create-today-journal!` outside the poll (manual triggers,
  route changes)

## 11. Cross-references

- [`agents/gotchas.md`](../gotchas.md) — "Migration only fires on a
  *fresh* journal creation" section enumerates the trigger paths that
  reach the listener. Sync's fs-watcher ingestion path is **not**
  among them; this doc explains why.
- [`agents/research/2026-05-09-modernization-ai-first-and-e2e.md`](./2026-05-09-modernization-ai-first-and-e2e.md)
  §2.4 — the trigger filter is correct; do not relax it. Multi-device
  considerations don't change that conclusion: a relaxed filter would
  fire on sync-delivered journals and re-migrate on every Logseq
  startup, which is strictly worse than the current per-device
  duplication risk.
