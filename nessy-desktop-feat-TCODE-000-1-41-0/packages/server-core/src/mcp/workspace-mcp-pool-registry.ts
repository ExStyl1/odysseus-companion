/**
 * WorkspaceMcpPoolRegistry (U3b)
 *
 * A workspace-level (browse) MCP client pool so the Sources tab can list an
 * MCP source's tools WITHOUT a live chat session. It reuses the EXISTING
 * `McpClientPool` class UNCHANGED — there is NO second pool/client class — and
 * derives its desired server set from a NON-session capability resolve through
 * the SAME `materializeRuntimePoolServers` authority the per-session agent uses,
 * so ALL upstream gating (enable/disable, trust, local-MCP toggle, credentials)
 * is inherited, never re-implemented and never bypassed.
 *
 * Lifecycle policy (recorded in the plan): lazy-connect on first NEED +
 * keep-alive. NEVER eager at app start — a fresh registry holds no pools and
 * starts no subprocesses/outbound connections until something ASKS. What
 * counts as a need grew by owner decision (plugin-install plan § 0b-4, T10):
 * a browse read always was one, and a SESSION START now is one too —
 * `SessionManager.maybeConnectSourcesAtSessionStart` calls `ensureSynced`
 * when `sources.connectOnStartup` resolves true (the Claude-parity default;
 * the managed `connectSourcesOnStartup: false` restores intent-only, under
 * which session start never reaches this registry). A subsequent
 * config/credential change RESYNCS the already-warm pool (debounced) but
 * never eagerly warms a cold one.
 *
 * Lease-shaped surface: `lease(key)` returns a handle over the pool. Today the
 * only client is browse and leases are not refcounted; the surface is shaped so
 * the deferred 1.10.0 shared-pool plan can add refcounted session borrowing
 * without changing callers. `release()` is a no-op placeholder for that future.
 *
 * Keying: workspace-only for the browse context. A project handle is only
 * threaded when a TRUSTED project is bound; project-scope MCP without a trusted
 * project context is honestly unavailable (invariant g) rather than hidden.
 */

import {
  McpClientPool,
  materializeRuntimePoolServers,
  type MaterializedRuntimePoolServers,
  type PluginMcpProcessAuthority,
  type RuntimeExternalAuthRequirement,
} from '@nessy-agent/shared/mcp'
import { toAgentRuntime } from '@nessy-agent/shared/capabilities/views'
import { getBuiltinDpMcpServerPreferences } from '@nessy-agent/shared/config/storage'
import {
  CapabilityMaterializationError,
  createCapabilitySnapshotMaterializer,
} from '@nessy-agent/shared/capabilities/materializer'
import type {
  CapabilityContext,
  CapabilityResolver,
} from '@nessy-agent/shared/capabilities/resolver'
import type { RuntimeCredentialBinding, ResolvedRuntimeCredential } from '@nessy-agent/shared/credentials'
import { getConfiguredAdditionalDirectories } from '@nessy-agent/shared/agent'
import type { CapabilityTurnRuntime, PluginNodeRuntimeBinding } from '@nessy-agent/shared/agent/backend'
import type { ProcessSupervisorPort } from '@nessy-agent/shared/agent/pi-harness/process-supervisor-port'
import type { DpSessionBroker, DpSessionState } from '@nessy-agent/shared/auth/dp'
import { createToolDescriptorStore } from '@nessy-agent/shared/mcp'
import { CONFIG_DIR } from '@nessy-agent/shared/workspaces'
import { createHash } from 'node:crypto'
import { join } from 'node:path'

/** Identity of a browse pool: one per (workspace [, trusted project]). */
export interface WorkspacePoolKey {
  workspaceId: string
  /** Present only when a trusted project handle scopes the resolve. */
  projectKey?: string
}

/** The workspace/project context a browse resolve should run against. */
export interface WorkspacePoolResolveContext {
  workspaceId: string
  /** Canonical trusted project root; omit for a pure workspace-scope resolve. */
  projectRoot?: string
  projectKey?: string
  projectTrustState?: CapabilityContext['projectTrustState']
  projectTrustRevision?: string
}

export interface WorkspaceMcpPoolRegistryDeps {
  resolver: CapabilityResolver
  resolveCredential: (binding: RuntimeCredentialBinding) => ResolvedRuntimeCredential
  /** Resolve a workspace's root path (for the pool's local-MCP gating). */
  resolveWorkspaceRootPath: (workspaceId: string) => string | undefined
  pluginNodeRuntime?: PluginNodeRuntimeBinding
  /** Value-only DP status authority. The registry never starts interactive login. */
  dpSessionBroker: Pick<DpSessionBroker, 'probe' | 'subscribe'>
  processSupervisor?: ProcessSupervisorPort
  /** Structured debug sink (defaults to no-op). */
  debug?: (message: string) => void
  /**
   * P3.246: called when a pool's connection verdicts moved — a source that now
   * needs signing in, one that recovered, one whose transport died.
   *
   * The registry is where the DELIVERY half of that notification has to be
   * wired, because it owns the pools and it is the layer that knows which
   * workspace one belongs to. Without it the pool's own notification would have
   * no subscriber and the session-start pending-auth notice would still be the
   * only reader — computed once, never told again.
   */
  onConnectionVerdictChanged?: (workspaceId: string) => void
  /** Injectable pool factory (tests supply a fake). Defaults to McpClientPool. */
  createPool?: (options: {
    workspaceRootPath?: string
    debug?: (msg: string) => void
    pluginProcessAuthority?: PluginMcpProcessAuthority
    rootsProvider?: () => readonly string[] | Promise<readonly string[]>
  }) => McpClientPool
  /** Debounce window for resyncs (ms). Coalesces watcher + reload storms. */
  resyncDebounceMs?: number
}

