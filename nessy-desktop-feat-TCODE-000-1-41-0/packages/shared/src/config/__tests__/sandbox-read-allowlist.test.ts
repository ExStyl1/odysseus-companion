/**
 * The settings half of D11: the key an administrator writes, how it composes,
 * and what the diagnosis surface says about it.
 *
 * `settings-reference.md#sandbox-filesystem-allowread` — "Re-open reading for
 * specific paths inside a region that `denyRead` blocks, to build workspace-only
 * read access. An exact or wildcard `denyRead` entry stays blocked inside a
 * broader `allowRead` … Claude Code merges entries across every settings file
 * the session loads unless `allowManagedReadPathsOnly` is set."
 * `managed-settings.md#keys-only-a-managed-source-can-set`, the
 * `sandbox.filesystem.allowManagedReadPathsOnly` row — "When `true`, only
 * `filesystem.allowRead` paths from managed settings are respected. `denyRead`
 * still merges from all sources."
 */

import { describe, expect, it } from 'bun:test';
import { STRICT_DROP_SINK } from '../managed-drops.ts';
import {
  parseManagedSandboxSettingsV1,
  resolveSandboxFilesystemConsequences,
  resolveSandboxReadAllowlist,
  resolveSandboxSettings,
} from '../sandbox-settings.ts';

describe('sandbox.filesystem.allowRead resolution', () => {
  it('is absent from a default install', () => {
    const settings = resolveSandboxSettings([]);
    expect(settings.filesystem.allowedReadRoots).toEqual([]);
    expect(settings.filesystem.allowManagedReadPathsOnly).toBe(false);
    expect(resolveSandboxReadAllowlist(settings, { platform: 'darwin' })).toEqual({
      allowedReadRoots: [],
      platformCanEnforce: true,
      restrictsReads: false,
      unenforceable: [],
    });
    expect(resolveSandboxFilesystemConsequences(settings, 'darwin')).toEqual([]);
  });

  // sandboxing.md:419 — "For array keys such as `excludedCommands` and
  // `allowRead`, Claude Code merges entries from every scope".
  it('merges entries from every layer', () => {
    const settings = resolveSandboxSettings(
      [{ filesystem: { allowRead: ['/srv/user'] } }],
      { floor: { filesystem: { allowRead: ['/srv/managed'] } } },
    );
    expect(settings.filesystem.allowedReadRoots).toEqual(['/srv/managed', '/srv/user']);
  });

  // sandboxing.md:421 — "User, project, and local `allowRead` entries are
  // ignored" once the lock is set. `denyRead` still merges, `:419`.
  it('caps the list to the floor under allowManagedReadPathsOnly', () => {
    const settings = resolveSandboxSettings(
      [{ filesystem: { allowRead: ['/srv/user'] }, deniedReadRoots: ['/srv/private'] }],
      {
        floor: {
          filesystem: { allowRead: ['/srv/managed'], allowManagedReadPathsOnly: true },
          deniedReadRoots: ['/srv/secret'],
        },
      },
    );
    expect(settings.filesystem.allowedReadRoots).toEqual(['/srv/managed']);
    expect(settings.filesystem.allowManagedReadPathsOnly).toBe(true);
    expect(settings.deniedReadRoots).toEqual(['/srv/secret', '/srv/private']);
  });

  it('validates entries the same way as the denied roots', () => {
    // A bare entry no longer means "not absolute" — it means "relative to the
    // declaring scope" (`settings-reference.md#sandbox-path-prefixes`, the
    // `./` or no prefix row). `resolveSandboxSettings` composes
    // already-parsed layers and holds no scope, so this tier is the one where a
    // bare entry has nothing to anchor to, and the reason now says which.
    expect(() => resolveSandboxSettings([{ filesystem: { allowRead: ['relative'] } }]))
      .toThrow('sandbox-allowRead-no-scope-root');
    expect(() => resolveSandboxSettings([{ filesystem: { allowRead: ['/'] } }]))
      .toThrow('sandbox-allowRead-too-broad');
    expect(() => parseManagedSandboxSettingsV1({ filesystem: { allowRead: 'no' } }))
      .toThrow('invalid sandbox allowRead');
  });

  // `settings-reference.md#sandbox-path-prefixes`, on the key whose name was
  // already right.
  it('expands every documented prefix against the declaring scope', () => {
    const parsed = parseManagedSandboxSettingsV1({
      filesystem: {
        allowRead: ['/srv/ok', '~/work', './output', 'output', '.', '//srv/ok'],
      },
    }, { scope: { home: '/home/x', root: '/home/x/.nessy-agent' } });
    expect(parsed.filesystem?.allowRead).toEqual([
      '/srv/ok',
      '/home/x/work',
      // `./output` and bare `output` are the same path, and `//srv/ok`
      // normalizes onto `/srv/ok` rather than surviving as a second entry.
      '/home/x/.nessy-agent/output',
      '/home/x/.nessy-agent/output',
      '/home/x/.nessy-agent',
      '/srv/ok',
    ]);
    expect(resolveSandboxSettings([parsed]).filesystem.allowedReadRoots).toEqual([
      '/srv/ok',
      '/home/x/work',
      '/home/x/.nessy-agent/output',
      '/home/x/.nessy-agent',
    ]);
  });

  // The resolver runs BEFORE the guards, so it is not a way around them.
  it('refuses a prefix that expands onto the filesystem root', () => {
    expect(() => parseManagedSandboxSettingsV1(
      { filesystem: { allowRead: ['~/'] } },
      { scope: { home: '/' } },
    )).toThrow('sandbox-allowRead-too-broad');
    expect(() => parseManagedSandboxSettingsV1(
      { filesystem: { allowRead: ['.'] } },
      { scope: { root: '/' } },
    )).toThrow('sandbox-allowRead-too-broad');
  });

  // The managed tier tolerates rather than throws
  // (`managed-settings.md#keys-that-fail-closed`'s sub-block rule: "This
  // tolerance applies only to managed settings"), and the lock reads at its
  // enforcing pole when malformed.
  it('tolerates a bad managed entry and tightens a malformed lock', () => {
    const drops: { at: string; reason: string }[] = [];
    const sink = {
      ...STRICT_DROP_SINK,
      tolerant: true,
      drop: (at: string, reason: string) => { drops.push({ at, reason }); },
    };
    const parsed = parseManagedSandboxSettingsV1({
      filesystem: { allowRead: ['/srv/ok', 'relative'], allowManagedReadPathsOnly: 'yes' },
    }, { sink, scope: {} });
    // `managed-settings.md#keys-that-fail-closed` — "An individual invalid entry
    // is stripped and the valid subset is enforced." A managed policy carries no
    // declaring directory, so a bare entry is still stripped here — but the
    // reason now names the actual cause instead of the misleading "not absolute".
    expect(parsed?.filesystem?.allowRead).toEqual(['/srv/ok']);
    expect(parsed?.filesystem?.allowManagedReadPathsOnly).toBe(true);
    expect(drops.find(drop => drop.at === 'sandbox.filesystem.allowRead[1]')?.reason)
      .toBe('sandbox-allowRead-no-scope-root');
    expect(drops.map(drop => drop.at)).toContain('sandbox.filesystem.allowManagedReadPathsOnly');
  });
});

