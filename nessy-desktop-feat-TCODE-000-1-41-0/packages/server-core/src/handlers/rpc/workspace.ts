import { join } from 'path'
import { RPC_CHANNELS } from '@nessy-agent/shared/protocol'
import type {
  ConnectRemoteWorkspaceInput,
  CreateWorkspaceOnRemoteInput,
  UpdateRemoteWorkspaceInput,
} from '@nessy-agent/shared/workspaces'
import type { SessionKey } from '@nessy-agent/shared/sessions'
import { perf } from '@nessy-agent/shared/utils'
import { pushTyped, type RpcServer } from '@nessy-agent/server-core/transport'
import type { HandlerDeps } from '../handler-deps'

export const CORE_HANDLED_CHANNELS = [
  RPC_CHANNELS.workspaces.GET,
  RPC_CHANNELS.workspaces.CREATE,
  RPC_CHANNELS.workspaces.CONNECT_REMOTE,
  RPC_CHANNELS.workspaces.UPDATE_REMOTE,
  RPC_CHANNELS.workspaces.CREATE_ON_REMOTE,
  RPC_CHANNELS.workspaces.DELETE,
  RPC_CHANNELS.window.GET_WORKSPACE,
  RPC_CHANNELS.window.GET_MODE,
  RPC_CHANNELS.window.SWITCH_WORKSPACE,
  RPC_CHANNELS.workspace.READ_IMAGE,
  RPC_CHANNELS.workspace.WRITE_IMAGE,
  RPC_CHANNELS.workspace.LIST_CUSTOM_SLASH_COMMANDS,
  RPC_CHANNELS.theme.GET_APP,
  RPC_CHANNELS.theme.GET_PRESETS,
  RPC_CHANNELS.theme.LOAD_PRESET,
  RPC_CHANNELS.theme.GET_COLOR_THEME,
  RPC_CHANNELS.theme.SET_COLOR_THEME,
  RPC_CHANNELS.theme.BROADCAST_PREFERENCES,
  RPC_CHANNELS.theme.GET_WORKSPACE_COLOR_THEME,
  RPC_CHANNELS.theme.SET_WORKSPACE_COLOR_THEME,
  RPC_CHANNELS.theme.GET_ALL_WORKSPACE_THEMES,
  RPC_CHANNELS.theme.BROADCAST_WORKSPACE_THEME,
  RPC_CHANNELS.views.LIST,
  RPC_CHANNELS.views.SAVE,
  RPC_CHANNELS.toolIcons.GET_MAPPINGS,
  RPC_CHANNELS.logo.GET_URL,
] as const

