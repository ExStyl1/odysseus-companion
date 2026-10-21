/**
 * Server DTO types — data shapes used by RPC handlers and SessionManager.
 *
 * These were previously in apps/electron/src/shared/types.ts.
 * Extracted here so handler code in @nessy-agent/server-core can import
 * from @nessy-agent/shared/protocol without reaching into the app.
 */

import type {
  AgentRetryFacts,
  BackgroundTaskSummary,
  Message,
  TypedError,
  ContentBadge,
  ToolDisplayMeta,
  AnnotationV1,
  AskUserAnswer,
  CacheUsageSnapshot,
  ContextUsageSnapshot,
  CostReporting,
  PersistedModelUsage,
  AgentTerminalReason,
  PermissionRequest as BasePermissionRequest,
  PermissionRequestType,
} from '@nessy-agent/core/types'
import type { OrchestrationProgress } from '@nessy-agent/core'
import type { PermissionMode } from '../agent/mode-types'
import type { ThinkingLevel } from '../agent/thinking-levels'
import type { CustomEndpointConfig } from '../config/llm-connections'
import type { ModelDefinition, ModelProvider } from '../config/models'
import type { DpAuthError, DpSessionStatus } from '../auth/dp'
import type {
  AuthRequest as SharedAuthRequest,
  CredentialInputMode as SharedCredentialInputMode,
  CredentialAuthRequest as SharedCredentialAuthRequest,
} from '../agent/index'
import type { RuntimeAdvertisedRostersV1 } from '../agent/backend/types'
import type { SessionAgentDefinitionV1 } from '../agents/definitions'
// D1.69 — the module, not the package root: `plugins/index.ts` pulls in the
// whole plugin subsystem, and this file is imported by the renderer.
import type { SessionScopedPluginSourceV1 } from '../plugins/session-scoped'
import type { AutomationLoopGuardSkip } from '../automations/constants'

// Re-export generateMessageId for handler convenience
export { generateMessageId } from '@nessy-agent/core/types'

// ---------------------------------------------------------------------------
// Session types
// ---------------------------------------------------------------------------

/**
 * Dynamic status ID referencing workspace status config.
 * Validated at runtime via validateSessionStatus().
 * Falls back to 'todo' if status doesn't exist.
 */
export type SessionStatus = string

export type BuiltInStatusId = 'todo' | 'in-progress' | 'needs-review' | 'done' | 'cancelled'

export type {
  AskUserAnswer,
  AskUserQuestionItem,
  AskUserQuestionOption,
  AskUserUrlConsent,
  AskUserUrlConsentWarning,
  CacheUsageSnapshot,
  ContextUsageCategory,
  ContextUsageCategoryId,
  ContextUsageCategoryItem,
  ContextUsageLoadedFile,
  ContextUsageSnapshot,
  ContextUsageSuggestion,
  ContextUsageSuggestionId,
  CostReporting,
  PersistedModelUsage,
} from '@nessy-agent/core/types'

/** Server-resolved composer configuration for the session's active integration. */
export interface ComposerPermissionModeOption {
  mode: PermissionMode
  label?: string
  shortLabel?: string
  description?: string
  iconMode?: PermissionMode
  remoteModeId?: string
}

export interface ComposerCapabilities {
  attachments: { files: boolean; images: 'yes' | 'no' | 'per-model'; folders: boolean }
  mentions: { files: boolean; skills: boolean; sources: boolean }
  /**
   * `excludedCommandIds` subtracts from `commandIds` (additive-optional so old
   * clients ignore it and fail OPEN: the command shows and the server answers
   * with a typed error). Exists because 'all' cannot express "all except":
   * the id vocabulary lives in the renderer, so the server cannot enumerate an
   * allowlist without duplicating it.
   *
   * `excludedCommandIdPrefixes` subtracts the same way, for the command
   * FAMILIES whose ids the server cannot enumerate because they are minted from
   * user data: a saved workflow recipe is `custom:workflow:<name>` and the names
   * are discovered per session (P2.279). Same subtraction, same fail-open on an
   * old client; a family is named by the prefix its id builder mints
   * (`workflowSlashCommandId`, `pluginWorkflowCommandId`), never by a
   * re-spelling.
   */
  slash: {
    commandIds: string[] | 'all'
    excludedCommandIds?: string[]
    excludedCommandIdPrefixes?: string[]
  }
  submit: { queue: boolean; steer: boolean }
  reasoning: { levels: ThinkingLevel[] }
  permissions: { modes: PermissionMode[]; locked?: boolean; modeOptions?: ComposerPermissionModeOption[] }
  /**
   * P6.940 — the agent this session is actually running AS, when the runtime
   * applies the pin. Absent means an ordinary session.
   *
   * Resolved SERVER-side and per session rather than read from the setting by
   * the renderer, because the setting is app-wide and the pin is not: claude has
   * a main-thread agent option (`Options.agent`) and Pi has the host-composed
   * projection clause (2) built, while codex layers role config for SPAWNED
   * agents only — so a badge derived from the raw key would put `@X` on a codex
   * session that ignores it, the advertised-and-unavailable shape
   * `excludedCommandIds` beside it exists to prevent. The two live arms were
   * turned on one row apart (clause (1), then P6.961) with no renderer change,
   * which is what resolving it here buys.
   */
  sessionAgent?: string
  /**
   * P6.951 + P6.864 — this session's runtime carries an ANSWER note to the
   * model, so the permission card may offer one. Absent means it does not, and
   * the affordance is not drawn.
   *
   * BOTH halves, by two different mechanisms, which is why one boolean is
   * honest: the denial note is native everywhere (claude's
   * `PermissionResult.deny.message`, codex's `rejection`, Pi's receipt
   * `reason`), and the approval note has no channel on any runtime, so the host
   * queues it onto the next turn's user tail for all three
   * (`BaseAgent.recordPermissionAnswerNote`). A runtime carries both or neither.
   *
   * Resolved server-side for `sessionAgent`'s reason directly above: the note is
   * only worth typing if something reads it. On a runtime that drops it the
   * field would be the advertised-and-unavailable shape `excludedCommandIds`
   * exists to prevent — the user would write a sentence to nobody.
   */
  answerNote?: true
  /**
   * UB14.34 (R4-14) — this session's runtime can start a shell command as a BACKGROUND task with its own
   * tool, so the composer may offer "Run in background" on a pasted console snippet (upstream v0.15.0
   * `ChatInputZone.tsx` `PastedCommandChip`). Absent means it cannot (or nobody has measured that it can),
   * and neither that offer nor a transcript code block's Run (UB12.91, `transcriptRunCommand`) is drawn.
   *
   * Resolved server-side (`resolveComposerCapabilities`) from the runtime's own mechanism, never from a
   * `providerType` in the renderer: Claude's `Bash` `run_in_background` (`tools-reference.md`, "Background
   * commands"), Pi's bash `run_in_background` (our local tool); both withdrawn by the background-task off
   * switch. Codex stays absent until UB14.19 measures whether its shell backgrounds without blocking the turn.
   */
  backgroundShell?: true
  /**
   * QK5 — what the ultracode toggle can do on THIS session's runtime.
   *
   * Absent means an older server that has no answer, and the composer draws no
   * control at all; it never means "unsupported", which is a real answer the
   * `mechanism` carries by name. That distinction is the whole point of the
   * field: on codex the control must be VISIBLY unavailable with its reason
   * (`SILENT-LOOSER` is the shape P6.214 measured and the ledger names visible
   * degradation as the pattern to copy), and silence cannot say that.
   *
   * Two of the three conditions `model-config.md#when-ultracode-is-available`
   * lists are answered here, because they are the two facts this resolver holds:
   * the runtime's mechanism and whether the active model can run `xhigh`. The
   * THIRD — workflows turned off — is the host's, resolved from three settings
   * layers this pure resolver deliberately does not read, and it reaches the
   * user as a one-line notice when they flip the toggle on, the same way
   * `claudeSwitchModelsInertNotice` answers a control that cannot bind. Stated
   * here rather than left to be rediscovered.
   */
  ultracode?: { mechanism: 'native-setting' | 'workflow-keyword' | 'unsupported'; modelCapable: boolean }
  /**
   * Whether this session may move to a different LLM connection, and which
   * runtime it is on right now.
   *
   * The renderer used to answer the first half itself, by guessing from the
   * transcript length (`isEmptySession`) — a connection locked at the first
   * message, so "no messages yet" was a serviceable proxy. A session can now
   * switch at any idle moment, and only the server knows the exceptions
   * (`nestor-cloud-agent` is not a switch target or source), so the answer
   * comes from here instead of being inferred.
   *
   * `activeRuntime` is what makes the confirmation tier computable in the
   * renderer: two integrations can carry the same vendor and the same models
   * and still answer through different runtimes.
   */
  connection: { switchable: boolean; activeRuntime: ModelProvider }
  contextMeter: boolean
  contextUsage?: {
    kind: 'fresh-local' | 'remote-reported' | 'unavailable'
    reason?: 'remote-not-reported' | 'unsupported' | 'unknown'
    /**
     * Where this backend's auto-compaction threshold comes from — the composer
     * draws a warning against it, so inventing one shows a prompt that cannot
     * do anything.
     *
     * - `real` — the backend reports its own; absent means there is none.
     * - `formula-claude` — the SDK's threshold is not reported but IS derivable
     *   from the window it is running on.
     * - `none` — this backend has no threshold we can know. No warning.
     * - `legacy` (also the value an older backend's absent field means) — the
     *   pre-reporting 77.5% fabrication, kept only where nothing better exists.
     */
    thresholdKind?: 'real' | 'formula-claude' | 'none' | 'legacy'
    refresh?: boolean
    compact?: { manual: boolean; auto?: boolean; structured?: boolean }
  }
  /**
   * UB12.77 — `gitBranch`: whether this session may show the composer's git-branch chip (ours; upstream has none).
   * Since UB14.31 that chip sits in the composer TOOLBAR after the folder chip, desktop only, not in a footer under
   * the card; the renderer's one reader is `composerMountsBranchChip` (`branch-switcher-helpers.ts`). Every
   * provider answers `true` today.
   *
   * The footer-era NAME is kept on purpose: every renderer since 1.0.1 reads `externalFooter.gitBranch` with no
   * guard, and a client of another 1.x version may pair with this server (`PROTOCOL_VERSION` checks the major
   * only), so a renamed object would throw in that client's composer. The `workingDir` half that sat beside it
   * from 1.0.1 was retired here: no version ever read it (`git log -S'externalFooter.workingDir'` finds no
   * commit), and the folder chip is gated by the folder callback, not by a capability. An older server that
   * still sends it is harmless — nothing reads it.
   */
  externalFooter: { gitBranch: boolean }
}

export interface RefreshContextUsageResult {
  success: boolean
  usage?: ContextUsageSnapshot
  unsupported?: boolean
  stale?: boolean
  error?: string
}

export interface GitBranchList {
  current: string | null
  branches: string[]
}

/**
 * Typed result of a branch listing. Distinguishes a healthy repo (`ok`, carries
 * the {@link GitBranchList}) from the reasons the switcher has nothing to show:
 * the session has no working directory (`no-cwd`), the directory is not a git
 * repository (`not-a-repo`), or git itself failed (`error`, carries a message).
 * The renderer uses this to render a disabled/explained affordance instead of
 * silently hiding the control. Additive: the `ok` branch is a superset of the
 * pre-existing `GitBranchList` fields.
 */
export type GitBranchesResult =
  | ({ status: 'ok' } & GitBranchList)
  | { status: 'no-cwd' }
  | { status: 'not-a-repo' }
  | { status: 'error'; error: string }

export interface GitCheckoutResult {
  /**
   * `success` — checkout completed. `dirty` — the working tree has uncommitted
   * changes and checkout was refused (no mutation happened); the UI may re-issue
   * the checkout with `autoStash` to stash → checkout → pop. `error` — git or
   * environment failure (carries a message).
   */
  status: 'success' | 'error' | 'dirty'
  error?: string
  /**
   * Only meaningful when the checkout ran with auto-stash and the trailing
   * `git stash pop` conflicted. Checkout of the target branch succeeded, but the
   * stashed changes could not be re-applied cleanly and remain on the stash
   * stack — surfaced so the user is never silently left with a broken tree.
   */
  stashPopConflict?: boolean
}

/**
 * Electron-specific Session type (includes runtime state).
 * Extends core Session with messages array and processing state.
 */
