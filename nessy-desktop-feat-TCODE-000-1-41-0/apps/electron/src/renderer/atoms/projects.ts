/* Copied from v0.13.4:apps/electron/src/renderer/atoms/projects.ts (craft-agents-oss, Apache-2.0) by
   UA5.8, 2026-10-02. Adapted: the element type is the wire's `LoadedProjectView` (UA5.3 — the folder
   crosses as `{ handleId, displayPath, trusted, problem? }`, never the stored path), not `LoadedProject`. */
/**
 * Jotai atom for the active workspace's projects (read once on workspace switch,
 * refreshed on `projects:changed` broadcast). Components that need projects in
 * isolation from AppShell read this atom.
 */

import { atom } from 'jotai'
import type { LoadedProjectView } from '@nessy-agent/shared/protocol'

export const projectsAtom = atom<LoadedProjectView[]>([])
