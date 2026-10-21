/**
 * ShikiDiffViewer - Diff viewer using @pierre/diffs (Shiki-based)
 *
 * Platform-agnostic component for displaying file diffs with:
 * - Unified or split diff view
 * - Syntax highlighting via Shiki
 * - Light/dark theme support
 * - Line-level diff highlighting
 */

import * as React from 'react'
import { useState, useEffect, useMemo, useRef, useCallback } from 'react'
import { FileDiff, type FileDiffMetadata, type FileDiffProps } from '@pierre/diffs/react'
import { parseDiffFromFile, DIFFS_TAG_NAME, type FileContents, type DiffLineAnnotation, type SelectedLineRange } from '@pierre/diffs'
import { cn } from '../../lib/utils'
import { LANGUAGE_MAP } from './language-map'
import { diffCommentKey, type DiffCommentSide, type DiffLineComment } from '../../lib/diff-comments'
import { registerNessyShikiThemes } from './registerShikiThemes'

// Register the diffs-container custom element if not already registered
// This is necessary because the React component renders a custom element
if (typeof HTMLElement !== 'undefined' && !customElements.get(DIFFS_TAG_NAME)) {
  class FileDiffContainer extends HTMLElement {
    constructor() {
      super()
      if (this.shadowRoot != null) return
      this.attachShadow({ mode: 'open' })
    }
  }
  customElements.define(DIFFS_TAG_NAME, FileDiffContainer)
}

// Register custom themes once per runtime.
registerNessyShikiThemes()

export interface ShikiDiffViewerProps {
  /** Original (before) content */
  original: string
  /** Modified (after) content */
  modified: string
  /** File path - used for language detection and display */
  filePath?: string
  /** Language for syntax highlighting (auto-detected from filePath if not provided) */
  language?: string
  /** Diff style: 'unified' (stacked) or 'split' (side-by-side) */
  diffStyle?: 'unified' | 'split'
  /** Theme mode */
  theme?: 'light' | 'dark'
  /** Shiki theme name (e.g., 'dracula', 'github-dark'). When provided, uses the matching
   *  Shiki theme natively. Falls back to nessy-dark/nessy-light (transparent bg) if not set. */
  shikiTheme?: string
  /** Disable background highlighting on changed lines */
  disableBackground?: boolean
  /** Whether to hide pierre's native file header (filename + stats). Default: true */
  disableFileHeader?: boolean
  /** Callback when the file header is clicked (e.g. to open the file in an editor).
   *  When provided, the header becomes clickable with cursor: pointer. */
  onFileHeaderClick?: (filePath: string) => void
  /** Callback when ready */
  onReady?: () => void
  /** Additional class names */
  className?: string

  // ==========================================================
  // P6.306 — line-anchored review comments
  // ==========================================================
  /**
   * Comments already attached to this file, rendered inline under their line
   * through pierre's own `lineAnnotations` grid.
   *
   * The THREE props below are byte-identical to `UnifiedDiffViewer`'s, and that
   * is the point of the row: this viewer serves Claude and Pi (original /
   * modified strings) while `UnifiedDiffViewer` serves codex (a pre-computed
   * patch). A comment affordance on only one of them would be a per-runtime
   * capability wearing a host-side hat.
   */
  comments?: readonly DiffLineComment[]
  /** Called when the reader selects a line and asks to comment. Enables pierre's line selection. */
  onCommentAnchor?: (anchor: { lineNumber: number; side: DiffCommentSide; lineText?: string }) => void
  /** Render one existing comment. Supplied by the overlay so the viewer holds no comment UI of its own. */
  renderComment?: (comment: DiffLineComment) => React.ReactNode
}

/**
 * Calculate addition/deletion stats from a FileDiffMetadata
 * Useful for displaying change counts in headers
 */
export function getDiffStats(fileDiff: FileDiffMetadata): { additions: number; deletions: number } {
  let additions = 0
  let deletions = 0
  for (const hunk of fileDiff.hunks) {
    additions += hunk.additionCount
    deletions += hunk.deletionCount
  }
  return { additions, deletions }
}

function getLanguageFromPath(filePath: string, explicit?: string): string {
  if (explicit) return explicit
  const ext = filePath.split('.').pop()?.toLowerCase() || ''
  return LANGUAGE_MAP[ext] || 'text'
}

/**
 * ShikiDiffViewer - Shiki-based diff viewer component
 */
