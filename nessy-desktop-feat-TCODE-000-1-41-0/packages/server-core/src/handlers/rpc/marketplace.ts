import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { chmod, link, lstat, mkdir, open, rm, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'
import {
  collectRelevanceManifests,
  MarketplaceProposalError,
  MarketplaceProposalRegistry,
  MarketplaceService,
  matchRelevanceSignal,
  normalizeRepositoryDisplaySource,
  resolveMarketplaceListingItem,
  SAFE_MARKETPLACE_ID,
  type MarketplaceCatalogItem,
  type MarketplaceListResult,
  type MarketplaceRegistryController,
  type MarketplaceRegistryLoadError,
  type RelevanceManifestFile,
} from '@nessy-agent/shared/marketplace'
import type {
  PluginActivationTarget,
  PluginCompatibilityReport,
  PluginInstallSource,
  PluginManagementInstallResult,
} from '@nessy-agent/shared/plugins'
import {
  hasRootMcpbManifest,
  isPluginMutationCommittedError,
  listRepositoryTags,
  MAX_MCPB_ARCHIVE_BYTES,
  pluginDeclaredComponentKindsFrom,
  probePluginManifestComponentKinds,
  toSafePluginPresentationForCatalogListing,
} from '@nessy-agent/shared/plugins'
import {
  isSafeMarketplaceDeclaredComponentsRequest,
  isSafeMarketplaceAddRegistryRequest,
  isSafeMarketplaceEnableOfferRequest,
  isSafeMarketplacePluginInstallRequest,
  isSafeMarketplaceListRequest,
  isSafeMarketplacePluginProposalRequest,
  isSafeMarketplaceRegistryRef,
  isSafeMarketplaceSetRegistryAutoUpdateRequest,
  isSafeMarketplaceSkillContentRequest,
  RPC_CHANNELS,
  type SafeMarketplaceAddRegistryRequest,
  type SafeMarketplaceAddRegistryResult,
  type SafeMarketplaceEnableOfferRequest,
  type SafeMarketplaceCatalogItem,
  type SafeMarketplaceDeclaredComponents,
  type SafeMarketplaceIcon,
  type SafeMarketplaceListRequest,
  type SafeMarketplaceListResult,
  type SafeMarketplacePluginDeferredCapability,
  type SafeMarketplacePluginInstallProposal,
  type SafeMarketplacePluginInstallRequest,
  type SafeMarketplacePluginInstallResult,
  type SafeMarketplacePluginProposalRequest,
  type SafeMarketplaceRegistryListResult,
  type SafeMarketplaceRegistryLoadError,
  type SafeMarketplaceRegistryRef,
  type SafeMarketplaceRemoveRegistryResult,
  type SafeMarketplaceSetRegistryAutoUpdateResult,
  type SafeMarketplaceUpgradeRegistryResult,
  type SafePluginActivationTarget,
  type SafePluginRuntimeRefreshResult,
} from '@nessy-agent/shared/protocol'
import type { ProjectKey } from '@nessy-agent/shared/projects/project-identity'
import {
  requestClientMcpbProposal,
  type RequestContext,
  type RpcServer,
} from '@nessy-agent/server-core/transport'
import { outputStyleProjectRootFor } from '@nessy-agent/shared/prompts/output-styles'
import { resolveEnforcedManagedPolicy } from '../../bootstrap/managed-policy-resolution'
import { resolveCapabilityContext } from '../../domain/capabilities/context'
import type { HandlerDeps } from '../handler-deps'
import {
  afterPluginMutation,
  describeRuntimeRefreshVerdict,
  type PluginMutationRefreshVerdict,
} from './plugin-runtime-refresh'
import { setTransferableHandler } from './transfer'

export const HANDLED_CHANNELS = [
  RPC_CHANNELS.marketplace.LIST,
  RPC_CHANNELS.marketplace.CONTENT,
  RPC_CHANNELS.marketplace.COMPONENTS,
  RPC_CHANNELS.marketplace.PROPOSE_INSTALL,
  RPC_CHANNELS.marketplace.PROPOSE_MCPB,
  RPC_CHANNELS.marketplace.INSTALL,
  RPC_CHANNELS.marketplace.ADD_REGISTRY,
  RPC_CHANNELS.marketplace.UPGRADE_REGISTRY,
  RPC_CHANNELS.marketplace.REMOVE_REGISTRY,
  RPC_CHANNELS.marketplace.LIST_REGISTRIES,
  RPC_CHANNELS.marketplace.SET_REGISTRY_AUTO_UPDATE,
  RPC_CHANNELS.marketplace.ENABLE_OFFER,
  RPC_CHANNELS.marketplace.REFRESH_RUNTIME,
] as const

export interface MarketplaceHandlerOptions {
  createService?: (context: Record<string, never>) => MarketplaceHandlerService
  /** Server-only opaque proposal registry (per-server singleton). */
  proposalRegistry?: MarketplaceProposalRegistry
}

export type MarketplaceHandlerService = Pick<
  MarketplaceService,
  'list' | 'skillContent' | 'inspect' | 'proposeInstall' | 'install'
>

export function registerMarketplaceHandlers(
  server: RpcServer,
  deps: HandlerDeps,
  options: MarketplaceHandlerOptions = {},
): void {
  const log = deps.platform.logger

  const createService = (): MarketplaceHandlerService => (
    options.createService?.({}) ?? new MarketplaceService({
      ...(deps.pluginManagement ? { pluginService: deps.pluginManagement } : {}),
      // R3: inject the bring-your-own registry source so registry catalog items
      // merge into `plugins` lists. Absent (no registries configured / headless
      // without the runtime) → the merge stays dormant, exactly as before.
      ...(deps.marketplaceRegistrySource ? { registrySource: deps.marketplaceRegistrySource } : {}),
      // `plugins/host-marketplace.md#run-release-channels` — the tag listing the dependency step
      // resolves a version constraint against. Same wiring as the storage
      // runtime's own service so a UI install and a tool-driven install cannot
      // resolve a `~2.1.0` two different ways.
      listRepositoryTags: repositoryUrl => listRepositoryTags(repositoryUrl),
    })
  )

  // R3 registry mutations run against the injected controller. The built-in
  // Skills Market is not a bring-your-own registry, so it can never be removed.
  const requireRegistrySource = (): MarketplaceRegistryController => {
    if (deps.marketplaceRegistrySource) return deps.marketplaceRegistrySource
    throw new Error('Marketplace registries are unavailable before storage readiness.')
  }

  // Server-only, content-pinned, single-use, expiring, client-bound registry.
  const proposalRegistry = options.proposalRegistry ?? new MarketplaceProposalRegistry()

  // Resolve a catalog-listing install target. Built-in Skills Market rows keep
  // the detail lookup over the HTTP client (unchanged). Bring-your-own registry
  // rows carry a durable `structuredInstallSource` in the registry source's
  // cached catalog — resolve it from there so install NEVER hits the Skills
  // Market client, whose ids differ (a registry id `<registryId>:<name>` 404s).
  const resolveListingItem = async (
    source: Extract<SafeMarketplacePluginInstallRequest['source'], { kind: 'listing' }>,
    service: MarketplaceHandlerService,
  ): Promise<MarketplaceCatalogItem> => {
    // Shared with the agent's `plugin_plan_install` since D2 — one resolver, so
    // the two channels cannot drift on which catalog owns a listing id.
    const item = await resolveMarketplaceListingItem(
      { itemId: source.listingId, kind: source.listingKind, marketplaceId: source.marketplaceId },
      {
        inspect: request => service.inspect(request),
        // Resolved LAZILY: `requireRegistrySource()` throws before storage
        // readiness, and a Skills Market listing must not need a registry at all.
        catalogReader: {
          peekCachedItems: () => requireRegistrySource().peekCachedItems(),
          findCatalogItem: (marketplaceId, itemId) => requireRegistrySource().findCatalogItem(marketplaceId, itemId),
        },
        // P6.421 — `plugins/install.md#install-a-plugin`: a NAMED install
        // refreshes that marketplace before the lookup, so a plugin published
        // since the last refresh installs without a manual refresh. The
        // primitive already existed and only the scheduled auto-update pass
        // called it; `refreshForInstall` applies the page's skip list (30-second
        // window, non-Git registry, `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`)
        // and is deliberately NOT gated on the auto-update flag.
        refreshMarketplace: marketplaceId => requireRegistrySource().refreshForInstall({ marketplaceId }),
      },
    )
    if (!item) {
      // A6: the old text advised "refresh the marketplace and try again" — the
      // remedy that, until A4 stamped `lastUpgradedAt` after the fetch, was
      // itself the cause (a 34.97 s window in which every lookup missed). It
      // also hid the id SHAPE a registry listing actually has
      // (`<registryId>:<pluginName>`), which is what makes a bare-name id
      // indistinguishable from a genuinely absent row. Name both halves.
      throw new Error(
        `Marketplace listing "${source.listingId}" is not in the catalog of marketplace `
        + `"${source.marketplaceId}". Registry listing ids are "<marketplaceId>:<name>"; `
        + `if this id has no prefix it did not come from that catalog.`,
      )
    }
    return item
  }

  server.handle(RPC_CHANNELS.marketplace.LIST, async (ctx, unsafeRequest: unknown): Promise<SafeMarketplaceListResult> => {
    if (!isSafeMarketplaceListRequest(unsafeRequest)) {
      throw new TypeError('Invalid marketplace list request')
    }
    const request: SafeMarketplaceListRequest = unsafeRequest
    log?.info(`MARKETPLACE_LIST: ${request.kind} ${request.query || '<empty>'}`)
    const result = await createService().list(request)
    const suggestions = await resolveSuggestionContext(ctx, request, deps)
    return toSafeMarketplaceListResult(
      result,
      await withRelevanceManifests(result, suggestions),
      managedPluginTrustMessage(),
    )
  })

  // Raw SKILL.md body for one market skill (path-free id in, markdown text out).
  // The service fails soft to `null`, so the renderer can fall back to the short
  // description without an error surface.
  server.handle(RPC_CHANNELS.marketplace.CONTENT, async (_ctx, unsafeRequest: unknown): Promise<string | null> => {
    if (!isSafeMarketplaceSkillContentRequest(unsafeRequest)) {
      throw new TypeError('Invalid marketplace content request')
    }
    return createService().skillContent(unsafeRequest.id)
  })

  // What ONE listing declares it contains, for a detail page that opened before
  // install (D3). Two sources, cheapest first:
  //
  //  1. the row the browse list already has — a Codex registry's per-plugin
  //     manifests were read during the catalog's own staged scan, and a Claude
  //     entry may declare components inline (12 of the 276 official entries
  //     carry `lspServers`, and their plugin directories have no manifest at
  //     all, so this is their ONLY source);
  //  2. failing that, ONE GET of that plugin's own manifest at the entry's
  //     pinned sha (`plugin-manifest-probe.ts`).
  //
  // `known: false` is returned for everything else — no registry, no row, no
  // addressable manifest, network refused. It renders as "the listing does not
  // say", never as "ships no components": `plugins-reference.md` § Plugin
  // manifest schema, "The manifest is optional. If omitted, Claude Code
  // auto-discovers components in default locations."
  server.handle(RPC_CHANNELS.marketplace.COMPONENTS, async (
    _ctx,
    unsafeRequest: unknown,
  ): Promise<SafeMarketplaceDeclaredComponents> => {
    if (!isSafeMarketplaceDeclaredComponentsRequest(unsafeRequest)) {
      throw new TypeError('Invalid marketplace components request')
    }
    const unknown: SafeMarketplaceDeclaredComponents = { known: false, kinds: [] }
    if (unsafeRequest.marketplaceId === SAFE_MARKETPLACE_ID) return unknown
    const registrySource = deps.marketplaceRegistrySource
    if (!registrySource) return unknown

    const item = await registrySource.findCatalogItem(
      unsafeRequest.marketplaceId,
      unsafeRequest.listingId,
    )
    if (!item) return unknown

    const fromListing = pluginDeclaredComponentKindsFrom(item.capabilities)
    if (fromListing.length) return { known: true, kinds: fromListing }

    const probed = await probePluginManifestComponentKinds(item.structuredInstallSource)
    return probed?.length ? { known: true, kinds: probed } : unknown
  })

  server.handle(RPC_CHANNELS.marketplace.PROPOSE_INSTALL, async (
    ctx,
    request: SafeMarketplacePluginProposalRequest,
  ): Promise<SafeMarketplacePluginInstallProposal> => {
    if (!isSafeMarketplacePluginProposalRequest(request)) {
      throw new TypeError('Invalid marketplace proposal request')
    }
    const raw = await createService().proposeInstall({
      url: request.sourceUrl,
      ...(request.ref ? { ref: request.ref } : {}),
      ...(request.subdirectory ? { subdirectory: request.subdirectory } : {}),
    })
    const displaySource = normalizeRepositoryDisplaySource(raw.sourceUrl, raw.repositoryUrl)
    const diagnosticCodes = raw.diagnostics.map(diagnostic => diagnostic.code)
    if (raw.status !== 'installable' || !raw.source) {
      return { status: 'unsupported', displaySource, diagnosticCodes }
    }
    return proposalRegistry.issue({
      clientId: ctx.clientId,
      source: raw.source,
      displaySource,
      detectedFormat: raw.detectedFormat,
      diagnosticCodes,
    })
  })

  server.handle(RPC_CHANNELS.marketplace.PROPOSE_MCPB, async (
    ctx,
  ): Promise<SafeMarketplacePluginInstallProposal | null> => {
    try {
      return sanitizeMcpbProposal(
        await requestClientMcpbProposal(server, ctx.clientId),
        proposalRegistry,
      )
    } catch {
      log?.warn('MCPB_IMPORT_REJECTED')
      return unsupportedMcpbProposal()
    }
  })

  setTransferableHandler(
    RPC_CHANNELS.marketplace.UPLOAD_MCPB,
    async (ctx, archive: unknown): Promise<SafeMarketplacePluginInstallProposal> => {
      const rootDirectory = deps.pluginStore?.rootDirectory
      if (!Buffer.isBuffer(archive) || !rootDirectory) return unsupportedMcpbProposal()
      try {
        const snapshotPath = await snapshotMcpbArchive(archive, rootDirectory)
        return proposalRegistry.issue({
          clientId: ctx.clientId,
          source: { kind: 'local-path', path: snapshotPath },
          displaySource: 'MCPB extension',
          detectedFormat: 'mcpb',
        })
      } catch {
        log?.warn('MCPB_IMPORT_REJECTED')
        return unsupportedMcpbProposal()
      }
    },
    { payloadEncoding: 'binary', maxBytes: MAX_MCPB_ARCHIVE_BYTES },
  )

  server.handle(
    RPC_CHANNELS.marketplace.INSTALL,
    async (ctx, request: SafeMarketplacePluginInstallRequest): Promise<SafeMarketplacePluginInstallResult> => {
      if (!isSafeMarketplacePluginInstallRequest(request)) {
        throw new TypeError('Invalid marketplace install request')
      }
      const enrichment = await safeInstallEnrichment(ctx, deps, request.activateIn)
      const service = createService()
      let result: PluginManagementInstallResult
      try {
        if (request.source.kind === 'proposal') {
          const source = proposalRegistry.consume(ctx.clientId, request.source.proposalId).source
          await assertManagedMcpbSnapshotUnchanged(source, deps.pluginStore?.rootDirectory)
          result = await service.install({
            ...(enrichment.activateIn ? { activateIn: enrichment.activateIn } : {}),
            source,
          })
        } else {
          result = await service.install({
            ...(enrichment.activateIn ? { activateIn: enrichment.activateIn } : {}),
            item: await resolveListingItem(request.source, service),
          })
        }
      } catch (error) {
        if (isPluginMutationCommittedError(error)) {
          await afterPluginMutation(server, deps, { ...(ctx.workspaceId ? { answerForWorkspaceId: ctx.workspaceId } : {}), // F1.484
            ...(enrichment.workspaceId ? { workspaceId: enrichment.workspaceId } : {}),
            ...(enrichment.projectKey ? { projectKey: enrichment.projectKey } : {}),
          }, 'marketplace install', error.effect)
        }
        throw error
      }
      // Failed/blocked installs commit no active plugin state. Avoid a false
      // capability invalidation and a potentially expensive runtime drain for
      // an operation that changed nothing.
      // P2.107 — the refresh's own verdict travels back with the result, so the
      // install summary can say "Plugin is now active" from what the server DID
      // rather than from a renderer-side re-derivation of the gate it read.
      // `undefined` (the refresh failed soft, or never ran because the install
      // failed) stays absent on the wire and the client falls back to
      // needs-refresh.
      let runtimeRefresh: PluginMutationRefreshVerdict
      if (result.ok) {
        runtimeRefresh = await afterPluginMutation(server, deps, { ...(ctx.workspaceId ? { answerForWorkspaceId: ctx.workspaceId } : {}), // F1.484
          ...(enrichment.workspaceId ? { workspaceId: enrichment.workspaceId } : {}),
          ...(enrichment.projectKey ? { projectKey: enrichment.projectKey } : {}),
        }, 'marketplace install')
      }
      // T2 (plugin-install plan): the service reports EVERY connector source
      // still awaiting auth. Only the ON_INSTALL subset stays on `authRequests`
      // — the renderer chains `performOAuth` over that field, and § 0b-2
      // (Claude's no-chaining model) forbids install-time OAuth for
      // ON_FIRST_USE connectors. The full list crosses as `pendingAuth`,
      // informational only.
      const pending = result.authRequests ?? []
      const onInstall = pending.filter(request => request.timing !== 'ON_FIRST_USE')
      return {
        ok: result.ok,
        ...(result.installed ? { pluginKey: result.installed.pluginKey } : {}),
        diagnosticCodes: result.diagnostics.map(diagnostic => diagnostic.code),
        // Compatibility detail is path-free: only external kind + reason code
        // crosses the boundary.
        ...(result.compatibility ? { state: result.compatibility.state } : {}),
        ...(result.requiresConfirmation ? { requiresConfirmation: true } : {}),
        ...(result.compatibility ? { deferred: toSafeDeferredCapabilities(result.compatibility) } : {}),
        // P2.155 — the persisted adapter warnings cross as CODES, on success as
        // well as on failure. They are informational by design (the drop had no
        // runtime effect), so they never touch `state` or `requiresConfirmation`.
        ...(result.installed?.adapterWarnings?.length
          ? { adapterWarnings: result.installed.adapterWarnings }
          : {}),
        ...(runtimeRefresh ? { runtimeRefresh } : {}),
        ...(onInstall.length ? {
          authRequests: onInstall.map(request => ({
            workspaceId: request.workspaceId,
            sourceSlug: request.sourceSlug,
          })),
        } : {}),
        ...(pending.length ? { pendingAuth: pending } : {}),
        ...(result.installed?.authRequirements?.length ? { authRequirements: result.installed.authRequirements } : {}),
        ...(result.installed?.configuration ? { configuration: result.installed.configuration } : {}),
      }
    },
  )

  // R3 — bring-your-own registry mutations. The server does the clone (NO
  // renderer-side fetch): add stages via the R1 governed staging seam; the Safe
  // I/O is path-free (no installedRoot/catalogRoot ever crosses).

  server.handle(
    RPC_CHANNELS.marketplace.ADD_REGISTRY,
    async (_ctx, request: SafeMarketplaceAddRegistryRequest): Promise<SafeMarketplaceAddRegistryResult> => {
      if (!isSafeMarketplaceAddRegistryRequest(request)) {
        throw new TypeError('Invalid marketplace add-registry request')
      }
      const result = await requireRegistrySource().add({
        source: request.source,
        ...(request.refName ? { refName: request.refName } : {}),
        ...(request.sparsePaths ? { sparsePaths: request.sparsePaths } : {}),
      })
      // Drop `installedRoot` — the absolute clone path stays server-side.
      return {
        marketplaceId: result.marketplaceId,
        displayName: result.displayName,
        alreadyAdded: result.alreadyAdded,
      }
    },
  )

  server.handle(
    RPC_CHANNELS.marketplace.UPGRADE_REGISTRY,
    async (_ctx, request: SafeMarketplaceRegistryRef): Promise<SafeMarketplaceUpgradeRegistryResult> => {
      if (!isSafeMarketplaceRegistryRef(request)) {
        throw new TypeError('Invalid marketplace upgrade-registry request')
      }
      const result = await requireRegistrySource().upgrade({ marketplaceId: request.marketplaceId })
      // `reason` crosses the boundary (a fixed server-chosen enum — never a
      // message, path or source string) so the user is told WHY an upgrade did
      // not happen instead of being shown the opaque registry id. The richer
      // `diagnosticCodes` deliberately stay server-side: they name internal
      // subsystems and the log already carries them.
      return {
        marketplaceId: result.marketplaceId,
        upgraded: result.upgraded,
        ...(result.reason ? { reason: result.reason } : {}),
      }
    },
  )

  server.handle(
    RPC_CHANNELS.marketplace.REMOVE_REGISTRY,
    async (_ctx, request: SafeMarketplaceRegistryRef): Promise<SafeMarketplaceRemoveRegistryResult> => {
      if (!isSafeMarketplaceRegistryRef(request)) {
        throw new TypeError('Invalid marketplace remove-registry request')
      }
      // The built-in Skills Market is not a bring-your-own registry — never removable.
      if (request.marketplaceId === SAFE_MARKETPLACE_ID) {
        throw new Error('The built-in Skills Market cannot be removed.')
      }
      const result = await requireRegistrySource().remove({ marketplaceId: request.marketplaceId })
      return { marketplaceId: result.marketplaceId, removed: result.removed }
    },
  )

  server.handle(
    RPC_CHANNELS.marketplace.LIST_REGISTRIES,
    async (): Promise<SafeMarketplaceRegistryListResult> => {
      const result = await requireRegistrySource().list()
      // Path-free rows only: id + display label + optional ref + the resolved
      // auto-update state; NO source path.
      return {
        registries: result.registries.map(registry => ({
          marketplaceId: registry.marketplaceId,
          displayName: registry.displayName,
          ...(registry.refName ? { refName: registry.refName } : {}),
          autoUpdate: registry.autoUpdate,
          ...(registry.autoUpdateManaged ? { autoUpdateManaged: true } : {}),
        })),
        // P6.517 / P6.518 — the built-in catalogs delivered but still OFF. The
        // registry source has already withheld any the administrator's
        // allowlist or blocklist would refuse, so every row here is a click the
        // server will accept. Omitted when empty: an older renderer, and a
        // machine where both are already on, see exactly the old payload.
        ...(result.available.length
          ? {
            available: result.available.map(offer => ({
              name: offer.name,
              source: offer.source,
              description: offer.description,
            })),
          }
          : {}),
      }
    },
  )

  // `plugins/install.md#turn-auto-update-on-or-off-for-a-marketplace` — the per-marketplace Enable/Disable auto-update
  // control. The server owns the precedence: a marketplace whose value the
  // managed policy fixed refuses the write rather than accepting one the
  // resolver would then ignore.
  server.handle(
    RPC_CHANNELS.marketplace.SET_REGISTRY_AUTO_UPDATE,
    async (_ctx, request: unknown): Promise<SafeMarketplaceSetRegistryAutoUpdateResult> => {
      if (!isSafeMarketplaceSetRegistryAutoUpdateRequest(request)) {
        throw new TypeError('Invalid marketplace set-registry-auto-update request')
      }
      if (request.marketplaceId === SAFE_MARKETPLACE_ID) {
        throw new Error('The built-in Skills Market has no auto-update setting.')
      }
      const result = await requireRegistrySource().setAutoUpdate({
        marketplaceId: request.marketplaceId,
        autoUpdate: request.autoUpdate,
      })
      return { marketplaceId: result.marketplaceId, autoUpdate: result.autoUpdate }
    },
  )

  /**
   * P6.517 / P6.518 — one click turns a delivered offer on.
   *
   * The request carries the NAME and nothing else, and the source is read from
   * the pinned catalog inside `enableBuiltInMarketplace`. That is the whole
   * security property: this is not `addRegistry` with a preset argument, and a
   * renderer (or anything that reaches this channel) cannot point it somewhere
   * else. Enabling REGISTERS and stages nothing — the catalog fetch is lazy, on
   * first browse.
   */
  server.handle(
    RPC_CHANNELS.marketplace.ENABLE_OFFER,
    async (_ctx, request: unknown): Promise<SafeMarketplaceAddRegistryResult> => {
      if (!isSafeMarketplaceEnableOfferRequest(request)) {
        throw new TypeError('Invalid marketplace enable-offer request')
      }
      const enable: SafeMarketplaceEnableOfferRequest = request
      const result = await requireRegistrySource().enableBuiltInMarketplace({ name: enable.name })
      // Same projection as ADD_REGISTRY: `installedRoot` stays server-side.
      return {
        marketplaceId: result.marketplaceId,
        displayName: result.displayName,
        alreadyAdded: result.alreadyAdded,
      }
    },
  )

  /**
   * P6.563 — the Plugins page's Refresh-runtime button, given the server it
   * never had. `SessionManager.refreshPluginRuntime` existed with exactly one
   * caller (`afterPluginMutation`, inside the install/manage RPCs) and no
   * renderer route, so the button invalidated react-query caches and told the
   * user the runtime had been refreshed when nothing had been torn down.
   *
   * Deliberately NOT `afterPluginMutation`: nothing was mutated here. Emitting
   * a capability invalidation would announce a change that did not happen and
   * would revoke live snapshots for a read-only user action.
   *
   * The workspace is optional for the same reason it is optional on the manager
   * method — absent means every live session, which is what a global refresh
   * from a workspace-less window has to mean.
   */
  server.handle(
    RPC_CHANNELS.marketplace.REFRESH_RUNTIME,
    async (_ctx, request: unknown): Promise<SafePluginRuntimeRefreshResult> => {
      const workspaceId = readOptionalWorkspaceId(request)
      const summary = await deps.sessionManager.refreshPluginRuntime(
        workspaceId,
        undefined,
        'plugins page refresh-runtime',
      )
      return { verdict: describeRuntimeRefreshVerdict(summary) }
    },
  )

}

/**
 * P6.563 — the only field the refresh request carries. Rejects anything else
 * rather than coercing: a caller that meant to scope the refresh and misspelled
 * the field would otherwise silently refresh every workspace's sessions.
 */
function readOptionalWorkspaceId(request: unknown): string | undefined {
  if (request === undefined || request === null) return undefined
  if (typeof request !== 'object') throw new TypeError('Invalid marketplace refresh-runtime request')
  const { workspaceId, ...rest } = request as { workspaceId?: unknown }
  if (Object.keys(rest).length > 0) throw new TypeError('Invalid marketplace refresh-runtime request')
  if (workspaceId === undefined || workspaceId === null) return undefined
  if (typeof workspaceId !== 'string' || workspaceId.length === 0) {
    throw new TypeError('Invalid marketplace refresh-runtime request')
  }
  return workspaceId
}

const MCPB_IMPORT_DIAGNOSTIC = 'marketplace.mcpb.invalid_archive'

function sanitizeMcpbProposal(
  value: unknown,
  registry: MarketplaceProposalRegistry,
): SafeMarketplacePluginInstallProposal | null {
  if (value === null) return null
  if (!value || typeof value !== 'object') throw new TypeError(MCPB_IMPORT_DIAGNOSTIC)
  const proposal = value as Partial<SafeMarketplacePluginInstallProposal>
  if (proposal.status === 'unsupported') return unsupportedMcpbProposal()
  if (proposal.status !== 'installable'
    || typeof proposal.proposalId !== 'string'
    || registry.contentHashFor(proposal.proposalId) === undefined
    || proposal.displaySource !== 'MCPB extension'
    || proposal.detectedFormat !== 'mcpb'
    || !Number.isSafeInteger(proposal.expiresAt)
    || !Array.isArray(proposal.diagnosticCodes)
    || proposal.diagnosticCodes.some(code => typeof code !== 'string')) {
    throw new TypeError(MCPB_IMPORT_DIAGNOSTIC)
  }
  return proposal as SafeMarketplacePluginInstallProposal
}

function unsupportedMcpbProposal(): Extract<SafeMarketplacePluginInstallProposal, { status: 'unsupported' }> {
  return {
    status: 'unsupported',
    displaySource: 'MCPB extension',
    diagnosticCodes: [MCPB_IMPORT_DIAGNOSTIC],
  }
}

async function snapshotMcpbArchive(
  archive: Buffer,
  pluginRoot: string,
): Promise<string> {
  if (archive.length < 1 || archive.length > MAX_MCPB_ARCHIVE_BYTES) {
    throw new Error(MCPB_IMPORT_DIAGNOSTIC)
  }

  const importsDirectory = join(pluginRoot, 'imports')
  await mkdir(importsDirectory, { recursive: true, mode: 0o700 })
  if (!(await lstat(importsDirectory)).isDirectory()) {
    throw new Error(MCPB_IMPORT_DIAGNOSTIC)
  }
  const temporaryPath = join(importsDirectory, `.${randomUUID()}.mcpb`)

  try {
    await writeFile(temporaryPath, archive, { flag: 'wx', mode: 0o600 })
    if (!await hasRootMcpbManifest(temporaryPath)) {
      throw new Error(MCPB_IMPORT_DIAGNOSTIC)
    }
    const digest = createHash('sha256').update(archive).digest('hex')
    const snapshotPath = join(importsDirectory, `${digest}.mcpb`)
    try {
      await link(temporaryPath, snapshotPath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST'
        || await sha256File(snapshotPath) !== digest) throw error
    }
    await chmod(snapshotPath, 0o600)
    return snapshotPath
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined)
  }
}

