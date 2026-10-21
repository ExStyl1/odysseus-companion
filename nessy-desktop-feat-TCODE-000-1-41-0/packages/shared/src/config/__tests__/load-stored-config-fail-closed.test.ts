import { describe, expect, it, setDefaultTimeout } from 'bun:test'
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { pathToFileURL } from 'url'

setDefaultTimeout(30_000)

// Guards the W3 fail-closed contract: loadStoredConfig() must never silently
// discard a legacy (pre-v2) or corrupt config.json by returning null, because
// several callers treat a falsy return as "no config yet" and write a fresh
// empty config in its place (e.g. ensureGlobalConfigExists() in
// packages/server-core/src/bootstrap/headless-start.ts, and the equivalent
// first-run check in apps/electron/src/main/index.ts). Before Phase W10 wires
// storage-readiness into startup, that fail-open path destroys a real legacy
// ~/.nessy-agent/config.json on first launch of this branch. loadStoredConfig()
// must THROW UnsupportedStorageLayoutError instead, so those callers crash
// instead of overwriting.

const STORAGE_MODULE_PATH = pathToFileURL(join(import.meta.dir, '..', 'storage.ts')).href

function makeConfigDir(): string {
  return mkdtempSync(join(tmpdir(), 'nessy-general-agent-config-'))
}

interface RunResult {
  ok: boolean
  isUnsupportedStorageLayoutError?: boolean
  name?: string
  message?: string
  config?: any
}

function runLoadStoredConfig(configDir: string): RunResult {
  const run = Bun.spawnSync([
    process.execPath,
    '--eval',
    `
      import * as S from '${STORAGE_MODULE_PATH}';
      try {
        const config = S.loadStoredConfig();
        process.stdout.write(JSON.stringify({ ok: true, config }));
      } catch (e) {
        process.stdout.write(JSON.stringify({
          ok: false,
          isUnsupportedStorageLayoutError: e instanceof S.UnsupportedStorageLayoutError,
          name: e && e.name,
          message: e instanceof Error ? e.message : String(e),
        }));
      }
    `,
  ], { env: { ...process.env, NESSY_CONFIG_DIR: configDir }, stdout: 'pipe', stderr: 'pipe' })

  if (run.exitCode !== 0) {
    throw new Error(`subprocess crashed unexpectedly (exit ${run.exitCode}):\n${run.stderr.toString()}`)
  }
  return JSON.parse(run.stdout.toString().trim())
}

