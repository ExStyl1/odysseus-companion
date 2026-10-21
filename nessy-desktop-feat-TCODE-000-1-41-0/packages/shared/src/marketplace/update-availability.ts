/**
 * Update AVAILABILITY — the read half of `plugins/loading.md#which-marketplaces-and-plugins-auto-update`.
 *
 * `:443` — "Claude Code can automatically update marketplaces and their
 * installed plugins in the background after startup. When auto-update is enabled
 * for a marketplace, Claude Code refreshes the marketplace data and updates
 * installed plugins to their latest versions on disk."
 *
 * R63 shipped the refresh, R72 shipped the bundle re-materialization
 * ({@link import('./service.ts').MarketplaceService.updateInstalledBundles}).
 * Both are WRITES. Neither tells a user that a newer version exists — and the
 * case that needs telling is the one auto-update never touches: `:454`,
 * "Official Anthropic marketplaces have auto-update enabled by default.
 * Third-party and local development marketplaces have auto-update disabled by
 * default." For those the background pass does nothing at all, so a badge is the
 * only thing standing between the user and an indefinitely stale plugin.
 *
 * This module is that read, and it is PURE: no catalog fetch, no store, no
 * clock. The caller supplies already-resolved catalog rows (see
 * `PluginRegistrySource.peekCachedItems`) and the installed set; everything here
 * is a join and two comparisons.
 *
 * The join and the strictly-higher rule are shared with `updateInstalledBundles`
 * rather than re-derived, deliberately: a badge that promises an update the
 * background pass then refuses is worse than no badge, so the two sides must not
 * be able to drift apart.
 */

import { gt, parse as parseSemver, satisfies } from 'semver';
import type { PluginInstallSource, PluginKey } from '../plugins/types.ts';
import type { PluginDependencySubject } from '../plugins/dependencies.ts';
import type {
  PluginManagementApi,
  PluginManagementInstalledSummary,
  PluginManagementRepairOptions,
} from '../plugins/management-types.ts';
import { resolveHeldConstraint, type HeldDependencyConstraint } from './dependency-acquisition.ts';
import { attachMarketplaceListingMetadata } from './install-source.ts';
import type { CachedMarketplaceCatalogReader } from './registry-source.ts';
import type { MarketplaceCatalogItem } from './types.ts';

/**
 * One installed plugin, reduced to what the catalog join and the hold check
 * read. A superset of {@link PluginDependencySubject} so the SAME array serves
 * both `resolveHeldConstraint` (which needs every installed plugin's declared
 * dependencies) and the per-plugin join.
 */
export interface InstalledUpdateSubject extends PluginDependencySubject {
  /**
   * The catalog listing id the install recorded, when it had one
   * (`origin.provenance.itemId`, surfaced on a management summary as
   * `source.marketplaceItemId`). Absent for rows installed before ids were
   * stamped, and for non-marketplace installs.
   */
  marketplaceItemId?: string;
}

/**
 * The ONE projection from a management status row to the join/hold subject.
 *
 * Both the background pass ({@link import('./service.ts').MarketplaceService.updateInstalledBundles})
 * and the user-clicked update resolve their catalog row from this. R81 deleted
 * the write side's private copies of the join and the comparison for exactly
 * this reason: a second projection that dropped, say, `marketplaceItemId` would
 * silently fall back to the name join and could update a same-named plugin from
 * the wrong listing.
 */
export function toInstalledUpdateSubjects(
  installed: readonly PluginManagementInstalledSummary[],
): InstalledUpdateSubject[] {
  return installed.map(entry => ({
    pluginKey: entry.pluginKey,
    pluginId: entry.pluginId,
    marketplaceId: entry.marketplaceId,
    version: entry.version,
    ...(entry.source?.marketplaceItemId ? { marketplaceItemId: entry.source.marketplaceItemId } : {}),
    manifest: {
      name: entry.name,
      ...(entry.dependencies ? { dependencies: entry.dependencies } : {}),
    },
  }));
}

/**
 * Join an installed record to the catalog row it came from.
 *
 * By listing id first, because that is what the install recorded and what
 * `formerIds` (`plugins/host-marketplace.md#migrate-users-with-a-renames-map`'s `renames`) lets survive an upstream
 * rename. The name fallback covers rows installed before ids were stamped; it is
 * scoped to the same marketplace so two marketplaces publishing the same plugin
 * name can never update each other's copy.
 */
