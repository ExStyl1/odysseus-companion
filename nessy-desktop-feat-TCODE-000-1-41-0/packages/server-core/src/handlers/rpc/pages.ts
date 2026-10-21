/**
 * UA6.4 — RPC handlers for workspace Pages (the core channels). Adapted from craft-agents-oss
 * `v0.13.4:packages/server-core/src/handlers/rpc/pages.ts` (Apache-2.0), rebranded (`@craft-agent` → `@nessy-agent`).
 *
 * UA6.7 — v0.13.4 L363–L437 (sharing) land REWRITTEN onto t-artifacts, at the end of {@link registerPagesHandlers}:
 *   `pages:getShareDataScan` (upstream's data scan plus our review: the host card for exactly the bytes a publish
 *   would send — nothing is sent), `pages:publish` (the reviewed bytes, through the one publish chain) and
 *   `pages:unpublish` (one DELETE through the registry), all over `server-core/src/pages/page-publishing.ts`.
 *   Dropped: `pages:getShareCapabilities` (a feature flag — an offer flag under spec §6) and
 *   `pages:setPublicationPassword` (the service has no passwords); the Craft `PagePublisher` is reason (a).
 *   `pages:delete` unpublishes a published page first (upstream's `deletePageWithUnpublish` policy).
 * UA8.2: v0.13.4 L201 (`refresh` on create) and the update patch's `refresh` land REWRITTEN: on the wire a refresh
 *   carries script CONTENT (`PageRefreshInput`) and goes through `setPageRefresh`, the same host writer the page tools
 *   use (it writes `pages/{slug}/refresh.ts`, strict: an upstream script PATH is refused); it is validated before any
 *   write, and it stays inert until approved. The upstream script-path spec is dropped under reason (b).
 * The renderer that calls these (PagesHome, PageView, PageFrame) is UA7.3's; nothing visible leads here before it.
 * UA8.3 (ours — upstream has no approval or run-now channel, spec §15): `pages:getRefreshStatus`,
 *   `pages:approveRefresh` and `pages:runRefreshNow`, at the end of {@link registerPagesHandlers}.
 * UA9.3 — v0.13.4 L5–L7, L35, L40–L47, L55–L168 (the per-workspace `PageActionBroker` and its executors) and
 *   L277–L315, L341–L361 (`pages:listGrants`, `issueGrant`, `revokeGrant`, `executeAction`, `cancelAction`), adapted
 *   (spec §15 "Page actions"; the broker is UA9.2's, on our system):
 *   - **One broker per workspace**, holding the render leases (UA6.4's lease-only store is gone). Its MCP executor
 *     leases the EXISTING workspace pool (`SessionManager`'s `WorkspaceMcpPoolRegistry`, leaser `page:<slug>`) with a
 *     fresh workspace-scope capability runtime per call — no second pool (upstream builds a page-only `McpClientPool`,
 *     L44–L47, L145–L155). Its script executor runs through `runApprovedScript` with the grant as the approval and the
 *     host's privileged audit sink. Its API executor is upstream's `buildApiExecutor` over `executeApiRequest`, and it
 *     first asks the same workspace capability view the MCP executor asks: a source absent from it (disabled,
 *     managed-denied) cannot be called, whatever the grant says. The host seams come from
 *     `ISessionManager.pageActionHostPorts`; a host without them gets a broker with NO executors (every action answers
 *     `executor-unavailable`) — fail closed.
 *   - **Grants are the host-approvals ledger's** (UA9.2): `listGrants` → `listPageGrants`, `issueGrant` →
 *     `issuePageGrant`, `revokeGrant` → `revokePageGrant`; page.json is never read or written for a grant (reason (b)).
 *     `issueGrant` re-parses the descriptor, refuses a page whose content moved from the digest the person saw
 *     (`content-changed`) and, for a script, bytes that moved from the sha256 the dialog showed
 *     (`grant-script-changed`); the grant then pins that sha256 (`pageGrantRecord`). Issue and revoke push
 *     `pages:changed`, so every open view re-reads the grants.
 *   - **`pages:describeGrantRequest` (ours)** — the host-validated descriptor a grant dialog shows as the authority: the
 *     descriptor re-parsed by the host's schema and, for a script, the sha256 of its bytes now (contained in the
 *     workspace, symlinks resolved). Upstream's dialog shows the page's own message.
 *   - Every new handler runs `assertCallerWorkspace` first, as the rest of this module.
 *
 * Channels handled here (all REMOTE_ELIGIBLE — pages are workspace content, as upstream classifies them):
 * `pages:get`, `getOne`, `create`, `update`, `delete`, `getContent`, `setContent`, `getData`, `createLease`,
 * `releaseLease`, and (UA7.4, v0.13.4 L439–L470) `pages:getThumbnail` and `pages:regenerateThumbnail`; a create with
 * content and every `setContent` enqueue a poster capture (v0.13.4 L205–L208, L265). The `pages:changed` push is UA6.2's (`SessionManager.broadcastPagesChanged`); these handlers push
 * it too after each mutation, as upstream.
 *
 * Stated divergences from v0.13.4:
 * - Every handler runs `assertCallerWorkspace` (UA1.9) first, refusing `pages-workspace-mismatch` (upstream: no
 *   caller check). The workspace root comes from the workspace service, never from the wire.
 * - A lease is released only by the workspace that issued it (the store is per workspace root).
 * - `pages:delete` is `deletePageLocal` (UA6.1) — the same single implementation behind `delete_page` (UA6.2).
 * - `pages:regenerateThumbnail` answers false for a slug that is not a page slug and enqueues nothing (upstream
 *   enqueues it and lets the capture find no page).
 */
