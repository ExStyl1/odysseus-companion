/**
 * P6.741 — the storage-readiness dialog's COPY and its builder, moved out of
 * `main/`.
 *
 * `main/storage-readiness-ui.ts` keeps everything that is not copy: the blocked-
 * code allowlist, the diagnostics-path containment check (which is a SECURITY
 * boundary — it decides what `shell.openPath` may be handed), and the retry
 * loop. None of that moved.
 *
 * What moved is the en/ru table and the pure options builder, into
 * `apps/electron/src/shared` for the reason `broken-config-dialog.ts` gives:
 * **a renderer never imports from `main/`**, so the playground — the one surface
 * where this product's copy is reviewed — could not reach this dialog's wording
 * at all. This is the second half of P6.741.
 *
 * Copy is local rather than i18n for the same reason as its two siblings: this
 * dialog is shown precisely when storage is unavailable, so the persisted UI
 * language may be unreadable. It follows the OS locale instead.
 */

export interface StorageReadinessDialogOptions {
  type: 'error'
  title: string
  message: string
  detail: string
  buttons: string[]
  defaultId: number
  cancelId: number
  noLink: boolean
}

/** Button indices, named because the retry loop switches on them. */
export const STORAGE_READINESS_RETRY_BUTTON = 0
export const STORAGE_READINESS_DIAGNOSTICS_BUTTON = 1
export const STORAGE_READINESS_QUIT_BUTTON = 2

const COPY = {
  en: {
    title: 'Nessy storage is unavailable',
    message: 'Nessy cannot start until its storage is ready.',
    detail: 'Normal windows and services have not started.',
    code: 'Code',
    diagnostics: 'Diagnostics',
    buttons: ['Retry', 'Open diagnostics', 'Quit'],
  },
  ru: {
    title: 'Хранилище Nessy недоступно',
    message: 'Nessy не может запуститься, пока хранилище не будет готово.',
    detail: 'Обычные окна и сервисы не запущены.',
    code: 'Код',
    diagnostics: 'Диагностика',
    buttons: ['Повторить', 'Открыть диагностику', 'Выйти'],
  },
} as const

export interface StorageReadinessDialogInput {
  /**
   * The blocked code, ALREADY narrowed to the allowlist by the caller. This
   * module renders what it is given: the allowlist lives beside the readiness
   * check that produces the codes, and a second copy of it here could admit a
   * code the check never emits.
   */
  code: string
  /**
   * The diagnostics path, ALREADY contained by the caller. Deliberately not
   * re-derived: containment decides what `shell.openPath` may be handed, and a
   * security boundary with two implementations has none.
   */
  diagnostics: string
}

export function buildStorageReadinessDialog(
  input: StorageReadinessDialogInput,
  locale?: string,
): StorageReadinessDialogOptions {
  const copy = COPY[locale?.toLowerCase().startsWith('ru') ? 'ru' : 'en']
  return {
    type: 'error',
    title: copy.title,
    message: copy.message,
    detail: `${copy.detail}\n${copy.code}: ${input.code}\n${copy.diagnostics}: ${input.diagnostics}`,
    buttons: [...copy.buttons],
    defaultId: STORAGE_READINESS_RETRY_BUTTON,
    cancelId: STORAGE_READINESS_QUIT_BUTTON,
    noLink: true,
  }
}
