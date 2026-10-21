/**
 * **P3.105 — denied paths are excluded from reads but not from SEARCH RESULTS.**
 *
 * `settings-reference.md`, section `#exclude-sensitive-files`, promises three
 * things of a deny on a sensitive path, verbatim: *"Claude Code excludes
 * matching files from file discovery and search results, denies reads of them,
 * and blocks the Edit and Write tools on the matching paths."* Our floor
 * delivered the last two, on the REQUEST. These pin the first, on the RESPONSE,
 * for the tools this package owns.
 *
 * Two failures are pinned as hard as the feature itself, because either one
 * would be worse than the gap:
 *
 * - **Withholding silently** — a shorter result set with no explanation teaches
 *   the reader the file does not exist. Every filtered set carries the notice,
 *   and a set whose every row was withheld returns the notice rather than the
 *   empty string that reads as "no matches".
 * - **Withholding the wrong thing** — the deny matches a PATH, and content can
 *   name a denied path without being one. `content mentioning a denied path` is
 *   the near miss, and it must come back intact.
 */

import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  LocalToolRuntime,
  deniedResultsWithheldNotice,
  type DeniedResultPathFilter,
  type LocalToolCall,
  type LocalToolOperation,
  type LocalToolRuntimeOptions,
} from '../index.ts';

async function makeWorkspace(): Promise<string> {
  return realpath(await mkdtemp(join(tmpdir(), 'nessy-p3105-')));
}

function testScope(primaryRoot: string) {
  return {
    session: { workspaceId: 'ws-p3105', sessionId: 'session-p3105' },
    primaryRoot,
    cwd: primaryRoot,
    additionalRoots: [],
    managedExclusions: [],
    generation: 'g-p3105',
  };
}

function makeRuntime(
  workspace: string,
  options: Partial<LocalToolRuntimeOptions> = {},
): LocalToolRuntime {
  return new LocalToolRuntime({
    filesystemScope: testScope(workspace),
    permissionManager: { evaluateToolCall: () => ({ allowed: true }) },
    guardLargeResults: false,
    ...options,
  });
}

function call(operation: LocalToolOperation): LocalToolCall {
  return {
    id: 'call-p3105',
    displayName: 'Search',
    operation,
    permission: { toolName: 'Search', input: {} },
  };
}

/** Denies exactly the named absolute paths, and records what it was asked. */
function denying(paths: string[], asked: string[][] = []): DeniedResultPathFilter {
  const denied = new Set(paths);
  return (candidates) => {
    asked.push([...candidates]);
    return candidates.filter(candidate => denied.has(candidate));
  };
}

