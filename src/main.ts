import '@logseq/libs';

import { BlockEntity, IDatom } from '@logseq/libs/dist/LSPlugin';

// Result shape of queryCurrentRepoRangeJournals — a journal-page entity
// pulled out of datascript. Bracket-keyed because Logseq's pull syntax
// returns kebab-cased attribute names, not camelCase.
type JournalPage = {
  name: string;
  'journal-day': number;
  [key: string]: unknown;
};

import {
  blockContent,
  doneRegex,
  extractTodoState,
  getNextTodoState,
  highlightRegex,
  isHighlighted,
  isUnderlineRegex,
  PreferredWorkflow,
  recursivelyCheckForRegexInBlock,
  splitBlocksIntoGroups,
  todoDoneRegex,
  todoRegex,
} from './lib';

import { log, error } from './log';

// Find the block immediately before `block` among its siblings. The legacy
// API was `block.left.id`, but `BlockEntity.left` was removed in newer
// @logseq/libs versions in favor of `parent` + `order`. We resolve siblings
// via the parent (a block or a page) and return the one before — works
// across SDK versions.
async function getLeftSibling(block: BlockEntity): Promise<BlockEntity | null> {
  const parent: any = (block as any).parent;
  const parentId = parent?.id ?? parent;
  if (parentId === undefined || parentId === null) return null;

  // Try parent as a block first.
  let siblings: BlockEntity[] | undefined;
  const parentBlock = await logseq.Editor.getBlock(parentId, { includeChildren: true });
  if (parentBlock?.children?.length) {
    siblings = parentBlock.children as BlockEntity[];
  } else {
    // Parent is the page (top-level block). Use getPageBlocksTree.
    const pageObj = await logseq.Editor.getPage(parentId);
    if (pageObj) {
      siblings = await logseq.Editor.getPageBlocksTree(pageObj.name);
    }
  }

  if (!siblings) return null;
  const idx = siblings.findIndex(s => s.uuid === block.uuid);
  if (idx <= 0) return null;
  // Re-fetch the previous sibling with includeChildren so the caller can
  // check whether it's a leaf empty separator.
  return await logseq.Editor.getBlock(siblings[idx - 1].uuid, { includeChildren: true });
}

const settingsVersion = 'v1';
export const defaultSettings = {
  keyBindings: {
    'TODO': 'mod+1',
    'HIGHLIGHT': 'mod+4',
  },
  settingsVersion,
  disabled: false,
};

export type DefaultSettingsType = typeof defaultSettings;

const initSettings = () => {
  let settings = logseq.settings;

  const shouldUpdateSettings =
    !settings || settings.settingsVersion != defaultSettings.settingsVersion;

  if (shouldUpdateSettings) {
    settings = defaultSettings;
    logseq.updateSettings(settings);
  }
};

const getSettings = (
  key: string | undefined,
  defaultValue: any = undefined
) => {
  const settings = logseq.settings;
  const merged = Object.assign(defaultSettings, settings);
  return key ? (merged[key] ? merged[key] : defaultValue) : merged;
};

async function toggleHighlight() {
  // sorry for the copy-paste maybe I'll fix you later
  const selected = await logseq.Editor.getSelectedBlocks();
  const blocks = (selected && selected.length > 1) ? selected : [await logseq.Editor.getCurrentBlock()];
  const blocksInDifferentStates = (blocks.length > 0 && blocks.some(block => isHighlighted(block) != isHighlighted(blocks[0])));
  for (const block of blocks) {
    if (block?.uuid) {
      if (isHighlighted(block)) {
        const match = highlightRegex.exec(blockContent(block));
        if (!match) continue; // isHighlighted said true; defensive only.
        const [, todoState, strippedContent] = match;
        await logseq.Editor.updateBlock(block.uuid, todoState + strippedContent);
      } else {
        let todoPrefix = extractTodoState(block);
        todoPrefix = todoPrefix !== '' ? todoPrefix + ' ' : todoPrefix;
        const content = blockContent(block);
        await logseq.Editor.updateBlock(block.uuid,
          blocksInDifferentStates // we want to just update all blocks to be un-highlighted
            ? content
            : todoPrefix + '^^' + content.replace(todoDoneRegex, '') + '^^');
      }
    }
  }
}