async function assertManagedMcpbSnapshotUnchanged(
  source: PluginInstallSource,
  pluginRoot: string | undefined,
): Promise<void> {
  if (!pluginRoot || source.kind !== 'local-path') return
  const importsDirectory = join(pluginRoot, 'imports')
  const candidate = relative(importsDirectory, source.path)
  if (!candidate || isAbsolute(candidate) || candidate.startsWith(`..${sep}`) || candidate.includes(sep)) return
  const match = /^([a-f0-9]{64})\.mcpb$/.exec(candidate)
  if (!match) return
  try {
    if (await sha256File(source.path) === match[1]) return
  } catch {
    // Fail closed without returning a filesystem path in the RPC diagnostic.
  }
  throw new MarketplaceProposalError('content-changed')
}

async function sha256File(path: string): Promise<string> {
  const metadata = await lstat(path)
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error(MCPB_IMPORT_DIAGNOSTIC)
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  const hash = createHash('sha256')
  try {
    const opened = await handle.stat()
    if (!opened.isFile() || opened.size !== metadata.size) throw new Error(MCPB_IMPORT_DIAGNOSTIC)
    for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk as Buffer)
    return hash.digest('hex')
  } finally {
    await handle.close()
  }
}

async function safeInstallEnrichment(
  ctx: RequestContext,
  deps: HandlerDeps,
  activateIn?: SafePluginActivationTarget,
): Promise<{
  activateIn?: PluginActivationTarget
  workspaceId?: string
  projectKey?: ProjectKey
}> {
  if (activateIn?.kind === 'global') return { activateIn: { kind: 'global' } }

  const workspaceId = activateIn?.kind === 'workspace'
    ? activateIn.workspaceId
    : activateIn?.kind === 'project'
      ? activateIn.context.workspaceId
      : ctx.workspaceId ?? undefined
  if (!workspaceId) return { activateIn: { kind: 'global' } }
  if (ctx.workspaceId !== workspaceId) {
    throw new Error('Marketplace activation workspace does not match the caller workspace')
  }

  if (activateIn?.kind === 'project') {
    const handleService = deps.sessionManager.getProjectHandleService?.()
    if (!handleService) throw new Error('Project handle service is unavailable')
    const resolved = await resolveCapabilityContext(activateIn.context, {
      handleService,
      resolveSessionWorkingDirectory: (candidateWorkspaceId, sessionId) => (
        deps.sessionManager.getWorkingDirectory(sessionId, candidateWorkspaceId) ?? undefined
      ),
    })
    if (!resolved.projectRoot || !resolved.projectKey) {
      throw new Error('Project activation context has no bound project')
    }
    return {
      workspaceId,
      projectKey: resolved.projectKey,
      activateIn: { kind: 'project', workspaceId, projectKey: resolved.projectKey },
    }
  }
  return {
    workspaceId,
    activateIn: { kind: 'workspace', workspaceId },
  }
}


