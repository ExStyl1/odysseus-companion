/**
 * P3.88 — the `context_length` contract PER BACK END, and an honest surface for
 * the two back ends disagreeing about the same model.
 *
 * ## What was measured, and what it means
 *
 * Measured 2026-08-28 by the controller with an owner-supplied personal
 * llm-proxy key. **That key is not in this repository and must never be**, so
 * everything below runs against a stubbed `fetch` — no credential, no network,
 * no fixture carrying a token.
 *
 * The two URLs are two different systems and each publishes its own field:
 *
 * | Back end | Endpoint | Auth | Window field | Value for `tgpt/qwen35-397b-a17b-fp8` |
 * | --- | --- | --- | --- | --- |
 * | Nestor gateway | `…/api/v1/cli/models` | `Nestor-Token` | `context_window_size` | **262000** — the serving limit |
 * | llm-proxy | `…/models`, `…/v1/models` | `Bearer` | `context_length` | **262144** — 256 x 1024, the architectural window |
 *
 * The 144-token gap is **uniform across the whole two-model shipped pool**, not
 * a one-model quirk. Cross-use fails in every direction (and gateway + a
 * personal `Bearer` answers `HTTP 500`), so neither credential can read the
 * other's catalogue — which is why the two numbers can never be reconciled by
 * asking one endpoint twice.
 *
 * ## The honest surface, and what it is NOT
 *
 * **Neither number is wrong and neither is clamped to the other.** A BYO
 * connection with the user's own llm-proxy key TALKS TO llm-proxy, so 262144 is
 * its serving limit; the gateway card talks to the gateway, so 262000 is its.
 * Clamping across the two would understate a real BYO window on the strength of
 * a different system's answer.
 *
 * What IS resolved downward is the shipped FALLBACK table, where both numbers
 * describe the same gateway session — `mergeSmallerWindow` takes the minimum and
 * `auth/__tests__/nestor.test.ts` pins it. The asymmetry is the reason: an
 * over-stated window runs the session past the real limit before anything
 * compacts (silent), an under-stated one merely compacts early (recoverable).
 *
 * ## Why this file exists at all
 *
 * The per-back-end FIELD contract was implicit: each parser reads the names its
 * own endpoint sends and is blind to the other's, and nothing said so. That is
 * correct today and is exactly the kind of fact that gets "tidied" into a shared
 * chain by someone who has met only one of the two catalogues. Pinned here, in
 * both directions, so a widening is a decision rather than an accident.
 *
 * The owner's 2026-08-28 ruling closes the product question this opened: a
 * personal llm-proxy key is a BYO connection and never a product credential, so
 * no harvested 387-model snapshot ships and no catalogue-enrichment work is
 * owed. The committed snapshot stays the 2-row gateway pool, harvested from the
 * gateway's own endpoint with the card's own credential.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { LlmConnection } from '@nessy-agent/shared/config'
import {
  MIN_PLAUSIBLE_CONTEXT_WINDOW,
  NESTOR_CLI_BASE_PREFIX,
  NESTOR_GATEWAY_MODEL_WINDOWS,
  NESTOR_MODEL_SNAPSHOT_WINDOWS,
} from '@nessy-agent/shared/auth/nestor'
import { NESSY_HOME_ENV } from '@nessy-agent/shared/auth/dp'
import { relatchHomeDirForTests } from '@nessy-agent/shared/config/home-latch'
import { fetchNestorModels } from '../nestor'
import { fetchOpenAiCompatModels } from '../openai-compat'
import { makeTestJwt } from '@nessy-agent/shared/auth/dp/__tests__/test-jwt.ts'

const originalFetch = globalThis.fetch

/**
 * DA1.3 — the gateway parser authenticates from the LIVE dp credentials, so the
 * stub key this file used to hand it is no longer the header. A fabricated JWT
 * under a temp `HOME` keeps the promise this file's own docblock makes — no
 * credential, no network, no fixture carrying a token — and keeps the suite from
 * reading the developer's real creds file.
 *
 * DA1.50 · three segments alone will not do: `getValidCreds` gates on
 * `isUsableJwt`, so the value must DECODE to an object carrying a numeric `exp`.
 * `makeTestJwt` builds one, unsigned and fabricated.
 */
