/**
 * Declared plugin-dependency evaluation (B1e).
 *
 * `plugins/host-marketplace.md#depend-on-and-recommend-other-plugins` — the load-time half of the dependency
 * contract: "Claude Code disables the affected plugin until you resolve the
 * error", and `claude plugin list --json` reports the problems in an `errors`
 * field that clean plugins omit.
 *
 * Deliberately pure and store-shaped rather than resolver-shaped, because it has
 * two readers that see different worlds: the capability resolver, which knows a
 * full activation context, and the CLI inventory, which knows only the global
 * policy layer. One implementation means the CLI and the app can never disagree
 * about whether a plugin's dependencies are satisfied.
 *
 * The acquisition half — tag enumeration (`version-tags.ts`), install-time
 * resolution and cross-marketplace refusal (`marketplace/dependency-acquisition.ts`)
 * — used to be recorded here as deliberately absent. It is built now; this
 * module stayed the LOAD-TIME verdict and gained the two pieces acquisition
 * needs from it: `no-matching-tag` as a fourth code (`:215`) and
 * {@link intersectDependencyRanges} for `:142`'s "Claude Code intersects their
 * ranges and resolves the dependency to the highest version that satisfies all
 * of them".
 */

import { satisfies, subset, validRange } from 'semver';
import type { NessyPluginManifest, PluginKey } from './types.ts';

/**
 * One descriptive dependency problem for `plugin list`'s `errors` field (`:217`).
 *
 * The four codes are exactly `:210`-`:215`'s table. `no-matching-tag` is the
 * acquisition failure `:127` describes — "If no matching tag exists, the
 * dependent plugin is disabled with an error listing the available versions" —
 * so it is the one code that carries a list rather than a single version.
 */
export interface PluginDependencyError {
  code:
    | 'dependency-unsatisfied'
    | 'dependency-version-unsatisfied'
    | 'range-conflict'
    | 'no-matching-tag';
  /** The declared dependency's plugin name, exactly as the manifest wrote it. */
  dependency: string;
  marketplace?: string;
  range?: string;
  installedVersion?: string;
  /** `:127`/`:215` — the versions the repository does tag, newest first. */
  availableVersions?: string[];
}

/** The subset of an installed record dependency resolution needs. */
export interface PluginDependencySubject {
  pluginKey: PluginKey;
  pluginId: string;
  marketplaceId: string;
  version: string;
  manifest: Pick<NessyPluginManifest, 'name' | 'dependencies'>;
}

/**
 * Every subject's unsatisfied dependencies, keyed by plugin key.
 *
 * Resolution is by plugin NAME within a marketplace (`:44` — "Resolves within the
 * same marketplace as the declaring plugin", overridden by `:46`'s `marketplace`).
 * `pluginId` is matched first because that is what a Claude bundle's `plugin.json`
 * `name` becomes at import; the display `manifest.name` is a fallback so a
 * plugin renamed for display still resolves.
 *
 * `isPolicyEnabled` answers "would policy alone activate this plugin here". The
 * pass then iterates to a fixpoint, because `:212` counts a dependency that is
 * "installed but disabled" as unsatisfied and a plugin disabled for its OWN
 * missing dependency is disabled — a single pass would let a three-deep chain
 * load its head.
 */
export function resolvePluginDependencyErrors(
  subjects: readonly PluginDependencySubject[],
  isPolicyEnabled: (subject: PluginDependencySubject) => boolean,
): Map<PluginKey, PluginDependencyError[]> {
  const errors = new Map<PluginKey, PluginDependencyError[]>();
  const declaring = subjects.filter(subject => (subject.manifest.dependencies?.length ?? 0) > 0);
  if (declaring.length === 0) return errors;

  const enabled = new Map<PluginKey, boolean>();
  for (const subject of subjects) enabled.set(subject.pluginKey, isPolicyEnabled(subject));

  const find = (name: string, marketplaceId: string) => subjects.find(subject => (
    subject.marketplaceId === marketplaceId
    && (subject.pluginId === name || subject.manifest.name === name)
  ));

  // Bounded by the count of dependency-declaring plugins: each round can only
  // ever disable one more, so the fixpoint is reached within that many rounds.
  for (let round = 0; round <= declaring.length; round += 1) {
    let changed = false;
    for (const subject of declaring) {
      const found: PluginDependencyError[] = [];
      for (const dependency of subject.manifest.dependencies ?? []) {
        const marketplace = dependency.marketplace ? { marketplace: dependency.marketplace } : {};
        const range = dependency.version ? { range: dependency.version } : {};
        // `:213` — an unparseable range is a `range-conflict` that disables the
        // plugin, so it is never silently treated as "no constraint".
        if (dependency.versionRangeValid === false) {
          found.push({ code: 'range-conflict', dependency: dependency.name, ...range, ...marketplace });
          continue;
        }
        const resolved = find(dependency.name, dependency.marketplace ?? subject.marketplaceId);
        const unsatisfied: PluginDependencyError = {
          code: 'dependency-unsatisfied',
          dependency: dependency.name,
          ...range,
          ...marketplace,
        };
        if (!resolved) {
          found.push(unsatisfied);
          continue;
        }
        // `:212` — "not installed, OR it is installed but disabled". Its own
        // unresolved dependencies count as disabled, which is what makes this a
        // fixpoint rather than one pass.
        if (enabled.get(resolved.pluginKey) !== true || (errors.get(resolved.pluginKey)?.length ?? 0) > 0) {
          found.push(unsatisfied);
          continue;
        }
        // `:137` and `:214` — the constraint is checked at load time even where
        // tag-based fetching does not apply, and the dependent plugin is disabled
        // with `dependency-version-unsatisfied` when the installed version falls
        // outside it. `includePrerelease: false` is `:48`'s rule: "Pre-release
        // versions … are excluded unless your range opts in".
        if (dependency.version !== undefined
          && !satisfies(resolved.version, dependency.version, { includePrerelease: false })) {
          found.push({
            code: 'dependency-version-unsatisfied',
            dependency: dependency.name,
            range: dependency.version,
            installedVersion: resolved.version,
            ...marketplace,
          });
        }
      }
      const previous = errors.get(subject.pluginKey) ?? [];
      if (found.length !== previous.length) changed = true;
      if (found.length > 0) errors.set(subject.pluginKey, found);
      else errors.delete(subject.pluginKey);
    }
    if (!changed) break;
  }
  return errors;
}

