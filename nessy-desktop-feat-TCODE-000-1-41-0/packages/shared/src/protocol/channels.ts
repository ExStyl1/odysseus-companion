/**
 * RPC channel names — organized by domain namespace.
 * Wire-format strings (values) are the stable API contract.
 * Key paths are internal and may be reorganized freely.
 */
export const RPC_CHANNELS = {
  remote: {
    TEST_CONNECTION: 'remote:testConnection',
  },
  server: {
    GET_WORKSPACES: 'server:getWorkspaces',
    CREATE_WORKSPACE: 'server:createWorkspace',
    GET_STATUS: 'server:getStatus',
    GET_HEALTH: 'server:getHealth',
    GET_ACTIVE_SESSIONS: 'server:getActiveSessions',
    SHUTTING_DOWN: 'server:shuttingDown',
    STATUS_CHANGED: 'server:statusChanged',
    HOME_DIR: 'server:homeDir',
  },
  sessions: {
    GET: 'sessions:get',
    GET_UNREAD_SUMMARY: 'sessions:getUnreadSummary',
    MARK_ALL_READ: 'sessions:markAllRead',
    UNREAD_SUMMARY_CHANGED: 'sessions:unreadSummaryChanged',
    CREATE: 'sessions:create',
    DELETE: 'sessions:delete',
    GET_MESSAGES: 'sessions:getMessages',
    SEND_MESSAGE: 'sessions:sendMessage',
    CANCEL: 'sessions:cancel',
    FUZZY_FILE_SEARCH: 'sessions:fuzzyFileSearch',
    QUEUE_GET: 'sessions:queueGet',
    QUEUE_DELETE: 'sessions:queueDelete',
    QUEUE_REORDER: 'sessions:queueReorder',
    QUEUE_SEND_NOW: 'sessions:queueSendNow',
    QUEUE_RESUME: 'sessions:queueResume',
    GIT_BRANCHES: 'sessions:gitBranches',
    GIT_CHECKOUT: 'sessions:gitCheckout',
    KILL_SHELL: 'sessions:killShell',
    STOP_AGENT_TASK: 'sessions:stopAgentTask',
    // L9 — read a RUNNING background task's output. `tasks:getOutput` is the
    // completed-task read and is session-less; this one is scoped by session
    // exactly like KILL_SHELL, because ownership is what makes the answer honest.
    READ_TASK_OUTPUT: 'sessions:readTaskOutput',
    RESPOND_TO_PERMISSION: 'sessions:respondToPermission',
    REVOKE_FILESYSTEM_ROOT: 'sessions:revokeFilesystemRoot',
    RESPOND_TO_CREDENTIAL: 'sessions:respondToCredential',
    COMMAND: 'sessions:command',
    GET_PENDING_PLAN_EXECUTION: 'sessions:getPendingPlanExecution',
    GET_PERMISSION_MODE_STATE: 'sessions:getPermissionModeState',
    /**
     * P6.411 — what this session's capability resolution deliberately withheld,
     * and why. The read path landed in `d1b7ae0bb` on `ISessionManager` and
     * reached no renderer; this is the route. It carries the WITHHELD half
     * only, on purpose: the loaded half is the capability catalog the renderer
     * already reads, and a second copy would be a second thing to keep in step.
     */
    GET_CAPABILITY_INVENTORY: 'sessions:getCapabilityInventory',
    /**
     * P6.711 — reconnect ONE of this session's MCP servers, on the user's word.
     * The host verb landed in `679fa9a13` and `ISessionManager` gained the
     * accessor in `f4ce1e0cb`; this is the route from the panel to it.
     *
     * Scoped by SESSION for the same reason `KILL_SHELL` is: the pool is per
     * managed session, and the leaser it passes is what stops one session
     * restarting another's server by naming the same slug.
     *
     * The result is a VERDICT, never an exception — `unknown-server` /
     * `no-config` / `in-process` / `failed` are four different things to tell
     * the user, and the panel renders whichever it gets.
     */
    RECONNECT_MCP_SERVER: 'sessions:reconnectMcpServer',
    /**
     * P6.750 — the LIVE state of this session's MCP servers, as one
     * `McpServerStatusLine` (`shared/mcp/server-status.ts`) per server.
     *
     * The panel builds its rows from stored CONFIG, so a failed server, a
     * server waiting on a sign-in and a connected server providing zero tools
     * all render exactly like a healthy one. This is the read that separates
     * them, and it is the same shape and the same producer `/mcp` prints from —
     * a second inventory would be a second thing to disagree with.
     *
     * Session-scoped for the reason {@link RECONNECT_MCP_SERVER} above is: the
     * pool is per managed session and the leaser is what keeps one session from
     * reading another's servers.
     *
     * `null` — never an exception — when the session holds no source of
     * inventory at all (no runtime yet and no pool). "Nobody has counted" and
     * "there are none" are different answers and the panel must not merge them.
     */
    GET_MCP_SERVER_STATUSES: 'sessions:getMcpServerStatuses',
    /**
     * P6.318 — keep this run: write the workflow the session just executed into
     * the project or the personal location, so `/<name>` dispatches it later.
     * `saveWorkflowRecipe` shipped with zero production callers; `7bac0f5c4`
     * gave it one on the host side and this is the route from the UI.
     */
    SAVE_WORKFLOW_RECIPE: 'sessions:saveWorkflowRecipe',
    /**
     * D1.97 + D1.98 — one read for everything this session has queued: the cron
     * records it will run later and the background work (watches included) it is
     * running now, as ONE flat list.
     *
     * One channel for two rows on purpose. The records already existed and no
     * RPC carried them: `sessionCronServices` is thirteen references inside
     * `SessionManager` with a store and a lifecycle test behind it, and the
     * monitor service files every watch into the background-task registry — so
     * what was missing was the route, not the data. A second channel for the
     * crons alone would have made the panel join two lists, which is the new
     * design the 2026-08-22 owner gate still holds.
     */
    LIST_SCHEDULED_WORK: 'sessions:listScheduledWork',
    GET_PI_HARNESS_RUNTIME: 'sessions:getPiHarnessRuntime',
    CONTROL_PI_HARNESS_RUNTIME: 'sessions:controlPiHarnessRuntime',
    LIST_PI_AGENT_VIEW: 'sessions:listPiAgentView',
    CONTROL_PI_AGENT_VIEW: 'sessions:controlPiAgentView',
    EVENT: 'session:event',
    GET_MODEL: 'session:getModel',
    SET_MODEL: 'session:setModel',
    /** Read-only: the session agent's recent subprocess stderr (see SessionManager). */
    GET_RECENT_STDERR: 'session:getRecentStderr',
    /**
     * P6.703 — the per-CHAT memory scope override.
     *
     * Two independent axes, each independently UNSET: may this chat read
     * existing memories, and may it feed future ones. An unset axis follows the
     * global switch, which is what "without touching the global setting" means —
     * a chat that says nothing behaves exactly as it does today.
     *
     * Session-scoped and therefore a `session:` verb rather than a settings one:
     * the whole point of the row is that the answer differs per chat while the
     * app-wide switch stays where it is.
     */
    GET_MEMORY_SCOPE: 'session:getMemoryScope',
    SET_MEMORY_SCOPE: 'session:setMemoryScope',
    GET_FILES: 'sessions:getFiles',
    OPEN_FILE: 'sessions:openFile',
    PREVIEW_FILE: 'sessions:previewFile',
    OPEN_ATTACHMENT: 'sessions:openAttachment',
    REVEAL_STORAGE: 'sessions:revealStorage',
    COPY_STORAGE_PATH: 'sessions:copyStoragePath',
    OPEN_ARTIFACT: 'sessions:openArtifact',
    GET_NOTES: 'sessions:getNotes',
    SET_NOTES: 'sessions:setNotes',
    WATCH_FILES: 'sessions:watchFiles',
    UNWATCH_FILES: 'sessions:unwatchFiles',
    FILES_CHANGED: 'sessions:filesChanged',
    SEARCH_CONTENT: 'sessions:searchContent',
    EXPORT: 'sessions:export',
    IMPORT: 'sessions:import',
    EXPORT_REMOTE_TRANSFER: 'sessions:exportRemoteTransfer',
    IMPORT_REMOTE_TRANSFER: 'sessions:importRemoteTransfer',
  },
  transfer: {
    START: 'transfer:start',
    CHUNK: 'transfer:chunk',
    COMMIT: 'transfer:commit',
    ABORT: 'transfer:abort',
  },
  // tasks — declared below the docs-cited lines (UA3.3): the background-output read `tasks:getOutput`
  // (rpc/sessions.ts) and the durable Tasks family (rpc/tasks.ts) share the namespace, separated by a
  // docblock there. Key paths are unchanged (`RPC_CHANNELS.tasks.GET_OUTPUT`).
  workspaces: {
    GET: 'workspaces:get',
    CREATE: 'workspaces:create',
    CONNECT_REMOTE: 'workspaces:connectRemote',
    UPDATE_REMOTE: 'workspaces:updateRemote',
    CREATE_ON_REMOTE: 'workspaces:createOnRemote',
    /**
     * P6.501 — the project-scoped purge, headlessly.
     *
     * `WorkspaceService.delete` was complete and transactional and reachable
     * only through the Electron `workspace:remove` IPC, so a headless install
     * had no supported way to offboard a project at all — the gap the row named,
     * at the scope where it is actually true. Answers with the WHOLE
     * `WorkspaceDeleteResult`, because a caller that cannot see
     * `cleanupFailures` cannot tell a complete purge from a partial one.
     */
    DELETE: 'workspaces:delete',
  },
  projects: {
    PICK_LOCAL_DIRECTORY: 'projects:pickLocalDirectory',
    VALIDATE_DIRECTORY: 'projects:validateDirectory',
    LIST_RECENT: 'projects:listRecent',
    ISSUE_RECENT_HANDLE: 'projects:issueRecentHandle',
    SET_TRUST: 'projects:setTrust',
    SET_SESSION_PROJECT: 'projects:setSessionProject',
    SET_WORKSPACE_DEFAULT: 'projects:setWorkspaceDefault', GET: 'projects:get', GET_ONE: 'projects:getOne', CREATE: 'projects:create', UPDATE: 'projects:update', DELETE: 'projects:delete', SET_FOLDER: 'projects:setFolder', CHANGED: 'projects:changed', LIST_ASSETS: 'projects:listAssets', UPLOAD_ASSET: 'projects:uploadAsset', DELETE_ASSET: 'projects:deleteAsset', // UA5.6 — the v0.13.4 asset keys; UA5.3 — the v0.13.4 project ENTITY keys (+ ours: SET_FOLDER, a folder only from a handle), one line so no cited line moves
  },
  window: {
    GET_WORKSPACE: 'window:getWorkspace',
    GET_MODE: 'window:getMode',
    OPEN_WORKSPACE: 'window:openWorkspace',
    OPEN_SESSION_IN_NEW_WINDOW: 'window:openSessionInNewWindow',
    SWITCH_WORKSPACE: 'window:switchWorkspace',
    CLOSE: 'window:close',
    CLOSE_REQUESTED: 'window:closeRequested',
    CONFIRM_CLOSE: 'window:confirmClose',
    CANCEL_CLOSE: 'window:cancelClose',
    SET_TRAFFIC_LIGHTS: 'window:setTrafficLights',
    FOCUS_STATE: 'window:focusState',
    GET_FOCUS_STATE: 'window:getFocusState',
  },
  file: {
    READ: 'file:read',
    READ_DATA_URL: 'file:readDataUrl',
    READ_PREVIEW_DATA_URL: 'file:readPreviewDataUrl',
    READ_BINARY: 'file:readBinary',
    OPEN_DIALOG: 'file:openDialog',
    READ_ATTACHMENT: 'file:readAttachment',
    READ_USER_ATTACHMENT: 'file:readUserAttachment',
    STORE_ATTACHMENT: 'file:storeAttachment',
    GENERATE_THUMBNAIL: 'file:generateThumbnail',
  },
  fs: {
    SEARCH: 'fs:search',
    LIST_DIRECTORY: 'fs:listDirectory',
  },
  debug: {
    LOG: 'debug:log',
  },
  theme: {
    GET_SYSTEM_PREFERENCE: 'theme:getSystemPreference',
    SYSTEM_CHANGED: 'theme:systemChanged',
    APP_CHANGED: 'theme:appChanged',
    GET_APP: 'theme:getApp',
    GET_PRESETS: 'theme:getPresets',
    LOAD_PRESET: 'theme:loadPreset',
    GET_COLOR_THEME: 'theme:getColorTheme',
    SET_COLOR_THEME: 'theme:setColorTheme',
    BROADCAST_PREFERENCES: 'theme:broadcastPreferences',
    PREFERENCES_CHANGED: 'theme:preferencesChanged',
    GET_WORKSPACE_COLOR_THEME: 'theme:getWorkspaceColorTheme',
    SET_WORKSPACE_COLOR_THEME: 'theme:setWorkspaceColorTheme',
    GET_ALL_WORKSPACE_THEMES: 'theme:getAllWorkspaceThemes',
    BROADCAST_WORKSPACE_THEME: 'theme:broadcastWorkspaceTheme',
    WORKSPACE_THEME_CHANGED: 'theme:workspaceThemeChanged',
  },
  system: {
    VERSIONS: 'system:versions',
    HOME_DIR: 'system:homeDir',
    IS_DEBUG_MODE: 'system:isDebugMode',
  },
  update: {
    CHECK: 'update:check',
    GET_INFO: 'update:getInfo',
    INSTALL: 'update:install',
    DISMISS: 'update:dismiss',
    GET_DISMISSED: 'update:getDismissed',
    AVAILABLE: 'update:available',
    DOWNLOAD_PROGRESS: 'update:downloadProgress',
  },
  shell: {
    OPEN_URL: 'shell:openUrl',
    OPEN_FILE: 'shell:openFile',
    SHOW_IN_FOLDER: 'shell:showInFolder',
  },
  menu: {
    NEW_CHAT: 'menu:newChat',
    NEW_WINDOW: 'menu:newWindow',
    OPEN_SETTINGS: 'menu:openSettings',
    KEYBOARD_SHORTCUTS: 'menu:keyboardShortcuts',
    TOGGLE_FOCUS_MODE: 'menu:toggleFocusMode',
    TOGGLE_SIDEBAR: 'menu:toggleSidebar',
    QUIT: 'menu:quit',
    MINIMIZE: 'menu:minimize',
    MAXIMIZE: 'menu:maximize',
    ZOOM_IN: 'menu:zoomIn',
    ZOOM_OUT: 'menu:zoomOut',
    ZOOM_RESET: 'menu:zoomReset',
    TOGGLE_DEV_TOOLS: 'menu:toggleDevTools',
    UNDO: 'menu:undo',
    REDO: 'menu:redo',
    CUT: 'menu:cut',
    COPY: 'menu:copy',
    PASTE: 'menu:paste',
    SELECT_ALL: 'menu:selectAll',
  },
  deeplink: {
    NAVIGATE: 'deeplink:navigate',
  },
  auth: {
    LOGOUT: 'auth:logout',
    SHOW_LOGOUT_CONFIRMATION: 'auth:showLogoutConfirmation',
    SHOW_DELETE_SESSION_CONFIRMATION: 'auth:showDeleteSessionConfirmation',
  },
  credentials: {
    HEALTH_CHECK: 'credentials:healthCheck',
  },
  onboarding: {
    GET_AUTH_STATE: 'onboarding:getAuthState',
    VALIDATE_MCP: 'onboarding:validateMcp',
    START_MCP_OAUTH: 'onboarding:startMcpOAuth',
    START_CLAUDE_OAUTH: 'onboarding:startClaudeOAuth',
    EXCHANGE_CLAUDE_CODE: 'onboarding:exchangeClaudeCode',
    HAS_CLAUDE_OAUTH_STATE: 'onboarding:hasClaudeOAuthState',
    CLEAR_CLAUDE_OAUTH_STATE: 'onboarding:clearClaudeOAuthState',
    DEFER_SETUP: 'onboarding:deferSetup',
  },
  llmConnections: {
    LIST: 'LLM_Connection:list',
    LIST_WITH_STATUS: 'LLM_Connection:listWithStatus',
    GET: 'LLM_Connection:get',
    GET_API_KEY: 'LLM_Connection:getApiKey',
    SAVE: 'LLM_Connection:save',
    DELETE: 'LLM_Connection:delete',
    TEST: 'LLM_Connection:test',
    SET_DEFAULT: 'LLM_Connection:setDefault',
    SET_WORKSPACE_DEFAULT: 'LLM_Connection:setWorkspaceDefault',
    REFRESH_MODELS: 'LLM_Connection:refreshModels',
    CHANGED: 'LLM_Connection:changed',
  },
  chatgpt: {
    START_OAUTH: 'chatgpt:startOAuth',
    COMPLETE_OAUTH: 'chatgpt:completeOAuth',
    CANCEL_OAUTH: 'chatgpt:cancelOAuth',
    GET_AUTH_STATUS: 'chatgpt:getAuthStatus',
    LOGOUT: 'chatgpt:logout',
  },
  copilot: {
    START_OAUTH: 'copilot:startOAuth',
    CANCEL_OAUTH: 'copilot:cancelOAuth',
    GET_AUTH_STATUS: 'copilot:getAuthStatus',
    LOGOUT: 'copilot:logout',
    DEVICE_CODE: 'copilot:deviceCode',
  },
  settings: {
    SETUP_LLM_CONNECTION: 'settings:setupLlmConnection',
    TEST_LLM_CONNECTION_SETUP: 'settings:testLlmConnectionSetup',
    GET_DEFAULT_THINKING_LEVEL: 'settings:getDefaultThinkingLevel',
    SET_DEFAULT_THINKING_LEVEL: 'settings:setDefaultThinkingLevel',
    GET_OUTPUT_STYLE: 'settings:getOutputStyle',
    SET_OUTPUT_STYLE: 'settings:setOutputStyle',
    LIST_OUTPUT_STYLES: 'settings:listOutputStyles',
    GET_NETWORK_PROXY: 'settings:getNetworkProxy',
    SET_NETWORK_PROXY: 'settings:setNetworkProxy',
    GET_SERVER_CONFIG: 'settings:getServerConfig',
    SET_SERVER_CONFIG: 'settings:setServerConfig',
    GET_SERVER_STATUS: 'settings:getServerStatus',
    /**
     * P6.168 — the read-only provenance checkup: which file and scope
     * supplied each family of settings the host resolves. Read-only by
     * construction (owner decision D12), so there is no setter beside it.
     */
    GET_PROVENANCE: 'settings:getProvenance',
    /**
     * P6.576 — the two settings-file tiers, as the report `nessy-general-agent
     * doctor` prints: which managed source is in effect, which of its entries
     * were refused, which settings layers were rejected whole, and whether a
     * policy file on disk is shadowed and enforcing nothing.
     *
     * Read-only, like `GET_PROVENANCE` beside it and for the same owner
     * decision (D12): the handler collects and renders, and nothing here is a
     * control.
     *
     * The report is DERIVED, never stored, so there is no cache to invalidate —
     * and it is deliberately the same builder the CLI calls, so the app and the
     * terminal cannot report different things about one machine.
     */
    GET_CONFIG_DOCTOR: 'settings:getConfigDoctor',
    /**
     * P6.319 — the workflow governance settings, RESOLVED (user layer + managed
     * layer + the env off switch), plus the advisory agent threshold that
     * follows from the size guideline. One read, because a renderer that had to
     * compose the layers itself would be a second resolver.
     */
    GET_WORKFLOW: 'settings:getWorkflow',
    /**
     * The one workflow key a user may set from the app. `disableWorkflows` and
     * the keyword trigger are deliberately NOT here: they are an organization's
     * off switch, tighter-wins, and an in-app control that appeared to relax one
     * would be a lie the resolver then ignores.
     */
    SET_WORKFLOW_SIZE_GUIDELINE: 'settings:setWorkflowSizeGuideline',
    /**
     * P6.868 — `crossSessionInbound`, RESOLVED: the user value, the documented
     * unset state, an unreadable stored value, and whether the operator control
     * outranks the lot. One read for the same reason as `GET_WORKFLOW` above.
     */
    GET_CROSS_SESSION_INBOUND: 'settings:getCrossSessionInbound',
    /**
     * The user rung, and only it. `null` clears the key: unset is a documented
     * behaviour of its own, not a synonym for `accept`, and there is no writer
     * here for the operator rung — an in-app control that appeared to relax an
     * environment value would write something the resolver then ignores.
     */
    SET_CROSS_SESSION_INBOUND: 'settings:setCrossSessionInbound',
  },
  pi: {
    GET_API_KEY_PROVIDERS: 'pi:getApiKeyProviders',
    GET_PROVIDER_BASE_URL: 'pi:getProviderBaseUrl',
    GET_PROVIDER_MODELS: 'pi:getProviderModels',
  },
  dialog: {
    OPEN_FOLDER: 'dialog:openFolder',
  },
  preferences: {
    READ: 'preferences:read',
    WRITE: 'preferences:write',
  },
  plugins: {
    MANAGE: 'plugins:manage',
  },
  marketplace: {
    LIST: 'marketplace:list',
    CONTENT: 'marketplace:content',
    COMPONENTS: 'marketplace:components',
    PROPOSE_INSTALL: 'marketplace:proposeInstall',
    PROPOSE_MCPB: 'marketplace:proposeMcpb',
    UPLOAD_MCPB: 'marketplace:uploadMcpb',
    INSTALL: 'marketplace:install',
    ADD_REGISTRY: 'marketplace:addRegistry',
    UPGRADE_REGISTRY: 'marketplace:upgradeRegistry',
    REMOVE_REGISTRY: 'marketplace:removeRegistry',
    LIST_REGISTRIES: 'marketplace:listRegistries',
    SET_REGISTRY_AUTO_UPDATE: 'marketplace:setRegistryAutoUpdate',
    ENABLE_OFFER: 'marketplace:enableOffer',
    /**
     * P6.563 — the Plugins page's Refresh-runtime button, which until now
     * reached no server at all. Sits beside the marketplace mutations because
     * that button is the fork's analogue of `/reload-plugins`, and it is the
     * only renderer route to `SessionManager.refreshPluginRuntime`.
     */
    REFRESH_RUNTIME: 'marketplace:refreshRuntime',
  },
  drafts: {
    GET: 'drafts:get',
    SET: 'drafts:set',
    DELETE: 'drafts:delete',
    GET_ALL: 'drafts:getAll',
  },
  sources: {
    CREATE: 'sources:create',
    DELETE: 'sources:delete',
    // T4 (plugin-install plan § 5): the session-start notice's data — every
    // source/server in the workspace still awaiting auth, value-free.
    PENDING_AUTH: 'sources:pendingAuth',
  },
  oauth: {
    START: 'oauth:start',
    COMPLETE: 'oauth:complete',
    CANCEL: 'oauth:cancel',
    FAIL: 'oauth:fail',
    REVOKE: 'oauth:revoke',
    // UB3.10: polled by clients that JOINED a live sign-in — still live, or how it ended.
    STATUS: 'oauth:status',
  },
  dpAuth: {
    ENSURE: 'dp-auth:ensure',
    CANCEL: 'dp-auth:cancel',
    STATUS: 'dp-auth:status',
    // Value-only, non-interactive dp session probe (T3, plugin-install plan).
    // Publishing the observed state is the point: the workspace pool registry
    // subscribes and restores dp-backed servers when the ready boundary is
    // crossed, so a completed system sign-in takes effect without a chat turn.
    PROBE: 'dp-auth:probe',
  },
  workspace: {
    GET_PERMISSIONS: 'workspace:getPermissions',
    IMPORT_CLAUDE_PREVIEW: 'workspace:importClaudePreview',
    IMPORT_CLAUDE_APPLY: 'workspace:importClaudeApply',
    LIST_CUSTOM_SLASH_COMMANDS: 'workspace:listCustomSlashCommands',
    READ_IMAGE: 'workspace:readImage',
    WRITE_IMAGE: 'workspace:writeImage',
    SETTINGS_GET: 'workspaceSettings:get',
    SETTINGS_UPDATE: 'workspaceSettings:update',
  },
  permissions: {
    GET_DEFAULTS: 'permissions:getDefaults',
    DEFAULTS_CHANGED: 'permissions:defaultsChanged',
    GET_MCP_CHANNEL_PUSH: 'permissions:getMcpChannelPush',
    SET_MCP_CHANNEL_PUSH: 'permissions:setMcpChannelPush',
    /**
     * P6.510 — the SESSION-scoped half of the same grant, declared beside the
     * app-wide one above on purpose: `channels` specifies a per-session act,
     * ours was an app-wide preference, and a reader who finds one scope has to
     * find the other or the softer boundary stays hidden.
     *
     * `ARM` is additive and idempotent and answers with the session's armed
     * set, sorted, so a caller can render exactly what it just granted;
     * `DISARM` drops the session's own arming and leaves the preference
     * untouched. Neither can loosen the managed bound: `resolveChannelPolicy`
     * applies `allowedChannelServers`, `deniedMcpServers` and a terminal
     * `channelsEnabled: false` on every READ, so a mandate that tightens after
     * an arming still takes effect rather than being frozen into the set.
     */
    ARM_SESSION_CHANNEL_SOURCES: 'permissions:armSessionChannelSources',
    DISARM_SESSION_CHANNEL_SOURCES: 'permissions:disarmSessionChannelSources',
    GET_ISOLATION_CAPABILITIES: 'permissions:getIsolationCapabilities',
    /**
     * P6.209 (A44, A45) — the rules this installation hands the Claude Code
     * runtime's own auto-mode judge, read-only.
     *
     * No setter beside it, and that is not a gap being deferred: whether an
     * operator may EDIT these lists is an open owner question, and the viewer
     * is the half that is correct under either answer.
     */
    GET_AUTO_MODE_POLICY: 'permissions:getAutoModePolicy',
    /**
     * P6.209 (A42) — what that judge has REFUSED in one session, read-only.
     *
     * Session-scoped, unlike the rules above: the receipts are retained in a
     * bounded ring on the live agent and die with it. Read-only for the reason
     * recorded on `SafeAutoModeDenialView` — a retry re-executes a call a safety
     * judge declined, which is a product posture and not a rendering choice.
     */
    GET_AUTO_MODE_DENIALS: 'permissions:getAutoModeDenials',
    // P6.327: the write half of the Process Isolation panel — the two user-layer
    // sandbox switches. Cannot loosen a managed floor (see setUserSandboxSwitches).
    GET_SANDBOX_SWITCHES: 'permissions:getSandboxSwitches',
    SET_SANDBOX_SWITCHES: 'permissions:setSandboxSwitches',
    // T5: the bypassPermissions responsibility acknowledgment (config.json,
    // this install only — see storage.ts's getBypassPermissionsAcknowledged).
    GET_BYPASS_PERMISSIONS_ACKNOWLEDGED: 'permissions:getBypassPermissionsAcknowledged',
    SET_BYPASS_PERMISSIONS_ACKNOWLEDGED: 'permissions:setBypassPermissionsAcknowledged',
  },
  /**
   * P6.361 — a project's own commands, saved once and launched from the app.
   *
   * `LIST` re-reads the store on every call rather than answering from a cache,
   * because the operator kill switch (`disableSkillShellExecution`) must be able
   * to take effect between the render and the click; `getWorkspaceActions`
   * answers `[]` while it is on, so a caller that forgets to ask cannot offer a
   * disabled action.
   *
   * `RUN` takes an action ID and NOT a command. A channel that accepted a
   * command string would be a second way to execute arbitrary shell from the
   * renderer, beside the one that already asks for approval — the row's own
   * clause is *"under the same command approval the agent's Bash goes through"*,
   * so the resolution happens on the host and the execution is
   * `SessionManager.runShellCommand`, unchanged.
   */
  workspaceActions: {
    LIST: 'workspaceActions:list',
    RUN: 'workspaceActions:run',
  },
  skills: {
    DELETE: 'skills:delete',
    OPEN_EDITOR: 'skills:openEditor',
    OPEN_FINDER: 'skills:openFinder',
  },
  statuses: {
    LIST: 'statuses:list',
    REORDER: 'statuses:reorder',
    CHANGED: 'statuses:changed',
  },
  labels: {
    LIST: 'labels:list',
    CREATE: 'labels:create',
    DELETE: 'labels:delete',
    CHANGED: 'labels:changed',
  },
  views: {
    LIST: 'views:list',
    SAVE: 'views:save',
  },
  toolIcons: {
    GET_MAPPINGS: 'toolIcons:getMappings',
  },
  logo: {
    GET_URL: 'logo:getUrl',
  },
  notification: {
    SHOW: 'notification:show',
    NAVIGATE: 'notification:navigate',
    GET_ENABLED: 'notification:getEnabled',
    SET_ENABLED: 'notification:setEnabled',
    // The three-position turn-completion timing plus the two separate alert
    // controls of
    // `learn.chatgpt.com/docs/notifications.md#configure-desktop-notifications`.
    // GET/SET_ENABLED stay for callers that still speak in the boolean those
    // replaced.
    GET_SETTINGS: 'notification:getSettings',
    SET_SETTINGS: 'notification:setSettings',
  },
  input: {
    GET_AUTO_CAPITALISATION: 'input:getAutoCapitalisation',
    SET_AUTO_CAPITALISATION: 'input:setAutoCapitalisation',
    GET_SEND_MESSAGE_KEY: 'input:getSendMessageKey',
    SET_SEND_MESSAGE_KEY: 'input:setSendMessageKey',
    GET_SPELL_CHECK: 'input:getSpellCheck',
    SET_SPELL_CHECK: 'input:setSpellCheck',
  },
  power: {
    GET_KEEP_AWAKE: 'power:getKeepAwake',
    SET_KEEP_AWAKE: 'power:setKeepAwake',
  },
  appearance: {
    GET_RICH_TOOL_DESCRIPTIONS: 'appearance:getRichToolDescriptions',
    SET_RICH_TOOL_DESCRIPTIONS: 'appearance:setRichToolDescriptions',
  },
  tools: {
    GET_BROWSER_TOOL_ENABLED: 'tools:getBrowserToolEnabled',
    SET_BROWSER_TOOL_ENABLED: 'tools:setBrowserToolEnabled',
    /**
     * P6.564 — the browser pane's download destination. Read and write are
     * separate channels rather than one toggle because the read carries more
     * than it stores: whether an environment variable is the layer in force,
     * so the form cannot look accepted while doing nothing.
     */
    GET_BROWSER_DOWNLOAD_SETTINGS: 'tools:getBrowserDownloadSettings',
    SET_BROWSER_DOWNLOAD_SETTINGS: 'tools:setBrowserDownloadSettings',
  },
  // The built-in dp-backed MCP set (A7). Its per-server preference was
  // persisted and folded into both pools long before anything could WRITE it —
  // until these two channels existed, `config.json` had to be hand-edited.
  builtinDpMcp: {
    LIST: 'builtinDpMcp:list',
    SET_ENABLED: 'builtinDpMcp:setEnabled',
  },
  // The age-based cleanup of session data. A destructive control, so it is a
  // settable window plus an explicit off switch, never a "large enough" number.
  retention: {
    GET_SETTINGS: 'retention:getSettings',
    SET_DAYS: 'retention:setDays',
    SET_SWEEP_ENABLED: 'retention:setSweepEnabled',
  },
  caching: {
    GET_EXTENDED_PROMPT_CACHE: 'caching:getExtendedPromptCache',
    SET_EXTENDED_PROMPT_CACHE: 'caching:setExtendedPromptCache',
  },
  rtk: {
    GET_ENABLED: 'rtk:getEnabled',
    SET_ENABLED: 'rtk:setEnabled',
    GET_STATUS: 'rtk:getStatus',
    GET_GAIN: 'rtk:getGain',
  },
  // UB6.3 — the decision layer's Settings card, its connectivity test and its usage read.
  decisions: {
    GET_SETTINGS: 'decisions:getSettings',
    SET_SETTINGS: 'decisions:setSettings',
    GET_STATUS: 'decisions:getStatus',
    SET_API_KEY: 'decisions:setApiKey',
    DELETE_API_KEY: 'decisions:deleteApiKey',
    TEST: 'decisions:test',
    PROBE_SERVER: 'decisions:probeServer',
    GET_USAGE: 'decisions:getUsage',
  },
  guardian: {
    GET_ENABLED: 'guardian:getEnabled',
    SET_ENABLED: 'guardian:setEnabled',
    GET_MODEL: 'guardian:getModel',
    SET_MODEL: 'guardian:setModel',
    /** Per-integration judge models — one global id cannot serve every key (H1). */
    GET_MODELS_BY_CONNECTION: 'guardian:getModelsByConnection',
    SET_MODEL_FOR_CONNECTION: 'guardian:setModelForConnection',
  },
  /**
   * The advising model (`advisor.md`, settings keys `advisorEnabled` /
   * `advisorModel`). P2.528 — until this group the getters and setters existed
   * and were reachable ONLY in-process, so `/advisor` was the whole surface and
   * no renderer could offer the setting at all.
   *
   * Deliberately shaped like `guardian` above rather than like `settings`: both
   * are install-wide AI keys in the same config file, both refuse a
   * managed-forbidden model at the write with the same code, and a renderer that
   * already reads one refusal reads the other unchanged.
   */
  advisor: {
    GET_ENABLED: 'advisor:getEnabled',
    SET_ENABLED: 'advisor:setEnabled',
    /** `''` means "the session's own model advises" — the documented default. */
    GET_MODEL: 'advisor:getModel',
    SET_MODEL: 'advisor:setModel',
  },
  /**
   * Codex's own approval reviewer (P6.225, settings keys `codexAutoReviewEnabled`
   * / `codexAutoReviewPolicy`). Both values are written into codex's OWN config
   * file by `config-writer.ts` (`approvals_reviewer = "auto_review"` and
   * `[auto_review].policy`) — nothing here re-implements a judge beside it.
   *
   * Shaped like `advisor` above rather than folded into `settings`: it is an
   * install-wide AI key in the same config file, written through the local
   * Electron server, and a renderer that already reads the advisor pair reads
   * this one unchanged. Measured before choosing that shape: `RPC_CHANNELS.settings`
   * has no key/value passthrough and `ElectronAPI` exposes no generic
   * `getConfig`/`setConfig`, so there was nothing to reuse.
   *
   * Turning it OFF reaches a running session from its next turn: F1.781
   * re-reads it at every turn/start; turning it ON, and a policy change, take
   * effect at the next codex session's config write (F1.1082's copy says so).
   */
  codexAutoReview: {
    GET_ENABLED: 'codexAutoReview:getEnabled',
    SET_ENABLED: 'codexAutoReview:setEnabled',
    /** `''` means "use codex's own policy unchanged" — the documented default. */
    GET_POLICY: 'codexAutoReview:getPolicy',
    SET_POLICY: 'codexAutoReview:setPolicy',
  },
  /**
   * C3.286 — codex's own delegation off-switch, reachable from the app.
   *
   * Its own pair rather than a member of `codexAutoReview` above: the two
   * settings are unrelated (one routes approvals through codex's reviewer, the
   * other decides whether codex may spawn agents at all) and a shared group
   * would make a reader think one gates the other.
   */
  codexSubagents: {
    GET_ENABLED: 'codexSubagents:getEnabled',
    SET_ENABLED: 'codexSubagents:setEnabled',
  },
  /**
   * C3.178 — WHICH attached folder is primary, as a user choice.
   *
   * `GET` answers with the stored choice AND the candidates, in one call rather
   * than two: the control cannot render a choice without the set it was made
   * from, and two channels would let the pair be read at different moments and
   * show a selected folder that is no longer attached.
   */
  primaryDirectory: {
    GET: 'primaryDirectory:get',
    SET: 'primaryDirectory:set',
  },
  badge: {
    REFRESH: 'badge:refresh',
    SET_ICON: 'badge:setIcon',
    DRAW: 'badge:draw',
    DRAW_WINDOWS: 'badge:draw-windows',
  },
  releaseNotes: {
    GET: 'releaseNotes:get',
    GET_LATEST_VERSION: 'releaseNotes:getLatestVersion',
  },
  git: {
    GET_BRANCH: 'git:getBranch',
  },
  gitbash: {
    CHECK: 'gitbash:check',
    BROWSE: 'gitbash:browse',
    SET_PATH: 'gitbash:setPath',
  },
  browserPane: {
    CREATE: 'browser-pane:create',
    DESTROY: 'browser-pane:destroy',
    LIST: 'browser-pane:list',
    NAVIGATE: 'browser-pane:navigate',
    GO_BACK: 'browser-pane:go-back',
    GO_FORWARD: 'browser-pane:go-forward',
    RELOAD: 'browser-pane:reload',
    STOP: 'browser-pane:stop',
    FOCUS: 'browser-pane:focus',
    SNAPSHOT: 'browser-pane:snapshot',
    CLICK: 'browser-pane:click',
    FILL: 'browser-pane:fill',
    SELECT: 'browser-pane:select',
    SCREENSHOT: 'browser-pane:screenshot',
    EVALUATE: 'browser-pane:evaluate',
    SCROLL: 'browser-pane:scroll',
    LAUNCH: 'browser-empty-state:launch',
    /** P6.536 — the per-origin trust store, for the settings surface. */
    TRUST_LIST: 'browser-pane:trust-list',
    TRUST_REVOKE: 'browser-pane:trust-revoke',
    STATE_CHANGED: 'browser-pane:state-changed',
    REMOVED: 'browser-pane:removed',
    INTERACTED: 'browser-pane:interacted',
  },
  automations: {
    GET: 'automations:get',
    TEST: 'automations:test',
    CREATE: 'automations:create',
    UPDATE: 'automations:update',
    SET_ENABLED: 'automations:setEnabled',
    DUPLICATE: 'automations:duplicate',
    DELETE: 'automations:delete',
    GET_HISTORY: 'automations:getHistory',
    GET_LAST_EXECUTED: 'automations:getLastExecuted',
    REPLAY: 'automations:replay',
    /** UA8.3 (ours): record the person's approval of a SAVED script action's current bytes in the host ledger. */
    APPROVE_SCRIPT: 'automations:approveScript',
    CHANGED: 'automations:changed',
  },
  resources: {
    EXPORT: 'resources:export',
    IMPORT: 'resources:import',
  },
  capabilities: {
    GET_CATALOG: 'capabilities:getCatalog',
    GET_COMPOSER_CATALOG: 'capabilities:getComposerCatalog',
    GET_DETAIL: 'capabilities:getDetail',
    /**
     * Headless `system/init` payload (`headless.md:197`). Read-only, CLI-facing
     * and deliberately NOT path-free — it carries `plugins[].path` — so no
     * renderer surface may consume it and it has no `channel-map.ts` entry.
     */
    GET_HEADLESS_INIT: 'capabilities:getHeadlessInit',
    LIST_MCP_TOOLS: 'capabilities:listMcpTools',
    PREVIEW: 'capabilities:preview',
    SUMMARY: 'capabilities:summary',
    OPEN: 'capabilities:open',
    REVEAL: 'capabilities:reveal',
    SUBMIT_MANAGED_EDIT: 'capabilities:submitManagedEdit',
    CHANGED: 'capabilities:changed',
    LIST_TRUST_REVIEWS: 'capabilities:listTrustReviews',
    GRANT_TRUST: 'capabilities:grantTrust',
    REVOKE_TRUST: 'capabilities:revokeTrust',
    DETECT_PROJECT_CONTRIBUTIONS: 'capabilities:detectProjectContributions',
  },
  tasks: {
    /** The background-agent output read (`rpc/sessions.ts`) — NOT a durable-Task channel; see below. */
    GET_OUTPUT: 'tasks:getOutput',
    /**
     * UA3.3 — the DURABLE Tasks family (ported from craft-agents-oss v0.13.4 `channels.ts`, Apache-2.0), handled
     * by `server-core/src/handlers/rpc/tasks.ts`: a task is `{workspaceRoot}/tasks/<slug>/task.yaml` plus its
     * orchestrator session (spec §10). `DELETE` is ours (v0.13.4 has no task delete).
     *
     * NOT `GET_OUTPUT` above, which shares the namespace by history only: `tasks:getOutput` reads a BACKGROUND
     * AGENT's output and is handled in `rpc/sessions.ts`. Its key, class and module do not move; nothing in
     * this family reads it (spec §22 item 8, the `tasks:*` vs `tasks:getOutput` name collision).
     */
    VALIDATE: 'tasks:validate',
    CREATE: 'tasks:create',
    GENERATE: 'tasks:generate',
    /** Push: the authored spec (or an error) for an async `tasks:generate`, keyed by `orchestratorSessionId`. */
    GENERATED: 'tasks:generated',
    RUN: 'tasks:run',
    PAUSE: 'tasks:pause',
    RESUME: 'tasks:resume',
    STOP: 'tasks:stop',
    GET: 'tasks:get',
    LIST: 'tasks:list',
    /** Storage-backed read of a run's outcome (verdict + per-node output); survives a restart. */
    GET_RESULTS: 'tasks:getResults',
    DELETE: 'tasks:delete',
  },
  /**
   * UA1.19 — the Published pages list (t-artifacts, OQ-18; waves.md O23), handled by
   * `server-core/src/handlers/rpc/artifacts.ts`: the signed-in dp identity's own artifacts (`/mine`) joined to this
   * workspace's registry; extend (`SET_RETENTION`) and delete are the user's actions, each behind its own
   * confirmation in the renderer. Ours — upstream v0.13.4 has no counterpart (its share service is cut, reason (a)).
   */
  artifacts: {
    LIST: 'artifacts:list',
    SET_RETENTION: 'artifacts:setRetention',
    DELETE: 'artifacts:delete',
    /**
     * UA1.23 — the user's "Publish" on an inline html-preview / markdown-preview block: `{ sessionId, filePath }`, a
     * PATH and never bytes, handled by the SAME host path as `publish_artifact` (guard → card → client → registry →
     * audit row) with the block's session as the source (`SessionManager.publishArtifactFromUser`).
     */
    PUBLISH_FILE: 'artifacts:publishFile',
    /**
     * UA12.52 — pushed to a workspace's windows when a publish or share lands a row in its registry
     * (`publish_artifact`, the preview's Publish, a chat share, a Pages publish), so an OPEN Published pages
     * section reloads without its Retry button. The payload is the workspace id; the renderer refetches
     * (`artifacts:list`), exactly like the `pages:changed` / `projects:changed` pushes.
     */
    CHANGED: 'artifacts:changed',
  },
  /**
   * UA6.4 — workspace Pages (ported from craft-agents-oss v0.13.4 `channels.ts`, Apache-2.0): agent-authored pages
   * under `{workspaceRoot}/pages/<slug>/`. The core invokes are handled by `server-core/src/handlers/rpc/pages.ts`;
   * grants and actions are UA9.3's, publishing UA6.7's; the poster channels are UA7.4's.
   */
  pages: {
    // UA6.4 — the core family (`rpc/pages.ts`)
    GET: 'pages:get',
    GET_ONE: 'pages:getOne',
    CREATE: 'pages:create',
    UPDATE: 'pages:update',
    DELETE: 'pages:delete',
    GET_CONTENT: 'pages:getContent',
    SET_CONTENT: 'pages:setContent',
    GET_DATA: 'pages:getData',
    /** A render lease bound to the digest of the exact content it returns (the frame renders THAT string). */
    CREATE_LEASE: 'pages:createLease',
    RELEASE_LEASE: 'pages:releaseLease',
    // UA7.4 — the cached poster (`rpc/pages.ts`); capture is Electron-main-only (`main/page-thumbnailer.ts`)
    /** The page's poster as a data URL while it is fresh (its digest is the current content's), else null. */
    GET_THUMBNAIL: 'pages:getThumbnail',
    /** Ask for a (re)capture; a no-op on a host with no capturer (headless). */
    REGENERATE_THUMBNAIL: 'pages:regenerateThumbnail',
    // UA8.3 — scheduled refresh (ours; upstream has no approval or run-now channel, spec §15)
    /** The page's refresh against the ledger, with the script text the person reviews. */
    GET_REFRESH_STATUS: 'pages:getRefreshStatus',
    /** Record the person's approval of the refresh script they reviewed (bound to the digest they were shown). */
    APPROVE_REFRESH: 'pages:approveRefresh',
    /** Run an approved refresh now, through runApprovedScript; the outcome lands on page.json and in history. */
    RUN_REFRESH_NOW: 'pages:runRefreshNow',
    // UA9.3 — grants (the host-approvals ledger, never page.json) and actions (the per-workspace broker)
    /** Every verified grant of a page, stale and expired ones included (validity is enforced at execution). */
    LIST_GRANTS: 'pages:listGrants',
    /** Ours: the descriptor a grant dialog shows as the authority, validated by the host (a script's sha256 now). */
    DESCRIBE_GRANT_REQUEST: 'pages:describeGrantRequest',
    /** Record a grant the person approved, bound to the content on screen (and a script's shown bytes). */
    ISSUE_GRANT: 'pages:issueGrant',
    REVOKE_GRANT: 'pages:revokeGrant',
    /** Run a granted source action through the broker (lease, nonce, replay, ledger grant, policy, audit). */
    EXECUTE_ACTION: 'pages:executeAction',
    CANCEL_ACTION: 'pages:cancelAction',
    /** UA12.112 — a refusal the RENDERER's gate decided (before the broker) reported for the audit trail. */
    AUDIT_REFUSAL: 'pages:auditRefusal',
    /** Push: the workspace's page list after any change (the watcher, the page tools, the pages RPC). */
    CHANGED: 'pages:changed',
    // UA6.7 — publishing on t-artifacts (`server-core/src/pages/page-publishing.ts`). Upstream's
    // `pages:getShareCapabilities` (a feature flag, an offer flag under spec §6) and `pages:setPublicationPassword`
    // (the service has no passwords) are dropped.
    /** Upstream's data scan plus OUR review: the host card for exactly the bytes a publish would send (nothing sent). */
    GET_SHARE_DATA_SCAN: 'pages:getShareDataScan',
    /** Publish or republish the reviewed bytes (one POST or one PUT); refused when they moved since the review. */
    PUBLISH: 'pages:publish',
    /** One DELETE of the page's copy; a retryable failure is kept as a pending deletion (UA1.19). */
    UNPUBLISH: 'pages:unpublish',
  },
} as const

