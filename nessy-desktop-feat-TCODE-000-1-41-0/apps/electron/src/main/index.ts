// Load user's shell environment first (before other imports that may use env)
// This ensures tools like Homebrew, nvm, etc. are available to the agent
import { loadShellEnv } from './shell-env'
loadShellEnv()

import { app, BrowserWindow, clipboard, dialog, ipcMain, nativeImage, nativeTheme, powerMonitor, shell } from 'electron'
import { randomUUID } from 'crypto'

// Initialize i18n for main process (menus, dialogs, etc.)
//
// The main-process i18n instance has no detection plugin (no localStorage in Node)
// — it always starts at `fallbackLng: 'en'`. We hydrate it here from the persisted
// `uiLanguage` preference, which is maintained by the `i18n:changeLanguage` IPC
// handler whenever the user changes Appearance → Language. Without this, the
// renderer would restore its language from localStorage on every restart while
// the main process silently stayed at English — breaking session title language,
// the system prompt's "Preferred language" line, and the native menu.
import { setupI18n, i18n, SUPPORTED_LANGUAGE_CODES, type LanguageCode } from '@nessy-agent/shared/i18n'
import { getPersistedUiLanguage, setPersistedUiLanguage } from '@nessy-agent/shared/config'
import { CONFIG_DIR } from '@nessy-agent/shared/config/paths'
setupI18n()
// Note: deferred startup log lives below where mainLog is available (after log.initialize()).

import { join, delimiter } from 'path'
import { existsSync, readFileSync, renameSync } from 'fs'
import { writeFile } from 'fs/promises'
import { RPC_CHANNELS } from '@nessy-agent/shared/protocol'
import { SessionManager, setSessionPlatform, setSessionRuntimeHooks } from '@nessy-agent/server-core/sessions'
import { registerAllRpcHandlers } from './handlers/index'
import { registerNessyAuthIpcHandlers, runGatewayLoginCheck, ensureGatewayAuthForLaunch, NESSY_GATEWAY_AUTH_STATUS_CHANNEL } from './handlers/nessy-auth'
// Relative import (not the `@/` renderer alias) so esbuild bundles the gateway
// URL literal into the main process; nessy-gateway.ts's only import is
// type-only, so no renderer runtime deps come along. Keeps the URL single-source.
import { dpSessionBroker, getValidCreds } from '@nessy-agent/shared/auth/dp'
import { registerCoreRpcHandlers, cleanupSessionFileWatchForClient } from '@nessy-agent/server-core/handlers/rpc'
import type { PlatformServices } from '../runtime/platform'
import { createElectronPlatform } from './platform'
import type { HandlerDeps } from './handlers/handler-deps'
import {
  assertManagedVersionAllowed,
  bootstrapServer,
  createStorageRuntime,
  loadManagedPiPolicy,
  managedPolicyUnreadableNotice,
  ManagedSettingsStartupError,
  registerEnforcedManagedInAppBrowserProvider,
  registerEnforcedManagedModelPricing,
  registerEnforcedManagedNonGatewayConnections,
  registerEnforcedManagedInAppUpdatesProvider,
  registerEnforcedManagedPolicyProvider,
  registerEnforcedManagedRetentionProvider,
  registerEnforcedManagedSandboxEnabledProvider,
  releaseServerLock,
  type StorageRuntime,
} from '@nessy-agent/server-core/bootstrap'
import { createElectronRemoteWorkspaceGateway } from './handlers/workspace'
import { initModelRefreshService, getModelRefreshService, setFetcherPlatform } from '@nessy-agent/server-core/model-fetchers'
import { setSearchPlatform, setImageProcessor } from '@nessy-agent/server-core/services'
import { createApplicationMenu } from './menu'
import { WindowManager } from './window-manager'
import { loadWindowState, saveWindowState } from './window-state'
import { getLlmConnections } from '@nessy-agent/shared/config'
import {
  initializeManagedDeliveryFromCache,
  setManagedDeliveryApproval,
  setManagedDeliveryEnabled,
  startManagedDeliveryEnvApplication,
  startManagedDeliveryPolling,
} from '@nessy-agent/shared/config/managed-delivery'
import { createManagedApprovalGate } from './handlers/managed-approval-dialog'
import { enforceForceRemoteSettingsRefresh } from '@nessy-agent/shared/config/managed-refresh-gate'
import { restoreCodexInAppUpdatesRequirement } from '@nessy-agent/shared/config/codex-managed-requirement-cache'
import { ensureStorageLayoutV2, type VerifiedStorageLayoutV2 } from '@nessy-agent/shared/workspaces'
import { initializeDocs } from '@nessy-agent/shared/docs'
import { initializeReleaseNotes } from '@nessy-agent/shared/release-notes'
import { ensureDefaultPermissions } from '@nessy-agent/shared/agent/permissions-config'
import { ensureToolIcons, ensurePresetThemes, loadStoredConfig } from '@nessy-agent/shared/config'
import { ensureBundledSkills } from '@nessy-agent/shared/skills'
import { setBundledAssetsRoot } from '@nessy-agent/shared/utils'
import { initializeBackendHostRuntime, resolvePluginNodeRuntime, resolveWindowsSandboxRuntime } from '@nessy-agent/shared/agent/backend'
import { setPowerShellValidatorRoot } from '@nessy-agent/shared/agent'
import { handleDeepLink } from './deep-link'
import { BrowserPaneManager } from './browser-pane-manager'
import { OAuthFlowStore } from '@nessy-agent/shared/auth'
import { registerThumbnailScheme, registerThumbnailHandler } from './thumbnail-protocol'
import log, { isDebugMode, mainLog, getLogFilePath, autoUpdateLog } from './logger'
import { setPerfEnabled, enableDebug } from '@nessy-agent/shared/utils'
import { registerPiModelResolver } from '@nessy-agent/shared/config'
import { getPiModelsForAuthProvider, getAllPiModels } from '@nessy-agent/shared/config'
import { initNotificationService, initBadgeIcon, initInstanceBadge, updateBadgeCount, deliverModelNotification as deliverDesktopNotification, deliverScheduledRunNotification } from './notifications'
import { checkForUpdatesOnLaunch, setAutoUpdateEventSink, isUpdating, setBeforeUpdateQuitHook } from './auto-update'
import { finalizeQuit } from './quit-finalizer'
import type { EventSink } from '@nessy-agent/server-core/transport'
import { validateGitBashPath, checkVCRedistInstalled } from '@nessy-agent/server-core/services'
import { showStorageReadinessBlockedDialog } from './storage-readiness-ui'
import { applySafeModeRelaunchEnv, safeModeRelaunchIntent } from './safe-mode-relaunch'
import {
  createBootDiagnosticWriter,
  formatBootBlockedLogLine,
  formatBootFatalLogLine,
  reportBootFatal,
} from './boot-fatal'
import { isRefusedStoredConfigError } from '../shared/broken-config-dialog'

// Initialize electron-log for renderer process support
log.initialize()

// Enable debug/perf in dev mode (running from source)
if (isDebugMode) {
  process.env.NESSY_DEBUG = '1'
  enableDebug()
  setPerfEnabled(true)
}