import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { RPC_CHANNELS } from '@nessy-agent/shared/protocol'
import type {
  CreatePageInput,
  PageActionBroker,
  PageActionDescriptor,
  PageActionExecutors,
  PageActionGrant,
  PageActionRequest,
  PageGateRefusalReport,
  PageRefreshInput,
  UpdatePagePatch,
} from '@nessy-agent/shared/pages'
import type { PagePublishOptions } from '@nessy-agent/shared/pages/types'
import type { TArtifactsClient } from '@nessy-agent/shared/artifacts/t-artifacts-client'
import { CLIENT_CONFIRM_DIALOG, pushTyped, type RpcServer } from '@nessy-agent/server-core/transport'
import type { HandlerDeps } from '../handler-deps'
import { getWorkspaceOrThrow } from '../utils'
import { assertCallerWorkspace } from './caller-workspace'
import { PrivilegedExecutionBroker } from '../../services/privileged-execution-broker'

export const HANDLED_CHANNELS = [
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
  RPC_CHANNELS.pages.GET_THUMBNAIL,
  RPC_CHANNELS.pages.REGENERATE_THUMBNAIL,
  RPC_CHANNELS.pages.GET_REFRESH_STATUS, // UA8.3
  RPC_CHANNELS.pages.APPROVE_REFRESH, // UA8.3
  RPC_CHANNELS.pages.RUN_REFRESH_NOW, // UA8.3
  RPC_CHANNELS.pages.LIST_GRANTS, // UA9.3
  RPC_CHANNELS.pages.DESCRIBE_GRANT_REQUEST, // UA9.3 (ours)
  RPC_CHANNELS.pages.ISSUE_GRANT, // UA9.3
  RPC_CHANNELS.pages.REVOKE_GRANT, // UA9.3
  RPC_CHANNELS.pages.EXECUTE_ACTION, // UA9.3
  RPC_CHANNELS.pages.CANCEL_ACTION, // UA9.3
  RPC_CHANNELS.pages.AUDIT_REFUSAL, // UA12.112
  RPC_CHANNELS.pages.GET_SHARE_DATA_SCAN, // UA6.7
  RPC_CHANNELS.pages.PUBLISH, // UA6.7
  RPC_CHANNELS.pages.UNPUBLISH, // UA6.7
] as const

/** The refusal every handler raises for a caller bound to another workspace (UA1.9). */
const WORKSPACE_MISMATCH = 'pages-workspace-mismatch'

/** Cap on action response bodies returned to the renderer (v0.13.4 L35) */
const ACTION_BODY_MAX_CHARS = 512 * 1024

/** What the renderer passes to `pages:issueGrant` after the person approved a request. */
export interface PageGrantIssueInput {
  action: PageActionDescriptor
  /** Page-supplied purpose; stored as the page's words, never the authority. */
  description?: string
  /** The digest of the content the person had on screen (the render lease's). */
  contentDigest: string
  /** Script grants: the sha256 the dialog showed (`pages:describeGrantRequest`). */
  scriptSha256?: string
}

/** What `pages:describeGrantRequest` answers: the descriptor as the host parsed it, and a script's sha256 now. */
export interface PageGrantRequestDescription {
  action: PageActionDescriptor
  scriptSha256?: string
}

/** Longest page-supplied grant description kept (the bridge bounds it at 500 too). */
const GRANT_DESCRIPTION_MAX_CHARS = 500

