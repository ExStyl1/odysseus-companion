import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { LocalToolRuntime, type LocalToolCall } from '../index.ts';
import { GLOB_TIMEOUT_SECONDS_ENV } from '../../../config/glob-timeout.ts';

/**
 * P6.692 — Glob (our `find`) had no discovery budget at all: `LocalToolRuntime.find`
 * passed no `timeout` and no `signal`, so a search that never returned held the
 * turn open indefinitely. The transition was decided before the timeout was
 * wired: expiry ENDS THE CALL with a named terminal reason, never a background
 * hand-off, because a half-finished file listing is a wrong answer that looks
 * like a right one.
 */

async function makeWorkspace(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'nessy-p6692-glob-')));
  await writeFile(join(root, 'alpha.ts'), 'export const a = 1');
  await writeFile(join(root, 'beta.ts'), 'export const b = 2');
  return root;
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

function findCall(pattern: string): LocalToolCall {
  return {
    id: 'find-call-1',
    displayName: 'find',
    operation: { kind: 'find', pattern } as LocalToolCall['operation'],
    permission: { toolName: 'Find', input: { pattern } },
  };
}

const original = process.env[GLOB_TIMEOUT_SECONDS_ENV];
afterEach(() => {
  // `delete` before assign, and on the restore path too: Bun 1.3.14 leaves an
  // assigned-only name invisible to a spread.
  delete process.env[GLOB_TIMEOUT_SECONDS_ENV];
  if (original !== undefined) process.env[GLOB_TIMEOUT_SECONDS_ENV] = original;
});

describe('Glob discovery budget', () => {
  // POSITIVE: over budget ends the call, and says why, in a result the model
  // can act on — not a hang and not a background handle.
  test('a search that exceeds the configured seconds returns a named timeout, not a hang', async () => {
    const workspace = await makeWorkspace();
    delete process.env[GLOB_TIMEOUT_SECONDS_ENV];
    process.env[GLOB_TIMEOUT_SECONDS_ENV] = '1';
    let sawSignal: AbortSignal | undefined;
    const runtime = new LocalToolRuntime({
      filesystemScope: testScope(workspace),
      permissionManager: { evaluateToolCall: () => ({ allowed: true }) },
      // A command that never finishes on its own: only the deadline can end it.
      runCommand: async (_command, _cwd, options) => {
        sawSignal = options?.signal;
        await new Promise<void>(resolve => {
          options?.signal?.addEventListener('abort', () => resolve(), { once: true });
        });
        return { stdout: '', stderr: 'Command aborted', exitCode: 130 };
      },
    });

    const started = Date.now();
    const result = await runtime.execute(findCall('*.ts'));

    expect(result.isError).toBe(true);
    expect(result.content).toContain('timed out after 1s');
    // The reason names the knob, so the message is actionable rather than a
    // dead end.
    expect(result.content).toContain(GLOB_TIMEOUT_SECONDS_ENV);
    // Not a background hand-off: no task id, no output file, no handle.
    expect(result.content).not.toContain('background');
    // The budget was actually enforced rather than inherited from some other
    // timer: a 1s budget must not take 20.
    expect(Date.now() - started).toBeLessThan(10_000);
    // And the deadline reached the command, which is what stops the child.
    expect(sawSignal?.aborted).toBe(true);
  });

  // NEGATIVE / CONTROL: an under-budget search is unchanged — same result the
  // tool produced before this row.
  test('an under-budget search returns its file list unchanged', async () => {
    const workspace = await makeWorkspace();
    const passedOptions: Array<Record<string, unknown>> = [];
    const runtime = new LocalToolRuntime({
      filesystemScope: testScope(workspace),
      permissionManager: { evaluateToolCall: () => ({ allowed: true }) },
      runCommand: async (_command, _cwd, options) => {
        passedOptions.push({ ...options });
        return {
          stdout: [join(workspace, 'alpha.ts'), join(workspace, 'beta.ts')].join('\n'),
          stderr: '',
          exitCode: 0,
        };
      },
    });

    const result = await runtime.execute(findCall('*.ts'));

    expect(result.isError).toBe(false);
    expect(result.content.split('\n').sort()).toEqual(['alpha.ts', 'beta.ts']);
    // The budget is handed to the command as well as held by us, so the child
    // is bounded even when our own timer is the thing that fires second.
    expect(passedOptions[0]?.timeout).toBe(20_000);
    expect(passedOptions[0]?.semanticId).toBe('find');
  });

  // The transition, asserted rather than assumed: if a supervisor ever DID hand
  // a search to a background task, the model must be told the search ended —
  // never handed the empty stdout a transition produces as if it were "no
  // matches".
  test('a background transition is refused with a named reason, never reported as an empty result', async () => {
    const workspace = await makeWorkspace();
    const runtime = new LocalToolRuntime({
      filesystemScope: testScope(workspace),
      permissionManager: { evaluateToolCall: () => ({ allowed: true }) },
      runCommand: async () => ({
        stdout: '',
        stderr: '',
        exitCode: 0,
        backgrounded: {
          taskId: 'process_0123456789abcdef0123456789abcdef',
          outputFile: join(workspace, 'search.log'),
          timedOut: true,
          timeoutMs: 20_000,
        },
      }),
    });

    const result = await runtime.execute(findCall('*.ts'));

    expect(result.isError).toBe(true);
    expect(result.content).toContain('no results were returned');
    expect(result.content).not.toContain('process_0123456789abcdef0123456789abcdef');
  });
});
