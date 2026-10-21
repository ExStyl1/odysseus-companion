import { describe, expect, it } from 'bun:test'

import type { BackendConfig, CapabilityTurnRuntime } from '../../../shared/src/agent/backend/types.ts'
import { PiAgent } from '../../../shared/src/agent/pi-agent.ts'
import {
  normalizePiOrchestratorConfig,
  type PiExecutionManifestSeedV2,
  type PiOrchestratorConfig,
} from '../../../shared/src/agent/pi-harness/harness-manifest.ts'
import { validatePiExecutionManifest } from './tool-manifest.ts'

// Regression for the live "Pi execution manifest orchestrator mismatch" turn
// failure: the subprocess pins its orchestrator config at init, but the host
// rebuilds the capability-turn seed each turn and derives the orchestrator
// `contextSeed` from the (mutable) working directory. When the working folder is
// rebound (or a mode change forces a fresh capability turn) the seed orchestrator
// drifts, and the next `buildExecutionManifestForCurrentTurn` used to register a
// manifest whose orchestrator no longer matched the subprocess's init-pinned
// value — `validatePiExecutionManifest` then threw and killed the turn.

function config(): BackendConfig {
  return {
    provider: 'pi', isHeadless: true, skipConfigWatcher: true,
    // Empty allow-list yields a tool-less manifest so the test isolates the
    // orchestrator identity check from the session-tool surface.
    piAllowedTools: [],
    workspace: { id: 'ws', name: 'ws', rootPath: '/tmp/ws', workspaceRootPath: '/tmp/ws', sessionRootPath: '/tmp/sessions/ws' } as any,
    session: { id: 'parent', workspaceId: 'ws', createdAt: 1, lastUsedAt: 1 } as any,
  }
}

function runtime(orchestrator: Partial<PiOrchestratorConfig>, generation: string): CapabilityTurnRuntime {
  const seed: PiExecutionManifestSeedV2 = {
    surfaceVersion: 2,
    snapshotGeneration: generation,
    sessionKey: { workspaceId: 'ws', sessionId: 'parent' },
    provenance: [],
    mcpSources: [],
    orchestrator: normalizePiOrchestratorConfig(orchestrator),
    staticTools: [],
  }
  return {
    view: { generation, sources: [], skills: [], mcpServers: [], hooks: [], automations: [], agents: [], promptLayers: [], memory: [], permissionLayers: [], commands: [], promptCommands: [], apps: [] },
    materializer: { assertActive() {}, async verifyPlugin() {}, async resolvePath() { return '' }, async readText() { return '' }, resolveCredential() { throw new Error('unused') } },
    piExecutionManifestSeed: seed,
  } as CapabilityTurnRuntime
}

describe('PiAgent orchestrator pin across capability-runtime refreshes', () => {
  it('keeps the registered orchestrator aligned with the init-pinned value when the working directory rebinds mid-session', () => {
    // Working directory A → orchestrator carries contextSeed A.
    const orchestratorA = { concurrency: 4, depth: 2, maxParallelTasks: 8, maxAgents: 100, tierModelMap: null, tokenBudget: null, contextSeed: 'Working directory: /repo/a' }
    // Working directory B (a mid-session rebind) → seed rebuilt with contextSeed B.
    const orchestratorB = { ...orchestratorA, contextSeed: 'Working directory: /repo/b' }
    const pinned = normalizePiOrchestratorConfig(orchestratorA)
    const drifted = normalizePiOrchestratorConfig(orchestratorB)
    // Sanity: the two orchestrators genuinely differ after normalization.
    expect(pinned).not.toEqual(drifted)

    const agent = new PiAgent(config())
    try {
      // First turn: subprocess spawns / initializes against orchestrator A. The
      // first manifest build pins the orchestrator for the subprocess lifetime.
      agent.setCapabilityTurnRuntime(runtime(orchestratorA, 'gen-a'))
      const first = (agent as any).buildExecutionManifestForCurrentTurn()
      expect(first.manifest.orchestrator).toEqual(pinned)
      const initExpected = {
        sessionKey: { workspaceId: 'ws', sessionId: 'parent' },
        orchestrator: first.manifest.orchestrator as PiOrchestratorConfig,
      }

      // Mid-session working-folder rebind: capability runtime is rebuilt with a
      // new generation and a drifted orchestrator (new contextSeed). No respawn,
      // so the subprocess still expects orchestrator A.
      agent.setCapabilityTurnRuntime(runtime(orchestratorB, 'gen-b'))
      const second = (agent as any).buildExecutionManifestForCurrentTurn()

      // Fix: the rebuilt manifest still carries the init-pinned orchestrator (A),
      // not the drifted seed orchestrator (B) — so register_tools validates.
      expect(second.manifest.orchestrator).toEqual(pinned)
      expect(second.manifest.orchestrator).not.toEqual(drifted)
      expect(() => validatePiExecutionManifest(second.manifest, {
        generation: second.manifest.snapshotGeneration,
        manifestHash: second.manifest.manifestHash,
        ...initExpected,
      })).not.toThrow()

      // Pre-fix behavior: without the pin the rebuild would follow the drifted
      // seed orchestrator (B); validating that manifest against the subprocess's
      // init-pinned orchestrator (A) throws and fails the turn.
      ;(agent as any).subprocessOrchestrator = null
      const preFix = (agent as any).buildExecutionManifestForCurrentTurn()
      expect(preFix.manifest.orchestrator).toEqual(drifted)
      expect(() => validatePiExecutionManifest(preFix.manifest, {
        generation: preFix.manifest.snapshotGeneration,
        manifestHash: preFix.manifest.manifestHash,
        ...initExpected,
      })).toThrow('orchestrator mismatch')
    } finally {
      agent.destroy()
    }
  })
})
