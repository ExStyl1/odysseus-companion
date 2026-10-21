/**
 * UB14.4 (B3-08/F3) — "no feature lost in the split": a census of what `AppShell.tsx` HANDLED before the v0.15.1
 * shell split (the sidebar frame moved to `SidebarPane.tsx`, the seam handles to `ShellResizeHandle.tsx`), pinned
 * from the pre-split file (`git show 9ac2ebaa2:apps/electron/src/renderer/components/app-shell/AppShell.tsx`,
 * 4286 lines), and asserted against the split files.
 *
 * Instrument: a source census (this repo has no DOM under `bun test`, and AppShell cannot be mounted here — it
 * imports `ThemeContext`'s `import.meta.glob`). Each category is read by its own pattern:
 *  - keyboard actions: `useAction('<id>'`;
 *  - main-process menu subscriptions: `window.electronAPI.on<X>`;
 *  - window listeners: `addEventListener('<event>'`;
 *  - sidebar entries: `id: "nav:…"` / `id: 'nav:…'` / `` id: `nav:…` `` — every navigator row the app mounts;
 *  - the sidebar's click and context-menu handlers: `onClick: <handler>` and the context-menu callback props.
 * The NEGATIVE arm drives the same census over a copy with one handled thing removed and requires it to be named
 * missing — so the census can fail.
 */
import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const DIR = join(import.meta.dir, '..')
const read = (name: string) => readFileSync(join(DIR, name), 'utf8')

/** Pinned from the pre-split AppShell.tsx (9ac2ebaa2). */
const BEFORE = {
  actions: [
    'app.keyboardShortcuts', 'app.newChat', 'app.newChatInPanel', 'app.newWindow', 'app.quit', 'app.search',
    'app.settings', 'app.toggleTheme', 'chat.cyclePermissionMode', 'chat.nextSearchMatch', 'chat.prevSearchMatch',
    'chat.stopProcessing', 'nav.focusChat', 'nav.focusNavigator', 'nav.focusSidebar', 'nav.goBack', 'nav.goBackAlt',
    'nav.goForward', 'nav.goForwardAlt', 'nav.nextZone', 'panel.focusNext', 'panel.focusPrev', 'view.toggleFocusMode',
    'view.toggleSidebar',
  ],
  menuSubscriptions: ['onMenuToggleFocusMode', 'onMenuToggleSidebar', 'onUnreadSummaryChanged'],
  windowEvents: ['mousemove', 'mouseup', 'paste'],
  navIds: [
    'nav:allSessions', 'nav:archived', 'nav:automations', 'nav:automations:agentic', 'nav:automations:event',
    'nav:automations:scheduled', 'nav:flagged', 'nav:labels', 'nav:pages', 'nav:plugins', 'nav:projects',
    'nav:settings', 'nav:sources', 'nav:sources:api', 'nav:sources:hooks', 'nav:sources:local', 'nav:sources:mcp',
    'nav:sources:plugins', 'nav:sources:skills', 'nav:whats-new',
    'nav:label:${node.fullId}', 'nav:pages:${p.config.id}', 'nav:projects:${p.config.id}', 'nav:state:${state.id}',
  ],
  sidebarHandlers: [
    'handleAllSessionsClick', 'handleArchivedClick', 'handleAutomationsAgenticClick', 'handleAutomationsClick',
    'handleAutomationsEventClick', 'handleAutomationsScheduledClick', 'handleFlaggedClick', 'handlePagesClick',
    'handlePluginsClick', 'handleProjectsClick', 'handleSkillsClick', 'handleSourcesApiClick', 'handleSourcesClick',
    'handleSourcesHooksClick', 'handleSourcesLocalClick', 'handleSourcesMcpClick', 'handleSourcesPluginsClick',
    'handleWhatsNewClick', '() => handleJumpToProjectSessions(p.config.id)', "() => handleLabelClick('__all__')",
    '() => handleLabelClick(node.fullId)',
    '() => handleSessionStatusClick(state.id)', '() => handleSettingsClick()',
    '() => navigate(routes.view.pages(p.config.slug))',
  ],
  contextMenuProps: [
    'onAddAutomation', 'onAddLabel', 'onAddProject', 'onAddSkill', 'onAddSource', 'onConfigureLabels',
    'onConfigureStatuses', 'onDeleteLabel', 'onMarkAllRead', 'onReorder', 'onToggle',
  ],
  /** The New-session row: click (⌘-click opens a window), the hotkey, the P6.133 worktree item, the tour anchor. */
  newSession: ['handleNewChat(', 'newChatHotkey', 'handleNewChatInWorktree', 'data-tutorial="new-chat-button"'],
} as const

