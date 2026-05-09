# How Logseq loads plugins

Reference for any change that affects load time, the `@logseq/libs` SDK,
or the build's chunk structure. Source links are to the `logseq/logseq`
repo on GitHub master.

## The 6-second warning

When you see this message in Logseq:

> This plugin takes too long to load, affecting the application startup
> time and potentially causing other plugins to fail to load.

…it's emitted from
[`src/main/frontend/handler/plugin.cljs:1276`](https://github.com/logseq/logseq/blob/master/src/main/frontend/handler/plugin.cljs#L1276).
On the `LSPluginCore` `'ready'` event, Logseq iterates a `perfTable` and
fires the tip for any plugin where `(end - start) > 6000` ms.

The interval is captured in
[`libs/src/LSPlugin.core.ts:1504-1509`](https://github.com/logseq/logseq/blob/master/libs/src/LSPlugin.core.ts#L1504):

```ts
const perfInfo = { o: pluginLocal, s: performance.now(), e: 0 }
perfTable.set(url, perfInfo)
await pluginLocal.load({ indicator: readyIndicator })
perfInfo.e = performance.now()
```

So **the metric is from iframe append to Postmate handshake completion** —
specifically, the moment `pluginLocal.load()` resolves, which is when the
parent has received `handshake-reply` from the plugin's iframe.

Plugins are loaded **serially** in a `for ... of` loop. A slow plugin blocks
every plugin queued behind it, which is why the warning text mentions
&quot;potentially causing other plugins to fail to load&quot;.

## What does NOT count toward the metric

The `s`/`e` timestamps are taken on the host side. By the time Logseq stops
the timer, the plugin has only:

- loaded its iframe HTML
- downloaded and parsed all `<script>` and statically imported chunks
- created `window.logseq` (a side effect of `import '@logseq/libs'`)
- called `logseq.ready(...)`, which triggers Postmate's `sendHandshakeReply`

Everything that happens *inside* the `ready()` callback runs **after** `e`
is captured. That means:

- `App.registerCommandPalette` calls — don't count
- `DB.onChanged` registration — doesn't count, and its callback only fires
  on future transactions, never on past state
- `datascriptQuery` calls — don't count
- `getPageBlocksTree` — doesn't count
- `logseq.updateSettings` from `initSettings` — doesn't count

If you see the warning, the fix is somewhere in the path from
&quot;iframe-append&quot; to &quot;handshake-reply-sent&quot;. Don't chase the work inside
`main()`.

## What DOES count

- **iframe HTML fetch** through Logseq's `lsp://` Electron protocol handler
  (registered in
  [`src/electron/electron/core.cljs`](https://github.com/logseq/logseq/blob/master/src/electron/electron/core.cljs)).
  Each fetch is a main-process IPC roundtrip.
- **Each chained ES module import** in your bundle is another `lsp://` fetch.
  A bundle that does `import './logseq.xxx.js'` from its entry forces a second
  serial roundtrip before `logseq.ready()` can fire.
- **Bundle parse + execute time** in the iframe.
- **Postmate handshake roundtrip.** Parent posts `handshake` every 500ms
  after iframe `load`; child replies with `handshake-reply` from inside
  `logseq.ready()`. Hard timeout: 8s
  ([`libs/src/LSPlugin.caller.ts:296`](https://github.com/logseq/logseq/blob/master/libs/src/LSPlugin.caller.ts#L296)).
- **IPC calls before iframe creation** (read `package.json`, load settings,
  optionally write a tmp `index.html` wrapper if the entry is a `.js` file —
  see `_tryToNormalizeEntry` in `LSPlugin.core.ts:745-798`).

## Iframe entry normalization

Logseq's loader injects `<script src=&quot;.../lsplugin.user.js&quot;>` into a
generated wrapper HTML **only when `package.json` `main` ends in `.js`**.
This plugin's `main` is `index.html`, so the loader uses our HTML untouched
and we provide `@logseq/libs` ourselves by bundling it. Don't switch the
entry to a JS file expecting the SDK to be auto-injected — re-test the load
path if you do.

## Useful runtime introspection (in Logseq's DevTools console)

- `__debugPluginsPerfInfo()` — `console.table` of every plugin and its load
  time in ms
  ([`LSPlugin.core.ts:1424-1449`](https://github.com/logseq/logseq/blob/master/libs/src/LSPlugin.core.ts#L1424)).
- `localStorage.debug = '*'` then restart — Postmate and lsplugin emit timed
  debug logs (handshake events, `load:done in Xms`, etc.).

## How this plugin's load timing was fixed in 0.0.8

Old build used `manualChunks: { logseq: ['@logseq/libs'] }`, producing
`index.js` (5KB) that statically imported `logseq.js` (73KB). Each `lsp://`
fetch is an Electron IPC roundtrip, so the iframe paid that cost twice
before reaching `logseq.ready()`. On a slow Mac with many plugins competing
for the IPC channel, that doubling can push past 6s.

0.0.8 sets `inlineDynamicImports: true`, producing one ~78KB chunk. Same
gzip size, same code, half the per-startup roundtrips.

For deeper context on what to test and how, see
[`perf-testing.md`](./perf-testing.md).