export function ShikiDiffViewer({
  original,
  modified,
  filePath = 'file',
  language,
  diffStyle = 'unified',
  theme = 'light',
  shikiTheme,
  disableBackground = false,
  disableFileHeader = true,
  onFileHeaderClick,
  onReady,
  className,
  comments,
  onCommentAnchor,
  renderComment,
}: ShikiDiffViewerProps) {
  const hasCalledReady = useRef(false)
  const [isReady, setIsReady] = useState(false)

  // Resolve language
  const resolvedLang = useMemo(() => {
    return language || getLanguageFromPath(filePath)
  }, [language, filePath])

  // Create file contents objects for the diff parser
  const oldFile: FileContents = useMemo(() => ({
    name: filePath,
    contents: original,
    lang: resolvedLang as any,
  }), [filePath, original, resolvedLang])

  const newFile: FileContents = useMemo(() => ({
    name: filePath,
    contents: modified,
    lang: resolvedLang as any,
  }), [filePath, modified, resolvedLang])

  // Parse the diff
  const fileDiff: FileDiffMetadata = useMemo(() => {
    return parseDiffFromFile(oldFile, newFile)
  }, [oldFile, newFile])

  // Diff options - use the app's Shiki theme if available, otherwise fall back
  // to nessy-dark/nessy-light which have transparent bg for CSS variable theming
  const resolvedThemeName = shikiTheme || (theme === 'dark' ? 'nessy-dark' : 'nessy-light')
  // When onFileHeaderClick is provided, inject CSS to make the header look clickable
  const unsafeCSS = onFileHeaderClick
    ? '[data-diffs-header] { cursor: pointer; } [data-diffs-header]:hover [data-title] { text-decoration: underline; }'
    : undefined

  // P6.306 — see `UnifiedDiffViewer.handleLineSelected` for why the FIRST line
  // of the range is the anchor and why the selection itself stays pierre's.
  const onCommentAnchorRef = useRef(onCommentAnchor)
  onCommentAnchorRef.current = onCommentAnchor
  const handleLineSelected = useCallback((range: SelectedLineRange | null) => {
    if (!range) return
    const side: DiffCommentSide = range.side === 'deletions' ? 'deletions' : 'additions'
    const lines = side === 'deletions' ? fileDiff.deletionLines : fileDiff.additionLines
    const lineText = lines?.[range.start - 1]
    onCommentAnchorRef.current?.({
      lineNumber: range.start,
      side,
      ...(typeof lineText === 'string' ? { lineText } : {}),
    })
  }, [fileDiff])

  const options: FileDiffProps<DiffLineComment>['options'] = useMemo(() => ({
    theme: resolvedThemeName,
    diffStyle,
    diffIndicators: 'bars',
    disableBackground,
    lineDiffType: 'word',
    overflow: 'scroll',
    disableFileHeader,
    themeType: theme === 'dark' ? 'dark' : 'light',
    unsafeCSS,
    ...(onCommentAnchor
      ? { enableLineSelection: true, onLineSelected: handleLineSelected }
      : {}),
  }), [resolvedThemeName, theme, diffStyle, disableBackground, disableFileHeader, unsafeCSS, onCommentAnchor, handleLineSelected])

  /** The comments, in pierre's annotation shape, one per anchor. */
  const lineAnnotations: DiffLineAnnotation<DiffLineComment>[] | undefined = useMemo(() => {
    if (!comments || comments.length === 0) return undefined
    const byKey = new Map<string, DiffLineComment>()
    for (const comment of comments) byKey.set(diffCommentKey(comment), comment)
    return [...byKey.values()].map(comment => ({
      lineNumber: comment.lineNumber,
      side: comment.side,
      metadata: comment,
    }))
  }, [comments])

  // Call onReady after first render
  useEffect(() => {
    if (!hasCalledReady.current && onReady) {
      hasCalledReady.current = true
      // Give Shiki time to highlight
      const timer = setTimeout(() => {
        setIsReady(true)
        onReady()
      }, 100)
      return () => {
        clearTimeout(timer)
        hasCalledReady.current = false // Reset so re-mounts (including StrictMode) re-arm the timer
      }
    }
  }, [onReady, original, modified, fileDiff])

  // Attach a click listener to the file header inside pierre's shadow DOM.
  // We query for the <diffs-container> custom element, then find [data-diffs-header]
  // inside its shadowRoot. This lets the filename be clickable without modifying pierre.
  const containerRef = useRef<HTMLDivElement>(null)
  const onFileHeaderClickRef = useRef(onFileHeaderClick)
  onFileHeaderClickRef.current = onFileHeaderClick

  useEffect(() => {
    if (!onFileHeaderClick || disableFileHeader) return

    // Wait briefly for pierre to render the header into the shadow DOM
    const timer = setTimeout(() => {
      const diffsContainer = containerRef.current?.querySelector(DIFFS_TAG_NAME)
      const header = diffsContainer?.shadowRoot?.querySelector('[data-diffs-header]')
      if (!header) return

      const handleClick = () => {
        onFileHeaderClickRef.current?.(filePath)
      }
      header.addEventListener('click', handleClick)
      // Store cleanup ref so we can remove listener
      ;(header as any).__nessyClickCleanup = () => header.removeEventListener('click', handleClick)
    }, 150)

    return () => {
      clearTimeout(timer)
      const diffsContainer = containerRef.current?.querySelector(DIFFS_TAG_NAME)
      const header = diffsContainer?.shadowRoot?.querySelector('[data-diffs-header]')
      if (header) {
        ;(header as any).__nessyClickCleanup?.()
      }
    }
  }, [filePath, disableFileHeader, onFileHeaderClick])

  // Use CSS variable so custom themes are respected
  const backgroundColor = 'var(--background)'

  return (
    <div
      ref={containerRef}
      className={cn(
        'h-full w-full overflow-auto transition-opacity duration-200',
        className
      )}
      style={{
        backgroundColor,
        fontFamily: '"JetBrains Mono", monospace',
        fontSize: 13,
        lineHeight: 1.6,
      }}
    >
      <FileDiff<DiffLineComment>
        fileDiff={fileDiff}
        options={options}
        className="min-h-full h-full"
        {...(lineAnnotations ? { lineAnnotations } : {})}
        {...(renderComment
          ? { renderAnnotation: (annotation: DiffLineAnnotation<DiffLineComment>) => renderComment(annotation.metadata) }
          : {})}
      />
    </div>
  )
}
