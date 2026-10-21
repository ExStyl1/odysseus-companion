/**
 * Merged with v0.15.1:apps/electron/src/renderer/components/app-shell/input/ChatInputZone.tsx (UB14.33, R4-13;
 * craft-agents-oss, Apache-2.0). Taken: `ComposerHintLine` under the card (desktop only, reserved height, keys from
 * the Send-message-key setting), the badge-row mode rule (the mode chip shows above the card only while a decision
 * prompt replaces the toolbar), upstream's padding (through OUR `CHAT_LAYOUT.controlGutter*`, which line the plates
 * above up with the card) and the `pendingLabelValueEditAtom` hand-off (the chat header's chip opens a valued
 * label's editor, UB14.6). Re-applied (ours): `ComposerCapabilitiesProvider`, the queue (`QueuedMessageList`,
 * `queueGet` / `queue_changed`, D1.383, F1.481), `neverPersist` (P6.502), the task routes behind upstream's
 * `onStopTask` / `onDismissTask` / `onOpenTaskOutput` (UB12.79: L9's stop and read, UA12.186's dismiss mark), the
 * deep-link notice below the card and above the hint line. UB14.34 (R4-14) takes upstream's pasted-snippet offer:
 * `onRunCommand`, the `pastedSnippet` state and `PastedCommandChip` (its own file) directly above the card, cleared
 * when the pasted text leaves the draft; ours gates it on the runtime's own background shell too (`pastedCommandRunner`,
 * `ComposerCapabilities.backgroundShell`), and the chip sits under our queue strip, next to the draft it acts on.
 * UB14.55 (R2-08) takes upstream's `ActiveOptionBadges` mount: the label and status props are gone from it (the chat
 * header owns those chips) and so are `sessionStatuses` / `onSessionStatusChange` / `onInsertMessage` from this
 * zone, as upstream. Ours: the mount passes the workspace cycle (`enabledModes`) and the cycle binding, so the mode
 * chip raised above a decision prompt offers the same menu as the toolbar's.
 */
import * as React from 'react'
import { useSetAtom } from 'jotai'
import { useTranslation } from 'react-i18next'
import { AlertTriangle } from 'lucide-react'
import { cn } from '@/lib/utils'
import { CHAT_LAYOUT } from '@/config/layout'
import { coerceInputText } from '@/lib/input-text'
import { resolveExternalPromptNotice } from '@/contexts/deep-link-policy'
import { extractLabelId, flattenLabels, type LabelConfig } from '@nessy-agent/shared/labels'
import type { PermissionMode } from '@nessy-agent/shared/agent/modes'
import type { ComposerCapabilities, QueuedMessageDto } from '@nessy-agent/shared/protocol'
import { pendingLabelValueEditAtom } from '@/atoms/label-value-edit'
import { useOptionalAppShellContext } from '@/context/AppShellContext'
import { useOptionalActionRegistry } from '@/actions/registry'
import type { BackgroundTask } from '../ActiveTasksBar'
import type { OpenedTaskOutput } from '../task-output'
import { ActiveOptionBadges } from '../ActiveOptionBadges'
import { InputContainer } from './InputContainer'
import { InputErrorBoundary } from './InputErrorBoundary'
import { ComposerHintLine } from './ComposerHintLine'
import { QueuedMessageList } from './QueuedMessageList'
import { ComposerCapabilitiesProvider } from './composer-capabilities-context'
import { PastedCommandChip } from './PastedCommandChip'
import { pastedCommandRunner, runPastedSnippet, trackPastedSnippet, type PastedSnippet } from './pasted-command'
import { isRendererMintedSessionId } from './stub-session'; import { isUnsteerableQueueRow } from './submit-control' // F1.481 (3) — one line: cited by line

