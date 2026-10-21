import { describe, expect, it } from 'bun:test';
import {
  parsePluginVersionTags,
  pluginVersionTagPrefix,
  selectPluginVersionTag,
} from '../version-tags.ts';
import { describePluginDependencyError, intersectDependencyRanges } from '../dependencies.ts';

/**
 * `plugin-dependencies.md` § Tag plugin releases for version resolution, page
 * re-fetched 2026-08-07.
 */
describe('plugin version tags', () => {
  it('filters on the FULL plugin name, so a hyphenated name is not split at the first --v (:125)', () => {
    // `:125` — "The `--v` separator is parsed as a prefix match on the full
    // plugin name, so plugin names that contain hyphens are handled correctly."
    // The negative half is the point: `deploy--v9.9.9` is a DIFFERENT plugin's
    // tag and must not be offered for `deploy-kit`.
    const tags = [
      { name: 'deploy-kit--v1.0.0' },
      { name: 'deploy-kit--v2.3.1' },
      { name: 'deploy--v9.9.9' },
      { name: 'v1.2.3' },
      { name: 'deploy-kit--vnot-semver' },
    ];

    expect(pluginVersionTagPrefix('deploy-kit')).toBe('deploy-kit--v');
    expect(parsePluginVersionTags(tags, 'deploy-kit')).toEqual([
      { tag: 'deploy-kit--v2.3.1', version: '2.3.1' },
      { tag: 'deploy-kit--v1.0.0', version: '1.0.0' },
    ]);
    expect(parsePluginVersionTags(tags, 'deploy')).toEqual([
      { tag: 'deploy--v9.9.9', version: '9.9.9' },
    ]);
  });

  it('fetches the highest satisfying tag and carries its commit sha (:45, :134)', () => {
    const selection = selectPluginVersionTag(
      [
        { name: 'secrets-vault--v2.1.0', commitSha: 'aaa' },
        { name: 'secrets-vault--v2.1.7', commitSha: 'bbb' },
        { name: 'secrets-vault--v2.2.0', commitSha: 'ccc' },
      ],
      'secrets-vault',
      '~2.1.0',
    );

    expect(selection).toEqual({
      ok: true,
      selected: { tag: 'secrets-vault--v2.1.7', version: '2.1.7', commitSha: 'bbb' },
      available: ['2.2.0', '2.1.7', '2.1.0'],
    });
  });

  it('excludes a pre-release unless the range opts in, and still lists it as available (:48, :127)', () => {
    const tags = [{ name: 'vault--v2.0.0-beta.1' }, { name: 'vault--v1.9.0' }];

    // `:48` — "Pre-release versions such as `2.0.0-beta.1` are excluded unless
    // your range opts in with a pre-release suffix like `^2.0.0-0`."
    const refused = selectPluginVersionTag(tags, 'vault', '^2.0.0');
    expect(refused).toEqual({ ok: false, code: 'no-matching-tag', available: ['2.0.0-beta.1', '1.9.0'] });

    const optedIn = selectPluginVersionTag(tags, 'vault', '^2.0.0-0');
    expect(optedIn.ok).toBe(true);
    expect(optedIn.ok && optedIn.selected.version).toBe('2.0.0-beta.1');
  });

  it('is no-matching-tag with the available list when nothing satisfies, and the message prints it (:127, :215)', () => {
    const selection = selectPluginVersionTag(
      [{ name: 'vault--v1.0.0' }, { name: 'vault--v1.4.2' }],
      'vault',
      '~2.1.0',
    );

    expect(selection).toEqual({ ok: false, code: 'no-matching-tag', available: ['1.4.2', '1.0.0'] });
    // `:127` — "the dependent plugin is disabled with an error listing the
    // available versions". The list IS the message, not decoration.
    const message = describePluginDependencyError({
      code: 'no-matching-tag',
      dependency: 'vault',
      range: '~2.1.0',
      availableVersions: selection.ok ? [] : selection.available,
    });
    expect(message).toContain('vault--v<version>');
    expect(message).toContain('1.4.2, 1.0.0');
  });

  it('takes the highest tag when the dependency declares no range (:40)', () => {
    const selection = selectPluginVersionTag(
      [{ name: 'audit-logger--v1.0.0' }, { name: 'audit-logger--v3.2.0' }],
      'audit-logger',
    );

    expect(selection.ok && selection.selected.version).toBe('3.2.0');
  });

  it('reports no-matching-tag with an empty list when the repository tags nothing for the plugin', () => {
    expect(selectPluginVersionTag([{ name: 'v1.0.0' }], 'vault', '^1.0.0'))
      .toEqual({ ok: false, code: 'no-matching-tag', available: [] });
  });
});

/** `plugin-dependencies.md` § How constraints interact (`:142`-`:150`, `:213`). */
describe('dependency range intersection', () => {
  it('combines ^2.0 and >=2.1 into a range only the higher 2.x satisfies (:146)', () => {
    const result = intersectDependencyRanges(['^2.0', '>=2.1']);

    expect(result).toEqual({ ok: true, range: '^2.0 >=2.1' });
  });

  it('refuses ~2.1 against ~3.0 as unsatisfiable rather than picking a side (:147)', () => {
    // `:147` — "Install of plugin B fails with `range-conflict`. Plugin A and
    // the dependency stay as they were." Picking either side would load one
    // dependent against a version it declared it cannot use.
    expect(intersectDependencyRanges(['~2.1', '~3.0'])).toEqual({
      ok: false,
      cause: 'unsatisfiable',
      range: '~2.1 ~3.0',
    });
  });

  it('names invalid syntax as its own cause (:213)', () => {
    expect(intersectDependencyRanges(['^2.0', 'not-a-range'])).toEqual({
      ok: false,
      cause: 'invalid-syntax',
      range: 'not-a-range',
    });
  });

  it('names a too-complex combination rather than attempting it (:213)', () => {
    const result = intersectDependencyRanges([
      '1 || 2 || 3 || 4',
      '5 || 6 || 7 || 8',
      '9 || 10 || 11',
    ]);

    expect(result).toEqual({ ok: false, cause: 'too-complex' });
  });

  it('treats no declared range as the unconstrained range', () => {
    expect(intersectDependencyRanges([])).toEqual({ ok: true, range: '*' });
  });
});
