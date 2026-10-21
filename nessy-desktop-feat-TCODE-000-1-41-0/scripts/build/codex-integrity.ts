/**
 * The packaging-time half of the codex runtime's integrity pin.
 *
 * `packages/codex-agent-server/src/manifest-verifier.ts` refuses to spawn a
 * `codex-app-server` whose sha256 differs from the pin in
 * `packages/codex-protocol/manifest.json`. That pin is the hash of the binary
 * `scripts/fetch-codex.mjs` downloaded from the upstream release — and until
 * this module existed, nothing checked it against the binary that actually
 * SHIPS.
 *
 * That gap shipped a sev-1 in signed 1.25.0: the release build re-signed the
 * nested binary with our Developer ID, code signing rewrites the Mach-O, and
 * every session died with
 *   `codex-app-server SHA mismatch for darwin-arm64: on-disk 52f6105d… ≠ manifest ac4fc97a…`
 * The defect was invisible to every prior gate because an UNSIGNED local build
 * is byte-identical to upstream, so the pin passed everywhere except in the
 * artifact users install.
 *
 * There is no post-sign repair available inside the bundle, which is why this
 * is an assertion rather than a fixup:
 *   - the app never reads `manifest.json` at runtime. `manifest-verifier.ts`
 *     imports it as JSON and esbuild INLINES the pin into `dist/main.cjs`, so
 *     "rewrite the manifest in the app bundle" has no file to rewrite.
 *   - electron-builder's `afterSign` hook runs after `signApp`, and `signApp`
 *     notarizes (`macPackager.js` `sign()` → `helper.notarizeIfProvided`), so
 *     any post-sign write invalidates the signature and the stapled ticket.
 *   - `afterPack` runs BEFORE signing, so it cannot know the post-sign hash.
 * The fix is therefore to stop the rewrite (`mac.signIgnore` keeps the upstream
 * Developer ID signature, which already carries hardened runtime and a secure
 * timestamp) and to assert the outcome here, on the final artifact.
 *
 * This gate asks two questions of every packaged binary, not one:
 *   1. do the bytes still match the pin? (byte identity with the upstream release)
 *   2. does the REAL `verifyCodexBinary` accept the file? (will the app spawn it)
 * The second is run through the actual runtime function rather than a
 * reimplementation, because a gate that reimplements the check it is gating drifts
 * from it — and an invisible drift between the pin the app inlines and the pin the
 * gate reads is precisely what made this defect survive every prior check.
 *
 * CLI:
 *   bun scripts/build/codex-integrity.ts <root>... [--require=<platform-dir>]... [--forbid-app-server]
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The runtime binary itself, per platform. The rest of the dir: the code-mode host (below), sandbox helpers. */
export const APP_SERVER_BASENAMES = ['codex-app-server', 'codex-app-server.exe'] as const;

/**
 * F1.1216 — codex's own code-mode host, from the same release archive. It ships
 * WITH the app-server (codex finds it beside its own executable; every
 * `code_mode_only` model has no tools without it), so it is required and
 * forbidden exactly where the app-server is, and pinned beside it as
 * `binaries[<dir>].codeModeHostSha256`.
 */
export const CODE_MODE_HOST_BASENAMES = ['codex-code-mode-host', 'codex-code-mode-host.exe'] as const;

/**
 * The slice of `packages/codex-protocol/manifest.json` this gate reads. Same
 * file the runtime verifier imports, so the two cannot drift.
 */
export interface CodexIntegrityManifest {
  upstream?: { tag?: string };
  binaries?: Record<string, { binarySha256?: string; codeModeHostSha256?: string } | undefined>;
  windowsSandbox?: Record<
    string,
    { files?: Record<string, { binarySha256?: string } | undefined> } | undefined
  >;
}

export interface BundledCodexBinary {
  /** Absolute path of the file inside the packaged output. */
  path: string;
  /** `darwin-arm64`, `win32-x64`, … — the directory name under `bin/codex/`. */
  platformDir: string;
  basename: string;
}

export type CodexIntegrityFailureKind =
  | 'sha-mismatch'
  | 'unpinned'
  | 'missing-required'
  | 'unexpected-platform'
  | 'forbidden-app-server'
  | 'no-packaged-output'
  | 'runtime-refused';