export function registerWorkspaceCoreHandlers(server: RpcServer, deps: HandlerDeps): void {
  const { sessionManager } = deps
  const windowManager = deps.windowManager

  const workspaceService = () => {
    if (!deps.workspaceService) throw new Error('Workspace service is unavailable')
    return deps.workspaceService
  }
  const resolveWorkspace = (workspaceId: string) => workspaceService().resolve(workspaceId)

  // Public Workspace DTOs are path- and secret-free.
  server.handle(RPC_CHANNELS.workspaces.GET, async () => {
    return workspaceService().list()
  })

  server.handle(RPC_CHANNELS.workspaces.CREATE, async (_ctx, name: string) => {
    return workspaceService().create({ name })
  })

  server.handle(RPC_CHANNELS.workspaces.CONNECT_REMOTE, async (_ctx, input: ConnectRemoteWorkspaceInput) => {
    return workspaceService().connectRemoteWorkspace(input)
  })

  server.handle(RPC_CHANNELS.workspaces.UPDATE_REMOTE, async (_ctx, input: UpdateRemoteWorkspaceInput) => {
    return workspaceService().updateRemoteWorkspace(input)
  })

  server.handle(RPC_CHANNELS.workspaces.CREATE_ON_REMOTE, async (_ctx, input: CreateWorkspaceOnRemoteInput) => {
    return workspaceService().createWorkspaceOnRemote(input)
  })

  /**
   * P6.501 — the headless route the purge never had.
   *
   * Nothing is re-implemented here: `WorkspaceService.delete` already stages
   * both roots into `.trash`, runs the four cleanup participants, removes the
   * credentials and writes a delete journal, all under a quiescence lease. It
   * simply had exactly one caller, the Electron `workspace:remove` IPC, so a
   * user offboarding a project on a headless install had no supported route.
   *
   * The whole result crosses the wire, `cleanupFailures` included. A verb that
   * answered `true` would let a purge whose credential cleanup failed read as a
   * complete one — the same collapse this row removed from `main/index.ts`.
   *
   * The residue the delegated decision chose to disclose rather than delete —
   * the Codex CLI's own `~/.codex` history — is a CONSTANT, not a field: the
   * app says it in the removal toast, and `nessy-general-agent workspace remove`
   * prints it. It is not carried here because it does not vary with the result.
   */
  server.handle(RPC_CHANNELS.workspaces.DELETE, async (_ctx, workspaceId: string) => {
    if (typeof workspaceId !== 'string' || workspaceId.trim() === '') {
      throw new Error('workspace id is required')
    }
    return workspaceService().delete(workspaceId)
  })

  server.handle(RPC_CHANNELS.workspace.LIST_CUSTOM_SLASH_COMMANDS, async (ctx, session: SessionKey) => {
    const callerWorkspaceId = ctx.workspaceId
      ?? (ctx.webContentsId != null ? windowManager?.getWorkspaceForWindow(ctx.webContentsId) : undefined)
    if (!callerWorkspaceId || callerWorkspaceId !== session?.workspaceId || !session.sessionId) {
      throw new Error('session-scope-mismatch')
    }
    return sessionManager.listCustomSlashCommandSummaries(session)
  })

  // Get workspace ID for the calling window
  server.handle(RPC_CHANNELS.window.GET_WORKSPACE, (ctx) => {
    const workspaceId = ctx.workspaceId ?? windowManager?.getWorkspaceForWindow(ctx.webContentsId!)
    // Set up ConfigWatcher for live updates (labels, statuses, sources, themes)
    if (workspaceId) {
      const workspace = resolveWorkspace(workspaceId)
      sessionManager.setupConfigWatcher(workspace.workspaceRootPath, workspaceId)
    }
    return workspaceId
  })

  // Get mode for the calling window (always 'main' now)
  server.handle(RPC_CHANNELS.window.GET_MODE, () => {
    return 'main'
  })

  // Switch workspace in current window (in-window switching)
  server.handle(RPC_CHANNELS.window.SWITCH_WORKSPACE, async (ctx, workspaceId: string) => {
    const end = perf.start('ipc.switchWorkspace', { workspaceId })

    // Keep WS push routing in sync (works for both GUI and headless)
    server.updateClientWorkspace?.(ctx.clientId, workspaceId)

    if (windowManager) {
      const wcId = ctx.webContentsId!

      // Get the old workspace ID before updating
      const oldWorkspaceId = windowManager.getWorkspaceForWindow(wcId)

      // Update the window's workspace mapping
      const updated = windowManager.updateWindowWorkspace(wcId, workspaceId)

      // If update failed, the window may have been re-created (e.g., after refresh)
      // Try to register it
      if (!updated) {
        const win = windowManager.getWindowByWebContentsId(wcId)
        if (win) {
          windowManager.registerWindow(win, workspaceId)
          deps.platform.logger.info(`Re-registered window ${wcId} for workspace ${workspaceId}`)
        }
      }

      // Clear activeViewingSession for old workspace if no other windows are viewing it
      // This ensures read/unread state is correct after workspace switch
      if (oldWorkspaceId && oldWorkspaceId !== workspaceId) {
        const otherWindows = windowManager.getAllWindowsForWorkspace(oldWorkspaceId)
        if (otherWindows.length === 0) {
          sessionManager.clearActiveViewingSession(oldWorkspaceId)
        }
      }
    }

    // Set up ConfigWatcher for the new workspace
    const workspace = resolveWorkspace(workspaceId)
    sessionManager.setupConfigWatcher(workspace.workspaceRootPath, workspaceId)
    end()

    // RoutedClient resolves ownership through the trusted async main/preload
    // factory. This response deliberately contains only the local ID.
    return { workspaceId }
  })

  // ============================================================
  // Workspace Image Read/Write
  // ============================================================

  // Generic workspace image loading (for source icons, status icons, etc.)
  server.handle(RPC_CHANNELS.workspace.READ_IMAGE, async (_ctx, workspaceId: string, relativePath: string) => {
    const workspace = resolveWorkspace(workspaceId)

    const { readFileSync, existsSync } = await import('fs')
    const { join, normalize } = await import('path')

    // Security: validate path
    // - Must not contain .. (path traversal)
    // - Must be a valid image extension
    const ALLOWED_EXTENSIONS = ['.svg', '.png', '.jpg', '.jpeg', '.webp', '.ico', '.gif']

    if (relativePath.includes('..')) {
      throw new Error('Invalid path: directory traversal not allowed')
    }

    const ext = relativePath.toLowerCase().slice(relativePath.lastIndexOf('.'))
    if (!ALLOWED_EXTENSIONS.includes(ext)) {
      throw new Error(`Invalid file type: ${ext}. Allowed: ${ALLOWED_EXTENSIONS.join(', ')}`)
    }

    // Resolve path relative to workspace root
    const absolutePath = normalize(join(workspace.workspaceRootPath, relativePath))

    // Double-check the resolved path is still within workspace
    const { isPathWithin } = await import('@nessy-agent/shared/workspaces')
    if (!isPathWithin(workspace.workspaceRootPath, absolutePath)) {
      throw new Error('Invalid path: outside workspace directory')
    }

    if (!existsSync(absolutePath)) {
      return null  // Missing optional files - silent fallback to default icons
    }

    // Read file as buffer
    const buffer = readFileSync(absolutePath)

    // If SVG, return as UTF-8 string (caller will use as innerHTML)
    if (ext === '.svg') {
      return buffer.toString('utf-8')
    }

    // For binary images, return as data URL
    const mimeTypes: Record<string, string> = {
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.webp': 'image/webp',
      '.ico': 'image/x-icon',
      '.gif': 'image/gif',
    }
    const mimeType = mimeTypes[ext] || 'image/png'
    return `data:${mimeType};base64,${buffer.toString('base64')}`
  })

  // Generic workspace image writing (for workspace icon, etc.)
  // Resizes images to max 256x256 to keep file sizes small
  server.handle(RPC_CHANNELS.workspace.WRITE_IMAGE, async (_ctx, workspaceId: string, relativePath: string, base64: string, mimeType: string) => {
    const workspace = resolveWorkspace(workspaceId)

    const { writeFileSync, existsSync, unlinkSync, readdirSync } = await import('fs')
    const { join, normalize, basename } = await import('path')

    // Security: validate path
    const ALLOWED_EXTENSIONS = ['.svg', '.png', '.jpg', '.jpeg', '.webp', '.gif']

    if (relativePath.includes('..')) {
      throw new Error('Invalid path: directory traversal not allowed')
    }

    const ext = relativePath.toLowerCase().slice(relativePath.lastIndexOf('.'))
    if (!ALLOWED_EXTENSIONS.includes(ext)) {
      throw new Error(`Invalid file type: ${ext}. Allowed: ${ALLOWED_EXTENSIONS.join(', ')}`)
    }

    // Resolve path relative to workspace root
    const absolutePath = normalize(join(workspace.workspaceRootPath, relativePath))

    // Double-check the resolved path is still within workspace
    const { isPathWithin } = await import('@nessy-agent/shared/workspaces')
    if (!isPathWithin(workspace.workspaceRootPath, absolutePath)) {
      throw new Error('Invalid path: outside workspace directory')
    }

    // If this is an icon file (icon.*), delete any existing icon files with different extensions
    const fileName = basename(relativePath)
    if (fileName.startsWith('icon.')) {
      const files = readdirSync(workspace.workspaceRootPath)
      for (const file of files) {
        if (file.startsWith('icon.') && file !== fileName) {
          const oldPath = join(workspace.workspaceRootPath, file)
          try {
            unlinkSync(oldPath)
          } catch {
            // Ignore errors deleting old icon
          }
        }
      }
    }

    // Decode base64 to buffer
    const buffer = Buffer.from(base64, 'base64')

    // For SVGs, just write directly (no resizing needed)
    if (mimeType === 'image/svg+xml' || ext === '.svg') {
      writeFileSync(absolutePath, buffer)
      return
    }

    // For raster images, resize to max 256x256
    const metadata = await deps.platform.imageProcessor.getMetadata(buffer)
    const width = metadata?.width ?? 0
    const height = metadata?.height ?? 0

    // Only resize if larger than 256px
    if (width > 256 || height > 256) {
      const resized = await deps.platform.imageProcessor.process(buffer, {
        resize: { width: 256, height: 256 },
        format: 'png',
      })
      writeFileSync(absolutePath, resized)
    } else {
      // Small enough, write as-is
      writeFileSync(absolutePath, buffer)
    }
  })

  // ============================================================
  // Theme (app-level only)
  // ============================================================

  server.handle(RPC_CHANNELS.theme.GET_APP, async () => {
    const { loadAppTheme } = await import('@nessy-agent/shared/config/storage')
    return loadAppTheme()
  })

  // Preset themes (app-level)
  server.handle(RPC_CHANNELS.theme.GET_PRESETS, async () => {
    const { loadPresetThemes } = await import('@nessy-agent/shared/config/storage')
    return loadPresetThemes()
  })

  server.handle(RPC_CHANNELS.theme.LOAD_PRESET, async (_ctx, themeId: string) => {
    const { loadPresetTheme } = await import('@nessy-agent/shared/config/storage')
    return loadPresetTheme(themeId)
  })

  server.handle(RPC_CHANNELS.theme.GET_COLOR_THEME, async () => {
    const { getColorTheme } = await import('@nessy-agent/shared/config/storage')
    return getColorTheme()
  })

  server.handle(RPC_CHANNELS.theme.SET_COLOR_THEME, async (_ctx, themeId: string) => {
    const { setColorTheme } = await import('@nessy-agent/shared/config/storage')
    setColorTheme(themeId)
  })

  // Broadcast theme preferences to all other windows (for cross-window sync)
  server.handle(RPC_CHANNELS.theme.BROADCAST_PREFERENCES, async (ctx, preferences: { mode: string; colorTheme: string; font: string; motion?: string }) => {
    pushTyped(server, RPC_CHANNELS.theme.PREFERENCES_CHANGED, { to: 'all' }, preferences)
  })

  // Workspace-level theme overrides
  server.handle(RPC_CHANNELS.theme.GET_WORKSPACE_COLOR_THEME, async (_ctx, workspaceId: string) => {
    return resolveWorkspace(workspaceId).config.defaults?.colorTheme ?? null
  })

  server.handle(RPC_CHANNELS.theme.SET_WORKSPACE_COLOR_THEME, async (_ctx, workspaceId: string, themeId: string | null) => {
    if (themeId) {
      await workspaceService().updateSettings(workspaceId, { defaults: { colorTheme: themeId } })
    } else {
      await workspaceService().updateSettings(workspaceId, { clearDefaults: ['colorTheme'] })
    }
  })

  server.handle(RPC_CHANNELS.theme.GET_ALL_WORKSPACE_THEMES, async () => {
    const themes: Record<string, string | undefined> = {}
    for (const workspace of workspaceService().listResolved()) {
      themes[workspace.id] = workspace.config.defaults?.colorTheme
    }
    return themes
  })

  // Broadcast workspace theme change to all other windows (for cross-window sync)
  server.handle(RPC_CHANNELS.theme.BROADCAST_WORKSPACE_THEME, async (ctx, workspaceId: string, themeId: string | null) => {
    pushTyped(server, RPC_CHANNELS.theme.WORKSPACE_THEME_CHANGED, { to: 'all' }, { workspaceId, themeId })
  })

  // ============================================================
  // Views
  // ============================================================

  // List views for a workspace (dynamic expression-based filters stored in views.json)
  server.handle(RPC_CHANNELS.views.LIST, async (_ctx, workspaceId: string) => {
    const workspace = resolveWorkspace(workspaceId)

    const { listViews } = await import('@nessy-agent/shared/views/storage')
    return listViews(workspace.workspaceRootPath)
  })

  // Save views (replaces full array)
  server.handle(RPC_CHANNELS.views.SAVE, async (_ctx, workspaceId: string, views: import('@nessy-agent/shared/views').ViewConfig[]) => {
    const workspace = resolveWorkspace(workspaceId)

    const { saveViews } = await import('@nessy-agent/shared/views/storage')
    saveViews(workspace.workspaceRootPath, views)
    // Broadcast labels changed since views are used alongside labels in sidebar
    pushTyped(server, RPC_CHANNELS.labels.CHANGED, { to: 'workspace', workspaceId }, workspaceId)
  })

  // ============================================================
  // Tool Icons and Logo
  // ============================================================

  // Tool icon mappings — loads tool-icons.json and resolves each entry's icon to a data URL
  // for display in the Appearance settings page
  server.handle(RPC_CHANNELS.toolIcons.GET_MAPPINGS, async () => {
    const { getToolIconsDir } = await import('@nessy-agent/shared/config/storage')
    const { loadToolIconConfig } = await import('@nessy-agent/shared/utils/cli-icon-resolver')
    const { encodeIconToDataUrl } = await import('@nessy-agent/shared/utils/icon-encoder')
    const { join } = await import('path')

    const toolIconsDir = getToolIconsDir()
    const config = loadToolIconConfig(toolIconsDir)
    if (!config) return []

    return config.tools
      .map(tool => {
        const iconPath = join(toolIconsDir, tool.icon)
        const iconDataUrl = encodeIconToDataUrl(iconPath)
        if (!iconDataUrl) return null
        return {
          id: tool.id,
          displayName: tool.displayName,
          iconDataUrl,
          commands: tool.commands,
        }
      })
      .filter(Boolean)
  })

  // Logo URL resolution (uses Node.js filesystem cache for provider domains)
  server.handle(RPC_CHANNELS.logo.GET_URL, async (_ctx, serviceUrl: string, provider?: string) => {
    const { getLogoUrl } = await import('@nessy-agent/shared/utils/logo')
    const result = getLogoUrl(serviceUrl, provider)
    return result
  })
}
