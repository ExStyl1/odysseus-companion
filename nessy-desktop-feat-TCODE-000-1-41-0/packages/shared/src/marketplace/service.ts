import { pluginDiagnostic } from '../plugins/schema.ts';
import type {
  PluginActivationTarget,
  PluginManagementApi,
  PluginManagementInstallResult,
  PluginManagementInstalledSummary,
  PluginManagementStatusResult,
} from '../plugins/management-types.ts';
import {
  describePluginDependencyError,
  type PluginDependencyError,
  type PluginDependencySubject,
} from '../plugins/dependencies.ts';
import { selectPluginVersionTag, type RepositoryTagRef } from '../plugins/version-tags.ts';
import type {
  PluginDependencyDescriptor,
  PluginDiagnostic,
  PluginInstallSource,
} from '../plugins/types.ts';
import {
  CROSS_MARKETPLACE_ALLOWLIST_FIELD,
  DEPENDENCY_ACQUISITION_REASON_CODES,
  planDependencyAcquisition,
  resolveHeldConstraint,
  type DependencyAcquisitionDecision,
  type DependencyCatalogRow,
  type HeldDependencyConstraint,
} from './dependency-acquisition.ts';
import { SkillsMarketClient, type MarketplaceClientError } from './client.ts';
import {
  attachMarketplaceListingMetadata,
  createPluginInstallSourceFromMarketplaceItem,
} from './install-source.ts';
import { normalizeMarketplaceList, normalizePluginDto, normalizeSkillDto } from './normalizers.ts';
import { proposeRepositoryInstall } from './repository-install.ts';
import {
  compareCandidateVersion,
  findCatalogRowForInstalled,
  toInstalledUpdateSubjects,
  type CandidateVersionComparison,
  type InstalledUpdateSubject,
} from './update-availability.ts';
import type {
  MarketplaceBundleUpdateRequest,
  MarketplaceBundleUpdateResult,
  MarketplaceCatalogItem,
  MarketplaceDisableRequest,
  MarketplaceEnableRequest,
  MarketplaceInspectRequest,
  MarketplaceInspectResult,
  MarketplaceInstallRequest,
  MarketplaceItemKind,
  MarketplaceListKind,
  MarketplaceListParams,
  MarketplaceListRequest,
  MarketplaceListResult,
  MarketplaceMetaDto,
  MarketplaceRefreshRequest,
  MarketplaceRegistryLoadError,
  MarketplaceRepositoryInstallProposal,
  MarketplaceRepositoryInstallRequest,
  MarketplaceServiceErrorCode,
  MarketplaceTryInChatRequest,
  MarketplaceTryInChatResult,
  MarketplaceUninstallRequest,
} from './types.ts';

/**
 * Injected bring-your-own registry source (R2). When present, `list()` merges
 * its catalog items into a `plugins` list alongside the built-in Skills Market.
 * The registry-fetch/parse plumbing (R1's `fetchRegistryCatalog` +
 * `registryCatalogItems`) lives server-side and is wired in R3; the service only
 * consumes this already-resolved, path-free result. `items` MUST already be
 * tagged with `marketplaceRegistryId`; `loadErrors` are path-free.
 */
export interface MarketplaceRegistrySource {
  listItems(): Promise<MarketplaceRegistryListResult>;
}

export interface MarketplaceRegistryListResult {
  items: MarketplaceCatalogItem[];
  loadErrors?: MarketplaceRegistryLoadError[];
}

export interface MarketplaceServiceOptions {
  client?: SkillsMarketClient;
  marketplaceBaseUrl?: string;
  pluginService?: MarketplacePluginManagementApi;
  fetchImpl?: typeof fetch;
  /** Optional bring-your-own registry catalog source; merged into `plugins` lists only. */
  registrySource?: MarketplaceRegistrySource;
  /**
   * `plugins/host-marketplace.md#run-release-channels` — the marketplace-repository tag listing a
   * version constraint resolves against. Injected rather than constructed here
   * because the listing rides the plugin install service's artifact auth
   * provider and fetch seam; omit it and a constrained dependency installs at
   * whatever the catalog holds and is then checked at load time, which is
   * exactly `:137`'s documented behaviour for non-git sources.
   */
  listRepositoryTags?: (repositoryUrl: string) => Promise<RepositoryTagRef[] | undefined>;
}

export type MarketplacePluginManagementApi = PluginManagementApi;