/**
 * `settings-reference.md#pluginsuggestionmarketplaces` + `plugins/org.md#recommend-plugins`
 * — what one browse list needs to decide a suggestion pin. The name-AND-source
 * condition is the page's own: "A name takes effect only when the marketplace is
 * registered on the machine and its registered source is also declared in the
 * same managed settings, either as the `extraKnownMarketplaces` entry for that
 * name or as an entry of `strictKnownMarketplaces`."
 *
 * Server-only: `workingDirectory` and `repositoryRoot` are absolute paths and
 * NEVER cross the boundary; only the matched signal does.
 */
interface MarketplaceSuggestionContext {
  /** Registry ids the managed allowlist admits, name AND source. */
  allowed: ReadonlySet<string>
  workingDirectory: string
  repositoryRoot?: string
  /**
   * P6.519 — the project manifests `manifestDeps` is matched against. Read
   * once per LIST rather than once per row, and only when some admitted row
   * asks for one.
   */
  manifests?: readonly RelevanceManifestFile[]
}

/**
 * P6.519 — read only the manifests some admitted row's own `file` pattern asks
 * for, and only when a suggestion pass is happening at all.
 *
 * The read is bounded inside `collectRelevanceManifests` (two directories,
 * non-recursive, at most ten files, a byte gate before opening) and never
 * throws: an unreadable project yields no manifests, which yields no match,
 * which is the same answer as no `manifestDeps` block.
 */