export interface CodexIntegrityFailure {
  kind: CodexIntegrityFailureKind;
  message: string;
  path?: string;
  platformDir?: string;
}

export interface CodexIntegrityOptions {
  /** Packaged output roots to scan. Non-existent roots are skipped. */
  roots: string[];
  manifest: CodexIntegrityManifest;
  /** Platform dirs whose `codex-app-server` MUST ship and verify. */
  requirePlatformDirs?: string[];
  /** Assert this build ships no `codex-app-server` anywhere (runtime flag off / Linux). */
  forbidAppServer?: boolean;
  /**
   * The REAL runtime gate — `verifyCodexBinary` from `@nessy-agent/codex-agent-server`,
   * injected rather than imported so this module stays pure and cycle-free (the
   * package's own test imports it back for the anti-drift check). The CLI always
   * passes the real one.
   *
   * It is not a second opinion on the hash; it is the answer to a different
   * question — "will the app this build produces actually spawn this file?" — asked
   * of the same code path the app runs, so the gate cannot drift from the runtime
   * by reimplementing it. Called for `codex-app-server`; the real gate also checks the
   * `codex-code-mode-host` beside it (F1.1216). Only the Windows sandbox helpers go
   * unchecked at spawn — they are pinned under `windowsSandbox`, verified here only.
   */
  runtimeVerify?: (binaryPath: string, platformDir: string) => void;
}

export interface CodexIntegrityResult {
  /** Binaries whose bytes matched their manifest pin. A mismatch lands in `failures` instead. */
  verified: Array<BundledCodexBinary & { sha256: string }>;
  failures: CodexIntegrityFailure[];
}

function isAppServer(name: string): boolean {
  return (APP_SERVER_BASENAMES as readonly string[]).includes(name);
}

function isCodeModeHost(name: string): boolean {
  return (CODE_MODE_HOST_BASENAMES as readonly string[]).includes(name);
}

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex').toLowerCase();
}

/**
 * Every file that sits at `…/bin/codex/<platform-dir>/<name>` under any root.
 *
 * The shape is the contract `resolveCodexBinaryPath`
 * (`packages/shared/src/agent/backend/internal/runtime-resolver.ts`) probes at
 * runtime, and it is deliberately location-agnostic: the packaged app can serve
 * the binary from `Contents/Resources/app/resources/…`, from `…/dist/resources/…`
 * or from `Contents/Resources/bin/codex/…`, and a binary in ANY of them is one
 * the app might spawn.
 */
export function findBundledCodexBinaries(roots: string[]): BundledCodexBinary[] {
  const found: BundledCodexBinary[] = [];
  const seen = new Set<string>();

  const walk = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // unreadable directory — nothing to assert about it
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isSymbolicLink()) continue; // never follow: loops, and the target is walked on its own
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        const platformDir = basename(dir);
        const codexDir = dirname(dir);
        if (basename(codexDir) !== 'codex' || basename(dirname(codexDir)) !== 'bin') continue;
        if (seen.has(full)) continue;
        seen.add(full);
        found.push({ path: full, platformDir, basename: entry.name });
      }
    }
  };

  for (const root of roots) {
    if (!existsSync(root)) continue;
    try {
      if (!statSync(root).isDirectory()) continue;
    } catch {
      continue;
    }
    walk(root);
  }

  return found.sort((a, b) => a.path.localeCompare(b.path));
}

function pinFor(manifest: CodexIntegrityManifest, entry: BundledCodexBinary): string | undefined {
  const pin = isAppServer(entry.basename)
    ? manifest.binaries?.[entry.platformDir]?.binarySha256
    : isCodeModeHost(entry.basename)
      ? manifest.binaries?.[entry.platformDir]?.codeModeHostSha256
      : manifest.windowsSandbox?.[entry.platformDir]?.files?.[entry.basename]?.binarySha256;
  return pin?.toLowerCase();
}

/**
 * A mismatched binary has two very different futures, and the difference decides
 * how urgent the failure is — so the gate says which one it is instead of leaving
 * the next reader to find out from a user. Either way the build fails: byte
 * identity with the pinned upstream release is the property `signIgnore` exists to
 * hold, and losing it silently is how this defect shipped the first time.
 */
