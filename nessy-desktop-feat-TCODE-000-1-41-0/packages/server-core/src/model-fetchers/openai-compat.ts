import type {
  LlmConnection,
  ModelDefinition,
  ModelFetcherCredentials,
  ModelFetchResult,
} from '@nessy-agent/shared/config'
// ONE placeholder floor for both catalogue paths, imported rather than declared —
// see `readContextWindow` for why this file no longer keeps a second one.
import { sanitizeReportedContextWindow } from '@nessy-agent/shared/auth/nestor'
import { i18n, setupI18n } from '@nessy-agent/shared/i18n'

interface OpenAiCompatModel {
  id: string
  description?: string
  context_length?: number
  contextWindow?: number
  context_window?: number
  /**
   * The date the provider says this model goes away. See {@link describeModelEol}
   * for the shape this parses and the shapes it deliberately refuses.
   */
  eol?: string | null
}

/**
 * How far ahead a retirement is worth sharpening the label for, in days.
 *
 * A CHOSEN PRODUCT DEFAULT, labelled as one: nothing measured says 30. It is safe
 * to choose here where P3.32 refused to choose a default context window, and the
 * asymmetry is the whole reason. A wrong window is consumed as arithmetic and
 * breaks a session silently; a wrong horizon only moves the day a visible label
 * changes its wording, and the date itself is shown at every horizon, so a user
 * who wants more notice reads it directly.
 */
const EOL_WARNING_HORIZON_DAYS = 30

const MS_PER_DAY = 86_400_000

/**
 * The label for a catalogue row's `eol`, or `undefined` when it publishes none.
 *
 * WHY THIS EXISTS (P3.89). llm-proxy publishes `eol` on every catalogue row and
 * we read it nowhere, which is not hypothetical: measured 2026-08-28, two rows in
 * the live catalogue were already PAST their own date — `tgpt/qwen3-235b-a22b`
 * (2026-08-03) and `tgpt/qwen3-235b-a22b-instruct-2507` (2026-08-10). Unread, a
 * model that has already been retired is presented exactly like a live one, and
 * the failure arrives as "my session stopped working" with nothing the user can
 * act on.
 *
 * A LABEL, NOT A BLOCKER. The row stays selectable and the notice leads the
 * description, because entitlement and retirement are the provider's call and
 * ours is only to say what it told us. Same honest-degradation register as
 * P3.32's "no context window" warning: name what is wrong and what to do about it.
 *
 * THIS FILE AND NOT `nestor.ts`, MEASURED RATHER THAN ASSUMED. Re-probed
 * 2026-08-28 with the `Nestor-Token` the shipped gateway card actually holds,
 * `GET https://code-completion-nestor.tcsbank.ru/api/v1/cli/models` returns 200
 * over two rows carrying exactly eight field names — `id, name, alias, desc,
 * context_window_size, is_default, is_internal, sampling_params` — and `eol` is
 * not among them; llm-proxy's own `/models` and `/v1/models` answer that same JWT
 * with `401 fail parse token claims: proxy token: missing id claim`. So this
 * signal is readable only on a connection where a user brought their own
 * llm-proxy key, which is this fetcher. The default card cannot see it at all.
 *
 * THE SHAPE IS SECOND-HAND AND THE PARSER SAYS SO. The two dates above were read
 * with a personal llm-proxy key this lane does not hold, so `YYYY-MM-DD` is the
 * only form anyone has OBSERVED. Every other shape is nevertheless DECIDED here
 * rather than left to chance, and the decision is not one rule but two:
 *
 * - A leading `YYYY-MM-DD` is READ BY ITS PREFIX, so a full ISO timestamp
 *   (`2026-08-03T00:00:00Z`) yields the same label as the bare date. The regex
 *   is deliberately not anchored at the end for exactly this.
 * - Everything else is DROPPED rather than guessed at — a null, an absent field,
 *   an empty or whitespace string, an epoch number, a locale string, a
 *   non-string, a zero-padded-less `2026-8-3`, and a well-formed but impossible
 *   calendar date — because a mis-parsed retirement date is a false alarm on a
 *   live model, and a label nobody believes is worse than no label.
 *
 * P3.161 asked whether the unseen variants were "unhandled by construction" and
 * whether closing it needed a personal key. Measured at HEAD 2026-09-03: no on
 * both counts. Each shape above is already decided AND pinned in
 * `__tests__/openai-compat.test.ts`, `null` and absent resolve identically, and
 * a timestamp was already handled — this paragraph was the only thing that said
 * otherwise, by listing what is dropped and omitting what is accepted. What a
 * key would settle is which shapes llm-proxy actually EMITS, which is a fact
 * about the server and cannot change any behaviour here.
 *
 * THREE FIELDS ON THE SAME ROW ARE STILL READ BY NOTHING, and that is a real
 * null rather than a decided one: `max_tpm`, `default_tpm` and
 * `criticality_level` appear NOWHERE in this tree (`git grep -a`, with
 * `context_length` as the positive control on the same command). Reading them
 * needs the same personal key, and nothing here depends on them today.
 */
