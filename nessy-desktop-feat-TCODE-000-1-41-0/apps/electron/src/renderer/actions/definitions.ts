import type { ActionDefinition } from './types'

export const actions = {
  // ═══════════════════════════════════════════
  // General
  // ═══════════════════════════════════════════
  'app.newChat': {
    id: 'app.newChat',
    label: 'New Chat',
    description: 'Create a new chat session',
    defaultHotkey: 'mod+n',
    category: 'General',
  },
  'app.newChatInPanel': {
    id: 'app.newChatInPanel',
    label: 'New Chat in Panel',
    description: 'Create a new chat session in a new panel',
    defaultHotkey: 'mod+t',
    category: 'General',
  },
  'app.settings': {
    id: 'app.settings',
    label: 'Settings',
    description: 'Open application settings',
    defaultHotkey: 'mod+,',
    category: 'General',
  },
  'app.toggleTheme': {
    id: 'app.toggleTheme',
    label: 'Toggle Theme',
    description: 'Switch between light and dark mode',
    defaultHotkey: 'mod+shift+a',
    category: 'General',
  },
  'app.search': {
    id: 'app.search',
    label: 'Search',
    description: 'Open search panel',
    defaultHotkey: 'mod+f',
    category: 'General',
  },
  'app.keyboardShortcuts': {
    id: 'app.keyboardShortcuts',
    label: 'Keyboard Shortcuts',
    description: 'Show keyboard shortcuts reference',
    defaultHotkey: 'mod+/',
    category: 'General',
  },
  'app.newWindow': {
    id: 'app.newWindow',
    label: 'New Window',
    description: 'Open a new window',
    defaultHotkey: 'mod+shift+n',
    category: 'General',
  },
  'app.quit': {
    id: 'app.quit',
    label: 'Quit',
    description: 'Quit the application',
    defaultHotkey: 'mod+q',
    category: 'General',
  },

  // ═══════════════════════════════════════════
  // Navigation
  // ═══════════════════════════════════════════
  'nav.focusSidebar': {
    id: 'nav.focusSidebar',
    label: 'Focus Sidebar',
    defaultHotkey: 'mod+1',
    category: 'Navigation',
  },
  'nav.focusNavigator': {
    id: 'nav.focusNavigator',
    label: 'Focus Navigator',
    defaultHotkey: 'mod+2',
    category: 'Navigation',
  },
  'nav.focusChat': {
    id: 'nav.focusChat',
    label: 'Focus Chat',
    defaultHotkey: 'mod+3',
    category: 'Navigation',
  },
  'nav.nextZone': {
    id: 'nav.nextZone',
    label: 'Focus Next Zone',
    defaultHotkey: 'tab',
    category: 'Navigation',
    when: '!inputFocus',  // Tab should work normally in text inputs
  },
  'nav.goBack': {
    id: 'nav.goBack',
    label: 'Go Back',
    description: 'Navigate to previous session',
    defaultHotkey: 'mod+[',
    category: 'Navigation',
  },
  'nav.goForward': {
    id: 'nav.goForward',
    label: 'Go Forward',
    description: 'Navigate to next session',
    defaultHotkey: 'mod+]',
    category: 'Navigation',
  },
  'nav.goBackAlt': {
    id: 'nav.goBackAlt',
    label: 'Go Back',
    description: 'Navigate to previous session (arrow key)',
    defaultHotkey: 'mod+left',
    category: 'Navigation',
    when: '!inputFocus',  // CMD+Left = cursor to line start in text inputs
  },
  'nav.goForwardAlt': {
    id: 'nav.goForwardAlt',
    label: 'Go Forward',
    description: 'Navigate to next session (arrow key)',
    defaultHotkey: 'mod+right',
    category: 'Navigation',
    when: '!inputFocus',  // CMD+Right = cursor to line end in text inputs
  },

  // ═══════════════════════════════════════════
  // View
  // ═══════════════════════════════════════════
  'view.toggleSidebar': {
    id: 'view.toggleSidebar',
    label: 'Toggle Sidebar',
    defaultHotkey: 'mod+b',
    category: 'View',
  },
  'view.toggleTaskChecklist': {
    id: 'view.toggleTaskChecklist',
    label: 'Toggle Task Checklist',
    description: 'Show or hide the session task checklist',
    // Claude binds this to Ctrl+T (interactive-mode.md:36), but `mod+t` is
    // already `app.newChatInPanel` here and matches the OS "new tab" convention
    // in a desktop shell. The SURFACE is what R20 requires; the chord moves.
    defaultHotkey: 'mod+shift+t',
    category: 'View',
  },
  'view.cycleTranscriptVerbosity': {
    id: 'view.cycleTranscriptVerbosity',
    label: 'Cycle Transcript View Mode',
    description: 'Cycle the chat transcript between Normal, Verbose and Summary',
    // `desktop.md#switch-view-modes`: "press Ctrl+O on macOS or Windows to
    // cycle through them". On Windows and Linux `mod` IS ctrl, so this default
    // is the documented chord exactly; on macOS it becomes Cmd+O, because
    // `matchesHotkey` has no literal `ctrl` modifier and inventing one would be
    // a keybinding-engine change for one chord. Same trade, same reason, as
    // `view.toggleTaskChecklist` above: the SURFACE is what the row requires,
    // the chord moves — and the user can rebind it on the Shortcuts page.
    defaultHotkey: 'mod+o',
    category: 'View',
  },
  'view.toggleFocusMode': {
    id: 'view.toggleFocusMode',
    label: 'Toggle Focus Mode',
    description: 'Hide both sidebars for distraction-free work',
    defaultHotkey: 'mod+.',
    category: 'View',
  },

  // ═══════════════════════════════════════════
  // Navigator (scoped — active entity list in middle panel)
  // ═══════════════════════════════════════════
  'navigator.selectAll': {
    id: 'navigator.selectAll',
    label: 'Select All',
    defaultHotkey: 'mod+a',
    category: 'Navigator',
    scope: 'navigator',
    when: 'navigatorFocus',  // CMD+A = select all text when in input
  },
  'navigator.clearSelection': {
    id: 'navigator.clearSelection',
    label: 'Clear Selection',
    defaultHotkey: 'escape',
    category: 'Navigator',
    scope: 'navigator',
    when: 'navigatorFocus',
  },

  // ═══════════════════════════════════════════
  // Panels
  // ═══════════════════════════════════════════
  'panel.focusNext': {
    id: 'panel.focusNext',
    label: 'Focus Next Panel',
    description: 'Move focus to the next panel',
    defaultHotkey: 'mod+shift+]',
    category: 'Navigation',
  },
  'panel.focusPrev': {
    id: 'panel.focusPrev',
    label: 'Focus Previous Panel',
    description: 'Move focus to the previous panel',
    defaultHotkey: 'mod+shift+[',
    category: 'Navigation',
  },

  // ═══════════════════════════════════════════
  // Chat
  // ═══════════════════════════════════════════
  'chat.stopProcessing': {
    id: 'chat.stopProcessing',
    label: 'Stop Processing',
    description: 'Cancel the current agent task (double-press)',
    defaultHotkey: 'escape',
    category: 'Chat',
    scope: 'chat',
    when: '!hasSelection',  // Let browser clear selection first; overlays handled by hasOpenOverlay() in enabled callback
  },
  'chat.cyclePermissionMode': {
    id: 'chat.cyclePermissionMode',
    label: 'Cycle Permission Mode',
    description: 'Switch to the next permission mode',
    defaultHotkey: 'shift+tab',
    category: 'Chat',
  },
  'chat.nextSearchMatch': {
    id: 'chat.nextSearchMatch',
    label: 'Next Search Match',
    defaultHotkey: 'mod+g',
    category: 'Chat',
  },
  'chat.prevSearchMatch': {
    id: 'chat.prevSearchMatch',
    label: 'Previous Search Match',
    defaultHotkey: 'mod+shift+g',
    category: 'Chat',
  },
  /**
   * P6.480 — send ONE message with the follow-up behaviour this connection does
   * NOT use by default, without changing the stored setting.
   *
   * Listed here rather than hard-coded in the composer for two reasons the row
   * names. It makes the chord REBINDABLE like every other shortcut, and it puts
   * it inside the registry's collision check — Alt/Option+Enter is free today
   * (`altKey` scored one hit in the composer, the ArrowUp guard, and the
   * registry had no Enter binding at all), and "free today" is exactly the
   * property nobody re-checks when they add the next action.
   *
   * The HANDLER stays in the composer, unlike its Chat neighbours, and that is
   * deliberate: this action sends the composer's own draft, so a global handler
   * would need the draft, the attachments and the mention state pushed out to
   * it. The composer matches the registry's CURRENT hotkey rather than the
   * literal chord, so a rebind is honoured.
   */
  'chat.sendWithOtherFollowUp': {
    id: 'chat.sendWithOtherFollowUp',
    label: 'Send with the other follow-up behavior',
    description: 'Send one message steering or queueing — whichever this connection does not do by default',
    defaultHotkey: 'alt+enter',
    category: 'Chat',
    scope: 'chat',
  },
  /**
   * P6.793 — move the tool call this turn is BLOCKED on into the background and
   * let the turn carry on.
   *
   * The product surface for the SDK's own `Query.backgroundTasks`, which the
   * host had never called. Its documentation names the terminal's equivalent —
   * *"backgrounds all foreground tasks — equivalent to pressing Ctrl+B in the
   * terminal"* — so a chord is the shape the mechanism was built for, and this
   * is the nearest documented solution rather than an invented affordance.
   *
   * NOT `mod+b`: that is `view.toggleSidebar` here. The chord is listed rather
   * than hard-coded for the reason its Chat neighbour above gives — it becomes
   * rebindable, it appears in the Shortcuts page, and it enters the registry's
   * collision check, which is the property nobody re-checks by hand.
   *
   * It does NOT change what `/code-review` does by default, and P6.798 did not
   * give it that job either: that row flipped the default where one exists —
   * Pi's `review` tool now backgrounds unless the caller passes
   * `background: false` — while claude and codex reach the command through the
   * skill, which has no direction switch. This stays the lever a person pulls
   * when a turn is blocked on any runtime. It said "foreground on every runtime
   * until the owner rules on P6.798" until that ruling.
   */
  'chat.backgroundInFlightTask': {
    id: 'chat.backgroundInFlightTask',
    label: 'Background the Running Task',
    description: 'Let the turn continue without waiting for the tool call it is blocked on',
    defaultHotkey: 'mod+shift+b',
    category: 'Chat',
    scope: 'chat',
  },

} as const satisfies Record<string, ActionDefinition>

// Type-safe action IDs
export type ActionId = keyof typeof actions

// Get all actions as array (for shortcuts page)
export const actionList = Object.values(actions)

// Get actions by category (for organized display)
export const actionsByCategory = actionList.reduce((acc, action) => {
  if (!acc[action.category]) acc[action.category] = []
  acc[action.category].push(action)
  return acc
}, {} as Record<string, ActionDefinition[]>)
