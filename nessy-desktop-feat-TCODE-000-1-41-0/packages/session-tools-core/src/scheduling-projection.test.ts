/**
 * T3 — the five scheduling/watching tools are projected to claude-runtime, and
 * still withheld from an external standalone subprocess.
 *
 * `Monitor`, `CronCreate`, `CronList`, `CronDelete` and `ScheduleWakeup` were
 * all `visibility: 'pi-only'`. T1 generalized the cron service and T2 built the
 * host-side Monitor gate, so both recorded reasons for the restriction are
 * gone; what is NOT gone is the host-callback dependency, which is why all five
 * stayed out of the Codex surface until T5 landed the callback bridge.
 *
 * T5/P3.10 — the exclusion is now conditional, and both conditions are pinned
 * below: an external standalone subprocess spawned WITHOUT a bridge port keeps
 * the 18-tool surface unchanged, and one spawned WITH it advertises 24 — T5's
 * five (the four cron tools and `Monitor`) plus P3.10's `ProcessStop`.
 *
 * Every row below reads the enforcement site (`getSessionToolDefs` through its
 * name helpers) rather than the literal table, so a def edited without the
 * filter honouring it — or a filter that stops honouring the defs — fails here.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import {
  CRON_TOOL_NAMES,
  GoalSchema,
  SESSION_BACKEND_TOOLS_BRIDGED_BY_HOST_CALLBACK,
  flattenDiscriminatedUnionForSdkTool,
  LEGACY_TASK_TOOL_NAMES,
  SESSION_TOOLS_BRIDGED_BY_HOST_CALLBACK,
  SESSION_TOOLS_REQUIRING_HOST_CALLBACK,
  SESSION_TOOLS_WITHHELD_FOR_NATIVE_EQUIVALENT,
  getSessionRegistryToolNames,
  getSessionSafeAllowedToolNames,
  getSessionToolNames,
  isCronDisabled,
} from './tool-defs.ts';
import {
  HOST_CALLBACK_BRIDGE_GOAL_ACTIONS,
  HOST_CALLBACK_BRIDGE_ROUTES,
} from './host-callback-bridge.ts';

/** The row's subject, in one place. Mutable so `it.each` accepts it. */
const PROJECTED: string[] = ['Monitor', 'CronCreate', 'CronList', 'CronDelete', 'CronControl', 'ScheduleWakeup'];

/**
 * P2.2 — the goal pair left `pi-only` for the same reason and by the same
 * mechanism, one task later: the host binds `ctx.goalPort` for every runtime in
 * `SCHEDULED_DELIVERY_RUNTIMES`, so the tools answer for real on all three.
 * Kept as its own list rather than folded into `PROJECTED`, because the two
 * projections are separately revocable and a single list would hide which task
 * a regression belongs to.
 */
const GOAL_PROJECTED: string[] = ['GoalGet', 'Goal'];

/**
 * P3.10 — the bridge also carries `ProcessStop`, so a persistent codex watch is
 * model-stoppable. It is NOT one of the five T3 projected out of `pi-only`
 * (`ProcessStop` was always on the Claude/Pi surface), which is why the bridged
 * set is the projected five PLUS this one — and, since P2.2, plus the goal pair.
 */
/**
 * P3.222 — the ROSTER pair joins the bridged set, and it is the one addition
 * that also SHRINKS the bare surface.
 *
 * `list_sessions` and `get_session_info` were in neither host-callback set, so
 * they survived the `externalStandaloneOnly` filter — and `createCodexContext`
 * bound neither closure, so they answered "not available in this context" on
 * every codex call. Being out of the sets advertised them; it never gave codex
 * the capability. 18 → 16 bare is therefore a correction, not a narrowing.
 */
const ROSTER_BRIDGED: string[] = ['list_sessions', 'get_session_info'];

/**
 * P6.466 — the archive verb, and the one bridged tool whose route exists for a
 * PERMISSION reason rather than a capability one.
 *
 * Measured: neither `INTERACTION_ONLY_TOOLS` (inside `runPreToolUseChecks`,
 * zero call sites in `codex-agent.ts`) nor `findNonNegotiableFloors` (reached
 * on codex only through `codexApprovalFloorSubjects`, whose subjects are `Bash`
 * and `Write`) is on codex's answer path for a session MCP tool. So the
 * approval card lives in the host closure, and this route is how a bridged
 * codex session meets it. Its own list, because a regression here means the
 * card went missing on codex — not that a tool went missing.
 */
const ARCHIVE_BRIDGED: string[] = ['archive_session'];

/**
 * UA1.3 — the self-management pair. Both were in the host-callback set and out of the bridged one, so a codex
 * session had neither while Pi and Claude reached the same host closures in process; codex has no workflow status
 * or label of its own. Their own list, because a regression here is the closure rule (UA1.2) going missing on
 * codex, not merely a tool.
 */
const STATUS_LABELS_BRIDGED: string[] = ['set_session_labels', 'set_session_status'];

/**
 * UA1.18 — the t-artifacts pair. `publish_artifact`'s card lives in the host closure (archive_session's seam), so a
 * regression here is the publish card going missing on codex, not merely a tool.
 */
const ARTIFACT_BRIDGED: string[] = ['publish_artifact', 'list_artifacts'];

/**
 * UA3.5 — the board task tool. Every restriction on the invoking agent lives in the host closure the route reaches, so
 * a regression here is codex losing the tool (or the restrictions), not merely a name.
 */
const BOARD_TASK_BRIDGED: string[] = ['create_board_task'];

/**
 * UB1.12 — the append-only project-memory note (v0.15.1 upstream parity, offered unconditionally): the project read,
 * the dated heading and the one O_APPEND write live in the host closure the route reaches, so a regression here is
 * codex losing the tool (or appending under another session's name), not merely a name.
 */
const PROJECT_MEMORY_BRIDGED: string[] = ['project_memory_append'];

/**
 * UB7.11 — the MCP prompt pair (v0.15.1 upstream parity, offered unconditionally on every runtime): the enabled-source
 * check, the pool reads, the rendering and the large-result guard live in the host closure the two routes reach, so a
 * regression here is codex losing the tools (or reading another session's sources), not merely names.
 */
const MCP_SOURCES_BRIDGED: string[] = ['source_list_prompts', 'source_get_prompt'];

/**
 * UA6.3 — the six page tools. Storage and `delete_page`'s one-shot card live in the host closure the six routes reach,
 * so a regression here is codex losing the tools (or the card), not merely names.
 */
