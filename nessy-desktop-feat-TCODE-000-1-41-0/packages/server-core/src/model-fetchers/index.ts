/**
 * Model Refresh Service
 *
 * Centralized service for fetching and refreshing model lists across all providers.
 * Replaces the scattered fetchAndStore*Models() functions and startCodexModelRefresh().
 *
 * Fallback chain (same for every provider):
 * 1. Provider runtime discovery via backend driver dispatch
 * 2. Persisted connection.models — previously fetched, survives offline/restart
 * 3. MODEL_REGISTRY — hardcoded offline seed data, last resort
 */

import type { ModelFetcherMap, ModelFetcherCredentials, FetchableProvider } from '@nessy-agent/shared/config'
import type { LlmConnection, ModelDefinition } from '@nessy-agent/shared/config'
import {
  getLlmConnections,
  getLlmConnection,
  updateLlmConnection,
  isCompatProvider,
  isAdapterRuntimeProvider,
  getModelsForProviderType,
  resolveGatewayCoderModelId,
} from '@nessy-agent/shared/config'
import { isNessyGatewayBaseUrl } from '@nessy-agent/shared/agent/backend'
import { MODEL_FETCHERS } from './registry'
import { handlerLog } from './runtime'
import { fetchNestorModels, isNestorConnection, isTransientNestorCatalogueFailure } from './nestor'
import { fetchOpenAiCompatModels } from './openai-compat'

/** Copilot models are server-managed — refresh every 10 minutes to pick up policy changes. */
const COPILOT_REFRESH_INTERVAL_MS = 10 * 60 * 1000

/**
 * At most one catalog fetch per day for an enrolled BYO endpoint. The refresh
 * runs at startup only (no timer), so this is what keeps a restart-heavy day
 * from hammering someone else's endpoint. The Nestor path has no TTL — its
 * cadence is existing product behavior.
 */
const MODEL_SYNC_TTL_MS = 24 * 60 * 60 * 1000

/**
 * D1.222 — how long the ONE bounded re-fetch waits after a transient gateway
 * catalogue failure.
 *
 * This is the lane's own choice and it is written down as one, because
 * read-don't-invent found nothing to read: the gateway publishes no retry
 * cadence for `/cli/models`, the two retryable statuses (408, 429) arrive with
 * no `Retry-After` this fetcher reads, and the request's own budget is the
 * 3-second `AbortSignal.timeout` the protocol page specifies — a bound on ONE
 * attempt, not a cadence between two.
 *
 * 30 s is picked to be long enough that the boot-time transient this row is
 * about (an interface still coming up, a VPN still connecting) has plausibly
 * cleared, and short enough that the second attempt lands well inside a first
 * session rather than after the user has already sent a turn against the stale
 * default. It is deliberately not a ladder: one attempt, then silence until the
 * next launch, which is the behaviour the not-retryable arm keeps for everyone.
 */
const NESTOR_TRANSIENT_RETRY_DELAY_MS = 30_000

/**
 * A connection is enrolled in metadata sync when the form stamped it (the
 * toggle writes/clears `modelsSyncedAt`). `modelSelectionMode` is deliberately
 * NOT consulted: a hand-pruned list still means `userDefined3Tier`, and reading
 * it here would enroll connections the user never opted in.
 *
 * TWO SHAPES qualify, and the stamp is required for both:
 *
 * - A Pi custom endpoint (`pi_compat`) speaking `openai-completions`. Only that
 *   protocol: an Anthropic-shaped `/v1/models` returns
 *   `{data:[{id, display_name, created_at}]}` with no context length, so there
 *   would be nothing to merge.
 * - A BYO adapter-runtime connection (`codex-runtime` / `claude-runtime`)
 *   pointed at the user's own endpoint. Those never carry a `customEndpoint` —
 *   emitting one would rewrite them to `pi_compat` and kill the local adapter —
 *   so the protocol cannot be read off the connection, and the runtime pair is
 *   itself the marker: both adapters speak to an OpenAI-compatible upstream
 *   (`UpstreamTarget` is `{nestor, openai-compatible}` and nothing else).
 *
 * The gateway one-click connections are excluded by URL. Belt and braces: no
 * stamp is ever written for them, so the `modelsSyncedAt` test alone would
 * already refuse — but the gateway has its own fetcher with its own cadence,
 * and an enrollment that reached it would have this path and that one both
 * writing the same list. `isNessyGatewayBaseUrl` is the WHOLE-URL matcher
 * (`agent/backend/internal/drivers/upstream-target.ts`), not the
 * prefix-tolerant `isNestorGatewayUrl` — prefix matching is exactly the hole
 * `registry.ts`'s docstring warns about, and it lives in a package this one
 * cannot import anyway.
 */
