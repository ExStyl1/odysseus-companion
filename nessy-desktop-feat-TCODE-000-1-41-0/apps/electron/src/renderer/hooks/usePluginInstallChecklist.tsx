/**
 * The post-install checklist, as one controller (T3, plugin-install plan § 4).
 *
 * Mirrors `usePluginConfigurationPrompt`: each install path calls
 * {@link PluginInstallChecklistController.offer} with the RPC result it just
 * got back and renders {@link PluginInstallChecklistController.element}. The
 * decision "does this install still need anything" lives in
 * `derivePluginSetupChecklist`, so the tool path, the tests and the dialog can
 * never disagree about it.
 *
 * The dp sign-in action runs the SAME one-click system flow the gateway
 * banner and onboarding cards use (`ensureGatewayAuth` — `dp auth login`
 * behind the scenes), then triggers a value-only dp probe so the server-side
 * pool registry observes the ready boundary and restores the dp-backed
 * servers WITHOUT a chat message being sent. Nothing here interrupts a turn.
 */

import * as React from 'react'
import {
  derivePluginSetupChecklist,
  PluginInstallChecklist,
  type ChecklistDpState,
  type PluginInstallChecklistState,
} from '@/components/plugins/PluginInstallChecklist'
import type {
  SafeMarketplacePluginInstallResult,
  SafePluginConfigurationStatus,
} from '@nessy-agent/shared/protocol/capabilities'

export interface PluginInstallChecklistController {
  /** Raise the checklist if this install result says something is unfinished. */
  offer: (
    result: SafeMarketplacePluginInstallResult | undefined,
    context: { pluginKey?: string; workspaceId: string | null; displayName?: string },
  ) => void
  /** Render this once wherever the install path lives. */
  element: React.ReactNode
}

export function usePluginInstallChecklist(options: {
  /** Open the enable-time configuration prompt for the plugin. */
  onConfigure: (context: {
    pluginKey: string
    workspaceId: string
    displayName?: string
    configuration: SafePluginConfigurationStatus
  }) => void
  /** Called after a completed dp sign-in so plugin/source state refreshes. */
  onAuthCompleted?: () => Promise<void> | void
}): PluginInstallChecklistController {
  const [state, setState] = React.useState<PluginInstallChecklistState | null>(null)
  const [dpState, setDpState] = React.useState<ChecklistDpState>('pending')
  const { onConfigure, onAuthCompleted } = options

  const offer = React.useCallback((
    result: SafeMarketplacePluginInstallResult | undefined,
    context: { pluginKey?: string; workspaceId: string | null; displayName?: string },
  ) => {
    if (!result || !context.pluginKey || !context.workspaceId) return
    const checklist = derivePluginSetupChecklist(result)
    if (!checklist) return
    setDpState('pending')
    setState({
      pluginKey: context.pluginKey,
      workspaceId: context.workspaceId,
      checklist,
      ...(context.displayName ? { displayName: context.displayName } : {}),
    })
  }, [])

  const signInDp = React.useCallback(async () => {
    setDpState('busy')
    try {
      const result = await window.electronAPI.ensureGatewayAuth?.()
      if (!result?.ok) {
        setDpState('error')
        return
      }
      // Value-only probe: publishes the dp ready boundary server-side, which
      // re-materializes and reconnects the dp-backed servers — the "flips nine
      // servers to available without sending a chat message" half of the gate.
      await window.electronAPI.probeDpSession?.()
      setDpState('done')
      await onAuthCompleted?.()
    } catch {
      setDpState('error')
    }
  }, [onAuthCompleted])

  const configure = React.useCallback((current: PluginInstallChecklistState) => {
    const configuration = current.checklist.userConfig?.configuration
    if (!configuration) return
    onConfigure({
      pluginKey: current.pluginKey,
      workspaceId: current.workspaceId,
      configuration,
      ...(current.displayName ? { displayName: current.displayName } : {}),
    })
  }, [onConfigure])

  return {
    offer,
    element: (
      <PluginInstallChecklist
        state={state}
        dpState={dpState}
        onDismiss={() => setState(null)}
        onDpSignIn={() => { void signInDp() }}
        onConfigure={configure}
      />
    ),
  }
}
