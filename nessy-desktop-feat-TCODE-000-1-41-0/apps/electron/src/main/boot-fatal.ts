/**
 * The loud end of a startup that cannot continue.
 *
 * Measured 2026-08-21 on packaged 1.31.0 (run file
 * `docs/testing/cdp-runs/2026-08-21-1.31.0-close-out.md`): a config tree whose
 * `config.json` passes `ensureStorageLayoutV2`'s tree check but fails
 * `loadStoredConfig`'s stricter validation made the app idle forever with no
 * window, no dialog and no log line. Two independent facts produced that:
 *
 *  1. **`app.whenReady().then(async …)` returns a promise nobody awaited.** A
 *     rejection inside it reached `process.on('unhandledRejection')`, which
 *     logged and returned. No `BrowserWindow` had been created yet, so
 *     `window-all-closed` never fires and nothing ever quits the process.
 *  2. **Outside debug mode `logger.ts` disables BOTH electron-log transports**
 *     (`log.transports.file.level = false`, same for console) — the reason
 *     `autoUpdateLog` exists at all. So `mainLog.error` writes nowhere in a
 *     packaged build, and an empty `~/Library/Logs/Nessy Desktop/main.log` is
 *     evidence of nothing whatsoever. Any startup diagnostic that matters must
 *     bypass electron-log, exactly as the auto-update log does.
 *
 * So this module writes its line to real stderr AND to an always-on
 * `<config dir>/logs/boot.log`, surfaces a dialog naming the config directory
 * and the error, and exits non-zero.
 *
 * The log line is written FIRST, before anything that can wait on a human: the
 * diagnostic has to be on disk even when nobody is at the keyboard. A parentless
 * `dialog.showMessageBox` then BLOCKS the main thread in a nested run loop
 * (measured on packaged 1.31.0, Electron 39.2.7 — the async signature does not
 * change that on macOS). Node timers still fire inside that nested loop, so the
 * watchdog below is reachable; the dialog is deliberately last.
 *
 * **`app.exit()` is not sufficient to end this process, and that is measured,
 * not assumed.** With the message loop running and no `BrowserWindow` ever
 * created, `app.exit(code)` returns and the process keeps idling in
 * `[NSApplication run]`. Controls that pin it down, all on the same packaged
 * binary: a minimal main calling `app.exit(1)` exits 1 every time (with and
 * without the single-instance lock, a privileged scheme, a protocol client
 * registration, or `--remote-debugging-port`); the same call at the very top of
 * `whenReady` — before the loop is running, where Electron takes its direct
 * `exit(code)` path — exits; and once a window exists it exits again, because
 * Electron then destroys windows instead of running the windowless
 * `Browser::Shutdown()` path. Calling it from INSIDE the dialog's nested loop is
 * worse than useless: it dismisses the alert, consumes Electron's one-shot
 * shutdown, and a second `app.exit()` is then a no-op forever. It also stops
 * Node timer delivery, so a grace timer armed after it never arrives. The
 * ending is therefore two calls in one tick — `app.exit(code)` for the clean
 * case, immediately followed by a hard exit that no run loop can starve.
 *
 * Copy is a local en/ru table rather than i18n, matching
 * `storage-readiness-ui.ts`: both surfaces can run before user-owned config —
 * and therefore before the persisted UI language — is readable. P6.741 moved
 * that table and the options builder to `../shared/boot-fatal-dialog.ts`, so the
 * playground can render this dialog's wording; a renderer never imports from
 * `main/`. Nothing about the ending, the countdown or the sink moved with it.
 */

import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  BROKEN_CONFIG_OPEN_BUTTON,
  BROKEN_CONFIG_SET_ASIDE_BUTTON,
  brokenConfigSetAsidePath,
  type BrokenConfigRepair,
} from '../shared/broken-config-dialog'
// P6.741 — the copy table and the options builder live beside the renderer now,
// so the playground can render this dialog's wording; a renderer never imports
// from `main/`. Everything below — the countdown, the sink, the ending — stays.
import {
  buildBootFatalDialog as buildBootFatalDialogOptions,
  type BootFatalDialogOptions,
  type BootFatalErrorDescription,
} from '../shared/boot-fatal-dialog'

export type { BootFatalDialogOptions, BootFatalErrorDescription }

