/**
 * D1.155 — a host `hooks.json` `SessionStart`/`SessionEnd` hook on the CLAUDE
 * backend.
 *
 * ## The premise, and the two readings it rests on
 *
 * This backend called `emitAutomationEvent` ZERO times by design: its hooks run
 * inside the SDK child through `buildSdkHooks()`, and `base-agent.ts` says so
 * ("Non-Claude backends call this directly. ClaudeAgent uses SDK's
 * buildSdkHooks() instead"). That is an architecture, not a defect — for every
 * event the child DOES call back on. W19-r's headless rig drove one host
 * `hooks.json` hook per event on all three runtimes and found two that it does
 * not: a `SessionStart` hook ran on pi and codex and was silent on claude, and
 * `SessionEnd` was ABSENT on BOTH termination signals (SIGTERM exit 143, SIGINT
 * exit 130, the process tree gone either way), where pi ran it on SIGTERM.
 *
 * The mechanism is not the missing half: `sdk.mjs`'s `initialize` maps EVERY
 * entry of `this.hooks` into `initHooksPayload` with no per-event filter, so the
 * matchers really are serialised to the child. What is missing is the child's
 * call back for these two names. So the host emits them, exactly as pi and codex
 * do, and the trusted copy is dropped so the migration cannot become a
 * duplication — which is the case T9 refused for `Stop`, on the opposite
 * evidence.
 *
 * ## Why the second `describe` sets a private latch
 *
 * `SessionEnd` is guarded by `_sessionStartEmitted`, and reaching that flag
 * honestly means driving a real turn, which on this backend means spawning an
 * SDK child. The guard itself is the thing worth pinning — a session that never
 * started must not announce that it ended — so the negative arm drives it for
 * real and the positive arm sets the flag the way a turn would. Stated rather
 * than hidden: this is a cast into a private field and it is the only one.
 */
import { describe, expect, it } from 'bun:test';
import { HOOK_EVENTS } from '@anthropic-ai/claude-agent-sdk';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { AgentEvent, SdkAutomationInput } from '../../automations/types.ts';
import type { BackendConfig } from '../backend/types.ts';
import { MCP_DEFAULT_TOOL_TIMEOUT_MS } from '../../mcp/server-config-values.ts';
import { McpClientPool } from '../../mcp/mcp-pool.ts';
import type { PoolClient } from '../../mcp/client.ts';
import { FIXTURE_STDIO_CONFIG, registerFixtureClient } from '../../mcp/__tests__/pool-fixture.ts';
import {
  ClaudeAgent,
  claudeSdkMcpServerTimeoutForServer,
  claudeSdkMcpServerTimeoutMs,
  createSourceProxyServers,
  mergeClaudeSdkHooks,
} from '../claude-agent.ts';

const WORKSPACE_ROOT = '/tmp/nessy-d1155';

let counter = 0;

function agentConfig(): BackendConfig {
  counter += 1;
  return {
    provider: 'anthropic',
    providerType: 'anthropic',
    model: 'claude-sonnet-4-6',
    isHeadless: true,
    skipConfigWatcher: true,
    workspace: {
      id: 'ws-d1155',
      name: 'D1.155',
      rootPath: WORKSPACE_ROOT,
      workspaceRootPath: WORKSPACE_ROOT,
      sessionRootPath: `${WORKSPACE_ROOT}/sessions`,
    } as never,
    session: {
      id: `session-d1155-${counter}`,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      workingDirectory: WORKSPACE_ROOT,
    } as never,
  } as BackendConfig;
}

/** One matcher shaped as `buildSdkHooksForConfig` produces them. */
function matcher(): { hooks: Array<() => Promise<{ continue: boolean }>> } {
  return { hooks: [async () => ({ continue: true })] };
}

