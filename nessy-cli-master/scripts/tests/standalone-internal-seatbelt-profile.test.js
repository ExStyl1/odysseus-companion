import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const readScript = (scriptPath) => readFileSync(scriptPath, 'utf8');

// [nessy-fork] macos-internal-seatbelt-profile
describe('standalone model Seatbelt profile packaging', () => {
  it('allows the model macOS sandbox profile dist assets', () => {
    const tmpDir = realpathSync(
      mkdtempSync(path.join(tmpdir(), 'nessy-package-test-')),
    );

    try {
      const fixtureRoot = createStandalonePackageFixtureRoot(tmpDir);

      expect(() =>
        execFileSync(
          'node',
          [
            path.join(fixtureRoot, 'scripts', 'create-standalone-package.js'),
            '--target',
            'win-x64',
            '--node-archive',
            createFakeWindowsNodeArchive(tmpDir),
            '--out-dir',
            path.join(tmpDir, 'out'),
            '--version',
            '0.0.0-test',
            '--skip-checksums',
          ],
          { stdio: 'pipe' },
        ),
      ).not.toThrow();
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

function createStandalonePackageFixtureRoot(tmpDir) {
  const fixtureRoot = path.join(tmpDir, 'fixture-root');
  const packageVersion = JSON.parse(readScript('package.json')).version;

  writeFixtureFile(
    fixtureRoot,
    'scripts/create-standalone-package.js',
    readScript('scripts/create-standalone-package.js'),
  );
  writeFixtureFile(fixtureRoot, 'README.md', '# Nessy CLI\n');
  writeFixtureFile(fixtureRoot, 'LICENSE', 'Apache-2.0\n');
  writeFixtureFile(
    fixtureRoot,
    'package.json',
    JSON.stringify(
      {
        name: '@nestor/nessy-cli',
        version: packageVersion,
      },
      null,
      2,
    ) + '\n',
  );
  writeFixtureFile(
    fixtureRoot,
    'dist/cli.js',
    `console.log(${JSON.stringify(packageVersion)});\n`,
  );
  writeFixtureFile(
    fixtureRoot,
    'dist/package.json',
    JSON.stringify({ name: '@nestor/nessy-cli', version: packageVersion }) +
      '\n',
  );
  writeFixtureFile(
    fixtureRoot,
    'dist/sandbox-macos-external-model-open.sb',
    '(version 1)\n',
  );
  writeFixtureFile(
    fixtureRoot,
    'dist/sandbox-macos-internal-model-open.sb',
    '(version 1)\n',
  );
  // [nessy-fork] statist-trusted-ca — create-standalone-package.js requires
  // both CA bundles in dist/.
  writeFixtureFile(
    fixtureRoot,
    'dist/certs/tinkoff-bundle.crt',
    '-----BEGIN CERTIFICATE-----\nfixture\n-----END CERTIFICATE-----\n',
  );
  writeFixtureFile(
    fixtureRoot,
    'dist/certs/russian-root-ca.crt',
    '-----BEGIN CERTIFICATE-----\nfixture\n-----END CERTIFICATE-----\n',
  );

  mkdirSync(path.join(fixtureRoot, 'dist', 'chunks'), { recursive: true });
  mkdirSync(path.join(fixtureRoot, 'dist', 'vendor'), { recursive: true });
  mkdirSync(path.join(fixtureRoot, 'dist', 'bundled', 'nc-helper', 'docs'), {
    recursive: true,
  });

  return fixtureRoot;
}

function writeFixtureFile(fixtureRoot, relativePath, content) {
  const filePath = path.join(fixtureRoot, relativePath);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, content);
}

function createFakeWindowsNodeArchive(tmpDir) {
  const fakeNodeDir = path.join(tmpDir, 'node-v20.0.0-win-x64');
  mkdirSync(fakeNodeDir, { recursive: true });
  writeFileSync(path.join(fakeNodeDir, 'node.exe'), 'fake node.exe\n');

  const archive = path.join(tmpDir, 'node-v20.0.0-win-x64.zip');
  createZipForTest(archive, tmpDir, path.basename(fakeNodeDir));
  return archive;
}

function createZipForTest(archive, cwd, entry) {
  if (process.platform === 'win32') {
    execFileSync(
      'powershell',
      [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        'Compress-Archive -LiteralPath $env:NESSY_TEST_ZIP_ENTRY -DestinationPath $env:NESSY_TEST_ZIP_ARCHIVE -Force',
      ],
      {
        env: {
          ...process.env,
          NESSY_TEST_ZIP_ENTRY: path.join(cwd, entry),
          NESSY_TEST_ZIP_ARCHIVE: archive,
        },
        stdio: 'ignore',
      },
    );
    return;
  }

  execFileSync('zip', ['-qr', archive, entry], {
    cwd,
    stdio: 'ignore',
  });
}
