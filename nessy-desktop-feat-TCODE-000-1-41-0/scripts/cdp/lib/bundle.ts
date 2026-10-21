/**
 * WHICH BUILD is answering this run, and does it carry the code under test.
 *
 * `scripts/cdp/README.md` states the rule that makes this module necessary:
 * *a source change is invisible to a CDP run until the bundles are rebuilt and
 * the app is relaunched*, and it cost a real measurement once — the first AGT-1
 * run measured a Pi subprocess built before the fix it was testing and reported
 * the result as today's. Every case whose claim depends on new code asserts the
 * shipped bundle carries it BEFORE it measures anything.
 *
 * Three things live here because three cases need them and a copy in each would
 * drift:
 *
 *   1. **Which artifact is on the other end of the CDP socket.** Read from the
 *      page target's own URL rather than assumed: a packaged app loads
 *      `file://…/Contents/Resources/app/dist/renderer/index.html`
 *      (`window-manager.ts` `loadFile`, and `asar: false` in
 *      `electron-builder.yml`, so the paths are real directories), while
 *      `electron:dev` loads `http://localhost:<vite>`. The difference is not
 *      cosmetic — the checklist's 2026-08-12 run records that a dev build is not
 *      the shipped artifact and that live evidence has to come from a packaged
 *      one.
 *   2. **Symbol counts in the shipped bundles**, the README's own freshness
 *      technique (`grep -c <symbol> apps/electron/dist/main.cjs`), done over
 *      BYTES. AGENTS.md: several files in this repo carry a NUL byte and plain
 *      `grep`/`rg` skips such a file SILENTLY — four "this identifier does not
 *      exist" findings were that. A byte scan cannot be fooled that way, and a
 *      42 MB esbuild bundle is exactly the kind of file that trips it.
 *   3. **The bundled `codex-app-server`**, found the same way the build gate
 *      finds it (`scripts/build/codex-integrity.ts` `findBundledCodexBinaries`,
 *      whose `bin/codex/<platform-dir>/` shape mirrors the runtime's own
 *      `resolveCodexBinaryPath`). Reusing that function rather than
 *      reimplementing the walk is deliberate: a gate that reimplements the check
 *      it is gating drifts from it.
 */

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { CdpSession } from './connect.ts'
import { findBundledCodexBinaries, type BundledCodexBinary } from '../../build/codex-integrity.ts'

/** Repo root, derived from this file (`scripts/cdp/lib/bundle.ts`). */
export function repoRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
}

export interface AppUnderTest {
  /**
   * `packaged` — the CDP target is a `file://` renderer inside an `.app`/`dist`
   * tree, i.e. the artifact a user installs.
   * `dev` — `electron:dev`; the bundles are the repo's own `dist/` directories.
   * `unknown` — the URL matched neither and no override was given.
   */
  kind: 'packaged' | 'dev' | 'unknown'
  /** The app root: the directory holding `dist/` and `resources/`. */
  appRoot?: string
  /** Roots to scan for bundled binaries (packaged: the whole `Resources` dir). */
  scanRoots: string[]
  /** How the answer was reached, so a report can say what it measured. */
  via: string
  /** The page URL the answer came from. */
  targetUrl: string
}

/**
 * `NESSY_CDP_APP_ROOT` overrides the derivation.
 *
 * For the case where the operator drives a packaged app whose renderer URL this
 * module cannot parse — a future packaging change, a remote target — rather
 * than have a case guess. It names the directory that holds `dist/main.cjs`.
 */
const APP_ROOT_ENV = 'NESSY_CDP_APP_ROOT'

export function resolveAppUnderTest(session: CdpSession): AppUnderTest {
  const targetUrl = session.target.url
  const override = process.env[APP_ROOT_ENV]
  if (override) {
    return {
      kind: 'packaged',
      appRoot: override,
      scanRoots: [override, dirname(override)],
      via: `${APP_ROOT_ENV}=${override}`,
      targetUrl,
    }
  }

  if (targetUrl.startsWith('file://')) {
    // `window.loadFile(join(__dirname, 'renderer/index.html'))` — `__dirname` is
    // the directory `main.cjs` sits in, so the app root is two levels up from
    // the html file. Query strings are present (`?workspaceId=…`).
    const filePath = decodeURIComponent(new URL(targetUrl).pathname)
    const marker = '/dist/renderer/'
    const index = filePath.indexOf(marker)
    if (index > 0) {
      const appRoot = filePath.slice(0, index)
      // A packaged mac app puts everything the runtime resolver probes under
      // `Contents/Resources`: `app/resources/bin/codex/…` (files) and
      // `bin/codex/…` (extraResources). Scanning the PARENT covers both without
      // encoding either layout here.
      return {
        kind: 'packaged',
        appRoot,
        scanRoots: [dirname(appRoot), appRoot],
        via: 'derived from the CDP page target url',
        targetUrl,
      }
    }
  }

  if (/^https?:\/\/(localhost|127\.0\.0\.1)/.test(targetUrl)) {
    const root = join(repoRoot(), 'apps', 'electron')
    return {
      kind: 'dev',
      appRoot: root,
      scanRoots: [root],
      via: 'localhost renderer — this is electron:dev, not the shipped artifact',
      targetUrl,
    }
  }

  return { kind: 'unknown', scanRoots: [], via: 'the page target url matched no known layout', targetUrl }
}

export interface BundleFile {
  label: string
  path: string
  exists: boolean
  /** Size in bytes, for a report that has to say WHICH bundle it read. */
  bytes?: number
  /** Last write time — the cheapest way to spot "this predates the fix". */
  modifiedMs?: number
}

