/**
 * P6.742 — the read is bounded WHILE the file is read, not after it is in memory.
 *
 * `tools-reference.md#read-tool-behavior` (anchor verified on the rendered page,
 * 2026-09-08), the paragraph this row exists for, verbatim: *"A read with an
 * explicit `limit` stops as soon as the selected lines exceed what the token
 * limit could ever fit and returns an error without loading the rest of the
 * range. The error tells Claude to use a smaller `limit`, or to search for
 * specific content with [Grep](#grep-tool-behavior) instead when a single line
 * is that large. Before v2.1.208, Claude Code loaded the whole range into memory
 * before rejecting it, so reading a file with an extremely long single line
 * could run it out of memory."*
 *
 * P6.558 landed the NOTICE — what the model is told. This suite is about how
 * much is READ, which is a different property and is only visible in one place:
 * the size of what comes back when the file is enormous and unbroken by
 * newlines. On the pre-P6.742 runtime the first case below returned the whole
 * two-megabyte line.
 *
 * The third case is the non-vacuity control, and it is the one a reviewer should
 * read first. A streaming line reader that returns "not much" passes every
 * bound in this file while being useless; it is also exactly the shape of code
 * that corrupts content at a chunk boundary, where a multi-byte character is
 * split in half. So a file that FITS must come back byte-identical, and it is
 * built to be larger than one read chunk in bytes while staying under the token
 * limit in characters — which only multi-byte text can be.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { estimateTokensDensityAware } from '../../../utils/large-response.ts';
import { LocalToolRuntime, type LocalToolCall, type LocalToolRuntimeOptions } from '../index.ts';

/** The default ceiling a session with no operator key and no context window gets. */
const DEFAULT_TOKEN_LIMIT = 12_000;
/** `MAX_CHARS_PER_TOKEN` in the runtime: the loosest chars-per-token estimate. */
const BUDGET_CHARS = DEFAULT_TOKEN_LIMIT * 4 + 1;

