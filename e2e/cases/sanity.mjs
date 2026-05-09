// Quick sanity test: one journal migration that exercises as many
// behavior combinations as possible in a single Logseq run. Designed
// for fast feedback during development — `pnpm test:e2e:quick` runs
// only this case (~15s end-to-end including Logseq launch).
//
// The mega-fixture below packs into one yesterday journal:
//   - Group with mixed TODO/DONE/title (rule 1, 3)
//   - Group with all DONEs that should stay put (rule 2)
//   - Group with title and only TODOs (rule 4)
//   - Recursive parent-with-children with mixed states (rule 7)
//   - Standalone TODO group (rule 1)
//   - Empty separator between groups (rule 5)
//
// One trigger, one assertion pass, and you find out if anything is
// broadly broken before running the full suite.

import { TODAY_FILE, YDAY_FILE } from '../harness.mjs';

const contains = (s, regex, label) =>
  regex.test(s) ? null : `${label}: missing ${regex} in:\n${s}`;
const notContains = (s, regex, label) =>
  !regex.test(s) ? null : `${label}: should not contain ${regex} in:\n${s}`;
const allOf = (...checks) => checks.find(c => c !== null) || null;

const MEGA_YDAY = `- TODO Buy groceries
- DONE Pay bills
- TODO Call mom
-
- DONE Already finished alpha
- DONE Already finished beta
-
- <ins>Project Mixed</ins>
\t- TODO Write proposal
\t- DONE Email client
-
- <ins>Project AllTodos</ins>
\t- TODO Design
\t- TODO Build
-
- TODO Standalone task
`;

export const sanityCase = {
  name: 'sanity-mega-migration',
  journals: {
    yesterday: MEGA_YDAY,
    today: '-\n',
  },
  todayWaitMatch: c =>
    /TODO Buy groceries/.test(c)
    && /TODO Standalone task/.test(c),
  expect: (j) => allOf(
    // === Mixed TODO/DONE group ===
    contains(j[TODAY_FILE], /TODO Buy groceries/, 'today: first TODO'),
    contains(j[TODAY_FILE], /TODO Call mom/, 'today: second TODO'),
    notContains(j[TODAY_FILE], /DONE Pay bills/, 'today: should not have DONE'),
    contains(j[YDAY_FILE], /DONE Pay bills/, 'yday: must keep DONE'),
    notContains(j[YDAY_FILE], /TODO Buy groceries/, 'yday: should not retain TODO'),

    // === All-DONE group stays put ===
    contains(j[YDAY_FILE], /DONE Already finished alpha/, 'yday: must keep all-DONE group'),
    contains(j[YDAY_FILE], /DONE Already finished beta/, 'yday: must keep all-DONE group'),
    notContains(j[TODAY_FILE], /Already finished/, 'today: should not have all-DONE group'),

    // === Title with DONE child duplicates ===
    contains(j[TODAY_FILE], /<ins>Project Mixed<\/ins>/, 'today: title with DONE child duplicates'),
    contains(j[YDAY_FILE], /<ins>Project Mixed<\/ins>/, 'yday: title with DONE child stays'),
    contains(j[TODAY_FILE], /TODO Write proposal/, 'today: TODO child of mixed title'),
    contains(j[YDAY_FILE], /DONE Email client/, 'yday: DONE child of mixed title stays'),
    notContains(j[TODAY_FILE], /DONE Email client/, 'today: DONE child should stay in source'),

    // === Title with only-TODO children migrates fully ===
    contains(j[TODAY_FILE], /<ins>Project AllTodos<\/ins>/, 'today: all-TODO title migrates'),
    contains(j[TODAY_FILE], /TODO Design/, 'today: all-TODO child 1'),
    contains(j[TODAY_FILE], /TODO Build/, 'today: all-TODO child 2'),
    notContains(j[YDAY_FILE], /<ins>Project AllTodos<\/ins>/, 'yday: all-TODO title should not stay'),

    // === Standalone TODO group ===
    contains(j[TODAY_FILE], /TODO Standalone task/, 'today: standalone TODO'),
    notContains(j[YDAY_FILE], /TODO Standalone task/, 'yday: standalone TODO should not remain'),
  ),
};
