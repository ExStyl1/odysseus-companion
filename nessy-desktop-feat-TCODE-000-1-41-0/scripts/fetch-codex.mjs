#!/usr/bin/env node
/**
 * Fetch + SHA-verify the prebuilt upstream `codex-app-server` binaries from the
 * pinned `openai/codex` GitHub Release (tag from
 * `packages/codex-protocol/manifest.json` `upstream.tag`) and install each into
 * `apps/electron/resources/bin/codex/<platform-dir>/codex-app-server[.exe]`.
 *
 * Trust anchor at fetch time: the release `codex-package_SHA256SUMS` (official
 * per-archive sums). This script then records the extracted-binary sha256 into
 * `manifest.json` `binaries[<dir>]` — the anchor the RUNTIME verifier
 * (`manifest-verifier.ts`) checks before every spawn. The manifest is regenerated
 * by this script, never hand-edited.
 *
 * `codex-app-server` is fetched direct from GitHub Releases, and that is not a
 * preference — see PROVENANCE below; no registry publishes it.
 *
 * The optional `--windows-sandbox` mode installs the three required
 * restricted-token sandbox executables, and it has TWO sources (P3.282):
 * `--windows-sandbox-source=npm` (the DEFAULT) takes them from the
 * `@openai/codex@<version>-win32-x64` package on the configured registry, and
 * `=github` takes them from the official full Windows release package. The
 * default is npm because that trio was the ONE github.com download the Windows
 * build path needed regardless of every feature flag, and a CI fleet with no
 * github egress could not build Windows because of it. Normal mode bundles
 * `codex-app-server` and its `codex-code-mode-host` (F1.1216), never the TUI.
 *
 * **The npm default is UNAVAILABLE at a freshly-lifted tag, and that is the
 * mirror's lag rather than a defect in either path** (measured 2026-09-13 on the
 * lift into `rust-v0.154.0`). The Artifactory `npm-all` proxy answered **403**
 * for `@openai/codex@0.154.0-win32-x64` and for plain `0.154.0`, its newest
 * cached publish was `0.151.0-alpha.8` (2026-08-28) and its `dist-tags.latest`
 * still read `0.150.1` — the version we had just lifted AWAY from — while
 * `0.150.1-win32-x64` answered 200 as the positive control. So the npm arm
 * refused by name, exactly as its own error says it should, and this lift took
 * the trio from `=github`: that is the day `=github` is "kept for". **A tag lift
 * therefore re-introduces the one mandatory github.com download into the Windows
 * build path until the mirror catches up**, which is a CI fact (`.gitlab-ci.yml`
 * §Windows park) and not a code change. The `windowsSandbox.win32-x64.npm`
 * sub-block is DROPPED rather than carried forward for the same reason: those
 * bytes cannot be measured at this tag today, and a stale record there does not
 * fail safe — `fetchWindowsSandboxFromNpm` would compare the NEW tarball against
 * the OLD `tarballSha256` and report a corruption where the truth is a stale
 * pin. One `--windows-sandbox` run restores the block the day the mirror carries
 * the version.
 *
 * PROVENANCE (P3.224, recorded 2026-09-03; full record in
 * `docs/superpowers/specs/2026-09-03-codex-binary-provenance.md`).
 * GitHub Releases is not a fallback here — it is the ONLY channel that
 * publishes this artefact. Upstream builds two variants of the same version and
 * tags them itself in each package's `codex-package.json`: npm
 * `@openai/codex` ships `variant: "codex"` (the CLI/TUI), while
 * `variant: "codex-app-server"` — the binary we spawn — is published solely as
 * the `codex-app-server-package-<target>.tar.gz` release asset. Measured
 * 2026-09-11 at the tag before this one: the whole
 * `@openai/codex@0.150.1-win32-x64` package is EIGHT members and not one of them
 * is a `codex-app-server` — it carries `bin/codex.exe`,
 * `bin/codex-code-mode-host.exe`, `codex-path/rg.exe` and the two sandbox
 * executables. That reading could NOT be re-taken at `rust-v0.154.0` for the
 * reason the paragraph above gives (the mirror has no `0.154.0-win32-x64`), so
 * it stands as the dated reading it is; what was re-measured on 2026-09-13 is
 * the claim it supports, from the other side — the release's own app-server
 * package still carries `bin/codex-app-server` and the npm-published `codex`
 * variant still does not. So NO registry pin at ANY version can reproduce our
 * binary. Do not "fix" this by pointing the script at npm.
 *   source  https://github.com/openai/codex/releases/download/rust-v0.154.0/
 *           codex-app-server-package-aarch64-apple-darwin.tar.gz
 *   archive sha256 7bf20c1843bdcff086c89a294299833f20146ebbdba03e7f49f020b7adbfff7b
 *   binary  sha256 2fc485696e5df06fc492fb310599752775fde726585149eaa7aeadb9117d235a
 *           (`codex-app-server 0.154.0`, the binary's own `--version`; every
 *           target's pair is in manifest.json, all verified against the release
 *           sums by this script's own run on 2026-09-13)
 * Artifactory's `@openai/codex` mirror is a lazily-refreshing proxy: uncached
 * newer versions answer 403 (not 404), and its cache ran ~15 days behind
 * upstream when that was first measured — so an "absent from Artifactory"
 * reading is a reading with a timestamp, not a fact. That paragraph's MEASURED
 * value is the perishable half and it has now turned over twice: read
 * `dist-tags.latest` yourself, never quote it (it said `0.148.0` on 2026-09-03,
 * `0.150.1` on 2026-09-11, and `0.150.1` again on 2026-09-13 — which on the last
 * date meant the mirror was a whole lift BEHIND the tag this repo ships).
 * The one part npm CAN supply is the `--windows-sandbox` trio, and only once the
 * mirror has cached the version: all three files in
 * `@openai/codex@0.150.1-win32-x64` were byte-identical to that tag's pins,
 * measured three times independently (W10-f's rig, P7.2's own re-extraction of
 * the same tarball, and the script's own drive through the registry, all
 * 2026-09-10/11). It is still the DEFAULT source — it removes the one mandatory
 * github.com download from the Windows build path (`.gitlab-ci.yml` §Windows
 * park) on every day the mirror is current — but see the paragraph above for
 * what a freshly-lifted tag does to it.
 *
 * WHAT MOVED AND WHAT DID NOT, because "the integrity check is unchanged" is
 * the sort of sentence that deserves to be specific:
 *   - unchanged: the per-file `binarySha256` gate in `fetchWindowsSandboxTarget`
 *     against `manifest.json` `windowsSandbox.win32-x64.files[*]`, which is what
 *     the runtime verifier ultimately trusts. A registry that served a different
 *     binary fails here exactly as a github mirror would.
 *   - moved: the ARCHIVE-level anchor. On the github path it is the release
 *     `codex-package_SHA256SUMS` plus the pinned `archiveSha256`; on the npm
 *     path it is the registry's own published digest for that version
 *     (`dist.integrity`, and `dist.shasum` when present), checked before the
 *     archive is opened, plus `npm.tarballSha256` once the manifest carries it.
 *
 * WHAT IS NOT EXTRACTED, and the measurement that settled it (C4.33, 2026-09-11).
 * The archive carries more than `bin/codex-app-server`, and the obvious worry is
 * that this product turns on a `[features]` key with no binary behind it. Asked
 * of the one key that looked exposed — `shell_snapshot = true`, which
 * `buildCodexConfigToml` writes — the answer is NO, measured at `rust-v0.150.1`
 * rather than assumed:
 *   - `codex-rs/shell-command/src/shell_snapshot.rs` emits a SCRIPT per shell
 *     type; the interpreter is resolved by `shell_detect.rs` `get_shell_path`,
 *     which tries the user's login shell (`getpwuid`), then
 *     `which::which("zsh")`, then `ZSH_FALLBACK_PATHS = ["/bin/zsh"]`. No member
 *     of that chain is a path inside this archive.
 *   - the shipped `darwin-arm64` binary scores `codex-resources/zsh` **0**
 *     against `/bin/zsh` **2** and `zsh` 77 on the same scan (dead control
 *     `zzz-not-a-real-str` 0).
 *   - the bundled `codex-resources/zsh/bin/zsh` is real
 *     (`scripts/codex_package/zsh.py`, `ZSH_RESOURCE_PATH`) and belongs to the
 *     PATCHED ZSH FORK behind `Feature::ShellZshFork`
 *     (`Stage::UnderDevelopment`, `default_enabled: false`) and
 *     `Feature::UnifiedExecZshFork` (`Stage::Removed`) — neither of which this
 *     product writes.
 * So nothing is added to the extraction list. The day a lane writes
 * `shell_zsh_fork`, this is the paragraph that says a binary has to come with
 * it; `config-writer-shell-snapshot.test.ts` is the guard that makes that day
 * loud instead of quiet.
 *
 * AND THE OTHER TWO SIBLINGS, asked the same way at `rust-v0.154.0` (I2.25,
 * 2026-09-17). C4.33 answered for `codex-resources/zsh`; the row that carried it
 * here asks the same of `bin/codex-code-mode-host` and `codex-path/rg`, because
 * "the bare binary answers `initialize` byte-identically" does not prove a path
 * that needs credentials and a real turn. Instrument named beside the number,
 * because the two ways of counting a minified binary disagree:
 * `grep -aoF <needle> <binary> | wc -l`, i.e. OCCURRENCES, over the shipped
 * `darwin-arm64/codex-app-server` whose own `--version` says `0.154.0`:
 *
 *   codex-code-mode-host   2      code_mode_host        25
 *   codex-path/rg          0      codex-resources/zsh    0
 *   zzz-not-a-real-str     0   (the dead control that proves the scan reads)
 *
 * `codex-path/rg` scores ZERO, so this binary never reaches for the bundled
 * ripgrep — the file-search path resolves its own tool, as the shell chain does.
 * `codex-resources/zsh` is still zero, which re-confirms C4.33 at the new tag.
 *
 * `codex-code-mode-host` is the interesting one and it answers the row in the
 * best possible way: BOTH of its two occurrences are the unavailability message
 * and the file that emits it, read out of the binary at their byte offsets —
 * *"Code Mode is unavailable because …; enable `features.code_mode_host` and
 * install `codex-code-mode-host`"*, from
 * `core/src/tools/code_mode/execute_handler.rs`. So the degradation this row
 * worried about is not silent: codex names the missing file and the feature key
 * in one sentence. And the path is not reached anyway — `Feature::CodeMode`
 * (`code_mode`) is `Stage::UnderDevelopment, default_enabled: false` in
 * `features/src/lib.rs` at the tag, and `buildCodexConfigToml` writes neither
 * `code_mode` nor `code_mode_host` (both score 0 in it). `code_mode_host` IS
 * `Stage::Stable, default_enabled: true`, so it is on by default — but it is
 * only the HOST half, and with the mode that drives it off there is nothing to
 * host.
 *
 * Nothing was added to the extraction list for these two then. The day a lane
 * writes `code_mode`, this is the paragraph that says `bin/codex-code-mode-host`
 * has to come with it.
 *
 * THAT DAY CAME WITHOUT A LANE WRITING `code_mode` (F1.1216, 2026-10-01, read at
 * `rust-v0.159.3`). The mode is no longer only a feature key: the MODEL asks for
 * it. `core/src/tools/mod.rs` `requested_tool_mode` returns
 * `model_info.tool_mode` first and consults `features.code_mode*` only when the
 * model names none, and `effective_tool_mode` falls back to Direct only for
 * `CodeMode` — never for `CodeModeOnly`. The bundled
 * `models-manager/models.json` marks every gpt-6, gpt-6.1 and gpt-5.6 entry and
 * `codex-auto-review` `tool_mode: "code_mode_only"` (gpt-5.5 alone names none),
 * so without the host those models get NO tools and codex says *"Code mode will
 * fail closed"* (`core/src/tools/code_mode/mod.rs`). So `bin/codex-code-mode-host`
 * IS extracted now, from the same archive, pinned per platform as
 * `binaries[<dir>].codeModeHostSha256` and installed BESIDE `codex-app-server`.
 * Beside, because that is where codex looks for it:
 * `install-context/src/lib.rs` `code_mode_host_program` tries a package
 * `codex-resources/` dir, then a package `bin/` dir (both need a
 * `codex-package.json` beside them, which our flat layout has not), and
 * otherwise `current_exe().parent()` canonicalised joined with
 * `codex-code-mode-host[.exe]`. No env var or config key moves it, so the
 * spawn needs no change: the app-server finds its sibling by itself.
 * `codex-path/rg` and `codex-resources/zsh` stay out, for the reasons above.
 *
 * Usage:
 *   node scripts/fetch-codex.mjs                 # host platform
 *   node scripts/fetch-codex.mjs --all           # every target (default in CI)
 *   node scripts/fetch-codex.mjs --target=linux-x64
 *   node scripts/fetch-codex.mjs darwin-arm64    # bare arg = a single dir
 *   node scripts/fetch-codex.mjs --target=win32-x64 --windows-sandbox
 *   node scripts/fetch-codex.mjs --target=win32-x64 --windows-sandbox \
 *     --windows-sandbox-source=github     # the old path, kept for a bad day
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, copyFileSync, chmodSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST = join(ROOT, 'packages', 'codex-protocol', 'manifest.json');

/** upstream target → Nessy platform dir (00-context §Codex release). */
const CODEX_TARGETS = [
  { dir: 'darwin-arm64', target: 'aarch64-apple-darwin', exe: false, musl: false },
  { dir: 'darwin-x64', target: 'x86_64-apple-darwin', exe: false, musl: false },
  // Linux app builds are paused — re-enable these two lines when Linux support
  // ships (manifest + electron-builder linux includes come back with them).
  // { dir: 'linux-arm64', target: 'aarch64-unknown-linux-musl', exe: false, musl: true },
  // { dir: 'linux-x64', target: 'x86_64-unknown-linux-musl', exe: false, musl: true },
  { dir: 'win32-x64', target: 'x86_64-pc-windows-msvc', exe: true, musl: false },
];

