import * as React from 'react'
import type { ComponentEntry } from './types'
import type { SafeCapabilityDiagnostic } from '@nessy-agent/shared/protocol/capabilities'
import type { ActivityItem } from '@nessy-agent/ui/chat/TurnCard'
import type { SessionMeta } from '@/atoms/sessions'
import type { SessionStatus } from '@/config/session-status-config'
import type {
  ContextUsageCategory,
  ContextUsageLoadedFile,
  ContextUsageSnapshot,
  ContextUsageSuggestion,
} from '../../../shared/types'
import {
  AlertTriangle,
  CheckCircle2,
  Circle,
  CircleAlert,
  Clock3,
  MoreHorizontal,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import {
  PERMISSION_MODE_ORDER,
  type PermissionMode,
} from '@nessy-agent/shared/agent/modes'
import {
  PERMISSION_MODE_PICKER_ORDER,
  describePermissionModeLine,
  resolveRuntimePermissionModeNote,
  withPermissionModeMenuDecorations,
} from '@/lib/composer-permission-modes'
import { parseTerminalReasonMarker, terminalReasonMarker, terminalReasonNoticeKey } from '@/lib/terminal-reason-copy'
import { TERMINAL_REASON_VALUES, type AgentTerminalReason } from '@nessy-agent/core/types'
import { cn } from '@/lib/utils'
import type { ModelProvider } from '@config/models'
import { SubagentCard } from '@/components/app-shell/SubagentCard'
import { TodoListCard } from '@/components/app-shell/TodoListCard'
import { WorkflowPanel } from '@/components/app-shell/WorkflowPanel'
import { CompactPermissionModeSelector } from '@/components/app-shell/input/CompactPermissionModeSelector'
import { ComposerModeChip } from '@/components/app-shell/input/ComposerModeChip'
import {
  ComposerCapabilitiesProvider,
  DEFAULT_COMPOSER_CAPABILITIES,
} from '@/components/app-shell/input/composer-capabilities-context'
import { AppShellProvider, useAppShellContext } from '@/context/AppShellContext'
import { PlaygroundAppShellProvider } from '../PlaygroundAppShellProvider'
import type { LlmConnectionWithStatus } from '@config/llm-connections'
import type { ModelDefinition } from '@config/models'
import type { ThinkingLevel } from '@nessy-agent/shared/agent/thinking-levels'
import { THINKING_LEVEL_IDS } from '@nessy-agent/shared/agent/thinking-levels'
import { derivePickerMode } from '@/components/app-shell/input/picker-mode'
import { isCompatProvider } from '@config/llm-connections'
import { CompactModelSelector } from '@/components/app-shell/input/CompactModelSelector'
import { ComposerModelMenu } from '@/components/app-shell/input/ComposerModelMenu'

const now = Date.now()

function frame(children: React.ReactNode, className = 'w-[560px]') {
  return (
    <div className={className}>
      {children}
    </div>
  )
}

// Registry chrome (knob options, variant names) uses the mode IDS — structure,
// not text. The words the entry RENDERS come from the same i18n keys the
// composer reads, resolved inside the component below.
const permissionModeOptions = PERMISSION_MODE_ORDER.map(mode => ({
  label: mode,
  value: mode,
}))

/**
 * The runtimes whose picker text differs. `nestor-cloud-agent` is absent on
 * purpose: it ships its own `modeOptions` with its own words, so it never
 * renders these strings at all.
 */
const permissionModeRuntimeOptions: { label: string, value: ModelProvider }[] = [
  { label: 'pi', value: 'pi' },
  { label: 'anthropic', value: 'anthropic' },
  { label: 'codex-runtime', value: 'codex-runtime' },
]

/**
 * i18n text with a LOUD miss. The playground is the design surface: a silently
 * echoed raw key here is exactly how the composer and the playground drifted
 * apart before, so a missing key renders an unmissable marker instead.
 */
function modeText(t: (key: string) => string, key: string): string {
  const value = t(key)
  return value === key ? `MISSING i18n: ${key}` : value
}

/**
 * The same text the composer reads: mode.<id>, mode.<id>Short, the ONE-LINE
 * description the picker actually renders (general string plus, on a runtime
 * that cannot enforce the mode, that runtime's short clause), and the shared
 * runtime note the menu shows ONCE as a footer (R15).
 *
 * `runtime` is a knob because the note is a LAYOUT state, not just words: on
 * `codex-runtime` two rows gain a clause and the whole list gains a footer band,
 * which is the tallest the dropdown ever gets and therefore the state worth
 * designing against. Before 2026-08-17 EVERY row gained a whole sentence — six
 * copies of one fact, three to four lines each — and this entry is where that
 * should have been visible.
 *
 * `modeText` is threaded through instead of a bare `t` so a clause or note key
 * that a locale has not translated renders the loud MISSING marker here too,
 * rather than being dropped the way the composer drops it.
 */
function usePermissionModeDisplays(runtime: ModelProvider, defaultMode?: PermissionMode) {
  const { t } = useTranslation()
  const translate = React.useCallback((key: string) => modeText(t, key), [t])
  // F1.1052: the picker's rows in Claude Desktop's order, with its badges and
  // digits — the same `withPermissionModeMenuDecorations` the composer applies.
  const modes = PERMISSION_MODE_PICKER_ORDER.map(mode => ({
    mode,
    label: modeText(t, `mode.${mode}`),
    shortLabel: modeText(t, `mode.${mode}Short`),
    description: describePermissionModeLine(mode, translate, runtime),
    iconMode: mode,
  })).map(withPermissionModeMenuDecorations(defaultMode))
  return { modes, runtimeNote: resolveRuntimePermissionModeNote(translate, runtime) }
}

/**
 * UB14.29 — the desktop surface is the composer toolbar's `ComposerModeChip` (v0.15.1's tinted pill over our
 * menu), the compact one the drawer selector. Each sits in its own `@container/panel` box, because both chips read
 * the PANEL's width the way they do in the app (`PanelSlot`): the desktop chip drops its label under 32rem, the
 * compact one under 24rem. `narrow` shrinks both boxes below those widths (the icon-only states); `locked` is the
 * capability set's lock (disabled trigger, no menu); `menuOpen` opens the desktop menu on mount (a portal, so the
 * static sweep sees only the trigger — the live page shows the menu). The desktop chip sits at its row's RIGHT end,
 * as it does in the toolbar's right-hand mode · model group, so the open menu end-aligns as in the app (UB12.110).
 */
function PermissionModeSelectorPlayground({
  mode,
  runtime = 'pi',
  defaultMode = 'auto',
  locked = false,
  narrow = false,
  menuOpen = false,
}: {
  mode: PermissionMode
  runtime?: ModelProvider
  defaultMode?: PermissionMode
  locked?: boolean
  narrow?: boolean
  menuOpen?: boolean
}) {
  const [currentMode, setCurrentMode] = React.useState<PermissionMode>(mode)
  const { modes: permissionModeDisplays, runtimeNote } = usePermissionModeDisplays(runtime, defaultMode)

  React.useEffect(() => {
    setCurrentMode(mode)
  }, [mode])

  return frame(
    <div className="space-y-3 rounded-[8px] border border-border/55 bg-background p-3 text-foreground shadow-minimal">
      <div className={cn('@container/panel flex items-center justify-between gap-2', narrow ? 'w-[440px]' : 'w-full')}>
        <span className="text-[11px] text-muted-foreground">Desktop</span>
        <ComposerModeChip
          key={menuOpen ? 'open' : 'closed'}
          permissionMode={currentMode}
          onPermissionModeChange={setCurrentMode}
          permissionModeDisplays={permissionModeDisplays}
          runtimeNote={runtimeNote}
          locked={locked}
          sessionId="parity-mode-session"
          defaultOpen={menuOpen}
        />
      </div>
      <div className={cn('@container/panel flex items-center gap-2 border-t border-border/45 pt-3', narrow ? 'w-[340px]' : 'w-[420px]')}>
        <span className="text-[11px] text-muted-foreground">Compact</span>
        <CompactPermissionModeSelector
          permissionMode={currentMode}
          onPermissionModeChange={setCurrentMode}
          permissionModeDisplays={permissionModeDisplays}
          runtimeNote={runtimeNote}
          locked={locked}
        />
      </div>
    </div>,
    'w-[560px]'
  )
}

// =============================================================================
// P6.600 — CompactModelSelector, the composer's model control, had no harness.
//
// The playground is the design surface, so every state the component can reach
// is a knob here rather than a state only a live session produces:
//
//  - `empty`       an active connection that declares `models: []`. Truthy in
//                  JS, so `models || ANTHROPIC_MODELS` keeps the empty list and
//                  the model section renders NOTHING. Reachable, and until now
//                  never looked at.
//  - `single`      `derivePickerMode`'s `locked-single` — a `pi_compat`
//                  connection with one model, rendered as a label rather than a
//                  list of one (`isCompatProvider` is `pi_compat` ONLY, which is
//                  why this fixture is not a `pi` one).
//  - `translated`  P6.454: ONE `claude-runtime` connection holds both wires and
//                  the router decides per request, so the model carrying no
//                  `wire` is marked translated and the note under the list says
//                  what the mark means.
//  - `flat`        the ordinary several-model list.
//
// `unavailable` is orthogonal (it wins over all four in `derivePickerMode`), so
// it is its own boolean rather than a fifth option.
// =============================================================================

function playgroundModel(
  id: string,
  name: string,
  extra: Partial<ModelDefinition> = {},
): ModelDefinition {
  return {
    id,
    name,
    shortName: name,
    description: '',
    provider: 'anthropic' as ModelProvider,
    contextWindow: 200_000,
    ...extra,
  }
}

const MODEL_SELECTOR_CONNECTIONS: Record<string, LlmConnectionWithStatus> = {
  empty: {
    slug: 'byo-empty',
    name: 'BYO endpoint',
    providerType: 'pi_compat',
    authType: 'api_key_with_endpoint',
    baseUrl: 'https://endpoint.internal/v1',
    models: [],
    isAuthenticated: true,
    createdAt: 0,
  },
  single: {
    slug: 'byo-single',
    name: 'Ollama',
    providerType: 'pi_compat',
    authType: 'none',
    baseUrl: 'http://localhost:11434/v1',
    models: [playgroundModel('qwen3-coder', 'Qwen3 Coder')],
    defaultModel: 'qwen3-coder',
    isAuthenticated: true,
    createdAt: 0,
  },
  flat: {
    slug: 'nessy-gateway',
    name: 'Nessy Gateway',
    providerType: 'pi',
    authType: 'bearer_token',
    models: [
      playgroundModel('tgpt/qwen35-397b-a17b-fp8', 'Qwen 3.5 397B', { contextWindow: 262_144 }),
      playgroundModel('tgpt/qwen36-35b-a3b-fp8', 'Qwen 3.6 35B', { contextWindow: 262_144 }),
      playgroundModel('tgpt/gpt-oss-120b', 'GPT-OSS 120B', { supportsThinking: false }),
    ],
    isAuthenticated: true,
    createdAt: 0,
  },
  translated: {
    slug: 'claude-gateway',
    name: 'Claude Code (Nessy Gateway)',
    providerType: 'claude-runtime',
    authType: 'bearer_token',
    models: [
      playgroundModel('claude-sonnet-4-5', 'Claude Sonnet 4.5', { wire: 'anthropic-messages' }),
      playgroundModel('tgpt/qwen35-397b-a17b-fp8', 'Qwen 3.5 397B', { contextWindow: 262_144 }),
    ],
    isAuthenticated: true,
    createdAt: 0,
  },
}

const MODEL_SELECTOR_CURRENT: Record<string, string> = {
  empty: 'tgpt/qwen35-397b-a17b-fp8',
  single: 'qwen3-coder',
  flat: 'tgpt/qwen36-35b-a3b-fp8',
  translated: 'tgpt/qwen35-397b-a17b-fp8',
}

/**
 * UB14.30 — both pickers are imported EAGERLY, so the static sweep (`registry-render.test.ts`) renders them for real
 * rather than a `React.lazy` fallback (which is all it had ever seen of either). D1.214 measured why they were lazy:
 * an eager import pulled the `@nessy-agent/ui` barrel, and through it pdfjs-dist's `?url` worker, into
 * `parity-ui-registry.test.ts` (0 pass / 1 fail / 1 error, 2026-09-17). The barrel edges were the two pickers' own
 * Spinner/Tooltip imports and `ConnectionIcon`'s tooltip import; UB14.30 moved all three onto the subpaths.
 */

/** A second integration on ANOTHER runtime, so the integration row has somewhere to switch to (the `twoRuntimes` knob). */
const SECOND_RUNTIME_CONNECTION: LlmConnectionWithStatus = {
  slug: 'codex-byo',
  name: 'Codex',
  providerType: 'codex-runtime',
  authType: 'api_key',
  models: [playgroundModel('gpt-5-codex', 'GPT-5 Codex')],
  isAuthenticated: true,
  createdAt: 0,
}

/**
 * `ComposerCapabilities.reasoning.levels` as the server answers it per runtime (`PROVIDER_DEFAULTS` in
 * `@nessy-agent/shared/agent/backend/composer-capabilities`): Pi and api.anthropic.com all six, codex and the
 * `claude-runtime` gateway `off`–`high`, nestor-cloud none. Both pickers offer exactly these (UB14.30).
 */
const REASONING_LEVELS: Record<string, ThinkingLevel[]> = {
  all: [...THINKING_LEVEL_IDS],
  reduced: ['off', 'low', 'medium', 'high'],
  none: [],
}

const REASONING_KNOB = {
  name: 'reasoning',
  description: "The effort levels the session's runtime honours (ComposerCapabilities.reasoning.levels)",
  control: {
    type: 'select' as const,
    options: [
      { label: 'All six (Pi, Claude API)', value: 'all' },
      { label: 'off–high (codex, Claude gateway)', value: 'reduced' },
      { label: 'None (nestor-cloud, older server)', value: 'none' },
    ],
  },
  defaultValue: 'all',
}

/**
 * Override only `llmConnections` on the inherited playground shell value —
 * the same nesting `MobilePlaygroundProviders` uses, and the reason
 * `PlaygroundAppShellProvider` documents it as intended.
 */
function ModelSelectorConnections({
  connections,
  children,
}: {
  connections: LlmConnectionWithStatus[]
  children: React.ReactNode
}) {
  const parent = useAppShellContext()
  const value = React.useMemo(
    () => ({ ...parent, llmConnections: connections }),
    [parent, connections],
  )
  return <AppShellProvider value={value}>{children}</AppShellProvider>
}

function CompactModelSelectorPlayground({
  state,
  unavailable,
  open,
  switchable,
  processing,
  reasoning = 'all',
  twoRuntimes = false,
  narrow = false,
}: {
  state: string
  unavailable: boolean
  open: boolean
  switchable: boolean
  processing: boolean
  reasoning?: string
  twoRuntimes?: boolean
  narrow?: boolean
}) {
  const connection = MODEL_SELECTOR_CONNECTIONS[state] ?? MODEL_SELECTOR_CONNECTIONS.flat!
  const connections = React.useMemo(
    () => (twoRuntimes ? [connection, SECOND_RUNTIME_CONNECTION] : [connection]),
    [connection, twoRuntimes],
  )
  const [model, setModel] = React.useState(MODEL_SELECTOR_CURRENT[state] ?? '')
  // Opened AFTER mount (UB14.30): vaul reads `document` while rendering an OPEN drawer, which the static sweep has
  // none of — measured with the eager import, 10 of the 13 states threw `document is not defined`
  // (`vaul/dist/index.mjs`). So the sweep reads every state's TRIGGER and the page opens the sheet one effect later.
  const [drawerOpen, setDrawerOpen] = React.useState(false)
  const [thinking, setThinking] = React.useState<ThinkingLevel>('medium')

  React.useEffect(() => { setDrawerOpen(open) }, [open])
  React.useEffect(() => { setModel(MODEL_SELECTOR_CURRENT[state] ?? '') }, [state])

  return frame(
    <PlaygroundAppShellProvider>
      <ModelSelectorConnections connections={connections}>
        <ComposerCapabilitiesProvider
          value={{
            ...DEFAULT_COMPOSER_CAPABILITIES,
            reasoning: { levels: REASONING_LEVELS[reasoning] ?? REASONING_LEVELS.all! },
            connection: { switchable, activeRuntime: 'pi' },
          }}
        >
          {/* The chip reads the PANEL's width (`@container/panel`, `PanelSlot` in the app): under 26rem it folds to
              the Cpu glyph, which `narrow` (340px) shows. */}
          <div className={cn('@container/panel flex items-center gap-2 rounded-[8px] border border-border/55 bg-background p-3 text-foreground shadow-minimal', narrow ? 'w-[340px]' : 'w-[420px]')}>
            <span className="text-[11px] text-muted-foreground">Composer</span>
            <CompactModelSelector
              currentModel={model}
              currentConnection={connection.slug}
              onModelChange={setModel}
              onConnectionChange={() => {}}
              thinkingLevel={thinking}
              onThinkingLevelChange={setThinking}
              connectionUnavailable={unavailable}
              isProcessing={processing}
              contextStatus={{ inputTokens: 42_000, contextWindow: 200_000 }}
              open={drawerOpen}
              onOpenChange={setDrawerOpen}
            />
          </div>
        </ComposerCapabilitiesProvider>
      </ModelSelectorConnections>
    </PlaygroundAppShellProvider>,
    'w-[420px]'
  )
}

// =============================================================================
// D1.214 — the DESKTOP picker, beside the compact one, on the SAME knobs.
//
// The compact selector above has had a harness since P6.600. The desktop picker
// had none, and the two rows that cost the most this week were both "the two
// pickers disagree": RS-44/DA2.23 (at 1400 px BOTH disclosure lines absent while
// the compact picker showed both at 700 px, same card, same minute) and DA2.25
// (the per-row translated mark and the note under the list). Neither is exotic
// and neither is visible in source; both are obvious the moment the two menus
// can be opened side by side, which is what this entry is for.
//
// The SAME fixtures and the SAME four states as the compact entry, deliberately:
// a harness with fixtures of its own could not answer "do these two agree".
//
// UB14.30 — the component is v0.15.1's `ComposerModelMenu` and owns its trigger, so the harness now shows the REAL
// chip (with the effort pill) rather than a stand-in button; `open` opens the menu above it.
// =============================================================================

function ComposerModelMenuPlayground({
  state,
  unavailable,
  switchable,
  processing,
  open = true,
  reasoning = 'all',
  twoRuntimes = false,
  integrationOpen = false,
}: {
  state: string
  unavailable: boolean
  switchable: boolean
  processing: boolean
  open?: boolean
  reasoning?: string
  twoRuntimes?: boolean
  integrationOpen?: boolean
}) {
  const connection = MODEL_SELECTOR_CONNECTIONS[state] ?? MODEL_SELECTOR_CONNECTIONS.flat!
  const connections = React.useMemo(
    () => (twoRuntimes ? [connection, SECOND_RUNTIME_CONNECTION] : [connection]),
    [connection, twoRuntimes],
  )
  const [model, setModel] = React.useState(MODEL_SELECTOR_CURRENT[state] ?? '')
  const [thinking, setThinking] = React.useState<ThinkingLevel>('medium')
  const [menuOpen, setMenuOpen] = React.useState(open)
  React.useEffect(() => { setModel(MODEL_SELECTOR_CURRENT[state] ?? '') }, [state])
  React.useEffect(() => { setMenuOpen(open) }, [open])

  // Derived with the composer's OWN helpers rather than hard-coded, so a change
  // to `derivePickerMode` moves this harness with the app instead of leaving it
  // rendering a mode the picker can no longer reach.
  const connectionDefaultModel = !isCompatProvider(connection.providerType)
    || (connection.models && connection.models.length > 1)
    ? null
    : connection.defaultModel ?? null
  const pickerMode = derivePickerMode({ connectionUnavailable: unavailable, connectionDefaultModel })
  const availableModels = unavailable ? [] : (connection.models ?? [])
  // The composer's own resolution (`currentModelDisplayName`): the entry's name, else the id.
  const currentEntry = availableModels.find(entry => (typeof entry === 'string' ? entry : entry.id) === model)
  const displayName = connectionDefaultModel
    ?? (currentEntry && typeof currentEntry !== 'string' ? currentEntry.name : undefined)
    ?? model

  return frame(
    <PlaygroundAppShellProvider>
      <ModelSelectorConnections connections={connections}>
        <div className="flex items-center justify-end gap-2 rounded-[8px] border border-border/55 bg-background p-3 text-foreground shadow-minimal">
          <span className="mr-auto text-[11px] text-muted-foreground">Composer</span>
          <ComposerModelMenu
            key={integrationOpen ? 'integration-open' : 'integration-closed'}
            open={menuOpen}
            onOpenChange={setMenuOpen}
            llmConnections={connections}
            effectiveConnectionDetails={connection}
            effectiveConnection={connection.slug}
            switchable={switchable}
            reasoningLevels={REASONING_LEVELS[reasoning] ?? REASONING_LEVELS.all!}
            isEmptySession
            isProcessing={processing}
            connectionUnavailable={unavailable}
            pickerMode={pickerMode}
            connectionDefaultModel={connectionDefaultModel}
            availableModels={availableModels}
            currentModel={model}
            currentModelDisplayName={displayName}
            thinkingLevel={thinking}
            thinkingDisabled={false}
            contextStatus={{ inputTokens: 42_000 }}
            onModelChange={setModel}
            onThinkingLevelChange={setThinking}
            onConnectionChange={() => {}}
            onToggleVision={() => {}}
            defaultIntegrationExpanded={integrationOpen}
          />
        </div>
      </ModelSelectorConnections>
    </PlaygroundAppShellProvider>,
    'w-[420px]'
  )
}

function ago(seconds: number): string {
  return new Date(now - seconds * 1000).toISOString()
}

function createElapsedSubagentActivity(): ActivityItem {
  return {
    id: 'parity-elapsed-subagent',
    type: 'tool',
    status: 'running',
    toolName: 'subagent',
    toolUseId: 'parity-elapsed-subagent',
    timestamp: now,
    orchestrationProgress: {
      kind: 'subagent',
      runId: 'subagent-elapsed-run',
      agents: [
        {
          id: 'elapsed-scout',
          label: 'Scout',
          agentType: 'scout',
          status: 'done',
          tokensIn: 940,
          tokensOut: 188,
          phase: 'discover',
          startedAt: ago(142),
        },
        {
          id: 'elapsed-reviewer',
          label: 'Reviewer',
          agentType: 'reviewer',
          status: 'running',
          tokensIn: 420,
          tokensOut: 72,
          phase: 'review',
          startedAt: ago(65),
        },
      ],
    },
  }
}

function createElapsedWorkflowActivity(): ActivityItem {
  return {
    id: 'parity-elapsed-workflow',
    type: 'tool',
    status: 'running',
    toolName: 'workflow',
    toolUseId: 'parity-elapsed-workflow',
    timestamp: now,
    toolInput: { tokenBudget: 4000 },
    orchestrationProgress: {
      kind: 'workflow',
      runId: 'workflow-elapsed-run',
      agents: [
        {
          id: 'workflow-elapsed-build',
          label: 'Builder',
          agentType: 'builder',
          phase: 'build',
          status: 'running',
          tokensIn: 1280,
          tokensOut: 390,
          lastActivity: 'editing patch',
          startedAt: ago(83),
        },
        {
          id: 'workflow-elapsed-verify',
          label: 'Verifier',
          agentType: 'reviewer',
          phase: 'verify',
          status: 'queued',
          tokensIn: 0,
          tokensOut: 0,
        },
      ],
    },
  }
}

function AgentElapsedPlayground() {
  return frame(
    <div className="space-y-3">
      <SubagentCard activity={createElapsedSubagentActivity()} defaultExpanded />
      <WorkflowPanel activity={createElapsedWorkflowActivity()} defaultExpanded />
    </div>
  )
}

function createTodoActivity(): ActivityItem {
  return {
    id: 'parity-todo',
    type: 'tool',
    status: 'running',
    toolName: 'TodoWrite',
    toolUseId: 'parity-todo',
    timestamp: now,
    toolInput: {
      todos: [
        { id: 'todo-1', content: 'Add permission-mode playground variants', status: 'completed' },
        { id: 'todo-2', content: 'Check dark theme token use', status: 'in_progress', activeForm: 'Checking dark theme token use' },
        { id: 'todo-3', content: 'Record final gate output', status: 'pending' },
      ],
    },
  }
}

function TodoListParityPlayground() {
  return frame(<TodoListCard activity={createTodoActivity()} />)
}

const memoryMarkdown = `# MEMORY.md

## Project facts

- Permission modes are Claude Code's: auto, default (Manual), acceptEdits, plan, bypassPermissions, and the hidden dontAsk.
- Session memory is stored beside the session under data/MEMORY.md.
- Slash command /memory opens the session memory file in the existing viewer.

## Recent note

Remember to keep tracker gates auditable and paste real output excerpts.
`

const LazyMemoryMarkdown = React.lazy(async () => {
  const { CollapsibleMarkdownProvider, Markdown } = await import('@/components/markdown')
  return {
    default: function MemoryMarkdown({ children }: { children: string }) {
      return (
        <CollapsibleMarkdownProvider>
          <Markdown mode="minimal">{children}</Markdown>
        </CollapsibleMarkdownProvider>
      )
    },
  }
})

function MemoryViewerPlayground() {
  return frame(
    <div className="overflow-hidden rounded-[8px] border border-border/55 bg-background text-foreground shadow-minimal">
      <div className="flex items-center justify-between border-b border-border/45 px-3 py-2">
        <div className="min-w-0">
          <div className="text-[13px] font-medium">MEMORY.md</div>
          <div className="truncate text-[11px] text-muted-foreground">data/MEMORY.md</div>
        </div>
        <div className="rounded-[4px] bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">/memory</div>
      </div>
      <div className="max-h-[360px] overflow-auto px-3 py-2 text-[13px]">
        <React.Suspense fallback={<pre className="whitespace-pre-wrap font-sans">{memoryMarkdown}</pre>}>
          <LazyMemoryMarkdown>{memoryMarkdown}</LazyMemoryMarkdown>
        </React.Suspense>
      </div>
    </div>
  )
}

const menuSession: SessionMeta = {
  id: 'parity-session',
  workspaceId: 'playground-workspace',
  name: 'Review checkpoint revert affordance',
  messageCount: 2,
  lastFinalMessageId: 'message-2',
  lastReadMessageId: 'message-2',
}

const menuStatuses: SessionStatus[] = [
  {
    id: 'todo',
    label: 'Todo',
    resolvedColor: 'var(--muted-foreground)',
    icon: <Circle className="h-3.5 w-3.5" strokeWidth={1.5} />,
    iconColorable: true,
    isDefault: true,
  },
  {
    id: 'done',
    label: 'Done',
    resolvedColor: 'var(--success)',
    icon: <CheckCircle2 className="h-3.5 w-3.5" strokeWidth={1.5} />,
    iconColorable: true,
  },
]

const LazyCheckpointRevertMenu = React.lazy(async () => {
  const [
    { SessionMenu },
    { DropdownMenu, DropdownMenuTrigger, StyledDropdownMenuContent },
    { DropdownMenuProvider },
  ] = await Promise.all([
    import('@/components/app-shell/SessionMenu'),
    import('@/components/ui/styled-dropdown'),
    import('@/components/ui/menu-context'),
  ])

  return {
    default: function CheckpointRevertMenu() {
      return (
        <DropdownMenu open>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="inline-flex h-8 items-center gap-2 rounded-[6px] border border-border/55 bg-background px-2.5 text-[12px] text-foreground shadow-minimal"
            >
              <MoreHorizontal className="h-4 w-4" />
              Session actions
            </button>
          </DropdownMenuTrigger>
          <StyledDropdownMenuContent align="center" sideOffset={8} forceMount>
            <DropdownMenuProvider>
              <SessionMenu
                item={menuSession}
                sessionStatuses={menuStatuses}
                onRename={() => console.info('[Playground] Rename')}
                onFlag={() => console.info('[Playground] Flag')}
                onUnflag={() => console.info('[Playground] Unflag')}
                onArchive={() => console.info('[Playground] Archive')}
                onUnarchive={() => console.info('[Playground] Unarchive')}
                onMarkUnread={() => console.info('[Playground] Mark unread')}
                onSessionStatusChange={state => console.info('[Playground] Status:', state)}
                onOpenInNewWindow={() => console.info('[Playground] Open in new window')}
                onDelete={() => console.info('[Playground] Delete')}
              />
            </DropdownMenuProvider>
          </StyledDropdownMenuContent>
        </DropdownMenu>
      )
    },
  }
})

function CheckpointRevertActionPlayground() {
  return frame(
    <div className="flex h-[420px] items-start justify-center pt-10">
      <React.Suspense fallback={<div className="text-[12px] text-muted-foreground">Loading session actions...</div>}>
        <LazyCheckpointRevertMenu />
      </React.Suspense>
    </div>,
    'w-[560px]'
  )
}

/**
 * `/context` overlay breakdown, driven by a wire snapshot.
 *
 * The overlay is a design surface: S2 added an optimization-suggestion group
 * between the category rows and the loaded-file list, so every state it can
 * reach — none, one per rule, all three, and all three under an over-limit
 * warning — is a variant here.
 */
const LazyContextOverlayBreakdown = React.lazy(async () => {
  const { ContextOverlayBreakdown } = await import('@/components/app-shell/context-overlay')
  return { default: ContextOverlayBreakdown }
})

const CONTEXT_OVERLAY_CATEGORIES: ContextUsageCategory[] = [
  { id: 'system_prompt', tokens: 7_400 },
  { id: 'system_tools', tokens: 11_800 },
  { id: 'mcp_tools', tokens: 24_300 },
  { id: 'custom_subagents', tokens: 2_100, items: [{ name: 'hive-scout', tokens: 2_100, source: 'plugin://honey' }] },
  { id: 'memory_files', tokens: 9_600 },
  { id: 'skills', tokens: 6_200 },
  { id: 'conversation_messages', tokens: 41_500 },
]

const CONTEXT_OVERLAY_LOADED_FILES: ContextUsageLoadedFile[] = [
  { name: 'instruction::project::ws::pk::::AGENTS.md', kind: 'instruction', tokens: 5_100 },
  { name: 'memory::global::-::-::::MEMORY.md', kind: 'memory', tokens: 4_500 },
]

const CONTEXT_OVERLAY_SUGGESTIONS: Record<string, ContextUsageSuggestion> = {
  mcp: { id: 'defer_mcp_tools', category: 'mcp_tools', tokens: 24_300, count: 42 },
  memory: { id: 'trim_memory_files', category: 'memory_files', tokens: 9_600, count: 2 },
  skills: { id: 'gate_skill_listing', category: 'skills', tokens: 6_200, count: 31 },
}

/**
 * The two catalog diagnostics the overlay renders as its not-loaded group
 * (P6.599). Shaped exactly as `toSafeDiagnostic` emits them — `messageKey`
 * equal to `code`, the count and the cap as `safeArgs` — so the playground
 * sweeps the sentence the user actually gets.
 */
const CONTEXT_OVERLAY_NOT_LOADED: Record<string, SafeCapabilityDiagnostic> = {
  cap: {
    severity: 'warning',
    code: 'capability.instruction.ancestorLayerCap',
    messageKey: 'capability.instruction.ancestorLayerCap',
    safeArgs: { droppedCount: '2', limit: '8' },
  },
  oversize: {
    severity: 'warning',
    code: 'capability.instruction.overSizeLimit',
    messageKey: 'capability.instruction.overSizeLimit',
    safeArgs: { droppedCount: '1', limitMiB: '4' },
  },
}

function ContextOverlaySuggestionsPlayground({
  suggestions,
  overLimit,
  notLoaded,
}: {
  suggestions: string
  overLimit: boolean
  notLoaded: string
}) {
  const selected = suggestions === 'none'
    ? []
    : suggestions === 'all'
      ? Object.values(CONTEXT_OVERLAY_SUGGESTIONS)
      : [CONTEXT_OVERLAY_SUGGESTIONS[suggestions]].filter(Boolean) as ContextUsageSuggestion[]

  const contextUsage: ContextUsageSnapshot = {
    modelId: 'playground-model',
    inputTokens: overLimit ? 214_000 : 102_900,
    contextWindow: 200_000,
    source: 'sdk_usage',
    autoCompactionEnabled: true,
    autoCompactionThreshold: 180_000,
    remainingBeforeAutoCompact: overLimit ? 0 : 77_100,
    categories: CONTEXT_OVERLAY_CATEGORIES,
    unattributedTokens: overLimit ? 111_100 : 0,
    loadedFiles: CONTEXT_OVERLAY_LOADED_FILES,
    ...(selected.length > 0 ? { suggestions: selected } : {}),
  }

  const diagnostics = notLoaded === 'none'
    ? []
    : notLoaded === 'both'
      ? Object.values(CONTEXT_OVERLAY_NOT_LOADED)
      : [CONTEXT_OVERLAY_NOT_LOADED[notLoaded]].filter(Boolean) as SafeCapabilityDiagnostic[]

  return frame(
    <div className="overflow-hidden rounded-[8px] border border-border/55 bg-background text-foreground shadow-minimal">
      <React.Suspense fallback={<div className="p-4 text-[12px] text-muted-foreground">Loading context overlay...</div>}>
        <LazyContextOverlayBreakdown
          contextUsage={contextUsage}
          tokenUsage={undefined}
          locale="en-US"
          diagnostics={diagnostics}
        />
      </React.Suspense>
    </div>,
    'w-[460px]'
  )
}

// Every reason the wire can carry is a knob option, not only the five with
// copy: the state worth designing against is "a reason this build cannot
// name", and it is only reachable from the list that includes the other
// twelve.
const TERMINAL_REASON_OPTIONS = TERMINAL_REASON_VALUES.map(reason => ({
  label: reason,
  value: reason,
}))

/**
 * P2.37 · the transcript's terminal-verdict row.
 *
 * A reason with no copy must render NOTHING rather than leak
 * `terminal_reason:<enum>` into the transcript — and a state that renders
 * nothing is invisible until a surface shows it deliberately, which is what
 * this entry's last variant is for.
 *
 * The words and the tone come from the REAL sources — `parseTerminalReasonMarker`
 * off the stored marker and `chat.terminalReason.*` through `modeText`'s loud
 * miss — so a key that drifts out of a locale is unmissable here. Only the
 * surrounding markup is a copy of `ChatDisplay`'s `info` arm.
 */
function TerminalVerdictRowPlayground({
  reason,
  isError = false,
}: {
  reason: AgentTerminalReason
  isError?: boolean
}) {
  const { t } = useTranslation()
  // Round-trip through the REAL parse so the design surface exercises the same
  // structural check ChatDisplay does, then resolve the copy via the same i18n
  // helper — a key that drifts out of a locale shows `modeText`'s loud miss.
  const parsedReason = parseTerminalReasonMarker(terminalReasonMarker(reason))
  const noticeKey = parsedReason ? terminalReasonNoticeKey(parsedReason) : undefined
  const level = isError ? 'error' : 'warning'
  const config = {
    warning: { icon: AlertTriangle, className: 'text-info' },
    error: { icon: CircleAlert, className: 'text-destructive' },
  }[level]
  const Icon = config.icon

  return frame(
    <div className="rounded-[8px] border border-border/55 bg-background py-2 shadow-minimal">
      {noticeKey
        ? (
          <div className={cn('flex items-center gap-2 px-3 py-1 text-[13px] select-none', config.className)}>
            <div className="w-3 h-3 flex items-center justify-center shrink-0">
              <Icon className="w-3 h-3" />
            </div>
            <span>{modeText(t, noticeKey)}</span>
          </div>
        )
        : (
          <div className="px-3 py-1 text-[12px] text-muted-foreground">
            No row — `{reason}` has no verdict copy, and this ending owns a louder surface of its own.
          </div>
        )}
    </div>,
    'w-[460px]'
  )
}

function DarkThemeSweepNote() {
  return frame(
    <div className="rounded-[8px] border border-border/55 bg-background p-3 text-foreground shadow-minimal">
      <div className="mb-2 flex items-center gap-2 text-[13px] font-medium">
        <Clock3 className="h-4 w-4 text-accent" />
        Dark theme sweep
      </div>
      <div className="space-y-1 text-[12px] text-muted-foreground">
        <p>Plan-3 parity entries use semantic tokens: background, foreground, border, muted, accent, success, info, and destructive.</p>
        <p>No warning token or one-off literal palette is required for the new states.</p>
      </div>
    </div>
  )
}

export const parityUiComponents: ComponentEntry[] = [
  {
    id: 'parity-permission-mode-selector',
    name: 'Parity / Permission Mode Selector',
    category: 'Chat',
    description: 'The composer\'s mode chip (desktop) and drawer selector (compact) — v0.15.1\'s tinted pill over our six modes, badges, digits and runtime note — on a runtime that enforces the mode and on one that cannot, locked, and in narrow panels.',
    component: PermissionModeSelectorPlayground,
    layout: 'centered',
    props: [
      {
        name: 'mode',
        description: 'Permission mode',
        control: { type: 'select', options: permissionModeOptions },
        defaultValue: 'default',
      },
      {
        name: 'runtime',
        description: 'Active runtime — codex-runtime adds the per-mode enforcement note (R15)',
        control: { type: 'select', options: permissionModeRuntimeOptions },
        defaultValue: 'pi',
      },
      {
        name: 'defaultMode',
        description: 'The workspace default mode — the row that carries the "Default" badge (F1.1052)',
        control: { type: 'select', options: permissionModeOptions },
        defaultValue: 'auto',
      },
      {
        name: 'locked',
        description: 'ComposerCapabilities.permissions.locked — the trigger is disabled and no menu opens (UB14.29)',
        control: { type: 'boolean' },
        defaultValue: false,
      },
      {
        name: 'narrow',
        description: 'Panels below 32rem (desktop) and 24rem (compact): both chips fold to their tinted icon (UB14.29)',
        control: { type: 'boolean' },
        defaultValue: false,
      },
      {
        name: 'menuOpen',
        description: 'Open the desktop menu on mount: rows, digits, the runtime note and the cycle-shortcut footer (UB14.29)',
        control: { type: 'boolean' },
        defaultValue: false,
      },
    ],
    variants: [
      ...permissionModeOptions.map(option => ({
        name: option.label,
        props: { mode: option.value, runtime: 'pi' as ModelProvider },
      })),
      // The tallest state the dropdown reaches: every row carries a note.
      ...permissionModeOptions.map(option => ({
        name: `${option.label} on codex`,
        props: { mode: option.value, runtime: 'codex-runtime' as ModelProvider },
      })),
      // UB14.29 — the lock and the icon-only folds.
      { name: 'Locked (Manual)', props: { mode: 'default' as PermissionMode, runtime: 'pi' as ModelProvider, locked: true } },
      { name: 'Narrow panels (icon only)', props: { mode: 'acceptEdits' as PermissionMode, runtime: 'pi' as ModelProvider, narrow: true } },
      { name: 'Menu open on codex', props: { mode: 'plan' as PermissionMode, runtime: 'codex-runtime' as ModelProvider, menuOpen: true } },
    ],
  },
  {
    id: 'parity-terminal-verdict-row',
    name: 'Parity / Terminal Verdict Row',
    category: 'Chat',
    description: 'The transcript row that says WHY a turn ended — one per reason that has copy, plus the silent state a reason without copy must render.',
    component: TerminalVerdictRowPlayground,
    layout: 'centered',
    props: [
      {
        name: 'reason',
        description: 'Terminal reason carried by the complete event',
        control: { type: 'select', options: TERMINAL_REASON_OPTIONS },
        defaultValue: 'max_budget_usd',
      },
      {
        name: 'isError',
        description: 'terminalIsError — tone only: a cap is a warning, a provider blow-up an error',
        control: { type: 'boolean' },
        defaultValue: false,
      },
    ],
    variants: [
      { name: 'max_agent_turns', props: { reason: 'max_agent_turns', isError: false } },
      { name: 'max_budget_usd', props: { reason: 'max_budget_usd', isError: false } },
      { name: 'max_budget_tokens', props: { reason: 'max_budget_tokens', isError: false } },
      { name: 'structured_output_retry_exhausted', props: { reason: 'structured_output_retry_exhausted', isError: false } },
      { name: 'provider_refusal', props: { reason: 'provider_refusal', isError: false } },
      { name: 'provider_error (is_error)', props: { reason: 'provider_error', isError: true } },
      // The state that is invisible everywhere else: no copy, no row.
      { name: 'user_stop — no row', props: { reason: 'user_stop', isError: false } },
    ],
  },
  {
    id: 'parity-agent-elapsed',
    name: 'Parity / Agent Elapsed',
    category: 'Chat',
    description: 'Started-at elapsed timers in subagent and workflow agent rows.',
    component: AgentElapsedPlayground,
    layout: 'centered',
    props: [],
    variants: [{ name: 'Subagent and workflow', props: {} }],
  },
  {
    id: 'parity-todo-list-card',
    name: 'Parity / Todo List Card',
    category: 'Chat',
    description: 'TodoWrite activity rendering with mixed pending, active, and completed states.',
    component: TodoListParityPlayground,
    layout: 'centered',
    props: [],
    variants: [{ name: 'Mixed state', props: {} }],
  },
  {
    id: 'parity-memory-viewer',
    name: 'Parity / Memory Viewer',
    category: 'Markdown',
    description: '/memory viewer content using the same markdown rendering surface as session files.',
    component: MemoryViewerPlayground,
    layout: 'centered',
    props: [],
    variants: [{ name: 'MEMORY.md', props: {} }],
  },
  {
    id: 'parity-checkpoint-revert-action',
    name: 'Parity / Checkpoint Revert Action',
    category: 'Session List',
    description: 'SessionMenu checkpoint revert affordance next to existing session actions.',
    component: CheckpointRevertActionPlayground,
    layout: 'centered',
    previewOverflow: 'visible',
    props: [],
    variants: [{ name: 'Menu open', props: {} }],
  },
  {
    id: 'parity-context-overlay-suggestions',
    name: 'Parity / Context Overlay Suggestions',
    category: 'Chat',
    description: '/context breakdown with the optimization-suggestion group in every state it can reach.',
    component: ContextOverlaySuggestionsPlayground,
    layout: 'top',
    props: [
      {
        name: 'suggestions',
        description: 'Which suggestions the snapshot carries',
        control: {
          type: 'select',
          options: [
            { label: 'None', value: 'none' },
            { label: 'MCP tools', value: 'mcp' },
            { label: 'Memory files', value: 'memory' },
            { label: 'Skills', value: 'skills' },
            { label: 'All three', value: 'all' },
          ],
        },
        defaultValue: 'all',
      },
      {
        name: 'overLimit',
        description: 'Show the documented over-limit warning above the rows',
        control: { type: 'boolean' },
        defaultValue: false,
      },
      {
        name: 'notLoaded',
        description: 'Which catalog diagnostics the not-loaded group carries',
        control: {
          type: 'select',
          options: [
            { label: 'None', value: 'none' },
            { label: 'Ancestor layer cap', value: 'cap' },
            { label: 'Over-size skip', value: 'oversize' },
            { label: 'Both', value: 'both' },
          ],
        },
        defaultValue: 'none',
      },
    ],
    variants: [
      { name: 'No suggestions', props: { suggestions: 'none', overLimit: false, notLoaded: 'none' } },
      { name: 'MCP tools', props: { suggestions: 'mcp', overLimit: false, notLoaded: 'none' } },
      { name: 'Memory files', props: { suggestions: 'memory', overLimit: false, notLoaded: 'none' } },
      { name: 'Skills', props: { suggestions: 'skills', overLimit: false, notLoaded: 'none' } },
      { name: 'All three', props: { suggestions: 'all', overLimit: false, notLoaded: 'none' } },
      { name: 'All three, over limit', props: { suggestions: 'all', overLimit: true, notLoaded: 'none' } },
      { name: 'Ancestor layer cap', props: { suggestions: 'none', overLimit: false, notLoaded: 'cap' } },
      { name: 'Both not-loaded notices', props: { suggestions: 'all', overLimit: false, notLoaded: 'both' } },
    ],
  },
  {
    id: 'parity-compact-model-selector',
    name: 'Parity / Compact Model Selector',
    category: 'Chat Inputs',
    description: "The composer's model control in every state derivePickerMode can reach, plus the translated-wire mark.",
    component: CompactModelSelectorPlayground,
    layout: 'centered',
    previewOverflow: 'visible',
    props: [
      {
        name: 'state',
        description: 'What the active connection offers',
        control: {
          type: 'select',
          options: [
            { label: 'Empty model list', value: 'empty' },
            { label: 'One model (locked single)', value: 'single' },
            { label: 'Several models (flat)', value: 'flat' },
            { label: 'Translated wire marked', value: 'translated' },
          ],
        },
        defaultValue: 'flat',
      },
      {
        name: 'unavailable',
        description: 'The active connection is gone or errored',
        control: { type: 'boolean' },
        defaultValue: false,
      },
      {
        name: 'open',
        description: 'Open the drawer',
        control: { type: 'boolean' },
        defaultValue: false,
      },
      {
        name: 'switchable',
        description: 'The composer may move the session to another integration',
        control: { type: 'boolean' },
        defaultValue: true,
      },
      {
        name: 'processing',
        description: 'A turn is in flight, so the integration row cannot move',
        control: { type: 'boolean' },
        defaultValue: false,
      },
      REASONING_KNOB,
      {
        name: 'twoRuntimes',
        description: 'A second integration on another runtime (codex), so the integration row can switch',
        control: { type: 'boolean' },
        defaultValue: false,
      },
      {
        name: 'narrow',
        description: 'A panel under 26rem: the chip folds to the Cpu glyph',
        control: { type: 'boolean' },
        defaultValue: false,
      },
    ],
    variants: [
      { name: 'Trigger, several models', props: { state: 'flat', unavailable: false, open: false, switchable: true, processing: false } },
      { name: 'Open, several models', props: { state: 'flat', unavailable: false, open: true, switchable: true, processing: false } },
      { name: 'Empty model list', props: { state: 'empty', unavailable: false, open: true, switchable: true, processing: false } },
      { name: 'One model', props: { state: 'single', unavailable: false, open: true, switchable: true, processing: false } },
      { name: 'Translated wire marked', props: { state: 'translated', unavailable: false, open: true, switchable: true, processing: false } },
      { name: 'Connection unavailable', props: { state: 'flat', unavailable: true, open: true, switchable: true, processing: false } },
      { name: 'Turn in flight', props: { state: 'flat', unavailable: false, open: true, switchable: true, processing: true } },
      { name: 'Not switchable', props: { state: 'flat', unavailable: false, open: true, switchable: false, processing: false } },
      // UB14.30 — v0.15.1's narrow fold, our integration row with somewhere to go, and the capability-driven levels.
      { name: 'Narrow panel (Cpu glyph)', props: { state: 'flat', unavailable: false, open: false, switchable: true, processing: false, narrow: true } },
      { name: 'Two runtimes', props: { state: 'flat', unavailable: false, open: true, switchable: true, processing: false, twoRuntimes: true } },
      { name: 'Codex effort levels (off–high)', props: { state: 'flat', unavailable: false, open: true, switchable: true, processing: false, reasoning: 'reduced' } },
      { name: 'No effort levels', props: { state: 'flat', unavailable: false, open: true, switchable: true, processing: false, reasoning: 'none' } },
    ],
  },
  {
    id: 'parity-desktop-model-picker',
    name: 'Parity / Composer Model Menu (desktop)',
    category: 'Chat Inputs',
    description: "The WIDE-window picker — v0.15.1's ComposerModelMenu chip and menu over ours (the integration row, the runtime's effort levels, the effort pill) — the one RS-44 caught missing both disclosure lines and DA2.25 caught missing the per-row mark. Same fixtures and same states as the compact selector above, so the two can be read against each other.",
    component: ComposerModelMenuPlayground,
    layout: 'centered',
    previewOverflow: 'visible',
    props: [
      {
        name: 'state',
        description: 'What the active connection offers — the same four the compact selector uses',
        control: {
          type: 'select',
          options: [
            { label: 'Empty model list', value: 'empty' },
            { label: 'One model (locked single)', value: 'single' },
            { label: 'Several models (flat)', value: 'flat' },
            { label: 'Translated wire marked', value: 'translated' },
          ],
        },
        defaultValue: 'flat',
      },
      {
        name: 'unavailable',
        description: 'The active connection is gone or errored',
        control: { type: 'boolean' },
        defaultValue: false,
      },
      {
        name: 'switchable',
        description: 'The composer may move the session to another integration',
        control: { type: 'boolean' },
        defaultValue: true,
      },
      {
        name: 'processing',
        description: 'A turn is in flight, so the integration row cannot move',
        control: { type: 'boolean' },
        defaultValue: false,
      },
      {
        name: 'open',
        description: 'Open the menu above the chip',
        control: { type: 'boolean' },
        defaultValue: true,
      },
      REASONING_KNOB,
      {
        name: 'twoRuntimes',
        description: 'A second integration on another runtime (codex), so the integration row can switch',
        control: { type: 'boolean' },
        defaultValue: false,
      },
      {
        name: 'integrationOpen',
        description: "Open the integration row's target list (each target names its runtime)",
        control: { type: 'boolean' },
        defaultValue: false,
      },
    ],
    variants: [
      { name: 'Several models', props: { state: 'flat', unavailable: false, switchable: true, processing: false } },
      { name: 'Empty model list', props: { state: 'empty', unavailable: false, switchable: true, processing: false } },
      { name: 'One model', props: { state: 'single', unavailable: false, switchable: true, processing: false } },
      { name: 'Translated wire marked — RS-44 and DA2.25 in one view', props: { state: 'translated', unavailable: false, switchable: true, processing: false } },
      { name: 'Connection unavailable', props: { state: 'flat', unavailable: true, switchable: true, processing: false } },
      { name: 'Turn in flight', props: { state: 'flat', unavailable: false, switchable: true, processing: true } },
      { name: 'Not switchable', props: { state: 'flat', unavailable: false, switchable: false, processing: false } },
      // UB14.30 — the chip at rest, the integration row open on two runtimes, and the capability-driven levels.
      { name: 'Trigger only (menu closed)', props: { state: 'flat', unavailable: false, switchable: true, processing: false, open: false } },
      { name: 'Two runtimes, integration open', props: { state: 'flat', unavailable: false, switchable: true, processing: false, twoRuntimes: true, integrationOpen: true } },
      { name: 'Codex effort levels (off–high)', props: { state: 'flat', unavailable: false, switchable: true, processing: false, reasoning: 'reduced' } },
      { name: 'No effort levels — no pill, no sub-menu', props: { state: 'flat', unavailable: false, switchable: true, processing: false, reasoning: 'none' } },
    ],
  },
  {
    id: 'parity-dark-theme-sweep',
    name: 'Parity / Dark Theme Sweep',
    category: 'Chat',
    description: 'Token-only dark-theme sweep note for the Plan-3 parity states.',
    component: DarkThemeSweepNote,
    layout: 'centered',
    props: [],
    variants: [{ name: 'Token sweep', props: {} }],
  },
]
