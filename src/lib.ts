// Pure helpers extracted from main.ts. Exported for unit tests.
//
// These functions operate on minimal block-shape interfaces so they
// don't depend on @logseq/libs at runtime — pass any object with the
// right shape and they work. main.ts uses them with full BlockEntity
// instances at runtime.

// TODO-like prefixes — Logseq supports two workflows:
//   "todo" workflow: TODO / DOING / DONE
//   "now"  workflow: LATER / NOW / DONE
// We recognize all four TODO-like prefixes (TODO/DOING/NOW/LATER) so
// the plugin works with mixed content regardless of which workflow the
// user has selected. Only the blank → first-state transition depends
// on the workflow; everything else (any TODO-like → DONE → blank) is
// the same across workflows.
export const todoRegex = /^(TODO|DOING|NOW|LATER)\s+/;
export const doneRegex = /^(DONE)\s+/;
export const todoDoneRegex = /^(TODO|DOING|NOW|LATER|DONE)\s+/;
export const isUnderlineRegex = /<ins>.*<\/ins>/;
export const highlightRegex = /^(TODO\s+|DOING\s+|NOW\s+|LATER\s+|DONE\s+|\s*)\^\^(.*)\^\^/;

// Logseq's two task workflows. The string values match what
// `logseq.App.getUserConfigs().preferredWorkflow` returns.
export type PreferredWorkflow = 'todo' | 'now';

// Cycle TODO state. Any TODO-like prefix (TODO/DOING/NOW/LATER) maps
// to DONE — the workflow only determines the blank → first-state
// transition (TODO in "todo" mode, LATER in "now" mode). This means a
// TODO block in a now-mode user's graph still cycles cleanly to DONE
// instead of getting stuck.
export const getNextTodoState = (
  todoState: string,
  preferredWorkflow: PreferredWorkflow = 'todo',
): string => {
  if (todoState === 'DONE') return '';
  if (todoState === '') return preferredWorkflow === 'now' ? 'LATER ' : 'TODO ';
  // Any recognized TODO-like prefix advances to DONE.
  if (todoState === 'TODO' || todoState === 'DOING'
      || todoState === 'NOW' || todoState === 'LATER') {
    return 'DONE ';
  }
  // Unknown state — leave it alone (mapping to '' would silently strip
  // a prefix the user added manually).
  return '';
};

// A minimal block shape that matches both legacy and modern
// @logseq/libs BlockEntity. Loose typing on `title` and `children` is
// intentional: in 0.0.9 `title` is `Array<any>` (legacy AST) and in
// >= 0.0.17 it's `string`; `children` in BlockEntity is
// `Array<BlockEntity | BlockUUIDTuple>`, so a strict `MinimalBlock[]`
// would refuse to accept it. The helpers here only touch the fields
// they need and gracefully tolerate extras, so main.ts can pass full
// BlockEntity instances through without casts.
export interface MinimalBlock {
  content?: string;
  title?: unknown;
  children?: ReadonlyArray<MinimalBlock | unknown>;
}

// Read a block's text content. In @logseq/libs >= 0.0.17 `block.content`
// is @deprecated and `block.title` is canonical (as a string); in 0.0.9
// `block.title` was `Array<any>` (legacy AST) and `block.content` held
// the text. Use this everywhere instead of reading `.content` directly
// so the plugin works across SDK versions.
export const blockContent = (block: MinimalBlock | undefined | null): string => {
  if (!block) return '';
  // Only treat .title as the source of truth when it's actually a string.
  // The legacy 0.0.9 Array<any> shape falls through to .content.
  if (typeof block.title === 'string') return block.title;
  return block.content ?? '';
};

export const isHighlighted = (block: MinimalBlock | undefined | null): boolean => {
  return highlightRegex.test(blockContent(block));
};

export const extractTodoState = (block: MinimalBlock | undefined | null): string => {
  const match = todoDoneRegex.exec(blockContent(block));
  return match !== null && match.length > 0 ? match[1] : '';
};

// Recursively check if any block in the subtree matches a regex. Children
// elements that aren't block-shaped (e.g. SDK BlockUUIDTuple — `[uuid, ...]`)
// are skipped — they don't carry content this helper can inspect.
export function recursivelyCheckForRegexInBlock(
  block: MinimalBlock,
  regex: RegExp,
): boolean {
  if (regex.test(blockContent(block))) return true;
  return (block.children ?? []).some(child => {
    if (typeof child !== 'object' || child === null || Array.isArray(child)) return false;
    return recursivelyCheckForRegexInBlock(child as MinimalBlock, regex);
  });
}

// Split a flat list of blocks into groups separated by empty blocks.
// Used by the journal-migration logic to identify "groups" of related
// blocks that migrate together. An empty block at the head of the list
// produces a leading empty group; consecutive empty blocks produce
// consecutive empty groups.
export function splitBlocksIntoGroups<B extends MinimalBlock>(blocks: B[]): B[][] {
  const groups: B[][] = [[]];
  for (const block of blocks) {
    if (blockContent(block) !== '') {
      groups[groups.length - 1].push(block);
    } else {
      groups.push([]);
    }
  }
  return groups;
}
