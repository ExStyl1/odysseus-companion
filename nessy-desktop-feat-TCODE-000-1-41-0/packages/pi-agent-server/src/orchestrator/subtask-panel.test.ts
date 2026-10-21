/**
 * S13 — the seam between `/subtask` and the agents panel.
 *
 * Both halves of the fork panel had tests and nothing tested the seam between
 * them, so a fork that never registered still looked built: `startSubtaskFork`
 * had unit tests against a fake child-session port that accepted any input, and
 * `toAgentPanelRows` had unit tests against a hand-written child list. The one
 * thing neither could see is the only thing the user experiences — whether the
 * command's start input is a shape the HOST accepts, and whether the child it
 * admits reaches the snapshot field the panel reads.
 *
 * So this test spans it: the real `startSubtaskFork`, the real spawner, the real
 * `SessionManager` child-session port, and `getPiHarnessRuntimeSnapshot()
 * .childState.children` — the exact field `useAgentPanel` maps into rows. Only
 * the child RUNTIME is stubbed (a real one would need a live model).
 *
 * The second test spans the same seam to the other surface a fork needs: its
 * permission prompt. An unregistered fork is also an unrendered prompt, so the
 * two were one defect, and the routing half was already built — what was never
 * proven is that a real `/subtask` child carries the facts that routing reads,
 * and that answering the prompt UNBLOCKS the fork.
 *
 * Fork mode is never enabled here. `sub-agents.md:1013` starts a user fork "with
 * or without the variable set", and off is the default, which is the state the
 * defect was measured in.
 */
import { describe, expect, test } from 'bun:test'

import { encodeSessionKey } from '../../../shared/src/sessions/session-key.ts'
import { createPiPermissionService } from '../../../server-core/src/pi-harness/permission-service.ts'
import { createHeadlessPlatform } from '../../../server-core/src/runtime/platform-headless.ts'
import { setSessionPlatform } from '../../../server-core/src/sessions/SessionManager.ts'
import {
  createTestCapabilityResolver,
  createTestSessionManager,
} from '../../../server-core/src/sessions/__tests__/test-session-manager.ts'
import type { PiChildSessionRecordV1 } from '../../../shared/src/agent/pi-harness/child-session-port.ts'
import { BackgroundTaskRegistry } from './background-task-registry.ts'
import { configureSpawner } from './spawner.ts'
import { startSubtaskFork } from './subtask.ts'

const workspaceId = 'workspace-fork-panel'
const sessionId = 'parent-fork-panel'
const session = { workspaceId, sessionId }

interface ChildRunOutcome {
  status: PiChildSessionRecordV1['status']
  output: string
  result?: string
  error?: string
}

interface Harness {
  manager: any
  /** Lifecycle events the subprocess would send to the host. */
  events: Array<{ type: string; taskId: string; status?: string; kind?: string }>
  /** Records handed to the child runtime — i.e. children the host really admitted. */
  admitted: PiChildSessionRecordV1[]
  /** Settle the fork's run, the way a finished child turn would. */
  finishChildRun: (outcome: ChildRunOutcome) => void
  children: () => Promise<readonly any[]>
  cleanup: () => void
}