const PAGES_BRIDGED: string[] = ['list_pages', 'get_page', 'create_page', 'update_page', 'write_page_data', 'delete_page'];
const BRIDGED: string[] = [...PROJECTED, 'ProcessStop', ...GOAL_PROJECTED, 'send_agent_message', ...ROSTER_BRIDGED, ...ARCHIVE_BRIDGED, ...STATUS_LABELS_BRIDGED, ...ARTIFACT_BRIDGED, ...BOARD_TASK_BRIDGED, ...PROJECT_MEMORY_BRIDGED, ...PAGES_BRIDGED, ...MCP_SOURCES_BRIDGED];

/**
 * P3.276 — in the bridged SET, and deliberately not in what the bridge lifts at
 * default flags.
 *
 * `ReviewDiff` is gated a second time, by `SessionToolFilterOptions.reviewDiffPort`:
 * the host must say it has bound `ctx.reviewDiff` before the tool is offered on
 * ANY projection. So it belongs to `SESSION_TOOLS_BRIDGED_BY_HOST_CALLBACK`
 * (the bridge has a route for it) and it must NOT appear in the surface
 * difference the bridge flag alone produces. Two different questions about one
 * tool, which is why the two lists are separate rather than one list with a
 * caveat.
 */
// P6.184 added the second, and for the same structural reason: the tool is in
// the bridged set, and a second gate — `SessionToolFilterOptions.notificationPort`
// ANDed with the bridge — decides whether it is OFFERED. So neither name appears
// on `codexBridged()`, which passes no port flag, and both are pinned here by
// their MEMBERSHIP rather than by an advertised surface.
//
// P6.137 added the worktree three, gated by `SessionToolFilterOptions.worktreePort`
// ANDed with the same bridge. Same structure, one extra property worth naming
// because it is the only one of these that carries a security floor: the enter
// route additionally requires the host's `worktreeEnterAuthority`, so a bridged
// spawn whose host bound the port but not the floor is refused rather than
// entering unjudged.
const PORT_GATED_BRIDGED: string[] = [
  'ReviewDiff',
  'PushNotification',
  'EnterWorktree',
  'ExitWorktree',
  'WorktreeBatch',
  // UB6.11 — the decide tool, the same structure one more time: in the bridged
  // set (the route exists), OFFERED only under `SessionToolFilterOptions.decidePort`
  // — which the codex spawn derives from `--decide-port`, emitted beside the
  // bridge port only when the decision layer is configured. Neither name
  // appears on `codexBridged()`, which passes no port flag.
  'decide',
];

/** P6.137 — the three names the worktree flag lifts, for the disjointness case. */
const SESSION_TOOLS_LIFTED_BY_WORKTREE_NAMES = ['EnterWorktree', 'ExitWorktree', 'WorktreeBatch'];

/** P6.137 — the same spawn, told the host also serves the worktree routes. */
const codexWorktreed = () => getSessionToolNames({
  externalStandaloneOnly: true,
  hostCallbackBridge: true,
  worktreePort: true,
});

/** P6.184 — the bridged codex spawn as the real subprocess builds it. */
const codexNotified = () => getSessionToolNames({
  externalStandaloneOnly: true,
  hostCallbackBridge: true,
  notificationPort: true,
});

const pi = () => getSessionToolNames({ projection: 'pi' });
const claude = () => getSessionToolNames();
const codex = () => getSessionToolNames({ externalStandaloneOnly: true });
/** T5 — the same external subprocess, spawned with a host-callback bridge port. */
const codexBridged = () => getSessionToolNames({ externalStandaloneOnly: true, hostCallbackBridge: true });
/** P3.13 — the same spawn, told the host also serves `advisor/consult`. */
const codexAdvised = () => getSessionToolNames({
  externalStandaloneOnly: true,
  hostCallbackBridge: true,
  advisorConsultBridge: true,
});

describe('T3 projection preconditions', () => {
  // `isCronDisabled` is read from process.env INSIDE getSessionToolDefs, so a
  // polluted environment would empty four of the five sets below and every
  // "absent" row would pass for the wrong reason. Fail loudly, naming the cause.
  it('runs with the scheduler enabled', () => {
    expect(isCronDisabled(), 'NESSY_DISABLE_CRON / CLAUDE_CODE_DISABLE_CRON is set in this test env').toBe(false);
  });

  // The cron names are the flag's set; the projected ones are the projection's.
  // They are maintained separately, so pin the relation rather than letting a
  // reader assume either contains the other. P6.295 arm (2) moved both by one,
  // `CronControl` — a control tool that survived `NESSY_DISABLE_CRON` would be
  // a way to pause and run tasks in a session whose scheduler is off.
  it('the cron flag set is the scheduling tools, inside the projected set', () => {
    expect([...CRON_TOOL_NAMES].sort()).toEqual(['CronControl', 'CronCreate', 'CronDelete', 'CronList', 'ScheduleWakeup']);
    expect([...CRON_TOOL_NAMES].every(name => PROJECTED.includes(name))).toBe(true);
  });
});

describe('the default projection (claude-runtime) advertises all five', () => {
  it.each(PROJECTED)('%s is on the Claude surface', name => {
    expect(claude().has(name)).toBe(true);
  });

  // Positive control for the row above: the projection filter still WITHHOLDS
  // something, so "present" is a measurement and not a filter that stopped
  // running. `PushNotification` is the pi-only tool T3 deliberately left alone.
  it('still withholds the tools that stayed pi-only', () => {
    expect(claude().has('PushNotification')).toBe(false);
    expect(pi().has('PushNotification')).toBe(true);
    expect(claude().has('EnterWorktree')).toBe(false);
  });

  it('Pi keeps all five — the projection widened, it did not move', () => {
    for (const name of PROJECTED) expect(pi().has(name)).toBe(true);
  });
});