/** A lease over a workspace browse pool. */
export interface WorkspacePoolLease {
  key: WorkspacePoolKey
  pool: McpClientPool
  /** Stable routing identity for this exact browse/session view. */
  leaserId: string
  /**
   * Ensure the pool's desired server set is materialized + connected for the
   * given resolve context, connecting lazily on first need. Idempotent while
   * warm; a config/credential change flips the pool dirty so the next call
   * resyncs. Fail-soft: returns even if some servers fail to connect.
   */
  ensureSynced: (context: WorkspacePoolResolveContext) => Promise<void>
  /** Materialize an exact pinned turn through the registry's DP probe authority. */
  materializeRuntime: (runtime: CapabilityTurnRuntime) => Promise<MaterializedRuntimePoolServers>
  /**
   * Release this lease. For a SESSION lease (created with a `leaserId`) this
   * drops the leaser's desired set and reconciles the shared pool — servers no
   * other leaser (session or browse) still wants are disconnected; the pool
   * itself is NEVER torn down here (browse keep-alive; teardown stays in
   * {@link WorkspaceMcpPoolRegistry.dispose}). For a browse lease (no leaserId)
   * this resolves without dropping anything.
   */
  release: () => Promise<void>
}

interface PoolEntry {
  pool: McpClientPool
  browseLeaserId: string
  workspaceId: string
  /** Resolved at creation for the local-MCP gate + LoadedSource records. */
  workspaceRootPath: string | undefined
  /**
   * Number of live SESSION leases (leaserId-bearing) on this entry.
   * Observability only — teardown is driven by the pool's per-leaser union, not
   * this count. Incremented on session lease, decremented on its release.
   */
  leaseCount: number
  /** True once a first sync has run (keep-alive: never re-warm a cold pool). */
  warmed: boolean
  /** Set when a config/credential change invalidates the last synced set. */
  dirty: boolean
  /** Monotonic invalidation marker used to detect changes during a sync. */
  invalidationGeneration: number
  /** Last exact context that successfully addressed this pool identity. */
  lastResolveContext?: WorkspacePoolResolveContext
  /** Release for the P3.246 connection-verdict subscription, if one was installed. */
  unsubscribeConnectionVerdict?: () => void
  /** Last browse desired set's value-only external-auth requirements. */
  externalAuthRequirements: RuntimeExternalAuthRequirement[]
  /**
   * Browse api-source instances retained ACROSS syncs, keyed by wire slug and
   * stamped with the digest of the resolved configuration they were built from.
   * See {@link WorkspaceMcpPoolRegistry.retainUnchangedBrowseApiServers}.
   */
  browseApiServers: Map<string, { digest: string; server: unknown }>
  /** Ready desired sets for session leasers whose pinned runtime requires DP. */
  sessionExternalAuthDesired: Map<string, {
    requirement: RuntimeExternalAuthRequirement
    mcpServers: MaterializedRuntimePoolServers['mergedMcpServers']
    apiServers: MaterializedRuntimePoolServers['apiServers']
  }>
  /** In-flight sync (dedupes concurrent ensureSynced calls). */
  syncing?: Promise<void>
  resyncTimer?: NodeJS.Timeout
  sessionAuthResyncTimer?: NodeJS.Timeout
  sessionAuthSyncing?: Promise<void>
}

function poolMapKey(key: WorkspacePoolKey): string {
  return key.projectKey ? `${key.workspaceId}\0${key.projectKey}` : key.workspaceId
}

const MAX_DP_MATERIALIZATION_ATTEMPTS = 3

export class WorkspaceMcpPoolRegistry {
  private readonly pools = new Map<string, PoolEntry>()
  private readonly deps: WorkspaceMcpPoolRegistryDeps
  private readonly debug: (message: string) => void
  private readonly resyncDebounceMs: number
  private readonly dpSessionBroker: Pick<DpSessionBroker, 'probe' | 'subscribe'>
  private readonly unsubscribeDpSessionState: () => void
  private dpSessionState: RuntimeExternalAuthRequirement['state'] = 'unavailable'
  private dpReadyBoundaryGeneration = 0
  private disposed = false
  private disposePromise: Promise<void> | undefined

  constructor(deps: WorkspaceMcpPoolRegistryDeps) {
    this.deps = deps
    this.debug = deps.debug ?? (() => {})
    this.resyncDebounceMs = deps.resyncDebounceMs ?? 250
    this.dpSessionBroker = deps.dpSessionBroker
    this.unsubscribeDpSessionState = this.dpSessionBroker.subscribe(state => this.observeDpSessionState(state))
  }

