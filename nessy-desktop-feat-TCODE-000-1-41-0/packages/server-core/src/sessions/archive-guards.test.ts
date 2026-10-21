/**
 * UA3.8 — adapted from craft-agents-oss `v0.13.4:packages/server-core/src/sessions/archive-guards.test.ts`
 * (Apache-2.0): the processing arm's cases. The scoping arm's cases are not ported with it (reason (c), see the
 * module header); `archiveSessionForAgent`'s own not-found answer is `archive-session-verb.test.ts`'s.
 */
import { describe, expect, it } from 'bun:test'
import { archiveProcessingRefusal } from './archive-guards.ts'

describe('archiveProcessingRefusal (archive_session processing arm)', () => {
  const idle = { isProcessing: false }
  const busy = { isProcessing: true }

  it('allows archiving an idle session', () => {
    expect(archiveProcessingRefusal(idle, 's-2', true)).toBeNull()
  })

  it('allows unarchiving an idle session', () => {
    expect(archiveProcessingRefusal(idle, 's-2', false)).toBeNull()
  })

  it('rejects archiving a session that is mid-turn', () => {
    expect(archiveProcessingRefusal(busy, 's-4', true)).toContain('processing a turn')
  })

  it('NESSY: the calling session archiving itself is not refused (it is always mid-turn while it calls the tool)', () => {
    expect(archiveProcessingRefusal({ isProcessing: true, isCaller: true }, 's-self', true)).toBeNull()
    expect(archiveProcessingRefusal({ isProcessing: true, isCaller: false }, 's-4', true)).toContain('processing a turn')
  })

  it('allows UNarchiving a session that is mid-turn', () => {
    // Unarchive only restores visibility — no reason to gate it on idleness.
    expect(archiveProcessingRefusal(busy, 's-4', false)).toBeNull()
  })
})
