/**
 * C4.13 (QH1, owner answer B, 2026-09-11) — codex's own detached `/code-review`.
 *
 * `code-review.md#review-a-diff-locally`, verbatim: *"The review runs as a
 * background subagent with its own context window, so it doesn't fill your
 * conversation."* Pi backgrounds it by default (P6.798), claude's SDK
 * backgrounds its own subagents, and codex ran the reviewer inline on the
 * conversation's own thread. `review/start` with `delivery: "detached"` is
 * codex's OWN mechanism for it.
 *
 * ## What each case kills
 *
 * - the SHAPE case dies if the request stops being `custom` + `detached`, or if
 *   the host's rubric stops riding it — a native `ReviewTarget` member would
 *   make codex recompute the diff with its own scope (the drift P3.276 removed)
 *   and would run codex's review prompt instead of ours;
 * - the GENERATED-TYPE pin reads `ReviewStartParams.ts` and `ReviewDelivery.ts`
 *   off disk, because the params shape is spelled locally rather than imported
 *   (`@nessy-agent/shared` has no edge to `@nessy-agent/codex-protocol`) — so a
 *   rename at the next codex lift fails HERE rather than at a round trip;
 * - the three FALLBACK cases are the row's safety property: a background review
 *   that cannot start must never cost the user the review. An inline delivery
 *   (codex answering with the ORIGINAL thread id) is the sharp one — it looks
 *   like success and is not;
 * - the SUBSCRIPTION case is what makes the capability real rather than
 *   fire-and-forget: a detached review's thread is foreign by construction, so
 *   without the re-admit its findings are dropped by the foreign-thread guard;
 * - the bridge cases pin that nothing changes for a review that did NOT ask for
 *   the background, which is every review until the two handed-off lines in
 *   `@nessy-agent/session-tools-core` land.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  HOST_CALLBACK_BRIDGE_ROUTES,
  type SessionReviewDiffAnswer,
} from '@nessy-agent/session-tools-core';
import type { BackendConfig } from '../backend/types.ts';
import { CodexAgent } from '../codex-agent.ts';
import {
  buildCodexDetachedReviewParams,
  CODEX_DETACHED_REVIEW_DELIVERY,
  CODEX_DETACHED_REVIEW_SWITCH_NOTE,
  describeCodexDetachedReviewFindings,
} from '../backend/codex/detached-review.ts';
import {
  startCodexSessionCallbackBridge,
  type CodexSessionCallbackBridgeHandle,
} from '../backend/codex/session-callback-bridge.ts';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..');
const PROTOCOL = join(REPO_ROOT, 'packages', 'codex-protocol', 'generated', 'v2');

const HOST_ANSWER = {
  target: 'this branch against origin/main',
  task: 'Review this diff:\n--- a\n+++ b\n',
  rubric: 'Be adversarial. Report only real defects.',
};

describe('C4.13 — the review/start request the host builds', () => {
  it('asks for a DETACHED review of a host-computed custom target', () => {
    const params = buildCodexDetachedReviewParams('thread-parent', HOST_ANSWER);

    expect(params.threadId).toBe('thread-parent');
    expect(params.delivery).toBe('detached');
    expect(params.target.type).toBe('custom');
    // Read into a local before asserting on it: `toMatchObject` with a matcher
    // overwrites the field it matched (AGENTS.md §Traps).
    const instructions = params.target.type === 'custom' ? params.target.instructions : '';
    expect(instructions).toContain(HOST_ANSWER.rubric);
    expect(instructions).toContain(HOST_ANSWER.task);
    // Rubric BEFORE task — the same order `handleReviewDiff` hands a delegated
    // reviewer on the other two runtimes.
    expect(instructions.indexOf(HOST_ANSWER.rubric)).toBeLessThan(instructions.indexOf(HOST_ANSWER.task));
  });

  it('matches the GENERATED protocol at the pinned tag', () => {
    const startParams = readFileSync(join(PROTOCOL, 'ReviewStartParams.ts'), 'utf8');
    const delivery = readFileSync(join(PROTOCOL, 'ReviewDelivery.ts'), 'utf8');
    const target = readFileSync(join(PROTOCOL, 'ReviewTarget.ts'), 'utf8');
    const response = readFileSync(join(PROTOCOL, 'ReviewStartResponse.ts'), 'utf8');

    for (const field of ['threadId', 'target', 'delivery']) expect(startParams).toContain(field);
    expect(delivery).toContain(`"${CODEX_DETACHED_REVIEW_DELIVERY}"`);
    expect(target).toContain('"custom"');
    // The field the subscription keys on.
    expect(response).toContain('reviewThreadId');
    // NEGATIVE control on the same reads, so "toContain finds everything" is not
    // what made the four above pass.
    expect(delivery).not.toContain('"zzz-not-a-delivery"');
  });

  it('states the residual switch difference rather than hiding it', () => {
    // The host's job is to make the difference uniform or HONEST; a codex review
    // thread does not survive a switch, and this is the sentence that says so.
    expect(CODEX_DETACHED_REVIEW_SWITCH_NOTE).toContain('Pi or Claude');
    expect(describeCodexDetachedReviewFindings('x', '   ')).toContain('nothing to report');
  });
});

function createConfig(): BackendConfig {
  return {
    provider: 'codex-runtime',
    workspace: {
      id: 'ws-c413',
      name: 'Detached Review Workspace',
      rootPath: '/tmp/nessy-c413-ws',
      workspaceRootPath: '/tmp/nessy-c413-ws',
      sessionRootPath: '/tmp/nessy-c413-sessions/ws-c413',
    } as any,
    session: {
      id: 'session-c413',
      workspaceRootPath: '/tmp/nessy-c413-ws',
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      workingDirectory: '/tmp/nessy-c413-project',
    } as any,
    model: 'codex/test-model',
    isHeadless: true,
  };
}

/** A CodexAgent with a fake app-server client and an open parent thread. */
function agentWithClient(answer: unknown | (() => never)): {
  agent: CodexAgent;
  requests: { method: string; params: unknown }[];
} {
  const agent = new CodexAgent(createConfig());
  const requests: { method: string; params: unknown }[] = [];
  (agent as any).threadId = 'thread-parent';
  (agent as any).client = {
    request: async (method: string, params: unknown) => {
      requests.push({ method, params });
      if (typeof answer === 'function') (answer as () => never)();
      return answer;
    },
  };
  return { agent, requests };
}

