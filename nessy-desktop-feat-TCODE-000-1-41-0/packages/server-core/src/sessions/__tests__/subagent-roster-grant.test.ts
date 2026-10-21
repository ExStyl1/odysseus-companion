/**
 * P6.19 — a Pi subagent holding the messaging tool was given no roster.
 *
 * `cross-session-messaging.md` (intro): "Claude uses two tools for this:
 * `ListAgents` to discover which agents it can reach, and `SendMessage` to
 * deliver a message to one of them by name." Two tools, one capability. Ours are
 * `list_sessions` and `send_agent_message`.
 *
 * Measured before this row: an author who wrote `tools: [Read, SendMessage]` got
 * the sending half and nothing else. That subagent could only answer a session
 * that had already written to it — the sender id arrives inside the delivery
 * envelope ("Use send_agent_message with sessionId … to reply") — and could not
 * discover a peer at all. An agent with NO `tools` field inherits the parent
 * pool and always had both, so the gap was exactly the RESTRICTED agent, the one
 * whose author was most explicit.
 *
 * ## Why the grant is conditional, which is the security half
 *
 * A roster is a DISCLOSURE. P0.1 settled that `send_agent_message`'s authority is
 * a thing to scope rather than to spread, and adding `list_sessions` to
 * `SUBAGENT_ALWAYS_AVAILABLE_TOOLS` would hand the workspace's session list to
 * every restricted subagent in the product — including ones written to touch
 * nothing outside their own files. Keying it on the author's own declaration
 * keeps the two answers honest: an agent that already holds the tool that WRITES
 * to peers learns nothing new by being able to name them, and an agent that does
 * not hold it gains nothing.
 *
 * ## Why BOTH sides are driven in one file
 *
 * The grant is outside the declared list by construction, so Pi must union it
 * into the child's pool AND the host must admit it on arrival. Either side alone
 * is a defect with the opposite sign: union-only is silently inert, admit-only is
 * spawn-fatal. That is Q10-2's trade verbatim, and a suite that pinned one side
 * would have passed through it.
 */
import { describe, expect, test } from 'bun:test'
import { encodeSessionKey } from '@nessy-agent/shared/sessions/session-key'
import { materializePiRuntimeAgentDefinitions } from '@nessy-agent/shared/agent/pi-harness/runtime-agent-definition'
import { createTestSessionManager } from './test-session-manager.ts'
import { createPiPermissionService } from '../../pi-harness/permission-service.ts'

const ROSTER_PI_NAME = 'mcp__session__list_sessions'
const MESSAGING_PI_NAME = 'mcp__session__send_agent_message'

/** The pool a real Pi session hands the builder, in the piName spelling. */
const SESSION_POOL = ['read', 'bash', ROSTER_PI_NAME, MESSAGING_PI_NAME, 'mcp__session__TaskCreate']

function agentFile(tools: string): string {
  return [
    '---',
    'name: courier',
    'description: An agent that talks to peer sessions.',
    `tools: ${tools}`,
    '---',
    '',
    'Coordinate with the other sessions.',
    '',
  ].join('\n')
}

function courierView() {
  return {
    generation: 'g1', sources: [], hooks: [], automations: [], promptLayers: [], memory: [],
    permissionLayers: [], commands: [], promptCommands: [], apps: [], skills: [], mcpServers: [],
    agents: [{
      key: 'agent://project/courier', name: 'courier',
      description: 'An agent that talks to peer sessions.',
      selectedAsUnqualifiedAlias: true,
      instructionsResource: {
        source: 'project', scope: { kind: 'project' }, resourceId: 'courier',
        absolutePath: '/tmp/courier.md', revision: '1', contentHash: 'b'.repeat(64),
      },
    }],
  } as never
}

async function descriptorFor(tools: string) {
  const materializer = { assertActive() {}, readText: async () => agentFile(tools) } as never
  const [definition] = await materializePiRuntimeAgentDefinitions({ view: courierView(), materializer })
  return definition!
}

async function builtToolsFor(tools: string): Promise<readonly string[]> {
  const { buildPiRuntimeAgentDefinitions } = await import(
    '../../../../pi-agent-server/src/orchestrator/runtime-agent-definitions.ts'
  )
  const descriptor = await descriptorFor(tools)
  const [built] = buildPiRuntimeAgentDefinitions(
    [descriptor], SESSION_POOL, 'g1', { sessionDepth: 0, maxDepth: 3 },
  )
  return (built as { tools?: readonly string[] }).tools ?? []
}

