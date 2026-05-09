# agents/

Documentation for coding agents (and humans) working on this repository.

These notes capture domain knowledge that isn't obvious from reading the code:
how Logseq loads plugins, how to test plugin performance, and the constraints
that should guide future changes. They were written after a deep-dive into the
Logseq plugin runtime — start here before changing anything load-sensitive.

## Contents

- [`overview.md`](./overview.md) — what this plugin does and how its pieces fit together.
- [`logseq-plugin-loading.md`](./logseq-plugin-loading.md) — how Logseq loads
  plugins, what the &quot;takes too long to load&quot; warning measures, and what
  *doesn't* count toward it.
- [`build-and-release.md`](./build-and-release.md) — Vite config rationale,
  the publish workflow, and version-bump checklist.
- [`perf-testing.md`](./perf-testing.md) — how to use the local perf harness
  and how to measure inside actual Logseq.
- [`gotchas.md`](./gotchas.md) — non-obvious behaviors that surprised us,
  preserved so the next person doesn't burn time re-discovering them.
