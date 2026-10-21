/**
 * Source: v0.15.1:apps/electron/src/renderer/components/ui/collapsible.tsx (UB13.11); the
 * AnimatedCollapsibleContent re-export goes through its SUBPATH (barrel trap), and the
 * springTransition re-export is ours until UB14.4.
 */
import * as CollapsiblePrimitive from "@radix-ui/react-collapsible"

// Radix primitives
const Collapsible = CollapsiblePrimitive.Root
const CollapsibleTrigger = CollapsiblePrimitive.CollapsibleTrigger
const CollapsibleContent = CollapsiblePrimitive.CollapsibleContent

// Expand-in-place content (fade + 4px drop, no height animation) — shared with @nessy-agent/ui/ui/AnimatedCollapsibleContent
export { AnimatedCollapsibleContent } from "@nessy-agent/ui/ui/AnimatedCollapsibleContent"

/**
 * One-line re-export kept for AppShell's `springTransition as collapsibleSpring` import, which
 * upstream's AppShell no longer makes (ours drops it in UB14.4). Values are the pre-redesign
 * ones, unchanged. (UB13.11, recorded deviation.)
 */
const springTransition = {
  type: "spring" as const,
  stiffness: 1400,
  damping: 75,
}

export { Collapsible, CollapsibleTrigger, CollapsibleContent, springTransition }
