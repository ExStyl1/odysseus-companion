/**
 * UB7.2 — ported from craft-agents-oss `v0.15.1:apps/electron/src/renderer/components/ui/workspace-avatar.tsx`
 * (Apache-2.0, v0.15.1 redesign). UB7.2 left the per-workspace colour OVERRIDE out until its only setter
 * existed; UB15.9 brings that setter (the Settings → Appearance avatar ColorPicker) and re-adds the atom read
 * and the `override ||` in `bgStyle`, so the file is upstream's again. The atom's storage key is
 * `nessy-workspace-avatar-colors`, and the override is read through `workspaceAvatarColorOf` (a hand-edited
 * non-object value reads as no override instead of throwing in every window's switcher).
 *
 * Otherwise verbatim: a deterministic hue from the workspace ID (so the same
 * workspace always gets the same colour across sessions and surfaces), the
 * lightest AA-compliant lightness for it (`workspace-avatar-color.ts`), and
 * the workspace name's initial as the fallback letter.
 */

import * as React from 'react'
import { useAtomValue } from 'jotai'
import { CrossfadeAvatar } from './avatar'
import { cn } from '@/lib/utils'
import { workspaceAvatarColorOf, workspaceAvatarColorsAtom } from '@/atoms/workspace-avatar-colors'
import { workspaceAvatarBackground } from './workspace-avatar-color'

function hashString(str: string): number {
  let hash = 5381
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash) + str.charCodeAt(i)
  }
  return Math.abs(hash)
}

function getWorkspaceHue(id: string): number {
  return hashString(id) % 360
}

interface WorkspaceAvatarProps {
  /** Workspace id. If omitted, the fallback uses a neutral muted background. */
  workspaceId?: string
  workspaceName?: string
  src?: string | null
  className?: string
  /** Override font size for the initial letter (default `text-[10px]`). */
  fallbackClassName?: string
}

export function WorkspaceAvatar({
  workspaceId,
  workspaceName,
  src,
  className,
  fallbackClassName,
}: WorkspaceAvatarProps) {
  const colorOverrides = useAtomValue(workspaceAvatarColorsAtom)
  const initial = (workspaceName?.trim().charAt(0) || 'W').toUpperCase()
  const hasId = !!workspaceId
  const override = hasId ? workspaceAvatarColorOf(colorOverrides, workspaceId!) : undefined
  const bgStyle = hasId
    ? {
        backgroundColor:
          override || workspaceAvatarBackground(getWorkspaceHue(workspaceId!)),
      }
    : undefined

  return (
    <CrossfadeAvatar
      src={src ?? undefined}
      alt={workspaceName}
      className={className}
      fallbackClassName={cn('text-[10px]', !hasId && 'bg-muted', fallbackClassName)}
      fallback={
        hasId ? (
          <div
            className="flex h-full w-full items-center justify-center font-medium text-white"
            style={bgStyle}
          >
            {initial}
          </div>
        ) : (
          initial
        )
      }
    />
  )
}
