/**
 * The rewind must not report success for an operation that did nothing.
 *
 * On a runtime with no checkpoint producer the manifest is EMPTY rather than
 * absent, which is indistinguishable from "the agent edited nothing" — so
 * `rewindToMessage({ restoreFiles: true })` answered `success: true` with
 * `restoredCheckpoints: 0` and the renderer drew a green success. These tests
 * pin the field that tells the two apart, in both directions and in the third
 * state (`undefined` — the runtime could not be resolved), because a surface
 * that treats absent as untracked lies in the opposite direction.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Message } from '@nessy-agent/core/types'
import {
  createFileCheckpoint,
  finalizeFileCheckpoint,
  getSessionDirPath,
} from '@nessy-agent/shared/sessions'
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

/**
 * `resolveManagedProvider` is stubbed rather than exercised: it resolves a
 * connection out of the user's real on-disk config, so a test that let it run
 * would be measuring the developer's machine. What is NOT stubbed is the thing
 * under test — the manager's own decision and the real `runtimeProducesFileCheckpoints`
 * lookup between them.
 */
function createHarness(
  messages: Message[],
  provider: string | (() => never),
  workspaceRoot = makeTempDir('nessy-rewind-runtime-'),
) {
  const sessionId = 'session-1'
  const events: Array<Record<string, unknown>> = []
  const managed = {
    id: sessionId,
    workspace: { id: 'workspace-1', name: 'Workspace', rootPath: workspaceRoot },
    agent: { dispose() {} },
    messages,
    messagesLoaded: true,
    messageQueue: [],
    queuePaused: false,
    streamingText: '',
    backgroundShellCommands: new Map(),
    backgroundTaskOutputs: new Map(),
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
    getSessionPath: ({ workspaceId, sessionId: stored }: { workspaceId: string; sessionId: string }) =>
      getSessionDirPath(workspaceId, stored),
  }
  manager.ensureMessagesLoaded = async () => {}
  manager.strictDrainSessionForMutation = async () => {}
  manager.persistSession = () => {}
  manager.flushSession = async () => {}
  manager.sendEvent = (event: Record<string, unknown>) => { events.push(event) }
  manager.emitQueueChanged = () => {}
  manager.resolveManagedProvider = typeof provider === 'function'
    ? provider
    : () => provider

  return { manager, managed, sessionId, workspaceRoot, events }
}

afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
  tempDirs = []
  rmSync(join(SESSIONS_DIR, 'workspace-1'), { recursive: true, force: true })
})

describe('rewindToMessage reports whether the runtime tracks file edits', () => {
  const base = Date.now() - 10_000
  const transcript = () => [
    message('u1', 'user', 'edit my file', base),
    message('a1', 'assistant', 'done', base + 1),
  ]

  it('says NOT tracked on a runtime with no checkpoint producer', async () => {
    const harness = createHarness(transcript(), 'anthropic')

    const result = await harness.manager.rewindToMessage(harness.sessionId, 'u1', { restoreFiles: true })

    expect(result.success).toBe(true)
    expect(result.restoredCheckpoints).toBe(0)
    // The whole point: a caller can now tell "nothing needed restoring" from
    // "nothing could be restored".
    expect(result.fileCheckpointsTracked).toBe(false)
    const rewound = harness.events.find(event => event.type === 'conversation_rewound')
    expect(rewound?.fileCheckpointsTracked).toBe(false)
  })

  it('says tracked on Pi, and really restores the file there', async () => {
    const workspaceRoot = makeTempDir('nessy-rewind-runtime-pi-')
    const harness = createHarness(transcript(), 'pi', workspaceRoot)
    const sessionPath = getSessionDirPath('workspace-1', harness.sessionId)
    mkdirSync(sessionPath, { recursive: true })
    const filePath = join(workspaceRoot, 'tracked.txt')
    writeFileSync(filePath, 'before\n')
    const [checkpoint] = await createFileCheckpoint({
      adapter: 'file',
      sessionPath,
      toolName: 'write',
      input: { file_path: filePath },
    })
    writeFileSync(filePath, 'after\n')
    await finalizeFileCheckpoint({ sessionPath, checkpointId: checkpoint!.id, succeeded: true })

    const result = await harness.manager.rewindToMessage(harness.sessionId, 'u1', { restoreFiles: true })

    expect(result.fileCheckpointsTracked).toBe(true)
    expect(result.restoredCheckpoints).toBe(1)
  })

  it('omits the field when files were not asked for at all', async () => {
    const harness = createHarness(transcript(), 'anthropic')

    const result = await harness.manager.rewindToMessage(harness.sessionId, 'u1')

    expect(result.success).toBe(true)
    expect('fileCheckpointsTracked' in result).toBe(false)
  })

  it('omits the field rather than guessing when the runtime cannot be resolved', async () => {
    const harness = createHarness(transcript(), () => { throw new Error('config unreadable') })

    const result = await harness.manager.rewindToMessage(harness.sessionId, 'u1', { restoreFiles: true })

    // Absent, not `false`: a failed config read must not tell the user their
    // edits were untracked, and must not abort the rewind either.
    expect(result.success).toBe(true)
    expect('fileCheckpointsTracked' in result).toBe(false)
  })
})

describe('revertFileCheckpoint explains an empty manifest', () => {
  it('reports the runtime does not track when the manifest is empty', async () => {
    // C3.67 · the non-producer arm was `codex-runtime` until codex grew a real
    // producer. `anthropic` is the surviving one, and the case still asks the
    // same question: an empty manifest on a runtime with no producer means "we
    // could not have restored anything", not "there was nothing to restore".
    const harness = createHarness([], 'anthropic')

    const result = await harness.manager.revertFileCheckpoint(harness.sessionId)

    expect(result.success).toBe(false)
    expect(result.fileCheckpointsTracked).toBe(false)
  })

  it('stays silent about tracking when checkpoints exist but none is revertable', async () => {
    const workspaceRoot = makeTempDir('nessy-revert-reverted-')
    const harness = createHarness([], 'pi', workspaceRoot)
    const sessionPath = getSessionDirPath('workspace-1', harness.sessionId)
    mkdirSync(sessionPath, { recursive: true })
    const filePath = join(workspaceRoot, 'tracked.txt')
    writeFileSync(filePath, 'before\n')
    const [checkpoint] = await createFileCheckpoint({
      adapter: 'file',
      sessionPath,
      toolName: 'write',
      input: { file_path: filePath },
    })
    writeFileSync(filePath, 'after\n')
    await finalizeFileCheckpoint({ sessionPath, checkpointId: checkpoint!.id, succeeded: true })
    await harness.manager.revertFileCheckpoint(harness.sessionId)

    const second = await harness.manager.revertFileCheckpoint(harness.sessionId)

    // The manifest is not empty, so "no checkpoint found" here means "already
    // reverted" — a tracking note would be noise, and on a tracked runtime it
    // would also be the wrong explanation.
    expect(second.success).toBe(false)
    expect('fileCheckpointsTracked' in second).toBe(false)
  })
})
