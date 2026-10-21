/**
 * The built-in dp-backed MCP set (A7) for the unified MCP servers panel.
 *
 * Owner decision 2026-08-01: the set is no longer a card of its own — it is
 * rows of the ONE MCP list, so this is the state that feeds those rows and the
 * write their switches make. Nothing here decides anything: the set, each
 * server's effective state and whether `dp` is installed all arrive over RPC
 * from the process that did the filesystem lookup.
 *
 * This module NEVER resolves or runs `dp`, and never reads a credential.
 *
 * The load-bearing logic is exported pure because the repo has no
 * `renderHook`/DOM lib — the established pattern for renderer hooks (see
 * `usePluginEnablement.ts` and `PendingAuthNotice.tsx`).
 */

import * as React from 'react'
import type { BuiltinDpMcpSettingsViewV1 } from '../../shared/types'

/**
 * The optimistic update one switch makes. Pure.
 *
 * Optimistic and then re-read on failure: the write can be REFUSED (an unknown
 * wire name is rejected by the setter on purpose), and a switch that stayed
 * flipped after a refusal would be a lie about what the pools will start.
 */
export function applyBuiltinDpMcpToggle(
  view: BuiltinDpMcpSettingsViewV1 | null,
  name: string,
  enabled: boolean,
): BuiltinDpMcpSettingsViewV1 | null {
  if (!view) return view
  return {
    ...view,
    servers: view.servers.map(server => (server.name === name ? { ...server, enabled } : server)),
  }
}

/**
 * Persist one server's switch. This is the ONLY write path for a built-in —
 * never the plugin `set-capability-enabled` mutation, which writes a capability
 * policy record a built-in does not have.
 *
 * @returns false when the write was refused or the transport failed, which is
 * the caller's signal to re-read rather than trust the optimistic state.
 */
export async function persistBuiltinDpMcpServerEnabled(name: string, enabled: boolean): Promise<boolean> {
  try {
    await window.electronAPI?.setBuiltinDpMcpServerEnabled?.(name, enabled)
    return true
  } catch (error) {
    console.error('Failed to save built-in MCP server setting:', error)
    return false
  }
}

export interface BuiltinDpMcpServersState {
  /** The set as the server process sees it, or null before the first read. */
  view: BuiltinDpMcpSettingsViewV1 | null
  /** Flip one server, optimistically, then persist. */
  toggle: (name: string, enabled: boolean) => void
}

export function useBuiltinDpMcpServers(): BuiltinDpMcpServersState {
  const [view, setView] = React.useState<BuiltinDpMcpSettingsViewV1 | null>(null)

  const reload = React.useCallback(async () => {
    try {
      // Fail-soft to "not read yet": a transport hiccup must not paint 28
      // servers as absent, and the panel renders no built-in rows for null.
      setView(await window.electronAPI?.getBuiltinDpMcpServers?.() ?? null)
    } catch {
      setView(null)
    }
  }, [])

  React.useEffect(() => { void reload() }, [reload])

  const toggle = React.useCallback((name: string, enabled: boolean) => {
    setView(prev => applyBuiltinDpMcpToggle(prev, name, enabled))
    void persistBuiltinDpMcpServerEnabled(name, enabled).then(ok => {
      if (!ok) void reload()
    })
  }, [reload])

  return { view, toggle }
}
