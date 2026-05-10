---
topic: logseq-sync-implications
date: 2026-05-10
status: reference
tags:
  - sync
  - multi-device
  - mobile
  - db-onchanged
  - migration
  - duplication
  - power-nap
summary: >
  How Logseq Sync (paid beta, file-graph era) interacts with the plugin's
  DB.onChanged listener. Sync transmits files, not transactions; pulled
  files arrive via the fs-watcher path and don't re-fire migration. Each
  device runs its own create-today-journal! poll independently — there's
  no cross-device coordination. Plugins do NOT run on Logseq mobile, so
  any migration the user sees on mobile was produced earlier on a
  desktop and synced as markdown. The "overnight migration with the lid
  closed" phenomenon is macOS Power Nap firing the desktop's Logseq
  during DarkWake windows. Multi-device duplication risk exists but is
  bounded to the desktop-vs-desktop case.
---

# Logseq Sync — implications for the plugin

A reference for anyone reasoning about the plugin's behavior in a multi-device setup. All Logseq source references are against tag `0.10.9` (the last stable
file-graph release before the DB-graph pivot). DB graphs use a different sync stack (`deps/db-sync/`, `src/main/frontend/worker/sync.cljs`) and are out of scope
here — see §7.

## 1. What Sync transmits

**Whole files, not datascript transactions.** Logseq Sync is a deltaful S3-style file sync delegating heavy lifting to a Rust binary (the `rsapi` — Rust Sync
API).

Source: `src/main/frontend/fs/sync.cljs:735-771` defines the `IRSAPI` protocol — `<update-local-files`, `<update-remote-files`, `<delete-local-files`,
`<rename-local-file`, `<fetch-remote-files`, `<encrypt-fnames`, `<decrypt-fnames`. The actual implementation goes through Electron IPC (`ipc/ipc
"update-local-files" ...` at lines 871-877) and Capacitor on mobile (line 973+).

Server-side state is `[user-uuid graph-uuid transaction-id]` (sync.cljs lines 47-49). Each remote commit produces a `FileTxn` (sync.cljs ~1700,
`apply-filetxns`) with one of `renamed?`, `updated?`, `deleted?`. Local clients pull the diff of `FileTxn`s since their last txid and apply by writing files to
disk.

**There is no datascript transaction wire format.** The transmission unit is whole-file content keyed by encrypted filename.

### Encryption

