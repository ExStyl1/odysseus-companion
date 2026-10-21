/**
 * F1.689 (origin WJ-co-docs P-WJcodocs-4) — the "your previous answer was cut short" note survives a restart.
 *
 * The note rides `ManagedSession.wasInterrupted`: set by the user's Stop (`cancelProcessing`), read and cleared by the
 * next real prompt, which gets the `<system-reminder>` saying the previous response was interrupted. The flag lived
 * only in memory, so a session resumed after the server exited — a Stop and then a quit, or a quit (SIGTERM) with the
 * turn still running — met the next prompt with no note, and the model saw a prompt with no answer and nothing
 * saying why.
 *
 * What runs for real: `cancelProcessing`, `persistSession`, `flushAllSessions` (the quit's flush, the only door a
 * quit mid-turn reaches) and the persistence queue writing the session file, then a FRESH manager (the restart)
 * loading it through the real session store — both doors: `ensureMessagesLoaded` (opening the chat) and the
 * cold-persist hydration (anything that writes the session first).
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getSessionFilePath } from '@nessy-agent/shared/sessions'
import { encodeSessionKey } from '@nessy-agent/shared/sessions/session-key'
import { createManagedSession } from '../SessionManager.ts'
import { createTestSessionManager } from './test-session-manager.ts'

const WORKSPACE_ID = 'ws-f1-689'

interface Managed {
  id: string
  isProcessing: boolean
  wasInterrupted?: boolean
  messagesLoaded: boolean
  messages: Array<Record<string, unknown>>
}

interface Internals {
  sessions: Map<string, unknown>
  persistSession(managed: unknown): void
  ensureMessagesLoaded(managed: unknown): Promise<void>
}

const roots: string[] = []
const managers: Array<ReturnType<typeof createTestSessionManager>> = []
let counter = 0

function process_(sessionId: string, messagesLoaded: boolean) {
  const manager = createTestSessionManager()
  managers.push(manager)
  manager.setEventSink((() => {}) as never)
  const root = mkdtempSync(join(tmpdir(), 'f1-689-'))
  roots.push(root)
  const managed = createManagedSession(
    { id: sessionId, name: 'F1.689' },
    { id: WORKSPACE_ID, name: 'F1.689', rootPath: root, createdAt: Date.now() } as never,
    { messagesLoaded },
  ) as unknown as Managed
  const internals = manager as unknown as Internals
  internals.sessions.set(encodeSessionKey({ workspaceId: WORKSPACE_ID, sessionId }), managed)
  return { manager, internals, managed }
}

type Ending = 'stop-then-quit' | 'quit-mid-turn' | 'completed'

/** The process before the restart: a turn, and how it ended. */
async function previousLaunch(ending: Ending): Promise<string> {
  counter += 1
  const sessionId = `session-f1-689-${counter}`
  const before = process_(sessionId, true)
  before.managed.messages.push({ id: 'u-1', role: 'user', content: 'write the long report', timestamp: 1 })
  before.managed.isProcessing = ending !== 'completed'
  // The turn's start puts the user message on disk (sendMessage's synchronous flush).
  before.internals.persistSession(before.managed)
  await before.manager.flushSession(sessionId, WORKSPACE_ID, { strict: true })
  if (ending === 'stop-then-quit') {
    await before.manager.cancelProcessing(sessionId, false, WORKSPACE_ID)
    expect(before.managed.wasInterrupted).toBe(true) // the live half, unchanged
    before.managed.isProcessing = false
    before.internals.persistSession(before.managed)
  }
  // The quit: only the flush runs; a turn still in flight (SIGTERM) is never stopped first.
  await before.manager.flushAllSessions()
  return sessionId
}

function header(sessionId: string): Record<string, unknown> {
  const firstLine = readFileSync(getSessionFilePath(WORKSPACE_ID, sessionId), 'utf-8').split('\n')[0]!
  return JSON.parse(firstLine) as Record<string, unknown>
}

const doors: Array<[string, (after: ReturnType<typeof process_>) => Promise<void>]> = [
  ['opening the chat (ensureMessagesLoaded)', async after => { await after.internals.ensureMessagesLoaded(after.managed) }],
  ['a write before the chat is opened (the cold-persist hydration)', async after => { after.internals.persistSession(after.managed) }],
]

afterEach(async () => {
  for (const manager of managers.splice(0)) await manager.flushAllSessions().catch(() => undefined)
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('F1.689 — the cut-short note survives the server\'s exit', () => {
  for (const ending of ['stop-then-quit', 'quit-mid-turn'] as const) {
    for (const [door, load] of doors) {
      it(`${ending}: the restored session still owes the note — ${door}`, async () => {
        const sessionId = await previousLaunch(ending)
        expect(header(sessionId).wasInterrupted).toBe(true)

        const after = process_(sessionId, false)
        await load(after)

        expect(after.managed.wasInterrupted).toBe(true)
      })
    }
  }

  it('NEGATIVE: a turn that completed writes no note, and a restored session owes none', async () => {
    const sessionId = await previousLaunch('completed')
    expect('wasInterrupted' in header(sessionId)).toBe(false)

    const after = process_(sessionId, false)
    await after.internals.ensureMessagesLoaded(after.managed)

    expect(after.managed.wasInterrupted === true).toBe(false)
  })

  it('once the note is spent (the next prompt clears the flag) the stored copy goes with it', async () => {
    const sessionId = await previousLaunch('stop-then-quit')
    const after = process_(sessionId, false)
    await after.internals.ensureMessagesLoaded(after.managed)
    after.managed.wasInterrupted = false // what the next real prompt does when it adds the note
    after.internals.persistSession(after.managed)
    await after.manager.flushSession(sessionId, WORKSPACE_ID, { strict: true })

    expect('wasInterrupted' in header(sessionId)).toBe(false)
  })
})
