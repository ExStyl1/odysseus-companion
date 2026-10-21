/**
 * C3.366 — a credential handed to `llmConnections.SAVE` must not be dropped in
 * silence, and must never reach `config.json`.
 *
 * R6a's PR-R6a-4 measured the symptom on a fresh profile: a card saved with an
 * inline `apiKey` listed and deleted correctly while `getLlmConnectionApiKey`
 * returned nothing. The cause is one layer down and has TWO faces, which is why
 * the create arm and the update arm are both pinned here:
 *
 * - `LlmConnectionSchema` (`config/validators.ts`) ends in `.passthrough()` and
 *   `addLlmConnection` (`config/storage.ts`) SPREADS the whole payload, so on the
 *   CREATE path the credential was written into `config.json` as plain text —
 *   stored, but in the one place nothing reads a credential from and the one
 *   place a credential must never be.
 * - `updateLlmConnection` rebuilds the connection from a hardcoded allowlist, so
 *   on the UPDATE path the same field was dropped and stored nowhere at all.
 *
 * Both answer `getLlmConnectionApiKey` with nothing, because the credential
 * manager is the single reader and neither path wrote to it.
 *
 * In-process, on the isolated `NESSY_CONFIG_DIR` the root `[test].preload`
 * installs, so a write here never reaches a real config or a real credential
 * store. The credential manager is the REAL one (`initializeCredentialManagerV2`
 * over that isolated dir), not a mock: the row is about where the credential
 * ends up, and a fake store cannot answer that.
 *
 * ## Why this file is `.isolated.ts` and not `.test.ts` (D1.440, 2026-09-20)
 *
 * `initializeCredentialManagerV2` binds a PROCESS-GLOBAL singleton
 * (`managerVerificationId`, `packages/shared/src/credentials/manager.ts`) and
 * THROWS on a second bind with a different id. There is no reset seam, and this
 * directory holds two suites that bind: this one and
 * `gateway-credential-snapshot.test.ts`. Whichever bun runs second dies in its
 * own `beforeAll` — which is what the first completed CI run reported as two
 * `(unnamed)` failures, and what the per-directory chunk runner still reported
 * as one, because they are in the same directory and therefore the same chunk.
 *
 * So this suite runs ALONE, through `bun run test:isolated` (P3.354), and the
 * rename is the whole mechanism: neither `bun test` nor `scripts/ci-test-chunks.ts`
 * treats a name without `.test.`/`.spec.` as a test file, and `test:isolated`
 * finds it by `*.isolated.ts`. It is NOT skipped and its coverage is unchanged.
 *
 * The tolerant alternative was REFUSED with a reason. Three suites under
 * `packages/server-core/src/sessions/` wrap the same call in a `try` and say
 * *"if another suite in this process bound it first, a manager exists either
 * way"*; that is right for them, whose subject is boot order, and wrong here,
 * where the SUBJECT is which store the credential lands in. Swallowing the bind
 * hands this suite somebody else's manager, which `runtime-switch.test.ts`'s own
 * comment calls passing vacuously.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RPC_CHANNELS } from '@nessy-agent/shared/protocol'
import { getCredentialManager, initializeCredentialManagerV2 } from '@nessy-agent/shared/credentials'
import type { LlmConnection } from '@nessy-agent/shared/config'
import type { StoredConfig } from '@nessy-agent/shared/config/storage'
import type { HandlerFn, RpcServer } from '@nessy-agent/server-core/transport'
import type { HandlerDeps } from '../../handler-deps'
import { registerLlmConnectionsHandlers } from '../llm-connections'
import { MODULE_GRAPH_HOOK_BUDGET_MS } from '@nessy-agent/shared/testing/module-graph-budgets'

const stateRoot = mkdtempSync(join(tmpdir(), 'connection-save-inline-key-'))
const workspaceRoot = join(stateRoot, 'workspace')
mkdirSync(workspaceRoot, { recursive: true })
const WORKSPACE_ID = 'ws-connection-save-inline-key'
writeFileSync(
  join(workspaceRoot, 'config.json'),
  JSON.stringify({
    id: WORKSPACE_ID,
    name: 'Connection Save Workspace',
    slug: 'connection-save-workspace',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }, null, 2),
  'utf-8',
)

/** Never a real credential — a literal nothing can authenticate with. */
const PROBE_KEY = 'sk-c3366-not-a-real-key-0000'
const PROBE_KEY_2 = 'sk-c3366-not-a-real-key-1111'
/** What `GET_API_KEY` hands the edit form back. It is not a credential. */
const MASKED = 'sk-c336••••••••0000'

const EXISTING: LlmConnection = {
  slug: 'byo-existing',
  name: 'BYO Existing',
  providerType: 'pi_compat',
  authType: 'api_key_with_endpoint',
  baseUrl: 'http://127.0.0.1:65535/v1',
  defaultModel: 'probe-model',
  models: ['probe-model'],
  createdAt: Date.now(),
}

let restoreConfig: () => void = () => {}
let configPath = ''
let seed: () => void = () => {}

beforeAll(async () => {
  const storage = await import('@nessy-agent/shared/config/storage')
  configPath = storage.getConfigPath()
  const previous = existsSync(configPath) ? storage.loadStoredConfig() : null
  const base: StoredConfig = previous ?? ({
    storageLayoutVersion: 2,
    workspaceRefs: [],
    activeWorkspaceId: null,
    activeSessionId: null,
  } as unknown as StoredConfig)
  seed = () => {
    storage.saveConfig({
      ...base,
      defaultLlmConnection: EXISTING.slug,
      llmConnections: [{ ...EXISTING }] as unknown as NonNullable<StoredConfig['llmConnections']>,
    })
  }
  seed()
  restoreConfig = () => {
    if (previous) storage.saveConfig(previous)
    else if (existsSync(configPath)) rmSync(configPath)
  }
  initializeCredentialManagerV2({ storageLayoutVersion: 2, verificationId: 'test-connection-save-inline-key' })
}, MODULE_GRAPH_HOOK_BUDGET_MS)

