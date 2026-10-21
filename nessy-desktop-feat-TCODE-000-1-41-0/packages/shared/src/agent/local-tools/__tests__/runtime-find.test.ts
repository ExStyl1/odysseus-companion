import { describe, expect, test } from 'bun:test';
import { mkdtemp, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { LocalToolRuntime, type LocalToolCall } from '../index.ts';

/**
 * F1.859 — Pi's Find (our `find`) with `**` + `/` omitted files at the search
 * root: the glob-to-regex filter turned the leading `**` + `/` into `.*.*` + `/`,
 * which needs a `/` in the path, so a root `README.md` never matched, and an
 * inner one (`src/` + `**` + `/*.ts`) missed the direct children of `src`.
 *
 * Upstream parity, measured 2026-09-26: Pi 0.85.1's own find
 * (`@earendil-works/pi-coding-agent` `dist/core/tools/find.js`) runs
 * `fd --glob --full-path` against the absolute path, and Pi's fd 10.4.2 over
 * THIS fixture tree answered exactly the lists pinned below — `**` + `/`
 * matches zero or more directories.
 *
 * `rg --files` is replaced by a fixed listing, so the test pins the filter,
 * not the host's ripgrep.
 */

const TREE = [
  'README.md',
  'docs/a.md',
  'docs/deep/b.md',
  'lib/y.ts',
  'src/lib/x.ts',
  'src/root.ts',
  'top.ts',
];

async function makeRuntime(tree: readonly string[] = TREE): Promise<LocalToolRuntime> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'nessy-f1859-find-')));
  return new LocalToolRuntime({
    filesystemScope: {
      session: { workspaceId: 'ws-test', sessionId: 'session-test' },
      primaryRoot: root,
      cwd: root,
      additionalRoots: [],
      managedExclusions: [],
      generation: 'g-test',
    },
    permissionManager: { evaluateToolCall: () => ({ allowed: true }) },
    // Lists the files under the searched directory (the command's last quoted
    // argument), as `rg --files <dir>` does.
    runCommand: async command => {
      const searched = /'([^']*)'$/.exec(command)?.[1] ?? root;
      return {
        stdout: tree.map(entry => join(root, entry)).filter(path => path.startsWith(`${searched}/`)).join('\n'),
        stderr: '',
        exitCode: 0,
      };
    },
  });
}

function findCall(pattern: string, path?: string): LocalToolCall {
  return {
    id: 'find-call-1',
    displayName: 'find',
    operation: { kind: 'find', pattern, ...(path ? { path } : {}) },
    permission: { toolName: 'Find', input: { pattern, ...(path ? { path } : {}) } },
  };
}

async function find(pattern: string, options: { tree?: readonly string[]; path?: string } = {}): Promise<string[]> {
  const result = await (await makeRuntime(options.tree)).execute(findCall(pattern, options.path));
  expect(result.isError).not.toBe(true);
  return result.content.split('\n').filter(line => line.length > 0);
}

describe('find glob: a double-star segment matches zero or more directories', () => {
  // POSITIVE: the SIT-y reproduction. Root files are found, as upstream Pi finds them.
  test('a leading double-star segment finds files at the search root too', async () => {
    expect(await find('**/*.md')).toEqual(['README.md', 'docs/a.md', 'docs/deep/b.md']);
  });

  // POSITIVE + CONTROL: an inner double-star segment reaches the directory's own
  // children, and the literal prefix still excludes everything outside it.
  test('an inner double-star segment finds direct children and still excludes files outside its prefix', async () => {
    const found = await find('src/**/*.ts');
    expect(found).toEqual(['src/lib/x.ts', 'src/root.ts']);
    expect(found).not.toContain('lib/y.ts');
    expect(found).not.toContain('top.ts');
    expect(await find('docs/**/*.md')).not.toContain('README.md');
  });
});

/**
 * F1.995 — the rest of upstream fd's glob dialect. Pi 0.85.1's find runs
 * `fd --glob` (globset, separator-literal), and when the pattern holds a `/` it
 * adds `--full-path` and a leading `**` + `/`, so the pattern matches the
 * ABSOLUTE path at any depth. Every list below is what Pi's own fd 10.4.2
 * answered over THIS tree on 2026-09-26 (directories dropped, as `rg --files`
 * lists files only).
 */
