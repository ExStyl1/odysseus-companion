import { describe, it, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

// Run ensureDefaultPermissions() in an isolated subprocess (cwd + NESSY_CONFIG_DIR
// both scoped to this test's own temp dirs) rather than in-process. CONFIG_DIR
// (packages/shared/src/config/paths.ts) is resolved once, at the *first* import
// of that module anywhere in the whole `bun test` run — whichever test file or
// preload script imports it first freezes it for every other in-process test.
// An in-process `process.env.NESSY_CONFIG_DIR = ...` assignment made here (after
// that first import) has no effect on the already-frozen CONFIG_DIR, so
// permissions-config.ts's `getAppPermissionsDir()` would silently keep pointing
// at whatever directory got frozen first — not this test's tempConfig — making
// the merge run against (and write into) the wrong directory.
const PERMISSIONS_MODULE_PATH = pathToFileURL(join(import.meta.dir, '..', 'permissions-config.ts')).href;

/**
 * The budget, set against the MEASURED FLOOR rather than bun's 5 s default.
 *
 * The case below spawns a real `bun --eval` that imports `permissions-config.ts`
 * and its whole module graph, so its wall time is that graph's and the
 * filesystem's, not the assertion's. Measured 2026-09-11: **1.21 s ALONE** at
 * load ~9, and **over 5 s beside three sibling suites** at load ~15 — where the
 * 5 s default fires, bun kills the child, and the failure presents as
 * `subprocess failed (exit null)` with an EMPTY stderr, i.e. as a defect in
 * `ensureDefaultPermissions` rather than as the timeout it is. That is how the
 * 1.36.0 wave gate reported this file: red in the whole-repo run, green alone.
 *
 * Generous on purpose — a floor on the machine, never a bound on the assertion.
 * Nothing here should take seconds, so a run approaching this ceiling means the
 * spawn itself has changed.
 */
const SUBPROCESS_MIGRATION_TIMEOUT_MS = 120_000;

describe('ensureDefaultPermissions migration', () => {
  it('merges new bundled defaults into existing installed file and preserves customizations', () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'permissions-bundle-'));
    const tempConfig = mkdtempSync(join(tmpdir(), 'permissions-config-'));

    const bundledDir = join(tempRoot, 'resources', 'permissions');
    mkdirSync(bundledDir, { recursive: true });
    writeFileSync(
      join(bundledDir, 'default.json'),
      JSON.stringify({
        version: '2026-03-01',
        allowedBashPatterns: [
          { pattern: '^rg\\b', comment: 'Ripgrep search' },
          { pattern: '^bun\\s+run\\s+typecheck\\b$', comment: 'Typecheck' },
        ],
        allowedMcpPatterns: ['search'],
        allowedApiEndpoints: [],
        allowedWritePaths: [],
        blockedCommandHints: [
          { command: 'printf', reason: 'printf blocked by default' },
        ],
      }, null, 2)
    );

    const installedDir = join(tempConfig, 'permissions');
    mkdirSync(installedDir, { recursive: true });
    writeFileSync(
      join(installedDir, 'default.json'),
      JSON.stringify({
        version: '2026-02-01',
        allowedBashPatterns: [
          { pattern: '^rg\\b', comment: 'User existing pattern' },
          { pattern: '^custom-review\\b', comment: 'User customization' },
        ],
        allowedMcpPatterns: ['list'],
        allowedApiEndpoints: [],
        allowedWritePaths: [],
        blockedCommandHints: [
          { command: 'sed', reason: 'sed print-only policy', whenNotMatching: '^sed\\s+-n\\b' },
        ],
      }, null, 2)
    );

    const run = Bun.spawnSync([
      process.execPath,
      '--eval',
      `import { ensureDefaultPermissions } from '${PERMISSIONS_MODULE_PATH}'; ensureDefaultPermissions();`,
    ], {
      cwd: tempRoot,
      env: { ...process.env, NESSY_CONFIG_DIR: tempConfig },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    if (run.exitCode !== 0) {
      throw new Error(`subprocess failed (exit ${run.exitCode}):\n${run.stderr.toString()}`);
    }

    const merged = JSON.parse(readFileSync(join(installedDir, 'default.json'), 'utf-8'));

    expect(merged.version).toBe('2026-03-01');

    const bashPatterns = merged.allowedBashPatterns.map((p: string | { pattern: string }) =>
      typeof p === 'string' ? p : p.pattern
    );

    expect(bashPatterns).toContain('^custom-review\\b');
    expect(bashPatterns).toContain('^bun\\s+run\\s+typecheck\\b$');
    expect(bashPatterns.filter((p: string) => p === '^rg\\b').length).toBe(1);

    const mcpPatterns = merged.allowedMcpPatterns as string[];
    expect(mcpPatterns).toContain('list');
    expect(mcpPatterns).toContain('search');

    const blockedCommandHints = merged.blockedCommandHints as Array<{ command: string; reason: string }>;
    expect(blockedCommandHints.some(h => h.command === 'printf')).toBe(true);
    expect(blockedCommandHints.some(h => h.command === 'sed')).toBe(true);

    rmSync(tempRoot, { recursive: true, force: true });
    rmSync(tempConfig, { recursive: true, force: true });
  }, SUBPROCESS_MIGRATION_TIMEOUT_MS);
});
