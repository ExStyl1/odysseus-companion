/**
 * useCapabilityReveal + revealItemProps — the ONE "Show in file manager" for a capability row,
 * shared by the Sources list row (`SourcesListPanel`), the Skills list row and the skill detail
 * page's header "⋯" (the last two through `useSkillActions`). UB12.113.
 *
 * Why one hook: after UB12.80 the Sources list still took its reveal as a prop from `AppShell`
 * (`handleRevealCapability`, passed as `onOpenResource`), whose body was a copy of the skill
 * hook's reveal. Two copies drift — a toast or a gate change in one leaves the other behind.
 * Everything the reveal reads is already in `AppShellContext` (`capabilityContext`,
 * `activeWorkspaceId`), so the hook reads it there and every surface calls the same function.
 *
 * Upstream v0.15.1 has no such hook: `SourcesListPanel.tsx` L144 and `SkillsListPanel.tsx` L87-98
 * each call `window.electronAPI.showInFolder(<path>)` inline. Ours asks the server's capability
 * REVEAL RPC instead (the renderer's safe rows carry no filesystem path), so the call and its
 * failure toast are ours, and they live here once.
 *
 * Outside the app shell (no provider, or a provider with no capability context or no active
 * workspace) the hook answers `null` and `revealItemProps` greys the item with no reason: there is
 * nothing to reveal in. A catalog-only row is greyed WITH the caller's reason (`canRevealCapability`).
 */

import * as React from 'react'
import { toast } from 'sonner'
import { useTranslation } from 'react-i18next'
import { useOptionalAppShellContext } from '@/context/AppShellContext'
import { getFileManagerName } from '@/lib/platform'
import { canRevealCapability } from '@/lib/runtime-resource-rows'
import type { SafeCapabilitySummary } from '@nessy-agent/shared/protocol/capabilities'

/** Shows a capability's resource in the OS file manager (the server's capability REVEAL). */
export type CapabilityReveal = (capabilityKey: string) => Promise<void>

/** The active workspace's capability reveal, or `null` outside the app shell. */
export function useCapabilityReveal(): CapabilityReveal | null {
  const { t } = useTranslation()
  const app = useOptionalAppShellContext()
  const context = app?.capabilityContext
  const workspaceId = app?.activeWorkspaceId ?? null

  return React.useMemo<CapabilityReveal | null>(() => {
    if (!context || !workspaceId) return null
    return async (capabilityKey) => {
      try {
        await window.electronAPI.capabilities.reveal(context, capabilityKey)
      } catch (error) {
        console.error('[Capabilities] Failed to reveal capability:', error)
        toast.error(t('toast.failedToReveal', { fileManager: getFileManagerName() }), {
          description: error instanceof Error ? error.message : String(error),
        })
      }
    }
  }, [context, workspaceId, t])
}

/** The Show-in-file-manager item of a row menu (`SourceMenu`'s two props; `skillMenuProps` maps them). */
export interface RevealItemProps {
  /** Present only when the item is live: inside the app shell, on a revealable row. */
  onShowInFinder?: () => Promise<void>
  /** Why a greyed item is greyed — only for a catalog-only row inside the app shell. */
  showInFinderDisabledReason?: string
}

/**
 * The ONE gate for a row's Show-in-file-manager item: live with a reveal on a revealable row;
 * greyed with `unavailableReason` on a catalog-only row; greyed with no reason outside the app shell.
 */
export function revealItemProps(
  capability: Pick<SafeCapabilitySummary, 'key' | 'state'>,
  reveal: CapabilityReveal | null,
  unavailableReason: string,
): RevealItemProps {
  if (!reveal) return {}
  if (!canRevealCapability(capability)) return { showInFinderDisabledReason: unavailableReason }
  return { onShowInFinder: () => reveal(capability.key) }
}
