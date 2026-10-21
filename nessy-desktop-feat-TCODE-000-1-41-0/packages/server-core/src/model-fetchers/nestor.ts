import type {
  LlmConnection,
  ModelDefinition,
  ModelFetchResult,
} from '@nessy-agent/shared/config'
// FALLBACK window table for models the live API could not answer for, plus the
// placeholder guard the live parse below runs every reported value through. Both
// are IMPORTED rather than declared because the compaction path
// (`shared/agent/claude-agent.ts`) needs the same table and cannot import
// server-core; a private copy here is a fallback that path could not reach.
import {
  NESTOR_CLI_BASE_PREFIX,
  NESTOR_GATEWAY_MODEL_WINDOWS,
  NESTOR_GATEWAY_MODELS_URL,
  sanitizeReportedContextWindow,
} from '@nessy-agent/shared/auth/nestor'
import { getValidCreds } from '@nessy-agent/shared/auth/dp'
import { handlerLog } from './runtime'

// DA1.27 — the three constants this module used to spell for itself are now
// IMPORTED above. There were two declarations of one boundary deriving in
// OPPOSITE directions: `packages/shared/src/auth/nestor.ts` parses the host out
// of the prefix, and this file wrote the host by hand and built the prefix from
// it. Two hand-written spellings of "which host is the gateway" is the drift
// this tree has already paid for on the URL question (DA1.11 counted five
// implementations of "is this the gateway"), and a fetcher is exactly where a
// silent divergence would send the dp JWT somewhere it does not belong.
//
// Nothing is re-exported, and nothing needed to be. The host constant had NO
// reader outside this file (`git grep -an NESTOR_GATEWAY_HOST`, 2026-09-17:
// every other reader already imports the shared one). The prefix had exactly
// ONE, the sibling `context-window-per-backend.test.ts`, which was already
// importing two other names from the shared module on the line above and now
// takes this one from there too — a re-export would have been a third place the
// same string can be reached from, which is the shape this row removes. The
// catalogue URL is now `NESTOR_GATEWAY_MODELS_URL`, which this file used to
// build a second time from its own prefix.

interface NestorModel {
  id: string
  name?: string
  alias?: string
  desc?: string
  is_default?: boolean
  contextWindow?: number
  context_window?: number
  context_window_tokens?: number
  /**
   * What the gateway actually sends. Measured 2026-08-28 against
   * `GET /api/v1/cli/models` with the `Nestor-Token` the shipped card holds:
   * every row carries `context_window_size`, and NONE of the three names above.
   * The earlier reading — six fields and no context window anywhere in the CLI
   * registry — is refuted; the gateway grew the field, and this parser read past
   * it, so the hard-coded fallback was answering a question the API had started
   * answering itself.
   */
  context_window_size?: number

  /**
   * THE TWO GENERATION FIELDS THE CATALOGUE PUBLISHES, AND ONE IT DOES NOT.
   *
   * Measured live 2026-09-13 by WA-e, `GET /api/v1/cli/models`, 200 over two
   * rows. The union of per-row field names is NINE: `alias`,
   * `context_window_size`, `desc`, `id`, `is_default`, `is_internal`, `name`,
   * `reasoning`, `sampling_params`. So `sampling_params` is on both rows,
   * `reasoning` is on the default `coder` row only (`{"effort":"low"}`), and
   * `extra_body` — which the donor's client reads — is published by NEITHER.
   * `extra_body` therefore still has no member here, and its absence is still a
   * DECISION rather than the parser walking past it: there is nothing to read.
   *
   * THE OTHER TWO ARE NOW READ, AND THE REVERSAL IS AN OWNER DECISION.
   * DA1.16 (2026-09-13) recorded a stated refusal — they are the gateway's
   * RECOMMENDATIONS and not settings it applies, and a turn that sends no effort
   * key comes back with `reasoning_tokens: 0` (three runs), which REFUTED the
   * donor's claim that the server silently bills at the highest effort. That
   * measurement stands. What changed is the posture on top of it: DA1.22, owner
   * decision 2026-09-17, adopts both fields on the gateway cards — native-first,
   * honour the backend's published recommendation — with the cost accepted in
   * the open. THE COST, restated here so it is never re-discovered: on the
   * measured arm the same prompt goes from 0.9 s with no effort key to 12 s with
   * `low`, plus the reasoning tokens, on every turn that takes the default.
   *
   * WHAT THAT COST BUYS AND WHERE IT IS BOUNDED. The effort is applied as a
   * DEFAULT only, never as an override — `codex-responses-adapter`'s
   * `toChatRequest` fills it in only where the caller ASKED for reasoning and
   * named no level, so a runtime that sends an effort keeps its own and a user
   * who turned thinking off stays off. On codex that gap is the ordinary case
   * (the shipped binary sends `{"summary":"auto"}` with no `effort` member when
   * `model_reasoning_effort` is unset — measured against the binary); on the
   * claude runtime it is rare, because `anthropic/inbound.ts` derives an effort
   * from the SDK's own thinking setting whenever thinking is on and omits the
   * whole block when it is off.
   *
   * Also measured, and it settles the adapter question `C4.37` deferred: flat
   * `reasoning_effort` and nested `reasoning.effort` return BYTE-IDENTICAL
   * usage, so `codex-responses-adapter`'s flat mapping is right and the nested
   * form was never being ignored.
   */
  reasoning?: { effort?: unknown }
  sampling_params?: unknown
}

