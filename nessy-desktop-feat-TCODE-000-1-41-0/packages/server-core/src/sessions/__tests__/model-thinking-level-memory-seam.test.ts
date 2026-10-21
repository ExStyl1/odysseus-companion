/**
 * D1.273 / I2.5 — the per-model effort memory is WRITTEN by the gesture that
 * already exists, and under the key the read looks for.
 *
 * ## What the row turned out to be
 *
 * The brief asked for "a per-model effort control where the model is shown".
 * There already is one: the model picker's thinking-level submenu, whose
 * `onThinkingLevelChange` reaches `SessionManager.setSessionThinkingLevel`. A
 * second control in settings would give one fact two entry points and would be
 * the LESS native answer — claude persists
 * `Settings.modelSettings[<model>].effortLevel` and Pi 0.84.3 persists
 * `Settings.modelThinkingLevels` as a SIDE EFFECT of choosing, and neither
 * ships an editor. What was missing is the memory, not the affordance.
 *
 * ## The key-spelling check, which is the whole of this file
 *
 * The ladder reads `getModelThinkingLevel(targetBackendContext.resolvedModel)`.
 * The obvious spelling for the write is `managed.model`, and it is WRONG:
 * `resolveModelForProvider` normalises a deprecated id, CLEARS a model that
 * belongs to another provider, and answers the connection's default when
 * `managed.model` is absent. Measured in this rig, `managed.model =
 * 'claude-opus-4-6'` on a session that resolves to `pi` gives
 * `resolvedModel === ''` — so a memory written under `managed.model` would sit
 * at a key the read can never ask for. Both sides now compute the key with the
 * same expression, and the second case drives exactly that divergence.
 *
 * SAFETY: the config directory is the per-process temp one `bunfig.toml`'s
 * preload installs, seeded here with an empty config because
 * `loadConfigForMutation` answers `null` when no `config.json` exists yet — the
 * same precondition every other setter in `storage.ts` has. No real home, no
 * credential.
 */
import { beforeAll, describe, expect, test } from 'bun:test'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { getModelThinkingLevel, setModelThinkingLevel } from '@nessy-agent/shared/config'
import { encodeSessionKey } from '@nessy-agent/shared/sessions/session-key'
import { createTestSessionManager } from './test-session-manager.ts'

interface Internals {
  sessions: Map<string, unknown>
  sendEvent(event: unknown, workspaceId?: string): void
  persistSession(managed: unknown, immediate?: boolean): void
  resolveBackendContextForManaged(managed: unknown): { resolvedModel: string }
  setSessionThinkingLevel(sessionId: string, level: string, workspaceId?: string): Promise<void>
}

beforeAll(() => {
  writeFileSync(
    join(process.env.NESSY_CONFIG_DIR ?? '', 'config.json'),
    JSON.stringify({
      storageLayoutVersion: 2,
      workspaceRefs: [],
      activeWorkspaceId: null,
      activeSessionId: null,
      llmConnections: [],
    }, null, 2),
    'utf-8',
  )
})

function rig(model: string | undefined, suffix: string) {
  const manager = createTestSessionManager()
  const internals = manager as unknown as Internals
  const sessionKey = { workspaceId: 'workspace-d1273', sessionId: `session-d1273-${suffix}` }
  const managed = {
    id: sessionKey.sessionId,
    name: 'D1.273',
    workspace: { id: sessionKey.workspaceId, rootPath: '/tmp/workspace-d1273' },
    model,
    thinkingLevel: 'low',
  }
  internals.sessions.set(encodeSessionKey(sessionKey), managed)
  internals.sendEvent = () => undefined
  internals.persistSession = () => undefined
  return { internals, managed, sessionKey }
}

describe('D1.273 · choosing an effort is that model\'s memory', () => {
  test('the write lands under the key the ladder reads', async () => {
    const { internals, managed, sessionKey } = rig('d1273-explicit-model', 'explicit')
    const key = internals.resolveBackendContextForManaged(managed).resolvedModel
    // The premise of the pair: the read's key, computed the read's way.
    expect(key).toBe('d1273-explicit-model')
    expect(getModelThinkingLevel(key)).toBeUndefined()

    await internals.setSessionThinkingLevel(sessionKey.sessionId, 'high', sessionKey.workspaceId)
    expect(getModelThinkingLevel(key)).toBe('high')

    // Re-picking rewrites it rather than keeping the first answer.
    await internals.setSessionThinkingLevel(sessionKey.sessionId, 'medium', sessionKey.workspaceId)
    expect(getModelThinkingLevel(key)).toBe('medium')

    setModelThinkingLevel(key, undefined)
  })

  test('where the two spellings DIVERGE, nothing is written under the one the read cannot ask for', async () => {
    // A claude id on a session that resolves to `pi`: the cross-provider guard
    // clears it, so the resolved model is empty. This is the arm that kills the
    // obvious `managed.model` spelling — it would have recorded `high` under
    // `claude-opus-4-6`, a key the ladder never looks up.
    const { internals, managed, sessionKey } = rig('claude-opus-4-6', 'cross-provider')
    expect(internals.resolveBackendContextForManaged(managed).resolvedModel).toBe('')

    await internals.setSessionThinkingLevel(sessionKey.sessionId, 'high', sessionKey.workspaceId)

    expect(getModelThinkingLevel('claude-opus-4-6')).toBeUndefined()
    expect(getModelThinkingLevel('')).toBeUndefined()
    // The effort itself still took, which is what the user asked for: only the
    // MEMORY is declined, because there is no model to remember it against.
    expect((managed as { thinkingLevel: string }).thinkingLevel).toBe('high')
  })

  test('and nothing is remembered for a model nobody chose an effort for — the control', () => {
    expect(getModelThinkingLevel('d1273-never-touched')).toBeUndefined()
    expect(getModelThinkingLevel(undefined)).toBeUndefined()
  })
})
