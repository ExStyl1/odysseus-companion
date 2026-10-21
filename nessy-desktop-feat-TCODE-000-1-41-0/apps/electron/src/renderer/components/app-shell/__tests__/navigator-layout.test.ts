/**
 * UA2.2 follow-up — the board collapses the session-list navigator at desktop
 * widths only, as v0.13.4 AppShell.tsx L3625/L3666 do. In the compact layout the
 * navigator stays: the board state has `details: null`, so the compact content
 * slot (which holds the board) is off-screen, and a zero navigator width left the
 * user a blank pane with no way back.
 */
import { describe, expect, it } from 'bun:test'
import { parseRouteToNavigationState } from '../../../../shared/route-parser'
import { isDetailNavState } from '@/lib/nav-helpers'
import { resolveNavigatorWidth, showSessionListResizeHandle, type NavigatorLayoutInput } from '../navigator-layout'

const base: NavigatorLayoutInput = {
  showNavigator: true,
  isBoardView: false,
  isAutoCompact: false,
  isSidebarAndNavigatorHidden: false,
  sessionListWidth: 320,
}

describe('navigator layout for the board route', () => {
  it('the board state is not a detail state, so the compact layout shows the navigator slot, not the board', () => {
    const board = parseRouteToNavigationState('board')
    expect(board).not.toBeNull()
    expect(isDetailNavState(board)).toBe(false)
  })

  it('compact board: the navigator keeps its width (PanelStackContainer mounts it only when > 0)', () => {
    expect(resolveNavigatorWidth({ ...base, isBoardView: true, isAutoCompact: true })).toBe(320)
  })

  it('desktop board: the navigator and its resize handle collapse', () => {
    const input = { ...base, isBoardView: true }
    expect(resolveNavigatorWidth(input)).toBe(0)
    expect(showSessionListResizeHandle(input)).toBe(false)
  })

  it('desktop list: the navigator and its resize handle are shown', () => {
    expect(resolveNavigatorWidth(base)).toBe(320)
    expect(showSessionListResizeHandle(base)).toBe(true)
  })

  it('navigator-less routes (Plugins) stay collapsed at every width', () => {
    const plugins = { ...base, showNavigator: false }
    expect(resolveNavigatorWidth(plugins)).toBe(0)
    expect(resolveNavigatorWidth({ ...plugins, isAutoCompact: true })).toBe(0)
    expect(showSessionListResizeHandle(plugins)).toBe(false)
  })

  it('focused mode collapses the desktop navigator and handle', () => {
    const focused = { ...base, isSidebarAndNavigatorHidden: true }
    expect(resolveNavigatorWidth(focused)).toBe(0)
    expect(showSessionListResizeHandle(focused)).toBe(false)
  })
})
