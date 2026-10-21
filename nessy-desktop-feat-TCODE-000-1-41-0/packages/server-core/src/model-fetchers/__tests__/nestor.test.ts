import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { LlmConnection, ModelDefinition } from '@nessy-agent/shared/config'
import { isNessyGatewayBaseUrl } from '@nessy-agent/shared/agent/backend'
import {
  MIN_PLAUSIBLE_CONTEXT_WINDOW,
  NESTOR_GATEWAY_MODEL_WINDOWS,
} from '@nessy-agent/shared/auth/nestor'
import { NESSY_HOME_ENV } from '@nessy-agent/shared/auth/dp'
import { relatchHomeDirForTests } from '@nessy-agent/shared/config/home-latch'
import { fetchNestorModels, isNestorConnection, NestorModelsFetchError } from '../nestor'
import { MODEL_FETCHERS } from '../registry'
import { makeTestJwt } from '@nessy-agent/shared/auth/dp/__tests__/test-jwt.ts'

const originalFetch = globalThis.fetch

/**
 * DA1.3 — every case here now runs against a FABRICATED creds file under a temp
 * `HOME`, because `fetchNestorModels` authenticates from the live dp
 * credentials rather than from the connection's stored key.
 *
 * DA1.50 · three segments is NOT all `getValidCreds` asks for any more: it gates
 * on `isUsableJwt`, so the value must also DECODE to an object carrying a
 * numeric `exp`. Every fixture here is built by `makeTestJwt`, which is
 * fabricated and unsigned; no real token exists in this tree, and the latch is
 * what keeps the suite from ever reading the developer's own
 * `~/.nessy/dp_auth_creds.json`.
 */
const LIVE_JWT = makeTestJwt({ preferred_username: 'fixture', sub: 'fixture' })
/** The value the card used to store and the fetcher used to send. */
const STORED_SNAPSHOT_KEY = 'stored-snapshot-key'

let fakeHome: string

function writeCreds(jwt: string, expiresAt = Date.now() + 60 * 60 * 1000): void {
  mkdirSync(join(fakeHome, '.nessy'), { recursive: true })
  writeFileSync(
    join(fakeHome, '.nessy', 'dp_auth_creds.json'),
    JSON.stringify({ jwt, expiresAt, username: 'fixture', userId: 'fixture' }),
    'utf-8',
  )
}

/**
 * DA1.36 — faking `HOME` is NOT enough, because `NESSY_HOME` OUTRANKS it.
 *
 * `packages/shared/src/auth/dp/creds-store.ts` symbol `getNessyDir` returns an
 * absolute `NESSY_HOME` verbatim and never consults the latch, so a developer
 * with that variable exported ran every case below against a REAL creds
 * directory — reading whatever credential happened to be there and putting it
 * on the stubbed `fetch`. It is cleared for the duration of each case and
 * restored afterwards.
 *
 * The `beforeAll` DECOY is what makes the clearing discriminating on a clean
 * machine: it stands in for that developer's exported value, and it points at a
 * directory holding a DIFFERENT fabricated JWT. Every case asserting the header
 * (`DECOY_JWT` would reach the wire instead of `LIVE_JWT`) and every case
 * asserting "no valid creds" now fails if the `delete` below is removed. The
 * decoy is live only between `beforeAll` and the first `beforeEach`, and again
 * between the last `afterEach` and `afterAll`, so no neighbouring suite in the
 * same process can observe it.
 *
 * `delete` FIRST, then assign, on the restore path too: an assignment to a name
 * Bun pre-creates a slot for stays invisible to `Object.keys` and to the spread
 * every subprocess env in this tree is built from (AGENTS.md §Traps).
 */
const DECOY_JWT = makeTestJwt({ preferred_username: 'decoy', sub: 'decoy' })
let decoyNessyHome: string
let savedNessyHome: string | undefined

