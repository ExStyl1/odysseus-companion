import { afterEach, describe, expect, it } from 'bun:test'
import { linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Message } from '@nessy-agent/core/types'
import { createFileCheckpoint, finalizeFileCheckpoint, getSessionDirPath, listFileCheckpoints } from '@nessy-agent/shared/sessions'
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

function createHarness(messages: Message[], workspaceRoot = makeTempDir('nessy-rewind-workspace-')) {
  const sessionId = 'session-1'
  const events: Array<{ event: Record<string, unknown>; workspaceId: string }> = []
  const managed = {
    id: sessionId,
    workspace: {
      id: 'workspace-1',
      name: 'Workspace',
      rootPath: workspaceRoot,
    },
    agent: { dispose() {} },
    messages,
    isProcessing: false,
    lastMessageAt: messages.at(-1)?.timestamp ?? Date.now(),
    lastMessageRole: messages.at(-1)?.role,
    lastFinalMessageId: messages.findLast(m => m.role === 'assistant')?.id,
    streamingText: '',
    processingGeneration: 0,
    isFlagged: false,
    sdkSessionId: 'sdk-old',
    piContinuationEnvelope: { schemaVersion: 1, capabilityGeneration: 'old' },
    goalState: { schemaVersion: 1, goal: { id: 'goal-1' } },
    messageQueue: [{ message: 'queued later' }],
    queuePaused: true,
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
  let disposed = false
  let persisted = false
  let flushedSessionId: string | null = null

  manager.sessions = new Map([[sessionId, managed]])
  manager.pendingDeltas = new Map()
  manager.deltaFlushTimers = new Map()
  manager.pendingPermissionRequests = new Map()
  manager.directPermissionResolvers = new Map()
  manager.projectMutationSessions = new Set()
  manager.piGoalServices = new Map([[manager.managedKey(managed), {}]])
  manager.sessionStore = {
    getSessionPath: ({ workspaceId, sessionId: storedSessionId }: { workspaceId: string; sessionId: string }) =>
      getSessionDirPath(workspaceId, storedSessionId),
  }
  manager.ensureMessagesLoaded = async (session: Record<string, unknown>) => {
    session.messagesLoaded = true
  }
  manager.disposeManagedAgentRuntime = async (session: Record<string, unknown>) => {
    disposed = true
    session.agent = null
  }
  manager.strictDrainSessionForMutation = async (session: Record<string, unknown>) => {
    await manager.disposeManagedAgentRuntime(session)
  }
  manager.persistSession = () => {
    persisted = true
  }
  manager.flushSession = async (sessionIdToFlush: string) => {
    flushedSessionId = sessionIdToFlush
  }
  manager.sendEvent = (event: Record<string, unknown>, workspaceId: string) => {
    events.push({ event, workspaceId })
  }
  manager.emitQueueChanged = (session: Record<string, any>) => {
    events.push({
      event: {
        type: 'queue_changed',
        sessionId: session.id,
        queue: [],
        paused: false,
      },
      workspaceId: session.workspace.id,
    })
  }

  return {
    manager,
    managed,
    sessionId,
    workspaceRoot,
    events,
    get disposed() { return disposed },
    get persisted() { return persisted },
    get flushedSessionId() { return flushedSessionId },
  }
}

afterEach(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true })
  }
  tempDirs = []
  rmSync(join(SESSIONS_DIR, 'workspace-1'), { recursive: true, force: true })
})

/**
 * P6.103 — the PRE-click answer the rewind menu had no way to ask for.
 *
 * `checkpointing.md#rewind-and-summarize`: "The two code restore options appear
 * only when the selected checkpoint has tracked file changes to revert."
 */
