/**
 * P6.327 — the WRITE half of the Process Isolation panel.
 *
 * Subprocess-per-test for the same reason its sibling
 * `storage-sandbox-master-switch.test.ts` uses one: `CONFIG_DIR`/`CONFIG_FILE`
 * resolve from `NESSY_CONFIG_DIR` at module scope, so mutating `process.env`
 * after import does not take effect, and two concurrent `bun test` processes
 * sharing one config dir would manufacture failures (AGENTS.md).
 */
import { describe, expect, it } from 'bun:test'
import { mkdtempSync, writeFileSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { pathToFileURL } from 'url'
import { resolveSandboxEnabled, resolveSandboxSettings } from '../sandbox-settings.ts'

const STORAGE_MODULE_PATH = pathToFileURL(join(import.meta.dir, '..', 'storage.ts')).href
const SUBPROCESS_TEST_TIMEOUT_MS = 120_000

function setup(overrides: Record<string, unknown> = {}) {
  const configDir = mkdtempSync(join(tmpdir(), 'nessy-sandbox-switches-'))
  const configPath = join(configDir, 'config.json')
  writeFileSync(configPath, JSON.stringify({
    storageLayoutVersion: 2,
    workspaceRefs: [{ id: 'ws-1', lastAccessedAt: Date.now() }],
    activeWorkspaceId: 'ws-1',
    activeSessionId: null,
    ...overrides,
  }, null, 2), 'utf-8')
  writeFileSync(join(configDir, 'config-defaults.json'), JSON.stringify({
    version: '1.0', description: 'test fixture', defaults: {}, workspaceDefaults: {},
  }, null, 2), 'utf-8')

  function evalInModule(body: string): string {
    const run = Bun.spawnSync([
      process.execPath, '--eval', `import * as S from '${STORAGE_MODULE_PATH}'; ${body}`,
    ], { env: { ...process.env, NESSY_CONFIG_DIR: configDir }, stdout: 'pipe', stderr: 'pipe' })
    if (run.exitCode !== 0) throw new Error(`subprocess failed:\n${run.stderr.toString()}`)
    return run.stdout.toString().trim()
  }
  const readSandbox = () =>
    (JSON.parse(readFileSync(configPath, 'utf-8')) as { sandbox?: Record<string, unknown> }).sandbox

  return { evalInModule, readSandbox }
}

describe('setUserSandboxSwitches (P6.327)', () => {
  it('writes the master switch the panel could previously only display', () => {
    const { evalInModule, readSandbox } = setup()
    evalInModule('S.setUserSandboxSwitches({ enabled: true })')
    expect(readSandbox()).toEqual({ enabled: true })
  }, SUBPROCESS_TEST_TIMEOUT_MS)

  it('is a PARTIAL — writing one switch leaves the other exactly as it was', () => {
    // The panel owns two independent toggles; a write that cleared the sibling
    // would silently re-open the escape hatch when the user turned the sandbox
    // on, which is the opposite of what they asked for.
    const { evalInModule, readSandbox } = setup({
      sandbox: { allowUnsandboxedCommands: false },
    })
    evalInModule('S.setUserSandboxSwitches({ enabled: true })')
    expect(readSandbox()).toEqual({ enabled: true, allowUnsandboxedCommands: false })
  }, SUBPROCESS_TEST_TIMEOUT_MS)

  it('preserves sandbox keys it does not own', () => {
    const { evalInModule, readSandbox } = setup({
      sandbox: { enabled: false, excludedCommands: ['docker *'] },
    })
    evalInModule('S.setUserSandboxSwitches({ allowUnsandboxedCommands: true })')
    expect(readSandbox()).toEqual({
      enabled: false,
      excludedCommands: ['docker *'],
      allowUnsandboxedCommands: true,
    })
  }, SUBPROCESS_TEST_TIMEOUT_MS)

  it('CONTROL — an unusable existing sandbox value is replaced, not merged into', () => {
    const { evalInModule, readSandbox } = setup({ sandbox: 'nonsense' })
    evalInModule('S.setUserSandboxSwitches({ enabled: true })')
    expect(readSandbox()).toEqual({ enabled: true })
  }, SUBPROCESS_TEST_TIMEOUT_MS)
})

/**
 * The security claim the panel makes when it offers these switches at all: a
 * user layer cannot loosen an administrator's floor. Asserted against the two
 * resolvers the supervisor itself resolves from, so this is the real rule and
 * not a restatement of it.
 */
describe('a written user layer cannot defeat the managed floor (P6.327)', () => {
  it('a managed `enabled` wins outright, in BOTH directions', () => {
    expect(resolveSandboxEnabled([{ enabled: true }], { enabled: false })).toBe(false)
    expect(resolveSandboxEnabled([{ enabled: false }], { enabled: true })).toBe(true)
  })

  it('a managed `allowUnsandboxedCommands: false` is terminal, and a managed true is not a grant', () => {
    expect(resolveSandboxSettings([{ allowUnsandboxedCommands: true }], {
      floor: { allowUnsandboxedCommands: false },
    }).allowUnsandboxedCommands).toBe(false)
    // The asymmetry the panel's `...Managed` flags encode: a managed `true`
    // still leaves the user free to deny, so that switch stays offered.
    expect(resolveSandboxSettings([{ allowUnsandboxedCommands: false }], {
      floor: { allowUnsandboxedCommands: true },
    }).allowUnsandboxedCommands).toBe(false)
  })

  it('CONTROL — with no floor the user layer is what decides', () => {
    expect(resolveSandboxEnabled([{ enabled: true }])).toBe(true)
    expect(resolveSandboxSettings([{ allowUnsandboxedCommands: true }], {})
      .allowUnsandboxedCommands).toBe(true)
  })
})
