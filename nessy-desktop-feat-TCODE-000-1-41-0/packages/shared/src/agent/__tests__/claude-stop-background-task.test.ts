/**
 * L9 — `ClaudeAgent.stopBackgroundTask`, the first call this repo makes to
 * `Query.stopTask`.
 *
 * ## The premise, checked rather than inherited
 *
 * `Query.stopTask(taskId): Promise<void>` and `Query.backgroundTasks(toolUseId?)`
 * are both declared in the installed `@anthropic-ai/claude-agent-sdk@0.3.218`
 * (asserted mechanically in `claude-live-settings.test.ts`, which reads the
 * shipped `sdk.d.ts`), and before this row NEITHER was called from anywhere in
 * the repo — every `stopTask` in the tree belongs to Pi's `ChildSessionPort`, a
 * different mechanism that happens to share the name.
 *
 * ## Why this file does NOT mock the SDK module
 *
 * Four test files already install a `mock.module('@anthropic-ai/claude-agent-sdk')`
 * fake, and `mock.module` is process-global: the last one evaluated is the one
 * live during the OTHER files' tests. A fifth armed fake for the same specifier
 * is a coin flip on file order, and this method needs none — it reads
 * `currentQuery` and the adapter's level and sends one control request, so the
 * seam can be injected on the instance. `ClaudeAgent`'s constructor is
 * SDK-free (a query is only created inside `ensureLiveSession`), which is what
 * makes that possible.
 *
 * ## The discipline
 *
 * Every refusal names the precondition that produced it AND asserts the control
 * request was not sent — "it returned false" alone cannot tell a guard from a
 * silently swallowed call.
 */
import { afterEach, describe, expect, it } from 'bun:test';

import { bracedRegion } from '../../testing/source-regions.ts';
import { readFileSync } from 'node:fs';
import type { BackendConfig } from '../backend/types.ts';
import { ClaudeAgent } from '../claude-agent.ts';

function sdkTypings(): string {
  const entry = require.resolve('@anthropic-ai/claude-agent-sdk');
  return readFileSync(entry.replace(/sdk\.mjs$/, 'sdk.d.ts'), 'utf8');
}

const WORKSPACE_ID = 'ws-l9-stop-task';
const WORKSPACE_ROOT = '/tmp/nessy-l9-stop-task';

let sessionCounter = 0;

function agentConfig(): BackendConfig {
  sessionCounter += 1;
  return {
    provider: 'anthropic',
    providerType: 'anthropic',
    model: 'claude-sonnet-4-6',
    isHeadless: true,
    skipConfigWatcher: true,
    workspace: {
      id: WORKSPACE_ID,
      name: 'L9 Stop Task',
      rootPath: WORKSPACE_ROOT,
      workspaceRootPath: WORKSPACE_ROOT,
      sessionRootPath: `${WORKSPACE_ROOT}/sessions`,
    } as never,
    session: {
      id: `session-l9-${sessionCounter}`,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      workingDirectory: WORKSPACE_ROOT,
    } as never,
  } as BackendConfig;
}

type Agent = InstanceType<typeof ClaudeAgent>;

interface Rig {
  agent: Agent;
  /** Ids the fake child was asked to stop, in order. Empty means nothing was sent. */
  stopCalls: string[];
  /**
   * P6.793 — what `Query.backgroundTasks` was called with, in order. `undefined`
   * is the SDK's "all foreground tasks" mode and is recorded as such, so a test
   * can tell "sent with no id" from "not sent".
   */
  backgroundCalls: (string | undefined)[];
}

const agents: Agent[] = [];

/**
 * An agent whose live child answers `stopTask` however the test asks.
 *
 * `backgroundTaskCount` is a getter on `ClaudeEventAdapter`'s prototype; an own
 * property on the instance shadows it, so the level can be set without touching
 * the adapter's own file.
 */
