import { describe, expect, it } from 'bun:test';
import {
  MAX_SETUP_SCRIPT_LENGTH,
  WORKTREE_SETTINGS_DEFAULTS,
  parseWorktreeSettingsV1,
  resolveWorktreeSettings,
  selectWorktreeSetupScript,
} from '../worktree-settings.ts';

describe('parseWorktreeSettingsV1', () => {
  it('parses the four documented keys', () => {
    expect(parseWorktreeSettingsV1({
      baseRef: 'head',
      symlinkDirectories: ['node_modules', '.cache'],
      sparsePaths: ['packages/shared', 'docs'],
      bgIsolation: 'worktree',
    })).toEqual({
      baseRef: 'head',
      symlinkDirectories: ['node_modules', '.cache'],
      sparsePaths: ['packages/shared', 'docs'],
      bgIsolation: 'worktree',
    });
  });

  it('throws on an unknown key, exactly as the sandbox parser does', () => {
    // Control for the fifth key: widening a parser that THROWS on unknown keys
    // is the one change that can quietly turn it into a parser that shrugs.
    expect(() => parseWorktreeSettingsV1({ baseRefs: 'fresh' })).toThrow(/invalid worktree setting: baseRefs/);
    expect(() => parseWorktreeSettingsV1({ location: '/tmp/wt' })).toThrow(/invalid worktree setting/);
    expect(() => parseWorktreeSettingsV1({ setupScripts: 'bun install' })).toThrow(/invalid worktree setting: setupScripts/);
    expect(() => parseWorktreeSettingsV1({ postCreateCommand: 'bun install' })).toThrow(/invalid worktree setting: postCreateCommand/);
  });

  it('takes a setup script and hands back the exact string, trimmed', () => {
    expect(parseWorktreeSettingsV1({ setupScript: '  bun install && bun run build\n' }))
      .toEqual({ setupScript: 'bun install && bun run build' });
    // A newline inside the script is content, not a delimiter: a multi-line
    // setup script is the normal shape and rides one argv element.
    expect(parseWorktreeSettingsV1({ setupScript: 'set -e\nbun install' }).setupScript)
      .toBe('set -e\nbun install');
  });

  it('refuses a bad setup script instead of dropping it to "no script"', () => {
    // Blank would be the one value that silently disabled the key.
    expect(() => parseWorktreeSettingsV1({ setupScript: '' })).toThrow(/invalid worktree setupScript/);
    expect(() => parseWorktreeSettingsV1({ setupScript: '   \n ' })).toThrow(/invalid worktree setupScript/);
    expect(() => parseWorktreeSettingsV1({ setupScript: 42 })).toThrow(/invalid worktree setupScript/);
    expect(() => parseWorktreeSettingsV1({ setupScript: ['bun', 'install'] })).toThrow(/invalid worktree setupScript/);
    // A NUL cannot cross an argv boundary intact — it would truncate the
    // command that eventually runs, which is the worst possible silence here.
    expect(() => parseWorktreeSettingsV1({ setupScript: 'bun install\u0000; rm -rf /' }))
      .toThrow(/invalid worktree setupScript/);
    expect(() => parseWorktreeSettingsV1({ setupScript: 'x'.repeat(MAX_SETUP_SCRIPT_LENGTH + 1) }))
      .toThrow(/invalid worktree setupScript/);
    expect(parseWorktreeSettingsV1({ setupScript: 'x'.repeat(MAX_SETUP_SCRIPT_LENGTH) }).setupScript)
      .toHaveLength(MAX_SETUP_SCRIPT_LENGTH);
  });

  it('rejects a branch name for baseRef', () => {
    // settings.md gives two values. A ref here would create worktrees off
    // something no other tier can reason about.
    expect(() => parseWorktreeSettingsV1({ baseRef: 'main' })).toThrow(/invalid worktree baseRef/);
    expect(() => parseWorktreeSettingsV1({ baseRef: 'origin/main' })).toThrow(/invalid worktree baseRef/);
  });

  it('rejects an unknown bgIsolation value', () => {
    expect(() => parseWorktreeSettingsV1({ bgIsolation: 'always' })).toThrow(/invalid worktree bgIsolation/);
  });

  it('refuses a path list that leaves the repository', () => {
    for (const key of ['symlinkDirectories', 'sparsePaths']) {
      expect(() => parseWorktreeSettingsV1({ [key]: ['/etc'] }), key).toThrow(/not-relative/);
      expect(() => parseWorktreeSettingsV1({ [key]: ['../secrets'] }), key).toThrow(/escapes-repository/);
      expect(() => parseWorktreeSettingsV1({ [key]: ['a/../../b'] }), key).toThrow(/escapes-repository/);
      expect(() => parseWorktreeSettingsV1({ [key]: [''] }), key).toThrow(/invalid worktree/);
      expect(() => parseWorktreeSettingsV1({ [key]: 'node_modules' }), key).toThrow(/invalid worktree/);
    }
  });

  it('omits absent keys rather than materializing defaults', () => {
    expect(parseWorktreeSettingsV1({})).toEqual({});
  });
});

