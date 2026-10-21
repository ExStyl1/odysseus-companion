/**
 * F1.481 (1)(2) — what the queue strip is told about a queued row.
 *
 * (1) P-qqb-2: a mid-turn send of ONE file queues an entry carrying both
 * `attachments` and `storedAttachments` — the RPC handler passes both,
 * index-aligned copies of the same files — and `queueDto` ADDED them, so the
 * strip said "Attachments: 2" for one file. The count is now the larger of the
 * two; a recovered row (only `storedAttachments` survives a restart) still
 * counts its files.
 *
 * (2) P-qqb-3: since F1.337 `sendQueuedNow` keeps a queued WORKFLOW row queued
 * when Steer is pressed mid-turn (`queueHoldsUnsteerablePayload`), and the
 * strip only knew about files — so Steer on that row did nothing and said
 * nothing. The DTO now carries `steerable`, the host's own verdict, computed by
 * the very predicate `sendQueuedNow` applies.
 *
 * The end-to-end arm is the probe WJ-qq-b ran (`work/wjqqb/probe/queue-dto-count.probe.test.ts`),
 * landed: the REAL `sendMessage` mid-turn, reading the `queue_changed` it emits.
 */
import { afterEach, describe, expect, it, mock } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { encodeSessionKey } from '@nessy-agent/shared/sessions/session-key'
import { PiAgent } from '@nessy-agent/shared/agent/pi-agent'
import { createManagedSession, type SessionManager } from '../SessionManager'
import { createTestSessionManager } from './test-session-manager'

const managers: SessionManager[] = []
const roots: string[] = []

afterEach(() => {
  for (const manager of managers.splice(0)) manager.cleanup()
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true })
})

type Dto = { id: string; text: string; attachmentsCount: number; steerable?: boolean }

function rig() {
  const manager = createTestSessionManager()
  managers.push(manager)
  const events: Array<Record<string, unknown>> = []
  manager.setEventSink(((...args: unknown[]) => { events.push(args[2] as Record<string, unknown>) }) as never)
  const root = mkdtempSync(join(tmpdir(), 'f1481-'))
  roots.push(root)
  const managed = createManagedSession({ id: 's1', name: 'q' }, { id: 'ws', name: 'q', rootPath: root, createdAt: Date.now() } as never, { messagesLoaded: true }) as any
  ;(manager as any).sessions.set(encodeSessionKey({ workspaceId: 'ws', sessionId: 's1' }), managed)
  return { manager, managed, events }
}

const FILE = { type: 'image', path: '/tmp/x.png', name: 'x.png', mimeType: 'image/png', base64: 'eA==', size: 1 }
const STORED = { id: 'st-1', type: 'image', name: 'x.png', mimeType: 'image/png', size: 1, storedPath: '/tmp/att/x.png' }

describe('F1.481 (1)(2) — the queue DTO', () => {
  it('end to end: a one-file mid-turn send is queued as ONE attachment and not steerable', async () => {
    const { manager, managed, events } = rig()
    const agent = Object.create(PiAgent.prototype) as any
    agent.redirect = mock(() => true); agent.forceAbort = () => undefined; agent.debug = () => undefined
    managed.agent = agent
    managed.isProcessing = true

    await manager.sendMessage('s1', 'look', [FILE] as never, [STORED] as never, undefined, undefined, undefined, undefined, { workspaceId: 'ws' } as never)

    // Fixture control: the send really was queued (files never ride a steer, F1.244), not redirected.
    expect(agent.redirect).not.toHaveBeenCalled()
    const queue = (events.filter(event => event?.type === 'queue_changed').at(-1)?.queue ?? []) as Dto[]
    expect(queue).toHaveLength(1)
    expect(queue[0]!.attachmentsCount).toBe(1)
    expect(queue[0]!.steerable).toBe(false)
  })

  it('per row: text, file (both copies), recovered file (stored only), workflow', () => {
    const { manager, managed } = rig()
    managed.messageQueue = [
      { message: 'and then deploy it', messageId: 'q-text' },
      { message: 'what is on line 3?', messageId: 'q-file', attachments: [FILE], storedAttachments: [STORED] },
      { message: 'recovered', messageId: 'q-recovered', storedAttachments: [STORED] },
      { message: 'run the release', messageId: 'q-workflow', workflowInvocation: { workflowId: 'release' } },
    ]
    const dto = (manager as any).queueDto(managed) as Dto[]
    expect(dto.map(row => row.attachmentsCount)).toEqual([0, 1, 1, 0])
    expect(dto.map(row => row.steerable)).toEqual([true, false, false, false])
  })

  it('CONTROL — two files are still two', () => {
    const { manager, managed } = rig()
    managed.messageQueue = [
      { message: 'both', messageId: 'q-two', attachments: [FILE, { ...FILE, name: 'y.png' }], storedAttachments: [STORED, { ...STORED, id: 'st-2' }] },
    ]
    expect(((manager as any).queueDto(managed) as Dto[])[0]!.attachmentsCount).toBe(2)
  })
})
