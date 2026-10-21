/**
 * P3.206 — the headless server seeds the bundled host assets the desktop seeds.
 *
 * THE DEFECT, measured 2026-09-03. Six seeders run in the desktop shell's ready
 * handler. `nessy-server` reached two of them, and only by accident:
 * `ensureConfigDir()` calls `initializeDocs()` and `ensureToolIcons()` itself,
 * so those two ride into both hosts through `bootstrapConfigArtifacts`. The
 * other four had exactly ONE production call site each — `apps/electron`'s — so
 * a headless deployment shipped **zero** bundled skills on every runtime, and
 * never wrote `permissions/default.json`.
 *
 * WHY THE TWO ARMS ARE DIFFERENT KINDS OF EVIDENCE, and why neither alone is
 * enough:
 *
 *  1. **Behavioural, in a real child process.** The seeders live in `shared` and
 *     are called from the electron main process everywhere else in this tree, so
 *     "does this work outside electron at all?" is a genuine question and not a
 *     formality — `getBundledAssetsDir` resolves against a root somebody has to
 *     set, and `initializeDocs`'s own header records that loading it too early
 *     yields empty docs on a fresh install. The child below sets the root the
 *     way `bootstrapServer` does and asserts what landed on disk. It runs in a
 *     FRESH `bun` process with `NESSY_CONFIG_DIR` exported before bun starts,
 *     which is the only form of that isolation that works (AGENTS.md: the root
 *     `bunfig.toml` preload beats a CLI `--preload`, so an in-process override
 *     reports success while `CONFIG_DIR` stays frozen at the real profile).
 *
 *  2. **The wiring pin, with a positive control.** The behavioural arm proves
 *     the mechanism runs headless; it cannot prove the ENTRY calls it, which is
 *     the whole defect. The entry is a script with top-level side effects
 *     (`setupI18n()`, a `--generate-token` `process.exit`, a server bootstrap),
 *     so importing it to test it would start a server — the same constraint
 *     `headless-i18n.test.ts` works under, and this file follows its shape,
 *     including its positive control: a source pin nobody has watched fail is a
 *     pin nobody should believe.
 *
 * `ensurePresetThemes` and `initializeReleaseNotes` are deliberately NOT
 * asserted here. The first self-heals from its own readers in
 * `config/storage.ts`; the second is a display surface with no bearing on a tool
 * call, and is recorded in the out-of-scope register instead.
 */
import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const REPO_ROOT = join(import.meta.dir, '..', '..', '..', '..')
const ENTRY = join(REPO_ROOT, 'packages', 'server', 'src', 'index.ts')
/** The root `bootstrapServer` registers; `getBundledAssetsDir` appends `resources/<kind>`. */
const BUNDLED_ASSETS_ROOT = join(REPO_ROOT, 'apps', 'electron')

interface ChildReport {
  configDir: string
  skillsSeeded: string[]
  skillsOnDisk: string[]
  receiptExists: boolean
  defaultPermissionsExists: boolean
  defaultPermissionsDeniedPaths: number
}

/**
 * Run both seeders in a fresh process against a throwaway profile.
 *
 * `-e` and not a fixture file: a fixture whose module body has a side effect,
 * imported by a test, can kill the runner at import time and report exit 0 with
 * zero tests executed (AGENTS.md). Nothing here is importable by accident.
 */
function seedInChildProcess(configDir: string): ChildReport {
  const source = `
    import { setBundledAssetsRoot } from '@nessy-agent/shared/utils'
    import { ensureBundledSkills, getManagedSkillsRoot, BUNDLED_SKILL_SEED_RECEIPT_FILE } from '@nessy-agent/shared/skills'
    import { ensureDefaultPermissions, getAppPermissionsDir } from '@nessy-agent/shared/agent'
    import { CONFIG_DIR } from '@nessy-agent/shared/config/paths'
    import { existsSync, readdirSync, readFileSync } from 'node:fs'
    import { join } from 'node:path'

    setBundledAssetsRoot(${JSON.stringify(BUNDLED_ASSETS_ROOT)})
    const skillsSeeded = ensureBundledSkills({ storedConfig: {}, env: {} })
    ensureDefaultPermissions()

    const skillsRoot = getManagedSkillsRoot()
    const defaultPermissions = join(getAppPermissionsDir(), 'default.json')
    const parsed = existsSync(defaultPermissions)
      ? JSON.parse(readFileSync(defaultPermissions, 'utf-8'))
      : { deniedPaths: [] }
    console.log(JSON.stringify({
      configDir: CONFIG_DIR,
      skillsSeeded,
      skillsOnDisk: existsSync(skillsRoot)
        ? readdirSync(skillsRoot).filter(name => existsSync(join(skillsRoot, name, 'SKILL.md'))).sort()
        : [],
      receiptExists: existsSync(join(skillsRoot, BUNDLED_SKILL_SEED_RECEIPT_FILE)),
      defaultPermissionsExists: existsSync(defaultPermissions),
      defaultPermissionsDeniedPaths: (parsed.deniedPaths ?? []).length,
    }))
  `
  // A fresh object rather than a mutated `process.env`: assigning to
  // `process.env.X` in this Bun leaves the name invisible to a spread for some
  // names, and every subprocess env in this tree is built by spreading.
  const env = { ...process.env, NESSY_CONFIG_DIR: configDir }
  const child = Bun.spawnSync(['bun', '-e', source], { cwd: REPO_ROOT, env })
  const stdout = child.stdout.toString().trim()
  const stderr = child.stderr.toString().trim()
  if (child.exitCode !== 0) {
    throw new Error(`seeder child failed (${child.exitCode}): ${stderr || stdout}`)
  }
  return JSON.parse(stdout.split('\n').at(-1) ?? '{}') as ChildReport
}