describe('D1.155 · the two events the host now emits are not also handed to the child', () => {
  it('drops SessionStart and SessionEnd from the TRUSTED side, with PostToolUse as the control', () => {
    const merged = mergeClaudeSdkHooks({}, {
      SessionStart: [matcher()],
      SessionEnd: [matcher()],
      PreToolUse: [matcher()],
      PostToolUse: [matcher()],
    });

    // The three the host emits itself: dropped, so the child cannot run them a
    // second time if a later SDK starts delivering them.
    expect(merged.SessionStart).toBeUndefined();
    expect(merged.SessionEnd).toBeUndefined();
    expect(merged.PreToolUse).toBeUndefined();
    // POSITIVE CONTROL on the same call — without it a `mergeClaudeSdkHooks`
    // that dropped everything would read as a pass.
    expect(merged.PostToolUse).toHaveLength(1);
  });

  it('BOUNDARY — the INTERNAL side keeps all three, because that is the host\'s own wiring', () => {
    const merged = mergeClaudeSdkHooks({
      SessionStart: [matcher()],
      SessionEnd: [matcher()],
      PreToolUse: [matcher()],
    }, {});

    expect(merged.SessionStart).toHaveLength(1);
    expect(merged.SessionEnd).toHaveLength(1);
    expect(merged.PreToolUse).toHaveLength(1);
  });
});

describe('D1.165 · the vendor\'s own model-switch pair is declined, and the decline is structural', () => {
  /**
   * The row asked whether `PreModelSwitch`/`PostModelSwitch` should join
   * `AgentEvent`. They ALREADY HAD, and the row's own control is refuted at
   * HEAD: it reads "0 occurrences of `ModelSwitch` across `packages` and
   * `apps`", and the tree answers `PreModelSwitch` 69, `PostModelSwitch` 41,
   * `runModelSwitchHook` 8. `SessionManager.updateSessionModel` has awaited
   * `runModelSwitchHook` before the switch is applied, fail-closed on a block
   * and with no provider gate, since `25f2781e8`.
   *
   * So the live half is the OTHER one — the double-fire — and the answer is not
   * the obvious one. A switch this fork drives is applied by respawning with a
   * new `Options.model`, so the child never switches into it and cannot
   * duplicate the host's emission. What handing the matcher to the child DOES
   * do is give it a second set of occurrences that no host switch minted, on
   * claude alone, over a transition whose vendor hook carries a documented
   * veto — while codex's own `HookEventName` has no model-switch event at all.
   * That is a switch verdict, and it is declined here rather than argued in a
   * comment somewhere.
   */
  it('drops both model-switch names from the TRUSTED side, with a live control', () => {
    const merged = mergeClaudeSdkHooks({}, {
      PreModelSwitch: [matcher()],
      PostModelSwitch: [matcher()],
      ConfigChange: [matcher()],
    });

    expect(merged.PreModelSwitch).toBeUndefined();
    expect(merged.PostModelSwitch).toBeUndefined();
    // POSITIVE CONTROL: a between-turns sibling event that IS still delivered
    // by the child, so "drops everything" cannot pass as this assertion.
    expect(merged.ConfigChange).toHaveLength(1);
  });
});

/**
 * F1.280 (P-WJaa-3) — the two describes above pin the drop on hand-picked
 * names; this one reads it against the WHOLE event list of the bundle we ship,
 * so it is re-read on every SDK lift (F1.255 lifted to 0.3.267 / 2.1.267).
 *
 * Why it matters: `recordAutomationHookRuns` is idempotent per result OBJECT,
 * not per run, so if a later SDK started delivering `SessionStart` or
 * `PreToolUse` to callbacks while the trusted copy still rode the SDK map,
 * `/hooks` would count one run twice. The guard against that is structural —
 * `mergeClaudeSdkHooks` keeps the host-emitted events out of the map — and the
 * assertion here is that the map built from a matcher on EVERY name in the
 * vendored `HOOK_EVENTS` carries none of them, and loses nothing else.
 *
 * The HOST-EMITTED list is written out, not imported: the constant is private
 * to `claude-agent.ts`, and a list read back from the function under test
 * would agree with whatever that function does. The control for the
 * SessionStart half on the production wrapper is F1.221's read-out arm
 * (`server-core/src/sessions/__tests__/automation-wrapper-forwarding.test.ts`,
 * "SessionStart is not on this road").
 */
