/**
 * The host's child-model ceiling must accept the substitution the host's own
 * documented fallback produces — and refuse everything else.
 *
 * Q8-D2, measured live on the packaged 1.25.1. `c086abed6` implemented
 * `sub-agents.md` § *Choose a model* ("Claude Code runs the subagent on the
 * inherited model instead") and announced it exactly as documented:
 *
 *   [model] scan-inventory asked for "sonnet", which this session cannot serve;
 *   it ran on "tgpt/qwen35-397b-a17b-fp8".
 *   runtime-agent-model-ceiling-mismatch
 *
 * The announcement printed and the spawn then died, because the ceiling
 * compared the SUBSTITUTED model against the DECLARED one — equal only when no
 * substitution happened, so the fallback and the check were mutually exclusive
 * by construction. Every agent declaring a model the gateway cannot serve was
 * unspawnable (`claude-security:scan-inventory`, `:explore`, and a fixture with
 * an invented id as the positive control on the reason).
 *
 * These tests drive the LIVE seam — the child-session port's own `start`, which
 * is where the Pi subprocess's spawn request lands — and the protection half is
 * pinned beside the fix: a model that is neither the declared one nor one this
 * session could authorise is still refused.
 */
import { describe, expect, test } from 'bun:test'
import { encodeSessionKey } from '@nessy-agent/shared/sessions/session-key'
import { materializePiRuntimeAgentDefinitions } from '@nessy-agent/shared/agent/pi-harness/runtime-agent-definition'
import { createTestSessionManager } from './__tests__/test-session-manager.ts'
import { createManagedSession, setSessionPlatform } from './SessionManager.ts'
import { createHeadlessPlatform } from '../runtime/platform-headless.ts'
import { createPiPermissionService } from '../pi-harness/permission-service.ts'

const SESSION_MODEL = 'tgpt/qwen35-397b-a17b-fp8'
const TIER_SMALL_MODEL = 'tgpt/qwen36-35b-a3b-fp8'
const allowAgentAdmission = createPiPermissionService({})

const materializer = {
  assertActive() {},
  readText: async () => 'Pinned inventory instructions.',
} as any

const view: any = {
  generation: 'g1',
  sources: [], hooks: [], automations: [], promptLayers: [], memory: [], permissionLayers: [],
  commands: [], promptCommands: [], apps: [], skills: [], mcpServers: [],
  agents: [{
    key: 'agent://scan-inventory',
    name: 'scan-inventory',
    description: 'Inventory scanner',
    selectedAsUnqualifiedAlias: true,
    instructionsResource: { source: 'workspace' },
    // The live shape: a public plugin agent declaring a Claude alias this
    // gateway does not serve.
    model: 'sonnet',
    tools: ['Glob', 'Grep', 'ReadFile'],
  }],
}

/**
 * Drive one spawn request through the real port and report either the admitted
 * record's model or the host's refusal.
 */
async function startWithArrivingModel(model: string): Promise<{ admittedModel?: string; error?: string }> {
  setSessionPlatform(createHeadlessPlatform())
  const manager = createTestSessionManager()
  const parentKey = { workspaceId: 'workspace-model-fallback', sessionId: 'parent-model' }
  const parent: any = createManagedSession(
    { id: parentKey.sessionId, name: 'Parent', ephemeral: true, permissionMode: 'default', llmConnection: 'pi' },
    { id: parentKey.workspaceId, name: 'Model fallback', rootPath: process.cwd(), createdAt: 1 } as never,
    { messagesLoaded: true, model: SESSION_MODEL },
  )
  // What the subprocess spawner reads as `cfg.modelId`: the live agent's model,
  // which is what the host sent it at init.
  parent.agent = { getModel: () => SESSION_MODEL }
  ;(manager as any).sessions.set(encodeSessionKey(parentKey), parent)
  ;(manager as any).persistSession = () => {}

  const [definition] = await materializePiRuntimeAgentDefinitions({ view, materializer })
  const port = await (manager as any).createPiChildSessionPort(
    parent,
    {
      view,
      materializer,
      // The tier map the host pins on the manifest for this generation — the
      // second half of what the spawner may substitute FROM.
      piExecutionManifestSeed: { orchestrator: { tierModelMap: { small: TIER_SMALL_MODEL } } },
    },
    allowAgentAdmission,
    async () => {}, async () => {}, async () => {},
  )

  let admitted: any
  ;(manager as any).startPiChildRuntime = async (_parent: unknown, record: any) => {
    admitted = record
    return {
      childSessionKey: { workspaceId: parentKey.workspaceId, sessionId: 'child-1' },
      transcriptId: 'child-1', status: 'completed', output: 'done', result: 'done',
    }
  }

  try {
    await port.start({
      requestedAgentId: `agent-${Math.random().toString(36).slice(2)}`,
      agent: 'scan-inventory',
      task: 'inspect the inventory',
      background: false,
      restrictions: {
        prompt: `Safety core.\n\n${definition!.systemPrompt}`,
        model,
        tools: ['find', 'grep', 'read'],
        worktreePolicy: 'shared',
        thinkingLevel: 'off',
        capabilityGeneration: 'g1',
        definitionKey: definition!.key,
        definitionDigest: definition!.definitionDigest,
      },
      budgets: {
        depth: 1, maxDepth: 3, fanout: 1, concurrency: 1,
        tokenLimit: 100, costLimitUsd: 1, deadlineAt: Date.now() + 60_000, ancestry: [],
      },
    })
    return { admittedModel: admitted?.restrictions?.model }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  } finally {
    // Rig teardown only: the model-reading stub is not a real backend, so it is
    // detached before the manager tries to end its lifecycle.
    parent.agent = null
    await manager.cleanup()
  }
}

describe('the child-model ceiling and the documented fallback', () => {
  test('the inherited model the fallback substituted is admitted', async () => {
    // The exact live request: frontmatter says `sonnet`, the spawner replaced
    // it with the session's own model and said so in the parent's tool result.
    expect(await startWithArrivingModel(SESSION_MODEL)).toEqual({ admittedModel: SESSION_MODEL })
  })

  test('a tier model this session resolved is admitted too', async () => {
    // `resolveAgentModelId`'s `inherited()` is `tierModelMap[tier] ?? modelId`,
    // so a small-tier agent substitutes to the host-pinned fast model — which
    // must be authorised for the same reason the session model is.
    expect(await startWithArrivingModel(TIER_SMALL_MODEL)).toEqual({ admittedModel: TIER_SMALL_MODEL })
  })

  test('the declared model itself is still admitted when the session can serve it', async () => {
    expect(await startWithArrivingModel('sonnet')).toEqual({ admittedModel: 'sonnet' })
  })

  test('a model this session could never authorise is still refused', async () => {
    // THE PROTECTION. The ceiling exists to stop a child running on a model the
    // parent never authorised; widening it to "any model at all" is the failure
    // mode this test blocks. The refusal must survive every future edit to the
    // fallback.
    expect(await startWithArrivingModel('claude-opus-4-6-20260514'))
      .toEqual({ error: 'runtime-agent-model-ceiling-mismatch' })
  })
})
