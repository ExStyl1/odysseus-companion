/**
 * F1.335 — a message sent AFTER Stop, while the stopped turn is still draining,
 * is queued on every runtime; it is never steered into the dying turn.
 *
 * Measured before this row (WJ-gg P-WJgg-7): `cancelProcessing` sets
 * `stopRequested` and leaves `isProcessing` true until the drain ends, so a send
 * in that window took `sendMessage`'s mid-stream branch with the connection's
 * default — `'steer'` on Pi, Claude and codex — and called `redirect()` on a
 * turn the user had just stopped. On Claude that steer could be drained into a
 * PreToolUse hook of the dying turn after the host had already taken the FIFO
 * at Stop; on Pi and codex what a steer does after Stop was never measured.
 *
 * DECIDED by the controller (2026-09-23): host-uniform — `stopRequested` →
 * `'queue'` in `effectiveMidStreamBehavior` (rule 2b), above the one-message
 * override. The Claude FIFO's own pause + generation guard is the other half
 * (`claude-steer-fifo.test.ts`, F1.335).
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { encodeSessionKey } from '@nessy-agent/shared/sessions/session-key'
import { createManagedSession } from '../SessionManager.ts'
import { createTestSessionManager } from './test-session-manager.ts'

const WORKSPACE_ID = 'ws-f1-335'

interface Row { id: string; role: string; content: string; isQueued?: boolean }
interface Managed {
  id: string
  isProcessing: boolean
  agent: unknown
  messages: Row[]
  messageQueue: Array<{ message: string; messageId?: string }>
  queuePaused: boolean
  stopRequested?: boolean
}

/** The three runtimes' steering shapes, as far as the host can see them. */
function backend(kind: 'pi' | 'claude' | 'codex') {
  const redirected: string[] = []
  const agent: Record<string, unknown> = {
    isProcessing: () => true,
    redirect: (message: string) => { redirected.push(message); return true },
    forceAbort: () => undefined,
    interruptForHandoff: () => undefined,
  }
  if (kind === 'claude') agent.takePendingSteers = () => []
  if (kind === 'codex') agent.redirectFallbackInterruptsTurn = () => false
  return { agent, redirected }
}

/**
 * A Stop arms `cancelProcessing`'s 5 s safety timer, which calls `onProcessingStopped`
 * — and so replays the queue — only while `stopRequested && isProcessing`. Left armed,
 * it fired inside LATER files of the same bun process and slowed them past their
 * budget (measured: a neighbour's 5 000 ms timeout). Every session a test created is
 * defused after it.
 */
const created: Array<{ stopRequested?: boolean; isProcessing: boolean }> = []
afterEach(() => {
  for (const session of created.splice(0)) {
    session.stopRequested = false
    session.isProcessing = false
  }
})

function rig(sessionId: string, agent: unknown) {
  const sm = createTestSessionManager()
  const statuses: Array<{ type: string; status?: string }> = []
  sm.setEventSink(((...args: unknown[]) => { statuses.push(args[2] as { type: string; status?: string }) }) as never)
  const root = mkdtempSync(join(tmpdir(), 'f1-335-'))
  const managed = createManagedSession(
    { id: sessionId, name: 'F1.335' },
    { id: WORKSPACE_ID, name: 'F1.335', rootPath: root, createdAt: Date.now() } as never,
    { messagesLoaded: true },
  ) as unknown as Managed
  ;(sm as unknown as { sessions: Map<string, unknown> }).sessions.set(
    encodeSessionKey({ workspaceId: WORKSPACE_ID, sessionId }),
    managed,
  )
  managed.agent = agent
  managed.isProcessing = true
  created.push(managed as unknown as { stopRequested?: boolean; isProcessing: boolean })
  return { sm, managed, statuses }
}

describe('F1.335 — a send after Stop is queued, host-uniform', () => {
  for (const kind of ['pi', 'claude', 'codex'] as const) {
    it(`${kind}: a send while the stopped turn drains is queued, never steered`, async () => {
      const b = backend(kind)
      const h = rig(`after-stop-${kind}`, b.agent)
      await h.sm.cancelProcessing(h.managed.id, false, WORKSPACE_ID)
      expect(h.managed.stopRequested).toBe(true) // control: the drain window is open
      expect(h.managed.isProcessing).toBe(true)

      await h.sm.sendMessage(h.managed.id, 'after the stop')

      // THE DEFECT: `redirect('after the stop')` on a turn the user had just stopped.
      expect(b.redirected).toEqual([])
      expect(h.managed.messageQueue.map(entry => entry.message)).toEqual(['after the stop'])
      const row = h.managed.messages.find(message => message.role === 'user' && message.content === 'after the stop')
      expect(row?.isQueued).toBe(true)
    })

    it(`${kind}: CONTROL — with no Stop the same send still steers`, async () => {
      const b = backend(kind)
      const h = rig(`no-stop-${kind}`, b.agent)

      await h.sm.sendMessage(h.managed.id, 'a correction')

      expect(b.redirected).toEqual(['a correction'])
      expect(h.managed.messageQueue).toEqual([])
    })
  }

  it('the one-message override cannot steer into a stopped turn either', async () => {
    const b = backend('pi')
    const h = rig('after-stop-override', b.agent)
    await h.sm.cancelProcessing(h.managed.id, false, WORKSPACE_ID)

    await h.sm.sendMessage(h.managed.id, 'steer this one', undefined, undefined, { midStreamOverride: 'steer' } as never)

    expect(b.redirected).toEqual([])
    expect(h.managed.messageQueue.map(entry => entry.message)).toEqual(['steer this one'])
  })
})
