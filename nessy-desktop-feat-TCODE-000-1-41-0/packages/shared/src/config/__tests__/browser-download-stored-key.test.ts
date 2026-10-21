/**
 * P6.564 — `browserDownload` as a real `config.json` key.
 *
 * The point of these three is the ENVELOPE, not the getter. `StoredConfigTopLevelSchema`
 * is `.strict()`, and `loadStoredConfig` throws `UnsupportedStorageLayoutError`
 * on any undeclared top-level key — so before the declaration in
 * `validators.ts` a user who wrote this block did not merely get it ignored,
 * they lost every OTHER setting in the file. Test 1 fails if that declaration
 * is ever tidied away.
 *
 * Subprocess-per-test, mirroring `bypass-permissions-acknowledged.test.ts`:
 * `CONFIG_DIR`/`CONFIG_FILE` resolve from `NESSY_CONFIG_DIR` at module scope, so
 * mutating `process.env` after import does not take effect, and two concurrent
 * `bun test` processes sharing one config dir would manufacture failures
 * (AGENTS.md).
 */
import { describe, expect, it } from 'bun:test'
import { mkdtempSync, writeFileSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { pathToFileURL } from 'url'

const STORAGE_MODULE_PATH = pathToFileURL(join(import.meta.dir, '..', 'storage.ts')).href
const SUBPROCESS_TEST_TIMEOUT_MS = 120_000

function setup(overrides: Record<string, unknown> = {}) {
  const configDir = mkdtempSync(join(tmpdir(), 'nessy-browser-download-'))
  const configPath = join(configDir, 'config.json')
  writeFileSync(
    configPath,
    JSON.stringify({
      storageLayoutVersion: 2,
      workspaceRefs: [],
      activeWorkspaceId: null,
      activeSessionId: null,
      // A neighbour setting that must survive every case here: the whole cost of
      // an undeclared key is that it takes the rest of the file down with it.
      memoryEnabled: false,
      ...overrides,
    }, null, 2),
    'utf-8',
  )

  function evalInModule(body: string): string {
    const run = Bun.spawnSync([
      process.execPath,
      '--eval',
      `import * as S from '${STORAGE_MODULE_PATH}'; ${body}`,
    ], { env: { ...process.env, NESSY_CONFIG_DIR: configDir }, stdout: 'pipe', stderr: 'pipe' })
    if (run.exitCode !== 0) throw new Error(`subprocess failed:\n${run.stderr.toString()}`)
    return run.stdout.toString().trim()
  }

  return { configPath, evalInModule }
}

const READ = 'process.stdout.write(JSON.stringify(S.getBrowserDownloadSettings()))'

describe('P6.564 — browserDownload in config.json', () => {
  it('is accepted by the strict envelope, and does not cost the file its other settings', () => {
    const { evalInModule } = setup({ browserDownload: { root: '/tmp/dl', ask: true } })
    expect(JSON.parse(evalInModule(READ))).toEqual({ root: '/tmp/dl', ask: true })
    // The negative half of the same fact: a REFUSED file reads as no config at
    // all, so this neighbour would come back as its default `true`.
    expect(evalInModule('process.stdout.write(String(S.getMemoryEnabled()))')).toBe('false')
  }, SUBPROCESS_TEST_TIMEOUT_MS)

  it('round-trips through disk: a fresh process reads what the setter wrote', () => {
    const { evalInModule, configPath } = setup()
    expect(JSON.parse(evalInModule(READ))).toEqual({ ask: false })
    evalInModule("S.setBrowserDownloadSettings({ root: '  /tmp/typed  ', ask: true })")
    // A second, independent process — the value came off disk, not a cache.
    expect(JSON.parse(evalInModule(READ))).toEqual({ root: '/tmp/typed', ask: true })
    expect(JSON.parse(readFileSync(configPath, 'utf-8')).browserDownload)
      .toEqual({ root: '/tmp/typed', ask: true })
  }, SUBPROCESS_TEST_TIMEOUT_MS)

  it('clearing both removes the key rather than storing an empty root', () => {
    // "Unset in the form" and "unset in config.json" have to be one state, or a
    // later reader has to guess whether an empty string means anything.
    const { evalInModule, configPath } = setup({ browserDownload: { root: '/tmp/dl', ask: true } })
    evalInModule("S.setBrowserDownloadSettings({ root: '', ask: false })")
    expect(JSON.parse(readFileSync(configPath, 'utf-8'))).not.toHaveProperty('browserDownload')
    expect(JSON.parse(evalInModule(READ))).toEqual({ ask: false })

    // A malformed value reads as unset too, which is today's behaviour rather
    // than a startup failure.
    const malformed = setup({ browserDownload: { root: 42, ask: 'yes' } })
    expect(JSON.parse(malformed.evalInModule(READ))).toEqual({ ask: false })
  }, SUBPROCESS_TEST_TIMEOUT_MS)
})
