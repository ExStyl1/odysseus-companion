/**
 * PlaygroundAppShellProvider
 *
 * Minimal stand-in for the real AppShellProvider so components that rely on
 * `useActiveWorkspace()` / `useAppShellContext()`
 * can render inside the playground without the full app shell wiring.
 *
 * All callbacks are no-op logging stubs — interactions just go to the console.
 */

import * as React from 'react'
import { AppShellProvider, type AppShellContextType } from '../context/AppShellContext'
import type { WorkspaceInfo } from '../../shared/types'

const PLAYGROUND_WORKSPACE: WorkspaceInfo = {
  id: 'playground-workspace',
  name: 'Playground',
}

function logCall(method: string) {
  return (...args: unknown[]) => {
    console.log(`[Playground AppShell] ${method} called`, args)
  }
}

// Build a minimal value that satisfies the type. Most callbacks are no-ops;
// only `workspaces` and `activeWorkspaceId` carry real data so
// `useActiveWorkspace()` resolves to the playground workspace. Demos that need
// more (the chat header) spread it and override (v0.15.1, UB14.6).
export const playgroundAppShellValue: AppShellContextType = {
  workspaces: [PLAYGROUND_WORKSPACE],
  activeWorkspaceId: PLAYGROUND_WORKSPACE.id,
  llmConnections: [],
  refreshLlmConnections: async () => {},
  pendingPermissions: new Map(),
  pendingCredentials: new Map(),
  getDraft: () => '',
  getDraftAttachmentRefs: () => [],
  getDraftPromptOrigin: () => undefined,
  hydrateDraftAttachments: async () => [],
  sessionOptions: new Map(),
  // F1.1052: the shipped default (`config-defaults.json` workspaceDefaults.permissionMode), so the
  // composer's mode picker shows its "Default" badge here as it does in a real workspace.
  defaultPermissionMode: 'auto',
  onCreateSession: (async () => {
    throw new Error('[Playground] onCreateSession is not available')
  }) as AppShellContextType['onCreateSession'],
  onSendMessage: logCall('onSendMessage'),
  onRenameSession: logCall('onRenameSession'),
  onFlagSession: logCall('onFlagSession'),
  onUnflagSession: logCall('onUnflagSession'),
  onArchiveSession: logCall('onArchiveSession'),
  onUnarchiveSession: logCall('onUnarchiveSession'),
  onMarkSessionRead: logCall('onMarkSessionRead'),
  onMarkSessionUnread: logCall('onMarkSessionUnread'),
  onSetActiveViewingSession: logCall('onSetActiveViewingSession'),
  onSessionStatusChange: logCall('onSessionStatusChange'),
  onDeleteSession: async () => {
    console.log('[Playground AppShell] onDeleteSession called')
    return false
  },
  onOpenFile: logCall('onOpenFile'),
  onOpenUrl: logCall('onOpenUrl'),
  onSelectWorkspace: logCall('onSelectWorkspace'),
  onOpenSettings: logCall('onOpenSettings'),
  onOpenKeyboardShortcuts: logCall('onOpenKeyboardShortcuts'),
  onOpenStoredUserPreferences: logCall('onOpenStoredUserPreferences'),
  onReset: logCall('onReset'),
  onSessionOptionsChange: logCall('onSessionOptionsChange'),
  onInputChange: logCall('onInputChange'),
  onAttachmentsChange: logCall('onAttachmentsChange'),
  // The mobile-webui demos rely on this signal to flip `AppMenu` into its
  // compact layout; harmless for other demos that don't read it.
  isCompactMode: true,
}

/**
 * `pendingPermissions` is overridable (P6.270) because the session list's
 * waiting-for-you marker is DRIVEN by it: the state cannot be reached from the
 * session record alone, so without this the playground could show two of the
 * three attention states and not the one the row is about. Nesting a second
 * provider is the intended use — the inner value wins for its subtree.
 */
export function PlaygroundAppShellProvider({
  children,
  pendingPermissions,
}: {
  children: React.ReactNode
  pendingPermissions?: AppShellContextType['pendingPermissions']
}) {
  const value = React.useMemo(
    () => (pendingPermissions ? { ...playgroundAppShellValue, pendingPermissions } : playgroundAppShellValue),
    [pendingPermissions],
  )
  return <AppShellProvider value={value}>{children}</AppShellProvider>
}
