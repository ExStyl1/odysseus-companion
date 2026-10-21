/**
 * P2.212 — `/workflow-name` is offered on every runtime; only Pi can dispatch it.
 *
 * A saved workflow recipe becomes a slash command whose body is the marker
 * `workflowSlashCommandBody` mints — `[workflow:<name>]\n$ARGUMENTS` — and whose
 * resolution ALSO carries a structured `workflowInvocation` down
 * `SessionManager.sendMessage` into `ChatOptions`. Exactly one backend reads
 * that option (`PiAgent.chatImpl` -> `workflow_execute`). On every other one the
 * option was ignored and the expanded body fell through to `chatImpl`, so the
 * literal `[workflow:audit]` reached the MODEL as prose. Nothing errored: the
 * model read a marker addressed to a tool it does not have, and answered as
 * though it had been asked something.
 *
 * That is the same defect as `/approve` (P3.25) — a command offered with no
 * dispatch arm — and it is answered the same way and in the same place: a
 * claiming arm at the `BaseAgent.chat` seam, so `chatImpl` is never entered.
 *
 * These tests drive the REAL seam on a REAL `ClaudeAgent` with the Agent SDK's
 * `query` faked, and count the turns that actually reached the model. The
 * absence claim in the first test is paired with a positive control on the same
 * rig — without it, a fake that never records anything would pass it.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import * as sdkPackage from '@anthropic-ai/claude-agent-sdk';
import type { AgentEvent } from '@nessy-agent/core/types';
import type { BackendConfig, CapabilityTurnRuntime } from '../backend/types.ts';
import { i18n, setupI18n } from '../../i18n/index.ts';

// `mock.module` is process-global and bun runs every file in one process, so the
// real module is spread back in and restored in `afterAll` — the pattern
// `claude-gateway-adapter.test.ts:79` records. Only `query` is replaced.
const realSdk = { ...sdkPackage };

/** The text of every turn that reached the model, in order. */
const queryCalls: string[] = [];

function resultMessage(): unknown {
  return {
    type: 'result',
    subtype: 'success',
    result: 'ok',
    num_turns: 1,
    usage: {
      input_tokens: 1,
      output_tokens: 1,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
  };
}

async function* plainSuccess(): AsyncGenerator<unknown> {
  yield resultMessage();
}

/** The text of one streamed `SDKUserMessage`, as the CLI would read it. */
function promptTextOf(message: unknown): string {
  const content = (message as { message?: { content?: unknown } } | undefined)?.message?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((block): block is { type: 'text'; text: string } =>
      !!block && typeof block === 'object' && (block as { type?: string }).type === 'text')
    .map(block => block.text)
    .join('\n');
}

mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  ...realSdk,
  query: (input: { prompt: unknown; options: Record<string, unknown> }) => {
    if (typeof input.prompt === 'string') {
      queryCalls.push(input.prompt);
      return plainSuccess();
    }
    const iterator = (input.prompt as AsyncIterable<unknown>)[Symbol.asyncIterator]();
    async function* serveTurns(): AsyncGenerator<unknown> {
      for (;;) {
        const next = await iterator.next();
        if (next.done) return;
        queryCalls.push(promptTextOf(next.value));
        yield* plainSuccess();
      }
    }
    const stream = serveTurns() as AsyncGenerator<unknown> & { interrupt(): Promise<unknown> };
    stream.interrupt = async () => ({ still_queued: [] });
    return stream;
  },
}));

afterAll(() => {
  mock.module('@anthropic-ai/claude-agent-sdk', () => realSdk);
});

const { ClaudeAgent } = await import('../claude-agent.ts');

const WORKSPACE_ID = 'ws-p2212-workflow-gate';
const WORKSPACE_ROOT = '/tmp/nessy-p2212-workflow-gate';

let sessionCounter = 0;
/** A fresh session id per test: the callback registry is a module-global keyed by it. */
function freshSessionId(): string {
  sessionCounter += 1;
  return `session-p2212-${sessionCounter}`;
}