export class MarketplaceServiceError extends Error {
  override readonly name = 'MarketplaceServiceError';
  readonly code: MarketplaceServiceErrorCode;
  readonly diagnostics: PluginDiagnostic[];

  constructor(code: MarketplaceServiceErrorCode, message: string, diagnostics: PluginDiagnostic[] = []) {
    super(message);
    this.code = code;
    this.diagnostics = diagnostics;
  }
}

export class MarketplaceService {
  private readonly client: SkillsMarketClient;
  private readonly pluginService?: MarketplacePluginManagementApi;
  private readonly registrySource?: MarketplaceRegistrySource;
  private readonly listRepositoryTags?: (repositoryUrl: string) => Promise<RepositoryTagRef[] | undefined>;

  constructor(options: MarketplaceServiceOptions = {}) {
    this.client = options.client ?? new SkillsMarketClient({
      ...(options.marketplaceBaseUrl ? { baseUrl: options.marketplaceBaseUrl } : {}),
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    });
    this.pluginService = options.pluginService;
    this.registrySource = options.registrySource;
    this.listRepositoryTags = options.listRepositoryTags;
  }

  async meta(): Promise<MarketplaceMetaDto> {
    return this.client.getMarketplaceMeta();
  }

  async list(request: MarketplaceListRequest): Promise<MarketplaceListResult> {
    const params = listParamsFor(request);
    const raw = request.kind === 'skills'
      ? await this.client.listMarketplaceSkills(params)
      : await this.client.listMarketplacePlugins(params);
    const skillsMarket = normalizeMarketplaceList(request.kind, raw);
    // The Skills Market `skills` path is untouched; only a `plugins` list merges
    // injected registry items (each already tagged with `marketplaceRegistryId`).
    if (request.kind !== 'plugins' || !this.registrySource) {
      return skillsMarket;
    }
    return mergeRegistryItems(
      skillsMarket,
      filterRegistryItems(await this.registrySource.listItems(), request),
      request.page ?? skillsMarket.page,
    );
  }

  /**
   * Fetch one market skill's raw SKILL.md body (frontmatter + markdown).
   * Fail-soft: any client error (network/HTTP/404), or empty content, resolves
   * to `null` so the caller can fall back to the short description without
   * surfacing an error. Never throws.
   */
  async skillContent(id: string): Promise<string | null> {
    try {
      const content = await this.client.getMarketplaceSkillContent(id);
      return content.trim().length > 0 ? content : null;
    } catch {
      return null;
    }
  }

  async inspect(request: MarketplaceInspectRequest): Promise<MarketplaceInspectResult> {
    const item = listKindForInspect(request.kind) === 'skills'
      ? normalizeSkillDto(await this.client.getMarketplaceSkill(request.id))
      : normalizePluginDto(await this.client.getMarketplacePlugin(request.id));
    return { item, diagnostics: [] };
  }

  proposeInstall(request: MarketplaceRepositoryInstallRequest): MarketplaceRepositoryInstallProposal {
    return proposeRepositoryInstall(request);
  }

  async install(request: MarketplaceInstallRequest): Promise<PluginManagementInstallResult> {
    const service = this.requirePluginService('marketplace.install.unavailable');
    const activateIn = request.activateIn ?? { kind: 'global' };
    const result = await service.install(
      resolveInstallSource(request),
      {
        ...(request.baseTempDir ? { baseTempDir: request.baseTempDir } : {}),
        activateIn,
        ...((request.item?.connectorAuthTiming ?? request.connectorAuthTiming)
          ? { connectorAuthTiming: (request.item?.connectorAuthTiming ?? request.connectorAuthTiming)! }
          : {}),
        ...((request.item?.catalogAuthenticationPolicy ?? request.catalogAuthenticationPolicy)
          ? { catalogAuthenticationPolicy: (request.item?.catalogAuthenticationPolicy ?? request.catalogAuthenticationPolicy)! }
          : {}),
      },
    );
    // `plugins/host-marketplace.md#depend-on-and-recommend-other-plugins` — "Claude Code resolves and installs them
    // automatically". Only a plugin that declares dependencies takes this path;
    // an install of the 276 official catalogue entries (0 of which declare one,
    // measured 2026-08-02) is byte-identical to before.
    if (!result.ok || !result.installed?.dependencies?.length) return result;
    return this.acquireDependencies(result, activateIn, request.baseTempDir);
  }