export const OAUTH_FAILURE_CODES = {
  CALLBACK_SERVER_FAILED: 'callback-server-failed',
  METADATA_UNAVAILABLE: 'metadata-unavailable',
  START_FAILED: 'start-failed',
  BROWSER_OPEN_FAILED: 'browser-open-failed',
  PROVIDER_CALLBACK_FAILED: 'provider-callback-failed',
  AUTHORIZATION_CODE_MISSING: 'authorization-code-missing',
  COMPLETE_FAILED: 'complete-failed',
} as const

export type OAuthFailureCode = typeof OAUTH_FAILURE_CODES[keyof typeof OAUTH_FAILURE_CODES]

/**
 * End-to-end budget for plugin operations that may perform bounded network or
 * dependency work.
 *
 * ## D1.124 — a channel ABSENT from this table is not "the default", it is a
 * MISMATCHED pair
 *
 * The consumer is `transport/server.ts` symbol `rpcHandlerTimeoutForChannel`,
 * and it derives the SERVER's handler budget from this table as
 * `entry - 5_000`, falling back to its own `DEFAULT_HANDLER_TIMEOUT_MS` of
 * 60 s when there is no entry. The CLIENT's ceiling is
 * {@link REQUEST_TIMEOUT_MS}, 30 s, whatever the table says. So an entry keeps
 * the two five seconds apart in the right order — the client waits slightly
 * LONGER than the server will run — while an ABSENT entry inverts it: the
 * handler is allowed 60 s and the caller gives up at 30 s.
 *
 * Every operation that takes between those two numbers therefore COMPLETES on
 * the server and is reported to the user as a failure. That is exactly the
 * measured shape of D1.124 — five `sessions:command` timeouts in 75 minutes at
 * the 1.36.0 sitting (RS-28 x2, RS-29 x2, CDX-150) against RS-27 making the
 * identical switch in time twice, with no evidence that any of the five had
 * actually failed.
 *
 * So `sessions:command` gets 65 s: the number is DERIVED, not chosen — 60 s is
 * the server's own default handler budget, which that channel keeps unchanged
 * (`65_000 - 5_000`), and the five seconds put the client on the correct side
 * of it. Nothing runs longer than it does today; what changes is that the
 * client stops calling a completed switch a failure.
 *
 * The bluntness is stated rather than hidden: this channel is CONSOLIDATED, so
 * a genuinely stuck `rename` now takes 65 s rather than 30 s to be reported.
 * That is the cheaper error — a client timeout does not cancel anything, the
 * handler runs on regardless, and the user's other option is being told that
 * something which worked did not. A per-command budget would need a channel
 * split, which is a renderer change too.
 *
 * ## D1.224 — the census of the rest of that class, and what it found
 *
 * The row asked whether the class wants three more entries or the DEFAULT pair
 * inverted. The census answers neither, and names a different set.
 *
 * **The three candidates the row named are each BOUNDED well under 30 s.**
 * `sessions:searchContent` hands `searchSessions` its own `timeout: 5000` plus
 * `maxSessions: 50` and `maxMatchesPerSession: 3`. `sessions:fuzzyFileSearch` is
 * either codex's own app-server call or the host search, and the host search
 * bounds its `git` at 5 s and caps candidates at 20 000
 * (`sessions/host-file-search.ts`). A session IMPORT big enough to be slow never
 * reaches `sessions:import`: `chunked-rpc.ts`'s `CHUNKED_TRANSFER_THRESHOLD`
 * (5 MB) routes it through `transfer:*`, and `transfer:commit` — where the
 * handler actually runs — is in this table at 360 s already.
 *
 * **Inverting the default would cost more than it fixes.** The server's timeout
 * is a `Promise.race` in `transport/server.ts` symbol `onRequest`: it does NOT
 * cancel the handler, so an absent entry MISREPORTS a slow operation without
 * losing its work. Lowering `DEFAULT_HANDLER_TIMEOUT_MS` to sit under the
 * client's 30 s would newly FAIL every handler in the 25–30 s band, which today
 * completes and is reported as success — and it would still not fix a handler
 * slower than 30 s, because only an entry here raises the CLIENT's ceiling.
 * So the table is the lever and the default's order is not.
 *
 * **The real members of the class are the USER-PACED channels**, and their
 * binding constraint is a THIRD timeout: `WsRpcServer.invokeClient` bounds every
 * server→client request at 30 s. Six RPC channels block on one of those — a
 * native file picker, a folder picker, a directory picker, the Git Bash browse,
 * and the two confirmation dialogs — so a user who takes 31 seconds to choose
 * had their answer discarded by the server. `CLIENT_PROPOSE_MCPB` already
 * carried the exception (ten minutes, because a human reads a proposal), which
 * is where the number below comes from rather than from a new judgement:
 * `marketplace:proposeMcpb` is in this table at 600 000 for the same reason, and
 * these six join it. All three layers have to agree — table entry, then the
 * handler budget it derives, then the client invoke — or the innermost decides.
 */
