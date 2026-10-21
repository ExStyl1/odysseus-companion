/**
 * P6.590 — an imported `agent` plugin hook fires on claude and codex.
 *
 * It was Pi-only, and the reason was never a runtime limit: an `agent` hook
 * spawns a HOST child session through `managed.piChildSessionPort`, and that
 * port was assigned only where `piPermissionService` — the Pi tool-approval
 * band's service — exists. So an imported `agent` hook was advertised in the
 * catalogue on claude and codex and died at `agent-unavailable`, which is the
 * silent-divergence shape this plan exists to remove. Ledger G2.
 *
 * Modelled on the P6.117 block in `SessionManager.plugin-hook-runners.test.ts`,
 * which pinned the other three runners the same way: build the real automation
 * system for one provider, fire one event, watch the port.
 */
import { describe, expect, test } from 'bun:test'
import { DEFAULT_MANAGED_PI_POLICY } from '@nessy-agent/shared/agent/pi-harness/managed-policy'
import { SessionManager } from '../SessionManager.ts'
import { createTestSessionManager } from './test-session-manager.ts'

const PLUGIN_INSTANCE = 'plugin://test@1.0.0#fixture'
const AGENT_KEY = 'plugin://test/agent.review@workspace'

/** One imported `"type": "agent"` hook plus the definition it names. */
function agentHookRuntime(provider: string) {
  return {
    provider,
    projectTrustState: 'trusted',
    view: {
      generation: 'test-agent-generation',
      sources: [], skills: [], mcpServers: [], automations: [],
      hooks: [{
        key: 'plugin://test/hook.review@workspace',
        event: 'Stop',
        type: 'agent',
        // The KEY, not the bare name: `pluginAgentHookRunner` matches a bare
        // name only for a definition materialization marked as the unqualified
        // alias, and this fixture declares one agent under its qualified key.
        agentName: AGENT_KEY,
        pluginInstanceId: PLUGIN_INSTANCE,
        resource: { pluginInstanceId: PLUGIN_INSTANCE, relativePath: 'hooks/review.json', contentHash: 'fixture' },
        executableHash: 'fixture',
      }],
      agents: [{
        key: AGENT_KEY,
        name: 'reviewer',
        description: 'Pinned review agent',
        instructionsResource: {
          pluginInstanceId: PLUGIN_INSTANCE,
          relativePath: 'agents/reviewer.md',
          contentHash: 'fixture',
        },
        model: 'agent-model',
        tools: ['Read'],
        effort: 'high',
        maxTurns: 2,
        permissionMode: 'allow-all',
      }],
      promptLayers: [], memory: [], permissionLayers: [], commands: [], promptCommands: [], apps: [],
    },
    materializer: {
      assertActive() {},
      async verifyPlugin() {},
      async readText() { return 'Review the change.' },
    },
  }
}

/** A child-session port that records what it was asked to spawn and completes. */
function recordingPort() {
  const starts: Array<Record<string, unknown>> = []
  return {
    starts,
    port: {
      async start(input: Record<string, unknown>) {
        starts.push(input)
        return { agentId: 'child-agent', childSessionKey: {}, transcriptId: 't', status: 'completed', output: '' }
      },
      async stop() {},
      async getResult() { return { status: 'completed', output: '' } },
    },
  }
}

async function fireStopHookOn(provider: string) {
  // D1.242 — a REAL instance through `createTestSessionManager`, not
  // a bare prototype double. Every assignment below still
  // overrides what it overrode; the fields nobody seeded are now the
  // constructor's rather than `undefined`. D1.109 priced it: a `mkdtemp` and
  // four in-memory stores, not measurably expensive.
  const manager = createTestSessionManager() as any
  manager.managedPiPolicyCurrent = DEFAULT_MANAGED_PI_POLICY
  const receipts: Array<Record<string, unknown>> = []
  manager.appendPiExecutionReceipt = (_managed: unknown, receipt: Record<string, unknown>) => {
    receipts.push(receipt)
    return receipt
  }
  manager.piGoalReceiptReference = () => undefined
  manager.isPluginHookEffectAllowed = async () => true
  // The three collaborators this builder needs and this row does not test.
  manager.trackAgentAutomationSystem = (_managed: unknown, system: unknown) => system
  manager.liveComponentHookLayer = () => undefined
  manager.sendEvent = () => {}

  const child = recordingPort()
  const managed = {
    id: 'session-hook',
    workspace: { id: 'workspace-hook', rootPath: process.cwd() },
    model: 'parent-model',
    // P6.590's subject: on claude and codex this used to be `undefined`, which
    // is the whole defect. Assigned here because the assignment site is
    // `getOrCreateAgent`, one layer above what this test drives.
    piChildSessionPort: child.port,
  }
  const runtime = agentHookRuntime(provider)
  const system = await manager.buildAgentAutomationSystem(managed, runtime, provider)
  expect(system, `no automation system was built for ${provider}`).toBeDefined()
  await system.executeAgentEvent('Stop', { hook_event_name: 'Stop' })
  return { starts: child.starts, receipts }
}

describe('P6.590 — the agent hook runner reaches every coding runtime', () => {
  for (const provider of ['pi', 'anthropic', 'codex-runtime'] as const) {
    test(`an imported agent hook spawns its declared agent on ${provider}`, async () => {
      const { starts, receipts } = await fireStopHookOn(provider)
      expect(starts, `no child was spawned on ${provider}; receipts: ${JSON.stringify(receipts)}`).toHaveLength(1)
      const spawned = starts[0]!
      expect(spawned.agent).toBe(AGENT_KEY)
      expect(spawned.background).toBe(false)
      // The receipt is the audit half, and it must not read `agent-unavailable`
      // — that is the code this row exists to stop seeing on claude and codex.
      const codes = receipts.map(receipt => receipt.code)
      expect(codes).not.toContain('agent-unavailable')
      expect(receipts.some(receipt => receipt.semanticId === 'plugin-agent-hook')).toBe(true)
    })
  }

  test('the remote backend still runs no host-side agent hook at all', async () => {
    // The negative control, and the reason the record is not simply `true`
    // everywhere: `nestor-cloud-agent` runs no host-side hook action, so the
    // runner is withheld and nothing is spawned.
    const { starts } = await fireStopHookOn('nestor-cloud-agent')
    expect(starts).toHaveLength(0)
  })
})
