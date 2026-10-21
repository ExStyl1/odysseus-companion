import type { ComponentEntry } from './types'
import { OnboardingFlowDemo } from '../demos/OnboardingFlowDemo'
import { ClaudeImportPanel } from '@/components/import/ClaudeImportPanel'
import type { ClaudeSetupImportPlan, ClaudeSetupImportResult } from '@nessy-agent/shared/capabilities/claude-setup-import'
import { ProviderSelectStep } from '@/components/onboarding/ProviderSelectStep'
import { WelcomeStep } from '@/components/onboarding/WelcomeStep'
import { APISetupStep } from '@/components/onboarding/APISetupStep'
import { CredentialsStep } from '@/components/onboarding/CredentialsStep'
import { CompletionStep } from '@/components/onboarding/CompletionStep'
import { GitBashWarning, type GitBashStatus } from '@/components/onboarding/GitBashWarning'
import { LocalModelStep } from '@/components/onboarding/LocalModelStep'
import { ReauthScreen } from '@/components/onboarding/ReauthScreen'
import { ByoRuntimeStep } from '@/components/onboarding/ByoRuntimeStep'
import { GatewayConnectStepView } from '@/components/onboarding/GatewayConnectStep'
import { ModelCatalogPicker } from '@/components/apisetup/ModelCatalogPicker'
import type { ModelDefinition } from '@nessy-agent/shared/config'
import { OnboardingWizard } from '@/components/onboarding/OnboardingWizard'
import type { OnboardingState } from '@/components/onboarding/OnboardingWizard'
import {
  NESSY_GATEWAY_BASE_URL,
  NESSY_GATEWAY_MODEL_IDS,
  NESSY_GATEWAY_PRESET_KEY,
} from '@/components/apisetup/nessy-gateway'
import type { ApiKeySubmitData } from '@/components/apisetup'

const createOnboardingState = (overrides: Partial<OnboardingState> = {}): OnboardingState => ({
  step: 'welcome',
  loginStatus: 'idle',
  credentialStatus: 'idle',
  completionStatus: 'complete',
  apiSetupMethod: null,
  isExistingUser: false,
  gitBashStatus: { found: false, path: null, platform: 'win32' },
  isRecheckingGitBash: false,
  isCheckingGitBash: false,
  ...overrides,
})

const noopHandler = () => console.log('[Playground] Action triggered')

/**
 * UB14.40 — a published catalog for the model picker: three families, one model
 * with no context size, so every badge the picker draws has a row to sit on.
 */
const catalogModel = (id: string, contextWindow: number, description = ''): ModelDefinition => ({
  id,
  name: id,
  shortName: id,
  description,
  provider: 'pi',
  contextWindow,
})
const PICKER_CATALOG: ModelDefinition[] = [
  catalogModel('tgpt/qwen3-235b-a22b', 131072, 'Qwen3 MoE'),
  catalogModel('tgpt/qwen3-next-80b-a3b-instruct', 262144),
  catalogModel('tgpt/t-pro-it-2-1-fp8', 32768, 'T-Pro'),
  catalogModel('tgpt/t-lite-it-1-0-llm-proxy', 32768),
  catalogModel('claude-sonnet-4-6', 200000, 'Anthropic wire'),
  catalogModel('tgpt/embed-large', 0, 'Embeddings'),
]
const PICKER_SELECTED = ['tgpt/qwen3-235b-a22b', 'tgpt/t-pro-it-2-1-fp8']

/**
 * P2.9 — the dry-run plan shapes the import screen has to render. One fixture
 * per CANONICAL STATE rather than per field: a populated preview (every artifact
 * kind, with the create/merge/conflict badge each one produces), a
 * nothing-to-import scan, and a preview whose targets already exist. The panel
 * is pure, so these props ARE the states.
 */
const claudeImportPlan = (
  overrides: Partial<ClaudeSetupImportPlan> = {},
): ClaudeSetupImportPlan => ({
  claudeDir: '/Users/you/.claude',
  workspaceRootPath: '/Users/you/.nessy-agent/workspaces/default',
  changes: [],
  warnings: [],
  empty: false,
  ...overrides,
})