export function findCatalogRowForInstalled(
  items: readonly MarketplaceCatalogItem[],
  installed: InstalledUpdateSubject,
): MarketplaceCatalogItem | undefined {
  const itemId = installed.marketplaceItemId;
  const inMarketplace = items.filter(item => item.marketplaceRegistryId === installed.marketplaceId);
  if (itemId) {
    const byId = inMarketplace.find(item => item.id === itemId || item.formerIds?.includes(itemId));
    if (byId) return byId;
  }
  return inMarketplace.find(item => (
    item.name === installed.pluginId || item.name === installed.manifest.name
  ));
}

/**
 * The THREE answers a version comparison can have, because two were not enough
 * (P2.159).
 *
 * `isHigherVersion` used to fold "not newer" and "I cannot order these" into one
 * `false`. The official `claude-security` plugin ships `0.10.2.3`; strict
 * `semver.parse` returns `null` for a four-part string, so
 * `isHigherVersion('0.10.2.3', '0.10.0')` was `false`, `canUpdate` was false for
 * the life of the install, and the plugin was never offered for update. The
 * update that eventually landed did NOT satisfy the comparison — it bypassed it,
 * through `repair` re-materializing a pinned origin whose ref is the moving
 * `main` branch.
 *
 * WHY REFUSE RATHER THAN NORMALIZE. Upstream does specify the scheme, twice, and
 * it is three-part: `plugins/manifest-reference.md#version` types the manifest field as
 * "Optional. Semantic version.", and `:1320` says "If you use explicit versions,
 * follow [semantic versioning](https://semver.org) (`MAJOR.MINOR.PATCH`): bump
 * MAJOR for breaking changes, MINOR for new features, PATCH for bug fixes."
 * (both fetched 2026-08-25). There is no fourth component to order, so any
 * ordering we invented would be ours and not the publisher's — and an update is
 * a code-execution event, so guessing the wrong direction is not a cosmetic
 * error. `semver.coerce` is not the escape hatch either, measured rather than
 * assumed: it maps BOTH `0.10.2.3` and `0.10.2.4` to `0.10.2`, so a coercing
 * comparator could never order two four-part releases against each other and
 * would answer "not newer" for every one of them — the same silence, now with a
 * plausible-looking mechanism in front of it.
 *
 * So an unorderable pair is its own answer, and every caller must name it:
 * the badge withholds and says why, the clicked update REFUSES instead of
 * quietly falling through to a same-version reinstall, and the unattended pass
 * records a named skip instead of an anonymous one.
 */
export type CandidateVersionComparison = 'higher' | 'not-higher' | 'incomparable';

export function compareCandidateVersion(
  candidate: string | undefined,
  current: string,
): CandidateVersionComparison {
  // No candidate at all is "nothing on offer", NOT an unorderable pair: there is
  // no second version to disagree about, and the caller has nothing to report.
  if (!candidate) return 'not-higher';
  const parsedCandidate = parseSemver(candidate);
  const parsedCurrent = parseSemver(current);
  if (!parsedCandidate || !parsedCurrent) return 'incomparable';
  return gt(parsedCandidate, parsedCurrent) ? 'higher' : 'not-higher';
}

/**
 * Whether a version string can be ordered against any other at all.
 *
 * True for the installed side means NO catalog row can ever be newer, whatever
 * the catalog says — which is why the badge can answer this without holding a
 * catalog (see `views.ts`, `actions.reasonCodes`).
 */
export function isUncomparableVersion(version: string | undefined): boolean {
  return !!version && parseSemver(version) === null;
}

/**
 * Strictly-higher semver. Only {@link CandidateVersionComparison} `'higher'` is
 * true, so a caller that keeps using the boolean cannot silently treat an
 * unorderable pair as "nothing newer" — it gets `false` here exactly as before,
 * and the two decision paths that must distinguish the cases read the
 * three-valued function instead.
 */
export function isHigherVersion(candidate: string | undefined, current: string): boolean {
  return compareCandidateVersion(candidate, current) === 'higher';
}

