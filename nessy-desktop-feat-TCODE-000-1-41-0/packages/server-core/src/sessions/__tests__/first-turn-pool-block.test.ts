/**
 * P3.247 — the two sites in `SessionManager` that still awaited a whole MCP
 * connect batch in front of a turn, and the fact that each of them fell on a
 * DIFFERENT single runtime.
 *
 * The mechanism (a dropped `sync` promise is safe because `sync` writes the
 * desired set and hydrates the descriptor cache in its synchronous prefix) is
 * driven end to end over a real `McpPoolServer` in
 * `shared/src/mcp/__tests__/first-turn-connect-block.test.ts`. This file pins
 * the two CALL SITES, because the mechanism being sound says nothing about
 * whether the manager uses it.
 *
 * Both premises the row was dispatched with were wrong in the same direction,
 * and both corrections are asserted here rather than restated in prose:
 *
 * - `BACKEND_CAPABILITIES.needsHttpPoolServer` is true for `codex-runtime`
 *   ALONE, so the session-setup await was codex-only, not "Pi and Codex".
 * - `preflightDpAuth` returned at its first line for any provider other than
 *   `pi`, so the DP preflight blocked Pi alone, not "every runtime".
 *
 * ## That second premise is NO LONGER TRUE, and the third case below says so
 *
 * C3.381 (owner decision 2026-09-12, option A) deleted that first line: every
 * runtime OBSERVES the same dp state and gets the same tool gate, because the
 * old asymmetry shipped two different products behind one card sentence. The
 * same decision made the return value a bare `DpAuthPreflight`
 * (`'ready' | 'needs-login' | 'unavailable'`) instead of
 * `{ ready, sessionState }` — the flag is gone rather than pinned true, so a
 * turn can no longer be stopped by a dp verdict at the type level — and dropped
 * the turn argument with the park it fed.
 *
 * All three cases below pinned the old shape and were red alone at HEAD and on
 * CI job 630520568. They are CONVERTED rather than deleted: P3.247's own
 * proposition (the preflight does not wait for the reconcile it queues) is
 * untouched by C3.381 and is what they still measure.
 */
