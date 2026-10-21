import * as React from "react"
import { useTranslation } from "react-i18next"
import { useEffect, useState, useMemo, useCallback } from "react"
import {
  ChevronUp,
  Info,
  X,
} from "lucide-react"
import type { RuntimeSwitchPreviewAnswer } from "./input/ConnectionRow"
import { agentOwnerLabelKey } from "@/lib/agent-tier"
import { toast } from "sonner"
import { isHostTurnInFlight, isRendererMintedSessionId } from "./input/stub-session"
import { ScrollArea } from "@/components/ui/scroll-area"
import { cn } from "@/lib/utils"
import { rewindFilesDescription, rewindUntrackedDescription } from "@/utils/rewind-report"
import { fileCheckpointsUntracked, uncoveredRewindCategories, uncoveredRewindCategoryKey } from "@/utils/rewind-report"
import { RewindMenuPanel, collectRewindPrompts, rewindCommandOpensMenu, rewindComposerText } from "./rewind-menu"
import { CHAT_PANE_ANCHOR_CLASS, ChatPaneOverlay } from "./chat-pane-overlay"
import { ChatNoticeRegion } from "./chat-notice-region"
import { composerTextAfterStop, userMessageToRetry } from "@/lib/input-text"
import { useDelayedLoading } from "@/hooks/useDelayedLoading"
import {
  parseReadResult,
  parseBashResult,
  parseGrepResult,
  parseGlobResult,
  extractOverlayData,
  extractOverlayCards,
  ActivityCardsOverlay,
  CodePreviewOverlay,
  MultiDiffPreviewOverlay,
  TerminalPreviewOverlay,
  GenericOverlay,
  JSONPreviewOverlay,
  DocumentFormattedMarkdownOverlay,
  detectLanguage,
  type ActivityItem,
  type ActivityRenderProps,
  type FileChange,
  type DiffViewerSettings,
  RunCommandProvider,
} from "@nessy-agent/ui"
import { useFocusZone } from "@/hooks/keyboard"
import { useTheme } from "@/hooks/useTheme"
import type { Session, Message, FileAttachment, PermissionRequest, CredentialRequest, CredentialResponse, MemoryAppendResult, MemoryAppendScope, ShellCommandResult, ConversationRewindResult, RewindTrackedChangesResult, SessionTranscriptExportResult } from "../../../shared/types"
import type { SafeCapabilitySummary } from '@nessy-agent/shared/protocol/capabilities'
import type { IssuedProjectHandle } from '@nessy-agent/shared/projects/project-handle-service'
import type { PermissionMode } from "@nessy-agent/shared/agent/modes"
import type { ThinkingLevel } from "@nessy-agent/shared/agent/thinking-levels"
import {
  TurnCard, formatToolDisplay,
  groupMessagesByTurn,
  formatTurnAsMarkdown,
  formatActivityAsMarkdown,
  getAssistantTurnUiKey,
  asRecord,
  getAnnotationNoteText,
  isAnnotationFollowUpSent,
  extractAnnotationSelectedText,
  normalizeFollowUpText,
  type Turn,
  type AssistantTurn,
  type UserTurn,
  type SystemTurn,
  type AuthRequestTurn,
} from "@nessy-agent/ui"
import { MemoizedAuthRequestCard } from "@/components/chat/AuthRequestCard"
import { ChatInputZone, adminApprovalCardData, type StructuredInputState, type StructuredResponse, type PermissionResponse, type AdminApprovalResponse } from "./input"
import type { RichTextInputHandle } from "@/components/ui/rich-text-input"
import { useBackgroundTasks } from "@/hooks/useBackgroundTasks"
import { useTurnCardExpansion } from "@/hooks/useTurnCardExpansion"
import { useTranscriptVerbosity } from "@/hooks/useTranscriptVerbosity"
import { useNavigation } from "@/contexts/NavigationContext"
import { AppShellProvider, useAppShellContext } from "@/context/AppShellContext"
import { useLearnImageRefusal } from "./input/useLearnImageRefusal"
// P6.278 — imported straight from the protocol rather than through
// `apps/electron/src/shared/types.ts`, which another lane holds this hour; the
// re-export there is a convenience, not the definition.
import type { WorkingTreeDiffResult } from "@nessy-agent/shared/protocol"
import { navigate, routes } from "@/lib/navigate"
import { CHAT_LAYOUT } from "@/config/layout"
import { collectFileChangesFromActivities, getFirstFileChangeIdForActivity } from "@/lib/file-changes"
import { resolveBranchNewPanelOption } from "./branching"
import { SubagentCard } from "./SubagentCard"
import { isStackedOrchestrationTool, isSubagentCardActivity } from "./activity-card-routing"
import { isTodoCardActivity, TodoListCard } from "./TodoListCard"
import { AdvisorConsultationCard } from "./AdvisorConsultationCard"
import { isAdvisorCardActivity } from "./advisor-consultation"
import { TaskChecklistPanel } from "./TaskChecklistPanel"
import type { OpenedTaskOutput, TaskOutputOverlayState } from "./task-output"
import { TaskOutputOverlay } from "./chat-display/TaskOutputOverlay"
import { AgentPanel } from "./AgentPanel"
import { PendingAuthNotice } from "./PendingAuthNotice"
import { SessionCapabilityInventoryNotice } from "./SessionCapabilityInventoryNotice"
import { useAgentPanel } from "@/hooks/useAgentPanel"
import { useAction } from "@/actions/useAction"
import { WorkflowPanel } from "./WorkflowPanel"
import { runtimeDispatchesWorkflows } from "@nessy-agent/shared/agent/runtime-agent-support"
import type { WorkflowSaveScope } from "../../../shared/types"
import { Info_GroupedList } from "@/components/info"
import { currentSnapshotTokens, formatContextUsage, formatContextWindowSource, formatSnapshotCount, formatUsageCostRow, formatUsageNumber, mayFallBackToTokenUsage, modelCostRows } from "./ChatDisplay.usage-format"
import { UsageCacheBreakdown } from "./UsageCacheBreakdown"
import { UsageCostBreakdown } from "./UsageCostBreakdown"
import { ContextOverlayBreakdown, getContextTokenTotal } from "./context-overlay"
import type { PluginSuggestionTipData } from "./plugin-suggestion-tip"
import { DeferredSpawnChips, type DeferredSpawnProposal } from "./deferred-spawn-chip"
// UB14.14 — v0.15.1's message renderer, extracted with our specifics (F1.351 task-notification line,
// the memory/rewind menu, D1.194 credential sign-in, the runtime-switch and terminal-reason notices).
import { MemoizedMessageBubble } from "./chat-display/MessageBubble"
import { MemoryContextMenu } from "./chat-display/MemoryContextMenu"
// UB14.15 — v0.15.1's live line, scroll anchor and turn frame, extracted (the indicator with our
// P6.274/P6.916 retry arm and P6.424 tip), and the transcript's Run-in-background runner.
import { ProcessingIndicator } from "./chat-display/ProcessingIndicator"
import { ScrollOnMount } from "./chat-display/ScrollOnMount"
import { TurnFrame } from "./chat-display/TurnFrame"
import { transcriptRunCommand } from "./chat-display/transcript-run-command"
import {
  CompactEmptyState,
  NewChatEmptyState,
  EarlierMessagesHint,
  NoRenderableMessages,
  TranscriptLoadError,
  TranscriptSkeleton,
} from "./chat-display/TranscriptStates"
import { compactTurnLeftPlanOpen } from "./input/compaction-wait" // F1.856
// ============================================================================
// CSS Custom Highlight API helper
// ============================================================================
/** Access CSS.highlights lazily — avoids stale ref from module-init / HMR timing */
function getCSSHighlights(): Map<string, Highlight> | undefined {
  try {
    return (CSS as any).highlights as Map<string, Highlight> | undefined
  } catch {
    return undefined
  }
}

// ============================================================================
// Overlay State Types
// ============================================================================

/** State for multi-diff overlay (Edit/Write activities) */
interface MultiDiffOverlayState {
  type: 'multi-diff'
  changes: FileChange[]
  consolidated: boolean
  focusedChangeId?: string
}

/** State for markdown overlay (pop-out, turn details, generic activities) */
interface MarkdownOverlayState {
  type: 'markdown'
  content: string
  title: string
  /** When true, show raw markdown source in code viewer instead of rendered preview */
  forceCodeView?: boolean
}

/**
 * L9 — A BACKGROUND TASK'S OUTPUT, THE OVERLAY'S SECOND SOURCE.
 *
 * `TerminalPreviewOverlay` needs nothing from an activity: it takes
 * `command/output/exitCode/toolType/description` as plain props. What coupled it to
 * the transcript was the STATE — `activityOutputOverlayData` is a memo over
 * `overlayState.activity`, so text fetched for a background-task id had nowhere to
 * land, and that is why the row's "View Output" item was gated off.
 *
 * A member of the SAME union rather than a second piece of state, deliberately:
 * `handleCloseOverlay` is one `setOverlayState(null)`, the members are mutually
 * exclusive by construction, and Escape/backdrop/close-button all keep working with
 * no new wiring. A parallel `useState` would have been a second close path and a
 * pair of overlays that can both be open.
 *
 * Snapshot semantics, on purpose — see the task chip's Open (`BackgroundTaskChip.tsx`, UB14.7). `running`
 * is carried so the overlay can be honest that more may follow.
 *
 * UB12.79 — v0.15.1's `TaskOutputOverlayState` (`{ type, title, output }`, imported from `task-output.ts`), whose
 * text arm is still DERIVED from `TerminalOverlayData` rather than restated (`OpenedTaskOutput`): the first version
 * restated it and the two drifted — `taskId` never reached this state, so the live still-running check had nothing
 * to key on. An intersection makes a new field a compile error instead of a silent omission.
 */

/**
 * P2.425 — the rewind menu, the surface `/rewind` opens.
 * `checkpointing.md#rewind-and-summarize`: "Run `/rewind`, or press `Esc` twice
 * when the prompt input is empty, to open the rewind menu."
 *
 * A member of the SAME union as every other overlay, for the reason spelled out
 * on `TaskOutputOverlayState`: one `handleCloseOverlay`, mutual exclusion by
 * construction, and backdrop/close-button exits with no new wiring. The anchor
 * the user has highlighted rides in the state rather than in a parallel
 * `useState`, so closing the menu cannot leave a stale selection behind.
 */
interface RewindOverlayState {
  type: 'rewind'
  /** The highlighted prompt's message id; `null` only when the session has none. */
  selectedId: string | null
}

/** Union of all overlay states, or null for no overlay */
type OverlayState =
  | { type: 'activity'; activity: ActivityItem }
  | MultiDiffOverlayState
  | MarkdownOverlayState
  | TaskOutputOverlayState
  | RewindOverlayState
  | { type: 'agents' }
  | { type: 'context' }
  | { type: 'usage' }
  | null

function isStackedActivityTool(activity: ActivityItem): boolean {
  const toolName = activity.toolName?.toLowerCase() || ''
  return toolName === 'bash'
    || isStackedOrchestrationTool(toolName)
    || toolName === 'workflow'
    || toolName.startsWith('mcp__')
    || toolName.startsWith('browser_')
}

function getTurnKey(turn: Turn): string {
  if (turn.type === 'user') return `user-${turn.message.id}`
  if (turn.type === 'system') return `system-${turn.message.id}`
  if (turn.type === 'auth-request') return `auth-${turn.message.id}`
  return `turn-${turn.turnId}-${turn.timestamp}`
}

interface ChatDisplayProps {
  session: Session | null
  /** P6.480 — `midStreamOverride` asks for the other follow-up behaviour for THIS send only. */
  onSendMessage: (message: string, attachments?: FileAttachment[], skillSlugs?: string[], customSlashCommandId?: import('@nessy-agent/shared/slash-commands/common').CustomSlashCommandId, midStreamOverride?: 'steer' | 'queue') => void
  onOpenFile: (path: string) => void
  onOpenUrl: (url: string) => void
  // Model selection
  currentModel: string
  onModelChange: (model: string, connection?: string) => void
  // Connection selection (locked after first message)
  /** Callback when LLM connection changes (only works when session is empty) */
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
  /** Ref for the input, used for external focus control */
  textareaRef?: React.RefObject<RichTextInputHandle>
  /** When true, disables input (e.g., when agent needs activation) */
  disabled?: boolean
  /** Pending permission request for this session */
  pendingPermission?: PermissionRequest
  /** Callback to respond to permission request */
  onRespondToPermission?: (
    sessionId: string,
    requestId: string,
    allowed: boolean,
    alwaysAllow: boolean,
    options?: import('../../../shared/types').PermissionResponseOptions
  ) => void
  /** Pending credential request for this session */
  pendingCredential?: CredentialRequest
  /** Callback to respond to credential request */
  onRespondToCredential?: (sessionId: string, requestId: string, response: CredentialResponse) => void
  // Thinking level (session-level setting)
  /** Current thinking level ('off', 'think', 'max') */
  thinkingLevel?: ThinkingLevel
  /** Callback when thinking level changes */
  onThinkingLevelChange?: (level: ThinkingLevel) => void
  // Advanced options
  /** Current permission mode */
  permissionMode?: PermissionMode
  onPermissionModeChange?: (mode: PermissionMode) => void
  /** Enabled permission modes for Shift+Tab cycling */
  enabledModes?: PermissionMode[]
  // Input value preservation (controlled from parent)
  /** Current input value - preserved across mode switches and conversation changes */
  inputValue?: string
  /** Callback when input value changes */
  onInputChange?: (value: string) => void
  /** Whether `inputValue` was prefilled by a deep link Nessy did not produce */
  promptFromExternalLink?: boolean
  /** Persisted attachment draft for this session (hydrated from disk in ChatPage) */
  attachmentsValue?: FileAttachment[]
  /** Callback when attachment draft changes (add, remove, clear on send) */
  onAttachmentsChange?: (attachments: FileAttachment[]) => void
  // Source selection
  /** Available sources (enabled only) */
  sources?: SafeCapabilitySummary[]
  /** Callback when source selection changes */
  onSourcesChange?: (slugs: string[]) => void
  // Skill selection (for @mentions)
  /** Available skills for @mention autocomplete */
  skills?: SafeCapabilitySummary[]
  // Label selection (for the composer's # menu; the chips themselves live in the chat header)
  /** Available label configs (tree) for the label menu */
  labels?: import('@nessy-agent/shared/labels').LabelConfig[]
  /** Callback when labels change */
  onLabelsChange?: (labels: string[]) => void
  // UB14.15 — v0.15.1 removed `sessionStatuses` / `onSessionStatusChange` here: the status picker
  // lives in the chat header (UB14.6), and no caller of ChatDisplay passed either.
  /** Workspace ID for loading skill icons */
  workspaceId?: string
  // Working directory (per session)
  /** Current working directory for this session */
  workingDirectory?: string
  /** Callback when working directory changes */
  onWorkingDirectoryChange?: (project: IssuedProjectHandle) => void
  /** Reset the session to its managed cwd. */
  onResetToSession?: () => void
  /**
   * P6.424 — the plugin suggestion this session may show below the spinner.
   *
   * Optional and undefined on the shipped default: the whole suggestion surface
   * is managed-fleet-only by the page's own design, because the allowlist key
   * `pluginSuggestionMarketplaces` is managed-settings-only. The decision that
   * fills it is `selectPluginSuggestion`, the same one behind the session-start
   * notice and the Discover pin, so the three never name different plugins.
   */
  pluginSuggestionTip?: PluginSuggestionTipData
  /**
   * P6.334 — work the agent proposed and did NOT start.
   *
   * A deferred `spawn_session`. Empty (the default) renders nothing at all, and
   * the plate collapses with the rest of the stack.
   */
  deferredSpawns?: readonly DeferredSpawnProposal[]
  /** Called when a proposal is started or dismissed, so it stops being offered. */
  onResolveDeferredSpawn?: (id: string) => void
  // Lazy loading
  /** When true, messages are still loading - show spinner in messages area */
  messagesLoading?: boolean
  /** Message load failure shown instead of an infinite spinner */
  messagesLoadError?: string | null
  /** Whether a retry is currently in flight */
  messagesRetrying?: boolean
  /** Retry lazy-loading the session transcript */
  onRetryMessagesLoad?: () => void
  // Tutorial
  /** Disable send action (for tutorial guidance) */
  disableSend?: boolean
  // Search highlighting (from session list search)
  /** Search query for highlighting matches - passed from session list */
  searchQuery?: string
  /** Whether search mode is active (prevents focus stealing to chat input) */
  isSearchModeActive?: boolean
  /** Callback when match info changes - for immediate UI updates */
  onMatchInfoChange?: (info: { count: number; index: number; isHighlighting: boolean; sessionId: string | null }) => void
  // Compact mode (for EditPopover embedding and auto-compact / WebUI mobile)
  /** Enable compact mode - hides non-essential UI elements for popover embedding */
  compactMode?: boolean
  /**
   * When compactMode is true, enable the compact (drawer-based) model selector
   * next to the permission-mode pill. Defaults to false so EditPopover keeps
   * its current behavior; ChatPage opts in when in auto-compact / mobile.
   */
  enableCompactModelPicker?: boolean
  /** Custom placeholder for input (used in compact mode for edit context) */
  placeholder?: string | string[]
  /**
   * D1.375 — `hideInput` USED TO SIT HERE and no longer exists. It hid the
   * composer for the `/btw` side-question panel, its only caller, on
   * `interactive-mode.md:369`; the owner met that panel in use on 2026-09-18
   * and ruled a side question is a chat the user can type into. A prop whose
   * one consumer is gone is deleted rather than kept as a supported way to ship
   * a chat with no input, so every embedding now renders `ChatInputZone`.
   */
  /** The compact empty state's own sentence. D1.382 — it used to be declared, destructured and READ BY NOTHING, so the `/btw` panel greeted the user with the edit popover's "What would you like to change?"; a caller that names one now owns the whole empty state, and one that names none keeps the two-line default below. */
  emptyStateLabel?: string
  /** When true, the session's locked connection has been removed - disables send and shows unavailable state */
  connectionUnavailable?: boolean
}

