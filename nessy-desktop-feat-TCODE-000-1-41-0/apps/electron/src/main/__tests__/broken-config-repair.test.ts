/**
 * P6.725 — a broken `config.json` is offered two ways out, and neither erases
 * anything.
 *
 * P6.438 (`7ff647a71`) made the refusal say which file and what could be done
 * about it; the dialog carrying that sentence still had one button, **Quit**.
 * The owner answered on 2026-09-07: a dialog WITHOUT reset — open the file, or
 * set it aside and start empty. What is pinned here is that second half, because
 * it is the half that touches the disk: the file is RENAMED and nothing else
 * happens to it, and the control is that every other startup failure keeps the
 * single Quit it has always had.
 */
import { describe, expect, it } from 'bun:test'
import { existsSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  BROKEN_CONFIG_OPEN_BUTTON,
  BROKEN_CONFIG_QUIT_BUTTON,
  BROKEN_CONFIG_SET_ASIDE_BUTTON,
  BROKEN_CONFIG_SUFFIX,
  brokenConfigSetAsidePath,
  buildBrokenConfigDialog,
  isRefusedStoredConfigError,
} from '../../shared/broken-config-dialog'
import {
  BOOT_FATAL_DIALOG_TIMEOUT_MS,
  BOOT_FATAL_REPAIR_DIALOG_TIMEOUT_MS,
  BOOT_FATAL_TICK_MS,
  buildBootFatalDialog,
  reportBootFatal,
  type BootFatalDialogOptions,
} from '../boot-fatal'

const AT = new Date('2026-09-07T18:30:00.000Z')

function refusal(message = 'config.json exists but is not valid JSON — refusing to load or overwrite it'): Error {
  const error = new Error(message)
  error.name = 'UnsupportedStorageLayoutError'
  return error
}

/**
 * A real config directory with a real `config.json`, because the action under
 * test is a rename and a mocked `fs` would pin the mock. Torn down by the caller.
 */