export interface Session {
  id: string
  workspaceId: string
  workspaceName: string
  name?: string
  /** Preview of first user message (from JSONL header, for lazy-loaded sessions) */
  preview?: string
  /**
   * P6.504 — one line of the session's OWN last output, precomputed in the
   * JSONL header the same way `preview` is, so the session list can say what a
   * session is doing without loading its messages and without spending a model
   * turn per row (Q-den 22 = A). Derivation: `summarizeSessionOutput`.
   */
  lastOutputSummary?: string
  lastMessageAt: number
  messages: Message[]
  isProcessing: boolean
  isFlagged?: boolean
  /**
   * P6.502 — this session is never written to disk, so resume, rewind and
   * search are all absent inside it. Mirrors the create-time
   * `CreateSessionOptions.ephemeral` and is FIXED for the life of the session,
   * which is why the renderer takes it as a prop rather than subscribing to it.
   *
   * Optional, and only ever `true` on the wire: an older server that omits it
   * reads as "saved normally" rather than failing the whole session decode.
   */
  ephemeral?: boolean
  /** Permission mode for this session ('dontAsk', 'plan', 'default', 'acceptEdits', 'auto', 'bypassPermissions') */
  permissionMode?: PermissionMode
  sessionStatus?: SessionStatus
  /** UB6.15 — set when the decision model moved the session to Needs Review at turn end: the visible reason. */
  statusSetByDecision?: { outcome: string; probability: number }
  /** Labels (additive tags, many-per-session — bare IDs or "id::value" entries) */
  labels?: string[]
  lastReadMessageId?: string
  /**
   * Explicit unread flag - single source of truth for NEW badge.
   * Set to true when assistant message completes while user is NOT viewing.
   * Set to false when user views the session (and not processing).
   */
  hasUnread?: boolean
  /**
   * F15 — how many permission requests this session is waiting on a human to
   * answer. DERIVED at read time from the live pending-request map, never
   * stored: a second copy of this would drift the moment a request expired or
   * was answered from another device, and a stale "waiting for you" badge is
   * worse than none.
   *
   * Optional so an older server that omits it reads as "not waiting" rather
   * than failing the whole session decode.
   */
  awaitingApprovalCount?: number
  /**
   * P6.764 — WHAT the oldest of those requests is waiting on, so a client that
   * has the count can also name the subject.
   *
   * The count alone told the session list that something is waiting and never
   * what; `SessionItem` names the prompt from this window's own
   * `pendingPermissions` map, which is empty for every prompt raised before the
   * window connected, against a session it never subscribed to, or on another
   * device. Those are exactly the cases `awaitingApprovalCount` exists for, and
   * they were the cases that fell back to the bare `session.attention.waiting`.
   *
   * Derived beside the count, from the same live map and never stored, for the
   * same reason: a stored copy would outlive the request. THE OLDEST pending
   * request, because the map is insertion-ordered and the first-raised prompt
   * is the one a client's own queue head also shows — describing a different
   * one would make two surfaces name two prompts for one badge.
   *
   * Both optional, and both must be read TOGETHER or not at all: they describe
   * ONE request, so pairing this `toolName` with some other source's `type`
   * would describe a prompt that does not exist. An older server omits both and
   * a client falls back to the subjectless label it already had.
   */
  awaitingApprovalToolName?: string
  /** P6.764 — the kind of that same oldest request; see {@link Session.awaitingApprovalToolName}. */
  awaitingApprovalType?: PermissionRequestType
  enabledSourceSlugs?: string[]
  workingDirectory?: string
  /**
   * D1.251 — where the runtime child is ACTUALLY started, which is not always
   * the directory the model is told about.
   *
   * `sdkCwd` is `workingDirectory` when the session has a project folder, and
   * the session's own managed storage directory when it does not
   * (`sessions/store-v2.ts`'s `create`: `options.workingDirectory ?? sessionDir`).
   * On a no-project session claude spawns in it — `resolveClaudeTranscriptCwd`'s
   * candidates are `sdkCwd` then the session dir — while `base-agent.ts` tells
   * the model `config.session?.workingDirectory ?? workspaceRootPath`, the
   * WORKSPACE ROOT. Two fallbacks that disagree, which is D1.141's finding: the
   * model is told one directory and a relative `Write` lands in another.
   *
   * **Declared here rather than filled anywhere.** It is already in
   * `SESSION_PERSISTENT_FIELDS`, and `managedToSession` builds every Session DTO
   * by spreading `pickSessionFields(m)`, so the value has always ridden the wire
   * — exactly as `workingDirectory`, `model` and `llmConnection` do, none of
   * which that function names either. What was missing was the DECLARATION: with
   * no field on this interface no client could read it, and D1.141's renderer
   * notice measured it as absent (0 occurrences over `protocol` + `renderer` +
   * `electron/shared`) and concluded a wire row was owed. The wire row is this
   * paragraph.
   *
   * Optional, like every other field here: an older server that omits it reads
   * as "unknown", and a surface that cannot name the directory says nothing
   * rather than guessing one.
   */
  sdkCwd?: string
  sharedUrl?: string
  sharedId?: string
  model?: string
  llmConnection?: string
  thinkingLevel?: ThinkingLevel
  /**
   * QK5 — the session's ultracode toggle, `true` or ABSENT.
   *
   * A RUNTIME-ONLY field, deliberately outside the persisted set: `sdk.d.ts`
   * calls the setting *"Session-scoped … interactive toggles never persist it"*,
   * and `settings-reference.md#ultracode` says *"Claude Code reads this key but
   * never writes it: `/effort ultracode` turns ultracode on for the current
   * session only"*. Projecting it is still necessary — without it a composer
   * that remounts would draw OFF while the session is ON, which is the silent
   * divergence the toggle exists to avoid.
   */
  ultracode?: true
  /**
   * D1.328 — what this session's runtime ADVERTISED about itself at start: the
   * Claude SDK's `system`/`init` tool, slash-command, skill and agent rosters.
   *
   * A DIAGNOSTICS field, not a user surface — plain names, no locale key, no
   * copy — decided that way because the question it answers is *"what did the
   * SDK say it had"*, which a developer, a live case and a support reading all
   * ask and no surface could answer: SIT-5b measured the adapter capturing all
   * four and NOTHING reading three of them, the SDK's own persisted session file
   * carrying no `init` entry, and the adapter's debug line for it occurring 0
   * times in a packaged run.
   *
   * RUNTIME-ONLY and emitted ONLY when the runtime has advertised something, for
   * `ultracode`'s reason above and one of its own: absent means *"not told
   * yet"*, while a present object with an empty `skills` means *"told, and there
   * are none"*. Every non-claude session and every claude session before its
   * first `init` therefore costs nothing on the wire — which matters, because
   * `getSessions()` projects every session in the workspace on a hot path.
   */
  runtimeAdvertisedRosters?: RuntimeAdvertisedRostersV1
  lastMessageRole?: 'user' | 'assistant' | 'plan' | 'tool' | 'error'
  lastFinalMessageId?: string
  isAsyncOperationOngoing?: boolean
  /** @deprecated Use isAsyncOperationOngoing instead */
  isRegeneratingTitle?: boolean
  currentStatus?: {
    message: string
    statusType?: string
    /** P6.916 — the retry's own facts, when this status is one. */
    retry?: AgentRetryFacts
  }
  /**
   * P6.424 — the plugin suggestion this session may show BELOW THE SPINNER while
   * a turn runs, carried structurally so the renderer owns the wording.
   *
   * `plugin-relevance.md` § What the user sees, verbatim: *"**Spinner tip**: a
   * "Working with *topic*? Install the *plugin* plugin" message with the
   * `/plugin install` command appears below the spinner while Claude is
   * responding."* Transient like `currentStatus` beside it — never persisted,
   * cleared when the turn ends — and `undefined` on the shipped default,
   * because the whole suggestion surface is gated on the managed-only
   * `pluginSuggestionMarketplaces` allowlist.
   */
  pluginSuggestionTip?: {
    /** Fills "Working with *topic*?" — the relevance signal's own phrase. */
    topic: string
    /** `<plugin>@<marketplace>`, the same reference the session-start notice names. */
    reference: string
  }
  createdAt?: number
  messageCount?: number
  tokenUsage?: {
    inputTokens: number
    outputTokens: number
    totalTokens: number
    contextTokens: number
    costUsd: number
    cacheReadTokens?: number
    cacheCreationTokens?: number
    /**
     * P6.616 — the derived cache breakdown (`warm`/`cold`, hit ratio, TTL), so
     * `/usage` can answer "is caching working" instead of printing two raw
     * counters. Stamped by the session layer, which is the only place that can
     * fill `ttl`; a reader that finds it absent derives the rest from the two
     * counters above through `describeCacheUsage`.
     */
    cache?: CacheUsageSnapshot
    /** Model's context window size in tokens (from SDK modelUsage) */
    contextWindow?: number
    contextUsage?: ContextUsageSnapshot
    /** Per-model breakdown, when the backend reported one. */
    modelUsage?: Record<string, PersistedModelUsage>
    /**
     * Whether `costUsd` is a figure a backend established. The cost surface must
     * resolve this through `resolveCostDisplay` rather than reading `costUsd`
     * directly — an unmarked zero is not zero spend.
     */
    costReporting?: CostReporting
  }
  contextUsage?: ContextUsageSnapshot
  /** When true, session is hidden from session list (e.g., mini edit sessions) */
  hidden?: boolean
  isArchived?: boolean
  archivedAt?: number
  supportsBranching?: boolean
  composerCapabilities?: ComposerCapabilities
}

/** Opaque backend-issued reference to one file inside managed session storage. */
export interface SessionFileHandle {
  handleId: string
  name: string
  /** Relative display path only; never an absolute managed-storage path. */
  displayPath: string
  kind: 'file' | 'directory'
  size?: number
}

/** Opaque backend-owned recent project row. The ID never encodes a path. */
export interface RecentProjectSummary {
  id: string
  displayPath: string
  lastUsedAt: number
}

export type ProjectTrustSelection = 'trusted' | 'untrusted'

export type SetProjectTrustInput =
  | { workspaceId: string; projectHandleId: string; state: ProjectTrustSelection }
  | { session: import('../sessions/types').SessionKey; state: ProjectTrustSelection }

export interface SetSessionProjectInput {
  session: import('../sessions/types').SessionKey
  /** `null` resets the session to its managed cwd. */
  projectHandleId: string | null
}

export interface SetWorkspaceDefaultProjectInput {
  workspaceId: string
  /** `null` clears the default for future sessions. */
  projectHandleId: string | null
}

export interface CreateSessionOptions {
  name?: string
  permissionMode?: PermissionMode
  /**
   * Reasoning/thinking level override. When set, takes precedence over workspace
   * and global defaults. Silently ignored by the underlying SDK on non-reasoning
   * models (e.g. gpt-4o) — provider drivers don't attach the reasoning param to
   * the API request for models with `reasoning: false` in the Pi SDK catalog.
   */
  thinkingLevel?: ThinkingLevel
  /** Opaque Workspace-bound project selection. */
  projectHandleId?: string
  /** Compatibility sentinel only; external paths require `projectHandleId`. */
  workingDirectory?: 'user_default' | 'none'
  model?: string
  llmConnection?: string
  systemPromptPreset?: 'default' | 'mini' | string
  hidden?: boolean
  sessionStatus?: SessionStatus
  labels?: string[]
  isFlagged?: boolean
  enabledSourceSlugs?: string[]
  /**
   * In-memory only: no session record or metadata is written to disk; the
   * session vanishes on close/restart.
   */
  ephemeral?: boolean
  /**
   * Message ID to branch from. This is a hard context cutoff:
   * the new session must not include model context from later parent messages.
   */
  branchFromMessageId?: string
  /** Parent session ID used together with branchFromMessageId. */
  branchFromSessionId?: string
  /**
   * Start the session already isolated in a git worktree (P6.20).
   *
   * `true` derives the name from the session id. A STRING is either the
   * worktree's name or, since P6.335, a merge-request/pull-request URL — the
   * HOST decides which, by path segment (`/-/merge_requests/<n>`,
   * `/pull/<n>`), so no caller carries a second copy of a forge's URL
   * contract. A URL branches the worktree from that request's head
   * (`merge-requests/<n>/head` on gitlab, `pull/<n>/head` on github, fetched
   * from `origin`, no forge credential) and labels the session `!<n>` / `#<n>`.
   * Until this
   * field existed a worktree could only be ENTERED mid-session, so no session
   * ever STARTED isolated — the one exception being the scheduled-task path,
   * which has created one at session creation since desktop-scheduled-tasks.md
   * asked for it, through the same host port this field now reaches.
   *
   * REFUSES rather than falling back: a session asked to start isolated and
   * given the live checkout instead is the one outcome the request rules out.
   * The refusal deletes the half-made session, so a failure leaves nothing
   * behind in the picker.
   */
  worktree?: boolean | string
  /**
   * P6.317 (2) — subagent definitions for THIS session only, keyed by agent
   * name, as the `--agents` flag supplies them.
   *
   * `sub-agents.md#choose-the-subagent-scope` puts this scope at priority 2 —
   * above `.claude/agents/`, `~/.claude/agents/` and plugin `agents/`, below
   * managed settings only — so a name here DISPLACES the same name on disk.
   * `materializePiRuntimeAgentDefinitions` applies that rule; see
   * {@link SessionAgentDefinitionV1} for the fifteen fields the page defines.
   *
   * Nothing is written to disk and nothing enters the capability snapshot: the
   * definitions live for the life of the created session, which is the flag's
   * documented shape and the whole value of it for automation and headless
   * runs. A session reopened later therefore has none, by construction.
   */
  agents?: Readonly<Record<string, SessionAgentDefinitionV1>>
  /**
   * D1.69 — plugin bundles for THIS session only: a local directory, or a URL
   * archive the host fetches and validates through the ordinary install
   * pipeline.
   *
   * Deliberately the sibling of {@link CreateSessionOptions.agents} above, one
   * capability-kind up, and with the same lifetime: nothing is written to the
   * plugin registry and nothing is placed in the plugin cache, so the bundle
   * lives only as long as the session object and a session reopened later has
   * none. A bundle whose `pluginKey` matches an installed plugin SHADOWS it for
   * this session, which is what makes "try a directory you are working on
   * without uninstalling the copy you have" possible at all.
   *
   * The ONE way it differs from `agents`, stated because the difference is
   * load-bearing: these DO enter the capability snapshot, because the snapshot
   * is the only path by which a plugin's commands, skills, agents, hooks and
   * MCP servers reach a turn. They are therefore subject to exactly the same
   * managed plugin policy as an installed one — a managed denial is not
   * escapable by starting a session with the bundle instead of installing it.
   *
   * REFUSES rather than falling back, for the reason
   * {@link CreateSessionOptions.worktree} gives: a session asked to start with a
   * plugin and started without it is the one outcome the request rules out. A
   * source that cannot be fetched, staged or validated fails `createSession`
   * with the load diagnostics and leaves nothing behind.
   */
  plugins?: readonly SessionScopedPluginSourceV1[]
}

export interface RemoteSessionTransferPayload {
  sourceSessionId: string
  name?: string
  sessionStatus?: SessionStatus
  labels?: string[]
  permissionMode?: PermissionMode
  summary: string
}

export interface ImportRemoteSessionTransferResult {
  sessionId: string
}

export interface PermissionModeState {
  permissionMode: PermissionMode
  previousPermissionMode?: PermissionMode
  transitionDisplay?: string
  modeVersion: number
  changedAt: string
  changedBy: 'user' | 'system' | 'restore' | 'automation' | 'unknown'; /** F1.1165 — the mode a new session in this workspace starts in (the phone's "Default" badge); absent from an older host */ workspaceDefaultPermissionMode?: PermissionMode
}

/** One pending follow-up message queued while the agent is processing. */
export interface QueuedMessageDto {
  id: string
  text: string
  attachmentsCount: number; /** F1.481 (2): `sendQueuedNow`'s own verdict — false for files, a workflow or a schema; absent from an older host */ steerable?: boolean
}

export interface FuzzyFileSearchResult {
  root: string
  path: string
  match_type: 'file' | 'directory'
  file_name: string
  score: number
  indices: number[] | null
}

/** One MCP resource offered in the `@` autocomplete alongside files. */
export interface FuzzyResourceSearchResult {
  server: string
  uri: string
  name?: string
  mimeType?: string
  description?: string
}

export interface FuzzyFileSearchResponse {
  files: FuzzyFileSearchResult[]
  /** MCP resources matching the query, from resource-advertising sources. */
  resources?: FuzzyResourceSearchResult[]
}

// ---------------------------------------------------------------------------
// Session events (main → renderer)
// ---------------------------------------------------------------------------

