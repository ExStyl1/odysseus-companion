/**
 * D1.344 — the durable info channel keeps its row on a session this process has
 * not loaded.
 *
 * ## The defect
 *
 * `recordSessionInfoEntry` is "append to the session, send it, persist", and the
 * persist is the step that destroyed it. `persistSession` cold-hydrates when
 * `managed.messagesLoaded` is false, and `hydrateMessagesForColdPersist` assigns
 * `managed.messages = (stored.messages || []).map(…)` — a WHOLESALE replace,
 * after the caller has already pushed. So the row was gone from memory and never
 * reached disk, silently, and only on a session nothing had loaded — which is
 * why nothing noticed: the product's own sends load the transcript first.
 *
 * ## What runs for real
 *
 * The real `recordSessionInfoEntry`, the real `appendManagedMessage`, the real
 * `persistSession` and the real `hydrateMessagesForColdPersist`. Only the two
 * leaves are supplied: `sessionStore.load` (which IS "the disk" for this case,
 * and whose call count is the control's instrument) and `enqueuePersist`, which
 * is captured rather than run — it is the snapshot builder, and what this file
 * asserts is what it is HANDED.
 */
import { describe, expect, test } from 'bun:test'
import { createTestSessionManager } from './test-session-manager.ts'

const WORKSPACE = 'workspace-cold-persist'
const SESSION = 'session-cold-persist'

function harness(options: { messagesLoaded: boolean; stored?: Array<Record<string, unknown>> }) {
  const manager = createTestSessionManager() as any
  const managed: any = {
    id: SESSION,
    workspace: { id: WORKSPACE, rootPath: '/tmp' },
    messages: [],
    messageQueue: [],
    messagesLoaded: options.messagesLoaded,
    isProcessing: false,
  }
  let loads = 0
  manager.sessionStore = {
    load: () => {
      loads += 1
      return { messages: options.stored ?? [], tokenUsage: undefined }
    },
  }
  const enqueued: Array<Array<{ id: string; role: string; content: string }>> = []
  manager.enqueuePersist = (session: any) => { enqueued.push(session.messages.map((m: any) => ({ id: m.id, role: m.role, content: m.content }))) }
  manager.sendEvent = () => {}
  const record = (content: string) => manager.recordSessionInfoEntry(managed, content, 'info')
  return { manager, managed, record, enqueued, loads: () => loads }
}

/**
 * The STORED shape, which is not the runtime one: `storedToPersistedMessage`
 * reads `type` and renames it to `role`. Spelling `role` here produced rows
 * whose role was `undefined` and read exactly like the re-append dropping a
 * field — the fixture was wrong, not the code.
 */
const DISK = [
  { id: 'disk-1', type: 'user', content: 'the first thing anyone said', timestamp: 1 },
  { id: 'disk-2', type: 'assistant', content: 'the answer to it', timestamp: 2 },
]

describe('D1.344 · a row appended before the cold hydration survives it', () => {
  test('a COLD session keeps the info row, after the transcript the disk carries', () => {
    const rig = harness({ messagesLoaded: false, stored: DISK })

    rig.record('the directory moved to /srv/app')

    // The memory half: the row is still there, and the history it was appended
    // after is there with it.
    expect(rig.managed.messages.map((m: any) => m.id)).toEqual(['disk-1', 'disk-2', expect.any(String)])
    const last = rig.managed.messages[rig.managed.messages.length - 1]
    expect(last.role).toBe('info')
    expect(last.content).toBe('the directory moved to /srv/app')
    // The disk half: the snapshot builder was handed the same list, with the row
    // in it — before this row it was handed the two disk entries alone.
    expect(rig.enqueued).toHaveLength(1)
    expect(rig.enqueued[0]!.map(entry => entry.role)).toEqual(['user', 'assistant', 'info'])
    expect(rig.managed.messagesLoaded).toBe(true)
  })

  test('the CONTROL: a loaded session keeps the row and never hydrates at all', () => {
    const rig = harness({ messagesLoaded: true, stored: DISK })
    rig.managed.messages.push({ id: 'live-1', role: 'user', content: 'already in memory', timestamp: 1 })

    rig.record('the directory moved to /srv/app')

    expect(rig.managed.messages.map((m: any) => m.role)).toEqual(['user', 'info'])
    // The pair is the control: the cold path is what this row changes, and it
    // must not have run here.
    expect(rig.loads()).toBe(0)
  })

  test('a pending row the disk ALREADY carries is not restored twice', () => {
    // Reachable inside one process: a caller appends and persists (so the row
    // reaches disk), then appends again before another cold hydration. A blind
    // re-append would show the first row twice.
    const rig = harness({
      messagesLoaded: false,
      stored: [...DISK, { id: 'info-1', type: 'info', content: 'said once', timestamp: 3 }],
    })
    rig.managed.messages.push({ id: 'info-1', role: 'info', content: 'said once', timestamp: 3 })

    rig.record('said twice')

    const ids = rig.managed.messages.map((m: any) => m.id)
    expect(ids.filter((id: string) => id === 'info-1')).toHaveLength(1)
    expect(rig.managed.messages.map((m: any) => m.content)).toEqual([
      'the first thing anyone said', 'the answer to it', 'said once', 'said twice',
    ])
  })

  test('queue recovery still reads the DISK alone — a row this process just wrote is not a crash leftover', () => {
    // The ordering the fix depends on: the re-append happens AFTER the orphaned
    // `isQueued` scan, so a queued row appended in memory a moment ago is not
    // re-queued as though a crash had left it.
    const rig = harness({ messagesLoaded: false, stored: DISK })
    rig.managed.messages.push({ id: 'fresh-1', role: 'user', content: 'just typed', timestamp: 9, isQueued: true })

    rig.record('a notice')

    expect(rig.managed.messageQueue).toHaveLength(0)
    expect(rig.managed.messages.map((m: any) => m.id)).toEqual(['disk-1', 'disk-2', 'fresh-1', expect.any(String)])
  })

  test('a session with nothing on disk keeps its row too', () => {
    const rig = harness({ messagesLoaded: false, stored: [] })
    rig.record('the only thing this session has ever said')
    expect(rig.managed.messages).toHaveLength(1)
    expect(rig.managed.messages[0].content).toBe('the only thing this session has ever said')
  })
})
