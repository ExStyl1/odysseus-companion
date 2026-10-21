/**
 * DA1.48 — rung 5 of the dp ladder, and the pin script that feeds it.
 *
 * NOTHING HERE TOUCHES THE NETWORK OR A REAL dp. Every arm serves a fabricated
 * asset (a `/bin/sh` script) from a LOCAL server on 127.0.0.1 and pins the
 * sha256 and length of the exact bytes it serves, so the verify step is proved
 * against a digest this file computed rather than one it was told. The real dp
 * asset is ~23 MB behind a corp host and a suite may never fetch it.
 *
 * ISOLATION. Every arm injects `configDir`, `nessyDir`, `homeDir`, `pathEnv`
 * and `fallbackPath`, so the ladder underneath the provisioner cannot walk the
 * developer's `~/.nessy-agent`, their `~/.nessy/dp_latest/dp` (which exists on
 * a machine with nessy-cli, and would turn every arm into the short-circuit) or
 * their `~/.dp`. `NESSY_HOME` is deleted per case and restored delete-then-
 * assign (DA1.36, and the Bun env trap: an assignment without the delete is
 * invisible to the spread every subprocess env is built from). `bun test`'s own
 * preload has already pointed `NESSY_CONFIG_DIR` at a private temp directory
 * for this process, so `CONFIG_DIR` is never the real one either — but no arm
 * depends on that, because each passes its own.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ensureManagedDp,
  type DpAssetPinTable,
  type EnsureManagedDpOptions,
} from '../dp-provision.ts';
import {
  clearDemotedDpBinaries,
  dpBinaryDemotion,
  managedDpBinaryPath,
  resolveDpRuntime,
} from '../dp-binary.ts';
import { DpAuthError, DpAuthServiceError } from '../errors.ts';
import { relatchHomeDirForTests } from '../../../config/home-latch.ts';

/** A fabricated dp that answers the liveness run the way the real one does. */
const LIVE_ASSET = `#!/bin/sh
echo "Spirit CLI Version: 13.14.1 prod (fake asset)"
`;

/** The same asset, truncated in the one way that matters: it does not run. */
const DEAD_ASSET = `#!/bin/sh
echo "fake asset: this build cannot run here" >&2
exit 1
`;

const PIN_VERSION = '13.14.1';

interface AssetServer {
  /** `http://127.0.0.1:<port>/dp`, the shape nessy-cli's prefix has. */
  urlPrefix: string;
  /** Request paths seen, in order — the only instrument that counts fetches. */
  paths: string[];
  close(): Promise<void>;
}

async function startAssetServer(body: string): Promise<AssetServer> {
  const bytes = Buffer.from(body, 'utf-8');
  const paths: string[] = [];
  const server: Server = createServer((req, res) => {
    paths.push(req.url ?? '');
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(bytes.byteLength),
    });
    res.end(bytes);
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  return {
    urlPrefix: `http://127.0.0.1:${port}/dp`,
    paths,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

function assetUrl(prefix: string, platform = 'darwin'): string {
  return `${prefix}/${PIN_VERSION}/${platform}/dp`;
}

/** A pin over the EXACT bytes the server serves, unless an arm bends one field. */
function pinFor(url: string, body: string, over: Partial<{ sha256: string; byteLength: number }> = {}): DpAssetPinTable {
  const bytes = Buffer.from(body, 'utf-8');
  return {
    version: PIN_VERSION,
    assets: {
      darwin: {
        url,
        sha256: over.sha256 ?? createHash('sha256').update(bytes).digest('hex'),
        byteLength: over.byteLength ?? bytes.byteLength,
      },
    },
  };
}

let configDir = '';
let nessyDir = '';
let fakeHome = '';
let emptyDir = '';
let savedNessyHome: string | undefined;

function ladderOptions(): EnsureManagedDpOptions {
  return {
    env: {},
    pathEnv: emptyDir,
    fallbackPath: join(emptyDir, 'no-such-dp'),
    configDir,
    nessyDir,
    homeDir: fakeHome,
    platform: 'darwin',
  };
}

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), 'dp-provision-config-'));
  nessyDir = mkdtempSync(join(tmpdir(), 'dp-provision-nessy-'));
  fakeHome = mkdtempSync(join(tmpdir(), 'dp-provision-home-'));
  emptyDir = mkdtempSync(join(tmpdir(), 'dp-provision-empty-'));
  savedNessyHome = process.env.NESSY_HOME;
  delete process.env.NESSY_HOME;
  relatchHomeDirForTests(fakeHome);
  clearDemotedDpBinaries();
});

afterEach(() => {
  delete process.env.NESSY_HOME;
  if (savedNessyHome !== undefined) process.env.NESSY_HOME = savedNessyHome;
  relatchHomeDirForTests();
  clearDemotedDpBinaries();
});

