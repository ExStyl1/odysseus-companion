/**
 * usePluginEnablement (U4)
 *
 * Shared enable/disable logic for the Sources management panel — the plugins
 * subsection rows AND plugin-origin source rows (skills / MCP / connectors).
 *
 * NO new policy machinery (Stop Condition): this ONLY reuses the EXISTING
 * marketplace enable/disable mutations (`useMarketplaceEnable`/`Disable` →
 * `window.electronAPI.plugin.manage`) keyed by `pluginKey` + a
 * `SafePluginActivationTarget`, identical to what `PluginsPage`'s actions menu
 * flips. The scope-target construction mirrors `PluginsPage.activationTarget`
 * so a toggle from a Sources row lands on the same policy record.
 *
 * Scope rule (owner decision 2026-07-19): "workspace" always available;
 * "project" only when a project/session capability context exists (a project
 * target always resolves to one concrete projectRoot via the context ref).
 */

import * as React from 'react'
import { toast } from 'sonner'
import { useTranslation } from 'react-i18next'
import { useMarketplaceEnable, useMarketplaceDisable, useMarketplaceSetCapabilityEnabled, useMarketplaceUninstall } from '@/hooks/useMarketplaceInstall'
import { useAppShellContext } from '@/context/AppShellContext'
import { usePluginConfigurationPrompt } from '@/hooks/usePluginConfigurationPrompt'
import type {
  SafeCapabilityContextRef,
  SafePluginActivationTarget,
  SafePluginManagementActionRequest,
} from '@nessy-agent/shared/protocol/capabilities'

export type PluginEnablementScope = 'workspace' | 'project'

/**
 * Build the activation target for a scope. Pure — SHARED with `PluginsPage`'s
 * `activationTarget` shape so a Sources-row toggle lands on the SAME policy
 * record the marketplace actions menu flips. Returns null for "project" when
 * no project/session context exists (caller then omits the project menu item).
 */
export function pluginActivationTarget(
  scope: PluginEnablementScope,
  workspaceId: string | null,
  context: SafeCapabilityContextRef | undefined,
): SafePluginActivationTarget | null {
  if (scope === 'workspace') return workspaceId ? { kind: 'workspace', workspaceId } : null
  if (context && ('sessionId' in context || 'projectHandleId' in context)) return { kind: 'project', context }
  return null
}

/**
 * The exact enable/disable action request sent to `plugin.manage` — the SAME
 * request `PluginsPage.onEnable`/`onDisable` builds. Pure + tested so a Sources
 * row provably flips the identical state the marketplace menu does.
 */
export function pluginToggleRequest(
  pluginKey: string,
  next: boolean,
  target: SafePluginActivationTarget,
): Extract<SafePluginManagementActionRequest, { action: 'enable' | 'disable' }> {
  return next
    ? { pluginKey, action: 'enable', target }
    : { pluginKey, action: 'disable', target }
}

export interface UsePluginEnablementResult {
  /** Whether a "project" menu item should be offered (project context present). */
  hasProjectContext: boolean
  /** An enable/disable mutation is in flight (drives the row spinner). */
  isPending: boolean
  /**
   * Flip a plugin's activation at a scope. Returns true on success. Errors are
   * toasted and surfaced through `errorFor(pluginKey)` so the row can render an
   * inline note (placeholder-not-hidden).
   */
  setEnabled: (pluginKey: string, scope: PluginEnablementScope, next: boolean) => Promise<boolean>
  /**
   * Flip ONE capability of a plugin at the workspace scope (the detail page's
   * per-component switches). Returns true on success; errors are toasted.
   */
  setCapabilityEnabled: (pluginKey: string, capabilityId: string, next: boolean) => Promise<boolean>
  /** The capabilityId of an in-flight capability toggle (drives row pending). */
  pendingCapabilityId: string | undefined
  /**
   * Uninstall the plugin — the SAME mutation the marketplace actions menu runs,
   * so a Sources row can remove an installed marketplace item without routing
   * through the browse page. Returns true on success; errors are toasted.
   */
  uninstall: (pluginKey: string, displayName?: string) => Promise<boolean>
  /** Last error message for a plugin (cleared on the next successful toggle). */
  errorFor: (pluginKey: string) => string | undefined
  /**
   * The enable-time configuration dialog, already rendered, or `null`.
   *
   * `plugins/components.md#when-the-configuration-dialog-appears` — "The `userConfig` field declares values that
   * Claude Code prompts the user for when the plugin is enabled." The prompt
   * belongs to the enable ACTION rather than to any one page, and this hook is
   * the single place every enable path goes through — the Sources panel rows,
   * the marketplace actions menu and the plugin detail page all call
   * {@link UsePluginEnablementResult.setEnabled}. Returning the element means a
   * caller opts in with one line and cannot wire the prompt to a different
   * request than the one it just sent.
   */
  configurationPrompt: React.ReactNode
}

