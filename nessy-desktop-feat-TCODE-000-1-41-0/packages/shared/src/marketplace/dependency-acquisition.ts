/**
 * Install-time dependency acquisition — `plugin-dependencies.md`, the half this
 * fork recorded as deliberately absent until now.
 *
 * Page re-fetched 2026-08-07. `:11` has been rewritten since the spec that
 * ordered this work quoted it; the clause about listing added dependencies "at
 * the end of the install output" is gone, and what stands is:
 *
 *   "When you install a plugin that declares dependencies, Claude Code resolves
 *   and installs them automatically. If a dependency later goes missing,
 *   `/reload-plugins` and the background plugin auto-update reinstall it,
 *   provided its marketplace is already in your configured marketplaces.
 *   Re-running `claude plugin install` on the dependent plugin, or adding a
 *   marketplace with `claude plugin marketplace add`, also resolves any
 *   outstanding missing dependencies. **Dependencies from a marketplace you have
 *   not added are left unresolved.**"
 *
 * That last sentence is why `marketplace-not-configured` is its own decision
 * rather than a generic failure: an unconfigured marketplace is a documented
 * resting state, not a broken install, and the remedy is to add the marketplace.
 *
 * This module is the DECISION, one level deep and pure. The caller drives the
 * recursion (install, read the new bundle's own `dependencies`, plan again) and
 * owns every network call, which is what keeps the rules here provable without
 * a fetch mock:
 *
 * - `:44` — a dependency "Resolves within the same marketplace as the declaring
 *   plugin", overridden by `:46`'s `marketplace`.
 * - `:81`/`:104` — a cross-marketplace dependency is REFUSED unless the root
 *   marketplace's `allowCrossMarketplaceDependenciesOn` lists the target, and
 *   the error names the field to set. `:83` — "only its allowlist is consulted,
 *   so trust does not chain through intermediate marketplaces", which is why the
 *   comparison is against the ROOT marketplace and not the declaring one.
 * - `:142` — several dependents' ranges are intersected, and `:147` makes an
 *   empty intersection a `range-conflict` that fails the install rather than a
 *   silent pick.
 * - `:167` — "a dependency pulled in to satisfy an active plugin installs with
 *   `true` regardless of its own default", so the caller activates explicitly.
 */

import {
  intersectDependencyRanges,
  type PluginDependencyError,
  type PluginDependencySubject,
} from '../plugins/dependencies.ts';
import type { PluginDependencyDescriptor, PluginInstallSource } from '../plugins/types.ts';
import { satisfies } from 'semver';

/** The catalog row a dependency resolves to, reduced to what acquisition reads. */
export interface DependencyCatalogRow {
  marketplaceId: string;
  /** The plugin NAME the catalog lists this row under. */
  pluginName: string;
  /** Catalog row id, so the caller can re-find the full item to install. */
  itemId: string;
  version?: string;
  source?: PluginInstallSource;
}

export interface DependencyAcquisitionInput {
  /** The dependencies declared by the plugin being resolved at this level. */
  declared: readonly PluginDependencyDescriptor[];
  /** The marketplace of the plugin that DECLARED them (`:44`). */
  declaringMarketplaceId: string;
  /**
   * The marketplace hosting the plugin the user is installing (`:83` — "The root
   * marketplace is the one that hosts the plugin the user is installing"). Equal
   * to `declaringMarketplaceId` at the first level and preserved through the
   * recursion, because trust must not chain.
   */
  rootMarketplaceId: string;
  /** `:91` — the root marketplace's allowlist. Empty means "refuse every hop". */
  allowCrossMarketplaceDependenciesOn?: readonly string[];
  /** Marketplaces registered on this machine (`:11`'s "already in your configured marketplaces"). */
  configuredMarketplaceIds: readonly string[];
  /** Everything already installed — the skip test and the intersection input. */
  installed: readonly PluginDependencySubject[];
  /** Catalog rows currently visible across every configured marketplace. */
  catalog: readonly DependencyCatalogRow[];
}

export type DependencyAcquisitionDecision =
  /** Already installed at a version every live constraint accepts. Nothing to do. */
  | { action: 'satisfied'; name: string; marketplaceId: string; version: string }
  /** Fetch it. `range` is the INTERSECTED range, not this dependent's own (`:142`). */
  | {
      action: 'install';
      name: string;
      marketplaceId: string;
      itemId: string;
      range?: string;
      /** Present when a differently-versioned copy is already installed (`:214`). */
      installedVersion?: string;
    }
  | { action: 'refuse'; name: string; marketplaceId: string; error: PluginDependencyError; reasonCode: string };

