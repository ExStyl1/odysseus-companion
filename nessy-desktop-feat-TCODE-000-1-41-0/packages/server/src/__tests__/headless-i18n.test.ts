/**
 * P2.196 — every localized string a headless run renders must be non-empty.
 *
 * TWO facts compose badly, and neither is visible on its own:
 *
 *  1. An i18next singleton nobody initialized returns `undefined` from `t()`.
 *     NOT the key. Measured, in this file, as a positive control rather than
 *     asserted from memory — because the whole reason this shipped is that
 *     everyone assumed the other behaviour.
 *  2. The headless `nessy-server` entry never called `setupI18n()`. Only the
 *     four renderer entries and `electron/src/main/index.ts` did.
 *
 * So on a headless deployment `auth:showLogoutConfirmation` sent the client a
 * dialog with an empty title, an empty message, an empty detail and TWO empty
 * buttons; the six `/advisor` status lines yielded an `info` with no message;
 * and Pi's Guardian marker interpolated the literal word "undefined" into a
 * permission prompt's reason.
 *
 * WHY THE ASSERTION IS "NON-EMPTY" AND NOT "EQUALS ITS KEY".
 * The natural way to guard localization is to check that a key resolves — i.e.
 * that `t(k) !== k`, or in the coverage direction that a missing key comes back
 * AS the key. Both of those are statements about an INITIALIZED instance: once
 * `init()` has run, a missing key really does return the key, non-empty
 * (measured below). A key-equality guard therefore has to be written in a file
 * that has already initialized i18n — which is exactly the state production
 * lacked, so it can never observe the bug. The invariant that survives that
 * trap is the blunt one: what the user receives is a NON-EMPTY STRING. It is
 * false in the broken state and true in the fixed one, in either language.
 *
 * The subprocesses matter for the same reason. Half the suites in this repo
 * call `setupI18n()` at file scope, which would make any in-process assertion
 * here vacuously green; each case below runs in a fresh `bun` process that
 * initializes i18n exactly as much as the state under test does.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const REPO_ROOT = join(import.meta.dir, '..', '..', '..', '..')
const ENTRY = join(REPO_ROOT, 'packages', 'server', 'src', 'index.ts')
const SHARED_I18N = join(REPO_ROOT, 'packages', 'shared', 'src', 'i18n', 'index.ts')

/** Directories whose `i18n.t(...)` calls a headless process can reach. */
const HEADLESS_SOURCE_ROOTS = [
  join(REPO_ROOT, 'packages', 'shared', 'src'),
  join(REPO_ROOT, 'packages', 'server-core', 'src'),
]

interface Scan {
  keys: string[]
  filesRead: number
  callSites: number
}

/**
 * Collect the translation keys reached from non-renderer code, from source, so
 * a NEW `i18n.t('…')` on a headless path is covered without editing this file.
 *
 * Every source read here goes through `readFileSync` on a whole file: some
 * files in this tree carry a NUL byte and a line-oriented tool skips them
 * silently, which is a measured trap in this repo. Reading bytes has no such
 * blind spot.
 */
function scanHeadlessTranslationKeys(): Scan {
  const keys = new Set<string>()
  let filesRead = 0
  let callSites = 0
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry)
      const stats = statSync(full)
      if (stats.isDirectory()) {
        if (entry === 'node_modules' || entry === '__tests__' || entry === 'dist') continue
        walk(full)
        continue
      }
      if (!entry.endsWith('.ts') || entry.includes('.test.')) continue
      filesRead += 1
      const text = readFileSync(full, 'utf-8')
      if (!text.includes('i18n.t(')) continue
      for (const line of text.split('\n')) {
        if (!line.includes('i18n.t(')) continue
        callSites += 1
        for (const match of line.matchAll(/'([a-zA-Z][\w]*(?:\.[\w]+)+)'/g)) {
          keys.add(match[1]!)
        }
      }
    }
  }
  for (const root of HEADLESS_SOURCE_ROOTS) walk(root)
  return { keys: [...keys].sort(), filesRead, callSites }
}

