/**
 * P3.2 fix wave — the two hops that make the auto-review row FUNCTION:
 *  (a) the caller hop: the `codexAutoReview*` settings → the options
 *      `writeCodexConfig` receives → the emitted TOML (the inertness fix);
 *  (b) the `/approve` hop: a user override → `thread/approveGuardianDeniedAction`
 *      + `eventAdapter.notifyGuardianOverride()` (breaker reset).
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { buildCodexConfigToml } from '@nessy-agent/codex-responses-adapter/config-writer';
import type { BackendConfig } from '../backend/types.ts';
import { cleanupModeState } from '../mode-manager.ts';
import { CodexAgent, buildCodexAutoReviewOptions } from '../codex-agent.ts';

// ---- (a) the inertness fix: settings → writer options → emitted TOML ----

describe('buildCodexAutoReviewOptions (P3.2 caller hop)', () => {
  it('OFF → {} (control: config-writer then emits nothing)', () => {
    expect(buildCodexAutoReviewOptions(false, 'anything')).toEqual({});
  });

  it('ON → approvals_reviewer, plus autoReviewPolicy only for a non-blank policy', () => {
    expect(buildCodexAutoReviewOptions(true, '')).toEqual({ approvalsReviewer: 'auto_review' });
    expect(buildCodexAutoReviewOptions(true, '   ')).toEqual({ approvalsReviewer: 'auto_review' });
    expect(buildCodexAutoReviewOptions(true, 'Deny egress.')).toEqual({
      approvalsReviewer: 'auto_review',
      autoReviewPolicy: 'Deny egress.',
    });
  });

  it('end-to-end: the helper output drives the writer ON and emits nothing OFF', () => {
    const base = { codexHome: '/tmp/x', model: 'tgpt/qwen35-397b-a17b-fp8', adapterPort: 4321 } as const;
    const on = buildCodexConfigToml({ ...base, ...buildCodexAutoReviewOptions(true, 'Deny egress.') });
    expect(on).toContain('approvals_reviewer = "auto_review"');
    expect(on).toContain('[auto_review]');
    expect(on).toContain('policy = "Deny egress."');
    const off = buildCodexConfigToml({ ...base, ...buildCodexAutoReviewOptions(false, 'Deny egress.') });
    expect(off).not.toContain('approvals_reviewer');
    expect(off).not.toContain('[auto_review]');
  });
});

// ---- (b) the /approve hop ----

const WORKSPACE_ID = 'ws-auto-review-wiring';
const SESSION_ID = 'session-auto-review-wiring';
const THREAD = 'thread-approve';

function createConfig(): BackendConfig {
  return {
    provider: 'codex-runtime',
    workspace: {
      id: WORKSPACE_ID, name: 'AR', rootPath: '/tmp/ar',
      workspaceRootPath: '/tmp/ar', sessionRootPath: '/tmp/ar-sessions',
    } as any,
    session: {
      id: SESSION_ID, workspaceRootPath: '/tmp/ar',
      createdAt: Date.now(), lastUsedAt: Date.now(), workingDirectory: '/tmp/ar',
    } as any,
    model: 'codex/test-model',
    isHeadless: true,
  };
}

interface Recorded { method: string; params: any }
interface SinkEvent { type: string; message?: string; level?: string }

function harness(opts: { rejectApprove?: boolean; withClient?: boolean } = {}) {
  const { rejectApprove = false, withClient = true } = opts;
  const agent = new CodexAgent(createConfig());
  const requests: Recorded[] = [];
  const events: SinkEvent[] = [];
  const internals = agent as unknown as {
    threadId: string | null;
    client: { request: (m: string, p: unknown) => Promise<unknown> } | null;
    turnSink: { push: (e: SinkEvent) => void; finish: () => void } | null;
    handleNotification: (m: string, p: unknown) => void;
  };
  internals.threadId = THREAD;
  internals.turnSink = { push: e => events.push(e), finish: () => {} };
  internals.client = withClient
    ? {
        request: (method, params) => {
          requests.push({ method, params });
          return rejectApprove && method === 'thread/approveGuardianDeniedAction'
            ? Promise.reject(new Error('unknown method'))
            : Promise.resolve({});
        },
      }
    : null;
  return { agent, requests, events, notify: (m: string, p: unknown) => internals.handleNotification(m, p) };
}

const deniedCompleted = (rationale = 'writes outside workspace') => ({
  threadId: THREAD, turnId: 'turn-1', startedAtMs: 1, completedAtMs: 2,
  reviewId: 'r1', targetItemId: 'i1', decisionSource: 'agent',
  review: { status: 'denied', riskLevel: 'high', userAuthorization: null, rationale },
  action: { type: 'command', source: 'shell', command: 'curl evil', cwd: '/tmp/ar' },
});

/**
 * The override notice, matched on its INVARIANT rather than its wording: this
 * file's job is the wiring — that the notice reaches the sink on one arm and the
 * caller on the other — not the sentence. P2.417 gave the notice a subject, so
 * it now reads "…a guardian-denied request to run `x` in /y" once a denial has
 * been seen and keeps the older "…a guardian-denied action" when none has. Both
 * are the same wiring; the WORDING of each is pinned in
 * `codex-event-adapter.test.ts`, where the adapter's own tests live.
 *
 * The third case below ("with no client and no captured denial") is the positive
 * control for the second form, so widening here does not blind the file to it.
 */
const OVERRIDE_NOTICE = /approved a guardian-denied (?:action|request)\b/;

