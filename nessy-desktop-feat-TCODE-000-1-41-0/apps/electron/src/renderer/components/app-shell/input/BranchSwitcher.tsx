/**
 * The session's git-branch chip (ours; upstream v0.15.1 has none and shows the branch only in the folder chip's
 * tooltip). UB14.31 moved it from the external footer under the composer card INTO the toolbar's left group, right
 * after the folder chip, on v0.15.1's chip material: `COMPOSER_CHIP` with the label and chevron as
 * `data-badge-label`, so a narrow panel folds it to its icon like the sources and folder chips. Behaviour unchanged:
 * capability-gated by the caller (`externalFooter.gitBranch`), a disabled-and-explained chip when there is no repo,
 * no working directory or a git error, and a checkout that refuses a dirty tree unless the user picks stash-and-switch.
 * The Tooltip comes from the `ui/tooltip` subpath, never the `@nessy-agent/ui` barrel (the barrel's pdfjs chain cannot
 * load in `bun test`; `BranchSwitcher.test.tsx` renders this file).
 */
import * as React from 'react'
import { Check, ChevronDown, GitBranch } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import type { GitBranchesResult } from '@nessy-agent/shared/protocol'
import { Tooltip, TooltipContent, TooltipTrigger } from '@nessy-agent/ui/ui/tooltip'
import { DropdownMenu, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { StyledDropdownMenuContent, StyledDropdownMenuItem } from '@/components/ui/styled-dropdown'
import { cn } from '@/lib/utils'
import { branchUnavailableReasonKey, checkoutResultAction } from './branch-switcher-helpers'
import { COMPOSER_CHIP } from './composer-styles'

interface BranchSwitcherProps {
  sessionId: string
  /**
   * The first paint's listing. The product passes nothing: the chip renders once its own fetch answers. The
   * playground and the render tests seed it, because a static render runs no effect and would draw nothing.
   */
  initialBranches?: GitBranchesResult
}

/** The chip's width cap and shrink (a long branch name ellipsizes inside the toolbar's left group). */
const BRANCH_CHIP = cn(COMPOSER_CHIP, 'max-w-40 shrink')

export function BranchSwitcher({ sessionId, initialBranches }: BranchSwitcherProps) {
  const { t } = useTranslation()
  const [open, setOpen] = React.useState(false)
  const [data, setData] = React.useState<GitBranchesResult | undefined>(initialBranches)
  const [query, setQuery] = React.useState('')

  React.useEffect(() => {
    let alive = true
    setData(undefined)
    window.electronAPI.gitBranches(sessionId)
      .then((result) => {
        if (!alive) return
        setData(result)
      })
      .catch((error) => {
        console.error('[BranchSwitcher] Failed to load branches:', error)
        if (alive) {
          setData({ status: 'error', error: error instanceof Error ? error.message : String(error) })
        }
      })

    return () => {
      alive = false
    }
  }, [sessionId])

  const refreshBranches = React.useCallback(async () => {
    const result = await window.electronAPI.gitBranches(sessionId)
    setData(result)
    return result
  }, [sessionId])

  const isOk = data?.status === 'ok'
  const current = data?.status === 'ok' ? data.current : null
  const branches = React.useMemo(() => (data?.status === 'ok' ? data.branches : []), [data])

  const filtered = React.useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase()
    if (!normalizedQuery) return branches
    return branches.filter((branch) => branch.toLowerCase().includes(normalizedQuery))
  }, [branches, query])

  const handleOpenChange = React.useCallback((nextOpen: boolean) => {
    setOpen(nextOpen)
    if (nextOpen) {
      setQuery('')
      refreshBranches().catch((error) => {
        console.error('[BranchSwitcher] Failed to refresh branches:', error)
        setData({ status: 'error', error: error instanceof Error ? error.message : String(error) })
        setOpen(false)
      })
    }
  }, [refreshBranches])

  const checkout = React.useCallback(async (branch: string, autoStash = false) => {
    const result = await window.electronAPI.gitCheckout(sessionId, branch, autoStash)
    const action = checkoutResultAction(result)
    switch (action.kind) {
      case 'dirty-confirm':
        // Uncommitted changes: refuse by default, offer an explicit stash-and-switch.
        toast.warning(t('chat.branch.dirtyTitle'), {
          description: t('chat.branch.dirtyDescription'),
          action: {
            label: t('chat.branch.stashAndSwitch'),
            onClick: () => void checkout(branch, true),
          },
        })
        break
      case 'error':
        toast.error(t('chat.branch.error', { message: action.message }))
        break
      case 'success-stash-conflict':
        // Branch switched, but the stashed changes are stranded on the stack.
        toast.warning(t('chat.branch.stashPopConflict'))
        setData((prev) => (prev?.status === 'ok' ? { ...prev, current: branch } : prev))
        break
      case 'success':
        setData((prev) => (prev?.status === 'ok' ? { ...prev, current: branch } : prev))
        break
    }
    setOpen(false)
  }, [sessionId, t])

  const unavailableReasonKey = branchUnavailableReasonKey(data)
  const unavailableReason = unavailableReasonKey ? t(unavailableReasonKey) : null

  // While the first fetch is in flight, render nothing to avoid a flicker.
  if (data === undefined) return null

  // No repo / no working directory / git error: show a disabled, explained
  // affordance instead of vanishing so the control never looks like it's missing.
  if (!isOk) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            disabled
            aria-disabled="true"
            aria-label={t('chat.branch.label')}
            // The chip's `disabled:pointer-events-none` would also silence the tooltip that says WHY.
            className={cn(BRANCH_CHIP, 'cursor-default disabled:pointer-events-auto')}
          >
            <GitBranch className="size-4 shrink-0" />
            <span data-badge-label className="min-w-0 truncate">{t('chat.branch.label')}</span>
          </button>
        </TooltipTrigger>
        <TooltipContent side="top" className="max-w-[280px] break-words">
          {unavailableReason}
        </TooltipContent>
      </Tooltip>
    )
  }

  return (
    <DropdownMenu open={open} onOpenChange={handleOpenChange}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={current ?? t('chat.branch.label')}
          className={BRANCH_CHIP}
        >
          <GitBranch className="size-4 shrink-0" />
          <span data-badge-label className="min-w-0 truncate">{current ?? t('chat.branch.label')}</span>
          <ChevronDown data-badge-label className="size-3.5 shrink-0" />
        </button>
      </DropdownMenuTrigger>
      <StyledDropdownMenuContent side="top" align="start" sideOffset={8} className="min-w-[240px]">
        <input
          autoFocus
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t('chat.branch.search')}
          className="mx-1 mb-1 h-control w-[calc(100%-8px)] rounded-md bg-fill-hover px-2 text-label outline-none placeholder:text-tertiary"
          onKeyDown={(event) => event.stopPropagation()}
        />
        <div className="max-h-[200px] overflow-y-auto">
          {filtered.map((branch) => (
            <StyledDropdownMenuItem
              key={branch}
              onClick={() => void checkout(branch)}
              className="flex items-center gap-2"
            >
              <span className="min-w-0 flex-1 truncate text-label">
                {branch === current ? t('chat.branch.current', { branch }) : branch}
              </span>
              {branch === current && <Check className="size-3.5 shrink-0 text-secondary" />}
            </StyledDropdownMenuItem>
          ))}
        </div>
      </StyledDropdownMenuContent>
    </DropdownMenu>
  )
}