const STUB_LIVE_JWT = makeTestJwt({ preferred_username: 'fixture', sub: 'fixture' })
let fakeHome: string
/**
 * DA1.36 — the latch alone does not isolate this suite. `NESSY_HOME` OUTRANKS
 * the latched home inside the creds resolver (`packages/shared/src/auth/dp/creds-store.ts`
 * symbol `getNessyDir` returns an absolute value verbatim), so a developer with
 * it exported ran these cases against a REAL creds directory. Cleared for the
 * duration, restored below; `delete` first, then assign, on both paths
 * (AGENTS.md §Traps — an assignment to a pre-created slot is invisible to the
 * spread). The discriminating pin for the same hole lives in the sibling
 * `nestor.test.ts`, which is the suite that asserts the header.
 */
let savedNessyHome: string | undefined

beforeEach(() => {
  savedNessyHome = process.env[NESSY_HOME_ENV]
  delete process.env[NESSY_HOME_ENV]
  fakeHome = mkdtempSync(join(tmpdir(), 'nessy-ctxwindow-'))
  relatchHomeDirForTests(fakeHome)
  mkdirSync(join(fakeHome, '.nessy'), { recursive: true })
  writeFileSync(
    join(fakeHome, '.nessy', 'dp_auth_creds.json'),
    JSON.stringify({
      jwt: STUB_LIVE_JWT,
      expiresAt: Date.now() + 60 * 60 * 1000,
      username: 'fixture',
      userId: 'fixture',
    }),
    'utf-8',
  )
})

/** The model both back ends serve, and the one the 144-token gap was measured on. */
const CODER = 'tgpt/qwen35-397b-a17b-fp8'
/** llm-proxy's `context_length` for it — 256 x 1024, the architectural window. */
const ARCHITECTURAL = 262_144
/** The gateway's `context_window_size` for it — the serving limit. */
const SERVING = 262_000

/**
 * A stubbed endpoint. Not a live server and not a recorded credential: the
 * measurement this file encodes was taken with a key that is deliberately absent
 * from the tree, so the only thing reproduced here is the response SHAPE.
 */
function serve(body: unknown, status = 200): Array<{ url: string; headers: Headers }> {
  const calls: Array<{ url: string; headers: Headers }> = []
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), headers: new Headers(init?.headers) })
    return new Response(JSON.stringify(body), { status })
  }) as typeof fetch
  return calls
}

const gatewayConnection: LlmConnection = {
  slug: 'nessy-gateway',
  name: 'Nessy Gateway',
  providerType: 'pi_compat',
  authType: 'api_key_with_endpoint',
  baseUrl: `${NESTOR_CLI_BASE_PREFIX}openai-like/v1`,
  createdAt: 1,
}

const byoConnection: LlmConnection = {
  slug: 'byo-llm-proxy',
  name: 'llm-proxy (my key)',
  providerType: 'pi_compat',
  authType: 'api_key_with_endpoint',
  baseUrl: 'https://llm-proxy.t-tech.team',
  customEndpoint: { api: 'openai-completions' },
  createdAt: 1,
}

/** The window the gateway parser resolves for the first row the stub serves. */
const gatewayWindow = async (): Promise<number | undefined> =>
  (await fetchNestorModels(gatewayConnection)).models[0]?.contextWindow

afterEach(() => {
  globalThis.fetch = originalFetch
  relatchHomeDirForTests()
  rmSync(fakeHome, { recursive: true, force: true })
  delete process.env[NESSY_HOME_ENV]
  if (savedNessyHome !== undefined) process.env[NESSY_HOME_ENV] = savedNessyHome
})

