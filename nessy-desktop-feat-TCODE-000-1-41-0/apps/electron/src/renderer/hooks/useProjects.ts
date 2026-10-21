/* Copied from v0.13.4:apps/electron/src/renderer/hooks/useProjects.ts (craft-agents-oss, Apache-2.0) by
   UA5.8, 2026-10-02. Adapted: typed with the wire's `LoadedProjectView` (UA5.3), so the `unknown` casts
   upstream needed are gone; nothing else differs. */
/**
 * useProjects
 *
 * Loads workspace-scoped projects and keeps them in sync via the
 * `projects:changed` broadcast. Mirrors the lightweight half of `useAutomations`.
 */

import { useState, useEffect, useCallback } from 'react'
import { useSetAtom } from 'jotai'
import { projectsAtom } from '@/atoms/projects'
import type { LoadedProjectView } from '@nessy-agent/shared/protocol'

export interface UseProjectsResult {
  projects: LoadedProjectView[]
  refresh: () => Promise<void>
}

export function useProjects(activeWorkspaceId: string | null | undefined): UseProjectsResult {
  const [projects, setProjects] = useState<LoadedProjectView[]>([])
  const setProjectsAtom = useSetAtom(projectsAtom)

  const refresh = useCallback(async () => {
    if (!activeWorkspaceId) {
      setProjects([])
      setProjectsAtom([])
      return
    }
    try {
      const result = await window.electronAPI.getProjects(activeWorkspaceId)
      const list = Array.isArray(result) ? result : []
      setProjects(list)
      setProjectsAtom(list)
    } catch (err) {
      console.error('[useProjects] Failed to load projects:', err)
      setProjects([])
      setProjectsAtom([])
    }
  }, [activeWorkspaceId, setProjectsAtom])

  useEffect(() => {
    refresh()
  }, [refresh])

  useEffect(() => {
    if (!activeWorkspaceId) return
    const off = window.electronAPI.onProjectsChanged((wsId: string, list: LoadedProjectView[]) => {
      if (wsId !== activeWorkspaceId) return
      const projects = Array.isArray(list) ? list : []
      setProjects(projects)
      setProjectsAtom(projects)
    })
    return () => {
      if (typeof off === 'function') off()
    }
  }, [activeWorkspaceId, setProjectsAtom])

  return { projects, refresh }
}
