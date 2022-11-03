import '@logseq/libs';

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

const extractTodoState = (regex: RegExp, block: logseq.Block) => {
  let todoMatch = regex.exec(block.content);
  return (todoMatch !== null && todoMatch.length > 0) ? todoMatch[1] : '';
};

async function toggleTODO() {
  let regex = /^(TODO|DONE)\s+/;
  const selected = await logseq.Editor.getSelectedBlocks();
  const blocks = (selected && selected.length > 1) ? selected : [await logseq.Editor.getCurrentBlock()];
  const blocksInDifferentStates = (blocks.length > 0 && blocks.some(block => extractTodoState(regex, block) != extractTodoState(regex, blocks[0])))
  for (let block of blocks) {
    if (block?.uuid) {
      let todoState = blocksInDifferentStates ? 'DONE' : extractTodoState(regex, block); // If blocks are in different states we "clear" them.
      let strippedContent = regex.test(block.content)
        ? block.content.replace(regex, '')
        : block.content;
      await logseq.Editor.updateBlock(
        block.uuid,
        getNextTodoState(todoState) + strippedContent
      );
    }
  }
}

async function main() {
  initSettings();
  const keyBindings = getSettings('keyBindings', {});

  logseq.App.registerCommandPalette(
    {
      key: `toggle-todo`,
      label: `Toggle TODO for the current block`,
      keybinding: {
        mode: 'global',
        binding: keyBindings['TODO'] || 'mod+1',
      },
    },
    async () => {
      await toggleTODO();
    }
  );
}

logseq.ready(main).catch(console.error);
