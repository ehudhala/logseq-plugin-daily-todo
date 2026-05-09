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
[`.github/workflows/publish.yml`](../.github/workflows/publish.yml). It
fires on **any tag push** matching `*` and:

1. Runs `pnpm install && pnpm build`
2. Renames `dist/` to `logseq-plugin-daily-todo/`
3. Zips and tars it
4. Creates a GitHub release attached to the pushed tag
5. Uploads the zip and tar.gz as release assets

The Logseq Marketplace registry watches for new releases and indexes them.

### Version bump checklist

1. Edit `package.json` → bump `&quot;version&quot;`. Always bump it. Skipping this
   step is how 0.0.7 ended up with a tag but a `package.json` that still
   said `&quot;0.0.6&quot;` — the Marketplace card and the unpacked card showed
   different versions for over a year.
2. Run `pnpm build` and confirm `dist/package.json` has the new version.
3. Optionally smoke-test in Logseq with the unpacked build.
4. Commit and push to master.
5. `git tag <version>` (no `v` prefix — match the existing pattern) and
   `git push origin <version>`. Pushing the tag fires the workflow.
6. Watch the Action complete on GitHub. Confirm the release exists with
   the zip and tar.gz attached.
7. Marketplace pickup is asynchronous — usually within an hour.

### Don't

- **Don't push a tag without bumping `package.json`** (see 0.0.7 incident).
- **Don't amend or force-push tags** that have already been published as
  releases. Cut a new patch version instead.
- **Don't commit `dist/`.** It's gitignored and rebuilt by CI from the
  tag.
- **Don't skip the workflow with `[skip ci]`** on a tag push — the
  workflow *is* the release.
