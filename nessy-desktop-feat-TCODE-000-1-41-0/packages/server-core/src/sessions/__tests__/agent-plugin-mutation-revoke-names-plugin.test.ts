/**
 * F1.582 (2/2) (origin WJ-be proposed row 5, 2026-09-24, LOW) — when the AGENT uninstalls or disables a plugin with
 * `plugin_manage`, a sibling turn that change stops is told WHICH plugin, as a user's uninstall already says.
 *
 * F1.493 (1) writes the revoke note from the capability invalidation's reason, and `emitPluginMutationInvalidation`
 * appends ` (<pluginKey>)` when its context names one. The RPC path passes the key; the agent path
 * (`afterAgentPluginMutation`, bound to the tools' `afterMutation`) did not, so the note read
 * `plugin_manage:uninstall` alone. Since F1.582 (1/2) the tools hand the key as `afterMutation`'s 4th argument; this
 * half carries it into the invalidation.
 *
 * The rig: the real `SessionManager` with an RPC server stub, the real catalog-invalidation bus
 * (`onCapabilityCatalogInvalidation`), and its revoke listener captured as in `capability-revoke-turn-note.test.ts`;
 * the resolver's step between the two — revoking the lease the invalidation names — is played by the test, which
 * forwards the bus event's reason to the listener for the session holding the lease.
 *
 * CONTROL — a call that names no plugin (prune, `source_manage:remove`) keeps the bare reason. The production
 * binding is pinned by its source line: the four-argument lambda forwards the key.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { onCapabilityCatalogInvalidation } from '@nessy-agent/shared/capabilities/invalidation'
import { createManagedSession } from '../SessionManager.ts'
import { createTestSessionManager } from './test-session-manager.ts'

type Listener = (event: { scope: { kind: string }; effect: string; revokedLeaseIds: string[]; reason?: string }) => void
type AfterAgentPluginMutation = (w: string, p: undefined, r: string, t?: undefined, e?: 'add-or-refresh' | 'remove', k?: string) => Promise<void>

const unsubscribers: Array<() => void> = []
afterEach(() => { for (const off of unsubscribers.splice(0)) off() })

function rig() {
  let listener: Listener | undefined
  const manager = createTestSessionManager({
    subscribeInvalidation: (next: Listener) => { listener = next; return () => { listener = undefined } },
  } as never) as any
  manager.setRpcServer({ handle() {}, push() {}, async invokeClient() { return undefined }, hasClientCapability() { return false }, findClientsWithCapability() { return [] } })
  const workspace = { id: 'ws-f1582', name: 'ws-f1582', slug: 'ws-f1582', rootPath: '/tmp/ws-f1582', createdAt: Date.now() }
  const sibling = createManagedSession({ id: 'sibling' }, workspace, { messagesLoaded: true, ephemeral: true })
  ;(sibling as { capabilityLeaseId?: string }).capabilityLeaseId = 'lease-sibling'
  ;(sibling as { agent: unknown }).agent = { forceAbort: () => {}, isProcessing: () => true }
  manager.sessions.set('ws-f1582:sibling', sibling)
  const reasons: string[] = []
  // The resolver's part: a `revoke-active-snapshot` catalog invalidation revokes the lease the sibling's turn holds.
  unsubscribers.push(onCapabilityCatalogInvalidation(event => {
    reasons.push(event.reason)
    if (event.effect === 'revoke-active-snapshot') listener!({ scope: event.scope, effect: event.effect, revokedLeaseIds: ['lease-sibling'], reason: event.reason })
  }))
  const mutate: AfterAgentPluginMutation = (...args) => (manager.afterAgentPluginMutation as AfterAgentPluginMutation).apply(manager, args)
  const notes = () => (sibling.messages as Array<{ role: string; content: string }>).filter(message => message.role === 'info').map(message => message.content)
  const dispose = async () => { (sibling as { agent: unknown }).agent = null; await manager.cleanup() }
  return { mutate, reasons, notes, dispose }
}

describe('F1.582 (2/2) — the agent\'s plugin_manage revoke names the plugin in the stopped turn\'s note', () => {
  test('THE DEFECT — an agent-run uninstall names the plugin in the invalidation reason and in the sibling\'s note', async () => {
    const { mutate, reasons, notes, dispose } = rig()
    try {
      await mutate('ws-f1582', undefined, 'plugin_manage:uninstall', undefined, 'remove', 'local.toolkit')
      expect(reasons).toEqual(['plugin_manage:uninstall (local.toolkit)'])
      expect(notes()).toHaveLength(1)
      expect(notes()[0]).toContain('plugin_manage:uninstall (local.toolkit)')
    } finally {
      await dispose()
    }
  })

  test('CONTROL — a mutation that names no plugin keeps the bare reason', async () => {
    const { mutate, reasons, notes, dispose } = rig()
    try {
      await mutate('ws-f1582', undefined, 'plugin_manage:prune', undefined, 'remove')
      expect(reasons).toEqual(['plugin_manage:prune'])
      expect(notes()[0]).toContain('plugin_manage:prune.')
    } finally {
      await dispose()
    }
  })

  test('THE BINDING — production\'s afterMutation forwards the tools\' 4th argument to afterAgentPluginMutation', () => {
    const source = readFileSync(join(import.meta.dir, '..', 'SessionManager.ts'), 'utf-8')
    const start = source.indexOf('afterMutation: (reason, target, effect')
    expect(start).toBeGreaterThan(0)
    const binding = source.slice(start, source.indexOf(')', source.indexOf('this.afterAgentPluginMutation(', start)) + 1)
    expect(binding).toContain('afterMutation: (reason, target, effect, pluginKey) =>')
    expect(binding).toMatch(/effect,\s*pluginKey/)
  })
})
