import { describe, expect, it, setDefaultTimeout } from 'bun:test'
import { mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { pathToFileURL } from 'url'
import {
  defaultMidStreamBehavior,
  resolveMidStreamBehavior,
  type LlmConnection,
} from '../llm-connections.ts'

setDefaultTimeout(60_000)

// ============================================================
// Pure helpers
// ============================================================

describe('defaultMidStreamBehavior', () => {
  it("returns 'steer' for anthropic since both arms were measured in the app", () => {
    // Was 'queue', on the reasoning that a turn making no tool call re-queues
    // anyway after burning its tokens. Both arms were then driven live
    // (`scripts/cdp/cases/str-1.ts`, `str-2.ts`): the delivered arm works, and the
    // UNDELIVERED arm was found to be destroying the correction — re-queued under
    // an id no transcript carried, so the replay threw. Fixed, pinned, flipped.
    expect(defaultMidStreamBehavior('anthropic')).toBe('steer')
  })

  it("returns 'steer' for pi (Pi's native steer is non-destructive)", () => {
    expect(defaultMidStreamBehavior('pi')).toBe('steer')
  })

  it("returns 'steer' for pi_compat (same backend as pi)", () => {
    expect(defaultMidStreamBehavior('pi_compat')).toBe('steer')
  })

  // Flipped once `CodexAgent.redirect` wired the app-server's own `turn/steer`.
  // A connection already on disk carries an explicit 'queue' and is unaffected;
  // this default governs new and field-less connections only.
  it("returns 'steer' for codex-runtime (native app-server turn/steer)", () => {
    expect(defaultMidStreamBehavior('codex-runtime')).toBe('steer')
  })

  it("returns 'steer' for claude-runtime — same backend, same proof", () => {
    expect(defaultMidStreamBehavior('claude-runtime')).toBe('steer')
  })

  it("returns 'queue' for nestor-cloud-agent, the one backend with no mid-turn delivery", () => {
    // The remaining exception, and the reason the function is written as one
    // negative rather than a list of positives: everything we can steer, we do.
    expect(defaultMidStreamBehavior('nestor-cloud-agent')).toBe('queue')
  })
})

describe('resolveMidStreamBehavior', () => {
  const baseAnthropic = { providerType: 'anthropic' as const }
  const basePi = { providerType: 'pi' as const }

  it('returns the explicit value when set to steer', () => {
    expect(resolveMidStreamBehavior({ ...baseAnthropic, midStreamBehavior: 'steer' })).toBe('steer')
  })

  it('returns the explicit value when set to queue', () => {
    expect(resolveMidStreamBehavior({ ...basePi, midStreamBehavior: 'queue' })).toBe('queue')
  })

  it('falls back to default when midStreamBehavior is undefined (legacy connection)', () => {
    expect(resolveMidStreamBehavior(baseAnthropic)).toBe('steer')
    expect(resolveMidStreamBehavior(basePi)).toBe('steer')
    expect(resolveMidStreamBehavior({ providerType: 'codex-runtime' })).toBe('steer')
    expect(resolveMidStreamBehavior({ providerType: 'claude-runtime' })).toBe('steer')
    expect(resolveMidStreamBehavior({ providerType: 'nestor-cloud-agent' })).toBe('queue')
  })

  it('falls back to default when midStreamBehavior has an unknown value (corrupt config.json)', () => {
    const corruptAnthropic = { ...baseAnthropic, midStreamBehavior: 'invalid' as never }
    const corruptPi = { ...basePi, midStreamBehavior: '' as never }
    expect(resolveMidStreamBehavior(corruptAnthropic)).toBe('steer')
    expect(resolveMidStreamBehavior(corruptPi)).toBe('steer')
  })
})

// ============================================================
// Storage round-trip — updateLlmConnection persists midStreamBehavior
// ============================================================

const STORAGE_MODULE_PATH = pathToFileURL(join(import.meta.dir, '..', 'storage.ts')).href

function setupConfig(llmConnections: LlmConnection[]) {
  const configDir = mkdtempSync(join(tmpdir(), 'nessy-general-agent-midstream-'))
  const configPath = join(configDir, 'config.json')
  writeFileSync(
    configPath,
    JSON.stringify({
      storageLayoutVersion: 2,
      workspaceRefs: [],
      activeWorkspaceId: null,
      activeSessionId: null,
      defaultLlmConnection: llmConnections[0]?.slug ?? null,
      llmConnections,
    }, null, 2),
    'utf-8',
  )

  function runUpdate(slug: string, updates: Record<string, unknown>): boolean {
    const updatesJson = JSON.stringify(updates)
    const run = Bun.spawnSync([
      process.execPath,
      '--eval',
      `import { updateLlmConnection } from '${STORAGE_MODULE_PATH}'; const ok = updateLlmConnection(${JSON.stringify(slug)}, ${updatesJson}); process.exit(ok ? 0 : 1);`,
    ], {
      env: { ...process.env, NESSY_CONFIG_DIR: configDir },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    if (run.exitCode !== 0 && run.stderr.toString().trim()) {
      throw new Error(`update subprocess failed:\n${run.stderr.toString()}`)
    }
    return run.exitCode === 0
  }

  function readConnection(slug: string) {
    const config = JSON.parse(readFileSync(configPath, 'utf-8'))
    return config.llmConnections.find((c: { slug: string }) => c.slug === slug)
  }

  return { runUpdate, readConnection }
}

function makeConnection(overrides: Partial<LlmConnection> = {}): LlmConnection {
  return {
    slug: 'pi-test',
    name: 'Test Connection',
    providerType: 'pi',
    authType: 'api_key',
    createdAt: Date.now(),
    midStreamBehavior: 'steer',
    ...overrides,
  }
}

describe('updateLlmConnection persists midStreamBehavior', () => {
  it("flips midStreamBehavior from 'steer' to 'queue'", () => {
    const { runUpdate, readConnection } = setupConfig([makeConnection({ midStreamBehavior: 'steer' })])
    expect(runUpdate('pi-test', { midStreamBehavior: 'queue' })).toBe(true)
    expect(readConnection('pi-test').midStreamBehavior).toBe('queue')
  })

  it("flips midStreamBehavior from 'queue' to 'steer'", () => {
    const { runUpdate, readConnection } = setupConfig([
      makeConnection({ providerType: 'anthropic', authType: 'api_key', midStreamBehavior: 'queue' }),
    ])
    expect(runUpdate('pi-test', { midStreamBehavior: 'steer' })).toBe(true)
    expect(readConnection('pi-test').midStreamBehavior).toBe('steer')
  })

  it('preserves existing midStreamBehavior when other fields are updated', () => {
    const { runUpdate, readConnection } = setupConfig([makeConnection({ midStreamBehavior: 'queue' })])
    expect(runUpdate('pi-test', { name: 'Renamed' })).toBe(true)
    const updated = readConnection('pi-test')
    expect(updated.name).toBe('Renamed')
    expect(updated.midStreamBehavior).toBe('queue')
  })

  it('seeds midStreamBehavior from undefined when patch sets it explicitly', () => {
    // Legacy connection (no midStreamBehavior on disk) — patch sets it.
    const { runUpdate, readConnection } = setupConfig([makeConnection({ midStreamBehavior: undefined })])
    expect(runUpdate('pi-test', { midStreamBehavior: 'queue' })).toBe(true)
    expect(readConnection('pi-test').midStreamBehavior).toBe('queue')
  })
})
