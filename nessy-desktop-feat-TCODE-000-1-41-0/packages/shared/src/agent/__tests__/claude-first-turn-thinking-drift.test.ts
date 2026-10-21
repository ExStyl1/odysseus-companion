/**
 * F1.802 — TURN 2 OF THE FIRST CLAUDE SESSION OF AN APP RUN MUST REUSE THE CHILD.
 *
 * ## What the release sitting saw (SIT-p, packaged `5896a66d2`, 2026-09-25)
 *
 * On the Nessy Gateway card, msg 1 of the first claude session started a
 * background subagent, and msg 2 logged `Live session options drifted —
 * respawning`; the respawn ended the task ("A background task did not survive
 * the Claude session restart."). The same run's SECOND claude session kept
 * `Reusing the live session`. F1.512's env fix was in that build.
 *
 * ## The moving key, read off the same log
 *
 * Turn 1 logged `[chat] Thinking: level=low, tokens=0`; turn 2 logged
 * `[chat] Thinking: level=low, disabled`, and so did the second session's turn 1.
 * `resolveClaudeThinkingOptions` decides the shape of "thinking off" from
 * `supportsAdaptiveThinking`, and P3.268 made that the RUNTIME's answer when it
 * has one: the process-scoped capability record is filled from the child's
 * `initialize` response DURING turn 1, so turn 1 of the first session on a model
 * falls back to the id heuristic (`tgpt/…` is not a Claude id, so `false`, so
 * `{ maxThinkingTokens: 0 }`) and turn 2 reads the runtime's row
 * (`supportsAdaptiveThinking: true`, so `{ thinking: { type: 'disabled' } }`).
 * The signature hashed both keys, so the same "off" in its two spellings was a
 * drift.
 *
 * The row the fake below answers is the row the vendored child answered for that
 * id, measured on `claude-agent-sdk` 0.3.267 / claude 2.1.267 with
 * `Query.supportedModels()` against the vendored binary (a lane probe, 2026-09-25):
 * the CLI lists the session's own `--model` beside its built-in aliases, with the
 * capability fields of its default family.
 *
 * ## Why folding the two spellings is the SDK's rule and not ours
 *
 * `query()` in the vendored `sdk.mjs` folds the two options into ONE value before
 * the transport ever sees them — `thinking` when set, else
 * `maxThinkingTokens === 0 ? {type:"disabled"} : {type:"enabled",budgetTokens}` —
 * and the argv builder reads only that value. So both spellings produce the same
 * `--thinking disabled` child; the signature now hashes the folded value.
 *
 * ## The discipline
 *
 * The SDK `query` is the only double; the turns are real `chatImpl` turns. Every
 * reuse claim sits beside a control on the same rig that respawns (a Haiku
 * crossing, entering bypass), and the precondition — that the two turns really
 * build the two different spellings — is asserted, so the reuse arm cannot pass
 * on a rig where nothing moved.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, mock, setDefaultTimeout } from 'bun:test';
import * as claudeAgentSdk from '@anthropic-ai/claude-agent-sdk';
import type { AgentEvent } from '@nessy-agent/core/types';
import type { BackendConfig } from '../backend/types.ts';
import type { PermissionMode } from '../mode-manager.ts';
import * as liveSession from '../backend/claude/live-session.ts';
import { resetClaudeModelCapabilities } from '../claude-model-capabilities.ts';
import { enableDebug } from '../../utils/debug.ts';

/**
 * A SNAPSHOT of the SDK's exports, taken before the mock is installed — never
 * the live namespace (AGENTS.md §Traps, the `mock.module` bullet).
 */
const realSdk = { ...claudeAgentSdk };
const realQuery = realSdk.query;

const GATEWAY_MODEL = 'tgpt/deepseek-v4-flash-0731';

/** What the vendored 2.1.267 child answered from `supportedModels()` (see the header). */
const MEASURED_MODEL_ROWS: readonly unknown[] = [
  {
    value: 'sonnet', resolvedModel: 'claude-sonnet-5', supportsAdaptiveThinking: true,
    supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
  },
  { value: 'haiku', resolvedModel: 'claude-haiku-4-5-20251001' },
  {
    value: GATEWAY_MODEL, resolvedModel: GATEWAY_MODEL, supportsAdaptiveThinking: true,
    supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
  },
  // F1.821 — measured on the same vendored child (DN-058 probe, 2026-09-26): no `xhigh`.
  {
    value: 'claude-sonnet-4-6', resolvedModel: 'claude-sonnet-4-6', supportsAdaptiveThinking: true,
    supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'max'],
  },
];

