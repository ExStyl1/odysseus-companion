/**
 * D1.327 — every permission mode the product offers must be ENTERABLE.
 *
 * SIT-5b measured `dontAsk` on the packaged 1.40.0 and the app reported the
 * session's mode as `default` on BOTH the pi and the claude card, twice each,
 * with `explore` and `plan` reporting themselves in the same runs as the
 * control that the set call works at all. The managed clamp was excluded by
 * reading it (`normalizeManagedPermissionMode` answers `plan`, not `default`,
 * for a disabled `dontAsk`, and that rig carried no managed policy).
 *
 * `dontAsk` is hidden from every picker on purpose — `PICKER_HIDDEN_MODES`, and
 * `DEFAULT_CYCLABLE_PERMISSION_MODES`' own docblock says it is "settable
 * through config, the CLI flag, and automations only" — so nothing else in this
 * tree drives it through the mid-session door, which is why a mode named in
 * `PERMISSION_MODE_ORDER`, described by `mode.dontAskFullDesc` and given its own
 * row in D1.32's matrix could stop being enterable with no test failing.
 *
 * All SEVEN modes are driven through the REAL `setSessionPermissionMode` and
 * read back through the REAL session DTO, on the pi and the claude card. Six of
 * them are the control: an arm that could only ever report `default` would pass
 * a `dontAsk`-only test written the other way round.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, rmSync } from 'node:fs'
import type { StoredConfig } from '@nessy-agent/shared/config/storage'
import { PERMISSION_MODE_ORDER, type PermissionMode } from '@nessy-agent/shared/agent/mode-types'
import { MODULE_GRAPH_HOOK_BUDGET_MS } from '@nessy-agent/shared/testing/module-graph-budgets'
import { createTestSessionManager } from './test-session-manager.ts'

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

/**
 * Ask for `mode` mid-session and read back what the product reports — the same
 * two surfaces the sitting read: the session DTO the renderer receives, and the
 * mode-manager diagnostics the backend logs.
 */
async function modeAfterSwitch(
  workspaceId: string,
  connectionSlug: string,
  mode: PermissionMode,
): Promise<{
  reported: PermissionMode | undefined
  listed: PermissionMode | undefined
  authoritative: PermissionMode | undefined
  provider: string | undefined
}> {
  const manager = createTestSessionManager()
  try {
    const session = await manager.createSession(workspaceId, {
      llmConnection: connectionSlug,
      permissionMode: 'default',
    })
    manager.setSessionPermissionMode(session.id, mode, workspaceId)
    const after = await manager.getSession(session.id, workspaceId)
    return {
      reported: after?.permissionMode,
      // `getSessions()` is the read the rig took (`scripts/cdp/lib/state.ts`'s
      // `listSessions`), and it is a DIFFERENT projection from `getSession` —
      // both are asserted so a disagreement between them cannot hide.
      listed: manager.getSessions(workspaceId).find(row => row.id === session.id)?.permissionMode,
      // `null` when the session is not resolvable, which is itself an answer:
      // asserted below rather than defaulted, so a lost session cannot read as
      // a mode that round-tripped.
      authoritative: manager.getSessionPermissionModeState(session.id, workspaceId)?.permissionMode,
      provider: manager.getSessionProvider(session.id, workspaceId),
    }
  } finally {
    await manager.cleanup()
  }
}

const RUNTIMES: Array<{ label: string; slug: string; provider: string }> = [
  { label: 'pi', slug: 'pi-conn', provider: 'pi' },
  // A `claude-runtime` connection resolves to the BACKEND name `anthropic`.
  // Asserted rather than assumed: an arm that quietly fell back to Pi would
  // report the same mode and prove nothing about the second runtime.
  { label: 'claude', slug: 'claude-conn', provider: 'anthropic' },
]

describe('D1.327 — every mode in PERMISSION_MODE_ORDER round-trips mid-session', () => {
  for (const runtime of RUNTIMES) {
    for (const mode of PERMISSION_MODE_ORDER) {
      // `bypassPermissions` is refused by `assertBypassPermittedForProcess` on a
      // root/sudo host, which is a host property rather than a mode property —
      // it is driven, and the refusal is accepted as its own answer.
      test(`${runtime.label}: ${mode}`, async () => {
        let result: Awaited<ReturnType<typeof modeAfterSwitch>>
        try {
          result = await modeAfterSwitch(`workspace-d1327-${runtime.label}-${mode.toLowerCase()}`, runtime.slug, mode)
        } catch (error) {
          expect(mode).toBe('bypassPermissions')
          expect(String((error as Error).message)).toContain('bypass')
          return
        }
        expect(result.provider).toBe(runtime.provider)
        expect(result.reported).toBe(mode)
        expect(result.listed).toBe(mode)
        // The DTO and the mode manager must not disagree: the sitting's whole
        // finding was two surfaces answering differently about one session.
        expect(result.authoritative).toBe(mode)
      })
    }
  }
})
