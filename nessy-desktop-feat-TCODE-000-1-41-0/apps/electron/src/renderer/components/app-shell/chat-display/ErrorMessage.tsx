/**
 * Source: v0.15.1:apps/electron/src/renderer/components/app-shell/chat-display/ErrorMessage.tsx (UB14.14; ADDED in v0.15.0).
 * Taken, then OUR hunks re-applied (UB14.14 Keep): D1.194/D1.272 credential sign-in — first and the
 * primary action, `data-testid="credential-sign-in"`, the connection slug read from the session's
 * metadata and handed to `handleErrorMessageAction`; `t('chat.errorRaw')` for upstream's literal
 * `Raw:` (UA12.142, `renderer-hardcoded-strings.test.ts`).
 */
import * as React from "react"
import { useTranslation } from "react-i18next"
import { motion } from "motion/react"
import { ChevronRight, CircleAlert } from "lucide-react"
import { useAtomValue } from "jotai"
import { SPRING } from "@nessy-agent/ui/motion"
import { Button } from "@/components/ui/button"
import { AnimatedCollapsibleContent } from "@/components/ui/collapsible"
// D1.194 — the ONE sign-in affordance for an expired credential, and the atom
// that says which connection the failing session was using.
import { isReplacedByCredentialSignIn, resolveCredentialSignIn } from "@/lib/credential-sign-in"
import { navigate } from "@/lib/navigate"
import { sessionMetaMapAtom } from "@/atoms/sessions"
import type { Message } from "../../../../shared/types"
import { handleErrorMessageAction } from "../error-message-actions"
import { stripRepeatedTitle } from "./strip-repeated-title"

interface ErrorMessageProps {
  message: Message
  onOpenUrl?: (url: string) => void
  sessionId?: string
  onRetry?: () => void
}

/**
 * ErrorMessage - inline error marker (spec §7.7): the same alert material as Info_Alert (destructive
 * tint, 1px destructive hairline, radius 12, 14px inset) — a 2px left rule on a rounded box tapered
 * into the corners like a bracket. Icon + title in the destructive role (600), body in the foreground
 * role, the recovery actions as buttons (the first one primary), raw details under a disclosure.
 */
export function ErrorMessage({ message, onOpenUrl, sessionId, onRetry }: ErrorMessageProps) {
  const { t } = useTranslation()
  const hasDetails = (message.errorDetails && message.errorDetails.length > 0) || message.errorOriginal
  const [detailsOpen, setDetailsOpen] = React.useState(false)
  /**
   * D1.194 — A CREDENTIAL FAILURE GETS ONE SIGN-IN BUTTON, ON EVERY RUNTIME.
   *
   * Selected by the error CODE, so a runtime does not have to be recognised for
   * its user to be offered the same thing — see `lib/credential-sign-in.ts` for
   * the three surfaces this replaces and why the choice is made there.
   *
   * The connection comes from the session's own metadata rather than from a
   * prop: this marker already has the `sessionId`, the map is the renderer's
   * existing per-session state, and threading a slug through `MessageBubble`'s
   * memo boundary would put the value one comparator away from being silently
   * dropped.
   */
  const sessionMetaMap = useAtomValue(sessionMetaMapAtom)
  // D1.272 — the same slug the card uses feeds the backend's own `reauth`
  // action, so the two buttons cannot land on different connections.
  const connectionSlug = sessionId ? sessionMetaMap.get(sessionId)?.llmConnection : undefined
  const credentialSignIn = resolveCredentialSignIn(message.errorCode, connectionSlug)
  const actions = message.errorActions?.filter(a => {
    if (a.action === 'open_url') return !!a.url && !!onOpenUrl
    // The backend's own `settings` action says the same thing less precisely and
    // in English; it is dropped ONLY while the card's button is shown.
    if (credentialSignIn && isReplacedByCredentialSignIn(a)) return false
    return true
  })
  const title = message.errorTitle || t('common.error')
  const body = stripRepeatedTitle(title, message.content)

  return (
    <div className="flex min-w-0 gap-2.5 rounded-lg bg-destructive-tint inset-ring inset-ring-[var(--destructive-border)] px-3.5 py-3">
      <CircleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-destructive" />
      <div className="min-w-0 flex-1 break-words">
        <div className="text-label font-semibold text-destructive">{title}</div>
        {body && <p className="mt-0.5 text-label leading-5 text-foreground">{body}</p>}

        {/* Action buttons: one primary, the rest quiet. D1.194 — the sign-in is that one primary. */}
        {(credentialSignIn || (actions && actions.length > 0)) && (
          <div className="mt-2 flex flex-wrap gap-2">
            {credentialSignIn && (
              <Button
                key="credential-sign-in"
                data-testid="credential-sign-in"
                variant="primary"
                size="md"
                onClick={() => navigate(credentialSignIn.route)}
              >
                {t(credentialSignIn.labelKey)}
              </Button>
            )}
            {actions?.map((action, index) => (
              <Button
                key={action.key}
                variant={!credentialSignIn && index === 0 ? 'primary' : 'ghost'}
                size="md"
                onClick={() => {
                  handleErrorMessageAction(action, {
                    sessionId,
                    connectionSlug,
                    onOpenUrl,
                    onRetry,
                  })
                }}
              >
                {action.label}{action.action === 'open_url' ? ' ↗' : ''}
              </Button>
            ))}
          </div>
        )}

        {/* Technical details, collapsed by default */}
        {hasDetails && (
          <div className="mt-2">
            <button
              type="button"
              onClick={() => setDetailsOpen(!detailsOpen)}
              aria-expanded={detailsOpen}
              className="-ml-1 inline-flex min-h-control-sm in-data-compact:min-h-9 items-center gap-1 rounded-xs px-1 text-label-sm text-secondary transition-colors duration-micro ease-out-subtle hover:text-foreground hover:duration-instant"
            >
              <motion.span
                initial={false}
                animate={{ rotate: detailsOpen ? 90 : 0 }}
                transition={SPRING.snap}
                className="flex"
              >
                <ChevronRight aria-hidden className="size-3" />
              </motion.span>
              <span>{detailsOpen ? t('chat.hideTechnicalDetails') : t('chat.showTechnicalDetails')}</span>
            </button>

            <AnimatedCollapsibleContent isOpen={detailsOpen} className="overflow-hidden">
              <div className="mt-1.5 space-y-0.5 rounded-sm bg-sunken px-2.5 py-2 font-mono text-mono-ui text-secondary wrap-anywhere">
                {message.errorDetails?.map((detail, i) => (
                  <div key={i}>{detail}</div>
                ))}
                {message.errorOriginal && !message.errorDetails?.some(d => d.includes('Raw error:')) && (
                  <div className="mt-1">{t('chat.errorRaw')}: {message.errorOriginal.slice(0, 200)}{message.errorOriginal.length > 200 ? '...' : ''}</div>
                )}
              </div>
            </AnimatedCollapsibleContent>
          </div>
        )}
      </div>
    </div>
  )
}
