# agents/

Documentation for coding agents (and humans) working on this repository.
The root [`AGENTS.md`](../AGENTS.md) is the front door — start there if
you haven't.

These notes capture domain knowledge that isn't obvious from reading
the code: how Logseq loads plugins, how to test plugin performance,
and the constraints that should guide future changes.

## Topic guides — "how does this work today"

- [`overview.md`](./overview.md) — what this plugin does and how its
  pieces fit together.
- [`logseq-plugin-loading.md`](./logseq-plugin-loading.md) — how
  Logseq loads plugins, what the &quot;takes too long to load&quot; warning
  measures, and what *doesn't* count toward it.
- [`build-and-release.md`](./build-and-release.md) — Vite config
  rationale, the publish workflow, and version-bump checklist.
- [`perf-testing.md`](./perf-testing.md) — how to use the local perf
  harness and how to measure inside actual Logseq.
- [`gotchas.md`](./gotchas.md) — non-obvious behaviors that surprised
  us, preserved so the next person doesn't burn time re-discovering
  them.

## Research log — "how did we figure this out"

[`research/`](./research/) holds dated investigation logs, one file
per topic. See [`research/README.md`](./research/README.md) for the
convention. The active research doc is
[`2026-05-09-modernization-ai-first-and-e2e.md`](./research/2026-05-09-modernization-ai-first-and-e2e.md);
it covers what's shipped, what's queued, and the technical layer of
the headless E2E PoC.
