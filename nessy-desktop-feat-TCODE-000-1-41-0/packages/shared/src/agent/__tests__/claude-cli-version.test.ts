/**
 * F1.1240 (origin: the final sitting, SIT2-b) — the "Claude Code Update Required" card said the bundled runtime was
 * "unknown" in the packaged app instead of 2.1.274.
 *
 * `readClaudeCliVersion` did `createRequire(import.meta.url)('@anthropic-ai/claude-agent-sdk/package.json')`. Two things
 * break that in the packaged app and neither shows under `bun test`:
 *
 * - the main process is bundled by esbuild as CJS (`apps/electron/package.json` `build:main`,
 *   `scripts/electron-build-main.ts`), which rewrites `import.meta` to `{}`, so `createRequire(undefined)` throws;
 * - the SDK's `exports` map has no `./package.json`, so Node refuses that subpath (`ERR_PACKAGE_PATH_NOT_EXPORTED`). Bun
 *   does not enforce it.
 *
 * So the first arm runs the reader the way the app does: bundled with the `build:main` flags and executed by `node`. The
 * other two pin the manifest walk through the resolver seam.
 */
import { afterAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { readClaudeCliVersion } from '../claude-transcript-rebuild.ts';

setDefaultTimeout(60_000);

const REPO = resolve(import.meta.dir, '../../../../..');
const SOURCE = resolve(import.meta.dir, '../claude-transcript-rebuild.ts');
const INSTALLED = (JSON.parse(readFileSync(join(REPO, 'node_modules/@anthropic-ai/claude-agent-sdk/package.json'), 'utf8')) as {
  claudeCodeVersion: string;
}).claudeCodeVersion;

const roots: string[] = [];
afterAll(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

/** A fake package at `<root>/<name>`, whose `exports` map (like the SDK's) has no `./package.json`. */
function fakePackage(name: string, claudeCodeVersion?: string): string {
  const root = mkdtempSync(join(tmpdir(), 'f1240-'));
  roots.push(root);
  const dir = join(root, 'pkg');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name,
    ...(claudeCodeVersion ? { claudeCodeVersion } : {}),
    exports: { '.': { types: './sdk.d.ts', default: './sdk.mjs' } },
  }));
  writeFileSync(join(dir, 'sdk.mjs'), 'export {};\n');
  return join(dir, 'sdk.mjs');
}

describe('F1.1240 — the bundled Claude Code version is read in the packaged app', () => {
  it('THE DEFECT — bundled as the app bundles its main process (esbuild CJS) and run by node, it names the installed version', () => {
    // Under the repo so node resolves the SDK the way the app's main.cjs does (from its own directory upwards).
    const cacheRoot = join(REPO, 'node_modules', '.cache');
    mkdirSync(cacheRoot, { recursive: true });
    const dir = mkdtempSync(join(cacheRoot, 'f1240-'));
    roots.push(dir);
    const entry = join(dir, 'entry.ts');
    writeFileSync(entry, `import { readClaudeCliVersion } from ${JSON.stringify(SOURCE)};\nprocess.stdout.write(readClaudeCliVersion());\n`);
    const outfile = join(dir, 'main.cjs');
    const build = spawnSync(join(REPO, 'node_modules/.bin/esbuild'), [
      entry, '--bundle', '--platform=node', '--format=cjs', `--outfile=${outfile}`,
      '--external:electron', '--external:@anthropic-ai/claude-agent-sdk', '--log-level=error',
    ], { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    expect(build.status, build.stderr).toBe(0);
    // The bundle carries the config module, which refuses a test process with no isolated config dir.
    const configDir = join(dir, 'config');
    const run = spawnSync('node', [outfile], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NESSY_CONFIG_DIR: configDir } });
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toBe(INSTALLED);
    expect(run.stdout).not.toBe('unknown');
  });

  it('reads `claudeCodeVersion` from the SDK manifest beside its entry, which no `exports` map gates', () => {
    expect(readClaudeCliVersion(() => fakePackage('@anthropic-ai/claude-agent-sdk', '2.1.999'))).toBe('2.1.999');
  });

  it('BOUNDARY — a manifest of another package is not read as the SDK\'s: unknown', () => {
    expect(readClaudeCliVersion(() => fakePackage('not-the-sdk', '2.1.999'))).toBe('unknown');
  });
});