  /**
   * Obtain a lease over the pool for a key, creating it on first ask. Creation
   * does NOT connect — the pool stays cold until `ensureSynced` (browse) or a
   * session `sync(..., { leaserId })` runs.
   *
   * P3.371 · THIS IS ONE OF TWO RADII, and reading only this one has already
   * produced a wrong answer. This registry decides how many pools exist — one
   * per `(workspaceId, projectKey)`, which is what {@link poolMapKey} spells.
   * How many TRANSPORTS exist inside one pool is a second and independent
   * decision, made by `mcpConnectionKey` in `@nessy-agent/shared/mcp`: by
   * default one per distinct server config, shared by every session leasing this
   * pool, which is why the roots answer below has to be the workspace-level
   * union rather than a per-session one. That module's docblock records the
   * decision, its blind spot (a `headersHelper`'s resolved credential is not in
   * the digest) and the operator lever that changes it
   * (`NESSY_MCP_CONNECTION_ISOLATION`). Neither radius is stated by any page;
   * both are ours.
   *
   * With `options.leaserId` the lease is a SESSION lease: its `release()` drops
   * that leaser from the shared pool's per-leaser desired set (reconciling so
   * only servers no other leaser wants disconnect). Without a leaserId it is a
   * browse lease whose `release()` is a no-op — the pool stays warm.
   */
  lease(key: WorkspacePoolKey, options?: { leaserId?: string }): WorkspacePoolLease {
    const entry = this.getOrCreateEntry(key)
    const leaserId = options?.leaserId
    if (leaserId === undefined) {
      return {
        key,
        pool: entry.pool,
        leaserId: entry.browseLeaserId,
        ensureSynced: context => this.ensureSynced(key, context),
        materializeRuntime: async runtime => (await this.materializeRuntimeResilient(entry, runtime)).servers,
        release: async () => {},
      }
    }
    entry.leaseCount += 1
    this.debug(`[WorkspaceMcpPool] lease ${poolMapKey(key)} leaser=${leaserId} count=${entry.leaseCount}`)
    let released = false
    return {
      key,
      pool: entry.pool,
      leaserId,
      ensureSynced: context => this.ensureSynced(key, context),
      materializeRuntime: async runtime => (
        await this.materializeRuntimeResilient(entry, runtime, false, leaserId)
      ).servers,
      release: async () => {
        if (released) return
        released = true
        entry.leaseCount -= 1
        entry.sessionExternalAuthDesired.delete(leaserId)
        this.debug(`[WorkspaceMcpPool] release ${poolMapKey(key)} leaser=${leaserId} count=${entry.leaseCount}`)
        await entry.pool.dropLeaser(leaserId)
      },
    }
  }

  /** Live SESSION-lease count for a key (observability / tests). */
  leaseCountFor(key: WorkspacePoolKey): number {
    return this.pools.get(poolMapKey(key))?.leaseCount ?? 0
  }