export function describeModelEol(raw: unknown, nowMs: number): string | undefined {
  if (typeof raw !== 'string') return undefined
  const date = /^\d{4}-\d{2}-\d{2}/.exec(raw.trim())?.[0]
  if (!date) return undefined
  const at = Date.parse(`${date}T00:00:00Z`)
  if (!Number.isFinite(at)) return undefined
  // The round trip is the calendar check, and it is NOT redundant with the
  // regex: measured on this runtime, `Date.parse('2026-02-31T00:00:00Z')` does
  // not return NaN — it rolls the day over into March and would have published
  // "Retired 2026-02-31", a date that does not exist, as a retirement notice.
  if (new Date(at).toISOString().slice(0, 10) !== date) return undefined

  // P3.160 — THE LABEL IS TRANSLATED, and the lookup is here rather than at the
  // render site on purpose: this string is not shown as a field of its own, it
  // is spliced into `description` by {@link describeModel}, and `description` is
  // a plain string on the wire that every picker renders verbatim. So there is
  // no renderer that could translate it later, and the alternative — a typed
  // field plus a badge of its own, which is the durable shape P3.89 named — is a
  // wire change this row deliberately does not make.
  //
  // The `if (!i18n.isInitialized)` guard is `SessionManager`'s idiom, and it is
  // needed for the same reason: a model catalogue is fetched at startup, and
  // this package is loaded by the headless server and the electron main process
  // alike, only one of which has already called `setupI18n()` by then.
  //
  // The day count goes through i18next's plural rules rather than the
  // hand-written `day${days === 1 ? '' : 's'}` this replaced — that spelling is
  // the manual `count === 1 ?` the i18n rules forbid, and Russian needs four
  // forms where it offered two.
  if (!i18n.isInitialized) setupI18n()
  if (at <= nowMs) return i18n.t('model.eolRetired', { date })
  const days = Math.ceil((at - nowMs) / MS_PER_DAY)
  if (days <= EOL_WARNING_HORIZON_DAYS) {
    return i18n.t('model.eolRetiresSoon', { date, count: days })
  }
  return i18n.t('model.eolRetires', { date })
}

/**
 * The subtitle the model pickers render, with any retirement notice IN FRONT.
 *
 * The notice leads rather than trails because the surfaces that show this field
 * clip it: `ModelCatalogPicker` renders it as a one-line `subtitle`, and the two
 * composer selectors fall back to it whenever a model carries no `descriptionKey`,
 * which is every BYO model. A warning appended after a long provider blurb is a
 * warning nobody sees.
 */
function describeModel(model: OpenAiCompatModel, nowMs: number): string | undefined {
  const notice = describeModelEol(model.eol, nowMs)
  const description = model.description?.trim() || undefined
  if (!notice) return description
  return description ? `${notice} · ${description}` : notice
}

/**
 * Model catalog for an OpenAI-compatible endpoint: `GET {baseUrl}/models`.
 *
 * What comes back is a CATALOG, not an entitlement list — llm-proxy publishes
 * every model it knows about, and a given key reaches a fraction of them. The
 * caller decides what to keep.
 */