describe('resolveWorktreeSettings', () => {
  it('defaults to fresh and to our own bgIsolation choice', () => {
    expect(resolveWorktreeSettings([])).toEqual(WORKTREE_SETTINGS_DEFAULTS);
    // The one deliberate divergence from the documented default.
    expect(WORKTREE_SETTINGS_DEFAULTS.bgIsolation).toBe('none');
    expect(WORKTREE_SETTINGS_DEFAULTS.baseRef).toBe('fresh');
  });

  it('takes the most specific baseRef and concats the path lists', () => {
    expect(resolveWorktreeSettings([
      { baseRef: 'fresh', symlinkDirectories: ['node_modules'], sparsePaths: ['docs'] },
      { baseRef: 'head', symlinkDirectories: ['.cache', 'node_modules'] },
    ])).toEqual({
      baseRef: 'head',
      symlinkDirectories: ['node_modules', '.cache'],
      sparsePaths: ['docs'],
      bgIsolation: 'none',
      // P6.336 — automatic deletion stays ON by default, which is what shipped.
      autoRemove: true,
    });
  });

  it('has no setup script by default and takes the most specific one declared', () => {
    expect(resolveWorktreeSettings([]).setupScript).toBeUndefined();
    expect(WORKTREE_SETTINGS_DEFAULTS.setupScript).toBeUndefined();
    // Last-wins like baseRef: a command has no more-restrictive form, and the
    // consent card — keyed on the script itself — is what actually gates it.
    expect(resolveWorktreeSettings([
      { setupScript: 'bun install' },
      { setupScript: 'make bootstrap' },
    ]).setupScript).toBe('make bootstrap');
    expect(resolveWorktreeSettings([{ setupScript: 'bun install' }, {}]).setupScript)
      .toBe('bun install');
    expect(() => resolveWorktreeSettings([{ setupScript: '' }])).toThrow(/invalid worktree setupScript/);
  });

  it('lets any layer tighten bgIsolation and no layer relax it', () => {
    // Restricting key: same "tighter wins" direction as allowManagedDomainsOnly.
    expect(resolveWorktreeSettings([{ bgIsolation: 'worktree' }, { bgIsolation: 'none' }]).bgIsolation)
      .toBe('worktree');
    expect(resolveWorktreeSettings([{ bgIsolation: 'none' }, { bgIsolation: 'worktree' }]).bgIsolation)
      .toBe('worktree');
  });

  it('validates every layer even when an outer one already decided', () => {
    expect(() => resolveWorktreeSettings([{ bgIsolation: 'worktree' }, { baseRef: 'main' } as never]))
      .toThrow(/invalid worktree baseRef/);
    expect(() => resolveWorktreeSettings([{ nope: 1 } as never])).toThrow(/invalid worktree setting: nope/);
  });
});

/**
 * P6.60 — one setup-script string was handed to `cmd.exe` and to `/bin/sh`
 * alike, so a user with both machines could declare a script for exactly one.
 *
 * The row said `worktrees.md` documents a per-platform shape. It does not: that
 * page has no setup-script setting at all (its § Set up the worktree
 * environment says to run your project's setup yourself), `settings-reference.md`
 * documents four `worktree.*` keys and no platform-keyed object anywhere on the
 * page, and codex's own setup scripts are a single Bash script in a Linux
 * container. So this shape is DECIDED where the documentation is silent, and
 * these tests pin the decision rather than a citation.
 *
 * Every assertion below names the platform explicitly, because the interesting
 * half of this feature is the one the machine running the suite is not.
 */
