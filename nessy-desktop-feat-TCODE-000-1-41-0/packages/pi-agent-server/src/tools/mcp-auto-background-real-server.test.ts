import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'bun:test';
import { realServerTestBudget, startRealServerClock } from '../__tests__/support/real-server-clock.ts';

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
import {
  createRealServerAllowPermissionReceipt,
} from '../__tests__/real-server-execution-manifest.ts';

const here = dirname(fileURLToPath(import.meta.url));
const defaultEntrypoint = join(here, '..', 'index.ts');
const preloadPath = join(here, 'mcp-auto-background-e2e-preload.ts');
/** F1.546 — the ANSWER budget, from the child's first `ready`; the boot has its own (`real-server-clock.ts`). */
const REAL_SERVER_TIMEOUT_MS = 120_000;
const TEST_TIMEOUT_MS = realServerTestBudget(REAL_SERVER_TIMEOUT_MS);

const STUB_TOOL = {
  name: 'mcp__stub__slow',
  description: 'Slow stub MCP tool',
  inputSchema: { type: 'object', properties: { payload: { type: 'string' } } },
  promptSnippet: 'Use mcp__stub__slow for slow stub calls',
};

function writeJson(child: ChildProcessWithoutNullStreams, message: Record<string, unknown>): void {
  child.stdin.write(`${JSON.stringify(message)}\n`);
}

