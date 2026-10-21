/**
 * P6.767 — the two reads that return nothing, and what the model is told about
 * each.
 *
 * `tools-reference.md#read-tool-behavior` (anchor verified against the RENDERED
 * page 2026-09-08: `curl https://code.claude.com/docs/en/tools-reference |
 * grep -o 'id="read-tool-behavior"'` → one hit), verbatim: *"Reading an empty
 * file returns a notice that the file exists but its contents are empty, and an
 * `offset` past the last line returns a notice giving the file's line count.
 * Before v2.1.208, reading an empty file returned the past-the-end notice
 * instead."*
 *
 * Before this landed both returned the empty string, and — the part that made
 * the row a safety row rather than a wording row — both RECORDED the path in
 * `filesSeenThisSession`, so a read that saw none of a file's lines satisfied
 * the read-before-write gate of `#edit-tool-behavior`.
 *
 * The two notices are therefore asserted from both ends: the text the model
 * gets, and what the read is worth to a later write. The gate verdicts differ
 * on purpose (an empty read saw the whole of the file's contents; a
 * past-the-end read saw none of them) and each is pinned here, so a change to
 * either is a deliberate one.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { LocalToolRuntime, type LocalToolCall, type LocalToolRuntimeOptions } from '../index.ts';

async function makeWorkspace(): Promise<string> {
  return realpath(await mkdtemp(join(tmpdir(), 'nessy-read-notices-')));
}

function makeRuntime(workspaceRootPath: string): LocalToolRuntime {
  return new LocalToolRuntime({
    filesystemScope: {
      session: { workspaceId: 'ws-test', sessionId: 'session-test' },
      primaryRoot: workspaceRootPath,
      cwd: workspaceRootPath,
      additionalRoots: [],
      managedExclusions: [],
      generation: 'g-test',
    },
    permissionManager: { evaluateToolCall: () => ({ allowed: true }) },
    guardLargeResults: false,
  } as LocalToolRuntimeOptions);
}

function readCall(path: string, offset?: number, limit?: number): LocalToolCall {
  return {
    id: 'call-read',
    displayName: 'Read',
    operation: {
      kind: 'read_file',
      path,
      ...(offset === undefined ? {} : { offset }),
      ...(limit === undefined ? {} : { limit }),
    },
    permission: { toolName: 'Read', input: { file_path: path } },
  };
}

function writeCall(path: string, content: string): LocalToolCall {
  return {
    id: 'call-write',
    displayName: 'Write',
    operation: { kind: 'write_file', path, content },
    permission: { toolName: 'Write', input: { file_path: path } },
  };
}

describe('P6.767 — reading an empty file', () => {
  test('returns the notice the page specifies, not an empty result', async () => {
    const workspace = await makeWorkspace();
    await writeFile(join(workspace, 'empty.txt'), '', 'utf-8');
    const runtime = makeRuntime(workspace);

    const read = await runtime.execute(readCall('empty.txt'));

    expect(read.isError).toBeFalsy();
    // "a notice that the file exists but its contents are empty" — both facts,
    // and the path, because a bare "empty" tells a model nothing about WHICH
    // read it is answering.
    expect(read.content).toContain('empty.txt');
    expect(read.content).toContain('exists');
    expect(read.content).toContain('empty');
    expect(read.content?.trim()).not.toBe('');
  });

  test('a file with content is unaffected — the notice is not a truncation', async () => {
    // The control that keeps the empty branch from swallowing ordinary reads:
    // one byte is not nothing, and a one-line file has no trailing newline to
    // make its content look absent.
    const workspace = await makeWorkspace();
    await writeFile(join(workspace, 'tiny.txt'), 'x', 'utf-8');
    const runtime = makeRuntime(workspace);

    const read = await runtime.execute(readCall('tiny.txt'));

    expect(read.isError).toBeFalsy();
    expect(read.content).toBe('x');
    expect(read.content).not.toContain('contents are empty');
  });

  test('DECISION: an empty read counts as a read for the write gate', async () => {
    // Decided here, and stated because the page does not settle it. The page's
    // only disqualifier is `#edit-tool-behavior`'s *"a read cut short with a
    // `PARTIAL view` notice doesn't count"*, which this is not: the read
    // returned the WHOLE of the file's contents. The gate's own refusal names
    // the harm it prevents — an overwrite destroying "content the conversation
    // never saw" — and an empty file has none, which is also why the gate
    // already exempts a file that does not exist at all.
    const workspace = await makeWorkspace();
    await writeFile(join(workspace, 'empty.txt'), '', 'utf-8');
    const runtime = makeRuntime(workspace);

    await runtime.execute(readCall('empty.txt'));
    const written = await runtime.execute(writeCall('empty.txt', 'now it has content'));

    expect(written.isError).toBeFalsy();
    expect(await readFile(join(workspace, 'empty.txt'), 'utf-8')).toBe('now it has content');
  });
});

describe('P6.767 — an offset past the last line', () => {
  const threeLines = 'alpha\nbeta\ngamma';

  test('returns a notice giving the file\'s line count, not an empty result', async () => {
    const workspace = await makeWorkspace();
    await writeFile(join(workspace, 'three.txt'), threeLines, 'utf-8');
    const runtime = makeRuntime(workspace);

    const read = await runtime.execute(readCall('three.txt', 9));

    expect(read.isError).toBeFalsy();
    expect(read.content).toContain('three.txt');
    // "a notice giving the file's line count" — the count is the point, so it
    // is asserted as a number and not as the presence of prose.
    expect(read.content).toContain('3 lines');
    expect(read.content).toContain('9');
    expect(read.content?.trim()).not.toBe('');
  });

  test('the count is the file\'s lines, not its newline-separated segments', async () => {
    // The boundary a trailing newline creates: `"a\\nb\\nc\\n".split("\\n")` has
    // four members and the file has three lines. A notice whose whole job is to
    // give the line count may not be off by one on the commonest file shape
    // there is.
    const workspace = await makeWorkspace();
    await writeFile(join(workspace, 'trailing.txt'), `${threeLines}\n`, 'utf-8');
    const runtime = makeRuntime(workspace);

    const read = await runtime.execute(readCall('trailing.txt', 4));

    expect(read.content).toContain('3 lines');
    expect(read.content).not.toContain('4 lines');
  });

  test('an offset ON the last line is a normal read, not a notice', async () => {
    // The off-by-one boundary in the other direction: line 3 of a 3-line file
    // exists, and a notice there would hide it.
    const workspace = await makeWorkspace();
    await writeFile(join(workspace, 'three.txt'), threeLines, 'utf-8');
    const runtime = makeRuntime(workspace);

    const read = await runtime.execute(readCall('three.txt', 3));

    expect(read.isError).toBeFalsy();
    expect(read.content).toBe('gamma');
    expect(read.content).not.toContain('lines');
  });

  test('the past-the-end read does NOT satisfy a later write', async () => {
    // The safety half, and the reason this row is not a wording row: the reader
    // saw none of the three lines, so a write that follows it would destroy
    // content the conversation never saw — exactly what the gate exists for.
    const workspace = await makeWorkspace();
    await writeFile(join(workspace, 'three.txt'), threeLines, 'utf-8');
    const runtime = makeRuntime(workspace);

    const read = await runtime.execute(readCall('three.txt', 9));
    expect(read.isError).toBeFalsy();

    const written = await runtime.execute(writeCall('three.txt', 'clobbered'));

    expect(written.isError).toBe(true);
    expect(written.error).toContain('has not been read in this session');
    expect(await readFile(join(workspace, 'three.txt'), 'utf-8')).toBe(threeLines);
  });

  test('a read INSIDE the file still satisfies a later write', async () => {
    // Non-vacuity: without this, a gate that had simply stopped recording
    // windowed reads would pass every assertion above.
    const workspace = await makeWorkspace();
    await writeFile(join(workspace, 'three.txt'), threeLines, 'utf-8');
    const runtime = makeRuntime(workspace);

    await runtime.execute(readCall('three.txt', 2, 2));
    const written = await runtime.execute(writeCall('three.txt', 'rewritten'));

    expect(written.isError).toBeFalsy();
    expect(await readFile(join(workspace, 'three.txt'), 'utf-8')).toBe('rewritten');
  });
});
