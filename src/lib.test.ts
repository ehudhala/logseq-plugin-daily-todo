import { describe, expect, it } from 'vitest';
import {
  blockContent,
  extractTodoState,
  getNextTodoState,
  isHighlighted,
  recursivelyCheckForRegexInBlock,
  splitBlocksIntoGroups,
  todoRegex,
  doneRegex,
  todoDoneRegex,
  highlightRegex,
  isUnderlineRegex,
  type MinimalBlock,
} from './lib';

const b = (content: string, children: MinimalBlock[] = []): MinimalBlock => ({
  content,
  children,
});

describe('regex constants', () => {
  it('todoRegex matches any TODO-like prefix only at start', () => {
    expect(todoRegex.test('TODO buy milk')).toBe(true);
    expect(todoRegex.test('DOING buy milk')).toBe(true);
    expect(todoRegex.test('NOW buy milk')).toBe(true);
    expect(todoRegex.test('LATER buy milk')).toBe(true);
    expect(todoRegex.test('  TODO buy milk')).toBe(false);
    expect(todoRegex.test('done TODO inline')).toBe(false);
    expect(todoRegex.test('DONE buy milk')).toBe(false);
  });

  it('doneRegex matches DONE prefix only at start', () => {
    expect(doneRegex.test('DONE pay bills')).toBe(true);
    expect(doneRegex.test('TODO pay bills')).toBe(false);
    expect(doneRegex.test('Already DONE')).toBe(false);
  });

  it('todoDoneRegex matches any TODO-like or DONE', () => {
    expect(todoDoneRegex.test('TODO x')).toBe(true);
    expect(todoDoneRegex.test('DOING x')).toBe(true);
    expect(todoDoneRegex.test('NOW x')).toBe(true);
    expect(todoDoneRegex.test('LATER x')).toBe(true);
    expect(todoDoneRegex.test('DONE x')).toBe(true);
    expect(todoDoneRegex.test('plain x')).toBe(false);
  });

  it('isUnderlineRegex matches <ins>...</ins>', () => {
    expect(isUnderlineRegex.test('<ins>Project A</ins>')).toBe(true);
    expect(isUnderlineRegex.test('Plain title')).toBe(false);
    expect(isUnderlineRegex.test('mixed <ins>Section</ins> rest')).toBe(true);
  });

  it('highlightRegex matches optional TODO-like/DONE prefix + ^^...^^', () => {
    expect(highlightRegex.test('^^just text^^')).toBe(true);
    expect(highlightRegex.test('TODO ^^a task^^')).toBe(true);
    expect(highlightRegex.test('DOING ^^a task^^')).toBe(true);
    expect(highlightRegex.test('NOW ^^a task^^')).toBe(true);
    expect(highlightRegex.test('LATER ^^a task^^')).toBe(true);
    expect(highlightRegex.test('DONE ^^a task^^')).toBe(true);
    expect(highlightRegex.test('plain text')).toBe(false);
  });

  it('highlightRegex captures todoState and stripped content', () => {
    const m = highlightRegex.exec('TODO ^^a task^^');
    expect(m?.[1]).toBe('TODO ');
    expect(m?.[2]).toBe('a task');

    const m2 = highlightRegex.exec('^^plain^^');
    expect(m2?.[1]).toBe('');
    expect(m2?.[2]).toBe('plain');

    const m3 = highlightRegex.exec('LATER ^^a task^^');
    expect(m3?.[1]).toBe('LATER ');
    expect(m3?.[2]).toBe('a task');
  });
});

describe('getNextTodoState', () => {
  describe('default (todo workflow)', () => {
    it('cycles blank → TODO → DONE → blank', () => {
      expect(getNextTodoState('')).toBe('TODO ');
      expect(getNextTodoState('TODO')).toBe('DONE ');
      expect(getNextTodoState('DONE')).toBe('');
    });

    it('treats DOING as TODO-like → DONE', () => {
      expect(getNextTodoState('DOING')).toBe('DONE ');
    });

    it('handles wrong-mode tasks: NOW/LATER in todo workflow → DONE', () => {
      // A user on todo-mode might still have NOW/LATER blocks if they
      // imported them or switched workflows. Cycling them to DONE keeps
      // the plugin useful instead of silently doing nothing.
      expect(getNextTodoState('NOW', 'todo')).toBe('DONE ');
      expect(getNextTodoState('LATER', 'todo')).toBe('DONE ');
    });

    it('returns empty string for unknown input (defensive)', () => {
      expect(getNextTodoState('UNKNOWN')).toBe('');
    });
  });

  describe('now workflow', () => {
    it('cycles blank → LATER → DONE → blank', () => {
      expect(getNextTodoState('', 'now')).toBe('LATER ');
      expect(getNextTodoState('LATER', 'now')).toBe('DONE ');
      expect(getNextTodoState('DONE', 'now')).toBe('');
    });

    it('treats NOW as TODO-like → DONE', () => {
      expect(getNextTodoState('NOW', 'now')).toBe('DONE ');
    });

    it('handles wrong-mode tasks: TODO/DOING in now workflow → DONE', () => {
      // Symmetric: a user on now-mode might still have TODO/DOING blocks.
      // (This was the bug in the original PR — TODO in now-mode returned
      // undefined, so pressing mod+1 corrupted the block content.)
      expect(getNextTodoState('TODO', 'now')).toBe('DONE ');
      expect(getNextTodoState('DOING', 'now')).toBe('DONE ');
    });
  });
});

