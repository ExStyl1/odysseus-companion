import { describe, expect, it } from 'bun:test';
import { PiAgent, type EditFeedbackRunner } from '../pi-agent.ts';
import type { BackendConfig } from '../backend/types.ts';

/**
 * CI2 — edit-feedback loop wiring on the PiAgent.
 *
 * These prove the OBSERVATIONAL contract at the agent boundary:
 * - a successful edit/write PostToolUse invokes the injected runner and stashes
 *   its bounded output for the next PreToolUse (positive path);
 * - a non-edit tool never invokes the runner (negative path);
 * - a runner error is fail-soft — swallowed, nothing stashed, edit not blocked;
 * - with no runner injected (untrusted / feature off) nothing ever runs.
 */

function createConfig(): BackendConfig {
  return {
    provider: 'pi',
    workspace: {
      id: 'ws-test',
      name: 'Test Workspace',
      rootPath: '/tmp/ws-root',
      workspaceRootPath: '/tmp/ws-root',
      sessionRootPath: '/tmp/nessy-general-agent-test-sessions/ws-test',
    } as any,
    session: {
      id: 'session-test',
      workspaceRootPath: '/tmp/ws-root',
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      workingDirectory: '/tmp/project-root',
    } as any,
    model: 'pi/test-model',
    isHeadless: true,
  };
}

