import '@logseq/libs';

import {BlockEntity} from '@logseq/libs/dist/LSPlugin';


// Read a block's text content. In @logseq/libs >= 0.0.17 `block.content`
// is @deprecated and `block.title` is canonical; both fields can be present
// at runtime depending on Logseq version. Use this everywhere instead of
// reading .content directly so the plugin works across SDK versions.
const blockContent = (block: BlockEntity | undefined | null): string => {
  if (!block) return '';
  // .title is the new field but doesn't exist on the 0.0.9 type — cast.
  return (block as any).title ?? block.content ?? '';
};

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

const todoRegex = /^(TODO)\s+/;
const doneRegex = /^(DONE)\s+/;
const todoDoneRegex = /^(TODO|DONE)\s+/;
const isUnderlineRegex = /<ins>.*<\/ins>/;

const highlightRegex = /^(TODO\s+|DONE\s+|\s*)\^\^(.*)\^\^/;

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

const getNextTodoState = (todoState: string) => {
  return {
    'TODO': 'DONE ',
    'DONE': '',
    '': 'TODO '
  }[todoState];
};

const getSettings = (
  key: string | undefined,
  defaultValue: any = undefined
) => {
  let settings = logseq.settings;
  const merged = Object.assign(defaultSettings, settings);
  return key ? (merged[key] ? merged[key] : defaultValue) : merged;
};

const isHighlighted = (block: BlockEntity) => {
  return highlightRegex.test(blockContent(block));
};

const extractTodoState = (block: BlockEntity) => {
  let todoMatch = todoDoneRegex.exec(blockContent(block));
  return (todoMatch !== null && todoMatch.length > 0) ? todoMatch[1] : '';
};