function isModelSyncEnrolled(
  connection: Pick<LlmConnection, 'providerType' | 'customEndpoint' | 'modelsSyncedAt' | 'baseUrl'>,
): boolean {
  if (typeof connection.modelsSyncedAt !== 'number') return false
  if (connection.providerType === 'pi_compat') {
    return connection.customEndpoint?.api === 'openai-completions'
  }
  return isAdapterRuntimeProvider(connection.providerType)
    && !isNessyGatewayBaseUrl(connection.baseUrl)
}

function isModelSyncFresh(connection: Pick<LlmConnection, 'modelsSyncedAt'>): boolean {
  const stamp = connection.modelsSyncedAt
  return typeof stamp === 'number' && Date.now() - stamp < MODEL_SYNC_TTL_MS
}

/**
 * The backend owns metadata; the user owns the selection.
 *
 * So this is a KEYED MERGE, not the replace the other providers do: catalog
 * rows the user did not pick are ignored (a 383-row catalog must never land in
 * `connection.models`), and picked ids that vanished upstream are kept rather
 * than deleted, so a running session cannot lose its model mid-flight. String
 * entries carry no metadata and pass through untouched.
 *
 * `name` is not merged: this fetcher derives it from the id, so writing it
 * could only either be a no-op or clobber a name the user chose.
 */
function mergeModelMetadata(
  persisted: NonNullable<LlmConnection['models']>,
  fetched: ModelDefinition[],
): NonNullable<LlmConnection['models']> {
  const byId = new Map(fetched.map(model => [model.id, model]))
  return persisted.map((entry) => {
    if (typeof entry !== 'object' || entry === null || !('id' in entry)) return entry
    const upstream = byId.get(entry.id)
    // D1.162 — the PER-ENTRY half of the picker's provenance label. This merge
    // is the one place that knows, per id, whether the endpoint's own catalogue
    // still lists it: a row it dropped is KEPT (so a running session cannot lose
    // its model) and was until now indistinguishable from one the endpoint just
    // confirmed. Stamped on both arms so the field is total for a synced
    // connection — a missing value means "never synced", never "not listed".
    if (!upstream) return { ...entry, catalogueListed: false }
    return {
      ...entry,
      catalogueListed: true,
      ...(upstream.contextWindow ? { contextWindow: upstream.contextWindow } : {}),
      ...(upstream.description ? { description: upstream.description } : {}),
    }
  })
}

/**
 * P6.1080 — a default model the endpoint retired, and the model that answers
 * instead, so a SESSION can say it out loud.
 *
 * The substitution happens here, at startup, before any session exists, and it
 * is otherwise invisible end to end: `_doRefresh` rewrites `connection.defaultModel`,
 * `resolveModelForProvider` clears the session's own stale model before
 * `SessionManager.warnIfModelIdUnrecognized` gets to read `resolvedModel`, and
 * no layer in between has a user to talk to. So the fact is parked here and the
 * session drains it beside that existing diagnostic — the same host-side seam,
 * which means the line reads identically on Pi, Claude and Codex rather than
 * being written three times.
 *
 * PEEKED, not taken: the latch belongs to the session (one line per session, the
 * `queueDegradationNotice` rule), so consuming it here would tell the first
 * session and silently skip every later one. It is instead dropped by the reader
 * once it stops describing the connection — the user picking a model of their
 * own makes this history, and history is not a warning.
 *
 * In memory on purpose. It describes one process's startup refresh; persisting
 * it would mean deciding when a warning expires, which is the question this
 * shape avoids having to answer.
 */