/** How long an undismissed boot-fatal dialog holds the process before it ends anyway. */
export const BOOT_FATAL_DIALOG_TIMEOUT_MS = 10_000

/**
 * P6.725 — the same bound, for the one dialog that asks a QUESTION.
 *
 * Ten seconds is right for a refusal whose only button is Quit: it bounds a
 * machine with nobody at it and costs a present user nothing, because there is
 * nothing to decide. A repair offer is different — the user has to read an
 * absolute path, understand that nothing will be deleted, and choose — and a
 * countdown that ends the process mid-read would take the way out away from
 * exactly the person it was built for. Two minutes still bounds the unattended
 * machine, which is the only thing the countdown is for.
 */
export const BOOT_FATAL_REPAIR_DIALOG_TIMEOUT_MS = 120_000

/**
 * The dialog's wait is counted in steps this size rather than armed as one long
 * timer. Measured on packaged 1.31.0: a 5 s timeout was delivered while a 60 s
 * one was still undelivered 100 s later — a windowless app with nothing on
 * screen is exactly what macOS throttles. Short repeated steps survive that.
 */
export const BOOT_FATAL_TICK_MS = 1_000

export const BOOT_FATAL_EXIT_CODE = 1

export interface BootFatalInput {
  /** Startup step that failed. Recorded in the log line; never shown in the dialog. */
  phase: string
  configDir: string
  error: unknown
  /**
   * P6.725 — present only when the failure is a refused `config.json`, and it
   * turns the one-button refusal into the two ways out
   * `shared/broken-config-dialog.ts` describes. Absent for every other startup
   * failure, which keeps its single **Quit**: those have no repair to offer, and
   * a button that cannot help is worse than none.
   */
  repair?: BrokenConfigRepair
}

export interface BootFatalDeps {
  /** Always-on diagnostic sink. Must not be electron-log — it is off in packaged builds. */
  writeDiagnostic(line: string): void
  showDialog(options: BootFatalDialogOptions): Promise<unknown>
  /** Electron's own ending. Clean, and — see the file header — not always enough. */
  exit(code: number): void
  /** The rung a run loop cannot starve. Only reached when `exit` did not end the process. */
  hardExit(code: number): void
  schedule(fn: () => void, ms: number): void
  locale?: string
  now?: () => Date
  /** P6.725 — reveal the refused file. Only ever called for a `repair` offer. */
  openPath?(path: string): unknown
  /**
   * P6.725 — rename the refused file out of the way. Only ever called for a
   * `repair` offer, and only ever with `repair.configFile` as its source: this
   * module chooses no paths of its own.
   */
  setAside?(from: string, to: string): void
}

/** Strip control characters and cap length: this text reaches a dialog and a log line. */
function safeText(value: string, limit: number): string {
  return value.replace(/[\u0000-\u001F\u007F]/g, ' ').slice(0, limit)
}

export function describeBootFatalError(error: unknown): BootFatalErrorDescription {
  if (error instanceof Error) {
    return {
      name: safeText(error.name || 'Error', 120),
      message: safeText(error.message || String(error), 512),
    }
  }
  if (typeof error === 'string') return { name: 'Error', message: safeText(error, 512) }
  return { name: 'Error', message: safeText(String(error), 512) }
}

export function formatBootFatalLogLine(input: BootFatalInput, now: Date = new Date()): string {
  const described = describeBootFatalError(input.error)
  return JSON.stringify({
    timestamp: now.toISOString(),
    level: 'error',
    scope: 'boot',
    phase: safeText(input.phase, 120),
    configDir: input.configDir,
    error: described,
    message: `Startup failed in ${safeText(input.phase, 120)}: ${described.name}: ${described.message}`,
  })
}

/**
 * One always-on line for a BLOCKED storage readiness result — the startup path
 * that had no diagnostic at all. Its dialog is the only surface, and a modal
 * nobody is present to see is indistinguishable from a hang.
 */
export function formatBootBlockedLogLine(
  input: { code: string; configDir: string },
  now: Date = new Date(),
): string {
  const code = safeText(input.code, 120)
  return JSON.stringify({
    timestamp: now.toISOString(),
    level: 'error',
    scope: 'boot',
    phase: 'storage-readiness',
    configDir: input.configDir,
    code,
    message: `Storage readiness blocked: ${code}. Startup is waiting on the storage dialog.`,
  })
}

