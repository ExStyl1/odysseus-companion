/**
 * `mcp.md:108` — "Claude Code answers `roots/list` with the session's launch
 * directory plus every additional working directory you've granted with
 * `--add-dir`, `/add-dir`, or the `additionalDirectories` setting", and "Claude
 * Code sends `notifications/roots/list_changed` when that set changes."
 *
 * This file covers the second half — WHEN the notification goes out. The first
 * half (the capability, the `file://` URIs, the request handler) is pinned in
 * `packages/shared/src/mcp/__tests__/client-transport.test.ts`.
 *
 * Every assertion drives the SHIPPED `notifyMcpRootsIfChanged`; only its two
 * edges are pinned — the resolved-directories read and the pool fan-out — the
 * same way `resolveNetworkAddressesFn` and `resolveChannelPolicy` are pinned.
 */
import { describe, expect, test } from 'bun:test'
import { createTestSessionManager } from './test-session-manager.ts'

interface Internals {
  lastNotifiedMcpRoots: string | null
  resolveConfiguredMcpRootsFn: () => readonly string[]
  workspaceMcpPools: { notifyRootsChanged(): Promise<void> }
  notifyMcpRootsIfChanged(): void
}

function harness() {
  const manager = createTestSessionManager()
  const internals = manager as unknown as Internals
  let dirs: string[] = ['/a']
  let fanouts = 0
  internals.resolveConfiguredMcpRootsFn = () => dirs
  // Patch the ONE method, leaving the real registry (and its `dispose`, which
  // `cleanup()` calls) intact.
  internals.workspaceMcpPools.notifyRootsChanged = async () => { fanouts += 1 }
  // `createTestSessionManager` may already have seeded the baseline through
  // `setupConfigWatcher`; clear it so each case starts from a known state.
  internals.lastNotifiedMcpRoots = null
  return {
    manager,
    internals,
    set: (next: string[]) => { dirs = next },
    observe: async () => { internals.notifyMcpRootsIfChanged(); await Promise.resolve() },
    get fanouts() { return fanouts },
  }
}

describe('notifications/roots/list_changed', () => {
  test('the first observation is a baseline, not a change', async () => {
    const h = harness()
    await h.observe()
    // Servers just received this set as their handshake answer; re-announcing it
    // would be a notification with nothing behind it.
    expect(h.fanouts).toBe(0)
    expect(h.internals.lastNotifiedMcpRoots).toBe('["/a"]')
    await h.manager.cleanup()
  })

  test('a changed set notifies exactly once', async () => {
    const h = harness()
    await h.observe()
    h.set(['/a', '/b'])
    await h.observe()
    expect(h.fanouts).toBe(1)
    await h.manager.cleanup()
  })

  test('a config write that leaves the resolved set identical notifies nothing', async () => {
    const h = harness()
    await h.observe()
    h.set(['/a', '/b'])
    await h.observe()
    // `:108` binds the notification to "when that set changes", and the config
    // watcher fires on EVERY config.json write — so an unrelated settings edit,
    // and a re-added entry that canonicalizes onto a path already present, must
    // both be silent.
    await h.observe()
    await h.observe()
    expect(h.fanouts).toBe(1)
    await h.manager.cleanup()
  })

  test('an emptied list is a change, not a no-op', async () => {
    // `null` (never observed) and `[]` (observed, empty) must not collapse:
    // removing the last additional directory narrows what servers may reach.
    const h = harness()
    await h.observe()
    h.set([])
    await h.observe()
    expect(h.fanouts).toBe(1)
    expect(h.internals.lastNotifiedMcpRoots).toBe('[]')
    await h.manager.cleanup()
  })
})
