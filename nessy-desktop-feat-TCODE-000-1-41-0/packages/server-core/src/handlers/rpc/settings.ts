import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'path'
import { CodedError, RPC_CHANNELS } from '@nessy-agent/shared/protocol'
import type { ConnectionProvenanceV1 } from '@nessy-agent/shared/protocol'
import { isManagedModelSelectable } from '@nessy-agent/shared/config/managed-models'
import { getPreferencesPath, getSessionDraft, setSessionDraft, deleteSessionDraft, getAllSessionDrafts, getDefaultThinkingLevel, setDefaultThinkingLevel, getOutputStyleId, setOutputStyleId, loadConfigDefaults, resolveMaxBudgetTokens, resolveMaxBudgetUsd } from '@nessy-agent/shared/config'
import { isValidThinkingLevel, normalizeThinkingLevel, THINKING_LEVEL_IDS } from '@nessy-agent/shared/agent/thinking-levels'
import { getUserWorkflowSettings, setWorkflowSizeGuideline } from '@nessy-agent/shared/config/storage'
import { largeWorkflowAgentThreshold, resolveWorkflowSettings, workflowDisableEnvLayer } from '@nessy-agent/shared/config/workflow-settings'
import { resolveManagedPiPolicyFloor } from '@nessy-agent/shared/agent/pi-harness/managed-policy'
import type { AutoModeDenialsView, SafeAutoModeDenialView, SafeWorkflowSettingsView } from '@nessy-agent/shared/protocol/capabilities'
import { resolveSessionRuntimeNotices } from '@nessy-agent/shared/protocol/session-runtime-notices'
import type { SessionMemoryScope, SessionMemoryScopeOverride } from '@nessy-agent/shared/agent/memory/session-memory-scope'
import { claudeSettingSourcesForProjectTrust, workspaceClaudeConfigDir, workspaceClaudeConfigDirPath } from '@nessy-agent/shared/agent'
import { isValidOutputStyleId, listOutputStyles, type PluginOutputStyleSource } from '@nessy-agent/shared/prompts'
import { createCapabilitySnapshotMaterializer } from '@nessy-agent/shared/capabilities/materializer'
import { withCapabilitySnapshot } from '@nessy-agent/shared/capabilities/resolver'
import {
  pluginNamesByInstanceId,
  readPluginOutputStyleSources,
} from '@nessy-agent/shared/capabilities/runtime-output-styles'
import { toAgentRuntime } from '@nessy-agent/shared/capabilities/views'
import { resolveCapabilityContext } from '../../domain/capabilities/context'
import type { ResolvedWorkspace, WorkspaceDefaultSettingKey } from '@nessy-agent/shared/workspaces'
import type { ResolvedWorkspaceAction } from '@nessy-agent/shared/config'

const VALID_THINKING_LEVELS_LIST = THINKING_LEVEL_IDS.map(id => `'${id}'`).join(', ')
import { buildBackendHostRuntimeContext, getWorkspaceOrThrow } from '@nessy-agent/server-core/handlers'
import type { RpcServer } from '@nessy-agent/server-core/transport'
import type { HandlerDeps } from '../handler-deps'
import { pushTyped, requestClientOpenFileDialog } from '@nessy-agent/server-core/transport'

export const HANDLED_CHANNELS = [
  RPC_CHANNELS.workspace.SETTINGS_GET,
  RPC_CHANNELS.workspace.SETTINGS_UPDATE,
  RPC_CHANNELS.preferences.READ,
  RPC_CHANNELS.preferences.WRITE,
  RPC_CHANNELS.drafts.GET,
  RPC_CHANNELS.drafts.SET,
  RPC_CHANNELS.drafts.DELETE,
  RPC_CHANNELS.drafts.GET_ALL,
  RPC_CHANNELS.input.GET_AUTO_CAPITALISATION,
  RPC_CHANNELS.input.SET_AUTO_CAPITALISATION,
  RPC_CHANNELS.input.GET_SEND_MESSAGE_KEY,
  RPC_CHANNELS.input.SET_SEND_MESSAGE_KEY,
  RPC_CHANNELS.input.GET_SPELL_CHECK,
  RPC_CHANNELS.input.SET_SPELL_CHECK,
  RPC_CHANNELS.power.GET_KEEP_AWAKE,
  RPC_CHANNELS.appearance.GET_RICH_TOOL_DESCRIPTIONS,
  RPC_CHANNELS.appearance.SET_RICH_TOOL_DESCRIPTIONS,
  RPC_CHANNELS.caching.GET_EXTENDED_PROMPT_CACHE,
  RPC_CHANNELS.caching.SET_EXTENDED_PROMPT_CACHE,
  RPC_CHANNELS.sessions.GET_MODEL,
  RPC_CHANNELS.sessions.SET_MODEL,
  RPC_CHANNELS.sessions.GET_RECENT_STDERR,
  RPC_CHANNELS.settings.GET_DEFAULT_THINKING_LEVEL,
  RPC_CHANNELS.settings.SET_DEFAULT_THINKING_LEVEL,
  RPC_CHANNELS.settings.GET_OUTPUT_STYLE,
  RPC_CHANNELS.settings.SET_OUTPUT_STYLE,
  RPC_CHANNELS.settings.LIST_OUTPUT_STYLES,
  RPC_CHANNELS.settings.GET_WORKFLOW,
  RPC_CHANNELS.settings.SET_WORKFLOW_SIZE_GUIDELINE,
  RPC_CHANNELS.settings.GET_CROSS_SESSION_INBOUND,
  RPC_CHANNELS.settings.SET_CROSS_SESSION_INBOUND,
  RPC_CHANNELS.tools.GET_BROWSER_TOOL_ENABLED,
  RPC_CHANNELS.tools.SET_BROWSER_TOOL_ENABLED,
  RPC_CHANNELS.tools.GET_BROWSER_DOWNLOAD_SETTINGS,
  RPC_CHANNELS.tools.SET_BROWSER_DOWNLOAD_SETTINGS,
  RPC_CHANNELS.builtinDpMcp.LIST,
  RPC_CHANNELS.builtinDpMcp.SET_ENABLED,
  RPC_CHANNELS.retention.GET_SETTINGS,
  RPC_CHANNELS.retention.SET_DAYS,
  RPC_CHANNELS.retention.SET_SWEEP_ENABLED,
  RPC_CHANNELS.permissions.GET_MCP_CHANNEL_PUSH,
  RPC_CHANNELS.permissions.SET_MCP_CHANNEL_PUSH,
  RPC_CHANNELS.permissions.ARM_SESSION_CHANNEL_SOURCES,
  RPC_CHANNELS.permissions.DISARM_SESSION_CHANNEL_SOURCES,
  RPC_CHANNELS.workspaceActions.LIST,
  RPC_CHANNELS.workspaceActions.RUN,
  RPC_CHANNELS.sessions.GET_MEMORY_SCOPE,
  RPC_CHANNELS.sessions.SET_MEMORY_SCOPE,
  RPC_CHANNELS.permissions.GET_AUTO_MODE_DENIALS,
  RPC_CHANNELS.permissions.GET_ISOLATION_CAPABILITIES,
  RPC_CHANNELS.permissions.GET_AUTO_MODE_POLICY,
  RPC_CHANNELS.permissions.GET_SANDBOX_SWITCHES,
  RPC_CHANNELS.permissions.SET_SANDBOX_SWITCHES,
  RPC_CHANNELS.permissions.GET_BYPASS_PERMISSIONS_ACKNOWLEDGED,
  RPC_CHANNELS.permissions.SET_BYPASS_PERMISSIONS_ACKNOWLEDGED,
  RPC_CHANNELS.rtk.GET_ENABLED,
  RPC_CHANNELS.rtk.SET_ENABLED,
  RPC_CHANNELS.rtk.GET_STATUS,
  RPC_CHANNELS.rtk.GET_GAIN,
  RPC_CHANNELS.guardian.GET_ENABLED,
  RPC_CHANNELS.guardian.SET_ENABLED,
  RPC_CHANNELS.guardian.GET_MODEL,
  RPC_CHANNELS.guardian.SET_MODEL,
  RPC_CHANNELS.guardian.GET_MODELS_BY_CONNECTION,
  RPC_CHANNELS.guardian.SET_MODEL_FOR_CONNECTION,
  RPC_CHANNELS.advisor.GET_ENABLED,
  RPC_CHANNELS.advisor.SET_ENABLED,
  RPC_CHANNELS.advisor.GET_MODEL,
  RPC_CHANNELS.advisor.SET_MODEL,
  RPC_CHANNELS.codexAutoReview.GET_ENABLED,
  RPC_CHANNELS.codexAutoReview.SET_ENABLED,
  RPC_CHANNELS.codexAutoReview.GET_POLICY,
  RPC_CHANNELS.codexAutoReview.SET_POLICY,
  RPC_CHANNELS.settings.GET_NETWORK_PROXY,
  RPC_CHANNELS.settings.GET_PROVENANCE,
  RPC_CHANNELS.settings.GET_CONFIG_DOCTOR,
  RPC_CHANNELS.dialog.OPEN_FOLDER,
  // D1.248 — four channels this module has `server.handle`d while declaring 79
  // others, found by WI-t: `registration-profiles.test.ts` is the only thing in
  // the tree that compares the two lists, and it was RED at HEAD for every lane
  // with exactly these four names. The declaration is what a host reads to know
  // which channels a profile serves, so an undeclared one is a channel that
  // answers and cannot be discovered.
  RPC_CHANNELS.codexSubagents.GET_ENABLED,
  RPC_CHANNELS.codexSubagents.SET_ENABLED,
  RPC_CHANNELS.primaryDirectory.GET,
  RPC_CHANNELS.primaryDirectory.SET,
] as const

/**
 * Plugin-shipped output styles for the picker (`output-styles.md:83`).
 *
 * Resolved through a workspace-scoped capability snapshot, so a style from a
 * DISABLED plugin — or one the managed policy blocked — never reaches the list:
 * the same activation that governs every other plugin capability governs this
 * one. The snapshot lease is released by `withCapabilitySnapshot` in `finally`.
 *
 * FAIL-SOFT by design. The picker's job is to show the styles it can; a resolver
 * that is not wired (headless, tests) or a bundle that has gone missing must
 * degrade to the built-in and on-disk styles rather than failing the settings
 * page.
 */
async function pluginOutputStylesFor(
  deps: HandlerDeps,
  workspaceId: string,
): Promise<PluginOutputStyleSource[]> {
  const resolver = deps.sessionManager.getCapabilityResolver?.()
  const handleService = deps.sessionManager.getProjectHandleService?.()
  if (!resolver || !handleService) return []
  try {
    const context = await resolveCapabilityContext({ workspaceId }, { handleService })
    return await withCapabilitySnapshot(resolver, context, async snapshot => (
      readPluginOutputStyleSources(
        toAgentRuntime(snapshot).outputStyles ?? [],
        createCapabilitySnapshotMaterializer(resolver, snapshot),
        pluginNamesByInstanceId(snapshot),
      )
    ))
  } catch {
    return []
  }
}

