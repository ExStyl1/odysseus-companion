/**
 * The packaged headless server could not start for four releases, and nothing
 * failed. `factory.ts` imports `CodexAgent` statically, the build shipped seven
 * workspace packages and neither Codex package was among them, so a relocated
 * distribution died at module load with
 * `Cannot find module '@nessy-agent/codex-agent-server'`. It went unseen because
 * the build writes to `<repo>/dist/server` and module resolution walks upward —
 * inside the repo the missing packages are found in the repo's own node_modules.
 *
 * These tests drive the two guards that now fail the build instead, and — as
 * with the interceptor pairing before them — assert that the build actually
 * calls them. `copyInterceptorBundle` in scripts/build/common.ts is the standing
 * reminder of why: a packaging check with no callers protects nothing.
 */
import { afterAll, describe, expect, it } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  BOOT_PROBE_ARG,
  DIST_ENTRY_RELATIVE,
  collectWorkspaceLinkageGaps,
  verifyDistributionBoots,
  verifyWorkspaceLinkage,
} from '../../../../scripts/build/distribution-boot.ts';

const repoRoot = join(import.meta.dir, '..', '..', '..', '..');
const VALID_TOKEN = 'd8caaa3b3190e27f0fbba3da6480fa3ed8a1904e41035d81';

const fixtures: string[] = [];
afterAll(() => {
  for (const dir of fixtures) rmSync(dir, { recursive: true, force: true });
});

function makeFixtureRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  fixtures.push(root);
  return root;
}

