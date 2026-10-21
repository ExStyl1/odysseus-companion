/**
 * Pages MCP action executor.
 *
 * Backs PageActionBroker.executors.executeMcp for mcp-kind grants: resolves
 * the source fresh on every call (so credential updates and OAuth refreshes
 * are picked up), builds its server config through the SAME authority sessions
 * and the browse pool use, connects it into the workspace pool, and executes
 * the tool. The broker has already validated the lease, nonce, replay cache,
 * and grant before this runs — and enforces the per-action timeout by aborting
 * `signal`.
 *
 * Thrown errors become `{ok: false, error}` action results in the page;
 * returned strings become `{ok: true, body}`.
 *
 * UA9.2 — copied from craft-agents-oss `v0.13.4:packages/server-core/src/pages/mcp-executor.ts` (Apache-2.0),
 * adapted to our pool (plan UA9.2, manifest "lease (b)"):
 * - **No second pool.** Upstream builds a page-only `McpClientPool` per workspace and connects through a new
 *   `ensureConnected`. Ours leases the EXISTING workspace pool from `WorkspaceMcpPoolRegistry` as leaser
 *   `page:<slug>` and `sync`s that leaser's desired set — the per-leaser union the pool already reconciles, so a
 *   server the browse pool or a session already holds is joined (one transport, no reconnect, under the default
 *   `shared` posture) and `NESSY_MCP_CONNECTION_ISOLATION=per-leaser` gives the page its own transport like any
 *   other leaser. Upstream's `ensureConnected` (reconnect when the config changed; refuse stdio while local MCP is
 *   off) is what `sync` + `mcpConnectionKey` already do for every leaser — measured in the UA9.2 premise, so
 *   `mcp-pool.ts` is unchanged. The leaser is released when the page's last in-flight call settles.
 * - **The config comes from the capability materializer** (`materializeRuntimePoolServers`, through the lease's
 *   `materializeRuntime`), not upstream's `buildServersFromSources` — the same gating sessions get (enabled,
 *   trust, the local-MCP toggle, managed MCP policy, credentials). A source that is absent from the materialized
 *   view — disabled, managed-denied, not in this workspace — cannot be called whatever the grant says.
 * - **Proxy names** come from `pool.getProxyName` (our single naming authority: sanitizing, the 64-char cap and
 *   collision suffixes); upstream's `proxyToolName` is the sanitize half of `buildPoolProxyBaseName`.
 * - Calls are leaser-scoped (`callTool(..., { leaserId })`), so a page can only reach a slug it leased.
 */

import {
  getSourceCredentialManager,
  isRefreshableSource,
  isSourceUsable,
  loadSource as loadSourceFromDisk,
  TokenRefreshManager,
  type LoadedSource,
} from '@nessy-agent/shared/sources'
import type { CapabilityTurnRuntime, SdkMcpServerConfig } from '@nessy-agent/shared/agent/backend'
import { createCapabilitySnapshotMaterializer } from '@nessy-agent/shared/capabilities/materializer'
import type { CapabilityResolver } from '@nessy-agent/shared/capabilities/resolver'
import { toAgentRuntime } from '@nessy-agent/shared/capabilities/views'
import type { RuntimeCredentialBinding, ResolvedRuntimeCredential } from '@nessy-agent/shared/credentials'
import type { Logger } from '../runtime/platform'
import type { WorkspaceMcpPoolRegistry, WorkspacePoolLease } from '../mcp/workspace-mcp-pool-registry'
import { assertPageSourceUsable } from './source-gate'

/** Cap on tool-result text returned to a page (mirrors the api-kind cap in rpc/pages.ts). */
export const MCP_ACTION_BODY_MAX_CHARS = 512 * 1024

/** The pool leaser a page's calls run under (plan UA9.2). */
export function pageMcpLeaserId(pageSlug: string): string {
  return `page:${pageSlug}`
}

/** A capability runtime pinned for one call, and how to let go of its snapshot. */
export interface PagesCapabilityRuntime {
  runtime: CapabilityTurnRuntime
  release: () => void
}

export interface PagesMcpExecutorDeps {
  workspaceId: string
  workspaceRootPath: string
  /** The workspace pool registry; every call leases it as `page:<slug>` */
  registry: Pick<WorkspaceMcpPoolRegistry, 'lease'>
  /** A fresh workspace-scope capability runtime per call ({@link workspaceCapabilityRuntimeResolver}). */
  resolveRuntime: () => Promise<PagesCapabilityRuntime>
  log: Logger
  /** Test seams — default to the real implementations */
  loadSource?: (workspaceRootPath: string, sourceSlug: string) => LoadedSource | null
  refreshManager?: Pick<TokenRefreshManager, 'ensureFreshToken'>
}

/**
 * The production `resolveRuntime`: a workspace-scope resolve (no project — the browse pool's own context,
 * `WorkspaceMcpPoolRegistry.buildResolveContext`), materialized against the host's credential resolver.
 */
export function workspaceCapabilityRuntimeResolver(deps: {
  workspaceId: string
  resolver: CapabilityResolver
  resolveCredential: (binding: RuntimeCredentialBinding) => ResolvedRuntimeCredential
}): () => Promise<PagesCapabilityRuntime> {
  return async () => {
    const snapshot = await deps.resolver.resolve({
      workspaceId: deps.workspaceId,
      projectTrustState: 'none',
      projectTrustRevision: '',
    })
    const materializer = createCapabilitySnapshotMaterializer(deps.resolver, snapshot, {
      resolveCredential: deps.resolveCredential,
    })
    return {
      runtime: { view: toAgentRuntime(snapshot), materializer },
      release: () => deps.resolver.releaseSnapshot(snapshot.leaseId),
    }
  }
}

