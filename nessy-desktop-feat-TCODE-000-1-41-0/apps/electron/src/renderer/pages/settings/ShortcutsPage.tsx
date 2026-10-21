/**
 * Source: v0.15.1:apps/electron/src/renderer/pages/settings/ShortcutsPage.tsx (UB15.4; per-hunk merge.
 * Taken: the `SettingsPage` column with the `settings.shortcuts.description` lede, the shared `Kbd`/`KbdGroup`
 * keycaps (UB13.10) and `SHORTCUT_ROW_CLASS`. Re-applied ours: rebinding (P6.49), the search row as the first
 * thing in the column (C3.230, C3.317), the arrow-aware Mac split and the `+` split on Linux/Windows, the
 * extra registry labels; the rebind, unbind, reset and by-keystroke controls are `Button`s keeping their
 * `aria-label`s. Upstream's `pages/ShortcutsPage.tsx` sibling stays retired (P2.441).)
 */
/**
 * ShortcutsPage
 *
 * Displays keyboard shortcuts from the centralized action registry, and — since
 * P6.49 — lets the user rebind them. Until then the registry's
 * `userOverrides` map was declared, read by `getHotkey` and re-exported on the
 * context, with no writer anywhere in the repo: the page could show you a
 * shortcut that collided with your screen reader, and offer nothing to do
 * about it.
 *
 * The recorder deliberately suspends the global hotkey handler while it is
 * listening (`suspendHotkeys`). Without that, pressing the chord you want to
 * assign would instead FIRE whatever it is currently bound to — the capture-
 * phase listener in `registry.tsx` calls `preventDefault`/`stopPropagation`
 * before this page ever sees the event.
 *
 * Known limitation, stated rather than hidden: `Escape` cancels recording, so
 * it cannot be recorded as a binding here. `escape` and `tab` remain valid
 * override values and load correctly from storage; only this recorder cannot
 * produce the former.
 *
 * Second known behaviour, also by construction (P2.441): the registry seeds
 * `userOverrides` from `preferences.json` through an ASYNC read, so for the
 * first frames after launch this page renders the DEFAULT chords and no Reset
 * button, and both change once the read lands. That is a race with the disk,
 * not with the user — nothing here writes before the seed, so an override can
 * never be lost to it.
 *
 * ## C3.230 — the two questions the table could not answer
 *
 * Thirty actions in category order, and no way to ask anything of them. The
 * search row adds both directions of the same question: a filter over the
 * LOCALIZED label (what the user reads, not `definitions.ts`'s English), and a
 * reverse lookup that records one keystroke and names every command bound to
 * it. The reverse verb reuses `findHotkeyCollisions` through
 * `shortcuts-search.ts` rather than re-deriving the mapping, so the page and
 * the rebind collision notice can never disagree about who owns a chord.
 *
 * The collision sentence is NOT what this buys: `shortcuts.rebind.collision`
 * already names one at rebind time. What was missing is the question asked the
 * other way round, by a user who pressed something and wants to know what it
 * did — including the honest "nothing is bound to this", which the rebind path
 * has no reason to ever say.
 *
 * Recording here reuses the row recorder's own discipline: `suspendHotkeys` for
 * the duration (otherwise the chord under test FIRES), `Escape` cancels and
 * therefore cannot be looked up, and a modifier held alone keeps listening.
 *
 * ## C3.317 — and the three component sections answer the query too
 *
 * C3.230 hid them while a filter was active, on the stated ground that a section
 * ignoring the query would read as a filter that had failed. That was half the
 * problem: *"Enter sends the message"* is a real answer to *"enter"*, and the
 * page that knew it was the page that went blank. They are searched now, by
 * heading plus row text, through `filterShortcutSections` — the second entry
 * shape, label-only, because these rows have no action id and nothing to
 * rebind.
 *
 * The two residues are on the page, not only here:
 * `shortcuts.componentSectionsNote` says in the UI that these are fixed and
 * that the keystroke lookup above does not reach them. The lookup cannot reach
 * them without turning display chips (`↑`, `Home`, `Right-click`, `⌥`+`Click`)
 * into hotkey strings, and two of those four are not keystrokes at all.
 *
 * This is now the ONLY shortcuts surface in the app (P2.441). Three siblings
 * used to render the same registry read-only — `components/KeyboardShortcuts.tsx`,
 * `components/KeyboardShortcutsDialog.tsx` and `pages/ShortcutsPage.tsx` — and
 * all three were measured unreachable: zero importers each, with the app menu
 * item and the `app.keyboardShortcuts` action both routed here through
 * `App.tsx`'s `handleOpenKeyboardShortcuts`. They were retired rather than
 * wired, because reviving them would have revived two defects with them: each
 * dropped an unbound action with `if (!hotkey) return null` — the exact hole
 * P6.49 closed here — and two of them documented keystrokes no handler
 * implements (`R` to rename a session: zero matches in the renderer; `←`/`→` to
 * collapse/expand a folder, while the session list's own arrow handler moves
 * between zones).
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { SettingsPage, SettingsSection, SettingsCard, SettingsRow } from '@/components/settings'
import { settingsUI } from '@/components/settings/SettingsUIConstants'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Kbd, KbdGroup } from '@/components/ui/kbd'
import type { DetailsPageMeta } from '@/lib/navigation-registry'
import { isMac } from '@/lib/platform'
import {
  actions,
  actionsByCategory,
  actionList,
  hotkeyFromKeyboardEvent,
  useActionLabel,
  useActionRegistry,
  type ActionId,
} from '@/actions'
import { formatHotkeyDisplay } from '@/actions/hotkey-overrides'
import { actionsOwningHotkey, filterShortcutEntries, filterShortcutSections } from './shortcuts-search'

export const meta: DetailsPageMeta = {
  navigator: 'settings',
  slug: 'shortcuts',
}

interface ShortcutItem {
  keys: string[]
  description: string
}

interface ShortcutSection {
  title: string
  shortcuts: ShortcutItem[]
}

// Component-specific shortcuts that aren't in the centralized registry
function useComponentSpecificSections(): ShortcutSection[] {
  const { t } = useTranslation()
  return [
    {
      title: t('shortcuts.listNavigation'),
      shortcuts: [
        { keys: ['↑', '↓'], description: t('shortcuts.navigateItems') },
        { keys: ['Home'], description: t('shortcuts.goToFirst') },
        { keys: ['End'], description: t('shortcuts.goToLast') },
      ],
    },
    {
      title: t('shortcuts.sessionList'),
      shortcuts: [
        { keys: ['Enter'], description: t('shortcuts.focusChatInput') },
        { keys: ['Right-click'], description: t('shortcuts.openContextMenu') },
        { keys: [isMac ? '⌥' : 'Alt', 'Click'], description: t('shortcuts.addFilterExcluded') },
      ],
    },
    {
      title: t('shortcuts.chatInput'),
      shortcuts: [
        { keys: ['Enter'], description: t('shortcuts.sendMessage') },
        { keys: ['Shift', 'Enter'], description: t('shortcuts.newLine') },
        { keys: ['Esc'], description: t('shortcuts.closeDialogBlur') },
      ],
    },
  ]
}

/** Single-line key rows are denser than setting rows (44px instead of 56px). */
const SHORTCUT_ROW_CLASS = 'min-h-11 py-2'