function hostPlatformDir() {
  const arch = process.arch === 'arm64' ? 'arm64' : process.arch === 'x64' ? 'x64' : process.arch;
  return `${process.platform}-${arch}`;
}

function sha256(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex').toLowerCase();
}

function archiveName(target) {
  return `codex-app-server-package-${target}.tar.gz`;
}
function binaryName(exe) {
  return exe ? 'codex-app-server.exe' : 'codex-app-server';
}
/** F1.1216 — codex's own code-mode host, shipped beside the app-server (see the docblock). */
function codeModeHostName(exe) {
  return exe ? 'codex-code-mode-host.exe' : 'codex-code-mode-host';
}

const WINDOWS_SANDBOX_FILES = [
  ['bin/codex.exe', 'codex.exe'],
  ['codex-resources/codex-command-runner.exe', 'codex-command-runner.exe'],
  ['codex-resources/codex-windows-sandbox-setup.exe', 'codex-windows-sandbox-setup.exe'],
];

/** The npm package that carries the same trio, and where inside it they live. */
const WINDOWS_SANDBOX_NPM_PACKAGE = '@openai/codex';
const WINDOWS_SANDBOX_NPM_PREFIX = 'package/vendor/x86_64-pc-windows-msvc';

/**
 * The registry to read the Windows sandbox trio from.
 *
 * `NPM_CONFIG_REGISTRY` is what `.gitlab-ci.yml` sets for the whole pipeline
 * (`.../api/npm/npm-all/`), so honouring it is the entire point: the fetch then
 * uses the same mirror every other dependency comes from, and needs no egress
 * the pipeline does not already have. `npm_config_registry` is the spelling npm
 * itself exports to lifecycle scripts.
 */