function writeFile(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

/**
 * A distribution shaped like the real one: `packages/<pkg>/src/*.ts` plus the
 * `node_modules/@nessy-agent/<pkg>` entries `createRootConfig` symlinks.
 */
function assembleDist(spec: {
  sources: Record<string, string>;
  shipped: string[];
}): string {
  const root = makeFixtureRoot('nessy-linkage-');
  for (const [relPath, content] of Object.entries(spec.sources)) {
    writeFile(join(root, 'packages', relPath), content);
  }
  for (const pkg of spec.shipped) {
    mkdirSync(join(root, 'node_modules', '@nessy-agent', pkg), { recursive: true });
  }
  return root;
}

describe('server distribution: workspace linkage', () => {
  it('accepts a distribution that ships every workspace package it imports', () => {
    const dist = assembleDist({
      sources: {
        'shared/src/agent/codex-agent.ts':
          "import { AppServerClient } from '@nessy-agent/codex-agent-server';\n",
        'server/src/index.ts': "import x from '@nessy-agent/shared/agent/backend'\n",
      },
      shipped: ['codex-agent-server', 'shared'],
    });

    expect(collectWorkspaceLinkageGaps(dist)).toEqual([]);
    expect(() => verifyWorkspaceLinkage(dist)).not.toThrow();
  });

  // The exact S2 defect, reduced: the static import is present in the shipped
  // source, the package is not.
  it('reports a workspace package the shipped source imports but the build omits', () => {
    const dist = assembleDist({
      sources: {
        'shared/src/agent/codex-agent.ts':
          "import { AppServerClient } from '@nessy-agent/codex-agent-server';\n"
          + "import { startAdapter } from '@nessy-agent/codex-responses-adapter';\n",
      },
      shipped: ['shared'],
    });

    expect(collectWorkspaceLinkageGaps(dist)).toEqual([
      {
        specifier: '@nessy-agent/codex-agent-server',
        referencedBy: join('packages', 'shared', 'src', 'agent', 'codex-agent.ts'),
      },
      {
        specifier: '@nessy-agent/codex-responses-adapter',
        referencedBy: join('packages', 'shared', 'src', 'agent', 'codex-agent.ts'),
      },
    ]);
    expect(() => verifyWorkspaceLinkage(dist)).toThrow(/@nessy-agent\/codex-agent-server/);
  });

  it('resolves subpath imports through the package, and ignores prose and non-runtime dirs', () => {
    const dist = assembleDist({
      sources: {
        'shared/src/agent/codex-agent.ts':
          "import { NESTOR_CHAT_URL } from '@nessy-agent/codex-responses-adapter/nestor-client';\n"
          + '// Prose mentioning @nessy-agent/never-shipped must not register.\n',
        'shared/src/__tests__/codex.test.ts': "import x from '@nessy-agent/test-only-helper';\n",
        'session-mcp-server/dist/index.js': "require('@nessy-agent/bundled-away');\n",
      },
      shipped: ['codex-responses-adapter'],
    });

    expect(collectWorkspaceLinkageGaps(dist)).toEqual([]);
  });
});

/** A stand-in distribution whose entry records where it was actually run from. */
function assembleBootableDist(entryBody: string): { dist: string; recordPath: string } {
  const root = makeFixtureRoot('nessy-boot-');
  const dist = join(root, 'server');
  const recordPath = join(root, 'record.txt');
  const entry = join(dist, DIST_ENTRY_RELATIVE);
  writeFile(entry, `#!/bin/sh\nRECORD="${recordPath}"\n${entryBody}\n`);
  chmodSync(entry, 0o755);
  writeFile(join(dist, 'package.json'), '{"name":"nessy-server-dist"}\n');
  return { dist, recordPath };
}

const hostTarget = {
  platform: process.platform,
  arch: process.arch === 'arm64' ? 'arm64' : 'x64',
};

describe('server distribution: boot', () => {
  it('relocates the distribution out of its build location and starts it from an empty cwd', () => {
    const { dist, recordPath } = assembleBootableDist(
      `[ "$1" = "${BOOT_PROBE_ARG}" ] || exit 64\n`
      + 'printf \'%s\\n%s\\n%s\\n\' "$0" "$(pwd)" "$(ls -A "$(pwd)" | wc -l)" > "$RECORD"\n'
      + `echo ${VALID_TOKEN}\n`,
    );

    expect(verifyDistributionBoots(dist, hostTarget)).toBe('booted');

    const [entryPath, cwd, cwdEntries] = readFileSync(recordPath, 'utf-8').trim().split('\n');
    // Neither the executable nor the cwd may sit under the build location, or
    // upward resolution from the repository would rescue a broken tree.
    expect(entryPath!.startsWith(dist)).toBe(false);
    expect(cwd!.startsWith(dist)).toBe(false);
    expect(Number(cwdEntries!.trim())).toBe(0);
    // ...and the build gets its output back.
    expect(existsSync(join(dist, DIST_ENTRY_RELATIVE))).toBe(true);
  });

  it('fails the build when the distribution cannot start, quoting its stderr', () => {
    const { dist } = assembleBootableDist(
      "echo \"error: Cannot find module '@nessy-agent/codex-agent-server'\" >&2\nexit 1\n",
    );

    expect(() => verifyDistributionBoots(dist, hostTarget))
      .toThrow(/Cannot find module '@nessy-agent\/codex-agent-server'/);
    expect(existsSync(join(dist, DIST_ENTRY_RELATIVE))).toBe(true);
  });

  it('fails the build when the entry exits 0 without the startup signal', () => {
    const { dist } = assembleBootableDist('echo "almost, but not a token"\nexit 0\n');

    expect(() => verifyDistributionBoots(dist, hostTarget))
      .toThrow(/without the expected startup signal/);
  });

  // Cross-platform tarballs ship the target's Bun binary, which this host cannot
  // execute. Skipping is honest; skipping silently is not.
  it('skips with a reason when the target cannot run on the build host', () => {
    const { dist, recordPath } = assembleBootableDist(`echo ${VALID_TOKEN} > "$RECORD"\n`);
    const reasons: string[] = [];

    const outcome = verifyDistributionBoots(dist, {
      platform: 'linux',
      arch: 'x64',
      hostPlatform: 'darwin',
      hostArch: 'arm64',
      onSkip: reason => reasons.push(reason),
    });

    expect(outcome).toBe('skipped');
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toMatch(/linux-x64 cannot be executed on darwin-arm64/);
    expect(existsSync(recordPath)).toBe(false);
  });

  it('fails when the distribution has no entry script at all', () => {
    const dist = makeFixtureRoot('nessy-boot-empty-');
    expect(() => verifyDistributionBoots(dist, hostTarget)).toThrow(/no bin\/nessy-server/);
  });
});

describe('server distribution: the guards are wired into the build', () => {
  // A guard nobody calls protects nothing — see copyInterceptorBundle in
  // scripts/build/common.ts, which has warned into the void since it was written.
  it('scripts/build-server.ts calls both guards on the assembled output', () => {
    const buildServer = readFileSync(join(repoRoot, 'scripts', 'build-server.ts'), 'utf-8');

    expect(buildServer).toContain("from './build/distribution-boot'");
    expect(buildServer).toContain('verifyWorkspaceLinkage(outputDir)');
    expect(buildServer).toContain('verifyDistributionBoots(outputDir, {');
    // Same output directory the assembly steps wrote, after they have all run.
    expect(buildServer.indexOf('verifyWorkspaceLinkage(outputDir)'))
      .toBeGreaterThan(buildServer.indexOf('createEntryScripts(config)'));
  });

  it('ships the workspace packages the static import graph needs', () => {
    const buildServer = readFileSync(join(repoRoot, 'scripts', 'build-server.ts'), 'utf-8');
    const factory = readFileSync(
      join(repoRoot, 'packages', 'shared', 'src', 'agent', 'backend', 'factory.ts'),
      'utf-8',
    );

    // If this import ever becomes lazy the packages may be dropped again — but
    // only together, and deliberately.
    expect(factory).toContain("import { CodexAgent } from '../codex-agent.ts';");
    expect(buildServer).toContain("'codex-agent-server',");
    expect(buildServer).toContain("'codex-responses-adapter',");
  });
});
