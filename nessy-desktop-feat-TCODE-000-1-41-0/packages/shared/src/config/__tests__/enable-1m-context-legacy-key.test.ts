/**
 * F1.1241 — `enable1MContext` is a tolerated LEGACY key.
 *
 * The Extended context switch is gone (each model's own window decides), but
 * config.json files written before keep the key. `StoredConfigTopLevelSchema` is
 * `.strict()`, so dropping its declaration from `stored-config-load.ts` would
 * throw `UnsupportedStorageLayoutError` and cost the user every OTHER setting in
 * the file. The key loads, and nothing reads it.
 *
 * Subprocess-per-test, mirroring `browser-download-stored-key.test.ts`:
 * `CONFIG_DIR` resolves from `NESSY_CONFIG_DIR` at module scope.
 */
import { describe, expect, it } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { pathToFileURL } from 'url'

const STORAGE_MODULE_PATH = pathToFileURL(join(import.meta.dir, '..', 'storage.ts')).href
const SUBPROCESS_TEST_TIMEOUT_MS = 120_000

function evalWithConfig(overrides: Record<string, unknown>, body: string): string {
  const configDir = mkdtempSync(join(tmpdir(), 'nessy-f1241-legacy-'))
  writeFileSync(join(configDir, 'config.json'), JSON.stringify({
    storageLayoutVersion: 2,
    workspaceRefs: [],
    activeWorkspaceId: null,
    activeSessionId: null,
    // The neighbour that must survive: an undeclared key takes the file down with it.
    memoryEnabled: false,
    ...overrides,
  }, null, 2), 'utf-8')
  const run = Bun.spawnSync([
    process.execPath,
    '--eval',
    `import * as S from '${STORAGE_MODULE_PATH}'; ${body}`,
  ], { env: { ...process.env, NESSY_CONFIG_DIR: configDir }, stdout: 'pipe', stderr: 'pipe' })
  if (run.exitCode !== 0) throw new Error(`subprocess failed:\n${run.stderr.toString()}`)
  return run.stdout.toString().trim()
}

const READ = 'const c = S.loadStoredConfig(); process.stdout.write(JSON.stringify({ loaded: c !== null, memoryEnabled: c?.memoryEnabled, getter: typeof S.getEnable1MContext, setter: typeof S.setEnable1MContext }))'

describe('F1.1241 — enable1MContext in an old config.json', () => {
  it('still loads, keeps its neighbours, and nothing reads the key', () => {
    expect(JSON.parse(evalWithConfig({ enable1MContext: true }, READ)))
      .toEqual({ loaded: true, memoryEnabled: false, getter: 'undefined', setter: 'undefined' })
  }, SUBPROCESS_TEST_TIMEOUT_MS)

  it('BOUNDARY — the envelope is still strict for a key nobody declared', () => {
    expect(() => evalWithConfig({ enable2MContext: true }, READ)).toThrow()
  }, SUBPROCESS_TEST_TIMEOUT_MS)
})