describe('loadStoredConfig fail-closed guard', () => {
  it('returns null when config.json is absent (fresh init stays allowed)', () => {
    const configDir = makeConfigDir()
    const result = runLoadStoredConfig(configDir)
    expect(result.ok).toBe(true)
    expect(result.config).toBeNull()
  })

  it('parses a valid v2 config', () => {
    const configDir = makeConfigDir()
    writeFileSync(
      join(configDir, 'config.json'),
      JSON.stringify({
        storageLayoutVersion: 2,
        workspaceRefs: [{ id: 'ws-1', lastAccessedAt: 1 }],
        activeWorkspaceId: 'ws-1',
        activeSessionId: null,
      }),
      'utf-8',
    )

    const result = runLoadStoredConfig(configDir)
    expect(result.ok).toBe(true)
    expect(result.config.activeWorkspaceId).toBe('ws-1')
    expect(result.config.workspaceRefs).toEqual([{ id: 'ws-1', lastAccessedAt: 1 }])
  })

  it('loads a boolean autoCompactEnabled setting', () => {
    const configDir = makeConfigDir()
    writeFileSync(
      join(configDir, 'config.json'),
      JSON.stringify({
        storageLayoutVersion: 2,
        workspaceRefs: [],
        activeWorkspaceId: null,
        activeSessionId: null,
        autoCompactEnabled: false,
      }),
      'utf-8',
    )

    const result = runLoadStoredConfig(configDir)
    expect(result.ok).toBe(true)
    expect(result.config.autoCompactEnabled).toBe(false)
  })

  it('loads the rtk exclusion list instead of rejecting the whole file (UB7.4, DA1.72)', () => {
    // The guard fixture for `rtkExcludeCommands`: without its declaration in
    // StoredConfigKnownFields the strict envelope would throw
    // UnsupportedStorageLayoutError and cost the user every OTHER setting.
    const configDir = makeConfigDir()
    writeFileSync(
      join(configDir, 'config.json'),
      JSON.stringify({
        storageLayoutVersion: 2,
        workspaceRefs: [],
        activeWorkspaceId: null,
        activeSessionId: null,
        rtkExcludeCommands: ['curl', 'aws'],
      }),
      'utf-8',
    )

    const result = runLoadStoredConfig(configDir)
    expect(result.ok).toBe(true)
    expect(result.config.rtkExcludeCommands).toEqual(['curl', 'aws'])
  })

  it('loads the documented skillOverrides snippet instead of rejecting the whole file', () => {
    // R61 · skills.md:680-687, copied from the page. The sibling case below
    // ('unknown top-level setting') is this one's control: without the
    // `skillOverrides` declaration in StoredConfigKnownFields, the strict
    // envelope treats it exactly the same way and the user loses every setting
    // in config.json rather than hiding one skill.
    const configDir = makeConfigDir()
    writeFileSync(
      join(configDir, 'config.json'),
      JSON.stringify({
        storageLayoutVersion: 2,
        workspaceRefs: [],
        activeWorkspaceId: null,
        activeSessionId: null,
        skillOverrides: { 'legacy-context': 'name-only', deploy: 'off' },
      }),
      'utf-8',
    )

    const result = runLoadStoredConfig(configDir)
    expect(result.ok).toBe(true)
    expect(result.config.skillOverrides).toEqual({ 'legacy-context': 'name-only', deploy: 'off' })
  })

  it.each([
    ['invalid autoCompactEnabled', { autoCompactEnabled: 'false' }],
    ['unknown top-level setting', { unknownCompactionSetting: true }],
  ])('throws UnsupportedStorageLayoutError for %s', (_label, invalid) => {
    const configDir = makeConfigDir()
    writeFileSync(
      join(configDir, 'config.json'),
      JSON.stringify({
        storageLayoutVersion: 2,
        workspaceRefs: [],
        activeWorkspaceId: null,
        activeSessionId: null,
        ...invalid,
      }),
      'utf-8',
    )

    const result = runLoadStoredConfig(configDir)
    expect(result.ok).toBe(false)
    expect(result.isUnsupportedStorageLayoutError).toBe(true)
  })

  it('throws UnsupportedStorageLayoutError for a pre-v2 legacy config instead of silently discarding it', () => {
    const configDir = makeConfigDir()
    writeFileSync(
      join(configDir, 'config.json'),
      JSON.stringify({
        // No storageLayoutVersion field at all: pre-migration legacy shape.
        workspaces: [{ id: 'ws-1', name: 'My Workspace', rootPath: join(configDir, 'workspaces', 'my-workspace'), createdAt: Date.now() }],
        activeWorkspaceId: 'ws-1',
        activeSessionId: null,
      }),
      'utf-8',
    )

    const result = runLoadStoredConfig(configDir)
    expect(result.ok).toBe(false)
    expect(result.isUnsupportedStorageLayoutError).toBe(true)
  })

  it('throws UnsupportedStorageLayoutError when storageLayoutVersion is an old number', () => {
    const configDir = makeConfigDir()
    writeFileSync(
      join(configDir, 'config.json'),
      JSON.stringify({ storageLayoutVersion: 1, workspaces: [], activeWorkspaceId: null, activeSessionId: null }),
      'utf-8',
    )

    const result = runLoadStoredConfig(configDir)
    expect(result.ok).toBe(false)
    expect(result.isUnsupportedStorageLayoutError).toBe(true)
  })

  it('throws UnsupportedStorageLayoutError for corrupt/unparseable JSON instead of returning null', () => {
    const configDir = makeConfigDir()
    writeFileSync(join(configDir, 'config.json'), '{ this is not valid json', 'utf-8')

    const result = runLoadStoredConfig(configDir)
    expect(result.ok).toBe(false)
    expect(result.isUnsupportedStorageLayoutError).toBe(true)
  })

  it('throws UnsupportedStorageLayoutError when storageLayoutVersion is 2 but workspaceRefs is missing', () => {
    const configDir = makeConfigDir()
    writeFileSync(
      join(configDir, 'config.json'),
      JSON.stringify({ storageLayoutVersion: 2, activeWorkspaceId: null, activeSessionId: null }),
      'utf-8',
    )

    const result = runLoadStoredConfig(configDir)
    expect(result.ok).toBe(false)
    expect(result.isUnsupportedStorageLayoutError).toBe(true)
  })

  it('rejects a v2 file that still carries the retired Workspace registry', () => {
    const configDir = makeConfigDir()
    writeFileSync(
      join(configDir, 'config.json'),
      JSON.stringify({
        storageLayoutVersion: 2,
        workspaces: [],
        workspaceRefs: [],
        activeWorkspaceId: null,
        activeSessionId: null,
      }),
      'utf-8',
    )

    const result = runLoadStoredConfig(configDir)
    expect(result.ok).toBe(false)
    expect(result.isUnsupportedStorageLayoutError).toBe(true)
  })

  it('regression: the "if (!loadStoredConfig()) saveConfig(fresh)" first-run pattern never overwrites a legacy config', () => {
    // This is the exact shape used by ensureGlobalConfigExists() (headless-start.ts)
    // and the first-run check in apps/electron/src/main/index.ts. Before the
    // fail-closed guard, a falsy return from loadStoredConfig() made both of
    // these callers stamp a brand-new empty config over the real legacy file.
    const configDir = makeConfigDir()
    const configPath = join(configDir, 'config.json')
    const legacyContent = JSON.stringify({
      workspaces: [{ id: 'ws-1', name: 'Real Legacy Workspace', rootPath: '/tmp/does-not-matter', createdAt: 1 }],
      activeWorkspaceId: 'ws-1',
      activeSessionId: null,
    }, null, 2)
    writeFileSync(configPath, legacyContent, 'utf-8')

    const run = Bun.spawnSync([
      process.execPath,
      '--eval',
      `
        import * as S from '${STORAGE_MODULE_PATH}';
        let overwrote = false;
        let threw = false;
        try {
          if (!S.loadStoredConfig()) {
            S.saveConfig({ workspaceRefs: [], activeWorkspaceId: null, activeSessionId: null });
            overwrote = true;
          }
        } catch (e) {
          threw = true;
        }
        process.stdout.write(JSON.stringify({ overwrote, threw }));
      `,
    ], { env: { ...process.env, NESSY_CONFIG_DIR: configDir }, stdout: 'pipe', stderr: 'pipe' })

    if (run.exitCode !== 0) {
      throw new Error(`subprocess crashed unexpectedly (exit ${run.exitCode}):\n${run.stderr.toString()}`)
    }
    const result = JSON.parse(run.stdout.toString().trim())
    expect(result.overwrote).toBe(false)
    expect(result.threw).toBe(true)

    // The legacy file on disk must be untouched — byte for byte.
    expect(readFileSync(configPath, 'utf-8')).toBe(legacyContent)
  })
})

