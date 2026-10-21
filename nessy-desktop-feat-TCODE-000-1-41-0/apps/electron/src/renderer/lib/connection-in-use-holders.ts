/**
 * D1.150 — `CONNECTION_IN_USE`'s holder names, rendered in the user's language.
 *
 * ## What was wrong, and it is sharper than the row states
 *
 * C3.368 appended the holder names to the refusal's MESSAGE as English prose
 * (`… used by Chat A, Chat B and 3 more`). On the onboarding path that string is
 * printed verbatim, so a Russian user read an English sentence. On the SETTINGS
 * path — the one with the Delete button — it was worse: `AiSettingsPage`
 * discards the server message entirely and renders `settings.ai.connectionInUse`
 * plus `…Desc`, so the names reached nobody at all. That is why D1.150 asked for
 * a wire FIELD rather than a better string: a translation cannot supply
 * user-authored names, and a message cannot be translated.
 *
 * `ConnectionInUseData` (`@nessy-agent/shared/protocol`) is that field. The
 * names arrive as two bounded lists plus the two tail COUNTS the sender left
 * out, so the "and N more" clause is built here, in the reader's own language,
 * instead of being read back out of English.
 *
 * ## The residue, stated rather than discovered
 *
 * At the time of writing ONE sending hop on the desktop path still drops
 * `WireError.data`: `sendResponseError` in
 * `packages/server-core/src/transport/server.ts`. The receiving half of
 * `transport/client.ts` already copies it onto the rebuilt error, and the
 * Electron bridge carries it since D1.150's renderer half
 * (`apps/electron/src/shared/rpc-error.ts`), so that one field is the whole
 * remainder. Until it lands this module answers `null` on every real refusal and
 * the toast reads exactly as it does today — which is why the caller treats the
 * lines as an ADDITION to the existing copy rather than a replacement for it.
 *
 * ## Why a parser and not a cast
 *
 * The value crosses two rebuild seams and a structured clone, and it is
 * `unknown` at both. A cast would put a `.map` on whatever arrived; a refusal
 * that threw while being rendered would hide the refusal itself. Every field is
 * checked, a malformed payload answers `null`, and the caller then shows the
 * sentence it always showed.
 */

import type { ConnectionInUseData } from '@nessy-agent/shared/protocol'

/** How many names are worth printing in a toast before the tail takes over. */
const MAX_RENDERED_NAMES = 3

function stringList(value: unknown): readonly string[] | null {
  if (!Array.isArray(value)) return null
  return value.every(entry => typeof entry === 'string') ? (value as readonly string[]) : null
}

function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

/**
 * The payload, or `null` for anything that is not one.
 *
 * Exported so the caller can narrow once and the test can drive the parse
 * directly — the toast itself is not reachable without an Electron window.
 */
export function parseConnectionInUseData(value: unknown): ConnectionInUseData | null {
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  const sessions = stringList(record.sessions)
  const automations = stringList(record.automations)
  const moreSessions = count(record.moreSessions)
  const moreAutomations = count(record.moreAutomations)
  if (sessions === null || automations === null) return null
  if (moreSessions === null || moreAutomations === null) return null
  return { sessions, automations, moreSessions, moreAutomations }
}

function group(
  names: readonly string[],
  more: number,
  labelKey: string,
  t: (key: string, options?: Record<string, unknown>) => string,
): string | null {
  if (names.length === 0 && more === 0) return null
  // The sender already bounded the lists; this bound is the TOAST's, and the
  // overflow joins the tail rather than being dropped, so the count a user
  // reads always adds up to what the server refused for.
  const shown = names.slice(0, MAX_RENDERED_NAMES)
  const tail = more + (names.length - shown.length)
  const parts = shown.length > 0 ? [shown.join(', ')] : []
  if (tail > 0) parts.push(t('settings.ai.connectionInUseMore', { count: tail }))
  if (parts.length === 0) return null
  return t(labelKey, { names: parts.join(' ') })
}

/**
 * The two lines to add under the refusal's own sentence, or `null` when the
 * payload names nobody — which is also what a missing or malformed field gives.
 *
 * The LABELS are the renderer's and are translated; the NAMES are the user's own
 * and are printed verbatim. That split is the whole point of the wire field.
 */
export function describeConnectionInUseHolders(
  value: unknown,
  t: (key: string, options?: Record<string, unknown>) => string,
): string | null {
  const data = parseConnectionInUseData(value)
  if (!data) return null
  const lines = [
    group(data.sessions, data.moreSessions, 'settings.ai.connectionInUseChats', t),
    group(data.automations, data.moreAutomations, 'settings.ai.connectionInUseTasks', t),
  ].filter((line): line is string => line !== null)
  return lines.length > 0 ? lines.join('\n') : null
}
