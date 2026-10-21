/**
 * P6.245 — the organization's own announcement, once per session.
 *
 * `settings-reference.md#companyannouncements`, verbatim: *"Show your
 * organization's announcements to users at startup. When you list more than one,
 * Claude Code picks one at random for each session; on a person's very first
 * launch it shows the first entry."* The vendored runtime renders it in the
 * CLI's interactive UI, which this fork never shows, so the host renders it and
 * all three runtimes get the same line.
 *
 * The carrier landed in `cb0ad16b4` and nothing read it: `companyAnnouncements`
 * was a policy field an administrator could set and no user could ever see.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import type { ManagedPiPolicyV1 } from '@nessy-agent/shared/agent/pi-harness/managed-policy'
import { createManagedSession, type SessionManager } from '../SessionManager'
import { createTestSessionManager } from './test-session-manager'

const managers: SessionManager[] = []

afterEach(() => {
  for (const manager of managers.splice(0)) manager.cleanup()
})

type Sent = { type?: string; message?: string; level?: string }

function fixture(policy: ManagedPiPolicyV1) {
  const manager = createTestSessionManager({ managedPiPolicy: policy })
  managers.push(manager)
  const sent: Sent[] = []
  manager.setEventSink(((..._args: unknown[]) => {
    sent.push(_args[2] as Sent)
  }) as Parameters<SessionManager['setEventSink']>[0])
  // One managed session per id, kept rather than rebuilt, so the SECOND call
  // for an id meets the same object a real repeat turn would — and so a test
  // can read what the announcement left in the session (C3.359).
  const sessions = new Map<string, ReturnType<typeof createManagedSession>>()
  const announce = (sessionId: string): ReturnType<typeof createManagedSession> => {
    const managed = sessions.get(sessionId) ?? createManagedSession({ id: sessionId }, {
      id: 'workspace-announce',
      name: 'Workspace Announce',
      rootPath: '/tmp/nessy-company-announcement-workspace',
      createdAt: 1,
    }, { messagesLoaded: true, ephemeral: true })
    sessions.set(sessionId, managed)
    ;(manager as unknown as { announceCompanyAnnouncement(m: unknown): void })
      .announceCompanyAnnouncement(managed)
    return managed
  }
  return { sent, announce }
}

const TWO: ManagedPiPolicyV1 = Object.freeze({
  schemaVersion: 1 as const,
  disabledPermissionModes: Object.freeze([]),
  companyAnnouncements: Object.freeze([
    'Acme runs auto mode with the classifier on. Ask #tooling before turning it off.',
    'Reminder: expense reports are due Friday.',
  ]),
})

const NONE: ManagedPiPolicyV1 = Object.freeze({
  schemaVersion: 1 as const,
  disabledPermissionModes: Object.freeze([]),
})

describe('the organization announcement reaches the user (P6.245)', () => {
  test('the FIRST entry goes to the first session, verbatim and exactly once', () => {
    // POSITIVE. "on a person's very first launch it shows the first entry" —
    // the nearest observable of a first launch in this process is that nothing
    // has been announced yet.
    const { sent, announce } = fixture(TWO)
    announce('session-first')
    expect(sent).toHaveLength(1)
    const first = sent[0]
    expect(first?.type).toBe('info')
    // VERBATIM: no host frame, because a frame would be a second voice on a
    // channel whose whole point is that the organization speaks in its own.
    expect(first?.message).toBe(TWO.companyAnnouncements?.[0])
    // …and not a warning: an announcement is a fact, not something wrong.
    //
    // C3.359 converted this pin rather than leaving it green. It read
    // `toBeUndefined()`, which was true only because the announcement went out
    // on the bare `sendEvent({ type: 'info' })` channel that sends no level at
    // all; on the durable channel the level is explicit, and an assertion that
    // it is ABSENT would have to be deleted rather than corrected the next time
    // anyone touched this. `'info'` still fails on a warning, which is what the
    // sentence above is about.
    expect(first?.level).toBe('info')

    // Once per SESSION, not per turn.
    announce('session-first')
    announce('session-first')
    expect(sent).toHaveLength(1)

    // A later session draws from the list — "picks one at random for each
    // session" — so it gets a line, and it is one the administrator wrote.
    announce('session-second')
    expect(sent).toHaveLength(2)
    expect(TWO.companyAnnouncements).toContain(sent[1]?.message as string)
  })

  test('C3.359 — the announcement is RECORDED in the session, not only sent to the pane', () => {
    // R5 measured the announcement on screen while `getSessionMessages` for the
    // same session returned no row for it, beside an ADAPTER `info` row that WAS
    // persisted — two rows a user cannot tell apart behaving differently, and an
    // administrator's sentence gone on a pane change. It cost four false FAILs
    // before the detector was corrected.
    const { sent, announce } = fixture(TWO)
    const managed = announce('session-recorded')

    // Still sent — the user sees it at the moment it is raised, unchanged.
    expect(sent).toHaveLength(1)

    // …and now also in the session's own history, which is what a reopen reads.
    const rows = managed.messages.filter(m => m.role === 'info')
    expect(rows).toHaveLength(1)
    expect(rows[0]?.content).toBe(TWO.companyAnnouncements?.[0])
    expect(rows[0]?.infoLevel).toBe('info')

    // The latch still holds across the record: one row, not one per turn.
    announce('session-recorded')
    expect(managed.messages.filter(m => m.role === 'info')).toHaveLength(1)
  })

  test('no announcements configured means no event at all', () => {
    // NEGATIVE, and the managed-pair invariant: the default install is unchanged
    // — "Default: unset, so no announcement shows".
    const { sent, announce } = fixture(NONE)
    const a = announce('session-a')
    announce('session-b')
    expect(sent).toEqual([])
    // C3.359's arm of the same negative: nothing is recorded either, so the
    // durable channel cannot leave a blank row in a transcript.
    expect(a.messages).toEqual([])

    // An EMPTY list is the same as unset, rather than an empty line shown to
    // somebody with no way to tell it from a defect.
    const empty = fixture(Object.freeze({
      schemaVersion: 1 as const,
      disabledPermissionModes: Object.freeze([]),
      companyAnnouncements: Object.freeze([]),
    }))
    empty.announce('session-c')
    expect(empty.sent).toEqual([])
  })
})
