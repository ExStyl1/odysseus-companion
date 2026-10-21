import { afterEach, describe, expect, it, setDefaultTimeout } from 'bun:test'
import type { LlmConnection, ModelDefinition } from '@nessy-agent/shared/config'
import { i18n, setupI18n } from '@nessy-agent/shared/i18n'
import { describeModelEol, fetchOpenAiCompatModels, probeOpenAiCompatModel } from '../openai-compat'

const originalFetch = globalThis.fetch

/**
 * D1.110 — a FILE budget with its measurement, and a CORRECTION to the class
 * this file was listed under.
 *
 * **It is NOT a subprocess-import suite.** WI-i's list of six called it one;
 * this file spawns nothing at all — its four imports are static and every case
 * stubs `globalThis.fetch`. What costs is the module graph behind
 * `@nessy-agent/shared/config` and `@nessy-agent/shared/i18n`, and a STATIC
 * top-level import is charged to the file's load and to no per-test timer, which
 * is exactly the case AGENTS.md rule 24 says nothing can notice. So the budget
 * below is NOT protecting a graph paid inside a hook, and saying otherwise would
 * be inheriting a label instead of reading a measurement.
 *
 * MEASURED 2026-09-18, this file ALONE under the test lock, at load 9.9–12.2:
 *
 *   * ZERO-CASE CONTROL (`-t` matching nothing): **17.02 s with 0 cases
 *     executed**, `user 0.66 / sys 0.22` against `real 19.18` — under 5 % cpu,
 *     the I/O regime. The static graph alone is 3.4x bun's 5 s default with
 *     nothing running.
 *   * the full file: **17.19 s** and **17.71 s** on two runs, `user 0.69 /
 *     sys 0.25` against `real 17.81` on the second — so ~96 % of the wall time is
 *     that graph and the cases are almost free.
 *   * per BODY by `--reporter=junit`, the only instrument that separates the two:
 *     every `<testcase>` is at most **6.2 ms**, and the largest describe-level
 *     reading is **1.503 s** (`probeOpenAiCompatModel`).
 *
 * **So what the budget protects is that 1.503 s under contention, and the sizing
 * is that number times this box's own measured spread.** The same bytes of a
 * comparable suite have answered 19x and 39x apart at the same load here
 * (D1.110's three landed files), and 1.503 s × 39 is **58.6 s** — which is why
 * 60 000 rather than a smaller head or a bigger one. It is also the family's
 * existing number (`cron-scheduler`, `user-settings-strict-report`,
 * `session-mirror-settings`), and not inventing a fifth is the point.
 *
 * Not raised to `MODULE_GRAPH_CASE_BUDGET_MS` (300 000): the budgets module's own
 * rule is that sizing UP is a cost, because a hung case has to be heard about.
 * Re-measure before lowering it — a warm reading is not a floor.
 */
setDefaultTimeout(60_000)


function makeConnection(overrides: Partial<LlmConnection> = {}): LlmConnection {
  return {
    slug: 'byo-llm-proxy',
    name: 'llm-proxy',
    providerType: 'pi_compat',
    authType: 'api_key_with_endpoint',
    baseUrl: 'https://llm-proxy.t-tech.team',
    customEndpoint: { api: 'openai-completions' },
    createdAt: 1,
    ...overrides,
  }
}

/** Row shapes recorded live from `GET https://llm-proxy.t-tech.team/models` (C5). */
const LIVE_ROWS = [
  { id: 'tgpt/qwen35-397b-a17b-fp8', context_length: 262144, description: 'Qwen coder', owned_by: 'tgpt' },
  { id: 'anthropic/claude-opus-5', context_length: 1000000, description: 'Opus', owned_by: 'anthropic' },
  { id: 'tgpt/context-intents-summ', context_length: 1, description: 'classifier stub', owned_by: 'tgpt' },
]

