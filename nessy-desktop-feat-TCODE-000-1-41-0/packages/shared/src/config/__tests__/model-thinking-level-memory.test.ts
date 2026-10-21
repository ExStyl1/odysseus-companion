/**
 * I2.5 — the TIER-2 per-model effort memory the host holds for all three
 * runtimes.
 *
 * ## The surface, read from the shipped artefacts rather than from prose
 *
 * claude's vendored `sdk.d.ts` declares
 * `Settings.modelSettings[<canonical model name>].effortLevel` as
 * `'low' | 'medium' | 'high' | 'xhigh'`, *"Persisted effort level for this
 * model"*. Pi 0.84.3's `core/settings-manager.d.ts` declares
 * `modelThinkingLevels?: Record<string, ThinkingLevel>`, and its
 * `core/model-resolver.js` `findInitialModel` resolves
 * `scopedModel.thinkingLevel ?? perModel ?? defaultThinkingLevel ?? DEFAULT`.
 * codex declares nothing per model.
 *
 * So two of three remember and one does not, which under the owner's
 * native-first rule is the residual difference the HOST must make uniform.
 * That is what this key is, and the precedence below is Pi's own, copied rather
 * than invented.
 *
 * ## Why a subprocess per case
 *
 * `storage.ts` caches and `NESSY_CONFIG_DIR` must be set before the module
 * loads — the recipe `review-effort-memory.test.ts` and
 * `default-thinking-level.test.ts` next door already use, for the same reason:
 * a test that mutates the real config directory eventually eats a developer's
 * settings.
 */
