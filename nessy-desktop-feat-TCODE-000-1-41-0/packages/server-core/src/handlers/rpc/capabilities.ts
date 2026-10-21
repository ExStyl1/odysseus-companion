/**
 * Unified safe capability RPC routes (W8 Steps 6/7, server side).
 *
 * Every view-only route resolves a `SafeCapabilityContextRef` into the server-only
 * `CapabilityContext`, then wraps resolve/project/serialize in
 * `withCapabilitySnapshot` so the snapshot lease is released in `finally` on
 * success, projection/serialization error, cancel or disconnect — the lease
 * registry returns to zero. Only path-/secret-free DTOs cross this boundary.
 *
 * Pre-W10 the resolver reads the live runtime through the single legacy adapter
 * supplied by the verified-v2 storage runtime.
 */
import { reportPostPersistTurnFailure } from './sessions.ts'
import { join } from 'node:path'
import { CONFIG_DIR, isKnownBuiltinDpMcpServer, readBuiltinDpMcpSettingsView, type BuiltinDpMcpSettingsViewV1 } from '@nessy-agent/shared/config'
import { createCapabilitySnapshotMaterializer } from '@nessy-agent/shared/capabilities/materializer'
import { detectProjectContributions, piLanguageServerContribution } from '@nessy-agent/shared/capabilities/project-contribution-detect'
import {
  withCapabilitySnapshot,
  type CapabilityResolver,
  type EffectiveCapabilitySnapshot,
  type ResolvedCapability,
  type ResolvedCapabilityEntry,
  pluginCapabilityTrustKeyMaterial,
} from '@nessy-agent/shared/capabilities/resolver'
import type { CapabilityTrustKey, CapabilityTrustStore } from '@nessy-agent/shared/capabilities/trust-store'
import {
  buildHeadlessInitView,
  toAgentRuntime, toComposerCatalog,
  toSafeDiagnostic,
  toSafeSummary,
  toUserCatalog,
  type HeadlessInitMcpHealth,
} from '@nessy-agent/shared/capabilities/views'
import { ProjectHandleService } from '@nessy-agent/shared/projects/project-handle-service'
import { cronToolsAbsentFor, LOOP_SKILL_SLUG } from '../../sessions/SessionManager.ts'
import {
  RPC_CHANNELS,
  isManagedResourceRef,
  isManagedResourceEditRequest,
  isMutableManagedResourceRef,
  isPreviewableManagedResourceRef,
  isSafeGrantTrustRequest,
  isSafeRevokeTrustRequest,
  type ManagedResourceRef,
  type ManagedResourceEditRequest,
  type MutableManagedResourceRef,
  type PreviewableManagedResourceRef,
  type ProjectContributionReport,
  type SafeCapabilityContextRef,
  type SafeCapabilityDetail,
  type SafeMcpToolsResult,
  type SafePluginPresentationOrigin,
  type SafeSessionRef,
  type SafeTrustMutationResult,
  type SafeTrustReviewItem,
  type SafeTrustReviewsResult,
} from '@nessy-agent/shared/protocol'
import { resolveContainedPath } from '@nessy-agent/shared/workspaces'
import type { RequestContext, RpcServer } from '@nessy-agent/server-core/transport'
import type { HandlerDeps } from '../handler-deps'
import { resolveCapabilityContext } from '../../domain/capabilities/context'
import {
  previewManagedResource,
  resolveManagedEditContext,
  resolveManagedResource,
  summarizeManagedResource,
  ManagedResourceError,
  type ManagedResourceDeps,
} from '../../domain/capabilities/managed-resources'
import { afterPluginMutation } from './plugin-runtime-refresh'

export const HANDLED_CHANNELS = [
  RPC_CHANNELS.capabilities.GET_CATALOG,
  RPC_CHANNELS.capabilities.GET_COMPOSER_CATALOG,
  RPC_CHANNELS.capabilities.GET_DETAIL,
  RPC_CHANNELS.capabilities.GET_HEADLESS_INIT,
  RPC_CHANNELS.capabilities.LIST_MCP_TOOLS,
  RPC_CHANNELS.capabilities.PREVIEW,
  RPC_CHANNELS.capabilities.SUMMARY,
  RPC_CHANNELS.capabilities.OPEN,
  RPC_CHANNELS.capabilities.REVEAL,
  RPC_CHANNELS.capabilities.SUBMIT_MANAGED_EDIT,
  RPC_CHANNELS.capabilities.LIST_TRUST_REVIEWS,
  RPC_CHANNELS.capabilities.GRANT_TRUST,
  RPC_CHANNELS.capabilities.REVOKE_TRUST,
  RPC_CHANNELS.capabilities.DETECT_PROJECT_CONTRIBUTIONS,
] as const

export interface CapabilitiesHandlerOptions {
  resolver?: CapabilityResolver
  handleService?: ProjectHandleService
  managedResourceDeps?: Partial<ManagedResourceDeps>
  trustStore?: CapabilityTrustStore
  mcpTools?: { cache?: McpToolsCache; now?: () => number } // U3 MCP-tools list cache/clock injection point (tests).
  builtinDpView?: () => BuiltinDpMcpSettingsViewV1 // F1.461: GET_DETAIL's dp-availability read (`withBuiltinDpAvailability`).
}

