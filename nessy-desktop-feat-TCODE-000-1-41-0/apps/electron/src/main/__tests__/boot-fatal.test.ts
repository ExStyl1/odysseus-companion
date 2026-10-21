import { describe, expect, it } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  BOOT_FATAL_DIALOG_TIMEOUT_MS,
  BOOT_FATAL_TICK_MS,
  bootDiagnosticLogPath,
  buildBootFatalDialog,
  createBootDiagnosticWriter,
  describeBootFatalError,
  formatBootBlockedLogLine,
  formatBootFatalLogLine,
  formatRendererGoneLogLine,
  reportBootFatal,
  type BootFatalDialogOptions,
} from '../boot-fatal'

const CONFIG_DIR = '/tmp/nessy-boot-fatal-fixture'
const AT = new Date('2026-08-21T10:00:00.000Z')

function harness(options: { dialog?: 'resolve' | 'reject' | 'pending' | 'throw' } = {}) {
  const lines: string[] = []
  const shown: BootFatalDialogOptions[] = []
  const exits: number[] = []
  const hardExits: number[] = []
  const timers: Array<{ fn: () => void, ms: number }> = []
  const armedMs: number[] = []
  let settle: (() => void) | undefined

  const deps = {
    writeDiagnostic: (line: string) => { lines.push(line) },
    showDialog: (dialogOptions: BootFatalDialogOptions) => {
      shown.push(dialogOptions)
      if (options.dialog === 'throw') throw new Error('no display')
      if (options.dialog === 'reject') return Promise.reject(new Error('dismissed badly'))
      if (options.dialog === 'pending') return new Promise<void>(resolve => { settle = resolve })
      return Promise.resolve({ response: 0 })
    },
    exit: (code: number) => { exits.push(code) },
    hardExit: (code: number) => { hardExits.push(code) },
    schedule: (fn: () => void, ms: number) => { armedMs.push(ms); timers.push({ fn, ms }) },
    now: () => AT,
  }

  /** Drive the tick-based countdowns: run every armed timer, repeatedly. */
  const runTimers = (rounds: number) => {
    for (let round = 0; round < rounds; round++) {
      const pending = timers.splice(0)
      if (pending.length === 0) return
      for (const timer of pending) timer.fn()
    }
  }

  return { lines, shown, exits, hardExits, timers, armedMs, deps, runTimers, settle: () => settle?.() }
}

describe('describeBootFatalError', () => {
  it('keeps the error name, which is the whole identification of a typed refusal', () => {
    const error = new Error('config.json activeWorkspaceId is not registered. Refusing to load it.')
    error.name = 'UnsupportedStorageLayoutError'

    expect(describeBootFatalError(error)).toEqual({
      name: 'UnsupportedStorageLayoutError',
      message: 'config.json activeWorkspaceId is not registered. Refusing to load it.',
    })
  })

  it('survives a non-Error rejection and strips control characters', () => {
    const escape = String.fromCharCode(27)
    expect(describeBootFatalError(`boom${escape}[2Jwiped`)).toEqual({
      name: 'Error',
      message: 'boom [2Jwiped',
    })
  })
})

describe('formatBootFatalLogLine', () => {
  it('names the phase, the config dir and the typed error in one parseable line', () => {
    const error = new Error('refused')
    error.name = 'UnsupportedStorageLayoutError'

    const parsed = JSON.parse(formatBootFatalLogLine(
      { phase: 'app-startup', configDir: CONFIG_DIR, error },
      AT,
    ))

    expect(parsed).toEqual({
      timestamp: '2026-08-21T10:00:00.000Z',
      level: 'error',
      scope: 'boot',
      phase: 'app-startup',
      configDir: CONFIG_DIR,
      error: { name: 'UnsupportedStorageLayoutError', message: 'refused' },
      message: 'Startup failed in app-startup: UnsupportedStorageLayoutError: refused',
    })
  })
})

