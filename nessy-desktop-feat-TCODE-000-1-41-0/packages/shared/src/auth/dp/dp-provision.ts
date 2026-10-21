/**
 * Rung 5 of the dp ladder — the LAZY PINNED PROVISIONER (DA1.48, DA1.6 item 5).
 *
 * `resolveDpRuntime` (`dp-binary.ts`) already checks `<CONFIG_DIR>/dp/bin/dp`
 * as rung 3 and is SYNC, never execs and never downloads. This module is the
 * one thing allowed to write that path: it downloads the PINNED asset, proves
 * it against the pin, proves it runs, and renames it into place. Nothing above
 * it changes — a machine on which this never runs resolves exactly as before.
 *
 * ## INERT at HEAD, and that is the shipped state of this file
 *
 * {@link DP_ASSET_PIN} has an empty version and no platform entries, so
 * {@link ensureManagedDp} answers `'inert'` before any I/O: no fetch, no file,
 * no demotion. The pin VALUES are the controller's, taken once at a release
 * close-out from `scripts/pin-dp-asset.ts`, because they cannot be read from a
 * reference and cannot be invented:
 *
 * **nessy-cli publishes MD5 only** — `packages/core/src/dp/dpConfig.ts` symbol
 * `DP_CONFIG`, field `md5Checksums`, three platform digests at version
 * `13.14.1` (read 2026-09-18 at their `9d94ec5d4`) — while this pin verifies
 * `sha256` plus `byteLength`. So the digest is COMPUTED from the asset at pin
 * time by the script, and a lane may not fetch it. An empty pin is therefore
 * the honest state, not an unfinished one: a downloader whose verify step has
 * no pin is worse than no downloader.
 *
 * ## The order, and the reference it follows
 *
 * nessy-cli's own `packages/core/src/dp/dpDownloader.ts` symbol
 * `installFreshBinary` is the reference (read-do-not-invent, tier 2): temp file
 * BESIDE the target and pid-suffixed, execute bit before the run, liveness run,
 * rename, and `rm` of the temp on every failure. This follows it, with the two
 * differences named rather than left to be discovered:
 *
 *  1. **Verified BEFORE anything is written.** The bytes are checked against
 *     `byteLength` then `sha256` in memory, so a temp file is never created for
 *     bytes that fail the pin — strictly stronger than deleting one afterwards,
 *     and it is why the mismatch arms record nothing durable at all. The cost
 *     is holding the asset (~23 MB on this family) in memory once.
 *  2. **No `dp update`, ever.** The reference runs one after installing,
 *     because its copy is nessy-cli's to keep current. Ours is pinned: the
 *     whole verification is against a fixed digest, and a binary that updated
 *     itself would no longer match the thing we proved. Freshness is a bumped
 *     pin at a close-out. This also keeps the module inside DP-1's boundary —
 *     we never write another product's tree, and we never run their updater.
 *
 * ## The negative cache is the demotion registry's reserved `'unrunnable'`
 *
 * `demoteDpBinary`'s docblock reserved that reason for this row and named the
 * reason it can be produced honestly HERE: the producer has just written the
 * file, so a failed liveness run means exactly one thing. A producer reached
 * from `session-broker.ts` symbol `runProbe` had to pay a precondition this row
 * did not — `printToken` folded a spawn failure into a transient non-zero exit,
 * so a demotion there would have been inferred from a bare `ExecFailed`. DA1.77
 * paid it (`DpSpawnFailedError`), so that second producer now exists and is
 * equally earned. The registry is process-lifetime and the pin is a build
 * constant, so
 * "no re-download until the pin changes" and "no re-download for the rest of
 * this process" are the same sentence here.
 *
 * A failed liveness run is therefore terminal for the process and the temp is
 * deleted, so `<CONFIG_DIR>/dp/bin/dp` never comes to exist as a dead file the
 * ladder would then prefer by its executable bit. The reference folds a
 * TIMEOUT into the same verdict ("EACCES, ENOEXEC, ETXTBSY, timeout — all mean
 * not usable") and so does this: the sha256 has already proved the bytes are
 * the pinned asset, so the only thing left for the run to tell us is whether
 * this machine can execute it.
 *
 * ## What it deliberately does not do
 *
 *  - It does not run when the ladder already answers. Rung 4
 *    (`<NESSY_HOME>/dp_latest/dp`, nessy-cli's own copy) covers every machine
 *    with nessy-cli installed, and rung 2 covers every machine with a corp dp;
 *    rung 5's marginal population is the machine with neither.
 *  - It never throws. Every failure is a named outcome, because the caller is a
 *    best-effort background act and a rejected promise there is a crash report
 *    about a machine that simply has no dp.
 *  - It plumbs no proxy and no CA of its own. A bare `fetch` in this process
 *    already carries the app's trust chain — the Electron main installs a
 *    global undici dispatcher and the headless server projects the proxy
 *    environment and wraps `fetch` (`config/network-runtime.ts`) — and
 *    `exchange.ts`, the only other outbound call in this module, is a bare
 *    `fetch` for the same reason. One mechanism for every request.
 *  - It is not wired to a caller. The pin is empty, so a call site would be
 *    inert today and a product decision tomorrow; the seam is exported and the
 *    ladder needs no change above it when the pin lands.
 */