  /**
   * Tell every live pool's servers that the roots set moved (`mcp.md:108`).
   *
   * Fans out over ALL entries rather than taking a key: the only change source
   * we notify for is the global `additionalDirectories` setting, which every
   * pool's answer includes, so a per-key call would leave the other workspaces'
   * servers holding a stale set. Fail-soft per pool.
   */
  async notifyRootsChanged(): Promise<void> {
    for (const entry of this.pools.values()) {
      try {
        await entry.pool.notifyRootsChanged()
      } catch (error) {
        this.debug(`[WorkspaceMcpPool] roots/list_changed fan-out failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  private getOrCreateEntry(key: WorkspacePoolKey): PoolEntry {
    const mapKey = poolMapKey(key)
    let entry = this.pools.get(mapKey)
    if (!entry) {
      const workspaceRootPath = this.deps.resolveWorkspaceRootPath(key.workspaceId)
      const poolIdentity = createHash('sha256').update(mapKey).digest('hex')
      const browseLeaserId = `browse:${poolIdentity}`
      const pool = (this.deps.createPool ?? defaultCreatePool)({
        ...(workspaceRootPath ? { workspaceRootPath } : {}),
        debug: this.debug,
        // `mcp.md:108` — "Claude Code answers `roots/list` with the session's
        // launch directory plus every additional working directory you've
        // granted with `--add-dir`, `/add-dir`, or the `additionalDirectories`
        // setting."
        //
        // DECISION, and it is a real narrowing recorded here rather than
        // inherited: this pool is shared per (workspaceId, projectKey) across
        // every session that leases it, so ONE connection cannot answer
        // differently per session. The answer is the WORKSPACE-level union —
        // workspace root plus the persisted `additionalDirectories` — and it
        // deliberately does NOT include a session-scoped `addDirectories` grant.
        // Including one would widen the roots reported to servers that OTHER
        // sessions in the same workspace are also using, which is a cross-session
        // disclosure no doc sentence asks for.
        //
        // No cache of its own: `getConfiguredAdditionalDirectories` is memoized
        // on the raw config entries, so a settings edit takes effect on the next
        // `roots/list` without a restart.
        rootsProvider: () => [
          ...(workspaceRootPath ? [workspaceRootPath] : []),
          ...getConfiguredAdditionalDirectories(),
        ],
        ...(this.deps.processSupervisor
          ? {
              pluginProcessAuthority: {
                processSupervisor: this.deps.processSupervisor,
                sessionKey: {
                  workspaceId: key.workspaceId,
                  sessionId: `mcp-pool:${poolIdentity}`,
                },
              },
            }
          : {}),
      })
      entry = {
        pool,
        browseLeaserId,
        workspaceId: key.workspaceId,
        workspaceRootPath,
        leaseCount: 0,
        warmed: false,
        dirty: true,
        invalidationGeneration: 0,
        externalAuthRequirements: [],
        browseApiServers: new Map(),
        sessionExternalAuthDesired: new Map(),
      }
      this.pools.set(mapKey, entry)
      // P3.246. Subscribed at CREATION, not at first sync: a verdict can move
      // on a path that never reconciles (a 401 on a tool call, a transport that
      // dropped), and a subscription installed later would miss exactly those.
      if (this.deps.onConnectionVerdictChanged) {
        const notify = this.deps.onConnectionVerdictChanged
        entry.unsubscribeConnectionVerdict = pool.subscribeConnectionVerdictChanged(() => {
          try {
            notify(key.workspaceId)
          } catch (error) {
            this.debug(`[WorkspaceMcpPool] connection-verdict fan-out failed: ${error instanceof Error ? error.message : String(error)}`)
          }
        })
      }
      this.debug(`[WorkspaceMcpPool] created cold pool for ${mapKey}`)
    }
    return entry
  }

  /**
   * Lazy connect-on-first-need + resync-when-dirty. Runs a fresh NON-session
   * resolve, materializes the desired server set through the shared authority,
   * and syncs the pool. Concurrent calls share one in-flight sync.
   */
  private async ensureSynced(key: WorkspacePoolKey, context: WorkspacePoolResolveContext): Promise<void> {
    if (this.disposed) return
    const entry = this.getOrCreateEntry(key)
    entry.lastResolveContext = { ...context }
    if (entry.syncing) return entry.syncing
    // A transport can die after a successful warm sync. The pool records that
    // exact identity as failed; treating `warmed` as sufficient would make the
    // browse UI permanently stale until an unrelated config invalidation.
    if (entry.warmed && !entry.dirty && entry.pool.health(entry.browseLeaserId).failed.length === 0) return
    entry.syncing = (async () => {
      let syncGeneration: number
      do {
        syncGeneration = entry.invalidationGeneration
        await this.runSync(entry, context)
      } while (!this.disposed && entry.invalidationGeneration !== syncGeneration)
    })().finally(() => {
      entry.syncing = undefined
    })
    return entry.syncing
  }

  private async runSync(entry: PoolEntry, context: WorkspacePoolResolveContext): Promise<void> {
    entry.dirty = false
    const resolveContext = this.buildResolveContext(context)
    let mergedMcpServers: Record<string, unknown> = {}
    let apiServers: Record<string, unknown> = {}
    let materializedDpReadyBoundaryGeneration: number | undefined
    try {
      const snapshot = await this.deps.resolver.resolve(resolveContext)
      try {
        const materializer = createCapabilitySnapshotMaterializer(this.deps.resolver, snapshot, {
          resolveCredential: this.deps.resolveCredential,
        })
        const runtime = { view: toAgentRuntime(snapshot), materializer }
        const materialized = await this.materializeRuntimeResilient(entry, runtime, true)
        if (materialized.degraded) {
          // Neither the just-resolved snapshot nor the re-resolve could
          // materialize. Leave the pool exactly as it is and retry on the next
          // need: syncing the empty degraded set here would disconnect every
          // browse server over a transient resolve failure.
          entry.dirty = true
          return
        }
        mergedMcpServers = materialized.servers.mergedMcpServers
        apiServers = this.retainUnchangedBrowseApiServers(entry, materialized.servers, materialized.view)
        if (materialized.servers.externalAuthRequirements.some(requirement => requirement.provider === 'dp')) {
          materializedDpReadyBoundaryGeneration = this.dpReadyBoundaryGeneration
        }
      } finally {
        this.deps.resolver.releaseSnapshot(snapshot.leaseId)
      }
    } catch (err) {
      // Fail-soft: leave the pool as-is; the caller sees whatever is connected
      // (or a `disconnected` refusal). Mark dirty so the next need retries.
      entry.dirty = true
      this.debug(`[WorkspaceMcpPool] resolve/materialize failed: ${err instanceof Error ? err.message : String(err)}`)
      return
    }
    if (
      materializedDpReadyBoundaryGeneration !== undefined
      && materializedDpReadyBoundaryGeneration !== this.dpReadyBoundaryGeneration
    ) {
      entry.dirty = true
      return
    }
    if (this.disposed) return
    try {
      await entry.pool.sync(
        mergedMcpServers as Parameters<McpClientPool['sync']>[0],
        apiServers as Parameters<McpClientPool['sync']>[1],
        { leaserId: entry.browseLeaserId },
      )
      entry.warmed = true
    } catch (err) {
      entry.dirty = true
      this.debug(`[WorkspaceMcpPool] pool.sync failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /**
   * {@link materializeRuntime} with ONE re-resolve, then a soft failure.
   *
   * A `CapabilityMaterializationError` means the caller's PINNED snapshot can no
   * longer answer: its lease was revoked or a pinned resource moved, which is
   * exactly what a plugin install/enable/disable does to every snapshot in
   * flight. The correct response is to look again — so the registry resolves a
   * FRESH snapshot for this pool's own identity and retries once, the same thing
   * every other consumer of a moved generation does. Nothing here widens a lease
   * or weakens `assertActive`: the retry runs against a new, live lease.
   *
   * If the fresh snapshot fails the same way the result is DEGRADED — an empty
   * desired set with no requirements — rather than an exception. A materialize
   * is reached from the pending-auth summary and from the send preflight, and an
   * exception there reaches the user as a raw `capability-snapshot-revoked`
   * instead of an answer. Callers that must not act on an empty set (the browse
   * resync) read the `degraded` flag.
   */
  private async materializeRuntimeResilient(
    entry: PoolEntry,
    runtime: CapabilityTurnRuntime,
    trackBrowseRequirements = false,
    sessionLeaserId?: string,
  ): Promise<{
    servers: MaterializedRuntimePoolServers
    degraded: boolean
    /**
     * The view that actually produced `servers` — the re-resolved one when the
     * retry below ran. The browse api-source digest reads its credential
     * bindings, and reading them off the caller's stale view would hide a
     * rotation behind an unchanged config file.
     */
    view: CapabilityTurnRuntime['view']
  }> {
    try {
      return {
        servers: await this.materializeRuntime(entry, runtime, trackBrowseRequirements, sessionLeaserId),
        degraded: false,
        view: runtime.view,
      }
    } catch (error) {
      if (!isCapabilityMaterializationError(error)) throw error
      this.debug(`[WorkspaceMcpPool] pinned snapshot could not materialize (${error.message}); re-resolving`)
    }
    const context = entry.lastResolveContext ?? { workspaceId: entry.workspaceId }
    try {
      const snapshot = await this.deps.resolver.resolve(this.buildResolveContext(context))
      try {
        const materializer = createCapabilitySnapshotMaterializer(this.deps.resolver, snapshot, {
          resolveCredential: this.deps.resolveCredential,
        })
        const view = toAgentRuntime(snapshot)
        return {
          servers: await this.materializeRuntime(
            entry,
            { view, materializer },
            trackBrowseRequirements,
            sessionLeaserId,
          ),
          degraded: false,
          view,
        }
      } finally {
        this.deps.resolver.releaseSnapshot(snapshot.leaseId)
      }
    } catch (error) {
      if (!isCapabilityMaterializationError(error)) throw error
      this.debug(`[WorkspaceMcpPool] re-resolved snapshot could not materialize either (${error.message}); degrading`)
      return { servers: emptyMaterializedRuntimePoolServers(), degraded: true, view: runtime.view }
    }
  }

  /**
   * E5a — a reload keeps the live connections of servers whose configuration is
   * unchanged (`plugins-reference.md`: "When you reload, Claude Code keeps the
   * live connections of plugin servers whose configuration is unchanged").
   *
   * `McpClientPool.reconcileUnion` already honours that for MCP servers: their
   * `mcpConnectionKey` is a sha256 over the server config, so an unchanged
   * server keeps the same identity across syncs and its client is left alone.
   * An API source has no serializable config to hash — it reaches the pool as a
   * live in-process `McpServer`, and `apiConnectionKey` therefore keys on the
   * INSTANCE via a WeakMap. Every browse resync re-materializes, mints a fresh
   * instance for every api source, and so tears down and rebuilds every one of
   * them even when nothing moved.
   *
   * We keep `apiConnectionKey` as it is and stabilize what it keys on instead: a
   * content key inside the pool is not expressible (the pool cannot see what
   * makes an in-process server "the same one"), and retaining the instance is
   * what the pool's existing diff already needs. The digest is computed HERE,
   * where the inputs live — the loaded source record plus the value-only
   * credential binding (`{id, expectedRevision}`, never the secret), so a
   * rotated or expired credential bumps the revision, changes the digest and
   * DOES reconnect.
   *
   * Browse only. A session leaser's api instance carries closures over that
   * turn's materializer, so retaining one across turns would pin an expired
   * lease — the registry keeps minting those fresh.
   */
  private retainUnchangedBrowseApiServers(
    entry: PoolEntry,
    servers: MaterializedRuntimePoolServers,
    view: CapabilityTurnRuntime['view'],
  ): Record<string, unknown> {
    const loaded = new Map(servers.sources.map(source => [source.config.slug, source]))
    const credentials = new Map(view.sources.map(handle => [handle.logicalName, handle.credential]))
    const retained: Record<string, unknown> = {}
    const next = new Map<string, { digest: string; server: unknown }>()
    for (const [slug, server] of Object.entries(servers.apiServers)) {
      const digest = browseApiSourceDigest(loaded.get(slug), credentials.get(slug))
      if (digest === undefined) {
        // No record to compare against: fall back to today's behaviour rather
        // than retain an instance we cannot prove is still current.
        retained[slug] = server
        continue
      }
      const cached = entry.browseApiServers.get(slug)
      const reused = cached?.digest === digest ? cached.server : server
      retained[slug] = reused
      next.set(slug, { digest, server: reused })
    }
    entry.browseApiServers = next
    return retained
  }

  private async materializeRuntime(
    entry: PoolEntry,
    runtime: CapabilityTurnRuntime,
    trackBrowseRequirements = false,
    sessionLeaserId?: string,
  ): Promise<MaterializedRuntimePoolServers> {
    const materialize = (dpSessionState: RuntimeExternalAuthRequirement['state']) =>
      materializeRuntimePoolServers(runtime, {
        workspaceRootPath: entry.workspaceRootPath ?? entry.workspaceId,
        workspaceId: entry.workspaceId,
        // ONLY a real root path — never the workspace-id fallback above, which
        // is not a directory. Absent, the materializer withholds the project-dir
        // spawn variables and leaves `${CLAUDE_PROJECT_DIR}` tokens
        // literal-with-warning instead of spawning against a fabricated path.
        ...(entry.workspaceRootPath ? { projectDirectory: entry.workspaceRootPath } : {}),
        pluginNodeRuntime: this.deps.pluginNodeRuntime,
        dpSessionState,
        // A7 — same set, same preferences as the session path, so a server the
        // user enabled is not present in one pool and absent from the other.
        builtinDpMcpServers: { enabled: getBuiltinDpMcpServerPreferences() },
        // F1.112 (origin WI-bx, D1.425's residue) — the BROWSE pool is
        // deliberately UNFILTERED, and the omission is written down here rather
        // than left to be inferred from a missing key.
        //
        // OWNER-LEVEL DECISION, 2026-09-20, under AGENTS.md's transparent-and-
        // simple rule: browse stays unfiltered because browsing RUNS NO TOOL. A
        // verdict answers "where are this session's tool schemas going", and
        // this registry has no session and no model — it is the workspace
        // catalogue. The per-session path carries the verdict at the one reader
        // every runtime crosses (`BaseAgent.setSourceServers`), so nothing a
        // model can call escapes through here.
        //
        // The cost of the other posture, which is why it was refused: a catalog
        // that silently lost rows when a model was selected reproduces what
        // `managed-mcp.md#how-restrictions-appear-to-users` records as the
        // outcome an administrator's users complain about, with no surface left
        // to explain it. The explanation this product does have is DA2.6's
        // disclosure, and it is per-session, where the withholding is.
        //
        // Spelled as an explicit `undefined` so the decision is greppable and so
        // a future edit has to delete a line rather than add one;
        // `applyExternalModelMcpWhitelist` returns its maps untouched for an
        // absent verdict, so this is byte-identical to omitting the key.
        modelTarget: undefined,
        debug: this.debug,
      })
    for (let attempt = 0; attempt < MAX_DP_MATERIALIZATION_ATTEMPTS; attempt += 1) {
      const initialGeneration = this.dpReadyBoundaryGeneration
      let result = await materialize(this.dpSessionState)
      if (!result.externalAuthRequirements.some(requirement => requirement.provider === 'dp')) {
        if (trackBrowseRequirements) entry.externalAuthRequirements = result.externalAuthRequirements
        if (sessionLeaserId) entry.sessionExternalAuthDesired.delete(sessionLeaserId)
        return result
      }
      if (initialGeneration !== this.dpReadyBoundaryGeneration) continue

      const probeGeneration = this.dpReadyBoundaryGeneration
      const state = await this.dpSessionBroker.probe()
      if (probeGeneration !== this.dpReadyBoundaryGeneration) continue

      this.observeDpSessionState(state)
      const probedState = runtimeDpSessionState(state)
      const finalGeneration = this.dpReadyBoundaryGeneration
      // Compare against the DP entry explicitly: since C3 the aggregation may
      // also carry 'oauth'/'bearer' entries, so [0] is not necessarily dp.
      const materializedDpState = result.externalAuthRequirements
        .find(requirement => requirement.provider === 'dp')!.state
      if (probedState !== materializedDpState) {
        result = await materialize(probedState)
      }
      const dpRequirement = result.externalAuthRequirements.find(requirement => requirement.provider === 'dp')
      const readyResult = sessionLeaserId && dpRequirement?.state !== 'ready'
        ? await materialize('ready')
        : result
      if (finalGeneration !== this.dpReadyBoundaryGeneration) continue

      if (trackBrowseRequirements) entry.externalAuthRequirements = result.externalAuthRequirements
      if (sessionLeaserId && dpRequirement) {
        const readyDpRequirement = readyResult.externalAuthRequirements.find(requirement => requirement.provider === 'dp')
        entry.sessionExternalAuthDesired.set(sessionLeaserId, {
          requirement: readyDpRequirement ?? dpRequirement,
          mcpServers: readyResult.mergedMcpServers,
          apiServers: result.apiServers,
        })
      }
      return result
    }
    throw new Error('dp-session-state-unstable')
  }

  private observeDpSessionState(state: DpSessionState): void {
    const next = runtimeDpSessionState(state)
    const crossedReadyBoundary = (this.dpSessionState === 'ready') !== (next === 'ready')
    this.dpSessionState = next
    if (crossedReadyBoundary) this.dpReadyBoundaryGeneration += 1
    if (this.disposed || !crossedReadyBoundary) return
    for (const [mapKey, entry] of this.pools) {
      if (entry.externalAuthRequirements.some(requirement => requirement.provider === 'dp')) {
        this.invalidateEntry(mapKey, entry)
      }
      if ([...entry.sessionExternalAuthDesired.keys()].some(leaserId => entry.pool.hasLeaser(leaserId))) {
        this.scheduleSessionAuthResync(entry)
      }
    }
  }

  private scheduleSessionAuthResync(entry: PoolEntry): void {
    if (entry.sessionAuthResyncTimer) clearTimeout(entry.sessionAuthResyncTimer)
    entry.sessionAuthResyncTimer = setTimeout(() => {
      entry.sessionAuthResyncTimer = undefined
      if (this.disposed) return
      const syncing = Promise.all([...entry.sessionExternalAuthDesired].map(async ([leaserId, desired]) => {
        if (
          entry.sessionExternalAuthDesired.get(leaserId) !== desired
          || !entry.pool.hasLeaser(leaserId)
        ) return
        const builtinNames = new Set(desired.requirement.builtinWireNames ?? [])
        // Builtins gate on needs-login ONLY (owner decision 2026-08-06): a
        // transient non-ready state must not evict connected builtin servers,
        // while plugin dp servers keep their stricter !== 'ready' threshold.
        const blocked = new Set(
          this.dpSessionState === 'needs-login'
            ? desired.requirement.wireNames
            : desired.requirement.wireNames.filter(name => !builtinNames.has(name)),
        )
        const mcpServers = this.dpSessionState === 'ready'
          ? desired.mcpServers
          : Object.fromEntries(Object.entries(desired.mcpServers).filter(([wireName]) => !blocked.has(wireName)))
        try {
          await entry.pool.sync(
            mcpServers,
            desired.apiServers as Parameters<McpClientPool['sync']>[1],
            { leaserId },
          )
        } catch (err) {
          this.debug(`[WorkspaceMcpPool] session auth resync failed: ${err instanceof Error ? err.message : String(err)}`)
        }
      })).then(() => {})
      entry.sessionAuthSyncing = syncing
      void syncing.finally(() => {
        if (entry.sessionAuthSyncing === syncing) entry.sessionAuthSyncing = undefined
      })
    }, this.resyncDebounceMs)
  }

  private buildResolveContext(context: WorkspacePoolResolveContext): CapabilityContext {
    // Project scope is threaded ONLY for a trusted project handle. Absent that,
    // the resolve is pure workspace-scope; project-scoped MCP is simply not in
    // the snapshot (honestly unavailable — invariant g). Deliberately omit the
    // internal provider discriminator: browse is provider-neutral.
    const trusted = context.projectTrustState === 'trusted' && !!context.projectRoot && !!context.projectKey
    if (trusted) {
      return {
        workspaceId: context.workspaceId,
        workingDirectory: context.projectRoot,
        projectRoot: context.projectRoot,
        projectKey: context.projectKey as CapabilityContext['projectKey'],
        projectTrustState: 'trusted',
        projectTrustRevision: context.projectTrustRevision ?? '',
      }
    }
    return {
      workspaceId: context.workspaceId,
      projectTrustState: 'none',
      projectTrustRevision: '',
    }
  }

  /**
   * A config/source/credential change invalidated a workspace: mark its warm
   * pool dirty so the NEXT browse need resyncs, and — while it is warm — resync
   * eagerly (debounced) so an already-open detail page reflects the change (e.g.
   * OAuth completion, plugin uninstall). A COLD pool is left cold: no eager
   * warm-at-change (start policy). Project-scoped pools for the same workspace
   * are invalidated too.
   */
  invalidateWorkspace(workspaceId: string, context?: WorkspacePoolResolveContext): void {
    if (this.disposed) return
    for (const [mapKey, entry] of this.pools) {
      if (mapKey !== workspaceId && !mapKey.startsWith(`${workspaceId}\0`)) continue
      this.invalidateEntry(mapKey, entry, context)
    }
  }

  private invalidateEntry(
    mapKey: string,
    entry: PoolEntry,
    context?: WorkspacePoolResolveContext,
  ): void {
    entry.dirty = true
    entry.invalidationGeneration += 1
    if (!entry.warmed) return
    const key = this.keyForMapKey(mapKey)
    const explicitContextMatches = !!context && (key.projectKey
      ? context.projectKey === key.projectKey
      : !context.projectKey)
    // Never downgrade a warm trusted-project pool to a workspace-only
    // resolve. Its last exact trusted context is the only safe eager-resync
    // fallback when an invalidation event carries no canonical project root.
    const resyncContext = explicitContextMatches ? context : entry.lastResolveContext
    if (!resyncContext) return
    if (entry.resyncTimer) clearTimeout(entry.resyncTimer)
    entry.resyncTimer = setTimeout(() => {
      entry.resyncTimer = undefined
      void this.ensureSynced(key, resyncContext)
    }, this.resyncDebounceMs)
  }

  /** Global plugin inventory/policy mutation: invalidate every warm pool. */
  invalidateAll(): void {
    const workspaceIds = new Set([...this.pools.values()].map(entry => entry.workspaceId))
    for (const workspaceId of workspaceIds) this.invalidateWorkspace(workspaceId)
  }

  private keyForMapKey(mapKey: string): WorkspacePoolKey {
    const sep = mapKey.indexOf('\0')
    if (sep === -1) return { workspaceId: mapKey }
    return { workspaceId: mapKey.slice(0, sep), projectKey: mapKey.slice(sep + 1) }
  }

  /** Tear down every pool + timer. Called from the SessionManager dispose path. */
  dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise
    this.disposed = true
    this.unsubscribeDpSessionState()
    const entries = [...this.pools.values()]
    for (const entry of entries) {
      entry.unsubscribeConnectionVerdict?.()
      entry.unsubscribeConnectionVerdict = undefined
      if (entry.resyncTimer) clearTimeout(entry.resyncTimer)
      entry.resyncTimer = undefined
      if (entry.sessionAuthResyncTimer) clearTimeout(entry.sessionAuthResyncTimer)
      entry.sessionAuthResyncTimer = undefined
    }
    this.disposePromise = (async () => {
      await Promise.allSettled(entries.flatMap(entry => [
        ...(entry.syncing ? [entry.syncing] : []),
        ...(entry.sessionAuthSyncing ? [entry.sessionAuthSyncing] : []),
      ]))
      await Promise.all(entries.map(entry => entry.pool.disconnectAll().catch(() => {})))
      this.pools.clear()
    })()
    return this.disposePromise
  }
}

/**
 * `instanceof` plus the class's own `name`: the shared package is bundled more
 * than once across the electron main bundle and the headless server, and a
 * cross-realm instance would otherwise read as an unrelated error and abort a
 * send instead of degrading.
 */
function isCapabilityMaterializationError(error: unknown): error is CapabilityMaterializationError {
  return error instanceof CapabilityMaterializationError
    || (error instanceof Error && error.name === 'CapabilityMaterializationError')
}

/** Key order-independent JSON so a re-serialized record digests identically. */
function stableJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableJson)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, stableJson(child)]),
  )
}

