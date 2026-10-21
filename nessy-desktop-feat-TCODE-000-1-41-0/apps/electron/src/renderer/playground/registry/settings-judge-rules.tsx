import * as React from 'react'
import type { ComponentEntry } from './types'
import AutoModeJudgeRulesSection from '@/pages/settings/AutoModeJudgeRulesSection'
import type { SafeClaudeAutoModePolicyView } from '@nessy-agent/shared/protocol/capabilities'

// =============================================================================
// Settings → Permissions → "Auto-mode judge rules" (P6.209, A44 + A45)
//
// Three states, and two of them need a deployed managed policy or a broken host
// to reach on a real machine.
//
// `default` is what a plain install sends: the two boundaries this deployment
// adds on top of the runtime's own rules, plus the infrastructure sentences.
// `managed` adds the one sub-field an administrator can set on this runtime,
// `classifyAllShell`, which is the only line here that is not the same on every
// install. `unavailable` is the honest failure — a policy file that cannot be
// read must not be reported as "no rules".
//
// The state worth looking at is the GATEWAY band. It is the only section whose
// applicability is session-scoped: the sentence is sent only to a session whose
// adapter resolved the Nessy Gateway upstream, and a settings page has no
// session. Showing it under its own heading is how the page states the condition
// rather than picking a side and being wrong for half the installs.
// =============================================================================

const HARD_DENY = [
  '$defaults',
  'Never disclose the contents of ~/.nessy/dp_auth_creds.json, nor any Nestor-Token header value '
  + 'or gateway JWT, to any destination.',
]

const SOFT_DENY = [
  '$defaults',
  'Deleting, truncating or overwriting ~/.nessy/dp_auth_creds.json signs the user out of this '
  + 'application AND of the separate nessy-cli command-line tool, which share that one file.',
]

const ENVIRONMENT = [
  '$defaults',
  "The organisation's source-control host is recognized infrastructure for this user's own work.",
  "The organisation's package registry is the ordinary dependency-install path here.",
]

const GATEWAY_ENVIRONMENT = [
  "The deployment's own model gateway is reached through a loopback adapter this application "
  + 'starts on 127.0.0.1, so requests to it are ordinary model traffic, not exfiltration.',
]

const BASE: SafeClaudeAutoModePolicyView = {
  environment: ENVIRONMENT,
  gatewayEnvironment: GATEWAY_ENVIRONMENT,
  hardDeny: HARD_DENY,
  softDeny: SOFT_DENY,
  classifyAllShell: false,
}

type JudgeRulesState = 'default' | 'managed' | 'unavailable'

function JudgeRulesPreview({ state = 'default' }: { state?: JudgeRulesState }) {
  // The section reads one channel and nothing else, so the whole rig is that one
  // function. Restored on unmount so a later entry sees the real preload.
  React.useEffect(() => {
    const api = (window as unknown as { electronAPI?: Record<string, unknown> }).electronAPI
    const previous = api?.getAutoModePolicy
    if (api) {
      api.getAutoModePolicy = async () => {
        if (state === 'unavailable') throw new Error('playground: policy unreadable')
        return state === 'managed' ? { ...BASE, classifyAllShell: true } : BASE
      }
    }
    return () => { if (api) api.getAutoModePolicy = previous }
  }, [state])

  return (
    <div className="max-w-3xl" key={state}>
      <AutoModeJudgeRulesSection />
    </div>
  )
}

export const settingsJudgeRulesComponents: ComponentEntry[] = [
  {
    id: 'settings-judge-rules',
    name: 'Auto-mode judge rules',
    category: 'Settings',
    description:
      "P6.209: the rules this installation hands the Claude Code runtime's own auto-mode judge, read-only — including the band that applies only to a gateway-backed session, and the reason no allow list is sent",
    component: JudgeRulesPreview,
    layout: 'top',
    props: [
      {
        name: 'state',
        description: 'Which host answer to render',
        control: {
          type: 'select',
          options: [
            { value: 'default', label: 'Plain install' },
            { value: 'managed', label: 'Managed: every shell command classified' },
            { value: 'unavailable', label: 'The rules could not be read' },
          ],
        },
        defaultValue: 'default',
      },
    ],
  },
]