function respondWith(body: unknown, status = 200) {
  const calls: Array<{ url: string; auth?: string; redirect?: RequestInit['redirect']; hasSignal: boolean }> = []
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers)
    calls.push({
      url: String(url),
      auth: headers.get('Authorization') ?? undefined,
      redirect: init?.redirect,
      hasSignal: init?.signal instanceof AbortSignal,
    })
    return new Response(JSON.stringify(body), { status })
  }) as typeof fetch
  return calls
}

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('fetchOpenAiCompatModels', () => {
  it('maps a llm-proxy-shaped {data:[...]} payload and sends a Bearer key with redirect+timeout guards', async () => {
    const calls = respondWith({ object: 'list', data: LIVE_ROWS })

    const result = await fetchOpenAiCompatModels(makeConnection(), { apiKey: 'secret-key' })

    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('https://llm-proxy.t-tech.team/models')
    expect(calls[0]!.auth).toBe('Bearer secret-key')
    expect(calls[0]!.redirect).toBe('error')
    expect(calls[0]!.hasSignal).toBe(true)

    expect(result.models.map(m => m.id)).toEqual([
      'tgpt/qwen35-397b-a17b-fp8',
      'anthropic/claude-opus-5',
      'tgpt/context-intents-summ',
    ])
    expect(result.models[0]).toMatchObject({
      id: 'tgpt/qwen35-397b-a17b-fp8',
      name: 'tgpt/qwen35-397b-a17b-fp8',
      description: 'Qwen coder',
      contextWindow: 262144,
    })
    // The endpoint publishes no default.
    expect(result.serverDefault).toBeUndefined()
  })

  it('accepts a bare-array body', async () => {
    respondWith(LIVE_ROWS.slice(0, 1))
    const result = await fetchOpenAiCompatModels(makeConnection(), { apiKey: 'k' })
    expect(result.models.map(m => m.id)).toEqual(['tgpt/qwen35-397b-a17b-fp8'])
  })

  it('sends no Authorization header for a keyless (local) endpoint', async () => {
    const calls = respondWith({ data: LIVE_ROWS })
    await fetchOpenAiCompatModels(
      makeConnection({ baseUrl: 'http://localhost:11434/v1/' }),
      {},
    )
    // Trailing slash trimmed, so the path is never `//models`.
    expect(calls[0]!.url).toBe('http://localhost:11434/v1/models')
    expect(calls[0]!.auth).toBeUndefined()
  })

  it('throws on a non-OK status so the caller keeps its stale list', async () => {
    respondWith({ error: 'nope' }, 401)
    await expect(fetchOpenAiCompatModels(makeConnection(), { apiKey: 'k' })).rejects.toThrow('401')
  })

  it('propagates a redirect rejection rather than following it', async () => {
    globalThis.fetch = (async () => {
      throw new TypeError('unexpected redirect')
    }) as unknown as typeof fetch
    await expect(fetchOpenAiCompatModels(makeConnection(), { apiKey: 'k' })).rejects.toThrow('unexpected redirect')
  })

  it('lets the API replace a stale persisted window while unknown persisted extras survive', async () => {
    respondWith({ data: LIVE_ROWS.slice(0, 1) })
    const persisted = {
      id: 'tgpt/qwen35-397b-a17b-fp8',
      name: 'stale name',
      shortName: 'Qwen',
      description: 'stale description',
      provider: 'pi',
      contextWindow: 131_072,
      supportsImages: true,
    } as unknown as ModelDefinition

    const result = await fetchOpenAiCompatModels(makeConnection({ models: [persisted] }), { apiKey: 'k' })

    expect(result.models[0]).toMatchObject({
      contextWindow: 262144,
      description: 'Qwen coder',
      name: 'tgpt/qwen35-397b-a17b-fp8',
      // Fields the API says nothing about are the user's, and are preserved.
      shortName: 'Qwen',
      supportsImages: true,
    })
  })

  /**
   * P6.482 (owner Q12, 2026-09-05) — the LEARNED stamp is durable across a BYO
   * catalogue refresh, which is one of the row's own done_means clauses.
   *
   * It rides the same spread the case above pins, so this is a pin on a
   * PROPERTY rather than a second mechanism: the point is that a future rewrite
   * of that spread which starts naming fields explicitly would drop the stamp
   * silently, and the user would be asked to re-learn the same refusal on the
   * next turn — the exact loop this row exists to end.
   *
   * Measured while writing it, and worth recording because it makes the clause
   * cheaper than it looks: `MODEL_FETCHERS` (`model-fetchers/registry.ts`) maps
   * only `anthropic`, `pi`, `codex-runtime` and `claude-runtime`, and the two
   * runtime entries share a `GatewayRuntimeModelFetcher` that returns
   * `{ models: [] }` for any NON-gateway base URL — so the scheduled refresh
   * leaves a BYO connection's models untouched entirely. This fetcher is
   * reached from the RPC discovery path instead, which is the surface that can
   * actually rewrite a BYO list, and therefore the one that has to preserve.
   */
  it('a learned image-refusal stamp survives a catalogue refresh', async () => {
    respondWith({ data: LIVE_ROWS.slice(0, 1) })
    const persisted = {
      id: 'tgpt/qwen35-397b-a17b-fp8',
      name: 'stale name',
      shortName: 'Qwen',
      provider: 'pi',
      supportsImages: false,
      supportsImagesLearnedFrom: 'Invalid Chat Message Part: Model Does Not Support Image Inputs',
    } as unknown as ModelDefinition

    const result = await fetchOpenAiCompatModels(makeConnection({ models: [persisted] }), { apiKey: 'k' })

    expect(result.models[0]).toMatchObject({
      supportsImages: false,
      supportsImagesLearnedFrom: 'Invalid Chat Message Part: Model Does Not Support Image Inputs',
    })
  })

  it('keeps a context_length:1 row as a model but writes no window for it', async () => {
    respondWith({ data: LIVE_ROWS })
    const result = await fetchOpenAiCompatModels(makeConnection(), { apiKey: 'k' })

    const classifier = result.models.find(m => m.id === 'tgpt/context-intents-summ')
    // The row survives — `context_length: 1` means "unfilled" upstream, and real
    // chat models carry it.
    expect(classifier).toBeDefined()
    // …but the number never reaches auto-compaction arithmetic.
    expect(classifier?.contextWindow).toBeUndefined()
  })

  it('falls back to the persisted window when the API reports an incredible one', async () => {
    respondWith({ data: [{ id: 'tgpt/context-intents-summ', context_length: 1 }] })
    const persisted = { id: 'tgpt/context-intents-summ', contextWindow: 32_768 } as unknown as ModelDefinition

    const result = await fetchOpenAiCompatModels(makeConnection({ models: [persisted] }), { apiKey: 'k' })

    expect(result.models[0]?.contextWindow).toBe(32_768)
  })
})