describe('F1.280 · over the lifted HOOK_EVENTS, the SDK hook map carries no host-emitted event', () => {
  const HOST_EMITTED = ['PostModelSwitch', 'PreModelSwitch', 'PreToolUse', 'SessionEnd', 'SessionStart'];
  const sdkEvents: readonly string[] = HOOK_EVENTS;

  it('a trusted matcher on every SDK hook event survives, except exactly the host-emitted five', () => {
    const everyEvent = Object.fromEntries(sdkEvents.map((event) => [event, [matcher()]]));
    const merged = mergeClaudeSdkHooks({}, everyEvent);

    expect(sdkEvents.filter((event) => merged[event] === undefined).sort()).toEqual(HOST_EMITTED);
    // Nothing else was dropped or doubled: every surviving event carries its one matcher.
    expect(Object.keys(merged).sort()).toEqual(sdkEvents.filter((event) => !HOST_EMITTED.includes(event)).sort());
    expect(Object.values(merged).every((matchers) => matchers.length === 1)).toBe(true);
  });

  it('every host-emitted event IS in the lifted HOOK_EVENTS, so the exclusion guards a live name', () => {
    // If a lift removed one, the drop would be vacuous for it — re-read the
    // vendor's delivery of that event before trusting the list.
    expect(sdkEvents.length).toBeGreaterThan(HOST_EMITTED.length);
    expect(HOST_EMITTED.filter((event) => !sdkEvents.includes(event))).toEqual([]);
  });

  it('CONTROL — the internal side keeps every event, host-emitted ones included', () => {
    const everyEvent = Object.fromEntries(sdkEvents.map((event) => [event, [matcher()]]));
    const merged = mergeClaudeSdkHooks(everyEvent, {});

    expect(Object.keys(merged).sort()).toEqual([...sdkEvents].sort());
  });
});

describe('D1.155 · SessionEnd is emitted once, with the documented reason', () => {
  function recordingAgent(): {
    agent: ClaudeAgent
    events: Array<{ event: AgentEvent; input: SdkAutomationInput }>
  } {
    const agent = new ClaudeAgent(agentConfig());
    const events: Array<{ event: AgentEvent; input: SdkAutomationInput }> = [];
    agent.setAutomationSystem({
      async executeAgentEvent(event, input) {
        events.push({ event, input });
        return { matchedCount: 1 };
      },
    });
    return { agent, events };
  }

  it('NEGATIVE — a session that never started does not announce that it ended', async () => {
    const { agent, events } = recordingAgent();

    await agent.endLifecycle('other');

    expect(events).toHaveLength(0);
  });

  it('emits exactly one SessionEnd with the reason, and a second teardown is a no-op', async () => {
    const { agent, events } = recordingAgent();
    // The one cast into a private, and the header says why.
    (agent as unknown as { _sessionStartEmitted: boolean })._sessionStartEmitted = true;

    await agent.endLifecycle('clear');
    await agent.endLifecycle('clear');

    expect(events.map(entry => entry.event)).toEqual(['SessionEnd']);
    expect(events[0]?.input).toMatchObject({ hook_event_name: 'SessionEnd', reason: 'clear' });
  });

  it('defaults the reason to the documented `other` when the caller passes none', async () => {
    const { agent, events } = recordingAgent();
    (agent as unknown as { _sessionStartEmitted: boolean })._sessionStartEmitted = true;

    await agent.endLifecycle();

    expect(events.map(entry => entry.event)).toEqual(['SessionEnd']);
    expect(events[0]?.input).toMatchObject({ reason: 'other' });
  });
});

/**
 * D1.202 — the four resume/fork fields, pinned as DELIBERATELY UNREAD.
 *
 * The decision and its three reasons are in `automations/types.ts`, above the
 * `SessionStart` row of `EVENT_INVENTORY`. This is its CONTROL, and it is a
 * tripwire rather than an assertion about our own code: it reads the vendored
 * `sdk.d.ts` and fails the day the surface the decision was taken against stops
 * being what it was — a rename, a removal, or the resume/fork restriction being
 * lifted. A decision recorded against a surface nobody re-reads is the shape
 * this repo keeps finding stale.
 */
