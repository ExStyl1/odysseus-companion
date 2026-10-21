import type {
  FileAttachment,
  FuzzyResourceSearchResult,
  PermissionMode,
  QueuedMessageDto,
  SessionEvent,
} from '../../shared/types'
import type { SafeCapabilitySummary } from '@nessy-agent/shared/protocol/capabilities'
import type { BackgroundTaskOutputResult } from '@nessy-agent/shared/protocol'
import type { IssuedProjectHandle } from '@nessy-agent/shared/projects/project-handle-service'

// ============================================================================
// Mock electronAPI
// ============================================================================

export const mockElectronAPI = {
  isDebugMode: async () => true,

  /**
   * BYO endpoint setup. `fetchModels` answers with a small llm-proxy-shaped
   * catalog (families, a filled context length, an unfilled one) so the model
   * picker's states are reachable in the playground; `validateModels` returns
   * one verdict of each kind.
   */
  testLlmConnectionSetup: async (params: { fetchModels?: boolean; validateModels?: string[] }) => {
    if (params?.fetchModels) {
      return {
        success: true,
        models: [
          { id: 'tgpt/qwen35-397b-a17b-fp8', name: 'tgpt/qwen35-397b-a17b-fp8', description: 'Qwen coder', contextWindow: 262_144 },
          { id: 'tgpt/gemma-4-31b-it', name: 'tgpt/gemma-4-31b-it', description: 'Gemma instruct' },
          { id: 'anthropic/claude-opus-5', name: 'anthropic/claude-opus-5', description: 'Opus', contextWindow: 1_000_000 },
          { id: 'openrouter/google/gemini-3-pro', name: 'openrouter/google/gemini-3-pro', description: 'Gemini via OpenRouter', contextWindow: 1_000_000 },
          { id: 'llama3.2', name: 'llama3.2', description: 'Local model, no family prefix', contextWindow: 131_072 },
        ],
      }
    }
    if (params?.validateModels?.length) {
      const verdicts = ['ok', 'no-quota', 'error'] as const
      return {
        success: true,
        modelProbes: params.validateModels.map((id, index) => ({ id, verdict: verdicts[index % verdicts.length]! })),
      }
    }
    return { success: true }
  },

  /**
   * Every provider card ON — deliberately more permissive than any real build.
   * The flags are build-time gates; a design surface has to show the states,
   * and without this the mock never resolves and ProviderSelectStep keeps its
   * conservative pre-resolve seed, hiding four of the cards it renders.
   */
  getProviderFlags: async () => ({
    nessy: true,
    nessy_cloud: true,
    nessy_codex: true,
    nessy_claude: true,
    claude: true,
    chatgpt: true,
    api_key: true,
    local: true,
  }),

  capabilities: {
    getCatalog: async () => ({ generation: 'playground', installedPlugins: [], capabilities: mockSources, diagnostics: [] }),
    getComposerCatalog: async () => ({ generation: 'playground', items: mockSources }),
    getDetail: async () => { throw new Error('No capability detail in playground') },
    preview: async () => { throw new Error('No capability preview in playground') },
    summary: async () => { throw new Error('No capability summary in playground') },
    open: async () => undefined,
    submitManagedEdit: async () => ({ workspaceId: 'playground-workspace', sessionId: 'playground-edit' }),
    onChanged: () => () => undefined,
  },

  // Called at module-load time by SessionFilesSection.tsx (and others) to
  // branch between Electron and web-UI rendering. Must be synchronous.
  getRuntimeEnvironment: (): 'electron' | 'web' => 'electron',

  // F1.470 (2) — the composer's working-directory picker (`use-working-directory-state.ts`) reads this on
  // mount and on every open, so every entry that renders it reaches here; only `input-container` overrode it,
  // and every other entry died on `undefined(…)`. A design surface with no history answers an empty list;
  // a scenario that wants rows still shadows it with `overrideElectronApiMethod('listRecentProjects', …)`.
  listRecentProjects: async (_workspaceId: string) => [],

  openFileDialog: async () => {
    console.log('[Playground] openFileDialog called')
    return [] // Let user use file input or drag-drop
  },

  readFileAttachment: async (path: string) => {
    console.log('[Playground] readFileAttachment called:', path)
    return null // Let FileReader API handle it
  },

  generateThumbnail: async (base64: string, mimeType: string) => {
    console.log('[Playground] generateThumbnail called')
    return null // Skip thumbnails in playground
  },

  openFolderDialog: async () => {
    console.log('[Playground] openFolderDialog called')
    return null
  },

  getTaskOutput: async (taskId: string) => {
    console.log('[Playground] getTaskOutput called:', taskId)
    return `Output for task ${taskId}:\n\nThis is a mock output in the playground.\nIn the real app, this would show the actual task output.`
  },

  /**
   * UB14.7 — the task chip's card reads here (v0.15.1's playground answers `getBackgroundTaskOutput` per id prefix;
   * ours is the session-scoped `readBackgroundTaskOutput`). An `agent-` id answers a Claude digest (live or, with
   * `done`, its result); {@link PLAYGROUND_FAILED_SHELL_ID} a failed lint run; any other id a running test watcher.
   * The ticker's liveness probe (cursor past the end) gets an empty running answer.
   */
  readBackgroundTaskOutput: async (sessionId: string, taskId: string, cursor?: number): Promise<BackgroundTaskOutputResult> => {
    console.log('[Playground] readBackgroundTaskOutput called:', sessionId, taskId, cursor)
    if (cursor === Number.MAX_SAFE_INTEGER) return { success: true, output: '', isRunning: true }
    if (taskId.startsWith('agent-')) {
      const done = taskId.includes('done')
      const message = done
        ? '**Radix popovers trap focus while open.** Hand focus back after unmount in a `requestAnimationFrame`, and pass `onCloseAutoFocus` when the trigger unmounts with the content.\n\n- `forwardRef` on portal children, or exit animations cannot run.'
        : 'Starting with the evaluator: `newAutoLabelEntries` is only called from SessionManager, so the merge rules hold.'
      return {
        success: true,
        output: message,
        isRunning: !done,
        digest: {
          kind: 'agent',
          message,
          steps: [
            { tool: 'Read', label: 'evaluator.ts' },
            { tool: 'Grep', label: 'newAutoLabelEntries' },
            { tool: 'Bash', label: 'Run label tests' },
            { tool: 'mcp__github__search_code', label: 'Search Code' },
          ],
          truncated: false,
        },
      }
    }
    if (taskId === PLAYGROUND_FAILED_SHELL_ID) {
      return { success: true, command: 'bun run lint', output: '$ eslint src\nsrc/a.ts\n  12:7  error  Unexpected any  @typescript-eslint/no-explicit-any\n\n✖ 1 problem (1 error, 0 warnings)\n', isRunning: false, exitCode: 1 }
    }
    return {
      success: true,
      command: 'bun test --watch',
      output: 'bun test v1.3.10\n\nsrc/labels/values.test.ts:\n✓ LabelEntrySet > a plain entry is present [0.02ms]\n✓ LabelEntrySet > values keep everything [0.01ms]\n\n 89 pass\n 0 fail\nRan 89 tests across 9 files. [150.00ms]\n\nWatching for file changes…\n',
      isRunning: true,
    }
  },

  queueGet: async (_sessionId: string): Promise<{ queue: QueuedMessageDto[]; paused: boolean }> => {
    void _sessionId
    return { queue: [], paused: false }
  },

  queueDelete: async (_sessionId: string, _messageId: string) => {
    void _sessionId
    void _messageId
  },

  queueSendNow: async (_sessionId: string, _messageId: string) => {
    void _sessionId
    void _messageId
  },

  queueResume: async (_sessionId: string) => {
    void _sessionId
  },

  gitBranches: async (_sessionId: string) => {
    void _sessionId
    return { status: 'not-a-repo' as const }
  },

  gitCheckout: async (_sessionId: string, _branch: string, _autoStash?: boolean) => {
    void _sessionId
    void _branch
    void _autoStash
    return { status: 'error' as const, error: 'No git repository in playground' }
  },

  fuzzyFileSearch: async (_sessionId: string, _query: string) => {
    void _sessionId
    void _query
    return null
  },

  onSessionEvent: (_callback: (event: SessionEvent) => void) => {
    void _callback
    return () => {}
  },

  // Session files API used by SessionFilesSection (Info popover)
  getSessionFiles: async (session: { workspaceId: string; sessionId: string }) => {
    console.log('[Playground] getSessionFiles called:', session)
    return []
  },

  openSessionFile: async (input: { session: { workspaceId: string; sessionId: string }; handleId: string }) => {
    console.log('[Playground] openSessionFile called:', input)
  },

  previewSessionFile: async (input: { session: { workspaceId: string; sessionId: string }; handleId: string }) => {
    console.log('[Playground] previewSessionFile called:', input)
    return null
  },

  openSessionAttachment: async (input: { session: { workspaceId: string; sessionId: string }; handleId: string }) => {
    console.log('[Playground] openSessionAttachment called:', input)
  },

  revealSessionStorage: async (session: { workspaceId: string; sessionId: string }) => {
    console.log('[Playground] revealSessionStorage called:', session)
  },

  copySessionStoragePath: async (session: { workspaceId: string; sessionId: string }) => {
    console.log('[Playground] copySessionStoragePath called:', session)
  },

  openSessionArtifact: async (input: { session: { workspaceId: string; sessionId: string }; kind: string }) => {
    console.log('[Playground] openSessionArtifact called:', input)
  },

  watchSessionFiles: (sessionId: string) => {
    console.log('[Playground] watchSessionFiles called:', sessionId)
  },

  unwatchSessionFiles: () => {
    console.log('[Playground] unwatchSessionFiles called')
  },

  onSessionFilesChanged: (callback: (sessionId: string) => void) => {
    console.log('[Playground] onSessionFilesChanged subscribed')
    // Keep callback referenced for parity/debugging, but no events emitted in playground
    void callback
    return () => {
      console.log('[Playground] onSessionFilesChanged unsubscribed')
    }
  },

  // F1.353 made NavigationProvider read the label tree (useLabels), so every entry wrapped in
  // PlaygroundChatProviders needs these two or it renders a blank frame.
  listLabels: async (_workspaceId: string) => [],
  onLabelsChanged: (callback: (workspaceId: string) => void) => {
    void callback
    return () => undefined
  },

  browserPane: {
    focus: async (instanceId: string) => {
      console.log('[Playground] browserPane.focus called:', instanceId)
    },
  },

  openFile: async (path: string) => {
    console.log('[Playground] openFile called:', path)
    alert(`Would open file in system editor:\n${path}`)
  },

  showInFolder: async (path: string) => {
    console.log('[Playground] showInFolder called:', path)
    alert(`Would reveal in file manager:\n${path}`)
  },

  // NavigationProvider subscribes to deep-link IPC on mount; in the playground
  // there is no main process firing these events, so the listener is a no-op.
  onDeepLinkNavigate: (_callback: unknown) => {
    void _callback
    return () => {}
  },

  // Debug menu actions invoked by the mobile menu's Debug sub-page in dev mode.
  // The real implementations call into the auto-updater; the playground just logs.
  checkForUpdates: () => {
    console.log('[Playground] checkForUpdates called')
  },
  installUpdate: () => {
    console.log('[Playground] installUpdate called')
  },

  // ChatDisplay required mocks
  readPreferences: async () => {
    return { diffViewerSettings: { showFilePath: true, expandedSections: {} } }
  },

  writePreferences: async (prefs: unknown) => {
    console.log('[Playground] writePreferences called:', prefs)
  },

  // FreeFormInput required mocks
  getAutoCapitalisation: async () => false,

  getPendingPlanExecution: async (sessionId: string) => {
    console.log('[Playground] getPendingPlanExecution called:', sessionId)
    return null
  },

  getSendMessageKey: async () => 'enter',
  getSpellCheck: async () => true,

  // Pi provider discovery mocks
  getPiApiKeyProviders: async () => [
    { key: 'anthropic', label: 'Anthropic', placeholder: 'sk-ant-...' },
    { key: 'openai', label: 'OpenAI', placeholder: 'sk-...' },
    { key: 'google', label: 'Google AI Studio', placeholder: 'AIza...' },
    { key: 'deepseek', label: 'DeepSeek', placeholder: 'sk-...' },
  ],
  getPiProviderBaseUrl: async () => '',
  getPiProviderModels: async (provider: string) => {
    const MOCK_MODELS: Record<string, Array<{ id: string; name: string; costInput: number; costOutput: number; contextWindow: number; reasoning: boolean }>> = {
      'openrouter': [
        // Top 10 expensive
        { id: 'anthropic/claude-opus-4.8', name: 'Claude Opus 4.8', costInput: 5, costOutput: 25, contextWindow: 1000000, reasoning: true },
        { id: 'anthropic/claude-opus-4.7', name: 'Claude Opus 4.7', costInput: 5, costOutput: 25, contextWindow: 1000000, reasoning: true },
        { id: 'xai/grok-4', name: 'Grok 4', costInput: 6, costOutput: 18, contextWindow: 256000, reasoning: true },
        { id: 'anthropic/claude-sonnet-4.6', name: 'Claude Sonnet 4.6', costInput: 3, costOutput: 15, contextWindow: 200000, reasoning: true },
        { id: 'openai/gpt-5.2-codex', name: 'GPT-5.2 Codex', costInput: 1.75, costOutput: 14, contextWindow: 400000, reasoning: false },
        { id: 'google/gemini-2.5-pro', name: 'Gemini 2.5 Pro', costInput: 1.25, costOutput: 10, contextWindow: 1048576, reasoning: true },
        { id: 'openai/o3', name: 'OpenAI o3', costInput: 2, costOutput: 8, contextWindow: 200000, reasoning: true },
        { id: 'mistralai/mistral-large', name: 'Mistral Large', costInput: 2, costOutput: 6, contextWindow: 131072, reasoning: false },
        { id: 'anthropic/claude-haiku-4.5', name: 'Claude Haiku 4.5', costInput: 1, costOutput: 5, contextWindow: 200000, reasoning: false },
        { id: 'cohere/command-r-plus', name: 'Command R+', costInput: 2.5, costOutput: 5, contextWindow: 128000, reasoning: false },
        { id: 'openai/o4-mini', name: 'OpenAI o4-mini', costInput: 1.1, costOutput: 4.4, contextWindow: 200000, reasoning: true },
        // Bottom 10 cheap
        { id: 'google/gemini-2.5-flash', name: 'Gemini 2.5 Flash', costInput: 0.3, costOutput: 2.5, contextWindow: 1048576, reasoning: false },
        { id: 'deepseek/deepseek-r1', name: 'DeepSeek R1', costInput: 0.55, costOutput: 2.19, contextWindow: 128000, reasoning: true },
        { id: 'openai/gpt-5-mini', name: 'GPT-5 Mini', costInput: 0.25, costOutput: 2, contextWindow: 400000, reasoning: false },
        { id: 'meta-llama/llama-4-maverick', name: 'Llama 4 Maverick', costInput: 0.2, costOutput: 0.6, contextWindow: 1000000, reasoning: false },
        { id: 'mistralai/mistral-small', name: 'Mistral Small', costInput: 0.1, costOutput: 0.3, contextWindow: 131072, reasoning: false },
        { id: 'google/gemma-3-27b', name: 'Gemma 3 27B', costInput: 0.1, costOutput: 0.2, contextWindow: 96000, reasoning: false },
        { id: 'qwen/qwen3-32b', name: 'Qwen3 32B', costInput: 0.08, costOutput: 0.18, contextWindow: 131072, reasoning: false },
        { id: 'deepseek/deepseek-chat-v3', name: 'DeepSeek V3', costInput: 0.07, costOutput: 0.14, contextWindow: 128000, reasoning: false },
        { id: 'meta-llama/llama-4-scout', name: 'Llama 4 Scout', costInput: 0.05, costOutput: 0.1, contextWindow: 512000, reasoning: false },
        { id: 'microsoft/phi-4', name: 'Phi-4', costInput: 0.03, costOutput: 0.05, contextWindow: 16384, reasoning: false },
      ],
      'groq': [
        { id: 'llama-3.3-70b-versatile', name: 'Llama 3.3 70B', costInput: 0.59, costOutput: 0.79, contextWindow: 131072, reasoning: false },
        { id: 'llama3-8b-8192', name: 'Llama 3 8B', costInput: 0.05, costOutput: 0.08, contextWindow: 8192, reasoning: false },
        { id: 'gemma2-9b-it', name: 'Gemma 2 9B', costInput: 0.2, costOutput: 0.2, contextWindow: 8192, reasoning: false },
      ],
      'mistral': [
        { id: 'mistral-large-2512', name: 'Mistral Large', costInput: 2, costOutput: 6, contextWindow: 131072, reasoning: false },
        { id: 'mistral-medium-3.1', name: 'Mistral Medium 3.1', costInput: 1, costOutput: 3, contextWindow: 131072, reasoning: false },
        { id: 'mistral-small-3.2-24b-instruct', name: 'Mistral Small 3.2', costInput: 0.1, costOutput: 0.3, contextWindow: 131072, reasoning: false },
      ],
      'deepseek': [
        { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', costInput: 0.56, costOutput: 1.68, contextWindow: 128000, reasoning: true },
        { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', costInput: 0.14, costOutput: 0.42, contextWindow: 128000, reasoning: true },
      ],
      'xai': [
        { id: 'grok-4', name: 'Grok 4', costInput: 6, costOutput: 18, contextWindow: 256000, reasoning: true },
        { id: 'grok-4-fast', name: 'Grok 4 Fast', costInput: 3, costOutput: 9, contextWindow: 256000, reasoning: false },
        { id: 'grok-3-mini-beta', name: 'Grok 3 Mini', costInput: 0.3, costOutput: 0.5, contextWindow: 131072, reasoning: false },
      ],
      'cerebras': [
        { id: 'llama-3.3-70b', name: 'Llama 3.3 70B', costInput: 0.85, costOutput: 1.2, contextWindow: 8192, reasoning: false },
      ],
      'huggingface': [
        { id: 'meta-llama/Llama-3.3-70B-Instruct', name: 'Llama 3.3 70B', costInput: 0.5, costOutput: 0.7, contextWindow: 131072, reasoning: false },
      ],
      'azure-openai-responses': [
        { id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol', costInput: 5, costOutput: 30, contextWindow: 272000, reasoning: true },
        { id: 'gpt-5.6-terra', name: 'GPT-5.6 Terra', costInput: 2.5, costOutput: 15, contextWindow: 272000, reasoning: true },
        { id: 'gpt-5.6-luna', name: 'GPT-5.6 Luna', costInput: 1, costOutput: 6, contextWindow: 272000, reasoning: true },
        { id: 'gpt-5.2', name: 'GPT-5.2', costInput: 1.75, costOutput: 14, contextWindow: 400000, reasoning: false },
        { id: 'gpt-4o', name: 'GPT-4o', costInput: 2.5, costOutput: 10, contextWindow: 128000, reasoning: false },
        { id: 'gpt-4o-mini', name: 'GPT-4o Mini', costInput: 0.15, costOutput: 0.6, contextWindow: 128000, reasoning: false },
      ],
      'amazon-bedrock': [
        { id: 'anthropic.claude-opus-4.8', name: 'Claude Opus 4.8', costInput: 5, costOutput: 25, contextWindow: 1000000, reasoning: true },
        { id: 'anthropic.claude-opus-4.7', name: 'Claude Opus 4.7', costInput: 5, costOutput: 25, contextWindow: 1000000, reasoning: true },
        { id: 'anthropic.claude-sonnet-4.6', name: 'Claude Sonnet 4.6', costInput: 3, costOutput: 15, contextWindow: 200000, reasoning: true },
        { id: 'anthropic.claude-haiku-4.5', name: 'Claude Haiku 4.5', costInput: 1, costOutput: 5, contextWindow: 200000, reasoning: false },
      ],
      'zai': [
        { id: 'glm-5', name: 'GLM-5', costInput: 1, costOutput: 3.2, contextWindow: 128000, reasoning: true },
        { id: 'glm-4.7', name: 'GLM-4.7', costInput: 0.6, costOutput: 2.2, contextWindow: 128000, reasoning: false },
        { id: 'glm-4.7-flash', name: 'GLM-4.7 Flash', costInput: 0, costOutput: 0, contextWindow: 128000, reasoning: false },
      ],
      'vercel-ai-gateway': [
        { id: 'anthropic/claude-opus-4.8', name: 'Claude Opus 4.8', costInput: 5, costOutput: 25, contextWindow: 1000000, reasoning: true },
        { id: 'anthropic/claude-opus-4.7', name: 'Claude Opus 4.7', costInput: 5, costOutput: 25, contextWindow: 1000000, reasoning: true },
        { id: 'anthropic/claude-sonnet-4.6', name: 'Claude Sonnet 4.6', costInput: 3, costOutput: 15, contextWindow: 200000, reasoning: true },
        { id: 'openai/gpt-5.2-codex', name: 'GPT-5.2 Codex', costInput: 1.75, costOutput: 14, contextWindow: 400000, reasoning: false },
      ],
    }
    const models = MOCK_MODELS[provider] ?? []
    // Simulate the IPC handler's totalCount — openrouter and vercel have many more in reality
    const MOCK_TOTAL_COUNTS: Record<string, number> = { 'openrouter': 233, 'vercel-ai-gateway': 129, 'amazon-bedrock': 79 }
    return { models, totalCount: MOCK_TOTAL_COUNTS[provider] ?? models.length }
  },

}

/**
 * Inject mock electronAPI into window if not already present.
 * Call this in playground component wrappers before rendering components
 * that depend on electronAPI.
 *
 * IMPORTANT: this also runs as a top-level side effect when this module is
 * imported (see below), so that consumers relying on a synchronous
 * `window.electronAPI.*` read at module-load time (e.g.
 * `SessionFilesSection.tsx`'s top-level `getRuntimeEnvironment()` call) see
 * the mock before their module is evaluated. The entry `playground.tsx`
 * must import this module before any component chain that touches
 * `window.electronAPI` at import time.
 */
let installedMockBridge = false

export function ensureMockElectronAPI() {
  if (!window.electronAPI) {
    ;(window as any).electronAPI = mockElectronAPI
    installedMockBridge = true
    console.log('[Playground] Injected mock electronAPI')
  }
}

/**
 * Which bridge the playground is actually rendering against (P6.668).
 *
 * `'mock'` — this module installed the fixture, which is the only supported
 *   state: nothing a playground entry does can reach a real session.
 * `'foreign'` — a bridge was ALREADY on `window` when this module loaded, so
 *   `ensureMockElectronAPI` yielded to it and every registry entry would render
 *   against the REAL RPC.
 *
 * ## Why the second state exists, and that it has already happened
 *
 * Every app `BrowserWindow` is created with
 * `preload: join(__dirname, 'bootstrap-preload.cjs')`, which has already run
 * `contextBridge.exposeInMainWorld` by the time this module evaluates. So
 * `playground.html` opened inside an app window renders the whole registry
 * against the live session, not the fixture — and the `if (!window.electronAPI)`
 * above is precisely what makes that silent. It is not theoretical: the
 * docblock on {@link overrideElectronApiMethod}, twenty lines below, records the
 * `input-container` entry crashing on `Cannot assign to read only property`
 * because the real API was present. Somebody has run this page against a live
 * bridge and seen it.
 *
 * The reachable route is DEV — `isRendererAppUrl` admits any path on the Vite
 * origin, so `http://localhost:5173/playground.html` loads in a real app window.
 * P6.667 closed the packaged half by narrowing that guard to `index.html`; this
 * is the other half, and it is the half that covers dev.
 *
 * ## Why a flag and not a fallback
 *
 * The smallest honest thing here is a REFUSAL, not a wrapper. Wrapping the real
 * bridge in something mock-shaped means deciding, per method, which live calls
 * are safe — a judgement that is wrong the moment a method is added, and wrong
 * invisibly. A design surface that cannot prove it is talking to a fixture
 * should not render. `playground.tsx` reads this and says so on screen.
 */
export type PlaygroundBridgeKind = 'mock' | 'foreign'

export function playgroundBridgeKind(): PlaygroundBridgeKind {
  // Read off the INSTALL, not off a snapshot of `window.electronAPI` taken at
  // module scope. A snapshot depends on this module's own statement order —
  // move the `ensureMockElectronAPI()` call below one line and it silently
  // inverts — while the flag records what actually happened. Same lesson as
  // `applyManagedEnv`'s origin record (AGENTS.md § Traps, W7-r): assert on what
  // the code did, not on what a value looked like nearby.
  return installedMockBridge ? 'mock' : 'foreign'
}

/**
 * The refusal itself: a visible page saying which bridge was found and why the
 * playground will not render against it.
 *
 * A pure function returning STATIC markup, for two reasons that pull the same
 * way. It has to work when the thing we refuse to trust is already installed, so
 * it must depend on no app component, no React tree and no `electronAPI` call.
 * And this repo has no DOM implementation in its test environment at all —
 * renderer suites go through `react-dom/server` — so a function that builds
 * nodes could not be tested here, while a function that returns text can be.
 *
 * There is no interpolation anywhere in the template: every character is a
 * literal, so `innerHTML` at the single call site has nothing to inject into.
 * Keep it that way — the moment a value is spliced in, this needs escaping or a
 * node builder.
 */
export function playgroundBridgeRefusalHtml(): string {
  return [
    '<div role="alert" data-playground-refusal="foreign-bridge"',
    ' style="max-width:44rem;margin:4rem auto;padding:1.5rem;',
    'font:14px/1.6 system-ui,sans-serif;border:1px solid #d33;border-radius:8px">',
    '<h1 style="margin:0 0 .75rem;font-size:1.1rem">',
    'Playground not started: a real app bridge is present</h1>',
    '<p style="margin:0 0 .75rem">This page is the design playground. It renders every ',
    'registry entry against a fixture, and it found a window.electronAPI it did not ',
    'install &mdash; the one an app window&rsquo;s preload exposes.</p>',
    '<p style="margin:0 0 .75rem">Rendering here would drive the REAL session: live RPC, ',
    'real sessions, real files. So it refuses rather than falling back, because a ',
    'fallback would have to decide per method which live calls are safe, and would be ',
    'wrong invisibly.</p>',
    '<p style="margin:0">Open playground.html in a plain browser tab against the dev ',
    'server instead, or in a window with no preload.</p>',
    '</div>',
  ].join('')
}

/**
 * Override one `electronAPI` method for the lifetime of a playground scenario.
 *
 * Playground entries used to assign straight onto `window.electronAPI`. In the
 * BROWSER playground that works, because the object above is a plain literal.
 * Inside Electron it does not: the real API arrives through
 * `contextBridge.exposeInMainWorld` (`preload/bootstrap.ts:486`), which hands
 * the isolated world an immutable proxy, so the assignment throws
 * `TypeError: Cannot assign to read only property` and takes the whole entry
 * down. The `input-container` entry crashed this way.
 *
 * `defineProperty` with `configurable: true` works on both: it shadows the
 * frozen member rather than writing through it, and the returned disposer puts
 * the original back. Playground scenarios must use this instead of assigning.
 */
export function overrideElectronApiMethod<K extends keyof Window['electronAPI']>(
  name: K,
  implementation: Window['electronAPI'][K],
): () => void {
  const target = window.electronAPI as unknown as Record<string, unknown>
  const original = Object.getOwnPropertyDescriptor(target, name as string)
  Object.defineProperty(target, name as string, {
    value: implementation,
    configurable: true,
    writable: true,
    enumerable: true,
  })
  return () => {
    if (original) Object.defineProperty(target, name as string, original)
    else delete target[name as string]
  }
}

// Install on import so any later module that reads `window.electronAPI` at top level finds the mock in place
// (idempotent). UA7.5: only where a window exists — a bun test importing a registry entry has none.
if (typeof window !== 'undefined') ensureMockElectronAPI()

// ============================================================================
// Sample Data
// ============================================================================

export const mockSources: SafeCapabilitySummary[] = [
  {
    key: 'source:github-api', kind: 'source', sourceType: 'api', logicalName: 'GitHub API', description: 'Access repositories, issues, and pull requests', iconUrl: 'https://www.google.com/s2/favicons?domain=github.com&sz=128', mention: { type: 'source', id: 'github-api', qualifiedId: 'source:github-api', selectedAsShortAlias: true, label: 'GitHub API' }, origin: 'native', scope: { kind: 'workspace', workspaceId: 'playground-workspace' }, state: 'active', readOnly: false, trustState: 'not-required', credentialState: 'ready', selectedAsUnqualifiedAlias: true, diagnosticCodes: [],
  },
  {
    key: 'source:linear-api', kind: 'source', sourceType: 'api', logicalName: 'Linear', description: 'Issue tracking and project management', iconUrl: 'https://www.google.com/s2/favicons?domain=linear.app&sz=128', mention: { type: 'source', id: 'linear-api', qualifiedId: 'source:linear-api', selectedAsShortAlias: true, label: 'Linear' }, origin: 'native', scope: { kind: 'workspace', workspaceId: 'playground-workspace' }, state: 'active', readOnly: false, trustState: 'not-required', credentialState: 'ready', selectedAsUnqualifiedAlias: true, diagnosticCodes: [],
  },
  {
    key: 'source:local-files', kind: 'source', sourceType: 'local', logicalName: 'Local Files', mention: { type: 'source', id: 'local-files', qualifiedId: 'source:local-files', selectedAsShortAlias: true, label: 'Local Files' }, origin: 'native', scope: { kind: 'workspace', workspaceId: 'playground-workspace' }, state: 'active', readOnly: false, trustState: 'not-required', credentialState: 'not-required', selectedAsUnqualifiedAlias: true, diagnosticCodes: [],
  },
]

/**
 * MCP resources offered in the `@` autocomplete — `mcp.md` § Use MCP resources,
 * "Type `@` in your prompt to see available resources from all connected MCP
 * servers. Resources appear alongside files in the autocomplete menu."
 *
 * Server + `scheme://path` pairs matching the documented reference format
 * (`@github:issue://123`), so the playground row shows exactly what a real
 * resource-advertising server produces.
 */
export const mockMcpResources: FuzzyResourceSearchResult[] = [
  { server: 'github', uri: 'issue://123', name: 'Flaky mention menu on Pi', description: 'Open issue #123' },
  { server: 'github', uri: 'pr://456', name: 'Resource mentions', description: 'Open pull request #456' },
  { server: 'docs', uri: 'file://api/authentication', name: 'Authentication', description: 'API documentation', mimeType: 'text/markdown' },
  { server: 'postgres', uri: 'schema://users', name: 'users', description: 'Table schema', mimeType: 'application/json' },
]

/** The host-side substring match, mirrored so the mock filters like the real one. */
export function filterMockMcpResources(query: string): FuzzyResourceSearchResult[] {
  const normalized = query.trim().toLowerCase()
  if (!normalized) return [...mockMcpResources]
  return mockMcpResources.filter(resource =>
    resource.uri.toLowerCase().includes(normalized)
    || resource.server.toLowerCase().includes(normalized)
    || (resource.name?.toLowerCase().includes(normalized) ?? false)
    || (resource.description?.toLowerCase().includes(normalized) ?? false))
}

export const sampleImageAttachment: FileAttachment = {
  type: 'image',
  path: '/Users/demo/screenshot.png',
  name: 'screenshot.png',
  mimeType: 'image/png',
  size: 245000,
  base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
}

export const samplePdfAttachment: FileAttachment = {
  type: 'pdf',
  path: '/Users/demo/design.pdf',
  name: 'design.pdf',
  mimeType: 'application/pdf',
  size: 1024000,
}

// ============================================================================
// Mock Callbacks
// ============================================================================

export const mockInputCallbacks = {
  onSubmit: (message: string, attachments?: FileAttachment[]) => {
    console.log('[Playground] Message submitted:', { message, attachments })
  },

  onModelChange: (model: string) => {
    console.log('[Playground] Model changed to:', model)
  },

  onInputChange: (value: string) => {
    console.log('[Playground] Input changed:', value.substring(0, 50) + (value.length > 50 ? '...' : ''))
  },

  onHeightChange: (height: number) => {
    console.log('[Playground] Height changed:', height)
  },

  onFocusChange: (focused: boolean) => {
    console.log('[Playground] Focus changed:', focused)
  },

  onPermissionModeChange: (mode: PermissionMode) => {
    console.log('[Playground] Permission mode changed:', mode)
  },

  onSourcesChange: (slugs: string[]) => {
    console.log('[Playground] Sources changed:', slugs)
  },

  onWorkingDirectoryChange: (project: IssuedProjectHandle) => {
    console.log('[Playground] Working directory changed:', project.displayPath)
  },

  onStop: () => {
    console.log('[Playground] Stop requested')
  },
}

export const mockAttachmentCallbacks = {
  onRemove: (index: number) => {
    console.log('[Playground] Remove attachment at index:', index)
  },

  onOpenFile: (path: string) => {
    console.log('[Playground] Open file:', path)
  },
}

/** UB14.7 — Pi supervisor handles (`process_` + 32 hex) for the playground's shell chips: the running watcher and the failed lint run. */
export const PLAYGROUND_SHELL_ID = `process_${'0123456789abcdef'.repeat(2)}`
export const PLAYGROUND_FAILED_SHELL_ID = `process_${'fedcba9876543210'.repeat(2)}`

export const mockBackgroundTaskCallbacks = {
  // UB12.79 — v0.15.1's composer task props (`onStopTask` / `onDismissTask` take the row).
  onStopTask: (task: { id: string }) => {
    console.log('[Playground] Stop task:', task.id)
  },
  onDismissTask: (task: { id: string }) => {
    console.log('[Playground] Dismiss task:', task.id)
  },
}
