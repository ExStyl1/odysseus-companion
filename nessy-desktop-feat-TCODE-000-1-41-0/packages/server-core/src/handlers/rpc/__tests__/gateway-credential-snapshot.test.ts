/**
 * DA1.13 — the gateway card stops carrying a stale credential snapshot.
 *
 * A one-click Nessy Gateway card's credential of record is the shared dp JWT in
 * `~/.nessy/dp_auth_creds.json`, read live per turn. Until this row the card
 * ALSO snapshotted that JWT into the credential store under its slug, where it
 * had no lifecycle at all: no re-mint refreshed it, the Reconnect item never
 * touched it (its handler says so in its own comment), nothing expired it. What
 * it could still do was LEAVE — `pi-agent.ts` symbol `getPiAuth` fell back to
 * the stored key when the live creds were gone and
 * `unified-network-interceptor.ts` symbol `rewriteNestorAuthHeaders` turns a
 * Bearer on the gateway into `Nestor-Token`.
 *
 * The rule has four halves and this file drives two of them end to end:
 * **created** (the setup RPC refuses the write) and **discarded** (the same
 * handler deletes a snapshot an older install left behind, which is the
 * migration — every re-run of the card upserts through here). The other two are
 * pinned where they live: **read** by
 * `packages/shared/src/agent/__tests__/pi-agent-nestor-auth.test.ts` (symbol
 * `isUsablePiStoredCredential` now refuses every stored value on a gateway
 * connection) and the transient staging in `testBackendConnection` by
 * `packages/shared/src/agent/backend/__tests__/byo-setup-test-seam.test.ts`.
 *
 * ## Why the connection-status arm is here and not an afterthought
 *
 * Removing the snapshot without it is a REGRESSION, not a fix:
 * `llmConnections.LIST_WITH_STATUS` computes `isAuthenticated` from the
 * credential store, `ConnectionRow.tsx` DISABLES a row that is not
 * authenticated, and the settings page labels it "Not authenticated". All three
 * gateway cards would have gone dark. The presence check therefore learned the
 * rule (`CredentialManager.hasLlmCredentials`, which now takes the connection's
 * base URL), and the two arms below are what stop that from silently rotting
 * back.
 *
 * In-process, on the isolated `NESSY_CONFIG_DIR` the root `[test].preload`
 * installs, with the REAL credential manager over that isolated dir — the same
 * shape as `connection-save-inline-key.isolated.ts` next door, and for the same
 * reason: the row is about where a credential ends up, and a fake store cannot
 * answer that. No value in this file is a real credential.
 *
 * D1.440 — the sibling's `.isolated.ts` name is not decoration and the pointer
 * above is not stale. `initializeCredentialManagerV2` binds a process-global
 * singleton that throws on a second bind with a different id, with no reset
 * seam, and these two suites were the only pair of binders in one directory;
 * whichever bun ran second died in its own `beforeAll`. The sibling moved to
 * `bun run test:isolated`, which leaves THIS file the sole binder in its batch,
 * so it needs no isolation of its own. A THIRD binder landing in this directory
 * brings the collision straight back — the sibling's header carries the full
 * reasoning, including why wrapping the call in a `try`, which three suites
 * under `sessions/` do, would be wrong for a suite whose subject is the store.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RPC_CHANNELS, type LlmConnectionSetup } from '@nessy-agent/shared/protocol'
import { getCredentialManager, initializeCredentialManagerV2 } from '@nessy-agent/shared/credentials'
import { isGatewayBackedConnection } from '@nessy-agent/shared/agent/backend'
import { enableDebug } from '@nessy-agent/shared/utils'
import type { LlmConnection, LlmConnectionWithStatus } from '@nessy-agent/shared/config'
import type { StoredConfig } from '@nessy-agent/shared/config/storage'
import type { HandlerFn, RpcServer } from '@nessy-agent/server-core/transport'
import type { HandlerDeps } from '../../handler-deps'
import { registerLlmConnectionsHandlers } from '../llm-connections'
import { MODULE_GRAPH_HOOK_BUDGET_MS } from '@nessy-agent/shared/testing/module-graph-budgets'

/**
 * The one-click cards' endpoint, spelled here rather than imported: the emitter
 * (`apps/electron/src/renderer/components/apisetup/gateway-one-click.ts`) is a
 * renderer module this package cannot import, and its own suite pins that the
 * payloads below are the ones it sends.
 */
