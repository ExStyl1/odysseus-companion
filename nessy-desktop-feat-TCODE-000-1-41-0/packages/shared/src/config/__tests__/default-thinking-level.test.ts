import { describe, expect, it } from 'bun:test'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { pathToFileURL } from 'url'
import { THINKING_LEVEL_IDS } from '../../agent/thinking-levels.ts'
import { publishedModelThinkingLevel } from '../llm-connections.ts'

const STORAGE_MODULE_PATH = pathToFileURL(join(import.meta.dir, '..', 'storage.ts')).href

/**
 * The budget belongs to the FILE, and 120 s was measured to be below its floor
 * rather than above it — this file is the known-failing register's P2.435, whose
 * verdict of "starvation" the instruments below refute.
 *
 * Priced 2026-09-11 with AGENTS.md's two separating instruments. The ZERO-CASE
 * control (`-t` matching nothing, so no case runs at all) costs **70.83 s wall at
 * 0.54 s user / 0.18 s sys**, load 13.85 — 1.0 % cpu, i.e. the module graph alone,
 * blocked on reads. `--reporter=junit` then prices every body inside it, and
 * unlike the classic module-graph red these bodies are NOT milliseconds: they are
 * 16.8 s / 32.9 s for one child, 77.7 s for two, and the whole file is 678.42 s
 * wall for 19 s of CPU (2.8 %). So the cost is one cold `storage.ts` import per
 * `runEval`, ~20–40 s each on the slow path and ~0.3 s warm — a 140x lottery that
 * straddles any fixed budget, which is why the same bytes ran 9 pass / 31.47 s at
 * load 6.8 and 7 pass / 2 fail / 678 s at load ~15 on the same day.
 *
 * Two cases exceeded the old value at load ~15: `supports every thinking level`
 * (120 037 ms) and `holds a model default across a restart` (122 009 ms). The
 * second spends six children, which 300 s covers; the first spent TWELVE, which
 * no honest budget covers, so it was restructured below rather than budgeted at
 * ten minutes. On the warm path this costs nothing.
 */
const SUBPROCESS_TEST_TIMEOUT_MS = 300_000

function setupWorkspaceConfigDir() {
  const configDir = mkdtempSync(join(tmpdir(), 'nessy-general-agent-config-thinking-'))
  const workspaceRoot = join(configDir, 'workspaces', 'my-workspace')
  mkdirSync(workspaceRoot, { recursive: true })

  writeFileSync(
    join(workspaceRoot, 'config.json'),
    JSON.stringify({
      id: 'ws-config-1',
      name: 'My Workspace',
      slug: 'my-workspace',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }, null, 2),
    'utf-8',
  )

  const configPath = join(configDir, 'config.json')
  writeFileSync(
    configPath,
    JSON.stringify({
      storageLayoutVersion: 2,
      workspaceRefs: [{ id: 'ws-1', lastAccessedAt: Date.now() }],
      activeWorkspaceId: 'ws-1',
      activeSessionId: null,
      llmConnections: [],
    }, null, 2),
    'utf-8',
  )

  writeFileSync(
    join(configDir, 'config-defaults.json'),
    JSON.stringify({
      version: 'test',
      description: 'test defaults',
      defaults: {
        notificationsEnabled: true,
        colorTheme: 'default',
        autoCapitalisation: true,
        sendMessageKey: 'enter',
        spellCheck: false,
        keepAwakeWhileRunning: false,
        richToolDescriptions: true,
      },
      workspaceDefaults: {
        thinkingLevel: 'off',
        permissionMode: 'ask',
        cyclablePermissionModes: ['safe', 'ask', 'allow-all'],
        localMcpServers: { enabled: true },
      },
    }, null, 2),
    'utf-8',
  )

  return { configDir, configPath }
}

