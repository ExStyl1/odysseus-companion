#!/usr/bin/env bun
/**
 * Audit `PRE_RECEIPT_SHIPPED_HASHES` in `packages/shared/src/skills/seed.ts`.
 *
 * That table is the one-time bootstrap that lets P2.281's refresh recognise an
 * already-seeded profile as PRISTINE: it holds `hashSkillDir` of every bundled
 * skill revision this repository shipped BEFORE the seed receipt existed. A
 * wrong or invented entry has two failure modes and they are not symmetric —
 * a MISSING hash silently keeps a stale skill in the field forever, and a
 * FOREIGN hash would overwrite whatever content happens to match it. So the
 * table has to be recomputable from the repository's own history, not trusted.
 *
 *   bun scripts/check-bundled-skill-seed-history.ts            # print every revision
 *   bun scripts/check-bundled-skill-seed-history.ts --check    # audit, exit 1 on drift
 *
 * `--check` asserts one direction only: every hash in the table is a real
 * historical revision of that slug. It deliberately does NOT require the
 * reverse. The table is CLOSED — a revision shipped after P2.281 is covered by
 * the receipt each write leaves behind, so a newer revision missing from the
 * table is correct, and adding it would be the mistake.
 *
 * Needs full history. In a shallow clone (`git log` cannot reach the older
 * commits) the audit reports what it could not see and exits 0 rather than
 * failing on a fact it was unable to check.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashSkillDir, PRE_RECEIPT_SHIPPED_HASHES } from '../packages/shared/src/skills/seed.ts';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BUNDLE_PREFIX = 'apps/electron/resources/skills';

function git(args: string[]): string {
  return execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 });
}

/** Every commit that touched the slug's directory, oldest first. */
function commitsFor(slug: string): string[] {
  try {
    return git(['log', '--all', '--reverse', '--format=%H', '--', `${BUNDLE_PREFIX}/${slug}`])
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

/** Materialize the slug's directory at one commit and hash it. */
function hashAt(slug: string, commit: string, scratch: string): string | undefined {
  let listing: string;
  try {
    listing = git(['ls-tree', '-r', '--name-only', commit, '--', `${BUNDLE_PREFIX}/${slug}`]);
  } catch {
    return undefined;
  }
  const paths = listing.split('\n').map(line => line.trim()).filter(Boolean);
  if (paths.length === 0) return undefined;
  const target = join(scratch, `${slug}-${commit.slice(0, 12)}`);
  for (const path of paths) {
    const relative = path.slice(`${BUNDLE_PREFIX}/${slug}/`.length);
    if (!relative) continue;
    const destination = join(target, relative);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, execFileSync('git', ['cat-file', 'blob', `${commit}:${path}`], {
      cwd: REPO_ROOT,
      maxBuffer: 64 * 1024 * 1024,
    }));
  }
  return hashSkillDir(target);
}

const check = process.argv.includes('--check');
const scratch = mkdtempSync(join(tmpdir(), 'bundled-skill-history-'));
let problems = 0;
let unreachable = 0;

try {
  for (const [slug, tabled] of Object.entries(PRE_RECEIPT_SHIPPED_HASHES)) {
    const commits = commitsFor(slug);
    if (commits.length === 0) {
      unreachable += 1;
      console.log(`${slug}: no history reachable (shallow clone?) — ${tabled.length} tabled hash(es) unchecked`);
      continue;
    }
    const seen = new Map<string, string[]>();
    for (const commit of commits) {
      const hash = hashAt(slug, commit, scratch);
      if (!hash) continue;
      const commitsForHash = seen.get(hash) ?? [];
      commitsForHash.push(commit.slice(0, 9));
      seen.set(hash, commitsForHash);
    }
    if (!check) {
      console.log(`\n${slug}`);
      for (const [hash, where] of seen) {
        const mark = tabled.includes(hash) ? 'tabled' : 'not tabled';
        console.log(`  ${hash}  ${where.join(', ')}  [${mark}]`);
      }
    }
    for (const hash of tabled) {
      if (seen.has(hash)) continue;
      problems += 1;
      console.error(`FAIL ${slug}: tabled hash ${hash} matches no revision in this repository's history`);
    }
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

if (check) {
  if (problems > 0) {
    console.error(`\n${problems} tabled hash(es) could not be traced to a shipped revision.`);
    process.exit(1);
  }
  console.log(`PRE_RECEIPT_SHIPPED_HASHES: every tabled hash traced to a shipped revision${
    unreachable > 0 ? ` (${unreachable} slug(s) unreachable in this clone)` : ''
  }.`);
}