const GATEWAY_BASE_URL = 'https://code-completion-nestor.tcsbank.ru/api/v1/cli/openai-like/v1'
/** Same HOST, different path: a BYO endpoint, and its key is its own business. */
const GATEWAY_HOST_BYO_URL = 'https://code-completion-nestor.tcsbank.ru/api/v1/personal/x'

/** Never a real token — a fabricated three-segment string shaped like a JWT. */
const FAKE_SNAPSHOT = 'da113header.da113payload.da113signature'
/** A user's own key on their own endpoint. Also fabricated. */
const BYO_KEY = 'sk-da113-not-a-real-key-0000'

const stateRoot = mkdtempSync(join(tmpdir(), 'gateway-credential-snapshot-'))
const workspaceRoot = join(stateRoot, 'workspace')
mkdirSync(workspaceRoot, { recursive: true })
const WORKSPACE_ID = 'ws-gateway-credential-snapshot'
writeFileSync(
  join(workspaceRoot, 'config.json'),
  JSON.stringify({
    id: WORKSPACE_ID,
    name: 'Gateway Credential Snapshot Workspace',
    slug: 'gateway-credential-snapshot-workspace',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }, null, 2),
  'utf-8',
)

const MODELS = ['tgpt/deepseek-v4-flash-0731']

/** A pre-DA1.13 Pi gateway card: created by the old one-click path, key and all. */
const PI_GATEWAY: LlmConnection = {
  slug: 'pi-api-key',
  name: 'Nessy Gateway',
  providerType: 'pi_compat',
  authType: 'api_key_with_endpoint',
  baseUrl: GATEWAY_BASE_URL,
  customEndpoint: { api: 'openai-completions', supportsImages: false },
  piAuthProvider: 'openai',
  defaultModel: MODELS[0]!,
  models: MODELS,
  createdAt: Date.now(),
}

/** The user's own endpoint, parked on the gateway HOST. Not a gateway card. */
const HOST_BYO: LlmConnection = {
  slug: 'byo-on-gateway-host',
  name: 'My Endpoint',
  providerType: 'pi_compat',
  authType: 'api_key_with_endpoint',
  baseUrl: GATEWAY_HOST_BYO_URL,
  customEndpoint: { api: 'openai-completions' },
  piAuthProvider: 'openai',
  defaultModel: MODELS[0]!,
  models: MODELS,
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
      defaultLlmConnection: PI_GATEWAY.slug,
      llmConnections: [
        { ...PI_GATEWAY },
        { ...HOST_BYO },
      ] as unknown as NonNullable<StoredConfig['llmConnections']>,
    })
  }
  seed()
  restoreConfig = () => {
    if (previous) storage.saveConfig(previous)
    else if (existsSync(configPath)) rmSync(configPath)
  }
  initializeCredentialManagerV2({ storageLayoutVersion: 2, verificationId: 'test-gateway-credential-snapshot' })
}, MODULE_GRAPH_HOOK_BUDGET_MS)

afterAll(() => {
  restoreConfig()
  rmSync(stateRoot, { recursive: true, force: true })
})

/** Everything `deps.platform.logger` was handed, in order, for the DA1.58 arms. */
type LoggerSink = string[]