async function harness(): Promise<Harness> {
  const resolver = createTestCapabilityResolver()
  const manager = createTestSessionManager({ resolver }) as any
  const managed: any = {
    id: sessionId,
    workspace: { id: workspaceId, rootPath: process.cwd(), name: workspaceId, createdAt: 1 },
    ephemeral: true,
    permissionMode: 'allow-all',
    thinkingLevel: 'off',
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

  const admitted: PiChildSessionRecordV1[] = []
  let settleChildRun!: (outcome: ChildRunOutcome) => void
  const childRun = new Promise<ChildRunOutcome>(resolve => { settleChildRun = resolve })
  // The real host publishes a child session and runs its turn. Here the record
  // is captured and the turn is a promise the test settles, which is what makes
  // "while it runs" and "after it ends" two observable states.
  manager.startPiChildRuntime = async (_parent: unknown, record: PiChildSessionRecordV1) => {
    admitted.push(structuredClone(record))
    const runKey = manager.piChildRunKey(session, record.agentId)
    manager.piChildRuns.set(runKey, childRun)
    void childRun.finally(() => {
      if (manager.piChildRuns.get(runKey) === childRun) manager.piChildRuns.delete(runKey)
    })
    return {
      childSessionKey: { workspaceId, sessionId: `child-${record.agentId}` },
      transcriptId: `child-${record.agentId}`,
      status: 'running' as const,
    }
  }

  const snapshot = await resolver.resolve({
    workspaceId, sessionId, enabledSourceNames: [], projectTrustState: 'none', projectTrustRevision: '',
  })
  managed.capabilityRuntime = {
    view: {
      generation: 'fork-panel-generation',
      sources: [], skills: [], mcpServers: [], hooks: [], automations: [], agents: [],
      promptLayers: [], memory: [], commands: [], promptCommands: [], apps: [],
      permissionLayers: [],
    },
    projectTrustState: 'trusted',
    materializer: { assertActive() {}, async readText() { return '' } },
  }
  managed.capabilityLeaseId = snapshot.leaseId
  managed.agentAutomationCapabilityLease = manager.createRetainedCapabilityLease(snapshot.leaseId)

  const port = manager.createPiDelegatingChildSessionPort(managed, createPiPermissionService({}))
  configureSpawner({
    childSessionPort: port,
    modelId: 'parent-session-model',
    retryBaseDelayMs: () => 0,
    sessionToolNames: ['read', 'bash', 'subagent'],
  })

  const events: Harness['events'] = []
  return {
    manager,
    events,
    admitted,
    finishChildRun: outcome => settleChildRun(outcome),
    children: async () => {
      const runtime = await manager.getPiHarnessRuntimeSnapshot(session)
      return runtime.childState?.children ?? []
    },
    cleanup: () => manager.cleanup(),
  }
}

async function waitFor(condition: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (condition()) return
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error(`timed out waiting for ${label}`)
}

describe('a /subtask fork reaches the agents panel', () => {
  test('registers as a child of the session while it runs, and is terminal after', async () => {
    const context = await harness()
    const backgroundTasks = new BackgroundTaskRegistry()
    try {
      const started = await startSubtaskFork({
        task: 'a deliberately slow fork',
        cwd: process.cwd(),
        requestId: 'subtask-1',
        emitEvent: event => context.events.push(event),
        backgroundTasks,
        childSessionPort: { stopTask: async () => {} },
      })

      // The host admitted the fork — which it refuses outright for a background
      // child that carries no background task id.
      expect(context.admitted).toHaveLength(1)
      expect(context.admitted[0]!.backgroundTaskId).toMatch(/^task-fork-/)

      const running = await context.children()
      expect(running).toHaveLength(1)
      // Everything `toAgentPanelRows` needs: the reserved `fork` name it uses as
      // the fork discriminator, the task that tells two forks apart, and a
      // status the panel reads as running.
      expect(running[0]).toMatchObject({
        agentId: started.agentId,
        agent: 'fork',
        task: 'a deliberately slow fork',
        status: 'running',
        background: true,
      })
      // The lifecycle event the host needs to retain the fork's capability
      // authority past the turn that started it.
      expect(context.events).toMatchObject([
        { type: 'task_backgrounded', taskId: context.admitted[0]!.backgroundTaskId, kind: 'subagent' },
      ])
      // ONE registry, both paths: the fork is in the same background-task
      // registry a background subagent uses, which is what `stop_task`,
      // generation teardown and shutdown reach.
      expect(backgroundTasks.activeCount).toBe(1)

      // A finished fork must not sit in the panel as "running" forever: the
      // row's dismiss action is only offered once the status is terminal.
      context.finishChildRun({ status: 'completed', output: 'fork output', result: 'fork output' })
      await waitFor(() => context.events.some(event => event.type === 'task_completed'), 'the fork to settle')
      expect(backgroundTasks.activeCount).toBe(0)
      const finished = await context.children()
      expect(finished).toHaveLength(1)
      expect(finished[0]).toMatchObject({ agentId: started.agentId, agent: 'fork', status: 'completed' })
      expect(context.events.map(event => event.type)).toEqual(['task_backgrounded', 'task_completed'])
      expect(context.events[1]).toMatchObject({ status: 'completed' })
    } finally {
      context.cleanup()
    }
  })

  /**
   * The other half of the same defect (S13 Task 2): an unregistered fork is also
   * an unrendered prompt. `sub-agents.md:1043`–`:1044` give a fork's prompts a
   * surface, and `:1044` gives a background NAMED subagent the same one, so the
   * routing is unconditional for hidden children rather than fork-only.
   *
   * Nothing here is new code — the routing landed with R29b. What was never
   * proven is that the child a `/subtask` fork actually produces carries the two
   * facts the routing reads (hidden, and a link to the visible parent), and that
   * answering the prompt UNBLOCKS the fork rather than merely rendering.
   */
  test('a fork surfaces its permission prompt at the visible parent, and answering it unblocks the fork', async () => {
    setSessionPlatform(createHeadlessPlatform())
    const resolver = createTestCapabilityResolver()
    const manager = createTestSessionManager({ resolver }) as any
    const emitted: Array<{ type: string; sessionId: string; request: Record<string, unknown> }> = []
    manager.sendEvent = (event: any) => { emitted.push(event) }
    try {
      const workspace = 'workspace-fork-prompt'
      const parentSession = await manager.createSession(workspace, { name: 'Parser work' })
      const parent = manager.getManaged(parentSession.id, workspace)
      parent.sdkSessionId = 'pi-session-parent'
      parent.model = 'parent-session-model'
      parent.llmConnection = 'pi-connection'
      parent.permissionMode = 'ask'
      parent.messagesLoaded = true
      parent.messages = [{ id: 'msg-user-1', role: 'user', content: 'PARENT_USER_MESSAGE', timestamp: 1 }]
      manager.persistSession(parent, true)
      await manager.flushSession(parent.id, workspace)
      manager.resolveManagedProvider = () => 'pi'

      // The branch preflight and the child's turn are the only parts that would
      // need a live model.
      manager.getOrCreateAgent = async () => ({ ensureBranchReady: async () => {} })
      let settleChildTurn!: (outcome: { status: PiChildSessionRecordV1['status']; output: string }) => void
      manager.runPiChildTurn = () => new Promise(resolve => { settleChildTurn = resolve })

      const snapshot = await resolver.resolve({
        workspaceId: workspace, sessionId: parent.id, enabledSourceNames: [],
        projectTrustState: 'none', projectTrustRevision: '',
      })
      parent.capabilityRuntime = {
        view: {
          generation: 'fork-prompt-generation',
          sources: [], skills: [], mcpServers: [], hooks: [], automations: [], agents: [],
          promptLayers: [], memory: [], commands: [], promptCommands: [], apps: [],
          permissionLayers: [],
        },
        projectTrustState: 'trusted',
        materializer: { assertActive() {}, async readText() { return '' } },
      }
      parent.capabilityLeaseId = snapshot.leaseId
      parent.agentAutomationCapabilityLease = manager.createRetainedCapabilityLease(snapshot.leaseId)

      configureSpawner({
        childSessionPort: manager.createPiDelegatingChildSessionPort(parent, createPiPermissionService({})),
        modelId: 'parent-session-model',
        retryBaseDelayMs: () => 0,
        sessionToolNames: ['read', 'bash'],
      })
      const started = await startSubtaskFork({
        task: 'check the parser change',
        cwd: process.cwd(),
        requestId: 'subtask-2',
        childSessionPort: { stopTask: async () => {} },
      })

      const record = manager.piChildSessionServices
        .get(encodeSessionKey({ workspaceId: workspace, sessionId: parent.id }))
        .get(started.agentId)
      const child = manager.getManaged(record.childSessionKey.sessionId, workspace)
      // The two facts the prompt routing reads.
      expect(child.hidden).toBe(true)
      expect(child.piParentSessionKey).toEqual({ workspaceId: workspace, sessionId: parent.id })
      child.agent = { respondToPermission: () => undefined }

      const waiting = manager.requestPiToolApproval(child, {
        decisionId: 'fork-decision-1',
        toolName: 'bash',
        type: 'bash',
        description: 'run the tests',
        command: 'bun test',
      }) as Promise<{ allowed: boolean }>

      const prompt = emitted.find(event => event.type === 'permission_request')
      expect(prompt).toBeDefined()
      // Filed against the child (the authority the answer is validated against),
      // shown in the parent (the session the user is actually looking at).
      expect(prompt!.request.sessionId).toBe(child.id)
      expect(prompt!.request.parentSessionId).toBe(parent.id)

      let resolved = false
      void waiting.then(() => { resolved = true })
      await Promise.resolve()
      expect(resolved).toBe(false)

      const accepted = await manager.respondToPermission(child.id, 'fork-decision-1', true, false, undefined, workspace)
      expect(accepted).toBe(true)
      // The unblocking is the point: a prompt that renders and does not release
      // the fork is the same hang with a friendlier face.
      expect(await waiting).toMatchObject({ allowed: true })
      // The stub backend exists only to reach the resolver branch; teardown
      // expects a real one.
      child.agent = undefined

      settleChildTurn({ status: 'completed', output: 'fork output' })
      await waitFor(
        () => manager.piChildSessionServices
          .get(encodeSessionKey({ workspaceId: workspace, sessionId: parent.id }))
          .get(started.agentId).status === 'completed',
        'the fork to reach a terminal status',
      )
    } finally {
      await manager.cleanup()
    }
  })
})
