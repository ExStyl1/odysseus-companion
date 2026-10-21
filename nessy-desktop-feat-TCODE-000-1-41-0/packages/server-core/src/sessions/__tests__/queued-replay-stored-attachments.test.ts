/**
 * F1.340 — a queued message recovered after a restart replays WITH its files.
 *
 * Measured at HEAD before this row (code read, WJ-gg verifier on F1.244): both
 * queue-recovery sites in `SessionManager` (the cold hydration and the lazy load)
 * rebuild an orphaned `isQueued` row as `{ attachments: undefined,
 * storedAttachments: msg.attachments }`, and `sendMessage` builds the model's
 * attachments ONLY by mapping `attachments` — so the replay reached the model with
 * no files while the transcript row still showed them. Every mid-turn attachment
 * send lands in the queue since F1.244, so a restart mid-turn hit this path.
 *
 * The fix sits at the two REPLAY doors (`processNextQueuedMessage` and
 * `sendQueuedNow`'s send path): an entry that carries stored attachments and no
 * in-memory ones is rebuilt from the stored files (`readFileAttachment` over
 * `storedPath`, the stored name/type/mimeType kept, a resized image's
 * `resizedBase64` preferred) before it is replayed. `sendMessage` is stubbed, so
 * these arms read exactly what the door hands it; its own index-aligned overlay
 * (`storedPath`, `markdownPath`) is unchanged and not re-tested here.
 */
import { describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { encodeSessionKey } from '@nessy-agent/shared/sessions/session-key'
import { createManagedSession } from '../SessionManager.ts'
import { createTestSessionManager } from './test-session-manager.ts'

const WORKSPACE_ID = 'ws-f1-340'
// A 1x1 PNG, so `readFileAttachment` classifies it as an image and reads its bytes.
const PNG_BYTES = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64')

interface QueueEntry { message: string; messageId?: string; attachments?: unknown[]; storedAttachments?: unknown[]; options?: unknown }
interface Managed { id: string; isProcessing: boolean; messageQueue: QueueEntry[]; messages: Array<Record<string, unknown>> }

function rig(sessionId: string) {
  const sm = createTestSessionManager()
  sm.setEventSink((() => undefined) as never)
  const root = mkdtempSync(join(tmpdir(), 'f1-340-'))
  const managed = createManagedSession(
    { id: sessionId, name: 'F1.340' },
    { id: WORKSPACE_ID, name: 'F1.340', rootPath: root, createdAt: Date.now() } as never,
    { messagesLoaded: true },
  ) as unknown as Managed
  ;(sm as unknown as { sessions: Map<string, unknown> }).sessions.set(encodeSessionKey({ workspaceId: WORKSPACE_ID, sessionId }), managed)
  const storedPath = join(root, 'attachments', 'a1b2-screenshot.png')
  mkdirSync(join(root, 'attachments'), { recursive: true })
  writeFileSync(storedPath, PNG_BYTES)
  const stored = [{ id: 'stored-1', type: 'image', name: 'screenshot.png', mimeType: 'image/png', size: PNG_BYTES.length, storedPath }]
  const replayed: unknown[][] = []
  ;(sm as unknown as { sendMessage: (...args: unknown[]) => Promise<void> }).sendMessage = async (...args: unknown[]) => { replayed.push(args) }
  return { sm, managed, stored, storedPath, replayed }
}

async function drainReplay(sm: unknown, sessionId: string): Promise<void> {
  ;(sm as { processNextQueuedMessage(id: string, ws: string): void }).processNextQueuedMessage(sessionId, WORKSPACE_ID)
  await new Promise<void>(resolve => setImmediate(resolve))
}

describe('F1.340 — a recovered queued row replays with its files', () => {
  it('an entry holding only storedAttachments (the recovery shape) reaches sendMessage WITH model attachments rebuilt from disk', async () => {
    const h = rig('recovered')
    // Exactly what both recovery sites push for an orphaned `isQueued` row.
    h.managed.messageQueue.push({ message: 'what is wrong here?', messageId: 'm-1', attachments: undefined, storedAttachments: h.stored, options: undefined })

    await drainReplay(h.sm, h.managed.id)

    expect(h.replayed).toHaveLength(1)
    const [, message, attachments, storedAttachments] = h.replayed[0]! as [string, string, Array<Record<string, unknown>> | undefined, unknown]
    expect(message).toBe('what is wrong here?')
    expect(storedAttachments).toBe(h.stored)
    // THE DEFECT: `undefined` here, so the model got no file at all.
    expect(attachments).toHaveLength(1)
    const first = attachments![0]!
    expect([first.type, first.name, first.mimeType, first.path]).toEqual(['image', 'screenshot.png', 'image/png', h.storedPath])
    expect(first.base64).toBe(PNG_BYTES.toString('base64'))
  })

  it('a resized image replays its resizedBase64, the bytes the model got the first time', async () => {
    const h = rig('resized')
    const stored = [{ ...h.stored[0]!, wasResized: true, resizedBase64: 'UkVTSVpFRA==' }]
    h.managed.messageQueue.push({ message: 'look', messageId: 'm-2', storedAttachments: stored })

    await drainReplay(h.sm, h.managed.id)

    const attachments = h.replayed[0]![2] as Array<Record<string, unknown>>
    expect(attachments[0]!.base64).toBe('UkVTSVpFRA==')
  })

  it('the second door: "Send now" on a recovered row of an IDLE session also replays the rebuilt files', async () => {
    const h = rig('send-now-idle')
    h.managed.messageQueue.push({ message: 'and this one', messageId: 'm-5', attachments: undefined, storedAttachments: h.stored, options: undefined })

    await (h.sm as unknown as { sendQueuedNow(id: string, messageId: string, ws: string): Promise<void> })
      .sendQueuedNow(h.managed.id, 'm-5', WORKSPACE_ID)

    expect(h.replayed).toHaveLength(1)
    const attachments = h.replayed[0]![2] as Array<Record<string, unknown>> | undefined
    expect(attachments).toHaveLength(1)
    expect(attachments![0]!.base64).toBe(PNG_BYTES.toString('base64'))
  })

  it('a stored file that is gone still replays as its stored path, not as nothing', async () => {
    const h = rig('gone')
    const gone = [{ ...h.stored[0]!, storedPath: join(h.storedPath, '..', 'deleted.png') }]
    h.managed.messageQueue.push({ message: 'look', messageId: 'm-6', storedAttachments: gone })

    await drainReplay(h.sm, h.managed.id)

    const attachments = h.replayed[0]![2] as Array<Record<string, unknown>>
    expect(attachments).toHaveLength(1)
    const only = attachments[0]!
    expect([only.name, only.path, only.base64]).toEqual(['screenshot.png', gone[0]!.storedPath, undefined])
  })

  it('CONTROL — an entry with in-memory attachments replays them untouched', async () => {
    const h = rig('in-memory')
    const inMemory = [{ type: 'image', path: '/tmp/x.png', name: 'x.png', mimeType: 'image/png', base64: 'eA==', size: 1 }]
    h.managed.messageQueue.push({ message: 'look', messageId: 'm-3', attachments: inMemory, storedAttachments: h.stored })

    await drainReplay(h.sm, h.managed.id)

    expect(h.replayed[0]![2]).toBe(inMemory)
  })

  it('CONTROL — a text-only entry replays with no attachments', async () => {
    const h = rig('text-only')
    h.managed.messageQueue.push({ message: 'just text', messageId: 'm-4' })

    await drainReplay(h.sm, h.managed.id)

    expect(h.replayed[0]![2]).toBeUndefined()
  })
})