export function registerCapabilitiesHandlers(
  server: RpcServer,
  deps: HandlerDeps,
  options: CapabilitiesHandlerOptions = {},
): void {
  const handleService = options.handleService ?? deps.sessionManager.getProjectHandleService?.()
  const resolver = options.resolver ?? deps.sessionManager.getCapabilityResolver?.()
  if (!handleService || !resolver) {
    throw new Error('Verified capability runtime is required')
  }
  const trustStore = options.trustStore ?? deps.capabilityTrustStore
  const managedDeps: ManagedResourceDeps = {
    resolveWorkspaceRootPath:
      options.managedResourceDeps?.resolveWorkspaceRootPath
      ?? ((workspaceId: string) => {
        try {
          return deps.workspaceService?.resolve(workspaceId).workspaceRootPath
        } catch {
          return undefined
        }
      }),
    resolveProjectRootPath:
      options.managedResourceDeps?.resolveProjectRootPath
      ?? ((workspaceId: string, sessionId: string) => (
        deps.sessionManager.getWorkingDirectory(sessionId, workspaceId) ?? undefined
      )),
    resolvePluginSkillResource: options.managedResourceDeps?.resolvePluginSkillResource,
    globalConfigDir: options.managedResourceDeps?.globalConfigDir ?? CONFIG_DIR,
    globalSkillsDir: options.managedResourceDeps?.globalSkillsDir ?? join(CONFIG_DIR, 'skills'),
  }

  const contextFor = async (ctx: RequestContext, ref: unknown) => {
    const context = await resolveCapabilityContext(ref, {
      handleService,
      resolveSessionWorkingDirectory: (workspaceId, sessionId) => (
        deps.sessionManager.getWorkingDirectory(sessionId, workspaceId) ?? undefined
      ),
      // Q8-D4 — EVERY user-readable capability read routes through here, so this
      // is the one seam where the catalog's runtime gate gets its input. The
      // provider is read from the live session by the session manager, not
      // taken from the ref: like the working directory above, a renderer must
      // not be able to choose which runtime the catalog answers for.
      resolveSessionProvider: (workspaceId, sessionId) => (
        deps.sessionManager.getSessionProvider?.(sessionId, workspaceId)
      ),
    })
    if (!ctx.workspaceId || ctx.workspaceId !== context.workspaceId) {
      throw new CapabilityContextScopeError()
    }
    return context
  }

  server.handle(RPC_CHANNELS.capabilities.GET_CATALOG, async (ctx, ref: unknown) => {
    const context = await contextFor(ctx, ref)
    const presentationByPluginKey = await presentationByPluginKeyFor(deps)
    return withCapabilitySnapshot(resolver, context, snapshot => toUserCatalog(snapshot, presentationByPluginKey))
  })

  server.handle(RPC_CHANNELS.capabilities.GET_COMPOSER_CATALOG, async (ctx, ref: unknown) => {
    const context = await contextFor(ctx, ref)
    return withCapabilitySnapshot(resolver, context, snapshot => {
      const catalog = toComposerCatalog(snapshot)
      // R39/T17, third surface. The `loop` skill is withheld wherever its cron
      // tools are not mounted, and `cronToolsAbsentFor` is that condition —
      // T1-widened from `provider === 'pi'` to `SCHEDULED_DELIVERY_RUNTIMES`
      // (plus the env flag). The GROUND has moved since this comment was first
      // written, and its old wording ("they are `visibility: 'pi-only'`, so a
      // non-Pi projection drops them") is now the opposite of the truth: after
      // T3 the five scheduling/watching tools ARE projected onto claude, which
      // is why the predicate keeps the skill there. The runtime this filter
      // actually withholds for is `nestor-cloud-agent`, the one member of
      // `AgentProvider` outside `SCHEDULED_DELIVERY_RUNTIMES` — it runs no
      // host-side tool loop, so a scheduled fire would have nothing to wake.
      // Read the predicate, not this comment, for the membership.
      //
      // **P2.211 replaced one optimistic sentence here with another, and this
      // is the correction** (P2.280). It said "T5 landed, a shipping codex
      // spawn carries `--host-callback-port`, and the four cron tools reach it
      // over that bridge". A shipping codex spawn carries that argument only
      // when the bridge STARTED: `CodexAgent.startCallbackBridge` fails
      // non-fatally by design — its own words are "scheduling tools stay
      // unavailable this session" — and a session it failed for runs its whole
      // life with 18 tools and none of the cron four (measured on HEAD; a
      // bridged codex surface is 26 and holds all four). Codex's membership in
      // `SCHEDULED_DELIVERY_RUNTIMES` is therefore CONDITIONAL, and this filter
      // cannot see the condition.
      //
      // **No bridge argument is passed to `cronToolsAbsentFor` here, and that
      // is a measured decision rather than an omission.** Two facts, either
      // sufficient on its own. (1) There is no value to pass at the moment that
      // matters: this route resolves a snapshot from `(resolver, context)`, and
      // even reaching through `deps.sessionManager` would find `managed.agent`
      // null — the agent is built by `getOrCreateAgent`, and the bridge later
      // still, inside the chat generator's `ensureRuntime()`, so on a freshly
      // opened session nothing has tried to start one yet. (2) The catalog has
      // no re-derivation cadence that would let a later answer land: the
      // renderer's `refreshCapabilityViews` depends on
      // `[activeSessionWorkingDirectory, activeWorkspaceId, session.selected]`
      // and on nothing that changes at a turn boundary. A gate added here would
      // be dead in the very case it exists for, which is worse than no gate:
      // the next reader would take it for enforcement. The gate that DOES fire
      // is on the model-facing turn view in
      // `SessionManager.createCapabilityTurn`, rebuilt on every send;
      // `skillSlashCommands` carries the same condition into the `/` menu. The
      // residue — the FIRST turn of a session whose bridge fails — is not
      // closable at any listing site, because the fact does not exist yet when
      // the listing is made.
      //
      // The same withhold was applied to the slash-command list and to the
      // model-facing runtime view; THIS is the list the composer palette
      // renders, and without it the user is offered a command
      // whose entire mechanism left with the runtime. The model then answers as
      // though it scheduled something, because nothing errors — measured live
      // as RTS-11 on packaged 1.26.1, where `/loop` was offered identically on
      // Pi, Claude and Codex.
      //
      // Kind-guarded, unlike the two skill-list call sites: this catalog is a
      // MIXED capability list, and a `logicalName` match alone would also drop
      // a source or an MCP server that happened to be called `loop`.
      if (!cronToolsAbsentFor(snapshot.context.provider)) return catalog
      return {
        ...catalog,
        items: catalog.items.filter(item => !(item.kind === 'skill' && item.logicalName === LOOP_SKILL_SLUG)),
      }
    })
  })

  // `headless.md:197` — the `system/init` frame the CLI writes as line 1 of a
  // `--output-format stream-json` run, and the only channel through which a CI
  // job can see that a plugin was demoted or an MCP entry skipped (`:222`: with
  // stderr captured, "Claude Code prints no warning and reports the skipped
  // entries only in the `mcp_server_errors` field").
  //
  // Live MCP health is best-effort ON PURPOSE. At the moment this is read the
  // session exists but no turn has run, so the Pi runtime has not started and
  // there is nothing to connect to yet; the projection then reports `pending`,
  // which is the status the page itself uses for a server that has not
  // connected. Never let that read fail the frame.
  server.handle(RPC_CHANNELS.capabilities.GET_HEADLESS_INIT, async (ctx, ref: unknown) => {
    const context = await contextFor(ctx, ref)
    let mcpHealth: HeadlessInitMcpHealth | undefined
    if (context.sessionId) {
      try {
        const runtime = await deps.sessionManager.getPiHarnessRuntimeSnapshot({
          workspaceId: context.workspaceId,
          sessionId: context.sessionId,
        })
        if (runtime.mcpHealth) {
          mcpHealth = { connected: runtime.mcpHealth.connected, failed: runtime.mcpHealth.failed }
        }
      } catch {
        // Session not managed yet, or a non-Pi provider: `pending` for all.
      }
    }
    // P6.263 — the runtime's own protocol capabilities, on the frame a CI job
    // already reads. Best-effort like `mcpHealth` above and for the same reason:
    // a session that is not managed yet advertises nothing, which is an empty
    // list rather than a failed frame.
    const protocolCapabilities = context.sessionId
      ? (deps.sessionManager.getSessionProtocolCapabilities?.({
          workspaceId: context.workspaceId,
          sessionId: context.sessionId,
        }) ?? [])
      : []
    return withCapabilitySnapshot(
      resolver,
      context,
      snapshot => buildHeadlessInitView(snapshot, mcpHealth, protocolCapabilities),
    )
  })

  server.handle(RPC_CHANNELS.capabilities.GET_DETAIL, async (ctx, ref: unknown, capabilityKey: string) => {
    const context = await contextFor(ctx, ref)
    const presentationByPluginKey = await presentationByPluginKeyFor(deps)
    return withCapabilitySnapshot(resolver, context, snapshot => withBuiltinDpAvailability(buildDetail(snapshot, capabilityKey, presentationByPluginKey), options.builtinDpView ?? readBuiltinDpMcpSettingsView))
  })

  const listMcpTools = createMcpToolsLister({
    listForCapability: (context, capabilityKey, peek) =>
      deps.sessionManager.listMcpToolsForCapability?.(context, capabilityKey, peek)
        ?? Promise.resolve({ status: 'refused' as const, reason: 'error' as const }),
    epoch: () => deps.sessionManager.getMcpToolsListingEpoch?.(), // F1.851
    ...(options.mcpTools?.cache ? { cache: options.mcpTools.cache } : {}),
    ...(options.mcpTools?.now ? { now: options.mcpTools.now } : {}),
  })
  server.handle(
    RPC_CHANNELS.capabilities.LIST_MCP_TOOLS,
    async (ctx, ref: unknown, capabilityKey: string, peek?: unknown): Promise<SafeMcpToolsResult> => {
      // Scope-check the context exactly like the other capability reads, but
      // NEVER throw to the renderer: any refusal maps to a typed result.
      try {
        const context = await contextFor(ctx, ref)
        if (typeof capabilityKey !== 'string' || capabilityKey.length === 0) {
          return { status: 'refused', reason: 'error' }
        }
        // `peek` (detail-open auto-read): serve the browse pool WITHOUT
        // connecting — opening a source page is not connect-intent.
        return await listMcpTools(context, capabilityKey, peek === true)
      } catch {
        return { status: 'refused', reason: 'error' }
      }
    },
  )

  server.handle(
    RPC_CHANNELS.capabilities.PREVIEW,
    async (ctx, contextRef: unknown, resourceRef: PreviewableManagedResourceRef) => {
      const context = await contextFor(ctx, contextRef)
      assertResourceScope(resourceRef, context.workspaceId)
      if (!isPreviewableManagedResourceRef(resourceRef)) throw new CapabilityManagedRequestError()
      if (resourceRef.scope === 'skill' && resourceRef.tier === 'plugin') {
        return withCapabilitySnapshot(
          resolver,
          context,
          snapshot => previewPluginSkillResource(resolver, snapshot, resourceRef),
        )
      }
      if (resourceRef.scope === 'skill') {
        // Native skills (global/workspace/project) live in many roots (bundled,
        // ~/.claude/skills, the managed dir). Resolve the real file from the
        // snapshot binding instead of a single hard-coded root; fall back to the
        // canonical path when the skill is not in the current snapshot.
        return withCapabilitySnapshot(
          resolver,
          context,
          snapshot => previewNativeSkillResource(resolver, snapshot, resourceRef, managedDeps),
        )
      }
      return previewManagedResource(resourceRef, managedDeps)
    },
  )

  server.handle(
    RPC_CHANNELS.capabilities.SUMMARY,
    async (ctx, contextRef: unknown, resourceRef: ManagedResourceRef) => {
      const context = await contextFor(ctx, contextRef)
      assertResourceScope(resourceRef, context.workspaceId)
      return summarizeManagedResource(resourceRef, managedDeps)
    },
  )

  server.handle(
    RPC_CHANNELS.capabilities.SUBMIT_MANAGED_EDIT,
    async (ctx, request: ManagedResourceEditRequest) => {
      if (!isManagedResourceEditRequest(request)) throw new CapabilityManagedRequestError()
      const context = await contextFor(ctx, request.session)
      assertResourceScope(request.resource, context.workspaceId, request.session)
      const edit = resolveManagedEditContext(request.resource, request.contextKey, managedDeps)
      await untilTurnDispatched(onAck => deps.sessionManager.sendMessage(
        request.session.sessionId,
        `${request.instructions}\n\n${edit.agentGuidance}\n\nManaged resource: ${edit.filePath}. Context: ${edit.editContextKey}. ${edit.label}`,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        onAck,
        { workspaceId: context.workspaceId, callerClientId: ctx.clientId },
      ), { server, deps, clientId: ctx.clientId, sessionId: request.session.sessionId, workspaceId: context.workspaceId })
    },
  )

  server.handle(
    RPC_CHANNELS.capabilities.OPEN,
    async (ctx, contextRef: unknown, resourceRef: MutableManagedResourceRef) => {
      const context = await contextFor(ctx, contextRef)
      assertResourceScope(resourceRef, context.workspaceId)
      if (!isMutableManagedResourceRef(resourceRef)) throw new CapabilityManagedRequestError()
      const resolved = resolveManagedResource(resourceRef, managedDeps)
      await deps.platform.openPath?.(resolved.absolutePath)
    },
  )

  server.handle(
    RPC_CHANNELS.capabilities.REVEAL,
    async (ctx, contextRef: unknown, capabilityKey: string) => {
      const context = await contextFor(ctx, contextRef)
      const showItemInFolder = deps.platform.showItemInFolder
      if (!showItemInFolder) throw new CapabilityRevealError('capability-reveal-unavailable')
      return withCapabilitySnapshot(resolver, context, snapshot => {
        const entry = snapshot.entries.find(item => item.summary.key === capabilityKey)
        if (!entry) throw new CapabilityDetailError('capability-not-found')
        showItemInFolder(resolveCapabilityRevealPath(entry))
      })
    },
  )

  server.handle(RPC_CHANNELS.capabilities.LIST_TRUST_REVIEWS, async (ctx, contextRef: unknown): Promise<SafeTrustReviewsResult> => {
    const context = await contextFor(ctx, contextRef)
    return withCapabilitySnapshot(resolver, context, snapshot => ({
      // Every entry the resolver put behind the gate AND can mint a key for.
      // The two halves are one predicate on purpose: a review row the grant
      // endpoint would refuse is a control that cannot work, and a gated
      // capability with no row is a capability nothing can ever enable — P2.158
      // was the second of those.
      items: snapshot.entries
        .filter(entry => (
          entry.summary.trustState === 'review-required'
          && trustKeyMaterialFor(entry) !== undefined
        ))
        .map(toSafeTrustReviewItem),
    }))
  })

  server.handle(RPC_CHANNELS.capabilities.GRANT_TRUST, async (ctx, unsafeRequest: unknown): Promise<SafeTrustMutationResult> => {
    if (!isSafeGrantTrustRequest(unsafeRequest)) throw new CapabilityTrustRequestError()
    if (!trustStore) throw new CapabilityTrustRuntimeUnavailableError()
    return trustStore.runExclusive(async () => {
      const context = await contextFor(ctx, unsafeRequest.context)
      const trustKey = await withCapabilitySnapshot(
        resolver,
        context,
        snapshot => reconstructTrustKey(snapshot, unsafeRequest.capabilityKey),
      )
      trustStore.grant(trustKey)
      await afterPluginMutation(server, deps, {
        workspaceId: context.workspaceId,
        ...(context.projectKey ? { projectKey: context.projectKey } : {}),
      }, 'capability trust grant')
      return {
        ok: true,
        capabilityKey: unsafeRequest.capabilityKey,
      }
    })
  })

  server.handle(RPC_CHANNELS.capabilities.REVOKE_TRUST, async (ctx, unsafeRequest: unknown): Promise<SafeTrustMutationResult> => {
    if (!isSafeRevokeTrustRequest(unsafeRequest)) throw new CapabilityTrustRequestError()
    if (!trustStore) throw new CapabilityTrustRuntimeUnavailableError()
    return trustStore.runExclusive(async () => {
      const context = await contextFor(ctx, unsafeRequest.context)
      const trustKey = await withCapabilitySnapshot(
        resolver,
        context,
        snapshot => reconstructTrustKey(snapshot, unsafeRequest.capabilityKey),
      )
      trustStore.revoke(trustKey)
      // Revoking trust removes availability: fail closed against an active
      // leased snapshot (revoke-active-snapshot), not merely a background refresh.
      await afterPluginMutation(server, deps, {
        workspaceId: context.workspaceId,
        ...(context.projectKey ? { projectKey: context.projectKey } : {}),
      }, 'capability trust revoke', 'remove')
      return { ok: true, capabilityKey: unsafeRequest.capabilityKey }
    })
  })

  // Read-only project-contribution detection (pre-trust consent + post-trust
  // re-inspect). Resolves the project root from the safe context ref server-side
  // and returns a bounded, path-free report. Fail-soft: any refusal (invalid ref,
  // workspace mismatch, no project, unreadable root) maps to an empty report so
  // the caller renders exactly as before detection existed. Detection does NOT
  // gate on trust — showing contributions is what informs the trust decision.
  server.handle(
    RPC_CHANNELS.capabilities.DETECT_PROJECT_CONTRIBUTIONS,
    async (ctx, ref: unknown, options?: unknown): Promise<ProjectContributionReport> => {
      try {
        const context = await contextFor(ctx, ref)
        if (!context.projectRoot) return { items: [] }
        const report = detectProjectContributions(context.projectRoot)
        // F1.1133 — the chat the trust gate asks for, when it names one. The safe ref keeps a session and a
        // handle mutually exclusive, so the gate's handle ref could not say which runtime the chat runs, and
        // Pi's language servers were named for a Claude or codex chat too, where trust starts none of them.
        // Read from the live session server-side, as `contextFor` reads a session ref's provider; a chat this
        // process does not know, or no chat (the dialog, the sources panel), keeps the F1.809 answer.
        const runtimeSessionId = runtimeSessionIdOf(options)
        const runtime = runtimeSessionId ? deps.sessionManager.getSessionProvider?.(runtimeSessionId, context.workspaceId) : undefined
        if (runtime !== undefined && runtime !== 'pi') return report
        // F1.809 — on Pi, trust also starts the enabled plugin language servers
        // (`piLanguageServerContribution`'s block). Read from the same view the
        // session path iterates; a failed read keeps the file report as it was.
        const lspServers = await withCapabilitySnapshot(
          resolver,
          context,
          snapshot => toAgentRuntime(snapshot).lspServers ?? [],
        ).catch(() => [])
        const languageServers = piLanguageServerContribution(lspServers)
        return languageServers ? { items: [...report.items, languageServers] } : report
      } catch {
        return { items: [] }
      }
    },
  )
}