export function registerPagesHandlers(server: RpcServer, deps: HandlerDeps): void {
  const log = deps.platform.logger

  // One broker per workspace: render leases and in-flight actions are
  // in-memory state scoped to the hosting process.
  const brokers = new Map<string, Promise<PageActionBroker>>()

  /** UA6.7 — the one fixed-origin client `publish_artifact` and the Published pages list use (`SessionManager`). */
  const artifactsClient = (): TArtifactsClient => {
    const client = deps.sessionManager.createArtifactsClient?.()
    if (!client) throw new Error('artifacts-unavailable')
    return client
  }

  /** The caller's own workspace root, after the caller-workspace check. */
  const rootFor = (ctx: Parameters<typeof assertCallerWorkspace>[0], workspaceId: string): string => {
    assertCallerWorkspace(ctx, deps, workspaceId, WORKSPACE_MISMATCH)
    return getWorkspaceOrThrow(deps.workspaceService, workspaceId).workspaceRootPath
  }

  async function broadcastChanged(workspaceId: string, workspaceRootPath: string): Promise<void> {
    const { loadWorkspacePages } = await import('@nessy-agent/shared/pages')
    const pages = loadWorkspacePages(workspaceRootPath)
    pushTyped(server, RPC_CHANNELS.pages.CHANGED, { to: 'workspace', workspaceId }, workspaceId, pages)
  }

  /**
   * API executor for the action bridge (v0.13.4 L55–L129). Resolves the source + credential lazily per call (same
   * seams sessions use), so tokens refresh correctly and never leave the host process. Ours: `inView` first asks the
   * workspace capability view whether the source may be used at all (disabled, managed-denied → refused).
   */
  function buildApiExecutor(
    workspaceRootPath: string,
    inView: (sourceSlug: string) => Promise<boolean>,
  ): NonNullable<PageActionExecutors['executeApi']> {
    // One refresh manager per workspace executor so failed-refresh cooldowns
    // survive across calls instead of resetting on every action.
    let refreshManager: import('@nessy-agent/shared/sources').TokenRefreshManager | undefined
    return async (invocation, { signal }) => {
      const {
        loadSource,
        getSourceCredentialManager,
        getSourceServerBuilder,
        isApiOAuthProvider,
        hasRenewEndpoint,
        TokenRefreshManager,
        createTokenGetter,
        executeApiRequest,
      } = await import('@nessy-agent/shared/sources')
      const { assertPageSourceUsable } = await import('../../pages/source-gate')

      const source = loadSource(workspaceRootPath, invocation.sourceSlug)
      if (!source || source.config.type !== 'api') {
        throw new Error(`API source not found: ${invocation.sourceSlug}`)
      }
      // Fail fast with the stable source-auth-required error instead of
      // letting the request die on a 401 or a refresh timeout downstream.
      assertPageSourceUsable(source)
      if (!(await inView(invocation.sourceSlug))) {
        throw new Error(`Source "${invocation.sourceSlug}" is not available to this workspace (disabled or blocked by policy)`)
      }

      const credManager = getSourceCredentialManager()
      const apiConfig = getSourceServerBuilder().buildApiConfig(source)

      // Credential resolution mirrors the session path: refreshable sources get a TokenRefreshManager-backed
      // getter, plain API sources read the vault per request, 'none' uses no credential.
      let credentialSource: import('@nessy-agent/shared/sources').ApiCredentialSource
      if (isApiOAuthProvider(source.config.provider) || source.config.api?.authType === 'oauth' || hasRenewEndpoint(source)) {
        refreshManager ??= new TokenRefreshManager(credManager, { log: (msg: string) => log.info(msg) })
        credentialSource = createTokenGetter(refreshManager, source)
      } else if (source.config.api?.authType === 'none' || !source.config.api?.authType) {
        credentialSource = ''
      } else {
        credentialSource = async () => credManager.getApiCredential(source)
      }

      let outcome: Awaited<ReturnType<typeof executeApiRequest>>
      try {
        outcome = await executeApiRequest(
          apiConfig,
          credentialSource,
          { path: invocation.path, method: invocation.method, params: invocation.params },
          { signal },
        )
      } catch (err) {
        // A failed token refresh inside the request marks the source
        // needs_auth — reload and surface the stable auth error so this
        // very call already tells the page (and matches the banner).
        const fresh = loadSource(workspaceRootPath, invocation.sourceSlug)
        if (fresh) assertPageSourceUsable(fresh)
        throw err
      }

      // Shape the body for the renderer: parse JSON when it is JSON, cap size.
      let text = outcome.buffer.toString('utf-8')
      const truncated = text.length > ACTION_BODY_MAX_CHARS
      if (truncated) {
        text = `${text.slice(0, ACTION_BODY_MAX_CHARS)}…[truncated]`
      }
      let body: unknown = text
      if (!truncated && outcome.contentType?.toLowerCase().includes('json')) {
        try { body = JSON.parse(text) } catch { /* leave as text */ }
      }
      return { status: outcome.status, ok: outcome.ok, body }
    }
  }

  /** The workspace's broker (v0.13.4 L131–L168), built once; concurrent first calls share one build. */
  function brokerFor(workspaceId: string, workspaceRootPath: string): Promise<PageActionBroker> {
    let pending = brokers.get(workspaceRootPath)
    if (!pending) {
      pending = buildBroker(workspaceId, workspaceRootPath)
      brokers.set(workspaceRootPath, pending)
      pending.catch(() => brokers.delete(workspaceRootPath))
    }
    return pending
  }

  async function buildBroker(workspaceId: string, workspaceRootPath: string): Promise<PageActionBroker> {
    const { PageActionBroker } = await import('@nessy-agent/shared/pages')
    const { loadWorkspaceSources } = await import('@nessy-agent/shared/sources')

    // UA12.102 — the slugs are read per ACTION, not here: the broker lives as long as the workspace,
    // so a source added after its build must still have its own permissions.json rules merged into the
    // next action's annotation (upstream reads them once here — v0.13.4 L138–L143, unchanged in v0.14.0).
    const activeSourceSlugs = (): string[] => {
      try {
        return loadWorkspaceSources(workspaceRootPath).map((source) => source.config.slug)
      } catch {
        return [] // Policy annotation degrades gracefully without per-source permissions
      }
    }

    const ports = deps.sessionManager.pageActionHostPorts?.()
    let executors: PageActionExecutors = {}
    // UA12.64 — the broker's MCP policy annotation names a call by the pool's WIRE name (the
    // resolver-minted `<wire>` of `mcp__<wire>__<tool>`, what the MCP executor calls through and
    // what an `allowedMcpPatterns` rule is written against), so the annotation reads the wire
    // name from the SAME workspace capability view the executors ask: `inView`'s lookup, plus
    // the handle's `mcpWireName`. A source the view cannot name (absent, disabled) leaves the
    // annotation on the config slug — the broker's fallback.
    let resolveMcpWireName: ((sourceSlug: string) => Promise<string | undefined>) | undefined
    if (ports) {
      const { createPagesMcpExecutor, workspaceCapabilityRuntimeResolver } = await import('../../pages/mcp-executor')
      const { createPagesScriptExecutor } = await import('../../pages/script-executor-bridge')
      const resolveRuntime = workspaceCapabilityRuntimeResolver({
        workspaceId,
        resolver: ports.resolver,
        resolveCredential: ports.resolveCredential,
      })
      resolveMcpWireName = async (sourceSlug: string): Promise<string | undefined> => {
        const pinned = await resolveRuntime()
        try {
          return pinned.runtime.view.sources.find(candidate => candidate.logicalName === sourceSlug)?.mcpWireName
        } finally {
          pinned.release()
        }
      }
      const inView = async (sourceSlug: string): Promise<boolean> => {
        const pinned = await resolveRuntime()
        try {
          return pinned.runtime.view.sources.some(candidate => candidate.logicalName === sourceSlug)
        } finally {
          pinned.release()
        }
      }
      executors = {
        executeApi: buildApiExecutor(workspaceRootPath, inView),
        executeMcp: createPagesMcpExecutor({ workspaceId, workspaceRootPath, registry: ports.registry, resolveRuntime, log }),
        executeScript: createPagesScriptExecutor({ workspaceRootPath, workspaceId, log, audit: ports.audit }),
      }
    } else {
      log.warn(`[pages] no page action host ports on this host — page actions of workspace ${workspaceId} are unavailable`)
    }

    const broker = new PageActionBroker({
      executors,
      workspaceRootPath,
      permissionsContext: () => ({ workspaceRootPath, activeSourceSlugs: activeSourceSlugs() }),
      ...(resolveMcpWireName ? { resolveMcpWireName } : {}),
    })
    log.info(`Created page action broker for workspace ${workspaceId}`)
    return broker
  }

  // List all pages for a workspace
  server.handle(RPC_CHANNELS.pages.GET, async (ctx, workspaceId: string) => {
    const root = rootFor(ctx, workspaceId)
    const { loadWorkspacePages } = await import('@nessy-agent/shared/pages')
    return loadWorkspacePages(root)
  })

  // Get one page (by slug or id)
  server.handle(RPC_CHANNELS.pages.GET_ONE, async (ctx, workspaceId: string, pageIdOrSlug: string) => {
    const root = rootFor(ctx, workspaceId)
    const { loadPage, loadPageById } = await import('@nessy-agent/shared/pages')
    return loadPage(root, pageIdOrSlug)
      ?? loadPageById(root, pageIdOrSlug)
  })

  // Create a new page
  server.handle(RPC_CHANNELS.pages.CREATE, async (
    ctx,
    workspaceId: string,
    input: Omit<CreatePageInput, 'refresh'> & { refresh?: PageRefreshInput },
  ) => {
    const root = rootFor(ctx, workspaceId)
    const { createPage, parsePageRefreshInput, setPageRefresh } = await import('@nessy-agent/shared/pages')
    if (input.refresh !== undefined) parsePageRefreshInput(input.refresh) // UA8.2 — refuse before the page exists
    let page = createPage(root, {
      name: input.name?.trim() || 'New Page',
      description: input.description,
      kind: input.kind,
      projectId: input.projectId,
      content: input.content,
    })
    if (input.refresh !== undefined) page = setPageRefresh(root, page.slug, input.refresh)
    deps.sessionManager.notifyConfigFileChange(workspaceId, `pages/${page.slug}/page.json`)
    await broadcastChanged(workspaceId, root)
    // UA7.4 — a page created with inline content gets a poster; empty pages wait for content.
    if (input.content !== undefined) deps.sessionManager.enqueuePageThumbnail(workspaceId, root, page.slug)
    log.info(`Created page: ${page.slug}`)
    return page
  })

  // Update page metadata (managed fields excluded). Slug stays stable.
  server.handle(RPC_CHANNELS.pages.UPDATE, async (
    ctx,
    workspaceId: string,
    pageSlug: string,
    patch: Omit<UpdatePagePatch, 'refresh'> & { refresh?: PageRefreshInput | null },
  ) => {
    const root = rootFor(ctx, workspaceId)
    const { updatePage, parsePageRefreshInput, setPageRefresh } = await import('@nessy-agent/shared/pages')
    const { refresh, ...configPatch } = patch ?? {}
    if (refresh !== undefined && refresh !== null) parsePageRefreshInput(refresh) // UA8.2 — before any write
    let updated = updatePage(root, pageSlug, configPatch)
    if (refresh !== undefined) updated = setPageRefresh(root, pageSlug, refresh)
    deps.sessionManager.notifyConfigFileChange(workspaceId, `pages/${pageSlug}/page.json`)
    await broadcastChanged(workspaceId, root)
    return updated
  })

  // Delete a page (content and data go with the folder). deletePageLocal is shared verbatim with the delete_page
  // session tool (UA6.2), so the two delete paths cannot drift; UA6.7: a published page's copy goes first.
  server.handle(RPC_CHANNELS.pages.DELETE, async (ctx, workspaceId: string, pageSlug: string) => {
    const root = rootFor(ctx, workspaceId)
    const { deletePageLocal } = await import('@nessy-agent/shared/pages')
    const { unpublishBeforeDelete } = await import('../../pages/page-publishing')
    const { publicCopyMayRemain } = await deletePageLocal(root, workspaceId, pageSlug, {
      log: (message: string) => log.warn(message),
      unpublish: unpublishBeforeDelete({ workspaceRoot: root, createClient: artifactsClient }),
    })
    deps.sessionManager.notifyConfigFileChange(workspaceId, `pages/${pageSlug}/page.json`)
    await broadcastChanged(workspaceId, root)
    log.info(`Deleted page ${pageSlug}`)
    return { publicCopyMayRemain }
  })

  // Read page content (for editing/inspection — rendering should use CREATE_LEASE)
  server.handle(RPC_CHANNELS.pages.GET_CONTENT, async (ctx, workspaceId: string, pageSlug: string) => {
    const root = rootFor(ctx, workspaceId)
    const { loadPageContent, loadPageConfig } = await import('@nessy-agent/shared/pages')
    return {
      content: loadPageContent(root, pageSlug),
      contentDigest: loadPageConfig(root, pageSlug)?.contentDigest,
    }
  })

  // Write page content (updates contentDigest; grants bound to the old digest go stale by design)
  server.handle(RPC_CHANNELS.pages.SET_CONTENT, async (ctx, workspaceId: string, pageSlug: string, content: string) => {
    const root = rootFor(ctx, workspaceId)
    const { savePageContent } = await import('@nessy-agent/shared/pages')
    const updated = savePageContent(root, pageSlug, content)
    deps.sessionManager.notifyConfigFileChange(workspaceId, `pages/${pageSlug}/page.json`)
    await broadcastChanged(workspaceId, root)
    deps.sessionManager.enqueuePageThumbnail(workspaceId, root, pageSlug) // UA7.4
    return updated
  })

  // Read the page's data snapshot (cross-process contract written by data writes and refresh runs)
  server.handle(RPC_CHANNELS.pages.GET_DATA, async (ctx, workspaceId: string, pageSlug: string) => {
    const root = rootFor(ctx, workspaceId)
    const { readPageDataSnapshot } = await import('@nessy-agent/shared/pages')
    return readPageDataSnapshot(root, pageSlug)
  })

  // Issue a render lease. Returns the lease AND the exact content it is bound
  // to — the renderer must render THIS content string (not a separately
  // fetched copy), closing the read/lease race.
  server.handle(RPC_CHANNELS.pages.CREATE_LEASE, async (ctx, workspaceId: string, pageSlug: string) => {
    const root = rootFor(ctx, workspaceId)
    const { loadPageContent, computePageContentDigest } = await import('@nessy-agent/shared/pages')

    const content = loadPageContent(root, pageSlug)
    if (content === null) throw new Error(`Page has no content: ${pageSlug}`)

    const broker = await brokerFor(workspaceId, root)
    const lease = broker.createLease({ pageSlug, contentDigest: computePageContentDigest(content) })
    return { lease, content }
  })

  // Release a render lease (page unmounted)
  server.handle(RPC_CHANNELS.pages.RELEASE_LEASE, async (ctx, workspaceId: string, leaseId: string) => {
    const root = rootFor(ctx, workspaceId)
    ;(await brokerFor(workspaceId, root)).releaseLease(leaseId)
  })

  // ------------------------------------------------------------------
  // UA7.4 — Thumbnails (cached poster). Generation is Electron-main-only; these
  // handlers serve the stored file and enqueue regeneration (a no-op on hosts
  // without an injected capturer).
  // ------------------------------------------------------------------

  // Read a page's poster as a data URL, but ONLY when it is fresh (the stored
  // digest matches the current content). Stale/missing → null → tile falls back.
  server.handle(RPC_CHANNELS.pages.GET_THUMBNAIL, async (ctx, workspaceId: string, pageSlug: string) => {
    const root = rootFor(ctx, workspaceId)
    const { loadPageConfig, getPageThumbnailPath, isThumbnailFresh } = await import('@nessy-agent/shared/pages')
    const config = loadPageConfig(root, pageSlug)
    if (!config || !isThumbnailFresh(config)) return null
    const path = getPageThumbnailPath(root, pageSlug)
    if (!existsSync(path)) return null
    try {
      const b64 = readFileSync(path).toString('base64')
      return { dataUrl: `data:image/jpeg;base64,${b64}`, digest: config.contentDigest! }
    } catch {
      return null
    }
  })

  // Manually request a (re)capture (e.g. an agent/user "refresh preview").
  server.handle(RPC_CHANNELS.pages.REGENERATE_THUMBNAIL, async (ctx, workspaceId: string, pageSlug: string) => {
    const root = rootFor(ctx, workspaceId)
    const { isValidPageSlug } = await import('@nessy-agent/shared/pages')
    if (!isValidPageSlug(pageSlug)) return false
    deps.sessionManager.enqueuePageThumbnail(workspaceId, root, pageSlug)
    return true
  })

  // ------------------------------------------------------------------
  // UA8.3 — scheduled refresh: review, approve, run now (ours; spec §15 "Scheduled refresh")
  // ------------------------------------------------------------------

  // Where the page's refresh stands against the ledger, with the script the person is asked to approve.
  server.handle(RPC_CHANNELS.pages.GET_REFRESH_STATUS, async (ctx, workspaceId: string, pageSlug: string) => {
    const root = rootFor(ctx, workspaceId)
    const { loadPageConfig } = await import('@nessy-agent/shared/pages')
    const config = loadPageConfig(root, pageSlug)
    if (!config) throw new Error(`Page not found: ${pageSlug}`)
    return readRefreshReview(root, await ledgerKey(), config)
  })

  // Record the person's approval of the refresh script they reviewed (the digest, args and runtime they were shown),
  // then poke the watcher so the page's matcher is rebuilt at once.
  server.handle(RPC_CHANNELS.pages.APPROVE_REFRESH, async (ctx, workspaceId: string, pageSlug: string, sha256?: string, binding?: unknown) => {
    const root = rootFor(ctx, workspaceId)
    const { approvePageRefresh, pageRefreshScriptPath } = await import('@nessy-agent/shared/pages')
    const approval = approvePageRefresh(root, await ledgerKey(), pageSlug, typeof sha256 === 'string' ? sha256 : undefined, reviewedRefreshBinding(binding))
    deps.sessionManager.notifyConfigFileChange(workspaceId, pageRefreshScriptPath(pageSlug))
    log.info(`Approved the refresh of page ${pageSlug}`)
    return approval
  })

  // Run an approved refresh now, through runApprovedScript (the one script entry: managed policy, ledger, verified
  // bytes, allowlisted env, audit). A refusal is answered at once; a started run finishes in the background and its
  // outcome lands on page.json (`lastRefresh`) and in automation history, as a scheduled run's does.
  server.handle(RPC_CHANNELS.pages.RUN_REFRESH_NOW, async (ctx, workspaceId: string, pageSlug: string) => {
    const root = rootFor(ctx, workspaceId)
    const { loadPageConfig, pageRefreshAction, readPageRefreshApproval, pageRefreshApprovalSubject, pageRefreshMatcherId, REFRESH_APPROVAL_KIND } =
      await import('@nessy-agent/shared/pages')
    const { runApprovedScript, buildScriptEnv, createScriptHistoryEntry, appendAutomationHistoryEntry } = await import('@nessy-agent/shared/automations')
    const { isLocalAutomationManagedDisabled, describeManagedLocalAutomationRefusal } = await import('@nessy-agent/shared/config/managed-local-automation')
    const config = loadPageConfig(root, pageSlug)
    if (!config) throw new Error(`Page not found: ${pageSlug}`)
    if (isLocalAutomationManagedDisabled()) return { started: false, error: describeManagedLocalAutomationRefusal() }
    const action = config.refresh ? pageRefreshAction({ ...config, refresh: { ...config.refresh, enabled: true } }) : null
    if (!action) return { started: false, error: `Page ${pageSlug} has no refresh script the host wrote` }
    const state = readPageRefreshApproval(root, await ledgerKey(), { ...config, refresh: { ...config.refresh!, enabled: true } }).state
    if (state !== 'approved') return { started: false, error: `The refresh script of ${pageSlug} is not approved (${state}) — approve it first` }

    const matcherId = pageRefreshMatcherId(pageSlug)
    const env = buildScriptEnv('SchedulerTick', { workspaceId, timestamp: Date.now() }, { workspaceRootPath: root, page: pageSlug })
    refreshAuditBroker ??= new PrivilegedExecutionBroker(log)
    const broker = refreshAuditBroker
    void runApprovedScript({
      action,
      workspaceRootPath: root,
      env,
      trigger: 'page-refresh',
      approval: { kind: REFRESH_APPROVAL_KIND, subject: pageRefreshApprovalSubject(pageSlug) },
      workspaceId,
      matcherId,
      audit: (event, fields) => broker.auditEvent(event, fields),
    }).then(async (result) => {
      await appendAutomationHistoryEntry(root, createScriptHistoryEntry({ matcherId, result }))
    }).catch((error: unknown) => log.warn(`Page refresh run failed to record for ${pageSlug}:`, error))
    return { started: true }
  })

  // ------------------------------------------------------------------
  // UA9.3 — grants (the host-approvals ledger) and actions (the broker)
  // ------------------------------------------------------------------

  // Every verified grant of the page, expired and stale ones included (validity is enforced at execution time).
  server.handle(RPC_CHANNELS.pages.LIST_GRANTS, async (ctx, workspaceId: string, pageSlug: string): Promise<PageActionGrant[]> => {
    const root = rootFor(ctx, workspaceId)
    const { listPageGrants, isValidPageSlug } = await import('@nessy-agent/shared/pages')
    if (!isValidPageSlug(pageSlug)) return []
    return listPageGrants(root, await ledgerKey(), pageSlug)
  })

  // Ours: the descriptor a grant dialog shows as the authority, validated by the host.
  server.handle(RPC_CHANNELS.pages.DESCRIBE_GRANT_REQUEST, async (
    ctx,
    workspaceId: string,
    pageSlug: string,
    action: unknown,
  ): Promise<PageGrantRequestDescription> => {
    const root = rootFor(ctx, workspaceId)
    const { loadPageConfig, PageActionDescriptorSchema } = await import('@nessy-agent/shared/pages')
    if (!loadPageConfig(root, pageSlug)) throw new Error(`Page not found: ${pageSlug}`)
    const parsed = PageActionDescriptorSchema.parse(action) as PageActionDescriptor
    if (parsed.kind !== 'script') return { action: parsed }
    return { action: parsed, scriptSha256: await pageScriptSha256(root, parsed.script) }
  })

  // Record a grant the person approved in the dialog (the approval UX happens in the caller).
  server.handle(RPC_CHANNELS.pages.ISSUE_GRANT, async (
    ctx,
    workspaceId: string,
    pageSlug: string,
    input: PageGrantIssueInput,
  ): Promise<PageActionGrant> => {
    const root = rootFor(ctx, workspaceId)
    const {
      loadPageConfig, loadPageContent, computePageContentDigest, issuePageGrant, PageActionDescriptorSchema, PAGE_GRANT_SCRIPT_CHANGED,
    } = await import('@nessy-agent/shared/pages')
    if (!loadPageConfig(root, pageSlug)) throw new Error(`Page not found: ${pageSlug}`)
    const action = PageActionDescriptorSchema.parse(input?.action) as PageActionDescriptor
    const content = loadPageContent(root, pageSlug)
    if (content === null) throw new Error(`Page has no content: ${pageSlug}`)
    const contentDigest = computePageContentDigest(content)
    if (input.contentDigest !== contentDigest) {
      throw new Error(`content-changed: ${pageSlug} changed since it asked; reload the page and approve again`)
    }
    let scriptSha256: string | undefined
    if (action.kind === 'script') {
      scriptSha256 = await pageScriptSha256(root, action.script)
      if (input.scriptSha256 !== scriptSha256) {
        throw new Error(`${PAGE_GRANT_SCRIPT_CHANGED}: ${action.script} changed since it was shown; review it again`)
      }
    }
    const description = typeof input.description === 'string' && input.description.length > 0
      ? input.description.slice(0, GRANT_DESCRIPTION_MAX_CHARS)
      : undefined
    const grant = issuePageGrant(root, await ledgerKey(), pageSlug, {
      id: `grant_${randomBytes(8).toString('hex')}`,
      action,
      contentDigest,
      ...(description !== undefined ? { description } : {}),
      ...(scriptSha256 !== undefined ? { scriptSha256 } : {}),
    })
    await broadcastChanged(workspaceId, root)
    const target = grant.action.kind === 'script' ? grant.action.script : grant.action.sourceSlug
    log.info(`Issued page grant ${grant.id} on ${pageSlug} (${grant.action.kind}:${target})`)
    return grant
  })

  // Revoke a grant; the next invocation under it is refused (the broker reads the ledger per invocation).
  server.handle(RPC_CHANNELS.pages.REVOKE_GRANT, async (ctx, workspaceId: string, pageSlug: string, grantId: string): Promise<boolean> => {
    const root = rootFor(ctx, workspaceId)
    const { revokePageGrant, isValidPageSlug } = await import('@nessy-agent/shared/pages')
    if (!isValidPageSlug(pageSlug) || typeof grantId !== 'string') return false
    const removed = revokePageGrant(root, await ledgerKey(), pageSlug, grantId)
    if (removed) {
      await broadcastChanged(workspaceId, root)
      log.info(`Revoked page grant ${grantId} on ${pageSlug}`)
    }
    return removed
  })

  // Execute a granted source action. The page config is re-read from disk per request, and the broker re-reads the
  // grant from the ledger, so revocations and content changes apply immediately.
  server.handle(RPC_CHANNELS.pages.EXECUTE_ACTION, async (ctx, workspaceId: string, request: PageActionRequest) => {
    const root = rootFor(ctx, workspaceId)
    const { loadPageConfig } = await import('@nessy-agent/shared/pages')
    const page = loadPageConfig(root, request?.pageSlug)
    if (!page) throw new Error(`Page not found: ${request?.pageSlug}`)
    return (await brokerFor(workspaceId, root)).executeAction(page, request)
  })

  // Cancel an in-flight action
  server.handle(RPC_CHANNELS.pages.CANCEL_ACTION, async (ctx, workspaceId: string, requestId: string): Promise<boolean> => {
    const root = rootFor(ctx, workspaceId)
    return (await brokerFor(workspaceId, root)).cancelAction(requestId)
  })

  // UA12.112 — record a refusal the RENDERER's gate decided (page-frame-gates.ts): the broker's own
  // rejection paths audit themselves, but these never reach it. Fire-and-forget for the caller; the
  // line lands in the workspace broker's trail, marked stage 'renderer-gate'.
  server.handle(RPC_CHANNELS.pages.AUDIT_REFUSAL, async (ctx, workspaceId: string, report: PageGateRefusalReport): Promise<boolean> => {
    const root = rootFor(ctx, workspaceId)
    ;(await brokerFor(workspaceId, root)).auditGateRefusal(report)
    return true
  })

  // ------------------------------------------------------------------
  // UA6.7 — publishing on t-artifacts (v0.13.4 L363–L437, rewritten; see the header). No handler is gated (spec §6):
  // the safety is the person's review of the exact bytes, the guard over the HTML and the snapshot, the
  // script-grant refusal, and the one fixed-origin client (`pages/page-publishing.ts`).
  // ------------------------------------------------------------------

  // The data scan and the review: the host card for exactly the bytes a publish with these options would send.
  server.handle(RPC_CHANNELS.pages.GET_SHARE_DATA_SCAN, async (ctx, workspaceId: string, pageSlug: string, options?: PagePublishOptions) => {
    const root = rootFor(ctx, workspaceId)
    const { reviewPagePublish } = await import('../../pages/page-publishing')
    return reviewPagePublish({ workspaceRoot: root, createClient: artifactsClient }, String(pageSlug), publishOptionsOf(options))
  })

  // Publish (create) or republish (one PUT to the page's own row) the reviewed bytes.
  server.handle(RPC_CHANNELS.pages.PUBLISH, async (
    ctx,
    workspaceId: string,
    pageSlug: string,
    options?: PagePublishOptions & { reviewedSha256?: string },
  ) => {
    const root = rootFor(ctx, workspaceId)
    // The review IS the card, so only a caller that can show a person a confirmation may publish (a window; never a
    // phone or a headless client) — the chat-share rule (`sessions/chat-share.ts`): nothing is sent otherwise.
    if (!server.hasClientCapability(ctx.clientId, CLIENT_CONFIRM_DIALOG)) {
      return { status: 'refused', note: 'Publishing a page needs its review shown in a Nessy window; nothing was sent.' }
    }
    const { publishPage } = await import('../../pages/page-publishing')
    const { formatArtifactAuditLine } = await import('../../sessions/artifact-publishing')
    const result = await publishPage({
      workspaceRoot: root,
      createClient: artifactsClient,
      audit: record => log.info(formatArtifactAuditLine(record)),
    }, String(pageSlug), { ...publishOptionsOf(options), reviewedSha256: String(options?.reviewedSha256 ?? '') })
    if (result.status === 'published' || result.status === 'updated') {
      await broadcastChanged(workspaceId, root)
      // UA12.52 — a Pages publish is also a registry row (kind `page`): the open Published pages section reloads.
      pushTyped(server, RPC_CHANNELS.artifacts.CHANGED, { to: 'workspace', workspaceId }, workspaceId)
    }
    return result
  })

  // Unpublish: one DELETE of the page's copy (a retryable failure is kept as a pending deletion, UA1.19).
  server.handle(RPC_CHANNELS.pages.UNPUBLISH, async (ctx, workspaceId: string, pageSlug: string) => {
    const root = rootFor(ctx, workspaceId)
    const { unpublishPage } = await import('../../pages/page-publishing')
    const result = await unpublishPage({ workspaceRoot: root, createClient: artifactsClient }, String(pageSlug))
    if (result.outcome !== 'not-published') await broadcastChanged(workspaceId, root)
    log.info(`Unpublish of page ${pageSlug}: ${result.outcome}${result.errorKind ? ` (${result.errorKind})` : ''}`)
    return result
  })
}

