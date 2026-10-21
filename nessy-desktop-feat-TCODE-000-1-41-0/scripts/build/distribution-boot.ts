/**
 * The property the packaged headless server never asserted: that the assembled
 * distribution can resolve its own imports and start.
 *
 * `nessy-server` could not boot for four releases. `factory.ts` imports
 * `CodexAgent` statically, `copyWorkspacePackages` did not ship the two Codex
 * packages, and every relocated distribution died with
 * `Cannot find module '@nessy-agent/codex-agent-server'` before a single line of
 * server code ran. Nothing noticed, because the build writes to
 * `<repo>/dist/server` and Node/Bun resolution walks *upward*: from inside the
 * repository the missing packages are found in the repository's own
 * `node_modules`. The bug was only ever observable one directory outside the
 * repo — which is the only place the artifact is ever actually used.
 *
 * So this module does not check the build inputs. It checks the build *output*,
 * in the position a customer runs it from.
 *
 * ## Two layers
 *
 * `verifyWorkspaceLinkage` — static, cheap, runs on every build including
 * cross-platform ones. Every `@nessy-agent/*` specifier the shipped source
 * mentions must have a corresponding package in the assembled tree. This is the
 * layer that catches the exact defect above, and any future drift between
 * `copyWorkspacePackages`'s list and the real import graph.
 *
 * `verifyDistributionBoots` — dynamic and much stronger, but only possible when
 * the target platform/arch matches the build host. It **relocates** the
 * assembled tree to a neutral temporary directory (asserting no `node_modules`
 * or `bunfig.toml` sits above it), runs `bin/nessy-server --generate-token` from
 * a cwd inside that directory, requires exit 0 and a real token on stdout, then
 * moves the tree back. `--generate-token` is the probe because ESM hoists
 * imports: reaching it proves the *entire* static import graph of
 * `packages/server/src/index.ts` evaluated, while exiting deterministically
 * without binding a port or needing a token.
 *
 * ## What this catches
 *
 * - a workspace package on the import graph that the build forgets to ship
 *   (the defect above), on every build;
 * - a missing/renamed npm dependency, a broken `bin/nessy-server`, a wrong Bun
 *   runtime, an entry module that throws at import time, and anything else that
 *   stops the artifact starting — on same-platform builds.
 *
 * ## What this does NOT catch
 *
 * - **cross-platform builds.** `bun run server:build:linux-x64` on a Mac ships a
 *   Linux Bun binary that cannot be executed here, so the boot layer is skipped
 *   with a loud warning and only the static layer runs. Build the artifact on
 *   (or in a container for) its target platform to get the strong check.
 * - **anything after startup.** The probe exits at `--generate-token`; RPC,
 *   sessions, agent turns and the whole runtime past bootstrap are untested.
 * - **dynamically imported modules.** `await import()` reached only on a later
 *   code path is not on the hoisted graph, and a specifier built at runtime is
 *   invisible to the static layer's literal scan.
 * - **resources, not code.** A missing binary under `resources/` (the Codex
 *   `codex-app-server` directory is one today) fails at spawn time, not here.
 * - **platform-native npm packages.** The boot layer only ever exercises the
 *   host's own arch, so a wrong-arch `@img/sharp-*` in a cross-built tree is
 *   invisible.
 */

import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';

/** Entry script the distribution exposes; the same one the Dockerfile ENTRYPOINTs. */
export const DIST_ENTRY_RELATIVE = 'bin/nessy-server';

/**
 * Argument that exits *after* the entry module's imports have been evaluated.
 *
 * ESM hoists every `import` declaration above the module body, so the
 * `--generate-token` branch at the top of `packages/server/src/index.ts` is only
 * reached once the full static import graph — including
 * `@nessy-agent/shared/agent/backend` → `factory.ts` → `CodexAgent` → both Codex
 * packages — has resolved and evaluated.
 */
export const BOOT_PROBE_ARG = '--generate-token';

/** `generateServerToken()` prints 24 random bytes as lowercase hex. */
export const BOOT_PROBE_SIGNAL = /^[0-9a-f]{48}$/m;

/** Directories whose contents are not part of the shipped runtime import graph. */
const NON_RUNTIME_DIRS = new Set(['node_modules', 'dist', '__tests__', 'tests', 'evals']);