const claudeImportFullPlan = claudeImportPlan({
  changes: [
    { kind: 'instruction', action: 'merge', name: 'CLAUDE.md', target: 'AGENTS.md', detail: '42 lines' },
    { kind: 'permission', action: 'merge', name: 'Permission rules', target: 'permissions.json', detail: '7 rule(s)' },
    { kind: 'skill', action: 'create', name: 'commit-helper', target: 'skills/commit-helper' },
    { kind: 'skill', action: 'create', name: 'review-pr', target: 'skills/review-pr' },
    { kind: 'mcp', action: 'create', name: 'filesystem', target: 'sources/filesystem', detail: 'stdio' },
    { kind: 'mcp', action: 'create', name: 'linear', target: 'sources/linear', detail: 'http' },
    { kind: 'hook', action: 'create', name: 'Hooks', target: 'hooks.json', detail: 'PreToolUse, SessionEnd' },
  ],
})

const claudeImportConflictPlan = claudeImportPlan({
  changes: [
    { kind: 'instruction', action: 'merge', name: 'CLAUDE.md', target: 'AGENTS.md', detail: '42 lines' },
    { kind: 'skill', action: 'conflict', name: 'commit-helper', target: 'skills/commit-helper' },
    { kind: 'mcp', action: 'conflict', name: 'filesystem', target: 'sources/filesystem', detail: 'stdio' },
  ],
  warnings: ['MCP server "broken" has no usable stdio command or http/sse url; skipped.'],
})

const claudeImportResult = (
  overrides: Partial<ClaudeSetupImportResult> = {},
): ClaudeSetupImportResult => ({ applied: [], skipped: [], errors: [], ...overrides })

