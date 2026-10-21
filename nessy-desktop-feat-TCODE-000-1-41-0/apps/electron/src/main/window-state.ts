import { writeFileSync, existsSync, mkdirSync } from 'fs'
import { readJsonFileSync } from '@nessy-agent/shared/utils/files'
import { CONFIG_DIR } from '@nessy-agent/shared/config/paths'
import { mainLog } from './logger'
import { join } from 'path'

export interface WindowBounds {
  x: number
  y: number
  width: number
  height: number
}

export interface SavedWindow {
  type: 'main'
  workspaceId: string
  bounds: WindowBounds
  focused?: boolean
  // Full URL captured from webContents.getURL() at quit time.
  // May be localhost (dev) or file:// (prod) — both are safe to store because
  // createWindow() never loads this URL directly. It extracts query params
  // (workspaceId, route, focused, etc.) and rebuilds the URL from __dirname
  // (prod) or the current dev server (dev). See window-manager.ts restoreUrl.
  url?: string
}

export interface WindowState {
  windows: SavedWindow[]
  lastFocusedWorkspaceId?: string
}

const WINDOW_STATE_FILE = join(CONFIG_DIR, 'window-state.json')

/**
 * Save the current window state (windows with bounds and type)
 */
export function saveWindowState(state: WindowState): void {
  try {
    // Ensure config directory exists
    if (!existsSync(CONFIG_DIR)) {
      mkdirSync(CONFIG_DIR, { recursive: true })
    }

    writeFileSync(WINDOW_STATE_FILE, JSON.stringify(state, null, 2), 'utf-8')
    mainLog.info('[WindowState] Saved window state:', state.windows.length, 'windows')
  } catch (error) {
    mainLog.error('[WindowState] Failed to save window state:', error)
  }
}

/**
 * Load the saved window state
 */
export function loadWindowState(): WindowState | null {
  try {
    if (!existsSync(WINDOW_STATE_FILE)) {
      return null
    }

    const raw = readJsonFileSync(WINDOW_STATE_FILE)

    // Validate format
    const state = raw as WindowState
    if (!Array.isArray(state.windows)) {
      mainLog.warn('[WindowState] Invalid window state file, ignoring')
      return null
    }

    mainLog.info('[WindowState] Loaded window state:', state.windows.length, 'windows')
    return state
  } catch (error) {
    mainLog.error('[WindowState] Failed to load window state:', error)
    return null
  }
}

/**
 * Clear the saved window state
 */
export function clearWindowState(): void {
  try {
    if (existsSync(WINDOW_STATE_FILE)) {
      writeFileSync(WINDOW_STATE_FILE, JSON.stringify({ windows: [] }, null, 2), 'utf-8')
      mainLog.info('[WindowState] Cleared window state')
    }
  } catch (error) {
    mainLog.error('[WindowState] Failed to clear window state:', error)
  }
}

/**
 * Rebuild a saved window URL for a DEV restore: the dev-server origin plus the
 * saved QUERY, and nothing else — the exact mirror of the prod branch, which
 * extracts query params and loads from the current `__dirname`. The saved
 * pathname is deliberately dropped: after a packaged run it points into the
 * packaged bundle, Vite answers 200 for that path with a page that has no
 * `window.electronAPI`, and `did-fail-load` never fires (plan 2026-08-20, T27).
 * Returns null when the saved URL does not parse — the caller falls back to
 * its default-query load.
 */
export function rebuildDevRestoreUrl(restoreUrl: string, devServerUrl: string): string | null {
  try {
    const savedUrl = new URL(restoreUrl)
    const devUrl = new URL(devServerUrl)
    devUrl.search = savedUrl.search
    return devUrl.toString()
  } catch {
    return null
  }
}
