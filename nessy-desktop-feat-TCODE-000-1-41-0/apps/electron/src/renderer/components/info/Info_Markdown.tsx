/**
 * Info_Markdown
 *
 * Markdown content with consistent styling and heading detection.
 * Auto-adjusts top padding based on whether content starts with a heading.
 * Supports optional fullscreen view using the shared DocumentFormattedMarkdownOverlay component.
 */

import * as React from 'react'
import { useState } from 'react'
import { Markdown } from '@/components/markdown'
// P6.850. The LEAF, not the barrel — fourteen renderer suites load whichever of the two
// this line names, inside a 5 000 ms hook.
//
// WHAT IS MEASURED is the GRAPH, by a static walk of relative imports: the barrel reaches
// 121 of the package's own modules and 56 external specifiers, this one file reaches 89
// and 53, and the three externals it drops are i18next, `@nessy-agent/core/utils` and
// `@nessy-agent/shared/utils/toolNames`. The row's own subpath candidate does not exist:
// `./markdown` is exported and does NOT carry this overlay, which lives under
// `components/overlay/`, and the `./overlay` BARREL is no narrowing at all (120 of 121).
//
// WHAT IS NOT MEASURED, said here so nobody quotes a number this change did not earn: the
// fourteen-suite batch could NOT separate the two arms on this tree. Eight runs at load
// 7-8, arms restored byte-for-byte and hash-verified between them, gave 180.8 s / 135.8 s
// (134 cases, 2 hook timeouts) and then 1.26 s / 1.24 s (143 cases, 0 failures) on the
// SAME unchanged bytes, with the narrowed arm landing at 4.1 s, 112.4 s, 117.1 s and
// 85.1 s across the same span. Cpu stayed under 3 % of wall throughout. That is the
// timer lottery AGENTS.md records, not a before/after, so the justification here is the
// smaller graph and nothing else.
//
// The pdfjs stub those suites carry STAYS either way and is not a carve-out to remove:
// the overlay renders `../markdown`, whose `Markdown.tsx` imports `MarkdownPdfBlock` at
// module scope, and that file imports react-pdf plus a Vite-only worker specifier bun
// cannot resolve. Narrowing the import narrows the graph; it does not remove pdfjs.
import { DocumentFormattedMarkdownOverlay } from '@nessy-agent/ui/overlay/DocumentFormattedMarkdownOverlay'
import { cn } from '@/lib/utils'
import { Info_FullscreenButton } from './Info_FullscreenButton'

export interface Info_MarkdownProps {
  /** Markdown content */
  children: string
  /** Optional max height with scroll */
  maxHeight?: number
  /** Markdown rendering mode */
  mode?: 'minimal' | 'full'
  className?: string
  /** Enable fullscreen button (shows Maximize2 icon on hover) */
  fullscreen?: boolean
}

export function Info_Markdown({
  children,
  maxHeight,
  mode = 'minimal',
  className,
  fullscreen = false,
}: Info_MarkdownProps) {
  const [isFullscreen, setIsFullscreen] = useState(false)

  // Detect if content starts with H1-H3 heading
  const startsWithHeading = children.trimStart().match(/^#{1,3}\s/)

  return (
    <>
      <div
        className={cn(
          // Same inset as every other card body (Info_Table rows, settings rows): the card pad
          'px-card-pad pb-3 text-label',
          maxHeight && 'overflow-y-auto',
          startsWithHeading ? 'pt-0' : 'pt-1',
          // Add relative + group for fullscreen button positioning
          fullscreen && 'relative group',
          className
        )}
        style={maxHeight ? { maxHeight } : undefined}
      >
        {/* Fullscreen button - visible on hover, positioned top-right */}
        {fullscreen && (
          <Info_FullscreenButton
            onClick={() => setIsFullscreen(true)}
            className="absolute top-2 right-2 z-local"
          />
        )}

        <Markdown mode={mode}>{children}</Markdown>
      </div>

      {/* Fullscreen overlay - reuses shared component from packages/ui */}
      {fullscreen && (
        <DocumentFormattedMarkdownOverlay
          content={children}
          isOpen={isFullscreen}
          onClose={() => setIsFullscreen(false)}
        />
      )}
    </>
  )
}