// turnId: Correlation ID from the API's message.id, groups all events in an assistant turn
export type SessionEvent = SessionTextDiscardEvent | SessionMetadataChangedEvent | ProjectIdChangedEvent
  | {
      type: 'text_delta'
      sessionId: string
      delta: string
      turnId?: string
      /**
       * R32 · the display-only companion of `delta`, and the ONLY field a
       * `MessageDisplay` hook can move (hooks.md:876 — "`displayContent`
       * replaces the displayed text on screen. Display-only: the transcript and
       * what Claude sees keep the original"). A surface renders
       * `displayDelta ?? delta`; `delta` itself stays the model's own output and
       * is what the transcript is built from.
       *
       * Absent means original, which is also the documented fail-open
       * (hooks.md:740 — "`MessageDisplay` | No | The original text is
       * displayed"). The cost of that direction, stated plainly because it is
       * the page's posture and not ours to improve: a client that IGNORES this
       * field renders the unredacted text, so a redaction hook fails silently
       * rather than loudly.
       */
      displayDelta?: string
    }
  | {
      type: 'text_complete'
      sessionId: string
      text: string
      isIntermediate?: boolean
      /**
       * P4.4 · the intermediate text is the model's reasoning, not commentary.
       * Always accompanied by `isIntermediate: true`, so a client that only
       * knows the older field is unaffected. Never set for a redacted
       * reasoning block — those have no readable text and are dropped at the
       * adapter.
       */
      isThinking?: boolean
      turnId?: string
      parentToolUseId?: string
      timestamp?: number
      messageId?: string
      /**
       * R32 · `displayDelta`'s counterpart on the final batch: the display-only
       * replacement for `text`. Same rules — a surface renders
       * `displayText ?? text`, persistence and what the model sees always read
       * `text`, and an absent field means the original.
       */
      displayText?: string
    }
  | { type: 'tool_start'; sessionId: string; toolName: string; toolUseId: string; toolInput: Record<string, unknown>; toolIntent?: string; toolDisplayName?: string; toolDisplayMeta?: ToolDisplayMeta; turnId?: string; parentToolUseId?: string; timestamp?: number }
  // UB1.16 — toolInput: replaces the input sent with tool_start (a browser_tool password fill is redacted once its result is known)
  | { type: 'tool_result'; sessionId: string; toolUseId: string; toolName: string; result: string; turnId?: string; parentToolUseId?: string; isError?: boolean; timestamp?: number; toolInput?: Record<string, unknown> }
  | { type: 'error'; sessionId: string; error: string; timestamp?: number }
  | { type: 'typed_error'; sessionId: string; error: TypedError; timestamp?: number }
  | {
      type: 'complete'
      sessionId: string
      tokenUsage?: Session['tokenUsage']
      contextUsage?: ContextUsageSnapshot
      hasUnread?: boolean
      terminalReason?: AgentTerminalReason
      /** The documented `deferred_tool_use` payload on tool_deferred(_unavailable) terminations (R7 Task 5). */
      deferredToolUse?: { id: string; name: string; input: Record<string, unknown> }
      /** hooks.md: `tool_deferred_unavailable` exits with `is_error: true`. */
      terminalIsError?: boolean
      /** R18: the validated turn structured output (success arm; absent when no schema rode the turn). */
      structuredOutput?: unknown
      /** R18: result subtype for a schema-bearing turn — `success` or `error_max_structured_output_retries`. */
      structuredOutputSubtype?: 'success' | 'error_max_structured_output_retries'
      /** R18: the result's errors list; tells validation exhaustion apart from the non-validation endings. */
      structuredOutputErrors?: string[]
    }
  | { type: 'interrupted'; sessionId: string; message?: Message; queuedMessages?: string[]; retainedPermissionRequestIds?: string[] } // F1.911 — the ids the host still holds that surface on this session, named at the Stop so the renderer's turn-end clear drops only what the host dropped; absent means the host names nothing
  // `hook` is a hook's `statusMessage` (hooks.md § Common fields): a transient
  // spinner label, cleared with an empty message, never a transcript entry.
  // P6.916 — `retry` rides beside the sentence rather than inside it: the chip
  // reads the attempt, the cause and the wait as fields, and `message` stays the
  // line a client that does not read them still shows.
  | { type: 'status'; sessionId: string; message: string; statusType?: 'compacting' | 'hook' | 'retrying' | 'runtime_turn' | 'phase'; retry?: AgentRetryFacts } // F1.524 (2): runtime_turn = a claude turn the host did not start; F1.1150: phase = a runtime phase label (AgentEvent status `phase`)
  /**
   * P6.424 — the spinner tip's payload, emitted at most once per session while a
   * turn is running. Structural rather than a rendered sentence: the wording is
   * `chat.pluginSuggestion.spinnerTip` and belongs to the surface, so a second
   * client renders it in its own locale instead of receiving ours.
   */
  | { type: 'plugin_suggestion_tip'; sessionId: string; topic: string; reference: string }
  | { type: 'info'; sessionId: string; message: string; statusType?: 'compaction_complete'; level?: 'info' | 'warning' | 'error' | 'success'; timestamp?: number }
  | { type: 'title_generated'; sessionId: string; title: string }
  | { type: 'title_regenerating'; sessionId: string; isRegenerating: boolean }
  | { type: 'async_operation'; sessionId: string; isOngoing: boolean }
  | { type: 'working_directory_changed'; sessionId: string; workingDirectory: string }
  | { type: 'permission_request'; sessionId: string; request: PermissionRequest }
  | { type: 'permission_request_cancelled'; sessionId: string; requestId: string }
  | { type: 'credential_request'; sessionId: string; request: CredentialRequest }
  | { type: 'permission_mode_changed'; sessionId: string; permissionMode: PermissionMode; previousPermissionMode?: PermissionMode; transitionDisplay?: string; modeVersion?: number; changedAt?: string; changedBy?: PermissionModeState['changedBy'] }
  | { type: 'plan_submitted'; sessionId: string; message: Message }
  | { type: 'sources_changed'; sessionId: string; enabledSourceSlugs: string[] }
  | { type: 'labels_changed'; sessionId: string; labels: string[] }
  | { type: 'connection_changed'; sessionId: string; connectionSlug: string; supportsBranching?: boolean }
  | { type: 'task_backgrounded'; sessionId: string; toolUseId: string; taskId: string; intent?: string; turnId?: string }
  // P6.109 — the claude backend's background AGENT tasks, REPLACE semantics.
  // Forwarded with no server-side effect; `tasks: []` retires the rows.
  | { type: 'background_tasks_replaced'; sessionId: string; tasks: readonly BackgroundTaskSummary[] }
  | { type: 'shell_backgrounded'; sessionId: string; toolUseId: string; shellId: string; intent?: string; command?: string; turnId?: string }
  | { type: 'task_progress'; sessionId: string; toolUseId: string; elapsedSeconds?: number; orchestrationProgress?: OrchestrationProgress; turnId?: string }
  // UB9.8 (v0.15.1) — what a running background task of the session's own agent is doing; forwarded only for a
  // task this session registered (SessionManager.processEvent). `summary` is an MCP task's own status (F1.901 keeps
  // the model-written agent summaries off).
  | { type: 'task_activity'; sessionId: string; taskId: string; toolUseId?: string; summary?: string; lastToolName?: string; toolUses?: number; turnId?: string }
  | { type: 'task_completed'; sessionId: string; taskId: string; status: 'completed' | 'failed' | 'stopped'; outputFile?: string; summary?: string; turnId?: string }
  | { type: 'shell_killed'; sessionId: string; shellId: string }
  | { type: 'user_message'; sessionId: string; message: Message; status: 'accepted' | 'queued' | 'processing'; optimisticMessageId?: string; /** F1.333 — a steer handed back to the queue: this 'queued' is NOT a late out-of-order echo */ requeued?: true }
  | { type: 'session_flagged'; sessionId: string }
  | { type: 'session_unflagged'; sessionId: string }
  | { type: 'session_archived'; sessionId: string }
  | { type: 'session_unarchived'; sessionId: string }
  | { type: 'name_changed'; sessionId: string; name?: string }
  | { type: 'session_model_changed'; sessionId: string; model: string | null }
  | { type: 'session_status_changed'; sessionId: string; sessionStatus: SessionStatus; statusSetByDecision?: { outcome: string; probability: number } }
  | { type: 'session_deleted'; sessionId: string }
  | { type: 'session_created'; sessionId: string }
  | { type: 'session_shared'; sessionId: string; sharedUrl: string }
  | { type: 'session_unshared'; sessionId: string }
  | { type: 'auth_request'; sessionId: string; message: Message; request: SharedAuthRequest }
  | { type: 'auth_completed'; sessionId: string; requestId: string; success: boolean; cancelled?: boolean; error?: string }
  | { type: 'source_activated'; sessionId: string; sourceSlug: string; originalMessage: string }
  | { type: 'usage_update'; sessionId: string; tokenUsage: { inputTokens?: number | null; contextWindow?: number | null; contextUsage?: ContextUsageSnapshot }; contextUsage?: ContextUsageSnapshot }
  | { type: 'queue_changed'; sessionId: string; queue: QueuedMessageDto[]; paused: boolean }
  /**
   * D1.269 — "this session's scheduled work moved; read it again".
   *
   * A SIGNAL and not a payload, deliberately: `sessions:listScheduledWork` is a
   * READ and the list is rebuilt from it, so a payload here would be a second
   * producer of the same fact and the two would drift. The renderer counts the
   * nudge per session and re-reads; the wire name is declared once on each side
   * (`renderer/lib/scheduled-work-refresh.ts` `SCHEDULED_WORK_CHANGED_EVENT`)
   * so the halves cannot spell it differently.
   *
   * Emitted by the two writers that can move the answer without moving the
   * background-task row count the list used to watch: the session's cron port
   * (create, remove, pause/resume, run-now, mark-read, wakeup rearm/stop) and
   * its monitor port (start, stop).
   */
  | { type: 'scheduled_work_changed'; sessionId: string }
  | { type: 'capabilities_changed'; sessionId: string; capabilities: ComposerCapabilities }
  | { type: 'message_annotations_updated'; sessionId: string; messageId: string; annotations: AnnotationV1[] }
  | { type: 'conversation_rewound'; sessionId: string; messageId: string; messages: Message[]; removedMessages: number; restoredCheckpoints?: number; fileCheckpointsTracked?: boolean; failedCheckpoints?: FileCheckpointRevertResult[]; skippedLinks?: number; skippedPaths?: readonly FileCheckpointSkippedPath[]; lastMessageAt?: number; lastMessageRole?: Session['lastMessageRole']; lastFinalMessageId?: string }
  | { type: 'working_directory_error'; sessionId: string; error: string }
  /**
   * A transcript row the SERVER composed and appended, outside any turn.
   *
   * Distinct from `info`, which carries a string the renderer turns into a
   * transient notice: this carries a whole `Message`, so the row can hold the
   * fields a notice cannot — `runtime`, `llmConnection`, an id stable enough to
   * branch from. The runtime-switch notice is the first producer; anything that
   * writes a row without a turn behind it belongs here rather than growing a
   * second string-shaped event.
   */
  | { type: 'message_added'; sessionId: string; message: Message }
  | ({ type: 'pi_harness_runtime_invalidated'; sessionId: string } & import('@nessy-agent/core/types').PiHarnessRuntimeEventV1)

export interface SendMessageOptions {
  skillSlugs?: string[]
  badges?: ContentBadge[]
  optimisticMessageId?: string
  /**
   * How this prompt reached the session. `'human'` means the person at the
   * client typed and sent it; a deep link, a relayed payload, an automation or
   * a headless caller must leave it unset.
   *
   * Only the workflow keyword trigger reads it, and it fails closed: an unset
   * origin never opts into workflow orchestration. `workflows.md` §Where the
   * keyword works makes this a boundary, not a preference — Claude records a
   * fixed defect where the keyword fired from webhook and PR-comment relays.
   */
  origin?: 'human'
  /**
   * R18 turn-level structured output: a JSON Schema (draft-07) the turn's
   * final assistant text must validate against. The validated value rides the
   * turn's `complete` event at `structuredOutput`. Absent = today's behavior.
   */
  outputSchema?: Record<string, unknown>
  /**
   * P6.480 — use the OTHER follow-up behaviour for THIS message, without
   * changing the connection's stored default.
   *
   * `learn.chatgpt.com/docs/prompting.md` describes the affordance beside the
   * setting: *"The setting also shows the shortcut for using the other behavior
   * for one message without changing your default"* (weak tier — a page, not
   * the codex source; it is intent, and the mechanism below is entirely ours).
   *
   * NO RUNTIME HAS THIS. codex does it with Enter-vs-Tab inside its own TUI,
   * which this renderer does not use, and neither Pi nor the Claude SDK exposes
   * a per-send hint — so native-first lands on step (2), the host, and
   * `SessionManager`'s mid-stream branch is the one seam all three share.
   *
   * Absent means "use the connection's resolved default", which is every
   * client that does not send it and every send that is not the chord.
   */
  midStreamOverride?: 'steer' | 'queue'
  /**
   * UB2.14 — when true, the message drives a turn (reaches the model) but is
   * marked `hidden` on the persisted `Message` so it never renders as a
   * transcript bubble (craft-agents-oss v0.15.1 `SendMessageOptions.hidden`,
   * Apache-2.0). The host's own source-activation auto-retry is the producer:
   * the user already sees their message and the activation. A hidden send is
   * not the user's: it labels nothing, never stands in for a deferred title's
   * next request, leaves the session-list role alone, never marks its turn
   * as begun by the user, runs no source suggestion, and is never steered
   * into a running turn (it queues).
   */
  hidden?: boolean
}

export type MemoryAppendScope = 'project' | 'user'

export interface MemoryAppendResult {
  success: boolean
  scope: MemoryAppendScope
  error?: string
}

/**
 * L9 — WHY A STOP DID NOT HAPPEN, as a code rather than as backend English.
 *
 * The first version of `SessionManager.stopAgentTask` returned prose, and the
 * prose was internal: `unknown-task-id:bg-9` and "Unknown supervised process
 * handle" reached the toast verbatim, in every locale. A stable code lets the
 * renderer own the sentence and the translators own the wording.
 *
 * - `session-not-found` — the session is gone from the manager.
 * - `unknown-task` — nothing running answers to this id (the id is stale; the
 *   row on screen is the leftover).
 * - `unreachable-mcp` — an auto-backgrounded MCP call whose only owner, the
 *   subprocess's background-task registry, could not be reached. It has no
 *   durable child record, so no other mechanism can stop it.
 * - `unreachable-workflow` — a background workflow whose DAG script could not be
 *   reached. Stopping only its current node's child would leave the script
 *   scheduling the next node, so this deliberately refuses rather than reporting
 *   a stop it cannot deliver.
 * - `unsupported` — this runtime has no mechanism for stopping a background task.
 * - `failed` — a mechanism owned the id and the stop went wrong; `error` carries
 *   the detail.
 */