beforeAll(() => {
  savedNessyHome = process.env[NESSY_HOME_ENV]
  decoyNessyHome = mkdtempSync(join(tmpdir(), 'nessy-nestor-decoy-'))
  writeFileSync(
    join(decoyNessyHome, 'dp_auth_creds.json'),
    JSON.stringify({ jwt: DECOY_JWT, expiresAt: Date.now() + 60 * 60 * 1000, username: 'decoy', userId: 'decoy' }),
    'utf-8',
  )
  delete process.env[NESSY_HOME_ENV]
  process.env[NESSY_HOME_ENV] = decoyNessyHome
})

afterAll(() => {
  delete process.env[NESSY_HOME_ENV]
  if (savedNessyHome !== undefined) process.env[NESSY_HOME_ENV] = savedNessyHome
  rmSync(decoyNessyHome, { recursive: true, force: true })
})

beforeEach(() => {
  delete process.env[NESSY_HOME_ENV]
  fakeHome = mkdtempSync(join(tmpdir(), 'nessy-nestor-fetch-'))
  relatchHomeDirForTests(fakeHome)
  writeCreds(LIVE_JWT)
})

function makeConnection(overrides: Partial<LlmConnection> = {}): LlmConnection {
  return {
    slug: 'nessy-gateway',
    name: 'Nessy Gateway',
    providerType: 'pi_compat',
    authType: 'api_key_with_endpoint',
    baseUrl: 'https://code-completion-nestor.tcsbank.ru/api/v1/cli/openai-like/v1',
    createdAt: 1,
    ...overrides,
  }
}

function model(id: string, overrides: Partial<ModelDefinition> = {}): ModelDefinition {
  return {
    id,
    name: id,
    shortName: id,
    description: id,
    provider: 'pi',
    contextWindow: 131_072,
    ...overrides,
  }
}

afterEach(() => {
  globalThis.fetch = originalFetch
  relatchHomeDirForTests()
  rmSync(fakeHome, { recursive: true, force: true })
  // DA1.36 — put the decoy back so the NEXT case's `beforeEach` has something
  // to clear; `afterAll` is what restores the developer's own value.
  delete process.env[NESSY_HOME_ENV]
  process.env[NESSY_HOME_ENV] = decoyNessyHome
})

describe('isNestorConnection', () => {
  it('matches only the CLI-scoped gateway URL prefix', () => {
    expect(isNestorConnection(makeConnection())).toBe(true)
    expect(isNestorConnection(makeConnection({ baseUrl: 'https://code-completion-nestor.tcsbank.ru/api/v1/cli/models' }))).toBe(true)
    expect(isNestorConnection(makeConnection({ baseUrl: 'https://code-completion-nestor.tcsbank.ru/api/v1/personal/x' }))).toBe(false)
    expect(isNestorConnection(makeConnection({ baseUrl: 'https://example.com/api/v1/cli/openai-like/v1' }))).toBe(false)
    expect(isNestorConnection(makeConnection({ baseUrl: 'not a url' }))).toBe(false)
    expect(isNestorConnection(makeConnection({ baseUrl: undefined }))).toBe(false)
  })
})