// Bundle CLI tools: resolve platform-specific uv binary and wrapper scripts.
// These are available to all agent Bash sessions via NESSY_UV, NESSY_SCRIPTS env vars
// and PATH prepend. uv auto-downloads Python 3.12 on first use (~5s, then cached).
{
  // In packaged app: resources are at process.resourcesPath/app/resources/
  // In dev: resources are at __dirname/../resources/ (sibling of dist/)
  const resourcesBase = app.isPackaged
    ? join(process.resourcesPath, 'app')
    : join(__dirname, '..')
  const platformKey = `${process.platform}-${process.arch}`
  const uvPlatformDir = join(resourcesBase, 'resources', 'bin', platformKey)
  const uvBinary = join(uvPlatformDir, process.platform === 'win32' ? 'uv.exe' : 'uv')
  const binDir = join(resourcesBase, 'resources', 'bin')
  const scriptsDir = join(resourcesBase, 'resources', 'scripts')

  const bundledUvExists = existsSync(uvBinary)
  const fallbackUv = bundledUvExists ? null : 'uv'

  // Runtime resolver hints for shared session tools.
  //
  // `'true'`/`'false'`, not `'1'`/`'0'`: that is the spelling every other writer
  // and reader of this variable uses — the generated `bin/nessy-server` launcher
  // and Dockerfile (`scripts/build-server.ts`), `platform-headless.ts`,
  // `logger.ts`, `packages/server/src/index.ts`, the `:448` re-assert below, and
  // `docs-site/content/server/headless.md`. This line wrote `'1'`/`'0'`, which
  // agreed with exactly one reader — `session-tools-core`'s `inferPackagedMode`
  // — and only until `:448` overwrote it, which happens before any tool handler
  // can run. The net effect was that the packaged-runtime guards in
  // `resolve-script-runtime.ts` were dead in packaged builds. Pinned by
  // `__tests__/packaged-env-spelling.test.ts`.
  process.env.NESSY_IS_PACKAGED = app.isPackaged ? 'true' : 'false'
  process.env.NESSY_RESOURCES_BASE = resourcesBase
  process.env.NESSY_APP_ROOT = app.isPackaged ? app.getAppPath() : process.cwd()

  process.env.NESSY_UV = bundledUvExists ? uvBinary : (fallbackUv ?? uvBinary)

  // Bun runtime (packaged builds should prefer bundled runtime over PATH)
  const bunName = process.platform === 'win32' ? 'bun.exe' : 'bun'
  const bunCandidates = [
    ...(app.isPackaged ? [join(process.resourcesPath, 'vendor', 'bun', bunName)] : []),
    join(resourcesBase, 'vendor', 'bun', bunName),
  ]
  const bunBinary = bunCandidates.find(candidate => existsSync(candidate))
  if (bunBinary) {
    process.env.NESSY_BUN = bunBinary
  }

  process.env.NESSY_SCRIPTS = scriptsDir
  // DA1.61 — the agent-facing CLI is NOT part of the packaged artefact, so this
  // build stops claiming it is. Owner decision 2026-09-17, after lane SIT read
  // three things off the packaged 1.39.0:
  //
  // - `apps/cli` is absent from `Contents/Resources/app` (the bundle carries
  //   `dist`, `node_modules`, `packages`, `resources` and `package.json`, and
  //   `electron-builder.yml`'s `files` list never names it) while this block
  //   used to point both variables at `<appPath>/apps/cli/src/index.ts`;
  // - the shim that reads them (`resources/bin/nessy-general-agent`) is not in
  //   the directory prepended to the agent's PATH either — it exists only under
  //   `app/dist/resources/bin/`, while `binDir` above resolves to
  //   `app/resources/bin`, whose listing is `codex`, `darwin-arm64` and the
  //   eight document tools;
  // - `grep -aoF runDoctor` over `dist/main.cjs` answers 0 against
  //   `collectGatewayAuthInput` 6 — the shared collector is bundled, the CLI's
  //   own driver is not.
  //
  // So in a packaged build the two variables named a file that cannot exist, for
  // a shim that is not on PATH. Neither is set there any more; DEV is unchanged,
  // where `apps/cli` and the shim are both really present. The config doctor
  // stays reachable in the app through its own `GET_CONFIG_DOCTOR` handler — the
  // CLI was never its only door.
  //
  // Nothing is added to `files`: shipping that CLI is the decision the owner
  // declined, not a step this comment leaves for later.
  if (!app.isPackaged) {
    const cliEntry = join(process.cwd(), 'apps', 'cli', 'src', 'index.ts')
    process.env.NESSY_COMMANDS_ENTRY = cliEntry
    process.env.NESSY_CLI_ENTRY = cliEntry
  }
  // DA1.63 — the packaged branch used to name `app/resources/docs`, a directory
  // the bundle does not have. Measured off the packaged 1.39.0 while DA1.61 was
  // removing this block's dead entry pointers: `Contents/Resources/app/resources`
  // lists `bin`, `bridge-mcp-server`, `pi-agent-server`, `scripts` and
  // `session-mcp-server` and NO `docs`, while `app/dist/resources/docs` carries
  // all seventeen files including this one. The control that `resourcesBase` is
  // not simply wrong: `NESSY_SCRIPTS` above uses the same base and
  // `app/resources/scripts` does exist.
  //
  // The reason is in `electron-builder.yml`'s own `files` comment — the bundled
  // assets (docs, themes, permissions, tool-icons) live in `resources/` in the
  // repo and are copied to `dist/resources/` by `build:copy`
  // (`scripts/electron-build-resources.ts`, whose `destDir` is that path), so
  // they arrive in the artefact through `dist/**/*` rather than through the
  // `resources/...` entries beside it. `utils/paths.ts` symbol
  // `getBundledAssetsDir` has always resolved docs the same way; this one
  // variable was the only reader spelling the path by hand.
  process.env.NESSY_COMMANDS_DOC_PATH = app.isPackaged
    ? join(resourcesBase, 'dist', 'resources', 'docs', 'nessy-general-agent.md')
    : join(process.cwd(), 'apps', 'electron', 'resources', 'docs', 'nessy-general-agent.md')
  process.env.NESSY_CLI_DOC_PATH = process.env.NESSY_COMMANDS_DOC_PATH
  process.env.NESSY_AGENT_VERSION = app.getVersion()
  // Prepend both generic wrappers dir and platform uv dir:
  // - binDir exposes wrapper commands (pdf-tool, docx-tool, ...)
  // - uvPlatformDir exposes raw `uv` for direct shell usage / debugging
  process.env.PATH = `${binDir}${delimiter}${uvPlatformDir}${delimiter}${process.env.PATH}`

  if (!bundledUvExists) {
    mainLog.warn('Bundled uv binary missing, CLI document tools may fail unless uv is available on PATH.', {
      expectedUvPath: uvBinary,
      usingNessyUv: process.env.NESSY_UV,
    })
  }

  if (isDebugMode) {
    mainLog.info('CLI tools configured:', { uvBinary: process.env.NESSY_UV, binDir, scriptsDir, bundledUvExists })
  }
}

// Register Pi model resolver so llm-connections.ts can resolve Pi models
// without importing @earendil-works/pi-ai (which breaks the Vite renderer build)
registerPiModelResolver((piAuthProvider) =>
  piAuthProvider ? getPiModelsForAuthProvider(piAuthProvider) : getAllPiModels()
)

// Custom URL scheme for deeplinks (e.g., nessy://auth-complete)
// Supports multi-instance dev: NESSY_DEEPLINK_SCHEME env var (nessy1, nessy2, etc.)
const DEEPLINK_SCHEME = process.env.NESSY_DEEPLINK_SCHEME || 'nessy'

let windowManager: WindowManager | null = null
let sessionManager: SessionManager | null = null
let browserPaneManager: BrowserPaneManager | null = null
let oauthFlowStore: OAuthFlowStore | null = null
let moduleSink: EventSink | null = null
let moduleClientResolver: ((webContentsId: number) => string | undefined) | null = null
let storageRuntime: StorageRuntime | null = null

// Store pending deep link if app not ready yet (cold start)
let pendingDeepLink: string | null = null

/**
 * Startup is loud when it fails, instead of idling forever.
 *
 * Measured 2026-08-21 on packaged 1.31.0: a config tree that clears
 * `ensureStorageLayoutV2` but not `loadStoredConfig` made the app hang with no
 * window, no dialog and no log line — `app.whenReady().then(async …)` returns
 * an unawaited promise, and electron-log's transports are disabled outside
 * debug mode, so `mainLog` writes nowhere in a packaged build. See
 * `boot-fatal.ts`; `bootDiagnostic` deliberately bypasses electron-log for the
 * same reason `autoUpdateLog` does.
 */
let bootCompleted = false
const bootDiagnostic = createBootDiagnosticWriter(CONFIG_DIR)

/**
 * Surface a boot failure and end the process — but only while no window exists.
 * Once a window is up the app is usable and the caller's own handling stands.
 * Returns whether this took ownership of the failure.
 */
function reportBootFatalIfWindowless(phase: string, error: unknown): boolean {
  if (bootCompleted || appWindows(BrowserWindow.getAllWindows()).length > 0) return false
  // P6.725 — a refused `config.json` is the one startup failure with a way out,
  // so it is the one that gets buttons. The path is this constant and never one
  // parsed out of the refusal's own message: that message embeds the JSON
  // parser's text, which is derived from the file's CONTENT, and the action on
  // the other end is a rename. `config.json` is `storage.ts`'s own
  // `join(CONFIG_DIR, CONFIG_FILE_NAME)`; the name is repeated here rather than
  // exported because that module is a shared hot spot this change does not touch.
  const repair = isRefusedStoredConfigError(error)
    ? { configFile: join(CONFIG_DIR, 'config.json') }
    : undefined
  reportBootFatal({ phase, configDir: CONFIG_DIR, error, repair }, {
    writeDiagnostic: bootDiagnostic,
    showDialog: options => dialog.showMessageBox(options),
    // Reveal rather than open: the user is going to EDIT this file, and a
    // `.json` handed to `openPath` lands in whatever registered for the
    // extension, which on a developer machine is as likely to be a viewer.
    openPath: path => shell.showItemInFolder(path),
    // The rename, and nothing else: no write, no delete, no reset. The old file
    // survives under its new name, which is the whole of the owner's "nothing is
    // erased", and the target carries a millisecond stamp so it does not land on
    // a previous set-aside.
    setAside: (from, to) => { renameSync(from, to) },
    exit: code => app.exit(code),
    // Measured, not defensive: `app.exit()` leaves a windowless startup idling
    // in the platform run loop (see `boot-fatal.ts`). This rung is the one a run
    // loop cannot starve, and it is only reached when the clean one did nothing.
    hardExit: () => { process.kill(process.pid, 'SIGKILL') },
    schedule: (fn, ms) => { setTimeout(fn, ms) },
    locale: (() => {
      try {
        return app.getLocale()
      } catch {
        return undefined
      }
    })(),
  })
  return true
}

// Set app name early (before app.whenReady) to ensure correct macOS menu bar title
// Supports multi-instance dev: NESSY_APP_NAME env var (e.g., "Nessy Desktop [1]")
app.setName(process.env.NESSY_APP_NAME || 'Odysseus')

// Register as default protocol client for nessy:// URLs
// This must be done before app.whenReady() on some platforms
if (process.defaultApp) {
  // Development mode: need to pass the app path
  if (process.argv.length >= 2) {
    app.setAsDefaultProtocolClient(DEEPLINK_SCHEME, process.execPath, [process.argv[1]])
  }
} else {
  // Production mode
  app.setAsDefaultProtocolClient(DEEPLINK_SCHEME)
}

import { applyConfiguredProxySettings } from './network-proxy'

// Accept self-signed / untrusted certificates when connecting to a user-configured remote server.
// Only bypasses cert validation for the exact NESSY_SERVER_URL origin — all other connections
// use standard certificate verification. Without this, wss:// to self-signed servers fails with
// ERR_CERT_AUTHORITY_INVALID because Chromium's WebSocket rejects untrusted certs.
//
// Electron's certificate-error always reports URLs with https:// scheme, so we normalize
// wss:// → https:// (and ws:// → http://) to ensure origins compare correctly.
function normalizeOriginForCert(urlStr: string): string {
  const u = new URL(urlStr)
  if (u.protocol === 'wss:') u.protocol = 'https:'
  else if (u.protocol === 'ws:') u.protocol = 'http:'
  return u.origin
}

if (process.env.NESSY_SERVER_URL) {
  let serverOrigin: string | undefined
  try {
    serverOrigin = normalizeOriginForCert(process.env.NESSY_SERVER_URL)
  } catch {
    // Invalid URL — will fail later during connection, no need to handle here
  }
  if (serverOrigin) {
    app.on('certificate-error', (event, _webContents, url, _error, _certificate, callback) => {
      try {
        if (normalizeOriginForCert(url) === serverOrigin) {
          event.preventDefault()
          callback(true)
          return
        }
      } catch {
        // URL parse failure — fall through to default rejection
      }
      callback(false)
    })
  }
}

// Register thumbnail:// custom protocol for file preview thumbnails in the sidebar.
// Must happen before app.whenReady() — Electron requires early scheme registration.
registerThumbnailScheme()

// Handle deeplink on macOS (when app is already running)
app.on('open-url', (event, url) => {
  event.preventDefault()
  mainLog.info('Received deeplink:', url)

  if (windowManager) {
    handleDeepLink(url, windowManager, 'external', moduleSink ?? undefined, moduleClientResolver ?? undefined).catch(err => {
      mainLog.error('Failed to handle deep link:', err)
    })
  } else {
    // App not ready - store for later
    pendingDeepLink = url
  }
})