describe('C4.13 — CodexAgent.startDetachedReview', () => {
  it('sends review/start and reports the background review', async () => {
    const { agent, requests } = agentWithClient({ reviewThreadId: 'thread-review' });

    const line = await (agent as any).startDetachedReview(HOST_ANSWER) as string | null;

    expect(requests.map(entry => entry.method)).toEqual(['review/start']);
    expect(line).toContain('in the background');
    expect(line).toContain(HOST_ANSWER.target);
  });

  it('FALLS BACK when codex delivers it INLINE — the sharp negative', async () => {
    // codex answers with the ORIGINAL thread id for an inline delivery (its own
    // field docblock says so). That is the review we already had, so claiming
    // the capability would be a lie the user cannot see.
    const { agent } = agentWithClient({ reviewThreadId: 'thread-parent' });

    expect(await (agent as any).startDetachedReview(HOST_ANSWER)).toBeNull();
  });

  it('FALLS BACK when codex refuses the method at all', async () => {
    const { agent } = agentWithClient(() => { throw new Error('unknown method review/start'); });

    expect(await (agent as any).startDetachedReview(HOST_ANSWER)).toBeNull();
  });

  it('FALLS BACK when no codex thread is open', async () => {
    const agent = new CodexAgent(createConfig());

    expect(await (agent as any).startDetachedReview(HOST_ANSWER)).toBeNull();
  });

  it('re-admits the review thread and surfaces its findings when it completes', async () => {
    const { agent } = agentWithClient({ reviewThreadId: 'thread-review' });
    await (agent as any).startDetachedReview(HOST_ANSWER);
    const surfaced: string[] = [];
    (agent as any).surfaceCodexOperatorNotice = (notice: string) => { surfaced.push(notice); };

    // The review thread is FOREIGN by construction, so this is the path the
    // foreign-thread guard would otherwise drop.
    expect((agent as any).admitDetachedReviewNotification('item/completed', {
      threadId: 'thread-review', item: { text: 'One finding: the null check is inverted.' },
    })).toBe(true);
    expect(surfaced).toEqual([]);
    expect((agent as any).admitDetachedReviewNotification('turn/completed', {
      threadId: 'thread-review',
    })).toBe(true);

    expect(surfaced).toHaveLength(1);
    expect(surfaced[0]).toContain('the null check is inverted');
    expect(surfaced[0]).toContain(HOST_ANSWER.target);
    // Reported ONCE: the thread is forgotten, so a late notification from it is
    // foreign again and the guard drops it.
    expect((agent as any).admitDetachedReviewNotification('turn/completed', {
      threadId: 'thread-review',
    })).toBe(false);
    // NEGATIVE control: a thread this session never started stays foreign.
    expect((agent as any).admitDetachedReviewNotification('turn/completed', {
      threadId: 'thread-someone-else',
    })).toBe(false);
  });
});