function npmRegistryBase() {
  const raw =
    process.env.NPM_CONFIG_REGISTRY ||
    process.env.npm_config_registry ||
    'https://registry.npmjs.org/';
  return raw.endsWith('/') ? raw : `${raw}/`;
}

/**
 * D1.170 — the release-asset base, and the ONE lever that makes this build
 * Artifactory-only without another code change.
 *
 * ## The posture, stated because the row asked for it rather than for a fix
 *
 * Two different github.com downloads are confused by "the codex build needs
 * github", and only one of them is a lift regression:
 *
 *  - **`codex-app-server` — PERMANENT, not a regression.** No registry publishes
 *    it (see PROVENANCE above); every build of every platform at every tag takes
 *    it from a release asset. Nothing about a lift changes that.
 *  - **the Windows restricted-token sandbox trio — TIME-BOUNDED.** It normally
 *    comes from `@openai/codex@<version>-win32-x64` through this pipeline's own
 *    `NPM_CONFIG_REGISTRY`, and a freshly-lifted tag is simply not cached yet, so
 *    `--windows-sandbox-source=github` is the fallback for as long as the mirror
 *    lags. Read 2026-09-17, four days after the lift into `rust-v0.154.0`:
 *    `@openai/codex@0.154.0-win32-x64` does not resolve, `dist-tags.latest` is
 *    `0.153.0` (it was `0.150.1` on 2026-09-13, so the mirror IS refreshing and
 *    is one release behind), and `0.150.1-win32-x64` resolves as the positive
 *    control. **Do not depend on the error CODE**: that same absence was recorded
 *    as a 403 and reads as a 404 through `npm view` today. Depend on "it does not
 *    resolve".
 *
 * ## The lever, and what it does NOT move
 *
 * `CODEX_RELEASE_BASE_URL` points the release-asset fetch at a mirror — an
 * Artifactory generic repo holding the same assets — exactly as
 * `BUN_DOWNLOAD_BASE_URL` and `ELECTRON_MIRROR` do for the other downloads
 * `.gitlab-ci.yml` §Windows park lists. The layout is github's own tail, so a
 * mirror that copies `<tag>/<asset>` under one root needs no path translation:
 * the value is that root, and the tag is appended here. Unset, nothing changes.
 *
 * What MOVES when it is set is only the fetch-time ARCHIVE anchor — the release
 * `codex-package_SHA256SUMS` then comes from the mirror — which is the identical
 * move the npm sandbox path already documents. What does NOT move: the per-binary
 * `binarySha256` written into `manifest.json` and reviewed in the diff, and the
 * pre-spawn verification the RUNTIME performs against that committed file
 * (`codex-agent-server/src/manifest-verifier.ts`). A mirror cannot substitute
 * bytes without the manifest diff showing it.
 *
 * The override is PRINTED when it is used, because a supply-chain source that
 * changes silently is worse than one that is inconvenient.
 */