describe('P6.60 — a setup script per interpreter', () => {
  it('accepts the object form and refuses a bucket no interpreter answers to', () => {
    expect(parseWorktreeSettingsV1({ setupScript: { windows: 'pnpm i', posix: 'bun install' } }))
      .toEqual({ setupScript: { windows: 'pnpm i', posix: 'bun install' } });
    // A typo or an over-specific platform name is REFUSED, not dropped: dropping
    // it would run nothing on the platform the user believed they had covered,
    // which is the defect this shape exists to close.
    expect(() => parseWorktreeSettingsV1({ setupScript: { darwin: 'bun install' } }))
      .toThrow(/invalid worktree setupScript platform: darwin/);
    expect(() => parseWorktreeSettingsV1({ setupScript: { win32: 'pnpm i' } }))
      .toThrow(/invalid worktree setupScript platform: win32/);
  });

  it('applies every string rule to each bucket, and refuses an empty declaration', () => {
    expect(parseWorktreeSettingsV1({ setupScript: { posix: '  bun install\n' } }))
      .toEqual({ setupScript: { posix: 'bun install' } });
    expect(() => parseWorktreeSettingsV1({ setupScript: { posix: '   ' } }))
      .toThrow(/invalid worktree setupScript/);
    expect(() => parseWorktreeSettingsV1({ setupScript: { windows: 'pnpm i\u0000; del /q *' } }))
      .toThrow(/invalid worktree setupScript/);
    expect(() => parseWorktreeSettingsV1({ setupScript: { windows: 'x'.repeat(MAX_SETUP_SCRIPT_LENGTH + 1) } }))
      .toThrow(/invalid worktree setupScript/);
    // `{}` is blank's twin: the one value that would silently disable the key.
    expect(() => parseWorktreeSettingsV1({ setupScript: {} }))
      .toThrow(/invalid worktree setupScript/);
    expect(() => parseWorktreeSettingsV1({ setupScript: { windows: undefined } }))
      .toThrow(/invalid worktree setupScript/);
    expect(() => parseWorktreeSettingsV1({ setupScript: null })).toThrow(/invalid worktree setupScript/);
  });

  it('resolves the bucket for the host, on both platforms', () => {
    const layers = [{ setupScript: { windows: 'pnpm i', posix: 'bun install' } }];
    expect(resolveWorktreeSettings(layers, { platform: 'win32' }).setupScript).toBe('pnpm i');
    expect(resolveWorktreeSettings(layers, { platform: 'darwin' }).setupScript).toBe('bun install');
    expect(resolveWorktreeSettings(layers, { platform: 'linux' }).setupScript).toBe('bun install');
  });

  it('leaves a string meaning BOTH platforms, so no existing config changes', () => {
    expect(resolveWorktreeSettings([{ setupScript: 'bun install' }], { platform: 'win32' }).setupScript)
      .toBe('bun install');
    expect(resolveWorktreeSettings([{ setupScript: 'bun install' }], { platform: 'darwin' }).setupScript)
      .toBe('bun install');
    expect(selectWorktreeSetupScript('bun install', 'win32')).toBe('bun install');
  });

  it('resolves to NO script when only the other platform is declared', () => {
    // Deliberate silence, module note: the user scoped it themselves, so there
    // is no "did it run?" ambiguity for the transcript to resolve.
    expect(resolveWorktreeSettings([{ setupScript: { windows: 'pnpm i' } }], { platform: 'darwin' }).setupScript)
      .toBeUndefined();
    expect(resolveWorktreeSettings([{ setupScript: { posix: 'bun install' } }], { platform: 'win32' }).setupScript)
      .toBeUndefined();
  });

  it('replaces the WHOLE declaration across layers, never one bucket of it', () => {
    // A later layer declaring only `windows` does not inherit the outer layer's
    // `posix`. Per-bucket merging would make "which script did I approve on this
    // machine" a two-file question.
    const layers = [
      { setupScript: { windows: 'pnpm i', posix: 'bun install' } },
      { setupScript: { windows: 'pnpm i --frozen-lockfile' } },
    ];
    expect(resolveWorktreeSettings(layers, { platform: 'win32' }).setupScript)
      .toBe('pnpm i --frozen-lockfile');
    expect(resolveWorktreeSettings(layers, { platform: 'darwin' }).setupScript).toBeUndefined();
  });

  it('validates a bad object in a layer an outer one already overrode', () => {
    expect(() => resolveWorktreeSettings([{ setupScript: { nope: 'x' } as never }, { setupScript: 'bun install' }]))
      .toThrow(/invalid worktree setupScript platform: nope/);
  });

  it('defaults the platform to this host when the caller names none', () => {
    // The production callers pass no platform, so the default has to be real.
    const both = { setupScript: { windows: 'pnpm i', posix: 'bun install' } };
    const expected = process.platform === 'win32' ? 'pnpm i' : 'bun install';
    expect(resolveWorktreeSettings([both]).setupScript).toBe(expected);
    expect(selectWorktreeSetupScript({ windows: 'pnpm i', posix: 'bun install' })).toBe(expected);
  });
});

