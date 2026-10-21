/**
 * UA12.49 — the browser answer to the server's confirm-dialog requests.
 *
 * UA3.8 gave `showDeleteSessionConfirmation` a `sessionId` so the host can name
 * the task folder the delete removes — the dialog is composed SERVER-side
 * (`auth:showDeleteSessionConfirmation`, `taskFolderDeletedWith`) and delivered
 * to the client as a `CLIENT_CONFIRM_DIALOG` request. The Electron preload
 * answers it with a native message box; the webui client now answers it with
 * `window.confirm`, so the web surface sees the same composed text (task
 * folder, shared link, cannot-undo) instead of a local two-arg-blind stub.
 *
 * Extracted from the adapter so a bun test can import it: the adapter's module
 * body reaches for `window.matchMedia`, `i18next` and a WebSocket client
 * (the D1.282 note in `__tests__/rpc-error-rehydration.test.ts`).
 */
import type { ConfirmDialogSpec } from '@nessy-agent/server-core/transport'

/**
 * Map the server's dialog spec onto `window.confirm`'s OK/Cancel.
 *
 * `window.confirm` has two answers where the native box may have three
 * buttons: OK is index 1 (the proceed action of every spec the server sends
 * today — delete, delete-keeping-the-link, log out), Cancel is index 0 (the
 * `cancelId` both existing specs pin). A shared-chat delete's third button
 * ("Delete and stop sharing", index 2) is therefore unreachable from a plain
 * browser confirm — stated residue on this dormant surface.
 */
export function browserConfirmDialogResponse(spec: ConfirmDialogSpec): { response: number } {
  const text = [spec.title, spec.message, spec.detail].filter(Boolean).join('\n\n')
  const confirmed = window.confirm(text)
  return { response: confirmed ? 1 : 0 }
}
