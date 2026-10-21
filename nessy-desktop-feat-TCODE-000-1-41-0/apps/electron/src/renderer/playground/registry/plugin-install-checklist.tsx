/**
 * Playground registry for the POST-INSTALL SETUP CHECKLIST (T3, plugin-install
 * plan § 4).
 *
 * The knobs are the row classes, because each is a distinct design decision:
 *
 * * the dp row is ACTIONABLE (one system sign-in unblocks N servers);
 * * the userConfig row is ACTIONABLE (opens the enable-time prompt);
 * * connector rows are INFORMATIONAL by owner decision § 0b-2 — they carry NO
 *   OAuth button and point at the session-start notice;
 * * the environment row is informational.
 *
 * IPC-free: sign-in/configure callbacks are no-ops; `dpState` is a knob so the
 * busy/done/error states render without a real dp binary.
 */

import * as React from 'react'
import {
  PluginInstallChecklist,
  type ChecklistDpState,
  type PluginSetupChecklist,
} from '@/components/plugins/PluginInstallChecklist'
import type { ComponentEntry } from './types'

interface ChecklistKnobs {
  dpServers: number
  connectors: number
  userConfigMissing: number
  environment: boolean
  dpState: string
}

function buildChecklist(knobs: ChecklistKnobs): PluginSetupChecklist {
  const dpServerNames = Array.from(
    { length: Math.max(0, knobs.dpServers) },
    (_, index) => `dp-server-${index + 1}`,
  )
  const connectors = Array.from(
    { length: Math.max(0, knobs.connectors) },
    (_, index) => ({ serverName: `connector-${index + 1}`, sourceSlug: `connector-${index + 1}` }),
  )
  const environment = knobs.environment
    ? { serverNames: ['env-server'], requiredNames: ['SERVICE_TOKEN', 'SERVICE_URL'] }
    : undefined
  const named = new Set<string>([
    ...dpServerNames,
    ...connectors.map(connector => connector.serverName),
    ...(environment?.serverNames ?? []),
  ])
  return {
    ...(dpServerNames.length > 0 ? { dp: { serverNames: dpServerNames } } : {}),
    ...(knobs.userConfigMissing > 0
      ? {
          userConfig: {
            missingCount: knobs.userConfigMissing,
            configuration: {
              state: 'needs_configuration',
              fields: Array.from({ length: knobs.userConfigMissing }, (_, index) => ({
                key: `option_${index + 1}`,
                valueType: 'string' as const,
                required: true,
                hasDefault: false,
                configured: false,
                missing: true,
                sensitive: false,
              })),
            },
          },
        }
      : {}),
    connectors,
    ...(environment ? { environment } : {}),
    serversNeedingSetup: named.size,
  }
}

function ChecklistPreview(knobs: ChecklistKnobs) {
  return (
    <PluginInstallChecklist
      state={{
        pluginKey: 'nessy.default-extension',
        workspaceId: 'ws-preview',
        displayName: 'Nessy Default Extension',
        checklist: buildChecklist(knobs),
      }}
      dpState={(knobs.dpState as ChecklistDpState) ?? 'pending'}
      onDismiss={() => {}}
      onDpSignIn={() => {}}
      onConfigure={() => {}}
    />
  )
}

const KNOBS: ComponentEntry['props'] = [
  { name: 'dpServers', description: 'dp-backed servers one Developer Platform sign-in unblocks (0 hides the row)', control: { type: 'number', min: 0, max: 14 }, defaultValue: 9 },
  { name: 'connectors', description: 'OAuth connector servers that will ask at first use — informational rows, NO buttons (§ 0b-2)', control: { type: 'number', min: 0, max: 14 }, defaultValue: 3 },
  { name: 'userConfigMissing', description: 'Declared userConfig keys still missing a value (0 hides the row)', control: { type: 'number', min: 0, max: 8 }, defaultValue: 1 },
  { name: 'environment', description: 'A server needing environment/credential values before it can start', control: { type: 'boolean' }, defaultValue: false },
  { name: 'dpState', description: 'The dp sign-in action state', control: { type: 'select', options: [
    { label: 'pending', value: 'pending' },
    { label: 'busy', value: 'busy' },
    { label: 'done', value: 'done' },
    { label: 'error', value: 'error' },
  ] }, defaultValue: 'pending' },
]

export const pluginInstallChecklistComponents: ComponentEntry[] = [
  {
    id: 'plugin-install-checklist',
    name: 'Plugin Install Checklist',
    category: 'Marketplace',
    description:
      'The post-install setup checklist (plugin-install plan § 4): dp sign-in and userConfig actionable, connector rows informational pointing at the session-start notice, nothing blocking.',
    component: ChecklistPreview,
    layout: 'centered',
    props: KNOBS,
    variants: [
      { name: 'nessy-default-extension', description: 'The measured defect case: 9 dp servers, 3 first-use connectors, 1 config value', props: { dpServers: 9, connectors: 3, userConfigMissing: 1, environment: false, dpState: 'pending' } },
      { name: 'dp signed in', description: 'After the one-click system sign-in — the row flips, no chat message was sent', props: { dpServers: 9, connectors: 3, userConfigMissing: 0, environment: false, dpState: 'done' } },
      { name: 'dp sign-in failed', description: 'The retryable failure state; everything stays reachable later', props: { dpServers: 9, connectors: 0, userConfigMissing: 0, environment: false, dpState: 'error' } },
      { name: 'Connectors only', description: 'Pure informational checklist — Claude\'s no-chaining-at-install contract', props: { dpServers: 0, connectors: 3, userConfigMissing: 0, environment: false, dpState: 'pending' } },
      { name: 'Environment values', description: 'A server that needs environment values before it can start', props: { dpServers: 0, connectors: 0, userConfigMissing: 2, environment: true, dpState: 'pending' } },
    ],
  },
]