const FD_TREE = [
  'README.md',
  'a.ts',
  'ab.ts',
  'b.ts',
  'br[a].ts',
  'c.ts',
  'lib/y.ts',
  'packages/x/src/a.ts',
  'packages/x/src/lib/z.ts',
  'src/a/b/deep.ts',
  'src/lib/x.ts',
  'src/root.ts',
  'src/root.tsx',
  'top.tsx',
];

const fdFind = (pattern: string, path?: string) => find(pattern, { tree: FD_TREE, path });

describe('find glob: the fd dialect upstream Pi uses', () => {
  // POSITIVE + NEGATIVE: a single star and a question mark stay inside one path segment.
  test('a single star and a question mark do not cross a slash', async () => {
    const found = await fdFind('src/*.ts');
    expect(found).toEqual(['packages/x/src/a.ts', 'src/root.ts']);
    expect(found).not.toContain('src/lib/x.ts');
    expect(found).not.toContain('src/a/b/deep.ts');
    expect(await fdFind('?.ts')).toEqual([
      'a.ts', 'b.ts', 'c.ts', 'lib/y.ts', 'packages/x/src/a.ts', 'packages/x/src/lib/z.ts', 'src/lib/x.ts',
    ]);
    expect(await fdFind('src/lib?x.ts')).toEqual([]);
    expect(await fdFind('src?root.ts')).toEqual([]);
  });

  // POSITIVE: alternation and character classes (negated with ! or ^), and a backslash escape.
  test('braces alternate and brackets are character classes', async () => {
    expect(await fdFind('src/*.{ts,tsx}')).toEqual(['packages/x/src/a.ts', 'src/root.ts', 'src/root.tsx']);
    expect(await fdFind('**/*.{ts,tsx}')).toEqual(FD_TREE.filter(entry => /\.tsx?$/.test(entry)));
    expect(await fdFind('[ab].ts')).toEqual(['a.ts', 'b.ts', 'packages/x/src/a.ts']);
    expect(await fdFind('[!ab].ts')).toEqual(['c.ts', 'lib/y.ts', 'packages/x/src/lib/z.ts', 'src/lib/x.ts']);
    expect(await fdFind('br\\[a\\].ts')).toEqual(['br[a].ts']);
  });

  // NEGATIVE: a malformed group ends the call with fd's reason instead of an empty list.
  test('an unclosed bracket or brace, or an unopened brace, is an error that names the problem', async () => {
    const runtime = await makeRuntime(FD_TREE);
    for (const [pattern, reason] of [
      ['[ab.ts', 'unclosed character class'],
      ['{a,b.ts', 'unclosed alternate group'],
      ['*}.ts', 'unopened alternate group'],
    ] as const) {
      const result = await runtime.execute(findCall(pattern));
      expect(result.isError).toBe(true);
      expect(result.content).toContain(reason);
      expect(result.content).toContain(pattern);
    }
  });

  // POSITIVE: a path pattern matches at any depth, not only from the search root.
  test('a pattern with a slash matches at any depth below the search root', async () => {
    expect(await fdFind('lib/*.ts')).toEqual(['lib/y.ts', 'packages/x/src/lib/z.ts', 'src/lib/x.ts']);
    expect(await fdFind('src/**/*.ts')).toEqual([
      'packages/x/src/a.ts', 'packages/x/src/lib/z.ts', 'src/a/b/deep.ts', 'src/lib/x.ts', 'src/root.ts',
    ]);
  });

  // BOUNDARY: the absolute path is what matches, so a pattern naming the searched
  // directory itself finds its files, and a pattern without a slash matches the basename only.
  test('with path src, src/*.ts lists its direct children and *.ts matches every basename', async () => {
    expect(await fdFind('src/*.ts', 'src')).toEqual(['root.ts']);
    expect(await fdFind('*.ts', 'src')).toEqual(['a/b/deep.ts', 'lib/x.ts', 'root.ts']);
  });
});

