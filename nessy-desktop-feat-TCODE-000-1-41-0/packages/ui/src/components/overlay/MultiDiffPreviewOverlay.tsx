/**
 * MultiDiffPreviewOverlay - Overlay for multiple file changes (Edit/Write tools)
 *
 * Layout: Stacked diffs using pierre's native file headers — GitHub PR-like view.
 * Each diff renders its own file header (filename + addition/deletion counts) via @pierre/diffs.
 * No card chrome or collapse — all diffs are visible in a single scrollable area.
 *
 * Features:
 * - Stacked diffs with native pierre file headers (no custom card wrappers)
 * - Consolidated view (group by file) or individual changes
 * - Unified/split diff viewer for each change
 * - Focused change support (scroll to specific change on open)
 * - Header shows file path for single file, "N edits" summary for multiple files
 */

import * as React from 'react'
import { useState, useMemo, useCallback, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { PencilLine, FilePlus, X, MessageSquarePlus, Trash2 } from 'lucide-react'
import { parseDiffFromFile, parsePatchFiles, type FileContents } from '@pierre/diffs'
import { ShikiDiffViewer, getDiffStats } from '../code-viewer/ShikiDiffViewer'
import { UnifiedDiffViewer, getUnifiedDiffStats } from '../code-viewer/UnifiedDiffViewer'
import { DiffViewerControls } from '../code-viewer/DiffViewerControls'
import { LANGUAGE_MAP } from '../code-viewer/language-map'
import { PreviewOverlay, type BadgeVariant } from './PreviewOverlay'
import { usePlatform } from '../../context/PlatformContext'
import { cn } from '../../lib/utils'
import {
  diffCommentKey,
  formatDiffCommentBatch,
  type DiffCommentSide,
  type DiffLineComment,
} from '../../lib/diff-comments'

/**
 * A single file change (Edit or Write)
 *
 * Supports two formats:
 * - Claude Code: original/modified strings (computed diff)
 * - Codex: unifiedDiff string (pre-computed unified diff patch)
 */
export interface FileChange {
  /** Unique ID for this change */
  id: string
  /** Absolute file path */
  filePath: string
  /** Tool type: Edit or Write */
  toolType: 'Edit' | 'Write'
  /** For Edit: the old_string; For Write: empty or previous content if available */
  original: string
  /** For Edit: the new_string; For Write: the written content */
  modified: string
  /** Codex format: raw unified diff string (alternative to original/modified) */
  unifiedDiff?: string
  /** Error message if the tool failed */
  error?: string
}

/**
 * Diff viewer display preferences
 * Passed from parent to avoid localStorage usage - all settings stored in preferences.json
 */
export interface DiffViewerSettings {
  diffStyle: 'unified' | 'split'
  disableBackground: boolean
}

export interface MultiDiffPreviewOverlayProps {
  /** Whether the overlay is visible */
  isOpen: boolean
  /** Callback when the overlay should close */
  onClose: () => void
  /** List of file changes to display */
  changes: FileChange[]
  /** Whether to consolidate changes by file path (default: true) */
  consolidated?: boolean
  /** ID of change to focus on initially */
  focusedChangeId?: string
  /** Theme mode */
  theme?: 'light' | 'dark'
  /** Render inline without dialog (for playground) */
  embedded?: boolean
  /** Initial diff viewer settings (from user preferences) */
  diffViewerSettings?: Partial<DiffViewerSettings>
  /** Callback when diff viewer settings change (to persist to preferences) */
  onDiffViewerSettingsChange?: (settings: DiffViewerSettings) => void

  /**
   * P6.306 — submit the batch of line-anchored comments as the next turn.
   *
   * Given the ALREADY-FORMATTED text (`formatDiffCommentBatch`) rather than the
   * comment objects, so the wire shape is decided in one place a test can hold
   * still and every consumer sends the same thing. Absent, the whole affordance
   * is off and this overlay renders exactly as it did before this row —
   * line selection included, since that is what enables it in the viewers.
   */
  onSubmitComments?: (text: string) => void
}

// ============================================
// Helpers
// ============================================

/** A group of changes for a single file (or a single ungrouped change) */
interface FileSection {
  key: string
  filePath: string
  changes: FileChange[]
}

/**
 * Groups changes into file sections.
 * In consolidated mode, changes to the same file are grouped together.
 * In non-consolidated mode, each change is its own section.
 */
function createFileSections(changes: FileChange[], consolidated: boolean): FileSection[] {
  if (!consolidated) {
    return changes.map(change => ({
      key: change.id,
      filePath: change.filePath,
      changes: [change],
    }))
  }

  // Group by file path, preserving order of first occurrence
  const byPath = new Map<string, FileChange[]>()
  for (const change of changes) {
    const existing = byPath.get(change.filePath) || []
    existing.push(change)
    byPath.set(change.filePath, existing)
  }

  return Array.from(byPath.entries()).map(([filePath, fileChanges]) => ({
    key: filePath,
    filePath,
    changes: fileChanges,
  }))
}

/** Compute diff stats for a single change */
function computeChangeStats(change: FileChange): { additions: number; deletions: number } {
  // Handle Codex format: unified diff string
  if (change.unifiedDiff) {
    const stats = getUnifiedDiffStats(change.unifiedDiff, change.filePath)
    return stats || { additions: 0, deletions: 0 }
  }

  // Handle Claude Code format: original/modified strings
  const ext = change.filePath.split('.').pop()?.toLowerCase() || ''
  const lang = LANGUAGE_MAP[ext] || 'text'
  const oldFile: FileContents = { name: change.filePath, contents: change.original, lang: lang as any }
  const newFile: FileContents = { name: change.filePath, contents: change.modified, lang: lang as any }
  const fileDiff = parseDiffFromFile(oldFile, newFile)
  return getDiffStats(fileDiff)
}

// ============================================
// Main Component
// ============================================

export function MultiDiffPreviewOverlay({
  isOpen,
  onClose,
  changes,
  consolidated = true,
  focusedChangeId,
  theme = 'light',
  embedded,
  diffViewerSettings,
  onDiffViewerSettingsChange,
  onSubmitComments,
}: MultiDiffPreviewOverlayProps) {
  const { t } = useTranslation()
  const { onOpenFileExternal } = usePlatform()

  // ── P6.306 — line-anchored review comments ───────────────────────────
  /**
   * The batch, keyed by anchor so a second comment on one line REPLACES the
   * first. A Map rather than an array because the anchor IS the identity: the
   * viewers de-duplicate by the same key when they project annotations, and two
   * sources of truth for "how many comments are on this line" is how a batch
   * submits a comment the reader thought they had overwritten.
   */
  const [comments, setComments] = useState<Map<string, DiffLineComment>>(() => new Map())
  /** The anchor currently being written, or `null` when no box is open. */
  const [draftAnchor, setDraftAnchor] = useState<DiffLineComment | null>(null)
  const [draftBody, setDraftBody] = useState('')

  const commentsForFile = useCallback((filePath: string): DiffLineComment[] =>
    [...comments.values()].filter(comment => comment.filePath === filePath), [comments])

  const openDraft = useCallback((filePath: string) =>
    (anchor: { lineNumber: number; side: DiffCommentSide; lineText?: string }) => {
      const key = diffCommentKey({ filePath, ...anchor })
      const existing = comments.get(key)
      setDraftAnchor({ filePath, ...anchor, body: existing?.body ?? '' })
      setDraftBody(existing?.body ?? '')
    }, [comments])

  const commitDraft = useCallback(() => {
    if (!draftAnchor) return
    const body = draftBody.trim()
    const key = diffCommentKey(draftAnchor)
    setComments(previous => {
      const next = new Map(previous)
      // An emptied box DELETES the comment rather than storing a blank one —
      // clearing the text is the only "undo" the affordance offers.
      if (body.length === 0) next.delete(key)
      else next.set(key, { ...draftAnchor, body })
      return next
    })
    setDraftAnchor(null)
    setDraftBody('')
  }, [draftAnchor, draftBody])

  const removeComment = useCallback((comment: DiffLineComment) => {
    setComments(previous => {
      const next = new Map(previous)
      next.delete(diffCommentKey(comment))
      return next
    })
  }, [])

  /**
   * One saved comment, rendered inside pierre's annotation grid.
   *
   * The overlay owns this rather than the viewers so the two viewers stay
   * identical and hold no comment UI of their own — the row's whole point is
   * that the reader sees the same thing whichever runtime produced the diff.
   */
  const renderComment = useCallback((comment: DiffLineComment) => (
    <div className="mx-4 my-1 rounded-[8px] bg-foreground-3 px-3 py-2 text-sm shadow-minimal">
      <div className="flex items-start gap-2">
        <p className="flex-1 min-w-0 whitespace-pre-wrap break-words text-foreground">{comment.body}</p>
        <button
          type="button"
          aria-label={t('diff.removeComment')}
          className="shrink-0 text-foreground/40 hover:text-destructive"
          onClick={() => removeComment(comment)}
        >
          <Trash2 className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  ), [removeComment, t])

  const submitComments = useCallback(() => {
    const text = formatDiffCommentBatch([...comments.values()])
    if (!text) return
    onSubmitComments?.(text)
    setComments(new Map())
    setDraftAnchor(null)
    setDraftBody('')
    // The batch IS the turn, so the diff it was written against has been
    // answered; leaving the overlay open would invite a second batch on a diff
    // the next turn is already replacing.
    onClose()
  }, [comments, onSubmitComments, onClose])

  // Ref map for scroll-to-focused-change support
  const changeRefs = useRef<Map<string, HTMLDivElement>>(new Map())

  // Build file sections (grouped or ungrouped)
  const fileSections = useMemo(() => {
    return createFileSections(changes, consolidated)
  }, [changes, consolidated])

  // ── Fade-in reveal ──────────────────────────────────────────────────
  // Content starts invisible (opacity 0) while ShikiDiffViewers load and
  // scroll position is achieved. Once all diffs fire onReady AND scroll is
  // done, we reveal with a CSS transition. If everything is ready within
  // the first frame (~50ms), we skip the transition for an instant show.
  // Only count visible (non-error) diffs for reveal gating
  const diffCount = useMemo(() => changes.filter(c => !c.error).length, [changes])
  const readyCountRef = useRef(0)
  const scrollDoneRef = useRef(!focusedChangeId) // no scroll needed → already done
  const revealedRef = useRef(false)
  const mountedAtRef = useRef(performance.now())
  const [contentVisible, setContentVisible] = useState(false)
  const [animateReveal, setAnimateReveal] = useState(true)

  const checkReveal = useCallback(() => {
    if (revealedRef.current) return
    if (readyCountRef.current >= diffCount && scrollDoneRef.current) {
      revealedRef.current = true
      // If all conditions met within first frame, show instantly (no transition)
      const elapsed = performance.now() - mountedAtRef.current
      if (elapsed < 50) setAnimateReveal(false)
      setContentVisible(true)
    }
  }, [diffCount])

  const handleDiffReady = useCallback(() => {
    readyCountRef.current++
    checkReveal()
  }, [checkReveal])

  // Check reveal on mount — handles edge cases like diffCount=0 (all errors)
  useEffect(() => {
    checkReveal()
  }, [checkReveal])

  // Diff viewer controls state — initialized from props (user preferences)
  // Settings are persisted via onDiffViewerSettingsChange callback to preferences.json
  const [diffStyle, setDiffStyleInternal] = useState<'unified' | 'split'>(
    diffViewerSettings?.diffStyle ?? 'unified'
  )
  const [disableBackground, setDisableBackgroundInternal] = useState(
    diffViewerSettings?.disableBackground ?? false
  )

  // Wrap setters to also call the persistence callback
  const setDiffStyle = useCallback((style: 'unified' | 'split') => {
    setDiffStyleInternal(style)
    onDiffViewerSettingsChange?.({ diffStyle: style, disableBackground })
  }, [disableBackground, onDiffViewerSettingsChange])

  const setDisableBackground = useCallback((disabled: boolean) => {
    setDisableBackgroundInternal(disabled)
    onDiffViewerSettingsChange?.({ diffStyle, disableBackground: disabled })
  }, [diffStyle, onDiffViewerSettingsChange])

  // Compute total diff stats for the overlay header
  const totalStats = useMemo(() => {
    let additions = 0
    let deletions = 0
    for (const change of changes) {
      if (change.error) continue
      const stats = computeChangeStats(change)
      additions += stats.additions
      deletions += stats.deletions
    }
    return { additions, deletions }
  }, [changes])

  // Scroll to focused change after mount, then signal scroll completion for reveal
  useEffect(() => {
    if (!focusedChangeId) {
      scrollDoneRef.current = true
      checkReveal()
      return
    }

    // Small delay to allow ShikiDiffViewer to render (async syntax highlighting)
    const timer = setTimeout(() => {
      const el = changeRefs.current.get(focusedChangeId)
      if (el) {
        el.scrollIntoView({ behavior: 'instant', block: 'start' })
      }
      scrollDoneRef.current = true
      checkReveal()
    }, 150)

    return () => clearTimeout(timer)
  }, [focusedChangeId, checkReveal])

  // Determine header content based on single vs. multiple files
  const isMultiFile = fileSections.length > 1
  const totalChangeCount = fileSections.reduce((acc, s) => acc + s.changes.length, 0)

  // Type badge: for single file, show Edit/Write; for multi-file, show edit count
  const typeBadge = useMemo((): { icon: typeof PencilLine; label: string; variant: BadgeVariant } => {
    const hasWrite = changes.some(c => c.toolType === 'Write' && !c.error)
    if (isMultiFile) {
      return {
        icon: hasWrite ? FilePlus : PencilLine,
        label: t('diff.editCount', { count: totalChangeCount }),
        variant: hasWrite ? 'green' : 'orange',
      }
    }
    // Single file — show tool type and count if multiple changes
    const firstSection = fileSections[0]
    if (!firstSection) return { icon: PencilLine, label: t('diff.edit'), variant: 'orange' }
    const sectionHasWrite = firstSection.changes.some(c => c.toolType === 'Write')
    const count = firstSection.changes.length
    return {
      icon: sectionHasWrite ? FilePlus : PencilLine,
      label: count > 1
        ? (sectionHasWrite ? t('diff.writeBadgeCount', { count }) : t('diff.editBadgeCount', { count }))
        : (sectionHasWrite ? t('diff.write') : t('diff.edit')),
      variant: sectionHasWrite ? 'green' : 'orange',
    }
  }, [changes, isMultiFile, totalChangeCount, fileSections, t])

  // Header file path (single file) or summary title (multi-file)
  const headerFilePath = !isMultiFile ? fileSections[0]?.filePath : undefined
  const headerTitle = isMultiFile
    ? t('diff.editsSummary', { edits: t('diff.editCount', { count: totalChangeCount }), files: t('diff.editFileCount', { count: fileSections.length }) })
    : undefined

  // Header actions: total diff stats + viewer controls
  const headerActions = (
    <DiffViewerControls
      additions={totalStats.additions}
      deletions={totalStats.deletions}
      diffStyle={diffStyle}
      onDiffStyleChange={setDiffStyle}
      disableBackground={disableBackground}
      onBackgroundChange={setDisableBackground}
    />
  )

  // Ref callback to register each change element for scroll-to support
  const setChangeRef = useCallback((changeId: string, el: HTMLDivElement | null) => {
    if (el) {
      changeRefs.current.set(changeId, el)
    } else {
      changeRefs.current.delete(changeId)
    }
  }, [])

  return (
    <PreviewOverlay
      isOpen={isOpen}
      onClose={onClose}
      theme={theme}
      typeBadge={typeBadge}
      filePath={headerFilePath}
      title={headerTitle}
      headerActions={headerActions}
      embedded={embedded}
      className="bg-foreground-3"
    >
      {/* Stacked diffs — flow layout inside parent scroll container.
          Hidden until all diffs are loaded + scroll position achieved (fade-in reveal). */}
      <div
        className={cn(
          "flex px-6 min-h-full",
          animateReveal && "transition-opacity duration-150"
        )}
        style={{ opacity: contentVisible ? 1 : 0 }}
      >
        <div className="m-auto" style={{ width: 'max-content', maxWidth: '100%', minWidth: 'min(850px, 100%)' }}>
          {/* Stacked diffs: each ShikiDiffViewer renders with pierre's native file header.
              No card chrome or collapse — continuous stacked layout like a GitHub PR diff. */}
          <div className="flex flex-col gap-4">
            {fileSections.map((section) => (
              <div key={section.key} className="flex flex-col gap-4">
                {section.changes.map((change) => (
                  <div
                    key={change.id}
                    ref={(el) => setChangeRef(change.id, el)}
                    className="rounded-xl overflow-hidden bg-background shadow-minimal"
                    style={{ minHeight: change.error ? undefined : 200, borderRadius: 12 }}
                  >
                    {change.error ? (
                      // Errored change — tinted error banner
                      <div className="px-4 py-4">
                        <div
                          className="flex items-start gap-3 px-4 py-3 rounded-[8px] bg-[color-mix(in_oklab,var(--destructive)_5%,var(--background))] shadow-tinted"
                          style={{ '--shadow-color': 'var(--destructive)' } as React.CSSProperties}
                        >
                          <X className="w-4 h-4 text-destructive shrink-0 mt-0.5" />
                          <div className="flex-1 min-w-0">
                            <div className="text-xs font-semibold text-destructive/70 mb-0.5">
                              {change.toolType} Failed
                            </div>
                            <p className="text-sm text-destructive whitespace-pre-wrap break-words">
                              {change.error}
                            </p>
                          </div>
                        </div>
                      </div>
                    ) : change.unifiedDiff ? (
                      // Codex format: pre-computed unified diff
                      <UnifiedDiffViewer
                        unifiedDiff={change.unifiedDiff}
                        filePath={change.filePath}
                        diffStyle={diffStyle}
                        disableBackground={disableBackground}
                        disableFileHeader={false}
                        onFileHeaderClick={onOpenFileExternal}
                        theme={theme}
                        onReady={handleDiffReady}
                        {...(onSubmitComments
                          ? {
                            comments: commentsForFile(change.filePath),
                            onCommentAnchor: openDraft(change.filePath),
                            renderComment,
                          }
                          : {})}
                      />
                    ) : (
                      // Claude Code format: original/modified strings
                      <ShikiDiffViewer
                        original={change.original}
                        modified={change.modified}
                        filePath={change.filePath}
                        diffStyle={diffStyle}
                        disableBackground={disableBackground}
                        disableFileHeader={false}
                        onFileHeaderClick={onOpenFileExternal}
                        theme={theme}
                        onReady={handleDiffReady}
                        {...(onSubmitComments
                          ? {
                            comments: commentsForFile(change.filePath),
                            onCommentAnchor: openDraft(change.filePath),
                            renderComment,
                          }
                          : {})}
                      />
                    )}
                  </div>
                ))}
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* P6.306 — the draft box and the batch footer. Both are rendered only
          when a consumer wired `onSubmitComments`, so an overlay with no next
          turn to send to shows no affordance that would go nowhere. */}
      {onSubmitComments && draftAnchor && (
        <div className="sticky bottom-0 z-10 border-t border-border bg-background px-6 py-3">
          <div className="mx-auto flex max-w-[850px] flex-col gap-2">
            <div className="text-xs text-foreground/60">
              {`${draftAnchor.filePath}:${draftAnchor.lineNumber}`}
            </div>
            <textarea
              autoFocus
              value={draftBody}
              onChange={event => setDraftBody(event.target.value)}
              onKeyDown={event => {
                // Enter sends the comment to the batch; Shift+Enter is a
                // newline, and Escape abandons it. Deliberately NOT the
                // submit-the-batch key: the batch goes when the reader says so.
                if (event.key === 'Escape') { setDraftAnchor(null); setDraftBody('') }
                if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); commitDraft() }
              }}
              rows={2}
              placeholder={t('diff.commentPlaceholder')}
              className="w-full resize-none rounded-[8px] bg-foreground-3 px-3 py-2 text-sm text-foreground outline-none"
            />
            <div className="flex justify-end gap-2">
              <button
                type="button"
                className="rounded-[6px] px-3 py-1 text-xs text-foreground/60 hover:text-foreground"
                onClick={() => { setDraftAnchor(null); setDraftBody('') }}
              >
                {t('common.cancel')}
              </button>
              <button
                type="button"
                className="rounded-[6px] bg-foreground px-3 py-1 text-xs text-background"
                onClick={commitDraft}
              >
                {t('diff.addComment')}
              </button>
            </div>
          </div>
        </div>
      )}
      {onSubmitComments && comments.size > 0 && !draftAnchor && (
        <div className="sticky bottom-0 z-10 border-t border-border bg-background px-6 py-3">
          <div className="mx-auto flex max-w-[850px] items-center justify-between gap-3">
            <span className="flex items-center gap-2 text-xs text-foreground/60">
              <MessageSquarePlus className="h-3.5 w-3.5" />
              {t('diff.commentsSummary', {
                comments: t('diff.commentCount', { count: comments.size }),
                files: t('diff.commentFileCount', { count: new Set([...comments.values()].map(c => c.filePath)).size }),
              })}
            </span>
            <button
              type="button"
              className="rounded-[6px] bg-foreground px-3 py-1 text-xs text-background"
              onClick={submitComments}
            >
              {t('diff.sendComments')}
            </button>
          </div>
        </div>
      )}
    </PreviewOverlay>
  )
}