describe('P2.2 — the goal pair is projected the same way, in both directions', () => {
  it.each(GOAL_PROJECTED)('%s is on the Claude surface', name => {
    expect(claude().has(name)).toBe(true);
  });

  it.each(GOAL_PROJECTED)('%s stays on the Pi surface — the projection widened, it did not move', name => {
    expect(pi().has(name)).toBe(true);
  });

  // The other direction of the same claim: without a bridge the pair is
  // withheld from an external standalone subprocess, and for the RIGHT reason —
  // the host-callback set, which is the one the bridge lifts.
  it.each(GOAL_PROJECTED)('%s is absent from an unbridged Codex surface, by the host-callback set', name => {
    expect(codex().has(name)).toBe(false);
    expect(SESSION_TOOLS_REQUIRING_HOST_CALLBACK.has(name)).toBe(true);
  });

  it.each(GOAL_PROJECTED)('%s crosses to Codex once the bridge is configured', name => {
    expect(codexBridged().has(name)).toBe(true);
    expect(SESSION_TOOLS_BRIDGED_BY_HOST_CALLBACK.has(name)).toBe(true);
  });

  // Positive control for the four rows above: the projection filter still
  // WITHHOLDS the neighbouring Pi-only tools, so "present" is a measurement and
  // not a filter that stopped running. The task tools are the closest
  // neighbours — same block in the def table, same era, still pi-only.
  it('the tools that stayed pi-only around it are still withheld', () => {
    for (const name of ['TaskCreate', 'TaskGet', 'PushNotification']) {
      expect(claude().has(name)).toBe(false);
      expect(pi().has(name)).toBe(true);
    }
  });

  // `safeMode` did not move with the projection: `GoalGet` is a read and `Goal`
  // arms an unattended continuation loop, which is the effect-outliving-the-call
  // that the read-only allowlist withholds — the same split `CronList` vs `CronCreate` has.
  it('the read-only allowlist (Plan, Don\'t ask) allows GoalGet and not Goal', () => {
    const allowed = getSessionSafeAllowedToolNames({ prefix: 'mcp__session__' });
    expect(allowed.has('mcp__session__GoalGet')).toBe(true);
    expect(allowed.has('mcp__session__Goal')).toBe(false);
  });

  /**
   * `Goal` is the first session tool whose TOP LEVEL is a union, and the Claude
   * SDK's `tool()` takes a Zod raw shape and nothing else — so projecting it
   * onto that surface threw `claude-session-tool-schema-not-object:Goal` until
   * the union was flattened for advertisement. These rows own the flattening's
   * two halves: what it produces, and what it refuses to produce.
   */
  describe('the SDK-tool flattening that made the Claude advertisement possible', () => {
    it('turns the Goal union into a raw shape: the action enum plus every other field optional', () => {
      const shape = flattenDiscriminatedUnionForSdkTool(GoalSchema) as
        Record<string, { options?: unknown; safeParse(value: unknown): { success: boolean } }> | undefined;
      expect(shape).toBeDefined();
      // Every field any branch declares is present exactly once…
      expect(Object.keys(shape!).sort()).toEqual([
        'action', 'blockedBy', 'blockingCondition', 'budgets', 'condition', 'evidence', 'id', 'reason', 'revision',
      ]);
      // …the discriminator carries the closed set of the six actions, and only
      // those…
      expect(shape!.action!.options).toEqual(GoalSchema.options.map(option => option.shape.action.value));
      expect(shape!.action!.safeParse('create').success).toBe(true);
      expect(shape!.action!.safeParse('delete').success).toBe(false);
      // …and every OTHER field accepts `undefined`, i.e. is optional. That is
      // the whole reason `handleGoal` re-parses through the real union: a flat
      // shape cannot say "complete requires evidence", and the union does.
      for (const [field, type] of Object.entries(shape!)) {
        if (field === 'action') continue;
        expect(type.safeParse(undefined).success, `${field} should be optional`).toBe(true);
      }
      expect(GoalSchema.safeParse({ action: 'complete' }).success).toBe(false);
      // The strictness that matters is NOT in the shape at all: the attribution
      // fields the host stamps are on no branch, so no flattened field exists
      // for them and the model has nothing to fill in.
      expect(Object.keys(shape!)).not.toContain('source');
      expect(Object.keys(shape!)).not.toContain('creator');
    });

    // The negative half: anything that is not a discriminated union of objects
    // returns `undefined`, so the Claude builder's guard still fires rather than
    // silently advertising a schema nobody checked.
    it('returns undefined for schemas it cannot flatten', () => {
      for (const schema of [z.object({ a: z.string() }), z.string(), z.union([z.string(), z.number()]), null, {}]) {
        expect(flattenDiscriminatedUnionForSdkTool(schema)).toBeUndefined();
      }
    });
  });
});