function releaseAssetBase(repo, tag) {
  const override = process.env.CODEX_RELEASE_BASE_URL?.trim();
  if (!override) return `https://github.com/${repo}/releases/download/${tag}`;
  const root = override.endsWith('/') ? override.slice(0, -1) : override;
  const base = `${root}/${tag}`;
  console.log(`[codex] CODEX_RELEASE_BASE_URL is set — release assets come from ${base}`);
  return base;
}

/** `rust-v0.150.1` → `0.150.1`. The npm version is `<that>-<platform>`. */
function upstreamVersionFromTag(tag) {
  const match = /^rust-v(\d+\.\d+\.\d+.*)$/.exec(tag);
  if (!match) throw new Error(`cannot derive an npm version from upstream tag "${tag}"`);
  return match[1];
}

function curlToFile(url, destination, extraArgs = []) {
  execFileSync('curl', ['-fsSL', '--retry', '3', '--retry-delay', '2', ...extraArgs, '-o', destination, url], {
    stdio: 'inherit',
  });
}

function sha1(filePath) {
  return createHash('sha1').update(readFileSync(filePath)).digest('hex').toLowerCase();
}

function sha512Base64(filePath) {
  return createHash('sha512').update(readFileSync(filePath)).digest('base64');
}

/**
 * Fetch the Windows sandbox trio from the configured npm registry.
 *
 * Two anchors are checked before a byte is extracted — the registry's published
 * digest for this exact version, and (once recorded) the manifest's own
 * `npm.tarballSha256`. Neither replaces the per-file `binarySha256` gate below;
 * they exist so a corrupted or substituted ARCHIVE is refused early and by name.
 */
