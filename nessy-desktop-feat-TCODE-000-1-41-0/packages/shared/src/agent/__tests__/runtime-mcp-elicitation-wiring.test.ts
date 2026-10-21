/**
 * Q13-D1: an MCP server can ask the user for a sign-in on every runtime.
 *
 * Measured on the packaged 1.25.1 build: a probe server's `elicitation/create`
 * was answered `-32601 Method not found` on Codex, while the identical server on
 * Pi received `elicitation: {form, url}` and was held open awaiting the user.
 * The seam was `mcp/client.ts`'s capability, keyed on an `elicitationHandler`,
 * and `pi-agent.ts` was the only caller of the pool's setter in the repo.
 *
 * The pool half — the advertised capability and the per-leaser routing — is
 * proven against a real MCP server in
 * `mcp/__tests__/mcp-pool-elicitation-routing.test.ts`. This suite pins the
 * agent half at the seam production crosses:
 *
 *   pool → the handler the agent registered for ITS leaser
 *        → a permission card on this session's screen
 *        → the answer the user gave
 *        → the `ElicitResult` the MCP server receives.
 *
 * It is deliberately NOT a test of `elicitation.ts`'s helpers: those already
 * have their own suite, and a helper-level pass is exactly what let the Codex
 * bridge look repaired while no request could reach it.
 */

import { describe, expect, it } from 'bun:test';
import type { ElicitRequest, ElicitResult } from '@modelcontextprotocol/sdk/types.js';
import type { AskUserPermissionRequest } from '@nessy-agent/core/types';
import type { McpElicitationHandler } from '../../mcp/client.ts';
import type { McpClientPool } from '../../mcp/mcp-pool.ts';
import type { BackendConfig, PermissionCallback } from '../backend/types.ts';
import type { PermissionMode } from '../mode-types.ts';
import { ElicitationAskUserBridge } from '../elicitation-ask-user.ts';
import { CodexAgent } from '../codex-agent.ts';
import { ClaudeAgent } from '../claude-agent.ts';
import { PiAgent } from '../pi-agent.ts';

/**
 * The two pool methods the wiring touches. A fake rather than a real pool: the
 * subject here is WHICH method an agent calls and with WHAT leaser, and a real
 * pool would answer that question by connecting to something.
 */
function fakePool() {
  const scoped = new Map<string, McpElicitationHandler>();
  let unscoped: McpElicitationHandler | undefined;
  const pool = {
    registerElicitationHandler(leaserId: string, fn: McpElicitationHandler) {
      scoped.set(leaserId, fn);
      return () => { if (scoped.get(leaserId) === fn) scoped.delete(leaserId); };
    },
    setElicitationHandler(fn: McpElicitationHandler) { unscoped = fn; },
  } as unknown as McpClientPool;
  return {
    pool,
    scoped,
    get unscoped() { return unscoped; },
  };
}

function baseConfig(overrides: Partial<BackendConfig> = {}): BackendConfig {
  return {
    provider: 'codex-runtime',
    model: 'codex/test-model',
    isHeadless: true,
    skipConfigWatcher: true,
    workspace: {
      id: 'ws-elicit',
      name: 'Elicit Workspace',
      rootPath: '/tmp/ws-elicit',
      workspaceRootPath: '/tmp/ws-elicit',
      sessionRootPath: '/tmp/ws-elicit/sessions',
    } as never,
    session: {
      id: 'session-elicit',
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      workingDirectory: '/tmp/ws-elicit',
    } as never,
    ...overrides,
  } as BackendConfig;
}

/**
 * Let the pending microtasks drain. The dialog is not synchronous: the
 * documented `Elicitation` hook runs BEFORE anything is shown (hooks.md
 * §Elicitation), so the card appears a turn of the loop after the request.
 */
const settle = () => new Promise(resolve => setTimeout(resolve, 0));

/** A form the batched question card can render: one two-way choice. */
function formRequest(): ElicitRequest {
  return {
    method: 'elicitation/create',
    params: {
      message: 'Which workspace should I connect?',
      requestedSchema: {
        type: 'object',
        properties: { workspace: { type: 'string', enum: ['personal', 'team'] } },
        required: ['workspace'],
      },
    },
  } as ElicitRequest;
}

