import { describe, expect, it, setDefaultTimeout } from 'bun:test'

import type { CdpSession } from './connect.ts'
import { waitForTurn, type SessionKey } from './state.ts'

/**
 * F1.491 — `waitForTurn` must not read a turn as done before it STARTS.
 *
 * F1.260's diagnosis (WJ-yy, 2026-09-24): the host appends the user's row and
 * flushes it BEFORE it raises `isProcessing` (`SessionManager.sendMessage`), so
 * a poll landing in that window read "the transcript grew, nothing is
 * processing" off the user's OWN row and returned. QL9 then uninstalled a
 * plugin under the codex turn that was only starting. WJ-yy's probe
 * (`work/wjyy/probe-f1260-waitforturn.ts`) measured the helper returning after
 * one poll in 1 ms; these are that probe, committed, with the arms the fix
 * needs beside it.
 *
 * The session is a fake answering the two reads a poll makes, in the order the
 * helper has always made them: the transcript (`getSessionMessages`) and then
 * the session list (`getSessions`). The step advances on the second read, so
 * one entry of `steps` is one poll; the last entry repeats for ever.
 */

// The unfixed helper sleeps 1.5 s between polls whatever it is asked, so its
// red arms need more than bun's 5 s default to fail on an assertion rather
// than on the timer.
setDefaultTimeout(20_000)

const KEY: SessionKey = { workspaceId: 'w-1', sessionId: 's-1' }

interface Step {
  roles: readonly string[]
  processing: boolean
  lastMessageAt?: number
}

/** The transcript before the send: a whole earlier turn, reply included. */
const PRIOR = ['user', 'assistant'] as const
const since = PRIOR.length

function scriptedSession(steps: readonly Step[]) {
  let step = 0
  const current = (): Step => steps[Math.min(step, steps.length - 1)]!
  const session = {
    call: async (script: string) => {
      if (script.includes('getSessionMessages')) {
        return current().roles.map((role, index) => ({
          id: `m-${index}`, role, content: `${role} ${index}`, timestamp: index,
        }))
      }
      if (script.includes('getSessions')) {
        const now = current()
        step += 1
        return [{
          id: KEY.sessionId,
          workspaceId: KEY.workspaceId,
          isProcessing: now.processing,
          lastMessageAt: now.lastMessageAt,
          messageCount: now.roles.length,
        }]
      }
      throw new Error(`unexpected script: ${script.slice(0, 80)}`)
    },
  }
  return { session: session as never as CdpSession, polls: () => step }
}

/** Poll fast: the interval is the only thing that makes this a unit test. */
const FAST = { intervalMs: 2, startWindowMs: 60 }

const rolesOf = (rows: readonly { role: string }[]): string[] => rows.map(row => row.role)

async function settle<T>(promise: Promise<T>): Promise<{ value?: T; error?: Error }> {
  try {
    return { value: await promise }
  } catch (error) {
    return { error: error instanceof Error ? error : new Error(String(error)) }
  }
}

