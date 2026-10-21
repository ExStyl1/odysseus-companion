/**
 * P6.536 — the one gate both browser powers ask.
 *
 * Navigation and the full-CDP attach are two different powers over the same
 * origin, and before this row both were an unconditional allow. They ask the
 * SAME function here — one managed check, one store lookup, one card — because
 * a second copy of this decision is how the per-site card and the CDP grant
 * would come to disagree about what the user approved.
 *
 * ## Fail CLOSED when there is no way to ask
 *
 * The card is raised by the pane manager, which owns the window it appears in,
 * so the prompter is registered rather than imported. When none is registered —
 * a headless server, a unit test, a boot order that never reached the pane
 * manager — an unknown origin is DENIED rather than allowed.
 *
 * That is the opposite of the usual "unregistered provider means no opinion"
 * convention next door in `managed-in-app-browser.ts`, and deliberately so: that
 * one governs whether a FEATURE is available and its safe default is "available",
 * whereas this one governs an egress path and a debugger attach, whose safe
 * default is "not without an answer". A registration this row forgot would
 * otherwise reproduce exactly the ungoverned state it exists to close.
 */

import { CodedError } from '@nessy-agent/shared/protocol/types'
import {
  isBrowserCdpManagedDisabled,
  resolveManagedBrowserNavigationRefusal,
  type ManagedBrowserNavigationActorV1,
} from '@nessy-agent/shared/config/managed-in-app-browser'
import type { BrowserTrustGate, BrowserTrustVerdict } from '@nessy-agent/shared/config/browser-origin-trust'
import {
  browserTrustDecisionFor,
  noteBrowserOriginVisited,
  recordBrowserTrustDecision,
} from './browser-origin-trust-store'
import { mainLog } from './logger'

export interface BrowserTrustPromptRequest {
  /** The pane the card belongs in. Absent means "no particular window". */
  instanceId?: string | undefined
  origin: string
  gate: BrowserTrustGate
  url: string
}

export type BrowserTrustPrompter =
  (request: BrowserTrustPromptRequest) => Promise<BrowserTrustVerdict>

let prompter: BrowserTrustPrompter | undefined

/** The pane manager registers the card; a test may register a stub. */
export function registerBrowserTrustPrompter(next: BrowserTrustPrompter | undefined): void {
  prompter = next
}

export interface BrowserTrustGrant {
  allowed: boolean
  /** Why not, when not — so the refusal names the right remedy. */
  reason?: 'managed' | 'denied' | 'unanswerable'
  origin?: string | undefined
  /**
   * P6.338 — the administrator's own sentence, when an administrator is the
   * reason. Three managed keys can refuse a navigation and they are remediated
   * in three different places, so one generic "your policy does not allow this"
   * would send the reader to the wrong one.
   */
  managedMessage?: string
}

/**
 * Decide whether one power over one URL may proceed, asking the user once.
 *
 * The order is not negotiable and each step is a different authority:
 *
 * 1. **The administrator** — only for `cdp`, and only its OWN switch. The pane's
 *    `disableInAppBrowser` is not consulted here because a forbidden pane never
 *    opens, so there is no page for either gate to run over.
 * 2. **The stored verdict**, including this process's allow-once grants.
 * 3. **The person**, once, through the card.
 *
 * A user who has to be asked and cannot be is refused (see the module docblock).
 */
export async function requireBrowserTrust(
  url: string,
  gate: BrowserTrustGate,
  context: {
    instanceId?: string | undefined
    /**
     * P6.338 — who is driving. `browserExternalPageTools` refuses the AGENT and
     * deliberately leaves the person's own browsing alone, so this gate cannot
     * answer it without the term. Defaults to `person`, the reading that
     * refuses less: a caller that forgot to say must not have its user's
     * browsing blocked by a key about Claude's tools.
     */
    actor?: ManagedBrowserNavigationActorV1 | undefined
  } = {},
): Promise<BrowserTrustGrant> {
  if (gate === 'cdp' && isBrowserCdpManagedDisabled()) {
    return { allowed: false, reason: 'managed' }
  }
  // P6.338 — the graded navigation locks, at step 1 with the CDP switch and for
  // the same reason: an administrator's answer outranks a stored "Always allow"
  // this user gave before the policy arrived. The converse also holds and is
  // the point of putting the locks HERE rather than beside the store — being on
  // the operator's allowlist does not skip the card below.
  if (gate === 'navigation') {
    const managedMessage = resolveManagedBrowserNavigationRefusal(url, context.actor ?? 'person')
    if (managedMessage) {
      const { origin } = browserTrustDecisionFor(url, gate)
      return { allowed: false, reason: 'managed', origin, managedMessage }
    }
  }

  const { origin, decision } = browserTrustDecisionFor(url, gate)
  if (!origin) return { allowed: true }
  if (decision === 'allow') return { allowed: true, origin }
  if (decision === 'deny') return { allowed: false, reason: 'denied', origin }

  if (!prompter) {
    mainLog.warn(
      `[browser-trust] refusing ${gate} for ${origin}: no prompter is registered, `
      + 'so the user cannot be asked. This gate fails closed by design.',
    )
    return { allowed: false, reason: 'unanswerable', origin }
  }

  let verdict: BrowserTrustVerdict
  try {
    verdict = await prompter({ instanceId: context.instanceId, origin, gate, url })
  } catch (err) {
    // A card that failed to appear, or a window closed under it, is an
    // unanswered question — not a yes.
    mainLog.warn(`[browser-trust] prompt for ${gate} on ${origin} failed: ${String(err)}`)
    return { allowed: false, reason: 'unanswerable', origin }
  }

  recordBrowserTrustDecision(origin, gate, verdict)
  if (verdict === 'deny') return { allowed: false, reason: 'denied', origin }
  return { allowed: true, origin }
}

/**
 * The same decision, as a throw — the shape the CDP attach path needs, because
 * `ensureAttached` has no way to return a refusal to its dozen callers.
 *
 * `BROWSER_CDP_DENIED` is its own code beside `BROWSER_MANAGED_DISABLED`, for
 * the reason that one records: a receiver can TRANSLATE a coded refusal instead
 * of surfacing an English string to a user in another locale.
 */
export async function requireBrowserTrustOrThrow(
  url: string,
  gate: BrowserTrustGate,
  context: {
    instanceId?: string | undefined
    actor?: ManagedBrowserNavigationActorV1 | undefined
  } = {},
): Promise<void> {
  const grant = await requireBrowserTrust(url, gate, context)
  if (grant.allowed) {
    if (gate === 'navigation') noteBrowserOriginVisited(url)
    return
  }
  const subject = grant.origin ?? url
  // P6.338 — the managed sentence when the lock supplied one, because three
  // keys refuse a navigation and each is fixed in a different line of the same
  // document. The CDP switch supplies none and keeps its own wording.
  const message = grant.managedMessage
    ?? (grant.reason === 'managed'
    ? `Your organization's policy does not allow the built-in browser's DevTools debugger (${subject}).`
    : grant.reason === 'unanswerable'
      ? `Cannot ask permission for ${subject}, so the ${gate === 'cdp' ? 'debugger attach' : 'navigation'} was refused.`
      : `${subject} is not allowed for ${gate === 'cdp' ? 'the DevTools debugger' : 'browsing'}.`)
  throw new CodedError(gate === 'cdp' ? 'BROWSER_CDP_DENIED' : 'BROWSER_ORIGIN_DENIED', message)
}
