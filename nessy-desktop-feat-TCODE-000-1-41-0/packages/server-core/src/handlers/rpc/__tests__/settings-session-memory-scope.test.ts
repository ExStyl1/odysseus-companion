/**
 * P6.703 — the per-chat memory scope verb.
 *
 * The model shipped complete in `agent/memory/session-memory-scope.ts` and
 * nothing persisted an override, so `resolveSessionMemoryScope` was called with
 * `undefined` on every turn. This is the wire half; the session-record field and
 * the resolver plumbing are another lane's files this hour, which is why the
 * manager methods are OPTIONAL on `ISessionManager` and why the first case here
 * is the refusal.
 *
 * The refusal is the load-bearing one. A verb that answered a default while the
 * record side was missing would report "no override" for a chat the user had
 * excluded — indistinguishable from success, and the exact failure the row
 * exists to close.
 */

import { describe, expect, it } from 'bun:test'
import { RPC_CHANNELS } from '@nessy-agent/shared/protocol'
import type { SessionMemoryScopeOverride } from '@nessy-agent/shared/agent/memory/session-memory-scope'
import type { HandlerFn, RpcServer } from '@nessy-agent/server-core/transport'
import type { HandlerDeps } from '../../handler-deps'
import { registerSettingsHandlers } from '../settings'

function harness(withManager: boolean, provider?: string) {
  const writes: Array<{ sessionId: string; override: SessionMemoryScopeOverride; workspaceId: string | undefined }> = []
  const registered = new Map<string, HandlerFn>()
  const server = {
    handle(channel: string, handler: HandlerFn) { registered.set(channel, handler) },
    push() {},
    async invokeClient() { return undefined },
    hasClientCapability() { return false },
    findClientsWithCapability() { return [] },
  } as RpcServer
  const manager = withManager
    ? {
        getSessionMemoryScope() {
          return { scope: { read: true, write: false }, override: { write: false } }
        },
        async setSessionMemoryScope(sessionId: string, override: SessionMemoryScopeOverride, workspaceId?: string) {
          writes.push({ sessionId, override, workspaceId })
          return {
            override,
            scope: { read: override.read ?? true, write: override.write ?? true },
          }
        },
        // D1.215 — the runtime gate. Absent unless a case asks for one, so every
        // case written before this row keeps measuring what it measured.
        ...(provider ? { getSessionProvider: () => provider } : {}),
      }
    : {}
  const deps = {
    sessionManager: manager,
    platform: { logger: { info() {}, warn() {}, error() {}, debug() {} } },
    oauthFlowStore: {},
  } as unknown as HandlerDeps
  registerSettingsHandlers(server, deps)
  return { registered, writes }
}

const ctx = { clientId: 'client-a', workspaceId: 'ws-a', webContentsId: null }