export const RPC_REQUEST_TIMEOUT_BY_CHANNEL: Readonly<Record<string, number>> = Object.freeze({
  [RPC_CHANNELS.marketplace.PROPOSE_MCPB]: 600_000,
  [RPC_CHANNELS.marketplace.INSTALL]: 360_000,
  [RPC_CHANNELS.marketplace.UPGRADE_REGISTRY]: 60_000,
  [RPC_CHANNELS.plugins.MANAGE]: 360_000,
  [RPC_CHANNELS.transfer.COMMIT]: 360_000,
  [RPC_CHANNELS.oauth.START]: 90_000,
  [RPC_CHANNELS.oauth.COMPLETE]: 90_000,
  [RPC_CHANNELS.dpAuth.ENSURE]: 360_000,
  // D1.124 — see the header above: this restores the pair rather than raising a
  // budget. The server side is unchanged at 60 s.
  [RPC_CHANNELS.sessions.COMMAND]: 65_000,
  // D1.224 — the six channels that block on a PERSON. Same 600 000 as
  // `marketplace:proposeMcpb` above, for the same stated reason, and the client
  // invoke they each reach carries the matching budget
  // (`transport/capabilities.ts` symbol `USER_PACED_CLIENT_CHANNELS`).
  [RPC_CHANNELS.file.OPEN_DIALOG]: 600_000,
  [RPC_CHANNELS.dialog.OPEN_FOLDER]: 600_000,
  [RPC_CHANNELS.projects.PICK_LOCAL_DIRECTORY]: 600_000,
  [RPC_CHANNELS.gitbash.BROWSE]: 600_000,
  [RPC_CHANNELS.auth.SHOW_LOGOUT_CONFIRMATION]: 600_000,
  [RPC_CHANNELS.auth.SHOW_DELETE_SESSION_CONFIRMATION]: 600_000,
  // UA1.19 — each call asks dp for a token (`dp auth print-token`, up to 30 s) and then makes one request (up to 30 s),
  // so 60 s is the honest ceiling and the D1.124 pair is restored by the same `+ 5 s` as `sessions:command`. The list
  // also STARTS owed deletions for `PENDING_DELETE_RETRY_WINDOW_MS` (20 s), the last one token + request: 60+20+60+5.
  [RPC_CHANNELS.artifacts.LIST]: 145_000,
  [RPC_CHANNELS.artifacts.SET_RETENTION]: 65_000,
  [RPC_CHANNELS.artifacts.DELETE]: 65_000,
  // UA1.23 — this call WAITS for a person: up to TWO publish cards (110 s each, `PUBLISH_ARTIFACT_CARD_TIMEOUT_MS`; the 2nd when the file changed
  // under the 1st), then dp's token (≤ 30 s) and one request (≤ 30 s) = 280 s; 300 s (handler 295 s) leaves room for the guard reads and
  // the registry write. Each card still times out at 110 s to a deny; pinned by session-command-timeout.test.ts (UA1.23).
  [RPC_CHANNELS.artifacts.PUBLISH_FILE]: 300_000,
  // UA6.7 — a page publish, an unpublish and a page delete (it unpublishes a published page first) each ask dp for a
  // token (≤ 30 s) and make one request (≤ 30 s): the UA1.19 ceiling, + 5 s (the D1.124 pair). The review sends nothing.
  [RPC_CHANNELS.pages.PUBLISH]: 65_000,
  [RPC_CHANNELS.pages.UNPUBLISH]: 65_000,
  [RPC_CHANNELS.pages.DELETE]: 65_000,
})

