/**
 * T1 contour (b) — `getMacosSeatbeltBashSandboxEnabled` outranked by the
 * `sandbox.enabled` master switch.
 *
 * Subprocess-per-test (mirrors `storage-zoom-factor.test.ts`): `CONFIG_DIR`/
 * `CONFIG_FILE` resolve from `NESSY_CONFIG_DIR` at module scope, so mutating
 * `process.env` in-process after import does not take effect, and two
 * concurrent `bun test` processes sharing one config dir would manufacture
 * failures (AGENTS.md).
 */
import { describe, expect, it } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { pathToFileURL } from 'url'

const STORAGE_MODULE_PATH = pathToFileURL(join(import.meta.dir, '..', 'storage.ts')).href
const SUBPROCESS_TEST_TIMEOUT_MS = 120_000

function setup(overrides: Record<string, unknown> = {}) {
  const configDir = mkdtempSync(join(tmpdir(), 'nessy-sandbox-master-switch-'))
  const configPath = join(configDir, 'config.json')
  writeFileSync(
    configPath,
    JSON.stringify({
      storageLayoutVersion: 2,
      workspaceRefs: [{ id: 'ws-1', lastAccessedAt: Date.now() }],
      activeWorkspaceId: 'ws-1',
      activeSessionId: null,
      ...overrides,
    }, null, 2),
    'utf-8',
  )
  // getMacosSeatbeltBashSandboxEnabled() falls back to loadConfigDefaults()
  // whenever config.json omits the legacy key; ensureConfigDir() is what
  // seeds this file in production (from the bundled asset), so a bare temp
  // dir needs the same minimal fixture — the real bundled default per §0
  // contour b ("macosSeatbeltBashSandboxEnabled": false).
  writeFileSync(
    join(configDir, 'config-defaults.json'),
    JSON.stringify({
      version: '1.0',
      description: 'test fixture',
      defaults: { macosSeatbeltBashSandboxEnabled: false },
      workspaceDefaults: {},
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

  return { configDir, evalInModule }
}

const READ_SEATBELT = 'process.stdout.write(String(S.getMacosSeatbeltBashSandboxEnabled()))'

describe('getMacosSeatbeltBashSandboxEnabled — the master switch outranks the legacy key', () => {
  it('legacy key true + master off (sandbox.enabled: false) -> false', () => {
    const { evalInModule } = setup({
      macosSeatbeltBashSandboxEnabled: true,
      sandbox: { enabled: false },
    })
    expect(evalInModule(READ_SEATBELT)).toBe('false')
  }, SUBPROCESS_TEST_TIMEOUT_MS)

  it('legacy key true + master on (sandbox.enabled: true) -> true', () => {
    const { evalInModule } = setup({
      macosSeatbeltBashSandboxEnabled: true,
      sandbox: { enabled: true },
    })
    expect(evalInModule(READ_SEATBELT)).toBe('true')
  }, SUBPROCESS_TEST_TIMEOUT_MS)

  it('legacy key true + master unset resolves the new default (off) -> false', () => {
    // SANDBOX_ENABLED_DEFAULT is false (T1, 2026-08-12): a legacy key set alone,
    // with no explicit sandbox.enabled anywhere, no longer turns the seatbelt on
    // — the master switch outranks it even by omission, not only by an explicit
    // false.
    const { evalInModule } = setup({
      macosSeatbeltBashSandboxEnabled: true,
    })
    expect(evalInModule(READ_SEATBELT)).toBe('false')
  }, SUBPROCESS_TEST_TIMEOUT_MS)

  it('legacy key unset + master on stays off — the legacy key still needs its own true', () => {
    const { evalInModule } = setup({
      sandbox: { enabled: true },
    })
    expect(evalInModule(READ_SEATBELT)).toBe('false')
  }, SUBPROCESS_TEST_TIMEOUT_MS)

  it('nothing set anywhere stays off, matching the bundled config-defaults.json contour-b fact', () => {
    const { evalInModule } = setup({})
    expect(evalInModule(READ_SEATBELT)).toBe('false')
  }, SUBPROCESS_TEST_TIMEOUT_MS)
})

/**
 * Review fix (2026-08-13): contour (b) used to resolve the master switch from
 * the user layer alone (`resolveSandboxEnabled([getUserSandboxSettings()])`,
 * no floor), so a MANAGED policy setting `sandbox.enabled` was invisible to
 * it even though contour (a) (`ProcessSupervisor`) already honored it. Fixed
 * by threading `resolveManagedSandboxEnabledFloor()` — the same
 * `registerManagedSandboxEnabledProvider` bridge `CodexAgent.sandboxGloballyEnabled`
 * (contour e) now uses — as `resolveSandboxEnabled`'s floor argument.
 *
 * The suite above (no provider ever registered) is the "unregistered ⇒
 * unchanged" evidence: it is untouched by this fix and still passes
 * identically, because an unregistered provider makes
 * `resolveManagedSandboxEnabledFloor()` return `undefined`, and
 * `resolveSandboxEnabled(layers, undefined)` behaves exactly like
 * `resolveSandboxEnabled(layers)` did before.
 */
describe('getMacosSeatbeltBashSandboxEnabled — the MANAGED floor outranks the user layer too', () => {
  it('a managed floor enabled:true forces contour (b) ON even when the user layer says false', () => {
    const { evalInModule } = setup({
      macosSeatbeltBashSandboxEnabled: true,
      sandbox: { enabled: false },
    })
    expect(evalInModule(`S.registerManagedSandboxEnabledProvider(() => true); ${READ_SEATBELT}`)).toBe('true')
  }, SUBPROCESS_TEST_TIMEOUT_MS)

  it('a managed floor enabled:false forces contour (b) OFF even when the user layer says true', () => {
    const { evalInModule } = setup({
      macosSeatbeltBashSandboxEnabled: true,
      sandbox: { enabled: true },
    })
    expect(evalInModule(`S.registerManagedSandboxEnabledProvider(() => false); ${READ_SEATBELT}`)).toBe('false')
  }, SUBPROCESS_TEST_TIMEOUT_MS)
})