describe('D1.202 · the resume/fork fields are unread, and the surface is watched', () => {
  function sdkTypings(): string {
    const require_ = createRequire(import.meta.url);
    const entry = require_.resolve('@anthropic-ai/claude-agent-sdk');
    const path = entry.replace(/sdk\.mjs$/, 'sdk.d.ts');
    if (!existsSync(path)) throw new Error(`sdk.d.ts not found beside ${entry}`);
    return readFileSync(path, 'utf8');
  }

  it('all four are still declared on SessionStartHookInput, still resume/fork only', () => {
    const dts = sdkTypings();
    const at = dts.indexOf('export declare type SessionStartHookInput');
    expect(at).toBeGreaterThan(-1);
    // A WINDOW, not the file: a `toContain` over 8000 lines cannot tell this
    // type's `context_tokens` from `PreModelSwitchHookInput`'s, which is a
    // different field of the same name and the reason this is anchored.
    const window = dts.slice(at, dts.indexOf('};', at));

    for (const field of [
      'seconds_since_last_response',
      'context_tokens',
      'prompt_cache_likely_expired',
      'estimated_cache_write_usd',
    ]) {
      expect(window, field).toContain(`${field}?:`);
      // The restriction the whole decision rests on. If a later SDK drops
      // "resume/fork" from a gloss, the field applies to every session start
      // and the decision has to be re-taken.
      expect(window, field).toContain('resume/fork');
    }
    // POSITIVE CONTROL that the window is the right type at all.
    expect(window).toContain("hook_event_name: 'SessionStart'");
    // NEGATIVE CONTROL: a name no SDK has, so a window that matched everything
    // would fail here.
    expect(window).not.toContain('zzz_not_a_real_hook_field');
  });
});

/**
 * D1.201 — the host's MCP tool wall clock reaching the SDK's own per-server key.
 *
 * The arithmetic and the reasons are in `claudeSdkMcpServerTimeoutMs`'s
 * docblock; these are its arms. The one that matters most is the NEGATIVE:
 * before this row claude projected nothing, and the failure this could
 * introduce is not "no timeout" but "a timeout where the operator asked for
 * none", which is why an unset lever and the enormous documented default must
 * both answer `undefined`.
 *
 * `MCP_DEFAULT_TOOL_TIMEOUT_MS` is read from the module rather than written as
 * a literal — a number in a test beside a number in a constant is the drift
 * this repo keeps paying for.
 */