describe('formatBootBlockedLogLine', () => {
  it('records the blocked code the readiness dialog would otherwise keep to itself', () => {
    const parsed = JSON.parse(formatBootBlockedLogLine({ code: 'unsafe-root', configDir: CONFIG_DIR }, AT))

    expect(parsed.scope).toBe('boot')
    expect(parsed.phase).toBe('storage-readiness')
    expect(parsed.code).toBe('unsafe-root')
    expect(parsed.configDir).toBe(CONFIG_DIR)
  })
})

describe('formatRendererGoneLogLine (D1.142)', () => {
  it('records the vendor reason and the exit code, and nothing else from the window', () => {
    const line = formatRendererGoneLogLine({ reason: 'crashed', exitCode: 133, configDir: CONFIG_DIR }, AT)
    const parsed = JSON.parse(line)

    expect(parsed.phase).toBe('render-process-gone')
    expect(parsed.reason).toBe('crashed')
    expect(parsed.exitCode).toBe(133)
    expect(parsed.configDir).toBe(CONFIG_DIR)
    expect(parsed.timestamp).toBe(AT.toISOString())
    // A renderer can die at any moment of a long session; a reader grepping for
    // a failed LAUNCH must not collect these.
    expect(parsed.scope).toBe('renderer')
    expect(parsed.scope).not.toBe('boot')
    // The URL carries a workspace id and a query, and this line is written to be
    // pasted into a bug report.
    expect(Object.keys(parsed).sort()).toEqual(
      ['configDir', 'exitCode', 'level', 'message', 'phase', 'reason', 'scope', 'timestamp'],
    )
  })

  it('survives a reason it has never seen and a missing exit code', () => {
    // The NEGATIVE: `details.reason` is Electron's vocabulary, not ours, and a
    // future member must produce a line rather than an exception. The exit code
    // is typed `number` and is `NaN` on at least one platform path.
    const parsed = JSON.parse(formatRendererGoneLogLine(
      { reason: 'some-future-reason', exitCode: Number.NaN, configDir: CONFIG_DIR },
      AT,
    ))
    expect(parsed.reason).toBe('some-future-reason')
    expect(parsed.exitCode).toBeNull()
    expect(parsed.message).toContain('exit unknown')
  })
})

describe('buildBootFatalDialog', () => {
  it('names the configuration folder and the error, and offers only Quit', () => {
    const error = new Error('refused')
    error.name = 'UnsupportedStorageLayoutError'

    const dialog = buildBootFatalDialog({ phase: 'app-startup', configDir: CONFIG_DIR, error })

    expect(dialog.type).toBe('error')
    expect(dialog.buttons).toEqual(['Quit'])
    expect(dialog.detail).toContain(CONFIG_DIR)
    expect(dialog.detail).toContain('UnsupportedStorageLayoutError: refused')
    // The phase is a diagnostic, not user copy.
    expect(dialog.detail).not.toContain('app-startup')
  })

  it('follows the locale the readiness dialog follows', () => {
    const dialog = buildBootFatalDialog({ phase: 'p', configDir: CONFIG_DIR, error: 'x' }, 'ru-RU')
    expect(dialog.buttons).toEqual(['Выйти'])
  })
})