// ---------------------------------------------------------------------------
// U3 — MCP tools listing (lazy, session-scoped bounded-TTL cache, fail-soft)
// ---------------------------------------------------------------------------

/** Default cache lifetime: repeat opens within this window skip the pool read. */
const MCP_TOOLS_CACHE_TTL_MS = 5 * 60 * 1000

/**
 * Hard cap on cached tool-list entries. TTL alone never EVICTS — an entry only
 * stops being RETURNED once expired, but its memory lingers until overwritten,
 * so a workspace with many MCP sources (or churning capability keys) would grow
 * the Map unbounded over a long session. `set` bounds the map by insertion
 * order: re-setting a key refreshes its recency, and once over the cap it drops
 * the oldest entries first. An expired oldest entry is worthless to keep, so
 * insertion-order eviction (no clock needed inside the cache) is sufficient and
 * keeps the interface clock-free. (U3 review finding 3.)
 */
const MCP_TOOLS_CACHE_MAX_ENTRIES = 256

interface McpToolsCacheEntry {
  expiresAt: number
  result: SafeMcpToolsResult
  /** The lister's `epoch()` when the entry was stored (F1.851); absent = no epoch source. */
  epoch?: number
}

/** Session-scoped bounded-TTL cache for the MCP tools list (injectable in tests). */
export interface McpToolsCache {
  get(key: string): McpToolsCacheEntry | undefined
  set(key: string, entry: McpToolsCacheEntry): void
}

