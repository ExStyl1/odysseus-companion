/**
 * F1.988 — `deleteSession` itself stops the deleted session's `/loop`.
 *
 * F1.878 closed by reading the code: after the storage delete commits,
 * `deleteSession`'s R27b block calls `sessionCronServices.get(key)?.clear()` and
 * drops the map entry, and `SessionCronService.clear()` stops the one-second
 * interval, empties the pending queue and removes the session's crons file. The
 * only test of that shape drove the branch ROLLBACK (the cron-store lifecycle suite,
 * "the preflight failure clears every per-session map it populated"), never
 * `deleteSession`. These rows drive the real method.
 *
 * Runtime-agnostic on purpose: SIT-z armed its loops on claude and codex, but
 * both reach the same host service through `buildSessionCronPort`, and
 * `getOrCreateSessionCronService` does not read the runtime. The loop is armed
 * the way the model arms it — `CronCreate` with `dynamic: true`, then
 * `ScheduleWakeup` 60 minutes out — through that port.
 *
 * What "the loop fired" means here is the SERVICE handing a fire to its
 * `deliver` seam. `deliverScheduledMonitorEvent` is replaced with a recorder so
 * the host's own delivery gate (which also drops a fire for a session it can no
 * longer find) cannot be what makes the deleted session quiet.
 */
import { afterAll, afterEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SessionCronPort } from '@nessy-agent/session-tools-core'
import { sessionCronFile } from '@nessy-agent/shared/sessions'
import { saveSession } from '@nessy-agent/shared/sessions/storage'
import type { StoredSession } from '@nessy-agent/shared/sessions/types'
import { SESSIONS_DIR } from '@nessy-agent/shared/workspaces'
import { createManagedSession, type SessionManager } from '../SessionManager'
import { createTestSessionManager } from './test-session-manager'

const WS = 'ws_session_delete_cron'
const workspaceRoot = mkdtempSync(join(tmpdir(), 'nessy-session-delete-cron-'))
const managers: SessionManager[] = []

interface CronServiceForTest {
  list(): readonly { id: string; prompt: string; dynamic?: boolean }[]
  pendingIds(): readonly string[]
  tick(): void
}

interface Internals {
  sessions: Map<string, unknown>
  sessionCronServices: Map<string, CronServiceForTest>
  getOrCreateSessionCronService(managed: unknown): CronServiceForTest | undefined
  buildSessionCronPort(managed: unknown, service: unknown): SessionCronPort
  deliverScheduledMonitorEvent(delivery: { sessionKey: { sessionId: string }; text: string }): void
}

afterEach(async () => {
  for (const manager of managers.splice(0)) await manager.cleanup()
  rmSync(join(SESSIONS_DIR, WS), { recursive: true, force: true })
})

afterAll(() => {
  rmSync(workspaceRoot, { recursive: true, force: true })
})

/** The interval `start()` sets and `stop()` nulls — the thing that would fire the loop later. */
const timerOf = (service: CronServiceForTest): unknown => (service as unknown as { timer: unknown }).timer

function harness() {
  const manager = createTestSessionManager()
  managers.push(manager)
  const internals = manager as unknown as Internals
  const delivered: { sessionId: string; text: string }[] = []
  internals.deliverScheduledMonitorEvent = delivery => {
    delivered.push({ sessionId: delivery.sessionKey.sessionId, text: delivery.text })
  }
  return { manager, internals, delivered }
}

