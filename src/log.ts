// Namespaced logging gated on `localStorage.debug`. Production is silent
// by default. To turn on diagnostic logs in any user's Logseq DevTools:
//
//   localStorage.debug = 'daily-todo'  // just this plugin's logs
//   localStorage.debug = '*'           // everything (Logseq + plugins)
//
// Then reload Logseq. The convention matches what `@logseq/libs` itself
// uses (the `debug` npm package), so users who already debug Logseq with
// `localStorage.debug = '*'` will see our logs too, namespaced.
//
// `error` is always emitted — actual errors should never be silenced.

const NAMESPACE = 'daily-todo';
const PREFIX = `[${NAMESPACE}]`;

const isDebugEnabled = (): boolean => {
  try {
    const flag = typeof localStorage !== 'undefined' ? localStorage.debug : null;
    if (!flag) return false;
    // Match either an exact namespace mention or a wildcard.
    // Comma- and space-separated namespace lists are the convention.
    return flag.split(/[\s,]+/).some(
      (p: string) => p === '*' || p === NAMESPACE,
    );
  } catch {
    return false;
  }
};

export const log = (...args: unknown[]): void => {
  if (isDebugEnabled()) console.log(PREFIX, ...args);
};

export const error = (...args: unknown[]): void => {
  console.error(PREFIX, ...args);
};