export type StopAgentTaskFailureReason =
  | 'session-not-found'
  | 'unknown-task'
  | 'unreachable-mcp'
  | 'unreachable-workflow'
  | 'unsupported'
  | 'failed'

/**
 * The answer to one stop request. `success: true` is the caller's ONLY licence to
 * drop the row from the Background Tasks list.
 */
export interface StopAgentTaskResult {
  success: boolean
  /** Present exactly when `success` is false. */
  reason?: StopAgentTaskFailureReason
  /** Backend detail for logs and bug reports — never the whole user-facing text. */
  error?: string
}

/**
 * L9 — WHY A BACKGROUND TASK'S OUTPUT COULD NOT BE READ.
 *
 * Same shape and the same reason as `StopAgentTaskFailureReason`: a code the
 * renderer turns into a translated sentence, never backend prose to show verbatim.
 *
 * - `session-not-found` — the session is gone from the manager.
 * - `unknown-task` — no source in this session owns this id. The Pi supervisor
 *   does not hold the handle, the Claude CLI's live task level does not name it
 *   (UB9.8) and no completed-task record answers to it either. The honest answer
 *   for a foreign id, a stale id, and a Pi `mcp`/`workflow` agent task that is
 *   still running (its output does not exist anywhere until `task_completed`).
 *   UB9.8 — also a Claude task the level names whose launching call named no
 *   readable `…/tasks/<taskId>.output` (no readable output, upstream's `null`).
 * - `unavailable` — a source owns the id and cannot be read right now: a
 *   supervised process whose host owner is gone (`process-recovery-*`), so the
 *   record survives and the live log does not.
 * - `failed` — a source owned the id and the read itself went wrong; `error`
 *   carries the detail for the log.
 */
export type BackgroundTaskOutputFailureReason =
  | 'session-not-found'
  | 'unknown-task'
  | 'unavailable'
  | 'failed'

/**
 * The answer to one output read.
 *
 * `success: true` with an EMPTY `output` is a real and common answer — a command
 * that has printed nothing yet — and is deliberately distinct from every failure
 * above. An overlay must be able to say "running, nothing printed yet" without
 * claiming the command produced nothing.
 */
export interface BackgroundTaskOutputResult {
  success: boolean
  /**
   * The command the task is running, when the source knows it. `killShell`'s own
   * ownership map (`backgroundShellCommands`) is the source, so a shell row gets a
   * real header instead of the row's synthesised "shell task" label.
   */
  command?: string
  /** Everything from `cursor` onward. Empty string when nothing has been printed. */
  output?: string
  /**
   * The store's own byte offset to pass as the next `cursor`. Present only on the
   * live-process path; the completed-task record is read whole and has none.
   */
  nextCursor?: number
  /** True while the process is still running, so the output is a snapshot. */
  isRunning?: boolean
  /** Present once the process has ended and the record carries one. */
  exitCode?: number
  /** Present exactly when `success` is false. */
  reason?: BackgroundTaskOutputFailureReason
  /** Backend detail for logs and bug reports — never the whole user-facing text. */
  error?: string
  /**
   * UB9.8 — the digest upstream v0.15.1's task card reads, present when the read came from a Claude CLI task file
   * (`server-core` `sessions/background-task-output.ts`): a shell's tail (`text`) or an agent transcript's latest
   * message and recent steps (`agent`). `output` then carries the text for the existing overlay (the tail, or the
   * agent's latest message). Such a read takes no `cursor` and returns no `nextCursor`: the file's tail every time.
   */
  digest?: BackgroundTaskOutput
}

/**
 * UB9.8 — ported from craft-agents-oss `v0.15.1:packages/shared/src/protocol/dto.ts` (Apache-2.0): one tool call
 * of a background agent, for the task card's step list.
 */
export interface BackgroundTaskStep {
  /** Tool name as the agent called it (`Bash`, `Read`, `mcp__linear__list_issues`) */
  tool: string
  /** What the call worked on: a file name, command, pattern, URL or description */
  label?: string
}

/** UB9.8 (v0.15.1, Apache-2.0) — a background task's output, digested for the task chip's card. */
export type BackgroundTaskOutput =
  | { kind: 'text'; text: string; truncated: boolean }
  | {
      kind: 'agent'
      /** The agent's latest message: its progress note while it runs, its answer once done */
      message: string | null
      /** Its most recent tool calls, oldest first */
      steps: BackgroundTaskStep[]
      truncated: boolean
    }

export interface ShellCommandResult {
  success: boolean
  executed: boolean
  command: string
  cwd?: string
  exitCode?: number | null
  signal?: string | null
  output?: string
  stdout?: string
  stderr?: string
  messageId?: string
  blocked?: boolean
  error?: string
  truncated?: boolean
}

export interface ConversationRewindResult {
  success: boolean
  messageId: string
  messages?: Message[]
  removedMessages?: number
  restoredCheckpoints?: number
  failedCheckpoints?: FileCheckpointRevertResult[]
  /**
   * Tracked paths the rewind declined to touch for link safety, summed across
   * every checkpoint it walked. A partial rewind is only defensible when it says
   * so, and this is how it says so.
   */
  skippedLinks?: number
  skippedPaths?: readonly FileCheckpointSkippedPath[]
  /**
   * Whether this session's runtime creates file checkpoints AT ALL.
   *
   * Present only when `restoreFiles` was asked for, because it is only then that
   * the answer changes what the user should believe. `false` means no tool call
   * on this runtime has ever been checkpointed, so `restoredCheckpoints: 0` is
   * not "nothing needed restoring" — it is "nothing could be". Without this the
   * two are indistinguishable at every surface, and the rewind reported success
   * for an operation that did nothing (`RUNTIME_FILE_CHECKPOINT_PRODUCERS`).
   *
   * It is about the runtime the session is on NOW, not about each checkpoint:
   * a session switched from Pi to Claude still holds its Pi-era checkpoints and
   * really does restore them, while its Claude-era edits were never tracked. Both
   * halves are true at once, so a surface must report the count AND this flag.
   */
  fileCheckpointsTracked?: boolean
  error?: string
}

export type SessionTranscriptExportFormat = 'markdown' | 'json'

export interface SessionTranscriptExportResult {
  success: boolean
  format: SessionTranscriptExportFormat
  content?: string
  defaultFilename?: string
  error?: string
}

// ---------------------------------------------------------------------------
// Session commands (consolidated operations)
// ---------------------------------------------------------------------------

export type SessionCommand = SetKanbanColumnCommand | SetProjectIdCommand
  | { type: 'flag' }
  | { type: 'unflag' }
  | { type: 'archive' }
  | { type: 'unarchive' }
  | { type: 'rename'; name: string }
  | { type: 'setSessionStatus'; state: SessionStatus }
  | { type: 'markRead' }
  | { type: 'markUnread' }
  | { type: 'setActiveViewing'; workspaceId: string }
  | { type: 'setPermissionMode'; mode: PermissionMode }
  | { type: 'setThinkingLevel'; level: ThinkingLevel }
  /**
   * QK5 — the session's ultracode toggle.
   *
   * Its own command rather than a field on `setThinkingLevel`, because
   * `model-config.md#adjust-effort-level` is explicit that *"Ultracode is a
   * Claude Code setting rather than a model effort level"*: folding it into the
   * level would make it a seventh member of an enum three recorded decisions in
   * this fork say it is not.
   *
   * PER SESSION and not persisted as a default, matching the SDK's own scope
   * (`sdk.d.ts` at `0.3.247`: *"Session-scoped … interactive toggles never
   * persist it"*), so a restart starts the session with it off exactly as the
   * vendor's unset default does.
   */
  | { type: 'setUltracode'; enabled: boolean }
  | { type: 'updateWorkingDirectory'; dir: string }
  | { type: 'setSources'; sourceSlugs: string[] }
  | { type: 'setLabels'; labels: string[] }
  | { type: 'shareToViewer' }
  | { type: 'updateShare' }
  | { type: 'revokeShare' }
  | { type: 'revertFileCheckpoint'; checkpointId?: string }
  | { type: 'refreshTitle' }
  | { type: 'setConnection'; connectionSlug: string }
  /**
   * Move a live session onto a different connection, including one whose
   * runtime differs. `setConnection` above now delegates to the same
   * operation; this member exists so a caller can read the
   * `RuntimeSwitchResult` — what tier the switch was, and whether any context
   * crossed — which the void-returning legacy command cannot report.
   */
  | { type: 'switchRuntime'; connectionSlug: string }
  /**
   * READ-ONLY. What a `switchRuntime` to this connection would carry, asked
   * BEFORE the confirmation modal opens so the modal can say it. Loads the
   * transcript and runs the carry planner; changes nothing, refuses nothing.
   * P3 of `docs/superpowers/plans/2026-08-20-cross-runtime-history-carry.md`.
   */
  | { type: 'previewRuntimeSwitch'; connectionSlug: string }
  | { type: 'setPendingPlanExecution'; planHandleId: string; draftInputSnapshot?: string }
  | { type: 'markCompactionComplete' }
  | { type: 'markPendingPlanExecutionDispatched' }
  | { type: 'clearPendingPlanExecution' }
  | { type: 'addAnnotation'; messageId: string; annotation: AnnotationV1 }
  | { type: 'removeAnnotation'; messageId: string; annotationId: string }
  | { type: 'updateAnnotation'; messageId: string; annotationId: string; patch: Partial<AnnotationV1> }
  | { type: 'appendMemory'; scope: MemoryAppendScope; text: string }
  | { type: 'runShellCommand'; command: string }
  | { type: 'rewindToMessage'; messageId: string; restoreFiles?: boolean }
  // P6.103 — the PRE-click half of the rewind menu: which anchors a
  // file-restoring rewind would actually revert something for. Read-only, and
  // deliberately its own command rather than a field on the session: the answer
  // is a directory read, and the session projection is on hot paths.
  | { type: 'rewindTrackedChanges' }
  | { type: 'exportTranscript'; format?: SessionTranscriptExportFormat }
  /**
   * P6.278 — the working-tree patch, for the DIFF VIEWER rather than the
   * summary `/diff` prints at the seam.
   *
   * READ-ONLY, and deliberately a session command rather than a new IPC
   * channel: the answer is `git` run in the session's own directory, which is
   * the same "answered by the server that owns the session" property every
   * other member of this union has, and the channel it needs already exists.
   * A new channel would have meant four wire files and an inventory
   * regeneration for a read this one already routes.
   */
  | { type: 'workingTreeDiff' }
  | { type: 'refreshContextUsage' }
  // `/btw` (interactive-mode.md:359-374) — answered out-of-band; NEVER rides
  // sendMessage, never persists, never emits transcript events.
  | { type: 'sideQuestion'; question: string }
  // `/recap` (interactive-mode.md:398-404) — one-line on-demand summary; same
  // non-persisting contract as sideQuestion.
  | { type: 'recap' }
  // `/heapdump` (troubleshooting.md:39) — write a heap snapshot + memory
  // breakdown to ~/Desktop (home fallback) and persist ONE summary message.
  // Never a model turn; deliberately NOT gated on isProcessing (a dump must
  // work on a wedged session).
  | { type: 'heapdump' }
  /**
   * P6.793 — move the tool call this turn is BLOCKED on into the background,
   * and let the turn continue.
   *
   * The trigger for the SDK's own `Query.backgroundTasks(toolUseId?)`, which
   * the host had never called: *"Background in-flight foreground tasks (Bash
   * commands and subagents). … Each blocking tool call returns immediately with
   * a 'running in the background' tool_result and the turn continues; the task
   * keeps running and emits a task_notification when it settles."*
   * (`sdk.d.ts`, the `Query` interface).
   *
   * A session command rather than a new IPC channel, for the reason
   * `workingTreeDiff` above gives: the answer is a control request to the
   * session's own child, which is the property every member of this union has,
   * and the channel it needs already exists.
   *
   * `toolUseId` targets ONE blocking call; without it every foreground task is
   * backgrounded — the SDK's own two modes, not an invention here. The default
   * direction of `/code-review` is NOT changed by this member: it stays
   * foreground until the owner decides (P6.798); this is the lever a person
   * pulls.
   */
  | { type: 'backgroundInFlightTasks'; toolUseId?: string }

/**
 * P6.793 — WHY AN IN-FLIGHT TOOL CALL COULD NOT BE BACKGROUNDED.
 *
 * A code the renderer turns into a translated sentence, never backend prose to
 * show verbatim — the same contract `StopAgentTaskFailureReason` states, and
 * for the same reason.
 *
 * - `session-not-found` — the session is gone from the manager.
 * - `unsupported` — this runtime has no lever at all. The NAMED refusal this
 *   row exists to produce on codex, where the alternative is a press that looks
 *   accepted and does nothing.
 * - `nothing-running` — the runtime has the lever and nothing was blocking:
 *   either no foreground task at all, or a `toolUseId` that matched none. The
 *   SDK returns `false` for exactly the second case.
 * - `failed` — the lever ran and went wrong; `error` carries the detail for the
 *   log.
 */
export type BackgroundInFlightTasksFailureReason =
  | 'session-not-found'
  | 'unsupported'
  | 'nothing-running'
  | 'failed'

/** P6.793 — result of the `backgroundInFlightTasks` session command. */
export interface BackgroundInFlightTasksResult {
  backgrounded: boolean
  /** Present exactly when `backgrounded` is false. */
  reason?: BackgroundInFlightTasksFailureReason
  /** Backend detail for logs and bug reports — never the whole user-facing text. */
  error?: string
}

/**
 * P6.278 — result of the `workingTreeDiff` session command.
 *
 * Three states, and they are three because collapsing them is how a viewer
 * shows a clean tree and a broken read as the same blank screen:
 * `success: false` (git could not answer — not a repository, git missing, no
 * working directory), `success: true` with an EMPTY `files` (a clean tree), and
 * `success: true` with rows.
 *
 * One patch per file, already cut by `splitUnifiedDiffByFile`, because the cut
 * is a parse of git's output and this product keeps exactly one parser of that
 * format (`slash-commands/diff-command.ts`) — the seam's summary and the
 * viewer's rows are read from the same bytes by the same code.
 */
export interface WorkingTreeDiffResult {
  success: boolean
  /** One entry per changed file; empty means a clean tree. */
  files: Array<{ path: string; unifiedDiff: string }>
  error?: string
}

