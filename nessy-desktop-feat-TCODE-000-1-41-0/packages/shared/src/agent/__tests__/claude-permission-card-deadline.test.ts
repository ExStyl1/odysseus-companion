/**
 * F1.76 (origin D1.373) — an unanswered PreToolUse card must be bounded by the
 * HOST, and the sentence the model reads must say what actually happened.
 *
 * ## The defect, measured
 *
 * `claude-agent.ts`'s `case 'prompt'` branch published the card and then awaited
 * `permissionPromise` with no deadline of its own. Nobody clicks, and the only
 * thing that ends the wait is the SDK's own per-hook backstop: WI-bd measured
 * **602 965 ms** in SIT-5e's leftover claude session, after which the tool row
 * ended `isError: true` carrying the vendored binary's sentence — *"PreToolUse
 * hook did not respond before its timeout (host client may be unreachable). The
 * tool call was not executed"* — while the session record still carried the
 * `pendingApproval` for a `tool_use_id` nothing could run any more. Two lies in
 * one turn: the model is told the transport is broken when the truth is that
 * nobody clicked, and the user keeps an Allow button that buys nothing.
 *
 * ## Native-first, asked and answered
 *
 * The runtime HAS a knob: `HookCallbackMatcher.timeout` (seconds) at
 * `sdk.d.ts:868`, honoured by the shipped binary (`hn.timeout?hn.timeout*1000:_`
 * inside the per-hook dispatch, with `_` defaulting to `var Li=600000` — one
 * occurrence, `grep -aoF … | wc -l` over the vendored darwin-arm64 `claude` at
 * `2.1.251`, 2026-09-20; both SDK self-reports agree on that version). That
 * 600 000 ms IS the row's "~603 s". It is measured and INSUFFICIENT, not
 * unexamined: the knob is per-MATCHER, so lowering it would also bound the fast
 * allow/deny path that never raises a card; its sentence is a frozen build
 * constant that blames the transport; and it withdraws no card. So the honest
 * shape is a host deadline strictly shorter than the SDK's, our own sentence,
 * and the cancellation event the host already routes.
 *
 * ## What this suite can and cannot prove
 *
 * The producer of the card lives inside the SDK query loop and cannot be reached
 * without a running child — `session-whitelist-key-per-card-type.test.ts` says
 * the same of the same branch. So the WAIT is driven here directly, with the
 * agent's REAL `pendingPermissions` map, a REAL `ClaudeTurnSlot` and the REAL
 * `respondToPermission`; that the branch calls it is a source-text arm at the
 * bottom, bounded by `bracedRegion` with a control declared below the anchor.
 * The SDK's own interpretation of the deny payload runs in the native binary and
 * belongs to the live case in the ASK.
 */
import { afterEach, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AgentEvent } from '@nessy-agent/core/types';
import { ClaudeAgent } from '../claude-agent.ts';
import type { BackendConfig } from '../backend/types.ts';
import { ClaudeTurnSlot } from '../backend/claude/turn-slot.ts';
import { bracedRegion } from '../../testing/source-regions.ts';
import {
  CLAUDE_PERMISSION_CARD_DEADLINE_MS,
  awaitClaudePermissionCardAnswer,
  claudePermissionCardTimeoutNotice,
  type ClaudePermissionCardAnswer,
  type ClaudePermissionCardWait,
} from '../backend/claude/permission-card-deadline.ts';

// Importing `claude-agent.ts` is this file's whole wall-clock cost; the cases
// themselves are milliseconds. Sized against the file, not against a case, for
// the reason AGENTS.md gives about a module-graph red wearing a test's name.
setDefaultTimeout(120_000);

/**
 * The SDK's own sentence, verbatim from the vendored binary (2 occurrences,
 * `grep -aoF … | wc -l`, 2026-09-20). It is the POSITIVE CONTROL for the
 * negative assertion below: it proves the needle is spellable and that
 * `toContain` reads, so `not.toContain` on our sentence means something.
 */
const SDK_TIMEOUT_SENTENCE =
  'PreToolUse hook did not respond before its timeout (host client may be unreachable). '
  + 'The tool call was not executed; other configured hooks may not have completed.';

/** The needle that must never appear in a sentence WE write. */
const TRANSPORT_BLAME = 'host client may be unreachable';

