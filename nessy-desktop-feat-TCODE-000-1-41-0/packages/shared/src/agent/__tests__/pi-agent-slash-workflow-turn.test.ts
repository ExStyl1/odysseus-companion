import { describe, expect, it } from 'bun:test';
import { PiAgent } from '../pi-agent.ts';
import type { BackendConfig, CapabilityTurnRuntime } from '../backend/types.ts';
import type { PiExecutionManifestSeedV2 } from '../pi-harness/harness-manifest.ts';

function createConfig(): BackendConfig {
  return {
    provider: 'pi',
    workspace: {
      id: 'ws-test',
      name: 'Test Workspace',
      rootPath: '/tmp/nessy-general-agent-test',
      workspaceRootPath: '/tmp/nessy-general-agent-test',
      sessionRootPath: '/tmp/nessy-general-agent-test-sessions/ws-test',
    } as any,
    session: {
      id: 'session-test',
      workspaceRootPath: '/tmp/nessy-general-agent-test',
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
    } as any,
    isHeadless: true,
  };
}

/**
 * Iterate the chat generator with a per-step timeout so a production hang
 * fails the test with a diagnostic instead of hitting the suite timeout.
 */
async function collect(generator: AsyncGenerator<any>, timeoutMs = 5_000): Promise<any[]> {
  const events: any[] = [];
  const iterator = generator[Symbol.asyncIterator]();
  for (;;) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const step = await Promise.race([
      iterator.next(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(
          `slash workflow turn hung: no event within ${timeoutMs}ms; events so far: ${JSON.stringify(events)}`,
        )), timeoutMs);
      }),
    ]).finally(() => clearTimeout(timer));
    if (step.done) break;
    events.push(step.value);
  }
  return events;
}

function setupAgent(): { agent: PiAgent; sent: Array<Record<string, unknown>> } {
  const agent = new PiAgent(createConfig());
  const runtime = agent as any;
  const manifestSeed: PiExecutionManifestSeedV2 = {
    surfaceVersion: 2,
    snapshotGeneration: 'generation-slash',
    sessionKey: { workspaceId: 'ws-test', sessionId: 'session-test' },
    provenance: [],
    mcpSources: [],
    orchestrator: { concurrency: 4, depth: 2, maxParallelTasks: 8, maxAgents: 100, tierModelMap: null, tokenBudget: null },
    staticTools: [],
  };
  const capabilityRuntime = {
    view: {
      generation: manifestSeed.snapshotGeneration,
      sources: [], skills: [], mcpServers: [], hooks: [], automations: [], agents: [],
      promptLayers: [], memory: [], permissionLayers: [], commands: [], promptCommands: [], apps: [],
    },
    materializer: {
      assertActive() {},
      async verifyPlugin() {},
      async resolvePath() { return '/tmp/nessy-general-agent-test'; },
      async readText() { return ''; },
      resolveCredential() { throw new Error('not used by this contract'); },
    },
    piExecutionManifestSeed: manifestSeed,
  } as CapabilityTurnRuntime;

  agent.setCapabilityTurnRuntime(capabilityRuntime);
  runtime.ensureSubprocess = async () => {};
  runtime.emitAutomationEvent = async () => {};
  const sent: Array<Record<string, unknown>> = [];
  runtime.subprocess = { stdin: { writable: true } };
  // Emulate the real subprocess JSONL contract for the two messages this
  // turn produces: manifest registration and the structured slash dispatch.
  runtime.send = (message: Record<string, unknown>) => {
    sent.push(message);
    if (message.type === 'register_tools') {
      const manifest = message.manifest as { snapshotGeneration: string; manifestHash: string };
      queueMicrotask(() => runtime.handleLine(JSON.stringify({
        type: 'register_tools_result',
        id: message.id,
        ok: true,
        generation: manifest.snapshotGeneration,
        manifestHash: manifest.manifestHash,
      })));
    }
    if (message.type === 'workflow_execute') {
      queueMicrotask(() => runtime.handleLine(JSON.stringify({
        type: 'workflow_execute_result',
        id: message.id,
        ok: true,
        content: 'workflow done',
        details: { result: { kind: 'workflow', status: 'done' } },
      })));
    }
  };
  return { agent, sent };
}

describe('PiAgent slash workflow production turn', () => {
  // Regression for the pass-8 live BLOCKER: an approved `/name` launch ran the
  // adapted workflow tool but the turn never completed. This drives the
  // production seam (BaseAgent.chat -> chatImpl -> workflow_execute), not
  // chatImpl in isolation.
  it('completes the turn after workflow_execute_result', async () => {
    const { agent, sent } = setupAgent();
    try {
      const events = await collect(agent.chat('/pass8-demo', undefined, {
        workflowInvocation: { name: 'pass8-demo', args: { input: '' } },
      } as any));

      expect(sent.some(message => message.type === 'workflow_execute')).toBe(true);
      expect(sent.some(message => message.type === 'prompt')).toBe(false);
      expect(events.at(-1)).toEqual({ type: 'complete' });
      expect(events).toContainEqual({ type: 'text_complete', text: 'workflow done' });
      expect(agent.isProcessing()).toBe(false);
    } finally {
      agent.destroy();
    }
  }, 20_000);
});