  /**
   * Resolve and install the declared dependency closure of a plugin that was
   * just installed (`:11`, `:52`-`:70`).
   *
   * Breadth-first with a visited set, so `:70`'s bundle ("Installing
   * `backend-standard` resolves and installs all four dependencies") pulls the
   * transitive set and a dependency cycle terminates instead of recursing.
   *
   * The root's own bundle is already committed and activated when this runs, and
   * that is deliberate rather than an ordering accident: `:208` — "Claude Code
   * disables the affected plugin until you resolve the error" — is enforced at
   * LOAD time by the capability resolver, which reads the same declared
   * dependencies and turns every capability of the dependent plugin off. So a
   * plugin whose dependency could not be acquired ends up present, visible in
   * the plugin list with its error, and completely inert. It never loads half
   * its capabilities.
   */
  private async acquireDependencies(
    rootResult: PluginManagementInstallResult,
    activateIn: PluginActivationTarget,
    baseTempDir?: string,
  ): Promise<PluginManagementInstallResult> {
    const service = this.requirePluginService('marketplace.install.unavailable');
    const root = rootResult.installed!;
    const diagnostics = [...rootResult.diagnostics];
    const installedDependencies: NonNullable<PluginManagementInstallResult['installedDependencies']> = [];
    const dependencyErrors: PluginDependencyError[] = [];

    const registry = this.registrySource ? await this.registrySource.listItems() : { items: [] };
    const catalogItems = registry.items;
    const catalog: DependencyCatalogRow[] = catalogItems
      .filter(item => item.marketplaceRegistryId)
      .map(item => ({
        marketplaceId: item.marketplaceRegistryId!,
        pluginName: item.name,
        itemId: item.id,
        ...(item.version ? { version: item.version } : {}),
        ...(item.structuredInstallSource ? { source: item.structuredInstallSource } : {}),
      }));
    // A registry whose catalog failed to load is still CONFIGURED — `:11`'s
    // "a marketplace you have not added" is about registration, not about
    // whether this poll managed to read it.
    const configuredMarketplaceIds = [...new Set([
      ...catalog.map(row => row.marketplaceId),
      ...(registry.loadErrors ?? []).map(error => error.marketplaceRegistryId),
    ])];

    const visited = new Set<string>([`${root.marketplaceId}\u0000${root.pluginId}`]);
    const queue: Array<{ marketplaceId: string; declared: PluginDependencyDescriptor[] }> = [
      { marketplaceId: root.marketplaceId, declared: root.dependencies ?? [] },
    ];

    while (queue.length > 0) {
      const level = queue.shift()!;
      const installedSubjects = await this.dependencySubjects(service);
      const decisions = planDependencyAcquisition({
        declared: level.declared,
        declaringMarketplaceId: level.marketplaceId,
        // `:83` — only the ROOT marketplace's allowlist is consulted, so trust
        // does not chain through an intermediate marketplace.
        rootMarketplaceId: root.marketplaceId,
        configuredMarketplaceIds,
        installed: installedSubjects,
        catalog,
      });
      for (const decision of decisions) {
        const visitKey = `${decision.marketplaceId}\u0000${decision.name}`;
        if (visited.has(visitKey)) continue;
        if (decision.action === 'satisfied') {
          visited.add(visitKey);
          continue;
        }
        if (decision.action === 'refuse') {
          visited.add(visitKey);
          dependencyErrors.push(decision.error);
          diagnostics.push(pluginDiagnostic(
            'error',
            decision.reasonCode,
            dependencyRefusalMessage(decision),
            undefined,
            { dependency: decision.name, marketplace: decision.marketplaceId },
          ));
          continue;
        }
        visited.add(visitKey);
        const item = catalogItems.find(candidate => candidate.id === decision.itemId);
        if (!item) continue;
        const resolvedRef = await this.resolveDependencyRef(item, decision.name, decision.range);
        if (resolvedRef.ok === false) {
          dependencyErrors.push(resolvedRef.error);
          diagnostics.push(pluginDiagnostic(
            'error',
            DEPENDENCY_ACQUISITION_REASON_CODES.noMatchingTag,
            describePluginDependencyError(resolvedRef.error),
            undefined,
            { dependency: decision.name, marketplace: decision.marketplaceId },
          ));
          continue;
        }
        const installed = await service.install(
          withDependencyRef(resolveInstallSource({ item }), resolvedRef.tag),
          {
            ...(baseTempDir ? { baseTempDir } : {}),
            // `:167` — "a dependency pulled in to satisfy an active plugin
            // installs with `true` regardless of its own default".
            activateIn,
            // P6.557 — this is the ONLY call that pulls a plugin in on another
            // plugin's behalf, so it is the only writer of the provenance bit
            // `plugin-dependencies.md` § *Remove orphaned auto-installed
            // dependencies* needs: "plugins you installed yourself are never
            // pruned, only those installed automatically through another
            // plugin's `dependencies` array".
            autoInstalled: true,
            ...(item.connectorAuthTiming ? { connectorAuthTiming: item.connectorAuthTiming } : {}),
            ...(item.catalogAuthenticationPolicy
              ? { catalogAuthenticationPolicy: item.catalogAuthenticationPolicy }
              : {}),
          },
        );
        diagnostics.push(...installed.diagnostics);
        if (!installed.ok || !installed.installed) {
          dependencyErrors.push({
            code: 'dependency-unsatisfied',
            dependency: decision.name,
            ...(decision.range ? { range: decision.range } : {}),
          });
          continue;
        }
        installedDependencies.push({
          pluginKey: installed.installed.pluginKey,
          name: installed.installed.name,
          marketplaceId: installed.installed.marketplaceId,
          version: installed.installed.version,
          ...(resolvedRef.tag ? { tag: resolvedRef.tag } : {}),
        });
        if (installed.installed.dependencies?.length) {
          queue.push({
            marketplaceId: installed.installed.marketplaceId,
            declared: installed.installed.dependencies,
          });
        }
      }
    }

    return {
      ...rootResult,
      // Not `ok` when the closure is incomplete: the root's bundle is on disk,
      // but the resolver disables it until the error is resolved (`:208`), and
      // reporting success for an install that produced an inert plugin is
      // precisely the "half-working" outcome this exists to avoid.
      ok: dependencyErrors.length === 0,
      diagnostics,
      ...(installedDependencies.length ? { installedDependencies } : {}),
      ...(dependencyErrors.length ? { dependencyErrors } : {}),
    };
  }