import {
  formatFollowUpSection,
  normalizeFollowUpsMarkdown,
  truncateForChipTooltip,
  type PendingFollowUpAnnotation,
} from './ChatDisplay.follow-ups'

/**
 * Imperative handle exposed via forwardRef for navigation between matches
 */
export interface ChatDisplayHandle {
  goToNextMatch: () => void
  goToPrevMatch: () => void
  matchCount: number
  currentMatchIndex: number
  isHighlighting: boolean
}

/** A stable empty default, so the plate does not re-render on every parent pass. */
const EMPTY_DEFERRED_SPAWNS: readonly DeferredSpawnProposal[] = []

/**
 * ChatDisplay - Main chat interface for a selected session
 *
 * Structure:
 * - Session Header: Avatar + workspace name
 * - Messages Area: Scrollable list of MessageBubble components
 * - Input Area: Textarea + Send button
 *
 * Shows empty state when no session is selected
 */
export const ChatDisplay = React.forwardRef<ChatDisplayHandle, ChatDisplayProps>(function ChatDisplay({
  session,
  onSendMessage,
  onOpenFile,
  onOpenUrl,
  currentModel,
  onModelChange,
  onConnectionChange,
  onPreviewConnectionChange,
  textareaRef: externalTextareaRef,
  disabled = false,
  pendingPermission,
  onRespondToPermission,
  pendingCredential,
  onRespondToCredential,
  // Thinking level
  thinkingLevel = 'medium',
  onThinkingLevelChange,
  // Advanced options
  permissionMode = 'default',
  onPermissionModeChange,
  enabledModes,
  // Input value preservation
  inputValue,
  onInputChange,
  promptFromExternalLink,
  attachmentsValue,
  onAttachmentsChange,
  // Sources
  sources,
  onSourcesChange,
  // Skills (for @mentions)
  skills,
  // Labels (for #labels)
  labels,
  onLabelsChange,
  workspaceId,
  // Working directory
  workingDirectory,
  onWorkingDirectoryChange,
  onResetToSession,
  pluginSuggestionTip,
  deferredSpawns = EMPTY_DEFERRED_SPAWNS,
  onResolveDeferredSpawn,
  // Lazy loading
  messagesLoading = false,
  messagesLoadError,
  messagesRetrying = false,
  onRetryMessagesLoad,
  // Tutorial
  disableSend = false,
  // Search highlighting
  searchQuery: externalSearchQuery,
  isSearchModeActive = false,
  onMatchInfoChange,
  // Compact mode (for EditPopover embedding and auto-compact / WebUI mobile)
  compactMode = false,
  enableCompactModelPicker = false,
  placeholder,
  // (D1.375 — the `hideInput` destructure that sat here went with the prop.)
  emptyStateLabel,
  // Connection unavailable
  connectionUnavailable = false,
}, ref) {
  const { t, i18n } = useTranslation()

  // Panel focus state (for multi-panel auto-scroll behavior)
  const appShellContext = useAppShellContext()
  const isFocusedPanel = appShellContext?.isFocusedPanel ?? true

  // Input is only disabled when explicitly disabled (e.g., agent needs activation)
  // User can type during streaming - submitting will stop the stream and send
  const isInputDisabled = disabled
  const messagesEndRef = React.useRef<HTMLDivElement>(null)
  const scrollViewportRef = React.useRef<HTMLDivElement>(null)
  const prevSessionIdRef = React.useRef<string | null>(null)
  // Reverse pagination: show last N turns initially, load more on scroll up
  const TURNS_PER_PAGE = 20
  const [visibleTurnCount, setVisibleTurnCount] = React.useState(TURNS_PER_PAGE)
  // Sticky-bottom: When true, auto-scroll on content changes. Toggled by user scroll behavior.
  const isStickToBottomRef = React.useRef(true)
  // Mirror isFocusedPanel into a ref so the ResizeObserver closure reads the latest value
  const isFocusedPanelRef = React.useRef(isFocusedPanel)
  isFocusedPanelRef.current = isFocusedPanel
  // Skip smooth scroll briefly after session switch (instant scroll already happened)
  const skipSmoothScrollUntilRef = React.useRef(0)
  // Track message commit boundaries so we can auto-scroll when a new user message
  // actually lands in state (important when attachments delay optimistic insertion).
  const prevLastMessageIdRef = React.useRef<string | null>(null)
  const prevMessageCountRef = React.useRef(0)
  const prevSessionIdForCommitScrollRef = React.useRef<string | null>(null)
  const internalTextareaRef = React.useRef<RichTextInputHandle>(null)
  const textareaRef = externalTextareaRef || internalTextareaRef
  const [sendMessageKey, setSendMessageKey] = useState<'enter' | 'cmd-enter'>('enter')
  const [openAnnotationRequest, setOpenAnnotationRequest] = React.useState<{
    messageId: string
    annotationId: string
    mode: 'view' | 'edit'
    anchorX?: number
    anchorY?: number
    nonce: number
  } | null>(null)
  const followUpOpenNonceRef = React.useRef(0)

  // Navigation for session branching
  const { navigate } = useNavigation()

  // Get isDark from useTheme hook for overlay theme
  // This accounts for scenic themes (like Haze) that force dark mode
  const { isDark } = useTheme()

  // Register as focus zone - when zone gains focus, focus the textarea
  // Guard with isFocusedPanelRef so only the focused panel responds in multi-panel layouts
  const { zoneRef, isFocused } = useFocusZone({
    zoneId: 'chat',
    enabled: isFocusedPanel,
    focusFirst: () => {
      if (isFocusedPanelRef.current) {
        textareaRef.current?.focus()
      }
    },
  })

  // Background tasks management. This is the `/tasks` namespace — running shells
  // and subagents — and is deliberately NOT the task checklist below.
  const { tasks: backgroundTasks, stopTask, dismissTask } = useBackgroundTasks({
    sessionId: session?.id ?? ''
  })

  // R29b: the observe-and-steer panel (sub-agents.md:1021). Always on when the
  // session has children, because `:1019` makes it the place a `/subtask` fork
  // becomes visible at all; it renders nothing when there are none.
  const agentPanel = useAgentPanel(session && !isRendererMintedSessionId(session.id) ? session.id : '', session?.workspaceId ?? '') // F1.167 — the host throws `session-not-found` for a minted id

  // R20: the session task checklist surface (interactive-mode.md:36). Opens with
  // the `view.toggleTaskChecklist` binding; a no-op when the list is empty.
  const [taskChecklistOpen, setTaskChecklistOpen] = useState(false)
  useAction('view.toggleTaskChecklist', () => setTaskChecklistOpen(open => !open))

  // P6.469 · the one transcript view mode, on one key, identical on all three
  // runtimes because the transcript is host-rendered from one event stream.
  // The toast is the whole discoverability of a cycling key: without it the
  // third press looks like the first, and Summary looks like a broken session.
  const { verbosity: transcriptVerbosity, cycle: cycleTranscriptView } = useTranscriptVerbosity()
  useAction('view.cycleTranscriptVerbosity', () => {
    const next = cycleTranscriptView()
    toast.info(t('chat.transcriptVerbosity.switched', { mode: t(`chat.transcriptVerbosity.${next}`) }), {
      description: t(`chat.transcriptVerbosity.${next}Description`),
      duration: 2500,
    })
  })

  /**
   * P6.793 — the press that moves the tool call this turn is blocked on into
   * the background, so the turn continues.
   *
   * NATIVE on claude and read for the first time here: `Query.backgroundTasks`
   * has shipped in the vendored SDK since 0.3.233 with no host caller at all.
   * The SDK's own words for what happens next — *"Each blocking tool call
   * returns immediately with a 'running in the background' tool_result and the
   * turn continues; the task keeps running and emits a task_notification when it
   * settles"* — are why SUCCESS IS SILENT here: the composer frees, the turn
   * resumes and the task notification becomes a background-task row (P6.109).
   * A toast would be a second voice describing an event the transcript already
   * shows, which is not what its `view.cycleTranscriptVerbosity` neighbour above
   * needs a toast for (a key whose third press looks like its first).
   *
   * FAILURE IS NOT SILENT, and that is the codex half of this row: on a runtime
   * with no such lever the press would otherwise look accepted and change
   * nothing. Three sentences for three states, because "this runtime cannot",
   * "nothing was blocking" and "the lever went wrong" are three different facts
   * and only the last is a problem.
   *
   * Gated on a HOST turn in flight: with none there is nothing to background, and
   * (F1.179) the `/btw` panel's pending answer is `isProcessing` over an id no
   * server knows — first-enabled-wins would otherwise send this chord there.
   */
  useAction('chat.backgroundInFlightTask', async () => {
    const sessionId = session?.id
    if (!sessionId) return
    const result = await window.electronAPI.sessionCommand(sessionId, { type: 'backgroundInFlightTasks' })
    // The command union is wide; `backgrounded` is this member's own field.
    if (!result || !(typeof result === 'object') || !('backgrounded' in result)) return
    if (result.backgrounded) return
    if (result.reason === 'nothing-running') {
      toast.info(t('chat.backgroundInFlight.nothingRunning'), { duration: 2500 })
      return
    }
    if (result.reason === 'unsupported') {
      toast.info(t('chat.backgroundInFlight.unsupported'), { duration: 3500 })
      return
    }
    toast.error(t('chat.backgroundInFlight.failed'), {
      description: result.error || t('toast.unknownError'),
    })
  }, { enabled: () => isHostTurnInFlight(session) })

  // TurnCard expansion state — persisted to localStorage across session switches
  const {
    expandedTurns,
    toggleTurn,
    expandedActivityGroups,
    setExpandedActivityGroups,
  } = useTurnCardExpansion(session?.id)


  // ============================================================================
  // Search Highlighting (from session list search)
  // ============================================================================
  // Current match index for navigation (internal state, exposed via ref)
  const [currentMatchIndex, setCurrentMatchIndex] = useState(0)
  const turnRefs = React.useRef<Map<string, HTMLDivElement>>(new Map())
  const registerTurnRef = useCallback((turnKey: string, el: HTMLDivElement | null) => {
    if (el) turnRefs.current.set(turnKey, el)
    else turnRefs.current.delete(turnKey)
  }, [])
  // Inject ::highlight() styles at runtime to avoid LightningCSS build warnings
  // (the optimizer doesn't recognize ::highlight as a valid pseudo-element yet)
  React.useEffect(() => {
    const id = 'search-highlight-styles'
    if (document.getElementById(id)) return
    const style = document.createElement('style')
    style.id = id
    style.textContent = `
      ::highlight(search-passive) { background-color: rgb(253 224 71 / 0.3); color: inherit; }
      ::highlight(search-active) { background-color: rgb(253 224 71); color: rgb(0 0 0 / 0.9); }
    `
    document.head.appendChild(style)
  }, [])
  // Flag to control when scrolling to matches should happen
  // Only scroll when: session changes with search active, or user clicks navigation
  const shouldScrollToMatchRef = React.useRef(false)
  const prevSessionIdForScrollRef = React.useRef<string | null>(null)

  // Use the external search query from props
  const searchQuery = externalSearchQuery || ''
  // Require 2+ characters to activate in-chat search (aligned with session list isSearchMode)
  const isSearchActive = searchQuery.trim().length >= 2

  // Focus textarea when zone gains focus via keyboard (Tab, Cmd+3, ArrowRight)
  // Requires isFocused to be true - respects zone architecture
  // Does NOT auto-focus just because session changed (that would steal focus from SessionList)
  // Uses isSearchModeActive (prop) instead of isSearchActive (query-based) to prevent
  // focus stealing when search is open but query is empty
  // In multi-panel layouts, only the focused panel should auto-focus its textarea
  useEffect(() => {
    if (session && !isSearchModeActive && isFocused && isFocusedPanel) {
      textareaRef.current?.focus()
    }
  }, [session?.id, isFocused, isSearchModeActive, isFocusedPanel])

  useEffect(() => {
    let isMounted = true

    const loadSendMessageKey = async () => {
      if (!window.electronAPI) return

      try {
        const key = await window.electronAPI.getSendMessageKey()
        if (!isMounted) return
        setSendMessageKey(key ?? 'enter')
      } catch (error) {
        console.error('Failed to load send message key for follow-up view:', error)
      }
    }

    loadSendMessageKey()

    return () => {
      isMounted = false
    }
  }, [])

  // Reset match state when session or search query changes
  useEffect(() => {
    const isSessionSwitch = prevSessionIdForScrollRef.current !== null && prevSessionIdForScrollRef.current !== session?.id
    prevSessionIdForScrollRef.current = session?.id ?? null

    // If session switched with search active, trigger scroll to first match
    if (isSessionSwitch && isSearchActive) {
      shouldScrollToMatchRef.current = true
    }

    setCurrentMatchIndex(0)
  }, [session?.id, searchQuery, isSearchActive])

  // Helper to count occurrences of a substring
  const countOccurrences = useCallback((text: string, query: string): number => {
    const lowerText = text.toLowerCase()
    const lowerQuery = query.toLowerCase()
    let count = 0
    let pos = 0
    while ((pos = lowerText.indexOf(lowerQuery, pos)) !== -1) {
      count++
      pos += lowerQuery.length
    }
    return count
  }, [])

  // Find ALL individual match occurrences (not just turns)
  // Returns array with unique matchId for each occurrence
  const matchingOccurrences = useMemo(() => {
    if (!searchQuery.trim() || !session?.messages) return []
    const startTime = performance.now()
    const query = searchQuery.toLowerCase()
    const turns = groupMessagesByTurn(session.messages, { isSessionProcessing: session.isProcessing })
    const matches: { matchId: string; turnId: string; turnIndex: number; matchIndexInTurn: number }[] = []

    for (let turnIndex = 0; turnIndex < turns.length; turnIndex++) {
      const turn = turns[turnIndex]
      let textContent = ''
      let turnId = ''

      // Use getTurnKey() for consistent IDs between text scan and DOM refs
      turnId = getTurnKey(turn)

      if (turn.type === 'user') {
        const content = turn.message.content as unknown
        if (typeof content === 'string') {
          textContent = content
        } else if (Array.isArray(content)) {
          textContent = content
            .filter((block: { type?: string }) => block.type === 'text')
            .map((block: { text?: string }) => block.text || '')
            .join('\n')
        }
      } else if (turn.type === 'assistant') {
        if (turn.response?.text) {
          textContent = turn.response.text
        }
      } else if (turn.type === 'system') {
        textContent = turn.message.content
      }

      // Count occurrences in this turn's text content
      const occurrenceCount = countOccurrences(textContent, query)
      for (let i = 0; i < occurrenceCount; i++) {
        matches.push({
          matchId: `${turnId}-match-${i}`,
          turnId,
          turnIndex,
          matchIndexInTurn: i,
        })
      }
    }
    return matches
  }, [searchQuery, session?.messages, session?.isProcessing, countOccurrences])

  // Auto-expand pagination when search is active to show all matching turns
  // This ensures match count is stable and all matches are highlightable from the start
  useEffect(() => {
    if (!isSearchActive || matchingOccurrences.length === 0) return

    // Find the earliest matching turn index (reduce to avoid RangeError on large arrays)
    const earliestMatchTurnIndex = matchingOccurrences.reduce(
      (min, m) => m.turnIndex < min ? m.turnIndex : min,
      matchingOccurrences[0]!.turnIndex
    )
    const totalTurns = groupMessagesByTurn(session?.messages || [], { isSessionProcessing: session?.isProcessing }).length

    // Calculate how many turns we need to show to include all matches
    // totalTurns - visibleTurnCount = startIndex, so we need visibleTurnCount = totalTurns - earliestMatchTurnIndex + buffer
    const requiredVisibleCount = totalTurns - earliestMatchTurnIndex + 5 // +5 buffer for context

    if (requiredVisibleCount > visibleTurnCount) {
      setVisibleTurnCount(requiredVisibleCount)
    }
  }, [isSearchActive, matchingOccurrences, session?.messages, session?.isProcessing, visibleTurnCount])

  // Extract unique turn IDs that have matches (for highlighting)
  const matchingTurnIds = useMemo(() => {
    const uniqueTurnIds = new Set(matchingOccurrences.map(m => m.turnId))
    return Array.from(uniqueTurnIds)
  }, [matchingOccurrences])

  // With CSS Custom Highlight API, navigation is driven by logical matches — no DOM verification needed.
  const validMatches = matchingOccurrences

  // Auto-scroll to match ONLY when there's exactly one match
  // Multiple matches: user navigates with chevrons to avoid jarring scroll
  useEffect(() => {
    if (validMatches.length === 1 && isSearchActive) {
      shouldScrollToMatchRef.current = true
    }
  }, [validMatches.length, isSearchActive])

  // Scroll to current match turn
  // Only scrolls when shouldScrollToMatchRef is true (single match auto-scroll or nav button click)
  useEffect(() => {
    if (!shouldScrollToMatchRef.current) return

    if (validMatches.length > 0 && currentMatchIndex < validMatches.length) {
      const matchData = validMatches[currentMatchIndex]
      const { turnId, turnIndex } = matchData
      const totalTurns = totalTurnCountRef.current

      // Check if the match is outside the visible range
      const currentStartIndex = Math.max(0, totalTurns - visibleTurnCount)
      if (turnIndex < currentStartIndex) {
        const newVisibleCount = totalTurns - turnIndex + 5
        setVisibleTurnCount(newVisibleCount)
        return
      }

      // Scroll the turn into view
      const turnEl = turnRefs.current.get(turnId)
      if (turnEl) {
        const rect = turnEl.getBoundingClientRect()
        const buffer = 128
        const isVisible = rect.top >= buffer && rect.bottom <= window.innerHeight - buffer
        if (!isVisible) {
          turnEl.scrollIntoView({ behavior: 'instant', block: 'center' })
        }
      }
      shouldScrollToMatchRef.current = false
    }
  }, [validMatches, currentMatchIndex, session?.id, visibleTurnCount])

  // ---------------------------------------------------------------------------
  // CSS Custom Highlight API — non-destructive text highlighting
  // Creates browser-native highlight ranges over matching text without
  // modifying the DOM tree. Safe with React re-renders and streaming.
  // Uses cross-node matching: concatenates text across node boundaries
  // to find matches that span multiple DOM nodes (e.g. Shiki-split tokens).
  // ---------------------------------------------------------------------------

  const MAX_HIGHLIGHT_RANGES = 5000
  // Store computed ranges so the active-match effect can restyle without re-walking the DOM
  const highlightRangesRef = React.useRef<Range[]>([])

  // Effect 1: Walk DOM and collect highlight ranges when search/session/pagination changes
  useEffect(() => {
    const cssHighlights = getCSSHighlights()
    highlightRangesRef.current = []

    // Clear previous highlights
    try {
      cssHighlights?.delete('search-passive')
      cssHighlights?.delete('search-active')
    } catch { /* API unavailable — no-op */ }

    if (!searchQuery.trim() || !isSearchActive || !cssHighlights) return

    const query = searchQuery.toLowerCase()
    const matchingTurnIdSet = new Set(matchingTurnIds)
    if (matchingTurnIdSet.size === 0) return

    const rafId = requestAnimationFrame(() => {
      const allRanges: Range[] = []

      turnRefs.current.forEach((container, turnKey) => {
        if (allRanges.length >= MAX_HIGHLIGHT_RANGES) return
        if (!matchingTurnIdSet.has(turnKey)) return

        // For assistant turns, narrow search to response content root
        const searchRoot = container.querySelector('[data-search-root="response"]') || container

        // Collect ALL eligible text nodes (no query filter — needed for cross-node matching)
        const walker = document.createTreeWalker(
          searchRoot,
          NodeFilter.SHOW_TEXT,
          {
            acceptNode: (node) => {
              const parent = node.parentElement
              if (!parent) return NodeFilter.FILTER_REJECT
              const tag = parent.tagName.toLowerCase()
              if (tag === 'script' || tag === 'style') return NodeFilter.FILTER_REJECT
              if (parent.closest('[data-search-exclude="true"]')) return NodeFilter.FILTER_REJECT
              return NodeFilter.FILTER_ACCEPT
            },
          }
        )

        // Build concatenated string with node offset mapping for cross-node matching
        const textNodes: Text[] = []
        let currentNode: Node | null
        while ((currentNode = walker.nextNode())) {
          textNodes.push(currentNode as Text)
        }
        if (textNodes.length === 0) return

        const nodeOffsets: { node: Text; start: number; end: number }[] = []
        let totalLength = 0
        for (const node of textNodes) {
          const text = node.textContent || ''
          nodeOffsets.push({ node, start: totalLength, end: totalLength + text.length })
          totalLength += text.length
        }
        const concatenated = textNodes.map(n => n.textContent || '').join('')
        const lowerConcatenated = concatenated.toLowerCase()

        // Find all matches in the concatenated string
        let searchPos = 0
        while (searchPos < lowerConcatenated.length && allRanges.length < MAX_HIGHLIGHT_RANGES) {
          const idx = lowerConcatenated.indexOf(query, searchPos)
          if (idx === -1) break
          const matchEnd = idx + query.length

          // Create a Range spanning the match (may cross node boundaries)
          try {
            const range = new Range()
            let startSet = false

            for (const offset of nodeOffsets) {
              if (offset.end <= idx) continue
              if (offset.start >= matchEnd) break

              if (!startSet) {
                range.setStart(offset.node, idx - offset.start)
                startSet = true
              }
              range.setEnd(offset.node, Math.min(offset.end - offset.start, matchEnd - offset.start))
            }

            if (startSet) {
              allRanges.push(range)
            }
          } catch {
            // Range creation can fail if node was removed during walk
          }

          searchPos = matchEnd
        }
      })

      // Store ranges for the active-match effect to use
      highlightRangesRef.current = allRanges

      if (allRanges.length === 0 && matchingTurnIdSet.size > 0) {
        console.warn('[search-highlight] 0 ranges from', matchingTurnIdSet.size, 'matching turns — possible turn ID mismatch')
      }

      if (allRanges.length === 0) return

      try {
        // Apply all ranges as passive initially — the active-match effect will restyle
        cssHighlights.set('search-passive', new Highlight(...allRanges))
      } catch {
        // Highlight API call failed — degrade gracefully
      }
    })

    return () => cancelAnimationFrame(rafId)
  }, [searchQuery, isSearchActive, matchingTurnIds, session?.id, visibleTurnCount])

  // Effect 2: Update active/passive highlight split when navigation index changes
  // Lightweight — just reshuffles existing Range objects between two Highlight instances
  useEffect(() => {
    const cssHighlights = getCSSHighlights()
    const allRanges = highlightRangesRef.current
    if (!cssHighlights || allRanges.length === 0) return

    try {
      const activeRange = allRanges[currentMatchIndex]
      if (activeRange) {
        const passiveRanges = allRanges.filter((_, i) => i !== currentMatchIndex)
        cssHighlights.set('search-passive', new Highlight(...passiveRanges))
        cssHighlights.set('search-active', new Highlight(activeRange))
      } else {
        cssHighlights.set('search-passive', new Highlight(...allRanges))
        cssHighlights.delete('search-active')
      }
    } catch { /* graceful degradation */ }
  }, [currentMatchIndex])

  // Navigate to next match (no looping - stops at last match)
  const goToNextMatch = useCallback(() => {
    if (validMatches.length === 0) return
    setCurrentMatchIndex(prev => {
      // Don't loop - stop at last match
      if (prev >= validMatches.length - 1) return prev
      shouldScrollToMatchRef.current = true
      return prev + 1
    })
  }, [validMatches])

  // Navigate to previous match (no looping - stops at first match)
  const goToPrevMatch = useCallback(() => {
    if (validMatches.length === 0) return
    setCurrentMatchIndex(prev => {
      // Don't loop - stop at first match
      if (prev <= 0) return prev
      shouldScrollToMatchRef.current = true
      return prev - 1
    })
  }, [validMatches])

  // With CSS Highlight API, highlighting is instant — no settling phase
  const isHighlighting = false

  // Expose navigation via imperative handle (for session list navigation controls)
  React.useImperativeHandle(ref, () => ({
    goToNextMatch,
    goToPrevMatch,
    matchCount: validMatches.length,
    currentMatchIndex,
    isHighlighting,
  }), [goToNextMatch, goToPrevMatch, validMatches.length, currentMatchIndex])

  // Notify parent when match info (count, index, highlighting state) changes
  useEffect(() => {
    onMatchInfoChange?.({
      count: validMatches.length,
      index: currentMatchIndex,
      isHighlighting,
      sessionId: session?.id ?? null,
    })
  }, [validMatches.length, currentMatchIndex, isHighlighting, session?.id, onMatchInfoChange])

  // ============================================================================
  // Overlay State Management
  // ============================================================================

  // Overlay state - controls which overlay is shown (if any)
  const [overlayState, setOverlayState] = useState<OverlayState>(null)
  /**
   * P6.103 — the anchors a file-restoring rewind would revert something for.
   *
   * `undefined` is UNKNOWN and offers the action for every anchor, which is what
   * the menu did before this row. Held here rather than in `overlayState` so the
   * menu can open immediately and the answer can land after it.
   */
  const [rewindTrackedIds, setRewindTrackedIds] = useState<readonly string[] | undefined>(undefined)

  // Diff viewer settings - loaded from user preferences on mount, persisted on change
  // These settings are stored in ~/.nessy-agent/preferences.json (not localStorage)
  const [diffViewerSettings, setDiffViewerSettings] = useState<Partial<DiffViewerSettings>>({})

  // Load diff viewer settings from preferences on mount
  useEffect(() => {
    window.electronAPI.readPreferences().then(({ content }) => {
      try {
        const prefs = JSON.parse(content)
        if (prefs.diffViewer) {
          setDiffViewerSettings(prefs.diffViewer)
        }
      } catch {
        // Ignore parse errors, use defaults
      }
    })
  }, [])

  // Persist diff viewer settings to preferences when changed
  const handleDiffViewerSettingsChange = useCallback((settings: DiffViewerSettings) => {
    setDiffViewerSettings(settings)
    // Read current preferences, merge in new settings, write back
    window.electronAPI.readPreferences().then(({ content }) => {
      try {
        const prefs = JSON.parse(content)
        prefs.diffViewer = settings
        prefs.updatedAt = Date.now()
        window.electronAPI.writePreferences(JSON.stringify(prefs, null, 2))
      } catch {
        // If preferences malformed, create fresh with just diffViewer
        window.electronAPI.writePreferences(JSON.stringify({ diffViewer: settings, updatedAt: Date.now() }, null, 2))
      }
    })
  }, [])

  // Close overlay handler
  const handleCloseOverlay = useCallback(() => {
    setOverlayState(null)
  }, [])

  // L9 — the background-task row's output lands here. The SAME `setOverlayState`
  // and therefore the same `handleCloseOverlay`; see `TaskOutputOverlayState`.
  /**
   * P2.425 — open the rewind menu on the newest prompt.
   *
   * Pre-selecting the newest rather than the oldest is the only ordering choice
   * this menu makes that the page does not state: the list itself stays
   * chronological so it matches the transcript above it, and the rewind target
   * is overwhelmingly the most recent turn.
   */
  const handleOpenRewindMenu = useCallback(() => {
    const prompts = collectRewindPrompts(session?.messages ?? [])
    setOverlayState({ type: 'rewind', selectedId: prompts.length > 0 ? prompts[prompts.length - 1]!.id : null })
    // P6.103 · ask which anchors a file-restoring rewind would revert something
    // for. Cleared FIRST so a stale answer from a previous open — or from
    // another session — cannot gate this one. D1.378 · `undefined` is the
    // unknown state and WITHHOLDS the file-restoring action, because this clear
    // runs at EVERY open: the menu opens without waiting, and the button
    // appears only once the session answers with something to restore.
    setRewindTrackedIds(undefined)
    const openedFor = session?.id
    if (!openedFor) return
    void (async () => {
      try {
        const result = await window.electronAPI.sessionCommand(openedFor, {
          type: 'rewindTrackedChanges',
        }) as RewindTrackedChangesResult | undefined
        // D1.378 · keep the unknown state on anything but a definite answer (it
        // WITHHOLDS), and ignore an answer for a session the user has left.
        if (!result?.success || !result.messageIds) return
        setRewindTrackedIds(current => (openedFor === session?.id ? result.messageIds : current))
      } catch {
        // D1.378 · a throw leaves the answer unknown, which now WITHHOLDS.
      }
    })()
  }, [session?.messages, session?.id])

  // A background task's full output, from its chip card (UB12.79, v0.15.1)
  const handleOpenTaskOutput = useCallback((task: { id: string; intent?: string }, output: OpenedTaskOutput) => {
    setOverlayState({ type: 'task-output', title: task.intent?.trim() || task.id, output })
  }, [])

  // "Run in background" on a shell/console code block: ask the agent to start it as a background
  // command (permissions apply; the task chip shows it). v0.15.1's `session ? handleRunCommand : null`,
  // plus our /btw and backgroundShell (UB12.91) arms — see `transcriptRunCommand`.
  const handleRunCommand = useMemo(
    () => transcriptRunCommand(session?.id, session?.composerCapabilities, (message) => onSendMessage(message)),
    [session?.id, session?.composerCapabilities, onSendMessage],
  )

  const handleOpenUsage = useCallback(() => {
    if (!session) return
    setOverlayState({ type: 'usage' })
  }, [session])

  const handleOpenContext = useCallback(() => {
    if (!session) return
    setOverlayState({ type: 'context' })
  }, [session])

  const handleOpenExport = useCallback(async () => {
    if (!session) return

    if (typeof window.electronAPI.saveTextFile !== 'function') {
      toast.error(t('sessionExport.unavailable'))
      return
    }

    try {
      const result = await window.electronAPI.sessionCommand(session.id, {
        type: 'exportTranscript',
        format: 'markdown',
      }) as SessionTranscriptExportResult

      if (!result?.success || !result.content) {
        toast.error(t('sessionExport.failed'), {
          description: result?.error || t('toast.unknownError'),
        })
        return
      }

      const saveResult = await window.electronAPI.saveTextFile({
        title: t('sessionExport.saveTitle'),
        defaultPath: result.defaultFilename ?? `${session.id}.md`,
        content: result.content,
        filters: [
          { name: t('sessionExport.markdownFiles'), extensions: ['md'] },
          { name: t('sessionExport.allFiles'), extensions: ['*'] },
        ],
      })

      if (saveResult.canceled) return

      if (saveResult.error) {
        toast.error(t('sessionExport.failed'), { description: saveResult.error })
        return
      }

      toast.success(t('sessionExport.saved'), {
        description: saveResult.filePath,
      })
    } catch (error) {
      toast.error(t('sessionExport.failed'), {
        description: error instanceof Error ? error.message : t('toast.unknownError'),
      })
    }
  }, [session, t])

  const handleOpenAgents = useCallback(() => {
    if (!session) return
    setOverlayState({ type: 'agents' })
  }, [session])

  /**
   * P6.278 — `/diff` picked from the composer menu opens the working-tree patch
   * in the viewer that already renders one.
   *
   * The route is the EXISTING `sessionCommand` channel, not a new IPC pair: the
   * answer is `git` run in the session's own directory, which is the same
   * "answered by the server that owns the session" property every other member
   * of that union has. A new channel would have meant four wire files and an
   * inventory regeneration for a read this one already routes.
   *
   * `MultiDiffPreviewOverlay` renders a `FileChange` per file with a
   * `unifiedDiff`, so the cut is per file and it is made SERVER-side by the one
   * parser of git's output this product keeps
   * (`slash-commands/diff-command.ts`) — the same parser the seam's `/diff`
   * summary counts with, so the two surfaces cannot describe different trees.
   *
   * Three outcomes, three answers, because a viewer that shows a clean tree and
   * a failed read as the same blank screen is worse than no viewer: a failed
   * read toasts the reason, a clean tree toasts that it is clean, and rows open
   * the overlay. `toolType: 'Edit'` on every row is the overlay's own
   * vocabulary for "this file changed" — nothing here claims a tool made the
   * change, and the working tree deliberately includes edits the user made
   * themselves.
   */
  const handleOpenWorkingTreeDiff = useCallback(async () => {
    if (!session) return
    try {
      const result = await window.electronAPI.sessionCommand(session.id, {
        type: 'workingTreeDiff',
      }) as unknown as WorkingTreeDiffResult

      if (!result?.success) {
        toast.error(t('chat.diffViewer.unavailable'))
        return
      }
      if (result.files.length === 0) {
        toast.success(t('chat.diffViewer.clean'))
        return
      }
      setOverlayState({
        type: 'multi-diff',
        changes: result.files.map((file, index) => ({
          id: `working-tree-${index}`,
          filePath: file.path,
          toolType: 'Edit' as const,
          original: '',
          modified: '',
          unifiedDiff: file.unifiedDiff,
        })),
        consolidated: false,
      })
    } catch (error) {
      toast.error(t('chat.diffViewer.unavailable'), {
        description: error instanceof Error ? error.message : t('toast.unknownError'),
      })
    }
  }, [session, t])

  const handleRunShellCommand = useCallback(async (sessionId: string, command: string): Promise<ShellCommandResult> => {
    const result = await window.electronAPI.sessionCommand(sessionId, {
      type: 'runShellCommand',
      command,
    }) as ShellCommandResult

    if (!result.executed) {
      toast.error(t('toast.shellCommandNotRun'), {
        description: result.error || t('toast.unknownError'),
      })
    }

    return result
  }, [t])

  const inputAppShellContext = useMemo(() => ({
    ...appShellContext,
    openAgents: handleOpenAgents,
    openContext: handleOpenContext,
    openExport: handleOpenExport,
    openUsage: handleOpenUsage,
    openWorkingTreeDiff: handleOpenWorkingTreeDiff,
    runShellCommand: handleRunShellCommand,
  }), [appShellContext, handleOpenAgents, handleOpenContext, handleOpenExport, handleOpenUsage, handleOpenWorkingTreeDiff, handleRunShellCommand])

  // Extract overlay cards for activity-based overlays (Input/Output, future extensible)
  const overlayCards = useMemo(() => {
    if (!overlayState || overlayState.type !== 'activity') return []
    return extractOverlayCards(overlayState.activity)
  }, [overlayState])

  // Parsed output data for legacy output-only activity overlays
  const activityOutputOverlayData = useMemo(() => {
    if (!overlayState || overlayState.type !== 'activity') return null
    return extractOverlayData(overlayState.activity)
  }, [overlayState])

  // Stacked input/output cards are enabled for tools with useful structured details
  const useStackedActivityOverlay = useMemo(() => {
    if (!overlayState || overlayState.type !== 'activity') return false
    return isStackedActivityTool(overlayState.activity)
  }, [overlayState])

  const handleInsertWorkflowResumePrompt = useCallback((prompt: string) => {
    onInputChange?.(prompt)
  }, [onInputChange])

  /**
   * P6.318 — whether this session may be offered "keep this run".
   *
   * `runtimeDispatchesWorkflows` is the SAME predicate the capability resolver,
   * `BaseAgent.canDispatchWorkflowCommands` and `saveSessionWorkflowRecipe` read,
   * so the offer here and the refusal there cannot answer differently. A runtime
   * that cannot dispatch a recipe is not shown the buttons at all: the server's
   * refusal is the backstop, not the affordance.
   */
  const canKeepWorkflowRun = runtimeDispatchesWorkflows(
    session?.composerCapabilities?.connection?.activeRuntime,
  )

  const handleKeepWorkflowRun = useCallback(async (scope: WorkflowSaveScope, source: string) => {
    if (!session) return
    try {
      const { path } = await window.electronAPI.saveSessionWorkflowRecipe(session.id, source, scope)
      // The SLASH COMMAND, not the path: `/<name>` dispatching it in a later
      // session is the whole point of keeping it, and the path is on whichever
      // machine runs the session rather than necessarily on this one.
      const name = path.split(/[\\/]/).pop()?.replace(/\.js$/, '') ?? ''
      toast.success(t('turnCard.workflow.keepSaved', { name }))
    } catch (error) {
      // Every refusal is the server's and names itself — workflows off for this
      // host, a runtime that cannot dispatch, a project scope with no trusted
      // directory. Showing the message is showing the reason.
      toast.error(t('turnCard.workflow.keepFailed'), {
        description: error instanceof Error ? error.message : String(error),
      })
    }
  }, [session, t])

  const renderActivityCard = useCallback(({ activity, onOpenDetails }: ActivityRenderProps) => {
    const toolName = activity.toolName?.toLowerCase()
    // P3.24 — `subagent` (Pi) OR any codex collab tool. See
    // `activity-card-routing.ts`: routing on Pi's spelling alone is why codex's
    // live orchestration data rendered no card.
    if (isSubagentCardActivity(activity)) {
      return (
        <SubagentCard
          activity={activity}
          onOpenDetails={onOpenDetails}
        />
      )
    }
    if (toolName === 'workflow' && activity.orchestrationProgress?.kind === 'workflow') {
      return (
        <WorkflowPanel
          activity={activity}
          onOpenDetails={onOpenDetails}
          onInsertResumePrompt={handleInsertWorkflowResumePrompt}
          {...(canKeepWorkflowRun ? { onKeepRun: handleKeepWorkflowRun } : {})}
        />
      )
    }
    // P2.503 — the full question, not the tool name. This routed on the name
    // alone, and `TodoListCard` renders `null` when no todos can be recovered,
    // so a TodoWrite row with an unparseable result VANISHED from the
    // transcript instead of falling back to the ordinary row. A card in this
    // slot cannot decline a row: see `TodoListCard.isTodoCardActivity`.
    if (isTodoCardActivity(activity)) {
      return <TodoListCard activity={activity} />
    }
    // P4.5 — the advisor's guidance is the tool RESULT and there is no second
    // channel (`BaseAgent.executeAdvisorConsult`), so without this the advice
    // sat behind the details pane on a row named "Advisor Consult". The card
    // router asks the FULL question rather than the tool name, because this
    // slot returns an ELEMENT: a card that renders `null` would delete the row
    // instead of yielding it back (P3.24 measured that for `SubagentCard`).
    // A running consult, a refusal or a drifted reply is therefore never
    // routed here and keeps the ordinary row.
    if (isAdvisorCardActivity(activity)) {
      return <AdvisorConsultationCard activity={activity} />
    }
    return null
  }, [canKeepWorkflowRun, handleInsertWorkflowResumePrompt, handleKeepWorkflowRun])

  // Pop-out handler - opens message in overlay (read-only markdown)
  const handlePopOut = useCallback((message: Message) => {
    if (!session) return
    setOverlayState({
      type: 'markdown',
      content: message.content,
      title: t('overlay.messagePreview'),
    })
  }, [session, t])

  // Ref to track total turn count for scroll handler
  const totalTurnCountRef = React.useRef(0)

  // Latest message metadata (for commit-time auto-scroll)
  const messageCount = session?.messages.length ?? 0
  const lastMessage = messageCount > 0 ? session?.messages[messageCount - 1] : undefined
  const lastMessageId = lastMessage?.id
  const lastMessageRole = lastMessage?.role

  // P6.584 — a named image refusal from the endpoint writes the model's LEARNED
  // flag once, through the connection save the renderer already owns.
  //
  // The effect sits here rather than in `FreeFormInput` (where the row's
  // hand-off first placed it) for one reason: the composer takes no `messages`
  // prop, and the anchored sentence arrives on the turn's error message. This
  // is the nearest component that holds both the session and the model, and the
  // writer is idempotent, so there is exactly one call site and no second one
  // to keep in step. Every error with no anchor is a no-op inside the hook.
  const learnImageRefusalFromTurn = useLearnImageRefusal()
  const lastMessageErrorDetails = lastMessage?.errorDetails
  const sessionConnectionSlug = session?.llmConnection
  React.useEffect(() => {
    if (lastMessageRole !== 'error') return
    if (!sessionConnectionSlug || !currentModel) return
    void learnImageRefusalFromTurn(sessionConnectionSlug, currentModel, lastMessageErrorDetails)
  }, [
    lastMessageId,
    lastMessageRole,
    lastMessageErrorDetails,
    sessionConnectionSlug,
    currentModel,
    learnImageRefusalFromTurn,
  ])

  const pendingFollowUpAnnotations = useMemo<PendingFollowUpAnnotation[]>(() => {
    if (!session?.messages?.length) return []

    const pending: PendingFollowUpAnnotation[] = []

    for (const message of session.messages) {
      if (message.role !== 'assistant' && message.role !== 'plan') continue
      if (!message.annotations?.length) continue

      for (const annotation of message.annotations) {
        const note = getAnnotationNoteText(annotation)
        if (!note) continue
        if (isAnnotationFollowUpSent(annotation)) continue

        pending.push({
          messageId: message.id,
          annotationId: annotation.id,
          note,
          selectedText: extractAnnotationSelectedText(annotation, message.content),
          createdAt: annotation.updatedAt ?? annotation.createdAt,
          color: annotation.style?.color,
          meta: asRecord(annotation.meta) ?? undefined,
        })
      }
    }

    return pending.sort((a, b) => a.createdAt - b.createdAt)
  }, [session?.messages])

  const followUpInputItems = useMemo(() => {
    return pendingFollowUpAnnotations.map((followUp, idx) => ({
      id: `${followUp.messageId}:${followUp.annotationId}`,
      messageId: followUp.messageId,
      annotationId: followUp.annotationId,
      index: idx + 1,
      noteLabel: normalizeFollowUpText(followUp.note),
      selectedText: truncateForChipTooltip(followUp.selectedText, 260),
      color: followUp.color,
    }))
  }, [pendingFollowUpAnnotations])

  // Track scroll position to toggle sticky-bottom behavior
  // - User scrolls up → unstick (stop auto-scrolling)
  // - User scrolls back to bottom → re-stick (resume auto-scrolling)
  // Also handles loading more turns when scrolling near top
  const handleScroll = React.useCallback(() => {
    const viewport = scrollViewportRef.current
    if (!viewport) return
    const { scrollTop, scrollHeight, clientHeight } = viewport
    const distanceFromBottom = scrollHeight - scrollTop - clientHeight
    // 20px threshold for "at bottom" detection
    isStickToBottomRef.current = distanceFromBottom < 20

    // Load more turns when scrolling near top (within 100px)
    if (scrollTop < 100) {
      setVisibleTurnCount(prev => {
        // Check if there are more turns to load
        const currentStartIndex = Math.max(0, totalTurnCountRef.current - prev)
        if (currentStartIndex <= 0) return prev // Already showing all

        // Remember scroll height before adding more items
        const prevScrollHeight = viewport.scrollHeight

        // Schedule scroll position adjustment after render
        requestAnimationFrame(() => {
          const newScrollHeight = viewport.scrollHeight
          viewport.scrollTop = newScrollHeight - prevScrollHeight + scrollTop
        })

        return prev + TURNS_PER_PAGE
      })
    }
  }, [])

  // Set up scroll event listener
  React.useEffect(() => {
    const viewport = scrollViewportRef.current
    if (!viewport) return
    viewport.addEventListener('scroll', handleScroll)
    return () => viewport.removeEventListener('scroll', handleScroll)
  }, [handleScroll])

  // Auto-scroll using ResizeObserver for streaming content
  // Initial scroll is handled by ScrollOnMount (useLayoutEffect, before paint)
  React.useEffect(() => {
    const viewport = scrollViewportRef.current
    if (!viewport) return

    const isSessionSwitch = prevSessionIdRef.current !== session?.id
    prevSessionIdRef.current = session?.id ?? null

    // On session switch: reset UI state (scroll handled by ScrollOnMount)
    if (isSessionSwitch) {
      isStickToBottomRef.current = true
      setVisibleTurnCount(TURNS_PER_PAGE)
    }

    // Debounced scroll for streaming - waits for layout to settle
    let debounceTimer: ReturnType<typeof setTimeout> | null = null

    const resizeObserver = new ResizeObserver(() => {
      // Unfocused panels: always scroll to bottom instantly (user isn't reading them)
      if (!isFocusedPanelRef.current) {
        messagesEndRef.current?.scrollIntoView({ behavior: 'instant' })
        return
      }

      // Focused panel: respect sticky-bottom preference
      if (!isStickToBottomRef.current) return

      // Clear pending scroll and wait for layout to settle
      if (debounceTimer) clearTimeout(debounceTimer)
      debounceTimer = setTimeout(() => {
        // Skip smooth scroll if we just did an instant scroll (session switch/lazy load)
        if (Date.now() < skipSmoothScrollUntilRef.current) return
        messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
      }, 200)
    })

    // Observe the scroll content container (first child of viewport)
    const content = viewport.firstElementChild
    if (content) {
      resizeObserver.observe(content)
    }

    return () => {
      resizeObserver.disconnect()
      if (debounceTimer) clearTimeout(debounceTimer)
    }
  }, [session?.id])

  // Commit-time auto-scroll for new user messages.
  // This complements submit-time scrolling and covers cases where attachments delay
  // optimistic message insertion (e.g., thumbnail generation/resizing).
  React.useEffect(() => {
    const currentSessionId = session?.id ?? null

    // Reset baseline on session switch; defer to ScrollOnMount/session-switch logic.
    if (prevSessionIdForCommitScrollRef.current !== currentSessionId) {
      prevSessionIdForCommitScrollRef.current = currentSessionId
      prevLastMessageIdRef.current = lastMessageId ?? null
      prevMessageCountRef.current = messageCount
      return
    }

    const previousCount = prevMessageCountRef.current
    const previousLastId = prevLastMessageIdRef.current
    const messageActuallyChanged = !!lastMessageId && lastMessageId !== previousLastId
    const countIncreased = messageCount > previousCount

    // Update baselines before early returns to keep refs consistent.
    prevLastMessageIdRef.current = lastMessageId ?? null
    prevMessageCountRef.current = messageCount

    if (!messageActuallyChanged || !countIncreased) return
    if (lastMessageRole !== 'user') return

    // Sending a message should always re-stick to bottom.
    isStickToBottomRef.current = true

    requestAnimationFrame(() => {
      messagesEndRef.current?.scrollIntoView({
        behavior: isFocusedPanelRef.current ? 'smooth' : 'instant',
      })
    })
  }, [session?.id, messageCount, lastMessageId, lastMessageRole])

  // Handle message submission from InputContainer
  // Backend handles interruption and queueing if currently processing
  const handleSubmit = (message: string, attachments?: FileAttachment[], skillSlugs?: string[], customSlashCommandId?: import('@nessy-agent/shared/slash-commands/common').CustomSlashCommandId, midStreamOverride?: 'steer' | 'queue') => {
    // P2.425 · `/rewind` OPENS the rewind menu and is never a prompt.
    // `checkpointing.md#rewind-and-summarize`: "Run `/rewind`, or press `Esc`
    // twice when the prompt input is empty, to open the rewind menu."
    //
    // Read off the RAW composer text, before the follow-up section is composed
    // onto it: a command is the whole message or it is prose. This is the
    // composer's single `onSubmit`, so there is no second route by which a
    // typed `/rewind` could still reach `onSendMessage` and the model. It is
    // deliberately NOT gated on `isProcessing` — the menu opens mid-turn and
    // says its actions are unavailable, because a command that silently does
    // nothing is indistinguishable from a defect. D1.390 · and it opens only
    // over a session the HOST minted — `rewindCommandOpensMenu` says why.
    if (rewindCommandOpensMenu(message, session?.id)) {
      handleOpenRewindMenu()
      return
    }

    const hasBaseMessage = message.trim().length > 0
    const followUpSection = formatFollowUpSection(pendingFollowUpAnnotations, {
      includeTopSeparator: hasBaseMessage,
    })
    const messageWithFollowUps = followUpSection.length > 0
      ? (hasBaseMessage ? `${message}\n\n${followUpSection}` : followUpSection)
      : message
    const normalizedMessage = normalizeFollowUpsMarkdown(messageWithFollowUps)

    // Force stick-to-bottom when user sends a message
    isStickToBottomRef.current = true
    onSendMessage(normalizedMessage, attachments, skillSlugs, customSlashCommandId, midStreamOverride)

    // Persist sent marker on follow-up annotations so TurnCard can distinguish
    // sent vs pending follow-ups. If user edits a follow-up later, TurnCard
    // clears these markers and the annotation becomes pending again.
    if (session && pendingFollowUpAnnotations.length > 0) {
      const sentAt = Date.now()
      void Promise.all(pendingFollowUpAnnotations.map((followUp) => {
        const currentMeta = followUp.meta ?? {}
        const currentFollowUpMeta = asRecord(currentMeta.followUp) ?? {}

        return window.electronAPI.sessionCommand(session.id, {
          type: 'updateAnnotation',
          messageId: followUp.messageId,
          annotationId: followUp.annotationId,
          patch: {
            meta: {
              ...currentMeta,
              followUp: {
                ...currentFollowUpMeta,
                text: followUp.note,
                lastSentAt: sentAt,
                lastSentText: followUp.note,
              },
            },
          },
        })
      })).catch((error) => {
        console.error('[ChatDisplay] Failed to mark follow-up annotations as sent:', error)
      })
    }

    // Immediately scroll to bottom after sending - use requestAnimationFrame
    // to ensure the DOM has updated with the new message
    requestAnimationFrame(() => {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
    })
  }

  const handleSaveToMemory = useCallback(async (scope: MemoryAppendScope, text: string) => {
    if (!session) return

    try {
      const result = await window.electronAPI.sessionCommand(session.id, {
        type: 'appendMemory',
        scope,
        text,
      }) as MemoryAppendResult | undefined

      if (result?.success) {
        toast.success(t('toast.memorySaved'))
        return
      }

      toast.error(t('toast.failedToSaveMemory'), {
        description: result?.error || t('toast.unknownError'),
      })
    } catch (error) {
      toast.error(t('toast.failedToSaveMemory'), {
        description: error instanceof Error ? error.message : t('toast.unknownError'),
      })
    }
  }, [session, t])

  const handleRewindConversation = useCallback(async (messageId: string, restoreFiles: boolean) => {
    if (!session) return

    // P6.104 · read the prompt BEFORE the call. The rewind truncates the
    // transcript and the props re-render off the event that follows, so the
    // message this handler was called about may not be in `session.messages` by
    // the time the await returns. The full CONTENT, never the row's `preview` —
    // that one is cut at `REWIND_PREVIEW_MAX_CHARS` for display, and restoring
    // a truncated prompt into the composer would be worse than restoring none.
    const rewoundPrompt = session.messages.find(message => message.id === messageId)?.content
    // P6.268 · the same before-the-call reasoning as the prompt above: these are
    // the rows the rewind is about to remove, and they are gone once it returns.
    // A rewind restores the edits the checkpoint adapter mediated and nothing
    // else, so a span that ran a shell command or spawned a background subagent
    // has file changes the restore could not have covered — and until now it
    // said "restored N", which reads as "that was everything".
    const rewindIndex = session.messages.findIndex(message => message.id === messageId)
    const uncovered = rewindIndex >= 0
      ? uncoveredRewindCategories(session.messages.slice(rewindIndex))
      : []

    try {
      const result = await window.electronAPI.sessionCommand(session.id, {
        type: 'rewindToMessage',
        messageId,
        restoreFiles,
      }) as ConversationRewindResult | undefined

      if (result?.success) {
        // P6.104 · `checkpointing.md#rewind-and-summarize`: "After restoring the
        // conversation or choosing Summarize from here, the original prompt from
        // the selected message is restored into the input field so you can
        // re-send or edit it." Both of our restore buttons restore the
        // conversation, so neither is excluded. Only on SUCCESS: a failed rewind
        // changed nothing, and a composer prefilled after it would say otherwise.
        const restoredComposer = rewindComposerText(inputValue, rewoundPrompt)
        if (restoredComposer !== undefined) onInputChange?.(restoredComposer)
        // A rewind that left files alone for link safety is a PARTIAL rewind.
        // Saying only "restored N" would be the lie: the user has to learn the
        // count and the reason here, not from a diff.
        const skippedLinks = result.skippedLinks ?? 0
        const restored = result.restoredCheckpoints ?? 0
        // F1.989 · the sentence itself is `rewindFilesDescription`, a pure
        // function, so its wording has a unit pin: this component cannot be
        // mounted in the test runner. The tone and the untracked and uncovered
        // clauses below still compose around it here, unchanged.
        const filesDescription = rewindFilesDescription({
          restored,
          failed: result.failedCheckpoints?.length ?? 0,
          skipped: skippedLinks,
          skippedPaths: result.skippedPaths,
        }, t)
        // "Restored 0 checkpoints" reads as "there was nothing to restore", and
        // on a runtime with no checkpoint producer it means "nothing could be".
        // The user clicked a button that says it restores files and acts on what
        // it tells them, so the difference has to arrive here in words — a green
        // success for an operation that did nothing is the one thing this branch
        // must never render. `undefined` means the server could not answer and
        // is NOT a warning; only an explicit `false` is.
        const filesUntracked = restoreFiles && fileCheckpointsUntracked(result)
        const untrackedDescription = filesUntracked
          // F1.1134 · the restored/failed/skipped counts and the skip reasons stay beside "does not track file edits"
          ? rewindUntrackedDescription(filesDescription, {
            restored, failed: result.failedCheckpoints?.length ?? 0, skipped: skippedLinks }, t)
          : filesDescription
        // P6.268 · the categories the restore could not cover, named. Only when
        // files were actually asked for: on a transcript-only rewind nothing was
        // supposed to be restored, so there is nothing to be honest about.
        // Joined the way the skip reasons above are, so one rewind produces one
        // description rather than a stack of toasts.
        const uncoveredSentence = restoreFiles && uncovered.length > 0
          ? uncovered.map(category => t(uncoveredRewindCategoryKey(category))).join(' ')
          : ''
        const honestDescription = uncoveredSentence
          ? `${untrackedDescription} — ${uncoveredSentence}`
          : untrackedDescription
        const notify = skippedLinks > 0 || filesUntracked || uncoveredSentence !== ''
          ? toast.warning
          : toast.success
        notify(t('toast.conversationRewound'), {
          description: restoreFiles
            ? honestDescription
            : t('toast.conversationRewoundDescription', { count: result.removedMessages ?? 0 }),
        })
        return
      }

      toast.error(t('toast.failedToRewindConversation'), {
        description: result?.error || t('toast.unknownError'),
      })
    } catch (error) {
      toast.error(t('toast.failedToRewindConversation'), {
        description: error instanceof Error ? error.message : t('toast.unknownError'),
      })
    }
  }, [session, t, inputValue, onInputChange])

  const handleSaveAndSendFollowUp = useCallback((_target: {
    messageId: string
    annotationId: string
    note: string
    selectedText: string
  }) => {
    if (!session) return

    if (isInputDisabled || disableSend || connectionUnavailable) {
      toast.error(t('toast.cannotSendRightNow'), {
        description: t('toast.sendingDisabledForSession'),
      })
      return
    }

    // Mimic pressing Send in the input after Save completes.
    window.setTimeout(() => {
      window.dispatchEvent(new CustomEvent('nessy:submit-input', {
        detail: { sessionId: session.id },
      }))
    }, 0)
  }, [session, t, isInputDisabled, disableSend, connectionUnavailable])

  // Handle stop request from InputContainer
  // silent=true when redirecting (sending new message), silent=false when user clicks Stop button
  const handleStop = (silent = false) => {
    // D1.377 — the HOST owns "is a turn running" and answers it itself (`cancelProcessing` returns at `!managed.isProcessing`).
    if (!session) return

    // Explicit Stop (not a redirect/new-message send): the in-flight prompt goes
    // back in the input so the user can tweak and resend — but NOT when a follow-up
    // is QUEUED behind the turn (F1.89 / D1.393). `restoredPromptAfterStop` owns that
    // rule and the measurement behind it; queued follow-ups stay server-owned.
    const restoredInput = composerTextAfterStop({ // F1.181 — the gate, the rule and the join, unit-tested there
      silent, isProcessing: session.isProcessing, messages: session.messages, inputValue,
    })
    if (restoredInput !== undefined) onInputChange?.(restoredInput)

    window.electronAPI.cancelProcessing(session.id, silent).catch(error => {
      console.error('[ChatDisplay] Failed to cancel processing:', error)  // D1.377 — and the user must SEE it:
      toast.error(t('chat.submit.stopFailed'), { description: error instanceof Error ? error.message : t('toast.unknownError') })
    })
  }

  // Per-frame scroll compensation during input height animation
  // Only compensate when user is "stuck to bottom" - otherwise let them control their scroll position
  const handleAnimatedHeightChange = React.useCallback((delta: number) => {
    if (!isStickToBottomRef.current) return
    const viewport = scrollViewportRef.current
    if (!viewport) return
    // Adjust scroll to maintain position relative to content
    viewport.scrollTop += delta
  }, [])

  // Handle structured input responses (permissions and credentials)
  const handleStructuredResponse = (response: StructuredResponse) => {
    if ((response.type === 'permission' || response.type === 'admin_approval' || response.type === 'workflow_launch') && pendingPermission && onRespondToPermission) {
      if (response.type === 'permission') {
        const permResponse = response as PermissionResponse
        onRespondToPermission(
          pendingPermission.sessionId,
          pendingPermission.requestId,
          permResponse.allowed,
          permResponse.alwaysAllow,
          permResponse.options
        )
        return
      }

      if (response.type === 'workflow_launch') {
        // `always` maps to alwaysAllow, which the host records as the durable
        // per-workflow-per-project launch consent.
        onRespondToPermission(
          pendingPermission.sessionId,
          pendingPermission.requestId,
          response.approved,
          response.always === true,
          undefined
        )
        return
      }

      const adminResponse = response as AdminApprovalResponse
      onRespondToPermission(
        pendingPermission.sessionId,
        pendingPermission.requestId,
        adminResponse.approved,
        false,
        { rememberForMinutes: adminResponse.rememberForMinutes }
      )
    } else if (response.type === 'credential' && pendingCredential && onRespondToCredential) {
      const credResponse = response as CredentialResponse
      onRespondToCredential(
        pendingCredential.sessionId,
        pendingCredential.requestId,
        credResponse
      )
    }
  }

  // Build structured input state from pending requests (permissions take priority)
  const structuredInput: StructuredInputState | undefined = React.useMemo(() => {
    if (pendingPermission) {
      if (pendingPermission.type === 'ask_user' && pendingPermission.askUser) {
        return { type: 'ask_user', data: pendingPermission }
      }
      if (pendingPermission.type === 'workflow_launch') {
        return { type: 'workflow_launch', data: pendingPermission }
      }
      if (pendingPermission.type === 'admin_approval') {
        // F1.885 — built by {@link adminApprovalCardData} beside the card, so the card's
        // test drives the mapping this renders. It keeps the request's own remember window
        // (an ask-rule card names none, and the host stores none for it, F1.869), its
        // `noAlwaysAllow` (F1.842) and the rule sentence that card sends as `description`.
        // The inline object here defaulted the window to 10 min and dropped the other two,
        // so an ask-rule card offered a remember switch the host ignores and never named
        // the rule that asks.
        return {
          type: 'admin_approval',
          data: adminApprovalCardData(pendingPermission),
        }
      }
      return { type: 'permission', data: pendingPermission }
    }
    if (pendingCredential) {
      return { type: 'credential', data: pendingCredential }
    }
    return undefined
  }, [pendingPermission, pendingCredential])

  // Memoize turn grouping - avoids O(n) iteration on every render/keystroke
  const allTurns = React.useMemo(() => {
    if (!session) return []
    return groupMessagesByTurn(session.messages, { isSessionProcessing: session.isProcessing })
  }, [session?.messages, session?.isProcessing])

  // Keep ref in sync for scroll handler
  totalTurnCountRef.current = allTurns.length

  // The checklist is SESSION-scoped, so it reads every turn rather than the
  // paginated window — a task created early must still show once the transcript
  // scrolls past it.
  const checklistActivities = useMemo(
    () => allTurns.flatMap(turn => (turn.type === 'assistant' ? turn.activities : [])),
    [allTurns],
  )

  // Reverse pagination: only render last N turns for fast initial render
  const startIndex = Math.max(0, allTurns.length - visibleTurnCount)
  const turns = allTurns.slice(startIndex)
  const hasMoreAbove = startIndex > 0

  const assistantTurnIndexByMessageId = useMemo(() => {
    const map = new Map<string, number>()
    allTurns.forEach((turn, index) => {
      if (turn.type !== 'assistant') return
      const messageId = turn.response?.messageId
      if (messageId) map.set(messageId, index)
    })
    return map
  }, [allTurns])

  const scrollToFollowUpTurn = useCallback((item: {
    messageId: string
    annotationId: string
  }) => {
    const targetTurnIndex = assistantTurnIndexByMessageId.get(item.messageId)
    if (targetTurnIndex == null) return

    const ensureVisibleCount = allTurns.length - targetTurnIndex

    const scrollToTurn = () => {
      const targetTurn = allTurns[targetTurnIndex]
      if (!targetTurn) return false

      const turnKey = getTurnKey(targetTurn)
      const turnContainer = turnRefs.current.get(turnKey)
      if (!turnContainer) return false

      turnContainer.scrollIntoView({ behavior: 'smooth', block: 'center' })
      return true
    }

    if (ensureVisibleCount > visibleTurnCount) {
      setVisibleTurnCount(ensureVisibleCount)
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          if (!scrollToTurn()) {
            setTimeout(() => {
              void scrollToTurn()
            }, 80)
          }
        })
      })
      return
    }

    if (!scrollToTurn()) {
      requestAnimationFrame(() => {
        void scrollToTurn()
      })
    }
  }, [assistantTurnIndexByMessageId, allTurns, visibleTurnCount])

  const handleFollowUpChipClick = useCallback((item: {
    messageId: string
    annotationId: string
  }, anchor?: { x: number; y: number }) => {
    const targetTurnIndex = assistantTurnIndexByMessageId.get(item.messageId)
    if (targetTurnIndex != null) {
      const ensureVisibleCount = allTurns.length - targetTurnIndex
      if (ensureVisibleCount > visibleTurnCount) {
        setVisibleTurnCount(ensureVisibleCount)
      }
    }

    followUpOpenNonceRef.current += 1
    setOpenAnnotationRequest({
      messageId: item.messageId,
      annotationId: item.annotationId,
      mode: 'view',
      anchorX: anchor?.x,
      anchorY: anchor?.y,
      nonce: followUpOpenNonceRef.current,
    })
  }, [assistantTurnIndexByMessageId, allTurns, visibleTurnCount])

  const handleFollowUpIndexClick = useCallback((item: {
    messageId: string
    annotationId: string
  }) => {
    scrollToFollowUpTurn(item)
  }, [scrollToFollowUpTurn])

  // Compute if we should skip scroll-to-bottom (when search is active on session switch)
  // At render time, prevSessionIdForScrollRef still has the OLD session ID, so we can detect the switch
  const isSessionSwitchForScroll = prevSessionIdForScrollRef.current !== null && prevSessionIdForScrollRef.current !== session?.id
  const skipScrollToBottom = isSessionSwitchForScroll && isSearchActive
  const hasUnrenderedLoadedMessages = !messagesLoading
    && turns.length === 0
    && ((session?.messages?.length ?? 0) > 0 || (session?.messageCount ?? 0) > 0)
  // Transcript placeholder only after 200ms of loading. Loaded messages replace it at once (no
  // minimum display time): holding them back left the turns unmounted while the search
  // highlight / scroll-to-match effects ran, so a slow switch lost the match.
  const showTranscriptSkeleton = useDelayedLoading(messagesLoading)
  // UB14.15 — which empty state an empty transcript shows. v0.15.1 tells the edit popover (the only
  // caller passing `emptyStateLabel`) apart by `emptyStateLabel !== undefined`; ours cannot, because
  // D1.382 made the label the empty state's own sentence and the edit popover passes none to keep its
  // two-line default. So a COMPACT EMBEDDING is a compact chat that names its own empty state (the /btw
  // panel) or that did not opt into the page's compact model picker (the edit popover); the chat page
  // in compact/mobile layout opts in (`enableCompactModelPicker={!!isCompactMode}`), and like upstream
  // it gets the new-chat display moment rather than the edit popover's hint.
  const isCompactEmbedding = compactMode && (emptyStateLabel !== undefined || !enableCompactModelPicker)

  return (
    <RunCommandProvider value={handleRunCommand}>
    {/* C3.244 · `CHAT_PANE_ANCHOR_CLASS` is load-bearing, not decoration: it is
        the containing block every `ChatPaneOverlay` below resolves its `inset-0`
        against. Drop it and the four chat dialogs go back to being centred on
        the WINDOW, which is the owner's 2026-09-11 screenshot. */}
    <div
      ref={zoneRef}
      className={cn('flex h-full flex-col min-w-0', CHAT_PANE_ANCHOR_CLASS)}
      data-focus-zone="chat"
    >
      {session ? (
        <div className="flex flex-1 flex-col min-h-0 min-w-0 relative">
          {/* Content layer */}
          <div className="flex flex-1 flex-col min-h-0 min-w-0 relative z-10">
          {/* === MESSAGES AREA: Scrollable list of message bubbles === */}
          <div className="relative flex-1 min-h-0">
            {/* Mask wrapper - fades content at top and bottom over transparent/image backgrounds */}
            <div
              className="h-full"
              style={{
                maskImage: 'linear-gradient(to bottom, transparent 0%, black 32px, black calc(100% - 32px), transparent 100%)',
                WebkitMaskImage: 'linear-gradient(to bottom, transparent 0%, black 32px, black calc(100% - 32px), transparent 100%)'
              }}
            >
              <ScrollArea className="h-full min-w-0" viewportRef={scrollViewportRef}>
              {/* Transcript column: 720px of text + gutters, turns 20px apart (spec §7.4) */}
              <div className={cn(
                CHAT_LAYOUT.maxWidth,
                "mx-auto min-w-0",
                compactMode ? CHAT_LAYOUT.compactContainerPadding : CHAT_LAYOUT.containerPadding,
                CHAT_LAYOUT.messageSpacing
              )}>
                {/* Session switch is instant (spec §6.3): the keyed wrapper swaps the whole transcript
                    in the same frame — no crossfade, no exit that holds back the new content. The keys
                    are the same as before, so ScrollOnMount still re-runs for every session. */}
                <div key={compactMode ? 'compact-session' : session?.id} className="contents">
                    {messagesLoading ? (
                      showTranscriptSkeleton ? <TranscriptSkeleton /> : null
                    ) : messagesLoadError ? (
                      <TranscriptLoadError
                        error={messagesLoadError}
                        onRetry={onRetryMessagesLoad}
                        isRetrying={messagesRetrying}
                      />
                    ) : (
                    /* Turn-based Message Display - memoized to avoid re-grouping on every render */
                    <div
                      key={compactMode ? 'loaded-compact' : `loaded-${session?.id}`}
                      className={CHAT_LAYOUT.messageSpacing}
                    >
                  {/* Scroll to bottom before paint - fires via useLayoutEffect */}
                  {/* Skip when search is active on session switch - scroll to first match instead */}
                  <ScrollOnMount
                    targetRef={messagesEndRef}
                    skip={skipScrollToBottom}
                    onScroll={() => {
                      skipSmoothScrollUntilRef.current = Date.now() + 500
                    }}
                  />
                  {/* Empty state of a compact EMBEDDING (the edit popover, the /btw panel) - inviting conversational prompt, centered in full popover. D1.382 — `emptyStateLabel` replaces BOTH lines, because "I'll handle the rest" is the edit popover's own voice and not a frame for every compact chat. */}
                  {isCompactEmbedding && turns.length === 0 && <CompactEmptyState label={emptyStateLabel} />}
                  {/* A new, empty chat in the app (compact or not): the display moment. UB7.18 adds the suggestion chips as its children. */}
                  {!isCompactEmbedding && turns.length === 0 && !hasUnrenderedLoadedMessages && (
                    <NewChatEmptyState compact={compactMode} />
                  )}
                  {!compactMode && hasUnrenderedLoadedMessages && <NoRenderableMessages />}
                  {/* Load more indicator - shown when there are older messages */}
                  {hasMoreAbove && <EarlierMessagesHint count={startIndex} />}
                  {turns.map((turn, index) => {
                    // Compute turn key and check if it's a search match
                    const turnKey = getTurnKey(turn)
                    const isCurrentMatch = isSearchActive && matchingTurnIds[currentMatchIndex] === turnKey
                    const isAnyMatch = isSearchActive && matchingTurnIds.includes(turnKey)

                    // User turns - render with MemoizedMessageBubble
                    if (turn.type === 'user') {
                      return (
                        <TurnFrame
                          key={turnKey}
                          turnKey={turnKey}
                          registerRef={registerTurnRef}
                          isCurrentMatch={isCurrentMatch}
                          isAnyMatch={isAnyMatch}
                          className={CHAT_LAYOUT.userMessagePadding}
                        >
                          <MemoizedMessageBubble
                            message={turn.message}
                            onOpenFile={onOpenFile}
                            onOpenUrl={onOpenUrl}
                            sessionId={session?.id}
                            workspaceId={session?.workspaceId}
                            compactMode={compactMode}
                            onSaveToMemory={handleSaveToMemory}
                            onRewindMessage={!session.isProcessing && !turn.message.isPending && !turn.message.isQueued
                              ? handleRewindConversation
                              : undefined}
                          />
                        </TurnFrame>
                      )
                    }

                    // System turns (error, status, info, warning) - render with MemoizedMessageBubble
                    if (turn.type === 'system') {
                      return (
                        <TurnFrame
                          key={turnKey}
                          turnKey={turnKey}
                          registerRef={registerTurnRef}
                          isCurrentMatch={isCurrentMatch}
                          isAnyMatch={isAnyMatch}
                        >
                          <MemoizedMessageBubble
                            message={turn.message}
                            onOpenFile={onOpenFile}
                            onOpenUrl={onOpenUrl}
                            sessionId={session?.id}
                            workspaceId={session?.workspaceId}
                            onSaveToMemory={handleSaveToMemory}
                            onRetry={turn.message.role === 'error' ? () => {
                              const msgs = session?.messages
                              if (!msgs) return
                              // UB12.45 — the newest user row before the error, skipping a hidden one (UB2.14's activation retry)
                              const lastUserMsg = userMessageToRetry(msgs, turn.message.id)
                              if (lastUserMsg) {
                                onSendMessage(lastUserMsg.content)
                              }
                            } : undefined}
                          />
                        </TurnFrame>
                      )
                    }

                    // Auth-request turns - render inline auth UI
                    if (turn.type === 'auth-request') {
                      // Interactive only if no user message follows
                      const isAuthInteractive = !turns.slice(index + 1).some(t => t.type === 'user')
                      return (
                        <TurnFrame
                          key={turnKey}
                          turnKey={turnKey}
                          registerRef={registerTurnRef}
                          isCurrentMatch={isCurrentMatch}
                          isAnyMatch={isAnyMatch}
                        >
                          <MemoizedAuthRequestCard
                            message={turn.message}
                            sessionId={session.id}
                            onRespondToCredential={onRespondToCredential}
                            isInteractive={isAuthInteractive}
                          />
                        </TurnFrame>
                      )
                    }

                    // The last response (Accept Plan visibility): no later user turn — a `/compact` that ended in an error ran nothing, so it does not count (F1.856)
                    const isLastResponse = index === turns.length - 1 || !turns.slice(index + 1).some((t, i, after) => t.type === 'user' && !compactTurnLeftPlanOpen(after, i))

                    // Assistant turns - render with TurnCard (buffered streaming)
                    const assistantUiKey = getAssistantTurnUiKey(turn, index)
                    return (
                      <TurnFrame
                        key={turnKey}
                        turnKey={turnKey}
                        registerRef={registerTurnRef}
                        isCurrentMatch={isCurrentMatch}
                        isAnyMatch={isAnyMatch}
                      >
                        <MemoryContextMenu
                          content={formatTurnAsMarkdown(turn)}
                          onSaveToMemory={handleSaveToMemory}
                        >
                          <TurnCard
                            sessionId={session.id}
                            hasActiveFollowUpAnnotations={pendingFollowUpAnnotations.length > 0}
                            turnId={turn.turnId}
                            activities={turn.activities}
                            response={turn.response}
                            intent={turn.intent}
                            isStreaming={turn.isStreaming}
                            isComplete={turn.isComplete}
                            isExpanded={expandedTurns.has(assistantUiKey)}
                            onExpandedChange={(expanded) => toggleTurn(assistantUiKey, expanded)}
                            transcriptVerbosity={transcriptVerbosity}
                            expandedActivityGroups={expandedActivityGroups}
                            onExpandedActivityGroupsChange={setExpandedActivityGroups}
                            renderActivity={renderActivityCard}
                            onOpenFile={onOpenFile}
                            onOpenUrl={onOpenUrl}
                            isLastResponse={isLastResponse}
                            compactMode={compactMode}
                            sendMessageKey={sendMessageKey}
                            openAnnotationRequest={openAnnotationRequest}
                            onBranch={session?.supportsBranching ? async (messageId: string, options?: { newPanel?: boolean }) => {
                              if (!session) return
                              try {
                                const child = await appShellContext.onCreateSession(
                                  session.workspaceId,
                                  {
                                    branchFromMessageId: messageId,
                                    branchFromSessionId: session.id,
                                    name: t('chat.branchOfSession', { name: session.name || t('chat.titlePlaceholder') }),
                                    // Keep branch on the same backend/provider by inheriting parent session settings.
                                    llmConnection: session.llmConnection,
                                    model: session.model,
                                    permissionMode: session.permissionMode,
                                    enabledSourceSlugs: session.enabledSourceSlugs,
                                  }
                                )
                                navigate(routes.view.allSessions(child.id), { newPanel: resolveBranchNewPanelOption(options) })
                              } catch (error) {
                                const rawMessage = error instanceof Error ? error.message : 'Failed to create branch'
                                const message = rawMessage.includes('source and target providers must match')
                                  || rawMessage.includes('same provider/backend')
                                  ? 'Branching is only supported within the same provider/backend. Switch this panel connection and try again.'
                                  : rawMessage
                                toast.error(t('toast.couldNotCreateBranch'), { description: message })
                              }
                            } : undefined}
                            onAddAnnotation={async (messageId, annotation) => {
                              if (!session) return
                              try {
                                await window.electronAPI.sessionCommand(session.id, {
                                  type: 'addAnnotation',
                                  messageId,
                                  annotation,
                                })
                              } catch (error) {
                                toast.error(t('toast.couldNotSaveHighlight'), {
                                  description: error instanceof Error ? error.message : t('toast.unknownError'),
                                })
                                throw error
                              }
                            }}
                            onRemoveAnnotation={async (messageId, annotationId) => {
                              if (!session) return
                              try {
                                await window.electronAPI.sessionCommand(session.id, {
                                  type: 'removeAnnotation',
                                  messageId,
                                  annotationId,
                                })
                              } catch (error) {
                                toast.error(t('toast.couldNotRemoveHighlight'), {
                                  description: error instanceof Error ? error.message : t('toast.unknownError'),
                                })
                              }
                            }}
                            onUpdateAnnotation={async (messageId, annotationId, patch) => {
                              if (!session) return
                              try {
                                await window.electronAPI.sessionCommand(session.id, {
                                  type: 'updateAnnotation',
                                  messageId,
                                  annotationId,
                                  patch,
                                })
                              } catch (error) {
                                toast.error(t('toast.couldNotUpdateHighlight'), {
                                  description: error instanceof Error ? error.message : t('toast.unknownError'),
                                })
                                throw error
                              }
                            }}
                            onSaveAndSendFollowUp={handleSaveAndSendFollowUp}
                            onAcceptPlan={() => {
                              const planMessage = session?.messages.findLast(m => m.role === 'plan')

                              window.dispatchEvent(new CustomEvent('nessy:approve-plan', {
                                detail: {
                                  sessionId: session?.id,
                                  includeDraftInput: true,
                                  source: 'plan-card',
                                },
                              }))
                            }}
                            onAcceptPlanWithCompact={() => {
                              const planMessage = session?.messages.findLast(m => m.role === 'plan')

                              window.dispatchEvent(new CustomEvent('nessy:approve-plan-with-compact', {
                                detail: {
                                  sessionId: session?.id,
                                  planHandleId: planMessage?.planHandleId,
                                  includeDraftInput: true,
                                  source: 'plan-card',
                                },
                              }))
                            }}
                            onPopOut={(text) => {
                              // Open raw markdown source in code viewer
                              setOverlayState({
                                type: 'markdown',
                                content: text,
                                title: t('overlay.responsePreview'),
                                forceCodeView: true,
                              })
                            }}
                            onOpenDetails={() => {
                              // Open turn details in markdown overlay
                              const markdown = formatTurnAsMarkdown(turn)
                              setOverlayState({
                                type: 'markdown',
                                content: markdown,
                                title: t('overlay.turnDetails'),
                              })
                            }}
                            onOpenActivityDetails={(activity) => {
                              // Write tool for .md/.txt → Document overlay (rendered markdown)
                              // rather than multi-diff, since these are better viewed as formatted documents
                              const isDocumentWrite = activity.toolName === 'Write' && (() => {
                                const actInput = activity.toolInput as Record<string, unknown> | undefined
                                const fp = (actInput?.file_path as string) || ''
                                const ext = fp.split('.').pop()?.toLowerCase()
                                return ext === 'md' || ext === 'txt'
                              })()

                              // Edit/Write tool → Multi-file diff overlay (ungrouped, focused on this change)
                              // Exception: Write to .md/.txt files goes to document overlay instead
                              if ((activity.toolName === 'Edit' || activity.toolName === 'Write') && !isDocumentWrite) {
                                const changes = collectFileChangesFromActivities(turn.activities)
                                if (changes.length > 0) {
                                  setOverlayState({
                                    type: 'multi-diff',
                                    changes,
                                    consolidated: false, // Ungrouped mode - show individual changes
                                    focusedChangeId: getFirstFileChangeIdForActivity(activity.id, changes),
                                  })
                                }
                              } else {
                                // All other tools → open generic activity cards overlay (Input/Output)
                                setOverlayState({ type: 'activity', activity })
                              }
                            }}
                            hasEditOrWriteActivities={turn.activities.some(a =>
                              a.toolName === 'Edit' || a.toolName === 'Write'
                            )}
                            onOpenMultiFileDiff={() => {
                              const changes = collectFileChangesFromActivities(turn.activities)
                              if (changes.length > 0) {
                                setOverlayState({
                                  type: 'multi-diff',
                                  changes,
                                  consolidated: true, // Consolidated mode - group by file
                                })
                              }
                            }}
                          />
                        </MemoryContextMenu>
                      </TurnFrame>
                    )
                  })}
                    </div>
                    )}
                </div>
                {/* Processing Indicator (live line) - always visible while processing */}
                {session.isProcessing && (() => {
                  // Find the last user message timestamp for accurate elapsed time
                  const lastUserMsg = [...session.messages].reverse().find(m => m.role === 'user')
                  return (
                    <ProcessingIndicator
                      startTime={lastUserMsg?.timestamp}
                      statusMessage={session.currentStatus?.message}
                      statusType={session.currentStatus?.statusType}
                      retry={session.currentStatus?.retry}
                      suggestion={pluginSuggestionTip}
                    />
                  )
                })()}
                {/* Scroll Anchor: For auto-scroll to bottom */}
                <div ref={messagesEndRef} />
              </div>
              </ScrollArea>
            </div>
          </div>

          {/* === CONTROL PLATES === */}
          {/* One wrapper for the three plates so they share the composer's
              gutter (CHAT_LAYOUT.controlGutter, owned by ChatInputZone) and a
              single vertical rhythm. Each plate renders null when it has
              nothing to say, so `empty:hidden` collapses the stack; the
              wrapper carries no vertical padding, so it is 0-height anyway. */}
          <div className={cn(
            CHAT_LAYOUT.maxWidth,
            'mx-auto w-full space-y-1.5 empty:hidden',
            compactMode ? CHAT_LAYOUT.controlGutterCompact : CHAT_LAYOUT.controlGutter,
          )}>
            {/* === DEFERRED SPAWN PROPOSALS (P6.334) === */}
            {/* Here rather than inline in the message flow, for the reason the
                sign-in notice records below: a card at the top of the list
                scrolls away with the first turn, taking the only affordance
                with it — and this one is an offer the user is meant to be able
                to accept later. It goes ABOVE the sign-in notice because it is
                the only plate in the stack whose button starts something. */}
            <DeferredSpawnChips
              proposals={deferredSpawns}
              onStart={route => { void navigate(route as Parameters<typeof navigate>[0]) }}
              {...(onResolveDeferredSpawn ? { onResolve: onResolveDeferredSpawn } : {})}
            />

            {/* === THE SESSION NOTICES, IN ONE BOUNDED REGION (C3.245) === */}
            {/* Owner request 2026-09-11 — "предупреждение сделать не на весь
                экран, добавить скролл". Both notices below are unbounded by
                nature: one lists every capability the session has, the other
                one row per source awaiting sign-in, and on a real workspace the
                pair covered the conversation AND the composer. The ceiling is
                on the REGION rather than on each card, because two separately
                bounded cards still add up to the whole pane. Each card pins its
                own header (`stickyHeader`), so the dismiss × stays reachable
                without scrolling. See `chat-notice-region.tsx`. */}
            <ChatNoticeRegion>
              {/* === PENDING SIGN-IN (W1) === */}
              {/* Owner decision 2026-08-01 — "вижу это сверху а не в самом чате в
                  виде карточки". This is the ONLY mount of the notice; the shell
                  wrapper in `MainContentPanel` no longer renders it.

                  Position argued, not chosen on taste: the session already has two
                  system-ish cards — `TaskChecklistPanel` and `AgentPanel` — and
                  both sit here, outside the ScrollArea, between the message list
                  and the composer, at chat width. Inline in the message flow would
                  mean the first non-message item that list has ever carried, and a
                  card at the top of it scrolls away with the first turn, taking
                  the only sign-in affordance we ship with it. It goes FIRST in the
                  stack so the Connect button does not shift under the cursor when
                  a checklist or an agent row appears mid-turn. */}
              <PendingAuthNotice
                workspaceId={session.workspaceId ?? null}
                activeSessionId={session.id}
              />

              {/* === SESSION CAPABILITY INVENTORY (P6.411) === */}
              {/* What this session's capability resolution withheld, and why —
                  the one surface that answers "which of my plugins actually
                  loaded here". Same plate stack and the same argument as the
                  sign-in notice above it: this is a statement about THIS chat,
                  so it belongs in the chat rather than in a workspace strip.

                  It goes AFTER the sign-in notice because a source that still
                  needs a password outranks one that was deliberately withheld:
                  the first is a thing to do, the second a thing to know. It
                  renders nothing when the session withheld nothing. */}
              <SessionCapabilityInventoryNotice
                sessionId={session.id} isProcessing={session.isProcessing}
                {...(appShellContext.capabilityCatalog?.capabilities
                  ? { capabilities: appShellContext.capabilityCatalog.capabilities }
                  : {})}
              />
            </ChatNoticeRegion>

            {/* === TASK CHECKLIST (R20) === */}
            {/* interactive-mode.md:36 — the checklist surface. NOT the
                background-task view, which lives in the composer's chip row. */}
            <TaskChecklistPanel activities={checklistActivities} open={taskChecklistOpen} />

            {/* === RUNNING AGENTS (R29b) === */}
            {/* sub-agents.md:1023 — "Running forks appear in a panel below the
                prompt input, with one row for the main session and one for each
                fork." */}
            <AgentPanel
              open
              mainSessionLabel={session.name || t('agentPanel.mainSession')}
              rows={agentPanel.rows}
              transcripts={agentPanel.transcripts}
              errors={agentPanel.errors}
              onOpenTranscript={agentPanel.openTranscript}
              onFollowUp={agentPanel.followUp}
              onDismiss={agentPanel.dismiss}
              onReturnFocus={() => textareaRef.current?.focus()}
            />
          </div>

          {/* === INPUT CONTAINER: FreeForm or Structured Input === */}
          {/* D1.375 — EVERY embedding gets the composer. The `{!hideInput && (`
              that used to wrap this block had one caller, the `/btw` panel, and
              the owner ruled that panel must be typed into; see the note on the
              prop declaration above for why nothing replaced it. */}
          <AppShellProvider value={inputAppShellContext}>
            <ChatInputZone
              compactMode={compactMode}
              permissionMode={permissionMode}
              // P6.502 — the session's own never-persist fact, straight off the
              // DTO. `undefined` on an older server reads as "saved normally".
              neverPersist={session.ephemeral === true}
              onPermissionModeChange={onPermissionModeChange}
              tasks={backgroundTasks}
              sessionId={session.id}
              workspaceId={session.workspaceId}
              onStopTask={stopTask}
              onDismissTask={dismissTask}
              onOpenTaskOutput={handleOpenTaskOutput}
              onRunCommand={handleRunCommand ?? undefined} // UB14.34: the pasted-snippet offer (the zone also reads backgroundShell)
              sessionLabels={session.labels}
              labels={labels}
              onLabelsChange={onLabelsChange}
              currentSessionStatus={session.sessionStatus || 'todo'}
              composerCapabilities={session.composerCapabilities}
              promptFromExternalLink={promptFromExternalLink}
              inputProps={{
                placeholder,
                disabled: isInputDisabled,
                isProcessing: session.isProcessing,
                onAnimatedHeightChange: handleAnimatedHeightChange,
                onSubmit: handleSubmit,
                onStop: handleStop,
                textareaRef,
                currentModel,
                onModelChange,
                thinkingLevel,
                onThinkingLevelChange,
                enabledModes,
                enableCompactModelPicker,
                structuredInput,
                onStructuredResponse: handleStructuredResponse,
                inputValue,
                onInputChange,
                attachmentsValue,
                onAttachmentsChange,
                sources,
                enabledSourceSlugs: session.enabledSourceSlugs,
                onSourcesChange,
                skills,
                workspaceId,
                workingDirectory,
                onWorkingDirectoryChange,
                onResetToSession,
                disableSend: disableSend || connectionUnavailable,
                connectionUnavailable,
                isEmptySession: session.messages.length === 0,
                currentConnection: session.llmConnection,
                onConnectionChange,
                onPreviewConnectionChange,
                contextStatus: {
                  isCompacting: session.currentStatus?.statusType === 'compacting',
                  // No `?? tokenUsage` for a fresh-local provider — see
                  // `mayFallBackToTokenUsage`. The donut waits for the snapshot
                  // rather than dividing a per-turn count by another model's window.
                  inputTokens: currentSnapshotTokens(session.contextUsage)
                    ?? (mayFallBackToTokenUsage(session.composerCapabilities) ? session.tokenUsage?.inputTokens : undefined),
                  contextWindow: session.contextUsage?.contextWindow
                    ?? (mayFallBackToTokenUsage(session.composerCapabilities) ? session.tokenUsage?.contextWindow : undefined),
                  autoCompactionThreshold: session.contextUsage?.autoCompactionThreshold,
                  remainingBeforeAutoCompact: session.contextUsage?.remainingBeforeAutoCompact,
                  remainingWindow: session.contextUsage?.remainingWindow,
                  contextWindowSource: session.contextUsage?.contextWindowSource,
                },
                followUpItems: followUpInputItems,
                onFollowUpClick: handleFollowUpChipClick,
                onFollowUpIndexClick: handleFollowUpIndexClick,
              }}
            />
          </AppShellProvider>
          {/* (D1.375 — the `)}` that closed the removed guard sat here.) */}
          </div>
        </div>
      ) : null}

      {/* ================================================================== */}
      {/* Preview Overlays - Rendered outside the main chat flow            */}
      {/* ================================================================== */}

      {/* Agent definitions overlay */}
      {overlayState?.type === 'agents' && session && (() => {
        const agents = appShellContext.agents ?? []

        return (
          <ChatPaneOverlay label={t('agents.title')} onClose={handleCloseOverlay}>
            <div
              className="w-full max-w-lg overflow-hidden rounded-[8px] border border-border bg-background shadow-modal-small"
              onClick={(event) => event.stopPropagation()}
            >
              <div className="flex items-center justify-between gap-3 border-b border-border/40 px-4 py-3">
                <div className="min-w-0">
                  <h2 className="text-sm font-semibold text-foreground">{t('agents.title')}</h2>
                  <p className="mt-0.5 text-xs text-muted-foreground">{t('agents.description')}</p>
                </div>
                <button
                  type="button"
                  className="grid h-8 w-8 shrink-0 place-items-center rounded-[6px] text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground"
                  aria-label={t('agents.close')}
                  onClick={handleCloseOverlay}
                >
                  <X className="h-4 w-4" />
                </button>
              </div>

              <Info_GroupedList empty={t('agents.empty')} className="max-h-[70vh] overflow-auto">
                <Info_GroupedList.Group label={t('agents.group')} variant="info" count={agents.length}>
                  {agents.map((agent) => (
                    <Info_GroupedList.Item key={agent.key}>
                      <div className="space-y-2 text-sm">
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <div className="font-medium text-foreground">{agent.logicalName}</div>
                            <div className="mt-0.5 text-xs leading-snug text-muted-foreground">{agent.description}</div>
                          </div>
                          <div className="shrink-0 rounded-[4px] bg-foreground/5 px-2 py-1 text-xs text-muted-foreground">
                            {agent.scope.kind}
                          </div>
                        </div>
                        <div className="grid gap-1 text-xs text-muted-foreground">
                          <div>
                            <span className="font-medium text-foreground/70">{t('agents.tierLabel')}: </span>
                            {/*
                              P6.633 — an administrator subagent says so, in
                              P2.439's own sentence and P2.439's own key. A row
                              the user can change is owed no such sentence and
                              keeps its ordinary scope word; see `lib/agent-tier`
                              for why `readOnly` is what decides that, and for why
                              the "no edit affordance" half of the row needed no
                              code (this overlay carries no edit control at all).
                            */}
                            {(() => {
                              const ownerKey = agentOwnerLabelKey(agent)
                              return ownerKey ? t(ownerKey) : agent.scope.kind
                            })()}
                          </div>
                          <div>
                            {/*
                              P6.665 — the heading names what is SHOWN. This line
                              renders `agent.diagnosticCodes` and was labelled
                              `agents.tools`, and diagnostic codes are not tools:
                              `SafeCapabilitySummary` carries no agent tool list
                              at all (`protocol/capabilities.ts`), and
                              `toSafeSummary` fills this field from
                              `cap.diagnostics.map(d => d.code)`. So the label was
                              not merely loose — it named a thing the projection
                              cannot carry, and a reader who trusted it would
                              conclude an agent declaring no tools had none.
                              Widening the projection to a real tool list is a
                              contract change and belongs to whichever row needs
                              it; relabelling is what the data supports today.
                            */}
                            <span className="font-medium text-foreground/70">{t('agents.diagnostics')}: </span>
                            {agent.diagnosticCodes.join(', ') || '—'}
                          </div>
                        </div>
                      </div>
                    </Info_GroupedList.Item>
                  ))}
                </Info_GroupedList.Group>
              </Info_GroupedList>
            </div>
          </ChatPaneOverlay>
        )
      })()}

      {/*
        P2.425 · The rewind MENU — `/rewind`'s destination, and the first way to
        reach these actions that does not require discovering a right-click.
        Same backdrop shape as the overlays above it, so Escape-detection
        (`overlay-detection` matches `role="dialog"`), the backdrop click and
        `handleCloseOverlay` all behave identically. "Never mind: return to the
        message list without making changes" is the backdrop, the X, Cancel and
        Escape — four ways out, none of which touches the session.
      */}
      {overlayState?.type === 'rewind' && session && (() => {
        const rewindPrompts = collectRewindPrompts(session.messages)
        const selectedId = overlayState.selectedId
        return (
          <ChatPaneOverlay label={t('chat.rewindMenu.title')} onClose={handleCloseOverlay}>
            <RewindMenuPanel
              prompts={rewindPrompts}
              selectedId={selectedId}
              onSelect={(id) => setOverlayState({ type: 'rewind', selectedId: id })}
              onRewind={(messageId, restoreFiles) => {
                // Close FIRST: the rewind is awaited elsewhere and reports
                // through a toast, and a menu left open over a transcript that
                // is being truncated under it offers rows that no longer exist.
                handleCloseOverlay()
                void handleRewindConversation(messageId, restoreFiles)
              }}
              onSummarize={(command) => {
                // P6.280 · same shape as `onRewind` above: close FIRST, then
                // hand the composed `/compact …` to the ONE send path this
                // component already owns. Deliberately `onSendMessage` and not
                // `handleSubmit`: the composed command is already the whole
                // message, and running it back through the composer's submit
                // would append the pending follow-up section to a session
                // command that takes the rest of the line as instructions.
                handleCloseOverlay()
                onSendMessage(command)
              }}
              onClose={handleCloseOverlay}
              busy={Boolean(session.isProcessing)}
              trackedChangeIds={rewindTrackedIds}
              locale={i18n.resolvedLanguage || i18n.language || 'en'}
            />
          </ChatPaneOverlay>
        )
      })()}

      {/* Context window overlay */}
      {overlayState?.type === 'context' && session && (() => {
        const usageLocale = i18n.resolvedLanguage || i18n.language || 'en'
        const tokenUsage = session.tokenUsage
        const contextUsage = session.contextUsage ?? tokenUsage?.contextUsage
        // Same rule as the composer's donut: a fresh-local provider's gap stays
        // empty rather than being filled from a differently-composed counter.
        const usageFallback = mayFallBackToTokenUsage(session.composerCapabilities) ? tokenUsage : undefined
        const contextTokens = contextUsage
          ? contextUsage.inputTokens
          : getContextTokenTotal(usageFallback)
        const contextWindow = contextUsage?.contextWindow ?? usageFallback?.contextWindow ?? null
        const remainingTokens = contextUsage?.remainingWindow ?? (contextTokens != null && contextWindow && contextWindow > 0
          ? Math.max(contextWindow - contextTokens, 0)
          : null)
        const windowPercent = contextUsage?.percent != null
          ? Math.round(contextUsage.percent)
          : contextTokens != null && contextWindow && contextWindow > 0
          ? Math.round((contextTokens / contextWindow) * 100)
          : null
        const autoCompactRemaining = contextUsage?.remainingBeforeAutoCompact ?? null
        const hasCacheTokens = tokenUsage?.cacheReadTokens !== undefined || tokenUsage?.cacheCreationTokens !== undefined

        return (
          <ChatPaneOverlay label={t('context.title')} onClose={handleCloseOverlay}>
            <div
              className="w-full max-w-md overflow-hidden rounded-[8px] border border-border bg-background shadow-modal-small"
              onClick={(event) => event.stopPropagation()}
            >
              <div className="flex items-center justify-between gap-3 border-b border-border/40 px-4 py-3">
                <div className="min-w-0">
                  <h2 className="text-sm font-semibold text-foreground">{t('context.title')}</h2>
                  <p className="mt-0.5 text-xs text-muted-foreground">{t('context.description')}</p>
                </div>
                <button
                  type="button"
                  className="grid h-8 w-8 shrink-0 place-items-center rounded-[6px] text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground"
                  aria-label={t('context.close')}
                  onClick={handleCloseOverlay}
                >
                  <X className="h-4 w-4" />
                </button>
              </div>

              <Info_GroupedList>
                <Info_GroupedList.Group label={t('context.window')} variant="info">
                  <Info_GroupedList.Item>
                    <div className="flex items-center justify-between gap-4 text-sm">
                      <span className="text-muted-foreground">{t('context.current')}</span>
                      <span className="font-mono text-foreground">{formatSnapshotCount(contextTokens, contextUsage?.stale === true, usageLocale, t('chat.contextUsage.stale'))}</span>
                    </div>
                  </Info_GroupedList.Item>
                  <Info_GroupedList.Item>
                    <div className="flex items-center justify-between gap-4 text-sm">
                      <span className="text-muted-foreground">{t('context.capacity')}</span>
                      <span className="font-mono text-foreground">{formatUsageNumber(contextWindow, usageLocale, t('common.unavailable'))}</span>
                    </div>
                  </Info_GroupedList.Item>
                  <Info_GroupedList.Item>
                    <div className="flex items-center justify-between gap-4 text-sm">
                      <span className="text-muted-foreground">{t('context.remaining')}</span>
                      <span className="font-mono text-foreground">{formatUsageNumber(remainingTokens, usageLocale, '?')}</span>
                    </div>
                  </Info_GroupedList.Item>
                  <Info_GroupedList.Item>
                    <div className="flex items-center justify-between gap-4 text-sm">
                      <span className="text-muted-foreground">{t('context.remainingAutoCompact')}</span>
                      <span className="font-mono text-foreground">{formatUsageNumber(autoCompactRemaining, usageLocale, '?')}</span>
                    </div>
                  </Info_GroupedList.Item>
                  <Info_GroupedList.Item>
                    <div className="flex items-center justify-between gap-4 text-sm">
                      <span className="text-muted-foreground">{t('context.source')}</span>
                      <span className="font-mono text-foreground">{formatContextWindowSource(contextUsage?.contextWindowSource, t)}</span>
                    </div>
                  </Info_GroupedList.Item>
                  {windowPercent !== null && (
                    <Info_GroupedList.Item>
                      <div className="flex items-center justify-between gap-4 text-sm">
                        <span className="text-muted-foreground">{t('context.used')}</span>
                        <span className="font-mono text-foreground">{t('context.percent', { percent: windowPercent })}</span>
                      </div>
                    </Info_GroupedList.Item>
                  )}
                </Info_GroupedList.Group>

                <ContextOverlayBreakdown
                  contextUsage={contextUsage}
                  tokenUsage={tokenUsage}
                  locale={usageLocale}
                  diagnostics={appShellContext.capabilityCatalog?.diagnostics}
                />

                {hasCacheTokens && (
                  <Info_GroupedList.Group label={t('context.cache')} variant="success">
                    {tokenUsage?.cacheReadTokens !== undefined && (
                      <Info_GroupedList.Item>
                        <div className="flex items-center justify-between gap-4 text-sm">
                          <span className="text-muted-foreground">{t('context.cacheRead')}</span>
                          <span className="font-mono text-foreground">{formatUsageNumber(tokenUsage.cacheReadTokens, usageLocale)}</span>
                        </div>
                      </Info_GroupedList.Item>
                    )}
                    {tokenUsage?.cacheCreationTokens !== undefined && (
                      <Info_GroupedList.Item>
                        <div className="flex items-center justify-between gap-4 text-sm">
                          <span className="text-muted-foreground">{t('context.cacheCreation')}</span>
                          <span className="font-mono text-foreground">{formatUsageNumber(tokenUsage.cacheCreationTokens, usageLocale)}</span>
                        </div>
                      </Info_GroupedList.Item>
                    )}
                  </Info_GroupedList.Group>
                )}
              </Info_GroupedList>
            </div>
          </ChatPaneOverlay>
        )
      })()}

      {/* Session usage overlay */}
      {overlayState?.type === 'usage' && session && (() => {
        const usageLocale = i18n.resolvedLanguage || i18n.language || 'en'
        const tokenUsage = session.tokenUsage
        const contextUsage = session.contextUsage ?? tokenUsage?.contextUsage
        const inputTokens = contextUsage?.inputTokens === null
          ? null
          : contextUsage?.inputTokens ?? tokenUsage?.inputTokens
        // Only the CONTEXT row is gated. `usage.inputTokens` above is a token
        // count, not an occupancy, and `tokenUsage` is its honest source.
        const tokenUsageWithContext = contextUsage
          ? ({ ...(tokenUsage ?? {}), contextUsage } as Session['tokenUsage'])
          : mayFallBackToTokenUsage(session.composerCapabilities) ? tokenUsage : undefined
        const costRow = formatUsageCostRow(tokenUsage, usageLocale, {
          unavailable: t('usage.costUnavailable'),
          partialSuffix: t('usage.costPartial'),
        })
        // P6.445 — the per-model split has been persisted for as long as the
        // claude adapter has differenced `modelUsage`, and reached no renderer
        // at all until this row.
        const perModel = modelCostRows(tokenUsage?.modelUsage)

        return (
          <ChatPaneOverlay label={t('usage.title')} onClose={handleCloseOverlay}>
            <div
              className="w-full max-w-md overflow-hidden rounded-[8px] border border-border bg-background shadow-modal-small"
              onClick={(event) => event.stopPropagation()}
            >
              <div className="flex items-center justify-between gap-3 border-b border-border/40 px-4 py-3">
                <div className="min-w-0">
                  <h2 className="text-sm font-semibold text-foreground">{t('usage.title')}</h2>
                  <p className="mt-0.5 text-xs text-muted-foreground">{t('usage.description')}</p>
                </div>
                <button
                  type="button"
                  className="grid h-8 w-8 shrink-0 place-items-center rounded-[6px] text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground"
                  aria-label={t('usage.close')}
                  onClick={handleCloseOverlay}
                >
                  <X className="h-4 w-4" />
                </button>
              </div>

              <Info_GroupedList>
                <Info_GroupedList.Group label={t('usage.tokens')} variant="info">
                  <Info_GroupedList.Item>
                    <div className="flex items-center justify-between gap-4 text-sm">
                      <span className="text-muted-foreground">{t('usage.inputTokens')}</span>
                      <span className="font-mono text-foreground">{formatUsageNumber(inputTokens, usageLocale, '?')}</span>
                    </div>
                  </Info_GroupedList.Item>
                  <Info_GroupedList.Item>
                    <div className="flex items-center justify-between gap-4 text-sm">
                      <span className="text-muted-foreground">{t('usage.outputTokens')}</span>
                      <span className="font-mono text-foreground">{formatUsageNumber(tokenUsage?.outputTokens, usageLocale)}</span>
                    </div>
                  </Info_GroupedList.Item>
                  <Info_GroupedList.Item>
                    <div className="flex items-center justify-between gap-4 text-sm">
                      <span className="text-muted-foreground">{t('usage.totalTokens')}</span>
                      <span className="font-mono text-foreground">{formatUsageNumber(tokenUsage?.totalTokens, usageLocale)}</span>
                    </div>
                  </Info_GroupedList.Item>
                  <Info_GroupedList.Item>
                    <div className="flex items-center justify-between gap-4 text-sm">
                      <span className="text-muted-foreground">{t('usage.contextUsage')}</span>
                      <span className="font-mono text-foreground">{formatContextUsage(tokenUsageWithContext, usageLocale, t('common.unavailable'), t('chat.contextUsage.stale'))}</span>
                    </div>
                  </Info_GroupedList.Item>
                  <Info_GroupedList.Item>
                    <div className="flex items-center justify-between gap-4 text-sm">
                      <span className="text-muted-foreground">{t('context.source')}</span>
                      <span className="font-mono text-foreground">{formatContextWindowSource(contextUsage?.contextWindowSource, t)}</span>
                    </div>
                  </Info_GroupedList.Item>
                </Info_GroupedList.Group>
                {/*
                  P6.616 — warmth, hit ratio, both counters and the lifetime.
                  The component returns null when the session has no cache
                  reading at all, so absence of a reading is never rendered as a
                  reading; the host stamps `tokenUsage.cache` because only it can
                  resolve the prompt-cache TTL, and the component falls back to
                  deriving the rest from the counters already on the wire.
                */}
                <UsageCacheBreakdown tokenUsage={tokenUsage} locale={usageLocale} t={t} />
                {costRow.visible && (
                  <Info_GroupedList.Group label={t('usage.cost')} variant="success">
                    <UsageCostBreakdown totalValue={costRow.value} rows={perModel} locale={usageLocale} t={t} />
                  </Info_GroupedList.Group>
                )}
              </Info_GroupedList>
            </div>
          </ChatPaneOverlay>
        )
      })()}

      {/* Activity details overlay */}
      {overlayState?.type === 'activity' && useStackedActivityOverlay && (
        <ActivityCardsOverlay
          isOpen={true}
          onClose={handleCloseOverlay}
          cards={overlayCards}
          title={formatToolDisplay(overlayState.activity).name}
          theme={isDark ? 'dark' : 'light'}
          onOpenUrl={onOpenUrl}
          onOpenFile={onOpenFile}
        />
      )}

      {/* Background task output (task chip card → Open): a command's output, or an agent's message + steps.
          UB12.79 — v0.15.1's branch, in its own file (`chat-display/TaskOutputOverlay`) so the playground renders it;
          L9's terminal arm (the host's facts, the running notice ANDed with the live row) lives there. */}
      {overlayState?.type === 'task-output' && (
        <TaskOutputOverlay
          state={overlayState}
          tasks={backgroundTasks}
          onClose={handleCloseOverlay}
          theme={isDark ? 'dark' : 'light'}
          onOpenUrl={onOpenUrl}
          onOpenFile={onOpenFile}
        />
      )}

      {/* Legacy output-only activity overlay for non-bash/non-mcp tools */}
      {overlayState?.type === 'activity' && !useStackedActivityOverlay && activityOutputOverlayData && (
        activityOutputOverlayData.type === 'code' ? (
          <CodePreviewOverlay
            isOpen={true}
            onClose={handleCloseOverlay}
            content={activityOutputOverlayData.content}
            filePath={activityOutputOverlayData.filePath}
            mode={activityOutputOverlayData.mode}
            startLine={activityOutputOverlayData.startLine}
            totalLines={activityOutputOverlayData.totalLines}
            numLines={activityOutputOverlayData.numLines}
            command={activityOutputOverlayData.command}
            error={activityOutputOverlayData.error}
            theme={isDark ? 'dark' : 'light'}
          />
        ) : activityOutputOverlayData.type === 'terminal' ? (
          <TerminalPreviewOverlay
            isOpen={true}
            onClose={handleCloseOverlay}
            command={activityOutputOverlayData.command}
            output={activityOutputOverlayData.output}
            exitCode={activityOutputOverlayData.exitCode}
            toolType={activityOutputOverlayData.toolType}
            description={activityOutputOverlayData.description}
            error={activityOutputOverlayData.error}
            theme={isDark ? 'dark' : 'light'}
          />
        ) : activityOutputOverlayData.type === 'json' ? (
          <JSONPreviewOverlay
            isOpen={true}
            onClose={handleCloseOverlay}
            data={activityOutputOverlayData.data}
            title={activityOutputOverlayData.title}
            error={activityOutputOverlayData.error}
            theme={isDark ? 'dark' : 'light'}
          />
        ) : activityOutputOverlayData.type === 'document' ? (
          <DocumentFormattedMarkdownOverlay
            isOpen={true}
            onClose={handleCloseOverlay}
            content={activityOutputOverlayData.content}
            onOpenUrl={onOpenUrl}
            onOpenFile={onOpenFile}
            filePath={activityOutputOverlayData.filePath}
            typeBadge={{
              icon: Info,
              label: activityOutputOverlayData.toolName,
              variant: 'blue',
            }}
            error={activityOutputOverlayData.error}
          />
        ) : detectLanguage(activityOutputOverlayData.content) === 'markdown' ? (
          <DocumentFormattedMarkdownOverlay
            isOpen={true}
            onClose={handleCloseOverlay}
            content={activityOutputOverlayData.content}
            onOpenUrl={onOpenUrl}
            onOpenFile={onOpenFile}
            typeBadge={{
              icon: Info,
              label: formatToolDisplay(overlayState.activity).name,
              variant: 'blue',
            }}
            error={activityOutputOverlayData.error}
          />
        ) : (
          <GenericOverlay
            isOpen={true}
            onClose={handleCloseOverlay}
            content={activityOutputOverlayData.content}
            title={activityOutputOverlayData.title}
            error={activityOutputOverlayData.error}
            theme={isDark ? 'dark' : 'light'}
          />
        )
      )}

      {/* Multi-diff preview overlay (Edit/Write tools) */}
      {overlayState?.type === 'multi-diff' && (
        <MultiDiffPreviewOverlay
          isOpen={true}
          onClose={handleCloseOverlay}
          changes={overlayState.changes}
          consolidated={overlayState.consolidated}
          focusedChangeId={overlayState.focusedChangeId}
          theme={isDark ? 'dark' : 'light'}
          diffViewerSettings={diffViewerSettings}
          onDiffViewerSettingsChange={handleDiffViewerSettingsChange}
          // P6.306 — the line-anchored comment batch reaches the next turn.
          // Deliberately `onSendMessage` and nothing else: the batch is a user
          // turn like any other, so it goes through the same queue, the same
          // steering and the same transcript the composer uses. The overlay
          // hands over ALREADY-FORMATTED text (`formatDiffCommentBatch`), so
          // the anchors are identical on all three runtimes — a second
          // composition site here would be a second definition of the contract.
          // The overlay closes itself after sending.
          onSubmitComments={onSendMessage}
        />
      )}

      {/* Markdown preview overlay (pop-out, turn details) */}
      {/* forceCodeView: show raw markdown source in code viewer (used by "View as Markdown" button) */}
      {/* otherwise: render formatted markdown (used by turn details, etc.) */}
      {overlayState?.type === 'markdown' && (
        overlayState.forceCodeView ? (
          <CodePreviewOverlay
            isOpen={true}
            onClose={handleCloseOverlay}
            content={overlayState.content}
            filePath="response.md"
            language="markdown"
            mode="read"
            theme={isDark ? 'dark' : 'light'}
          />
        ) : (
          <DocumentFormattedMarkdownOverlay
            isOpen={true}
            onClose={handleCloseOverlay}
            content={overlayState.content}
            onOpenUrl={onOpenUrl}
            onOpenFile={onOpenFile}
          />
        )
      )}
    </div>
    </RunCommandProvider>
  )
})
