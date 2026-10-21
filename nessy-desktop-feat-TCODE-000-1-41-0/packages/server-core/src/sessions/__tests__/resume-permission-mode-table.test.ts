/**
 * P6.492 — a session that ended in `bypassPermissions` reopens in it, and a
 * restored `auto` gets no eligibility re-check.
 *
 * The contract is `sessions.md#permission-mode-on-resume`, whose table this
 * host now follows for two of its rows and deliberately diverges from on a
 * third (delegated decision 2026-09-05, Q-den 1, option C):
 *
 *  - `bypassPermissions` → *"The permission mode a new session would start in"*
 *  - `auto` → *"`auto`, only when your account still meets the auto mode
 *    requirements"*
 *  - `plan` → the page also resets it; we restore it unchanged, because a plan
 *    session that silently came back as an executing session is the worse of
 *    the two failures.
 *
 * Driven through the REAL `normalizePersistedSessionPermissionMode`, which is
 * the single funnel both restore sites use (`loadSessionsFromDisk` and the
 * import path) — a unit test on the table alone cannot rule out the funnel
 * never calling it.
 *
 * `defaultMode` is set on the managed policy in every arm so the start mode is
 * a FIXED value rather than whatever this machine's config files say: the
 * assertion is about the table, not about the shipped default.
 */
import { describe, expect, test } from 'bun:test'
import type { PermissionMode } from '@nessy-agent/shared/agent/mode-types'
import { isBypassPermittedForProcess } from '@nessy-agent/shared/agent/pi-harness/bypass-root-guard'
import type { ManagedPiPolicyV1 } from '@nessy-agent/shared/agent/pi-harness/managed-policy'
import { createTestSessionManager } from './test-session-manager.ts'

/**
 * The bypass arms assume the host does NOT refuse bypass on its own: on a root
 * host outside a container `clampArrivingBypassForHost` answers first (by
 * design — it is a floor with its own log line), so the resume table never sees
 * the mode and the arm would be measuring the wrong rule.
 */
const HOST_REFUSES_BYPASS = !isBypassPermittedForProcess()

type ArrivingSession = {
  id: string
  permissionMode?: PermissionMode
  previousPermissionMode?: PermissionMode
  workspace: { id: string; rootPath?: string }
}

function policy(overrides: Partial<ManagedPiPolicyV1> = {}): ManagedPiPolicyV1 {
  return { schemaVersion: 1, disabledPermissionModes: [], defaultMode: 'acceptEdits', ...overrides }
}

function normalize(managed: ArrivingSession, managedPiPolicy: ManagedPiPolicyV1): boolean {
  const manager = createTestSessionManager({ managedPiPolicy })
  try {
    return (manager as unknown as {
      normalizePersistedSessionPermissionMode(m: ArrivingSession): boolean
    }).normalizePersistedSessionPermissionMode(managed)
  } finally {
    manager.cleanup()
  }
}

describe('the resume table is applied to an arriving permission mode', () => {
  test.skipIf(HOST_REFUSES_BYPASS)(
    'a session that ended in bypassPermissions comes back in the mode a new session would start in',
    () => {
      const managed: ArrivingSession = {
        id: 'resume-bypass',
        permissionMode: 'bypassPermissions',
        workspace: { id: 'workspace-resume-bypass' },
      }
      expect(normalize(managed, policy())).toBe(true)
      expect(managed.permissionMode).toBe('acceptEdits')
    },
  )

  test('a session that ended in auto is re-checked against current eligibility', () => {
    const managed: ArrivingSession = {
      id: 'resume-auto',
      permissionMode: 'auto',
      workspace: { id: 'workspace-resume-auto' },
    }
    expect(normalize(managed, policy({ disabledPermissionModes: ['auto'] }))).toBe(true)
    expect(managed.permissionMode).toBe('acceptEdits')
  })

  test('an eligible auto is restored unchanged — the re-check is not a blanket reset', () => {
    const managed: ArrivingSession = {
      id: 'resume-auto-eligible',
      permissionMode: 'auto',
      workspace: { id: 'workspace-resume-auto-eligible' },
    }
    expect(normalize(managed, policy())).toBe(false)
    expect(managed.permissionMode).toBe('auto')
  })

  test('plan is restored unchanged — the one deliberate divergence from the table', () => {
    const managed: ArrivingSession = {
      id: 'resume-plan',
      permissionMode: 'plan',
      workspace: { id: 'workspace-resume-plan' },
    }
    expect(normalize(managed, policy())).toBe(false)
    expect(managed.permissionMode).toBe('plan')
  })

  test.skipIf(HOST_REFUSES_BYPASS)(
    'the bypass stored as the plan-exit target is reset too, so it cannot ride out of plan mode',
    () => {
      const managed: ArrivingSession = {
        id: 'resume-plan-previous-bypass',
        permissionMode: 'plan',
        previousPermissionMode: 'bypassPermissions',
        workspace: { id: 'workspace-resume-plan-previous' },
      }
      expect(normalize(managed, policy())).toBe(true)
      expect(managed.permissionMode).toBe('plan')
      expect(managed.previousPermissionMode).toBe('acceptEdits')
    },
  )
})
