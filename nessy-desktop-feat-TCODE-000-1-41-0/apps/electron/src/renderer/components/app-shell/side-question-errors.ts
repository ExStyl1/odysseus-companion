/**
 * D1.398, half two — a `/btw` answer that FAILED says a sentence, never a code.
 *
 * OWNER, 2026-09-19, screenshot: the panel showed a red bubble reading
 * `agent-not-started`. Half one of the row removed that particular failure (a
 * chat with no agent now starts one — `SessionManager.withSideChannelAgent`),
 * but the shape of the defect was wider than the code: `SideQuestionResult`
 * and `SessionRecapResult` are typed-error results by contract — the DTO calls
 * the codes "stable identifiers" — and the panel rendered `error` verbatim as
 * the text of a `role: 'error'` message. ANY failure therefore reached the user
 * as a machine token.
 *
 * So: one sentence per code, in both locales, and the mapping lives here rather
 * than in the panel because a key spelled by concatenation
 * (`` `chat.sideQuestion.error.${code}` ``) is invisible to
 * `lint:i18n:reachable`, which enumerates READERS by literal text — the keys
 * would read as unreachable the day they landed. Every key below is written out
 * in full for that reason, and the codes are hyphenated while the keys are
 * camelCase, which is this tree's own spelling on both sides.
 *
 * WHAT IS NOT MAPPED IS NOT SWALLOWED. The catch arms of both server methods
 * return the PROVIDER's own message (`error.message`), which is a sentence
 * already and often the only thing that says what went wrong — a rate limit, a
 * refused credential. Those fall to the generic sentence with the raw text kept
 * beside it as a detail, rather than being replaced by it: the user gets a
 * sentence AND the diagnostic, which is what makes this a translation rather
 * than a redaction.
 */

import type { SideQuestionErrorCode } from '@nessy-agent/shared/protocol'

/**
 * Every code the two server methods return as a LITERAL, mapped to its
 * sentence. Pinned against `SessionManager.ts`'s own source in this module's
 * test, so a code added there without a sentence here goes red rather than
 * reaching a user as a token.
 *
 * `unknown-error` is the renderer's own: `FreeFormInput` mints it when a result
 * comes back unsuccessful with no `error` at all, which is exactly the generic
 * case — so it maps to the generic sentence instead of earning a key of its own.
 */
const SIDE_QUESTION_ERROR_KEYS: Readonly<Record<SideQuestionErrorCode, string>> = {
  'session-not-found': 'chat.sideQuestion.error.sessionNotFound',
  'empty-question': 'chat.sideQuestion.error.emptyQuestion',
  'empty-answer': 'chat.sideQuestion.error.emptyAnswer',
  'agent-start-failed': 'chat.sideQuestion.error.agentStartFailed',
  'empty-session': 'chat.sideQuestion.error.emptySession',
  'recap-unavailable': 'chat.sideQuestion.error.recapUnavailable',
  'unknown-error': 'chat.sideQuestion.error.generic',
}

/** The sentence for anything the map above does not name. */
export const SIDE_QUESTION_GENERIC_ERROR_KEY = 'chat.sideQuestion.error.generic'

/** The codes with a sentence of their own — the test's census reads this. */
export const SIDE_QUESTION_ERROR_CODES: readonly SideQuestionErrorCode[] =
  Object.keys(SIDE_QUESTION_ERROR_KEYS) as SideQuestionErrorCode[]

export interface SideQuestionErrorDisplay {
  /** The i18n key of the sentence to show. Never a code. */
  key: string
  /**
   * The server's own words, present ONLY when they were not one of the mapped
   * codes — i.e. a provider message worth keeping under the sentence. Never a
   * code, because a mapped code is fully replaced by its sentence.
   */
  detail?: string
}

/**
 * The sentence (and optional provider detail) for one `error` field of a
 * {@link SideQuestionResult} or {@link SessionRecapResult}.
 */
export function sideQuestionErrorDisplay(error: string | undefined): SideQuestionErrorDisplay {
  const raw = (error ?? '').trim()
  // The wire carries a `string` — a code OR a provider's own sentence — so the
  // lookup is widened here rather than the map, which must stay TOTAL over the
  // union for the type gate F1.95 added to mean anything.
  const mapped = (SIDE_QUESTION_ERROR_KEYS as Readonly<Record<string, string | undefined>>)[raw]
  if (mapped) return { key: mapped }
  if (!raw) return { key: SIDE_QUESTION_GENERIC_ERROR_KEY }
  return { key: SIDE_QUESTION_GENERIC_ERROR_KEY, detail: raw }
}
