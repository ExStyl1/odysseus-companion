/**
 * D1.97 + D1.98 — the rules that decide what the background-task row draws from
 * one `sessions:listScheduledWork` answer.
 *
 * Every case here is one of the distinctions the owner's decision asked the flat
 * list to keep: an empty session is not an unreadable one, a watch is a
 * `monitor` and not a second name for the same fact, and a work item already on
 * screen is drawn once.
 */

import { describe, expect, it } from 'bun:test'
import type { SessionScheduledWorkPageV1 } from '@nessy-agent/shared/protocol'
import { asSessionScheduledWorkPage, projectScheduledWorkView } from '../scheduled-work-chips'

function page(overrides: Partial<SessionScheduledWorkPageV1> = {}): SessionScheduledWorkPageV1 {
  return { schemaVersion: 1, entries: [], ...overrides }
}

describe('projectScheduledWorkView', () => {
  it('draws a cron record as a scheduled chip carrying its cadence', () => {
    const view = projectScheduledWorkView(page({
      entries: [
        { id: 'cron-1', type: 'scheduled', status: 'scheduled', description: 'Nightly digest', schedule: '0 3 * * *', recurring: true },
        { id: 'cron-2', type: 'scheduled', status: 'scheduled', description: 'One reminder', schedule: 'at 17:00', recurring: false },
      ],
    }))
    expect(view.chips.map(chip => chip.cadenceKey)).toEqual([
      'chat.backgroundTasks.scheduledRepeats',
      'chat.backgroundTasks.scheduledOnce',
    ])
    expect(view.chips.every(chip => chip.scheduled)).toBe(true)
    expect(view.chips[0]?.schedule).toBe('0 3 * * *')
    expect(view.noticeKey).toBeUndefined()
  })

  it('draws a WATCH, and it is a monitor rather than a type of its own (D1.98)', () => {
    // The row's build line asked for a `'watch'` type. There is none and there
    // must not be one — `SessionMonitorService` files every watch under
    // `type: 'monitor'`, which is `hooks.md`'s own spelling. The chip carries
    // that word verbatim rather than translating it into a second vocabulary.
    const view = projectScheduledWorkView(page({
      entries: [{ id: 'mon-1', type: 'monitor', status: 'running', description: 'watch src/**' }],
    }))
    expect(view.chips).toHaveLength(1)
    expect(view.chips[0]?.type).toBe('monitor')
    expect(view.chips[0]?.scheduled).toBe(false)
    expect(view.chips[0]?.cadenceKey).toBeUndefined()
  })

  it('drops an entry the event feed already put on screen, and keeps the rest', () => {
    const view = projectScheduledWorkView(
      page({
        entries: [
          { id: 'shell-7', type: 'shell', status: 'running', description: 'bun test' },
          { id: 'mon-1', type: 'monitor', status: 'running', description: 'watch src/**' },
        ],
      }),
      ['shell-7'],
    )
    expect(view.chips.map(chip => chip.id)).toEqual(['mon-1'])
  })

  it('an EMPTY page is silence, and an UNAVAILABLE page is a sentence — never the same', () => {
    // The distinction is the whole reason `unavailable` is on the wire: a panel
    // that merged them would tell a user "nothing is running" about a session it
    // never managed to ask about.
    expect(projectScheduledWorkView(page()).chips).toHaveLength(0)
    expect(projectScheduledWorkView(page()).noticeKey).toBeUndefined()

    for (const unavailable of ['not-supported', 'session-not-found'] as const) {
      const view = projectScheduledWorkView(page({ unavailable }))
      expect(view.noticeKey).toBe('chat.backgroundTasks.unavailable')
      expect(view.chips).toHaveLength(0)
      // D1.268 — and it is NOT also empty: a session nobody could ask about is
      // not a session with nothing queued.
      expect(view.emptyKey).toBeUndefined()
    }
  })

  it('D1.268 — an answered page with nothing left to draw says so, and the three states stay apart', () => {
    // Positive: the host answered, there is nothing queued.
    expect(projectScheduledWorkView(page()).emptyKey).toBe('chat.backgroundTasks.empty')
    // Positive, the case the bar can actually render: every entry the host sent
    // is already on screen from the event feed, so nothing ELSE is queued.
    const subtracted = projectScheduledWorkView(
      page({ entries: [{ id: 'shell-7', type: 'shell', status: 'running', description: 'bun test' }] }),
      ['shell-7'],
    )
    expect(subtracted.chips).toHaveLength(0)
    expect(subtracted.emptyKey).toBe('chat.backgroundTasks.empty')
    // Negative: a page with something to draw makes no such claim.
    expect(projectScheduledWorkView(page({
      entries: [{ id: 'mon-1', type: 'monitor', status: 'running', description: 'watch src/**' }],
    })).emptyKey).toBeUndefined()
    // Boundary: no answer yet is not an answer of "nothing".
    expect(projectScheduledWorkView(undefined).emptyKey).toBeUndefined()
  })

  it('renders nothing at all before a read has answered', () => {
    const view = projectScheduledWorkView(undefined, ['shell-7'])
    expect(view.chips).toHaveLength(0)
    expect(view.noticeKey).toBeUndefined()
  })
})

