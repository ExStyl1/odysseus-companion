/**
 * Exhaustive channel routing table for hybrid local/remote transport.
 *
 * Every RPC channel must belong to exactly one of two sets:
 * - LOCAL_ONLY: Always runs on the local Electron server, never proxied.
 * - REMOTE_ELIGIBLE: Runs on whichever server owns the workspace.
 *
 * ## Both sets are load-bearing, and the table is total by construction
 *
 * `channelLocality()` below is the ONLY routing decision, and it reaches
 * `'workspace'` exclusively through membership in `REMOTE_ELIGIBLE_CHANNELS`.
 * A channel in neither set is `'unclassified'`, and `RoutedClient`
 * (`apps/electron/src/transport/routed-client.ts`) REFUSES it rather than
 * picking a server. Crossing to another machine is now something a channel is
 * granted, not something it gets by not being mentioned.
 *
 * Three guards make an unclassified channel impossible rather than merely
 * discouraged, weakest last:
 *
 * 1. **`tsc`.** `CHANNELS_IN_NEITHER_ROUTING_SET` must be `never`, so a new
 *    entry in `RPC_CHANNELS` that nobody classifies fails the TYPECHECK. The
 *    same assertions reject a channel in BOTH sets and a string in a set that
 *    is not a declared channel.
 * 2. **Runtime refusal.** A channel string that never reached `RPC_CHANNELS` at
 *    all — invisible to both the typecheck and the test — throws
 *    `UnclassifiedChannelError` at the router instead of being routed.
 * 3. **The exhaustiveness test** (`__tests__/routing.test.ts`), which still
 *    names the offending channel and catches drift in `getAllChannelValues()`.
 *
 * ## History: this was FAIL-OPEN, and shipped that way
 *
 * Until P2.296, `RoutedClient` routed on `isLocalOnly()` alone, so the
 * COMPLEMENT of `LOCAL_ONLY` crossed — including channels in neither set —
 * while `REMOTE_ELIGIBLE` and `isRemoteEligible()` had zero production call
 * sites (measured 2026-08-28). The second set read exactly like enforcement and
 * enforced nothing: hardening routing by adding a channel to it achieved
 * literally nothing. `workspace:importClaudePreview` / `…Apply` shipped
 * unclassified under that regime (P2.282) and reached the remote server with
 * nobody deciding they should.
 *
 * ## "Remote" means the OPPOSITE thing one document away
 *
 * Here, remote/`REMOTE_ELIGIBLE` is about the DESTINATION SERVER and means MORE
 * reach — permitted to leave this machine.
 *
 * In `docs/architecture/transport-locality.md` it is about the CALLING CLIENT's
 * advertised capability set (`isLocalClient`) and means FEWER privileges — its
 * "Fail closed. An unknown or empty capability set reads as REMOTE." is a
 * genuine fail-closed because remote is the restricted end there.
 *
 * Identical word, inverted polarity. Do not carry a conclusion from one to the
 * other; see that document's "Two senses of 'remote'" section.
 */

import { RPC_CHANNELS, TRANSPORT_INTERNAL_CHANNELS } from './channels'
import type { RpcChannelValue, TransportInternalChannel } from './channels'

// ---------------------------------------------------------------------------
// LOCAL_ONLY — fundamentally requires local OS / Electron
// ---------------------------------------------------------------------------

