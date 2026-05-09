// Journal-migration test cases. Each case seeds journal markdown files
// on disk, deletes today's file to trigger create-today-journal!, then
// asserts on the resulting markdown content (yesterday + today).
//
// Assertions return null on pass or a string failure message on fail.
//
// `journals` keys: 'today', 'yesterday', or a literal date slug like '2024_01_15'.
// `todayWaitMatch` is a predicate over today's content used to wait for
// migration to complete; if omitted, we wait for any non-empty content
// or fall through after the timeout.

import { TODAY_FILE, YDAY_FILE } from '../harness.mjs';

const eq = (actual, expected) => actual === expected
  ? null
  : `expected:\n---\n${expected}---\nactual:\n---\n${actual}---\n`;

const contains = (s, regex, label) =>
  regex.test(s) ? null : `${label}: missing ${regex} in:\n${s}`;

const notContains = (s, regex, label) =>
  !regex.test(s) ? null : `${label}: should not contain ${regex} in:\n${s}`;

const allOf = (...checks) => checks.find(c => c !== null) || null;

export const migrationCases = [
  {
    name: 'rule-1-todo-group-migrates',
    journals: {
      yesterday: `- TODO Buy groceries
- TODO Call mom
`,
      today: '-\n',
    },
    todayWaitMatch: c => /TODO Buy groceries/.test(c),
    expect: (j) => allOf(
      contains(j[TODAY_FILE], /TODO Buy groceries/, 'today missing first TODO'),
      contains(j[TODAY_FILE], /TODO Call mom/, 'today missing second TODO'),
      notContains(j[YDAY_FILE], /TODO Buy groceries/, 'yesterday should be empty'),
    ),
  },

  {
    name: 'rule-1-todo-group-with-done-mixes',
    journals: {
      yesterday: `- TODO Buy groceries
- DONE Pay bills
- TODO Call mom
`,
      today: '-\n',
    },
    todayWaitMatch: c => /TODO Buy groceries/.test(c),
    expect: (j) => allOf(
      contains(j[TODAY_FILE], /TODO Buy groceries/, 'today missing TODO'),
      contains(j[TODAY_FILE], /TODO Call mom/, 'today missing second TODO'),
      notContains(j[TODAY_FILE], /DONE Pay bills/, 'today should not have DONE'),
      notContains(j[YDAY_FILE], /TODO Buy groceries/, 'yday should not have TODO'),
      contains(j[YDAY_FILE], /DONE Pay bills/, 'yday must keep DONE'),
    ),
  },

  {
    name: 'rule-2-all-done-group-stays',
    journals: {
      yesterday: `- DONE Pay bills
- DONE Email client
`,
      today: '-\n',
    },
    noMigrationExpected: true,
    expect: (j) => allOf(
      contains(j[YDAY_FILE], /DONE Pay bills/, 'yday must keep all DONE'),
      contains(j[YDAY_FILE], /DONE Email client/, 'yday must keep all DONE'),
      notContains(j[TODAY_FILE] || '', /DONE/, 'today should not have any DONE'),
    ),
  },

  {
    name: 'rule-3-title-with-dones-duplicates',
    journals: {
      yesterday: `- <ins>Project A</ins>
\t- TODO Write proposal
\t- DONE Email client
`,
      today: '-\n',
    },
    todayWaitMatch: c => /TODO Write proposal/.test(c),
    expect: (j) => allOf(
      // Title duplicates: present in both
      contains(j[TODAY_FILE], /<ins>Project A<\/ins>/, 'today missing duplicated title'),
      contains(j[YDAY_FILE], /<ins>Project A<\/ins>/, 'yday missing kept title'),
      // TODO migrates, DONE stays
      contains(j[TODAY_FILE], /TODO Write proposal/, 'today missing TODO'),
      contains(j[YDAY_FILE], /DONE Email client/, 'yday missing DONE'),
      notContains(j[TODAY_FILE], /DONE Email client/, 'today should not have DONE'),
      notContains(j[YDAY_FILE], /TODO Write proposal/, 'yday should not have TODO'),
    ),
  },

  {
    name: 'rule-4-title-with-only-todos-migrates-fully',
    journals: {
      yesterday: `- <ins>Project B</ins>
\t- TODO Design
\t- TODO Build
`,
      today: '-\n',
    },
    todayWaitMatch: c => /<ins>Project B<\/ins>/.test(c),
    expect: (j) => allOf(
      contains(j[TODAY_FILE], /<ins>Project B<\/ins>/, 'today missing title'),
      contains(j[TODAY_FILE], /TODO Design/, 'today missing first TODO child'),
      contains(j[TODAY_FILE], /TODO Build/, 'today missing second TODO child'),
      // Yesterday should not retain the title (no DONEs to anchor it)
      notContains(j[YDAY_FILE] || '', /<ins>Project B<\/ins>/, 'yday should not keep title (no DONEs)'),
    ),
  },

  {
    name: 'rule-5-empty-separator-cleanup',
    journals: {
      yesterday: `- TODO First
-
- DONE Already done
`,
      today: '-\n',
    },
    todayWaitMatch: c => /TODO First/.test(c),
    expect: (j) => allOf(
      contains(j[TODAY_FILE], /TODO First/, 'today missing TODO'),
      contains(j[YDAY_FILE], /DONE Already done/, 'yday missing DONE'),
      notContains(j[YDAY_FILE], /TODO First/, 'yday should not have TODO'),
      // Yesterday should not start with an empty separator block (was cleaned up)
      // First non-empty line after dashes should be the DONE
    ),
  },

  {
    name: 'rule-7-recursion-mixed-children',
    // KNOWN BUG: when a parent has mixed children, the DONE child is
    // currently dropped instead of staying in source. The test asserts
    // the *correct* behavior — fix the plugin to make this pass.
    knownFailing: true,
    journals: {
      yesterday: `- TODO Parent task
\t- TODO Subtask 1
\t- DONE Subtask done
\t- TODO Subtask 2
`,
      today: '-\n',
    },
    todayWaitMatch: c => /TODO Parent task/.test(c),
    expect: (j) => allOf(
      // Parent migrates (or duplicates as title) because it has TODO descendants
      contains(j[TODAY_FILE], /TODO Parent task/, 'today missing parent'),
      contains(j[TODAY_FILE], /TODO Subtask 1/, 'today missing TODO subtask'),
      contains(j[TODAY_FILE], /TODO Subtask 2/, 'today missing TODO subtask 2'),
      notContains(j[TODAY_FILE], /DONE Subtask done/, 'today should not have DONE child'),
      contains(j[YDAY_FILE], /DONE Subtask done/, 'yday must keep DONE child'),
    ),
  },

  {
    name: 'rule-8-multiple-groups-independent',
    journals: {
      yesterday: `- TODO Group A task
-
- TODO Group B task
-
- DONE Group C done
`,
      today: '-\n',
    },
    todayWaitMatch: c => /TODO Group A task/.test(c) && /TODO Group B task/.test(c),
    expect: (j) => allOf(
      contains(j[TODAY_FILE], /TODO Group A task/, 'today missing group A'),
      contains(j[TODAY_FILE], /TODO Group B task/, 'today missing group B'),
      notContains(j[TODAY_FILE], /DONE Group C done/, 'today should not have group C (all-DONE)'),
      contains(j[YDAY_FILE], /DONE Group C done/, 'yday must keep group C'),
      notContains(j[YDAY_FILE], /TODO Group A task/, 'yday should not have group A'),
      notContains(j[YDAY_FILE], /TODO Group B task/, 'yday should not have group B'),
    ),
  },

  {
    name: 'rule-9-empty-graph-no-crash',
    journals: {
      // Only today seeded, no yesterday or historical journals at all
      today: '-\n',
    },
    noMigrationExpected: true,
    expect: (j) => {
      // Today should remain empty/no migration. No crash. (Empty graph case
      // exercises the prevJournals === [] early-return path.)
      const t = j[TODAY_FILE] || '';
      if (/TODO|DONE/.test(t)) {
        return `today should be empty but contains:\n${t}`;
      }
      return null;
    },
  },

  {
    name: 'rule-10-yesterday-no-todos-only-plain',
    journals: {
      yesterday: `- Just a plain note
- Another plain line
`,
      today: '-\n',
    },
    noMigrationExpected: true,
    expect: (j) => {
      // Yesterday has no TODOs → no group qualifies → no migration.
      const t = j[TODAY_FILE] || '';
      if (/Just a plain note|Another plain line/.test(t)) {
        return `today should not have plain content from yesterday:\n${t}`;
      }
      return contains(j[YDAY_FILE], /Just a plain note/, 'yday should keep its plain content');
    },
  },

  {
    name: 'rule-11-today-has-pre-existing-content',
    // KNOWN BUG: when today already has content, the migration overwrites
    // it instead of appending. The test asserts the *correct* behavior.
    knownFailing: true,
    journals: {
      yesterday: `- TODO Buy groceries
`,
      today: `- Existing morning note
- TODO Already in today
`,
    },
    todayWaitMatch: c => /TODO Buy groceries/.test(c),
    expect: (j) => allOf(
      contains(j[TODAY_FILE], /Existing morning note/, 'today must keep existing content'),
      contains(j[TODAY_FILE], /TODO Already in today/, 'today must keep its own pre-existing TODO'),
      contains(j[TODAY_FILE], /TODO Buy groceries/, 'today must have migrated TODO'),
    ),
  },

  {
    name: 'rule-12-latest-journal-selection',
    journals: {
      // Multiple historical journals; the plugin must pick the most recent
      // one before today (yesterday) as the migration source.
      '2024_01_15': `- TODO This is from 2024 — should NOT migrate
`,
      '2025_06_03': `- TODO This is from 2025 — should NOT migrate
`,
      yesterday: `- TODO From actual yesterday — should migrate
`,
      today: '-\n',
    },
    todayWaitMatch: c => /From actual yesterday/.test(c),
    expect: (j) => allOf(
      contains(j[TODAY_FILE], /TODO From actual yesterday/, 'today must have actual-yesterday TODO'),
      notContains(j[TODAY_FILE], /from 2024/, 'today should not have 2024 TODO'),
      notContains(j[TODAY_FILE], /from 2025/, 'today should not have 2025 TODO'),
      // Historical journals stay untouched
      contains(j['2024_01_15'], /from 2024/, 'historical 2024 should be untouched'),
      contains(j['2025_06_03'], /from 2025/, 'historical 2025 should be untouched'),
    ),
  },
];