function handlers(sink?: LoggerSink): Map<string, HandlerFn> {
  const registered = new Map<string, HandlerFn>()
  const server = {
    handle(channel: string, handler: HandlerFn) { registered.set(channel, handler) },
    push() {},
    async invokeClient() { return undefined },
    hasClientCapability() { return false },
    findClientsWithCapability() { return [] },
  } as RpcServer
  const record = (...args: unknown[]) => { sink?.push(args.map(a => String(a)).join(' ')) }
  const deps = {
    sessionManager: {
      sessionsUsingConnection: () => [],
      listAutomationsUsingConnection: () => [],
      refreshConnectionRuntime: async () => {},
      reinitializeAuth: async () => {},
    },
    platform: { logger: { info: record, warn: record, error: record, debug: record } },
    oauthFlowStore: {},
  } as unknown as HandlerDeps
  registerLlmConnectionsHandlers(server, deps)
  return registered
}

const ctx = { clientId: 'client-a', workspaceId: WORKSPACE_ID, webContentsId: null }

const setup = (payload: LlmConnectionSetup, sink?: LoggerSink) =>
  handlers(sink).get(RPC_CHANNELS.settings.SETUP_LLM_CONNECTION)!(ctx, payload) as Promise<{ success: boolean; error?: string }>

const listWithStatus = () =>
  handlers().get(RPC_CHANNELS.llmConnections.LIST_WITH_STATUS)!(ctx, undefined) as Promise<LlmConnectionWithStatus[]>

/** What the Pi card submits today — `buildGatewaySetup('pi', …)`, minus the credential. */
const PI_CARD_SETUP: LlmConnectionSetup = {
  slug: PI_GATEWAY.slug,
  baseUrl: GATEWAY_BASE_URL,
  defaultModel: MODELS[0]!,
  models: MODELS,
  piAuthProvider: 'openai',
  modelSelectionMode: 'userDefined3Tier',
  customEndpoint: { api: 'openai-completions', supportsImages: false },
}

describe('DA1.13 — the setup RPC refuses a gateway credential and discards an old snapshot', () => {
  it('deletes the snapshot a pre-DA1.13 install left under the Pi gateway slug', async () => {
    // The migration, and the trigger is the card re-run itself: a user who
    // clicks the gateway card again upserts through this handler.
    await getCredentialManager().setLlmApiKey(PI_GATEWAY.slug, FAKE_SNAPSHOT)
    expect(await getCredentialManager().getLlmApiKey(PI_GATEWAY.slug)).toBe(FAKE_SNAPSHOT)

    expect((await setup(PI_CARD_SETUP)).success).toBe(true)

    expect(await getCredentialManager().getLlmApiKey(PI_GATEWAY.slug)).toBeNull()
  })

  it('refuses a credential a caller still sends for a gateway card', async () => {
    // `buildGatewaySetup` stopped sending one and DA1.32 removed `ApiKeyInput`'s
    // prefill, so nothing in the product sends one any more — but a user can
    // still TYPE a key with the gateway preset active, and a non-form client
    // (the CDP harness, iOS) can send anything. The server is where the rule can
    // actually be enforced.
    //
    // DA1.60 CHANGED WHAT THAT ENFORCEMENT LOOKS LIKE, and this arm is where the
    // change is visible: it used to answer `success: true` with the credential
    // dropped on the floor, which is the silent half DA1.60 was born to close.
    // The invariant this arm has always been about — nothing is stored — is
    // unchanged and still asserted.
    await getCredentialManager().deleteLlmApiKey(PI_GATEWAY.slug)
    const refused = await setup({ ...PI_CARD_SETUP, credential: FAKE_SNAPSHOT })
    expect(refused).toEqual({ success: false, error: 'endpointIsGateway' })
    expect(await getCredentialManager().getLlmApiKey(PI_GATEWAY.slug)).toBeNull()
  })

  it('stores nothing for the claude and codex gateway cards either — three cards, not one', async () => {
    // The payload each card actually submits (`buildGatewaySetup('claude'|'codex', …)`):
    // slug, endpoint, models — and no credential at all.
    for (const slug of ['claude-gateway', 'codex-gateway']) {
      const result = await setup({
        slug,
        baseUrl: GATEWAY_BASE_URL,
        defaultModel: MODELS[0]!,
        models: MODELS,
      })
      expect(result.success).toBe(true)
      expect(await getCredentialManager().getLlmApiKey(slug)).toBeNull()

      // …and a caller that DOES send one is refused rather than quietly served
      // (DA1.60). Both arms in one loop so the card's own shape and the refused
      // shape are read on the same slug in the same state.
      expect(await setup({
        slug,
        credential: FAKE_SNAPSHOT,
        baseUrl: GATEWAY_BASE_URL,
        defaultModel: MODELS[0]!,
        models: MODELS,
      })).toEqual({ success: false, error: 'endpointIsGateway' })
      expect(await getCredentialManager().getLlmApiKey(slug)).toBeNull()
    }
  })

  it('POSITIVE CONTROL: a BYO endpoint on the gateway HOST keeps and updates its own key', async () => {
    // The whole reason the predicate is the strict whole-URL match rather than
    // the host-class one (`isNessyGatewayConnectionShape`): DA1.10 measured that
    // such a connection receives no dp JWT at all, so the key stored here is a
    // real user credential and deleting it would break their endpoint.
    const result = await setup({
      slug: HOST_BYO.slug,
      credential: BYO_KEY,
      baseUrl: GATEWAY_HOST_BYO_URL,
      defaultModel: MODELS[0]!,
      models: MODELS,
      customEndpoint: { api: 'openai-completions' },
    })
    expect(result.success).toBe(true)
    expect(await getCredentialManager().getLlmApiKey(HOST_BYO.slug)).toBe(BYO_KEY)
  })
})