function fetchWindowsSandboxFromNpm(spec, tmp, pinned, upstreamTag) {
  if (spec.dir !== 'win32-x64') throw new Error('Windows sandbox assets are currently published only for win32-x64');
  const version = `${upstreamVersionFromTag(upstreamTag)}-win32-x64`;
  const registry = npmRegistryBase();
  const packumentPath = join(tmp, 'codex-packument.json');
  console.log(`\n[${spec.dir}] reading ${WINDOWS_SANDBOX_NPM_PACKAGE}@${version} from ${registry}`);
  curlToFile(`${registry}${WINDOWS_SANDBOX_NPM_PACKAGE}`, packumentPath, ['-H', 'Accept: application/json']);
  const packument = JSON.parse(readFileSync(packumentPath, 'utf8'));
  const release = packument.versions?.[version];
  if (!release) {
    throw new Error(
      `[${spec.dir}] ${WINDOWS_SANDBOX_NPM_PACKAGE}@${version} is absent from ${registry}. ` +
        'Artifactory proxies lazily and answer 403 for uncached versions, so this is a reading with a ' +
        'timestamp, not proof the version does not exist — retry, or use --windows-sandbox-source=github.',
    );
  }
  const tarballUrl = release.dist?.tarball;
  if (!tarballUrl) throw new Error(`[${spec.dir}] ${version} has no dist.tarball in the packument`);

  const archivePath = join(tmp, `codex-${version}.tgz`);
  console.log(`  downloading ${tarballUrl}`);
  curlToFile(tarballUrl, archivePath);

  // Anchor 1 — the registry's own published digest for this version.
  const integrity = release.dist.integrity;
  if (integrity?.startsWith('sha512-')) {
    const actual = sha512Base64(archivePath);
    if (actual !== integrity.slice('sha512-'.length)) {
      throw new Error(`[${spec.dir}] tarball fails dist.integrity: got sha512-${actual}, expected ${integrity}`);
    }
    console.log('  dist.integrity verified ✓');
  }
  if (release.dist.shasum) {
    const actual = sha1(archivePath);
    if (actual !== release.dist.shasum.toLowerCase()) {
      throw new Error(`[${spec.dir}] tarball fails dist.shasum: got ${actual}, expected ${release.dist.shasum}`);
    }
    console.log('  dist.shasum verified ✓');
  }
  if (!integrity && !release.dist.shasum) {
    throw new Error(`[${spec.dir}] the packument publishes no digest for ${version} — refusing to extract`);
  }

  // Anchor 2 — our own recorded tarball sha, once a previous run wrote it.
  const tarballSha256 = sha256(archivePath);
  const pinnedTarball = pinned?.npm?.tarballSha256?.toLowerCase();
  if (pinnedTarball && pinnedTarball !== tarballSha256) {
    throw new Error(
      `[${spec.dir}] tarball SHA differs from the pinned manifest: got ${tarballSha256}, expected ${pinnedTarball}`,
    );
  }

  // Extract ONLY the three members; the package also carries a 288 MB TUI.
  const extractDir = join(tmp, `extract-windows-sandbox-npm-${spec.dir}`);
  mkdirSync(extractDir, { recursive: true });
  const members = WINDOWS_SANDBOX_FILES.map(([sourceName]) => `${WINDOWS_SANDBOX_NPM_PREFIX}/${sourceName}`);
  execFileSync('tar', ['-xzf', archivePath, '-C', extractDir, ...members], { stdio: 'inherit' });

  const targetDir = join(ROOT, 'apps', 'electron', 'resources', 'bin', 'codex', spec.dir);
  mkdirSync(targetDir, { recursive: true });
  const files = {};
  for (const [sourceName, targetName] of WINDOWS_SANDBOX_FILES) {
    const source = join(extractDir, ...`${WINDOWS_SANDBOX_NPM_PREFIX}/${sourceName}`.split('/'));
    if (!existsSync(source)) {
      throw new Error(`[${spec.dir}] ${sourceName} missing from ${WINDOWS_SANDBOX_NPM_PACKAGE}@${version}`);
    }
    const binarySha256 = sha256(source);
    const expectedSha256 = pinned?.files?.[targetName]?.binarySha256?.toLowerCase();
    if (!expectedSha256 || binarySha256 !== expectedSha256) {
      throw new Error(`[${spec.dir}] ${targetName} SHA mismatch vs pinned manifest: got ${binarySha256}, expected ${expectedSha256 ?? 'missing'}`);
    }
    const target = join(targetDir, targetName);
    copyFileSync(source, target);
    files[targetName] = { binarySha256 };
    console.log(`  installed → ${target} ✓`);
  }

  // The github pin is PRESERVED, not replaced: it is the provenance record for
  // where these bytes were first published, and `--windows-sandbox-source=github`
  // still reads it.
  return {
    ...pinned,
    files,
    npm: {
      // The URL is deliberately NOT recorded: it differs between the public
      // registry and an Artifactory mirror, and a manifest that changes with
      // the machine that ran the script is a manifest nobody can diff.
      package: WINDOWS_SANDBOX_NPM_PACKAGE,
      version,
      tarballSha256,
      ...(integrity ? { integrity } : {}),
    },
  };
}