export interface ModelDefaultSubstitution {
  /** The connection whose stored default the endpoint no longer serves. */
  readonly slug: string
  /** The id that was stored — the one that would have produced the failure. */
  readonly from: string
  /** The id that answers now, and how it was chosen. */
  readonly to: string
  /** Which tier of `_doRefresh`'s chain picked `to`. */
  readonly via: 'catalogue-default' | 'coder-alias' | 'first-model'
}

const modelDefaultSubstitutions = new Map<string, ModelDefaultSubstitution>()

/**
 * Publish the fact that `slug`'s stored default was replaced.
 *
 * Exported rather than private because the reader is exported and the pair is
 * the contract: any refresh path that substitutes a default owes this call, and
 * a second such path (a manual re-fetch, a future provider) must be able to make
 * it without reaching inside this module. It is also what lets the SESSION half
 * of the behaviour be tested where `SessionManager` already lives, instead of
 * mocking this module into the one test file that imports both.
 */
export function recordModelDefaultSubstitution(
  slug: string,
  from: string,
  to: string,
  via: ModelDefaultSubstitution['via'],
): void {
  modelDefaultSubstitutions.set(slug, { slug, from, to, via })
  // Machine-readable first, exactly as `warnIfModelIdUnrecognized` does it: the
  // log is what a support thread greps, the session line is what the user reads.
  handlerLog.warn(
    `Model refresh [${slug}]: stored default ${from} is not in the fetched catalogue`
    + ` — substituted ${to} (via ${via})`,
  )
}

/**
 * The substitution recorded for `slug`, or `undefined` — see
 * {@link ModelDefaultSubstitution} for why this peeks rather than takes.
 */
export function peekModelDefaultSubstitution(slug: string): ModelDefaultSubstitution | undefined {
  return modelDefaultSubstitutions.get(slug)
}

/**
 * Forget the substitution for `slug`. Called by the reader once the connection's
 * default no longer matches what was substituted — the user chose for
 * themselves, so there is nothing left to warn about.
 */
export function forgetModelDefaultSubstitution(slug: string): void {
  modelDefaultSubstitutions.delete(slug)
}

// ============================================================
// Types
// ============================================================

type CredentialResolver = (slug: string) => Promise<ModelFetcherCredentials>

// ============================================================
// ModelRefreshService
// ============================================================

class ModelRefreshService {
  private timers = new Map<string, ReturnType<typeof setInterval>>()
  private inFlight = new Map<string, Promise<void>>()
  /** D1.222 — the pending single re-fetch per slug, so `stopAll` can cancel it. */
  private retryTimers = new Map<string, ReturnType<typeof setTimeout>>()
  /** D1.222 — slugs that have already SPENT their one retry in this process. */
  private retriedSlugs = new Set<string>()

  constructor(
    private fetchers: ModelFetcherMap,
    private getCredentials: CredentialResolver,
  ) {}

  /**
   * Fetch models for a connection through the fallback chain.
   * Deduplicates concurrent calls for the same slug — if a refresh is already
   * in progress, callers share the same promise instead of racing.
   */
  async refreshConnection(slug: string): Promise<void> {
    const existing = this.inFlight.get(slug)
    if (existing) return existing

    const promise = this._doRefresh(slug).finally(() => {
      this.inFlight.delete(slug)
    })
    this.inFlight.set(slug, promise)
    return promise
  }