// Handle deeplink on Windows/Linux (single instance check)
const gotTheLock = app.requestSingleInstanceLock()
if (!gotTheLock) {
  app.quit()
} else {
  app.on('second-instance', (_event, commandLine, _workingDirectory) => {
    // Someone tried to run a second instance, we should focus our window.
    // On Windows/Linux, the deeplink is in commandLine
    const url = commandLine.find(arg => arg.startsWith(`${DEEPLINK_SCHEME}://`))
    if (url && windowManager) {
      mainLog.info('Received deeplink from second instance:', url)
      handleDeepLink(url, windowManager, 'external', moduleSink ?? undefined, moduleClientResolver ?? undefined).catch(err => {
        mainLog.error('Failed to handle deep link:', err)
      })
    } else if (windowManager) {
      // No deep link - just focus the first window
      const windows = windowManager.getAllWindows()
      if (windows.length > 0) {
        const win = windows[0].window
        if (win.isMinimized()) win.restore()
        win.focus()
      }
    }
  })
}

// Helper to create initial windows on startup
async function createInitialWindows(): Promise<void> {
  if (!windowManager || !storageRuntime) return

  // Load saved window state
  const savedState = loadWindowState()
  let workspaces = await storageRuntime.workspaceService.list()

  // If no workspaces exist, create default "My Workspace" on first run
  if (workspaces.length === 0) {
    await storageRuntime.workspaceService.create({ name: 'My Workspace' })
    workspaces = await storageRuntime.workspaceService.list()
    mainLog.info('Created default workspace on first run')
  }

  const validWorkspaceIds = workspaces.map(ws => ws.id)

  if (savedState?.windows.length) {
    // Restore windows from saved state
    let restoredCount = 0

    for (const saved of savedState.windows) {
      // Skip invalid workspaces
      if (!validWorkspaceIds.includes(saved.workspaceId)) continue

      // Restore main window with focused mode if it was saved
      mainLog.info(`Restoring window: workspaceId=${saved.workspaceId}, focused=${saved.focused ?? false}, url=${saved.url ?? 'none'}`)
      const win = windowManager.createWindow({
        workspaceId: saved.workspaceId,
        focused: saved.focused,
        restoreUrl: saved.url,
      })
      win.setBounds(saved.bounds)

      restoredCount++
    }

    if (restoredCount > 0) {
      mainLog.info(`Restored ${restoredCount} window(s) from saved state`)
      return
    }
  }

  // Default: open window for first workspace
  windowManager.createWindow({ workspaceId: workspaces[0].id })
  mainLog.info(`Created window for first workspace: ${workspaces[0].name}`)
}