function managedPath(): string {
  return managedDpBinaryPath(configDir);
}

function leftoverTemps(): string[] {
  const binDir = join(configDir, 'dp', 'bin');
  if (!existsSync(binDir)) return [];
  return readdirSync(binDir).filter((name) => name.includes('.download-'));
}

function ladderThrowsNotFound(): boolean {
  try {
    resolveDpRuntime(ladderOptions());
    return false;
  } catch (error) {
    return error instanceof DpAuthServiceError && error.code === DpAuthError.DpNotFound;
  }
}

describe('ensureManagedDp', () => {
  it('is INERT on the empty pin this file ships: no fetch, no file, the ladder unchanged', async () => {
    const server = await startAssetServer(LIVE_ASSET);
    try {
      // The shipped shape: a version nobody has taken and no platform entries.
      const result = await ensureManagedDp({ ...ladderOptions(), pin: { version: '', assets: {} } });
      expect(result.outcome).toBe('inert');
      expect(server.paths).toHaveLength(0);
      expect(existsSync(managedPath())).toBe(false);
      // The whole promise of an empty pin: rung 5 changes nothing above it.
      expect(ladderThrowsNotFound()).toBe(true);
    } finally {
      await server.close();
    }
  });

  it('downloads, verifies, chmods, runs and renames into the rung-3 slot', async () => {
    const server = await startAssetServer(LIVE_ASSET);
    try {
      const url = assetUrl(server.urlPrefix);
      const result = await ensureManagedDp({ ...ladderOptions(), pin: pinFor(url, LIVE_ASSET) });
      expect(result.outcome).toBe('provisioned');
      expect(result.dpPath).toBe(managedPath());
      expect(server.paths).toEqual([`/dp/${PIN_VERSION}/darwin/dp`]);
      expect(existsSync(managedPath())).toBe(true);
      expect(statSync(managedPath()).mode & 0o777).toBe(0o700);
      expect(leftoverTemps()).toEqual([]);
      // The point of writing there: the ladder now answers it, as rung 3.
      const record = resolveDpRuntime(ladderOptions());
      expect(record.dpPath).toBe(managedPath());
      expect(record.source).toBe('managed');
    } finally {
      await server.close();
    }
  });

  it('refuses a digest that does not match the pin and records nothing durable', async () => {
    const server = await startAssetServer(LIVE_ASSET);
    try {
      const url = assetUrl(server.urlPrefix);
      const result = await ensureManagedDp({
        ...ladderOptions(),
        pin: pinFor(url, LIVE_ASSET, { sha256: 'f'.repeat(64) }),
      });
      expect(result.outcome).toBe('digest-mismatch');
      expect(existsSync(managedPath())).toBe(false);
      expect(leftoverTemps()).toEqual([]);
      // Not the binary's fault: no negative cache, so a later attempt may retry.
      expect(dpBinaryDemotion(managedPath())).toBeUndefined();
      expect(ladderThrowsNotFound()).toBe(true);
    } finally {
      await server.close();
    }
  });

  it('refuses a length that does not match the pin, before hashing anything', async () => {
    const server = await startAssetServer(LIVE_ASSET);
    try {
      const url = assetUrl(server.urlPrefix);
      const result = await ensureManagedDp({
        ...ladderOptions(),
        // Length bent by one byte; the digest is the CORRECT one, so only the
        // length check can produce this verdict.
        pin: pinFor(url, LIVE_ASSET, { byteLength: Buffer.byteLength(LIVE_ASSET) + 1 }),
      });
      expect(result.outcome).toBe('size-mismatch');
      expect(existsSync(managedPath())).toBe(false);
      expect(dpBinaryDemotion(managedPath())).toBeUndefined();
    } finally {
      await server.close();
    }
  });

  it('a downloaded binary that does not run is demoted ONCE and never re-downloaded', async () => {
    const server = await startAssetServer(DEAD_ASSET);
    try {
      const url = assetUrl(server.urlPrefix);
      const options = { ...ladderOptions(), pin: pinFor(url, DEAD_ASSET) };

      const first = await ensureManagedDp(options);
      expect(first.outcome).toBe('unrunnable');
      // The reserved reason gets its only honest producer.
      expect(dpBinaryDemotion(managedPath())).toBe('unrunnable');
      // Never renamed into place: a dead file at rung 3 would be preferred by
      // its executable bit on every later resolve.
      expect(existsSync(managedPath())).toBe(false);
      expect(leftoverTemps()).toEqual([]);
      expect(server.paths).toHaveLength(1);

      const second = await ensureManagedDp(options);
      expect(second.outcome).toBe('cached-unrunnable');
      expect(server.paths).toHaveLength(1);
    } finally {
      await server.close();
    }
  });

  it('single-flights: two concurrent callers cost ONE download', async () => {
    const server = await startAssetServer(LIVE_ASSET);
    try {
      const url = assetUrl(server.urlPrefix);
      const options = { ...ladderOptions(), pin: pinFor(url, LIVE_ASSET) };
      const [a, b] = await Promise.all([ensureManagedDp(options), ensureManagedDp(options)]);
      expect(a.outcome).toBe('provisioned');
      expect(b.outcome).toBe('provisioned');
      expect(server.paths).toHaveLength(1);
      expect(leftoverTemps()).toEqual([]);
    } finally {
      await server.close();
    }
  });

  it('does not run at all when rung 4 already answers', async () => {
    const server = await startAssetServer(LIVE_ASSET);
    try {
      // nessy-cli's own managed copy — the population rung 5 is not for.
      const dpLatest = join(nessyDir, 'dp_latest');
      mkdirSync(dpLatest, { recursive: true });
      const theirDp = join(dpLatest, 'dp');
      writeFileSync(theirDp, LIVE_ASSET);
      chmodSync(theirDp, 0o755);

      const url = assetUrl(server.urlPrefix);
      const result = await ensureManagedDp({ ...ladderOptions(), pin: pinFor(url, LIVE_ASSET) });
      expect(result.outcome).toBe('not-needed');
      expect(result.source).toBe('nessy-cli');
      expect(result.dpPath).toBe(theirDp);
      expect(server.paths).toHaveLength(0);
      expect(existsSync(managedPath())).toBe(false);
    } finally {
      await server.close();
    }
  });
});

