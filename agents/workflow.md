# Working in this repo

Patterns and conventions an agent (or human) should follow when making
changes here. Most of this is implicit in the existing PRs but worth
making explicit.

## The standard inner loop

For most changes:

```bash
# Iterate
pnpm test:watch          # Vitest in watch mode if you're touching src/lib.ts
pnpm test:e2e:quick      # ~17s sanity check after touching src/main.ts

# Before committing
pnpm verify              # check + lint + test + build + perf (~30s)
pnpm test:e2e            # full E2E suite (~3m30s)

# After committing
git push -u origin <branch>
gh pr create ...
```

`pnpm verify` is the canonical "did I break it" gate. If it's green
locally, the corresponding CI jobs will be green too — they run the
same commands on the same Node/pnpm versions.

## Branch naming

Used consistently across recent PRs:

- `feat/<thing>` — adds a feature or capability (e.g. `feat/e2e-coverage`)
- `fix/<thing>` — fixes a bug (e.g. `fix/rule-7-done-child-dropped`)
- `chore/<thing>` — toolchain, deps, refactors with no user-visible change
- `ci/<thing>` — workflow changes
- `docs/<thing>` — documentation only

Match the PR title's conventional-commit prefix to the branch prefix
where reasonable.

## Commit hygiene

Each commit on a feature branch should leave the build green. Multi-step
PRs (the toolchain modernization had 9 commits) are fine — but each step
runs cleanly on its own.

When a PR review surfaces a fix that belongs in an earlier commit,
amend or rebase rather than tacking on at the end. Use
`git push --force-with-lease` (not plain `--force`) so you don't
clobber concurrent pushes.

## PR descriptions

Strong PR descriptions in this repo follow a small template:

```
## Summary
<1-3 bullet points: what changed and why>

## What's NOT in this PR
<things deferred to a follow-up — name the task ID if it exists>

## Test plan
- [x] pnpm verify is green locally
- [x] pnpm test:e2e is 19/19 PASS
- [ ] Manual smoke test in Logseq with the unpacked dist
```

The "What's NOT in this PR" section is unusually valuable here because
many of the recent changes were sequenced — knowing what a PR
deliberately punts saves the reviewer asking.

## CI is split across five gates (six with E2E)

When you see a red dot on a PR, look at *which* job failed:

| Job | What it catches | When to investigate first |
|---|---|---|
| `type-check` | `tsc --noEmit` | TS errors after a SDK bump or ts version change |
| `lint` | ESLint (style + typescript-eslint recommended) | New code missed `--fix`, or a real correctness rule |
| `unit` | Vitest on `src/lib.ts` | Pure logic regressions |
| `sanity` | `pnpm build` | Build config broke |
| `performance` | resourceCount === 1 + median load time | Someone re-added bundle splitting |
| `e2e` | Logseq-driven journal migration + shortcuts | Real plugin behavior regressed |

Each runs in its own job, in parallel. Failure in one doesn't kill the
others. Concurrency group `ci-${{ workflow }}-${{ ref }}` cancels
in-progress runs when a PR is force-pushed.

The first five (Linux) take ~30s combined. E2E (macOS, runs Logseq.app)
takes ~5 min. They share `pnpm install --frozen-lockfile` time.

## Mass-formatting with eslint --fix

When you do a refactor or migrate ESLint rules, run:

```bash
pnpm lint --fix
```

This auto-fixes mechanical issues across `src/`, `scripts/`, `e2e/`.
Review the diff before committing — fixes are usually pure formatting
but occasionally suggest deletions (unused vars).

## What to read for what

| If you're... | Start here |
|---|---|
| Onboarding | [`AGENTS.md`](../AGENTS.md), then [`overview.md`](./overview.md) |
| Touching `src/main.ts` | [`overview.md`](./overview.md), [`gotchas.md`](./gotchas.md) |
| Touching the bundle/build | [`logseq-plugin-loading.md`](./logseq-plugin-loading.md), [`gotchas.md`](./gotchas.md) |
| Adding/modifying tests | [`testing.md`](./testing.md) |
| Cutting a release | [`build-and-release.md`](./build-and-release.md) |
| Investigating a past decision | [`research/`](./research/) |

## Out-of-scope deliberately

- **No UI**. The plugin doesn't render anything; don't add a settings panel.
- **No network calls**. The plugin is offline-only.
- **No DB-graph mode** support. The plugin runs against file-based graphs;
  DB-graph behavior isn't tested. See research §2 for what would change.
- **No CHANGELOG**. Releases use git history + the PR-description style above.
