/**
 * T3 — the Claude side of the scheduling projection.
 *
 * Three separable claims, one per describe block:
 *
 * 1. The in-process tool context the Claude adapter builds resolves BOTH host
 *    ports the five projected tools need (`ctx.cronPort`, `ctx.monitor`) from
 *    the per-session callback registry. `monitor` was already bound; `cronPort`
 *    was NOT, which is the gap this row closed — without it the four cron tools
 *    would have been advertised on every Claude card and answered "unavailable".
 * 2. The child env suppresses the SDK's OWN scheduler, on every spawn path.
 * 3. The child's NATIVE `Monitor` is disallowed, so only ours exists.
 *
 * The first block drives the REAL registry handlers out of
 * `SESSION_TOOL_REGISTRY` against a fake port, which is byte-for-byte what the
 * adapter's `registryTool` wrapper does (`def.handler(ctx, args)`); the fake is
 * the host service, the only thing a unit test has no business starting.
 */
import { beforeEach, describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { SESSION_TOOL_REGISTRY, getSessionToolDefs } from '@nessy-agent/session-tools-core';
import type { SessionCronPort, SessionToolContext } from '@nessy-agent/session-tools-core';
import { createClaudeContext } from '../claude-context.ts';
import { getSessionScopedTools, invalidateAllSessionToolsCaches } from '../session-scoped-tools.ts';
import { attachSessionSelfManagementBindings } from '../session-self-management-bindings.ts';
import {
  mergeSessionScopedToolCallbacks,
  unregisterSessionScopedToolCallbacks,
} from '../session-scoped-tool-callback-registry.ts';
import { CLAUDE_SESSION_DISALLOWED_TOOLS, withClaudeHostTaskRegistry } from '../claude-agent.ts';
import type {
  HookTaskRegistryPort,
  SdkAutomationCallbackMatcher,
  SdkAutomationInput,
} from '../../automations/index.ts';
import { buildClaudeSubprocessEnv } from '../options.ts';
import type { SessionKey } from '../../sessions/session-key.ts';

const key: SessionKey = { workspaceId: 'ws-t3-scheduling', sessionId: 'session-t3-scheduling' };

function claudeContext(): SessionToolContext {
  const ctx = createClaudeContext({
    sessionId: key.sessionId,
    workspacePath: '/tmp/t3-scheduling-workspace',
    workspaceId: key.workspaceId,
    sessionPath: `/tmp/t3-scheduling-workspace/sessions/${key.sessionId}`,
    onPlanSubmitted: () => {},
    onAuthRequest: () => {},
  });
  attachSessionSelfManagementBindings(ctx, key);
  return ctx;
}

/** A stand-in for the host `SessionCronService`, recording what reached it. */
function fakeCronPort() {
  const created: unknown[] = [];
  const removed: string[] = [];
  const rearmed: number[] = [];
  let stopped = 0;
  const port: SessionCronPort = {
    create: async input => {
      created.push(input);
      return { id: 'abc12345', schedule: input.schedule ?? 'dynamic', recurring: input.recurring, prompt: input.prompt };
    },
    list: async () => [{ id: 'abc12345', schedule: '*/5 * * * *', recurring: true, prompt: 'sweep' }],
    remove: async id => { removed.push(id); return true; },
    rearmWakeup: async ({ delayMs }) => { rearmed.push(delayMs); return { firesAt: 1_000 + delayMs }; },
    stopWakeup: async () => { stopped += 1; return true; },
  };
  return { port, created, removed, rearmed, stoppedCount: () => stopped };
}

const callHandler = async (name: string, ctx: SessionToolContext, args: Record<string, unknown>) => {
  const def = SESSION_TOOL_REGISTRY.get(name);
  if (!def?.handler) throw new Error(`no registry handler for ${name}`);
  return def.handler(ctx, args as never);
};

/** `isError` is optional on a success, so read it the way an MCP client does. */
const failedWith = (result: { isError?: boolean; content: { text: string }[] }): string | null =>
  result.isError ? result.content.map(block => block.text).join('\n') : null;

describe('the Claude in-process context resolves the scheduling ports', () => {
  beforeEach(() => {
    unregisterSessionScopedToolCallbacks(key);
  });

  // The five are only worth wiring if the adapter actually offers them, and the
  // adapter's call is `getSessionToolDefs({ includeDeveloperFeedback })` with no
  // projection — so this is the same surface, asked the same way.
  it('offers all five on the surface the adapter builds from', () => {
    const names = getSessionToolDefs({ includeDeveloperFeedback: false }).map(def => def.name);
    for (const name of ['Monitor', 'CronCreate', 'CronList', 'CronDelete', 'ScheduleWakeup']) {
      expect(names).toContain(name);
    }
  });

  // The gap this row closed, pinned from the failing side: with nothing in the
  // registry the context has no ports, so the handlers report unavailability
  // rather than throwing or pretending. This is also the state a session on a
  // runtime outside SCHEDULED_DELIVERY_RUNTIMES is left in.
  it('has no cronPort and no monitor until the host registers them', async () => {
    const ctx = claudeContext();
    expect(ctx.cronPort).toBeUndefined();
    expect(ctx.monitor).toBeUndefined();
    const result = await callHandler('CronList', ctx, {});
    expect(failedWith(result)).toContain('CronList is unavailable for this backend.');
  });

  it('resolves cronPort from the registry and reaches the host service', async () => {
    const ctx = claudeContext();
    const fake = fakeCronPort();
    mergeSessionScopedToolCallbacks(key, { cronPort: fake.port });

    expect(ctx.cronPort).toBe(fake.port);

    const created = await callHandler('CronCreate', ctx, {
      schedule: '*/5 * * * *',
      recurring: true,
      prompt: 'sweep the queue',
    });
    expect(failedWith(created)).toBeNull();
    expect(fake.created).toHaveLength(1);

    const listed = await callHandler('CronList', ctx, {});
    expect(failedWith(listed)).toBeNull();

    const deleted = await callHandler('CronDelete', ctx, { id: 'abc12345' });
    expect(failedWith(deleted)).toBeNull();
    expect(fake.removed).toEqual(['abc12345']);

    // `delaySeconds` (60-3600) is the documented arg; the port takes
    // milliseconds, and the handler is what converts — so 60 → 60_000 below is
    // the conversion being measured, not a coincidence of units.
    const wakeup = await callHandler('ScheduleWakeup', ctx, { delaySeconds: 60, reason: 'check again' });
    expect(failedWith(wakeup)).toBeNull();
    expect(fake.rearmed).toEqual([60_000]);
  });

  it('resolves the monitor port the same way, for the same session key', async () => {
    const ctx = claudeContext();
    const starts: unknown[] = [];
    mergeSessionScopedToolCallbacks(key, {
      monitorPort: {
        start: async input => { starts.push(input); return { taskId: 'monitor-1', timeoutMs: 0, persistent: true }; },
        stop: async () => true,
      },
    });
    expect(ctx.monitor).toBeDefined();
    const started = await callHandler('Monitor', ctx, {
      command: 'tail -f /tmp/log',
      description: 'watch the log',
      persistent: true,
    });
    expect(failedWith(started)).toBeNull();
    expect(starts).toHaveLength(1);
  });

  // The getters are non-memoized by design (this file's own rule): a runtime
  // switch rebuilds the agent, re-merges the registry entry, and the context
  // must follow. A merge writing `undefined` is how a session that left a
  // scheduled runtime loses the port instead of keeping the previous one's.
  it('follows a later merge, including one that clears the port', () => {
    const ctx = claudeContext();
    const first = fakeCronPort();
    mergeSessionScopedToolCallbacks(key, { cronPort: first.port });
    expect(ctx.cronPort).toBe(first.port);

    const second = fakeCronPort();
    mergeSessionScopedToolCallbacks(key, { cronPort: second.port });
    expect(ctx.cronPort).toBe(second.port);

    mergeSessionScopedToolCallbacks(key, { cronPort: undefined });
    expect(ctx.cronPort).toBeUndefined();
  });
});

/**
 * P2.2 — the CLAUDE resolution of the goal port, the same three claims the
 * scheduling block above makes, for the pair that left `pi-only` one task later.
 *
 * The Pi resolution (the port assigned straight onto Pi's own context) is
 * measured in `session-tools-core/src/handlers/goal.test.ts`; the Codex one
 * (the port reached over the host-callback bridge) in
 * `session-mcp-server/src/host-callback-bridge.test.ts`.
 */
describe('the Claude in-process context resolves the goal port', () => {
  beforeEach(() => {
    unregisterSessionScopedToolCallbacks(key);
  });

  /** The host `GoalService`, stood in for — what a unit test has no business starting. */
  function fakeGoalPort() {
    const seen: Record<string, unknown>[] = [];
    let goal: Record<string, unknown> | undefined;
    return {
      seen,
      port: {
        execute: async (args: Record<string, unknown>) => {
          seen.push(args);
          if (args.action === 'create') goal = { id: 'goal-7', revision: 1, status: 'active', condition: args.condition };
          if (args.action === 'cancel') goal = { ...goal, status: 'cancelled', revision: 2 };
          return { schemaVersion: 1, ...(goal ? { goal } : {}) };
        },
      },
    };
  }

  // The pair is only worth wiring if the adapter offers it, and the adapter's
  // call is `getSessionToolDefs({ includeDeveloperFeedback })` with no
  // projection — the same surface, asked the same way.
  it('offers Goal and GoalGet on the surface the adapter builds from', () => {
    const names = getSessionToolDefs({ includeDeveloperFeedback: false }).map(def => def.name);
    expect(names).toContain('Goal');
    expect(names).toContain('GoalGet');
  });

  /**
   * The row the projection needed and did not have.
   *
   * `getSessionToolDefs` returning a name proves the FILTER; it does not prove
   * the SDK can be handed that def. `Goal` is the first session tool whose top
   * level is a union, and `getSessionScopedTools` throws
   * `claude-session-tool-schema-not-object:Goal` on anything without a Zod raw
   * shape — measured, as a build that failed for every Claude session, not as a
   * hypothetical. So the real factory is driven here and the registered tool
   * names are read off the MCP server it returns.
   */
  it('the real SDK tool factory registers both, union schema and all', () => {
    invalidateAllSessionToolsCaches();
    const server = getSessionScopedTools(key.sessionId, '/tmp/t3-scheduling-workspace', key.workspaceId, `/tmp/t3-scheduling-workspace/sessions/${key.sessionId}`) as unknown as {
      instance: { _registeredTools: Record<string, unknown> }
    };
    const registered = Object.keys(server.instance._registeredTools);
    expect(registered).toContain('Goal');
    expect(registered).toContain('GoalGet');
    // Positive control: the neighbours this file's other block projected are
    // registered by the same call, so "contains" measures the build rather than
    // an empty object read as a pass.
    for (const name of ['Monitor', 'CronCreate', 'CronList']) expect(registered).toContain(name);
  });

  // The failing side, pinned: with nothing in the registry the context has no
  // port, so the handlers report unavailability rather than throwing or
  // pretending. This is the state a session outside `SCHEDULED_DELIVERY_RUNTIMES`
  // is left in.
  it('has no goalPort until the host registers one', async () => {
    const ctx = claudeContext();
    expect(ctx.goalPort).toBeUndefined();
    const result = await callHandler('GoalGet', ctx, {});
    expect(failedWith(result)).toContain('Goal is unavailable for this backend.');
  });

  it('resolves goalPort from the registry and reaches the host service', async () => {
    const ctx = claudeContext();
    const fake = fakeGoalPort();
    mergeSessionScopedToolCallbacks(key, { goalPort: fake.port });

    expect(ctx.goalPort).toBe(fake.port);

    const created = await callHandler('Goal', ctx, { action: 'create', condition: 'Ship the retry' });
    expect(failedWith(created)).toBeNull();

    const read = await callHandler('GoalGet', ctx, {});
    expect(failedWith(read)).toBeNull();

    const cleared = await callHandler('Goal', ctx, {
      action: 'cancel', id: 'goal-7', revision: 1, reason: 'changed my mind',
    });
    expect(failedWith(cleared)).toBeNull();

    // `GoalGet` carries no arguments of its own — the handler mints `get`, which
    // is why the read is a THIRD shape at the port rather than a passthrough.
    expect(fake.seen).toEqual([
      { action: 'create', condition: 'Ship the retry' },
      { action: 'get' },
      { action: 'cancel', id: 'goal-7', revision: 1, reason: 'changed my mind' },
    ]);
  });

  // Same non-memoization rule as `cronPort`: a runtime switch re-merges the
  // entry (or clears it), and the context must follow rather than hand the next
  // runtime the previous one's `GoalService`.
  it('follows a later merge, including one that clears the port', () => {
    const ctx = claudeContext();
    const first = fakeGoalPort();
    mergeSessionScopedToolCallbacks(key, { goalPort: first.port });
    expect(ctx.goalPort).toBe(first.port);

    const second = fakeGoalPort();
    mergeSessionScopedToolCallbacks(key, { goalPort: second.port });
    expect(ctx.goalPort).toBe(second.port);

    mergeSessionScopedToolCallbacks(key, { goalPort: undefined });
    expect(ctx.goalPort).toBeUndefined();
  });
});

describe("the child env suppresses the SDK's own scheduler", () => {
  // `scheduled-tasks.md:208` — the flag makes the child's cron tools and /loop
  // unavailable and stops its already-scheduled tasks firing. Ours run in the
  // host, behind an in-process MCP server this variable does not reach.
  it('sets CLAUDE_CODE_DISABLE_CRON=1 on the plain (subscription) path', () => {
    expect(buildClaudeSubprocessEnv().CLAUDE_CODE_DISABLE_CRON).toBe('1');
  });

  // The gateway path differs only by its `envOverrides`, and those are spread
  // BEFORE this assignment — so the same call proves both spawn paths, which is
  // the reason the variable is written in the shared builder at all.
  it('sets it on the gateway path, whose overrides are spread first', () => {
    const env = buildClaudeSubprocessEnv({
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:4711',
      ANTHROPIC_API_KEY: 'not-needed',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    });
    expect(env.CLAUDE_CODE_DISABLE_CRON).toBe('1');
    // Positive control: the overrides themselves still land, so the assertion
    // above is not reading an env the builder ignored.
    expect(env.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:4711');
  });

  // Authoritative, not defaulted: the only value that keeps the child's
  // scheduler from running alongside ours is `1`, so an ambient or overridden
  // `0` must not win. Asserted in both directions it can arrive from.
  it('wins over an override and over an ambient value', () => {
    expect(buildClaudeSubprocessEnv({ CLAUDE_CODE_DISABLE_CRON: '0' }).CLAUDE_CODE_DISABLE_CRON).toBe('1');
    const previous = process.env.CLAUDE_CODE_DISABLE_CRON;
    process.env.CLAUDE_CODE_DISABLE_CRON = '0';
    try {
      expect(buildClaudeSubprocessEnv().CLAUDE_CODE_DISABLE_CRON).toBe('1');
    } finally {
      if (previous === undefined) delete process.env.CLAUDE_CODE_DISABLE_CRON;
      else process.env.CLAUDE_CODE_DISABLE_CRON = previous;
    }
  });
});

describe('only OUR Monitor exists on a Claude card', () => {
  it("disallows the child's native Monitor", () => {
    expect(CLAUDE_SESSION_DISALLOWED_TOOLS).toContain('Monitor');
  });

  // The entry names the BUILT-IN. Ours is served from the in-process `session`
  // MCP server and is therefore `mcp__session__Monitor`, which this list does
  // not name — the same reason `Skill` above has never suppressed a session
  // tool. A prefixed entry here would silently remove the tool this row exists
  // to project.
  it('does not name the session tool', () => {
    expect(CLAUDE_SESSION_DISALLOWED_TOOLS).not.toContain('mcp__session__Monitor');
    expect(CLAUDE_SESSION_DISALLOWED_TOOLS.filter(name => name.startsWith('mcp__'))).toEqual([]);
  });
});

/**
 * T9 — the host's cron records reach a claude session's Stop hooks.
 *
 * The row's premise, re-measured here rather than assumed: `ClaudeAgent` emits
 * no host-side automation event at all (`emitAutomationEvent` occurs zero times
 * in `claude-agent.ts`), so the ONLY Stop a claude session has is the child's,
 * delivered into the matchers we register. These rows drive the REAL wrapper
 * over a REAL matcher shape; the port is the one thing a unit test has no
 * business starting.
 */
describe('a claude Stop hook reads the host task registry', () => {
  const hostPort: HookTaskRegistryPort = {
    backgroundTasks: () => [
      { id: 'mon-1', type: 'monitor', status: 'running', description: 'tail build.log', server: 'session', tool: 'Monitor' },
    ],
    sessionCrons: () => [
      { id: 'abc12345', schedule: '*/5 * * * *', recurring: true, prompt: 'sweep' },
    ],
  };

  /** One matcher shaped exactly like `buildSdkHooksForConfig` produces. */
  const capturingMatcher = (seen: SdkAutomationInput[]): SdkAutomationCallbackMatcher => ({
    hooks: [async input => { seen.push(input); return { continue: true }; }],
  });

  const childStopInput = (): SdkAutomationInput => ({
    hook_event_name: 'Stop',
    stop_hook_active: false,
    // The child's OWN registry: its scheduler is suppressed, so its crons are
    // empty while one of its backgrounded shells is still running.
    background_tasks: [{ id: 'sh-9', type: 'shell', status: 'running', description: 'npm run watch', command: 'npm run watch' }],
    session_crons: [],
  });

  it("hands the host's session_crons to a Stop matcher the child drives", async () => {
    const seen: SdkAutomationInput[] = [];
    const wrapped = withClaudeHostTaskRegistry({ Stop: [capturingMatcher(seen)] }, hostPort);
    await wrapped.Stop![0]!.hooks[0]!(childStopInput(), 'tool-use-id', {});
    expect(seen).toHaveLength(1);
    expect(seen[0]!.session_crons).toEqual([
      { id: 'abc12345', schedule: '*/5 * * * *', recurring: true, prompt: 'sweep' },
    ]);
  });

  // UNION of what each side OWNS: the child's own in-flight work plus the host
  // work the child cannot see (a monitor here). A hook that lost either half
  // would read "nothing is in flight" while something is (`hooks.md :2194`).
  it("keeps the child's own background_tasks alongside the host's", async () => {
    const seen: SdkAutomationInput[] = [];
    const wrapped = withClaudeHostTaskRegistry({ Stop: [capturingMatcher(seen)] }, hostPort);
    await wrapped.Stop![0]!.hooks[0]!(childStopInput(), 'tool-use-id', {});
    expect(seen[0]!.background_tasks?.map(task => task.id)).toEqual(['sh-9', 'mon-1']);
  });

  // The correction to that union's premise. The host's shell entries are NOT a
  // disjoint set on this runtime: `extractToolResults` mints
  // `shell_backgrounded` from the SDK child's own Bash result and
  // `SessionManager` stores it, so the host copy is a derivative of the entry
  // the child is already reporting. Unioning both halves reports one shell
  // twice.
  it("does not report the child's backgrounded shell twice", async () => {
    const hostWithTheChildsShell: HookTaskRegistryPort = {
      // Exactly what `projectBackgroundTasks` builds from
      // `backgroundShellCommands`: same handle, always `status: 'running'`.
      backgroundTasks: () => [
        { id: 'sh-9', type: 'shell', status: 'running', description: 'npm run watch', command: 'npm run watch' },
        { id: 'mon-1', type: 'monitor', status: 'running', description: 'tail build.log', server: 'session', tool: 'Monitor' },
      ],
      sessionCrons: () => [],
    };
    const seen: SdkAutomationInput[] = [];
    const wrapped = withClaudeHostTaskRegistry({ Stop: [capturingMatcher(seen)] }, hostWithTheChildsShell);
    await wrapped.Stop![0]!.hooks[0]!(childStopInput(), 'tool-use-id', {});
    expect(seen[0]!.background_tasks?.map(task => task.id)).toEqual(['sh-9', 'mon-1']);
  });

  // And the half that outlives the shell. `reconcileEndedBackgroundShells`
  // retires an entry only on a `piProcessStore` record proving an exit, which
  // an SDK-owned shell never gets — so the host copy stays `running` forever.
  // The child, which DOES know the shell exited, stops listing it; the hook
  // must not be handed the host's stale `running` copy instead.
  it("drops the host's forever-running shell once the child stops listing it", async () => {
    const hostHoldingAnExitedShell: HookTaskRegistryPort = {
      backgroundTasks: () => [
        { id: 'sh-9', type: 'shell', status: 'running', description: 'npm run watch', command: 'npm run watch' },
      ],
      sessionCrons: () => [],
    };
    const seen: SdkAutomationInput[] = [];
    const wrapped = withClaudeHostTaskRegistry({ Stop: [capturingMatcher(seen)] }, hostHoldingAnExitedShell);
    // The child's payload after the shell exited: it no longer lists it.
    await wrapped.Stop![0]!.hooks[0]!(
      { hook_event_name: 'Stop', stop_hook_active: false, background_tasks: [], session_crons: [] } as SdkAutomationInput,
      'tool-use-id',
      {},
    );
    expect(seen[0]!.background_tasks).toEqual([]);
  });

  // `:2046` — SubagentStop carries both arrays too, scoped to the PARENT
  // session, which is precisely what this port reads.
  it('covers SubagentStop on the same rule', async () => {
    const seen: SdkAutomationInput[] = [];
    const wrapped = withClaudeHostTaskRegistry({ SubagentStop: [capturingMatcher(seen)] }, hostPort);
    await wrapped.SubagentStop![0]!.hooks[0]!(
      { hook_event_name: 'SubagentStop' } as SdkAutomationInput,
      'tool-use-id',
      {},
    );
    expect(seen[0]!.session_crons).toHaveLength(1);
  });

  // The documented "registry is not reachable" state (`:2194`) — the one case
  // where the keys are absent rather than present-and-empty. Ours to leave
  // alone, not to invent.
  it('leaves the payload untouched when no port is bound', async () => {
    const seen: SdkAutomationInput[] = [];
    const matchers = { Stop: [capturingMatcher(seen)] };
    const wrapped = withClaudeHostTaskRegistry(matchers, undefined);
    expect(wrapped).toBe(matchers);
    await wrapped.Stop![0]!.hooks[0]!({ hook_event_name: 'Stop' } as SdkAutomationInput, 'tool-use-id', {});
    expect(seen[0]).not.toHaveProperty('session_crons');
    expect(seen[0]).not.toHaveProperty('background_tasks');
  });

  // Negative control: only the two events the docs name are enriched. Without
  // this the wrapper would be writing registry keys onto every hook input.
  it('does not touch events outside the two the docs name', async () => {
    const seen: SdkAutomationInput[] = [];
    const wrapped = withClaudeHostTaskRegistry({ PreToolUse: [capturingMatcher(seen)] }, hostPort);
    await wrapped.PreToolUse![0]!.hooks[0]!(
      { hook_event_name: 'PreToolUse', tool_name: 'Bash' } as SdkAutomationInput,
      'tool-use-id',
      {},
    );
    expect(seen[0]).not.toHaveProperty('session_crons');
  });

  // Live, not captured at build: a cron created DURING the turn must appear in
  // the Stop that ends that turn. A later dispatch is a different payload
  // (`last_assistant_message` alone makes it one), so it re-reads.
  it('re-reads the port on the next dispatch', async () => {
    const crons: { id: string; schedule: string; recurring: boolean; prompt: string }[] = [];
    const growing: HookTaskRegistryPort = { backgroundTasks: () => [], sessionCrons: () => crons };
    const seen: SdkAutomationInput[] = [];
    const wrapped = withClaudeHostTaskRegistry({ Stop: [capturingMatcher(seen)] }, growing);
    const stop = (message: string) => ({ hook_event_name: 'Stop', last_assistant_message: message }) as SdkAutomationInput;
    await wrapped.Stop![0]!.hooks[0]!(stop('first'), 'tool-use-id', {});
    crons.push({ id: 'later123', schedule: 'dynamic', recurring: false, prompt: 'wake' });
    await wrapped.Stop![0]!.hooks[0]!(stop('second'), 'tool-use-id', {});
    expect(seen[0]!.session_crons).toEqual([]);
    expect(seen[1]!.session_crons?.map(cron => cron.id)).toEqual(['later123']);
  });

  // ONE read per dispatch, however many matchers the event carries. Two
  // matchers on one `Stop` used to take two independent reads, which cost a
  // cron-store file read each AND let them disagree when the registry moved
  // between them. The counter is the detector: a shared snapshot reads once.
  it('reads the registry once per dispatch, not once per matcher', async () => {
    let reads = 0;
    const crons = [{ id: 'abc12345', schedule: '*/5 * * * *', recurring: true, prompt: 'sweep' }];
    const counting: HookTaskRegistryPort = {
      backgroundTasks: () => [],
      sessionCrons: () => {
        reads += 1;
        // Moves between reads, so two reads could not agree.
        return [...crons, { id: `read${reads}`, schedule: 'dynamic', recurring: false, prompt: 'wake' }];
      },
    };
    const first: SdkAutomationInput[] = [];
    const second: SdkAutomationInput[] = [];
    const wrapped = withClaudeHostTaskRegistry(
      { Stop: [capturingMatcher(first), capturingMatcher(second)] },
      counting,
    );
    // The SDK delivers each callback its own control request, so the same
    // payload arrives as two separately-deserialized objects.
    await wrapped.Stop![0]!.hooks[0]!(childStopInput(), 'tool-use-id', {});
    await wrapped.Stop![1]!.hooks[0]!(childStopInput(), 'tool-use-id', {});
    expect(reads).toBe(1);
    expect(second[0]!.session_crons).toEqual(first[0]!.session_crons!);
  });

  // Source probe with a positive control: the wrapper is applied at the ONE
  // seam that builds the SDK's `hooks` option, and it is fed the config port
  // the host binds. A unit test cannot reach that object literal without
  // constructing an agent and a live query.
  it('is applied to the merged hook map with the config port', () => {
    const source = readFileSync(fileURLToPath(new URL('../claude-agent.ts', import.meta.url)), 'utf8');
    // Whitespace-tolerant on purpose: the CALL is the claim, and a reformat is
    // not a regression. Both arguments are named, in order.
    expect(source).toMatch(
      /withClaudeHostTaskRegistry\(\s*mergeClaudeSdkHooks\(internalHooks,\s*userHooks\),\s*this\.config\.hookTaskRegistryPort,?\s*\)/,
    );
    // Positive control: the file still has no host-side Stop emission, which is
    // the measurement that made enrichment the right shape. A second emission
    // appearing here would mean every Stop matcher runs twice per turn. Matched
    // by SHAPE rather than one spelling — the previous literal would have been
    // silently satisfied by a double-quoted, backticked or line-wrapped call.
    expect(source).not.toMatch(/emitAutomationEvent\(\s*['"`]Stop['"`]/);
  });
});