/**
 * P6.103 — result of the `rewindTrackedChanges` session command.
 *
 * `checkpointing.md#rewind-and-summarize`, verbatim: *"The two code restore
 * options appear only when the selected checkpoint has tracked file changes to
 * revert. If no file edits were captured after that point, the menu offers only
 * **Restore conversation**, the summarize options, and **Never mind**."*
 *
 * `messageIds` is the set of anchors for which a `restoreFiles` rewind would
 * revert at least one checkpoint — computed with the SAME predicate the rewind
 * walk uses (an un-reverted checkpoint created strictly after the anchor's
 * timestamp, over the session's own directory and its forks'), so the
 * affordance is hidden exactly when the walk would find nothing.
 *
 * PER ANCHOR, never per runtime: a session that ran on Pi and later switched
 * still has real revertable checkpoints, and a rewind reverts them whatever
 * runtime is current. Nothing here reads the provider.
 *
 * A `success: false` means the answer could not be computed, and the caller
 * must FAIL OPEN — keep offering the action. Hiding a working button on a
 * failed read would be the one outcome worse than showing an inert one.
 */
export interface RewindTrackedChangesResult {
  success: boolean
  messageIds?: string[]
  error?: string
}

/**
 * Result of the `sideQuestion` session command (`/btw`). Errors are typed into
 * the result (`success: false` + a stable code) rather than thrown; the panel
 * renders a SENTENCE per code and never the code itself (D1.398). The codes are
 * {@link SideQuestionErrorCode} below — F1.95 / D1.408 replaced the enumeration
 * that used to stand here, because a list in prose beside a type ages silently.
 * `error` carries one of those codes, or a provider message, which is already a
 * sentence and is shown as a detail under the generic one.
 */
export interface SideQuestionResult {
  success: boolean
  /** The answer, present when `success` is true. */
  text?: string
  error?: string
}

/**
 * F1.95 / D1.408 — every failure the product NAMES for `/btw` and `/recap`,
 * declared once.
 *
 * It is what makes "a code without a sentence" a TYPE error rather than a
 * census finding: the renderer maps it with a total
 * `Record<SideQuestionErrorCode, string>` (`side-question-errors.ts`), so a new
 * member with no sentence fails `typecheck:electron`, and both server methods
 * return their coded literals `satisfies SideQuestionCodedFailure`, so a typo
 * or an unlisted code fails `typecheck:server-core`. Before this the only
 * guard was a renderer test reading `SessionManager.ts`'s source across a
 * package boundary.
 *
 * `unknown-error` is the RENDERER's own: `FreeFormInput` mints it when a result
 * comes back unsuccessful with no `error` at all. No server method returns it,
 * and it is a member here so the sentence map stays one list.
 *
 * NOT a closed set for the WIRE: the catch arms of both methods return the
 * provider's own message, so `error` stays a `string` and the panel falls back
 * to a generic sentence with that text kept beside it.
 */
export type SideQuestionErrorCode =
  | 'session-not-found'
  | 'empty-question'
  | 'empty-answer'
  | 'agent-start-failed'
  | 'empty-session'
  | 'recap-unavailable'
  | 'unknown-error'

/**
 * The shape a coded failure has. Both server methods stamp their literal
 * returns with `satisfies` this, so the union above is the only place a new
 * code can be introduced.
 */
export type SideQuestionCodedFailure = { success: false, error: SideQuestionErrorCode }

/**
 * Result of the `recap` session command (`/recap`): a ONE-LINE summary of the
 * session so far (interactive-mode.md:400). Same typed-error posture as
 * {@link SideQuestionResult}; codes today: `session-not-found`,
 * `agent-start-failed`, `empty-session`, `recap-unavailable`.
 */
export interface SessionRecapResult {
  success: boolean
  /** The one-line recap, present when `success` is true. */
  text?: string
  error?: string
}

/**
 * Result of the `heapdump` session command (`/heapdump`,
 * troubleshooting.md:39). Mirrors the HOST process's dump row; the Pi
 * subprocess's row (and any error rows) surface in the persisted summary
 * message, not here. Same typed-error posture as {@link SideQuestionResult};
 * codes today: `session-not-found`, or the host writer's error text.
 */
export interface SessionHeapdumpResult {
  success: boolean
  /** Which directory rule matched: the Desktop folder, or the home fallback. */
  wroteTo?: 'desktop' | 'home'
  snapshotPath?: string
  diagnosticsPath?: string
  error?: string
}

export interface NewChatActionParams {
  input?: string
  name?: string
}

// ---------------------------------------------------------------------------
// Permission / credential types
// ---------------------------------------------------------------------------

export type { BasePermissionRequest }

/**
 * Permission request with session context (for multi-session Electron app)
 */
export interface PermissionRequest extends BasePermissionRequest {
  sessionId: string
}

export interface PermissionResponseOptions {
  rememberForMinutes?: number
  askUserAnswer?: AskUserAnswer
  updatedInput?: Record<string, unknown>
  /**
   * P6.951 — a note the user attached to THIS answer, which the agent is told.
   *
   * `permissions.md#add-a-comment-when-you-answer-a-permission-prompt`, verbatim:
   * *"**No**: Claude Code sends your comment to Claude as the reason for the
   * denial, and Claude continues working."* Only the DENY half is wired: the
   * page's Yes half — *"runs the action, then sends your comment to Claude after
   * the result"* — has no channel on any runtime (the SDK's `PermissionResult`
   * allow branch carries no feedback field), so it is a host injection and stays
   * on P6.864.
   *
   * The same page rules the note OUT of the remembering answers: *"The options
   * that allow the action for the rest of the session or save a rule don't take
   * one either."* Nothing here enforces that — the card is where the affordance
   * is offered, and it offers it on Deny alone.
   *
   * Never persisted and never a rule: it is one sentence about one refusal.
   */
  comment?: string
}

// Re-export for handler convenience
export type { SharedCredentialInputMode as CredentialInputMode }
export type CredentialRequest = SharedCredentialAuthRequest
export type { SharedAuthRequest as AuthRequest }

export interface CredentialResponse {
  type: 'credential'
  value?: string
  username?: string
  password?: string
  headers?: Record<string, string>
  cancelled: boolean
}

// ---------------------------------------------------------------------------
// Directory browsing types (remote mode)
// ---------------------------------------------------------------------------

/** Server-side directory listing result (for remote directory browsing). */
export interface DirectoryListingResult {
  /** Normalized absolute path of the listed directory (after resolve(), not symlink-resolved). */
  currentPath: string
  /** Parent directory path, or null if at root. */
  parentPath: string | null
  /** Pre-split breadcrumb segments for display (computed server-side). */
  breadcrumbs: Array<{ name: string; path: string }>
  /** Server platform info. */
  platform: 'win32' | 'darwin' | 'linux'
  /** Whether the server truncated the directory list for safety/performance. */
  truncated: boolean
  /** Total number of matching child directories before truncation. */
  totalEntries: number
  /** Child directory entries. */
  entries: Array<{ name: string; path: string; isSymlink: boolean }>
}

// ---------------------------------------------------------------------------
// File types
// ---------------------------------------------------------------------------

export interface FileAttachment {
  type: 'image' | 'text' | 'pdf' | 'office' | 'audio' | 'unknown'
  path: string
  name: string
  mimeType: string
  base64?: string
  text?: string
  size: number
  thumbnailBase64?: string
  origin?: 'pasted-text'
}

export interface SessionFile {
  name: string
  path: string
  type: 'file' | 'directory'
  size?: number
  children?: SessionFile[]
}

export interface FileSearchResult {
  name: string
  path: string
  type: 'file' | 'directory'
  relativePath: string
}

// ---------------------------------------------------------------------------
// LLM connection types
// ---------------------------------------------------------------------------

/**
 * Resolved Anthropic OAuth identity (issue #838), captured from the
 * token-exchange response. Shape mirrors `ClaudeOAuthIdentity` in
 * `auth/claude-oauth.ts`; kept in the protocol layer so DTOs stay decoupled
 * from the auth module. All fields optional and fail-soft.
 */
export interface ClaudeOAuthIdentityDto {
  account?: { uuid?: string; emailAddress?: string }
  organization?: { uuid?: string; name?: string }
}

export interface LlmConnectionSetup {
  slug: string
  credential?: string
  baseUrl?: string | null
  defaultModel?: string | null
  models?: Array<ModelDefinition | string> | null
  /**
   * The utility-model slot (E1). Validated against the POST-MERGE effective
   * model list, not `models` alone: an edit payload may carry `miniModel`
   * without `models`, and checking it against an absent list would reject
   * every such edit.
   */
  miniModel?: string
  piAuthProvider?: string
  modelSelectionMode?: 'automaticallySyncedFromProvider' | 'userDefined3Tier'
  /**
   * Enrollment marker for the daily metadata refresh (C2): a number stamps the
   * connection in, `null` clears it. Omitted = leave whatever is persisted.
   */
  modelsSyncedAt?: number | null
  /** When true, reject setup if the connection doesn't already exist (reauth guard). */
  updateOnly?: boolean
  /** Custom endpoint protocol for arbitrary OpenAI/Anthropic-compatible APIs */
  customEndpoint?: CustomEndpointConfig
  /**
   * Explicit auth type, honored ONLY for the adapter-runtime provider types
   * (`codex-runtime` / `claude-runtime`) — see `resolveAdapterRuntimeAuthType`.
   *
   * Those connections never carry a `customEndpoint` (it would rewrite them to
   * `pi_compat`), so they never reach `resolveCustomEndpointSetup`, the one
   * place that maps loopback-plus-no-credential onto `authType: 'none'`. The
   * BYO endpoint form (C3) makes that call itself and sends it here; without it
   * a keyless local endpoint persists as `api_key_with_endpoint` with no stored
   * key, which reads as "credentials missing" to both the settings Test button
   * and the credential-health check.
   */
  authType?: 'none' | 'api_key_with_endpoint'
  /** IAM credentials for Pi+Bedrock (piAuthProvider='amazon-bedrock') connections */
  iamCredentials?: {
    accessKeyId: string
    secretAccessKey: string
    sessionToken?: string
  }
  /** AWS region for Pi+Bedrock connections */
  awsRegion?: string
  /** Bedrock authentication method — determines auth type for Pi+Bedrock connections */
  bedrockAuthMethod?: 'iam_credentials' | 'environment'
  /**
   * Resolved Anthropic OAuth identity (issue #838), threaded through setup so it
   * persists for both new and re-auth connections. Optional and fail-soft.
   */
  oauthIdentity?: ClaudeOAuthIdentityDto
}

export interface TestLlmConnectionParams {
  /**
   * Legacy backend discriminator. Ignored when `runtimeProviderType` is set —
   * that field names the providerType outright, and the driver is resolved from
   * it (this union cannot spell `codex-runtime`).
   */
  provider: 'anthropic' | 'pi'
  apiKey: string
  baseUrl?: string
  model?: string
  piAuthProvider?: string
  /** Optional custom endpoint protocol hint so setup tests mirror runtime routing */
  customEndpoint?: CustomEndpointConfig
  /**
   * BYO endpoint form (C3): the connection being tested runs through a local
   * adapter, so the setup test must reach that runtime's driver rather than be
   * classified as a `pi_compat` custom endpoint. Without it,
   * `anthropicDriver.testConnection`'s `claude-runtime` branch is unreachable
   * and the codex driver cannot be selected at all.
   */
  runtimeProviderType?: 'codex-runtime' | 'claude-runtime'
  /**
   * Ask for the endpoint's model catalog instead of running the agent-subprocess
   * connection test. Answered directly by the OpenAI-compatible fetcher — the
   * 45s test is the wrong vehicle for a list.
   */
  fetchModels?: boolean
  /**
   * Probe these model ids for entitlement. The catalog is a directory, not an
   * entitlement list, so a published id can still answer "quota not found";
   * only ids the user actually selected are probed.
   */
  validateModels?: string[]
  /**
   * Resolve the credential SERVER-SIDE from this connection's stored key,
   * for `fetchModels` / `validateModels` only.
   *
   * The edit form never holds a usable key: `GET_API_KEY` masks for every
   * caller, and the mask is not a credential — sending it crashes header
   * encoding (U+2022 is not a ByteString character). Without this the edit
   * path could only read a catalog by making the user retype a key they had
   * already given us. The mask still never crosses the wire; the slug does.
   *
   * An explicit `apiKey` wins — that is the create path, where nothing is
   * stored yet.
   */
  slug?: string
}

/**
 * Per-model verdict from a `validateModels` probe. FOUR classes, because three
 * of them mean different things to the user and the fourth is our own failure:
 *
 * - `ok` — the key reached the model over this wire.
 * - `no-quota` — published, but this key is not entitled (llm-proxy: 404
 *   `quota not found`).
 * - `unsupported-endpoint` — the model exists and the key may well reach it,
 *   but NOT on this protocol (llm-proxy: 400 `unsupported endpoint` for every
 *   `anthropic/*` id on chat-completions; they answer on `/v1/messages`).
 *   Measured 2026-08-14. Folding this into `no-quota` told 11 entitled Claude
 *   models they were unavailable.
 * - `error` — the probe itself failed and says nothing about the model.
 */
export interface ModelProbeResult {
  id: string
  verdict: 'ok' | 'no-quota' | 'unsupported-endpoint' | 'error'
  /**
   * The wire the model actually answered on, when it was not chat-completions
   * (G3). Set only by a REAL second request to `/v1/messages` — never inferred
   * from a chat-completions refusal, because `gemini/*` refuses there too and
   * speaks its own Google protocol, not Anthropic's.
   *
   * Persisted onto the connection's model entry, and read per request by the
   * Claude runtime's loopback adapter to decide passthrough vs translation.
   */
  wire?: 'anthropic-messages'
}

export interface TestLlmConnectionResult {
  success: boolean
  error?: string
  /** Present when `fetchModels` was requested: what the endpoint PUBLISHES. */
  models?: ModelDefinition[]
  /** Present when `validateModels` was requested, one entry per requested id. */
  modelProbes?: ModelProbeResult[]
}

// ---------------------------------------------------------------------------
// Source / skill types
// ---------------------------------------------------------------------------

export interface OAuthResult {
  success: boolean
  error?: string
}

export type DpAuthResult =
  | { ok: true }
  | { ok: false; code: DpAuthError }

export interface DpAuthRequestArgs {
  sessionId: string
  requestId: string
}

export interface DpAuthStatusEvent {
  requestId: string
  status: DpSessionStatus
}

/**
 * Value-only result of a non-interactive dp session probe (T3, plugin-install
 * plan). Never carries a token, a version string, or an error detail — the
 * renderer only needs to know whether the system sign-in took.
 */
export interface DpSessionProbeResult {
  state: 'ready' | 'needs-login' | 'unavailable'
}

/**
 * Everything in a workspace still awaiting authentication (T4, plugin-install
 * plan § 5) — the session-start notice's data. Value-free: slugs, display
 * names, wire names and reason codes only; never a token, header or path.
 */
