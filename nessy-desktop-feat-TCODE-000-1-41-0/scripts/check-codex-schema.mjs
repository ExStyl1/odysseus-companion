#!/usr/bin/env node
/**
 * Schema-drift gate: the committed `packages/codex-protocol/generated` (+ the
 * protocol `schema/`) MUST match what the pinned codex binary generates. This
 * fetches the FULL `codex` binary for the runner arch (spike outcome: the
 * standalone `codex-app-server` has NO subcommands — the generators live in the
 * full `codex` binary: `codex app-server generate-ts` / `generate-json-schema`),
 * regenerates into a temp dir, and diffs against the committed files. Any diff →
 * non-zero exit with the diff printed.
 *
 * Runs on darwin-arm64 (offline dev) and the Linux CI runner. Pinned tag from
 * `packages/codex-protocol/manifest.json`. `schema/config-schema.json` is a
 * separate release asset (not generate-json-schema output) → excluded from the
 * schema diff.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PROTOCOL = join(ROOT, 'packages', 'codex-protocol');

/** platform dir → FULL codex release tarball (NOT the app-server package). */
const FULL_CODEX = {
  'darwin-arm64': { archive: 'codex-aarch64-apple-darwin.tar.gz', bin: 'codex-aarch64-apple-darwin' },
  'darwin-x64': { archive: 'codex-x86_64-apple-darwin.tar.gz', bin: 'codex-x86_64-apple-darwin' },
  'linux-arm64': { archive: 'codex-aarch64-unknown-linux-musl.tar.gz', bin: 'codex-aarch64-unknown-linux-musl' },
  'linux-x64': { archive: 'codex-x86_64-unknown-linux-musl.tar.gz', bin: 'codex-x86_64-unknown-linux-musl' },
};

function hostDir() {
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  return `${process.platform}-${arch}`;
}

/** Deep-sort object keys so non-deterministic serde/schemars ordering isn't drift. */
function sortDeep(x) {
  if (Array.isArray(x)) return x.map(sortDeep);
  if (x && typeof x === 'object') {
    const r = {};
    for (const k of Object.keys(x).sort()) r[k] = sortDeep(x[k]);
    return r;
  }
  return x;
}

function listFilesRel(root) {
  const out = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.push(relative(root, p));
    }
  };
  if (existsSync(root)) walk(root);
  return out.sort();
}

/**
 * Compare committed vs freshly generated dirs. `.json` files compare
 * deep-sorted (ordering-insensitive — schemars HashMap output is
 * non-deterministic); everything else (`.ts`) compares byte-for-byte. Returns
 * the list of drifting/missing/extra relative paths. `exclude` skips names.
 */
function compareDirs(committed, fresh, exclude = new Set()) {
  const drift = [];
  const all = new Set([...listFilesRel(committed), ...listFilesRel(fresh)]);
  for (const rel of [...all].sort()) {
    if (exclude.has(rel.split('/').pop())) continue;
    const a = join(committed, rel);
    const b = join(fresh, rel);
    if (!existsSync(a)) { drift.push(`+ ${rel} (generated, not committed)`); continue; }
    if (!existsSync(b)) { drift.push(`- ${rel} (committed, not generated)`); continue; }
    if (rel.endsWith('.json')) {
      const na = JSON.stringify(sortDeep(JSON.parse(readFileSync(a, 'utf8'))));
      const nb = JSON.stringify(sortDeep(JSON.parse(readFileSync(b, 'utf8'))));
      if (na !== nb) drift.push(`~ ${rel} (json content differs)`);
    } else {
      if (readFileSync(a, 'utf8') !== readFileSync(b, 'utf8')) drift.push(`~ ${rel} (content differs)`);
    }
  }
  return drift;
}

function main() {
  const manifest = JSON.parse(readFileSync(join(PROTOCOL, 'manifest.json'), 'utf8'));
  const { tag, repo } = manifest.upstream;
  const dir = process.argv[2] ?? hostDir();
  const spec = FULL_CODEX[dir];
  if (!spec) throw new Error(`No full-codex mapping for "${dir}" (schema gen needs a darwin/linux runner)`);

  const tmp = join(ROOT, '.codex-schema-check');
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  try {
    const base = `https://github.com/${repo}/releases/download/${tag}`;
    const archivePath = join(tmp, spec.archive);
    console.log(`Fetching full codex binary ${spec.archive} (${tag})...`);
    execFileSync('curl', ['-fsSL', '--retry', '3', '-o', archivePath, `${base}/${spec.archive}`], { stdio: 'inherit' });
    execFileSync('tar', ['-xzf', archivePath, '-C', tmp], { stdio: 'inherit' });
    const codexBin = join(tmp, spec.bin);
    if (!existsSync(codexBin)) throw new Error(`full codex binary not found at ${spec.bin} inside ${spec.archive}`);
    execFileSync('chmod', ['+x', codexBin]);

    const genTs = join(tmp, 'generated');
    const genSchema = join(tmp, 'schema');
    console.log('Regenerating protocol bindings...');
    execFileSync(codexBin, ['app-server', 'generate-ts', '--out', genTs], { stdio: 'inherit' });
    execFileSync(codexBin, ['app-server', 'generate-json-schema', '--out', genSchema], { stdio: 'inherit' });

    // Compare generated TS (byte) + protocol schema (JSON deep-sorted; the
    // release-asset config-schema.json is not generate-json-schema output).
    const drift = [
      ...compareDirs(join(PROTOCOL, 'generated'), genTs),
      ...compareDirs(join(PROTOCOL, 'schema'), genSchema, new Set(['config-schema.json'])),
    ];

    if (drift.length > 0) {
      console.error('\n❌ codex-protocol drift vs the pinned binary:');
      for (const d of drift) console.error(`  ${d}`);
      console.error('Regenerate from the pinned binary and commit.');
      process.exit(1);
    }
    console.log('\n✓ codex-protocol matches the pinned binary (no drift).');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

main();
