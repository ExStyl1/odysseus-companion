import type { ComponentEntry } from './types'
import { SettingsProvenanceView, type SettingsProvenanceAnswer } from '@/pages/settings/SettingsProvenanceSection'
import type {
  CodexConfigProvenanceV1,
  SettingsProvenanceReportV1,
} from '@nessy-agent/shared/config/config-doctor'
import type { ConnectionProvenanceV1 } from '@nessy-agent/shared/protocol'

// =============================================================================
// Settings → App → "Where settings come from" (P6.168)
//
// Four states this section has and no live machine shows all of: a project
// open, no project open, the managed family present, and the checkup failing.
//
// The state worth looking at is `present-no-keys` — a settings file that EXISTS
// and sets nothing for that family. It is the state a user misreads as "my
// setting is being ignored", it is invisible in any listing that only says
// which files were READ, and separating it from `missing` is most of why this
// view exists.
//
// UB15.8 — the entry renders `SettingsProvenanceView`, the section as it draws
// once the read has answered, with each answer passed in. Stubbing the preload
// showed every state only after an effect ran, so the static sweep in
// `registry-render.test.ts` saw the first paint five times over; now each state
// is its own variant, the first paint (`loading`) included, and the P6.447
// connection pane — on no state before — has its gateway, BYO and
// no-connection answers.
// =============================================================================

const PROJECT = '/Users/dev/work/api-gateway'
const HOME = '/Users/dev'

const WITH_PROJECT: SettingsProvenanceReportV1 = {
  projectDirectory: PROJECT,
  families: [
    {
      id: 'permissions',
      combine: 'last-wins',
      entries: [
        { scope: 'project', file: `${PROJECT}/.nessy-agent/permissions.json`, state: 'supplies' },
        { scope: 'project', file: `${PROJECT}/.claude/settings.json`, state: 'present-no-keys' },
        { scope: 'local', file: `${PROJECT}/.claude/settings.local.json`, state: 'supplies' },
      ],
    },
    {
      id: 'instructionExcludes',
      combine: 'union',
      entries: [
        { scope: 'user', file: `${HOME}/.nessy-agent/config.json`, state: 'supplies' },
        { scope: 'user', file: `${HOME}/.claude/settings.json`, state: 'missing' },
        { scope: 'project', file: `${PROJECT}/.claude/settings.json`, state: 'present-no-keys' },
        { scope: 'local', file: `${PROJECT}/.claude/settings.local.json`, state: 'supplies' },
      ],
    },
    {
      id: 'skillOverrides',
      combine: 'last-wins',
      entries: [
        { scope: 'user', file: `${HOME}/.nessy-agent/config.json`, state: 'present-no-keys' },
        { scope: 'project', file: `${PROJECT}/.claude/settings.json`, state: 'supplies' },
        { scope: 'local', file: `${PROJECT}/.claude/settings.local.json`, state: 'missing' },
      ],
    },
    {
      id: 'managedSettings',
      combine: 'winner-takes-all',
      entries: [
        { scope: 'managed', file: '/Library/Application Support/Nessy/managed-policy.json', state: 'present-no-keys' },
        { scope: 'managed', file: `${HOME}/.nessy-agent/managed-delivery.json`, state: 'supplies' },
      ],
    },
  ],
  claudeChildSettingSources: [
    { scope: 'user', file: `${HOME}/.claude/settings.json`, state: 'missing' },
    { scope: 'project', file: `${PROJECT}/.claude/settings.json`, state: 'present-no-keys' },
    { scope: 'local', file: `${PROJECT}/.claude/settings.local.json`, state: 'supplies' },
  ],
}

const WITHOUT_PROJECT: SettingsProvenanceReportV1 = {
  families: [
    {
      id: 'instructionExcludes',
      combine: 'union',
      entries: [
        { scope: 'user', file: `${HOME}/.nessy-agent/config.json`, state: 'supplies' },
        { scope: 'user', file: `${HOME}/.claude/settings.json`, state: 'missing' },
      ],
    },
    {
      id: 'skillOverrides',
      combine: 'last-wins',
      entries: [{ scope: 'user', file: `${HOME}/.nessy-agent/config.json`, state: 'present-no-keys' }],
    },
  ],
  claudeChildSettingSources: [
    { scope: 'user', file: `${HOME}/.claude/settings.json`, state: 'missing' },
  ],
}

/**
 * P6.169 — the codex section, with the three layer states in one frame.
 *
 * The shape is the measured one (shipped `codex-app-server`, 2026-09-08): a
 * project layer READ AND REFUSED because the project is not trusted, a user
 * layer that supplies, and a system file that does not exist coming back as a
 * layer with no keys. The `not-applied` row is the state worth looking at — it
 * is the one a user has to act on, and it has no equivalent in the four host
 * families above.
 *
 * `effectiveKeyCount` is deliberately far larger than `origins.length`: the
 * real answer explained 2 keys of 97, and the sentence naming that gap is what
 * stops the list reading as "these are all my settings".
 */
