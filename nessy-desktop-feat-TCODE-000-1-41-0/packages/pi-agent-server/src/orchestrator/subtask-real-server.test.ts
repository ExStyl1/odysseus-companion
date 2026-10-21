/**
 * S13 — the `/subtask` wiring, through the real server process.
 *
 * The seam test (`subtask-panel.test.ts`) drives `startSubtaskFork` with the
 * options the server passes it. This one proves the SERVER passes them: the
 * background-task registration is only correct if `handleSubtaskStart` hands the
 * command the published generation's registry and an event channel, and a
 * forgotten argument there is the same class of defect as the missing
 * registration itself — declared on one path, wired on none.
 *
 * So the assertions are on the wire: the start the host receives carries
 * `background: true` AND a `backgroundTaskId` (without which the host refuses the
 * fork), and the lifecycle pair the host needs in order to retain and release the
 * fork's capability authority is emitted around it.
 *
 * Fork mode is not enabled: the init carries no orchestrator overrides, so
 * `forkSubagent` normalizes to the default OFF — the state `sub-agents.md:1013`
 * says `/subtask` must work in.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'bun:test';

import { createRealServerExecutionManifest } from '../__tests__/real-server-execution-manifest.ts';
import { realServerTestBudget, startRealServerClock } from '../__tests__/support/real-server-clock.ts';

const here = dirname(fileURLToPath(import.meta.url));
const defaultEntrypoint = join(here, '..', 'index.ts');
const preloadPath = join(here, 'subtask-e2e-preload.ts');
/** F1.607 — the ANSWER budget, from the child's first `ready`; the boot has its own (`real-server-clock.ts`). */
const REAL_SERVER_TIMEOUT_MS = 120_000;
const TEST_TIMEOUT_MS = realServerTestBudget(REAL_SERVER_TIMEOUT_MS);

const FORK_AGENT_ID = 'fork-agent-1';
const FORK_RESULT = 'fork answered from the parent conversation';

function writeJson(child: ChildProcessWithoutNullStreams, message: Record<string, unknown>): void {
  child.stdin.write(`${JSON.stringify(message)}\n`);
}

describe('/subtask real server e2e', () => {
  it('starts the fork as a registered background child and reports it when it ends', async () => {
    const workspaceRootPath = mkdtempSync(join(tmpdir(), 'nessy-subtask-workspace-'));
    const sessionPath = mkdtempSync(join(tmpdir(), 'nessy-subtask-session-'));
    const workspaceId = 'subtask-e2e-workspace';
    const sessionId = 'subtask-e2e-session';
    const executionManifest = createRealServerExecutionManifest({ workspaceId, sessionId });
    const entrypoint = process.env.NESSY_PI_SERVER_ENTRYPOINT || defaultEntrypoint;
    const child = spawn(process.execPath, ['--preload', preloadPath, entrypoint], {
      cwd: join(here, '..', '..', '..', '..'),
      env: { ...process.env, NO_COLOR: '1', FAUX_API_KEY: 'test' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stdout = createInterface({ input: child.stdout });
    let stderr = '';
    let promptSent = false;
    let subtaskSent = false;
    const messages: any[] = [];
    const starts: any[] = [];

    child.stderr.on('data', chunk => { stderr += String(chunk); });

    const done = new Promise<void>((resolve, reject) => {
      const clock = startRealServerClock({
        answerWaitMs: REAL_SERVER_TIMEOUT_MS,
        onExpire: (_phase, why) => reject(new Error(`/subtask real-server e2e timed out — ${why}\nstderr:\n${stderr}`)),
      });

      const forkRecord = (status: 'running' | 'completed') => ({
        agentId: FORK_AGENT_ID,
        status,
        output: FORK_RESULT,
        result: FORK_RESULT,
        inputTokens: 1,
        outputTokens: 1,
        costUsd: 0,
      });

      stdout.on('line', line => {
        let message: any;
        try { message = JSON.parse(line); } catch { return }
        messages.push(message);

        // One ordinary turn first: the spawner a fork uses is configured when a
        // capability generation is published, not at init.
        if (message.type === 'ready') clock.ready();
        if (message.type === 'ready' && !promptSent) {
          promptSent = true;
          writeJson(child, {
            type: 'prompt',
            id: 'prompt-1',
            message: 'Say something.',
            systemPrompt: 'Answer briefly.',
            manifestGeneration: executionManifest.snapshotGeneration,
            manifestHash: executionManifest.manifestHash,
          });
          return;
        }

        if (message.type === 'child_session_request') {
          const operation = message.request?.operation;
          if (operation === 'start') {
            starts.push(message.request.input);
            writeJson(child, {
              type: 'child_session_response',
              requestId: message.requestId,
              result: forkRecord('running'),
            });
            return;
          }
          if (operation === 'monitor' || operation === 'get_result') {
            writeJson(child, {
              type: 'child_session_response',
              requestId: message.requestId,
              result: forkRecord('completed'),
            });
            return;
          }
          writeJson(child, { type: 'child_session_response', requestId: message.requestId });
          return;
        }

        if (message.type === 'event' && message.event?.type === 'agent_end' && !subtaskSent) {
          subtaskSent = true;
          // What the host sends when the user types `/subtask <task>`.
          writeJson(child, { type: 'subtask_start', id: 'subtask-e2e-1', task: 'check the parser change' });
          return;
        }

        if (message.type === 'event' && message.event?.type === 'task_completed') {
          clock.clear();
          resolve();
          return;
        }

        if (message.type === 'error') {
          clock.clear();
          reject(new Error(`${message.code}: ${message.message}\nstderr:\n${stderr}`));
        }
      });
    });

    writeJson(child, {
      type: 'init',
      apiKey: 'test',
      model: 'subtask-e2e-model',
      cwd: workspaceRootPath,
      workingDirectory: workspaceRootPath,
      workspaceRootPath,
      workspaceId,
      sessionId,
      sessionPath,
      plansFolderPath: join(sessionPath, 'plans'),
      thinkingLevel: 'off',
      executionManifest,
      piAuth: { provider: 'faux', credential: { type: 'api_key', key: 'test' } },
    });

    try {
      await done;
    } finally {
      writeJson(child, { type: 'shutdown' });
      child.kill();
      stdout.close();
    }

    const result = messages.find(message => message.type === 'subtask_start_result');
    expect(result).toMatchObject({ id: 'subtask-e2e-1', ok: true, agentId: FORK_AGENT_ID });

    // The start the HOST sees. Without the task id it answers
    // `pi-background-child-task-id-required` and no child is ever created.
    expect(starts).toHaveLength(1);
    expect(starts[0]).toMatchObject({ agent: 'fork', background: true, restrictions: { fork: true } });
    expect(starts[0].backgroundTaskId).toMatch(/^task-fork-/);

    const events = messages.filter(message => message.type === 'event').map(message => message.event);
    const backgrounded = events.find(event => event?.type === 'task_backgrounded');
    expect(backgrounded).toMatchObject({
      taskId: starts[0].backgroundTaskId,
      toolUseId: 'subtask-e2e-1',
      kind: 'subagent',
    });
    const completed = events.find(event => event?.type === 'task_completed');
    expect(completed).toMatchObject({ taskId: starts[0].backgroundTaskId, status: 'completed' });
  }, TEST_TIMEOUT_MS);
});
