import { formatDistanceToNowStrict } from "date-fns"
import type { Locale } from "date-fns"
import { AlertCircle, Flag, Hand } from "lucide-react"
import { useActionLabel } from "@/actions"
import { cn } from "@/lib/utils"
import { rendererPerf } from "@/lib/perf"
import { Spinner } from "@nessy-agent/ui"
import { EntityRow } from "@/components/ui/entity-row"
import { SessionMenu } from "./SessionMenu"
import { BatchSessionMenu } from "./BatchSessionMenu"
import { CompactSessionMenu } from "./CompactSessionMenu"
import { SessionStatusIcon } from "./SessionStatusIcon"
import { SessionBadges } from "./SessionBadges"
import { SessionRowPermissionAnswer } from "./SessionRowPermissionAnswer"
import { hasTransferTargets } from "./transfer-targets"
import { SessionProjectColorWrapper } from "./SessionProjectColorWrapper"
import { useProjectColorTreatment } from "@/hooks/useProjectColorTreatment"
import { getSessionTitle, getSessionPreviewText, highlightMatch, hasUnreadMeta, shortTimeLocale } from "@/utils/session"
import { useTranslation } from "react-i18next"
import { useSessionListContext } from "@/context/SessionListContext"
import { useAppShellContext, usePendingPermission } from "@/context/AppShellContext"
import { navigate, routes } from "@/lib/navigate"
import { sessionAttentionPrompt, sessionAttentionState, sessionAwaitsApproval, type SessionMeta } from "@/atoms/sessions"
import { extractLabelId } from "@nessy-agent/shared/labels"

/** Plan-ready mark (paper plane) — the glyph the row's marker strip used, now on the subtitle line (v0.15.1). */
function PlanReadyIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 25 24" fill="currentColor" aria-hidden="true">
      <path fillRule="nonzero" d="M13.7207031,22.6523438 C13.264974,22.6523438 12.9361979,22.4895833 12.734375,22.1640625 C12.5325521,21.8385417 12.360026,21.4316406 12.2167969,20.9433594 L10.6640625,15.7871094 C10.5729167,15.4615885 10.5403646,15.1995443 10.5664062,15.0009766 C10.5924479,14.8024089 10.6998698,14.6022135 10.8886719,14.4003906 L20.859375,3.6484375 C20.9179688,3.58984375 20.9472656,3.52473958 20.9472656,3.453125 C20.9472656,3.38151042 20.921224,3.32291667 20.8691406,3.27734375 C20.8170573,3.23177083 20.7568359,3.20735677 20.6884766,3.20410156 C20.6201172,3.20084635 20.5566406,3.22851562 20.4980469,3.28710938 L9.78515625,13.296875 C9.5703125,13.4921875 9.36197917,13.601237 9.16015625,13.6240234 C8.95833333,13.6468099 8.70117188,13.609375 8.38867188,13.5117188 L3.11523438,11.9101562 C2.64648438,11.7669271 2.25911458,11.5960286 1.953125,11.3974609 C1.64713542,11.1988932 1.49414062,10.875 1.49414062,10.4257812 C1.49414062,10.0742188 1.63411458,9.77148438 1.9140625,9.51757812 C2.19401042,9.26367188 2.5390625,9.05859375 2.94921875,8.90234375 L19.7460938,2.46679688 C19.9739583,2.38216146 20.1871745,2.31542969 20.3857422,2.26660156 C20.5843099,2.21777344 20.764974,2.19335938 20.9277344,2.19335938 C21.2467448,2.19335938 21.4973958,2.28450521 21.6796875,2.46679688 C21.8619792,2.64908854 21.953125,2.89973958 21.953125,3.21875 C21.953125,3.38802083 21.9287109,3.5703125 21.8798828,3.765625 C21.8310547,3.9609375 21.7643229,4.17252604 21.6796875,4.40039062 L15.2832031,21.109375 C15.1009115,21.578125 14.8828125,21.952474 14.6289062,22.2324219 C14.375,22.5123698 14.0722656,22.6523438 13.7207031,22.6523438 Z" />
    </svg>
  )
}

