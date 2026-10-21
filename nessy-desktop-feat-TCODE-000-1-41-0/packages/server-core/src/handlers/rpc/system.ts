import { resolve } from 'path'
import { join } from 'path'
import { homedir } from 'os'
import { execSync } from 'child_process'
import { RPC_CHANNELS } from '@nessy-agent/shared/protocol'
import { getGitBashPath, setGitBashPath, clearGitBashPath } from '@nessy-agent/shared/config'
import { classifyExternalUrl, formatBlockedUrlError } from '@nessy-agent/shared/utils/url-safety'
import { isUsableGitBashPath, validateGitBashPath } from '@nessy-agent/server-core/services'
import { validateFilePath, getWorkspaceAllowedDirs, getWorkspaceOrThrow } from '@nessy-agent/server-core/handlers'
import type { RpcServer } from '@nessy-agent/server-core/transport'
import type { HandlerDeps } from '../handler-deps'
import {
  requestClientOpenExternal,
  requestClientOpenPath,
  requestClientShowInFolder,
  requestClientOpenFileDialog,
} from '@nessy-agent/server-core/transport'

export const CORE_HANDLED_CHANNELS = [
  RPC_CHANNELS.theme.GET_SYSTEM_PREFERENCE,
  RPC_CHANNELS.system.VERSIONS,
  RPC_CHANNELS.system.HOME_DIR,
  RPC_CHANNELS.system.IS_DEBUG_MODE,
  RPC_CHANNELS.debug.LOG,
  RPC_CHANNELS.shell.OPEN_URL,
  RPC_CHANNELS.shell.OPEN_FILE,
  RPC_CHANNELS.shell.SHOW_IN_FOLDER,
  RPC_CHANNELS.releaseNotes.GET,
  RPC_CHANNELS.releaseNotes.GET_LATEST_VERSION,
  RPC_CHANNELS.git.GET_BRANCH,
  RPC_CHANNELS.gitbash.CHECK,
  RPC_CHANNELS.gitbash.BROWSE,
  RPC_CHANNELS.gitbash.SET_PATH,
] as const

interface ParsedInternalDeepLink {
  navigation?: {
    view?: string
    action?: string
    actionParams?: Record<string, string>
  }
  workspaceId?: string
  /** Use client shell.openExternal fallback (e.g. window=focused links). */
  requiresExternalOpen?: boolean
  /** True when URL is intentionally consumed without navigation (auth callbacks). */
  handledNoop?: boolean
}

const COMPOUND_ROUTE_PREFIXES = new Set([
  'allSessions',
  'flagged',
  'state',
  'sources',
  'settings',
  'skills',
])

function collectDeepLinkParams(parsed: URL, pathId?: string): Record<string, string> | undefined {
  const params: Record<string, string> = {}
  if (pathId) params.id = pathId

  parsed.searchParams.forEach((value, key) => {
    if (key === 'window' || key === 'sidebar') return
    params[key] = value
  })

  return Object.keys(params).length > 0 ? params : undefined
}

function parseInternalNessyAgentsDeepLink(parsed: URL): ParsedInternalDeepLink | null {
  if (parsed.protocol !== 'nessy:') return null

  const host = parsed.hostname
  const pathParts = parsed.pathname.split('/').filter(Boolean)
  const windowMode = parsed.searchParams.get('window')

  // Preserve window-specific behavior via OS protocol path.
  if (windowMode === 'focused' || windowMode === 'full') {
    return { requiresExternalOpen: true }
  }

  // OAuth callback links are handled by auth flow code paths.
  if (host === 'auth-callback') {
    return { handledNoop: true }
  }

  if (COMPOUND_ROUTE_PREFIXES.has(host)) {
    const viewRoute = pathParts.length > 0 ? `${host}/${pathParts.join('/')}` : host
    return { navigation: { view: viewRoute } }
  }

  if (host === 'action') {
    const action = pathParts[0]
    if (!action) return null

    const actionParams = collectDeepLinkParams(parsed, pathParts[1])
    return {
      navigation: {
        action,
        actionParams,
      },
    }
  }

  if (host === 'workspace') {
    const workspaceId = pathParts[0]
    if (!workspaceId) return null

    const routeType = pathParts[1]
    if (!routeType) return null

    if (COMPOUND_ROUTE_PREFIXES.has(routeType)) {
      return {
        workspaceId,
        navigation: { view: pathParts.slice(1).join('/') },
      }
    }

    if (routeType === 'action') {
      const action = pathParts[2]
      if (!action) return null

      return {
        workspaceId,
        navigation: {
          action,
          actionParams: collectDeepLinkParams(parsed, pathParts[3]),
        },
      }
    }
  }

  return null
}