const openBridges: CodexSessionCallbackBridgeHandle[] = [];
afterEach(async () => {
  while (openBridges.length > 0) await openBridges.pop()!.close();
});

async function bridgeWith(options: {
  diff: string;
  detachedReview?: (input: { target: string; task: string; rubric: string }) => Promise<string | null>;
}): Promise<(payload: unknown) => Promise<Record<string, unknown>>> {
  const answer: SessionReviewDiffAnswer = {
    target: HOST_ANSWER.target,
    diff: options.diff,
    task: HOST_ANSWER.task,
    rubric: HOST_ANSWER.rubric,
    reviewerAgent: 'reviewer',
  };
  const bridge = await startCodexSessionCallbackBridge({
    sessionKey: { workspaceId: 'ws-c413', sessionId: 'session-c413' },
    resolvePorts: () => ({ reviewDiff: { compute: async () => answer } }),
    ...(options.detachedReview ? { detachedReview: options.detachedReview } : {}),
  });
  openBridges.push(bridge);
  return async payload => {
    const response = await fetch(`http://127.0.0.1:${bridge.port}${HOST_CALLBACK_BRIDGE_ROUTES.reviewDiff}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: 'session-c413', payload }),
    });
    const body = await response.json() as { result?: Record<string, unknown> };
    return body.result ?? {};
  };
}

describe('C4.13 — the ReviewDiff bridge route', () => {
  it('starts the background review when the request asks for one', async () => {
    const seen: { target: string }[] = [];
    const post = await bridgeWith({
      diff: '--- a\n+++ b\n',
      detachedReview: async input => { seen.push(input); return 'running in the background'; },
    });

    const result = await post({ scope: 'uncommitted', background: true });

    expect(seen).toHaveLength(1);
    expect(result.backgroundReview).toBe('running in the background');
  });

  /**
   * C4.42 (OWNER, 2026-09-13) — this pair is the DEFAULT FLIP, and it is written
   * as a pair on purpose.
   *
   * The arm below read *"changes NOTHING for a request that did not ask — every
   * review today"* and asserted no `backgroundReview` on a request with no
   * flag. That was C4.13's deliberate opt-in, and it left codex the one runtime
   * whose default was decided by whether the model complied with a skill
   * paragraph. `code-review.md#run-in-the-foreground`: *"The review runs in the
   * background by default"*; Pi does (P6.798), the SDK backgrounds claude's
   * subagents. So the predicate is `background !== false`.
   *
   * A default flip has no instrument of its own — its stale pins go GREEN rather
   * than red (AGENTS.md §Traps, 2026-09-11) — so the escape is pinned in the
   * same block as the default. If the predicate were ever narrowed back to
   * `=== true`, the first of these two fails; if it were widened to ignore the
   * flag entirely, the second does.
   */
  it('C4.42 · DETACHES by default, with no flag in the request', async () => {
    const post = await bridgeWith({
      diff: '--- a\n+++ b\n',
      detachedReview: async () => 'running in the background',
    });

    const result = await post({ scope: 'uncommitted' });

    expect(result.backgroundReview).toBe('running in the background');
  });

  it('C4.42 · an explicit background:false keeps the review INLINE — the documented escape', async () => {
    let called = 0;
    const post = await bridgeWith({
      diff: '--- a\n+++ b\n',
      detachedReview: async () => { called += 1; return 'running in the background'; },
    });

    const result = await post({ scope: 'uncommitted', background: false });

    // Not merely "no field on the answer": the thread is never started at all.
    expect(called).toBe(0);
    expect(result).not.toHaveProperty('backgroundReview');
    expect(result.reviewerAgent).toBe('reviewer');
  });

  it('hands back the ordinary answer when codex declines', async () => {
    const post = await bridgeWith({ diff: '--- a\n+++ b\n', detachedReview: async () => null });

    const result = await post({ background: true });

    expect(result).not.toHaveProperty('backgroundReview');
    expect(result.task).toBe(HOST_ANSWER.task);
  });

  it('never starts one for an empty diff', async () => {
    let called = 0;
    const post = await bridgeWith({
      diff: '',
      detachedReview: async () => { called += 1; return 'started'; },
    });

    await post({ background: true });

    expect(called).toBe(0);
  });
});