describe('T5/P3.10 — the host-callback bridge lifts the exclusion, and only for the bridged set', () => {
  it.each(BRIDGED)('%s is on the Codex surface once the bridge is configured', name => {
    expect(codexBridged().has(name)).toBe(true);
  });

  // The bridged set is a SUBSET of the host-callback set, not a replacement for
  // it: the six still depend on a host callback, which is why they are the ones
  // the bridge had to carry. P3.10 added `ProcessStop` (its monitor half rides
  // `monitor/stop`); the four cron tools and `Monitor` are T5's five.
  it('the bridged set is the projected five plus ProcessStop, the goal pair, send_agent_message and the port-gated five, all inside the host-callback set', () => {
    expect([...SESSION_TOOLS_BRIDGED_BY_HOST_CALLBACK].sort())
      .toEqual([...BRIDGED, ...PORT_GATED_BRIDGED].sort());
    for (const name of SESSION_TOOLS_BRIDGED_BY_HOST_CALLBACK) {
      expect(SESSION_TOOLS_REQUIRING_HOST_CALLBACK.has(name)).toBe(true);
    }
  });

  // Positive control: the flag lifts EIGHT exclusions, not the whole filter. A
  // bridge is not a backend, so `executionMode: 'backend'` tools stay gone, and
  // so does every host-callback tool the bridge has no route for.
  it('everything else the filter withheld is still withheld', () => {
    const bridged = codexBridged();
    expect(bridged.has('call_llm')).toBe(false);
    expect(bridged.has('spawn_session')).toBe(false);
    expect(bridged.has('SubmitPlan')).toBe(false);
    expect(bridged.has('EnterWorktree')).toBe(false);
    // `BashOutput` is ProcessStop's sibling on the background-shell half: it has
    // no bridge route and no codex producer, so it stays withheld while
    // `ProcessStop` (monitor half) crosses. This is the pin that keeps
    // ProcessStop-on-codex MONITOR-ONLY.
    expect(bridged.has('BashOutput')).toBe(false);
    expect(SESSION_TOOLS_REQUIRING_HOST_CALLBACK.has('BashOutput')).toBe(true);
    expect(bridged.has('ProcessStop')).toBe(true);
    expect([...bridged].filter(name => !codex().has(name)).sort()).toEqual([...BRIDGED].sort());
  });

  /**
   * P6.184 — `PushNotification` crosses to a BRIDGED codex spawn, and to
   * nothing else.
   *
   * The tool is `visibility: 'pi-only'`, and that marker is LIFTED rather than
   * dropped, because `visibility` is two-valued against a `'pi'`/not-`'pi'`
   * projection: dropping it reaches claude and codex together, and the two are
   * opposite cases. Codex has no notification mechanism the model can reach at
   * all (`push_notification`/`user_notification`/"desktop notification" all 0
   * on both shipped mac binaries, against `notification` 101/147 and
   * `thread/start` 5/5 as controls). Claude ships its OWN `PushNotification`,
   * so a projection there would put two notification tools in front of the
   * model and the ungated one would win — `Monitor`'s recorded defect.
   */
  it('the notification port lifts PushNotification onto a bridged codex spawn', () => {
    // Positive: the spawn as the real subprocess builds it.
    expect(codexNotified().has('PushNotification')).toBe(true);
    // …and it is the ONLY thing the flag adds, so the lift cannot widen the
    // surface sideways while nobody is reading the whole set.
    expect([...codexNotified()].filter(name => !codexBridged().has(name))).toEqual(['PushNotification']);
  });

  it('the notification port cannot reach claude, Pi is unchanged, and the flag is inert without a bridge', () => {
    // NEGATIVE, and the one that matters: claude's in-process surface is built
    // by the unset-projection call, and the flag is ANDed with the bridge —
    // which claude never passes — so even a caller that sets it gets nothing.
    expect([...getSessionToolNames({ notificationPort: true })].sort()).toEqual([...claude()].sort());
    expect(claude().has('PushNotification')).toBe(false);
    // Pi already had the tool and must not gain or lose anything.
    expect(pi().has('PushNotification')).toBe(true);
    expect([...getSessionToolNames({ projection: 'pi', notificationPort: true })].sort())
      .toEqual([...pi()].sort());
    // A bare external spawn with no bridge: the route it would need is not
    // there, so neither is the offer.
    expect([...getSessionToolNames({ externalStandaloneOnly: true, notificationPort: true })].sort())
      .toEqual([...codex()].sort());
  });

  /**
   * P6.137 — the worktree three cross to a BRIDGED codex spawn, and to nothing
   * else.
   *
   * The same lift shape as `PushNotification` above and the same reason the
   * marker is lifted rather than dropped, with the runtimes in the same
   * opposition: codex publishes NO worktree surface at all (`worktree` 0 files
   * in `packages/codex-protocol`, `WorktreeCreate` 0 in the shipped
   * `codex-app-server`, `preToolUse` 3 files as the control), while claude
   * ships its own `EnterWorktree`/`ExitWorktree` WITH its own documented,
   * non-suppressible approval prompt.
   */
  it('the worktree port lifts the three worktree tools onto a bridged codex spawn', () => {
    expect([...codexWorktreed()].filter(name => !codexBridged().has(name)).sort())
      .toEqual(['EnterWorktree', 'ExitWorktree', 'WorktreeBatch']);
  });

  it('the worktree port cannot reach claude, Pi is unchanged, and the flag is inert without a bridge', () => {
    // NEGATIVE, and the one that matters: claude must keep meeting exactly ONE
    // worktree ENTER tool — its own. The flag is ANDed with the bridge, which
    // claude never passes, so even a caller that sets it gets nothing. C3.329
    // did not change this: `WorktreeBatch` reaches claude by having no
    // `visibility` marker at all, never by this flag, which is why this equality
    // still holds with the batch on BOTH sides of it.
    expect([...getSessionToolNames({ worktreePort: true })].sort()).toEqual([...claude()].sort());
    expect(claude().has('EnterWorktree')).toBe(false);
    expect(claude().has('ExitWorktree')).toBe(false);
    // Pi already had all three and must not gain or lose anything.
    expect(pi().has('EnterWorktree')).toBe(true);
    expect([...getSessionToolNames({ projection: 'pi', worktreePort: true })].sort())
      .toEqual([...pi()].sort());
    // A bare external spawn with no bridge: the four routes it would need are
    // not there, and neither is the FLOOR the enter one requires, so the offer
    // is withheld rather than made without a gate behind it.
    expect([...getSessionToolNames({ externalStandaloneOnly: true, worktreePort: true })].sort())
      .toEqual([...codex()].sort());
  });

  /**
   * C3.329 — `WorktreeBatch` reaches all three runtimes, and its two siblings
   * still reach exactly what they reached before.
   *
   * The fan-out is host-side; claude's own PR-opening `/batch` is OFF by this
   * fork's own hand (C3.326, `8d1b5f0ad`, because owner answer QH2 = B is that a
   * person opens the merge requests) and codex has no isolation mechanism to
   * fan out with at all. So the host's is the one batch that reaches everyone,
   * and it is lifted ALONE — claude ships its own enter/exit with its own
   * documented non-suppressible prompt, and ours must not stand beside them.
   */
  it('C3.329 — the batch reaches claude, alone, and the enter/exit pair does not follow it', () => {
    // The whole row, in one line.
    expect(claude().has('WorktreeBatch')).toBe(true);
    expect(pi().has('WorktreeBatch')).toBe(true);
    expect(codexWorktreed().has('WorktreeBatch')).toBe(true);
    // NEGATIVE — the siblings did NOT come with it. This is the half that keeps
    // a claude session from meeting two enter tools of different lease semantics.
    for (const sibling of ['EnterWorktree', 'ExitWorktree']) {
      expect(claude().has(sibling)).toBe(false);
      expect(pi().has(sibling)).toBe(true);
    }
    // NEGATIVE — codex is unchanged in BOTH directions. A bare spawn still gets
    // nothing, and a BRIDGED spawn whose host did not bind the worktree port
    // still gets nothing: the offer rides the route, which is what the dropped
    // `visibility` marker used to enforce on its behalf.
    expect(codex().has('WorktreeBatch')).toBe(false);
    expect(codexBridged().has('WorktreeBatch')).toBe(false);
    // POSITIVE CONTROL that those two surfaces are real and not empty sets.
    expect(codex().has('automation_list')).toBe(true);
    expect(codexBridged().has('Monitor')).toBe(true);
  });

  // The two port flags are independent: neither may drag the other's tools
  // across, or a host that bound one port would advertise a tool with no route.
  it('the two port flags lift disjoint sets', () => {
    expect([...codexNotified()].some(name => SESSION_TOOLS_LIFTED_BY_WORKTREE_NAMES.includes(name))).toBe(false);
    expect(codexWorktreed().has('PushNotification')).toBe(false);
  });

  // The flag means nothing on its own — every other runtime resolves the ports
  // in-process, so it must not be able to widen a non-standalone surface.
  it('the flag is inert without externalStandaloneOnly', () => {
    expect([...getSessionToolNames({ hostCallbackBridge: true })].sort()).toEqual([...claude()].sort());
    expect([...getSessionToolNames({ projection: 'pi', hostCallbackBridge: true })].sort()).toEqual([...pi()].sort());
  });

  // The routes and the tools are maintained in two files; this is the join.
  // The mismatch is per-tool rather than uniform:
  // `ScheduleWakeup` needs two (rearm and stop); `monitorStop` serves BOTH
  // `Monitor`'s port `stop` and `ProcessStop`'s monitor half (P3.10) — the
  // once-orphaned route; and `Goal` alone needs two of P2.2's three
  // (`goal/set` and `goal/clear`), because its port takes the action in the
  // payload and the routes split it by effect, `GoalGet` taking `goal/get`.
  // `agentMessageSend` is one route for one tool, and the SECOND that carries a
  // bound closure rather than a port (`advisorConsult` is the first).
  it('the bridge has a route set the bridged tools can be served from', () => {
    expect(Object.keys(HOST_CALLBACK_BRIDGE_ROUTES).sort()).toEqual([
      'advisorConsult', 'agentMessageSend',
      // UA1.18 — the t-artifacts pair: one route per tool, both carrying a bound host closure; the publish route's far
      // side raises the card.
      'artifactList', 'artifactPublish',
      // P6.295 arm (2) — `CronControl` needs THREE, one per port method
      // (`setPaused`, `runNow`, `acknowledgeRuns`), so the per-tool mismatch
      // above gains its largest entry: one tool, three routes.
      'cronAcknowledgeRuns', 'cronCreate', 'cronList', 'cronRearmWakeup', 'cronRemove',
      'cronRunNow', 'cronSetPaused', 'cronStopWakeup',
      // UB6.11 — `decide`, the fourth port-gated-bridged route (its far side the bound `ctx.decide` closure).
      'decide',
      'goalClear', 'goalGet', 'goalSet', 'monitorStart', 'monitorStop',
      // P6.184 — `notificationPush`, the seventh route whose tool is gated a
      // second time, and the only one added because the far-side RUNTIME has no
      // mechanism of its own rather than because ours is better.
      'notificationPush',
      // UA6.3 — the six page tools: one route per `PagesToolCallbacks` member, the far side the bound `pages` closure.
      'pageCreate', 'pageDelete', 'pageGet', 'pageList', 'pageUpdate', 'pageWriteData',
      // P3.276 — the host-computed review diff. Fifth route carrying a bound
      // host closure rather than a `SessionToolContext` port, and the only one
      // whose tool is gated a second time (`reviewDiffPort`), so registering the
      // route and advertising the tool cannot come apart.
      // UB1.12 — `project_memory_append`: one route, its far side the bound `appendProjectMemoryFn` closure
      // (sorted position: this list is compared to `Object.keys(...).sort()`).
      'projectMemoryAppend',
      'reviewDiff',
      // P3.222 — the roster pair, the third and fourth routes carrying a bound
      // host closure rather than a `SessionToolContext` port.
      // P6.466 — `sessionArchive`, the sixth bound-closure route and the only
      // one whose far side raises a permission card of its own.
      'sessionArchive', 'sessionInfo', 'sessionList',
      // UA1.3 — the self-management pair: TWO routes per tool, one per `SessionToolContext` member (resolve, set),
      // the rule the cron routes follow, so the codex handler resolves and refuses exactly as on Pi and Claude.
      'sessionResolveLabels', 'sessionResolveStatus', 'sessionSetLabels', 'sessionSetStatus',
      // UB7.11 — the MCP prompt pair: one route per `McpSourceToolCallbacks` member, the far side the bound
      // `mcpSources` closure (sorted position: this list is compared to `Object.keys(...).sort()`).
      'sourceGetPrompt', 'sourceListPrompts',
      // UA3.5 — `create_board_task`: one route, its far side the bound `createBoardTaskFn` closure.
      'taskCreate',
      // P6.137 — the worktree family: FOUR routes for three tools, the largest
      // per-tool spread after `CronControl`'s three. `EnterWorktree` and
      // `ExitWorktree` take one each, `WorktreeBatch` takes `worktreeBatch`,
      // and `worktreeList` serves the port's `list` member, which no tool on
      // this surface calls yet but which `SessionWorktreePort` requires — a
      // client built from a partial port would be the only bridged port
      // NARROWER than the in-process one, which is the defect P6.295 arm (2)
      // measured for `CronControl`.
      'worktreeBatch', 'worktreeEnter', 'worktreeExit', 'worktreeList',
    ]);
    // Injectivity — no two route keys serve the same target — stated against
    // the key list this case already pins WHOLE, one line up, rather than
    // against a literal that has to be edited in step with it (P6.907).
    expect(new Set(Object.values(HOST_CALLBACK_BRIDGE_ROUTES)).size)
      .toBe(Object.keys(HOST_CALLBACK_BRIDGE_ROUTES).length);
    // The two mutating goal routes partition the `Goal` schema's six actions —
    // no action is servable by both routes and none is servable by neither, so
    // a new action added to the tool fails HERE rather than reaching a client
    // that silently posts it to `goal/set`.
    const actions = GoalSchema.options.map(option => option.shape.action.value).sort();
    expect([
      ...HOST_CALLBACK_BRIDGE_GOAL_ACTIONS.set,
      ...HOST_CALLBACK_BRIDGE_GOAL_ACTIONS.clear,
    ].sort()).toEqual(actions);
    expect(HOST_CALLBACK_BRIDGE_GOAL_ACTIONS.set
      .some(action => (HOST_CALLBACK_BRIDGE_GOAL_ACTIONS.clear as readonly string[]).includes(action))).toBe(false);
  });

  it('the bridged Codex surface is the bare one plus exactly the bridged set', () => {
    // The DIFFERENCE is what this case is about, and every movement it has seen
    // moved both counts together: P6.303 (1) took the host `TodoWrite` off both
    // (an external standalone runtime ships its own `update_plan`), and P6.148
    // put the host `web_search` on both (codex's own is written `disabled`
    // bar the ChatGPT card, F1.570, and this one needs no bridge). A subtraction applied to
    // one surface and not the other is what would show here.
    //
    // P6.907 — the absolute `27`, then `29`, is gone: it was a second copy of a
    // surface size that is pinned where it is DERIVED (the regenerated
    // `tool-surface.json` fixture, and `runtime-switch-costs-surface-counts.test.ts`,
    // which reads `getSessionToolNames` live). Stated as the whole set instead,
    // which a size difference cannot do — two names swapping sides leave it alone.
    expect([...codexBridged()].filter(name => !codex().has(name)).sort()).toEqual([...BRIDGED].sort());
    expect(codexBridged().size - codex().size).toBe(BRIDGED.length);
  });
});

