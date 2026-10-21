import type { ComponentEntry } from './types'
import { ConfigDoctorView } from '@/pages/settings/SettingsConfigDoctorSection'
import type { ConfigDoctorReportV1 } from '@nessy-agent/shared/config/config-doctor'

// =============================================================================
// Settings → App → "Settings diagnosis" (P6.576)
//
// Three states no developer machine shows on demand, because reaching two of
// them means deploying a managed policy: a clean install, a machine with
// findings, and a host where the diagnosis cannot run at all.
//
// The state worth looking at is `findings`. Every line in it is a fact an
// administrator has no other way to observe — a managed entry REFUSED rather
// than applied, a settings layer rejected WHOLE rather than key by key, and a
// policy file that is on disk, looks deployed, and enforces nothing because a
// delivered payload outranks it. The clean state is the control: it proves the
// section is not just always saying something alarming.
//
// P6.787 adds a SECOND axis, because the closing sentence now has two forms and
// only one of them was reachable here. The playground already renders inside
// `PlaygroundAppShellProvider`, which supplies an active workspace — so the
// workspace-scoped note is what this entry shows by default, and the
// no-workspace note (the one that still discloses a missing section) had no
// state at all.
//
// UB15.8 — the entry renders `ConfigDoctorView`, the section as it draws once
// the read has answered, with the answer and the workspace's name passed in
// (the default export reads both from the shell and the preload). Stubbing the
// preload showed a state only after an effect ran, so the static sweep in
// `registry-render.test.ts` saw the first paint alone; each state is now a
// variant, the first paint (`loading`) included.
// =============================================================================

const CLEAN: ConfigDoctorReportV1 = {
  hasFindings: false,
  text: [
    'Managed settings',
    '  No managed settings source is in effect',
    '',
    'Invalid managed entries',
    '  none',
    '',
    'Rejected settings layers',
    '  none',
  ].join('\n'),
}

const WITH_FINDINGS: ConfigDoctorReportV1 = {
  hasFindings: true,
  text: [
    'Managed settings',
    '  Managed settings (remote)',
    '  cache: /Users/dev/.nessy-agent/managed-delivery.json',
    '  a managed policy file on disk is shadowed and enforces nothing:',
    '  /Library/Application Support/Nessy/managed-policy.json',
    '',
    'Invalid managed entries',
    '  permissions.deny[3]: "Bash(rm -rf /*" — unbalanced parenthesis; the rule was dropped',
    '  cleanupPeriodDays: -1 — not a positive integer; the key was dropped',
    '',
    'Rejected settings layers',
    '  config.json workflow: sizeGuideline "huge" is not one of unrestricted, small, medium, large',
    '',
    'Available models',
    '  enforced: claude-opus-4-6, claude-sonnet-4-6',
  ].join('\n'),
}

type DoctorState = 'clean' | 'findings' | 'unavailable' | 'loading'
type WorkspaceState = 'open' | 'none'

/** The workspace the window has open, by the name the user calls it (the shell supplies it on a page). */
const WORKSPACE_NAME = 'api-gateway'

function ConfigDoctorPreview({
  state = 'findings',
  workspace = 'open',
}: { state?: DoctorState; workspace?: WorkspaceState }) {
  const report = state === 'clean' ? CLEAN : state === 'findings' ? WITH_FINDINGS : null
  // The SettingsPage column's content width (680px less its 28px sides).
  return (
    <div className="w-[624px] max-w-full">
      <ConfigDoctorView
        report={report}
        failed={state === 'unavailable'}
        workspaceName={workspace === 'none' ? undefined : WORKSPACE_NAME}
      />
    </div>
  )
}

export const settingsConfigDoctorComponents: ComponentEntry[] = [
  {
    id: 'settings-config-doctor',
    name: 'Settings diagnosis',
    category: 'Settings',
    description:
      'P6.576: the settings-file tiers read-only, as the same builder `nessy-general-agent doctor` prints — a refused managed entry, a layer rejected whole, and a policy file that is deployed and enforcing nothing',
    component: ConfigDoctorPreview,
    layout: 'top',
    props: [
      {
        name: 'state',
        description: 'Which host answer to render',
        control: {
          type: 'select',
          options: [
            { value: 'findings', label: 'Findings an administrator must act on' },
            { value: 'clean', label: 'Clean install (nothing to act on)' },
            { value: 'unavailable', label: 'The diagnosis could not run' },
            { value: 'loading', label: 'First paint — the read has not answered' },
          ],
        },
        defaultValue: 'findings',
      },
      {
        name: 'workspace',
        description: 'Which closing sentence the page ends on',
        control: {
          type: 'select',
          options: [
            { value: 'open', label: 'A workspace is open (the note names it)' },
            { value: 'none', label: 'No workspace open (one section is disclosed as missing)' },
          ],
        },
        defaultValue: 'open',
      },
    ],
    variants: [
      { name: 'findings', props: { state: 'findings', workspace: 'open' } },
      { name: 'clean', props: { state: 'clean', workspace: 'open' } },
      { name: 'unavailable', props: { state: 'unavailable', workspace: 'open' } },
      { name: 'no-workspace', props: { state: 'findings', workspace: 'none' } },
      { name: 'loading', props: { state: 'loading', workspace: 'open' } },
    ],
  },
]