describe('fetchNestorModels', () => {
  it('maps live models, sends Nestor-Token, preserves per-model overrides, and returns server default', async () => {
    const calls: Array<{ url: string; token?: string; redirect?: RequestInit['redirect']; hasTimeoutSignal: boolean }> = []
    globalThis.fetch = (async (url, init) => {
      const headers = new Headers(init?.headers)
      calls.push({
        url: String(url),
        token: headers.get('Nestor-Token') ?? undefined,
        redirect: init?.redirect,
        hasTimeoutSignal: init?.signal instanceof AbortSignal,
      })
      return new Response(JSON.stringify([
        { id: 'tgpt/qwen35-397b-a17b-fp8', alias: 'coder', desc: 'Default coder', is_default: true, context_window_tokens: 262144 },
        { id: 'tgpt/override-only', name: 'Override Only', is_default: false },
        { id: 'tgpt/new-model', name: 'New Model', is_default: false },
      ]), { status: 200 })
    }) as typeof fetch

    const result = await fetchNestorModels(makeConnection({
      models: [
        model('tgpt/qwen35-397b-a17b-fp8', {
          contextWindow: 131_072,
          supportsImages: false,
          supportsThinking: false,
        }),
        model('tgpt/override-only', {
          contextWindow: 99_000,
          supportsImages: true,
        }),
      ],
    }))

    // llm-gateway-protocol.md:159 — "any redirect is treated as failure so the
    // credential can't leak to a redirect target", with a 3-second timeout.
    expect(calls).toEqual([{
      url: 'https://code-completion-nestor.tcsbank.ru/api/v1/cli/models',
      token: LIVE_JWT,
      redirect: 'error',
      hasTimeoutSignal: true,
    }])
    expect(result.serverDefault).toBe('tgpt/qwen35-397b-a17b-fp8')
    expect(result.models[0]).toMatchObject({
      id: 'tgpt/qwen35-397b-a17b-fp8',
      name: 'coder (tgpt/qwen35-397b-a17b-fp8)',
      shortName: 'coder',
      description: 'Default coder',
      contextWindow: 262_144,
      supportsImages: false,
      supportsThinking: false,
    })
    expect(result.models[1]).toMatchObject({
      id: 'tgpt/override-only',
      name: 'Override Only',
      contextWindow: 99_000,
      supportsImages: true,
    })
    expect(result.models[2]).toMatchObject({
      id: 'tgpt/new-model',
      name: 'New Model',
    })
    expect('contextWindow' in result.models[2]!).toBe(false)
    expect('supportsImages' in result.models[2]!).toBe(false)
  })

  /**
   * DA1.22 — the two generation fields, in the EXACT shape WA-e measured live on
   * 2026-09-13: `sampling_params` on both rows, `reasoning` on the default
   * `coder` row only, `extra_body` on neither. The `fast` row's `top_k` is in the
   * fixture on purpose — it is the key that reaches the gateway by no other
   * route, so a reader that allowlisted `temperature`/`top_p` would pass every
   * other assertion here and still drop it.
   */
  it('stores the catalogue\'s reasoning effort and sampling params (DA1.22)', async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify([
      {
        id: 'tgpt/deepseek-v4-flash-0731',
        alias: 'coder',
        is_default: true,
        context_window_size: 524_000,
        sampling_params: { temperature: 1, top_p: 0.95 },
        reasoning: { effort: 'low' },
      },
      {
        id: 'tgpt/qwen36-35b-a3b-fp8',
        alias: 'fast',
        is_default: false,
        context_window_size: 262_000,
        sampling_params: { temperature: 0.7, top_k: 20, top_p: 0.8 },
      },
    ]), { status: 200 })) as unknown as typeof fetch

    const result = await fetchNestorModels(makeConnection())

    expect(result.models[0]).toMatchObject({
      id: 'tgpt/deepseek-v4-flash-0731',
      reasoningEffort: 'low',
      samplingParams: { temperature: 1, top_p: 0.95 },
    })
    expect(result.models[1]).toMatchObject({
      id: 'tgpt/qwen36-35b-a3b-fp8',
      samplingParams: { temperature: 0.7, top_k: 20, top_p: 0.8 },
    })
    // The `fast` row publishes no `reasoning` block, so it gains no effort — the
    // absence is the catalogue's, not the parser's.
    expect('reasoningEffort' in result.models[1]!).toBe(false)
  })

  /**
   * DA1.22, the CONTROL. A catalogue that publishes neither field must produce
   * byte-identical entries to the pre-row parser — no empty objects, no empty
   * strings, no keys at all — because the two adapters that read them treat
   * PRESENCE as "the catalogue recommended something".
   *
   * The second row is the defensive arm: the shape has already moved twice on
   * this endpoint, so a `reasoning` that is a boolean, an `effort` that is a
   * number, an empty `sampling_params`, and a `sampling_params` that is an array
   * must all read as "no recommendation" rather than putting a non-string or an
   * empty object on the wire.
   */
  it('a catalogue row without the generation fields changes nothing (DA1.22 control)', async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify([
      { id: 'tgpt/plain', name: 'Plain', is_default: true, context_window_size: 262_000 },
      {
        id: 'tgpt/malformed',
        name: 'Malformed',
        is_default: false,
        context_window_size: 262_000,
        reasoning: true,
        sampling_params: [1, 2, 3],
      },
      {
        id: 'tgpt/empty',
        name: 'Empty',
        is_default: false,
        context_window_size: 262_000,
        reasoning: { effort: 3 },
        sampling_params: {},
      },
    ]), { status: 200 })) as unknown as typeof fetch

    const result = await fetchNestorModels(makeConnection())

    for (const entry of result.models) {
      expect('reasoningEffort' in entry).toBe(false)
      expect('samplingParams' in entry).toBe(false)
    }
    // The positive control on the same fixture: the rows ARE parsed, so the
    // three `false`s above are the fields being absent and not the fetch failing.
    expect(result.models.map(m => m.id)).toEqual(['tgpt/plain', 'tgpt/malformed', 'tgpt/empty'])
  })

  it('consumes `context_window_size`, the field the live gateway actually sends', async () => {
    // THE SHAPE THE REAL ENDPOINT RETURNS. Measured 2026-08-28 against
    // `GET /api/v1/cli/models` with the `Nestor-Token` the shipped card holds:
    // every row carries `context_window_size: 262000`, and none of the three
    // names this parser used to read. The previously recorded reading — six
    // fields and no context window anywhere in the CLI registry — is REFUTED;
    // the gateway grew the field and the parser read straight past it, so a
    // hard-coded fallback was answering a question the API had begun answering
    // itself, with a value 2144 tokens LARGER than the gateway's own.
    globalThis.fetch = (async () => new Response(JSON.stringify([
      { id: 'tgpt/qwen35-397b-a17b-fp8', alias: 'coder', is_default: true, context_window_size: 262_000 },
      { id: 'tgpt/qwen36-35b-a3b-fp8', alias: 'fast', is_default: false, context_window_size: 262_000 },
      { id: 'tgpt/unknown-future', name: 'Future', is_default: false, context_window_size: 40_960 },
    ]), { status: 200 })) as unknown as typeof fetch

    const result = await fetchNestorModels(makeConnection({
      models: [model('tgpt/qwen35-397b-a17b-fp8', { contextWindow: 131_072 })],
    }))

    expect(result.models[0]).toMatchObject({ id: 'tgpt/qwen35-397b-a17b-fp8', contextWindow: 262_000 })
    expect(result.models[1]).toMatchObject({ id: 'tgpt/qwen36-35b-a3b-fp8', contextWindow: 262_000 })
    // The whole point of reading the API: a model NO table covers now gets a
    // real window, which is the case the fallback table can never rescue.
    expect(result.models[2]).toMatchObject({ id: 'tgpt/unknown-future', contextWindow: 40_960 })
  })

  it('treats a `1` context window as "not filled in", never as a one-token window', async () => {
    // The sentinel. Both catalogues in this ecosystem use `1` for "nobody filled
    // this in" — llm-proxy on 63 of its 387 rows (measured 2026-08-28), the Pi
    // SDK's vendored registry on 207 of its own (as recorded 2026-08-28). The
    // counts carry their date because the catalogue moves weekly.
    // Consuming it literally would cap the session at one token
    // and do it silently, on exactly the models nobody curated: a strictly worse
    // bug than the missing window this path exists to fix. A placeholder must
    // fall through to the table, and past the table to nothing at all.
    globalThis.fetch = (async () => new Response(JSON.stringify([
      { id: 'tgpt/qwen35-397b-a17b-fp8', alias: 'coder', is_default: true, context_window_size: 1 },
      { id: 'tgpt/unknown-future', name: 'Future', is_default: false, context_window_size: 1 },
      { id: 'tgpt/zeroed', name: 'Zeroed', is_default: false, context_window_size: 0 },
    ]), { status: 200 })) as unknown as typeof fetch

    const result = await fetchNestorModels(makeConnection())

    // Covered by the table → the table's value, not the placeholder.
    expect(result.models[0]!.contextWindow).toBe(NESTOR_GATEWAY_MODEL_WINDOWS['tgpt/qwen35-397b-a17b-fp8']!)
    expect(result.models[0]!.contextWindow).toBeGreaterThan(MIN_PLAUSIBLE_CONTEXT_WINDOW)
    // Not covered → unannotated, so the compaction path warns loudly rather
    // than running a session against a one-token window.
    expect('contextWindow' in result.models[1]!).toBe(false)
    expect('contextWindow' in result.models[2]!).toBe(false)
  })

  it('self-heals stale gateway windows from the shipped table when the API omits context window', async () => {
    // The refresh-failed / field-withdrawn shape: the API answers, with no
    // window on any row. This is tier two of three.
    globalThis.fetch = (async () => new Response(JSON.stringify([
      { id: 'tgpt/qwen35-397b-a17b-fp8', alias: 'coder', is_default: true },
      { id: 'tgpt/qwen36-35b-a3b-fp8', alias: 'fast', is_default: false },
      { id: 'tgpt/unknown-future', name: 'Future', is_default: false },
    ]), { status: 200 })) as unknown as typeof fetch

    const result = await fetchNestorModels(makeConnection({
      models: [
        // Stale persisted overrides from before the fix.
        model('tgpt/qwen35-397b-a17b-fp8', { contextWindow: 131_072 }),
        model('tgpt/qwen36-35b-a3b-fp8', { contextWindow: 131_072 }),
      ],
    }))

    // Known gateway ids: the shipped table overrides the stale 131072. Asserted
    // through the constant rather than a literal — the table is refreshed by
    // `scripts/refresh-nestor-model-windows.ts`, and a hand-copied number here
    // would pin this test to whichever harvest happened to be current when it
    // was written.
    expect(result.models[0]).toMatchObject({
      id: 'tgpt/qwen35-397b-a17b-fp8',
      contextWindow: NESTOR_GATEWAY_MODEL_WINDOWS['tgpt/qwen35-397b-a17b-fp8'],
    })
    expect(result.models[1]).toMatchObject({
      id: 'tgpt/qwen36-35b-a3b-fp8',
      contextWindow: NESTOR_GATEWAY_MODEL_WINDOWS['tgpt/qwen36-35b-a3b-fp8'],
    })
    // Unknown model without an API window stays unannotated (no faked value).
    expect('contextWindow' in result.models[2]!).toBe(false)
  })

  it('throws on non-OK responses', async () => {
    globalThis.fetch = (async () => new Response('nope', { status: 503 })) as unknown as typeof fetch

    await expect(fetchNestorModels(makeConnection()))
      .rejects.toThrow('Nestor models fetch failed: 503')
  })

  // P3.90. The gateway answers 500 (not 401) for a credential it cannot parse
  // — measured 2026-08-28 with a personal llm-proxy key in `Authorization:
  // Bearer`. A 5xx is what every backoff in this tree treats as transient, so
  // the classification is the whole fix: retried, a wrong key would present as
  // a slow opaque failure instead of "wrong credential".
  it('classifies a models-endpoint 5xx as non-retryable and says why', async () => {
    globalThis.fetch = (async () => new Response('boom', { status: 500 })) as unknown as typeof fetch

    const error = await fetchNestorModels(makeConnection())
      .then(() => undefined, (thrown: unknown) => thrown)

    expect(error).toBeInstanceOf(NestorModelsFetchError)
    const classified = error as NestorModelsFetchError
    expect(classified.status).toBe(500)
    expect(classified.retryable).toBe(false)
    expect(classified.diagnosis).toContain('credential')
    // The diagnosis has to reach the caller's log, which prints `.message`.
    expect(classified.message).toContain('Nestor models fetch failed: 500')
    expect(classified.message).toContain('credential')
  })

  // The boundary: the two statuses a repeat CAN fix stay retryable, so the row
  // does not turn every failure into a permanent one.
  it('keeps 429 and 408 retryable, and carries no diagnosis for them', async () => {
    for (const status of [408, 429]) {
      globalThis.fetch = (async () => new Response('slow down', { status })) as unknown as typeof fetch

      const error = await fetchNestorModels(makeConnection())
        .then(() => undefined, (thrown: unknown) => thrown) as NestorModelsFetchError

      expect(error).toBeInstanceOf(NestorModelsFetchError)
      expect(error.status).toBe(status)
      expect(error.retryable).toBe(true)
      expect(error.diagnosis).toBeUndefined()
    }
  })

  it('rejects when the gateway redirects — never a silent empty model list', async () => {
    // The shape `redirect: 'error'` produces: fetch rejects with a TypeError
    // before any second request is issued. The failure MUST stay a throw —
    // the callers' catch paths keep the stale persisted catalog, while an
    // empty result would wipe it.
    globalThis.fetch = (async () => {
      throw new TypeError('unexpected redirect')
    }) as unknown as typeof fetch

    await expect(fetchNestorModels(makeConnection()))
      .rejects.toThrow('unexpected redirect')
  })

  // DA1.3 (positive). The credential is read LIVE, on every refresh — which is
  // the whole difference from the snapshot this path used to send. A re-mint
  // that lands between two refreshes must reach the second one; a value
  // captured once would keep sending the token the process started with, which
  // is the stale-snapshot failure in a new place.
  it('re-reads the creds file on every fetch, so a re-minted JWT reaches the next refresh', async () => {
    const tokens: Array<string | undefined> = []
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      tokens.push(new Headers(init?.headers).get('Nestor-Token') ?? undefined)
      return new Response(JSON.stringify([
        { id: 'tgpt/qwen35-397b-a17b-fp8', alias: 'coder', is_default: true },
      ]), { status: 200 })
    }) as unknown as typeof fetch

    await fetchNestorModels(makeConnection())
    const rotated = makeTestJwt({ preferred_username: 'rotated', sub: 'rotated' })
    writeCreds(rotated)
    await fetchNestorModels(makeConnection())

    expect(tokens).toEqual([LIVE_JWT, rotated])
  })

  // DA1.36 (the isolation invariant, stated once so the reason is legible).
  // The `beforeAll` decoy above is a developer's exported `NESSY_HOME`; the
  // `beforeEach` clears it. Remove that `delete` and this case reports the
  // decoy's JWT, which is exactly what the suite used to send to a stubbed
  // `fetch` on such a machine — a credential nobody in this file wrote.
  it('reads the fixture creds, not whatever NESSY_HOME points at (DA1.36)', async () => {
    expect(process.env[NESSY_HOME_ENV]).toBeUndefined()

    let sent: string | undefined
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      sent = new Headers(init?.headers).get('Nestor-Token') ?? undefined
      return new Response(JSON.stringify([
        { id: 'tgpt/qwen35-397b-a17b-fp8', alias: 'coder', is_default: true },
      ]), { status: 200 })
    }) as unknown as typeof fetch

    await fetchNestorModels(makeConnection())

    expect(sent).toBe(LIVE_JWT)
    expect(sent).not.toBe(DECOY_JWT)
  })

  // DA1.3 (negative/boundary). THREE ways the live credential can be unusable,
  // and all three must refuse BEFORE the request: an empty `Nestor-Token`
  // earns the gateway's "token contains an invalid number of segments" 401, and
  // a 401 recorded against a credential we never had is a diagnosis
  // `classifyNestorModelsStatus` would then carry for the rest of the session.
  // The warn is read off `console.warn` because that is where the fetcher's own
  // `handlerLog` lands until a host calls `setFetcherPlatform` — no test in this
  // package does, so this is the production logger and not a planted one.
  for (const [name, mutate] of [
    ['no creds file at all', () => { rmSync(join(fakeHome, '.nessy'), { recursive: true, force: true }) }],
    ['a hand-edited non-JWT value', () => { writeCreds('not-a-jwt') }],
    ['an expired JWT', () => { writeCreds(LIVE_JWT, Date.now() - 1000) }],
  ] as Array<[string, () => void]>) {
    it(`issues no request and logs one warn when the live creds are unusable: ${name}`, async () => {
      const calls: string[] = []
      globalThis.fetch = (async (url: unknown) => {
        calls.push(String(url))
        return new Response('[]', { status: 200 })
      }) as unknown as typeof fetch
      mutate()

      const warned: string[] = []
      const realWarn = console.warn
      console.warn = (...args: unknown[]) => { warned.push(args.map(String).join(' ')) }
      let result
      try {
        result = await fetchNestorModels(makeConnection())
      } finally {
        console.warn = realWarn
      }

      // No egress: in particular no empty or non-JWT `Nestor-Token`.
      expect(calls).toEqual([])
      // The empty result `_doRefresh` reads as "no models available from any
      // source" — the persisted catalogue is kept, never wiped.
      expect(result.models).toEqual([])
      expect(result.serverDefault).toBeUndefined()

      // ONE warn, and it is the skip's own line rather than the fetch-failed
      // one, so the P3.90 diagnosis is not spent on a request never issued.
      expect(warned).toHaveLength(1)
      expect(warned[0]).toContain('nessy-gateway')
      expect(warned[0]).toContain('no valid dp credentials')
      expect(warned[0]).not.toContain('fetch failed')
      // Codes only, never credential material.
      expect(warned[0]).not.toContain(LIVE_JWT)
      expect(warned[0]).not.toContain('not-a-jwt')
    })
  }
})