export interface SafeWorkspacePendingAuth {
  /** Present only when dp-backed servers exist and dp is not ready. */
  dp?: {
    state: 'needs-login' | 'unavailable'
    /** One dp sign-in unblocks all of these (wire names). */
    serverNames: string[]
  }
  /**
   * True when the resolved dp binary reports a version below DP_MIN_VERSION.
   * Rendered as an update hint next to failedServers: an outdated dp lacks
   * `dp ai mcp`, so every builtin dp server fails connect regardless of login.
   */
  dpOutdated?: boolean
  /** Sources/servers awaiting a credential, one row each. */
  sources: Array<{
    workspaceId: string
    sourceSlug: string
    name: string
    reason: 'needs-auth' | 'credential-missing' | 'credential-expired'
    /** True when the one-click `performOAuth` flow applies to this row. */
    canSignIn: boolean
    /**
     * C6 (capability-path): plugin-server sign-in target. Present when the row
     * is a plugin-owned MCP server whose GLOBAL credential slot is empty; the
     * one-click flow passes it through `performOAuth`.
     */
    pluginServer?: { pluginKey: string; serverName: string }
  }>
  /**
   * P6.256 — credentials that still WORK and are about to stop, oldest deadline
   * first.
   *
   * Every other field here reports something already broken; this is the only
   * one that fires while the session is fine, which is the row: at HEAD the
   * earliest a user could learn a credential was about to die was the turn it
   * died on, on all three runtimes. Present only when at least one credential is
   * inside the threshold, so the ordinary machine carries nothing.
   *
   * `daysLeft` is at least 1 — a credential dying in four hours reads as "1
   * day", never "0 days", which would read as already gone. A RENEWABLE
   * credential is deliberately absent: an hourly OAuth token renews itself, and
   * warning about it would train every user to ignore this notice.
   */
  expiringSoon?: Array<{
    workspaceId?: string
    sourceSlug: string
    name: string
    daysLeft: number
  }>
  /** Servers whose last connect attempt failed (broken at session start). */
  failedServers: string[]
}

export interface McpValidationResult {
  success: boolean
  error?: string
  tools?: string[]
}

// ---------------------------------------------------------------------------
// Search types
// ---------------------------------------------------------------------------

export interface SessionSearchMatch {
  sessionId: string
  lineNumber: number
  snippet: string
}

export interface SessionSearchResult {
  sessionId: string
  matchCount: number
  matches: SessionSearchMatch[]
}

// ---------------------------------------------------------------------------
// Session result types
// ---------------------------------------------------------------------------

export interface UnreadSummary {
  totalUnreadSessions: number
  byWorkspace: Record<string, number>
  hasUnreadByWorkspace: Record<string, boolean>
}

export interface ShareResult {
  success: boolean
  url?: string
  error?: string
  /** UA1.25 — share / update: when the link stops working (ISO), or `null` for never. */
  expiresAt?: string | null
  /** UA1.25 — the person declined the card (nothing was sent): not an error to toast. */
  declined?: boolean
  /** UA1.25 — stop sharing: the DELETE failed for a reason a retry can fix, so it is kept as a pending deletion. */
  deletionPending?: boolean
  /** UA1.25 — the sentence that goes with `deletionPending`. */
  message?: string
}

export interface RefreshTitleResult {
  success: boolean
  title?: string
  error?: string
}

/**
 * Why a rewind refused to touch a tracked path. Mirrors
 * `FileCheckpointSkipReason` in `sessions/file-checkpoints.ts`; the wire copy
 * exists so the renderer can name the reason without importing the session
 * store.
 */
export type FileCheckpointSkipReason =
  | 'symlink'
  | 'hard-link'
  | 'not-a-regular-file'
  | 'parent-directory-missing'
  | 'parent-directory-moved'
  | 'snapshot-unreadable'

export interface FileCheckpointSkippedPath {
  filePath: string
  reason: FileCheckpointSkipReason
}

export interface FileCheckpointRevertResult {
  success: boolean
  checkpointId?: string
  filePath?: string
  restored?: boolean
  deleted?: boolean
  error?: string
  /** Tracked paths this rewind refused to restore or delete for link safety. */
  skippedLinks?: number
  skippedPaths?: readonly FileCheckpointSkippedPath[]
  /**
   * Whether this session's runtime creates file checkpoints at all.
   *
   * Set only on the "no checkpoint found" refusal, where the distinction is the
   * whole message: on Pi or the Nestor cloud agent an empty manifest means the
   * agent has not edited a file yet, and on Claude or Codex it means edits are
   * not tracked and this action can never do anything. Both used to arrive as
   * the same bare "No file checkpoint found".
   */
  fileCheckpointsTracked?: boolean
}

// ---------------------------------------------------------------------------
// Plan types
// ---------------------------------------------------------------------------

export interface PlanStep {
  id: string
  description: string
  tools?: string[]
  status?: 'pending' | 'in_progress' | 'completed' | 'failed' | 'skipped'
}

export interface Plan {
  id: string
  title: string
  summary?: string
  steps: PlanStep[]
  questions?: string[]
  state?: 'creating' | 'refining' | 'ready' | 'executing' | 'completed' | 'cancelled'
  createdAt?: number
  updatedAt?: number
}

// ---------------------------------------------------------------------------
// System types
// ---------------------------------------------------------------------------

export interface GitBashStatus {
  found: boolean
  path: string | null
  platform: 'win32' | 'darwin' | 'linux'
}

export interface UpdateInfo {
  available: boolean
  currentVersion: string
  latestVersion: string | null
  downloadState: 'idle' | 'downloading' | 'ready' | 'installing' | 'error'
  downloadProgress: number
  error?: string
  /**
   * Set when a managed policy has disabled in-app updates
   * (`config/managed-in-app-updates.ts`). Absent otherwise, so an unmanaged
   * install's payload is byte-identical to what it was before P2.10.
   *
   * This rides the update payload rather than a channel of its own because the
   * settings page already reads this object every time it asks about updates,
   * and the refusal and the reason for it must arrive together — a page that
   * learns "not available" without learning "forbidden" shows an up-to-date app.
   */
  managedDisabled?: boolean
  /**
   * P3.240 — WHICH managed tier turned updates off, present only alongside
   * `managedDisabled: true`.
   *
   * Two documents can set this policy and they are remediated by two different
   * people: `'host'` is the composed `managed-policy.json`, `'codex'` is a
   * deployed `requirements.toml` read over `configRequirements/read`, `'both'`
   * is both. Rides the same payload as `managedDisabled` for the reason that
   * field gives — the refusal and the reason for it must arrive together — and
   * stays absent on an unmanaged install so its payload is unchanged.
   *
   * Spelled here rather than imported from `config/managed-in-app-updates.ts`:
   * this module is the wire contract and carries no imports from the modules it
   * describes. `ManagedInAppUpdatesSourceV1` is the same three strings and the
   * two are pinned against each other by test.
   */
  managedSource?: 'host' | 'codex' | 'both'
}

// ---------------------------------------------------------------------------
// Workspace types
// ---------------------------------------------------------------------------

export interface WorkspaceSettings {
  name?: string
  model?: string
  /**
   * The workspace's OWN configured mode — `config.defaults.permissionMode` —
   * and absent when the workspace has never set one, which is most of them.
   * A reader that wants to show what a new session in this workspace will
   * actually do must fall back to {@link effectiveDefaultPermissionMode}, not
   * to a mode of its own choosing (P4.8).
   */
  permissionMode?: PermissionMode
  /**
   * READ-ONLY, and the only field here the workspace does not own: the mode a
   * new session gets when `permissionMode` above is absent — the tail of
   * `createSession`'s own chain, `globalDefaults.workspaceDefaults.permissionMode`.
   *
   * It exists because Workspace Settings → Permissions hardcoded `'default'`
   * for an unconfigured workspace and therefore displayed **Manual** while
   * sessions started in **Auto** (P0.2 flipped the shipped default on
   * 2026-08-14; `config-defaults.json` and `loadConfigDefaults`'s in-code copy
   * both say `auto`). The label understated the autonomy the user was actually
   * granting, which is the direction that matters.
   *
   * NOT the whole chain, and the omission is deliberate rather than
   * unnoticed: a managed policy's `defaultMode` outranks the workspace value
   * entirely (`SessionManager.ts` — `this.managedPiPolicy.defaultMode ??
   * wsConfig?.defaults?.permissionMode ?? globalDefaults…`), so on an install
   * that sets it this control writes a value no session reads. That is a
   * bigger, product-shaped defect than the one this field closes — the control
   * should probably say so — and it is not this field's job to hide it. The
   * managed tier is also not reachable from this handler: it is a live private
   * field on `SessionManager`, refreshed on policy change.
   *
   * `SETTINGS_UPDATE`'s `validKeys` does not list this name, so a write is
   * refused by the handler rather than silently accepted.
   */
  effectiveDefaultPermissionMode?: PermissionMode
  /**
   * READ-ONLY, and the tier that outranks every other one on this object: the
   * managed policy's `defaultMode`, present ONLY when an administrator's policy
   * sets one (P2.489).
   *
   * The field above closes the tail of `createSession`'s chain; this one closes
   * its HEAD — `this.managedPiPolicy.defaultMode ??
   * wsConfig?.defaults?.permissionMode ?? globalDefaults…`. Without it the
   * workspace default-mode control on a managed install writes a value no
   * session will ever read, with no indication, which is the defect its
   * neighbour's docblock names and declines to hide.
   *
   * ABSENT means UNMANAGED, not unknown, and the renderer reads it that way on
   * purpose: it is missing from every unmanaged install's payload and from any
   * host older than this field, so treating absence as managed would disable a
   * working control for everyone. The consumer is
   * `resolveWorkspaceDefaultModeDisplay`, which disables the control and
   * annotates it — it does NOT re-rank the tiers, because the managed tier
   * outranking a user setting is correct and deliberate.
   *
   * Like its neighbour it is not in `SETTINGS_UPDATE`'s `validKeys`, so a write
   * is refused by the handler rather than silently accepted.
   */
  managedDefaultPermissionMode?: PermissionMode
  /**
   * READ-ONLY, and the only pair here that no tier of this product can set:
   * the two budget ceilings a session is actually stopped at (P6.821).
   *
   * `maxBudgetTokens` is the ceiling `resolveMaxBudgetTokens()` computes and
   * `BaseAgent` compares a session's own turns against; `maxBudgetUsd` is the
   * one `resolveMaxBudgetUsd()` computes and `SessionManager`'s
   * `maxBudgetUsdReached` latch rests on. Both are `workspaceDefaults` fields of
   * `config-defaults.json`, which `syncConfigDefaults` rewrites from the bundle
   * on every launch — so they belong to whoever administers the installation,
   * and there is no app control that could change them.
   *
   * WHY THE WIRE CARRIES THEM AT ALL. Two notices told the user to "set a token
   * limit (`maxBudgetTokens`)" and `maxBudgetUsdReached` rested on "ask the user
   * to raise the limit" being followable; neither was. The row's answer is to
   * DISCLOSE rather than to invent a user-settable ceiling: the page says what
   * the ceilings are and whose they are, and the notices point at that instead
   * of asking for something impossible.
   *
   * `0` MEANS NO CEILING, on both, verbatim from the resolvers — the same value
   * `config-defaults-schema.ts` documents ("0 disables the guard") and the same
   * one an absent or non-positive field reads as. It is deliberately NOT
   * translated to `null` here: a wire that re-spelled the rule would be a third
   * copy of it, and the whole point of routing through the resolvers is that
   * there is one.
   *
   * ABSENT means a host older than this field, not "no ceiling" — a renderer
   * must not read `undefined` as `0`, because the two are different claims:
   * *this build cannot tell you* against *there is no limit*.
   *
   * Like its two neighbours above it is missing from `SETTINGS_UPDATE`'s
   * `validKeys`, so a write is refused by the handler rather than taken.
   */
  budgetCeilings?: {
    maxBudgetTokens: number
    maxBudgetUsd: number
  }
  cyclablePermissionModes?: PermissionMode[]
  thinkingLevel?: ThinkingLevel
  workingDirectory?: string
  localMcpEnabled?: boolean
  defaultLlmConnection?: string
  enabledSourceSlugs?: string[]
}

// ---------------------------------------------------------------------------
// Auth result types
// ---------------------------------------------------------------------------

export interface ClaudeOAuthResult {
  success: boolean
  token?: string
  error?: string
  /**
   * Resolved Anthropic identity (issue #838), forwarded to the renderer so it
   * can thread it into the SETUP payload (which is what persists it). Present
   * only when the token-exchange response carried identity.
   */
  identity?: ClaudeOAuthIdentityDto
}

// ---------------------------------------------------------------------------
// Automation types
// ---------------------------------------------------------------------------

export type TestAutomationAction =
  | { type: 'prompt'; prompt: string; llmConnection?: string; model?: string; thinkingLevel?: ThinkingLevel; ephemeral?: boolean }
  | { type: 'webhook'; url: string; method?: string; headers?: Record<string, string>; bodyFormat?: 'json' | 'form' | 'raw'; body?: unknown; captureResponse?: boolean; auth?: { type: 'basic'; username: string; password: string } | { type: 'bearer'; token: string } }

export interface TestAutomationPayload {
  workspaceId: string
  automationId?: string
  automationName?: string
  actions: TestAutomationAction[]
  permissionMode?: PermissionMode
  labels?: string[]
}

export type SafeAutomationAction =
  | { type: 'prompt'; prompt: string; llmConnection?: string; model?: string; thinkingLevel?: ThinkingLevel; ephemeral?: boolean }
  | { type: 'webhook'; url: string; method?: string; bodyFormat?: 'json' | 'form' | 'raw'; captureResponse?: boolean }
  | SafeScriptAutomationAction // UA8.3

export interface SafeAutomationMatcher {
  id?: string
  name?: string
  matcher?: string
  cron?: string
  timezone?: string
  permissionMode?: PermissionMode
  labels?: string[]
  conditions?: unknown[]
  enabled?: boolean
  actions: SafeAutomationAction[]
}

export interface SafeAutomationsConfig {
  version?: number
  automations: Record<string, SafeAutomationMatcher[]>
  /** F1.795 — set when the managed codex policy keeps this app's local automations from running; absent otherwise. */
  managedLocalAutomationDisabled?: true
}

export interface SafeAutomationMutationResult {
  automationId: string
  event: string
  matcherIndex: number
}