describe('D1.201 · the SDK per-server MCP timeout is the host ceiling plus a margin', () => {
  it('projects the operator ceiling, strictly looser than the host\'s own', () => {
    expect(claudeSdkMcpServerTimeoutMs({ NESSY_MCP_TOOL_TIMEOUT: '45000' })).toBe(46_000);
    // The documented compat spelling answers identically — the same reader
    // codex uses, so the two runtimes cannot disagree about which name counts.
    expect(claudeSdkMcpServerTimeoutMs({ MCP_TOOL_TIMEOUT: '30000' })).toBe(31_000);
  });

  it('NEGATIVE — an unset, blank or at-the-default lever projects NOTHING', () => {
    expect(claudeSdkMcpServerTimeoutMs({})).toBeUndefined();
    // Present but blank counts as unset in the pool's own reader, and must here.
    expect(claudeSdkMcpServerTimeoutMs({ NESSY_MCP_TOOL_TIMEOUT: '' })).toBeUndefined();
    expect(claudeSdkMcpServerTimeoutMs({ NESSY_MCP_TOOL_TIMEOUT: '   ' })).toBeUndefined();
    // The ~28-hour default an operator can also type by hand: dropped, because
    // they asked for the ceiling that changes nothing.
    expect(
      claudeSdkMcpServerTimeoutMs({ NESSY_MCP_TOOL_TIMEOUT: String(MCP_DEFAULT_TOOL_TIMEOUT_MS) }),
    ).toBeUndefined();
    // And a value that cannot be parsed resolves to that same default in the
    // reader, so it takes the same exit rather than writing a 28-hour deadline.
    expect(claudeSdkMcpServerTimeoutMs({ NESSY_MCP_TOOL_TIMEOUT: 'soon' })).toBeUndefined();
  });

  it('BOUNDARY — the projected value clears the SDK\'s own 1000 ms floor', () => {
    // `sdk.d.ts`: "Values below 1000ms are ignored (falls through to
    // MCP_TOOL_TIMEOUT or the default)." The margin alone guarantees it, but a
    // tiny operator ceiling is the case where that is not obvious.
    const projected = claudeSdkMcpServerTimeoutMs({ NESSY_MCP_TOOL_TIMEOUT: '1' });
    expect(projected).toBeGreaterThanOrEqual(1000);
  });

  /**
   * F1.1103 — the class DN-068 measured (f7cfaf64e): a setTimeout delay above
   * 2 147 483 647 ms overflows into a ~1 ms timer on this runtime, so a value
   * in THAT class must never reach the binary through this projection. It
   * cannot: every value at or above `MCP_DEFAULT_TOOL_TIMEOUT_MS` — which sits
   * 21.5× BELOW the timer maximum — is dropped outright, so the projection's
   * supremum is the arm below, not an overflow-case special case. The pool's
   * own clamp (DN-068's `clampToTimerMaxMs`) never has to catch these, because
   * the projection refuses them one gate earlier.
   */
  it('F1.1103 — the setTimeout-overflow class never projects: the whole class is above the drop gate', () => {
    // DN-068's own measured overflow values, verbatim.
    expect(claudeSdkMcpServerTimeoutMs({ NESSY_MCP_TOOL_TIMEOUT: '2147483648' })).toBeUndefined();
    expect(claudeSdkMcpServerTimeoutMs({ NESSY_MCP_TOOL_TIMEOUT: '3000000000' })).toBeUndefined();
    // The timer maximum EXACTLY is still above the drop gate, so it is dropped
    // too — the class boundary and the gate boundary are different lines, and
    // this is the value the two are closest to.
    expect(claudeSdkMcpServerTimeoutMs({ NESSY_MCP_TOOL_TIMEOUT: '2147483647' })).toBeUndefined();
  });

  it('F1.1103 — the projection\'s supremum sits 21x below the setTimeout maximum, measured against it', () => {
    // The largest value this function can ever return: the lever just below
    // the drop gate, plus the 1000 ms margin. Asserted against the timer
    // maximum by VALUE, so a future edit that raises either number reddens
    // here instead of letting an overflowing timeout reach the binary.
    const projected = claudeSdkMcpServerTimeoutMs({ NESSY_MCP_TOOL_TIMEOUT: String(MCP_DEFAULT_TOOL_TIMEOUT_MS - 1) });
    expect(projected).toBe(MCP_DEFAULT_TOOL_TIMEOUT_MS - 1 + 1000);
    // Node's setTimeout keeps its delay in a 32-bit signed integer; above this
    // the timer fires after ~1 ms (DN-068, measured on Bun 1.3.14 2026-09-26).
    const SET_TIMEOUT_MAX_MS = 2_147_483_647;
    expect(projected).toBeLessThan(SET_TIMEOUT_MAX_MS);
  });
});

/**
 * D1.216 — the two OUTPUT fields of the `SessionStart` result D1.155 started
 * producing, which on this backend alone reached nobody.
 *
 * `claude-agent.ts` read `universal` and `systemMessage` ZERO times: pi feeds
 * `additionalContext` into `_sessionHookContext` and codex has
 * `surfaceHookUserFacingOutput`, and neither seam existed here. The child cannot
 * cover for it — the whole point of D1.155 is that it never calls these matchers
 * back, and `mergeClaudeSdkHooks` now drops the event from `trustedHooks` — so a
 * hook was being RUN with its output discarded.
 *
 * Both methods are private and driven through one cast, for the reason the
 * header gives about `_sessionStartEmitted`: reaching them honestly means
 * spawning an SDK child and driving a whole turn, and what is worth pinning is
 * the seam, not the turn. The prompt builders' side is covered by the DRAIN
 * arms — once and only once is exactly what a caller in either builder gets.
 */
