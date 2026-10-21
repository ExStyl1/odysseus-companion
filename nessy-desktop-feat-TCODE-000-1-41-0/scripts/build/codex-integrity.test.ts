/**
 * The packaging gate for the codex runtime's integrity pin.
 *
 * Live defect (signed 1.25.0): the shipped app refused to spawn its own codex
 * runtime — `codex-app-server SHA mismatch for darwin-arm64: on-disk 52f6105d…
 * ≠ manifest ac4fc97a…`. The release build re-signed the nested binary, which
 * rewrites the Mach-O, and the runtime pin records the UNSIGNED upstream hash.
 * Every prior gate missed it because an unsigned local build is byte-identical
 * to upstream, so the pin passed everywhere except in the artifact users get.
 *
 * These tests drive the assertion that closes the class: the binary the
 * PACKAGED app will actually spawn must satisfy the same pin the app checks.
 */
import { test, expect, describe, beforeEach, afterEach } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  findBundledCodexBinaries,
  verifyBundledCodexIntegrity,
  type CodexIntegrityManifest,
} from './codex-integrity.ts';

let workspace: string;

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex').toLowerCase();
}

/** Write `<root>/Contents/Resources/app/resources/bin/codex/<dir>/<name>`, mirroring the packaged .app. */
function stageBundledBinary(root: string, platformDir: string, name: string, bytes: Buffer): string {
  const dir = join(root, 'Nessy Desktop.app', 'Contents', 'Resources', 'app', 'resources', 'bin', 'codex', platformDir);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, bytes);
  return path;
}

/** F1.1216 — the code-mode host ships beside every app-server; its own pin sits beside the app-server's. */
const HOST_BYTES = Buffer.from('the upstream codex-code-mode-host bytes');

function manifestPinning(platformDir: string, sha: string): CodexIntegrityManifest {
  return {
    upstream: { tag: 'rust-v0.0.0-test' },
    binaries: { [platformDir]: { binarySha256: sha, codeModeHostSha256: sha256(HOST_BYTES) } },
  };
}

/** The app-server plus the code-mode host it carries — what a codex-enabled build ships per platform. */
function stageRuntime(root: string, platformDir: string, bytes: Buffer): string {
  stageBundledBinary(root, platformDir, 'codex-code-mode-host', HOST_BYTES);
  return stageBundledBinary(root, platformDir, 'codex-app-server', bytes);
}

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'codex-integrity-'));
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

describe('findBundledCodexBinaries', () => {
  test('finds a codex binary at the packaged .app depth and reads its platform dir', () => {
    const path = stageBundledBinary(workspace, 'darwin-arm64', 'codex-app-server', Buffer.from('upstream'));

    const found = findBundledCodexBinaries([workspace]);

    expect(found).toEqual([{ path, platformDir: 'darwin-arm64', basename: 'codex-app-server' }]);
  });

  test('ignores files that are not under a bin/codex/<platform> directory', () => {
    const stray = join(workspace, 'resources', 'bin', 'codex-app-server');
    mkdirSync(join(workspace, 'resources', 'bin'), { recursive: true });
    writeFileSync(stray, 'not the bundled runtime');

    expect(findBundledCodexBinaries([workspace])).toEqual([]);
  });

  test('skips roots that do not exist rather than throwing', () => {
    const path = stageBundledBinary(workspace, 'win32-x64', 'codex-app-server.exe', Buffer.from('upstream'));

    const found = findBundledCodexBinaries([join(workspace, 'no-such-dir'), workspace]);

    expect(found.map(entry => entry.path)).toEqual([path]);
  });
});