/**
 * A models-endpoint failure that carries its own retryability verdict.
 *
 * MEASURED 2026-08-28 (P3.90): `GET /api/v1/cli/models` answers **HTTP 500
 * Internal Server Error** for a personal llm-proxy key presented as
 * `Authorization: Bearer`, while the same endpoint answers **401** for the CLI
 * token in the wrong header and for a personal key in the right header. The
 * gateway therefore distinguishes *unauthorized* from *unparseable* and crashes
 * on the latter. That is a gateway-side defect and it is NOT ours to fix — the
 * upstream report is the owner's (D19, 2026-09-05) — but it IS ours to handle,
 * because a 5xx is exactly what a backoff treats as transient: this tree's own
 * `agent/backend/nestor-cloud/retry.ts` spends `SERVER_ERROR_MAX_RETRIES` on
 * one. Retried, a pasted wrong credential becomes a slow opaque failure instead
 * of "wrong credential".
 *
 * So on THIS endpoint a 5xx is classified **non-retryable, with a diagnosis**.
 * Only the two codes that genuinely mean "come back later" stay retryable.
 */
export class NestorModelsFetchError extends Error {
  constructor(
    readonly status: number,
    /** `false` for every 5xx here — see the class docstring; a retry cannot help. */
    readonly retryable: boolean,
    /** Present exactly when the status needs a human explanation. */
    readonly diagnosis?: string,
  ) {
    super(`Nestor models fetch failed: ${status}${diagnosis ? ` — ${diagnosis}` : ''}`)
    this.name = 'NestorModelsFetchError'
  }
}

/**
 * The only two statuses on this endpoint that a repeat can fix. Deliberately a
 * closed set rather than "not 5xx": the point of the row is that the status
 * class no longer decides retryability here.
 */
const NESTOR_TRANSIENT_STATUSES: ReadonlySet<number> = new Set([408, 429])

/** The 5xx diagnosis, in the words the measurement supports. */
const NESTOR_UNPARSEABLE_CREDENTIAL_DIAGNOSIS =
  'the gateway answers 5xx for a credential it cannot parse instead of 401, '
  + 'so this is a credential-type failure until proven otherwise, not a transient one; '
  + 'the stale catalogue is kept rather than retried'

export function classifyNestorModelsStatus(status: number): NestorModelsFetchError {
  if (NESTOR_TRANSIENT_STATUSES.has(status)) return new NestorModelsFetchError(status, true)
  if (status >= 500) {
    return new NestorModelsFetchError(status, false, NESTOR_UNPARSEABLE_CREDENTIAL_DIAGNOSIS)
  }
  return new NestorModelsFetchError(status, false)
}

/**
 * D1.222 — is this catalogue failure worth ONE more attempt?
 *
 * The STATUS verdict is {@link NestorModelsFetchError.retryable} and nothing
 * here weakens it: a 5xx stays non-retryable for the reason the class docstring
 * measures (this gateway answers 5xx for a credential it cannot parse), and a
 * 4xx other than 408/429 is an answer, not an accident.
 *
 * What this adds is the arm the status vocabulary cannot see. `fetchNestorModels`
 * throws a `NestorModelsFetchError` only when a RESPONSE arrived; a start with no
 * network reaching the endpoint — DNS, a refused connection, a VPN still coming
 * up, or the request's own 3-second `AbortSignal.timeout` — rejects with
 * something else entirely, so `error instanceof NestorModelsFetchError` is false
 * and the status classifier would call the one failure the row is about "not
 * retryable". A transport failure is not a status; it is the canonical transient.
 *
 * Cost of the wide arm, stated rather than hidden: a genuine programming error
 * inside the fetcher (a shape the parser cannot read) also lands here and buys
 * one extra request. One, once — the caller's ladder is bounded at a single
 * re-fetch per connection per process, so nothing can spin on it.
 */
