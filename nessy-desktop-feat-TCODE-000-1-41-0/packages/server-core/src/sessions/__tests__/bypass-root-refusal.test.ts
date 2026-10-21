/**
 * T4 — bypassPermissions refuses root/sudo, door 1 (session create).
 *
 * Integration proof through the REAL `SessionManager.createSession`, not just
 * the guard's own unit tests (`packages/shared/src/agent/pi-harness/bypass-root-guard.test.ts`)
 * — this is the actual acceptance point a caller goes through, and it is
 * what a unit test on the guard function alone cannot rule out: that the two
 * doors are actually wired to call it.
 *
 * `process.geteuid` is spied rather than passed as an option because
 * `createSession` calls `assertBypassPermittedForProcess()` with no
 * arguments in production (see SessionManager.ts's door-1 comment) — the
 * only way to drive its default `process.geteuid?.()` branch from outside is
 * to make the real function return 0 for the duration of the test. Skipped
 * on win32, where `process.geteuid` does not exist to spy on (matching the
 * guard's own win32 short-circuit — see `bypass-root-guard.test.ts`).
 */
import { describe, expect, it, spyOn, test } from 'bun:test'
import type { PermissionMode } from '@nessy-agent/shared/agent/mode-types'
import { arrivingModeNeedsReconcile, isBypassPermittedForProcess } from '@nessy-agent/shared/agent/pi-harness/bypass-root-guard'
import { createTestSessionManager } from './test-session-manager.ts'

/**
 * True when THIS process runs inside a recognized container (the euid is forced
 * to 0 so only the container signals decide). The four euid-spying tests below
 * drive the guard through its PRODUCTION call sites, which read the real
 * environment — and on this repo's GitLab CI the test job runs as root in a
 * Kubernetes pod, where the contract says the check is skipped. Expecting a
 * refusal there asserts the opposite of the documented behaviour, so the tests
 * skip with this named reason instead. The guard's own unit tests cover the
 * refusal logic hermetically on every host.
 */
const RUNNING_IN_RECOGNIZED_CONTAINER = isBypassPermittedForProcess({ euid: 0 })
const SKIP_ROOT_REFUSAL_TESTS = process.platform === 'win32' || RUNNING_IN_RECOGNIZED_CONTAINER

describe('SessionManager.createSession refuses bypassPermissions for root', () => {
  test.skipIf(SKIP_ROOT_REFUSAL_TESTS)(
    'root with no container marker: createSession rejects with the coded refusal',
    async () => {
      const manager = createTestSessionManager()
      const euidSpy = spyOn(process, 'geteuid').mockReturnValue(0)
      try {
        await expect(
          manager.createSession('workspace-bypass-root-refusal', { permissionMode: 'bypassPermissions' }),
        ).rejects.toThrow('bypassPermissions cannot be used with root/sudo privileges for security reasons')
      } finally {
        euidSpy.mockRestore()
        manager.cleanup()
      }
    },
  )
})

describe('SessionManager.setSessionPermissionMode refuses bypassPermissions for root', () => {
  // Door 2. The review that asked for this test made the point precisely: door
  // 1 had an end-to-end proof and door 2 had only the guard's unit tests plus a
  // reading of the source, which is exactly the evidence that cannot show a
  // call site was never wired.
  test.skipIf(SKIP_ROOT_REFUSAL_TESTS)(
    'root with no container marker: switching an existing session into bypass throws',
    async () => {
      const manager = createTestSessionManager()
      try {
        const session = await manager.createSession('workspace-bypass-root-door2', { permissionMode: 'default' })
        const euidSpy = spyOn(process, 'geteuid').mockReturnValue(0)
        try {
          expect(() => manager.setSessionPermissionMode(session.id, 'bypassPermissions'))
            .toThrow('bypassPermissions cannot be used with root/sudo privileges for security reasons')
        } finally {
          euidSpy.mockRestore()
        }
      } finally {
        manager.cleanup()
      }
    },
  )
})

