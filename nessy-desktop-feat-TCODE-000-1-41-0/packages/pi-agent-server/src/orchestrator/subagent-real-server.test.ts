import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import http from 'node:http';
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
const preloadPath = join(here, 'subagent-e2e-preload.ts');
/** F1.607 — the ANSWER budget, from the child's first `ready`; the boot has its own (`real-server-clock.ts`). */
const REAL_SERVER_TIMEOUT_MS = 120_000;
const TEST_TIMEOUT_MS = realServerTestBudget(REAL_SERVER_TIMEOUT_MS);

function writeJson(child: ChildProcessWithoutNullStreams, message: Record<string, unknown>): void {
  child.stdin.write(`${JSON.stringify(message)}\n`);
}

function writeSse(res: http.ServerResponse, payload: unknown): void {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

async function startOpenAiStub(): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const responses = [
    {
      toolCall: {
        id: 'subagent-e2e-call',
        name: 'subagent',
        arguments: {
          // Explicit background:false pins the inline path this e2e streams
          // through; top-level calls otherwise default to background (S1).
          background: false,
          tasks: [
            { agent: 'scout', task: 'Return scout child output.' },
            { agent: 'reviewer', task: 'Return reviewer child output.' },
          ],
        },
      },
    },
    { text: 'scout child output' },
    { text: 'reviewer child output' },
    { text: 'parent saw merged subagent result' },
  ];

  const server = http.createServer((req, res) => {
    req.resume();
    const next = responses.shift();
    res.writeHead(next ? 200 : 500, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    if (!next) {
      writeSse(res, { error: { message: 'No more stub responses queued' } });
      res.end('data: [DONE]\n\n');
      return;
    }

    const base = {
      id: `chatcmpl-${Date.now()}`,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model: 'subagent-e2e-model',
    };
    // Guard on the VALUE, not the key. `responses` is an array of two
    // differently-shaped literals, so TS widens both members to carry the
    // other's key as optional-undefined — which means `'toolCall' in next`
    // cannot eliminate `undefined` and every read below stayed unchecked.
    if (next.toolCall !== undefined) {
      writeSse(res, {
        ...base,
        choices: [{
          index: 0,
          delta: {
            tool_calls: [{
              index: 0,
              id: next.toolCall.id,
              type: 'function',
              function: {
                name: next.toolCall.name,
                arguments: JSON.stringify(next.toolCall.arguments),
              },
            }],
          },
          finish_reason: null,
        }],
      });
      writeSse(res, {
        ...base,
        choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      });
    } else {
      writeSse(res, {
        ...base,
        choices: [{ index: 0, delta: { content: next.text }, finish_reason: null }],
      });
      writeSse(res, {
        ...base,
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      });
    }
    res.end('data: [DONE]\n\n');
  });

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('stub server did not bind to a TCP port');

  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    close: () => new Promise(resolve => server.close(() => resolve())),
  };
}

describe('subagent tool real server e2e', () => {
  it('streams parallel progress and merged result through JSONL stdout', async () => {
    const workspaceRootPath = mkdtempSync(join(tmpdir(), 'nessy-subagent-workspace-'));
    const sessionPath = mkdtempSync(join(tmpdir(), 'nessy-subagent-session-'));
    const workspaceId = 'subagent-e2e-workspace';
    const sessionId = 'subagent-e2e-session';
    const executionManifest = createRealServerExecutionManifest({ workspaceId, sessionId });
    const entrypoint = process.env.NESSY_PI_SERVER_ENTRYPOINT || defaultEntrypoint;
    const useCustomEndpointStub = Boolean(process.env.NESSY_PI_SERVER_ENTRYPOINT);
    const stub = useCustomEndpointStub ? await startOpenAiStub() : null;
    const child = spawn(process.execPath, useCustomEndpointStub ? [entrypoint] : ['--preload', preloadPath, entrypoint], {
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
        onExpire: (_phase, why) => reject(new Error(`subagent real-server e2e timed out — ${why}\nstderr:\n${stderr}`)),
      });

      child.on('error', error => {
        clock.clear();
        reject(error);
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
            message: 'Use subagent in parallel for scout and reviewer, then summarize.',
            systemPrompt: 'Call the subagent tool exactly once with two parallel tasks.',
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
          if (message.request?.operation === 'seal_owner_task') {
            writeJson(child, { type: 'child_session_response', requestId: message.requestId });
            return;
          }
          if (message.request?.operation === 'start') {
            const input = message.request.input;
            const agentId = input.requestedAgentId ?? `subagent-e2e-${input.agent}`;
            const result = `${input.agent}: ${input.task}`;
            writeJson(child, {
              type: 'child_session_response',
              requestId: message.requestId,
              result: {
                agentId,
                status: 'completed',
                output: result,
                result,
                inputTokens: 1,
                outputTokens: 1,
                costUsd: 0,
              },
            });
            return;
          }
          clock.clear();
          reject(new Error(`unexpected child operation: ${message.request?.operation}`));
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
      ...(stub ? {
        baseUrl: stub.baseUrl,
        customEndpoint: { api: 'openai-completions' },
        customModels: ['subagent-e2e-model'],
        piAuth: { provider: 'custom-endpoint', credential: { type: 'api_key', key: 'test' } },
      } : {
        piAuth: { provider: 'faux', credential: { type: 'api_key', key: 'test' } },
      }),
    });

    try {
      await done;
    } finally {
      writeJson(child, { type: 'shutdown' });
      child.kill();
      stdout.close();
      await stub?.close();
    }

    const events = messages.filter(message => message.type === 'event').map(message => message.event);
    const updates = events.filter(event => event?.type === 'tool_execution_update' && event.toolName === 'subagent');
    const progressAgents = updates.flatMap(event => event.partialResult?.details?.progress?.agents ?? []);
    const end = events.find(event => event?.type === 'tool_execution_end' && event.toolName === 'subagent');

    expect(updates.length).toBeGreaterThanOrEqual(2);
    expect(new Set(progressAgents.map((agent: any) => agent.agentType))).toEqual(new Set(['scout', 'reviewer']));
    expect(progressAgents.some((agent: any) => agent.status === 'done')).toBe(true);
    expect(end?.result?.details?.result?.status).toBe('done');
    expect(end?.result?.content?.[0]?.text).toContain('scout');
    expect(end?.result?.content?.[0]?.text).toContain('reviewer');

    console.log(`real-server subagent updates: ${updates.length}`);
    console.log(JSON.stringify(end?.result?.details?.result));
  }, TEST_TIMEOUT_MS);
});
