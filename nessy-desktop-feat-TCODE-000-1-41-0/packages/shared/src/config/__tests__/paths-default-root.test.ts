import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const profiles: string[] = [];

afterEach(() => {
  for (const path of profiles.splice(0)) rmSync(path, { recursive: true, force: true });
});

async function loadPaths(configDir: string) {
  // An empty override IS the default-root arm, so the child cannot be isolated
  // with NESSY_CONFIG_DIR — that would be the case this test is not about. A
  // disposable HOME isolates it instead: DEFAULT_CONFIG_DIR then resolves under
  // a temp profile, and the assertions below (default classification, the two
  // constants agreeing) are indifferent to which home it is.
  const profile = mkdtempSync(join(tmpdir(), 'nessy-default-root-profile-'));
  profiles.push(profile);
  const env: Record<string, string | undefined> = {
    ...process.env,
    HOME: profile,
    USERPROFILE: profile,
    NESSY_CONFIG_DIR: configDir,
  };
  // `bun test` sets NODE_ENV=test here and the child inherits it, so
  // config/paths.ts read this `bun -e` probe as a test runner about to touch
  // the real ~/.nessy-agent and threw. The probe is not a test runner and no
  // longer says it is; the guard is unchanged and still fires for one.
  delete env.NODE_ENV;
  const child = Bun.spawn([
    process.execPath,
    '-e',
    `import { CONFIG_DIR, DEFAULT_CONFIG_DIR, IS_DEFAULT_CONFIG_DIR } from './packages/shared/src/config/paths.ts'; console.log(JSON.stringify({ CONFIG_DIR, DEFAULT_CONFIG_DIR, IS_DEFAULT_CONFIG_DIR }));`,
  ], {
    cwd: process.cwd(),
    env,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const stdout = await new Response(child.stdout).text();
  const stderr = await new Response(child.stderr).text();
  expect(await child.exited, stderr).toBe(0);
  return JSON.parse(stdout.trim()) as {
    CONFIG_DIR: string;
    DEFAULT_CONFIG_DIR: string;
    IS_DEFAULT_CONFIG_DIR: boolean;
  };
}

describe('config path default-root classification', () => {
  it.each(['', '   '])('treats an empty override as the default root', async (configDir) => {
    const paths = await loadPaths(configDir);
    expect(paths.IS_DEFAULT_CONFIG_DIR).toBe(true);
    expect(paths.CONFIG_DIR).toBe(paths.DEFAULT_CONFIG_DIR);
  });
});