  /**
   * Internal: actual refresh logic with fallback chain.
   * Skips compat providers (not in fetcher map).
   * Preserves user's defaultModel if still valid.
   * Updates connection.models in storage on success.
   */
  /**
   * The enrolled-connection metadata refresh, shared by both shapes that reach
   * it — a `pi_compat` custom endpoint and a BYO adapter-runtime connection.
   *
   * One body on purpose: the two callers differ only in how they were routed
   * here, and a copy would be the kind of divergence that has already cost this
   * repo twice (the two install channels, the two source-removal channels).
   */
  private async refreshEnrolledMetadata(slug: string, connection: LlmConnection): Promise<void> {
    if (isModelSyncFresh(connection)) {
      handlerLog.info(`Model refresh [${slug}]: BYO metadata synced within ${MODEL_SYNC_TTL_MS}ms — skipping`)
      return
    }
    try {
      const credentials = await this.getCredentials(slug)
      const result = await fetchOpenAiCompatModels(connection, credentials)
      const merged = mergeModelMetadata(connection.models ?? [], result.models)
      // Merge, never replace: the id set is the user's, the metadata is the
      // endpoint's. Neither `defaultModel` nor `modelSelectionMode` is touched.
      updateLlmConnection(slug, { models: merged, modelsSyncedAt: Date.now() })
      handlerLog.info(`Model refresh [${slug}]: merged metadata for ${merged.length} selected models from ${result.models.length} catalog rows`)
    } catch (error) {
      // Keep the stale list AND the stale timestamp, so the next startup retries.
      const msg = error instanceof Error ? error.message : String(error)
      handlerLog.warn(`Model refresh [${slug}]: BYO metadata fetch failed: ${msg}`)
    }
  }

