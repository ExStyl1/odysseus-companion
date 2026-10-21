/**
 * F1.1191 — the mode picker's "Default" badge (F1.1052) follows a default changed in Workspace Settings.
 *
 * AppShell loads the workspace settings it holds (the default mode behind the badge, the SHIFT+TAB cycle, local MCP)
 * once per workspace, and Workspace Settings wrote the new default through `updateWorkspaceSetting` and told nobody, so
 * the badge stayed on the old mode until a workspace switch or a reload while the next new session started in the new
 * one. The host broadcasts no settings change (the `workspaceSettings:update` handler only writes), so the page that
 * saves says so: AppShell hands its loader through `AppShellContext.onWorkspaceSettingsChanged` and the page calls it
 * after a save that succeeded.
 *
 * WHY THE SOURCE AND NOT A RENDER: the same reasoning `components/info/__tests__/local-mcp-disabled-surfaces.test.tsx`
 * measured — AppShell's value arrives through an async effect and its module graph is the renderer's heaviest, so a
 * render test would pin the initial state while calling itself a wiring test. What is pinned is the wiring itself: one
 * loader, run by the effect AND handed to the page, and the page calling it on the success path only.
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const read = (relative: string): string =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8')

const between = (text: string, start: string, end: string): string => {
  const from = text.indexOf(start)
  const to = text.indexOf(end, from + start.length)
  if (from < 0 || to < 0) throw new Error(`region not found: ${start} … ${end}`)
  return text.slice(from, to)
}

describe('F1.1191 — Workspace Settings tells AppShell a setting was saved', () => {
  const page = read('../WorkspaceSettingsPage.tsx')
  const shell = read('../../../components/app-shell/AppShell.tsx')
  const writer = between(page, 'const updateWorkspaceSetting = useCallback(', '// Workspace icon upload handler')
  const [trySide, catchSide] = writer.split('} catch (error) {')

  test('FAILING ARM: a save that succeeded calls the reload, and the default-mode select saves through that writer', () => {
    expect(trySide).toMatch(/await window\.electronAPI\.updateWorkspaceSetting\(activeWorkspaceId, key, value\)\s*\n\s*onWorkspaceSettingsChanged\?\.\(\); return true/)
    expect(writer).toMatch(/\[activeWorkspaceId, t, onWorkspaceSettingsChanged\]/)
    expect(page).toMatch(/const \{ onRefreshWorkspaces, onWorkspaceSettingsChanged \} = appShellContext/)
    expect(between(page, 'const handlePermissionModeChange = useCallback(', '[updateWorkspaceSetting]')).toContain("await updateWorkspaceSetting('permissionMode', newMode)")
  })

  test('FAILING ARM: AppShell hands the page the SAME loader its workspace effect runs, and only that loader sets the badge', () => {
    const loader = between(shell, 'const loadWorkspaceSettings = React.useCallback(() => {', '}, [activeWorkspaceId])')
    expect(loader).toContain('window.electronAPI.getWorkspaceSettings(activeWorkspaceId)')
    expect(loader).toContain('setDefaultPermissionMode(')
    expect(shell.split('setDefaultPermissionMode(').length - 1).toBe(1)
    expect(shell).toContain('React.useEffect(loadWorkspaceSettings, [loadWorkspaceSettings])')
    expect(shell).toContain('onWorkspaceSettingsChanged: loadWorkspaceSettings,')
  })

  test('BOUNDARY: a save that failed reloads nothing (the toast is its only effect)', () => {
    const failed = catchSide!.slice(0, catchSide!.indexOf('return false')) // the catch body, up to its own return
    expect(failed).toContain('toast.error(')
    expect(failed).not.toContain('onWorkspaceSettingsChanged')
    expect(catchSide).toContain('return false')
  })
})