describe('P6.19 — the Pi side unions the roster half', () => {
  test('an agent declaring the messaging tool is given the roster tool too', async () => {
    const tools = await builtToolsFor('Read, SendMessage')
    // Precondition: the declared half really resolved, so the roster below is an
    // addition rather than the only thing that worked.
    expect(tools).toContain(MESSAGING_PI_NAME)
    // THE ROW.
    expect(tools).toContain(ROSTER_PI_NAME)
  })

  test('and the documented spelling reaches it the same way our own does', async () => {
    expect(await builtToolsFor('Read, send_agent_message')).toContain(ROSTER_PI_NAME)
  })

  test('NEGATIVE CONTROL: an agent that did not declare it gets no roster', async () => {
    const tools = await builtToolsFor('Read, Grep')
    expect(tools).toContain('read')
    expect(tools).not.toContain(ROSTER_PI_NAME)
    expect(tools).not.toContain(MESSAGING_PI_NAME)
  })

  test('NEGATIVE CONTROL: a session without the roster tool cannot manufacture one', async () => {
    // The grant only ever re-adds a name the PARENT's pool already carries, so a
    // session where `list_sessions` is absent stays absent.
    const { buildPiRuntimeAgentDefinitions } = await import(
      '../../../../pi-agent-server/src/orchestrator/runtime-agent-definitions.ts'
    )
    const [built] = buildPiRuntimeAgentDefinitions(
      [await descriptorFor('Read, SendMessage')],
      ['read', MESSAGING_PI_NAME],
      'g1', { sessionDepth: 0, maxDepth: 3 },
    )
    expect((built as { tools?: readonly string[] }).tools ?? []).not.toContain(ROSTER_PI_NAME)
  })
})

describe('P6.19 — the host side admits what Pi sends', () => {
  async function admissionPort() {
    const manager = createTestSessionManager()
    const parent: never = {
      id: 'parent', workspace: { id: 'workspace-a', rootPath: process.cwd() },
      permissionMode: 'default', thinkingLevel: 'off', llmConnection: 'pi',
      childSessionState: undefined, messagesLoaded: true, messages: [],
      backgroundShellCommands: new Map(),
    } as never
    ;(manager as never as { sessions: Map<string, unknown> }).sessions
      .set(encodeSessionKey({ workspaceId: 'workspace-a', sessionId: 'parent' }), parent)
    const manageAny = manager as never as Record<string, unknown>
    manageAny.persistSession = () => {}
    manageAny.startPiChildRuntime = async () => ({
      childSessionKey: { workspaceId: 'workspace-a', sessionId: 'child-1' },
      transcriptId: 'child-1', status: 'completed', output: 'done', result: 'done',
    })
    return { manager, parent, manageAny }
  }

  async function startWith(declared: string, arriving: string[], requestedAgentId: string) {
    const { manager, parent, manageAny } = await admissionPort()
    const materializer = { assertActive() {}, readText: async () => agentFile(declared) } as never
    const view = courierView()
    const [definition] = await materializePiRuntimeAgentDefinitions({ view, materializer })
    const port = await (manageAny.createPiChildSessionPort as (...args: unknown[]) => Promise<{
      start: (input: unknown) => Promise<unknown>
    }>).call(
      manager, parent, { view, materializer }, createPiPermissionService({}),
      async () => {}, async () => {}, async () => {},
    )
    return port.start({
      requestedAgentId, agent: 'courier', task: 'coordinate', background: false,
      restrictions: {
        prompt: `Safety core.\n\n${definition!.systemPrompt}`,
        model: 'session-model',
        tools: arriving,
        worktreePolicy: 'isolated-worktree', thinkingLevel: 'off',
        capabilityGeneration: 'g1',
        definitionKey: definition!.key,
        definitionDigest: definition!.definitionDigest,
      },
      budgets: {
        depth: 1, maxDepth: 2, fanout: 2, concurrency: 1, tokenLimit: 100,
        costLimitUsd: 1, deadlineAt: Date.now() + 10_000, ancestry: [],
      },
    })
  }

  test('the roster tool is admitted for an agent whose declared list names the messaging tool', async () => {
    await expect(startWith('Read, SendMessage', ['read', MESSAGING_PI_NAME, ROSTER_PI_NAME], 'agent-ok'))
      .resolves.toBeDefined()
  })

  test('NEGATIVE CONTROL: it is refused for an agent that did not declare the messaging tool', async () => {
    // Without this arm the admission above is consistent with the check having
    // been widened to "any session tool", which is the failure mode that would
    // turn a scoped disclosure into an unscoped one.
    await expect(startWith('Read, Grep', ['read', ROSTER_PI_NAME], 'agent-no'))
      .rejects.toThrow(`runtime-agent-tool-unavailable:${ROSTER_PI_NAME}`)
  })

  test('NEGATIVE CONTROL: the check is still live on an unrelated undeclared tool', async () => {
    await expect(startWith('Read, SendMessage', ['read', 'bash'], 'agent-bash'))
      .rejects.toThrow('runtime-agent-tool-unavailable:bash')
  })
})
