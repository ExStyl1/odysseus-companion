import * as React from 'react'
import { useTranslation } from "react-i18next"
import { toast } from 'sonner'
import {
  Paperclip,
  ChevronUp,
  // D1.214 — `Image as ImageIcon` went to the model menu with the menu; UB14.30 — `ChevronDown` and
  // `AlertCircle` went to `ComposerModelMenu` with the trigger; UB14.31 — `Check` and `DatabaseZap` went
  // to `WorkingDirectorySelector` and `ComposerSourcesChip` (and the unread `X` went with them).
} from 'lucide-react'
import { Icon_Home, consoleSnippetCommand } from '@nessy-agent/ui'
import { useAtomValue } from 'jotai'
import { agentsAtom } from '@/atoms/agents'
import { sessionMetaMapAtom } from '@/atoms/sessions'
import { sessionStorageWorkingDirectory } from '@/lib/session-storage-notice'

import * as storage from '@/lib/local-storage'
// UB14.31 — the folder picker's `useDirectoryPicker` / `ServerDirectoryBrowser` live in `WorkingDirectorySelector`.
import {
  InlineSlashCommand,
  useInlineSlashCommand,
  type SlashCommandId,
} from '@/components/ui/slash-command-menu'
import {
  InlineMentionMenu,
  useInlineMention,
  type MentionItem,
  type MentionItemType,
} from '@/components/ui/mention-menu'
import {
  InlineLabelMenu,
  useInlineLabelMenu,
} from '@/components/ui/label-menu'
import type { LabelConfig } from '@nessy-agent/shared/labels'
import { parseMentions } from '@/lib/mentions'
import { skillMentionInvocationId } from '@/lib/capability-catalog'
import { RichTextInput, type RichTextInputHandle } from '@/components/ui/rich-text-input'
// D1.214 — `StyledDropdownMenuSubTrigger` and `StyledDropdownMenuSubContent` went with the thinking
// sub-menu, which moved whole; UB14.29 — the mode menu's `StyledDropdownMenu{Content,Item,Separator}`
// went into `ComposerModeChip`; UB14.30 — the model trigger's `DropdownMenu`/`DropdownMenuTrigger` and
// `Tooltip*` went into `ComposerModelMenu` (the last readers of both imports here).
import { cn } from '@/lib/utils'
import { IconButton } from '@/components/ui/button'
import { coerceInputText } from '@/lib/input-text'
import { isMac } from '@/lib/platform'
import { sourceSelectionId } from '@/lib/capability-catalog'
import { applySmartTypography } from '@/lib/smart-typography'
import { autoCapitaliseFirstCharacter } from '@/lib/auto-capitalise'
import { AttachmentPreview } from '../AttachmentPreview'
import { ImageSupportWarningBanner } from './ImageSupportWarningBanner'
import { resolveStagedImagePolicy } from './attachment-capability'
import { ANTHROPIC_MODELS, getModelDisplayName, getModelContextWindow, type ModelDefinition } from '@config/models'
import {
  resolveEffectiveConnectionSlug,
  isCompatProvider,
  modelSupportsImages,
} from '@config/llm-connections'
import { useOptionalAppShellContext } from '@/context/AppShellContext'
import { EditPopover, getManagedEditConfig } from '@/components/ui/EditPopover'
import { CompactWorkingDirectorySelector } from '@/components/ui/CompactWorkingDirectorySelector'
import { FreeFormInputContextBadge } from './FreeFormInputContextBadge'
import { ComposerSourcesChip } from './ComposerSourcesChip'
import { WorkingDirectorySelector, formatPathForDisplay } from './WorkingDirectorySelector'
import { BranchSwitcher } from './BranchSwitcher'
import { composerLeftGroupFloor, composerMountsBranchChip } from './branch-switcher-helpers'
import { resolveContextMeterState } from './context-meter-state'
import { ContextMeterUnknownWindow } from './ContextMeterUnknownWindow'
import { ContextUsageChip } from './ContextUsageChip'
import { FollowUpChips } from './FollowUpChips'
import { SendButton } from './SendButton'
import { derivePickerMode } from './picker-mode'
import { defaultComposerPlaceholderKeys } from './composer-placeholders'
import { ComposerModelMenu } from './ComposerModelMenu'
import { ConnectionRow, type RuntimeSwitchPreviewAnswer } from './ConnectionRow'
import type { CustomSlashCommand, CustomSlashCommandId, FileAttachment } from '../../../../shared/types'
import { attachmentKindFromBrowserFile } from '@nessy-agent/shared/utils/file-types'
import type { SafeCapabilitySummary } from '@nessy-agent/shared/protocol/capabilities'
import {
  DEFAULT_CYCLABLE_PERMISSION_MODES,
  type PermissionMode,
} from '@nessy-agent/shared/agent/modes'
import type { ThinkingLevel } from '@nessy-agent/shared/agent/thinking-levels'
import type { IssuedProjectHandle } from '@nessy-agent/shared/projects/project-handle-service'
import type { RecentProjectSummary, SessionHeapdumpResult, SessionRecapResult, SideQuestionResult } from '@nessy-agent/shared/protocol'
import { useEscapeInterrupt } from '@/context/EscapeInterruptContext'
import { hasOpenOverlay } from '@/lib/overlay-detection'
import { ToolbarStatusSlot } from './ToolbarStatusSlot'
import { buildPlanApprovalMessage, planApprovalLandingMode } from '../plan-approval-message'
import { shouldHandleScopedInputEvent, stopTurnOnArrowUp } from './input-event-guards'
import { createDraftParentSync, seedComposerFromParent, type DraftParentSync } from './draft-parent-sync'
import {
  pushComposerInputHistory,
  recallComposerInputHistory,
  resolveDoubleEscape,
} from './double-escape'
import { REWIND_COMMAND_LABEL } from '@nessy-agent/shared/slash-commands/rewind'
import { resolveSubmitControl, type SubmitMode } from './submit-control'
import { clearPendingFocusForSession, consumePendingFocusForSession } from './focus-input-events'
import { CompactPermissionModeSelector } from './CompactPermissionModeSelector'
import { ComposerModeChip } from './ComposerModeChip'
import { CompactModelSelector } from './CompactModelSelector'
import { useComposerCapabilities } from './composer-capabilities-context'
import {
  // D1.214 — `formatTokenCount` went with the context footer and
  groupConnectionsByProvider,
  // `isTranslatedWireSessionModel` with the per-row translated mark.
  stripPiPrefixForDisplay,
} from './model-picker-helpers'
import { useModelVisionToggle } from './useModelVisionToggle'
import { dispatchSlashCommandAction, typedOutOfBandCommandSubmission } from './slash-command-actions'
import { hotkeyMatchesEvent, useActionRegistry } from '@/actions'
import { otherMidStreamBehavior } from '@nessy-agent/shared/config/llm-connections'
import { SideQuestionOverlay, isSideQuestionSessionId, nestedSideQuestionText } from '../SideQuestionOverlay'
import { appendExchange, resolveExchange, updateSideQuestionRing, viewNewest } from '../side-question-ring'
import { awaitCompactionComplete, createPendingPlanDispatcher } from './compaction-wait'
import {
  customSlashCommandInputSubmission,
  customSlashCommandMenuSubmission,
} from './custom-slash-command-submission'
import {
  applyWorkspaceCycleToComposerModes,
  coercePermissionModeForComposer,
  getSupportedComposerPermissionModes,
  resolveComposerPermissionModeList, withPermissionModeMenuDecorations,
} from '@/lib/composer-permission-modes'
import { isRendererMintedSessionId } from './stub-session'
import { useTransportConnectionState } from '@/hooks/useTransportConnectionState'
import { checkAttachmentSizes, DEFAULT_MAX_MESSAGE_BYTES, type AttachmentSizeInput, type AttachmentSizeProblem } from '@nessy-agent/shared/protocol/message-limits'
import { attachmentSizeInputOf, attachmentSizeToast, maxMessageBytesOf, oversizedAttachment } from './attachment-size-guard'


/** Platform-specific modifier key for keyboard shortcuts */
const cmdKey = isMac ? '⌘' : 'Ctrl'
const EMPTY_CUSTOM_SLASH_COMMANDS: CustomSlashCommand[] = []

// `SubmitMode` and the rule that produces it live in `./submit-control`.

/** Default rotating placeholders are now generated inside FreeFormInput via useMemo + t() */

/** Fisher-Yates shuffle — returns a new array in random order */
function shuffleArray<T>(array: T[]): T[] {
  const shuffled = [...array]
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]
  }
  return shuffled
}

export interface FollowUpInputItem {
  id: string
  messageId: string
  annotationId: string
  index?: number
  noteLabel: string
  selectedText: string
  color?: string
}

export interface FreeFormInputProps {
  /** A console snippet was pasted (`$ cmd` lines or a fenced shell block): offer to run it in the background */
  onConsoleSnippetPaste?: (snippet: { command: string; text: string }) => void
  /** Placeholder text(s) for the textarea - can be array for rotation */
  placeholder?: string | string[]
  /** Whether input is disabled */
  disabled?: boolean
  /** Whether the session is currently processing */
  isProcessing?: boolean
  /** Callback when message is submitted (skillSlugs from @mentions) */
  /**
   * P6.480 — `midStreamOverride` asks for the OTHER follow-up behaviour for this
   * one send, without changing the connection's stored setting. Absent on every
   * ordinary send and on every non-chord route.
   */
  onSubmit: (message: string, attachments?: FileAttachment[], skillSlugs?: string[], customSlashCommandId?: CustomSlashCommandId, midStreamOverride?: 'steer' | 'queue') => void
  /** Callback to stop processing. Pass silent=true to skip "Response interrupted" message */
  onStop?: (silent?: boolean) => void
  /** External ref for the input */
  inputRef?: React.RefObject<RichTextInputHandle>
  /** Current model ID */
  currentModel: string
  /** Callback when model changes (includes connection slug for proper persistence) */
  onModelChange: (model: string, connection?: string) => void
  // Thinking level (session-level setting)
  /** Current thinking level ('off', 'think', 'max') */
  thinkingLevel?: ThinkingLevel
  /** Callback when thinking level changes */
  onThinkingLevelChange?: (level: ThinkingLevel) => void
  // Advanced options
  permissionMode?: PermissionMode
  onPermissionModeChange?: (mode: PermissionMode) => void
  /** Enabled permission modes for Shift+Tab cycling (min 2 modes) */
  enabledModes?: PermissionMode[]
  // Controlled input value (for persisting across mode switches and conversation changes)
  /** Current input value - if provided, component becomes controlled */
  inputValue?: string
  /** Callback when input value changes */
  onInputChange?: (value: string) => void
  /** Persisted attachment draft for this session (seeds local state on session switch) */
  attachmentsValue?: FileAttachment[]
  /** Callback when attachment list changes (add, remove, clear on send) */
  onAttachmentsChange?: (attachments: FileAttachment[]) => void
  /** When true, removes container styling (shadow, bg, rounded) - used when wrapped by InputContainer */
  unstyled?: boolean
  /** Callback when component height changes (for external animation sync) */
  onHeightChange?: (height: number) => void
  /** Callback when focus state changes */
  onFocusChange?: (focused: boolean) => void
  // Source selection
  /** Available sources (enabled only) */
  sources?: SafeCapabilitySummary[]
  /** Currently enabled source slugs for this session */
  enabledSourceSlugs?: string[]
  /** Callback when source selection changes */
  onSourcesChange?: (slugs: string[]) => void
  // Skill selection (for @mentions)
  /** Available skills for @mention autocomplete */
  skills?: SafeCapabilitySummary[]
  // Label selection (for #labels)
  /** Available labels for #label autocomplete */
  labels?: LabelConfig[]
  /** Currently applied session labels */
  sessionLabels?: string[]
  /** Callback when a label is added via # menu */
  onLabelAdd?: (labelId: string) => void
  /** Workspace ID for loading skill icons */
  workspaceId?: string
  /** Current working directory path */
  workingDirectory?: string
  /** Callback when working directory changes */
  onWorkingDirectoryChange?: (project: IssuedProjectHandle) => void
  /** Reset the backend-owned project selection to the managed session cwd. */
  onResetToSession?: () => void
  /** Session ID for scoping events like approve-plan */
  sessionId?: string
  /** Current session status of the session (for # menu state selection) */
  currentSessionStatus?: string
  /** Disable send action (for tutorial guidance) */
  disableSend?: boolean; /** F1.481 (3): the queue holds a row the host will not steer (`isUnsteerableQueueRow`) */ queueHoldsUnsteerableRow?: boolean
  /** Whether the session is empty (no messages yet) - affects context badge prominence */
  isEmptySession?: boolean
  /** Context status for showing compaction indicator and token usage */
  contextStatus?: {
    /** True when SDK is actively compacting the conversation */
    isCompacting?: boolean
    /** Input tokens used so far in this session */
    inputTokens?: number
    /** Model's context window size in tokens */
    contextWindow?: number
    autoCompactionThreshold?: number | null
    remainingBeforeAutoCompact?: number | null
    remainingWindow?: number | null
    contextWindowSource?: string
  }
  /** Follow-up annotations shown as context chips above the input */
  followUpItems?: FollowUpInputItem[]
  /** Callback when user clicks a follow-up chip body */
  onFollowUpClick?: (item: FollowUpInputItem, anchor?: { x: number; y: number }) => void
  /** Callback when user clicks the follow-up index badge */
  onFollowUpIndexClick?: (item: FollowUpInputItem) => void
  /**
   * Compact-footer layout. Used by EditPopover (popover embedding) and by
   * ChatPage in auto-compact / WebUI mobile mode. The popover case hides the
   * model picker; the auto-compact case opts the compact picker in via
   * `enableCompactModelPicker`.
   */
  compactMode?: boolean
  /**
   * When `compactMode` is true, render the compact (drawer-based) model
   * selector next to the permission-mode pill. Defaults to false so that
   * EditPopover (which has no use for a model picker) keeps its current
   * behavior.
   */
  enableCompactModelPicker?: boolean
  // Connection selection (hierarchical connection → model selector)
  /** Current LLM connection slug (locked after first message) */
  currentConnection?: string
  /** Callback when connection changes (only works when session is empty) */
  onConnectionChange?: (connectionSlug: string) => void
  /**
   * Read-only pre-switch carry answer; see `ConnectionRow.onPreviewSwitch`.
   *
   * P3.266 widened this from the bare plan to the plan AND its reason. It is one
   * object rather than two values because `planHistoryCarry` decides them
   * together, and a prop that could carry one without the other is a prop in
   * which the modal can explain a promise it is not making.
   */
  onPreviewConnectionChange?: (connectionSlug: string) => Promise<RuntimeSwitchPreviewAnswer | null>
  /** When true, the session's locked connection has been removed */
  connectionUnavailable?: boolean
  /**
   * True when the input is collapsed because the agent is processing in
   * compact mode and the user hasn't expanded it yet. Owned by
   * `InputContainer`; toggle back via `onRequestExpand`.
   */
  isCollapsedInCompact?: boolean
  /** Callback fired when the user clicks or hovers the collapsed-input strip. */
  onRequestExpand?: () => void
}

