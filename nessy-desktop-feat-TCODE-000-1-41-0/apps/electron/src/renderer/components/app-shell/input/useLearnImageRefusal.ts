import * as React from 'react'
import {
  imageRefusalSentenceFromErrorDetails,
  learnImageRefusal,
  modelImageRefusalSentence,
  type LlmConnection,
} from '@config/llm-connections'
import { useOptionalAppShellContext } from '@/context/AppShellContext'

/**
 * What a turn error did to the connection catalogue.
 *
 * `skip` is by far the common case and is deliberately the same verdict for
 * three different reasons — no anchored refusal in the error, the model already
 * carries a person's explicit declaration, or the identical sentence is already
 * stored. The caller does nothing in all three, and none of them is an error.
 */
export type LearnImageRefusalOutcome =
  | { kind: 'skip' }
  | { kind: 'write'; connection: LlmConnection; sentence: string }

/**
 * P6.584 — the learned image-refusal writer's decision, as a pure function.
 *
 * Owner ruling Q12 of 2026-09-05 is **B narrowly**, and every clause of it is a
 * condition here rather than a note:
 *
 * - **LEARNED, never declared.** The write goes through `learnImageRefusal`,
 *   which refuses a model that carries an explicit `supportsImages` — a
 *   person's answer, in either direction, outranks a sentence we matched.
 * - **Never on a generic 400.** The only input is the ANCHORED detail line
 *   (`IMAGE_REFUSAL_DETAIL_PREFIX`), which the turn-error seam writes only for
 *   a message `isNamedImageRefusal` accepted. An error with no anchor produces
 *   `skip`, so nothing is learned from `Bad Request`.
 * - **Once.** A sentence identical to the stored one is `skip`, so a repeated
 *   refusal does not round-trip the connection through storage on every turn.
 * - **Reversible through the existing P3.136 toggle.** No new reversal path is
 *   built: `setModelSupportsImages` clears `supportsImagesLearnedFrom` on every
 *   write that does not carry one, and the composer's "Enable image support"
 *   action is exactly such a write.
 *
 * Why the renderer and not the server: the sentence is seen at the turn-error
 * seam in `packages/shared/src/agent/claude-sdk-error-mapper.ts`, but the
 * connection is SAVED by the renderer (`saveLlmConnection`), which already
 * exists — so the row needs no new RPC, no new wire field and no change to
 * `Message`. `AgentError.details` already crosses verbatim as
 * `Message.errorDetails`.
 */
export function resolveLearnImageRefusal(
  connection: LlmConnection,
  modelId: string,
  errorDetails: readonly string[] | null | undefined,
): LearnImageRefusalOutcome {
  const sentence = imageRefusalSentenceFromErrorDetails(errorDetails)
  if (!sentence) return { kind: 'skip' }
  if (modelImageRefusalSentence(connection, modelId) === sentence) return { kind: 'skip' }
  const { connection: next, learned } = learnImageRefusal(connection, modelId, sentence)
  if (!learned) return { kind: 'skip' }
  return { kind: 'write', connection: next, sentence }
}

export type LearnImageRefusal = (
  connectionSlug: string,
  modelId: string,
  errorDetails: readonly string[] | null | undefined,
) => Promise<void>

/**
 * Apply {@link resolveLearnImageRefusal} through the connection save the
 * renderer already owns.
 *
 * Shaped after `useModelVisionToggle` on purpose — the same catalogue, the same
 * `saveLlmConnection` round-trip, the same refresh — so the learned write and
 * the manual toggle can never drift into two ways of writing one field. The
 * one difference is silence: a failure here is logged and dropped rather than
 * toasted, because the user did not ask for this write and a toast about it
 * would be a second error card for one failed turn.
 */
export function useLearnImageRefusal(): LearnImageRefusal {
  const appShellCtx = useOptionalAppShellContext()
  const llmConnections = appShellCtx?.llmConnections ?? []
  const refreshLlmConnections = appShellCtx?.refreshLlmConnections

  return React.useCallback(async (connectionSlug, modelId, errorDetails) => {
    if (!window.electronAPI) return
    const conn = llmConnections.find(c => c.slug === connectionSlug)
    if (!conn) return
    try {
      const { isAuthenticated: _a, authError: _b, isDefault: _c, ...bare } = conn
      const outcome = resolveLearnImageRefusal(bare as LlmConnection, modelId, errorDetails)
      if (outcome.kind === 'skip') return
      const result = await window.electronAPI.saveLlmConnection(outcome.connection)
      if (!result.success) {
        console.error('Failed to record the endpoint image refusal:', result.error)
        return
      }
      await refreshLlmConnections?.()
    } catch (error) {
      console.error('Failed to record the endpoint image refusal:', error)
    }
  }, [llmConnections, refreshLlmConnections])
}