/** Fetch the release SHA256SUMS once and return a map archive → sha. */
function loadReleaseSums(base, tmp) {
  const sumsPath = join(tmp, 'codex-package_SHA256SUMS');
  execFileSync('curl', ['-fsSL', '--retry', '3', '--retry-delay', '2', '-o', sumsPath, `${base}/codex-package_SHA256SUMS`], { stdio: 'inherit' });
  const map = new Map();
  for (const line of readFileSync(sumsPath, 'utf8').split('\n')) {
    const [sha, name] = line.trim().split(/\s+/);
    if (sha && name) map.set(name, sha.toLowerCase());
  }
  return map;
}

/** Fetch+verify+extract one target; returns its manifest entry. */
function fetchTarget(spec, base, sums, tmp) {
  const archive = archiveName(spec.target);
  const releaseSha = sums.get(archive);
  if (!releaseSha) throw new Error(`${archive} not present in codex-package_SHA256SUMS`);

  const archivePath = join(tmp, archive);
  console.log(`\n[${spec.dir}] downloading ${archive}...`);
  execFileSync('curl', ['-fsSL', '--retry', '3', '--retry-delay', '2', '-o', archivePath, `${base}/${archive}`], { stdio: 'inherit' });

  const archiveSha = sha256(archivePath);
  if (archiveSha !== releaseSha) {
    throw new Error(`[${spec.dir}] archive SHA mismatch vs SHA256SUMS: got ${archiveSha}, expected ${releaseSha}`);
  }
  console.log(`  archive SHA verified vs SHA256SUMS ✓`);

  const extractDir = join(tmp, `extract-${spec.dir}`);
  mkdirSync(extractDir, { recursive: true });
  execFileSync('tar', ['-xzf', archivePath, '-C', extractDir], { stdio: 'inherit' });
  const extractedBin = join(extractDir, 'bin', binaryName(spec.exe));
  if (!existsSync(extractedBin)) {
    throw new Error(`[${spec.dir}] ${binaryName(spec.exe)} not found at bin/ inside ${archive}`);
  }
  const binarySha256 = sha256(extractedBin);
  const extractedHost = join(extractDir, 'bin', codeModeHostName(spec.exe));
  if (!existsSync(extractedHost)) {
    throw new Error(`[${spec.dir}] ${codeModeHostName(spec.exe)} not found at bin/ inside ${archive}`);
  }
  const codeModeHostSha256 = sha256(extractedHost);

  // Optional sigstore provenance (musl only). Record presence; cryptographic
  // verification is DEFER-TO-REVIEW (needs cosign/policy the reviewer owns).
  let sigstore = false;
  if (spec.musl) {
    const sigPath = join(tmp, `${archive}.sigstore`);
    try {
      execFileSync('curl', ['-fsSL', '--retry', '2', '-o', sigPath, `${base}/${archive}.sigstore`], { stdio: 'pipe' });
      sigstore = existsSync(sigPath) && statSync(sigPath).size > 0;
    } catch {
      sigstore = false; // no sigstore asset — not a failure
    }
    console.log(`  sigstore asset: ${sigstore ? 'present' : 'absent'}`);
  }

  // Install.
  const targetDir = join(ROOT, 'apps', 'electron', 'resources', 'bin', 'codex', spec.dir);
  mkdirSync(targetDir, { recursive: true });
  const targetBin = join(targetDir, binaryName(spec.exe));
  copyFileSync(extractedBin, targetBin);
  if (!spec.exe) chmodSync(targetBin, 0o755);
  console.log(`  installed → ${targetBin} ✓`);
  const targetHost = join(targetDir, codeModeHostName(spec.exe));
  copyFileSync(extractedHost, targetHost);
  if (!spec.exe) chmodSync(targetHost, 0o755);
  console.log(`  installed → ${targetHost} ✓`);

  return {
    target: spec.target,
    archive,
    archiveSha256: archiveSha,
    binarySha256,
    codeModeHostSha256,
    ...(spec.musl ? { sigstore } : {}),
  };
}