function rig(options: {
  /** How many background tasks the child is holding. Default 1. */
  level?: number;
  /** `false` omits the method entirely, exercising the `typeof` guard. */
  stopTask?: false | ((taskId: string) => Promise<void>);
  /**
   * P6.793 — the OTHER lever on the same fake child. `false` omits it, which is
   * the SDK build that predates it; a function answers the way the real
   * `Query.backgroundTasks` does, including its documented `false`.
   */
  backgroundTasks?: false | ((toolUseId?: string) => Promise<boolean>);
  /** No live child at all. */
  noQuery?: boolean;
} = {}): Rig {
  const agent = new ClaudeAgent(agentConfig()) as Agent;
  agents.push(agent);
  const internals = agent as unknown as {
    currentQuery: unknown;
    eventAdapter: object;
    interruptDeadlineMs: number;
  };
  internals.interruptDeadlineMs = 120;

  Object.defineProperty(internals.eventAdapter, 'backgroundTaskCount', {
    configurable: true,
    get: () => options.level ?? 1,
  });

  const stopCalls: string[] = [];
  const backgroundCalls: (string | undefined)[] = [];
  if (!options.noQuery) {
    const query: Record<string, unknown> = {};
    if (options.stopTask !== false) {
      query.stopTask = async (taskId: string) => {
        stopCalls.push(taskId);
        if (typeof options.stopTask === 'function') await options.stopTask(taskId);
      };
    }
    if (options.backgroundTasks !== false) {
      query.backgroundTasks = async (toolUseId?: string) => {
        backgroundCalls.push(toolUseId);
        return typeof options.backgroundTasks === 'function'
          ? await options.backgroundTasks(toolUseId)
          : true;
      };
    }
    internals.currentQuery = query;
  }

  return { agent, stopCalls, backgroundCalls };
}

afterEach(() => {
  for (const agent of agents.splice(0)) {
    try {
      (agent as unknown as { destroy(): void }).destroy();
    } catch {
      // A never-started agent has nothing to tear down.
    }
  }
});

describe('ClaudeAgent.stopBackgroundTask', () => {
  it('sends the stop to the live child and reports the acceptance', async () => {
    const { agent, stopCalls } = rig({ level: 2 });

    const result = await agent.stopBackgroundTask('task_42');

    expect(result).toEqual({ stopped: true });
    expect(stopCalls).toEqual(['task_42']);
  });

  it('refuses when the session holds NO background task, and sends nothing', async () => {
    // The state a stale row is in after `resetBackgroundTaskLevel`: the child
    // restarted and the task died with it, so a "success" here would remove a row
    // for something nothing stopped — the exact lie this row exists to remove.
    const { agent, stopCalls } = rig({ level: 0 });

    const result = await agent.stopBackgroundTask('task_42');

    expect(result.stopped).toBe(false);
    expect(result.error).toContain('holds no background task');
    expect(stopCalls).toEqual([]);
  });

  it('refuses when there is no live child', async () => {
    const { agent, stopCalls } = rig({ noQuery: true });

    const result = await agent.stopBackgroundTask('task_42');

    expect(result.stopped).toBe(false);
    expect(result.error).toContain('no live Claude session');
    expect(stopCalls).toEqual([]);
  });

  it('refuses when this SDK build has no stopTask, rather than throwing', async () => {
    const { agent, stopCalls } = rig({ stopTask: false });

    const result = await agent.stopBackgroundTask('task_42');

    expect(result.stopped).toBe(false);
    expect(result.error).toContain('not implemented by this Claude SDK build');
    expect(stopCalls).toEqual([]);
  });

  it("reports a CLI refusal in the CLI's own words instead of claiming a stop", async () => {
    const { agent, stopCalls } = rig({
      stopTask: async () => { throw new Error('stop_task: unknown task id: task_42'); },
    });

    const result = await agent.stopBackgroundTask('task_42');

    expect(result.stopped).toBe(false);
    expect(result.error).toBe('stop_task: unknown task id: task_42');
    // The request WAS sent — this is a refusal, not a guard, and the two must not
    // be confusable from the return value alone.
    expect(stopCalls).toEqual(['task_42']);
  });

  it('does not hang on a child that never answers its control channel', async () => {
    // `awaitControlResponse` has no timeout of its own, so without the deadline
    // this call — and the button the user pressed — waits forever.
    const { agent, stopCalls } = rig({ stopTask: () => new Promise<void>(() => {}) });

    const started = Date.now();
    const result = await agent.stopBackgroundTask('task_42');

    expect(result.stopped).toBe(false);
    expect(result.error).toContain('did not answer within');
    expect(stopCalls).toEqual(['task_42']);
    expect(Date.now() - started).toBeLessThan(3_000);
  });
});