export async function fetchOpenAiCompatModels(
  connection: LlmConnection,
  credentials: ModelFetcherCredentials,
): Promise<ModelFetchResult> {
  const baseUrl = (connection.baseUrl ?? '').replace(/\/+$/, '')
  if (!baseUrl) throw new Error('OpenAI-compatible models fetch failed: no baseUrl')

  // Same safety posture as the Nestor fetcher: any redirect is a failure so the
  // credential cannot leak to a redirect target, and a 3s cap so a hung
  // endpoint cannot stall startup. A throw means "keep the stale list".
  const res = await fetch(`${baseUrl}/models`, {
    // A local endpoint (Ollama) serves this unauthenticated — send the header
    // only when there is a key, rather than an empty Bearer.
    headers: credentials.apiKey ? { Authorization: `Bearer ${credentials.apiKey}` } : {},
    redirect: 'error',
    signal: AbortSignal.timeout(3000),
  })

  if (!res.ok) {
    throw new Error(`OpenAI-compatible models fetch failed: ${res.status}`)
  }

  const body = (await res.json()) as { data?: OpenAiCompatModel[] } | OpenAiCompatModel[]
  const raw = Array.isArray(body) ? body : (body?.data ?? [])

  const overrides = new Map<string, Record<string, unknown>>()
  for (const model of connection.models ?? []) {
    if (typeof model === 'object' && model !== null && 'id' in model) {
      overrides.set((model as { id: string }).id, model as unknown as Record<string, unknown>)
    }
  }

  const now = Date.now()
  const models = raw
    .filter((model) => typeof model?.id === 'string' && model.id.length > 0)
    .map((model) => {
      const contextWindow = readContextWindow(model)
      const description = describeModel(model, now)
      return {
        // Persisted fields first, API fields after: a stale local window must
        // never win over what the endpoint just reported — and neither must a
        // retirement notice composed on an earlier refresh.
        ...(overrides.get(model.id) ?? {}),
        id: model.id,
        name: model.id,
        ...(description ? { description } : {}),
        ...(contextWindow ? { contextWindow } : {}),
      }
    }) as ModelDefinition[]

  // The endpoint publishes no default.
  return { models }
}

/**
 * Does this key actually reach this model, over THIS wire?
 *
 * The catalog is a global directory: on a real llm-proxy key, 306 of 383
 * published ids answered `quota not found` — measured 2026-08-14, and DATED
 * because the catalogue moves weekly (it was 387 rows by 2026-08-28). The ratio
 * is the durable part; the counts are a reading, not a standing fact. One cheap
 * non-streaming completion is the only way to tell.
 *
 * G2 probes the WHOLE catalog rather than the selection, so the form can group
 * by availability instead of asking the user to guess and then check. That is
 * only affordable because the caller chunks it (~8 ids at a time, sequential
 * chunks) — this function stays one request per id, and the handler must never
 * be handed the full list at once: its `Promise.all` is unbounded and 386
 * simultaneous sockets is a self-inflicted 429 storm.
 *
 * THREE THINGS THIS LEARNED FROM MEASUREMENT (2026-08-14, real llm-proxy key),
 * each of which had manufactured a false "unavailable":
 *
 * 1. `400 unsupported endpoint` is a PROTOCOL verdict, not an entitlement one.
 *    Every `anthropic/*` id answers it on chat-completions and answers a real
 *    completion on `/v1/messages`. Reporting those 11 entitled models as
 *    unavailable is the single worst answer this probe can give.
 *
 *    G3 goes one step further and ASKS the other wire instead of inferring it.
 *    That distinction matters: `gemini/*` also answers `unsupported endpoint`
 *    here and does NOT speak Anthropic Messages — it has its own Google path.
 *    Inferring "not chat-completions, therefore Anthropic" would have told the
 *    user gemini works on the Claude runtime, which is a worse lie than the one
 *    this replaced. So the second probe is a real request, and only a real
 *    answer sets `wire`.
 * 2. `azure/o4-mini` rejects `max_tokens` outright and needs
 *    `max_completion_tokens`. One retry on that error shape, or the model reads
 *    as broken.
 * 3. A burst-throttled `429` says nothing about the model. Retry with backoff;
 *    never let it reach the grouping.
 *
 * Deliberately not `testBackendConnection`: that spawns an agent subprocess on
 * a 45s budget, which is the wrong vehicle for a one-token probe.
 */
export type ProbeVerdict = 'ok' | 'no-quota' | 'unsupported-endpoint' | 'error'

export interface ModelProbe {
  verdict: ProbeVerdict
  /** Set only when the model answered on a wire OTHER than chat-completions. */
  wire?: 'anthropic-messages'
}

