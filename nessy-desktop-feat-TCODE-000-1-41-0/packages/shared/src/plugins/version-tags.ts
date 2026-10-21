/**
 * `{plugin-name}--v{version}` release tags — the version-selection half of
 * `plugin-dependencies.md`.
 *
 * Page re-fetched 2026-08-07 (`curl -sL .../plugin-dependencies.md`); the spec
 * that ordered this work quoted an older revision, and two of its anchors moved.
 * The rules implemented here, quoted from the current page:
 *
 * - `:110` — "Tag each release as `{plugin-name}--v{version}`, where
 *   `{version}` matches the `version` field in that commit's `plugin.json`."
 * - `:125` — "The `--v` separator is parsed as a prefix match on the full plugin
 *   name, so plugin names that contain hyphens are handled correctly." That is
 *   why the prefix here is the WHOLE name plus `--v` and never a split on the
 *   first `--`: `deploy-kit--v1.0.0` belongs to `deploy-kit`, not to `deploy`.
 * - `:127` — "Claude Code lists the marketplace's tags, filters to those
 *   starting with `secrets-vault--v`, and fetches the highest version satisfying
 *   `~2.1.0`. If no matching tag exists, the dependent plugin is disabled with
 *   an error listing the available versions." The available-versions list is
 *   part of the failure, not decoration, so {@link selectPluginVersionTag}
 *   returns it.
 * - `:48` — "Pre-release versions such as `2.0.0-beta.1` are excluded unless
 *   your range opts in with a pre-release suffix like `^2.0.0-0`", which is
 *   `includePrerelease: false`. A tag whose version is a pre-release is still
 *   LISTED as available: `:127`'s error lists what the repository has, and
 *   hiding the pre-releases there would make "no matching tag" unexplainable to
 *   someone looking at the tag list.
 * - `:134` — "The resolved tag's semver is recorded separately from
 *   `plugin.json`'s `version`, so constraint checks use the tag that was
 *   actually fetched even if `plugin.json` at that commit has a stale value."
 *   Hence {@link PluginVersionTag} carries `version` from the TAG, and the
 *   commit sha travels with it for the cache-directory suffix the same line
 *   describes.
 *
 * Pure. The network half (listing a repository's tags) lives in
 * `acquisition.ts`, which owns the artifact auth provider and the fetch
 * seam; this module is what decides, and it decides the same way for a GitHub
 * repository, a GitLab project and a local git folder.
 */

import { parse as parseSemverStrict, rcompare, satisfies } from 'semver';

/** One `{plugin-name}--v{version}` tag that parsed as semver. */
export interface PluginVersionTag {
  /** The tag name exactly as the repository spells it. */
  tag: string;
  /** The semver taken from the tag suffix — `:134`'s separately-recorded value. */
  version: string;
  /** Commit the tag points at, when the listing carried one (`:134`'s cache suffix). */
  commitSha?: string;
}

/** A repository tag as a lister reports it, before any plugin filtering. */
export interface RepositoryTagRef {
  name: string;
  commitSha?: string;
}

export type PluginVersionTagSelection =
  | { ok: true; selected: PluginVersionTag; available: string[] }
  /**
   * `:127`/`:215` — no `{name}--v*` tag satisfies the range. `available` is the
   * list the error must print, newest first; it is empty when the repository
   * carries no tag for this plugin at all.
   */
  | { ok: false; code: 'no-matching-tag'; available: string[] };

/**
 * `:125` — the prefix is the FULL plugin name plus the `--v` separator.
 *
 * Exported because the refusal message quotes it ("filters to those starting
 * with `secrets-vault--v`") and a second spelling of the same string is exactly
 * how that message drifts away from what the filter actually did.
 */
export function pluginVersionTagPrefix(pluginName: string): string {
  return `${pluginName}--v`;
}

/**
 * Every tag that belongs to `pluginName` and parses as semver, newest first.
 *
 * A tag whose suffix is not valid semver is DROPPED rather than reported: the
 * page's convention is the contract for participation, and a repository is free
 * to carry unrelated tags. What is not dropped is a pre-release — see the file
 * header for why it stays in the available list.
 */
export function parsePluginVersionTags(
  tags: readonly RepositoryTagRef[],
  pluginName: string,
): PluginVersionTag[] {
  const prefix = pluginVersionTagPrefix(pluginName);
  const parsed: PluginVersionTag[] = [];
  for (const tag of tags) {
    if (!tag.name.startsWith(prefix)) continue;
    const suffix = tag.name.slice(prefix.length);
    // `parse` is strict on purpose: `v2.1.0` after a `--v` separator would mean
    // the tag is `name--vv2.1.0`, which is not the documented convention.
    const semver = parseSemverStrict(suffix);
    if (!semver) continue;
    parsed.push({
      tag: tag.name,
      version: semver.version,
      ...(tag.commitSha ? { commitSha: tag.commitSha } : {}),
    });
  }
  return parsed.sort((a, b) => rcompare(a.version, b.version));
}

/**
 * `:45`/`:127` — "The dependency is fetched at the highest tagged version that
 * satisfies this range."
 *
 * An absent range means "whatever version that plugin's marketplace provides"
 * (`:40`), which among tags is the highest one. It is NOT an error to have no
 * range; it IS an error to have a range nothing satisfies, and that error must
 * carry the available versions.
 */
export function selectPluginVersionTag(
  tags: readonly RepositoryTagRef[],
  pluginName: string,
  range?: string,
): PluginVersionTagSelection {
  const candidates = parsePluginVersionTags(tags, pluginName);
  const available = candidates.map(candidate => candidate.version);
  if (candidates.length === 0) return { ok: false, code: 'no-matching-tag', available };
  if (range === undefined) return { ok: true, selected: candidates[0]!, available };
  const selected = candidates.find(candidate => (
    // `:48` — pre-releases are excluded unless the range opts in.
    satisfies(candidate.version, range, { includePrerelease: false })
  ));
  if (!selected) return { ok: false, code: 'no-matching-tag', available };
  return { ok: true, selected, available };
}