/**
 * G2 — the probe's four verdicts, each pinned against the response shape that
 * MEASURED it (2026-08-14, real llm-proxy key). Three of these had already
 * manufactured a false "unavailable".
 */
describe('probeOpenAiCompatModel', () => {
  /** Replies per attempt, in order; records every request body it saw. */
  function replyInTurn(replies: Array<{ status: number; body?: unknown }>) {
    const bodies: Array<Record<string, unknown>> = []
    let attempt = 0
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body ?? '{}')))
      const reply = replies[Math.min(attempt++, replies.length - 1)]!
      return new Response(JSON.stringify(reply.body ?? {}), { status: reply.status })
    }) as typeof fetch
    return bodies
  }

  it('reads a completion as ok', async () => {
    replyInTurn([{ status: 200 }])
    expect(await probeOpenAiCompatModel('https://llm-proxy.t-tech.team', 'k', 'tgpt/qwen35-397b-a17b-fp8'))
      .toEqual({ verdict: 'ok' })
  })

  it('reads 404 quota-not-found as no-quota, not as a failure', async () => {
    replyInTurn([{ status: 404, body: { error: 'quota not found' } }])
    expect(await probeOpenAiCompatModel('https://llm-proxy.t-tech.team', 'k', 'openai/gpt-5'))
      .toEqual({ verdict: 'no-quota' })
  })

  it('ASKS the other wire when chat-completions refuses the protocol', async () => {
    // Every `anthropic/*` id refuses on chat-completions and answers a real
    // completion on /v1/messages. Calling it no-quota told 11 entitled models
    // they were unavailable — the worst answer this probe can give.
    const bodies = replyInTurn([
      { status: 400, body: { error: 'unsupported endpoint' } },
      { status: 200 },
    ])
    expect(await probeOpenAiCompatModel('https://llm-proxy.t-tech.team', 'k', 'anthropic/claude-opus-5'))
      .toEqual({ verdict: 'ok', wire: 'anthropic-messages' })
    // The second request is a REAL Anthropic Messages call, not an inference.
    expect(bodies[1]).toHaveProperty('max_tokens')
  })

  it('does not claim a wire for a model that refuses BOTH', async () => {
    // `gemini/*` refuses chat-completions and does not speak Anthropic Messages
    // either — it has its own Google path. Inferring "not chat, therefore
    // Anthropic" would tell the user gemini runs on the Claude runtime.
    replyInTurn([
      { status: 400, body: { error: 'unsupported endpoint' } },
      { status: 400, body: { error: 'unsupported endpoint' } },
    ])
    expect(await probeOpenAiCompatModel('https://llm-proxy.t-tech.team', 'k', 'gemini/gemini-3-pro'))
      .toEqual({ verdict: 'unsupported-endpoint' })
  })

  it('reports an unentitled anthropic-wire model as no-quota, with no wire', async () => {
    replyInTurn([
      { status: 400, body: { error: 'unsupported endpoint' } },
      { status: 404, body: { error: 'quota not found' } },
    ])
    expect(await probeOpenAiCompatModel('https://llm-proxy.t-tech.team', 'k', 'anthropic/claude-opus-5'))
      .toEqual({ verdict: 'no-quota' })
  })

  it('retries with max_completion_tokens when the model rejects max_tokens', async () => {
    const bodies = replyInTurn([
      { status: 400, body: { error: "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens'." } },
      { status: 200 },
    ])
    expect(await probeOpenAiCompatModel('https://llm-proxy.t-tech.team', 'k', 'azure/o4-mini')).toEqual({ verdict: 'ok' })
    expect(bodies[0]).toHaveProperty('max_tokens')
    expect(bodies[1]).toHaveProperty('max_completion_tokens')
  })

  it('does not retry a 400 that is about something else', async () => {
    // Negative control for the retry above: retrying on status alone would turn
    // an unrelated 400 into a second request and a different verdict.
    const bodies = replyInTurn([{ status: 400, body: { error: 'model is deprecated' } }])
    expect(await probeOpenAiCompatModel('https://llm-proxy.t-tech.team', 'k', 'legacy/model')).toEqual({ verdict: 'error' })
    expect(bodies).toHaveLength(1)
  })

  it('retries a throttle instead of reporting the model unavailable', async () => {
    const bodies = replyInTurn([{ status: 429 }, { status: 200 }])
    expect(await probeOpenAiCompatModel('https://llm-proxy.t-tech.team', 'k', 'tgpt/qwen35-397b-a17b-fp8'))
      .toEqual({ verdict: 'ok' })
    expect(bodies.length).toBeGreaterThan(1)
  })

  it('sends no Authorization header when there is no key (loopback)', async () => {
    let auth: string | null = 'unset'
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      auth = new Headers(init?.headers).get('Authorization')
      return new Response('{}', { status: 200 })
    }) as typeof fetch
    expect(await probeOpenAiCompatModel('http://127.0.0.1:11434/v1', undefined, 'llama3.2')).toEqual({ verdict: 'ok' })
    expect(auth).toBeNull()
  })
})

