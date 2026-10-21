/**
 * P6.411 — the session-scoped capability inventory: what is active in this chat
 * and what its capability resolution deliberately withheld, with the reason.
 *
 * Before this the answer existed and reached nobody. `toAgentRuntime` records
 * every withheld entry with the FIRST test that rejected it (`9ad1c13d9`), the
 * session retains it (`5b39f00c2`) and `ISessionManager.getSessionCapability-
 * Inventory` reads it back (`d1b7ae0bb`) — and no renderer route existed, so a
 * session could not say which of its plugins actually loaded and which silently
 * did not.
 *
 * IDENTICAL ON ALL THREE RUNTIMES BY CONSTRUCTION, not by agreement:
 * `toAgentRuntime` is the single point Pi, claude and codex converge on, so one
 * surface here cannot describe them differently.
 *
 * The two halves come from DIFFERENT places on purpose. The WITHHELD half is
 * the new RPC. The ACTIVE half is the capability catalog the renderer already
 * reads, minus the withheld keys — a second server-side copy of the loaded list
 * would be a second thing to keep in step with the catalog, which is the shape
 * of the defect this row's own evidence is made of.
 *
 * The `reason` is a VALUE (`disabled` / `review-required` / `blocked` /
 * `unsupported-runtime`), never a sentence: the wording and the locale keys are
 * this file's.
 *
 * WHERE IT MOUNTS: `ChatDisplay`'s system-card stack, beside `PendingAuthNotice`
 * and `TaskChecklistPanel` — the same chat width and card body, because this is
 * a statement about THIS session and not about the workspace. C3.245 put the
 * two of them inside one `ChatNoticeRegion`, which is bounded and scrolls; this
 * card's header is `stickyHeader` so its dismiss `x` stays reachable there.
 *
 * C3.245 — THE DEFAULT SHAPE IS TWO LINES. Owner screenshot 2026-09-11: the
 * active roster was a comma-joined sentence over every capability in the
 * catalogue and the withheld set a row each, so on a real workspace this card
 * covered the conversation and the composer and could not be scrolled. The
 * counts are now the card and the names are one click away; nothing was
 * removed.
 *
 * Positive control: a session that withheld nothing renders NOTHING. The card
 * exists to report an omission; with no omission there is nothing to report,
 * and the active list alone is already on the capability pages.
 */

import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { X } from 'lucide-react'
import { PANEL_HEADER_BUTTON_CLASS } from '@/components/ui/panel-header-button-style.ts'
import { SystemCard } from '@/components/ui/system-card'
import type { RuntimeWithheldCapability } from '../../../shared/types'
import type { SafeCapabilitySummary } from '@nessy-agent/shared/protocol/capabilities'
import { isRendererMintedSessionId } from './input/stub-session'

/**
 * The three fields this surface reads off a catalog row, and no more.
 *
 * Narrowed deliberately: the card names capabilities, it does not render their
 * state, trust or diagnostics, and a prop typed as the whole
 * `SafeCapabilitySummary` would make every test and playground fixture carry
 * nine fields the component never looks at.
 */
export type CapabilityNameRow = Pick<SafeCapabilitySummary, 'key' | 'logicalName' | 'displayName'>

/** The locale key for a withheld reason. Total over the four values. */
export function withheldReasonKey(reason: RuntimeWithheldCapability['reason']): string {
  switch (reason) {
    case 'disabled': return 'sessionCapabilities.reasonDisabled'
    case 'review-required': return 'sessionCapabilities.reasonReviewRequired'
    case 'blocked': return 'sessionCapabilities.reasonBlocked'
    case 'unsupported-runtime': return 'sessionCapabilities.reasonUnsupportedRuntime'
  }
}

/**
 * What is ACTIVE this session: every capability the catalog carries whose key
 * is not in the withheld record.
 *
 * Derived rather than fetched, so the two halves cannot disagree about a single
 * capability — the withheld set is subtracted from the same list the capability
 * pages render, instead of being compared against a second server-side copy.
 */
export function activeCapabilityNames(
  capabilities: readonly CapabilityNameRow[] | undefined,
  withheld: readonly RuntimeWithheldCapability[],
): string[] {
  const withheldKeys = new Set(withheld.map(entry => entry.key))
  return (capabilities ?? [])
    .filter(capability => !withheldKeys.has(capability.key))
    .map(capability => capability.displayName ?? capability.logicalName)
}

export interface SessionCapabilityInventoryViewProps {
  withheld: readonly RuntimeWithheldCapability[]
  capabilities?: readonly CapabilityNameRow[]
  onDismiss: () => void
  /**
   * C3.245 — start with the roster open. The card's own default is CLOSED; this
   * exists so the open state is renderable without a click, which is the only
   * way this tree can assert it (static markup, no DOM harness) and the knob
   * the playground needs to show both shapes of one card.
   */
  defaultExpanded?: boolean
}

