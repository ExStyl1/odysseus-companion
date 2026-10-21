import { describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { pathToFileURL } from 'url'

const STORAGE_MODULE_PATH = pathToFileURL(join(import.meta.dir, '..', 'storage.ts')).href
const SUBPROCESS_TEST_TIMEOUT_MS = 120_000

function setup() {
  const configDir = mkdtempSync(join(tmpdir(), 'nessy-general-agent-config-'))
  const configPath = join(configDir, 'config.json')
  writeFileSync(
    configPath,
    JSON.stringify({
      storageLayoutVersion: 2,
      workspaceRefs: [{ id: 'ws-1', lastAccessedAt: Date.now() }],
      activeWorkspaceId: 'ws-1',
      activeSessionId: null,
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

  const readConfig = () => JSON.parse(readFileSync(configPath, 'utf-8'))
  return { configDir, readConfig, evalInModule }
}

describe('zoom factor storage', () => {
  it('defaults to 1.0 when unset', () => {
    const { evalInModule } = setup()
    expect(evalInModule('process.stdout.write(String(S.getZoomFactor()))')).toBe('1')
  }, SUBPROCESS_TEST_TIMEOUT_MS)

  it('persists a set factor and reads it back', () => {
    const { evalInModule, readConfig } = setup()
    evalInModule('S.setZoomFactor(1.3)')
    expect(readConfig().zoomFactor).toBe(1.3)
    expect(evalInModule('process.stdout.write(String(S.getZoomFactor()))')).toBe('1.3')
  }, SUBPROCESS_TEST_TIMEOUT_MS)

  it('clamps out-of-range stored values into [0.5, 3.0]', () => {
    const { evalInModule } = setup()
    evalInModule('S.setZoomFactor(99)')
    expect(evalInModule('process.stdout.write(String(S.getZoomFactor()))')).toBe('3')
    evalInModule('S.setZoomFactor(0.01)')
    expect(evalInModule('process.stdout.write(String(S.getZoomFactor()))')).toBe('0.5')
  }, SUBPROCESS_TEST_TIMEOUT_MS)
})