  /** The installed set, shaped for the same resolution the load-time verdict uses. */
  private async dependencySubjects(
    service: MarketplacePluginManagementApi,
  ): Promise<PluginDependencySubject[]> {
    const status = await service.status();
    return status.installed.map(entry => ({
      pluginKey: entry.pluginKey,
      pluginId: entry.pluginId,
      marketplaceId: entry.marketplaceId,
      version: entry.version,
      manifest: {
        name: entry.name,
        ...(entry.dependencies ? { dependencies: entry.dependencies } : {}),
      },
    }));
  }

  /**
   * `:127` — "Claude Code lists the marketplace's tags, filters to those
   * starting with `secrets-vault--v`, and fetches the highest version satisfying
   * `~2.1.0`."
   *
   * Two documented cases resolve to "no tag, install what the catalog holds",
   * and neither is an error:
   *
   * - No range at all (`:40` — a bare-string dependency "depends on whatever
   *   version that plugin's marketplace provides").
   * - A non-git source. `:137` — "For `npm` marketplace sources, the constraint
   *   does not control which version is fetched, since tag-based resolution
   *   applies only to git-backed sources. The constraint is still checked at
   *   load time, and the dependent plugin is disabled with
   *   `dependency-version-unsatisfied` if the installed version does not satisfy
   *   it." So the constraint is deliberately NOT enforced here for those, and
   *   the existing load-time verdict is what enforces it.
   *
   * An unreachable tag listing is also not a refusal: `listRepositoryTags`
   * returns `undefined` rather than `[]` for that case, and a network failure
   * must not be reported as "the upstream has not tagged a release".
   */
  private async resolveDependencyRef(
    item: MarketplaceCatalogItem,
    dependencyName: string,
    range?: string,
  ): Promise<{ ok: true; tag?: string } | { ok: false; error: PluginDependencyError }> {
    if (!range) return { ok: true };
    const source = item.structuredInstallSource;
    if (!this.listRepositoryTags || source?.kind !== 'repository') return { ok: true };
    const tags = await this.listRepositoryTags(source.repositoryUrl);
    if (tags === undefined) return { ok: true };
    const selection = selectPluginVersionTag(tags, dependencyName, range);
    if (selection.ok) return { ok: true, tag: selection.selected.tag };
    return {
      ok: false,
      error: {
        code: 'no-matching-tag',
        dependency: dependencyName,
        range,
        availableVersions: selection.available,
        ...(item.marketplaceRegistryId ? { marketplace: item.marketplaceRegistryId } : {}),
      },
    };
  }

