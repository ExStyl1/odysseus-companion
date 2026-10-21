/**
 * P6.558 — the safety half of the Pi read notice: a mutation of an existing file
 * this session has not seen is refused.
 *
 * `tools-reference.md#edit-tool-behavior`, verbatim: *"**Read-before-edit**:
 * Claude reads the file in the current conversation before editing it, and a
 * read cut short with a `PARTIAL view` notice doesn't count."* And
 * `#write-tool-behavior` on the same rule for overwrites: *"This constraint
 * doesn't apply to new files."*
 *
 * The suite is built as a POSITIVE plus four boundaries, because the two ways
 * this gate can be wrong are opposite and only one of them is loud. A gate that
 * never fires is a safety feature that does nothing; a gate that fires on a new
 * file, on the agent's own output, or after a windowed read is a fork-only
 * refusal of something the page allows. Both are asserted.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { LocalToolRuntime, type LocalToolCall, type LocalToolRuntimeOptions } from '../index.ts';

async function makeWorkspace(): Promise<string> {
  return realpath(await mkdtemp(join(tmpdir(), 'nessy-read-before-write-')));
}

function testScope(primaryRoot: string) {
  return {
    session: { workspaceId: 'ws-test', sessionId: 'session-test' },
    primaryRoot,
    cwd: primaryRoot,
    additionalRoots: [],
    managedExclusions: [],
    generation: 'g-test',
  };
}

function makeRuntime(workspaceRootPath: string): LocalToolRuntime {
  return new LocalToolRuntime({
    filesystemScope: testScope(workspaceRootPath),
    permissionManager: { evaluateToolCall: () => ({ allowed: true }) },
    guardLargeResults: false,
  } as LocalToolRuntimeOptions);
}

function readCall(path: string, offset?: number, limit?: number): LocalToolCall {
  return {
    id: 'call-read',
    displayName: 'Read',
    operation: { kind: 'read_file', path, ...(offset === undefined ? {} : { offset }), ...(limit === undefined ? {} : { limit }) },
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

function editCall(path: string, oldText: string, newText: string): LocalToolCall {
  return {
    id: 'call-edit',
    displayName: 'Edit',
    operation: { kind: 'edit_file', path, edits: [{ oldText, newText }] },
    permission: { toolName: 'Edit', input: { file_path: path } },
  };
}

function bashCall(command: string): LocalToolCall {
  return {
    id: 'call-bash',
    displayName: 'Bash',
    operation: { kind: 'bash', command },
    permission: { toolName: 'Bash', input: { command }, type: 'bash', command },
  };
}

describe('P6.558 — a mutation of an unseen existing file is refused', () => {
  test('edit, overwrite and replace are all refused, and the bytes on disk are untouched', async () => {
    const workspace = await makeWorkspace();
    await writeFile(join(workspace, 'unseen.txt'), 'original bytes', 'utf-8');
    const runtime = makeRuntime(workspace);

    const edited = await runtime.execute(editCall('unseen.txt', 'original', 'replaced'));
    expect(edited.isError).toBe(true);
    expect(edited.error).toContain('has not been read in this session');

    const overwritten = await runtime.execute(writeCall('unseen.txt', 'clobbered'));
    expect(overwritten.isError).toBe(true);

    // `replace_in_file` is `edit_file` under another name. Left ungated, the
    // whole gate would be one rename wide.
    const replaced = await runtime.execute({
      id: 'call-replace',
      displayName: 'Edit',
      operation: { kind: 'replace_in_file', path: 'unseen.txt', oldString: 'original', newString: 'replaced' },
      permission: { toolName: 'Edit', input: { file_path: 'unseen.txt' } },
    });
    expect(replaced.isError).toBe(true);

    // The half that says the refusal is real rather than cosmetic.
    expect(await readFile(join(workspace, 'unseen.txt'), 'utf-8')).toBe('original bytes');
  });

  test('a new file, a read, a windowed read and the session\'s own write all pass', async () => {
    const workspace = await makeWorkspace();
    const runtime = makeRuntime(workspace);

    // (a) A new file — the page: "This constraint doesn't apply to new files."
    const created = await runtime.execute(writeCall('fresh.txt', 'line one\nline two\nline three'));
    expect(created.isError).toBe(false);

    // (b) The session's own write counts as having seen the content: the agent
    // authored those bytes. Refusing an edit to the file you just created would
    // be absurd rather than safe.
    const editedOwn = await runtime.execute(editCall('fresh.txt', 'line one', 'line ONE'));
    expect(editedOwn.isError).toBe(false);

    // (c) A plain read of a file the session did not create.
    await writeFile(join(workspace, 'read-first.txt'), 'alpha beta', 'utf-8');
    const beforeRead = await runtime.execute(editCall('read-first.txt', 'alpha', 'gamma'));
    expect(beforeRead.isError).toBe(true);
    expect((await runtime.execute(readCall('read-first.txt'))).isError).toBeFalsy();
    const afterRead = await runtime.execute(editCall('read-first.txt', 'alpha', 'gamma'));
    expect(afterRead.isError).toBe(false);
    expect(await readFile(join(workspace, 'read-first.txt'), 'utf-8')).toBe('gamma beta');

    // (d) A WINDOWED read satisfies it too, and this is the boundary most likely
    // to be got wrong. The page's disqualifier is a read "cut short with a
    // `PARTIAL view` notice", and `#read-tool-behavior` scopes that notice to a
    // whole-file read that exceeds the token limit — an explicit offset/limit
    // read either succeeds or errors, and a successful one is a normal read.
    await writeFile(join(workspace, 'windowed.txt'), 'one\ntwo\nthree\nfour', 'utf-8');
    const window = await runtime.execute(readCall('windowed.txt', 1, 2));
    expect(window.content).toBe('one\ntwo');
    const afterWindow = await runtime.execute(editCall('windowed.txt', 'four', 'FOUR'));
    expect(afterWindow.isError).toBe(false);
  });

  test('a bare `cat` credits the file; `head -n` and a pipeline deliberately do not', async () => {
    const workspace = await makeWorkspace();
    await writeFile(join(workspace, 'viewed.txt'), 'seen by cat', 'utf-8');
    await writeFile(join(workspace, 'headed.txt'), 'seen by head', 'utf-8');
    const runtime = makeRuntime(workspace);

    // The page: "Viewing a file with Bash also satisfies the read-before-edit
    // requirement when the command is `cat`, `nl`, `bat`, `batcat`, `head`,
    // `tail`, `sed -n 'X,Yp'`, `grep`, `egrep`, `fgrep`, or `rg` on a single
    // file with no pipes or redirects."
    const viewed = await runtime.execute(bashCall('cat viewed.txt'));
    expect(viewed.isError).toBeFalsy();
    const afterCat = await runtime.execute(editCall('viewed.txt', 'seen', 'SEEN'));
    expect(afterCat.isError).toBe(false);

    // Only four of the page's eleven viewers are credited, and this asserts the
    // omission rather than leaving it to a reader's guess: the other seven take
    // their subject as an operand a whitespace split cannot tell from an option
    // VALUE or a pattern, and crediting the wrong path would silently weaken a
    // safety gate. The cost is one refusal that names its own remedy.
    const headed = await runtime.execute(bashCall('head -n 1 headed.txt'));
    expect(headed.isError).toBeFalsy();
    const afterHead = await runtime.execute(editCall('headed.txt', 'seen', 'SEEN'));
    expect(afterHead.isError).toBe(true);

    // "Piped output and other Bash commands don't count toward the
    // read-before-edit check."
    await writeFile(join(workspace, 'piped.txt'), 'seen through a pipe', 'utf-8');
    await runtime.execute(bashCall('cat piped.txt | tr a-z A-Z'));
    const afterPipe = await runtime.execute(editCall('piped.txt', 'seen', 'SEEN'));
    expect(afterPipe.isError).toBe(true);
  });
});

/**
 * P6.558 — the NOTICE half, and the clause it finally gives a subject to.
 *
 * `tools-reference.md#read-tool-behavior`, verbatim: *"By default, Read returns
 * the file from the start. When a whole-file read exceeds the token limit, Read
 * returns the first page with a `PARTIAL view` notice that tells Claude how much
 * of the file it received and how to read more with `offset` and `limit`. A read
 * that passes an explicit `offset` or `limit` and still exceeds the token limit
 * returns an error."*
 *
 * Until this landed the gate above enforced only the base rule, because a
 * whole-file read on this runtime was never cut short — so *"a read cut short
 * with a `PARTIAL view` notice doesn't count"* had nothing to refuse. Both
 * assertions below are therefore about ONE behaviour: the notice and the
 * refusal that follows it are the same rule seen from two ends.
 */