/**
 * D1.142 — ONE line for a renderer that died, on the one sink a packaged build
 * actually writes.
 *
 * The harness half of this was built by C3.389: `scripts/cdp/lib/renderer-health.ts`
 * can tell a lost renderer from a quit app by asking the DevTools endpoint, and
 * its own docblock says the PRODUCT half belongs here. This is that half, and
 * the reason it belongs in THIS file rather than in `logger.ts` is the sentence
 * `createBootDiagnosticWriter` already carries: electron-log's transports are
 * disabled in packaged builds, so a renderer loss reached no log at all — the
 * user's whole evidence was a window that went white.
 *
 * `scope` is `renderer`, not `boot`, and that is deliberate: this file's other
 * two lines describe a startup that cannot continue, while a renderer can die
 * at any moment of a long session and the window usually comes back. A reader
 * grepping `"scope":"boot"` for a failed launch must not collect these.
 *
 * `reason` is Electron's own `RenderProcessGoneDetails.reason` verbatim
 * (`crashed`, `killed`, `oom`, `launch-failed`, …) — the vendor's vocabulary,
 * not one of ours — and `exitCode` is the number beside it. Nothing else from
 * the window is recorded: a URL can carry a workspace id and a query, and this
 * line exists to be pasted into a bug report.
 */
export function formatRendererGoneLogLine(
  input: { reason: string; exitCode: number; configDir: string },
  now: Date = new Date(),
): string {
  const reason = safeText(input.reason, 120)
  return JSON.stringify({
    timestamp: now.toISOString(),
    level: 'error',
    scope: 'renderer',
    phase: 'render-process-gone',
    configDir: input.configDir,
    reason,
    exitCode: Number.isFinite(input.exitCode) ? input.exitCode : null,
    message: `The renderer process ended: ${reason} (exit ${Number.isFinite(input.exitCode) ? input.exitCode : 'unknown'}).`,
  })
}

/**
 * The dialog for a startup that cannot continue.
 *
 * P6.741 moved the copy and the rendering to `shared/boot-fatal-dialog.ts`; this
 * wrapper keeps the signature its callers and tests already use, and it is the
 * one place that turns an unknown thrown value into the described pair — the
 * same `describeBootFatalError` the log-line formatters above use, so a dialog
 * and its log line can never disagree about what failed.
 */
export function buildBootFatalDialog(
  input: BootFatalInput,
  locale?: string,
  now: Date = new Date(),
): BootFatalDialogOptions {
  return buildBootFatalDialogOptions(
    {
      configDir: input.configDir,
      described: describeBootFatalError(input.error),
      ...(input.repair ? { repair: input.repair } : {}),
    },
    locale,
    now,
  )
}

/** A deadline counted in {@link BOOT_FATAL_TICK_MS} steps. See that constant for why. */
function countDown(deps: BootFatalDeps, totalMs: number, done: () => void): void {
  let remaining = totalMs
  const tick = () => {
    remaining -= BOOT_FATAL_TICK_MS
    if (remaining <= 0) {
      done()
      return
    }
    deps.schedule(tick, BOOT_FATAL_TICK_MS)
  }
  deps.schedule(tick, BOOT_FATAL_TICK_MS)
}

/**
 * Report and end the process. Never throws: a failure to report must not become
 * a second, quieter failure.
 */
