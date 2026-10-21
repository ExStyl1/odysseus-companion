/**
 * P2.366 / P2.367 — the documented Bash output limits, reaching a real result.
 *
 * P2.355 landed the numbers and the pure functions and wired them to nothing:
 * no command was cut at any of them, and `BASH_MAX_OUTPUT_LENGTH` was honoured
 * by the Claude subprocess and by nothing on the Pi/host path. This exercises
 * the seam through `LocalToolRuntime.bash()`, with a real classification and a
 * real exit code, rather than only the pure function.
 *
 * Every size here is measured against the SHIPPED defaults — 10 000 characters
 * for a failure excerpt, a 30 000-character read-back window — never against a
 * knob dialled down to make a short string look truncated. A threshold set below
 * the system's resting state manufactures its own pass.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtemp, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { LocalToolRuntime, type LocalToolCall, type LocalToolRuntimeOptions } from '../index.ts';
import {
  BASH_FAILURE_INLINE_CHARS,
  BASH_READ_BACK_CHARS_DEFAULT,
} from '../../../config/bash-output-limits.ts';

async function makeWorkspace(): Promise<string> {
  return realpath(await mkdtemp(join(tmpdir(), 'nessy-bash-limits-')));
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

function makeRuntime(
  workspaceRootPath: string,
  rest: Partial<LocalToolRuntimeOptions>,
): LocalToolRuntime {
  return new LocalToolRuntime({
    filesystemScope: testScope(workspaceRootPath),
    permissionManager: { evaluateToolCall: () => ({ allowed: true }) },
    // The file-plus-preview tier is a different mechanism with a different
    // threshold; this suite is about the limits, so it is held off.
    guardLargeResults: false,
    ...rest,
  } as LocalToolRuntimeOptions);
}

function bashCall(command: string): LocalToolCall {
  return {
    id: 'call-bash',
    displayName: 'Bash',
    operation: { kind: 'bash', command },
    permission: { toolName: 'Bash', input: { command }, type: 'bash', command },
  } as LocalToolCall;
}

/** A distinguishable head and tail, so a head-only cut is visible as one. */
function bracketedOutput(length: number): string {
  const head = 'HEAD-MARKER';
  const tail = 'TAIL-MARKER';
  return head + 'x'.repeat(Math.max(0, length - head.length - tail.length)) + tail;
}

describe('Bash output limits, wired', () => {
  test('a valid result passes through whole', async () => {
    const workspace = await makeWorkspace();
    // Comfortably past the failure excerpt size, so a wrongly-classified result
    // would be cut and this would fail.
    const output = bracketedOutput(BASH_FAILURE_INLINE_CHARS * 2);
    const runtime = makeRuntime(workspace, {
      runCommand: async () => ({ stdout: output, stderr: '', exitCode: 0 }),
    });

    const res = await runtime.execute(bashCall('echo hi'));
    expect(res.isError).toBe(false);
    expect(res.content).toBe(output);
  });

  test('a failing command gets the documented head-AND-tail excerpt', async () => {
    const workspace = await makeWorkspace();
    // The concrete harm this closes: a failure's message is at the END, and
    // every cut on this path was head-only.
    const output = bracketedOutput(BASH_FAILURE_INLINE_CHARS * 2);
    const runtime = makeRuntime(workspace, {
      runCommand: async () => ({ stdout: '', stderr: output, exitCode: 2 }),
    });

    const res = await runtime.execute(bashCall('make build'));
    expect(res.isError).toBe(true);
    expect(res.content).toContain('HEAD-MARKER');
    expect(res.content).toContain('TAIL-MARKER');
    expect(res.content).toContain('characters omitted');
    // The excerpt is the promised size; the marker is additional to it.
    expect(res.content.length).toBeLessThan(output.length);
    expect(res.content.length).toBeGreaterThanOrEqual(BASH_FAILURE_INLINE_CHARS);
  });

  test('a small failure is not touched at all', async () => {
    const workspace = await makeWorkspace();
    const output = 'error: no such file';
    const runtime = makeRuntime(workspace, {
      runCommand: async () => ({ stdout: '', stderr: output, exitCode: 1 }),
    });

    const res = await runtime.execute(bashCall('cat missing'));
    expect(res.content).toBe(output);
  });

  test("grep's benign exit 1 stays a valid result", async () => {
    const workspace = await makeWorkspace();
    // The page names grep among the commands whose exit 1 is benign. Misreading
    // it as a failure would hand the model a 10 000-character excerpt of a
    // perfectly good search result.
    const output = bracketedOutput(BASH_FAILURE_INLINE_CHARS * 2);
    const runtime = makeRuntime(workspace, {
      runCommand: async () => ({ stdout: output, stderr: '', exitCode: 1 }),
    });

    const res = await runtime.execute(bashCall('grep -r needle .'));
    expect(res.content).toBe(output);
  });

  test('says which end it kept when the output outruns the read-back window', async () => {
    const workspace = await makeWorkspace();
    // Past the 30 000-character default window, so the excerpt's tail is the end
    // of the WINDOW rather than the end of the command — and the result has to
    // say so, with the operator's variable named in it.
    const output = bracketedOutput(BASH_READ_BACK_CHARS_DEFAULT * 2);
    const runtime = makeRuntime(workspace, {
      runCommand: async () => ({ stdout: '', stderr: output, exitCode: 127 }),
    });

    const res = await runtime.execute(bashCall('./configure'));
    expect(res.content).toContain('HEAD-MARKER');
    expect(res.content).not.toContain('TAIL-MARKER');
    expect(res.content).toContain(`read back ${BASH_READ_BACK_CHARS_DEFAULT} of ${output.length} characters`);
    expect(res.content).toContain('BASH_MAX_OUTPUT_LENGTH');
  });
});