import { describe, expect, it, setDefaultTimeout } from 'bun:test'
import { mkdtempSync, writeFileSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { pathToFileURL } from 'url'

const STORAGE_MODULE_PATH = pathToFileURL(join(import.meta.dir, '..', 'storage.ts')).href

/**
 * The budget belongs to the FILE: each `runEval` pays for a cold bun process
 * importing `storage.ts`'s whole module graph, which is tens of seconds under
 * load and nothing to do with what is asserted. Sized against the two sibling
 * suites that pay the same cost.
 */
setDefaultTimeout(300_000)

function configDirWith(config: Record<string, unknown>): { configDir: string; configPath: string } {
  const configDir = mkdtempSync(join(tmpdir(), 'nessy-model-effort-'))
  const configPath = join(configDir, 'config.json')
  writeFileSync(configPath, JSON.stringify({
    storageLayoutVersion: 2,
    workspaceRefs: [],
    activeWorkspaceId: null,
    activeSessionId: null,
    llmConnections: [],
    ...config,
  }, null, 2), 'utf-8')
  return { configDir, configPath }
}

function runEval(configDir: string, code: string): string {
  const run = Bun.spawnSync([
    process.execPath,
    '--eval',
    `import { getModelThinkingLevel, getModelThinkingLevels, setModelThinkingLevel, loadStoredConfig } from '${STORAGE_MODULE_PATH}'; ${code}`,
  ], {
    env: { ...process.env, NESSY_CONFIG_DIR: configDir },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (run.exitCode !== 0) {
    throw new Error(`subprocess failed (exit ${run.exitCode})\nstderr:\n${run.stderr.toString()}`)
  }
  return run.stdout.toString().trim()
}

describe('I2.5 — per-model effort memory', () => {
  it('remembers a level for one model and hands it back, without touching another', () => {
    const { configDir, configPath } = configDirWith({})
    const out = runEval(configDir, [
      "setModelThinkingLevel('gateway/coder', 'high');",
      "setModelThinkingLevel('gateway/fast', 'low');",
      "console.log(JSON.stringify({",
      "  coder: getModelThinkingLevel('gateway/coder') ?? null,",
      "  fast: getModelThinkingLevel('gateway/fast') ?? null,",
      "  unknown: getModelThinkingLevel('gateway/never-set') ?? null,",
      "  all: getModelThinkingLevels(),",
      "}));",
    ].join(' '))
    expect(JSON.parse(out)).toEqual({
      coder: 'high',
      fast: 'low',
      // NEGATIVE: a model nobody chose for keeps answering "no memory", which is
      // what lets the ladder fall through to the configured default.
      unknown: null,
      all: { 'gateway/coder': 'high', 'gateway/fast': 'low' },
    })
    // It is ONE key on `config.json`, not a second store.
    const persisted = JSON.parse(readFileSync(configPath, 'utf-8'))
    expect(persisted.modelThinkingLevels).toEqual({ 'gateway/coder': 'high', 'gateway/fast': 'low' })
  })

  it('releases the model-config.md#adjust-effort-level hold, as an explicit choice must', () => {
    // The hold lasts "until you choose a level for them", and choosing a
    // level FOR A MODEL is one. `setDefaultThinkingLevel` already does this;
    // without it here, a hold-listed model would keep answering its documented
    // default over the level the user just picked for it.
    const { configDir, configPath } = configDirWith({ heldThinkingLevelModelId: 'claude-fable-5' })
    runEval(configDir, "setModelThinkingLevel('claude-fable-5', 'low');")
    const persisted = JSON.parse(readFileSync(configPath, 'utf-8'))
    expect(persisted.defaultThinkingLevelExplicit).toBe(true)
    expect('heldThinkingLevelModelId' in persisted).toBe(false)
    // …and the app-level default is NOT overwritten, because the page requires
    // it to survive so a model with no memory can still carry it over.
    expect('defaultThinkingLevel' in persisted).toBe(false)
  })

  it('BOUNDARY — forgetting the last model removes the key rather than leaving {}', () => {
    const { configDir, configPath } = configDirWith({})
    runEval(configDir, [
      "setModelThinkingLevel('gateway/coder', 'high');",
      "setModelThinkingLevel('gateway/coder', undefined);",
    ].join(' '))
    const persisted = JSON.parse(readFileSync(configPath, 'utf-8'))
    // An empty map would be a key the strict envelope carries for no reason,
    // and it reads differently from "never remembered" in a settings surface.
    expect('modelThinkingLevels' in persisted).toBe(false)
  })

  it('BOUNDARY — a hand-edited malformed value reads as no memory, never as a level', () => {
    // Unknown-tolerant like its envelope neighbours: the declared type is
    // `z.unknown().optional()` in the strict load envelope precisely so a bad
    // value cannot throw `UnsupportedStorageLayoutError` and cost the user every
    // other setting. What it must NOT do is resolve to something.
    const { configDir } = configDirWith({
      modelThinkingLevels: { 'gateway/coder': 'enormous', 'gateway/fast': 42, 'gateway/ok': 'medium' },
    })
    const out = runEval(configDir, [
      "console.log(JSON.stringify({",
      "  bogus: getModelThinkingLevel('gateway/coder') ?? null,",
      "  numeric: getModelThinkingLevel('gateway/fast') ?? null,",
      "  good: getModelThinkingLevel('gateway/ok') ?? null,",
      "  all: getModelThinkingLevels(),",
      "  loaded: loadStoredConfig() !== null,",
      "}));",
    ].join(' '))
    expect(JSON.parse(out)).toEqual({
      bogus: null,
      numeric: null,
      good: 'medium',
      all: { 'gateway/ok': 'medium' },
      // The positive control that the file was READ rather than refused: a
      // strict-envelope rejection would have thrown before any of the above.
      loaded: true,
    })
  })

  it('a malformed CONTAINER (not a map) reads as no memory and refuses nothing', () => {
    const { configDir } = configDirWith({ modelThinkingLevels: 'high' })
    const out = runEval(configDir, [
      "console.log(JSON.stringify({",
      "  one: getModelThinkingLevel('gateway/coder') ?? null,",
      "  all: getModelThinkingLevels(),",
      "  loaded: loadStoredConfig() !== null,",
      "}));",
    ].join(' '))
    expect(JSON.parse(out)).toEqual({ one: null, all: {}, loaded: true })
  })
})
