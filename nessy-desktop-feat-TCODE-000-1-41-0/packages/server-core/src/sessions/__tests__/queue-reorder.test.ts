/**
 * P6.51 — reordering a queued message.
 *
 * `learn.chatgpt.com/docs/prompting.md#steering-and-queuing`: "Queued messages
 * appear above the composer, where you can edit, reorder, send, or delete
 * them." Three of the
 * four verbs were built; `reorder` was a comment in `QueuedMessageList.tsx`, and
 * had to stay one until this method existed: the authoritative order is
 * `ManagedSession.messageQueue`, drained by `shift()`, so a strip-local reorder
 * would have changed what the user sees and nothing about the send order.
 *
 * Which is why these tests assert the DRAIN ORDER, not just the array — the
 * array is what a dead-UI implementation would also have got right.
 *
 * Per-runtime: the queue is host state with no provider branch, so this is one
 * surface behaving identically on Pi, claude and codex.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createManagedSession } from '../SessionManager'
import { createTestSessionManager } from './test-session-manager'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture(texts: string[]) {
  const stateRoot = mkdtempSync(join(tmpdir(), 'nessy-queue-reorder-'))
  roots.push(stateRoot)
  const manager = createTestSessionManager() as any

  const workspace = {
    id: 'ws-queue-reorder',
    name: 'Queue Workspace',
    slug: 'queue-workspace',
    rootPath: join(stateRoot, 'workspace'),
    createdAt: Date.now(),
  }
  const managed = createManagedSession(
    { id: 'session-1' },
    workspace,
    { messagesLoaded: true, ephemeral: true },
  )
  managed.messageQueue = texts.map((message, index) => ({
    message,
    messageId: `queued-${index}`,
  })) as typeof managed.messageQueue
  manager.sessions.set(`${workspace.id}:${managed.id}`, managed)

  const emitted: Array<string[]> = []
  manager.sendEvent = (event: any) => {
    if (event?.type === 'queue_changed') emitted.push(event.queue.map((entry: any) => entry.text))
  }

  return {
    manager,
    managed,
    emitted,
    order: () => managed.messageQueue.map((entry: { message: string }) => entry.message),
    /** What `shift()` would actually hand the model, in order. */
    drainOrder: () => {
      const queue = [...managed.messageQueue] as Array<{ message: string }>
      const drained: string[] = []
      while (queue.length > 0) drained.push(queue.shift()!.message)
      return drained
    },
  }
}

describe('reordering a queued message changes the SEND order', () => {
  it('moves an entry up, and the drain order follows', () => {
    const rig = fixture(['a', 'b', 'c'])

    rig.manager.reorderQueuedMessage('session-1', 'queued-2', 0, 'ws-queue-reorder')

    expect(rig.order()).toEqual(['c', 'a', 'b'])
    // The point of the row: the array and the drain must not be able to
    // disagree, which is what a renderer-only reorder would have produced.
    expect(rig.drainOrder()).toEqual(['c', 'a', 'b'])
    expect(rig.emitted).toEqual([['c', 'a', 'b']])
  })

  it('moves an entry down', () => {
    const rig = fixture(['a', 'b', 'c'])

    rig.manager.reorderQueuedMessage('session-1', 'queued-0', 1, 'ws-queue-reorder')

    expect(rig.order()).toEqual(['b', 'a', 'c'])
  })

  it('clamps an index past either end instead of rejecting it', () => {
    // The strip's buttons produce `index ± 1`; clamping is what keeps the ends
    // from having to be special-cased in two places.
    const up = fixture(['a', 'b', 'c'])
    up.manager.reorderQueuedMessage('session-1', 'queued-2', -5, 'ws-queue-reorder')
    expect(up.order()).toEqual(['c', 'a', 'b'])

    const down = fixture(['a', 'b', 'c'])
    down.manager.reorderQueuedMessage('session-1', 'queued-0', 99, 'ws-queue-reorder')
    expect(down.order()).toEqual(['b', 'c', 'a'])
  })

  it('emits nothing for a move that changes no order', () => {
    const rig = fixture(['a', 'b', 'c'])

    rig.manager.reorderQueuedMessage('session-1', 'queued-1', 1, 'ws-queue-reorder')
    rig.manager.reorderQueuedMessage('session-1', 'no-such-entry', 0, 'ws-queue-reorder')
    rig.manager.reorderQueuedMessage('session-1', 'queued-1', Number.NaN, 'ws-queue-reorder')
    // Out-of-range at the end the entry is ALREADY at. `splice` clamps on its
    // own, so the array would be right either way and only the emit tells the
    // difference — a repeated "moved" broadcast for a queue nobody moved is how
    // this ends up flickering the strip on a held-down button.
    rig.manager.reorderQueuedMessage('session-1', 'queued-0', -5, 'ws-queue-reorder')
    rig.manager.reorderQueuedMessage('session-1', 'queued-2', 99, 'ws-queue-reorder')

    expect(rig.order()).toEqual(['a', 'b', 'c'])
    expect(rig.emitted).toEqual([])
  })

  it('leaves a paused queue paused — reordering empties nothing', () => {
    const rig = fixture(['a', 'b'])
    rig.managed.queuePaused = true

    rig.manager.reorderQueuedMessage('session-1', 'queued-1', 0, 'ws-queue-reorder')

    // `deleteQueuedMessage` clears the pause when the queue empties, because the
    // pause is about the queue. Reordering has no such claim.
    expect(rig.managed.queuePaused).toBe(true)
    expect(rig.order()).toEqual(['b', 'a'])
  })

  it('refuses an unknown session the way its siblings do', () => {
    const rig = fixture(['a'])

    expect(() => rig.manager.reorderQueuedMessage('nope', 'queued-0', 0, 'ws-queue-reorder'))
      .toThrow('Session nope not found')
  })
})
