import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'bun:test';

import { createRealServerExecutionManifest } from './real-server-execution-manifest.ts';
import { realServerTestBudget, startRealServerClock } from './support/real-server-clock.ts';

/** F1.546 — from the child's first `ready`; the boot has its own budget (`support/real-server-clock.ts`). */
const ANSWER_WAIT_MS = 300_000;

const here = dirname(fileURLToPath(import.meta.url));
const entrypoint = join(here, '..', 'index.ts');
const adapterUrl = new URL('../compat/pi-runtime-adapter.ts', import.meta.url).href;
const repoRoot = join(here, '..', '..', '..', '..');

async function startStub(): Promise<{ baseUrl: string; requests: string[]; close(): Promise<void> }> {
  const requests: string[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += String(chunk); });
    req.on('end', () => {
      requests.push(body);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const base = { id: 'h1a', object: 'chat.completion.chunk', created: 1, model: 'h1a-model' };
      res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: null }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } })}\n\n`);
      res.end('data: [DONE]\n\n');
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('stub did not bind');
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests,
    close: () => new Promise(resolve => server.close(() => resolve())),
  };
}

describe('H1A real Pi server runtime adapter', () => {
  it('validates before ready and runs main plus ephemeral construction through 0.84.3', async () => {
    const stub = await startStub();
    const sessionPath = mkdtempSync(join(tmpdir(), 'nessy-h1a-session-'));
    const cwd = mkdtempSync(join(tmpdir(), 'nessy-h1a-cwd-'));
    const workspaceId = 'h1a-real-server-workspace';
    const sessionId = 'h1a-real-server';
    const executionManifest = createRealServerExecutionManifest({ workspaceId, sessionId });
    const disposeMarker = join(sessionPath, 'ephemeral-disposed');
    const preloadPath = join(sessionPath, 'subscribe-throw-preload.ts');
    writeFileSync(preloadPath, `
      import { mock } from 'bun:test';
      import { writeFileSync } from 'node:fs';
      const actual = await import(${JSON.stringify(adapterUrl)});
      const createRuntimeAdapter = actual.createPiRuntimeAdapter;
      mock.module(${JSON.stringify(adapterUrl)}, () => ({
        ...actual,
        createPiRuntimeAdapter(...args) {
          const adapter = createRuntimeAdapter(...args);
          let createCount = 0;
          return {
            ...adapter,
            async createSession(options) {
              const handle = await adapter.createSession(options);
              createCount += 1;
              if (createCount === 3) {
                handle.session.subscribe = () => { throw new Error('H1A_SUBSCRIBE_THROW'); };
                const dispose = handle.dispose.bind(handle);
                handle.dispose = () => {
                  writeFileSync(${JSON.stringify(disposeMarker)}, 'disposed');
                  return dispose();
                };
              }
              return handle;
            },
          };
        },
      }));
    `);
    const child = spawn(process.execPath, ['--preload', preloadPath, entrypoint], {
      cwd: repoRoot,
      env: { ...process.env, NO_COLOR: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const lines = createInterface({ input: child.stdout });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += String(chunk); });

    const result = new Promise<{
      runtimeVersion: string;
      queryText: string;
      subscribeError: string;
    }>((resolve, reject) => {
      const clock = startRealServerClock({
        answerWaitMs: ANSWER_WAIT_MS,
        onExpire: (_phase, message) => reject(new Error(`H1A ${message}\n${stderr}`)),
      });
      let runtimeVersion = '';
      let queryText = '';
      let prompted = false;
      let queried = false;
      let awaitingSubscribeFailure = false;
      child.on('error', reject);
      lines.on('line', line => {
        let message: any;
        try { message = JSON.parse(line); } catch { return; }
        if (message.type === 'startup_error' || (
          message.type === 'error'
          && !(awaitingSubscribeFailure && message.code === 'llm_query_error')
        )) {
          clock.clear();
          reject(new Error(`${message.code}: ${message.message}\n${stderr}`));
          return;
        }
        if (message.type === 'ready') clock.ready();
        if (message.type === 'ready' && !prompted) {
          runtimeVersion = message.runtimeVersion;
          prompted = true;
          child.stdin.write(`${JSON.stringify({
            type: 'prompt', id: 'main', message: 'main turn', systemPrompt: 'H1A_MAIN_PROMPT',
            manifestGeneration: executionManifest.snapshotGeneration,
            manifestHash: executionManifest.manifestHash,
          })}\n`);
          return;
        }
        if (message.type === 'event' && message.event?.type === 'agent_end' && !queried) {
          queried = true;
          child.stdin.write(`${JSON.stringify({
            type: 'llm_query', id: 'ephemeral', request: { prompt: 'ephemeral turn', systemPrompt: 'H1A_EPHEMERAL_PROMPT', model: 'h1a-model' },
          })}\n`);
          return;
        }
        if (message.type === 'llm_query_result' && message.id === 'ephemeral') {
          queryText = message.result?.text ?? '';
          awaitingSubscribeFailure = true;
          child.stdin.write(`${JSON.stringify({
            type: 'llm_query', id: 'subscribe-failure', request: { prompt: 'must dispose', model: 'h1a-model' },
          })}\n`);
          return;
        }
        if (message.type === 'llm_query_result' && message.id === 'subscribe-failure') {
          clock.clear();
          resolve({ runtimeVersion, queryText, subscribeError: message.errorMessage ?? '' });
        }
      });
    });

    child.stdin.write(`${JSON.stringify({
      type: 'init',
      apiKey: 'test',
      model: 'h1a-model',
      cwd,
      workingDirectory: cwd,
      workspaceRootPath: cwd,
      workspaceId,
      sessionId,
      sessionPath,
      plansFolderPath: join(sessionPath, 'plans'),
      thinkingLevel: 'off',
      baseUrl: stub.baseUrl,
      customEndpoint: { api: 'openai-completions' },
      customModels: ['h1a-model'],
      executionManifest,
      piAuth: { provider: 'custom-endpoint', credential: { type: 'api_key', key: 'test' } },
    })}\n`);

    try {
      expect(await result).toEqual({
        runtimeVersion: '0.87.1',
        queryText: 'ok',
        subscribeError: 'H1A_SUBSCRIBE_THROW',
      });
      expect(existsSync(disposeMarker)).toBe(true);
      expect(stub.requests.length).toBeGreaterThanOrEqual(2);
      expect(stub.requests.some(body => body.includes('H1A_MAIN_PROMPT'))).toBe(true);
      expect(stub.requests.some(body => body.includes('H1A_EPHEMERAL_PROMPT'))).toBe(true);
    } finally {
      child.stdin.write(`${JSON.stringify({ type: 'shutdown' })}\n`);
      child.kill();
      lines.close();
      await stub.close();
      rmSync(sessionPath, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  }, realServerTestBudget(ANSWER_WAIT_MS));

  it('routes main, ephemeral, and child construction through the adapter with disposal', () => {
    const indexSource = readFileSync(new URL('../index.ts', import.meta.url), 'utf8');
    const spawnerSource = readFileSync(new URL('../orchestrator/spawner.ts', import.meta.url), 'utf8');

    expect(indexSource).not.toContain('createAgentSession');
    expect(indexSource).toMatch(/createPiRuntimeAdapter/);
    // UPDATED 2026-08-21 (T7). The MAIN session's construction is still the
    // adapter's and `runtimeHandle` still receives it — the two halves this row
    // exists for — but the single call became a closure so that a carry fork
    // which throws can retry once as a plain resume instead of taking the
    // session down. Both halves are asserted separately rather than as one
    // regex, so a future change to either is named by the failure.
    expect(indexSource).toMatch(/const createWithStrategy = \(chosen: PiRuntimeSessionStrategy\) => runtimeAdapter\.createSession/);
    expect(indexSource).toMatch(/runtimeHandle\s*=\s*await createWithStrategy\(/);
    expect(indexSource).toMatch(/runtimeHandle\?*\.dispose\(\)/);
    expect(indexSource).toMatch(/ephemeralRuntime\s*=\s*await runtimeAdapter\.createSession/);
    expect(indexSource).toMatch(
      /let unsubscribe:[\s\S]*try\s*{[\s\S]*ephemeralSession\.subscribe[\s\S]*finally\s*{[\s\S]*unsubscribe\?\.\(\);[\s\S]*await ephemeralRuntime\.dispose\(\)/,
    );

    expect(spawnerSource).not.toContain('createAgentSession');
    expect(spawnerSource).not.toContain('createSessionManager');
    expect(spawnerSource).not.toMatch(/\bcreateSession\?:/);
    expect(spawnerSource).not.toContain('createPiRuntimeAdapter');
    expect(spawnerSource).not.toContain('runtimeAdapter');
    expect(spawnerSource).not.toContain('runtimeHandle');
    expect(spawnerSource).toContain('startWithAbort(cfg.childSessionPort, {');
    expect(spawnerSource).toContain('childSessionPort.start(input)');
  });
});
