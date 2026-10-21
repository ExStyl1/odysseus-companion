/**
 * App-shell-connected variant of the unified MCP servers panel (C6): catalog
 * from context, plugin toggles through the existing plugin enablement mutations
 * (incl. the enable-time configuration prompt), built-in dp toggles (A7)
 * through the built-in preference. Kept in its own module so the presentational
 * panel stays import-light for tests and the playground.
 */
import * as React from 'react'
import { useAtomValue } from 'jotai'
import { useAppShellContext } from '@/context/AppShellContext'
import { usePluginEnablement } from '@/hooks/usePluginEnablement'
import type { BuiltinDpMcpServersState } from '@/hooks/useBuiltinDpMcpServers'
import { useSession } from '@/hooks/useSession'
import { focusedSessionIdAtom } from '@/atoms/panel-stack'
import { McpServersPanel, type McpServersPanelProps } from './McpServersPanel'
import type { McpServerStatusLine } from '../../../shared/types'

export function ConnectedMcpServersPanel({
  builtinDp,
  onOpenServer,
  className,
}: Pick<McpServersPanelProps, 'onOpenServer' | 'className'> & {
  /**
   * The built-in dp set, read by the OWNER (AppShell) rather than here: the
   * left-nav MCP count derives from the same state, and a second
   * `useBuiltinDpMcpServers()` would be a second RPC read and a second
   * optimistic state that can disagree with this one.
   */
  builtinDp: BuiltinDpMcpServersState
}) {
  const { capabilityCatalog } = useAppShellContext()
  const enablement = usePluginEnablement()
  // P6.711 — the reconnect verb is SESSION-scoped (the MCP pool is per managed
  // session), and this panel is reached from the Sources navigation, which
  // knows of no session. The two selections are read here rather than threaded
  // down from `AppShell` on purpose: both are global stores, so reading them at
  // the one place that needs them costs a hook instead of a prop through a
  // 3 500-line component — and it is the SAME `focused ?? selected` order
  // `AppShell`'s own `effectiveSessionId` uses, so a multi-panel user
  // reconnects the pool of the panel they are looking at.
  const focusedSessionId = useAtomValue(focusedSessionIdAtom)
  const [session] = useSession()
  const sessionId = focusedSessionId ?? session.selected
  // P6.750 — the LIVE inventory for the same session the Reconnect button
  // addresses, read once per session selection rather than polled: the panel is
  // a list the user opens, not a monitor, and a poll would put an RPC per
  // interval behind a surface that is closed most of the time. The Reconnect
  // button refreshes it, which is the one moment the state is expected to move.
  const [serverStatuses, setServerStatuses] = React.useState<
    readonly McpServerStatusLine[] | null
  >(null)
  const refreshStatuses = React.useCallback(() => {
    if (!sessionId) {
      setServerStatuses(null)
      return
    }
    // A failed read leaves the markers absent rather than showing a wrong one:
    // "nobody counted" is exactly what a failed read means.
    void window.electronAPI.getSessionMcpServerStatuses(sessionId)
      .then(setServerStatuses)
      .catch(() => setServerStatuses(null))
  }, [sessionId])
  React.useEffect(refreshStatuses, [refreshStatuses])
  const onReconnectServer = React.useMemo(
    // No session, no control: `undefined` removes the button rather than
    // offering one whose only possible answer is "there is nothing to restart".
    () => (sessionId
      ? async (wireName: string) => {
        const result = await window.electronAPI.reconnectSessionMcpServer(sessionId, wireName)
        // Whatever the verdict, the pool's state may have moved — a successful
        // redial clears the marker, a failed one leaves it and updates the
        // reason. Re-reading on both is what stops the row contradicting the
        // button that just ran.
        refreshStatuses()
        return result
      }
      : undefined),
    [refreshStatuses, sessionId],
  )
  return (
    <>
      {enablement.configurationPrompt}
      <McpServersPanel
        catalog={capabilityCatalog}
        builtinDp={builtinDp.view}
        pendingCapabilityId={enablement.pendingCapabilityId}
        onToggleServer={(target, next) => void enablement.setCapabilityEnabled(target.pluginKey, target.capabilityId, next)}
        onToggleBuiltinDp={builtinDp.toggle}
        onReconnectServer={onReconnectServer}
        serverStatuses={serverStatuses}
        onOpenServer={onOpenServer}
        className={className}
      />
    </>
  )
}