// Read Logseq's user-level workflow preference. Logseq's setting is
// Settings → Editor → "Preferred workflow", with values 'todo' or 'now'.
// We re-read on every toggle so the user doesn't have to reload the
// plugin after changing it. getUserConfigs() is cheap (a postmessage
// roundtrip) and a manual cmd+1 press is rare, so this isn't hot-path.
async function readPreferredWorkflow(): Promise<PreferredWorkflow> {
  const cfg = await logseq.App.getUserConfigs() as { preferredWorkflow?: string };
  return cfg?.preferredWorkflow === 'now' ? 'now' : 'todo';
}

async function toggleTODO() {
  const preferredWorkflow = await readPreferredWorkflow();
  const selected = await logseq.Editor.getSelectedBlocks();
  const blocks = (selected && selected.length > 1) ? selected : [await logseq.Editor.getCurrentBlock()];
  const blocksInDifferentStates = (blocks.length > 0 && blocks.some(block => extractTodoState(block) != extractTodoState(blocks[0])));
  for (const block of blocks) {
    if (block?.uuid) {
      const todoState = blocksInDifferentStates ? 'DONE' : extractTodoState(block); // If blocks are in different states we "clear" them.
      const content = blockContent(block);
      const strippedContent = todoDoneRegex.test(content)
        ? content.replace(todoDoneRegex, '')
        : content;
      await logseq.Editor.updateBlock(
        block.uuid,
        getNextTodoState(todoState, preferredWorkflow) + strippedContent
      );
    }
  }
}

// const updateNewJournalWithAllTODOs = ({path, template}) => {
//   // This hook is actually called on every route change, fortunately a route change happens when creating a new journal.
//   console.log(path, template);
//   debugger;
// };

async function queryCurrentRepoRangeJournals(untilDate: number): Promise<JournalPage[] | undefined> {
  try {
    const journals = await logseq.DB.datascriptQuery(`
      [:find (pull ?p [*])
       :where
       [?b :block/page ?p]
       [?p :block/journal? true]
       [?p :block/journal-day ?d]
       [(< ?d ${untilDate})]
      ]
    `);
    return (journals || []).flat();
  } catch (e) {
    error(e);
  }
}


type OnChangedPayload = {
  blocks: Array<BlockEntity>;
  txData: Array<IDatom>;
  txMeta?: { outlinerOp: string; [key: string]: unknown };
};