const CODEX: CodexConfigProvenanceV1 = {
  layers: [
    {
      kind: 'project',
      label: `${PROJECT}/.codex`,
      state: 'not-applied',
      keys: ['model'],
      disabledReason:
        `To load project-local config, hooks, and exec policies, add ${PROJECT} as a trusted project in `
        + `${HOME}/.codex/config.toml.`,
    },
    {
      kind: 'user',
      label: `${HOME}/.codex/config.toml`,
      state: 'supplies',
      keys: ['model', 'model_reasoning_effort', 'sandbox_mode'],
    },
    { kind: 'system', label: '/etc/codex/config.toml', state: 'present-no-keys', keys: [] },
    { kind: 'sessionFlags', state: 'present-no-keys', keys: [] },
  ],
  origins: [
    { key: 'model', kind: 'user', label: `${HOME}/.codex/config.toml` },
    { key: 'model_reasoning_effort', kind: 'user', label: `${HOME}/.codex/config.toml` },
    { key: 'sandbox_mode', kind: 'user', label: `${HOME}/.codex/config.toml` },
  ],
  effectiveKeyCount: 97,
}

/**
 * P6.447 — the connection pane's answers. The verified gateway is the one endpoint whose requests this product
 * rewrites and signs, so it is the loud line; a BYO endpoint with a proxy in force shows the userinfo-stripped value.
 */
const GATEWAY_CONNECTION: ConnectionProvenanceV1 = {
  connectionSlug: 'nessy-gateway',
  displayName: 'Nessy Gateway',
  baseUrl: 'https://code-completion-nestor.tcsbank.ru/api/v1/cli/openai-like/v1',
  providerLabel: 'Nessy Gateway',
  credentialSource: 'stored-token',
  verifiedGateway: true,
  proxy: null,
}

const BYO_CONNECTION: ConnectionProvenanceV1 = {
  connectionSlug: 'my-endpoint',
  displayName: 'My endpoint',
  baseUrl: 'https://llm.example.internal/v1',
  providerLabel: 'Custom Endpoint',
  credentialSource: 'environment',
  verifiedGateway: false,
  proxy: { name: 'HTTPS_PROXY', value: 'http://proxy.example.internal:3128' },
}

const NO_CONNECTION: ConnectionProvenanceV1 = {
  connectionSlug: null,
  displayName: null,
  baseUrl: null,
  providerLabel: '',
  credentialSource: 'none',
  verifiedGateway: false,
  proxy: null,
}

type ProvenanceState =
  | 'project' | 'no-project' | 'codex' | 'unavailable' | 'loading' | 'gateway' | 'byo' | 'no-connection'

/** The answer the section would hold for each state (`failed` is the checkup that could not run). */
function answerFor(state: ProvenanceState): { report: SettingsProvenanceAnswer; failed: boolean } {
  switch (state) {
    case 'unavailable': return { report: null, failed: true }
    case 'loading': return { report: null, failed: false }
    case 'no-project': return { report: WITHOUT_PROJECT, failed: false }
    case 'codex': return { report: { ...WITH_PROJECT, codex: CODEX }, failed: false }
    case 'gateway': return { report: { ...WITH_PROJECT, connection: GATEWAY_CONNECTION }, failed: false }
    case 'byo': return { report: { ...WITH_PROJECT, connection: BYO_CONNECTION }, failed: false }
    case 'no-connection': return { report: { ...WITHOUT_PROJECT, connection: NO_CONNECTION }, failed: false }
    case 'project': return { report: WITH_PROJECT, failed: false }
  }
}

function ProvenancePreview({ state = 'project' }: { state?: ProvenanceState }) {
  const { report, failed } = answerFor(state)
  // The SettingsPage column's content width (680px less its 28px sides).
  return (
    <div className="w-[624px] max-w-full">
      <SettingsProvenanceView report={report} failed={failed} />
    </div>
  )
}

export const settingsProvenanceComponents: ComponentEntry[] = [
  {
    id: 'settings-provenance',
    name: 'Where settings come from',
    category: 'Settings',
    description:
      'P6.168 + P6.169: the read-only provenance checkup — four families with their scope orders, the second stack a Claude session loads, codex\'s own config layers, and the three states a listing of "files read" cannot show',
    component: ProvenancePreview,
    layout: 'top',
    props: [
      {
        name: 'state',
        description: 'Which host answer to render',
        control: {
          type: 'select',
          options: [
            { label: 'Project open — all four families', value: 'project' },
            { label: 'No project — user and managed scopes only', value: 'no-project' },
            { label: 'Codex layers — one read and NOT applied', value: 'codex' },
            { label: 'Connection — the verified Nessy gateway', value: 'gateway' },
            { label: 'Connection — a BYO endpoint behind a proxy', value: 'byo' },
            { label: 'Connection — none configured', value: 'no-connection' },
            { label: 'Checkup unavailable', value: 'unavailable' },
            { label: 'First paint — the read has not answered', value: 'loading' },
          ],
        },
        defaultValue: 'project',
      },
    ],
    variants: [
      { name: 'project', props: { state: 'project' } },
      { name: 'no-project', props: { state: 'no-project' } },
      { name: 'codex', props: { state: 'codex' } },
      { name: 'gateway', props: { state: 'gateway' } },
      { name: 'byo', props: { state: 'byo' } },
      { name: 'no-connection', props: { state: 'no-connection' } },
      { name: 'unavailable', props: { state: 'unavailable' } },
      { name: 'loading', props: { state: 'loading' } },
    ],
  },
]