/** `'@nessy-agent/foo'` or `'@nessy-agent/foo/bar'`, in an import/require position. */
const WORKSPACE_SPECIFIER = /['"]@nessy-agent\/([a-z0-9][a-z0-9.-]*)(?:\/[^'"]*)?['"]/g;

export interface WorkspaceLinkageGap {
  /** The unresolvable package, e.g. `@nessy-agent/codex-agent-server`. */
  specifier: string;
  /** First shipped file that references it, relative to the distribution root. */
  referencedBy: string;
}

function collectSourceFiles(dir: string, into: string[]): void {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (NON_RUNTIME_DIRS.has(entry.name)) continue;
      collectSourceFiles(join(dir, entry.name), into);
    } else if (entry.isFile() && (entry.name.endsWith('.ts') || entry.name.endsWith('.js'))) {
      into.push(join(dir, entry.name));
    }
  }
}

/**
 * Every `@nessy-agent/*` package the shipped source imports but the assembled
 * tree cannot resolve.
 *
 * Deliberately literal: it reads quoted specifiers, so prose mentioning a
 * package name in a comment does not register, and a specifier assembled at
 * runtime does not either (see "What this does NOT catch").
 */
export function collectWorkspaceLinkageGaps(outputDir: string): WorkspaceLinkageGap[] {
  const packagesDir = join(outputDir, 'packages');
  const scopeDir = join(outputDir, 'node_modules', '@nessy-agent');
  const gaps = new Map<string, string>();

  if (!existsSync(packagesDir)) return [];

  const files: string[] = [];
  for (const pkg of readdirSync(packagesDir)) {
    collectSourceFiles(join(packagesDir, pkg), files);
  }

  for (const file of files) {
    const content = readFileSync(file, 'utf-8');
    for (const match of content.matchAll(WORKSPACE_SPECIFIER)) {
      const name = match[1]!;
      const specifier = `@nessy-agent/${name}`;
      if (gaps.has(specifier)) continue;
      // existsSync follows symlinks, so a dangling workspace link counts as a gap.
      if (existsSync(join(scopeDir, name))) continue;
      gaps.set(specifier, relative(outputDir, file));
    }
  }

  return [...gaps].map(([specifier, referencedBy]) => ({ specifier, referencedBy }));
}

/**
 * Fail the build when the assembled tree references a workspace package it does
 * not ship.
 *
 * @throws listing every gap, not just the first — a drifted package list is
 *   usually wrong by more than one entry.
 */
export function verifyWorkspaceLinkage(outputDir: string): void {
  const gaps = collectWorkspaceLinkageGaps(outputDir);
  if (gaps.length === 0) return;

  const detail = gaps
    .map(gap => `  ${gap.specifier}  (referenced by ${gap.referencedBy})`)
    .join('\n');
  throw new Error(
    `The assembled distribution at ${outputDir} imports workspace packages it does not ship:\n`
    + `${detail}\n`
    + 'It would resolve them only while it sits inside the repository. Relocated — '
    + 'which is the only way it is ever used — it dies at module load. Add the '
    + "package(s) to copyWorkspacePackages' list in scripts/build-server.ts.",
  );
}

export type DistributionBootOutcome = 'booted' | 'skipped';

export interface BootProbeResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

export interface DistributionBootOptions {
  /** Target platform of the assembled distribution. */
  platform: string;
  /** Target arch of the assembled distribution. */
  arch: string;
  /** Host platform; defaults to the current process. */
  hostPlatform?: string;
  /** Host arch; defaults to the current process. */
  hostArch?: string;
  /** Seam for tests; defaults to spawning the real entry script. */
  run?: (args: { entry: string; cwd: string; configDir: string }) => BootProbeResult;
  /** Called instead of booting when the target cannot run on this host. */
  onSkip?: (reason: string) => void;
}

function hostArchOf(arch: string): string {
  return arch === 'arm64' ? 'arm64' : 'x64';
}

/**
 * Refuse to run the probe anywhere an ancestor directory could rescue module
 * resolution — that is exactly the illusion this guard exists to destroy.
 */
