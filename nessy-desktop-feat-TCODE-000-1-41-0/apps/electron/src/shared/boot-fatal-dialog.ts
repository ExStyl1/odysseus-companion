/**
 * P6.741 — the boot-fatal dialog's COPY and its builder, moved out of `main/`.
 *
 * The dialog itself — its countdown, its always-on diagnostic sink and its
 * two-call ending — stays in `main/boot-fatal.ts`, whose header explains why
 * that ending is ordered exactly as it is. None of that moved. What moved is
 * the part a reviewer needs to be able to LOOK at: the en/ru table and the pure
 * function that turns a startup failure into the options object the OS draws.
 *
 * It sits in `apps/electron/src/shared` for one reason, the same one
 * `broken-config-dialog.ts` gives: **a renderer never imports from `main/`**, so
 * while the table lived there the playground could not render this dialog's copy
 * at all. That is the whole of P6.741 — two startup dialogs whose copy had no
 * runnable evidence, because the one surface where this product's copy is
 * reviewed could not reach them.
 *
 * Copy is a local en/ru table rather than i18n, and that is not an oversight:
 * this dialog runs when startup has already failed, which includes the failures
 * where user-owned configuration — and therefore the persisted UI language —
 * cannot be read. `storage-readiness-ui.ts` and `broken-config-dialog.ts` carry
 * their own tables for the same reason.
 *
 * ## Why this takes a DESCRIBED error rather than an unknown
 *
 * `describeBootFatalError` stays in `main/boot-fatal.ts` beside the log-line
 * formatters that are its other caller. Passing the described `{name, message}`
 * in keeps this module free of the control-character strip those formatters own,
 * so there is exactly one copy of that rule, and it makes this builder trivially
 * renderable from a playground entry that has no `Error` to describe.
 */

import { buildBrokenConfigDialog, type BrokenConfigRepair } from './broken-config-dialog'

const COPY = {
  en: {
    title: 'Nessy cannot start',
    message: 'Nessy stopped during startup and cannot continue.',
    detail: 'No windows or services were started.',
    configDir: 'Configuration folder',
    problem: 'Problem',
    buttons: ['Quit'],
  },
  ru: {
    title: 'Nessy не может запуститься',
    message: 'Nessy остановился при запуске и не может продолжить.',
    detail: 'Окна и сервисы не запущены.',
    configDir: 'Папка конфигурации',
    problem: 'Проблема',
    buttons: ['Выйти'],
  },
} as const

export interface BootFatalDialogOptions {
  type: 'error'
  title: string
  message: string
  detail: string
  buttons: string[]
  defaultId: number
  cancelId: number
  noLink: boolean
}

/** Already stripped and capped by `describeBootFatalError` — see the header. */
export interface BootFatalErrorDescription {
  name: string
  message: string
}

export interface BootFatalDialogInput {
  configDir: string
  described: BootFatalErrorDescription
  /**
   * P6.725 — present only when the failure is a refused `config.json`, and it
   * turns the one-button refusal into the two ways out
   * `broken-config-dialog.ts` describes. Absent for every other startup failure,
   * which keeps its single **Quit**: those have no repair to offer, and a button
   * that cannot help is worse than none.
   */
  repair?: BrokenConfigRepair
}

export function buildBootFatalDialog(
  input: BootFatalDialogInput,
  locale?: string,
  now: Date = new Date(),
): BootFatalDialogOptions {
  const copy = COPY[locale?.toLowerCase().startsWith('ru') ? 'ru' : 'en']
  const { name, message } = input.described
  // P6.725 — a refused `config.json` gets its own copy and its own two choices.
  // Everything else keeps the single Quit this dialog has always had.
  if (input.repair) {
    return buildBrokenConfigDialog(input.repair, `${name}: ${message}`, locale, now)
  }
  return {
    type: 'error',
    title: copy.title,
    message: copy.message,
    detail: `${copy.detail}\n${copy.configDir}: ${input.configDir}\n${copy.problem}: ${name}: ${message}`,
    buttons: [...copy.buttons],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  }
}