describe('P3.105 search results honour the deniedPaths floor', () => {
  test('withholds the denied file\'s line, keeps the rest, and says so', async () => {
    const workspace = await makeWorkspace();
    const secret = join(workspace, 'src', '.env');
    const ordinary = join(workspace, 'src', 'app.ts');
    const runtime = makeRuntime(workspace, {
      filterDeniedResultPaths: denying([secret]),
      runCommand: async () => ({
        stdout: [
          `${ordinary}:4:const token = readToken()`,
          `${secret}:1:API_TOKEN=sk-live-4f2a`,
          `${ordinary}:9:log(token)`,
        ].join('\n'),
        stderr: '',
        exitCode: 0,
      }),
    });

    const grep = await runtime.execute(call({ kind: 'grep', pattern: 'token', path: 'src' }));

    expect(grep.content).toContain(`${ordinary}:4:const token = readToken()`);
    expect(grep.content).toContain(`${ordinary}:9:log(token)`);
    // The secret VALUE is the thing that leaked before this row.
    expect(grep.content).not.toContain('sk-live-4f2a');
    // Neither the path nor its basename is named — naming it would undo the
    // exclusion the contract asks for.
    expect(grep.content).not.toContain(secret);
    expect(grep.content).toContain(deniedResultsWithheldNotice(1));
  });

  test('a legitimate file whose CONTENT names a denied path is still returned', async () => {
    const workspace = await makeWorkspace();
    const secret = join(workspace, '.env');
    const doc = join(workspace, 'docs', 'setup.md');
    const runtime = makeRuntime(workspace, {
      filterDeniedResultPaths: denying([secret]),
      runCommand: async () => ({
        // The path field of the second row is `docs/setup.md`; its CONTENT
        // names the denied file. Matching the wrong field withholds this row.
        //
        // The FIRST row is what makes this test able to fail: it puts the
        // denied path into the answered deny set. Without it a content-matching
        // implementation still passes, because the set it would scan is empty —
        // measured, as mutant M2, which survived the earlier version of this
        // test for exactly that reason.
        stdout: [
          `${secret}:1:TOKEN=sk-live-6b1e`,
          `${doc}:12:copy ${secret} into place before running`,
        ].join('\n'),
        stderr: '',
        exitCode: 0,
      }),
    });

    const grep = await runtime.execute(call({ kind: 'grep', pattern: 'env', path: '.' }));

    expect(grep.content).toContain(`${doc}:12:copy ${secret} into place before running`);
    expect(grep.content).not.toContain('sk-live-6b1e');
    expect(grep.content).toContain(deniedResultsWithheldNotice(1));
  });

  test('withholds a denied file\'s CONTEXT lines and attributes a hyphenated filename correctly', async () => {
    const workspace = await makeWorkspace();
    const secret = join(workspace, '.env');
    // Two filenames that themselves contain `-<digits>-`, one denied and one
    // not, because reading the context form first misparses BOTH — it would
    // take the path as the workspace root, over-withholding the allowed file
    // and, far worse, LEAKING the denied one whose match line it never
    // attributes. Only a denied hyphenated file can catch the second.
    const hyphenated = join(workspace, 'report-12-final.ts');
    const hyphenatedSecret = join(workspace, 'deploy-24-prod.key');
    const runtime = makeRuntime(workspace, {
      filterDeniedResultPaths: denying([secret, hyphenatedSecret]),
      runCommand: async () => ({
        stdout: [
          `${hyphenated}-3-// preceding context`,
          `${hyphenated}:4:const key = 1`,
          '--',
          `${hyphenatedSecret}-1-# deploy key`,
          `${hyphenatedSecret}:2:PRIVATE=sk-live-7c3d`,
          '--',
          `${secret}-1-# generated`,
          `${secret}:2:KEY=sk-live-9a8b`,
        ].join('\n'),
        stderr: '',
        exitCode: 0,
      }),
    });

    const grep = await runtime.execute(call({ kind: 'grep', pattern: 'key', path: '.', context: 1 }));

    expect(grep.content).toContain(`${hyphenated}-3-// preceding context`);
    expect(grep.content).toContain(`${hyphenated}:4:const key = 1`);
    expect(grep.content).not.toContain('sk-live-9a8b');
    expect(grep.content).not.toContain('# generated');
    // The hyphenated DENIED file: misparsing its path leaks this value.
    expect(grep.content).not.toContain('sk-live-7c3d');
    expect(grep.content).not.toContain('# deploy key');
    expect(grep.content).toContain(deniedResultsWithheldNotice(2));
  });

  test('a fully withheld result set returns the notice, never a bare empty body', async () => {
    const workspace = await makeWorkspace();
    const secret = join(workspace, '.env');
    const runtime = makeRuntime(workspace, {
      filterDeniedResultPaths: denying([secret]),
      runCommand: async () => ({
        stdout: `${secret}:1:KEY=sk-live-0000\n`,
        stderr: '',
        exitCode: 0,
      }),
    });

    const grep = await runtime.execute(call({ kind: 'grep', pattern: 'KEY', path: '.' }));

    // "" would read as "no matches" — the exact lie this row is about.
    expect(grep.content).toBe(deniedResultsWithheldNotice(1));
    expect(grep.isError).toBeFalsy();
  });

  test('the count is of FILES, so it cannot leak how many lines of a secret matched', async () => {
    const workspace = await makeWorkspace();
    const secret = join(workspace, '.env');
    const runtime = makeRuntime(workspace, {
      filterDeniedResultPaths: denying([secret]),
      runCommand: async () => ({
        stdout: [
          `${secret}:1:A=1`,
          `${secret}:2:B=2`,
          `${secret}:3:C=3`,
        ].join('\n'),
        stderr: '',
        exitCode: 0,
      }),
    });

    const grep = await runtime.execute(call({ kind: 'grep', pattern: '=', path: '.' }));

    expect(grep.content).toBe(deniedResultsWithheldNotice(1));
    expect(grep.content).not.toContain('3 files');
  });

  test('the limit counts results the reader can see, not rows that were withheld', async () => {
    const workspace = await makeWorkspace();
    const secret = join(workspace, '.env');
    const visible = join(workspace, 'a.ts');
    const runtime = makeRuntime(workspace, {
      filterDeniedResultPaths: denying([secret]),
      runCommand: async () => ({
        stdout: [
          `${secret}:1:KEY=sk-live-1111`,
          `${secret}:2:KEY=sk-live-2222`,
          `${visible}:3:keyword`,
        ].join('\n'),
        stderr: '',
        exitCode: 0,
      }),
    });

    const grep = await runtime.execute(call({ kind: 'grep', pattern: 'key', path: '.', limit: 2 }));

    // Filtering before the limit is what makes this row survive; filtering
    // after would have spent both slots on the withheld rows.
    expect(grep.content).toContain(`${visible}:3:keyword`);
    expect(grep.content).toContain(deniedResultsWithheldNotice(1));
  });

  test('search_files is filtered on the same terms as grep', async () => {
    const workspace = await makeWorkspace();
    const secret = join(workspace, 'src', '.npmrc');
    const runtime = makeRuntime(workspace, {
      filterDeniedResultPaths: denying([secret]),
      runCommand: async () => ({
        stdout: `${secret}:1:_authToken=npm-secret-value\n`,
        stderr: '',
        exitCode: 0,
      }),
    });

    const searched = await runtime.execute(call({ kind: 'search_files', pattern: 'authToken', path: 'src' }));

    expect(searched.content).not.toContain('npm-secret-value');
    expect(searched.content).toBe(deniedResultsWithheldNotice(1));
  });

  test('find withholds a denied file from the discovery listing', async () => {
    const workspace = await makeWorkspace();
    const runtime = makeRuntime(workspace, {
      filterDeniedResultPaths: denying([join(workspace, 'deploy.key')]),
      runCommand: async () => ({
        stdout: [join(workspace, 'deploy.key'), join(workspace, 'notes.key')].join('\n'),
        stderr: '',
        exitCode: 0,
      }),
    });

    const found = await runtime.execute(call({ kind: 'find', pattern: '*.key' }));

    expect(found.content).toContain('notes.key');
    expect(found.content).not.toContain('deploy.key');
    expect(found.content).toContain(deniedResultsWithheldNotice(1));
  });

  test('ls withholds a denied entry and asks about the name without its display slash', async () => {
    const workspace = await makeWorkspace();
    await writeFile(join(workspace, '.env'), 'KEY=1', 'utf-8');
    await writeFile(join(workspace, 'index.ts'), 'x', 'utf-8');
    await mkdir(join(workspace, 'secrets'), { recursive: true });
    const asked: string[][] = [];
    const runtime = makeRuntime(workspace, {
      filterDeniedResultPaths: denying([join(workspace, '.env'), join(workspace, 'secrets')], asked),
    });

    const listed = await runtime.execute(call({ kind: 'ls' }));

    expect(listed.content).toContain('index.ts');
    expect(listed.content).not.toContain('.env');
    expect(listed.content).not.toContain('secrets');
    expect(listed.content).toContain(deniedResultsWithheldNotice(2));
    // The directory was asked about WITHOUT the trailing slash the listing adds
    // for display — with it, no deny pattern would ever have matched.
    expect(asked[0]).toContain(join(workspace, 'secrets'));
  });

  test('list_files withholds a denied file from a recursive walk', async () => {
    const workspace = await makeWorkspace();
    await mkdir(join(workspace, 'cfg'), { recursive: true });
    await writeFile(join(workspace, 'cfg', '.env.production'), 'KEY=1', 'utf-8');
    await writeFile(join(workspace, 'cfg', 'app.json'), '{}', 'utf-8');
    const runtime = makeRuntime(workspace, {
      filterDeniedResultPaths: denying([join(workspace, 'cfg/.env.production')]),
    });

    const listed = await runtime.execute(call({ kind: 'list_files', recursive: true }));

    expect(listed.content).toContain('cfg/app.json');
    expect(listed.content).not.toContain('.env.production');
    expect(listed.content).toContain(deniedResultsWithheldNotice(1));
  });

  test('the floor is asked ONCE per result set, with distinct absolute paths', async () => {
    const workspace = await makeWorkspace();
    const ordinary = join(workspace, 'a.ts');
    const asked: string[][] = [];
    const runtime = makeRuntime(workspace, {
      filterDeniedResultPaths: denying([], asked),
      runCommand: async () => ({
        // ripgrep prints the path RELATIVE when it was given a relative root;
        // the floor is asked about absolute paths either way.
        stdout: ['a.ts:1:one', 'a.ts:2:two', 'a.ts:3:three'].join('\n'),
        stderr: '',
        exitCode: 0,
      }),
    });

    await runtime.execute(call({ kind: 'grep', pattern: 'o', path: '.' }));

    expect(asked).toHaveLength(1);
    expect(asked[0]).toEqual([ordinary]);
  });

  test('a floor that denies nothing changes nothing, notice included', async () => {
    const workspace = await makeWorkspace();
    const stdout = ['a.ts:1:one', 'b.ts:2:two'].join('\n');
    const runtime = makeRuntime(workspace, {
      filterDeniedResultPaths: denying([]),
      runCommand: async () => ({ stdout, stderr: '', exitCode: 0 }),
    });

    const grep = await runtime.execute(call({ kind: 'grep', pattern: 'o', path: '.' }));

    expect(grep.content).toBe(stdout);
  });

  test('with no filter wired the tools behave exactly as before', async () => {
    const workspace = await makeWorkspace();
    await writeFile(join(workspace, '.env'), 'KEY=1', 'utf-8');
    const stdout = `${join(workspace, '.env')}:1:KEY=sk-live-3333`;
    const runtime = makeRuntime(workspace, {
      runCommand: async () => ({ stdout, stderr: '', exitCode: 0 }),
    });

    const grep = await runtime.execute(call({ kind: 'grep', pattern: 'KEY', path: '.' }));
    const listed = await runtime.execute(call({ kind: 'ls' }));

    // The honest status quo: unfiltered, and NOT quietly half-filtered.
    expect(grep.content).toBe(stdout);
    expect(grep.content).not.toContain('withheld');
    expect(listed.content).toBe('.env');
  });

  test('ripgrep\'s own stderr is never filtered or counted as a result', async () => {
    const workspace = await makeWorkspace();
    const runtime = makeRuntime(workspace, {
      filterDeniedResultPaths: denying([join(workspace, '.env')]),
      runCommand: async () => ({ stdout: '', stderr: 'regex parse error\n', exitCode: 2 }),
    });

    const grep = await runtime.execute(call({ kind: 'grep', pattern: '[', path: '.' }));

    expect(grep.content).toContain('regex parse error');
    expect(grep.content).not.toContain('withheld');
  });
});