function describeRuntimeFallback(
  entry: BundledCodexBinary,
  runtimeVerify: (binaryPath: string, platformDir: string) => void,
): string {
  try {
    runtimeVerify(entry.path, entry.platformDir);
    return 'The app WOULD still spawn it, via the runtime\'s Developer ID fallback arm — so this is not a '
      + 'dead runtime, but the shipped bytes are no longer the upstream release we pinned. Do not ship it: '
      + 'restore signIgnore rather than lean on the fallback.';
  } catch {
    return 'The app will REFUSE to spawn it (manifest-verifier.ts: neither the pin nor the Developer ID '
      + 'fallback accepts these bytes). This is the exact sev-1 signed 1.25.0 shipped.';
  }
}

/**
 * Assert that every codex binary in the packaged output would satisfy the
 * runtime pin. Pure over the filesystem + an injected manifest so the CLI and
 * the tests exercise identical logic.
 */
export function verifyBundledCodexIntegrity(options: CodexIntegrityOptions): CodexIntegrityResult {
  const { roots, manifest, requirePlatformDirs = [], forbidAppServer = false, runtimeVerify } = options;
  const failures: CodexIntegrityFailure[] = [];
  const verified: CodexIntegrityResult['verified'] = [];

  const existingRoots = roots.filter(root => existsSync(root));
  if (existingRoots.length === 0 && requirePlatformDirs.length > 0) {
    return {
      verified,
      failures: [{
        kind: 'no-packaged-output',
        message:
          `no packaged output found to verify (looked in: ${roots.join(', ')}), `
          + `but ${requirePlatformDirs.join(', ')} was required to ship a codex-app-server`,
      }],
    };
  }

  const found = findBundledCodexBinaries(existingRoots);

  for (const entry of found) {
    const expected = pinFor(manifest, entry);
    if (!expected) {
      failures.push({
        kind: 'unpinned',
        path: entry.path,
        platformDir: entry.platformDir,
        message:
          `${entry.basename} shipped under bin/codex/${entry.platformDir}/ but no manifest entry pins it — `
          + 'every executable in that directory must come from scripts/fetch-codex.mjs',
      });
      continue;
    }

    const actual = sha256File(entry.path);
    if (actual === expected) {
      verified.push({ ...entry, sha256: actual });
    } else {
      failures.push({
        kind: 'sha-mismatch',
        path: entry.path,
        platformDir: entry.platformDir,
        message:
          `SHA mismatch for ${entry.platformDir}/${entry.basename}: packaged ${actual} ≠ manifest ${expected}. `
          + 'This is what a code-signing step that re-signs the bundled binary looks like — signing rewrites '
          + 'the Mach-O/PE, and the pin records the unsigned upstream hash. Keep the upstream signature '
          + '(electron-builder mac.signIgnore) instead of re-signing it.'
          + (isAppServer(entry.basename) && runtimeVerify
            ? ' ' + describeRuntimeFallback(entry, runtimeVerify)
            : ''),
      });
    }

    // Same file, different question: would the app SPAWN it? Asked of the real
    // runtime gate, so a gate that passes can never mean a runtime that refuses.
    if (isAppServer(entry.basename) && runtimeVerify) {
      try {
        runtimeVerify(entry.path, entry.platformDir);
      } catch (error) {
        if (actual !== expected) continue; // already reported as sha-mismatch, annotated above
        failures.push({
          kind: 'runtime-refused',
          path: entry.path,
          platformDir: entry.platformDir,
          message:
            `the packaged ${entry.platformDir}/${entry.basename} matches this gate's manifest but the REAL `
            + 'runtime gate still refuses to spawn it — the pin the app inlined at build time and the pin '
            + `this gate read from packages/codex-protocol/manifest.json have drifted apart: ${String(
              error instanceof Error ? error.message : error,
            )}`,
        });
      }
    }
  }

  const appServers = found.filter(entry => isAppServer(entry.basename));
  const codeModeHosts = found.filter(entry => isCodeModeHost(entry.basename));

  if (forbidAppServer) {
    for (const entry of [...appServers, ...codeModeHosts]) {
      failures.push({
        kind: 'forbidden-app-server',
        path: entry.path,
        platformDir: entry.platformDir,
        message:
          `${entry.basename} shipped at ${entry.path} but this build disabled the codex runtime — `
          + 'the runtime\'s binaries must not ride along',
      });
    }
  }

  for (const platformDir of requirePlatformDirs) {
    if (!appServers.some(entry => entry.platformDir === platformDir)) {
      failures.push({
        kind: 'missing-required',
        platformDir,
        message:
          `no codex-app-server shipped under bin/codex/${platformDir}/ — `
          + 'this build enabled the codex runtime, so the binary has to be in the package',
      });
    }
    // F1.1216 — the host travels with the app-server: without it every
    // code_mode_only model (gpt-5.6, gpt-6, gpt-6.1, codex-auto-review) runs with
    // no tools ("Code mode will fail closed").
    if (!codeModeHosts.some(entry => entry.platformDir === platformDir)) {
      failures.push({
        kind: 'missing-required',
        platformDir,
        message:
          `no codex-code-mode-host shipped beside codex-app-server under bin/codex/${platformDir}/ — `
          + 'without it codex fails closed on every code_mode_only model (no tools)',
      });
    }
  }

  if (requirePlatformDirs.length > 0) {
    for (const entry of [...appServers, ...codeModeHosts]) {
      if (requirePlatformDirs.includes(entry.platformDir)) continue;
      failures.push({
        kind: 'unexpected-platform',
        path: entry.path,
        platformDir: entry.platformDir,
        message:
          `a ${entry.platformDir} ${entry.basename} rode along in a ${requirePlatformDirs.join('/')} package `
          + `(${entry.path}) — electron-builder's per-platform include leaked`,
      });
    }
  }

  return { verified, failures };
}