/**
 * `:208` — the problems appear "as descriptive error messages rather than the
 * literal codes in this table"; `:212`/`:214`/`:213` give the remedy each carries.
 */
export function describePluginDependencyError(error: PluginDependencyError): string {
  const target = error.marketplace ? `${error.dependency}@${error.marketplace}` : error.dependency;
  switch (error.code) {
    case 'dependency-unsatisfied':
      return `This plugin requires ${target}, which is not installed or is disabled. Install it, or enable it if it is already installed.`;
    case 'dependency-version-unsatisfied':
      return `This plugin requires ${target} ${error.range}, but version ${error.installedVersion} is installed. Reinstall ${target} to re-resolve it against all current constraints.`;
    case 'range-conflict':
      return `This plugin declares "${error.range}" for ${target}, which is not a valid version range. Ask the plugin author to fix it.`;
    // `:127` — "the dependent plugin is disabled with an error listing the
    // available versions", and `:215`'s remedy is to check the upstream tags or
    // relax the range. The list is the whole point of this message: without it
    // the reader cannot tell a mistyped range from an untagged repository.
    case 'no-matching-tag':
      return `No ${target} release is tagged "${error.dependency}--v<version>" matching ${error.range ?? 'any version'}. `
        + (error.availableVersions?.length
          ? `Available: ${error.availableVersions.join(', ')}. Relax the range, or ask the upstream to tag a matching release.`
          : 'The repository has no tagged release for this plugin. Ask the upstream to tag one using that convention.');
  }
}

export type DependencyRangeIntersection =
  | { ok: true; range: string }
  /**
   * `:213` names exactly three causes, and the error message has to say which:
   * "no version satisfies all of the ranges, a range is not valid semver
   * syntax, or the combined ranges are too complex to intersect".
   */
  | { ok: false; cause: 'unsatisfiable' | 'invalid-syntax' | 'too-complex'; range?: string };

/** `semver.subset` refuses to reason past this many `||` alternatives (`:213`'s third cause). */
const MAX_INTERSECTABLE_RANGE_ALTERNATIVES = 8;

/**
 * `:142` — "When several installed plugins constrain the same dependency,
 * Claude Code intersects their ranges and resolves the dependency to the
 * highest version that satisfies all of them."
 *
 * Returns the COMBINED range rather than a version, because the version is a
 * property of the tag list and this module never sees one. The combination is
 * plain conjunction — semver's own space-separated comparator syntax — which is
 * what makes `^2.0` + `>=2.1` resolve to "the highest `2.x` at or above 2.1.0"
 * (`:146`) with no bespoke interval arithmetic.
 *
 * Emptiness is detected with `subset(combined, '<0.0.0-0')`: a range that is a
 * subset of the empty range has no member. That is `:147`'s `~2.1` + `~3.0`
 * case, and it is a REFUSAL rather than a silent pick, because picking either
 * side would load one dependent against a version it declared it cannot use.
 */
export function intersectDependencyRanges(ranges: readonly string[]): DependencyRangeIntersection {
  // De-duplicated because the same constraint reaches this from two directions:
  // the plugin being resolved declares it, and that plugin is ALSO in the
  // installed set by the time acquisition runs. `~2.1.0` intersected with itself
  // is `~2.1.0`, and a repeated comparator in the combined range would leak into
  // the `range-conflict` message as `~2.1.0 ~2.1.0`.
  const declared = [...new Set(ranges.filter(range => range.trim().length > 0))];
  if (declared.length === 0) return { ok: true, range: '*' };
  for (const range of declared) {
    if (validRange(range) === null) return { ok: false, cause: 'invalid-syntax', range };
  }
  const alternatives = declared.reduce(
    (total, range) => total * (range.split('||').length),
    1,
  );
  if (alternatives > MAX_INTERSECTABLE_RANGE_ALTERNATIVES) {
    return { ok: false, cause: 'too-complex' };
  }
  const combined = declared.join(' ');
  if (validRange(combined) === null) return { ok: false, cause: 'invalid-syntax', range: combined };
  try {
    if (subset(combined, '<0.0.0-0', { includePrerelease: true })) {
      return { ok: false, cause: 'unsatisfiable', range: combined };
    }
  } catch {
    return { ok: false, cause: 'too-complex', range: combined };
  }
  return { ok: true, range: combined };
}