export function createMcpToolsCache(maxEntries: number = MCP_TOOLS_CACHE_MAX_ENTRIES): McpToolsCache {
  const map = new Map<string, McpToolsCacheEntry>()
  return {
    get: key => map.get(key),
    set: (key, entry) => {
      // Re-setting an existing key must refresh its recency, so delete first.
      map.delete(key)
      map.set(key, entry)
      // Evict oldest by insertion order until within bound.
      while (map.size > maxEntries) {
        const oldest = map.keys().next().value
        if (oldest === undefined) break
        map.delete(oldest)
      }
    },
  }
}

function mcpToolsCacheKey(context: SafeCapabilityContextRef, capabilityKey: string): string {
  const sessionId = 'sessionId' in context ? context.sessionId : ''
  return `${context.workspaceId}\u0000${sessionId}\u0000${capabilityKey}`
}

/**
 * Build the fail-soft MCP-tools lister used by the RPC handler. A successful
 * (`status: 'ok'`) result is cached under the composite session/capability key
 * for a bounded TTL so a repeat open within the window returns the cached tools
 * WITHOUT touching the pool again. Refusals are NOT cached — a source that just
 * connected (or was re-enabled) must be reflected on the next open. Any thrown
 * error from the accessor maps to a typed `error` refusal (never rethrown).
 *
 * F1.851 — and a cached `ok` is served only while `epoch()` still reads what it
 * read when the entry was stored. The TTL alone let a server the user had just
 * switched OFF keep answering with its tools for up to five minutes (measured on
 * RC `69a6d33da`: a disabled built-in `dpGitlab` still listed its tools while a
 * never-enabled `dpJira` answered `refused / disabled`), because the accessor —
 * which refuses a disabled source before any pool read — was never asked. The
 * production epoch is `SessionManager.getMcpToolsListingEpoch`, which moves on
 * every MCP inventory change the manager hears: the built-in dp switch, the
 * capability invalidation bus, and a source file change on disk. Any move
 * expires every cached list, which only costs a re-read; a caller with no epoch
 * source (`epoch` absent, or answering `undefined`) keeps the TTL-only cache.
 */
