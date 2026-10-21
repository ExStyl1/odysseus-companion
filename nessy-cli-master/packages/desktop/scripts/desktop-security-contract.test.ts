import { describe, expect, it } from 'bun:test';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import yaml from 'js-yaml';

const desktopRoot = join(import.meta.dir, '..');
const repositoryRoot = join(desktopRoot, '..', '..');

function readRepositoryFile(relativePath: string): string {
  return readFileSync(join(repositoryRoot, relativePath), 'utf8');
}

describe('desktop distribution security contract', () => {
  it('requires signed Windows executables and signed updates', () => {
    const config = yaml.load(
      readFileSync(
        join(desktopRoot, 'apps/electron/electron-builder.yml'),
        'utf8',
      ),
    ) as {
      win: {
        signAndEditExecutable: boolean;
        signExts: string[];
        verifyUpdateCodeSignature: boolean;
      };
      nsis: { packElevateHelper: boolean };
    };

    expect(config.win.verifyUpdateCodeSignature).toBe(true);
    expect(config.win.signAndEditExecutable).toBe(true);
    expect(config.win.signExts).toContain('.exe');
    expect(config.win.signExts).toContain('.dll');
    expect(config.nsis.packElevateHelper).toBe(true);
  });

  it('requires code signing for GitLab Windows release builds', () => {
    const pipeline = readFileSync(
      join(desktopRoot, '..', '..', '.gitlab-ci.yml'),
      'utf8',
    );

    expect(pipeline).toContain(
      'WIN_CSC_LINK and WIN_CSC_KEY_PASSWORD are required',
    );
    expect(pipeline).toContain('.windows-signing.pfx');
    expect(pipeline).toContain('| base64 -D > "$WIN_CSC_FILE"');
    expect(pipeline).toContain('--config.forceCodeSigning=true');
    expect(pipeline).toContain(
      'unset WIN_CSC_LINK WIN_CSC_KEY_PASSWORD CSC_LINK CSC_KEY_PASSWORD',
    );
    expect(pipeline).toContain('scripts/verify-windows-release.sh');
    const verifier = readRepositoryFile(
      'packages/desktop/scripts/verify-windows-release.sh',
    );
    expect(verifier).toContain('Signature verification: ok');
    expect(verifier).toContain('Missing or invalid Authenticode signature');
  });

  it('rejects an unsigned DLL even when osslsigncode exits successfully', () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'windows-signature-test-'));
    const appDir = join(fixtureRoot, 'win-unpacked');
    const fakeVerifier = join(fixtureRoot, 'osslsigncode');
    mkdirSync(appDir);
    writeFileSync(join(appDir, 'chromium.dll'), 'unsigned fixture');
    writeFileSync(
      fakeVerifier,
      '#!/usr/bin/env bash\necho "No signature found."\necho "Succeeded"\nexit 0\n',
    );
    chmodSync(fakeVerifier, 0o755);

    try {
      const result = spawnSync(
        join(desktopRoot, 'scripts/verify-windows-release.sh'),
        {
          env: {
            ...process.env,
            OSSLSIGNCODE: fakeVerifier,
            WINDOWS_RELEASE_DIR: fixtureRoot,
          },
          encoding: 'utf8',
        },
      );

      expect(result.status).not.toBe(0);
      expect(result.stdout).toContain(
        'Missing or invalid Authenticode signature: chromium.dll',
      );
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it('signs and verifies Linux AppImage release artifacts', () => {
    const pipeline = readRepositoryFile('.gitlab-ci.yml')
    const signer = readRepositoryFile('packages/desktop/scripts/sign-linux-release.sh')
    const uploader = readRepositoryFile('packages/desktop/scripts/upload.ts')
    const updater = readRepositoryFile(
      'packages/desktop/apps/electron/src/main/auto-update.ts',
    )
    const verifier = readRepositoryFile(
      'packages/desktop/apps/electron/src/main/linux-update-signature.ts',
    )

    expect(pipeline).toContain('scripts/sign-linux-release.sh')
    expect(signer).toContain('--detach-sign')
    expect(signer).toContain('gpg --batch --verify')
    expect(signer).toContain('LINUX_GPG_KEY_FINGERPRINT')
    expect(signer).toContain('nessy-cli-desktop.gpg-key.asc')
    expect(signer).toContain("'*-linux*.yml'")
    expect(uploader).toContain('Missing GPG signature')
    expect(uploader).toContain('Missing GPG public key')
    expect(updater).toContain('await verifyLinuxUpdate(info, existing.filePath)')
    expect(updater).toContain('await verifyDetachedFile(')
    expect(updater).toContain('autoUpdater.autoInstallOnAppQuit = false')
    expect(updater).toContain(
      'Verified Linux update does not match the pending installer',
    )
    expect(verifier).toContain('0A2987B9F751BCCEC510D3C9060891CCCD47BDA9')
    expect(verifier).toContain("require('openpgp')")
    expect(verifier).not.toContain("from 'openpgp'")
    expect(verifier).not.toContain("from 'child_process'")
  })
});

