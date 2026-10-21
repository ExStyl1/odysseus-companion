/**
 * P6.714 — the managed pin holds BETWEEN the doors, not only at them.
 *
 * P6.492 made the resume door runtime-uniform and P6.685 the create door. This
 * is the third and last one that was still `provider === 'pi'`:
 * `normalizeSessionPermissionMode`, which every MID-SESSION change funnels
 * through — the RPC `setPermissionMode`, plan-mode approve/exit restore, and the
 * agent's own `onPermissionModeChange` (`acceptPlan` left with F1.259). While it
 * was gated, a claude or codex session created in an allowed mode could be
 * switched into a mode the administrator had turned off and stay there for the
 * rest of its life, with nothing saying so.
 *
 * Driven through the REAL `setSessionPermissionMode` on all three runtimes,
 * because a unit test on the normalizer cannot rule out the door never calling
 * it — which is exactly what was wrong. The provider of every arm is ASSERTED
 * rather than assumed: a session created against the bare test manager resolves
 * to `pi`, so an arm that did not install its connection would pass identically
 * with the Pi-only branch restored.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, rmSync } from 'node:fs'
import type { StoredConfig } from '@nessy-agent/shared/config/storage'
import type { PermissionMode } from '@nessy-agent/shared/agent/mode-types'
import type { ManagedPiPolicyV1 } from '@nessy-agent/shared/agent/pi-harness/managed-policy'
import { createTestSessionManager } from './test-session-manager.ts'
import { MODULE_GRAPH_HOOK_BUDGET_MS } from '@nessy-agent/shared/testing/module-graph-budgets'

const TEST_CONNECTIONS = [
  {
    slug: 'pi-conn',
    name: 'Pi',
    providerType: 'pi',
    authType: 'api_key',
    defaultModel: 'pi-model-a',
    createdAt: Date.now(),
  },
  {
    slug: 'claude-conn',
    name: 'Claude Code (Nessy Gateway)',
    providerType: 'claude-runtime',
    authType: 'bearer_token',
    defaultModel: 'claude-gw-model-a',
    createdAt: Date.now(),
  },
  {
    slug: 'codex-conn',
    name: 'Codex',
    providerType: 'codex-runtime',
    authType: 'bearer_token',
    defaultModel: 'codex-model-a',
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
  storage.saveConfig({ ...base, defaultLlmConnection: 'pi-conn', llmConnections: TEST_CONNECTIONS })
  restoreConfig = () => {
    if (previous) storage.saveConfig(previous)
    else if (existsSync(configPath)) rmSync(configPath)
  }
}, MODULE_GRAPH_HOOK_BUDGET_MS)

afterAll(() => { restoreConfig() })

function policy(overrides: Partial<ManagedPiPolicyV1> = {}): ManagedPiPolicyV1 {
  return { schemaVersion: 1, disabledPermissionModes: [], ...overrides }
}

/** Create a session in an ALLOWED mode, then ask for `switchTo` mid-session. */
async function modeAfterMidSessionSwitch(
  workspaceId: string,
  connectionSlug: string,
  managedPiPolicy: ManagedPiPolicyV1,
  switchTo: PermissionMode,
): Promise<{ mode: PermissionMode | undefined; provider: string | undefined }> {
  const manager = createTestSessionManager({ managedPiPolicy })
  try {
    const session = await manager.createSession(workspaceId, {
      llmConnection: connectionSlug,
      permissionMode: 'default',
    })
    manager.setSessionPermissionMode(session.id, switchTo, workspaceId)
    const after = await manager.getSession(session.id, workspaceId)
    return {
      mode: after?.permissionMode,
      provider: manager.getSessionProvider(session.id, workspaceId),
    }
  } finally {
    await manager.cleanup()
  }
}

const RUNTIMES: Array<{ label: string; slug: string; provider: string }> = [
  { label: 'pi', slug: 'pi-conn', provider: 'pi' },
  // `AgentProvider` is the BACKEND name, not the connection's providerType:
  // a `claude-runtime` connection resolves to `anthropic` (measured), while a
  // `codex-runtime` one keeps its own spelling. Both are asserted so an arm
  // that quietly fell back to Pi cannot pass.
  { label: 'claude', slug: 'claude-conn', provider: 'anthropic' },
  { label: 'codex', slug: 'codex-conn', provider: 'codex-runtime' },
]

describe('a disabled mode cannot be entered mid-session on any runtime', () => {
  for (const runtime of RUNTIMES) {
    test(`${runtime.label}: the pin wins over a mid-session switch`, async () => {
      // `acceptEdits` is disabled by the administrator; the ladder's next rung
      // down is `default`, which is where the session already is. Before this
      // row the claude and codex arms landed in `acceptEdits` — the disabled
      // mode itself — and stayed there.
      const { mode, provider } = await modeAfterMidSessionSwitch(
        `workspace-p6714-pin-${runtime.label}`,
        runtime.slug,
        policy({ disabledPermissionModes: ['acceptEdits'] }),
        'acceptEdits',
      )
      expect(mode).toBe('default')
      // The control: without this, an arm that silently resolved to Pi would
      // pass with the Pi-only branch restored and prove nothing.
      expect(provider).toBe(runtime.provider)
    })

    test(`${runtime.label}: an unpinned session is unchanged`, async () => {
      const { mode, provider } = await modeAfterMidSessionSwitch(
        `workspace-p6714-open-${runtime.label}`,
        runtime.slug,
        policy(),
        'acceptEdits',
      )
      expect(mode).toBe('acceptEdits')
      expect(provider).toBe(runtime.provider)
    })
  }
})