/** Fetch the pinned official Windows package and install only sandbox assets. */
function fetchWindowsSandboxTarget(spec, base, sums, tmp, pinned) {
  if (spec.dir !== 'win32-x64') throw new Error('Windows sandbox assets are currently published only for win32-x64');
  const archive = `codex-package-${spec.target}.tar.gz`;
  const releaseSha = sums.get(archive);
  if (!releaseSha) throw new Error(`${archive} not present in codex-package_SHA256SUMS`);
  if (pinned?.target !== spec.target || pinned?.archive !== archive || !pinned?.archiveSha256) {
    throw new Error(`[${spec.dir}] Windows sandbox manifest pin is missing or inconsistent`);
  }
  if (releaseSha !== pinned.archiveSha256.toLowerCase()) {
    throw new Error(`[${spec.dir}] release SHA differs from pinned manifest: got ${releaseSha}, expected ${pinned.archiveSha256}`);
  }

  const archivePath = join(tmp, archive);
  console.log(`\n[${spec.dir}] downloading ${archive} for restricted-token sandbox...`);
  execFileSync('curl', ['-fsSL', '--retry', '3', '--retry-delay', '2', '-o', archivePath, `${base}/${archive}`], { stdio: 'inherit' });
  const archiveSha = sha256(archivePath);
  if (archiveSha !== pinned.archiveSha256.toLowerCase()) {
    throw new Error(`[${spec.dir}] archive SHA mismatch vs pinned manifest: got ${archiveSha}, expected ${pinned.archiveSha256}`);
  }

  const extractDir = join(tmp, `extract-windows-sandbox-${spec.dir}`);
  mkdirSync(extractDir, { recursive: true });
  execFileSync('tar', ['-xzf', archivePath, '-C', extractDir], { stdio: 'inherit' });
  const targetDir = join(ROOT, 'apps', 'electron', 'resources', 'bin', 'codex', spec.dir);
  mkdirSync(targetDir, { recursive: true });
  const files = {};
  for (const [sourceName, targetName] of WINDOWS_SANDBOX_FILES) {
    const source = join(extractDir, ...sourceName.split('/'));
    if (!existsSync(source)) throw new Error(`[${spec.dir}] ${sourceName} missing from ${archive}`);
    const binarySha256 = sha256(source);
    const expectedSha256 = pinned.files?.[targetName]?.binarySha256?.toLowerCase();
    if (!expectedSha256 || binarySha256 !== expectedSha256) {
      throw new Error(`[${spec.dir}] ${targetName} SHA mismatch vs pinned manifest: got ${binarySha256}, expected ${expectedSha256 ?? 'missing'}`);
    }
    const target = join(targetDir, targetName);
    copyFileSync(source, target);
    files[targetName] = { binarySha256 };
    console.log(`  installed → ${target} ✓`);
  }
  return { target: spec.target, archive, archiveSha256: archiveSha, files };
}

function windowsSandboxAssetsCurrent(spec, manifest) {
  const entry = manifest.windowsSandbox?.[spec.dir];
  if (!entry?.files) return false;
  const targetDir = join(ROOT, 'apps', 'electron', 'resources', 'bin', 'codex', spec.dir);
  return WINDOWS_SANDBOX_FILES.every(([, name]) => {
    const path = join(targetDir, name);
    const expected = entry.files[name]?.binarySha256;
    return existsSync(path) && expected && sha256(path) === expected.toLowerCase();
  });
}