// UB6.11 — the decide tool: the port-gated-bridged structure's fourth member
// (after ReviewDiff, PushNotification and the worktree three), and the one whose
// offer flag the codex spawn itself derives (`--decide-port`, emitted beside the
// bridge port only when the decision layer is configured — the sync, local read
// `SessionManager.decisionFeatureActive` makes at binding time, so the offer and
// the port cannot disagree by more than one respawn).
describe('UB6.11 — decide is port-gated on every surface', () => {
  const codexDecided = () => getSessionToolNames({
    externalStandaloneOnly: true,
    hostCallbackBridge: true,
    decidePort: true,
  });
  const piDecided = () => getSessionToolNames({ projection: 'pi', decidePort: true });
  const claudeDecided = () => getSessionToolNames({ decidePort: true });

  it('absent at the default flags on all five surfaces (the pins do not move)', () => {
    for (const surface of [pi(), claude(), codex(), codexBridged()]) {
      expect(surface.has('decide')).toBe(false);
    }
  });

  it('offered with the port, beside the bridge on codex and in-process on pi and claude', () => {
    expect(codexDecided().has('decide')).toBe(true);
    expect(piDecided().has('decide')).toBe(true);
    expect(claudeDecided().has('decide')).toBe(true);
    expect(codexDecided().size - codexBridged().size).toBe(1);
    expect(piDecided().size - pi().size).toBe(1);
    expect(claudeDecided().size - claude().size).toBe(1);
  });

  it('the port flag is inert without the bridge on an external spawn', () => {
    const portOnly = getSessionToolNames({ externalStandaloneOnly: true, decidePort: true });
    expect(portOnly.has('decide')).toBe(false);
    expect([...portOnly].sort()).toEqual([...codex()].sort());
  });

  it('membership: decide is in the bridged set and in PORT_GATED_BRIDGED', () => {
    expect(SESSION_TOOLS_BRIDGED_BY_HOST_CALLBACK.has('decide')).toBe(true);
    expect(SESSION_TOOLS_REQUIRING_HOST_CALLBACK.has('decide')).toBe(true);
    expect(PORT_GATED_BRIDGED).toContain('decide');
  });
});

