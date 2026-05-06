# perf-test

A standalone harness that measures plugin load time the same way Logseq does:
from iframe append to Postmate `handshake-reply`. See
[`agents/perf-testing.md`](../agents/perf-testing.md) for the full background.

## Run

```bash
pnpm build
python3 -m http.server 8765
```

Then open <http://localhost:8765/perf-test/host.html> in a browser. From the
DevTools console:

```js
await runHarnessN('http://localhost:8765/dist/index.html', 'current build', 10)
```

Reports median / min / max elapsed ms across N runs and lists the resources
the iframe fetched.

## Caveats

Loopback HTTP is much faster than Logseq's `lsp://` Electron protocol handler,
so absolute numbers are not meaningful. Use this harness to compare
**configurations relatively** (e.g. split chunks vs single chunk; resource
count). For real-world measurements, install the unpacked build into Logseq
and run `__debugPluginsPerfInfo()` in Logseq's DevTools — see
`agents/logseq-plugin-loading.md`.
