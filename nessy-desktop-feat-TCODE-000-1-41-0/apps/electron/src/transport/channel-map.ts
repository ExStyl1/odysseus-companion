/**
 * Channel map — maps ElectronAPI method names to IPC channels.
 *
 * Derived from preload/index.ts. This is the single source of truth for
 * the method→channel mapping used by buildClientApi().
 */

import { RPC_CHANNELS } from '../shared/types'
import type { ChannelMap } from './build-api'

function invoke(channel: string, transform?: (result: any) => any) {
  return { type: 'invoke' as const, channel, ...(transform && { transform }) }
}

function listener(channel: string) {
  return { type: 'listener' as const, channel }
}

export const CHANNEL_MAP = {
  // Session management
  getSessions: invoke(RPC_CHANNELS.sessions.GET),
  getUnreadSummary: invoke(RPC_CHANNELS.sessions.GET_UNREAD_SUMMARY),
  markAllSessionsRead: invoke(RPC_CHANNELS.sessions.MARK_ALL_READ),
  getSessionMessages: invoke(RPC_CHANNELS.sessions.GET_MESSAGES),
  createSession: invoke(RPC_CHANNELS.sessions.CREATE),
  deleteSession: invoke(RPC_CHANNELS.sessions.DELETE),
  sendMessage: invoke(RPC_CHANNELS.sessions.SEND_MESSAGE),
  cancelProcessing: invoke(RPC_CHANNELS.sessions.CANCEL),
  fuzzyFileSearch: invoke(RPC_CHANNELS.sessions.FUZZY_FILE_SEARCH),
  queueGet: invoke(RPC_CHANNELS.sessions.QUEUE_GET),
  queueDelete: invoke(RPC_CHANNELS.sessions.QUEUE_DELETE),
  queueReorder: invoke(RPC_CHANNELS.sessions.QUEUE_REORDER),
  queueSendNow: invoke(RPC_CHANNELS.sessions.QUEUE_SEND_NOW),
  queueResume: invoke(RPC_CHANNELS.sessions.QUEUE_RESUME),
  gitBranches: invoke(RPC_CHANNELS.sessions.GIT_BRANCHES),
  gitCheckout: invoke(RPC_CHANNELS.sessions.GIT_CHECKOUT),
  killShell: invoke(RPC_CHANNELS.sessions.KILL_SHELL),
  stopAgentTask: invoke(RPC_CHANNELS.sessions.STOP_AGENT_TASK),
  readBackgroundTaskOutput: invoke(RPC_CHANNELS.sessions.READ_TASK_OUTPUT),
  getTaskOutput: invoke(RPC_CHANNELS.tasks.GET_OUTPUT),
  respondToPermission: invoke(RPC_CHANNELS.sessions.RESPOND_TO_PERMISSION),
  revokeFilesystemRoot: invoke(RPC_CHANNELS.sessions.REVOKE_FILESYSTEM_ROOT),
  respondToCredential: invoke(RPC_CHANNELS.sessions.RESPOND_TO_CREDENTIAL),
  sessionCommand: invoke(RPC_CHANNELS.sessions.COMMAND),
  exportSession: invoke(RPC_CHANNELS.sessions.EXPORT),
  importSession: invoke(RPC_CHANNELS.sessions.IMPORT),
  exportRemoteSessionTransfer: invoke(RPC_CHANNELS.sessions.EXPORT_REMOTE_TRANSFER),
  importRemoteSessionTransfer: invoke(RPC_CHANNELS.sessions.IMPORT_REMOTE_TRANSFER),
  getPendingPlanExecution: invoke(RPC_CHANNELS.sessions.GET_PENDING_PLAN_EXECUTION),
  getSessionPermissionModeState: invoke(RPC_CHANNELS.sessions.GET_PERMISSION_MODE_STATE),
  getSessionCapabilityInventory: invoke(RPC_CHANNELS.sessions.GET_CAPABILITY_INVENTORY),
  listSessionScheduledWork: invoke(RPC_CHANNELS.sessions.LIST_SCHEDULED_WORK),
  reconnectSessionMcpServer: invoke(RPC_CHANNELS.sessions.RECONNECT_MCP_SERVER),
  getSessionMcpServerStatuses: invoke(RPC_CHANNELS.sessions.GET_MCP_SERVER_STATUSES),
  saveSessionWorkflowRecipe: invoke(RPC_CHANNELS.sessions.SAVE_WORKFLOW_RECIPE),

  // Event listeners
  onSessionEvent: listener(RPC_CHANNELS.sessions.EVENT),
  onUnreadSummaryChanged: listener(RPC_CHANNELS.sessions.UNREAD_SUMMARY_CHANGED),

  // Transport reliability
  onReconnected: listener('__transport:reconnected'),

  // Workspace management
  getWorkspaces: invoke(RPC_CHANNELS.workspaces.GET),
  createWorkspace: invoke(RPC_CHANNELS.workspaces.CREATE),
  connectRemoteWorkspace: invoke(RPC_CHANNELS.workspaces.CONNECT_REMOTE),
  updateRemoteWorkspace: invoke(RPC_CHANNELS.workspaces.UPDATE_REMOTE),
  createWorkspaceOnRemote: invoke(RPC_CHANNELS.workspaces.CREATE_ON_REMOTE),
  testRemoteConnection: invoke(RPC_CHANNELS.remote.TEST_CONNECTION),

  // Project selection/trust — all renderer mutations use opaque handles.
  pickLocalProjectDirectory: invoke(RPC_CHANNELS.projects.PICK_LOCAL_DIRECTORY),
  validateProjectDirectory: invoke(RPC_CHANNELS.projects.VALIDATE_DIRECTORY),
  listRecentProjects: invoke(RPC_CHANNELS.projects.LIST_RECENT),
  issueRecentProjectHandle: invoke(RPC_CHANNELS.projects.ISSUE_RECENT_HANDLE),
  setProjectTrust: invoke(RPC_CHANNELS.projects.SET_TRUST),
  setSessionProject: invoke(RPC_CHANNELS.projects.SET_SESSION_PROJECT),
  setWorkspaceDefaultProject: invoke(RPC_CHANNELS.projects.SET_WORKSPACE_DEFAULT),

  // Server-level workspace operations (REMOTE_ELIGIBLE)
  getServerWorkspaces: invoke(RPC_CHANNELS.server.GET_WORKSPACES),
  createServerWorkspace: invoke(RPC_CHANNELS.server.CREATE_WORKSPACE),

  // Window management
  getWindowWorkspace: invoke(RPC_CHANNELS.window.GET_WORKSPACE),
  getWindowMode: invoke(RPC_CHANNELS.window.GET_MODE),
  openWorkspace: invoke(RPC_CHANNELS.window.OPEN_WORKSPACE),
  openSessionInNewWindow: invoke(RPC_CHANNELS.window.OPEN_SESSION_IN_NEW_WINDOW),
  switchWorkspace: invoke(RPC_CHANNELS.window.SWITCH_WORKSPACE),
  closeWindow: invoke(RPC_CHANNELS.window.CLOSE),
  confirmCloseWindow: invoke(RPC_CHANNELS.window.CONFIRM_CLOSE),
  cancelCloseWindow: invoke(RPC_CHANNELS.window.CANCEL_CLOSE),
  onCloseRequested: listener(RPC_CHANNELS.window.CLOSE_REQUESTED),
  setTrafficLightsVisible: invoke(RPC_CHANNELS.window.SET_TRAFFIC_LIGHTS),

  // File operations
  readFile: invoke(RPC_CHANNELS.file.READ),
  readFileDataUrl: invoke(RPC_CHANNELS.file.READ_DATA_URL),
  readFilePreviewDataUrl: invoke(RPC_CHANNELS.file.READ_PREVIEW_DATA_URL),
  readFileBinary: invoke(RPC_CHANNELS.file.READ_BINARY),
  openFileDialog: invoke(RPC_CHANNELS.file.OPEN_DIALOG),
  readFileAttachment: invoke(RPC_CHANNELS.file.READ_ATTACHMENT),
  readUserAttachment: invoke(RPC_CHANNELS.file.READ_USER_ATTACHMENT),
  storeAttachment: invoke(RPC_CHANNELS.file.STORE_ATTACHMENT),
  generateThumbnail: invoke(RPC_CHANNELS.file.GENERATE_THUMBNAIL),

  // Theme
  getSystemTheme: invoke(RPC_CHANNELS.theme.GET_SYSTEM_PREFERENCE),
  onSystemThemeChange: listener(RPC_CHANNELS.theme.SYSTEM_CHANGED),

  // System
  getVersions: invoke(RPC_CHANNELS.system.VERSIONS),
  getHomeDir: invoke(RPC_CHANNELS.system.HOME_DIR),
  isDebugMode: invoke(RPC_CHANNELS.system.IS_DEBUG_MODE),

  // Auto-update
  checkForUpdates: invoke(RPC_CHANNELS.update.CHECK),
  getUpdateInfo: invoke(RPC_CHANNELS.update.GET_INFO),
  installUpdate: invoke(RPC_CHANNELS.update.INSTALL),
  dismissUpdate: invoke(RPC_CHANNELS.update.DISMISS),
  getDismissedUpdateVersion: invoke(RPC_CHANNELS.update.GET_DISMISSED),
  onUpdateAvailable: listener(RPC_CHANNELS.update.AVAILABLE),
  onUpdateDownloadProgress: listener(RPC_CHANNELS.update.DOWNLOAD_PROGRESS),

  // Release notes
  getReleaseNotes: invoke(RPC_CHANNELS.releaseNotes.GET),
  getLatestReleaseVersion: invoke(RPC_CHANNELS.releaseNotes.GET_LATEST_VERSION),

  // Shell operations
  openUrl: invoke(RPC_CHANNELS.shell.OPEN_URL),
  openFile: invoke(RPC_CHANNELS.shell.OPEN_FILE),
  showInFolder: invoke(RPC_CHANNELS.shell.SHOW_IN_FOLDER),

  // Menu event listeners
  onMenuNewChat: listener(RPC_CHANNELS.menu.NEW_CHAT),
  onMenuOpenSettings: listener(RPC_CHANNELS.menu.OPEN_SETTINGS),
  onMenuKeyboardShortcuts: listener(RPC_CHANNELS.menu.KEYBOARD_SHORTCUTS),
  onMenuToggleFocusMode: listener(RPC_CHANNELS.menu.TOGGLE_FOCUS_MODE),
  onMenuToggleSidebar: listener(RPC_CHANNELS.menu.TOGGLE_SIDEBAR),

  // Deep link
  onDeepLinkNavigate: listener(RPC_CHANNELS.deeplink.NAVIGATE),

  // Auth
  showLogoutConfirmation: invoke(RPC_CHANNELS.auth.SHOW_LOGOUT_CONFIRMATION),
  showDeleteSessionConfirmation: invoke(RPC_CHANNELS.auth.SHOW_DELETE_SESSION_CONFIRMATION),
  logout: invoke(RPC_CHANNELS.auth.LOGOUT),
  getCredentialHealth: invoke(RPC_CHANNELS.credentials.HEALTH_CHECK),

  // Onboarding
  getAuthState: invoke(RPC_CHANNELS.onboarding.GET_AUTH_STATE),
  getSetupNeeds: invoke(RPC_CHANNELS.onboarding.GET_AUTH_STATE, r => r.setupNeeds),
  startWorkspaceMcpOAuth: invoke(RPC_CHANNELS.onboarding.START_MCP_OAUTH),
  startClaudeOAuth: invoke(RPC_CHANNELS.onboarding.START_CLAUDE_OAUTH),
  exchangeClaudeCode: invoke(RPC_CHANNELS.onboarding.EXCHANGE_CLAUDE_CODE),
  hasClaudeOAuthState: invoke(RPC_CHANNELS.onboarding.HAS_CLAUDE_OAUTH_STATE),
  clearClaudeOAuthState: invoke(RPC_CHANNELS.onboarding.CLEAR_CLAUDE_OAUTH_STATE),
  deferSetup: invoke(RPC_CHANNELS.onboarding.DEFER_SETUP),

  // ChatGPT OAuth
  startChatGptOAuth: invoke(RPC_CHANNELS.chatgpt.START_OAUTH),
  cancelChatGptOAuth: invoke(RPC_CHANNELS.chatgpt.CANCEL_OAUTH),
  getChatGptAuthStatus: invoke(RPC_CHANNELS.chatgpt.GET_AUTH_STATUS),
  chatGptLogout: invoke(RPC_CHANNELS.chatgpt.LOGOUT),

  // Server info (REMOTE_ELIGIBLE)
  getServerHomeDir: invoke(RPC_CHANNELS.server.HOME_DIR),

  // Server mode configuration
  getServerConfig: invoke(RPC_CHANNELS.settings.GET_SERVER_CONFIG),
  setServerConfig: invoke(RPC_CHANNELS.settings.SET_SERVER_CONFIG),
  getServerStatus: invoke(RPC_CHANNELS.settings.GET_SERVER_STATUS),

  // Settings - API Setup
  setupLlmConnection: invoke(RPC_CHANNELS.settings.SETUP_LLM_CONNECTION),
  testLlmConnectionSetup: invoke(RPC_CHANNELS.settings.TEST_LLM_CONNECTION_SETUP),
  getDefaultThinkingLevel: invoke(RPC_CHANNELS.settings.GET_DEFAULT_THINKING_LEVEL),
  setDefaultThinkingLevel: invoke(RPC_CHANNELS.settings.SET_DEFAULT_THINKING_LEVEL),
  getOutputStyle: invoke(RPC_CHANNELS.settings.GET_OUTPUT_STYLE),
  setOutputStyle: invoke(RPC_CHANNELS.settings.SET_OUTPUT_STYLE),
  listOutputStyles: invoke(RPC_CHANNELS.settings.LIST_OUTPUT_STYLES),
  getNetworkProxySettings: invoke(RPC_CHANNELS.settings.GET_NETWORK_PROXY),
  setNetworkProxySettings: invoke(RPC_CHANNELS.settings.SET_NETWORK_PROXY),

  // Pi provider discovery
  getPiApiKeyProviders: invoke(RPC_CHANNELS.pi.GET_API_KEY_PROVIDERS),
  getPiProviderBaseUrl: invoke(RPC_CHANNELS.pi.GET_PROVIDER_BASE_URL),
  getPiProviderModels: invoke(RPC_CHANNELS.pi.GET_PROVIDER_MODELS),

  // Session-specific model
  getSessionModel: invoke(RPC_CHANNELS.sessions.GET_MODEL),
  getSessionRecentStderr: invoke(RPC_CHANNELS.sessions.GET_RECENT_STDERR),

  // P6.510 — the per-session channel grant, beside the app-wide preference the
  // permissions page already writes.
  armSessionChannelSources: invoke(RPC_CHANNELS.permissions.ARM_SESSION_CHANNEL_SOURCES),
  disarmSessionChannelSources: invoke(RPC_CHANNELS.permissions.DISARM_SESSION_CHANNEL_SOURCES),

  // P6.361 — a project's saved commands, listed and launched.
  listWorkspaceActions: invoke(RPC_CHANNELS.workspaceActions.LIST),
  runWorkspaceAction: invoke(RPC_CHANNELS.workspaceActions.RUN),

  // P6.703 — the per-chat memory scope.
  getSessionMemoryScope: invoke(RPC_CHANNELS.sessions.GET_MEMORY_SCOPE),
  setSessionMemoryScope: invoke(RPC_CHANNELS.sessions.SET_MEMORY_SCOPE),

  // P6.209 (A42) — the session's own judge refusals, read-only.
  getAutoModeDenials: invoke(RPC_CHANNELS.permissions.GET_AUTO_MODE_DENIALS),
  setSessionModel: invoke(RPC_CHANNELS.sessions.SET_MODEL),

  // Workspace Settings
  getWorkspaceSettings: invoke(RPC_CHANNELS.workspace.SETTINGS_GET),
  updateWorkspaceSetting: invoke(RPC_CHANNELS.workspace.SETTINGS_UPDATE),
  listCustomSlashCommands: invoke(RPC_CHANNELS.workspace.LIST_CUSTOM_SLASH_COMMANDS),

  // Folder dialog
  openFolderDialog: invoke(RPC_CHANNELS.dialog.OPEN_FOLDER),

  // Filesystem search
  searchFiles: invoke(RPC_CHANNELS.fs.SEARCH),

  // Server filesystem browsing (remote mode)
  listServerDirectory: invoke(RPC_CHANNELS.fs.LIST_DIRECTORY),

  // Debug logging
  debugLog: invoke(RPC_CHANNELS.debug.LOG),

  // User Preferences
  readPreferences: invoke(RPC_CHANNELS.preferences.READ),
  writePreferences: invoke(RPC_CHANNELS.preferences.WRITE),

  // Plugins
  'plugin.manage': invoke(RPC_CHANNELS.plugins.MANAGE),

  // Marketplace
  'marketplace.list': invoke(RPC_CHANNELS.marketplace.LIST),
  'marketplace.content': invoke(RPC_CHANNELS.marketplace.CONTENT),
  'marketplace.components': invoke(RPC_CHANNELS.marketplace.COMPONENTS),
  'marketplace.proposeInstall': invoke(RPC_CHANNELS.marketplace.PROPOSE_INSTALL),
  'marketplace.proposeMcpb': invoke(RPC_CHANNELS.marketplace.PROPOSE_MCPB),
  'marketplace.install': invoke(RPC_CHANNELS.marketplace.INSTALL),
  'marketplace.addRegistry': invoke(RPC_CHANNELS.marketplace.ADD_REGISTRY),
  'marketplace.upgradeRegistry': invoke(RPC_CHANNELS.marketplace.UPGRADE_REGISTRY),
  'marketplace.removeRegistry': invoke(RPC_CHANNELS.marketplace.REMOVE_REGISTRY),
  'marketplace.listRegistries': invoke(RPC_CHANNELS.marketplace.LIST_REGISTRIES),
  'marketplace.setRegistryAutoUpdate': invoke(RPC_CHANNELS.marketplace.SET_REGISTRY_AUTO_UPDATE),
  'marketplace.enableOffer': invoke(RPC_CHANNELS.marketplace.ENABLE_OFFER),
  'marketplace.refreshRuntime': invoke(RPC_CHANNELS.marketplace.REFRESH_RUNTIME),

  // Unified safe capability snapshot
  'capabilities.getCatalog': invoke(RPC_CHANNELS.capabilities.GET_CATALOG),
  'capabilities.getComposerCatalog': invoke(RPC_CHANNELS.capabilities.GET_COMPOSER_CATALOG),
  'capabilities.getDetail': invoke(RPC_CHANNELS.capabilities.GET_DETAIL),
  'capabilities.listMcpTools': invoke(RPC_CHANNELS.capabilities.LIST_MCP_TOOLS),
  'capabilities.preview': invoke(RPC_CHANNELS.capabilities.PREVIEW),
  'capabilities.summary': invoke(RPC_CHANNELS.capabilities.SUMMARY),
  'capabilities.open': invoke(RPC_CHANNELS.capabilities.OPEN),
  'capabilities.reveal': invoke(RPC_CHANNELS.capabilities.REVEAL),
  'capabilities.submitManagedEdit': invoke(RPC_CHANNELS.capabilities.SUBMIT_MANAGED_EDIT),
  'capabilities.onChanged': listener(RPC_CHANNELS.capabilities.CHANGED),
  'capabilities.listTrustReviews': invoke(RPC_CHANNELS.capabilities.LIST_TRUST_REVIEWS),
  'capabilities.grantTrust': invoke(RPC_CHANNELS.capabilities.GRANT_TRUST),
  'capabilities.revokeTrust': invoke(RPC_CHANNELS.capabilities.REVOKE_TRUST),
  'capabilities.detectProjectContributions': invoke(RPC_CHANNELS.capabilities.DETECT_PROJECT_CONTRIBUTIONS),

  // Session Drafts
  getDraft: invoke(RPC_CHANNELS.drafts.GET),
  setDraft: invoke(RPC_CHANNELS.drafts.SET),
  deleteDraft: invoke(RPC_CHANNELS.drafts.DELETE),
  getAllDrafts: invoke(RPC_CHANNELS.drafts.GET_ALL),

  // Session Info Panel
  getSessionFiles: invoke(RPC_CHANNELS.sessions.GET_FILES),
  openSessionFile: invoke(RPC_CHANNELS.sessions.OPEN_FILE),
  previewSessionFile: invoke(RPC_CHANNELS.sessions.PREVIEW_FILE),
  openSessionAttachment: invoke(RPC_CHANNELS.sessions.OPEN_ATTACHMENT),
  revealSessionStorage: invoke(RPC_CHANNELS.sessions.REVEAL_STORAGE),
  copySessionStoragePath: invoke(RPC_CHANNELS.sessions.COPY_STORAGE_PATH),
  openSessionArtifact: invoke(RPC_CHANNELS.sessions.OPEN_ARTIFACT),
  getSessionNotes: invoke(RPC_CHANNELS.sessions.GET_NOTES),
  setSessionNotes: invoke(RPC_CHANNELS.sessions.SET_NOTES),
  watchSessionFiles: invoke(RPC_CHANNELS.sessions.WATCH_FILES),
  unwatchSessionFiles: invoke(RPC_CHANNELS.sessions.UNWATCH_FILES),
  onSessionFilesChanged: listener(RPC_CHANNELS.sessions.FILES_CHANGED),

  // Native Source/Skill destructive mutations use IDs resolved from safe detail.
  createSource: invoke(RPC_CHANNELS.sources.CREATE),
  deleteSource: invoke(RPC_CHANNELS.sources.DELETE),
  // Value-only dp probe (T3): lets a completed system sign-in take effect
  // server-side (pool registry resync) without a chat message.
  probeDpSession: invoke(RPC_CHANNELS.dpAuth.PROBE),
  // T4: the session-start notice's data (value-free, never connects).
  getWorkspacePendingAuth: invoke(RPC_CHANNELS.sources.PENDING_AUTH),
  getWorkspacePermissionsConfig: invoke(RPC_CHANNELS.workspace.GET_PERMISSIONS),
  // P2.9 — import a Claude Code setup (`~/.claude`) into the active workspace.
  previewClaudeSetupImport: invoke(RPC_CHANNELS.workspace.IMPORT_CLAUDE_PREVIEW),
  applyClaudeSetupImport: invoke(RPC_CHANNELS.workspace.IMPORT_CLAUDE_APPLY),
  getDefaultPermissionsConfig: invoke(RPC_CHANNELS.permissions.GET_DEFAULTS),
  getMcpChannelPushEnabled: invoke(RPC_CHANNELS.permissions.GET_MCP_CHANNEL_PUSH),
  setMcpChannelPushEnabled: invoke(RPC_CHANNELS.permissions.SET_MCP_CHANNEL_PUSH),
  getSandboxSwitches: invoke(RPC_CHANNELS.permissions.GET_SANDBOX_SWITCHES),
  setSandboxSwitches: invoke(RPC_CHANNELS.permissions.SET_SANDBOX_SWITCHES),
  getIsolationCapabilities: invoke(RPC_CHANNELS.permissions.GET_ISOLATION_CAPABILITIES),
  // P6.209 — read-only; the missing setter is an open owner question, not an
  // oversight (see the channel's own docblock).
  getAutoModePolicy: invoke(RPC_CHANNELS.permissions.GET_AUTO_MODE_POLICY),
  // T5: bypassPermissions responsibility acknowledgment (config.json tier).
  getBypassPermissionsAcknowledged: invoke(RPC_CHANNELS.permissions.GET_BYPASS_PERMISSIONS_ACKNOWLEDGED),
  setBypassPermissionsAcknowledged: invoke(RPC_CHANNELS.permissions.SET_BYPASS_PERMISSIONS_ACKNOWLEDGED),
  // Built-in dp-backed MCP set (A7) — read the set, write one server's switch.
  getBuiltinDpMcpServers: invoke(RPC_CHANNELS.builtinDpMcp.LIST),
  setBuiltinDpMcpServerEnabled: invoke(RPC_CHANNELS.builtinDpMcp.SET_ENABLED),
  onDefaultPermissionsChanged: listener(RPC_CHANNELS.permissions.DEFAULTS_CHANGED),

  // Session content search
  searchSessionContent: invoke(RPC_CHANNELS.sessions.SEARCH_CONTENT),

  // OAuth (server-owned credentials)
  oauthRevoke: invoke(RPC_CHANNELS.oauth.REVOKE),
  // UB3.10: how a joined sign-in is doing — still live, or how it ended.
  oauthStatus: invoke(RPC_CHANNELS.oauth.STATUS),

  // Skills
  deleteSkill: invoke(RPC_CHANNELS.skills.DELETE),

  // Statuses
  listStatuses: invoke(RPC_CHANNELS.statuses.LIST),
  reorderStatuses: invoke(RPC_CHANNELS.statuses.REORDER),
  onStatusesChanged: listener(RPC_CHANNELS.statuses.CHANGED),

  // Labels
  listLabels: invoke(RPC_CHANNELS.labels.LIST),
  createLabel: invoke(RPC_CHANNELS.labels.CREATE),
  deleteLabel: invoke(RPC_CHANNELS.labels.DELETE),
  onLabelsChanged: listener(RPC_CHANNELS.labels.CHANGED),

  // LLM connections change listener
  onLlmConnectionsChanged: listener(RPC_CHANNELS.llmConnections.CHANGED),

  // Views
  listViews: invoke(RPC_CHANNELS.views.LIST),
  saveViews: invoke(RPC_CHANNELS.views.SAVE),

  // Tool icon mappings
  getToolIconMappings: invoke(RPC_CHANNELS.toolIcons.GET_MAPPINGS),

  // Workspace images
  readWorkspaceImage: invoke(RPC_CHANNELS.workspace.READ_IMAGE),
  writeWorkspaceImage: invoke(RPC_CHANNELS.workspace.WRITE_IMAGE),

  // Theme
  getAppTheme: invoke(RPC_CHANNELS.theme.GET_APP),
  loadPresetThemes: invoke(RPC_CHANNELS.theme.GET_PRESETS),
  loadPresetTheme: invoke(RPC_CHANNELS.theme.LOAD_PRESET),
  getColorTheme: invoke(RPC_CHANNELS.theme.GET_COLOR_THEME),
  setColorTheme: invoke(RPC_CHANNELS.theme.SET_COLOR_THEME),
  getWorkspaceColorTheme: invoke(RPC_CHANNELS.theme.GET_WORKSPACE_COLOR_THEME),
  setWorkspaceColorTheme: invoke(RPC_CHANNELS.theme.SET_WORKSPACE_COLOR_THEME),
  getAllWorkspaceThemes: invoke(RPC_CHANNELS.theme.GET_ALL_WORKSPACE_THEMES),
  getLogoUrl: invoke(RPC_CHANNELS.logo.GET_URL),
  onAppThemeChange: listener(RPC_CHANNELS.theme.APP_CHANGED),
  broadcastThemePreferences: invoke(RPC_CHANNELS.theme.BROADCAST_PREFERENCES),
  onThemePreferencesChange: listener(RPC_CHANNELS.theme.PREFERENCES_CHANGED),
  broadcastWorkspaceThemeChange: invoke(RPC_CHANNELS.theme.BROADCAST_WORKSPACE_THEME),
  onWorkspaceThemeChange: listener(RPC_CHANNELS.theme.WORKSPACE_THEME_CHANGED),

  // Notifications
  showNotification: invoke(RPC_CHANNELS.notification.SHOW),
  getNotificationsEnabled: invoke(RPC_CHANNELS.notification.GET_ENABLED),
  setNotificationsEnabled: invoke(RPC_CHANNELS.notification.SET_ENABLED),
  getNotificationSettings: invoke(RPC_CHANNELS.notification.GET_SETTINGS),
  setNotificationSettings: invoke(RPC_CHANNELS.notification.SET_SETTINGS),

  // Input settings
  getAutoCapitalisation: invoke(RPC_CHANNELS.input.GET_AUTO_CAPITALISATION),
  setAutoCapitalisation: invoke(RPC_CHANNELS.input.SET_AUTO_CAPITALISATION),
  getSendMessageKey: invoke(RPC_CHANNELS.input.GET_SEND_MESSAGE_KEY),
  setSendMessageKey: invoke(RPC_CHANNELS.input.SET_SEND_MESSAGE_KEY),
  getSpellCheck: invoke(RPC_CHANNELS.input.GET_SPELL_CHECK),
  setSpellCheck: invoke(RPC_CHANNELS.input.SET_SPELL_CHECK),

  // Power settings
  getKeepAwakeWhileRunning: invoke(RPC_CHANNELS.power.GET_KEEP_AWAKE),
  setKeepAwakeWhileRunning: invoke(RPC_CHANNELS.power.SET_KEEP_AWAKE),

  // Appearance settings
  getRichToolDescriptions: invoke(RPC_CHANNELS.appearance.GET_RICH_TOOL_DESCRIPTIONS),
  setRichToolDescriptions: invoke(RPC_CHANNELS.appearance.SET_RICH_TOOL_DESCRIPTIONS),

  // Tools settings
  getBrowserToolEnabled: invoke(RPC_CHANNELS.tools.GET_BROWSER_TOOL_ENABLED),
  setBrowserToolEnabled: invoke(RPC_CHANNELS.tools.SET_BROWSER_TOOL_ENABLED),
  getBrowserDownloadSettings: invoke(RPC_CHANNELS.tools.GET_BROWSER_DOWNLOAD_SETTINGS),
  setBrowserDownloadSettings: invoke(RPC_CHANNELS.tools.SET_BROWSER_DOWNLOAD_SETTINGS),

  // Retention — the destructive age-based cleanup window and its off switch
  getRetentionSettings: invoke(RPC_CHANNELS.retention.GET_SETTINGS),
  setRetentionDays: invoke(RPC_CHANNELS.retention.SET_DAYS),
  setRetentionSweepEnabled: invoke(RPC_CHANNELS.retention.SET_SWEEP_ENABLED),

  // P6.868 — inbound messages from the user's own other sessions
  getCrossSessionInboundSettings: invoke(RPC_CHANNELS.settings.GET_CROSS_SESSION_INBOUND),
  setCrossSessionInbound: invoke(RPC_CHANNELS.settings.SET_CROSS_SESSION_INBOUND),

  // Prompt caching & context
  getExtendedPromptCache: invoke(RPC_CHANNELS.caching.GET_EXTENDED_PROMPT_CACHE),
  setExtendedPromptCache: invoke(RPC_CHANNELS.caching.SET_EXTENDED_PROMPT_CACHE),

  // RTK token optimization
  getRtkEnabled: invoke(RPC_CHANNELS.rtk.GET_ENABLED),
  setRtkEnabled: invoke(RPC_CHANNELS.rtk.SET_ENABLED),
  getRtkStatus: invoke(RPC_CHANNELS.rtk.GET_STATUS),
  getRtkGain: invoke(RPC_CHANNELS.rtk.GET_GAIN),

  // UB6.3 — Decision model (Jev): the Settings > AI card.
  getDecisionLayerSettings: invoke(RPC_CHANNELS.decisions.GET_SETTINGS),
  setDecisionLayerSettings: invoke(RPC_CHANNELS.decisions.SET_SETTINGS),
  getDecisionLayerStatus: invoke(RPC_CHANNELS.decisions.GET_STATUS),
  setDecisionApiKey: invoke(RPC_CHANNELS.decisions.SET_API_KEY),
  deleteDecisionApiKey: invoke(RPC_CHANNELS.decisions.DELETE_API_KEY),
  testDecisionConnection: invoke(RPC_CHANNELS.decisions.TEST),
  probeDecisionServer: invoke(RPC_CHANNELS.decisions.PROBE_SERVER),
  getDecisionUsage: invoke(RPC_CHANNELS.decisions.GET_USAGE),

  // Guardian safety judge
  getGuardianEnabled: invoke(RPC_CHANNELS.guardian.GET_ENABLED),
  setGuardianEnabled: invoke(RPC_CHANNELS.guardian.SET_ENABLED),
  getGuardianModel: invoke(RPC_CHANNELS.guardian.GET_MODEL),
  setGuardianModel: invoke(RPC_CHANNELS.guardian.SET_MODEL),
  getGuardianModelsByConnection: invoke(RPC_CHANNELS.guardian.GET_MODELS_BY_CONNECTION),
  setGuardianModelForConnection: invoke(RPC_CHANNELS.guardian.SET_MODEL_FOR_CONNECTION),

  // Advisor model (P2.528). `setAdvisorModel` can reject with
  // MODEL_RESTRICTED_BY_POLICY, the same code the session and guardian model
  // writes use — `describeManagedModelRefusal` already reads it.
  // P6.168 — read-only; no setter beside it (owner decision D12).
  getSettingsProvenance: invoke(RPC_CHANNELS.settings.GET_PROVENANCE),
  // P6.576 — read-only; no setter beside it (owner decision D12), and
  // narrower than `nessy-general-agent doctor` by construction: five of that
  // report's collectors are unexported inside the CLI. The section says so.
  getConfigDoctorReport: invoke(RPC_CHANNELS.settings.GET_CONFIG_DOCTOR),
  getWorkflowSettings: invoke(RPC_CHANNELS.settings.GET_WORKFLOW),
  setWorkflowSizeGuideline: invoke(RPC_CHANNELS.settings.SET_WORKFLOW_SIZE_GUIDELINE),
  getAdvisorEnabled: invoke(RPC_CHANNELS.advisor.GET_ENABLED),
  setAdvisorEnabled: invoke(RPC_CHANNELS.advisor.SET_ENABLED),
  getAdvisorModel: invoke(RPC_CHANNELS.advisor.GET_MODEL),
  setAdvisorModel: invoke(RPC_CHANNELS.advisor.SET_MODEL),

  // Codex's own approval reviewer (P6.225). Takes effect on the NEXT codex
  // session: both values are written into codex's own config file.
  getCodexAutoReviewEnabled: invoke(RPC_CHANNELS.codexAutoReview.GET_ENABLED),
  setCodexAutoReviewEnabled: invoke(RPC_CHANNELS.codexAutoReview.SET_ENABLED),
  getCodexSubagentsEnabled: invoke(RPC_CHANNELS.codexSubagents.GET_ENABLED),
  setCodexSubagentsEnabled: invoke(RPC_CHANNELS.codexSubagents.SET_ENABLED),
  getCodexAutoReviewPolicy: invoke(RPC_CHANNELS.codexAutoReview.GET_POLICY),
  setCodexAutoReviewPolicy: invoke(RPC_CHANNELS.codexAutoReview.SET_POLICY),

  // C3.178 — which attached folder is primary. Display and ordering only.
  getPrimaryDirectory: invoke(RPC_CHANNELS.primaryDirectory.GET),
  setPrimaryDirectory: invoke(RPC_CHANNELS.primaryDirectory.SET),

  // Badge
  refreshBadge: invoke(RPC_CHANNELS.badge.REFRESH),
  setDockIconWithBadge: invoke(RPC_CHANNELS.badge.SET_ICON),
  onBadgeDraw: listener(RPC_CHANNELS.badge.DRAW),
  onBadgeDrawWindows: listener(RPC_CHANNELS.badge.DRAW_WINDOWS),

  // Window focus
  getWindowFocusState: invoke(RPC_CHANNELS.window.GET_FOCUS_STATE),
  onWindowFocusChange: listener(RPC_CHANNELS.window.FOCUS_STATE),
  onNotificationNavigate: listener(RPC_CHANNELS.notification.NAVIGATE),

  // Git
  getGitBranch: invoke(RPC_CHANNELS.git.GET_BRANCH),
  checkGitBash: invoke(RPC_CHANNELS.gitbash.CHECK),
  browseForGitBash: invoke(RPC_CHANNELS.gitbash.BROWSE),
  setGitBashPath: invoke(RPC_CHANNELS.gitbash.SET_PATH),

  // Menu actions
  menuQuit: invoke(RPC_CHANNELS.menu.QUIT),
  menuNewWindow: invoke(RPC_CHANNELS.menu.NEW_WINDOW),
  menuMinimize: invoke(RPC_CHANNELS.menu.MINIMIZE),
  menuMaximize: invoke(RPC_CHANNELS.menu.MAXIMIZE),
  menuZoomIn: invoke(RPC_CHANNELS.menu.ZOOM_IN),
  menuZoomOut: invoke(RPC_CHANNELS.menu.ZOOM_OUT),
  menuZoomReset: invoke(RPC_CHANNELS.menu.ZOOM_RESET),
  menuToggleDevTools: invoke(RPC_CHANNELS.menu.TOGGLE_DEV_TOOLS),
  menuUndo: invoke(RPC_CHANNELS.menu.UNDO),
  menuRedo: invoke(RPC_CHANNELS.menu.REDO),
  menuCut: invoke(RPC_CHANNELS.menu.CUT),
  menuCopy: invoke(RPC_CHANNELS.menu.COPY),
  menuPaste: invoke(RPC_CHANNELS.menu.PASTE),
  menuSelectAll: invoke(RPC_CHANNELS.menu.SELECT_ALL),

  // Browser pane management
  'browserPane.create': invoke(RPC_CHANNELS.browserPane.CREATE),
  'browserPane.destroy': invoke(RPC_CHANNELS.browserPane.DESTROY),
  'browserPane.list': invoke(RPC_CHANNELS.browserPane.LIST),
  'browserPane.navigate': invoke(RPC_CHANNELS.browserPane.NAVIGATE),
  'browserPane.goBack': invoke(RPC_CHANNELS.browserPane.GO_BACK),
  'browserPane.goForward': invoke(RPC_CHANNELS.browserPane.GO_FORWARD),
  'browserPane.reload': invoke(RPC_CHANNELS.browserPane.RELOAD),
  'browserPane.stop': invoke(RPC_CHANNELS.browserPane.STOP),
  'browserPane.focus': invoke(RPC_CHANNELS.browserPane.FOCUS),
  'browserPane.emptyStateLaunch': invoke(RPC_CHANNELS.browserPane.LAUNCH),
  'browserPane.trustList': invoke(RPC_CHANNELS.browserPane.TRUST_LIST),
  'browserPane.trustRevoke': invoke(RPC_CHANNELS.browserPane.TRUST_REVOKE),
  'browserPane.onStateChanged': listener(RPC_CHANNELS.browserPane.STATE_CHANGED),
  'browserPane.onRemoved': listener(RPC_CHANNELS.browserPane.REMOVED),
  'browserPane.onInteracted': listener(RPC_CHANNELS.browserPane.INTERACTED),

  // LLM Connections
  listLlmConnections: invoke(RPC_CHANNELS.llmConnections.LIST),
  listLlmConnectionsWithStatus: invoke(RPC_CHANNELS.llmConnections.LIST_WITH_STATUS),
  getLlmConnection: invoke(RPC_CHANNELS.llmConnections.GET),
  getLlmConnectionApiKey: invoke(RPC_CHANNELS.llmConnections.GET_API_KEY),
  saveLlmConnection: invoke(RPC_CHANNELS.llmConnections.SAVE),
  deleteLlmConnection: invoke(RPC_CHANNELS.llmConnections.DELETE),
  testLlmConnection: invoke(RPC_CHANNELS.llmConnections.TEST),
  setDefaultLlmConnection: invoke(RPC_CHANNELS.llmConnections.SET_DEFAULT),
  setWorkspaceDefaultLlmConnection: invoke(RPC_CHANNELS.llmConnections.SET_WORKSPACE_DEFAULT),

  // Automations
  getAutomations: invoke(RPC_CHANNELS.automations.GET),
  testAutomation: invoke(RPC_CHANNELS.automations.TEST),
  createAutomation: invoke(RPC_CHANNELS.automations.CREATE),
  updateAutomation: invoke(RPC_CHANNELS.automations.UPDATE),
  setAutomationEnabled: invoke(RPC_CHANNELS.automations.SET_ENABLED),
  duplicateAutomation: invoke(RPC_CHANNELS.automations.DUPLICATE),
  deleteAutomation: invoke(RPC_CHANNELS.automations.DELETE),
  getAutomationHistory: invoke(RPC_CHANNELS.automations.GET_HISTORY),
  getAutomationLastExecuted: invoke(RPC_CHANNELS.automations.GET_LAST_EXECUTED),
  replayAutomation: invoke(RPC_CHANNELS.automations.REPLAY),
  approveAutomationScript: invoke(RPC_CHANNELS.automations.APPROVE_SCRIPT), // UA8.3
  onAutomationsChanged: listener(RPC_CHANNELS.automations.CHANGED),

  // Tasks (Conductor) — UA3.3, v0.13.4; `getTaskOutput` above is the background-output read, not this family
  validateTask: invoke(RPC_CHANNELS.tasks.VALIDATE),
  createTask: invoke(RPC_CHANNELS.tasks.CREATE),
  generateTask: invoke(RPC_CHANNELS.tasks.GENERATE),
  runTask: invoke(RPC_CHANNELS.tasks.RUN),
  pauseTask: invoke(RPC_CHANNELS.tasks.PAUSE),
  resumeTask: invoke(RPC_CHANNELS.tasks.RESUME),
  stopTask: invoke(RPC_CHANNELS.tasks.STOP),
  getTask: invoke(RPC_CHANNELS.tasks.GET),
  listTasks: invoke(RPC_CHANNELS.tasks.LIST),
  getTaskResults: invoke(RPC_CHANNELS.tasks.GET_RESULTS),
  deleteTask: invoke(RPC_CHANNELS.tasks.DELETE),
  onTaskGenerated: listener(RPC_CHANNELS.tasks.GENERATED),

  // Published pages (t-artifacts) — UA1.19
  listPublishedArtifacts: invoke(RPC_CHANNELS.artifacts.LIST),
  setPublishedArtifactRetention: invoke(RPC_CHANNELS.artifacts.SET_RETENTION),
  deletePublishedArtifact: invoke(RPC_CHANNELS.artifacts.DELETE),
  publishArtifactFile: invoke(RPC_CHANNELS.artifacts.PUBLISH_FILE), // UA1.23

  // Pages — UA6.4 (v0.13.4): the page list push and the core invokes
  getPages: invoke(RPC_CHANNELS.pages.GET),
  getPage: invoke(RPC_CHANNELS.pages.GET_ONE),
  createPage: invoke(RPC_CHANNELS.pages.CREATE),
  updatePage: invoke(RPC_CHANNELS.pages.UPDATE),
  deletePage: invoke(RPC_CHANNELS.pages.DELETE),
  getPageContent: invoke(RPC_CHANNELS.pages.GET_CONTENT),
  setPageContent: invoke(RPC_CHANNELS.pages.SET_CONTENT),
  getPageData: invoke(RPC_CHANNELS.pages.GET_DATA),
  createPageLease: invoke(RPC_CHANNELS.pages.CREATE_LEASE),
  releasePageLease: invoke(RPC_CHANNELS.pages.RELEASE_LEASE),
  getPageThumbnail: invoke(RPC_CHANNELS.pages.GET_THUMBNAIL), // UA7.4
  regeneratePageThumbnail: invoke(RPC_CHANNELS.pages.REGENERATE_THUMBNAIL), // UA7.4
  getPageRefreshStatus: invoke(RPC_CHANNELS.pages.GET_REFRESH_STATUS), // UA8.3
  approvePageRefresh: invoke(RPC_CHANNELS.pages.APPROVE_REFRESH), // UA8.3
  runPageRefreshNow: invoke(RPC_CHANNELS.pages.RUN_REFRESH_NOW), // UA8.3
  listPageGrants: invoke(RPC_CHANNELS.pages.LIST_GRANTS), // UA9.3
  describePageGrantRequest: invoke(RPC_CHANNELS.pages.DESCRIBE_GRANT_REQUEST), // UA9.3 (ours)
  issuePageGrant: invoke(RPC_CHANNELS.pages.ISSUE_GRANT), // UA9.3
  revokePageGrant: invoke(RPC_CHANNELS.pages.REVOKE_GRANT), // UA9.3
  executePageAction: invoke(RPC_CHANNELS.pages.EXECUTE_ACTION), // UA9.3
  cancelPageAction: invoke(RPC_CHANNELS.pages.CANCEL_ACTION), // UA9.3
  auditPageGateRefusal: invoke(RPC_CHANNELS.pages.AUDIT_REFUSAL), // UA12.112
  getPageShareDataScan: invoke(RPC_CHANNELS.pages.GET_SHARE_DATA_SCAN), // UA6.7
  publishPage: invoke(RPC_CHANNELS.pages.PUBLISH), // UA6.7
  unpublishPage: invoke(RPC_CHANNELS.pages.UNPUBLISH), // UA6.7
  onPagesChanged: listener(RPC_CHANNELS.pages.CHANGED),
  onArtifactsChanged: listener(RPC_CHANNELS.artifacts.CHANGED), // UA12.52 — the Published pages section refetches

  // Projects — UA5.3 (v0.13.4): the project ENTITY invokes and its list push (+ ours: setProjectFolder)
  getProjects: invoke(RPC_CHANNELS.projects.GET),
  getProject: invoke(RPC_CHANNELS.projects.GET_ONE),
  createProject: invoke(RPC_CHANNELS.projects.CREATE),
  updateProject: invoke(RPC_CHANNELS.projects.UPDATE),
  deleteProject: invoke(RPC_CHANNELS.projects.DELETE),
  setProjectFolder: invoke(RPC_CHANNELS.projects.SET_FOLDER), // UA5.3 (ours)
  onProjectsChanged: listener(RPC_CHANNELS.projects.CHANGED),
  listProjectAssets: invoke(RPC_CHANNELS.projects.LIST_ASSETS), // UA5.6
  uploadProjectAsset: invoke(RPC_CHANNELS.projects.UPLOAD_ASSET), // UA5.6
  deleteProjectAsset: invoke(RPC_CHANNELS.projects.DELETE_ASSET), // UA5.6

  // Resources (cross-workspace export/import)
  exportResources: invoke(RPC_CHANNELS.resources.EXPORT),
  importResources: invoke(RPC_CHANNELS.resources.IMPORT),
} satisfies ChannelMap
