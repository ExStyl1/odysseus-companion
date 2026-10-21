import { describe, it, expect, beforeEach } from 'bun:test';
import { mkdirSync, mkdtempSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  resolveDpBinary,
  resolveDpRuntime,
  managedDpBinaryPath,
  managedDpStateRoot,
  nessyCliDpBinaryPath,
  demoteDpBinary,
  clearDemotedDpBinaries,
  getDpVersion,
  isDpVersionSupported,
  DP_MIN_VERSION,
  NESSY_DP_ENV,
} from '../dp-binary.ts';
import { DpAuthError, DpAuthServiceError } from '../errors.ts';
import { printToken } from '../dp-api.ts';
import { createFakeDp } from './fake-dp.ts';

/**
 * Every arm below pins the two lower rungs (`configDir`, `nessyDir`) at empty
 * temp directories and `homeDir` at a fake home. Without them the ladder reads
 * the DEVELOPER's `<CONFIG_DIR>/dp/bin/dp`, their `~/.nessy/dp_latest/dp` and
 * their `~/.dp` — and on a machine with nessy-cli installed the "absent
 * everywhere" arm would find rung 4 and stop throwing. A resolver that walks
 * the real home is right in production and is a host dependency in a test.
 */
function isolated(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    env: {},
    configDir: mkdtempSync(join(tmpdir(), 'dp-config-')),
    nessyDir: mkdtempSync(join(tmpdir(), 'dp-nessy-')),
    homeDir: mkdtempSync(join(tmpdir(), 'dp-home-')),
    ...over,
  };
}