function agentConfig(sessionId: string): BackendConfig {
  return {
    provider: 'anthropic',
    providerType: 'anthropic',
    model: 'claude-sonnet-4-6',
    isHeadless: true,
    skipConfigWatcher: true,
    workspace: {
      id: WORKSPACE_ID,
      name: 'P2.212 workflow gate',
      rootPath: WORKSPACE_ROOT,
      workspaceRootPath: WORKSPACE_ROOT,
      sessionRootPath: `${WORKSPACE_ROOT}/sessions`,
    } as never,
    session: {
      id: sessionId,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      workingDirectory: WORKSPACE_ROOT,
    } as never,
  } as BackendConfig;
}

/**
 * The minimum capability runtime `BaseAgent.chat` needs to reach `chatImpl`:
 * `extractSkillInvocations` throws `capability-turn-runtime-required` without
 * one, which would make BOTH rows below fail for a rig reason and the absence
 * claim worthless.
 */
function emptyCapabilityRuntime(): CapabilityTurnRuntime {
  return {
    view: {
      generation: 'generation-p2212',
      sources: [], skills: [], mcpServers: [], hooks: [], automations: [], agents: [],
      promptLayers: [], memory: [], permissionLayers: [], commands: [], promptCommands: [], apps: [],
    },
    materializer: {
      assertActive() {},
      async verifyPlugin() {},
      async resolvePath() { return WORKSPACE_ROOT; },
      async readText() { return ''; },
      resolveCredential() { throw new Error('not used by this contract'); },
    },
  } as CapabilityTurnRuntime;
}

/**
 * Iterate the chat generator with a per-step timeout, so a hang fails with a
 * diagnostic instead of consuming the suite timeout.
 */
async function collect(generator: AsyncGenerator<AgentEvent>, timeoutMs = 15_000): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  const iterator = generator[Symbol.asyncIterator]();
  for (;;) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const step = await Promise.race([
      iterator.next(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(
          `workflow-gate turn hung: no event within ${timeoutMs}ms; events so far: ${JSON.stringify(events)}`,
        )), timeoutMs);
      }),
    ]).finally(() => clearTimeout(timer));
    if (step.done) break;
    events.push(step.value);
  }
  return events;
}

let liveAgent: InstanceType<typeof ClaudeAgent> | null = null;

beforeEach(() => {
  queryCalls.length = 0;
});

afterEach(() => {
  liveAgent?.destroy();
  liveAgent = null;
});

describe('P2.212 · a workflow command on a runtime with no dispatcher', () => {
  it('refuses the turn and never sends the [workflow:…] marker to the model', async () => {
    liveAgent = new ClaudeAgent(agentConfig(freshSessionId()));
    liveAgent.setCapabilityTurnRuntime(emptyCapabilityRuntime());

    const events = await collect(liveAgent.chat('[workflow:audit]\nrelease readiness', undefined, {
      workflowInvocation: { name: 'audit', args: { input: 'release readiness' } },
    }));

    // The measured defect: this used to be one call carrying `[workflow:audit]`.
    expect(queryCalls).toEqual([]);
    expect(events.at(-1)).toEqual({ type: 'complete' });
    const refusal = events.find((event): event is Extract<AgentEvent, { type: 'error' }> =>
      event.type === 'error');
    expect(refusal).toBeDefined();
    // The refusal must SAY something. `approveGuardianDenial` records the
    // measured trap this guards against: an uninitialized i18next returns
    // `undefined` from `t()` — not the key — so a refusal with an empty message
    // is indistinguishable from a command that did nothing.
    if (!i18n.isInitialized) setupI18n();
    const expected = i18n.t('settings.ai.workflows.dispatchUnavailable');
    expect(expected).toBeTruthy();
    expect(expected).not.toBe('settings.ai.workflows.dispatchUnavailable');
    expect(refusal!.message).toBe(expected);
  }, 30_000);

  /**
   * The positive control the absence claim above needs, on the same rig: an
   * ORDINARY turn from the same agent does reach the model. Without this row,
   * a fake that recorded nothing — or a `chat()` that threw before ever
   * querying — would satisfy `queryCalls === []` for the wrong reason.
   */
  it('positive control: the same agent without a workflow invocation does reach the model', async () => {
    liveAgent = new ClaudeAgent(agentConfig(freshSessionId()));
    liveAgent.setCapabilityTurnRuntime(emptyCapabilityRuntime());

    await collect(liveAgent.chat('release readiness'));

    expect(queryCalls.length).toBeGreaterThan(0);
    expect(queryCalls.join('\n')).toContain('release readiness');
  }, 30_000);
});
