/**
 * Common build utilities shared across all platforms
 */

import { $ } from 'bun';
import { execSync } from 'child_process';
import {
  existsSync,
  mkdirSync,
  rmSync,
  copyFileSync,
  cpSync,
  lstatSync,
  readdirSync,
  readFileSync,
} from 'fs';
import { join, dirname } from 'path';
import { createHash } from 'crypto';
import {
  ELECTRON_INTERCEPTOR_CONTEXT,
  stageInterceptorSources,
  verifyInterceptorBundle,
} from './interceptor-pairing';

export type Platform = 'darwin' | 'win32' | 'linux';
export type Arch = 'x64' | 'arm64';

export interface BuildConfig {
  platform: Platform;
  arch: Arch;
  upload: boolean;
  uploadLatest: boolean;
  uploadScript: boolean;
  rootDir: string;
  electronDir: string;
}

/**
 * Bun version to bundle with the app.
 * Update this when upgrading Bun. Check latest at: https://github.com/oven-sh/bun/releases
 * This should match or be close to the version used in CI (setup-bun action).
 */
export const BUN_VERSION = 'bun-v1.3.9';

/**
 * uv version to bundle with the app.
 * Update this when upgrading uv. Check latest at: https://github.com/astral-sh/uv/releases
 */
export const UV_VERSION = '0.10.6';

/**
 * Get platform key for resources/bin folder naming.
 */
export function getPlatformKey(platform: Platform, arch: Arch): string {
  return `${platform}-${arch}`;
}

/**
 * Get the Bun download filename for a platform/arch combination
 */
export function getBunDownloadName(platform: Platform, arch: Arch): string {
  const archMap: Record<Arch, string> = {
    x64: 'x64',
    arm64: 'aarch64',
  };

  const platformMap: Record<Platform, string> = {
    darwin: 'darwin',
    win32: 'windows',
    linux: 'linux',
  };

  const bunArch = archMap[arch];
  const bunPlatform = platformMap[platform];

  // Windows and Linux x64 use baseline build for broader CPU compatibility (no AVX2 requirement)
  if ((platform === 'win32' || platform === 'linux') && arch === 'x64') {
    return `bun-${bunPlatform}-x64-baseline`;
  }

  return `bun-${bunPlatform}-${bunArch}`;
}

/**
 * Get uv release artifact filename for a platform/arch combination.
 */
export function getUvDownloadName(platform: Platform, arch: Arch): string {
  if (platform === 'darwin' && arch === 'arm64') return 'uv-aarch64-apple-darwin.tar.gz';
  if (platform === 'darwin' && arch === 'x64') return 'uv-x86_64-apple-darwin.tar.gz';
  if (platform === 'linux' && arch === 'arm64') return 'uv-aarch64-unknown-linux-gnu.tar.gz';
  if (platform === 'linux' && arch === 'x64') return 'uv-x86_64-unknown-linux-gnu.tar.gz';
  if (platform === 'win32' && arch === 'arm64') return 'uv-aarch64-pc-windows-msvc.zip';
  if (platform === 'win32' && arch === 'x64') return 'uv-x86_64-pc-windows-msvc.zip';

  throw new Error(`Unsupported uv target: ${platform}-${arch}`);
}

/**
 * Verify SHA256 checksum of a file
 */
export async function verifySha256(filePath: string, expectedHash: string): Promise<boolean> {
  const file = Bun.file(filePath);
  const buffer = await file.arrayBuffer();
  const hash = createHash('sha256').update(Buffer.from(buffer)).digest('hex');
  return hash.toLowerCase() === expectedHash.toLowerCase();
}

/**
 * Download and verify Bun binary
 * Uses curl for downloads (more reliable in CI than fetch + Bun.write)
 */
