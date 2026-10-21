/**
 * useLabels Hook
 *
 * React hook to load and manage workspace labels.
 * Returns the label tree (nested structure with children) from config.
 * Also exposes a flattened version for components that need flat lookups.
 * Auto-refreshes when workspace changes or label config changes.
 */

import { useState, useEffect, useCallback, useMemo } from 'react'
import type { LabelConfig } from '@nessy-agent/shared/labels'
import { flattenLabels } from '@nessy-agent/shared/labels'

export interface UseLabelsResult {
  /** Label tree (root-level nodes with nested children) */
  labels: LabelConfig[]
  /** Flattened label list for lookups and non-hierarchical display */
  flatLabels: LabelConfig[]
  /** True while ANY load runs — the first one and every refresh (LABELS_CHANGED) alike. */
  isLoading: boolean
  /**
   * True once `labels` holds a successful load for THIS workspaceId. A refresh does not reset it
   * (the last good list stays in `labels` meanwhile); a workspace switch does, until the new
   * workspace's list arrives. Use it — not `!isLoading` — to tell "not loaded yet" from "absent".
   */
  isLoaded: boolean
  error: string | null
  refresh: () => Promise<void>
}

/**
 * Load labels for a workspace via IPC.
 * Returns the tree structure (labels with nested children).
 * Auto-refreshes when workspaceId changes.
 * Subscribes to live label config changes via LABELS_CHANGED event.
 */
export function useLabels(workspaceId: string | null): UseLabelsResult {
  const [labels, setLabels] = useState<LabelConfig[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  // The workspace whose list `labels` last loaded successfully (see UseLabelsResult.isLoaded).
  const [loadedWorkspaceId, setLoadedWorkspaceId] = useState<string | null>(null)

  // Memoized flat version of the tree for lookups
  const flatLabels = useMemo(() => flattenLabels(labels), [labels])

  const refresh = useCallback(async () => {
    if (!workspaceId) {
      setLabels([])
      setLoadedWorkspaceId(null)
      setIsLoading(false)
      return
    }

    try {
      setIsLoading(true)
      const configs = await window.electronAPI.listLabels(workspaceId)
      setLabels(configs)
      setLoadedWorkspaceId(workspaceId)
      setError(null)
    } catch (err) {
      console.error('[useLabels] Failed to load labels:', err)
      setError(err instanceof Error ? err.message : 'Failed to load labels')
    } finally {
      setIsLoading(false)
    }
  }, [workspaceId])

  // Load labels when workspace changes
  useEffect(() => {
    refresh()
  }, [refresh])

  // Subscribe to live label changes (config file changes)
  useEffect(() => {
    if (!workspaceId) return

    const cleanup = window.electronAPI.onLabelsChanged((changedWorkspaceId) => {
      // Only refresh if this is our workspace
      if (changedWorkspaceId === workspaceId) {
        refresh()
      }
    })

    return cleanup
  }, [workspaceId, refresh])

  return {
    labels,
    flatLabels,
    isLoading,
    isLoaded: isLabelsLoadedFor(loadedWorkspaceId, workspaceId),
    error,
    refresh,
  }
}

/**
 * UA12.164 follow-up (2026-10-08 re-verification of 6da39447a): whether the labels a hook holds
 * are a successful load for `workspaceId`. A refresh keeps it true (refresh() flips isLoading on
 * every LABELS_CHANGED, while the last good list stays); a workspace switch makes it false until
 * the new workspace's list arrives; no workspace is never loaded.
 */
export function isLabelsLoadedFor(loadedWorkspaceId: string | null, workspaceId: string | null): boolean {
  return workspaceId !== null && loadedWorkspaceId === workspaceId
}
