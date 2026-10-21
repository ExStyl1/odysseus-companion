/**
 * F1.258 follow-up — the SAME retirement for the shipped BASH allow-list: every
 * shipped string a later bundle tightened leaves an installed `default.json`.
 *
 * ## The hole, measured 2026-09-23 from the file's own history
 *
 * `migratePermissions` only ever APPENDED, so every shipped bash pattern a
 * later bundle replaced stayed in the installed copy beside its successor — and
 * an allow-list is a union, so the loose one is the verdict. P2.207
 * (`64c6a8391`, 2026-08-26) anchored 19 entries after measuring 56 holes
 * (`python -c import os --help` allowed through an unanchored `--help\b`, `sed
 * -n -i`, `git branch -D main`, `gh api -X DELETE`, …) but did not move the
 * bundle's `version`; the next bump (`feea4b1b9`, `2026-08-28`) migrated every
 * older install by APPENDING the anchored entries and keeping the holes. So on
 * any install first seeded before that release the P2.207 holes are live today.
 *
 * The list below is every `allowedBashPatterns` string any bundle ever shipped
 * that the current one does not — the union over the eleven commits that touched
 * the file (aadf3a052 … e6296c0f7) minus HEAD: the 19 P2.207 predecessors, the
 * ten dead `nessy-general-agent` CLI entries 2ea932a19 removed, and the ten
 * `craft-agent` spellings of those from the pre-rebrand seed. It is history and
 * never changes. `retireShippedPatterns` (`permissions-config.ts`) carries the
 * same list; this copy is the independent one, so a typo there reads red here.
 */
import { describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { validateBashCommand } from '../bash-validator.ts'

const SHIPPED_TEXT = readFileSync(
  join(import.meta.dir, '..', '..', '..', '..', '..', 'apps', 'electron', 'resources', 'permissions', 'default.json'),
  'utf-8',
)
const shipped = JSON.parse(SHIPPED_TEXT) as { version: string; allowedBashPatterns: Array<{ pattern: string; comment?: string }> }
const PERMISSIONS_MODULE_PATH = pathToFileURL(join(import.meta.dir, '..', 'permissions-config.ts')).href

const RETIRED_SHIPPED_BASH: readonly string[] = [
  '^craft-agent\\s+label\\s+(list|get|auto-rule-list|auto-rule-validate)\\b',
  '^craft-agent\\s+source\\s+(list|get|validate|test|auth-help)\\b',
  '^craft-agent\\s+skill\\s+(list|get|validate|where)\\b',
  '^craft-agent\\s+automation\\s+(list|get|validate|history|last-executed|test|lint)\\b',
  '^craft-agent\\s+permission\\s+(list|get|validate)\\b',
  '^craft-agent\\s+theme\\s+(get|validate|list-presets|get-preset)\\b',
  '^craft-agent\\s*$',
  '^craft-agent\\s+(label|source|skill|automation|permission|theme)\\s*$',
  '^craft-agent\\s+(label|source|skill|automation|permission|theme)\\s+--help\\b',
  '^craft-agent\\s+--(help|version|discover)\\b',
  '^fd\\b',
  '^git\\s+((-[A-Za-z]|--[a-z][-a-z]*)(\\s+[^\\s-][^\\s]*)?\\s+)*(status|log|diff|show|branch|tag|remote|stash\\s+list|describe|rev-parse|config\\s+--get|config\\s+-l|ls-files|ls-tree|shortlog|blame|annotate|reflog|cherry|whatchanged|ls-remote|history)\\b',
  '^gh\\s+api\\b.*--method\\s+GET\\b',
  '^gh\\s+api\\b(?!.*--method)',
  '^npm\\s+(ls|list|view|info|show|outdated|audit|search|explain|why|config\\s+get|config\\s+list)\\b',
  '^pnpm\\s+(list|ls|why|outdated|audit)\\b',
  '^kubectl\\s+(get|describe|logs|top|explain|api-resources|api-versions|cluster-info|config\\s+view|config\\s+get-contexts|version)\\b',
  '^sed\\s+-n\\b',
  '^sort\\b',
  '^uniq\\b',
  '^yq\\b',
  '^xq\\b',
  '^xmllint\\b',
  '^python\\s+-m\\s+json\\.tool\\b',
  '^ss\\b',
  '^ip\\s+(addr|link|route|neigh)\\s*(show)?\\b',
  '^ifconfig\\b',
  '--help\\b',
  '-h\\b$',
  '^nessy-general-agent\\s+label\\s+(list|get|auto-rule-list|auto-rule-validate)\\b',
  '^nessy-general-agent\\s+source\\s+(list|get|validate|test|auth-help)\\b',
  '^nessy-general-agent\\s+skill\\s+(list|get|validate|where)\\b',
  '^nessy-general-agent\\s+automation\\s+(list|get|validate|history|last-executed|test|lint)\\b',
  '^nessy-general-agent\\s+permission\\s+(list|get|validate)\\b',
  '^nessy-general-agent\\s+theme\\s+(get|validate|list-presets|get-preset)\\b',
  '^nessy-general-agent\\s*$',
  '^nessy-general-agent\\s+(label|source|skill|automation|permission|theme)\\s*$',
  '^nessy-general-agent\\s+(label|source|skill|automation|permission|theme)\\s+--help\\b',
  '^nessy-general-agent\\s+--(help|version|discover)\\b',
]

/** The spawn arm's budget — the same measured floor as `permissions-config-migration.test.ts`. */
const SUBPROCESS_MIGRATION_TIMEOUT_MS = 120_000

const USER_ENTRY = { pattern: '^mytool\\s+status\\b', comment: 'mine: a user-added read' }

function migrateInChild(installed: unknown): { merged: { version: string; allowedBashPatterns: Array<string | { pattern: string }> }; stderr: string } {
  const tempRoot = mkdtempSync(join(tmpdir(), 'nessy-f1258b-bundle-'))
  const tempConfig = mkdtempSync(join(tmpdir(), 'nessy-f1258b-config-'))
  try {
    mkdirSync(join(tempRoot, 'resources', 'permissions'), { recursive: true })
    writeFileSync(join(tempRoot, 'resources', 'permissions', 'default.json'), SHIPPED_TEXT, 'utf-8')
    mkdirSync(join(tempConfig, 'permissions'), { recursive: true })
    writeFileSync(join(tempConfig, 'permissions', 'default.json'), JSON.stringify(installed, null, 2), 'utf-8')
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
    return { merged: JSON.parse(readFileSync(join(tempConfig, 'permissions', 'default.json'), 'utf-8')), stderr }
  } finally {
    rmSync(tempRoot, { recursive: true, force: true })
    rmSync(tempConfig, { recursive: true, force: true })
  }
}

const patternOf = (entry: string | { pattern: string }): string => (typeof entry === 'string' ? entry : entry.pattern)

describe('F1.258 follow-up · an installed default.json drops the retired shipped bash strings', () => {
  it('no retired string is still shipped — the retirement can never remove a live pattern', () => {
    const live = new Set(shipped.allowedBashPatterns.map(entry => entry.pattern))
    expect(RETIRED_SHIPPED_BASH.filter(pattern => live.has(pattern))).toEqual([])
  })

  it('an install migrated before the fix loses exactly the retired strings, keeps the user entry, and the P2.207 holes close', () => {
    // What an install first seeded before 2026-08-28 carries today: its old
    // entries first, the anchored successors the 2026-08-28 migration appended
    // after them, and one entry of the user's own.
    const installed = {
      ...(JSON.parse(SHIPPED_TEXT) as Record<string, unknown>),
      version: '2026-08-28',
      allowedBashPatterns: [
        ...RETIRED_SHIPPED_BASH.map(pattern => ({ pattern, comment: 'an older bundle' })),
        USER_ENTRY,
        ...shipped.allowedBashPatterns,
      ],
    }
    const { merged, stderr } = migrateInChild(installed)

    const patterns = merged.allowedBashPatterns.map(patternOf)
    expect(patterns.filter(pattern => RETIRED_SHIPPED_BASH.includes(pattern))).toEqual([])
    for (const entry of shipped.allowedBashPatterns) {
      expect(patterns.filter(pattern => pattern === entry.pattern)).toHaveLength(1)
    }
    expect(merged.allowedBashPatterns).toContainEqual(USER_ENTRY)
    const lines = stderr.split('\n').filter(line => line.includes('[Permissions] Retired the shipped bash pattern'))
    expect(lines).toHaveLength(RETIRED_SHIPPED_BASH.length)

    // The verdicts the retired strings used to give, on the MIGRATED file.
    const compiled = merged.allowedBashPatterns.map(entry => ({ regex: new RegExp(patternOf(entry)), source: patternOf(entry) }))
    const explore = (command: string) => (validateBashCommand(command, compiled).allowed ? 'allow' : 'block')
    expect({
      helpSmuggle: explore('python -c import os --help'),
      shortHelpSmuggle: explore('sh deploy.sh -h'),
      sedInPlace: explore('sed -n -i s/a/b/ notes.txt'),
      gitBranchDelete: explore('git branch -D main'),
      ghApiDelete: explore('gh api -X DELETE repos/o/r'),
    }).toEqual({ helpSmuggle: 'block', shortHelpSmuggle: 'block', sedInPlace: 'block', gitBranchDelete: 'block', ghApiDelete: 'block' })
    // CONTROL: the reads those tightenings kept.
    expect({ help: explore('ls --help'), status: explore('git status'), sedRead: explore('sed -n 1,5p notes.txt') })
      .toEqual({ help: 'allow', status: 'allow', sedRead: 'allow' })
  }, SUBPROCESS_MIGRATION_TIMEOUT_MS)
})

/**
 * UA12.184 — bundle `2026-10-09` (UA12.88, development builds only; no release carried it)
 * shipped upstream v0.14.0's two `gh api` entries instead of the anchored one. Bundle
 * `2026-10-09.2` ships the anchored entry again and retires the two, so a profile at
 * `2026-10-09` loses them and the merge appends the anchored entry from the bundle.
 */
describe('UA12.184 · an install at bundle 2026-10-09 trades upstream\'s two gh api entries back for the anchored one', () => {
  const UPSTREAM_GH_API = ['^gh\\s+api\\b.*--method\\s+GET\\b', '^gh\\s+api\\b(?!.*--method)']
  const ANCHORED_GH_API = '^gh\\s+api\\b(?!.*\\s-[XfF](?:[\\s=]|$))(?!.*\\s--(?:field|raw-field|input)(?:[\\s=]|$))(?!.*\\s--method(?:[\\s=])(?!GET\\b))'

  it('ensureDefaultPermissions retires the two, appends the anchored entry once, keeps the user entry; the smart-quote and GET-with-field spellings are refused again', () => {
    const installed = {
      ...(JSON.parse(SHIPPED_TEXT) as Record<string, unknown>),
      version: '2026-10-09',
      allowedBashPatterns: [
        ...shipped.allowedBashPatterns.filter(entry => entry.pattern !== ANCHORED_GH_API),
        ...UPSTREAM_GH_API.map(pattern => ({ pattern, comment: 'the 2026-10-09 bundle' })),
        USER_ENTRY,
      ],
    }
    const { merged, stderr } = migrateInChild(installed)

    expect(merged.version).toBe(shipped.version)
    const patterns = merged.allowedBashPatterns.map(patternOf)
    for (const upstream of UPSTREAM_GH_API) expect(patterns).not.toContain(upstream)
    expect(patterns.filter(pattern => pattern === ANCHORED_GH_API)).toHaveLength(1)
    expect(merged.allowedBashPatterns).toContainEqual(USER_ENTRY)
    const lines = stderr.split('\n').filter(line => line.includes('[Permissions] Retired the shipped bash pattern'))
    expect(lines).toHaveLength(2)

    const compiled = merged.allowedBashPatterns.map(entry => ({ regex: new RegExp(patternOf(entry)), source: patternOf(entry) }))
    const explore = (command: string) => (validateBashCommand(command, compiled).allowed ? 'allow' : 'block')
    expect({ getWithField: explore('gh api -X GET search/issues -f q=bug'), del: explore('gh api -X DELETE repos/o/r') })
      .toEqual({ getWithField: 'block', del: 'block' })
    // CONTROL: the plain GET reads the anchored entry keeps.
    expect({ get: explore('gh api repos/o/r'), methodGet: explore('gh api --method=GET repos/o/r') })
      .toEqual({ get: 'allow', methodGet: 'allow' })
  }, SUBPROCESS_MIGRATION_TIMEOUT_MS)
})