/**
 * NO GUARD HERE WRITES THE USER'S SENTENCE.
 *
 * The three guards used to return full English sentences ("The Claude session is
 * not running, so it holds no background task to stop.") on the strength of this
 * method's own comment, which said "The `error` is prose meant for the user".
 * `dto.ts` says the opposite of the same field — "Backend detail for logs and bug
 * reports — never the whole user-facing text" — and `dto.ts` is the contract that
 * matters, because `SessionManager` maps ANY arm-1 error to `reason: 'failed'` and
 * the renderer then had exactly one place to put the string: the toast body, in
 * every locale. Two contracts disagreeing was the defect; this pins the resolution
 * on this side, and `useBackgroundTasks.test.ts` pins it on the renderer's.
 */
describe('every refusal is a log line, not a sentence for a user', () => {
  const arms: Array<[string, Parameters<typeof rig>[0]]> = [
    ['no live child', { noQuery: true }],
    ['no stopTask in this build', { stopTask: false }],
    ['session holds no background task', { level: 0 }],
  ];

  for (const [name, options] of arms) {
    it(`${name} — diagnostic shaped, and it names the id`, async () => {
      const { agent } = rig(options);
      const result = await agent.stopBackgroundTask('task_42');
      expect(result.stopped).toBe(false);
      // Log-shaped: the call and its argument first, so a bug report says WHICH id.
      expect(result.error!.startsWith('stopTask(task_42):')).toBe(true);
      // A sentence for a user would be capitalised and full-stopped; a diagnostic
      // is neither. This is what stops the next editor writing prose here again.
      expect(result.error!).not.toMatch(/\.$/);
      expect(result.error!).not.toMatch(/^[A-Z]/);
    });
  }
});

/**
 * L9 review finding 4 — THE DOC CLAIM, CHECKED AGAINST THE TYPINGS THAT CARRY IT.
 *
 * The method's comment first asserted that `sdk.d.ts` calls `stopTask` a
 * "streaming-only control request". It does NOT say that at `stopTask`, and the
 * reviewer was right about the line — but the property is still documented, one
 * level up, by the `Query` interface's own opening block. Since a doc line decays
 * and a quoted sentence does not, both halves are now pinned: the sentence exists
 * where the comment now says it does, and it does NOT exist where the comment used
 * to say it did.
 */
describe('the streaming-only claim, against the installed sdk.d.ts', () => {
  it("the Query interface's opening block is where the claim lives", () => {
    const typings = sdkTypings();
    const iface = typings.indexOf('export declare interface Query extends AsyncGenerator');
    expect(iface).toBeGreaterThan(0);
    const stopTask = typings.indexOf('stopTask(taskId: string): Promise<void>;', iface);
    expect(stopTask).toBeGreaterThan(iface);
    const preamble = typings.slice(iface, stopTask);
    expect(preamble).toContain('The following methods are control requests, and are only supported when');
    expect(preamble).toContain('streaming input/output is used.');
  });

  it("stopTask's OWN doc comment says nothing about streaming", () => {
    const typings = sdkTypings();
    const at = typings.indexOf('stopTask(taskId: string): Promise<void>;');
    const own = typings.slice(typings.lastIndexOf('/**', at), at);
    expect(own).toContain('Stop a running task');
    expect(own).toContain("task_notification with status 'stopped' will be emitted");
    expect(own).not.toContain('streaming');
  });

  it('the comment in claude-agent.ts now cites the block it actually came from', () => {
    const source = readFileSync(new URL('../claude-agent.ts', import.meta.url), 'utf8');
    const method = source.slice(
      source.lastIndexOf('/**', source.indexOf('async stopBackgroundTask(')),
      source.indexOf('async stopBackgroundTask('),
    );
    expect(method).toContain('The following methods are control requests');
    // And the guard is explained and read under ONE name.
    expect(method).toContain('backgroundWorkCount() === 0');
    const body = source.slice(
      source.indexOf('async stopBackgroundTask('),
      source.indexOf('async stopBackgroundTask(') + 1_400,
    );
    expect(body).toContain('this.backgroundWorkCount() === 0');
    expect(body).not.toContain('this.eventAdapter.backgroundTaskCount === 0');
  });

  it('the lever is DECLARED on AgentInstance, so its three return states are a contract', () => {
    // The first version reached it through a structural cast on `managed.agent`,
    // which documents none of the three states the caller must distinguish. The
    // optional-method shape is the one L5 established for `backgroundWorkCount`.
    const types = readFileSync(new URL('../backend/types.ts', import.meta.url), 'utf8');
    expect(types).toContain('stopBackgroundTask?(taskId: string): Promise<{ stopped: boolean; error?: string }>;');
    const doc = types.slice(
      types.lastIndexOf('/**', types.indexOf('stopBackgroundTask?(taskId: string)')),
      types.indexOf('stopBackgroundTask?(taskId: string)'),
    );
    // The state whose mishandling is the whole point: "not mine" is a fall-through
    // instruction, not a failure.
    expect(doc).toContain('FALL');
    expect(doc).toContain('half-stopped tree');
  });
});

