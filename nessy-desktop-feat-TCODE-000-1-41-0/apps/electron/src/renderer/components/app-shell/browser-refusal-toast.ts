/**
 * P2.464 — WHICH TOAST A REFUSED BROWSER WINDOW EARNS, and why that is a
 * module rather than four lines inside `handleNewBrowserWindow`.
 *
 * ## The defect this closes
 *
 * `BrowserPaneManager.create` refuses when an administrator has turned the
 * in-app browser off, and until W3-f it threw a PLAIN error with the reason in
 * its message. `AppShell` caught it and rendered
 * `toast.error(t('toast.failedToCreateBrowser'))` — so the refusal was
 * discarded entirely and a managed policy reached the user as a malfunction.
 * A refusal and a failure that read identically have OPPOSITE remedies: one
 * clears when the administrator changes the policy, the other when the user
 * tries again. That is the same distinction P2.429 drew for a refused
 * marketplace, and this row is its browser instance.
 *
 * ## Why a module
 *
 * The reason `managed-model-refusal.ts` gives for its own extraction, which is
 * the sibling this row's code was modelled on: a rule has to be assertable on
 * VALUES, and `AppShell.tsx` cannot be imported cheaply — it reaches the
 * `@nessy-agent/ui` barrel, whose chain ends at a `?url` import of the pdf
 * worker that bun's runner cannot load, so a suite importing it must install
 * `mock.module` stubs on a shared graph before it can start. A suite driving
 * this module needs none of that.
 *
 * ## The two rules a caller must not re-derive
 *
 * **Branch on the wire CODE, never `instanceof CodedError`.** The transport
 * rebuilds a plain `Error` with `.code` attached on this side, so the class
 * check is false for every real refusal. `pi-agent.ts`'s
 * `mapBrowserToolErrorCode` records the same rule for the model-facing half of
 * this row, and `managed-model-refusal.ts` for the settings half.
 *
 * **Show the server's sentence.** Every other coded refusal in this tree
 * REPLACES the message with a translated one; this one keeps it, in the
 * description, because it names WHICH administrator's document decided — the
 * only actionable half of the refusal and the one thing no translated string
 * can carry. The translated title says what happened; the untranslated sentence
 * says where it was decided.
 */
import type { ErrorCode } from '@nessy-agent/shared/protocol'

/**
 * The code `BrowserPaneManager.create` throws under a managed refusal.
 *
 * `satisfies ErrorCode` is the compile-time half of the drift guard: the branch
 * below is dead the moment the protocol renames or drops this code, and dead
 * SILENTLY — the refusal would quietly fall back to "could not create", which
 * is the exact defect this row closed. `typecheck:electron` catches the rename;
 * the suite catches the removal through the protocol's own registry.
 */
const BROWSER_MANAGED_DISABLED = 'BROWSER_MANAGED_DISABLED' satisfies ErrorCode

/**
 * The toast a refused browser window earns, or `null` when the failure was
 * something else and belongs in the generic could-not-create path.
 */
export function describeBrowserRefusal(
  error: unknown,
): { titleKey: string; description: string } | null {
  const code = (error as { code?: unknown } | null | undefined)?.code
  if (code !== BROWSER_MANAGED_DISABLED) return null
  return {
    titleKey: 'toast.browserManagedDisabled',
    description: error instanceof Error ? error.message : String(error),
  }
}
