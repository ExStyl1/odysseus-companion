/**
 * P2.407 (agent half) — the two places `CodexAgent` now RECORDS what codex told
 * it, instead of discarding it at the door.
 *
 * The row's instruction is literal: *read `action` and record what arrives
 * before proposing any behaviour change*. So nothing here routes on what it
 * reads. What it buys is the receipt P2.384 said was missing — a guardian
 * verdict that changed a permission outcome used to leave behind a sentence
 * naming nothing, and an amendment codex offered used to leave behind nothing
 * at all.
 *
 * ## What is NOT covered here, and why
 *
 * The USER-facing half of (a) — the event adapter's "Auto-review denied this
 * action" naming the action too — lives in
 * `packages/shared/src/agent/backend/codex/event-adapter.ts`, outside this
 * lane's files. `describeGuardianReviewAction` is exported from
 * `@nessy-agent/codex-agent-server` so that edit is a one-line adoption rather
 * than a second, drifting describer.
 */
import { describe, expect, it } from 'bun:test';
import type { BackendConfig } from '../backend/types.ts';
import { CodexAgent } from '../codex-agent.ts';

const THREAD = 'thread-approval-records';

function createConfig(): BackendConfig {
  return {
    provider: 'codex-runtime',
    workspace: {
      id: 'ws-approval-records',
      name: 'Approval Records Workspace',
      rootPath: '/tmp/ws-approval-records-root',
      workspaceRootPath: '/tmp/ws-approval-records-root',
      sessionRootPath: '/tmp/nessy-general-agent-test-sessions/ws-approval-records',
    } as any,
    session: {
      id: 'session-approval-records',
      workspaceRootPath: '/tmp/ws-approval-records-root',
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      workingDirectory: '/tmp/project-root',
    } as any,
    model: 'codex/test-model',
    isHeadless: true,
  };
}

interface Harness {
  notify: (method: string, params: unknown) => void;
  debug: string[];
  lastDenial: () => unknown;
}

function harness(): Harness {
  const agent = new CodexAgent(createConfig());
  const internals = agent as unknown as {
    threadId: string | null;
    turnSink: { push: (e: unknown) => void } | null;
    lastGuardianDeniedEvent: unknown;
    handleNotification: (method: string, params: unknown) => void;
  };
  const debug: string[] = [];
  agent.onDebug = (message: string) => debug.push(message);
  internals.threadId = THREAD;
  internals.turnSink = { push: () => {} };
  return {
    notify: (method, params) => internals.handleNotification(method, params),
    debug,
    lastDenial: () => internals.lastGuardianDeniedEvent,
  };
}

/**
 * `ItemGuardianApprovalReviewCompletedNotification` — built from the generated
 * type (`packages/codex-protocol/generated/v2/`, ts-rs output from the codex
 * source at `rust-v0.148.0`). NOT captured live: auto-review is setting-gated
 * and off by default, so this shape is strong-by-derivation and its arrival is
 * unmeasured here.
 */
const deniedNetworkReview = () => ({
  threadId: THREAD,
  turnId: 'turn-1',
  startedAtMs: 0,
  completedAtMs: 1,
  reviewId: 'rev-1',
  targetItemId: null,
  decisionSource: 'agent',
  review: { status: 'denied', riskLevel: 'high', userAuthorization: 'low', rationale: 'exfiltration risk' },
  action: { type: 'networkAccess', target: 'api', host: 'paste.example', protocol: 'https', port: 443 },
});

describe('the guardian verdict now carries its subject', () => {
  /**
   * THE RECEIPT. Before this row the denial was remembered (for `/approve`) and
   * described nowhere.
   *
   * KILLS: dropping the `action` read from the `autoApprovalReview/completed`
   * branch — the state P2.407 found.
   */
  it('records WHAT was denied, not just that something was', () => {
    const h = harness();
    h.notify('item/autoApprovalReview/completed', deniedNetworkReview());
    const line = h.debug.find(m => m.includes('auto-review DENIED'));
    expect(line).toBeDefined();
    expect(line).toContain('paste.example:443');
    expect(line).toContain('https');
    // The pre-existing `/approve` bookkeeping is untouched.
    expect(h.lastDenial()).toEqual(deniedNetworkReview());
  });

  /** KILLS: a record that goes silent (or throws) when `action` is absent. */
  it('says so when the action is unreadable, rather than saying nothing', () => {
    const h = harness();
    const withoutAction = { ...deniedNetworkReview(), action: undefined };
    expect(() => h.notify('item/autoApprovalReview/completed', withoutAction)).not.toThrow();
    expect(h.debug.find(m => m.includes('auto-review DENIED'))).toContain('not readable');
  });

  /**
   * NEGATIVE CONTROL. Only a DENIAL is a permission outcome worth a receipt; an
   * approval is the routine path and must not fill the log.
   */
  it('records nothing for an approved review', () => {
    const h = harness();
    h.notify('item/autoApprovalReview/completed', {
      ...deniedNetworkReview(),
      review: { status: 'approved', riskLevel: 'low', userAuthorization: 'high', rationale: null },
    });
    expect(h.debug.find(m => m.includes('auto-review DENIED'))).toBeUndefined();
  });
});