  private async _doRefresh(slug: string): Promise<void> {
    const connection = getLlmConnection(slug)
    if (!connection) {
      handlerLog.warn(`Model refresh: connection not found: ${slug}`)
      return
    }
    if (connection.providerType === 'nestor-cloud-agent') {
      return
    }

    let newModels: ModelDefinition[] | null = null
    let serverDefault: string | undefined
    let providerType: FetchableProvider | undefined

    // An ENROLLED adapter-runtime connection takes the merge path, and it has
    // to be decided BEFORE the compat/else split below: `codex-runtime` and
    // `claude-runtime` are not compat providers, so the split would hand them
    // to `this.fetchers[providerType]` — the gateway fetcher — which REPLACES
    // the model list from a gateway this connection does not point at.
    // `isModelSyncEnrolled` has already excluded the one-click gateway
    // connections by URL, so what reaches here is a user's own endpoint.
    if (isAdapterRuntimeProvider(connection.providerType) && isModelSyncEnrolled(connection)) {
      await this.refreshEnrolledMetadata(slug, connection)
      return
    }

    // Compat providers are user-configured, except the built-in Nessy Gateway
    // preset, which exposes a scoped Nestor models endpoint.
    //
    // DA1.47 — the gate is {@link isNessyGatewayBaseUrl}, the WHOLE-URL match,
    // and NOT `isNestorConnection`'s `…/api/v1/cli/` prefix match. That is the
    // same correction `GatewayRuntimeModelFetcher` already carries for the two
    // adapter-runtime cards, and the `pi_compat` route was the half of it that
    // had not landed: a BYO `pi_compat` endpoint on another path under the CLI
    // prefix passed the prefix test, so this branch spent the shared dp JWT on
    // the GATEWAY's own catalogue URL and then wrote the gateway's model list
    // over the user's own — the same defect, on the same file, that the runtime
    // path's docblock describes as "overwrote their catalog with the gateway's".
    // DA1.10's census declined this site by name (it was narrowing the
    // CREDENTIAL predicates, not the fetcher router) and the fetcher's §SCOPE
    // comment deferred to it, which is the double deferral the review caught.
    //
    // `isNestorConnection` itself stays wide, deliberately: its two other
    // callers (`startAll`, `refreshNow`) use it to STOP before the timer block,
    // and narrowing it there would hand a BYO prefix connection an hourly timer
    // whose every tick is a no-op. The router is the only caller that decides
    // where a credential goes, so the router is the only one narrowed.
    if (isCompatProvider(connection.providerType)) {
      if (!isNessyGatewayBaseUrl(connection.baseUrl)) {
        if (!isModelSyncEnrolled(connection)) return
        await this.refreshEnrolledMetadata(slug, connection)
        return
      }

      try {
        // DA1.3 — no `this.getCredentials(slug)` here on purpose. The gateway
        // catalogue authenticates from the live dp creds inside the fetcher, so
        // the stored per-connection snapshot is neither read nor resolved: one
        // credential, one lifecycle, and the same answer on both production
        // resolvers (Electron main and the headless `nessy-server`).
        const result = await fetchNestorModels(connection)
        newModels = result.models
        serverDefault = result.serverDefault
        handlerLog.info(`Model refresh [${slug}]: fetched ${newModels.length} models from Nestor`)
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error)
        // P3.90 — say which kind of failure this was. A 5xx from the models
        // endpoint is a credential-type diagnosis, not a transient (the
        // gateway crashes rather than answering 401 on a credential it cannot
        // parse), and the stale catalogue below is kept deliberately. The
        // verdict is read off the error rather than off the status class so a
        // future retry ladder cannot spin on a wrong key.
        //
        // D1.222 — and the verdict now does something. A nestor connection is
        // given a startup fetch and NO periodic timer (`startAll`), so before
        // this the only retry an offline start got was a RESTART. On a
        // TRANSIENT verdict only, one bounded re-fetch is scheduled; a
        // not-retryable verdict schedules nothing, because that one is a
        // credential diagnosis and a ladder on it would spin.
        const retryable = isTransientNestorCatalogueFailure(error)
        handlerLog.warn(
          `Model refresh [${slug}]: Nestor fetch failed (${retryable ? 'transient' : 'not retryable'}): ${msg}`,
        )
        if (retryable) this.scheduleSingleRetry(slug)
        return
      }
    } else {
      providerType = connection.providerType as FetchableProvider
      const fetcher = this.fetchers[providerType]
      if (!fetcher) {
        handlerLog.warn(`Model refresh: no fetcher for provider type: ${providerType}`)
        return
      }

      // Layer 1: Provider API/SDK
      try {
        const credentials = await this.getCredentials(slug)
        handlerLog.info(`Model refresh [${slug}]: fetching (provider=${connection.providerType}, piAuth=${connection.piAuthProvider}, hasOAuthRefresh=${!!credentials.oauthRefreshToken}, hasOAuthAccess=${!!credentials.oauthAccessToken})`)
        const result = await fetcher.fetchModels(connection, credentials)
        newModels = result.models
        serverDefault = result.serverDefault
        handlerLog.info(`Model refresh [${slug}]: fetched ${newModels.length} models from provider: ${newModels.map(m => m.id).join(', ')}`)
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error)
        handlerLog.warn(`Model refresh [${slug}]: provider fetch failed: ${msg}`)
      }
    }

    // Layer 2: Persisted connection.models (keep what we have)
    if (!newModels && connection.models && connection.models.length > 0) {
      handlerLog.warn(`Model refresh [${slug}]: keeping ${connection.models.length} stale persisted models (live fetch failed)`)
      return // Nothing to update
    }

    // Layer 3: MODEL_REGISTRY hardcoded fallback
    if (!newModels && providerType) {
      const registryModels = getModelsForProviderType(providerType, connection.piAuthProvider)
      if (registryModels.length > 0) {
        newModels = registryModels
        handlerLog.info(`Model refresh [${slug}]: using ${newModels.length} models from MODEL_REGISTRY`)
      }
    }

    if (!newModels || newModels.length === 0) {
      handlerLog.warn(`Model refresh [${slug}]: no models available from any source`)
      return
    }

    // For Pi connections with explicit user-owned 3-tier selection,
    // never overwrite model lists from background refresh.
    // Exception: Copilot connections are always server-managed — GitHub's
    // model policy controls which models are enabled, so we must always
    // accept the live API result.
    const isCopilot = connection.providerType === 'pi' && connection.piAuthProvider === 'github-copilot'
    if (connection.providerType === 'pi' && connection.modelSelectionMode === 'userDefined3Tier' && !isCopilot) {
      const modelCount = connection.models?.length ?? 0
      handlerLog.info(`Model refresh [${slug}]: preserving user-defined Pi model list (${modelCount} models)`)
      if (modelCount > 10) {
        handlerLog.warn(`Model refresh [${slug}]: userDefined3Tier has suspicious model count (${modelCount})`)
      }
      return
    }

    // Preserve user's defaultModel if still valid
    const currentDefault = connection.defaultModel
    const stillValid = currentDefault && newModels.some(m => m.id === currentDefault)
    // P6.1080 — THREE tiers, and the middle one was missing.
    //
    // 1. the catalogue's own `is_default`. The right first answer, and not one
    //    to depend on alone: probed on 2026-09-11 the gateway's two rows carried
    //    it at 10:40 and W12-e recorded neither row carrying it at 10:00.
    // 2. the catalogue's `coder` ALIAS. The gateway rotates the id behind its
    //    aliases and keeps the alias — `tgpt/qwen35-397b-a17b-fp8` became
    //    `tgpt/deepseek-v4-flash-0731` and the alias never moved — so this is
    //    the native seam, and without it a flapping flag drops straight to
    //    tier 3, where today's FIRST row is the `fast` model: a coding session
    //    silently downgraded to the cheap tier.
    // 3. the first row, unchanged, for every catalogue that publishes neither.
    const coderAliasId = stillValid ? undefined : resolveGatewayCoderModelId({ models: newModels })
    const substituteVia: ModelDefaultSubstitution['via'] = serverDefault
      ? 'catalogue-default'
      : coderAliasId ? 'coder-alias' : 'first-model'
    const newDefault = stillValid
      ? currentDefault
      : serverDefault ?? coderAliasId ?? newModels[0]?.id

    // …and SAY SO. The substitution is silent today, at every layer: the
    // session's own stale model is cleared by `resolveModelForProvider` BEFORE
    // `SessionManager.warnIfModelIdUnrecognized` reads `resolvedModel`, so
    // P6.362's diagnostic — the one host-side line all three runtimes share —
    // cannot see it. Measured on this rig: three gateway connections moved off
    // the retired id between the 2026-09-03 and 2026-09-07 config snapshots and
    // nothing anywhere told the user which model answers now.
    if (!stillValid && currentDefault && newDefault && newDefault !== currentDefault) {
      recordModelDefaultSubstitution(slug, currentDefault, newDefault, substituteVia)
    }

    // DA2.12 — the STAMP, in the same write as the list it describes, so the two
    // cannot disagree about when this catalogue was read. It is a second field
    // and not `modelsSyncedAt`: that one is the BYO metadata-sync ENROLMENT
    // marker `isModelSyncEnrolled` reads, and stamping it here would enrol the
    // gateway card and give one model list two writers — the hazard
    // `model-list-provenance.ts` declines by name, which is why the picker could
    // not honestly say WHEN its list was last read.
    updateLlmConnection(slug, {
      models: newModels,
      catalogueRefreshedAt: Date.now(),
      ...(newDefault && !stillValid ? { defaultModel: newDefault } : {}),
    })
  }

  /**
   * Start periodic refresh timers for all existing connections.
   * Also runs an immediate non-blocking fetch for each.
   * Call on app startup after IPC handlers are registered.
   */
  startAll(): void {
    const connections = getLlmConnections()

    for (const conn of connections) {
      if (conn.providerType === 'nestor-cloud-agent') continue
      const isNestor = isNestorConnection(conn)
      // An enrolled connection has to pass BOTH of the gates below, or the
      // startup fetch never happens — and it must stop before the timer block.
      // The reason differs by shape, which is why the flag is read once here
      // and consulted three times:
      //   - `pi_compat`: `this.fetchers['pi_compat']` is undefined, so the
      //     timer block would throw on `fetcher.refreshIntervalMs`.
      //   - an adapter runtime: a fetcher DOES exist and its
      //     `refreshIntervalMs` is 3 600 000, so without the stop at the timer
      //     block an enrolled connection would carry an hourly timer whose
      //     every tick is a no-op against the 24h TTL.
      const isEnrolledByo = isModelSyncEnrolled(conn)
      if (isCompatProvider(conn.providerType) && !isNestor && !isEnrolledByo) continue

      const providerType = conn.providerType as FetchableProvider
      const fetcher = this.fetchers[providerType]
      if (!fetcher && !isNestor && !isEnrolledByo) continue

      // Immediate non-blocking fetch.
      //
      // D1.117 — THE BOUND OF THIS LINE, measured 2026-09-17 and written here
      // because the row it belongs to is an owner posture and the code should
      // not pretend otherwise.
      //
      //  1. Nothing waits on it. The first turn of the first session can be
      //     sent before this promise settles, against whatever
      //     `connection.defaultModel` is stored — the race the row names.
      //  2. A stale default is rewritten ONLY on a successful fetch. Every
      //     failure arm of `_doRefresh` RETURNS (the gateway catch, "keeping N
      //     stale persisted models", "no models available from any source"), so
      //     an offline start leaves the stored default exactly as it was.
      //  3. And for a nestor connection there is no PERIODIC attempt in this
      //     process: the `continue` below deliberately schedules no timer.
      //     D1.222 gave that arm its one exception — a TRANSIENT catalogue
      //     failure (a transport error, 408, 429) now buys exactly one bounded
      //     re-fetch, `scheduleSingleRetry`; a not-retryable verdict still has
      //     the restart as its only retry. What the user
      //     meets meanwhile is the endpoint's own refusal on their first turn —
      //     a 404 whose body names nessy-cli's `/auth` and `/model`, which D1.118
      //     answers by putting this product's own remedy beside it.
      //  4. The `.catch` below is very nearly dead, and that is worth knowing
      //     before anyone reads its absence as evidence: `_doRefresh` swallows
      //     every fetch failure into `handlerLog.warn` and returns, so this
      //     handler fires only if the refresh throws OUTSIDE those arms.
      //
      // The posture the row asks for — block the first turn on an in-flight
      // refresh, or let it fail and translate the endpoint's message — is the
      // OWNER's, left ⏸ with the recommendation recorded in the lane report:
      // translate (D1.118), never block, because a blocked turn is what the
      // dp-auth Target scheme's clause 2 refuses for the neighbouring case.
      this.refreshConnection(conn.slug).catch(err => {
        handlerLog.warn(`Initial model refresh failed for ${conn.slug}: ${err instanceof Error ? err.message : err}`)
      })

      // Startup fetch only, no periodic timer — the 24h TTL is the cadence.
      if (isNestor || isEnrolledByo) continue

      // Set up periodic refresh: Copilot connections get their own interval
      // (models are server-managed by GitHub policy), other providers use
      // the fetcher's generic interval (0 = no periodic refresh for static SDK models).
      const isCopilot = conn.providerType === 'pi' && conn.piAuthProvider === 'github-copilot'
      if (isCopilot) {
        this.startTimer(conn.slug, COPILOT_REFRESH_INTERVAL_MS)
      } else if (fetcher.refreshIntervalMs > 0) {
        this.startTimer(conn.slug, fetcher.refreshIntervalMs)
      }
    }
  }

  /**
   * Stop all refresh timers. Call on app quit.
   */
  stopAll(): void {
    for (const [slug, timer] of this.timers) {
      clearInterval(timer)
      handlerLog.info(`Stopped model refresh timer for ${slug}`)
    }
    this.timers.clear()
    // D1.222 — the pending single re-fetch dies with the timers. `retriedSlugs`
    // is deliberately NOT cleared: this is the quit path, and a `stopAll`
    // followed by a `startAll` in one process (the tests, and any future
    // re-init) must not hand every connection a fresh retry budget.
    for (const [slug, timer] of this.retryTimers) {
      clearTimeout(timer)
      handlerLog.info(`Cancelled the pending catalogue retry for ${slug}`)
    }
    this.retryTimers.clear()
  }

  /**
   * Trigger an immediate refresh for a specific connection.
   * Also starts a periodic timer if the fetcher supports it.
   * Called when: connection created, auth completed, user clicks refresh.
   */
  async refreshNow(slug: string): Promise<void> {
    await this.refreshConnection(slug)

    // Ensure periodic timer is running
    const connection = getLlmConnection(slug)
    if (!connection || connection.providerType === 'nestor-cloud-agent' || isNestorConnection(connection) || isCompatProvider(connection.providerType)) return
    // An enrolled connection's cadence is the 24h TTL, and this is the path the
    // user actually takes: `refreshNow` runs on connection created, auth
    // completed and the manual refresh button. `startAll`'s stop covers the
    // startup sweep only, so without this an enrolled adapter-runtime
    // connection picks up the fetcher's hourly timer the moment it is saved —
    // every tick a no-op the TTL refuses, against someone else's endpoint.
    if (isModelSyncEnrolled(connection)) return

    const providerType = connection.providerType as FetchableProvider
    const fetcher = this.fetchers[providerType]
    const isCopilot = connection.providerType === 'pi' && connection.piAuthProvider === 'github-copilot'
    if (isCopilot && !this.timers.has(slug)) {
      this.startTimer(slug, COPILOT_REFRESH_INTERVAL_MS)
    } else if (fetcher && fetcher.refreshIntervalMs > 0 && !this.timers.has(slug)) {
      this.startTimer(slug, fetcher.refreshIntervalMs)
    }
  }

  /**
   * Stop timer for a specific connection (e.g., when deleted).
   */
  stopConnection(slug: string): void {
    const timer = this.timers.get(slug)
    if (timer) {
      clearInterval(timer)
      this.timers.delete(slug)
    }
    // D1.222 — a deleted connection's pending re-fetch goes with it. Harmless
    // either way (`_doRefresh` warns and returns on a connection it cannot
    // find), but a request to an endpoint the user just removed is not a thing
    // to leave scheduled.
    const retry = this.retryTimers.get(slug)
    if (retry) {
      clearTimeout(retry)
      this.retryTimers.delete(slug)
    }
  }

  /**
   * D1.222 — ONE more attempt for this connection, and never a second.
   *
   * The boundedness is the whole design, and it is two guards rather than a
   * counter: `retriedSlugs` is never cleared while the process lives, so the
   * retry's OWN failure — which re-enters the same catch — schedules nothing,
   * and a connection that fails transiently again an hour later has already
   * spent its attempt. A ladder here would spin against an endpoint that is
   * down, on the boot path, with nobody watching.
   *
   * It is scheduled from the catch rather than from `startAll` so that every
   * caller of `refreshConnection` gets the same behaviour — the startup fetch
   * is simply the one that had no other retry at all.
   */
  private scheduleSingleRetry(slug: string): void {
    if (this.retriedSlugs.has(slug) || this.retryTimers.has(slug)) return
    this.retriedSlugs.add(slug)

    const timer = setTimeout(() => {
      this.retryTimers.delete(slug)
      handlerLog.info(`Model refresh [${slug}]: retrying the catalogue once after a transient failure`)
      this.refreshConnection(slug).catch((err) => {
        handlerLog.warn(`Model refresh [${slug}]: the single retry failed too: ${err instanceof Error ? err.message : err}`)
      })
    }, NESTOR_TRANSIENT_RETRY_DELAY_MS)

    // A pending retry must not hold the process open: the headless
    // `nessy-server` and the packaged app both quit through `stopAll`, but a
    // CLI run that finishes in between should not wait 30 s for a catalogue
    // nobody is going to read.
    timer.unref?.()
    this.retryTimers.set(slug, timer)
    handlerLog.info(
      `Model refresh [${slug}]: one retry scheduled in ${NESTOR_TRANSIENT_RETRY_DELAY_MS}ms (transient failure)`,
    )
  }

  private startTimer(slug: string, intervalMs: number): void {
    // Don't create duplicate timers
    if (this.timers.has(slug)) return

    const timer = setInterval(async () => {
      try {
        await this.refreshConnection(slug)
      } catch (err) {
        handlerLog.warn(`Periodic model refresh failed for ${slug}: ${err instanceof Error ? err.message : err}`)
      }
    }, intervalMs)

    this.timers.set(slug, timer)
  }
}

// ============================================================
// Singleton Instance
// ============================================================

let _service: ModelRefreshService | null = null

/**
 * Get the ModelRefreshService singleton.
 * Must be initialized with initModelRefreshService() before use.
 */
export function getModelRefreshService(): ModelRefreshService {
  if (!_service) {
    throw new Error('ModelRefreshService not initialized. Call initModelRefreshService() first.')
  }
  return _service
}

/**
 * Initialize the ModelRefreshService with a credential resolver.
 * Called once during app startup.
 */
export function initModelRefreshService(getCredentials: CredentialResolver): ModelRefreshService {
  _service = new ModelRefreshService(MODEL_FETCHERS, getCredentials)
  return _service
}

export { setFetcherPlatform } from './runtime'