export function createMcpToolsLister(deps: {
  listForCapability: (
    context: SafeCapabilityContextRef,
    capabilityKey: string,
    peek?: boolean,
  ) => Promise<SafeMcpToolsResult>
  cache?: McpToolsCache
  ttlMs?: number
  now?: () => number
  epoch?: () => number | undefined
}): (context: SafeCapabilityContextRef, capabilityKey: string, peek?: boolean) => Promise<SafeMcpToolsResult> {
  const cache = deps.cache ?? createMcpToolsCache()
  const ttlMs = deps.ttlMs ?? MCP_TOOLS_CACHE_TTL_MS
  const now = deps.now ?? Date.now
  return async (context, capabilityKey, peek) => {
    // The cache key is peek-independent: a successful list is the same tools
    // whether they were peeked (warm) or connected. A peek 'ok' warms the
    // cache so the later full open short-circuits; refusals are never cached.
    const key = mcpToolsCacheKey(context, capabilityKey)
    const epoch = deps.epoch?.()
    const cached = cache.get(key)
    if (cached && cached.expiresAt > now() && cached.epoch === epoch) return cached.result
    let result: SafeMcpToolsResult
    try {
      result = await deps.listForCapability(context, capabilityKey, peek)
    } catch {
      result = { status: 'refused', reason: 'error' }
    }
    if (result.status === 'ok') {
      // The epoch read BEFORE the accessor ran: an inventory change that lands
      // while it runs leaves this entry already stale rather than fresh.
      cache.set(key, { result, expiresAt: now() + ttlMs, ...(epoch === undefined ? {} : { epoch }) })
    }
    return result
  }
}

export class CapabilityContextScopeError extends Error {
  override readonly name = 'CapabilityContextScopeError'
  constructor() { super('capability-context-workspace-mismatch') }
}

export class CapabilityManagedRequestError extends Error {
  override readonly name = 'CapabilityManagedRequestError'
  constructor() { super('invalid-managed-resource-request') }
}

export class CapabilityTrustRequestError extends Error {
  override readonly name = 'CapabilityTrustRequestError'
  constructor() { super('invalid-trust-request') }
}

export class CapabilityTrustRuntimeUnavailableError extends Error {
  override readonly name = 'CapabilityTrustRuntimeUnavailableError'
  constructor() { super('capability-trust-runtime-unavailable') }
}

export type CapabilityTrustNotFoundReason = 'capability-not-found' | 'capability-trust-not-required'
export class CapabilityTrustNotFoundError extends Error {
  override readonly name = 'CapabilityTrustNotFoundError'
  constructor(readonly code: CapabilityTrustNotFoundReason) { super(code) }
}

export type CapabilityRevealErrorCode = 'capability-not-revealable' | 'capability-reveal-unavailable'
export class CapabilityRevealError extends Error {
  override readonly name = 'CapabilityRevealError'
  constructor(readonly code: CapabilityRevealErrorCode, message?: string) {
    super(message ?? code)
  }
}

function resolveCapabilityRevealPath(entry: ResolvedCapabilityEntry): string {
  const binding = entry.runtimeBinding
  if (binding.kind === 'source' || binding.kind === 'skill') {
    if ('absolutePath' in binding.resource) return binding.resource.absolutePath
    if (binding.pluginRuntime) {
      return resolveContainedPath(binding.pluginRuntime.rootPath, binding.resource.relativePath)
    }
  }
  if (binding.kind === 'mcp') {
    if (binding.server.resource) return binding.server.resource.absolutePath
    if (binding.server.pluginRuntime) return binding.server.pluginRuntime.rootPath
  }
  throw new CapabilityRevealError('capability-not-revealable')
}

async function previewPluginSkillResource(
  resolver: CapabilityResolver,
  snapshot: EffectiveCapabilitySnapshot,
  ref: Extract<PreviewableManagedResourceRef, { scope: 'skill'; tier: 'plugin' }>,
) {
  if (ref.file !== 'instructions') throw new ManagedResourceError('unsupported-ref')
  const entry = snapshot.entries.find(item => (
    item.summary.kind === 'skill'
    && item.summary.origin === 'plugin'
    && item.summary.pluginInstanceId === ref.pluginInstanceId
    && item.summary.capabilityId === ref.capabilityId
  ))
  if (
    !entry
    || entry.runtimeBinding.kind !== 'skill'
    || 'absolutePath' in entry.runtimeBinding.resource
    || entry.runtimeBinding.resource.pluginInstanceId !== ref.pluginInstanceId
  ) {
    throw new ManagedResourceError('unsupported-ref')
  }
  const content = await createCapabilitySnapshotMaterializer(resolver, snapshot).readText(
    entry.runtimeBinding.resource,
  )
  return {
    title: ref.capabilityId,
    content,
    contentType: 'markdown' as const,
    provenance: 'Installed plugin',
  }
}

type NativeSkillPreviewRef = Exclude<
  Extract<PreviewableManagedResourceRef, { scope: 'skill' }>,
  { tier: 'plugin' }
>

function skillScopeMatchesTier(scope: ResolvedCapability['scope'], ref: NativeSkillPreviewRef): boolean {
  if (ref.tier === 'global') return scope.kind === 'global'
  if (ref.tier === 'workspace') return scope.kind === 'workspace' && scope.workspaceId === ref.workspaceId
  return scope.kind === 'project'
}