describe('P3.88 · each back end reads its OWN window field and is blind to the other', () => {
  it('the gateway parser reads context_window_size', async () => {
    serve([{ id: CODER, alias: 'coder', context_window_size: SERVING }])
    expect(await gatewayWindow()).toBe(SERVING)
  })

  /**
   * The blindness, stated as a property rather than left implicit. A gateway row
   * carrying llm-proxy's field name is NOT read: the id falls through to the
   * shipped fallback table, which is the correct outcome (that table is the
   * gateway's own harvested value) and NOT the same thing as reading 262144.
   */
  it('the gateway parser does not read llm-proxy\'s context_length', async () => {
    serve([{ id: CODER, alias: 'coder', context_length: ARCHITECTURAL }])
    const fallback = NESTOR_GATEWAY_MODEL_WINDOWS[CODER]
    expect(fallback).toBe(SERVING)
    expect(await gatewayWindow()).toBe(fallback)
    // The load-bearing half: it did not pick up the architectural number.
    expect(await gatewayWindow()).not.toBe(ARCHITECTURAL)
  })

  it('an UNKNOWN gateway id carrying only context_length gets no window at all', async () => {
    serve([{ id: 'tgpt/never-heard-of-it', context_length: ARCHITECTURAL }])
    const result = await fetchNestorModels(gatewayConnection)
    // Not a faked window and not the other back end's number — absent, so the
    // compaction path warns loudly instead of running on an invented figure.
    expect(result.models[0]!.contextWindow).toBeUndefined()
  })

  it('the llm-proxy parser reads context_length', async () => {
    serve({ object: 'list', data: [{ id: CODER, context_length: ARCHITECTURAL }] })
    const result = await fetchOpenAiCompatModels(byoConnection, { apiKey: 'stub-personal-key' })
    expect(result.models[0]!.contextWindow).toBe(ARCHITECTURAL)
  })

  it('the llm-proxy parser does not read the gateway\'s context_window_size', async () => {
    serve({ object: 'list', data: [{ id: CODER, context_window_size: SERVING }] })
    const result = await fetchOpenAiCompatModels(byoConnection, { apiKey: 'stub-personal-key' })
    // No fallback table on this path — a BYO endpoint is not the gateway pool —
    // so an unread field means no window rather than a substituted one.
    expect(result.models[0]!.contextWindow).toBeUndefined()
  })
})

describe('P3.88 · the disagreement itself, and why neither side is clamped', () => {
  /**
   * The same id, the same lane, two connections, two numbers — and both are
   * right. This is the assertion that stops a future reader "fixing" the gap by
   * making one endpoint's answer win globally.
   */
  it('the same model reports 262144 on a BYO llm-proxy connection and 262000 on the gateway card', async () => {
    serve({ object: 'list', data: [{ id: CODER, context_length: ARCHITECTURAL }] })
    const byo = await fetchOpenAiCompatModels(byoConnection, { apiKey: 'stub-personal-key' })

    serve([{ id: CODER, alias: 'coder', context_window_size: SERVING }])
    const gateway = await fetchNestorModels(gatewayConnection)

    expect(byo.models[0]!.contextWindow).toBe(ARCHITECTURAL)
    expect(gateway.models[0]!.contextWindow).toBe(SERVING)
    expect(byo.models[0]!.contextWindow).toBeGreaterThan(gateway.models[0]!.contextWindow!)
    // 262144 is 256 x 1024 exactly, which is what makes it recognisable as an
    // architectural figure rather than a serving one.
    expect(ARCHITECTURAL).toBe(256 * 1024)
  })

  /**
   * Where the two numbers DO describe one session — the shipped fallback for a
   * gateway model — the smaller one wins. Asserted here as well as in
   * `auth/__tests__/nestor.test.ts` because this is the file that explains why
   * the two are not clamped ABOVE, and the two claims are easy to confuse.
   */
  it('the shipped fallback table resolves the gateway disagreement downward', () => {
    // `CODER` here is `tgpt/qwen35-397b-a17b-fp8`, which the gateway retired
    // (P6.1080, 2026-09-11). It is still resolvable, and deliberately: the
    // retired-history half of the merge keeps it at the gateway's own last
    // SERVING limit, because tier two is consulted exactly when the live fetch
    // failed — which is also the only state in which a connection still carries
    // this id as its default. This assertion is that guarantee's witness.
    expect(NESTOR_GATEWAY_MODEL_WINDOWS[CODER]).toBe(SERVING)
    // The tree-wide `<= ARCHITECTURAL` loop this replaces was never the claim it
    // looked like. 262144 is ONE model family's architectural figure, and it
    // held over the whole table only while the shipped pool was two qwen rows.
    // The 2026-09-11 catalogue serves `tgpt/deepseek-v4-flash-0731` at 524000,
    // so the old loop failed on a table that is CORRECT. The invariant that
    // actually survives is per id, against the source that id was merged from.
    // The discriminator is asserted first, unconditionally: the set of ids the
    // snapshot also carries must be non-empty, or the loop below proves nothing
    // (lint:conditional-expect, P6.1080's own gate red).
    const covered = Object.entries(NESTOR_GATEWAY_MODEL_WINDOWS)
      .filter(([id]) => NESTOR_MODEL_SNAPSHOT_WINDOWS[id] !== undefined)
    expect(covered.length, 'no window id is present in the snapshot — the invariant would be vacuous').toBeGreaterThan(0)
    for (const [id, window] of covered) {
      expect(window, `${id} resolved above the window the gateway reported`)
        .toBeLessThanOrEqual(NESTOR_MODEL_SNAPSHOT_WINDOWS[id] as number)
    }
  })
})

