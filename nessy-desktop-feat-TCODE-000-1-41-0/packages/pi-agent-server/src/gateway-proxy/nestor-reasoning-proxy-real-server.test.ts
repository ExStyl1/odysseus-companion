import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'bun:test';

import { createRealServerExecutionManifest } from '../__tests__/real-server-execution-manifest.ts';
import { REAL_SERVER_BOOT_WAIT_MS, realServerTestBudget, startRealServerClock } from '../__tests__/support/real-server-clock.ts';
import { startNestorReasoningProxy } from './nestor-reasoning-proxy.ts';

const here = dirname(fileURLToPath(import.meta.url));
const defaultEntrypoint = join(here, '..', 'index.ts');
const SERVER_STARTUP_TIMEOUT_MS = REAL_SERVER_BOOT_WAIT_MS;
const REAL_SERVER_TIMEOUT_MS = 120_000;
const TEST_TIMEOUT_MS = SERVER_STARTUP_TIMEOUT_MS + realServerTestBudget(REAL_SERVER_TIMEOUT_MS); // startup, init -> ready, answers

function writeJson(child: ChildProcessWithoutNullStreams, message: Record<string, unknown>): void {
  child.stdin.write(`${JSON.stringify(message)}\n`);
}

function writeSse(res: http.ServerResponse, payload: unknown): void {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

async function startOpenAiThinkingStub(): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    req.resume();
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });

    const base = {
      id: `chatcmpl-${Date.now()}`,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model: 'tgpt/qwen35-397b-a17b-fp8',
    };

    writeSse(res, {
      ...base,
      choices: [{ index: 0, delta: { content: '<thi' }, finish_reason: null }],
    });
    writeSse(res, {
      ...base,
      choices: [{ index: 0, delta: { content: 'nk>plan</thi' }, finish_reason: null }],
    });
    writeSse(res, {
      ...base,
      choices: [{ index: 0, delta: { content: 'nk>clean answer' }, finish_reason: null }],
    });
    writeSse(res, {
      ...base,
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 5,
        reasoning_tokens: 2,
        total_tokens: 17,
      },
    });
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

/**
 * The upstream here is a LOCAL stub, not the gateway — so since C6 this case is
 * the BYO half: a non-gateway endpoint running one of the two Qwen ids, which
 * is exactly the connection whose answers leaked `<think>` before.
 */
describe('Nestor reasoning proxy real server e2e', () => {
  it('surfaces proxied think spans as Pi thinking deltas and keeps root text clean', async () => {
    const workspaceRootPath = mkdtempSync(join(tmpdir(), 'nessy-reasoning-proxy-workspace-'));
    const sessionPath = mkdtempSync(join(tmpdir(), 'nessy-reasoning-proxy-session-'));
    const workspaceId = 'reasoning-proxy-e2e-workspace';
    const sessionId = 'reasoning-proxy-e2e-session';
    const executionManifest = createRealServerExecutionManifest({ workspaceId, sessionId });
    const entrypoint = process.env.NESSY_PI_SERVER_ENTRYPOINT || defaultEntrypoint;
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

    // The module-graph boot is slow on a cold cache (F1.607: it gets REAL_SERVER_BOOT_WAIT_MS). Wait for the child to
    // start before opening the proxy fixtures, then the turn's two-phase clock times init -> ready apart from the answers.
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        child.kill();
        reject(new Error(`pi server startup timed out\nstderr:\n${stderr}`));
      }, SERVER_STARTUP_TIMEOUT_MS);
      const checkStarted = () => {
        if (!stderr.includes('[pi-server] Pi agent server starting')) return;
        clearTimeout(timeout);
        resolve();
      };
      child.stderr.on('data', checkStarted);
      child.once('error', error => {
        clearTimeout(timeout);
        reject(error);
      });
      child.once('exit', (code, signal) => {
        clearTimeout(timeout);
        reject(new Error(`pi server exited before startup: code=${code} signal=${signal}\nstderr:\n${stderr}`));
      });
      checkStarted();
    });

    const stub = await startOpenAiThinkingStub();
    const proxy = await startNestorReasoningProxy(stub.baseUrl);

    const done = new Promise<void>((resolve, reject) => {
      const clock = startRealServerClock({
        answerWaitMs: REAL_SERVER_TIMEOUT_MS,
        onExpire: (_phase, why) => {
          const observed = messages.map(message => ({ type: message?.type, eventType: message?.event?.type, code: message?.code }));
          reject(new Error(`reasoning proxy real-server e2e timed out — ${why}\nobserved:\n${JSON.stringify(observed)}\nstderr:\n${stderr}`));
        },
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
            message: 'Return a concise answer.',
            manifestGeneration: executionManifest.snapshotGeneration,
            manifestHash: executionManifest.manifestHash,
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
      model: 'tgpt/qwen35-397b-a17b-fp8',
      cwd: workspaceRootPath,
      workingDirectory: workspaceRootPath,
      workspaceRootPath,
      workspaceId,
      sessionId,
      sessionPath,
      plansFolderPath: join(sessionPath, 'plans'),
      thinkingLevel: 'off',
      baseUrl: proxy.localBaseUrl,
      customEndpoint: { api: 'openai-completions' },
      customModels: ['tgpt/qwen35-397b-a17b-fp8'],
      executionManifest,
      piAuth: { provider: 'custom-endpoint', credential: { type: 'api_key', key: 'test' } },
    });

    try {
      await done;
    } finally {
      writeJson(child, { type: 'shutdown' });
      child.kill();
      stdout.close();
      await proxy.close();
      await stub.close();
    }

    const events = messages.filter(message => message.type === 'event').map(message => message.event);
    const assistantUpdates = events
      .filter(event => event?.type === 'message_update')
      .map(event => event.assistantMessageEvent);
    const thinkingText = assistantUpdates
      .filter(event => event?.type === 'thinking_delta')
      .map(event => event.delta)
      .join('');
    const rootText = assistantUpdates
      .filter(event => event?.type === 'text_delta')
      .map(event => event.delta)
      .join('');

    expect(thinkingText).toBe('plan');
    expect(rootText).toBe('clean answer');
    expect(rootText).not.toContain('<think');
    expect(rootText).not.toContain('</think>');
  }, TEST_TIMEOUT_MS);
});
