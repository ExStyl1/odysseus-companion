import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'bun:test';

import {
  createRealServerAllowPermissionReceipt,
  createRealServerExecutionManifest,
} from '../__tests__/real-server-execution-manifest.ts';
import { realServerTestBudget, startRealServerClock } from '../__tests__/support/real-server-clock.ts';

const here = dirname(fileURLToPath(import.meta.url));
const defaultEntrypoint = join(here, '..', 'index.ts');
const preloadPath = join(here, 'subagent-background-e2e-preload.ts');
/** F1.607 — the ANSWER budget, from the child's first `ready`; the boot has its own (`real-server-clock.ts`). */
const REAL_SERVER_TIMEOUT_MS = 120_000;
const TEST_TIMEOUT_MS = realServerTestBudget(REAL_SERVER_TIMEOUT_MS);

// Durable agent id the harness pins for the single background child, so the
// scripted model can retrieve it verbatim through get_subagent_result.
const DURABLE_AGENT_ID = 'bg-agent-1';
const CHILD_RESULT = 'scout background child result';

function writeJson(child: ChildProcessWithoutNullStreams, message: Record<string, unknown>): void {
  child.stdin.write(`${JSON.stringify(message)}\n`);
}

describe('subagent tool default background real server e2e', () => {
  // The existing subagent-real-server.test.ts pins background:false (inline
  // path). This one exercises the S1 DEFAULT: a top-level subagent call with
  // `background` unset must background immediately (task id returned), fire a
  // task_completed event, and the durable result must be retrievable through
  // get_subagent_result by agent_id.
  it('backgrounds a top-level call by default and retrieves the durable result by agent_id', async () => {
    const workspaceRootPath = mkdtempSync(join(tmpdir(), 'nessy-subagent-bg-workspace-'));
    const sessionPath = mkdtempSync(join(tmpdir(), 'nessy-subagent-bg-session-'));
    const workspaceId = 'subagent-bg-e2e-workspace';
    const sessionId = 'subagent-bg-e2e-session';
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
    const messages: any[] = [];

    child.stderr.on('data', chunk => {
      stderr += String(chunk);
    });

    const done = new Promise<void>((resolve, reject) => {
      const clock = startRealServerClock({
        answerWaitMs: REAL_SERVER_TIMEOUT_MS,
        onExpire: (_phase, why) => reject(new Error(`subagent background real-server e2e timed out — ${why}\nstderr:\n${stderr}`)),
      });

      child.on('error', error => {
        clock.clear();
        reject(error);
      });

      const completedRecord = (agentId: string) => ({
        agentId,
        status: 'completed' as const,
        output: CHILD_RESULT,
        result: CHILD_RESULT,
        inputTokens: 1,
        outputTokens: 1,
        costUsd: 0,
      });

      stdout.on('line', line => {
        let message: any;
        try {
          message = JSON.parse(line);
        } catch {
          return;
        }
        messages.push(message);

        if (message.type === 'ready') clock.ready();
        if (message.type === 'ready' && !promptSent) {
          promptSent = true;
          writeJson(child, {
            type: 'prompt',
            id: 'prompt-1',
            message: 'Delegate one scout task, then retrieve its background result.',
            systemPrompt: 'Call subagent once with a single task, then get_subagent_result.',
            manifestGeneration: executionManifest.snapshotGeneration,
            manifestHash: executionManifest.manifestHash,
          });
          return;
        }

        if (message.type === 'pre_tool_use_request') {
          writeJson(child, {
            type: 'pre_tool_use_response',
            requestId: message.requestId,
            action: 'allow',
            receipt: createRealServerAllowPermissionReceipt(executionManifest, {
              requestId: message.requestId, manifestResponseEpoch: message.manifestResponseEpoch,
              piName: message.piName,
              semanticId: message.semanticId,
              input: message.input,
            }),
          });
          return;
        }

        if (message.type === 'post_tool_use_request') {
          writeJson(child, {
            type: 'post_tool_use_response',
            requestId: message.requestId,
          });
          return;
        }

        if (message.type === 'child_session_request') {
          const operation = message.request?.operation;
          if (operation === 'seal_owner_task') {
            writeJson(child, { type: 'child_session_response', requestId: message.requestId });
            return;
          }
          if (operation === 'start') {
            // Return `running` so the background spawner monitors to completion,
            // and pin the durable agent id the model will query later.
            writeJson(child, {
              type: 'child_session_response',
              requestId: message.requestId,
              result: { ...completedRecord(DURABLE_AGENT_ID), status: 'running' },
            });
            return;
          }
          if (operation === 'monitor' || operation === 'get_result') {
            // The background monitor and the later get_subagent_result pull both
            // resolve to the same completed durable record by agent_id.
            writeJson(child, {
              type: 'child_session_response',
              requestId: message.requestId,
              result: completedRecord(message.request.agentId ?? DURABLE_AGENT_ID),
            });
            return;
          }
          clock.clear();
          reject(new Error(`unexpected child operation: ${operation}`));
          return;
        }

        if (message.type === 'event' && message.event?.type === 'agent_end' && promptSent) {
          clock.clear();
          resolve();
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
      model: 'subagent-e2e-model',
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

    const events = messages.filter(message => message.type === 'event').map(message => message.event);

    // The default top-level call backgrounded: a task id was published up front.
    const backgrounded = events.find(event => event?.type === 'task_backgrounded');
    expect(backgrounded?.taskId).toBeTruthy();

    // The background run completed and fired task_completed for the same task id.
    const completed = events.find(event => event?.type === 'task_completed');
    expect(completed?.taskId).toBe(backgrounded.taskId);
    expect(completed?.status).toBe('completed');

    // The subagent tool_execution_end returned the task id immediately (not the
    // merged inline result), and the model saw it.
    const subagentEnd = events.find(event => event?.type === 'tool_execution_end' && event.toolName === 'subagent');
    expect(subagentEnd?.result?.details?.backgrounded).toBe(true);
    expect(subagentEnd?.result?.details?.taskId).toBe(backgrounded.taskId);
    expect(subagentEnd?.result?.details?.agentIds).toContain(DURABLE_AGENT_ID);

    // get_subagent_result pulled the durable record by agent_id and surfaced it.
    const getEnd = events.find(event => event?.type === 'tool_execution_end' && event.toolName === 'get_subagent_result');
    expect(getEnd?.result?.content?.[0]?.text).toContain(DURABLE_AGENT_ID);
    expect(getEnd?.result?.content?.[0]?.text).toContain(CHILD_RESULT);

    console.log(`background task id: ${backgrounded.taskId}`);
    console.log(`get_subagent_result text: ${getEnd?.result?.content?.[0]?.text}`);
  }, TEST_TIMEOUT_MS);
});