describe('P3.13 — the advisor consult crosses on its OWN flag, and only with both', () => {
  const ADVISOR = 'advisor_consult';

  // The row's subject. `advisor_consult` is `executionMode: 'backend'`, which is
  // the line the eight bridged port tools never lifted, so this is the ONE tool
  // whose presence proves the second flag is wired rather than ignored.
  it('is on the Codex surface only when the bridge AND the advisor flag are both set', () => {
    expect(codex().has(ADVISOR)).toBe(false);
    expect(codexBridged().has(ADVISOR)).toBe(false);
    expect(codexAdvised().has(ADVISOR)).toBe(true);
  });

  // The flag cannot lift anything by itself: its route lives on the bridge, so a
  // spawn that claimed the advisor with no bridge would advertise a tool whose
  // call has nowhere to land. Measured through the enforcement site, not the AND.
  it('the advisor flag is inert without a bridge', () => {
    const advisorOnly = getSessionToolNames({ externalStandaloneOnly: true, advisorConsultBridge: true });
    expect(advisorOnly.has(ADVISOR)).toBe(false);
    expect([...advisorOnly].sort()).toEqual([...codex()].sort());
  });

  // ...and it is inert on every non-standalone surface, exactly as the bridge
  // flag is: pi and claude bind the consult in-process and are governed by the
  // HOST setting, which this package cannot read and must not appear to.
  it('the advisor flag is inert without externalStandaloneOnly', () => {
    expect([...getSessionToolNames({ hostCallbackBridge: true, advisorConsultBridge: true })].sort())
      .toEqual([...claude()].sort());
    expect([...getSessionToolNames({ projection: 'pi', hostCallbackBridge: true, advisorConsultBridge: true })].sort())
      .toEqual([...pi()].sort());
  });

  // The delta is exactly one tool — the flag must not drag a second backend tool
  // across with it. `call_llm` and `spawn_session` are the positive control: they
  // are `executionMode: 'backend'` too and stay gone.
  it('the flag moves exactly advisor_consult — the other backend tools stay withheld', () => {
    expect([...codexAdvised()].filter(name => !codexBridged().has(name))).toEqual([ADVISOR]);
    // The absolute size that stood here (29 until P6.303 (1) withheld the host
    // `TodoWrite` from both codex surfaces, 30 since P6.148 put the host
    // `web_search` on every one) is gone with P6.907: the DELTA on the line
    // above is what this case is about, it is strictly stronger than a count,
    // and the count itself was a second copy of a surface pinned elsewhere.
    expect(codexAdvised().has('call_llm')).toBe(false);
    expect(codexAdvised().has('spawn_session')).toBe(false);
    expect(codexAdvised().has('browser_tool')).toBe(false);
  });

  // The two bridged sets are maintained separately and answer different
  // questions; both live INSIDE the host-callback set, which is what makes the
  // "single source of truth for the split" claim survive a second lifting flag.
  it('the backend-bridged set is advisor_consult alone, inside the host-callback set', () => {
    expect([...SESSION_BACKEND_TOOLS_BRIDGED_BY_HOST_CALLBACK]).toEqual([ADVISOR]);
    for (const name of SESSION_BACKEND_TOOLS_BRIDGED_BY_HOST_CALLBACK) {
      expect(SESSION_TOOLS_REQUIRING_HOST_CALLBACK.has(name)).toBe(true);
      expect(SESSION_TOOLS_BRIDGED_BY_HOST_CALLBACK.has(name)).toBe(false);
    }
  });
});

