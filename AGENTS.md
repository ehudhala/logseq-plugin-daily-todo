# AGENTS.md — front door for coding agents

> Read this first. It's deliberately short. Pointers below take you to
> the document you actually need.

## What this repo is

`logseq-plugin-daily-todo` is a small (~300 LOC) Logseq plugin written
in TypeScript with Vite. It does two things:

1. Migrates unfinished `TODO` blocks from yesterday's journal into
   today's journal when Logseq creates today.
2. Adds two keyboard shortcuts: `mod+1` toggles TODO state on selected
   blocks; `mod+4` toggles `^^highlight^^`.

No UI, no network, no React. All logic lives in `src/main.ts`. The
[`agents/overview.md`](./agents/overview.md) doc has the code map.

## Where to look first

| What you're doing | Read this first |
|---|---|
| Touching `src/main.ts` for the first time | [`agents/overview.md`](./agents/overview.md) |
| Running tests / writing tests | [`agents/testing.md`](./agents/testing.md) |
| Anything that affects bundle/build/load time | [`agents/logseq-plugin-loading.md`](./agents/logseq-plugin-loading.md) and [`agents/perf-testing.md`](./agents/perf-testing.md) |
| Cutting a release | [`agents/build-and-release.md`](./agents/build-and-release.md) |
| Debugging something weird | [`agents/gotchas.md`](./agents/gotchas.md) |
| Understanding a past decision | [`agents/research/`](./agents/research/) — dated investigation logs |
| Anything else | [`agents/README.md`](./agents/README.md) is the topic index |

## How to verify a change

The canonical agent gate (no Logseq needed, ~30s):

```bash
pnpm verify          # check + lint + test + build + perf
```

Inner-loop iteration on pure logic:

```bash
pnpm test            # Vitest unit tests (<1s)
pnpm test:watch      # auto-rerun on save
```

End-to-end against real Logseq (macOS only, requires
`/Applications/Logseq.app`):

```bash
pnpm test:e2e:quick  # one mega-migration sanity case (~17s)
pnpm test:e2e        # full E2E suite (~3m30s, before opening a PR)
```

Full details in [`agents/testing.md`](./agents/testing.md).

## Constraints worth knowing up front

- **Never re-introduce `manualChunks` for `@logseq/libs`.** It looks
  like a vendor-cache optimization but isn't; explanation in
  [`agents/gotchas.md`](./agents/gotchas.md).

## What's out of scope

- UI. There isn't any and we aren't adding one.
- Network calls. The plugin doesn't make any.
- A custom settings UI beyond `logseq.updateSettings` defaults.
- DB-graph mode. Not currently tested. See research doc §2 for what
  would need to change.
