import { describe, expect, test } from 'bun:test'
import { encodeSessionKey } from '@nessy-agent/shared/sessions/session-key'
import { materializePiRuntimeAgentDefinitions } from '@nessy-agent/shared/agent/pi-harness/runtime-agent-definition'
import { createTestSessionManager } from './test-session-manager.ts'
import { createPiPermissionService } from '../../pi-harness/permission-service.ts'

/**
 * P3.232 — what HOST ADMISSION actually does with a file-authored agent whose
 * declared `tools` name nothing.
 *
 * The row was opened on an unmeasured boundary: the host's
 * `runtime-agent-tool-unavailable:<tool>` check runs only against a PINNED
 * definition, and a file-authored agent "reads as" having none, so the check
 * looked skipped. Driven here, it is not skipped — a project `.nessy-agent/agents`
 * file IS pinned, the check runs, and the bogus names are ADMITTED.
 *
 * That is not a hole, and the reason is the shape of the check: it authenticates
 * the ARRIVING list against the DECLARED one, because the arriving list is
 * transport-supplied and the pinned definition is the authority. A name the
 * author declared therefore authenticates itself — and grants nothing, because no
 * tool answers to it. The control arm proves the check is live on the same call.
 *
 * The reason this is not the whole story is the second test: on the route a real
 * session uses, Pi resolves the same declared list against its manifest, records
 * the zero-tools verdict and REFUSES the spawn (P6.17), so a list of dead names
 * never reaches the host at all. Both facts are pinned together because either
 * one alone reads as a defect.
 */

const AGENT_FILE = [
  '---',
  'name: typo-scout',
  'description: A file-authored agent whose tools are typos.',
  'tools: Grpe, Reed',
  '---',
  '',
  'Inspect the repository and report.',
  '',
].join('\n')

function fileAuthoredView() {
  return {
    generation: 'g1', sources: [], hooks: [], automations: [], promptLayers: [], memory: [],
    permissionLayers: [], commands: [], promptCommands: [], apps: [], skills: [], mcpServers: [],
    agents: [{
      key: 'agent://project/typo-scout', name: 'typo-scout',
      description: 'A file-authored agent whose tools are typos.',
      selectedAsUnqualifiedAlias: true,
      // A NATIVE project-scoped file, not a plugin bundle: `instructionsResource`
      // carries an absolute path and no `pluginInstanceId`, which is what makes
      // this the file route rather than the imported one.
      instructionsResource: {
        source: 'project', scope: { kind: 'project' }, resourceId: 'typo-scout',
        absolutePath: '/tmp/typo-scout.md', revision: '1', contentHash: 'a'.repeat(64),
      },
    }],
  } as never
}

describe('host admission of a file-authored agent whose declared tools resolve to nothing', () => {
  test('reaches the pinned-definition check and admits the declared-but-unresolvable names', async () => {
    const manager = createTestSessionManager()
    const parent: never = {
      id: 'parent', workspace: { id: 'workspace-a', rootPath: process.cwd() },
      permissionMode: 'default', thinkingLevel: 'off', llmConnection: 'pi',
      childSessionState: undefined, messagesLoaded: true, messages: [],
      backgroundShellCommands: new Map(),
    } as never
    ;(manager as never as { sessions: Map<string, unknown> }).sessions
      .set(encodeSessionKey({ workspaceId: 'workspace-a', sessionId: 'parent' }), parent)

    const materializer = { assertActive() {}, readText: async () => AGENT_FILE } as never
    const view = fileAuthoredView()
    const [definition] = await materializePiRuntimeAgentDefinitions({ view, materializer })
    // Precondition: the file route really is PINNED. Without this the two
    // assertions below would be consistent with the check never running.
    expect(definition?.tools).toEqual(['Grpe', 'Reed'])

    const manageAny = manager as never as Record<string, unknown>
    const port = await (manageAny.createPiChildSessionPort as (...args: unknown[]) => Promise<{
      start: (input: unknown) => Promise<unknown>
    }>).call(
      manager, parent, { view, materializer }, createPiPermissionService({}),
      async () => {}, async () => {}, async () => {},
    )
    let admitted: { restrictions: { tools?: string[] } } | undefined
    manageAny.persistSession = () => {}
    manageAny.startPiChildRuntime = async (_parent: unknown, record: unknown) => {
      admitted = record as typeof admitted
      return {
        childSessionKey: { workspaceId: 'workspace-a', sessionId: 'child-1' },
        transcriptId: 'child-1', status: 'completed', output: 'done', result: 'done',
      }
    }
    const input = {
      requestedAgentId: 'agent-1', agent: 'typo-scout', task: 'inspect', background: false,
      restrictions: {
        prompt: `Safety core.\n\n${definition!.systemPrompt}`,
        model: 'session-model',
        tools: ['Grpe', 'Reed'],
        worktreePolicy: 'isolated-worktree', thinkingLevel: 'off',
        capabilityGeneration: 'g1',
        definitionKey: definition!.key,
        definitionDigest: definition!.definitionDigest,
      },
      budgets: {
        depth: 1, maxDepth: 2, fanout: 2, concurrency: 1, tokenLimit: 100,
        costLimitUsd: 1, deadlineAt: Date.now() + 10_000, ancestry: [],
      },
    }

    // THE MEASUREMENT. Not skipped, not refused: admitted, normalized, dead.
    await port.start(input)
    expect(admitted?.restrictions.tools).toEqual(['grpe', 'reed'])

    // POSITIVE CONTROL on the same call, so the admission above is a real
    // admission and not a check that silently does nothing: a tool the author did
    // NOT declare is still refused by name.
    await expect(port.start({
      ...input,
      requestedAgentId: 'agent-2',
      restrictions: { ...input.restrictions, tools: ['bash'] },
    })).rejects.toThrow('runtime-agent-tool-unavailable:bash')

    // And the identity arm, proving the pinned definition really is the one this
    // file produced rather than a builtin fallthrough.
    await expect(port.start({
      ...input,
      requestedAgentId: 'agent-3',
      restrictions: { ...input.restrictions, definitionDigest: 'a'.repeat(64) },
    })).rejects.toThrow('runtime-agent-definition-identity-mismatch')
  })

  test('and Pi refuses that spawn before the host is ever asked', async () => {
    // The other half, without which the arm above reads as an open widening. The
    // same file, through the route a real session uses: the declared entries are
    // resolved against the manifest, dropped, and the zero-tools verdict is
    // recorded — which `spawnChildSession` turns into a refusal
    // (`errors.md#agent-would-be-spawned-with-zero-tools`), so the list of dead
    // names the host would have admitted is never sent.
    const { buildPiRuntimeAgentDefinitions } = await import(
      '../../../../pi-agent-server/src/orchestrator/runtime-agent-definitions.ts'
    )
    const materializer = { assertActive() {}, readText: async () => AGENT_FILE } as never
    const descriptors = await materializePiRuntimeAgentDefinitions({
      view: fileAuthoredView(), materializer,
    })
    const [built] = buildPiRuntimeAgentDefinitions(
      descriptors,
      ['read', 'bash', 'mcp__session__TaskCreate', 'mcp__session__ReportFindings'],
      'g1',
      { sessionDepth: 0, maxDepth: 3 },
    )
    expect(built!.tools).not.toContain('grpe')
    expect(built!.tools).not.toContain('reed')
    expect(built!.zeroToolResolution).toEqual({ unmatched: ['Grpe', 'Reed'], withheld: [] })
  })
})