export function isTransientNestorCatalogueFailure(error: unknown): boolean {
  if (error instanceof NestorModelsFetchError) return error.retryable
  return true
}

export function isNestorConnection(connection: Pick<LlmConnection, 'baseUrl'>): boolean {
  return !!connection.baseUrl?.startsWith(NESTOR_CLI_BASE_PREFIX)
}

/**
 * The gateway catalogue, authenticated from the LIVE dp credentials.
 *
 * DA1.3. The credential used to be the connection's stored key, and that key is
 * a sign-in-time JWT SNAPSHOT with no lifecycle (DA1.13 owns its removal). Two
 * failures followed from reading it here, and a user reads both as *the model
 * list is broken*: a connection whose keychain entry is missing sent
 * `Nestor-Token: ''`, which the gateway answers 401 "token contains an invalid
 * number of segments"; and a connection whose snapshot has expired 401s while
 * the chat turn beside it is healthy, because the turn already authenticates
 * from the live file. Target scheme clause 1 — the credential of record is the
 * JWT in the shared creds file, read live — so this path reads it too.
 *
 * REFUSING BEFORE THE REQUEST IS ISSUED is the point, not an optimisation. An
 * empty or non-JWT header can teach {@link classifyNestorModelsStatus} nothing:
 * the 401 it would earn is a gateway verdict on a credential we never had, and
 * recording it would lose the unparseable-credential diagnosis that classifier
 * exists for. So the skip carries its OWN warn line rather than reusing the
 * fetch-failed one, and returns the empty result `ModelRefreshService._doRefresh`
 * already reads as "no models available from any source" — the same signal
 * `registry.ts`'s `GatewayRuntimeModelFetcher` uses for a non-gateway endpoint,
 * which leaves `connection.models` untouched.
 *
 * SCOPE, and DA1.47 CLOSED the residue this paragraph used to defer. All three
 * gateway cards now arrive through the SAME whole-URL gate: the `pi_compat`
 * card through `model-fetchers/index.ts`'s compat branch, the `claude-runtime`
 * and `codex-runtime` cards through `GatewayRuntimeModelFetcher`. Until that
 * row the compat branch routed on the `…/api/v1/cli/` PREFIX instead, so a BYO
 * `pi_compat` endpoint on another path under that prefix spent the shared dp
 * JWT on the gateway's own catalogue URL and had the gateway's model list
 * written over its own. This comment used to hand that half to DA1.10, whose
 * census had declined this site by name — a deferral to a row that had already
 * declined it, which is what the wave-A review caught.
 *
 * Putting the credential here rather than in either caller is what makes all
 * THREE gateway cards authenticate identically, on both production credential
 * resolvers — the Electron main process and the headless `nessy-server`.
 *
 * The stored per-connection key is deliberately not a parameter any more: a
 * caller that could still pass one would be a second way to authenticate this
 * endpoint, which is the divergence the row exists to close.
 */