async function withRelevanceManifests(
  result: MarketplaceListResult,
  suggestions: MarketplaceSuggestionContext | undefined,
): Promise<MarketplaceSuggestionContext | undefined> {
  if (!suggestions) return undefined
  const blocks = result.items
    .filter(item => item.marketplaceRegistryId && suggestions.allowed.has(item.marketplaceRegistryId))
    .map(item => item.relevance)
  const manifests = await collectRelevanceManifests(blocks, {
    workingDirectory: suggestions.workingDirectory,
    ...(suggestions.repositoryRoot ? { repositoryRoot: suggestions.repositoryRoot } : {}),
  })
  return manifests.length ? { ...suggestions, manifests } : suggestions
}

/**
 * Resolve that context, or undefined when there is nothing to decide.
 *
 * Two gates, both required. The row's marketplace must be admitted by
 * `pluginSuggestionMarketplaces` INCLUDING its source-correspondence half
 * (`isSuggestionAllowed`, which lives in the registry source because that is the
 * only place the registered rows, `extraKnownMarketplaces` and
 * `strictKnownMarketplaces` are all in scope at once); and the row's own
 * `relevance.cwd` must match. With no allowlist, no session or no `relevance`
 * the list is byte-identical to what it was before this existed.
 */
async function resolveSuggestionContext(
  ctx: RequestContext,
  request: SafeMarketplaceListRequest,
  deps: HandlerDeps,
): Promise<MarketplaceSuggestionContext | undefined> {
  const registrySource = deps.marketplaceRegistrySource
  if (!registrySource || !request.sessionId || !ctx.workspaceId) return undefined
  let allowed: Set<string>
  try {
    allowed = new Set(await registrySource.listSuggestionAllowedRegistryIds())
  } catch {
    return undefined
  }
  if (allowed.size === 0) return undefined
  const workingDirectory = deps.sessionManager.getWorkingDirectory(request.sessionId, ctx.workspaceId)
  if (!workingDirectory) return undefined
  // The SAME `.git` climb the output-style project walk uses. A third copy of
  // that loop would be a third thing to keep in step.
  const repositoryRoot = outputStyleProjectRootFor(workingDirectory)
  return { allowed, workingDirectory, ...(repositoryRoot ? { repositoryRoot } : {}) }
}