import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { chmod, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { promisify } from 'node:util';
import { CONFIG_DIR } from '../../config/paths.ts';
import { createLogger } from '../../utils/debug.ts';
import {
  demoteDpBinary,
  dpBinaryDemotion,
  managedDpBinaryPath,
  resolveDpRuntime,
  type DpRuntimeSource,
  type ResolveDpRuntimeOptions,
} from './dp-binary.ts';
import { dpExecEnv } from './internal.ts';

const execFileAsync = promisify(execFile);

/** Codes and paths only — never a token, never a response body. */
const log = createLogger('dp-auth');

/**
 * `0o700` — owner-only rwx, the mode nessy-cli gives the same file
 * (`DP_CONFIG.binaryMode`). The directory gets the same mode: a binary this
 * product downloaded is not something another account on the machine should be
 * able to replace.
 */
const BINARY_MODE = 0o700;

/** nessy-cli's `DP_CONFIG.downloadTimeout` — 5 min for a ~23 MB asset. */
const DOWNLOAD_TIMEOUT_MS = 5 * 60_000;

/** nessy-cli's `DP_CONFIG.versionCheckTimeout`. */
const LIVENESS_TIMEOUT_MS = 15_000;

/**
 * The liveness run is the FLAG form, `dp --version`, and the distinction is
 * measured rather than stylistic: `dp version` is a SUBCOMMAND and pays dp's
 * startup hook (`dp-api.ts` symbol `PRINT_TOKEN_TIMEOUT_MS` carries the table —
 * the subcommand costs the flag plus ~0.3 s in all three arms), while the flag
 * is exempt. nessy-cli's `isDpRunnable` uses the same flag and the same regex,
 * which is where the output shape comes from; asserting the output rather than
 * the exit code is what separates "a file that execs" from "the dp we pinned".
 */
const DP_VERSION_OUTPUT = /Spirit CLI Version: (\d+\.\d+\.\d+)/;

/** Platforms the asset host publishes a dp for (nessy-cli's `DpPlatform`). */
export type DpAssetPlatform = 'darwin' | 'linux' | 'win32';

/** One platform's pinned asset. `url` is recorded verbatim by the pin script. */
export interface DpAssetPin {
  readonly url: string;
  /** Lowercase hex, computed from the asset at pin time. */
  readonly sha256: string;
  readonly byteLength: number;
}

export interface DpAssetPinTable {
  /** dp version the pin was taken at. Empty means no pin at all. */
  readonly version: string;
  readonly assets: Partial<Record<DpAssetPlatform, DpAssetPin>>;
}

/**
 * THE PIN — empty at HEAD, by decision (see this module's header).
 *
 * Filled at a release close-out from `bun scripts/pin-dp-asset.ts <version>`,
 * whose output is exactly the four fields below per platform. Nothing else in
 * this tree may write it: a hand-typed digest is a digest nobody computed.
 */
export const DP_ASSET_PIN: DpAssetPinTable = {
  version: '',
  assets: {},
};

/**
 * Why the provisioner did what it did. Diagnostic only — no caller switches on
 * it today, and `'inert'`, `'not-needed'` and `'cached-unrunnable'` are the
 * three that perform no I/O whatsoever.
 */
export type DpProvisionOutcome =
  | 'inert'
  | 'not-needed'
  | 'cached-unrunnable'
  | 'download-failed'
  | 'size-mismatch'
  | 'digest-mismatch'
  | 'unrunnable'
  | 'install-failed'
  | 'provisioned';

export interface DpProvisionResult {
  readonly outcome: DpProvisionOutcome;
  /** The managed path, or the path the ladder answered with on `'not-needed'`. */
  readonly dpPath: string;
  /** Which rung answered, on `'not-needed'` only. */
  readonly source?: DpRuntimeSource;
}

export interface EnsureManagedDpOptions extends ResolveDpRuntimeOptions {
  /** The pin table. Production passes nothing and gets {@link DP_ASSET_PIN}. */
  pin?: DpAssetPinTable;
  /** Platform key. Test seam; production reads `process.platform`. */
  platform?: string;
  /** Download budget. Test seam. */
  downloadTimeoutMs?: number;
  /** Liveness budget. Test seam. */
  livenessTimeoutMs?: number;
}

function pinnedAsset(pin: DpAssetPinTable, platform: string): DpAssetPin | undefined {
  if (!pin.version.trim()) return undefined;
  if (platform !== 'darwin' && platform !== 'linux' && platform !== 'win32') return undefined;
  const asset = pin.assets[platform];
  if (!asset || !asset.url || !asset.sha256 || asset.byteLength <= 0) return undefined;
  return asset;
}

/**
 * `resolveDpRuntime` throws exactly one error — `DpNotFound` — so a null here
 * means "no rung answers", which is the only condition under which rung 5 has
 * anything to do.
 */
function ladderAnswer(opts: ResolveDpRuntimeOptions): ReturnType<typeof resolveDpRuntime> | null {
  try {
    return resolveDpRuntime(opts);
  } catch {
    return null;
  }
}

async function isLive(dpPath: string, timeoutMs: number): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync(dpPath, ['--version'], {
      // No workdir: the flag form reads no state root, and Target scheme
      // clause 3 says we never hand dp an isolated one.
      env: dpExecEnv(),
      signal: AbortSignal.timeout(timeoutMs),
    });
    return DP_VERSION_OUTPUT.test(stdout);
  } catch {
    return false;
  }
}