export function registerSettingsHandlers(server: RpcServer, deps: HandlerDeps): void {
  // ============================================================
  // Settings - Default Thinking Level (App-Level)
  // ============================================================

  server.handle(RPC_CHANNELS.settings.GET_DEFAULT_THINKING_LEVEL, async () => {
    return getDefaultThinkingLevel()
  })

  server.handle(RPC_CHANNELS.settings.SET_DEFAULT_THINKING_LEVEL, async (_ctx, level: string) => {
    if (!isValidThinkingLevel(level)) {
      throw new Error(`Invalid thinking level: ${level}. Valid values: ${VALID_THINKING_LEVELS_LIST}`)
    }
    const success = setDefaultThinkingLevel(level)
    if (!success) {
      throw new Error('Failed to persist default thinking level')
    }
    return { success: true }
  })

  // ============================================================
  // Settings - Output Style (App-Level)
  // ============================================================

  server.handle(RPC_CHANNELS.settings.GET_OUTPUT_STYLE, async () => {
    return getOutputStyleId()
  })

  server.handle(RPC_CHANNELS.settings.SET_OUTPUT_STYLE, async (_ctx, styleId: string) => {
    if (!isValidOutputStyleId(styleId)) {
      throw new Error(`Invalid output style: ${styleId}`)
    }
    const success = setOutputStyleId(styleId)
    if (!success) {
      throw new Error('Failed to persist output style')
    }
    return { success: true }
  })

  /**
   * P6.319 — the workflow governance settings, read RESOLVED.
   *
   * All three layers are composed here, in the same order and by the same
   * function `SessionManager` uses at session start
   * (`resolveWorkflowSettings([user, managed, envOffSwitch])`), so the page can
   * never show a value the model would not get. The managed layer comes from
   * `resolveManagedPiPolicyFloor()` — the process-scoped reader — rather than
   * from a session, because this page has no session and an administrator's
   * policy applies whether one is open or not.
   *
   * `agentThreshold` is sent pre-computed for the same reason: it is
   * `largeWorkflowAgentThreshold`'s answer, and a renderer that derived it would
   * be a second copy of a documented mapping.
   */
  server.handle(RPC_CHANNELS.settings.GET_WORKFLOW, async (): Promise<SafeWorkflowSettingsView> => {
    const userLayer = getUserWorkflowSettings()
    const resolved = resolveWorkflowSettings([
      userLayer,
      resolveManagedPiPolicyFloor()?.workflow ?? {},
      workflowDisableEnvLayer(),
    ])
    return {
      disableWorkflows: resolved.disableWorkflows,
      sizeGuideline: resolved.sizeGuideline,
      keywordTriggerEnabled: resolved.keywordTriggerEnabled,
      agentThreshold: largeWorkflowAgentThreshold(resolved.sizeGuideline),
      // Absent unless THIS user set it: that is what lets the page say whether
      // the control is showing your choice or somebody else's.
      ...(userLayer.sizeGuideline === undefined ? {} : { userSizeGuideline: userLayer.sizeGuideline }),
    }
  })

  /**
   * The one workflow key writable from the app.
   *
   * `disableWorkflows` and the keyword trigger are deliberately absent: both are
   * tighter-wins in the resolver, so a control that appeared to turn workflows
   * back ON would write a value the resolver then ignores — a lie with a
   * checkbox. The size guideline is an ordinary last-explicit-value-wins
   * preference, which is exactly what a user control can honestly own.
   *
   * The WRITE itself is `setWorkflowSizeGuideline` in `config/storage.ts`, beside
   * its ~40 sibling setters — it was inlined here until P6.682, only because
   * that file belonged to another lane the hour P6.319 landed. It refuses an
   * unknown value by throwing (the union's own parser, so a bad value never
   * becomes the default on the next load) and returns `false` for the other
   * failure, an absent `config.json`, which is the state this handler reports.
   */
  server.handle(
    RPC_CHANNELS.settings.SET_WORKFLOW_SIZE_GUIDELINE,
    async (_ctx, guideline: unknown) => {
      if (!setWorkflowSizeGuideline(guideline)) {
        throw new Error('Failed to persist workflow size guideline')
      }
      return { success: true }
    },
  )

  server.handle(RPC_CHANNELS.settings.LIST_OUTPUT_STYLES, async (_ctx, workspaceId?: string) => {
    let workspaceRootPath: string | undefined

    if (workspaceId) {
      workspaceRootPath = getWorkspaceOrThrow(deps.workspaceService, workspaceId).workspaceRootPath
    }

    const pluginStyles = workspaceId ? await pluginOutputStylesFor(deps, workspaceId) : []
    return listOutputStyles({
      workspaceRootPath,
      ...(pluginStyles.length > 0 ? { pluginStyles } : {}),
    })
  })

  // ============================================================
  // Settings - Model (Session-Specific)
  // ============================================================

  // Get session-specific model
  server.handle(RPC_CHANNELS.sessions.GET_MODEL, async (_ctx, sessionId: string, workspaceId: string): Promise<string | null> => {
    const session = await deps.sessionManager.getSession(sessionId, workspaceId)
    return session?.model ?? null
  })

  // Read-only diagnostic: what this session's agent subprocess last wrote to
  // stderr. The buffer is always on and its contents already surface in
  // connection-test failures; this only makes them readable directly.
  server.handle(RPC_CHANNELS.sessions.GET_RECENT_STDERR, async (_ctx, sessionId: string, workspaceId: string): Promise<string> => {
    return deps.sessionManager.getRecentAgentStderr(sessionId, workspaceId)
  })

  /**
   * P6.209 (A42) — what the auto-mode judge refused in this session.
   *
   * The producer and the read path already exist: `claude-agent.ts` retains a
   * bounded ring of fifty receipts at BOTH mint sites (the `PermissionDenied`
   * hook and the SDK's `system/permission_denied` message) and
   * `SessionManager.getRecentAutoModeDenials` reads it, exactly like
   * `getRecentAgentStderr` above. Before that ring the receipt's only sink was
   * `onDebug`, which in a packaged build has no reader at all — the evidence was
   * discarded where it was created.
   *
   * The mapping to {@link SafeAutoModeDenialView} DROPS `toolInput` and
   * `toolUseId`, and that is the whole reason a safe view exists rather than the
   * receipt crossing whole: printing the refused arguments would publish exactly
   * the payload the judge declined. Oldest first, as the ring holds them, so the
   * list reads as a history rather than as a leaderboard.
   *
   * P6.721 — THE ANSWER SAYS WHICH, so no client has to. This used to end
   * "the renderer says which", and exactly one renderer did, in a static
   * sentence of its own; every other client reading this channel would have
   * rendered an empty list as *"the judge refused nothing"* on a Pi or codex
   * session. `supported` and `runtime` come from `SessionManager`, which is the
   * only layer holding both the session's provider and its live agent.
   */
  server.handle(
    RPC_CHANNELS.permissions.GET_AUTO_MODE_DENIALS,
    async (_ctx, sessionId: string, workspaceId: string): Promise<AutoModeDenialsView> => {
      const { supported, runtime, receipts } =
        deps.sessionManager.getRecentAutoModeDenials(sessionId, workspaceId)
      return {
        supported,
        runtime,
        denials: receipts.map(receipt => ({
          toolName: receipt.toolName,
          reason: receipt.reason,
          permissionMode: receipt.permissionMode,
          deniedAt: receipt.deniedAt,
        })),
      }
    },
  )

  /**
   * P6.703 — the per-chat memory scope, read and written.
   *
   * Two independent axes (may this chat READ existing memories, may it FEED
   * future ones), each independently unset; an unset axis follows the global
   * switch, so a chat that says nothing behaves exactly as it does today. The
   * read answers BOTH the stored override and the effective scope, because the
   * renderer has to be able to render "off" differently from "following the
   * app-wide setting" — collapsing them would make a user who turned memory off
   * globally believe every chat had been excluded individually.
   *
   * **The refusal below is deliberate and temporary.** The session-record field
   * and the resolver plumbing are another lane's files this hour, so the manager
   * methods are declared OPTIONAL on `ISessionManager` and this verb refuses BY
   * NAME while they are absent. It does not answer a default: an unrecorded
   * override that reads back as "no override" is indistinguishable from a chat
   * the user did exclude, and that is the exact failure the row exists to close.
   */
  /**
   * D1.215 / D1.139 — the runtime notices this session carries, attached to
   * BOTH memory-scope verbs.
   *
   * ## Why here and not in `SessionManager`
   *
   * D1.139's own note re-zoned this row twice, the second time onto
   * `SessionManager.getSessionMemoryScope`. It does not need to be there. The
   * disposition has exactly two inputs and this handler holds both: the memory
   * switch is `buildClaudeSessionMemoryEnv(scope)` — the same function
   * `applyAutoMemoryOffSwitch` calls, on the very `scope` this verb returns —
   * and the config dir is `workspaceClaudeConfigDir(workspaceId)`, the same
   * function the spawn calls, on the argument this verb already takes. So this
   * is the derivation, not a copy of it. WI-l's refutation was about the
   * RENDERER, which holds neither input and would have answered a shared root
   * for a per-workspace tree.
   *
   * ## Why BOTH verbs
   *
   * The menu re-renders from the WRITE's result, so a notice list on the read
   * alone would vanish the moment a user touched a switch — and the memory
   * notice is exactly the one whose text a write can change.
   *
   * Never throws: a notice is a disclosure, and losing the whole memory menu
   * because a posture could not be resolved would trade a real control for a
   * sentence.
   */
  const withRuntimeNotices = (
    result: { scope: SessionMemoryScope; override: SessionMemoryScopeOverride },
    sessionId: string,
    workspaceId: string,
  ) => {
    try {
      const provider = deps.sessionManager.getSessionProvider?.(sessionId, workspaceId)
      // Short-circuited BEFORE `workspaceClaudeConfigDir`, which creates the
      // directory it names: a session that will never spawn a claude child must
      // not grow a `claude-config/` because someone opened a menu. The module
      // keeps its own guard — that one is the contract, this one is the cost.
      if (provider !== 'anthropic') return { ...result, notices: [] }
      return {
        ...result,
        notices: resolveSessionRuntimeNotices({
          provider,
          memoryScope: result.scope,
          claudeConfigDir: workspaceClaudeConfigDir(workspaceId),
        }),
      }
    } catch {
      return { ...result, notices: [] }
    }
  }

  server.handle(
    RPC_CHANNELS.sessions.GET_MEMORY_SCOPE,
    async (_ctx, sessionId: string, workspaceId: string) => {
      const read = deps.sessionManager.getSessionMemoryScope
      if (typeof read !== 'function') throw new Error('Per-chat memory scope is not available on this server')
      return withRuntimeNotices(read.call(deps.sessionManager, sessionId, workspaceId), sessionId, workspaceId)
    },
  )

  server.handle(
    RPC_CHANNELS.sessions.SET_MEMORY_SCOPE,
    async (_ctx, sessionId: string, workspaceId: string, override: { read?: boolean; write?: boolean }) => {
      if (override === null || typeof override !== 'object' || Array.isArray(override)) {
        throw new Error('memory scope override must be an object')
      }
      for (const axis of ['read', 'write'] as const) {
        const value = override[axis]
        // `undefined` is a real value here and means "follow the global switch",
        // so it is accepted; anything that is neither a boolean nor absent would
        // silently resolve to the global default and look like it was applied.
        if (value !== undefined && typeof value !== 'boolean') {
          throw new Error(`memory scope ${axis} must be a boolean or absent`)
        }
      }
      const write = deps.sessionManager.setSessionMemoryScope
      if (typeof write !== 'function') throw new Error('Per-chat memory scope is not available on this server')
      const result = await write.call(deps.sessionManager, sessionId, {
        ...(override.read === undefined ? {} : { read: override.read }),
        ...(override.write === undefined ? {} : { write: override.write }),
      }, workspaceId)
      return withRuntimeNotices(result, sessionId, workspaceId)
    },
  )

  // Set session-specific model (and optionally connection)
  server.handle(RPC_CHANNELS.sessions.SET_MODEL, async (_ctx, sessionId: string, workspaceId: string, model: string | null, connection?: string) => {
    // `model-config.md:165` — "**`/model`**: the switch is rejected with an
    // error." This is the one model entry point the documentation refuses
    // rather than substitutes, because the user named the model. Every path
    // that merely INHERITS a forbidden model — the `model` setting, a resumed
    // session, a subagent or command override — substitutes silently instead
    // (`:166`, `:167`), which is what `resolveModelForProvider` and the
    // subprocess spawner do.
    //
    // Clearing the override (`model === null`) is always permitted: it resolves
    // to the connection Default, which `managed-settings.md#keys-that-fail-closed`
    // keeps reachable through any allowlist, valid or not — the `availableModels`
    // row reads "Enforced as an empty allowlist until fixed, so only the Default
    // model is available" — as does `model-config.md:205`.
    //
    // The refusal carries only the model id, never the allowlist: the message
    // reaches a renderer toast, and a policy's contents are the administrator's
    // to disclose through `nessy-general-agent doctor`.
    if (model !== null && !isManagedModelSelectable(model)) {
      throw new CodedError(
        'MODEL_RESTRICTED_BY_POLICY',
        `Model is restricted by managed policy: ${model}`,
      )
    }
    await deps.sessionManager.updateSessionModel(sessionId, workspaceId, model, connection)
    deps.platform.logger.info(`Session ${sessionId} model updated to: ${model}${connection ? ` (connection: ${connection})` : ''}`)
  })

  /**
   * Open a native folder dialog (routed to the client).
   *
   * P6.623 — the title became a parameter. This channel was written for one
   * caller, the working-directory picker, and hardcoded that caller's English
   * title; the download-folder Browse button is a second caller, and a picker
   * that says *Select Working Directory* while the user is choosing where
   * downloads land is worse than no picker. The renderer passes a TRANSLATED
   * title, which is also the only way this string can reach a locale at all —
   * this process has no `t()`.
   *
   * The default is the original string, so the working-directory caller is
   * unchanged, and a non-string title falls back to it rather than reaching
   * Electron as junk.
   */
  server.handle(RPC_CHANNELS.dialog.OPEN_FOLDER, async (ctx, params?: { title?: string }) => {
    const requested = params?.title
    const result = await requestClientOpenFileDialog(server, ctx.clientId, {
      properties: ['openDirectory', 'createDirectory'],
      title: typeof requested === 'string' && requested.trim() !== ''
        ? requested
        : 'Select Working Directory',
    })
    return result.canceled ? null : result.filePaths[0]
  })

  // ============================================================
  // Workspace Settings (per-workspace configuration)
  // ============================================================

  // Get Workspace-owned settings. Project cwd is managed through opaque handles.
  server.handle(RPC_CHANNELS.workspace.SETTINGS_GET, async (_ctx, workspaceId: string) => {
    let workspace: ResolvedWorkspace
    try {
      workspace = getWorkspaceOrThrow(deps.workspaceService, workspaceId)
    } catch {
      deps.platform.logger.error(`Workspace not found: ${workspaceId}`)
      return null
    }
    const config = workspace.config

    return {
      name: config?.name,
      model: config?.defaults?.model,
      permissionMode: config?.defaults?.permissionMode,
      // P4.8 — what a new session in this workspace gets when the line above is
      // absent, which is the common case: `createSession` resolves
      // `managedPiPolicy.defaultMode ?? wsConfig?.defaults?.permissionMode ??
      // globalDefaults.workspaceDefaults.permissionMode`, and this is that last
      // term. Sent because the page cannot compute it — a renderer has no
      // access to the config defaults — and it was hardcoding `'default'`
      // instead, displaying Manual for a workspace whose sessions start in Auto.
      //
      // The managed tier is deliberately not folded in HERE — it is sent
      // alongside instead, on the line below, so the page can say *which* tier
      // decided rather than being handed one blended answer it cannot explain.
      effectiveDefaultPermissionMode: loadConfigDefaults().workspaceDefaults.permissionMode,
      // P2.489 — the FIRST term of the same chain, and the reason the control
      // above could be honest and still wrong: on an install that deploys a
      // managed mode, `createSession` never reaches the workspace value, so the
      // control wrote something no session would read and said nothing.
      //
      // Read live off the session manager (its `managedPiPolicy` getter
      // re-reads, so an administrator's mid-run tightening reaches this page on
      // its next read), never from a boot snapshot. `?.` because the method is
      // optional on `ISessionManager`: an embedder that composes no managed
      // policy answers `undefined`, which is what an unmanaged install sends
      // too. Absence therefore means UNMANAGED rather than unknown — the
      // fail-open direction, because reading absence as managed would disable a
      // working control on every install that has no policy at all.
      //
      // Read-only: the name is absent from `SETTINGS_UPDATE`'s `validKeys`
      // below, so a write is refused by the handler rather than silently taken.
      managedDefaultPermissionMode: deps.sessionManager.managedDefaultPermissionMode?.(),
      // P6.821 — the two ceilings a session is stopped at, disclosed because
      // NEITHER can be set from this app and two notices used to tell the user
      // to set one anyway. Both come from the resolvers the enforcement reads
      // (`resolveMaxBudgetTokens` is what `BaseAgent` compares turns against;
      // `resolveMaxBudgetUsd` is what the `maxBudgetUsdReached` latch rests
      // on), never recomputed here — a disclosure that derived its own number
      // would present as authoritative a ceiling nothing enforces.
      //
      // Read LIVE on every call, like `effectiveDefaultPermissionMode` above and
      // for the same reason: `syncConfigDefaults` rewrites `config-defaults.json`
      // from the bundle on every launch, so an operator's change reaches this
      // page on its next read rather than at the next restart.
      //
      // Read-only: the name is absent from `SETTINGS_UPDATE`'s `validKeys`
      // below, so a write is refused rather than silently taken.
      budgetCeilings: {
        maxBudgetTokens: resolveMaxBudgetTokens(),
        maxBudgetUsd: resolveMaxBudgetUsd(),
      },
      cyclablePermissionModes: config?.defaults?.cyclablePermissionModes,
      thinkingLevel: normalizeThinkingLevel(config?.defaults?.thinkingLevel),
      localMcpEnabled: config?.localMcpServers?.enabled ?? true,
      defaultLlmConnection: config?.defaults?.defaultLlmConnection,
      enabledSourceSlugs: config?.defaults?.enabledSourceSlugs ?? [],
    }
  })

  // Update a workspace setting
  server.handle(RPC_CHANNELS.workspace.SETTINGS_UPDATE, async (_ctx, workspaceId: string, key: string, value: unknown) => {
    const workspace = getWorkspaceOrThrow(deps.workspaceService, workspaceId)
    const normalizedValue = value

    // Validate key is a known workspace setting
    const validKeys = ['name', 'model', 'enabledSourceSlugs', 'permissionMode', 'cyclablePermissionModes', 'thinkingLevel', 'localMcpEnabled', 'defaultLlmConnection']
    if (!validKeys.includes(key)) {
      throw new Error(`Invalid workspace setting key: ${key}. Valid keys: ${validKeys.join(', ')}`)
    }

    // Validate defaultLlmConnection exists before saving
    if (key === 'defaultLlmConnection' && normalizedValue !== undefined && normalizedValue !== null) {
      const { getLlmConnection } = await import('@nessy-agent/shared/config/storage')
      if (!getLlmConnection(normalizedValue as string)) {
        throw new Error(`LLM connection "${normalizedValue}" not found`)
      }
    }

    if (key === 'name') {
      await deps.workspaceService!.rename(workspaceId, String(normalizedValue))
      return
    }

    if (key === 'localMcpEnabled') {
      await deps.workspaceService!.updateSettings(workspaceId, {
        localMcpEnabled: Boolean(normalizedValue),
      })
    } else if (normalizedValue === undefined || normalizedValue === null) {
      await deps.workspaceService!.updateSettings(workspaceId, {
        clearDefaults: [key as WorkspaceDefaultSettingKey],
      })
    } else {
      await deps.workspaceService!.updateSettings(workspaceId, {
        defaults: { [key]: normalizedValue },
      })
    }
    deps.platform.logger.info(`Workspace setting updated: ${key} = ${JSON.stringify(normalizedValue)}`)
  })

  // ============================================================
  // User Preferences
  // ============================================================

  // Read user preferences file
  server.handle(RPC_CHANNELS.preferences.READ, async () => {
    const path = getPreferencesPath()
    if (!existsSync(path)) {
      return { content: '{}', exists: false }
    }
    return { content: readFileSync(path, 'utf-8'), exists: true }
  })

  // Write user preferences file (validates JSON before saving)
  server.handle(RPC_CHANNELS.preferences.WRITE, async (_, content: string) => {
    try {
      JSON.parse(content) // Validate JSON
      const path = getPreferencesPath()
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, content, 'utf-8')
      return { success: true }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
    }
  })

  // ============================================================
  // Session Drafts (persisted input text)
  // ============================================================

  // drafts.json is a single global file keyed by the composite {workspaceId,
  // sessionId}. Every renderer window is workspace-scoped and threads its
  // workspaceId alongside the bare sessionId so two workspaces that reuse the
  // same session id never share a draft.

  // Get draft for a session (text + attachment refs)
  server.handle(RPC_CHANNELS.drafts.GET, async (_ctx, sessionId: string, workspaceId: string) => {
    return getSessionDraft({ workspaceId, sessionId })
  })

  // Set draft for a session (empty drafts are cleared)
  server.handle(RPC_CHANNELS.drafts.SET, async (_ctx, sessionId: string, workspaceId: string, draft: import('@nessy-agent/shared/config').SessionDraft) => {
    setSessionDraft({ workspaceId, sessionId }, draft)
  })

  // Delete draft for a session
  server.handle(RPC_CHANNELS.drafts.DELETE, async (_ctx, sessionId: string, workspaceId: string) => {
    deleteSessionDraft({ workspaceId, sessionId })
  })

  // Get all drafts for the calling window's workspace (for loading on app start)
  server.handle(RPC_CHANNELS.drafts.GET_ALL, async (_ctx, workspaceId: string) => {
    return getAllSessionDrafts(workspaceId)
  })

  // ============================================================
  // Input Settings
  // ============================================================

  // Get auto-capitalisation setting
  server.handle(RPC_CHANNELS.input.GET_AUTO_CAPITALISATION, async () => {
    const { getAutoCapitalisation } = await import('@nessy-agent/shared/config/storage')
    return getAutoCapitalisation()
  })

  // Set auto-capitalisation setting
  server.handle(RPC_CHANNELS.input.SET_AUTO_CAPITALISATION, async (_ctx, enabled: boolean) => {
    const { setAutoCapitalisation } = await import('@nessy-agent/shared/config/storage')
    setAutoCapitalisation(enabled)
  })

  // Get send message key setting
  server.handle(RPC_CHANNELS.input.GET_SEND_MESSAGE_KEY, async () => {
    const { getSendMessageKey } = await import('@nessy-agent/shared/config/storage')
    return getSendMessageKey()
  })

  // Set send message key setting
  server.handle(RPC_CHANNELS.input.SET_SEND_MESSAGE_KEY, async (_ctx, key: 'enter' | 'cmd-enter') => {
    const { setSendMessageKey } = await import('@nessy-agent/shared/config/storage')
    setSendMessageKey(key)
  })

  // Get spell check setting
  server.handle(RPC_CHANNELS.input.GET_SPELL_CHECK, async () => {
    const { getSpellCheck } = await import('@nessy-agent/shared/config/storage')
    return getSpellCheck()
  })

  // Set spell check setting
  server.handle(RPC_CHANNELS.input.SET_SPELL_CHECK, async (_ctx, enabled: boolean) => {
    const { setSpellCheck } = await import('@nessy-agent/shared/config/storage')
    setSpellCheck(enabled)
  })

  // ============================================================
  // Power Settings
  // ============================================================

  // Get keep awake while running setting
  server.handle(RPC_CHANNELS.power.GET_KEEP_AWAKE, async () => {
    const { getKeepAwakeWhileRunning } = await import('@nessy-agent/shared/config/storage')
    return getKeepAwakeWhileRunning()
  })

  // ============================================================
  // Appearance Settings
  // ============================================================

  // Get rich tool descriptions setting
  server.handle(RPC_CHANNELS.appearance.GET_RICH_TOOL_DESCRIPTIONS, async () => {
    const { getRichToolDescriptions } = await import('@nessy-agent/shared/config/storage')
    return getRichToolDescriptions()
  })

  // Set rich tool descriptions setting
  server.handle(RPC_CHANNELS.appearance.SET_RICH_TOOL_DESCRIPTIONS, async (_ctx, enabled: boolean) => {
    const { setRichToolDescriptions } = await import('@nessy-agent/shared/config/storage')
    setRichToolDescriptions(enabled)
  })

  // ============================================================
  // Prompt Caching Settings
  // ============================================================

  // Get extended prompt cache (1h TTL) setting
  server.handle(RPC_CHANNELS.caching.GET_EXTENDED_PROMPT_CACHE, async () => {
    const { getExtendedPromptCache } = await import('@nessy-agent/shared/config/storage')
    return getExtendedPromptCache()
  })

  // Set extended prompt cache (1h TTL) setting
  server.handle(RPC_CHANNELS.caching.SET_EXTENDED_PROMPT_CACHE, async (_ctx, enabled: boolean) => {
    const { setExtendedPromptCache } = await import('@nessy-agent/shared/config/storage')
    setExtendedPromptCache(enabled)
  })

  // ============================================================
  // RTK Token-Optimization Settings
  // ============================================================

  // Get rtk Bash-output compression setting
  server.handle(RPC_CHANNELS.rtk.GET_ENABLED, async () => {
    const { getRtkEnabled } = await import('@nessy-agent/shared/config/storage')
    return getRtkEnabled()
  })

  // Set rtk Bash-output compression setting
  server.handle(RPC_CHANNELS.rtk.SET_ENABLED, async (_ctx, enabled: boolean) => {
    const { setRtkEnabled } = await import('@nessy-agent/shared/config/storage')
    setRtkEnabled(enabled)
  })

  // Detect rtk installation (used by Settings UI to swap install prompt ↔ toggle)
  server.handle(RPC_CHANNELS.rtk.GET_STATUS, async (_ctx, opts?: { forceRecheck?: boolean }) => {
    const { getRtkStatus } = await import('@nessy-agent/shared/agent')
    return getRtkStatus(opts)
  })

  // Token-savings summary from `rtk gain --format json` (efficiency meter)
  server.handle(RPC_CHANNELS.rtk.GET_GAIN, async () => {
    const { getRtkGain } = await import('@nessy-agent/shared/agent')
    return getRtkGain()
  })

  // ============================================================
  // Guardian Safety-Judge Settings
  // ============================================================

  // Get whether the guardian safety judge is enabled (default: true)
  server.handle(RPC_CHANNELS.guardian.GET_ENABLED, async () => {
    const { getGuardianEnabled } = await import('@nessy-agent/shared/config/storage')
    return getGuardianEnabled()
  })

  // Set whether the guardian safety judge is enabled
  server.handle(RPC_CHANNELS.guardian.SET_ENABLED, async (_ctx, enabled: boolean) => {
    const { setGuardianEnabled } = await import('@nessy-agent/shared/config/storage')
    setGuardianEnabled(enabled)
  })

  // Get the guardian judge model id ('' => gateway `fast` alias default)
  server.handle(RPC_CHANNELS.guardian.GET_MODEL, async () => {
    const { getGuardianJudgeModelId } = await import('@nessy-agent/shared/config/storage')
    return getGuardianJudgeModelId()
  })

  // Set the guardian judge model id ('' clears the override back to default)
  // PER INTEGRATION (H1). The global pair above is kept for the legacy value's
  // read path — no migration — but the UI writes through these two.
  server.handle(RPC_CHANNELS.guardian.GET_MODELS_BY_CONNECTION, async (): Promise<Record<string, string>> => {
    const { getGuardianJudgeModels } = await import('@nessy-agent/shared/config/storage')
    return getGuardianJudgeModels()
  })

  /**
   * P2.527 — a judge model the managed allowlist forbids is REFUSED at the
   * write, not stored and then dropped at use.
   *
   * What this replaces: the write went straight to storage without consulting
   * the allowlist, and `resolveGuardianJudgeModel` later found the stored id
   * `!isModelAllowed` and fell through to the default. So a user picked a judge,
   * the picker kept showing it, and a DIFFERENT model ran the deny-net over auto
   * mode — with no signal to the user, the administrator or the log. Storing a
   * lie and substituting silently are each defensible alone; together they are
   * the fork's own silent-divergence class.
   *
   * The pattern is `sessions.SET_MODEL`'s, one section up, and deliberately the
   * SAME call and the SAME code so a renderer that already knows how to read one
   * refusal reads both: `AiSettingsPage.handleGuardianModelChange` rolls back its
   * optimistic state and branches on `MODEL_RESTRICTED_BY_POLICY` (P2.502), an
   * arm that shipped unreachable and becomes reachable here.
   *
   * CLEARING IS ALWAYS PERMITTED (`''`), exactly as `model === null` is on the
   * session write: it resolves back through the chain to the `fast` alias or the
   * session's own model, which no allowlist can make unreachable. Refusing a
   * clear would trap a user on a forbidden judge with no way back.
   *
   * The substitution in `resolveGuardianJudgeModel` STAYS, and that is not a
   * contradiction: a preference can become forbidden after it was stored (policy
   * changes, connection deleted, model dropped from the catalog), and a broken
   * preference must never disable the deny-net it configures. This closes the
   * entry point; the resolver keeps failing safe on everything already on disk.
   */
  const refuseUnselectableJudgeModel = (modelId: string): void => {
    if (modelId !== '' && !isManagedModelSelectable(modelId)) {
      throw new CodedError(
        'MODEL_RESTRICTED_BY_POLICY',
        `Model is restricted by managed policy: ${modelId}`,
      )
    }
  }

  server.handle(RPC_CHANNELS.guardian.SET_MODEL_FOR_CONNECTION, async (_ctx, slug: string, modelId: string) => {
    refuseUnselectableJudgeModel(modelId)
    const { setGuardianJudgeModelForConnection } = await import('@nessy-agent/shared/config/storage')
    setGuardianJudgeModelForConnection(slug, modelId)
  })

  // The legacy global write. Gated by the same rule rather than left open: it is
  // still a reachable channel (`electronAPI.setGuardianModel`), and a per-channel
  // exemption is how a closed door grows a second entrance.
  server.handle(RPC_CHANNELS.guardian.SET_MODEL, async (_ctx, modelId: string) => {
    refuseUnselectableJudgeModel(modelId)
    const { setGuardianJudgeModelId } = await import('@nessy-agent/shared/config/storage')
    setGuardianJudgeModelId(modelId)
  })

  // ============================================================
  // Advisor Settings
  // ============================================================

  /**
   * P2.528 — the advising model had NO IPC surface at all. `getAdvisorModelId` /
   * `setAdvisorModelId` and their enable pair existed and were reachable only
   * in-process, so `/advisor` was the entire surface: no settings row could
   * exist, whatever the renderer wanted to draw.
   *
   * Shaped as guardian's four handlers above and NOT as a new pattern, because
   * it is the same class of key and the same refusal. What is deliberately NOT
   * here, and the warning for whoever builds the picker:
   *
   * - **The resolution is SESSION-scoped and cannot be answered here.**
   *   `resolveAdvisorModel` refuses for THREE distinct reasons —
   *   `refused-entitlement` (the session connection's catalogue does not offer
   *   the model), `refused-allowlist` (managed policy), `refused-capability`
   *   (the pairing table ranks it below the session's own model) — and two of
   *   the three depend on the session's connection and model, which a settings
   *   handler has neither of. Only the allowlist arm is global, and that is the
   *   one refused at the write below. A handler that answered the other two
   *   would be guessing, and P2.528's own warning is that a picker reporting the
   *   wrong reason is worse than one reporting nothing: the session already says
   *   which one fired (`base-agent.ts`, the three `settings.ai.advisor.
   *   statusRefused*` lines).
   * - **An empty catalogue is NOT an empty list.** The resolver reads it as *no
   *   narrowing*, so the honest empty state a picker shows is "the session's own
   *   model advises" — the documented default — never a blank list.
   *
   * Locale keys for a settings row do not exist yet either; that namespace holds
   * only the status lines above. This row is the plumbing, and the picker is the
   * renderer lane's.
   */
  server.handle(RPC_CHANNELS.advisor.GET_ENABLED, async () => {
    const { getAdvisorEnabled } = await import('@nessy-agent/shared/config/storage')
    return getAdvisorEnabled()
  })

  server.handle(RPC_CHANNELS.advisor.SET_ENABLED, async (_ctx, enabled: boolean) => {
    const { setAdvisorEnabled } = await import('@nessy-agent/shared/config/storage')
    setAdvisorEnabled(enabled)
  })

  // `''` is "the session's own model advises", the documented default.
  server.handle(RPC_CHANNELS.advisor.GET_MODEL, async () => {
    const { getAdvisorModelId } = await import('@nessy-agent/shared/config/storage')
    return getAdvisorModelId()
  })

  /**
   * The same call and the same code as `guardian.SET_MODEL` and
   * `sessions.SET_MODEL`, for the same reason P2.527 gave: storing an id the
   * allowlist forbids and then refusing it at consult time is storing a lie and
   * substituting silently, which is this fork's own silent-divergence class.
   *
   * CLEARING IS ALWAYS PERMITTED (`''`) — it resolves to the session's own
   * model, which no allowlist can make unreachable, so a user can always get
   * back out. The consult-time `refused-allowlist` branch STAYS: a preference
   * can become forbidden after it was stored, and this closes the entry point
   * rather than the resolver.
   */
  server.handle(RPC_CHANNELS.advisor.SET_MODEL, async (_ctx, modelId: string) => {
    const trimmed = modelId.trim()
    if (trimmed !== '' && !isManagedModelSelectable(trimmed)) {
      throw new CodedError(
        'MODEL_RESTRICTED_BY_POLICY',
        `Model is restricted by managed policy: ${trimmed}`,
      )
    }
    const { setAdvisorModelId } = await import('@nessy-agent/shared/config/storage')
    setAdvisorModelId(trimmed)
  })

  // ============================================================
  // The auto-mode judge's own rules (read-only)
  // ============================================================

  /**
   * P6.209, denominator entries A44 and A45 — the judge's rules had no surface
   * at all: `autoMode` scored ZERO across `apps/electron/src`, `packages/ui` and
   * the i18n catalogue, while the block itself has been sent on every Claude
   * session since P3.94.
   *
   * **Composed, not configured.** The handler returns the four arrays exactly as
   * `buildClaudeAutoModePolicySettings` produces them. A view derived from the
   * inputs would be a second composition, free to disagree with the one that
   * goes on the wire — and "what is the judge actually told" is the entire
   * question this surface exists to answer.
   *
   * **The gateway sentence is session-scoped, so it is SPLIT rather than
   * guessed.** `buildClaudeAutoModeEnvironmentRules` emits it only for a session
   * whose adapter resolved the `nestor` upstream, and a settings page has no
   * session. Composing twice and reporting the difference lets the page state
   * the condition; picking one side would be wrong for half the installs. The
   * difference is computed rather than restated here, so a change to that
   * builder cannot leave this handler describing the old split — the same reason
   * the arrays themselves are not re-listed.
   *
   * **Read-only, and the missing setter is a decision.** Whether an operator may
   * EDIT these lists is an open owner question; the viewer is the half that is
   * correct under either answer, which is why the row asks for it first.
   *
   * Never throws: the composition reads the managed policy floor from disk, and
   * a settings page that failed because a policy file was unreadable would be
   * worse than one that says it could not look.
   */
  server.handle(RPC_CHANNELS.permissions.GET_AUTO_MODE_POLICY, async () => {
    const { buildClaudeAutoModePolicySettings } = await import(
      '@nessy-agent/shared/agent/claude-auto-mode-policy'
    )
    const plain = buildClaudeAutoModePolicySettings({ gatewayUpstream: false }).autoMode
    const onGateway = buildClaudeAutoModePolicySettings({ gatewayUpstream: true }).autoMode
    // Every array is optional on the SDK's own type, so each is defaulted here
    // rather than asserted: an absent array means "this deployment adds nothing
    // in that band", which renders as an empty section and is a true statement.
    const environment = plain.environment ?? []
    const alreadySent = new Set(environment)
    return {
      environment: [...environment],
      gatewayEnvironment: (onGateway.environment ?? []).filter(rule => !alreadySent.has(rule)),
      hardDeny: [...(plain.hard_deny ?? [])],
      softDeny: [...(plain.soft_deny ?? [])],
      classifyAllShell: plain.classifyAllShell === true,
    }
  })

  // ============================================================
  // Settings-file tiers diagnosis (read-only)
  // ============================================================

  /**
   * P6.576 — the two settings-file tiers had no surface in the app.
   *
   * `buildConfigDoctorReport` already existed and its only production consumer
   * was `apps/cli/src/doctor.ts`: a managed policy in effect, a refused managed
   * entry, a settings layer rejected whole and a shadowed policy file were all
   * discoverable exclusively by running a CLI the app ships no route to.
   *
   * Read-only by construction (owner decision D12), like `GET_PROVENANCE`: this
   * handler collects and renders, and there is no setter beside it.
   *
   * **P6.775 — the doctor's collectors are called here.** This handler passed
   * `collectConfigDoctorInput()` alone and carried a comment explaining that the
   * other collectors "are unexported functions inside `apps/cli/src/doctor.ts`,
   * so they cannot be called from here". Every clause of that sentence stopped
   * being true when P6.684 and P6.760 moved all seven to
   * `@nessy-agent/shared/config/doctor-collectors` — and the comment kept the
   * narrowing alive after its own cause was gone, which is this fork's
   * silent-divergence class arriving through a stale explanation rather than
   * through code. The list, the order and the `undefined`-omits-the-section
   * convention are `runDoctor`'s own, so the page and the terminal render one
   * record rather than two.
   *
   * Two collectors cannot be parameter-free, and both are answered as the CLI
   * answers them: the mandate one takes the ENFORCED `enabledPlugins` map, which
   * is `server-core`'s to resolve, and the search-backend one takes this host's
   * runtime, so a packaged desktop reports its bundled ripgrep rather than the
   * CLI's unpackaged answer.
   *
   * **P6.787 — the last absent section, and it was absent only because the
   * channel took no argument.** Project instruction files are measured in a
   * DIRECTORY: the CLI answers with the project the user ran it in, and this
   * process's cwd is not anybody's project, so a parameter-free handler had no
   * honest directory to hand the collector. It did not follow that the page
   * could never have one — `LIST_OUTPUT_STYLES`, twenty lines up in this same
   * file, has taken an optional `workspaceId` all along.
   *
   * Controller decision, transparent and simple: **the page speaks for the
   * workspace the window has open, and the renderer's note names it.** An
   * app-level page reporting a project-scoped section without saying which
   * project would be the silent-divergence shape this whole report exists to
   * remove; naming it costs one sentence.
   *
   * `workspaceId` is OPTIONAL and its absence is not an error — every other
   * caller (the CLI's own `--json` route, a headless client, the playground)
   * gets exactly the report it got before, and the renderer's `cliNote` is the
   * true sentence in that case. An id that does not resolve is treated the same
   * way as a collector returning `undefined`: the section is omitted rather than
   * the page being failed, because "I could not look" and "there is nothing" are
   * different answers and only one of them is honest here.
   *
   * `SessionManager.announceSettingsTiers` gates the same collector on
   * `workspace.rootPath`; this is the same gate reached through the wire.
   *
   * Never throws on a collector's behalf: each one already returns `undefined`
   * for "I could not look", which omits its section. The mandate collector is the
   * one that needs a resolve first, and both halves are wrapped inside
   * `collectMandatedPluginFindingsFromEnforcedPolicy` (P6.788) rather than here —
   * a diagnosis that fails a settings page is worse than the silence it replaces,
   * and that judgement now has one place to live instead of three.
   */
  server.handle(RPC_CHANNELS.settings.GET_CONFIG_DOCTOR, async (_ctx, workspaceId?: string) => {
    const { buildConfigDoctorReport } = await import('@nessy-agent/shared/config/config-doctor')
    const {
      collectAgentDefinitionFindings,
      collectConfigOnlySettings,
      collectInstructionFileFindings,
      collectGatewayAuthInput,
      collectNetworkTrustInput,
      collectSearchBackendInput,
      collectStoredConfigValidationInput,
      collectUncarriedSandboxKeys,
      collectUserAutoModeInput,
    } = await import('@nessy-agent/shared/config/doctor-collectors')
    const { collectConfigDoctorInput, collectMandatedPluginFindingsFromEnforcedPolicy } = await import(
      '../../bootstrap/managed-policy-resolution.ts'
    )
    const collected = collectConfigDoctorInput()
    // P6.788 — the enforced-policy wiring and the decision its `catch` encodes
    // ("I could not look", so omit the section rather than claim no mandate
    // exists) have ONE definition now. This block used to spell it out and its
    // own comment called itself the CLI's copy "verbatim in intent".
    const mandatedPlugins = collectMandatedPluginFindingsFromEnforcedPolicy()
    // The collector's own default is `process.cwd()`, which is the CLI's honest
    // answer and the desktop's meaningless one — so it is called with a resolved
    // root or not at all, never with the default.
    let instructionFiles: ReturnType<typeof collectInstructionFileFindings>
    if (workspaceId !== undefined) {
      try {
        const { workspaceRootPath } = getWorkspaceOrThrow(deps.workspaceService, workspaceId)
        instructionFiles = workspaceRootPath ? collectInstructionFileFindings(workspaceRootPath) : undefined
      } catch {
        instructionFiles = undefined
      }
    }
    const agentDefinitions = collectAgentDefinitionFindings()
    const searchBackend = collectSearchBackendInput(buildBackendHostRuntimeContext(deps.platform))
    const networkTrust = collectNetworkTrustInput()
    // DA1.34 — the shared gateway credential, in the same vocabulary the
    // DA1.4 card uses. Codes, lengths and booleans; never a token value.
    const gatewayAuth = collectGatewayAuthInput()
    const sandboxUncarriedKeys = collectUncarriedSandboxKeys()
    const userAutoMode = collectUserAutoModeInput()
    // P6.878 — parameter-free, and the same read on both surfaces:
    // `validateConfig()` resolves `<config dir>/config.json` from this process's
    // own CONFIG_DIR, which the desktop and the CLI share.
    const storedConfigValidation = collectStoredConfigValidationInput()
    // P6.824 — parameter-free like its neighbour, and the same read on both
    // surfaces: both files it names come from this process's own CONFIG_DIR.
    const configOnlySettings = collectConfigOnlySettings()
    return buildConfigDoctorReport({
      ...collected,
      ...(mandatedPlugins === undefined ? {} : { mandatedPlugins }),
      ...(instructionFiles === undefined ? {} : { instructionFiles }),
      ...(agentDefinitions === undefined ? {} : { agentDefinitions }),
      ...(searchBackend === undefined ? {} : { searchBackend }),
      ...(networkTrust === undefined ? {} : { networkTrust }),
      ...(gatewayAuth === undefined ? {} : { gatewayAuth }),
      ...(sandboxUncarriedKeys === undefined ? {} : { sandboxUncarriedKeys }),
      ...(userAutoMode === undefined ? {} : { userAutoMode }),
      ...(storedConfigValidation === undefined ? {} : { storedConfigValidation }),
      ...(configOnlySettings === undefined ? {} : { configOnlySettings }),
    })
  })

  // ============================================================
  // Codex auto-review (codex's own approval reviewer)
  // ============================================================

  /**
   * P6.225 — the reviewer was fully wired and reachable only by hand-editing our
   * config file: no toggle, no policy field.
   *
   * **Native-first, and nothing is built beside it.** These two keys are inputs
   * to codex's OWN mechanism — `config-writer.ts` emits
   * `approvals_reviewer = "auto_review"` and `[auto_review].policy`,
   * `CodexAutoReviewBreaker` opens the turn-scoped circuit, and `/approve`
   * overrules a denial. The host supplies only the surface that sets them.
   *
   * Shaped as advisor's four handlers above and NOT as a new pattern: same class
   * of key, same file, same local-only routing. Two differences from advisor,
   * both deliberate:
   *
   * - **No managed-policy refusal at the write.** Advisor and guardian refuse a
   *   model id the allowlist forbids; there is no model id here. The policy is
   *   free text appended to codex's own reviewer prompt, and `''` — the
   *   documented default — means codex's policy is used unchanged.
   * - **Only turning it OFF reaches a running session** (F1.781: each codex turn
   *   re-reads the toggle and asks for `'user'`). Turning it ON, and the policy,
   *   take effect when codex's config file is written for the NEXT session.
   */
  server.handle(RPC_CHANNELS.codexAutoReview.GET_ENABLED, async () => {
    const { getCodexAutoReviewEnabled } = await import('@nessy-agent/shared/config/storage')
    return getCodexAutoReviewEnabled()
  })

  server.handle(RPC_CHANNELS.codexAutoReview.SET_ENABLED, async (_ctx, enabled: boolean) => {
    const { setCodexAutoReviewEnabled } = await import('@nessy-agent/shared/config/storage')
    setCodexAutoReviewEnabled(enabled)
  })

  /**
   * C3.286 — codex's delegation off-switch, the in-app half of C3.109.
   *
   * Same two deliberate properties as the pair above, and for the same reason:
   * no managed-policy refusal at the write (there is no model id here, only a
   * boolean), and the write does NOT reach a running session, because
   * `[agents] enabled` is an entry in codex's own config file read when that file
   * is written for the NEXT session. The renderer copy says so.
   */
  server.handle(RPC_CHANNELS.codexSubagents.GET_ENABLED, async () => {
    const { getCodexSubagentsEnabled } = await import('@nessy-agent/shared/config/storage')
    return getCodexSubagentsEnabled()
  })

  server.handle(RPC_CHANNELS.codexSubagents.SET_ENABLED, async (_ctx, enabled: boolean) => {
    const { setCodexSubagentsEnabled } = await import('@nessy-agent/shared/config/storage')
    setCodexSubagentsEnabled(enabled)
  })

  /**
   * C3.178 — which attached folder is primary, and the set the choice is made
   * from, answered together.
   *
   * `candidates` are the RESOLVED `additionalDirectories` — the same canonical
   * roots the permission gate is handed, through the same reader — so the
   * control cannot offer a folder that failed validation and is not attached.
   * The derived root (the project, or the managed workspace) is the implicit
   * first option and is deliberately NOT in this list: it is per-session, this
   * setting is install-wide, and naming one session's project here would make
   * the control describe whichever session happened to be open.
   *
   * `null` for `choice` is the documented "use the derivation" state.
   */
  server.handle(RPC_CHANNELS.primaryDirectory.GET, async () => {
    const { getPrimaryDirectory } = await import('@nessy-agent/shared/config/storage')
    const { getConfiguredAdditionalDirectories } = await import('@nessy-agent/shared/agent')
    return {
      choice: getPrimaryDirectory() ?? null,
      candidates: getConfiguredAdditionalDirectories(),
    }
  })

  server.handle(RPC_CHANNELS.primaryDirectory.SET, async (_ctx, value: string | null) => {
    const { setPrimaryDirectory } = await import('@nessy-agent/shared/config/storage')
    setPrimaryDirectory(typeof value === 'string' && value.trim().length > 0 ? value : undefined)
  })

  // `''` is "use codex's own policy unchanged", the documented default.
  server.handle(RPC_CHANNELS.codexAutoReview.GET_POLICY, async () => {
    const { getCodexAutoReviewPolicy } = await import('@nessy-agent/shared/config/storage')
    return getCodexAutoReviewPolicy()
  })

  server.handle(RPC_CHANNELS.codexAutoReview.SET_POLICY, async (_ctx, policy: string) => {
    const { setCodexAutoReviewPolicy } = await import('@nessy-agent/shared/config/storage')
    setCodexAutoReviewPolicy(policy)
  })

  // ============================================================
  // Settings provenance (read-only)
  // ============================================================

  /**
   * P6.168 — which file and scope supplied each family of settings.
   *
   * `settings.md#confirm-what-loaded` (the section the page once titled *debug settings
   * precedence*, renamed — P6.663) is explicit that the runtime we
   * vendor does not answer this, verbatim: *"The line confirms which files
   * Claude Code read; it doesn't show which file supplied each key."* Its two
   * narrow exceptions do not either (`claude doctor` lists REJECTED entries
   * only; the startup header names a file only for a model), and
   * `SDKSystemMessage` carries no such field. So the host answers it once, from
   * its OWN merge, which is why the text is identical on all three runtimes.
   *
   * Read-only by construction (owner decision D12, 2026-09-05): this handler
   * stats and parses, and writes nothing. Every read fails open — an unreadable
   * or unparseable file is reported as supplying nothing, which is exactly what
   * each of the four readers does with it.
   *
   * The four families and their scope orders are NOT restated here. Each is
   * taken from the reader that owns it, and the shared module holds the keys and
   * the combine rule so this collector and those readers cannot drift apart in
   * prose.
   */
  server.handle(RPC_CHANNELS.settings.GET_PROVENANCE, async (_ctx, workspaceId?: string) => {
    const {
      SETTINGS_PROVENANCE_COMBINE,
      classifySettingsProvenanceEntry,
    } = await import('@nessy-agent/shared/config/config-doctor')
    type Report = import('@nessy-agent/shared/config/config-doctor').SettingsProvenanceReportV1
    type Family = import('@nessy-agent/shared/config/config-doctor').SettingsProvenanceFamilyV1
    type FamilyId = import('@nessy-agent/shared/config/config-doctor').SettingsProvenanceFamilyIdV1
    type Entry = import('@nessy-agent/shared/config/config-doctor').SettingsProvenanceEntryV1

    const { CONFIG_DIR } = await import('@nessy-agent/shared/config')
    const { homedir } = await import('node:os')
    const { join } = await import('node:path')

    const projectDirectory = workspaceId
      ? getWorkspaceOrThrow(deps.workspaceService, workspaceId).workspaceRootPath
      : undefined

    /** A settings document, or `undefined` for anything this host would ignore. */
    const readDocument = (file: string): Record<string, unknown> | undefined => {
      try {
        if (!existsSync(file)) return undefined
        const parsed: unknown = JSON.parse(readFileSync(file, 'utf-8'))
        return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
          ? parsed as Record<string, unknown>
          : undefined
      } catch {
        return undefined
      }
    }

    const claudeProject = projectDirectory ? join(projectDirectory, '.claude', 'settings.json') : undefined
    const claudeLocal = projectDirectory ? join(projectDirectory, '.claude', 'settings.local.json') : undefined
    // The HOST's user scope, and it is correctly the operator's home file: this
    // process's own `resolveInstructionExcludes` reads
    // `<CLAUDE_CONFIG_DIR or ~/.claude>/settings.json`. It is NOT the child's —
    // see `claudeChildSettingSources` below, which D1.334 re-derived.
    const claudeUser = join(homedir(), '.claude', 'settings.json')
    const claudeChildConfigDir = workspaceId ? workspaceClaudeConfigDirPath(workspaceId) : undefined
    const nessyConfig = join(CONFIG_DIR, 'config.json')

    const entriesFor = (
      id: FamilyId,
      candidates: readonly (readonly [Entry['scope'], string])[],
    ): Family => ({
      id,
      combine: SETTINGS_PROVENANCE_COMBINE[id],
      entries: candidates.map(([scope, file]) =>
        classifySettingsProvenanceEntry(scope, file, id, readDocument(file))),
    })

    const families: Family[] = [
      // `capabilities/native-sources.ts` reads Claude's own permission files
      // "BESIDE ours — never instead", at project scope, local after project.
      entriesFor('permissions', [
        ...(projectDirectory ? [['project', join(projectDirectory, '.nessy-agent', 'permissions.json')] as const] : []),
        ...(claudeProject ? [['project', claudeProject] as const] : []),
        ...(claudeLocal ? [['local', claudeLocal] as const] : []),
      ]),
      // `resolveInstructionExcludes`: user config first, then project, then local.
      entriesFor('instructionExcludes', [
        ['user', nessyConfig],
        ...(claudeUser ? [['user', claudeUser] as const] : []),
        ...(claudeProject ? [['project', claudeProject] as const] : []),
        ...(claudeLocal ? [['local', claudeLocal] as const] : []),
      ]),
      // `resolveSkillOverrides`: user config, then the two project files.
      entriesFor('skillOverrides', [
        ['user', nessyConfig],
        ...(claudeProject ? [['project', claudeProject] as const] : []),
        ...(claudeLocal ? [['local', claudeLocal] as const] : []),
      ]),
    ]

    // The managed family is answered by the doctor report's own composition
    // rather than by re-reading files here: it is winner-takes-all at the SOURCE
    // level, and a second reader of the same policy is exactly the drift this
    // row exists to remove. `state` is what the winner says.
    const { collectConfigDoctorInput } = await import('../../bootstrap/managed-policy-resolution')
    try {
      const managed = collectConfigDoctorInput()
      const managedEntries: Entry[] = []
      if (managed.filePath) {
        managedEntries.push({
          scope: 'managed',
          file: managed.filePath,
          state: managed.winner === 'file' && managed.fileCarriesSettings
            ? 'supplies'
            : managed.fileCarriesSettings ? 'present-no-keys' : 'missing',
        })
      }
      if (managed.deliveryCachePath) {
        managedEntries.push({
          scope: 'managed',
          file: managed.deliveryCachePath,
          state: managed.winner === 'delivered' ? 'supplies' : 'missing',
        })
      }
      if (managedEntries.length > 0) {
        families.push({
          id: 'managedSettings',
          combine: SETTINGS_PROVENANCE_COMBINE.managedSettings,
          entries: managedEntries,
        })
      }
    } catch {
      // "Could not resolve a policy at all" omits the family, the same
      // distinction `buildConfigDoctorReport` draws for its caveats section.
    }

    // The child's own stack: the `settingSources` `claude-agent.ts` passes it.
    // We name what we told it to read; what it made of them is not readable
    // back, by the page's own admission, so this is listed as a second stack
    // rather than merged above.
    //
    // F1.790 — WHICH sources is not a constant. Since F1.768 the child gets
    // `project` and `local` only for a project the host trusted, and `['user']`
    // otherwise (`ClaudeAgent.projectTrustSettingSources`), and the operator's
    // `--setting-sources` narrows the list before that. This view listed the
    // documented triple whatever the trust, so a restricted project showed two
    // files the child never opens. The list is now composed by the SAME two
    // calls the agent makes ({@link claudeSettingSourcesForProjectTrust} over
    // `resolveClaudeSettingSources(process.env)`; this handler and the agent
    // share one process, so one env), falling back to the documented triple
    // the SDK option builder uses when both leave it unset.
    //
    // F1.1184 — and this view has no project to be trusted: see the note at the
    // call below. Nothing is looked up and nothing is written (D12 holds).
    //
    // D1.334 — the USER scope is the CHILD's, not this process's, and this line
    // published the operator's home file until RS-77 read the two accounts side
    // by side and found ZERO overlap:
    //
    // | account | file |
    // | --- | --- |
    // | this view PUBLISHED | `~/.claude/settings.json`, state `supplies` |
    // | the CHILD's own `[DEBUG]` named | `<config>/workspaces/<id>/claude-config/settings.json` |
    //
    // The home file exists on a developer machine and carries `permissions`,
    // `hooks`, `env` and `model`, so it was reported as SUPPLYING settings to a
    // child that never opens it — the exact silent divergence this second stack
    // exists to remove, committed by the stack itself. `buildClaudeSubprocessEnv`
    // gives each Workspace its own `CLAUDE_CONFIG_DIR`
    // (`workspaceClaudeConfigDir`), and the vendored binary's `configHomeDir()`
    // follows it, so the child's user scope is that directory's `settings.json`.
    //
    // Derived through `workspaceClaudeConfigDirPath`, the NON-creating sibling:
    // this handler is read-only by construction and must not grow a
    // `claude-config/` because someone opened the settings page.
    //
    // WITHOUT a workspace there is no child and no directory to name, so the
    // user leg is omitted rather than guessed — an entry naming a file nobody
    // reads is what this row is repairing.
    const claudeChildUser = claudeChildConfigDir
      ? join(claudeChildConfigDir, 'settings.json')
      : undefined
    const { CLAUDE_SETTING_SOURCES, resolveClaudeSettingSources } = await import(
      '@nessy-agent/shared/config/claude-flag-settings'
    )
    // F1.1184 — no trust lookup: the only folder this view has is the workspace's own data folder
    // (`workspaceRootPath`, under CONFIG_DIR), which ProjectHandleService refuses as a project every time, so the
    // "trusted" arm F1.790 added could never fire (decided under the owner's rule 2026-10-08: drop the arm and its
    // locale promise rather than thread a session's project into a page that has no session). The child stack is
    // the untrusted one — what a Claude session gets in a project nobody trusted, and here the honest default.
    const claudeChildSources = claudeSettingSourcesForProjectTrust(
      resolveClaudeSettingSources(process.env),
      false,
    ) ?? CLAUDE_SETTING_SOURCES
    const claudeChildSourceFile = { user: claudeChildUser, project: claudeProject, local: claudeLocal }
    const claudeChildSettingSources: Entry[] = claudeChildSources.flatMap(scope => {
      const file = claudeChildSourceFile[scope]
      return file ? [classifySettingsProvenanceEntry(scope, file, 'permissions', readDocument(file))] : []
    })

    /**
     * P6.447 — the connection pane, INSIDE this view rather than beside it.
     *
     * The row's own sequencing rule is that it "must not open a competing
     * page": P6.168 owns the settings-provenance surface and this is the same
     * question one layer out — where an effective answer came from — so it
     * rides the same channel and the same section.
     *
     * WORKSPACE-effective, not session-effective, and the surface says so: a
     * settings page has no session, and `resolveEffectiveConnectionSlug`'s
     * first argument is the per-session override. Naming a session's connection
     * here would be a guess.
     *
     * The proxy WINNER is the first `proxyEnv` entry that is not `ALL_PROXY` —
     * `collectNetworkTrustInput` documents that the four documented names come
     * first in the page's binding order, and that `ALL_PROXY` is listed for the
     * operator's benefit while binding nothing. Fail-soft: a connection store or
     * a network probe that cannot be read omits the pane rather than failing the
     * checkup, exactly like the managed family above.
     */
    let connection: ConnectionProvenanceV1 | undefined
    try {
      const [
        { getLlmConnections, getDefaultLlmConnection },
        { describeConnectionProvenance },
        { collectNetworkTrustInput },
        { resolveEffectiveConnectionSlug },
      ] = await Promise.all([
        import('@nessy-agent/shared/config/storage'),
        import('@nessy-agent/shared/agent/diagnostics'),
        import('@nessy-agent/shared/config/doctor-collectors'),
        import('@nessy-agent/shared/config/llm-connections'),
      ])
      const connections = getLlmConnections()
      const appDefault = getDefaultLlmConnection()
      const workspaceDefault = workspaceId
        ? getWorkspaceOrThrow(deps.workspaceService, workspaceId).config.defaults?.defaultLlmConnection
        : undefined
      // The SAME resolver every session uses, with its per-session argument
      // deliberately empty: this page has no session.
      const slug = resolveEffectiveConnectionSlug(
        undefined,
        workspaceDefault,
        connections.map(entry => ({ slug: entry.slug, isDefault: entry.slug === appDefault })),
      )
      const proxyEnv = collectNetworkTrustInput()?.proxyEnv ?? []
      const winner = proxyEnv.find(entry => entry.name !== 'ALL_PROXY' && entry.name !== 'all_proxy')
      const effective = connections.find(entry => entry.slug === slug)
      connection = describeConnectionProvenance({
        ...(effective ? { connection: effective } : {}),
        ...(winner ? { proxy: winner } : {}),
      })
    } catch {
      // "Could not read the connection at all" omits the pane. An invented
      // answer here is indistinguishable from a real one, which is the whole
      // failure this view exists to remove.
    }

    /**
     * P6.169 — the codex runtime's OWN per-key answer, when a codex session in
     * this host process has reported one.
     *
     * Read from a module-scope record rather than from a live agent, and that
     * is the design and not a shortcut: `config/read` rides an app-server
     * connection a SESSION holds, and a settings page has none. Reaching into
     * `SessionManager` for one would make a read-only checkup depend on session
     * lifetime and would widen a seam this handler does not own. The recorder
     * is `agent/codex-config-origins.ts`, written on every codex spawn.
     *
     * P6.823 — read for THIS workspace. The record is keyed by workspace id
     * because `config/read` resolves the project layer from the session's
     * `cwd`; without the key, two open workspaces were shown whichever layer
     * stack started a codex session last. A page opened without a workspace
     * reads only what a session without one wrote, rather than borrowing an
     * answer that belongs to a directory it did not name.
     *
     * Absent means "no codex session has answered here", never "codex has no
     * layers" — the section says so, because an empty list that reads like an
     * answer is the defect this whole view exists to remove. Fail-soft like the
     * connection pane above.
     */
    let codex: import('@nessy-agent/shared/config/config-doctor').CodexConfigProvenanceV1 | undefined
    try {
      const { readRecordedCodexConfigProvenance } = await import(
        '@nessy-agent/shared/agent/codex-config-origins'
      )
      codex = readRecordedCodexConfigProvenance(workspaceId)
    } catch {
      // A module that cannot be loaded omits the section, exactly as an
      // unreadable connection store omits its pane.
    }

    const report: Report & { connection?: ConnectionProvenanceV1 } = {
      families,
      claudeChildSettingSources,
      ...(projectDirectory === undefined ? {} : { projectDirectory }),
      ...(connection ? { connection } : {}),
      ...(codex ? { codex } : {}),
    }
    return report
  })

  // ============================================================
  // Tools Settings
  // ============================================================

  server.handle(RPC_CHANNELS.tools.GET_BROWSER_TOOL_ENABLED, async () => {
    const { getBrowserToolEnabled } = await import('@nessy-agent/shared/config/storage')
    return getBrowserToolEnabled()
  })

  server.handle(RPC_CHANNELS.tools.SET_BROWSER_TOOL_ENABLED, async (_ctx, enabled: boolean) => {
    const { setBrowserToolEnabled } = await import('@nessy-agent/shared/config/storage')
    setBrowserToolEnabled(enabled)
  })

  // P6.564 — the browser pane's download destination. The READ carries the
  // effective policy beside the stored one, because the environment outranks
  // the file: without that, a user could type a root, see it saved, and have
  // every download ignore it. `describeBrowserDownloadSettings` is the same
  // resolver the pane manager uses, so the form cannot disagree with the pane.
  server.handle(RPC_CHANNELS.tools.GET_BROWSER_DOWNLOAD_SETTINGS, async () => {
    const [{ getBrowserDownloadSettings }, { describeBrowserDownloadSettings }] = await Promise.all([
      import('@nessy-agent/shared/config/storage'),
      import('@nessy-agent/shared/config/browser-download'),
    ])
    return describeBrowserDownloadSettings(getBrowserDownloadSettings())
  })

  server.handle(
    RPC_CHANNELS.tools.SET_BROWSER_DOWNLOAD_SETTINGS,
    async (_ctx, next: { root?: string; ask?: boolean }) => {
      const [{ getBrowserDownloadSettings, setBrowserDownloadSettings }, { describeBrowserDownloadSettings }] =
        await Promise.all([
          import('@nessy-agent/shared/config/storage'),
          import('@nessy-agent/shared/config/browser-download'),
        ])
      setBrowserDownloadSettings(next ?? {})
      // Answer with the resolved view rather than an ack: a root the resolver
      // refuses must reach the user as a sentence, not as a silently saved field.
      return describeBrowserDownloadSettings(getBrowserDownloadSettings())
    },
  )

  // ============================================================
  // Built-in dp-backed MCP set (A7) — the per-server switch
  // ============================================================

  // Every built-in with its effective state, plus whether `dp` is installed at
  // all. The list is served whole even when dp is missing: the settings surface
  // has to explain why nothing can start rather than show a dead toggle, and it
  // needs the rows to say it about.
  server.handle(RPC_CHANNELS.builtinDpMcp.LIST, async () => {
    const { readBuiltinDpMcpSettingsView } = await import('@nessy-agent/shared/config')
    return readBuiltinDpMcpSettingsView()
  })

  // Straight through `setBuiltinDpMcpServerEnabled`, which is where the write's
  // rules live: an unknown wire name is refused (a stored one is still IGNORED
  // on read — that asymmetry is the forward-compatibility seam), only the named
  // server's entry is touched, and the write goes through the config storage
  // path rather than around it.
  server.handle(RPC_CHANNELS.builtinDpMcp.SET_ENABLED, async (_ctx, name: string, enabled: boolean) => {
    if (typeof name !== 'string' || !name) throw new Error('built-in dp MCP server name must be a non-empty string')
    if (typeof enabled !== 'boolean') throw new Error('built-in dp MCP server enablement must be a boolean')
    const { setBuiltinDpMcpServerEnabled } = await import('@nessy-agent/shared/config')
    setBuiltinDpMcpServerEnabled(name, enabled)
    deps.sessionManager.invalidateWorkspaceMcpPools()
    // F1.1251 — the switch moved a source in every workspace's catalog, and nothing else on this path says so: an
    // open source page (its tools list, its detail) re-reads on `capabilities.CHANGED`. App-wide, so every workspace
    // is told, and only after the write and the pool invalidation above, so the re-read sees the new state.
    for (const workspace of deps.sessionManager.getWorkspaces()) {
      pushTyped(server, RPC_CHANNELS.capabilities.CHANGED, { to: 'workspace', workspaceId: workspace.id }, {
        workspaceId: workspace.id,
        generation: '',
        reasonCode: 'builtin-dp-mcp-changed',
        effect: 'refresh-before-next-turn',
      })
    }
  })

  // ============================================================
  // Retention — the destructive age-based cleanup of session data
  // ============================================================

  // The window, the off switch, and the reason the sweep is not running when it
  // is not. `settings-reference.md#cleanupperioddays` makes the sweep
  // conditional — "Claude Code runs the deletion as a background sweep after a
  // session starts, as long as it can safely determine the retention period" —
  // and says nothing about surfacing the condition, so showing the pause
  // somewhere a user looks is OUR call, not the page's; this payload is what
  // the settings card renders.
  server.handle(RPC_CHANNELS.retention.GET_SETTINGS, async () => {
    const { getRetentionSettings } = await import('@nessy-agent/shared/config/storage')
    return getRetentionSettings()
  })

  // Straight through `setRetentionDays`, which is where the documented minimum
  // lives: `settings-reference.md#cleanupperioddays` — "**Type**: number of
  // days, a whole number, minimum `1`" and "Setting `0` fails validation, so
  // pick a large value such as `3650` for long retention." Bypassing it here
  // would put the write back out of the
  // validator's reach, which is the whole defect this handler exists to close.
  server.handle(RPC_CHANNELS.retention.SET_DAYS, async (_ctx, days: number) => {
    const { setRetentionDays } = await import('@nessy-agent/shared/config/storage')
    setRetentionDays(days)
  })

  server.handle(RPC_CHANNELS.retention.SET_SWEEP_ENABLED, async (_ctx, enabled: boolean) => {
    if (typeof enabled !== 'boolean') throw new Error('retention sweep enablement must be a boolean')
    const { setRetentionSweepEnabled } = await import('@nessy-agent/shared/config/storage')
    setRetentionSweepEnabled(enabled)
  })

  // ============================================================
  // Cross-session inbound — text arriving from the user's own other sessions
  // ============================================================

  // P6.868 — all four states in one read, because the settings surface must show
  // the precedence the value is subject to and a renderer composing the layers
  // itself would be a second resolver. The two lower-scope project files are
  // deliberately NOT read: they are per-project, they can only tighten, and the
  // enforcement module re-reads them per message by design.
  server.handle(RPC_CHANNELS.settings.GET_CROSS_SESSION_INBOUND, async () => {
    const { getCrossSessionInboundSettings } = await import('@nessy-agent/shared/config/storage')
    return getCrossSessionInboundSettings()
  })

  // `null` CLEARS the key. The page's "unset, so Claude Code decides per
  // message" is a distinct documented behaviour, and `setCrossSessionInbound`
  // refuses anything outside the three precisely so a stored value always means
  // one of them — a sentinel would make the app's unset and a hand-edited file's
  // unset two different states.
  server.handle(RPC_CHANNELS.settings.SET_CROSS_SESSION_INBOUND, async (_ctx, mode: unknown) => {
    const store = await import('@nessy-agent/shared/config/storage')
    if (mode === null) return store.clearCrossSessionInbound()
    if (typeof mode !== 'string'
      || !(store.CROSS_SESSION_INBOUND_SETTINGS as readonly string[]).includes(mode)) {
      throw new Error(
        `cross-session inbound mode must be one of ${store.CROSS_SESSION_INBOUND_SETTINGS.join(', ')} or null`,
      )
    }
    return store.setCrossSessionInbound(mode as typeof store.CROSS_SESSION_INBOUND_SETTINGS[number])
  })

  // ============================================================
  // MCP channel push (a connected server steering a live turn)
  // ============================================================

  server.handle(RPC_CHANNELS.permissions.GET_MCP_CHANNEL_PUSH, async () => {
    const { getMcpChannelPushEnabled } = await import('@nessy-agent/shared/config/storage')
    return getMcpChannelPushEnabled()
  })

  server.handle(RPC_CHANNELS.permissions.SET_MCP_CHANNEL_PUSH, async (_ctx, enabled: boolean) => {
    const { setMcpChannelPushEnabled } = await import('@nessy-agent/shared/config/storage')
    setMcpChannelPushEnabled(enabled)
  })

  /**
   * P6.510 — the arming VERB, the caller the host API landed without.
   *
   * `armSessionChannelSources` and `disarmSessionChannelSources` were committed
   * with the per-session grant and had no route to them at all, so the softer
   * boundary the delegated decision chose (option 2: a session set SEEDED from
   * the persistent preference) was reachable only from inside the process.
   *
   * Several servers at once, which is the row's own `done_means` clause — the
   * parameter is a list, not a name — and the answer is the session's whole
   * armed set rather than a delta, so a caller renders what it has rather than
   * what it just added. Nothing here re-derives the managed bound:
   * `SessionManager.resolveChannelPolicy` applies `allowedChannelServers`,
   * `deniedMcpServers` and the terminal `channelsEnabled: false` on every read,
   * so an administrator's mandate that tightens AFTER an arming still takes
   * effect. Validating the list against the bound here would freeze the answer
   * at arming time and quietly become a second, weaker gate.
   *
   * The grant is session-scoped by construction: it lives on the managed
   * session record and dies with it, so there is no expiry to implement and no
   * store to purge.
   */
  server.handle(
    RPC_CHANNELS.permissions.ARM_SESSION_CHANNEL_SOURCES,
    async (_ctx, sessionId: string, workspaceId: string, sources: readonly string[]): Promise<readonly string[]> => {
      if (!Array.isArray(sources) || sources.some(source => typeof source !== 'string')) {
        throw new Error('channel sources must be an array of server names')
      }
      return deps.sessionManager.armSessionChannelSources(sessionId, sources, workspaceId)
    },
  )

  server.handle(
    RPC_CHANNELS.permissions.DISARM_SESSION_CHANNEL_SOURCES,
    async (_ctx, sessionId: string, workspaceId: string): Promise<void> => {
      deps.sessionManager.disarmSessionChannelSources(sessionId, workspaceId)
    },
  )

  // ============================================================
  // Saved workspace actions (P6.361) — the user-invocable entry point
  // ============================================================

  /**
   * The list, re-read on every call.
   *
   * Never a cached one: `getUserWorkspaceActions` applies the operator kill
   * switch (`disableSkillShellExecution`) AT THE READ and answers `[]` while it
   * is on, so the switch has to be able to take effect between the render and
   * the click. A menu built from a snapshot taken at startup would keep offering
   * actions after an administrator turned them off.
   */
  server.handle(RPC_CHANNELS.workspaceActions.LIST, async (): Promise<readonly ResolvedWorkspaceAction[]> => {
    const { getUserWorkspaceActions } = await import('@nessy-agent/shared/config/storage')
    return getUserWorkspaceActions()
  })

  /**
   * Run one saved action, BY ID, on the path the agent's own Bash already takes.
   *
   * Three things this deliberately does not do, and each is the row's own
   * clause rather than a preference:
   *
   * 1. **It does not accept a command.** An id is resolved here, against the
   *    store, so the channel cannot become a second way to execute arbitrary
   *    shell from the renderer beside the one that asks for approval.
   * 2. **It does not execute anything itself.** `SessionManager.runShellCommand`
   *    is the existing seam — it applies `shouldAllowToolInMode('Bash', …)`, the
   *    explore/plan refusal, the `default`-mode approval card and the auto-mode
   *    prompt, and it persists the output as a session message. A second
   *    executor beside it is exactly the divergence this plan exists to remove.
   * 3. **It re-reads the store rather than trusting the list the caller saw.**
   *    Same reason as the LIST comment above: the kill switch must win a race
   *    with a click.
   *
   * The action's `cwd` rides the SAME seam rather than a second one (P6.720):
   * `runShellCommand` takes the RELATIVE path and contains it against the
   * session's own working directory with `resolveWorkspaceActionCwd` (the
   * store's rule, the same words the declaration-time parser uses). Passing it
   * through unresolved is deliberate — a path this handler had already joined
   * would arrive at the executor as an absolute string with no memory of having
   * been checked, and the executor is reachable from the session `command` verb
   * too, so the containment has to live there rather than at one of its callers.
   *
   * **Residue, stated because it is real and short-lived:** the argument is
   * passed and the executor does not read it yet. `SessionManager.runShellCommand`
   * was another lane's file the hour this landed, so its four-line hunk
   * (`relativeCwd` parameter + the contained `cwd`) is handed off in
   * `lane-W8-z-report.md`. Until it applies, an action with a `cwd` runs where it
   * runs today — unchanged behaviour, not a new one — and an action WITHOUT a
   * `cwd` is byte-identical either way.
   */
  server.handle(
    RPC_CHANNELS.workspaceActions.RUN,
    async (_ctx, sessionId: string, workspaceId: string, actionId: string) => {
      if (typeof actionId !== 'string' || actionId.trim() === '') {
        throw new Error('A saved action id is required')
      }
      const { getUserWorkspaceActions } = await import('@nessy-agent/shared/config/storage')
      const action = getUserWorkspaceActions().find(candidate => candidate.id === actionId)
      if (!action) {
        // Covers BOTH "no such action" and "actions are turned off", on purpose:
        // the read answers `[]` under the kill switch, and a refusal that
        // distinguished the two would report an operator's policy to a caller
        // that has no business reading it.
        // A plain Error and not a new `ErrorCode`: the renderer already owns the
        // wording (`chat.workspaceActions.refused`) and never renders this
        // string, so minting a wire code would add a contract nobody reads.
        throw new Error(`No saved action: ${actionId}`)
      }
      return deps.sessionManager.runShellCommand(sessionId, action.command, workspaceId, action.cwd)
    },
  )

  // ============================================================
  // bypassPermissions responsibility acknowledgment (T5)
  // ============================================================
  // Single durable source, config.json tier. NOT reachable from any
  // model-invocable tool — only the renderer's responsibility-dialog
  // accept path calls the SET channel (apps/electron/src/renderer/lib/
  // bypass-permissions-gate.ts).

  server.handle(RPC_CHANNELS.permissions.GET_BYPASS_PERMISSIONS_ACKNOWLEDGED, async () => {
    const { getBypassPermissionsAcknowledged } = await import('@nessy-agent/shared/config/storage')
    return getBypassPermissionsAcknowledged()
  })

  server.handle(RPC_CHANNELS.permissions.SET_BYPASS_PERMISSIONS_ACKNOWLEDGED, async (_ctx, acknowledged: boolean) => {
    const { setBypassPermissionsAcknowledged } = await import('@nessy-agent/shared/config/storage')
    setBypassPermissionsAcknowledged(acknowledged)
  })

  // ============================================================
  // Process isolation availability (read-only diagnosis)
  // ============================================================

  // Serves the startup probe when the host ran one; otherwise probes on demand
  // so a standalone server still answers rather than reporting nothing.
  server.handle(RPC_CHANNELS.permissions.GET_ISOLATION_CAPABILITIES, async () => {
    if (deps.isolationCapabilities) return deps.isolationCapabilities
    const { probeIsolationCapabilities } = await import('../../pi-harness/isolation-capabilities')
    // The on-demand probe resolves the master switch itself: without it the
    // report lists available profiles for a layer that is off by default, which
    // is the surface claiming protection the host is not applying.
    const { resolveSandboxEnabled } = await import('@nessy-agent/shared/config/sandbox-settings')
    const { getUserSandboxSettings } = await import('@nessy-agent/shared/config/storage')
    const { resolveManagedSandboxEnabledFloor } = await import('@nessy-agent/shared/config/storage')
    return probeIsolationCapabilities({
      sandboxEnabled: resolveSandboxEnabled([getUserSandboxSettings()], resolveManagedSandboxEnabledFloor()),
    })
  })

  // P6.327 — what the two switches actually resolve to, and whether an
  // administrator has already decided either one. Resolved through the SAME
  // units the supervisor resolves from (`resolveSandboxEnabled` outright for
  // the master switch, `resolveSandboxSettings`' boolean-AND for the escape
  // hatch) against the managed policy as the floor, so this panel cannot
  // report something other than what runs — the drift R25c shipped.
  server.handle(RPC_CHANNELS.permissions.GET_SANDBOX_SWITCHES, async () => {
    const { getUserSandboxSettings } = await import('@nessy-agent/shared/config/storage')
    const { resolveSandboxEnabled, resolveSandboxSettings } = await import(
      '@nessy-agent/shared/config/sandbox-settings'
    )
    const { loadManagedPiPolicy } = await import('../../pi-harness/managed-policy-loader')
    const floor = loadManagedPiPolicy().sandbox ?? {}
    const user = getUserSandboxSettings()
    return {
      enabled: resolveSandboxEnabled([user], floor),
      allowUnsandboxedCommands: resolveSandboxSettings([user], { floor }).allowUnsandboxedCommands,
      // A pinned switch is shown and not offered: writing a value an
      // administrator's floor will overrule is the surface lying about who is
      // in control. `enabled` is pinned by ANY managed value (it wins
      // outright); the escape hatch is pinned only by a managed `false`,
      // because a managed `true` still leaves the user layer free to deny.
      enabledManaged: floor.enabled !== undefined,
      allowUnsandboxedCommandsManaged: floor.allowUnsandboxedCommands === false,
    }
  })

  // P6.327 — the write half of the panel above. The user layer only: an
  // administrator's `enabled` floor outranks it outright and
  // `allowUnsandboxedCommands` is boolean-ANDed across the floor and every
  // layer, so this cannot loosen a managed policy. The panel disables a switch
  // the floor has already decided rather than letting the user write one that
  // will be silently overruled.
  server.handle(
    RPC_CHANNELS.permissions.SET_SANDBOX_SWITCHES,
    async (_ctx, next: { enabled?: boolean; allowUnsandboxedCommands?: boolean }) => {
      const { setUserSandboxSwitches } = await import('@nessy-agent/shared/config/storage')
      setUserSandboxSwitches(next ?? {})
    },
  )

  // ============================================================
  // Network Proxy Settings
  // ============================================================

  // Get network proxy settings
  server.handle(RPC_CHANNELS.settings.GET_NETWORK_PROXY, async () => {
    const { getNetworkProxySettings } = await import('@nessy-agent/shared/config/storage')
    return getNetworkProxySettings()
  })
}