export function formatCodexIntegrityReport(result: CodexIntegrityResult): string {
  const lines = result.verified.map(
    entry => `  ok  ${entry.platformDir}/${entry.basename}  ${entry.sha256}`,
  );
  for (const failure of result.failures) {
    lines.push(`  FAIL [${failure.kind}] ${failure.message}`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export function repoRootManifestPath(): string {
  const here = dirname(fileURLToPath(import.meta.url)); // scripts/build
  return join(here, '..', '..', 'packages', 'codex-protocol', 'manifest.json');
}

async function main(argv: string[]): Promise<number> {
  const roots: string[] = [];
  const requirePlatformDirs: string[] = [];
  let forbidAppServer = false;

  for (const arg of argv) {
    if (arg.startsWith('--require=')) requirePlatformDirs.push(arg.slice('--require='.length));
    else if (arg === '--forbid-app-server') forbidAppServer = true;
    else if (arg.startsWith('--')) {
      console.error(`Unknown option: ${arg}`);
      return 2;
    } else roots.push(arg);
  }

  if (roots.length === 0) {
    console.error(
      'Usage: bun scripts/build/codex-integrity.ts <packaged-output-root>... [--require=<platform-dir>]... [--forbid-app-server]',
    );
    return 2;
  }

  const manifestPath = repoRootManifestPath();
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as CodexIntegrityManifest;

  // The real spawn-time gate, imported lazily so the pure half above stays free of
  // a runtime-package dependency (and of the import cycle its own test would make).
  const { verifyCodexBinary } = await import('@nessy-agent/codex-agent-server');

  const result = verifyBundledCodexIntegrity({
    roots,
    manifest,
    requirePlatformDirs,
    forbidAppServer,
    runtimeVerify: (binaryPath, platformDir) => verifyCodexBinary(binaryPath, platformDir),
  });
  const report = formatCodexIntegrityReport(result);

  if (result.failures.length > 0) {
    console.error(`codex integrity gate FAILED (upstream ${manifest.upstream?.tag ?? 'unknown'}):`);
    if (report) console.error(report);
    return 1;
  }

  console.log(
    `codex integrity verified (upstream ${manifest.upstream?.tag ?? 'unknown'}): `
    + `${result.verified.length} bundled binar${result.verified.length === 1 ? 'y' : 'ies'} match the pin`
    + ' and the real runtime gate accepts every packaged codex-app-server',
  );
  if (report) console.log(report);
  return 0;
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}