export async function probeOpenAiCompatModel(
  baseUrl: string,
  apiKey: string | undefined,
  modelId: string,
): Promise<ModelProbe> {
  const url = `${baseUrl.replace(/\/+$/, '')}/chat/completions`

  const attempt = async (tokenField: 'max_tokens' | 'max_completion_tokens') => {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: modelId,
        messages: [{ role: 'user', content: 'hi' }],
        [tokenField]: 1,
        stream: false,
      }),
      redirect: 'error',
      signal: AbortSignal.timeout(10000),
    })
    // The body is read only on failure, and only to classify it — a 400 from
    // llm-proxy carries the whole verdict in `{"error":"..."}`.
    const body = res.ok ? '' : await res.text().catch(() => '')
    return { status: res.status, ok: res.ok, body }
  }

  try {
    let result = await attempt('max_tokens')

    // (2) The token-field retry. Matched on the message rather than on the
    // status alone: a 400 that does NOT mention the field is a different
    // failure and must not be retried into a false verdict.
    if (!result.ok && result.status === 400 && /max_tokens/i.test(result.body)) {
      result = await attempt('max_completion_tokens')
    }

    // (3) The throttle retry. Two attempts, widely spaced — the caller is
    // already chunking, so this only has to absorb a burst edge.
    for (let i = 0; i < 2 && !result.ok && result.status === 429; i++) {
      await new Promise(resolve => setTimeout(resolve, 1500 * (i + 1)))
      result = await attempt('max_tokens')
    }

    if (result.ok) return { verdict: 'ok' }
    // (1) Protocol, not entitlement — so ask the other protocol.
    if (result.status === 400 && /unsupported endpoint/i.test(result.body)) {
      return await probeAnthropicWire(baseUrl, apiKey, modelId)
    }
    // llm-proxy answers an unentitled model with 404 `quota not found`; every
    // other status is a real failure the user should read as such.
    if (result.status === 404) return { verdict: 'no-quota' }
    return { verdict: 'error' }
  } catch {
    return { verdict: 'error' }
  }
}

/**
 * The second wire: `POST {base}/v1/messages`, Anthropic Messages.
 *
 * Reached only from the `unsupported endpoint` branch above, so it answers one
 * question — "does this model work at all, just not there?" — and its answer is
 * what the Claude runtime routes on later. An entitlement failure here is a
 * plain `no-quota`: the model is real and this key cannot reach it either way.
 */
async function probeAnthropicWire(
  baseUrl: string,
  apiKey: string | undefined,
  modelId: string,
): Promise<ModelProbe> {
  try {
    const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'anthropic-version': '2023-06-01',
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: modelId,
        max_tokens: 1,
        messages: [{ role: 'user', content: 'hi' }],
      }),
      redirect: 'error',
      signal: AbortSignal.timeout(10000),
    })
    if (res.ok) return { verdict: 'ok', wire: 'anthropic-messages' }
    if (res.status === 404) return { verdict: 'no-quota' }
    // Neither wire serves it. `gemini/*` lands here, which is the honest answer:
    // it is published, it is not reachable from this connection, and naming a
    // wire for it would be an invention.
    return { verdict: 'unsupported-endpoint' }
  } catch {
    return { verdict: 'error' }
  }
}

/**
 * The window the catalogue reports, or `undefined` when it reports a placeholder.
 *
 * ONE FLOOR, SHARED WITH THE GATEWAY PATH (P3.91). This file used to declare a
 * private `MIN_CREDIBLE_CONTEXT_WINDOW = 4096` while `auth/nestor.ts` guarded the
 * same sentinel at `MIN_PLAUSIBLE_CONTEXT_WINDOW = 1024`, and neither cited the
 * other — so a model with a genuine 2048-token window was kept on the gateway
 * path and thrown away here, and a user's diagnosis differed by which connection
 * they happened to be on.
 *
 * UNIFIED DOWNWARD, FOR A REASON RATHER THAN A PREFERENCE. Both floors reject the
 * only placeholders anyone has observed (`0` and `1`), so they can only differ on
 * a genuinely small window — and there the lower floor is strictly better: a real
 * 2048 kept compacts at 2048, while a real 2048 dropped leaves the row with no
 * window at all, which is the silent no-compaction failure this guard exists to
 * prevent (and on the Pi path something worse, since P3.79 stamps 131 072 over
 * the hole). `auth/nestor.ts` carries the written reasoning for 1024; the 4096
 * this replaces never carried any.
 *
 * Latent either way as of 2026-08-28: the llm-proxy catalogue holds no row
 * between the two floors.
 */
function readContextWindow(model: OpenAiCompatModel): number | undefined {
  const value = model.context_length ?? model.contextWindow ?? model.context_window
  return sanitizeReportedContextWindow(value)
}