describe('DA1.13 — removing the snapshot does not take the card away', () => {
  it('reports a keyless gateway card as authenticated', async () => {
    await getCredentialManager().deleteLlmApiKey(PI_GATEWAY.slug)
    const rows = await listWithStatus()
    const gateway = rows.find(row => row.slug === PI_GATEWAY.slug)
    expect(gateway).toBeDefined()
    // Before the presence check learned the rule this was `false`, which
    // DISABLES the row in the model switcher and labels it "Not authenticated"
    // — a signed-out user could then not select the connection whose selection
    // is what triggers the re-mint.
    expect(gateway!.isAuthenticated).toBe(true)
  })

  it('NEGATIVE CONTROL: a keyless BYO connection is still reported unauthenticated', async () => {
    // Without this the row above passes just as well against a build that had
    // stopped consulting the credential store at all.
    await getCredentialManager().deleteLlmApiKey(HOST_BYO.slug)
    const rows = await listWithStatus()
    const byo = rows.find(row => row.slug === HOST_BYO.slug)
    expect(byo).toBeDefined()
    expect(byo!.isAuthenticated).toBe(false)

    await getCredentialManager().setLlmApiKey(HOST_BYO.slug, BYO_KEY)
    const after = await listWithStatus()
    expect(after.find(row => row.slug === HOST_BYO.slug)!.isAuthenticated).toBe(true)
  })
})

describe('DA1.13 — isGatewayBackedConnection, the one spelling of the rule', () => {
  it('answers for all three one-click cards', () => {
    for (const providerType of ['pi_compat', 'claude-runtime', 'codex-runtime']) {
      expect(isGatewayBackedConnection({ providerType, baseUrl: GATEWAY_BASE_URL })).toBe(true)
    }
    // Trailing slash and surrounding space normalise, as they do for every other
    // reader of this module's URL comparison.
    expect(isGatewayBackedConnection({ providerType: 'pi_compat', baseUrl: ` ${GATEWAY_BASE_URL}/ ` })).toBe(true)
  })

  it('refuses the host-class look-alikes the destructive half must not touch', () => {
    // Same host, different path.
    expect(isGatewayBackedConnection({ providerType: 'pi_compat', baseUrl: GATEWAY_HOST_BYO_URL })).toBe(false)
    // A different host that merely mentions the gateway's.
    expect(isGatewayBackedConnection({
      providerType: 'claude-runtime',
      baseUrl: 'https://evil.example/?x=code-completion-nestor.tcsbank.ru',
    })).toBe(false)
    // A provider type that never reaches the gateway.
    expect(isGatewayBackedConnection({ providerType: 'anthropic', baseUrl: GATEWAY_BASE_URL })).toBe(false)
    expect(isGatewayBackedConnection({ providerType: 'pi', baseUrl: GATEWAY_BASE_URL })).toBe(false)
  })

  it('BOUNDARY: a caller that does not know the endpoint gets the store-only answer', () => {
    // The strict half, and the reason it is strict. `refreshGatewayAuthForRetry`'s
    // private copy accepts a blank base URL because attempting a re-mint costs
    // nothing when it guesses wide; this one decides whether to DELETE a stored
    // credential and whether to skip a presence check, where guessing wide would
    // drop a BYO connection's real key.
    expect(isGatewayBackedConnection({ providerType: 'pi_compat' })).toBe(false)
    expect(isGatewayBackedConnection({ providerType: 'codex-runtime', baseUrl: null })).toBe(false)
    expect(isGatewayBackedConnection({ providerType: 'claude-runtime', baseUrl: '   ' })).toBe(false)
    expect(isGatewayBackedConnection({})).toBe(false)
  })
})