End-to-end via [age](https://github.com/FiloSottile/age). Per-graph keypair: server stores the public key plus an encrypted private key; the user's passphrase
decrypts the private key locally (sync.cljs:850-856, 2023-2028). Both file contents and filenames are encrypted.

This is the **paid tier**'s only sync. There is no free-tier file sync; free users have plugin-based git sync or nothing.

## 2. Mobile does NOT run plugins

This is the single most important fact for reasoning about cross-device behavior. Logseq's Capacitor iOS/Android app gates plugin install, marketplace UI, and
`LSPluginCore` bootstrap behind `(util/electron?)` checks:

- `lsp-enabled?` (`src/main/frontend/config.cljs:149-152`) requires `util/plugin-platform?`, defined as `(or (and web-platform? (not PUBLISHING)) (electron?))`
  (`src/main/frontend/util.cljc:139`). On Capacitor mobile, `electron?` is false and `web-platform?` is also false, so `plugin-platform?` is false.
- `frontend.handler.plugin/setup!` (`src/main/frontend/handler/plugin.cljs:1339-1344`) early-returns without calling `init-plugins!` when `lsp-enabled?` is
  false.

There is no Postmate host on mobile, no plugin iframe sandbox, nothing.

**Implication**: this plugin's migration logic only runs on desktop (Electron) devices. Mobile sees migration *results* through sync — it pulls today's
already-migrated journal file from the server and renders it. From the user's perspective, "I opened my phone in the morning and yesterday's TODOs were already
in today" is the result of migration that ran on a desktop earlier, not on the phone.

## 3. Boot sequence on a freshly-opened device

The plugin's listener fires very early on desktop — *before* sync has had a chance to do anything. Order from `events.cljs handle :graph/ready` and
`restore-and-setup!` in `handler.cljs`:

1. **`db/restore!`** — hydrate DataScript from the local IndexedDB cache. The DB is **fully populated from the last session** before any sync I/O.
2. **`:graph/ready` event fires.**
3. **`preload-graph-homepage-files!`** (`watcher_handler.cljs:139-190`) — reads today's journal file from disk if it exists, compares to db-content, calls
   `handle-add-and-change!` if different. One-shot disk read, NOT a sync pull.
4. **`load-graph-files!`** — full disk reconciliation against db.
5. **`watch-for-date!`** interval starts (`handler.cljs:50-72`) — every 3 seconds calls `create-today-journal!`. Runs even offline. Acts as the
   "cron".
6. **Sync** runs in a background go-loop, pulling remote `FileTxn`s and writing files via `<update-local-files`. Each successful file write goes through
   Electron's chokidar (or Capacitor on mobile) and IPCs `change`/`add` events to `frontend.fs.watcher-handler/handle-changed!`.

The 3 s poll typically fires **before** sync converges. That ordering matters for the duplication risk in §6.

## 4. Per-device `create-today-journal!` — no coordination

There is **no primary device, no midnight cron, no cross-device coordination**.

Every desktop has its own `watch-for-date!` 3-second poll (`handler.cljs:50-72`) that calls `create-today-journal!`. The function (`page.cljs:281-299`) only
acts when `db/page-empty? repo today-page` returns true, then:

- Calls `create!` (`page.cljs:125-178`) which produces a single `db/transact!` with `:outliner-op :create-page`. This tx has the page entity with
  `:block/created-at == :block/updated-at` and `:block/journal? true`.
- Immediately calls `editor-handler/api-insert-new-block!` to create a first empty block under the new page.

**The plugin's `DB.onChanged` filter (`createdAt === updatedAt && journal? === true` on a single tx) targets exactly this page-creation transaction.**

`db/page-empty?` is a **local-DB-only** check. It does not consult the filesystem or the sync pipeline. There is no atomic "if remote has no today's journal
yet, create one" coordination.

Mobile also runs `watch-for-date!`/`create-today-journal!` natively in core — but the plugin isn't loaded there, so creating today's journal on mobile produces
no migration. Mobile's today's journal starts empty unless sync delivers a desktop-migrated version.

## 5. Sync conflict resolution

**Default: last-writer-wins on the server, with a versioned-file backup on the loser.** Before overwriting a local file whose content differs from incoming
server content, the local client writes the previous content to `logseq/version-files/local/...` (`<add-new-version` at sync.cljs:926; invocation at
sync.cljs:1739-1746). The user can browse "Page History" to recover.

**Optional three-way merge.** `state/enable-sync-diff-merge?` toggles between plain overwrite (`<update-local-files`) and `<fetch-remote-and-update-local-files`
which performs a block-aware three-way text merge using the `@logseq/diff-merge` npm module (`fs/diff_merge.cljs:170` `three-way-merge`). The merge is keyed by
block UUIDs.

**No `<<<<<<<` / `>>>>>>>` conflict markers are written into markdown.** The version-files directory is the only conflict artifact.

If two devices both create today's journal independently before sync converges, they produce **different page UUIDs** (squuid in `block.cljs:313`). Default
mode: whichever uploads second wins on the server; the loser's version lives in `version-files/local/`. With diff-merge: the merge keys by UUID, and since the
two pages have different UUIDs they will not deduplicate cleanly — the user is likely to see concatenated blocks or two same-named pages.

## 6. The overnight phenomenon — explained

> "Every morning when I open Logseq on my phone for the first time on a
> new day, today's journal already contains yesterday's unfinished
> TODOs. My laptop is asleep AND disconnected from the network all
> night. This happens every single time."

The plugin doesn't run on mobile (§2), so this can't be the phone doing the migration. The migration runs on the **desktop** during macOS **Power Nap /
DarkWake**.

Mechanism, verified empirically against a real machine's `pmset -g log` and journal mtimes:

1. macOS Power Nap (`pmset -g` shows `powernap = 1` and `tcpkeepalive = 1`) wakes the system from Deep Idle every 15-30 minutes for 9-60 second DarkWake windows
   for routine maintenance — DHCP renewal, Spotlight indexing, mail/iCloud, Time Machine. Wake reasons include `rtc/Maintenance`, `rtc/SleepService`, and
   `wifibt SMC.OutboxNotEmpty`.
2. Logseq Electron is kept resident in RAM and was launched with `--disable-features=MacWebContentsOcclusion`, which disables Chromium's hidden-window
   throttling. During each DarkWake the renderer thread runs JavaScript.
3. The 3 s `watch-for-date!` poll fires. `(date/today)` (`src/main/frontend/date.cljs:61-63`) reads `js/Date.` and now returns the new day's name.
4. `create-today-journal!` (`page.cljs:281-299`) sees today's page doesn't exist and creates it, firing the page-creation tx.
5. The plugin's `DB.onChanged` matches. `queryCurrentRepoRangeJournals` reads from the local DataScript DB (already populated from IndexedDB cache — independent
   of sync). Migration runs. Both yesterday's and today's markdown files are rewritten on disk during the same DarkWake window.