/**
 * The pin script. It is the controller's close-out step and the ONLY thing
 * allowed to produce the three values, so its output shape is pinned here
 * against a served asset whose digest this file computed independently.
 */
describe('scripts/pin-dp-asset.ts', () => {
  const scriptPath = join(import.meta.dir, '../../../../../..', 'scripts', 'pin-dp-asset.ts');

  /**
   * ASYNC on purpose. `spawnSync` blocks this process's event loop, so the
   * loopback server above can never answer the child it just started — the
   * first draft of this case deadlocked and reported itself as a 5 000 ms
   * test timeout with no assertion failure, which is the signature AGENTS.md
   * warns has two causes. `stdin` is closed rather than inherited (a probe
   * runner that leaves stdin as a pipe is the `grep -c` hang).
   */
  function runScript(
    args: string[],
    extraEnv: NodeJS.ProcessEnv,
  ): Promise<{ status: number | null; stdout: string; stderr: string }> {
    return new Promise((resolve) => {
      const child = spawn(process.execPath, [scriptPath, ...args], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, NO_PROXY: '127.0.0.1,localhost', ...extraEnv },
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk: unknown) => {
        stdout += String(chunk);
      });
      child.stderr.on('data', (chunk: unknown) => {
        stderr += String(chunk);
      });
      child.on('close', (code) => resolve({ status: code, stdout, stderr }));
    });
  }

  it('resolves to the real script (the path math is a positive control)', () => {
    expect(existsSync(scriptPath)).toBe(true);
  });

  it(
    'prints the four pinned fields as JSON and nothing else',
    async () => {
      const server = await startAssetServer(LIVE_ASSET);
      try {
        const run = await runScript([PIN_VERSION, 'darwin'], {
          NESSY_DP_ASSET_URL_PREFIX: server.urlPrefix,
        });
        expect(run.status).toBe(0);
        // "and NOTHING else": the whole of stdout has to parse.
        const records = JSON.parse(run.stdout) as Array<Record<string, unknown>>;
        expect(records).toHaveLength(1);
        expect(records[0]).toEqual({
          version: PIN_VERSION,
          platform: 'darwin',
          url: assetUrl(server.urlPrefix),
          sha256: createHash('sha256').update(Buffer.from(LIVE_ASSET, 'utf-8')).digest('hex'),
          byteLength: Buffer.byteLength(LIVE_ASSET),
        });
        // It really fetched — the server is the instrument, not the exit code.
        expect(server.paths).toEqual([`/dp/${PIN_VERSION}/darwin/dp`]);
      } finally {
        await server.close();
      }
    },
    // A bun CHILD pays its own module-graph load; the 5 s default is sized for
    // in-process work and this case is two processes plus a round trip.
    30_000,
  );

  it(
    'refuses without a version and prints nothing on stdout',
    async () => {
      const run = await runScript([], {});
      expect(run.status).toBe(2);
      expect(run.stdout).toBe('');
      expect(run.stderr).toContain('usage:');
    },
    30_000,
  );
});