/** `:104` — the error "names the field to set". One spelling, used by every message. */
export const CROSS_MARKETPLACE_ALLOWLIST_FIELD = 'allowCrossMarketplaceDependenciesOn';

export const DEPENDENCY_ACQUISITION_REASON_CODES = {
  crossMarketplace: 'plugin.install.cross_marketplace_dependency',
  marketplaceNotConfigured: 'plugin.install.dependency_marketplace_not_configured',
  notInCatalog: 'plugin.install.dependency_not_in_catalog',
  rangeConflict: 'plugin.install.dependency_range_conflict',
  noMatchingTag: 'plugin.install.dependency_no_matching_tag',
} as const;

/**
 * Plan one level of dependency acquisition.
 *
 * Deterministic and order-preserving: decisions come back in the manifest's own
 * declaration order, because that is the order the install output and the error
 * list read in.
 */
export function planDependencyAcquisition(
  input: DependencyAcquisitionInput,
): DependencyAcquisitionDecision[] {
  const allowlist = new Set(input.allowCrossMarketplaceDependenciesOn ?? []);
  const configured = new Set(input.configuredMarketplaceIds);
  const decisions: DependencyAcquisitionDecision[] = [];

  for (const dependency of input.declared) {
    const marketplaceId = dependency.marketplace ?? input.declaringMarketplaceId;
    const marketplaceField = dependency.marketplace ? { marketplace: dependency.marketplace } : {};

    // `:213` — "a range is not valid semver syntax" is a `range-conflict`, and it
    // is decided before anything is looked up: an unparseable range can never
    // select a version, so resolving the name first would only produce a worse
    // message.
    if (dependency.versionRangeValid === false) {
      decisions.push({
        action: 'refuse',
        name: dependency.name,
        marketplaceId,
        reasonCode: DEPENDENCY_ACQUISITION_REASON_CODES.rangeConflict,
        error: {
          code: 'range-conflict',
          dependency: dependency.name,
          ...(dependency.version ? { range: dependency.version } : {}),
          ...marketplaceField,
        },
      });
      continue;
    }

    // `:81` — the refusal exists so "one marketplace [cannot] silently pull in
    // plugins from a source you have not reviewed". Checked against the ROOT
    // marketplace (`:83`), before the catalog lookup, so a hop into an
    // unreviewed marketplace is refused whether or not that marketplace happens
    // to be registered.
    if (marketplaceId !== input.rootMarketplaceId && !allowlist.has(marketplaceId)) {
      decisions.push({
        action: 'refuse',
        name: dependency.name,
        marketplaceId,
        reasonCode: DEPENDENCY_ACQUISITION_REASON_CODES.crossMarketplace,
        error: {
          code: 'dependency-unsatisfied',
          dependency: dependency.name,
          marketplace: marketplaceId,
          ...(dependency.version ? { range: dependency.version } : {}),
        },
      });
      continue;
    }

    // `:142` — every INSTALLED dependent's range for this same dependency, plus
    // this one's, combined into the range a fetch must satisfy. `:148`'s `=2.1.0`
    // row falls out of this for free: a pinned dependent keeps holding the
    // dependency at its pin while it stays installed.
    const ranges = collectDeclaredRanges(input.installed, dependency.name, marketplaceId);
    if (dependency.version) ranges.push(dependency.version);
    const intersection = intersectDependencyRanges(ranges);
    if (!intersection.ok) {
      decisions.push({
        action: 'refuse',
        name: dependency.name,
        marketplaceId,
        reasonCode: DEPENDENCY_ACQUISITION_REASON_CODES.rangeConflict,
        error: {
          code: 'range-conflict',
          dependency: dependency.name,
          ...(intersection.range ? { range: intersection.range } : {}),
          ...marketplaceField,
        },
      });
      continue;
    }
    const combined = intersection.range === '*' ? undefined : intersection.range;

    const resolved = findInstalled(input.installed, dependency.name, marketplaceId);
    if (resolved && (combined === undefined
      || satisfies(resolved.version, combined, { includePrerelease: false }))) {
      decisions.push({
        action: 'satisfied',
        name: dependency.name,
        marketplaceId,
        version: resolved.version,
      });
      continue;
    }

    const row = input.catalog.find(candidate => (
      candidate.marketplaceId === marketplaceId && candidate.pluginName === dependency.name
    ));
    if (!row) {
      // `:11` — "Dependencies from a marketplace you have not added are left
      // unresolved." Distinguished from "the marketplace is here and does not
      // list it", because only the first has "add the marketplace" as a remedy.
      const configuredMarketplace = configured.has(marketplaceId);
      decisions.push({
        action: 'refuse',
        name: dependency.name,
        marketplaceId,
        reasonCode: configuredMarketplace
          ? DEPENDENCY_ACQUISITION_REASON_CODES.notInCatalog
          : DEPENDENCY_ACQUISITION_REASON_CODES.marketplaceNotConfigured,
        error: {
          code: 'dependency-unsatisfied',
          dependency: dependency.name,
          ...(dependency.marketplace ? { marketplace: dependency.marketplace } : {}),
          ...(combined ? { range: combined } : {}),
        },
      });
      continue;
    }

    decisions.push({
      action: 'install',
      name: dependency.name,
      marketplaceId,
      itemId: row.itemId,
      ...(combined ? { range: combined } : {}),
      // `:214` — a copy outside the range is re-resolved rather than reported,
      // which is exactly what its remedy ("re-resolve the dependency against all
      // current constraints") asks the user to do by hand today.
      ...(resolved ? { installedVersion: resolved.version } : {}),
    });
  }

  return decisions;
}