async function updateNewJournalWithAllTODOs({ blocks, txData }: OnChangedPayload) {
  // This hook is actually called on every block update so checking if the block update is a journal creation transatcion should be fast.
  let updatedAt = null;
  let createdAt = null;
  let isJournal = false;
  for (const datum of txData) {
    // datum structure https://tonsky.me/blog/datascript-internals/
    if ((datum[1] === 'updatedAt' || datum[1] === 'block/updated-at') && datum[4] === true) {
      updatedAt = datum[2];
    }
    if ((datum[1] === 'createdAt' || datum[1] === 'block/created-at') && datum[4] === true) {
      createdAt = datum[2];
    }
    if ((datum[1] === 'journal?' || datum[1] === 'block/journal?') && datum[4] === true) {
      isJournal = datum[2];
    }
  }
  const isJournalCreatedEvent = updatedAt !== null && updatedAt === createdAt && isJournal;
  if (!isJournalCreatedEvent) {
    return;
  }

  // The "block" representing the new journal is conceptually a PageEntity —
  // journal? and journalDay live on PageEntity in modern @logseq/libs (they
  // were on BlockEntity in 0.0.x). Bracket access keeps this working across
  // versions without depending on the static type.
  type JournalPageBlock = BlockEntity & {
    name: string;
    'journal?'?: boolean;
    journalDay?: number;
  };
  const newJournalBlock = blocks.find(
    (block: BlockEntity): block is JournalPageBlock =>
      Object.prototype.hasOwnProperty.call(block, 'createdAt') &&
      (block as JournalPageBlock)['journal?'] === true
  );
  log({ newJournalBlock });
  if (!newJournalBlock || newJournalBlock.journalDay === undefined) return;

  const prevJournals = await queryCurrentRepoRangeJournals(newJournalBlock.journalDay);
  log({ prevJournals });
  if (!prevJournals || prevJournals.length === 0) {
    return;
  }
  const latestJournal = prevJournals.reduce( // TODO: This aggregation should be handled by the query itself.
    (prev: JournalPage, current: JournalPage) => prev['journal-day'] > current['journal-day'] ? prev : current
  );
  log({ latestJournal });
  const latestJournalBlocks = await logseq.Editor.getPageBlocksTree(latestJournal.name);
  log({ latestJournalBlocks });

  const latestJournalBlockGroups = splitBlocksIntoGroups(latestJournalBlocks);
  log({ latestJournalBlockGroups });

  let newJournalLastBlock = await getLastBlock(newJournalBlock.name);
  if (!newJournalLastBlock) {
    // Today is somehow blockless — bail rather than crashing in the loop.
    log('newJournalLastBlock is null, skipping migration');
    return;
  }
  for (const group of latestJournalBlockGroups) {
    if (group.some((block: BlockEntity) => recursivelyCheckForRegexInBlock(block, todoRegex))) {
      const hasAnyDoneTasks = group.some((block: BlockEntity) => recursivelyCheckForRegexInBlock(block, doneRegex));
      for (const block of group) {
        const [nextLast, isBlockRemoved] = await recursiveCopyBlocks(block, newJournalLastBlock, hasAnyDoneTasks);
        newJournalLastBlock = nextLast;
        if (isBlockRemoved) {
          // We want to remove the empty "group separators" from the source journal
          let leftBlock = await getLeftSibling(block);
          while (leftBlock && blockContent(leftBlock) === '' && (leftBlock.children?.length ?? 0) === 0) {
            const nextLeft = await getLeftSibling(leftBlock);
            await logseq.Editor.removeBlock(leftBlock.uuid);
            leftBlock = nextLeft;
          }
        }
      }
      log(['inserting block between groups', blockContent(newJournalLastBlock), newJournalLastBlock, newJournalBlock]);
      // we add a block twice because the copy updates the last empty block
      await logseq.Editor.appendBlockInPage(newJournalBlock.uuid, ''); // actual separator
      await logseq.Editor.appendBlockInPage(newJournalBlock.uuid, ''); // new block of next group
      const refreshed = await getLastBlock(newJournalBlock.name); // appendBlockInPage returns the block before somewhy
      if (!refreshed) break; // No blocks left on today — done.
      newJournalLastBlock = refreshed;
    }
  }
  let lastEmptyBlock = await getLastBlock(newJournalBlock.name);
  while (lastEmptyBlock && blockContent(lastEmptyBlock) === '') {
    await logseq.Editor.removeBlock(lastEmptyBlock.uuid);
    lastEmptyBlock = await getLastBlock(newJournalBlock.name);
  }
}

// Result of one recursive copy step:
//   newBlock              — the block to use as lastDestBlock for the next sibling
//   isBlockRemoved        — true if we deleted srcBlock from source after copying
//   hasAnyDoneDescendant  — true if srcBlock or any descendant was DONE (signals
//                           up to the caller: don't delete yourself from source)
type CopyResult = [BlockEntity, boolean, boolean];

