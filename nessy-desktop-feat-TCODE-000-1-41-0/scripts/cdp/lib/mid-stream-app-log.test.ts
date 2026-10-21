/**
 * F1.909 — the mid-stream readers read the lane's OWN log, and a log with no `[session]` line is no instrument.
 *
 * SIT-aa (2026-09-25): STR-2's readers defaulted to the machine-wide electron-log file under a relocated config dir,
 * and on a packaged build the lane's own stdout capture grew without a single `[session]` line, so three checks read
 * "the app did not park / re-queue" about a build that cannot log it.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  appLogCandidates,
  appLogOffset,
  appLogPath,
  readMidStreamSends,
  readSessionLogMatching,
  readSteerRequeues,
  SHARED_ELECTRON_MAIN_LOG,
} from './mid-stream.ts'

const NAMES = ['NESSY_CDP_APP_LOG', 'NESSY_CONFIG_DIR'] as const
let saved: Record<string, string | undefined> = {}
let dir = ''

// Bun 1.3.14: `delete` then assign (AGENTS.md trap), and restore the same way.
function setEnv(name: string, value: string | undefined): void {
  delete process.env[name]
  if (value !== undefined) process.env[name] = value
}

beforeEach(() => {
  saved = Object.fromEntries(NAMES.map(name => [name, process.env[name]]))
  dir = mkdtempSync(join(tmpdir(), 'f1909-'))
})

afterEach(() => {
  for (const name of NAMES) setEnv(name, saved[name])
  rmSync(dir, { recursive: true, force: true })
})

describe('F1.909 — which file the readers read', () => {
  it('a relocated config dir never answers with the machine-wide electron-log file', () => {
    setEnv('NESSY_CDP_APP_LOG', undefined)
    setEnv('NESSY_CONFIG_DIR', dir)
    expect(appLogCandidates()).toEqual([join(dir, 'logs', 'main.log')])
    expect(appLogCandidates()).not.toContain(SHARED_ELECTRON_MAIN_LOG)
  })

  it('control: the default profile (no NESSY_CONFIG_DIR) still falls back to the dev run\'s shared file', () => {
    setEnv('NESSY_CDP_APP_LOG', undefined)
    setEnv('NESSY_CONFIG_DIR', undefined)
    expect(appLogCandidates().at(-1)).toBe(SHARED_ELECTRON_MAIN_LOG)
  })

  it('a NESSY_CDP_APP_LOG that names a missing file is no instrument, not a fall-through to another file', () => {
    setEnv('NESSY_CONFIG_DIR', dir)
    mkdirSync(join(dir, 'logs'))
    writeFileSync(join(dir, 'logs', 'main.log'), '[session] from some other writer\n')
    setEnv('NESSY_CDP_APP_LOG', join(dir, 'not-yet-captured.log'))
    expect(appLogPath()).toBeUndefined()
  })
})

describe('F1.909 — a grown log without a single [session] line', () => {
  it('reads as unavailable on all three readers (a packaged build\'s NESSY_DEBUG stdout)', () => {
    const log = join(dir, 'app-stdout.log')
    writeFileSync(log, 'boot\n')
    setEnv('NESSY_CONFIG_DIR', dir)
    setEnv('NESSY_CDP_APP_LOG', log)
    const offset = appLogOffset()
    appendFileSync(log, '[ws-rpc-server] client connected\n[model-target] disclosure\n')
    expect(readMidStreamSends(offset, 'sess-1')).toBeUndefined()
    expect(readSteerRequeues(offset, 'sess-1')).toBeUndefined()
    expect(readSessionLogMatching(offset, /replay queued/)).toBeUndefined()
  })

  it('control: with the [session] scope present, a found event and a missing one are both real readings', () => {
    const log = join(dir, 'main.log')
    writeFileSync(log, '')
    setEnv('NESSY_CONFIG_DIR', dir)
    setEnv('NESSY_CDP_APP_LOG', log)
    const offset = appLogOffset()
    const payload = { behavior: 'steer', steered: true, sessionId: 'sess-1' }
    appendFileSync(log, `${JSON.stringify({ level: 'info', message: ['[session]', 'mid-stream send', payload] })}\n`)
    expect(readMidStreamSends(offset, 'sess-1')).toEqual([payload])
    expect(readSteerRequeues(offset, 'sess-1')).toBe(0)
    expect(readSessionLogMatching(offset, /replay queued/)).toEqual([])
  })
})