/** The quiet text the rows' controls and the search answer speak in (12px, tertiary ink). */
const QUIET_TEXT_CLASS = settingsUI.descriptionSmall

/** One shared keycap per key, grouped (v0.15.1 `KbdGroup` around `Kbd`, UB13.10). */
function KeyChips({ keys }: { keys: readonly string[] }) {
  return (
    <KbdGroup>
      {keys.map((key, keyIndex) => (
        <Kbd key={keyIndex}>{key}</Kbd>
      ))}
    </KbdGroup>
  )
}

/**
 * Renders a shortcut row for an action from the registry
 */
// Map action IDs to i18n keys for translated labels
const ACTION_LABEL_KEYS: Partial<Record<ActionId, string>> = {
  'app.newChat': 'shortcuts.action.newChat',
  'app.newChatInPanel': 'shortcuts.action.newChatInPanel',
  'app.settings': 'shortcuts.action.settings',
  'app.toggleTheme': 'shortcuts.action.toggleTheme',
  'app.search': 'shortcuts.action.search',
  'app.keyboardShortcuts': 'shortcuts.action.keyboardShortcuts',
  'app.newWindow': 'shortcuts.action.newWindow',
  'app.quit': 'shortcuts.action.quit',
  'nav.focusSidebar': 'shortcuts.action.focusSidebar',
  'nav.focusNavigator': 'shortcuts.action.focusNavigator',
  'nav.focusChat': 'shortcuts.action.focusChat',
  'nav.nextZone': 'shortcuts.action.focusNextZone',
  'nav.goBack': 'shortcuts.action.goBack',
  'nav.goForward': 'shortcuts.action.goForward',
  'nav.goBackAlt': 'shortcuts.action.goBack',
  'nav.goForwardAlt': 'shortcuts.action.goForward',
  'view.toggleSidebar': 'shortcuts.action.toggleSidebar',
  'view.toggleFocusMode': 'shortcuts.action.toggleFocusMode',
  'view.toggleTaskChecklist': 'shortcuts.action.toggleTaskChecklist',
  'navigator.selectAll': 'shortcuts.action.selectAll',
  'navigator.clearSelection': 'shortcuts.action.clearSelection',
  'panel.focusNext': 'shortcuts.action.focusNextPanel',
  'panel.focusPrev': 'shortcuts.action.focusPrevPanel',
  'chat.stopProcessing': 'shortcuts.action.stopProcessing',
  'chat.cyclePermissionMode': 'shortcuts.action.cyclePermissionMode',
  'chat.nextSearchMatch': 'shortcuts.action.nextSearchMatch',
  'chat.prevSearchMatch': 'shortcuts.action.prevSearchMatch',
  'chat.sendWithOtherFollowUp': 'shortcuts.action.sendWithOtherFollowUp',
}