function createMcpManifest(sessionKey: { workspaceId: string; sessionId: string }): PiExecutionManifestV2 {
  const generation = `mcp-bg:${sessionKey.sessionId}`;
  const provenance = { capabilityKey: 'stub:mcp', generation };
  const seed: PiExecutionManifestSeedV2 = {
    surfaceVersion: 2,
    snapshotGeneration: generation,
    sessionKey,
    provenance: [provenance],
    mcpSources: [{ wireName: 'stub', ...provenance }],
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
  return finalizePiExecutionManifest(seed, [{
    bindingName: STUB_TOOL.name,
    description: STUB_TOOL.description,
    inputSchema: STUB_TOOL.inputSchema,
    promptSnippet: STUB_TOOL.promptSnippet,
    modelSchemaVersion: 1 as const,
    bindingSchemaVersion: 1 as const,
    provenance,
  }]);
}

interface RunOptions {
  mode: 'detach' | 'off';
  sessionId: string;
  env: Record<string, string>;
  /** Delay before the host settles each stalled call, ms. */
  settleAfterMs: number;
  /** Ordered per-call settle payloads. */
  settle: Array<{ content: string; isError: boolean }>;
  /** Wall-clock instant (ms since spawn) at which detachment must already be visible. */
  detachProbeAtMs?: number;
  /**
   * R24 probe: after the first `ready`, report a stale elicitation dialog as
   * open and RE-INIT the subprocess before registering tools. The re-init must
   * drop the stale id (`elicitationDialogGate.reset()`), or the detach below
   * is deferred forever by a dialog belonging to a replaced host agent.
   */
  reinitWithStaleDialog?: boolean;
}

async function runMcpScenario(options: RunOptions) {
  const workspaceRootPath = realpathSync(mkdtempSync(join(tmpdir(), 'nessy-mcp-bg-workspace-')));
  const sessionPath = realpathSync(mkdtempSync(join(tmpdir(), 'nessy-mcp-bg-session-')));
  const workspaceId = 'mcp-bg-e2e-workspace';
  const sessionKey = { workspaceId, sessionId: options.sessionId };
  const manifest = createMcpManifest(sessionKey);
  const initMessage = {
    type: 'init',
    apiKey: 'test',
    model: 'mcp-bg-e2e-model',
    cwd: workspaceRootPath,
    workingDirectory: workspaceRootPath,
    workspaceRootPath,
    workspaceId,
    sessionId: options.sessionId,
    sessionPath,
    plansFolderPath: join(sessionPath, 'plans'),
    thinkingLevel: 'off',
    executionManifest: manifest,
    piAuth: { provider: 'faux', credential: { type: 'api_key', key: 'test' } },
  };

  const child = spawn(process.execPath, ['--preload', preloadPath, defaultEntrypoint], {
    cwd: join(here, '..', '..', '..', '..'),
    env: {
      ...process.env,
      NO_COLOR: '1',
      FAUX_API_KEY: 'test',
      NESSY_MCP_E2E_MODE: options.mode,
      ...options.env,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const stdout = createInterface({ input: child.stdout });
  let stderr = '';
  let promptSent = false;
  let toolsRegistered = false;
  let readyCount = 0;
  let settleIndex = 0;
  const messages: any[] = [];
  const detachProbes: boolean[] = [];
  const settleSentAt: number[] = [];

  child.stderr.on('data', chunk => {
    stderr += String(chunk);
  });

  const mcpEndSeen = () => messages.some(message =>
    message.type === 'event'
    && message.event?.type === 'tool_execution_end'
    && message.event?.toolName === STUB_TOOL.name);
  const notificationCount = () => messages.filter(message =>
    message.type === 'event' && message.event?.type === 'task_notification').length;
  const expectedNotifications = options.mode === 'detach' ? options.settle.length : 0;
  let agentEnded = false;

  const done = new Promise<void>((resolve, reject) => {
    const clock = startRealServerClock({
      answerWaitMs: REAL_SERVER_TIMEOUT_MS,
      onExpire: (_phase, why) => reject(new Error(`mcp auto-background real-server e2e (${options.mode}) timed out — ${why}\nstderr:\n${stderr}`)),
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
      if (message.type === 'ready') {
        readyCount += 1;
        if (options.reinitWithStaleDialog && readyCount === 1) {
          // A dialog id belonging to the host agent that is about to be
          // replaced — the gate set is synchronous, then the re-init follows
          // on the next line.
          writeJson(child, { type: 'mcp_elicitation_state', dialogId: 'stale-elicit-dialog-1', open: true });
          writeJson(child, initMessage);
          return;
        }
        if (!toolsRegistered) {
          toolsRegistered = true;
          writeJson(child, {
            type: 'register_tools',
            id: 'register-1',
            tools: [STUB_TOOL],
            manifest,
            previous: { generation: manifest.snapshotGeneration, manifestHash: manifest.manifestHash },
          });
        }
        return;
      }

      if (message.type === 'register_tools_result' && !promptSent) {
        if (!message.ok) {
          clock.clear();
          reject(new Error(`register_tools failed: ${message.error}`));
          return;
        }
        promptSent = true;
        writeJson(child, {
          type: 'prompt',
          id: 'prompt-1',
          message: 'Call the slow stub tool as scripted.',
          systemPrompt: 'Call mcp__stub__slow as scripted.',
          manifestGeneration: manifest.snapshotGeneration,
          manifestHash: manifest.manifestHash,
        });
        return;
      }

      if (message.type === 'pre_tool_use_request') {
        writeJson(child, {
          type: 'pre_tool_use_response',
          requestId: message.requestId,
          action: 'allow',
          receipt: createRealServerAllowPermissionReceipt(manifest, {
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

      if (message.type === 'tool_execute_request' && message.toolName === STUB_TOOL.name) {
        const callIndex = settleIndex;
        settleIndex += 1;
        const payload = options.settle[callIndex]
          ?? { content: 'unexpected extra call', isError: true };
        // The stub MCP server stalls: the settle arrives well past the threshold.
        if (options.detachProbeAtMs !== undefined) {
          setTimeout(() => {
            detachProbes[callIndex] = mcpEndSeen();
          }, options.detachProbeAtMs);
        }
        setTimeout(() => {
          settleSentAt[callIndex] = Date.now();
          writeJson(child, {
            type: 'tool_execute_response',
            requestId: message.requestId,
            result: { content: payload.content, isError: payload.isError },
          });
        }, options.settleAfterMs);
        return;
      }

      if (message.type === 'event' && message.event?.type === 'agent_end' && promptSent) {
        agentEnded = true;
      }
      // Done once the turn ended AND every detached call's settle notification
      // arrived (0 expected in 'off' mode - resolve shortly after agent_end so
      // a late stray notification would still be caught by the assertions).
      if (agentEnded && notificationCount() >= expectedNotifications) {
        setTimeout(() => {
          clock.clear();
          resolve();
        }, options.mode === 'off' ? 500 : 0);
      }

      if (message.type === 'error') {
        clock.clear();
        reject(new Error(`${message.code}: ${message.message}\nstderr:\n${stderr}`));
      }
    });
  });

  writeJson(child, initMessage);

  try {
    await done;
  } finally {
    writeJson(child, { type: 'shutdown' });
    child.kill();
    stdout.close();
  }

  const events = messages.filter(message => message.type === 'event').map(message => message.event);
  return { events, detachProbes, settleSentAt, stderr };
}

/**
 * R10 MCP auto-background through the PRODUCTION chain: a real pi-agent-server
 * subprocess whose proxied MCP call stalls at the host boundary (the stub MCP
 * server view). Past `NESSY_MCP_AUTO_BACKGROUND_MS` the call detaches: the
 * model receives the task id IMMEDIATELY, the call keeps running, and the
 * settled result (or error) arrives as a `task_notification` event for the R3
 * delivery path.
 */
describe('mcp auto-background real server e2e', () => {
  it('detaches at the threshold, notifies on settle, and carries errors', async () => {
    const { events, detachProbes } = await runMcpScenario({
      mode: 'detach',
      sessionId: 'mcp-bg-e2e-detach',
      env: { NESSY_MCP_AUTO_BACKGROUND_MS: '1000' },
      settleAfterMs: 2_500,
      settle: [
        { content: 'slow-result-one', isError: false },
        { content: 'wall-clock timeout exceeded for mcp__stub__slow', isError: true },
      ],
      detachProbeAtMs: 2_000,
    });

    const mcpEnds = events.filter(event => event?.type === 'tool_execution_end' && event.toolName === STUB_TOOL.name);
    expect(mcpEnds).toHaveLength(2);

    // 1. The model saw the task id IMMEDIATELY - the tool result landed while
    //    the stub server was still stalling.
    expect(detachProbes[0]).toBe(true);
    const firstText: string = mcpEnds[0]?.result?.content?.[0]?.text ?? '';
    const taskId = /task_id: (task-mcp-[a-z0-9-]+)/.exec(firstText)?.[1];
    expect(taskId).toBeDefined();
    expect(firstText).toContain('moved to a background task');

    // The detachment is listed like other background tasks.
    const backgrounded = events.filter(event => event?.type === 'task_backgrounded' && event.kind === 'mcp');
    expect(backgrounded.some((event: any) => event.taskId === taskId)).toBe(true);

    // 2. The settled result arrived as a task notification carrying the content.
    const notifications = events.filter(event => event?.type === 'task_notification');
    const settled = notifications.find((event: any) => event.taskId === taskId);
    expect(settled).toBeDefined();
    expect(settled!.text).toContain('slow-result-one');

    // 3. The second call's failure arrived as a notification carrying the error.
    expect(detachProbes[1]).toBe(true);
    const secondText: string = mcpEnds[1]?.result?.content?.[0]?.text ?? '';
    const secondTaskId = /task_id: (task-mcp-[a-z0-9-]+)/.exec(secondText)?.[1];
    expect(secondTaskId).toBeDefined();
    expect(secondTaskId).not.toBe(taskId);
    const failed = notifications.find((event: any) => event.taskId === secondTaskId);
    expect(failed).toBeDefined();
    expect(failed!.text).toContain('wall-clock timeout exceeded');
  }, TEST_TIMEOUT_MS);

  it('a re-inited session starts with an empty dialog-id set: a stale id cannot defer the detach (R24)', async () => {
    // The gate is a module singleton that outlives session re-init, and a new
    // host agent restarts its dialog-id sequence — so without the re-init
    // reset() a stale open id from the replaced agent defers auto-background
    // detaches forever. Probe: open a dialog id, re-init, then run the same
    // detach scenario as above; the detach must still fire at the threshold.
    const { events, detachProbes } = await runMcpScenario({
      mode: 'detach',
      sessionId: 'mcp-bg-e2e-reinit-gate',
      env: { NESSY_MCP_AUTO_BACKGROUND_MS: '1000' },
      settleAfterMs: 2_500,
      settle: [
        { content: 'slow-result-after-reinit', isError: false },
        { content: 'slow-result-two', isError: false },
      ],
      detachProbeAtMs: 2_000,
      reinitWithStaleDialog: true,
    });

    // The model saw the task id while the stub was still stalling — the stale
    // dialog id did not hold the detach clock.
    expect(detachProbes[0]).toBe(true);
    const backgrounded = events.filter(event => event?.type === 'task_backgrounded' && event.kind === 'mcp');
    expect(backgrounded.length).toBeGreaterThanOrEqual(1);
    const notifications = events.filter(event => event?.type === 'task_notification');
    expect(notifications.some((event: any) => String(event.text).includes('slow-result-after-reinit'))).toBe(true);
  }, TEST_TIMEOUT_MS);

  it('NESSY_MCP_AUTO_BACKGROUND_MS=0 disables the detach entirely', async () => {
    const { events } = await runMcpScenario({
      mode: 'off',
      sessionId: 'mcp-bg-e2e-off',
      env: { NESSY_MCP_AUTO_BACKGROUND_MS: '0' },
      settleAfterMs: 1_500,
      settle: [{ content: 'inline-result', isError: false }],
    });

    const mcpEnds = events.filter(event => event?.type === 'tool_execution_end' && event.toolName === STUB_TOOL.name);
    expect(mcpEnds).toHaveLength(1);
    const text: string = mcpEnds[0]?.result?.content?.[0]?.text ?? '';
    expect(text).toContain('inline-result');
    expect(text).not.toContain('task_id:');
    expect(events.filter(event => event?.type === 'task_notification')).toEqual([]);
    expect(events.filter(event => event?.type === 'task_backgrounded')).toEqual([]);
  }, TEST_TIMEOUT_MS);
});