/**
 * The version to advertise for ONE installed plugin, or `undefined` for "nothing
 * to say".
 *
 * Two gates, and the second is the whole reason this is not a one-line
 * comparison:
 *
 * - **Strictly higher, by semver.** Same rule `updateInstalledBundles` moves on.
 *   A catalog listing and its bundle manifest disagreeing about the version is a
 *   known, tolerated skew (`plugin.install.version_mismatch`), so "different"
 *   would badge forever while the update never lands.
 * - **A held plugin is not advertised past its hold.** `plugins/host-marketplace.md#hold-users-on-one-version`
 *   — "The dependency stays at `2.1.0`. Auto-update skips newer versions while
 *   plugin A is installed." and `:150` — "Auto-update fetches a constrained
 *   dependency at the highest git tag that satisfies every installed plugin's
 *   range, rather than at the marketplace's latest version ... If no tag
 *   satisfies all ranges, auto-update skips that dependency". Offering the
 *   catalog's latest for a held plugin would be a control that either does
 *   nothing (auto) or breaks the dependent (manual), so the badge is withheld
 *   whenever the catalog's version is outside the held range.
 *
 * The hold check is deliberately conservative in the other direction too: when
 * the catalog version DOES satisfy the range, the version named here is the
 * catalog's, not the highest satisfying git TAG the write side would resolve.
 * Naming the tag requires a network listing, which this read must never do; the
 * catalog version is an honest floor ("at least this is available, and allowed").
 *
 * `includePrerelease: false` mirrors `plugins/dependencies.ts` and
 * `plugins/version-tags.ts` — `plugins/host-marketplace.md#run-release-channels`'s rule, applied the
 * same way on both sides so a pre-release cannot be advertised into a range that
 * would then refuse it.
 */
export function resolveAvailableUpdateVersion(
  items: readonly MarketplaceCatalogItem[],
  installed: InstalledUpdateSubject,
  held?: HeldDependencyConstraint,
): string | undefined {
  const item = findCatalogRowForInstalled(items, installed);
  if (!item?.version || !isHigherVersion(item.version, installed.version)) return undefined;
  if (held && !satisfies(item.version, held.range, { includePrerelease: false })) return undefined;
  return item.version;
}

/**
 * The whole installed set at once: the versions to advertise, plus the plugins
 * whose versions cannot be ORDERED at all.
 *
 * The second half exists because the first one cannot say why it is empty
 * (P2.159). `versions` omits every plugin with nothing to advertise, which is the
 * ordinary silent result for almost every install — and was also the result for a
 * plugin whose four-part version strict semver refuses, forever, with no way for
 * any surface to tell the two apart. `uncomparable` is that distinction, carried
 * out of the SAME join rather than re-derived: a second pass over the catalog
 * could disagree with this one, and a badge that contradicts the update path is
 * the defect this module's header already forbids.
 *
 * The hold is resolved against the SAME `installed` array — by `pluginId` first
 * and display name second, exactly the order `updateInstalledBundles` uses and
 * the same order the load-time dependency verdict uses.
 */
export interface InstalledUpdateAvailability {
  /** Plugin key -> the version to advertise. Absent means "nothing to say". */
  versions: Map<PluginKey, string>;
  /**
   * Plugin keys whose catalog row and install declare versions that cannot be
   * ordered, so no update can ever be offered until one side ships a semver.
   */
  uncomparable: Set<PluginKey>;
}

export function resolveAvailableUpdateVersions(
  items: readonly MarketplaceCatalogItem[],
  installed: readonly InstalledUpdateSubject[],
): InstalledUpdateAvailability {
  const versions = new Map<PluginKey, string>();
  const uncomparable = new Set<PluginKey>();
  if (items.length === 0) return { versions, uncomparable };
  for (const subject of installed) {
    const held = resolveHeldConstraint(installed, subject.pluginId, subject.marketplaceId)
      ?? resolveHeldConstraint(installed, subject.manifest.name, subject.marketplaceId);
    const item = findCatalogRowForInstalled(items, subject);
    if (compareCandidateVersion(item?.version, subject.version) === 'incomparable') {
      uncomparable.add(subject.pluginKey);
      continue;
    }
    const version = resolveAvailableUpdateVersion(items, subject, held);
    if (version) versions.set(subject.pluginKey, version);
  }
  return { versions, uncomparable };
}