describe('P6.558 — a whole-file read over the token limit is a PARTIAL view', () => {
  // ~130 KB, comfortably past the 12 000-token default with no env or context
  // window to arrange: the ceiling under test is the one a real session gets.
  const bigFile = Array.from({ length: 6_000 }, (_, index) => `line ${index} ${'x'.repeat(20)}`).join('\n');

  test('returns the first page with the notice, and the cut-short read does not satisfy a later write', async () => {
    const workspace = await makeWorkspace();
    await writeFile(join(workspace, 'big.txt'), bigFile, 'utf-8');
    const runtime = makeRuntime(workspace);

    const read = await runtime.execute(readCall('big.txt'));
    expect(read.isError).toBeFalsy();
    // "tells Claude how much of the file it received and how to read more with
    // `offset` and `limit`" — all three facts, in the page's own words.
    expect(read.content).toContain('[PARTIAL view: lines 1-');
    expect(read.content).toContain('of 6000 ');
    expect(read.content).toContain('Use offset=');
    // A PAGE, not the file: the start is present, the end is not.
    expect(read.content).toContain('line 0 x');
    expect(read.content).not.toContain('line 5999 x');
    expect(read.content.length).toBeLessThan(bigFile.length);

    // The coupling. `#edit-tool-behavior`: a read cut short "doesn't count".
    const edited = await runtime.execute(editCall('big.txt', 'line 0 x', 'LINE 0 x'));
    expect(edited.isError).toBe(true);
    expect(edited.error).toContain('has not been read in this session');
    expect(await readFile(join(workspace, 'big.txt'), 'utf-8')).toBe(bigFile);
  });

  test('an explicit range that still exceeds the limit is an ERROR, not a page', async () => {
    // The other half of the same page sentence, and the boundary that keeps the
    // notice off the windowed path — where `appendReadContinuation` already
    // writes its own continuation hint, so one result can never carry both.
    const workspace = await makeWorkspace();
    await writeFile(join(workspace, 'big.txt'), bigFile, 'utf-8');
    const runtime = makeRuntime(workspace);

    const windowed = await runtime.execute(readCall('big.txt', 1, 6_000));
    expect(windowed.isError).toBe(true);
    expect(windowed.error).toContain('still exceeds');
    // Not a PAGE. The refusal is allowed to NAME the notice — it points at the
    // whole-file read as the remedy — so the guard is on the notice's own
    // rendered form, not on the two words.
    expect(windowed.content).not.toContain('[PARTIAL view: lines');

    // An error grants nothing either.
    const edited = await runtime.execute(editCall('big.txt', 'line 0 x', 'LINE 0 x'));
    expect(edited.isError).toBe(true);
  });
});
