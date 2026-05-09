// Pure helpers extracted from main.ts. Exported for unit tests.
//
// These functions operate on minimal block-shape interfaces so they
// don't depend on @logseq/libs at runtime — pass any object with the
// right shape and they work. main.ts uses them with full BlockEntity
// instances at runtime.

export const todoRegex = /^(TODO)\s+/;
export const doneRegex = /^(DONE)\s+/;
export const todoDoneRegex = /^(TODO|DONE)\s+/;
export const isUnderlineRegex = /<ins>.*<\/ins>/;
export const highlightRegex = /^(TODO\s+|DONE\s+|\s*)\^\^(.*)\^\^/;

// Cycle TODO state: '' → 'TODO ' → 'DONE ' → ''.
export const getNextTodoState = (todoState: string): string => {
  return ({
    'TODO': 'DONE ',
    'DONE': '',
    '': 'TODO ',
  } as Record<string, string>)[todoState] ?? '';
};

// A minimal block shape that matches both legacy (`content`) and
// modern (`title`) @logseq/libs BlockEntity. The helpers here only
// touch the fields they need, so the lib stays free of SDK-version
// concerns and main.ts can pass full BlockEntity instances through.
export interface MinimalBlock {
  content?: string;
  title?: string;
  children?: MinimalBlock[];
}

// Read a block's text content. In @logseq/libs >= 0.0.17 `block.content`
// is @deprecated and `block.title` is canonical; both fields can be present
// at runtime depending on Logseq version. Use this everywhere instead of
// reading .content directly so the plugin works across SDK versions.
export const blockContent = (block: MinimalBlock | undefined | null): string => {
  if (!block) return '';
  return block.title ?? block.content ?? '';
};

export const isHighlighted = (block: MinimalBlock): boolean => {
  return highlightRegex.test(blockContent(block));
};

export const extractTodoState = (block: MinimalBlock): string => {
  const match = todoDoneRegex.exec(blockContent(block));
  return match !== null && match.length > 0 ? match[1] : '';
};

// Recursively check if any block in the subtree matches a regex.
export function recursivelyCheckForRegexInBlock(
  block: MinimalBlock,
  regex: RegExp,
): boolean {
  if (regex.test(blockContent(block))) return true;
  return (block.children ?? []).some(child =>
    recursivelyCheckForRegexInBlock(child, regex),
  );
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
