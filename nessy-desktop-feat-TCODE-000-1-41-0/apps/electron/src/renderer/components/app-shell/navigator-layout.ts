/**
 * Navigator geometry for the AppShell panel stack: how wide the session-list
 * navigator is and whether its resize sash is shown.
 *
 * UA2.2 follow-up (v0.13.4 AppShell.tsx L3625 and L3666). Upstream collapses the
 * navigator for the board at DESKTOP widths only:
 *
 *   navigatorWidth={isAutoCompact ? sessionListWidth
 *     : (effectiveSidebarAndNavigatorHidden || isBoardView || isPagesView ? 0 : sessionListWidth)}
 *
 * In the compact layout the navigator must stay: PanelStackContainer's compact
 * branch mounts the navigator slot only when `navigatorWidth > 0`, and the board
 * state carries `details: null`, so `isDetailNavState` is false and the content
 * slot holding the board sits off-screen. A zero width there left a blank pane.
 *
 * `showNavigator` is Nessy's own gate for navigator-less routes (the Plugins
 * marketplace); it applies at every width, as before.
 */
export interface NavigatorLayoutInput {
  /** False on navigator-less routes (Plugins). */
  showNavigator: boolean
  /** Sessions navigator in viewMode 'board'. */
  isBoardView: boolean
  /** Compact (mobile / narrow window) layout. */
  isAutoCompact: boolean
  /** Focused mode: sidebar and navigator hidden. */
  isSidebarAndNavigatorHidden: boolean
  sessionListWidth: number
}

export function resolveNavigatorWidth(input: NavigatorLayoutInput): number {
  const { showNavigator, isBoardView, isAutoCompact, isSidebarAndNavigatorHidden, sessionListWidth } = input
  if (!showNavigator) return 0
  if (isAutoCompact) return sessionListWidth
  return isSidebarAndNavigatorHidden || isBoardView ? 0 : sessionListWidth
}

export function showSessionListResizeHandle(input: NavigatorLayoutInput): boolean {
  return !input.isSidebarAndNavigatorHidden && input.showNavigator && !input.isBoardView
}
