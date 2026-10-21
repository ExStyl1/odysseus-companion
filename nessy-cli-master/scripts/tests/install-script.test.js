/**
 * @license
 * Copyright 2025 Nessy Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';

const {
  appendFileSync,
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} = await vi.importActual('node:fs');
const { execFileSync } = await vi.importActual('node:child_process');
const crypto = await vi.importActual('node:crypto');
const { tmpdir } = await vi.importActual('node:os');
const path = await vi.importActual('node:path');
const { pathToFileURL } = await vi.importActual('node:url');
const readScript = (path) => readFileSync(path, 'utf8');
const standaloneReleaseScriptUrl = pathToFileURL(
  path.resolve('scripts/build-standalone-release.js'),
).href;
// These E2E cases execute the Unix shell installer and POSIX symlink behavior.
// Windows batch behavior has separate Windows-only E2E coverage below.
const itOnUnix = process.platform === 'win32' ? it.skip : it;
const itOnWindows = process.platform === 'win32' ? it : it.skip;

describe('installation scripts', () => {
  it('keeps the Linux/macOS installer lightweight', () => {
    const script = readScript(
      'scripts/installation/install-nessy-with-source-new.sh',
    );

    expect(script).not.toContain('install_nvm');
    expect(script).not.toContain('install_nvm.sh');
    expect(script).not.toContain('nvm install');
    expect(script).not.toContain('NVM_NODEJS_ORG_MIRROR');
    expect(script).toContain(
      'extensions install "${DEFAULT_EXTENSION_SOURCE}"',
    );
    expect(script).toContain('--registry="${DEFAULT_EXTENSION_REGISTRY}"');
    expect(script).toContain(
      `*'Extension "nessy-default-extension" is already installed. Please uninstall it first.'*`,
    );
    expect(script).not.toContain('npm config set prefix');
    expect(script).not.toContain('clean_npmrc_conflict');
    expect(script).not.toContain('.npmrc');
    expect(script).toContain('.npm-global/bin/nessy');
    expect(script).toContain('.npm-packages/bin/nessy');
    expect(script).not.toMatch(/^\s*exec\s+nessy\s*$/m);
    expect(script).not.toContain('--print-env');
    expect(script).not.toContain('brew install node@20');
    expect(script).toContain('brew install node');
    expect(script).toContain(
      '--source may only contain letters, numbers, dot, underscore, or dash',
    );
    expect(script).toContain('Node.js 20 or newer is required');
    expect(script).toContain('get_npm_package_spec()');
    expect(script).toContain('npm uninstall -g @nestor/nessy-cli --registry');
    expect(script).toContain('npm install -g ${package_spec} --force');
    expect(script).toContain('get_npm_exposed_bin_dir()');
    expect(script).toContain('You can now run: nessy');
    expect(script).toContain('SYSTEM_CURL="/usr/bin/curl"');
    expect(script).toContain('"${SYSTEM_CURL}" -fsSL --retry 2');
    expect(script).not.toContain('command_exists curl');
  });

  it('supports code-server-style standalone install on Linux/macOS', () => {
    const script = readScript(
      'scripts/installation/install-nessy-with-source-new.sh',
    );

    expect(script).toContain('--method METHOD');
    expect(script).toContain('--version VERSION');
    expect(script).toContain('--archive PATH');
    expect(script).toContain('install_standalone()');
    expect(script).toContain('install_npm()');
    expect(script).toContain('detect_target()');
    expect(script).toContain('verify_checksum()');
    expect(script).toContain('SHA256SUMS not found; cannot verify archive');
    expect(script).toContain('awk -v archive_name');
    expect(script).not.toContain(
      'grep -E "(^|[[:space:]])[*]?${archive_name}$"',
    );
    expect(script).toContain('validate_archive_contents()');
    expect(script).toContain('Archive contains unsafe path');
    expect(script).toContain('nessy-cli-${target}');
    expect(script).toContain('*.tar.xz)');
    expect(script).toContain('METHOD="${METHOD:-detect}"');
    expect(script).toContain('must start with https://');
    expect(script).not.toContain('Falling back to npm installation');
    expect(script).toContain('standalone_status=$?');
    expect(script).toContain('[[ "${standalone_status}" -eq 2 ]]');
    expect(script).toContain('resolve_local_standalone_archive()');
    expect(script).toContain('Using local standalone archive');
    expect(script).toContain(
      'Standalone archive is unavailable for ${VERSION}',
    );
    expect(script).toContain(
      'rerun with --method npm to use user Node.js/npm explicitly',
    );
    expect(script).toContain(
      'Standalone install failed. Retry with --method npm',
    );
    expect(script).not.toContain('ln -sf "${INSTALL_LIB_DIR}/bin/nessy"');
    expect(script).toContain('shell_quote()');
    expect(script).toContain('exec ${quoted_nessy_bin} "\\$@"');
    expect(script).toContain('validate_version()');
    expect(script).toContain('validate_install_path');
    expect(script).toContain('validate_https_url "${NPM_REGISTRY}"');
    expect(script).not.toMatch(/--mirror/);
    expect(script).not.toMatch(/--base-url/);
    expect(script).not.toMatch(/MIRROR=/);
    expect(script).not.toMatch(/BASE_URL=/);
    expect(script).not.toContain('NVM_NODEJS_ORG_MIRROR');
    expect(script).not.toMatch(/github\.com.*nessy-cli/);
    expect(script).toContain('s3-msk.tinkoff.ru');
    expect(script).toContain('nessy-cli/node/bin/node');
    expect(script).toContain('Archive contains symlinks; refusing to install');
    expect(script).toContain('not a Nessy CLI standalone install');
    expect(script).toContain(
      'Return 2 only when a standalone archive is unavailable',
    );
    expect(script).not.toContain('npm fallback also failed');
    expect(script).toContain(
      'unzip -q "${archive_path}" -d "${destination}" || return 1',
    );
    expect(script).toContain(
      'tar -xzf "${archive_path}" -C "${destination}" || return 1',
    );
    expect(script).toContain('wget -q --tries=3 "${url}" -O "${destination}"');
    expect(script).toContain('TEMP_DIRS+=');
    expect(script).not.toContain('-print -quit');
  });

  it('keeps the Windows installer lightweight', () => {
    const script = readScript(
      'scripts/installation/install-nessy-with-source-new.bat',
    );

    expect(script).not.toContain('InstallNodeJSDirectly');
    expect(script).not.toContain('node-v!NODE_VERSION!');
    expect(script).not.toContain('msiexec');
    expect(script).not.toContain('Invoke-WebRequest');
    expect(script).not.toContain('PowerShell (Administrator)');
    expect(script).not.toContain('echo INFO: Installation source: %SOURCE%');
    expect(script).not.toMatch(/^\s*call\s+nessy\s*$/m);
    expect(script).toContain(':ValidateSource');
    expect(script).toContain(':PrintUsage');
    expect(script).toContain('findstr /R');
    expect(script).toContain(
      '--source may only contain letters, numbers, dot, underscore, or dash',
    );
    expect(script).toContain('Node.js 20 or newer is required');
    expect(script).toContain('Please install Node.js');
    expect(script).toContain(
      'npm install -g @nestor/nessy-cli@latest --registry',
    );
    expect(script).toContain('You can now run: nessy');
    expect(script).toContain(':InstallDefaultExtension');
    expect(script).toContain(
      'extensions install "!DEFAULT_EXTENSION_SOURCE!" --registry="!DEFAULT_EXTENSION_REGISTRY!" --auto-update --consent',
    );
    expect(script).toContain(
      'findstr /C:"Extension \\"nessy-default-extension\\" is already installed. Please uninstall it first."',
    );
    expect(script).toContain(
      'INFO: Default extension pack is already installed.',
    );
    expect(script).not.toMatch(/^\s*(?:call\s+)?curl(?:\.exe)?(?:\s|$)/im);
  });

  it('keeps the Windows installer compatible with cmd.exe line endings', () => {
    const script = readScript(
      'scripts/installation/install-nessy-with-source-new.bat',
    );

    expect(script).toContain('\r\n:DetectTarget\r\n');
    expect(script).toContain('\r\n:MaybeUpdateUserPath\r\n');
    expect(script.replaceAll('\r\n', '')).not.toContain('\n');
  });

  it('keeps the PowerShell installer as a lightweight batch wrapper', () => {
    const script = readScript(
      'scripts/installation/install-nessy-with-source-new.ps1',
    );

    expect(script).toContain('Invoke-WebRequest -Uri $installerUrl');
    expect(script).toContain('[Net.SecurityProtocolType]::Tls12');
    expect(script).toContain("$installerName = 'install-nessy.bat'");
    expect(script).toContain('& $installerPath @args');
    expect(script).toContain('$exitCode = $LASTEXITCODE');
    expect(script).toContain(
      'Remove-Item -LiteralPath $temporaryDirectory -Recurse',
    );
    expect(script).not.toContain('Get-Command curl.exe');
    expect(script).not.toMatch(/^\s*curl(?:\.exe)?(?:\s|$)/im);
    expect(script).not.toContain('$checksumsUrl');
    expect(script).not.toContain('Get-FileHash');
    expect(script).not.toContain('NESSY_INSTALLER_BAT_URL');
  });

  // AIDT-7250. The wrapper stays thin for the install itself, but it still has
  // to make `nessy` runnable without reopening the terminal.
  it('refreshes the current session PATH after the batch installer succeeds', () => {
    const script = readScript(
      'scripts/installation/install-nessy-with-source-new.ps1',
    );

    // PATH work runs only once the batch installer reported success.
    expect(script).toMatch(
      /if \(\$exitCode -ne 0\) \{[^}]*exit \$exitCode[^}]*\}\s*Update-CurrentShell/,
    );
    expect(script).toContain('function Update-CurrentSessionPath');
    expect(script).toContain("Join-Path $nessyInstallBinDir 'nessy.cmd'");
    expect(script).toContain("$env:NESSY_NO_MODIFY_PATH -eq '1'");
    // cmd.exe cannot inherit PATH from its PowerShell child, so the installer
    // drops a shim into a directory that is already on the parent's PATH.
    expect(script).toContain('function Install-CurrentCmdPathShim');
    expect(script).toContain("$parentProcessName -ieq 'cmd.exe'");
    expect(script).toContain("Join-Path $installBase 'current-cmd-shim.txt'");
  });

  it('supports code-server-style standalone install on Windows', () => {
    const script = readScript(
      'scripts/installation/install-nessy-with-source-new.bat',
    );

    expect(script).toContain('--method METHOD');
    expect(script).toContain('--version VERSION');
    expect(script).toContain('--archive PATH');
    expect(script).not.toMatch(/--mirror/);
    expect(script).not.toMatch(/--base-url/);
    expect(script).toContain(':InstallStandalone');
    expect(script).toContain(':InstallNpm');
    expect(script).toContain(':VerifyChecksum');
    expect(script).toContain('SHA256SUMS not found; cannot verify archive');
    expect(script).toContain('Get-FileHash -Algorithm SHA256');
    expect(script).toContain('tokens=1,2');
    expect(script).toContain('CHECKSUM_NAME');
    expect(script).toContain('if "!CHECKSUM_NAME!"=="!ARCHIVE_NAME!"');
    expect(script).not.toContain('findstr /C:"!ARCHIVE_NAME!"');
    expect(script).not.toContain('certutil -hashfile');
    expect(script).toContain('nessy-cli-win-x64.zip');
    expect(script).toContain('Expand-Archive');
    expect(script).toContain('$env:NESSY_DOWNLOAD_URL');
    expect(script).toContain('$env:NESSY_ARCHIVE_FILE');
    expect(script).toContain(
      'if defined NESSY_INSTALL_ROOT set "INSTALL_BASE=!NESSY_INSTALL_ROOT!"',
    );
    expect(script).not.toContain('%NESSY_INSTALL_ROOT%');
    expect(script).toContain(
      'set "NESSY_VALIDATE_INSTALL_BASE=!INSTALL_BASE!"',
    );
    expect(script).toContain(
      'installer options contain unsafe command characters',
    );
    expect(script).toContain('[char[]](10,13,33,34');
    expect(script).toContain('if "!INSTALL_BASE:~1,2!"==":/"');
    expect(script).toContain('if "!INSTALL_DIR:~1,2!"==":/"');
    expect(script).toContain('if "!INSTALL_BIN_DIR:~1,2!"==":/"');
    expect(script).toContain(':ValidateVersion');
    expect(script).toContain('--version VERSION');
    expect(script).not.toMatch(/--mirror/);
    expect(script).not.toMatch(/--base-url/);
    expect(script).not.toMatch(/MIRROR=/);
    expect(script).not.toMatch(/^\s*set\s+"BASE_URL=/m);
    expect(script).not.toMatch(/ReleaseVersionPath/);
    expect(script).toContain('s3-msk.tinkoff.ru');
    expect(script).toContain(
      'call :ValidateHttpsUrlVar "NPM_REGISTRY" "--registry"',
    );
    expect(script).toContain("$ErrorActionPreference = 'Stop'; try");
    expect(script).toContain(
      '[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; $request = [Net.WebRequest]::Create($env:NESSY_CHECK_URL)',
    );
    expect(script).toContain('must start with https://');
    expect(script).toContain('Falling back to npm installation');
    expect(script).toContain('set "STANDALONE_STATUS=!ERRORLEVEL!"');
    expect(script).toContain('if !STANDALONE_STATUS! EQU 2');
    expect(script).toContain(
      'Standalone install failed. Retry with --method npm',
    );
    expect(script).toContain('nessy-cli\\node\\node.exe');
    expect(script).toContain('Archive contains symlinks or reparse points');
    expect(script).toContain('NESSY_INSTALL_ROOT');
    expect(script).toContain('npm fallback also failed');
  });
});

describe('standalone release packaging', () => {
  it('defines a standalone packaging script', () => {
    const packageJson = JSON.parse(readScript('package.json'));

    expect(packageJson.scripts['package:standalone']).toBe(
      'node scripts/create-standalone-package.js',
    );
    expect(packageJson.scripts['package:standalone:release']).toMatch(
      /node scripts\/build-standalone-release\.js/,
    );
    expect(existsSync('scripts/create-standalone-package.js')).toBe(true);
    expect(existsSync('scripts/build-standalone-release.js')).toBe(true);

    const packageScript = readScript('scripts/create-standalone-package.js');
    expect(packageScript).toContain('Copyright 2025 Nessy CLI Team');
    expect(packageScript).toContain("'bundled/nc-helper/docs'");
    expect(packageScript).toContain('DIST_ALLOWED_ENTRIES');
    expect(packageScript).toContain('Unexpected dist asset');
    expect(packageScript).toContain('topLevelDistEntryForPath(outDir)');
    expect(packageScript).toContain("path.join(packageRoot, 'package.json')");
    expect(packageScript).toContain('validateNodeRuntime');
    expect(packageScript).toContain('copyNodeRuntimeEntry');
    expect(packageScript).toContain('symlink cycle');
    expect(packageScript).toContain('refusing to write empty SHA256SUMS');
    expect(packageScript).toContain('--skip-checksums');
    expect(packageScript).toContain('dereference: true');
    expect(packageScript).toContain('fs.createReadStream');
    expect(packageScript).toContain('Expand-Archive');
    expect(packageScript).toContain('Compress-Archive');

    const releaseScript = readScript('scripts/build-standalone-release.js');
    expect(releaseScript).toContain('Copyright 2025 Nessy Team');
    expect(releaseScript).toContain('--node-dist-path');
    expect(releaseScript).toContain('parseLocalChecksums');
    expect(releaseScript).toContain('SHASUMS256.txt');
    expect(releaseScript).toContain('verifyNodeArchive');
    expect(releaseScript).toContain(
      'EXPECTED_ARCHIVE_COUNT = RELEASE_TARGETS.length',
    );
    expect(releaseScript).toContain('nodeArchiveExtension');
    expect(releaseScript).toContain('fs.createReadStream');
    expect(releaseScript).toContain('expectedArchiveNames');
    expect(releaseScript).toContain('nessy-cli-${nessyTarget}');
    expect(releaseScript).toContain('scripts/create-standalone-package.js');
    expect(releaseScript).toContain('--skip-checksums');
    expect(releaseScript).toContain('writeSha256Sums(outDir)');
  });

  it('loads the standalone release packaging helper', () => {
    const output = execFileSync(
      process.execPath,
      ['scripts/build-standalone-release.js', '--help'],
      { encoding: 'utf8' },
    );

    expect(output).toContain('package:standalone:release');
    expect(output).toContain('--node-version VERSION');
  });

  it('parses Node.js SHASUMS entries', async () => {
    const { parseChecksums } = await import(standaloneReleaseScriptUrl);

    const checksums = parseChecksums(
      [
        'a'.repeat(64) + '  node-v20.19.0-linux-x64.tar.xz',
        'b'.repeat(64) + ' *node-v20.19.0-win-x64.zip',
        '',
      ].join('\n'),
    );

    expect(checksums.get('node-v20.19.0-linux-x64.tar.xz')).toBe(
      'a'.repeat(64),
    );
    expect(checksums.get('node-v20.19.0-win-x64.zip')).toBe('b'.repeat(64));
  });

  it('validates standalone release checksum output', async () => {
    const { assertStandaloneOutput, RELEASE_TARGETS } = await import(
      standaloneReleaseScriptUrl
    );
    const tmpDir = mkdtempSync(path.join(tmpdir(), 'nessy-release-test-'));

    try {
      const lines = RELEASE_TARGETS.map(({ nessyTarget }) => {
        const extension = nessyTarget === 'win-x64' ? 'zip' : 'tar.gz';
        return `${'a'.repeat(64)}  nessy-cli-${nessyTarget}.${extension}`;
      });
      writeFileSync(path.join(tmpDir, 'SHA256SUMS'), `${lines.join('\n')}\n`);

      expect(() => assertStandaloneOutput(tmpDir)).not.toThrow();

      writeFileSync(
        path.join(tmpDir, 'SHA256SUMS'),
        `${lines.join('\n')}\n${'b'.repeat(64)}  nessy-cli-extra.tar.gz\n`,
      );
      expect(() => assertStandaloneOutput(tmpDir)).toThrow(/Extra/);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('rejects a runtime archive without a Node executable', () => {
    const createdDist = ensureMinimalDist();
    const tmpDir = mkdtempSync(path.join(tmpdir(), 'nessy-package-test-'));

    try {
      const target = process.platform === 'win32' ? 'win-x64' : 'linux-x64';
      const fakeRuntimeArchive =
        process.platform === 'win32'
          ? createBadWindowsNodeArchive(tmpDir)
          : createBadUnixNodeArchive(tmpDir);

      expect(() =>
        execFileSync(
          'node',
          [
            'scripts/create-standalone-package.js',
            '--target',
            target,
            '--node-archive',
            fakeRuntimeArchive,
            '--out-dir',
            path.join(tmpDir, 'out'),
            '--version',
            '0.0.0-test',
          ],
          { stdio: 'pipe' },
        ),
      ).toThrow(/Node\.js runtime for .* must contain/);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
      if (createdDist) {
        rmSync('dist', { recursive: true, force: true });
      }
    }
  });

  it('packages a win-x64 standalone archive', () => {
    const createdDist = ensureMinimalDist();
    const distPackageJson = path.join('dist', 'package.json');
    const createdDistPackageJson = !existsSync(distPackageJson);
    const distCliPath = path.join('dist', 'cli.js');
    const originalDistCli = readScript(distCliPath);
    const packageVersion = JSON.parse(readScript('package.json')).version;
    const tmpDir = mkdtempSync(path.join(tmpdir(), 'nessy-package-test-'));

    try {
      if (createdDistPackageJson) {
        writeFileSync(
          distPackageJson,
          JSON.stringify({ name: '@nestor/nessy-cli', version: '9.9.9' }),
        );
      }
      writeFileSync(
        distCliPath,
        `${originalDistCli}\nconsole.log(${JSON.stringify(packageVersion)});\n`,
      );

      const outDir = path.join(tmpDir, 'out');
      execFileSync(
        'node',
        [
          'scripts/create-standalone-package.js',
          '--target',
          'win-x64',
          '--node-archive',
          createFakeWindowsNodeArchive(tmpDir),
          '--out-dir',
          outDir,
          '--version',
          '0.0.0-test',
        ],
        { stdio: 'pipe' },
      );

      const archive = path.join(outDir, 'nessy-cli-win-x64.zip');
      const extractDir = path.join(tmpDir, 'extract');
      mkdirSync(extractDir, { recursive: true });
      extractZipForTest(archive, extractDir);

      expect(existsSync(path.join(extractDir, 'nessy-cli'))).toBe(true);
      expect(
        existsSync(path.join(extractDir, 'nessy-cli', 'bin', 'nessy.cmd')),
      ).toBe(true);
      expect(
        existsSync(path.join(extractDir, 'nessy-cli', 'node', 'node.exe')),
      ).toBe(true);
      expect(
        JSON.parse(
          readScript(path.join(extractDir, 'nessy-cli', 'package.json')),
        ).version,
      ).toBe('0.0.0-test');
      expect(
        JSON.parse(
          readScript(path.join(extractDir, 'nessy-cli', 'lib', 'package.json')),
        ).version,
      ).toBe('0.0.0-test');
      expect(
        JSON.parse(
          readScript(path.join(extractDir, 'nessy-cli', 'manifest.json')),
        ).version,
      ).toBe('0.0.0-test');
      expect(
        readScript(path.join(extractDir, 'nessy-cli', 'lib', 'cli.js')),
      ).toContain('"0.0.0-test"');
      expect(
        readScript(path.join(extractDir, 'nessy-cli', 'lib', 'cli.js')),
      ).not.toContain(JSON.stringify(packageVersion));
      expect(readScript(path.join(outDir, 'SHA256SUMS'))).toContain(
        'nessy-cli-win-x64.zip',
      );
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
      if (createdDist) {
        rmSync('dist', { recursive: true, force: true });
      } else {
        writeFileSync(distCliPath, originalDistCli);
        if (createdDistPackageJson) {
          rmSync(distPackageJson, { force: true });
        }
      }
    }
  }, 30_000);

  itOnUnix(
    'dereferences safe Node.js runtime symlinks',
    () => {
      const createdDist = ensureMinimalDist();
      const tmpDir = mkdtempSync(path.join(tmpdir(), 'nessy-package-test-'));

      try {
        const archive = packageFakeStandalone(tmpDir, {
          withSafeNodeSymlink: true,
        });
        const installRoot = path.join(tmpDir, 'install');
        runUnixInstaller(archive, installRoot, path.join(tmpDir, 'home'));

        const npmShim = path.join(
          installRoot,
          'lib',
          'nessy-cli',
          'node',
          'bin',
          'npm',
        );
        expect(existsSync(npmShim)).toBe(true);
        expect(lstatSync(npmShim).isSymbolicLink()).toBe(false);
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
        if (createdDist) {
          rmSync('dist', { recursive: true, force: true });
        }
      }
    },
    30_000,
  );

  itOnUnix('rejects Node.js runtime symlinks that escape the archive', () => {
    const createdDist = ensureMinimalDist();
    const tmpDir = mkdtempSync(path.join(tmpdir(), 'nessy-package-test-'));

    try {
      expect(() =>
        execFileSync(
          'node',
          [
            'scripts/create-standalone-package.js',
            '--target',
            'linux-x64',
            '--node-archive',
            createFakeNodeArchive(tmpDir, {
              withEscapingNodeSymlink: true,
            }),
            '--out-dir',
            path.join(tmpDir, 'out'),
            '--version',
            '0.0.0-test',
          ],
          { stdio: 'pipe' },
        ),
      ).toThrow(/symlink escapes the archive/);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
      if (createdDist) {
        rmSync('dist', { recursive: true, force: true });
      }
    }
  });

  itOnUnix('rejects Node.js runtime symlink cycles', () => {
    const createdDist = ensureMinimalDist();
    const tmpDir = mkdtempSync(path.join(tmpdir(), 'nessy-package-test-'));

    try {
      expect(() =>
        execFileSync(
          'node',
          [
            'scripts/create-standalone-package.js',
            '--target',
            'linux-x64',
            '--node-archive',
            createFakeNodeArchive(tmpDir, {
              withNodeSymlinkCycle: true,
            }),
            '--out-dir',
            path.join(tmpDir, 'out'),
            '--version',
            '0.0.0-test',
          ],
          { stdio: 'pipe' },
        ),
      ).toThrow(/symlink cycle/);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
      if (createdDist) {
        rmSync('dist', { recursive: true, force: true });
      }
    }
  });

  it('rejects unexpected dist assets', () => {
    const createdDist = ensureMinimalDist();
    const tmpDir = mkdtempSync(path.join(tmpdir(), 'nessy-package-test-'));

    try {
      writeFileSync('dist/debug-cache.tmp', 'debug\n');

      expect(() =>
        execFileSync(
          'node',
          [
            'scripts/create-standalone-package.js',
            '--target',
            'win-x64',
            '--node-archive',
            createFakeWindowsNodeArchive(tmpDir),
            '--out-dir',
            path.join(tmpDir, 'out'),
            '--version',
            '0.0.0-test',
          ],
          { stdio: 'pipe' },
        ),
      ).toThrow(/Unexpected dist asset/);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
      if (createdDist) {
        rmSync('dist', { recursive: true, force: true });
      } else {
        rmSync('dist/debug-cache.tmp', { force: true });
      }
    }
  });

  it('does not whitelist internal planning documents in gitignore', () => {
    const gitignore = readScript('.gitignore');

    expect(gitignore).not.toContain('!.nessy/design/');
    expect(gitignore).not.toContain('!.nessy/e2e-tests/');
  });

  it('documents optional native module parity for standalone installs', () => {
    const guide = readScript('scripts/installation/INSTALLATION_GUIDE.md');

    expect(guide).toContain('Optional Native Modules');
    expect(guide).toContain('node-pty');
    expect(guide).toContain('clipboard');
  });

  it('documents separate system curl commands for macOS and Linux', () => {
    const guide = readScript('scripts/installation/INSTALLATION_GUIDE.md');
    const russianUserDocs = [
      'docs-ru/users/quickstart.md',
      'docs-ru/users/overview.md',
    ];

    expect(guide).toContain('/usr/bin/curl -fsSL');
    expect(guide).toContain('[ -x "$CURL" ] || CURL=/bin/curl');
    expect(guide).toContain('Anaconda');
    for (const doc of russianUserDocs) {
      const content = readScript(doc);
      // overview.md labels platforms with bold headings, quickstart.md moved to
      // Docusaurus tabs — both are valid, so match either form.
      expect(content).toMatch(/\*\*macOS|label="macOS"/);
      expect(content).toContain('/usr/bin/curl -fsSL');
      expect(content).toMatch(/\*\*Linux\*\*|label="Linux"/);
      expect(content).toContain('[ -x "$CURL" ] || CURL=/bin/curl');
    }
  });

  it('documents the system curl.exe for Windows installation', () => {
    // docs-ru/users/quickstart.md deliberately offers only the PowerShell
    // one-liner for Windows (covered by the next test), so it carries no
    // cmd.exe command to pin down.
    const docsWithCmdInstaller = [
      'scripts/installation/INSTALLATION_GUIDE.md',
      'docs/users/quickstart.md',
      'docs/users/overview.md',
      'docs-ru/users/overview.md',
    ];
    const allUserDocs = [
      ...docsWithCmdInstaller,
      'docs-ru/users/quickstart.md',
    ];

    for (const doc of docsWithCmdInstaller) {
      expect(readScript(doc)).toContain(
        '"%SystemRoot%\\System32\\curl.exe" -fsSL',
      );
    }
    // A bare `curl` would resolve to the Anaconda build when it shadows the
    // system one on PATH.
    for (const doc of allUserDocs) {
      expect(readScript(doc)).not.toMatch(/^\s*curl -fsSL -o %TEMP%/m);
    }
  });

  it('documents the PowerShell installer for Russian Windows users', () => {
    const russianUserDocs = [
      'docs-ru/users/quickstart.md',
      'docs-ru/users/overview.md',
    ];

    for (const doc of russianUserDocs) {
      const content = readScript(doc);
      expect(content).toContain(
        'irm https://s3-msk.tinkoff.ru/nestor-companion/installation/v2/install-nessy.ps1 | iex',
      );
    }
    // The rationale for preferring PowerShell lives in overview.md;
    // quickstart.md keeps the step list bare on purpose.
    expect(readScript('docs-ru/users/overview.md')).toContain(
      'не вызывает `curl`',
    );
  });

  it('documents macOS installation through Self Service', () => {
    const russianUserDocs = [
      'docs-ru/users/quickstart.md',
      'docs-ru/users/overview.md',
    ];

    for (const doc of russianUserDocs) {
      const content = readScript(doc);
      // Bold heading in overview.md, tab label in quickstart.md.
      expect(content).toMatch(
        /\*\*macOS — Self Service\*\*|label="Self Service"/,
      );
      expect(content).toContain('приложение **Self Service**');
      expect(content).toContain('Введите в поиске `Nessy CLI`');
      expect(content).toContain('Нажмите **Install**');
    }
  });
});

describe('Linux/macOS installer end-to-end', () => {
  itOnUnix(
    'installs a local standalone archive with checksum verification',
    () => {
      const createdDist = ensureMinimalDist();
      const tmpDir = mkdtempSync(path.join(tmpdir(), 'nessy-install-test-'));

      try {
        const archive = packageFakeStandalone(tmpDir);
        const installRoot = path.join(tmpDir, 'install');
        const home = path.join(tmpDir, 'home');
        runUnixInstaller(archive, installRoot, home);

        expect(existsSync(path.join(installRoot, 'bin', 'nessy'))).toBe(true);
        expect(
          existsSync(
            path.join(installRoot, 'lib', 'nessy-cli', 'node', 'bin', 'node'),
          ),
        ).toBe(true);
        expect(readScript(path.join(home, '.nessy', 'source.json'))).toContain(
          '"source": "smoke"',
        );

        const version = execFileSync(path.join(installRoot, 'bin', 'nessy'), [
          '--version',
        ])
          .toString()
          .trim();
        expect(version).toBe('0.0.0-smoke');
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
        if (createdDist) {
          rmSync('dist', { recursive: true, force: true });
        }
      }
    },
  );

  itOnUnix('shell-quotes custom install paths in the generated wrapper', () => {
    const createdDist = ensureMinimalDist();
    const tmpDir = mkdtempSync(path.join(tmpdir(), 'nessy-install-test-'));

    try {
      const archive = packageFakeStandalone(tmpDir);
      const installRoot = path.join(tmpDir, 'install');
      const home = path.join(tmpDir, 'home');
      const installLibDir = path.join(
        installRoot,
        'lib',
        'nessy-cli$(touch nessy-pwned)',
      );

      runUnixInstaller(archive, installRoot, home, 'standalone', {
        NESSY_INSTALL_LIB_DIR: installLibDir,
      });

      const version = execFileSync(
        path.join(installRoot, 'bin', 'nessy'),
        ['--version'],
        {
          cwd: tmpDir,
        },
      )
        .toString()
        .trim();
      expect(version).toBe('0.0.0-smoke');
      expect(existsSync(path.join(tmpDir, 'nessy-pwned'))).toBe(false);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
      if (createdDist) {
        rmSync('dist', { recursive: true, force: true });
      }
    }
  });

  itOnUnix('rejects a tampered local archive', () => {
    const createdDist = ensureMinimalDist();
    const tmpDir = mkdtempSync(path.join(tmpdir(), 'nessy-install-test-'));

    try {
      const archive = packageFakeStandalone(tmpDir);
      appendFileSync(archive, 'tamper');

      expect(() =>
        runUnixInstaller(
          archive,
          path.join(tmpDir, 'install'),
          path.join(tmpDir, 'home'),
        ),
      ).toThrow(/Checksum verification failed/);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
      if (createdDist) {
        rmSync('dist', { recursive: true, force: true });
      }
    }
  });

  itOnUnix('rejects a local archive when SHA256SUMS is missing', () => {
    const createdDist = ensureMinimalDist();
    const tmpDir = mkdtempSync(path.join(tmpdir(), 'nessy-install-test-'));

    try {
      const archive = packageFakeStandalone(tmpDir);
      rmSync(path.join(path.dirname(archive), 'SHA256SUMS'), { force: true });

      expect(() =>
        runUnixInstaller(
          archive,
          path.join(tmpDir, 'install'),
          path.join(tmpDir, 'home'),
        ),
      ).toThrow(/SHA256SUMS not found/);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
      if (createdDist) {
        rmSync('dist', { recursive: true, force: true });
      }
    }
  });

  itOnUnix('rejects standalone archives containing symlinks', () => {
    const tmpDir = mkdtempSync(path.join(tmpdir(), 'nessy-install-test-'));

    try {
      const archive = createSymlinkStandaloneArchive(tmpDir);

      expect(() =>
        runUnixInstaller(
          archive,
          path.join(tmpDir, 'install'),
          path.join(tmpDir, 'home'),
        ),
      ).toThrow(/Archive contains symlinks/);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  itOnUnix(
    'rejects standalone archives containing path traversal entries',
    () => {
      const tmpDir = mkdtempSync(path.join(tmpdir(), 'nessy-install-test-'));

      try {
        const archive = createTraversalStandaloneArchive(tmpDir);

        expect(() =>
          runUnixInstaller(
            archive,
            path.join(tmpDir, 'install'),
            path.join(tmpDir, 'home'),
          ),
        ).toThrow(/Archive contains unsafe path/);
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    },
  );

  itOnUnix('refuses to overwrite a non-managed install directory', () => {
    const createdDist = ensureMinimalDist();
    const tmpDir = mkdtempSync(path.join(tmpdir(), 'nessy-install-test-'));

    try {
      const archive = packageFakeStandalone(tmpDir);
      const installRoot = path.join(tmpDir, 'install');
      const installDir = path.join(installRoot, 'lib', 'nessy-cli');
      mkdirSync(installDir, { recursive: true });
      writeFileSync(path.join(installDir, 'important.txt'), 'keep me\n');

      expect(() =>
        runUnixInstaller(archive, installRoot, path.join(tmpDir, 'home')),
      ).toThrow(/not a Nessy CLI standalone install/);
      expect(readScript(path.join(installDir, 'important.txt'))).toBe(
        'keep me\n',
      );
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
      if (createdDist) {
        rmSync('dist', { recursive: true, force: true });
      }
    }
  });

  itOnUnix('does not fall back to npm when detect finds a bad archive', () => {
    const createdDist = ensureMinimalDist();
    const tmpDir = mkdtempSync(path.join(tmpdir(), 'nessy-install-test-'));

    try {
      const archive = packageFakeStandalone(tmpDir);
      appendFileSync(archive, 'tamper');

      let failureMessage = '';
      try {
        runUnixInstaller(
          archive,
          path.join(tmpDir, 'install'),
          path.join(tmpDir, 'home'),
          'detect',
        );
      } catch (error) {
        failureMessage = error.message;
      }

      expect(failureMessage).toContain('Checksum verification failed');
      expect(failureMessage).toContain('Standalone install failed');
      expect(failureMessage).not.toContain('Falling back to npm installation');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
      if (createdDist) {
        rmSync('dist', { recursive: true, force: true });
      }
    }
  });

  itOnUnix('removes stale npm-prefix and PATH nessy wrappers', () => {
    const createdDist = ensureMinimalDist();
    const tmpDir = mkdtempSync(path.join(tmpdir(), 'nessy-install-test-'));

    try {
      const archive = packageFakeStandalone(tmpDir);
      const installRoot = path.join(tmpDir, 'install');
      const home = path.join(tmpDir, 'home');
      const npmGlobalBin = path.join(home, '.npm-global', 'bin');
      const pathGlobalBin = path.join(tmpDir, 'usr-local-bin');
      const npmGlobalNessy = path.join(npmGlobalBin, 'nessy');
      const pathGlobalNessy = path.join(pathGlobalBin, 'nessy');

      mkdirSync(npmGlobalBin, { recursive: true });
      mkdirSync(pathGlobalBin, { recursive: true });
      for (const staleBin of [npmGlobalNessy, pathGlobalNessy]) {
        writeFileSync(
          staleBin,
          '#!/usr/bin/env sh\nexec node "$HOME/.npm-global/lib/node_modules/@nestor/nessy-cli/dist/cli.js" "$@"\n',
        );
        chmodSync(staleBin, 0o755);
      }

      const output = runUnixInstaller(
        archive,
        installRoot,
        home,
        'standalone',
        {
          PATH: `${npmGlobalBin}:${pathGlobalBin}:/usr/bin:/bin:/usr/sbin:/sbin`,
          NESSY_NO_MODIFY_PATH: '1',
        },
      ).toString();

      expect(output).toContain(
        `Removed stale Nessy executable: ${npmGlobalNessy}`,
      );
      expect(output).toContain(
        `Removed stale Nessy executable: ${pathGlobalNessy}`,
      );
      expect(existsSync(npmGlobalNessy)).toBe(false);
      expect(existsSync(pathGlobalNessy)).toBe(false);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
      if (createdDist) {
        rmSync('dist', { recursive: true, force: true });
      }
    }
  });

  itOnUnix('uses a local dist standalone archive in detect mode', () => {
    const tmpDir = mkdtempSync(path.join(tmpdir(), 'nessy-install-test-'));

    try {
      const repoRoot = path.join(tmpDir, 'repo');
      const scriptDir = path.join(repoRoot, 'scripts', 'installation');
      const outDir = path.join(repoRoot, 'dist', 'standalone');
      const fakeBin = path.join(tmpDir, 'bin');
      const archiveName = currentUnixStandaloneArchiveName();
      mkdirSync(scriptDir, { recursive: true });
      mkdirSync(outDir, { recursive: true });
      mkdirSync(fakeBin, { recursive: true });
      writeFileSync(
        path.join(scriptDir, 'install-nessy-with-source-new.sh'),
        readScript('scripts/installation/install-nessy-with-source-new.sh'),
      );
      chmodSync(
        path.join(scriptDir, 'install-nessy-with-source-new.sh'),
        0o755,
      );
      createFakeUnixStandaloneArchive(outDir, archiveName, '0.0.0-smoke');
      writeFileSync(path.join(fakeBin, 'curl'), '#!/usr/bin/env sh\nexit 22\n');
      chmodSync(path.join(fakeBin, 'curl'), 0o755);

      const installRoot = path.join(tmpDir, 'install');
      const home = path.join(tmpDir, 'home');
      const extensionLog = path.join(tmpDir, 'extension-args.txt');
      mkdirSync(home, { recursive: true });
      const output = execFileSync(
        'bash',
        [
          path.join(scriptDir, 'install-nessy-with-source-new.sh'),
          '--method',
          'detect',
          '--version',
          '0.0.0-smoke',
          '--source',
          'smoke',
        ],
        {
          cwd: repoRoot,
          env: {
            ...process.env,
            HOME: home,
            PATH: `${fakeBin}:/usr/bin:/bin:/usr/sbin:/sbin`,
            NESSY_INSTALL_ROOT: installRoot,
            NESSY_EXTENSION_LOG: extensionLog,
            NESSY_EXTENSION_RESULT: 'already-installed',
          },
          stdio: 'pipe',
        },
      ).toString();

      expect(output).toContain('Using local standalone archive');
      expect(output).toContain('Default extension pack is already installed.');
      expect(output).not.toContain(
        'WARNING: Failed to install the default extension pack',
      );
      expect(readScript(extensionLog).trim().split('\n')).toEqual([
        'extensions',
        'install',
        '@nestor/nessy-cli-extensions',
        '--registry=https://artifactory.tcsbank.ru/artifactory/api/npm/npm-all',
        '--auto-update',
        '--consent',
      ]);
      expect(output).not.toContain('Downloading https://');
      expect(output).not.toContain('Standalone archive is unavailable');
      expect(
        execFileSync(path.join(installRoot, 'bin', 'nessy'), ['--version'])
          .toString()
          .trim(),
      ).toBe('0.0.0-smoke');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  itOnUnix(
    'uses requested version in explicit npm install and preserves asdf shim',
    () => {
      const tmpDir = mkdtempSync(path.join(tmpdir(), 'nessy-install-test-'));

      try {
        const fakeBin = path.join(tmpDir, 'bin');
        const home = path.join(tmpDir, 'home');
        const asdfShims = path.join(home, '.asdf', 'shims');
        const asdfShim = path.join(home, '.asdf', 'shims', 'nessy');
        const npmPrefix = path.join(
          home,
          '.asdf',
          'installs',
          'nodejs',
          '22.21.1',
        );
        const npmLog = path.join(tmpDir, 'npm-args.txt');
        mkdirSync(fakeBin, { recursive: true });
        mkdirSync(home, { recursive: true });

        writeFileSync(
          path.join(fakeBin, 'curl'),
          '#!/usr/bin/env sh\nexit 22\n',
        );
        writeFileSync(
          path.join(fakeBin, 'node'),
          [
            '#!/usr/bin/env sh',
            'if [ "$1" = "-p" ]; then',
            '  case "$2" in',
            '    *split*) echo 20 ;;',
            '    *) echo 20.19.0 ;;',
            '  esac',
            '  exit 0',
            'fi',
            'exit 0',
            '',
          ].join('\n'),
        );
        writeFileSync(
          path.join(fakeBin, 'npm'),
          [
            '#!/usr/bin/env sh',
            'case "$1" in',
            '  -v) echo 10.0.0 ;;',
            '  prefix) echo "$NESSY_FAKE_NPM_PREFIX" ;;',
            '  uninstall)',
            '    printf "%s\\n" "$*" >> "$NESSY_FAKE_NPM_LOG"',
            '    rm -f "$NESSY_FAKE_NPM_PREFIX/bin/nessy"',
            '    ;;',
            '  install)',
            '    printf "%s\\n" "$*" >> "$NESSY_FAKE_NPM_LOG"',
            '    mkdir -p "$NESSY_FAKE_NPM_PREFIX/bin"',
            '    printf "%s\\n" "#!/usr/bin/env sh" "echo 0.0.0-test" > "$NESSY_FAKE_NPM_PREFIX/bin/nessy"',
            '    chmod +x "$NESSY_FAKE_NPM_PREFIX/bin/nessy"',
            '    ;;',
            'esac',
            'exit 0',
            '',
          ].join('\n'),
        );
        writeFileSync(
          path.join(fakeBin, 'asdf'),
          [
            '#!/usr/bin/env sh',
            'if [ "$1" = "reshim" ]; then',
            '  mkdir -p "$HOME/.asdf/shims"',
            '  printf "%s\\n" "# asdf-plugin: nodejs 22.21.1" "@nestor/nessy-cli" > "$HOME/.asdf/shims/nessy"',
            '  chmod +x "$HOME/.asdf/shims/nessy"',
            '  exit 0',
            'fi',
            'if [ "$1" = "exec" ]; then',
            '  shift',
            '  "$@"',
            '  exit $?',
            'fi',
            'exit 0',
            '',
          ].join('\n'),
        );
        writeFileSync(
          path.join(fakeBin, 'nessy'),
          '#!/usr/bin/env sh\necho 0.0.0-npm\n',
        );
        for (const command of ['asdf', 'curl', 'node', 'npm', 'nessy']) {
          chmodSync(path.join(fakeBin, command), 0o755);
        }

        const output = execFileSync(
          'bash',
          [
            'scripts/installation/install-nessy-with-source-new.sh',
            '--method',
            'npm',
            '--version',
            '0.0.0-test',
            '--source',
            'smoke',
          ],
          {
            env: {
              ...process.env,
              HOME: home,
              PATH: `${fakeBin}:/usr/bin:/bin:/usr/sbin:/sbin`,
              NESSY_FAKE_NPM_LOG: npmLog,
              NESSY_FAKE_NPM_PREFIX: npmPrefix,
            },
            stdio: 'pipe',
          },
        ).toString();

        expect(output).not.toContain('Falling back to npm installation');
        expect(output).toContain('Reinstalling @nestor/nessy-cli@0.0.0-test');
        expect(output).toContain(
          'To use nessy in this current terminal after the installer exits, run:',
        );
        expect(
          output.includes(`path=('${asdfShims}' $path)`) ||
            output.includes(`nessy_bin_dir='${asdfShims}'`),
        ).toBe(true);
        expect(output).not.toContain(
          `Removed stale Nessy executable: ${asdfShim}`,
        );
        expect(existsSync(asdfShim)).toBe(true);
        expect(readScript(npmLog)).toContain(
          'uninstall -g @nestor/nessy-cli --registry',
        );
        expect(readScript(npmLog)).toContain(
          'install -g @nestor/nessy-cli@0.0.0-test --force --registry',
        );
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    },
  );

  itOnUnix('ignores PATH curl when detect archive is unavailable', () => {
    const tmpDir = mkdtempSync(path.join(tmpdir(), 'nessy-install-test-'));

    try {
      const fakeBin = path.join(tmpDir, 'bin');
      const curlLog = path.join(tmpDir, 'curl-used.txt');
      const npmLog = path.join(tmpDir, 'npm-args.txt');
      mkdirSync(fakeBin, { recursive: true });
      writeFileSync(
        path.join(fakeBin, 'curl'),
        '#!/usr/bin/env sh\nprintf "used\\n" > "$NESSY_FAKE_CURL_LOG"\nexit 22\n',
      );
      chmodSync(path.join(fakeBin, 'curl'), 0o755);
      writeFileSync(
        path.join(fakeBin, 'npm'),
        '#!/usr/bin/env sh\nprintf "%s\\n" "$*" >> "$NESSY_FAKE_NPM_LOG"\nexit 0\n',
      );
      chmodSync(path.join(fakeBin, 'npm'), 0o755);

      let failureMessage = '';
      try {
        execFileSync(
          'bash',
          [
            'scripts/installation/install-nessy-with-source-new.sh',
            '--method',
            'detect',
            '--version',
            '0.0.0-test',
            '--source',
            'smoke',
          ],
          {
            env: {
              HOME: path.join(tmpDir, 'home'),
              PATH: `${fakeBin}:/usr/bin:/bin`,
              NESSY_FAKE_CURL_LOG: curlLog,
              NESSY_FAKE_NPM_LOG: npmLog,
            },
            stdio: 'pipe',
          },
        );
      } catch (error) {
        failureMessage = [
          error.message,
          error.stdout?.toString() || '',
          error.stderr?.toString() || '',
        ].join('\n');
      }

      expect(failureMessage).toContain(
        'Standalone archive is unavailable for 0.0.0-test',
      );
      expect(failureMessage).toContain(
        'rerun with --method npm to use user Node.js/npm explicitly',
      );
      expect(failureMessage).not.toContain('Falling back to npm installation');
      expect(existsSync(curlLog)).toBe(false);
      expect(existsSync(npmLog) ? readScript(npmLog) : '').not.toMatch(
        /(^|\n)(install|uninstall)\b/,
      );
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('Windows installer end-to-end', () => {
  itOnWindows(
    'installs a local standalone archive with checksum verification',
    () => {
      const tmpDir = mkdtempSync(path.join(tmpdir(), 'nessy-install-test-'));

      try {
        const archive = createFakeWindowsStandaloneArchive(tmpDir);
        const installRoot = path.join(tmpDir, 'install');
        const home = path.join(tmpDir, 'home');
        runWindowsInstaller(archive, installRoot, home);

        expect(existsSync(path.join(installRoot, 'bin', 'nessy.cmd'))).toBe(
          true,
        );
        expect(
          existsSync(path.join(installRoot, 'nessy-cli', 'node', 'node.exe')),
        ).toBe(true);
        expect(readScript(path.join(home, '.nessy', 'source.json'))).toContain(
          '"source": "smoke"',
        );

        const version = runWindowsCommand(
          `call "${path.join(installRoot, 'bin', 'nessy.cmd')}" --version`,
          { USERPROFILE: home },
        )
          .toString()
          .trim();
        expect(version).toBe('0.0.0-smoke');
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    },
  );

  itOnWindows('rejects a tampered local archive', () => {
    const tmpDir = mkdtempSync(path.join(tmpdir(), 'nessy-install-test-'));

    try {
      const archive = createFakeWindowsStandaloneArchive(tmpDir);
      appendFileSync(archive, 'tamper');

      expect(() =>
        runWindowsInstaller(
          archive,
          path.join(tmpDir, 'install'),
          path.join(tmpDir, 'home'),
        ),
      ).toThrow(/Checksum verification failed/);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  itOnWindows('rejects unsafe environment-derived install paths', () => {
    const tmpDir = mkdtempSync(path.join(tmpdir(), 'nessy-install-test-'));

    try {
      const archive = createFakeWindowsStandaloneArchive(tmpDir);
      const marker = path.join(tmpDir, 'pwned.txt');

      expect(() =>
        runWindowsInstaller(
          archive,
          path.join(tmpDir, 'install'),
          path.join(tmpDir, 'home'),
          'standalone',
          {
            NESSY_INSTALL_ROOT: `${path.join(tmpDir, 'install')}" & echo pwned > "${marker}" & "`,
          },
        ),
      ).toThrow(/unsafe command characters/);
      expect(existsSync(marker)).toBe(false);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

function ensureMinimalDist() {
  if (existsSync('dist')) {
    return false;
  }

  // Mirrors DIST_REQUIRED_PATHS in scripts/create-standalone-package.js — a
  // missing entry here fails packaging long before the assertion under test.
  const packageVersion = JSON.parse(readScript('package.json')).version;
  mkdirSync('dist/chunks', { recursive: true });
  mkdirSync('dist/vendor', { recursive: true });
  mkdirSync('dist/bundled/nc-helper/docs', { recursive: true });
  mkdirSync('dist/certs', { recursive: true });
  writeFileSync(
    'dist/cli.js',
    `console.log(${JSON.stringify(packageVersion)});\n`,
  );
  writeFileSync(
    'dist/package.json',
    JSON.stringify({ name: '@nestor/nessy-cli', version: '0.0.0' }),
  );
  // [nessy-fork] statist-trusted-ca
  for (const certificate of ['tinkoff-bundle.crt', 'russian-root-ca.crt']) {
    writeFileSync(
      path.join('dist', 'certs', certificate),
      '-----BEGIN CERTIFICATE-----\nfixture\n-----END CERTIFICATE-----\n',
    );
  }
  return true;
}

function createFakeNodeArchive(tmpDir, options = {}) {
  const fakeNodeDir = path.join(tmpDir, 'node-v20.0.0-linux-x64');
  mkdirSync(path.join(fakeNodeDir, 'bin'), { recursive: true });
  writeFileSync(
    path.join(fakeNodeDir, 'bin', 'node'),
    '#!/usr/bin/env sh\necho 0.0.0-smoke\n',
  );
  chmodSync(path.join(fakeNodeDir, 'bin', 'node'), 0o755);

  if (options.withSafeNodeSymlink) {
    mkdirSync(path.join(fakeNodeDir, 'lib'), { recursive: true });
    writeFileSync(path.join(fakeNodeDir, 'lib', 'npm-cli.js'), 'npm cli\n');
    symlinkSync('../lib/npm-cli.js', path.join(fakeNodeDir, 'bin', 'npm'));
  }

  if (options.withEscapingNodeSymlink) {
    const outsideTarget = path.join(tmpDir, 'outside-node-helper.js');
    writeFileSync(outsideTarget, 'outside\n');
    symlinkSync(outsideTarget, path.join(fakeNodeDir, 'bin', 'npm'));
  }

  if (options.withNodeSymlinkCycle) {
    symlinkSync('../bin', path.join(fakeNodeDir, 'bin', 'cycle'));
  }

  const archive = path.join(tmpDir, 'node-v20.0.0-linux-x64.tar.gz');
  execFileSync(
    'tar',
    ['-czf', archive, '-C', tmpDir, path.basename(fakeNodeDir)],
    {
      env: { ...process.env, LC_ALL: 'C' },
      stdio: 'ignore',
    },
  );
  return archive;
}

function createBadUnixNodeArchive(tmpDir) {
  const fakeRuntimeDir = path.join(tmpDir, 'not-node');
  mkdirSync(fakeRuntimeDir, { recursive: true });
  writeFileSync(path.join(fakeRuntimeDir, 'README.txt'), 'not node\n');

  const archive = path.join(tmpDir, 'bad-runtime.tar.gz');
  execFileSync('tar', ['-czf', archive, '-C', tmpDir, 'not-node'], {
    env: { ...process.env, LC_ALL: 'C' },
    stdio: 'ignore',
  });
  return archive;
}

function createBadWindowsNodeArchive(tmpDir) {
  const fakeRuntimeDir = path.join(tmpDir, 'not-node');
  mkdirSync(fakeRuntimeDir, { recursive: true });
  writeFileSync(path.join(fakeRuntimeDir, 'README.txt'), 'not node\n');

  const archive = path.join(tmpDir, 'bad-runtime.zip');
  createZipForTest(archive, tmpDir, path.basename(fakeRuntimeDir));
  return archive;
}

function createFakeWindowsNodeArchive(tmpDir) {
  const fakeNodeDir = path.join(tmpDir, 'node-v20.0.0-win-x64');
  mkdirSync(fakeNodeDir, { recursive: true });
  writeFileSync(path.join(fakeNodeDir, 'node.exe'), 'fake node.exe\n');

  const archive = path.join(tmpDir, 'node-v20.0.0-win-x64.zip');
  createZipForTest(archive, tmpDir, path.basename(fakeNodeDir));
  return archive;
}

function createFakeWindowsStandaloneArchive(tmpDir) {
  const packageRoot = path.join(tmpDir, 'nessy-cli');
  const outDir = path.join(tmpDir, 'out');
  mkdirSync(path.join(packageRoot, 'bin'), { recursive: true });
  mkdirSync(path.join(packageRoot, 'node'), { recursive: true });
  mkdirSync(outDir, { recursive: true });

  writeFileSync(
    path.join(packageRoot, 'bin', 'nessy.cmd'),
    ['@echo off', 'echo 0.0.0-smoke', ''].join('\r\n'),
  );
  writeFileSync(path.join(packageRoot, 'node', 'node.exe'), 'fake node.exe\n');
  writeFileSync(
    path.join(packageRoot, 'manifest.json'),
    JSON.stringify({ name: '@nestor/nessy-cli' }),
  );

  const archive = path.join(outDir, 'nessy-cli-win-x64.zip');
  createZipForTest(archive, tmpDir, path.basename(packageRoot));
  writeChecksumFile(outDir, path.basename(archive));
  return archive;
}

function currentUnixStandaloneArchiveName() {
  const osByPlatform = {
    darwin: 'darwin',
    linux: 'linux',
  };
  const archByProcessArch = {
    arm64: 'arm64',
    x64: 'x64',
  };
  const os = osByPlatform[process.platform];
  const arch = archByProcessArch[process.arch];

  if (!os || !arch) {
    throw new Error(
      `Unsupported test platform: ${process.platform}/${process.arch}`,
    );
  }

  return `nessy-cli-${os}-${arch}.tar.gz`;
}

function createFakeUnixStandaloneArchive(outDir, archiveName, version) {
  const packageRoot = path.join(outDir, 'nessy-cli');
  mkdirSync(path.join(packageRoot, 'bin'), { recursive: true });
  mkdirSync(path.join(packageRoot, 'node', 'bin'), { recursive: true });
  writeFileSync(
    path.join(packageRoot, 'bin', 'nessy'),
    `#!/usr/bin/env sh\nif [ "$1" = "--version" ]; then echo ${version}; exit 0; fi\nif [ -n "$NESSY_EXTENSION_LOG" ]; then printf '%s\\n' "$@" > "$NESSY_EXTENSION_LOG"; fi\nif [ "$NESSY_EXTENSION_RESULT" = "already-installed" ]; then echo 'Extension "nessy-default-extension" is already installed. Please uninstall it first.' >&2; exit 1; fi\n`,
  );
  chmodSync(path.join(packageRoot, 'bin', 'nessy'), 0o755);
  writeFileSync(
    path.join(packageRoot, 'node', 'bin', 'node'),
    '#!/usr/bin/env sh\necho fake node\n',
  );
  chmodSync(path.join(packageRoot, 'node', 'bin', 'node'), 0o755);
  writeFileSync(
    path.join(packageRoot, 'manifest.json'),
    JSON.stringify({
      name: '@nestor/nessy-cli',
      version,
      target: archiveName.replace(/^nessy-cli-/, '').replace(/\.tar\.gz$/, ''),
    }),
  );

  const archive = path.join(outDir, archiveName);
  execFileSync(
    'tar',
    ['-czf', archive, '-C', outDir, path.basename(packageRoot)],
    {
      env: { ...process.env, LC_ALL: 'C' },
      stdio: 'ignore',
    },
  );
  rmSync(packageRoot, { recursive: true, force: true });
  writeChecksumFile(outDir, archiveName);
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

function extractZipForTest(archive, destination) {
  if (process.platform === 'win32') {
    execFileSync(
      'powershell',
      [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        'Expand-Archive -LiteralPath $env:NESSY_TEST_ZIP_ARCHIVE -DestinationPath $env:NESSY_TEST_ZIP_DESTINATION -Force',
      ],
      {
        env: {
          ...process.env,
          NESSY_TEST_ZIP_ARCHIVE: archive,
          NESSY_TEST_ZIP_DESTINATION: destination,
        },
        stdio: 'ignore',
      },
    );
    return;
  }

  execFileSync('unzip', ['-q', archive, '-d', destination], {
    stdio: 'ignore',
  });
}

function packageFakeStandalone(tmpDir, nodeArchiveOptions = {}) {
  const outDir = path.join(tmpDir, 'out');
  mkdirSync(outDir, { recursive: true });
  execFileSync(
    'node',
    [
      'scripts/create-standalone-package.js',
      '--target',
      'linux-x64',
      '--node-archive',
      createFakeNodeArchive(tmpDir, nodeArchiveOptions),
      '--out-dir',
      outDir,
      '--version',
      '0.0.0-smoke',
    ],
    { stdio: 'pipe' },
  );
  return path.join(outDir, 'nessy-cli-linux-x64.tar.gz');
}

function runUnixInstaller(
  archive,
  installRoot,
  home,
  method = 'standalone',
  extraEnv = {},
) {
  mkdirSync(home, { recursive: true });
  try {
    return execFileSync(
      'bash',
      [
        'scripts/installation/install-nessy-with-source-new.sh',
        '--method',
        method,
        '--archive',
        archive,
        '--source',
        'smoke',
      ],
      {
        env: {
          ...process.env,
          HOME: home,
          NESSY_INSTALL_ROOT: installRoot,
          NESSY_SKIP_DEFAULT_EXTENSION: '1',
          ...extraEnv,
        },
        stdio: 'pipe',
      },
    );
  } catch (error) {
    const processError = error;
    throw new Error(
      [
        processError.message,
        processError.stdout?.toString() || '',
        processError.stderr?.toString() || '',
      ].join('\n'),
    );
  }
}

function runWindowsInstaller(
  archive,
  installRoot,
  home,
  method = 'standalone',
  extraEnv = {},
) {
  mkdirSync(home, { recursive: true });
  try {
    return runWindowsCommand(
      [
        `call "${path.resolve('scripts/installation/install-nessy-with-source-new.bat')}"`,
        '--method',
        method,
        '--archive',
        `"${archive}"`,
        '--source',
        'smoke',
      ].join(' '),
      {
        USERPROFILE: home,
        NESSY_INSTALL_ROOT: installRoot,
        ...extraEnv,
      },
    );
  } catch (error) {
    const processError = error;
    throw new Error(
      [
        processError.message,
        processError.stdout?.toString() || '',
        processError.stderr?.toString() || '',
      ].join('\n'),
    );
  }
}

function runWindowsCommand(command, env = {}) {
  return execFileSync(process.env.ComSpec || 'cmd.exe', ['/d', '/c', command], {
    env: {
      ...process.env,
      ...env,
    },
    stdio: 'pipe',
    // cmd.exe parses the command string itself; preserve quoted paths.
    windowsVerbatimArguments: true,
  });
}

function createSymlinkStandaloneArchive(tmpDir) {
  const packageRoot = path.join(tmpDir, 'malicious', 'nessy-cli');
  mkdirSync(path.join(packageRoot, 'bin'), { recursive: true });
  mkdirSync(path.join(packageRoot, 'node', 'bin'), { recursive: true });
  symlinkSync('/usr/bin/env', path.join(packageRoot, 'bin', 'nessy'));
  writeFileSync(
    path.join(packageRoot, 'node', 'bin', 'node'),
    '#!/usr/bin/env sh\necho 0.0.0-smoke\n',
  );
  chmodSync(path.join(packageRoot, 'node', 'bin', 'node'), 0o755);
  writeFileSync(
    path.join(packageRoot, 'manifest.json'),
    JSON.stringify({ name: '@nestor/nessy-cli' }),
  );

  const outDir = path.join(tmpDir, 'out');
  mkdirSync(outDir, { recursive: true });
  const archive = path.join(outDir, 'nessy-cli-linux-x64.tar.gz');
  execFileSync(
    'tar',
    ['-czf', archive, '-C', path.dirname(packageRoot), 'nessy-cli'],
    {
      env: { ...process.env, LC_ALL: 'C' },
      stdio: 'ignore',
    },
  );
  writeChecksumFile(outDir, path.basename(archive));
  return archive;
}

function createTraversalStandaloneArchive(tmpDir) {
  const maliciousRoot = path.join(tmpDir, 'malicious');
  const packageRoot = path.join(maliciousRoot, 'nessy-cli');
  mkdirSync(path.join(packageRoot, 'bin'), { recursive: true });
  mkdirSync(path.join(packageRoot, 'node', 'bin'), { recursive: true });
  writeFileSync(
    path.join(packageRoot, 'bin', 'nessy'),
    '#!/usr/bin/env sh\necho 0.0.0-smoke\n',
  );
  chmodSync(path.join(packageRoot, 'bin', 'nessy'), 0o755);
  writeFileSync(
    path.join(packageRoot, 'node', 'bin', 'node'),
    '#!/usr/bin/env sh\necho 0.0.0-smoke\n',
  );
  chmodSync(path.join(packageRoot, 'node', 'bin', 'node'), 0o755);
  writeFileSync(
    path.join(packageRoot, 'manifest.json'),
    JSON.stringify({ name: '@nestor/nessy-cli' }),
  );
  writeFileSync(path.join(tmpDir, 'nessy-slip'), 'path traversal\n');

  const outDir = path.join(tmpDir, 'out');
  mkdirSync(outDir, { recursive: true });
  const archive = path.join(outDir, 'nessy-cli-linux-x64.zip');
  execFileSync('zip', ['-qr', archive, 'nessy-cli', '../nessy-slip'], {
    cwd: maliciousRoot,
    stdio: 'ignore',
  });
  writeChecksumFile(outDir, path.basename(archive));
  return archive;
}

function writeChecksumFile(outDir, archiveName) {
  const archive = path.join(outDir, archiveName);
  const hash = crypto
    .createHash('sha256')
    .update(readFileSync(archive))
    .digest('hex');
  writeFileSync(path.join(outDir, 'SHA256SUMS'), `${hash}  ${archiveName}\n`);
}