interface WiredAgent {
  handler: McpElicitationHandler;
  surfaced: Array<Parameters<PermissionCallback>[0]>;
  /** The pool's live registrations, so a release can be asserted rather than assumed. */
  scoped: Map<string, McpElicitationHandler>;
  respond: (requestId: string, allowed: boolean, answer?: unknown) => void;
  setPermissionMode: (mode: PermissionMode) => void;
  destroy: () => void;
  /**
   * The teardown a managed session actually gets.
   * `SessionManager.disposeManagedAgentRuntime` does
   * `if (agent.disposeForRestart) await agent.disposeForRestart() else agent.dispose()`,
   * and it is the ONLY agent teardown for real sessions — the two remaining
   * `agent.destroy()` sites belong to throwaway title-generation agents. Codex
   * defines `disposeForRestart`, so a fix proven through `destroy()` alone would
   * be proven on a path production never takes.
   */
  tearDown: () => Promise<void>;
}

/** Build one agent already attached to a fake pool under `leaserId`. */
function wire(kind: 'codex' | 'claude', leaserId?: string): WiredAgent {
  const fake = fakePool();
  const config = baseConfig({
    mcpPool: fake.pool,
    ...(leaserId ? { mcpLeaserId: leaserId } : {}),
    ...(kind === 'claude' ? { provider: 'anthropic', model: 'claude-sonnet-4-6' } : {}),
  } as Partial<BackendConfig>);
  const agent = kind === 'codex' ? new CodexAgent(config) : new ClaudeAgent(config as never);
  const surfaced: Array<Parameters<PermissionCallback>[0]> = [];
  agent.onPermissionRequest = request => { surfaced.push(request); };
  const handler = leaserId ? fake.scoped.get(leaserId) : fake.unscoped;
  expect(handler).toBeDefined();
  return {
    handler: handler!,
    surfaced,
    scoped: fake.scoped,
    respond: (requestId, allowed, answer) =>
      agent.respondToPermission(requestId, allowed, false, answer ? { askUserAnswer: answer as never } : undefined),
    setPermissionMode: mode => { agent.setPermissionMode(mode); },
    destroy: () => { void (agent as unknown as { destroy?: () => void }).destroy?.(); },
    tearDown: async () => {
      const disposable = agent as unknown as {
        disposeForRestart?: () => Promise<void>;
        dispose?: () => void;
      };
      if (disposable.disposeForRestart) await disposable.disposeForRestart();
      else disposable.dispose?.();
    },
  };
}

