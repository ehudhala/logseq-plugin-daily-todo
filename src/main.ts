import '@logseq/libs';

import {BlockEntity} from '@logseq/libs/dist/LSPlugin';

const DEBUGGING = false;

const todoRegex = /^(TODO|DOING|NOW|LATER)\s+/;
const doneRegex = /^(DONE)\s+/;
const todoDoneRegex = /^(TODO|DOING|NOW|LATER|DONE)\s+/;
const isUnderlineRegex = /<ins>.*<\/ins>/;

const highlightRegex =
  /^(TODO\s+|DOING\s+|NOW\s+|LATER\s+|DONE\s+|\s*)\^\^(.*)\^\^/;

const settingsVersion = 'v1';

const log = DEBUGGING ? console.log : () => {};

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

const getNextTodoState = (todoState: string, preferredWorkflow = 'todo') => {
  switch (preferredWorkflow) {
    case 'now':
      return {
        TODO: 'DONE ',
        DOING: 'DONE ',
        DONE: '',
        '': 'TODO ',
      }[todoState];
    default:
      return {
        LATER: 'DONE ',
        NOW: 'DONE ',
        DONE: '',
        '': 'LATER ',
      }[todoState];
  }
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
  return highlightRegex.test(block.content);
};

const extractTodoState = (block: BlockEntity) => {
  let todoMatch = todoDoneRegex.exec(block.content);
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
        let [, todoState, strippedContent] = highlightRegex.exec(block.content);
        await logseq.Editor.updateBlock(block.uuid, todoState + strippedContent);
      } else {
        let todoPrefix = extractTodoState(block);
        todoPrefix = todoPrefix !== '' ? todoPrefix + ' ' : todoPrefix;
        await logseq.Editor.updateBlock(block.uuid, 
          blocksInDifferentStates // we want to just update all blocks to be un-highlighted
            ? block.content
            : todoPrefix + '^^' + block.content.replace(todoDoneRegex, '') + '^^');
      }
    }
  }
}

async function toggleTODO(preferredWorkflow = 'todo') {
  const selected = await logseq.Editor.getSelectedBlocks();
  const blocks = (selected && selected.length > 1) ? selected : [await logseq.Editor.getCurrentBlock()];
  const blocksInDifferentStates = (blocks.length > 0 && blocks.some(block => extractTodoState(block) != extractTodoState(blocks[0])));
  for (let block of blocks) {
    if (block?.uuid) {
      let todoState = blocksInDifferentStates ? 'DONE' : extractTodoState(block); // If blocks are in different states we "clear" them.
      let strippedContent = todoDoneRegex.test(block.content)
        ? block.content.replace(todoDoneRegex, '')
        : block.content;
      await logseq.Editor.updateBlock(
        block.uuid,
        getNextTodoState(todoState, preferredWorkflow) + strippedContent
      );
    }
  }
}

// const updateNewJournalWithAllTODOs = ({path, template}) => {
//   // This hook is actually called on every route change, fortunately a route change happens when creating a new journal.
//   log(path, template);
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
    if (datum[1] === 'updatedAt' && datum[4] === true) {
      updatedAt = datum[2];
    }
    if (datum[1] === 'createdAt' && datum[4] === true) {
      createdAt = datum[2];
    }
    if (datum[1] === 'journal?' && datum[4] === true) {
      isJournal = datum[2];
    }
  }
  const isJournalCreatedEvent = updatedAt !== null && updatedAt === createdAt && isJournal;
  if (!isJournalCreatedEvent) {
    return;
  }

  const newJournalBlock = blocks.find(block => block.hasOwnProperty('createdAt') && block['journal?'] === true);
  log({ newJournalBlock });

  const prevJournals = await queryCurrentRepoRangeJournals(newJournalBlock['journalDay']);
  log({ prevJournals });
  const latestJournal = prevJournals.reduce( // TODO: This aggregation should be handled by the query itself.
    (prev, current) => prev['journal-day'] > current['journal-day'] ? prev : current
  );
  log({latestJournal});
  const latestJournalBlocks = await logseq.Editor.getPageBlocksTree(latestJournal.name);
  log({latestJournalBlocks});

  let latestJournalBlockGroups = [[]];
  for (let block of latestJournalBlocks) {
    if (block.content !== '') {
      latestJournalBlockGroups[latestJournalBlockGroups.length - 1].push(block);
    } else {
      latestJournalBlockGroups.push([]);
    }
  }
  log({latestJournalBlockGroups});

  let newJournalLastBlock = await getLastBlock(newJournalBlock.name);
  for (let group of latestJournalBlockGroups) {
    if (group.some(block => recursivelyCheckForRegexInBlock(block, todoRegex))) {
      const hasAnyDoneTasks = group.some(block => recursivelyCheckForRegexInBlock(block, doneRegex));
      for (let block of group) {
        let isBlockRemoved = false;
        [newJournalLastBlock, isBlockRemoved,] = await recursiveCopyBlocks(block, newJournalLastBlock, hasAnyDoneTasks);
        if (isBlockRemoved) {
          // We want to remove the empty "group separators" from the source journal
          let leftBlock = await logseq.Editor.getBlock(block.left.id, {includeChildren: true});
          while (leftBlock?.content === '' && leftBlock?.children?.length === 0) {
            await logseq.Editor.removeBlock(leftBlock.uuid);
            leftBlock = await logseq.Editor.getBlock(leftBlock.left.id, {includeChildren: true});
          }
        }
      }
      log(["inserting block between groups", newJournalLastBlock?.content, newJournalLastBlock, newJournalBlock]);
      // we add a block twice because the copy updates the last empty block
      await logseq.Editor.appendBlockInPage(newJournalBlock.uuid, ''); // actual separator
      await logseq.Editor.appendBlockInPage(newJournalBlock.uuid, ''); // new block of next group
      newJournalLastBlock = await getLastBlock(newJournalBlock.name); // appendBlockInPage returns the block before somewhy
    }
  }
  let lastEmptyBlock = await getLastBlock(newJournalBlock.name);
  while (lastEmptyBlock?.content === '') {
    await logseq.Editor.removeBlock(lastEmptyBlock.uuid);
    lastEmptyBlock = await getLastBlock(newJournalBlock.name);
  }
}