/**
 * FreeFormInput - Self-contained textarea input with attachments and controls
 *
 * Features:
 * - Auto-growing textarea
 * - File attachments via button or drag-drop
 * - Slash commands menu
 * - Model selector
 * - Active option badges
 */
export function FreeFormInput({
  onConsoleSnippetPaste,
  placeholder,
  disabled = false,
  isProcessing = false,
  onSubmit,
  onStop,
  inputRef: externalInputRef,
  currentModel,
  onModelChange,
  thinkingLevel = 'medium',
  onThinkingLevelChange,
  permissionMode = 'default',
  onPermissionModeChange,
  enabledModes = DEFAULT_CYCLABLE_PERMISSION_MODES,
  inputValue,
  onInputChange,
  attachmentsValue,
  onAttachmentsChange,
  unstyled = false,
  onHeightChange,
  onFocusChange,
  sources = [],
  enabledSourceSlugs = [],
  onSourcesChange,
  skills = [],
  labels = [],
  sessionLabels = [],
  onLabelAdd,
  workspaceId,
  workingDirectory,
  onWorkingDirectoryChange,
  onResetToSession,
  sessionId,
  currentSessionStatus,
  disableSend = false, queueHoldsUnsteerableRow = false,
  isEmptySession = false,
  contextStatus,
  followUpItems = [],
  onFollowUpClick,
  onFollowUpIndexClick,
  compactMode = false,
  enableCompactModelPicker = false,
  currentConnection,
  onConnectionChange,
  onPreviewConnectionChange,
  connectionUnavailable = false,
  isCollapsedInCompact = false,
  onRequestExpand,
}: FreeFormInputProps) {
  const { t } = useTranslation()
  const composerCapabilities = useComposerCapabilities()
  const actionRegistry = useActionRegistry()
  /**
   * P6.480 — the follow-up behaviour THIS connection resolves to, read off the
   * capability the composer already receives rather than re-derived from the
   * connection. `resolveComposerCapabilities` computes it once with
   * `resolveMidStreamBehavior`, and a second derivation here is how the hint
   * and the send end up disagreeing.
   */
  const midStreamDefault: 'steer' | 'queue' = composerCapabilities.submit.steer ? 'steer' : 'queue'

  /**
   * P6.946 — what the P6.480 chord will DO, shown where the user meets the send
   * key it sits beside.
   *
   * The two sentences (`chat.midStream.overrideSteer` / `overrideQueue`) shipped
   * with P6.480's renderer half and had no reader, so `lint:i18n:reachable` was
   * red on committed work. They belong on the send button's own tooltip rather
   * than in Settings: that tooltip already names the default behaviour and the
   * Enter that triggers it, and the chord is the third line of the same table.
   *
   * Null when the user has UNBOUND the action — the settings hint's own rule,
   * for the same reason its comment gives: printing a shortcut nobody can press
   * is worse than printing none.
   */
  const midStreamOverrideHotkey = actionRegistry.getHotkeyDisplay('chat.sendWithOtherFollowUp')

  // Default rotating placeholders for onboarding/empty state (i18n-aware). The keyboard tips are
  // left out in compact (touch) layouts, where they are noise (v0.15.0) — by KEY, see `composer-placeholders.ts`.
  const defaultPlaceholders = React.useMemo(
    () => defaultComposerPlaceholderKeys(compactMode).map(key => t(key, { key: cmdKey })),
    [t, compactMode],
  )

  const effectivePlaceholderProp = placeholder ?? defaultPlaceholders

  // Read connection default model, connections, and workspace info from context.
  // Uses optional variant so playground (no provider) doesn't crash.
  const appShellCtx = useOptionalAppShellContext()
  const llmConnections = appShellCtx?.llmConnections ?? []
  const workspaceDefaultConnection = appShellCtx?.workspaceDefaultLlmConnection
  const openFile = appShellCtx?.onOpenFile
  const openAgents = appShellCtx?.openAgents
  const openAutomations = appShellCtx?.openAutomations

  // QK5 — the ultracode toggle, read from and written to the session-options map
  // this component's own `sessionId` already keys. Not threaded as props through
  // `ChatDisplay` for the reason `llmConnections` above is not: the composer is
  // where the control lives, and the context already carries a per-session map
  // with a writer beside it. `?? false` also covers the playground, which has no
  // provider at all.
  const ultracodeEnabled = sessionId
    ? (appShellCtx?.sessionOptions.get(sessionId)?.ultracode ?? false)
    : false
  const handleUltracodeChange = React.useCallback((next: boolean) => {
    if (!sessionId) return
    appShellCtx?.onSessionOptionsChange(sessionId, { ultracode: next })
  }, [appShellCtx, sessionId])
  const openContext = appShellCtx?.openContext
  const openExport = appShellCtx?.openExport
  const openUsage = appShellCtx?.openUsage
  // P6.278 — present only in the desktop composer; see the context field.
  const openWorkingTreeDiff = appShellCtx?.openWorkingTreeDiff
  const runShellCommand = appShellCtx?.runShellCommand
  const customSlashCommands = appShellCtx?.customSlashCommands ?? EMPTY_CUSTOM_SLASH_COMMANDS

  // Derive connectionDefaultModel per-session from the effective connection.
  // Only non-null for compat providers (custom endpoints with fixed models).
  // Standard providers (anthropic, pi) → null → normal model picker.
  const connectionDefaultModel = React.useMemo(() => {
    const effectiveSlug = resolveEffectiveConnectionSlug(currentConnection, workspaceDefaultConnection, llmConnections)
    const conn = llmConnections.find(c => c.slug === effectiveSlug)
    if (!conn) return null
    if (!isCompatProvider(conn.providerType)) return null
    // Allow model switching when connection has multiple models
    if (conn.models && conn.models.length > 1) return null
    return conn.defaultModel ?? null
  }, [currentConnection, workspaceDefaultConnection, llmConnections])

  // How the MODEL list renders. The integration is no longer one of the
  // outcomes — it has its own row above the list ({@link ConnectionRow}), so
  // the #727 precedence trap between `switcher` and `locked-single` has no
  // branches left to order.
  const pickerMode = derivePickerMode({
    connectionUnavailable,
    connectionDefaultModel,
  })

  // Compute available models from the effective connection.
  // All connections have models populated by backfillAllConnectionModels().
  const availableModels = React.useMemo(() => {
    // Connection removed — don't fall through to another connection's models
    if (connectionUnavailable) return []

    // Determine effective connection using the canonical fallback chain
    const effectiveSlug = resolveEffectiveConnectionSlug(currentConnection, workspaceDefaultConnection, llmConnections)
    const connection = llmConnections.find(c => c.slug === effectiveSlug)

    if (!connection) {
      return ANTHROPIC_MODELS // Safety net — shouldn't happen
    }

    return connection.models || ANTHROPIC_MODELS
  }, [llmConnections, currentConnection, workspaceDefaultConnection, connectionUnavailable])

  // Disable thinking selector when the current model explicitly doesn't support it
  const thinkingDisabled = React.useMemo(() => {
    const model = availableModels.find(m => typeof m !== 'string' && m.id === currentModel)
    return typeof model !== 'string' && model?.supportsThinking === false
  }, [availableModels, currentModel])

  // Get display name for current model (full name, not short name)
  const currentModelDisplayName = React.useMemo(() => {
    const modelToDisplay = connectionDefaultModel ?? currentModel
    const model = availableModels.find(m =>
      typeof m === 'string' ? m === modelToDisplay : m.id === modelToDisplay
    )
    if (!model) {
      // Fallback: use helper function to format unknown model IDs nicely
      return stripPiPrefixForDisplay(getModelDisplayName(modelToDisplay))
    }
    if (typeof model === 'string') return stripPiPrefixForDisplay(model)
    // Defensive: partial entries (custom-endpoint user-config or vision-toggle
    // promotions) may lack `name`. Fall back to the id so the trigger button
    // never goes blank.
    return model.name ?? stripPiPrefixForDisplay(model.id)
  }, [availableModels, currentModel, connectionDefaultModel])

  // Group connections by provider type for hierarchical dropdown.
  // Each provider (Anthropic, Pi) can have multiple connections (API Key, OAuth, etc.)
  const connectionsByProvider = React.useMemo(
    () => groupConnectionsByProvider(llmConnections),
    [llmConnections],
  )

  // Find current connection details for display
  const currentConnectionDetails = React.useMemo(() => {
    if (!currentConnection) return null
    return llmConnections.find(c => c.slug === currentConnection) ?? null
  }, [llmConnections, currentConnection])

  // Effective connection: canonical fallback chain (session → workspace default → global default → first)
  const effectiveConnection = resolveEffectiveConnectionSlug(currentConnection, workspaceDefaultConnection, llmConnections)

  // Effective connection details (with fallbacks) for model list
  // Unlike currentConnectionDetails which is null when no explicit connection is set,
  // this resolves to the actual connection being used (including workspace default)
  const effectiveConnectionDetails = React.useMemo(() => {
    if (!effectiveConnection) return null
    return llmConnections.find(c => c.slug === effectiveConnection) ?? null
  }, [llmConnections, effectiveConnection])


  // Access sessionStatuses and onSessionStatusChange from context for the # menu state picker
  const sessionStatuses = appShellCtx?.sessionStatuses ?? []
  const onSessionStatusChange = appShellCtx?.onSessionStatusChange
  // Capability qualification uses the immutable backend Workspace ID.
  const workspaceQualificationId = workspaceId

  // Read panel focus state (multi-panel unfocused styling) and the workspace's default mode (F1.1052) from context
  const appShellContext = useOptionalAppShellContext()
  const isFocusedPanel = appShellContext?.isFocusedPanel ?? true

  // Shuffle placeholder order once per mount so each session feels fresh.
  // UB14.32 — v0.15.0 wires a compact-mode `placeholderOptions` filter back here for CALLER lists; it is
  // not taken, for the reasons below (the defaults' key-based half is taken above).
  // F1.93 / D1.400 — a compact-mode `placeholderOptions` filter used to sit
  // here and it was DEAD: it computed a filtered array that no render path
  // read (`effectivePlaceholderProp` below is built from the raw prop).
  // Wiring it would not have earned its place either, and both reasons are
  // measured: it keyed on `placeholder` rather than on
  // `effectivePlaceholderProp`, so a compact embedding that passes NO
  // placeholder — exactly what the `/btw` panel did before D1.392 — fell
  // through to the default rotation with the desktop guidance still in it;
  // and its needles were ENGLISH substrings (shift + tab, toggle the
  // sidebar, focus mode), inert under every other locale. THE RULE THAT
  // REPLACED IT: a compact composer NAMES ITS OWN placeholder, and the panel
  // does (`SIDE_QUESTION_PLACEHOLDER_KEYS`). A compact embedding that passes
  // none gets the desktop rotation on purpose — if that is wrong for it, give
  // it its own strings rather than a filter guessing from rendered text.
  // Pinned by `input/__tests__/compact-placeholder.test.ts`.

  // Hide placeholder entirely when panel is unfocused in multi-panel layout
  const shuffledPlaceholder = React.useMemo(
    () => Array.isArray(effectivePlaceholderProp) ? shuffleArray(effectivePlaceholderProp) : effectivePlaceholderProp,
    [] // eslint-disable-line react-hooks/exhaustive-deps -- intentionally shuffle only on mount
  )
  const effectivePlaceholder = isFocusedPanel ? shuffledPlaceholder : ''

  // Performance optimization: Always use internal state for typing to avoid parent re-renders
  // Sync FROM parent on mount/change (for restoring drafts)
  // Sync TO parent on blur/submit (debounced persistence)
  const [input, setInput] = React.useState(() => coerceInputText(inputValue))
  const [attachments, setAttachments] = React.useState<FileAttachment[]>(attachmentsValue ?? [])

  // Ref to track current attachments for use in event handlers (avoids stale closure issues)
  const attachmentsRef = React.useRef<FileAttachment[]>([])
  React.useEffect(() => {
    attachmentsRef.current = attachments
  }, [attachments])

  // UB4.14 (v0.15.1) — attachments must fit in one message to the connected server, or the send
  // drops the connection ("Connection lost"); the server advertises its limit (message-limits.ts).
  const transportState = useTransportConnectionState()
  const maxMessageBytesRef = React.useRef(DEFAULT_MAX_MESSAGE_BYTES)
  React.useEffect(() => {
    maxMessageBytesRef.current = maxMessageBytesOf(transportState?.maxMessageBytes)
  }, [transportState?.maxMessageBytes])

  const showAttachmentSizeProblem = React.useCallback((problem: AttachmentSizeProblem) => {
    const { title, description } = attachmentSizeToast(problem, t)
    toast.error(title, { description })
  }, [t])

  /** Refuse a file that can never be sent, before reading it (reading a huge file can freeze the window). */
  const refuseOversizedAttachment = React.useCallback((attachment: AttachmentSizeInput): boolean => {
    const problem = oversizedAttachment(attachment, maxMessageBytesRef.current)
    if (!problem) return false
    showAttachmentSizeProblem(problem)
    return true
  }, [showAttachmentSizeProblem])

  // Seed from parent when `attachmentsValue` changes (e.g., switching sessions).
  // `skipPersistRef` tells the save effect below that the next `attachments` change
  // is a prop-driven seed, not user intent — otherwise we'd echo the seed back to
  // the parent and risk persisting A's attachments under B's sessionId.
  const attachmentsRefsKey = React.useMemo(() => {
    if (!attachmentsValue) return ''
    return attachmentsValue.map(a => a.path).join('|')
  }, [attachmentsValue])
  const prevAttachmentsRefsKey = React.useRef(attachmentsRefsKey)
  const skipPersistRef = React.useRef(true) // treat initial mount as a prop-seed
  React.useEffect(() => {
    if (attachmentsValue === undefined) return
    if (attachmentsRefsKey === prevAttachmentsRefsKey.current) return
    prevAttachmentsRefsKey.current = attachmentsRefsKey
    skipPersistRef.current = true
    setAttachments(attachmentsValue)
  }, [attachmentsValue, attachmentsRefsKey])

  // Persist user-initiated attachment changes back to the parent. The parent stores
  // refs (path + name) and debounces the disk write, so we fire eagerly on every
  // change — add/remove/send-clear.
  const onAttachmentsChangeRef = React.useRef(onAttachmentsChange)
  onAttachmentsChangeRef.current = onAttachmentsChange
  React.useEffect(() => {
    if (skipPersistRef.current) {
      skipPersistRef.current = false
      return
    }
    onAttachmentsChangeRef.current?.(attachments)
  }, [attachments])

  // Optimistic state for source selection - updates UI immediately before IPC round-trip completes
  const [optimisticSourceSlugs, setOptimisticSourceSlugs] = React.useState(enabledSourceSlugs)

  // Sync from prop when server state changes (reconciles after IPC or on external updates)
  // Use content comparison (not reference) to avoid infinite loops with empty arrays
  const prevEnabledSourceSlugsRef = React.useRef(enabledSourceSlugs)
  React.useEffect(() => {
    const prev = prevEnabledSourceSlugsRef.current
    const changed = enabledSourceSlugs.length !== prev.length ||
      enabledSourceSlugs.some((slug, i) => slug !== prev[i])

    if (changed) {
      setOptimisticSourceSlugs(enabledSourceSlugs)
      prevEnabledSourceSlugsRef.current = enabledSourceSlugs
    }
  }, [enabledSourceSlugs])

  // Both directions of the draft ↔ parent sync live in `draft-parent-sync.ts`,
  // where their ordering is unit-testable (`bun test` has no DOM, so a rendered
  // component cannot exercise these effects). The notifier is passed per call so
  // the unmount flush keeps using the callback from the render that scheduled
  // it — its identity is bound to the session id in `ChatPage`.
  const draftSyncRef = React.useRef<DraftParentSync | null>(null)
  if (!draftSyncRef.current) {
    draftSyncRef.current = createDraftParentSync(coerceInputText(inputValue))
  }
  const draftSync = draftSyncRef.current

  // Sync from parent when inputValue changes externally (e.g., switching
  // sessions, a deep-link prefill, or Stop putting the in-flight prompt back).
  // The decision AND the re-seed both live in `seedComposerFromParent`, so the
  // re-seed cannot be deleted without a test going red (L11); it also cancels
  // any pending debounced write, so a keystroke scheduled just before the seed
  // cannot land after it and leave the visible composer and the persisted draft
  // disagreeing.
  React.useEffect(() => {
    seedComposerFromParent(draftSync, inputValue, setInput)
  }, [inputValue, draftSync])

  // Debounced sync to parent (saves draft without blocking typing)
  const syncToParent = React.useCallback((value: string) => {
    draftSync.syncToParent(value, onInputChange)
  }, [draftSync, onInputChange])

  // Sync immediately on unmount to preserve input across mode switches
  // Also cleanup any pending debounced sync
  const inputRef = React.useRef(input)
  inputRef.current = input // Keep ref in sync with state

  React.useEffect(() => {
    return () => {
      // Cancel the pending debounced sync, then immediately sync the current
      // value to the parent. This preserves input when switching to structured
      // input (e.g., permission request).
      draftSync.flushOnUnmount(inputRef.current, onInputChange)
    }
  }, [draftSync, onInputChange])

  const [isDraggingOver, setIsDraggingOver] = React.useState(false)
  const [loadingCount, setLoadingCount] = React.useState(0)
  const [sourceDropdownOpen, setSourceDropdownOpen] = React.useState(false)
  const [isFocused, setIsFocused] = React.useState(false)
  const [inputMaxHeight, setInputMaxHeight] = React.useState(540)
  const [modelDropdownOpen, setModelDropdownOpen] = React.useState(false)

  // Input settings (loaded from config)
  const [autoCapitalisation, setAutoCapitalisation] = React.useState(true)
  const [sendMessageKey, setSendMessageKey] = React.useState<'enter' | 'cmd-enter'>('enter')
  const [spellCheck, setSpellCheck] = React.useState(false)
  const [isShellCommandRunning, setIsShellCommandRunning] = React.useState(false)

  // Load input settings on mount
  React.useEffect(() => {
    const loadInputSettings = async () => {
      if (!window.electronAPI) return
      try {
        const [autoCapEnabled, sendKey, spellCheckEnabled] = await Promise.all([
          window.electronAPI.getAutoCapitalisation(),
          window.electronAPI.getSendMessageKey(),
          window.electronAPI.getSpellCheck(),
        ])
        setAutoCapitalisation(autoCapEnabled)
        setSendMessageKey(sendKey ?? 'enter')
        setSpellCheck(spellCheckEnabled)
      } catch (error) {
        console.error('Failed to load input settings:', error)
      }
    }
    loadInputSettings()
  }, [])

  // Double-Esc interrupt: show warning overlay on first Esc, interrupt on second
  const { showEscapeOverlay } = useEscapeInterrupt()

  // Calculate max height: min(66% of window height, 540px)
  React.useEffect(() => {
    const updateMaxHeight = () => {
      const maxFromWindow = Math.floor(window.innerHeight * 0.66)
      setInputMaxHeight(Math.min(maxFromWindow, 540))
    }
    updateMaxHeight()
    window.addEventListener('resize', updateMaxHeight)
    return () => window.removeEventListener('resize', updateMaxHeight)
  }, [])

  const dragCounterRef = React.useRef(0)
  const containerRef = React.useRef<HTMLDivElement>(null)
  const sourceButtonRef = React.useRef<HTMLButtonElement>(null)
  const fileInputRef = React.useRef<HTMLInputElement>(null)

  // Merge refs for RichTextInput
  const internalInputRef = React.useRef<RichTextInputHandle>(null)
  const richInputRef = externalInputRef || internalInputRef

  // Track last caret position for focus restoration (e.g., after permission mode popover closes)
  const lastCaretPositionRef = React.useRef<number | null>(null)

  // Listen for nessy:insert-text events (generic mechanism for inserting text into input)
  // Used by components that want to pre-fill the input with text
  React.useEffect(() => {
    const handleInsertText = (e: CustomEvent<{ text: string; sessionId?: string }>) => {
      const targetSessionId = e.detail?.sessionId
      if (!shouldHandleScopedInputEvent({ sessionId, isFocusedPanel, targetSessionId })) return

      const text = coerceInputText(e.detail?.text)
      setInput(text)
      syncToParent(text)
      // Focus the input after inserting
      setTimeout(() => {
        richInputRef.current?.focus()
        // Move cursor to end
        richInputRef.current?.setSelectionRange(text.length, text.length)
      }, 0)
    }

    window.addEventListener('nessy:insert-text', handleInsertText as EventListener)
    return () => window.removeEventListener('nessy:insert-text', handleInsertText as EventListener)
  }, [sessionId, isFocusedPanel, syncToParent, richInputRef])

  const clearInputDraft = React.useCallback(() => {
    setInput('')
    draftSync.markCleared(onInputChange)
  }, [draftSync, onInputChange])

  /**
   * P2.447 — the state behind double-Esc. See `./double-escape` for the
   * mechanism decision (a component behaviour, NOT a rebindable hotkey) and for
   * why this history exists at all.
   *
   * Both live in refs rather than state: neither renders anything, and an arm
   * that re-rendered the composer on every Escape press would be a visible cost
   * for an invisible fact.
   */
  const escapeArmedAtRef = React.useRef<number | null>(null)
  const inputHistoryRef = React.useRef<string[]>([])
  React.useEffect(() => {
    // This component is NOT remounted on a session switch (see the
    // `stopRequestedFor` note below for the same hazard), so without this drop
    // the draft cleared in session A would be recallable with `Up` in B — and a
    // half-typed prompt reappearing in someone else's conversation is a leak,
    // not a convenience. A pending arm is dropped for the same reason: the
    // second press belongs to the session that saw the first.
    inputHistoryRef.current = []
    escapeArmedAtRef.current = null
  }, [sessionId])

  /**
   * `checkpointing.md#rewind-and-summarize`: "If the prompt input contains text,
   * double `Esc` clears it instead of opening the menu. The cleared text is
   * saved to your input history."
   *
   * Attachments are deliberately LEFT ALONE. The page's branch is about text
   * ("if the prompt input contains text"), the history can only hold text, and
   * dropping attachments here would destroy something `Up` cannot bring back —
   * a silent loss dressed as a documented clear.
   */
  const clearDraftIntoInputHistory = React.useCallback(() => {
    inputHistoryRef.current = pushComposerInputHistory(inputHistoryRef.current, inputRef.current)
    clearInputDraft()
  }, [clearInputDraft])

  /**
   * `Up` recalls the cleared text — the third of the page's three behaviours,
   * and the one that makes the clear branch a clear rather than a delete.
   * Returns whether the key was consumed, so the caller knows whether to leave
   * `Up` to caret movement.
   */
  const recallClearedDraft = React.useCallback((): boolean => {
    const recalled = recallComposerInputHistory({
      entries: inputHistoryRef.current,
      draftText: inputRef.current,
    })
    if (recalled === null) return false

    setInput(recalled)
    syncToParent(recalled)
    requestAnimationFrame(() => {
      richInputRef.current?.focus()
      richInputRef.current?.setSelectionRange(recalled.length, recalled.length)
    })
    return true
  }, [syncToParent, richInputRef])

  const handleToggleModelVision = useModelVisionToggle()

  const consumeInputDraftSnapshot = React.useCallback((): string => {
    const snapshot = input.trim()
    clearInputDraft()
    return snapshot
  }, [input, clearInputDraft])

  type PlanApprovalEventDetail = {
    sessionId?: string
    planHandleId?: string
    includeDraftInput?: boolean
    source?: string
  }

  // Listen for nessy:approve-plan events (used by ResponseCard's Accept Plan button)
  // This disables safe mode AND submits the message in one action
  // Only process events for this session (sessionId must match)
  React.useEffect(() => {
    const handleApprovePlan = (e: CustomEvent<PlanApprovalEventDetail>) => {
      // Only handle if this event is for our session
      if (e.detail?.sessionId && e.detail.sessionId !== sessionId) {
        return
      }

      const shouldIncludeDraft = e.detail?.includeDraftInput !== false
      const draftInput = shouldIncludeDraft ? consumeInputDraftSnapshot() : ''
      const text = buildPlanApprovalMessage({
        draftInput,
      })

      // F1.106 — explore lands in `default` (the page's "Yes, manually approve edits"), never in bypass,
      // which is entered only through its own dialog; every other mode is left alone. See planApprovalLandingMode.
      const landingMode = planApprovalLandingMode(permissionMode)
      if (landingMode) {
        onPermissionModeChange?.(landingMode)
      }

      onSubmit(text, undefined)
    }

    window.addEventListener('nessy:approve-plan', handleApprovePlan as EventListener)
    return () => window.removeEventListener('nessy:approve-plan', handleApprovePlan as EventListener)
  }, [sessionId, permissionMode, onPermissionModeChange, onSubmit, consumeInputDraftSnapshot])

  // F1.241 — live completion and reload recovery share ONE persisted-state dispatcher
  // (`pending-plan-dispatch.ts`, ported from craft-agents-oss v0.13.4, Apache-2.0). A
  // compaction-complete event, the session going idle and a mount are only WAKEUPS: what
  // authorizes the send is the readiness the host persists on a MANUAL compaction plus the
  // host's claim (`markPendingPlanExecutionDispatched` → `true` for exactly one caller,
  // refused while the session is busy). Before, it left from two paths with no shared claim.
  // Declared before the approval listener, so its listener exists before `/compact` is sent.
  const processingRef = React.useRef(isProcessing)
  processingRef.current = isProcessing
  const requestPendingPlanRef = React.useRef<(() => void) | null>(null)

  React.useEffect(() => {
    if (!sessionId || isRendererMintedSessionId(sessionId)) return // F1.88 — no host state behind a minted id
    const isExpectedReconnectError = (error: unknown): boolean => {
      const message = error instanceof Error ? error.message : String(error)
      return message.includes('Connection closed')
        || message.includes('Client disconnected')
        || message.includes('transport')
        || message.includes('socket')
    }
    const dispatcher = createPendingPlanDispatcher({
      isBusy: () => processingRef.current,
      load: () => window.electronAPI.getPendingPlanExecution(sessionId),
      claim: () => window.electronAPI.sessionCommand(sessionId, { type: 'markPendingPlanExecutionDispatched' }),
      submit: pending => onSubmit(buildPlanApprovalMessage({ draftInput: pending.draftInputSnapshot }), undefined),
      clear: () => window.electronAPI.sessionCommand(sessionId, { type: 'clearPendingPlanExecution' }),
    })
    const request = () => {
      void dispatcher.request().catch(error => {
        if (!isExpectedReconnectError(error)) {
          console.error('[FreeFormInput] Failed to resume pending plan execution:', error)
        }
      })
    }
    const handleCompactionComplete = (event: Event) => {
      if ((event as CustomEvent<{ sessionId?: string }>).detail?.sessionId === sessionId) request()
    }
    requestPendingPlanRef.current = request
    window.addEventListener('nessy:compaction-complete', handleCompactionComplete)
    // A mount is a wakeup too: the page reloaded (CMD+R) after the compaction finished.
    request()
    return () => {
      window.removeEventListener('nessy:compaction-complete', handleCompactionComplete)
      if (requestPendingPlanRef.current === request) requestPendingPlanRef.current = null
      dispatcher.dispose()
    }
  }, [sessionId, onSubmit])

  // The compaction's own info arrives while its `/compact` turn is still running, when the host
  // refuses the claim; the idle transition that follows is the wakeup that actually sends.
  React.useEffect(() => {
    if (!isProcessing) requestPendingPlanRef.current?.()
  }, [isProcessing, sessionId])

  // Listen for nessy:approve-plan-with-compact events (Accept & Compact option)
  // This compacts the conversation first; the plan itself is sent by the dispatcher above.
  // The pending state is persisted to survive page reloads (CMD+R).
  React.useEffect(() => {
    let cancelCompactionWait: (() => void) | undefined

    const handleApprovePlanWithCompact = async (e: CustomEvent<PlanApprovalEventDetail>) => {
      // Only handle if this event is for our session
      if (e.detail?.sessionId && e.detail.sessionId !== sessionId) {
        return
      }

      const planHandleId = e.detail?.planHandleId
      if (!planHandleId) return
      const shouldIncludeDraft = e.detail?.includeDraftInput !== false
      const draftInputSnapshot = shouldIncludeDraft ? consumeInputDraftSnapshot() : ''

      // F1.106 — the same landing as the plain Accept (explore → default, never bypass).
      const landingMode = planApprovalLandingMode(permissionMode)
      if (landingMode) onPermissionModeChange?.(landingMode)

      // Persist the pending plan execution state BEFORE sending /compact.
      // This allows reload recovery if CMD+R happens during compaction.
      if (sessionId) {
        await window.electronAPI.sessionCommand(sessionId, {
          type: 'setPendingPlanExecution',
          planHandleId,
          draftInputSnapshot,
        })
      }

      // Send /compact to trigger compaction. The host keeps the pending plan across this one
      // message (every other message clears it) and marks it ready on its MANUAL compaction.
      onSubmit('/compact', undefined)

      // Wait for the compaction, but never forever: on a wait that does not settle the user gets a
      // stated failure and the plan stays approvable, instead of a composer that silently never
      // executes the plan. F1.856 — only while the host still has it awaiting its compaction.
      const clearPendingPlanExecution = async () => {
        if (!sessionId) return
        await window.electronAPI.sessionCommand(sessionId, { type: 'clearPendingPlanExecution' })
      }

      cancelCompactionWait?.()
      cancelCompactionWait = awaitCompactionComplete({
        sessionId: sessionId ?? '',
        // A plan already sent (a compaction refused as nothing to compact is done) or cleared did not fail.
        isStillAwaiting: async () => !!sessionId && (await window.electronAPI.getPendingPlanExecution(sessionId))?.awaitingCompaction === true,
        onComplete: () => {
          cancelCompactionWait = undefined
          // A wakeup, never a send (F1.241): the dispatcher reads the persisted readiness and
          // wins the host's claim first. The renderer cannot tell an automatic compaction from
          // the manual one by this event, so an automatic one settles this wait too; the plan
          // then waits for the manual one's readiness, without this wait's timeout (residue).
          requestPendingPlanRef.current?.()
        },
        onTimeout: async () => {
          cancelCompactionWait = undefined
          toast.error(t('toast.planCompactionUnfinished'), {
            description: t('toast.planCompactionUnfinishedDesc'),
            duration: 10000,
          })
          // Clearing the pending state matters as much as the toast: while it is
          // set with awaitingCompaction, even a reload refuses to run the plan.
          await clearPendingPlanExecution()
        },
      })
    }

    window.addEventListener('nessy:approve-plan-with-compact', handleApprovePlanWithCompact as unknown as EventListener)
    return () => {
      window.removeEventListener('nessy:approve-plan-with-compact', handleApprovePlanWithCompact as unknown as EventListener)
      // The inner wait used to outlive the component: an unmount or a session
      // switch left the listener and its callbacks attached to a dead composer.
      cancelCompactionWait?.()
      cancelCompactionWait = undefined
    }
  }, [sessionId, permissionMode, onPermissionModeChange, onSubmit, consumeInputDraftSnapshot, t])

  // Reload recovery is the dispatcher above: its mount-time request reads the persisted state
  // (awaitingCompaction = false after a finished manual compaction) and sends through the same
  // claim, so a reload during or after the compaction cannot send the plan a second time.
  // What this block used to be — a second sender with a local `hasExecuted` flag, a 100 ms
  // guess that the host had marked the plan ready, and a claim that could not refuse — is gone.
  //
  // Measured while porting (F1.241, `pending-plan-claim.test.ts`): that sender was dead in this
  // fork anyway. The host cleared the pending record on the `/compact` message itself and every
  // session write erased it from the session header, so the recovery read always came back
  // empty and Accept & Compact only ever worked through the live, claim-less callback.
  // D09 (upstream-refresh, 2026-09-23) had it partial; this measurement is its missing half.

  // Listen for nessy:focus-input events (restore focus after popover/dropdown closes)
  React.useEffect(() => {
    const handleFocusInput = (e: Event) => {
      const detail = (e as CustomEvent<{ sessionId?: string }>).detail
      const targetSessionId = detail?.sessionId
      if (!shouldHandleScopedInputEvent({ sessionId, isFocusedPanel, targetSessionId })) return

      if (targetSessionId) {
        clearPendingFocusForSession(targetSessionId)
      }

      richInputRef.current?.focus()
      // Restore caret position if saved, then clear it (one-shot)
      if (lastCaretPositionRef.current !== null) {
        richInputRef.current?.setSelectionRange(
          lastCaretPositionRef.current,
          lastCaretPositionRef.current
        )
        lastCaretPositionRef.current = null
      }
    }

    window.addEventListener('nessy:focus-input', handleFocusInput)
    return () => window.removeEventListener('nessy:focus-input', handleFocusInput)
  }, [sessionId, isFocusedPanel, richInputRef])

  // Recover queued focus requests after session switch/mount races.
  React.useEffect(() => {
    if (!consumePendingFocusForSession(sessionId)) return

    setTimeout(() => {
      richInputRef.current?.focus()
    }, 0)
  }, [sessionId, richInputRef])

  // Get the next available number for a pasted file prefix (e.g., pasted-image-1, pasted-image-2)
  const getNextPastedNumber = (
    prefix: 'image' | 'text' | 'file',
    existingAttachments: FileAttachment[]
  ): number => {
    const pattern = new RegExp(`^pasted-${prefix}-(\\d+)\\.`)
    let maxNum = 0
    for (const att of existingAttachments) {
      const match = att.name.match(pattern)
      if (match) {
        maxNum = Math.max(maxNum, parseInt(match[1], 10))
      }
    }
    return maxNum + 1
  }

  // Listen for nessy:paste-files events (for global paste when input not focused)
  React.useEffect(() => {
    const handlePasteFiles = async (e: CustomEvent<{ files: File[]; sessionId?: string }>) => {
      if (disabled) return

      const targetSessionId = e.detail?.sessionId
      if (!shouldHandleScopedInputEvent({ sessionId, isFocusedPanel, targetSessionId })) return

      const { files } = e.detail
      if (!files || files.length === 0) return

      setLoadingCount(prev => prev + files.length)

      // Pre-assign sequential names using ref to avoid race conditions
      let nextImageNum = getNextPastedNumber('image', attachmentsRef.current)
      const fileNames: string[] = files.map(file => {
        if (!file.name || file.name === 'image.png' || file.name === 'image.jpg' || file.name === 'blob') {
          const ext = file.type.split('/')[1] || 'png'
          return `pasted-image-${nextImageNum++}.${ext}`
        }
        return file.name
      })

      for (let i = 0; i < files.length; i++) {
        if (refuseOversizedAttachment(attachmentSizeInputOf(files[i], fileNames[i]))) {
          setLoadingCount(prev => prev - 1)
          continue
        }
        try {
          const attachment = await readFileAsAttachment(files[i], fileNames[i])
          if (attachment) {
            setAttachments(prev => [...prev, attachment])
          }
        } catch (error) {
          console.error('[FreeFormInput] Failed to process pasted file:', error)
        }
        setLoadingCount(prev => prev - 1)
      }

      // Focus the input after adding attachments
      richInputRef.current?.focus()
    }

    window.addEventListener('nessy:paste-files', handlePasteFiles as unknown as EventListener)
    return () => window.removeEventListener('nessy:paste-files', handlePasteFiles as unknown as EventListener)
  }, [disabled, sessionId, isFocusedPanel, richInputRef, refuseOversizedAttachment])

  const permissionModeList = React.useMemo(
    () => resolveComposerPermissionModeList(composerCapabilities, t),
    [composerCapabilities, t],
  )
  const permissionModeDisplays = permissionModeList.modes
  // P2.56 — what the PICKER offers, which is the runtime's list narrowed by the
  // workspace's `cyclablePermissionModes` exactly as SHIFT+TAB narrows it
  // (`AppShell.tsx`'s `chat.cyclePermissionMode`). The `enabledModes` prop was
  // declared here and never read, so route 1 was inert on the click path.
  // Deliberately NOT used for `visiblePermissionModes` below: see
  // `applyWorkspaceCycleToComposerModes` for why the mode the session is already
  // in must not be re-derived from a menu filter.
  const permissionModeMenuDisplays = React.useMemo(
    () => applyWorkspaceCycleToComposerModes(permissionModeDisplays, enabledModes).map(withPermissionModeMenuDecorations(appShellContext?.defaultPermissionMode)),
    [permissionModeDisplays, enabledModes, appShellContext?.defaultPermissionMode], // F1.1052: badges and digits of the rows the menu RENDERS
  )
  // The active runtime's shared caveat, rendered ONCE as the picker's footer rather than repeated under all six modes.
  // Every local runtime draws one (UB12.48): Pi and Claude P6.492's resume sentence, codex its clause plus that sentence.
  // `undefined` only on Nestor Cloud or when no half translates (then no band); DEFAULT_COMPOSER_CAPABILITIES names 'pi'.
  const permissionModeRuntimeNote = permissionModeList.runtimeNote
  const visiblePermissionModes = React.useMemo(
    () => permissionModeDisplays.map(display => display.mode),
    [permissionModeDisplays],
  )
  // D1.327 — coerced against what the RUNTIME can honour, never against what
  // the picker offers. The effect below writes this value BACK to the host, so
  // coercing it with the picker's list made every `PICKER_HIDDEN_MODES` entry
  // unenterable: `dontAsk` fell to `coercePermissionModeForComposer`'s `default`
  // rung and the composer overwrote the session's real mode within a render of
  // mounting — measured on the packaged 1.40.0 on both the pi and the claude
  // card. A mode the runtime genuinely cannot honour is absent from this list
  // too and is still coerced, which is the effect's actual job.
  const supportedPermissionModes = React.useMemo(
    () => getSupportedComposerPermissionModes(composerCapabilities),
    [composerCapabilities],
  )
  const effectivePermissionMode = React.useMemo(
    () => coercePermissionModeForComposer(permissionMode, supportedPermissionModes),
    [permissionMode, supportedPermissionModes],
  )

  React.useEffect(() => {
    if (effectivePermissionMode !== permissionMode) {
      onPermissionModeChange?.(effectivePermissionMode)
    }
  }, [effectivePermissionMode, onPermissionModeChange, permissionMode])

  // Build active commands list for slash command menu
  const activeCommands = React.useMemo(() => {
    return [effectivePermissionMode as SlashCommandId]
  }, [effectivePermissionMode])

  const submitCustomSlashCommand = React.useCallback((commandId: SlashCommandId): boolean => {
    const submission = customSlashCommandMenuSubmission(customSlashCommands, commandId)
    if (!submission) return false

    onSubmit(submission.message, undefined, undefined, submission.customSlashCommandId)
    return true
  }, [customSlashCommands, onSubmit])

  const refreshUsage = React.useCallback(async () => {
    if (!sessionId) return
    await window.electronAPI.sessionCommand(sessionId, { type: 'refreshContextUsage' })
  }, [sessionId])

  // A command that takes an argument (`/subtask <task>`) prefills the composer
  // instead of submitting. The inline menu strips the typed `/text` AFTER
  // calling us, so the text is parked here and merged in by the caller below;
  // the button-triggered menu has no such step and reads the applied value.
  const pendingSlashPrefillRef = React.useRef<string | null>(null)

  // ── R36 `/btw` + `/recap` — answered OUT-OF-BAND in the SideQuestionOverlay.
  // The per-session exchange ring lives in side-question-ring.ts (renderer
  // state only, never persisted, never a session event —
  // interactive-mode.md:365); only the open flag is component state.
  const [sideQuestionOpen, setSideQuestionOpen] = React.useState(false)

  const openSideQuestionOverlay = React.useCallback(() => {
    if (!sessionId) return
    // `:374` — bare `/btw` reopens the overlay ON THE MOST RECENT exchange.
    updateSideQuestionRing(sessionId, viewNewest)
    setSideQuestionOpen(true)
  }, [sessionId])

  const askSideQuestion = React.useCallback((question: string) => {
    if (!sessionId) return
    const trimmed = question.trim()
    if (!trimmed) {
      // Defensive: an empty question is the reopen form, never a server call
      // (the server would answer with the typed `empty-question` error).
      openSideQuestionOverlay()
      return
    }
    const exchangeId = crypto.randomUUID()
    updateSideQuestionRing(sessionId, state =>
      appendExchange(state, { id: exchangeId, question: trimmed, timestamp: Date.now() }))
    setSideQuestionOpen(true)
    // Rides the widened SessionCommand union — NOT sendMessage — so it can
    // never become a transcript entry or a model turn, and is not blocked by
    // isProcessing (`:367` — available while Claude is working).
    void window.electronAPI.sessionCommand(sessionId, { type: 'sideQuestion', question: trimmed })
      .then(result => {
        const answer = result as SideQuestionResult | undefined
        updateSideQuestionRing(sessionId, state => resolveExchange(state, exchangeId, {
          text: answer?.success ? answer.text : undefined,
          error: answer?.success ? undefined : (answer?.error ?? 'unknown-error'),
        }))
      })
      .catch(error => {
        updateSideQuestionRing(sessionId, state => resolveExchange(state, exchangeId, {
          error: error instanceof Error ? error.message : String(error),
        }))
      })
  }, [sessionId, openSideQuestionOverlay])

  // R49 `/heapdump` (troubleshooting.md:39) — rides the SessionCommand union,
  // NOT sendMessage (the server guard rejects the typed form outright), and is
  // deliberately not gated on isProcessing: a dump must work on a wedged
  // session. NO new UI: the printed summary arrives as a persisted transcript
  // message; a hard failure (e.g. session-not-found) lands in the console the
  // same way the `!` shell path's does.
  const runHeapdump = React.useCallback(() => {
    if (!sessionId) return
    void window.electronAPI.sessionCommand(sessionId, { type: 'heapdump' })
      .then(result => {
        const dump = result as SessionHeapdumpResult | undefined
        if (dump && !dump.success) {
          console.error('[FreeFormInput] /heapdump failed:', dump.error ?? 'unknown-error')
        }
      })
      .catch(error => {
        console.error('[FreeFormInput] /heapdump failed:', error)
      })
  }, [sessionId])

  const requestRecap = React.useCallback(() => {
    if (!sessionId) return
    // `/recap` (interactive-mode.md:398-404) surfaces through the SAME overlay:
    // a recap is just an exchange whose question is the localized recap label
    // (R36 dispatch B choice — overlay over toast, for component reuse).
    const exchangeId = crypto.randomUUID()
    updateSideQuestionRing(sessionId, state =>
      appendExchange(state, { id: exchangeId, question: t('commands.recap.label'), timestamp: Date.now() }))
    setSideQuestionOpen(true)
    void window.electronAPI.sessionCommand(sessionId, { type: 'recap' })
      .then(result => {
        const recap = result as SessionRecapResult | undefined
        updateSideQuestionRing(sessionId, state => resolveExchange(state, exchangeId, {
          text: recap?.success ? recap.text : undefined,
          error: recap?.success ? undefined : (recap?.error ?? 'unknown-error'),
        }))
      })
      .catch(error => {
        updateSideQuestionRing(sessionId, state => resolveExchange(state, exchangeId, {
          error: error instanceof Error ? error.message : String(error),
        }))
      })
  }, [sessionId, t])

  // Handle slash command selection (mode/feature commands)
  const handleSlashCommand = React.useCallback((commandId: SlashCommandId) => {
    if (submitCustomSlashCommand(commandId)) {
      return
    }

    dispatchSlashCommandAction(commandId, {
      isProcessing,
      onPermissionModeChange,
      allowedPermissionModes: visiblePermissionModes,
      allowedCommandIds: composerCapabilities.slash.commandIds,
      excludedCommandIds: composerCapabilities.slash.excludedCommandIds,
      excludedCommandIdPrefixes: composerCapabilities.slash.excludedCommandIdPrefixes,
      contextUsageCapability: composerCapabilities.contextUsage,
      openModelSelector: () => setModelDropdownOpen(true),
      openAgents,
      openAutomations,
      openContext,
      openExport,
      openSideQuestionOverlay: sessionId ? openSideQuestionOverlay : undefined,
      requestRecap: sessionId ? requestRecap : undefined,
      openMemory: sessionId && workspaceId
        ? () => void window.electronAPI.openSessionArtifact({
            session: { sessionId, workspaceId },
            kind: 'memory',
          })
        : undefined,
      openUsage,
      openWorkingTreeDiff,
      refreshUsage: composerCapabilities.contextUsage?.refresh ? refreshUsage : undefined,
      submitCommand: command => onSubmit(command, undefined),
      prefillCommand: text => {
        pendingSlashPrefillRef.current = text
        setInput(text)
        syncToParent(text)
      },
    })
  }, [composerCapabilities.contextUsage?.refresh, composerCapabilities.slash.commandIds, composerCapabilities.slash.excludedCommandIds, composerCapabilities.slash.excludedCommandIdPrefixes, isProcessing, onPermissionModeChange, onSubmit, openAgents, openAutomations, openContext, openExport, openSideQuestionOverlay, openUsage, openWorkingTreeDiff, refreshUsage, requestRecap, sessionId, submitCustomSlashCommand, syncToParent, visiblePermissionModes, workspaceId])

  // Handle folder selection from slash command menu
  const [recentProjects, setRecentProjects] = React.useState<RecentProjectSummary[]>([])

  const handleSlashFolderSelect = React.useCallback((displayPath: string) => {
    const recentProject = recentProjects.find((project) => project.displayPath === displayPath)
    if (!workspaceId || !recentProject || !onWorkingDirectoryChange) return
    void window.electronAPI.issueRecentProjectHandle({
      workspaceId,
      recentProjectId: recentProject.id,
    }).then(onWorkingDirectoryChange)
  }, [onWorkingDirectoryChange, recentProjects, workspaceId])

  // Get recent folders and home directory for slash menu and mention menu
  const [homeDir, setHomeDir] = React.useState<string>('')

  React.useEffect(() => {
    if (workspaceId) {
      void window.electronAPI.listRecentProjects(workspaceId).then(setRecentProjects)
    } else {
      setRecentProjects([])
    }
    window.electronAPI?.getHomeDir?.().then((dir: string) => {
      if (dir) setHomeDir(dir)
    })
  }, [workspaceId])

  // Inline slash command hook (modes, features, and folders)
  const inlineSlash = useInlineSlashCommand({
    inputRef: richInputRef,
    onSelectCommand: handleSlashCommand,
    onSelectFolder: handleSlashFolderSelect,
    activeCommands,
    permissionModeDisplays,
    enabledCommandIds: composerCapabilities.slash.commandIds,
    excludedCommandIds: composerCapabilities.slash.excludedCommandIds,
    excludedCommandIdPrefixes: composerCapabilities.slash.excludedCommandIdPrefixes,
    customCommands: customSlashCommands,
    recentFolders: recentProjects.map((project) => project.displayPath),
    homeDir,
  })

  /**
   * P6.311 — the session's materialized subagent definitions, for the `@`
   * typeahead. `sub-agents.md#invoke-subagents-explicitly`, verbatim: "Type `@`
   * and pick the subagent from the typeahead, the same way you @-mention files".
   *
   * Read from the atom rather than threaded as a prop: `AppShell` ALREADY
   * derives this exact list (`composerCatalog.items` filtered to `kind:'agent'`)
   * and already writes it to `agentsAtom`, which until now had a writer and
   * ZERO readers. The seam existed; only the reader was missing, and taking it
   * costs no prop through two components that have no other use for it.
   */
  const mentionableAgents = useAtomValue(agentsAtom)

  /**
   * C3.224 (= row D1.80, carried from P6.464) — the OTHER live sessions the `@`
   * typeahead offers. `cross-session-messaging.md#message-another-session`,
   * verbatim: *"The typeahead lists your other live sessions on this machine"*.
   *
   * Read from the metadata map rather than threaded as a prop, for the same
   * reason `agentsAtom` is: the sidebar already maintains it, and it is the
   * lightweight half — names, not messages.
   *
   * Three exclusions, each with its own reason rather than one filter:
   * THIS session (the page's *"other"*, and `send_agent_message` refuses a
   * self-send anyway, so offering it could only produce a refusal); hidden and
   * archived rows (nobody can address them — the same rule the naming side
   * applies in `sessions/session-name-uniqueness.ts`); and rows with no name,
   * which have nothing to mention.
   */
  const sessionMetaMap = useAtomValue(sessionMetaMapAtom)
  const mentionableSessions = React.useMemo(() => {
    const rows: { id: string; name: string }[] = []
    for (const meta of sessionMetaMap.values()) {
      if (meta.id === sessionId) continue
      if (meta.hidden || meta.isArchived) continue
      const name = meta.name?.trim()
      if (!name) continue
      rows.push({ id: meta.id, name })
    }
    return rows.sort((a, b) => a.name.localeCompare(b.name))
  }, [sessionMetaMap, sessionId])

  // Handle mention selection (sources, skills, files, agents)
  const handleMentionSelect = React.useCallback((item: MentionItem) => {
    // For sources: enable the source immediately
    if (item.type === 'source' && item.source && onSourcesChange) {
      const slug = sourceSelectionId(item.source) // UB14.31 — the one identity the chip and the selectors key on
      if (!optimisticSourceSlugs.includes(slug)) {
        const newSlugs = [...optimisticSourceSlugs, slug]
        setOptimisticSourceSlugs(newSlugs)
        onSourcesChange(newSlugs)
      }
    }

    // Files via @ mention in text are sufficient context for the agent.
    // Skills also don't need special handling beyond text insertion.
    // An AGENT likewise inserts text and nothing more from here. The page's
    // guarantee — "This ensures that specific subagent runs rather than leaving
    // the choice to Claude" — is a HOST promise about the turn, not a composer
    // side effect, and the record that keeps it lives session-side; see this
    // row's report for what the composer hands it.
    // MCP resources likewise: the inserted `@server:uri` text is the reference,
    // and the host fetches and inlines it before the turn is built
    // (`resolveMcpResourceMentions`).
  }, [optimisticSourceSlugs, onSourcesChange])

  // Inline mention hook (for skills, sources, and files)
  const inlineMention = useInlineMention({
    inputRef: richInputRef,
    skills,
    sources,
    agents: mentionableAgents,
    sessions: mentionableSessions,
    basePath: workingDirectory,
    // Always supplied: the session RPC also carries the MCP resource candidates,
    // which the host resolves from the session's own pool on every backend.
    sessionId,
    // FILE strategy only. `codex-agent.ts` is the sole implementer of the
    // fuzzy-file RPC, and it REPLACES the local filesystem walk — so this stays
    // a provider check, and it no longer gates the resource half.
    useCodexFuzzyFileSearch: effectiveConnectionDetails?.providerType === 'codex-runtime',
    onSelect: handleMentionSelect,
    workspaceId: workspaceQualificationId,
  })

  // Inline label menu hook (for #labels)
  const handleLabelSelect = React.useCallback((labelId: string) => {
    onLabelAdd?.(labelId)
  }, [onLabelAdd])

  const inlineLabel = useInlineLabelMenu({
    inputRef: richInputRef,
    labels,
    sessionLabels,
    onSelect: handleLabelSelect,
    sessionStatuses,
    activeStateId: currentSessionStatus,
  })

  // "Add New Label" handler: cleans up the #trigger text and opens a controlled
  // EditPopover so the user can describe the label before the agent creates it.
  const [addLabelPopoverOpen, setAddLabelPopoverOpen] = React.useState(false)
  const [addLabelPrefill, setAddLabelPrefill] = React.useState('')
  const handleAddLabel = React.useCallback((prefill: string) => {
    if (!workspaceId) return

    // Remove the #trigger text from input
    const cleaned = inlineLabel.handleSelect('')
    setInput(cleaned)
    syncToParent(cleaned)
    inlineLabel.close()

    // Store the prefill text (e.g., "Test" from "#Test") to pre-fill the popover
    // Format: "Add new label {prefill}" so user can just press enter or modify
    setAddLabelPrefill(prefill ? t('labels.addNewLabel', { prefill }) : '')

    // Open the EditPopover for label creation
    setAddLabelPopoverOpen(true)
  }, [workspaceId, inlineLabel, syncToParent, t])

  // Memoize the add-label config so the EditPopover doesn't recreate on every render
  const addLabelEditConfig = React.useMemo(() => {
    if (!workspaceId) return null
    return getManagedEditConfig('add-label', {
      scope: 'workspace', workspaceId, kind: 'labels',
    })
  }, [workspaceId])

  // Report height changes to parent (for external animation sync)
  React.useLayoutEffect(() => {
    if (!onHeightChange || !containerRef.current) return

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        onHeightChange(entry.contentRect.height)
      }
    })

    observer.observe(containerRef.current)
    return () => observer.disconnect()
  }, [onHeightChange])

  // In compact mode, immediately report collapsed height when the input is
  // collapsed during processing. This ensures smooth animation timing.
  // When the user expands (or processing ends), the ResizeObserver takes
  // over and reports the actual rendered height.
  React.useEffect(() => {
    if (!onHeightChange) return
    if (isCollapsedInCompact) {
      // Collapsed state - only bottom bar visible (~44px)
      onHeightChange(44)
    }
  }, [isCollapsedInCompact, onHeightChange])

  // Check if running in Electron environment (has electronAPI)
  const hasElectronAPI = typeof window !== 'undefined' && !!window.electronAPI

  // Shared helper: read a File, add as attachment, decrement loading count
  const processFileAttachment = async (file: File, overrideName?: string) => {
    if (refuseOversizedAttachment(attachmentSizeInputOf(file, overrideName))) {
      setLoadingCount(prev => prev - 1)
      return
    }
    try {
      const attachment = await readFileAsAttachment(file, overrideName)
      if (attachment) {
        setAttachments(prev => [...prev, attachment])
      }
    } catch (error) {
      console.error('[FreeFormInput] Failed to read file:', error)
    }
    setLoadingCount(prev => prev - 1)
  }

  // File attachment handlers
  const handleAttachClick = () => {
    if (disabled) return
    fileInputRef.current?.click()
  }

  const handleFileInputChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files
    if (!files || files.length === 0) return

    const fileList = Array.from(files)
    setLoadingCount(prev => prev + fileList.length)

    for (const file of fileList) {
      await processFileAttachment(file)
    }

    // Reset input so re-selecting the same file triggers onChange again
    e.target.value = ''
  }

  const handleRemoveAttachment = React.useCallback((index: number) => {
    setAttachments(prev => prev.filter((_, i) => i !== index))
  }, [])

  // Drag and drop handlers
  const handleDragEnter = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    dragCounterRef.current++
    if (e.dataTransfer.types.includes('Files')) {
      setIsDraggingOver(true)
    }
  }

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    dragCounterRef.current--
    if (dragCounterRef.current === 0) {
      setIsDraggingOver(false)
    }
  }

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
  }

  // Helper to read a File using FileReader API
  const readFileAsAttachment = async (file: File, overrideName?: string): Promise<FileAttachment | null> => {
    // Capture the absolute OS path at attach time. Works for <input type="file"> and
    // OS drag-drop; returns null for clipboard paste and web-drag (no disk origin).
    // When null, the draft layer falls back to persisting content inline (Track C).
    const realPath = hasElectronAPI ? window.electronAPI.getFilePath?.(file) ?? null : null

    return new Promise((resolve) => {
      const reader = new FileReader()
      reader.onload = async () => {
        const result = reader.result as ArrayBuffer
        // Chunked base64 encoding — btoa + reduce fails on large files (>1MB)
        // due to O(n²) string concatenation and browser string-length limits
        const bytes = new Uint8Array(result)
        let binary = ''
        const chunkSize = 8192
        for (let i = 0; i < bytes.length; i += chunkSize) {
          binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + chunkSize, bytes.length)))
        }
        const base64 = btoa(binary)

        const fileName = overrideName || file.name
        // P3.274 — ONE classifier for the composer and the mapper. This used to
        // be an inline five-branch chain with a ten-extension regex and no
        // audio family, against `files.ts`'s four tables and forty text
        // extensions, so a `.rs`, `.go`, `.yaml`, `.toml`, `.sql` or `.mp3`
        // was `text`/`audio` to the model and a nameless "File" on screen —
        // and its contents were never decoded here.
        //
        // The fallback stays `'unknown'` and is passed explicitly: saying
        // `'text'` here (which is what `files.ts` answers) would decode the
        // whole buffer of an arbitrary binary as UTF-8 in the renderer with no
        // size cap. That residue is named in `file-types.ts`'s header.
        const type: FileAttachment['type'] = attachmentKindFromBrowserFile(
          { name: fileName, mimeType: file.type },
          'unknown',
        )

        const mimeType = file.type || 'application/octet-stream'

        // For text files, decode the ArrayBuffer as UTF-8 text
        let text: string | undefined
        if (type === 'text') {
          text = new TextDecoder('utf-8').decode(new Uint8Array(result))
        }

        let thumbnailBase64: string | undefined
        if (hasElectronAPI) {
          try {
            const thumb = await window.electronAPI.generateThumbnail(base64, mimeType)
            if (thumb) thumbnailBase64 = thumb
          } catch {
            // Thumbnail generation is optional, continue without it
          }
        }

        resolve({
          type,
          path: realPath ?? fileName,
          name: fileName,
          mimeType,
          base64,
          text,
          size: file.size,
          thumbnailBase64,
        })
      }
      reader.onerror = () => resolve(null)
      reader.readAsArrayBuffer(file)
    })
  }

  // Clipboard paste handler for files/images
  const handlePaste = async (e: React.ClipboardEvent) => {
    if (disabled) return

    const clipboardItems = e.clipboardData?.files
    if (!clipboardItems || clipboardItems.length === 0) return

    // We have files to process - prevent default text paste behavior
    e.preventDefault()

    const files = Array.from(clipboardItems)
    setLoadingCount(prev => prev + files.length)

    // Pre-assign sequential names using ref to avoid race conditions
    let nextImageNum = getNextPastedNumber('image', attachmentsRef.current)
    const fileNames: string[] = files.map(file => {
      if (!file.name || file.name === 'image.png' || file.name === 'image.jpg' || file.name === 'blob') {
        const ext = file.type.split('/')[1] || 'png'
        return `pasted-image-${nextImageNum++}.${ext}`
      }
      return file.name
    })

    for (let i = 0; i < files.length; i++) {
      await processFileAttachment(files[i], fileNames[i])
    }
  }

  // Text pastes go in as usual; a console snippet also gets a "Run in background" offer (UB14.34, v0.15.0)
  const handleTextPaste = React.useCallback((text: string) => {
    const command = consoleSnippetCommand(text)
    if (command) onConsoleSnippetPaste?.({ command, text })
  }, [onConsoleSnippetPaste])

  // Handle long text paste - convert to file attachment
  const handleLongTextPaste = React.useCallback((text: string) => {
    const nextNum = getNextPastedNumber('text', attachmentsRef.current)
    const fileName = `pasted-text-${nextNum}.txt`
    const attachment: FileAttachment = {
      type: 'text',
      path: fileName,
      name: fileName,
      mimeType: 'text/plain',
      text: text,
      size: new Blob([text]).size,
      origin: 'pasted-text',
    }
    if (refuseOversizedAttachment(attachment)) return
    setAttachments(prev => [...prev, attachment])
    // Focus input after adding attachment
    richInputRef.current?.focus()
  }, [refuseOversizedAttachment])

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    dragCounterRef.current = 0
    setIsDraggingOver(false)
    if (disabled) return

    const files = Array.from(e.dataTransfer.files)
    setLoadingCount(files.length)

    for (const file of files) {
      await processFileAttachment(file)
    }
  }

  // Pre-flight image-support check, read from the runtime's own declared
  // capability rather than from a `pi_compat`-shaped guess. The previous
  // condition (`isCompatProvider && !modelSupportsImages`) could only ever fire
  // for a custom endpoint, so a staged image on `claude-runtime` was sent,
  // dropped by the local adapter and never mentioned.
  const hasStagedImages = attachments.some(a => a.type === 'image' || a.mimeType?.startsWith('image/'))
  const stagedImagePolicy = resolveStagedImagePolicy({
    hasStagedImages,
    images: composerCapabilities.attachments.images,
    providerType: effectiveConnectionDetails?.providerType,
    // P6.584 — the connection and model whose LEARNED refusal the banner
    // quotes. Both are handed over together because either one alone gives
    // nothing to look the sentence up in.
    connection: effectiveConnectionDetails ?? undefined,
    modelId: currentModel,
  })
  const showVisionWarning = stagedImagePolicy.blocked

  // Submit message - backend handles queueing and interruption
  /**
   * P6.480 — `midStreamOverride` rides only the plain-text branch, and that is
   * the whole of the decision rather than an omission.
   *
   * A `!` shell command never reaches the model; an out-of-band `/btw`,
   * `/recap` or `/heapdump` deliberately bypasses `sendMessage` altogether; and
   * a custom slash command carries a resolved id the server may not downgrade
   * to steered prose — the same reason `effectiveMidStreamBehavior` refuses the
   * override for a workflow invocation on the server side. Those four branches
   * return before the override can be applied, so the two ends agree by shape.
   */
  const submitMessage = React.useCallback((midStreamOverride?: 'steer' | 'queue') => {
    const trimmedInput = input.trim()
    const hasContent = trimmedInput || attachments.length > 0 || followUpItems.length > 0
    if (!hasContent || disabled) return false

    // Tutorial may disable sending. F1.983: a staged image the model refuses blocks Enter, Alt+Enter and nessy:submit-input as it blocks the button
    if (disableSend || isShellCommandRunning || showVisionWarning) return false

    const clearSubmittedDraft = () => {
      setInput('')
      setAttachments([])
      // Clear draft immediately (cancel any pending debounced sync)
      draftSync.markCleared(onInputChange)
      onAttachmentsChange?.([])

      // Restore focus after state updates
      requestAnimationFrame(() => {
        richInputRef.current?.focus()
      })
    }

    if (trimmedInput.startsWith('!')) {
      const command = trimmedInput.slice(1).trim()
      if (!command || !sessionId || !runShellCommand) return false

      setIsShellCommandRunning(true)
      void runShellCommand(sessionId, command)
        .then((result) => {
          if (result.executed) {
            clearSubmittedDraft()
          }
        })
        .catch((error) => {
          console.error('[FreeFormInput] Failed to run shell command:', error)
        })
        .finally(() => {
          setIsShellCommandRunning(false)
        })
      return true
    }

    // R36/R49 — TYPED `/btw [question]`, `/recap` and `/heapdump` never reach
    // onSubmit/sendMessage (the server guard rejects them outright), and they
    // are deliberately NOT blocked by isProcessing (interactive-mode.md:367 —
    // available while Claude is working; a /heapdump must work on a wedged
    // session). `/clear`, `/compact` and `/subtask` ride the normal message
    // path. Sits before custom slash-command submission, because the menu is
    // not the only way the text arrives (and /heapdump has no menu entry).
    const outOfBandCommand = typedOutOfBandCommandSubmission(trimmedInput)
    if (outOfBandCommand) {
      if (!sessionId) return false
      if (isSideQuestionSessionId(sessionId)) { // D1.384 — the panel IS the side question
        onSubmit(nestedSideQuestionText(outOfBandCommand, trimmedInput))
      } else if (outOfBandCommand.kind === 'recap') {
        requestRecap()
      } else if (outOfBandCommand.kind === 'heapdump') {
        runHeapdump()
      } else if (outOfBandCommand.question) {
        askSideQuestion(outOfBandCommand.question)
      } else {
        // Bare `/btw` = reopen on the most recent (`:374`), not an error or prefill.
        openSideQuestionOverlay()
      }
      clearSubmittedDraft()
      return true
    }

    const customCommandSubmission = customSlashCommandInputSubmission(customSlashCommands, trimmedInput)
    if (customCommandSubmission) {
      onSubmit(
        customCommandSubmission.message,
        undefined,
        undefined,
        customCommandSubmission.customSlashCommandId,
      )
      clearSubmittedDraft()
      return true
    }

    // UB4.14 (v0.15.1) — too much to send in one message: say so and keep the draft (the send would
    // drop the connection). Upstream checks right after the disableSend gate; ours sits here, after
    // the shell / out-of-band / custom-command branches, because none of those three sends the
    // attachments and this is the one path that does.
    const sizeProblem = checkAttachmentSizes(attachments, maxMessageBytesRef.current)
    if (sizeProblem) {
      showAttachmentSizeProblem(sizeProblem)
      return false
    }

    // Parse all @mentions (skills, sources, folders)
    const skillSlugs = skills.map(skillMentionInvocationId)
    const sourceSlugs = sources.map(s => s.mention?.id ?? s.logicalName)
    const mentions = parseMentions(input, skillSlugs, sourceSlugs)

    // Enable any mentioned sources that aren't already enabled
    if (mentions.sources.length > 0 && onSourcesChange) {
      const newSlugs = [...new Set([...optimisticSourceSlugs, ...mentions.sources])]
      if (newSlugs.length > optimisticSourceSlugs.length) {
        setOptimisticSourceSlugs(newSlugs)
        onSourcesChange(newSlugs)
      }
    }

    const attachmentSnapshot = attachments

    onSubmit(
      trimmedInput,
      attachmentSnapshot.length > 0 ? attachmentSnapshot : undefined,
      mentions.skills.length > 0 ? mentions.skills : undefined,
      undefined,
      midStreamOverride,
    )
    clearSubmittedDraft()

    return true
  }, [input, attachments, followUpItems, disabled, disableSend, isShellCommandRunning, showVisionWarning, sessionId, runShellCommand, customSlashCommands, draftSync, onInputChange, onAttachmentsChange, onModelChange, onSubmit, skills, sources, optimisticSourceSlugs, onSourcesChange, onWorkingDirectoryChange, homeDir, askSideQuestion, openSideQuestionOverlay, requestRecap, runHeapdump, showAttachmentSizeProblem])

  // Listen for nessy:submit-input events (simulate pressing the Send button)
  React.useEffect(() => {
    const handleSubmitInput = (e: CustomEvent<{ sessionId?: string }>) => {
      const targetSessionId = e.detail?.sessionId
      if (!shouldHandleScopedInputEvent({ sessionId, isFocusedPanel, targetSessionId })) return
      submitMessage()
    }

    window.addEventListener('nessy:submit-input', handleSubmitInput as EventListener)
    return () => window.removeEventListener('nessy:submit-input', handleSubmitInput as EventListener)
  }, [sessionId, isFocusedPanel, submitMessage])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    submitMessage()
  }

  // An explicit Stop refills the composer (`ChatDisplay.handleStop`), which used
  // to flip the primary control from Stop to Queue/Steer while `isProcessing`
  // was still true — so a second press of the same button re-sent the stopped
  // prompt. Hold the control as an inert Stop until the turn actually settles.
  // See `./submit-control`.
  // Scoped to the session, because this component is not remounted on a session
  // switch — a stop issued on one session must not leave another's button inert.
  const [stopRequestedFor, setStopRequestedFor] = React.useState<string | null>(null)
  React.useEffect(() => {
    if (!isProcessing) setStopRequestedFor(null)
  }, [isProcessing])

  const handleStop = (silent = false) => {
    if (!silent) setStopRequestedFor(sessionId ?? '')
    onStop?.(silent)
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    // During IME composition, ESC should cancel composition, not trigger app/menu ESC behavior.
    if (e.key === 'Escape' && e.nativeEvent.isComposing) {
      return
    }

    // Don't submit when mention menu is open AND has visible content
    if (inlineMention.isOpen) {
      // Only intercept navigation/selection keys if menu actually shows items or is loading
      const hasVisibleContent = inlineMention.sections.some(s => s.items.length > 0) || inlineMention.isSearching
      if (hasVisibleContent && (e.key === 'Enter' || e.key === 'Tab' || e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
        // These keys are handled by the InlineMentionMenu component
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        inlineMention.close()
        return
      }
    }

    // Don't submit when slash command menu is open - let it handle the Enter key
    if (inlineSlash.isOpen) {
      if (e.key === 'Enter' || e.key === 'Tab' || e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        // These keys are handled by the InlineSlashCommand component
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        inlineSlash.close()
        return
      }
    }

    // Don't submit when label menu is open - let it handle navigation keys
    if (inlineLabel.isOpen) {
      if (e.key === 'Enter' || e.key === 'Tab' || e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        inlineLabel.close()
        return
      }
    }

    // P6.480 — the ONE-MESSAGE override, ahead of both send-key modes because it
    // is a distinct chord in each. Matched against the ACTION's current hotkey,
    // not against a literal Alt+Enter, so a user who rebinds it in Settings is
    // honoured; the handler stays here because it sends this composer's own
    // draft (see the action's own definition for why it is not global).
    const overrideHotkey = actionRegistry.getHotkey('chat.sendWithOtherFollowUp')
    if (
      overrideHotkey
      && hotkeyMatchesEvent(e.nativeEvent, overrideHotkey)
      && !e.nativeEvent.isComposing
    ) {
      e.preventDefault()
      // The page describes it as "using the other behavior for one message", so
      // the value is the INVERSE of the resolved default rather than a constant.
      submitMessage(otherMidStreamBehavior(midStreamDefault))
      return
    }

    // Skip submission during IME composition - user is confirming composed characters, not sending
    // Handle send key based on user preference:
    // - 'enter': Enter sends (Shift+Enter for newline)
    // - 'cmd-enter': ⌘/Ctrl+Enter sends (Enter for newline)
    if (sendMessageKey === 'enter') {
      // Enter sends, Shift+Enter adds newline
      if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.nativeEvent.isComposing) {
        e.preventDefault()
        submitMessage()
      }
      // Also allow Cmd/Ctrl+Enter to send (power user shortcut)
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.nativeEvent.isComposing) {
        e.preventDefault()
        submitMessage()
      }
    } else {
      // cmd-enter mode: ⌘/Ctrl+Enter sends, plain Enter adds newline
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.nativeEvent.isComposing) {
        e.preventDefault()
        submitMessage()
      }
      // Plain Enter is allowed to pass through (adds newline)
    }
    // P2.447 · `Up` recalls a draft that double-Esc cleared ("The cleared text is saved to your input
    // history, so press `Up` to recall it", `checkpointing.md#rewind-and-summarize`). UA1.13 · ELSE, in an
    // EMPTY composer mid-turn, `Up` runs the Stop button's own path, which restores the stopped prompt
    // (v0.13.4 `shouldRecallPromptOnArrowUp`; a waiting cleared draft wins, OQ-20 — see `./input-event-guards`).
    // Sits AFTER the three inline menus above, each of which claims ArrowUp while open; both decisions
    // decline on any non-empty input, so multi-line caret movement is untouched.
    if (e.key === 'ArrowUp' && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
      if (recallClearedDraft() || stopTurnOnArrowUp({ key: e.key, shiftKey: e.shiftKey, metaKey: e.metaKey, ctrlKey: e.ctrlKey, altKey: e.altKey, isComposing: e.nativeEvent.isComposing, isProcessing, input: inputRef.current, attachmentCount: attachments.length, loadingAttachmentCount: loadingCount, followUpItemCount: followUpItems.length, inlineMenuOpen: inlineMention.isOpen || inlineSlash.isOpen || inlineLabel.isOpen, disabled, disableSend, stopAvailable: submitControl.mode === 'stop' && !submitControl.inert }, () => handleStop(false))) {
        e.preventDefault()
        return
      }
    }

    if (e.key === 'Escape') {
      // Skip this if a popover/overlay is open — let the overlay handle ESC instead.
      // This prevents the input from consuming ESC when focus gets pulled back here
      // while a popover is still visible (portal DOM isolation means the event won't
      // reach the popover's DismissableLayer otherwise).
      if (hasOpenOverlay()) return

      // P2.447 · double-Esc, both documented branches.
      // `checkpointing.md#rewind-and-summarize`: "Run `/rewind`, or press `Esc`
      // twice when the prompt input is empty, to open the rewind menu." — "If
      // the prompt input contains text, double `Esc` clears it instead."
      //
      // Owned HERE and not in the hotkey map: `./double-escape` carries the
      // decision and the product statement that follows from it (this chord is
      // NOT user-rebindable). Emptiness and the input history are both this
      // component's state, which is why the behaviour is this component's.
      const outcome = resolveDoubleEscape({
        now: Date.now(),
        armedAt: escapeArmedAtRef.current,
        hasDraftText: inputRef.current.trim().length > 0, rewindAvailable: !isRendererMintedSessionId(sessionId ?? ''), // F1.166
      })
      escapeArmedAtRef.current = outcome.armedAt

      if (outcome.kind === 'clear-draft') {
        e.preventDefault()
        clearDraftIntoInputHistory()
        return
      }

      if (outcome.kind === 'open-rewind-menu') {
        e.preventDefault()
        // The SAME route `/rewind` takes: `ChatDisplay.handleSubmit` reads the
        // raw text before anything is composed onto it and answers a whole-
        // message `/rewind` by opening the menu, so this reaches the ONE
        // existing rewind handler and can never become a model turn. A second
        // way in, not a second implementation — and the precedent for calling
        // `onSubmit` with a synthesised command is `'/compact'`, above.
        onSubmit(REWIND_COMMAND_LABEL, undefined)
        return
      }

      // outcome.kind === 'arm' (F1.166's 'decline' ends here too) — the FIRST press deliberately does NOT
      // blur any more. A blur here made the documented SECOND press unreachable:
      // focus lands on `body`, which is an ancestor of the React root, so no
      // further Escape reaches this handler at all, and hearing it would have
      // required a window-level Escape consumer racing the action registry's own
      // capture-phase listener — the broad mechanism P2.425 refused. Stated
      // rather than silently dropped: Escape no longer moves focus out of the
      // composer; the focus zones (⌘1/⌘2/⌘3) are the way out that remains.
    }
  }

  // Handle input changes from RichTextInput
  const handleInputChange = React.useCallback((value: string) => {
    const nextValue = coerceInputText(value)
    // Get previous input value before updating state
    const prevValue = inputRef.current

    setInput(nextValue)
    syncToParent(nextValue) // Debounced sync to parent for draft persistence

    // Sync source selection when mentions are removed from input
    if (onSourcesChange) {
      const sourceSlugs = sources.map(s => s.mention?.id ?? s.logicalName)

      // Parse mentions from previous and current input
      const prevMentions = parseMentions(prevValue, [], sourceSlugs)
      const currMentions = parseMentions(nextValue, [], sourceSlugs)

      // Remove sources that were mentioned before but not anymore
      const removedSources = prevMentions.sources.filter(slug => !currMentions.sources.includes(slug))
      if (removedSources.length > 0) {
        const newSlugs = optimisticSourceSlugs.filter(slug => !removedSources.includes(slug))
        setOptimisticSourceSlugs(newSlugs)
        onSourcesChange(newSlugs)
      }
    }
  }, [syncToParent, sources, optimisticSourceSlugs, onSourcesChange])

  const handleRestorePastedText = React.useCallback((attachment: FileAttachment) => {
    if (attachment.origin !== 'pasted-text' || !attachment.text) return

    const nextValue = `${inputRef.current}${attachment.text}`
    handleInputChange(nextValue)

    const index = attachmentsRef.current.indexOf(attachment)
    if (index >= 0) {
      handleRemoveAttachment(index)
    }

    requestAnimationFrame(() => {
      richInputRef.current?.focus()
      richInputRef.current?.setSelectionRange(nextValue.length, nextValue.length)
    })
  }, [handleInputChange, handleRemoveAttachment, richInputRef])

  // Handle input with cursor position (for menu detection)
  const handleRichInput = React.useCallback((value: string, cursorPosition: number) => {
    const nextValue = coerceInputText(value)

    // Update inline slash command state
    inlineSlash.handleInputChange(nextValue, cursorPosition)

    // Update inline mention state (for @mentions - skills, sources, folders)
    inlineMention.handleInputChange(nextValue, cursorPosition)

    // Update inline label state (for #labels)
    inlineLabel.handleInputChange(nextValue, cursorPosition)

    // Auto-capitalize first letter — but not for slash commands, @mentions,
    // #labels, ! shell commands, or a prompt that OPENS with a keyword a runtime
    // matches as a token (C3.351). Every one of those exemptions now lives in
    // `shouldAutoCapitaliseFirstCharacter`, read by the pure rewrite (F1.460 (5)),
    // so both are testable and this component keeps no copy. Only if autoCapitalisation is enabled.
    let newValue = nextValue
    if (autoCapitalisation) {
      const capitalized = autoCapitaliseFirstCharacter(nextValue)
      if (capitalized !== nextValue) {
        newValue = capitalized
        // Set cursor position BEFORE state update so it's used when useEffect syncs the value
        richInputRef.current?.setSelectionRange(cursorPosition, cursorPosition)
        setInput(newValue)
        syncToParent(newValue)
        return
      }
    }

    // Apply smart typography (-> to →, etc.)
    const typography = applySmartTypography(nextValue, cursorPosition)
    if (typography.replaced) {
      newValue = typography.text
      // Set cursor position BEFORE state update so it's used when useEffect syncs the value
      richInputRef.current?.setSelectionRange(typography.cursor, typography.cursor)
      setInput(newValue)
      syncToParent(newValue)
    }
  }, [inlineSlash, inlineMention, inlineLabel, syncToParent, autoCapitalisation])

  // Handle inline slash command selection (removes the /command text)
  const handleInlineSlashCommandSelect = React.useCallback((commandId: SlashCommandId) => {
    const newValue = inlineSlash.handleSelectCommand(commandId)
    // An argument-taking command parked its prefill during the call above; the
    // stripped remainder is whatever else the user had typed, so keep both.
    const prefill = pendingSlashPrefillRef.current
    pendingSlashPrefillRef.current = null
    const merged = prefill ? (newValue ? `${newValue} ${prefill}` : prefill) : newValue
    setInput(merged)
    syncToParent(merged)
    richInputRef.current?.focus()
    if (prefill) {
      richInputRef.current?.setSelectionRange(merged.length, merged.length)
    }
  }, [inlineSlash, syncToParent])

  // Handle inline slash folder selection (inserts a directory badge)
  const handleInlineSlashFolderSelect = React.useCallback((path: string) => {
    const newValue = inlineSlash.handleSelectFolder(path)
    setInput(newValue)
    syncToParent(newValue)
    richInputRef.current?.focus()
  }, [inlineSlash, syncToParent])

  // Handle inline mention selection (inserts appropriate mention text)
  const handleInlineMentionSelect = React.useCallback((item: MentionItem) => {
    const { value: newValue, cursorPosition } = inlineMention.handleSelect(item)
    setInput(newValue)
    syncToParent(newValue)
    // Focus input and restore cursor position after badge renders
    setTimeout(() => {
      richInputRef.current?.focus()
      richInputRef.current?.setSelectionRange(cursorPosition, cursorPosition)
    }, 0)
  }, [inlineMention, syncToParent])

  // Handle inline label selection (removes the #label text from input)
  const handleInlineLabelSelect = React.useCallback((labelId: string) => {
    const newValue = inlineLabel.handleSelect(labelId)
    setInput(newValue)
    syncToParent(newValue)
    richInputRef.current?.focus()
  }, [inlineLabel, syncToParent])

  // Handle inline state selection from # menu (removes #text, changes session state)
  const handleInlineStateSelect = React.useCallback((stateId: string) => {
    const newValue = inlineLabel.handleSelect('')
    setInput(newValue)
    syncToParent(newValue)
    if (sessionId) {
      onSessionStatusChange?.(sessionId, stateId)
    }
    richInputRef.current?.focus()
  }, [inlineLabel, syncToParent, sessionId, onSessionStatusChange])

  const followUpLayoutKey = React.useMemo(
    () => followUpItems.map(item => [
      item.id,
      item.index ?? '',
      item.noteLabel,
      item.selectedText,
      item.color ?? '',
    ].join('::')).join('|'),
    [followUpItems]
  )
  const previousFollowUpLayoutKeyRef = React.useRef<string | null>(null)
  const [animateFollowUpLayout, setAnimateFollowUpLayout] = React.useState(false)

  React.useEffect(() => {
    const previous = previousFollowUpLayoutKeyRef.current
    previousFollowUpLayoutKeyRef.current = followUpLayoutKey

    if (previous == null || previous === followUpLayoutKey) return

    setAnimateFollowUpLayout(true)
    const timer = window.setTimeout(() => {
      setAnimateFollowUpLayout(false)
    }, 220)

    return () => window.clearTimeout(timer)
  }, [followUpLayoutKey])

  const hasContent = input.trim() || attachments.length > 0 || followUpItems.length > 0
  const submitControl = resolveSubmitControl({
    isProcessing,
    hasContent: Boolean(hasContent),
    queueSupported: composerCapabilities.submit.queue,
    sessionId,
    stopRequestedFor, awaitingAnswer: disableSend, hasAttachments: attachments.length > 0, queueHoldsUnsteerableRow, // F1.331 / F1.481 (3)
  })
  const submitMode: SubmitMode = submitControl.mode
  const submitDisabled = submitControl.inert
    || (submitMode !== 'stop'
      && (!hasContent || disabled || disableSend || isShellCommandRunning || showVisionWarning))
  const submitBlockReason: string | null = React.useMemo(() => {
    // The control is disabled because the Stop it just issued is still in
    // flight, not because there is nothing to send. Fall through to the plain
    // "Stop" label rather than naming a reason that is not the reason.
    if (submitControl.inert) return null
    if (connectionUnavailable) return t('chat.submit.blocked.connectionUnavailable')
    if (loadingCount > 0) return t('chat.submit.blocked.uploadsPending')
    if (showVisionWarning) return t('chat.submit.blocked.imagesUnsupported')
    if (isShellCommandRunning) return t('chat.submit.blocked.shellCommandRunning')
    if (!hasContent) return t('chat.submit.blocked.empty')
    return null
  }, [submitControl.inert, connectionUnavailable, loadingCount, showVisionWarning, isShellCommandRunning, hasContent, t])

  // v0.15.1 — one toggle for the sources chip's desktop popover and compact drawer (each held its own copy).
  const handleToggleSourceSlug = (slug: string) => {
    const isEnabled = optimisticSourceSlugs.includes(slug)
    const newSlugs = isEnabled
      ? optimisticSourceSlugs.filter(currentSlug => currentSlug !== slug)
      : [...optimisticSourceSlugs, slug]
    setOptimisticSourceSlugs(newSlugs)
    onSourcesChange?.(newSlugs)
  }

  // Ours: the branch chip (UB14.31) behind its capability gate (UB12.77). One reading for the mount AND the left
  // group's floor (UB12.78), so the four-icon floor and the fourth icon cannot drift apart.
  const mountsBranchChip = composerMountsBranchChip({ compactMode, canChangeWorkingDirectory: !!onWorkingDirectoryChange, workspaceId, sessionId, capabilities: composerCapabilities })

  return (
    <form onSubmit={handleSubmit}>
      <div
        ref={containerRef}
        className={cn(
          // Own the panel query boundary: standalone/playground composers must collapse chips
          // at the input's width too, not depend on an AppShell ancestor being present.
          // (`relative` is ours: it anchors the hidden "Add New Label" popover trigger below.)
          '@container/panel relative flex flex-col min-h-0 overflow-hidden transition-colors',
          // Container styling - only when not wrapped by InputContainer (v0.15.1's card; UB14.27)
          !unstyled && 'rounded-xl bg-raised shadow-elev-2',
          // Drop target: inset focus ring + accent tint (never clipped by the card). UB14.32 — the
          // "Drop to attach" pill overlay (Codex parity wave 1.8) went with v0.15.0's look.
          isDraggingOver && 'ring-2 ring-inset ring-focus bg-accent-tint'
        )}
        onDragEnter={handleDragEnter}
        onDragLeave={handleDragLeave}
        onDragOver={handleDragOver}
        onDrop={handleDrop}
      >
        {/* Inline Slash Command Autocomplete */}
        <InlineSlashCommand
          open={inlineSlash.isOpen}
          onOpenChange={(open) => !open && inlineSlash.close()}
          sections={inlineSlash.sections}
          activeCommands={activeCommands}
          onSelectCommand={handleInlineSlashCommandSelect}
          onSelectFolder={handleInlineSlashFolderSelect}
          filter={inlineSlash.filter}
          position={inlineSlash.position}
          anchorRef={containerRef}
          contextStatus={contextStatus}
        />

        {/* Inline Mention Autocomplete (skills, sources, files) */}
        <InlineMentionMenu
          open={inlineMention.isOpen}
          onOpenChange={(open) => !open && inlineMention.close()}
          sections={inlineMention.sections}
          onSelect={handleInlineMentionSelect}
          filter={inlineMention.filter}
          position={inlineMention.position}
          workspaceId={workspaceId}
          anchorRef={containerRef}
          isSearching={inlineMention.isSearching}
        />

        {/* Inline Label & State Autocomplete (#labels / #states) */}
        <InlineLabelMenu
          open={inlineLabel.isOpen}
          onOpenChange={(open) => !open && inlineLabel.close()}
          items={inlineLabel.items}
          onSelect={handleInlineLabelSelect}
          onAddLabel={handleAddLabel}
          filter={inlineLabel.filter}
          position={inlineLabel.position}
          states={inlineLabel.states}
          activeStateId={inlineLabel.activeStateId}
          onSelectState={handleInlineStateSelect}
        />

        {/* Controlled EditPopover for "Add New Label" — opens when user selects
            the option from the # menu with no matches.
            Spread the full config so optional fields like `inlineExecution`,
            `displayLabel`, and `displayLabelKey` reach the popover. The previous
            cherry-pick dropped `inlineExecution: true`, which made the popover
            fall back to the same-window deep-link path; that worked inside
            Electron but launched the desktop app from the WebUI via `nessy://`.
            Match the AppShell pattern (which already uses spread). */}
        {addLabelEditConfig && (
          <EditPopover
            trigger={<span className="absolute top-0 left-0 w-0 h-0 overflow-hidden" />}
            open={addLabelPopoverOpen}
            onOpenChange={setAddLabelPopoverOpen}
            {...addLabelEditConfig}
            defaultValue={addLabelPrefill}
            side="top"
            align="start"
          />
        )}

        {/* R36 `/btw` overlay (see its own docblock for the shape). D1.375 — it
            carries a composer, a `FreeFormInput`, so the guard stops it nesting. */}
        {sessionId && !isSideQuestionSessionId(sessionId) && (
          <SideQuestionOverlay
            sessionId={sessionId}
            open={sideQuestionOpen}
            onOpenChange={setSideQuestionOpen}
            onAsk={askSideQuestion}
            composerCapabilities={composerCapabilities}
          />
        )}

        {/* Pre-flight image-support warning, shown on every runtime that
            declares it takes no images. The inline "enable" action rides along
            only where the connection catalog is what decides — see
            `resolveStagedImagePolicy`. */}
        {showVisionWarning && (
          <ImageSupportWarningBanner
            modelName={currentModelDisplayName}
            {...(stagedImagePolicy.refusalSentence
              ? { refusalSentence: stagedImagePolicy.refusalSentence }
              : {})}
            {...(stagedImagePolicy.offerModelOverride && effectiveConnectionDetails
              ? { onEnable: () => handleToggleModelVision(effectiveConnectionDetails.slug, currentModel, true) }
              : {})}
          />
        )}

        {/* Attachment Preview */}
        <AttachmentPreview
          attachments={attachments}
          onRemove={handleRemoveAttachment}
          onRestoreText={handleRestorePastedText}
          disabled={disabled}
          loadingCount={loadingCount}
        />

        {/* Follow-up context chips (v0.15.1's FollowUpChips, UB14.28) */}
        <FollowUpChips
          items={followUpItems}
          animateLayout={animateFollowUpLayout}
          onItemClick={onFollowUpClick}
          onIndexClick={onFollowUpIndexClick}
        />

        {/* Rich Text Input with inline mention badges */}
        {/* In compact mode, hide input while the agent is processing — until the
            user clicks / hovers the collapsed bar to expand it back. */}
        {!isCollapsedInCompact && (
        <RichTextInput
          ref={richInputRef}
          value={input}
          onChange={handleInputChange}
          onInput={handleRichInput}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          onLongTextPaste={handleLongTextPaste}
          onTextPaste={handleTextPaste}
          onFocus={() => { setIsFocused(true); onFocusChange?.(true) }}
          onBlur={() => {
            // Save caret position before losing focus (for restoration via nessy:focus-input)
            lastCaretPositionRef.current = richInputRef.current?.selectionStart ?? null
            setIsFocused(false)
            onFocusChange?.(false)
          }}
          placeholder={effectivePlaceholder}
          disabled={disabled}
          skills={skills}
          sources={sources}
          workspaceId={workspaceQualificationId}
          // Copy type (15/24; 16/26 in compact so iOS never zooms), placeholder in tertiary (v0.15.0).
          // Narrow panels reserve two lines so a wrapped rotating tip is never clipped. Ours: the textbox
          // keeps its own scroll and `inputMaxHeight` — upstream's shared scroll region rides on
          // `composer-height`, which is not taken (UB14.27, UB5.4).
          className={cn(
            'px-3.5 pt-3.5 pb-3.5 overflow-y-auto',
            compactMode ? 'text-copy-lg min-h-[80px]' : 'text-copy @max-panel-medium/panel:min-h-[76px]',
          )}
          style={{ maxHeight: inputMaxHeight, lineHeight: compactMode ? 'var(--lh-copy-lg)' : 'var(--lh-copy)' }}
          data-tutorial="chat-input"
          spellCheck={spellCheck}
        />
        )}

        {/* Bottom Row: Controls - never shrinks into the draft above; relative for the status slot overlay */}
        <div className="relative shrink-0" data-composer-actions>
          {/* Status slot overlay - escape interrupt (highest priority), browser status, etc. */}
          <ToolbarStatusSlot
            showEscapeOverlay={isProcessing && showEscapeOverlay}
            sessionId={sessionId}
          />

          {/* Toolbar (v0.15.0, mockup `.cx-bar`): attach · sources · folder · spacer · mode · model · context · send.
              UB14.32 — it replaced the Codex-parity grid footer; ours in it: the branch chip after the folder
              (desktop, capability-gated, UB14.31), our mode and model menus, and the always-on context ring. */}
          {/* The first icon's glyph lines up with the draft text (card-pad, 14px): 28px desktop
              buttons pad 6px, 36px compact ones 10px, so the row insets 8px / 4px. */}
          <div className={cn("flex items-center gap-1 pb-1.5", compactMode ? "px-1" : "px-2", isCollapsedInCompact && "pt-1.5")}>
          {/* Hidden file input for attach button (shared by compact and desktop) */}
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={handleFileInputChange}
          />

          {/* Left: attach, sources, working folder (and our branch chip). Compact, and desktop panels under 32rem,
              show the chips icon-only (their names stay in tooltips/aria-labels) so the model keeps its name.
              Desktop keeps the three icons (96px) — four (128px) where our branch chip mounts (UB12.78) — while
              the row still leaves 11rem for mode · model · context · Send; in a narrower row that floor gives way
              so Send is never pushed out. overflow-hidden is safe — popovers/drawers portal. */}
          <div className={cn(
            "flex items-center gap-1",
            compactMode
              ? "shrink-0 [&_[data-badge-label]]:hidden"
              : cn(composerLeftGroupFloor(mountsBranchChip), "shrink overflow-hidden @max-[32rem]/panel:[&_[data-badge-label]]:hidden")
          )}>
          <IconButton
            aria-label={attachments.length > 0
              ? t("chat.filesCount", { count: attachments.length })
              : t("chat.attachFiles")
            }
            tooltip={t("chat.attachFilesTooltip")}
            icon={<Paperclip />}
            onClick={handleAttachClick}
            disabled={disabled}
            className="input-toolbar-btn"
          />

          {/* Source selector chip (v0.15.1's ComposerSourcesChip, UB14.31) - only if onSourcesChange is provided */}
          {onSourcesChange && (
            <ComposerSourcesChip
              compact={compactMode}
              sources={sources}
              selectedSlugs={optimisticSourceSlugs}
              onToggleSlug={handleToggleSourceSlug}
              open={sourceDropdownOpen}
              setOpen={setSourceDropdownOpen}
              isEmptySession={isEmptySession}
              disabled={disabled}
              buttonRef={sourceButtonRef}
            />
          )}

          {/* Working folder chip — the drawer selector in compact, the popover badge on desktop */}
          {onWorkingDirectoryChange && workspaceId && (compactMode ? (
            <CompactWorkingDirectorySelector
              workingDirectory={workingDirectory}
              onWorkingDirectoryChange={onWorkingDirectoryChange}
              onResetToSession={onResetToSession}
              isEmptySession={false}
              workspaceId={workspaceId}
            />
          ) : (
            <WorkingDirectoryBadge
              workingDirectory={workingDirectory}
              onWorkingDirectoryChange={onWorkingDirectoryChange}
              onResetToSession={onResetToSession}
              isEmptySession={isEmptySession}
              workspaceId={workspaceId}
              sessionId={sessionId}
            />
          ))}

          {/* Ours: the branch chip after the folder (UB14.31) — desktop only, capability-gated (UB12.77) */}
          {mountsBranchChip && sessionId && (
            <BranchSwitcher sessionId={sessionId} />
          )}
          </div>

          {/* Spacer — doubles as a tap / hover target while the input is
              collapsed during processing in compact mode, so the user can
              type a follow-up without waiting for the agent to finish. */}
          {isCollapsedInCompact ? (
            <button
              type="button"
              onClick={onRequestExpand}
              onMouseEnter={onRequestExpand}
              aria-label={t('chat.tapToType')}
              className="motion-press mx-1 flex h-control min-w-0 flex-1 cursor-pointer items-center justify-center rounded-md text-tertiary hover:bg-fill-hover hover:text-secondary"
            >
              <ChevronUp className="h-4 w-4" />
            </button>
          ) : (
            <div className="flex-1" />
          )}

          {/* Right: mode · model absorb the squeeze — the model label truncates, and in narrow
              panels the mode chip folds to its icon. Context and Send sit outside this group and
              never shrink, so Send stays inside the card. The 4px inset keeps focus rings visible
              inside the clipping group. Compact moved them here from the left (UB14.32). */}
          <div className="-m-1 flex min-w-0 shrink items-center gap-1 overflow-hidden p-1">
          {onPermissionModeChange && (compactMode ? (
            <CompactPermissionModeSelector
              permissionMode={effectivePermissionMode}
              onPermissionModeChange={onPermissionModeChange}
              permissionModeDisplays={permissionModeMenuDisplays}
              runtimeNote={permissionModeRuntimeNote}
              locked={composerCapabilities.permissions.locked}
            />
          ) : (
            <ComposerModeChip
              permissionMode={effectivePermissionMode}
              onPermissionModeChange={onPermissionModeChange}
              permissionModeDisplays={permissionModeMenuDisplays}
              runtimeNote={permissionModeRuntimeNote}
              locked={composerCapabilities.permissions.locked}
              sessionId={sessionId}
              cycleHotkey={actionRegistry.getHotkey('chat.cyclePermissionMode')}
            />
          ))}

          {/* Model/Connection selector — the drawer in compact (when enabled), v0.15.1's `ComposerModelMenu` on
              desktop (UB14.30: it owns the trigger and the menu; the open state stays here because the compact
              picker shares it). The compact EditPopover embedding shows no model picker. */}
          {compactMode ? (
            enableCompactModelPicker && (
              <CompactModelSelector
                currentModel={currentModel}
                currentConnection={currentConnection}
                onModelChange={onModelChange}
                onConnectionChange={onConnectionChange}
                onPreviewConnectionChange={onPreviewConnectionChange}
                thinkingLevel={thinkingLevel}
                onThinkingLevelChange={onThinkingLevelChange}
                ultracode={ultracodeEnabled}
                onUltracodeChange={handleUltracodeChange}
                isEmptySession={isEmptySession}
                connectionUnavailable={connectionUnavailable}
                isProcessing={isProcessing}
                contextStatus={contextStatus}
                open={modelDropdownOpen}
                onOpenChange={setModelDropdownOpen}
              />
            )
          ) : (
            <ComposerModelMenu
              open={modelDropdownOpen}
              onOpenChange={setModelDropdownOpen}
              llmConnections={llmConnections}
              effectiveConnectionDetails={effectiveConnectionDetails}
              effectiveConnection={effectiveConnection}
              switchable={composerCapabilities.connection.switchable}
              reasoningLevels={composerCapabilities.reasoning.levels}
              isEmptySession={!!isEmptySession}
              isProcessing={!!isProcessing}
              connectionUnavailable={!!connectionUnavailable}
              pickerMode={pickerMode}
              connectionDefaultModel={connectionDefaultModel}
              availableModels={availableModels}
              currentModel={currentModel}
              currentModelDisplayName={currentModelDisplayName}
              thinkingLevel={thinkingLevel}
              thinkingDisabled={thinkingDisabled}
              {...(contextStatus ? { contextStatus } : {})}
              onModelChange={onModelChange}
              {...(onThinkingLevelChange ? { onThinkingLevelChange } : {})}
              {...(onConnectionChange ? { onConnectionChange } : {})}
              {...(onPreviewConnectionChange ? { onPreviewConnectionChange } : {})}
              onToggleVision={handleToggleModelVision}
            />
          )}
          </div>

          {/* Context usage meter, outside the squeeze (v0.15.0's place for `ContextUsageChip`). */}
          {!compactMode && composerCapabilities.contextMeter && (() => {
            // ONE context indicator. It used to be two — this donut, showing a
            // share of the whole window, and a warning badge further along the
            // toolbar showing a share of the auto-compaction threshold. Two
            // different percentages an inch apart, both meaning "context".
            // The badge's meaning lives here now and the badge is gone; the
            // decision itself is in `context-meter-state.ts`, where it is tested.
            //
            // The donut's `!compactMode` gate is deliberately unchanged, so the
            // compact (EditPopover) composer now shows no context warning where
            // the badge used to appear. Owner decision 2026-08-08: acceptable,
            // because `/compact` is reachable as a chat command from there.
            const meterInput = {
              inputTokens: contextStatus?.inputTokens,
              contextWindow: contextStatus?.contextWindow,
              autoCompactionThreshold: contextStatus?.autoCompactionThreshold,
              isCompacting: contextStatus?.isCompacting,
              thresholdKind: composerCapabilities.contextUsage?.thresholdKind,
              catalogContextWindow: getModelContextWindow(currentModel),
              isProcessing,
            }
            const meter = resolveContextMeterState(meterInput)
            // The blank has two causes and only one of them is nothing to report.
            // `ContextMeterUnknownWindow` self-returns `null` for the other one,
            // so every input that renders nothing today still renders nothing.
            if (!meter) return <ContextMeterUnknownWindow input={meterInput} />

            // UB14.28 — the quiet ring at rest, v0.15.1's info-tint chip at the warning.
            return (
              <ContextUsageChip
                meter={meter}
                usage={{
                  inputTokens: contextStatus!.inputTokens!,
                  contextWindow: contextStatus!.contextWindow!,
                  estimatedWindow: contextStatus?.contextWindowSource === 'fallback',
                }}
                onCompact={() => onSubmit('/compact', [])}
              />
            )
          })()}

          {/* Send/Queue/Steer/Stop Button (v0.15.1's SendButton over our four states, UB14.28) */}
          <SendButton
            mode={submitMode}
            inert={submitControl.inert}
            disabled={submitDisabled}
            busy={isShellCommandRunning}
            blockReason={submitBlockReason}
            // P6.946 — the override row names the chord's EFFECT with the same expression the key
            // handler passes to `submitMessage`. F1.331 — with files staged the host queues whichever
            // way the chord points, so the row is hidden; F1.481 (3) likewise behind an unsteerable row.
            midStreamOverride={midStreamOverrideHotkey && attachments.length === 0 && !queueHoldsUnsteerableRow
              ? { hotkey: midStreamOverrideHotkey, behavior: otherMidStreamBehavior(midStreamDefault) }
              : null}
            onStop={() => handleStop(false)}
          />
          </div>
        </div>
      </div>
    </form>
  )
}

