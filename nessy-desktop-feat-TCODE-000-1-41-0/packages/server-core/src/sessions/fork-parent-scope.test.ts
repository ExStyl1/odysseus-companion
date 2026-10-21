/**
 * R29b Task 3 — one property, three consumers.
 *
 * `sub-agents.md:1036` — "A fork inherits everything the main session has at the
 * moment it spawns. A named subagent starts from its own definition." A fork is
 * INSIDE the parent's session scope; a named subagent is OUTSIDE it. Each test
 * here asserts BOTH sides, because a test that only checks the fork proves the
 * half that was already accidentally right.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Message } from '@nessy-agent/core/types'
import { createFileCheckpoint, finalizeFileCheckpoint, getSessionDirPath } from '@nessy-agent/shared/sessions'
import { SESSIONS_DIR } from '@nessy-agent/shared/workspaces'
import { SessionManager } from './SessionManager'
import { createTestSessionManager } from './__tests__/test-session-manager.ts'

let tempDirs: string[] = []

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

function message(id: string, role: Message['role'], content: string, timestamp: number): Message {
  return { id, role, content, timestamp } as Message
}

function childRecord(agentId: string, childSessionId: string, fork: boolean) {
  return {
    schemaVersion: 1 as const,
    agentId,
    parentSessionKey: { workspaceId: 'workspace-1', sessionId: 'session-1' },
    childSessionKey: { workspaceId: 'workspace-1', sessionId: childSessionId },
    agent: fork ? 'fork' : 'scout',
    task: 'do the thing',
    background: true,
    restrictions: {
      prompt: fork ? '' : 'scout prompt',
      model: 'm',
      tools: [],
      thinkingLevel: 'off' as const,
      worktreePolicy: 'shared' as const,
      ...(fork ? { fork: true as const } : {}),
    },
    budgets: { depth: 1, maxDepth: 3, fanout: 10, concurrency: 4, tokenLimit: 1, costLimitUsd: 1, deadlineAt: Date.now() + 1000, ancestry: [] },
    status: 'completed' as const,
    output: '',
    createdAt: 1,
    updatedAt: 1,
  }
}

function createHarness(messages: Message[], workspaceRoot: string) {
  const sessionId = 'session-1'
  const drained: string[] = []
  const managed = {
    id: sessionId,
    workspace: { id: 'workspace-1', name: 'Workspace', rootPath: workspaceRoot },
    agent: { dispose() {} },
    messages,
    isProcessing: false,
    lastMessageAt: messages.at(-1)?.timestamp ?? Date.now(),
    lastMessageRole: messages.at(-1)?.role,
    streamingText: '',
    processingGeneration: 0,
    messageQueue: [],
    queuePaused: false,
    backgroundShellCommands: new Map(),
    backgroundTaskOutputs: new Map(),
    messagesLoaded: true,
  } as Record<string, any>

  // D1.242 — a REAL instance through `createTestSessionManager`, not
  // a bare prototype double. Every assignment below still
  // overrides exactly what it overrode; what changes is that the fields NOBODY
  // seeded are now the constructor's rather than `undefined`, so a method that
  // starts reading one fails here instead of passing against a shape the
  // product never has. Priced by D1.109's demonstration: the real constructor
  // is a `mkdtemp` and four in-memory stores, 68.38 s -> 62.45 s at ~3 % cpu,
  // i.e. not measurably expensive.
  const manager = createTestSessionManager() as any
  manager.sessions = new Map([[sessionId, managed]])
  manager.pendingDeltas = new Map()
  manager.deltaFlushTimers = new Map()
  manager.pendingPermissionRequests = new Map()
  manager.directPermissionResolvers = new Map()
  manager.projectMutationSessions = new Set()
  manager.piGoalServices = new Map()
  manager.sessionStore = {
    getSessionPath: ({ workspaceId, sessionId: storedSessionId }: { workspaceId: string; sessionId: string }) =>
      getSessionDirPath(workspaceId, storedSessionId),
  }
  manager.ensureMessagesLoaded = async () => undefined
  manager.disposeManagedAgentRuntime = async (session: Record<string, unknown>) => { session.agent = null }
  // The real drain is what stops every running child before a rewind touches
  // anything; here it only records that it ran ahead of the restore.
  manager.strictDrainSessionForMutation = async (session: Record<string, any>, reason: string) => {
    drained.push(reason)
    await manager.disposeManagedAgentRuntime(session)
  }
  manager.persistSession = () => undefined
  manager.flushSession = async () => undefined
  manager.sendEvent = () => undefined
  manager.emitQueueChanged = () => undefined

  return { manager, managed, sessionId, drained }
}

/** Writes `before`, checkpoints it, writes `after`, finalizes. */
async function checkpointed(sessionPath: string, filePath: string): Promise<void> {
  mkdirSync(sessionPath, { recursive: true })
  writeFileSync(filePath, 'before\n')
  const [checkpoint] = await createFileCheckpoint({
    adapter: 'file',
    sessionPath,
    toolName: 'write',
    input: { file_path: filePath },
  })
  writeFileSync(filePath, 'after\n')
  await finalizeFileCheckpoint({ sessionPath, checkpointId: checkpoint!.id, succeeded: true })
}

afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
  tempDirs = []
  rmSync(join(SESSIONS_DIR, 'workspace-1'), { recursive: true, force: true })
})

describe('a rewind of the parent reaches its forks and stops there', () => {
  it("restores a fork child's file edit and leaves a named subagent's alone", async () => {
    const workspaceRoot = makeTempDir('nessy-fork-rewind-')
    const base = Date.now() - 10_000
    const harness = createHarness([
      message('u1', 'user', 'rewind here', base),
      message('a1', 'assistant', 'done', base + 1),
    ], workspaceRoot)

    // The parent's own edit, and one from each kind of child. All three
    // checkpoints are created after the rewind anchor.
    const parentFile = join(workspaceRoot, 'parent.txt')
    const forkFile = join(workspaceRoot, 'fork.txt')
    const namedFile = join(workspaceRoot, 'named.txt')
    await checkpointed(getSessionDirPath('workspace-1', 'session-1'), parentFile)
    await checkpointed(getSessionDirPath('workspace-1', 'fork-child'), forkFile)
    await checkpointed(getSessionDirPath('workspace-1', 'named-child'), namedFile)

    harness.managed.childSessionState = {
      schemaVersion: 1,
      revision: 1,
      sealedOwnerTaskIds: [],
      children: [
        childRecord('fork-agent', 'fork-child', true),
        childRecord('named-agent', 'named-child', false),
      ],
    }

    const result = await harness.manager.rewindToMessage(harness.sessionId, 'u1', { restoreFiles: true })

    expect(result.success).toBe(true)
    // The parent's own edit and its FORK's are both undone…
    expect(readFileSync(parentFile, 'utf8')).toBe('before\n')
    expect(readFileSync(forkFile, 'utf8')).toBe('before\n')
    // …and the named subagent's is not: it started from its own definition and
    // is outside the parent's scope.
    expect(readFileSync(namedFile, 'utf8')).toBe('after\n')
    expect(result.restoredCheckpoints).toBe(2)
    // Running children are stopped before anything is restored.
    expect(harness.drained).toEqual(['conversation rewind'])
  })

  it('is a no-op for a session with no fork children', async () => {
    const workspaceRoot = makeTempDir('nessy-fork-rewind-none-')
    const base = Date.now() - 10_000
    const harness = createHarness([message('u1', 'user', 'rewind here', base)], workspaceRoot)
    const parentFile = join(workspaceRoot, 'parent.txt')
    await checkpointed(getSessionDirPath('workspace-1', 'session-1'), parentFile)

    const result = await harness.manager.rewindToMessage(harness.sessionId, 'u1', { restoreFiles: true })
    expect(result.success).toBe(true)
    expect(result.restoredCheckpoints).toBe(1)
  })
})