afterAll(() => {
  restoreConfig()
  rmSync(stateRoot, { recursive: true, force: true })
})

function handlers(): Map<string, HandlerFn> {
  const registered = new Map<string, HandlerFn>()
  const server = {
    handle(channel: string, handler: HandlerFn) { registered.set(channel, handler) },
    push() {},
    async invokeClient() { return undefined },
    hasClientCapability() { return false },
    findClientsWithCapability() { return [] },
  } as RpcServer
  const deps = {
    sessionManager: {
      sessionsUsingConnection: () => [],
      listAutomationsUsingConnection: () => [],
      refreshConnectionRuntime: async () => {},
      reinitializeAuth: async () => {},
    },
    platform: { logger: { info() {}, warn() {}, error() {}, debug() {} } },
    oauthFlowStore: {},
  } as unknown as HandlerDeps
  registerLlmConnectionsHandlers(server, deps)
  return registered
}

const ctx = { clientId: 'client-a', workspaceId: WORKSPACE_ID, webContentsId: null }

const save = (connection: unknown) =>
  handlers().get(RPC_CHANNELS.llmConnections.SAVE)!(ctx, connection) as Promise<{ success: boolean; error?: string }>

const readApiKey = (slug: string) =>
  handlers().get(RPC_CHANNELS.llmConnections.GET_API_KEY)!(ctx, slug) as Promise<string | null>

const storedConnection = (slug: string): Record<string, unknown> | undefined => {
  const raw = JSON.parse(readFileSync(configPath, 'utf-8')) as { llmConnections?: Record<string, unknown>[] }
  return raw.llmConnections?.find(entry => entry.slug === slug)
}

describe('saving a connection with an inline credential', () => {
  it('round-trips a key handed to the CREATE path', async () => {
    const slug = 'byo-created'
    const result = await save({ ...EXISTING, slug, name: 'BYO Created', apiKey: PROBE_KEY })
    expect(result.success).toBe(true)

    // The reader R6a used. Masked, because GET_API_KEY masks for every caller —
    // so the assertion is on the tail, which is the part only a real stored key
    // can produce.
    expect(await readApiKey(slug)).toContain(PROBE_KEY.slice(-4))
    // …and the same key read unmasked from the store the app itself reads.
    expect(await getCredentialManager().getLlmApiKey(slug)).toBe(PROBE_KEY)
  })

  // A SEPARATE case, not three more assertions on the one above, because this
  // is the half that makes the row a security fix rather than only a round-trip
  // fix — and a failing round-trip assertion above would otherwise hide it.
  // Measured at HEAD before this row: `config.json` held the credential
  // verbatim after a create.
  it('leaves none of a CREATE-path credential in config.json', async () => {
    const slug = 'byo-created-leak'
    expect((await save({ ...EXISTING, slug, name: 'BYO Leak', apiKey: PROBE_KEY })).success).toBe(true)
    const stored = storedConnection(slug)
    expect(stored).toBeDefined()
    expect(Object.hasOwn(stored!, 'apiKey')).toBe(false)
    expect(readFileSync(configPath, 'utf-8')).not.toContain(PROBE_KEY)
  })

  it('round-trips a key handed to the UPDATE path, where the allowlist dropped it entirely', async () => {
    const result = await save({ ...EXISTING, apiKey: PROBE_KEY_2 })
    expect(result.success).toBe(true)
    expect(await getCredentialManager().getLlmApiKey(EXISTING.slug)).toBe(PROBE_KEY_2)
    expect(Object.hasOwn(storedConnection(EXISTING.slug) ?? {}, 'apiKey')).toBe(false)
    expect(readFileSync(configPath, 'utf-8')).not.toContain(PROBE_KEY_2)
  })

  it('refuses to overwrite a stored key with the MASK the edit form holds', async () => {
    // The boundary. `GET_API_KEY` prefills the edit form with `sk-xxx••••••••1234`,
    // and a renderer that spreads the connection it is editing sends that string
    // straight back. Storing it would destroy the real credential with a string
    // no endpoint accepts — silently, which is the same failure this row closes
    // pointed the other way.
    await getCredentialManager().setLlmApiKey(EXISTING.slug, PROBE_KEY)
    const result = await save({ ...EXISTING, apiKey: MASKED })
    expect(result.success).toBe(true)
    expect(await getCredentialManager().getLlmApiKey(EXISTING.slug)).toBe(PROBE_KEY)
  })

  it('leaves the stored key alone when the payload carries no credential at all', async () => {
    // The negative subject. Without it the rows above pass just as well against
    // a handler that writes the credential store on every save — and the app's
    // own callers (the rename in `AiSettingsPage`, the vision toggle) are
    // exactly this shape.
    await getCredentialManager().setLlmApiKey(EXISTING.slug, PROBE_KEY_2)
    const result = await save({ ...EXISTING, name: 'BYO Renamed' })
    expect(result.success).toBe(true)
    expect(await getCredentialManager().getLlmApiKey(EXISTING.slug)).toBe(PROBE_KEY_2)
    expect(storedConnection(EXISTING.slug)?.name).toBe('BYO Renamed')
  })
})
