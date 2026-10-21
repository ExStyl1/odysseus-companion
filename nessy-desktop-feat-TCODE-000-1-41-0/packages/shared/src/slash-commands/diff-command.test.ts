/**
 * P6.278 — `/diff` summarizes the working tree, and states the per-turn half it
 * cannot show rather than showing an empty one.
 *
 * The row's two controls are the two negatives here: a clean tree offers no
 * change list, and a runtime with no per-turn snapshot says the reason instead
 * of rendering nothing.
 */
import { describe, expect, it } from 'bun:test';
import {
  PER_TURN_AVAILABLE_LINE,
  PER_TURN_UNAVAILABLE_LINE,
  WORKING_TREE_CLEAN_LINE,
  WORKING_TREE_UNAVAILABLE_LINE,
  formatWorkingTreeDiffReport,
  summarizeUnifiedDiff,
} from './diff-command.ts';
import { parseSessionCommand } from './session-command.ts';

/** A real `git diff HEAD` shape: one edit, one addition, one deletion. */
const PATCH = [
  'diff --git a/src/edited.ts b/src/edited.ts',
  'index 1111111..2222222 100644',
  '--- a/src/edited.ts',
  '+++ b/src/edited.ts',
  '@@ -1,3 +1,3 @@',
  ' const keep = 1',
  '-const gone = 2',
  '+const added = 2',
  '+const alsoAdded = 3',
  'diff --git a/src/gone.ts b/src/gone.ts',
  'deleted file mode 100644',
  '--- a/src/gone.ts',
  '+++ /dev/null',
  '@@ -1,2 +0,0 @@',
  '-first',
  '-second',
  'diff --git a/new.txt b/new.txt',
  'new file mode 100644',
  '--- /dev/null',
  '+++ b/new.txt',
  '@@ -0,0 +1,1 @@',
  '+brand new',
].join('\n');

describe('summarizeUnifiedDiff', () => {
  it('counts content lines per file and never the +++/--- headers', () => {
    // The bug every naive version of this has: `+++ b/x` starts with `+`, so a
    // parser that counts before consuming the header reports one phantom
    // addition and one phantom deletion on EVERY file.
    expect(summarizeUnifiedDiff(PATCH)).toEqual([
      { path: 'src/edited.ts', added: 2, removed: 1 },
      { path: 'src/gone.ts', removed: 2, added: 0 },
      { path: 'new.txt', added: 1, removed: 0 },
    ]);
  });

  it('names a deleted file from its OLD path, not "/dev/null"', () => {
    // The `+++` side of a deletion is `/dev/null`; taking it literally would
    // report every deletion under the same meaningless name.
    const deleted = summarizeUnifiedDiff(PATCH).find(file => file.removed === 2);
    expect(deleted?.path).toBe('src/gone.ts');
  });

  it('reports nothing at all for an empty patch', () => {
    expect(summarizeUnifiedDiff('')).toEqual([]);
  });
});

describe('formatWorkingTreeDiffReport', () => {
  it('lists the files with their counts and a total', () => {
    const report = formatWorkingTreeDiffReport(PATCH, { perTurnSnapshots: false });

    expect(report).toContain('3 files, +3 −3');
    expect(report).toContain('src/edited.ts');
    expect(report).toContain('+2 −1');
    expect(report).toContain('new.txt');
  });

  it('offers NO change list for a clean tree, and says so', () => {
    // done_means control: "a turn that edited nothing offers no entry".
    const report = formatWorkingTreeDiffReport('', { perTurnSnapshots: false });

    expect(report).toContain(WORKING_TREE_CLEAN_LINE);
    expect(report).not.toContain('Uncommitted changes');
  });

  it('separates "git could not answer" from "nothing changed"', () => {
    // A null patch is a directory git cannot read; an empty string is a clean
    // tree. Conflating them would report a non-repository as pristine.
    expect(formatWorkingTreeDiffReport(null, { perTurnSnapshots: false }))
      .toContain(WORKING_TREE_UNAVAILABLE_LINE);
    expect(formatWorkingTreeDiffReport(null, { perTurnSnapshots: false }))
      .not.toContain(WORKING_TREE_CLEAN_LINE);
  });

  it('states the per-turn reason on a runtime that snapshots nothing, in EVERY branch', () => {
    // The row's other control, and it has to hold on the empty and the
    // unreadable branch too — those are exactly where a user would otherwise
    // read the silence as "there were no edits".
    for (const patch of [PATCH, '', null]) {
      expect(formatWorkingTreeDiffReport(patch, { perTurnSnapshots: false }))
        .toContain(PER_TURN_UNAVAILABLE_LINE);
    }
    expect(formatWorkingTreeDiffReport(PATCH, { perTurnSnapshots: true }))
      .toContain(PER_TURN_AVAILABLE_LINE);
    // The two sentences are different claims and must never both appear.
    expect(formatWorkingTreeDiffReport(PATCH, { perTurnSnapshots: true }))
      .not.toContain(PER_TURN_UNAVAILABLE_LINE);
  });
});

describe('parseSessionCommand — the /diff half', () => {
  it('claims the whole message and nothing else', () => {
    expect(parseSessionCommand('/diff')?.kind).toBe('diff');
    expect(parseSessionCommand('  /DIFF  ')?.kind).toBe('diff');
    expect(parseSessionCommand('/diff the last turn')).toBeNull();
    expect(parseSessionCommand('run /diff for me')).toBeNull();
    // The two kinds stay distinct through one table.
    expect(parseSessionCommand('/mcp')?.kind).toBe('mcp');
    // `/help` is a session command too now, and a DIFFERENT kind — which is the
    // property the old assertion was really about: one table, distinct kinds.
    expect(parseSessionCommand('/help')?.kind).toBe('help');
  });
});