/**
 * P6.245 — the administrator's own pre-install trust sentence, from the ENFORCED
 * managed composition rather than the host-owned file, so a server-DELIVERED
 * value works as well as a file one (the same reading the retention, sandbox and
 * in-app-update providers take in `bootstrap/managed-policy-resolution.ts`).
 *
 * Resolved per LIST rather than captured once, for the reason that module states
 * about its own providers: "The provider re-resolves on every read, so a
 * delivered payload that lands after registration is seen by the next decision."
 * A policy this run cannot resolve yields no message — the standard confirmation
 * alone, which is what `settings-reference.md#plugintrustmessage` calls the
 * default ("unset, so Claude Code shows the standard warning alone") and what
 * every unmanaged install already gets.
 */
function managedPluginTrustMessage(): string | undefined {
  try {
    return resolveEnforcedManagedPolicy().policy.pluginTrustMessage
  } catch {
    return undefined
  }
}

function toSafeMarketplaceListResult(
  result: MarketplaceListResult,
  suggestions?: MarketplaceSuggestionContext,
  pluginTrustMessage?: string,
): SafeMarketplaceListResult {
  const registryLoadErrors = (result.registryLoadErrors ?? []).map(toSafeRegistryLoadError)
  return {
    items: result.items.map(item => toSafeMarketplaceCatalogItem(item, suggestions)),
    page: result.page,
    pageSize: result.pageSize,
    total: result.total,
    visible: result.visible,
    ...(result.generatedAt ? { generatedAt: result.generatedAt } : {}),
    ...(result.nextPage ? { nextPage: result.nextPage } : {}),
    ...(registryLoadErrors.length ? { registryLoadErrors } : {}),
    // The managed-pair invariant on the wire: a policy that says nothing sends
    // nothing.
    ...(pluginTrustMessage ? { pluginTrustMessage } : {}),
  }
}