describe('externalStandaloneOnly with NO bridge still excludes all six', () => {
  it.each(BRIDGED)('%s is absent from the Codex surface', name => {
    expect(codex().has(name)).toBe(false);
  });

  // ...and absent for the RIGHT reason. The exclusion has to come from the
  // host-callback set, because that is the one the bridge lifts; an accidental
  // exclusion (a stray executionMode, say) would pass the row above while
  // hiding whether the bridge flag does anything.
  it.each(BRIDGED)('%s is excluded by the host-callback set, not by accident', name => {
    expect(SESSION_TOOLS_REQUIRING_HOST_CALLBACK.has(name)).toBe(true);
  });

  // The set is the "single source of truth for the split" (tool-defs.ts), and
  // the split is derivable two ways: the codex surface must be exactly the
  // default registry surface minus the set. The four cron tools joining the set
  // is what keeps this equality true after the projection widened.
  //
  // P6.303 (1) added the SECOND subtrahend, and it is written as a second named
  // set rather than folded into the first because the two mean different things:
  // the host-callback set is "the call has nowhere to land here", and
  // `SESSION_TOOLS_WITHHELD_FOR_NATIVE_EQUIVALENT` is "the runtime already does
  // this itself". Only the first is lifted by the bridge, which is why merging
  // them would quietly hand `TodoWrite` back to a bridged codex session.
  it('codex surface = default registry tools minus the two named exclusions', () => {
    const expected = [...getSessionRegistryToolNames()]
      .filter(name => !SESSION_TOOLS_REQUIRING_HOST_CALLBACK.has(name))
      .filter(name => !SESSION_TOOLS_WITHHELD_FOR_NATIVE_EQUIVALENT.has(name))
      .sort();
    expect([...codex()].sort()).toEqual(expected);
    // The two sets are disjoint — the property that makes the two filters above
    // independent rather than one written twice.
    expect([...SESSION_TOOLS_WITHHELD_FOR_NATIVE_EQUIVALENT]
      .filter(name => SESSION_TOOLS_REQUIRING_HOST_CALLBACK.has(name))).toEqual([]);
  });
});

describe('safeMode follows the projection', () => {
  // `CronList` is `safeMode: 'allow', readOnly: true`; the other four are
  // `block`. The read-only allowlist on a Claude session resolves them through the
  // same metadata a Pi session does — `mode-manager` reads this helper by
  // prefix, so the projection change lands there with no second decision.
  it('CronList is the only one of the five the read-only allowlist (Plan, Don\'t ask) allows', () => {
    const allowed = getSessionSafeAllowedToolNames({ prefix: 'mcp__session__' });
    expect(allowed.has('mcp__session__CronList')).toBe(true);
    for (const name of ['Monitor', 'CronCreate', 'CronDelete', 'ScheduleWakeup']) {
      expect(allowed.has(`mcp__session__${name}`)).toBe(false);
    }
  });
});

