/**
 * L4 — WHAT A LIVE SESSION CAN BE TOLD, AND WHAT IT STILL HAS TO BE REBUILT FOR.
 *
 * ## The premise this file had to correct before it could test anything
 *
 * L2 recorded that "the SDK exposes exactly three live setters — `setModel`,
 * `setPermissionMode`, `supportedCommands` — and nothing else; verified against
 * the whole `sdk.d.ts`", and L1's caller walk concluded from it that the MCP
 * server set "is a construction option with no live equivalent", which is why
 * source activation became an explicit interrupt-then-respawn.
 *
 * **Both halves are false for the SDK we ship.** `Query` in
 * `@anthropic-ai/claude-agent-sdk@0.3.218` declares 27 methods;
 * `supportedCommands` is a getter, not a setter; and `setMcpServers` exists, is
 * implemented in `sdk.mjs`, and is answered by the shipped CLI binary — whose
 * own schema string for the control request reads *"Replaces the set of
 * dynamically managed MCP servers."* So the MCP answer is that it CAN change
 * live, and the last test in this file is the mechanical guard that keeps that
 * claim — and the five options that still have NO setter — from rotting the same
 * silent way.
 *
 * ## The discipline
 *
 * Every "it went live" claim is paired with a control on the same rig that
 * produces a respawn, and every "it respawns" claim names the option that forced
 * it. A setter call is never inferred from the absence of a second child: the
 * fake records the calls, and both facts are asserted together.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import * as claudeAgentSdk from '@anthropic-ai/claude-agent-sdk';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { AgentEvent, PersistedModelUsage } from '@nessy-agent/core/types';
// P2.42 folds each turn's per-model map the way `SessionManager` does.
import { mergeModelUsage } from '../../telemetry/cost-reporting.ts';
import type { BackendConfig } from '../backend/types.ts';
import type { PermissionMode } from '../mode-manager.ts';
import { AbortReason } from '../core/session-lifecycle.ts';

/**
 * A SNAPSHOT of the SDK's exports, taken before the mock is installed — NOT the
 * live namespace. `mock.module` mutates the namespace object in place, so
 * `() => claudeAgentSdk` in the `afterAll` would hand the MOCK back and leave it
 * installed for every later file in the process (AGENTS.md §Traps, the
 * `mock.module` bullet; `scripts/check-mock-module-spread.ts` is the gate).
 */
const realSdk = { ...claudeAgentSdk };
/**
 * The real `query`, bound once as a VALUE.
 *
 * Reading it off the LIVE namespace after `mock.module` returns the MOCK —
 * delegating through the namespace made the fake call itself, and the pairing
 * with `claude-turn-cancel-contract.test.ts` hung indefinitely rather than
 * failing. The snapshot above already removes that hazard for `realSdk`; the
 * binding stays because the delegating call site below wants a plain function.
 */
const realQuery = realSdk.query;

// ---------------------------------------------------------------------------
// A fake CLI that reads the input channel, outlives the turn, and answers (or
// refuses) the three control requests L4 depends on.
// ---------------------------------------------------------------------------

interface FakeSession {
  /** Prompts this session received, in order. One entry per turn it served. */
  prompts: string[];
  /** The `Options` object this child was CONSTRUCTED with. */
  options: Record<string, unknown>;
  aborted: boolean;
  interrupts: number;
  setModelCalls: Array<string | undefined>;
  setPermissionModeCalls: string[];
  setMcpServersCalls: string[][];
}

/** One entry per `query()` call — i.e. per CHILD PROCESS the agent would spawn. */
const sessions: FakeSession[] = [];
/** Scripted turns, consumed one per prompt that arrives. Empty = a plain success. */
const scripts: Array<() => AsyncGenerator<unknown>> = [];

/** The SDK message shape a failed MCP tool call arrives in. */
function toolResultMessage(toolUseId: string, text: string): unknown {
  return {
    type: 'user',
    session_id: 'fake-live-settings-session',
    parent_tool_use_id: null,
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: toolUseId, content: text, is_error: true }],
    },
  };
}

/** How the fake CLI answers control requests. Reset per test. */
const rig = {
  /** Setters to omit entirely, so the agent's `typeof` guard is exercised. */
  omit: new Set<string>(),
  /** Setters that answer with a CLI error verdict, as a refusal does. */
  reject: new Set<string>(),
  /** Setters that acknowledge nothing at all, as a wedged child does. */
  hang: new Set<string>(),
  /** Run just before `setModel` resolves — the seam for "the session died mid-reconciliation". */
  duringSetModel: null as null | (() => void),
  /** What `setMcpServers` resolves with; `null` means "derive it honestly". */
  mcpResult: null as null | { added: string[]; removed: string[]; errors: Record<string, string> },
};

