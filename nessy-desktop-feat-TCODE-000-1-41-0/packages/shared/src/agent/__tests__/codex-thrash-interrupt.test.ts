/**
 * P2.437 — the thrash guard named the loop and did not stop it.
 *
 * P6.55's guard counts refills, warns once durably and stamps the turn's
 * terminal reason. Its notice tells the user *"this turn stops instead of
 * looping"* — and nothing stopped it. The adapter observes the notification
 * stream and has no control channel by construction, so the interrupt has to
 * come from the agent.
 *
 * ## The divergence this row decided, pinned here so it is not re-decided by
 * accident
 *
 * Pi's guard disables auto-compaction, making the NEXT overflow terminal. Codex
 * gets `turn/interrupt`, stopping the CURRENT turn. That is not a preference:
 *
 * - Pi's guard trips on an assistant `message_end` with `stopReason: 'error'` —
 *   the model has already failed and the turn is already over. Nothing to
 *   interrupt.
 * - Codex compacts SERVER-SIDE and continues, and never surfaces the overflow
 *   error at all, so its loop does not end on its own. Without an interrupt the
 *   turn keeps compacting and keeps spending gateway tokens; a terminal reason
 *   for an ending that never arrives is worth nothing.
 *
 * Both reach `how-claude-code-works.md#when-context-fills-up`'s "instead of
 * looping" with the only lever their runtime has, and both end on the same
 * shared `auto_compaction_thrashing` reason.
 *
 * The residue is real and asserted as such below: codex's protection is
 * per-TURN. `model_auto_compact_token_limit` is read at app-server start, so
 * there is no mid-session equivalent of Pi's disable, and the next turn starts
 * with a fresh count.
 *
 * Hermetic: credentials, the adapter launcher, the app-server subprocess and the
 * dp-creds reader are faked. Nothing opens a socket or spawns a process.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import * as credentialsIndex from '../../credentials/index.ts';
import * as adapterPackage from '@nessy-agent/codex-responses-adapter';
import * as nestorAuth from '@nessy-agent/codex-responses-adapter/nestor-auth';
import * as codexAgentServer from '@nessy-agent/codex-agent-server';
import type { AdapterHandle } from '@nessy-agent/codex-responses-adapter';
import type { LlmConnection } from '../../config/storage.ts';
import type { BackendConfig } from '../backend/types.ts';
import type { BackendRuntimePayload } from '../backend/internal/driver-types.ts';
import { AUTO_COMPACTION_THRASHING_REFILL_LIMIT } from '../../config/auto-compaction-settings.ts';
import { CodexAutoCompactionThrashGuard } from '../backend/codex/auto-compaction-thrash-guard.ts';
import { CodexEventAdapter } from '../backend/codex/event-adapter.ts';

// ============================================================
// Fakes — the client records every request, which is the whole assertion
// ============================================================

interface Notify { (method: string, params: unknown): void }

const requests: Array<{ method: string; params: unknown }> = [];
let notifyIntoAgent: Notify | null = null;

class FakeRuntimeManager {
  spawn(): unknown { return { pid: 4242 }; }
  async kill(): Promise<void> { /* no child to reap */ }
}

class FakeAppServerClient {
  constructor(_child: unknown, handlers: { onNotification?: Notify }) {
    notifyIntoAgent = (method, params) => handlers.onNotification?.(method, params);
  }
  async request(method: string, params?: unknown): Promise<unknown> {
    requests.push({ method, params });
    return method === 'thread/start' ? { thread: { id: 'thread-p2437' } } : {};
  }
  notify(): void { /* no-op */ }
  close(): void { /* no-op */ }
}

const realCredentials = { ...credentialsIndex };
const realAdapter = { ...adapterPackage };
const realNestorAuth = { ...nestorAuth };
const realCodexAgentServer = { ...codexAgentServer };

mock.module('../../credentials/index.ts', () => ({
  ...realCredentials,
  getCredentialManager: () => ({ getLlmApiKey: async () => null }),
}));

mock.module('@nessy-agent/codex-responses-adapter', () => ({
  ...realAdapter,
  startAdapter: async (): Promise<AdapterHandle> => (
    { port: 46271, close: async () => { /* nothing bound */ } }
  ),
}));

/**
 * DA1.29 — this stub covers BOTH readers of the creds file, not just the one
 * a past call graph used. `codex-agent.ts` imports `readNestorCreds` and no
 * longer imports `readNestorJwt` at all (DA1.12), and a spread isolates only
 * the names it lists: the un-stubbed sibling reads the developer's real
 * `~/.nessy/dp_auth_creds.json` (measured by WA-b, now AGENTS.md §Traps).
 * Both are derived from ONE literal so they cannot drift, and neither is
 * reachable on this suite's paths today — which is exactly why it must not
 * depend on that staying true.
 */
