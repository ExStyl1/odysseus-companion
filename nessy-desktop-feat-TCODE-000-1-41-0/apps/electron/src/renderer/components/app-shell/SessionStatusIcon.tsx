/* Copied from v0.15.1:apps/electron/src/renderer/components/app-shell/SessionStatusIcon.tsx (craft-agents-oss, Apache-2.0) by
   UB14.4, 2026-10-16 (the 24px hit area, the hover fill and the `status.change` name). Kept ours: the trigger is a
   SPAN with the button role and its own Enter/Space handling (nested-button fix; upstream still nests a <button>). */
import { useState } from "react"
import { useTranslation } from "react-i18next"
import { cn } from "@/lib/utils"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { SessionStatusMenu } from "@/components/ui/session-status-menu"
import { getStateIcon, getStateIconStyle } from "@/config/session-status-config"
import { useSessionListContext } from "@/context/SessionListContext"
import type { SessionMeta } from "@/atoms/sessions"
import { getSessionStatus } from "@/utils/session"

interface SessionStatusIconProps {
  item: SessionMeta
}

export function SessionStatusIcon({ item }: SessionStatusIconProps) {
  const { t } = useTranslation()
  const ctx = useSessionListContext()
  const [open, setOpen] = useState(false)
  const status = getSessionStatus(item)

  const handleSelect = (state: import("@/config/session-status-config").SessionStatusId) => {
    setOpen(false)
    ctx.onSessionStatusChange(item.id, state)
  }

  return (
    <Popover modal={true} open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        {/*
          A SPAN with the button role, never a <button>. This trigger is rendered
          into EntityRow's `icon` slot, which sits INSIDE the row's own <button>
          (SessionItem → EntityRow, components/ui/entity-row.tsx). A <button>
          inside a <button> is invalid HTML — React logs
          `validateDOMNesting(...): <button> cannot appear as a descendant of
          <button>` on every session row — and some engines drop the inner
          element out of the parent during parsing, which loses the click.
          EntityRow's own "…" menu trigger already takes this exact route
          (`DropdownMenuTrigger asChild` around a <div>); this is the same trade,
          with the role/tabIndex/keyboard handling a <button> gave for free put
          back by hand.
        */}
        <span
          role="button"
          tabIndex={0}
          className={cn(
            // UB14.4 (v0.15.1): 16px glyph (spec §2.4) in a 24px button box (36px in the compact/touch shell),
            // padded around the glyph with a matching negative margin so the row's layout doesn't change
            "relative !size-6 -m-1 p-1 flex items-center justify-center rounded-full cursor-pointer",
            "@max-mobile/shell:!size-9 @max-mobile/shell:-m-2.5 @max-mobile/shell:p-2.5",
            "before:absolute before:inset-0 before:rounded-full before:content-[''] hover:before:bg-fill-hover",
            "[&>svg]:w-full [&>svg]:h-full [&>img]:w-full [&>img]:h-full [&>span]:text-label",
          )}
          style={getStateIconStyle(status, ctx.sessionStatuses)}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label={t("status.change")}
          onContextMenu={(e) => {
            e.preventDefault()
            e.stopPropagation()
          }}
          onKeyDown={(e) => {
            // Enter/Space activate a <button> natively; a span has to say so.
            // Both are stopped from reaching the row button underneath, which
            // would otherwise also handle the key as a row activation.
            if (e.key !== 'Enter' && e.key !== ' ') return
            e.preventDefault()
            e.stopPropagation()
            setOpen(prev => !prev)
          }}
        >
          {getStateIcon(status, ctx.sessionStatuses)}
        </span>
      </PopoverTrigger>
      <PopoverContent
        className="w-auto p-0 border-0 shadow-none bg-transparent"
        align="start"
        side="bottom"
        sideOffset={4}
        onContextMenu={(e) => {
          e.preventDefault()
          e.stopPropagation()
        }}
      >
        <SessionStatusMenu
          activeState={status}
          onSelect={handleSelect}
          states={ctx.sessionStatuses}
          isArchived={item.isArchived}
          onArchive={ctx.onArchive ? () => { setOpen(false); ctx.onArchive!(item.id) } : undefined}
          onUnarchive={ctx.onUnarchive ? () => { setOpen(false); ctx.onUnarchive!(item.id) } : undefined}
        />
      </PopoverContent>
    </Popover>
  )
}
