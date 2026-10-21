import { afterEach, describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  deleteLegacySourceCredentialCache,
  deleteLegacySourceCredentialCaches,
  legacySourceCredentialCachePath,
} from './credential-cache.ts';

const roots: string[] = [];
const symlinkTest = process.platform === 'win32' ? test.skip : test;

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'nessy-legacy-credential-cache-'));
  roots.push(root);
  const workspaceRootPath = join(root, 'workspace');
  const folderPath = join(workspaceRootPath, 'sources', 'source-a');
  mkdirSync(folderPath, { recursive: true });
  return { root, source: { workspaceRootPath, folderPath } };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('legacy source credential cache cleanup', () => {
  test('removes a legacy plaintext cache and is idempotent', () => {
    const { source } = fixture();
    const path = legacySourceCredentialCachePath(source);
    writeFileSync(path, JSON.stringify({ value: 'legacy-secret' }));

    expect(deleteLegacySourceCredentialCache(source)).toBe(true);
    expect(existsSync(path)).toBe(false);
    expect(deleteLegacySourceCredentialCache(source)).toBe(false);
  });

  test('sweeps every managed source directory, including malformed sources', () => {
    const { source } = fixture();
    const malformedFolder = join(source.workspaceRootPath, 'sources', 'malformed');
    mkdirSync(malformedFolder);
    writeFileSync(legacySourceCredentialCachePath(source), JSON.stringify({ value: 'secret-a' }));
    writeFileSync(join(malformedFolder, '.credential-cache.json'), JSON.stringify({ value: 'secret-b' }));

    expect(deleteLegacySourceCredentialCaches(source.workspaceRootPath)).toBe(2);
    expect(existsSync(legacySourceCredentialCachePath(source))).toBe(false);
    expect(existsSync(join(malformedFolder, '.credential-cache.json'))).toBe(false);
  });

  test('fails the sweep when a plaintext cache cannot be safely removed', () => {
    const { source } = fixture();
    mkdirSync(legacySourceCredentialCachePath(source));
    expect(() => deleteLegacySourceCredentialCaches(source.workspaceRootPath))
      .toThrow('source-credential-cache-path-unsafe');
  });

  test('rejects a source folder outside the managed sources directory', () => {
    const { root, source } = fixture();
    const escaped = { ...source, folderPath: join(root, 'outside') };
    mkdirSync(escaped.folderPath);
    expect(() => legacySourceCredentialCachePath(escaped)).toThrow('source-credential-cache-path-unsafe');
  });

  test('rejects a directory collision instead of deleting recursively', () => {
    const { source } = fixture();
    mkdirSync(legacySourceCredentialCachePath(source));
    expect(() => deleteLegacySourceCredentialCache(source)).toThrow('source-credential-cache-path-unsafe');
  });

  symlinkTest('unlinks a legacy cache symlink without touching its target', () => {
    const { root, source } = fixture();
    const target = join(root, 'target');
    writeFileSync(target, 'keep');
    const path = legacySourceCredentialCachePath(source);
    symlinkSync(target, path);

    expect(deleteLegacySourceCredentialCache(source)).toBe(true);
    expect(existsSync(path)).toBe(false);
    expect(existsSync(target)).toBe(true);
  });

  symlinkTest('rejects a source directory symlink escaping the workspace', () => {
    const { root, source } = fixture();
    rmSync(source.folderPath, { recursive: true });
    const outside = join(root, 'outside-source');
    mkdirSync(outside);
    symlinkSync(outside, source.folderPath, 'dir');
    expect(() => legacySourceCredentialCachePath(source)).toThrow('source-credential-cache-path-unsafe');
  });
});