/**
 * F1.1044 — fd's smart case and its whole-name match, the two residues F1.995
 * kept. Pi 0.85.1's find passes no case flag, so fd 10.4.2 is smart-case: the
 * match ignores ASCII case unless the pattern holds an upper-case letter (fd
 * asks the compiled regex: a literal, or the first or last character of a
 * class range after negation). globset's regex is bytes-mode, so only ASCII
 * letters fold and `?` is one BYTE. A pattern with no glob character must
 * equal the whole basename. Every list below is what Pi's own fd answered over
 * THIS tree on 2026-09-28.
 */
const CASE_TREE = [
  '@x.md', 'NOTES.MD', 'Notes2.md', 'README.md', 'Z.ts', '[y.md', 'a.ts', 'docs/guide.md', 'lib/root.tsx',
  'packages/Docs/Guide.md', 'pkg/Src/Main.ts', 'pkg/Src/other.ts', 'readme.txt', 'root.ts', 'src/Root2.ts',
  'src/root.ts', 'z2.ts', 'Éclair.txt', 'é.txt', 'Отчет.txt', 'отчет2.txt', 'я.txt',
];

const caseFind = (pattern: string) => find(pattern, { tree: CASE_TREE });

describe('find glob: fd smart case and whole-name matching', () => {
  // POSITIVE: all lower case ignores case; one upper-case letter makes the whole pattern exact.
  test('a lower-case pattern ignores case and an upper-case letter makes it case-sensitive', async () => {
    expect(await caseFind('readme*')).toEqual(['README.md', 'readme.txt']);
    expect(await caseFind('README*')).toEqual(['README.md']);
    expect(await caseFind('Readme*')).toEqual([]);
    expect(await caseFind('*.MD')).toEqual(['NOTES.MD']);
    expect(await caseFind('docs/*.md')).toEqual(['docs/guide.md', 'packages/Docs/Guide.md']);
    expect(await caseFind('Docs/*.md')).toEqual(['packages/Docs/Guide.md']);
    expect(await caseFind('{readme,notes}*')).toEqual(['NOTES.MD', 'Notes2.md', 'README.md', 'readme.txt']);
  });

  // BOUNDARY: a class decides by its range ends after negation, and folds before it negates.
  test('a class counts as upper case only by its range ends, and folds before it negates', async () => {
    expect(await caseFind('[!A-Z]*.md')).toEqual(['@x.md', '[y.md']);
    expect(await caseFind('[@A-Z[]*.md')).toEqual([
      '@x.md', 'NOTES.MD', 'Notes2.md', 'README.md', '[y.md', 'docs/guide.md', 'packages/Docs/Guide.md',
    ]);
    expect(await caseFind('[!Z]*.ts')).toContain('z2.ts');
    expect(await caseFind('[!z]*.ts')).not.toContain('z2.ts');
  });

  // NEGATIVE: only ASCII letters fold, and a non-ASCII character is several bytes.
  test('only ASCII letters fold, and a question mark matches one byte', async () => {
    expect(await caseFind('отчет*')).toEqual(['отчет2.txt']);
    expect(await caseFind('Отчет*')).toEqual(['Отчет.txt']);
    expect(await caseFind('é*')).toEqual(['é.txt']);
    expect(await caseFind('?.txt')).toEqual([]);
    expect(await caseFind('??.txt')).toEqual(['é.txt', 'я.txt']);
  });

  // POSITIVE + NEGATIVE: a pattern with no glob character is the whole basename, not a substring.
  test('a plain pattern must equal the whole file name', async () => {
    expect(await caseFind('root')).toEqual([]);
    expect(await caseFind('README')).toEqual([]);
    expect(await caseFind('root.ts')).toEqual(['root.ts', 'src/root.ts']);
    expect(await caseFind('readme.md')).toEqual(['README.md']);
    expect(await caseFind('root2.ts')).toEqual(['src/Root2.ts']);
    expect(await caseFind('src/root.ts')).toEqual(['src/root.ts']);
    // fd treats an empty pattern as "match everything" rather than a glob.
    expect(await caseFind('')).toEqual(CASE_TREE);
  });
});
