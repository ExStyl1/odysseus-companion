import { describe, it, expect, beforeEach } from 'bun:test';
import {
  registerSessionScopedToolCallbacks,
  mergeSessionScopedToolCallbacks,
  unregisterSessionScopedToolCallbacks,
} from '../session-scoped-tools.ts';
import { createClaudeContext } from '../claude-context.ts';
import { attachSessionSelfManagementBindings } from '../session-self-management-bindings.ts';
import type { SessionToolContext, SessionInfo } from '@nessy-agent/session-tools-core';
import { SESSION_TOOL_REGISTRY } from '@nessy-agent/session-tools-core';
import type { SessionKey } from '../../sessions/session-key.ts';

// Minimal noop callbacks for createClaudeContext
const noopPlan = () => {};
const noopAuth = () => {};

/** Helper to create a valid SessionInfo fixture */
function makeSessionInfo(overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id: 'test-session',
    name: 'Test Session',
    labels: [],
    status: 'active',
    permissionMode: 'execute',
    createdAt: Date.now(),
    isActive: true,
    ...overrides,
  };
}

function createBaseContext(sessionId: string): SessionToolContext {
  return createClaudeContext({
    sessionId,
    workspacePath: '/tmp/test-workspace',
    workspaceId: 'test-ws',
    sessionPath: `/tmp/test-workspace/sessions/${sessionId}`,
    onPlanSubmitted: noopPlan,
    onAuthRequest: noopAuth,
  });
}

// ============================================================
// Phase 1 — Regression test: Pi path must support session tools
// ============================================================

describe('Pi session self-management regression (#511)', () => {
  const sessionId = 'test-pi-regression-511';
  const key: SessionKey = { workspaceId: 'ws-selfmgmt', sessionId };

  beforeEach(() => {
    unregisterSessionScopedToolCallbacks(key);
  });

  it('context WITHOUT bindings has undefined session management properties', () => {
    const ctx = createBaseContext(sessionId);
    // This is the bug: PiAgent creates context without session management
    expect(ctx.setSessionLabels).toBeUndefined();
    expect(ctx.setSessionStatus).toBeUndefined();
    expect(ctx.getSessionInfo).toBeUndefined();
    expect(ctx.listSessions).toBeUndefined();
    expect(ctx.resolveLabels).toBeUndefined();
    expect(ctx.resolveStatus).toBeUndefined();
  });

  it('context WITH bindings resolves callbacks from registry', async () => {
    const ctx = createBaseContext(sessionId);
    attachSessionSelfManagementBindings(ctx, key);

    // Register callbacks in the registry (simulates SessionManager)
    const setLabelsCalled: Array<[string | undefined, string[]]> = [];
    const setStatusCalled: Array<[string | undefined, string]> = [];

    registerSessionScopedToolCallbacks(key, {
      setSessionLabelsFn: (sid, labels) => { setLabelsCalled.push([sid, labels]); },
      setSessionStatusFn: (sid, status) => { setStatusCalled.push([sid, status]); },
      getSessionInfoFn: (sid) => makeSessionInfo({ id: sid ?? sessionId }),
      listSessionsFn: () => ({ total: 1, returned: 1, sessions: [] }),
      resolveLabelsFn: (labels) => ({ resolved: labels, unknown: [], available: labels }),
      resolveStatusFn: (status) => ({ resolved: status, available: ['active', 'done'] }),
    });

    // All 6 properties should now be defined
    expect(ctx.setSessionLabels).toBeDefined();
    expect(ctx.setSessionStatus).toBeDefined();
    expect(ctx.getSessionInfo).toBeDefined();
    expect(ctx.listSessions).toBeDefined();
    expect(ctx.resolveLabels).toBeDefined();
    expect(ctx.resolveStatus).toBeDefined();

    // Verify they actually work
    await ctx.setSessionLabels!(undefined, ['bug', 'urgent']);
    expect(setLabelsCalled).toEqual([[undefined, ['bug', 'urgent']]]);

    await ctx.setSessionStatus!(undefined, 'done');
    expect(setStatusCalled).toEqual([[undefined, 'done']]);

    // P3.222 widened both returns to `T | Promise<T>` so the codex bridge can
    // resolve them over HTTP; the in-process binding here is still synchronous,
    // which is what `await` on a non-promise leaves unchanged.
    const info = await ctx.getSessionInfo!();
    expect(info).toBeTruthy();
    expect(info!.id).toBe(sessionId);

    const list = await ctx.listSessions!();
    expect(list.total).toBe(1);

    const resolved = await ctx.resolveLabels!(['bug']); // UA1.3 — the resolver may be a promise (codex)
    expect(resolved.resolved).toEqual(['bug']);

    const statusResolved = await ctx.resolveStatus!('active');
    expect(statusResolved.resolved).toBe('active');
  });
});

// ============================================================
// Phase 2 — Binding helper unit tests
// ============================================================

