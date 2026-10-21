/**
 * P6.278 — the cut between the producer and the diff VIEWER.
 *
 * `computeReviewDiffWithGit({mode:'uncommitted'})` emits ONE patch for the whole
 * tree; `MultiDiffPreviewOverlay` renders one `FileChange` per file, each with
 * its own `unifiedDiff`. `splitUnifiedDiffByFile` is the only thing that was
 * between them, and it is here rather than in the renderer so this product
 * keeps exactly ONE parser of git's output — the same module whose
 * `summarizeUnifiedDiff` produces the seam's counts, so the summary and the
 * viewer can never describe different trees.
 *
 * The three headers a naive splitter gets wrong are the three fixtures: a
 * deletion (whose `+++` is `/dev/null`), an addition (whose `---` is), and a
 * rename. The fourth case is the one that decides where the cut goes at all: a
 * chunk has to carry its OWN `diff --git` / `index` / `---` / `+++` headers or
 * the viewer is handed a fragment beginning mid-header.
 */

import { describe, expect, it } from 'bun:test';
import { splitUnifiedDiffByFile, summarizeUnifiedDiff } from './diff-command.ts';

const MODIFY = `diff --git a/src/a.ts b/src/a.ts
index 1111111..2222222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,2 +1,3 @@
 const a = 1
+const b = 2
 export { a }
`;

const DELETE = `diff --git a/src/gone.ts b/src/gone.ts
deleted file mode 100644
index 3333333..0000000
--- a/src/gone.ts
+++ /dev/null
@@ -1,2 +0,0 @@
-export function gone() {}
-
`;

const ADD = `diff --git a/src/new.ts b/src/new.ts
new file mode 100644
index 0000000..4444444
--- /dev/null
+++ b/src/new.ts
@@ -0,0 +1,1 @@
+export const fresh = true
`;

const RENAME = `diff --git a/src/old-name.ts b/src/new-name.ts
similarity index 92%
rename from src/old-name.ts
rename to src/new-name.ts
index 5555555..6666666 100644
--- a/src/old-name.ts
+++ b/src/new-name.ts
@@ -1,1 +1,1 @@
-export const label = 'old'
+export const label = 'new'
`;

const TREE = MODIFY + DELETE + ADD + RENAME;

describe('splitUnifiedDiffByFile', () => {
  it('cuts one chunk per file and names each one', () => {
    const files = splitUnifiedDiffByFile(TREE);
    expect(files.map(file => file.path)).toEqual([
      'src/a.ts',
      'src/gone.ts',
      'src/new.ts',
      'src/new-name.ts',
    ]);
  });

  it('every chunk carries its OWN headers — the viewer parses each one alone', () => {
    // The failure this pins: cutting on `+++` instead of `diff --git` hands the
    // viewer a fragment whose first line is already inside the header block.
    for (const file of splitUnifiedDiffByFile(TREE)) {
      expect(file.unifiedDiff.startsWith('diff --git ')).toBe(true);
      expect(file.unifiedDiff).toContain('@@');
    }
  });

  it('a deletion is named from its OLD path, not from /dev/null', () => {
    const [deletion] = splitUnifiedDiffByFile(DELETE);
    expect(deletion!.path).toBe('src/gone.ts');
  });

  it('an addition is named from its NEW path', () => {
    const [addition] = splitUnifiedDiffByFile(ADD);
    expect(addition!.path).toBe('src/new.ts');
  });

  it('a rename is named from where the file ended up', () => {
    const [renamed] = splitUnifiedDiffByFile(RENAME);
    expect(renamed!.path).toBe('src/new-name.ts');
  });

  it('boundary — an empty or whitespace patch is no files, never one empty file', () => {
    expect(splitUnifiedDiffByFile('')).toEqual([]);
    expect(splitUnifiedDiffByFile('   \n  ')).toEqual([]);
  });

  it('boundary — a patch with no `diff --git` line is kept whole rather than dropped', () => {
    // `git diff --no-index` and some porcelain omit it. One entry is worse than
    // a per-file split and much better than a viewer that silently shows
    // nothing.
    const headerless = `--- a/src/x.ts\n+++ b/src/x.ts\n@@ -1 +1 @@\n-a\n+b\n`;
    const files = splitUnifiedDiffByFile(headerless);
    expect(files).toHaveLength(1);
    expect(files[0]!.path).toBe('src/x.ts');
    expect(files[0]!.unifiedDiff).toBe(headerless);
  });

  it('agrees with the summary the SEAM prints — same bytes, same parser', () => {
    // The whole reason the cut lives beside `summarizeUnifiedDiff`: the file
    // list a user sees in `/diff`'s text answer and the tabs they see in the
    // viewer are derived from one reading of one patch.
    expect(splitUnifiedDiffByFile(TREE).map(file => file.path))
      .toEqual(summarizeUnifiedDiff(TREE).map(file => file.path));
  });

  it('the per-file counts survive the cut', () => {
    // A chunk that lost a hunk header would still name its file and would count
    // wrong; this is the assertion that would catch it.
    const whole = summarizeUnifiedDiff(TREE);
    for (const file of splitUnifiedDiffByFile(TREE)) {
      const [alone] = summarizeUnifiedDiff(file.unifiedDiff);
      const inWhole = whole.find(entry => entry.path === file.path);
      expect(alone).toEqual(inWhole!);
    }
  });
});
