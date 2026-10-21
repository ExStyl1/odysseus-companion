/**
 * Source: v0.15.1:apps/electron/src/renderer/components/app-shell/input/ComposerHintLine.tsx (UB14.33; ADDED in
 * v0.15.0, craft-agents-oss, Apache-2.0). Taken 1:1 — the look, the reserved height, the focus fade and the two
 * narrow-panel folds — except three hunks of ours:
 *  - the cycle hint's label reads `chat.permissionMode`, the name F1.358 gave upstream's `mode.permissionMode`
 *    (`ComposerModeChip` and `CompactPermissionModeSelector` read it too), so no second key says the same thing;
 *  - `cycleHotkey`: the binding the user actually has. Our registry HAS user overrides (P6.49), so the caller passes
 *    `getHotkey('chat.cyclePermissionMode')` exactly as `ComposerModeChip`'s footer does (UB14.29); `null` (unbound)
 *    draws no cycle hint. Left undefined (no `ActionRegistryProvider`), the shipped default shows, as upstream's does;
 *  - `sendMessageKey`: pins the send key instead of reading the setting, for the playground and tests (a static
 *    render runs no effect, so it never reads one); the app passes nothing and the setting decides.
 */
import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Kbd, KbdGroup } from '@/components/ui/kbd'
import { actionHotkeyKeys, composerSendKeys, hotkeyKeycaps } from './action-hotkey'

function Hint({ keys, label }: { keys: string[]; label: string }) {
  return (
    <span className="inline-flex items-center gap-1">
      <KbdGroup>
        {keys.map((key, i) => <Kbd key={`${key}-${i}`}>{key}</Kbd>)}
      </KbdGroup>
      {label}
    </span>
  )
}

export interface ComposerHintLineProps {
  /** Keep the reserved space but show nothing (decision prompts) */
  empty?: boolean
  /** The cycle action's binding as the registry resolves it; `null` = unbound (no hint); undefined = shipped default */
  cycleHotkey?: string | null
  /** Pin the send key instead of reading the Send-message-key setting (playground, tests) */
  sendMessageKey?: 'enter' | 'cmd-enter'
}

/**
 * Shortcut hints under the composer (spec §7.5, mockup `.cx-hints`), desktop only: the keys that
 * already exist — send and new line (per the Send-message-key setting) and ⇧Tab to cycle the
 * permission mode. Its height is always reserved and it fades in only while focus is inside the
 * composer card (`peer/composer` on InputContainer), so nothing shifts.
 */
export function ComposerHintLine({ empty = false, cycleHotkey, sendMessageKey: pinnedSendKey }: ComposerHintLineProps) {
  const { t } = useTranslation()
  const [sendMessageKey, setSendMessageKey] = React.useState<'enter' | 'cmd-enter'>('enter')

  // Same setting FreeFormInput reads for its key handling, so the hint always matches it
  React.useEffect(() => {
    if (pinnedSendKey) return
    let cancelled = false
    window.electronAPI?.getSendMessageKey?.()
      .then((key) => { if (!cancelled) setSendMessageKey(key ?? 'enter') })
      .catch(() => {})
    return () => { cancelled = true }
  }, [pinnedSendKey])

  const sendKeys = composerSendKeys(pinnedSendKey ?? sendMessageKey)
  const cycleKeys = cycleHotkey === undefined ? actionHotkeyKeys('chat.cyclePermissionMode') : hotkeyKeycaps(cycleHotkey)

  return (
    <div
      aria-hidden="true"
      data-composer-hints
      // 10px below the card (mt-2.5 + centred 20px keycaps), not glued to it
      className="mt-2.5 flex h-6 items-center justify-center gap-3.5 overflow-hidden text-label-sm text-tertiary whitespace-nowrap select-none opacity-0 transition-opacity duration-fast ease-out peer-focus-within/composer:opacity-100"
    >
      {!empty && (
        <>
          <Hint keys={sendKeys.send} label={t('shortcuts.sendMessage')} />
          {/* Narrow panels keep only the hints that fit, instead of clipping both ends */}
          <span className="contents @max-[24rem]/panel:hidden">
            <Hint keys={sendKeys.newLine} label={t('shortcuts.newLine')} />
          </span>
          {cycleKeys.length > 0 && (
            <span className="contents @max-[32rem]/panel:hidden">
              <Hint keys={cycleKeys} label={t('chat.permissionMode')} />
            </span>
          )}
        </>
      )}
    </div>
  )
}