describe('resolveDpBinary', () => {
  beforeEach(() => clearDemotedDpBinaries());

  it('finds dp on PATH', () => {
    const fake = createFakeDp();
    const resolved = resolveDpBinary(isolated({
      pathEnv: fake.dir,
      fallbackPath: join(tmpdir(), 'nonexistent-dp-fallback'),
    }));
    expect(resolved).toBe(fake.binary);
  });

  it('falls back when dp is not on PATH', () => {
    const fake = createFakeDp();
    const emptyDir = mkdtempSync(join(tmpdir(), 'empty-path-'));
    const resolved = resolveDpBinary(isolated({
      pathEnv: emptyDir,
      fallbackPath: fake.binary,
    }));
    expect(resolved).toBe(fake.binary);
  });

  it('throws DpNotFound (never downloads) when dp is absent from every rung', () => {
    const emptyDir = mkdtempSync(join(tmpdir(), 'empty-path-'));
    let error: unknown;
    try {
      resolveDpBinary(isolated({
        pathEnv: emptyDir,
        fallbackPath: join(tmpdir(), 'nonexistent-dp-fallback'),
      }));
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(DpAuthServiceError);
    expect((error as DpAuthServiceError).code).toBe(DpAuthError.DpNotFound);
  });

  it('prefers PATH over the fallback', () => {
    const onPath = createFakeDp();
    const fallback = createFakeDp();
    const resolved = resolveDpBinary(isolated({
      pathEnv: onPath.dir,
      fallbackPath: fallback.binary,
    }));
    expect(resolved).toBe(onPath.binary);
  });
});

describe('resolveDpRuntime — the ladder (DA1.6, DP-1 amended)', () => {
  beforeEach(() => clearDemotedDpBinaries());

  const nowhere = join(tmpdir(), 'nonexistent-dp-fallback');

  /**
   * Table-driven on an INJECTED executable-bit predicate: no exec, no network,
   * no dependence on what this machine has installed. `runnable` is the exact
   * set of paths the predicate answers true for.
   */
  function ladder(runnable: string[], over: Record<string, unknown> = {}) {
    const configDir = mkdtempSync(join(tmpdir(), 'dp-config-'));
    const nessyDir = mkdtempSync(join(tmpdir(), 'dp-nessy-'));
    const homeDir = mkdtempSync(join(tmpdir(), 'dp-home-'));
    return {
      configDir,
      nessyDir,
      homeDir,
      managed: managedDpBinaryPath(configDir),
      cli: nessyCliDpBinaryPath(nessyDir),
      record: resolveDpRuntime({
        env: {},
        pathEnv: '',
        fallbackPath: nowhere,
        configDir,
        nessyDir,
        homeDir,
        // `~/.dp` present on every arm unless an arm says otherwise, so the
        // workdir stays out of the way of the rung assertions.
        dirExists: () => true,
        isRunnable: (path: string) => runnable.includes(path),
        ...over,
      }),
    };
  }

  it('rung 1: NESSY_DP wins over every later rung, and labels its source', () => {
    const override = '/opt/corp/dp';
    const onPath = createFakeDp();
    const record = resolveDpRuntime({
      env: { [NESSY_DP_ENV]: override },
      pathEnv: onPath.dir,
      fallbackPath: nowhere,
      configDir: mkdtempSync(join(tmpdir(), 'dp-config-')),
      nessyDir: mkdtempSync(join(tmpdir(), 'dp-nessy-')),
      homeDir: mkdtempSync(join(tmpdir(), 'dp-home-')),
      dirExists: () => true,
      isRunnable: (path: string) => path === override || path === onPath.binary,
    });
    expect(record).toEqual({ dpPath: override, source: 'override' });
  });

  it('rung 1 that is not runnable FALLS THROUGH to the system dp', () => {
    const onPath = createFakeDp();
    const record = resolveDpRuntime({
      env: { [NESSY_DP_ENV]: '/opt/corp/missing-dp' },
      pathEnv: onPath.dir,
      fallbackPath: nowhere,
      configDir: mkdtempSync(join(tmpdir(), 'dp-config-')),
      nessyDir: mkdtempSync(join(tmpdir(), 'dp-nessy-')),
      homeDir: mkdtempSync(join(tmpdir(), 'dp-home-')),
      dirExists: () => true,
      isRunnable: (path: string) => path === onPath.binary,
    });
    expect(record.dpPath).toBe(onPath.binary);
    expect(record.source).toBe('system');
  });

  it('rung 2: the fallback path is still a SYSTEM dp', () => {
    const seen = ladder([nowhere]);
    expect(seen.record).toEqual({ dpPath: nowhere, source: 'system' });
  });

  it('rung 3: the managed copy answers when no system dp is runnable', () => {
    const configDir = mkdtempSync(join(tmpdir(), 'dp-config-'));
    const managed = managedDpBinaryPath(configDir);
    const record = resolveDpRuntime({
      env: {},
      pathEnv: '',
      fallbackPath: nowhere,
      configDir,
      nessyDir: mkdtempSync(join(tmpdir(), 'dp-nessy-')),
      homeDir: mkdtempSync(join(tmpdir(), 'dp-home-')),
      dirExists: () => true,
      isRunnable: (path: string) => path === managed,
    });
    expect(record).toEqual({ dpPath: managed, source: 'managed' });
  });

  it("rung 4: nessy-cli's own copy is the last rung before DpNotFound", () => {
    const configDir = mkdtempSync(join(tmpdir(), 'dp-config-'));
    const nessyDir = mkdtempSync(join(tmpdir(), 'dp-nessy-'));
    const cli = nessyCliDpBinaryPath(nessyDir);
    const record = resolveDpRuntime({
      env: {},
      pathEnv: '',
      fallbackPath: nowhere,
      configDir,
      nessyDir,
      homeDir: mkdtempSync(join(tmpdir(), 'dp-home-')),
      dirExists: () => true,
      isRunnable: (path: string) => path === cli,
    });
    expect(record).toEqual({ dpPath: cli, source: 'nessy-cli' });
  });

  it('a below-floor system dp is DESCENDED past while another rung is runnable', () => {
    const configDir = mkdtempSync(join(tmpdir(), 'dp-config-'));
    const nessyDir = mkdtempSync(join(tmpdir(), 'dp-nessy-'));
    const cli = nessyCliDpBinaryPath(nessyDir);
    const seams = {
      env: {},
      pathEnv: '',
      fallbackPath: nowhere,
      configDir,
      nessyDir,
      homeDir: mkdtempSync(join(tmpdir(), 'dp-home-')),
      dirExists: () => true,
      isRunnable: (path: string) => path === nowhere || path === cli,
    };
    expect(resolveDpRuntime(seams).source).toBe('system');
    demoteDpBinary(nowhere, 'below-floor');
    expect(resolveDpRuntime(seams).source).toBe('nessy-cli');
  });

  it('a demoted dp is still TAKEN when it is the only runnable one (warn-only floor)', () => {
    demoteDpBinary(nowhere, 'below-floor');
    const seen = ladder([nowhere]);
    expect(seen.record.dpPath).toBe(nowhere);
  });

  it('throws DpNotFound when no rung is runnable', () => {
    let error: unknown;
    try {
      ladder([]);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(DpAuthServiceError);
    expect((error as DpAuthServiceError).code).toBe(DpAuthError.DpNotFound);
  });

  it('is SYNC — the seam never returns a promise and never execs', () => {
    const seen = ladder([nowhere]);
    expect(seen.record).not.toBeInstanceOf(Promise);
    expect(typeof (seen.record as { then?: unknown }).then).toBe('undefined');
  });
});

describe('resolveDpRuntime — the workdir (Target scheme clause 3)', () => {
  beforeEach(() => clearDemotedDpBinaries());

  const nowhere = join(tmpdir(), 'nonexistent-dp-fallback');

  function withWorkdir(over: Record<string, unknown>) {
    const configDir = mkdtempSync(join(tmpdir(), 'dp-config-'));
    const nessyDir = mkdtempSync(join(tmpdir(), 'dp-nessy-'));
    const homeDir = mkdtempSync(join(tmpdir(), 'dp-home-'));
    const created: string[] = [];
    return {
      configDir,
      created,
      record: resolveDpRuntime({
        env: {},
        pathEnv: '',
        fallbackPath: nowhere,
        configDir,
        nessyDir,
        homeDir,
        isRunnable: (path: string) => path === nowhere,
        ensureStateRoot: (dir: string) => { created.push(dir); },
        ...over,
      }),
    };
  }

  it('~/.dp present → NO workdir, so dp uses the user own session', () => {
    const seen = withWorkdir({ dirExists: () => true });
    expect(seen.record.workdir).toBeUndefined();
    expect(seen.created).toEqual([]);
  });

  it('~/.dp present → NO workdir on the managed rung either', () => {
    const configDir = mkdtempSync(join(tmpdir(), 'dp-config-'));
    const managed = managedDpBinaryPath(configDir);
    const record = resolveDpRuntime({
      env: {},
      pathEnv: '',
      fallbackPath: nowhere,
      configDir,
      nessyDir: mkdtempSync(join(tmpdir(), 'dp-nessy-')),
      homeDir: mkdtempSync(join(tmpdir(), 'dp-home-')),
      dirExists: () => true,
      isRunnable: (path: string) => path === managed,
      ensureStateRoot: () => { throw new Error('must not be called'); },
    });
    expect(record.source).toBe('managed');
    expect(record.workdir).toBeUndefined();
  });

  /**
   * F1.363 — with neither `DP_WORKDIR` nor `~/.dp`, the ladder used to create
   * and hand dp `<CONFIG_DIR>/dp/state`, so a login we triggered was invisible
   * to the user's terminal dp and to every `dp ai mcp` server (both read dp's
   * own `~/.dp`). No reason for that fallback was recorded anywhere (the
   * resolver's docblock itself called dp making its own `~/.dp` "the outcome
   * clause 3 prefers anyway"), so dp now uses its own default and nothing is
   * created on our side.
   */
  it('~/.dp absent → NO workdir either: dp uses its own default, and nothing is created (F1.363)', () => {
    const seen = withWorkdir({ dirExists: () => false });
    expect(seen.record.workdir).toBeUndefined();
    expect(seen.created).toEqual([]);
    expect(readdirSync(seen.configDir)).toEqual([]);
  });

  it('(+) a temp HOME with no .dp → the dp child receives no DP_WORKDIR (F1.363)', async () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'dp-home-without-dp-'));
    const fake = createFakeDp({ loggedIn: true, token: 'tok-f1363' });
    const record = resolveDpRuntime({
      env: {},
      pathEnv: '',
      fallbackPath: fake.binary,
      configDir: mkdtempSync(join(tmpdir(), 'dp-config-')),
      nessyDir: mkdtempSync(join(tmpdir(), 'dp-nessy-')),
      homeDir,
    });
    expect(record.dpPath).toBe(fake.binary);
    expect(record.workdir).toBeUndefined();
    expect(await printToken(record.dpPath, { workdir: record.workdir })).toBe('tok-f1363');
    expect(fake.childEnv()[0]).toContain('|DP_WORKDIR=|');
  });

  it('(control) an existing ~/.dp is left exactly as it was', () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'dp-home-with-dp-'));
    const dotDp = join(homeDir, '.dp');
    mkdirSync(dotDp, { mode: 0o700 });
    const before = statSync(dotDp).mtimeMs;
    const seen = withWorkdir({ homeDir, dirExists: undefined });
    expect(seen.record.workdir).toBeUndefined();
    expect(readdirSync(dotDp)).toEqual([]);
    expect(statSync(dotDp).mtimeMs).toBe(before);
  });

  it('the state root is NEVER ~/.nessy/dp_latest (DP-1 revocation) — nor anything of ours', () => {
    const nessyDir = mkdtempSync(join(tmpdir(), 'dp-nessy-'));
    const seen = withWorkdir({ dirExists: () => false, nessyDir });
    expect(seen.record.workdir).toBeUndefined();
    expect(managedDpStateRoot(seen.configDir)).not.toContain('dp_latest');
  });

  it('(control) an explicit DP_WORKDIR wins — it is dp own variable — with or without ~/.dp', () => {
    for (const present of [true, false]) {
      const seen = withWorkdir({ env: { DP_WORKDIR: '/tmp/dp-state-of-mine' }, dirExists: () => present });
      expect({ present, workdir: seen.record.workdir }).toEqual({ present, workdir: '/tmp/dp-state-of-mine' });
      expect(seen.created).toEqual([]);
    }
  });
});