const bootPromise = app.whenReady().then(async () => {
  if (!gotTheLock) return

  // The startup retention sweep runs inside the first ensureConfigDir(), which
  // this host reaches lazily through the first config write
  // (saveConfig/savePreferences) rather than at an explicit bootstrap site — so
  // the managed cleanupPeriodDays reader must be registered before anything
  // below can write config, or a delivered-only retention value never reaches
  // the sweep (R25). Reads the same enforced composition createStorageRuntime
  // uses; order-independent of initializeManagedDeliveryFromCache() further
  // down because getDeliveredManagedPolicy re-reads the cache on every call.
  registerEnforcedManagedRetentionProvider()
  // Same reasoning, for the T1 `sandbox.enabled` master switch: registered
  // before anything can read `getMacosSeatbeltBashSandboxEnabled()` (contour
  // b) or `CodexAgent.sandboxGloballyEnabled()` (contour e), so a managed
  // floor reaches both, not only the `ProcessSupervisor` wrap (contour a),
  // which reads the same composition straight from the policy object.
  registerEnforcedManagedSandboxEnabledProvider()
  // P3.261 — the in-app-update gate's CODEX tier, restored from the last
  // ANSWERED `configRequirements/read` before the launch check can run.
  //
  // The host tier below is registered here because `checkForUpdatesOnLaunch()`
  // is the one update entry point with no user behind it. The codex tier had no
  // such guarantee at all: `recordCodexInAppUpdatesRequirement` writes a
  // module-scope value that only exists once the first codex runtime of the
  // process has started, which is long after this handler. So an organisation
  // running codex ALONE got a weaker guarantee than a mixed fleet — the launch
  // check ran ungated at every boot — which inverts what an operator would
  // assume.
  //
  // Composition is unchanged: tightest wins across the two tiers, and a live
  // codex runtime answering later overwrites this with a fresher answer. Only
  // an ANSWERED requirement was ever written to the cache (P2.137's rule, kept
  // at the writer in `codex-agent.ts`), so this can restore a disable, restore
  // an administrator's WITHDRAWAL of one, or — for a missing, corrupt or
  // mis-versioned cache — do nothing at all, which is the pre-P3.261 behaviour.
  // It never throws; the whole module is best-effort by construction.
  restoreCodexInAppUpdatesRequirement()
  // P2.7 clause (c) — the in-app-update gate's HOST tier, registered HERE and
  // not beside the updater, because `checkForUpdatesOnLaunch()` further down
  // this same handler is the one update entry point with no user behind it. A
  // registration that lands after it has already let an unmanaged check run,
  // and with `autoDownload` on, stage a download the policy forbids. The
  // ordering is asserted in `__tests__/managed-update-registration.test.ts`
  // against this file's source, because there is nothing at runtime to catch a
  // future edit that moves one of the two lines past the other.
  registerEnforcedManagedInAppUpdatesProvider()
  // P2.399 — the in-app-BROWSER gate's HOST tier, beside its twin because it
  // reads the same enforced composition. No launch-time race to lose (every
  // browser entry point has a user or an agent behind it), but the pane
  // manager's own startup enforcement pass reads this once, so the registration
  // must precede `browserPaneManager.registerManagedPolicyEnforcement()` below.
  registerEnforcedManagedInAppBrowserProvider()
  // P2.7 — the whole composed policy, for the shared-package readers that need
  // the document rather than one key: the Claude spawn projects it onto the
  // SDK's own policy tier (`Options.managedSettings`).
  registerEnforcedManagedPolicyProvider()
  // P6.537 — the operator's model price table (owner decision D11 = A). Landed
  // with `f530b51df` and read from a process registry nothing set, so every
  // gateway and BYO figure still priced at zero. Registered beside the composed
  // policy because it reads the same enforced composition; a PUSH rather than a
  // provider, because `parseManagedModelPricing` also returns the rejections a
  // mistyped rate produces and those have to reach a channel once rather than
  // on every price lookup.
  registerEnforcedManagedModelPricing()
  // P6.498 — the operator's gateway-only lock, beside the price table because
  // both read the same enforced composition and both govern what a user may
  // choose rather than what a session may do.
  registerEnforcedManagedNonGatewayConnections()

  let verifiedStorageLayout: VerifiedStorageLayoutV2
  while (true) {
    const readiness = await ensureStorageLayoutV2({
      assertHeld() {
        if (!app.hasSingleInstanceLock()) throw new Error('single-instance-lock-not-held')
      },
    })
    if (readiness.status !== 'blocked') {
      verifiedStorageLayout = readiness.layout
      break
    }
    // The dialog below is this path's ONLY surface, and it produced no log line
    // at all — so a packaged launch blocked here (a config dir whose parent does
    // not exist yields `unsafe-root`, for one) looked exactly like a hang.
    bootDiagnostic(formatBootBlockedLogLine({ code: readiness.code, configDir: CONFIG_DIR }))
    const action = await showStorageReadinessBlockedDialog(readiness, {
      configDir: CONFIG_DIR,
      dialog,
      shell,
      app,
    })
    if (action === 'quit') return
  }

  // User-owned config may be read only after verified-v2 readiness.
  const persistedUiLanguage = getPersistedUiLanguage()
  if (persistedUiLanguage) await i18n.changeLanguage(persistedUiLanguage)
  mainLog.info('[i18n] startup hydration', {
    persistedUiLanguage: persistedUiLanguage ?? null,
    resolvedLanguageAfterHydration: i18n.resolvedLanguage ?? null,
  })

  // Export packaged state as env var so logger.ts (and headless Bun) don't need 'electron'.
  // Same spelling as the module-scope write near the top of this file — the two
  // must not diverge again; `__tests__/packaged-env-spelling.test.ts` pins both.
  process.env.NESSY_IS_PACKAGED = app.isPackaged ? 'true' : 'false'

  // Register bundled assets root so all seeding functions can find their files
  // (docs, permissions, themes, tool-icons resolve via getBundledAssetsDir)
  setBundledAssetsRoot(__dirname)

  // Initialize backend runtime bootstrapping (Codex vendor root, Claude SDK runtime paths).
  initializeBackendHostRuntime({
    hostRuntime: {
      appRootPath: app.isPackaged ? app.getAppPath() : process.cwd(),
      resourcesPath: process.resourcesPath,
      isPackaged: app.isPackaged,
    },
  })

  // Register PowerShell validator root so it can find the bundled parser script
  // (Windows only: checks PowerShell commands for the read-only allowlist Plan and Don't ask use, via AST analysis)
  setPowerShellValidatorRoot(join(__dirname, 'resources'))

  // Initialize bundled docs
  initializeDocs()

  // Initialize bundled release notes
  initializeReleaseNotes()

  // Ensure default permissions file exists (copies bundled default.json on first run)
  ensureDefaultPermissions()

  // Seed tool icons to ~/.nessy-agent/tool-icons/ (copies bundled SVGs on first run)
  ensureToolIcons()

  // Seed preset themes to ~/.nessy-agent/themes/ (copies bundled theme JSONs on first run)
  ensurePresetThemes()

  // Seed bundled built-in skills to ~/.nessy-agent/skills/ on first run (C1).
  // Seed-once by slug-existence: never overwrites a user-modified skill. Runs
  // before createStorageRuntime (below) so seeded skills are in the managed
  // skills root before the first capability inventory and surface immediately.
  // `settings-reference.md#disablebundledskills` — "Claude Code removes bundled
  // skills and workflows entirely" — so with the key on, nothing is seeded. The
  // already-seeded profile is handled separately, in the capability inventory:
  // a switch that only worked on a fresh profile would not be an off switch.
  ensureBundledSkills({ storedConfig: loadStoredConfig() })

  // Register thumbnail:// protocol handler (scheme was registered earlier, before app.whenReady)
  registerThumbnailHandler()

  // Re-apply proxy settings now that Electron sessions are available
  // (first call before app.whenReady only configured Node-level proxy)
  await applyConfiguredProxySettings()

  // Note: electron-updater handles pending updates internally via autoInstallOnAppQuit

  // Application menu is created after windowManager initialization (see below)

  // Dock icon on macOS, in dev AND packaged builds (no isPackaged guard): icon.png replaces the Info.plist icon
  if (process.platform === 'darwin' && app.dock) {
    // In packaged app, resources are at dist/resources/ (same level as __dirname)
    // In dev, resources are at ../resources/ (sibling of dist/)
    const dockIconPath = [
      join(__dirname, 'resources/icon.png'),
      join(__dirname, '../resources/icon.png'),
    ].find(p => existsSync(p))

    if (dockIconPath) {
      app.dock.setIcon(dockIconPath)
      // Initialize badge icon for canvas-based badge overlay
      initBadgeIcon(dockIconPath)
    }

    // Multi-instance dev: show instance number badge on dock icon
    // NESSY_INSTANCE_NUMBER is set by detect-instance.sh for numbered folders
    const instanceNum = process.env.NESSY_INSTANCE_NUMBER
    if (instanceNum) {
      const num = parseInt(instanceNum, 10)
      if (!isNaN(num) && num > 0) {
        initInstanceBadge(num)
      }
    }
  }

  try {
    // Initialize window manager
    windowManager = new WindowManager()

    // Create the application menu (needs windowManager for New Window action)
    createApplicationMenu(windowManager)

    // When NESSY_SERVER_URL is set, this Electron instance is a thin client —
    // it only creates windows whose preload connects to the remote server.
    // Skip server-side initialization (SessionManager, model refresh, platform injection).
    const isClientOnly = !!process.env.NESSY_SERVER_URL
    const isHeadless = !!process.env.NESSY_HEADLESS

    // The security approval gate for server-delivered managed settings, built
    // and installed HERE — before `bootstrapServer()` below, which runs the
    // managed-delivery lifecycle itself.
    //
    // P3.289: it used to be installed several hundred lines further down,
    // AFTER that call. `bootstrapServer` installs a `non-interactive` gate of
    // its own and then runs the fail-closed refresh, so on the desktop a
    // payload resolved in that window applied with no dialog, and
    // `server-managed-settings.md#security-approval-dialogs`'s "If a user
    // rejects the settings, Claude Code exits" branch could not fire for it —
    // a permission-shaped control whose first pass silently skipped the user.
    // Installing it before the call, and handing the same gate to bootstrap
    // through `managedDeliveryApproval`, makes the lifecycle run once under one
    // gate. `app.whenReady()` has already resolved, so `dialog` is usable.
    //
    // `setManagedDeliveryEnabled(true)` opts this process in: delivery is off
    // by default in the library so that importing auth/dp never makes an
    // unannounced request on sign-in, and the desktop shell is a host that
    // wants it. Set here for the same reason as the gate — the sign-in hook
    // must not fire before the gate exists.
    const managedDeliveryApproval = createManagedApprovalGate({
      showMessageBox: (options) => dialog.showMessageBox(options),
      // `#security-approval-dialogs` — "If a user rejects the settings, Claude
      // Code exits."
      onReject: () => { app.exit(1) },
      // `#approval-memory` — a headless run applies for that run only, records
      // no approval and writes no cache; the interactive-but-cannot-show state
      // is what the resolution falls back to when no prompt is supplied.
      mode: isHeadless ? 'non-interactive' : 'interactive',
    })
    setManagedDeliveryApproval(managedDeliveryApproval)
    setManagedDeliveryEnabled(true)

    if (isClientOnly) {
      mainLog.info(`Client-only mode: NESSY_SERVER_URL=${process.env.NESSY_SERVER_URL} (server initialization skipped)`)
    }

    // Initialize notification service (always — triggered by server push events)
    initNotificationService(windowManager)

    // Initialize browser pane manager (always — even in headless, for deps wiring)
    browserPaneManager = new BrowserPaneManager()
    browserPaneManager.setWindowManager(windowManager)
    browserPaneManager.registerToolbarIpc()
    browserPaneManager.registerCapabilityIpc()
    // P2.399 — refuse to open a pane, and close any pane already open, while the
    // managed policy disables the built-in browser. AFTER
    // `registerEnforcedManagedInAppBrowserProvider()` above: this call runs the
    // first enforcement pass synchronously.
    browserPaneManager.registerManagedPolicyEnforcement()

    // Build real PlatformServices from Electron APIs
    const platform: PlatformServices = createElectronPlatform({
      app,
      nativeImage,
      shell,
      clipboard,
      nativeTheme,
      logger: log,
      isDebugMode,
      getLogFilePath,
    })

    // Bootstrap IPC handlers — preload uses sendSync for window-local details
    ipcMain.on('__get-web-contents-id', (e) => {
      e.returnValue = e.sender.id
    })
    ipcMain.on('__get-workspace-id', (e) => {
      e.returnValue = windowManager?.getWorkspaceForWindow(e.sender.id) ?? ''
    })
    registerNessyAuthIpcHandlers()

    // Transport diagnostics bridge — preload reports remote WS connection state changes
    // so failures are visible in terminal/main.log (not only renderer console).
    ipcMain.on('__transport:status', (_event, payload: unknown) => {
      if (!payload || typeof payload !== 'object') return
      const p = payload as {
        level?: 'info' | 'warn' | 'error'
        message?: string
        status?: string
        attempt?: number
        nextRetryInMs?: number
        error?: unknown
        close?: unknown
        url?: string
      }

      const level = p.level ?? 'info'
      const message = p.message ?? '[transport] status update'
      const context = {
        status: p.status,
        attempt: p.attempt,
        nextRetryInMs: p.nextRetryInMs,
        error: p.error,
        close: p.close,
        url: p.url,
      }

      if (level === 'error') {
        mainLog.error(message, context)
      } else if (level === 'warn') {
        mainLog.warn(message, context)
      } else {
        mainLog.info(message, context)
      }
    })

    // Dialog bridge — preload capability handlers use ipcRenderer.invoke to
    // call main-process-only dialog APIs (dialog, BrowserWindow).
    ipcMain.handle('__dialog:showMessageBox', async (event, spec) => {
      const win = BrowserWindow.fromWebContents(event.sender)
        || BrowserWindow.getFocusedWindow()
        || appWindows(BrowserWindow.getAllWindows())[0]
      const result = await dialog.showMessageBox(win, spec)
      return { response: result.response }
    })
    ipcMain.handle('__dialog:showOpenDialog', async (event, spec) => {
      const win = BrowserWindow.fromWebContents(event.sender)
        || BrowserWindow.getFocusedWindow()
        || appWindows(BrowserWindow.getAllWindows())[0]
      const result = await dialog.showOpenDialog(win, spec)
      return { canceled: result.canceled, filePaths: result.filePaths }
    })
    ipcMain.handle('__dialog:saveTextFile', async (event, spec) => {
      const win = BrowserWindow.fromWebContents(event.sender)
        || BrowserWindow.getFocusedWindow()
        || appWindows(BrowserWindow.getAllWindows())[0]
      const result = await dialog.showSaveDialog(win, {
        title: typeof spec?.title === 'string' ? spec.title : undefined,
        defaultPath: typeof spec?.defaultPath === 'string' ? spec.defaultPath : undefined,
        filters: Array.isArray(spec?.filters) ? spec.filters : undefined,
      })
      if (result.canceled || !result.filePath) {
        return { canceled: true }
      }

      try {
        await writeFile(result.filePath, typeof spec?.content === 'string' ? spec.content : '', 'utf-8')
        return { canceled: false, filePath: result.filePath }
      } catch (error) {
        return {
          canceled: false,
          filePath: result.filePath,
          error: error instanceof Error ? error.message : String(error),
        }
      }
    })

    if (isClientOnly) {
      storageRuntime = await createStorageRuntime(verifiedStorageLayout, {
        dpSessionBroker,
        remoteGateway: createElectronRemoteWorkspaceGateway(),
        pluginRuntimeHost: {
          appRootPath: platform.appRootPath,
          resourcesPath: platform.resourcesPath,
          isPackaged: platform.isPackaged,
          platform: process.platform,
        },
      })
      windowManager.setWorkspaceService(storageRuntime.workspaceService)
      browserPaneManager.setWorkspaceService(storageRuntime.workspaceService)
    }

    if (!isClientOnly) {
      // Restore persisted Git Bash path on Windows (must happen before any SDK subprocess spawn)
      if (process.platform === 'win32') {
        const { getGitBashPath, clearGitBashPath } = await import('@nessy-agent/shared/config')
        const gitBashPath = getGitBashPath()
        if (gitBashPath) {
          const validation = await validateGitBashPath(gitBashPath)
          if (validation.valid) {
            process.env.CLAUDE_CODE_GIT_BASH_PATH = validation.path
          } else {
            clearGitBashPath()
            delete process.env.CLAUDE_CODE_GIT_BASH_PATH
            mainLog.warn(`Cleared invalid persisted Git Bash path: ${gitBashPath}`)
          }
        }
      }

      // Check for VC++ Redistributable on Windows (required by onnxruntime / markitdown).
      // Without it, document conversion tools (PDF, PPTX, DOCX, XLSX) crash with DLL errors.
      // Sets env var so renderer can show an actionable toast with install button.
      if (process.platform === 'win32') {
        const vcCheck = checkVCRedistInstalled()
        if (!vcCheck.installed) {
          mainLog.warn('[vcredist]', vcCheck.message)
          process.env.NESSY_VCREDIST_MISSING = '1'
          if (vcCheck.downloadUrl) {
            process.env.NESSY_VCREDIST_URL = vcCheck.downloadUrl
          }
        } else if (isDebugMode) {
          mainLog.info('[vcredist]', vcCheck.message)
        }
      }

      // Pre-import power manager (async import needed for applyPlatformToSubsystems)
      const { onSessionStarted, onSessionStopped } = await import('./power-manager')

      // Client ID tracking for Electron IPC bridge (webContentsId → clientId)
      const clientMap = new Map<number, string>()
      const resolveClientId = (wcId: number) => clientMap.get(wcId)

      // Read embedded server config (Server settings page)
      const { getServerConfig } = await import('@nessy-agent/shared/config')
      const embeddedServerConfig = getServerConfig()
      const serverModeEnabled = embeddedServerConfig.enabled && !isClientOnly

      // Derive host/port/token from server config (or env overrides)
      const serverToken = serverModeEnabled && embeddedServerConfig.token
        ? embeddedServerConfig.token
        : randomUUID()
      const rpcHost = process.env.NESSY_RPC_HOST
        ?? (serverModeEnabled ? '0.0.0.0' : '127.0.0.1')
      const rpcPort = process.env.NESSY_RPC_PORT
        ? parseInt(process.env.NESSY_RPC_PORT, 10)
        : (serverModeEnabled ? embeddedServerConfig.port : 0)

      // Load TLS certificates if configured
      let tls: import('@nessy-agent/server-core/transport').WsRpcTlsOptions | undefined
      if (serverModeEnabled && embeddedServerConfig.tlsCertPath && embeddedServerConfig.tlsKeyPath) {
        try {
          tls = {
            cert: readFileSync(embeddedServerConfig.tlsCertPath),
            key: readFileSync(embeddedServerConfig.tlsKeyPath),
          }
          mainLog.info('[server-mode] TLS enabled')
        } catch (err) {
          mainLog.error('[server-mode] Failed to load TLS certificates:', err)
        }
      }

      if (serverModeEnabled) {
        mainLog.info(`[server-mode] Enabled — binding ${rpcHost}:${rpcPort}${tls ? ' (TLS)' : ''}`)
      }

      let runtime!: StorageRuntime

      // Bootstrap only from the exact layout verified under Electron's single-instance lease.
      const instance = await bootstrapServer<SessionManager, HandlerDeps>({
        verifiedStorageLayout,
        serverToken,
        rpcHost,
        rpcPort,
        tls,
        bundledAssetsRoot: __dirname,
        serverId: 'local',
        serverVersion: app.getVersion(),
        // P3.289 — the host owns the gate, so bootstrap must not install its
        // `non-interactive` one over it.
        managedDeliveryApproval,
        platformFactory: () => platform,
        applyPlatformToSubsystems: (p) => {
          setFetcherPlatform(p)
          setSessionPlatform(p)
          setSessionRuntimeHooks({
            updateBadgeCount,
            onSessionStarted,
            onSessionStopped,
            deliverDesktopNotification,
            deliverScheduledRunNotification,
          })
          setSearchPlatform(p)
          setImageProcessor(p.imageProcessor)
        },
        createSessionManager: async (layout) => {
          runtime = await createStorageRuntime(layout, {
            dpSessionBroker,
            remoteGateway: createElectronRemoteWorkspaceGateway(),
            pluginRuntimeHost: {
              appRootPath: platform.appRootPath,
              resourcesPath: platform.resourcesPath,
              isPackaged: platform.isPackaged,
              platform: process.platform,
            },
            // Same binding the ProcessSupervisor below is given, so the startup
            // isolation probe reports what a real run would actually do.
            windowsSandboxRuntime: resolveWindowsSandboxRuntime({
              appRootPath: platform.appRootPath,
              resourcesPath: platform.resourcesPath,
              isPackaged: platform.isPackaged,
            }),
          })
          storageRuntime = runtime
          windowManager?.setWorkspaceService(runtime.workspaceService)
          browserPaneManager?.setWorkspaceService(runtime.workspaceService)
          const sm = new SessionManager(runtime.sessionStore, {
            resolver: runtime.capabilityResolver,
            workspaceService: runtime.workspaceService,
            projectHandleService: runtime.projectHandleService,
            recentProjectStore: runtime.recentProjectStore,
            workspaceQuiescence: runtime.workspaceQuiescence,
            resolveCredential: runtime.resolveRuntimeCredential,
            dpSessionBroker: runtime.dpSessionBroker,
            managedPiPolicy: runtime.managedPiPolicy,
            // D4: the boot snapshot is the seed, not the last word.
            resolveManagedPiPolicy: runtime.resolveManagedPiPolicy,
            subscribeManagedPolicyChange: runtime.subscribeManagedPolicyChange,
            piTelemetry: runtime.piTelemetry,
            usageMetrics: runtime.usageMetrics,
            pluginNodeRuntime: resolvePluginNodeRuntime({
              appRootPath: platform.appRootPath,
              resourcesPath: platform.resourcesPath,
              isPackaged: platform.isPackaged,
            }),
            windowsSandboxRuntime: resolveWindowsSandboxRuntime({
              appRootPath: platform.appRootPath,
              resourcesPath: platform.resourcesPath,
              isPackaged: platform.isPackaged,
            }),
            subscribeInvalidation: runtime.onCapabilityInvalidation,
            pluginManagementTools: {
              pluginManagement: runtime.pluginManagement,
              marketplaceService: runtime.marketplaceService,
              marketplaceProposalRegistry: runtime.marketplaceProposalRegistry,
              // R88b: cached-only catalog read, so `plugin_manage: update`
              // fetches the newer version instead of re-installing the
              // installed one.
              marketplaceCatalogReader: runtime.marketplaceRegistrySource,
            },
          })
          sm.setBrowserPaneManager(browserPaneManager!); attachPageThumbnailer(sm) // UA7.4 (defined at the file end)
          return sm
        },
        bindRpcServer: (sm, server) => sm.setRpcServer(server),
        createHandlerDeps: ({ sessionManager: sm, platform: p, oauthFlowStore: ofs }) => ({
          sessionManager: sm,
          platform: p,
          windowManager: windowManager ?? undefined,
          browserPaneManager: browserPaneManager ?? undefined,
          oauthFlowStore: ofs,
          workspaceService: runtime.workspaceService,
          pluginManagement: runtime.pluginManagement,
          pluginStore: runtime.pluginStore,
          capabilityPolicyStore: runtime.capabilityPolicyStore,
          marketplaceRegistrySource: runtime.marketplaceRegistrySource,
          capabilityTrustStore: runtime.capabilityTrustStore,
          isolationCapabilities: runtime.isolationCapabilities,
        }),
        // Headless: register only core handlers (no GUI handlers for browser, settings, etc.)
        // GUI: register all handlers (core + GUI)
        registerAllRpcHandlers: isHeadless
          ? (server, deps, serverCtx) => registerCoreRpcHandlers(server, deps, serverCtx)
          : registerAllRpcHandlers,
        setSessionEventSink: (sm, sink) => sm.setEventSink(sink),
        initializeSessionManager: (sm) => sm.initialize(),
        cleanupSessionManager: async (sm) => {
          try {
            await sm.flushAllSessions()
          } finally {
            await sm.cleanup()
            runtime.dispose()
            if (storageRuntime === runtime) storageRuntime = null
          }
        },
        initModelRefreshService: () => initModelRefreshService(async (slug: string) => {
          const { getCredentialManager } = await import('@nessy-agent/shared/credentials')
          const manager = getCredentialManager()
          const [apiKey, oauth] = await Promise.all([
            manager.getLlmApiKey(slug).catch(() => null),
            manager.getLlmOAuth(slug).catch(() => null),
          ])
          return {
            apiKey: apiKey ?? undefined,
            oauthAccessToken: oauth?.accessToken,
            oauthRefreshToken: oauth?.refreshToken,
            oauthIdToken: oauth?.idToken,
          }
        }),
        onClientConnected: ({ clientId, webContentsId }) => {
          if (webContentsId != null) clientMap.set(webContentsId, clientId)
        },
        cleanupClientResources: (clientId) => {
          for (const [wcId, cId] of clientMap) {
            if (cId === clientId) { clientMap.delete(wcId); break }
          }
          cleanupSessionFileWatchForClient(clientId)
        },
      })

      // Capture module-level references for before-quit cleanup and deep-link handlers
      sessionManager = instance.sessionManager
      oauthFlowStore = instance.oauthFlowStore

      // desktop-scheduled-tasks.md:74 — "When the app starts or your computer
      // wakes, Desktop checks whether each task missed any runs in the last
      // seven days." The app-start half runs inside each workspace's
      // AutomationSystem; `resume` is the wake half, and it is the only
      // powerMonitor listener in the tree. SessionManager debounces and the
      // persisted occurrence cursor makes a double fire impossible, so a resume
      // landing next to the aligned minute tick is safe.
      powerMonitor.on('resume', () => {
        void sessionManager?.runMissedRunSweep().catch((error) => {
          mainLog.warn('Missed-run sweep after resume failed:', error)
        })
      })
      moduleSink = instance.wsServer.push.bind(instance.wsServer)
      moduleClientResolver = resolveClientId

      // IPC handlers — preload uses sendSync to get WS connection details

      // Remove workspace from config (cleanup stale entries)
      // P6.501 — the WHOLE result, not `result.deleted`. `WorkspaceDeleteResult`
      // already carries `cleanupFailures`, and collapsing it here meant a purge
      // whose credentials or plugin-data cleanup failed reported plain success:
      // the renderer could not tell a complete removal from a partial one, and
      // the residue disclosure the delegated decision (Q-den 18, option A) chose
      // had nowhere to land.
      ipcMain.handle('workspace:remove', async (_event, workspaceId: string) => {
        return runtime.workspaceService.delete(workspaceId)
      })

      // Narrow cross-server resource import. The renderer supplies only the
      // local Workspace ID; trusted main resolves the saved credential.
      ipcMain.handle('resources:importIntoRemoteWorkspace', async (
        _event,
        targetWorkspaceId: string,
        bundle: unknown,
        mode: 'skip' | 'overwrite',
      ) => {
        const { connectToRemote } = await import('./handlers/workspace')
        const connection = await runtime.workspaceService.resolveRemoteWorkspaceConnection(targetWorkspaceId)
        const { client, error } = await connectToRemote(
          connection.url,
          connection.token,
          connection.remoteWorkspaceId,
        )
        if (!client) throw new Error(error ?? 'Connection failed')
        try {
          return await client.invoke(
            RPC_CHANNELS.resources.IMPORT,
            connection.remoteWorkspaceId,
            bundle,
            mode,
          )
        } finally {
          client.destroy()
        }
      })

      // Transfer session to another workspace — orchestrated in main process
      // so bundles move directly between owning servers; a LOCAL target imports in-process (UA1.14, v0.13.4).
      ipcMain.handle('session:transferToWorkspace', async (_event, sessionId: string, targetWorkspaceId: string, sessionIndex?: number, sessionCount?: number) => {
        const idx = sessionIndex ?? 0
        const count = sessionCount ?? 1
        const [{ connectToRemote, TRANSFER_REQUEST_TIMEOUT_MS }, { importTransferBundleLocally, resolveTransferTargetConnection }] = await Promise.all([import('./handlers/workspace'), import('./session-transfer')])
        const { CHUNKED_TRANSFER_THRESHOLD, getChunkCount, invokeChunked, prepareChunkedPayload } = await import('./chunked-rpc')

        const targetConnection = await resolveTransferTargetConnection(runtime.workspaceService, targetWorkspaceId)
        if (!sessionManager) throw new Error('Session manager not initialized')

        const sourceWorkspaceLocalId = windowManager?.getWorkspaceForWindow(_event.sender.id)
        if (!sourceWorkspaceLocalId) throw new Error('Unable to resolve source workspace for transfer')

        const sourceWorkspace = runtime.workspaceService.resolve(sourceWorkspaceLocalId)

        let bundle: any = null

        if (sourceWorkspace.config.remoteServer) {
          const sourceConnection = await runtime.workspaceService.resolveRemoteWorkspaceConnection(sourceWorkspaceLocalId)
          const { url: sourceUrl, token: sourceToken, remoteWorkspaceId: sourceRemoteWorkspaceId } = sourceConnection
          console.log(`[Transfer] Exporting remote-owned session ${sessionId} from workspace ${sourceRemoteWorkspaceId}...`)
          const { client: sourceClient, error: sourceError } = await connectToRemote(sourceUrl, sourceToken, sourceRemoteWorkspaceId, { requestTimeout: TRANSFER_REQUEST_TIMEOUT_MS })
          if (!sourceClient) throw new Error(sourceError ?? 'Connection failed to source remote server')

          try {
            bundle = await sourceClient.invoke('sessions:export', sessionId)
            if (!bundle) throw new Error(`Failed to export session ${sessionId}`)

            try {
              console.log('[Transfer] Generating conversation summary on source server...')
              const transferPayload = await sourceClient.invoke('sessions:exportRemoteTransfer', sessionId)
              if (transferPayload?.summary && bundle.session?.header) {
                ;(bundle.session.header as any).transferredSessionSummary = transferPayload.summary
                ;(bundle.session.header as any).transferredSessionSummaryApplied = false
                console.log(`[Transfer] Summary generated: ${transferPayload.summary.length} chars`)
              }
            } catch (err) {
              console.warn('[Transfer] Source-server summary generation failed:', err)
            }
          } finally {
            sourceClient.destroy()
          }
        } else {
          console.log(`[Transfer] Exporting local-owned session ${sessionId} from workspace ${sourceWorkspace.id}...`)
          bundle = await sessionManager.exportSession(sessionId, sourceWorkspace.id)
          if (!bundle) throw new Error(`Failed to export session ${sessionId}`)

          try {
            console.log('[Transfer] Generating conversation summary...')
            const transferPayload = await sessionManager.exportRemoteSessionTransfer(sessionId, sourceWorkspace.id)
            if (transferPayload?.summary && bundle.session?.header) {
              ;(bundle.session.header as any).transferredSessionSummary = transferPayload.summary
              ;(bundle.session.header as any).transferredSessionSummaryApplied = false
              console.log(`[Transfer] Summary generated: ${transferPayload.summary.length} chars`)
            }
          } catch (err) {
            console.warn('[Transfer] Summary generation failed:', err)
          }
        }

        console.log(`[Transfer] Export complete: ${bundle.session?.messages?.length ?? 0} messages, ${bundle.files?.length ?? 0} files`)
        if (!targetConnection) return await importTransferBundleLocally(sessionManager, targetWorkspaceId, bundle, { sessionIndex: idx, sessionCount: count, send: frame => _event.sender.send('transfer:progress', frame) })
        const { url, token, remoteWorkspaceId } = targetConnection
        console.log(`[Transfer] Connecting to target remote server: ${url}`)
        const { client, error } = await connectToRemote(url, token, remoteWorkspaceId, { requestTimeout: TRANSFER_REQUEST_TIMEOUT_MS })
        if (!client) throw new Error(error ?? 'Connection failed to target remote server')
        console.log('[Transfer] Connected to target remote server')

        try {
          const preparedBundle = prepareChunkedPayload(bundle)
          const payloadSize = preparedBundle.bytes.length
          const payloadMB = (payloadSize / (1024 * 1024)).toFixed(1)

          const emitProgress = (chunkSent: number, chunkTotal: number) => {
            try { _event.sender.send('transfer:progress', { sessionIndex: idx, sessionCount: count, chunkSent, chunkTotal }) } catch { /* renderer may be gone */ }
          }

          if (payloadSize < CHUNKED_TRANSFER_THRESHOLD) {
            console.log(`[Transfer] Bundle size: ${payloadMB}MB (< 5MB threshold) → using direct RPC`)
            emitProgress(0, 1)
            const result = await client.invoke('sessions:import', remoteWorkspaceId, bundle, 'fork')
            emitProgress(1, 1)
            return result
          }

          const chunkCount = getChunkCount(payloadSize)
          console.log(`[Transfer] Bundle size: ${payloadMB}MB (>= 5MB threshold) → using chunked transfer (${chunkCount} chunks)`)
          return await invokeChunked(
            client,
            'sessions:import',
            [remoteWorkspaceId, bundle, 'fork'],
            1,
            emitProgress,
            preparedBundle,
          )
        } finally {
          client.destroy()
        }
      })

      // App relaunch (for server config changes — NOT an update install).
      //
      // P6.451 — it also carries the safe-mode posture. `safeMode` is optional
      // and absent means "leave the posture alone", which is what the
      // server-settings caller has always meant; `true` enters safe mode and
      // `false` leaves it, clearing BOTH accepted spellings so a session started
      // by a wrapper that exported the Claude alias can get back out. The
      // mechanism is the ENVIRONMENT rather than a relaunch option because
      // Electron's `RelaunchOptions` has no `env` field (measured against the
      // installed typings) and because the variable is what a directly spawned
      // Pi/claude/codex child inherits — see `safe-mode-relaunch.ts`.
      ipcMain.handle('app:relaunch', (_event, options?: { safeMode?: boolean }) => {
        applySafeModeRelaunchEnv(process.env, safeModeRelaunchIntent(options?.safeMode))
        app.relaunch()
        app.exit(0)
      })

      // Language change: sync from renderer to main process, persist, and rebuild native menu.
      // Persistence here is what lets the next app launch hydrate main's i18n correctly —
      // see the `getPersistedUiLanguage()` block at the top of this file.
      ipcMain.handle('i18n:changeLanguage', async (_event, lang: unknown) => {
        const previousResolved = i18n.resolvedLanguage ?? null
        if (typeof lang !== 'string' || !SUPPORTED_LANGUAGE_CODES.includes(lang as LanguageCode)) {
          // Defense-in-depth: renderer guarantees a supported code, but if a renegade
          // caller hands us garbage we drop it silently rather than poison i18n state.
          mainLog.warn('[i18n] changeLanguage IPC rejected — unsupported code', {
            incoming: lang,
            previousResolved,
          })
          return
        }
        const code = lang as LanguageCode
        await i18n.changeLanguage(code)
        setPersistedUiLanguage(code)
        mainLog.info('[i18n] changeLanguage IPC applied', {
          incoming: code,
          previousResolved,
          newResolved: i18n.resolvedLanguage ?? null,
        })
        const { rebuildMenu } = await import('./menu')
        await rebuildMenu()
      })

      ipcMain.on('__get-ws-port', (e) => {
        e.returnValue = instance.port
      })
      ipcMain.on('__get-ws-token', (e) => {
        e.returnValue = instance.token
      })
      ipcMain.handle('__resolve-workspace-client', async (_event, localWorkspaceId: unknown) => {
        if (typeof localWorkspaceId !== 'string' || !localWorkspaceId) {
          throw new Error('Workspace connection is unavailable')
        }
        const resolved = runtime.workspaceService.resolve(localWorkspaceId)
        if (!resolved.config.remoteServer) return null
        return runtime.workspaceService.resolveRemoteWorkspaceConnection(localWorkspaceId)
      })

      // Server config RPC handlers (LOCAL_ONLY — Electron-specific)
      const runningServerState = {
        host: rpcHost,
        port: instance.port,
        tls: !!tls,
        token: serverToken,
        enabled: serverModeEnabled,
      }

      instance.wsServer.handle(RPC_CHANNELS.settings.GET_SERVER_CONFIG, async () => {
        const { getServerConfig: getConfig } = await import('@nessy-agent/shared/config')
        return getConfig()
      })

      instance.wsServer.handle(RPC_CHANNELS.settings.SET_SERVER_CONFIG, async (_ctx: unknown, config: unknown) => {
        const { setServerConfig: setConfig } = await import('@nessy-agent/shared/config')
        const cfg = config as import('@nessy-agent/shared/config/server-config').ServerConfig
        // Validate port range
        if (cfg.port < 1024 || cfg.port > 65535) {
          throw new Error(`Port must be between 1024 and 65535, got ${cfg.port}`)
        }
        // Validate cert/key files exist if provided
        if (cfg.tlsCertPath && !existsSync(cfg.tlsCertPath)) {
          throw new Error(`Certificate file not found: ${cfg.tlsCertPath}`)
        }
        if (cfg.tlsKeyPath && !existsSync(cfg.tlsKeyPath)) {
          throw new Error(`Private key file not found: ${cfg.tlsKeyPath}`)
        }
        setConfig(cfg)
      })

      instance.wsServer.handle(RPC_CHANNELS.settings.GET_SERVER_STATUS, async () => {
        const { getServerConfig: getConfig } = await import('@nessy-agent/shared/config')
        const saved = getConfig()
        const protocol = runningServerState.tls ? 'wss' : 'ws'

        // Determine display host (LAN IP if bound to 0.0.0.0)
        let displayHost = runningServerState.host
        if (displayHost === '0.0.0.0' || displayHost === '::') {
          const os = await import('os')
          const nets = os.networkInterfaces()
          for (const name of Object.keys(nets)) {
            for (const net of nets[name] ?? []) {
              if (net.family === 'IPv4' && !net.internal) {
                displayHost = net.address
                break
              }
            }
            if (displayHost !== '0.0.0.0' && displayHost !== '::') break
          }
        }

        // Only compare port/tls/token when at least one side has server mode enabled.
        // When both are disabled, the running port is random — comparing it to the
        // saved default (9100) would always produce a false "restart required" banner.
        const needsRestart = saved.enabled !== runningServerState.enabled
          || ((saved.enabled || runningServerState.enabled) && (
            saved.port !== runningServerState.port
            || (!!saved.tlsCertPath) !== runningServerState.tls
            || (saved.token ?? '') !== runningServerState.token
          ))

        return {
          running: true,
          host: runningServerState.host,
          port: runningServerState.port,
          tls: runningServerState.tls,
          url: `${protocol}://${displayHost}:${runningServerState.port}`,
          token: runningServerState.token,
          needsRestart,
          insecureWarning: isInsecureBind,
        }
      })

      // TLS enforcement — warn when server mode binds to a network address without TLS
      // Mirrors the hard guard in packages/server/src/index.ts but warns instead of blocking,
      // since the user explicitly enabled server mode via UI (may be on a trusted LAN).
      const isInsecureBind = serverModeEnabled && !tls
        && !['127.0.0.1', 'localhost', '::1'].includes(rpcHost)
      if (isInsecureBind) {
        mainLog.warn(
          '[server-mode] WARNING: Listening on a network address without TLS. ' +
          'Auth tokens will be sent in cleartext. ' +
          'Configure TLS certificates in Settings > Server.'
        )
      }

      // Wire EventSink to Electron-specific services
      // Must happen BEFORE createInitialWindows() so event handlers use WS from the start
      windowManager.setRpcEventSink(moduleSink!, resolveClientId)
      const { setMenuEventSink } = await import('./menu')
      setMenuEventSink(moduleSink!, resolveClientId)
      const { setNotificationEventSink } = await import('./notifications')
      setNotificationEventSink(moduleSink!, resolveClientId)

      // Headless: print connection details
      if (isHeadless) {
        console.log(`NESSY_SERVER_URL=${instance.protocol}://${instance.host}:${instance.port}`)
        console.log(`NESSY_SERVER_TOKEN=${instance.token}`)
      }
    }

    // `settings-reference.md#requiredminimumversion` and
    // `#requiredmaximumversion` — the admin version floor and ceiling. Out of
    // range, "Claude Code exits at startup and tells the user to update through
    // your organization's approved method". Read from the host-owned policy FILE
    // only: an admin who can pin a version can deploy that file, and reading the
    // server cache here would let a poisoned cache refuse to start the app. Both
    // fail-open rules are upstream — `managed-settings.md#keys-that-fail-closed`:
    // "`requiredMinimumVersion` and `requiredMaximumVersion` fail open by design:
    // an invalid value is dropped rather than enforced" — the parser strips an
    // invalid bound and the gate allows an unparseable running version, so this
    // can only refuse on a comparison an admin wrote.
    try {
      assertManagedVersionAllowed(loadManagedPiPolicy(), app.getVersion())
    } catch (err) {
      if (err instanceof ManagedSettingsStartupError) {
        mainLog.error('[managed-settings] version gate refused startup:', err.reason)
        dialog.showErrorBox('Unsupported Nessy Desktop version', err.message)
        app.exit(1)
        return
      }
      // P6.246(a). `loadManagedPiPolicy()` throws `managed-pi-policy-invalid`
      // when the organisation's file cannot be read, and that is a FAIL-CLOSED
      // error: until this branch it degraded to the `mainLog.warn` below, the
      // admin version floor was skipped, and startup continued — with a
      // packaged build writing nothing outside debug mode, so no operator ever
      // saw it. The composition fails closed downstream in
      // `createStorageRuntime` regardless; this makes the refusal legible and
      // names the one thing the operator can act on.
      const unreadable = managedPolicyUnreadableNotice(err)
      if (unreadable) {
        mainLog.error('[managed-settings] managed policy unreadable:', unreadable.reason)
        dialog.showErrorBox(unreadable.title, unreadable.message)
        app.exit(1)
        return
      }
      mainLog.warn('[managed-settings] version gate check error:', err)
    }

    // Server-delivered managed settings. The approval gate and the delivery
    // opt-in are installed much earlier, before `bootstrapServer()` — see the
    // comment at their site, and P3.289 for what running them after it cost.
    //
    // The three lifecycle steps below are `bootstrapServer`'s as well, so on a
    // full desktop launch they have already run and re-running them is the
    // duplicate half of P3.289 (the poll is idempotent by construction, the
    // env application is not — it would register a second listener). A
    // thin client never calls `bootstrapServer`, so there they are the ONLY
    // pass and must still run.
    //
    // The cache applies immediately (`#fetch-and-caching-behavior`) with the
    // transport, routing, credential and execution variables withheld until a
    // fetch confirms the payload; the env application re-runs on confirmation,
    // which is that section's "the withheld variables apply for the rest of the
    // session". The poll is "polls for updates hourly during active sessions":
    // the sign-in hook alone left a long-running session on the policy it
    // started with, so a deny rule an admin tightened at 09:00 reached a
    // machine that signed in at 08:00 only on the next restart. Fail-open; the
    // JWT is read per tick so a session that signs in later starts polling
    // with it.
    if (isClientOnly) {
      initializeManagedDeliveryFromCache()
      startManagedDeliveryEnvApplication()
      startManagedDeliveryPolling({ jwt: () => getValidCreds()?.jwt ?? null })
    }

    // :189 fail-closed startup. Runs BEFORE any window so "blocks at startup"
    // means what it says. `needs-authentication` deliberately does NOT exit —
    // see managed-refresh-gate.ts: exiting is what would make an expired
    // credential unrecoverable, since this app has no separate `auth` binary to
    // exempt the way :205 exempts `claude auth login`.
    let forceRefreshAwaitingSignIn = false
    const runForceRefreshGate = async (): Promise<boolean> => {
      try {
        const gate = await enforceForceRemoteSettingsRefresh({
          managedFilePolicy: loadManagedPiPolicy(),
          jwt: getValidCreds()?.jwt ?? null,
        })
        forceRefreshAwaitingSignIn = gate.outcome === 'needs-authentication'
        if (gate.outcome === 'blocked') {
          mainLog.error('[managed-settings] fail-closed startup refused:', gate.reason)
          dialog.showErrorBox('Managed settings required', gate.recovery ?? '')
          app.exit(1)
          return false
        }
        if (forceRefreshAwaitingSignIn) {
          mainLog.warn('[managed-settings] fail-closed startup awaiting gateway sign-in')
        }
      } catch (err) {
        mainLog.warn('[managed-settings] fail-closed startup check error:', err)
      }
      return true
    }
    if (!await runForceRefreshGate()) return

    // Create initial windows (restores from saved state or opens first workspace)
    // In headless mode the server runs without any UI — skip window creation.
    if (!isHeadless) {
      await createInitialWindows()

      // Gateway login check: if a Pi Nessy Gateway connection exists but the shared
      // dp JWT is unavailable even after a silent dp probe, prompt a one-click sign-in
      // via a non-blocking banner. Emits once to each window (waiting for its first
      // load so the renderer's status listener is mounted). Renderer banner UI is deferred.
      try {
        const connections = getLlmConnections()
        // This probe is our shape of the exemption in
        // `server-managed-settings.md#enforce-fail-closed-startup`: "The `claude
        // auth` subcommands such as `claude auth login` are exempt from this
        // check and from the gateway startup exit, so users can re-authenticate
        // when expired credentials are the reason the settings fetch fails." It
        // is the entry point that OBTAINS credentials, so it must run even when
        // the fail-closed gate is awaiting a sign-in. Gating it would deadlock:
        // the fetch needs a JWT the probe is here to get.
        const hasValidGatewayCreds = await ensureGatewayAuthForLaunch({
          connections,
          hasValidCreds: getValidCreds() !== null,
        })

        // Credentials just arrived, so the gate that could not make a request
        // now can. This is the recovery path that keeps an expired credential
        // from becoming a lockout.
        if (forceRefreshAwaitingSignIn && hasValidGatewayCreds) {
          if (!await runForceRefreshGate()) return
        }

        // DA1.31 — no `gatewayBaseUrl` any more: both helpers read the one
        // exported `isGatewayBackedConnection`, so the main process no longer
        // supplies (or imports from the renderer) its own copy of the boundary.
        runGatewayLoginCheck({
          connections,
          hasValidCreds: hasValidGatewayCreds,
          broadcast: (status) => {
            for (const win of appWindows(BrowserWindow.getAllWindows())) {
              const wc = win.webContents
              if (wc.isLoading()) {
                wc.once('did-finish-load', () => wc.send(NESSY_GATEWAY_AUTH_STATUS_CHANNEL, status))
              } else {
                wc.send(NESSY_GATEWAY_AUTH_STATUS_CHANNEL, status)
              }
            }
          },
        })
      } catch (err) {
        mainLog.warn('Gateway login check error:', err)
      }
    }

    // Run credential health check at startup to detect issues early
    // (corruption, machine migration, missing credentials for default connection)
    // Skip in thin-client mode — credentials are managed by the remote server.
    if (!isClientOnly) {
      try {
        const { getCredentialManager } = await import('@nessy-agent/shared/credentials')
        const credentialManager = getCredentialManager()
        const health = await credentialManager.checkHealth()
        if (!health.healthy) {
          mainLog.warn('Credential health check failed:', health.issues)
          // Issues will be displayed in Settings → AI when user navigates there
        }
      } catch (err) {
        mainLog.error('Credential health check error:', err)
      }
    }

    // Initialize power manager (loads setting, must happen after config is available)
    // Non-critical — powerSaveBlocker may not work on headless/xvfb setups
    try {
      const { initPowerManager } = await import('./power-manager')
      await initPowerManager()
    } catch (err) {
      mainLog.warn('[power] Power manager init failed (non-critical):', err instanceof Error ? err.message : err)
    }

    // Initialize auto-update (check immediately on launch)
    // Skip in dev mode to avoid replacing /Applications app and launching it instead
    if (moduleSink) setAutoUpdateEventSink(moduleSink)
    // Snapshot multi-window state BEFORE quitAndInstall. electron-updater
    // (Squirrel.Mac) destroys BrowserWindows between quitAndInstall and
    // before-quit firing; saving from before-quit alone would overwrite
    // window-state.json with an empty array.
    setBeforeUpdateQuitHook(() => captureAndSaveWindowState('pre-update'))
    if (app.isPackaged) {
      checkForUpdatesOnLaunch().catch(err => {
        mainLog.error('[auto-update] Launch check failed:', err)
      })
    } else {
      mainLog.info('[auto-update] Skipping auto-update in dev mode')
    }

    // Process pending deep link from cold start
    if (pendingDeepLink) {
      mainLog.info('Processing pending deep link:', pendingDeepLink)
      await handleDeepLink(pendingDeepLink, windowManager, 'external', moduleSink ?? undefined, moduleClientResolver ?? undefined)
      pendingDeepLink = null
    }

    mainLog.info('App initialized successfully')
    if (isDebugMode) {
      mainLog.info('Debug mode enabled - logs at:', getLogFilePath())
    }
  } catch (error) {
    mainLog.error('Failed to initialize app:', error instanceof Error ? error.message : error, (error as any)?.stack)
    // `app.quit()` alone exits 0 and, in a packaged build, logs nothing — a
    // failed startup was indistinguishable from a normal one. Windowless
    // failures now name themselves and exit 1; once a window exists the old
    // quit is still the right ending.
    if (!reportBootFatalIfWindowless('app-initialization', error)) app.quit()
    return
  }

  bootCompleted = true

  // macOS: Re-create window when dock icon is clicked
  app.on('activate', async () => {
    if (appWindows(BrowserWindow.getAllWindows()).length === 0 && windowManager && storageRuntime) {
      // Open first workspace or last focused
      const workspaces = await storageRuntime.workspaceService.list()
      if (workspaces.length > 0) {
        const savedState = loadWindowState()
        const wsId = savedState?.lastFocusedWorkspaceId || workspaces[0].id
        // Verify workspace still exists
        if (workspaces.some(ws => ws.id === wsId)) {
          windowManager.createWindow({ workspaceId: wsId })
        } else {
          windowManager.createWindow({ workspaceId: workspaces[0].id })
        }
      }
    }
  })
})