function fixture(): { dir: string, configFile: string, bytes: string, cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'nessy-broken-config-'))
  const configFile = join(dir, 'config.json')
  const bytes = '{ this is not json'
  writeFileSync(configFile, bytes, 'utf8')
  return { dir, configFile, bytes, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

function harness(configFile: string, responses: number[], options: { pending?: boolean } = {}) {
  const lines: string[] = []
  const shown: BootFatalDialogOptions[] = []
  const opened: string[] = []
  const renames: Array<{ from: string, to: string }> = []
  const exits: number[] = []
  const timers: Array<() => void> = []
  let call = 0

  const deps = {
    writeDiagnostic: (line: string) => { lines.push(line) },
    showDialog: (dialogOptions: BootFatalDialogOptions) => {
      shown.push(dialogOptions)
      if (options.pending) return new Promise<{ response: number }>(() => {})
      const response = responses[call++] ?? BROKEN_CONFIG_QUIT_BUTTON
      return Promise.resolve({ response })
    },
    openPath: (path: string) => { opened.push(path) },
    setAside: (from: string, to: string) => { renames.push({ from, to }); renameSync(from, to) },
    exit: (code: number) => { exits.push(code) },
    // The two-call ending is `boot-fatal.ts`'s own contract; this suite is about
    // the choice, so the hard rung is recorded and not exercised.
    hardExit: () => {},
    schedule: (fn: () => void, _ms: number) => { timers.push(fn) },
    now: () => AT,
  }

  /** One `BOOT_FATAL_TICK_MS` step of the countdown, `count` times. */
  const runTicks = (count: number) => {
    for (let step = 0; step < count; step++) {
      const pending = timers.splice(0)
      if (pending.length === 0) return
      for (const timer of pending) timer()
    }
  }

  return { lines, shown, opened, renames, exits, timers, runTicks, deps, configFile }
}

/** Let the dialog promise and its `.then` chain run. */
const settle = () => new Promise<void>(resolve => { setTimeout(resolve, 0) })

describe('the refused-config predicate', () => {
  it('recognises the typed refusal and nothing else', () => {
    expect(isRefusedStoredConfigError(refusal())).toBe(true)
    // The control, and it is the one that keeps every OTHER startup failure on
    // its single Quit: an ordinary error offers no repair, because there is none.
    expect(isRefusedStoredConfigError(new Error('EACCES: permission denied'))).toBe(false)
    expect(isRefusedStoredConfigError('a string rejection')).toBe(false)
    expect(isRefusedStoredConfigError(undefined)).toBe(false)
  })
})

describe('the broken-config dialog', () => {
  it('offers both ways out, names the file, and says what the second one does', () => {
    const configFile = '/Users/dev/.nessy-agent/config.json'
    const dialog = buildBrokenConfigDialog({ configFile }, 'SyntaxError: Unexpected token t', undefined, AT)

    expect(dialog.buttons).toEqual(['Open the file', 'Set it aside and quit', 'Quit'])
    expect(dialog.detail).toContain(configFile)
    expect(dialog.detail).toContain('SyntaxError: Unexpected token t')
    // The target is named BEFORE the user commits to it, and so is the promise
    // the owner's decision turns on.
    expect(dialog.detail).toContain(brokenConfigSetAsidePath(configFile, AT))
    expect(dialog.detail).toContain('Nothing is deleted')
    // Cancelling means quitting, never the destructive-looking middle button.
    expect(dialog.cancelId).toBe(BROKEN_CONFIG_QUIT_BUTTON)
  })

  it('follows the locale the other two startup dialogs follow', () => {
    const dialog = buildBrokenConfigDialog({ configFile: '/c/config.json' }, 'x', 'ru-RU', AT)
    expect(dialog.buttons).toEqual(['Открыть файл', 'Отложить и выйти', 'Выйти'])
  })

  it('is reached through the boot-fatal dialog, and only with a repair offer', () => {
    const configFile = '/c/config.json'
    const withRepair = buildBootFatalDialog(
      { phase: 'app-startup', configDir: '/c', error: refusal(), repair: { configFile } },
      undefined,
      AT,
    )
    expect(withRepair.buttons).toHaveLength(3)

    // THE CONTROL the row asks for: unchanged when there is nothing to repair.
    const without = buildBootFatalDialog({ phase: 'app-startup', configDir: '/c', error: refusal() }, undefined, AT)
    expect(without.buttons).toEqual(['Quit'])
    expect(without.detail).not.toContain(BROKEN_CONFIG_SUFFIX)
  })
})

describe('choosing a way out', () => {
  it('sets the file aside by RENAMING it — the bytes survive under the new name', async () => {
    const f = fixture()
    try {
      const h = harness(f.configFile, [BROKEN_CONFIG_SET_ASIDE_BUTTON])
      reportBootFatal(
        { phase: 'app-startup', configDir: f.dir, error: refusal(), repair: { configFile: f.configFile } },
        h.deps,
      )
      await settle()

      const target = brokenConfigSetAsidePath(f.configFile, AT)
      expect(h.renames).toEqual([{ from: f.configFile, to: target }])
      // Nothing is erased: the old content is on disk, byte for byte, under a
      // name a user can recognise and rename back.
      expect(existsSync(f.configFile)).toBe(false)
      expect(readFileSync(target, 'utf8')).toBe(f.bytes)
      // And NOTHING ELSE happened to the directory — no fresh config.json, no
      // backup, no reset. One file, renamed.
      expect(readdirSync(f.dir)).toEqual([`config.json${BROKEN_CONFIG_SUFFIX}2026-09-07T18-30-00-000Z`])
      // The episode is on disk too, so a rename is never mistaken later for a
      // file that vanished.
      const repairLine = h.lines.map(line => JSON.parse(line)).find(line => line.phase === 'config-set-aside')
      expect(repairLine).toMatchObject({ level: 'info', from: f.configFile, to: target })
      expect(h.exits).toEqual([1])
    } finally {
      f.cleanup()
    }
  })

  it('opens the file and ASKS AGAIN, touching nothing', async () => {
    const f = fixture()
    try {
      const h = harness(f.configFile, [BROKEN_CONFIG_OPEN_BUTTON, BROKEN_CONFIG_QUIT_BUTTON])
      reportBootFatal(
        { phase: 'app-startup', configDir: f.dir, error: refusal(), repair: { configFile: f.configFile } },
        h.deps,
      )
      await settle()
      await settle()

      expect(h.opened).toEqual([f.configFile])
      // Revealing a file is not a decision, so the question comes back.
      expect(h.shown).toHaveLength(2)
      expect(h.renames).toEqual([])
      expect(readFileSync(f.configFile, 'utf8')).toBe(f.bytes)
      expect(h.exits).toEqual([1])
    } finally {
      f.cleanup()
    }
  })

  it('quits without touching the file', async () => {
    const f = fixture()
    try {
      const h = harness(f.configFile, [BROKEN_CONFIG_QUIT_BUTTON])
      reportBootFatal(
        { phase: 'app-startup', configDir: f.dir, error: refusal(), repair: { configFile: f.configFile } },
        h.deps,
      )
      await settle()

      expect(h.renames).toEqual([])
      expect(h.opened).toEqual([])
      expect(readdirSync(f.dir)).toEqual(['config.json'])
      expect(h.exits).toEqual([1])
    } finally {
      f.cleanup()
    }
  })

  it('records a rename that FAILS and still ends the process', async () => {
    const f = fixture()
    try {
      const h = harness(f.configFile, [BROKEN_CONFIG_SET_ASIDE_BUTTON])
      h.deps.setAside = () => { throw new Error('EROFS: read-only file system') }
      reportBootFatal(
        { phase: 'app-startup', configDir: f.dir, error: refusal(), repair: { configFile: f.configFile } },
        h.deps,
      )
      await settle()

      const repairLine = h.lines.map(line => JSON.parse(line)).find(line => line.phase === 'config-set-aside')
      expect(repairLine).toMatchObject({ level: 'error', failure: 'EROFS: read-only file system' })
      // The file is still there, which is the point: a failed set-aside must not
      // look like a successful one.
      expect(readFileSync(f.configFile, 'utf8')).toBe(f.bytes)
      expect(h.exits).toEqual([1])
    } finally {
      f.cleanup()
    }
  })

  it('gives the question a longer bound than the refusal that only says Quit', async () => {
    const f = fixture()
    try {
      // Nobody answers the dialog. The countdown is what ends the process, and
      // its length is the whole assertion: ten seconds is right for a refusal
      // with one button and would end this one mid-read.
      const offered = harness(f.configFile, [], { pending: true })
      reportBootFatal(
        { phase: 'app-startup', configDir: f.dir, error: refusal(), repair: { configFile: f.configFile } },
        offered.deps,
      )
      await settle()
      offered.runTicks(BOOT_FATAL_DIALOG_TIMEOUT_MS / BOOT_FATAL_TICK_MS)
      expect(offered.exits).toEqual([])
      offered.runTicks(BOOT_FATAL_REPAIR_DIALOG_TIMEOUT_MS / BOOT_FATAL_TICK_MS)
      expect(offered.exits).toEqual([1])

      // THE CONTROL, on the identical instrument: with no offer the old bound
      // still ends it at ten seconds, so what just passed was the branch and not
      // a broken countdown.
      const plain = harness(f.configFile, [], { pending: true })
      reportBootFatal({ phase: 'app-startup', configDir: f.dir, error: refusal() }, plain.deps)
      await settle()
      plain.runTicks(BOOT_FATAL_DIALOG_TIMEOUT_MS / BOOT_FATAL_TICK_MS)
      expect(plain.exits).toEqual([1])
      expect(plain.shown[0]?.buttons).toEqual(['Quit'])
      expect(plain.opened).toEqual([])
      expect(plain.renames).toEqual([])
    } finally {
      f.cleanup()
    }
  })
})
