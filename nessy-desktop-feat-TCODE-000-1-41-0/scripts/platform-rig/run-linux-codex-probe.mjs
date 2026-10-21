#!/usr/bin/env node
/**
 * The LINUX half of the platform rig, second instrument: drive the real
 * `codex-app-server` on Linux against the profile shapes our mirror emits.
 *
 *     node scripts/platform-rig/run-linux-codex-probe.mjs
 *     node scripts/platform-rig/run-linux-codex-probe.mjs --json
 *
 * Exit 0 when every arm answered, 2 when the rig could not run (no daemon, no
 * egress for the one-time download, a control that did not behave).
 *
 * ## Why (P3.183, P3.62; owner decision 2026-09-02 §A4+§A6)
 *
 * Every end-to-end codex measurement on this plan ran on darwin. The two claims
 * that most needed another platform were read from `rust-v0.148.0`'s source and
 * never driven:
 *
 * - a filesystem-ROOT-anchored deny glob (`/**` followed by `/.env`) is FATAL to
 *   Linux sandbox construction;
 * - the `":workspace_roots"` spelling P3.175 chose instead is portable.
 *
 * Both are now measured here. What the source reading did NOT predict, and what
 * makes this worth keeping rather than doing once:
 *
 * - the root-anchored profile is **accepted** by `permissionProfile/list`
 *   (`allowed: true`), so the in-band signal the darwin detector keys on stays
 *   silent; the failure appears only as EVERY sandboxed exec dying with
 *   `error building bubblewrap command: Fatal error: unreadable glob ...`;
 * - Linux logs an ERROR for **every** `**` deny glob — *"Non-macOS sandboxing
 *   does not support unbounded `**` natively; set `glob_scan_max_depth`"* —
 *   including the workspace-scoped one that works. `glob_scan_max_depth` is
 *   deliberately not written (see `config-writer-permissions.ts`); on darwin
 *   that decision is silent and on Linux it is an operator-visible ERROR line;
 * - a denied read presents DIFFERENTLY per platform. darwin's seatbelt answers
 *   `Operation not permitted`; Linux returns **exit 0 with empty stdout**. A host
 *   that recognises a denial by its error text would read Linux as a success.
 *
 * ## Safety
 *
 * The archive is pinned by `packages/codex-protocol/manifest.json` `upstream.tag`
 * and verified against the release `codex-package_SHA256SUMS` before anything is
 * extracted or run. The binary then runs inside `docker run --rm --network none`
 * against a workspace the container builds; the only host path is a READ-ONLY
 * mount of the cache directory this script downloaded into.
 */
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MANIFEST = join(ROOT, 'packages', 'codex-protocol', 'manifest.json');
/**
 * Deliberately OUTSIDE the repo: this holds a ~95 MB archive, and a repo-local
 * cache would need a `.gitignore` line — a shared file, which is exactly the
 * kind of incidental edit that sweeps a neighbour's work in a parallel wave.
 * Override with `NESSY_RIG_CODEX_CACHE` to keep it between reboots.
 */
const CACHE = process.env.NESSY_RIG_CODEX_CACHE ?? join(tmpdir(), 'nessy-platform-rig-cache');
/** A node image so the JSON-RPC driver can run beside the binary. */
const IMAGE = process.env.NESSY_RIG_NODE_IMAGE ?? 'node:22-bookworm-slim';

/** Host arch → the upstream musl target to drive. */
const LINUX_TARGET = process.arch === 'arm64'
  ? 'aarch64-unknown-linux-musl'
  : 'x86_64-unknown-linux-musl';

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex').toLowerCase();
}

function fail(message) {
  console.error(`platform-rig/codex-linux: RIG UNAVAILABLE — ${message}`);
  process.exit(2);
}

function ensureArchive() {
  const { tag, repo } = JSON.parse(readFileSync(MANIFEST, 'utf8')).upstream;
  const base = `https://github.com/${repo}/releases/download/${tag}`;
  const archive = `codex-app-server-package-${LINUX_TARGET}.tar.gz`;
  mkdirSync(CACHE, { recursive: true });
  const sumsPath = join(CACHE, `${tag}-codex-package_SHA256SUMS`);
  const archivePath = join(CACHE, `${tag}-${archive}`);
  try {
    if (!existsSync(sumsPath)) {
      execFileSync('curl', ['-fsSL', '--retry', '3', '-o', sumsPath, `${base}/codex-package_SHA256SUMS`]);
    }
    if (!existsSync(archivePath)) {
      console.error(`[rig] downloading ${archive} (~95 MB, once) ...`);
      execFileSync('curl', ['-fsSL', '--retry', '3', '-o', archivePath, `${base}/${archive}`]);
    }
  } catch (error) {
    fail(`could not fetch the pinned codex release: ${error.message ?? error}`);
  }
  const expected = readFileSync(sumsPath, 'utf8')
    .split('\n')
    .map((line) => line.trim().split(/\s+/))
    .find(([, name]) => name === archive)?.[0]
    ?.toLowerCase();
  if (!expected) fail(`${archive} is not listed in ${tag}'s codex-package_SHA256SUMS`);
  const actual = sha256(archivePath);
  // Refuse BEFORE extraction: an unverified archive is never opened, let alone run.
  if (actual !== expected) fail(`archive SHA mismatch: got ${actual}, expected ${expected}`);
  return { tag, archivePath, archive };
}