6. Whenever WiFi briefly comes up during a later DarkWake (`tcpkeepalive=1`) or on lid-open, sync uploads the modified files via `rsapi`. Mobile pulls them next
   time it connects.

**Empirical confirmation from a recent run:**
- `2026_05_05.md` was modified at `00:49:56 May 6` — there's a DarkWake at `00:49:48` on the same machine (8 s before the file write).
- `2026_05_06.md` modified at `01:04:11 May 7` — DarkWake at `01:04:04`.
- `2026_05_08.md` modified at `00:13:02 May 9` — same pattern.

The migration is purely a local file-write operation; it doesn't need network during DarkWake. Power Nap fires multiple times per hour with high regularity, so
within ~1 hour after midnight the migration is essentially guaranteed to have run.

### To verify on your machine

```bash
# Compare overnight-modified journal mtimes to wake events
stat -f "%Sm %N" /path/to/your/graph/journals/*.md | tail -7
pmset -g log | grep DarkWake | tail -50
```

Mtimes for migrated journal files should fall inside DarkWake windows in the early hours.

### To kill the behavior decisively

```bash
sudo pmset -a powernap 0
```

If migration stops running overnight when the lid is closed, Power Nap was the mechanism. If it keeps running, there's some other wake source worth
investigating (e.g. network-wake, scheduled wake via `pmset schedule`, an external monitor staying connected).

### Edge case: laptop genuinely off / hibernated

If the laptop is fully hibernated or powered off, the Logseq process isn't running and migration cannot fire. After wake, the next 3 s poll catches up and
migration runs at that moment. If the user reports "migration ran while laptop was off," the most likely explanations in order are:

1. The laptop was actually in Sleep, not hibernate / off — Power Nap was active.
2. "Closed" meant Cmd+W (window closed, process running), not Cmd+Q (process killed).
3. A second desktop running Logseq did the migration and synced.
4. The user is seeing the result of yesterday's migration that ran the previous evening before laptop sleep.

## 7. Sync ingestion does NOT re-fire migration

When sync delivers today's journal file to a desktop that didn't already have it, the file goes through the fs-watcher → parser path. The resulting transaction:

- Has `:from-disk? true` and `:fs/event :fs/local-file-change` in tx-meta (`file_handler.cljs:158-160`).
- Reuses the existing page entity if present (`page-name->map` short-circuits via `page-entity` when `(d/entity [:block/name page-name])` is non-nil —
  `block.cljs:305-312`).