/**
 * What ONE user-clicked update must do — the WRITE counterpart of
 * {@link resolveAvailableUpdateVersion}, decided from the same cached catalog
 * rows the badge was computed from.
 *
 * R88. `PluginManagementServiceV2.update` is `repair` with a caller-supplied
 * source, and its own docstring says so: "Called with no `source`, it therefore
 * re-fetches the version that is already installed. That is a real limit and it
 * is the caller's to fix: this service holds no catalog and must not grow one."
 * The RPC handler was that caller and passed nothing, so the one update a user
 * can actually run reinstalled the version they already had and reported
 * success. The background pass never covered for it: `plugins/loading.md#which-marketplaces-and-plugins-auto-update`
 * makes auto-update OFF the default for "Third-party and local development
 * marketplaces", which is precisely where the badge is the only signal.
 *
 * Deliberately the same shape of decision as the badge, in the same order, off
 * the same rows:
 *
 * - **`current` is not a failure.** A catalog row that is not strictly higher
 *   means there is nothing newer to fetch, and re-materializing the pinned
 *   origin is exactly what the pre-R88 handler did. The badge (`canUpdate`)
 *   withholds the control in that state, so this is reachable only by raw RPC
 *   or by a click racing a catalog refresh — neither is a reason to fail at the
 *   user.
 * - **`no-catalog-row` IS a failure.** Without a row we cannot tell a genuine
 *   update from a same-version reinstall, and reporting "updated" for the
 *   latter is the defect this unit exists to remove. Repair is the honest verb
 *   for "re-fetch what is installed" and it is still there.
 * - **A hold refuses.** `plugins/host-marketplace.md#hold-users-on-one-version`: "The dependency stays at
 *   `2.1.0`. Auto-update skips newer versions while plugin A is installed." The
 *   background pass SKIPS such a plugin; a manual click cannot be allowed to do
 *   what the unattended pass refuses, or one user action breaks the dependent
 *   the hold exists to protect.
 *
 * No network, by construction: the caller peeks an already-resolved catalog
 * (`PluginRegistrySource.peekCachedItems`) and everything here is a join and two
 * comparisons. In particular the held case is answered from the catalog version
 * alone and never resolves the highest satisfying git TAG the way
 * `resolveBundleUpdateTarget` does — that needs a tag listing, and R81's floor
 * ("at least this is available, and allowed") is the same one the badge quotes.
 */
export type InstalledUpdatePlan =
  | { kind: 'update'; version: string; source: PluginInstallSource }
  | { kind: 'current'; version: string }
  /**
   * The catalog row and the install declare versions that cannot be ordered
   * (P2.159). Deliberately NOT folded into `current`: `current` returns `{}`,
   * which `update` reads as `repair`, i.e. re-materialize the pinned origin —
   * and on a moving ref that silently installs whatever the ref points at now.
   * That is precisely how the `claude-security` 0.10.0 -> 0.10.2.3 update
   * landed with `canUpdate` false the whole time. An unorderable pair must
   * refuse and say so, not reinstall by accident.
   */
  | { kind: 'version-uncomparable'; catalogVersion: string; installedVersion: string }
  | { kind: 'held'; version: string; range: string; constrainedBy: string[] }
  | { kind: 'no-catalog-row' }
  | { kind: 'no-install-source' }
  | { kind: 'not-installed' };

export function planInstalledUpdate(
  items: readonly MarketplaceCatalogItem[],
  installed: readonly InstalledUpdateSubject[],
  pluginKey: PluginKey,
): InstalledUpdatePlan {
  const subject = installed.find(entry => entry.pluginKey === pluginKey);
  if (!subject) return { kind: 'not-installed' };
  const item = findCatalogRowForInstalled(items, subject);
  if (!item?.version) return { kind: 'no-catalog-row' };
  const comparison = compareCandidateVersion(item.version, subject.version);
  if (comparison === 'incomparable') {
    return { kind: 'version-uncomparable', catalogVersion: item.version, installedVersion: subject.version };
  }
  if (comparison === 'not-higher') return { kind: 'current', version: item.version };
  const held = resolveHeldConstraint(installed, subject.pluginId, subject.marketplaceId)
    ?? resolveHeldConstraint(installed, subject.manifest.name, subject.marketplaceId);
  if (held && !satisfies(item.version, held.range, { includePrerelease: false })) {
    return {
      kind: 'held',
      version: item.version,
      range: held.range,
      constrainedBy: held.constrainedBy,
    };
  }
  if (!item.structuredInstallSource) return { kind: 'no-install-source' };
  return {
    kind: 'update',
    version: item.version,
    // Same decoration the background pass applies, so an updated bundle keeps
    // joining back to the exact catalog row it came from.
    source: attachMarketplaceListingMetadata(item.structuredInstallSource, item),
  };
}