/**
 * DA1.60 — `endpointIsGateway` moves from the form to the door every client shares.
 *
 * Born 2026-09-17 from lane SIT's RS-40 on the packaged 1.39.0: the exact
 * gateway URL with a fabricated key answered `success: true` and produced a
 * connection, because the only enforcement point was a renderer FORM rule and
 * the shipped ADD form renders no endpoint input at all.
 *
 * Read the handler's own docblock for why the refusal keys on the CREDENTIAL
 * rather than on the URL alone: the one-click cards submit that URL through this
 * same RPC, so an unconditional refusal would take the gateway feature away.
 */
describe('DA1.60 — the exact gateway URL is refused server-side when a credential rides with it', () => {
  /** RS-40's own payload, verbatim in shape: a fresh slug, a key, the gateway URL. */
  const BYO_AT_GATEWAY_SLUG = 'pi-api-key-da160'

  it('refuses the SIT payload and creates NO connection — the refusal is before the write', async () => {
    const before = (await handlers().get(RPC_CHANNELS.llmConnections.LIST)!(ctx, undefined)) as LlmConnection[]
    expect(before.some(c => c.slug === BYO_AT_GATEWAY_SLUG)).toBe(false)

    expect(await setup({
      slug: BYO_AT_GATEWAY_SLUG,
      credential: BYO_KEY,
      baseUrl: GATEWAY_BASE_URL,
      customEndpoint: { api: 'openai-completions' },
      defaultModel: MODELS[0]!,
      models: MODELS,
    })).toEqual({ success: false, error: 'endpointIsGateway' })

    // The half a refusal placed after the write would fail: the connection must
    // not exist, and no credential may be left behind under its slug.
    const after = (await handlers().get(RPC_CHANNELS.llmConnections.LIST)!(ctx, undefined)) as LlmConnection[]
    expect(after.some(c => c.slug === BYO_AT_GATEWAY_SLUG)).toBe(false)
    expect(await getCredentialManager().getLlmApiKey(BYO_AT_GATEWAY_SLUG)).toBeNull()
  })

  it('POSITIVE CONTROL: the same key on the gateway HOST, different path, is accepted and stored', async () => {
    // Without this the arm above passes just as well against a build that had
    // started refusing every keyed setup. AGENTS.md: a custom endpoint on the
    // same host keeps normal provider auth semantics.
    await getCredentialManager().deleteLlmApiKey(HOST_BYO.slug)
    expect((await setup({
      slug: HOST_BYO.slug,
      credential: BYO_KEY,
      baseUrl: GATEWAY_HOST_BYO_URL,
      customEndpoint: { api: 'openai-completions' },
      defaultModel: MODELS[0]!,
      models: MODELS,
    })).success).toBe(true)
    expect(await getCredentialManager().getLlmApiKey(HOST_BYO.slug)).toBe(BYO_KEY)
  })

  it('POSITIVE CONTROL: the one-click card, which sends no credential, still succeeds on that URL', async () => {
    // The reason the rule is not the URL alone. `buildGatewaySetup('pi', …)`
    // submits this shape, and refusing it would be the whole feature.
    expect((await setup(PI_CARD_SETUP)).success).toBe(true)
  })

  it('BOUNDARY: the masked placeholder an edit form sends back is not a credential', async () => {
    // `GET_API_KEY` returns the stored value masked; an ordinary re-save sends
    // it back. A refusal that could not tell the two apart would reject a save
    // the user never changed.
    expect((await setup({ ...PI_CARD_SETUP, credential: 'sk-••••••••1234' })).success).toBe(true)
  })
})

