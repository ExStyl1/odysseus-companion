/**
 * F1.83 (origin D1.389) — the HOST half: a named Pi child's clamped `maxTurns`
 * reaches the backend config its PiAgent is built from.
 *
 * The chain, read end to end before building: the spawner
 * (`pi-agent-server/src/orchestrator/spawner.ts`) forwards the definition's
 * `maxTurns` on the child's restrictions; `SessionManager` clamps it against
 * the parent and the pinned definition and stores it on the child record;
 * `childManaged.piChildRestrictions` carries it into the child session — and
 * `getOrCreateAgentUnchecked` built the child's `BackendConfig` from
 * `piChildRestrictions.prompt`, `.tools`, `.skillDisallowedTools` and never
 * `.maxTurns`. The only reader was the child-session service, which counts the
 * START and each RESUME against it — not the agentic turns
 * `sub-agents.md#supported-frontmatter-fields` means. So a `maxTurns: "1"`
 * agent ran its whole body (RS-98 on the packaged 1.40.0).
 *
 * The agent half — that `piChildMaxTurns` arms PiAgent's own turn cap — is
 * `packages/shared/src/agent/__tests__/pi-child-max-turns.test.ts`. This file
 * drives the REAL `getOrCreateAgent` and captures the config it hands the
 * backend factory, which is the rig
 * `SessionManager.orchestration.test.ts`'s child-prompt case already uses for
 * the neighbouring `childSystemPrompt` field.
 */
import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { encodeSessionKey } from '@nessy-agent/shared/sessions/session-key'
import { parseManagedPiPolicyV1 } from '@nessy-agent/shared/agent/pi-harness/managed-policy'
import { createTestSessionManager } from './test-session-manager.ts'
import { createManagedSession, setSessionPlatform } from '../SessionManager.ts'
import { createHeadlessPlatform } from '../../runtime/platform-headless.ts'

async function childBackendConfig(restrictions: Record<string, unknown> | undefined): Promise<any> {
  setSessionPlatform(createHeadlessPlatform())
  const manager = createTestSessionManager({
    managedPiPolicy: parseManagedPiPolicyV1({ schemaVersion: 1, disabledPermissionModes: [], autoCompactEnabled: false }),
  })
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'nessy-f183-host-'))
  const workspace = { id: 'workspace-f183', name: 'F1.83', rootPath: workspaceRoot, createdAt: 1 }
  const managed: any = createManagedSession(
    { id: 'f183-child-session', name: 'F1.83 child', ephemeral: true },
    workspace as never,
    { messagesLoaded: true },
  )
  if (restrictions) managed.piChildRestrictions = restrictions
  ;(manager as any).sessions.set(encodeSessionKey({ workspaceId: workspace.id, sessionId: managed.id }), managed)
  ;(manager as any).resolveBackendContextForManaged = () => ({
    connection: null,
    provider: 'pi',
    resolvedModel: 'pi-model',
    capabilities: { needsHttpPoolServer: false },
  })
  ;(manager as any).buildAgentAutomationSystem = async () => ({ executeAgentEvent: async () => ({ matchedCount: 0 }) })
  const agent = {
    isProcessing: () => false,
    setAutomationSystem() {},
    setCapabilityTurnRuntime() {},
    drainAutomationEvents: async () => {},
    postInit: async () => ({}),
    setAllSources() {},
    setSourceServers: async () => {},
    getModel: () => 'pi-model',
    chat: () => (async function* () {})(),
    getSessionId: () => undefined,
    endLifecycle: async () => {},
    forceAbort() {},
    dispose() {},
  }
  let coreConfig: any
  ;(manager as any).createBackendFromManagedContext = (input: any) => {
    coreConfig = input.coreConfig
    return agent
  }
  ;(manager as any).piWorkspaceDrainParticipant = {
    processSupervisorPort: undefined,
    async admitRuntime(input: any) { input.publish(await input.create(), { dispose() {} }) },
    dispose() {},
  }
  ;(manager as any).persistSession = () => {}
  ;(manager as any).flushSession = async () => {}
  ;(manager as any).sendEvent = () => {}
  try {
    await (manager as any).withCapabilityRuntime(managed, (runtime: any) => (
      (manager as any).getOrCreateAgent(managed, runtime)
    ))
    return coreConfig
  } finally {
    managed.agent = null
    managed.piDrainRegistration = undefined
    try { await manager.cleanup() } finally { rmSync(workspaceRoot, { recursive: true, force: true }) }
  }
}

const NAMED_CHILD = {
  prompt: '## Subagent Safety Core\n\nSENTINEL_F183',
  model: 'pi-model',
  tools: ['bash'],
  worktreePolicy: 'shared',
  thinkingLevel: 'off',
}

describe('F1.83 · the child backend config carries the clamped maxTurns', () => {
  test('a child whose restrictions say maxTurns: 1 is built with piChildMaxTurns: 1', async () => {
    const config = await childBackendConfig({ ...NAMED_CHILD, maxTurns: 1 })
    // Positive control on the same capture: the neighbouring field from the
    // same restrictions object arrives, so a missing maxTurns is not a rig
    // that captured the wrong config.
    expect(config.childSystemPrompt).toBe(NAMED_CHILD.prompt)
    expect(config.piChildMaxTurns).toBe(1)
  })

  test('CONTROL: the uncapped twin carries no cap at all', async () => {
    const config = await childBackendConfig({ ...NAMED_CHILD })
    expect(config.childSystemPrompt).toBe(NAMED_CHILD.prompt)
    expect('piChildMaxTurns' in config && config.piChildMaxTurns !== undefined).toBe(false)
  })

  test('a top-level session (no child restrictions) carries none', async () => {
    const config = await childBackendConfig(undefined)
    expect(config.piChildMaxTurns).toBeUndefined()
  })
})