/**
 * The whole-URL gateway gate shared by BOTH runtime fetchers.
 *
 * The load-bearing rows are the same-host-different-path ones: AGENTS.md says
 * "Custom endpoints, even on the same host with a different path, must retain
 * normal provider auth semantics", and such a URL is a PREFIX match for
 * `isNestorConnection` while being BYO for the runtime adapter. Gating model
 * refresh on the prefix therefore posts the user's own key to the gateway as
 * `Nestor-Token` and overwrites their catalog with the gateway's.
 */
describe('runtime model fetchers gate on the whole-URL gateway match', () => {
  const GATEWAY_BASE_URL = 'https://code-completion-nestor.tcsbank.ru/api/v1/cli/openai-like/v1'
  // Same host, same `/api/v1/cli/` prefix, different path.
  const SAME_HOST_BYO_BASE_URL = 'https://code-completion-nestor.tcsbank.ru/api/v1/cli/byo-proxy/v1'
  const RUNTIME_PROVIDER_TYPES = ['codex-runtime', 'claude-runtime'] as const

  function recordFetch(): Array<{ url: string; nestorToken?: string }> {
    const calls: Array<{ url: string; nestorToken?: string }> = []
    globalThis.fetch = (async (url, init) => {
      const headers = new Headers(init?.headers)
      calls.push({ url: String(url), nestorToken: headers.get('Nestor-Token') ?? undefined })
      return new Response(JSON.stringify([
        { id: 'tgpt/qwen35-397b-a17b-fp8', alias: 'coder', is_default: true },
      ]), { status: 200 })
    }) as typeof fetch
    return calls
  }

  it('the same-host-different-path URL is a prefix match, so the prefix predicate cannot be the gate', () => {
    expect(isNestorConnection(makeConnection({ baseUrl: SAME_HOST_BYO_BASE_URL }))).toBe(true)
    expect(isNessyGatewayBaseUrl(SAME_HOST_BYO_BASE_URL)).toBe(false)
    expect(isNessyGatewayBaseUrl(GATEWAY_BASE_URL)).toBe(true)
  })

  for (const providerType of RUNTIME_PROVIDER_TYPES) {
    it(`${providerType}: a same-host-different-path BYO endpoint sends nothing to the gateway and keeps stored models`, async () => {
      const calls = recordFetch()

      const result = await MODEL_FETCHERS[providerType].fetchModels(
        makeConnection({
          providerType,
          baseUrl: SAME_HOST_BYO_BASE_URL,
          models: [model('byo/some-model')],
        }),
        { apiKey: 'user-own-byo-key' },
      )

      // No egress at all — in particular no `Nestor-Token: user-own-byo-key`.
      expect(calls).toEqual([])
      // Empty result → `ModelRefreshService._doRefresh` logs "no models available
      // from any source" and leaves `connection.models` untouched.
      expect(result.models).toEqual([])
      expect(result.serverDefault).toBeUndefined()
    })

    it(`${providerType}: an unrelated-host BYO endpoint sends nothing to the gateway`, async () => {
      const calls = recordFetch()

      const result = await MODEL_FETCHERS[providerType].fetchModels(
        makeConnection({
          providerType,
          baseUrl: 'https://llm.internal.example.com/v1',
          models: [model('local/some-model')],
        }),
        { apiKey: 'user-own-byo-key' },
      )

      expect(calls).toEqual([])
      expect(result.models).toEqual([])
    })

    it(`${providerType}: a connection with no baseUrl sends nothing to the gateway`, async () => {
      const calls = recordFetch()

      const result = await MODEL_FETCHERS[providerType].fetchModels(
        makeConnection({ providerType, baseUrl: undefined }),
        { apiKey: 'user-own-byo-key' },
      )

      expect(calls).toEqual([])
      expect(result.models).toEqual([])
    })

    it(`${providerType}: the exact gateway base URL still refreshes from the Nestor models API`, async () => {
      const calls = recordFetch()

      const result = await MODEL_FETCHERS[providerType].fetchModels(
        makeConnection({ providerType, baseUrl: GATEWAY_BASE_URL }),
        // DA1.3 — the `ModelFetcher` interface still hands every fetcher the
        // connection's stored key. The gateway catalogue must ignore it: all
        // three gateway cards (Pi, claude, codex) authenticate from the live
        // dp creds, which is what makes the claude and codex arms of this row
        // real rather than incidental.
        { apiKey: STORED_SNAPSHOT_KEY },
      )

      expect(calls).toEqual([{
        url: 'https://code-completion-nestor.tcsbank.ru/api/v1/cli/models',
        nestorToken: LIVE_JWT,
      }])
      expect(result.models.map(m => m.id)).toEqual(['tgpt/qwen35-397b-a17b-fp8'])
      expect(result.serverDefault).toBe('tgpt/qwen35-397b-a17b-fp8')
    })

    it(`${providerType}: a trailing slash on the gateway base URL still refreshes`, async () => {
      const calls = recordFetch()

      await MODEL_FETCHERS[providerType].fetchModels(
        makeConnection({ providerType, baseUrl: `${GATEWAY_BASE_URL}/` }),
        { apiKey: STORED_SNAPSHOT_KEY },
      )

      expect(calls).toHaveLength(1)
    })

    // DA1.3 — the row's own "Reach, measured" paragraph scopes this failure to
    // the `pi_compat` card through `isCompatProvider`. It is wider: these two
    // runtime gateway cards reach the same fetcher through
    // `GatewayRuntimeModelFetcher`, so before this row an absent keychain entry
    // put `Nestor-Token: ''` on the wire for them too.
    it(`${providerType}: with no valid dp creds the gateway URL issues no request either`, async () => {
      const calls = recordFetch()
      rmSync(join(fakeHome, '.nessy'), { recursive: true, force: true })

      const realWarn = console.warn
      console.warn = () => {}
      let result
      try {
        result = await MODEL_FETCHERS[providerType].fetchModels(
          makeConnection({ providerType, baseUrl: GATEWAY_BASE_URL }),
          { apiKey: STORED_SNAPSHOT_KEY },
        )
      } finally {
        console.warn = realWarn
      }

      expect(calls).toEqual([])
      expect(result.models).toEqual([])
    })
  }
})