async function recursiveCopyBlocks(srcBlock: BlockEntity, lastDestBlock: BlockEntity, groupHasAnyDoneTask: boolean) {
  // copied from https://github.com/vipzhicheng/logseq-plugin-move-block TODO add note in readme
  let hasAnyDoneDescendant = false;
  if (doneRegex.test(srcBlock.content)) {
    return [lastDestBlock, true];
  }
  let newBlock = lastDestBlock;
  if (lastDestBlock.content !== '') {
    log(['inserting block', srcBlock.content, lastDestBlock.content, srcBlock, lastDestBlock]);
    newBlock = await logseq.Editor.insertBlock(lastDestBlock.uuid, srcBlock.content, {
        sibling: true,
    });
  } else {
    log(["updating block content", srcBlock.content, lastDestBlock.content, srcBlock, lastDestBlock]);
    await logseq.Editor.updateBlock(lastDestBlock.uuid, srcBlock.content);
    newBlock.content = srcBlock.content; // update doesn't update the instance.
  }

  if (srcBlock.children.length > 0) {
    log(["inserting child block", srcBlock.content, newBlock.content, srcBlock, newBlock]);
    let newChildBlock = await logseq.Editor.insertBlock(newBlock.uuid, '');
    const firstChildBlockUUID = newChildBlock.uuid;
    for (let child of srcBlock.children) {
      let childHasAnyDoneDescendant;
      [newChildBlock, , childHasAnyDoneDescendant] = await recursiveCopyBlocks(child, newChildBlock, groupHasAnyDoneTask);
      hasAnyDoneDescendant = hasAnyDoneDescendant || childHasAnyDoneDescendant;
    }
    if (newChildBlock.uuid === firstChildBlockUUID && newChildBlock.content === '') {
      // Actually all children were DONE, we didn't copy to the empty block.
      log(["removing unused child block", newChildBlock?.content, newChildBlock]);
      await logseq.Editor.removeBlock(newChildBlock.uuid);
    }
  }
  let isBlockRemoved = false;
  if (!hasAnyDoneDescendant && (!(isUnderlineRegex.test(srcBlock.content) && groupHasAnyDoneTask))) {
    // we can safely delete the block if it was copied whole
    // we keep underline blocks for groups with done tasks as they are titles
    log(["Removing block from source", srcBlock.content, srcBlock]);
    await logseq.Editor.removeBlock(srcBlock.uuid);
    isBlockRemoved = true;
  }
  return [newBlock, isBlockRemoved, hasAnyDoneDescendant];
}


function recursivelyCheckForRegexInBlock(block: BlockEntity, regex: RegExp): boolean {
  return regex.test(block.content) || block.children.some(child => recursivelyCheckForRegexInBlock(child, regex));
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

  const { preferredWorkflow } = await logseq.App.getUserConfigs();

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
      await toggleTODO(preferredWorkflow);
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

logseq.ready(main).catch(console.error);