/**
 * The identity of an api source's in-process server: everything
 * `SourceServerBuilder.buildApiServer` bakes into the instance, plus the
 * value-only credential binding it resolves against. `undefined` means "cannot
 * be established" — the caller then declines to retain rather than guess.
 */
function browseApiSourceDigest(
  source: MaterializedRuntimePoolServers['sources'][number] | undefined,
  credential: RuntimeCredentialBinding | undefined,
): string | undefined {
  if (!source) return undefined
  try {
    return createHash('sha256').update(JSON.stringify(stableJson({
      config: source.config,
      guide: source.guide,
      folderPath: source.folderPath,
      workspaceRootPath: source.workspaceRootPath,
      workspaceId: source.workspaceId,
      credential: credential ?? null,
    }))).digest('hex')
  } catch {
    return undefined
  }
}

function emptyMaterializedRuntimePoolServers(): MaterializedRuntimePoolServers {
  return {
    sources: [],
    mcpServers: {},
    apiServers: {},
    mergedMcpServers: {},
    externalAuthRequirements: [],
  }
}

function runtimeDpSessionState(state: DpSessionState): RuntimeExternalAuthRequirement['state'] {
  return state.state === 'ready' || state.state === 'needs-login'
    ? state.state
    : 'unavailable'
}

/**
 * Durable tool descriptors, shared by every pool this process creates.
 *
 * Keyed by the pool's own `connectionKey`, which hashes the whole server config
 * including credentials and the plugin executable, so one store is safe across
 * workspaces: a record can only ever be read back by the exact server identity
 * that wrote it.
 */