/**
 * Every range an INSTALLED plugin declares for `name` in `marketplaceId`.
 *
 * `:152` — "When you uninstall the last plugin that constrains a dependency, the
 * dependency is no longer held", which is why this reads the installed set at
 * plan time instead of a persisted hold: uninstalling the constrainer removes
 * its range from the next intersection with no separate bookkeeping to go stale.
 * An unparseable range is skipped here; it is the DECLARING plugin's own
 * `range-conflict` and must not corrupt a third plugin's intersection.
 */
export function collectDeclaredRanges(
  installed: readonly PluginDependencySubject[],
  name: string,
  marketplaceId: string,
): string[] {
  const ranges: string[] = [];
  for (const subject of installed) {
    for (const declared of subject.manifest.dependencies ?? []) {
      if (declared.name !== name) continue;
      if ((declared.marketplace ?? subject.marketplaceId) !== marketplaceId) continue;
      if (declared.versionRangeValid === false) continue;
      if (declared.version) ranges.push(declared.version);
    }
  }
  return ranges;
}

/**
 * `:150` — "Auto-update fetches a constrained dependency at the highest git tag
 * that satisfies every installed plugin's range, rather than at the
 * marketplace's latest version … If no tag satisfies all ranges, auto-update
 * skips that dependency and lists the skip in the `/plugin` Errors tab, **naming
 * the constraining plugin**."
 *
 * The hold on one plugin, plus who is holding it — the names are part of the
 * contract, not a nicety, because a skipped update with no named constrainer is
 * unactionable.
 */
export interface HeldDependencyConstraint {
  range: string;
  /** Display names of the installed plugins whose ranges produced it. */
  constrainedBy: string[];
}

export function resolveHeldConstraint(
  installed: readonly PluginDependencySubject[],
  name: string,
  marketplaceId: string,
): HeldDependencyConstraint | undefined {
  const ranges = collectDeclaredRanges(installed, name, marketplaceId);
  if (ranges.length === 0) return undefined;
  const intersection = intersectDependencyRanges(ranges);
  const constrainedBy = installed
    .filter(subject => (subject.manifest.dependencies ?? []).some(declared => (
      declared.name === name
      && (declared.marketplace ?? subject.marketplaceId) === marketplaceId
      && declared.versionRangeValid !== false
      && Boolean(declared.version)
    )))
    .map(subject => subject.manifest.name);
  // An unsatisfiable intersection still HOLDS the dependency — `:147` keeps the
  // dependency "as [it was]" — so the caller must see a range it cannot match
  // rather than an absent constraint that reads as "free to move".
  return {
    range: intersection.ok ? intersection.range : '<0.0.0-0',
    constrainedBy,
  };
}

/** Same name resolution the load-time verdict uses: `pluginId` first, display name second. */
function findInstalled(
  installed: readonly PluginDependencySubject[],
  name: string,
  marketplaceId: string,
): PluginDependencySubject | undefined {
  return installed.find(subject => (
    subject.marketplaceId === marketplaceId
    && (subject.pluginId === name || subject.manifest.name === name)
  ));
}