mock.module('@nessy-agent/codex-responses-adapter/nestor-auth', () => ({
  ...realNestorAuth,
  readNestorJwt: () => 'jwt-not-a-real-token',
  readNestorCreds: () => ({ ok: true, jwt: 'jwt-not-a-real-token' }),
}));

mock.module('@nessy-agent/codex-agent-server', () => ({
  ...realCodexAgentServer,
  CodexRuntimeManager: FakeRuntimeManager,
  AppServerClient: FakeAppServerClient,
}));

afterAll(() => {
  mock.module('../../credentials/index.ts', () => realCredentials);
  mock.module('@nessy-agent/codex-responses-adapter', () => realAdapter);
  mock.module('@nessy-agent/codex-responses-adapter/nestor-auth', () => realNestorAuth);
  mock.module('@nessy-agent/codex-agent-server', () => realCodexAgentServer);
});

const { CodexAgent } = await import('../codex-agent.ts');
const { codexDriver } = await import('../backend/internal/drivers/codex.ts');

// ============================================================
// Fixtures
// ============================================================

const MODEL = 'tgpt/qwen35-397b-a17b-fp8';
const GATEWAY_BASE_URL = 'https://code-completion-nestor.tcsbank.ru/api/v1/cli/openai-like/v1';
const TURN_ID = 'cx-turn-p2437';

function connection(): LlmConnection {
  return {
    slug: 'nessy-codex',
    name: 'Nessy Codex',
    providerType: 'codex-runtime',
    authType: 'api_key_with_endpoint',
    baseUrl: GATEWAY_BASE_URL,
    defaultModel: MODEL,
    createdAt: Date.now(),
  } as LlmConnection;
}

function runtimeFor(conn: LlmConnection): BackendRuntimePayload {
  return codexDriver.buildRuntime({
    context: {
      connection: conn,
      provider: 'codex-runtime',
      resolvedModel: MODEL,
      capabilities: { needsHttpPoolServer: false },
    },
    coreConfig: {} as never,
    hostRuntime: {} as never,
    resolvedPaths: { codexBinaryPath: '/fake/codex-app-server' } as never,
  });
}

function agentConfig(): BackendConfig {
  return {
    provider: 'codex-runtime',
    providerType: 'codex-runtime',
    connectionSlug: 'nessy-codex',
    model: MODEL,
    isHeadless: true,
    workspace: {
      id: 'ws-p2437',
      name: 'Test Workspace',
      rootPath: '/tmp/ws-p2437',
      workspaceRootPath: '/tmp/ws-p2437',
      sessionRootPath: '/tmp/ws-p2437/sessions',
    } as never,
    session: {
      id: 'session-p2437',
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      workingDirectory: '/tmp/ws-p2437',
    } as never,
    runtime: runtimeFor(connection()),
  } as BackendConfig;
}

type PrivateAgent = { ensureRuntime: () => Promise<void> };

const live: Array<{ destroy: () => void }> = [];

beforeEach(() => {
  requests.length = 0;
  notifyIntoAgent = null;
  live.length = 0;
});
afterEach(() => { for (const agent of live.splice(0)) agent.destroy(); });

/** A booted agent whose notification handler this suite can drive directly. */
async function bootedAgent(): Promise<{ notify: Notify }> {
  const agent = new CodexAgent(agentConfig());
  live.push(agent);
  await (agent as unknown as PrivateAgent).ensureRuntime();
  if (!notifyIntoAgent) throw new Error('the agent registered no notification handler');
  const notify = notifyIntoAgent;
  // `TurnStartedNotification` nests the id: `{ turn: { id } }`, NOT `turnId`.
  // `readCodexTurnId` reads only that shape, and a flat `turnId` here would
  // leave `activeTurnId` null — which silently turns every assertion below into
  // "no interrupt", passing for the wrong reason.
  notify('turn/started', { threadId: 'thread-p2437', turn: { id: TURN_ID } });
  return { notify };
}

/** One observed compaction, in the item spelling a newer app-server sends. */
function compaction(notify: Notify, id: string): void {
  notify('item/completed', {
    threadId: 'thread-p2437',
    turnId: TURN_ID,
    item: { type: 'contextCompaction', id },
  });
}

function interrupts(): Array<{ method: string; params: unknown }> {
  return requests.filter(r => r.method === 'turn/interrupt');
}

// ============================================================