/** Split a display string into per-key chips. */
function splitDisplayKeys(hotkey: string): string[] {
  // Mac: symbols are concatenated (⌘⇧N) - need smart splitting
  // Windows: separated by + (Ctrl+Shift+N) - split on +
  return isMac ? hotkey.match(/[⌘⇧⌥←→↑↓]|Tab|Esc|./g) || [] : hotkey.split('+')
}

/**
 * The label a row SHOWS, which is not always `definitions.ts`'s `label`.
 *
 * A plain function of `t`, not a hook, so the page can resolve all thirty at
 * once and hand them to the filter: the string the filter compares must be the
 * string the user reads. The fallback is the definition's English label, for an
 * action with no entry in `ACTION_LABEL_KEYS` — that is a gap in the map, not a
 * reason to hide the row from the filter. (`useActionLabel`'s `label` is this
 * same value: the registry's `getAction` returns the definition.)
 */
function rowLabelFor(actionId: ActionId, t: (key: string) => string): string {
  const key = ACTION_LABEL_KEYS[actionId]
  return key ? t(key) : actions[actionId].label
}

function ActionShortcutRow({ actionId }: { actionId: ActionId }) {
  const { t } = useTranslation()
  const { hotkey } = useActionLabel(actionId)
  const { setHotkeyOverride, resetHotkeyOverride, suspendHotkeys, userOverrides } = useActionRegistry()

  const [recording, setRecording] = React.useState(false)
  const [notice, setNotice] = React.useState<string | null>(null)

  const isOverridden = userOverrides.has(actionId)

  React.useEffect(() => {
    if (!recording) return

    // Take the keyboard away from the global handler for the duration.
    const restore = suspendHotkeys()

    const onKeyDown = (event: KeyboardEvent) => {
      event.preventDefault()
      event.stopPropagation()

      if (event.key === 'Escape') {
        setRecording(false)
        return
      }

      const candidate = hotkeyFromKeyboardEvent(event, isMac)
      // Modifiers alone are not a binding: keep listening.
      if (!candidate) return

      const result = setHotkeyOverride(actionId, candidate)
      setRecording(false)
      if (!result.ok) {
        setNotice(t('shortcuts.rebind.invalid'))
        return
      }
      setNotice(result.collidesWith.length > 0 ? t('shortcuts.rebind.collision') : null)
    }

    window.addEventListener('keydown', onKeyDown, true)
    return () => {
      window.removeEventListener('keydown', onKeyDown, true)
      restore()
    }
  }, [recording, actionId, setHotkeyOverride, suspendHotkeys, t])

  const rowLabel = rowLabelFor(actionId, t)

  return (
    <SettingsRow label={rowLabel} className={SHORTCUT_ROW_CLASS}>
      {/*
        The rebind surface exists so a user whose shortcut collides with their
        assistive technology can move it — so the one message that must reach
        them is the one saying the new chord collides too. The region is
        rendered unconditionally and empty, rather than mounted with its first
        message, for the reason `ReplyAnnouncer` records: a live region that
        appears together with its own first update is not reliably announced.
        `polite`, not `assertive` — it must not interrupt the rebind.
      */}
      <span role="status" aria-live="polite" className={QUIET_TEXT_CLASS}>
        {notice}
      </span>

      {/*
        The chips ARE the rebind control (P6.49): a ghost button around the
        shared keycaps, so the row reads exactly like upstream's until it is
        pressed. The keycaps are `pointer-events-none`, so a click on a chip
        lands on the button.
      */}
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={() => { setNotice(null); setRecording(true) }}
        aria-label={t('shortcuts.rebind.changeFor', { action: rowLabel })}
      >
        {recording ? (
          <span className={QUIET_TEXT_CLASS}>{t('shortcuts.rebind.recording')}</span>
        ) : hotkey ? (
          <KeyChips keys={splitDisplayKeys(hotkey)} />
        ) : (
          // Before P6.49 this row returned null and the action vanished from
          // the page — leaving an unbound action with no way back.
          <span className={QUIET_TEXT_CLASS}>{t('shortcuts.rebind.notBound')}</span>
        )}
      </Button>

      {hotkey && !recording && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => { setNotice(null); setHotkeyOverride(actionId, null) }}
          aria-label={t('shortcuts.rebind.unbindFor', { action: rowLabel })}
          className="text-secondary hover:text-foreground"
        >
          {t('shortcuts.rebind.unbind')}
        </Button>
      )}

      {isOverridden && !recording && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => { setNotice(null); resetHotkeyOverride(actionId) }}
          aria-label={t('shortcuts.rebind.resetFor', { action: rowLabel })}
          className="text-secondary hover:text-foreground"
        >
          {t('shortcuts.rebind.reset')}
        </Button>
      )}
    </SettingsRow>
  )
}