/** UA6.7 — the wire's publish options, coerced (anything but `true` is false). */
function publishOptionsOf(options: PagePublishOptions | undefined): PagePublishOptions {
  return { includeData: options?.includeData === true, viewOnlyAcknowledged: options?.viewOnlyAcknowledged === true }
}

/** What `pages:getRefreshStatus` answers: the ledger state plus the script text the person reviews. */
type PageRefreshReview = import('@nessy-agent/shared/pages').PageRefreshApproval & { content?: string; truncated?: boolean }

/** How much of a refresh script the review shows (the digest still covers every byte). */
const REFRESH_REVIEW_MAX_CHARS = 64 * 1024


/** The audit sink for run-now: the same `logs/privileged-actions.jsonl` `SessionManager`'s broker writes (UA8.1). */
let refreshAuditBroker: PrivilegedExecutionBroker | undefined

/** The host-approvals ledger key (the host's installed provider; no key → the read/write fails closed). */
async function ledgerKey(): Promise<Buffer> {
  const { getHostApprovalsKeyProvider } = await import('@nessy-agent/shared/approvals/host-approvals')
  return getHostApprovalsKeyProvider().getKey()
}

/**
 * The sha256 of a page-granted script's bytes now: workspace-relative, contained in the workspace with symlinks
 * resolved, present. The same containment `runApprovedScript` re-checks on the bytes it runs.
 */
