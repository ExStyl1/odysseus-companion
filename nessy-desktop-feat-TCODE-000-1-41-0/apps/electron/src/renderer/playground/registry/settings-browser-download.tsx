import * as React from 'react'
import type { ComponentEntry } from './types'
import type { BrowserDownloadSettingsView } from '../../../shared/types'
// The two primitives by their OWN modules, not through `@/components/settings`.
// The barrel is a bundler concern in the app (vite tree-shakes it) and a 39-second
// import under `bun test`, where nothing does — the measurement and its control
// are recorded in `settings-isolation.tsx`'s header, and this entry's test would
// pay the same cost through the same barrel.
import { SettingsCard } from '@/components/settings/SettingsCard'
import { SettingsInput } from '@/components/settings/SettingsInput'
import { SettingsToggle } from '@/components/settings/SettingsToggle'
import { settingsUI } from '@/components/settings/SettingsUIConstants'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { useTranslation } from 'react-i18next'

// =============================================================================
// Browser download destination (Settings → App → Tools) — P6.564
//
// A design surface for a card whose interesting states are otherwise reachable
// only by setting an environment variable on the host and restarting: the
// environment outranks `config.json`, so the field and the switch can each be
// disabled with a sentence explaining who took them, and a refused value has to
// render as a problem line rather than as a silently saved field.
// =============================================================================

/** Verbatim shapes of what `describeBrowserDownloadSettings` produces. */
const VIEWS: Record<string, BrowserDownloadSettingsView> = {
  unset: {
    root: '',
    ask: false,
    effectiveRoot: '',
    effectiveAsk: false,
    rootFromEnv: false,
    askFromEnv: false,
    problems: [],
  },
  stored: {
    root: '/Users/you/Downloads/nessy',
    ask: true,
    effectiveRoot: '/Users/you/Downloads/nessy',
    effectiveAsk: true,
    rootFromEnv: false,
    askFromEnv: false,
    problems: [],
  },
  'env-root': {
    root: '/Users/you/Downloads/nessy',
    ask: false,
    effectiveRoot: '/srv/agent-downloads',
    effectiveAsk: false,
    rootFromEnv: true,
    askFromEnv: false,
    problems: [],
  },
  'env-both': {
    root: '',
    ask: false,
    effectiveRoot: '/srv/agent-downloads',
    effectiveAsk: true,
    rootFromEnv: true,
    askFromEnv: true,
    problems: [],
  },
  refused: {
    root: 'downloads',
    ask: false,
    effectiveRoot: '',
    effectiveAsk: false,
    rootFromEnv: false,
    askFromEnv: false,
    problems: [
      'config.json browserDownload.root="downloads" is not an absolute path — '
      + 'ignored; downloads keep the session-scoped default',
    ],
  },
  'env-refused': {
    root: '/Users/you/Downloads/nessy',
    ask: false,
    effectiveRoot: '',
    effectiveAsk: false,
    rootFromEnv: true,
    askFromEnv: false,
    problems: [
      'NESSY_BROWSER_DOWNLOAD_DIR="agent-downloads" is not an absolute path — '
      + 'ignored; downloads keep the session-scoped default',
    ],
  },
}

/**
 * The card's note lines on the material `AppSettingsPage` gives them since UB15.5 (its `CARD_NOTE_CLASS`):
 * v0.15.1's in-card padding and prose, spelled the same way here so the twin cannot drift from the page.
 */
const CARD_NOTE_CLASS = cn(settingsUI.cardPadding, settingsUI.prose)

/** The Tools card's download half, exactly as `AppSettingsPage` renders it. */
function BrowserDownloadCard({ state = 'unset' }: { state?: string }) {
  const { t } = useTranslation()
  const view = VIEWS[state] ?? VIEWS.unset!
  // Local only: the playground never writes config.json, so typing here shows
  // the field's own behaviour and nothing else. The Browse button (P6.623) is
  // inert for the same reason — what the design surface has to show is that it
  // goes disabled with the field whenever the environment holds the value, which
  // is the state a running app can only reach by restarting with a variable set.
  const [root, setRoot] = React.useState(view.root)
  React.useEffect(() => setRoot(view.root), [view.root])

  return (
    <div className="w-[560px] max-w-full">
      <SettingsCard>
        <SettingsInput
          label={t('settings.tools.downloadRoot')}
          description={t('settings.tools.downloadRootDesc')}
          value={root}
          onChange={setRoot}
          placeholder={t('settings.tools.downloadRootPlaceholder')}
          disabled={view.rootFromEnv}
          action={(
            <Button variant="secondary" size="md" disabled={view.rootFromEnv}>
              {t('settings.tools.downloadRootBrowse')}
            </Button>
          )}
          inCard
        />
        <SettingsToggle
          label={t('settings.tools.downloadAsk')}
          description={t('settings.tools.downloadAskDesc')}
          checked={view.effectiveAsk}
          onCheckedChange={() => {}}
          disabled={view.askFromEnv}
        />
        {(view.rootFromEnv || view.askFromEnv || view.problems.length > 0) && (
          <div className={CARD_NOTE_CLASS}>
            {view.rootFromEnv && (
              <div>{t('settings.tools.downloadRootFromEnv', {
                value: view.effectiveRoot || t('settings.tools.downloadRootDefault'),
              })}</div>
            )}
            {view.askFromEnv && <div>{t('settings.tools.downloadAskFromEnv')}</div>}
            {view.problems.map(problem => (
              <div key={problem} className="text-destructive">{problem}</div>
            ))}
          </div>
        )}
      </SettingsCard>
    </div>
  )
}

const STATE_OPTIONS: readonly { label: string; value: string }[] = [
  { label: 'Unset (the shipped default)', value: 'unset' },
  { label: 'Set in config.json', value: 'stored' },
  { label: 'Root taken by the environment', value: 'env-root' },
  { label: 'Both taken by the environment', value: 'env-both' },
  { label: 'Stored root refused (relative)', value: 'refused' },
  { label: 'Environment root refused (relative)', value: 'env-refused' },
]

export const settingsBrowserDownloadComponents: ComponentEntry[] = [
  {
    id: 'settings-browser-download',
    name: 'BrowserDownloadCard',
    category: 'Settings',
    description:
      'Browser download folder and ask-each-time (Settings → App → Tools) — stored, '
      + 'overridden by the environment, and refused',
    component: BrowserDownloadCard,
    layout: 'centered',
    props: [
      {
        name: 'state',
        description: 'Which layer decides, and what it was told',
        control: { type: 'select', options: [...STATE_OPTIONS] },
        defaultValue: 'unset',
      },
    ],
    variants: STATE_OPTIONS.map(option => ({ name: option.label, props: { state: option.value } })),
  },
]
