import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import {
  setModelSupportsImages,
  type LlmConnection,
} from '@config/llm-connections'
import { useOptionalAppShellContext } from '@/context/AppShellContext'

export type ToggleModelVision = (
  connectionSlug: string,
  modelId: string,
  enabled: boolean,
) => Promise<void>

/**
 * What `setModelSupportsImages` did with the connection it was handed.
 *
 * `no-op` is the case P3.365 is about: the model id is not in
 * `connection.models` (or the connection declares no `models` at all), so the
 * override the user asked for was never written.
 */
export type VisionToggleOutcome =
  | { kind: 'no-op' }
  | { kind: 'write'; connection: LlmConnection }

/**
 * Decide whether a vision toggle actually wrote anything.
 *
 * **Identity is an EXACT discriminator, and that is not an accident of the
 * implementation — it is the only signal there is.** `setModelSupportsImages`
 * has two bare returns, `!connection.models` and `idx === -1`, and BOTH return
 * the input reference unchanged; its success path allocates
 * `{ ...connection, models: nextModels }`. Measured 2026-09-04 at HEAD, with a
 * positive control on the same rig:
 *
 * ```
 * arm1 !models    identity: true    (nothing written)
 * arm2 idx === -1 identity: true    (nothing written)
 * ctrl model present identity: false (supportsImages written)
 * ```
 *
 * Comparing the two objects by VALUE would be wrong in the other direction: a
 * toggle set to the value the model already carries produces a new object that
 * deep-equals the input, and that is a real write, not a no-op.
 *
 * Why this matters more than a missing toast: the flag decides whether images
 * reach the model at all (`filterAttachmentsForModelInput` moves every image to
 * `omittedImages` when it is false), and on `pi_compat` an undeclared model
 * defaults to `supportsImages: false`. So the exact condition that renders the
 * toggle OFF and raises the image-support warning banner is the condition that
 * makes the write a no-op — the control that stops controlling reports success,
 * and the state is self-reinforcing. `llm-connections.ts` is deliberately NOT
 * changed: a pure function returning its input unchanged for a model it was not
 * given is correct; the defect was the caller taking the success branch anyway.
 */
export function resolveVisionToggle(
  connection: LlmConnection,
  modelId: string,
  enabled: boolean,
): VisionToggleOutcome {
  const updated = setModelSupportsImages(connection, modelId, enabled)
  if (updated === connection) return { kind: 'no-op' }
  return { kind: 'write', connection: updated }
}

/**
 * Toggle per-model image support on a pi_compat (custom endpoint) connection.
 *
 * Same implementation as the inline callback that used to live in
 * `FreeFormInput.tsx` — extracted so the desktop dropdown and the compact
 * (drawer) model picker share one source of truth and stay aligned with
 * `setModelSupportsImages` / `modelSupportsImages` in `@config/llm-connections`.
 */
export function useModelVisionToggle(): ToggleModelVision {
  const { t } = useTranslation()
  const appShellCtx = useOptionalAppShellContext()
  const llmConnections = appShellCtx?.llmConnections ?? []
  const refreshLlmConnections = appShellCtx?.refreshLlmConnections

  return React.useCallback(async (connectionSlug, modelId, enabled) => {
    if (!window.electronAPI) return
    const conn = llmConnections.find(c => c.slug === connectionSlug)
    if (!conn) return
    try {
      const { isAuthenticated: _a, authError: _b, isDefault: _c, ...bare } = conn
      const outcome = resolveVisionToggle(bare as LlmConnection, modelId, enabled)
      if (outcome.kind === 'no-op') {
        // Saving here would round-trip the connection unchanged and take the
        // success branch — the toggle would report success while writing
        // nothing, and the banner that raised it would raise it again forever.
        console.error(
          'Failed to toggle model vision: model is not listed on the connection',
          { connectionSlug, modelId },
        )
        toast.error(t('chat.modelPicker.toggleVisionFailed'))
        return
      }
      const result = await window.electronAPI.saveLlmConnection(outcome.connection)
      if (!result.success) {
        console.error('Failed to toggle model vision:', result.error)
        toast.error(t('chat.modelPicker.toggleVisionFailed'))
        return
      }
      await refreshLlmConnections?.()
    } catch (error) {
      console.error('Failed to toggle model vision:', error)
      toast.error(t('chat.modelPicker.toggleVisionFailed'))
    }
  }, [llmConnections, refreshLlmConnections, t])
}
