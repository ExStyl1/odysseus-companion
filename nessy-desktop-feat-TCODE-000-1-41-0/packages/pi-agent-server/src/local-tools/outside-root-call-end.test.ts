import { describe, expect, it } from 'bun:test'

import { bindOutsideRootRequestToCall, type OutsideRootCancelMessage, type PendingOutsideRootEntry } from './outside-root-call-end.ts'

/**
 * F1.957 — the subprocess half: an outside-root request ends with the call that asked. Mirrors how `index.ts`'s
 * `requestOutsideRootApproval` registers the entry and binds it; the host half is
 * `shared/src/agent/__tests__/pi-outside-root-call-end.test.ts`.
 */
function request(pending: Map<string, PendingOutsideRootEntry>, requestId: string, signal: AbortSignal | undefined, sent: OutsideRootCancelMessage[]) {
  const answer = new Promise<unknown>((resolve, reject) => { pending.set(requestId, { resolve, refuse: reason => reject(new Error(reason)) }) })
  bindOutsideRootRequestToCall(pending, requestId, signal, message => { sent.push(message) })
  return answer
}

describe('F1.957 — bindOutsideRootRequestToCall', () => {
  it('the call\'s end drops the request, tells the host once, and settles the scope check with a denial', async () => {
    const pending = new Map<string, PendingOutsideRootEntry>()
    const sent: OutsideRootCancelMessage[] = []
    const controller = new AbortController()
    const answer = request(pending, 'pi-oroot-1', controller.signal, sent)
    expect(sent).toEqual([])
    controller.abort()
    await expect(answer).resolves.toBeNull()
    expect(pending.has('pi-oroot-1')).toBe(false)
    expect(sent).toEqual([{ type: 'outside_root_cancel', requestId: 'pi-oroot-1', reason: 'aborted' }])
    controller.signal.dispatchEvent(new Event('abort'))
    expect(sent).toHaveLength(1)
  })

  it('names a timed_out reason when the signal carries it, and cancels at once when the call already ended', async () => {
    const pending = new Map<string, PendingOutsideRootEntry>()
    const sent: OutsideRootCancelMessage[] = []
    const ended = new AbortController()
    ended.abort('timed_out')
    await expect(request(pending, 'pi-oroot-2', ended.signal, sent)).resolves.toBeNull()
    expect(sent).toEqual([{ type: 'outside_root_cancel', requestId: 'pi-oroot-2', reason: 'timed_out' }])
    expect(pending.size).toBe(0)
  })

  it('BOUNDARY: an answer first sends no cancel on a later abort; a refusal keeps its reason; no signal keeps the old lifetime', async () => {
    const pending = new Map<string, PendingOutsideRootEntry>()
    const sent: OutsideRootCancelMessage[] = []
    const answered = new AbortController()
    const granted = request(pending, 'pi-oroot-3', answered.signal, sent)
    const root = { canonicalRoot: '/out', access: 'write', receiptId: 'pi-oroot-3', expires: 'request' } as const
    // The host's `outside_root_response` path: take the entry out, then settle it.
    const entry = pending.get('pi-oroot-3')!
    pending.delete('pi-oroot-3')
    entry.resolve(root)
    await expect(granted).resolves.toEqual(root)
    answered.abort()
    expect(sent).toEqual([])

    const refusedCall = new AbortController()
    const refused = request(pending, 'pi-oroot-4', refusedCall.signal, sent)
    const refusedEntry = pending.get('pi-oroot-4')!
    pending.delete('pi-oroot-4')
    refusedEntry.refuse('host reason')
    await expect(refused).rejects.toThrow('host reason')
    refusedCall.abort()
    expect(sent).toEqual([])

    void request(pending, 'pi-oroot-5', undefined, sent)
    expect(pending.has('pi-oroot-5')).toBe(true)
    expect(sent).toEqual([])
  })
})
