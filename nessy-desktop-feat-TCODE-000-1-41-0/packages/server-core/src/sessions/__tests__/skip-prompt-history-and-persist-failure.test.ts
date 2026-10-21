/**
 * P6.267 — the documented never-persist env, and the failing transcript write
 * that told nobody.
 *
 * Both halves live at the session create/persist choke point, which is why the
 * row insists they are one lane. They are pinned in one file for the same
 * reason: the (a) arm's whole mechanism is `ephemeral`, and the (b) arm is what
 * happens on the path (a) turns off.
 *
 * (a) `cli-reference.md`, the `--no-session-persistence` row, whole:
 *     "Disable session persistence so sessions are not saved to disk and cannot
 *     be resumed. Print mode only. The `CLAUDE_CODE_SKIP_PROMPT_HISTORY`
 *     environment variable does the same in any mode." The env half said "in any
 *     mode" while its only production caller was the CLI's own flag plumbing.
 *
 * (b) A debounced write is fire-and-forget by construction, so the one failure
 *     class that silently loses a conversation was also the one with no surface.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  SKIP_PROMPT_HISTORY_COMPAT_ENV_VAR,
  SKIP_PROMPT_HISTORY_ENV_VAR,
} from '@nessy-agent/shared/config/skip-prompt-history'
import { getSessionFilePath, sessionPersistenceQueue } from '@nessy-agent/shared/sessions'
import { createTestSessionManager } from './test-session-manager'

const stateRoot = mkdtempSync(join(tmpdir(), 'nessy-skip-prompt-history-'))
const WS = 'ws-skip-prompt-history'

afterAll(() => {
  rmSync(stateRoot, { recursive: true, force: true })
})

/**
 * `delete` first, then assign — Bun 1.3.14 leaves a plain assignment readable by
 * property and INVISIBLE to `Object.keys` and the spread, and this module's
 * reader takes a spread-shaped record by default.
 */
function setEnv(name: string, value: string | undefined): void {
  delete process.env[name]
  if (value !== undefined) process.env[name] = value
}

const BOTH_SPELLINGS = [SKIP_PROMPT_HISTORY_ENV_VAR, SKIP_PROMPT_HISTORY_COMPAT_ENV_VAR] as const

beforeEach(() => {
  for (const name of BOTH_SPELLINGS) setEnv(name, undefined)
})
afterEach(() => {
  for (const name of BOTH_SPELLINGS) setEnv(name, undefined)
})

/**
 * The detector is the FILE, not a DTO field, and the row's own sentence is "not
 * saved to disk": asserting on a flag would have measured the option's plumbing
 * while the record was written anyway. (P6.502 has since put `ephemeral` on the
 * `Session` DTO for the badge to read — this sentence said `Session` carries no
 * such field, which is no longer true. The detector is unchanged, and for the
 * same reason: the flag is what the badge needs, the file is what the row
 * promises.)
 */
const wroteRecord = (workspaceId: string, sessionId: string): boolean =>
  existsSync(getSessionFilePath(workspaceId, sessionId))

