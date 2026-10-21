import { createHash } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'bun:test';
import { realServerTestBudget, startRealServerClock } from './__tests__/support/real-server-clock.ts';

import { createRealServerExecutionManifest } from './__tests__/real-server-execution-manifest.ts';

const here = dirname(fileURLToPath(import.meta.url));
const defaultEntrypoint = join(here, 'index.ts');
/** F1.546 — the ANSWER budget, from the child's first `ready`; the boot has its own (`real-server-clock.ts`). */
const REAL_SERVER_TIMEOUT_MS = 120_000;
const TEST_TIMEOUT_MS = realServerTestBudget(REAL_SERVER_TIMEOUT_MS);

const CATEGORY_IDS = [
  'system_prompt',
  'system_tools',
  'mcp_tools',
  'custom_subagents',
  'memory_files',
  'skills',
  'conversation_messages',
];

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function writeJson(child: ChildProcessWithoutNullStreams, message: Record<string, unknown>): void {
  child.stdin.write(`${JSON.stringify(message)}\n`);
}

function writeSse(res: http.ServerResponse, payload: unknown): void {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

/** One plain text completion per request — enough to run a real prompt turn. */
async function startOpenAiStub(): Promise<{ baseUrl: string; close: () => Promise<void> }> {
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
      model: 'context-e2e-model',
    };
    writeSse(res, {
      ...base,
      choices: [{ index: 0, delta: { content: 'context accounted' }, finish_reason: null }],
    });
    writeSse(res, {
      ...base,
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 90_000, completion_tokens: 5, total_tokens: 90_005 },
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

/** A descriptor that passes parsePiRuntimeAgentDefinitions' hash validation. */
function runtimeAgentDescriptor(capabilityGeneration: string) {
  const systemPrompt = 'Inspect concisely.';
  const parsed = {
    schemaVersion: 2 as const,
    key: 'plugin://honey#agent.hive-scout@workspace',
    name: 'hive-scout',
    description: 'Honey scout',
    selectedAsUnqualifiedAlias: true,
    systemPrompt,
    sha256: sha256(systemPrompt),
    provenance: 'plugin://honey#agent.hive-scout@workspace@generation-live',
    capabilityGeneration,
  };
  return { ...parsed, definitionDigest: sha256(JSON.stringify(parsed)) };
}

const AGENTS_MD_CONTENT = '# Project guide\n\nAlways run bun test from the repo root.\n';

function contextResourceDescriptor() {
  const contentHash = sha256(AGENTS_MD_CONTENT);
  return {
    schemaVersion: 1 as const,
    id: `cap-instruction-project_AGENTS.md-${sha256('instruction:project:AGENTS.md').slice(0, 8)}-${contentHash.slice(0, 12)}`,
    kind: 'agent-instruction' as const,
    content: AGENTS_MD_CONTENT,
    sha256: contentHash,
    provenance: 'project:AGENTS.md@generation-live',
  };
}

describe('context usage categories real server e2e', () => {
  // CDP pass 9 gap: the snapshot only flowed on the three host RPC paths
  // (compact, update_runtime_config, set_model) — a plain completed model turn
  // never emitted it, so live sessions showed "Current context 0" forever.
  it('emits the category snapshot on turn completion without any RPC', async () => {
    const workspaceRootPath = mkdtempSync(join(tmpdir(), 'nessy-context-turn-workspace-'));
    const sessionPath = mkdtempSync(join(tmpdir(), 'nessy-context-turn-session-'));
    const workspaceId = 'context-turn-workspace';
    const sessionId = 'context-turn-session';
    const executionManifest = createRealServerExecutionManifest({ workspaceId, sessionId });
    const entrypoint = process.env.NESSY_PI_SERVER_ENTRYPOINT || defaultEntrypoint;
    const stub = await startOpenAiStub();
    const child = spawn(process.execPath, [entrypoint], {
      cwd: join(here, '..', '..', '..'),
      env: { ...process.env, NO_COLOR: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stdout = createInterface({ input: child.stdout });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += String(chunk); });
    const events: any[] = [];
    let promptSent = false;

    const done = new Promise<void>((resolve, reject) => {
      const clock = startRealServerClock({
        answerWaitMs: REAL_SERVER_TIMEOUT_MS,
        onExpire: (_phase, why) => reject(new Error(`turn-completion snapshot e2e timed out — ${why}\nstderr:\n${stderr}`)),
      });
      child.on('error', error => { clock.clear(); reject(error); });
      stdout.on('line', line => {
        let message: any;
        try { message = JSON.parse(line); } catch { return; }
        if (message.type === 'event') events.push(message.event);

        if (message.type === 'ready') clock.ready();
        if (message.type === 'ready' && !promptSent) {
          promptSent = true;
          writeJson(child, {
            type: 'prompt',
            id: 'prompt-1',
            message: 'Summarize the repo state.',
            systemPrompt: 'You are the Nessy assistant.',
            manifestGeneration: executionManifest.snapshotGeneration,
            manifestHash: executionManifest.manifestHash,
          });
          return;
        }
        if (message.type === 'event' && message.event?.type === 'agent_end' && promptSent) {
          clock.clear();
          resolve();
          return;
        }
        if (message.type === 'error' || message.type === 'startup_error') {
          clock.clear();
          reject(new Error(`${message.code ?? message.type}: ${message.message}\nstderr:\n${stderr}`));
        }
      });
    });

    writeJson(child, {
      type: 'init',
      apiKey: 'test',
      model: 'context-e2e-model',
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
      customModels: ['context-e2e-model'],
      executionManifest,
      piRuntimeAgentDefinitions: [runtimeAgentDescriptor(executionManifest.snapshotGeneration)],
      piContextResources: [contextResourceDescriptor()],
      piAuth: { provider: 'custom-endpoint', credential: { type: 'api_key', key: 'test' } },
    });

    try {
      await done;
    } finally {
      writeJson(child, { type: 'shutdown' });
      child.kill();
      stdout.close();
      await stub.close();
      rmSync(workspaceRootPath, { recursive: true, force: true });
      rmSync(sessionPath, { recursive: true, force: true });
    }

    // The snapshot must ride the TURN path itself, before the agent_end that
    // completes the host's event queue — no get_context_usage, no set_model.
    const agentEndIndex = events.findIndex(event => event?.type === 'agent_end');
    expect(agentEndIndex).toBeGreaterThan(-1);
    const turnUsage = events
      .slice(0, agentEndIndex)
      .find(event => event?.type === 'context_usage_update');
    expect(turnUsage).toBeTruthy();
    expect((turnUsage.usage.categories ?? []).map((category: any) => category.id)).toEqual(CATEGORY_IDS);
    expect(turnUsage.usage.loadedFiles).toEqual([
      { name: 'project:AGENTS.md', kind: 'instruction', tokens: expect.any(Number) },
    ]);
  }, TEST_TIMEOUT_MS);

  it('carries the category breakdown and loaded files on the production wire', async () => {
    const workspaceRootPath = mkdtempSync(join(tmpdir(), 'nessy-context-usage-workspace-'));
    const sessionPath = mkdtempSync(join(tmpdir(), 'nessy-context-usage-session-'));
    const workspaceId = 'context-usage-workspace';
    const sessionId = 'context-usage-session';
    const executionManifest = createRealServerExecutionManifest({ workspaceId, sessionId });
    const entrypoint = process.env.NESSY_PI_SERVER_ENTRYPOINT || defaultEntrypoint;
    const stub = await startOpenAiStub();
    const child = spawn(process.execPath, [entrypoint], {
      cwd: join(here, '..', '..', '..'),
      env: { ...process.env, NO_COLOR: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stdout = createInterface({ input: child.stdout });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += String(chunk); });
    const messages: any[] = [];
    let promptSent = false;
    let usageRequested = false;
    let modelChangeRequested = false;
    let polledUsage: any;
    let updateEventUsage: any;

    const done = new Promise<void>((resolve, reject) => {
      const clock = startRealServerClock({
        answerWaitMs: REAL_SERVER_TIMEOUT_MS,
        onExpire: (_phase, why) => reject(new Error(`context usage real-server e2e timed out — ${why}\nstderr:\n${stderr}`)),
      });
      child.on('error', error => { clock.clear(); reject(error); });
      stdout.on('line', line => {
        let message: any;
        try { message = JSON.parse(line); } catch { return; }
        messages.push(message);

        if (message.type === 'ready') clock.ready();
        if (message.type === 'ready' && !promptSent) {
          promptSent = true;
          writeJson(child, {
            type: 'prompt',
            id: 'prompt-1',
            message: 'Summarize the repo state.',
            systemPrompt: [
              'You are the Nessy assistant.',
              '<available_skills>\n- [skill:review] — Review a diff for correctness.\n</available_skills>',
            ].join('\n\n'),
            manifestGeneration: executionManifest.snapshotGeneration,
            manifestHash: executionManifest.manifestHash,
          });
          return;
        }
        if (message.type === 'event' && message.event?.type === 'agent_end' && promptSent && !usageRequested) {
          usageRequested = true;
          writeJson(child, { type: 'get_context_usage', id: 'usage-1' });
          return;
        }
        if (message.type === 'context_usage_result' && message.id === 'usage-1') {
          polledUsage = message.usage;
          if (!modelChangeRequested) {
            modelChangeRequested = true;
            writeJson(child, { type: 'set_model', model: 'context-e2e-model' });
          }
          return;
        }
        // The production emit path under test: set_model emits
        // context_usage_update; the breakdown must ride THIS event.
        if (message.type === 'event' && message.event?.type === 'context_usage_update' && modelChangeRequested) {
          updateEventUsage = message.event.usage;
          clock.clear();
          resolve();
          return;
        }
        if (message.type === 'error' || message.type === 'startup_error') {
          clock.clear();
          reject(new Error(`${message.code ?? message.type}: ${message.message}\nstderr:\n${stderr}`));
        }
      });
    });

    writeJson(child, {
      type: 'init',
      apiKey: 'test',
      model: 'context-e2e-model',
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
      customModels: ['context-e2e-model'],
      executionManifest,
      piRuntimeAgentDefinitions: [runtimeAgentDescriptor(executionManifest.snapshotGeneration)],
      piContextResources: [contextResourceDescriptor()],
      piAuth: { provider: 'custom-endpoint', credential: { type: 'api_key', key: 'test' } },
    });

    try {
      await done;
    } finally {
      writeJson(child, { type: 'shutdown' });
      child.kill();
      stdout.close();
      await stub.close();
      rmSync(workspaceRootPath, { recursive: true, force: true });
      rmSync(sessionPath, { recursive: true, force: true });
    }

    for (const [label, usage] of [['polled context_usage_result', polledUsage], ['context_usage_update event', updateEventUsage]] as const) {
      expect(usage, label).toBeTruthy();
      const categories = usage.categories ?? [];
      expect(categories.map((category: any) => category.id), label).toEqual(CATEGORY_IDS);
      const byId = new Map(categories.map((category: any) => [category.id, category]));
      // The production strings all have content, so their rows are non-zero.
      expect((byId.get('system_prompt') as any).tokens, label).toBeGreaterThan(0);
      expect((byId.get('skills') as any).tokens, label).toBeGreaterThan(0);
      expect((byId.get('system_tools') as any).tokens, label).toBeGreaterThan(0);
      expect((byId.get('conversation_messages') as any).tokens, label).toBeGreaterThan(0);
      expect((byId.get('custom_subagents') as any).items, label).toEqual([
        {
          name: 'hive-scout',
          tokens: expect.any(Number),
          source: 'plugin://honey#agent.hive-scout@workspace@generation-live',
        },
      ]);
      expect(usage.loadedFiles, label).toEqual([
        { name: 'project:AGENTS.md', kind: 'instruction', tokens: expect.any(Number) },
      ]);
      const sum = categories.reduce((total: number, category: any) => total + category.tokens, 0);
      if (usage.inputTokens !== null && usage.inputTokens !== undefined) {
        expect(sum + usage.unattributedTokens, label).toBe(usage.inputTokens);
      } else {
        expect(usage.unattributedTokens, label).toBeNull();
      }
    }
  }, TEST_TIMEOUT_MS);
});