  /**
   * `plugins/loading.md#when-auto-update-runs` — "When auto-update is enabled for a marketplace,
   * Claude Code refreshes the marketplace data **and updates installed plugins
   * to their latest versions on disk**."
   *
   * R63 (commit `d6412e3bd`) shipped the first half and recorded the second as
   * unbuilt, in-source, deferred to this unit. This is that second half: the
   * catalog refresh has already landed by the time this runs, and this walks the
   * installed plugins that came from those marketplaces and re-materializes the
   * ones the catalog now offers at a higher version.
   *
   * Three rules the page fixes, all of them load-bearing:
   *
   * - **Strictly higher, by semver.** `:441` says "latest versions"; comparing
   *   by inequality instead would re-fetch on every pass forever whenever a
   *   catalog listing and its bundle manifest disagree about the version, which
   *   is a known and tolerated skew (`plugin.install.version_mismatch`). Higher
   *   is idempotent; different is not.
   * - **A held dependency is not moved to the marketplace's latest**
   *   (`plugins/host-marketplace.md#hold-users-on-one-version`). It moves to the highest tag satisfying
   *   every installed dependent's range, and when nothing satisfies them the
   *   update is SKIPPED and the skip names the constraining plugin.
   * - **Nothing hot-swaps into the running session.** This only writes bundles;
   *   the caller's existing invalidation seam resolves before the next turn,
   *   which is `plugins/loading.md#when-auto-update-runs`'s "the running session keeps using the
   *   versions it loaded at launch".
   */
  async updateInstalledBundles(
    request: MarketplaceBundleUpdateRequest = {},
  ): Promise<MarketplaceBundleUpdateResult> {
    const service = this.requirePluginService('marketplace.refresh.unavailable');
    const result: MarketplaceBundleUpdateResult = { considered: [], updated: [], skipped: [] };
    if (!this.registrySource) return result;
    const scope = request.marketplaceIds ? new Set(request.marketplaceIds) : undefined;
    const { items } = await this.registrySource.listItems();
    const status = await service.status();
    // ONE subject array, and it is the same shape the READ side joins on
    // (`update-availability.ts`): the hold check needs every installed plugin's
    // declared dependencies, and the catalog join needs the recorded listing id,
    // so both ride the same rows rather than two near-identical projections that
    // could drift.
    const subjects: InstalledUpdateSubject[] = toInstalledUpdateSubjects(status.installed);

    for (const installed of subjects) {
      if (scope && !scope.has(installed.marketplaceId)) continue;
      // THE RULE THIS LOOP EXISTS TO STATE (P2.173): a per-item loop must
      // contain its OWN failure, or one bad item silently becomes zero items
      // processed.
      //
      // Everything a single plugin needs — the catalog join, the hold lookup,
      // the target decision AND the write — is inside this `try`, not just the
      // write. The guard used to sit around the write alone, and the decision
      // step ran outside it: `resolveBundleUpdateTarget` compared versions with
      // a bare `semver.gt`, which THROWS on a string strict semver cannot parse,
      // so ONE installed plugin declaring `0.10.2.3` took the entire unattended
      // pass down and skipped every plugin behind it (P2.159 removed that one
      // thrower; it did not move the guard). The decision step still awaits an
      // INJECTED `listRepositoryTags`, so the pass would otherwise be trusting a
      // callback it does not own never to reject.
      //
      // This failure mode is invisible by construction, which is why the guard
      // has to be structural rather than per-known-thrower: the pass is
      // unattended, its scheduler discards the rejection
      // (`auto-update.ts` — "the pass logs its own failures"), and its only
      // symptom is that nothing happens. Same family as P2.146, P2.153, P2.159
      // and P2.162. `rule-matching.ts` states the same rule for the other kind
      // of per-item work in this tree — "an invalid pattern MATCHES NOTHING and
      // never throws, so it cannot take the rule's sibling patterns down with
      // it".
      try {
        const item = findCatalogRowForInstalled(items, installed);
        if (!item?.version) continue;
        result.considered.push(installed.pluginKey);
        const held = resolveHeldConstraint(subjects, installed.pluginId, installed.marketplaceId)
          ?? resolveHeldConstraint(subjects, installed.manifest.name, installed.marketplaceId);
        const target = await this.resolveBundleUpdateTarget(item, installed, held);
        if (target.kind === 'skip') {
          if (target.reasonCode) {
            result.skipped.push({
              pluginKey: installed.pluginKey,
              reasonCode: target.reasonCode,
              ...(held?.constrainedBy.length ? { constrainedBy: held.constrainedBy } : {}),
            });
          }
          continue;
        }
        try {
          const updated = await service.update(installed.pluginKey, {
            source: withDependencyRef(
              attachMarketplaceListingMetadata(item.structuredInstallSource!, item),
              target.tag,
            ),
          });
          if (updated.ok && updated.installed) {
            result.updated.push({
              pluginKey: installed.pluginKey,
              fromVersion: installed.version,
              toVersion: updated.installed.version,
              ...(target.tag ? { tag: target.tag } : {}),
            });
          } else {
            result.skipped.push({ pluginKey: installed.pluginKey, reasonCode: 'plugin.update.failed' });
          }
        } catch {
          // One plugin's failed update must not stop the rest of an unattended
          // background pass; the registry is unchanged for that plugin.
          result.skipped.push({ pluginKey: installed.pluginKey, reasonCode: 'plugin.update.failed' });
        }
      } catch {
        // A failure BEFORE the write is a distinct fact and gets a distinct
        // name: the plugin was never attempted, so calling it
        // `plugin.update.failed` would report an update that never ran. It
        // rides the SAME `skipped` channel every other named skip rides — the
        // one `marketplace-auto-update.ts` already logs per row — rather than a
        // new one.
        result.skipped.push({ pluginKey: installed.pluginKey, reasonCode: 'plugin.update.decision_failed' });
      }
    }
    return result;
  }