/**
 * G3 — the 24h metadata sync must not clobber a recorded wire.
 *
 * `GET /models` lists all 386 ids including the anthropic ones, so the sync
 * genuinely re-visits a wired model on every refresh. The merge spreads the
 * PERSISTED entry first and the API fields second, so a field the API never
 * reports survives — this pins that ordering, which is otherwise one keystroke
 * from silently dropping the routing the Claude runtime depends on.
 */
describe('the metadata sync preserves a persisted wire', () => {
  it('keeps `wire` while still refreshing the context window', async () => {
    respondWith({ data: [{ id: 'anthropic/claude-opus-5', context_length: 200_000, description: 'refreshed' }] })
    const persisted = {
      id: 'anthropic/claude-opus-5',
      contextWindow: 8_192,
      wire: 'anthropic-messages',
    } as unknown as ModelDefinition

    const result = await fetchOpenAiCompatModels(makeConnection({ models: [persisted] }), { apiKey: 'k' })

    expect(result.models[0]?.wire).toBe('anthropic-messages')
    // Positive control: the sync did run — the window and description are the
    // API's, not the persisted ones.
    expect(result.models[0]?.contextWindow).toBe(200_000)
    expect(result.models[0]?.description).toBe('refreshed')
  })
})


/**
 * P3.91 — the two sentinel floors, unified.
 *
 * This file used to discard a reported window below 4096 while the gateway path
 * discarded below 1024, neither citing the other, so a genuine 2048 survived one
 * connection and vanished on the other. Both now run through
 * `sanitizeReportedContextWindow`. Latent as measured 2026-08-28 — the llm-proxy
 * catalogue holds no row between the two floors — so these tests are the pin that
 * keeps it from re-diverging silently.
 */