/**
 * Preview a NATIVE skill's instructions from the capability snapshot's own
 * runtime binding, so a skill previews from wherever it actually lives — bundled
 * skills, the user's `~/.claude/skills`, or the managed global/workspace/project
 * dir — instead of a single hard-coded root (the old `previewManagedResource`
 * assumed only the managed dir, so bundled/home skills returned `not-found`).
 * Mirrors the plugin-skill path (materializer read of the pinned resource), which
 * also brings the same revision/lease integrity checks. Falls back to the
 * canonical managed-path read when the skill is absent from the current snapshot,
 * preserving prior behavior.
 */
async function previewNativeSkillResource(
  resolver: CapabilityResolver,
  snapshot: EffectiveCapabilitySnapshot,
  ref: NativeSkillPreviewRef,
  managedDeps: ManagedResourceDeps,
) {
  if (ref.file === 'instructions') {
    const entry = snapshot.entries.find(item => (
      item.summary.kind === 'skill'
      && item.summary.origin !== 'plugin'
      && item.summary.logicalName === ref.skillId
      && skillScopeMatchesTier(item.summary.scope, ref)
    ))
    if (
      entry
      && entry.runtimeBinding.kind === 'skill'
      && !('pluginInstanceId' in entry.runtimeBinding.resource)
    ) {
      const content = await createCapabilitySnapshotMaterializer(resolver, snapshot).readText(
        entry.runtimeBinding.resource,
      )
      return { title: ref.skillId, content, contentType: 'markdown' as const }
    }
  }
  // Not resolvable from the snapshot (or a manifest ref): canonical-path read.
  return previewManagedResource(ref, managedDeps)
}

function assertResourceScope(
  ref: unknown,
  workspaceId: string,
  editSession?: SafeSessionRef,
): asserts ref is ManagedResourceRef {
  if (!isManagedResourceRef(ref)) throw new CapabilityManagedRequestError()
  if (ref.scope === 'workspace' && ref.workspaceId !== workspaceId) throw new CapabilityContextScopeError()
  if (ref.scope === 'source' && ref.workspaceId !== workspaceId) throw new CapabilityContextScopeError()
  if (ref.scope === 'skill') {
    if (ref.tier === 'workspace' && ref.workspaceId !== workspaceId) throw new CapabilityContextScopeError()
    if (ref.tier === 'project' && ref.session.workspaceId !== workspaceId) throw new CapabilityContextScopeError()
    if (ref.tier === 'project' && editSession
      && (ref.session.workspaceId !== editSession.workspaceId || ref.session.sessionId !== editSession.sessionId)) {
      throw new CapabilityContextScopeError()
    }
  }
}

/**
 * Project one review-required resolved capability into safe review metadata:
 * capability key/name, executable kind, scope and review reason. Never a
 * path, environment value or credential.
 */
function toSafeTrustReviewItem(entry: ResolvedCapabilityEntry): SafeTrustReviewItem {
  const cap = entry.summary
  return {
    capabilityKey: cap.key,
    capabilityName: cap.displayName ?? cap.logicalName,
    // `SafeTrustExecutableKind` has carried `'plugin'` since the channel was
    // typed and nothing ever emitted it, because nothing plugin-shaped could
    // reach a review row. A trust-gated plugin capability now does, and it must
    // not be labelled as a project hook: the two are consented to on completely
    // different grounds (a repository-resident file the user is being asked to
    // vouch for, versus one immutable capability of a bundle already installed).
    executableKind: cap.origin === 'plugin' ? 'plugin' : 'native-project',
    scope: cap.scope,
    reasonCode: cap.unavailableReason ?? 'review-required',
  }
}

function isNativeProjectTrustEntry(entry: ResolvedCapabilityEntry): boolean {
  return entry.summary.origin === 'native'
    && entry.summary.kind === 'hook'
    && entry.summary.scope.kind === 'project'
    && entry.runtimeBinding.kind === 'hook'
}

/**
 * Whether this entry has a mintable trust key at all — a native project hook, or
 * a trust-gated plugin capability (P2.158).
 *
 * The plugin half exists because the resolver already refuses to run such a
 * capability until a grant matches, and until now the ONLY grant call site in
 * the tree required `origin === 'native' && kind === 'hook' && scope ===
 * 'project'`, which a plugin workflow fails on all three. So the resolver
 * demanded a grant that the one grant endpoint would not mint, in the UI and
 * over raw RPC alike, and a plugin's central pipeline installed permanently
 * inert with `listTrustReviews` measuring `items: []`.
 *
 * THE SEMANTICS BEING CHOSEN, stated because this predicate is the thing
 * standing between a downloaded bundle and executing its JavaScript:
 *
 * - The grant is for one (plugin instance, capability, exact host-derived hash,
 *   scope) tuple, never for "the plugin" and never for a kind. The hash is
 *   `sha256(bundleHash || definition)` (`projection-candidates.ts`), so ANY
 *   change to the bundle or to the capability's declaration mints a different
 *   key and the capability returns to `review-required`. A grant therefore
 *   cannot survive an update — which is the property that makes widening this
 *   gate safe rather than a blanket "plugins are trusted".
 * - Scope is the resolver's SELECTED scope, carried through unchanged, so a
 *   grant made for one workspace/project cannot be replayed at another.
 * - The client still supplies only a `capabilityKey`; the hash and instance id
 *   are read from a FRESH snapshot, so a caller cannot smuggle a hash it wants
 *   trusted.
 * - Uninstalling purges the record (`purgePluginInstances`), so a re-install of
 *   the same bytes starts un-granted.
 *
 * What is deliberately NOT widened: plugin agents, executable skills and MCP
 * servers stay `not-required` and their grant attempts stay refused, because the
 * resolver never gates them — install IS their authorization boundary. The
 * gated set is the single list {@link TRUST_GATED_PLUGIN_CAPABILITY_KINDS}, which
 * the resolver's own gate reads, so the two can no longer disagree.
 */
function trustKeyMaterialFor(entry: ResolvedCapabilityEntry): CapabilityTrustKey | undefined {
  if (isNativeProjectTrustEntry(entry) && entry.runtimeBinding.kind === 'hook') {
    return {
      capabilityId: entry.summary.key,
      executableHash: entry.runtimeBinding.hook.executableHash,
      scope: entry.summary.scope,
    }
  }
  const plugin = pluginCapabilityTrustKeyMaterial(entry)
  if (!plugin) return undefined
  return {
    pluginInstanceId: plugin.pluginInstanceId,
    capabilityId: plugin.capabilityId,
    executableHash: plugin.executableHash,
    scope: entry.summary.scope,
  }
}