async function toggleHighlight() {
  // sorry for the copy-paste maybe I'll fix you later
  const selected = await logseq.Editor.getSelectedBlocks();
  const blocks = (selected && selected.length > 1) ? selected : [await logseq.Editor.getCurrentBlock()];
  const blocksInDifferentStates = (blocks.length > 0 && blocks.some(block => isHighlighted(block) != isHighlighted(blocks[0])));
  for (let block of blocks) {
    if (block?.uuid) {
      if (isHighlighted(block)) {
        let [, todoState, strippedContent] = highlightRegex.exec(blockContent(block));
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

async function toggleTODO() {
  const selected = await logseq.Editor.getSelectedBlocks();
  const blocks = (selected && selected.length > 1) ? selected : [await logseq.Editor.getCurrentBlock()];
  const blocksInDifferentStates = (blocks.length > 0 && blocks.some(block => extractTodoState(block) != extractTodoState(blocks[0])));
  for (let block of blocks) {
    if (block?.uuid) {
      let todoState = blocksInDifferentStates ? 'DONE' : extractTodoState(block); // If blocks are in different states we "clear" them.
      const content = blockContent(block);
      let strippedContent = todoDoneRegex.test(content)
        ? content.replace(todoDoneRegex, '')
        : content;
      await logseq.Editor.updateBlock(
        block.uuid,
        getNextTodoState(todoState) + strippedContent
      );
    }
  }
}

// const updateNewJournalWithAllTODOs = ({path, template}) => {
//   // This hook is actually called on every route change, fortunately a route change happens when creating a new journal.
//   console.log(path, template);
//   debugger;
// };

async function queryCurrentRepoRangeJournals(untilDate) {
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
    console.error(e);
  }
}


async function updateNewJournalWithAllTODOs({blocks, txData, txMeta}) {
  // This hook is actually called on every block update so checking if the block update is a journal creation transatcion should be fast.
  let updatedAt = null;
  let createdAt = null;
  let isJournal = false;
  for (let datum of txData) {
    // datum structure https://tonsky.me/blog/datascript-internals/
    if ((datum[1] === 'updatedAt' || datum[1] === "block/updated-at") && datum[4] === true) {
      updatedAt = datum[2];
    }
    if ((datum[1] === 'createdAt' || datum[1] === "block/created-at") && datum[4] === true) {
      createdAt = datum[2];
    }
    if ((datum[1] === 'journal?' || datum[1] === "block/journal?") && datum[4] === true) {
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
  type JournalPageBlock = BlockEntity & { 'journal?'?: boolean; journalDay?: number; };
  const newJournalBlock = blocks.find(
    (block): block is JournalPageBlock =>
      block.hasOwnProperty('createdAt') && (block as JournalPageBlock)['journal?'] === true
  ) as JournalPageBlock | undefined;
  console.log({newJournalBlock});
  if (!newJournalBlock) return;

  const prevJournals = await queryCurrentRepoRangeJournals(newJournalBlock['journalDay']);
  console.log({prevJournals});
  if (!prevJournals || prevJournals.length === 0) {
    return;
  }
  const latestJournal = prevJournals.reduce( // TODO: This aggregation should be handled by the query itself.
    (prev, current) => prev['journal-day'] > current['journal-day'] ? prev : current
  );
  console.log({latestJournal});
  const latestJournalBlocks = await logseq.Editor.getPageBlocksTree(latestJournal.name);
  console.log({latestJournalBlocks});

  let latestJournalBlockGroups = [[]];
  for (let block of latestJournalBlocks) {
    if (blockContent(block) !== '') {
      latestJournalBlockGroups[latestJournalBlockGroups.length - 1].push(block);
    } else {
      latestJournalBlockGroups.push([]);
    }
  }
  console.log({latestJournalBlockGroups});

  let newJournalLastBlock = await getLastBlock(newJournalBlock.name);
  for (let group of latestJournalBlockGroups) {
    if (group.some(block => recursivelyCheckForRegexInBlock(block, todoRegex))) {
      const hasAnyDoneTasks = group.some(block => recursivelyCheckForRegexInBlock(block, doneRegex));
      for (let block of group) {
        let isBlockRemoved = false;
        [newJournalLastBlock, isBlockRemoved,] = await recursiveCopyBlocks(block, newJournalLastBlock, hasAnyDoneTasks);
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
      console.log(["inserting block between groups", blockContent(newJournalLastBlock), newJournalLastBlock, newJournalBlock]);
      // we add a block twice because the copy updates the last empty block
      await logseq.Editor.appendBlockInPage(newJournalBlock.uuid, ''); // actual separator
      await logseq.Editor.appendBlockInPage(newJournalBlock.uuid, ''); // new block of next group
      newJournalLastBlock = await getLastBlock(newJournalBlock.name); // appendBlockInPage returns the block before somewhy
    }
  }
  let lastEmptyBlock = await getLastBlock(newJournalBlock.name);
  while (lastEmptyBlock && blockContent(lastEmptyBlock) === '') {
    await logseq.Editor.removeBlock(lastEmptyBlock.uuid);
    lastEmptyBlock = await getLastBlock(newJournalBlock.name);
  }
}

async function recursiveCopyBlocks(srcBlock: BlockEntity, lastDestBlock: BlockEntity, groupHasAnyDoneTask: boolean) {
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
  let newBlock = lastDestBlock;
  const lastDestContent = blockContent(lastDestBlock);
  if (lastDestContent !== '') {
    console.log(["inserting block", srcContent, lastDestContent, srcBlock, lastDestBlock]);
    newBlock = await logseq.Editor.insertBlock(lastDestBlock.uuid, srcContent, {
      sibling: true,
    });
  } else {
    console.log(["updating block content", srcContent, lastDestContent, srcBlock, lastDestBlock]);
    await logseq.Editor.updateBlock(lastDestBlock.uuid, srcContent);
    // updateBlock doesn't refresh the in-memory instance; keep both fields
    // in sync so subsequent blockContent(newBlock) reads see the update on
    // either SDK version.
    newBlock.content = srcContent;
    (newBlock as any).title = srcContent;
  }

  if (srcBlock.children.length > 0) {
    console.log(["inserting child block", srcContent, blockContent(newBlock), srcBlock, newBlock]);
    let newChildBlock = await logseq.Editor.insertBlock(newBlock.uuid, '');
    const firstChildBlockUUID = newChildBlock.uuid;
    for (let child of srcBlock.children) {
      let childHasAnyDoneDescendant;
      [newChildBlock, , childHasAnyDoneDescendant] = await recursiveCopyBlocks(child as BlockEntity, newChildBlock, groupHasAnyDoneTask);
      hasAnyDoneDescendant = hasAnyDoneDescendant || childHasAnyDoneDescendant;
    }
    if (newChildBlock.uuid === firstChildBlockUUID && blockContent(newChildBlock) === '') {
      // Actually all children were DONE, we didn't copy to the empty block.
      console.log(["removing unused child block", blockContent(newChildBlock), newChildBlock]);
      await logseq.Editor.removeBlock(newChildBlock.uuid);
    }
  }
  let isBlockRemoved = false;
  if (!hasAnyDoneDescendant && (!(isUnderlineRegex.test(srcContent) && groupHasAnyDoneTask))) {
    // we can safely delete the block if it was copied whole
    // we keep underline blocks for groups with done tasks as they are titles
    console.log(["Removing block from source", srcContent, srcBlock]);
    await logseq.Editor.removeBlock(srcBlock.uuid);
    isBlockRemoved = true;
  }
  return [newBlock, isBlockRemoved, hasAnyDoneDescendant];
}


function recursivelyCheckForRegexInBlock(block: BlockEntity, regex: RegExp): boolean {
  return regex.test(blockContent(block)) || block.children.some(child => recursivelyCheckForRegexInBlock(child as BlockEntity, regex));
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
  logseq.DB.onChanged(async (params) => {
    await updateNewJournalWithAllTODOs(params);
  });

}

logseq.ready(main).catch(console.error);