describe('SessionManager.listRewindTrackedChanges', () => {
  it('names the anchors a file-restoring rewind would revert something for, and only those', async () => {
    const workspaceRoot = makeTempDir('nessy-rewind-tracked-')
    const sessionId = 'session-1'
    const sessionPath = getSessionDirPath('workspace-1', sessionId)
    mkdirSync(sessionPath, { recursive: true })
    const filePath = join(workspaceRoot, 'tracked.txt')
    writeFileSync(filePath, 'before\n')

    // u1 is BEFORE the edit, u2 after it — the ordinary shape of "you asked,
    // Claude edited, you asked again".
    const before = Date.now() - 60_000
    const [checkpoint] = await createFileCheckpoint({
      adapter: 'file',
      sessionPath,
      toolName: 'write',
      input: { file_path: filePath },
    })
    writeFileSync(filePath, 'after\n')
    await finalizeFileCheckpoint({ sessionPath, checkpointId: checkpoint!.id, succeeded: true })

    const harness = createHarness([
      message('u1', 'user', 'before the edit', before),
      message('a1', 'assistant', 'edited', before + 1),
      message('u2', 'user', 'after the edit', Date.now() + 60_000),
    ], workspaceRoot)

    const result = await harness.manager.listRewindTrackedChanges(sessionId)

    expect(result.success).toBe(true)
    // The positive AND its negative in one assertion: an anchor with edits after
    // it, and one with none, from the same walk.
    expect(result.messageIds).toEqual(['u1'])
  })

  it('counts a REVERTED checkpoint as nothing, so a second rewind offers nothing to revert', async () => {
    const workspaceRoot = makeTempDir('nessy-rewind-tracked-none-')
    const sessionId = 'session-1'
    const sessionPath = getSessionDirPath('workspace-1', sessionId)
    mkdirSync(sessionPath, { recursive: true })
    const before = Date.now() - 60_000

    // The boundary: no checkpoints at all. `success` must still be true — an
    // empty answer is an ANSWER, and the renderer hides the action on it, while
    // `success: false` would make it fail open instead.
    const harness = createHarness([
      message('u1', 'user', 'nothing was edited', before),
    ], workspaceRoot)

    const result = await harness.manager.listRewindTrackedChanges(sessionId)

    expect(result).toEqual({ success: true, messageIds: [] })
  })

  it('reads the CHECKPOINTS and never the runtime — the Pi-era-then-switched control', async () => {
    // The control the row names by name: a session that ran on Pi and later
    // switched has real revertable checkpoints, and a rewind reverts them
    // whatever runtime is current. The stubs answer "this runtime does not track
    // file edits" and "this session is on claude"; the anchor must still be
    // named, so a provider gate added here fails this row instead of silently
    // hiding a working button.
    const workspaceRoot = makeTempDir('nessy-rewind-tracked-switched-')
    const sessionId = 'session-1'
    const sessionPath = getSessionDirPath('workspace-1', sessionId)
    mkdirSync(sessionPath, { recursive: true })
    const filePath = join(workspaceRoot, 'pi-era.txt')
    writeFileSync(filePath, 'written on pi\n')
    const before = Date.now() - 60_000
    const [checkpoint] = await createFileCheckpoint({
      adapter: 'file',
      sessionPath,
      toolName: 'write',
      input: { file_path: filePath },
    })
    writeFileSync(filePath, 'edited on pi\n')
    await finalizeFileCheckpoint({ sessionPath, checkpointId: checkpoint!.id, succeeded: true })

    const harness = createHarness([
      message('u1', 'user', 'asked on pi', before),
    ], workspaceRoot)
    harness.manager.managedRuntimeTracksFileEdits = () => false
    harness.manager.resolveManagedProvider = () => 'anthropic'

    const result = await harness.manager.listRewindTrackedChanges(sessionId)

    expect(result.messageIds).toEqual(['u1'])
  })
})