async function makeWorkspace(): Promise<string> {
  return realpath(await mkdtemp(join(tmpdir(), 'nessy-read-bounded-')));
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

function editCall(path: string, oldText: string, newText: string): LocalToolCall {
  return {
    id: 'call-edit',
    displayName: 'Edit',
    operation: { kind: 'edit_file', path, edits: [{ oldText, newText }] },
    permission: { toolName: 'Edit', input: { file_path: path } },
  };
}

describe('P6.742 — an extremely long single line is bounded as it is read', () => {
  // Two megabytes on ONE line: forty times the budget, and no newline anywhere
  // for a line window to stop at. This is the page's own "extremely long single
  // line", at a size that cannot exhaust a test runner if the bound regresses.
  const hugeLine = `head ${'x'.repeat(2_000_000)} tail`;

  test('a whole-file read returns a page the size of the budget, not the line', async () => {
    const workspace = await makeWorkspace();
    await writeFile(join(workspace, 'one-line.txt'), hugeLine, 'utf-8');
    const runtime = makeRuntime(workspace);

    const read = await runtime.execute(readCall('one-line.txt'));
    expect(read.isError).toBeFalsy();

    // The row itself: what came back is bounded by the budget. Before P6.742 the
    // whole 2 MB line was loaded and returned, which is the pre-v2.1.208 defect
    // the page describes.
    expect(read.content.length).toBeLessThan(BUDGET_CHARS + 2_000);
    expect(read.content.length).toBeGreaterThan(1_000);
    expect(read.content.startsWith('head xxx')).toBe(true);
    expect(read.content).not.toContain(' tail');

    // The notice tells the truth about what it did: one line, cut, and the
    // page's own remedy for a line this large rather than a continuation offset
    // that cannot resume inside a line.
    expect(read.content).toContain('[PARTIAL view: lines 1-1 of 1 ');
    expect(read.content).toContain('was cut here');
    expect(read.content).toContain('Grep');

    // A cut-short read still does not satisfy a later write (`#edit-tool-behavior`).
    const edited = await runtime.execute(editCall('one-line.txt', 'head', 'HEAD'));
    expect(edited.isError).toBe(true);
    expect(await readFile(join(workspace, 'one-line.txt'), 'utf-8')).toBe(hugeLine);
  });

  test('an explicit range over it errors with the page\'s two remedies and grants nothing', async () => {
    const workspace = await makeWorkspace();
    await writeFile(join(workspace, 'one-line.txt'), hugeLine, 'utf-8');
    const runtime = makeRuntime(workspace);

    const windowed = await runtime.execute(readCall('one-line.txt', 1, 1));
    expect(windowed.isError).toBe(true);
    expect(windowed.error).toContain('still exceeds');
    // "The error tells Claude to use a smaller `limit`, or to search for
    // specific content with Grep instead when a single line is that large."
    expect(windowed.error).toContain('smaller limit');
    expect(windowed.error).toContain('Grep');
    expect(windowed.error).toContain('the rest of the range was not loaded');
    // An error is not a page, and it grants nothing.
    expect(windowed.content ?? '').not.toContain('[PARTIAL view: lines');
    expect((await runtime.execute(editCall('one-line.txt', 'head', 'HEAD'))).isError).toBe(true);
  });

  test('a file that FITS comes back byte-identical across chunk boundaries', async () => {
    // Larger than one read chunk in BYTES (multi-byte characters, so a chunk
    // boundary lands inside a character) and under the token limit in
    // CHARACTERS, so the whole file is returned and every byte of it is
    // asserted. Empty lines and no trailing newline are here because a
    // hand-rolled line splitter loses exactly those.
    const lines: string[] = [];
    for (let index = 0; index < 400; index += 1) {
      lines.push(index % 7 === 0 ? '' : `${index} ${'日本語テキスト'.repeat(11)} ${index}`);
    }
    const content = lines.join('\n');
    expect(Buffer.byteLength(content, 'utf-8')).toBeGreaterThan(64 * 1024);
    expect(estimateTokensDensityAware(content)).toBeLessThan(DEFAULT_TOKEN_LIMIT);

    const workspace = await makeWorkspace();
    await writeFile(join(workspace, 'fits.txt'), content, 'utf-8');
    const runtime = makeRuntime(workspace);

    const whole = await runtime.execute(readCall('fits.txt'));
    expect(whole.isError).toBeFalsy();
    expect(whole.content).toBe(content);
    expect(whole.content).not.toContain('[PARTIAL view');

    // The window is still the window: 1-based `offset`, `limit` lines, empty
    // lines preserved in place.
    const windowed = await runtime.execute(readCall('fits.txt', 6, 4));
    expect(windowed.isError).toBeFalsy();
    expect(windowed.content).toBe(lines.slice(5, 9).join('\n'));

    // A complete read still satisfies a later write — the half that would break
    // silently if the reader had merely stopped returning content.
    const edited = await runtime.execute(editCall('fits.txt', '398 日', '398 Я'));
    expect(edited.isError).toBe(false);
  });

  test('the budget cannot cut a page that would have fitted', () => {
    // The reader stops retaining at `tokenLimit * 4 + 1` characters. That is only
    // sound while 4 chars/token is the LOOSEST estimate any estimator applies —
    // if `estimateTokens` ever divided by more, the reader would start cutting
    // pages the limit would have accepted, silently. This pins the relationship
    // rather than the constant.
    const tokens = 1_000;
    expect(estimateTokensDensityAware('x'.repeat(tokens * 4))).toBeLessThanOrEqual(tokens);
    expect(estimateTokensDensityAware('x'.repeat(tokens * 4 + 1))).toBeGreaterThan(tokens);

    // And the other direction: the density correction only ever RAISES the count
    // for the same characters, so it can never make a budgeted prefix fit.
    const dense = 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVphYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5eg=='.repeat(400);
    expect(dense.length).toBeGreaterThan(20_000);
    expect(estimateTokensDensityAware(dense)).toBeGreaterThan(Math.ceil(dense.length / 4));
  });
});
