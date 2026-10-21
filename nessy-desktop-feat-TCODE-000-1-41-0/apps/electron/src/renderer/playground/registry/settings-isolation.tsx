import * as React from 'react'
import type { ComponentEntry } from './types'
import type { IsolationNetworkPostureV1 } from '@nessy-agent/core/types'
// P6.607 — the two components by their OWN modules, not through
// `@/components/settings`. The barrel is why this entry's registry test could
// not run: `settings-isolation-registry.test.ts`'s `beforeAll` does one dynamic
// import of THIS module, and under `bun test` that import cost **39 002 ms**
// through the barrel against **27 ms + 34 ms** for the two modules directly
// (both measured 2026-09-06 at load ~12, in a throwaway probe with a 300 s
// budget so the number is the import's and not a timeout's). A barrel is a
// bundler concern in the app, where vite tree-shakes it; under `bun test`
// nothing tree-shakes and the whole settings graph is evaluated for two
// components. So this is the fix rather than a bigger timeout — a budget set
// against a 39 s floor would leave the suite slow AND red the first time the
// graph grows.
import { IsolationNetworkPosture } from '@/components/settings/IsolationNetworkPosture'
import { SettingsToggle } from '@/components/settings/SettingsToggle'
import { SettingsCard } from '@/components/settings/SettingsCard'
import { settingsUI } from '@/components/settings/SettingsUIConstants'
import { cn } from '@/lib/utils'
import { useTranslation } from 'react-i18next'

// =============================================================================
// Isolation network posture (Settings → Permissions → Process Isolation)
//
// A design surface for the egress disclosure, whose states are otherwise only
// reachable by deploying a managed policy on the host. The `unenforceable`
// lines are long, host-authored sentences, so the wrapping case is a state in
// its own right rather than a detail.
// =============================================================================

const NO_DOMAIN_FILTER =
  'no supported isolation backend can filter by domain (sandboxing.md:321 uses a proxy for this;'
  + ' Seatbelt rejects any host but * or localhost, unshare/firejail toggle the whole namespace,'
  + ' and the Windows profile has one network.enabled boolean)'

/** Verbatim shapes of what `resolveSandboxNetworkEnforcement` produces. */
const POSTURES: Record<string, IsolationNetworkPostureV1 | undefined> = {
  open: { egress: 'open', source: 'default', unenforceable: [] },
  'open-unenforceable': {
    egress: 'open',
    source: 'default',
    unenforceable: ['*.example.com', 'pastebin.com'].map(domain =>
      `sandbox.network.deniedDomains "${domain}" is NOT enforced for sandboxed commands:`
      + ` ${NO_DOMAIN_FILTER}. It still applies to Monitor websocket targets.`
      + ' Set sandbox.network.allowManagedDomainsOnly to deny sandboxed egress outright.'),
  },
  denied: { egress: 'denied', source: 'allowManagedDomainsOnly', unenforceable: [] },
  'denied-unenforceable': {
    egress: 'denied',
    source: 'allowManagedDomainsOnly',
    unenforceable: ['registry.npmjs.org'].map(domain =>
      `sandbox.network.allowedDomains "${domain}" is NOT reachable from a sandboxed command:`
      + ` allowManagedDomainsOnly is enforced as a total egress deny because ${NO_DOMAIN_FILTER}.`),
  },
  absent: undefined,
}

/**
 * Shown inside a `<dl>` under a profile row, the way the settings page renders it (UB15.7: the page's isolation
 * card — one hairline-separated group per profile, then the posture group).
 */
function PosturePreview({ state = 'open' }: { state?: string }) {
  return (
    <div className="w-[560px] max-w-full">
      <SettingsCard>
        <dl className="divide-y divide-separator">
          <div className={cn(settingsUI.cardPadding, 'space-y-1')}>
            <div className="flex items-baseline justify-between gap-3">
              <dt className="font-mono text-mono-ui text-foreground">networked</dt>
              <dd className="text-label text-secondary">Available</dd>
            </div>
            <p className={cn(settingsUI.description, '[overflow-wrap:anywhere]')}>seatbelt</p>
          </div>
          <IsolationNetworkPosture posture={POSTURES[state]} />
        </dl>
      </SettingsCard>
    </div>
  )
}

