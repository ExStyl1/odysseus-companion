/**
 * OURS (no v0.15.1 counterpart) — the transcript's right-click menu: save a message (or the selected
 * part of it) to project or user memory, and rewind the conversation to it (C3.384).
 *
 * UB14.14 moved it out of `ChatDisplay.tsx` unchanged, because v0.15.1 moved the message renderer
 * that wraps both bubbles in it into `chat-display/MessageBubble.tsx`, and `ChatDisplay` still wraps
 * each assistant turn in it. One module for both callers keeps one menu.
 */
import * as React from "react"
import { useTranslation } from "react-i18next"
import { BookOpenText, RotateCcw, UserRound } from "lucide-react"
import {
  ContextMenu,
  ContextMenuTrigger,
  StyledContextMenuContent,
  StyledContextMenuItem,
  StyledContextMenuSub,
  StyledContextMenuSubContent,
  StyledContextMenuSubTrigger,
  StyledContextMenuSeparator,
} from "@/components/ui/styled-context-menu"
import type { MemoryAppendScope } from "../../../../shared/types"

export type SaveToMemoryHandler = (scope: MemoryAppendScope, text: string) => Promise<void> | void
export type RewindHandler = (restoreFiles: boolean) => Promise<void> | void

function getSelectedTextWithin(container: HTMLElement | null, fallback: string): string {
  const fallbackText = fallback.trim()
  const selection = window.getSelection()
  const selectedText = selection?.toString().trim()
  if (!selection || selection.isCollapsed || !selectedText || selection.rangeCount === 0) {
    return fallbackText
  }

  const range = selection.getRangeAt(0)
  if (!container?.contains(range.commonAncestorContainer)) {
    return fallbackText
  }

  return selectedText
}

export function MemoryContextMenu({
  content,
  onSaveToMemory,
  onRewind,
  children,
}: {
  content: string
  onSaveToMemory?: SaveToMemoryHandler
  onRewind?: RewindHandler
  children: React.ReactElement
}) {
  const { t } = useTranslation()
  const triggerRef = React.useRef<HTMLDivElement>(null)
  const selectedTextRef = React.useRef('')
  const canSave = Boolean(onSaveToMemory && content.trim())
  const canRewind = Boolean(onRewind)

  const captureText = React.useCallback(() => {
    selectedTextRef.current = getSelectedTextWithin(triggerRef.current, content)
  }, [content])

  const save = React.useCallback((scope: MemoryAppendScope) => {
    if (!onSaveToMemory) return
    const text = selectedTextRef.current || content.trim()
    void onSaveToMemory(scope, text)
  }, [content, onSaveToMemory])

  if (!canSave && !canRewind) return children

  return (
    <ContextMenu modal={false} onOpenChange={(open) => { if (open) captureText() }}>
      <ContextMenuTrigger asChild>
        <div ref={triggerRef} onContextMenu={captureText}>
          {children}
        </div>
      </ContextMenuTrigger>
      <StyledContextMenuContent minWidth="min-w-52">
        {canSave && (
          <StyledContextMenuSub>
            <StyledContextMenuSubTrigger>
              <BookOpenText className="h-3.5 w-3.5" />
              <span>{t('messageMenu.saveToMemory')}</span>
            </StyledContextMenuSubTrigger>
            <StyledContextMenuSubContent>
              <StyledContextMenuItem onSelect={() => save('project')}>
                <BookOpenText className="h-3.5 w-3.5" />
                <span>{t('messageMenu.saveToProjectMemory')}</span>
              </StyledContextMenuItem>
              <StyledContextMenuItem onSelect={() => save('user')}>
                <UserRound className="h-3.5 w-3.5" />
                <span>{t('messageMenu.saveToUserMemory')}</span>
              </StyledContextMenuItem>
            </StyledContextMenuSubContent>
          </StyledContextMenuSub>
        )}
        {canSave && canRewind && <StyledContextMenuSeparator />}
        {canRewind && (
          <>
            <StyledContextMenuItem onSelect={() => onRewind?.(false)}>
              <RotateCcw className="h-3.5 w-3.5" />
              <span>{t('messageMenu.rewindToHere')}</span>
            </StyledContextMenuItem>
            <StyledContextMenuItem onSelect={() => onRewind?.(true)}>
              <RotateCcw className="h-3.5 w-3.5" />
              <span>{t('messageMenu.rewindToHereRestoreFiles')}</span>
            </StyledContextMenuItem>
          </>
        )}
      </StyledContextMenuContent>
    </ContextMenu>
  )
}
