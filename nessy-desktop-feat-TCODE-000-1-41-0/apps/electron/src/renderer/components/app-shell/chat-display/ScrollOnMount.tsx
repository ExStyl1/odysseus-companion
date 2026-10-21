/**
 * Source: v0.15.1:apps/electron/src/renderer/components/app-shell/chat-display/ScrollOnMount.tsx
 * (craft-agents-oss, Apache-2.0; ADDED in v0.15.0, identical in v0.15.1). UB14.15 (R2-10): taken 1:1 — ours
 * was the same function inline in ChatDisplay.tsx.
 */
import * as React from "react"

/**
 * Scrolls to target element on mount, before browser paint.
 * Uses useLayoutEffect to ensure scroll happens before content is visible.
 */
export function ScrollOnMount({
  targetRef,
  onScroll,
  skip = false
}: {
  targetRef: React.RefObject<HTMLDivElement | null>
  onScroll?: () => void
  skip?: boolean
}) {
  React.useLayoutEffect(() => {
    if (skip) return
    targetRef.current?.scrollIntoView({ behavior: 'instant' })
    onScroll?.()
  }, [skip])
  return null
}