export async function downloadBun(config: BuildConfig): Promise<void> {
  const { platform, arch, electronDir } = config;
  const bunDownload = getBunDownloadName(platform, arch);
  const vendorDir = join(electronDir, 'vendor', 'bun');

  console.log(`Downloading Bun ${BUN_VERSION} for ${platform}-${arch}...`);

  // Create vendor directory
  mkdirSync(vendorDir, { recursive: true });

  // Create temp directory
  const tempDir = join(electronDir, '.bun-download-temp');
  mkdirSync(tempDir, { recursive: true });

  try {
    const zipUrl = `https://github.com/oven-sh/bun/releases/download/${BUN_VERSION}/${bunDownload}.zip`;
    const checksumUrl = `https://github.com/oven-sh/bun/releases/download/${BUN_VERSION}/SHASUMS256.txt`;

    // Download files using curl (more reliable in CI than fetch + Bun.write)
    const zipPath = join(tempDir, `${bunDownload}.zip`);
    const checksumPath = join(tempDir, 'SHASUMS256.txt');

    console.log(`  Downloading ${zipUrl}...`);
    await $`curl -fsSL --retry 3 --retry-delay 2 -o ${zipPath} ${zipUrl}`;
    console.log('  Download complete');

    console.log('  Downloading checksums...');
    await $`curl -fsSL --retry 3 --retry-delay 2 -o ${checksumPath} ${checksumUrl}`;

    // Verify checksum
    console.log('  Verifying checksum...');
    const checksumContent = await Bun.file(checksumPath).text();
    const expectedHash = checksumContent
      .split('\n')
      .find((line) => line.includes(`${bunDownload}.zip`))
      ?.split(' ')[0];

    if (!expectedHash) {
      throw new Error(`Checksum not found for ${bunDownload}.zip`);
    }

    const isValid = await verifySha256(zipPath, expectedHash);
    if (!isValid) {
      throw new Error('Checksum verification failed!');
    }
    console.log('  Checksum verified ✓');

    // Extract
    console.log('  Extracting...');
    await $`unzip -o ${zipPath} -d ${tempDir}`.quiet();

    // Copy binary
    const bunBinary = platform === 'win32' ? 'bun.exe' : 'bun';
    const sourcePath = join(tempDir, bunDownload, bunBinary);
    const destPath = join(vendorDir, bunBinary);

    copyFileSync(sourcePath, destPath);

    // Make executable on Unix
    if (platform !== 'win32') {
      await $`chmod +x ${destPath}`.quiet();
    }

    console.log(`  Bun installed to ${destPath} ✓`);
  } finally {
    // Cleanup temp directory
    rmSync(tempDir, { recursive: true, force: true });
  }
}

/**
 * Find the first matching file recursively under a directory.
 */
function findFileRecursive(root: string, fileName: string): string | null {
  const entries = readdirSync(root, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(root, entry.name);
    if (entry.isFile() && entry.name === fileName) {
      return fullPath;
    }
    if (entry.isDirectory()) {
      const nested = findFileRecursive(fullPath, fileName);
      if (nested) return nested;
    }
  }
  return null;
}

/**
 * Download and verify uv binary, then install it to resources/bin/<platform-arch>/uv(.exe).
 */
