/**
 * R53c — the seam between the effort a spawn RESOLVES and the effort a panel
 * row SHOWS.
 *
 * `statusline.md` § `subagentStatusLine` gives the per-subagent row body an
 * `effort` — "the reasoning effort set for that subagent, in its definition
 * frontmatter or on the individual invocation" — alongside `model`. Both halves
 * of that already had tests and the seam between them had none: `spawner.test.ts`
 * pins the precedence against a fake port, and `AgentPanel.test.tsx` pins the
 * rendering against a hand-written summary. What neither can see is the only
 * thing the user experiences — whether the level the spawner resolved survives
 * admission, the child record, and the snapshot projection to arrive on the row.
 * It did not: `PiHarnessChildSummaryV1` carried tokens and cost and neither
 * field, which is why CDP `AGT-5` was blocked twice on "no field of the Pi
 * runtime snapshot carries it".
 *
 * So this test spans it: the real `spawnChildSession`, the real `SessionManager`
 * child-session port, and `getPiHarnessRuntimeSnapshot().childState.children` —
 * the exact field `useAgentPanel` maps into rows. Only the child RUNTIME is
 * stubbed (a real one would need a live model).
 *
 * The value asserted is the APPLIED level, not the configured one — see the
 * note on `PiHarnessChildSummaryV1.effort`.
 */
import { afterEach, describe, expect, test } from 'bun:test'

import { encodeSessionKey } from '../../../shared/src/sessions/session-key.ts'
import { createPiPermissionService } from '../../../server-core/src/pi-harness/permission-service.ts'
import {
  createTestCapabilityResolver,
  createTestSessionManager,
} from '../../../server-core/src/sessions/__tests__/test-session-manager.ts'
import type { PiChildSessionRecordV1 } from '../../../shared/src/agent/pi-harness/child-session-port.ts'
import type { AgentDefinition } from '../../../shared/src/agents/index.ts'
import type { ThinkingLevel } from '../../../shared/src/agent/thinking-levels.ts'
import { configureSpawner, spawnChildSession } from './spawner.ts'

const workspaceId = 'workspace-row-effort'
const sessionId = 'parent-row-effort'
const session = { workspaceId, sessionId }

/** A BUILTIN agent name, so admission needs no pinned definition identity. */
const scout: AgentDefinition = {
  name: 'scout',
  description: 'Inspect the workspace and return concise facts with file references.',
  systemPrompt: 'You are a scout agent. Read only what is needed, cite concrete files or commands, and avoid edits or speculative plans.',
  toolset: 'read-only',
  tools: ['read', 'grep', 'find', 'ls'],
  tier: 'small',
}

interface Harness {
  manager: any
  children: () => Promise<readonly any[]>
  cleanup: () => void
}

async function harness(sessionLevel: ThinkingLevel): Promise<Harness> {
  const resolver = createTestCapabilityResolver()
  const manager = createTestSessionManager({ resolver }) as any
  const managed: any = {
    id: sessionId,
    workspace: { id: workspaceId, rootPath: process.cwd(), name: workspaceId, createdAt: 1 },
    ephemeral: true,
    permissionMode: 'allow-all',
    thinkingLevel: sessionLevel,
    llmConnection: 'pi',
    messages: [],
    messagesLoaded: true,
    childSessionState: undefined,
    backgroundTaskOutputs: new Map(),
    backgroundShellCommands: new Map(),
    isProcessing: false,
  }
  manager.sessions.set(encodeSessionKey(session), managed)
  manager.persistSession = () => {}
  manager.eventSink = () => {}
  manager.resolveManagedProvider = () => 'pi'

  // The real host publishes a child session and runs its turn. Here the record
  // is admitted and the turn settles at once — the record and its restrictions
  // are what the snapshot projects, and they are written at admission.
  manager.startPiChildRuntime = async (_parent: unknown, record: PiChildSessionRecordV1) => ({
    childSessionKey: { workspaceId, sessionId: `child-${record.agentId}` },
    transcriptId: `child-${record.agentId}`,
    status: 'completed' as const,
    output: 'child result',
    result: 'child result',
  })

  const snapshot = await resolver.resolve({
    workspaceId, sessionId, enabledSourceNames: [], projectTrustState: 'none', projectTrustRevision: '',
  })
  managed.capabilityRuntime = {
    view: {
      generation: 'row-effort-generation',
      sources: [], skills: [], mcpServers: [], hooks: [], automations: [], agents: [],
      promptLayers: [], memory: [], commands: [], promptCommands: [], apps: [],
      permissionLayers: [],
    },
    projectTrustState: 'trusted',
    materializer: { assertActive() {}, async readText() { return '' } },
  }
  managed.capabilityLeaseId = snapshot.leaseId
  managed.agentAutomationCapabilityLease = manager.createRetainedCapabilityLease(snapshot.leaseId)

  configureSpawner({
    childSessionPort: manager.createPiDelegatingChildSessionPort(managed, createPiPermissionService({})),
    modelId: 'parent-session-model',
    retryBaseDelayMs: () => 0,
    sessionToolNames: ['read', 'grep', 'find', 'ls', 'subagent'],
    thinkingLevel: () => sessionLevel,
  })

  return {
    manager,
    children: async () => (await manager.getPiHarnessRuntimeSnapshot(session)).childState?.children ?? [],
    cleanup: () => manager.cleanup(),
  }
}

let active: Harness | undefined
afterEach(() => { active?.cleanup(); active = undefined })

describe('a subagent carries its effort and model to the agents panel', () => {
  test("frontmatter effort ABOVE the session level reaches the row as the child's own", async () => {
    const context = active = await harness('low')

    const result = await spawnChildSession({
      agentDef: { ...scout, effort: 'xhigh' },
      task: 'survey the repo', cwd: process.cwd(), background: false,
    })
    expect(result.status).toBe('done')

    const rows = await context.children()
    expect(rows).toHaveLength(1)
    // `xhigh`, not the session's `low` — the frontmatter overrides UP, and the
    // row reports what actually ran rather than what the session was set to.
    expect(rows[0]).toMatchObject({ agent: 'scout', effort: 'xhigh', model: 'parent-session-model' })
  })

  test('a child that inherits the session level reaches the row with the inherited one', async () => {
    const context = active = await harness('high')

    await spawnChildSession({
      agentDef: scout,
      task: 'survey the repo', cwd: process.cwd(), background: false,
    })

    const rows = await context.children()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ agent: 'scout', effort: 'high', model: 'parent-session-model' })
  })
})
