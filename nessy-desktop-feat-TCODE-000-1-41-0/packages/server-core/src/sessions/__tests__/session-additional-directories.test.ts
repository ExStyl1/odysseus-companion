import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createTestSessionManager } from './test-session-manager.ts'

/**
 * R15 - a `PermissionRequest` hook's `updatedPermissions` `addDirectories`
 * entry widens the SESSION, so every gate that consults the configured
 * `additionalDirectories` has to consult the granted roots too. Before this,
 * only `runPreToolUseChecks` did, and four SessionManager gates decided
 * differently from it on the identical path.
 */
type Internals = {
  sessionAdditionalDirectories(managed: unknown): string[]
}

const managerFile = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'SessionManager.ts',
)

/**
 * C3.337 — the method now reads `managed.workspace.rootPath` to resolve the
 * primary root it ORDERS by, so the rigs hand it a session shaped like one.
 * Before this row they passed a bare `{ agent }`, which was enough while the
 * method only merged two lists.
 */
function session(overrides: Record<string, unknown>): unknown {
  return { workspace: { rootPath: '/repo' }, ...overrides }
}

describe('session-granted additional directories', () => {
  test('a hook grant is merged with the configured list, deduplicated', () => {
    const manager = createTestSessionManager() as unknown as Internals
    const agent = { getSessionAdditionalDirectories: () => ['/granted/root', '/granted/root'] }
    const merged = manager.sessionAdditionalDirectories(session({ agent }))
    expect(merged).toContain('/granted/root')
    expect(merged.filter(root => root === '/granted/root')).toHaveLength(1)
  })

  test('a backend without the grant, or with none, widens nothing', () => {
    const manager = createTestSessionManager() as unknown as Internals
    const configured = manager.sessionAdditionalDirectories(session({ agent: null }))
    expect(manager.sessionAdditionalDirectories(session({ agent: {} }))).toEqual(configured)
    expect(manager.sessionAdditionalDirectories(session({
      agent: { getSessionAdditionalDirectories: () => [] },
    }))).toEqual(configured)
  })

  // The defect was one gate reading the configured list directly. A source
  // guard is the only cheap way to keep a fifth gate from reintroducing it:
  // the raw getter must have exactly one caller, the merging helper.
  //
  // R57 added a SECOND consumer of the configured list — MCP roots change
  // detection (`mcp.md:108`), which must deliberately NOT merge the session
  // grant, because the MCP pool is shared across every session in the workspace
  // and one session's grant must not widen the roots reported to servers the
  // other sessions are using. It reaches the getter through the
  // `resolveConfiguredMcpRootsFn` field rather than calling it, so this
  // invariant is unchanged and the count stays at one.
  //
  // C3.337 — and the count instrument was RED at HEAD, having stopped being able
  // to tell a gate from a snapshot. C3.178 added a second direct read
  // (`attachedRoots: getConfiguredAdditionalDirectories()`) feeding
  // `resolveSessionPrimaryRoot` for the Pi runtime SNAPSHOT, which is display and
  // reaches no gate — the invariant this case exists for was never violated, but
  // a bare count cannot say so and simply failed. So the case names the call
  // sites instead of counting them: a NEW one is still a failure, and the two
  // that exist are each accounted for by what they feed.
  test('no gate reads the configured list directly any more', () => {
    const source = readFileSync(managerFile, 'utf8')
    const direct = source.split('\n').filter(line => line.includes('getConfiguredAdditionalDirectories()'))
    // The merging helper — the ONE read any permission gate may reach.
    expect(direct).toContain('    const configured = getConfiguredAdditionalDirectories()')
    // C3.178's snapshot input. Display-only: `resolveSessionPrimaryRoot` can
    // answer only with a member of the set it is handed, and its answer reaches
    // `PiHarnessFilesystemScopeSummaryV1` and this file's ORDERING, never an
    // authority.
    expect(direct).toContain('      attachedRoots: getConfiguredAdditionalDirectories(),')
    // A THIRD read is the defect this case was written for, and it still fails.
    expect(direct).toHaveLength(2)
  })

  /**
   * C3.337 — the gate's `Additional:` list is ordered primary-first.
   *
   * `orderAttachedRoots` (`packages/shared/src/config/primary-directory.ts`)
   * shipped with C3.178 and no consumer; C3.305 measured four of the five
   * candidates out and named this one as the only honest consumer, unreachable
   * from that module because the list arrives pre-built from here.
   *
   * The order is DISPLAY: every caller passes this list as
   * `shouldAllowToolInMode`'s `additionalDirectories`, where containment is a
   * `some(...)`, so no decision can read it. What reads it is the refusal text in
   * `agent/mode-manager.ts` symbol `shouldAllowToolInMode` — the `Additional:`
   * block and the `Additional directory:` hints.
   */
  describe('C3.337 — the primary folder leads the list', () => {
    const roots = ['/srv/data', '/srv/logs', '/repo']

    test('the session primary root is moved to the front, and nothing else moves', () => {
      const manager = createTestSessionManager() as unknown as Internals
      const ordered = manager.sessionAdditionalDirectories(session({
        agent: { getSessionAdditionalDirectories: () => roots },
      }))
      // `/repo` is the workspace root the rig gives, and with no stored choice
      // that derivation IS the primary root.
      expect(ordered[0]).toBe('/repo')
      // NEVER a filter and never an addition: the same SET, in a new order.
      // Derived from a control call rather than from a literal, so a config dir
      // that carries its own attached folders cannot make this vacuous.
      const configured = manager.sessionAdditionalDirectories(session({ agent: null }))
      expect([...ordered].sort()).toEqual([...new Set([...configured, ...roots])].sort())
      // The non-primary roots keep their configured order relative to each other.
      expect(ordered.indexOf('/srv/data')).toBeLessThan(ordered.indexOf('/srv/logs'))
    })

    test('NEGATIVE — a list with no primary member is returned in its own order', () => {
      const manager = createTestSessionManager() as unknown as Internals
      const other = ['/srv/data', '/srv/logs']
      const ordered = manager.sessionAdditionalDirectories(session({
        agent: { getSessionAdditionalDirectories: () => other },
      }))
      // Nothing is invented: `/repo` is the primary root and is not in the list,
      // so the list is unchanged rather than gaining it.
      expect(ordered).not.toContain('/repo')
      expect(ordered.indexOf('/srv/data')).toBeLessThan(ordered.indexOf('/srv/logs'))
    })
  })
})
