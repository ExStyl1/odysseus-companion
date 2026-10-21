/**
 * P6.773 — the two remaining `showStatus` surfaces that could not say
 * `local_disabled`: `components/info/SourcesManagementRow.tsx` and
 * `pages/SourceInfoPage.tsx`.
 *
 * P6.769 gave `capabilitySummaryConnectionStatus` its second parameter and wired
 * `SourcesListPanel` into it; these two held no setting, so a stdio server the
 * user had switched off in Settings still wore the dot of one nobody had tested
 * yet. The MAPPING needed no change and is already pinned four ways in
 * `components/ui/__tests__/source-status-indicator.test.tsx` (the verdict, the
 * transport scope, the default, and the precedence against `needs_auth`), so
 * repeating it here would pin nothing new. What these cases pin is the half a
 * mapping test cannot see: whether the setting REACHES the pip on each surface.
 * Every mapping arm passes just as well with the value dropped on the way — that
 * is precisely the state P6.769 found on the panel and P6.773 found on these two.
 *
 * WHY THE SOURCE AND NOT A RENDER, measured rather than assumed (2026-09-08).
 * The same instrument P6.769 used for `SourcesListPanel`, and here it was the
 * second choice, not the first: a render test was written and thrown away.
 * Importing `SourcesManagementRow` under bun costs **136 s** and then throws
 * `ReferenceError: DOMMatrix is not defined` out of a SECOND pdfjs copy
 * (`react-pdf/node_modules/pdfjs-dist`) that the usual `mock.module` stubs do not
 * cover — which is why its sibling `SourcesManagementRow.test.tsx` is a
 * registered known red for this graph. Buying that back would mean three global
 * `mock.module` replacements plus a `DOMMatrix` polyfill, and module mocks
 * without a spread leak to every later file in the process (AGENTS.md §Traps).
 * For the detail page the source is the only honest instrument in any case: its
 * value arrives through an async effect, so `renderToStaticMarkup` would render
 * the default and a render assertion would pin the initial state while calling
 * itself a wiring test.
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const read = (relative: string): string =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8')

describe('P6.773 — SourcesManagementRow passes the setting to its own avatar', () => {
  const row = read('../SourcesManagementRow.tsx')

  test('the prop is destructured out of props, not merely declared', () => {
    // The P6.769 defect verbatim: `SourcesListPanel` DECLARED `localMcpEnabled`
    // and never read it, so the setting reached the component and stopped.
    expect(row).toMatch(/^\s*localMcpEnabled\?: boolean$/m)
    expect(row).toMatch(/^\s*localMcpEnabled = true,$/m)
  })

  test('it reaches the SourceAvatar this row renders, which is the only thing that can draw the pip', () => {
    expect(row).toMatch(/<SourceAvatar[^>]*localMcpEnabled=\{localMcpEnabled\}/)
  })

  test('the default is true, so no existing caller is told its servers are off', () => {
    // The boundary. This component is IPC-free by contract and every production
    // caller today (`PluginsManagementPanel` → `SourcesManagementRowList`)
    // supplies nothing, so the default IS the live behaviour: it must be the
    // pre-row verdict, never `false`.
    expect(row).not.toMatch(/localMcpEnabled = false/)
    // And the row is reached WITHOUT a change to the list between them:
    // `SourcesManagementRowEntry` extends the row's props and the list spreads
    // its entries, so a caller can supply the setting per row today.
    const list = read('../SourcesManagementRowList.tsx')
    expect(list).toContain('extends SourcesManagementRowProps')
    expect(list).toMatch(/<SourcesManagementRow[\s\S]{0,120}\{\.\.\.rowProps\}/)
  })
})

describe('P6.773 — SourceInfoPage reads the setting and hands it to the pip', () => {
  const page = read('../../../pages/SourceInfoPage.tsx')

  test('it reads the workspace setting the way every other surface reads it', () => {
    // `getWorkspaceSettings` keyed on this page's own `workspaceId` — the same
    // call `AppShell` and `WorkspaceSettingsPage` make. Not a new mechanism, and
    // not a dependence on being mounted inside the app shell, which this page
    // does not require (`useOptionalAppShellContext`).
    expect(page).toContain('window.electronAPI.getWorkspaceSettings(workspaceId)')
    expect(page).toMatch(/setLocalMcpEnabled\(settings\.localMcpEnabled \?\? true\)/)
  })

  test('the value reaches SourceAvatar, and it is the state rather than a literal', () => {
    // The defect this row named: the page rendered the pip with no setting at
    // all. A literal `true` would satisfy a looser match and pin nothing, so the
    // state variable is matched by name.
    expect(page).toMatch(/<SourceAvatar[^>]*localMcpEnabled=\{localMcpEnabled\}/)
  })

  test('an unreadable setting leaves the page saying what it said before', () => {
    // The negative arm, and a stated decision: naming a server "switched off" on
    // the strength of a failed read is a worse answer than the one the page had,
    // and `true` matches `SourceAvatar`'s own default. The read is also
    // cancelled on unmount, so a workspace switch cannot land a stale answer.
    expect(page).toMatch(/const \[localMcpEnabled, setLocalMcpEnabled\] = React\.useState\(true\)/)
    expect(page).toMatch(/if \(!cancelled && settings\)/)
    expect(page).toMatch(/\.catch\(\(err\) => \{/)
  })
})

describe('P6.778 — the row names its real consumer, and the panel has a path for the setting', () => {
  const row = read('../SourcesManagementRow.tsx')
  const panel = read('../../app-shell/PluginsManagementPanel.tsx')
  const shell = read('../../app-shell/AppShell.tsx')

  test('the row docblock names who actually renders it, not only the five kinds it was designed for', () => {
    // The defect: the docblock promised five kinds, four of which no production
    // caller produces, so every status affordance added here reads as wired and
    // is unreachable in the shipped app.
    expect(row).toContain('PluginsManagementPanel')
    expect(row).toContain('playground/registry/sources-management.tsx')
    expect(row).toContain('pluginRowSummary')
  })

  test('the panel takes the setting and puts it on every row entry', () => {
    expect(panel).toMatch(/^\s*localMcpEnabled\?: boolean$/m)
    expect(panel).toContain('localMcpEnabled = true }: PluginsManagementPanelProps')
    expect(panel).toMatch(/^\s*localMcpEnabled,$/m)
  })

  test('the value is a memo dependency, so a later edit cannot strand it at its first value', () => {
    // The boundary: the rows are built in a `useMemo`. Passing the prop without
    // listing it would freeze every row at whatever the setting was on first
    // render — the same class of "wired but inert" defect this row is closing.
    expect(panel).toContain('[enablement, installed, localMcpEnabled]')
  })

  test('AppShell supplies it from the state it already holds, by name rather than as a literal', () => {
    expect(shell).toMatch(/<PluginsManagementPanel[\s\S]{0,240}localMcpEnabled=\{localMcpEnabled\}/)
    expect(shell).toMatch(/const \[localMcpEnabled, setLocalMcpEnabled\] = React\.useState\(true\)/)
  })
})