describe('the never-persist env reaches the session-create path (P6.267 a)', () => {
  let counter = 0
  const workspaceId = () => `${WS}-${counter += 1}`

  // The CONTROL comes first deliberately: without it, "no file on disk" would
  // also pass on a rig where the store never writes at all.
  it('the same creation WITHOUT either spelling writes a record', async () => {
    const ws = workspaceId()
    const manager = createTestSessionManager()
    const session = await manager.createSession(ws, {})
    expect(wroteRecord(ws, session.id)).toBe(true)
    await manager.cleanup()
  })

  for (const name of BOTH_SPELLINGS) {
    it(`${name} makes a new session ephemeral, so nothing is written`, async () => {
      setEnv(name, '1')
      const ws = workspaceId()
      const manager = createTestSessionManager()
      const session = await manager.createSession(ws, {})
      expect(wroteRecord(ws, session.id)).toBe(false)
      await manager.cleanup()
    })

    it(`${name} set to a falsey value changes nothing`, async () => {
      // The reader's own truthiness table — an env var that is present but off
      // must not turn a privacy switch on by accident.
      setEnv(name, '0')
      const ws = workspaceId()
      const manager = createTestSessionManager()
      const session = await manager.createSession(ws, {})
      expect(wroteRecord(ws, session.id)).toBe(true)
      await manager.cleanup()
    })
  }

  it('the Nessy spelling wins over the compat one, in both directions', async () => {
    setEnv(SKIP_PROMPT_HISTORY_ENV_VAR, '0')
    setEnv(SKIP_PROMPT_HISTORY_COMPAT_ENV_VAR, '1')
    const offWs = workspaceId()
    const off = createTestSessionManager()
    const offSession = await off.createSession(offWs, {})
    expect(wroteRecord(offWs, offSession.id)).toBe(true)
    await off.cleanup()

    setEnv(SKIP_PROMPT_HISTORY_ENV_VAR, '1')
    setEnv(SKIP_PROMPT_HISTORY_COMPAT_ENV_VAR, '0')
    const onWs = workspaceId()
    const on = createTestSessionManager()
    const onSession = await on.createSession(onWs, {})
    expect(wroteRecord(onWs, onSession.id)).toBe(false)
    await on.cleanup()
  })

  it('an explicit ephemeral request still stands with no env at all', async () => {
    // The OR is one-directional on purpose: a caller may ask for ephemeral, and
    // no caller can turn persistence back on against the operator's environment.
    const ws = workspaceId()
    const manager = createTestSessionManager()
    const session = await manager.createSession(ws, { ephemeral: true })
    expect(wroteRecord(ws, session.id)).toBe(false)
    await manager.cleanup()
  })
})

describe('a failing transcript write is reported (P6.267 b)', () => {
  it('the listener fires, and carries the filesystem error code', async () => {
    // A DETERMINISTIC failure, not a hopeful one: the session's directory is
    // occupied by a FILE, so `ensureSessionDir` fails with a real errno on the
    // production path rather than a stubbed one. A test that merely hoped for a
    // failure would pass vacuously on a healthy disk, which is the shape this
    // row exists to stop trusting.
    const workspaceId = `ws-persist-failure-${Date.now()}`
    const sessionId = 'doomed-session'
    const sessionDir = dirname(getSessionFilePath(workspaceId, sessionId))
    mkdirSync(dirname(sessionDir), { recursive: true })
    rmSync(sessionDir, { recursive: true, force: true })
    writeFileSync(sessionDir, 'not a directory', 'utf-8')

    const failures: Array<{ code?: string }> = []
    const unsubscribe = sessionPersistenceQueue.onWriteFailure(f => {
      if (f.key.sessionId === sessionId) failures.push({ code: f.code })
    })
    try {
      sessionPersistenceQueue.enqueue({
        id: sessionId,
        workspaceId,
        createdAt: Date.now(),
        lastUsedAt: Date.now(),
        sdkCwd: sessionDir,
        messages: [],
        tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      } as unknown as Parameters<typeof sessionPersistenceQueue.enqueue>[0])
      await sessionPersistenceQueue.flush({ workspaceId, sessionId }).catch(() => undefined)
    } finally {
      unsubscribe()
      rmSync(sessionDir, { force: true })
    }

    expect(failures).toHaveLength(1)
    // The CODE is the whole point: "could not save" without it is unactionable,
    // because ENOTDIR and ENOSPC need different things from the reader.
    expect(typeof failures[0]!.code).toBe('string')
  })

  it('unsubscribing really detaches, so a disposed manager cannot be woken', () => {
    let calls = 0
    // A leaked listener on a module-scope singleton outlives the manager that
    // made it and would report another session's failure into a dead UI.
    const first = sessionPersistenceQueue.onWriteFailure(() => { calls += 1 })
    first()
    const second = sessionPersistenceQueue.onWriteFailure(() => { calls += 1 })
    second()
    expect(calls).toBe(0)
  })
})
