# agents/research

Dated investigation logs, one file per topic, named
`YYYY-MM-DD-topic.md`.

## What goes here

- Multi-page investigations with sources and reasoning
- Reports of options considered with the chosen path explained
- Anything you want a future agent (or future-you) to find when asking
  "how did we figure this out and what else did we consider"

## What does NOT go here

- "How does this work today" — that's `agents/<topic>.md`. Topic guides
  describe current state; research describes how we arrived at it.
- "Don't do X" — that's `agents/gotchas.md`.
- In-flight task tracking — that's `agents/STATUS.md` if needed (and
  it gets deleted when the work lands).

## Index

| Date | Topic |
|---|---|
| 2026-05-09 | [Plugin loading, modernization, testing, and AI-first conventions](./2026-05-09-modernization-ai-first-and-e2e.md) |
| 2026-05-10 | [Logseq Sync — implications for the plugin](./2026-05-10-logseq-sync-implications.md) |

## Conventions

- Filenames: `YYYY-MM-DD-topic.md`. Dates are in UTC (ISO format) so
  they sort correctly.
- Every doc starts with YAML frontmatter (`topic`, `date`, `status`,
  `tags`, `summary`).
- Research docs are append-mostly. When findings change, write a new
  doc and replace the old one — keeping a paper trail beats letting
  notes drift.