const LOCAL_ONLY_LIST = [
  // remote — local connectivity management (reaches out to remote server from local app)
  RPC_CHANNELS.remote.TEST_CONNECTION,

  // workspaces — local workspace CRUD (workspace list is local config)
  RPC_CHANNELS.workspaces.GET,
  RPC_CHANNELS.workspaces.CREATE,
  RPC_CHANNELS.workspaces.CONNECT_REMOTE,
  RPC_CHANNELS.workspaces.UPDATE_REMOTE,
  RPC_CHANNELS.workspaces.CREATE_ON_REMOTE,
  // P6.501 — the registry the purge edits is this machine's local config, so
  // it belongs with its CRUD siblings above and never crosses.
  RPC_CHANNELS.workspaces.DELETE,

  // projects — native picker runs on the user's local desktop
  RPC_CHANNELS.projects.PICK_LOCAL_DIRECTORY,

  // window — Electron window management
  RPC_CHANNELS.window.GET_WORKSPACE,
  RPC_CHANNELS.window.GET_MODE,
  RPC_CHANNELS.window.OPEN_WORKSPACE,
  RPC_CHANNELS.window.OPEN_SESSION_IN_NEW_WINDOW,
  RPC_CHANNELS.window.SWITCH_WORKSPACE,
  RPC_CHANNELS.window.CLOSE,
  RPC_CHANNELS.window.CLOSE_REQUESTED,
  RPC_CHANNELS.window.CONFIRM_CLOSE,
  RPC_CHANNELS.window.CANCEL_CLOSE,
  RPC_CHANNELS.window.SET_TRAFFIC_LIGHTS,
  RPC_CHANNELS.window.FOCUS_STATE,
  RPC_CHANNELS.window.GET_FOCUS_STATE,

  // file — native file dialog
  RPC_CHANNELS.file.OPEN_DIALOG,
  // file — draft hydration for user-attached paths. Paths in drafts.json were captured
  // via webUtils.getPathForFile in the renderer, so they point at the user's local machine
  // — even when the workspace itself lives on a remote server. Routing this REMOTE_ELIGIBLE
  // would send the local path to a remote filesystem that can't resolve it.
  RPC_CHANNELS.file.READ_USER_ATTACHMENT,

  // dialog — native folder dialog
  RPC_CHANNELS.dialog.OPEN_FOLDER,

  // auth — local auth state + native dialogs
  RPC_CHANNELS.auth.LOGOUT,
  RPC_CHANNELS.auth.SHOW_LOGOUT_CONFIRMATION,
  RPC_CHANNELS.auth.SHOW_DELETE_SESSION_CONFIRMATION,

  // shell — local OS shell (openFile/showInFolder guarded for remote)
  RPC_CHANNELS.shell.OPEN_URL,
  RPC_CHANNELS.shell.OPEN_FILE,
  RPC_CHANNELS.shell.SHOW_IN_FOLDER,

  // skills — local filesystem actions (guarded for remote)
  RPC_CHANNELS.skills.OPEN_EDITOR,
  RPC_CHANNELS.skills.OPEN_FINDER,

  // capabilities — opens/reveals a resolved managed resource in the local OS
  RPC_CHANNELS.capabilities.OPEN,
  RPC_CHANNELS.capabilities.REVEAL,
  // capabilities — MCP tools list reads the LIVE session's in-process MCP client
  // pool, which only exists on the local Electron server that runs the session
  // (like guardian's local-only reads). Session-scoped, fail-soft, no connect.
  RPC_CHANNELS.capabilities.LIST_MCP_TOOLS,

  // system — local OS info
  RPC_CHANNELS.system.VERSIONS,
  RPC_CHANNELS.system.HOME_DIR,
  RPC_CHANNELS.system.IS_DEBUG_MODE,

  // theme — app/OS-level preferences, not workspace content
  RPC_CHANNELS.theme.GET_SYSTEM_PREFERENCE,
  RPC_CHANNELS.theme.SYSTEM_CHANGED,
  RPC_CHANNELS.theme.APP_CHANGED,
  RPC_CHANNELS.theme.GET_APP,
  RPC_CHANNELS.theme.GET_PRESETS,
  RPC_CHANNELS.theme.LOAD_PRESET,
  RPC_CHANNELS.theme.GET_COLOR_THEME,
  RPC_CHANNELS.theme.SET_COLOR_THEME,
  RPC_CHANNELS.theme.BROADCAST_PREFERENCES,
  RPC_CHANNELS.theme.PREFERENCES_CHANGED,
  RPC_CHANNELS.theme.GET_WORKSPACE_COLOR_THEME,
  RPC_CHANNELS.theme.SET_WORKSPACE_COLOR_THEME,
  RPC_CHANNELS.theme.GET_ALL_WORKSPACE_THEMES,
  RPC_CHANNELS.theme.BROADCAST_WORKSPACE_THEME,
  RPC_CHANNELS.theme.WORKSPACE_THEME_CHANGED,

  // update — local auto-update
  RPC_CHANNELS.update.CHECK,
  RPC_CHANNELS.update.GET_INFO,
  RPC_CHANNELS.update.INSTALL,
  RPC_CHANNELS.update.DISMISS,
  RPC_CHANNELS.update.GET_DISMISSED,
  RPC_CHANNELS.update.AVAILABLE,
  RPC_CHANNELS.update.DOWNLOAD_PROGRESS,

  // releaseNotes — local app info
  RPC_CHANNELS.releaseNotes.GET,
  RPC_CHANNELS.releaseNotes.GET_LATEST_VERSION,

  // badge — local dock badge
  RPC_CHANNELS.badge.REFRESH,
  RPC_CHANNELS.badge.SET_ICON,
  RPC_CHANNELS.badge.DRAW,
  RPC_CHANNELS.badge.DRAW_WINDOWS,

  // menu — local menu events
  RPC_CHANNELS.menu.NEW_CHAT,
  RPC_CHANNELS.menu.NEW_WINDOW,
  RPC_CHANNELS.menu.OPEN_SETTINGS,
  RPC_CHANNELS.menu.KEYBOARD_SHORTCUTS,
  RPC_CHANNELS.menu.TOGGLE_FOCUS_MODE,
  RPC_CHANNELS.menu.TOGGLE_SIDEBAR,
  RPC_CHANNELS.menu.QUIT,
  RPC_CHANNELS.menu.MINIMIZE,
  RPC_CHANNELS.menu.MAXIMIZE,
  RPC_CHANNELS.menu.ZOOM_IN,
  RPC_CHANNELS.menu.ZOOM_OUT,
  RPC_CHANNELS.menu.ZOOM_RESET,
  RPC_CHANNELS.menu.TOGGLE_DEV_TOOLS,
  RPC_CHANNELS.menu.UNDO,
  RPC_CHANNELS.menu.REDO,
  RPC_CHANNELS.menu.CUT,
  RPC_CHANNELS.menu.COPY,
  RPC_CHANNELS.menu.PASTE,
  RPC_CHANNELS.menu.SELECT_ALL,

  // deeplink — local deep link handling
  RPC_CHANNELS.deeplink.NAVIGATE,

  // notification — local OS notifications
  RPC_CHANNELS.notification.SHOW,
  RPC_CHANNELS.notification.NAVIGATE,
  RPC_CHANNELS.notification.GET_ENABLED,
  RPC_CHANNELS.notification.SET_ENABLED,
  RPC_CHANNELS.notification.GET_SETTINGS,
  RPC_CHANNELS.notification.SET_SETTINGS,

  // input — local input preferences
  RPC_CHANNELS.input.GET_AUTO_CAPITALISATION,
  RPC_CHANNELS.input.SET_AUTO_CAPITALISATION,
  RPC_CHANNELS.input.GET_SEND_MESSAGE_KEY,
  RPC_CHANNELS.input.SET_SEND_MESSAGE_KEY,
  RPC_CHANNELS.input.GET_SPELL_CHECK,
  RPC_CHANNELS.input.SET_SPELL_CHECK,

  // power — local power management
  RPC_CHANNELS.power.GET_KEEP_AWAKE,
  RPC_CHANNELS.power.SET_KEEP_AWAKE,

  // appearance — local UI preferences
  RPC_CHANNELS.appearance.GET_RICH_TOOL_DESCRIPTIONS,
  RPC_CHANNELS.appearance.SET_RICH_TOOL_DESCRIPTIONS,

  // caching — prompt cache settings
  RPC_CHANNELS.caching.GET_EXTENDED_PROMPT_CACHE,
  RPC_CHANNELS.caching.SET_EXTENDED_PROMPT_CACHE,
  // F1.1241 — caching:getEnable1MContext / setEnable1MContext left with the
  // Extended context switch; each model's own window decides.

  // rtk — token-optimization opt-in
  RPC_CHANNELS.rtk.GET_ENABLED,
  RPC_CHANNELS.rtk.SET_ENABLED,
  RPC_CHANNELS.rtk.GET_STATUS,
  RPC_CHANNELS.rtk.GET_GAIN,

  // UB6.3 — decisions: the settings and keys live on the server whose sessions ask the
  // model (it can reuse that server's LLM connections). ALL EIGHT are REMOTE_ELIGIBLE —
  // a remote client may READ and may change non-endpoint settings; the SEC-8 refusal
  // (provider, base URL, connection or key changes from a non-local client) is the
  // HANDLER's, in rpc/decisions.ts, not a routing class.
  RPC_CHANNELS.decisions.GET_SETTINGS,
  RPC_CHANNELS.decisions.SET_SETTINGS,
  RPC_CHANNELS.decisions.GET_STATUS,
  RPC_CHANNELS.decisions.SET_API_KEY,
  RPC_CHANNELS.decisions.DELETE_API_KEY,
  RPC_CHANNELS.decisions.TEST,
  RPC_CHANNELS.decisions.PROBE_SERVER,
  RPC_CHANNELS.decisions.GET_USAGE,

  // guardian — safety judge enable + model selection
  RPC_CHANNELS.guardian.GET_ENABLED,
  RPC_CHANNELS.guardian.SET_ENABLED,
  RPC_CHANNELS.guardian.GET_MODEL,
  RPC_CHANNELS.guardian.SET_MODEL,
  RPC_CHANNELS.guardian.GET_MODELS_BY_CONNECTION,
  RPC_CHANNELS.guardian.SET_MODEL_FOR_CONNECTION,

  // advisor — advising-model enable + model selection (P2.528). Classified with
  // guardian rather than with `settings` because it is the same CLASS of key:
  // one install-wide entry in `~/.nessy-agent/config.json`, written through the
  // local Electron server. It therefore inherits guardian's residue rather than
  // introducing a new one — a remote server's agent reads its own config file,
  // so the value the renderer writes here governs local sessions.
  RPC_CHANNELS.advisor.GET_ENABLED,
  RPC_CHANNELS.advisor.SET_ENABLED,
  RPC_CHANNELS.advisor.GET_MODEL,
  RPC_CHANNELS.advisor.SET_MODEL,

  // codexAutoReview — codex's own approval reviewer (P6.225). Local for the same
  // reason as advisor directly above: one install-wide entry in
  // `~/.nessy-agent/config.json`, written through the local Electron server, and
  // consumed when THIS machine writes codex's config file.
  RPC_CHANNELS.codexAutoReview.GET_ENABLED,
  RPC_CHANNELS.codexAutoReview.SET_ENABLED,
  RPC_CHANNELS.codexAutoReview.GET_POLICY,
  RPC_CHANNELS.codexAutoReview.SET_POLICY,

  // codexSubagents — codex's own delegation off-switch (C3.286, the in-app half
  // of C3.109). Local for the same reason as the pair above: one install-wide
  // boolean in `~/.nessy-agent/config.json`, consumed when THIS machine writes
  // codex's config file, so answering it from another server would report and
  // set the wrong machine's switch.
  RPC_CHANNELS.codexSubagents.GET_ENABLED,
  RPC_CHANNELS.codexSubagents.SET_ENABLED,

  // primaryDirectory — which attached folder is primary (C3.178). Local for the
  // same reason as the pairs above, and one of its own: both the choice and the
  // candidate list come from THIS machine's `~/.nessy-agent/config.json`
  // (`primaryDirectory` beside `additionalDirectories`), and the candidates are
  // absolute paths on THIS filesystem — a remote answer would offer folders that
  // do not exist here.
  RPC_CHANNELS.primaryDirectory.GET,
  RPC_CHANNELS.primaryDirectory.SET,

  // settings — the settings-file tiers diagnosis (P6.576). Local for
  // `GET_PROVENANCE`'s reason: it stats and parses THIS machine's managed policy
  // file, its delivery cache and its config.json, so answering it from another
  // server would describe the wrong machine.
  RPC_CHANNELS.settings.GET_CONFIG_DOCTOR,

  // permissions — the auto-mode judge's own rules (P6.209). Local: the block
  // is composed from THIS machine's managed policy floor, so a remote answer
  // would describe another host's judge.
  RPC_CHANNELS.permissions.GET_AUTO_MODE_POLICY,

  // tools — local tool settings
  RPC_CHANNELS.tools.GET_BROWSER_TOOL_ENABLED,
  RPC_CHANNELS.tools.SET_BROWSER_TOOL_ENABLED,
  // P6.564 — local for the same reason as its neighbour above: the browser pane
  // and its download directory belong to the machine the app runs on, and the
  // environment half of the policy is that process's own.
  RPC_CHANNELS.tools.GET_BROWSER_DOWNLOAD_SETTINGS,
  RPC_CHANNELS.tools.SET_BROWSER_DOWNLOAD_SETTINGS,

  // retention — the local config.json window and off switch for the startup
  // cleanup sweep. Local like every other config.json setting: the sweep runs in
  // whichever process owns this machine's config dir.
  RPC_CHANNELS.retention.GET_SETTINGS,
  RPC_CHANNELS.retention.SET_DAYS,
  RPC_CHANNELS.retention.SET_SWEEP_ENABLED,

  // permissions — bypassPermissions responsibility acknowledgment (T5). Local
  // like retention above: a per-install config.json flag, not workspace state
  // — unlike GET_MCP_CHANNEL_PUSH/GET_ISOLATION_CAPABILITIES below, nothing
  // about it is enforced on whichever server owns a workspace.
  RPC_CHANNELS.permissions.GET_BYPASS_PERMISSIONS_ACKNOWLEDGED,
  RPC_CHANNELS.permissions.SET_BYPASS_PERMISSIONS_ACKNOWLEDGED,

  // browserPane — Electron BrowserView
  RPC_CHANNELS.browserPane.CREATE,
  RPC_CHANNELS.browserPane.DESTROY,
  RPC_CHANNELS.browserPane.LIST,
  RPC_CHANNELS.browserPane.NAVIGATE,
  RPC_CHANNELS.browserPane.GO_BACK,
  RPC_CHANNELS.browserPane.GO_FORWARD,
  RPC_CHANNELS.browserPane.RELOAD,
  RPC_CHANNELS.browserPane.STOP,
  RPC_CHANNELS.browserPane.FOCUS,
  RPC_CHANNELS.browserPane.SNAPSHOT,
  RPC_CHANNELS.browserPane.CLICK,
  RPC_CHANNELS.browserPane.FILL,
  RPC_CHANNELS.browserPane.SELECT,
  RPC_CHANNELS.browserPane.SCREENSHOT,
  RPC_CHANNELS.browserPane.EVALUATE,
  RPC_CHANNELS.browserPane.SCROLL,
  RPC_CHANNELS.browserPane.LAUNCH,
  RPC_CHANNELS.browserPane.TRUST_LIST,
  RPC_CHANNELS.browserPane.TRUST_REVOKE,
  RPC_CHANNELS.browserPane.STATE_CHANGED,
  RPC_CHANNELS.browserPane.REMOVED,
  RPC_CHANNELS.browserPane.INTERACTED,

  // gitbash — Windows-specific local
  RPC_CHANNELS.gitbash.CHECK,
  RPC_CHANNELS.gitbash.BROWSE,
  RPC_CHANNELS.gitbash.SET_PATH,

  // debug — local debug logging
  RPC_CHANNELS.debug.LOG,

  // onboarding — local auth setup flow
  RPC_CHANNELS.onboarding.GET_AUTH_STATE,
  RPC_CHANNELS.onboarding.VALIDATE_MCP,
  RPC_CHANNELS.onboarding.START_MCP_OAUTH,
  RPC_CHANNELS.onboarding.DEFER_SETUP,
  RPC_CHANNELS.settings.GET_NETWORK_PROXY,
  RPC_CHANNELS.settings.SET_NETWORK_PROXY,

  // server config — local embedded server settings
  RPC_CHANNELS.settings.GET_SERVER_CONFIG,
  RPC_CHANNELS.settings.SET_SERVER_CONFIG,
  RPC_CHANNELS.settings.GET_SERVER_STATUS,
] as const satisfies readonly RpcChannelValue[]

