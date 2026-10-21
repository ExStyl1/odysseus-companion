/**
 * F1.293 (origin WJ-dd P-WJ-dd-5 + its verifier's F1.258-f) — the retirement of
 * a shipped string is reported on a channel a PACKAGED build keeps.
 *
 * ## The defect
 *
 * `retireShippedPatterns` (`permissions-config.ts`) drops a retired shipped
 * string from an installed `default.json` while crossing its version, and until
 * this row it said so only through `debug()`, which is gated on `NESSY_DEBUG` —
 * a packaged build wrote nothing. The retirement matches by EXACT string, so a
 * user entry spelled like a retired one disappears with it, and nothing anywhere
 * recorded that it had.
 *
 * ## The fix, and why it lives where the retirement happens
 *
 * Each retired string is written, always-on, to stderr and to
 * `<config dir>/logs/boot.log` — the startup sink the desktop's boot-fatal path
 * already appends to (`apps/electron/src/main/boot-fatal.ts`,
 * `createBootDiagnosticWriter`), and which the headless server shares through the
 * same config directory. Both hosts call `ensureDefaultPermissions` once per
 * launch and a retirement runs only while crossing its version, so the report is
 * written once, by the one function both hosts already call — no host carries a
 * second copy of it.
 *
 * Every arm drives a CHILD with `NESSY_DEBUG` removed from its environment, so
 * `debug()` is off exactly as in a packaged build.
 */
import { describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const SHIPPED_TEXT = readFileSync(
  join(import.meta.dir, '..', '..', '..', '..', '..', 'apps', 'electron', 'resources', 'permissions', 'default.json'),
  'utf-8',
)
const shipped = JSON.parse(SHIPPED_TEXT) as {
  version: string
  allowedBashPatterns: Array<{ pattern: string }>
  allowedMcpPatterns: Array<{ pattern: string }>
}
const PERMISSIONS_MODULE_PATH = pathToFileURL(join(import.meta.dir, '..', 'permissions-config.ts')).href

/** A child importing the permissions module graph — the migration suites' measured floor. */
const SUBPROCESS_MIGRATION_TIMEOUT_MS = 120_000

/** One retired bash string and one retired MCP string, each also a plausible USER entry. */
const RETIRED_SED = '^sed\\s+-n\\b'
const RETIRED_STATUS = 'status'
/** The seed's awk hint key (`command::whenNotMatching::reason`), which the current bundle still carries (F1.1170). */
const RETIRED_AWK_HINT = 'awk::::awk is blocked when the command appears to execute external commands.'

interface Launch { stderr: string; bootLog: string | null }

/**
 * Run `ensureDefaultPermissions` in a child with debug OFF. `installed` is the
 * file the profile holds before the launch (null: a fresh profile); `configDir`
 * lets a second launch reuse the first one's profile.
 */
function launch(installed: unknown | null, configDir?: string): Launch & { configDir: string } {
  const tempRoot = mkdtempSync(join(tmpdir(), 'nessy-f1293-bundle-'))
  const tempConfig = configDir ?? mkdtempSync(join(tmpdir(), 'nessy-f1293-config-'))
  try {
    const bundledDir = join(tempRoot, 'resources', 'permissions')
    mkdirSync(bundledDir, { recursive: true })
    writeFileSync(join(bundledDir, 'default.json'), SHIPPED_TEXT, 'utf-8')
    if (installed !== null) {
      mkdirSync(join(tempConfig, 'permissions'), { recursive: true })
      writeFileSync(join(tempConfig, 'permissions', 'default.json'), JSON.stringify(installed, null, 2), 'utf-8')
    }
    const env: Record<string, string | undefined> = { ...process.env, NESSY_CONFIG_DIR: tempConfig }
    delete env.NESSY_DEBUG
    const run = Bun.spawnSync([
      process.execPath,
      '--eval',
      `import { ensureDefaultPermissions } from '${PERMISSIONS_MODULE_PATH}'; ensureDefaultPermissions();`,
    ], { cwd: tempRoot, env, stdout: 'pipe', stderr: 'pipe' })
    const stderr = run.stderr.toString()
    if (run.exitCode !== 0) throw new Error(`subprocess failed (exit ${run.exitCode}):\n${stderr}`)
    const bootLogPath = join(tempConfig, 'logs', 'boot.log')
    return { stderr, bootLog: existsSync(bootLogPath) ? readFileSync(bootLogPath, 'utf-8') : null, configDir: tempConfig }
  } finally {
    rmSync(tempRoot, { recursive: true, force: true })
  }
}

const retiredLines = (text: string | null) => (text ?? '').split('\n').filter(line => line.includes('Retired the shipped'))

describe('F1.293 · a retired shipped string is reported with NESSY_DEBUG unset', () => {
  it('a migrating profile reports each retired string — the user\'s look-alike included — on stderr AND in boot.log', () => {
    const installed = {
      ...(JSON.parse(SHIPPED_TEXT) as Record<string, unknown>),
      version: '2026-09-06',
      allowedBashPatterns: [...shipped.allowedBashPatterns, { pattern: RETIRED_SED, comment: 'mine' }],
      allowedMcpPatterns: [...shipped.allowedMcpPatterns, { pattern: RETIRED_STATUS, comment: 'mine' }],
    }
    const first = launch(installed)
    try {
      const expected = [
        `Retired the shipped bash pattern "${RETIRED_SED}"`,
        `Retired the shipped unanchored MCP pattern "${RETIRED_STATUS}"`,
        // F1.1170 — the profile is a copy of the CURRENT bundle, and the bundle's
        // awk hint keeps the seed's merge key (only its `tryInstead` changed), so
        // crossing `2026-09-29` retires it and the merge re-appends the bundle's
        // text: the third retired string, by design of that entry.
        `Retired the shipped command hint "${RETIRED_AWK_HINT}"`,
      ]
      for (const needle of expected) {
        expect(first.stderr).toContain(needle)
        expect(first.bootLog ?? '').toContain(needle)
      }
      expect(retiredLines(first.bootLog)).toHaveLength(expected.length)
      // Once: the next launch finds the profile at the current bundle and writes nothing more.
      const second = launch(null, first.configDir)
      expect(retiredLines(second.stderr)).toEqual([])
      expect(retiredLines(second.bootLog)).toHaveLength(expected.length)
    } finally {
      rmSync(first.configDir, { recursive: true, force: true })
    }
  }, SUBPROCESS_MIGRATION_TIMEOUT_MS)

  it('CONTROL: a fresh profile retires nothing and reports nothing', () => {
    const fresh = launch(null)
    try {
      expect(retiredLines(fresh.stderr)).toEqual([])
      expect(retiredLines(fresh.bootLog)).toEqual([])
      expect(JSON.parse(readFileSync(join(fresh.configDir, 'permissions', 'default.json'), 'utf-8')).version).toBe(shipped.version)
    } finally {
      rmSync(fresh.configDir, { recursive: true, force: true })
    }
  }, SUBPROCESS_MIGRATION_TIMEOUT_MS)
})