export interface SafeAutomationHistoryEntry {
  id: string
  ts: number
  ok: boolean
  sessionId?: string
  error?: string
  /**
   * UB4.8/UB6.9 — the host's skip reason (the loop guard, or the matcher's
   * semantic condition). A `skipped` row is `ok: true` with no session; the
   * field existed at the serializer since UB4.8 and is declared here now that
   * a reader reads it.
   */
  skipped?: string
  /**
   * UB6.9 — the "yes" probability behind a semantic-condition skip. Structured
   * so the timeline can localise the reason instead of parsing `skipped`.
   */
  skippedProbability?: number
  /**
   * UB12.20 — which loop-guard arm skipped the run (self-trigger or chain depth).
   * Structured so the timeline can localise the reason instead of showing the
   * host's English `skipped` line; absent on rows written before UB12.20.
   */
  skippedLoopGuard?: AutomationLoopGuardSkip
  webhook?: {
    method: string
    url: string
    statusCode: number
    durationMs: number
    attempts?: number
    /** UB4.27 — the executor's failure reason, passed to the timeline (capped at HISTORY_FIELD_MAX_LENGTH at write). */
    error?: string
    /** UB4.27 — the captured response body, capped, possibly truncated and not valid JSON. */
    responseBody?: string
  }
  /** UA8.3 — a script run (the host's refusal reason, when it refused, is in `error`). */
  script?: {
    script: string
    exitCode: number | null
    durationMs: number
    page?: string
    blocked?: boolean
    skipped?: boolean
    timedOut?: boolean
  }
}

export type TestAutomationActionResult =
  | { type: 'prompt'; success: boolean; stderr?: string; sessionId?: string; duration: number }
  | { type: 'webhook'; success: boolean; url: string; statusCode: number; error?: string; duration: number } | TestScriptActionResult

export interface TestAutomationResult {
  actions: TestAutomationActionResult[]
}

// ---------------------------------------------------------------------------
// Window types
// ---------------------------------------------------------------------------

export type WindowCloseRequestSource = 'keyboard-shortcut' | 'window-button' | 'unknown'

export interface WindowCloseRequest {
  source: WindowCloseRequestSource
}

// ---------------------------------------------------------------------------
// Browser / navigation types (data shapes used by BroadcastEventMap)
// ---------------------------------------------------------------------------

/**
 * UB4.17 (v0.15.1) — verdict of a security-challenge check on a browser page
 * (Cloudflare interstitial, captcha challenge, …). Classified in
 * apps/electron/src/main/security-challenge.ts.
 */
export interface BrowserSecurityChallenge {
  /** A blocking challenge from a known provider: the user has to solve it. */
  detected: boolean
  /** Provider behind the evidence ('cloudflare', 'google', 'hcaptcha', …), or 'none'. */
  provider: string
  /** Evidence seen, including context that never decides a verdict. */
  signals: string[]
  /** Evidence too weak for a hand-off, e.g. a visible Turnstile widget: worth a note only. */
  suspected?: boolean
}

export interface BrowserInstanceInfo {
  id: string
  url: string
  title: string
  favicon: string | null
  isLoading: boolean
  canGoBack: boolean
  canGoForward: boolean
  boundSessionId: string | null
  ownerType: 'session' | 'manual'
  ownerSessionId: string | null
  isVisible: boolean
  agentControlActive: boolean
  themeColor: string | null
  /**
   * Workspace that owns this browser instance, or `null` for unbound manual
   * windows. Renderers filter the tab strip / status badge by `activeWorkspaceId`
   * so a session in workspace A doesn't see windows opened by workspace B.
   * Missing/null entries always pass the filter — this keeps older renderers
   * and main processes that pre-date the field working unchanged.
   */
  workspaceId?: string | null
}

export interface DeepLinkNavigation {
  view?: string
  tabType?: string
  tabParams?: Record<string, string>
  action?: string
  actionParams?: Record<string, string>
  /**
   * Trust label of the URL this navigation came from. `'external'` covers an
   * OS-delivered link, a page in the in-app browser pane and a markdown link
   * in model output; `'internal'` is only for a dispatch Nessy itself built.
   *
   * Optional so an older main process stays wire-compatible, but a MISSING
   * value MUST be read as `'external'`. This is deliberately the OPPOSITE of
   * the `workspaceId` convention documented on `BrowserInstanceInfo` above
   * ("Missing/null entries always pass the filter"): there a missing field is
   * permissive, here it must fail safe, because the renderer keeps external
   * links inert (prefill only, no state-mutating actions).
   */
  origin?: 'external' | 'internal'
}

/**
 * P6.563 — what the Plugins page's Refresh-runtime button actually did.
 *
 * The three names are `PluginRuntimeRefreshOutcome`'s
 * (`server-core/src/sessions/plugin-runtime-refresh-outcome.ts`), collapsed
 * from the per-session counts into the one verdict the button has to report:
 * `deferred` wins over `applied` (a turn in flight still holds the old paths),
 * and `untouched` is the honest answer when no live runtime existed to refresh
 * — NOT a failure, and deliberately not folded into `applied`, because a user
 * who is told "plugins are now live" after clicking on a workspace with no
 * running session has been told something the server never checked.
 *
 * Declared here rather than beside the marketplace `Safe*` family because that
 * file cannot import from `server-core`, and this DTO is the wire projection of
 * a `server-core` vocabulary.
 */
export type PluginRuntimeRefreshRpcVerdict = 'applied' | 'deferred' | 'untouched'

export interface SafePluginRuntimeRefreshResult {
  verdict: PluginRuntimeRefreshRpcVerdict
}

/**
 * P6.447 — which connection this app is actually talking to.
 *
 * Nothing in the app said which base URL, credential source, provider and proxy
 * a session was using. Claude's own `/status` is inside the closed binary and
 * unreachable from an SDK-hosted session, codex publishes no equivalent, and Pi
 * is ours — so the answer is the HOST's, computed once and worded identically on
 * all three runtimes rather than read back from three different reports.
 *
 * `credentialSource` is a VALUE, so the surface owns the wording. It names the
 * connection's own auth mechanism — WHICH kind of secret is presented — and
 * never the secret, nor whether one is currently valid: that is
 * `checkApiAvailability`'s question and a different one.
 */
export type ConnectionCredentialSourceV1 =
  | 'stored-api-key'
  | 'stored-oauth'
  | 'stored-token'
  | 'environment'
  | 'platform-credentials'
  | 'none'

export interface ConnectionProvenanceV1 {
  /** `null` when no connection is configured at all. */
  connectionSlug: string | null
  displayName: string | null
  /** The endpoint requests actually go to, or `null` when the provider default applies. */
  baseUrl: string | null
  providerLabel: string
  credentialSource: ConnectionCredentialSourceV1
  /**
   * `true` only for the verified Nessy gateway (`isNessyGatewayBaseUrl`, the
   * WHOLE-URL match). A BYO endpoint is `false`, and the surface must render the
   * two differently — that distinction is the row's own requirement, because the
   * gateway is the one endpoint whose request rewriting and `Nestor-Token`
   * attachment this product performs.
   */
  verifiedGateway: boolean
  /**
   * The proxy env var in force and its value with any userinfo stripped, or
   * `null` when requests go direct.
   */
  proxy: { name: string; value: string } | null
}

/**
 * F1.298 — a `SessionEvent` member, declared here rather than inline because the
 * union's head sits above lines this file is cited by: the Pi adapter's verdict
 * that a failed attempt's streamed text is void. The host cancels that turn's
 * pending delta batch before forwarding it (never flushing failed text after the
 * discard), and the renderer removes the still-streaming message of `turnId`.
 * Ported from craft-agents-oss v0.13.4 (`text_discard`, Apache-2.0).
 */
export type SessionTextDiscardEvent = { type: 'text_discard'; sessionId: string; turnId: string }

/**
 * UA2.1 — the metadata a `session_metadata_changed` event carries: programmatic writes that do not ride the
 * header-signature file watch (ported from craft-agents-oss v0.13.4 `dto.ts`, Apache-2.0; the board column
 * here, UA3.1 adds `taskNodeCount`, `taskDraft`, `taskSlug` and `projectId`).
 *
 * NESSY DEVIATION (an upstream defect not copied): a CLEARED field travels as `null`. The WS codec is JSON
 * (`transport/codec.ts`), which drops a key whose value is `undefined`, so upstream's
 * `{ kanbanColumn: undefined }` reaches a window as `{}` and the clear is lost until a reload. Receivers map
 * `null` to absent; any other value — `false` included — is a value.
 */
export type SessionMetadataChanges = { kanbanColumn?: string | null; taskNodeCount?: number | null; taskDraft?: boolean | null; taskSlug?: string | null; projectId?: string | null } // UA3.1 — the other four v0.13.4 fields, same null-clear rule

/** UA2.1 — declared here rather than inline for {@link SessionTextDiscardEvent}'s reason (the union's head is cited by line). */
export type SessionMetadataChangedEvent = { type: 'session_metadata_changed'; sessionId: string; changes: SessionMetadataChanges }

/** UA2.1 — move a session to a board column; `null` clears it (the board falls back to `statusToColumn`). */
export type SetKanbanColumnCommand = { type: 'setKanbanColumn'; column: string | null }

// UA2.1 — declared by interface merging so no docs-cited line above moves.
export interface Session {
  /** UA2.1 — Kanban board column id ('todo' | 'in-progress' | 'done' or a project column); independent of sessionStatus. */
  kanbanColumn?: string
}

// UA3.1 — the v0.13.4 project and task fields on the wire, declared by interface merging (this file is cited by line).
export interface Session {
  /** UA3.1 — workspace-scoped project id (an entity id, not a folder; the folder is `projectHandleId`'s). */
  projectId?: string
  /** UA3.1 — the parent session (subtask, or a Conductor child's orchestrator). Not `PermissionRequest.parentSessionId` (see `SessionConfig.parentSessionId`). */
  parentSessionId?: string
  /** UA3.1 — Tasks Conductor: slug of the task spec this session belongs to. */
  taskSlug?: string
  /** UA3.1 — Tasks Conductor: id of the run that spawned this child session (child nodes only). */
  taskRunId?: string
  /** UA3.1 — Tasks Conductor: id of the DAG node this child session executes (child nodes only). */
  taskNodeId?: string
  /** UA3.1 — Tasks Conductor: total DAG node count (orchestrator only); a stable board progress denominator. */
  taskNodeCount?: number
  /** UA3.1 — Tasks Conductor: generate-time draft orchestrator, hidden from the board until adopted. */
  taskDraft?: boolean
}

// UA3.1 — the v0.13.4 create options (ported from craft-agents-oss v0.13.4 `dto.ts`, Apache-2.0), by interface merging.
export interface CreateSessionOptions {
  /**
   * Bind the new session to a workspace project ENTITY. UA3.1 persists it (and a child inherits its
   * parent's when it names none); the entity check and the project folder are UA5.4's — no folder ever
   * enters through this field (the folder is `projectHandleId`, the only folder ingress).
   */
  projectId?: string
  /** Mark the new session as a subtask of this parent. Must be a session of the SAME workspace (`parent-session-not-in-workspace`). */
  parentSessionId?: string
  /** Tasks Conductor: slug of the task spec this session belongs to. Must match the task slug grammar (`task-slug-invalid`). */
  taskSlug?: string
  /** Tasks Conductor: id of the run that spawned this child session (child nodes only). */
  taskRunId?: string
  /** Tasks Conductor: id of the DAG node this child session executes (child nodes only). */
  taskNodeId?: string
  /** Tasks Conductor: mark the orchestrator as a generate-time draft (hidden until adopted). `false` is persisted. */
  taskDraft?: boolean
  /**
   * Apply the reserved "Task" labeling after creation (`SessionManager.applyTaskLabel`): a top-level session
   * gets its own `TASK-<slug>-<N>` item label; a session with `parentSessionId` inherits the parent's. Task
   * flows opt in; plain chats do not. Fail-soft: a label problem never fails the create.
   */
  applyTaskLabel?: boolean
}

// ---------------------------------------------------------------------------
// UA3.3 — Tasks (Conductor) DTOs: the wire contract of the durable `tasks:*` channels. Ported from
// craft-agents-oss v0.13.4 `packages/shared/src/protocol/dto.ts` (Apache-2.0). Folder ingress is a project
// HANDLE, never a path: `TaskCreateRequest.projectHandleId` is ours, and `TaskGenerateRequest` takes
// `projectHandleId` where upstream took a raw `cwd` (spec §10 "Folder ingress").
// ---------------------------------------------------------------------------

export interface TaskValidationIssueDto {
  /** Dotted path into the spec, e.g. "nodes.design.depends_on". */
  path: string
  message: string
  severity: 'error' | 'warning'
  suggestion?: string
}

export interface TaskValidationResultDto {
  valid: boolean
  errors: TaskValidationIssueDto[]
  warnings: TaskValidationIssueDto[]
  /** Pre-flight estimate: total nodes and how many sessions a run would spawn. */
  estimate?: { nodeCount: number; sessionNodeCount: number }
}

export interface TaskCreateRequest {
  /** task.yaml source text (authoritative). */
  yaml: string
  /**
   * When this YAML was authored by a `tasks:generate` orchestrator, the id of that draft session (UA4.5: visible):
   * `tasks:create` promotes it in place instead of minting a second top-level session. Honoured only while
   * the draft is unadopted and unbound; otherwise a fresh orchestrator is created. Beside
   * `attachToExistingSession` (an edit that saves a Generate plan) the attach wins and the draft is not adopted.
   * Set on any path, the save records no human run confirmation (UA4.4): an agent wrote the nodes.
   */
  orchestratorSessionId?: string
  /**
   * Edit-mode bind: the id of an existing, board-visible session the user is saving this spec onto.
   * `tasks:create` binds it and HARD-ERRORS if the bind fails — never a fresh orchestrator beside it.
   */
  attachToExistingSession?: string
  /**
   * NESSY: the folder chosen in the editor, as an issued project handle of this workspace. The fresh
   * orchestrator starts in it. Never a path; an attach or adopt never moves a session's folder (that is
   * `projects:setSessionProject`'s alone).
   */
  projectHandleId?: string
}

export interface TaskCreateResult {
  /** Empty string when validation failed — inspect `validation`. */
  slug: string
  /** The persistent parent/orchestrator session (author + final verifier). */
  orchestratorSessionId: string
  validation: TaskValidationResultDto
  /** Resolved id of the Task item label applied to the orchestrator; undefined when labeling failed (fail-soft). */
  taskLabelId?: string
}

