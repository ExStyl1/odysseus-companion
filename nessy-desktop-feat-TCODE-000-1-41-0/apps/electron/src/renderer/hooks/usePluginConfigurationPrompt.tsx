/**
 * The enable-time configuration prompt, as one controller (D15).
 *
 * `plugins/components.md#when-the-configuration-dialog-appears` — "The `userConfig` field declares values that
 * Claude Code prompts the user for when the plugin is enabled." There is more
 * than one enable path in this renderer (the Sources panel rows and the plugin
 * detail page both go through `usePluginEnablement`; the marketplace page runs
 * its own confirm-enable mutation), and a prompt implemented per path is a
 * prompt that will be missing from the next one.
 *
 * So the decision — "did this enable return a status that still needs
 * configuration" — and the dialog live here, and each enable path calls
 * {@link PluginConfigurationPromptController.offer} with the result it just got
 * back and renders {@link PluginConfigurationPromptController.element}.
 */

import * as React from 'react'
import { toast } from 'sonner'
import { useTranslation } from 'react-i18next'
import {
  PluginConfigurationPrompt,
  type PluginConfigurationPromptState,
} from '@/components/plugins/PluginConfigurationPrompt'
import type { SafePluginManagementActionResult } from '@nessy-agent/shared/protocol/capabilities'

export interface PluginConfigurationPromptController {
  /**
   * Raise the prompt if this enable result says something is still unset.
   *
   * A plugin that declares no options, or whose options are all configured,
   * returns `state: 'ready'`/no status at all and enables silently — which is
   * the behaviour every plugin had before this existed.
   */
  offer: (
    result: SafePluginManagementActionResult | undefined,
    context: { pluginKey: string; workspaceId: string | null; displayName?: string },
  ) => void
  /** Render this once wherever the enable path lives. */
  element: React.ReactNode
}

export function usePluginConfigurationPrompt(
  onSaved?: () => Promise<void> | void,
): PluginConfigurationPromptController {
  const { t } = useTranslation()
  const [state, setState] = React.useState<PluginConfigurationPromptState | null>(null)

  const offer = React.useCallback((
    result: SafePluginManagementActionResult | undefined,
    context: { pluginKey: string; workspaceId: string | null; displayName?: string },
  ) => {
    const configuration = result?.configuration
    if (!configuration || configuration.state !== 'needs_configuration') return
    if (!context.workspaceId) return
    setState({
      pluginKey: context.pluginKey,
      workspaceId: context.workspaceId,
      configuration,
      ...(context.displayName ? { displayName: context.displayName } : {}),
    })
  }, [])

  const submit = React.useCallback(async (
    prompt: PluginConfigurationPromptState,
    values: Record<string, string | number | boolean>,
  ) => {
    // The one-way `configure` action the detail page already uses: values go in
    // and never come back, so nothing here holds a configured value once this
    // resolves.
    await window.electronAPI.plugin.manage({
      pluginKey: prompt.pluginKey,
      action: 'configure',
      workspaceId: prompt.workspaceId,
      values,
    })
    setState(null)
    toast.success(t('pluginDetail.configurationPromptSaved'))
    await onSaved?.()
  }, [onSaved, t])

  return {
    offer,
    element: (
      <PluginConfigurationPrompt
        state={state}
        onDismiss={() => setState(null)}
        onSubmit={submit}
      />
    ),
  }
}