// The line that turns a failed startup into an exit instead of a hang. The
// callback above is async and nothing awaited it, so before T10 a rejection
// went only to `process.on('unhandledRejection')` below — which logs (nowhere,
// in a packaged build) and returns, leaving a process with no window that
// `window-all-closed` will never quit.
bootPromise.catch(error => {
  mainLog.error('Startup failed:', error)
  reportBootFatalIfWindowless('app-startup', error)
})

app.on('window-all-closed', () => {
  if (process.env.NESSY_HEADLESS) return  // headless server stays alive
  // On macOS, apps typically stay active until explicitly quit
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

// Track if we're in the process of quitting (to avoid re-entry)
let isQuitting = false

/**
 * Capture the current multi-window state and persist it to disk.
 * Called from two sites:
 *   - before-quit (normal quit path, reason='before-quit')
 *   - installUpdate hook (auto-update path, reason='pre-update'), because
 *     electron-updater destroys BrowserWindows between quitAndInstall and
 *     before-quit firing — by the time before-quit runs, getWindowStates()
 *     returns an empty array and would clobber the on-disk state.
 * Returns the number of windows saved, or -1 if windowManager isn't ready.
 */
function captureAndSaveWindowState(reason: 'before-quit' | 'pre-update'): number {
  if (!windowManager) return -1
  const windows = windowManager.getWindowStates()
  const focusedWindow = BrowserWindow.getFocusedWindow()
  const lastFocusedWorkspaceId = focusedWindow
    ? windowManager.getWorkspaceForWindow(focusedWindow.webContents.id) ?? undefined
    : undefined
  saveWindowState({ windows, lastFocusedWorkspaceId })
  mainLog.info('[window-state] saved', { windowCount: windows.length, reason })
  return windows.length
}

// Save window state and clean up resources before quitting
app.on('before-quit', async (event) => {
  // Avoid re-entry when we call app.exit()
  if (isQuitting) return
  isQuitting = true

  // Ensure Cmd+Q/app quit bypasses layered window close interception (Cmd+W behavior).
  windowManager?.setAppQuitting(true)

  if (windowManager) {
    const windows = windowManager.getWindowStates()
    // Empty-snapshot guard: during update-quit, electron-updater has already
    // destroyed all BrowserWindows by the time before-quit fires. The pre-update
    // hook already saved the real state — don't let this late save overwrite it.
    if (windows.length === 0 && isUpdating()) {
      mainLog.warn('[window-state] skip save: empty snapshot during update-quit (pre-update snapshot wins)')
    } else {
      captureAndSaveWindowState('before-quit')
    }
    // Diagnostic correlation with installUpdate's [update-flow] log. During an
    // update-quit, record it to the dedicated always-on auto-update log (#891)
    // so the install/quit handoff is diagnosable in production; normal quits
    // stay on the debug-only main log.
    const isUpdateQuit = isUpdating()
    const beforeQuitSave = {
      windowCount: windows.length,
      electronWindowCount: BrowserWindow.getAllWindows().length,
      isUpdating: isUpdateQuit,
      reason: isUpdateQuit ? 'update-quit' : 'user-quit',
    }
    if (isUpdateQuit) {
      autoUpdateLog.info('before-quit save', beforeQuitSave)
    } else {
      mainLog.info('[update-flow] before-quit save', beforeQuitSave)
    }
  }

  // Flush all pending session writes before quitting
  if (sessionManager) {
    // Prevent quit until sessions are flushed
    event.preventDefault()
    try {
      await sessionManager.flushAllSessions()
      mainLog.info('Flushed all pending session writes')
    } catch (error) {
      mainLog.error('Failed to flush sessions:', error)
    }

    // Everything from here to the quit is BEST EFFORT. It used to be
    // unguarded, and a throw in any of these steps aborted the handler before
    // any quit call at all: the app sat half-shut-down, and an update that was
    // mid-handoff stayed downloaded and never installed. `finalizeQuit` below
    // runs whatever happens here — see `quit-finalizer.ts`.
    let cleanupError: unknown
    try {
      // Clean up SessionManager resources (file watchers, timers, etc.)
      await sessionManager.cleanup()
      storageRuntime?.dispose()
      storageRuntime = null
      dpSessionBroker.dispose()

      // Clean up browser pane instances
      if (browserPaneManager) {
        browserPaneManager.destroyAll()
      }

      // Clean up OAuth flow store (stop periodic cleanup timer)
      if (oauthFlowStore) {
        oauthFlowStore.dispose()
      }

      // Stop all model refresh timers
      getModelRefreshService().stopAll()

      // Clean up power manager (release power blocker)
      const { cleanup: cleanupPowerManager } = await import('./power-manager')
      cleanupPowerManager()

      // Release the server lock file so the next launch doesn't see a stale PID.
      // This must happen regardless of the exit path (normal quit or update quit).
      releaseServerLock()
    } catch (error) {
      cleanupError = error
    }

    finalizeQuit(
      { isUpdating: isUpdating(), ...(cleanupError === undefined ? {} : { cleanupError }) },
      {
        quit: () => app.quit(),
        exit: (code: number) => app.exit(code),
        relaunch: () => app.relaunch(),
        schedule: (fn, ms) => setTimeout(fn, ms),
        log: (message, detail) => {
          if (detail === undefined) autoUpdateLog.info(message)
          else autoUpdateLog.error(message, detail)
        },
      },
    )
    return
  } else {
    storageRuntime?.dispose()
    storageRuntime = null
    dpSessionBroker.dispose()
  }
})

// Handle uncaught exceptions with local logging.
//
// While startup is still in flight these ALSO write the always-on boot
// diagnostic, because `mainLog` is the transport that is off in a packaged
// build. They deliberately do not exit: the boot promise's own `.catch` above
// is the exact signal for "startup failed", and escalating every stray
// boot-phase rejection would kill launches that were about to succeed.
process.on('uncaughtException', (error) => {
  mainLog.error('Uncaught exception:', error)
  if (!bootCompleted) {
    bootDiagnostic(formatBootFatalLogLine({ phase: 'uncaught-exception', configDir: CONFIG_DIR, error }))
  }
})

process.on('unhandledRejection', (reason, promise) => {
  mainLog.error('Unhandled rejection at:', promise, 'reason:', reason)
  if (!bootCompleted) {
    bootDiagnostic(formatBootFatalLogLine({ phase: 'unhandled-rejection', configDir: CONFIG_DIR, error: reason }))
  }
})

// UA12.1 — the host-approvals ledger key is sealed by the OS secret store
// (safeStorage) on the desktop; the headless server keeps the credential-store
// key. Lazy: nothing is read or minted until a reader asks for the key.
import { installElectronHostApprovalsKeyProvider } from './host-approvals-key'
installElectronHostApprovalsKeyProvider()

// UA7.4 — page posters (v0.13.4 `createSessionManager`, Apache-2.0): offscreen capture is Electron-main-only, in
// the hardened window of `page-thumbnailer.ts`. On capture, nudge the watcher so the pages:changed push carries the
// fresh thumbnail pointer to open grids (ours keys the watcher by workspace id; upstream passed the root path).
// Appended below the highest line the docs cite (1564), so no anchor moves; import declarations are hoisted.
import { session as electronSession } from 'electron'
import { PageThumbnailer, abortCaptureWhenLastAppWindowCloses } from './page-thumbnailer'
// UA12.80 — the main-process consumers above that mean "the app's windows" leave the capture window out.
import { appWindows } from './app-windows'
function attachPageThumbnailer(sm: SessionManager): void {
  const pageThumbnailer = new PageThumbnailer({
    electron: {
      createWindow: options => new BrowserWindow(options),
      fromPartition: partition => electronSession.fromPartition(partition),
    },
    log: (m) => mainLog.info(m),
    onCaptured: ({ workspaceId, slug }) => {
      sm.notifyConfigFileChange(workspaceId, `pages/${slug}/page.json`)
    },
  })
  sm.setPageThumbnailer((req) => pageThumbnailer.enqueue(req))
  // UA12.193 — the last app window closing ends an in-flight capture at once where that closing quits the app: the
  // `window-all-closed` handler above (`app.quit()` off macOS, never headless). Electron counts the capture window.
  abortCaptureWhenLastAppWindowCloses(pageThumbnailer, {
    onWindowCreated: listener => { app.on('browser-window-created', (_event, win) => listener(win)) },
    allWindows: () => appWindows(BrowserWindow.getAllWindows()),
  }, process.platform !== 'darwin' && !process.env.NESSY_HEADLESS)
}
