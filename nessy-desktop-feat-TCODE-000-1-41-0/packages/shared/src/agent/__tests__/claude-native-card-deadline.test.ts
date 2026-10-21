/**
 * F1.169 (origin WJ-d's F1.76-A) — the OTHER claude permission card, the one
 * the SDK's own `canUseTool` raises, must be bounded by the HOST too.
 *
 * ## The defect, re-read at this HEAD
 *
 * `ClaudeAgent.askToolApproval` registers a resolver in `pendingPermissions`,
 * publishes a card with `origin: 'claude_native'` and returns a promise that
 * settles on exactly three things: a click, an `AbortSignal`, and a teardown.
 * Nobody clicks and none of the three happens — so the wait is unbounded.
 *
 * It is NOT the same shape as F1.76's `case 'prompt'` card, and the difference
 * is what makes this row worse rather than duplicate. That branch runs inside a
 * PreToolUse hook callback, so the SDK's own per-hook backstop ends it at
 * 600 000 ms with a sentence that blames the transport. This seam is a
 * `can_use_tool` CONTROL REQUEST, not a hook callback: the vendored binary's
 * 600 000 ms default (`var Li=600000`) is read at `hn.type==="callback"` →
 * `hn.timeout?hn.timeout*1000:_`, which this path never reaches. The SDK's own
 * note, quoted in `buildClaudeCanUseTool`, says a missing response "parks the
 * tool with no deadline".
 *
 * ## What this suite can and cannot prove
 *
 * The production callback is a closure inside the SDK query options and cannot
 * be reached without a running child — `claude-permission-card-deadline.test.ts`
 * says the same of its own branch, for the same reason. So the WAIT is driven
 * here with the agent's REAL `askToolApproval`, its REAL `pendingPermissions`
 * map, a REAL `ClaudeTurnSlot` and the REAL `respondToPermission`; that the
 * query options use it is a source-text arm at the bottom, bounded by
 * `bracedRegion` with a control declared BELOW the anchor. The last link — that
 * the notice reaches the model — is driven for real through the exported
 * `buildClaudeCanUseTool`, which is the whole of the production path between
 * this answer and the SDK's `deny.message`.
 */
import { afterEach, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AgentEvent } from '@nessy-agent/core/types';
import {
  ClaudeAgent,
  buildClaudeCanUseTool,
  type ClaudeToolApprovalAnswer,
  type ClaudeToolApprovalRequest,
} from '../claude-agent.ts';
import type { BackendConfig } from '../backend/types.ts';
import { ClaudeTurnSlot } from '../backend/claude/turn-slot.ts';
import { bracedRegion } from '../../testing/source-regions.ts';
import {
  CLAUDE_PERMISSION_CARD_DEADLINE_MS,
  awaitClaudeNativeCardAnswer,
  claudePermissionCardTimeoutNotice,
  type ClaudeNativeCardWait,
} from '../backend/claude/permission-card-deadline.ts';

// Importing `claude-agent.ts` is this file's whole wall-clock cost; the cases
// themselves are milliseconds. Sized against the FILE, not against a case, for
// the reason AGENTS.md gives about a module-graph red wearing a test's name.
setDefaultTimeout(120_000);

/** The needle that must never appear in a sentence WE write. */
const TRANSPORT_BLAME = 'host client may be unreachable';

/**
 * The SDK's own sentence, verbatim from the vendored binary. It is the POSITIVE
 * CONTROL for the negative assertion below: it proves the needle is spellable
 * and that `toContain` reads, so `not.toContain` on our sentence means
 * something.
 */
const SDK_TIMEOUT_SENTENCE =
  'PreToolUse hook did not respond before its timeout (host client may be unreachable). '
  + 'The tool call was not executed; other configured hooks may not have completed.';

/**
 * The call site's shape at `ff2beaa6b`: `askPermission` handed
 * `this.askToolApproval(request, signal)` straight to `buildClaudeCanUseTool`.
 * Kept as a PERMANENT negative control — the three properties below are
 * asserted to FAIL against it, so no later refactor can satisfy this suite by
 * removing the deadline again (the D1.333 "a default flip has no instrument"
 * trap, closed in advance).
 */
const PRE_F1_169_AWAIT = <TAnswer>(options: ClaudeNativeCardWait<TAnswer>): Promise<TAnswer> =>
  options.wait;