/** The pure view — what the tests and the playground render. */
export function SessionCapabilityInventoryView({
  withheld,
  capabilities,
  onDismiss,
  defaultExpanded = false,
}: SessionCapabilityInventoryViewProps) {
  const { t } = useTranslation()
  // C3.245 · before the early return, because a hook after a conditional return
  // is a hook that does not run on every render.
  const [expanded, setExpanded] = useState(defaultExpanded)
  // The positive control lives here, not at the mount: nothing withheld means
  // nothing to report, whatever the caller passes.
  if (withheld.length === 0) return null

  const activeNames = activeCapabilityNames(capabilities, withheld)

  return (
    <SystemCard
      className="select-none"
      data-testid="session-capability-inventory"
      title={t('sessionCapabilities.title')}
      titleClassName="text-foreground"
      stickyHeader
      meta={
        <button
          type="button"
          className={PANEL_HEADER_BUTTON_CLASS}
          onClick={onDismiss}
          aria-label={t('sessionCapabilities.dismiss')}
        >
          <X className="h-4 w-4" />
        </button>
      }
    >
      <div className="space-y-1 text-muted-foreground">
        {/*
          C3.245 · the default shape is this ONE line, and the lists are behind
          it. Owner screenshot 2026-09-11: a session with a full catalogue put
          every active capability in a comma-joined sentence and every withheld
          one on a row of its own, and the card grew over the conversation and
          the composer. The counts are the part that is always worth reading —
          "how many loaded, how many did not" — and the names are the part you
          go looking for, so the names are the click.
        */}
        <button
          type="button"
          onClick={() => setExpanded(value => !value)}
          aria-expanded={expanded}
          aria-controls="session-capability-details"
          data-testid="session-capability-summary"
          className="text-left underline-offset-2 hover:underline"
        >
          {t(expanded ? 'sessionCapabilities.summaryHide' : 'sessionCapabilities.summaryShow', {
            active: activeNames.length,
            withheld: withheld.length,
          })}
        </button>
        {expanded && (
          <div id="session-capability-details" className="space-y-1">
            <div data-testid="session-capability-active">
              {activeNames.length > 0
                ? t('sessionCapabilities.activeList', { names: activeNames.join(', ') })
                : t('sessionCapabilities.activeNone')}
            </div>
            <div className="font-medium text-foreground/70">{t('sessionCapabilities.withheldHeading')}</div>
            <ul className="space-y-0.5">
              {withheld.map(entry => (
                <li key={entry.key} data-testid={`session-capability-withheld-${entry.key}`}>
                  {t('sessionCapabilities.withheldRow', {
                    name: entry.logicalName,
                    reason: t(withheldReasonKey(entry.reason)),
                  })}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </SystemCard>
  )
}

export interface SessionCapabilityInventoryNoticeProps {
  sessionId: string
  capabilities?: readonly CapabilityNameRow[]
  /** F1.1258 — the session's `isProcessing`; the read runs again when it changes (see {@link inventoryReadPhase}). */
  isProcessing?: boolean
}

/**
 * F1.1258 (origin SIT2-a D-11) — one of the wrapper's read keys. A brand-new chat resolves its capabilities at its
 * FIRST send (`toAgentRuntime`), after the mount's read already answered `[]`, and no `capabilities_changed` follows,
 * so the card appeared only once the chat was re-opened. Keyed on the turn phase, the read runs again when a turn
 * starts and when it ends — the end is the first moment the first turn's answer exists. A chat with no turn stays
 * one phase and reads once. (The alternative, a host `capabilities_changed` after the first build, would make every
 * capability page re-fetch its catalog for one session's answer.)
 */
export function inventoryReadPhase(isProcessing: boolean | undefined): 'turn' | 'idle' {
  return isProcessing === true ? 'turn' : 'idle'
}

/**
 * The data-fetching wrapper. Reads once per session, again whenever the
 * capability catalog changes generation, because that is exactly when the
 * withheld set can move, and again at a turn's edges (F1.1258); the dismissal
 * is per session id, so switching chats shows the new session's own answer.
 */
export function SessionCapabilityInventoryNotice({
  sessionId,
  capabilities,
  isProcessing,
}: SessionCapabilityInventoryNoticeProps) {
  const readPhase = inventoryReadPhase(isProcessing)
  const [withheld, setWithheld] = useState<readonly RuntimeWithheldCapability[]>([])
  const [dismissedFor, setDismissedFor] = useState<string | null>(null)

  useEffect(() => {
    // F1.167 — a renderer-minted id (`EditPopover`'s stub, the `/btw` panel's
    // synthetic id) has no host session to have withheld anything from, so the
    // answer is known without the round trip: the host's own is `[]` for an
    // unknown id. The subscription goes too — there is nothing to re-read.
    if (isRendererMintedSessionId(sessionId)) {
      setWithheld([])
      return
    }
    let cancelled = false
    const read = async () => {
      try {
        const answer = await window.electronAPI.getSessionCapabilityInventory(sessionId)
        if (!cancelled) setWithheld(answer)
      } catch {
        // Fail-soft: a read that could not be answered must not replace the
        // conversation with an error card. The absence of the notice is the
        // same statement the empty answer would make.
        if (!cancelled) setWithheld([])
      }
    }
    void read()
    const unsubscribe = window.electronAPI.capabilities.onChanged(() => { void read() })
    return () => { cancelled = true; unsubscribe() }
  }, [sessionId, readPhase])

  if (dismissedFor === sessionId) return null

  return (
    <SessionCapabilityInventoryView
      withheld={withheld}
      {...(capabilities ? { capabilities } : {})}
      onDismiss={() => setDismissedFor(sessionId)}
    />
  )
}