async function sessionWithLoop(internals: Internals, id: string) {
  // `sessionStore.delete` answers false for a session with no directory, which
  // sends `deleteSession` down its rollback branch — so the session is stored.
  const stored: StoredSession = {
    id,
    workspaceId: WS,
    createdAt: 1000,
    lastUsedAt: 2000,
    messages: [{ id: `${id}-m1`, type: 'user', content: '/loop keep going', timestamp: 3000 }],
    tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, contextTokens: 0, costUsd: 0 },
  }
  await saveSession(stored)
  const managed = createManagedSession({ id }, {
    id: WS,
    name: 'Session Delete Cron Workspace',
    rootPath: workspaceRoot,
    createdAt: 1,
  } as never, { messagesLoaded: true })
  internals.sessions.set(`${WS}:${id}`, managed)

  const service = internals.getOrCreateSessionCronService(managed)
  if (!service) throw new Error('the session must get a cron service (is NESSY_DISABLE_CRON or CLAUDE_CODE_DISABLE_CRON set?)')
  return { managed, service, port: internals.buildSessionCronPort(managed, service) }
}

describe('F1.988 — deleteSession stops the deleted session\'s /loop', () => {
  it('a loop armed with CronCreate + ScheduleWakeup 60 min loses its timer, its records, its file and its map entry', async () => {
    const { manager, internals } = harness()
    const { service, port } = await sessionWithLoop(internals, 's-loop-deleted')

    // SIT-z's shape: a self-paced loop, rescheduled an hour out.
    const loop = await port.create({ dynamic: true, recurring: true, prompt: 'keep going' })
    const wakeup = await port.rearmWakeup!({ delayMs: 3_600_000 })
    expect(wakeup.firesAt).toBeGreaterThan(Date.now())
    // Positive controls: the loop is really armed before the delete.
    expect(service.list().map(record => record.id)).toEqual([loop.id])
    expect(timerOf(service)).not.toBeNull()
    expect(existsSync(sessionCronFile(workspaceRoot, 's-loop-deleted'))).toBe(true)
    expect(internals.sessionCronServices.get(`${WS}:s-loop-deleted`)).toBe(service)

    await manager.deleteSession('s-loop-deleted', WS)

    expect(existsSync(join(SESSIONS_DIR, WS, 's-loop-deleted'))).toBe(false)
    expect(internals.sessionCronServices.has(`${WS}:s-loop-deleted`)).toBe(false)
    // The service object outlives its map entry in this test only; what matters
    // is that nothing in it can fire again.
    expect(timerOf(service)).toBeNull()
    expect(service.list()).toEqual([])
    expect(service.pendingIds()).toEqual([])
    expect(existsSync(sessionCronFile(workspaceRoot, 's-loop-deleted'))).toBe(false)
    // …and the wakeup cannot be re-armed: the port finds no loop left.
    await expect(port.rearmWakeup!({ delayMs: 60_000 })).rejects.toThrow('No self-paced /loop is active in this session.')
  })

  it('a due iteration of the deleted loop is never delivered, while a sibling session\'s loop still fires', async () => {
    const { manager, internals, delivered } = harness()
    const deleted = await sessionWithLoop(internals, 's-loop-gone')
    const sibling = await sessionWithLoop(internals, 's-loop-kept')

    // `dynamic: true` makes the first iteration due NOW, so a tick delivers it
    // unless the record is gone — the discriminating case for "stopped".
    await deleted.port.create({ dynamic: true, recurring: true, prompt: 'iteration of the deleted loop' })
    await sibling.port.create({ dynamic: true, recurring: true, prompt: 'iteration of the sibling loop' })

    await manager.deleteSession('s-loop-gone', WS)

    // The boundary: the deletion is scoped to one session's key.
    expect(internals.sessionCronServices.get(`${WS}:s-loop-kept`)).toBe(sibling.service)
    expect(timerOf(sibling.service)).not.toBeNull()
    expect(existsSync(sessionCronFile(workspaceRoot, 's-loop-kept'))).toBe(true)

    // Drive the tick the interval would have run, on both services.
    deleted.service.tick()
    sibling.service.tick()
    // The sibling's fire is the positive control for the instrument: the
    // recorder does see a loop iteration when one is owed.
    expect(delivered).toEqual([{ sessionId: 's-loop-kept', text: 'iteration of the sibling loop' }])
  })
})