describe('a refused config.json is preserved as a .corrupted copy (P6.438)', () => {
  const corruptedSiblings = (configDir: string): string[] =>
    readdirSync(configDir).filter(name => name.startsWith('config.json.corrupted.'))

  /**
   * An explicit budget, set against the MEASURED floor rather than the file's
   * 30s default.
   *
   * Every test here spawns a real `bun` child that imports `storage.ts`, which
   * is this suite's whole cost. Measured 2026-09-06 on a box running five other
   * lanes: these three passed in **29.06s for three spawns** at load 11.94, and
   * a single spawn of the SAME child on the same box took **34.87s wall for
   * 0.53s of user CPU (2% CPU)**. So the 30s default sits below the contended
   * cost of one spawn, and the whole file goes red together when the queue is
   * deep — including `returns null when config.json is absent`, which writes no
   * file and never reaches the code this block tests.
   */
  const SPAWN_BUDGET_MS = 60_000

  it('keeps the broken bytes beside the original and names the copy in the refusal', () => {
    // `settings.md#fix-a-broken-settings-file`, third tier: "Claude Code copies
    // the broken file to `~/.claude/backups/.claude.json.corrupted.<timestamp>`".
    // `~/.claude.json` is that product's app-state file; `config.json` is ours.
    const configDir = makeConfigDir()
    const configPath = join(configDir, 'config.json')
    const broken = '{ "storageLayoutVersion": 2, '  // truncated on purpose
    writeFileSync(configPath, broken, 'utf-8')

    const result = runLoadStoredConfig(configDir)
    expect(result.ok).toBe(false)
    expect(result.isUnsupportedStorageLayoutError).toBe(true)

    const copies = corruptedSiblings(configDir)
    expect(copies).toHaveLength(1)
    // The copy is the EVIDENCE, so it must be byte-identical…
    expect(readFileSync(join(configDir, copies[0]!), 'utf-8')).toBe(broken)
    // …and the refusal must still be a refusal: the original is untouched,
    // which is the invariant every other test in this file exists for.
    expect(readFileSync(configPath, 'utf-8')).toBe(broken)
    // Naming it is the point — a copy nobody is told about is not a diagnostic.
    expect(result.message).toContain('A copy of the refused file was kept at')
    expect(result.message).toContain(copies[0]!)
  }, SPAWN_BUDGET_MS)

  it('takes ONE copy per process however many readers hit the refusal', () => {
    // The latch. `loadStoredConfig` is called by every settings getter, so an
    // uncopied-per-call version would litter the config directory of a broken
    // install. Driven through three real readers rather than three bare calls,
    // because those are the callers that actually multiply.
    const configDir = makeConfigDir()
    writeFileSync(join(configDir, 'config.json'), '{ not json', 'utf-8')
    const run = Bun.spawnSync([
      process.execPath,
      '--eval',
      `
        import * as S from '${STORAGE_MODULE_PATH}';
        let refusals = 0;
        for (const call of [S.loadStoredConfig, S.getUserSandboxSettings, S.loadStoredConfig]) {
          try { call(); } catch { refusals += 1; }
        }
        process.stdout.write(JSON.stringify({ refusals }));
      `,
    ], { env: { ...process.env, NESSY_CONFIG_DIR: configDir }, stdout: 'pipe', stderr: 'pipe' })
    expect(run.exitCode, run.stderr.toString()).toBe(0)
    // `getUserSandboxSettings` catches its own parse errors, so it is not
    // required to refuse — what matters is that the readers ran and exactly one
    // copy exists afterwards.
    expect(JSON.parse(run.stdout.toString().trim()).refusals).toBeGreaterThanOrEqual(2)
    expect(corruptedSiblings(configDir)).toHaveLength(1)
  }, SPAWN_BUDGET_MS)

  it('takes no copy when the config is valid (the control)', () => {
    const configDir = makeConfigDir()
    writeFileSync(
      join(configDir, 'config.json'),
      JSON.stringify({
        storageLayoutVersion: 2,
        workspaceRefs: [],
        activeWorkspaceId: null,
        activeSessionId: null,
      }),
      'utf-8',
    )
    expect(runLoadStoredConfig(configDir).ok).toBe(true)
    expect(corruptedSiblings(configDir)).toHaveLength(0)
  }, SPAWN_BUDGET_MS)

  it('keeps only the newest three copies, so a broken install cannot litter across restarts', () => {
    // The latch above is per-PROCESS and says nothing about the next launch — and
    // a corrupt config is exactly the state a user restarts into repeatedly. Four
    // copies from earlier launches stand in for those restarts; the stamp is a
    // flattened ISO timestamp, so a lexical sort is chronological and the NEWEST
    // survive.
    const configDir = makeConfigDir()
    const broken = '{ "storageLayoutVersion": 2, '
    writeFileSync(join(configDir, 'config.json'), broken, 'utf-8')
    const older = [
      'config.json.corrupted.2020-01-01T00-00-01-000Z',
      'config.json.corrupted.2020-01-01T00-00-02-000Z',
      'config.json.corrupted.2020-01-01T00-00-03-000Z',
      'config.json.corrupted.2020-01-01T00-00-04-000Z',
    ]
    for (const name of older) writeFileSync(join(configDir, name), name, 'utf-8')

    expect(runLoadStoredConfig(configDir).ok).toBe(false)

    const kept = corruptedSiblings(configDir).sort()
    expect(kept).toHaveLength(3)
    // The two OLDEST are the ones dropped…
    expect(kept).not.toContain('config.json.corrupted.2020-01-01T00-00-01-000Z')
    expect(kept).not.toContain('config.json.corrupted.2020-01-01T00-00-02-000Z')
    // …and this launch's own copy — the only evidence of THIS refusal — is not
    // pruned by the sweep it triggers.
    expect(readFileSync(join(configDir, kept[2]!), 'utf-8')).toBe(broken)
    // The original is still untouched, which every test in this file exists for.
    expect(readFileSync(join(configDir, 'config.json'), 'utf-8')).toBe(broken)
  }, SPAWN_BUDGET_MS)

  it('names the refused file and both repair routes the page offers', () => {
    // P6.438(1). `settings.md#fix-a-broken-settings-file` third tier: Claude Code
    // "asks whether to exit and fix it by hand or reset to the default
    // configuration". We stop, and we perform neither repair — so the refusal has
    // to SAY both, because `boot-fatal.ts` interpolates this message verbatim
    // into a dialog whose only button is Quit.
    const configDir = makeConfigDir()
    writeFileSync(join(configDir, 'config.json'), '{ not json', 'utf-8')

    const result = runLoadStoredConfig(configDir)
    expect(result.ok).toBe(false)
    // The ABSOLUTE path: a user who set `NESSY_CONFIG_DIR` reads "config.json"
    // and looks in the wrong directory.
    expect(result.message).toContain(join(configDir, 'config.json'))
    expect(result.message).toContain('repair the file by hand')
    expect(result.message).toContain('move it aside to start from the default configuration')
    // The caller's own sentence still leads — those are what the other tests and
    // the callers match on.
    expect(result.message!.startsWith('config.json exists but is not valid JSON')).toBe(true)
  }, SPAWN_BUDGET_MS)
})
