/**
 * pin-dp-asset — take the dp asset pin `dp-provision.ts` ships EMPTY.
 *
 * DA1.48. `packages/shared/src/auth/dp/dp-provision.ts` verifies a downloaded
 * dp against `{url, sha256, byteLength}` per platform, and those three values
 * cannot be read from anywhere: **nessy-cli publishes MD5 only** — their
 * `packages/core/src/dp/dpConfig.ts` symbol `DP_CONFIG`, field `md5Checksums`,
 * three digests at version `13.14.1` (read 2026-09-18 at their `9d94ec5d4`).
 * So the sha256 and the length have to be COMPUTED from the asset, which means
 * fetching it, which is a close-out act and not a lane's: the row assigns the
 * fetch and the values to the controller. This script is that step, and it is
 * the only thing that may produce them — a hand-typed digest is a digest
 * nobody computed.
 *
 * Usage:
 *   bun scripts/pin-dp-asset.ts <version> [platform ...]
 *
 * `<version>` is a dp version such as `13.14.1`; platforms default to all
 * three. STDOUT carries the JSON and NOTHING else, so the output can be piped;
 * every diagnostic goes to stderr. A non-zero exit means no pin was printed.
 *
 * ## The URL is nessy-cli's pattern, read from their source
 *
 * `dpConfig.ts` symbol `buildDpDownloadUrl` is
 * `${prefix}/${version}/${platformDir}/${basename}` with `platformDir` in
 * `windows | linux | darwin` and `basename` `dp.exe` on Windows and `dp`
 * otherwise, against `DP_CONFIG.downloadUrlPrefix`. Both halves are spelled
 * below with that citation rather than guessed, and the URL each row carries is
 * recorded VERBATIM in the pin — so the provisioner never rebuilds a URL at
 * runtime and there is only ever one spelling of the pattern in play.
 *
 * ## What this never does
 *
 * It writes no file, touches no credential and runs no dp. It fetches, hashes,
 * prints. The values go into `DP_ASSET_PIN` by hand, in the close-out commit
 * that names the version.
 */

import { createHash } from 'node:crypto'

/** nessy-cli `DP_CONFIG.downloadUrlPrefix`. */
const DEFAULT_PREFIX = 'https://code-completion-nestor.tcsbank.ru/api/v2/download/dp'

/**
 * TEST SEAM, and only that: the suite that drives this script points it at a
 * local fake asset server on loopback, because a test may never fetch the real
 * binary. An operator has no reason to set it.
 */
const PREFIX_ENV = 'NESSY_DP_ASSET_URL_PREFIX'

/** nessy-cli `DP_CONFIG.downloadTimeout` — 5 min for a ~23 MB asset. */
const FETCH_TIMEOUT_MS = 5 * 60_000

/** The pin table's keys, and their spelling in nessy-cli's download path. */
const PLATFORM_DIRS: Record<string, string> = {
  darwin: 'darwin',
  linux: 'linux',
  win32: 'windows',
}

interface PinnedAssetRecord {
  version: string
  platform: string
  url: string
  sha256: string
  byteLength: number
}

/** nessy-cli `dpBaseName()`. */
function baseName(platform: string): string {
  return platform === 'win32' ? 'dp.exe' : 'dp'
}

function buildUrl(prefix: string, version: string, platform: string): string {
  return `${prefix}/${version}/${PLATFORM_DIRS[platform]}/${baseName(platform)}`
}

async function pinOne(
  prefix: string,
  version: string,
  platform: string,
): Promise<PinnedAssetRecord> {
  const url = buildUrl(prefix, version, platform)
  process.stderr.write(`fetching ${platform}: ${url}\n`)
  const response = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
  if (!response.ok) {
    throw new Error(`${platform}: HTTP ${response.status} ${response.statusText} for ${url}`)
  }
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (bytes.byteLength === 0) throw new Error(`${platform}: empty asset at ${url}`)
  return {
    version,
    platform,
    url,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    byteLength: bytes.byteLength,
  }
}

async function main(): Promise<number> {
  const [version, ...platformArgs] = process.argv.slice(2)
  if (!version) {
    process.stderr.write('usage: bun scripts/pin-dp-asset.ts <version> [platform ...]\n')
    return 2
  }
  const platforms = platformArgs.length > 0 ? platformArgs : Object.keys(PLATFORM_DIRS)
  const unknown = platforms.filter((p) => !(p in PLATFORM_DIRS))
  if (unknown.length > 0) {
    process.stderr.write(
      `unknown platform(s): ${unknown.join(', ')} — expected ${Object.keys(PLATFORM_DIRS).join(', ')}\n`,
    )
    return 2
  }

  const prefix = (process.env[PREFIX_ENV] ?? DEFAULT_PREFIX).replace(/\/+$/, '')
  const records: PinnedAssetRecord[] = []
  for (const platform of platforms) {
    // Sequential on purpose: three 23 MB fetches at once tell a reader nothing
    // useful and one failure should stop before the next starts.
    records.push(await pinOne(prefix, version, platform))
  }

  process.stdout.write(`${JSON.stringify(records, null, 2)}\n`)
  return 0
}

main()
  .then((code) => {
    process.exitCode = code
  })
  .catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