describe('desktop macOS distribution security contract', () => {
  it('verifies vendored runtimes against repository-controlled hashes', () => {
    const downloader = readRepositoryFile(
      'packages/desktop/scripts/build/common.ts',
    );
    const pipeline = readRepositoryFile('.gitlab-ci.yml');
    const releaseScripts = [
      'build-dmg.sh',
      'build-linux.sh',
      'build-win.ps1',
    ]
      .map((name) =>
        readRepositoryFile(
          `packages/desktop/apps/electron/scripts/${name}`,
        ),
      )
      .join('\n');

    expect(downloader).toContain('BUN_BINARY_SHA256');
    expect(downloader).toContain('UV_BINARY_SHA256');
    expect(downloader).toContain('verifyBundledRuntime');
    expect(downloader).not.toContain('github.com/oven-sh/bun/releases');
    expect(downloader).not.toContain('github.com/astral-sh/uv/releases');
    expect(pipeline).not.toContain('gh attestation');
    expect(releaseScripts).not.toContain('github.com/oven-sh/bun/releases');
    expect(releaseScripts).not.toContain('Invoke-WebRequest');
    expect(releaseScripts).not.toContain('rm -rf "$ELECTRON_DIR/vendor"');
    expect(releaseScripts).toContain('electron:prepare:runtimes');

    const devLauncher = readRepositoryFile(
      'packages/desktop/scripts/electron-dev.ts',
    );
    expect(devLauncher).toContain('await verifyBundledBun(config)');
    expect(devLauncher).toContain('await verifyBundledUv(config)');
    expect(devLauncher).toContain('process.env.CRAFT_BUN = getBundledBunPath');
    expect(devLauncher).toContain('process.env.CRAFT_UV = getBundledUvPath');
    expect(devLauncher).not.toContain("cmd: ['bun'");

    const packageJson = JSON.parse(
      readRepositoryFile('packages/desktop/package.json'),
    ) as { scripts: Record<string, string> };
    expect(packageJson.scripts['electron:start']).toBe(
      '$npm_execpath run scripts/electron-start.ts',
    );
    expect(packageJson.scripts['electron:dev']).toStartWith('$npm_execpath ');
    expect(packageJson.scripts['electron:dev:terminal']).toStartWith(
      '$npm_execpath ',
    );
    const devStarter = readRepositoryFile(
      'packages/desktop/scripts/electron-start.ts',
    );
    expect(devStarter).toContain('await verifyBundledBun(config)');
    expect(devStarter).toContain('await verifyBundledUv(config)');
    expect(devStarter).toContain("cmd: [bunPath, 'run', 'electron:build']");
  });

  it('provisions and verifies bundled runtimes for release builds', () => {
    const packageJson = JSON.parse(
      readRepositoryFile('packages/desktop/package.json'),
    ) as {
      scripts: Record<string, string>;
    };
    const verifier = readRepositoryFile(
      'packages/desktop/scripts/verify-macos-release.sh',
    );
    const main = readRepositoryFile(
      'packages/desktop/apps/electron/src/main/index.ts',
    );
    const unixWrapper = readRepositoryFile(
      'packages/desktop/apps/electron/resources/bin/craft-agent',
    );
    const windowsWrapper = readRepositoryFile(
      'packages/desktop/apps/electron/resources/bin/craft-agent.cmd',
    );

    expect(packageJson.scripts['electron:dist:mac:no-publish']).toStartWith(
      'bun run electron:prepare:runtimes darwin &&',
    );
    expect(packageJson.scripts['electron:dist:win:no-publish']).toStartWith(
      'bun run electron:prepare:runtimes win32 &&',
    );
    expect(packageJson.scripts['electron:dist:linux:no-publish']).toStartWith(
      'bun run electron:prepare:runtimes linux &&',
    );
    expect(verifier).toContain('vendor/bun/darwin-$executable_arch/bun');
    expect(verifier).toContain('resources/bin/darwin-$executable_arch/uv');
    expect(main).toContain('delete process.env.CRAFT_BUN');
    expect(unixWrapper).not.toContain('${CRAFT_BUN:-bun}');
    expect(windowsWrapper).not.toContain('set "CRAFT_BUN_BIN=bun"');
  });

  it('verifies the downloaded app before replacing the installation', () => {
    const installer = readRepositoryFile(
      'packages/desktop/scripts/install-app.sh',
    );
    const signatureCheck = installer.indexOf(
      'codesign --verify --deep --strict',
    );
    const removal = installer.indexOf('rm -rf "$INSTALL_DIR/$APP_NAME"');

    expect(installer).not.toContain('xattr -rd com.apple.quarantine');
    expect(installer).toContain(
      'EXPECTED_TEAM_ID="__MACOS_EXPECTED_TEAM_ID__"',
    );
    expect(installer).toContain(
      'EXPECTED_BUNDLE_ID="__MACOS_EXPECTED_BUNDLE_ID__"',
    );
    expect(installer).toContain('APP_BUNDLE_ID="$EXPECTED_BUNDLE_ID"');
    expect(installer).toContain('spctl --assess --type execute');
    expect(signatureCheck).toBeGreaterThan(-1);
    expect(removal).toBeGreaterThan(signatureCheck);
  });

  it('forces signing, notarizes and verifies release artifacts', () => {
    const pipeline = readRepositoryFile('.gitlab-ci.yml');
    const fastfile = readRepositoryFile('fastlane/Fastfile');
    const verifier = readRepositoryFile(
      'packages/desktop/scripts/verify-macos-release.sh',
    );

    expect(pipeline).toContain('--config.forceCodeSigning=true');
    expect(pipeline).toContain('MACOS_EXPECTED_TEAM_ID:');
    expect(pipeline).toContain(
      's#__MACOS_EXPECTED_TEAM_ID__#$MACOS_EXPECTED_TEAM_ID#g',
    );
    expect(pipeline).toContain('build_desktop_macos_arm64:');
    expect(pipeline).toContain('build_desktop_macos_x64:');
    expect(pipeline).toContain('rules: *build_desktop_rules');
    expect(pipeline).not.toContain('MACOS_RELEASE_BUILD');
    expect(pipeline).toContain('bundle exec fastlane notarize_app');
    expect(pipeline).toContain('Nessy-CLI-Desktop-*.dmg');
    expect(pipeline).toContain(
      'rm -f packages/desktop/apps/electron/release/*.dmg.blockmap',
    );
    expect(pipeline).toContain('merge-macos-release-manifests.ts');
    expect(pipeline).toContain('scripts/verify-macos-release.sh');
    expect(fastfile).toContain('Dir[File.join(release_dir, "*.dmg")]');
    expect(fastfile).toContain('Dir[File.join(release_dir, "*.zip")]');
    expect(fastfile).toContain('package: dmg_path');
    expect(fastfile).not.toContain('package: zip_path');
    expect(fastfile).toContain('skip_stapling: false');
    expect(fastfile).toContain('sh("xcrun", "stapler", "staple", app_path)');
    expect(fastfile).toContain('"--keepParent"');
    expect(fastfile).toContain('"blockmap"');
    expect(verifier).toContain('codesign --verify --deep --strict');
    expect(verifier).toContain('xcrun stapler validate "$app_path"');
    expect(verifier).toContain('xcrun stapler validate "$dmg_path"');
    expect(verifier).toContain('verify_app "${app_paths[0]}" true');
    expect(verifier).toContain('verify_app "${app_paths[0]}" false');
    expect(verifier).toContain('expected_team_id="35CMT9F8X3"');
  });

  it('checks downloaded macOS updates with Gatekeeper', () => {
    const updater = readRepositoryFile(
      'packages/desktop/apps/electron/src/main/auto-update-signature.ts',
    );
    const signatureCheck = updater.indexOf(
      'getMacAppCodeSignatureStatus(appBundlePath)',
    );
    const gatekeeperCheck = updater.indexOf("'/usr/sbin/spctl'");

    expect(gatekeeperCheck).toBeGreaterThan(signatureCheck);
    expect(updater).toContain(
      "['--assess', '--type', 'execute', '--verbose=2', appBundlePath]",
    );
  });
});