/**
 * WorkingDirectoryBadge - chat-input trigger for the shared WorkingDirectorySelector.
 *
 * Renders the context-badge trigger; the picker popover + folder state machine
 * live in {@link WorkingDirectorySelector}. UB14.31 moved this chip INTO the
 * toolbar's left group (attach · sources · folder), out of the footer row under
 * the card. Ours on the trigger: UA12.206's `chat.workInFolder` placeholder, and
 * D1.251's session-storage line in the no-folder tooltip.
 */
function WorkingDirectoryBadge({
  workingDirectory,
  onWorkingDirectoryChange,
  onResetToSession,
  isEmptySession = false,
  workspaceId,
  sessionId,
}: {
  workingDirectory?: string
  onWorkingDirectoryChange: (project: IssuedProjectHandle) => void
  onResetToSession?: () => void
  isEmptySession?: boolean
  workspaceId: string
  /**
   * D1.251 — read only to name this session's own storage directory in the
   * no-folder tooltip. Optional so the playground and any caller without a
   * session render exactly what they rendered before.
   */
  sessionId?: string
}) {
  const { t } = useTranslation()

  // D1.251 — the session's own storage directory, read from the metadata the
  // renderer already holds rather than threaded down as a fourth prop. Null for
  // every session with a project folder, which is the common case, and for a
  // server that does not send the field.
  const sessionMetaMap = useAtomValue(sessionMetaMapAtom)
  const sessionStorageDirectory = sessionStorageWorkingDirectory({
    workingDirectory,
    ...(sessionId ? { sdkCwd: sessionMetaMap.get(sessionId)?.sdkCwd } : {}),
  })

  return (
    <WorkingDirectorySelector
      workingDirectory={workingDirectory}
      onWorkingDirectoryChange={onWorkingDirectoryChange}
      onResetToSession={onResetToSession}
      workspaceId={workspaceId}
      renderTrigger={({ open, hasFolder, folderName, workingDirectory: wd, homeDir, gitBranch }) => (
        <span className="shrink min-w-0 overflow-hidden">
          <FreeFormInputContextBadge
            icon={<Icon_Home className="h-4 w-4" />}
            label={folderName ?? t('chat.workInFolder')} // UA12.206, upstream v0.13.4's key
            isExpanded={isEmptySession}
            hasSelection={hasFolder}
            showChevron={true}
            isOpen={open}
            tooltip={
              hasFolder ? (
                <span className="flex flex-col gap-0.5">
                  <span className="font-medium">{t("chat.workingDirectory")}</span>
                  <span className="text-label-sm text-secondary">{formatPathForDisplay(wd, homeDir)}</span>
                  {gitBranch && <span className="text-label-sm text-secondary">{t("chat.onBranch", { branch: gitBranch })}</span>}
                </span>
              ) : sessionStorageDirectory ? (
                /* D1.251 — a session with NO project folder still runs its child
                   somewhere, and until now nothing said where: the model is told
                   the workspace root and a relative Write lands in the session's
                   own storage. The invitation to choose a folder stays first,
                   because that is what the badge is for; the fact rides under it. */
                <span className="flex flex-col gap-0.5">
                  <span>{t("chat.chooseWorkingDirectory")}</span>
                  <span className="text-label-sm text-secondary">
                    {t("chat.sessionStorageWorkingDirectory", { path: formatPathForDisplay(sessionStorageDirectory, homeDir) })}
                  </span>
                </span>
              ) : t("chat.chooseWorkingDirectory")
            }
          />
        </span>
      )}
    />
  )
}
