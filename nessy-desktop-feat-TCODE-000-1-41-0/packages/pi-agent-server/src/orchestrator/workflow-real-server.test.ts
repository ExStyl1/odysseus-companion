import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
/** F1.607 — the ANSWER budget, from the child's first `ready`; the boot has its own (`real-server-clock.ts`). */
const REAL_SERVER_TIMEOUT_MS = 120_000;
const TEST_TIMEOUT_MS = realServerTestBudget(REAL_SERVER_TIMEOUT_MS);

function writeJson(child: ChildProcessWithoutNullStreams, message: Record<string, unknown>): void {
  child.stdin.write(`${JSON.stringify(message)}\n`);
}

function writeSse(res: http.ServerResponse, payload: unknown): void {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

async function startOpenAiStub(): Promise<{
  baseUrl: string;
  requestCount: () => number;
  close: () => Promise<void>;
}> {
  const workflowScript = `
    phase('first');
    const first = await agent({ agent: 'scout', task: 'Return exactly: workflow first child.' });
    phase('second');
    const second = await agent({ agent: 'reviewer', task: 'Review this previous result: ' + first + '. Return exactly: workflow second child.' });
    log('combined ' + first + ' ' + second);
    return { first, second, remaining: budget.remaining() };
  `;
  const responses = [
    {
      toolCall: {
        id: 'workflow-e2e-call',
        name: 'workflow',
        arguments: { script: workflowScript, tokenBudget: 1000 },
      },
    },
    { text: 'workflow first child' },
    { text: 'workflow second child' },
    { text: 'parent saw workflow result' },
  ];

  let requests = 0;
  const server = http.createServer((req, res) => {
    requests += 1;
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
      model: 'workflow-e2e-model',
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
    requestCount: () => requests,
    close: () => new Promise(resolve => server.close(() => resolve())),
  };
}

describe('workflow tool real server e2e', () => {
  it('streams workflow progress and result through JSONL stdout', async () => {
    const workspaceRootPath = mkdtempSync(join(tmpdir(), 'nessy-workflow-workspace-'));
    const sessionPath = mkdtempSync(join(tmpdir(), 'nessy-workflow-session-'));
    const workspaceId = 'workflow-e2e-workspace';
    const sessionId = 'workflow-e2e-session';
    const executionManifest = createRealServerExecutionManifest({ workspaceId, sessionId });
    const entrypoint = process.env.NESSY_PI_SERVER_ENTRYPOINT || defaultEntrypoint;
    const stub = await startOpenAiStub();
    const child = spawn(process.execPath, [entrypoint], {
      cwd: join(here, '..', '..', '..', '..'),
      env: { ...process.env, NO_COLOR: '1' },
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
        onExpire: (_phase, why) => reject(new Error(`workflow real-server e2e timed out — ${why}\nstderr:\n${stderr}`)),
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
            message: 'Use workflow for a two-phase scout then reviewer script.',
            systemPrompt: 'Call the workflow tool exactly once with a script that has two phases.',
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
            const agentId = input.requestedAgentId ?? `workflow-e2e-${input.agent}`;
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
      model: 'workflow-e2e-model',
      cwd: workspaceRootPath,
      workingDirectory: workspaceRootPath,
      workspaceRootPath,
      workspaceId,
      sessionId,
      sessionPath,
      plansFolderPath: join(sessionPath, 'plans'),
      thinkingLevel: 'off',
      baseUrl: stub.baseUrl,
      customEndpoint: { api: 'openai-completions' },
      customModels: ['workflow-e2e-model'],
      executionManifest,
      piAuth: { provider: 'custom-endpoint', credential: { type: 'api_key', key: 'test' } },
    });

    try {
      await done;
    } finally {
      writeJson(child, { type: 'shutdown' });
      child.kill();
      stdout.close();
      await stub.close();
    }

    const events = messages.filter(message => message.type === 'event').map(message => message.event);
    const updates = events.filter(event => event?.type === 'tool_execution_update' && event.toolName === 'workflow');
    const progressAgents = updates.flatMap(event => event.partialResult?.details?.progress?.agents ?? []);
    const end = events.find(event => event?.type === 'tool_execution_end' && event.toolName === 'workflow');

    expect(updates.length).toBeGreaterThanOrEqual(2);
    expect(progressAgents.some((agent: any) => agent.phase === 'first')).toBe(true);
    expect(progressAgents.some((agent: any) => agent.phase === 'second')).toBe(true);
    expect(end?.result?.details?.result?.kind).toBe('workflow');
    expect(end?.result?.details?.result?.status).toBe('done');
    expect(end?.result?.details?.result?.results).toHaveLength(2);
    expect(end?.result?.details?.journalPath).toContain('.orchestrator');

    console.log(`real-server workflow updates: ${updates.length}`);
    console.log(JSON.stringify(end?.result?.details?.result));
  }, TEST_TIMEOUT_MS);

  // CDP pass 9: a session whose cwd is already set at init (no cwd transaction
  // ever runs) must still load the project's saved workflow recipes, so a
  // slash launch by NAME resolves instead of "Unknown workflow recipe".
  it('resolves a saved project recipe by name for a trusted preset-cwd init', async () => {
    const workspaceRootPath = mkdtempSync(join(tmpdir(), 'nessy-workflow-preset-cwd-'));
    const sessionPath = mkdtempSync(join(tmpdir(), 'nessy-workflow-preset-cwd-session-'));
    mkdirSync(join(workspaceRootPath, '.nessy-agent', 'workflows'), { recursive: true });
    writeFileSync(join(workspaceRootPath, '.nessy-agent', 'workflows', 'pass8-demo.js'), [
      "export const meta = { name: 'pass8-demo', description: 'Pass 8 demo', phases: [{ title: 'Greet', detail: 'zero-agent check' }] }",
      "return 'greeted';",
    ].join('\n'));
    const workspaceId = 'workflow-preset-cwd-workspace';
    const sessionId = 'workflow-preset-cwd-session';
    const executionManifest = createRealServerExecutionManifest({ workspaceId, sessionId });
    const entrypoint = process.env.NESSY_PI_SERVER_ENTRYPOINT || defaultEntrypoint;
    const stub = await startOpenAiStub();
    const child = spawn(process.execPath, [entrypoint], {
      cwd: join(here, '..', '..', '..', '..'),
      env: { ...process.env, NO_COLOR: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stdout = createInterface({ input: child.stdout });
    let stderr = '';
    const messages: any[] = [];
    child.stderr.on('data', chunk => { stderr += String(chunk); });

    const result = new Promise<any>((resolve, reject) => {
      const clock = startRealServerClock({
        answerWaitMs: REAL_SERVER_TIMEOUT_MS,
        onExpire: (_phase, why) => reject(new Error(`preset-cwd workflow dispatch timed out — ${why}\n${stderr}`)),
      });
      child.on('error', reject);
      stdout.on('line', line => {
        let message: any;
        try { message = JSON.parse(line); } catch { return; }
        messages.push(message);
        if (message.type === 'ready') {
          clock.ready();
          writeJson(child, {
            type: 'workflow_execute',
            id: 'slash-workflow-preset-1',
            invocation: { name: 'pass8-demo', args: { input: '' } },
            message: '/pass8-demo',
            manifestGeneration: executionManifest.snapshotGeneration,
            manifestHash: executionManifest.manifestHash,
          });
        } else if (message.type === 'pre_tool_use_request') {
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
        } else if (message.type === 'post_tool_use_request') {
          writeJson(child, { type: 'post_tool_use_response', requestId: message.requestId });
        } else if (message.type === 'workflow_execute_result') {
          clock.clear();
          resolve(message);
        } else if (message.type === 'error' || message.type === 'startup_error') {
          clock.clear();
          reject(new Error(`${message.code ?? message.type}: ${message.message}\n${stderr}`));
        }
      });
    });

    writeJson(child, {
      type: 'init',
      apiKey: 'test',
      model: 'workflow-e2e-model',
      cwd: workspaceRootPath,
      workingDirectory: workspaceRootPath,
      workspaceRootPath,
      // The host-resolved eligibility for the PRESET cwd; no cwd transaction
      // will ever deliver it later.
      projectTrusted: true,
      workspaceId,
      sessionId,
      sessionPath,
      plansFolderPath: join(sessionPath, 'plans'),
      thinkingLevel: 'off',
      baseUrl: stub.baseUrl,
      customEndpoint: { api: 'openai-completions' },
      customModels: ['workflow-e2e-model'],
      executionManifest,
      piAuth: { provider: 'custom-endpoint', credential: { type: 'api_key', key: 'test' } },
    });

    try {
      await expect(result).resolves.toMatchObject({
        type: 'workflow_execute_result',
        id: 'slash-workflow-preset-1',
        ok: true,
        details: {
          returnValue: 'greeted',
          result: { kind: 'workflow', status: 'done' },
        },
      });
      expect(stub.requestCount()).toBe(0);
    } finally {
      writeJson(child, { type: 'shutdown' });
      child.kill();
      stdout.close();
      await stub.close();
      rmSync(workspaceRootPath, { recursive: true, force: true });
      rmSync(sessionPath, { recursive: true, force: true });
    }
  }, TEST_TIMEOUT_MS);

  it('executes a structured slash workflow through the production handler without a model request', async () => {
    const workspaceRootPath = mkdtempSync(join(tmpdir(), 'nessy-workflow-slash-workspace-'));
    const sessionPath = mkdtempSync(join(tmpdir(), 'nessy-workflow-slash-session-'));
    const workspaceId = 'workflow-slash-workspace';
    const sessionId = 'workflow-slash-session';
    const executionManifest = createRealServerExecutionManifest({ workspaceId, sessionId });
    const entrypoint = process.env.NESSY_PI_SERVER_ENTRYPOINT || defaultEntrypoint;
    const stub = await startOpenAiStub();
    const child = spawn(process.execPath, [entrypoint], {
      cwd: join(here, '..', '..', '..', '..'),
      env: { ...process.env, NO_COLOR: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stdout = createInterface({ input: child.stdout });
    let stderr = '';
    const messages: any[] = [];
    child.stderr.on('data', chunk => { stderr += String(chunk); });

    const result = new Promise<any>((resolve, reject) => {
      const clock = startRealServerClock({
        answerWaitMs: REAL_SERVER_TIMEOUT_MS,
        onExpire: (_phase, why) => reject(new Error(`workflow slash dispatch timed out — ${why}\n${stderr}`)),
      });
      child.on('error', reject);
      stdout.on('line', line => {
        let message: any;
        try { message = JSON.parse(line); } catch { return; }
        messages.push(message);
        if (message.type === 'ready') {
          clock.ready();
          writeJson(child, {
            type: 'workflow_execute',
            id: 'slash-workflow-1',
            invocation: {
              script: 'return { source: "structured-slash", input: args.input };',
              args: { input: 'release readiness' },
            },
            message: '/audit release readiness',
            manifestGeneration: executionManifest.snapshotGeneration,
            manifestHash: executionManifest.manifestHash,
          });
        } else if (message.type === 'pre_tool_use_request') {
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
        } else if (message.type === 'post_tool_use_request') {
          writeJson(child, { type: 'post_tool_use_response', requestId: message.requestId });
        } else if (message.type === 'workflow_execute_result') {
          clock.clear();
          resolve(message);
        } else if (message.type === 'error' || message.type === 'startup_error') {
          clock.clear();
          reject(new Error(`${message.code ?? message.type}: ${message.message}\n${stderr}`));
        }
      });
    });

    writeJson(child, {
      type: 'init',
      apiKey: 'test',
      model: 'workflow-e2e-model',
      cwd: workspaceRootPath,
      workingDirectory: workspaceRootPath,
      workspaceRootPath,
      projectTrusted: false,
      workspaceId,
      sessionId,
      sessionPath,
      plansFolderPath: join(sessionPath, 'plans'),
      thinkingLevel: 'off',
      baseUrl: stub.baseUrl,
      customEndpoint: { api: 'openai-completions' },
      customModels: ['workflow-e2e-model'],
      executionManifest,
      piAuth: { provider: 'custom-endpoint', credential: { type: 'api_key', key: 'test' } },
    });

    try {
      await expect(result).resolves.toMatchObject({
        type: 'workflow_execute_result',
        id: 'slash-workflow-1',
        ok: true,
        details: {
          returnValue: { source: 'structured-slash', input: 'release readiness' },
          result: { kind: 'workflow', status: 'done' },
        },
      });
      expect(stub.requestCount()).toBe(0);
      expect(messages.some(message => message.type === 'pre_tool_use_request')).toBe(true);
    } finally {
      writeJson(child, { type: 'shutdown' });
      child.kill();
      stdout.close();
      await stub.close();
      rmSync(workspaceRootPath, { recursive: true, force: true });
      rmSync(sessionPath, { recursive: true, force: true });
    }
  }, TEST_TIMEOUT_MS);
});