/** Guard: reject filesystem-path actions on remote workspaces where local paths are meaningless. */
function assertLocalWorkspace(deps: HandlerDeps, ctx: { workspaceId: string | null }, action: string): void {
  if (!ctx.workspaceId) return
  const workspace = getWorkspaceOrThrow(deps.workspaceService, ctx.workspaceId)
  if (workspace.config.remoteServer) {
    throw new Error(`${action} is not available for remote workspaces`)
  }
}

export function registerSystemCoreHandlers(server: RpcServer, deps: HandlerDeps): void {
  const windowManager = deps.windowManager

  // Get system theme preference (dark = true, light = false)
  server.handle(RPC_CHANNELS.theme.GET_SYSTEM_PREFERENCE, async () => {
    return deps.platform.systemDarkMode?.() ?? false
  })

  // Get runtime versions (previously handled locally in preload via process.versions)
  server.handle(RPC_CHANNELS.system.VERSIONS, async () => {
    return {
      node: process.versions.node,
      chrome: process.versions.chrome ?? undefined,
      electron: process.versions.electron ?? undefined,
    }
  })

  // Get user's home directory
  server.handle(RPC_CHANNELS.system.HOME_DIR, async () => {
    return homedir()
  })

  // Check if running in debug mode (from source)
  server.handle(RPC_CHANNELS.system.IS_DEBUG_MODE, async () => {
    return !deps.platform.isPackaged
  })

  // Release notes
  server.handle(RPC_CHANNELS.releaseNotes.GET, async () => {
    // Loaded lazily inside the handler so the bundled release-notes payload is
    // read only when the renderer actually asks for it; a top-level import
    // would pull it into every server start. P2.88 put this file under lint.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getCombinedReleaseNotes } = require('@nessy-agent/shared/release-notes') as typeof import('@nessy-agent/shared/release-notes')
    return getCombinedReleaseNotes()
  })

  server.handle(RPC_CHANNELS.releaseNotes.GET_LATEST_VERSION, async () => {
    // Same lazy load as the handler above.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getLatestReleaseVersion } = require('@nessy-agent/shared/release-notes') as typeof import('@nessy-agent/shared/release-notes')
    return getLatestReleaseVersion()
  })

  // Get git branch for a directory (returns null if not a git repo or git unavailable)
  server.handle(RPC_CHANNELS.git.GET_BRANCH, async (_ctx, dirPath: string) => {
    try {
      const branch = execSync('git rev-parse --abbrev-ref HEAD', {
        cwd: dirPath,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 5000,
      }).trim()
      return branch || null
    } catch {
      return null
    }
  })

  // Git Bash detection and configuration (Windows only)
  server.handle(RPC_CHANNELS.gitbash.CHECK, async () => {
    const platform = process.platform as 'win32' | 'darwin' | 'linux'

    if (platform !== 'win32') {
      return { found: true, path: null, platform }
    }

    const commonPaths = [
      'C:\\Program Files\\Git\\bin\\bash.exe',
      'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
      join(process.env.LOCALAPPDATA || '', 'Programs', 'Git', 'bin', 'bash.exe'),
      join(process.env.PROGRAMFILES || '', 'Git', 'bin', 'bash.exe'),
    ]

    const persistedPath = getGitBashPath()
    if (persistedPath) {
      if (await isUsableGitBashPath(persistedPath)) {
        process.env.CLAUDE_CODE_GIT_BASH_PATH = persistedPath.trim()
        return { found: true, path: persistedPath, platform }
      }
      clearGitBashPath()
    }

    for (const bashPath of commonPaths) {
      if (await isUsableGitBashPath(bashPath)) {
        process.env.CLAUDE_CODE_GIT_BASH_PATH = bashPath
        setGitBashPath(bashPath)
        return { found: true, path: bashPath, platform }
      }
    }

    try {
      const result = execSync('where bash', {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 5000,
      }).trim()
      const firstPath = result.split('\n')[0]?.trim()
      if (firstPath && firstPath.toLowerCase().includes('git') && await isUsableGitBashPath(firstPath)) {
        process.env.CLAUDE_CODE_GIT_BASH_PATH = firstPath
        setGitBashPath(firstPath)
        return { found: true, path: firstPath, platform }
      }
    } catch {
      // where command failed
    }

    delete process.env.CLAUDE_CODE_GIT_BASH_PATH
    return { found: false, path: null, platform }
  })

  server.handle(RPC_CHANNELS.gitbash.BROWSE, async (ctx) => {
    const result = await requestClientOpenFileDialog(server, ctx.clientId, {
      // Name the shell, not one filename: the accepted enum is
      // bash.exe/sh.exe/bash/sh (troubleshoot-install.md), and the 'All files'
      // filter keeps the extension-less names selectable.
      title: 'Select the Git Bash shell executable',
      filters: [
        { name: 'Executable', extensions: ['exe'] },
        { name: 'All files', extensions: ['*'] },
      ],
      properties: ['openFile'],
      defaultPath: 'C:\\Program Files\\Git\\bin',
    })

    if (result.canceled || result.filePaths.length === 0) {
      return null
    }

    return result.filePaths[0]
  })

  server.handle(RPC_CHANNELS.gitbash.SET_PATH, async (_ctx, bashPath: string) => {
    const validation = await validateGitBashPath(bashPath)
    if (!validation.valid) {
      return { success: false, error: validation.error }
    }

    setGitBashPath(validation.path)
    process.env.CLAUDE_CODE_GIT_BASH_PATH = validation.path
    return { success: true }
  })

  // Debug logging from renderer -> main log file (fire-and-forget, no response)
  server.handle(RPC_CHANNELS.debug.LOG, async (_ctx, ...args: unknown[]) => {
    deps.platform.logger.info('[renderer]', ...args)
  })

  // Shell operations - open URL in external browser (or handle nessy:// internally)
  server.handle(RPC_CHANNELS.shell.OPEN_URL, async (ctx, url: string) => {
    deps.platform.logger.info('[OPEN_URL] Received request:', url)
    try {
      const classification = classifyExternalUrl(url)
      if (classification.kind === 'dangerous') {
        throw new Error(formatBlockedUrlError(classification))
      }

      const parsed = new URL(url)

      if (classification.kind === 'internal-deeplink') {
        const deepLink = parseInternalNessyAgentsDeepLink(parsed)

        if (deepLink?.handledNoop) {
          deps.platform.logger.info('[OPEN_URL] Ignoring auth-callback deep link in OPEN_URL handler')
          return
        }

        if (deepLink?.navigation?.view || deepLink?.navigation?.action) {
          const target = deepLink.workspaceId && deepLink.workspaceId !== ctx.workspaceId
            ? { to: 'workspace' as const, workspaceId: deepLink.workspaceId }
            : { to: 'client' as const, clientId: ctx.clientId }

          deps.platform.logger.info('[OPEN_URL] Routing nessy:// URL internally via deeplink:navigate')
          // "Internally" is about the transport, not about trust: the URL still
          // arrived on OPEN_URL, which carries markdown-link clicks from model
          // output. Stamp it external so the renderer keeps it inert — leaving
          // the field off would fail safe to the same verdict, but only by
          // accident of the missing-value rule.
          server.push(RPC_CHANNELS.deeplink.NAVIGATE, target, { ...deepLink.navigation, origin: 'external' })
          return
        }

        // For links requiring window management (e.g. window=focused/full), or
        // unknown deep-link shapes, fall back to the client protocol handler.
        deps.platform.logger.info('[OPEN_URL] Falling back to client openExternal for nessy:// URL')
        const deepLinkResult = await requestClientOpenExternal(server, ctx.clientId, url)
        if (!deepLinkResult.opened) {
          deps.platform.logger.error(`[OPEN_URL] Client capability failed: ${deepLinkResult.error}`)
          throw new Error(`Cannot open URL on client: ${deepLinkResult.error}`)
        }
        return
      }

      const result = await requestClientOpenExternal(server, ctx.clientId, url)
      if (!result.opened) {
        deps.platform.logger.error(`[OPEN_URL] Client capability failed: ${result.error}`)
        throw new Error(`Cannot open URL on client: ${result.error}`)
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error'
      deps.platform.logger.error('openUrl error:', message)
      throw new Error(`Failed to open URL: ${message}`)
    }
  })

  server.handle(RPC_CHANNELS.shell.OPEN_FILE, async (ctx, path: string) => {
    assertLocalWorkspace(deps, ctx, 'Open file')
    try {
      // Expand ~ before resolve() — resolve() treats ~ as a literal path component
      const expanded = path.startsWith('~') ? path.replace(/^~/, homedir()) : path
      const absolutePath = resolve(expanded)
      const safePath = await validateFilePath(absolutePath, getWorkspaceAllowedDirs(deps.workspaceService, ctx.workspaceId))
      const result = await requestClientOpenPath(server, ctx.clientId, safePath)
      if (result.error) throw new Error(result.error)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error'
      deps.platform.logger.error('openFile error:', message)
      throw new Error(`Failed to open file: ${message}`)
    }
  })

  server.handle(RPC_CHANNELS.shell.SHOW_IN_FOLDER, async (ctx, path: string) => {
    assertLocalWorkspace(deps, ctx, 'Show in folder')
    try {
      const expanded = path.startsWith('~') ? path.replace(/^~/, homedir()) : path
      const absolutePath = resolve(expanded)
      const safePath = await validateFilePath(absolutePath, getWorkspaceAllowedDirs(deps.workspaceService, ctx.workspaceId))
      await requestClientShowInFolder(server, ctx.clientId, safePath)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error'
      deps.platform.logger.error('showInFolder error:', message)
      throw new Error(`Failed to show in folder: ${message}`)
    }
  })
}