async function recursiveCopyBlocks(
  srcBlock: BlockEntity,
  lastDestBlock: BlockEntity,
  groupHasAnyDoneTask: boolean,
): Promise<CopyResult> {
  // copied from https://github.com/vipzhicheng/logseq-plugin-move-block TODO add note in readme
  let hasAnyDoneDescendant = false;
  const srcContent = blockContent(srcBlock);
  if (doneRegex.test(srcContent)) {
    // DONE blocks stay in source. Signal hasAnyDoneDescendant=true so the
    // caller (parent block) knows it has a DONE descendant and must NOT
    // delete itself from source — otherwise this DONE child would be
    // removed along with the parent's subtree.
    return [lastDestBlock, false, true];
  }
  let newBlock: BlockEntity = lastDestBlock;
  const lastDestContent = blockContent(lastDestBlock);
  if (lastDestContent !== '') {
    log(['inserting block', srcContent, lastDestContent, srcBlock, lastDestBlock]);
    const inserted = await logseq.Editor.insertBlock(lastDestBlock.uuid, srcContent, {
      sibling: true,
    });
    if (!inserted) throw new Error(`insertBlock returned null for ${srcContent}`);
    newBlock = inserted;
  } else {
    log(['updating block content', srcContent, lastDestContent, srcBlock, lastDestBlock]);
    await logseq.Editor.updateBlock(lastDestBlock.uuid, srcContent);
    // updateBlock doesn't refresh the in-memory instance; keep both fields
    // in sync so subsequent blockContent(newBlock) reads see the update on
    // either SDK version.
    newBlock.content = srcContent;
    (newBlock as { title?: unknown }).title = srcContent;
  }

  const children = (srcBlock.children ?? []) as Array<BlockEntity>;
  if (children.length > 0) {
    log(['inserting child block', srcContent, blockContent(newBlock), srcBlock, newBlock]);
    const firstChild = await logseq.Editor.insertBlock(newBlock.uuid, '');
    if (!firstChild) throw new Error('insertBlock returned null for empty child placeholder');
    let newChildBlock: BlockEntity = firstChild;
    const firstChildBlockUUID = newChildBlock.uuid;
    for (const child of children) {
      const [nextChild, , childHasAnyDoneDescendant] =
        await recursiveCopyBlocks(child, newChildBlock, groupHasAnyDoneTask);
      newChildBlock = nextChild;
      hasAnyDoneDescendant = hasAnyDoneDescendant || childHasAnyDoneDescendant;
    }
    if (newChildBlock.uuid === firstChildBlockUUID && blockContent(newChildBlock) === '') {
      // Actually all children were DONE, we didn't copy to the empty block.
      log(['removing unused child block', blockContent(newChildBlock), newChildBlock]);
      await logseq.Editor.removeBlock(newChildBlock.uuid);
    }
  }
  let isBlockRemoved = false;
  if (!hasAnyDoneDescendant && (!(isUnderlineRegex.test(srcContent) && groupHasAnyDoneTask))) {
    // we can safely delete the block if it was copied whole
    // we keep underline blocks for groups with done tasks as they are titles
    log(['Removing block from source', srcContent, srcBlock]);
    await logseq.Editor.removeBlock(srcBlock.uuid);
    isBlockRemoved = true;
  }
  return [newBlock, isBlockRemoved, hasAnyDoneDescendant];
}


export const getLastBlock = async function (
  pageName: string
): Promise<null | BlockEntity> {
  // copied from https://github.com/vipzhicheng/logseq-plugin-move-block TODO add note in readme
  const blocks = await logseq.Editor.getPageBlocksTree(pageName);
  if (blocks.length === 0) {
    return null;
  }
  return blocks[blocks.length - 1];
};


async function main() {
  initSettings();
  const keyBindings = getSettings('keyBindings', {});

  logseq.App.registerCommandPalette(
    {
      key: `toggle-todo-block`,
      label: `Toggle TODO for the current block(s)`,
      keybinding: {
        mode: 'global',
        binding: keyBindings['TODO'] || 'mod+1',
      },
    },
    async () => {
      await toggleTODO();
    }
  );

  logseq.App.registerCommandPalette(
    {
      key: `toggle-highlight-block`,
      label: `Toggle highlighting for the current block(s)`,
      keybinding: {
        mode: 'global',
        binding: keyBindings['HIGHLIGHT'] || 'mod+4',
      },
    },
    async () => {
      await toggleHighlight();
    }
  );
  logseq.DB.onChanged(async params => {
    await updateNewJournalWithAllTODOs(params);
  });

}

logseq.ready(main).catch(error);
