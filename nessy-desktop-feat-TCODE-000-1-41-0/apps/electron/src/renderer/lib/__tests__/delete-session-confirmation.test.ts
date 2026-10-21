/**
 * UA1.26 follow-up (O18) — every renderer delete path asks a SHARED chat. The handler below is App.tsx's
 * `handleDeleteSession` (ask when `deleteNeedsConfirmation`, then delete); the host dialog is faked with the answers of
 * `rpc/auth.ts` SHOW_DELETE_SESSION_CONFIRMATION (0 Cancel, 1 Delete / Delete-keep-the-link, 2 Delete and stop sharing,
 * which revokes the id it was asked about — pinned host-side by delete-confirmation-share.test.ts).
 */
import { describe, expect, it } from 'bun:test'
import {
  deleteNeedsConfirmation,
  deleteSessionsInBatch,
  type DeleteConfirmationMeta,
} from '../delete-session-confirmation'

const SHARED_URL = 'https://example.invalid/a/fake'

function rig(metas: Record<string, DeleteConfirmationMeta>, answers: number[]) {
  const asked: string[] = []
  const revoked: string[] = []
  const deleted: string[] = []
  const handleDeleteSession = async (sessionId: string, skipConfirmation = false): Promise<boolean> => {
    const meta = metas[sessionId]
    if (deleteNeedsConfirmation(meta, skipConfirmation)) {
      asked.push(sessionId)
      const response = answers.shift() ?? 0
      if (response === 2 && meta?.sharedUrl) revoked.push(sessionId)
      if (response === 0) return false
    }
    deleted.push(sessionId)
    return true
  }
  return { handleDeleteSession, asked, revoked, deleted }
}

describe('UA1.26 follow-up — a shared chat is asked on every delete path', () => {
  it('batch: an unshared first chat and a shared second chat — the shared one gets its own question', async () => {
    const r = rig({ a: { name: 'A' }, b: { name: 'B', sharedUrl: SHARED_URL } }, [1, 2])
    expect(await deleteSessionsInBatch(['a', 'b'], r.handleDeleteSession)).toBe(2)
    expect(r.asked).toEqual(['a', 'b'])
    expect(r.revoked).toEqual(['b'])
    expect(r.deleted).toEqual(['a', 'b'])
  })

  it('batch: "Delete and stop sharing" on every shared chat revokes every shared id', async () => {
    const r = rig({ a: { name: 'A', sharedUrl: SHARED_URL }, b: { name: 'B', sharedUrl: SHARED_URL }, c: { name: 'C' } }, [2, 2])
    expect(await deleteSessionsInBatch(['a', 'b', 'c'], r.handleDeleteSession)).toBe(3)
    expect(r.asked).toEqual(['a', 'b'])
    expect(r.revoked).toEqual(['a', 'b'])
  })

  it('batch: Cancel on a later shared chat keeps that chat only, and the count says so', async () => {
    const r = rig({ a: { name: 'A' }, b: { name: 'B', sharedUrl: SHARED_URL }, c: { name: 'C' } }, [1, 0])
    expect(await deleteSessionsInBatch(['a', 'b', 'c'], r.handleDeleteSession)).toBe(2)
    expect(r.deleted).toEqual(['a', 'c'])
  })

  it('negative: an unshared batch asks once (the first chat), and a cancel there deletes nothing', async () => {
    const plain = rig({ a: { name: 'A' }, b: { name: 'B' } }, [1])
    expect(await deleteSessionsInBatch(['a', 'b'], plain.handleDeleteSession)).toBe(2)
    expect(plain.asked).toEqual(['a'])
    const cancel = rig({ a: { name: 'A' }, b: { name: 'B', sharedUrl: SHARED_URL } }, [0])
    expect(await deleteSessionsInBatch(['a', 'b'], cancel.handleDeleteSession)).toBeNull()
    expect(cancel.deleted).toEqual([])
  })

  it('deep link (skipConfirmation): a shared chat is asked, an unshared or empty one is not', () => {
    expect(deleteNeedsConfirmation({ name: 'S', sharedUrl: SHARED_URL }, true)).toBe(true)
    expect(deleteNeedsConfirmation({ name: 'P' }, true)).toBe(false)
    expect(deleteNeedsConfirmation(undefined, true)).toBe(false)
    expect(deleteNeedsConfirmation({}, false)).toBe(false)
    expect(deleteNeedsConfirmation({ lastFinalMessageId: 'm1' }, false)).toBe(true)
  })
})