/**
 * `awaitClaudePermissionCardAnswer`'s shape as `claude-agent.ts` had it at
 * `edbc4c4fa`: the bare `const allowed = await permissionPromise;`. Kept as a
 * permanent negative control — the three properties below are asserted to FAIL
 * against it, so no future refactor can satisfy this suite by removing the
 * deadline again.
 */
const PRE_F1_76_AWAIT = async (
  options: ClaudePermissionCardWait,
): Promise<ClaudePermissionCardAnswer> => ({ answered: true, allowed: await options.wait });

interface Internals {
  pendingPermissions: Map<string, Record<string, unknown>>;
  respondToPermission: (requestId: string, allowed: boolean, alwaysAllow?: boolean) => void;
  permissionManager: { getBaseCommand: (command: string) => string };
}

const agents: ClaudeAgent[] = [];
afterEach(() => { for (const agent of agents.splice(0)) agent.destroy(); });

/**
 * One card, registered exactly as the PreToolUse producer registers it, on a
 * real agent with a real open turn slot.
 */
function card(toolName = 'Bash', command = 'rm -rf /tmp/f176') {
  const root = mkdtempSync(join(tmpdir(), 'f176-agent-'));
  const agent = new ClaudeAgent({
    provider: 'anthropic',
    providerType: 'anthropic',
    model: 'claude-sonnet-4-6',
    isHeadless: true,
    skipConfigWatcher: true,
    workspace: {
      id: 'ws-f176', name: 'F176', rootPath: root,
      workspaceRootPath: root, sessionRootPath: join(root, 'sessions'),
    } as never,
    session: { id: 'sess-f176', createdAt: Date.now(), lastUsedAt: Date.now(), workingDirectory: root } as never,
  } as BackendConfig);
  agents.push(agent);
  // The fixture's runtime is asserted rather than assumed: a test whose arms
  // silently measure some other backend is the 2026-09-20 trap one file over.
  expect(agent).toBeInstanceOf(ClaudeAgent);

  const internals = agent as unknown as Internals;
  const requestId = 'perm-toolu_f176';
  const wait = new Promise<boolean>(resolve => {
    internals.pendingPermissions.set(requestId, {
      resolve,
      toolName,
      command,
      baseCommand: internals.permissionManager.getBaseCommand(command),
    });
  });

  const slot = new ClaudeTurnSlot({
    userMessage: 'delete the scratch dir',
    isRetry: false,
    wasResuming: false,
    attemptedBranchCutoff: false,
    metadataSessionDir: root,
  });
  const seen: AgentEvent[] = [];
  const reader = (async () => { for await (const event of slot.drain()) seen.push(event); })();

  const options: ClaudePermissionCardWait = {
    wait, requestId, toolName, pending: internals.pendingPermissions, slot, budgetMs: 40,
  };
  const finish = async () => { slot.close('terminal'); await reader; };
  return { agent, internals, requestId, options, seen, finish };
}

describe('F1.76 — the host bounds the wait', () => {
  it('(a) the deadline fires, and the sentence says nobody clicked — never that the host is unreachable', async () => {
    const rig = card();
    const answer = await awaitClaudePermissionCardAnswer(rig.options);
    await rig.finish();

    expect(answer.answered).toBe(false);
    const notice = answer.answered ? '' : answer.notice;
    expect(notice).toContain('Bash');
    expect(notice.toLowerCase()).toContain('answer');
    // The claim, and its positive control on the same instrument directly below.
    expect(notice).not.toContain(TRANSPORT_BLAME);
    expect(SDK_TIMEOUT_SENTENCE).toContain(TRANSPORT_BLAME);
  });

  it('(b) the card is WITHDRAWN: the pending entry is gone and exactly one cancellation reached the turn', async () => {
    const rig = card();
    await awaitClaudePermissionCardAnswer(rig.options);
    await rig.finish();

    expect(rig.internals.pendingPermissions.has(rig.requestId)).toBe(false);
    expect(rig.seen).toEqual([
      { type: 'permission_request_cancelled', requestId: rig.requestId },
    ]);
  });

  it('control — an answered card inside the budget still runs the tool, and withdraws nothing', async () => {
    const rig = card();
    const answered = awaitClaudePermissionCardAnswer(rig.options);
    rig.internals.respondToPermission(rig.requestId, true);
    const answer = await answered;
    await rig.finish();

    expect(answer).toEqual({ answered: true, allowed: true });
    // `respondToPermission` owns the removal on the answered path, and it did it.
    expect(rig.internals.pendingPermissions.has(rig.requestId)).toBe(false);
    expect(rig.seen).toEqual([]);
  });

  it('control — a click that arrives AFTER the deadline is a no-op that throws nothing', async () => {
    const rig = card();
    const answer = await awaitClaudePermissionCardAnswer(rig.options);
    expect(answer.answered).toBe(false);
    expect(() => rig.internals.respondToPermission(rig.requestId, true)).not.toThrow();
    await rig.finish();
    // Still exactly one cancellation — the late click added nothing.
    expect(rig.seen).toHaveLength(1);
  });

  it('the BEFORE-state, verbatim: all three properties fail without the deadline', async () => {
    const rig = card();
    const sentinel = Symbol('never');
    const raced = await Promise.race([
      PRE_F1_76_AWAIT(rig.options),
      new Promise<symbol>(resolve => setTimeout(() => resolve(sentinel), 400)),
    ]);
    await rig.finish();

    expect(raced).toBe(sentinel);                                        // it never settles
    expect(rig.internals.pendingPermissions.has(rig.requestId)).toBe(true); // the card stays
    expect(rig.seen).toEqual([]);                                        // nothing is withdrawn
  });
});