describe('the per-chat memory scope verb', () => {
  it('registers both halves', () => {
    const { registered } = harness(true)
    expect(registered.has(RPC_CHANNELS.sessions.GET_MEMORY_SCOPE)).toBe(true)
    expect(registered.has(RPC_CHANNELS.sessions.SET_MEMORY_SCOPE)).toBe(true)
  })

  it('REFUSES BY NAME while the record side is absent, instead of answering a default', () => {
    const { registered } = harness(false)
    const read = registered.get(RPC_CHANNELS.sessions.GET_MEMORY_SCOPE)!
    const write = registered.get(RPC_CHANNELS.sessions.SET_MEMORY_SCOPE)!
    expect(read(ctx, 'session-1', 'workspace-1')).rejects.toThrow(/not available on this server/)
    expect(write(ctx, 'session-1', 'workspace-1', { read: false })).rejects.toThrow(/not available on this server/)
  })

  it('answers the stored override AND the effective scope, because they render differently', async () => {
    // "off" and "following the app-wide setting" must not look the same, or a
    // user who turned memory off globally believes every chat was excluded.
    const { registered } = harness(true)
    const result = await registered.get(RPC_CHANNELS.sessions.GET_MEMORY_SCOPE)!(ctx, 'session-1', 'workspace-1')
    // D1.215 added the third key; the two this case is about are unchanged, and
    // an empty list is the right answer for a manager that names no runtime.
    expect(result).toEqual({ scope: { read: true, write: false }, override: { write: false }, notices: [] })
  })

  /**
   * D1.215 / D1.139 — the notices ride BOTH verbs, and nothing but claude gets
   * any.
   *
   * The write half is not a duplicate of the read half: the menu re-renders from
   * the WRITE's result, so a notice list on the read alone would vanish the
   * moment a user touched a switch — and the memory notice is exactly the one a
   * write can change.
   *
   * `workspaceClaudeConfigDir` is not exercised here (this harness has no real
   * workspace) and does not need to be: the derivation it feeds is driven
   * directly in `packages/shared/src/protocol/__tests__/session-runtime-notices.test.ts`.
   * What this file owns is the WIRING — which verbs carry the field, and which
   * sessions get an empty one.
   */
  it('attaches the runtime notices to both verbs on a claude session', async () => {
    const { registered } = harness(true, 'anthropic')
    const read = await registered.get(RPC_CHANNELS.sessions.GET_MEMORY_SCOPE)!(ctx, 'session-1', 'workspace-1')
    const write = await registered.get(RPC_CHANNELS.sessions.SET_MEMORY_SCOPE)!(ctx, 'session-1', 'workspace-1', {})
    // The two verbs answer DIFFERENT memory dispositions here, and that is the
    // assertion rather than an inconvenience: this harness reads back a chat
    // whose write axis is off (so the runtime's own store is closed) and then
    // writes an empty override (so both axes follow the app-wide switch and the
    // runtime decides). A notice that did not track the scope would answer the
    // same id twice.
    for (const [name, result, expected] of [
      ['read', read, 'claude-auto-memory-off-by-host'],
      ['write', write, 'claude-auto-memory-runtime-default'],
    ] as const) {
      const notices = (result as { notices?: readonly { id: string }[] }).notices ?? []
      expect(notices.length, `the ${name} verb carries no notices`).toBeGreaterThan(0)
      expect(notices.map(notice => notice.id), `the ${name} verb names no memory disposition`)
        .toContain(expected)
      // The postures that are not about memory ride both verbs unchanged.
      expect(notices.map(notice => notice.id), `the ${name} verb dropped the standing postures`)
        .toEqual([expected, 'claude-search-results-filtered', 'claude-worktree-cwd-may-move'])
    }
  })

  it('answers an EMPTY list on the other runtimes, and never touches the filesystem for one', async () => {
    // The negative, and it is also the cost control: the config-dir resolver
    // CREATES the directory it names, so a pi or codex session opening this menu
    // must not grow a `claude-config/` it will never use.
    for (const provider of ['pi', 'codex-runtime'] as const) {
      const { registered } = harness(true, provider)
      const result = await registered.get(RPC_CHANNELS.sessions.GET_MEMORY_SCOPE)!(ctx, 'session-1', 'workspace-1')
      expect((result as { notices?: readonly unknown[] }).notices, `${provider} got notices`).toEqual([])
    }
  })

  it('accepts an ABSENT axis as a real value — it means "follow the app-wide switch"', async () => {
    const { registered, writes } = harness(true)
    const write = registered.get(RPC_CHANNELS.sessions.SET_MEMORY_SCOPE)!
    await write(ctx, 'session-1', 'workspace-1', { read: false })
    await write(ctx, 'session-1', 'workspace-1', {})
    expect(writes.map(entry => entry.override)).toEqual([{ read: false }, {}])
    expect(writes[0]?.workspaceId).toBe('workspace-1')
  })

  it('refuses a non-boolean axis rather than resolving it to the global default', async () => {
    // The silent-coercion case: `'false'` is truthy, and an axis coerced from
    // the wrong shape looks applied while doing the opposite of what was asked.
    const { registered, writes } = harness(true)
    const write = registered.get(RPC_CHANNELS.sessions.SET_MEMORY_SCOPE)!
    await expect(write(ctx, 's', 'w', { read: 'false' } as never)).rejects.toThrow(/read must be a boolean/)
    await expect(write(ctx, 's', 'w', null as never)).rejects.toThrow(/must be an object/)
    expect(writes).toEqual([])
  })
})
