/**
 * D7 at spawn level — a session survives a mid-session capability bump WITH its
 * agents intact.
 *
 * The two unit tests pin each half's logic in isolation: the subprocess drops a
 * stale descriptor instead of throwing
 * (`orchestrator/runtime-agent-definitions.test.ts`), and the host sends
 * descriptors materialized for the new generation
 * (`shared/src/agent/__tests__/pi-agent-manifest-agent-refresh.test.ts`).
 * Neither can see the COMPOSITION, and the composition is where the regression
 * would hide: with the degrade half in place, an adopt regression is SILENT —
 * the session no longer dies, the agents simply disappear mid-session, and
 * nothing in CI notices. That is the gap this case exists to close.
 *
 * What it drives, end to end on the real subprocess:
 *   init at generation A carrying one agent definition
 *   → a turn (the agent is in the `custom_subagents` context category)
 *   → register_tools at generation B carrying REFRESHED definitions
 *   → another turn.
 *
 * That last turn is what used to die. `buildSessionDefinition` rebuilt the
 * agents from the init-time descriptors, found them stamped for generation A
 * against a manifest on B, and threw — killing not that turn but every turn of
 * the session, permanently, with no way back from the UI. Measured live
 * 2026-08-14 on a real profile: three reproductions, two controls, and the
 * precondition was an ordinary installed plugin that ships an agent capability.
 */
import { createHash } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'bun:test';

import {
  DEFAULT_PI_ORCHESTRATOR_CONFIG,
  finalizePiExecutionManifest,
  type PiExecutionManifestSeedV2,
  type PiExecutionManifestV2,
} from '../../../shared/src/agent/pi-harness/harness-manifest.ts';
import {
  PI_STATIC_MODEL_CONTRACT_HASHES,
  PI_TOOL_BINDINGS,
  getHarnessToolDescriptor,
} from '../../../shared/src/agent/pi-harness/harness-tool-descriptor.ts';
import { realServerTestBudget, startRealServerClock } from './support/real-server-clock.ts';