interface FakeSession {
  prompts: string[];
  options: Record<string, unknown>;
  aborted: boolean;
  /** F1.821 — every `applyFlagSettings` payload this child was sent. */
  flagSettings: unknown[];
}

const sessions: FakeSession[] = [];
/** F1.821 — when set, `applyFlagSettings` is refused, as a CLI control-response error is. */
let refuseFlagSettings = false;
const scripts: Array<() => AsyncGenerator<unknown>> = [];

function resultMessage(): unknown {
  return {
    type: 'result', subtype: 'success', result: 'ok', is_error: false, num_turns: 1,
    total_cost_usd: 0, session_id: 'fake-f1802-session', stop_reason: null, modelUsage: {},
    usage: { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  };
}

/** Assistant content before the result, or `chatImpl`'s empty-response recovery fires on a resumed turn. */
function assistantMessage(text: string): unknown {
  return {
    type: 'assistant', session_id: 'fake-f1802-session',
    message: {
      id: `msg-${text}`, role: 'assistant', model: GATEWAY_MODEL,
      content: [{ type: 'text', text }], stop_reason: 'end_turn',
      usage: { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    },
  };
}

/** The SDK's own background-task LEVEL payload (`tasks` replaces the set). */
function backgroundTasksChanged(id: string, description: string): unknown {
  return {
    type: 'system', subtype: 'background_tasks_changed',
    tasks: [{ task_id: id, task_type: 'local_agent', description }],
    uuid: `uuid-bg-${id}`, session_id: 'fake-f1802-session',
  };
}

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

/**
 * Armed only while this file's own tests run, and delegating otherwise: the last
 * `mock.module` for a specifier is live during other files' tests too.
 */
let rigArmed = false;

mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  ...realSdk,
  query: (input: { prompt: unknown; options: Record<string, unknown> }) => {
    if (!rigArmed) return (realQuery as unknown as (arg: unknown) => unknown)(input);
    const session: FakeSession = { prompts: [], options: input.options, aborted: false, flagSettings: [] };
    sessions.push(session);
    const abortController = input.options.abortController as AbortController | undefined;
    abortController?.signal.addEventListener('abort', () => { session.aborted = true; }, { once: true });

    const iterator = (input.prompt as AsyncIterable<unknown>)[Symbol.asyncIterator]();
    async function* serveTurns(): AsyncGenerator<unknown> {
      for (;;) {
        const next = await iterator.next();
        if (next.done) return;
        session.prompts.push(promptTextOf(next.value));
        const scripted = scripts.shift();
        if (scripted) yield* scripted();
        else {
          yield assistantMessage('ok');
          yield resultMessage();
        }
      }
    }
    const stream = serveTurns() as AsyncGenerator<unknown> & Record<string, unknown>;
    stream.interrupt = async () => ({ still_queued: [] });
    stream.setModel = async () => {};
    stream.setPermissionMode = async () => {};
    stream.setMcpServers = async () => ({ added: [], removed: [], errors: {} });
    stream.applyFlagSettings = async (settings: unknown) => {
      if (refuseFlagSettings) throw new Error('apply_flag_settings refused (test)');
      session.flagSettings.push(settings);
    };
    // P3.268's read: resolves off `initialize`, which every real child answers
    // during its first turn.
    stream.supportedModels = async () => MEASURED_MODEL_ROWS;
    return stream;
  },
}));

afterAll(() => {
  mock.module('@anthropic-ai/claude-agent-sdk', () => realSdk);
  // The record is process-scoped; leave none of this file's rows behind.
  resetClaudeModelCapabilities();
});

const { ClaudeAgent, resolveClaudeThinkingOptions } = await import('../claude-agent.ts');

// A real `chatImpl` turn measured 4.2-5.7 s on this rig at load ~8 (first run,
// 2026-09-25), against bun's 5 s default: the budget belongs to the file.
setDefaultTimeout(60_000);

const WORKSPACE_ROOT = '/tmp/nessy-f1802-first-turn';
let sessionCounter = 0;