export const onboardingComponents: ComponentEntry[] = [
  /**
   * P2.9 — the Settings → Import screen and the optional onboarding import step
   * render the SAME panel, so one playground entry sweeps both. The variants are
   * the states the row spec names: the dry-run preview, nothing-to-import, and a
   * conflict (a skill / MCP source that already exists is never overwritten).
   */
  {
    id: 'claude-import-panel',
    name: 'Claude Code import (dry-run preview)',
    category: 'Onboarding',
    description: 'Import a Claude Code setup (~/.claude): instructions, settings.json permissions, skills, MCP servers, hooks. The preview is computed BEFORE anything is written and the write is one confirmed step, so cancelling from this screen writes nothing. Badges: Add (new), Merge (additive/idempotent), Conflict (target exists, left untouched).',
    component: ClaudeImportPanel,
    props: [],
    variants: [
      { name: 'Idle (before scan)', props: { status: 'idle' } },
      { name: 'Scanning', props: { status: 'scanning' } },
      { name: 'Dry-run preview (all kinds)', props: { status: 'preview', plan: claudeImportFullPlan } },
      { name: 'Nothing to import', props: { status: 'preview', plan: claudeImportPlan({ empty: true }) } },
      { name: 'Conflicts + warning', props: { status: 'preview', plan: claudeImportConflictPlan } },
      { name: 'Importing', props: { status: 'importing' } },
      {
        name: 'Done',
        props: {
          status: 'done',
          result: claudeImportResult({
            applied: claudeImportFullPlan.changes,
            skipped: [claudeImportConflictPlan.changes[1]!],
          }),
        },
      },
      {
        // P6.654 — an import can WRITE a server and still leave it unable to run.
        name: 'Done — something needs authentication',
        description: 'Two MCP servers landed switched off because their env vars / headers were not carried. The review card names them on the screen the user lands on, with what to do next.',
        props: {
          status: 'done',
          result: claudeImportResult({
            applied: [
              ...claudeImportFullPlan.changes.filter(change => change.kind !== 'mcp'),
              {
                kind: 'mcp', action: 'create', name: 'github', target: 'sources/github', needsAuth: true,
                detail: 'stdio · imported disabled: it declares environment variables or headers that were not carried; add them in Sources, then enable it',
              },
              {
                kind: 'mcp', action: 'create', name: 'linear', target: 'sources/linear', needsAuth: true,
                detail: 'http · imported disabled: it declares environment variables or headers that were not carried; add them in Sources, then enable it',
              },
            ],
          }),
        },
      },
      {
        name: 'Error',
        props: { status: 'error', errorMessage: 'Select a workspace before importing.' },
      },
    ],
    mockData: () => ({
      status: 'preview' as const,
      plan: claudeImportFullPlan,
      onScan: noopHandler,
      onImport: noopHandler,
      onCancel: noopHandler,
    }),
    layout: 'full',
  },
  /**
   * E4, restated for v2 (G2) — the merged personal-key form, one entry per
   * state that changes its SHAPE rather than one per field. The sweep these
   * exist for is the owner's sizing requirement: the catalog-open entry must
   * show a dialog that GREW and a model list that scrolls inside its own
   * container, at normal and compact widths, dark first.
   *
   * v2 removed four controls from this form, so the states that used to differ
   * by control now differ by CONTEXT: create vs edit, and where the connection
   * points. The entries below are those states.
   */
  {
    id: 'byo-runtime-merged-pi-custom',
    name: 'Merged form — create (v2)',
    category: 'Onboarding',
    description: 'What a new connection looks like in v2: runtime radio, key, models, catalog, utility model. No endpoint field (hardcoded), no preset, no protocol, no dialect, no sync toggle — the runtime radio picks the harness and nothing else restructures the form.',
    component: ByoRuntimeStep,
    props: [],
    variants: [],
    mockData: () => ({
      // Seventeen picked models, the count from the owner's own live walk —
      // the state that made the chip row wrap to ten rows and pushed every
      // control below the fold. This entry exists to keep it one scrolling row.
      initialValues: {
        models: [
          'tgpt/qwen35-397b-a17b-fp8', 'tgpt/qwen3-235b-a22b', 'tgpt/t-pro-it-2-1-fp8',
          'tgpt/t-lite-it-1-0-llm-proxy', 'tgpt/qwen3-next-80b-a3b-instruct',
          'tgpt/qwen3-235b-a22b-instruct-2507', 'tgpt/t-pro-it-1-2-fp8',
          'tgpt/qwen36-35b-a3b-fp8', 'tgpt/context-intents-summ', 'tgpt/embed-large',
          'tgpt/rerank-multilingual', 'tgpt/whisper-large-v3', 'tgpt/t-banking-it',
          'tgpt/t-code-it', 'tgpt/t-vision-it', 'tgpt/t-guard-it', 'tgpt/t-summ-it',
        ].join(', '),
      },
      onSubmit: (data: unknown) => console.log('[Playground] merged submit', data),
      onBack: noopHandler,
    }),
    // `full` because the OWNER'S SIZING REQUIREMENT is only observable in a pane
    // wider than the form's own cap. In the default preview pane (~251 px) the
    // dialog's `max-w-3xl` is applied and provably in the DOM, but the rendered
    // width cannot change — and a width that cannot change is not evidence that
    // it changed. Measured 2026-08-14 before this line was added.
    layout: 'full',
  },
  {
    id: 'byo-runtime-merged-pi-official',
    name: 'Merged form — Pi / official preset',
    category: 'Onboarding',
    description: 'Anthropic preset: endpoint, models, catalog and utility model are all HIDDEN. The blank baseUrl is what the server reset path keys on, and the server installs the provider catalog itself.',
    component: ByoRuntimeStep,
    props: [],
    variants: [],
    mockData: () => ({
      initialValues: { preset: 'anthropic' as const },
      onSubmit: (data: unknown) => console.log('[Playground] merged submit', data),
      onBack: noopHandler,
    }),
  },
  {
    id: 'byo-runtime-merged-anthropic-protocol',
    name: 'Merged form — edit of an anthropic-messages connection',
    category: 'Onboarding',
    description: 'Unreachable from CREATE in v2 (the protocol is pinned to openai-completions) and still reachable by EDIT, which is the point: no catalog block at all, replaced by the helper line, because that /v1/models carries no context length. The stored protocol round-trips untouched.',
    component: ByoRuntimeStep,
    props: [],
    variants: [],
    mockData: () => ({
      isEditing: true,
      initialValues: {
        preset: 'custom' as const,
        customApi: 'anthropic-messages' as const,
        baseUrl: 'https://llm-proxy.example.com',
      },
      onSubmit: (data: unknown) => console.log('[Playground] merged submit', data),
      onBack: noopHandler,
    }),
  },
  {
    id: 'byo-runtime-merged-edit-locked',
    name: 'Merged form — edit, foreign URL shown disabled',
    category: 'Onboarding',
    description: 'The Edit path with the v2 endpoint rule: this connection points somewhere other than the hardcoded URL, so the field APPEARS and is read-only — visible so the user knows where it goes, not editable because this form cannot express a change to it. The arm selector is gone and the stored key arrives MASKED (GET_API_KEY masks for every caller) and counts as present.',
    component: ByoRuntimeStep,
    props: [],
    variants: [],
    mockData: () => ({
      lockedArm: 'claude-runtime' as const,
      isEditing: true,
      initialValues: {
        baseUrl: 'https://llm-proxy.example.com',
        apiKey: 'sk-ab\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u20221234',
        models: 'deepseek-v3, deepseek-r1',
        miniModel: 'deepseek-r1',
        syncModelsFromEndpoint: true,
      },
      onSubmit: (data: unknown) => console.log('[Playground] merged submit', data),
      onBack: noopHandler,
    }),
  },
  {
    id: 'gateway-connect-step',
    name: 'GatewayConnectStep',
    category: 'Onboarding',
    description: 'The zero-form step behind every Nessy Gateway card (UB14.40): the running line as the lede, the spinner, the copy-the-link hint while dp waits for a browser, the dp hints, and a failure in the destructive tint well with Back and Retry. The view takes its state as props; the live step derives it from the dp sign-in.',
    component: GatewayConnectStepView,
    props: [
      {
        name: 'kind',
        description: 'Which gateway card started it',
        control: { type: 'select', options: [
          { label: 'Pi', value: 'pi' },
          { label: 'Nestor Cloud', value: 'cloud' },
          { label: 'Codex', value: 'codex' },
          { label: 'Claude Code', value: 'claude' },
        ] },
        defaultValue: 'pi',
      },
      {
        name: 'status',
        description: 'The running state (ignored once there is an error)',
        control: { type: 'select', options: [
          { label: 'Connecting', value: 'connecting' },
          { label: 'Waiting for the browser', value: 'waiting-browser' },
          { label: 'Creating the connection', value: 'creating-connection' },
        ] },
        defaultValue: 'connecting',
      },
      { name: 'authUrl', description: 'The link dp handed its browser', control: { type: 'string' }, defaultValue: '' },
      { name: 'dpOutdated', description: 'The dp-outdated hint', control: { type: 'boolean' }, defaultValue: false },
      { name: 'dpUnrunnable', description: 'The dp-unrunnable hint', control: { type: 'boolean' }, defaultValue: false },
      { name: 'errorMessage', description: 'A failure, in words', control: { type: 'string' }, defaultValue: '' },
    ],
    variants: [
      { name: 'Connecting', props: { status: 'connecting' } },
      { name: 'Waiting for the browser, with the link', props: { status: 'waiting-browser', authUrl: 'https://auth.example.invalid/oauth2/auth?state=playground' } },
      { name: 'Waiting, both dp hints', props: { status: 'waiting-browser', authUrl: 'https://auth.example.invalid/oauth2/auth?state=playground', dpOutdated: true, dpUnrunnable: true } },
      { name: 'Creating the connection (Codex)', props: { kind: 'codex', status: 'creating-connection' } },
      { name: 'Sign-in failed (Claude Code)', props: { kind: 'claude', errorMessage: 'The dp CLI was not found. Install dp, then try again.' } },
    ],
    mockData: () => ({
      onDismissHints: noopHandler,
      onBack: noopHandler,
      onCancel: noopHandler,
      onRetry: noopHandler,
    }),
  },
  {
    id: 'model-catalog-picker',
    name: 'ModelCatalogPicker',
    category: 'Onboarding',
    description: 'The personal-key form\'s catalog list on its own (UB14.40): the placeholder before Fetch, a fetched catalog with Check access, a probe still streaming (pending rows keep their family), and a finished probe that sorts the barred models into the collapsed Unavailable group. Marks on the status tints, the context size on the neutral fill.',
    component: ModelCatalogPicker,
    props: [],
    variants: [
      { name: 'Before Fetch (placeholder)', props: { catalog: [], selectedIds: [] } },
      { name: 'Fetched, no probe (Check access)', props: { catalog: PICKER_CATALOG, selectedIds: PICKER_SELECTED } },
      {
        name: 'Probe streaming',
        props: {
          catalog: PICKER_CATALOG,
          selectedIds: PICKER_SELECTED,
          onProbeSelected: undefined,
          probes: { 'tgpt/qwen3-235b-a22b': 'ok', 'tgpt/t-pro-it-2-1-fp8': 'ok', 'tgpt/embed-large': 'unsupported-endpoint' },
          probeProgress: { done: 3, total: 6 },
        },
      },
      {
        name: 'Probed: available and unavailable',
        props: {
          catalog: PICKER_CATALOG,
          selectedIds: PICKER_SELECTED,
          onProbeSelected: undefined,
          probes: {
            'tgpt/qwen3-235b-a22b': 'ok',
            'tgpt/qwen3-next-80b-a3b-instruct': 'no-quota',
            'tgpt/t-pro-it-2-1-fp8': 'ok',
            'tgpt/t-lite-it-1-0-llm-proxy': 'ok',
            'claude-sonnet-4-6': 'wrong-runtime',
            'tgpt/embed-large': 'error',
          },
        },
      },
    ],
    mockData: () => ({
      catalog: PICKER_CATALOG,
      selectedIds: PICKER_SELECTED,
      onSelectionChange: (ids: string[]) => console.log('[Playground] picker selection', ids),
      onProbeSelected: noopHandler,
    }),
    layout: 'top',
  },
  {
    id: 'onboarding-flow-demo',
    name: 'Onboarding Flow (Interactive)',
    category: 'Onboarding',
    description: 'Click through the full onboarding: Welcome → Provider → Credentials → Done',
    component: OnboardingFlowDemo,
    props: [],
    variants: [],
    layout: 'full',
  },
  {
    id: 'provider-select-step',
    name: 'ProviderSelectStep',
    category: 'Onboarding',
    description: 'First-launch screen — pick your subscription or API key. Shows every card: the mocked getProviderFlags reports all providers on, where a real build gates them.',
    component: ProviderSelectStep,
    props: [],
    variants: [],
    mockData: () => ({
      onSelect: (choice: string) => console.log('[Playground] Provider selected:', choice),
      onSkip: () => console.log('[Playground] Setup deferred'),
    }),
  },
  {
    id: 'welcome-step',
    name: 'WelcomeStep',
    category: 'Onboarding',
    description: 'Initial welcome screen with feature overview',
    component: WelcomeStep,
    props: [
      {
        name: 'isExistingUser',
        description: 'Show update settings message instead of welcome',
        control: { type: 'boolean' },
        defaultValue: false,
      },
      {
        name: 'isLoading',
        description: 'Show loading state on continue button',
        control: { type: 'boolean' },
        defaultValue: false,
      },
    ],
    variants: [
      { name: 'New User', props: { isExistingUser: false } },
      { name: 'Existing User', props: { isExistingUser: true } },
      { name: 'Loading', props: { isLoading: true } },
    ],
    mockData: () => ({
      onContinue: noopHandler,
    }),
  },
  {
    id: 'api-setup-step',
    name: 'APISetupStep',
    category: 'Onboarding',
    description: 'Choose payment method for AI usage with provider segmented control',
    component: APISetupStep,
    props: [
      {
        name: 'selectedMethod',
        description: 'Currently selected API setup method',
        control: {
          type: 'select',
          options: [
            { label: 'None', value: '' },
            { label: 'Claude OAuth', value: 'claude_oauth' },
            { label: 'Anthropic API Key', value: 'anthropic_api_key' },
            { label: 'CAB ChatGPT OAuth', value: 'pi_chatgpt_oauth' },
            { label: 'CAB API Key', value: 'pi_api_key' },
          ],
        },
        defaultValue: '',
      },
      {
        name: 'initialSegment',
        description: 'Initial provider segment to show',
        control: {
          type: 'select',
          options: [
            { label: 'Anthropic', value: 'anthropic' },
            { label: 'Nessy Backend', value: 'pi' },
          ],
        },
        defaultValue: 'anthropic',
      },
    ],
    variants: [
      { name: 'Anthropic Segment', props: { selectedMethod: null, initialSegment: 'anthropic' } },
      { name: 'Anthropic - Claude OAuth Selected', props: { selectedMethod: 'claude_oauth', initialSegment: 'anthropic' } },
      { name: 'Anthropic - API Key Selected', props: { selectedMethod: 'anthropic_api_key', initialSegment: 'anthropic' } },
      { name: 'CAB Segment', props: { selectedMethod: null, initialSegment: 'pi' } },
      { name: 'CAB - ChatGPT OAuth Selected', props: { selectedMethod: 'pi_chatgpt_oauth', initialSegment: 'pi' } },
      { name: 'CAB - API Key Selected', props: { selectedMethod: 'pi_api_key', initialSegment: 'pi' } },
    ],
    mockData: () => ({
      onSelect: (method: string) => console.log('[Playground] Selected method:', method),
      onContinue: noopHandler,
      onBack: noopHandler,
    }),
  },
  {
    id: 'credentials-step-api-key',
    name: 'Credentials - API Key',
    category: 'Onboarding',
    description: 'API key + optional Base URL and Model for compatible APIs',
    component: CredentialsStep,
    props: [
      {
        name: 'status',
        description: 'Credential validation status',
        control: {
          type: 'select',
          options: [
            { label: 'Idle', value: 'idle' },
            { label: 'Validating', value: 'validating' },
            { label: 'Success', value: 'success' },
            { label: 'Error', value: 'error' },
          ],
        },
        defaultValue: 'idle',
      },
      {
        name: 'errorMessage',
        description: 'Error message to display',
        control: { type: 'string', placeholder: 'Error message' },
        defaultValue: '',
      },
    ],
    variants: [
      { name: 'Idle', props: { apiSetupMethod: 'pi_api_key', status: 'idle' } },
      { name: 'Validating', props: { apiSetupMethod: 'pi_api_key', status: 'validating' } },
      { name: 'Success', props: { apiSetupMethod: 'pi_api_key', status: 'success' } },
      { name: 'Error', props: { apiSetupMethod: 'pi_api_key', status: 'error', errorMessage: 'Invalid API key. Please check and try again.' } },
    ],
    mockData: () => ({
      apiSetupMethod: 'pi_api_key',
      onSubmit: (data: ApiKeySubmitData) => console.log('[Playground] Submitted:', data),
      onStartOAuth: noopHandler,
      onBack: noopHandler,
    }),
  },
  {
    id: 'credentials-step-oauth',
    name: 'Credentials - OAuth',
    category: 'Onboarding',
    description: 'Claude Max/Pro OAuth authentication flow',
    component: CredentialsStep,
    props: [
      {
        name: 'status',
        description: 'OAuth status',
        control: {
          type: 'select',
          options: [
            { label: 'Idle', value: 'idle' },
            { label: 'Validating', value: 'validating' },
            { label: 'Success', value: 'success' },
            { label: 'Error', value: 'error' },
          ],
        },
        defaultValue: 'idle',
      },
      {
        name: 'isWaitingForCode',
        description: 'Show auth code entry form',
        control: { type: 'boolean' },
        defaultValue: false,
      },
      {
        name: 'errorMessage',
        description: 'Error message to display',
        control: { type: 'string', placeholder: 'Error message' },
        defaultValue: '',
      },
    ],
    variants: [
      { name: 'Idle', props: { apiSetupMethod: 'claude_oauth', status: 'idle' } },
      { name: 'Waiting for Code', props: { apiSetupMethod: 'claude_oauth', status: 'idle', isWaitingForCode: true } },
      { name: 'Waiting for Code - Validating', props: { apiSetupMethod: 'claude_oauth', status: 'validating', isWaitingForCode: true } },
      { name: 'Waiting for Code - Error', props: { apiSetupMethod: 'claude_oauth', status: 'error', isWaitingForCode: true, errorMessage: 'Invalid authorization code.' } },
      { name: 'Validating', props: { apiSetupMethod: 'claude_oauth', status: 'validating' } },
      { name: 'Success', props: { apiSetupMethod: 'claude_oauth', status: 'success' } },
      { name: 'Error', props: { apiSetupMethod: 'claude_oauth', status: 'error', errorMessage: 'Authentication failed. Please try again.' } },
    ],
    mockData: () => ({
      apiSetupMethod: 'claude_oauth',
      onSubmit: (data: { apiKey: string }) => console.log('[Playground] Submitted:', data),
      onStartOAuth: noopHandler,
      onBack: noopHandler,
      onSubmitAuthCode: (code: string) => console.log('[Playground] Auth code:', code),
      onCancelOAuth: noopHandler,
    }),
  },
  /**
   * UB14.37 — the ChatGPT sign-in step (v0.15.1's ChatGPT hunk: the instructions
   * on the sunken well, the error and success notes on their tints). Ours has no
   * Copilot entry (Copilot removed) and signs in for BOTH ChatGPT cards: the Pi
   * one and F1.202's codex-runtime one, so both methods are states here.
   */
  {
    id: 'credentials-step-chatgpt',
    name: 'Credentials - ChatGPT',
    category: 'Onboarding',
    description: 'ChatGPT Plus sign-in through the host browser OAuth: the Pi card and the Codex-runtime card share this step',
    component: CredentialsStep,
    props: [
      {
        name: 'status',
        description: 'OAuth status',
        control: {
          type: 'select',
          options: [
            { label: 'Idle', value: 'idle' },
            { label: 'Validating', value: 'validating' },
            { label: 'Success', value: 'success' },
            { label: 'Error', value: 'error' },
          ],
        },
        defaultValue: 'idle',
      },
      {
        name: 'errorMessage',
        description: 'Error message to display',
        control: { type: 'string', placeholder: 'Error message' },
        defaultValue: '',
      },
    ],
    variants: [
      { name: 'Codex runtime - Idle', props: { apiSetupMethod: 'codex_chatgpt_oauth', status: 'idle' } },
      { name: 'Codex runtime - Validating', props: { apiSetupMethod: 'codex_chatgpt_oauth', status: 'validating' } },
      { name: 'Pi - Success', props: { apiSetupMethod: 'pi_chatgpt_oauth', status: 'success' } },
      { name: 'Pi - Error', props: { apiSetupMethod: 'pi_chatgpt_oauth', status: 'error', errorMessage: 'Sign-in was cancelled. Please try again.' } },
    ],
    mockData: () => ({
      apiSetupMethod: 'pi_chatgpt_oauth',
      onSubmit: noopHandler,
      onStartOAuth: noopHandler,
      onBack: noopHandler,
    }),
  },
  {
    id: 'credentials-step-nessy-gateway',
    name: 'Credentials - Nessy Gateway',
    category: 'Onboarding',
    description: 'Nessy Gateway API key preset with local JWT prefill',
    component: CredentialsStep,
    props: [
      {
        name: 'status',
        description: 'OAuth status',
        control: {
          type: 'select',
          options: [
            { label: 'Idle', value: 'idle' },
            { label: 'Validating', value: 'validating' },
            { label: 'Success', value: 'success' },
            { label: 'Error', value: 'error' },
          ],
        },
        defaultValue: 'idle',
      },
      {
        name: 'errorMessage',
        description: 'Error message to display',
        control: { type: 'string', placeholder: 'Error message' },
        defaultValue: '',
      },
    ],
    variants: [
      {
        name: 'Initial',
        props: {
          apiSetupMethod: 'pi_api_key',
          status: 'idle',
          editInitialValues: {
            activePreset: NESSY_GATEWAY_PRESET_KEY,
            baseUrl: NESSY_GATEWAY_BASE_URL,
            connectionDefaultModel: NESSY_GATEWAY_MODEL_IDS.join(', '),
            models: [...NESSY_GATEWAY_MODEL_IDS],
            customApi: 'openai-completions',
          },
        },
      },
      {
        name: 'Validating',
        props: {
          apiSetupMethod: 'pi_api_key',
          status: 'validating',
        },
      },
      { name: 'Success', props: { apiSetupMethod: 'pi_api_key', status: 'success' } },
      {
        name: 'Error',
        props: {
          apiSetupMethod: 'pi_api_key',
          status: 'error',
          errorMessage: 'Gateway authentication failed. Please check the JWT and try again.',
        },
      },
    ],
    mockData: () => ({
      apiSetupMethod: 'pi_api_key',
      onSubmit: noopHandler,
      onStartOAuth: noopHandler,
      onBack: noopHandler,
    }),
  },
  {
    id: 'completion-step',
    name: 'CompletionStep',
    category: 'Onboarding',
    description: 'Success screen after completing onboarding',
    component: CompletionStep,
    props: [
      {
        name: 'status',
        description: 'Completion status',
        control: {
          type: 'select',
          options: [
            { label: 'Saving', value: 'saving' },
            { label: 'Complete', value: 'complete' },
          ],
        },
        defaultValue: 'complete',
      },
    ],
    variants: [
      { name: 'Saving', props: { status: 'saving' } },
      { name: 'Complete', props: { status: 'complete' } },
    ],
    mockData: () => ({
      onFinish: noopHandler,
    }),
  },
  {
    id: 'git-bash-warning',
    name: 'GitBashWarning',
    category: 'Onboarding',
    description: 'Warning screen when Git Bash is not found on Windows',
    component: GitBashWarning,
    props: [
      {
        name: 'isRechecking',
        description: 'Show loading state on re-check button',
        control: { type: 'boolean' },
        defaultValue: false,
      },
    ],
    variants: [
      {
        name: 'Not Found',
        props: {
          status: { found: false, path: null, platform: 'win32' } as GitBashStatus,
        },
      },
      {
        name: 'Rechecking',
        props: {
          status: { found: false, path: null, platform: 'win32' } as GitBashStatus,
          isRechecking: true,
        },
      },
      {
        name: 'With Suggested Path',
        props: {
          status: { found: false, path: 'C:\\Program Files\\Git\\bin\\bash.exe', platform: 'win32' } as GitBashStatus,
        },
      },
      {
        name: 'With Error',
        props: {
          status: { found: false, path: null, platform: 'win32' } as GitBashStatus,
          errorMessage: 'File does not exist at the specified path',
        },
      },
    ],
    mockData: () => ({
      status: { found: false, path: null, platform: 'win32' } as GitBashStatus,
      onBrowse: async () => {
        console.log('[Playground] Browse clicked')
        return 'C:\\Program Files\\Git\\bin\\bash.exe'
      },
      onUsePath: (path: string) => console.log('[Playground] Use path:', path),
      onRecheck: noopHandler,
      onBack: noopHandler,
      onClearError: noopHandler,
    }),
  },
  /**
   * UB14.37 — the two onboarding surfaces the playground had no entry for. The
   * local-model step's error states come from its `status` prop; the reauth
   * screen's error is its own state after a failed login, so only its resting
   * state is a static state here.
   */
  {
    id: 'local-model-step',
    name: 'LocalModelStep',
    category: 'Onboarding',
    description: 'Local model (Ollama) endpoint and model, pre-filled with the Ollama defaults',
    component: LocalModelStep,
    props: [
      {
        name: 'status',
        description: 'Validation status',
        control: {
          type: 'select',
          options: [
            { label: 'Idle', value: 'idle' },
            { label: 'Validating', value: 'validating' },
            { label: 'Error', value: 'error' },
          ],
        },
        defaultValue: 'idle',
      },
      {
        name: 'errorMessage',
        description: 'Error message to display',
        control: { type: 'string', placeholder: 'Error message' },
        defaultValue: '',
      },
    ],
    variants: [
      { name: 'Validating', props: { status: 'validating' } },
      { name: 'Error', props: { status: 'error', errorMessage: 'Could not reach http://localhost:11434.' } },
    ],
    mockData: () => ({
      onSubmit: (data: unknown) => console.log('[Playground] Local model submitted:', data),
      onBack: noopHandler,
    }),
  },
  {
    id: 'reauth-screen',
    name: 'ReauthScreen',
    category: 'Onboarding',
    description: 'Re-login screen for an expired session: the paper card on the navigator canvas, login primary, reset ghost',
    component: ReauthScreen,
    props: [],
    variants: [],
    mockData: () => ({
      onLogin: async () => { console.log('[Playground] Login clicked') },
      onReset: noopHandler,
    }),
    layout: 'full',
  },
  {
    id: 'onboarding-wizard',
    name: 'OnboardingWizard',
    category: 'Onboarding',
    description: 'Full-screen onboarding flow container with all steps',
    component: OnboardingWizard,
    props: [],
    variants: [
      {
        name: 'Welcome (New User)',
        props: {
          state: createOnboardingState({ step: 'welcome', isExistingUser: false }),
        },
      },
      {
        name: 'Welcome (Existing User)',
        props: {
          state: createOnboardingState({ step: 'welcome', isExistingUser: true }),
        },
      },
      {
        name: 'Git Bash Warning',
        props: {
          state: createOnboardingState({ step: 'git-bash' }),
        },
      },
      {
        name: 'Git Bash Warning (Rechecking)',
        props: {
          state: createOnboardingState({ step: 'git-bash', isRecheckingGitBash: true }),
        },
      },
      {
        name: 'Credentials - API Key',
        props: {
          state: createOnboardingState({ step: 'credentials', apiSetupMethod: 'anthropic_api_key' }),
        },
      },
      {
        name: 'Credentials - OAuth',
        props: {
          state: createOnboardingState({ step: 'credentials', apiSetupMethod: 'claude_oauth' }),
        },
      },
      {
        name: 'Complete - Saving',
        props: {
          state: createOnboardingState({ step: 'complete', completionStatus: 'saving' }),
        },
      },
      {
        name: 'Complete - Done',
        props: {
          state: createOnboardingState({
            step: 'complete',
            completionStatus: 'complete',
          }),
        },
      },
    ],
    mockData: () => ({
      state: createOnboardingState(),
      className: 'min-h-0 h-full',
      onContinue: noopHandler,
      onBack: noopHandler,
      onSelectApiSetupMethod: (method: string) => console.log('[Playground] Selected method:', method),
      onSubmitCredential: (data: ApiKeySubmitData) => console.log('[Playground] Submitted:', data),
      onStartOAuth: noopHandler,
      onFinish: noopHandler,
      onBrowseGitBash: async () => {
        console.log('[Playground] Browse Git Bash clicked')
        return 'C:\\Program Files\\Git\\bin\\bash.exe'
      },
      onUseGitBashPath: (path: string) => console.log('[Playground] Use Git Bash path:', path),
      onRecheckGitBash: noopHandler,
      onClearError: noopHandler,
      onSkipSetup: () => console.log('[Playground] Setup deferred'),
    }),
  },
]