function toSafeMarketplaceCatalogItem(
  item: MarketplaceCatalogItem,
  suggestions?: MarketplaceSuggestionContext,
): SafeMarketplaceCatalogItem {
  const signal = suggestions && item.marketplaceRegistryId
    && suggestions.allowed.has(item.marketplaceRegistryId)
    ? matchRelevanceSignal(item.relevance, {
      workingDirectory: suggestions.workingDirectory,
      ...(suggestions.repositoryRoot ? { repositoryRoot: suggestions.repositoryRoot } : {}),
      ...(suggestions.manifests ? { manifests: suggestions.manifests } : {}),
    })
    : undefined
  const sourceUrl = safeCatalogUrl(item.sourceUrl)
  const detailUrl = safeCatalogUrl(item.detailUrl)
  const repo = safeCatalogLabel(item.repo)
  // Bring-your-own registry rows (R2) carry their registry id + a path-free
  // display label; built-in Skills Market rows stay on SAFE_MARKETPLACE_ID.
  // safeCatalogLabel strips any absolute/home/drive path so no installedRoot /
  // catalogRoot can leak through the label (Stop Condition).
  const registryLabel = safeCatalogLabel(item.marketplaceRegistryLabel)
  const formerIds = (item.formerIds ?? []).filter(formerId => typeof formerId === 'string' && formerId.length > 0)
  return {
    marketplaceId: item.marketplaceRegistryId ?? SAFE_MARKETPLACE_ID,
    id: item.id,
    kind: item.kind,
    listKind: item.listKind,
    name: item.name,
    ...(item.description ? { description: item.description } : {}),
    ...(item.version ? { version: item.version } : {}),
    icon: safeMarketplaceIcon(item),
    ...(sourceUrl ? { sourceUrl } : {}),
    ...(detailUrl ? { detailUrl } : {}),
    ...(item.tenant ? { tenant: item.tenant } : {}),
    ...(repo ? { repo } : {}),
    ...(registryLabel ? { registryLabel } : {}),
    // C3: the ids this row used to have in this same registry. Already
    // path-free by construction (`<registryId>:<name>`, the same shape as `id`),
    // and filtered like `capabilities` so nothing non-string crosses.
    ...(formerIds.length ? { formerIds } : {}),
    capabilities: item.capabilities.filter(capability => typeof capability === 'string'),
    install: { sourceConfidence: item.install.sourceConfidence },
    // Pre-inspection catalog row (A9): acquisition is known from the listing
    // identity — built-in Skills Market rows are 'nessy-marketplace' (T-bank
    // badge); bring-your-own registry rows are 'external-marketplace' so a
    // third-party catalog is never branded T-bank (live-audit finding
    // 2026-07-20). Format stays 'unknown' until fetched/adapter-detected.
    presentation: toSafePluginPresentationForCatalogListing(
      item.marketplaceRegistryId ? 'external-marketplace' : 'nessy-marketplace',
    ),
    // Only the SIGNAL crosses: the working directory that produced it is server
    // state and the label is rendered (and translated) in the renderer.
    ...(signal ? { suggestion: { signal } } : {}),
  }
}