  /**
   * Decide whether one installed plugin moves, and to which ref.
   *
   * `plugins/host-marketplace.md#hold-users-on-one-version` is the case worth naming: a dependent pinning
   * `=2.1.0` means "the dependency stays at `2.1.0`. Auto-update skips newer
   * versions while plugin A is installed" — so a held plugin is compared against
   * the highest satisfying TAG, never against the catalog's latest.
   */
  private async resolveBundleUpdateTarget(
    item: MarketplaceCatalogItem,
    installed: InstalledUpdateSubject,
    held: HeldDependencyConstraint | undefined,
  ): Promise<{ kind: 'update'; tag?: string } | { kind: 'skip'; reasonCode?: string }> {
    const source = item.structuredInstallSource;
    if (!source) return { kind: 'skip' };
    if (held) {
      if (!this.listRepositoryTags || source.kind !== 'repository') {
        // `:137` — for a non-git source the constraint does not select a version.
        // Moving it anyway could push a held dependency out of range, so a
        // constrained non-git plugin is left where it is.
        return { kind: 'skip', reasonCode: 'plugin.update.held_by_dependency' };
      }
      const tags = await this.listRepositoryTags(source.repositoryUrl);
      if (tags === undefined) return { kind: 'skip' };
      const selection = selectPluginVersionTag(tags, installed.pluginId, held.range);
      if (!selection.ok) {
        // `:150` — "auto-update skips that dependency and lists the skip …
        // naming the constraining plugin".
        return { kind: 'skip', reasonCode: 'plugin.update.no_tag_satisfies_constraints' };
      }
      // `compareCandidateVersion`, not a bare `gt`: `gt` THROWS on a version
      // strict semver cannot parse (measured — `gt('0.10.2.3', '0.10.0')` raises
      // `TypeError: Invalid Version`), and `installed.version` is whatever the
      // publisher's manifest declared. A four-part installed version therefore
      // used to take down the whole unattended pass from inside this line, before
      // the per-plugin `try` two frames up, skipping every plugin behind it.
      return this.namedComparison(
        compareCandidateVersion(selection.selected.version, installed.version),
        { kind: 'update', tag: selection.selected.tag },
      );
    }
    return this.namedComparison(
      compareCandidateVersion(item.version, installed.version),
      { kind: 'update' },
    );
  }

  /**
   * Turn a three-valued version comparison into a move-or-skip, with the
   * unorderable case NAMED (P2.159).
   *
   * An anonymous `{kind:'skip'}` reaches `updateInstalledBundles` and is dropped
   * — `if (target.reasonCode)` is what decides whether a skip is recorded at all
   * — so a plugin whose version cannot be ordered used to leave no trace in the
   * result and no line in the log, indefinitely, while auto-update was on. That
   * is the same shape as P2.146 and P2.153: a failure whose only symptom is that
   * nothing happens. `not-higher` stays anonymous on purpose: "already current"
   * is the ordinary answer for almost every installed plugin and is not news.
   */
  private namedComparison(
    comparison: CandidateVersionComparison,
    move: { kind: 'update'; tag?: string },
  ): { kind: 'update'; tag?: string } | { kind: 'skip'; reasonCode?: string } {
    if (comparison === 'higher') return move;
    if (comparison === 'incomparable') {
      return { kind: 'skip', reasonCode: 'plugin.update.version_uncomparable' };
    }
    return { kind: 'skip' };
  }

