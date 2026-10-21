/**
 * F1.290 (origin WJ-dd's F1.258 verifier, F1.258-e + F1.258-interim) — a
 * retirement keyed on a bundle version that ALREADY SHIPPED never runs for an
 * install already at that version.
 *
 * ## The defect
 *
 * `retireShippedPatterns` (`permissions-config.ts`) drops a
 * `RETIRED_SHIPPED_PATTERNS` entry only while CROSSING its version (installed
 * older, bundle at or past it). `f4a545cca` (F1.258) shipped bundle `2026-09-23`
 * with the MCP retirement; `a72dc2456`, twelve minutes later, added the 39 bash
 * retirements keyed to the SAME `2026-09-23` without moving `default.json`'s
 * `version`. A profile migrated by a build between the two is at `2026-09-23`,
 * never crosses the bash entry, and keeps whichever of the 39 it carries —
 * `^sed\s+-n\b` among them, which admits `sed -n -i s/a/b/ notes.txt`. No
 * release shipped in that window; the defect is the SHAPE, and it recurs on the
 * next retirement added without a bump.
 *
 * ## The fix
 *
 * The bundle moves to `2026-09-23.2` (the second bundle of that day — versions
 * compare as strings, so it sorts after `2026-09-23` and before `2026-09-24`),
 * and the bash entry is re-keyed to it, so an install at `2026-09-23` crosses
 * it. The guard that stops the next one — a retirement table or allow-list
 * change with no `version` bump — is F1.291's pinned hash.
 */
import { describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const SHIPPED_TEXT = readFileSync(
  join(import.meta.dir, '..', '..', '..', '..', '..', 'apps', 'electron', 'resources', 'permissions', 'default.json'),
  'utf-8',
)
const shipped = JSON.parse(SHIPPED_TEXT) as { version: string; allowedBashPatterns: Array<{ pattern: string }> }
const PERMISSIONS_MODULE_PATH = pathToFileURL(join(import.meta.dir, '..', 'permissions-config.ts')).href

/** A child importing the permissions module graph — the migration suites' measured floor. */
const SUBPROCESS_MIGRATION_TIMEOUT_MS = 120_000

/** One of the 39 retired bash strings (P2.207's predecessor of the anchored `sed -n` entry). */
const RETIRED_SED = '^sed\\s+-n\\b'

function migrateInChild(installed: unknown): { version: string; bash: string[]; stderr: string } {
  const tempRoot = mkdtempSync(join(tmpdir(), 'nessy-f1290-bundle-'))
  const tempConfig = mkdtempSync(join(tmpdir(), 'nessy-f1290-config-'))
  try {
    const bundledDir = join(tempRoot, 'resources', 'permissions')
    mkdirSync(bundledDir, { recursive: true })
    writeFileSync(join(bundledDir, 'default.json'), SHIPPED_TEXT, 'utf-8')
    const installedDir = join(tempConfig, 'permissions')
    mkdirSync(installedDir, { recursive: true })
    writeFileSync(join(installedDir, 'default.json'), JSON.stringify(installed, null, 2), 'utf-8')
    const run = Bun.spawnSync([
      process.execPath,
      '--eval',
      `import { ensureDefaultPermissions } from '${PERMISSIONS_MODULE_PATH}'; ensureDefaultPermissions();`,
    ], {
      cwd: tempRoot,
      env: { ...process.env, NESSY_CONFIG_DIR: tempConfig, NESSY_DEBUG: '1' },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const stderr = run.stderr.toString()
    if (run.exitCode !== 0) throw new Error(`subprocess failed (exit ${run.exitCode}):\n${stderr}`)
    const merged = JSON.parse(readFileSync(join(installedDir, 'default.json'), 'utf-8')) as {
      version: string
      allowedBashPatterns: Array<string | { pattern: string }>
    }
    return {
      version: merged.version,
      bash: merged.allowedBashPatterns.map(entry => (typeof entry === 'string' ? entry : entry.pattern)),
      stderr,
    }
  } finally {
    rmSync(tempRoot, { recursive: true, force: true })
    rmSync(tempConfig, { recursive: true, force: true })
  }
}

describe('F1.290 · a profile already at the retiring bundle still loses the retired bash strings', () => {
  it('an install at 2026-09-23 carrying a retired bash string loses it on the next launch', () => {
    const installed = {
      ...(JSON.parse(SHIPPED_TEXT) as Record<string, unknown>),
      version: '2026-09-23',
      allowedBashPatterns: [...shipped.allowedBashPatterns, { pattern: RETIRED_SED, comment: 'Print-only sed' }],
    }
    const { version, bash, stderr } = migrateInChild(installed)
    expect(version).toBe(shipped.version)
    expect(bash).not.toContain(RETIRED_SED)
    expect(stderr).toContain(`Retired the shipped bash pattern "${RETIRED_SED}"`)
  }, SUBPROCESS_MIGRATION_TIMEOUT_MS)

  it('CONTROL: an install already at the CURRENT bundle is not touched — a user who re-adds the string keeps it', () => {
    const installed = {
      ...(JSON.parse(SHIPPED_TEXT) as Record<string, unknown>),
      allowedBashPatterns: [...shipped.allowedBashPatterns, { pattern: RETIRED_SED, comment: 'mine, on purpose' }],
    }
    const { bash, stderr } = migrateInChild(installed)
    expect(bash).toContain(RETIRED_SED)
    expect(stderr).not.toContain('Retired the shipped')
  }, SUBPROCESS_MIGRATION_TIMEOUT_MS)
})
