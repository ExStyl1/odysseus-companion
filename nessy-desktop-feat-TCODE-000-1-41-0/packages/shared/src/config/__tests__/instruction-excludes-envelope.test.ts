/**
 * R31 · f185 + f163a — the documented settings keys the strict stored-config
 * envelope did not declare.
 *
 * Two contracts, one regression class. `StoredConfigTopLevelSchema` is
 * `.strict()` and `loadStoredConfig()` THROWS `UnsupportedStorageLayoutError`
 * when the parse fails (`storage.ts:856-862`), so a single
 * documented-but-undeclared top-level key costs the user every setting in
 * `config.json` — the same startup-brick class `session-mirror-settings.test.ts`
 * guards. Only a disk round-trip through the PRODUCTION loader proves the
 * envelope accepts a key; an in-process schema unit test passes while the app
 * bricks.
 *
 * - `claudeMdExcludes` / `instructionExcludes`: `large-codebases.md:155` — "You
 *   can set `claudeMdExcludes` at any settings scope: user, project, local, or
 *   managed. Arrays merge across scopes, so a team can set project-level
 *   defaults while individuals add local overrides."
 * - `env`: `env-vars.md:78` — "Add variables under the `env` key in a
 *   `settings.json` file". DECLARED so the file loads; the value is NOT applied
 *   (f163b is parked — `docs/superpowers/plans/2026-08-04-user-env-park.md`).
 */
import { describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { pathToFileURL } from 'url'

const STORAGE_MODULE = pathToFileURL(join(import.meta.dir, '..', 'storage.ts')).href
const EXCLUDES_MODULE = pathToFileURL(
  join(import.meta.dir, '..', '..', 'agent', 'memory', 'instruction-excludes.ts'),
).href

interface Fixture {
  configDir: string
  projectRoot: string
}

/** A v2 config.json in a fresh CONFIG_DIR, plus an empty project directory. */
function fixture(prefix: string, config: Record<string, unknown>): Fixture {
  const configDir = mkdtempSync(join(tmpdir(), prefix))
  writeFileSync(join(configDir, 'config.json'), JSON.stringify({
    storageLayoutVersion: 2,
    workspaceRefs: [],
    activeWorkspaceId: null,
    activeSessionId: null,
    ...config,
  }), 'utf-8')
  return { configDir, projectRoot: mkdtempSync(join(tmpdir(), `${prefix}project-`)) }
}

function writeClaudeSettings(projectRoot: string, name: string, body: unknown): void {
  mkdirSync(join(projectRoot, '.claude'), { recursive: true })
  writeFileSync(join(projectRoot, '.claude', name), JSON.stringify(body), 'utf-8')
}

/**
 * Every case here spawns a `bun --eval` subprocess that imports
 * `instruction-excludes.ts`, and under concurrent lane load that import blocks
 * for **20-30 s while burning 0.5 s of CPU** — measured 2026-08-28, and A/B'd
 * against the file at HEAD in the same minute (22.3 s mine, 20.6 s HEAD), so it
 * is the module graph waiting on something, not this suite's diff. Importing
 * `storage.ts` alone in the same shell costs 0.38 s, which is the positive
 * control. `bun test`'s 5000 ms default therefore sat far below the suite's own
 * resting runtime — the narrowing-knob trap in a test file: 4 red tests no diff
 * caused, and the file at HEAD failed 2 of 4 minutes after passing 4 of 4 in a
 * quiet window.
 *
 * 60 s, not 30 s: one case still overran a 30 s budget at 39.7 s. The registered
 * shape and its advice — raise the budget, do not chase the code it points at —
 * are in `docs/superpowers/specs/2026-07-29-known-failing-tests.md`, and the
 * likely blocker is the one that register already names: a spawn under the
 * `pi-harness` graph reaching its own ceiling while several lanes run tests.
 */
const SUBPROCESS_BUDGET_MS = 60_000;

/**
 * Run `source` in a subprocess whose CONFIG_DIR is the fixture's.
 *
 * `CLAUDE_CONFIG_DIR` is pointed at a directory that does not exist, and that is
 * load-bearing since P6.32: `resolveInstructionExcludes` now reads the USER
 * scope's `~/.claude/settings.json` too (`settings-reference.md#scopes` — "`User`
 * is `~/.claude/settings.json`"), so without this the subprocess would read the
 * DEVELOPER'S OWN file and these expectations would depend on the machine.
 */
function run(configDir: string, source: string): { stdout: string; stderr: string; exitCode: number } {
  const spawned = Bun.spawnSync([process.execPath, '--eval', source], {
    env: {
      ...process.env,
      NESSY_CONFIG_DIR: configDir,
      CLAUDE_CONFIG_DIR: join(configDir, 'claude-config-absent'),
    },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  return {
    stdout: spawned.stdout.toString().trim(),
    stderr: spawned.stderr.toString(),
    exitCode: spawned.exitCode ?? -1,
  }
}

describe('claudeMdExcludes survives the envelope and merges across scopes', () => {
  it('unions user, project and local exclusions instead of letting one scope win', () => {
    const fx = fixture('nessy-excludes-merge-', {
      // Both user spellings, which merged before R31 and must keep merging.
      instructionExcludes: ['/monorepo/legacy/**'],
      claudeMdExcludes: ['**/packages/web/**'],
    })
    writeClaudeSettings(fx.projectRoot, 'settings.json', {
      claudeMdExcludes: ['**/packages/other-team/**'],
      // Never read out of this file — it is co-owned with real Claude Code.
      permissions: { deny: ['Read(//etc/**)'] },
    })
    writeClaudeSettings(fx.projectRoot, 'settings.local.json', {
      claudeMdExcludes: ['**/vendor/**', '**/packages/web/**'],
    })

    const result = run(fx.configDir, `
      import { loadStoredConfig } from '${STORAGE_MODULE}';
      import { resolveInstructionExcludes } from '${EXCLUDES_MODULE}';
      loadStoredConfig();
      console.log(JSON.stringify(resolveInstructionExcludes({
        managed: ['**/managed-only/**'],
        workingDirectory: ${JSON.stringify(fx.projectRoot)},
        projectTrustState: 'trusted',
      })));
    `)

    expect(result.exitCode, result.stderr).toBe(0)
    // Every scope contributes; the duplicate appears once.
    expect(JSON.parse(result.stdout)).toEqual([
      '**/managed-only/**',
      '/monorepo/legacy/**',
      '**/packages/web/**',
      '**/packages/other-team/**',
      '**/vendor/**',
    ])
  }, SUBPROCESS_BUDGET_MS)

  it('an untrusted project contributes nothing, and one bad entry costs only itself', () => {
    const fx = fixture('nessy-excludes-boundary-', { claudeMdExcludes: ['   ', 7, '**/kept/**'] })
    writeClaudeSettings(fx.projectRoot, 'settings.local.json', { claudeMdExcludes: ['**/untrusted/**'] })

    const result = run(fx.configDir, `
      import { loadStoredConfig } from '${STORAGE_MODULE}';
      import { resolveInstructionExcludes } from '${EXCLUDES_MODULE}';
      // The file still loads with a malformed entry in it — the envelope is
      // unknown-tolerant for this key on purpose.
      loadStoredConfig();
      console.log(JSON.stringify({
        untrusted: resolveInstructionExcludes({
          workingDirectory: ${JSON.stringify(fx.projectRoot)},
          projectTrustState: 'none',
        }),
        gated: resolveInstructionExcludes({
          workingDirectory: ${JSON.stringify(fx.projectRoot)},
          projectTrustState: 'trusted',
          settingSources: ['user', 'project'],
        }),
      }));
    `)

    expect(result.exitCode, result.stderr).toBe(0)
    const parsed = JSON.parse(result.stdout)
    // The blank and the non-string are dropped; the usable entry survives.
    expect(parsed.untrusted).toEqual(['**/kept/**'])
    // `local` excluded from --setting-sources ⇒ settings.local.json is not read.
    expect(parsed.gated).toEqual(['**/kept/**'])
  }, SUBPROCESS_BUDGET_MS)
})

describe('a user-scope env block loads and is not applied (f163a)', () => {
  it('loads a config.json carrying env, where the strict envelope used to throw', () => {
    const fx = fixture('nessy-user-env-declared-', {
      env: { API_TIMEOUT_MS: '1200000', NESSY_TEST_USER_ENV_MARKER: 'from-config' },
      colorTheme: 'nord',
    })
    const result = run(fx.configDir, `
      import { loadStoredConfig } from '${STORAGE_MODULE}';
      const config = loadStoredConfig();
      // Every OTHER setting in the file survives, which is the actual damage
      // the undeclared key did.
      console.log(JSON.stringify({ theme: config?.colorTheme, env: config?.env }));
    `)
    expect(result.exitCode, result.stderr).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({
      theme: 'nord',
      env: { API_TIMEOUT_MS: '1200000', NESSY_TEST_USER_ENV_MARKER: 'from-config' },
    })
  }, SUBPROCESS_BUDGET_MS)

  it('never reaches process.env or a child process, and says so through the doctor surface', () => {
    const fx = fixture('nessy-user-env-inert-', {
      env: { NESSY_TEST_USER_ENV_MARKER: 'from-config', PATH: '/attacker/bin' },
    })
    const result = run(fx.configDir, `
      import { loadStoredConfig, collectRejectedUserSettingsLayers } from '${STORAGE_MODULE}';
      loadStoredConfig();
      const child = Bun.spawnSync([process.execPath, '--eval',
        'console.log(JSON.stringify({ marker: process.env.NESSY_TEST_USER_ENV_MARKER ?? null, path: process.env.PATH }))'],
        { stdout: 'pipe', stderr: 'pipe' });
      console.log(JSON.stringify({
        host: process.env.NESSY_TEST_USER_ENV_MARKER ?? null,
        hostPathHijacked: process.env.PATH === '/attacker/bin',
        child: JSON.parse(child.stdout.toString().trim()),
        rejected: collectRejectedUserSettingsLayers().map(layer => ({ key: layer.key, reason: layer.reason })),
      }));
    `)
    expect(result.exitCode, result.stderr).toBe(0)
    const parsed = JSON.parse(result.stdout)
    // The park, pinned: reading the block must not set anything, in this process
    // or in anything it spawns. If this fails, f163b was implemented without the
    // owner threat-model decision it is parked on.
    expect(parsed.host).toBeNull()
    expect(parsed.hostPathHijacked).toBe(false)
    expect(parsed.child.marker).toBeNull()
    expect(parsed.child.path).not.toBe('/attacker/bin')
    // Ignored, but not silent — the compensating control for the refusal.
    const envLayer = parsed.rejected.find((layer: { key: string }) => layer.key === 'env')
    expect(envLayer).toBeDefined()
    // The phrase this pinned until 2026-09-07 said only that the block is not
    // applied; `df90ecc94` closed the park and rewrote the reason to say the
    // refusal is PERMANENT and why. Two bounded clauses of the live sentence
    // (`reportUnhonouredUserEnvBlock`, `packages/shared/src/config/storage.ts`)
    // are pinned instead of one loose word pair: the first is the verdict, the
    // second is the scope claim, and a rewrite that drops either is the thing
    // this case exists to catch. `user-env-block-park.test.ts` pins the same
    // verdict clause from the other side.
    expect(envLayer.reason).toContain('PERMANENTLY REFUSED, not merely unimplemented')
    expect(envLayer.reason).toContain('at no scope a user can write')
    expect(envLayer.reason).toContain('NESSY_TEST_USER_ENV_MARKER')
    // Names, never values.
    expect(envLayer.reason).not.toContain('from-config')
    expect(envLayer.reason).not.toContain('/attacker/bin')
  }, SUBPROCESS_BUDGET_MS)
})