export const LOCAL_ONLY_CHANNELS = new Set<string>(LOCAL_ONLY_LIST)

// ---------------------------------------------------------------------------
// REMOTE_ELIGIBLE — runs on whichever server owns the workspace
// ---------------------------------------------------------------------------

const REMOTE_ELIGIBLE_LIST = [
  // server — server-level operations (no workspace context needed)
  RPC_CHANNELS.server.GET_WORKSPACES,
  RPC_CHANNELS.server.CREATE_WORKSPACE,
  RPC_CHANNELS.server.GET_STATUS,
  RPC_CHANNELS.server.GET_HEALTH,
  RPC_CHANNELS.server.GET_ACTIVE_SESSIONS,
  RPC_CHANNELS.server.SHUTTING_DOWN,
  RPC_CHANNELS.server.STATUS_CHANGED,
  RPC_CHANNELS.server.HOME_DIR,

  // projects — validation/history/session mutation run on the Workspace owner
  RPC_CHANNELS.projects.VALIDATE_DIRECTORY,
  RPC_CHANNELS.projects.LIST_RECENT,
  RPC_CHANNELS.projects.ISSUE_RECENT_HANDLE,
  RPC_CHANNELS.projects.SET_TRUST,
  RPC_CHANNELS.projects.SET_SESSION_PROJECT,
  RPC_CHANNELS.projects.SET_WORKSPACE_DEFAULT,

  // sessions — core session runtime
  RPC_CHANNELS.sessions.GET,
  RPC_CHANNELS.sessions.GET_PI_HARNESS_RUNTIME,
  RPC_CHANNELS.sessions.CONTROL_PI_HARNESS_RUNTIME,
  RPC_CHANNELS.sessions.LIST_PI_AGENT_VIEW,
  RPC_CHANNELS.sessions.CONTROL_PI_AGENT_VIEW,
  RPC_CHANNELS.sessions.GET_UNREAD_SUMMARY,
  RPC_CHANNELS.sessions.MARK_ALL_READ,
  RPC_CHANNELS.sessions.UNREAD_SUMMARY_CHANGED,
  RPC_CHANNELS.sessions.CREATE,
  RPC_CHANNELS.sessions.DELETE,
  RPC_CHANNELS.sessions.GET_MESSAGES,
  RPC_CHANNELS.sessions.SEND_MESSAGE,
  RPC_CHANNELS.sessions.CANCEL,
  RPC_CHANNELS.sessions.FUZZY_FILE_SEARCH,
  RPC_CHANNELS.sessions.QUEUE_GET,
  RPC_CHANNELS.sessions.QUEUE_DELETE,
  RPC_CHANNELS.sessions.QUEUE_REORDER,
  RPC_CHANNELS.sessions.QUEUE_SEND_NOW,
  RPC_CHANNELS.sessions.QUEUE_RESUME,
  RPC_CHANNELS.sessions.GIT_BRANCHES,
  RPC_CHANNELS.sessions.GIT_CHECKOUT,
  RPC_CHANNELS.sessions.KILL_SHELL,
  RPC_CHANNELS.sessions.STOP_AGENT_TASK,
  RPC_CHANNELS.sessions.READ_TASK_OUTPUT,
  RPC_CHANNELS.sessions.RESPOND_TO_PERMISSION,
  RPC_CHANNELS.sessions.REVOKE_FILESYSTEM_ROOT,
  RPC_CHANNELS.sessions.RESPOND_TO_CREDENTIAL,
  RPC_CHANNELS.sessions.COMMAND,
  RPC_CHANNELS.sessions.GET_PENDING_PLAN_EXECUTION,
  RPC_CHANNELS.sessions.GET_PERMISSION_MODE_STATE,
  // P6.411 — the session's own withheld record, held by whichever server runs
  // the session; a local answer would describe a session that is not there.
  RPC_CHANNELS.sessions.GET_CAPABILITY_INVENTORY,
  // P6.711 — the pool being restarted belongs to the session, which lives on
  // whichever server runs it; a local reconnect would restart a pool nobody's
  // turn is using.
  RPC_CHANNELS.sessions.RECONNECT_MCP_SERVER,
  // P6.750 — the inventory belongs to the session's own pool and runtime, which
  // live on whichever server runs it; a local read would describe a pool nobody
  // is using.
  RPC_CHANNELS.sessions.GET_MCP_SERVER_STATUSES,
  // P6.318 — the save lands beside the session's own project, on the machine
  // that runs it; a local write would put the recipe on the wrong host.
  RPC_CHANNELS.sessions.SAVE_WORKFLOW_RECIPE,
  // D1.97/D1.98 — the cron store and the monitor registry are the session's own
  // live state, held by whichever server runs it; a local read would describe a
  // session that is not there and report "nothing queued" about one that has
  // work in flight.
  RPC_CHANNELS.sessions.LIST_SCHEDULED_WORK,
  RPC_CHANNELS.sessions.EVENT,
  RPC_CHANNELS.sessions.GET_MODEL,
  RPC_CHANNELS.sessions.SET_MODEL,
  RPC_CHANNELS.sessions.GET_RECENT_STDERR,
  // P6.703 — per-chat state, so it belongs to the server that owns the chat.
  RPC_CHANNELS.sessions.GET_MEMORY_SCOPE,
  RPC_CHANNELS.sessions.SET_MEMORY_SCOPE,
  // P6.209 (A42) — session-scoped, unlike `permissions:getAutoModePolicy` beside
  // it in the namespace: the ring lives on the agent, so the answer comes from
  // the server that owns the session rather than from this machine.
  RPC_CHANNELS.permissions.GET_AUTO_MODE_DENIALS,
  // P6.361 — both are answered by the server that owns the session: the store is
  // read from that host's settings and the command runs in that host's shell.
  RPC_CHANNELS.workspaceActions.LIST,
  RPC_CHANNELS.workspaceActions.RUN,
  RPC_CHANNELS.sessions.GET_FILES,
  RPC_CHANNELS.sessions.OPEN_FILE,
  RPC_CHANNELS.sessions.PREVIEW_FILE,
  RPC_CHANNELS.sessions.OPEN_ATTACHMENT,
  RPC_CHANNELS.sessions.REVEAL_STORAGE,
  RPC_CHANNELS.sessions.COPY_STORAGE_PATH,
  RPC_CHANNELS.sessions.OPEN_ARTIFACT,
  RPC_CHANNELS.sessions.GET_NOTES,
  RPC_CHANNELS.sessions.SET_NOTES,
  RPC_CHANNELS.sessions.WATCH_FILES,
  RPC_CHANNELS.sessions.UNWATCH_FILES,
  RPC_CHANNELS.sessions.FILES_CHANGED,
  RPC_CHANNELS.sessions.SEARCH_CONTENT,
  RPC_CHANNELS.sessions.EXPORT,
  RPC_CHANNELS.sessions.IMPORT,
  RPC_CHANNELS.sessions.EXPORT_REMOTE_TRANSFER,
  RPC_CHANNELS.sessions.IMPORT_REMOTE_TRANSFER,

  // transfer — chunked large-payload import (sessions, resources)
  RPC_CHANNELS.transfer.START,
  RPC_CHANNELS.transfer.CHUNK,
  RPC_CHANNELS.transfer.COMMIT,
  RPC_CHANNELS.transfer.ABORT,

  // tasks — workspace content: the background-output read; the durable Tasks family (UA3.3) is listed at the end
  RPC_CHANNELS.tasks.GET_OUTPUT,

  // file — workspace files (not openDialog which is native)
  RPC_CHANNELS.file.READ,
  RPC_CHANNELS.file.READ_DATA_URL,
  RPC_CHANNELS.file.READ_PREVIEW_DATA_URL,
  RPC_CHANNELS.file.READ_BINARY,
  RPC_CHANNELS.file.READ_ATTACHMENT,
  RPC_CHANNELS.file.STORE_ATTACHMENT,
  RPC_CHANNELS.file.GENERATE_THUMBNAIL,

  // fs — workspace filesystem
  RPC_CHANNELS.fs.SEARCH,
  RPC_CHANNELS.fs.LIST_DIRECTORY,

  // credentials — remote server's credential state
  RPC_CHANNELS.credentials.HEALTH_CHECK,

  // llmConnections — LLM config lives on server running workspace
  RPC_CHANNELS.llmConnections.LIST,
  RPC_CHANNELS.llmConnections.LIST_WITH_STATUS,
  RPC_CHANNELS.llmConnections.GET,
  RPC_CHANNELS.llmConnections.GET_API_KEY,
  RPC_CHANNELS.llmConnections.SAVE,
  RPC_CHANNELS.llmConnections.DELETE,
  RPC_CHANNELS.llmConnections.TEST,
  RPC_CHANNELS.llmConnections.SET_DEFAULT,
  RPC_CHANNELS.llmConnections.SET_WORKSPACE_DEFAULT,
  RPC_CHANNELS.llmConnections.REFRESH_MODELS,
  RPC_CHANNELS.llmConnections.CHANGED,

  // chatgpt — OAuth via capability passthrough
  RPC_CHANNELS.chatgpt.START_OAUTH,
  RPC_CHANNELS.chatgpt.COMPLETE_OAUTH,
  RPC_CHANNELS.chatgpt.CANCEL_OAUTH,
  RPC_CHANNELS.chatgpt.GET_AUTH_STATUS,
  RPC_CHANNELS.chatgpt.LOGOUT,

  // copilot — OAuth via capability passthrough
  RPC_CHANNELS.copilot.START_OAUTH,
  RPC_CHANNELS.copilot.CANCEL_OAUTH,
  RPC_CHANNELS.copilot.GET_AUTH_STATUS,
  RPC_CHANNELS.copilot.LOGOUT,
  RPC_CHANNELS.copilot.DEVICE_CODE,

  // Claude OAuth — runs on workspace server so credentials and connection config
  // end up on the same server that will use them. Browser opening is client-side.
  // (ChatGPT OAuth stays LOCAL_ONLY — requires localhost callback server.)
  RPC_CHANNELS.onboarding.START_CLAUDE_OAUTH,
  RPC_CHANNELS.onboarding.EXCHANGE_CLAUDE_CODE,
  RPC_CHANNELS.onboarding.HAS_CLAUDE_OAUTH_STATE,
  RPC_CHANNELS.onboarding.CLEAR_CLAUDE_OAUTH_STATE,

  // settings — workspace-level settings
  RPC_CHANNELS.settings.SETUP_LLM_CONNECTION,
  RPC_CHANNELS.settings.TEST_LLM_CONNECTION_SETUP,
  RPC_CHANNELS.settings.GET_DEFAULT_THINKING_LEVEL,
  RPC_CHANNELS.settings.SET_DEFAULT_THINKING_LEVEL,
  RPC_CHANNELS.settings.GET_OUTPUT_STYLE,
  RPC_CHANNELS.settings.SET_OUTPUT_STYLE,
  RPC_CHANNELS.settings.LIST_OUTPUT_STYLES,
  // P6.168 — REMOTE_ELIGIBLE and not local-only, because the settings whose
  // provenance it reports are resolved on the machine running the sessions:
  // the workspace root, the project's `.claude` files and the managed policy
  // all live there. Answering it locally would name a different host's files.
  RPC_CHANNELS.settings.GET_PROVENANCE,
  RPC_CHANNELS.settings.GET_WORKFLOW,
  RPC_CHANNELS.settings.SET_WORKFLOW_SIZE_GUIDELINE,
  // P6.868 — REMOTE_ELIGIBLE for `GET_PROVENANCE`'s reason and not local-only:
  // the value is enforced in `SessionManager.resolveInboundModeFor` on whichever
  // server owns the workspace, and both rungs it reports — that server's
  // config.json and that server's `NESSY_CROSS_SESSION_INBOUND` — live there.
  // Answering locally would show the user a different host's setting.
  RPC_CHANNELS.settings.GET_CROSS_SESSION_INBOUND,
  RPC_CHANNELS.settings.SET_CROSS_SESSION_INBOUND,

  // pi — provider config on workspace server
  RPC_CHANNELS.pi.GET_API_KEY_PROVIDERS,
  RPC_CHANNELS.pi.GET_PROVIDER_BASE_URL,
  RPC_CHANNELS.pi.GET_PROVIDER_MODELS,

  // preferences — workspace-level preferences
  RPC_CHANNELS.preferences.READ,
  RPC_CHANNELS.preferences.WRITE,

  // plugins — marketplace/cache/projection state belongs to the workspace server
  RPC_CHANNELS.plugins.MANAGE,

  // marketplace — safe catalog reads plus ID/ref-based install actions, and
  // the R3 bring-your-own registry mutations (add/upgrade/remove/list).
  RPC_CHANNELS.marketplace.LIST,
  RPC_CHANNELS.marketplace.CONTENT,
  RPC_CHANNELS.marketplace.COMPONENTS,
  RPC_CHANNELS.marketplace.PROPOSE_INSTALL,
  RPC_CHANNELS.marketplace.PROPOSE_MCPB,
  RPC_CHANNELS.marketplace.UPLOAD_MCPB,
  RPC_CHANNELS.marketplace.INSTALL,
  RPC_CHANNELS.marketplace.ADD_REGISTRY,
  RPC_CHANNELS.marketplace.UPGRADE_REGISTRY,
  RPC_CHANNELS.marketplace.REMOVE_REGISTRY,
  RPC_CHANNELS.marketplace.LIST_REGISTRIES,
  RPC_CHANNELS.marketplace.SET_REGISTRY_AUTO_UPDATE,
  RPC_CHANNELS.marketplace.ENABLE_OFFER,
  // P6.563 — REMOTE_ELIGIBLE, and not local-only, for the same reason
  // `plugins.MANAGE` is: the live sessions whose runtime it refreshes belong to
  // whichever server owns the workspace. Refreshing locally would tear down
  // nothing on the machine that is actually running them.
  RPC_CHANNELS.marketplace.REFRESH_RUNTIME,

  // drafts — workspace content
  RPC_CHANNELS.drafts.GET,
  RPC_CHANNELS.drafts.SET,
  RPC_CHANNELS.drafts.DELETE,
  RPC_CHANNELS.drafts.GET_ALL,

  // sources — source config per-workspace
  RPC_CHANNELS.sources.CREATE,
  RPC_CHANNELS.sources.DELETE,
  // T4 session-start pending-auth summary: workspace-owned state, served by
  // whichever server owns the workspace, like the rest of `sources.*`.
  RPC_CHANNELS.sources.PENDING_AUTH,

  // oauth — OAuth state management
  RPC_CHANNELS.oauth.START,
  RPC_CHANNELS.oauth.COMPLETE,
  RPC_CHANNELS.oauth.CANCEL,
  RPC_CHANNELS.oauth.FAIL,
  RPC_CHANNELS.oauth.REVOKE,
  // UB3.10 joined-clients poll: reads the workspace-owned flow store, like the rest of oauth.*.
  RPC_CHANNELS.oauth.STATUS,

  // dp auth — workspace owner validates local Electron availability.
  RPC_CHANNELS.dpAuth.ENSURE,
  RPC_CHANNELS.dpAuth.CANCEL,
  RPC_CHANNELS.dpAuth.STATUS,
  // T3 value-only dp probe: same workspace-owned broker as ENSURE/STATUS.
  RPC_CHANNELS.dpAuth.PROBE,

  // workspace — workspace config + images (sharp on headless)
  RPC_CHANNELS.workspace.GET_PERMISSIONS,
  RPC_CHANNELS.workspace.LIST_CUSTOM_SLASH_COMMANDS,
  RPC_CHANNELS.workspace.READ_IMAGE,
  RPC_CHANNELS.workspace.WRITE_IMAGE,
  RPC_CHANNELS.workspace.SETTINGS_GET,
  RPC_CHANNELS.workspace.SETTINGS_UPDATE,
  // workspace — Claude Code setup import (P2.9). REMOTE_ELIGIBLE because BOTH
  // operands live on the workspace owner and neither comes from the client:
  // the handler (`server-core/handlers/rpc/sources.ts`) passes only
  // `workspaceRootPath`, so `claude-setup-import.ts` resolves the source from
  // its own `homedir()` — the server's `~/.claude` + `~/.claude.json` — and
  // writes `<ws>/AGENTS.md`, `<ws>/skills/`, `<ws>/hooks.json` and workspace
  // MCP sources, then invalidates that workspace's capability catalog.
  //
  // LOCAL_ONLY would not be the conservative choice here, it would be the wrong
  // one: the agent that consumes the imported skills/hooks runs on the workspace
  // owner, so importing on the client would write the setup onto a machine the
  // agent never reads, and the import would appear to succeed with no effect.
  // Contrast `file.READ_USER_ATTACHMENT` above, which is LOCAL_ONLY precisely
  // because its path DOES come from the client.
  //
  // APPLY takes a confirmed plan over the wire, and that is safe to accept from
  // a remote caller: it is used only as a filter on `kind\0name\0action`, while
  // every payload and path is re-derived server-side from a fresh scan
  // (`applyClaudeSetupImportPlan`), so a client cannot inject a source path.
  RPC_CHANNELS.workspace.IMPORT_CLAUDE_PREVIEW,
  RPC_CHANNELS.workspace.IMPORT_CLAUDE_APPLY,

  // permissions — workspace permissions
  RPC_CHANNELS.permissions.GET_DEFAULTS,
  RPC_CHANNELS.permissions.DEFAULTS_CHANGED,
  // The channel gate is enforced inside the MCP pool, and process isolation runs
  // on whichever server owns the workspace — so both answer from there, not from
  // the local client's config.
  RPC_CHANNELS.permissions.GET_MCP_CHANNEL_PUSH,
  RPC_CHANNELS.permissions.SET_MCP_CHANNEL_PUSH,
  // P6.510 — session-scoped, so it must reach the server that owns the session
  // rather than the one the window happens to be talking to; the app-wide pair
  // above is remote-eligible for the same reason.
  RPC_CHANNELS.permissions.ARM_SESSION_CHANNEL_SOURCES,
  RPC_CHANNELS.permissions.DISARM_SESSION_CHANNEL_SOURCES,
  RPC_CHANNELS.permissions.GET_ISOLATION_CAPABILITIES,
  // P6.327: the switches the isolation report describes live on the same host
  // whose supervisor applies them, so the write goes where the read goes.
  RPC_CHANNELS.permissions.GET_SANDBOX_SWITCHES,
  RPC_CHANNELS.permissions.SET_SANDBOX_SWITCHES,

  // builtinDpMcp — the per-server switch for the built-in dp-backed MCP set.
  // REMOTE_ELIGIBLE for the same reason as the MCP channel gate above, and NOT
  // for the reason retention is local: the preference is only ever read by the
  // two pools (`base-agent.ts`, `workspace-mcp-pool-registry.ts`), which run on
  // whichever server owns the workspace, and `dp` — whose presence decides
  // whether the set can start at all — has to be installed on THAT machine. A
  // local answer would report the client's dp and the client's config while the
  // servers actually spawned come from the host's.
  RPC_CHANNELS.builtinDpMcp.LIST,
  RPC_CHANNELS.builtinDpMcp.SET_ENABLED,

  // skills — skill content per-workspace (not openEditor/openFinder which are local OS)
  RPC_CHANNELS.skills.DELETE,

  // statuses — workspace metadata
  RPC_CHANNELS.statuses.LIST,
  RPC_CHANNELS.statuses.REORDER,
  RPC_CHANNELS.statuses.CHANGED,

  // labels — workspace metadata
  RPC_CHANNELS.labels.LIST,
  RPC_CHANNELS.labels.CREATE,
  RPC_CHANNELS.labels.DELETE,
  RPC_CHANNELS.labels.CHANGED,

  // views — workspace UI views
  RPC_CHANNELS.views.LIST,
  RPC_CHANNELS.views.SAVE,

  // toolIcons — workspace config
  RPC_CHANNELS.toolIcons.GET_MAPPINGS,

  // logo — workspace config
  RPC_CHANNELS.logo.GET_URL,

  // automations — workspace automations
  RPC_CHANNELS.automations.GET,
  RPC_CHANNELS.automations.TEST,
  RPC_CHANNELS.automations.CREATE,
  RPC_CHANNELS.automations.UPDATE,
  RPC_CHANNELS.automations.SET_ENABLED,
  RPC_CHANNELS.automations.DUPLICATE,
  RPC_CHANNELS.automations.DELETE,
  RPC_CHANNELS.automations.GET_HISTORY,
  RPC_CHANNELS.automations.GET_LAST_EXECUTED,
  RPC_CHANNELS.automations.REPLAY,
  // UA8.3 — the script approval is recorded in the ledger of the server that owns the workspace (where it runs)
  RPC_CHANNELS.automations.APPROVE_SCRIPT,
  RPC_CHANNELS.automations.CHANGED,

  // git — workspace filesystem
  RPC_CHANNELS.git.GET_BRANCH,

  // resources — workspace resource export/import
  RPC_CHANNELS.resources.EXPORT,
  RPC_CHANNELS.resources.IMPORT,

  // capabilities — unified safe catalog / detail / preview served by whichever
  // server owns the workspace (path-free DTOs; resolver runs server-side).
  RPC_CHANNELS.capabilities.GET_CATALOG,
  RPC_CHANNELS.capabilities.GET_COMPOSER_CATALOG,
  RPC_CHANNELS.capabilities.GET_DETAIL,
  // Same server-side resolve, same workspace owner; the CLI reads it before the
  // first turn to write the headless init frame.
  RPC_CHANNELS.capabilities.GET_HEADLESS_INIT,
  RPC_CHANNELS.capabilities.PREVIEW,
  RPC_CHANNELS.capabilities.SUMMARY,
  RPC_CHANNELS.capabilities.SUBMIT_MANAGED_EDIT,
  RPC_CHANNELS.capabilities.CHANGED,

  // capabilities — path-free trust review (read) and grant/revoke (mutate),
  // resolved from a fresh server-side snapshot on whichever server owns the
  // workspace; same safe-DTO boundary as the catalog routes above.
  RPC_CHANNELS.capabilities.LIST_TRUST_REVIEWS,
  RPC_CHANNELS.capabilities.GRANT_TRUST,
  RPC_CHANNELS.capabilities.REVOKE_TRUST,

  // capabilities — read-only, path-free project-contribution detection resolved
  // from a backend-issued handle on whichever server owns the workspace (the
  // project directory lives on that server); same safe-DTO boundary as above.
  RPC_CHANNELS.capabilities.DETECT_PROJECT_CONTRIBUTIONS,

  // tasks — the durable Tasks family (UA3.3, v0.13.4): workspace content — task.yaml and its runs live under
  // the workspace root, and the Conductor runs on the server that owns the workspace (upstream classifies
  // every one REMOTE_ELIGIBLE, the push included).
  RPC_CHANNELS.tasks.VALIDATE,
  RPC_CHANNELS.tasks.CREATE,
  RPC_CHANNELS.tasks.GENERATE,
  RPC_CHANNELS.tasks.GENERATED,
  RPC_CHANNELS.tasks.RUN,
  RPC_CHANNELS.tasks.PAUSE,
  RPC_CHANNELS.tasks.RESUME,
  RPC_CHANNELS.tasks.STOP,
  RPC_CHANNELS.tasks.GET,
  RPC_CHANNELS.tasks.LIST,
  RPC_CHANNELS.tasks.GET_RESULTS,
  RPC_CHANNELS.tasks.DELETE,

  // artifacts — the Published pages list (UA1.19): workspace content as `tasks:*` — the registry lives under the
  // workspace root, and the dp identity that publishes is the one on the server that owns the workspace (the same
  // server `publish_artifact` runs on).
  RPC_CHANNELS.artifacts.LIST,
  RPC_CHANNELS.artifacts.SET_RETENTION,
  RPC_CHANNELS.artifacts.DELETE,
  // UA1.23 — the preview's Publish runs on the server that owns the session it publishes from.
  RPC_CHANNELS.artifacts.PUBLISH_FILE,
  // UA12.52 — the registry push is workspace content for the same reason (every sibling `*.CHANGED` push).
  RPC_CHANNELS.artifacts.CHANGED,

  // pages — workspace pages (UA6.4, v0.13.4): the page list push is workspace content (the pages live under the
  // workspace root on the server that owns it), as upstream classifies it.
  RPC_CHANNELS.pages.CHANGED,
  // UA6.4 — the core family (`rpc/pages.ts`), workspace content for the same reason
  RPC_CHANNELS.pages.GET,
  RPC_CHANNELS.pages.GET_ONE,
  RPC_CHANNELS.pages.CREATE,
  RPC_CHANNELS.pages.UPDATE,
  RPC_CHANNELS.pages.DELETE,
  RPC_CHANNELS.pages.GET_CONTENT,
  RPC_CHANNELS.pages.SET_CONTENT,
  RPC_CHANNELS.pages.GET_DATA,
  RPC_CHANNELS.pages.CREATE_LEASE,
  RPC_CHANNELS.pages.RELEASE_LEASE,
  // UA7.4 — the poster channels: workspace content for the same reason (the poster lives in the page folder, and
  // a server with no capturer answers regenerate as a no-op), as upstream classifies them
  RPC_CHANNELS.pages.GET_THUMBNAIL,
  RPC_CHANNELS.pages.REGENERATE_THUMBNAIL,
  // UA8.3 — the refresh review, approval and run-now: the script, its ledger and its run live with the workspace
  RPC_CHANNELS.pages.GET_REFRESH_STATUS,
  RPC_CHANNELS.pages.APPROVE_REFRESH,
  RPC_CHANNELS.pages.RUN_REFRESH_NOW,
  // UA9.3 — grants and actions, as upstream classifies them: the ledger, the broker and the sources live with the
  // workspace's server
  RPC_CHANNELS.pages.LIST_GRANTS,
  RPC_CHANNELS.pages.DESCRIBE_GRANT_REQUEST,
  RPC_CHANNELS.pages.ISSUE_GRANT,
  RPC_CHANNELS.pages.REVOKE_GRANT,
  RPC_CHANNELS.pages.EXECUTE_ACTION,
  RPC_CHANNELS.pages.CANCEL_ACTION,
  // UA12.112 — the audit trail the renderer-gate refusals land in lives with the workspace's server,
  // beside the broker that writes it.
  RPC_CHANNELS.pages.AUDIT_REFUSAL,
  // UA6.7 — publishing: the registry, the page and the dp identity that publishes live with the workspace's server
  // (the `artifacts:*` reason), as upstream classifies its share channels
  RPC_CHANNELS.pages.GET_SHARE_DATA_SCAN,
  RPC_CHANNELS.pages.PUBLISH,
  RPC_CHANNELS.pages.UNPUBLISH,

  // projects — the project ENTITY family (UA5.3, v0.13.4): workspace content — `projects/<slug>/config.json` lives
  // under the workspace root, and a folder handle is issued by the server that owns the workspace (the same server the
  // folder channels above run on); upstream classifies every one REMOTE_ELIGIBLE, the push included.
  RPC_CHANNELS.projects.GET,
  RPC_CHANNELS.projects.GET_ONE,
  RPC_CHANNELS.projects.CREATE,
  RPC_CHANNELS.projects.UPDATE,
  RPC_CHANNELS.projects.DELETE,
  RPC_CHANNELS.projects.SET_FOLDER,
  RPC_CHANNELS.projects.CHANGED,
  // UA5.6 — the asset channels: `projects/<slug>/assets/` is workspace content too; upstream: REMOTE_ELIGIBLE
  RPC_CHANNELS.projects.LIST_ASSETS,
  RPC_CHANNELS.projects.UPLOAD_ASSET,
  RPC_CHANNELS.projects.DELETE_ASSET,
] as const satisfies readonly RpcChannelValue[]