/**
 * DA1.58 — the credential-lifecycle sentences move to a sink a packaged build writes.
 *
 * Born 2026-09-17 from lane SIT's RS-41: the DA1.13 migration RAN on the
 * packaged 1.39.0 and neither its sentence nor its sibling "Saved API key to LLM
 * connection" was anywhere in the app's captured output, while `[ws-rpc-server]`
 * and `[dp-auth]` lines from the same run were. The cause is
 * `apps/electron/src/main/logger.ts` disabling BOTH electron-log transports
 * whenever `isDebugMode` is false — which a packaged build always is.
 *
 * Two arms, and the first is the one that can regress: it asserts the sentences
 * are NOT on the injected logger while a sibling line still IS, which is the
 * control proving the injected logger is wired and recording.
 */
describe('DA1.58 — the discard sentence is off deps.platform.logger and on the operator-reachable sink', () => {
  it('the injected platform logger no longer carries it — and still carries its sibling', async () => {
    await getCredentialManager().setLlmApiKey(PI_GATEWAY.slug, FAKE_SNAPSHOT)
    const sink: LoggerSink = []
    expect((await setup(PI_CARD_SETUP, sink)).success).toBe(true)

    // The control: this logger recorded something from this very call.
    expect(sink.some(line => line.includes(`Updated LLM connection settings: ${PI_GATEWAY.slug}`))).toBe(true)
    // The subject: the credential-lifecycle sentences are not among them.
    expect(sink.some(line => line.includes('Discarded the stored credential snapshot'))).toBe(false)
    expect(sink.some(line => line.includes('Saved API key to LLM connection'))).toBe(false)
    // And the migration still ran — the move is a move, not a deletion.
    expect(await getCredentialManager().getLlmApiKey(PI_GATEWAY.slug)).toBeNull()
  })

  it('it reaches stderr under the [llm-connections] scope once debug is on', async () => {
    // `createLogger` writes only when `isDebugEnabled()`, which a packaged build
    // turns on through `NESSY_DEBUG=1` — the same lever that makes
    // `[ws-rpc-server]` and `[dp-auth]` appear, and the reading that made this
    // row. `debugEnabled` is module state resolved at load, so the env var
    // cannot be set from here: `enableDebug()` is the door, as two suites under
    // `packages/shared/src/agent/__tests__/` already use it. It is STICKY for
    // the process, which is why this arm is last in the file.
    await getCredentialManager().setLlmApiKey(PI_GATEWAY.slug, FAKE_SNAPSHOT)
    enableDebug()

    const written: string[] = []
    const realWrite = process.stderr.write.bind(process.stderr)
    process.stderr.write = ((chunk: unknown, ...rest: unknown[]) => {
      written.push(String(chunk))
      return (realWrite as (...args: unknown[]) => boolean)(chunk, ...rest)
    }) as typeof process.stderr.write
    const sink: LoggerSink = []
    try {
      expect((await setup(PI_CARD_SETUP, sink)).success).toBe(true)
    } finally {
      process.stderr.write = realWrite
    }

    const discard = written.find(line => line.includes('Discarded the stored credential snapshot'))
    expect(discard).toBeDefined()
    expect(discard).toContain('[llm-connections]')
    expect(discard).toContain(PI_GATEWAY.slug)
    // NEGATIVE, in the same run and on the same instrument: turning the sink on
    // does not put the sentence back on the injected logger.
    expect(sink.some(line => line.includes('Discarded the stored credential snapshot'))).toBe(false)
  })
})