describe('waitForTurn — a turn is not done before it starts (F1.491)', () => {
  it('F1.260 — the user\'s own row with nothing processing yet is NOT a finished turn: it waits for the turn', async () => {
    const { session, polls } = scriptedSession([
      // The window the rig fell into: the row is written, `isProcessing` not yet raised.
      { roles: [...PRIOR, 'user'], processing: false },
      { roles: [...PRIOR, 'user'], processing: false },
      { roles: [...PRIOR, 'user'], processing: true },
      { roles: [...PRIOR, 'user', 'assistant'], processing: true },
      { roles: [...PRIOR, 'user', 'assistant'], processing: false },
    ])

    const rows = await waitForTurn(session, KEY, since, 10_000, { ...FAST, startWindowMs: 5_000 })

    // The unfixed helper returned here after ONE poll, with the user's row as
    // the whole "turn" — which is what let QL9's cleanup run under the turn.
    expect(polls()).toBe(5)
    expect(rolesOf(rows)).toEqual([...PRIOR, 'user', 'assistant'])
  })

  it('a turn that never starts is reported as NOT STARTED — a distinct failure, never as done', async () => {
    const { session, polls } = scriptedSession([
      { roles: [...PRIOR, 'user'], processing: false },
    ])
    const startedAt = Date.now()

    const { value, error } = await settle(waitForTurn(session, KEY, since, 10_000, FAST))

    expect(value).toBeUndefined()
    expect(error?.message).toMatch(/^turn-not-started: /)
    expect(error?.name).toBe('TurnNotStartedError')
    // It says what it saw, so the reader is not left guessing which half was missing.
    expect(error?.message).toContain('rows added since the send: [user]')
    expect(error?.message).toContain('isProcessing never read true')
    // The START window bounds it, not the turn's own (much longer) timeout.
    expect(Date.now() - startedAt).toBeLessThan(5_000)
    expect(polls()).toBeGreaterThan(1)
  })

  it('CONTROL (WJ-yy) — processing at the first poll: it waits until the turn ends, then returns its reply', async () => {
    const { session, polls } = scriptedSession([
      { roles: [...PRIOR, 'user'], processing: true },
      { roles: [...PRIOR, 'user'], processing: true },
      { roles: [...PRIOR, 'user', 'assistant'], processing: false },
    ])

    const rows = await waitForTurn(session, KEY, since, 10_000, FAST)

    expect(polls()).toBe(3)
    expect(rolesOf(rows)).toEqual([...PRIOR, 'user', 'assistant'])
  })

  it('CONTROL (WJ-yy) — a turn fast enough to start and end between two polls counts by its reply row', async () => {
    const { session, polls } = scriptedSession([
      { roles: [...PRIOR, 'user', 'assistant'], processing: false },
    ])

    const rows = await waitForTurn(session, KEY, since, 10_000, FAST)

    expect(polls()).toBe(1)
    expect(rolesOf(rows)).toEqual([...PRIOR, 'user', 'assistant'])
  })

  it('a reply row from BEFORE the send does not count: only rows past `since` are the turn\'s', async () => {
    // The transcript already ends in an assistant row; the new turn has added
    // only its user row. A "some row is not the user's" test over the whole
    // transcript would call this started.
    const { session } = scriptedSession([
      { roles: [...PRIOR, 'user'], processing: false },
    ])

    const { error } = await settle(waitForTurn(session, KEY, since, 10_000, FAST))

    expect(error?.message).toMatch(/^turn-not-started: /)
  })

  it('a command answered with no turn (the /heapdump shape) counts once lastMessageAt moved past the pre-send baseline', async () => {
    // `/heapdump` bypasses `sendMessage`: the host appends ONE user row (the
    // summary), stamps `lastMessageAt` beside it and never raises
    // `isProcessing`, and no reply follows. The stamp moving past the one read
    // before the send is the only sign the command took effect.
    const { session, polls } = scriptedSession([
      { roles: [...PRIOR, 'user'], processing: false, lastMessageAt: 2_000 },
    ])

    const rows = await waitForTurn(session, KEY, { count: since, lastMessageAt: 1_000 }, 3_000, FAST)

    expect(polls()).toBe(1)
    expect(rolesOf(rows)).toEqual([...PRIOR, 'user'])
  })

  it('CONTROL — the same shape with lastMessageAt still at the baseline has not started', async () => {
    const { session } = scriptedSession([
      { roles: [...PRIOR, 'user'], processing: false, lastMessageAt: 1_000 },
    ])

    const { error } = await settle(waitForTurn(session, KEY, { count: since, lastMessageAt: 1_000 }, 3_000, FAST))

    expect(error?.message).toMatch(/^turn-not-started: /)
  })

  it('a turn that started and outlives the timeout is a wait-timeout, not NOT STARTED', async () => {
    const { session } = scriptedSession([
      { roles: [...PRIOR, 'user'], processing: true },
    ])

    const { value, error } = await settle(waitForTurn(session, KEY, since, 80, { intervalMs: 2, startWindowMs: 40 }))

    expect(value).toBeUndefined()
    expect(error?.message).toMatch(/^wait-timeout: /)
    expect(error?.name).not.toBe('TurnNotStartedError')
  })
})