describe('asSessionScheduledWorkPage', () => {
  it('accepts the page the host sends', () => {
    const real = page({ entries: [{ id: 'a', type: 'monitor', status: 'running', description: 'x' }] })
    expect(asSessionScheduledWorkPage(real)).toBe(real)
    expect(asSessionScheduledWorkPage(page({ unavailable: 'not-supported' }))).not.toBeUndefined()
  })

  it('refuses an RPC error envelope — the shape a surface with no rehydration resolves with', () => {
    // D1.267: in the Electron app the renderer entry rehydrates that envelope
    // into a thrown Error before product code sees it, so the `catch` beside the
    // read is the one that fires. This refusal covers the surfaces that build
    // the same API without that entry (the playground mock, `apps/webui`) and
    // every answer whose shape is simply not this page.
    expect(asSessionScheduledWorkPage({ __nessyRpcError__: true, message: 'no handler' })).toBeUndefined()
    expect(asSessionScheduledWorkPage(undefined)).toBeUndefined()
    expect(asSessionScheduledWorkPage(null)).toBeUndefined()
    expect(asSessionScheduledWorkPage({ schemaVersion: 2, entries: [] })).toBeUndefined()
    expect(asSessionScheduledWorkPage({ schemaVersion: 1 })).toBeUndefined()
    // An `unavailable` value this renderer does not know is not a page either:
    // it would be drawn as the one sentence we have, which would be a guess.
    expect(asSessionScheduledWorkPage({ schemaVersion: 1, entries: [], unavailable: 'later' })).toBeUndefined()
  })
})

describe('F1.508 — a scheduled plugin monitor on the panel', () => {
  it('draws the armed monitor with its schedule and the idle-tick note, after the registry rows', () => {
    const view = projectScheduledWorkView(page({
      entries: [{ id: 'cron-1', type: 'scheduled', status: 'scheduled', description: 'Nightly digest', schedule: '0 3 * * *', recurring: true }],
      pluginMonitors: [{ monitorId: 'build-watch', cron: '*/5 * * * *', timezone: 'Europe/Moscow' }],
    }))
    expect(view.chips.map(chip => chip.id)).toEqual(['cron-1', 'build-watch'])
    const monitor = view.chips[1]!
    expect(monitor.scheduled).toBe(true)
    expect(monitor.type).toBe('monitor')
    expect(monitor.schedule).toBe('*/5 * * * * (Europe/Moscow)')
    expect(monitor.cadenceKey).toBe('chat.backgroundTasks.scheduledMonitorSkipsIdle')
    expect(view.emptyKey).toBeUndefined()
  })

  it('a session whose only scheduled work is a monitor is not "nothing scheduled"; a page without monitors reads as before', () => {
    const onlyMonitor = projectScheduledWorkView(page({ pluginMonitors: [{ monitorId: 'm', cron: '0 * * * *' }] }))
    expect(onlyMonitor.chips).toHaveLength(1)
    expect(onlyMonitor.chips[0]?.schedule).toBe('0 * * * *')
    expect(onlyMonitor.emptyKey).toBeUndefined()
    // CONTROL — the pre-F1.508 page shape still answers "nothing scheduled".
    expect(projectScheduledWorkView(page()).emptyKey).toBe('chat.backgroundTasks.empty')
    // A malformed monitors field is not a page (the same refusal as a malformed `entries`).
    expect(asSessionScheduledWorkPage({ schemaVersion: 1, entries: [], pluginMonitors: 'x' })).toBeUndefined()
    expect(asSessionScheduledWorkPage({ schemaVersion: 1, entries: [], pluginMonitors: [] })).toBeDefined()
  })
})
