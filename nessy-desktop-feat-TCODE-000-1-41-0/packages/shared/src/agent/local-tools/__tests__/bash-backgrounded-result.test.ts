import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { LocalToolRuntime, type LocalToolCall } from '../index.ts';

/**
 * R10 documented Bash result shapes (doc-verification § R10, `tools-reference.md`
 * §Background commands). The timeout message is a WIRE/tool-result contract
 * string and stays English verbatim.
 */

async function makeWorkspace(): Promise<string> {
  return realpath(await mkdtemp(join(tmpdir(), 'nessy-r10-bash-result-')));
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

function bashCall(operation: Record<string, unknown>): LocalToolCall {
  return {
    id: 'bash-call-1',
    displayName: 'bash',
    operation: { kind: 'bash', ...operation } as LocalToolCall['operation'],
    permission: { toolName: 'Bash', input: operation, type: 'bash', command: String(operation.command) },
  };
}

const originalDisable = process.env.NESSY_DISABLE_BACKGROUND_TASKS;
afterEach(() => {
  if (originalDisable === undefined) delete process.env.NESSY_DISABLE_BACKGROUND_TASKS;
  else process.env.NESSY_DISABLE_BACKGROUND_TASKS = originalDisable;
});

describe('bash backgrounded tool results', () => {
  test('a timeout transition returns the documented message with matching seconds', async () => {
    const workspace = await makeWorkspace();
    const commands: Array<Record<string, unknown>> = [];
    const runtime = new LocalToolRuntime({
      filesystemScope: testScope(workspace),
      permissionManager: { evaluateToolCall: () => ({ allowed: true }) },
      runCommand: async (_command, _cwd, options) => {
        commands.push({ ...options });
        return {
          stdout: 'partial output before the move',
          stderr: '',
          exitCode: 0,
          backgrounded: {
            taskId: 'process_0123456789abcdef0123456789abcdef',
            outputFile: join(workspace, 'process_0123456789abcdef0123456789abcdef.log'),
            timedOut: true,
            timeoutMs: 120_000,
          },
        };
      },
    });

    const result = await runtime.execute(bashCall({ command: 'bun run build' }));
    expect(result.isError).toBe(false);
    const lines = result.content.split('\n');
    expect(lines[0]).toBe('Command did not complete within its 120s timeout and was moved to the background');
    expect(result.content).toContain('shell_id: process_0123456789abcdef0123456789abcdef');
    expect(result.content).toContain(`output_file: ${join(workspace, 'process_0123456789abcdef0123456789abcdef.log')}`);
    expect(result.content).toContain(
      `Session cwd remains ${workspace}; directory changes made by the backgrounded command do not apply to subsequent commands.`,
    );
  });

  test('N equals the applied timeout, not a constant', async () => {
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
          outputFile: '/tmp/task.log',
          timedOut: true,
          timeoutMs: 3_000,
        },
      }),
    });
    const result = await runtime.execute(bashCall({ command: 'bun run build', timeout: 3_000 }));
    expect(result.content).toContain('Command did not complete within its 3s timeout and was moved to the background');
  });

  test('run_in_background returns the handle shape minus the timeout sentence', async () => {
    const workspace = await makeWorkspace();
    const optionsSeen: Array<Record<string, unknown>> = [];
    const runtime = new LocalToolRuntime({
      filesystemScope: testScope(workspace),
      permissionManager: { evaluateToolCall: () => ({ allowed: true }) },
      runCommand: async (_command, _cwd, options) => {
        optionsSeen.push({ ...options });
        return {
          stdout: '',
          stderr: '',
          exitCode: 0,
          backgrounded: {
            taskId: 'process_feedfacefeedfacefeedfacefeedface',
            outputFile: '/tmp/bg.log',
            timedOut: false,
            timeoutMs: 86_400_000,
          },
        };
      },
    });

    const result = await runtime.execute(bashCall({ command: 'bun run dev', runInBackground: true }));
    expect(result.isError).toBe(false);
    expect(result.content).not.toContain('did not complete within');
    expect(result.content).toContain('shell_id: process_feedfacefeedfacefeedfacefeedface');
    expect(result.content).toContain('output_file: /tmp/bg.log');
    expect(result.content).toContain(
      `Session cwd remains ${workspace}; directory changes made by the backgrounded command do not apply to subsequent commands.`,
    );
    // The production runCommand seam received the background start request and
    // the tool-call id for the shell_backgrounded event.
    expect(optionsSeen[0]?.background).toBe(true);
    expect(optionsSeen[0]?.executionId).toBe('bash-call-1');
  });

  test('run_in_background is rejected when background tasks are disabled', async () => {
    const workspace = await makeWorkspace();
    let ran = false;
    const runtime = new LocalToolRuntime({
      filesystemScope: testScope(workspace),
      permissionManager: { evaluateToolCall: () => ({ allowed: true }) },
      runCommand: async () => {
        ran = true;
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    });
    process.env.NESSY_DISABLE_BACKGROUND_TASKS = '1';
    const result = await runtime.execute(bashCall({ command: 'bun run dev', runInBackground: true }));
    expect(result.isError).toBe(true);
    expect(result.content).toContain('NESSY_DISABLE_BACKGROUND_TASKS');
    expect(ran).toBe(false);
  });
});