describe('P3.88 · one placeholder floor, both back ends', () => {
  /**
   * 63 of llm-proxy's 387 rows carried `context_length <= 1` on 2026-08-28 and
   * two more sat under 1024 — ~17% of the catalogue would poison a naive
   * consumer. The floor is shared (P3.91) and this is the cross-back-end proof:
   * the same value is accepted or refused identically on both paths, so a user's
   * diagnosis no longer depends on which connection they happen to be on.
   */
  it('rejects the "not filled in" sentinel on both paths', async () => {
    serve({ object: 'list', data: [{ id: 'tgpt/classifier-stub', context_length: 1 }] })
    const byo = await fetchOpenAiCompatModels(byoConnection, { apiKey: 'stub-personal-key' })
    expect(byo.models[0]!.contextWindow).toBeUndefined()

    serve([{ id: 'tgpt/classifier-stub', context_window_size: 1 }])
    const gateway = await fetchNestorModels(gatewayConnection)
    expect(gateway.models[0]!.contextWindow).toBeUndefined()
  })

  it('keeps a genuinely small window at the floor on both paths', async () => {
    serve({ object: 'list', data: [{ id: 'tiny/model', context_length: MIN_PLAUSIBLE_CONTEXT_WINDOW }] })
    const byo = await fetchOpenAiCompatModels(byoConnection, { apiKey: 'stub-personal-key' })
    expect(byo.models[0]!.contextWindow).toBe(MIN_PLAUSIBLE_CONTEXT_WINDOW)

    serve([{ id: 'tiny/model', context_window_size: MIN_PLAUSIBLE_CONTEXT_WINDOW }])
    const gateway = await fetchNestorModels(gatewayConnection)
    expect(gateway.models[0]!.contextWindow).toBe(MIN_PLAUSIBLE_CONTEXT_WINDOW)
  })
})

describe('P3.88 · no credential reaches this tree', () => {
  /**
   * The row's standing condition, made mechanical. Every request above is a
   * stub, and neither fetcher invents a credential — the BYO one sends exactly
   * the key its caller handed it, and the gateway one sends exactly the JWT in
   * the creds file, which under this suite's temp `HOME` is fabricated. So a
   * fixture cannot start carrying a real token without this failing.
   */
  it('sends exactly the stub credential, on the header its own back end uses', async () => {
    const gatewayCalls = serve([{ id: CODER, context_window_size: SERVING }])
    await fetchNestorModels(gatewayConnection)
    expect(gatewayCalls[0]!.headers.get('Nestor-Token')).toBe(STUB_LIVE_JWT)
    expect(gatewayCalls[0]!.headers.get('Authorization')).toBeNull()

    const byoCalls = serve({ object: 'list', data: [{ id: CODER, context_length: ARCHITECTURAL }] })
    await fetchOpenAiCompatModels(byoConnection, { apiKey: 'stub-personal-key' })
    expect(byoCalls[0]!.headers.get('Authorization')).toBe('Bearer stub-personal-key')
    expect(byoCalls[0]!.headers.get('Nestor-Token')).toBeNull()
  })
})