function agentConfig(model: string): BackendConfig {
  sessionCounter += 1;
  return {
    provider: 'anthropic',
    providerType: 'anthropic',
    model,
    isHeadless: true,
    skipConfigWatcher: true,
    workspace: {
      id: 'ws-f1802', name: 'F1.802', rootPath: WORKSPACE_ROOT,
      workspaceRootPath: WORKSPACE_ROOT, sessionRootPath: `${WORKSPACE_ROOT}/sessions`,
    } as never,
    session: {
      id: `session-f1802-${sessionCounter}`, createdAt: Date.now(), lastUsedAt: Date.now(),
      workingDirectory: WORKSPACE_ROOT,
    } as never,
  } as BackendConfig;
}

type Agent = InstanceType<typeof ClaudeAgent>;
let agents: Agent[] = [];

function makeAgent(model: string, mode: PermissionMode = 'bypassPermissions'): Agent {
  const agent = new ClaudeAgent(agentConfig(model)) as Agent;
  // The sitting's session: bypass, thinking level low.
  agent.setPermissionMode(mode);
  agent.setThinkingLevel('low');
  agents.push(agent);
  return agent;
}

/**
 * One real `chatImpl` turn, with the debug channel captured. `debug()` writes
 * through `process.stderr.write` directly (`utils/debug.ts` `output`), so the
 * stub sees it; `enableDebug()` has no twin, which is why every arm reads only
 * the lines its own turn wrote.
 */
async function runTurn(agent: Agent, message: string): Promise<{ events: AgentEvent[]; log: string[] }> {
  const chatImpl = (agent as unknown as {
    chatImpl: (message: string) => AsyncGenerator<AgentEvent>;
  }).chatImpl.bind(agent);
  const events: AgentEvent[] = [];
  const log: string[] = [];
  const realWrite = process.stderr.write.bind(process.stderr);
  (process.stderr as { write: unknown }).write = (chunk: unknown) => {
    log.push(String(chunk));
    return true;
  };
  try {
    for await (const event of chatImpl(message)) events.push(event);
  } finally {
    (process.stderr as { write: unknown }).write = realWrite;
  }
  return { events, log };
}

const infoTexts = (events: AgentEvent[]): string[] => events
  .filter((event): event is AgentEvent & { message: string } => event.type === 'info')
  .map(event => event.message);

const driftLines = (log: string[]): string[] => log.filter(line => line.includes('Live session options drifted'));

beforeEach(() => {
  rigArmed = true;
  sessions.length = 0;
  scripts.length = 0;
  refuseFlagSettings = false;
  // "The first claude session of an app run": nothing has reported yet.
  resetClaudeModelCapabilities();
  enableDebug();
});

afterEach(() => {
  for (const agent of agents.splice(0)) agent.destroy();
  rigArmed = false;
});

// ---------------------------------------------------------------------------

describe('the first session of an app run, on the gateway model', () => {
  it('PRECONDITION: the two turns really build the two spellings of "thinking off"', () => {
    // Without this the reuse arm below could pass on a rig where nothing moved.
    const before = resolveClaudeThinkingOptions({ thinkingLevel: 'low', model: GATEWAY_MODEL, minimizeThinking: false });
    const after = resolveClaudeThinkingOptions({
      thinkingLevel: 'low', model: GATEWAY_MODEL, minimizeThinking: false,
      capabilities: { supportsAdaptiveThinking: true, supportsEffort: true },
    });
    expect(before).toEqual({ maxThinkingTokens: 0 });
    expect(after).toEqual({ thinking: { type: 'disabled' } });
  });

  it('THE CLAIM: turn 2 reuses the child, and the background task turn 1 started survives', async () => {
    const agent = makeAgent(GATEWAY_MODEL);

    scripts.push(async function* startsBackgroundTask() {
      yield backgroundTasksChanged('task-bg', 'sleep 45; echo BG-MARK');
      yield assistantMessage('started it');
      yield resultMessage();
    });
    const first = await runTurn(agent, 'start a background subagent');
    expect(infoTexts(first.events).some(text => text.includes('Background task started'))).toBe(true);
    // Turn 1 was built BEFORE the child reported — the heuristic spelling.
    expect(sessions[0]!.options.maxThinkingTokens).toBe(0);
    expect(sessions[0]!.options.thinking).toBeUndefined();

    const second = await runTurn(agent, 'what is 17 times 3?');

    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.aborted).toBe(false);
    expect(sessions[0]!.prompts).toHaveLength(2);
    expect(infoTexts(second.events).some(text => text.includes('did not survive'))).toBe(false);
    expect(driftLines(second.log)).toEqual([]);
    expect(second.log.some(line => line.includes('Reusing the live session'))).toBe(true);
  });

  it('CONTROL: the second session of the run (capabilities already reported) reuses too', async () => {
    const warm = makeAgent(GATEWAY_MODEL);
    await runTurn(warm, 'first session, turn one');
    sessions.length = 0;

    const agent = makeAgent(GATEWAY_MODEL);
    await runTurn(agent, 'second session, turn one');
    // The runtime's spelling from turn 1 on — the sitting's `disabled` line.
    expect(sessions[0]!.options.thinking).toEqual({ type: 'disabled' });
    const second = await runTurn(agent, 'second session, turn two');

    expect(sessions).toHaveLength(1);
    expect(second.log.some(line => line.includes('Reusing the live session'))).toBe(true);
  });
});