export interface SessionItemProps {
  item: SessionMeta
  index: number
  itemProps: Record<string, unknown>
  isSelected: boolean
  isFirstInGroup: boolean
  isInMultiSelect: boolean
  onSelect: () => void
  onToggleSelect?: () => void
  onRangeSelect?: () => void
}

/**
 * One session row — v0.15.1's anatomy (design spec §2.4 "one slot, one meaning", §7.2), UB14.3, merged
 * with ours:
 * - leading glyph = the user's workflow status (click to change it);
 * - title (600 when unread) · age (unread: led by an 8px accent dot, age in accent);
 * - subtitle = run state with its own shape and colour (needs you · working · failed · plan ready),
 *   else the decision model's verdict (UB6.15, ours), else the labels (chips tinted with each label's
 *   colour, "+N" expands them), else the activity line (P6.504's own last words, else the preview).
 *
 * The run state is upstream's, computed from OUR predicates: "needs you" is `sessionAwaitsApproval`,
 * which also reads the server's `awaitingApprovalCount` (P6.757), so a prompt raised before this
 * window connected still counts — for Pi, Claude and Codex alike, through the same count.
 */
export function SessionItem({
  item,
  itemProps,
  isSelected,
  isFirstInGroup: _isFirstInGroup,
  isInMultiSelect,
  onSelect,
  onToggleSelect,
  onRangeSelect,
}: SessionItemProps) {
  const ctx = useSessionListContext()
  const { workspaces, isCompactMode, onRespondToPermission } = useAppShellContext()
  const canSendToWorkspace = hasTransferTargets(workspaces)
  const { hotkey: nextHotkey } = useActionLabel('chat.nextSearchMatch')
  const { hotkey: prevHotkey } = useActionLabel('chat.prevSearchMatch')
  const title = getSessionTitle(item)
  // For the active session, prefer logical match count over ripgrep count
  const activeMatch = ctx.activeChatMatchInfo
  const isActiveSession = isSelected && activeMatch?.sessionId === item.id
  const ripgrepMatchCount = ctx.contentSearchResults.get(item.id)?.matchCount
  const chatMatchCount = isActiveSession ? activeMatch!.count : ripgrepMatchCount
  const hasMatch = chatMatchCount != null && chatMatchCount > 0
  const hasLabels = !!(item.labels && item.labels.length > 0 && ctx.flatLabels.length > 0 && item.labels.some(entry => {
    const labelId = extractLabelId(entry)
    return ctx.flatLabels.some(l => l.id === labelId)
  }))
  const isUnread = hasUnreadMeta(item)
  // P6.757 — "needs you" is drawn from BOTH sources, through the one predicate
  // `sessionAttentionState` also calls, so the line and its accessible name
  // cannot disagree: this window's own `pendingPermissions` map, and the
  // server's `awaitingApprovalCount`, which is what iOS has read since F15 and
  // is the only half that can see a prompt raised before this window connected.
  const hasLocalPendingPrompt = ctx.hasPendingPrompt?.(item.id) ?? false
  const hasPendingPrompt = sessionAwaitsApproval(item, hasLocalPendingPrompt)

  // Run state owns the subtitle line; attention states win (spec §2.4).
  const runState: 'needs-you' | 'working' | 'failed' | 'plan' | null = hasPendingPrompt
    ? 'needs-you'
    : item.isProcessing
      ? 'working'
      : item.lastMessageRole === 'error'
        ? 'failed'
        : item.lastMessageRole === 'plan'
          ? 'plan'
          : null
  const needsAttention = runState === 'needs-you' || runState === 'failed'

  // P6.270 — one classifier decides which state this row is in, and one label
  // describes it, so the line, its tooltip and its accessible name cannot
  // disagree; and for the state the user has to clear, the label names WHAT is
  // waiting rather than only that something is. Since UB14.3 the label is the
  // run-state line's `title` and `aria-label` (the marker strip it lived on is
  // gone with v0.15.1's anatomy).
  const { t } = useTranslation()
  const pendingPermission = usePendingPermission(item.id)
  const attention = sessionAttentionState(item, hasLocalPendingPrompt)
  // P6.764 — the subject of the wait, from this window's live card when it has
  // one and otherwise from the DTO the server already sends. Before this row
  // only the local map was read, so every prompt raised before this window
  // connected — the exact case `awaitingApprovalCount` exists for — showed the
  // subjectless label while the server knew the answer.
  const waitingOn = sessionAttentionPrompt(item, pendingPermission)
  const attentionLabel = attention === 'waiting'
    ? waitingOn?.type === 'ask_user'
      ? t('session.attention.waitingOnQuestion')
      // `toolName` is the one field every prompt shape carries; `command` and
      // `appName` are optional and a missing one would render "undefined".
      : waitingOn?.toolName
        ? t('session.attention.waitingOn', { prompt: waitingOn.toolName })
        : t('session.attention.waiting')
    : attention === 'running'
      ? t('session.attention.running')
      : undefined
  // The label rides only the line that states the same thing (needs you · working).
  const runStateLabel = runState === 'needs-you' || runState === 'working' ? attentionLabel : undefined

  /**
   * P6.504 — the one line saying what this session is doing.
   *
   * `item.lastOutputSummary` is the session's OWN last words, extracted at save
   * time by `summarizeSessionOutput` (`packages/shared/src/sessions`). Q-den 22
   * chose that over a per-row mini-model turn, which is a recurring charge the
   * user cannot see and which on our default gateway lands on the MAIN model.
   *
   * It does not invent a line when the session has produced no readable output —
   * a fresh session keeps the first-user-message preview (v0.15.1 shows it on
   * every layout, not only compact) — and it does not present the line as OUR
   * summary: the tooltip says whose words these are, because a line that reads
   * long or fragmentary after a tool-heavy turn is the derivation's known limit
   * and must be legible as such rather than discovered.
   */
  // UB6.15 — the visible reason when the decision model moved the session to Needs
  // Review at turn end: the row's secondary line names the outcome and the confidence
  // instead of the activity line (the reason is the fresher fact, and the point of
  // the move); the tooltip names who set it. It outranks the labels for the same
  // reason the run state does (an attention fact, ours).
  const decisionLineNode = item.statusSetByDecision
    ? (
      <span title={t('sessions.statusSetByDecision')}>
        {t('sessions.statusSetByDecisionDetail', {
          outcome: item.statusSetByDecision.outcome,
          probability: Math.round(item.statusSetByDecision.probability * 100),
        })}
      </span>
    )
    : null
  // One line, one subject: run state, else the decision verdict, else labels (full width), else the
  // activity line. Squeezing the preview and the chips into one line truncated both into fragments.
  const showLabels = hasLabels && !needsAttention && !decisionLineNode
  const activityLineNode = item.lastOutputSummary
    ? <span title={t('session.lastOutput.hint')}>{item.lastOutputSummary}</span>
    : getSessionPreviewText(item)

  /**
   * P6.589 — the one-shot answer, offered exactly where the row already says
   * this session is waiting: beside the "needs you" line (the labels give that
   * slot up while the row needs attention).
   *
   * The always-allow flag is decided inside the component and is deliberately not
   * reachable from here: a permission answered without seeing the conversation
   * must never widen the session. The component returns `null` for every
   * non-answerable state — no request, no handler, an `ask_user` question — so
   * the `waiting` guard is an optimisation for a list that re-renders often,
   * not a correctness condition. The other three halves mirror those `null`s so
   * that a row the control would draw nothing on — a prompt this window has no
   * card for (the server count alone), a question, no handler — does not reserve
   * the line's trailing slot for it.
   */
  const answerControl = attention === 'waiting' && pendingPermission && pendingPermission.type !== 'ask_user' && onRespondToPermission
    ? (
      <SessionRowPermissionAnswer
        sessionId={item.id}
        request={pendingPermission}
        onRespond={onRespondToPermission}
        className="ml-auto"
      />
    )
    : null

  // UA5.9 (v0.13.4) — Resolve the bound project so the row can show a project-themed stripe /
  // tint and reveal the project name on hover. Treatment is a user preference
  // under Appearance.
  const projectColorTreatment = useProjectColorTreatment()
  const boundProject = item.projectId
    ? ctx.projects?.find(p => p.id === item.projectId)
    : undefined
  const projectColor = boundProject?.color
  const projectName = boundProject?.name

  const handleClick = (e: React.MouseEvent) => {
    ctx.onFocusZone()
    if (e.button === 2) {
      if (ctx.isMultiSelectActive && !isInMultiSelect && onToggleSelect) onToggleSelect()
      return
    }
    if ((e.metaKey || e.ctrlKey) && e.shiftKey) {
      // Cmd+Shift+Click: open session in a new panel
      e.preventDefault()
      navigate(routes.view.allSessions(item.id), { newPanel: true })
      return
    }
    if ((e.metaKey || e.ctrlKey) && onToggleSelect) {
      // Cmd+Click: always toggle multi-select (standard OS behavior)
      e.preventDefault()
      onToggleSelect()
      return
    }
    if (e.shiftKey && onRangeSelect) {
      e.preventDefault()
      onRangeSelect()
      return
    }
    rendererPerf.startSessionSwitch(item.id)
    onSelect()
  }

  const runStateLine = runState ? (
    <span
      data-run-state={runState}
      className={cn(
        "flex items-center gap-1.5 min-w-0",
        runState === 'needs-you' && "text-info",
        runState === 'failed' && "text-destructive",
      )}
      title={runStateLabel}
      aria-label={runStateLabel}
      role={runStateLabel ? 'status' : undefined}
    >
      {runState === 'needs-you' ? (
        <Hand className="size-3.5 shrink-0" aria-hidden="true" />
      ) : runState === 'working' ? (
        <Spinner className="text-label text-accent shrink-0" />
      ) : runState === 'failed' ? (
        <AlertCircle className="size-3.5 shrink-0" aria-hidden="true" />
      ) : (
        <PlanReadyIcon className="size-3.5 shrink-0 text-success" />
      )}
      <span className="truncate">
        {t(runState === 'needs-you'
          ? "session.runState.needsYou"
          : runState === 'working'
            ? "session.runState.working"
            : runState === 'failed'
              ? "session.runState.failed"
              : "session.runState.planReady")}
      </span>
    </span>
  ) : null

  const subtitle = runStateLine ?? decisionLineNode ?? (showLabels ? undefined : activityLineNode)
  const subtitleTrailing = runState === 'needs-you'
    ? answerControl ?? undefined
    : showLabels ? <SessionBadges item={item} /> : undefined

  return (
    <SessionProjectColorWrapper color={projectColor} treatment={projectColorTreatment}>
    <EntityRow
      className="session-item"
      dataAttributes={{ 'data-session-id': item.id }}
      isSelected={isSelected}
      isInMultiSelect={isInMultiSelect}
      // UA5.9 (v0.13.4) — When a project stripe is drawn at the leading edge, suppress EntityRow's
      // own multi-select bar so they don't stack. The row's background tint
      // continues to convey "selected".
      suppressSelectionBar={!!projectColor}
      onMouseDown={handleClick}
      buttonProps={{
        ...itemProps,
        onKeyDown: (e: React.KeyboardEvent) => {
          ;(itemProps as { onKeyDown: (event: React.KeyboardEvent) => void }).onKeyDown(e)
          ctx.onKeyDown(e, item)
        },
      }}
      moreButtonLabel={t("session.actionsFor", { title })}
      menuContent={
        <SessionMenu
          item={item}
          sessionStatuses={ctx.sessionStatuses}
          labels={ctx.labels}
          onLabelsChange={ctx.onLabelsChange ? (ls) => ctx.onLabelsChange!(item.id, ls) : undefined}
          onRename={() => ctx.onRenameClick(item.id, title)}
          onFlag={() => ctx.onFlag?.(item.id)}
          onUnflag={() => ctx.onUnflag?.(item.id)}
          onArchive={() => ctx.onArchive?.(item.id)}
          onUnarchive={() => ctx.onUnarchive?.(item.id)}
          onMarkUnread={() => ctx.onMarkUnread(item.id)}
          onSessionStatusChange={(s) => ctx.onSessionStatusChange(item.id, s)}
          onOpenInNewWindow={() => ctx.onOpenInNewWindow(item)}
          onSendToWorkspace={ctx.onSendToWorkspace ? () => ctx.onSendToWorkspace!([item.id]) : undefined}
          hasTransferTargets={canSendToWorkspace}
          onDelete={() => ctx.onDelete(item.id)}
          projects={ctx.projects}
          onSetProjectId={ctx.onSetProjectId ? (pid) => ctx.onSetProjectId!(item.id, pid) : undefined}
        />
      }
      contextMenuContent={ctx.isMultiSelectActive && isInMultiSelect ? <BatchSessionMenu /> : undefined}
      isCompactMode={isCompactMode}
      compactMenu={({ open, onOpenChange }) => (
        <CompactSessionMenu
          open={open}
          onOpenChange={onOpenChange}
          trigger={null}
          title={title}
          item={item}
          sessionStatuses={ctx.sessionStatuses}
          labels={ctx.labels}
          hasTransferTargets={canSendToWorkspace}
          onLabelsChange={ctx.onLabelsChange ? (ls) => ctx.onLabelsChange!(item.id, ls) : undefined}
          onRename={() => ctx.onRenameClick(item.id, title)}
          onFlag={() => ctx.onFlag?.(item.id)}
          onUnflag={() => ctx.onUnflag?.(item.id)}
          onArchive={() => ctx.onArchive?.(item.id)}
          onUnarchive={() => ctx.onUnarchive?.(item.id)}
          onMarkUnread={() => ctx.onMarkUnread(item.id)}
          onSessionStatusChange={(s) => ctx.onSessionStatusChange(item.id, s)}
          onOpenInNewWindow={() => ctx.onOpenInNewWindow(item)}
          onSendToWorkspace={ctx.onSendToWorkspace ? () => ctx.onSendToWorkspace!([item.id]) : undefined}
          onDelete={() => ctx.onDelete(item.id)}
        />
      )}
      icon={<SessionStatusIcon item={item} />}
      title={ctx.searchQuery ? highlightMatch(title, ctx.searchQuery) : title}
      titleClassName={cn(isUnread && "font-semibold", item.isAsyncOperationOngoing && "animate-shimmer-text")}
      subtitle={subtitle}
      subtitleTrailing={subtitleTrailing}
      // UA5.9 (v0.13.4) — the bound project's name on hover. Upstream's same hunk also brings the messaging
      // pills back (`hasMessagingBinding`, `PLATFORM_LABEL`); messaging is removed in ours, so only the project part.
      titleSuffix={projectName ? (
        <div className="flex items-center gap-1">
          {/* Revealed on hover/focus only, and out of the layout otherwise: an invisible (opacity-0)
              name still reserved its width and cut the title short for nothing. Solved tertiary
              text, not the raw project colour (v0.15.1: coloured text failed AA); the stripe carries the colour. */}
          <span
            className="hidden group-hover:inline group-focus-within:inline text-label-sm text-tertiary whitespace-nowrap truncate max-w-[120px]"
            title={projectName}
          >
            {projectName}
          </span>
        </div>
      ) : undefined}
      titleTrailing={isUnread && !hasMatch ? (
        // Unread: an accent dot leads the meta and the age turns accent, so the signal sits on the
        // row's own grid (the trailing slot) instead of floating in the bleed past the gutter.
        <span className="inline-flex items-center gap-1.5 text-accent">
          <span aria-hidden="true" className="size-2 shrink-0 rounded-full bg-accent-solid" />
          <span className="sr-only">{t("session.unreadIndicator")}</span>
          {item.isFlagged ? (
            <Flag className="size-3.5 text-info" aria-label={t("sidebar.flagged")} />
          ) : item.lastMessageAt ? (
            formatDistanceToNowStrict(new Date(item.lastMessageAt), { locale: shortTimeLocale as Locale, roundingMethod: 'floor' })
          ) : null}
        </span>
      ) : hasMatch ? (
        <span
          className="inline-flex h-[18px] min-w-6 items-center justify-center rounded-xs px-1 text-caption tabular-nums bg-info-tint text-info"
          title={t('session.matchesFound', { next: nextHotkey, prev: prevHotkey })}
        >
          {chatMatchCount}
        </span>
      ) : item.isFlagged ? (
        <Flag className="size-3.5 text-info" aria-label={t("sidebar.flagged")} />
      ) : item.lastMessageAt ? (
        <span>
          {formatDistanceToNowStrict(new Date(item.lastMessageAt), { locale: shortTimeLocale as Locale, roundingMethod: 'floor' })}
        </span>
      ) : undefined}
    />
    </SessionProjectColorWrapper>
  )
}
