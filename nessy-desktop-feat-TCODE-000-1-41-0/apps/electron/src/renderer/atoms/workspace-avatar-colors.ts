/**
 * Source: v0.15.1:apps/electron/src/renderer/atoms/workspace-avatar-colors.ts (UB15.9; in upstream since v0.11.0,
 * taken with its one setter, the Settings → Appearance avatar ColorPicker, as UB7.2's divergence note asked).
 * Rebrand: the storage key `craft-workspace-avatar-colors` → `nessy-workspace-avatar-colors`.
 * Ours: `workspaceAvatarColorOf`, the defensive read (the UA2.3 `readColumnMap` precedent in `atoms/kanban.ts`).
 */
/**
 * Per-workspace avatar color overrides.
 *
 * Stored in localStorage so the user's choice survives reloads. When unset,
 * `WorkspaceAvatar` falls back to a deterministic hue derived from the
 * workspace id (see `components/ui/workspace-avatar.tsx`).
 */

import { atomWithStorage } from 'jotai/utils'

const STORAGE_KEY = 'nessy-workspace-avatar-colors'

export type WorkspaceAvatarColors = Record<string, string>

export const workspaceAvatarColorsAtom = atomWithStorage<WorkspaceAvatarColors>(
  STORAGE_KEY,
  {}
)

/**
 * One workspace's override, read defensively. `atomWithStorage` hands back whatever JSON the key holds, and
 * `WorkspaceAvatar` renders in every window's switcher, so a hand-edited `null`, array or number must read as
 * "no override" (the deterministic hue) rather than throw, and only a non-empty string is a colour.
 */
export function workspaceAvatarColorOf(colors: unknown, workspaceId: string): string | undefined {
  if (!colors || typeof colors !== 'object' || Array.isArray(colors)) return undefined
  const value = (colors as Record<string, unknown>)[workspaceId]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}