export const REMOTE_ELIGIBLE_CHANNELS = new Set<string>(REMOTE_ELIGIBLE_LIST)

// ---------------------------------------------------------------------------
// Transport-internal pseudo-channels
// ---------------------------------------------------------------------------

/**
 * Locality for the channels the transport client emits about ITSELF. These are
 * not RPC channels — no server handles one — so they are absent from
 * `RPC_CHANNELS` and from the exhaustiveness test's denominator, but they do
 * travel through `RoutedClient` and so they still need a decision.
 *
 * `__transport:reconnected` is `'workspace'` deliberately: the event that
 * matters is the WORKSPACE connection coming back, because that is the one
 * whose downtime left session state stale. It was reaching the workspace client
 * before P2.296 too — but by falling through the fail-open complement, not by
 * anyone choosing it.
 *
 * `satisfies Record<…>` makes this total: adding a pseudo-channel to
 * `TRANSPORT_INTERNAL_CHANNELS` without classifying it here fails the typecheck.
 */
const TRANSPORT_INTERNAL_LOCALITY = {
  [TRANSPORT_INTERNAL_CHANNELS.RECONNECTED]: 'workspace',
} as const satisfies Record<TransportInternalChannel, RoutedChannelLocality>

/**
 * Looked up through a `Map`, not by indexing the object above. Measured
 * 2026-08-28: `TRANSPORT_INTERNAL_LOCALITY['constructor']` returns a FUNCTION
 * off the prototype chain, which is not `'unclassified'`, so `?? 'unclassified'`
 * never fires and `RoutedClient` routes the call to the workspace client —
 * the exact fail-open this file exists to close, reintroduced for precisely the
 * strings someone probing the boundary would try. `Set.has()` and `Map.get()`
 * have no prototype chain; `Object.entries` copies own keys only.
 */
