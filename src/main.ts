import '@logseq/libs';

import {BlockEntity} from '@logseq/libs/dist/LSPlugin';


const todoRegex = /^(TODO|DONE)\s+/;
const doneRegex = /^(DONE)\s+/;

const settingsVersion = 'v1';
export const defaultSettings = {
  keyBindings: {
    'TODO': 'mod+1',
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

const extractTodoState = (block: BlockEntity) => {
  let todoMatch = todoRegex.exec(block.content);
  return (todoMatch !== null && todoMatch.length > 0) ? todoMatch[1] : '';
};

async function toggleTODO() {
  const selected = await logseq.Editor.getSelectedBlocks();
  const blocks = (selected && selected.length > 1) ? selected : [await logseq.Editor.getCurrentBlock()];
  const blocksInDifferentStates = (blocks.length > 0 && blocks.some(block => extractTodoState(block) != extractTodoState(blocks[0])));
  for (let block of blocks) {
    if (block?.uuid) {
      let todoState = blocksInDifferentStates ? 'DONE' : extractTodoState(block); // If blocks are in different states we "clear" them.
      let strippedContent = todoRegex.test(block.content)
        ? block.content.replace(todoRegex, '')
        : block.content;
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
  console.log({newJournalBlock});

  const prevJournals = await queryCurrentRepoRangeJournals(newJournalBlock['journalDay']);
  console.log({prevJournals});
  const latestJournal = prevJournals.reduce( // TODO: This aggregation should be handled by the query itself.
    (prev, current) => prev['journal-day'] > current['journal-day'] ? prev : current
  );
  console.log({latestJournal});
  const latestJournalBlocks = await logseq.Editor.getPageBlocksTree(latestJournal.name);
  console.log({latestJournalBlocks});

  let latestJournalBlockGroups = [[]];
  for (let block of latestJournalBlocks) {
    if (block.content !== '') {
      latestJournalBlockGroups[latestJournalBlockGroups.length - 1].push(block);
    } else {
      latestJournalBlockGroups.push([]);
    }
  }
  console.log({latestJournalBlockGroups});

  let newJournalLastBlock = await getLastBlock(newJournalBlock.name);
  for (let group of latestJournalBlockGroups) {
    if (group.some(recursivelyCheckForTodoInBlock)) {
      for (let block of group) {
        newJournalLastBlock = await recursiveCopyBlocks(block, newJournalLastBlock);
      }
      newJournalLastBlock == await logseq.Editor.insertBlock(newJournalLastBlock.uuid, '');
    }
  }
}

async function recursiveCopyBlocks(srcBlock: BlockEntity, lastDestBlock: BlockEntity) {
  // copied from https://github.com/vipzhicheng/logseq-plugin-move-block TODO add note in readme
  if (doneRegex.test(srcBlock.content)) {
    return lastDestBlock;
  }
  let newBlock = lastDestBlock;
  console.log({srcBlock, lastDestBlock});
  if (lastDestBlock.content !== '') {
    newBlock = await logseq.Editor.insertBlock(lastDestBlock.uuid, srcBlock.content, {
      sibling: true,
    });
  } else {
    await logseq.Editor.updateBlock(lastDestBlock.uuid, srcBlock.content);
    newBlock.content = srcBlock.content; // update doesn't update the instance.
  }

  if (srcBlock.children.length > 0) {
    let newChildBlock = await logseq.Editor.insertBlock(newBlock.uuid, '');
    for (let child of srcBlock.children) {
      newChildBlock = await recursiveCopyBlocks(child, newChildBlock);
    }
  }
  return newBlock;
}


function recursivelyCheckForTodoInBlock(block) {
  return todoRegex.test(block.content) || block.children.some(recursivelyCheckForTodoInBlock);
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

  logseq.DB.onChanged(async (params) => {
    await updateNewJournalWithAllTODOs(params);
  });

}

logseq.ready(main).catch(console.error);
