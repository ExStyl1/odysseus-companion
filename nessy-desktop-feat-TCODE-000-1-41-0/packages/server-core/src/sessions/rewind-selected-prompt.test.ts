/**
 * P6.545 — the rewound prompt leaves the transcript with everything after it.
 *
 * `checkpointing.md#rewind-and-summarize`, verbatim: *"After restoring the
 * conversation or choosing Summarize from here, the original prompt from the
 * selected message is restored into the input field so you can re-send or edit
 * it."* A prompt handed back for RE-SENDING is one the transcript no longer
 * holds. Ours retained it, so once P6.104 put it into the composer, sending it
 * again appended a second copy and the history read as if the user had asked
 * twice — a divergence in the rewind ACTION, not in the composer.
 *
 * The harness is `rewind-runtime-tracking.test.ts`'s, deliberately: it drives
 * the real `rewindToMessage` with only the disk and provider seams stubbed.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Message } from '@nessy-agent/core/types'
import { getSessionDirPath } from '@nessy-agent/shared/sessions'
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

function createHarness(messages: Message[]) {
  const sessionId = 'session-1'
  const events: Array<Record<string, unknown>> = []
  const managed = {
    id: sessionId,
    workspace: { id: 'workspace-1', name: 'Workspace', rootPath: makeTempDir('nessy-rewind-prompt-') },
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
  manager.resolveManagedProvider = () => 'pi'

  return { manager, managed, sessionId, events }
}

afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
  tempDirs = []
  rmSync(join(SESSIONS_DIR, 'workspace-1'), { recursive: true, force: true })
})

const base = Date.now() - 10_000
const transcript = () => [
  message('u1', 'user', 'first ask', base),
  message('a1', 'assistant', 'first answer', base + 1),
  message('u2', 'user', 'the prompt being rewound to', base + 2),
  message('a2', 'assistant', 'second answer', base + 3),
]

describe('P6.545 the selected prompt is removed, not retained', () => {
  it('drops the prompt itself and everything after it', async () => {
    const harness = createHarness(transcript())

    const result = await harness.manager.rewindToMessage(harness.sessionId, 'u2')

    expect(result.success).toBe(true)
    expect(result.messages.map((m: { id: string }) => m.id)).toEqual(['u1', 'a1'])
    // Two removed, not one: the prompt counts, and the number the renderer
    // shows has to agree with what it is about to render.
    expect(result.removedMessages).toBe(2)
    // The whole reason the row exists: re-sending the text the composer now
    // holds produces ONE copy, because none is left behind.
    expect(harness.managed.messages.some((m: { content: string }) => m.content === 'the prompt being rewound to'))
      .toBe(false)
    // Derived from what survives. `lastMessageRole = 'user'` was true only while
    // the selected prompt stayed.
    expect(harness.managed.lastMessageRole).toBe('assistant')
    expect(harness.managed.lastMessageAt).toBe(base + 1)
  })

  it('a rewind to the first message leaves no messages and no role', async () => {
    const harness = createHarness(transcript())

    const result = await harness.manager.rewindToMessage(harness.sessionId, 'u1')

    expect(result.success).toBe(true)
    expect(result.messages).toEqual([])
    expect(result.removedMessages).toBe(4)
    expect(harness.managed.lastMessageRole).toBeUndefined()
    // Nothing survives, so the boundary falls back to the rewind point itself
    // rather than to `Date.now()`, which would reorder the session list.
    expect(harness.managed.lastMessageAt).toBe(base)
  })

  it('still refuses to rewind to an assistant message', async () => {
    const harness = createHarness(transcript())
    const result = await harness.manager.rewindToMessage(harness.sessionId, 'a1')
    expect(result.success).toBe(false)
    expect(result.error).toContain('user message')
    // The control: a refusal changes nothing.
    expect(harness.managed.messages).toHaveLength(4)
  })
})