export function reportBootFatal(input: BootFatalInput, deps: BootFatalDeps): void {
  try {
    deps.writeDiagnostic(formatBootFatalLogLine(input, deps.now?.() ?? new Date()))
  } catch {
    // The diagnostic sink already mirrors to stderr and swallows its own errors.
  }

  let ending = false
  const end = () => {
    if (ending) return
    ending = true
    // The clean ending first, then in the SAME TICK the one that cannot fail.
    // Nothing may be scheduled between them: `app.exit()` stops this process's
    // Node timer delivery (measured — a 2 s grace timer armed immediately after
    // it was never delivered, and the app idled on exactly the hang this whole
    // task exists to remove), so the hard rung cannot wait on a timer.
    deps.exit(BOOT_FATAL_EXIT_CODE)
    deps.hardExit(BOOT_FATAL_EXIT_CODE)
  }

  // Armed before the dialog, because the dialog blocks the main thread. This
  // countdown is what bounds a machine with nobody at it — including the repair
  // loop below, which is why that loop needs no bound of its own.
  countDown(
    deps,
    input.repair ? BOOT_FATAL_REPAIR_DIALOG_TIMEOUT_MS : BOOT_FATAL_DIALOG_TIMEOUT_MS,
    end,
  )

  const options = buildBootFatalDialog(input, deps.locale, deps.now?.() ?? new Date())

  const show = (): void => {
    let shown: Promise<unknown>
    try {
      shown = deps.showDialog(options)
    } catch {
      end()
      return
    }
    void Promise.resolve(shown).then(choose, end)
  }

  /**
   * P6.725 — act on the two ways out, then end. Without a `repair` offer this is
   * the old unconditional `end`, and the dialog it answers has one button.
   */
  const choose = (result: unknown): void => {
    const repair = input.repair
    if (!repair) {
      end()
      return
    }
    const response = (result as { response?: unknown } | null | undefined)?.response
    if (response === BROKEN_CONFIG_OPEN_BUTTON) {
      // Best-effort, and then ASK AGAIN: revealing the file is not a decision,
      // and a user who repairs it by hand still has to choose how this ends.
      // `storage-readiness-ui.ts` treats its own "Open diagnostics" the same way.
      try {
        void deps.openPath?.(repair.configFile)
      } catch {
        // A file manager that will not open must not turn into a second failure.
      }
      show()
      return
    }
    if (response === BROKEN_CONFIG_SET_ASIDE_BUTTON) {
      const target = brokenConfigSetAsidePath(repair.configFile, deps.now?.() ?? new Date())
      try {
        deps.setAside?.(repair.configFile, target)
        deps.writeDiagnostic(formatBootRepairLogLine(
          { configDir: input.configDir, from: repair.configFile, to: target },
          deps.now?.() ?? new Date(),
        ))
      } catch (error) {
        // The rename is the whole action, so its failure is the whole news. It
        // is written rather than shown: this process is one tick from ending and
        // a second modal would be a second thing to dismiss.
        deps.writeDiagnostic(formatBootRepairLogLine(
          {
            configDir: input.configDir,
            from: repair.configFile,
            to: target,
            failure: describeBootFatalError(error).message,
          },
          deps.now?.() ?? new Date(),
        ))
      }
    }
    end()
  }

  show()
}

/**
 * P6.725 — one always-on line for a set-aside, succeeded or failed.
 *
 * It goes to the same sink as the refusal above it, so `boot.log` carries the
 * whole episode: what was refused, and what the user chose to do about it. A
 * rename nobody recorded is indistinguishable later from a file that vanished.
 */
export function formatBootRepairLogLine(
  input: { configDir: string; from: string; to: string; failure?: string },
  now: Date = new Date(),
): string {
  return JSON.stringify({
    timestamp: now.toISOString(),
    level: input.failure === undefined ? 'info' : 'error',
    scope: 'boot',
    phase: 'config-set-aside',
    configDir: input.configDir,
    from: input.from,
    to: input.to,
    ...(input.failure === undefined ? {} : { failure: safeText(input.failure, 512) }),
    message: input.failure === undefined
      ? `Set the refused configuration aside: ${input.from} -> ${input.to}. Nothing was deleted.`
      : `Could not set the refused configuration aside: ${input.from} -> ${input.to}.`,
  })
}

/**
 * Always-on startup diagnostic sink: stderr plus `<config dir>/logs/boot.log`.
 * Same reasoning as `autoUpdateLog` in `logger.ts` — electron-log's transports
 * are disabled in packaged builds, so neither of these may go through it.
 *
 * The file half is best-effort by necessity: the boot failures worth reporting
 * include "this config directory cannot be used", where the write must fail.
 */
export function createBootDiagnosticWriter(configDir: string): (line: string) => void {
  const path = join(configDir, 'logs', 'boot.log')
  return (line: string) => {
    try {
      process.stderr.write(`${line}\n`)
    } catch {
      // A closed stderr must not mask the disk write below.
    }
    try {
      mkdirSync(join(configDir, 'logs'), { recursive: true })
      appendFileSync(path, `${line}\n`, 'utf8')
    } catch {
      // Unusable config directory — stderr above is the whole diagnostic then.
    }
  }
}

export function bootDiagnosticLogPath(configDir: string): string {
  return join(configDir, 'logs', 'boot.log')
}