const TRANSPORT_INTERNAL_LOCALITY_BY_CHANNEL = new Map<string, RoutedChannelLocality>(
  Object.entries(TRANSPORT_INTERNAL_LOCALITY),
)

// ---------------------------------------------------------------------------
// Compile-time exhaustiveness — the floor, checked by `tsc`, not by `bun test`
// ---------------------------------------------------------------------------

/**
 * Same idiom as `transport/__tests__/channel-map-parity.test.ts`. Keep the
 * `Exclude`/`Extract` INLINE rather than behind a named alias: `tsc` prints an
 * inlined union's members, so the error names the offending channel, and prints
 * only the alias name if you hide it behind one (measured 2026-08-28).
 *
 * Keep the `= true` too. A `declare const` of the union with a `: never`
 * assignment reads more directly and is a TRAP: `declare` erases, the
 * assignment does not, and the module throws `ReferenceError` on import while
 * `tsc --noEmit` stays green. That spelling was written here first and every
 * test importing `protocol` failed to load.
 */
type AssertNever<T extends never> = true

/**
 * Must be `never`. If `tsc` says otherwise, a channel in `RPC_CHANNELS` is in
 * NEITHER routing set — the error names it. Add it to `LOCAL_ONLY_LIST` or
 * `REMOTE_ELIGIBLE_LIST` above; there is no default, which is the point.
 *
 * KNOW WHAT THIS DOES NOT COVER. **The guarantee is bounded by `RPC_CHANNELS`
 * membership, not by what actually routes.** `RpcChannelValue` is the whole
 * denominator, so a channel string that never entered `RPC_CHANNELS` is outside
 * this assertion permanently — no amount of `tsc` makes it appear, and the
 * `routing.test.ts` exhaustiveness test cannot see it either, for the same
 * reason. That is not hypothetical: `__transport:reconnected` routed through
 * `RoutedClient` for its whole life while absent from `RPC_CHANNELS`, which is
 * why `TRANSPORT_INTERNAL_CHANNELS` above exists and is separately made total.
 *
 * The practical consequence, for callers rather than for this file: **write a
 * channel as a `RPC_CHANNELS.*` constant, never as a raw string literal.** A
 * literal typechecks against `invoke`'s `string` parameter and is invisible
 * here, so it is the shape that becomes the next unclassified router. The six
 * literals in `preload/bootstrap.ts` were converted for exactly this reason
 * (P2.325); they all named declared channels, so nothing was broken — the point
 * is that this guard could not have told anyone if one had not.
 */