/**
 * P6.793 — `ClaudeAgent.backgroundInFlightTasks`, the FIRST call this repo makes
 * to `Query.backgroundTasks`.
 *
 * The file above measured, at L9, that neither `stopTask` nor `backgroundTasks`
 * had a caller anywhere in the tree. `stopTask` got one then; this is the other
 * one, and P6.308 re-measured its absence as a fifth unread SDK surface.
 *
 * The SDK's own contract, verbatim: *"Background in-flight foreground tasks
 * (Bash commands and subagents). With `toolUseId`, targets the single task
 * started by that tool_use block; without it, backgrounds all foreground tasks
 * … @returns true when at least one task was backgrounded; false only when
 * `toolUseId` was given and it matched no foreground task."*
 *
 * The case that matters most is the LAST one: a documented `false` is not a
 * failure, and rounding it up to success is the lie the whole row exists to
 * remove.
 */
describe('ClaudeAgent.backgroundInFlightTasks (P6.793)', () => {
  it('sends the SDK call and reports the acceptance — with an id and without one', async () => {
    const { agent, backgroundCalls } = rig();

    expect(await agent.backgroundInFlightTasks('toolu_01')).toEqual({ backgrounded: true });
    // No id is the SDK's "all foreground tasks" mode, not a missing argument.
    expect(await agent.backgroundInFlightTasks()).toEqual({ backgrounded: true });

    expect(backgroundCalls).toEqual(['toolu_01', undefined]);
  });

  it('a documented `false` is "nothing was blocking", NOT an error', async () => {
    // The SDK returns false only when a toolUseId matched no foreground task.
    // The absence of `error` is the assertion: the caller reads that absence to
    // choose its sentence, and an error string here would tell the user their
    // press failed when nothing failed.
    const { agent, backgroundCalls } = rig({ backgroundTasks: async () => false });

    const result = await agent.backgroundInFlightTasks('toolu_missing');

    expect(result).toEqual({ backgrounded: false });
    expect(result).not.toHaveProperty('error');
    expect(backgroundCalls).toEqual(['toolu_missing']);
  });

  it('refuses with no live child, and sends nothing', async () => {
    const { agent, backgroundCalls } = rig({ noQuery: true });

    const result = await agent.backgroundInFlightTasks();

    expect(result.backgrounded).toBe(false);
    expect(result.error).toContain('no live Claude session');
    expect(backgroundCalls).toEqual([]);
  });

  it('refuses when this SDK build has no such method, and sends nothing', async () => {
    const { agent, backgroundCalls } = rig({ backgroundTasks: false });

    const result = await agent.backgroundInFlightTasks('toolu_01');

    expect(result.backgrounded).toBe(false);
    expect(result.error).toContain('not implemented by this Claude SDK build');
    expect(backgroundCalls).toEqual([]);
  });

  it('a throwing child is reported as a failure, not swallowed', async () => {
    const { agent } = rig({
      backgroundTasks: async () => { throw new Error('control request refused'); },
    });

    const result = await agent.backgroundInFlightTasks();

    expect(result.backgrounded).toBe(false);
    expect(result.error).toContain('control request refused');
  });

  it('does NOT inherit the sibling\u2019s background-count guard, which would invert it', async () => {
    // `stopBackgroundTask` refuses when `backgroundWorkCount() === 0` because it
    // acts on a task ALREADY backgrounded. This method acts on a FOREGROUND one,
    // and a session holding zero background tasks is its ordinary case — copying
    // that guard would refuse every honest press.
    const { agent, backgroundCalls } = rig({ level: 0 });

    expect(await agent.backgroundInFlightTasks()).toEqual({ backgrounded: true });
    expect(backgroundCalls).toEqual([undefined]);

    const source = readFileSync(new URL('../claude-agent.ts', import.meta.url), 'utf8');
    const start = source.indexOf('async backgroundInFlightTasks(');
    expect(start).toBeGreaterThan(-1);
    // D1.111 — and this site is the one where a bad bound would have been
    // INVISIBLE: the claim is a NEGATIVE, so any region too small satisfies it.
    // The declaration's first `{` is inside the RETURN TYPE
    // (`Promise<{ backgrounded: boolean; … }>`), so a region anchored there
    // would be that type literal and the assertion would pass over nothing.
    // Anchor past the signature, then take the body's own braces.
    const bodyAt = source.indexOf('}> {', start);
    expect(bodyAt).toBeGreaterThan(start);
    const body = bracedRegion(source, bodyAt);
    // The positive control the negative needs: this IS the method body.
    expect(body).toContain('live.backgroundTasks(toolUseId)');
    // BOUNDARY CONTROL: the next method below it.
    expect(body).not.toContain('private mintStreamPermissionDenialReceipt(');
    expect(body).not.toContain('backgroundWorkCount()');
  });

  it('the SDK still declares the method this row reads', () => {
    // The premise, checked rather than inherited — the same discipline the
    // `stopTask` half of this file uses, against the shipped typings.
    expect(sdkTypings()).toContain('backgroundTasks(toolUseId?: string): Promise<boolean>;');
  });
});