/**
 * Path-free registry load-error projection (R2). Only the registry id, a
 * path-stripped display label, and diagnostic CODES cross the boundary — never
 * a marketplacePath / installedRoot / catalogRoot (Stop Condition).
 */
function toSafeRegistryLoadError(error: MarketplaceRegistryLoadError): SafeMarketplaceRegistryLoadError {
  const displayName = safeCatalogLabel(error.displayName)
  return {
    marketplaceId: error.marketplaceRegistryId,
    ...(displayName ? { displayName } : {}),
    diagnosticCodes: error.diagnosticCodes.filter(code => typeof code === 'string'),
  }
}

/**
 * Safe, path-free deferred-capability summary (A9 A7-carry): only the
 * external kind + reason code cross the RPC boundary, from both the
 * `deferred` and `blocked` compatibility lists — a blocked install needs to
 * show why just as much as a partial one does. `sourcePath` never crosses.
 */
function toSafeDeferredCapabilities(
  compatibility: PluginCompatibilityReport,
): SafeMarketplacePluginDeferredCapability[] {
  return [...compatibility.deferred, ...compatibility.blocked].map(entry => ({
    externalKind: entry.externalKind,
    reasonCode: entry.reasonCode,
  }))
}

function safeMarketplaceIcon(item: MarketplaceCatalogItem): SafeMarketplaceIcon {
  if (item.icon.kind === 'url') {
    const url = safeCatalogUrl(item.icon.url)
    if (url) return { kind: 'url', url }
  }
  const fallback = item.kind === 'skill' || item.kind === 'mcp' || item.kind === 'hook'
    ? item.kind
    : 'plugin'
  return { kind: 'symbol', name: fallback }
}

function safeCatalogUrl(value?: string): string | undefined {
  if (!value) return undefined
  try {
    const url = new URL(value)
    if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password) {
      return undefined
    }
    url.search = ''
    url.hash = ''
    return url.toString()
  } catch {
    return undefined
  }
}

function safeCatalogLabel(value?: string): string | undefined {
  if (!value || value.startsWith('/') || value.startsWith('~/') || /^[A-Za-z]:[\\/]/.test(value)) {
    return undefined
  }
  return value
}
