import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'bun:test';

import { createRealServerExecutionManifest } from '../__tests__/real-server-execution-manifest.ts';
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

async function collectBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function startOpenAiStub(): Promise<{ baseUrl: string; requestBodies: string[]; close: () => Promise<void> }> {
  const requestBodies: string[] = [];
  const responses = [
    {
      toolCall: {
        id: 'ask-user-e2e-call',
        name: 'ask_user',
        arguments: {
          question: 'Which path should I take?',
          options: ['Ship it', 'Stop'],
          allowFreeText: false,
        },
      },
    },
    { text: 'parent saw Ship it' },
  ];

  const server = http.createServer(async (req, res) => {
    requestBodies.push(await collectBody(req));
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
      model: 'ask-user-e2e-model',
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
    requestBodies,
    close: () => new Promise(resolve => server.close(() => resolve())),
  };
}

describe('ask_user tool real server e2e', () => {
  it('round-trips the scripted answer over JSONL and returns it to the model', async () => {
    const workspaceRootPath = mkdtempSync(join(tmpdir(), 'nessy-ask-user-workspace-'));
    const sessionPath = mkdtempSync(join(tmpdir(), 'nessy-ask-user-session-'));
    const workspaceId = 'ask-user-e2e-workspace';
    const sessionId = 'ask-user-e2e-session';
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
        onExpire: (_phase, why) => reject(new Error(`ask_user real-server e2e timed out — ${why}\nstderr:\n${stderr}`)),
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
            message: 'Ask me which path to take, then continue with my answer.',
            systemPrompt: 'Call ask_user exactly once, then continue after the tool returns.',
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
          });
          return;
        }

        if (message.type === 'ask_user_request') {
          writeJson(child, {
            type: 'ask_user_response',
            requestId: message.requestId,
            answer: { type: 'option', value: 'Ship it', optionIndex: 0 },
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
      model: 'ask-user-e2e-model',
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
      customModels: ['ask-user-e2e-model'],
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

    const askRequest = messages.find(message => message.type === 'ask_user_request');
    const events = messages.filter(message => message.type === 'event').map(message => message.event);
    const end = events.find(event => event?.type === 'tool_execution_end' && event.toolName === 'ask_user');

    expect(askRequest?.question).toBe('Which path should I take?');
    expect(askRequest?.options).toEqual(['Ship it', 'Stop']);
    expect(end?.result?.content?.[0]?.text).toContain('Ship it');
    expect(stub.requestBodies.some(body => body.includes('User selected option 1: Ship it'))).toBe(true);

    console.log(`real-server ask_user requests: ${messages.filter(message => message.type === 'ask_user_request').length}`);
    console.log(end?.result?.content?.[0]?.text);
  }, TEST_TIMEOUT_MS);

  it('emits ask_user_cancel when the tool times out before a user answer', async () => {
    const workspaceRootPath = mkdtempSync(join(tmpdir(), 'nessy-ask-user-timeout-workspace-'));
    const sessionPath = mkdtempSync(join(tmpdir(), 'nessy-ask-user-timeout-session-'));
    const workspaceId = 'ask-user-timeout-e2e-workspace';
    const sessionId = 'ask-user-timeout-e2e-session';
    const executionManifest = createRealServerExecutionManifest({ workspaceId, sessionId });
    const entrypoint = process.env.NESSY_PI_SERVER_ENTRYPOINT || defaultEntrypoint;
    const stub = await startOpenAiStub();
    const child = spawn(process.execPath, [entrypoint], {
      cwd: join(here, '..', '..', '..', '..'),
      env: { ...process.env, NO_COLOR: '1', NESSY_ASK_USER_TIMEOUT_MS: '5' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stdout = createInterface({ input: child.stdout });
    let stderr = '';
    let promptSent = false;
    let askRequestId = '';
    const messages: any[] = [];

    child.stderr.on('data', chunk => {
      stderr += String(chunk);
    });

    const done = new Promise<void>((resolve, reject) => {
      const clock = startRealServerClock({
        answerWaitMs: REAL_SERVER_TIMEOUT_MS,
        onExpire: (_phase, why) => reject(new Error(`ask_user timeout cancel e2e timed out — ${why}\nstderr:\n${stderr}`)),
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
            id: 'prompt-timeout',
            message: 'Ask me which path to take, then continue with my answer.',
            systemPrompt: 'Call ask_user exactly once, then continue after the tool returns.',
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
          });
          return;
        }

        if (message.type === 'ask_user_request') {
          askRequestId = message.requestId;
          return;
        }

        if (message.type === 'ask_user_cancel') {
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
      model: 'ask-user-e2e-model',
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
      customModels: ['ask-user-e2e-model'],
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

    const cancel = messages.find(message => message.type === 'ask_user_cancel');
    expect(askRequestId).toBeTruthy();
    expect(cancel).toEqual({
      type: 'ask_user_cancel',
      requestId: askRequestId,
      reason: 'timed_out',
    });
  }, TEST_TIMEOUT_MS);
});