/**
 * The spawn arm's budget, set against a MEASURED floor rather than guessed.
 *
 * Alone on a quiet-ish box this whole file runs in **1373 ms** (5 tests, load
 * ~18). In a nine-suite batch at load ~14 the same child was still starting at
 * bun's 5000 ms default and came back `exitCode: null` — killed, not failed.
 * That is the shape the out-of-scope register files as O4: a spawn-based test
 * timing out purely under lane contention, green again at `--timeout 120000`.
 * Two orders of magnitude over the floor, because the cost being covered is
 * another lane's CPU and not this test's work.
 */
const SPAWN_BUDGET_MS = 120_000

describe('P3.206 — bundled host assets reach a headless process', () => {
  test('a non-electron process seeds the bundled skills and the default permissions', () => {
    const configDir = mkdtempSync(join(tmpdir(), 'nessy-headless-seed-'))
    const report = seedInChildProcess(configDir)

    // The isolation actually took. Without this the assertions below could be
    // describing the developer's real profile, where everything is already
    // seeded and every one of them passes for the wrong reason.
    expect(report.configDir).toBe(configDir)

    // The bundle resolved and its slugs landed. Asserted as a superset of the
    // two creator skills rather than an exact list, so adding a bundled skill
    // does not fail a test that is not about it.
    expect(report.skillsOnDisk).toEqual(expect.arrayContaining(['plugin-creator', 'skill-creator']))
    expect(report.skillsSeeded.length).toBeGreaterThan(0)
    // P2.281's receipt: this is what makes a headless profile's state legible.
    expect(report.receiptExists).toBe(true)

    expect(report.defaultPermissionsExists).toBe(true)
    expect(report.defaultPermissionsDeniedPaths).toBeGreaterThan(0)
  }, SPAWN_BUDGET_MS)

  test('CONTROL: an unseeded profile has neither, so the arm above is not vacuous', () => {
    const configDir = mkdtempSync(join(tmpdir(), 'nessy-headless-unseeded-'))
    expect(existsSync(join(configDir, 'skills'))).toBe(false)
    expect(existsSync(join(configDir, 'permissions', 'default.json'))).toBe(false)
  })
})

describe('P3.206 — the headless entry wires the seeding', () => {
  test('the entry calls the seeder exactly once, from the platform hook', () => {
    const entry = readFileSync(ENTRY, 'utf-8')
    const calls = entry.match(/^\s*seedBundledHostAssets\(\)$/gm) ?? []
    expect(calls).toHaveLength(1)
    // Before the session manager exists, so the first capability inventory sees
    // the seeded skills — the ordering the desktop states at its own call site.
    expect(entry.indexOf('seedBundledHostAssets()')).toBeLessThan(entry.indexOf('createSessionManager:'))
  })

  test('the seeder calls both bundled-asset entry points', () => {
    const entry = readFileSync(ENTRY, 'utf-8')
    expect(entry).toContain('ensureBundledSkills({ storedConfig: loadStoredConfig() })')
    expect(entry).toContain('ensureDefaultPermissions()')
    expect(entry).toContain("import { ensureBundledSkills } from '@nessy-agent/shared/skills'")
    expect(entry).toContain("import { ensureDefaultPermissions } from '@nessy-agent/shared/agent'")
  })

  test('POSITIVE CONTROL: the detector flags an entry with the call removed', () => {
    const stripped = readFileSync(ENTRY, 'utf-8').replace(/^\s*seedBundledHostAssets\(\)$/m, '// removed')
    expect(stripped.match(/^\s*seedBundledHostAssets\(\)$/gm) ?? []).toHaveLength(0)
  })
})