import { describe, expect, mock, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { BACKEND_CAPABILITIES } from '@nessy-agent/shared/agent/backend/factory'
import { encodeSessionKey } from '@nessy-agent/shared/sessions/session-key'
import { createManagedSession } from '../SessionManager.ts'
import { createTestSessionManager } from './test-session-manager.ts'

const sessionManagerSource = readFileSync(
  new URL('../SessionManager.ts', import.meta.url),
  'utf8',
)

const runtime = {
  provider: 'pi' as const,
  view: { generation: 'gen', sources: [], skills: [], mcpServers: [], promptLayers: [], memory: [] },
  materializer: { assertActive() {} },
}

const turn = {
  message: 'go',
  modelMessage: 'go',
  userMessageId: 'user-1',
  attachments: [],
  storedAttachments: [],
  options: {},
}

/**
 * The preflight's ready branch: dp is materialized with no requirement that
 * needs a login, which is the ONLY path that reaches the reconcile under test.
 */
function readyMaterialization() {
  return {
    sources: [],
    mcpServers: {},
    apiServers: {},
    mergedMcpServers: { linear: { type: 'http', url: 'https://mcp.example.test/mcp' } },
    externalAuthRequirements: [
      { provider: 'dp' as const, wireNames: ['dp-0'], pluginInstanceIds: ['p-0'], state: 'ready' as const },
    ],
  }
}

function fixture(sync: () => Promise<string[]>) {
  const manager = createTestSessionManager({
    resolver: {
      resolve: async () => { throw new Error('unused') },
      releaseSnapshot() {},
      invalidate: mock(() => {}),
      isLeaseActive: () => true,
      referencedInstances: () => new Set(),
      leaseCount: () => 0,
    },
  })
  const managed = createManagedSession({
    id: 'session-1',
    llmConnection: 'pi',
  }, {
    id: 'workspace-1',
    name: 'Workspace',
    rootPath: '/tmp/workspace-1',
    createdAt: 1,
  }, {
    messagesLoaded: true,
    ephemeral: true,
  })
  managed.messages.push({ id: turn.userMessageId, role: 'user', content: turn.message, timestamp: 1 })
  managed.mcpPoolLease = {
    key: { workspaceId: managed.workspace.id },
    pool: { sync } as never,
    leaserId: 'session-1-lease',
    ensureSynced: async () => {},
    materializeRuntime: mock(async () => readyMaterialization()),
    release: async () => {},
  } as never

  const internal = manager as any
  internal.sessions.set(encodeSessionKey({
    workspaceId: managed.workspace.id,
    sessionId: managed.id,
  }), managed)
  internal.sendEvent = mock(() => {})
  internal.persistSession = mock(() => {})
  internal.flushSession = mock(async () => {})
  return { managed, internal }
}

describe('P3.247 · the DP preflight no longer waits for the reconcile it queues', () => {
  test('returns ready before a slow sync settles, having still queued it', async () => {
    let settle: (value: string[]) => void = () => {}
    let calledWith: unknown[] | undefined
    const sync = mock((...args: unknown[]) => {
      calledWith = args
      return new Promise<string[]>(resolve => { settle = resolve })
    })
    const { managed, internal } = fixture(sync as never)

    // A sync that never settles would have hung this call before P3.247. That
    // is the whole assertion: `await` here made an unreachable MCP server able
    // to stall every Pi turn, on a preflight whose own docblock says it "must
    // never be the reason a turn dies".
    const preflight = await internal.preflightDpAuth(managed, runtime)

    expect(preflight).toBe('ready')
    // Deferred, not dropped: the desired set is registered, under this lease's
    // own leaser id, which is what the send path's `dpSessionState` threading
    // depends on.
    expect(sync).toHaveBeenCalledTimes(1)
    expect(calledWith?.[0]).toEqual({ linear: { type: 'http', url: 'https://mcp.example.test/mcp' } })
    expect(calledWith?.[2]).toEqual({ leaserId: 'session-1-lease' })

    settle([])
  })

  test('a reconcile that REJECTS no longer takes the turn down with it', async () => {
    const sync = mock(async () => { throw new Error('pool exploded') })
    const { managed, internal } = fixture(sync as never)

    // Before P3.247 this rejection propagated out of `preflightDpAuth` and out
    // of `sendMessage`, replacing the answer with a raw error — the exact
    // failure mode the `materializeRuntime` try/catch two blocks above was
    // added to close, left open on the line beneath it.
    expect(await internal.preflightDpAuth(managed, runtime)).toBe('ready')
    expect(sync).toHaveBeenCalledTimes(1)
  })

  test('a non-Pi provider takes the SAME path now, which is what C3.381 decided', async () => {
    const sync = mock(async () => [])
    const { managed, internal } = fixture(sync as never)

    const preflight = await internal.preflightDpAuth(
      managed,
      { ...runtime, provider: 'codex-runtime' as const },
    )

    // This case used to be the positive control for an ASYMMETRY: it asserted
    // that a non-Pi provider returned at the method's first line with
    // `'unavailable'` and never reached a reconcile. C3.381 deleted that line
    // by owner decision, because it meant a lapsed `dp` session paused a Pi turn
    // behind an auth card while the same lapse on claude/codex was reported as
    // the one state the two-tier gate treats as "do not evict" — so the builtin
    // dp servers were spawned anyway against a signed-out dp.
    //
    // Converted rather than deleted, and the ARMS ARE INVERTED on purpose: the
    // old pair could be satisfied by a method that did nothing at all, where
    // this pair fails both if the early return comes back AND if the reconcile
    // stops being reached. Pi's own verdict is the case above; that the two
    // agree is the whole of the decision.
    expect(preflight).toBe('ready')
    expect(sync).toHaveBeenCalledTimes(1)
  })
})

describe('P3.247 · the session-setup reconcile no longer waits either', () => {
  /**
   * Pinned structurally for the reason `runtime-switch-session.test.ts` pins the
   * handoff closure that way: this line lives inside `getOrCreateAgentUnchecked`
   * and no test can reach it without standing up a whole codex session setup.
   * The slice's own positive control comes first, so a `.toContain` below is
   * about this branch and not a lucky substring in a 22 000-line file.
   */
  test('the shipped setup branch drops the promise instead of awaiting it', () => {
    const start = sessionManagerSource.indexOf('if (backendContext.capabilities.needsHttpPoolServer) {')
    expect(start).toBeGreaterThan(0)
    const end = sessionManagerSource.indexOf('this.emitPiHarnessInvalidation(managed, [\'tools\'])', start)
    expect(end).toBeGreaterThan(start)
    const branch = sessionManagerSource.slice(start, end)

    expect(branch).toContain('new McpPoolServer(setupMcpPool')
    expect(branch).toContain('await setupPoolServer.start()')
    expect(branch).toContain('void setupMcpPool.sync(mcpServers, {}, { leaserId: mcpLeaserId })')
    // The failure has to go somewhere: a dropped promise whose rejection is
    // unhandled is a different defect from the one being fixed.
    expect(branch).toContain('.catch(err => sessionLog.debug(')
    expect(branch).not.toContain('await setupMcpPool.sync(')
  })

  test('and it is reached by exactly one runtime', () => {
    // The row said "Pi and Codex pay it". Measured, the capability record says
    // one runtime — so the wait was never a codex tradeoff anyone chose.
    const needs = Object.entries(BACKEND_CAPABILITIES)
      .filter(([, capabilities]) => capabilities.needsHttpPoolServer)
      .map(([provider]) => provider)
    expect(needs).toEqual(['codex-runtime'])
  })
})