describe('F1.76 — the budget, and the call site that uses it', () => {
  /**
   * The SDK's default hook-callback budget. Read from the vendored binary rather
   * than from a page: `grep -aoF 'var Li=600000' <claude>` → 1 occurrence at
   * `2.1.251` (2026-09-20), inside the per-hook dispatch `hn.timeout?hn.timeout*1000:_`.
   * Pinned here with its instrument and its date because our budget only means
   * anything while it WINS this race.
   */
  const SDK_DEFAULT_HOOK_CALLBACK_BUDGET_MS = 600_000;

  it('is strictly below the SDK backstop it has to win against', () => {
    expect(CLAUDE_PERMISSION_CARD_DEADLINE_MS).toBeLessThan(SDK_DEFAULT_HOOK_CALLBACK_BUDGET_MS);
    expect(CLAUDE_PERMISSION_CARD_DEADLINE_MS).toBeGreaterThan(60_000);
  });

  it('the knob the SDK does declare is still declared — native-first, re-checked', () => {
    const sdkEntry = Bun.resolveSync('@anthropic-ai/claude-agent-sdk', import.meta.dir);
    const typings = readFileSync(`${sdkEntry.slice(0, sdkEntry.lastIndexOf('/'))}/sdk.d.ts`, 'utf8');
    expect(typings).toContain('Timeout in seconds for all hooks in this matcher');
  });

  it('renders a budget a person can read, at both scales', () => {
    expect(claudePermissionCardTimeoutNotice('Bash', 540_000)).toContain('9 minutes');
    expect(claudePermissionCardTimeoutNotice('Bash', 60_000)).toContain('1 minute');
    expect(claudePermissionCardTimeoutNotice('Bash', 40)).toContain('40 ms');
  });

  it("the call site uses it — `case 'prompt'` no longer bare-awaits the permission promise", () => {
    const source = readFileSync(new URL('../claude-agent.ts', import.meta.url), 'utf8');
    const branch = bracedRegion(source, source.indexOf("case 'prompt': {"));

    expect(branch).toContain('awaitClaudePermissionCardAnswer(');
    // Boundary control, declared BELOW the anchor so a runaway region is caught:
    // `this.queueDegradationNotice(` occurs inside `chatImpl` well past this
    // branch's closing brace, and its LAST occurrence in the file is later still.
    expect(branch).not.toContain('this.queueDegradationNotice(');

    // F1.172 — the pre-fix await, asserted over the WHOLE FILE instead of over
    // the region. Inside the region it could never fail: a brace scan runs only
    // FORWARD from the anchor, every occurrence of this needle sat above it, and
    // after F1.76 the file cannot spell it at all — the two shapes AGENTS.md
    // names (a control that cannot fail, WI-s / D1.111; a negative needle the
    // corpus cannot spell) meeting in one line, which `lint:braced-region-controls`
    // refuses. Over the file the absence is a real reading, and the line below is
    // its positive control: the identifier IS still spellable here, so
    // `toContain` is known to read before `not.toContain` is believed.
    expect(source).not.toContain('await permissionPromise');
    expect(source).toContain('const permissionPromise = new Promise');
  });
});