/**
 * P6.690 — a `cd` never carries over on this runtime, and the model is now told.
 *
 * `tools-reference.md#bash-tool-behavior`, verbatim: *"If `cd` lands outside
 * those directories, Claude Code resets to the project directory and appends
 * `Shell cwd was reset to <dir>` to the tool result."* Pi is permanently in the
 * state that page's third sentence describes (`every Bash command starts in the
 * project directory`), so the reset is real on every call — only the sentence
 * was missing. The page's wording is reused unchanged so a user switching
 * runtimes meets a notice they already know.
 *
 * The suite is one positive and two silences, because the way a disclosure goes
 * wrong is by being everywhere: a notice on every command is a notice nobody
 * reads, and a notice on a command we could not parse is a claim we cannot make.
 */
describe('P6.690 — the shell cwd reset notice', () => {
  test('a command that changes directory says where the next one will start', async () => {
    const workspace = await makeWorkspace();
    const runtime = makeRuntime(workspace, {
      runCommand: async () => ({ stdout: 'built', stderr: '', exitCode: 0 }),
    });

    const res = await runtime.execute(bashCall('cd build && make'));
    expect(res.isError).toBeFalsy();
    // The page's sentence, and the real directory the next call will use.
    expect(res.content).toContain(`Shell cwd was reset to ${workspace}`);
    // Appended, never replacing: the command's own output survives.
    expect(res.content).toContain('built');
  });

  test('a command that does not change directory says nothing', async () => {
    const workspace = await makeWorkspace();
    const runtime = makeRuntime(workspace, {
      runCommand: async () => ({ stdout: 'a\nb', stderr: '', exitCode: 0 }),
    });

    const res = await runtime.execute(bashCall('ls -la'));
    expect(res.content).toBe('a\nb');
    expect(res.content).not.toContain('Shell cwd was reset');
  });

  test('a command that cannot be split safely earns no claim about what it did', async () => {
    // An unbalanced quote makes `splitCompoundCommand` answer `null`. Guessing
    // there would be inventing a fact about a command nobody could parse.
    const workspace = await makeWorkspace();
    const runtime = makeRuntime(workspace, {
      runCommand: async () => ({ stdout: '', stderr: 'unterminated', exitCode: 2 }),
    });

    const res = await runtime.execute(bashCall('cd "build'));
    expect(res.content).not.toContain('Shell cwd was reset');
  });
});