function runEval(configDir: string, code: string): string {
  const run = Bun.spawnSync([
    process.execPath,
    '--eval',
    `import { getConfiguredDefaultThinkingLevel, getDefaultThinkingLevel, loadConfigDefaults, releaseThinkingLevelHold, resolveHeldModelThinkingLevel, setDefaultThinkingLevel } from '${STORAGE_MODULE_PATH}'; ${code}`,
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

describe('default thinking level storage', () => {
  it('falls back to bundled default when no app-level default is set', () => {
    const { configDir } = setupWorkspaceConfigDir()
    const output = runEval(configDir, "console.log(String(getDefaultThinkingLevel()))")
    expect(output).toBe('off')
  }, SUBPROCESS_TEST_TIMEOUT_MS)

  it('persists defaultThinkingLevel to config.json', () => {
    const { configDir, configPath } = setupWorkspaceConfigDir()

    runEval(configDir, "setDefaultThinkingLevel('max'); console.log(String(getDefaultThinkingLevel()))")

    const config = JSON.parse(readFileSync(configPath, 'utf-8'))
    expect(config.defaultThinkingLevel).toBe('max')
  }, SUBPROCESS_TEST_TIMEOUT_MS)

  it('round-trips persisted value across processes', () => {
    const { configDir } = setupWorkspaceConfigDir()
    runEval(configDir, "setDefaultThinkingLevel('medium')")
    const output = runEval(configDir, "console.log(String(getDefaultThinkingLevel()))")
    expect(output).toBe('medium')
  }, SUBPROCESS_TEST_TIMEOUT_MS)

  it('supports every thinking level', () => {
    const { configDir } = setupWorkspaceConfigDir()
    // A CHAIN, not a pair per level: each hop reads back what the previous
    // process wrote and writes the next level itself, so every level still
    // crosses a real process boundary between its write and its read — the
    // property this case exists for — at seven children for six levels instead
    // of twelve. Halving them is what brings the case inside a budget an honest
    // measurement can justify (see `SUBPROCESS_TEST_TIMEOUT_MS` above: the
    // twelve-child form cost more than 120 s at load 15 and could not be fixed
    // by raising the number).
    runEval(configDir, `setDefaultThinkingLevel('${THINKING_LEVEL_IDS[0]}')`)
    for (let index = 1; index <= THINKING_LEVEL_IDS.length; index += 1) {
      const written = THINKING_LEVEL_IDS[index - 1]!
      const next = THINKING_LEVEL_IDS[index]
      const output = runEval(configDir, next
        ? `console.log(String(getDefaultThinkingLevel())); setDefaultThinkingLevel('${next}')`
        : 'console.log(String(getDefaultThinkingLevel()))')
      expect(output).toBe(written)
    }
  }, SUBPROCESS_TEST_TIMEOUT_MS)

  it('migrates legacy "think" value to "medium"', () => {
    const { configDir, configPath } = setupWorkspaceConfigDir()
    // Manually write the legacy 'think' value to config
    const config = JSON.parse(readFileSync(configPath, 'utf-8'))
    config.defaultThinkingLevel = 'think'
    writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8')

    const output = runEval(configDir, "console.log(String(getDefaultThinkingLevel()))")
    expect(output).toBe('medium')
  }, SUBPROCESS_TEST_TIMEOUT_MS)
})

/**
 * `model-config.md:506` — "The environment variable takes precedence over all
 * other methods, then your configured level, then the model default." A getter
 * that always answers makes the model default unreachable, so the user-set
 * value and the shipped fallback are two different questions now.
 */
describe('configured vs shipped default thinking level', () => {
  it('separates "the user set one" from "the shipped fallback"', () => {
    const { configDir } = setupWorkspaceConfigDir()

    // No `defaultThinkingLevel` in config.json: the configured getter declines
    // and the concrete one still answers with the bundled value.
    expect(runEval(configDir, "console.log(String(getConfiguredDefaultThinkingLevel()))")).toBe('undefined')
    expect(runEval(configDir, "console.log(String(getDefaultThinkingLevel()))")).toBe('off')

    // Once the user sets one, both agree.
    runEval(configDir, "setDefaultThinkingLevel('high')")
    expect(runEval(configDir, "console.log(String(getConfiguredDefaultThinkingLevel()))")).toBe('high')
    expect(runEval(configDir, "console.log(String(getDefaultThinkingLevel()))")).toBe('high')
  }, SUBPROCESS_TEST_TIMEOUT_MS)
})

/**
 * `model-config.md#adjust-effort-level` (F1.1214, re-read 2026-10-01) — the older
 * top-level level "keeps applying where it applied before, on Opus 5, Fable 5.1,
 * and earlier models, while Opus 5.5 and models released after it start at their
 * own default until you choose a level for them". Where it applied before excludes
 * Fable 5, Opus 4.8 and Opus 4.7: Claude Code 2.1.280 narrowed their launch-default
 * hold to stop holding it over "`/effort` in `-p` or the Agent SDK, a project,
 * managed or `--settings` `effortLevel`, or a per-model level" — not the older form.
 */
describe('per-model effort hold', () => {
  it('holds a model default across a restart until an explicit choice releases it', () => {
    const { configDir, configPath } = setupWorkspaceConfigDir()

    // A level previously set for another model.
    runEval(configDir, "setDefaultThinkingLevel('low')")
    // …then release the hold-clearing marker that write left behind, so this
    // case is the documented "you previously set a level" state and not the
    // "you just made an explicit choice" one.
    const stored = JSON.parse(readFileSync(configPath, 'utf-8'))
    delete stored.defaultThinkingLevelExplicit
    writeFileSync(configPath, JSON.stringify(stored, null, 2), 'utf-8')

    // First run of a hold-listed model: its own default wins over the stored level…
    expect(runEval(configDir, "console.log(String(resolveHeldModelThinkingLevel('claude-opus-5-5')))")).toBe('medium')
    // …and the model it came from is persisted, which is what "across sessions" means.
    expect(JSON.parse(readFileSync(configPath, 'utf-8')).heldThinkingLevelModelId).toBe('claude-opus-5-5')

    // A separate process — the hold is still in force, and the user's own level
    // was NOT overwritten.
    expect(runEval(configDir, "console.log(String(resolveHeldModelThinkingLevel('claude-opus-5-5')))")).toBe('medium')
    expect(runEval(configDir, "console.log(String(getConfiguredDefaultThinkingLevel()))")).toBe('low')

    // An explicit effort choice releases it, and the release also persists.
    runEval(configDir, "releaseThinkingLevelHold()")
    const afterRelease = JSON.parse(readFileSync(configPath, 'utf-8'))
    expect(afterRelease.defaultThinkingLevelExplicit).toBe(true)
    expect(afterRelease.heldThinkingLevelModelId).toBeUndefined()
    expect(runEval(configDir, "console.log(String(resolveHeldModelThinkingLevel('claude-opus-5-5')))")).toBe('undefined')
  }, SUBPROCESS_TEST_TIMEOUT_MS)

  it('keeps the narrowed 2.1.280 launch-default hold of Opus 4.8 over a pre-marker level', () => {
    const { configDir, configPath } = setupWorkspaceConfigDir()
    runEval(configDir, "setDefaultThinkingLevel('low')")
    const stored = JSON.parse(readFileSync(configPath, 'utf-8'))
    delete stored.defaultThinkingLevelExplicit
    writeFileSync(configPath, JSON.stringify(stored, null, 2), 'utf-8')

    // A pre-marker configured level is the user-settings older form, which is
    // not on 2.1.280's list of sources Opus 4.8 stopped holding over.
    expect(runEval(configDir, "console.log(String(resolveHeldModelThinkingLevel('claude-opus-4-8')))")).toBe('high')
    expect(JSON.parse(readFileSync(configPath, 'utf-8')).heldThinkingLevelModelId).toBe('claude-opus-4-8')
    expect(runEval(configDir, "console.log(String(getConfiguredDefaultThinkingLevel()))")).toBe('low')
  }, SUBPROCESS_TEST_TIMEOUT_MS)

  it('carries a previously-set level over on a model with no hold', () => {
    const { configDir, configPath } = setupWorkspaceConfigDir()
    runEval(configDir, "setDefaultThinkingLevel('low')")
    const stored = JSON.parse(readFileSync(configPath, 'utf-8'))
    delete stored.defaultThinkingLevelExplicit
    writeFileSync(configPath, JSON.stringify(stored, null, 2), 'utf-8')

    // The page names Opus 5 and Fable 5.1 as keeping the older level, though
    // each has a default of its own.
    expect(runEval(configDir, "console.log(String(resolveHeldModelThinkingLevel('claude-opus-5')))")).toBe('undefined')
    expect(runEval(configDir, "console.log(String(resolveHeldModelThinkingLevel('claude-fable-5-1')))")).toBe('undefined')
    expect(runEval(configDir, "console.log(String(resolveHeldModelThinkingLevel('tgpt/qwen35-397b-a17b-fp8')))")).toBe('undefined')
    expect(runEval(configDir, "console.log(String(getConfiguredDefaultThinkingLevel()))")).toBe('low')
    // Nothing was written for a model with no hold.
    expect(JSON.parse(readFileSync(configPath, 'utf-8')).heldThinkingLevelModelId).toBeUndefined()
  }, SUBPROCESS_TEST_TIMEOUT_MS)
})

/**
 * The persistence-boundary back-compat case: a config written by a build that
 * predates this change must load unchanged.
 */
describe('legacy config back-compat', () => {
  it('loads a scalar fallbackModel and a previously-set effort level unchanged', () => {
    const { configDir, configPath } = setupWorkspaceConfigDir()

    const config = JSON.parse(readFileSync(configPath, 'utf-8'))
    config.defaultThinkingLevel = 'high'
    writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8')

    const defaultsPath = join(configDir, 'config-defaults.json')
    const defaults = JSON.parse(readFileSync(defaultsPath, 'utf-8'))
    defaults.workspaceDefaults.fallbackModel = 'pi/legacy-single'
    writeFileSync(defaultsPath, JSON.stringify(defaults, null, 2), 'utf-8')

    // The level survives the two new keys being absent…
    expect(runEval(configDir, "console.log(String(getDefaultThinkingLevel()))")).toBe('high')
    // …and the legacy scalar reads as a one-entry chain rather than throwing or
    // collapsing to "disabled".
    expect(runEval(configDir, "console.log(JSON.stringify(loadConfigDefaults().workspaceDefaults.fallbackModel))"))
      .toBe('["pi/legacy-single"]')
  }, SUBPROCESS_TEST_TIMEOUT_MS)
})

/**
 * D1.116 — the catalogue's own recommendation, read off the CONNECTION.
 *
 * `getModelDefaultThinkingLevel` answers from `MODEL_REGISTRY` (the documented
 * claude families) and declines for every gateway or BYO id, which is the gap
 * this fills: the effort the fetcher wrote onto the model row it read from the
 * catalogue.
 */
describe('publishedModelThinkingLevel (D1.116)', () => {
  const connection = {
    models: [
      { id: 'tgpt/deepseek-v4-flash-0731', reasoningEffort: 'low' },
      { id: 'tgpt/qwen36-35b-a3b-fp8' },
      { id: 'tgpt/published-nonsense', reasoningEffort: 'enthusiastic' },
      'a-bare-string-row',
    ],
  } as unknown as Parameters<typeof publishedModelThinkingLevel>[0];

  it('returns the level the catalogue published for that model', () => {
    expect(publishedModelThinkingLevel(connection, 'tgpt/deepseek-v4-flash-0731')).toBe('low');
  });

  it('declines for a row that publishes none, an unknown id, or no connection', () => {
    expect(publishedModelThinkingLevel(connection, 'tgpt/qwen36-35b-a3b-fp8')).toBeUndefined();
    expect(publishedModelThinkingLevel(connection, 'a-model-this-connection-never-had')).toBeUndefined();
    expect(publishedModelThinkingLevel(undefined, 'tgpt/deepseek-v4-flash-0731')).toBeUndefined();
    expect(publishedModelThinkingLevel(connection, undefined)).toBeUndefined();
  });

  /**
   * The vocabulary control: an effort this product has no level for must not
   * become a silent `medium` — the normalizer decides and the answer is a
   * refusal, which is what keeps the tier below the user's own choice honest.
   */
  it('declines a published value this product cannot name', () => {
    expect(publishedModelThinkingLevel(connection, 'tgpt/published-nonsense')).toBeUndefined();
  });
});
