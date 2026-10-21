/**
 * P6.725 — the two ways out of a `config.json` the app refuses to load.
 *
 * ## What was missing, and what deliberately still is
 *
 * `7ff647a71` (P6.438) made the refusal SAY what a user can do: it names the
 * absolute file and both routes `settings.md#fix-a-broken-settings-file`
 * describes — repair it by hand, or move it aside and start from the default
 * configuration. It performed neither, and the boot dialog carrying that
 * sentence had one button, **Quit**. So the diagnosis was complete and the exit
 * was still "read this path, quit the app, and go find a file manager".
 *
 * The owner answered on 2026-09-07: **a dialog WITHOUT reset.** Two choices, and
 * nothing is erased — no factory reset, because resetting an app-state file
 * discards the user's workspaces and connections, which is a posture this
 * product has not taken and a dialog is the wrong place to take it.
 *
 *  - **Open the file** reveals it, for the repair-by-hand route. The app stays
 *    stopped and the dialog stays up, so a user who edits the file can quit and
 *    relaunch, or set it aside after all.
 *  - **Set it aside and quit** RENAMES `config.json` to
 *    `config.json.broken-<timestamp>` and does nothing else. The old file stays
 *    on disk under a new name; nothing is written, nothing is deleted, and the
 *    next launch finds no `config.json` and starts from the defaults.
 *
 * ## Why the second button says "and quit" rather than "and start empty"
 *
 * The owner's words were *"rename it to `.broken` and start empty"*, and this
 * does exactly that in two steps rather than one. Restarting in-process is not
 * available at this point without touching a measured hazard:
 * `reportBootFatal`'s ending is `app.exit(code)` followed IN THE SAME TICK by a
 * hard exit, because a windowless Electron app survives `app.exit()` and idles
 * in the platform run loop (measured on packaged 1.31.0 — see `boot-fatal.ts`).
 * An `app.relaunch()` registered against that exit would be racing a `SIGKILL`
 * arriving in the same tick, and reordering that ending is exactly the change
 * that file's header exists to prevent. A button label must describe what
 * happens, so it says so and the detail line says the next launch starts from
 * the default configuration.
 *
 * ## The path is supplied, never parsed out of the refusal
 *
 * The refusal message DOES carry the absolute path — P6.438 put it there — and
 * reading it back out would be the obvious shortcut. It is not taken, because
 * `refuseStorageLayout` builds that message by prefixing the JSON parser's own
 * error text, which is derived from the FILE'S CONTENT. A crafted `config.json`
 * could therefore make the message contain an earlier `The refused file is
 * /some/other/path.` sentence, and the thing on the other end of this decision
 * is a rename. The caller passes the constant instead, and this module renames
 * only the path it was given.
 *
 * ## Copy lives here, not in i18n
 *
 * Same reason `boot-fatal.ts` and `storage-readiness-ui.ts` carry local en/ru
 * tables: this dialog runs precisely when user-owned configuration — and
 * therefore the persisted UI language — cannot be read. It sits in
 * `apps/electron/src/shared` rather than in `main/` so the playground entry can
 * render the same table the dialog uses; a renderer never imports from `main/`.
 */

/** Button indices, named because two files switch on them. */
export const BROKEN_CONFIG_OPEN_BUTTON = 0
export const BROKEN_CONFIG_SET_ASIDE_BUTTON = 1
export const BROKEN_CONFIG_QUIT_BUTTON = 2

/** The suffix that makes a set-aside file recognisable at a glance. */
export const BROKEN_CONFIG_SUFFIX = '.broken-'

const COPY = {
  en: {
    title: 'Nessy cannot read its configuration',
    message: 'Nessy stopped during startup: its configuration file could not be read.',
    file: 'File',
    problem: 'Problem',
    setAsideNote: (target: string) =>
      `"Set it aside and quit" renames the file to ${target} and quits. Nothing is deleted and nothing else `
      + 'is changed; the next launch starts from the default configuration.',
    buttons: ['Open the file', 'Set it aside and quit', 'Quit'],
  },
  ru: {
    title: 'Nessy не может прочитать конфигурацию',
    message: 'Nessy остановился при запуске: не удалось прочитать файл конфигурации.',
    file: 'Файл',
    problem: 'Проблема',
    setAsideNote: (target: string) =>
      `«Отложить и выйти» переименует файл в ${target} и завершит работу. Ничего не удаляется и больше `
      + 'ничего не меняется; следующий запуск начнётся с настроек по умолчанию.',
    buttons: ['Открыть файл', 'Отложить и выйти', 'Выйти'],
  },
} as const

export interface BrokenConfigDialogOptions {
  type: 'error'
  title: string
  message: string
  detail: string
  buttons: string[]
  defaultId: number
  cancelId: number
  noLink: boolean
}

export interface BrokenConfigRepair {
  /** Absolute path of the refused file. Supplied by the caller — see the header. */
  configFile: string
}

/** Strip control characters and cap length: this text reaches a dialog. */
function safeText(value: string, limit: number): string {
  return value.replace(/[\u0000-\u001F\u007F]/g, ' ').slice(0, limit)
}

/**
 * Where the file goes. The ISO stamp is flattened exactly as
 * `copyCorruptedConfigOnce` flattens its own — colons are illegal in a Windows
 * filename — so the two neighbours in one directory sort the same way.
 */
export function brokenConfigSetAsidePath(configFile: string, now: Date = new Date()): string {
  return `${configFile}${BROKEN_CONFIG_SUFFIX}${now.toISOString().replace(/[:.]/g, '-')}`
}

/**
 * Is this the failure the two choices apply to?
 *
 * The name, not `instanceof`: this predicate runs in the Electron main bundle
 * and the error is constructed in `@nessy-agent/shared`, so an identity check
 * across bundle boundaries is the kind of thing that works until a build tool
 * changes. `UnsupportedStorageLayoutError` is thrown by exactly one function,
 * `refuseStorageLayout`, and that function is only ever about `config.json`.
 */
export function isRefusedStoredConfigError(error: unknown): boolean {
  return (error as { name?: unknown } | null | undefined)?.name === 'UnsupportedStorageLayoutError'
}

export function buildBrokenConfigDialog(
  repair: BrokenConfigRepair,
  problem: string,
  locale?: string,
  now: Date = new Date(),
): BrokenConfigDialogOptions {
  const copy = COPY[locale?.toLowerCase().startsWith('ru') ? 'ru' : 'en']
  const target = brokenConfigSetAsidePath(repair.configFile, now)
  return {
    type: 'error',
    title: copy.title,
    message: copy.message,
    detail: [
      `${copy.file}: ${repair.configFile}`,
      `${copy.problem}: ${safeText(problem, 512)}`,
      copy.setAsideNote(target),
    ].join('\n'),
    buttons: [...copy.buttons],
    defaultId: BROKEN_CONFIG_OPEN_BUTTON,
    cancelId: BROKEN_CONFIG_QUIT_BUTTON,
    noLink: true,
  }
}
