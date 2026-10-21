import { describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { pathToFileURL } from 'url'

const STORAGE_MODULE_PATH = pathToFileURL(join(import.meta.dir, '..', 'storage.ts')).href
const SUBPROCESS_TEST_TIMEOUT_MS = 120_000

/**
 * Create isolated config dir with a root config containing the given connections.
 * Returns paths needed by tests plus a runner to call updateLlmConnection in a subprocess.
 */
function setup(llmConnections: any[]) {
  const configDir = mkdtempSync(join(tmpdir(), 'nessy-general-agent-config-'))
  const configPath = join(configDir, 'config.json')
  writeFileSync(
    configPath,
    JSON.stringify({
      storageLayoutVersion: 2,
      workspaceRefs: [{ id: 'ws-1', lastAccessedAt: Date.now() }],
      activeWorkspaceId: 'ws-1',
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

  function readConnection(slug: string): any {
    const config = JSON.parse(readFileSync(configPath, 'utf-8'))
    return config.llmConnections.find((c: any) => c.slug === slug)
  }

  return { configDir, configPath, runUpdate, readConnection }
}

function makeConnection(overrides: Record<string, unknown> = {}) {
  return {
    slug: 'custom-compat',
    name: 'My Custom Endpoint',
    providerType: 'pi_compat',
    authType: 'api_key_with_endpoint',
    createdAt: Date.now(),
    baseUrl: 'http://localhost:8085',
    piAuthProvider: 'anthropic',
    ...overrides,
  }
}

describe('updateLlmConnection – customEndpoint', () => {
  it('preserves customEndpoint when provided in updates', () => {
    const { runUpdate, readConnection } = setup([makeConnection()])
    const customEndpoint = { api: 'anthropic-messages' }

    const ok = runUpdate('custom-compat', { customEndpoint })
    expect(ok).toBe(true)

    const conn = readConnection('custom-compat')
    expect(conn.customEndpoint).toEqual(customEndpoint)
  }, SUBPROCESS_TEST_TIMEOUT_MS)

  it('preserves existing customEndpoint when updates do not include it', () => {
    const customEndpoint = { api: 'openai-completions' }
    const { runUpdate, readConnection } = setup([makeConnection({ customEndpoint })])

    // Update an unrelated field
    const ok = runUpdate('custom-compat', { name: 'Renamed Endpoint' })
    expect(ok).toBe(true)

    const conn = readConnection('custom-compat')
    expect(conn.customEndpoint).toEqual(customEndpoint)
    expect(conn.name).toBe('Renamed Endpoint')
  }, SUBPROCESS_TEST_TIMEOUT_MS)

  it('overwrites customEndpoint protocol when updated', () => {
    const { runUpdate, readConnection } = setup([
      makeConnection({ customEndpoint: { api: 'openai-completions' } }),
    ])

    const ok = runUpdate('custom-compat', { customEndpoint: { api: 'anthropic-messages' } })
    expect(ok).toBe(true)

    const conn = readConnection('custom-compat')
    expect(conn.customEndpoint).toEqual({ api: 'anthropic-messages' })
  }, SUBPROCESS_TEST_TIMEOUT_MS)
})

describe('updateLlmConnection – Anthropic OAuth identity (issue #838)', () => {
  const identity = {
    oauthAccountUuid: 'acct-uuid-123',
    oauthAccountEmail: 'user@example.com',
    oauthOrganizationUuid: 'org-uuid-456',
    oauthOrganizationName: 'Nessy',
    oauthProfileVerifiedAt: 1_700_000_000_000,
  }

  it('persists identity fields when provided in updates', () => {
    const { runUpdate, readConnection } = setup([
      makeConnection({ slug: 'claude-max', authType: 'oauth' }),
    ])

    const ok = runUpdate('claude-max', identity)
    expect(ok).toBe(true)

    const conn = readConnection('claude-max')
    expect(conn.oauthAccountUuid).toBe(identity.oauthAccountUuid)
    expect(conn.oauthAccountEmail).toBe(identity.oauthAccountEmail)
    expect(conn.oauthOrganizationUuid).toBe(identity.oauthOrganizationUuid)
    expect(conn.oauthOrganizationName).toBe(identity.oauthOrganizationName)
    expect(conn.oauthProfileVerifiedAt).toBe(identity.oauthProfileVerifiedAt)
  }, SUBPROCESS_TEST_TIMEOUT_MS)

  it('preserves identity across an unrelated update (the allowlist-rebuild bug guard)', () => {
    const { runUpdate, readConnection } = setup([
      makeConnection({ slug: 'claude-max', authType: 'oauth', ...identity }),
    ])

    // An update that touches none of the identity fields must not drop them.
    const ok = runUpdate('claude-max', { name: 'Renamed Claude Max' })
    expect(ok).toBe(true)

    const conn = readConnection('claude-max')
    expect(conn.name).toBe('Renamed Claude Max')
    expect(conn.oauthAccountUuid).toBe(identity.oauthAccountUuid)
    expect(conn.oauthAccountEmail).toBe(identity.oauthAccountEmail)
    expect(conn.oauthOrganizationUuid).toBe(identity.oauthOrganizationUuid)
    expect(conn.oauthOrganizationName).toBe(identity.oauthOrganizationName)
    expect(conn.oauthProfileVerifiedAt).toBe(identity.oauthProfileVerifiedAt)
  }, SUBPROCESS_TEST_TIMEOUT_MS)
})

describe('updateLlmConnection – miniModel (E1)', () => {
  it('persists an explicit utility model', () => {
    const { runUpdate, readConnection } = setup([makeConnection()])

    expect(runUpdate('custom-compat', { miniModel: 'deepseek-v3' })).toBe(true)
    expect(readConnection('custom-compat').miniModel).toBe('deepseek-v3')
  }, SUBPROCESS_TEST_TIMEOUT_MS)

  /**
   * The #838 trap, one field over: this merge is an ALLOWLIST, so a field
   * missing from it survives its own save and then vanishes the next time any
   * OTHER field is written. Renaming the connection is the cheapest unrelated
   * update there is.
   */
  it('preserves it across an unrelated update', () => {
    const { runUpdate, readConnection } = setup([makeConnection({ miniModel: 'deepseek-v3' })])

    expect(runUpdate('custom-compat', { name: 'Renamed Endpoint' })).toBe(true)

    const conn = readConnection('custom-compat')
    expect(conn.name).toBe('Renamed Endpoint')
    expect(conn.miniModel).toBe('deepseek-v3')
  }, SUBPROCESS_TEST_TIMEOUT_MS)
})

describe('updateLlmConnection – per-model generation config (DA1.22)', () => {
  /**
   * The strict-envelope question, answered by the round trip rather than by
   * reading the merge.
   *
   * DA1.22 adds `reasoningEffort` and `samplingParams` to a model ENTRY, not to
   * the connection, so the wave-9 rule-19 checklist (type + `StoredConfigSchema`
   * + this allowlist + the writer) has nothing to add: `models` is already one
   * allowlisted field carried wholesale, and its element schema is
   * `z.object({ id }).passthrough()`. This case is what makes that claim
   * falsifiable — it fails the day either the array stops being carried whole or
   * the element schema stops passing unknown keys through.
   */
  it('survives an unrelated update, keys and all', () => {
    const { runUpdate, readConnection } = setup([makeConnection({
      models: [{ id: 'coder', reasoningEffort: 'low', samplingParams: { temperature: 1, top_k: 20, top_p: 0.95 } }],
    })])

    expect(runUpdate('custom-compat', { name: 'Renamed Endpoint' })).toBe(true)

    const conn = readConnection('custom-compat')
    expect(conn.name).toBe('Renamed Endpoint')
    expect(conn.models[0]).toEqual({
      id: 'coder',
      reasoningEffort: 'low',
      samplingParams: { temperature: 1, top_k: 20, top_p: 0.95 },
    })
  }, SUBPROCESS_TEST_TIMEOUT_MS)
})