/** Drive one raw start+end pair through the subprocess event path. */
function driveToolResult(
  agent: PiAgent,
  toolName: string,
  input: Record<string, unknown>,
  isError = false,
): string {
  const toolCallId = `call-${Math.random().toString(36).slice(2)}`;
  (agent as any).handleSubprocessEvent({ type: 'tool_execution_start', toolCallId, toolName, args: input });
  (agent as any).handleSubprocessEvent({ type: 'tool_execution_end', toolCallId, toolName, result: 'ok', isError });
  return toolCallId;
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('PiAgent CI2 edit-feedback loop', () => {
  it('invokes the runner on a successful edit and stashes bounded diagnostics', async () => {
    const agent = new PiAgent(createConfig());
    const calls: Array<{ toolName: string; toolInput: Record<string, unknown> }> = [];
    const runner: EditFeedbackRunner = async (event) => {
      calls.push({ toolName: event.toolName, toolInput: event.toolInput });
      return 'lint: unused variable at line 3';
    };
    agent.editFeedbackRunner = runner;

    driveToolResult(agent, 'edit', { path: '/tmp/ws-root/a.ts' });
    await flush();

    expect(calls).toHaveLength(1);
    expect(calls[0]!.toolName).toBe('Edit');
    // SEAM ASSERTION (the gap the old tests missed): the changed-file path must
    // survive the full tool_execution_start → tool_execution_end flow and reach
    // the runner. tool_result carries no input, so this only passes when the
    // tool_start input is cached by toolCallId and looked up at the result. The
    // raw Pi field is `path`; the adapter normalizes it to `file_path`, which is
    // exactly what resolveChangedFile consumes.
    expect(calls[0]!.toolInput.file_path).toBe('/tmp/ws-root/a.ts');
    expect(calls[0]!.toolInput.path).toBeUndefined();
    // The one-shot queue holds the diagnostics for the next PreToolUse.
    expect((agent as any).consumePendingEditFeedback()).toContain('unused variable');
    // Consuming is one-shot: a second read is empty.
    expect((agent as any).consumePendingEditFeedback()).toBeUndefined();
    // The per-callId cache is consumed at the result — nothing leaks.
    expect((agent as any).editFeedbackInputByCallId.size).toBe(0);

    agent.destroy();
  });

  it('delivers notebook_path through the seam for NotebookEdit', async () => {
    const agent = new PiAgent(createConfig());
    const calls: Array<{ toolName: string; toolInput: Record<string, unknown> }> = [];
    agent.editFeedbackRunner = async (event) => {
      calls.push({ toolName: event.toolName, toolInput: event.toolInput });
      return undefined;
    };

    // NotebookEdit carries notebook_path (the adapter does not rewrite it), which
    // resolveChangedFile reads after file_path/path.
    driveToolResult(agent, 'NotebookEdit', { notebook_path: '/tmp/ws-root/nb.ipynb' });
    await flush();

    expect(calls).toHaveLength(1);
    expect(calls[0]!.toolName).toBe('NotebookEdit');
    expect(calls[0]!.toolInput.notebook_path).toBe('/tmp/ws-root/nb.ipynb');
    expect((agent as any).editFeedbackInputByCallId.size).toBe(0);

    agent.destroy();
  });

  it('leaks nothing into the cache for non-edit or failed tools', async () => {
    const agent = new PiAgent(createConfig());
    agent.editFeedbackRunner = async () => undefined;

    driveToolResult(agent, 'read', { path: '/tmp/ws-root/a.ts' });
    driveToolResult(agent, 'edit', { path: '/tmp/ws-root/b.ts' }, /* isError */ true);
    await flush();

    // A non-edit tool is never cached; a failed edit is cached at start but
    // consumed (deleted) at the result even though the runner is skipped.
    expect((agent as any).editFeedbackInputByCallId.size).toBe(0);
    expect((agent as any).consumePendingEditFeedback()).toBeUndefined();
    agent.destroy();
  });

  it('does not invoke the runner for a non-edit tool (negative path)', async () => {
    const agent = new PiAgent(createConfig());
    let invoked = false;
    agent.editFeedbackRunner = async () => { invoked = true; return 'should not appear'; };

    driveToolResult(agent, 'read', { path: '/tmp/ws-root/a.ts' });
    await flush();

    expect(invoked).toBe(false);
    expect((agent as any).consumePendingEditFeedback()).toBeUndefined();
    agent.destroy();
  });

  it('does not invoke the runner for a failed edit (only successes are linted)', async () => {
    const agent = new PiAgent(createConfig());
    let invoked = false;
    agent.editFeedbackRunner = async () => { invoked = true; return 'x'; };

    driveToolResult(agent, 'edit', { path: '/tmp/ws-root/a.ts' }, /* isError */ true);
    await flush();

    expect(invoked).toBe(false);
    agent.destroy();
  });

  it('is fail-soft when the runner throws — nothing stashed, never blocks', async () => {
    const agent = new PiAgent(createConfig());
    agent.editFeedbackRunner = async () => { throw new Error('linter crashed'); };

    driveToolResult(agent, 'write', { path: '/tmp/ws-root/b.ts' });
    await flush();

    expect((agent as any).consumePendingEditFeedback()).toBeUndefined();
    agent.destroy();
  });

  it('runs nothing when no runner is injected (untrusted / feature off)', async () => {
    const agent = new PiAgent(createConfig());
    expect(agent.editFeedbackRunner).toBeNull();

    driveToolResult(agent, 'edit', { path: '/tmp/ws-root/a.ts' });
    await flush();

    expect((agent as any).consumePendingEditFeedback()).toBeUndefined();
    agent.destroy();
  });

  it('merges parallel feedback once in tool-call order without retaining file paths', async () => {
    const agent = new PiAgent(createConfig());
    const releases = new Map<string, (value: string) => void>();
    agent.editFeedbackRunner = ({ toolInput }) => new Promise(resolve => {
      releases.set(String(toolInput.file_path), resolve);
    });

    driveToolResult(agent, 'edit', { path: '/tmp/ws-root/a.ts' });
    driveToolResult(agent, 'write', { path: '/tmp/ws-root/b.ts' });
    releases.get('/tmp/ws-root/b.ts')?.('diagnostic-b');
    await flush();
    expect((agent as any).consumePendingEditFeedback()).toBeUndefined();
    expect(JSON.stringify([...(agent as any).pendingEditFeedback.keys()])).not.toContain('/tmp/ws-root');

    releases.get('/tmp/ws-root/a.ts')?.('diagnostic-a');
    await flush();
    expect((agent as any).consumePendingEditFeedback()).toBe('diagnostic-a\n\ndiagnostic-b');
    expect((agent as any).consumePendingEditFeedback()).toBeUndefined();
    agent.destroy();
  });

  it('bounds pending feedback under a stalled runner', async () => {
    const agent = new PiAgent(createConfig());
    agent.editFeedbackRunner = async () => new Promise<string>(() => {});
    for (let index = 0; index < 40; index += 1) {
      driveToolResult(agent, 'edit', { path: `/tmp/ws-root/${index}.ts` });
    }

    expect((agent as any).pendingEditFeedback.size).toBe(32);
    agent.destroy();
  });
});
