import i18n from 'i18next'
import { toast } from 'sonner'
import type {
  ManagedEditContextKey,
  ManagedResourceEditRequest,
  MutableManagedResourceRef,
  SafeSessionRef,
} from '@nessy-agent/shared/protocol/capabilities'

export interface ManagedEditTarget {
  resource: MutableManagedResourceRef
  contextKey: ManagedEditContextKey
  label: string
}

export function buildManagedEditRequest(
  target: ManagedEditTarget,
  session: SafeSessionRef,
  instructions: string,
): ManagedResourceEditRequest {
  if (!instructions.trim()) throw new Error('Managed edit instruction is required')
  return { session, resource: target.resource, contextKey: target.contextKey, instructions }
}

/**
 * F1.754 — the one catch both EditPopover send paths put on a managed edit.
 * Both used to drop the request's promise, so every rejection reached the
 * renderer as an UNHANDLED error.
 *
 * The host answers `capabilities:submitManagedEdit` once the turn is dispatched
 * (`handlers/rpc/capabilities.ts` symbol `untilTurnDispatched`), so a rejection
 * is one of two things. A REFUSAL (no such session, a scope mismatch, a refused
 * start) is shown to the user. The renderer's own 30 s request budget running
 * out under load (`transport/client.ts` symbol `invoke`, the F1.212 family) is
 * only logged: a client timeout cancels nothing, the host goes on handling the
 * request, and the hidden session's transcript shows the turn if it landed —
 * reporting it as a failed edit would be the misreport F1.212 records.
 *
 * A turn that fails AFTER the dispatch never reaches this catch (F1.994): the
 * host ends it on the session's own event stream, `error` then `complete` to
 * this client (`handlers/rpc/sessions.ts` symbol `reportPostPersistTurnFailure`),
 * and that is what stops the inline popover's spinner and shows the error.
 */
export function reportManagedEditFailure(
  error: unknown,
  showRefusal: (message: string) => void = showManagedEditRefusal,
): void {
  const message = error instanceof Error ? error.message : String(error)
  if (message.startsWith('Request timeout: ')) {
    console.warn(`[EditPopover] ${message}; not reported as a failed edit, the host keeps handling the request`)
    return
  }
  console.error('[EditPopover] managed edit refused:', error)
  showRefusal(message)
}

function showManagedEditRefusal(message: string): void {
  toast.error(i18n.t('common.error'), { description: message })
}