describe('the projections, stated as SETS — the sizes live where they are derived', () => {
  /**
   * THE ABSOLUTE COUNTS ARE GONE (P6.907, 2026-09-08). They read
   * `57 / 48 / 16` behind a case title that still said `15`, which is the whole
   * defect in one line: a hand-maintained copy of a surface size can only ever
   * disagree with the surface, and it disagreed with the assertion three lines
   * under it.
   *
   * This block's stated job was to keep `runtime-switch-costs.ts`'s PROSE
   * honest — it opened with "getSessionToolNames returns 54 names under
   * `projection: 'pi'`, 46 with no projection (Claude) and 18 under
   * `externalStandaloneOnly` (Codex)". That job now belongs to
   * `apps/electron/…/__tests__/runtime-switch-costs-surface-counts.test.ts`,
   * which is the instrument this block never was: it calls
   * `getSessionToolNames` LIVE and matches the derived numbers against that
   * file's own sentences, so a prose copy cannot drift and no literal is
   * transcribed on either side. The absolute NAMES stay pinned by the
   * regenerated `tool-surface.json` fixture behind `check:surface --pin`.
   *
   * The forcing function the old comment claimed for itself — "a tool added to
   * the registry SHOULD fail this test and make its author state which surfaces
   * it lands on" — survives, and lands somewhere better: the author must write
   * the new number into a SENTENCE a human reads, not into a literal beside an
   * assertion.
   *
   * The history below is kept as history: every transition it records is a true
   * statement about a past reading.
   *
   * P2.1 moved Pi 53 → 54 and Claude 43 → 44, by exactly one tool:
   * `advisor_consult`. Codex was unchanged at 18 — the consult runs on
   * `BaseAgent.queryLlm`, which an external standalone subprocess does not
   * have, so it is excluded by the same `executionMode: 'backend'` line that
   * excludes `call_llm`.
   *
   * P2.2 then moved Claude 44 → 46 by exactly two: `GoalGet` and `Goal` left
   * `pi-only`. Pi is unchanged — it already advertised both — and the UNBRIDGED
   * Codex count is unchanged too, because the pair depends on a host callback
   * and only the bridged surface lifts that exclusion (24 → 26, one block up).
   *
   * P3.222 moved the UNBRIDGED Codex count 18 → 16 and left the other two alone.
   * The direction is the unusual part and the reason is measured, not stylistic:
   * `list_sessions` and `get_session_info` were never withheld from codex, and
   * were never bound there either, so a codex session was OFFERED two tools that
   * answered "not available in this context" on every call. Joining the two
   * host-callback sets makes the bare surface honest and the bridged one real.
   */
  it('the bare Codex surface withholds every host-callback tool and gains exactly the host web_search', () => {
    // The history the three counts used to carry, kept because each line is a
    // true statement about a past reading: P6.466 moved Pi 54 → 55 and Claude
    // 46 → 47 by one (`archive_session`), P6.295 arm (2) moved both by one more
    // (`CronControl`), and P6.508 moved Pi alone (`WorktreeBatch`,
    // `visibility: 'pi-only'`). Each left the BARE codex count alone for one
    // reason: the tool is in the host-callback set, so it is withheld from an
    // unbridged subprocess and comes back over the bridge.
    //
    // P3.222 moved the BARE codex surface 18 → 16 by withdrawing two tools that
    // could only ever answer "not available in this context" there. Nothing a
    // codex session could DO changed; two dishonest offers went away, and both
    // come back real over the bridge. P6.303 (1) then moved it 16 → 15 the same
    // way, withdrawing `TodoWrite`, which a codex session does not need because
    // it writes its plan with `update_plan` onto the same two host views since
    // P3.295 — the AMBIGUITY of two checklists went away, not a capability.
    // Claude keeps it, having no native equivalent, which is why that one is
    // `SESSION_TOOLS_WITHHELD_FOR_NATIVE_EQUIVALENT` and not `pi-only`.
    const claudeNames = claude();
    const codexNames = codex();
    // P6.148 is the first movement in the other direction, and it is the ONE
    // name the bare codex surface has that the default claude projection does
    // not: the host's own `web_search`, offered because codex's native one
    // executes on OpenAI's backend the local adapter never reaches and is
    // written `disabled` bar the ChatGPT card (F1.570). A registry tool needing no host port,
    // so it lands on the BARE surface rather than the bridged one.
    expect([...codexNames].filter(name => !claudeNames.has(name))).toEqual(['web_search']);
    // …and nothing that needs a host callback survives the bare filter, which
    // is the property the three counts were standing in for.
    expect([...codexNames].filter(name => SESSION_TOOLS_REQUIRING_HOST_CALLBACK.has(name))).toEqual([]);
    // Positive control, so the line above is a measurement and not a statement
    // about an empty set: both other projections do carry host-callback tools.
    expect([...pi()].some(name => SESSION_TOOLS_REQUIRING_HOST_CALLBACK.has(name))).toBe(true);
    expect([...claudeNames].some(name => SESSION_TOOLS_REQUIRING_HOST_CALLBACK.has(name))).toBe(true);
  });

  // P2.1 — the per-runtime projection decision, stated as three assertions
  // rather than left implicit in the counts above.
  it('advisor_consult is on Pi and Claude, and off Codex even with the bridge', () => {
    expect(pi().has('advisor_consult')).toBe(true);
    expect(claude().has('advisor_consult')).toBe(true);
    expect(codex().has('advisor_consult')).toBe(false);
    // A bridge moves a host PORT; it does not give an external subprocess a
    // backend, so the bridge flag cannot lift this one.
    expect(codexBridged().has('advisor_consult')).toBe(false);
    expect(SESSION_TOOLS_BRIDGED_BY_HOST_CALLBACK.has('advisor_consult')).toBe(false);
  });

  // The Claude surface's growth is exactly these seven and nothing else — the
  // relation that makes the absolute numbers above meaningful rather than
  // merely current. Containment is stated at its real strength: pi ⊇ (claude
  // minus the legacy checklist pair), because `TodoWrite`/`Task` leave the PI
  // surface when the task tools are on and only there. None of the seven is in
  // that pair, so the projection change does not touch the exception.
  it('Claude gained exactly the projected six and the goal pair, and Pi still contains the rest of its surface', () => {
    const claudeNames = claude();
    const piNames = pi();
    const gained = [...PROJECTED, ...GOAL_PROJECTED].filter(name => claudeNames.has(name));
    // Stated as the whole list rather than its length (P6.907): a count of 8 is
    // also what six projected names plus two strangers would give.
    expect(gained).toEqual([...PROJECTED, ...GOAL_PROJECTED]);
    // The gap to codex used to be written here as a size DIFFERENCE — 25 before
    // P2.1, then 26, 28, 30, 31, 32, 33 as `advisor_consult`, the goal pair,
    // P3.222's roster removal, `archive_session`, `TodoWrite`'s withdrawal and
    // `CronControl` moved it, and 32 again once P6.148 put the host
    // `web_search` on codex and not on the default claude projection.
    //
    // P6.907 replaces it with the whole set, and the replacement is not
    // cosmetic: `claude.size - codex.size` is 32 while `claude \ codex` holds
    // 33, because the two surfaces are NOT nested — `web_search` sits on the
    // codex side of a difference the subtraction silently netted out. The
    // derivation below is the same one `codex surface = default registry tools
    // minus the two named exclusions` uses, read from the claude side.
    const codexNames = codex();
    expect([...claudeNames].filter(name => !codexNames.has(name)).sort()).toEqual(
      [...claudeNames].filter(name =>
        !getSessionRegistryToolNames().has(name)
        || SESSION_TOOLS_REQUIRING_HOST_CALLBACK.has(name)
        || SESSION_TOOLS_WITHHELD_FOR_NATIVE_EQUIVALENT.has(name)).sort(),
    );
    // The other direction, stated so the pair cannot hide a name moving across:
    // the host `web_search` is the whole of it.
    expect([...codexNames].filter(name => !claudeNames.has(name))).toEqual(['web_search']);
    expect([...claudeNames].filter(name => !piNames.has(name) && !LEGACY_TASK_TOOL_NAMES.has(name))).toEqual([]);
    // Positive control for the carve-out: it is the documented pair and not a
    // hole this row is widening.
    expect([...claudeNames].filter(name => !piNames.has(name))).toEqual(['TodoWrite']);
  });

  /**
   * D1.185, 2026-09-17 — the tripwire for the prose that lives in another
   * package.
   *
   * ## What this catches, measured three times
   *
   * `apps/electron/src/renderer/components/app-shell/input/runtime-switch-costs.ts`
   * transcribes these four sizes into its header, and the transcription has gone
   * stale three times: P3.222 took the bare codex surface 18 → 16 and four prose
   * copies did not move; `6173c9778` moved the fourth and fifth; C3.329
   * (`b6b8e1be1`) lifted `WorktreeBatch` off `pi-only` and the claude surface
   * went 48 → 49. The third time a test DID catch it — but the test is
   * `runtime-switch-costs-surface-counts.test.ts`, in `apps/electron`, and a lane
   * editing `tool-defs.ts` has no reason to run a renderer suite. So the red
   * arrived after the commit that caused it, which is the whole of D1.185.
   *
   * ## Why a tripwire here rather than a gate line
   *
   * The row's other option is to chain that renderer suite into this package's
   * own `typecheck` script. Declined, with the reason stated rather than left
   * implicit: `typecheck:session-tools-core` is a step of `typecheck:chain`, so
   * the suite would run a `bun test` inside a `typecheck:all` that may already be
   * running beside a `bun test` (AGENTS.md §Traps — two concurrent `bun test`
   * processes manufacture failures), and `check-typecheck-coverage.ts` parses
   * that script's shape. This costs neither.
   *
   * ## Why ONE tuple and not a second copy of the renderer suite
   *
   * That suite asserts four propositions about the prose; re-deriving its
   * historical-line filter here would be a copy that can drift from the original.
   * This is the single spelling that no historical sentence can wear — the pin
   * tuple the header quotes from THIS file — so it fires on any of the four
   * moving, with no filter to keep in step. Both sides are derived, so neither
   * can go stale on its own.
   */
  it('the renderer header still quotes these four sizes — D1.185 tripwire', () => {
    const header = readFileSync(
      fileURLToPath(new URL(
        '../../../apps/electron/src/renderer/components/app-shell/input/runtime-switch-costs.ts',
        import.meta.url,
      )),
      'utf8',
    );
    // The probe reads the real module, not an empty string: its own name is the
    // positive control, so a moved or renamed file fails here rather than
    // passing vacuously.
    expect(header, 'the renderer module was not read').toContain('runtime-switch-costs-surface-counts.test.ts');

    const tuple = `(${pi().size} / ${claude().size} / ${codex().size} / ${codexBridged().size} /`;
    expect(
      header,
      `the renderer header does not quote ${tuple} — a projection changed here and the prose in `
      + '`apps/electron/src/renderer/components/app-shell/input/runtime-switch-costs.ts` did not move with it. '
      + 'Re-read that header and run `runtime-switch-costs-surface-counts.test.ts`, which checks the rest of it.',
    ).toContain(tuple);
  });
});