describe('P2.437 — a codex thrash loop is stopped, not merely named', () => {
  it('sends no interrupt while the compactions are still the healthy path', async () => {
    const { notify } = await bootedAgent();

    // `refills = compactions - 1`, so this is one refill short of the limit.
    for (let i = 0; i < AUTO_COMPACTION_THRASHING_REFILL_LIMIT; i += 1) compaction(notify, `c${i}`);

    // The floor matters: a guard that interrupted here would cut healthy long
    // turns short and look correct doing it.
    expect(interrupts()).toEqual([]);
  });

  it('interrupts the live turn on the compaction that trips the guard', async () => {
    const { notify } = await bootedAgent();

    for (let i = 0; i <= AUTO_COMPACTION_THRASHING_REFILL_LIMIT; i += 1) compaction(notify, `c${i}`);

    // Both ids required — `TurnInterruptParams` has `threadId` AND `turnId`
    // required, and the single-field shape is rejected by the shipped binary.
    expect(interrupts()).toEqual([
      { method: 'turn/interrupt', params: { threadId: 'thread-p2437', turnId: TURN_ID } },
    ]);
  });

  it('interrupts once, however many compactions follow the trip', async () => {
    const { notify } = await bootedAgent();

    for (let i = 0; i <= AUTO_COMPACTION_THRASHING_REFILL_LIMIT + 4; i += 1) compaction(notify, `c${i}`);
    // Any other notification arriving after the trip must not re-fire it either:
    // the guard LATCHES, so the once-ness has to be the agent's own.
    notify('thread/tokenUsage/updated', { threadId: 'thread-p2437', turnId: TURN_ID });

    expect(interrupts()).toHaveLength(1);
  });

  it('still ends the turn NAMED, so the interrupt did not replace the verdict', async () => {
    const { notify } = await bootedAgent();
    for (let i = 0; i <= AUTO_COMPACTION_THRASHING_REFILL_LIMIT; i += 1) compaction(notify, `c${i}`);

    expect(interrupts()).toHaveLength(1);
    // The interrupt provokes `turn/completed`, which the adapter still stamps
    // with the shared reason Pi's guard produces — one ending, one vocabulary.
    notify('turn/completed', { threadId: 'thread-p2437', turnId: TURN_ID });
    expect(interrupts()).toHaveLength(1);
  });

  it('does not re-interrupt a later turn on the strength of this turn’s verdict', async () => {
    const { notify } = await bootedAgent();
    for (let i = 0; i <= AUTO_COMPACTION_THRASHING_REFILL_LIMIT; i += 1) compaction(notify, `c${i}`);
    expect(interrupts()).toHaveLength(1);
    notify('turn/completed', { threadId: 'thread-p2437', turnId: TURN_ID });

    // The first version of this failed here. It latched on the turn id, and the
    // guard's reset runs on `startTurn()` — which `chatImpl` calls — not on this
    // notification, so a new id with a still-tripped guard interrupted a turn
    // that had done nothing wrong. The trip is a consumed EDGE for that reason.
    notify('turn/started', { threadId: 'thread-p2437', turn: { id: 'cx-turn-p2437-b' } });
    compaction(notify, 'next-0');
    expect(interrupts()).toHaveLength(1);
  });

  it('clears an unconsumed trip at the turn boundary, so it cannot leak forward', () => {
    // In production the edge is consumed on the same notification that arms it,
    // so this reset is defensive — which is exactly the kind of line that rots
    // uncovered. Armed and NOT consumed here, the way a turn ending between the
    // two would leave it: `startTurn()` must disarm it, or the next turn's first
    // notification would be interrupted for the previous turn's loop.
    const adapter = new CodexEventAdapter();
    adapter.startTurn();
    for (let i = 0; i <= AUTO_COMPACTION_THRASHING_REFILL_LIMIT; i += 1) {
      adapter.adapt('item/completed', {
        threadId: 't', turnId: 'x', item: { type: 'contextCompaction', id: `c${i}` },
      });
    }

    adapter.startTurn();

    expect(adapter.consumeAutoCompactionThrashTrip()).toBe(false);
  });

  it('THE RESIDUE: protection is per-TURN, unlike Pi’s session-wide disable', () => {
    // Pi calls `session.setAutoCompactionEnabled(false)`, which survives the
    // turn. Codex's trigger is `model_auto_compact_token_limit` in config.toml,
    // read at app-server START, so there is no mid-session equivalent — and
    // respawning the app-server would drop the running thread. A user who
    // re-sends the same oversized read gets a fresh count and thrashes again
    // (once) before the guard trips a second time.
    const guard = new CodexAutoCompactionThrashGuard();
    for (let i = 0; i <= AUTO_COMPACTION_THRASHING_REFILL_LIMIT; i += 1) guard.recordCompaction();
    expect(guard.isTripped).toBe(true);

    guard.resetTurn();
    expect(guard.isTripped).toBe(false);
    expect(guard.refills).toBe(0);
  });
});