interface PageLeaseState {
  lease: WorkspacePoolLease
  /** Calls in flight on this page's leaser; the lease is released when it returns to zero. */
  inFlight: number
  /** The union of what in-flight calls need, so one call's sync never drops another's server. */
  desired: Map<string, { config: SdkMcpServerConfig; holders: number }>
}

export function createPagesMcpExecutor(deps: PagesMcpExecutorDeps) {
  const loadSource = deps.loadSource ?? loadSourceFromDisk
  // One manager per workspace executor so refresh-failure cooldowns persist
  // across calls (the instance-scoped rate limit is the whole point).
  const refreshManager =
    deps.refreshManager ??
    new TokenRefreshManager(getSourceCredentialManager(), {
      log: msg => deps.log.debug(msg),
    })
  const pages = new Map<string, PageLeaseState>()

  function acquire(pageSlug: string): PageLeaseState {
    let state = pages.get(pageSlug)
    if (!state) {
      state = {
        lease: deps.registry.lease({ workspaceId: deps.workspaceId }, { leaserId: pageMcpLeaserId(pageSlug) }),
        inFlight: 0,
        desired: new Map(),
      }
      pages.set(pageSlug, state)
    }
    state.inFlight += 1
    return state
  }

  async function release(pageSlug: string, state: PageLeaseState, wireName: string | undefined): Promise<void> {
    if (wireName) {
      const held = state.desired.get(wireName)
      if (held && --held.holders <= 0) state.desired.delete(wireName)
    }
    state.inFlight -= 1
    if (state.inFlight > 0) return
    if (pages.get(pageSlug) === state) pages.delete(pageSlug)
    try {
      await state.lease.release()
    } catch (error) {
      deps.log.warn(`[pages] releasing the MCP lease of ${pageSlug} failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  return async (
    invocation: { pageSlug: string; sourceSlug: string; toolName: string; args: Record<string, unknown> },
    options: { signal: AbortSignal },
  ): Promise<unknown> => {
    const { pageSlug, sourceSlug, toolName, args } = invocation

    const source = loadSource(deps.workspaceRootPath, sourceSlug)
    if (!source) {
      throw new Error(`Source "${sourceSlug}" not found in this workspace`)
    }
    // Sessions heal expired-but-refreshable tokens in their own refresh
    // cycle; pages have none, so heal here before the build — otherwise an
    // expired OAuth token dead-ends as "not connectable: Token expired"
    // forever. A failed refresh marks the source needs_auth (disk +
    // in-memory), which the gate below turns into the stable auth error.
    if (isSourceUsable(source) && isRefreshableSource(source)) {
      await refreshManager.ensureFreshToken(source)
    }
    assertPageSourceUsable(source)

    const state = acquire(pageSlug)
    let wireName: string | undefined
    try {
      // Fresh materialization per call: picks up rotated credentials and policy;
      // `sync` reconnects only when the config identity actually changed.
      const pinned = await deps.resolveRuntime()
      let config: SdkMcpServerConfig | undefined
      try {
        const handle = pinned.runtime.view.sources.find(candidate => candidate.logicalName === sourceSlug)
        if (!handle) {
          throw new Error(`Source "${sourceSlug}" is not available to this workspace (disabled or blocked by policy)`)
        }
        const servers = await state.lease.materializeRuntime(pinned.runtime)
        if (!handle.mcpWireName) {
          if (servers.apiServers[sourceSlug]) {
            throw new Error(`Source "${sourceSlug}" is an API source — use an api-kind grant instead of mcp`)
          }
          throw new Error(`Source "${sourceSlug}" did not produce an MCP server config`)
        }
        wireName = handle.mcpWireName
        config = servers.mergedMcpServers[wireName]
      } finally {
        pinned.release()
      }
      if (!config) {
        // The build may have just marked the source needs_auth — prefer the
        // stable auth error over generic connect prose.
        const fresh = loadSource(deps.workspaceRootPath, sourceSlug)
        if (fresh) assertPageSourceUsable(fresh)
        const missing = wireName
        wireName = undefined
        throw new Error(`Source "${sourceSlug}" is not connectable (no server config for ${missing})`)
      }

      const held = state.desired.get(wireName)
      if (held) {
        held.config = config
        held.holders += 1
      } else {
        state.desired.set(wireName, { config, holders: 1 })
      }
      const failed = await state.lease.pool.sync(
        Object.fromEntries([...state.desired].map(([name, entry]) => [name, entry.config])),
        {},
        { leaserId: state.lease.leaserId },
      )
      if (failed.includes(wireName)) {
        const fresh = loadSource(deps.workspaceRootPath, sourceSlug)
        if (fresh) assertPageSourceUsable(fresh)
        throw new Error(`Source "${sourceSlug}" is not connectable: its server failed to connect`)
      }

      const proxyName = state.lease.pool.getProxyName(wireName, toolName, state.lease.leaserId)
      const result = await state.lease.pool.callTool(proxyName, args, options.signal, {
        leaserId: state.lease.leaserId,
      })
      if (result.isError) {
        throw new Error(result.content || `Tool ${toolName} on ${sourceSlug} failed`)
      }
      if (result.content.length > MCP_ACTION_BODY_MAX_CHARS) {
        const marker = `\n…[truncated — full result was ${result.content.length} chars]`
        return result.content.slice(0, MCP_ACTION_BODY_MAX_CHARS - marker.length) + marker
      }
      return result.content
    } finally {
      await release(pageSlug, state, wireName)
    }
  }
}