describe('D1.216 · a SessionStart hook\'s systemMessage and additionalContext reach the user and the model', () => {
  interface Internals {
    surfaceSessionStartHookMessage: (result: unknown) => void
    consumeSessionHookContext: () => string | undefined
    _sessionHookContext: string | undefined
    pendingDegradationNotices: string[]
  }

  function internals(): Internals {
    return new ClaudeAgent(agentConfig()) as unknown as Internals;
  }

  it('POSITIVE — a systemMessage becomes one queued warning, in codex\'s own words', () => {
    const agent = internals();

    agent.surfaceSessionStartHookMessage({ matchedCount: 1, universal: { systemMessage: '  heads up  ' } });

    // No slot is open before the first turn, which is exactly when this fires,
    // so it queues. The prefix is `surfaceHookUserFacingOutput`'s character for
    // character, so a user switching runtimes meets one sentence.
    expect(agent.pendingDegradationNotices).toEqual(['SessionStart hook: heads up']);
  });

  it('NEGATIVE — a result with no message, a blank one, or no result at all queues nothing', () => {
    const agent = internals();

    agent.surfaceSessionStartHookMessage(undefined);
    agent.surfaceSessionStartHookMessage({ matchedCount: 0 });
    agent.surfaceSessionStartHookMessage({ matchedCount: 1, universal: {} });
    agent.surfaceSessionStartHookMessage({ matchedCount: 1, universal: { systemMessage: '   ' } });

    // Without this arm, "the message is surfaced" is equally satisfied by an
    // agent that announces a SessionStart hook on every session that has none.
    expect(agent.pendingDegradationNotices).toEqual([]);
  });

  it('POSITIVE — additionalContext is drained ONCE, fenced by the shared band', () => {
    const agent = internals();
    agent._sessionHookContext = 'Current branch: feat/auth-refactor';

    const band = agent.consumeSessionHookContext();

    expect(band).toBeDefined();
    expect(band).toContain('Current branch: feat/auth-refactor');
    // Fenced, not pasted: the element and the fence come from the SHARED
    // `fenceHookBand`, whose exact bytes are `hook-band-fence.test.ts`'s to pin.
    // What this asserts is that this backend is not the one band that arrives
    // unannotated.
    expect(band).toContain('hook_context');
    expect(band).toContain('<untrusted');
    expect(band).not.toBe('Current branch: feat/auth-refactor');

    // THE CONTROL, and the one that matters: `buildTextPrompt` and
    // `buildSDKUserMessage` both drain, and the documented semantics is ONE
    // insertion ("at the point where the hook fired", "before the first
    // prompt"). A read instead of a drain would put the band on every turn of
    // the session.
    expect(agent.consumeSessionHookContext()).toBeUndefined();
  });

  it('NEGATIVE — a SessionStart with no additionalContext composes no band at all', () => {
    const agent = internals();

    expect(agent.consumeSessionHookContext()).toBeUndefined();
  });
});

/**
 * D1.219 — the FINER of the host's two MCP tool wall clocks, per server.
 *
 * D1.201 projected the SESSION ceiling and named what it was leaving behind in
 * as many words: a per-SERVER `toolTimeoutMs` exists (`.mcp.json`'s `timeout`,
 * source definitions, plugin-imported servers) and `createSourceProxyServers`
 * *"holds the pool, not its private per-slug configs"*. One pool accessor closes
 * that, and these are its arms.
 *
 * THE FIXTURE DRIVES THE REAL `connect` (`registerFixtureClient`), which is not
 * a style choice here — it is the only path that writes `activeConfigs`, and
 * `activeConfigs` is what the accessor and the pool's own call path both read.
 * A fixture on the retired `registerClient` shape would leave that map EMPTY and
 * every arm below would pass for the wrong reason (DA3.16's own note says so).
 */