type Census = { [K in keyof typeof BEFORE]: Set<string> }

function census(source: string): Census {
  const all = (re: RegExp) => new Set([...source.matchAll(re)].map(m => m[1]!))
  return {
    actions: all(/useAction\('([^']+)'/g),
    menuSubscriptions: all(/window\.electronAPI\.(on[A-Z]\w*)/g),
    windowEvents: all(/addEventListener\('([^']+)'/g),
    navIds: all(/\bid: ["'`](nav:[^"'`]+)["'`]/g),
    sidebarHandlers: all(/\bonClick: ((?:\(\) => )?[\w.]+(?:\([^\n]*?\))?)(?=,?\n)/g),
    contextMenuProps: all(/\b(on[A-Z]\w*): /g),
    newSession: new Set(BEFORE.newSession.filter(needle => source.includes(needle))),
  }
}

/** Everything pinned BEFORE that the given sources no longer handle, as `category:item`. */
function missingAfter(sources: readonly string[]): string[] {
  const found = census(sources.join('\n'))
  return (Object.keys(BEFORE) as Array<keyof typeof BEFORE>).flatMap(category =>
    (BEFORE[category] as readonly string[]).filter(item => !found[category].has(item)).map(item => `${category}:${item}`),
  )
}

const SPLIT_FILES = ['AppShell.tsx', 'SidebarPane.tsx', 'LeftSidebar.tsx'] as const

describe('UB14.4 — the AppShell split loses no handled action', () => {
  const appShell = read('AppShell.tsx')
  const after = SPLIT_FILES.map(read)

  it('POSITIVE — every action, subscription, listener, sidebar entry and handler handled before the split is still handled', () => {
    expect(appShell.length).toBeGreaterThan(100_000) // the real file was read, not an empty one
    expect(missingAfter(after)).toEqual([])
    // The census reads every category it pins: none of them is an empty match set on the split files.
    const found = census(after.join('\n'))
    for (const category of Object.keys(BEFORE) as Array<keyof typeof BEFORE>) {
      expect({ category, size: found[category].size > 0 }).toEqual({ category, size: true })
    }
  })

  it('NEGATIVE (control) — a copy missing one handled thing is named missing, per category', () => {
    const drop = (needle: string) => after.map(source => source.split(needle).join('/* dropped */'))
    expect(missingAfter(drop("useAction('view.toggleSidebar'"))).toEqual(['actions:view.toggleSidebar'])
    expect(missingAfter(drop('id: "nav:sources:hooks"'))).toEqual(['navIds:nav:sources:hooks'])
    // A row the keyboard list ALSO names (`id: 'nav:plugins'`) is missing only once both are gone.
    expect(missingAfter(drop('id: "nav:plugins"'))).toEqual([])
    expect(missingAfter(drop('id: "nav:plugins"').map(source => source.split("id: 'nav:plugins'").join('')))).toEqual(['navIds:nav:plugins'])
    expect(missingAfter(drop('onClick: handleSourcesHooksClick'))).toEqual(['sidebarHandlers:handleSourcesHooksClick'])
    expect(missingAfter(drop('window.electronAPI.onMenuToggleSidebar'))).toEqual(['menuSubscriptions:onMenuToggleSidebar'])
    expect(missingAfter(drop('handleNewChatInWorktree'))).toEqual(['newSession:handleNewChatInWorktree'])
  })

  it('the sidebar mounts through SidebarPane: the main set scrolls, Settings / Plugins / What\'s New are the pinned footer, a Workspace heading replaces the separator', () => {
    expect(appShell).toMatch(/<SidebarPane\s[\s\S]{0,400}links=\{sidebarLinks\}\s+footerLinks=\{sidebarFooterLinks\}/)
    expect(appShell).toContain('onNewChatInWorktree={handleNewChatInWorktree}')
    expect(appShell).toContain('{ id: "section:workspace", type: "section", title: t("sidebar.workspaceSection") }')
    expect(appShell).not.toContain('separator:chats-sources')
    expect(appShell).not.toContain('separator:skills-settings')
    const footer = appShell.slice(appShell.indexOf('const sidebarFooterLinks'), appShell.indexOf('\n  ]\n', appShell.indexOf('const sidebarFooterLinks')))
    expect([...footer.matchAll(/id: "(nav:[^"]+)"/g)].map(m => m[1])).toEqual(['nav:settings', 'nav:plugins', 'nav:whats-new'])
    expect(appShell).not.toContain('<LeftSidebar')
    expect(appShell).not.toContain('from "@/components/ui/collapsible"') // UB13.11's dead import, gone with its last use
  })

  it('keyboard and menu toggles are instant; pointer toggles animate (the PanelStackContainer FLIP)', () => {
    expect(appShell).toMatch(/useAction\('view\.toggleSidebar', \(\) => \{\s+setAnimateShellLayout\(false\)\s+handleToggleSidebar\(\)/)
    expect(appShell).toMatch(/useAction\('view\.toggleFocusMode', \(\) => \{\s+setAnimateShellLayout\(false\)/)
    expect(appShell).toMatch(/onMenuToggleFocusMode\?\.\(\(\) => \{\s+setAnimateShellLayout\(false\)/)
    expect(appShell).toMatch(/onMenuToggleSidebar\?\.\(\(\) => \{\s+setAnimateShellLayout\(false\)/)
    expect(appShell).toMatch(/const handleToggleSidebarFromPointer = useCallback\(\(\) => \{\s+setAnimateShellLayout\(true\)/)
    expect(appShell).toMatch(/const handleToggleFocusModeFromPointer = useCallback\(\(\) => \{\s+setAnimateShellLayout\(true\)/)
    expect(appShell).toContain('onToggleSidebar={handleToggleSidebarFromPointer}')
    expect(appShell).toContain('onToggleFocusMode={handleToggleFocusModeFromPointer}')
    expect(appShell).toContain('animateLayout={animateShellLayout}')
  })

  it('the seams are ShellResizeHandles whose drag AppShell persists on release; the default widths are 232 / 304', () => {
    expect(appShell.match(/<ShellResizeHandle\b/g)).toHaveLength(2)
    expect(appShell).toContain("onDragStart={() => setIsResizing('sidebar')}")
    expect(appShell).toContain("onDragStart={() => setIsResizing('session-list')}")
    // UA2.2's gate on the list seam is kept.
    expect(appShell).toMatch(/showSessionListResizeHandle\(navigatorLayout\) && \(\s+<ShellResizeHandle/)
    // The release writes the dragged width (a persisted width outranks the new fallbacks).
    expect(appShell).toContain('storage.set(storage.KEYS.sidebarWidth, sidebarWidth)')
    expect(appShell).toContain('storage.set(storage.KEYS.sessionListWidth, sessionListWidth)')
    expect(appShell).toContain('storage.get(storage.KEYS.sidebarWidth, 232)')
    expect(appShell).toContain('storage.get(storage.KEYS.sessionListWidth, 304)')
    // Seams move with the layout at once (spec §6.1): no `left` transition is left on them.
    expect(appShell).not.toContain("'left 0.15s ease-out'")
  })
})