let inflight: Promise<DpProvisionResult> | null = null;

/**
 * Provision `<CONFIG_DIR>/dp/bin/dp` from the pin, at most once at a time.
 *
 * SINGLE-FLIGHT for the reason nessy-cli's `ensureDpPresence` gives: parallel
 * entry points must not download over each other or replace the file under a
 * running child. Concurrent callers share the one promise; the temp path is
 * pid-suffixed on top of that, so two PROCESSES cannot collide either.
 */
export function ensureManagedDp(
  opts: EnsureManagedDpOptions = {},
): Promise<DpProvisionResult> {
  if (inflight) return inflight;
  inflight = provision(opts).finally(() => {
    inflight = null;
  });
  return inflight;
}

async function provision(opts: EnsureManagedDpOptions): Promise<DpProvisionResult> {
  const configDir = opts.configDir ?? CONFIG_DIR;
  const dpPath = managedDpBinaryPath(configDir);

  const asset = pinnedAsset(opts.pin ?? DP_ASSET_PIN, opts.platform ?? process.platform);
  if (!asset) return { outcome: 'inert', dpPath };

  // The negative cache comes FIRST so it holds even when the ladder throws:
  // it is the clause that says a dead download is not retried.
  if (dpBinaryDemotion(dpPath) === 'unrunnable') {
    return { outcome: 'cached-unrunnable', dpPath };
  }

  const already = ladderAnswer(opts);
  if (already) {
    return { outcome: 'not-needed', dpPath: already.dpPath, source: already.source };
  }

  let bytes: Uint8Array;
  try {
    const response = await fetch(asset.url, {
      signal: AbortSignal.timeout(opts.downloadTimeoutMs ?? DOWNLOAD_TIMEOUT_MS),
    });
    if (!response.ok) {
      log.info('dp asset download refused', { status: response.status });
      return { outcome: 'download-failed', dpPath };
    }
    bytes = new Uint8Array(await response.arrayBuffer());
  } catch {
    log.info('dp asset download failed');
    return { outcome: 'download-failed', dpPath };
  }

  if (bytes.byteLength !== asset.byteLength) {
    log.info('dp asset size does not match the pin');
    return { outcome: 'size-mismatch', dpPath };
  }
  if (createHash('sha256').update(bytes).digest('hex') !== asset.sha256) {
    log.info('dp asset digest does not match the pin');
    return { outcome: 'digest-mismatch', dpPath };
  }

  const tempPath = `${dpPath}.download-${process.pid}`;
  try {
    await mkdir(dirname(dpPath), { recursive: true, mode: BINARY_MODE });
    await writeFile(tempPath, bytes, { mode: BINARY_MODE });
    // Windows has no POSIX execute bit and `.exe` runs by extension, which is
    // the same exemption the reference makes.
    if (process.platform !== 'win32') await chmod(tempPath, BINARY_MODE);

    if (!(await isLive(tempPath, opts.livenessTimeoutMs ?? LIVENESS_TIMEOUT_MS))) {
      await rm(tempPath, { force: true }).catch(() => {});
      demoteDpBinary(dpPath, 'unrunnable');
      log.info('downloaded dp does not run; not installed', { dpPath });
      return { outcome: 'unrunnable', dpPath };
    }

    await rename(tempPath, dpPath);
    log.info('managed dp installed', { dpPath });
    return { outcome: 'provisioned', dpPath };
  } catch {
    await rm(tempPath, { force: true }).catch(() => {});
    log.info('managed dp install failed', { dpPath });
    return { outcome: 'install-failed', dpPath };
  }
}
