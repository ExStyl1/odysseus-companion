/**
 * Source: v0.15.1:apps/electron/src/renderer/components/ui/scroll-area.tsx (UB13.11) + our
 * viewportClassName Keep (the height-cap seam; upstream has no viewport prop).
 */
import * as React from "react"
import * as ScrollAreaPrimitive from "@radix-ui/react-scroll-area"
import { cn } from "@/lib/utils"

interface ScrollAreaProps extends React.ComponentProps<typeof ScrollAreaPrimitive.Root> {
  /** Ref to the scrollable viewport element */
  viewportRef?: React.RefObject<HTMLDivElement>
  /**
   * Classes for the scrollable VIEWPORT — this is where a height cap belongs. (UB13.11 Keep.)
   *
   * A cap on the Root does not work and does not look broken: the Root is
   * `overflow-hidden` with `height: auto`, so the Viewport's `h-full`
   * (`height: 100%`) has no definite parent height to resolve against and
   * falls back to content height. The Root then simply CLIPS the overflow —
   * no wheel scrolling, no scrollbar, and the rest of the list unreachable.
   * Put `max-h-*` here instead and the Viewport scrolls.
   */
  viewportClassName?: string
}

function ScrollArea({
  className,
  children,
  viewportRef,
  viewportClassName,
  ...props
}: ScrollAreaProps) {
  return (
    <ScrollAreaPrimitive.Root
      data-slot="scroll-area"
      className={cn("relative overflow-hidden", className)}
      {...props}
    >
      <ScrollAreaPrimitive.Viewport
        ref={viewportRef}
        className={cn("h-full w-full rounded-[inherit]", viewportClassName)}
      >
        {children}
      </ScrollAreaPrimitive.Viewport>
      <ScrollBar />
      <ScrollAreaPrimitive.Corner />
    </ScrollAreaPrimitive.Root>
  )
}

function ScrollBar({
  className,
  orientation = "vertical",
  ...props
}: React.ComponentProps<typeof ScrollAreaPrimitive.ScrollAreaScrollbar>) {
  return (
    <ScrollAreaPrimitive.ScrollAreaScrollbar
      data-slot="scroll-bar"
      orientation={orientation}
      className={cn(
        // z-scrollbar: sticky content in the viewport (list group headers) must not paint over the thumb
        "z-scrollbar flex touch-none select-none",
        orientation === "vertical" &&
          "h-full w-2 border-l border-l-transparent p-[1px]",
        orientation === "horizontal" &&
          "h-2.5 flex-col border-t border-t-transparent p-[1px]",
        className
      )}
      {...props}
    >
      <ScrollAreaPrimitive.ScrollAreaThumb className="relative flex-1 rounded-full bg-[var(--border-strong)] hover:bg-[var(--border-control)]" />
    </ScrollAreaPrimitive.ScrollAreaScrollbar>
  )
}

export { ScrollArea, ScrollBar }