async function pageScriptSha256(workspaceRootPath: string, script: string): Promise<string> {
  const { isPathWithinDirectory } = await import('@nessy-agent/session-tools-core')
  const { scriptSha256 } = await import('@nessy-agent/shared/automations')
  if (isAbsolute(script)) throw new Error(`Script path escapes the workspace: ${script}`)
  const path = join(workspaceRootPath, script)
  if (!existsSync(path)) throw new Error(`Script not found: ${script}`)
  if (!isPathWithinDirectory(path, workspaceRootPath)) throw new Error(`Script path escapes the workspace: ${script}`)
  return scriptSha256(readFileSync(path))
}

/** How many times the review re-reads a script that changed between its state read and its text read. */
const REFRESH_REVIEW_READ_ATTEMPTS = 3

/**
 * The refresh review `pages:getRefreshStatus` answers (UA8.3 follow-up): the digest the person approves and the text
 * they are shown come from ONE read of the bytes. The ledger state is read first (it hashes the file itself), then
 * the bytes once; the review is answered only when those bytes hash to the state's digest, so the text on screen is
 * always the bytes `sha256` names — never text A beside sha256(B) after a swap between two reads. A script that keeps
 * changing is refused after {@link REFRESH_REVIEW_READ_ATTEMPTS} reads rather than reviewed. `readBytes` is the test
 * seam for a file swapped between the reads.
 */
