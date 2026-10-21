/**
 * R37 (f228) — `respondToBashCommands`
 * (`settings-reference.md#respondtobashcommands`, "**Default**: `true`" — "By
 * default, Claude Code adds the command's output to the conversation and Claude
 * replies to it. Set this key to `false` to add the output to context without a
 * reply").
 *
 * Two contracts:
 * - Value semantics: an ABSENT key responds (`!== false`), only an explicit
 *   `false` selects the context-only branch — mirroring
 *   `getUseAutoModeDuringPlan`.
 * - Envelope survival: `StoredConfigTopLevelSchema` is `.strict()` and
 *   `loadStoredConfig()` THROWS on an undeclared top-level key, so a
 *   config.json written by `setRespondToBashCommands()` must round-trip
 *   through the PRODUCTION loader in a fresh process — the startup-brick
 *   class instruction-excludes-envelope.test.ts guards. An in-process unit
 *   test passes while the app bricks, hence the subprocess pattern.
 */
import { describe, expect, it, setDefaultTimeout } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { pathToFileURL } from 'url'

const STORAGE_MODULE = pathToFileURL(join(import.meta.dir, '..', 'storage.ts')).href

/**
 * The budget belongs to the FILE, not to a case. The subprocess pattern the
 * docblock above justifies costs one bun process importing `storage.ts`'s whole
 * module graph per `run`, and that cost is a PAGE-CACHE LOTTERY rather than work:
 * measured 2026-09-11 on the same child, `real 48.74` at load 8.26, `real 38.28`
 * at load 8.49, then **0.29 / 0.34 / 0.35** at load 7.62 once the graph was warm,
 * CPU flat at ~0.5 s user + 0.2 s sys throughout — 1.7 % of the slow wall, a 140x
 * spread that straddles the 5 s default. Against that default both cases died at
 * `expect(…exitCode).toBe(0)` with `-1` (the `?? -1` above standing in for the
 * `null` of a killed child), which reads exactly like the bricked envelope this
 * file exists to catch and is its opposite. This is the budget the known-failing
 * register's class (c) asked the owner of these files to set, with the
 * measurement beside it. On the warm path it costs nothing.
 */
setDefaultTimeout(300_000)

/** A v2 config.json in a fresh CONFIG_DIR. */
function fixture(config: Record<string, unknown> = {}): string {
  const configDir = mkdtempSync(join(tmpdir(), 'nessy-respond-bash-'))
  writeFileSync(join(configDir, 'config.json'), JSON.stringify({
    storageLayoutVersion: 2,
    workspaceRefs: [],
    activeWorkspaceId: null,
    activeSessionId: null,
    ...config,
  }), 'utf-8')
  return configDir
}

/** Run `source` in a subprocess whose CONFIG_DIR is the fixture's. */
function run(configDir: string, source: string): { stdout: string; stderr: string; exitCode: number } {
  const spawned = Bun.spawnSync([process.execPath, '--eval', source], {
    env: { ...process.env, NESSY_CONFIG_DIR: configDir },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  return {
    stdout: spawned.stdout.toString().trim(),
    stderr: spawned.stderr.toString(),
    exitCode: spawned.exitCode ?? -1,
  }
}

describe('respondToBashCommands stored setting', () => {
  it('defaults ON when absent and only an explicit false turns it off', () => {
    const configDir = fixture()
    const probe = run(configDir, `
      const { getRespondToBashCommands, setRespondToBashCommands } = await import(${JSON.stringify(STORAGE_MODULE)})
      const absent = getRespondToBashCommands()
      setRespondToBashCommands(false)
      const explicitFalse = getRespondToBashCommands()
      console.log(JSON.stringify({ absent, explicitFalse }))
    `)

    expect(probe.exitCode).toBe(0)
    expect(JSON.parse(probe.stdout)).toEqual({ absent: true, explicitFalse: false })
  })

  it('survives the strict envelope after the setter writes it, and turns back on', () => {
    const configDir = fixture()
    const write = run(configDir, `
      const { setRespondToBashCommands } = await import(${JSON.stringify(STORAGE_MODULE)})
      setRespondToBashCommands(false)
    `)
    expect(write.exitCode).toBe(0)

    // Fresh process: the production loader must accept the written key (an
    // undeclared key would throw UnsupportedStorageLayoutError here and brick
    // every setting in config.json).
    const reload = run(configDir, `
      const { getRespondToBashCommands, loadStoredConfig, setRespondToBashCommands } = await import(${JSON.stringify(STORAGE_MODULE)})
      const loaded = loadStoredConfig()
      const persistedFalse = getRespondToBashCommands()
      setRespondToBashCommands(true)
      const backOn = getRespondToBashCommands()
      console.log(JSON.stringify({ loadedOk: loaded !== null, persistedFalse, backOn }))
    `)

    expect(reload.exitCode).toBe(0)
    expect(JSON.parse(reload.stdout)).toEqual({ loadedOk: true, persistedFalse: false, backOn: true })
  })
})