/**
 * The two bundles a `packages/shared` change can land in.
 *
 * `main` is the Electron host: every backend (`pi-agent.ts`, `claude-agent.ts`,
 * `codex-agent.ts`), the MCP pool and the session manager. `pi` is the Pi
 * subprocess, which is a SEPARATE build of an overlapping source tree — the
 * README's rule exists because `electron:dev` runs both from built bundles and a
 * change to one is not a change to the other.
 */
export function bundleFiles(app: AppUnderTest): { main: BundleFile; pi: BundleFile } {
  const describe = (label: string, candidates: string[]): BundleFile => {
    const path = candidates.find(candidate => existsSync(candidate)) ?? candidates[0] ?? ''
    if (!path || !existsSync(path)) return { label, path, exists: false }
    const stat = statSync(path)
    return { label, path, exists: true, bytes: stat.size, modifiedMs: stat.mtimeMs }
  }
  const root = app.appRoot
  return {
    main: describe('host bundle (main.cjs)', [
      ...(root ? [join(root, 'dist', 'main.cjs')] : []),
      join(repoRoot(), 'apps', 'electron', 'dist', 'main.cjs'),
    ]),
    pi: describe('Pi subprocess bundle (pi-agent-server/index.js)', [
      // Packaged: staged into the app's `resources/`. Dev: the package's own dist.
      ...(root ? [join(root, 'resources', 'pi-agent-server', 'index.js')] : []),
      join(repoRoot(), 'packages', 'pi-agent-server', 'dist', 'index.js'),
    ]),
  }
}

/**
 * Occurrences of an ASCII `needle` in a file, counted over BYTES.
 *
 * A byte scan rather than `grep -c`, for two reasons that both bite on a 42 MB
 * esbuild bundle. `grep -c` counts LINES, so two hits sharing one line of a
 * bundle read as one — a count that is off by an unknown factor is not evidence.
 * And AGENTS.md records that a NUL byte anywhere in a file makes plain
 * `grep`/`rg` skip it SILENTLY (four "this identifier does not exist" findings
 * in this repo's history were that); `apps/electron/dist/main.cjs` does carry
 * one, ~16 MB in, so the `-a` that check depends on is a flag someone has to
 * remember. Counting bytes cannot be fooled either way.
 *
 * Returns `-1` when the file is absent, so a caller can tell "not built" from
 * "built without the symbol". Those are different failures with different fixes.
 *
 * **The read belongs inside the case, not in an operator pre-flight.** Measured
 * while this module was being written: the host bundle was rebuilt four minutes
 * into the session, and the same symbol answered 0 before and 4 after. A
 * freshness check performed by hand before a run is a check of a file that may
 * no longer be the one the app loaded.
 */
export function countInFile(path: string, needle: string): number {
  if (!existsSync(path)) return -1
  const haystack = readFileSync(path)
  const pattern = Buffer.from(needle, 'utf8')
  let count = 0
  let from = 0
  for (;;) {
    const at = haystack.indexOf(pattern, from)
    if (at < 0) return count
    count += 1
    from = at + pattern.length
  }
}

export interface SymbolReport {
  bundle: string
  path: string
  counts: Record<string, number>
  /** Symbols the bundle does not carry (count 0), or `file-missing`. */
  missing: string[]
}

/** Count several symbols in one bundle and name the ones that are absent. */
export function symbolsIn(bundle: BundleFile, symbols: string[]): SymbolReport {
  const counts: Record<string, number> = {}
  const missing: string[] = []
  for (const symbol of symbols) {
    const count = countInFile(bundle.path, symbol)
    counts[symbol] = count
    if (count <= 0) missing.push(count < 0 ? `${symbol} (file-missing)` : symbol)
  }
  return { bundle: bundle.label, path: bundle.path, counts, missing }
}

// ---------------------------------------------------------------------------
// The bundled codex-app-server
// ---------------------------------------------------------------------------

export interface CodexManifest {
  upstream?: { tag?: string }
  binaries?: Record<string, { binarySha256?: string } | undefined>
}

export function readCodexManifest(): { path: string; manifest: CodexManifest } {
  const path = join(repoRoot(), 'packages', 'codex-protocol', 'manifest.json')
  return { path, manifest: JSON.parse(readFileSync(path, 'utf8')) as CodexManifest }
}

export interface CodexBinaryReading extends BundledCodexBinary {
  sha256: string
  /** The manifest pin for this platform dir, lowercased. */
  pinned?: string
  matchesPin: boolean
}

/**
 * Every `codex-app-server` the app under test could spawn, hashed.
 *
 * Only `codex-app-server`: the spawn gate also refuses a mismatched `codex-code-mode-host`
 * beside it (F1.1216), which this reading does NOT hash — a swapped host surfaces only as that refusal.
 */
export function codexBinaries(app: AppUnderTest, manifest: CodexManifest): CodexBinaryReading[] {
  return findBundledCodexBinaries(app.scanRoots)
    .filter(entry => entry.basename === 'codex-app-server' || entry.basename === 'codex-app-server.exe')
    .map(entry => {
      const sha256 = createHash('sha256').update(readFileSync(entry.path)).digest('hex').toLowerCase()
      const pinned = manifest.binaries?.[entry.platformDir]?.binarySha256?.toLowerCase()
      return { ...entry, sha256, pinned, matchesPin: Boolean(pinned) && sha256 === pinned }
    })
}

/** `darwin-arm64`, `win32-x64`, … — the platform dir this host would spawn. */
export function hostPlatformDir(): string {
  const arch = process.arch === 'arm64' ? 'arm64' : process.arch === 'x64' ? 'x64' : process.arch
  return `${process.platform}-${arch}`
}
