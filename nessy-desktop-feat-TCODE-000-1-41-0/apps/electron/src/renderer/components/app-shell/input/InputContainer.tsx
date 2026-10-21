/**
 * Source: v0.15.1:apps/electron/src/renderer/components/app-shell/input/InputContainer.tsx (UB14.27; the
 * card look is v0.15.0's, Apache-2.0). Per-hunk merge: upstream's ONE raised card (`rounded-xl bg-raised`,
 * `shadow-elev-1` / `shadow-elev-0` in an unfocused panel, the `focus-within` tint ring), the decision ring
 * (`decisionRingClass(getDecisionTone(...))`) on structured prompts, the `peer/composer` wrapper, the motion
 * tokens (`DURATION.base` / `EASE.standard`) and the reduced-motion height jump replace our Codex-parity
 * glass box (the squircle surface class, `bg-background/95 backdrop-blur-lg`). Re-applied (ours): the
 * `workflow_launch` fallback height; the `structured-height` clamp (we never took upstream's
 * `composer-height` / `useInputAvailableHeight` — UB5.4 stays a measurement), so freeform keeps no max
 * height; the P6.208 permission-mode forwarding; the "leaving structured layer gets no exit animation"
 * rule; the UA1.15 chip note.
 */
import * as React from 'react'
import { motion, AnimatePresence, useMotionValue, useMotionValueEvent, animate } from 'motion/react'
import { DURATION, EASE, prefersReducedMotion } from '@nessy-agent/ui/motion'
import { cn } from '@/lib/utils'
import { FreeFormInput, type FreeFormInputProps } from './FreeFormInput'
import { StructuredInput } from './StructuredInput'
import type { RichTextInputHandle } from '@/components/ui/rich-text-input'
import { useOptionalAppShellContext } from '@/context/AppShellContext'
import type { StructuredInputState, StructuredResponse, InputMode } from './structured/types'
import { getStructuredInputMaxHeight } from './structured-height'
import { BackgroundFinishedChip } from '../BackgroundFinishedChip'
import { decisionRingClass } from './structured/DecisionCard'
import { getDecisionTone } from './structured/decision-tone'

interface InputContainerProps extends Omit<FreeFormInputProps, 'inputRef'> {
  /** Structured input state - when present, shows structured UI instead of freeform */
  structuredInput?: StructuredInputState
  /** Callback when user responds to structured input */
  onStructuredResponse?: (response: StructuredResponse) => void
  /** External ref for the input (for focus control) */
  textareaRef?: React.RefObject<RichTextInputHandle>
  /** Per-frame callback during height animation (for scroll sync) */
  onAnimatedHeightChange?: (delta: number) => void
}

// Animation timing - synced across height and opacity (motion tokens: component swap, on-screen move)
const TRANSITION_DURATION = DURATION.base
const TRANSITION_EASE = EASE.standard

// Fallback heights (used on first render before measurement)
const FALLBACK_HEIGHTS: Record<InputMode | string, number> = {
  freeform: 114,
  'freeform-compact': 70,  // Smaller for compact mode
  permission: 200,
  credential: 240,  // Taller for form fields + hint
  admin_approval: 220,
  workflow_launch: 200,
}

/**
 * InputContainer - Main orchestrator for FreeFormInput and StructuredInput
 *
 * Animation approach:
 * - Uses a hidden measuring div to get the natural height of content
 * - Container animates to measured height
 * - Content crossfades inside using AnimatePresence mode="sync"
 * - All visible children use absolute positioning to stack during transition
 */
