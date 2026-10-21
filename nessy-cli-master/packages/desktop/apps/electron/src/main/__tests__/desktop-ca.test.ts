import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { resolveDesktopCaPath, resolveDesktopCaPaths } from '../desktop-ca';

const tempDirs: string[] = [];

afterEach(() => {
  for (const directory of tempDirs.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function createTempDir(): string {
  const directory = mkdtempSync(join(tmpdir(), 'desktop-ca-'));
  tempDirs.push(directory);
  return directory;
}

function createCert(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, 'certificate');
}

describe('resolveDesktopCaPath', () => {
  it('finds the CA shipped with a packaged Desktop app', () => {
    const root = createTempDir();
    const appPath = join(root, 'resources', 'app');
    const certPath = join(
      appPath,
      'vendor',
      'nessy-cli',
      'certs',
      'tinkoff-bundle.crt',
    );
    createCert(certPath);

    expect(resolveDesktopCaPath(appPath, root)).toBe(certPath);
  });

  it('finds the CLI build CA when running Desktop in development', () => {
    const root = createTempDir();
    const appPath = join(root, 'packages', 'desktop', 'apps', 'electron');
    const certPath = join(root, 'dist', 'certs', 'tinkoff-bundle.crt');
    createCert(certPath);

    expect(
      resolveDesktopCaPath(appPath, join(root, 'packages', 'desktop')),
    ).toBe(certPath);
  });

  it('finds both CA files shipped with the CLI', () => {
    const root = createTempDir();
    const certDir = join(root, 'dist', 'certs');
    const bundlePath = join(certDir, 'tinkoff-bundle.crt');
    const russianRootPath = join(certDir, 'russian-root-ca.crt');
    createCert(bundlePath);
    createCert(russianRootPath);

    expect(resolveDesktopCaPaths(root, root)).toEqual([
      bundlePath,
      russianRootPath,
    ]);
  });

  it('prefers an explicitly configured CA', () => {
    const root = createTempDir();
    const bundledPath = join(root, 'dist', 'certs', 'tinkoff-bundle.crt');
    const explicitPath = join(root, 'custom.crt');
    createCert(bundledPath);
    createCert(explicitPath);

    expect(resolveDesktopCaPath(root, root, explicitPath)).toBe(explicitPath);
  });
});