- Even on a fresh page, `with-timestamp?` only adds `created-at`/ `updated-at` `(when (and with-timestamp? (not page-entity)))` (`block.cljs:319`). Explicit
  timestamps come from `created-at::`/`updated-at::` properties if present, not freshly-stamped equal values.

**Result**: the fs-watcher sync ingestion path **does not produce a tx with `createdAt === updatedAt && journal? === true`**. The plugin filter does not match.
**Sync delivery does not re-fire migration.**

This generalizes the rule-11 finding ("file-watcher additions don't trigger the plugin") to the sync case: sync goes through the same fs-watcher path, and the
plugin's filter is robust against it.

## 8. Multi-device duplication — the real risk

Two scenarios produce duplicate migration. Both are **desktop-vs-desktop only**; mobile is a passive participant.

### Scenario A: both desktops boot offline / before sync converges

Each desktop sees "today is empty in my local DB", each runs `create-today-journal!`, each fires the plugin, each runs migration locally. When they meet via
sync, default last-writer-wins picks one; the other lives in `version-files/local/`. With diff-merge enabled, the two pages have different UUIDs so the merge
concatenates them, giving duplicated TODOs in today.

### Scenario B: race on already-online desktops

Desktop A creates today's journal at 08:00:00; sync push starts. Before push completes, desktop B's 3 s poll fires (08:00:03). B's DB is still empty for today.
B creates its own today's journal. Both run migration. After sync converges, same outcome as Scenario A.

### Yesterday's journal also gets touched twice

Migration is destructive on the source side: it removes migrated TODOs from yesterday's journal. If both devices run migration, both modify yesterday too.
Last-writer-wins on yesterday's file means whichever device's modified yesterday lands on the server first wins; the other device's view of yesterday gets
overwritten. DONE/title content that happened to differ between the two devices' migration executions can be lost.

### Severity

- Probability is bounded: requires both desktops to be active around midnight or first-open of a new day.
- Impact when it happens: duplicated TODOs in today, potentially lost blocks in yesterday.
- **Single-desktop users are not affected.** Even if mobile is involved, mobile doesn't run the plugin, so mobile can't independently fire migration.

## 9. Implications for plugin design

We are not changing the plugin in this doc. But if/when sync-aware behavior is added, the design constraints are:

1. **Idempotent-by-design migration is the most defensible approach.** Two devices migrating the same yesterday should converge to the same today. Currently the
   plugin removes blocks from yesterday and appends to today; doing this twice produces different state because the second run sees a different yesterday. An
   idempotent design would need a marker on the data (e.g. `:migrated-from <yday-page-uuid>` on today's blocks, or an inline marker in the markdown) to detect
   "already done" and no-op.
2. **Persisted "last migrated journal-day" in `logseq.settings` is not enough by itself in a multi-device world.** Each desktop has its own settings; both can
   independently fire and both believe they "own" the migration. The marker has to live on the data (today/yesterday's content) to survive sync.
3. **Don't depend on the fs-watcher tx shape from sync to fire the listener.** Sync ingestion goes through the parser path with `:from-disk? true` and the
   page-entity short-circuit. The `create-today-journal!` shape is reliable; the parser-path shape is not.
4. **The `:today-journal-created` plugin app-hook** (`page.cljs:851`, `plugin-handler/hook-plugin-app`) is more semantically correct than tx-shape filtering —
   but it is only emitted by the in-app `create-today-journal!`, not by sync ingestion, so it inherits the same per-device-fire problem. Using it would simplify
   the trigger filter without solving the duplication risk.

## 10. What we don't know — needs empirical testing

1. **Exact tx shape on sync ingestion of a fresh today's journal authored by another device when the receiving device's DB doesn't yet have that page entity.**
   The 0.10.9 code path strongly implies the parser produces a multi-block tx with `:from-disk? true` and no fresh equal-timestamps on the page entity. But: (a)
   `preload-graph-homepage-files!` runs before the watcher, and (b) if the page entity does not yet exist in the receiving device's DB, `page-name->map` may
   produce a brand-new entity with `created-at == updated-at`. Test: device A creates today, syncs; device B with a wiped DB receives the file via sync; inspect
   the actual tx in `DB.onChanged` (add a temporary `console.log({datums: txData})` in the listener).
2. **Mobile sync pull timing relative to mobile's `watch-for-date!`.** Whether mobile typically completes its initial sync pull before its 3 s poll fires would
   determine whether mobile creates a competing today's journal. If sync usually finishes first, mobile sees today's journal already in DB after sync ingestion
   and skips `create-today-journal!`. Mobile doesn't run the plugin anyway, so this only affects whether mobile creates a duplicate-empty today-page that
   conflicts with the desktop's migrated version.
3. **Default value of `enable-sync-diff-merge?`.** Most users probably have it off (default), but the plugin's behavior under each mode for duplicated
   migrations differs.
4. **DB-graph era.** The user is on file graphs. If they migrate to a DB graph, sync becomes RTC-based (`deps/db-sync/`) and transmits datascript-level ops.
   Plugin behavior under that stack is a separate research question and almost certainly different.
5. **Whether `:today-journal-created` ever fires twice on the same device.** Per-session state, but worth confirming: does a stale poller across hibernate/sleep
   ever double-invoke?

## 11. Source references

`logseq/logseq` at tag `0.10.9`:

- `src/main/frontend/handler.cljs:50-72` — 3 s `watch-for-date!` poll
- `src/main/frontend/handler/page.cljs:281-299` — `create-today-journal!`
- `src/main/frontend/handler/page.cljs:125-178` — `create!` and the page-creation transaction
- `deps/graph-parser/src/logseq/graph_parser/block.cljs:287-326` — `page-name->map`, source of `created-at == updated-at` on page creation
- `src/main/frontend/fs/sync.cljs:735-771` — `IRSAPI` protocol
- `src/main/frontend/fs/sync.cljs:850-856, 2023-2028` — age encryption
- `src/main/frontend/fs/sync.cljs:1700-1761` — `apply-filetxns`
- `src/main/frontend/fs/sync.cljs:1735-1737` — diff-merge vs plain overwrite branch
- `src/main/frontend/fs/diff_merge.cljs:170` — `three-way-merge`
- `src/main/frontend/fs/watcher_handler.cljs:58-137` — `handle-changed!`
- `src/main/frontend/handler/file.cljs:142-196` — `alter-file`
- `src/main/frontend/handler/common/file.cljs:95-113` — `reset-file!` (calls `graph-parser/parse-file`)
- `src/main/frontend/handler/file_sync.cljs` — high-level sync orchestration
- `src/main/frontend/handler/events.cljs:368, 440, 632, 672` — call sites for `create-today-journal!` outside the poll
- `src/main/frontend/util.cljc:136-139`, `src/main/frontend/config.cljs:149-152`, `src/main/frontend/handler/plugin.cljs:1339-1344` — plugin platform gating
  (mobile is excluded)

External:

- macOS Power Nap reference: <https://support.apple.com/guide/mac-help/use-power-nap-on-your-mac-mh40773/mac>
- age (encryption library Logseq Sync uses): <https://github.com/FiloSottile/age>

## 12. Cross-references

- [`agents/gotchas.md`](../gotchas.md) — "Migration only fires on a fresh journal creation" section enumerates the trigger paths that reach the listener. Sync's
  fs-watcher ingestion path is **not** among them; this doc explains why.
- [`agents/research/2026-05-09-modernization-ai-first-and-e2e.md`](./2026-05-09-modernization-ai-first-and-e2e.md) §2.4 — the trigger filter is correct; do not
  relax it. Multi-device considerations don't change that conclusion: a relaxed filter would fire on sync-delivered journals and re-migrate on every Logseq
  startup, which is strictly worse than the current per-device duplication risk.