export interface TaskGenerateRequest {
  /** Natural-language goal the orchestrator turns into a task.yaml DAG. */
  goal: string
  /** Optional working title for the task / orchestrator session. */
  title?: string
  /** Optional model for the orchestrator session (defaults to the session default). */
  model?: string
  /** NESSY: the orchestrator's folder as an issued project handle (upstream: a raw `cwd`). */
  projectHandleId?: string
  /** Project entity to bind the draft orchestrator to. */
  projectId?: string
  /** LLM connection slug that serves `model`. */
  llmConnection?: string
  /** Task-level source slugs the draft orchestrator may author against (omitted → workspace default). */
  enabledSourceSlugs?: string[]
  /** The editor's mode. NESSY (UA4.5): the draft always authors in `dontAsk`; this mode arrives on adoption, via the spec. */
  permissionMode?: PermissionMode
  /**
   * NESSY (UA12.93) — an edit-mode Generate names the task's orchestrator: the draft authors in ITS folder (the one the
   * run's children use) and `projectHandleId` is ignored; an unknown or archived id is refused `task-orchestrator-missing`.
   */
  orchestratorSessionId?: string
}

/** Synchronous ack for `tasks:generate`; the authored spec arrives later on the `tasks:generated` push. */
export interface TaskGenerateAck {
  orchestratorSessionId: string
}

export interface TaskGenerateResult {
  /** The persistent orchestrator session that authored the spec (also handles revisions). */
  orchestratorSessionId: string
  /** Slug of the authored spec; empty when generation produced an invalid spec. */
  slug: string
  /** Parsed TaskSpec when valid (consumers cast to TaskSpec from @nessy-agent/shared/tasks). */
  spec?: unknown
  /** The raw task.yaml the orchestrator produced — shown and editable in the editor. */
  yaml: string
  validation: TaskValidationResultDto
  /** Set when generation failed before producing a spec. */
  error?: string
}

export interface TaskRunRequest {
  slug: string
  runId?: string
  orchestratorSessionId?: string
  params?: Record<string, unknown>
  /**
   * UA4.4 — the `task.yaml` digest the user confirmed in the run confirmation (`TaskGetResult.runConfirmation.digest`).
   * `tasks:run` refuses `run-confirmation-required` unless the current digest is the last one a human saved or
   * confirmed, or equals this — which the host then records.
   */
  confirmedDigest?: string
}

/** UA4.4 — what the run confirmation shows (spec §10 "Run confirmation"); the host builds it from the spec on disk. */
export interface TaskRunConfirmationDto {
  /** `sha256:<hex>` of the `task.yaml` bytes this confirmation is for; sent back as `TaskRunRequest.confirmedDigest`. */
  digest: string
  nodeCount: number
  /** Each node as the Conductor dispatches it: model and connection (none = the workspace default), effective mode. */
  nodes: { id: string; title: string; model?: string; llmConnection?: string; permissionMode?: PermissionMode }[]
  /** Task-level sources (workspace sources only; empty = the workspace's default sources). */
  sources: string[]
  /** The orchestrator's mode — every node's ceiling. */
  orchestratorPermissionMode?: PermissionMode
  /** Active plugins a node sees, with their MCP server names; absent when they could not be read. */
  plugins?: { name: string; mcpServers: string[] }[]
}

export interface TaskNodeRunStateDto {
  id: string
  /** pending | running | done | failed | cancelled | skipped */
  state: string
  sessionId?: string
  attempt: number
}

export interface TaskRunSnapshotDto {
  slug: string
  runId: string
  taskId: string
  /** running | paused | verifying | stopped | completed | failed */
  status: string
  orchestratorSessionId?: string
  nodes: TaskNodeRunStateDto[]
  /** Sum of each child's (input + output) tokens observed at completion. */
  tokensUsed: number
}

export interface TaskGetResult {
  slug: string
  validation: TaskValidationResultDto
  /** The parsed TaskSpec when valid; consumers cast. */
  spec?: unknown
  /** Active run snapshot when a runId was supplied and known; otherwise null. */
  run?: TaskRunSnapshotDto | null
  /** UA4.4 — the current `task.yaml` digest is not the last one a human saved or confirmed: a run asks first. */
  needsRunConfirmation?: boolean
  /** UA4.4 — present exactly when `needsRunConfirmation` is true. */
  runConfirmation?: TaskRunConfirmationDto
  /** UA4.4 — node ids whose session worked again after the node was done, in the task's latest run. */
  wokeAfterDone?: string[]
}

/** One subtask's outcome in a persisted run, for the editor's Results tab. */
export interface TaskResultNodeDto {
  id: string
  title: string
  /** pending | running | done | failed | cancelled | skipped */
  state: string
  /** The child session that ran this node, recovered from the run log. */
  sessionId?: string
  /** The node's recorded final output text, when present. */
  output?: string
  /** UA4.4 — its session worked again after the node was done (`node-woke-after-done`); that work is not its output. */
  wokeAfterDone?: boolean
}

/** UB6.6 — one verifier verdict as shown in the editor's Results tab. */
export interface TaskVerdictDto {
  result: 'pass' | 'fail' | 'unparsed'
  reason?: string
  nodes?: string[]
  /**
   * `decision` when the verdict was read out of a reply WITHOUT a VERDICT line by the
   * decision model (opt-in layer); absent for a parsed VERDICT line. The UI marks
   * inferred verdicts (`tasks.verdictInferred`).
   */
  via?: 'parsed' | 'decision'
  /** Decision-model verdicts only: confidence of the winning option (0..1). */
  confidence?: number
}

/** Storage-backed read of a task run's outcome; survives a restart. */
export interface TaskResultsDto {
  slug: string
  /** The run inspected; null when the task has never been run. */
  runId: string | null
  /** All run ids for this task (newest last). */
  runIds: string[]
  verdict?: TaskVerdictDto
  /** Every verdict in order (a FAIL→repair loop produces several), for the history view. */
  verdicts?: TaskVerdictDto[]
  repair?: { used: number; max: number }
  /** UA4.3 — the live run's status (running | paused | verifying | …), else the log's terminal one (completed | failed | stopped), else `interrupted` (a restart). */
  runStatus?: string
  acceptanceCriteria?: string
  nodes: TaskResultNodeDto[]
}

/** NESSY (`tasks:delete`, no v0.13.4 counterpart): the outcome of deleting a task spec no live session carries. */
export interface TaskDeleteResult {
  slug: string
  /** `true` when `tasks/<slug>/` existed and was removed; `false` when there was nothing to remove. */
  deleted: boolean
}

/**
 * UA8.1 — a saved script action's "Run test" result (craft-agents-oss v0.13.4's shape: exit code, stdout capped at
 * 2000 characters, the failure in `error`). `blocked` marks a run refused before it spawned (unapproved, changed since
 * approval, managed policy, containment, or sent without its saved automation) — nothing ran.
 */
export interface TestScriptActionResult {
  type: 'script'
  success: boolean
  script: string
  exitCode: number | null
  blocked?: boolean
  stdout?: string
  error?: string
  duration: number
}

/**
 * UA1.19 — one row of the Published pages list (`artifacts:list`): an artifact the signed-in dp identity owns on
 * t-artifacts (`GET /api/artifacts/mine`), joined to THIS workspace's registry. `source` is absent for a page published
 * outside this workspace (another workspace, another machine, the service's own CLI). No token, header or body.
 */
export interface PublishedArtifactDto {
  id: string
  url: string
  title: string
  emoji?: string
  /** ISO timestamp; `null` = the link never expires. */
  expiresAt: string | null
  /** `null` when the service did not say. */
  retentionDays: number | null
  /** The session and file this workspace published it from (`kind`: O22 — `file`, `page` or `chat`). */
  source?: { sessionId: string; path: string; kind: 'file' | 'page' | 'chat' }
  /** A DELETE that failed for a reason a later attempt can fix; retried after the next successful sign-in. */
  pendingDelete?: { requestedAt: string; lastErrorKind?: string }
}

/** `needs-login`: dp is signed out (one card, no browser); `unavailable`: any other failure of the list call. */
export type ArtifactsListStatus = 'ok' | 'needs-login' | 'unavailable'

export interface ArtifactsListResult {
  status: ArtifactsListStatus
  /** The client's fixed sentence for a failure, or a note about the registry — never a body or a token. */
  message?: string
  /** The client's error kind (`needs-login`, `network`, `dp-unavailable`, …) when `status` is not `ok`. */
  errorKind?: string
  /** On `ok`: the list. Otherwise: only the registry's pending deletions, so a deletion still owed stays visible. */
  artifacts: PublishedArtifactDto[]
  /** How many owed deletions this call completed (absent when none). */
  retriedDeletes?: number
}

/** `artifacts:setRetention`. */
export type ArtifactActionResult =
  | { ok: true; artifact?: PublishedArtifactDto }
  | { ok: false; errorKind: string; message: string }

/** `artifacts:delete`'s argument: the row being deleted (the link is kept if the deletion is owed). */
export interface ArtifactDeleteTarget {
  id: string
  url: string
  title?: string
  expiresAt?: string | null
  retentionDays?: number | null
}

/** `artifacts:delete`: `pending` = kept in the registry and retried after the next successful sign-in. */
export type ArtifactDeleteResult =
  | { outcome: 'deleted' }
  | { outcome: 'pending'; errorKind: string; message: string }
  | { outcome: 'failed'; errorKind: string; message: string }

/** UA1.23 — `artifacts:publishFile`'s argument: the block's session and the file its `src` names (a path, never bytes). */
export interface ArtifactPublishFileRequest {
  sessionId: string
  filePath: string
}

/**
 * UA1.23 — the host's verdict for a preview's Publish: the SAME verdict `publish_artifact` gets
 * (session-tools-core `PublishArtifactVerdict`), declared here structurally so the protocol package does not depend
 * on the tools package. `note` is the host's sentence (never a token or a body).
 */
export interface ArtifactPublishFileResult {
  status: 'published' | 'updated' | 'denied' | 'refused' | 'failed'
  note: string
  url?: string
  /** ISO timestamp, or `null` when the link never expires. */
  expiresAt?: string | null
}

// ---------------------------------------------------------------------------
// UA8.3 — the script action on the wire (ours: upstream v0.13.4 has no approval, spec §15 item 3)
// ---------------------------------------------------------------------------

/** Where a script stands against the host ledger (`automations/script-approval.ts` `ScriptApprovalState`). */
export interface ScriptApprovalStatusDto {
  state: 'outside' | 'missing' | 'unapproved' | 'changed' | 'approved'
  /** sha256 of the script's current bytes — the digest an approval must name. */
  sha256?: string
}

/** A saved `type:'script'` action as the renderer sees it, with its approval state. */
export interface SafeScriptAutomationAction {
  type: 'script'
  script: string
  args?: string[]
  runtime?: 'bun' | 'node' | 'python3'
  timeoutMs?: number
  page?: string
  /** Absent when the host could not read the ledger key (the run is then refused at use time anyway). */
  approval?: ScriptApprovalStatusDto
}

// ---------------------------------------------------------------------------
// UA5.3 — the project ENTITY on the wire (craft-agents-oss v0.13.4 `projects:*`, `project_id_changed`,
// `setProjectId`; Apache-2.0), declared at the file end because the union heads above are cited by line.
// ---------------------------------------------------------------------------

/** UA5.3 — a session's project binding changed (v0.13.4 `project_id_changed`); `null` = unbound. */
export type ProjectIdChangedEvent = { type: 'project_id_changed'; sessionId: string; projectId: string | null }

/**
 * UA5.3 — bind a session to a project entity, or unbind it with `null` (v0.13.4 `setProjectId`). It never moves the
 * session's folder (spec §12 "Rebind"): the folder moves only through `projects:setSessionProject`.
 */
export type SetProjectIdCommand = { type: 'setProjectId'; projectId: string | null }

/**
 * UA5.3 — a project's folder as the renderer sees it (spec §12 "Folder (adapt)": `{ handleId, displayPath, trusted }`),
 * never the stored `ProjectFolder`: the host re-validates the stored path through the handle service's one raw-path
 * ingress on every read and compares the persisted `projectKey`.
 */
export interface ProjectFolderView {
  /** An issued, expiring handle for the folder now — what `projects:setTrust` and the folder flows take. `null` when the folder cannot be used (see `problem`). */
  handleId: string | null
  /** The folder as the user chose it (the handle's display path). */
  displayPath: string
  /** The folder's whole-project trust decision is `trusted`. */
  trusted: boolean
  /**
   * Why `handleId` is `null`: the folder now has another identity than the one bound (`project-folder-identity-changed`
   * — moved, replaced, or `config.json` edited on disk), or it cannot be resolved at all (`project-folder-unavailable`
   * — missing, unmounted, unreadable, refused by the ingress).
   */
  problem?: 'project-folder-identity-changed' | 'project-folder-unavailable'
}

/** UA5.3 — `ProjectConfig` with its folder as a {@link ProjectFolderView}. */
export type ProjectConfigView = Omit<import('../projects/types').ProjectConfig, 'folder'> & { folder?: ProjectFolderView }

/** UA5.3 — what `projects:get` / `projects:getOne` / `projects:changed` carry: upstream's `LoadedProject`, folder as a view. */
export type LoadedProjectView = Omit<import('../projects/types').LoadedProject, 'config'> & { config: ProjectConfigView }

/** UA5.3 — `projects:create`'s input: upstream's `CreateProjectInput`, the folder as an issued handle of this workspace (never a path). */
export type CreateProjectRequest = import('../projects/types').CreateProjectInput & { projectHandleId?: string }

/** UA5.3 — `projects:update`'s patch: upstream's, minus the folder (`projects:setFolder` is its only writer). */
export type UpdateProjectPatch = Partial<Omit<import('../projects/types').ProjectConfig, 'id' | 'slug' | 'createdAt' | 'updatedAt' | 'folder'>>

/**
 * UA12.25 — the reload half of the host-gate cards: declared by interface MERGING at
 * the end of the file so that no docs-cited line above moves (the house pattern — see
 * `ArtifactPublishPermissionRequest` in `core/types/message.ts`, and `Message.taskNotification`
 * there).
 */
export interface Session {
  /**
   * Every card still pending for this session whose `permission_request` went out with
   * `origin: 'host_gate'`, with its full payload, so a client that loads the list after it was
   * raised (a reload, a second window) can re-show it without having seen the original event — the
   * badge (`awaitingApprovalCount`) names nothing a person could answer. That origin is the host's
   * own cards (`publish_artifact`, `archive_session`) AND the default for a request that names no
   * origin (P6.709): Pi tool-call cards, Pi `ask_user`, MCP elicitation, the host consents (worktree
   * setup/cleanup, reopen compact). A `claude_native` or `codex_approval` card rides nothing. Absent
   * when the session files none; a card leaves the list when it is answered or withdrawn — the live
   * pending-request map is the only source, nothing is stored. (F1.910's residue, a card of a Pi turn
   * that ended by an error staying pending and returning on every reload, was closed by F1.1105:
   * `SessionManager.withdrawStoppedTurnPiToolCards` now runs on an error ending too.)
   */
  pendingHostCardRequests?: PermissionRequest[]
}