describe('attachSessionSelfManagementBindings', () => {
  const sessionId = 'test-bindings-unit';
  const key: SessionKey = { workspaceId: 'ws-selfmgmt', sessionId };

  beforeEach(() => {
    unregisterSessionScopedToolCallbacks(key);
  });

  it('absent callback → property is undefined for all 6 fields', () => {
    const ctx = createBaseContext(sessionId);
    attachSessionSelfManagementBindings(ctx, key);

    // No callbacks registered — all should resolve to undefined
    expect(ctx.setSessionLabels).toBeUndefined();
    expect(ctx.setSessionStatus).toBeUndefined();
    expect(ctx.getSessionInfo).toBeUndefined();
    expect(ctx.listSessions).toBeUndefined();
    expect(ctx.resolveLabels).toBeUndefined();
    expect(ctx.resolveStatus).toBeUndefined();
    expect(ctx.pluginManagement).toBeUndefined();
  });

  it('pluginManagement resolves from the registry and reflects late merge (A8)', () => {
    const ctx = createBaseContext(sessionId);
    attachSessionSelfManagementBindings(ctx, key);

    expect(ctx.pluginManagement).toBeUndefined();

    const pluginManagementTools = {
      planInstall: async () => ({ content: [{ type: 'text' as const, text: 'ok' }], structuredContent: {}, isError: false }),
      install: async () => ({ content: [{ type: 'text' as const, text: 'ok' }], structuredContent: {}, isError: false }),
      status: async () => ({ content: [{ type: 'text' as const, text: 'ok' }], structuredContent: {}, isError: false }),
      manage: async () => ({ content: [{ type: 'text' as const, text: 'ok' }], structuredContent: {}, isError: false }),
    };
    registerSessionScopedToolCallbacks(key, { pluginManagementTools });

    expect(ctx.pluginManagement).toBe(pluginManagementTools);
  });

  it('late merge becomes visible without recreating the context', () => {
    const ctx = createBaseContext(sessionId);
    attachSessionSelfManagementBindings(ctx, key);

    // Initially no callbacks
    expect(ctx.setSessionLabels).toBeUndefined();

    // Late merge — simulates SessionManager registering after agent start
    registerSessionScopedToolCallbacks(key, {
      setSessionLabelsFn: () => {},
    });

    // Should now be defined without recreating ctx
    expect(ctx.setSessionLabels).toBeDefined();
  });

  it('callback replacement is visible without recreating the context', () => {
    const ctx = createBaseContext(sessionId);
    attachSessionSelfManagementBindings(ctx, key);

    const callsA: string[] = [];
    const callsB: string[] = [];

    // Register callback A
    registerSessionScopedToolCallbacks(key, {
      setSessionStatusFn: (_, status) => { callsA.push(status); },
    });

    ctx.setSessionStatus!(undefined, 'from-A');
    expect(callsA).toEqual(['from-A']);

    // Replace with callback B via merge (full overwrite)
    mergeSessionScopedToolCallbacks(key, {
      setSessionStatusFn: (_, status) => { callsB.push(status); },
    });

    ctx.setSessionStatus!(undefined, 'from-B');
    expect(callsA).toEqual(['from-A']); // A not called again
    expect(callsB).toEqual(['from-B']); // B was called
  });

  it('getSessionInfo defaults to current session ID when called without arg', () => {
    const ctx = createBaseContext(sessionId);
    attachSessionSelfManagementBindings(ctx, key);

    let receivedId: string | undefined;
    registerSessionScopedToolCallbacks(key, {
      getSessionInfoFn: (sid) => {
        receivedId = sid;
        return makeSessionInfo({ id: sid ?? sessionId });
      },
    });

    // Call without arg — should default to sessionId
    ctx.getSessionInfo!();
    expect(receivedId).toBe(sessionId);

    // Call with explicit arg — should pass through
    ctx.getSessionInfo!('other-session');
    expect(receivedId).toBe('other-session');
  });

  it('setters pass through explicit session IDs unchanged', async () => {
    const ctx = createBaseContext(sessionId);
    attachSessionSelfManagementBindings(ctx, key);

    let receivedSid: string | undefined;
    registerSessionScopedToolCallbacks(key, {
      setSessionLabelsFn: (sid) => { receivedSid = sid; },
    });

    await ctx.setSessionLabels!('explicit-session-123', ['test']);
    expect(receivedSid).toBe('explicit-session-123');

    await ctx.setSessionLabels!(undefined, ['test']);
    expect(receivedSid).toBeUndefined();
  });

  it('no identity fallback — resolveLabels returns undefined when no callback', () => {
    const ctx = createBaseContext(sessionId);
    attachSessionSelfManagementBindings(ctx, key);

    // No callbacks registered — resolveLabels should be undefined, not an identity function
    expect(ctx.resolveLabels).toBeUndefined();
  });
});