interface Internals {
  onPermissionRequest: ((request: Record<string, unknown>) => void) | null;
  askToolApproval: (
    request: ClaudeToolApprovalRequest,
    signal?: AbortSignal,
  ) => Promise<ClaudeToolApprovalAnswer>;
  pendingPermissions: Map<string, Record<string, unknown>>;
  respondToPermission: (requestId: string, allowed: boolean, alwaysAllow?: boolean) => void;
}

const agents: ClaudeAgent[] = [];
afterEach(() => { for (const agent of agents.splice(0)) agent.destroy(); });

/** One `claude_native` card on a real agent, with a real open turn slot. */
function nativeCard(toolName = 'Bash') {
  const root = mkdtempSync(join(tmpdir(), 'f1169-agent-'));
  const agent = new ClaudeAgent({
    provider: 'anthropic',
    providerType: 'anthropic',
    model: 'claude-sonnet-4-6',
    isHeadless: true,
    skipConfigWatcher: true,
    workspace: {
      id: 'ws-f1169', name: 'F1169', rootPath: root,
      workspaceRootPath: root, sessionRootPath: join(root, 'sessions'),
    } as never,
    session: { id: 'sess-f1169', createdAt: Date.now(), lastUsedAt: Date.now(), workingDirectory: root } as never,
  } as BackendConfig);
  agents.push(agent);
  // The fixture's runtime is asserted rather than assumed: a test whose arms
  // silently measure some other backend is the 2026-09-20 WI-cb trap.
  expect(agent).toBeInstanceOf(ClaudeAgent);

  const internals = agent as unknown as Internals;
  const cards: Record<string, unknown>[] = [];
  internals.onPermissionRequest = request => { cards.push(request); };

  const requestId = 'toolu_f1169_control_request';
  const wait = internals.askToolApproval({
    requestId,
    toolName,
    command: 'rm -rf /tmp/f1169',
    description: 'Delete the scratch dir',
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

  const options: ClaudeNativeCardWait<ClaudeToolApprovalAnswer> = {
    wait,
    requestId,
    toolName,
    pending: internals.pendingPermissions,
    slot,
    budgetMs: 40,
    expired: notice => ({ allowed: false, comment: notice }),
  };
  const finish = async () => { slot.close('terminal'); await reader; };
  return { agent, internals, requestId, cards, options, seen, finish };
}

describe('F1.169 — the host bounds the native card too', () => {
  it('(a) the card was really raised, and it is the native one', async () => {
    const rig = nativeCard();
    await awaitClaudeNativeCardAnswer(rig.options);
    await rig.finish();

    // The positive control for every arm below: this rig drives the real
    // producer, so an arm that passes is about the card and not about the stub.
    expect(rig.cards).toHaveLength(1);
    expect(rig.cards[0]?.origin).toBe('claude_native');
    expect(rig.cards[0]?.requestId).toBe(rig.requestId);
  });

  it('(b) the deadline fires and the answer is a DENIAL carrying our sentence', async () => {
    const rig = nativeCard();
    const answer = await awaitClaudeNativeCardAnswer(rig.options);
    await rig.finish();

    expect(answer.allowed).toBe(false);
    const notice = answer.comment ?? '';
    expect(notice).toContain('Bash');
    expect(notice.toLowerCase()).toContain('answer');
    // The claim, and its positive control on the same instrument directly below.
    expect(notice).not.toContain(TRANSPORT_BLAME);
    expect(SDK_TIMEOUT_SENTENCE).toContain(TRANSPORT_BLAME);
  });

  it('(c) the card is WITHDRAWN: the resolver is gone and one cancellation reached the turn', async () => {
    const rig = nativeCard();
    await awaitClaudeNativeCardAnswer(rig.options);
    await rig.finish();

    expect(rig.internals.pendingPermissions.has(rig.requestId)).toBe(false);
    expect(rig.seen).toEqual([
      { type: 'permission_request_cancelled', requestId: rig.requestId },
    ]);
  });

  it('control — an answered card inside the budget still runs the tool, and withdraws nothing', async () => {
    const rig = nativeCard();
    const answered = awaitClaudeNativeCardAnswer(rig.options);
    rig.internals.respondToPermission(rig.requestId, true);
    const answer = await answered;
    await rig.finish();

    expect(answer).toEqual({ allowed: true });
    // `askToolApproval`'s own settle owns the removal on the answered path.
    expect(rig.internals.pendingPermissions.has(rig.requestId)).toBe(false);
    expect(rig.seen).toEqual([]);
  });

  it('control — a click that arrives AFTER the deadline is a no-op that throws nothing', async () => {
    const rig = nativeCard();
    const answer = await awaitClaudeNativeCardAnswer(rig.options);
    expect(answer.allowed).toBe(false);
    expect(() => rig.internals.respondToPermission(rig.requestId, true)).not.toThrow();
    await rig.finish();
    // Still exactly one cancellation — the late click added nothing.
    expect(rig.seen).toHaveLength(1);
  });

  it('the BEFORE-state, verbatim: all three properties fail without the deadline', async () => {
    const rig = nativeCard();
    const sentinel = Symbol('never');
    const raced = await Promise.race([
      PRE_F1_169_AWAIT(rig.options),
      new Promise<symbol>(resolve => setTimeout(() => resolve(sentinel), 400)),
    ]);
    await rig.finish();

    expect(raced).toBe(sentinel);                                            // it never settles
    expect(rig.internals.pendingPermissions.has(rig.requestId)).toBe(true);  // the card stays
    expect(rig.seen).toEqual([]);                                            // nothing is withdrawn
  });
});

describe('F1.169 — the sentence reaches the model, and the call site is bounded', () => {
  it('the expired answer becomes the SDK deny message, through the real callback', async () => {
    // The whole production path between this answer and the SDK: no stub of
    // `buildClaudeCanUseTool`, only of the card that never gets answered.
    const notice = claudePermissionCardTimeoutNotice('Bash', 40);
    const canUseTool = buildClaudeCanUseTool({
      askUser: async () => ({ type: 'option', value: 'first', optionIndex: 0 }) as never,
      askPermission: async () => ({ allowed: false, comment: notice }),
      alreadyApprovedByGate: () => false,
      permissionMode: () => 'default',
    });

    const result = await canUseTool('Bash', { command: 'rm -rf /tmp/f1169' }, {
      signal: new AbortController().signal,
      suggestions: [],
    } as never);

    expect(result).toEqual({ behavior: 'deny', message: notice });
  });

  it('shares F1.76\'s budget rather than inventing a second one', () => {
    // Two cards a user cannot tell apart must not expire at different times.
    expect(CLAUDE_PERMISSION_CARD_DEADLINE_MS).toBe(540_000);
  });

  it('the call site uses it — `askPermission` no longer hands the bare promise over', () => {
    const source = readFileSync(new URL('../claude-agent.ts', import.meta.url), 'utf8');
    const anchor = source.indexOf('canUseTool: buildClaudeCanUseTool({');
    expect(anchor).toBeGreaterThan(0);
    const wiring = bracedRegion(source, anchor);

    expect(wiring).toContain('awaitClaudeNativeCardAnswer(');
    // The EXPIRY SHAPE, pinned here because nothing else in this suite can see
    // it: the callback is a closure inside the SDK query options, so the arms
    // above supply their own `expired` and would pass against a call site that
    // dropped the sentence entirely. Measured rather than assumed — a mutant
    // replacing this line with `() => ({ allowed: false })` left the suite at
    // 9 pass / 0 fail until this assertion existed. The collaborators are pinned
    // for the same reason: a call site that withdrew nothing (no `pending`, no
    // `slot`) is invisible to a rig that passes its own.
    expect(wiring).toContain('expired: notice => ({ allowed: false, comment: notice })');
    expect(wiring).toContain('pending: this.pendingPermissions,');
    expect(wiring).toContain('slot: this.openSlot,');
    // Boundary control, declared BELOW the anchor so a runaway region is caught:
    // `private wrapUserText(` is a later method of the same class and must sit
    // outside the braces this region closes on.
    expect(wiring).not.toContain('private wrapUserText(');

    // The pre-fix wiring, asserted over the WHOLE FILE rather than over the
    // region — the F1.172 shape, met again one file over and caught by the same
    // gate. Inside the region it could never fail: after this commit the file
    // cannot spell the needle at all, so a brace scan running forward from the
    // anchor can never meet it. The line below is its positive control on the
    // same instrument: the method IS still called from this file, so `toContain`
    // is known to read before `not.toContain` is believed.
    expect(source).not.toContain('askPermission: (request, signal) => this.askToolApproval(request, signal)');
    expect(source).toContain('this.askToolApproval(request, signal)');
    // Boundary control, declared BELOW the anchor so a runaway region is caught:
    // `disallowedTools` is assigned in the same options object AFTER this
    // callback, so it must sit outside the braces this region closes on.
    expect(wiring).not.toContain('disallowedTools');
  });
});
