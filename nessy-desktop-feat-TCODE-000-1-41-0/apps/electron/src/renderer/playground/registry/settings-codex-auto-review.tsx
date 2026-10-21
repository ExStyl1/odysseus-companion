import * as React from 'react'
import type { ComponentEntry } from './types'
// The primitives by their OWN modules, not through `@/components/settings` —
// the barrel is a bundler concern in the app and a 39-second import under
// `bun test`, where nothing tree-shakes it. The measurement and its control are
// in `settings-isolation.tsx`'s header.
import { SettingsSection } from '@/components/settings/SettingsSection'
import { SettingsCard } from '@/components/settings/SettingsCard'
import { SettingsToggle } from '@/components/settings/SettingsToggle'
import { SettingsTextarea } from '@/components/settings/SettingsTextarea'
import { useTranslation } from 'react-i18next'

// =============================================================================
// Codex auto-review (Settings → AI) — P6.225
//
// A design surface for a section whose states were otherwise reachable only by
// hand-editing `~/.nessy-agent/config.json` and restarting: the reviewer is
// codex's own, fully wired below this page, and until this row there was no
// control at all.
//
// The three states are the whole design question. OFF hides the policy field,
// because a policy that governs nothing is a field that invites a paragraph
// nobody reads. ON with an EMPTY policy is the honest default — codex's own
// policy, unchanged — and the placeholder has to read as an example rather than
// as a value already in force. ON with a policy is the only state where this
// install has said something codex would not have said by itself.
// =============================================================================

const SAMPLE_POLICY = [
  'Never approve a command that writes outside the project folder.',
  'Never approve a network call to a host that is not on the allow list.',
  'Approve read-only inspection of files already inside the workspace.',
].join('\n')

type CodexAutoReviewState = 'off' | 'on-default-policy' | 'on-custom-policy'

function CodexAutoReviewPreview({ state = 'off' }: { state?: CodexAutoReviewState }) {
  const { t } = useTranslation()
  const [enabled, setEnabled] = React.useState(state !== 'off')
  const [policy, setPolicy] = React.useState(state === 'on-custom-policy' ? SAMPLE_POLICY : '')

  // The knob re-seeds both fields, so switching states in the sidebar shows the
  // state that was asked for rather than whatever the last click left behind.
  React.useEffect(() => {
    setEnabled(state !== 'off')
    setPolicy(state === 'on-custom-policy' ? SAMPLE_POLICY : '')
  }, [state])

  return (
    <div className="max-w-3xl">
      <SettingsSection
        title={t('settings.ai.codexAutoReview.title')}
        description={`${t('settings.ai.codexAutoReview.description')} ${t('settings.ai.codexAutoReview.scopeNote')}`}
      >
        <SettingsCard>
          <SettingsToggle
            label={t('settings.ai.codexAutoReview.enabledLabel')}
            description={t('settings.ai.codexAutoReview.enabledDesc')}
            checked={enabled}
            onCheckedChange={setEnabled}
          />
          {enabled && (
            <SettingsTextarea
              label={t('settings.ai.codexAutoReview.policyLabel')}
              description={t('settings.ai.codexAutoReview.policyDesc')}
              value={policy}
              onChange={setPolicy}
              placeholder={t('settings.ai.codexAutoReview.policyPlaceholder')}
              rows={4}
              inCard
            />
          )}
        </SettingsCard>
      </SettingsSection>
    </div>
  )
}

export const settingsCodexAutoReviewComponents: ComponentEntry[] = [
  {
    id: 'settings-codex-auto-review',
    name: 'Codex auto-review',
    category: 'Settings',
    description:
      "P6.225: codex's own approval reviewer, which was fully wired and reachable only by hand-editing a config file — the toggle, the policy field it reveals, and the scope note that keeps it apart from the Pi-only Guardian judge above it",
    component: CodexAutoReviewPreview,
    layout: 'top',
    props: [
      {
        name: 'state',
        description: 'Which of the three states to render',
        control: {
          type: 'select',
          options: [
            { value: 'off', label: 'Off (no policy field)' },
            { value: 'on-default-policy', label: "On — codex's own policy" },
            { value: 'on-custom-policy', label: 'On — this install added rules' },
          ],
        },
        defaultValue: 'off',
      },
    ],
    // UB15.11 — the two on-states as variants, so the registry render sweeps all three (dark).
    variants: [
      { name: "On — codex's own policy", props: { state: 'on-default-policy' } },
      { name: 'On — this install added rules', props: { state: 'on-custom-policy' } },
    ],
  },
]