const _everyChannelIsClassified: AssertNever<
  Exclude<RpcChannelValue, typeof LOCAL_ONLY_LIST[number] | typeof REMOTE_ELIGIBLE_LIST[number]>
> = true

/**
 * Must be `never`. If `tsc` says otherwise, a channel is in BOTH sets — two
 * contradictory transport decisions for one channel.
 */
const _noChannelIsClassifiedTwice: AssertNever<
  Extract<typeof LOCAL_ONLY_LIST[number], typeof REMOTE_ELIGIBLE_LIST[number]>
> = true

void _everyChannelIsClassified
void _noChannelIsClassifiedTwice

// ---------------------------------------------------------------------------
// The routing decision
// ---------------------------------------------------------------------------

/** Where a classified channel runs. Mirrors `RoutedClient`'s own two clients. */
export type RoutedChannelLocality = 'local' | 'workspace'

/**
 * `'unclassified'` is not a third destination — it is the absence of a
 * decision, and the router refuses it.
 */
export type ChannelLocality = RoutedChannelLocality | 'unclassified'

/**
 * THE routing decision. `RoutedClient` consults this and nothing else.
 *
 * `'workspace'` is reachable only through `REMOTE_ELIGIBLE_CHANNELS` (or the
 * explicitly classified transport-internal channels), which is what stops the
 * second set from being decorative: adding a channel to it is now the act that
 * lets the channel leave this machine.
 *
 * Deliberately takes `string`, not `RpcChannelValue` — `RpcClient.invoke` is a
 * string interface, and `'unclassified'` exists precisely to answer the strings
 * that never went through `RPC_CHANNELS`.
 */
export function channelLocality(channel: string): ChannelLocality {
  if (LOCAL_ONLY_CHANNELS.has(channel)) return 'local'
  if (REMOTE_ELIGIBLE_CHANNELS.has(channel)) return 'workspace'
  return TRANSPORT_INTERNAL_LOCALITY_BY_CHANNEL.get(channel) ?? 'unclassified'
}

// ---------------------------------------------------------------------------
// Query helpers
// ---------------------------------------------------------------------------

export function isLocalOnly(channel: string): boolean {
  return LOCAL_ONLY_CHANNELS.has(channel)
}

export function isRemoteEligible(channel: string): boolean {
  return REMOTE_ELIGIBLE_CHANNELS.has(channel)
}