describe('an ARRIVING bypassPermissions is downgraded, not thrown', () => {
  /**
   * The other half of the same property, and the half a `throw` would get
   * wrong. A restored or imported session carries a mode as DATA; refusing to
   * load it at all would cost the user the whole session over one field. The
   * host clamps it to `default` and logs instead — so the assertion here is
   * that the session LOADS and is not in bypass, not that anything threw.
   */
  test.skipIf(SKIP_ROOT_REFUSAL_TESTS)(
    'a persisted session whose mode is bypassPermissions loads in default on a root host',
    async () => {
      const manager = createTestSessionManager()
      const euidSpy = spyOn(process, 'geteuid').mockReturnValue(0)
      try {
        const managed: { id: string; permissionMode: PermissionMode; workspace: { id: string } } = {
          id: 'arriving-bypass',
          permissionMode: 'bypassPermissions',
          workspace: { id: 'workspace-arriving-bypass' },
        }
        const changed = (manager as unknown as {
          normalizePersistedSessionPermissionMode(m: typeof managed): boolean
        }).normalizePersistedSessionPermissionMode(managed)

        expect(changed).toBe(true)
        expect(managed.permissionMode).toBe('default')
      } finally {
        euidSpy.mockRestore()
        manager.cleanup()
      }
    },
  )
})

describe('the clamp reaches the authoritative mode state, not just the managed session', () => {
  /**
   * The defect the final whole-branch review found in the FIRST version of this
   * fix. `BaseAgent.setPermissionMode` writes the mode-manager singleton before
   * firing `onPermissionModeChange`, and that singleton is what the permission
   * gate reads. On a refusing host the load-time clamp has already put
   * `managed.permissionMode` at `default`, so the callback's clamp produced an
   * EQUAL value, hit the same-mode early return, and never reconciled — the
   * singleton kept `bypassPermissions` while the log line said it had been
   * refused. The two halves of the protection cancelled each other out.
   *
   * Driving the real callback needs a live agent subprocess, which this harness
   * has none of, so the RULE is pinned here and the wired path is proven by the
   * live run. Asserting on `managed` alone would pass in the broken state.
   */
  it('a clamped arrival that equals the session mode still demands reconciliation', () => {
    expect(arrivingModeNeedsReconcile({
      arriving: 'bypassPermissions',
      clamped: 'default',
      managed: 'default',
    })).toBe(true)
  })

  it('an unclamped arrival that equals the session mode is a genuine no-op', () => {
    expect(arrivingModeNeedsReconcile({
      arriving: 'default',
      clamped: 'default',
      managed: 'default',
    })).toBe(false)
  })

  it('an arrival that differs from the session mode takes the normal path, not the reconcile branch', () => {
    expect(arrivingModeNeedsReconcile({
      arriving: 'bypassPermissions',
      clamped: 'default',
      managed: 'plan',
    })).toBe(false)
  })
})

describe('previousPermissionMode is clamped as well', () => {
  test.skipIf(SKIP_ROOT_REFUSAL_TESTS)(
    'previousPermissionMode is clamped too, so a plan exit cannot throw on a root host',
    async () => {
      const manager = createTestSessionManager()
      const euidSpy = spyOn(process, 'geteuid').mockReturnValue(0)
      try {
        const managed: { id: string; permissionMode: PermissionMode; previousPermissionMode: PermissionMode; workspace: { id: string } } = {
          id: 'arriving-previous-bypass',
          permissionMode: 'plan',
          previousPermissionMode: 'bypassPermissions',
          workspace: { id: 'workspace-arriving-previous' },
        }
        const changed = (manager as unknown as {
          normalizePersistedSessionPermissionMode(m: typeof managed): boolean
        }).normalizePersistedSessionPermissionMode(managed)

        expect(changed).toBe(true)
        expect(managed.previousPermissionMode).toBe('default')
        expect(managed.permissionMode).toBe('plan')
      } finally {
        euidSpy.mockRestore()
        manager.cleanup()
      }
    },
  )
})