/**
 * The search row: a label filter and a one-keystroke reverse lookup.
 *
 * It renders its own answer and reports the surviving ids upward, so the page
 * below it stays the registry's table rather than becoming a second one.
 */
function ShortcutSearchRow({ onQueryChange }: { onQueryChange: (query: string) => void }) {
  const { t } = useTranslation()
  const { getHotkey, suspendHotkeys } = useActionRegistry()
  const [query, setQuery] = React.useState('')
  const [listening, setListening] = React.useState(false)
  const [recorded, setRecorded] = React.useState<string | null>(null)

  React.useEffect(() => {
    if (!listening) return
    // The same reason the row recorder does it: without this the chord being
    // looked up FIRES, because `registry.tsx` listens in the capture phase.
    const restore = suspendHotkeys()
    const onKeyDown = (event: KeyboardEvent) => {
      event.preventDefault()
      event.stopPropagation()
      if (event.key === 'Escape') { setListening(false); return }
      const candidate = hotkeyFromKeyboardEvent(event, isMac)
      // Modifiers alone are not a keystroke yet: keep listening.
      if (!candidate) return
      setRecorded(candidate)
      setListening(false)
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => {
      window.removeEventListener('keydown', onKeyDown, true)
      restore()
    }
  }, [listening, suspendHotkeys])

  const owners = recorded === null
    ? []
    : actionsOwningHotkey(recorded, actionList.map(action => action.id), id => getHotkey(id as ActionId))

  return (
    <div data-shortcuts-search className="space-y-1.5">
      <div className="flex items-center gap-2">
        <Input
          value={query}
          onChange={event => {
            setQuery(event.target.value)
            onQueryChange(event.target.value)
            // A typed query and a recorded chord are two answers to two
            // questions; showing both at once would say which is stale to
            // nobody, so typing retires the lookup.
            setRecorded(null)
          }}
          placeholder={t('shortcuts.search.placeholder')}
          aria-label={t('shortcuts.search.placeholder')}
        />
        <Button
          type="button"
          variant="secondary"
          size="lg"
          onClick={() => { setRecorded(null); setListening(true) }}
        >
          {listening ? t('shortcuts.search.listening') : t('shortcuts.search.byKeystroke')}
        </Button>
      </div>
      {/*
        `polite` and rendered unconditionally: the answer to "what does this
        chord do" arrives without focus moving, and a live region mounted
        together with its first message is not reliably announced
        (`ReplyAnnouncer`'s measurement, the same one the rebind notice cites).
      */}
      <div role="status" aria-live="polite" className={`min-h-4.5 ${QUIET_TEXT_CLASS}`}>
        {recorded !== null && (owners.length > 0
          ? t('shortcuts.search.owners', {
            keys: formatHotkeyDisplay(recorded, isMac),
            actions: owners.map(id => ACTION_LABEL_KEYS[id as ActionId]
              ? t(ACTION_LABEL_KEYS[id as ActionId]!)
              : id).join(', '),
          })
          // The honest half, and the one the rebind path never says: a chord
          // that runs nothing is an answer, not an empty result.
          : t('shortcuts.search.unbound', { keys: formatHotkeyDisplay(recorded, isMac) }))}
      </div>
    </div>
  )
}

export default function ShortcutsPage() {
  const { t } = useTranslation()
  const componentSpecificSections = useComponentSpecificSections()
  const [query, setQuery] = React.useState('')
  const filtering = query.trim().length > 0
  // Resolved once for the whole page, from the SAME strings the rows render.
  const visible = new Set(filterShortcutEntries(
    actionList.map(action => ({ id: action.id, label: rowLabelFor(action.id as ActionId, t) })),
    query,
  ))
  // C3.317 — the component sections answer the query too, matched on their
  // heading PLUS the row text (see `filterShortcutSections`). With no query this
  // is every section, unchanged.
  const visibleSections = filterShortcutSections(componentSpecificSections, query)
  return (
    <SettingsPage title={t("settings.shortcuts.title")} description={t("settings.shortcuts.description")}>
      {/* Ours (C3.230): the search row is the first thing in the column, above every table it filters. */}
      <ShortcutSearchRow onQueryChange={setQuery} />

      {/* Registry-driven sections */}
      {Object.entries(actionsByCategory).map(([category, categoryActions]) => {
        const rows = categoryActions.filter(action => visible.has(action.id))
        // A category with nothing left is not an empty card: it is gone.
        if (rows.length === 0) return null
        return (
          <SettingsSection key={category} title={t(`shortcuts.category.${category.toLowerCase()}`)}>
            <SettingsCard>
              {rows.map(action => (
                <ActionShortcutRow key={action.id} actionId={action.id as ActionId} />
              ))}
            </SettingsCard>
          </SettingsSection>
        )
      })}

      {/*
        C3.317 — the filter now speaks for BOTH tables, so "nothing
        matched" is only true when neither has a row left. It used to be
        `visible.size === 0` alone, which was the right sentence for a page
        that hid the component sections while filtering and the wrong one
        the moment they started answering.
      */}
      {filtering && visible.size === 0 && visibleSections.length === 0 && (
        <p className={settingsUI.description}>
          {t('shortcuts.search.noMatches', { query })}
        </p>
      )}

      {/* Component-specific sections — searched since C3.317, never rebindable */}
      {visibleSections.length > 0 && (
        <p className={settingsUI.description}>
          {t('shortcuts.componentSectionsNote')}
        </p>
      )}
      {visibleSections.map((section) => (
        <SettingsSection key={section.title} title={section.title}>
          <SettingsCard>
            {section.shortcuts.map((shortcut, index) => (
              <SettingsRow key={index} label={shortcut.description} className={SHORTCUT_ROW_CLASS}>
                <KeyChips keys={shortcut.keys} />
              </SettingsRow>
            ))}
          </SettingsCard>
        </SettingsSection>
      ))}
    </SettingsPage>
  )
}