describe('F1.821 — an effort the model\'s reported levels clamp is applied live, not respawned', () => {
  const EFFORT_MODEL = 'claude-sonnet-4-6';
  const startsBackgroundTask = async function* (): AsyncGenerator<unknown> {
    yield backgroundTasksChanged('task-bg', 'sleep 45; echo BG-MARK');
    yield assistantMessage('started it');
    yield resultMessage();
  };

  it('PRECONDITION: turn 1 sends xhigh (no row yet) and turn 2 clamps it to high', () => {
    // Without this the reuse arm could pass on a rig where effort never moved.
    expect(resolveClaudeThinkingOptions({ thinkingLevel: 'xhigh', model: EFFORT_MODEL, minimizeThinking: false }))
      .toEqual({ thinking: { type: 'adaptive' }, effort: 'xhigh' });
    expect(resolveClaudeThinkingOptions({
      thinkingLevel: 'xhigh', model: EFFORT_MODEL, minimizeThinking: false,
      capabilities: MEASURED_MODEL_ROWS[3] as never,
    })).toEqual({ thinking: { type: 'adaptive' }, effort: 'high' });
  });

  it('THE CLAIM: turn 2 keeps the child and its background task, and tells it the level once', async () => {
    const agent = makeAgent(EFFORT_MODEL);
    agent.setThinkingLevel('xhigh');
    scripts.push(startsBackgroundTask);
    await runTurn(agent, 'start a background subagent');
    expect(sessions[0]!.options.effort).toBe('xhigh');

    const second = await runTurn(agent, 'what is 17 times 3?');
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.aborted).toBe(false);
    expect(sessions[0]!.prompts).toHaveLength(2);
    expect(infoTexts(second.events).some(text => text.includes('did not survive'))).toBe(false);
    expect(driftLines(second.log)).toEqual([]);
    expect(second.log.some(line => line.includes('Reusing the live session'))).toBe(true);
    expect(sessions[0]!.flagSettings).toEqual([{ effortLevel: 'high' }]);

    // The new signature was RECORDED: turn 3 needs no second control request.
    await runTurn(agent, 'and 18 times 3?');
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.flagSettings).toHaveLength(1);
  });

  // F1.1099 — this arm was the CONTROL "a user's own effort change still respawns"; the row turned it.
  it('F1.1099 THE CLAIM: a user\'s own effort change is applied live, and turn 1\'s background task survives', async () => {
    const agent = makeAgent(EFFORT_MODEL);
    agent.setThinkingLevel('high');
    scripts.push(startsBackgroundTask);
    await runTurn(agent, 'turn one');
    agent.setThinkingLevel('low');
    const second = await runTurn(agent, 'turn two');

    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.aborted).toBe(false);
    expect(sessions[0]!.flagSettings).toEqual([{ effortLevel: 'low' }]);
    expect(infoTexts(second.events).some(text => text.includes('did not survive'))).toBe(false);
    expect(driftLines(second.log)).toEqual([]);
  });

  it('F1.1099 CONTROL: a change to or from max still respawns, and no effort is applied live', async () => {
    const agent = makeAgent(EFFORT_MODEL);
    agent.setThinkingLevel('high');
    await runTurn(agent, 'turn one');
    agent.setThinkingLevel('max');
    const second = await runTurn(agent, 'turn two');
    agent.setThinkingLevel('high');
    const third = await runTurn(agent, 'turn three');

    expect(sessions).toHaveLength(3);
    expect(sessions[1]!.options.effort).toBe('max');
    expect(sessions.flatMap(session => session.flagSettings)).toEqual([]);
    expect(driftLines(second.log)[0]).toContain('effort');
    expect(driftLines(third.log)[0]).toContain('effort');
  });

  it('F1.1099 CONTROL: turning thinking off still respawns', async () => {
    const agent = makeAgent(EFFORT_MODEL);
    agent.setThinkingLevel('high');
    await runTurn(agent, 'turn one');
    agent.setThinkingLevel('off');
    const second = await runTurn(agent, 'turn two');

    expect(sessions).toHaveLength(2);
    expect(sessions[0]!.flagSettings).toEqual([]);
    expect(driftLines(second.log)[0]).toContain('thinking');
  });

  it('CONTROL: a refused setter falls back to the respawn, naming effort', async () => {
    const agent = makeAgent(EFFORT_MODEL);
    agent.setThinkingLevel('xhigh');
    await runTurn(agent, 'turn one');
    refuseFlagSettings = true;
    const second = await runTurn(agent, 'turn two');

    expect(sessions).toHaveLength(2);
    expect(sessions[1]!.options.effort).toBe('high');
    const lines = driftLines(second.log);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('effort');
  });
});