const toolDescriptorStore = createToolDescriptorStore(join(CONFIG_DIR, 'mcp', 'tool-descriptors'))

/**
 * P6.351 (denominator J44) — the documented name for the cache above.
 *
 * **The row's verdict was `absent` on all three and that is REFUTED at HEAD.**
 * J44 wanted *"a remote server's tools listable from the first message of a
 * session out of `MCP_DISCOVERY_CACHE`"*. `MCP_DISCOVERY_CACHE` does score 0 in
 * this tree — but the CAPABILITY is built and shipping under another name:
 * {@link toolDescriptorStore} plus the pool's `hydrateDescriptorsFromStore`,
 * whose own docblock reads *"Seed the in-memory cache and proxy routes for
 * desired servers that have durable descriptors but no live client yet, so they
 * are advertised and callable before their first connect."* That is the
 * behaviour, not an approximation of it. What was actually missing is the SWITCH.
 *
 * `mcp.md`, whole sentence: *"The discovery cache is off by default unless a
 * gradual rollout has enabled it for your account. Set `MCP_DISCOVERY_CACHE=1`
 * to turn it on, or `0` to keep it off even when the rollout has enabled it.
 * Before v2.1.238, the cache was on by default."*
 *
 * **Our default stays ON, and that is a stated divergence rather than a quiet
 * one.** The page's default is about a vendor rollout this product is not part
 * of, and our cache has been on since it was built — turning it off to match a
 * sentence about someone else's rollout would delete a working capability for
 * every user, which is the opposite of what the row asks for. So the operator
 * gets the documented control and the documented spelling, `0` wins, and the
 * difference in default is written here where the next reader meets it.
 */
