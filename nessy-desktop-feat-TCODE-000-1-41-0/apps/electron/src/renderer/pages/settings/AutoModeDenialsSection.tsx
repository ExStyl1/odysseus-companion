/**
 * P6.209, denominator entry A42 — what the auto-mode judge REFUSED.
 *
 * A42's verdict was claude `partial` for exactly one reason: a typed denial
 * receipt was already minted on every refusal and handed to `onDebug` and
 * nothing else — which in a packaged build has no reader at all, electron-log's
 * transports being disabled there. A session that auto mode had silently
 * narrowed could not be inspected, because the evidence was thrown away one line
 * after it was created. The ring and the read path landed first; this is the
 * surface.
 *
 * ## Three limits, stated rather than implied — the same rule the rules viewer
 * above it follows
 *
 * **It is the chat you have open, and only that one.** The receipts live in a
 * bounded ring on the live agent, so this section is session-scoped inside a
 * workspace-scoped page. With no chat open it says so instead of rendering an
 * empty list that would read as "nothing has ever been refused".
 *
 * **It is this run of the app.** Fifty at most, in memory, gone when the session
 * ends. Calling that a log would be a promise the storage does not keep.
 *
 * **It is Claude Code auto mode only** — and P6.721 moved that fact out of this
 * file. It used to be a static sentence in the scope note, true only because
 * this happened to be the only client; the channel handed every other client a
 * bare list whose emptiness read as "nothing was refused". The ANSWER now
 * carries `supported` and the runtime's name, so this section renders what it
 * was told rather than asserting a runtime claim of its own.
 *
 * ## No retry, and its absence is a decision rather than an omission
 *
 * The row's `done_means` names a retry that re-issues the call under a manual
 * approval. Re-executing a call a safety judge refused is a PRODUCT POSTURE, not
 * a rendering choice, so it is recorded as a proposed row and the default is
 * kept: this surface lists and does not re-issue. The wire shape agrees — the
 * channel has no setter and the safe view carries no `toolUseId` to retry with.
 *
 * ## UB15.7 — on v0.15.1's settings material
 *
 * `AutoModeDenialsList` draws card-ready blocks: each state sentence sits in the in-card padding as a row
 * description, and each refusal is a list row with one hairline between rows (the tool in mono on the label ink,
 * mode and time as tertiary small type, the judge's words as the row description). The scope note is fine print in
 * the card's last block. Still no control anywhere — a viewer, not a retry surface.
 */

import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useAtomValue } from 'jotai'
import { SettingsSection, SettingsCard } from '@/components/settings'
import { settingsUI } from '@/components/settings/SettingsUIConstants'
import { cn } from '@/lib/utils'
import { activeSessionIdAtom } from '@/atoms/sessions'
import type { AutoModeDenialsView, SafeAutoModeDenialView } from '@nessy-agent/shared/protocol/capabilities'

export interface AutoModeDenialsSectionProps {
  workspaceId: string | null
  /** Injected by the playground; the app uses the real bridge. */
  sessionId?: string | null
  load?: (sessionId: string, workspaceId: string) => Promise<AutoModeDenialsView>
}

type LoadState =
  | { kind: 'no-session' }
  | { kind: 'unavailable' }
  // P6.721 — "this runtime keeps no such record", which is a different answer
  // from an empty list and from a failed read.
  | { kind: 'unsupported'; runtime: string }
  | { kind: 'listed'; denials: SafeAutoModeDenialView[] }

/** One state sentence, in the card's padding (UB15.7). */
const STATE_LINE_CLASS = cn(settingsUI.cardPadding, settingsUI.description)

export function AutoModeDenialsList({ state }: { state: LoadState }) {
  const { t } = useTranslation()
  if (state.kind === 'no-session') {
    return <p className={STATE_LINE_CLASS}>{t('settings.permissions.judgeDenials.noSession')}</p>
  }
  if (state.kind === 'unavailable') {
    return <p className={STATE_LINE_CLASS}>{t('settings.permissions.judgeDenials.unavailable')}</p>
  }
  if (state.kind === 'unsupported') {
    return (
      <p className={STATE_LINE_CLASS}>
        {t('settings.permissions.judgeDenials.unsupported', { runtime: state.runtime })}
      </p>
    )
  }
  if (state.denials.length === 0) {
    return <p className={STATE_LINE_CLASS}>{t('settings.permissions.judgeDenials.empty')}</p>
  }
  return (
    <ul className="divide-y divide-separator" data-testid="auto-mode-denials">
      {state.denials.map(denial => (
        <li key={`${denial.deniedAt}-${denial.toolName}`} className="px-3.5 py-2.5">
          <div className="flex items-baseline gap-2">
            <span className="font-mono text-mono-ui font-medium text-foreground">{denial.toolName}</span>
            <span className="text-label-sm text-tertiary">{denial.permissionMode}</span>
            <span className="ml-auto text-label-sm text-tertiary tabular-nums">{denial.deniedAt}</span>
          </div>
          <div className={cn(settingsUI.description, settingsUI.labelDescriptionGap)}>{denial.reason}</div>
        </li>
      ))}
    </ul>
  )
}

export default function AutoModeDenialsSection({ workspaceId, sessionId, load }: AutoModeDenialsSectionProps) {
  const { t } = useTranslation()
  const activeSessionId = useAtomValue(activeSessionIdAtom)
  const resolvedSessionId = sessionId !== undefined ? sessionId : activeSessionId
  const [state, setState] = useState<LoadState>({ kind: 'no-session' })

  const read = useCallback(async () => {
    if (!resolvedSessionId || !workspaceId) {
      setState({ kind: 'no-session' })
      return
    }
    const reader = load ?? ((s: string, w: string) => window.electronAPI.getAutoModeDenials(s, w))
    try {
      const view = await reader(resolvedSessionId, workspaceId)
      // The capability is read BEFORE the length, because an empty list from a
      // runtime that mints none is not the same statement as an empty list from
      // one that does.
      setState(view.supported
        ? { kind: 'listed', denials: view.denials }
        : { kind: 'unsupported', runtime: view.runtime })
    } catch {
      // A refusal is its own state and not an empty list: an empty list would
      // claim the judge refused nothing, which is the one thing this section
      // must never say when it does not know.
      setState({ kind: 'unavailable' })
    }
  }, [load, resolvedSessionId, workspaceId])

  useEffect(() => { void read() }, [read])

  return (
    <SettingsSection title={t('settings.permissions.judgeDenials.title')}>
      <SettingsCard>
        <AutoModeDenialsList state={state} />
        <p className={cn(settingsUI.cardPadding, settingsUI.descriptionSmall)}>
          {t('settings.permissions.judgeDenials.scopeNote')}
        </p>
      </SettingsCard>
    </SettingsSection>
  )
}
