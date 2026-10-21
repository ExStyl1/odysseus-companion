/**
 * D1.254 — what `AiSettingsPage` does about the connection its ROUTE names.
 *
 * A module of its own, and not four lines inside the effect, for the reason this
 * renderer's other decisions are functions too: there is no DOM harness for
 * hooks here, so a rule that lives inside a `useEffect` is a rule only a source
 * read can check — and a source read cannot tell a rule that fires once from a
 * rule that fires on every render.
 *
 * It deliberately does NOT reach for the page's own module: importing
 * `AiSettingsPage` pulls the `@nessy-agent/ui` barrel and its pdfjs `?url`
 * chain, which is why its siblings (`byo-runtime.ts`,
 * `permissions-cross-scope.ts`) are separate modules as well.
 */

import { isNessyGatewayBaseUrl } from '@/components/apisetup/nessy-gateway'

/** The subset of a connection this decision reads. */
export interface RouteConnectionCandidate {
  slug: string
  authType?: string
  baseUrl?: string
}

export type RouteConnectionAction<T extends RouteConnectionCandidate> =
  /** Nothing to do: no connection is named, or this one has already been acted on, or it is not in the list. */
  | { kind: 'idle' }
  /** The segment is gone — forget what was consumed, so the SAME connection can be named again. */
  | { kind: 'forget' }
  /** A gateway-backed connection: the one-click dp flow, no form. */
  | { kind: 'gateway'; connection: T }
  /** Everything else: open this connection's setup (which starts OAuth by itself for an OAuth row). */
  | { kind: 'setup'; connection: T }

/**
 * Decide what a route-named connection should trigger.
 *
 * Three rules, each of which has a way to be wrong:
 *
 *  - **Once per naming.** `consumed` is the slug this page has already acted on.
 *    Without it the effect would re-fire on every unrelated re-render and the
 *    user could not close the overlay; with it, and with the page dropping the
 *    segment afterwards, pressing the same button again works.
 *  - **An unknown slug does nothing**, and that is not the same as an error:
 *    the connection list arrives asynchronously, so "not in the list" means "not
 *    loaded yet" as often as it means "deleted", and the caller re-runs when the
 *    list lands.
 *  - **A gateway-backed connection takes the one-click path**, the same decision
 *    the credential-health banner makes through `computeGatewayReconnectItem`:
 *    it has no form to fill in, so opening the setup overlay for one would show
 *    a form whose only honest answer is "press Reconnect".
 */
export function resolveRouteConnectionAction<T extends RouteConnectionCandidate>(
  connectionSlug: string | undefined,
  consumed: string | null,
  connections: readonly T[],
): RouteConnectionAction<T> {
  if (!connectionSlug) return { kind: 'forget' }
  if (consumed === connectionSlug) return { kind: 'idle' }
  const connection = connections.find(candidate => candidate.slug === connectionSlug)
  if (!connection) return { kind: 'idle' }
  // `computeGatewayReconnectItem`'s own two terms, in its order: an OAuth row
  // keeps its own re-authenticate path even on a gateway URL.
  if (connection.authType !== 'oauth' && isNessyGatewayBaseUrl(connection.baseUrl)) {
    return { kind: 'gateway', connection }
  }
  return { kind: 'setup', connection }
}
