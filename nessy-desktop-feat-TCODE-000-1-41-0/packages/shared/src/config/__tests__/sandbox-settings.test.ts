import { describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import { STRICT_DROP_SINK } from '../managed-drops.ts';
import {
  matchExcludedCommand,
  parseManagedSandboxSettingsV1,
  resolveSandboxEnabled,
  resolveSandboxNetworkEnforcement,
  resolveSandboxSettings,
  DOCUMENTED_UNCARRIED_SANDBOX_KEYS,
  documentedUncarriedSandboxKeys,
  SANDBOX_ENABLED_DEFAULT,
  unmatchableDomainReason,
} from '../sandbox-settings.ts';
import { isDeniedNetworkTarget } from '../network-address-guard.ts';
import { credentialDenyRoots } from '@nessy-agent/session-tools-core';

/**
 * The REAL floor, imported — P6.679.
 *
 * This was a four-entry hand copy, justified by a comment reading *"`shared`
 * does not depend on `session-tools-core`"*. **That was false**, and it had been
 * false for as long as the copy existed: `@nessy-agent/session-tools-core` is in
 * `packages/shared/package.json`'s `dependencies` (`workspace:*`),
 * `credentialDenyRoots` is exported from that package's own `src/index.ts`, and
 * `agent/mode-manager.ts` already imports from it. So the copy bought nothing
 * and cost the only thing that matters here: it froze the floor at four entries
 * while the real list grew past twenty, and every assertion below silently
 * stopped covering the entries added since.
 *
 * Derived, never copied, is the point of the row. An entry ADDED to
 * `credentialDenyRoots` is now inside every loop here on the day it lands,
 * rather than on the day someone notices.
 */
function credentialDenyRootsFixture(homeDir: string, configDir: string): string[] {
  return credentialDenyRoots(homeDir, configDir);
}

describe('resolveSandboxSettings', () => {
  it('merges list keys by concat-and-dedupe, most-specific last', () => {
    const resolved = resolveSandboxSettings([
      { excludedCommands: ['docker *'] },
      { excludedCommands: ['go *', 'docker *'] },
    ]);
    expect(resolved.excludedCommands).toEqual(['docker *', 'go *']);
  });

  it('refuses a filesystem entry that is relative or a filesystem root', () => {
    // Same two refusals canonicalDeniedReadRoot already enforces. A settings
    // surface must not become a way around them. The name promises TWO
    // distinct refusals, so each is matched: a bare `toThrow()` pair passed
    // equally when both collapsed onto one message.
    expect(() => resolveSandboxSettings([{ deniedReadRoots: ['relative/x'] }]))
      .toThrow('sandbox-deniedReadRoots-no-scope-root');
    expect(() => resolveSandboxSettings([{ deniedReadRoots: ['/'] }]))
      .toThrow('sandbox-deniedReadRoots-too-broad');
  });

  it('the floor under test IS the shipped one, and it is not a four-entry stub', () => {
    // The instrument's own positive control. Without it a `credentialDenyRoots`
    // that returned `[]` — or the four-entry copy this replaced — would make
    // every floor assertion below vacuously green, which is precisely the state
    // this suite was in.
    const floor = credentialDenyRootsFixture('/home/x', '/home/x/.nessy-agent');
    expect(floor.length).toBeGreaterThan(10);
    expect(new Set(floor).size).toBe(floor.length);
    for (const root of floor) expect(root.startsWith('/home/x')).toBe(true);
    // Named entries the four-entry copy did NOT carry, so a silent revert to a
    // stub is red rather than merely smaller.
    expect(floor).toContain(join('/home/x', '.config', 'gh'));
    expect(floor).toContain(join('/home/x', '.config', 'glab-cli'));
    expect(floor).toContain(join('/home/x', '.git-credentials'));
  });

  it('cannot remove a credential deny that the runtime seeded', () => {
    // The seeded list is a floor, not a default. A user setting may add to it
    // and must not be able to subtract from it.
    const floor = credentialDenyRootsFixture('/home/x', '/home/x/.nessy-agent');
    const resolved = resolveSandboxSettings([{ deniedReadRoots: [] }], { floor: { deniedReadRoots: floor } });
    expect(resolved.deniedReadRoots).toEqual(expect.arrayContaining([expect.stringContaining('.ssh')]));
    for (const root of floor) expect(resolved.deniedReadRoots).toContain(root);
  });

  it('keeps the floor even when a layer names the same roots, without duplicating them', () => {
    const floor = credentialDenyRootsFixture('/home/x', '/home/x/.nessy-agent');
    const resolved = resolveSandboxSettings(
      [{ deniedReadRoots: ['/home/x/.ssh', '/home/x/secrets'] }],
      { floor: { deniedReadRoots: floor } },
    );
    expect(resolved.deniedReadRoots.filter(root => root === '/home/x/.ssh')).toHaveLength(1);
    expect(resolved.deniedReadRoots).toContain('/home/x/secrets');
  });

  // `settings-reference.md#sandbox-filesystem-denywrite` — "Claude Code merges
  // entries across every settings scope the session loads, and adds the paths
  // from your `Edit(...)` deny permission rules", i.e. it restricts and is
  // additive, exactly like `denyRead`.
  it('treats deniedWriteRoots as a restricting key with a floor that layers cannot subtract', () => {
    const resolved = resolveSandboxSettings(
      [{ deniedWriteRoots: [] }, { deniedWriteRoots: ['/srv/shared/protected'] }],
      { floor: { deniedWriteRoots: ['/usr/local/bin'] } },
    );
    expect(resolved.deniedWriteRoots).toEqual(['/usr/local/bin', '/srv/shared/protected']);
    expect(() => resolveSandboxSettings([{ deniedWriteRoots: ['relative/x'] }]))
      .toThrow('sandbox-deniedWriteRoots-no-scope-root');
    expect(() => resolveSandboxSettings([{ deniedWriteRoots: ['/'] }]))
      .toThrow('sandbox-deniedWriteRoots-too-broad');
  });

  it('rejects an unknown key rather than ignoring it', () => {
    // The diagnostic must NAME the key — that is what distinguishes this gate
    // from any other refusal on the way through.
    expect(() => resolveSandboxSettings([{ nope: true } as never]))
      .toThrow('invalid sandbox setting: nope');
  });

  it('defaults allowUnsandboxedCommands to true and lets a layer lock it off', () => {
    // Strict sandbox mode. Default true keeps behaviour unchanged for anyone who
    // never sets it; false must be terminal, so a later layer cannot re-open it.
    expect(resolveSandboxSettings([]).allowUnsandboxedCommands).toBe(true);
    expect(resolveSandboxSettings([{ allowUnsandboxedCommands: false }]).allowUnsandboxedCommands).toBe(false);
    expect(resolveSandboxSettings([
      { allowUnsandboxedCommands: false },
      { allowUnsandboxedCommands: true },
    ]).allowUnsandboxedCommands).toBe(false);
    expect(resolveSandboxSettings([{ allowUnsandboxedCommands: false }], {
      floor: { allowUnsandboxedCommands: true },
    }).allowUnsandboxedCommands).toBe(false);
  });

  it('a floor that locks strict mode cannot be unlocked by any layer', () => {
    expect(resolveSandboxSettings([{ allowUnsandboxedCommands: true }], {
      floor: { allowUnsandboxedCommands: false },
    }).allowUnsandboxedCommands).toBe(false);
  });

  it('rejects a non-string or over-long command pattern', () => {
    expect(() => resolveSandboxSettings([{ excludedCommands: [42] as never }]))
      .toThrow('invalid sandbox excludedCommands');
    expect(() => resolveSandboxSettings([{ excludedCommands: ['x'.repeat(513)] }]))
      .toThrow('invalid sandbox excludedCommands');
  });

  it('is empty and permissive with no layers at all', () => {
    expect(resolveSandboxSettings([])).toEqual({
      excludedCommands: [],
      deniedReadRoots: [],
      deniedWriteRoots: [],
      additionalWritableRoots: [],
      allowUnsandboxedCommands: true,
      // T1 owner decision 2026-08-12: SANDBOX_ENABLED_DEFAULT is false, so "no
      // layers at all" — a fresh install — resolves to nothing wrapped.
      enabled: false,
      network: { deniedDomains: [], allowedDomains: [], allowManagedDomainsOnly: false },
      filesystem: { disabled: false, allowedReadRoots: [], allowManagedReadPathsOnly: false },
    });
  });

  it('validates additionalWritableRoots the same way as denied roots', () => {
    expect(() => resolveSandboxSettings([{ additionalWritableRoots: ['rel'] }]))
      .toThrow('sandbox-additionalWritableRoots-no-scope-root');
    expect(() => resolveSandboxSettings([{ additionalWritableRoots: ['/'] }]))
      .toThrow('sandbox-additionalWritableRoots-too-broad');
    expect(resolveSandboxSettings([{ additionalWritableRoots: ['/opt/cache'] }]).additionalWritableRoots)
      .toEqual(['/opt/cache']);
  });
});

describe('matchExcludedCommand', () => {
  it('matches a glob against the whole command and reports the pattern', () => {
    expect(matchExcludedCommand('docker ps', ['docker *'])).toBe('docker *');
    expect(matchExcludedCommand('docker', ['docker'])).toBe('docker');
  });

  it('does not match a command that merely contains the pattern', () => {
    // Anchored on purpose: `sudo docker ps` is not `docker ps`.
    expect(matchExcludedCommand('sudo docker ps', ['docker *'])).toBeUndefined();
    expect(matchExcludedCommand('rm -rf /', ['docker *', 'go *'])).toBeUndefined();
    expect(matchExcludedCommand('anything', [])).toBeUndefined();
  });

  it('treats regex metacharacters in a pattern as literals', () => {
    expect(matchExcludedCommand('a.b', ['a.b'])).toBe('a.b');
    expect(matchExcludedCommand('axb', ['a.b'])).toBeUndefined();
  });
});

describe('resolveSandboxSettings — the floor is the tighter side of every key', () => {
  it('caps excludedCommands when the floor names them, so a lock cannot be escaped', () => {
    // Without the cap an admin could set allowUnsandboxedCommands:false and a
    // user could still escape by adding their own exclusion.
    const resolved = resolveSandboxSettings(
      [{ excludedCommands: ['* '], allowUnsandboxedCommands: true }],
      { floor: { excludedCommands: ['docker *'], allowUnsandboxedCommands: false } },
    );
    expect(resolved.excludedCommands).toEqual(['docker *']);
    expect(resolved.allowUnsandboxedCommands).toBe(false);
  });

  it('caps additionalWritableRoots the same way', () => {
    expect(resolveSandboxSettings(
      [{ additionalWritableRoots: ['/etc'] }],
      { floor: { additionalWritableRoots: ['/opt/cache'] } },
    ).additionalWritableRoots).toEqual(['/opt/cache']);
  });

  it('still validates a capped layer rather than silently ignoring it', () => {
    // The refusal must be the VALUE validation, not the cap declining the layer.
    expect(() => resolveSandboxSettings(
      [{ excludedCommands: [42] as never }],
      { floor: { excludedCommands: ['docker *'] } },
    )).toThrow('invalid sandbox excludedCommands');
  });

  it('lets layers concat freely when the floor names no granting key', () => {
    expect(resolveSandboxSettings(
      [{ excludedCommands: ['go *'] }],
      { floor: { deniedReadRoots: ['/home/x/.ssh'] } },
    ).excludedCommands).toEqual(['go *']);
  });
});

describe('parseManagedSandboxSettingsV1', () => {
  it('accepts a bounded layer and freezes it', () => {
    const parsed = parseManagedSandboxSettingsV1({
      excludedCommands: ['docker *'],
      deniedReadRoots: ['/srv/secrets'],
      allowUnsandboxedCommands: false,
    });
    expect(parsed).toEqual({
      excludedCommands: ['docker *'],
      deniedReadRoots: ['/srv/secrets'],
      allowUnsandboxedCommands: false,
    });
    expect(Object.isFrozen(parsed)).toBe(true);
  });

  it('throws rather than dropping to a permissive default', () => {
    // One matcher for the whole table cannot tell a shape refusal from a value
    // refusal, so each row carries the message its own case must produce.
    const table: Array<[unknown, string]> = [
      [null, 'invalid sandbox settings'],
      [[], 'invalid sandbox settings'],
      ['sandbox', 'invalid sandbox settings'],
      [{ nope: true }, 'invalid sandbox setting: nope'],
      [{ excludedCommands: 'docker *' }, 'invalid sandbox excludedCommands'],
      [{ deniedReadRoots: ['relative'] }, 'sandbox-deniedReadRoots-no-scope-root'],
      [{ allowUnsandboxedCommands: 0 }, 'invalid sandbox allowUnsandboxedCommands'],
    ];
    for (const [invalid, message] of table) {
      expect(() => parseManagedSandboxSettingsV1(invalid)).toThrow(message);
    }
  });

  it('omits keys the layer did not name, so absence stays distinguishable', () => {
    expect(parseManagedSandboxSettingsV1({})).toEqual({});
    expect(Object.keys(parseManagedSandboxSettingsV1({ allowUnsandboxedCommands: true })))
      .toEqual(['allowUnsandboxedCommands']);
  });
});

/**
 * R51 · f022 f023 — the documented NESTED path keys and the path prefixes.
 *
 * `settings-reference.md#sandbox-filesystem` nests all four path keys under
 * `sandbox.filesystem` — "**Type**: object with `allowWrite`, `denyWrite`,
 * `denyRead`, and `allowRead` arrays, plus the `allowManagedReadPathsOnly` and
 * `disabled` Booleans"; our three flat names are pre-doc aliases that stay
 * accepted. `settings-reference.md#sandbox-path-prefixes` is now one section
 * carrying all three things the older anchors pointed at separately: it binds
 * the prefix rule to the same keys ("Paths in `allowWrite`, `denyWrite`,
 * `denyRead`, `allowRead`, and `credentials.files` resolve by their prefix"),
 * holds the prefix table, and keeps the `//path` form ("The `//path` prefix for
 * absolute paths also works").
 */
describe('sandbox.filesystem — the documented nested path keys', () => {
  // The doc's own example document — the `settings-reference.md#sandbox` JSON
  // stanza, "This turns the sandbox on, skips permission prompts for sandboxed
  // commands, runs `docker` outside the sandbox, opens two extra write paths,
  // hides your AWS credentials file, and pre-allows GitHub and npm" —
  // restricted to the keys this fork's schema knows. `autoAllowBashIfSandboxed`,
  // `network.allowUnixSockets` and `network.allowLocalBinding` have no key here
  // at all and are still refused — a SEPARATE finding from this unit's, and the
  // assertion below pins that boundary so it cannot be closed by accident.
  // `enabled` USED to be in this out-of-scope list; T1 (2026-08-12) is the unit
  // this comment was left for — see the `sandbox.enabled` describe block below.
  const DOC_STANZA = {
    excludedCommands: ['docker *'],
    filesystem: {
      allowWrite: ['/tmp/build', '~/.kube'],
      denyRead: ['~/.aws/credentials'],
    },
    network: {
      allowedDomains: ['github.com', '*.npmjs.org', 'registry.yarnpkg.com'],
      deniedDomains: ['uploads.github.com'],
    },
  };
  const SCOPE = { home: '/home/x', root: '/home/x/.nessy-agent' };

  it("parses the doc's stanza at the strict tier and folds it onto the flat names", () => {
    const parsed = parseManagedSandboxSettingsV1(DOC_STANZA, { scope: SCOPE });
    const resolved = resolveSandboxSettings([parsed]);
    expect(resolved.additionalWritableRoots).toEqual(['/tmp/build', '/home/x/.kube']);
    expect(resolved.deniedReadRoots).toEqual(['/home/x/.aws/credentials']);
    expect(resolved.excludedCommands).toEqual(['docker *']);
    expect(resolved.network.allowedDomains).toHaveLength(3);
  });

  it("parses the doc's stanza at the tolerant managed tier with nothing dropped", () => {
    const drops: string[] = [];
    const sink = { ...STRICT_DROP_SINK, tolerant: true, drop: (at: string) => { drops.push(at); } };
    // Managed carries no scope root, and the stanza needs none: every entry is
    // absolute or home-anchored.
    const parsed = parseManagedSandboxSettingsV1(DOC_STANZA, { sink, scope: { home: '/home/x' } });
    expect(drops).toEqual([]);
    expect(parsed?.filesystem?.allowWrite).toEqual(['/tmp/build', '/home/x/.kube']);
    expect(parsed?.filesystem?.denyRead).toEqual(['/home/x/.aws/credentials']);
  });

  it('ACCEPTS the documented stanza keys this product does not carry, and keeps the rest — P6.233', () => {
    // Was a refusal. It threw, and the strict path's one caller
    // (`getUserSandboxSettings`) catches the throw and returns an EMPTY layer,
    // so one documented key silently disabled a whole hand-written sandbox
    // block. `managed-settings.md#invalid-entries-in-managed-settings` describes
    // the opposite shape — "drops any top-level key whose value still fails and
    // keeps enforcing every remaining valid key" — and the tolerant path already
    // implemented it. The two paths now agree.
    for (const key of ['autoAllowBashIfSandboxed', 'failIfUnavailable', 'ignoreViolations', 'allowAppleEvents']) {
      const parsed = parseManagedSandboxSettingsV1({ ...DOC_STANZA, [key]: true }, { scope: SCOPE });
      // Accepted...
      expect(parsed, key).toBeDefined();
      // ...and PROJECTING NOTHING: the key is not on the parsed layer.
      expect(Object.keys(parsed ?? {}), key).not.toContain(key);
      // ...while every other key in the same block still applies. Without this
      // the assertion above would also pass for a parser that returned `{}`.
      expect(parsed?.filesystem?.allowWrite, key).toEqual(['/tmp/build', '/home/x/.kube']);
    }
    // The `sandbox.network` sub-block is DELIBERATELY not changed: its eight
    // transport keys are P6.253's decided refusals, and that row's own test
    // drives this throw to prove "removing one has to be a visible decision".
    expect(() => parseManagedSandboxSettingsV1({ network: { allowLocalBinding: true } }))
      .toThrow('invalid sandbox network setting: allowLocalBinding');
  });

  it('still THROWS for a key nobody documents — a typo is not a deferral', () => {
    // The negative control the acceptance above needs. `nope` is in neither
    // `SANDBOX_SETTING_KEYS` nor `DOCUMENTED_UNCARRIED_SANDBOX_KEYS`, so it is a
    // typo, and strictness is the right answer to a typo.
    expect(() => parseManagedSandboxSettingsV1({ ...DOC_STANZA, nope: true }, { scope: SCOPE }))
      .toThrow('invalid sandbox setting: nope');
    expect(() => parseManagedSandboxSettingsV1({ network: { nope: true } }))
      .toThrow('invalid sandbox network setting: nope');
    // ...and it says the TYPO sentence, not the decided-deferral one, so the
    // two classes stay distinguishable in the sub-block as well.
    expect(() => parseManagedSandboxSettingsV1({ network: { nope: true } }))
      .not.toThrow('deliberately not carried here');
  });

  it('names the accepted-and-uncarried keys, so acceptance is not silence — P6.233', () => {
    // Accept-and-name. Read off the RAW layer, before the parse strips them, and
    // descending into the documented sub-blocks so a network key is named as
    // itself rather than as `network`.
    expect(documentedUncarriedSandboxKeys({
      enabled: true,
      failIfUnavailable: true,
      network: { deniedDomains: ['x.example'], strictAllowlist: true },
      credentials: { envVars: {} },
    })).toEqual([
      'sandbox.credentials',
      'sandbox.credentials.envVars',
      'sandbox.failIfUnavailable',
      'sandbox.network.strictAllowlist',
    ]);
    // A clean block names nothing — otherwise every install would carry a
    // diagnostic and the operator would learn to ignore it.
    expect(documentedUncarriedSandboxKeys({ enabled: true, excludedCommands: ['docker *'] })).toEqual([]);
    expect(documentedUncarriedSandboxKeys(undefined)).toEqual([]);
    expect(documentedUncarriedSandboxKeys('nope')).toEqual([]);
  });

  // `settings-reference.md#sandbox-filesystem-allowwrite` — "user, project,
  // local, and managed paths combine rather than replace each other". Applied
  // to the two SPELLINGS of one key in one document: neither wins, they concat
  // and dedupe.
  it('concat-dedupes the nested and flat spellings rather than letting one replace the other', () => {
    const resolved = resolveSandboxSettings([{
      additionalWritableRoots: ['/tmp/flat', '/tmp/both'],
      deniedWriteRoots: ['/etc/flat'],
      deniedReadRoots: ['/etc/secret'],
      filesystem: {
        allowWrite: ['/tmp/nested', '/tmp/both'],
        denyWrite: ['/etc/nested'],
        denyRead: ['/etc/secret', '/etc/other'],
      },
    }]);
    expect(resolved.additionalWritableRoots).toEqual(['/tmp/flat', '/tmp/both', '/tmp/nested']);
    expect(resolved.deniedWriteRoots).toEqual(['/etc/flat', '/etc/nested']);
    expect(resolved.deniedReadRoots).toEqual(['/etc/secret', '/etc/other']);
  });

  // The grant cap has to fire on either spelling, or an administrator who writes
  // the DOCUMENTED one gets a floor that caps nothing.
  it('caps grants when the floor names allowWrite under the nested spelling', () => {
    expect(resolveSandboxSettings(
      [{ additionalWritableRoots: ['/etc'] }, { filesystem: { allowWrite: ['/opt/other'] } }],
      { floor: { filesystem: { allowWrite: ['/opt/cache'] } } },
    ).additionalWritableRoots).toEqual(['/opt/cache']);
  });

  it('keeps a floor denyWrite that no layer can subtract', () => {
    expect(resolveSandboxSettings(
      [{ filesystem: { denyWrite: [] } }],
      { floor: { filesystem: { denyWrite: ['/usr/local/bin'] } } },
    ).deniedWriteRoots).toEqual(['/usr/local/bin']);
  });

  it('applies the same two refusals to the new keys', () => {
    for (const key of ['allowWrite', 'denyWrite', 'denyRead'] as const) {
      expect(() => resolveSandboxSettings([{ filesystem: { [key]: ['/'] } }]))
        .toThrow(`sandbox-${key}-too-broad`);
      expect(() => parseManagedSandboxSettingsV1({ filesystem: { [key]: 'no' } }))
        .toThrow(`invalid sandbox ${key}`);
    }
  });

  // `settings-reference.md#sandbox-path-prefixes`. `/x` is absolute and NOT
  // project-relative — that section says so explicitly, contrasting it with
  // Read/Edit permission rules: "sandbox filesystem paths use standard
  // conventions, so `/tmp/build` is an absolute path."
  it('expands every documented prefix on a write key', () => {
    const parsed = parseManagedSandboxSettingsV1({
      filesystem: { allowWrite: ['/tmp/build', '~/.kube', './out', 'out', '//tmp/build'] },
    }, { scope: SCOPE });
    expect(parsed.filesystem?.allowWrite).toEqual([
      '/tmp/build',
      '/home/x/.kube',
      '/home/x/.nessy-agent/out',
      '/home/x/.nessy-agent/out',
      // The older `//path` form normalizes onto its single-slash twin, so the
      // two dedupe instead of reaching a backend as two entries.
      '/tmp/build',
    ]);
    expect(resolveSandboxSettings([parsed]).additionalWritableRoots).toEqual([
      '/tmp/build', '/home/x/.kube', '/home/x/.nessy-agent/out',
    ]);
  });

  it('drops a bare entry by name when the tier has no scope root', () => {
    // Strict: the throw carries the reason.
    expect(() => parseManagedSandboxSettingsV1({ filesystem: { allowWrite: ['./out'] } }))
      .toThrow('sandbox-allowWrite-no-scope-root');
    // Tolerant: the entry is stripped and the reason says which, so an admin
    // reading the drop summary is not told the path "is not absolute".
    const drops: { at: string; reason: string }[] = [];
    const sink = {
      ...STRICT_DROP_SINK,
      tolerant: true,
      drop: (at: string, reason: string) => { drops.push({ at, reason }); },
    };
    const parsed = parseManagedSandboxSettingsV1(
      { filesystem: { denyRead: ['/etc/secret', 'out'] } },
      { sink, scope: {} },
    );
    expect(parsed?.filesystem?.denyRead).toEqual(['/etc/secret']);
    expect(drops).toEqual([
      { at: 'sandbox.filesystem.denyRead[1]', reason: 'sandbox-denyRead-no-scope-root' },
    ]);
  });

  it('expands the flat aliases too, since they name the same paths', () => {
    const parsed = parseManagedSandboxSettingsV1(
      { deniedReadRoots: ['~/.aws/credentials'], additionalWritableRoots: ['./build'] },
      { scope: SCOPE },
    );
    expect(parsed.deniedReadRoots).toEqual(['/home/x/.aws/credentials']);
    expect(parsed.additionalWritableRoots).toEqual(['/home/x/.nessy-agent/build']);
  });
});

/**
 * The `network` section (R3). `deniedDomains` is a RESTRICTING list, so the
 * floor is a minimum layers can only add to. `allowedDomains` is a GRANTING
 * list, so a floor that names it caps the list — otherwise an admin could lock
 * `allowManagedDomainsOnly` and a user setting could widen the allowlist right
 * back. `allowManagedDomainsOnly` is restricting, so it composes by OR.
 */
describe('resolveSandboxSettings — the network section', () => {
  it('is absent and permissive when nothing names it', () => {
    expect(resolveSandboxSettings([]).network).toEqual({
      deniedDomains: [],
      allowedDomains: [],
      allowManagedDomainsOnly: false,
    });
  });

  it('unions deniedDomains across layers and the floor, and a layer cannot subtract', () => {
    const resolved = resolveSandboxSettings([
      { network: { deniedDomains: [] } },
      { network: { deniedDomains: ['b.example', 'a.example'] } },
    ], { floor: { network: { deniedDomains: ['a.example'] } } });
    expect(resolved.network.deniedDomains).toEqual(['a.example', 'b.example']);
  });

  it('caps allowedDomains when the floor names them, so a managed allowlist cannot be widened', () => {
    const resolved = resolveSandboxSettings([
      { network: { allowedDomains: ['attacker.example'] } },
    ], { floor: { network: { allowedDomains: ['corp.example'], allowManagedDomainsOnly: true } } });
    expect(resolved.network.allowedDomains).toEqual(['corp.example']);
    expect(resolved.network.allowManagedDomainsOnly).toBe(true);
  });

  it('lets layers concat allowedDomains when the floor names none', () => {
    expect(resolveSandboxSettings([
      { network: { allowedDomains: ['a.example'] } },
      { network: { allowedDomains: ['b.example', 'a.example'] } },
    ]).network.allowedDomains).toEqual(['a.example', 'b.example']);
  });

  it('composes allowManagedDomainsOnly by OR: any layer may tighten, none may unlock', () => {
    expect(resolveSandboxSettings([{ network: { allowManagedDomainsOnly: true } }])
      .network.allowManagedDomainsOnly).toBe(true);
    expect(resolveSandboxSettings([{ network: { allowManagedDomainsOnly: false } }], {
      floor: { network: { allowManagedDomainsOnly: true } },
    }).network.allowManagedDomainsOnly).toBe(true);
  });

  it('rejects an unknown key inside network, and a non-list or non-boolean value', () => {
    // Four different refusals, so four different matchers: the unknown key must
    // be named, and a bad shape must not be reported as a bad key.
    expect(() => resolveSandboxSettings([{ network: { nope: true } } as never]))
      .toThrow('invalid sandbox network setting: nope');
    expect(() => resolveSandboxSettings([{ network: { deniedDomains: 'a.example' } } as never]))
      .toThrow('invalid sandbox network deniedDomains');
    expect(() => resolveSandboxSettings([{ network: { allowManagedDomainsOnly: 1 } } as never]))
      .toThrow('invalid sandbox network allowManagedDomainsOnly');
    expect(() => resolveSandboxSettings([{ network: ['a.example'] } as never]))
      .toThrow('invalid sandbox network settings');
  });
});

/**
 * The half that binds a command (S12). The composition above was already
 * correct; what it produced reached no shell. These cover the two directions
 * that matter: the default must be untouched, and a lock must deny.
 */
describe('resolveSandboxNetworkEnforcement', () => {
  it('leaves egress open and reports nothing when no network key is set', () => {
    // The owner decision of 2026-07-28 (`networked` foreground shell) is the
    // default and this unit does not move it.
    expect(resolveSandboxNetworkEnforcement(resolveSandboxSettings([]).network)).toEqual({
      egress: 'open',
      source: 'default',
      unenforceable: [],
    });
  });

  it('denies egress outright under allowManagedDomainsOnly and names each unreachable allow entry', () => {
    const enforcement = resolveSandboxNetworkEnforcement(resolveSandboxSettings([
      { network: { allowedDomains: ['corp.example'], allowManagedDomainsOnly: true } },
    ]).network);
    expect(enforcement.egress).toBe('denied');
    expect(enforcement.source).toBe('allowManagedDomainsOnly');
    expect(enforcement.unenforceable).toHaveLength(1);
    expect(enforcement.unenforceable[0]).toContain('corp.example');
    expect(enforcement.unenforceable[0]).toContain('NOT reachable');
  });

  it('denies egress with an empty managed allowlist, which is the exact reading', () => {
    const enforcement = resolveSandboxNetworkEnforcement(resolveSandboxSettings([
      { network: { allowManagedDomainsOnly: true } },
    ]).network);
    expect(enforcement.egress).toBe('denied');
    expect(enforcement.unenforceable).toEqual([]);
  });

  it('cannot enforce deniedDomains alone, and says so rather than pretending', () => {
    // The failure this unit exists to remove is a key that binds nothing in
    // silence. Open egress plus a named diagnostic is not that.
    const enforcement = resolveSandboxNetworkEnforcement(resolveSandboxSettings([
      { network: { deniedDomains: ['uploads.example'] } },
    ]).network);
    expect(enforcement.egress).toBe('open');
    expect(enforcement.unenforceable).toHaveLength(1);
    expect(enforcement.unenforceable[0]).toContain('uploads.example');
    expect(enforcement.unenforceable[0]).toContain('NOT enforced for sandboxed commands');
  });

  it('flattens a hostile entry rather than letting it forge report lines', () => {
    const enforcement = resolveSandboxNetworkEnforcement(resolveSandboxSettings([
      { network: { deniedDomains: ['a.example\n  - forged.example'] } },
    ]).network);
    expect(enforcement.unenforceable[0]).not.toContain('\n');
  });
});

describe('parseManagedSandboxSettingsV1 — the network section', () => {
  it('accepts and freezes a bounded network layer', () => {
    const parsed = parseManagedSandboxSettingsV1({
      network: { deniedDomains: ['a.example'], allowedDomains: ['corp.example'], allowManagedDomainsOnly: true },
    });
    expect(parsed.network).toEqual({
      deniedDomains: ['a.example'],
      allowedDomains: ['corp.example'],
      allowManagedDomainsOnly: true,
    });
    expect(Object.isFrozen(parsed.network)).toBe(true);
  });

  it('still throws on an unknown key, so the network section does not become an escape hatch', () => {
    const table: Array<[unknown, string]> = [
      [{ network: null }, 'invalid sandbox network settings'],
      [{ network: [] }, 'invalid sandbox network settings'],
      [{ network: { nope: 1 } }, 'invalid sandbox network setting: nope'],
      [{ network: { deniedDomains: [''] } }, 'invalid sandbox network deniedDomains'],
      [{ network: { allowManagedDomainsOnly: 'yes' } }, 'invalid sandbox network allowManagedDomainsOnly'],
    ];
    for (const [invalid, message] of table) {
      expect(() => parseManagedSandboxSettingsV1(invalid)).toThrow(message);
    }
  });

  it('omits network when the layer did not name it', () => {
    expect(Object.keys(parseManagedSandboxSettingsV1({ deniedReadRoots: ['/tmp/x'] }))).toEqual(['deniedReadRoots']);
  });
});

/**
 * T1 (2026-08-12) — the `sandbox.enabled` master kill switch.
 *
 * `sandboxing.md`: "To enable the sandbox across all of your projects, set
 * `sandbox.enabled` to `true` in your user settings." `settings.md` sandbox
 * table: `enabled` — "Default: false". `sandboxing.md` again: "For boolean
 * keys such as `enabled` and `failIfUnavailable`, Claude Code uses the managed
 * value and ignores anything a developer sets locally" — the managed layer
 * wins OUTRIGHT with either value, which is NOT the boolean-AND
 * `allowUnsandboxedCommands` composes with.
 */
describe('sandbox.enabled — the master kill switch (T1)', () => {
  it('parser accepts a boolean and rejects anything else', () => {
    expect(parseManagedSandboxSettingsV1({ enabled: false })).toEqual({ enabled: false });
    expect(parseManagedSandboxSettingsV1({ enabled: true })).toEqual({ enabled: true });
    expect(() => parseManagedSandboxSettingsV1({ enabled: 'no' })).toThrow('invalid sandbox enabled');
  });

  it('defaults to SANDBOX_ENABLED_DEFAULT (false) with nothing set anywhere', () => {
    expect(SANDBOX_ENABLED_DEFAULT).toBe(false);
    expect(resolveSandboxSettings([]).enabled).toBe(false);
    expect(resolveSandboxEnabled([])).toBe(false);
  });

  it('a lone user layer decides it when no floor is present', () => {
    expect(resolveSandboxSettings([{ enabled: true }]).enabled).toBe(true);
    expect(resolveSandboxEnabled([{ enabled: true }])).toBe(true);
  });

  it('the managed floor wins OUTRIGHT over a user value, in either direction', () => {
    // managed true + user false -> true
    expect(resolveSandboxSettings([{ enabled: false }], { floor: { enabled: true } }).enabled).toBe(true);
    // managed false + user true -> false
    expect(resolveSandboxSettings([{ enabled: true }], { floor: { enabled: false } }).enabled).toBe(false);
  });

  it('is NOT the boolean-AND allowUnsandboxedCommands composes with', () => {
    // A plain AND would make managed=true + user=false resolve to false (the
    // same shape allowUnsandboxedCommands uses). It must resolve to true: the
    // managed value is authoritative, not merely a floor the user cannot lower.
    const resolved = resolveSandboxSettings([{ enabled: false }], { floor: { enabled: true } });
    expect(resolved.enabled).toBe(true);
  });

  it('resolveSandboxEnabled is the ONE composition helper (hazard 10): floor beats every layer', () => {
    expect(resolveSandboxEnabled([{ enabled: true }, { enabled: false }], { enabled: false })).toBe(false);
    expect(resolveSandboxEnabled([{ enabled: false }, { enabled: false }], { enabled: true })).toBe(true);
    // Without a floor, the most specific (last) layer that names it wins.
    expect(resolveSandboxEnabled([{ enabled: true }, { enabled: false }])).toBe(false);
    expect(resolveSandboxEnabled([{ enabled: false }, {}])).toBe(false);
  });

  it('rejects the key at the strict tier via assertKnownKeys, the same gate as every other key', () => {
    expect(() => resolveSandboxSettings([{ enabled: false }])).not.toThrow();
    // `assertKnownKeys` is named in this test's name, so the assertion pins the
    // message only that function produces — `invalid sandbox setting: <key>`.
    // A bare `toThrow()` credited the gate without ever seeing it.
    expect(() => resolveSandboxSettings([{ nope: true } as never]))
      .toThrow('invalid sandbox setting: nope');
  });
});

describe('a documented sandbox key this product does not carry says so (P6.233)', () => {
  const drops = (layer: unknown) => {
    const collected: string[] = [];
    parseManagedSandboxSettingsV1(layer, {
      sink: { tolerant: true, drop: (field, reason) => collected.push(`${field}: ${reason}`) },
    });
    return collected;
  };

  it('the refusal is appended at all three depths, and a typo keeps the bare message', () => {
    // Before this, `failIfUnavailable` and `failIfUnavailabl` produced
    // byte-identical messages, so an administrator following the page read a
    // decided posture as their own spelling mistake.
    // P6.233 changed the TOP-LEVEL depth from a throw to an acceptance — the
    // throw cost the operator every other key in the same block — so the
    // distinguishing sentence now lives on the tolerant tier's drop and on
    // `documentedUncarriedSandboxKeys`, and this depth asserts the acceptance.
    expect(resolveSandboxSettings([{ failIfUnavailable: true } as never]).enabled)
      .toBe(SANDBOX_ENABLED_DEFAULT);
    expect(documentedUncarriedSandboxKeys({ failIfUnavailable: true }))
      .toEqual(['sandbox.failIfUnavailable']);
    expect(documentedUncarriedSandboxKeys({ failIfUnavailabl: true })).toEqual([]);
    expect(() => parseManagedSandboxSettingsV1({ network: { strictAllowlist: true } }))
      .toThrow('invalid sandbox network setting: strictAllowlist — documented by Claude Code');
    // The `filesystem` section's own gate. `enabled` is a plausible-looking
    // name that the page does NOT carry under `filesystem`, so it is the
    // negative control at that depth rather than a second positive.
    expect(() => parseManagedSandboxSettingsV1({ filesystem: { enabled: true } }))
      .toThrow('invalid sandbox filesystem setting: enabled');
    expect(() => parseManagedSandboxSettingsV1({ filesystem: { enabled: true } }))
      .not.toThrow('documented by Claude Code');

    // The controls: an unknown key at each depth is unchanged, byte for byte.
    expect(() => resolveSandboxSettings([{ nope: true } as never]))
      .toThrow('invalid sandbox setting: nope');
    expect(() => resolveSandboxSettings([{ nope: true } as never]))
      .not.toThrow('documented by Claude Code');
  });

  it('the tolerant tier carries the same note, so a managed policy reports it too', () => {
    // The strict tier throws at the first bad key; the managed tier collects.
    // Both must say the same thing, or an administrator gets the explanation
    // only in the tier that stops the session.
    const managed = drops({ failIfUnavailable: true, nope: 1, network: { tlsTerminate: true } });
    expect(managed).toEqual([
      'sandbox.failIfUnavailable: invalid sandbox setting: failIfUnavailable — documented by '
      + "Claude Code and deliberately not carried here: this product's OS isolation is off by "
      + 'owner decision and its wrapper is its own, so the key has no layer to reach',
      'sandbox.nope: invalid sandbox setting: nope',
      'sandbox.network.tlsTerminate: invalid sandbox network setting: tlsTerminate — documented '
      + "by Claude Code and deliberately not carried here: this product's OS isolation is off by "
      + 'owner decision and its wrapper is its own, so the key has no layer to reach',
    ]);
  });

  it('no documented key is also a CARRIED key, and the top-level ones now parse — P6.233', () => {
    // The one way this table can go wrong is a key gaining a carrier and keeping
    // its refusal, which would refuse a key the parser then reads. Asserted on
    // the LISTS, which is where that defect would live.
    for (const dotted of DOCUMENTED_UNCARRIED_SANDBOX_KEYS) {
      const path = dotted.slice('sandbox.'.length);
      const segments = path.split('.');
      // Depth picks the arm below, so it is asserted here rather than inside
      // either one: a three-segment documented key would fall into the `else`
      // and be probed as if `segments[1]` were its leaf — a green case proving
      // nothing about the key it names. All 23 are one or two deep today.
      expect({ dotted, deep: segments.length > 2 }).toEqual({ dotted, deep: false });
      if (segments.length === 1) {
        // P6.233 — the TOP-LEVEL ones are now ACCEPTED rather than fatal, so one
        // of them cannot cost the operator the rest of the block...
        const parsed = parseManagedSandboxSettingsV1(
          { enabled: true, [segments[0]!]: true }, { sink: STRICT_DROP_SINK },
        );
        expect({ dotted, parsed: parsed !== undefined }).toEqual({ dotted, parsed: true });
        // ...and PROJECT NOTHING: the key is absent from the parsed layer, while
        // the valid key beside it survived.
        expect({ dotted, projected: Object.keys(parsed ?? {}).includes(segments[0]!) })
          .toEqual({ dotted, projected: false });
        expect({ dotted, kept: parsed?.enabled }).toEqual({ dotted, kept: true });
      } else {
        const refused = (() => {
          try {
            parseManagedSandboxSettingsV1(
              { [segments[0]!]: { [segments[1]!]: true } }, { sink: STRICT_DROP_SINK },
            );
            return false;
          } catch { return true; }
        })();
        // Two different parents, two different answers, and the split is the
        // point. `sandbox.network` IS a carried block, so its sub-block gate
        // still refuses — those eight are P6.253's DECIDED refusals and removing
        // one has to be a visible decision, which is not this row's to make.
        // `sandbox.credentials` is itself a documented-uncarried TOP-LEVEL key,
        // so the whole block (its sub-keys included) rides the acceptance above.
        expect({ dotted, refused }).toEqual({ dotted, refused: segments[0] === 'network' });
      }
    }
    // 23 at the 2026-09-06 reading of `settings-reference.md`. The count is a
    // reading with a date; the disjointness above is the standing fact.
    expect(DOCUMENTED_UNCARRIED_SANDBOX_KEYS.size).toBe(23);
  });
});

/**
 * P6.326 half (b) — an entry that can match no host is named, instead of being
 * reported as a rule that "still applies to Monitor websocket targets".
 *
 * The agreement case at the end is the one that matters: it drives the REAL
 * guard, so the diagnostic cannot drift away from the matcher it describes.
 */
describe('a sandbox.network domain entry that can never match is named (P6.326)', () => {
  const lineFor = (domain: string): string => {
    const enforcement = resolveSandboxNetworkEnforcement(resolveSandboxSettings([
      { network: { deniedDomains: [domain] } },
    ]).network);
    expect(enforcement.unenforceable).toHaveLength(1);
    return enforcement.unenforceable[0]!;
  };

  it('names a host:port entry, which the row\'s own two-colon rule would have missed', () => {
    const line = lineFor('uploads.example:443');
    expect(line).toContain('matches NO host at all');
    expect(line).toContain('carries a port or a scheme');
    // The clause that would be a lie for this entry is gone, not appended to.
    expect(line).not.toContain('It still applies to Monitor websocket targets');
  });

  it('names a URL written where a domain belongs', () => {
    expect(lineFor('https://uploads.example')).toContain('matches NO host at all');
  });

  it('leaves an unbracketed IPv6 alone, because it WORKS', () => {
    const line = lineFor('2606:4700::1111');
    expect(line).not.toContain('matches NO host at all');
    expect(line).toContain('NOT enforced for sandboxed commands');
  });

  it('names a bare * and an empty entry, the same void spelt differently', () => {
    expect(unmatchableDomainReason('*')).toContain('refused on purpose');
    expect(unmatchableDomainReason('   ')).toBe('the entry is empty');
    expect(unmatchableDomainReason('*.example.com')).toBeNull();
  });

  it('the same spelling is named under allowManagedDomainsOnly too', () => {
    const enforcement = resolveSandboxNetworkEnforcement(resolveSandboxSettings([
      { network: { allowedDomains: ['corp.example:8443'], allowManagedDomainsOnly: true } },
    ]).network);
    expect(enforcement.unenforceable[0]).toContain('allowedDomains "corp.example:8443" matches NO host');
  });

  it('AGREES with the guard that actually enforces these lists', async () => {
    // Not a table of expectations: each verdict is taken from the real matcher,
    // so a change to `matchesDomain` that makes a spelling work (or stop
    // working) fails here instead of leaving the diagnostic quietly wrong.
    const spellings = [
      'example.com',
      '*.example.com',
      'example.com:443',
      'https://example.com',
      'ex:am:ple.com',
      '[2606:4700::1111]',
      '2606:4700::1111',
      '[2606:4700::1111]:443',
    ];
    const hosts = ['example.com', 'api.example.com', '2606:4700::1111', '[2606:4700::1111]'];
    const resolve = async (): Promise<string[]> => ['93.184.216.34'];
    let matched = 0;
    for (const domain of spellings) {
      let matchesSomething = false;
      for (const host of hosts) {
        const verdict = await isDeniedNetworkTarget(host, { deniedDomains: [domain], resolve });
        if (verdict.denied && verdict.reason?.includes('deniedDomains')) matchesSomething = true;
      }
      if (matchesSomething) matched += 1;
      expect({ domain, unmatchable: unmatchableDomainReason(domain) !== null })
        .toEqual({ domain, unmatchable: !matchesSomething });
    }
    // The guard is alive at all — without this the agreement would hold
    // vacuously if every spelling stopped matching.
    expect(matched).toBeGreaterThan(0);
  });
});

/**
 * P6.253 — the eight `sandbox.network` transport keys are DECIDED refusals,
 * not an oversight, and removing one has to be a visible decision.
 *
 * The row asks for them to reach the claude child. Two independent reasons
 * that is not what lands, both recorded on the list itself: the standing owner
 * decision that OS isolation is off and the wrapper is ours, and the measured
 * fact that the SDK's restrictive managed-settings filter copies exactly one
 * of the eight — so projecting the other seven would be a silent drop inside
 * the SDK rather than enforcement.
 */
describe('the sandbox.network transport keys stay refused, by name (P6.253)', () => {
  const TRANSPORT_KEYS = [
    'strictAllowlist',
    'tlsTerminate',
    'httpProxyPort',
    'socksProxyPort',
    'allowUnixSockets',
    'allowAllUnixSockets',
    'allowLocalBinding',
    'allowMachLookup',
  ];

  it('every one of the eight is a recorded refusal, so none can be dropped quietly', () => {
    for (const key of TRANSPORT_KEYS) {
      expect({ key, declined: DOCUMENTED_UNCARRIED_SANDBOX_KEYS.has(`sandbox.network.${key}`) })
        .toEqual({ key, declined: true });
    }
  });

  it('and the parser still refuses them with the DECIDED sentence, not the typo one', () => {
    // The positive control for the whole family: one key driven through the
    // real parser, so the list above is not merely a list.
    let message = '';
    try {
      parseManagedSandboxSettingsV1({ network: { allowLocalBinding: true } });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain('allowLocalBinding');
    expect(message).toContain('deliberately not carried here');
  });
});