/**
 * Reconstruct the exact `CapabilityTrustKey` the resolver used for this
 * capability from a FRESH snapshot — never from client-supplied fields.
 */
function reconstructTrustKey(snapshot: EffectiveCapabilitySnapshot, capabilityKey: string): CapabilityTrustKey {
  const entry = snapshot.entries.find(item => item.summary.key === capabilityKey)
  if (!entry) throw new CapabilityTrustNotFoundError('capability-not-found')
  const key = trustKeyMaterialFor(entry)
  if (!key) throw new CapabilityTrustNotFoundError('capability-trust-not-required')
  return key
}

/**
 * Build the display-only presentation-by-pluginKey join map (A9) from the
 * installed-plugin management API's own persisted-origin projection. This is
 * deliberately independent of the capability resolver/snapshot: presentation
 * must never enter resolver generation, so it is computed from a *separate*
 * read and joined into the safe view by `pluginKey` only. Returns `undefined`
 * when no plugin management runtime is wired (e.g. some test harnesses), OR
 * when the read itself fails (e.g. a transiently unreadable registry) — a
 * cosmetic join must never break GET_CATALOG/GET_DETAIL, so any error here
 * degrades to "no presentation" rather than propagating.
 */
async function presentationByPluginKeyFor(
  deps: HandlerDeps,
): Promise<ReadonlyMap<string, SafePluginPresentationOrigin> | undefined> {
  if (!deps.pluginManagement) return undefined
  try {
    const status = await deps.pluginManagement.status()
    const map = new Map<string, SafePluginPresentationOrigin>()
    for (const installed of status.installed) {
      if (installed.presentation) map.set(installed.pluginKey, installed.presentation)
    }
    return map
  } catch (error) {
    deps.platform.logger?.warn(
      `CAPABILITY_PRESENTATION: failed to read installed-plugin presentation, degrading to none: ${error instanceof Error ? error.message : String(error)}`,
    )
    return undefined
  }
}

/**
 * Project one resolved capability (by key) into a `SafeCapabilityDetail` with
 * allowlisted display fields and the managed-resource refs the renderer may
 * preview/edit/open. Never exposes a path, config, secret ref or hash.
 */
function buildDetail(
  snapshot: EffectiveCapabilitySnapshot,
  capabilityKey: string,
  presentationByPluginKey?: ReadonlyMap<string, SafePluginPresentationOrigin>,
): SafeCapabilityDetail {
  const entry = snapshot.entries.find(e => e.summary.key === capabilityKey)
  if (!entry) throw new CapabilityDetailError('capability-not-found')
  const cap = entry.summary
  const diagnostics = snapshot.diagnostics
    .filter(diagnostic => diagnostic.capabilityKey === capabilityKey)
    .map(toSafeDiagnostic)
  const permissionModes = buildPermissionModes(cap)
  const permissions = buildSourcePermissions(cap)
  return {
    summary: toSafeSummary(cap, presentationByPluginKey),
    safeFields: buildSafeFields(entry),
    resources: buildResourceRefs(cap),
    ...(permissionModes ? { permissionModes } : {}),
    ...(permissions ? { permissions } : {}),
    ...(diagnostics.length > 0 ? { diagnostics } : {}),
  }
}

/**
 * Skill permission-mode projection (U2). A skill that pins `alwaysAllow` tools
 * gets one row per picker mode saying how the always-allowed set behaves there.
 * The behavior is a fixed consequence of the mode semantics, not per-tool, so the
 * rows are constant once `alwaysAllow` is non-empty. No `alwaysAllow` →
 * `undefined` (the renderer shows an in-section placeholder). Trust-gated exactly
 * as the pinned inventory metadata already is — this reads only the snapshot, no
 * new file access.
 *
 * F1.1052 — the ids are the real `PermissionMode` values, in the picker's order
 * (Claude Desktop's: Auto, Manual, Accept edits, Plan, Bypass permissions). They
 * were craft's vocabulary (`explore` / `askToEdit` / `auto`, where `auto` meant
 * allow-all), which no longer named a mode a user can pick. What each row says is
 * `core/pre-tool-use.ts`'s: the grant takes effect only at the seam where a call
 * in a prompting mode would become an approval request (`skillGrantAllows`), so
 * the three prompting modes pre-approve the listed tools, Plan still blocks a
 * write before that seam, and Bypass permissions asks about nothing to begin
 * with. The hidden `dontAsk` gets no row, as it gets no picker entry.
 */
function buildPermissionModes(cap: ResolvedCapability): SafeCapabilityDetail['permissionModes'] {
  if (cap.kind !== 'skill') return undefined
  if (!cap.skillAlwaysAllow || cap.skillAlwaysAllow.length === 0) return undefined
  return [
    { mode: 'auto', behavior: 'allowed' },
    { mode: 'default', behavior: 'allowed' },
    { mode: 'acceptEdits', behavior: 'allowed' },
    { mode: 'plan', behavior: 'blocked' },
    { mode: 'bypassPermissions', behavior: 'neutral' },
  ]
}

/**
 * Source permission projection (U2). Passes the inventory-pinned, path-free
 * pattern/access rows straight through. The pinning step already excluded
 * path-based rules, so nothing here can carry an absolute path.
 */
function buildSourcePermissions(cap: ResolvedCapability): SafeCapabilityDetail['permissions'] {
  if (cap.kind !== 'source') return undefined
  if (!cap.sourcePermissions || cap.sourcePermissions.length === 0) return undefined
  return cap.sourcePermissions.map(rule => ({ pattern: rule.pattern, access: rule.access }))
}

export type CapabilityDetailErrorCode = 'capability-not-found'
export class CapabilityDetailError extends Error {
  override readonly name = 'CapabilityDetailError'
  constructor(readonly code: CapabilityDetailErrorCode, message?: string) {
    super(message ?? code)
  }
}

function buildSafeFields(entry: EffectiveCapabilitySnapshot['entries'][number]): Array<{ label: string; value: string }> {
  const cap = entry.summary
  const fields: Array<{ label: string; value: string }> = [{ label: 'origin', value: cap.origin }]
  if (entry.runtimeBinding.kind === 'mcp') {
    fields.push({ label: 'transport', value: entry.runtimeBinding.server.definition.type })
  }
  if (cap.pluginKey) fields.push({ label: 'plugin', value: cap.pluginKey })
  if (cap.capabilityId) fields.push({ label: 'capability', value: cap.capabilityId })
  if (cap.trustState !== 'not-required') fields.push({ label: 'trust', value: cap.trustState })
  if (cap.credentialState !== 'not-required') fields.push({ label: 'credential', value: cap.credentialState })
  return fields
}