/**
 * P6.336 (a) — the operator's worktree policy: a root, a retention count and an
 * off switch for automatic deletion.
 *
 * Read-before-invented came back EMPTY on both corpora — `settings-reference.md`
 * lists exactly four `worktree.*` keys and no lifetime key, `worktrees.md`
 * documents a FIXED location, and codex exposes no worktree object through the
 * app-server — so these three are decided here, and the rows below are what
 * makes the decisions visible.
 */
describe('P6.336 · the worktree retention policy keys', () => {
  it('accepts an absolute root, a count and the off switch, and resolves them', () => {
    const parsed = parseWorktreeSettingsV1({
      root: '/srv/worktrees', retainCount: 3, autoRemove: false,
    });
    expect(parsed).toEqual({ root: '/srv/worktrees', retainCount: 3, autoRemove: false });
    const resolved = resolveWorktreeSettings([parsed]);
    expect(resolved.root).toBe('/srv/worktrees');
    expect(resolved.retainCount).toBe(3);
    expect(resolved.autoRemove).toBe(false);
  });

  it('defaults to automatic deletion ON, with no root and no count', () => {
    const resolved = resolveWorktreeSettings([]);
    expect(resolved.autoRemove).toBe(true);
    expect(resolved.root).toBeUndefined();
    expect(resolved.retainCount).toBeUndefined();
  });

  // `0` is a legal count and is NOT the off switch — "keep nothing extra" and
  // "never delete" are opposite intents.
  it('takes zero as a count, which is not the off switch', () => {
    const resolved = resolveWorktreeSettings([{ retainCount: 0 }]);
    expect(resolved.retainCount).toBe(0);
    expect(resolved.autoRemove).toBe(true);
  });

  // Composition: root is last-wins like baseRef; the two policy keys are
  // TIGHTER-wins, so a more specific layer cannot make the sweep delete more.
  it('takes the last root, the smallest count, and any layer that turns deletion off', () => {
    const resolved = resolveWorktreeSettings([
      { root: '/a', retainCount: 5, autoRemove: true },
      { root: '/b', retainCount: 2 },
    ]);
    expect(resolved.root).toBe('/b');
    expect(resolved.retainCount).toBe(2);

    expect(resolveWorktreeSettings([{ retainCount: 2 }, { retainCount: 9 }]).retainCount).toBe(2);
    expect(resolveWorktreeSettings([{ autoRemove: false }, { autoRemove: true }]).autoRemove).toBe(false);
    expect(resolveWorktreeSettings([{ autoRemove: true }, { autoRemove: false }]).autoRemove).toBe(false);
  });

  // NEGATIVE — refused, never dropped to a default. A root the operator meant
  // and we silently ignored would put worktrees somewhere they did not choose.
  it('refuses a relative root, a filesystem root, a bad count and a non-boolean switch', () => {
    expect(() => parseWorktreeSettingsV1({ root: 'worktrees' })).toThrow(/worktree-root-not-absolute/);
    expect(() => parseWorktreeSettingsV1({ root: '/' })).toThrow(/worktree-project-root-too-broad/);
    expect(() => parseWorktreeSettingsV1({ root: '/srv/../etc' })).toThrow(/worktree-root-escapes/);
    expect(() => parseWorktreeSettingsV1({ root: '' })).toThrow(/invalid worktree root/);
    expect(() => parseWorktreeSettingsV1({ retainCount: -1 })).toThrow(/invalid worktree retainCount/);
    expect(() => parseWorktreeSettingsV1({ retainCount: 1.5 })).toThrow(/invalid worktree retainCount/);
    expect(() => parseWorktreeSettingsV1({ autoRemove: 'no' })).toThrow(/invalid worktree autoRemove/);
  });
});
