/**
 * P6.50 — the notification boolean widened to the page's three positions, plus
 * the two separate alert controls beside it.
 *
 * `learn.chatgpt.com/docs/notifications.md#configure-desktop-notifications` —
 * "Open [**Settings**](codex://settings) to choose whether turn-completion
 * alerts appear never, only while ChatGPT is in the background, or always.
 * Separate controls let you turn permission and question notifications on or
 * off."
 *
 * Subprocess-per-test (mirrors `bypass-permissions-acknowledged.test.ts`):
 * `CONFIG_DIR`/`CONFIG_FILE` resolve from `NESSY_CONFIG_DIR` at module scope,
 * so mutating `process.env` in-process after import does not take effect, and
 * two concurrent `bun test` processes sharing one config dir would manufacture
 * failures (AGENTS.md).
 */
import { describe, expect, it } from 'bun:test'
import { copyFileSync, mkdtempSync, writeFileSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { pathToFileURL } from 'url'

const STORAGE_MODULE_PATH = pathToFileURL(join(import.meta.dir, '..', 'storage.ts')).href
/** The bundled file the app syncs into the config dir on every launch. */
const BUNDLED_DEFAULTS = join(
  import.meta.dir, '..', '..', '..', '..', '..',
  'apps', 'electron', 'resources', 'config-defaults.json',
)
const SUBPROCESS_TEST_TIMEOUT_MS = 120_000

function setup(overrides: Record<string, unknown> = {}, options: { withDefaults?: boolean } = {}) {
  const configDir = mkdtempSync(join(tmpdir(), 'nessy-notif-settings-'))
  const configPath = join(configDir, 'config.json')
  if (options.withDefaults !== false) {
    copyFileSync(BUNDLED_DEFAULTS, join(configDir, 'config-defaults.json'))
  }
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

const READ_SETTINGS = 'process.stdout.write(JSON.stringify(S.getNotificationSettings()))'
const READ_ENABLED = 'process.stdout.write(String(S.getNotificationsEnabled()))'

describe('notification settings — the boolean migration', () => {
  it('an untouched config resolves to the bundled default, position two', () => {
    const { evalInModule } = setup()
    expect(JSON.parse(evalInModule(READ_SETTINGS))).toEqual({
      timing: 'background',
      permissionAlerts: true,
      questionAlerts: true,
    })
  }, SUBPROCESS_TEST_TIMEOUT_MS)

  it('a config carrying only the old true reads as background, never always', () => {
    // "always" was unreachable before this row, so no stored `true` can mean it.
    const { evalInModule } = setup({ notificationsEnabled: true })
    expect(JSON.parse(evalInModule(READ_SETTINGS)).timing).toBe('background')
  }, SUBPROCESS_TEST_TIMEOUT_MS)

  it('a config carrying only the old false silences all three classes', () => {
    // The boolean was the only switch a user had; splitting it into three
    // controls must not resurrect two of them.
    const { evalInModule } = setup({ notificationsEnabled: false })
    expect(JSON.parse(evalInModule(READ_SETTINGS))).toEqual({
      timing: 'never',
      permissionAlerts: false,
      questionAlerts: false,
    })
  }, SUBPROCESS_TEST_TIMEOUT_MS)

  it('an explicit timing outranks the legacy boolean beside it', () => {
    const { evalInModule } = setup({ notificationsEnabled: false, notificationTiming: 'always' })
    expect(JSON.parse(evalInModule(READ_SETTINGS)).timing).toBe('always')
  }, SUBPROCESS_TEST_TIMEOUT_MS)

  it('a malformed timing falls back instead of being stored as-is', () => {
    const { evalInModule } = setup({ notificationTiming: 'sometimes' })
    expect(JSON.parse(evalInModule(READ_SETTINGS)).timing).toBe('background')
  }, SUBPROCESS_TEST_TIMEOUT_MS)

  it('answers from the stored keys without reading the bundled defaults at all', () => {
    // `loadConfigDefaults` throws when the config dir has no synced defaults
    // file. The boolean this replaced reached it only as a last resort, so a
    // fully-answered config must not start throwing.
    const { evalInModule } = setup({
      notificationTiming: 'always',
      notificationPermissionAlerts: false,
      notificationQuestionAlerts: false,
    }, { withDefaults: false })
    expect(JSON.parse(evalInModule(READ_SETTINGS))).toEqual({
      timing: 'always',
      permissionAlerts: false,
      questionAlerts: false,
    })
  }, SUBPROCESS_TEST_TIMEOUT_MS)
})

describe('notification settings — round trip', () => {
  it('writes durably: a FRESH process still reads always', () => {
    const { evalInModule } = setup()
    evalInModule("S.setNotificationSettings({ timing: 'always', permissionAlerts: false, questionAlerts: true })")
    expect(JSON.parse(evalInModule(READ_SETTINGS))).toEqual({
      timing: 'always',
      permissionAlerts: false,
      questionAlerts: true,
    })
  }, SUBPROCESS_TEST_TIMEOUT_MS)

  it('keeps the legacy boolean in step so the two never contradict', () => {
    const { evalInModule, configPath } = setup()
    evalInModule("S.setNotificationSettings({ timing: 'never', permissionAlerts: true, questionAlerts: true })")
    const raw = JSON.parse(readFileSync(configPath, 'utf-8'))
    expect(raw.notificationTiming).toBe('never')
    expect(raw.notificationsEnabled).toBe(false)
  }, SUBPROCESS_TEST_TIMEOUT_MS)

  it('preserves unrelated fields on write', () => {
    const { evalInModule, configPath } = setup({ memoryEnabled: false })
    evalInModule("S.setNotificationSettings({ timing: 'always', permissionAlerts: true, questionAlerts: true })")
    const raw = JSON.parse(readFileSync(configPath, 'utf-8'))
    expect(raw.memoryEnabled).toBe(false)
  }, SUBPROCESS_TEST_TIMEOUT_MS)
})

describe('notification settings — the legacy boolean entry point', () => {
  it('getNotificationsEnabled is every position except the first', () => {
    expect(evalWith({ notificationTiming: 'always' }, READ_ENABLED)).toBe('true')
    expect(evalWith({ notificationTiming: 'background' }, READ_ENABLED)).toBe('true')
    expect(evalWith({ notificationTiming: 'never' }, READ_ENABLED)).toBe('false')
  }, SUBPROCESS_TEST_TIMEOUT_MS)

  it('setNotificationsEnabled(true) does NOT collapse an existing always', () => {
    // A boolean cannot express "always", so it must not be able to undo it.
    const { evalInModule } = setup({ notificationTiming: 'always' })
    expect(JSON.parse(evalInModule(`S.setNotificationsEnabled(true); ${READ_SETTINGS}`)).timing).toBe('always')
  }, SUBPROCESS_TEST_TIMEOUT_MS)

  it('setNotificationsEnabled(false) silences all three classes', () => {
    const { evalInModule } = setup({ notificationTiming: 'always' })
    expect(JSON.parse(evalInModule(`S.setNotificationsEnabled(false); ${READ_SETTINGS}`))).toEqual({
      timing: 'never',
      permissionAlerts: false,
      questionAlerts: false,
    })
  }, SUBPROCESS_TEST_TIMEOUT_MS)
})

function evalWith(overrides: Record<string, unknown>, body: string): string {
  return setup(overrides).evalInModule(body)
}