describe('verifyBundledCodexIntegrity', () => {
  test('accepts a bundled binary whose bytes still match the manifest pin', () => {
    const bytes = Buffer.from('the upstream codex-app-server bytes');
    stageRuntime(workspace, 'darwin-arm64', bytes);

    const result = verifyBundledCodexIntegrity({
      roots: [workspace],
      manifest: manifestPinning('darwin-arm64', sha256(bytes)),
      requirePlatformDirs: ['darwin-arm64'],
    });

    expect(result.failures).toEqual([]);
    expect(result.verified.map(entry => entry.basename)).toEqual(['codex-app-server', 'codex-code-mode-host']);
  });

  // THE DEFECT. Code signing rewrites the Mach-O in place; the pin records the
  // hash of what we fetched. Before this gate existed the build shipped happily
  // and the app refused to spawn at runtime.
  test('rejects a bundled binary that a signing step rewrote after the fetch', () => {
    const bytes = Buffer.from('the upstream codex-app-server bytes');
    const pinned = sha256(bytes);
    const path = stageRuntime(workspace, 'darwin-arm64', bytes);
    appendFileSync(path, Buffer.from('<embedded code signature>'));

    const result = verifyBundledCodexIntegrity({
      roots: [workspace],
      manifest: manifestPinning('darwin-arm64', pinned),
      requirePlatformDirs: ['darwin-arm64'],
    });

    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]!.kind).toBe('sha-mismatch');
    expect(result.failures[0]!.path).toBe(path);
    expect(result.failures[0]!.message).toMatch(/SHA mismatch/i);
    // The diagnosis has to name the cause, or the next reader repeats the search.
    expect(result.failures[0]!.message).toMatch(/sign/i);
  });

  test('fails when a required platform dir shipped no codex-app-server at all', () => {
    const result = verifyBundledCodexIntegrity({
      roots: [workspace],
      manifest: manifestPinning('darwin-arm64', sha256(Buffer.from('x'))),
      requirePlatformDirs: ['darwin-arm64'],
    });

    // Both the app-server and the code-mode host it carries are missing.
    expect(result.failures.map(f => f.kind)).toEqual(['missing-required', 'missing-required']);
  });

  // F1.1216 — every code_mode_only model (gpt-5.6, gpt-6, gpt-6.1, codex-auto-review)
  // has no tools without the host, so a codex-enabled package without it fails.
  test('fails when the app-server shipped without its codex-code-mode-host', () => {
    const bytes = Buffer.from('upstream');
    stageBundledBinary(workspace, 'darwin-arm64', 'codex-app-server', bytes);

    const result = verifyBundledCodexIntegrity({
      roots: [workspace],
      manifest: manifestPinning('darwin-arm64', sha256(bytes)),
      requirePlatformDirs: ['darwin-arm64'],
    });

    expect(result.failures.map(f => f.kind)).toEqual(['missing-required']);
    expect(result.failures[0]!.message).toMatch(/codex-code-mode-host/);
    expect(result.failures[0]!.message).toMatch(/code_mode_only/);
  });

  test('checks the code-mode host against its own pin, not the app-server pin', () => {
    const bytes = Buffer.from('upstream');
    stageBundledBinary(workspace, 'win32-x64', 'codex-app-server.exe', bytes);
    const host = stageBundledBinary(workspace, 'win32-x64', 'codex-code-mode-host.exe', Buffer.from('swapped host'));

    const result = verifyBundledCodexIntegrity({
      roots: [workspace],
      manifest: manifestPinning('win32-x64', sha256(bytes)),
      requirePlatformDirs: ['win32-x64'],
    });

    expect(result.failures.map(f => f.kind)).toEqual(['sha-mismatch']);
    expect(result.failures[0]!.path).toBe(host);
    expect(result.verified.map(entry => entry.basename)).toEqual(['codex-app-server.exe']);
  });

  test('fails when the codex runtime is disabled but its code-mode host shipped anyway', () => {
    stageBundledBinary(workspace, 'darwin-arm64', 'codex-code-mode-host', HOST_BYTES);

    const result = verifyBundledCodexIntegrity({
      roots: [workspace],
      manifest: manifestPinning('darwin-arm64', sha256(Buffer.from('x'))),
      forbidAppServer: true,
    });

    expect(result.failures.map(f => f.kind)).toEqual(['forbidden-app-server']);
    expect(result.failures[0]!.message).toMatch(/codex-code-mode-host/);
  });

  test('fails when a wrong-arch codex-app-server rode along', () => {
    const bytes = Buffer.from('upstream');
    stageRuntime(workspace, 'darwin-arm64', bytes);
    stageBundledBinary(workspace, 'darwin-x64', 'codex-app-server', bytes);
    const sha = sha256(bytes);

    const result = verifyBundledCodexIntegrity({
      roots: [workspace],
      manifest: {
        upstream: { tag: 'rust-v0.0.0-test' },
        binaries: {
          'darwin-arm64': { binarySha256: sha, codeModeHostSha256: sha256(HOST_BYTES) },
          'darwin-x64': { binarySha256: sha },
        },
      },
      requirePlatformDirs: ['darwin-arm64'],
    });

    expect(result.failures.map(f => f.kind)).toEqual(['unexpected-platform']);
  });

  test('fails when the codex runtime is disabled for this build but a binary shipped anyway', () => {
    const bytes = Buffer.from('upstream');
    stageBundledBinary(workspace, 'darwin-arm64', 'codex-app-server', bytes);

    const result = verifyBundledCodexIntegrity({
      roots: [workspace],
      manifest: manifestPinning('darwin-arm64', sha256(bytes)),
      forbidAppServer: true,
    });

    expect(result.failures.map(f => f.kind)).toEqual(['forbidden-app-server']);
  });

  test('fails on an executable shipped inside the codex dir that no manifest entry pins', () => {
    const bytes = Buffer.from('upstream');
    stageRuntime(workspace, 'darwin-arm64', bytes);
    stageBundledBinary(workspace, 'darwin-arm64', 'smuggled-helper', Buffer.from('unpinned'));

    const result = verifyBundledCodexIntegrity({
      roots: [workspace],
      manifest: manifestPinning('darwin-arm64', sha256(bytes)),
      requirePlatformDirs: ['darwin-arm64'],
    });

    expect(result.failures.map(f => f.kind)).toEqual(['unpinned']);
  });

  test('verifies the Windows restricted-token sandbox trio against the windowsSandbox pins', () => {
    const runner = Buffer.from('codex-command-runner');
    stageBundledBinary(workspace, 'win32-x64', 'codex-command-runner.exe', runner);

    const result = verifyBundledCodexIntegrity({
      roots: [workspace],
      manifest: {
        upstream: { tag: 'rust-v0.0.0-test' },
        windowsSandbox: {
          'win32-x64': { files: { 'codex-command-runner.exe': { binarySha256: sha256(runner) } } },
        },
      },
      forbidAppServer: true,
    });

    expect(result.failures).toEqual([]);
    expect(result.verified).toHaveLength(1);
  });

  /**
   * The gate's second question — "will the app spawn this?" — asked of the real
   * runtime function (injected here). It is not a duplicate of the hash: it is
   * the only thing that catches the gate and the runtime reading DIFFERENT pins,
   * which is what let the original defect through a green build.
   */
  test('fails when the pin matches but the real runtime gate still refuses the binary', () => {
    const bytes = Buffer.from('upstream');
    const path = stageRuntime(workspace, 'darwin-arm64', bytes);

    const result = verifyBundledCodexIntegrity({
      roots: [workspace],
      manifest: manifestPinning('darwin-arm64', sha256(bytes)),
      requirePlatformDirs: ['darwin-arm64'],
      runtimeVerify: () => {
        throw new Error('codex-app-server refused for darwin-arm64 — both integrity arms failed');
      },
    });

    expect(result.failures.map(f => f.kind)).toEqual(['runtime-refused']);
    expect(result.failures[0]!.path).toBe(path);
    expect(result.failures[0]!.message).toMatch(/drifted apart/i);
  });

  // A re-signed-by-us binary is the case where the runtime fallback rescues the
  // app. The build still fails — byte identity with the pinned upstream release
  // is the property signIgnore holds — but it must say which of the two futures
  // this is, or the next reader re-derives it from a user report.
  test('a mismatch the runtime fallback would accept still fails, and says so', () => {
    const bytes = Buffer.from('the upstream codex-app-server bytes');
    const pinned = sha256(bytes);
    const path = stageRuntime(workspace, 'darwin-arm64', bytes);
    appendFileSync(path, Buffer.from('<our Developer ID signature>'));

    const result = verifyBundledCodexIntegrity({
      roots: [workspace],
      manifest: manifestPinning('darwin-arm64', pinned),
      requirePlatformDirs: ['darwin-arm64'],
      runtimeVerify: () => {/* signed by our team → the runtime accepts it */},
    });

    expect(result.failures.map(f => f.kind)).toEqual(['sha-mismatch']);
    expect(result.failures[0]!.message).toMatch(/WOULD still spawn it/);
    expect(result.failures[0]!.message).toMatch(/restore signIgnore/);
  });

  // The runtime verifies nothing but the app-server, and the sandbox helpers are
  // pinned under a different manifest key — running it on them would compare a
  // helper against the app-server's pin and manufacture a failure.
  test('does not put the sandbox helpers through the runtime gate', () => {
    const runner = Buffer.from('codex-command-runner');
    stageBundledBinary(workspace, 'win32-x64', 'codex-command-runner.exe', runner);

    const result = verifyBundledCodexIntegrity({
      roots: [workspace],
      manifest: {
        upstream: { tag: 'rust-v0.0.0-test' },
        windowsSandbox: {
          'win32-x64': { files: { 'codex-command-runner.exe': { binarySha256: sha256(runner) } } },
        },
      },
      forbidAppServer: true,
      runtimeVerify: () => {
        throw new Error('the runtime gate must not be asked about a sandbox helper');
      },
    });

    expect(result.failures).toEqual([]);
    expect(result.verified).toHaveLength(1);
  });

  test('fails when nothing was packaged at all and a platform dir was required', () => {
    const result = verifyBundledCodexIntegrity({
      roots: [join(workspace, 'never-built')],
      manifest: manifestPinning('darwin-arm64', sha256(Buffer.from('x'))),
      requirePlatformDirs: ['darwin-arm64'],
    });

    expect(result.failures.map(f => f.kind)).toEqual(['no-packaged-output']);
  });
});