describe('SessionManager.rewindToMessage', () => {
  it('pins the selected latest checkpoint before the drain boundary yields', async () => {
    const workspaceRoot = makeTempDir('nessy-rewind-pinned-')
    const harness = createHarness([], workspaceRoot)
    const sessionPath = getSessionDirPath('workspace-1', harness.sessionId)
    mkdirSync(sessionPath, { recursive: true })
    const filePath = join(workspaceRoot, 'pinned.txt')
    writeFileSync(filePath, 'before\n')
    const [selected] = await createFileCheckpoint({
      adapter: 'file',
      sessionPath,
      toolName: 'write',
      input: { file_path: filePath },
    })
    writeFileSync(filePath, 'after selected\n')
    await finalizeFileCheckpoint({ sessionPath, checkpointId: selected!.id, succeeded: true })

    let enterDrain!: () => void
    let releaseDrain!: () => void
    const drainEntered = new Promise<void>(resolve => { enterDrain = resolve })
    const drainGate = new Promise<void>(resolve => { releaseDrain = resolve })
    harness.manager.strictDrainSessionForMutation = async () => {
      enterDrain()
      await drainGate
    }

    const rewind = harness.manager.revertFileCheckpoint(harness.sessionId)
    await drainEntered
    const [newer] = await createFileCheckpoint({
      adapter: 'file',
      sessionPath,
      toolName: 'edit',
      input: { file_path: filePath },
    })
    writeFileSync(filePath, 'after newer\n')
    await finalizeFileCheckpoint({ sessionPath, checkpointId: newer!.id, succeeded: true })
    releaseDrain()

    const result = await rewind
    expect(result).toMatchObject({ success: false, conflict: true, checkpointId: selected!.id })
    const checkpoints = await listFileCheckpoints(sessionPath)
    // Both checkpoints must still BE there. `find(...)?.revertedAt` is
    // `undefined` for a checkpoint that was deleted rather than left unreverted,
    // so without these two lines a conflict that wiped the ledger reads exactly
    // like a conflict that correctly reverted nothing.
    const selectedAfter = checkpoints.find(checkpoint => checkpoint.id === selected!.id)
    const newerAfter = checkpoints.find(checkpoint => checkpoint.id === newer!.id)
    expect(selectedAfter).toBeDefined()
    expect(newerAfter).toBeDefined()
    expect(selectedAfter?.revertedAt).toBeUndefined()
    expect(newerAfter?.revertedAt).toBeUndefined()
  })

  it('truncates the transcript to the target user message and resets continuation state', async () => {
    const base = Date.now() - 10_000
    const harness = createHarness([
      message('u1', 'user', 'first', base),
      message('a1', 'assistant', 'answer', base + 1),
      message('u2', 'user', 'rewind here', base + 2),
      message('a2', 'assistant', 'remove me', base + 3),
    ])

    const result = await harness.manager.rewindToMessage(harness.sessionId, 'u2')

    // 2026-09-11 (W12-c) · re-pinned onto `16e978ea5` (P6.545), which made the
    // rewound prompt LEAVE the transcript with everything after it so that
    // re-sending the text the composer now holds makes one copy rather than
    // two. This case was written before that and still asserted the retained
    // prompt; the contract itself is covered by `rewind-selected-prompt.test.ts`
    // and what this case is for is the CONTINUATION STATE reset below, which
    // that file does not touch.
    expect(result).toMatchObject({
      success: true,
      messageId: 'u2',
      removedMessages: 2,
    })
    expect(harness.managed.messages.map((m: Message) => m.id)).toEqual(['u1', 'a1'])
    expect(harness.managed.messageQueue).toEqual([])
    expect(harness.managed.queuePaused).toBe(false)
    expect(harness.managed.sdkSessionId).toBeUndefined()
    expect(harness.managed.piContinuationEnvelope).toBeUndefined()
    expect(harness.managed.goalState).toBeUndefined()
    expect(harness.manager.piGoalServices.size).toBe(0)
    expect(harness.managed.branchFromMessageId).toBe('u2')
    expect(harness.managed.branchContextStrategy).toBe('seeded-fresh-session')
    expect(harness.managed.branchSeedApplied).toBe(false)
    expect(harness.disposed).toBe(true)
    expect(harness.persisted).toBe(true)
    expect(harness.flushedSessionId).toBe(harness.sessionId)
    expect(harness.events.some(({ event }) => event.type === 'queue_changed')).toBe(true)
    expect(harness.events.find(({ event }) => event.type === 'conversation_rewound')?.event).toMatchObject({
      sessionId: harness.sessionId,
      messageId: 'u2',
      removedMessages: 2,
      // Derived from what SURVIVES, per P6.545: `'user'` was true only while
      // the selected prompt stayed in the transcript.
      lastMessageRole: 'assistant',
    })
  })

  it('restores unreverted file checkpoints after the target timestamp newest-first', async () => {
    const workspaceRoot = makeTempDir('nessy-rewind-files-')
    const base = Date.now() - 60_000
    const harness = createHarness([
      message('u1', 'user', 'before edits', base),
      message('a1', 'assistant', 'editing files', base + 1),
    ], workspaceRoot)
    // Checkpoints live in the global v2 session dir (SESSIONS_DIR/<workspaceId>/<sessionId>)
    const sessionPath = getSessionDirPath('workspace-1', harness.sessionId)
    mkdirSync(sessionPath, { recursive: true })

    const filePath = join(workspaceRoot, 'example.txt')
    writeFileSync(filePath, 'before\n')
    const [first] = await createFileCheckpoint({
      adapter: 'file',
      sessionPath,
      toolName: 'write',
      input: { file_path: filePath },
    })
    writeFileSync(filePath, 'after first edit\n')
    await finalizeFileCheckpoint({ sessionPath, checkpointId: first!.id, succeeded: true })
    const [second] = await createFileCheckpoint({
      adapter: 'file',
      sessionPath,
      toolName: 'edit',
      input: { file_path: filePath },
    })
    writeFileSync(filePath, 'after second edit\n')
    await finalizeFileCheckpoint({ sessionPath, checkpointId: second!.id, succeeded: true })

    const result = await harness.manager.rewindToMessage(harness.sessionId, 'u1', {
      restoreFiles: true,
    })

    expect(result.success).toBe(true)
    expect(result.restoredCheckpoints).toBe(2)
    expect(result.failedCheckpoints).toBeUndefined()
    expect(readFileSync(filePath, 'utf8')).toBe('before\n')
  })

  it('restores what it safely can and reports the paths it left alone for link safety', async () => {
    // Both the tracked file and its alias live inside this test's own temp
    // workspace; nothing is linked anywhere the test did not create.
    const workspaceRoot = makeTempDir('nessy-rewind-links-')
    const base = Date.now() - 60_000
    const harness = createHarness([
      message('u1', 'user', 'before edits', base),
      message('a1', 'assistant', 'editing files', base + 1),
    ], workspaceRoot)
    const sessionPath = getSessionDirPath('workspace-1', harness.sessionId)
    mkdirSync(sessionPath, { recursive: true })

    const safePath = join(workspaceRoot, 'safe.txt')
    const linkedPath = join(workspaceRoot, 'linked.txt')
    writeFileSync(safePath, 'safe before\n')
    writeFileSync(linkedPath, 'linked before\n')
    for (const [toolCallId, filePath, after] of [
      ['safe', safePath, 'safe after\n'],
      ['linked', linkedPath, 'linked after\n'],
    ] as const) {
      const [entry] = await createFileCheckpoint({
        adapter: 'file', sessionPath, toolName: 'edit', toolCallId, input: { file_path: filePath },
      })
      writeFileSync(filePath, after)
      await finalizeFileCheckpoint({ sessionPath, checkpointId: entry!.id, succeeded: true })
    }

    const aliasPath = join(workspaceRoot, 'alias.txt')
    linkSync(linkedPath, aliasPath)
    const aliasBefore = readFileSync(aliasPath)

    const result = await harness.manager.rewindToMessage(harness.sessionId, 'u1', {
      restoreFiles: true,
    })

    // Partial, and it says so: the safe file is back, the aliased inode is
    // untouched, and the count reaches the caller.
    expect(result.success).toBe(true)
    expect(result.restoredCheckpoints).toBe(1)
    expect(result.skippedLinks).toBe(1)
    expect(result.skippedPaths).toEqual([{ filePath: linkedPath, reason: 'hard-link' }])
    expect(result.failedCheckpoints).toBeUndefined()
    expect(readFileSync(safePath, 'utf8')).toBe('safe before\n')
    expect(readFileSync(linkedPath, 'utf8')).toBe('linked after\n')
    expect(readFileSync(aliasPath)).toEqual(aliasBefore)
    expect(readFileSync(aliasPath, 'utf8')).toBe('linked after\n')
    expect(harness.events.find(({ event }) => event.type === 'conversation_rewound')?.event).toMatchObject({
      restoredCheckpoints: 1,
      skippedLinks: 1,
    })
  })
})