afterEach(() => cleanupModeState({ workspaceId: WORKSPACE_ID, sessionId: SESSION_ID }));

describe('CodexAgent.approveGuardianDeniedAction (P3.2 /approve)', () => {
  it('captures the denial, relays it to the app-server, and fires notifyGuardianOverride', () => {
    const h = harness();
    try {
      h.notify('item/autoApprovalReview/completed', deniedCompleted());
      // adapter half: the denial surfaced as a durable info row
      expect(h.events.some(e => e.type === 'info' && /denied/.test(e.message ?? ''))).toBe(true);
      const before = h.events.length;
      h.agent.approveGuardianDeniedAction();
      const req = h.requests.find(r => r.method === 'thread/approveGuardianDeniedAction');
      expect(req).toBeTruthy();
      expect(req!.params.threadId).toBe(THREAD);
      expect(req!.params.event).toEqual(deniedCompleted());
      // notifyGuardianOverride fired → the override notice reached the sink
      expect(h.events.slice(before).some(e => e.type === 'info' && OVERRIDE_NOTICE.test(e.message ?? ''))).toBe(true);
    } finally { h.agent.destroy(); }
  });

  it('degrades (no throw) when the [UNSTABLE] method is refused, still resetting the local breaker', () => {
    const h = harness({ rejectApprove: true });
    try {
      h.notify('item/autoApprovalReview/completed', deniedCompleted());
      expect(() => h.agent.approveGuardianDeniedAction()).not.toThrow();
      expect(h.events.some(e => OVERRIDE_NOTICE.test(e.message ?? ''))).toBe(true);
    } finally { h.agent.destroy(); }
  });

  it('with no client and no captured denial, resets the local breaker and does not throw or relay', () => {
    const h = harness({ withClient: false });
    try {
      expect(() => h.agent.approveGuardianDeniedAction()).not.toThrow();
      expect(h.requests).toHaveLength(0);
      expect(h.events.some(e => OVERRIDE_NOTICE.test(e.message ?? ''))).toBe(true);
    } finally { h.agent.destroy(); }
  });
});

/**
 * P3.25 — the seam arm, and the hazard that made it a SEPARATE method.
 *
 * `/approve` is answered by `BaseAgent.chat` BEFORE `chatImpl` runs, and
 * `turnSink` is set by `chatImpl`. So at the seam there is no sink: the
 * push-based `approveGuardianDeniedAction` resets the breaker and relays
 * correctly, and its notice — the only thing that tells the user the override
 * landed — goes nowhere. The override YIELDS instead.
 */
describe('CodexAgent.approveGuardianDenial (P3.25 seam arm)', () => {
  it('yields the override notice at the seam, where nothing is pushed anywhere', async () => {
    const h = harness();
    const internals = h.agent as unknown as { turnSink: unknown };
    try {
      h.notify('item/autoApprovalReview/completed', deniedCompleted());
      // The seam's real condition: no turn is open.
      internals.turnSink = null;
      const before = h.events.length;

      const yielded: SinkEvent[] = [];
      for await (const event of (h.agent as unknown as {
        approveGuardianDenial(): AsyncGenerator<SinkEvent>
      }).approveGuardianDenial()) {
        yielded.push(event);
      }

      // The notice reached the CALLER, which at this seam is the only route out.
      expect(yielded.some(e => e.type === 'info' && OVERRIDE_NOTICE.test(e.message ?? ''))).toBe(true);
      // Nothing was pushed: with `turnSink` null a push is a silent drop, and a
      // test that only asserted "the notice exists somewhere" would pass for the
      // pushing sibling too.
      expect(h.events.length).toBe(before);
      // The relay half is unchanged and still fires from this path.
      const relayed = h.requests.find(r => r.method === 'thread/approveGuardianDeniedAction');
      expect(relayed).toBeTruthy();
      expect(relayed!.params.event).toEqual(deniedCompleted());
    } finally { h.agent.destroy(); }
  });

  it('is what `/approve` reaches through chat(), with no prompt sent and no chatImpl entered', async () => {
    const h = harness();
    const internals = h.agent as unknown as {
      turnSink: unknown
      chatImpl(): AsyncGenerator<SinkEvent>
    };
    try {
      h.notify('item/autoApprovalReview/completed', deniedCompleted());
      internals.turnSink = null;
      internals.chatImpl = async function* () { throw new Error('chatImpl must not run for /approve'); };

      const events: SinkEvent[] = [];
      for await (const event of h.agent.chat('/approve')) events.push(event);

      expect(events.map(e => e.type)).toEqual(['info', 'complete']);
      expect(OVERRIDE_NOTICE.test(events[0]!.message ?? '')).toBe(true);
      expect(h.requests.some(r => r.method === 'thread/approveGuardianDeniedAction')).toBe(true);
    } finally { h.agent.destroy(); }
  });

  it('degrades on a refused relay without throwing out of the user action', async () => {
    const h = harness({ rejectApprove: true });
    const internals = h.agent as unknown as { turnSink: unknown };
    try {
      h.notify('item/autoApprovalReview/completed', deniedCompleted());
      internals.turnSink = null;

      const yielded: SinkEvent[] = [];
      for await (const event of h.agent.chat('/approve')) yielded.push(event);

      expect(yielded.some(e => OVERRIDE_NOTICE.test(e.message ?? ''))).toBe(true);
    } finally { h.agent.destroy(); }
  });
});