function resultMessage(overrides: Record<string, unknown> = {}): unknown {
  return {
    type: 'result',
    subtype: 'success',
    result: 'ok',
    is_error: false,
    num_turns: 1,
    total_cost_usd: 0,
    session_id: 'fake-live-settings-session',
    stop_reason: null,
    modelUsage: {},
    usage: { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    ...overrides,
  };
}

/**
 * A real turn produces assistant content before its result. A fixture that only
 * ever emits a result trips `chatImpl`'s empty-response recovery on every
 * RESUMED turn — measured in L2, kept here for the same reason.
 */
function assistantMessage(text: string): unknown {
  return {
    type: 'assistant',
    session_id: 'fake-live-settings-session',
    message: {
      id: `msg-${text}`,
      role: 'assistant',
      model: 'claude-sonnet-4-6',
      content: [{ type: 'text', text }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    },
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

/** The user's own text is the LAST line: `buildTextPrompt` prepends the context. */
function userLineOf(prompt: string): string {
  const lines = prompt.trimEnd().split('\n');
  return lines[lines.length - 1] ?? prompt;
}

/** Never resolves — the SDK's `awaitControlResponse` has no timeout of its own. */
function forever(): Promise<never> {
  return new Promise<never>(() => {});
}

/**
 * THE FAKE DELEGATES RATHER THAN REPLACES, and that is not tidiness.
 *
 * `mock.module` is process-global and bun evaluates every test file's
 * module scope before it runs any of them, so the last `mock.module` for a
 * specifier is the one live during OTHER files' tests. Restoring in `afterAll`
 * is not enough: measured while writing this file, installing an unconditional
 * fake here made `claude-turn-cancel-contract.test.ts` — which needs the REAL
 * `query`, because it spawns a process to prove what a string prompt does to
 * stdin — fail five tests with `input.prompt[Symbol.asyncIterator] is not a
 * function`, i.e. our fake answering its call.
 *
 * So the fake is armed only for the duration of this file's own tests and hands
 * everything else straight to the real implementation.
 */
let rigArmed = false;

mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  ...realSdk,
  query: (input: { prompt: unknown; options: Record<string, unknown> }) => {
    if (!rigArmed) return (realQuery as unknown as (arg: unknown) => unknown)(input);
    const session: FakeSession = {
      prompts: [],
      options: input.options,
      aborted: false,
      interrupts: 0,
      setModelCalls: [],
      setPermissionModeCalls: [],
      setMcpServersCalls: [],
    };
    sessions.push(session);
    const abortController = input.options.abortController as AbortController | undefined;
    abortController?.signal.addEventListener('abort', () => { session.aborted = true; }, { once: true });

    // What the CLI currently believes its dynamic server set to be. Seeded from
    // construction, exactly as the SDK seeds `sdkMcpServerInstances` from
    // `options.mcpServers` before the first turn.
    let liveServerNames = Object.keys((input.options.mcpServers ?? {}) as object);

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
    stream.interrupt = async () => { session.interrupts += 1; return { still_queued: [] }; };
    if (!rig.omit.has('setModel')) {
      stream.setModel = async (model?: string) => {
        if (rig.hang.has('setModel')) return forever();
        session.setModelCalls.push(model);
        rig.duringSetModel?.();
        if (rig.reject.has('setModel')) throw new Error(`set_model: model not allowed: ${model}`);
      };
    }
    if (!rig.omit.has('setPermissionMode')) {
      stream.setPermissionMode = async (mode: string) => {
        if (rig.hang.has('setPermissionMode')) return forever();
        session.setPermissionModeCalls.push(mode);
        if (rig.reject.has('setPermissionMode')) {
          throw new Error('Cannot set permission mode to bypassPermissions because the session was not launched with --dangerously-skip-permissions');
        }
      };
    }
    if (!rig.omit.has('setMcpServers')) {
      stream.setMcpServers = async (servers: Record<string, unknown>) => {
        if (rig.hang.has('setMcpServers')) return forever();
        const wanted = Object.keys(servers);
        session.setMcpServersCalls.push([...wanted].sort());
        if (rig.reject.has('setMcpServers')) throw new Error('mcp_set_servers refused');
        if (rig.mcpResult) return rig.mcpResult;
        const added = wanted.filter(name => !liveServerNames.includes(name));
        const removed = liveServerNames.filter(name => !wanted.includes(name));
        liveServerNames = wanted;
        return { added, removed, errors: {} };
      };
    }
    return stream;
  },
}));

afterAll(() => {
  mock.module('@anthropic-ai/claude-agent-sdk', () => realSdk);
});

const { ClaudeAgent } = await import('../claude-agent.ts');

const WORKSPACE_ID = 'ws-l4-live-settings';
const WORKSPACE_ROOT = '/tmp/nessy-l4-live-settings';

let sessionCounter = 0;

function agentConfig(overrides: Partial<BackendConfig> = {}): BackendConfig {
  sessionCounter += 1;
  return {
    provider: 'anthropic',
    providerType: 'anthropic',
    model: 'claude-sonnet-4-6',
    isHeadless: true,
    skipConfigWatcher: true,
    workspace: {
      id: WORKSPACE_ID,
      name: 'L4 Live Settings',
      rootPath: WORKSPACE_ROOT,
      workspaceRootPath: WORKSPACE_ROOT,
      sessionRootPath: `${WORKSPACE_ROOT}/sessions`,
    } as never,
    session: {
      id: `session-l4-${sessionCounter}`,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      workingDirectory: WORKSPACE_ROOT,
    } as never,
    ...overrides,
  } as BackendConfig;
}

type Agent = InstanceType<typeof ClaudeAgent>;

async function runTurn(agent: Agent, message: string): Promise<AgentEvent[]> {
  const chatImpl = (agent as unknown as {
    chatImpl: (message: string) => AsyncGenerator<AgentEvent>;
  }).chatImpl.bind(agent);
  const events: AgentEvent[] = [];
  for await (const event of chatImpl(message)) events.push(event);
  return events;
}

let agents: Agent[] = [];

function makeAgent(overrides: Partial<BackendConfig> = {}): Agent {
  const config = agentConfig(overrides);
  const agent = new ClaudeAgent(config) as Agent;
  agents.push(agent);
  return agent;
}

/**
 * Put this agent's session into a permission mode the way the UI does.
 *
 * `ClaudeAgent.setPermissionMode` writes the session-keyed mode store that
 * `chatImpl` reads through `getPermissionMode(sessionKey)` — the same key, since
 * both derive it from `config.workspace.id` + `config.session.id`.
 */
function putInMode(agent: Agent, mode: PermissionMode): void {
  agent.setPermissionMode(mode);
}

/**
 * A minimal `McpClientPool` duck whose connected slug list is MUTABLE between
 * turns — which is the whole point, because "a source was activated" is exactly
 * "the pool now reports one more slug" and `createSourceProxyServers` reads it
 * afresh every turn.
 */
function fakePool(): { slugs: string[]; pool: unknown } {
  const state = { slugs: ['linear'] as string[] };
  return {
    get slugs() { return state.slugs; },
    set slugs(next: string[]) { state.slugs = next; },
    pool: {
      getConnectedSlugs: () => state.slugs,
      slugsForLeaser: () => state.slugs,
      getTools: (slug: string) => [
        { name: 'ping', description: `${slug} ping`, inputSchema: { type: 'object' } },
      ],
      getProxyName: (slug: string, name: string) => `mcp__${slug}__${name}`,
      // W2-l, 2026-09-03 — the two reads `createSourceProxyServers` grew after
      // this duck was written, and their absence is what made 8 of this file's
      // 41 cases red at HEAD (`2026-07-29-known-failing-tests.md`). Not a
      // product defect and not a flake: `alwaysLoadProxyToolNames` arrived with
      // `ff28207ea` (P2.454, 2026-08-31) and `getInstructions` with `6acef70b7`
      // (2026-08-29), both on the real `McpClientPool`, and a duck typed as
      // `never` cannot fail the build when the interface it stands in for
      // grows. Every affected case is one that calls `makeAgentWithPool`; the
      // rest of the file never enters that code path, which is exactly the
      // 8-of-41 split the register recorded.
      //
      // Empty answers rather than fixtures: no case here is about the pin or
      // about server instructions, and inventing content would make this duck
      // assert things its own suite does not test.
      alwaysLoadProxyToolNames: () => new Set<string>(),
      getInstructions: () => undefined,
      // D1.440, 2026-09-20 — the THIRD read to arrive this way, exactly as the
      // register entry above predicted: `toolTimeoutMsForSlug` landed on the
      // real `McpClientPool` and on `createSourceProxyServers` in one commit
      // (`2547cba52`, D1.219) and the same eight `makeAgentWithPool` cases went
      // red with `pool.toolTimeoutMsForSlug is not a function` — naming the
      // duck's caller, never the commit that widened the interface. `undefined`
      // is the real pool's own answer for a slug with no per-server timeout.
      toolTimeoutMsForSlug: () => undefined,
      callTool: async () => ({ content: 'ok', isError: false }),
      // Registered at construction: the Claude runtime routes `elicitation/create`
      // back through the pool, and an unleased pool keeps the single-owner setter.
      setElicitationHandler: () => {},
      registerElicitationHandler: () => () => {},
      // An agent that OWNS its pool (no leaser id) tears it down on destroy.
      disconnectAll: async () => {},
    },
  };
}

/** An agent whose MCP server names follow `pool.slugs`, plus the always-present `session`. */
function makeAgentWithPool(): { agent: Agent; pool: ReturnType<typeof fakePool> } {
  const pool = fakePool();
  const agent = makeAgent({ mcpPool: pool.pool as never });
  return { agent, pool };
}

beforeEach(() => {
  rigArmed = true;
  sessions.length = 0;
  scripts.length = 0;
  rig.omit.clear();
  rig.reject.clear();
  rig.hang.clear();
  rig.mcpResult = null;
  rig.duringSetModel = null;
});

afterEach(() => {
  for (const agent of agents.splice(0)) agent.destroy();
  rigArmed = false;
});

// ---------------------------------------------------------------------------
// MODEL
// ---------------------------------------------------------------------------

describe('the model moves on a live session', () => {
  it('THE CLAIM: a model change goes through setModel and starts no second child', async () => {
    const agent = makeAgent();

    await runTurn(agent, 'turn one');
    agent.setModel('claude-opus-4-1');
    const second = await runTurn(agent, 'turn two');

    // One child for both turns — and the setter is what made that possible, so
    // both facts are asserted rather than one being inferred from the other.
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.setModelCalls).toEqual(['claude-opus-4-1']);
    // The second turn really ran, on the same channel, and really completed.
    expect(sessions[0]!.prompts.map(userLineOf)).toEqual(['turn one', 'turn two']);
    expect(second.filter(event => event.type === 'complete')).toHaveLength(1);
    expect(sessions[0]!.aborted).toBe(false);
  });

  it('THE CONTROL: an option with no setter respawns on the same rig', async () => {
    // Without this, "no second child" proves only that the rig cannot count to
    // two. `effort` is hashed into the signature and has no usable live setter
    // (`setMaxThinkingTokens` is deprecated and cannot express effort at all),
    // so a thinking change is a genuine respawn and is expected to stay one.
    const agent = makeAgent();

    await runTurn(agent, 'turn one');
    agent.setThinkingLevel('off');
    await runTurn(agent, 'turn two');

    expect(sessions).toHaveLength(2);
    // And it respawned INSTEAD of setting anything — not as well as.
    expect(sessions[0]!.setModelCalls).toEqual([]);
    expect(sessions[0]!.aborted).toBe(true);
  });

  it('the same model twice is not a drift — no setter call, no respawn', async () => {
    // A reconciliation that fires on every turn would be a per-turn control
    // round trip on the turn's critical path, for nothing.
    const agent = makeAgent();

    await runTurn(agent, 'turn one');
    agent.setModel('claude-sonnet-4-6');
    await runTurn(agent, 'turn two');

    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.setModelCalls).toEqual([]);
  });

  /**
   * THE MEASUREMENT THE PLAN'S OWN CLAIM NEEDED.
   *
   * The row reads "switching model mid-session stops costing the context". L0's
   * reviewer flagged that as unestablished, and it is: today's respawn carries
   * `resume`, so the conversation is replayed rather than lost. What a model
   * switch costs today is a PROCESS — a spawn, a transcript replay and a
   * prompt-cache miss — and that is what L4 removes.
   */
  it('WHAT THE OLD BEHAVIOUR COST: the respawn kept the context via `resume`, and lost the process', async () => {
    const agent = makeAgent();

    await runTurn(agent, 'turn one');
    // Force the pre-L4 shape by drifting an option that still has no setter.
    agent.setThinkingLevel('off');
    await runTurn(agent, 'turn two');

    expect(sessions).toHaveLength(2);
    // Turn 1 opened a fresh conversation…
    expect(sessions[0]!.options.resume).toBeUndefined();
    // …and the replacement child was told to resume the conversation the first
    // one reported. So the context survived a respawn even before L4.
    expect(sessions[1]!.options.resume).toBe('fake-live-settings-session');
    // The cost is the child itself: the first one was torn down and a second
    // was started, which is exactly what the live path avoids.
    expect(sessions[0]!.aborted).toBe(true);
  });

  it('a model switch the CLI REFUSES falls back to the respawn', async () => {
    // The CLI's `set_model` handler has an unrecognized-model arm and a
    // not-allowed arm, both of which answer with an error verdict the SDK turns
    // into a rejected promise. A rejected setter must not leave the turn running
    // on the old model in silence.
    //
    // The model here is a Claude one ON PURPOSE. A gateway id such as
    // `tgpt/qwen35-…` never reaches the setter at all — it is not a Claude
    // model, so `resolveClaudeThinkingOptions` returns `maxThinkingTokens: 0`
    // instead of adaptive+effort, the signature drifts and the session respawns
    // first. Using one here would have made this test pass while proving
    // nothing about refusals, which is the same false green the L2 file carried.
    rig.reject.add('setModel');
    const agent = makeAgent();

    await runTurn(agent, 'turn one');
    agent.setModel('claude-opus-4-1');
    await runTurn(agent, 'turn two');

    expect(sessions[0]!.setModelCalls).toEqual(['claude-opus-4-1']);
    expect(sessions).toHaveLength(2);
    // The new child is constructed with the model the setter could not deliver.
    expect(sessions[1]!.options.model).toBe('claude-opus-4-1');
  });

  it('an SDK without the setter falls back to the respawn', async () => {
    // The setter surface is version-dependent — this repo already recorded three
    // setters where the shipped SDK has fifteen — so the guard is a `typeof`
    // check and its fallback is the pre-L4 behaviour.
    rig.omit.add('setModel');
    const agent = makeAgent();

    await runTurn(agent, 'turn one');
    agent.setModel('claude-opus-4-1');
    await runTurn(agent, 'turn two');

    expect(sessions).toHaveLength(2);
  });

  /**
   * THE LIMIT OF THE MODEL CLAIM, pinned so it cannot become folklore.
   *
   * `thinking` / `effort` / `maxThinkingTokens` are DERIVED FROM THE MODEL by
   * `resolveClaudeThinkingOptions`, and they are still hashed. So a model switch
   * is live only while the derived thinking shape is unchanged — which is true
   * between two non-Haiku Claude models and false the moment the switch crosses
   * into Haiku (token budget instead of adaptive+effort) or out of the Claude
   * family altogether (`maxThinkingTokens: 0`).
   */
  it('THE LIMIT: a switch that also changes the derived thinking shape still respawns', async () => {
    const live = makeAgent();
    await runTurn(live, 'turn one');
    live.setModel('claude-opus-4-1');   // adaptive + effort on both sides
    await runTurn(live, 'turn two');
    expect(sessions).toHaveLength(1);

    sessions.length = 0;
    const rebuilt = makeAgent();
    await runTurn(rebuilt, 'turn one');
    rebuilt.setModel('claude-haiku-4-5'); // token budget, not adaptive+effort
    await runTurn(rebuilt, 'turn two');
    expect(sessions).toHaveLength(2);
    expect(sessions[0]!.setModelCalls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// PERMISSION MODE
// ---------------------------------------------------------------------------

describe('the permission mode moves on a live session', () => {
  it('THE CLAIM: a mode change goes through setPermissionMode and starts no second child', async () => {
    const agent = makeAgent();
    putInMode(agent, 'default');

    await runTurn(agent, 'turn one');
    putInMode(agent, 'acceptEdits');
    await runTurn(agent, 'turn two');

    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.setPermissionModeCalls).toEqual(['acceptEdits']);
    expect(sessions[0]!.prompts.map(userLineOf)).toEqual(['turn one', 'turn two']);
  });

  it('the mode rides the ONE table — the SDK is told `default`, never a second spelling', async () => {
    // `explore` has no SDK member and stays ours layered on theirs. The live
    // path reads the mode back off the options, which
    // `buildClaudePermissionModeOptions` already put there through
    // `toClaudeSdkPermissionMode`, precisely so a second spelling cannot appear
    // here and drift from the first.
    const agent = makeAgent();
    putInMode(agent, 'dontAsk');

    await runTurn(agent, 'turn one');
    putInMode(agent, 'plan');
    await runTurn(agent, 'turn two');

    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.setPermissionModeCalls).toEqual(['default']);
  });

  it('two Nessy modes that share one SDK mode do not touch the child at all', async () => {
    // `plan` and `default` both map to `'default'` (F1.1050: this pair was
    // explore/plan until explore retired). Our own PreToolUse gate reads the mode
    // per call and already sees the change; the SDK has nothing to be told.
    const agent = makeAgent();
    putInMode(agent, 'default');

    await runTurn(agent, 'turn one');
    putInMode(agent, 'plan');
    await runTurn(agent, 'turn two');

    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.setPermissionModeCalls).toEqual([]);
  });

  it('THE ONE MODE THAT STILL RESPAWNS: bypassPermissions, and the CLI says why', async () => {
    // `allowDangerouslySkipPermissions` is a SPAWN-TIME CLI flag
    // (`--allow-dangerously-skip-permissions`), and the shipped CLI refuses the
    // live transition in its own words: "Cannot set permission mode to
    // bypassPermissions because the session was not launched with
    // --dangerously-skip-permissions". So the flag stays in the signature and
    // crossing the boundary rebuilds the child — deliberately, not by omission.
    const agent = makeAgent();
    putInMode(agent, 'default');

    await runTurn(agent, 'turn one');
    putInMode(agent, 'bypassPermissions');
    await runTurn(agent, 'turn two');

    expect(sessions).toHaveLength(2);
    // It respawned INSTEAD of asking — the refusal is never even attempted.
    expect(sessions[0]!.setPermissionModeCalls).toEqual([]);
    expect(sessions[1]!.options.allowDangerouslySkipPermissions).toBe(true);
    expect(sessions[1]!.options.permissionMode).toBe('bypassPermissions');
  });

  it('leaving bypass respawns too — the flag is wrong in that direction as well', async () => {
    const agent = makeAgent();
    putInMode(agent, 'bypassPermissions');

    await runTurn(agent, 'turn one');
    putInMode(agent, 'default');
    await runTurn(agent, 'turn two');

    expect(sessions).toHaveLength(2);
    expect(sessions[1]!.options.allowDangerouslySkipPermissions).toBeUndefined();
  });

  it('a refused setPermissionMode falls back to the respawn', async () => {
    rig.reject.add('setPermissionMode');
    const agent = makeAgent();
    putInMode(agent, 'default');

    await runTurn(agent, 'turn one');
    putInMode(agent, 'auto');
    await runTurn(agent, 'turn two');

    expect(sessions[0]!.setPermissionModeCalls).toEqual(['auto']);
    expect(sessions).toHaveLength(2);
    expect(sessions[1]!.options.permissionMode).toBe('auto');
  });
});

// ---------------------------------------------------------------------------
// MCP SERVERS — the answer L1 got wrong
// ---------------------------------------------------------------------------

describe('the MCP server set moves on a live session', () => {
  it('THE CLAIM: a newly active source is added by setMcpServers, with no second child', async () => {
    const { agent, pool } = makeAgentWithPool();

    await runTurn(agent, 'turn one');
    expect(Object.keys(sessions[0]!.options.mcpServers as object).sort()).toEqual(['linear', 'nessy-sources-resources', 'session']);

    // The source panel activates a second source between turns.
    pool.slugs = ['linear', 'github'];
    await runTurn(agent, 'turn two');

    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.setMcpServersCalls).toEqual([['github', 'linear', 'nessy-sources-resources', 'session']]);
    expect(sessions[0]!.aborted).toBe(false);
    // And the turn really ran on that child, so "no respawn" is not "no turn".
    expect(sessions[0]!.prompts.map(userLineOf)).toEqual(['turn one', 'turn two']);
  });

  it('a deactivated source is removed the same way', async () => {
    const { agent, pool } = makeAgentWithPool();
    pool.slugs = ['linear', 'github'];

    await runTurn(agent, 'turn one');
    pool.slugs = ['linear'];
    await runTurn(agent, 'turn two');

    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.setMcpServersCalls).toEqual([['linear', 'nessy-sources-resources', 'session']]);
  });

  it('the same set twice is not a drift — no control request at all', async () => {
    // Source proxy servers are rebuilt every turn, so the INSTANCES differ on
    // every reconciliation while the names do not. Reacting to instance identity
    // would put an `mcp_set_servers` on the critical path of every turn forever
    // — and would achieve nothing, because the SDK's own diff is by key and
    // never reconnects a name it already holds.
    const { agent } = makeAgentWithPool();

    await runTurn(agent, 'turn one');
    await runTurn(agent, 'turn two');

    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.setMcpServersCalls).toEqual([]);
  });

  it('THE CONTROL: a server that fails to connect is reported, not thrown — and it respawns', async () => {
    // `setMcpServers` resolves with `{added, removed, errors}`. A connect
    // failure arrives in `errors` with no exception, so an un-thrown call is not
    // evidence that the turn has the tools it needs.
    const { agent, pool } = makeAgentWithPool();

    await runTurn(agent, 'turn one');
    rig.mcpResult = { added: [], removed: [], errors: { github: 'connect ECONNREFUSED' } };
    pool.slugs = ['linear', 'github'];
    await runTurn(agent, 'turn two');

    expect(sessions[0]!.setMcpServersCalls).toEqual([['github', 'linear', 'nessy-sources-resources', 'session']]);
    expect(sessions).toHaveLength(2);
    expect(Object.keys(sessions[1]!.options.mcpServers as object).sort())
      .toEqual(['github', 'linear', 'nessy-sources-resources', 'session']);
  });

  it('THE CONTROL: a silently incomplete reconciliation respawns too', async () => {
    // No errors, no exception — and the server we asked for is simply not in
    // `added`. Trusting the call would run the turn without the tools the user
    // just enabled, with nothing anywhere to say so.
    const { agent, pool } = makeAgentWithPool();

    await runTurn(agent, 'turn one');
    rig.mcpResult = { added: [], removed: [], errors: {} };
    pool.slugs = ['linear', 'github'];
    await runTurn(agent, 'turn two');

    expect(sessions).toHaveLength(2);
  });

  it('an SDK without setMcpServers falls back to the respawn', async () => {
    rig.omit.add('setMcpServers');
    const { agent, pool } = makeAgentWithPool();

    await runTurn(agent, 'turn one');
    pool.slugs = ['linear', 'github'];
    await runTurn(agent, 'turn two');

    expect(sessions).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// SOURCE ACTIVATION — the one path in the product where the MCP set changes
// ---------------------------------------------------------------------------

describe('source activation — what it actually does, measured', () => {
  /**
   * The real chain, not a stand-in for it: the model calls a tool belonging to
   * an inactive source, the CLI answers "No such tool available", the agent
   * activates the source, ends the turn, and the renderer auto-retries.
   *
   * TWO THINGS THIS PINS, and both were written down wrongly before it existed.
   *
   * 1. **The interrupt on this path has never fired.** L2 recorded the sequence
   *    as "interrupt first so the CLI ends its own turn and writes its own
   *    journal rather than being SIGTERMed mid-tool". Every caller closes the
   *    slot on the line above — `source_activated` is the turn's last event by
   *    contract — and `interruptLiveTurn` returns at `slot.settled` before
   *    sending anything. So the child is SIGTERMed after all.
   * 2. **The teardown stays anyway, and L4 did not remove it.** Its stated
   *    reason was wrong (`Query.setMcpServers` is the live equivalent the note
   *    said did not exist), but a live session here would leave a child
   *    unwinding an interrupted turn while the auto-retry writes into the same
   *    channel — the exact condition L0's review reproduced coalescing under.
   *    The Sources-panel path gets the live reconciliation; this one keeps its
   *    hard bound.
   */
  function armInactiveSource(agent: Agent, slug: string): void {
    const manager = (agent as unknown as {
      sourceManager: { getAllSources(): unknown[]; isSourceActive(slug: string): boolean };
    }).sourceManager;
    manager.getAllSources = () => [{ config: { slug } }];
    manager.isSourceActive = () => false;
  }

  function armActivationTurn(agent: Agent, pool: ReturnType<typeof fakePool>): void {
    armInactiveSource(agent, 'github');
    agent.onSourceActivationRequest = async () => {
      // Activation is what makes the pool report the new slug next turn.
      pool.slugs = ['linear', 'github'];
      return true;
    };
    scripts.push(async function* toolCallOnAnInactiveSource() {
      yield assistantMessage('let me check github');
      yield toolResultMessage('tool-1', 'No such tool available: mcp__github__ping');
      yield resultMessage();
    });
  }

  it('the turn ends on `source_activated`, the child is torn down, and the retry resumes', async () => {
    const { agent, pool } = makeAgentWithPool();
    armActivationTurn(agent, pool);

    const activation = await runTurn(agent, 'check github');

    // The turn ended on the contract event, with no `complete` after it.
    expect(activation.at(-1)).toMatchObject({ type: 'source_activated', sourceSlug: 'github' });
    // MEASURED: the interrupt this path claims to send does not reach the child.
    expect(sessions[0]!.interrupts).toBe(0);
    // The teardown is what ends it, and it is deliberate.
    expect(sessions[0]!.aborted).toBe(true);

    // The renderer's auto-retry builds a new child with the new server set and
    // resumes the conversation — the pre-L4 shape, unchanged, on purpose.
    await runTurn(agent, 'check github');
    expect(sessions).toHaveLength(2);
    expect(Object.keys(sessions[1]!.options.mcpServers as object).sort())
      .toEqual(['github', 'linear', 'nessy-sources-resources', 'session']);
    expect(sessions[1]!.options.resume).toBe('fake-live-settings-session');
    // Nothing was reconciled onto the dead child.
    expect(sessions[0]!.setMcpServersCalls).toEqual([]);
  });

  it('THE CONTRAST: the same server set arriving between turns IS reconciled live', async () => {
    // The Sources panel does not go through the mid-turn path at all —
    // `setSourceServers` reconciles the pool with no abort anywhere, so the
    // change simply shows up in the next turn's options. That is the shape L4
    // makes live, and running both on one rig is what stops the two being
    // confused for each other.
    const { agent, pool } = makeAgentWithPool();

    await runTurn(agent, 'turn one');
    pool.slugs = ['linear', 'github'];
    await runTurn(agent, 'turn two');

    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.setMcpServersCalls).toEqual([['github', 'linear', 'nessy-sources-resources', 'session']]);
    expect(sessions[0]!.aborted).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// THE GUARANTEE L2's REVIEW HAD TO RESTORE ONCE — ARRIVING BY A SECOND DOOR
// ---------------------------------------------------------------------------

describe('a session that dies while a setter is in flight', () => {
  it('the turn does not run on the dead child, and the successor keeps its own record', async () => {
    // Every setter is AWAITED, and a teardown can land during any of those
    // awaits — a capability revoke, an internal error, a dispose. Two things go
    // wrong without the generation check: the turn is handed the input channel
    // of a child that no longer exists, and the settings record built from the
    // dead session's values is written over the successor's.
    const agent = makeAgent();

    await runTurn(agent, 'turn one');
    rig.duringSetModel = () => {
      // Session death, landing exactly inside the control round trip.
      agent.forceAbort(AbortReason.InternalError);
      rig.duringSetModel = null;
    };
    agent.setModel('claude-opus-4-1');
    const second = await runTurn(agent, 'turn two');

    // The setter was reached, the old child was killed, and turn two ran on a
    // NEW one rather than on the corpse.
    expect(sessions[0]!.setModelCalls).toEqual(['claude-opus-4-1']);
    expect(sessions[0]!.aborted).toBe(true);
    expect(sessions).toHaveLength(2);
    expect(sessions[1]!.prompts.map(userLineOf)).toEqual(['turn two']);
    expect(second.filter(event => event.type === 'complete')).toHaveLength(1);

    // The successor's record is its own: a third turn on the same model is not a
    // drift, so nothing is re-sent to it.
    await runTurn(agent, 'turn three');
    expect(sessions).toHaveLength(2);
    expect(sessions[1]!.setModelCalls).toEqual([]);
  });
});

describe('a child that stops answering its control channel', () => {
  it('REGRESSION: a setter that never answers does not hang the turn', async () => {
    // The SDK's `awaitControlResponse` settles on the response, on a CLI error
    // verdict, or at query cleanup — and NEVER on a clock. So a wedged child
    // would hold this turn open forever, which is exactly the defect L2's review
    // found on the interrupt path. Same fix, same reason: a deadline, then the
    // respawn that every other failure here degrades to.
    rig.hang.add('setModel');
    const agent = makeAgent();
    (agent as unknown as { interruptDeadlineMs: number }).interruptDeadlineMs = 150;

    await runTurn(agent, 'turn one');
    agent.setModel('claude-opus-4-1');
    const second = await runTurn(agent, 'turn two');

    // It ended, and it ended by rebuilding rather than by giving up on the turn.
    expect(sessions).toHaveLength(2);
    expect(second.filter(event => event.type === 'complete')).toHaveLength(1);
    expect(sessions[1]!.prompts.map(userLineOf)).toEqual(['turn two']);
  }, 10_000);
});

// ---------------------------------------------------------------------------
// THE USD BUDGET CAP — P2.28
// ---------------------------------------------------------------------------

/**
 * Arm this agent's ceiling at the seam `chatImpl` actually reads.
 *
 * `getMaxBudgetUsd` is `BaseAgent`'s own config reader — it calls
 * `loadConfigDefaults()` on every call, which is what makes the ceiling
 * per-turn fresh — and overriding it here is the same seam
 * `pi-agent-max-budget.test.ts` uses. Pinning the SDK option against THIS
 * method rather than against a config fixture is the point: the two authorities
 * (the SDK's own cap and the host loop in `BaseAgent.chat`) must read one
 * source, or they cap at different numbers.
 */
function withCap(agent: Agent, maxBudgetUsd: number): Agent {
  (agent as unknown as { getMaxBudgetUsd: () => number }).getMaxBudgetUsd = () => maxBudgetUsd;
  return agent;
}

describe('the USD budget cap is armed on the SDK query', () => {
  it('THE CLAIM: the configured ceiling reaches the child as `maxBudgetUsd`', async () => {
    // `Options.maxBudgetUsd` — "the query will stop if this budget is exceeded,
    // returning an `error_max_budget_usd` result" (sdk.d.ts). Before this row
    // nothing set it, and `event-adapter.ts` mapped a verdict nobody could
    // provoke.
    const agent = withCap(makeAgent(), 2.5);

    await runTurn(agent, 'turn one');

    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.options.maxBudgetUsd).toBe(2.5);
  });

  it('no configured ceiling leaves the option ABSENT rather than zero', async () => {
    // `getMaxBudgetUsd` returns 0 for every "off" spelling (unset, non-finite,
    // non-positive), and 0 is a REAL ceiling to the SDK — passing it would stop
    // the first turn of every uncapped session. Absence is the only honest
    // spelling of "no cap".
    const agent = withCap(makeAgent(), 0);

    await runTurn(agent, 'turn one');

    expect('maxBudgetUsd' in sessions[0]!.options).toBe(false);
  });

  it('the ceiling is re-read PER TURN — a raised cap reaches the next turn', async () => {
    // The host loop re-reads its own ceiling at the start of every turn
    // (`base-agent.ts`: "Read the ceiling once per turn, like the Pi loop
    // does"), so a cap the user raises binds again on the next send. The SDK
    // copy has to move with it or the two disagree — and it has NO live setter,
    // so the only way to move it is the respawn the signature forces.
    const agent = makeAgent();
    withCap(agent, 1);
    await runTurn(agent, 'turn one');
    withCap(agent, 5);
    const second = await runTurn(agent, 'turn two');

    expect(sessions).toHaveLength(2);
    expect(sessions[0]!.options.maxBudgetUsd).toBe(1);
    expect(sessions[1]!.options.maxBudgetUsd).toBe(5);
    // The second turn really ran on the new child rather than merely spawning it.
    expect(sessions[1]!.prompts.map(userLineOf)).toEqual(['turn two']);
    expect(second.filter(event => event.type === 'complete')).toHaveLength(1);
  });

  it('THE CONTROL: an unchanged ceiling is not a drift — the child is reused', async () => {
    // Without this, "a raised cap respawns" proves only that the rig spawns.
    const agent = withCap(makeAgent(), 1);

    await runTurn(agent, 'turn one');
    await runTurn(agent, 'turn two');

    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.prompts.map(userLineOf)).toEqual(['turn one', 'turn two']);
  });

  it("the SDK's own verdict arrives as ONE complete naming the budget", async () => {
    // The reader for the cap nothing used to set. `error_max_budget_usd` is one
    // of the four `SDKResultError` subtypes and maps to `max_budget_usd`
    // (`event-adapter.ts` CLAUDE_RESULT_SUBTYPE_REASON) — a cap is a STOP, so
    // no `error` event rides with it and the turn's assistant text survives.
    scripts.push(async function* () {
      yield assistantMessage('spent it');
      yield resultMessage({ subtype: 'error_max_budget_usd', is_error: true, errors: [] });
    });
    const agent = withCap(makeAgent(), 1);

    const events = await runTurn(agent, 'go');

    const completes = events.filter(event => event.type === 'complete');
    expect(completes).toHaveLength(1);
    expect(completes[0]).toMatchObject({ terminalReason: 'max_budget_usd' });
    expect(events.filter(event => event.type === 'error')).toEqual([]);
  });

  it('forceAbort(MaxBudgetUsd) INTERRUPTS rather than kills, and the reader names the budget', async () => {
    // What this pins is `forceAbort`'s REASON DISPATCH, not a production
    // fallback — the name it carried ("THE HOST FALLBACK SURVIVES: an SDK-silent
    // cap is still named at the reader") described a path that cannot run.
    // `BaseAgent.chat` only ever calls `forceAbort(MaxBudgetUsd)` AFTER yielding
    // the terminal `complete`, and the reader closed the slot on that event
    // (`turn-slot.close` sets `stop` synchronously), so in production
    // `interruptLiveTurn` returns at its `slot.settled` guard and the reason
    // reaches the transcript from the host's own `{ ...event, terminalReason }`
    // spread instead. This script aborts MID-TURN, which is why the reader arm
    // runs here at all.
    //
    // Both assertions are still worth their keep: `MaxBudgetUsd` must sit on the
    // interrupt arm of the dispatch beside `UserStop` (a cap must not kill the
    // conversation), and the arm it lands on must stamp `max_budget_usd` rather
    // than `user_stop`.
    let agent: Agent | null = null;
    scripts.push(async function* () {
      yield assistantMessage('spent it');
      agent!.forceAbort(AbortReason.MaxBudgetUsd);
      yield resultMessage();
    });
    agent = withCap(makeAgent(), 1);

    const events = await runTurn(agent, 'go');

    const completes = events.filter(event => event.type === 'complete');
    expect(completes).toHaveLength(1);
    expect(completes[0]).toMatchObject({ terminalReason: 'max_budget_usd' });
    // Turn-scoped: interrupted, never killed — the conversation outlives a cap.
    expect(sessions[0]!.interrupts).toBe(1);
    expect(sessions[0]!.aborted).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// THE COST COUNTER ACROSS A RESPAWN — P2.35
// ---------------------------------------------------------------------------

describe("the child's running cost total, across the boundary where it restarts", () => {
  /** `costUsd` off each turn's terminal `complete`, in order. */
  function turnCosts(events: AgentEvent[]): Array<number | undefined> {
    return events
      .filter(event => event.type === 'complete')
      .map(event => (event as { usage?: { costUsd?: number } }).usage?.costUsd);
  }

  it('THE CLAIM: a respawn restarts the SDK total, and the turn costs stay honest', async () => {
    // `total_cost_usd` is scoped to one `query()` call (`sdk.d.ts:4359`), so the
    // child that turn three runs on begins counting again at zero while the
    // session's real spend continues. The adapter OUTLIVES that respawn —
    // it is an agent field — so its remembered total has to be cleared on the
    // same line that spawns the child, or turn three's $0.50 would difference
    // against a dead child's $3.00 and report nothing at all.
    const totals = [1, 3, 0.5, 2];
    for (const total of totals) {
      scripts.push(async function* () {
        yield assistantMessage('ok');
        yield resultMessage({ total_cost_usd: total });
      });
    }
    const agent = makeAgent();

    const first = await runTurn(agent, 'turn one');
    const second = await runTurn(agent, 'turn two');
    // An option with no live setter — the same lever the CONTROL above uses to
    // force a genuine respawn rather than a simulated one.
    agent.setThinkingLevel('off');
    const third = await runTurn(agent, 'turn three');
    const fourth = await runTurn(agent, 'turn four');

    // The respawn really happened, and it happened where this test says it did.
    expect(sessions).toHaveLength(2);
    expect(sessions[0]!.prompts.map(userLineOf)).toEqual(['turn one', 'turn two']);
    expect(sessions[1]!.prompts.map(userLineOf)).toEqual(['turn three', 'turn four']);

    // Child one: 1 then 3 → $1 and $2. Child two: 0.5 then 2 → $0.50 and $1.50.
    expect([...turnCosts(first), ...turnCosts(second)]).toEqual([1, 2]);
    expect([...turnCosts(third), ...turnCosts(fourth)]).toEqual([0.5, 1.5]);
    // The session spent each child's final total exactly once: 3 + 2 = 5.
    const spent = [first, second, third, fourth]
      .flatMap(turnCosts)
      .reduce((sum: number, cost) => sum + (cost ?? 0), 0);
    expect(spent).toBe(5);
  });

  it('THE CONTROL: with no respawn the same totals are one rising series', async () => {
    // Without this, "the reset fired" is indistinguishable from "the adapter
    // never remembers anything". Same four totals, one child, no reset.
    for (const total of [1, 3, 0.5, 2]) {
      scripts.push(async function* () {
        yield assistantMessage('ok');
        yield resultMessage({ total_cost_usd: total });
      });
    }
    const agent = makeAgent();

    const costs: Array<number | undefined> = [];
    for (const message of ['one', 'two', 'three', 'four']) {
      costs.push(...turnCosts(await runTurn(agent, message)));
    }

    expect(sessions).toHaveLength(1);
    // 1 → 3 is $2 — the half that still does this control's original job: a
    // second entry of 2 rather than 3 is the proof that the adapter REMEMBERS,
    // and an adapter that remembered nothing would report the four totals
    // verbatim as [1, 3, 0.5, 2].
    //
    // The second half changed with `a192475d5` (P2.46, 2026-09-03), which split
    // the SDK's crash condition from its mid-session RESTART condition. This
    // control still asserted the pre-split fold: `0 < running < baseline` used
    // to report nothing and keep the dead baseline. It is now the restart
    // branch — a smaller non-zero total is a NEW running total, so all of it is
    // new spend and it rebaselines: 0.5 reports 0.5, then 2 − 0.5 = 1.5.
    // Folding the two back together is the silent permanent UNDERCOUNT that
    // commit exists to prevent, so the production side is the right one and
    // this expectation was the stale one.
    //
    // WHAT THIS CONTROL NO LONGER SEPARATES, stated so nobody re-derives it:
    // the restart branch now INFERS what the explicit respawn reset used to
    // say, so this series equals the respawned test's second child exactly.
    // That test's own `sessions).toHaveLength(2)` and its per-child prompt
    // split are what prove the respawn happened; this file's `toHaveLength(1)`
    // above is the other side of that pair.
    expect(costs).toEqual([1, 2, 0.5, 1.5]);
  });
});

// ---------------------------------------------------------------------------
// THE PER-MODEL BREAKDOWN ACROSS THE SAME RESPAWN — P2.42
// ---------------------------------------------------------------------------

describe("the child's running per-model totals, across the boundary where they restart", () => {
  /** The session breakdown these turns fold into, the way `SessionManager` does. */
  function mergeTurns(events: AgentEvent[], previous: Record<string, PersistedModelUsage> | undefined) {
    let merged = previous;
    for (const event of events) {
      if (event.type !== 'complete') continue;
      merged = mergeModelUsage(merged, (event as { usage?: { modelUsage?: Record<string, PersistedModelUsage> } }).usage?.modelUsage);
    }
    return merged;
  }

  /** One model's cumulative counters, in the SDK's own field names. */
  const opusTotals = (costUSD: number) => ({
    opus: {
      inputTokens: costUSD * 100,
      outputTokens: costUSD * 10,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      webSearchRequests: 0,
      costUSD,
      contextWindow: 200_000,
    },
  });

  it('THE CLAIM: a respawn restarts the per-model totals, and the breakdown stays honest', async () => {
    // `modelUsage` is scoped to one `query()` call (`sdk.d.ts:4367`), and the
    // adapter that differences it is an agent field that OUTLIVES the respawn.
    // Child one ends at $3, child two ends at $6, so the session spent $9 —
    // the number a breakdown differenced against a per-CHILD baseline lands on.
    for (const total of [1, 3, 5, 6]) {
      scripts.push(async function* () {
        yield assistantMessage('ok');
        yield resultMessage({ modelUsage: opusTotals(total), total_cost_usd: total });
      });
    }
    const agent = makeAgent();

    let merged: Record<string, PersistedModelUsage> | undefined;
    merged = mergeTurns(await runTurn(agent, 'turn one'), merged);
    merged = mergeTurns(await runTurn(agent, 'turn two'), merged);
    // An option with no live setter — a genuine respawn rather than a simulated one.
    agent.setThinkingLevel('off');
    merged = mergeTurns(await runTurn(agent, 'turn three'), merged);
    merged = mergeTurns(await runTurn(agent, 'turn four'), merged);

    expect(sessions).toHaveLength(2);
    expect(merged?.opus?.costUsd).toBe(9);
    expect(merged?.opus?.inputTokens).toBe(900);
    expect(merged?.opus?.costReporting).toBe('reported');
  });

  it('THE CONTROL: with no respawn the same totals are one rising series', async () => {
    // Without this, "the reset fired" is indistinguishable from "the adapter
    // never remembers anything". Same four totals, one child, no reset: the
    // session's breakdown is the LAST total, not the sum of the four.
    for (const total of [1, 3, 5, 6]) {
      scripts.push(async function* () {
        yield assistantMessage('ok');
        yield resultMessage({ modelUsage: opusTotals(total), total_cost_usd: total });
      });
    }
    const agent = makeAgent();

    let merged: Record<string, PersistedModelUsage> | undefined;
    for (const message of ['one', 'two', 'three', 'four']) {
      merged = mergeTurns(await runTurn(agent, message), merged);
    }

    expect(sessions).toHaveLength(1);
    expect(merged?.opus?.costUsd).toBe(6);
    expect(merged?.opus?.inputTokens).toBe(600);
  });
});

// ---------------------------------------------------------------------------
// WHAT MUST NOT BE PROMISED — and the guard that keeps it from rotting
// ---------------------------------------------------------------------------

describe('the SDK setter surface, read from the SDK rather than remembered', () => {
  /**
   * This test exists because the claim it checks ALREADY ROTTED ONCE: L1 and L2
   * were written against "exactly three live setters", the shipped SDK has
   * fifteen mutating methods, and the difference — `setMcpServers` — was the
   * whole reason source activation respawned. A hand-written note cannot notice
   * an SDK upgrade; this can.
   */
  function queryMethodNames(): string[] {
    const require = createRequire(import.meta.url);
    const entry = require.resolve('@anthropic-ai/claude-agent-sdk');
    const source = readFileSync(entry.replace(/sdk\.mjs$/, 'sdk.d.ts'), 'utf8');
    const start = source.indexOf('export declare interface Query extends AsyncGenerator');
    expect(start).toBeGreaterThan(-1);
    let depth = 0;
    let end = start;
    while (end < source.length) {
      if (source[end] === '{') depth += 1;
      else if (source[end] === '}') {
        depth -= 1;
        if (depth === 0) break;
      }
      end += 1;
    }
    const body = source.slice(start, end).replace(/\/\*[\s\S]*?\*\//g, '');
    return [...body.matchAll(/^ {4}(\w+)\s*(?:<[^>]*>)?\(/gm)].map(match => match[1]!);
  }

  it('the three methods L4 depends on are all there', () => {
    const methods = queryMethodNames();
    expect(methods).toContain('setModel');
    expect(methods).toContain('setPermissionMode');
    expect(methods).toContain('setMcpServers');
  });

  it('and `supportedCommands` is a GETTER, which is what made the old count wrong', () => {
    // It was recorded as one of "exactly three live setters". It returns the
    // slash-command list; it sets nothing.
    const methods = queryMethodNames();
    expect(methods).toContain('supportedCommands');
    expect(methods).toContain('supportedModels');
    expect(methods).toContain('supportedAgents');
  });

  it('NOTHING sets cwd, the system prompt, the tool set, the subagent set or our hooks', () => {
    // The five this plan may not promise. If an SDK upgrade ever adds one, this
    // fails and the promise can be revisited deliberately — instead of the
    // option quietly continuing to respawn for a reason that stopped being true.
    const methods = queryMethodNames();
    const forbidden = /^(set|update|replace)(Cwd|WorkingDirectory|SystemPrompt|Tools|Agents|Subagents|Hooks)$/i;
    expect(methods.filter(name => forbidden.test(name))).toEqual([]);
  });

  it('and nothing sets the USD ceiling either — which is why a raised cap respawns (P2.28)', () => {
    // `maxBudgetUsd` is hashed into `claudeLiveSessionSignature` for exactly this
    // reason. If an SDK upgrade ever adds a setter, this fails and the respawn
    // can be traded for a control request deliberately.
    const methods = queryMethodNames();
    expect(methods.filter(name => /budget/i.test(name))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// L5 — THE BACKGROUND-WORK LEVERS, READ RATHER THAN REMEMBERED
// ---------------------------------------------------------------------------

/**
 * The same guard as above, for the surface L5 measured and the follow-up row
 * will build on. It exists for the same reason: this plan has now had FOUR
 * premises refuted, and the one that cost the most (L4's) was a hand-written
 * count of the `Query` surface that rotted silently.
 *
 * What is asserted here is an INVENTORY, not a promise of behaviour. None of
 * these three is wired into the product yet, and the row that wires them says
 * so. What this stops is the next executor re-deriving the inventory by hand and
 * getting a different answer — or an SDK upgrade removing a lever the follow-up
 * row was written against, silently.
 */
describe('the SDK background-work surface, read from the SDK', () => {
  function sdkTypings(): string {
    const require = createRequire(import.meta.url);
    const entry = require.resolve('@anthropic-ai/claude-agent-sdk');
    return readFileSync(entry.replace(/sdk\.mjs$/, 'sdk.d.ts'), 'utf8');
  }

  function typeBody(source: string, anchor: string): string {
    const start = source.indexOf(anchor);
    expect(start).toBeGreaterThan(-1);
    let depth = 0;
    let end = start;
    while (end < source.length) {
      if (source[end] === '{') depth += 1;
      else if (source[end] === '}') {
        depth -= 1;
        if (depth === 0) break;
      }
      end += 1;
    }
    return source.slice(start, end).replace(/\/\*[\s\S]*?\*\//g, '');
  }

  it('`Query` carries both background-task controls', () => {
    // `backgroundTasks(toolUseId?)` is the Ctrl+B equivalent — it moves an
    // in-flight FOREGROUND Bash/subagent to the background and lets the turn
    // continue. `stopTask(taskId)` stops a running one. Neither is called
    // anywhere in this repo today; the renderer's own kill button still warns
    // "Killing agent tasks not yet implemented" and removes the row anyway.
    const body = typeBody(sdkTypings(), 'export declare interface Query extends AsyncGenerator');
    const methods = [...body.matchAll(/^ {4}(\w+)\s*(?:<[^>]*>)?\(/gm)].map(match => match[1]!);
    expect(methods).toContain('backgroundTasks');
    expect(methods).toContain('stopTask');
  });

  it('`SDKUserMessage` carries the native queue rank, and it is a THREE-valued enum', () => {
    // MEASURED 2026-08-17 against the shipped CLI, not inferred from the name:
    // the CLI enqueues every stream-json user message with `priority ?? "next"`
    // and dequeues by the rank map `{now:0,next:1,later:2}`. The behavioural
    // difference on an identical rig, with a turn in flight over a tool call:
    // `next` (and unset) FOLDS the second message into the running turn and
    // produces ONE result; `later` runs it as its own turn and produces TWO;
    // `now` interrupts the running turn outright, discarding its tool result.
    //
    // That is why the follow-up row cannot use the queue without this field:
    // one message written, no second result, and a slot that waits forever.
    const body = typeBody(sdkTypings(), 'export declare type SDKUserMessage = {');
    expect(body).toContain("priority?: 'now' | 'next' | 'later'");

    // TWO MORE FIELDS IN THE SAME STRUCT, both found by L5's review after the
    // first read stopped at `priority`. They are pinned here rather than in
    // prose because that is the discipline L4 established when a hand-written
    // surface claim hid `setMcpServers` for two whole tasks.
    //
    // `shouldQuery: false` appends to the transcript WITHOUT starting a turn —
    // the native answer to the follow-up row's stated blocker (a second write
    // producing a result no slot is waiting for). `origin` carries an explicit
    // obligation on us: an unstamped message is unattributed and fails closed at
    // the CLI's strict `isHuman()` gates. We do not stamp it today; whether that
    // costs anything user-visible is unmeasured and recorded as such.
    expect(body).toContain('shouldQuery?: boolean');
    expect(body).toContain('origin?: SDKMessageOrigin');
  });

  it('the five background-task messages are all still in the message union', () => {
    // The adapter maps every one of these (`backend/claude/event-adapter.ts`).
    // `background_tasks_changed` is the LEVEL signal whose per-process reset
    // this row implements; the other four are the edge bookends.
    const source = sdkTypings();
    const union = source.slice(source.indexOf('export declare type SDKMessage ='));
    const line = union.slice(0, union.indexOf(';'));
    for (const name of [
      'SDKBackgroundTasksChangedMessage',
      'SDKTaskStartedMessage',
      'SDKTaskProgressMessage',
      'SDKTaskUpdatedMessage',
      'SDKTaskNotificationMessage',
    ]) {
      expect(line).toContain(name);
    }
  });

  it('the level signal still says it is PER-PROCESS — the sentence the reset implements', () => {
    // If an SDK upgrade ever makes the level survive a restart, this fails and
    // `resetBackgroundTaskLevel` becomes wrong rather than quietly redundant.
    //
    // Anchored to the declaration's OWN doc comment, not to everything above
    // it: a whole-file slice would keep passing if the sentence were deleted
    // here and happened to survive in any of the four thousand lines before —
    // the vacuous match the other three guards are anchored against.
    const source = sdkTypings();
    const declaration = source.indexOf('export declare type SDKBackgroundTasksChangedMessage');
    expect(declaration).toBeGreaterThan(0);
    const doc = source.slice(source.lastIndexOf('/**', declaration), declaration);
    expect(doc).toContain('The level is per-process');
    expect(doc).toContain("whenever the session's CLI process (re)starts");
  });
});