async function main() {
  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
  const { tag, repo } = manifest.upstream;
  const base = releaseAssetBase(repo, tag);

  const argv = process.argv.slice(2);
  const all = argv.includes('--all');
  const windowsSandbox = argv.includes('--windows-sandbox');
  const windowsSandboxSource =
    argv.find((a) => a.startsWith('--windows-sandbox-source='))?.split('=')[1] ?? 'npm';
  if (windowsSandbox && windowsSandboxSource !== 'npm' && windowsSandboxSource !== 'github') {
    throw new Error(`--windows-sandbox-source must be "npm" or "github", got "${windowsSandboxSource}"`);
  }
  const targetArg = argv.find((a) => a.startsWith('--target='))?.split('=')[1] ?? argv.find((a) => !a.startsWith('--'));
  const dir = targetArg ?? hostPlatformDir();

  let specs;
  if (all) specs = CODEX_TARGETS;
  else {
    const spec = CODEX_TARGETS.find((s) => s.dir === dir);
    if (!spec) throw new Error(`Unknown platform dir "${dir}". Known: ${CODEX_TARGETS.map((s) => s.dir).join(', ')}`);
    specs = [spec];
  }
  if (windowsSandbox) specs = specs.filter(spec => spec.dir === 'win32-x64');
  if (specs.length === 0) throw new Error('Windows sandbox fetch requires the win32-x64 target');

  const tmp = join(ROOT, '.codex-download-temp');
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  try {
    // The release sums are a github.com download. The npm sandbox path exists to
    // remove exactly that, so it must not be fetched when nothing needs it —
    // otherwise the switch buys a CI fleet with no github egress nothing at all.
    const needsReleaseSums = !(windowsSandbox && windowsSandboxSource === 'npm');
    const sums = needsReleaseSums ? loadReleaseSums(base, tmp) : null;
    manifest.binaries = manifest.binaries ?? {};
    manifest.windowsSandbox = manifest.windowsSandbox ?? {};
    for (const spec of specs) {
      if (windowsSandbox) {
        if (windowsSandboxAssetsCurrent(spec, manifest)) {
          console.log(`[${spec.dir}] Windows sandbox assets already present + verified — skipping`);
          continue;
        }
        manifest.windowsSandbox[spec.dir] =
          windowsSandboxSource === 'npm'
            ? fetchWindowsSandboxFromNpm(spec, tmp, manifest.windowsSandbox[spec.dir], tag)
            : fetchWindowsSandboxTarget(spec, base, sums, tmp, manifest.windowsSandbox[spec.dir]);
        continue;
      }
      // Idempotent skip: binary present + matches the manifest's recorded sha
      // AND that record belongs to the tag `upstream.tag` currently pins.
      //
      // The sha check ALONE cannot see a tag bump, and that is not theoretical:
      // measured 2026-09-11 on the lift into `rust-v0.150.1` from the tag before
      // it, an `--all` run straight after `upstream.tag` moved printed "already
      // present + verified" for all three targets, refetched nothing, and left
      // the PREVIOUS release's binaries on disk under the new tag's manifest —
      // a pin that says one thing and ships another, which is the one state a
      // supply-chain pin exists to prevent. The release sums for the pinned tag
      // are already loaded above, so tying the skip to them costs nothing.
      const targetBin = join(ROOT, 'apps', 'electron', 'resources', 'bin', 'codex', spec.dir, binaryName(spec.exe));
      const targetHost = join(dirname(targetBin), codeModeHostName(spec.exe));
      const known = manifest.binaries[spec.dir];
      const releaseArchiveSha = sums?.get(archiveName(spec.target));
      const recordIsForPinnedTag =
        !!known?.archiveSha256 && !!releaseArchiveSha && known.archiveSha256.toLowerCase() === releaseArchiveSha;
      if (
        existsSync(targetBin) &&
        known?.binarySha256 &&
        sha256(targetBin) === known.binarySha256.toLowerCase() &&
        // F1.1216 — a tree fetched before the host was extracted must refetch.
        existsSync(targetHost) &&
        known?.codeModeHostSha256 &&
        sha256(targetHost) === known.codeModeHostSha256.toLowerCase() &&
        recordIsForPinnedTag
      ) {
        console.log(`[${spec.dir}] already present + verified — skipping`);
        continue;
      }
      manifest.binaries[spec.dir] = fetchTarget(spec, base, sums, tmp);
    }
    // Write the manifest back with a stable key order.
    const ordered = {};
    for (const s of CODEX_TARGETS) if (manifest.binaries[s.dir]) ordered[s.dir] = manifest.binaries[s.dir];
    manifest.binaries = ordered;
    const orderedWindowsSandbox = {};
    for (const s of CODEX_TARGETS) {
      if (manifest.windowsSandbox[s.dir]) orderedWindowsSandbox[s.dir] = manifest.windowsSandbox[s.dir];
    }
    manifest.windowsSandbox = orderedWindowsSandbox;
    writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
    console.log(`\nmanifest updated: ${Object.keys(manifest.binaries).join(', ')}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