export function usePluginEnablement(): UsePluginEnablementResult {
  const { t } = useTranslation()
  const { activeWorkspaceId, capabilityContext, refreshPluginState } = useAppShellContext()
  const enableMutation = useMarketplaceEnable(activeWorkspaceId)
  const disableMutation = useMarketplaceDisable(activeWorkspaceId)
  const capabilityMutation = useMarketplaceSetCapabilityEnabled(activeWorkspaceId)
  const uninstallMutation = useMarketplaceUninstall(activeWorkspaceId)
  const [errors, setErrors] = React.useState<Record<string, string>>({})
  const [pendingCapabilityId, setPendingCapabilityId] = React.useState<string | undefined>(undefined)
  const configurationPrompt = usePluginConfigurationPrompt(refreshPluginState)

  const hasProjectContext = Boolean(
    capabilityContext && ('sessionId' in capabilityContext || 'projectHandleId' in capabilityContext),
  )

  const setEnabled = React.useCallback(async (
    pluginKey: string,
    scope: PluginEnablementScope,
    next: boolean,
  ): Promise<boolean> => {
    const target = pluginActivationTarget(scope, activeWorkspaceId, capabilityContext)
    if (!target) {
      const message = t('sourcesManagement.noProjectContext')
      setErrors(prev => ({ ...prev, [pluginKey]: message }))
      toast.error(message)
      return false
    }
    try {
      if (next) {
        // `:543` — ask at enable, not at first failure. The controller raises
        // nothing when the plugin declares no options or they are all set, so a
        // plugin that needs nothing enables silently, exactly as before.
        const result = await enableMutation.mutateAsync({ pluginKey, action: 'enable', target })
        configurationPrompt.offer(result, { pluginKey, workspaceId: activeWorkspaceId })
      } else {
        await disableMutation.mutateAsync({ pluginKey, action: 'disable', target })
      }
      setErrors(prev => {
        if (!(pluginKey in prev)) return prev
        const { [pluginKey]: _dropped, ...rest } = prev
        return rest
      })
      toast.success(next ? t('plugins.toastEnabled') : t('plugins.toastDisabled'))
      await refreshPluginState?.()
      return true
    } catch (error) {
      const message = error instanceof Error && error.message
        ? error.message
        : t(next ? 'plugins.errorEnable' : 'plugins.errorDisable')
      setErrors(prev => ({ ...prev, [pluginKey]: message }))
      toast.error(t(next ? 'plugins.errorEnable' : 'plugins.errorDisable'), { description: message })
      return false
    }
  }, [activeWorkspaceId, capabilityContext, configurationPrompt, disableMutation, enableMutation, refreshPluginState, t])

  const setCapabilityEnabled = React.useCallback(async (
    pluginKey: string,
    capabilityId: string,
    next: boolean,
  ): Promise<boolean> => {
    const target = pluginActivationTarget('workspace', activeWorkspaceId, capabilityContext)
    if (!target) return false
    setPendingCapabilityId(capabilityId)
    try {
      await capabilityMutation.mutateAsync({
        pluginKey,
        action: 'set-capability-enabled',
        target,
        capabilityId,
        enabled: next,
      })
      toast.success(next ? t('pluginDetail.toastComponentEnabled') : t('pluginDetail.toastComponentDisabled'))
      await refreshPluginState?.()
      return true
    } catch (error) {
      const message = error instanceof Error && error.message ? error.message : undefined
      toast.error(t('pluginDetail.errorComponentToggle'), message ? { description: message } : undefined)
      return false
    } finally {
      setPendingCapabilityId(undefined)
    }
  }, [activeWorkspaceId, capabilityContext, capabilityMutation, refreshPluginState, t])

  const uninstall = React.useCallback(async (
    pluginKey: string,
    displayName?: string,
  ): Promise<boolean> => {
    try {
      await uninstallMutation.mutateAsync({ pluginKey, action: 'uninstall' })
      setErrors(prev => {
        if (!(pluginKey in prev)) return prev
        const { [pluginKey]: _dropped, ...rest } = prev
        return rest
      })
      toast.success(t('plugins.toastUninstalled'), displayName ? { description: displayName } : undefined)
      await refreshPluginState?.()
      return true
    } catch (error) {
      const message = error instanceof Error && error.message ? error.message : t('plugins.errorUninstall')
      setErrors(prev => ({ ...prev, [pluginKey]: message }))
      toast.error(t('plugins.errorUninstall'), { description: message })
      return false
    }
  }, [refreshPluginState, t, uninstallMutation])

  const errorFor = React.useCallback((pluginKey: string) => errors[pluginKey], [errors])

  return {
    hasProjectContext,
    isPending: enableMutation.isPending || disableMutation.isPending || uninstallMutation.isPending,
    setEnabled,
    setCapabilityEnabled,
    pendingCapabilityId,
    uninstall,
    errorFor,
    configurationPrompt: configurationPrompt.element,
  }
}