describe.each(['codex', 'claude'] as const)('the %s runtime wires MCP elicitation to its user', kind => {
  /**
   * The load-bearing assertion. Before the fix neither runtime called the pool
   * at all, so `elicitation` was never advertised on any pool client and every
   * `elicitation/create` was refused.
   */
  it('registers a handler on the pool, scoped to its own leaser', () => {
    const wired = wire(kind, 'session:elicit:runtime:1');
    expect(typeof wired.handler).toBe('function');
  });

  /** A private pool has one owner, so the unscoped setter is the right one. */
  it('uses the single-owner setter when it holds no lease', () => {
    const wired = wire(kind);
    expect(typeof wired.handler).toBe('function');
  });

  it('shows the server\'s question on this session\'s screen and sends back the answer', async () => {
    const wired = wire(kind, 'session:elicit:runtime:1');

    const pending = wired.handler(formRequest(), new AbortController().signal, { server: 'acme' });
    await settle();
    // The card is on screen before anything is answered — this is the step that
    // did not exist, and the reason the repaired bridge below it was unreachable.
    expect(wired.surfaced).toHaveLength(1);
    const card = wired.surfaced[0]!;
    expect(card.type).toBe('ask_user');
    expect(card.askUser?.question).toBe('Which workspace should I connect?');
    expect(card.askUser?.options).toEqual(['personal', 'team']);

    wired.respond(card.requestId, true, { type: 'option', optionIndex: 1, value: 'team' });

    expect(await pending).toEqual({ action: 'accept', content: { workspace: 'team' } });
  });

  /**
   * A dismissed card is `cancel`, not `accept` — MCP's own reading ("the user
   * dismissed the request without making an explicit choice") and the same
   * answer the Pi path has always given. What matters is that it is SETTLED and
   * that nothing was accepted on the user's behalf.
   */
  it('never accepts on the user\'s behalf when the card is dismissed', async () => {
    const wired = wire(kind, 'session:elicit:runtime:1');

    const pending = wired.handler(formRequest(), new AbortController().signal, { server: 'acme' });
    await settle();
    wired.respond(wired.surfaced[0]!.requestId, false);

    const result = await pending;
    expect(result.action).toBe('cancel');
    expect(result.content).toBeUndefined();
  });

  /**
   * Fail closed, visibly. A URL the gate refuses is never opened AND never
   * silently accepted — the user is told, then the server is declined. Same
   * `safeHttpUrl` gate as the Pi path; asserted here because this is the first
   * time either runtime reaches it.
   */
  it('refuses a non-http url-mode elicitation, telling the user why', async () => {
    const wired = wire(kind, 'session:elicit:runtime:1');
    const request = {
      method: 'elicitation/create',
      params: {
        mode: 'url',
        elicitationId: 'e1',
        url: 'javascript:alert(1)',
        message: 'Sign in to continue.',
      },
    } as ElicitRequest;

    const pending = wired.handler(request, new AbortController().signal, { server: 'acme' });
    await settle();
    const card = wired.surfaced[0]!;
    expect(card.askUser?.question).toContain('Refused');
    expect(card.askUser?.question).not.toContain('javascript:');
    wired.respond(card.requestId, true, { type: 'option', optionIndex: 0, value: 'OK' });

    expect((await pending).action).toBe('decline');
  });

  /**
   * A dialog that outlives its session must settle, or the MCP server waits on
   * an answer that can never come — the symptom this whole change is about.
   */
  it('settles a dialog left open when the session is destroyed', async () => {
    const wired = wire(kind, 'session:elicit:runtime:1');

    const pending = wired.handler(formRequest(), new AbortController().signal, { server: 'acme' });
    await settle();
    expect(wired.surfaced).toHaveLength(1);
    wired.destroy();

    const result: ElicitResult = await pending;
    expect(['cancel', 'decline']).toContain(result.action);
  });

  /**
   * The same invariant as the test above, on the path a session is actually
   * torn down by — and the one that matters more, because the registration is
   * held by the LONG-LIVED shared workspace pool. Left behind, it is a second
   * candidate in `resolveElicitationHandler` forever, which turns off the
   * single-bridge fallback for every other session in that workspace.
   */
  it('releases its pool registration and settles the dialog on the teardown a session gets', async () => {
    const wired = wire(kind, 'session:elicit:runtime:1');

    const pending = wired.handler(formRequest(), new AbortController().signal, { server: 'acme' });
    await settle();
    expect(wired.surfaced).toHaveLength(1);
    expect(wired.scoped.size).toBe(1);

    await wired.tearDown();

    expect(wired.scoped.size).toBe(0);
    expect(['cancel', 'decline']).toContain((await pending).action);
  });

  /**
   * `dontAsk` is documented as never prompting, and Pi's ask surface refuses
   * before showing anything. Until this, the shared bridge did not: the same
   * server put a card on screen on Claude and Codex and none on Pi. Fail-closed
   * on interaction — the server is still answered, so nothing hangs.
   */
  it('refuses without putting a card on screen in a mode that never prompts', async () => {
    const wired = wire(kind, 'session:elicit:runtime:1');
    wired.setPermissionMode('dontAsk');

    // Abortable on purpose: without the guard the card goes up and the request
    // waits on a human, so an unabortable version of this test would HANG on a
    // regression instead of failing. `surfaced` is the load-bearing assertion.
    const controller = new AbortController();
    const pending = wired.handler(formRequest(), controller.signal, { server: 'acme' });
    await settle();
    expect(wired.surfaced).toHaveLength(0);

    controller.abort();
    expect(['cancel', 'decline']).toContain((await pending).action);
  });

  /** No permission callback (headless): refuse, never hang. */
  it('answers rather than hanging when there is no surface to ask on', async () => {
    const fake = fakePool();
    const config = baseConfig({
      mcpPool: fake.pool,
      mcpLeaserId: 'session:headless:1',
      ...(kind === 'claude' ? { provider: 'anthropic', model: 'claude-sonnet-4-6' } : {}),
    } as Partial<BackendConfig>);
    const agent = kind === 'codex' ? new CodexAgent(config) : new ClaudeAgent(config as never);
    // `onPermissionRequest` deliberately left null.
    const handler = fake.scoped.get('session:headless:1')!;

    const result = await handler(formRequest(), new AbortController().signal, { server: 'acme' });
    expect(['cancel', 'decline']).toContain(result.action);
    void agent;
  });
});