interface ChatInputZoneProps {
  compactMode?: boolean
  /** Show the row above the composer (background tasks, our session badges, the mode chip during decision prompts) */
  showOptionBadges?: boolean
  permissionMode?: PermissionMode
  /**
   * P6.502 — this session is never written to disk. Threaded rather than read
   * here for the reason `ActiveOptionBadges` records on its own prop: the fact
   * is the SESSION's, fixed at create time, so a read here would be an RPC per
   * render for a constant.
   */
  neverPersist?: boolean
  onPermissionModeChange?: (mode: PermissionMode) => void
  tasks?: BackgroundTask[]
  sessionId: string
  workspaceId: string
  onStopTask?: (task: BackgroundTask) => void
  onDismissTask?: (task: BackgroundTask) => void
  /**
   * Show a background task's full output (ChatDisplay opens it in an overlay). L9 — this link is what the
   * "View Output" item's gate used to be waiting for: `ActiveOptionBadges`, `ActiveTasksBar` and `TaskActionMenu`
   * (UB14.7: `BackgroundTaskChip`) all carried the prop already, and the chain was severed HERE, so no product
   * caller could supply one.
   */
  onOpenTaskOutput?: (task: BackgroundTask, output: OpenedTaskOutput) => void
  /** Run a shell command as a background task (a pasted console snippet's "Run in background", v0.15.0); the offer
   *  also needs `composerCapabilities.backgroundShell` (UB14.34), else no paste makes an offer. */
  onRunCommand?: (command: string) => void
  /** For the # label menu; the label chips live in the chat header (UB14.6) */
  sessionLabels?: string[]
  labels?: LabelConfig[]
  onLabelsChange?: (labels: string[]) => void
  /** For the # menu's status picker; the status glyph lives in the chat header (UB14.6) */
  currentSessionStatus?: string
  composerCapabilities?: ComposerCapabilities
  /** Whether the current draft was prefilled by a deep link Nessy did not produce */
  promptFromExternalLink?: boolean
  className?: string
  inputProps: React.ComponentProps<typeof InputContainer>
}

