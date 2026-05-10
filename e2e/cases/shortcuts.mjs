// Keyboard shortcut test cases. Each case seeds journal content,
// opens the journal, focuses a specific block, presses keystrokes,
// and asserts on the resulting markdown.
//
// Cases declare content under `today` for ergonomic readability, but
// the harness remaps it to `yesterday` because Logseq's
// create-today-journal! races on-disk seeds for today's file. Yesterday
// is a stable page Logseq doesn't auto-rewrite.
//
// On macOS, Logseq's `mod` keybinding maps to `Meta` (Command).
// Disk flushes after a keystroke usually take <300ms.

import { YDAY_FILE } from '../harness.mjs';
const TARGET = YDAY_FILE; // shortcut content lives in yesterday's journal

const contains = (s, regex, label) =>
  regex.test(s) ? null : `${label}: missing ${regex} in:\n${s}`;
const notContains = (s, regex, label) =>
  !regex.test(s) ? null : `${label}: should not contain ${regex} in:\n${s}`;
const allOf = (...checks) => checks.find(c => c !== null) || null;

export const shortcutCases = [
  {
    name: 'mod1-blank-becomes-todo',
    journals: { today: `- Buy groceries\n- Pay bills\n` },
    focusText: 'Buy groceries',
    actions: [{ press: 'Meta+1' }],
    expect: j => contains(j[TARGET], /^- TODO Buy groceries$/m, 'first block became TODO'),
  },

  {
    name: 'mod1-todo-becomes-done',
    journals: { today: `- TODO Buy groceries\n- Pay bills\n` },
    focusText: 'Buy groceries',
    actions: [{ press: 'Meta+1' }],
    expect: j => contains(j[TARGET], /^- DONE Buy groceries$/m, 'first block became DONE'),
  },

  {
    name: 'mod1-done-becomes-blank',
    journals: { today: `- DONE Buy groceries\n- Pay bills\n` },
    focusText: 'Buy groceries',
    actions: [{ press: 'Meta+1' }],
    expect: j => allOf(
      contains(j[TARGET], /^- Buy groceries$/m, 'first block back to plain'),
      notContains(j[TARGET], /^- (TODO|DONE) Buy groceries$/m, 'no TODO/DONE prefix'),
    ),
  },

  {
    name: 'mod1-full-cycle-blank-todo-done-blank',
    journals: { today: `- Buy groceries\n- Pay bills\n` },
    focusText: 'Buy groceries',
    actions: [
      { press: 'Meta+1' },                     // → TODO
      { focusText: 'Buy groceries', press: 'Meta+1' }, // → DONE
      { focusText: 'Buy groceries', press: 'Meta+1' }, // → blank
    ],
    expect: j => allOf(
      contains(j[TARGET], /^- Buy groceries$/m, 'block back to plain'),
      notContains(j[TARGET], /^- (TODO|DONE) Buy groceries$/m, 'no prefix'),
    ),
  },

  {
    name: 'mod4-blank-becomes-highlighted',
    journals: { today: `- Buy groceries\n- Pay bills\n` },
    focusText: 'Buy groceries',
    actions: [{ press: 'Meta+4' }],
    expect: j => contains(j[TARGET], /^- \^\^Buy groceries\^\^$/m, 'first block highlighted'),
  },

  {
    name: 'mod4-highlighted-becomes-blank',
    journals: { today: `- ^^Buy groceries^^\n- Pay bills\n` },
    focusText: 'Buy groceries',
    actions: [{ press: 'Meta+4' }],
    expect: j => allOf(
      contains(j[TARGET], /^- Buy groceries$/m, 'highlight removed'),
      notContains(j[TARGET], /\^\^Buy groceries\^\^/, 'no ^^ wrap remains'),
    ),
  },

  {
    name: 'mod4-preserves-todo-prefix',
    // The plugin's highlight regex is /^(TODO\s+|DONE\s+|\s*)\^\^(.*)\^\^/
    // so toggling highlight off should preserve the TODO prefix.
    journals: { today: `- TODO ^^Buy groceries^^\n- Pay bills\n` },
    focusText: 'Buy groceries',
    actions: [{ press: 'Meta+4' }],
    expect: j => allOf(
      contains(j[TARGET], /^- TODO Buy groceries$/m, 'TODO prefix preserved after un-highlighting'),
      notContains(j[TARGET], /\^\^/, 'no ^^ remains'),
    ),
  },

  // === NOW workflow cases ===
  // These pin :preferred-workflow :now in the graph's config.edn
  // before the case runs. The plugin re-reads the workflow on every
  // mod+1 press, so the change takes effect without a plugin reload.

  {
    name: 'now-mod1-blank-becomes-later',
    preferredWorkflow: 'now',
    journals: { today: `- Buy groceries\n- Pay bills\n` },
    focusText: 'Buy groceries',
    actions: [{ press: 'Meta+1' }],
    expect: j => contains(j[TARGET], /^- LATER Buy groceries$/m, 'first block became LATER'),
  },

  {
    name: 'now-mod1-later-becomes-done',
    preferredWorkflow: 'now',
    journals: { today: `- LATER Buy groceries\n- Pay bills\n` },
    focusText: 'Buy groceries',
    actions: [{ press: 'Meta+1' }],
    expect: j => contains(j[TARGET], /^- DONE Buy groceries$/m, 'LATER advanced to DONE'),
  },

  {
    name: 'now-mod1-now-becomes-done',
    preferredWorkflow: 'now',
    journals: { today: `- NOW Buy groceries\n- Pay bills\n` },
    focusText: 'Buy groceries',
    actions: [{ press: 'Meta+1' }],
    expect: j => contains(j[TARGET], /^- DONE Buy groceries$/m, 'NOW advanced to DONE'),
  },

  {
    name: 'now-mod1-todo-still-becomes-done',
    // Wrong-mode handling: a TODO-prefixed block in now-mode should
    // still advance to DONE, not get stuck. (This was the bug the
    // original community PR introduced — TODO in now-mode produced
    // `undefined` and corrupted the block.)
    preferredWorkflow: 'now',
    journals: { today: `- TODO Buy groceries\n- Pay bills\n` },
    focusText: 'Buy groceries',
    actions: [{ press: 'Meta+1' }],
    expect: j => contains(j[TARGET], /^- DONE Buy groceries$/m, 'TODO in now-mode → DONE'),
  },

  {
    name: 'now-mod1-full-cycle',
    preferredWorkflow: 'now',
    journals: { today: `- Buy groceries\n- Pay bills\n` },
    focusText: 'Buy groceries',
    actions: [
      { press: 'Meta+1' },                                    // → LATER
      { focusText: 'Buy groceries', press: 'Meta+1' },        // → DONE
      { focusText: 'Buy groceries', press: 'Meta+1' },        // → blank
    ],
    expect: j => allOf(
      contains(j[TARGET], /^- Buy groceries$/m, 'block back to plain'),
      notContains(j[TARGET], /^- (LATER|NOW|TODO|DONE) Buy groceries$/m, 'no prefix'),
    ),
  },
];