/**
 * P7.18 — the DECLARATION that keeps L9's affordance meaningful after the
 * `0.3.233` → `0.3.247` lift.
 *
 * `Options.perTaskStopAffordance` does not exist at `0.3.233` (the name scores 0
 * in that `sdk.d.ts`) and is declared twice at `0.3.247`. Its own doc comment
 * states the fail-closed rule verbatim: *"The CLI also fails closed on absence:
 * without the declaration, an interrupt kills background tasks, because a spared
 * runaway task would otherwise be unstoppable from this consumer short of ending
 * the session."* So the lift alone would have changed what Stop does in this app,
 * silently.
 *
 * This block pins the two halves that must not drift apart: that we declare it,
 * and that the thing we declare — a per-task stop wired to `stop_task` — is
 * really there. The cases above are that affordance; these three are the
 * declaration and its controls. The remaining arm, an interrupt driven against a
 * live child holding a background task, needs a real CLI and is a sitting case.
 */
describe('P7.18 · the per-task stop affordance is declared, and it is not a claim we cannot keep', () => {
  it('declares the SDK’s own option name — not an invented spelling', () => {
    // Read, do not invent: pinned against the SDK that ships, so an upstream
    // rename fails here instead of silently reverting the interrupt behaviour.
    // `forwardSubagentText` is the positive control — a sibling `Options` flag
    // this file's typings reader has always resolved.
    const typings = sdkTypings();
    expect(typings).toContain('perTaskStopAffordance?: boolean;');
    expect(typings).toContain('forwardSubagentText?: boolean;');
  });

  it('sets it on the options this backend builds', () => {
    const source = readFileSync(new URL('../claude-agent.ts', import.meta.url), 'utf8');
    expect(source).toContain('perTaskStopAffordance: true,');
  });

  it('the affordance the declaration promises is reachable: a held task really is stoppable', async () => {
    // The vendor's precondition is *"this consumer renders a per-task stop
    // control wired to the `stop_task` control request"*. The renderer half is
    // the task chip card's Stop (`BackgroundTaskChip.tsx`, UB14.7); the routing half is
    // `SessionManager.killShell` -> `AgentInstance.stopBackgroundTask`; this is
    // the backend half, driven. If it ever stops sending, the declaration above
    // becomes a promise this app cannot keep, and both assertions are in one
    // file so that cannot happen quietly.
    const { agent, stopCalls } = rig({ level: 1 });
    expect(await agent.stopBackgroundTask('task_p718')).toEqual({ stopped: true });
    expect(stopCalls).toEqual(['task_p718']);
  });
});