function buildResourceRefs(cap: ResolvedCapability): SafeCapabilityDetail['resources'] {
  if (cap.kind === 'source' && cap.scope.workspaceId) {
    const workspaceId = cap.scope.workspaceId
    return [
      { ref: { scope: 'source', workspaceId, sourceId: cap.logicalName, file: 'config' }, canPreview: false, canEdit: true, canOpen: true },
      { ref: { scope: 'source', workspaceId, sourceId: cap.logicalName, file: 'guide' }, canPreview: true, canEdit: true, canOpen: true },
    ]
  }
  if (cap.kind === 'skill') {
    if (cap.origin === 'plugin' && cap.pluginInstanceId && cap.capabilityId) {
      return [{
        ref: { scope: 'skill', tier: 'plugin', pluginInstanceId: cap.pluginInstanceId, capabilityId: cap.capabilityId, file: 'instructions' },
        canPreview: true,
        canEdit: false,
        canOpen: false,
      }]
    }
    if (cap.scope.kind === 'global') {
      return [{
        ref: { scope: 'skill', tier: 'global', skillId: cap.logicalName, file: 'instructions' },
        canPreview: true,
        canEdit: true,
        canOpen: true,
      }]
    }
    if (cap.scope.kind === 'workspace' && cap.scope.workspaceId) {
      return [{
        ref: { scope: 'skill', tier: 'workspace', workspaceId: cap.scope.workspaceId, skillId: cap.logicalName, file: 'instructions' },
        canPreview: true,
        canEdit: true,
        canOpen: true,
      }]
    }
  }
  return []
}

/**
 * F1.461 — a user WITHOUT dp is told, on the detail page a built-in dp MCP row
 * opens, why that server cannot start.
 *
 * The sentence (`builtin_dp_mcp.dp_not_found`) used to reach only the MCP LIST
 * row (`buildBuiltinDpMcpRows` in the renderer's `capability-catalog.ts`), and
 * nothing renders it there since badge parity removed the `Needs dp` badge. The
 * detail page reads THIS route, and a built-in's summary comes from
 * `builtinDpMcpCapabilityRecords` (`bootstrap/storage-runtime.ts`), which never
 * resolves dp — deliberately, because every turn resolves and a PATH scan per
 * resolve is the cost it refuses. A detail open is one user action, so the one
 * filesystem lookup is made here, and only for a built-in dp row: every other
 * detail returns untouched without reading anything.
 *
 * The reader is the SAME one the MCP list's `builtinDpMcp:list` RPC answers
 * with (`readBuiltinDpMcpSettingsView`, which never executes dp), and the join
 * is the list row's own (`messages.join(' ')`), so the product says one sentence
 * in both places. When dp is missing the sentence REPLACES the resolver's
 * reason (`source-disabled` for a server the user left off): nothing in the set
 * can start until dp is there, which is the more useful statement, and the
 * switch beside the row already says on/off. A failed lookup degrades to the
 * detail as resolved — a cosmetic join never breaks GET_DETAIL, the same rule
 * `presentationByPluginKeyFor` follows. `CapabilityDetailTemplate` renders the
 * free string as it is (its "falls back to the raw string" arm).
 */
export function withBuiltinDpAvailability(
  detail: SafeCapabilityDetail,
  readView: () => BuiltinDpMcpSettingsViewV1,
): SafeCapabilityDetail {
  const summary = detail.summary
  if (summary.origin !== 'builtin' || summary.kind !== 'mcp' || !isKnownBuiltinDpMcpServer(summary.logicalName)) {
    return detail
  }
  let view: BuiltinDpMcpSettingsViewV1
  try {
    view = readView()
  } catch {
    return detail
  }
  if (view.available) return detail
  const reason = view.diagnostics.map(diagnostic => diagnostic.message).join(' ')
  return reason ? { ...detail, summary: { ...summary, unavailableReason: reason } } : detail
}

/**
 * F1.754 — `capabilities:submitManagedEdit` answers when its turn is DISPATCHED,
 * not when the turn ends.
 *
 * `SessionManager.sendMessage` settles when the agent turn finishes, and an
 * add-source or add-skill turn routinely outlives the renderer's 30 s request
 * budget (and this server's own 60 s handler budget, `transport/server.ts`
 * symbol `DEFAULT_HANDLER_TIMEOUT_MS`), so awaiting it reported a live turn as a
 * failed request. The answer point is not a new one: it is the `onAck` that
 * `sessions:sendMessage` already answers at, fired once the user message is on
 * disk.
 *
 * The 2026-07-23 contract this narrows ("completes only when `sendMessage`
 * completes and propagates failures") keeps its purpose: a failure BEFORE the
 * dispatch (no such session, a refused start) still rejects the request, and
 * nothing else is sent for it. A send that settles without acking answers too,
 * as it always did — unlike `sessions:sendMessage` there is no message id to
 * hand back.
 *
 * F1.994 — a failure AFTER the dispatch belongs to the turn, and the caller has
 * already been answered, so it cannot be a rejection. It is logged, and the
 * caller's turn is ended on its event stream through
 * {@link reportPostPersistTurnFailure}, the same arm `sessions:sendMessage`
 * uses (flush, then `error` + `complete` to the calling client). Logging alone
 * left the inline Add Source / Add Skill popover spinning: nothing told its
 * hidden session the turn was over.
 */
function untilTurnDispatched(
  send: (onAck: () => void) => Promise<void>,
  turn: { server: RpcServer; deps: HandlerDeps; clientId: string; sessionId: string; workspaceId: string },
): Promise<void> {
  const { server, deps, ...target } = turn
  const logger: HandlerDeps['platform']['logger'] | undefined = deps.platform.logger
  return new Promise<void>((resolve, reject) => {
    let answered = false
    const answer = () => {
      if (answered) return
      answered = true
      resolve()
    }
    send(answer).then(answer, (error: unknown) => {
      if (!answered) {
        answered = true
        reject(error)
        return
      }
      logger?.error(
        `CAPABILITY_MANAGED_EDIT: the dispatched turn failed: ${error instanceof Error ? error.message : String(error)}`,
      )
      reportPostPersistTurnFailure(server, deps.sessionManager, logger, target, error).catch((reportError: unknown) => {
        logger?.warn('CAPABILITY_MANAGED_EDIT: ending the failed turn on the caller\'s event stream failed:', reportError)
      })
    })
  })
}

/** F1.1133 — the optional `{ runtimeSessionId }` the trust gate passes beside its handle ref; anything else is ignored. */
function runtimeSessionIdOf(options: unknown): string | undefined {
  if (!options || typeof options !== 'object' || Array.isArray(options)) return undefined
  const value = (options as { runtimeSessionId?: unknown }).runtimeSessionId
  return typeof value === 'string' && value.length > 0 ? value : undefined
}
