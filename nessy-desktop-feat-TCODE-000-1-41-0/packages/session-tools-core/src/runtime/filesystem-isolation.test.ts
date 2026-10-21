import { describe, it, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { userInfo } from 'node:os';
import { isAbsolute } from 'node:path';
import { credentialDenyRoots } from './credential-deny-roots.ts';
import { applyFilesystemIsolation, buildDarwinSandboxProfile } from './filesystem-isolation.ts';
import {
  machLookupRule,
  NETWORK_SANDBOX_MACH_SERVICES,
  SANDBOX_MACH_SERVICES,
} from './mach-services.ts';
import { applyNetworkIsolation } from './network-isolation.ts';
import { resolveTrustedIsolationLauncher } from './trusted-isolation-launchers.ts';

describe('buildDarwinSandboxProfile', () => {
  it('includes session subpath write allow', () => {
    const profile = buildDarwinSandboxProfile('/tmp/nessy-session');
    expect(profile).toContain('(allow file-write* (subpath "/tmp/nessy-session"))');
    expect(profile).toContain('(allow file-write* (literal "/dev/null"))');
    expect(profile).not.toContain('(allow file-write* (subpath "/dev"))');
    expect(profile).not.toContain('(deny network*)');
    expect(profile).toContain('(allow network*)');
    expect(profile).toContain(machLookupRule(SANDBOX_MACH_SERVICES));
    expect(profile).toContain(machLookupRule(NETWORK_SANDBOX_MACH_SERVICES));
  });

  it('allows null-device output without granting other device writes on macOS', () => {
    if (process.platform !== 'darwin') return;
    const result = spawnSync('/usr/bin/sandbox-exec', [
      '-p',
      buildDarwinSandboxProfile('/tmp/nessy-session'),
      '/bin/sh',
      '-c',
      'printf ignored > /dev/null',
    ], { encoding: 'utf-8' });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
  });

  it('includes deny network when requested', () => {
    const profile = buildDarwinSandboxProfile('/tmp/nessy-session', { includeNetworkDeny: true });
    expect(profile).toContain('(deny network*)');
    expect(profile).not.toContain('(allow network*)');
    expect(profile).toContain(machLookupRule(SANDBOX_MACH_SERVICES));
    // The resolver-config and trust-evaluation names belong to the network-capable
    // profiles alone; a network-denied profile has no use for either.
    expect(profile).not.toContain(machLookupRule(NETWORK_SANDBOX_MACH_SERVICES));
  });

  it('allows only explicitly supplied host scratch roots in addition to the session', () => {
    const profile = buildDarwinSandboxProfile('/tmp/nessy-session', {
      additionalWritableRoots: ['/tmp/nessy-process-scratch'],
    });
    expect(profile).toContain('(allow file-write* (subpath "/tmp/nessy-process-scratch"))');
    expect(profile).not.toContain('(allow file-write* (subpath "/tmp/nessy-process-sibling"))');
  });

  it('denies reads and writes for host-owned sensitive roots', () => {
    const profile = buildDarwinSandboxProfile('/tmp/nessy-session', {
      deniedReadRoots: ['/private/nessy/credentials.enc'],
    });
    expect(profile).toContain('(deny file-read* (subpath "/private/nessy/credentials.enc"))');
    expect(profile).toContain('(deny file-write* (subpath "/private/nessy/credentials.enc"))');
  });

  // sandboxing.md:363 - `denyWrite` blocks subprocess writes; unlike `denyRead`
  // it must leave the path readable, and it has to hold INSIDE a wider grant,
  // which on sandbox-exec means being emitted after every allow.
  it('denies writes without denying reads, and wins inside a wider grant', () => {
    const profile = buildDarwinSandboxProfile('/tmp/nessy-session', {
      additionalWritableRoots: ['/srv/shared'],
      deniedWriteRoots: ['/srv/shared/protected', '/usr/local/bin'],
    });
    expect(profile).toContain('(deny file-write* (subpath "/srv/shared/protected"))');
    expect(profile).toContain('(deny file-write* (subpath "/usr/local/bin"))');
    expect(profile).not.toContain('(deny file-read* (subpath "/srv/shared/protected"))');
    expect(profile.indexOf('(deny file-write* (subpath "/srv/shared/protected"))'))
      .toBeGreaterThan(profile.indexOf('(allow file-write* (subpath "/srv/shared"))'));
  });

  it('lets a read deny subsume a write deny for the same root', () => {
    const profile = buildDarwinSandboxProfile('/tmp/nessy-session', {
      deniedReadRoots: ['/srv/secret'],
      deniedWriteRoots: ['/srv/secret'],
    });
    expect(profile).toContain('(deny file-read* (subpath "/srv/secret"))');
    expect(profile.match(/\(deny file-write\* \(subpath "\/srv\/secret"\)\)/g)).toHaveLength(1);
  });

  it('denies the credential paths in the rendered darwin profile', () => {
    const profile = buildDarwinSandboxProfile('/tmp/nessy-session', {
      deniedReadRoots: credentialDenyRoots('/Users/x', '/Users/x/.nessy-agent'),
    });
    for (const denied of [
      '/Users/x/.ssh',
      '/Users/x/.aws',
      // The whole shared nessy-cli dir, not just dp_auth_creds.json — sibling
      // `.bak` copies of the same JWT live there and are not ours to predict.
      '/Users/x/.nessy',
    ]) {
      expect(profile).toContain(`(deny file-read* (subpath "${denied}"))`);
    }
    // The pre-existing deny must survive being folded into the shared list.
    expect(profile).toContain('(deny file-read* (subpath "/Users/x/.nessy-agent/credentials.enc"))');
  });

  it('never resolves an isolation launcher through PATH', () => {
    for (const launcher of ['sandbox-exec', 'bwrap', 'firejail', 'unshare', 'true'] as const) {
      const resolved = resolveTrustedIsolationLauncher(launcher);
      if (resolved !== undefined) expect(isAbsolute(resolved)).toBe(true);
      expect(resolved).not.toBe(launcher);
    }
  });

  it('returns absolute host-owned launchers for every enforced isolation plan', () => {
    const filesystem = applyFilesystemIsolation('/bin/echo', ['ok'], '/tmp/nessy-session');
    const network = applyNetworkIsolation('/bin/echo', ['ok']);
    if (filesystem.status === 'enforced') expect(isAbsolute(filesystem.command)).toBe(true);
    if (network.status === 'enforced') expect(isAbsolute(network.command)).toBe(true);
  });

  it('allows shell initialization and current-user lookup', () => {
    const profile = buildDarwinSandboxProfile('/tmp/nessy-session');
    expect(profile).toContain('(global-name "com.apple.system.opendirectoryd.libinfo")');
    expect(profile).toContain('(allow file-write* (literal "/dev/null"))');
    expect(profile).toContain('(allow file-ioctl (literal "/dev/null"))');
  });

  // The finding: a bare `(allow mach-lookup)` has NO filter, so it grants every
  // registered mach service by name — including the pasteboard. Both profiles are
  // asserted because the grant was emitted twice, once for all four profiles and
  // once more in the network branch.
  it('never emits an unfiltered mach-lookup grant', () => {
    for (const options of [undefined, { includeNetworkDeny: true }] as const) {
      const profile = buildDarwinSandboxProfile('/tmp/nessy-session', options);
      expect(profile).not.toMatch(/\(allow mach-lookup\)/);
      for (const forbidden of [
        'com.apple.pasteboard.1',
        'com.apple.CoreServices.coreservicesd',
        'com.apple.lsd.mapdb',
        'com.apple.SecurityServer',
      ]) {
        expect(profile).not.toContain(forbidden);
      }
    }
  });

  it('emits one filtered rule per name and refuses an empty allowlist', () => {
    expect(machLookupRule(['com.apple.a', 'com.apple.b']))
      .toBe('(allow mach-lookup (global-name "com.apple.a") (global-name "com.apple.b"))');
    // An empty list must throw rather than degrade to `(allow mach-lookup)`,
    // which seatbelt reads as "every service".
    expect(() => machLookupRule([])).toThrow('mach-lookup-allowlist-empty');
  });

  // The probe from the finding, inverted, plus the other half of the gate: a
  // command that legitimately needs a mach service must still work, or the
  // sandbox gets switched off and then protects nothing.
  it('refuses the pasteboard while current-user lookup still resolves', () => {
    if (process.platform !== 'darwin') return;
    const sandboxExec = resolveTrustedIsolationLauncher('sandbox-exec');
    if (!sandboxExec) return;
    const profile = buildDarwinSandboxProfile('/tmp/nessy-session');

    const pasteboard = spawnSync(sandboxExec, ['-p', profile, '/usr/bin/pbpaste'], { stdio: 'ignore' });
    expect(pasteboard.status).not.toBe(0);

    // `id -un` needs `com.apple.system.opendirectoryd.libinfo`; with mach-lookup
    // denied outright it prints the raw uid instead of the user name.
    const whoami = spawnSync(sandboxExec, ['-p', profile, '/usr/bin/id', '-un'], { encoding: 'utf-8' });
    expect(whoami.status).toBe(0);
    expect(whoami.stdout.trim()).toBe(userInfo().username);
  });
});