/**
 * Pi is not in the table above: it answers through its own durable ask-user
 * service, so none of the dialog assertions apply to it. The pool REGISTRATION
 * is shared, and Pi is the runtime where every teardown misses the base cleanup
 * — `destroy()` does not chain `super.destroy()`, and `disposeForRestart()` is
 * the method SessionManager prefers over both.
 */
describe('the pi runtime leaves the pool routing on every teardown it has', () => {
  function pi(leaserId: string) {
    const fake = fakePool();
    const agent = new PiAgent(baseConfig({
      provider: 'pi',
      model: 'pi/test-model',
      mcpPool: fake.pool,
      mcpLeaserId: leaserId,
    } as Partial<BackendConfig>));
    expect(fake.scoped.size).toBe(1);
    return { agent, scoped: fake.scoped };
  }

  it('releases on disposeForRestart, the teardown SessionManager performs', async () => {
    const { agent, scoped } = pi('session:pi:runtime:1');
    await agent.disposeForRestart();
    expect(scoped.size).toBe(0);
  });

  it('releases on destroy, which never reaches the base cleanup', () => {
    const { agent, scoped } = pi('session:pi:runtime:2');
    agent.destroy();
    expect(scoped.size).toBe(0);
  });
});

/**
 * The two settings Pi's `requestAskUserPermission` has always applied and the
 * shared bridge did not. Driven at the bridge rather than through an agent
 * because the mode and the clock are INJECTED — `BaseAgent` supplies
 * `permissionManager.getPermissionMode()` and `getAskUserQuestionTimeoutMs()`,
 * and the latter reads a config path fixed at module load, which a unit test
 * cannot move.
 */
describe('the shared ask surface carries the user\'s settings', () => {
  const question = (): AskUserPermissionRequest => ({
    question: 'Sign in to continue?',
    options: ['OK'],
  } as AskUserPermissionRequest);

  it('stamps the auto-continue clock on the card that carries it', () => {
    const surfaced: AskUserPermissionRequest[] = [];
    const bridge = new ElicitationAskUserBridge({
      idPrefix: 'test-elicit',
      withdraw: () => {},
      surface: request => { surfaced.push(request.askUser); },
      permissionMode: () => 'default',
      timeoutMs: () => 60_000,
    });

    // Settled by `cancelAll` below; the assertion is on what was SURFACED.
    bridge.ask(question()).catch(() => {});

    // The renderer arms its countdown from this field and from nothing else, so
    // an unstamped card is a knob that silently governs one runtime out of three.
    expect(surfaced).toHaveLength(1);
    expect(surfaced[0]!.timeoutMs).toBe(60_000);
    bridge.cancelAll('test over');
  });

  it('leaves the card unclocked when the setting is "never"', () => {
    const surfaced: AskUserPermissionRequest[] = [];
    const bridge = new ElicitationAskUserBridge({
      idPrefix: 'test-elicit',
      withdraw: () => {},
      surface: request => { surfaced.push(request.askUser); },
      permissionMode: () => 'default',
      timeoutMs: () => undefined,
    });

    // Settled by `cancelAll` below; the assertion is on what was SURFACED.
    bridge.ask(question()).catch(() => {});

    expect(surfaced[0]!.timeoutMs).toBeUndefined();
    bridge.cancelAll('test over');
  });

  it('refuses before surfacing anything in dontAsk mode', async () => {
    const surfaced: AskUserPermissionRequest[] = [];
    const bridge = new ElicitationAskUserBridge({
      idPrefix: 'test-elicit',
      withdraw: () => {},
      surface: request => { surfaced.push(request.askUser); },
      permissionMode: () => 'dontAsk',
      timeoutMs: () => undefined,
    });

    // Aborted for the same reason as the runtime-level case: without the guard
    // the ask waits on a card, and a test that hangs on a regression reports
    // nothing. With the guard it throws before the signal is ever consulted.
    const controller = new AbortController();
    const pending = bridge.ask(question(), controller.signal);
    controller.abort();

    await expect(pending).rejects.toThrow(/never prompts/);
    expect(surfaced).toHaveLength(0);
  });
});