  enable(request: MarketplaceEnableRequest): Promise<PluginManagementInstalledSummary> {
    return this.requirePluginService('marketplace.enable.unavailable')
      .enable(request.pluginKey, request.target);
  }

  disable(request: MarketplaceDisableRequest): Promise<PluginManagementInstalledSummary> {
    return this.requirePluginService('marketplace.disable.unavailable')
      .disable(request.pluginKey, request.target);
  }

  async uninstall(request: MarketplaceUninstallRequest): Promise<void> {
    await this.requirePluginService('marketplace.uninstall.unavailable').uninstall(request.pluginKey);
  }

  refresh(_request: MarketplaceRefreshRequest = {}): Promise<PluginManagementStatusResult> {
    return this.requirePluginService('marketplace.refresh.unavailable').refresh();
  }

  tryInChat(request: MarketplaceTryInChatRequest): MarketplaceTryInChatResult {
    const prompt = request.locale?.toLowerCase().startsWith('ru')
      ? `Расскажи, что ты умеешь с ${request.item.name}, и предложи первую полезную задачу, которую я могу попробовать.`
      : `Tell me what you can do with ${request.item.name} and suggest the first useful task I can try.`;
    return {
      prompt,
      autoSend: false,
      itemId: request.item.id,
      itemName: request.item.name,
      kind: request.item.kind,
    };
  }

  private requirePluginService(code: MarketplaceServiceErrorCode): MarketplacePluginManagementApi {
    if (this.pluginService) return this.pluginService;
    throw new MarketplaceServiceError(
      code,
      'Marketplace plugin management is unavailable before storage readiness.',
    );
  }
}

/**
 * Concatenate Skills Market items + injected registry items into one `plugins`
 * result. `total`/`visible` grow by the registry count; per-registry load errors
 * (path-free) ride along only when present (additive, omit-when-empty).
 */
function mergeRegistryItems(
  skillsMarket: MarketplaceListResult,
  registry: MarketplaceRegistryListResult,
  page: number,
): MarketplaceListResult {
  // Registry catalogs are already an in-memory snapshot and are appended once
  // on page one. Re-injecting them on every Skills Market page creates duplicate
  // cards and stale lifecycle state after an external install.
  const items = page === 1
    ? [...skillsMarket.items, ...registry.items]
    : skillsMarket.items;
  const loadErrors = registry.loadErrors?.filter(error => error.diagnosticCodes.length > 0) ?? [];
  return {
    ...skillsMarket,
    items,
    total: skillsMarket.total + registry.items.length,
    visible: items.length,
    ...(loadErrors.length ? { registryLoadErrors: loadErrors } : {}),
  };
}

function filterRegistryItems(
  registry: MarketplaceRegistryListResult,
  request: MarketplaceListRequest,
): MarketplaceRegistryListResult {
  const query = request.query?.trim().toLocaleLowerCase();
  const requiredCapabilities = request.capabilities?.map(value => value.toLocaleLowerCase()) ?? [];
  const requiredTenants = request.tenants?.map(value => value.toLocaleLowerCase()) ?? [];
  const items = registry.items.filter(item => {
    if (query) {
      const haystack = [item.name, item.description, item.tenant, item.repo, ...item.capabilities]
        .filter((value): value is string => Boolean(value))
        .join('\n')
        .toLocaleLowerCase();
      if (!haystack.includes(query)) return false;
    }
    if (requiredCapabilities.length > 0) {
      const available = new Set(item.capabilities.map(value => value.toLocaleLowerCase()));
      if (!requiredCapabilities.every(value => available.has(value))) return false;
    }
    if (requiredTenants.length > 0) {
      if (!item.tenant || !requiredTenants.includes(item.tenant.toLocaleLowerCase())) return false;
    }
    return true;
  });
  return { ...registry, items };
}

/**
 * `:104` — "install fails with a `cross-marketplace` error **naming the field to
 * set**", and `:212`/`:213` give each other refusal its own remedy. The message
 * carries the remedy because the code alone is not actionable in a UI toast.
 */