/**
 * The `options` ONE update call must be given — every caller of
 * {@link import('../plugins/management-types.ts').PluginManagementApi.update},
 * with the failure wording included so no two of them can drift.
 *
 * R88 closed this on the user-clicked RPC path; R88b found the agent's own
 * `plugin_manage` tool was the same no-op (`plugin-management-tools.ts` called
 * `update(pluginKey)` with nothing, and `update` with no `source` is `repair`,
 * i.e. it re-fetches the version already installed and reports success). Rather
 * than a second copy of the switch, the decision lives here once: the two
 * callers are now a single line each, and a third caller cannot be written
 * without inheriting the honest failures.
 *
 * The catalog is PEEKED, never listed. `listItems()` would kick a git clone onto
 * the request path, spend a failed registry's retry budget and write
 * `marketplaces.json` (R81); {@link CachedMarketplaceCatalogReader} is the
 * cached-only read that does none of those, and is deliberately the narrowest
 * type that can answer the question — a caller cannot mutate anything through
 * it. A caller with no reader wired at all sees an empty catalog, which lands on
 * the same honest refusal as an empty cache: we cannot tell an update from a
 * reinstall, so we do not claim one.
 *
 * `current` is the one non-failure that does NOT carry a source: nothing newer
 * exists, so re-materializing the pinned origin is exactly right, and it is what
 * every caller did before R88.
 */
export async function resolveInstalledUpdateOptions(
  catalog: CachedMarketplaceCatalogReader | undefined,
  management: Pick<PluginManagementApi, 'status'>,
  pluginKey: PluginKey,
): Promise<PluginManagementRepairOptions> {
  const items = (await catalog?.peekCachedItems()) ?? [];
  const status = await management.status();
  const plan = planInstalledUpdate(items, toInstalledUpdateSubjects(status.installed), pluginKey);
  switch (plan.kind) {
    case 'update':
      return { source: plan.source };
    // Nothing newer in the catalog: re-materialize the pinned origin, which is
    // what the callers have always done and what the pre-R88 tests pin. The
    // control is withheld in this state (`actions.canUpdate`), so it is
    // reachable only by raw RPC, by an agent tool call, or by a click racing a
    // catalog refresh — none deserves an error.
    case 'current':
      return {};
    case 'not-installed':
      throw new Error('plugin.manage.not-installed');
    case 'version-uncomparable':
      // LOUD, at the one place a user or an agent can ask for this update. The
      // alternative measured worse than an error: falling through to `{}` is
      // `repair`, which on a moving ref installs an arbitrary newer bundle while
      // reporting a same-version reinstall.
      throw new Error(
        `Plugin ${pluginKey} cannot be updated: the marketplace lists ${plan.catalogVersion} and `
        + `${plan.installedVersion} is installed, and at least one of those is not a semantic `
        + 'version (MAJOR.MINOR.PATCH), so they cannot be ordered. Ask the publisher for a '
        + 'semver-tagged release, or use Repair to re-install from the pinned origin.',
      );
    case 'held':
      // `plugins/host-marketplace.md#hold-users-on-one-version` — the background pass SKIPS a held
      // plugin. A manual click must not do what the unattended pass refuses.
      throw new Error(
        `Plugin ${pluginKey} cannot be updated to ${plan.version}: an installed plugin requires `
        + `${plan.range}${plan.constrainedBy.length ? ` (${plan.constrainedBy.join(', ')})` : ''}. `
        + 'Update or uninstall that plugin first.',
      );
    default:
      // `no-catalog-row` / `no-install-source`. Without a catalog row we cannot
      // tell a real update from a same-version reinstall, and claiming
      // "updated" for the latter is the whole defect. Repair is the honest
      // verb for re-fetching what is installed, and it is unaffected.
      throw new Error(
        `Plugin ${pluginKey} has no installable marketplace catalog entry in the local cache, so `
        + 'there is no newer version to fetch. Refresh the marketplace, or use Repair to '
        + 're-install the current version.',
      );
  }
}