describe('F1.821 — claudeEffortClampDrift is the documented fallback and nothing wider', () => {
  const signature = (fields: Record<string, unknown>): string =>
    liveSession.claudeLiveSessionSignature({ cwd: '/w', thinking: { type: 'adaptive' }, ...fields } as never);
  const clampDrift = (args: Record<string, unknown>): unknown => {
    const fn = (liveSession as Record<string, unknown>).claudeEffortClampDrift;
    expect(typeof fn).toBe('function');
    return (fn as (a: Record<string, unknown>) => unknown)(args);
  };
  const noXhigh = { supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'max'] };

  it('xhigh → high under a row without xhigh is the clamp', () => {
    expect(clampDrift({
      previousSignature: signature({ effort: 'xhigh' }), signature: signature({ effort: 'high' }), capabilities: noXhigh,
    })).toBe('high');
  });

  it('F1.1099: a user\'s own level change is live too — with or without a row', () => {
    const xhigh = signature({ effort: 'xhigh' });
    expect(clampDrift({ previousSignature: signature({ effort: 'high' }), signature: signature({ effort: 'low' }), capabilities: noXhigh })).toBe('low');
    expect(clampDrift({ previousSignature: xhigh, signature: signature({ effort: 'medium' }), capabilities: noXhigh })).toBe('medium');
    expect(clampDrift({ previousSignature: xhigh, signature: signature({ effort: 'high' }), capabilities: undefined })).toBe('high');
    expect(clampDrift({ previousSignature: signature({ effort: 'low' }), signature: xhigh, capabilities: undefined })).toBe('xhigh');
  });

  it('F1.1099 BOUNDARY: max on either side respawns, unless it is the documented clamp of max', () => {
    const max = signature({ effort: 'max' });
    expect(clampDrift({ previousSignature: signature({ effort: 'high' }), signature: max, capabilities: undefined })).toBeNull();
    expect(clampDrift({ previousSignature: max, signature: signature({ effort: 'high' }), capabilities: undefined })).toBeNull();
    // A row without max: max → its fallback (the highest level below it) stays F1.821's clamp.
    expect(clampDrift({ previousSignature: max, signature: signature({ effort: 'high' }), capabilities: { supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high'] } })).toBe('high');
  });

  it('BOUNDARY: another key moved, or effort dropped — all null', () => {
    const xhigh = signature({ effort: 'xhigh' });
    // Effort moved WITH another hashed key — the env included (F1.117's respawn stays one).
    expect(clampDrift({ previousSignature: xhigh, signature: signature({ effort: 'high', maxTurns: 3 }), capabilities: noXhigh })).toBeNull();
    expect(clampDrift({ previousSignature: xhigh, signature: signature({ effort: 'high', env: { A: '1' } }), capabilities: noXhigh })).toBeNull();
    // A clamp to no effort at all is not the documented fallback.
    expect(clampDrift({ previousSignature: xhigh, signature: signature({}), capabilities: { supportsEffort: false } })).toBeNull();
    // An unchanged signature is no drift at all.
    expect(clampDrift({ previousSignature: xhigh, signature: xhigh, capabilities: noXhigh })).toBeNull();
  });
});

describe('a real option change still respawns, and the drift line names the KEYS', () => {
  it('CONTROL: a model switch crossing into Haiku respawns, naming thinking and effort', async () => {
    const agent = makeAgent('claude-sonnet-4-6');
    await runTurn(agent, 'turn one');
    agent.setModel('claude-haiku-4-5');
    const second = await runTurn(agent, 'turn two');

    expect(sessions).toHaveLength(2);
    expect(sessions[0]!.aborted).toBe(true);
    const lines = driftLines(second.log);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('thinking');
    expect(lines[0]).toContain('effort');
  });

  it('CONTROL: entering bypass respawns, naming allowDangerouslySkipPermissions', async () => {
    const agent = makeAgent(GATEWAY_MODEL, 'default');
    await runTurn(agent, 'turn one');
    agent.setPermissionMode('bypassPermissions');
    const second = await runTurn(agent, 'turn two');

    expect(sessions).toHaveLength(2);
    const lines = driftLines(second.log);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('allowDangerouslySkipPermissions');
    // The first-turn spelling moved too on this path; it is NOT a key any more.
    expect(lines[0]).not.toContain('maxThinkingTokens');
  });
});

describe('the signature hashes thinking the way the SDK spends it', () => {
  const signature = (fields: Record<string, unknown>): string =>
    liveSession.claudeLiveSessionSignature({ cwd: '/w', ...fields } as never);

  it('the two spellings of "off" are one signature', () => {
    expect(signature({ maxThinkingTokens: 0 })).toBe(signature({ thinking: { type: 'disabled' } }));
  });

  it('a token budget is the SDK\'s `enabled` with that budget, and a different budget is a drift', () => {
    expect(signature({ maxThinkingTokens: 8000 }))
      .toBe(signature({ thinking: { type: 'enabled', budgetTokens: 8000 } }));
    expect(signature({ maxThinkingTokens: 8000 })).not.toBe(signature({ maxThinkingTokens: 4000 }));
  });

  it('`thinking` outranks `maxThinkingTokens`, as in `query()`', () => {
    expect(signature({ thinking: { type: 'adaptive' }, maxThinkingTokens: 0 }))
      .toBe(signature({ thinking: { type: 'adaptive' } }));
  });

  it('BOUNDARY: off and adaptive stay apart, and unset stays apart from off', () => {
    expect(signature({ maxThinkingTokens: 0 })).not.toBe(signature({ thinking: { type: 'adaptive' } }));
    expect(signature({})).not.toBe(signature({ maxThinkingTokens: 0 }));
  });
});

describe('the drift diagnostic names keys, never values', () => {
  const describeRespawn = (args: Record<string, unknown>): string => {
    const fn = (liveSession as Record<string, unknown>).describeClaudeLiveRespawn;
    expect(typeof fn).toBe('function');
    return (fn as (a: Record<string, unknown>) => string)(args);
  };
  const signature = (fields: Record<string, unknown>): string =>
    liveSession.claudeLiveSessionSignature({ cwd: '/w', ...fields } as never);
  const base = { previousSignature: null, signature: '', anchorMatches: true, forking: false, inputEnded: false };

  it('names the moved option keys and the moved env NAMES, and no value', () => {
    const text = describeRespawn({
      ...base,
      previousSignature: signature({ effort: 'high', env: { HTTPS_PROXY: 'http://secret-proxy:1', KEEP: 'same' } }),
      signature: signature({ effort: 'low', env: { HTTPS_PROXY: 'http://other-proxy:2', KEEP: 'same', ADDED: 'v' } }),
    });
    expect(text).toContain('effort');
    expect(text).toContain('env.HTTPS_PROXY');
    expect(text).toContain('env.ADDED');
    expect(text).not.toContain('env.KEEP');
    expect(text).not.toContain('secret-proxy');
    expect(text).not.toContain('other-proxy');
    expect(text).not.toContain('high');
  });

  it('with an unchanged signature it names the other cause', () => {
    const same = signature({});
    expect(describeRespawn({ ...base, previousSignature: same, signature: same, anchorMatches: false }))
      .toContain('resume anchor');
    expect(describeRespawn({ ...base, previousSignature: same, signature: same, forking: true })).toContain('fork');
    expect(describeRespawn({ ...base, previousSignature: same, signature: same, inputEnded: true })).toContain('input');
    expect(describeRespawn({ ...base, previousSignature: same, signature: same })).toContain('live setter');
  });
});