// IPC_CHANNELS compat alias removed — all consumers now use RPC_CHANNELS

type RpcChannels = typeof RPC_CHANNELS

/**
 * Every declared RPC channel wire string, as a union of literal types.
 *
 * This is the type-level twin of `getAllChannelValues()`, and it is what makes
 * the routing table in `routing.ts` exhaustive AT COMPILE TIME rather than only
 * under `bun test`. Note the mapped type: `RPC_CHANNELS[keyof RPC_CHANNELS]` is
 * a union of namespace OBJECTS, and `keyof` of a union is the INTERSECTION of
 * its members' keys — which is empty here, silently collapsing the whole type
 * to `never` and making every downstream assertion vacuously true. Distribute
 * over the namespaces first (measured 2026-08-28; the naive spelling type-
 * checked clean and proved nothing).
 */
export type RpcChannelValue = {
  [Namespace in keyof RpcChannels]: RpcChannels[Namespace][keyof RpcChannels[Namespace]]
}[keyof RpcChannels]

/**
 * Pseudo-channels the TRANSPORT CLIENT emits about itself. No server ever
 * handles one, so they are deliberately not in `RPC_CHANNELS` and are not
 * counted by `getAllChannelValues()` — but they DO pass through
 * `RoutedClient`, which means each one still needs a locality decision.
 * `routing.ts` classifies them alongside the RPC channels.
 */
export const TRANSPORT_INTERNAL_CHANNELS = {
  /** Synthetic reconnect signal (`WsRpcClient.emitReconnected`); drives stale recovery. */
  RECONNECTED: '__transport:reconnected',
} as const

export type TransportInternalChannel =
  typeof TRANSPORT_INTERNAL_CHANNELS[keyof typeof TRANSPORT_INTERNAL_CHANNELS]

/**
 * Flatten all channel string values from the nested RPC_CHANNELS object.
 * Used by the exhaustive routing test to ensure every channel is classified.
 */
export function getAllChannelValues(): string[] {
  const values: string[] = []
  for (const namespace of Object.values(RPC_CHANNELS)) {
    for (const channel of Object.values(namespace)) {
      values.push(channel)
    }
  }
  return values
}