export async function readRefreshReview(
  root: string,
  key: Buffer,
  config: import('@nessy-agent/shared/pages').PageConfig,
  readBytes: (path: string) => Buffer = readFileSync,
): Promise<PageRefreshReview> {
  const { readPageRefreshApproval } = await import('@nessy-agent/shared/pages')
  const { scriptSha256 } = await import('@nessy-agent/shared/automations')
  for (let attempt = 0; attempt < REFRESH_REVIEW_READ_ATTEMPTS; attempt += 1) {
    const status: PageRefreshReview = readPageRefreshApproval(root, key, config)
    if (!status.sha256 || !status.script) return status
    const bytes = readBytes(join(root, status.script))
    if (scriptSha256(bytes) !== status.sha256) continue
    const content = bytes.toString('utf-8')
    status.content = content.length > REFRESH_REVIEW_MAX_CHARS ? content.slice(0, REFRESH_REVIEW_MAX_CHARS) : content
    if (content.length > REFRESH_REVIEW_MAX_CHARS) status.truncated = true
    return status
  }
  throw new Error(`The refresh script of ${config.slug} kept changing while it was being read; review it again once it is still`)
}

/**
 * The args and runtime a `pages:approveRefresh` caller says it showed (UA8.3 follow-up 2). Absent → no binding check
 * (the digest check alone, as before); present but malformed → refused, never read as "absent".
 */
function reviewedRefreshBinding(binding: unknown): { args?: string[]; runtime?: string } | undefined {
  if (binding === undefined || binding === null) return undefined
  const value = binding as { args?: unknown; runtime?: unknown }
  const argsOk = value.args === undefined || (Array.isArray(value.args) && value.args.every(arg => typeof arg === 'string'))
  if (typeof binding !== 'object' || !argsOk || (value.runtime !== undefined && typeof value.runtime !== 'string')) {
    throw new Error('Invalid refresh review binding: expected { args?: string[], runtime?: string }')
  }
  return { args: value.args as string[] | undefined, runtime: value.runtime as string | undefined }
}