describe('the placeholder floor is the shared one, not a second private floor', () => {
  it('keeps a genuine sub-4096 window instead of throwing it away', async () => {
    respondWith({ data: [{ id: 'tgpt/tiny-but-real', context_length: 2048 }] })
    const result = await fetchOpenAiCompatModels(makeConnection(), { apiKey: 'k' })
    // The old private 4096 dropped this, leaving the row with NO window — the
    // silent no-compaction failure the guard exists to prevent.
    expect(result.models[0]?.contextWindow).toBe(2048)
  })

  it('accepts the floor itself and rejects one token below it', async () => {
    respondWith({ data: [
      { id: 'tgpt/at-floor', context_length: 1024 },
      { id: 'tgpt/below-floor', context_length: 1023 },
    ] })
    const result = await fetchOpenAiCompatModels(makeConnection(), { apiKey: 'k' })
    expect(result.models[0]?.contextWindow).toBe(1024)
    // Below the floor the row survives and the number does not.
    expect(result.models[1]).toBeDefined()
    expect(result.models[1]?.contextWindow).toBeUndefined()
  })
})


/**
 * P3.89 — the catalogue's `eol`, which we read nowhere until now.
 *
 * Readable only here: re-probed 2026-08-28, the shipped gateway card's own
 * `/cli/models` publishes eight fields and `eol` is not one of them, and llm-proxy
 * refuses that card's JWT outright. So every case below is a BYO-connection case.
 */
describe('describeModelEol', () => {
  const NOW = Date.parse('2026-08-28T12:00:00Z')

  it('warns, and says what to do, for a date already past', () => {
    // Live, not hypothetical: this id was past its own EOL in the 2026-08-28 pull.
    expect(describeModelEol('2026-08-03', NOW))
      .toBe('Retired 2026-08-03; it may already be gone — pick another model')
  })

  it('treats the EOL day itself as past rather than as a day of grace', () => {
    expect(describeModelEol('2026-08-28', NOW)).toStartWith('Retired 2026-08-28;')
  })

  it('counts down inside the horizon and only names the date outside it', () => {
    // 30 days is a chosen product default, so both sides of it are pinned: a
    // silent widening or narrowing changes what the user is told and when.
    expect(describeModelEol('2026-09-27', NOW))
      .toBe('Retires 2026-09-27, in 30 days — pick another model before then')
    expect(describeModelEol('2026-09-28', NOW)).toBe('Retires 2026-09-28')
    expect(describeModelEol('2026-08-29', NOW))
      .toBe('Retires 2026-08-29, in 1 day — pick another model before then')
  })

  it('reads a full ISO timestamp by its date prefix', () => {
    expect(describeModelEol('2026-08-03T00:00:00Z', NOW)).toStartWith('Retired 2026-08-03;')
  })

  it('drops everything it cannot read as a date rather than guessing at it', () => {
    // A mis-parsed retirement date is a false alarm on a live model, and a label
    // nobody believes is worse than no label. `YYYY-MM-DD` is the only shape
    // anyone has observed on this field.
    for (const raw of [null, undefined, '', '   ', 'soon', 1_754_179_200_000, '03/08/2026', {}, '2026-8-3']) {
      expect(describeModelEol(raw, NOW), `${JSON.stringify(raw)} should not produce a label`).toBeUndefined()
    }
    // Well-formed but not a real calendar day. `Date.parse` alone does NOT catch
    // this — measured, it rolls 2026-02-31 into March rather than returning NaN,
    // and would have published a retirement date that does not exist. The
    // ISO round trip is what rejects it.
    expect(describeModelEol('2026-02-31', NOW)).toBeUndefined()
    expect(describeModelEol('2026-13-01', NOW)).toBeUndefined()
  })

  it('P3.160 — the notice follows the UI language, and the plural follows the language too', async () => {
    // Every assertion above is an EN assertion, and they all passed before this
    // row as literals. That is the positive control for the wiring: en resolves
    // byte-identically. This case is the one they cannot be — the label was
    // English prose baked into the fetcher, so a Russian user read it in English
    // on the one surface where the warning has to land.
    //
    // The language is process-global, so it is restored in a `finally` rather
    // than in an `afterEach`: a leaked `ru` would silently retranslate every
    // later suite in this process.
    if (!i18n.isInitialized) setupI18n()
    const before = i18n.language
    try {
      await i18n.changeLanguage('ru')
      const past = describeModelEol('2026-08-03', NOW)!
      expect(past).not.toContain('Retired')
      expect(past).toContain('2026-08-03')

      // The hand-written `day${days === 1 ? '' : 's'}` this replaced has no
      // Russian answer: 1 / 3 / 11 days take three different forms, and any two
      // of them being equal would mean the plural family is not being consulted.
      const [one, few, many] = [
        describeModelEol('2026-08-29', NOW)!,
        describeModelEol('2026-08-31', NOW)!,
        describeModelEol('2026-09-08', NOW)!,
      ]
      expect(new Set([one, few, many]).size).toBe(3)
      for (const label of [one, few, many]) expect(label).not.toContain('Retires')
    } finally {
      await i18n.changeLanguage(before)
    }
    // ...and the restore actually restored, or every suite after this one is
    // measuring a different locale than it thinks.
    expect(describeModelEol('2026-08-03', NOW))
      .toBe('Retired 2026-08-03; it may already be gone — pick another model')
  })
})


