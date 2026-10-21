/**
 * `plugin-relevance.md` § `relevance.signals`, the `manifestDeps` row, fetched
 * 2026-09-06 — "Manifest files larger than 512 KB are skipped."
 *
 * The set collected here is the session PROJECT's manifests rather than the
 * page's "manifests Claude has read this session"; the divergence and its reason
 * are stated in `relevance-manifests.ts`.
 */
import { afterAll, describe, expect, it } from 'bun:test';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { collectRelevanceManifests } from '../relevance-manifests.ts';
import { MANIFEST_CONTENT_MAX, parseMarketplaceRelevance } from '../relevance.ts';

const roots: string[] = [];

async function project(files: Record<string, string>): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'relevance-manifests-'));
  roots.push(root);
  for (const [name, content] of Object.entries(files)) {
    await fs.writeFile(path.join(root, name), content, 'utf8');
  }
  return root;
}

afterAll(async () => {
  await Promise.all(roots.map(root => fs.rm(root, { recursive: true, force: true })));
});

const packageJson = parseMarketplaceRelevance({
  signals: { manifestDeps: [{ file: '[/\\\\]package\\.json$', pattern: '"stripe"\\s*:' }] },
});

describe('collectRelevanceManifests', () => {
  it('reads only the files an entry\'s own `file` pattern selects', async () => {
    const root = await project({
      'package.json': '{"dependencies":{"stripe":"^1"}}',
      'Cargo.toml': 'stripe = "1"',
    });
    const collected = await collectRelevanceManifests([packageJson], { workingDirectory: root });
    expect(collected.map(file => path.basename(file.path))).toEqual(['package.json']);
    expect(collected[0]?.content).toContain('stripe');
  });

  it('collects nothing without a manifestDeps entry, a directory, or a small enough file', async () => {
    const root = await project({ 'package.json': '{}' });
    // No `manifestDeps` anywhere: no directory is even read.
    const cwdOnly = parseMarketplaceRelevance({ signals: { cwd: ['x'] } });
    expect(await collectRelevanceManifests([cwdOnly, undefined], { workingDirectory: root })).toEqual([]);
    // A directory that does not exist is an empty answer, never a throw.
    expect(await collectRelevanceManifests([packageJson], {
      workingDirectory: path.join(root, 'missing'),
    })).toEqual([]);
    // "Manifest files larger than 512 KB are skipped."
    const oversized = await project({ 'package.json': ' '.repeat(MANIFEST_CONTENT_MAX + 1) });
    expect(await collectRelevanceManifests([packageJson], { workingDirectory: oversized })).toEqual([]);
  });
});
