import { describe, expect, it, setDefaultTimeout } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { pathToFileURL } from 'url'

setDefaultTimeout(30_000)

// P2.293 (re-derived). Every mutator in config/storage.ts used to answer an
// absent config.json with a bare `if (!config) return;` — 34 of them, `void`,
// so the caller could not tell the write had been dropped. `/advisor on` was
// the reported symptom; `setBypassPermissionsAcknowledged` and
// `setNetworkProxySettings` are the two live security-relevant siblings.
//
// The rule these tests pin, once, for all of them:
//   - never CREATE the config (that is the fail-open shape
//     UnsupportedStorageLayoutError exists to prevent, and it would bypass the
//     host lease that owns storage-root installation),
//   - never THROW (these run from RPC handlers, window/auto-update events and
//     boot-time cleanup, where an exception skips work nobody is watching),
//   - never stay SILENT: warn, and return false.
//
// CONFIG_DIR freezes at first import of config/paths.ts, so every case runs in
// a fresh subprocess with its own NESSY_CONFIG_DIR — the real storage path, no
// doubles, which is the only way this suite can fail if the rule regresses.

const STORAGE_MODULE_PATH = pathToFileURL(join(import.meta.dir, '..', 'storage.ts')).href
const STORAGE_SOURCE_PATH = join(import.meta.dir, '..', 'storage.ts')

function makeConfigDir(): string {
  return mkdtempSync(join(tmpdir(), 'nessy-setter-rule-'))
}

function writeValidConfig(configDir: string): void {
  writeFileSync(join(configDir, 'config.json'), JSON.stringify({
    storageLayoutVersion: 2,
    workspaceRefs: [],
    activeWorkspaceId: null,
  }))
}

interface CallResult {
  threw: boolean
  returned?: unknown
  message?: string
  stderr: string
}

/** Invoke one storage mutator in a subprocess pinned to `configDir`. */
function callSetter(configDir: string, expression: string): CallResult {
  const run = Bun.spawnSync([
    process.execPath,
    '--eval',
    `
      import * as S from '${STORAGE_MODULE_PATH}';
      try {
        const returned = ${expression};
        process.stdout.write(JSON.stringify({ threw: false, returned }));
      } catch (e) {
        process.stdout.write(JSON.stringify({
          threw: true,
          message: e instanceof Error ? e.message : String(e),
        }));
      }
    `,
  ], { env: { ...process.env, NESSY_CONFIG_DIR: configDir }, stdout: 'pipe', stderr: 'pipe' })

  if (run.exitCode !== 0) {
    throw new Error(`subprocess crashed unexpectedly (exit ${run.exitCode}):\n${run.stderr.toString()}`)
  }
  return { ...JSON.parse(run.stdout.toString().trim()), stderr: run.stderr.toString() }
}

// One boolean knob, one security-relevant boolean, one security-relevant
// object setter. Chosen for coverage of the shapes, not for volume — the
// structural case below is what holds the rule across all 42.
const CASES: Array<{ name: string; call: string; assertPersisted: (config: any) => void }> = [
  {
    name: 'setAdvisorEnabled',
    call: 'S.setAdvisorEnabled(true)',
    assertPersisted: config => expect(config.advisorEnabled).toBe(true),
  },
  {
    name: 'setBypassPermissionsAcknowledged',
    call: 'S.setBypassPermissionsAcknowledged(true)',
    assertPersisted: config => expect(config.bypassPermissionsAcknowledged).toBe(true),
  },
  {
    name: 'setNetworkProxySettings',
    call: `S.setNetworkProxySettings({ enabled: true, httpProxy: 'http://127.0.0.1:8080' })`,
    assertPersisted: config => expect(config.networkProxy?.enabled).toBe(true),
  },
]

describe('storage mutators, config.json absent', () => {
  for (const testCase of CASES) {
    it(`${testCase.name} reports failure, warns, and does not create the config`, () => {
      const configDir = makeConfigDir()
      const configFile = join(configDir, 'config.json')
      expect(existsSync(configFile)).toBe(false)

      const result = callSetter(configDir, testCase.call)

      // Does not throw — the teardown/boot-path half of the rule.
      expect(result.threw).toBe(false)
      // Reports the failure to the caller, rather than a silent `undefined`.
      expect(result.returned).toBe(false)
      // Says so out loud, naming the setter.
      expect(result.stderr).toContain(testCase.name)
      expect(result.stderr).toContain('was NOT persisted')
      // Never creates a storage root behind the host lease's back.
      expect(existsSync(configFile)).toBe(false)
    })
  }
})

describe('storage mutators, config.json present (positive control)', () => {
  for (const testCase of CASES) {
    it(`${testCase.name} persists and reports success`, () => {
      const configDir = makeConfigDir()
      writeValidConfig(configDir)

      const result = callSetter(configDir, testCase.call)

      expect(result.threw).toBe(false)
      expect(result.returned).toBe(true)
      expect(result.stderr).not.toContain('was NOT persisted')
      testCase.assertPersisted(JSON.parse(readFileSync(join(configDir, 'config.json'), 'utf-8')))
    })
  }
})

describe('the rule holds for every mutator, not just the sampled ones', () => {
  // A behavioural test can only sample; this is what catches setter number 43
  // being written in the old shape. It reads the source, not the module, so a
  // new mutator that never gets a test of its own still trips it.
  const source = readFileSync(STORAGE_SOURCE_PATH, 'utf-8')

  it('no mutator answers an absent config with a bare silent return', () => {
    expect(source).not.toContain('if (!config) return;')
  })

  it('every saveConfig() caller loads through loadConfigForMutation', () => {
    const functions = [...source.matchAll(/^(?:export )?function ([A-Za-z0-9_$]+)\s*[(<]/gm)]
    const offenders: string[] = []
    for (let i = 0; i < functions.length; i++) {
      const start = functions[i]!.index!
      const end = i + 1 < functions.length ? functions[i + 1]!.index! : source.length
      const name = functions[i]![1]!
      const body = source.slice(start, end)
      if (name === 'saveConfig') continue
      // Documented single exception: a resolver whose write is incidental, so
      // "no config" is a correct ANSWER rather than a dropped write.
      if (name === 'resolveHeldModelThinkingLevel') continue
      if (!/\bsaveConfig\s*\(/.test(body)) continue
      if (!/\bloadConfigForMutation\s*\(/.test(body)) offenders.push(name)
    }
    expect(offenders).toEqual([])
  })

  it('the sampled setters are a real subset of the mutators the rule covers', () => {
    // Positive control for the two assertions above: if the scan found nothing
    // at all, they would both pass vacuously.
    const routed = [...source.matchAll(/loadConfigForMutation\('([A-Za-z0-9_$]+)'\)/g)].map(m => m[1])
    expect(routed.length).toBeGreaterThanOrEqual(40)
    for (const testCase of CASES) expect(routed).toContain(testCase.name)
  })
})