describe('getDpVersion', () => {
  it('parses the version line', async () => {
    const fake = createFakeDp({ version: '13.24.1' });
    expect(await getDpVersion(fake.binary)).toBe('13.24.1');
  });

  it('returns null on parse failure', async () => {
    // A binary that exists but prints nothing parseable → null, no throw.
    expect(await getDpVersion('/bin/echo')).toBeNull();
  });

  it('returns null when the binary cannot be executed', async () => {
    expect(await getDpVersion('/definitely/not/a/binary')).toBeNull();
  });

  it(
    'a SLOW but successful `dp version` still returns the version (the C3.391 budget)',
    async () => {
      // `dp version` is a SUBCOMMAND, so it pays dp's startup hook exactly as
      // `dp auth print-token` does — the row was born believing this constant
      // was exempt and it is not. Six seconds is above the 5 s this shipped with
      // and below the 30 s it is sized to now. It matters even though the probe
      // is advisory: a version probe that always times out returns null,
      // `isDpVersionSupported(null)` is true, and the "dp is outdated" warning
      // then never fires for the users whose dp is slow enough to need it.
      const fake = createFakeDp({ version: '13.50.0', versionDelaySeconds: 6 });
      const start = Date.now();
      expect(await getDpVersion(fake.binary)).toBe('13.50.0');
      expect(Date.now() - start).toBeGreaterThan(5_000);
    },
    60_000,
  );

  it('kills an active version probe when the caller aborts', async () => {
    const fake = createFakeDp({ hangVersion: true });
    const controller = new AbortController();
    const pending = getDpVersion(fake.binary, { signal: controller.signal });
    while (fake.countCalls('version') === 0) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const started = Date.now();
    controller.abort();

    expect(await pending).toBeNull();
    expect(Date.now() - started).toBeLessThan(2_000);
    const markerStart = Date.now();
    while (!fake.gotSigterm() && Date.now() - markerStart < 2_000) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(fake.gotSigterm()).toBe(true);
  });
});

describe('isDpVersionSupported', () => {
  it('accepts versions at or above the floor', () => {
    expect(isDpVersionSupported('13.0.0')).toBe(true);
    expect(isDpVersionSupported('13.24.1')).toBe(true);
    expect(isDpVersionSupported('14.0.0')).toBe(true);
  });

  it('rejects versions below the floor', () => {
    expect(isDpVersionSupported('12.99.99')).toBe(false);
    expect(isDpVersionSupported('12.0.0')).toBe(false);
  });

  it('treats unknown version as supported (advisory-only)', () => {
    expect(isDpVersionSupported(null)).toBe(true);
  });

  it('uses DP_MIN_VERSION as the default floor', () => {
    expect(DP_MIN_VERSION).toBe('13.0.0');
  });
});
