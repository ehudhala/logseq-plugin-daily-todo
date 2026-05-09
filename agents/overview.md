# Overview

`logseq-plugin-daily-todo` is a Logseq plugin with two responsibilities:

1. **Daily journal migration.** When a new daily journal is created, copy
   every block group (groups separated by empty blocks) that still has
   unfinished `TODO` blocks from the previous journal into the new one.
   `DONE` blocks stay behind. Title blocks (`<ins>...</ins>`) are duplicated
   so both journals keep their headings.

2. **Keyboard shortcuts** (OneNote-style):
   - `mod+1` — toggle TODO state of selected block(s) (TODO → DONE → empty → TODO)
   - `mod+4` — toggle highlight (`^^...^^`) on selected block(s)

## Code map

Everything lives in [`src/main.ts`](../src/main.ts). It's a single file by
design — the plugin is small and the structure is roughly:

| Region | Purpose |
| --- | --- |
| Regex constants | `todoRegex`, `doneRegex`, `highlightRegex`, etc. |
| Settings | `defaultSettings`, `initSettings`, `getSettings` |
| `toggleTODO` / `toggleHighlight` | shortcut handlers |
| `updateNewJournalWithAllTODOs` | the journal-migration logic |
| `recursiveCopyBlocks` | recursive block copy with DONE/title rules |
| `main()` | registers shortcuts and the `DB.onChanged` listener |

The journal-migration listener runs through `logseq.DB.onChanged`. That
callback fires on **every** transaction, but the handler exits in a few
microseconds unless the transaction looks like a journal-creation event
(see the `isJournalCreatedEvent` check). Don't move heavy work outside that
guard.

## What &quot;don't break&quot; means

Two regression-prone areas:

- **Journal migration** is destructive (it removes blocks from the previous
  day). The before/after screenshots in the README capture the expected
  behavior. If you change `recursiveCopyBlocks` or the group-detection
  loop, eyeball test against a sample journal manually.
- **Shortcuts** are global — they fire even when Logseq is not focused on
  a block. Don't introduce paths that throw when there's no current block
  or no selection.

## Out of scope

- This plugin doesn't render any UI (no React, no toolbar buttons).
- It doesn't expose settings UI beyond what `logseq.updateSettings` provides
  by default.
- It doesn't talk to the network.