function dependencyRefusalMessage(
  decision: Extract<DependencyAcquisitionDecision, { action: 'refuse' }>,
): string {
  const target = `${decision.name}@${decision.marketplaceId}`;
  switch (decision.reasonCode) {
    case DEPENDENCY_ACQUISITION_REASON_CODES.crossMarketplace:
      return `${decision.name} lives in marketplace ${decision.marketplaceId}, which this plugin's own marketplace `
        + `does not allow it to depend on. Add ${decision.marketplaceId} to "${CROSS_MARKETPLACE_ALLOWLIST_FIELD}" `
        + `in the root marketplace's marketplace.json, or install ${target} yourself first.`;
    case DEPENDENCY_ACQUISITION_REASON_CODES.marketplaceNotConfigured:
      // `:11` — "Dependencies from a marketplace you have not added are left
      // unresolved", and `:212`'s remedy is to add it.
      return `${decision.name} comes from marketplace ${decision.marketplaceId}, which is not added on this machine. `
        + 'Add that marketplace and the dependency resolves automatically.';
    case DEPENDENCY_ACQUISITION_REASON_CODES.notInCatalog:
      return `Marketplace ${decision.marketplaceId} does not list a plugin named ${decision.name}.`;
    default:
      return describePluginDependencyError(decision.error);
  }
}

/**
 * `:134` — "The cache directory name for a tag-resolved install includes a
 * 12-character commit-SHA suffix", which in this fork's terms means the resolved
 * TAG becomes the source's pinned ref: the bundle hash is computed over the
 * fetched content, so pinning the ref is what makes a force-moved tag land in a
 * different cache entry instead of reusing stale content.
 */
function withDependencyRef(source: PluginInstallSource, tag?: string): PluginInstallSource {
  if (!tag || source.kind !== 'repository') return source;
  return { ...source, ref: tag };
}

function resolveInstallSource(request: MarketplaceInstallRequest): PluginInstallSource {
  if (typeof request.source === 'string') {
    throw new MarketplaceServiceError(
      'marketplace.install.invalid_source',
      'Marketplace install requires a structured install source; shell command strings are not accepted.',
      [pluginDiagnostic(
        'error',
        'marketplace.install.invalid_source',
        'Marketplace install requires a structured install source; shell command strings are not accepted.',
        'source',
      )],
    );
  }
  if (request.source) return request.source;
  if (request.proposal) {
    if (request.proposal.status === 'installable' && request.proposal.source) return request.proposal.source;
    throw new MarketplaceServiceError(
      'marketplace.install.unsupported_source',
      'Repository install proposal is not installable.',
      request.proposal.diagnostics,
    );
  }
  if (request.item) {
    // Registry catalog rows (R2) carry the parser's typed source directly, so
    // install routes through this SAME path without re-deriving from the (absent)
    // DTO `install` descriptor. Skills Market items leave this unset and fall
    // through to the existing descriptor-based resolution below.
    if (request.item.structuredInstallSource) {
      return attachMarketplaceListingMetadata(request.item.structuredInstallSource, request.item);
    }
    const result = createPluginInstallSourceFromMarketplaceItem(request.item);
    if (result.ok && result.source) return result.source;
    throw new MarketplaceServiceError(
      'marketplace.install.unsupported_source',
      `Marketplace item "${request.item.name}" does not expose a structured install source supported by Nessy Desktop.`,
      result.diagnostics,
    );
  }
  throw new MarketplaceServiceError(
    'marketplace.install.unsupported_source',
    'Marketplace install requires either a marketplace item, a typed proposal, or a structured plugin install source.',
  );
}

function listParamsFor(request: MarketplaceListRequest): MarketplaceListParams {
  return {
    ...(request.query ? { query: request.query } : {}),
    ...(request.page ? { page: request.page } : {}),
    ...(request.pageSize ? { pageSize: request.pageSize } : {}),
    ...(request.sort ? { sort: request.sort } : {}),
    ...(request.capabilities ? { capabilities: request.capabilities } : {}),
    ...(request.phases ? { phases: request.phases } : {}),
    ...(request.professions ? { professions: request.professions } : {}),
    ...(request.tenants ? { tenants: request.tenants } : {}),
  };
}

function listKindForInspect(kind: MarketplaceListKind | MarketplaceItemKind): MarketplaceListKind {
  return kind === 'skills' || kind === 'skill' ? 'skills' : 'plugins';
}

export function isMarketplaceClientError(error: unknown): error is MarketplaceClientError {
  return error instanceof Error && error.name === 'MarketplaceClientError';
}
