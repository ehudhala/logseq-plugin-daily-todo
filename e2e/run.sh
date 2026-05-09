#!/usr/bin/env bash
# Driver for the Logseq E2E suite.
#
# Steps:
#  1. Build the plugin if dist/ is stale
#  2. Hard-link-clone /Applications/Logseq.app -> /tmp/LogseqPatched.app
#  3. Patch electron.js to honour LOGSEQ_FAKE_HOME (bypasses macOS
#     HOME-vs-getpwuid issue — see agents/research/...e2e.md §4.2)
#  4. Run the test suite
#
# Constraint: never writes to ~/.logseq. The patched binary lives in /tmp,
# Logseq's dotdir lives in $TMP_HOME/.logseq, userData lives in $TMP_HOME/userData.

set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC_APP="/Applications/Logseq.app"
TMP_APP="/tmp/LogseqPatched.app"
PATCH_MARKER="$TMP_APP/Contents/Resources/app/.e2e-patched"

cd "$ROOT"

if [[ ! -x "$SRC_APP/Contents/MacOS/Logseq" ]]; then
  echo "ERROR: $SRC_APP not found. Install Logseq.app first."; exit 1
fi

# Build the plugin if dist is older than src
if [[ ! -f "$ROOT/dist/index.html" || "$ROOT/src/main.ts" -nt "$ROOT/dist/index.html" ]]; then
  echo "[run.sh] Building plugin..."
  pnpm build
fi

# Hard-link-clone Logseq.app to /tmp once. Re-clone if upstream changed.
SRC_VER="$(cat "$SRC_APP/Contents/Resources/app/VERSION" 2>/dev/null || echo unknown)"
TMP_VER="$(cat "$TMP_APP/Contents/Resources/app/VERSION" 2>/dev/null || echo none)"
if [[ "$SRC_VER" != "$TMP_VER" ]]; then
  echo "[run.sh] Cloning Logseq.app to $TMP_APP (src=$SRC_VER tmp=$TMP_VER) ..."
  rm -rf "$TMP_APP"
  mkdir -p "$TMP_APP"
  ( cd "$SRC_APP" && pax -rwl . "$TMP_APP" )
fi

# Patch electron.js (idempotent — keyed by $PATCH_MARKER)
if [[ ! -f "$PATCH_MARKER" ]]; then
  echo "[run.sh] Patching electron.js to honor LOGSEQ_FAKE_HOME..."
  EJS="$TMP_APP/Contents/Resources/app/electron.js"
  # Break the hardlink first so we don't mutate /Applications/Logseq.app
  cp "$EJS" "$EJS.tmp" && rm "$EJS" && mv "$EJS.tmp" "$EJS"
  node -e '
    const fs = require("fs");
    const p = process.argv[1];
    let s = fs.readFileSync(p, "utf8");
    let n = 0;
    const subs = [
      [`$shadow$js$shim$module$0electron$$.app.getPath("home")`,
       `(process.env.LOGSEQ_FAKE_HOME || $shadow$js$shim$module$0electron$$.app.getPath("home"))`],
      [`$shadow$js$shim$module$0os$$.homedir()`,
       `(process.env.LOGSEQ_FAKE_HOME || $shadow$js$shim$module$0os$$.homedir())`],
    ];
    for (const [find, repl] of subs) {
      while (s.includes(find)) { s = s.replace(find, repl); n++; }
    }
    fs.writeFileSync(p, s);
    console.log("[run.sh] patched", n, "occurrences");
  ' "$EJS"
  touch "$PATCH_MARKER"
fi

echo "[run.sh] Running e2e/runner.mjs $* ..."
node "$ROOT/e2e/runner.mjs" "$@"