/**
 * The four config.toml arms. `PROFILE_HEAD` mirrors
 * `buildCodexPermissionsTomlLines` — including the top-level
 * `default_permissions` scalar, whose omission makes the binary answer
 * *"config defines `[permissions]` profiles but does not set
 * `default_permissions`"* on STDERR ONLY and fall back to defaults. That is a
 * fail-open that reads as a clean run, and it cost this rig one whole pass.
 */
const PROFILE_HEAD = `model = "gpt-5"
default_permissions = "nessy_runtime"

[permissions.nessy_runtime]
description = "Nessy runtime with managed plugin data and host credentials policy"
extends = ":workspace"
`;
const ARMS = [
  { name: 'no-profile', toml: 'model = "gpt-5"\n', role: 'control — the decoy must leak' },
  {
    name: 'unrelated-deny',
    toml: `${PROFILE_HEAD}\n[permissions.nessy_runtime.filesystem]\n\n[permissions.nessy_runtime.filesystem.":workspace_roots"]\n"**/nothing-here.txt" = "deny"\n`,
    role: 'control — a profile that denies something else must still leak',
  },
  {
    name: 'root-anchored',
    toml: `${PROFILE_HEAD}\n[permissions.nessy_runtime.filesystem]\n"/**/.env" = "deny"\n`,
    role: 'the spelling the source calls FATAL on Linux',
  },
  {
    name: 'workspace-scoped',
    toml: `${PROFILE_HEAD}\n[permissions.nessy_runtime.filesystem]\n\n[permissions.nessy_runtime.filesystem.":workspace_roots"]\n"**/.env" = "deny"\n`,
    role: "P3.175's portable spelling",
  },
];

function main() {
  if (spawnSync('docker', ['version', '--format', '{{.Server.Version}}'], { encoding: 'utf8' }).status !== 0) {
    fail('no reachable container runtime (`docker version` failed)');
  }
  const { tag, archivePath, archive } = ensureArchive();
  writeFileSync(join(CACHE, 'arms.json'), JSON.stringify(ARMS), 'utf8');
  writeFileSync(join(CACHE, 'driver.mjs'), readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'linux-codex-driver.mjs')));

  const script = [
    'set -e',
    'mkdir -p /work && cd /work',
    `tar -xzf /in/${JSON.stringify(`${tag}-${archive}`).slice(1, -1)} -C /work`,
    'chmod +x /work/bin/* /work/codex-resources/* /work/codex-path/* 2>/dev/null || true',
    '/work/bin/codex-app-server --version',
    'node /in/driver.mjs',
  ].join('\n');

  const result = spawnSync(
    'docker',
    ['run', '--rm', '-i', '--network', 'none', '--security-opt', 'seccomp=unconfined',
      '-v', `${CACHE}:/in:ro`, IMAGE, 'sh', '-s'],
    { input: script, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
  );
  if (result.status !== 0) fail(`container run failed (exit ${result.status}): ${result.stderr.trim()}`);

  const start = result.stdout.indexOf('[');
  let rows;
  try {
    rows = JSON.parse(result.stdout.slice(start));
  } catch {
    fail(`driver produced no parseable result:\n${result.stdout.slice(-2000)}`);
  }

  const control = rows.find((row) => row.arm === 'no-profile');
  if (!control || control.envRead?.stdout?.includes('decoy') !== true) {
    fail('the no-profile control did not leak the decoy — nothing below can be read as a denial');
  }

  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ tag, image: IMAGE, target: LINUX_TARGET, rows }, null, 2));
    return 0;
  }
  console.log(`platform-rig/codex-linux — ${tag} ${LINUX_TARGET} in ${IMAGE}`);
  console.log(`${'arm'.padEnd(18)}${'profile'.padEnd(12)}${'cat .env'.padEnd(34)}cat plain.txt`);
  for (const row of rows) {
    const shape = (read) =>
      read === 'timeout' ? 'TIMEOUT' : `exit ${read.exit} ${read.stdout ? `"${read.stdout}"` : (read.stderr ? `err:${read.stderr.slice(0, 40)}` : '<empty>')}`;
    console.log(
      row.arm.padEnd(18) +
        String(row.profileListed?.allowed ?? row.profileListed).padEnd(12) +
        shape(row.envRead).padEnd(34) +
        shape(row.plainRead),
    );
  }
  console.log('\nstderr, first line per arm:');
  for (const row of rows) {
    const first = (row.stderrFirst ?? []).map((line) => line.replace(/\[[0-9;]*m/g, ''))
      .find((line) => !line.includes('bubblewrap on PATH'));
    console.log(`  ${row.arm.padEnd(18)}${first ? first.slice(0, 150) : '(none beyond the bundled-bwrap notice)'}`);
  }
  return 0;
}

process.exit(main());
