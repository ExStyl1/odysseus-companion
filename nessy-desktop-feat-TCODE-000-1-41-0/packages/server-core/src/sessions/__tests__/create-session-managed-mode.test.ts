/**
 * P6.685 — a managed policy that turns a permission mode off now holds at the
 * CREATE door as well as at the resume door.
 *
 * P6.492 made `startPermissionModeForResume` runtime-uniform and recorded, in
 * the same docblock, that `createSession`'s own branch was still `provider ===
 * 'pi'` — reported as a row rather than changed there, *"because a create-door
 * change is a contract change and this is not"*. This is that row.
 *
 * The defect it removes is the shape this fork keeps finding: the same
 * administrator setting held or did not hold depending on which door a session
 * came through, with nothing saying so. `disabledPermissionModes` is a managed
 * key and was never Pi-scoped, and `normalizeManagedPermissionMode` only ever
 * narrows — it walks a fixed fallback ladder to the first mode the administrator
 * has not disabled, with `plan` as its floor.
 *
 * Driven through the REAL `createSession`, which is the acceptance point a
 * caller goes through: a unit test on the normalizer cannot rule out the door
 * never calling it, which is precisely what was wrong.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, rmSync } from 'node:fs'
import type { StoredConfig } from '@nessy-agent/shared/config/storage'
import type { PermissionMode } from '@nessy-agent/shared/agent/mode-types'
import type { ManagedPiPolicyV1 } from '@nessy-agent/shared/agent/pi-harness/managed-policy'
import { createTestSessionManager } from './test-session-manager.ts'
import { MODULE_GRAPH_HOOK_BUDGET_MS } from '@nessy-agent/shared/testing/module-graph-budgets'

/**
 * A NON-PI default connection, and it is the whole control.
 *
 * Measured first: a session created against the bare test manager resolves to
 * `provider: 'pi'`, so an arm that did not install a connection would pass
 * identically with the Pi-only branch restored — a green test proving nothing,
 * which is the exact failure mode this suite is guarding against elsewhere.
 */
const TEST_CONNECTIONS = [
  {
    slug: 'claude-gateway',
    name: 'Claude Code (Nessy Gateway)',
    providerType: 'claude-runtime',
    authType: 'bearer_token',
    defaultModel: 'claude-gw-model-a',
    createdAt: Date.now(),
  },
] as unknown as NonNullable<StoredConfig['llmConnections']>

let restoreConfig: () => void = () => {}

beforeAll(async () => {
  const storage = await import('@nessy-agent/shared/config/storage')
  const configPath = storage.getConfigPath()
  const previous = existsSync(configPath) ? storage.loadStoredConfig() : null
  const base: StoredConfig = previous ?? ({
    storageLayoutVersion: 2,
    workspaceRefs: [],
    activeWorkspaceId: null,
    activeSessionId: null,
  } as unknown as StoredConfig)
  storage.saveConfig({ ...base, defaultLlmConnection: 'claude-gateway', llmConnections: TEST_CONNECTIONS })
  restoreConfig = () => {
    if (previous) storage.saveConfig(previous)
    else if (existsSync(configPath)) rmSync(configPath)
  }
}, MODULE_GRAPH_HOOK_BUDGET_MS)

afterAll(() => { restoreConfig() })

function policy(overrides: Partial<ManagedPiPolicyV1> = {}): ManagedPiPolicyV1 {
  return { schemaVersion: 1, disabledPermissionModes: [], ...overrides }
}

async function createdMode(
  workspaceId: string,
  managedPiPolicy: ManagedPiPolicyV1,
  requested?: PermissionMode,
): Promise<{ mode: PermissionMode | undefined; provider: string | undefined }> {
  const manager = createTestSessionManager({ managedPiPolicy })
  try {
    const session = await manager.createSession(
      workspaceId,
      requested ? { permissionMode: requested } : {},
    )
    return {
      mode: session.permissionMode,
      provider: manager.getSessionProvider(session.id, workspaceId),
    }
  } finally {
    manager.cleanup()
  }
}

describe('a disabled mode is not the mode a created session starts in', () => {
  test('the managed defaultMode is clamped down the fallback ladder', async () => {
    // `acceptEdits` pinned by the administrator and simultaneously disabled by
    // them: the ladder's next rung is `default`. Before this row a non-Pi
    // session started in `acceptEdits` — the disabled mode itself.
    const { mode } = await createdMode(
      'workspace-p6685-default-mode',
      policy({ defaultMode: 'acceptEdits', disabledPermissionModes: ['acceptEdits'] }),
    )
    expect(mode).toBe('default')
  })

  test('an explicit per-session request is clamped too, not waved through', async () => {
    const { mode } = await createdMode(
      'workspace-p6685-requested',
      policy({ defaultMode: 'default', disabledPermissionModes: ['acceptEdits'] }),
      'acceptEdits',
    )
    expect(mode).toBe('default')
  })

  test('the clamp is a NARROWING only — an allowed mode is untouched', async () => {
    const { mode, provider } = await createdMode(
      'workspace-p6685-allowed',
      policy({ defaultMode: 'acceptEdits', disabledPermissionModes: ['bypassPermissions'] }),
    )
    expect(mode).toBe('acceptEdits')
    // The control, asserted rather than assumed: every arm above ran on a
    // non-Pi session, which is the only reason they say anything at all.
    expect(provider).not.toBe('pi')
  })

  test('a policy that disables nothing changes nothing', async () => {
    const { mode } = await createdMode(
      'workspace-p6685-empty-policy',
      policy({ defaultMode: 'plan' }),
    )
    expect(mode).toBe('plan')
  })
})