export async function downloadUv(config: BuildConfig): Promise<void> {
  const { platform, arch, electronDir } = config;
  const uvDownload = getUvDownloadName(platform, arch);
  const uvBinaryName = platform === 'win32' ? 'uv.exe' : 'uv';
  const platformKey = getPlatformKey(platform, arch);

  const targetDir = join(electronDir, 'resources', 'bin', platformKey);
  const targetPath = join(targetDir, uvBinaryName);

  // Skip when already provisioned
  if (existsSync(targetPath)) {
    console.log(`uv already present at ${targetPath}`);
    return;
  }

  console.log(`Downloading uv ${UV_VERSION} for ${platformKey}...`);

  mkdirSync(targetDir, { recursive: true });
  const tempDir = join(electronDir, '.uv-download-temp');
  rmSync(tempDir, { recursive: true, force: true });
  mkdirSync(tempDir, { recursive: true });

  try {
    const baseUrl = (
      process.env.UV_DOWNLOAD_BASE_URL ?? `https://github.com/astral-sh/uv/releases/download/${UV_VERSION}`
    ).replace(/\/$/, '');
    const assetUrl = `${baseUrl}/${uvDownload}`;
    const checksumUrl = `${assetUrl}.sha256`;

    const assetPath = join(tempDir, uvDownload);
    const checksumPath = join(tempDir, `${uvDownload}.sha256`);
    const extractDir = join(tempDir, 'extract');

    console.log(`  Downloading ${assetUrl}...`);
    await $`curl -fsSL --retry 3 --retry-delay 2 -o ${assetPath} ${assetUrl}`;

    console.log('  Downloading checksum...');
    await $`curl -fsSL --retry 3 --retry-delay 2 -o ${checksumPath} ${checksumUrl}`;

    console.log('  Verifying checksum...');
    const checksumContent = await Bun.file(checksumPath).text();
    const hashMatch = checksumContent.match(/[a-fA-F0-9]{64}/);
    if (!hashMatch) {
      throw new Error(`Unable to parse checksum from ${checksumPath}`);
    }

    const isValid = await verifySha256(assetPath, hashMatch[0]);
    if (!isValid) {
      throw new Error('uv checksum verification failed');
    }
    console.log('  Checksum verified ✓');

    mkdirSync(extractDir, { recursive: true });

    if (uvDownload.endsWith('.zip')) {
      // Use PowerShell on Windows for consistent extraction support.
      await $`powershell -NoProfile -ExecutionPolicy Bypass -Command "Expand-Archive -LiteralPath '${assetPath}' -DestinationPath '${extractDir}' -Force"`;
    } else {
      await $`tar -xzf ${assetPath} -C ${extractDir}`;
    }

    const extractedUv = findFileRecursive(extractDir, uvBinaryName);
    if (!extractedUv) {
      throw new Error(`Unable to locate ${uvBinaryName} in extracted archive`);
    }

    copyFileSync(extractedUv, targetPath);
    if (platform !== 'win32') {
      await $`chmod +x ${targetPath}`.quiet();
    }

    console.log(`  uv installed to ${targetPath} ✓`);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

/**
 * Clean previous build artifacts
 */
export function cleanBuildArtifacts(config: BuildConfig): void {
  const { electronDir } = config;

  console.log('Cleaning previous builds...');

  const foldersToClean = [
    join(electronDir, 'vendor'),
    join(electronDir, 'node_modules', '@anthropic-ai'),
    join(electronDir, 'packages'),
    join(electronDir, 'release'),
  ];

  for (const folder of foldersToClean) {
    if (existsSync(folder)) {
      rmSync(folder, { recursive: true, force: true });
    }
  }
}

/**
 * Install dependencies
 * On Windows, uses hoisted linker to avoid .bun symlink directory
 */
export async function installDependencies(config: BuildConfig): Promise<void> {
  const { rootDir, platform } = config;

  if (platform === 'win32') {
    // Use hoisted linker on Windows - Bun's default isolated mode creates
    // node_modules/.bun/ with symlinks that esbuild can't traverse on Windows
    // ("Access is denied" errors with junction points)
    // Hoisted mode creates flat npm-style node_modules without .bun
    console.log('Installing dependencies (Windows hoisted mode)...');
    await $`cd ${rootDir} && bun install --linker=hoisted`.quiet();
  } else {
    console.log('Installing dependencies...');
    await $`cd ${rootDir} && bun install`.quiet();
  }
}

/**
 * Per-platform optional-dep package name for the native `claude` binary.
 * Since SDK 0.2.113 the SDK ships only `sdk.mjs` + types; the native CLI
 * lives in a per-arch sibling package (`@anthropic-ai/claude-agent-sdk-{platform}-{arch}`).
 */
function platformBinaryPkg(config: BuildConfig): string {
  const { platform, arch } = config;
  if (platform === 'darwin') return `claude-agent-sdk-darwin-${arch}`;
  if (platform === 'win32') return `claude-agent-sdk-win32-${arch}`;
  if (platform === 'linux') return `claude-agent-sdk-linux-${arch}`;
  throw new Error(`Unsupported platform for SDK binary lookup: ${platform}`);
}

function nativeBinaryName(config: BuildConfig): string {
  return config.platform === 'win32' ? 'claude.exe' : 'claude';
}

/**
 * Copy SDK from root node_modules:
 *   1. The thin core (`claude-agent-sdk`) — universal sdk.mjs + types.
 *   2. The matching arch's binary package, staged at the stable alias
 *      `claude-agent-sdk-binary/` so electron-builder.yml stays arch-agnostic
 *      and the runtime resolver finds the binary regardless of host arch.
 */
export function copySDK(config: BuildConfig): void {
  const { rootDir, electronDir } = config;
  const sdkScope = join(electronDir, 'node_modules', '@anthropic-ai');

  const sdkSource = join(rootDir, 'node_modules', '@anthropic-ai', 'claude-agent-sdk');
  const sdkDest = join(sdkScope, 'claude-agent-sdk');

  if (!existsSync(sdkSource)) {
    throw new Error(`SDK core not found at ${sdkSource}. Run 'bun install' first.`);
  }

  console.log('Copying SDK core...');
  mkdirSync(sdkScope, { recursive: true });
  if (existsSync(sdkDest)) {
    rmSync(sdkDest, { recursive: true, force: true });
  }
  cpSync(sdkSource, sdkDest, { recursive: true, dereference: true });

  const pkg = platformBinaryPkg(config);
  const binSource = join(rootDir, 'node_modules', '@anthropic-ai', pkg);
  if (!existsSync(binSource)) {
    throw new Error(
      `SDK native binary package not found at ${binSource}. ` +
      `For cross-arch builds run \`npm pack @anthropic-ai/${pkg}@<sdk-version>\` ` +
      `to fetch it, or use the platform build script (build-dmg.sh / build-linux.sh / build-win.ps1) ` +
      `which handles the cross-fetch automatically.`,
    );
  }

  const aliasDest = join(sdkScope, 'claude-agent-sdk-binary');
  console.log(`Staging SDK native binary (${pkg}) as claude-agent-sdk-binary alias...`);
  if (existsSync(aliasDest)) {
    rmSync(aliasDest, { recursive: true, force: true });
  }
  cpSync(binSource, aliasDest, { recursive: true, dereference: true });
}

/**
 * Verify the native binary was copied correctly (real file, expected size).
 * Since SDK 0.2.113 the binary is 210-307 MB — 222 MB on darwin-arm64 at
 * `0.3.247`, where it SHRANK by about a quarter, and 222-242 MB across that
 * version's eight platform packages. The floor below is a botched-copy check and
 * nothing more, so it is deliberately not tracked to the reading.
 */
export function verifySDKCopy(config: BuildConfig): void {
  const { electronDir } = config;
  const binaryPath = join(
    electronDir,
    'node_modules', '@anthropic-ai', 'claude-agent-sdk-binary',
    nativeBinaryName(config),
  );

  if (!existsSync(binaryPath)) {
    throw new Error(`SDK verification failed: native binary not found at ${binaryPath}`);
  }

  const stats = lstatSync(binaryPath);
  if (stats.isSymbolicLink()) {
    throw new Error('SDK verification failed: native binary is a symlink (should be real file)');
  }

  const size = stats.size;
  if (size < 50_000_000) {
    throw new Error(`SDK verification failed: native binary too small (${size} bytes, expected 210-307 MB)`);
  }

  console.log(`  SDK copy verified: native binary is ${(size / 1024 / 1024).toFixed(1)} MB`);
}

/**
 * Copy network interceptor source files (Anthropic — runs under Bun via --preload)
 *
 * The list is DERIVED from the interceptor's own imports (P6.805), not written
 * by hand: `stageInterceptorSources` walks them transitively, so this closure
 * cannot go short again. It was, for four days — the hand list carried three of
 * the module's five direct imports; `interceptorClosure`'s docblock has the
 * measurement and the four names the hand list was missing.
 *
 * P6.820 closed the first of the two residues P6.805 left here. This function
 * HAD no callers: `apps/electron/scripts/build-{dmg.sh,linux.sh,win.ps1}` each
 * re-spelled the copy in shell/PowerShell with the same hand-written three, so
 * the shipped artefact carried three of the seven — the repo's own cautionary
 * case (`copyInterceptorBundle`, a guard nobody called) recurring. All three now
 * call THIS function through `bun -e`, the way they already call `downloadUv`,
 * and `electron-builder.yml` names the whole derived closure. One derivation,
 * four consumers.
 *
 * The second residue stands, and it is the reason the first could stand for four
 * days: it is not a live break either way. The PACKAGED runtime loads
 * `apps/electron/dist/interceptor.cjs`, an esbuild bundle that inlines every
 * import (`runtime-resolver.ts:resolveInterceptorBundlePath`), and the `.ts`
 * copies serve the dev/monorepo preload path, where the missing modules resolve
 * from the repo anyway.
 *
 * The parameter is narrowed to the two fields it reads, so a shell caller can
 * pass the two paths it has rather than a `BuildConfig` it would have to invent.
 */
export function copyInterceptor(config: Pick<BuildConfig, 'rootDir' | 'electronDir'>): void {
  const { rootDir, electronDir } = config;

  const staged = stageInterceptorSources(rootDir, electronDir);
  console.log(`Interceptor staged: ${staged.length} files, derived from its own imports.`);
}

/**
 * Verify the unified interceptor CJS bundle exists (runs under Node.js via --require)
 * Built by `bun run build:interceptor` into apps/electron/dist/
 *
 * This used to WARN and return, which is the same as no check: a missing bundle
 * makes the packaged app's Pi subprocess start unpatched with no runtime error,
 * so a warning scrolls past and a broken artifact ships. It now fails, through
 * the same assertion the server build has always used.
 */
export function copyInterceptorBundle(config: BuildConfig): void {
  const { electronDir } = config;

  const source = join(electronDir, 'dist', 'interceptor.cjs');
  verifyInterceptorBundle(source, ELECTRON_INTERCEPTOR_CONTEXT);

  // Already in dist/ which is included in the packaged app — just verify it exists
  console.log('Interceptor bundle verified at:', source);
}

/**
 * Copy Session MCP Server to packaged app resources.
 * The session server provides session-scoped tools (SubmitPlan, config_validate, etc.) for agent sessions.
 */
export function copySessionServer(config: BuildConfig): void {
  const { rootDir, electronDir } = config;

  const sessionSource = join(rootDir, 'packages', 'session-mcp-server', 'dist', 'index.js');
  const sessionDest = join(electronDir, 'resources', 'session-mcp-server', 'index.js');

  if (!existsSync(sessionSource)) {
    throw new Error(`Session server not found at ${sessionSource}. Session-scoped tools will not work.`);
  }

  console.log('Copying Session MCP Server...');
  mkdirSync(dirname(sessionDest), { recursive: true });
  copyFileSync(sessionSource, sessionDest);
}

/**
 * Map our Platform type to koffi's directory naming convention.
 * koffi uses: darwin_arm64, darwin_x64, linux_x64, win32_x64, etc.
 */
function koffiPlatformDir(platform: Platform, arch: Arch): string {
  return `${platform}_${arch}`;
}

/**
 * Copy Pi Agent Server to packaged app resources.
 *
 * The bun build uses --external koffi so the bare import resolves through
 * node_modules at runtime. We copy the koffi npm package next to index.js
 * with only the target platform's native binary (~4MB instead of ~80MB).
 */
export function copyPiAgentServer(config: BuildConfig): void {
  const { rootDir, electronDir, platform, arch } = config;

  const piSourceDir = join(rootDir, 'packages', 'pi-agent-server', 'dist');
  const piDestDir = join(electronDir, 'resources', 'pi-agent-server');

  if (!existsSync(join(piSourceDir, 'index.js'))) {
    throw new Error(`Pi agent server not found at ${piSourceDir}/index.js. Pi SDK sessions will not work.`);
  }

  console.log('Copying Pi Agent Server...');
  mkdirSync(piDestDir, { recursive: true });

  // 1. Copy index.js plus the Pi package identity the bundled runtime resolves
  // its VERSION/piConfig from (nearest package.json above the bundle).
  copyFileSync(join(piSourceDir, 'index.js'), join(piDestDir, 'index.js'));
  if (!existsSync(join(piSourceDir, 'package.json'))) {
    throw new Error(`Pi package identity not found at ${piSourceDir}/package.json. Rebuild pi-agent-server; Pi sessions would fail version validation.`);
  }
  copyFileSync(join(piSourceDir, 'package.json'), join(piDestDir, 'package.json'));

  // 2. Copy koffi npm package (external import, resolved via node_modules at runtime)
  const koffiSource = join(rootDir, 'node_modules', 'koffi');

  if (!existsSync(koffiSource)) {
    throw new Error('koffi not found in node_modules. Pi SDK sessions will not work.');
  }

  const koffiDest = join(piDestDir, 'node_modules', 'koffi');
  mkdirSync(koffiDest, { recursive: true });

  // Copy koffi JS files
  for (const entry of ['package.json', 'index.js', 'indirect.js', 'index.d.ts', 'lib']) {
    const src = join(koffiSource, entry);
    if (existsSync(src)) {
      cpSync(src, join(koffiDest, entry), { recursive: true });
    }
  }

  // Copy only the target platform's native binary
  const targetDir = koffiPlatformDir(platform, arch);
  const nativeSrc = join(koffiSource, 'build', 'koffi', targetDir);
  const nativeDest = join(koffiDest, 'build', 'koffi', targetDir);

  if (existsSync(nativeSrc)) {
    mkdirSync(nativeDest, { recursive: true });
    cpSync(nativeSrc, nativeDest, { recursive: true });
    // `[0]` is `string | undefined` — an empty koffi dir is a real (if unlikely)
    // state, and indexing it blindly crashed with a bare "path must be a string"
    // instead of naming the directory that was empty.
    const first = readdirSync(nativeSrc)[0];
    const size = first ? lstatSync(join(nativeSrc, first)).size : 0;
    console.log(`  Copied index.js + koffi/${targetDir} (${(size / 1024 / 1024).toFixed(1)}MB)`);
  } else {
    console.warn(`  Warning: koffi native binary not found for ${targetDir}`);
    cpSync(join(koffiSource, 'build'), join(koffiDest, 'build'), { recursive: true });
    console.log('  Copied index.js + koffi (all platforms as fallback)');
  }

  // Inside the copy, not beside it. A restage that happens but is never checked
  // is the same defect one layer along, and a caller that has to remember a
  // second call is a caller that will one day forget: every path that stages —
  // `stage-electron-servers.ts` and `scripts/electron-dev.ts` — gets this here.
  assertStagedPiMatchesDist(config);
}

/**
 * The staged Pi artifacts must be byte-identical to the dist they came from.
 *
 * Both files matter and for different reasons. `index.js` is the code the
 * packaged app runs; `package.json` is the Pi package identity the bundled
 * runtime walks up to for VERSION/piConfig, and a missing or mismatched one
 * fails every session with `Unsupported Pi runtime` — a message that reads
 * like the model declining to dispatch rather than like a build error.
 *
 * The hash, not the size: two bundles built from different source can land on
 * the same length, and this repo has already been burned once by treating a
 * cheap proxy as evidence.
 *
 * Hashing is sound HERE and nowhere else nearby: this compares a copy against
 * the exact file `copyPiAgentServer` just copied it from. `bun build` is not
 * reproducible (see `buildPiAgentServerBundle`), so the same check between two
 * independently built bundles would fail about half the time on identical
 * source. Do not lift it out of the copy.
 */
export function assertStagedPiMatchesDist(config: BuildConfig): void {
  const { rootDir, electronDir } = config;

  const files: ReadonlyArray<readonly [string, string]> = [
    ['index.js', 'The staged Pi bundle'],
    ['package.json', 'The staged Pi package identity'],
  ];

  for (const [file, what] of files) {
    const source = join(rootDir, 'packages', 'pi-agent-server', 'dist', file);
    const staged = join(electronDir, 'resources', 'pi-agent-server', file);

    if (!existsSync(source)) {
      throw new Error(`${what} has no source to match: ${source} is missing. Rebuild pi-agent-server.`);
    }
    if (!existsSync(staged)) {
      throw new Error(`${what} was never written: ${staged} is missing. Run \`bun run electron:build:servers\`.`);
    }

    const sourceHash = sha256Of(source);
    const stagedHash = sha256Of(staged);
    if (sourceHash !== stagedHash) {
      throw new Error(
        `${what} is stale: ${staged} (sha256 ${stagedHash.slice(0, 12)}) does not match ` +
        `${source} (sha256 ${sourceHash.slice(0, 12)}). Run \`bun run electron:build:servers\`.`
      );
    }
  }
}

function sha256Of(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/**
 * Build MCP servers (session) and Pi agent server.
 * Shared across all platforms to avoid drift.
 */
export function buildMcpServers(config: BuildConfig): void {
  const { rootDir } = config;

  const sessionDir = join(rootDir, 'packages', 'session-mcp-server');
  const sessionOut = join(sessionDir, 'dist', 'index.js');

  console.log('Building MCP servers...');

  mkdirSync(join(sessionDir, 'dist'), { recursive: true });

  // No `shell` option on any of these: execSync always runs through a shell,
  // and the option's type is the shell's PATH (a string) — `shell: true` was a
  // boolean in a string slot, a compile error doing nothing at runtime.
  execSync(
    `bun build ${join(sessionDir, 'src', 'index.ts')} --outfile ${sessionOut} --target node --format cjs`,
    { cwd: rootDir, stdio: 'inherit' }
  );

  if (!existsSync(sessionOut)) {
    throw new Error(`Session MCP server output not found at ${sessionOut}`);
  }

  buildPiAgentServerBundle(config);
}

/**
 * Build `packages/pi-agent-server/dist` — the ONE recipe for that bundle.
 *
 * Exported because `scripts/electron-dev.ts` must use this exact command, not a
 * near-copy. The dev app spawns `packages/pi-agent-server/dist/index.js` (the
 * `!isPackaged` branch of `resolveServerPath`) and the packaged app spawns the
 * staged copy under `apps/electron/resources/pi-agent-server/`, so a second
 * spelling of this command is a second artifact nobody can tell apart from a
 * stale one.
 *
 * Two things measured on 2026-08-27, both of which say the staged copy has to
 * be a COPY and can never be an independently built twin:
 *
 *  - cwd leaks into the output. `bun build` writes each module's path relative
 *    to the working directory into a comment, so the identical source built
 *    from `packages/pi-agent-server` rather than the repo root differs by
 *    ~20,000 bytes of `../../` prefixes across the same 4,477 modules. That is
 *    the bulk of the 20,014-byte gap P2.193 arrived as, and it is not drift.
 *  - `bun build` is not reproducible. The SAME command line, same cwd, same
 *    outdir, same source, run twice, alternates between two stable images 47
 *    bytes and 100 hunks apart — every hunk an identifier-suffix counter
 *    (`target`/`target2`, `check`/`check2`, `Type2`/`Type3`), no semantic
 *    difference. Measured by rebuilding into one fixed outdir repeatedly and
 *    watching the digest flip back and forth.
 *
 * So comparing digests of two independent builds is a coin flip, not a
 * staleness test — which is the second reason P2.87 had to build a literal
 * ledger instead of hashing, and the reason `assertStagedPiMatchesDist` only
 * ever compares a copy against the file it was copied from.
 *
 * `--target=bun --format=esm`: the Pi SDK deps are ESM-only, and
 * `--target=node --format=cjs` leaves them as external `require()` calls that
 * fail at runtime. `--external koffi`: koffi is a native N-API module — bun
 * cannot inline a `.node` binary and inlining its JS breaks the native binary
 * resolution paths; `copyPiAgentServer` ships the npm package beside the
 * bundle instead. That flag is a no-op TODAY — measured, the only occurrence of
 * `koffi` in either 27 MB bundle is inside an inlined copy of the repo root
 * `package.json`'s `trustedDependencies`, and nothing imports it — but it stays,
 * because the day something does, the dev path and the packaging path must not
 * be the two places that disagree about it.
 */
export function buildPiAgentServerBundle(config: BuildConfig): void {
  const { rootDir } = config;

  const piDir = join(rootDir, 'packages', 'pi-agent-server');
  const piOut = join(piDir, 'dist', 'index.js');

  // Optional: skip if package directory is missing (e.g., not synced to OSS).
  if (!existsSync(join(piDir, 'src'))) {
    console.warn('Warning: Pi agent server package not found. Pi SDK sessions will not work.');
    return;
  }

  mkdirSync(join(piDir, 'dist'), { recursive: true });
  execSync(
    `bun build ${join(piDir, 'src', 'index.ts')} --outdir ${join(piDir, 'dist')} --target bun --format esm --external koffi`,
    { cwd: rootDir, stdio: 'inherit' }
  );
  if (!existsSync(piOut)) {
    throw new Error(`Pi agent server output not found at ${piOut}`);
  }
  // Write the Pi package identity (dist/package.json) that copyPiAgentServer
  // requires for the bundled runtime's VERSION/piConfig resolution — mirrors
  // pi-agent-server's own `build` script, which the raw `bun build` above omits.
  // Omitting it is not cosmetic: the bundled Pi runtime walks up from the bundle
  // for its VERSION/piConfig, lands on an unrelated manifest, and the adapter
  // rejects every session with `Unsupported Pi runtime` — the failure AGENTS.md
  // records after a `rm -rf packages/pi-agent-server/dist`.
  execSync('bun scripts/write-dist-package.ts', { cwd: piDir, stdio: 'inherit' });
  if (!existsSync(join(piDir, 'dist', 'package.json'))) {
    throw new Error(`Pi package identity not written at ${join(piDir, 'dist', 'package.json')}`);
  }
}

/**
 * Verify MCP helper servers and Pi agent server are present in packaged resources.
 */
export function verifyMcpServersExist(config: BuildConfig): void {
  const { electronDir } = config;

  const sessionPath = join(electronDir, 'resources', 'session-mcp-server', 'index.js');
  const piPath = join(electronDir, 'resources', 'pi-agent-server', 'index.js');

  if (!existsSync(sessionPath)) {
    throw new Error(`Session MCP server not found at ${sessionPath}`);
  }
  if (!existsSync(piPath)) {
    throw new Error(`Pi agent server not found at ${piPath}. Pi SDK sessions will not work.`);
  }
}

/**
 * Build the Electron app (main, preload, renderer)
 */
export async function buildElectronApp(config: BuildConfig): Promise<void> {
  const { rootDir } = config;

  console.log('Building Electron app...');
  await $`cd ${rootDir} && bun run electron:build`;
}

/**
 * Create manifest.json for upload
 */
export async function createManifest(config: BuildConfig): Promise<string> {
  const { rootDir, electronDir } = config;

  const packageJson = await Bun.file(join(electronDir, 'package.json')).json();
  const version = packageJson.version;

  const uploadDir = join(rootDir, '.build', 'upload');
  mkdirSync(uploadDir, { recursive: true });

  const manifestPath = join(uploadDir, 'manifest.json');
  await Bun.write(manifestPath, JSON.stringify({ version }, null, 2));

  console.log(`Created manifest.json (version: ${version})`);
  return version;
}

/**
 * Upload to S3
 */
export async function uploadToS3(config: BuildConfig): Promise<void> {
  const { rootDir, upload, uploadLatest, uploadScript } = config;

  if (!upload) return;

  // Check for required env vars
  const required = [
    'S3_VERSIONS_BUCKET_ENDPOINT',
    'S3_VERSIONS_BUCKET_ACCESS_KEY_ID',
    'S3_VERSIONS_BUCKET_SECRET_ACCESS_KEY',
  ];

  const missing = required.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    throw new Error(`Missing S3 credentials: ${missing.join(', ')}`);
  }

  console.log('\n=== Uploading to S3 ===');

  const flags = ['--electron'];
  if (uploadLatest) flags.push('--latest');
  if (uploadScript) flags.push('--script');

  await $`cd ${rootDir} && bun run scripts/upload.ts ${flags}`;

  console.log('Upload complete ✓');
}

/**
 * Load environment variables from .env file
 */
export async function loadEnvFile(config: BuildConfig): Promise<void> {
  const envPath = join(config.rootDir, '.env');

  if (existsSync(envPath)) {
    const content = await Bun.file(envPath).text();
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#')) {
        const [key, ...valueParts] = trimmed.split('=');
        if (key && valueParts.length > 0) {
          const value = valueParts.join('=').replace(/^["']|["']$/g, '');
          process.env[key] = value;
        }
      }
    }
  }
}

/**
 * Get output artifact name for a platform/arch
 */
export function getArtifactName(platform: Platform, arch: Arch): string {
  switch (platform) {
    case 'darwin':
      return `Nessy-Agents-${arch}.dmg`;
    case 'win32':
      return `Nessy-Agents-${arch}.exe`;
    case 'linux':
      return `Nessy-Agents-${arch}.AppImage`;
  }
}
