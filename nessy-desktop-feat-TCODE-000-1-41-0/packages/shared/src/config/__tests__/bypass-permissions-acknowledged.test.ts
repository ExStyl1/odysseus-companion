/**
 * T5 — `bypassPermissionsAcknowledged` durable in the user config tier
 * (`permission-modes.md`: "Claude Code saves your acceptance to user
 * settings"). Getter/setter pair next to `getMemoryEnabled`/`setMemoryEnabled`
 * in storage.ts, over a `bypassPermissionsAcknowledged?: boolean` key in
 * config.json.
 *
 * Subprocess-per-test (mirrors `storage-sandbox-master-switch.test.ts`):
 * `CONFIG_DIR`/`CONFIG_FILE` resolve from `NESSY_CONFIG_DIR` at module scope,
 * so mutating `process.env` in-process after import does not take effect, and
 * two concurrent `bun test` processes sharing one config dir would
 * manufacture failures (AGENTS.md).
 */
import { describe, expect, it } from 'bun:test'
import { mkdtempSync, writeFileSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { pathToFileURL } from 'url'

const STORAGE_MODULE_PATH = pathToFileURL(join(import.meta.dir, '..', 'storage.ts')).href
const SUBPROCESS_TEST_TIMEOUT_MS = 120_000

function setup(overrides: Record<string, unknown> = {}) {
  const configDir = mkdtempSync(join(tmpdir(), 'nessy-bypass-ack-'))
  const configPath = join(configDir, 'config.json')
  writeFileSync(
    configPath,
    JSON.stringify({
      storageLayoutVersion: 2,
      workspaceRefs: [],
      activeWorkspaceId: null,
      activeSessionId: null,
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

  return { configDir, configPath, evalInModule }
}

const READ_ACK = 'process.stdout.write(String(S.getBypassPermissionsAcknowledged()))'

describe('bypassPermissionsAcknowledged — round trip', () => {
  it('defaults to false when the key has never been written', () => {
    const { evalInModule } = setup()
    expect(evalInModule(READ_ACK)).toBe('false')
  }, SUBPROCESS_TEST_TIMEOUT_MS)

  it('setter then getter reflects true, in the same process', () => {
    const { evalInModule } = setup()
    expect(evalInModule(`S.setBypassPermissionsAcknowledged(true); ${READ_ACK}`)).toBe('true')
  }, SUBPROCESS_TEST_TIMEOUT_MS)

  it('setter writes durably: a FRESH process (new load) still reads true', () => {
    const { evalInModule } = setup()
    evalInModule('S.setBypassPermissionsAcknowledged(true)')
    // Second, independent subprocess — proves the value round-trips through
    // disk (config.json), not merely an in-process cache.
    expect(evalInModule(READ_ACK)).toBe('true')
  }, SUBPROCESS_TEST_TIMEOUT_MS)

  it('setter can also write false explicitly (same shape as setMemoryEnabled)', () => {
    const { evalInModule } = setup({ bypassPermissionsAcknowledged: true })
    expect(evalInModule(`S.setBypassPermissionsAcknowledged(false); ${READ_ACK}`)).toBe('false')
  }, SUBPROCESS_TEST_TIMEOUT_MS)

  it('an existing true value is read back without needing a setter call', () => {
    const { evalInModule } = setup({ bypassPermissionsAcknowledged: true })
    expect(evalInModule(READ_ACK)).toBe('true')
  }, SUBPROCESS_TEST_TIMEOUT_MS)

  it('preserves unrelated fields on write (does not clobber sibling settings)', () => {
    const { evalInModule, configPath } = setup({ notificationsEnabled: false, memoryEnabled: false })
    evalInModule('S.setBypassPermissionsAcknowledged(true)')
    const raw = JSON.parse(readFileSync(configPath, 'utf-8'))
    expect(raw.bypassPermissionsAcknowledged).toBe(true)
    expect(raw.notificationsEnabled).toBe(false)
    expect(raw.memoryEnabled).toBe(false)
  }, SUBPROCESS_TEST_TIMEOUT_MS)
})

describe('bypassPermissionsAcknowledged — schema migration / forward-compat', () => {
  it('a config.json predating this key (key absent) still loads without throwing', () => {
    // Guards the StoredConfigTopLevelSchema declaration: an undeclared
    // top-level key makes loadStoredConfig() throw UnsupportedStorageLayoutError
    // and costs the user every OTHER setting in config.json (storage.ts's own
    // history around this exact failure mode). A pre-existing install's
    // config.json never had this key and must keep loading cleanly.
    const { evalInModule } = setup()
    expect(evalInModule(READ_ACK)).toBe('false')
  }, SUBPROCESS_TEST_TIMEOUT_MS)

  it('round-trips through the strict top-level schema within one process (set then get)', () => {
    // setBypassPermissionsAcknowledged() writes via saveConfig(), which does
    // NOT itself validate; the very next getBypassPermissionsAcknowledged()
    // call re-invokes loadStoredConfig(), which DOES run the key through
    // StoredConfigTopLevelSchema (.strict()). If the key were undeclared
    // there, this single script would throw UnsupportedStorageLayoutError
    // instead of returning a value.
    const { evalInModule } = setup()
    expect(evalInModule(`S.setBypassPermissionsAcknowledged(true); ${READ_ACK}`)).toBe('true')
  }, SUBPROCESS_TEST_TIMEOUT_MS)
})
