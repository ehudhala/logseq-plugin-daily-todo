# Perf testing

Two complementary ways to measure plugin load time. Use both — they answer
different questions.

## In-browser harness (relative comparison, no Logseq needed)

The harness in [`perf-test/host.html`](../perf-test/host.html) implements
the parent side of Postmate's handshake protocol so it can measure exactly
what Logseq measures: from iframe append to `handshake-reply` received.

```bash
pnpm build
python3 -m http.server 8765
```

Open <http://localhost:8765/perf-test/host.html> in Chrome. From the
DevTools console:

```js
// 10 cold runs of the current build
await runHarnessN('http://localhost:8765/dist/index.html', 'current', 10)

// One run with full diagnostic output
await runHarness('http://localhost:8765/dist/index.html', 'one-shot')
```

The result includes:

- `elapsedMs` — handshake-reply minus iframe-append (the metric)
- `frameLoadMs` — iframe `load` event timing
- `firstHandshakeSentMs` — when the first `handshake` was posted
- `resources` — per-resource fetch timings inside the iframe
- `resourceCount` — **the most actionable number for build changes**

### What the harness can and can't tell you

It **can** show you:
- How many resource fetches your build forces (1 vs 2 vs more)
- Whether handshake timing changes between configurations
- Whether the bundle still parses and reaches `logseq.ready()` after a build change

It **cannot** show you:
- Real Logseq performance numbers. Loopback HTTP is much faster than the
  `lsp://` Electron protocol handler. Treat absolute milliseconds as
  &quot;nothing's catastrophically broken&quot; signal only.
- Multi-plugin contention. Logseq loads plugins serially, so a slow plugin
  upstream can blow past 6s due to queueing — which the harness won't show.

### Test plan when changing the build

1. Capture a baseline:
   ```bash
   pnpm build && cp -r dist /tmp/baseline-dist
   ```
2. Make the change, rebuild.
3. Serve the parent of both folders, point the harness at each in turn,
   run `runHarnessN` 10x for each. Compare median elapsed ms and resource
   count.
4. **Always** also load both unpacked into Logseq and compare
   `__debugPluginsPerfInfo()` numbers — see below.

## In Logseq (real-world numbers)

Logseq's plugin host exposes its own perf table. Run in Logseq's DevTools
console:

```js
__debugPluginsPerfInfo()
```

That `console.table`s every plugin with its load time in ms (the same
`e - s` Logseq uses to fire the 6s warning). Also useful:

```js
// Verbose handshake/IPC logs — reload Logseq after setting this
localStorage.debug = '*'
```

### Cold-start protocol

The 6s warning is about cold starts. Reloading the plugin via the toggle in
the Plugins panel doesn't reproduce the cold-start condition.

For each variant you want to compare:

1. Quit Logseq fully.
2. Install the unpacked dist/.
3. Start Logseq, open DevTools, run `__debugPluginsPerfInfo()`.
4. Quit. Repeat 2-3 more times — Electron's disk cache warms up across
   restarts and the first cold start is always slowest.
5. Take the median across the runs.

If you're A/B-ing two builds, **swap which dist is loaded** between runs
(uninstall + install unpacked). Don't try to load both — the IDs will
collide.