/**
 * P6.327 — the two sandbox switches and the scope notice, whose managed-pinned
 * states are otherwise reachable only by deploying a managed policy on the host.
 * That is the whole reason they are here: "pinned by an administrator" is the
 * state most likely to be got wrong and the one nobody can see locally.
 */
function SandboxSwitchesPreview({ state = 'user' }: { state?: string }) {
  const { t } = useTranslation()
  const enabledManaged = state === 'managed-on' || state === 'managed-off'
  const escapeManaged = state === 'managed-off'
  const enabled = state === 'managed-on' || state === 'on'
  return (
    <div className="w-[560px] max-w-full">
      <SettingsCard>
        <SettingsToggle
          label={t('settings.permissions.sandboxSwitchLabel')}
          description={enabledManaged
            ? t('settings.permissions.sandboxManagedPinned')
            : t('settings.permissions.sandboxSwitchDesc')}
          checked={enabled}
          disabled={enabledManaged}
          onCheckedChange={() => {}}
        />
        <SettingsToggle
          label={t('settings.permissions.sandboxEscapeHatchLabel')}
          description={escapeManaged
            ? t('settings.permissions.sandboxManagedPinned')
            : t('settings.permissions.sandboxEscapeHatchDesc')}
          checked={!escapeManaged}
          disabled={escapeManaged}
          onCheckedChange={() => {}}
        />
        <p className={cn(settingsUI.cardPadding, settingsUI.descriptionSmall)}>
          {t('settings.permissions.sandboxScopeNotice')}
        </p>
      </SettingsCard>
    </div>
  )
}

export const settingsIsolationComponents: ComponentEntry[] = [
  {
    id: 'settings-sandbox-switches',
    name: 'SandboxSwitches',
    category: 'Settings',
    description: 'The two writable sandbox switches under Process Isolation, plus the line naming what the boundary does not cover',
    component: SandboxSwitchesPreview,
    layout: 'centered',
    props: [
      {
        name: 'state',
        description: 'Who decides the switches',
        control: {
          type: 'select',
          options: [
            { label: 'User, off (the shipped default)', value: 'user' },
            { label: 'User, on', value: 'on' },
            { label: 'Pinned on by policy', value: 'managed-on' },
            { label: 'Pinned off, escape hatch locked', value: 'managed-off' },
          ],
        },
        defaultValue: 'user',
      },
    ],
    variants: [
      { name: 'User, off (the shipped default)', props: { state: 'user' } },
      { name: 'User, on', props: { state: 'on' } },
      { name: 'Pinned on by policy', props: { state: 'managed-on' } },
      { name: 'Pinned off, escape hatch locked', props: { state: 'managed-off' } },
    ],
  },
  {
    id: 'settings-isolation-network-posture',
    name: 'IsolationNetworkPosture',
    category: 'Settings',
    description: 'Egress posture disclosure under Process Isolation — open, denied, and the unenforceable-entry states',
    component: PosturePreview,
    layout: 'centered',
    props: [
      {
        name: 'state',
        description: 'Which reported posture to render',
        control: {
          type: 'select',
          options: [
            { label: 'Open (default)', value: 'open' },
            { label: 'Open + unenforceable deniedDomains', value: 'open-unenforceable' },
            { label: 'Denied (allowManagedDomainsOnly)', value: 'denied' },
            { label: 'Denied + unenforceable allowedDomains', value: 'denied-unenforceable' },
            { label: 'Not reported', value: 'absent' },
          ],
        },
        defaultValue: 'open',
      },
    ],
    variants: [
      { name: 'Open (default)', props: { state: 'open' } },
      { name: 'Open + unenforceable deniedDomains', props: { state: 'open-unenforceable' } },
      { name: 'Denied (allowManagedDomainsOnly)', props: { state: 'denied' } },
      { name: 'Denied + unenforceable allowedDomains', props: { state: 'denied-unenforceable' } },
      { name: 'Not reported', props: { state: 'absent' } },
    ],
  },
]