// ============================================================
// Phase 3 — Parity: Claude and Pi paths expose same bindings
// ============================================================

describe('Claude/Pi session self-management parity', () => {
  const sessionId = 'test-parity';
  const key: SessionKey = { workspaceId: 'ws-selfmgmt', sessionId };

  beforeEach(() => {
    unregisterSessionScopedToolCallbacks(key);
  });

  it('both paths expose the same 6 bound properties when callbacks are registered', () => {
    const SELF_MGMT_PROPERTIES = [
      'setSessionLabels',
      'setSessionStatus',
      'getSessionInfo',
      'listSessions',
      'resolveLabels',
      'resolveStatus',
    ] as const;

    registerSessionScopedToolCallbacks(key, {
      setSessionLabelsFn: () => {},
      setSessionStatusFn: () => {},
      getSessionInfoFn: () => makeSessionInfo({ id: sessionId }),
      listSessionsFn: () => ({ total: 0, returned: 0, sessions: [] }),
      resolveLabelsFn: (l) => ({ resolved: l, unknown: [], available: l }),
      resolveStatusFn: (s) => ({ resolved: s, available: [] }),
    });

    // Simulate Pi path: createClaudeContext + attachBindings
    const piCtx = createBaseContext(sessionId);
    attachSessionSelfManagementBindings(piCtx, key);

    // Simulate Claude path: same thing after refactor
    const claudeCtx = createBaseContext(sessionId);
    attachSessionSelfManagementBindings(claudeCtx, key);

    for (const prop of SELF_MGMT_PROPERTIES) {
      expect(piCtx[prop]).toBeDefined();
      expect(claudeCtx[prop]).toBeDefined();
      // Both should be functions
      expect(typeof piCtx[prop]).toBe('function');
      expect(typeof claudeCtx[prop]).toBe('function');
    }
  });

  it('absent callbacks → handlers return exact "not available" error messages', async () => {
    const ctx = createBaseContext(sessionId);
    attachSessionSelfManagementBindings(ctx, key);
    // No callbacks registered — use the canonical registry to invoke handlers (same as runtime)

    const labelsHandler = SESSION_TOOL_REGISTRY.get('set_session_labels')!.handler!;
    const labelsResult = await labelsHandler(ctx, { labels: ['test'] });
    expect(labelsResult.isError).toBe(true);
    expect(labelsResult.content[0]!.text).toContain('not available in this context');

    const statusHandler = SESSION_TOOL_REGISTRY.get('set_session_status')!.handler!;
    const statusResult = await statusHandler(ctx, { status: 'done' });
    expect(statusResult.isError).toBe(true);
    expect(statusResult.content[0]!.text).toContain('not available in this context');

    const infoHandler = SESSION_TOOL_REGISTRY.get('get_session_info')!.handler!;
    const infoResult = await infoHandler(ctx, {});
    expect(infoResult.isError).toBe(true);
    expect(infoResult.content[0]!.text).toContain('not available in this context');

    const listHandler = SESSION_TOOL_REGISTRY.get('list_sessions')!.handler!;
    const listResult = await listHandler(ctx, {});
    expect(listResult.isError).toBe(true);
    expect(listResult.content[0]!.text).toContain('not available in this context');
  });
});

/**
 * P3.276 — the diff authority behind `ReviewDiff` is bound the same way every
 * other host port on this context is.
 *
 * `session-tools-core` holds no `git` and no copy of the review rubric —
 * `shared` depends on it, so the arrow points one way — which is why the tool
 * is a thin dispatcher onto a host port. The binding has to be a registry READ
 * rather than a one-time assignment: a runtime switch rebuilds the agent and
 * re-merges the port or clears it, and a memoized read would hand the next
 * runtime the previous one's working directory.
 */
describe('reviewDiff binding (P3.276)', () => {
  const key: SessionKey = { workspaceId: 'test-ws', sessionId: 'review-diff-binding' };

  beforeEach(() => {
    unregisterSessionScopedToolCallbacks(key);
  });

  it('resolves from the registry, and reflects a LATE merge without rebuilding the context', () => {
    const ctx = createBaseContext(key.sessionId);
    attachSessionSelfManagementBindings(ctx, key);
    // Absent until the host binds one — which is what makes the tool report
    // unavailability instead of diffing somewhere arbitrary.
    expect(ctx.reviewDiff).toBeUndefined();

    const port = { compute: async () => ({ target: 't', diff: '', task: '', rubric: '', reviewerAgent: 'reviewer' }) };
    registerSessionScopedToolCallbacks(key, {});
    mergeSessionScopedToolCallbacks(key, { reviewDiff: port });
    expect(ctx.reviewDiff).toBe(port);

    // And a CLEAR is visible too, which is the switch case: the port belongs to
    // the runtime that bound it.
    mergeSessionScopedToolCallbacks(key, { reviewDiff: undefined });
    expect(ctx.reviewDiff).toBeUndefined();
  });
});