describe('D1.219 · a per-server MCP timeout reaches the SDK proxy', () => {
  function fakeToolClient(): PoolClient {
    return {
      async listTools() {
        return [{ name: 'search', description: 'd', inputSchema: { type: 'object', properties: {} } }] as never;
      },
      async callTool() { return { content: [{ type: 'text', text: 'ok' }] }; },
      async close() {},
    } as unknown as PoolClient;
  }

  it('the accessor answers the value the CALL PATH will enforce, by connection identity', async () => {
    const pool = new McpClientPool();
    await registerFixtureClient(pool, 'docs', fakeToolClient(), {
      ...FIXTURE_STDIO_CONFIG, toolTimeoutMs: 600_000,
    } as never);
    await registerFixtureClient(pool, 'linear', fakeToolClient());

    expect(pool.toolTimeoutMsForSlug('docs')).toBe(600_000);
    // POSITIVE CONTROL in the same pool: a server that set nothing answers
    // `undefined`, so "reads the map" cannot pass as "reads the right entry".
    expect(pool.toolTimeoutMsForSlug('linear')).toBeUndefined();
    // NEGATIVE: a slug nobody connected resolves to no identity at all.
    expect(pool.toolTimeoutMsForSlug('never-connected')).toBeUndefined();
  });

  it('the per-server value wins over the session projection, with the same margin', () => {
    // The pool bounds a call at `activeConfigs…toolTimeoutMs ?? default`, so a
    // server with its own value is never bounded by the session ceiling — and
    // projecting the ceiling for it would put the SDK's hard wall clock INSIDE
    // the host's bound whenever the ceiling is the tighter number.
    expect(claudeSdkMcpServerTimeoutForServer(600_000, 46_000)).toBe(601_000);
    // No per-server value: the session projection, byte-for-byte D1.201.
    expect(claudeSdkMcpServerTimeoutForServer(undefined, 46_000)).toBe(46_000);
    expect(claudeSdkMcpServerTimeoutForServer(undefined, undefined)).toBeUndefined();
  });

  it('BOUNDARY — a per-server value at or above the ~28-hour default projects NOTHING', () => {
    // Same rule as D1.201's session half and for a sharper reason: any
    // projection here would be TIGHTER than the host's own bound for this
    // server, which is the race the one-second margin exists to prevent.
    expect(claudeSdkMcpServerTimeoutForServer(MCP_DEFAULT_TOOL_TIMEOUT_MS, 46_000)).toBeUndefined();
    expect(claudeSdkMcpServerTimeoutForServer(MCP_DEFAULT_TOOL_TIMEOUT_MS + 1, 46_000)).toBeUndefined();
  });

  it('F1.1103 — a per-server value in the setTimeout-overflow class projects NOTHING, and the session value does not leak in behind it', () => {
    // The overflow class DN-068 measured, through the per-server half. The
    // second assertion is the one that matters: a `.mcp.json` `timeout` of 3e9
    // must not silently fall through to the session projection — the drop has
    // to be a drop, because a server whose operator asked for "forever" gets
    // the SDK default, not the session ceiling.
    expect(claudeSdkMcpServerTimeoutForServer(2_147_483_648, 46_000)).toBeUndefined();
    expect(claudeSdkMcpServerTimeoutForServer(3_000_000_000, undefined)).toBeUndefined();
  });

  it('END TO END — the built SDK server carries it, and its sibling is untouched', async () => {
    const pool = new McpClientPool();
    await registerFixtureClient(pool, 'docs', fakeToolClient(), {
      ...FIXTURE_STDIO_CONFIG, toolTimeoutMs: 600_000,
    } as never);
    await registerFixtureClient(pool, 'linear', fakeToolClient());

    const servers = createSourceProxyServers(pool);

    expect((servers.docs as unknown as { timeout?: number }).timeout).toBe(601_000);
    // The whole point of the fall-through: a source that configured nothing is
    // built exactly as it was before this row (no lever set in this process, so
    // the session projection is absent too).
    expect((servers.linear as unknown as { timeout?: number }).timeout).toBeUndefined();
  });
});