describe('reportBootFatal', () => {
  it('writes the diagnostic before showing anything, then ends non-zero on dismissal', async () => {
    const h = harness()

    reportBootFatal({ phase: 'app-startup', configDir: CONFIG_DIR, error: new Error('refused') }, h.deps)

    // The line is on disk before the dialog exists: nobody may be at the keyboard.
    expect(h.lines).toHaveLength(1)
    expect(h.shown).toHaveLength(1)
    expect(h.exits).toEqual([])

    await Promise.resolve()
    await Promise.resolve()
    expect(h.exits).toEqual([1])
  })

  it('hard-exits in the same tick as app.exit, never behind a timer it would kill', async () => {
    const h = harness()

    reportBootFatal({ phase: 'app-startup', configDir: CONFIG_DIR, error: 'refused' }, h.deps)
    await Promise.resolve()
    await Promise.resolve()

    // No timer stands between the two: `app.exit()` stops timer delivery, so
    // the only wait ever armed is the dialog watchdog's first tick.
    expect(h.exits).toEqual([1])
    expect(h.hardExits).toEqual([1])
    expect(h.armedMs).toEqual([BOOT_FATAL_TICK_MS])
  })

  it('ends on the watchdog when the dialog is never dismissed, and only once', async () => {
    const h = harness({ dialog: 'pending' })

    reportBootFatal({ phase: 'app-startup', configDir: CONFIG_DIR, error: 'refused' }, h.deps)

    // The watchdog is armed BEFORE the dialog — the dialog blocks the main
    // thread — and counted in short steps, never one long timeout.
    expect(h.timers).toHaveLength(1)
    expect(h.timers[0]!.ms).toBe(BOOT_FATAL_TICK_MS)
    expect(h.exits).toEqual([])

    h.runTimers(BOOT_FATAL_DIALOG_TIMEOUT_MS / BOOT_FATAL_TICK_MS)
    expect(h.exits).toEqual([1])
    expect(h.hardExits).toEqual([1])

    h.settle()
    await Promise.resolve()
    await Promise.resolve()
    expect(h.exits).toEqual([1])
    expect(h.hardExits).toEqual([1])
  })

  it('never waits on a single long timer — the one macOS did not deliver', () => {
    const h = harness({ dialog: 'pending' })

    reportBootFatal({ phase: 'app-startup', configDir: CONFIG_DIR, error: 'refused' }, h.deps)
    h.runTimers(BOOT_FATAL_DIALOG_TIMEOUT_MS / BOOT_FATAL_TICK_MS)

    expect(h.hardExits).toEqual([1])
    // Every wait armed is one tick. A long timeout is the thing that was not delivered.
    expect([...new Set(h.armedMs)]).toEqual([BOOT_FATAL_TICK_MS])
    expect(h.armedMs.length).toBe(BOOT_FATAL_DIALOG_TIMEOUT_MS / BOOT_FATAL_TICK_MS)
  })

  it('still ends when the dialog rejects or cannot be shown at all', async () => {
    const rejected = harness({ dialog: 'reject' })
    reportBootFatal({ phase: 'p', configDir: CONFIG_DIR, error: 'x' }, rejected.deps)
    await Promise.resolve()
    await Promise.resolve()
    expect(rejected.exits).toEqual([1])

    const threw = harness({ dialog: 'throw' })
    reportBootFatal({ phase: 'p', configDir: CONFIG_DIR, error: 'x' }, threw.deps)
    expect(threw.exits).toEqual([1])
  })

  it('ends even when the diagnostic sink itself fails', () => {
    const h = harness()
    reportBootFatal({ phase: 'p', configDir: CONFIG_DIR, error: 'x' }, {
      ...h.deps,
      writeDiagnostic: () => { throw new Error('read-only disk') },
      showDialog: () => { throw new Error('no display') },
    })
    expect(h.exits).toEqual([1])
  })
})

describe('createBootDiagnosticWriter', () => {
  it('appends to <config dir>/logs/boot.log, creating the directory', () => {
    const root = mkdtempSync(join(tmpdir(), 'nessy-boot-diag-'))
    try {
      const write = createBootDiagnosticWriter(root)
      write('{"first":true}')
      write('{"second":true}')

      const path = bootDiagnosticLogPath(root)
      expect(existsSync(path)).toBe(true)
      expect(readFileSync(path, 'utf8')).toBe('{"first":true}\n{"second":true}\n')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('never throws when the config directory cannot be written — the case it exists for', () => {
    const write = createBootDiagnosticWriter('/dev/null/definitely-not-a-directory')
    expect(() => write('{"line":true}')).not.toThrow()
  })
})
