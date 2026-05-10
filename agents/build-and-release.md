# Build and release

## Local build

```bash
pnpm install
pnpm build
```

Output lands in `dist/` and is what Logseq actually loads. The `build`
script also copies `README.md`, `LICENSE`, `icon.png`, and `package.json`
into `dist/` because the Marketplace zip is built from the `dist/` folder.

## Vite config

[`vite.config.ts`](../vite.config.ts) uses
`output.inlineDynamicImports: true`. **Don't switch this back to
`manualChunks`** — see [`logseq-plugin-loading.md`](./logseq-plugin-loading.md)
for why. The TL;DR: every chained ES-module fetch in the plugin's iframe
goes through Logseq's `lsp://` protocol handler (an Electron IPC roundtrip),
and bundle splitting buys nothing in this context because plugin assets
aren't shared across plugins.

## Loading the local build into Logseq for testing

1. Settings → Advanced → Developer mode → restart Logseq.
2. 3-dot menu → Plugins.
3. If the Marketplace version is installed, **uninstall it first** so it
   doesn't fight the unpacked one for the same shortcuts.
4. Click `Load unpacked plugin` → select this repo's `dist/` folder.
5. Restart Logseq to test the cold-start path that the 6s warning measures.
6. In Logseq's DevTools console, run `__debugPluginsPerfInfo()` to see
   each plugin's load time in ms.

When you load unpacked, Logseq writes `&quot;id&quot;: &quot;<random>&quot;` into the
unpacked `dist/package.json` to give your build a unique plugin ID. **Don't
copy that back into the source `package.json`** — it should only exist in
the unpacked install. The build script regenerates `dist/package.json` from
source on every `pnpm build`, so this isn't sticky.

## Publishing a new version

The release flow is automated via
[`.github/workflows/publish.yml`](../.github/workflows/publish.yml).
**The pushed tag is the source of truth for the version.** The workflow:

1. Reads the tag (e.g. `0.0.9`) and rewrites `package.json` to match.
2. Runs `pnpm install --frozen-lockfile && pnpm build` so
   `dist/package.json` carries the tag's version.
3. Packages `dist/` as zip + tar.gz.
4. Creates a GitHub release attached to the tag with both archives
   uploaded via `softprops/action-gh-release`.
5. **Commits the `package.json` version bump back to `master`** with
   `[skip ci]` so the source tracks the released version. Runs last,
   after a successful release, so a failed build doesn't leave master
   with a phantom bump.

The Logseq Marketplace registry watches for new releases and indexes
them within an hour or so.

### Cutting a release

1. Make sure master is in the state you want to release.
2. `git tag <version>` (no `v` prefix — match the existing pattern,
   e.g. `0.0.9`).
3. `git push origin <version>`.
4. Watch the Action on GitHub. On success: the release page has the
   zip and tar.gz, and master gains a `chore: bump version to X.Y.Z`
   commit from `github-actions[bot]`.

That's it. **You do not bump `package.json` manually.** The workflow
makes the tag and `package.json` agree by construction, so the
0.0.7-style drift (tag was 0.0.7, `package.json` said 0.0.6 for over
a year) cannot recur.

### Don't

- **Don't manually edit `package.json`'s `version` field.** Let the
  workflow handle it; otherwise master and the next tag may diverge.
- **Don't amend or force-push tags** that have already been published
  as releases. Cut a new patch version instead.
- **Don't commit `dist/`.** It's gitignored and rebuilt by CI from the
  tag.

### When master and the tag would have raced

The workflow handles the (rare) case where master moves between when
the action checks out the tag and when it tries to commit the bump
back: it does `git fetch origin master && git checkout master` before
the bump-and-push and re-applies the version edit. If master was bumped
to the same version by another action concurrently, the diff is empty
and no commit is created. Worst case is a benign no-op.