const here = dirname(fileURLToPath(import.meta.url));
const defaultEntrypoint = join(here, '..', 'index.ts');
/** F1.607 — the ANSWER budget, from the child's first `ready`; the boot has its own (`support/real-server-clock.ts`). */
const REAL_SERVER_TIMEOUT_MS = 120_000;
const TEST_TIMEOUT_MS = realServerTestBudget(REAL_SERVER_TIMEOUT_MS);

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
      model: 'agent-refresh-model',
    };
    writeSse(res, { ...base, choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: null }] });
    writeSse(res, {
      ...base,
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1_000, completion_tokens: 2, total_tokens: 1_002 },
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

/** A descriptor that passes `parsePiRuntimeAgentDefinitions`' hash validation. */
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

/**
 * A manifest at an explicit generation, so the test can move from one to the
 * next — the real-server helper derives its generation from the session key and
 * therefore cannot produce two.
 */
function manifestAt(
  sessionKey: { workspaceId: string; sessionId: string },
  snapshotGeneration: string,
): PiExecutionManifestV2 {
  const seed: PiExecutionManifestSeedV2 = {
    surfaceVersion: 2,
    snapshotGeneration,
    sessionKey,
    provenance: [],
    mcpSources: [],
    // Must match the subprocess's normalized orchestrator: this init omits the
    // field, so the server normalizes to the defaults.
    orchestrator: { ...DEFAULT_PI_ORCHESTRATOR_CONFIG },
    staticTools: PI_TOOL_BINDINGS
      .filter(binding => PI_STATIC_MODEL_CONTRACT_HASHES[binding.bindingName] !== undefined)
      .map(binding => ({
        descriptor: getHarnessToolDescriptor(binding.descriptorId),
        binding,
        source: { kind: 'piBuiltin' as const, bindingId: binding.bindingName },
        modelContractHash: PI_STATIC_MODEL_CONTRACT_HASHES[binding.bindingName]!,
      })),
  };
  return finalizePiExecutionManifest(seed, []);
}

/**
 * How many agents the recreated session actually built.
 *
 * This used to read the row's TOKEN count and assert it was above zero, using
 * cost as a proxy for presence. C4 made that proxy invalid on purpose: agent
 * definitions are never sent on the Pi wire (measured — 0 of 7 description
 * markers and 0 of 7 body markers in the request), so the row now reports 0
 * tokens and keeps the NAMES. Counting the items asserts the same thing the
 * comment below always meant — the agents did not silently vanish — without
 * depending on a number that is now deliberately zero.
 */
function subagentCount(usage: { categories?: Array<{ id: string; items?: unknown[] }> } | undefined): number {
  return usage?.categories?.find(category => category.id === 'custom_subagents')?.items?.length ?? 0;
}

describe('D7 real server — a capability bump keeps the session and its agents alive', () => {
  it('runs a turn after register_tools moves the generation, with the agent still present', async () => {
    const workspaceRootPath = mkdtempSync(join(tmpdir(), 'nessy-d7-workspace-'));
    const sessionPath = mkdtempSync(join(tmpdir(), 'nessy-d7-session-'));
    const sessionKey = { workspaceId: 'd7-workspace', sessionId: 'd7-session' };
    const first = manifestAt(sessionKey, 'd7-generation-a');
    const second = manifestAt(sessionKey, 'd7-generation-b');
    // The recreation is driven by the manifest HASH moving, so a fixture whose
    // two manifests hashed identically would silently measure nothing.
    expect(second.manifestHash).not.toBe(first.manifestHash);

    const entrypoint = process.env.NESSY_PI_SERVER_ENTRYPOINT || defaultEntrypoint;
    const stub = await startOpenAiStub();
    const child = spawn(process.execPath, [entrypoint], {
      cwd: join(here, '..', '..', '..', '..'),
      env: { ...process.env, NO_COLOR: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stdout = createInterface({ input: child.stdout });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += String(chunk); });

    const events: any[] = [];
    let stage: 'init' | 'first-turn' | 'registering' | 'second-turn' | 'done' = 'init';

    const done = new Promise<void>((resolve, reject) => {
      const clock = startRealServerClock({
        answerWaitMs: REAL_SERVER_TIMEOUT_MS,
        onExpire: (_phase, why) => reject(new Error(`D7 agent-refresh e2e timed out at stage ${stage} — ${why}\nstderr:\n${stderr}`)),
      });
      child.on('error', error => { clock.clear(); reject(error); });
      stdout.on('line', line => {
        let message: any;
        try { message = JSON.parse(line); } catch { return; }
        if (message.type === 'event') events.push(message.event);

        if (message.type === 'ready') clock.ready();
        if (message.type === 'ready' && stage === 'init') {
          stage = 'first-turn';
          writeJson(child, {
            type: 'prompt', id: 'prompt-1', message: 'First turn.',
            systemPrompt: 'You are the Nessy assistant.',
            manifestGeneration: first.snapshotGeneration,
            manifestHash: first.manifestHash,
          });
          return;
        }
        if (message.type === 'event' && message.event?.type === 'agent_end' && stage === 'first-turn') {
          stage = 'registering';
          // THE BUMP. A source enabled or disabled, or a plugin installed,
          // reaches the subprocess as exactly this message.
          writeJson(child, {
            type: 'register_tools', id: 'bump', tools: [], manifest: second,
            previous: { generation: first.snapshotGeneration, manifestHash: first.manifestHash },
            piRuntimeAgentDefinitions: [runtimeAgentDescriptor(second.snapshotGeneration)],
          });
          return;
        }
        if (message.type === 'register_tools_result' && message.id === 'bump') {
          if (!message.ok) {
            clock.clear();
            reject(new Error(`register_tools refused the bump: ${message.error}\nstderr:\n${stderr}`));
            return;
          }
          stage = 'second-turn';
          writeJson(child, {
            type: 'prompt', id: 'prompt-2', message: 'Second turn, after the bump.',
            systemPrompt: 'You are the Nessy assistant.',
            manifestGeneration: second.snapshotGeneration,
            manifestHash: second.manifestHash,
          });
          return;
        }
        if (message.type === 'event' && message.event?.type === 'agent_end' && stage === 'second-turn') {
          stage = 'done';
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
      model: 'agent-refresh-model',
      cwd: workspaceRootPath,
      workingDirectory: workspaceRootPath,
      workspaceRootPath,
      workspaceId: sessionKey.workspaceId,
      sessionId: sessionKey.sessionId,
      sessionPath,
      plansFolderPath: join(sessionPath, 'plans'),
      thinkingLevel: 'off',
      baseUrl: stub.baseUrl,
      customEndpoint: { api: 'openai-completions' },
      customModels: ['agent-refresh-model'],
      executionManifest: first,
      piRuntimeAgentDefinitions: [runtimeAgentDescriptor(first.snapshotGeneration)],
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

    // 1. The session was never killed by the bump. Asserted against the
    //    subprocess's own words, not against "the turn finished" alone.
    expect(stderr).not.toContain('Stale runtime agent definition');

    // 2. The agents did NOT silently vanish. This is the assertion the degrade
    //    half alone would pass while the product quietly lost every custom
    //    agent mid-session: `custom_subagents` is computed from the definitions
    //    the recreated session actually built.
    const usages = events.filter(event => event?.type === 'context_usage_update');
    expect(usages.length).toBeGreaterThan(1);
    expect(subagentCount(usages.at(0)?.usage)).toBeGreaterThan(0);
    expect(subagentCount(usages.at(-1)?.usage)).toBeGreaterThan(0);

    // 3. The refresh is visible in the log the operator would actually read —
    //    the generation value is there because its absence is why a dead
    //    session had to be diagnosed from source.
    expect(stderr).toContain(`at generation ${second.snapshotGeneration} (was ${first.snapshotGeneration})`);
    expect(stderr).toContain('agent definitions refreshed: 1');
  }, TEST_TIMEOUT_MS);
});