export function InputContainer({
  structuredInput,
  onStructuredResponse,
  textareaRef,
  compactMode,
  isProcessing,
  onAnimatedHeightChange,
  ...freeFormProps
}: InputContainerProps) {
  const appShellContext = useOptionalAppShellContext()
  const isFocusedPanel = appShellContext?.isFocusedPanel ?? true
  const mode: InputMode = structuredInput ? 'structured' : 'freeform'
  const measureRef = React.useRef<HTMLDivElement>(null)
  // Separate height states: freeform uses callback, structured uses measuring div
  // Use smaller fallback height for compact mode
  const [freeformHeight, setFreeformHeight] = React.useState<number>(
    compactMode ? FALLBACK_HEIGHTS['freeform-compact'] : FALLBACK_HEIGHTS.freeform
  )
  const [structuredHeight, setStructuredHeight] = React.useState<number | null>(null)
  const [viewportHeight, setViewportHeight] = React.useState<number>(() =>
    typeof window === 'undefined' ? 0 : window.innerHeight
  )
  const [isFocused, setIsFocused] = React.useState(false)
  const hasInitializedRef = React.useRef(false)

  // Create a stable key for the current content
  const contentKey = mode === 'freeform' ? 'freeform' : `structured-${structuredInput?.type}`

  // Track mode transitions - animate height for a short period after mode change
  const [isAnimating, setIsAnimating] = React.useState(false)
  const prevContentKeyRef = React.useRef(contentKey)

  // Detect transition synchronously during render
  const isTransitioning = prevContentKeyRef.current !== contentKey

  // Should animate if we're in a transition OR still in the animation window
  const shouldAnimateHeight = isTransitioning || isAnimating

  React.useEffect(() => {
    if (isTransitioning) {
      prevContentKeyRef.current = contentKey
      setIsAnimating(true)
      // Keep animating for the transition duration + a bit extra for measurement settle
      const timer = setTimeout(() => {
        setIsAnimating(false)
      }, TRANSITION_DURATION * 1000 + 100)
      return () => clearTimeout(timer)
    }
  }, [contentKey, isTransitioning])

  // Compact-mode collapse-during-thinking is escapable: the user can hover or
  // click the collapsed bar to bring the input back without waiting for the
  // agent to finish. State resets the moment processing ends so the next
  // thinking cycle starts collapsed again.
  const [expandedDuringProcessing, setExpandedDuringProcessing] = React.useState(false)

  React.useEffect(() => {
    if (!isProcessing && expandedDuringProcessing) {
      setExpandedDuringProcessing(false)
    }
  }, [isProcessing, expandedDuringProcessing])

  const handleRequestExpand = React.useCallback(() => {
    setExpandedDuringProcessing(true)
  }, [])

  const isCollapsedInCompact = compactMode && isProcessing && !expandedDuringProcessing

  // Animate height when either isProcessing flips OR the user manually expands
  // / re-collapses the input during a thinking cycle.
  const prevIsProcessingRef = React.useRef(isProcessing)
  const prevExpandedRef = React.useRef(expandedDuringProcessing)
  React.useEffect(() => {
    if (!compactMode) return
    const isProcessingChanged = prevIsProcessingRef.current !== isProcessing
    const expandedChanged = prevExpandedRef.current !== expandedDuringProcessing
    prevIsProcessingRef.current = isProcessing
    prevExpandedRef.current = expandedDuringProcessing
    if (!isProcessingChanged && !expandedChanged) return
    setIsAnimating(true)
    const timer = setTimeout(() => {
      setIsAnimating(false)
    }, TRANSITION_DURATION * 1000 + 100)
    return () => clearTimeout(timer)
  }, [compactMode, isProcessing, expandedDuringProcessing])

  // Handle height changes from FreeFormInput (synchronous, no measuring div needed)
  const handleFreeformHeightChange = React.useCallback((height: number) => {
    setFreeformHeight(height)
    if (!hasInitializedRef.current) {
      hasInitializedRef.current = true
    }
  }, [])

  // Handle focus changes from FreeFormInput
  const handleFocusChange = React.useCallback((focused: boolean) => {
    setIsFocused(focused)
  }, [])

  React.useEffect(() => {
    if (typeof window === 'undefined') return

    const updateViewportHeight = () => setViewportHeight(window.innerHeight)
    updateViewportHeight()
    window.addEventListener('resize', updateViewportHeight)
    return () => window.removeEventListener('resize', updateViewportHeight)
  }, [])

  // Use ResizeObserver only for structured inputs (freeform uses onHeightChange callback)
  React.useEffect(() => {
    // Skip for freeform - it uses the onHeightChange callback
    if (mode === 'freeform') return

    const measureEl = measureRef.current
    if (!measureEl) return

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const height = entry.contentRect.height
        if (height > 0) {
          setStructuredHeight(height)
          // Mark as initialized after first measurement
          if (!hasInitializedRef.current) {
            requestAnimationFrame(() => {
              hasInitializedRef.current = true
            })
          }
        }
      }
    })

    observer.observe(measureEl)
    return () => observer.disconnect()
  }, [contentKey, mode])

  // Use appropriate height source based on mode. Structured prompts are clamped
  // to viewport-aware bounds; their internals scroll so action buttons stay reachable.
  const rawTargetHeight = mode === 'freeform'
    ? freeformHeight
    : (structuredHeight ?? FALLBACK_HEIGHTS[structuredInput?.type ?? 'freeform'] ?? FALLBACK_HEIGHTS.freeform)
  const structuredMaxHeight = getStructuredInputMaxHeight(viewportHeight)
  const targetHeight = mode === 'freeform'
    ? rawTargetHeight
    : Math.min(rawTargetHeight, structuredMaxHeight)

  // Motion value for frame-synchronized height animation
  const heightMotionValue = useMotionValue(targetHeight)
  const prevAnimatedHeightRef = React.useRef(targetHeight)

  // Emit delta on every animation frame for scroll sync
  useMotionValueEvent(heightMotionValue, "change", (latest) => {
    const delta = latest - prevAnimatedHeightRef.current
    prevAnimatedHeightRef.current = latest
    if (delta !== 0) {
      onAnimatedHeightChange?.(delta)
    }
  })

  // Animate height changes using motion value
  React.useEffect(() => {
    if (shouldAnimateHeight) {
      const animation = animate(heightMotionValue, targetHeight, {
        // Reduced motion: the size change lands at once (the content crossfade still plays)
        duration: prefersReducedMotion() ? 0 : TRANSITION_DURATION,
        ease: TRANSITION_EASE
      })
      // A keyboard resize can replace a transition before its animation settles.
      return () => animation.stop()
    } else {
      // Instant update - no animation
      heightMotionValue.set(targetHeight)
      prevAnimatedHeightRef.current = targetHeight
    }
  }, [targetHeight, shouldAnimateHeight, heightMotionValue])

  const handleStructuredResponse = (response: StructuredResponse) => {
    onStructuredResponse?.(response)
  }

  // Render the current content (measuring div only for structured, freeform uses callback)
  const renderContent = (forMeasuring: boolean) => {
    if (mode === 'freeform') {
      return (
        <FreeFormInput
          {...freeFormProps}
          compactMode={compactMode}
          isProcessing={isProcessing}
          isCollapsedInCompact={isCollapsedInCompact}
          onRequestExpand={handleRequestExpand}
          inputRef={forMeasuring ? undefined : textareaRef}
          onHeightChange={forMeasuring ? undefined : handleFreeformHeightChange}
          onFocusChange={forMeasuring ? undefined : handleFocusChange}
          unstyled
        />
      )
    }
    return (
      <StructuredInput
        state={structuredInput!}
        onResponse={forMeasuring ? () => {} : handleStructuredResponse}
        unstyled
        // P6.208 (A40) — the permission card's documented **Yes, and switch to
        // auto mode** answer needs the session's live mode and the composer's
        // own setter. Both already arrive here inside `freeFormProps` (the
        // props type extends `FreeFormInputProps`), so they are READ rather
        // than destructured: pulling them out of the rest would silently stop
        // forwarding them to the freeform composer's mode picker.
        //
        // The measuring copy gets no setter, for the same reason it gets no
        // response handler: it is an invisible render used only for height, and
        // a click cannot reach it.
        permissionMode={freeFormProps.permissionMode}
        onPermissionModeChange={forMeasuring ? undefined : freeFormProps.onPermissionModeChange}
      />
    )
  }

  // Decision prompts draw their status ring on the composer card (info, or destructive for risky calls)
  const decisionTone = mode === 'freeform' ? null : getDecisionTone(structuredInput)

  return (
    // `peer/composer` lets the hint line under the card react to focus inside it (ChatInputZone)
    <div className="peer/composer relative">
      {/* Hidden measuring div - only needed for structured inputs (freeform uses onHeightChange) */}
      {mode !== 'freeform' && (
        <div
          ref={measureRef}
          className="absolute top-0 left-0 right-0 invisible pointer-events-none"
          aria-hidden="true"
        >
          <div className="overflow-hidden rounded-xl">
            {renderContent(true)}
          </div>
        </div>
      )}

      {/* Visible animated container — ONE raised card (spec §7.5): radius 16, a quiet elev-1 lift
          (hairline only in an unfocused panel; the large elev-2 blur read as a cheap drop shadow),
          focus shown instantly as a tint ring; decision prompts swap in their status ring. */}
      <motion.div
        className={cn(
          "input-container relative overflow-hidden rounded-xl bg-raised",
          isFocusedPanel ? "shadow-elev-1" : "shadow-elev-0",
          decisionTone
            ? decisionRingClass(decisionTone)
            : "focus-within:ring-1 focus-within:ring-focus/55",
        )}
        style={{
          height: heightMotionValue,
          ...(mode !== 'freeform' ? { maxHeight: structuredMaxHeight } : {}),
        }}
      >
        {/* Crossfading content - freeform anchored to bottom (for auto-grow), others fill */}
        <AnimatePresence mode="sync" initial={false}>
          <motion.div
            key={contentKey}
            className={mode === 'freeform' ? "absolute bottom-0 left-0 right-0" : "absolute inset-0"}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            // A LEAVING STRUCTURED LAYER GETS NO EXIT ANIMATION, and that is a
            // correctness rule rather than a taste in motion design.
            //
            // `AnimatePresence` keeps an exiting child mounted until its exit
            // animation reports completion, and that report comes from the frame
            // loop. When the frame loop is not running the child never leaves:
            // measured live 2026-07-30 with `document.hidden === true` and ZERO
            // `requestAnimationFrame` callbacks in 2.1s, an ANSWERED permission
            // card sat at `opacity: 1` over a composer stuck at `opacity: 0`,
            // while `pendingPermissions` was already empty and this component had
            // already re-rendered in freeform mode. The React state was right; the
            // pixels outlived it.
            //
            // That is precisely the failure `App.tsx handleRespondToPermission`
            // exists to prevent — its comment names "left on screen forever" — and
            // a card asking to approve a command that already ran is worse than
            // cosmetic: the next real prompt is indistinguishable from it.
            //
            // The exiting child keeps the props it was rendered with, so this
            // reads the mode of the layer that is LEAVING: a structured layer
            // leaves in the same commit as the state that removed it (no exit
            // animation, nothing to wait for), and the freeform layer keeps its
            // crossfade for the ordinary freeform -> prompt direction. Not a
            // timer: nothing here waits, and the removal cannot disagree with the
            // state in either direction.
            {...(mode === 'freeform' ? { exit: { opacity: 0 } } : {})}
            transition={{ duration: TRANSITION_DURATION, ease: TRANSITION_EASE }}
          >
            {renderContent(false)}
          </motion.div>
        </AnimatePresence>
      </motion.div>

      {/* UA1.15 (v0.13.4; moved by v0.15.0) — background-completion chip, floating just
       * ABOVE the input box, right-aligned, so it never covers the draft. Self-contained
       * (its own atoms + navigation); renders nothing when idle or when the Appearance
       * preference is off (the default). Freeform-only. The outer wrapper is `relative`
       * and (unlike the visible box) not `overflow-hidden`, so the chip isn't clipped.
       * The composer itself is unchanged. */}
      {mode === 'freeform' && freeFormProps.sessionId && (
        <BackgroundFinishedChip sessionId={freeFormProps.sessionId} />
      )}
    </div>
  )
}