export function ChatInputZone({
  compactMode = false,
  showOptionBadges,
  permissionMode = 'default',
  neverPersist = false,
  onPermissionModeChange,
  tasks = [],
  sessionId,
  workspaceId,
  onStopTask,
  onDismissTask,
  onOpenTaskOutput,
  onRunCommand,
  sessionLabels = [],
  labels = [],
  onLabelsChange,
  currentSessionStatus = 'todo',
  composerCapabilities,
  promptFromExternalLink = false,
  className,
  inputProps,
}: ChatInputZoneProps) {
  const { t } = useTranslation()
  const setPendingLabelValueEdit = useSetAtom(pendingLabelValueEditAtom)
  const panelId = useOptionalAppShellContext()?.panelId
  // The hint names the cycle binding the user HAS (P6.49 overrides; null = unbound); undefined outside the registry
  const cycleHotkey = useOptionalActionRegistry()?.getHotkey('chat.cyclePermissionMode')
  const [queueState, setQueueState] = React.useState<{ queue: QueuedMessageDto[]; paused: boolean }>({ queue: [], paused: false })
  const sawQueueEventRef = React.useRef(false)
  const shouldShowOptionBadges = showOptionBadges ?? !compactMode
  const externalPromptNotice = resolveExternalPromptNotice(
    coerceInputText(inputProps.inputValue),
    promptFromExternalLink,
  )
  const inputResetKey = `${sessionId}::${inputProps.structuredInput?.type ?? 'freeform'}`
  const onInputChange = inputProps.onInputChange

  // A pasted console snippet offers "Run in background" until it is run, dismissed, or deleted from
  // the composer (the paste lands after the event, so the offer waits until it has seen the text).
  // UB14.34: only where the runtime's own tool can background it (`pastedCommandRunner`).
  const runPasted = pastedCommandRunner(onRunCommand, composerCapabilities)
  const draft = coerceInputText(inputProps.inputValue)
  const [pastedSnippet, setPastedSnippet] = React.useState<PastedSnippet | null>(null)
  const snippetSeenRef = React.useRef(false)
  React.useEffect(() => { setPastedSnippet(null) }, [sessionId])
  React.useEffect(() => {
    if (!pastedSnippet) return
    const next = trackPastedSnippet(pastedSnippet, draft, snippetSeenRef.current)
    snippetSeenRef.current = next.seen
    if (!next.keep) setPastedSnippet(null)
  }, [draft, pastedSnippet])
  const handleSnippetPaste = React.useCallback((snippet: PastedSnippet) => {
    snippetSeenRef.current = false
    setPastedSnippet(snippet)
  }, [])
  const handleRunPasted = () => {
    if (!pastedSnippet || !runPasted) return
    if (runPastedSnippet(pastedSnippet, draft, runPasted).clearDraft) inputProps.onInputChange?.('')
    setPastedSnippet(null)
  }

  React.useEffect(() => {
    let cancelled = false
    sawQueueEventRef.current = false
    setQueueState({ queue: [], paused: false })
    if (isRendererMintedSessionId(sessionId)) return // D1.383 — no host side to ask
    window.electronAPI.queueGet(sessionId)
      .then((next) => {
        if (!cancelled && !sawQueueEventRef.current) {
          setQueueState(next)
        }
      })
      .catch((error) => {
        console.error('[ChatInputZone] Failed to hydrate queue:', error)
      })
    return () => {
      cancelled = true
    }
  }, [sessionId])

  React.useEffect(() => {
    return window.electronAPI.onSessionEvent((event) => {
      if (event.type !== 'queue_changed' || event.sessionId !== sessionId) return
      sawQueueEventRef.current = true
      setQueueState({ queue: event.queue, paused: event.paused })
    })
  }, [sessionId])

  const handleClearDraft = React.useCallback(() => {
    inputProps.onInputChange?.('')
    inputProps.onAttachmentsChange?.([])
  }, [inputProps])

  const handleLabelAdd = React.useCallback((labelId: string) => {
    const current = sessionLabels || []
    // Valued entries are stored as "id::value", so compare ids: picking an applied label again must not
    // append a bare duplicate (for a valued label it opens the existing chip's editor instead, below).
    const alreadyApplied = current.some(entry => extractLabelId(entry) === labelId)
    if (!alreadyApplied) onLabelsChange?.([...current, labelId])

    // A valued label needs its value: the chip in the chat header opens its editor once the label
    // arrives. Compact headers show no chips, so there is nothing to open there.
    const config = flattenLabels(labels || []).find(label => label.id === labelId)
    if (config?.valueType && !compactMode) {
      setPendingLabelValueEdit({ sessionId, panelId, labelId, requestedAt: Date.now() })
    }
  }, [labels, onLabelsChange, sessionLabels, compactMode, sessionId, panelId, setPendingLabelValueEdit])

  const handleQueueSteer = React.useCallback((messageId: string) => {
    window.electronAPI.queueSendNow(sessionId, messageId).catch((error) => {
      console.error('[ChatInputZone] Failed to steer queued message:', error)
    })
  }, [sessionId])

  const handleQueueDelete = React.useCallback((messageId: string) => {
    window.electronAPI.queueDelete(sessionId, messageId).catch((error) => {
      console.error('[ChatInputZone] Failed to delete queued message:', error)
    })
  }, [sessionId])

  const handleQueueReorder = React.useCallback((messageId: string, toIndex: number) => {
    // No optimistic reorder: the server owns the order the model will actually
    // see, and it broadcasts `queue_changed` when it has applied this one.
    window.electronAPI.queueReorder(sessionId, messageId, toIndex).catch((error) => {
      console.error('[ChatInputZone] Failed to reorder queued message:', error)
    })
  }, [sessionId])

  const handleQueueEdit = React.useCallback((messageId: string, text: string) => {
    window.electronAPI.queueDelete(sessionId, messageId)
      .then(() => {
        onInputChange?.(text)
      })
      .catch((error) => {
        console.error('[ChatInputZone] Failed to edit queued message:', error)
      })
  }, [onInputChange, sessionId])

  const handleQueueResume = React.useCallback(() => {
    window.electronAPI.queueResume(sessionId).catch((error) => {
      console.error('[ChatInputZone] Failed to resume queue:', error)
    })
  }, [sessionId])

  return (
    <div className={cn(
      CHAT_LAYOUT.maxWidth,
      'mx-auto w-full mt-1',
      // The card lines up with the transcript's text edge: the 16px gutter in compact, the column's
      // 24px gutters on desktop (the hint line below the card reserves its own 24px)
      compactMode ? CHAT_LAYOUT.controlGutterCompact : CHAT_LAYOUT.controlGutter,
      compactMode ? 'pb-gutter' : 'pb-3.5',
      className,
    )}>
      <ComposerCapabilitiesProvider value={composerCapabilities}>
        {shouldShowOptionBadges && (
          <ActiveOptionBadges
            permissionMode={permissionMode}
            // The permission-mode chip lives in the composer toolbar next to the model (spec §7.5).
            // A decision prompt replaces that toolbar, so the chip moves up here while one is shown.
            showPermissionMode={!!inputProps.structuredInput}
            onPermissionModeChange={onPermissionModeChange}
            enabledModes={inputProps.enabledModes}
            cycleHotkey={cycleHotkey}
            neverPersist={neverPersist}
            tasks={tasks}
            sessionId={sessionId}
            workspaceId={workspaceId}
            onStopTask={onStopTask}
            onDismissTask={onDismissTask}
            onOpenTaskOutput={onOpenTaskOutput}
          />
        )}

        <QueuedMessageList
          queue={queueState.queue}
          paused={queueState.paused}
          onSteer={handleQueueSteer}
          onEdit={handleQueueEdit}
          onDelete={handleQueueDelete}
          onReorder={handleQueueReorder}
          onResume={handleQueueResume}
        />

        {pastedSnippet && runPasted && (
          <PastedCommandChip command={pastedSnippet.command} onRun={handleRunPasted} onDismiss={() => setPastedSnippet(null)} />
        )}

        <InputErrorBoundary
          sessionId={sessionId}
          resetKey={inputResetKey}
          onClearDraft={handleClearDraft}
        >
          <>
            <InputContainer
              {...inputProps} queueHoldsUnsteerableRow={queueState.queue.some(isUnsteerableQueueRow)} // F1.481 (3): a draft behind such a row is queued (F1.338), so the control says Queue
              onConsoleSnippetPaste={runPasted ? handleSnippetPaste : undefined}
              compactMode={compactMode}
              permissionMode={permissionMode}
              onPermissionModeChange={onPermissionModeChange}
              labels={labels}
              sessionLabels={sessionLabels}
              onLabelAdd={handleLabelAdd}
              sessionId={sessionId}
              workspaceId={workspaceId}
              currentSessionStatus={currentSessionStatus}
            />
            {/* deep-links.md: "a warning line below the input box reads `Prompt
                from an external link` and stays visible until you send or clear
                the prompt." Below the box on purpose — the user's own text is
                what has to be read, so the disclosure must not push it down. */}
            {externalPromptNotice && (
              <div
                role="status"
                className="flex items-start gap-1.5 px-2 pt-1.5 text-label-sm text-secondary"
              >
                <AlertTriangle aria-hidden className="mt-0.5 size-3.5 shrink-0 text-info" />
                <span className="min-w-0">
                  {externalPromptNotice.count === undefined
                    ? t(externalPromptNotice.key)
                    : t(externalPromptNotice.key, { count: externalPromptNotice.count })}
                </span>
              </div>
            )}
            {/* UB14.31 — the folder and branch chips that sat in a footer row here moved INTO the composer
                toolbar (FreeFormInput: attach · sources · folder · branch); below the card sit only this
                notice and, under it, the hint line. */}
          </>
        </InputErrorBoundary>

        {/* Desktop shortcut hints: reserved height, shown while the composer has focus. A later sibling of the
            card's `peer/composer` wrapper (InputErrorBoundary renders its children in place), as the fade needs. */}
        {!compactMode && <ComposerHintLine empty={!!inputProps.structuredInput} cycleHotkey={cycleHotkey} />}
      </ComposerCapabilitiesProvider>
    </div>
  )
}