/** Render `keys` in a fresh process, optionally initializing i18n first. */
function renderInFreshProcess(keys: string[], init: boolean): Record<string, unknown> {
  const source = `
    const m = await import(${JSON.stringify(SHARED_I18N)});
    ${init ? 'm.setupI18n();' : ''}
    const out = { __initialized: m.i18n.isInitialized ?? null };
    for (const key of ${JSON.stringify(keys)}) {
      const v = m.i18n.t(key, { name: 'n', model: 'm', limit: '$1' });
      out[key] = v === undefined ? null : v;
    }
    out.__missingKey = m.i18n.t('this.key.does.not.exist') ?? null;
    console.log(JSON.stringify(out));
  `
  const proc = Bun.spawnSync(['bun', '-e', source], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      // `config/paths.ts` refuses to run under `NODE_ENV=test` against the
      // developer's real config directory, and it is right to: a suite once
      // overwrote a real `config.json`. The probe needs neither, so it is
      // pointed at a path under the system temp directory. Nothing here ever
      // names a real home as an operand.
      NESSY_CONFIG_DIR: join(tmpdir(), 'nessy-p2196-i18n-probe'),
    },
  })
  const stdout = proc.stdout.toString().trim()
  if (proc.exitCode !== 0 || !stdout) {
    throw new Error(`probe failed (exit ${proc.exitCode}): ${proc.stderr.toString().slice(0, 800)}`)
  }
  return JSON.parse(stdout.split('\n').at(-1)!) as Record<string, unknown>
}

describe('P2.196 — headless localized strings', () => {
  const scan = scanHeadlessTranslationKeys()

  test('the scan finds real headless translation keys (anti-vacuity)', () => {
    // A guard over an empty set is the failure this row is about, one level up.
    expect(scan.filesRead).toBeGreaterThan(100)
    expect(scan.callSites).toBeGreaterThanOrEqual(10)
    expect(scan.keys.length).toBeGreaterThanOrEqual(10)
    // The two that cost the most when blank, named so the set cannot silently
    // drift off them.
    expect(scan.keys).toContain('dialog.logoutConfirmation')
    expect(scan.keys).toContain('settings.ai.guardian.judgeFailedMarker')
  })

  test('POSITIVE CONTROL: without init every one of them is undefined, not the key', () => {
    const rendered = renderInFreshProcess(scan.keys, false)
    expect(rendered.__initialized).toBeNull()
    // The measured fact this whole row rests on: absent, not degraded.
    expect(rendered.__missingKey).toBeNull()
    const nonUndefined = scan.keys.filter(key => rendered[key] !== null)
    expect(nonUndefined).toEqual([])
  })

  test('with init every headless key renders a NON-EMPTY string', () => {
    const rendered = renderInFreshProcess(scan.keys, true)
    expect(rendered.__initialized).toBe(true)
    const empty = scan.keys.filter(key => {
      const value = rendered[key]
      return typeof value !== 'string' || value.length === 0
    })
    expect(empty).toEqual([])
    // And the contrast that makes "non-empty" the right assertion rather than
    // key-equality: once initialized, a MISSING key is also non-empty — it
    // comes back as the key — so key-equality cannot separate the two states.
    expect(rendered.__missingKey).toBe('this.key.does.not.exist')
  })

  test('the headless entry initializes i18n before it can render anything', () => {
    const entry = readFileSync(ENTRY, 'utf-8')
    const calls = entry.match(/^\s*setupI18n\(\)/gm) ?? []
    expect(calls).toHaveLength(1)
    expect(entry).toContain("import { i18n, setupI18n } from '@nessy-agent/shared/i18n'")
    // Before the server exists, so no handler can answer with a blank string.
    expect(entry.indexOf('setupI18n()')).toBeLessThan(entry.indexOf('bootstrapServer<'))
  })

  test('the persisted language is applied, and only after storage readiness', () => {
    const entry = readFileSync(ENTRY, 'utf-8')
    const hydrations = entry.match(/await i18n\.changeLanguage\(persistedUiLanguage\)/g) ?? []
    expect(hydrations).toHaveLength(1)
    // `preferences.json` is user-owned config, readable only once bootstrap has
    // passed the storage-readiness gate — the same ordering
    // `electron/src/main/index.ts` states and follows.
    expect(entry.indexOf('getPersistedUiLanguage()')).toBeGreaterThan(entry.indexOf('bootstrapServer<'))
  })

  test('POSITIVE CONTROL: the entry detector flags an entry with the call removed', () => {
    const stripped = readFileSync(ENTRY, 'utf-8').replace(/^setupI18n\(\)$/m, '// removed')
    expect(stripped.match(/^\s*setupI18n\(\)/gm) ?? []).toHaveLength(0)
  })
})