describe('the retirement notice reaches the surfaces that render a model', () => {
  it('puts the notice IN FRONT of the provider blurb, because the subtitle clips', async () => {
    respondWith({ data: [{ id: 'tgpt/qwen3-235b-a22b', context_length: 262_144, description: 'Qwen', eol: '2026-08-03' }] })
    const result = await fetchOpenAiCompatModels(makeConnection(), { apiKey: 'k' })
    expect(result.models[0]?.description)
      .toBe('Retired 2026-08-03; it may already be gone — pick another model · Qwen')
  })

  it('becomes the whole description when the row carries no blurb', async () => {
    respondWith({ data: [{ id: 'tgpt/bare', eol: '2099-01-01' }] })
    const result = await fetchOpenAiCompatModels(makeConnection(), { apiKey: 'k' })
    expect(result.models[0]?.description).toBe('Retires 2099-01-01')
  })

  it('leaves a row with no eol exactly as it was', async () => {
    respondWith({ data: LIVE_ROWS.slice(0, 1) })
    const result = await fetchOpenAiCompatModels(makeConnection(), { apiKey: 'k' })
    expect(result.models[0]?.description).toBe('Qwen coder')
  })

  it('P3.161 — an explicit null eol is the same answer as an absent one, at the SUBTITLE', async () => {
    // The row asked whether `eol` is ever "null vs absent" and treated the
    // difference as unhandled. It is handled, and this is the level at which it
    // matters: a divergence in the parser is invisible until it reaches the
    // string a picker renders, which is the only thing a user sees.
    respondWith({ data: [{ id: 'tgpt/absent', description: 'Qwen coder' }] })
    const absent = await fetchOpenAiCompatModels(makeConnection(), { apiKey: 'k' })
    respondWith({ data: [{ id: 'tgpt/absent', description: 'Qwen coder', eol: null }] })
    const explicitNull = await fetchOpenAiCompatModels(makeConnection(), { apiKey: 'k' })

    expect(explicitNull.models[0]?.description).toBe(absent.models[0]?.description)
    expect(explicitNull.models[0]?.description).toBe('Qwen coder')
  })

  it('recomposes over a persisted notice instead of stacking a second one', async () => {
    respondWith({ data: [{ id: 'tgpt/qwen3-235b-a22b', description: 'Qwen', eol: '2026-08-03' }] })
    const persisted = {
      id: 'tgpt/qwen3-235b-a22b',
      description: 'Retires 2099-01-01 · Qwen',
    } as unknown as ModelDefinition

    const result = await fetchOpenAiCompatModels(makeConnection({ models: [persisted] }), { apiKey: 'k' })

    expect(result.models[0]?.description)
      .toBe('Retired 2026-08-03; it may already be gone — pick another model · Qwen')
  })
})