describe('what the doctor says about a configured allowlist', () => {
  const configured = (): ReturnType<typeof resolveSandboxSettings> => resolveSandboxSettings(
    [],
    { floor: { filesystem: { allowRead: ['/srv/work'] }, deniedReadRoots: ['/Users/x'] } },
  );

  it('reports it as enforced on darwin, and lists what it admits', () => {
    const lines = resolveSandboxFilesystemConsequences(configured(), 'darwin');
    expect(lines[0]).toContain('1 entry');
    expect(lines[0]).toContain('enforced on darwin');
    expect(lines).toContain('  allowRead "/srv/work"');
    expect(lines.join('\n')).toContain('credential deny floor is emitted after every entry');
  });

  // The row this task exists for: a control that silently does nothing on two of
  // three platforms is worse than none.
  it('reports it as NOT enforceable on linux and win32', () => {
    for (const platform of ['linux', 'win32'] as const) {
      const enforcement = resolveSandboxReadAllowlist(configured(), { platform });
      expect(enforcement.platformCanEnforce).toBe(false);
      expect(enforcement.unenforceable.join('\n')).toContain('REFUSED');
      expect(resolveSandboxFilesystemConsequences(configured(), platform)[0])
        .toContain(`NOT enforceable on ${platform}`);
    }
  });

  // The other silent failure: `allowRead` alone grants what is already granted.
  it('says so when an allowlist has no denied region to re-open', () => {
    const settings = resolveSandboxSettings([], { floor: { filesystem: { allowRead: ['/srv/work'] } } });
    const enforcement = resolveSandboxReadAllowlist(settings, { platform: 'darwin' });
    expect(enforcement.restrictsReads).toBe(false);
    expect(enforcement.unenforceable.join('\n')).toContain('restricts nothing');
  });

  it('names an entry the credential floor outranks when the caller supplies it', () => {
    const settings = resolveSandboxSettings(
      [],
      { floor: { filesystem: { allowRead: ['/Users/x/.aws'] }, deniedReadRoots: ['/Users/x/.aws'] } },
    );
    const enforcement = resolveSandboxReadAllowlist(settings, {
      platform: 'darwin',
      credentialFloor: ['/Users/x/.aws'],
    });
    expect(enforcement.unenforceable.join('\n')).toContain('does not re-open');
    // Without the floor the line is simply not itemised; the rule still holds at
    // the isolation boundary, which is where it is probed.
    expect(resolveSandboxReadAllowlist(settings, { platform: 'darwin' }).unenforceable)
      .toEqual([]);
  });

  // `sandbox.filesystem.disabled` takes the read boundary with everything else.
  it('says the allowlist does not bind while the filesystem layer is off', () => {
    const settings = resolveSandboxSettings(
      [{ filesystem: { disabled: true } }],
      { floor: { filesystem: { allowRead: ['/srv/work'] }, deniedReadRoots: ['/Users/x'] } },
    );
    expect(resolveSandboxFilesystemConsequences(settings, 'darwin').join('\n'))
      .toContain('does not bind while sandbox.filesystem.disabled is true');
  });
});