describe('blockContent', () => {
  it('reads .content when only .content is set', () => {
    expect(blockContent({ content: 'plain' })).toBe('plain');
  });

  it('prefers .title over .content (modern SDK)', () => {
    expect(blockContent({ content: 'old', title: 'new' })).toBe('new');
  });

  it('reads .title when only .title is set', () => {
    expect(blockContent({ title: 'new only' })).toBe('new only');
  });

  it('returns empty string for null/undefined/empty', () => {
    expect(blockContent(null)).toBe('');
    expect(blockContent(undefined)).toBe('');
    expect(blockContent({})).toBe('');
    expect(blockContent({ content: '' })).toBe('');
  });

  it('falls back to .content when .title is the legacy 0.0.9 Array shape', () => {
    // BlockEntity in @logseq/libs 0.0.9 declared title?: Array<any>
    // (parsed AST). Modern versions canonicalize title to a string.
    // The helper treats non-string title as "not present" so the legacy
    // .content path still works.
    expect(blockContent({ title: ['parsed', 'ast'] as any, content: 'real content' }))
      .toBe('real content');
    expect(blockContent({ title: [] as any, content: 'real content' }))
      .toBe('real content');
  });
});

describe('isHighlighted', () => {
  it('returns true for ^^...^^ blocks', () => {
    expect(isHighlighted(b('^^buy milk^^'))).toBe(true);
    expect(isHighlighted(b('TODO ^^buy milk^^'))).toBe(true);
    expect(isHighlighted(b('DONE ^^pay bills^^'))).toBe(true);
  });

  it('returns false for non-highlighted', () => {
    expect(isHighlighted(b('TODO buy milk'))).toBe(false);
    expect(isHighlighted(b('plain text'))).toBe(false);
    expect(isHighlighted(b(''))).toBe(false);
  });
});

describe('extractTodoState', () => {
  it('returns TODO for TODO blocks', () => {
    expect(extractTodoState(b('TODO buy milk'))).toBe('TODO');
  });

  it('returns DONE for DONE blocks', () => {
    expect(extractTodoState(b('DONE pay bills'))).toBe('DONE');
  });

  it('returns empty for plain blocks', () => {
    expect(extractTodoState(b('plain text'))).toBe('');
    expect(extractTodoState(b(''))).toBe('');
    expect(extractTodoState(b('  TODO indented'))).toBe('');
  });
});

describe('recursivelyCheckForRegexInBlock', () => {
  it('matches a regex in the top-level block', () => {
    expect(recursivelyCheckForRegexInBlock(b('TODO foo'), todoRegex)).toBe(true);
  });

  it('matches a regex in a child block', () => {
    const tree = b('plain', [b('TODO child')]);
    expect(recursivelyCheckForRegexInBlock(tree, todoRegex)).toBe(true);
  });

  it('matches a regex deep in the tree', () => {
    const tree = b('plain', [b('also plain', [b('TODO grandchild')])]);
    expect(recursivelyCheckForRegexInBlock(tree, todoRegex)).toBe(true);
  });

  it('returns false when no match anywhere', () => {
    const tree = b('plain', [b('also plain', [b('still plain')])]);
    expect(recursivelyCheckForRegexInBlock(tree, todoRegex)).toBe(false);
  });

  it('returns false on empty children', () => {
    expect(recursivelyCheckForRegexInBlock(b('plain'), todoRegex)).toBe(false);
  });

  it('handles missing children field', () => {
    expect(recursivelyCheckForRegexInBlock({ content: 'TODO x' }, todoRegex)).toBe(true);
    expect(recursivelyCheckForRegexInBlock({ content: 'plain' }, todoRegex)).toBe(false);
  });
});

describe('splitBlocksIntoGroups', () => {
  it('returns single group for non-empty blocks', () => {
    const blocks = [b('one'), b('two'), b('three')];
    expect(splitBlocksIntoGroups(blocks)).toEqual([blocks]);
  });

  it('splits on empty separator', () => {
    const blocks = [b('one'), b('two'), b(''), b('three')];
    const groups = splitBlocksIntoGroups(blocks);
    expect(groups).toHaveLength(2);
    expect(groups[0]).toEqual([b('one'), b('two')]);
    expect(groups[1]).toEqual([b('three')]);
  });

  it('produces empty leading group on empty-first block', () => {
    const blocks = [b(''), b('one')];
    const groups = splitBlocksIntoGroups(blocks);
    expect(groups).toHaveLength(2);
    expect(groups[0]).toEqual([]);
    expect(groups[1]).toEqual([b('one')]);
  });

  it('produces consecutive empty groups for adjacent empties', () => {
    const blocks = [b('a'), b(''), b(''), b('b')];
    const groups = splitBlocksIntoGroups(blocks);
    expect(groups).toHaveLength(3);
    expect(groups[0]).toEqual([b('a')]);
    expect(groups[1]).toEqual([]);
    expect(groups[2]).toEqual([b('b')]);
  });

  it('handles empty input', () => {
    expect(splitBlocksIntoGroups([])).toEqual([[]]);
  });

  it('preserves block identity (no copies)', () => {
    const block1 = b('one');
    const block2 = b('two');
    const groups = splitBlocksIntoGroups([block1, block2]);
    expect(groups[0][0]).toBe(block1);
    expect(groups[0][1]).toBe(block2);
  });
});
