/**
 * D7 — the host half: a manifest re-registration carries FRESH agent
 * descriptors.
 *
 * `this.config.piRuntimeAgentDefinitions` is captured when the agent is
 * constructed and never refreshed. Before this, a mid-session capability
 * re-registration bumped `snapshotGeneration` while the subprocess still held
 * the init-time descriptors, and rebuilding the session from them threw —
 * killing every subsequent turn for the life of that session. Measured live
 * 2026-08-14 on a real profile: three reproductions (a source disabled, a
 * source auto-enabled by `source_test`), two controls (no capability change =
 * clean; no agent definitions = clean).
 *
 * The subprocess-side floor lives in
 * `pi-agent-server/src/orchestrator/runtime-agent-definitions.test.ts` (a stale
 * descriptor is dropped and named, never session-fatal). This file pins the
 * half that keeps the agents ALIVE rather than merely dropped.
 */
import { describe, expect, it } from 'bun:test'
import type { BackendConfig, CapabilityTurnRuntime } from '../backend/types.ts'
import { PiAgent } from '../pi-agent.ts'
import type { PiExecutionManifestSeedV2 } from '../pi-harness/harness-manifest.ts'

const GENERATION = 'generation-2'

const AGENT_FILE = [
  '---',
  'name: diary-writer',
  'description: generate a diary for user',
  'tools: Read',
  '---',
  '',
  'You write diaries.',
].join('\n')

function config(withDefinitions: boolean): BackendConfig {
  return {
    provider: 'pi', isHeadless: true, skipConfigWatcher: true,
    workspace: { id: 'ws', name: 'ws', rootPath: '/tmp/ws', workspaceRootPath: '/tmp/ws', sessionRootPath: '/tmp/sessions/ws' } as never,
    session: { id: 'parent', workspaceId: 'ws', createdAt: 1, lastUsedAt: 1 } as never,
    // Presence is the gate — a runtime that does not dispatch agent definitions
    // at init must not start receiving them at re-registration.
    ...(withDefinitions ? { piRuntimeAgentDefinitions: [] } : {}),
  } as BackendConfig
}

function runtime(): CapabilityTurnRuntime {
  return {
    view: {
      generation: GENERATION,
      sources: [], skills: [], mcpServers: [], hooks: [], automations: [],
      agents: [{
        key: 'plugin://market/example#agent.diary-writer@workspace',
        name: 'diary-writer',
        description: 'generate a diary for user',
        selectedAsUnqualifiedAlias: true,
        instructionsResource: {
          pluginInstanceId: 'plugin://market/example@1.0.0#fixture',
          relativePath: 'agents/diary.md',
          contentHash: 'fixture',
        },
      }],
      promptLayers: [], memory: [], permissionLayers: [], commands: [],
      promptCommands: [], apps: [],
    },
    materializer: {
      assertActive() {}, async verifyPlugin() {}, async resolvePath() { return '' },
      async readText() { return AGENT_FILE },
      resolveCredential() { throw new Error('unused') },
    },
    piExecutionManifestSeed: { snapshotGeneration: GENERATION } as PiExecutionManifestSeedV2,
  } as unknown as CapabilityTurnRuntime
}

/** Drive `publishExecutionManifest` far enough to capture what it sends. */
async function sentRegisterTools(withDefinitions: boolean): Promise<Record<string, unknown> | undefined> {
  const agent = new PiAgent(config(withDefinitions))
  const state = agent as never as {
    capabilityTurnRuntime: CapabilityTurnRuntime | null
    subprocess: unknown
    send(message: Record<string, unknown>): void
    pendingManifestRegistrations: Map<string, { resolve(value: unknown): void }>
    publishExecutionManifest(execution: unknown, previous?: unknown): Promise<void>
    activeExecutionManifest: unknown
  }
  agent.setCapabilityTurnRuntime(runtime())

  const manifest = {
    snapshotGeneration: GENERATION,
    manifestHash: 'hash-2',
    tools: [],
    deferredMcp: { candidatePiNames: [] },
  }
  const sent: Record<string, unknown>[] = []
  // `publishExecutionManifest` writes to the subprocess's stdin and then awaits
  // the subprocess's acknowledgement; both are stubbed so the test observes the
  // MESSAGE, which is the whole contract under test.
  state.subprocess = { stdin: { writable: true } }
  state.send = (message: Record<string, unknown>) => {
    sent.push(message)
    if (message.type === 'register_tools') {
      state.pendingManifestRegistrations.get(message.id as string)
        ?.resolve({ generation: GENERATION, manifestHash: 'hash-2' })
    }
  }
  // The real adapter is LEFT IN PLACE. Replacing it with a stub broke
  // `destroy()` (`resetOverflowState is not a function`) — a teardown crash
  // that has nothing to do with what is being measured.

  try {
    await state.publishExecutionManifest({ manifest, tools: [] })
  } catch {
    // Everything after the acknowledgement touches machinery this test does not
    // stand up; the send has already happened by then.
  } finally {
    state.subprocess = null
    agent.destroy()
  }
  return sent.find(message => message.type === 'register_tools')
}

describe('D7 — manifest re-registration refreshes runtime agent definitions', () => {
  it('sends descriptors materialized for the NEW generation', async () => {
    const message = await sentRegisterTools(true)

    expect(message).toBeDefined()
    const definitions = message!.piRuntimeAgentDefinitions as Array<{ key: string; capabilityGeneration: string }>
    expect(definitions).toHaveLength(1)
    // The generation is what every staleness check compares. Materialized from
    // the live view rather than re-stamped onto the init-time copy: a
    // descriptor's digest is computed from its content and generation together,
    // so a re-stamp makes the pair disagree and every spawn dies on
    // `runtime-agent-definition-identity-mismatch` instead.
    expect(definitions[0]!.capabilityGeneration).toBe(GENERATION)
    expect(definitions[0]!.key).toContain('diary-writer')
  })

  it('omits the field entirely when init never dispatched agent definitions', async () => {
    const message = await sentRegisterTools(false)

    expect(message).toBeDefined()
    expect(message).not.toHaveProperty('piRuntimeAgentDefinitions')
  })
})