export async function fetchNestorModels(
  connection: LlmConnection,
): Promise<ModelFetchResult> {
  const jwt = getValidCreds()?.jwt
  if (!jwt) {
    handlerLog.warn(
      `Model refresh [${connection.slug}]: no valid dp credentials`
      + ' — skipping the Nestor catalogue fetch (no request issued);'
      + ' the persisted model list is kept',
    )
    return { models: [] }
  }

  // llm-gateway-protocol.md:159 — "any redirect is treated as failure so the
  // credential can't leak to a redirect target", with the page's 3-second
  // timeout. Both reject; every caller already treats a throw as
  // keep-the-stale-list failure.
  const res = await fetch(NESTOR_GATEWAY_MODELS_URL, {
    headers: { 'Nestor-Token': jwt },
    redirect: 'error',
    signal: AbortSignal.timeout(3000),
  })

  if (!res.ok) {
    throw classifyNestorModelsStatus(res.status)
  }

  const raw = (await res.json()) as NestorModel[]
  const overrides = new Map<string, Record<string, unknown>>()

  for (const model of connection.models ?? []) {
    if (typeof model === 'object' && model !== null && 'id' in model) {
      overrides.set((model as { id: string }).id, model as unknown as Record<string, unknown>)
    }
  }

  const models = raw.map((model) => {
    // Three tiers, in this order: the window the live API reports, else the
    // shipped fallback table, else absent — an unknown model stays unannotated
    // rather than carrying a faked value, and the compaction path warns loudly.
    const contextWindow = readContextWindow(model) ?? NESTOR_GATEWAY_MODEL_WINDOWS[model.id]
    // DA1.22 — the catalogue's own generation config, on the same side of the
    // spread as the other five server-owned fields. That placement is the
    // decision: these are CATALOGUE FACTS about the model, they are refreshed
    // with the catalogue, and a row that stops publishing one drops it here on
    // the next refresh rather than leaving a stale recommendation behind. Every
    // OTHER user-authored key on a gateway model row still survives a refresh,
    // which is the documented posture DA1.16 re-confirmed.
    const reasoningEffort = readReasoningEffort(model)
    const samplingParams = readSamplingParams(model)
    return {
      ...(overrides.get(model.id) ?? {}),
      id: model.id,
      name: model.alias ? `${model.alias} (${model.id})` : (model.name ?? model.id),
      ...(model.alias ? { shortName: model.alias } : {}),
      ...(model.desc ? { description: model.desc } : {}),
      ...(contextWindow ? { contextWindow } : {}),
      ...(reasoningEffort ? { reasoningEffort } : {}),
      ...(samplingParams ? { samplingParams } : {}),
    }
  }) as ModelDefinition[]

  return {
    models,
    serverDefault: raw.find((model) => model.is_default)?.id,
  }
}

/**
 * The window the live catalogue reports, or `undefined` when it reports none.
 *
 * `??` chains on the raw fields rather than on sanitized ones deliberately: a
 * row that carries a PLACEHOLDER in its real field has not reported a window,
 * and must fall through to the table — not to whichever legacy alias happens to
 * also be present. `sanitizeReportedContextWindow` rejects the `1`/`0`
 * "not filled in" sentinel that both this ecosystem's catalogues use.
 */
/**
 * The effort the row recommends, or `undefined` when it recommends none.
 *
 * DA1.22. NON-EMPTY STRING ONLY, and the type is `unknown` above rather than
 * `string` for the reason every other reader in this file is defensive: the
 * shape has moved twice already (eight field names on 2026-08-28, a `reasoning`
 * block on 2026-09-11), so a row that one day publishes `reasoning: true`, or an
 * effort as a number, must fall through to "no recommendation" instead of
 * putting a non-string on the wire. The VALUE is not validated against a set —
 * the accepted set is the endpoint's own, it states it in its own 400
 * (`literal['none','minimal','low','medium','high','xhigh','max']`, measured
 * 2026-09-03), and narrowing it here would be authoring a policy this parser
 * cannot know.
 */
function readReasoningEffort(model: NestorModel): string | undefined {
  const effort = model.reasoning && typeof model.reasoning === 'object'
    ? (model.reasoning as { effort?: unknown }).effort
    : undefined
  return typeof effort === 'string' && effort.length > 0 ? effort : undefined
}

/**
 * The row's published sampling parameters, or `undefined` when it publishes none.
 *
 * DA1.22. Carried VERBATIM as an object — no key allowlist — because the two
 * consumers both take it verbatim: Pi's `Model.samplingParams` is
 * `Record<string, unknown>` and its OpenAI-compatible adapters merge it into the
 * body as-is, and the loopback adapter spreads it under the caller's own named
 * fields. An allowlist here would silently drop the next key the gateway adds
 * (`top_k` is already one of them, and it reaches the gateway by NO other route
 * — `anthropic/inbound.ts` accepts and drops it for want of a Responses
 * equivalent). Arrays and `null` are rejected: `typeof null === 'object'`.
 */
function readSamplingParams(model: NestorModel): Record<string, unknown> | undefined {
  const raw = model.sampling_params
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
  const entries = Object.entries(raw as Record<string, unknown>)
  return entries.length > 0 ? Object.fromEntries(entries) : undefined
}

function readContextWindow(model: NestorModel): number | undefined {
  const value = model.contextWindow
    ?? model.context_window
    ?? model.context_window_size
    ?? model.context_window_tokens
  return sanitizeReportedContextWindow(value)
}