const DISCOVERY_CACHE_ENV_VAR = 'MCP_DISCOVERY_CACHE'

function discoveryCacheEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env[DISCOVERY_CACHE_ENV_VAR] ?? '').trim().toLowerCase()
  if (raw === '0' || raw === 'false') return false
  return true
}

/**
 * Bounded initial-connect retry for every pool this process creates. Three
 * attempts on a transient failure, matching Claude Code's documented
 * initial-connect retry (`docs/en/mcp` — "retries the initial connection up to
 * three times on transient errors").
 *
 * The base delay is deliberately shorter than Claude's one second: the send path
 * passes `awaitConnect: false`, but `setSourceServers` without that option still
 * BLOCKS on the reconcile, so the worst-case chain (250ms + 500ms) has to stay
 * imperceptible there while still riding out a stdio process losing a race with
 * its own runtime or a single 5xx from a remote server.
 */
const MCP_CONNECT_RETRY = { attempts: 3, baseDelayMs: 250 } as const

function defaultCreatePool(options: NonNullable<ConstructorParameters<typeof McpClientPool>[0]>): McpClientPool {
  // NO sessionPath — the browse pool is session-invariant; tool responses are
  // never persisted to a session dir from a browse read.
  return new McpClientPool({
    ...(options.workspaceRootPath ? { workspaceRootPath: options.workspaceRootPath } : {}),
    ...(options.debug ? { debug: options.debug } : {}),
    ...(options.rootsProvider ? { rootsProvider: options.rootsProvider } : {}),
    ...(options.pluginProcessAuthority
      ? { pluginProcessAuthority: options.pluginProcessAuthority }
      : {}),
    // Without this the descriptor cache is inert: `hydrateDescriptorsFromStore`
    // returns early and `write` is a no-op, so a cold pool's first turn would
    // advertise no MCP tools now that connect is no longer awaited. Which is
    // exactly what an operator setting `MCP_DISCOVERY_CACHE=0` is asking for —
    // the omission IS the off switch, so no second inert path is needed.
    ...(discoveryCacheEnabled() ? { toolDescriptorStore } : {}),
    // A transient transport failure used to cost a server its entire session.
    // Three attempts with 1s/2s backoff, matching Claude Code's documented
    // initial-connect retry, and bounded by the pool's ONE connect deadline —
    // `awaitConnect: false` keeps the whole chain off the turn's critical path.
    retry: MCP_CONNECT_RETRY,
  })
}
