import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { chmodSync, cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { computeNormalizedBundleHash } from '../bundle-hash.ts';

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'plugin-bundle-hash-'));
});

afterEach(() => {
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
});

function buildBundle(root: string): void {
  mkdirSync(join(root, 'skills', 'review'), { recursive: true });
  mkdirSync(join(root, 'hooks'), { recursive: true });
  mkdirSync(join(root, 'assets'), { recursive: true });
  writeFileSync(join(root, 'plugin.json'), JSON.stringify({ id: 'toolkit', version: '1.0.0' }));
  writeFileSync(join(root, 'skills', 'review', 'SKILL.md'), '# Review skill');
  writeFileSync(join(root, 'hooks', 'pre.sh'), '#!/bin/sh\necho hi\n');
  writeFileSync(join(root, 'assets', 'icon.svg'), '<svg></svg>');
}

describe('computeNormalizedBundleHash', () => {
  it('produces a 64-char lowercase hex digest', async () => {
    const root = join(tempDir, 'bundle');
    buildBundle(root);
    const hash = await computeNormalizedBundleHash(root);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('is identical for byte-identical trees at different absolute paths (portable)', async () => {
    const a = join(tempDir, 'a');
    const b = join(tempDir, 'b');
    buildBundle(a);
    cpSync(a, b, { recursive: true });
    expect(await computeNormalizedBundleHash(a)).toBe(await computeNormalizedBundleHash(b));
  });

  it('changes when a skill, hook, asset or executable bit changes', async () => {
    const base = join(tempDir, 'base');
    buildBundle(base);
    const baseline = await computeNormalizedBundleHash(base);

    const skillMut = join(tempDir, 'skill-mut');
    buildBundle(skillMut);
    writeFileSync(join(skillMut, 'skills', 'review', 'SKILL.md'), '# Review skill (changed)');
    expect(await computeNormalizedBundleHash(skillMut)).not.toBe(baseline);

    const hookMut = join(tempDir, 'hook-mut');
    buildBundle(hookMut);
    writeFileSync(join(hookMut, 'hooks', 'pre.sh'), '#!/bin/sh\necho changed\n');
    expect(await computeNormalizedBundleHash(hookMut)).not.toBe(baseline);

    const assetMut = join(tempDir, 'asset-mut');
    buildBundle(assetMut);
    writeFileSync(join(assetMut, 'assets', 'icon.svg'), '<svg><rect/></svg>');
    expect(await computeNormalizedBundleHash(assetMut)).not.toBe(baseline);

    if (process.platform !== 'win32') {
      const execMut = join(tempDir, 'exec-mut');
      buildBundle(execMut);
      chmodSync(join(execMut, 'hooks', 'pre.sh'), 0o755);
      expect(await computeNormalizedBundleHash(execMut)).not.toBe(baseline);
    }
  });

  it('is not merely the manifest checksum', async () => {
    const withExtra = join(tempDir, 'with-extra');
    const withoutExtra = join(tempDir, 'without-extra');
    buildBundle(withExtra);
    buildBundle(withoutExtra);
    // Same manifest bytes, different tree content.
    writeFileSync(join(withExtra, 'skills', 'review', 'EXTRA.md'), 'extra');
    expect(await computeNormalizedBundleHash(withExtra)).not.toBe(
      await computeNormalizedBundleHash(withoutExtra),
    );
  });

  it('distinguishes a symlink from a regular file with the same content', async () => {
    if (process.platform === 'win32') return;
    const withFile = join(tempDir, 'with-file');
    const withLink = join(tempDir, 'with-link');
    buildBundle(withFile);
    buildBundle(withLink);
    writeFileSync(join(withFile, 'assets', 'link'), 'icon.svg');
    symlinkSync('icon.svg', join(withLink, 'assets', 'link'));
    expect(await computeNormalizedBundleHash(withFile)).not.toBe(
      await computeNormalizedBundleHash(withLink),
    );
  });
});