function assertNeutralLocation(dir: string): void {
  let current = resolve(dir);
  for (;;) {
    for (const rescuer of ['node_modules', 'bunfig.toml']) {
      if (existsSync(join(current, rescuer))) {
        throw new Error(
          `Boot probe location ${dir} is not neutral: ${join(current, rescuer)} sits above it `
          + 'and would rescue module resolution, making the probe pass on a distribution '
          + 'that cannot start anywhere else.',
        );
      }
    }
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

function spawnBootProbe(args: { entry: string; cwd: string; configDir: string }): BootProbeResult {
  const env: NodeJS.ProcessEnv = { ...process.env, NESSY_CONFIG_DIR: args.configDir };
  // NODE_PATH is another way an ancestor install could rescue resolution.
  delete env.NODE_PATH;

  const result = spawnSync(args.entry, [BOOT_PROBE_ARG], {
    cwd: args.cwd,
    env,
    encoding: 'utf-8',
    timeout: 180_000,
  });

  return {
    status: result.error ? null : result.status,
    stdout: result.stdout ?? '',
    stderr: result.error ? `${result.error.message}\n${result.stderr ?? ''}` : (result.stderr ?? ''),
  };
}

/**
 * Fail the build when the assembled distribution cannot start.
 *
 * Relocates the tree out of the repository first: run in place, the probe would
 * be rescued by the repository's own `node_modules` and would have passed
 * happily on all four releases that could not start.
 *
 * @returns `'booted'`, or `'skipped'` when the target cannot execute on this host.
 */
export function verifyDistributionBoots(
  outputDir: string,
  options: DistributionBootOptions,
): DistributionBootOutcome {
  if (!existsSync(join(outputDir, DIST_ENTRY_RELATIVE))) {
    throw new Error(
      `The assembled distribution at ${outputDir} has no ${DIST_ENTRY_RELATIVE}, `
      + 'so there is nothing to start.',
    );
  }

  const hostPlatform = options.hostPlatform ?? process.platform;
  const hostArch = options.hostArch ?? hostArchOf(process.arch);
  if (options.platform !== hostPlatform || options.arch !== hostArch) {
    options.onSkip?.(
      `target ${options.platform}-${options.arch} cannot be executed on `
      + `${hostPlatform}-${hostArch}; the distribution ships its target's Bun runtime. `
      + 'Only the static workspace-linkage check ran — build on the target platform '
      + 'for the full boot check.',
    );
    return 'skipped';
  }

  const probeRoot = mkdtempSync(join(tmpdir(), 'nessy-dist-boot-'));
  assertNeutralLocation(probeRoot);

  const relocated = join(probeRoot, 'nessy-server');
  const cwd = join(probeRoot, 'cwd');
  const configDir = join(probeRoot, 'config');
  let moved = false;

  try {
    try {
      renameSync(outputDir, relocated);
      moved = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
      // Temp dir on another filesystem — copy instead, preserving the
      // node_modules/@nessy-agent/* workspace symlinks verbatim.
      cpSync(outputDir, relocated, { recursive: true, verbatimSymlinks: true });
    }

    // A cwd with nothing in it: no bunfig.toml to preload from, no package.json
    // to resolve through. bunfig is read from the CWD, never the script path.
    mkdirSync(cwd, { recursive: true });
    mkdirSync(configDir, { recursive: true });

    const result = (options.run ?? spawnBootProbe)({
      entry: join(relocated, DIST_ENTRY_RELATIVE),
      cwd,
      configDir,
    });

    if (result.status !== 0 || !BOOT_PROBE_SIGNAL.test(result.stdout)) {
      throw new Error(
        `The assembled distribution cannot start.\n`
        + `\`${DIST_ENTRY_RELATIVE} ${BOOT_PROBE_ARG}\`, run from a neutral cwd with the `
        + `distribution relocated outside the repository, exited ${result.status} without `
        + 'the expected startup signal.\n'
        + 'Run in place it would have passed: inside the repository, upward module '
        + "resolution reaches the repo's own node_modules.\n"
        + `--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`,
      );
    }

    return 'booted';
  } finally {
    if (moved) {
      try {
        renameSync(relocated, outputDir);
      } catch (error) {
        // Never delete the only copy of a 1.4 GB assembly.
        throw new Error(
          `Boot probe could not move the distribution back to ${outputDir}: `
          + `${(error as Error).message}. It is still at ${relocated}.`,
        );
      }
    }
    rmSync(probeRoot, { recursive: true, force: true });
  }
}
