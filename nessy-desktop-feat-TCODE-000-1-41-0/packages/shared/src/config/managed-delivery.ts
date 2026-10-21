/**
 * Server-delivered managed settings — the Nessy Gateway analogue of Claude's
 * server-managed settings (`server-managed-settings.md`).
 *
 * The shape we match is the page's opening paragraph, which carries no section
 * anchor of its own — only `##`/`###`/`####` headings get an id — so it is cited
 * by page and sentence: "Claude Code clients fetch these settings automatically
 * when users authenticate with a Team or Enterprise OAuth login, an OAuth token
 * supplied through `CLAUDE_CODE_OAUTH_TOKEN`, or a directly configured API key,
 * on platforms where server-managed delivery is supported." Our authentication
 * event is the Nessy Gateway sign-in (`auth/dp`), so the fetch hangs off that
 * facade rather than off a poll of Anthropic's endpoint. Everything else in the
 * lifecycle is the documented one — all sections below are on that same page:
 *
 * - `#fetch-and-caching-behavior` first launch with no cache fetches
 *   asynchronously, and a failed fetch continues WITHOUT managed settings.
 * - `#fetch-and-caching-behavior` a later launch applies the cache immediately —
 *   except the withheld env categories (see `managed-env.ts`) — fetches fresh in
 *   the background, and keeps the cache through network failures.
 * - `#invalid-entries-in-delivered-settings` the cache stores the SALVAGED
 *   payload with invalid entries removed; the raw invalid payload is never
 *   persisted. One carve-out this list used to omit: invalid
 *   `cleanupPeriodDays` and `desktopSessionCleanupPeriodDays` values "stay in
 *   the cached copy and are never applied".
 * - `#invalid-entries-in-delivered-settings` when no field can be salvaged the
 *   last-accepted cache is KEPT and the failure is recorded — never a silent
 *   wipe. See {@link parseDeliveredManagedPolicy} for the two conditions this
 *   summary flattens.
 * - `#enforce-fail-closed-startup` the fetch sends `Cache-Control: no-cache` —
 *   "The settings fetch also sends a `Cache-Control: no-cache` header so
 *   intermediate HTTP proxies don't serve a stale response."
 * - `#settings-precedence` a successful fetch is what supersedes the cache:
 *   "cached settings persist on client machines until the next successful
 *   fetch".
 *
 * Every citation in this file was a bare `:<line>` into that page until P3.209.
 * They are section anchors now, and the conversion was a RE-VERIFICATION rather
 * than a renumbering: three of the quotes turned out to be false rather than
 * stale, and each is corrected at its own site with the difference named.
 *
 * ## Two files this module must not confuse
 *
 * `~/.nessy/dp_auth_creds.json` is nessy-cli's contract and `auth/dp` is its
 * ONLY writer (AGENTS.md). Settings never go there. This cache is its own file
 * under the Nessy config dir, mode 0600, written atomically.
 *
 * ## Logging
 *
 * Nothing here logs. A delivered payload can carry a credential in its `env`
 * block and a proxy URL with an embedded password, so the module returns
 * structured results and lets call sites decide what is safe to surface —
 * field paths and counts, never values.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import {
  carriesManagedSettings,
  DEFAULT_MANAGED_PI_POLICY,
  parseManagedPiPolicyTolerantV1,
  type ManagedPiPolicyV1,
  type ManagedPolicyDropV1,
} from '../agent/pi-harness/managed-policy.ts'
import {
  classifyManagedApproval,
  type ManagedApprovalRequestV1,
} from './managed-approval.ts'
import {
  applyComposedManagedEnv,
  applyManagedEnv,
  resolveComposedManagedEnvSources,
  type ManagedEnvApplicationV1,
} from './managed-env.ts'
import { CONFIG_DIR } from './paths.ts'

/**
 * The delivery endpoint, on the gateway host we already own. Sibling of the
 * documented `/api/v1/cli/models` route (AGENTS.md "Gateway Facts") and, like
 * the token exchange, spelled out here rather than derived from the chat
 * prefix — a settings endpoint must not move when the chat prefix does.
 */
export const NESSY_MANAGED_SETTINGS_URL =
  'https://code-completion-nestor.tcsbank.ru/api/v1/cli/managed-settings'

/** The gateway's auth header (AGENTS.md "Gateway Facts"). */
const GATEWAY_AUTH_HEADER = 'Nestor-Token'

const FETCH_TIMEOUT_MS = 15_000

/**
 * `server-managed-settings.md#fetch-and-caching-behavior` — "polls for updates hourly during active sessions". The interval is
 * also the floor between two sign-in-triggered fetches, so a burst of
 * `ensureNessyGatewayAuth()` calls produces one request.
 */
export const MANAGED_DELIVERY_POLL_INTERVAL_MS = 3_600_000

export const MANAGED_DELIVERY_CACHE_SCHEMA_VERSION = 1 as const

/** The cache file name. Our `~/.claude/remote-settings.json` (`server-managed-settings.md#invalid-entries-in-delivered-settings`). */
export const MANAGED_DELIVERY_CACHE_FILENAME = 'managed-delivery.json'

export function getManagedDeliveryCachePath(configDir: string = CONFIG_DIR): string {
  return join(configDir, MANAGED_DELIVERY_CACHE_FILENAME)
}

export interface ManagedDeliveryCacheV1 {
  readonly schemaVersion: typeof MANAGED_DELIVERY_CACHE_SCHEMA_VERSION
  /** Epoch ms of the fetch that produced {@link payload}. */
  readonly fetchedAt: number
  /**
   * The SALVAGED payload (`server-managed-settings.md#invalid-entries-in-delivered-settings`). Stored as the parsed policy re-serialised,
   * which is stronger than filtering the raw document: an entry the parser
   * refused cannot reach disk even by accident, and re-reading the cache
   * produces the same policy with no further drops.
   */
  readonly payload: Record<string, unknown>
  /**
   * Digest of {@link payload} recorded when a user approved it (`server-managed-settings.md#approval-memory`).
   * Absent means the payload needed no approval, or was never approved — see
   * `managed-approval.ts`.
   */
  readonly approvedDigest?: string
}

function plainObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

/**
 * Read the cache. A missing, unreadable, or structurally wrong file reads as
 * "no cache" rather than an error: `server-managed-settings.md#security-considerations` treats a deleted cache as
 * first-launch behaviour, and a corrupt one must not stop the app.
 */
export function readManagedDeliveryCache(
  path: string = getManagedDeliveryCachePath(),
): ManagedDeliveryCacheV1 | null {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return null
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  const root = plainObject(parsed)
  if (!root || root.schemaVersion !== MANAGED_DELIVERY_CACHE_SCHEMA_VERSION) return null
  const payload = plainObject(root.payload)
  if (!payload || typeof root.fetchedAt !== 'number') return null
  const approvedDigest = typeof root.approvedDigest === 'string' ? root.approvedDigest : undefined
  return Object.freeze({
    schemaVersion: MANAGED_DELIVERY_CACHE_SCHEMA_VERSION,
    fetchedAt: root.fetchedAt,
    payload,
    ...(approvedDigest === undefined ? {} : { approvedDigest }),
  })
}

/**
 * Atomic write at mode 0600. The payload can carry a credential in its `env`
 * block, so the file is no more readable than the credential store beside it.
 */
export function writeManagedDeliveryCache(
  cache: ManagedDeliveryCacheV1,
  path: string = getManagedDeliveryCachePath(),
): void {
  const directory = dirname(path)
  if (!existsSync(directory)) mkdirSync(directory, { recursive: true, mode: 0o700 })
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  writeFileSync(temporary, JSON.stringify(cache, null, 2), { encoding: 'utf8', mode: 0o600 })
  chmodSync(temporary, 0o600) // guarantee 0600 regardless of umask
  renameSync(temporary, path) // atomic on the same filesystem
}

export function clearManagedDeliveryCache(path: string = getManagedDeliveryCachePath()): void {
  try {
    unlinkSync(path)
  } catch {
    // absent is the desired state
  }
}

/**
 * What a delivered document turned out to be.
 *
 * `empty` and `unsalvageable` are deliberately different (`server-managed-settings.md#invalid-entries-in-delivered-settings` vs `server-managed-settings.md#settings-precedence`): a
 * server that delivers nothing SUPERSEDES the cache on the next successful
 * fetch, while a payload whose every field is invalid keeps the last-accepted
 * cache and records a fatal error. Collapsing the two would let one bad push
 * silently disable an organization's policy.
 */
export type ManagedDeliveryOutcomeV1 = 'delivered' | 'empty' | 'unsalvageable'

export interface ManagedDeliverySalvageV1 {
  readonly outcome: ManagedDeliveryOutcomeV1
  readonly policy: ManagedPiPolicyV1
  /** JSON-safe salvaged form, ready for the cache. */
  readonly payload: Record<string, unknown>
  readonly drops: readonly ManagedPolicyDropV1[]
}

/** Source label carried on drops from a delivered payload. */
export const MANAGED_DELIVERY_SOURCE = 'nessy-gateway:managed-settings'

/**
 * Parse a delivered document under the SAME tolerant rules as every other
 * managed source (`server-managed-settings.md#invalid-entries-in-delivered-settings`), and classify the result.
 *
 * Reuses `parseManagedPiPolicyTolerantV1` rather than adding a second parser:
 * a delivered payload that behaved differently from the same document dropped
 * on disk would be a policy divergence nobody could reason about.
 */
export function salvageDeliveredPayload(
  document: unknown,
  source: string = MANAGED_DELIVERY_SOURCE,
): ManagedDeliverySalvageV1 {
  const root = plainObject(document)
  if (!root || Object.keys(root).length === 0) {
    return Object.freeze({
      outcome: 'empty' as const,
      policy: DEFAULT_MANAGED_PI_POLICY,
      payload: {},
      drops: Object.freeze([] as ManagedPolicyDropV1[]),
    })
  }
  const parsed = parseManagedPiPolicyTolerantV1(root, { source })
  const payload = JSON.parse(JSON.stringify(parsed.policy)) as Record<string, unknown>
  // The salvage-failure condition
  // (`server-managed-settings.md#invalid-entries-in-delivered-settings`) is
  // measured on the SETTINGS, not on the
  // drop count: `disabledPermissionModes` is mandatory in this schema, so a
  // document that omits it always records one drop and installs the default —
  // which would otherwise read every legitimately empty payload as fatal.
  // `carriesManagedSettings` owns that distinction, and is the SAME predicate
  // `server-managed-settings.md#settings-precedence`'s "delivers any keys at all" uses when the two managed sources are
  // composed; a second copy of it here could drift into two answers to one
  // question.
  const delivered = Object.keys(root).filter(key => key !== 'schemaVersion')
  const salvagedNothing = delivered.length > 0 && !carriesManagedSettings(parsed.policy)
  return Object.freeze({
    outcome: (salvagedNothing ? 'unsalvageable' : 'delivered') as ManagedDeliveryOutcomeV1,
    policy: parsed.policy,
    payload,
    drops: parsed.drops,
  })
}

export interface ManagedDeliveryFetchOptions {
  /** Gateway JWT. Never logged, never persisted by this module. */
  jwt: string
  url?: string
  signal?: AbortSignal
  timeoutMs?: number
  /** Injectable transport — the only seam tests use. */
  fetchImpl?: typeof fetch
}

/** A fetch that reached the server, with the document it returned (or none). */
export interface ManagedDeliveryFetchResultV1 {
  /** `undefined` when the server has no managed settings for this account. */
  readonly document: unknown
}

export class ManagedDeliveryFetchError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ManagedDeliveryFetchError'
  }
}

/**
 * Fetch the delivered document. Throws {@link ManagedDeliveryFetchError} on any
 * failure to reach or read the endpoint — callers decide whether that is
 * fail-open (`server-managed-settings.md#fetch-and-caching-behavior`) or fail-closed (`server-managed-settings.md#enforce-fail-closed-startup`).
 *
 * `404`/`204`/an empty body mean the organization has no managed settings.
 * That is a SUCCESSFUL fetch delivering nothing, not a failure: `server-managed-settings.md#settings-precedence` makes
 * the next successful fetch the thing that supersedes a stale cache.
 */
export async function fetchManagedSettings(
  options: ManagedDeliveryFetchOptions,
): Promise<ManagedDeliveryFetchResultV1> {
  const url = options.url ?? NESSY_MANAGED_SETTINGS_URL
  const timeout = AbortSignal.timeout(options.timeoutMs ?? FETCH_TIMEOUT_MS)
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout
  const call = options.fetchImpl ?? fetch

  let response: Response
  try {
    response = await call(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        // `server-managed-settings.md#enforce-fail-closed-startup` — "so intermediate HTTP proxies don't serve a stale response".
        'Cache-Control': 'no-cache',
        'X-Request-Id': randomUUID(),
        [GATEWAY_AUTH_HEADER]: options.jwt,
      },
      signal,
    })
  } catch {
    // The error is swallowed rather than wrapped: a transport error can carry
    // the request URL, and a proxied request URL can carry credentials.
    throw new ManagedDeliveryFetchError('managed settings request failed')
  }

  if (response.status === 404 || response.status === 204) {
    return Object.freeze({ document: undefined })
  }
  if (!response.ok) {
    throw new ManagedDeliveryFetchError(`managed settings HTTP ${response.status}`)
  }
  let body: string
  try {
    body = await response.text()
  } catch {
    throw new ManagedDeliveryFetchError('managed settings response unreadable')
  }
  if (body.trim().length === 0) return Object.freeze({ document: undefined })
  try {
    return Object.freeze({ document: JSON.parse(body) })
  } catch {
    throw new ManagedDeliveryFetchError('managed settings response is not JSON')
  }
}

/**
 * What the app should enforce right now, and how sure it is of it.
 *
 * `confirmed` is the whole point of the state: it is `true` only after a fetch
 * SUCCEEDED in this session, which is the condition `server-managed-settings.md#fetch-and-caching-behavior` puts on releasing
 * the withheld environment variables.
 */
export interface ManagedDeliveryStateV1 {
  readonly policy: ManagedPiPolicyV1
  readonly source: 'none' | 'cache' | 'server'
  readonly confirmed: boolean
  /**
   * `server-managed-settings.md#invalid-entries-in-delivered-settings` — a payload with nothing salvageable is recorded, not applied.
   *
   * Read by {@link reportManagedDeliveryState} at the publish site, which is
   * what makes `server-managed-settings.md#invalid-entries-in-delivered-settings`'s "records a fatal error" a record someone can see.
   */
  readonly fatalError?: string
  readonly drops: readonly ManagedPolicyDropV1[]
  /** Epoch ms of the fetch behind this state, when there was one. */
  readonly fetchedAt?: number
  /**
   * Set when a payload exists but is held back for approval (`server-managed-settings.md#approval-memory`). The
   * policy above is the last APPROVED one, not this payload.
   *
   * The hold-back itself does not depend on this field — it works through
   * `source: 'none'` — so its job is to say WHY the org's new settings are not
   * in effect. {@link reportManagedDeliveryState} is what says it.
   */
  readonly awaitingApproval?: ManagedApprovalRequestV1
  /**
   * P6.246(c) — WHY the last fetch failed, and when.
   *
   * READER CORRECTED, and this field is the correction: the row was written
   * believing the state already held the outcome. It did not. A network failure
   * throws {@link ManagedDeliveryFetchError} out of
   * {@link refreshManagedDelivery} and published NOTHING, so the cause existed
   * only in whatever the caller decided to do with the exception — and both
   * documented callers (fail-open at startup, fail-closed under
   * `forceRemoteSettingsRefresh`) decide policy, not legibility. An
   * administrator asking *"did the organisation's settings arrive?"* had no
   * surface that could answer *"no, and here is why"*.
   *
   * Recorded ALONGSIDE the state that is still in force rather than replacing
   * it: the whole point of the caching contract
   * (`server-managed-settings.md#fetch-and-caching-behavior`, *"Cached settings
   * apply immediately at startup"*) is that a failed fetch leaves the cached
   * policy running, so the honest report is *cause + what still applies*, and
   * `source`/`policy`/`confirmed` next to this field are that second half.
   *
   * Absent on every successful publish, because `applyDeliveredDocument` builds
   * a fresh state object — so a fetch that recovers clears the cause by
   * construction rather than by anyone remembering to.
   */
  readonly fetchError?: ManagedDeliveryFetchFailureV1
}

/** P6.246(c) — the recorded cause of a failed delivery fetch. */
export interface ManagedDeliveryFetchFailureV1 {
  /** The `ManagedDeliveryFetchError` message, or the thrown value's text. */
  readonly cause: string
  /** Epoch ms of the attempt. */
  readonly at: number
}

const EMPTY_DROPS = Object.freeze([] as ManagedPolicyDropV1[])

export const NO_MANAGED_DELIVERY: ManagedDeliveryStateV1 = Object.freeze({
  policy: DEFAULT_MANAGED_PI_POLICY,
  source: 'none' as const,
  confirmed: false,
  drops: EMPTY_DROPS,
})

/**
 * The startup read: the cached payload, re-parsed, UNCONFIRMED.
 *
 * Re-parsing rather than trusting the file is deliberate. The cache is a
 * user-writable file on an unmanaged device (`server-managed-settings.md#security-considerations` "User edits the cached
 * settings file"), so it gets the same tolerant parse a server payload gets,
 * and a hand-edited entry is stripped exactly the same way.
 */
export function loadCachedManagedDelivery(
  path: string = getManagedDeliveryCachePath(),
): ManagedDeliveryStateV1 {
  const cache = readManagedDeliveryCache(path)
  if (!cache) return NO_MANAGED_DELIVERY
  const salvage = salvageDeliveredPayload(cache.payload, path)
  if (salvage.outcome !== 'delivered') return NO_MANAGED_DELIVERY
  // The cache is only ever written for a payload that needed no approval or
  // was approved, so a cached payload that needs approval and does not match
  // the recorded digest was TAMPERED WITH (`server-managed-settings.md#security-considerations`). It is held back rather than
  // applied, which is `server-managed-settings.md#approval-memory`'s "keeps the last-approved settings"; the next
  // fetch presents it properly.
  const approval = classifyManagedApproval(salvage.policy, salvage.payload)
  if (approval && approval.digest !== cache.approvedDigest) {
    return Object.freeze({ ...NO_MANAGED_DELIVERY, awaitingApproval: approval })
  }
  return Object.freeze({
    policy: salvage.policy,
    source: 'cache' as const,
    confirmed: false,
    drops: salvage.drops,
    fetchedAt: cache.fetchedAt,
  })
}

/**
 * The security-approval verdict, as this module needs it. Defined here rather
 * than imported so `managed-approval.ts` can depend on the delivery types
 * without a cycle; that module produces the values.
 */
export interface ManagedDeliveryGateResultV1 {
  /** Apply the delivered payload to this session. */
  readonly apply: boolean
  /** Write the salvaged payload to the cache. */
  readonly persist: boolean
  /** Digest to record as approved, when the user just approved it. */
  readonly approvedDigest?: string | undefined
}

export type ManagedDeliveryGateV1 = (
  salvage: ManagedDeliverySalvageV1,
  context: { approvedDigest?: string | undefined },
) => ManagedDeliveryGateResultV1

export interface ApplyDeliveredDocumentOptions {
  /** The document the server returned; `undefined` when it delivered nothing. */
  document: unknown
  /** Epoch ms to stamp on the cache. */
  now?: number
  cachePath?: string
  /**
   * When false, the salvaged payload is NOT written to the cache. `server-managed-settings.md#approval-memory`: a
   * non-interactive run that would need approval "applies them for that run
   * only: it doesn't record them as approved or write them to the local
   * cache".
   */
  persist?: boolean
  /**
   * The security approval decision (`server-managed-settings.md#security-approval-dialogs` through `#approval-memory`), evaluated on the SALVAGED
   * payload per `server-managed-settings.md#invalid-entries-in-delivered-settings`. Absent means "no approval layer wired" — the payload
   * applies and caches, which is the pre-approval behaviour.
   */
  gate?: ManagedDeliveryGateV1
}

/**
 * Fold a freshly fetched document into the cache and produce the state to
 * enforce. The fetch already SUCCEEDED by the time this runs, so every branch
 * returns `confirmed: true` — including the unsalvageable one, where the
 * server did confirm the session even though its payload was unusable.
 */
export function applyDeliveredDocument(
  options: ApplyDeliveredDocumentOptions,
): ManagedDeliveryStateV1 {
  const cachePath = options.cachePath ?? getManagedDeliveryCachePath()
  const persist = options.persist ?? true
  const now = options.now ?? Date.now()
  const salvage = salvageDeliveredPayload(options.document)

  if (salvage.outcome === 'empty') {
    // `server-managed-settings.md#settings-precedence` — the next successful fetch is what clears a stale cache.
    if (persist) clearManagedDeliveryCache(cachePath)
    return Object.freeze({ ...NO_MANAGED_DELIVERY, source: 'server' as const, confirmed: true, fetchedAt: now })
  }

  if (salvage.outcome === 'unsalvageable') {
    // `server-managed-settings.md#invalid-entries-in-delivered-settings` — keep the last-accepted cache and record a fatal error. The
    // cache file is left exactly as it was; nothing is written.
    const retained = loadCachedManagedDelivery(cachePath)
    return Object.freeze({
      policy: retained.policy,
      source: retained.source === 'none' ? 'none' as const : 'cache' as const,
      confirmed: true,
      fatalError: 'no field in the delivered managed settings payload could be salvaged',
      drops: salvage.drops,
      ...(retained.fetchedAt === undefined ? {} : { fetchedAt: retained.fetchedAt }),
    })
  }

  const previous = readManagedDeliveryCache(cachePath)
  // With no approval gate wired the host has nobody to ask, so a payload that
  // WOULD need approval takes `server-managed-settings.md#approval-memory`'s shape: applied for this run, never
  // recorded and never cached. Persisting it unstamped would write a payload
  // the startup read then refuses, which is a cache that can only ever miss.
  const verdict = options.gate?.(salvage, { approvedDigest: previous?.approvedDigest })
    ?? {
      apply: true,
      persist: classifyManagedApproval(salvage.policy, salvage.payload) === null,
    }

  if (!verdict.apply) {
    // `server-managed-settings.md#approval-memory` — the delivered settings are NOT applied and the last approved
    // ones are kept. The session is still confirmed: the server answered, so
    // the withheld env variables of the RETAINED payload may be released.
    const retained = loadCachedManagedDelivery(cachePath)
    return Object.freeze({
      policy: retained.policy,
      source: retained.source === 'none' ? 'none' as const : 'cache' as const,
      confirmed: true,
      drops: salvage.drops,
      ...(retained.fetchedAt === undefined ? {} : { fetchedAt: retained.fetchedAt }),
    })
  }

  if (persist && verdict.persist) {
    // An approval recorded against a DIFFERENT payload must not carry over —
    // only a digest the gate just stamped, or the previous one when the payload
    // is unchanged.
    const approvedDigest = verdict.approvedDigest ?? previous?.approvedDigest
    writeManagedDeliveryCache({
      schemaVersion: MANAGED_DELIVERY_CACHE_SCHEMA_VERSION,
      fetchedAt: now,
      payload: salvage.payload,
      ...(approvedDigest === undefined ? {} : { approvedDigest }),
    }, cachePath)
  }

  return Object.freeze({
    policy: salvage.policy,
    source: 'server' as const,
    confirmed: true,
    drops: salvage.drops,
    fetchedAt: now,
  })
}

/* ------------------------------------------------------------------------- *
 * Session state
 * ------------------------------------------------------------------------- */

export type ManagedDeliveryApprovalV1 = (
  salvage: ManagedDeliverySalvageV1,
  context: { approvedDigest?: string | undefined },
) => Promise<ManagedDeliveryGateResultV1> | ManagedDeliveryGateResultV1

interface DeliverySession {
  state: ManagedDeliveryStateV1
  lastFetchAt: number
  inflight: Promise<ManagedDeliveryStateV1> | null
  listeners: Set<(state: ManagedDeliveryStateV1) => void>
  approve: ManagedDeliveryApprovalV1 | null
  enabled: boolean
  poll: ReturnType<typeof setInterval> | null
  report: (message: string) => void
  /** Already-said lines, so the hourly poll cannot repeat one every hour. */
  reported: Set<string>
}

const DEFAULT_MANAGED_DELIVERY_REPORT = (message: string): void => { console.warn(message) }

const session: DeliverySession = {
  state: NO_MANAGED_DELIVERY,
  lastFetchAt: 0,
  inflight: null,
  listeners: new Set(),
  approve: null,
  enabled: false,
  poll: null,
  report: DEFAULT_MANAGED_DELIVERY_REPORT,
  reported: new Set(),
}

/**
 * Opt this process into server-delivered managed settings.
 *
 * OFF by default, and deliberately so. The trigger is a sign-in
 * (`ensureNessyGatewayAuth`), which library consumers and test suites call
 * routinely; without this switch, importing `auth/dp` would make an
 * unannounced outbound request to the gateway on every authentication in every
 * embedder. A host that wants delivery says so once, at startup.
 *
 * Only the implicit sign-in trigger is gated. An explicit
 * {@link refreshManagedDelivery} still fetches, because the caller asked for it
 * by name.
 */
export function setManagedDeliveryEnabled(enabled: boolean): void {
  session.enabled = enabled
}

export function isManagedDeliveryEnabled(): boolean {
  return session.enabled
}

/**
 * Install the process-wide security approval gate (`server-managed-settings.md#security-approval-dialogs` through `#approval-memory`).
 *
 * Process-wide rather than threaded through every call because the sign-in
 * hook fires from `auth/dp` with no access to a dialog, and an unapproved
 * payload must not slip through just because that path did not carry the gate.
 * A host that never registers one applies delivered payloads unprompted, which
 * is the correct default for a headless embedder that has no user to ask.
 */
export function setManagedDeliveryApproval(approve: ManagedDeliveryApprovalV1 | null): void {
  session.approve = approve
}

/** The state every consumer reads. Starts unconfirmed, by construction. */
export function getManagedDeliveryState(): ManagedDeliveryStateV1 {
  return session.state
}

/**
 * The delivered policy that applies RIGHT NOW, for a caller that has to build
 * the enforced policy — `bootstrap/storage-runtime.ts`.
 *
 * Order-independent by construction, which is the whole reason it exists.
 * Delivery is asynchronous and hangs off sign-in, while the storage runtime is
 * built at boot: in the desktop shell `createStorageRuntime` runs several
 * hundred lines BEFORE `initializeManagedDeliveryFromCache()`, and in the
 * headless host the delivery lifecycle has already run and may hold a payload
 * fresher than anything on disk. So both are consulted, freshest first:
 *
 * 1. the live session state, when this process has one. It can hold a payload
 *    the cache deliberately does not — `server-managed-settings.md#approval-memory`'s non-interactive run "applies
 *    them for that run only: it doesn't record them as approved or write them
 *    to the local cache".
 * 2. the 0600 cache, re-parsed. `server-managed-settings.md#fetch-and-caching-behavior` — "Cached settings apply immediately at
 *    startup". This is the same model the withheld-`env` rule already uses, and
 *    it is what makes the policy enforced from the first turn rather than from
 *    whenever a fetch happens to land.
 *
 * Both paths refuse an UNAPPROVED payload before it gets here: the session
 * state holds one back behind `awaitingApproval`, and `loadCachedManagedDelivery`
 * re-checks `approvedDigest` on every read (`server-managed-settings.md#approval-memory`, `server-managed-settings.md#security-considerations`). Returns `undefined`
 * when no delivered policy applies.
 */
export function getDeliveredManagedPolicy(cachePath?: string): ManagedPiPolicyV1 | undefined {
  const live = session.state
  if (live.source !== 'none' && carriesManagedSettings(live.policy)) return live.policy
  const cached = loadCachedManagedDelivery(cachePath ?? getManagedDeliveryCachePath())
  return cached.source !== 'none' && carriesManagedSettings(cached.policy) ? cached.policy : undefined
}

/** `server-managed-settings.md#fetch-and-caching-behavior` — the gate on releasing the withheld environment variables. */
export function isManagedDeliveryConfirmed(): boolean {
  return session.state.confirmed
}

export function onManagedDeliveryChange(
  listener: (state: ManagedDeliveryStateV1) => void,
): () => void {
  session.listeners.add(listener)
  return () => {
    session.listeners.delete(listener)
  }
}

/**
 * The two states a delivery can land in that a user cannot otherwise observe,
 * rendered as one line each.
 *
 * `server-managed-settings.md#invalid-entries-in-delivered-settings` — "When no
 * field in the payload can be salvaged and the payload isn't only those
 * retention keys, Claude Code rejects the payload, keeps the last-accepted
 * cached settings, and writes `Remote settings: Settings validation failed - no
 * fields could be salvaged` to the debug log. With `forceRemoteSettingsRefresh`
 * set, the CLI exits instead."
 *
 * This docblock quoted that sentence as ending "…and records a fatal error",
 * which is on no page: a paraphrase in quotation marks, and one that dropped two
 * real conditions — the retention-key carve-out, and the fail-closed exit. Both
 * were added to the page after the quote was written and neither was in view
 * here (P3.209). Recording the failure in a field nobody reads is not recording
 * it. `server-managed-settings.md#approval-memory`'s hold-back has the same
 * problem from the other side: the org's new settings are deliberately NOT in
 * effect, and without this the only symptom is a policy that quietly stays old.
 *
 * Reported HERE, at the one function every state change goes through, for the
 * reason `storage-runtime.ts:265` gives for the drop list: "printed at load
 * rather than by each host so no host can forget it". That also settles the
 * ordering problem that deferred `drops` — the desktop shell builds its storage
 * runtime before delivery is initialised, so a host-side read would report in
 * one host and silently not in the other; a publish-site report cannot.
 *
 * Values never travel. The fatal error is a fixed sentence, and the hold-back
 * line carries a count and the approval CATEGORIES only — never a field name or
 * a value, since a managed `env` block routinely holds a credential.
 */
function reportManagedDeliveryState(state: ManagedDeliveryStateV1): void {
  const lines: string[] = []
  if (state.fatalError) lines.push(`delivered payload rejected: ${state.fatalError}; keeping the last accepted settings`)
  if (state.awaitingApproval) {
    const categories = [...new Set(state.awaitingApproval.items.map(item => item.category))].sort()
    lines.push(
      `delivered settings need approval (${state.awaitingApproval.items.length} item(s): ${categories.join(', ')})`
      + '; they are NOT applied and the last approved settings are kept',
    )
  }
  if (state.fetchError) {
    // P6.246(c) — the cause AND what is still in force, in one sentence,
    // because an administrator who reads only the first half cannot tell a
    // fleet running yesterday's approved policy from a fleet running none.
    const stillApplies = state.source === 'none'
      ? 'no managed settings are in effect'
      : `the ${state.source === 'cache' ? 'cached' : 'last fetched'} settings still apply`
    lines.push(`fetch failed: ${state.fetchError.cause}; ${stillApplies}`)
  }
  for (const line of lines) {
    const message = `[managed-settings] ${line}`
    if (session.reported.has(message)) continue
    session.reported.add(message)
    session.report(message)
  }
}

function publish(state: ManagedDeliveryStateV1): ManagedDeliveryStateV1 {
  session.state = state
  reportManagedDeliveryState(state)
  for (const listener of session.listeners) {
    try {
      listener(state)
    } catch {
      // a consumer must never break the delivery flow
    }
  }
  return state
}

/**
 * Replace the sink {@link reportManagedDeliveryState} writes to.
 *
 * A seam for tests and for a host that routes diagnostics somewhere other than
 * stderr; the default is the same `console.warn` `reportManagedPolicyDrops`
 * uses, which both hosts already route to their log.
 */
export function setManagedDeliveryReporter(report: ((message: string) => void) | null): void {
  session.report = report ?? DEFAULT_MANAGED_DELIVERY_REPORT
  session.reported.clear()
}

/**
 * Seed the session from the cache. Idempotent, and safe to call before any
 * network is available — this is `server-managed-settings.md#fetch-and-caching-behavior`'s "cached settings apply immediately at
 * startup", with `confirmed: false` carrying the exception it names.
 */
export function initializeManagedDeliveryFromCache(
  cachePath?: string,
): ManagedDeliveryStateV1 {
  if (session.state.confirmed) return session.state
  return publish(loadCachedManagedDelivery(cachePath ?? getManagedDeliveryCachePath()))
}

/** Test/process seam: drop every scrap of session state. */
export function resetManagedDeliverySession(): void {
  stopManagedDeliveryPolling()
  session.state = NO_MANAGED_DELIVERY
  session.lastFetchAt = 0
  session.inflight = null
  session.listeners.clear()
  session.approve = null
  session.enabled = false
  session.report = DEFAULT_MANAGED_DELIVERY_REPORT
  session.reported.clear()
}

export interface ManagedDeliveryPollOptions {
  /**
   * The current gateway JWT, or `null` when the session has none. Read on every
   * tick rather than captured once: a session that signs in an hour after
   * startup must start polling with the credential it now has, and a session
   * whose credential expired must stop presenting it.
   *
   * A callback rather than an import so this module never depends on `auth/dp`
   * — that module already depends on this one for the sign-in hook.
   */
  jwt: () => string | null | undefined
  intervalMs?: number
  cachePath?: string
  /** Injectable refresh. The only seam tests use. */
  refresh?: (jwt: string) => Promise<unknown>
}

/**
 * The hourly poll — `server-managed-settings.md#fetch-and-caching-behavior`: "Claude Code fetches
 * settings from Anthropic's servers at startup and polls for updates hourly
 * during active sessions." `server-managed-settings.md#configure-server-managed-settings` says the same from the admin's side: a saved
 * change reaches clients "on their next startup or hourly polling cycle".
 *
 * Without this the only producer was the sign-in hook, so a session that stayed
 * open never saw a policy update — an admin who tightened a deny rule at 09:00
 * reached a machine that signed in at 08:00 only when the user restarted.
 *
 * Three properties this timer has to have:
 *
 * - **Fail-open.** `server-managed-settings.md#platform-availability` — "the hourly background refresh is fail-open on both
 *   channels". A failed poll leaves the current state alone and says nothing;
 *   the fail-CLOSED posture belongs to startup under `forceRemoteSettingsRefresh`
 *   (`server-managed-settings.md#enforce-fail-closed-startup`), which is a different call site.
 * - **Unref'd.** A background refresh must not be the reason a headless server
 *   or a CLI-spawned server refuses to exit.
 * - **Idempotent.** Calling it twice keeps one timer, so a host that re-runs its
 *   startup path does not double the request rate.
 *
 * Returns a stop function. It is a no-op when delivery is not enabled for this
 * process — the same switch `onNessyGatewayAuthenticated` respects, for the
 * same reason: an embedder that never opted in must make no outbound request.
 */
export function startManagedDeliveryPolling(
  options: ManagedDeliveryPollOptions,
): () => void {
  if (!session.enabled) return () => {}
  if (session.poll) return stopManagedDeliveryPolling
  const intervalMs = options.intervalMs ?? MANAGED_DELIVERY_POLL_INTERVAL_MS
  // `force` because the rate-limit floor IS this interval: without it a tick
  // that lands a few milliseconds early (timer drift, or a sign-in fetch a
  // minute before the tick) is swallowed and the next attempt is two hours
  // away, which is not the documented cadence. The floor exists to collapse a
  // burst of sign-in-triggered fetches; a poll tick is not a burst, and
  // single-flighting still collapses one that overlaps an in-progress fetch.
  const refresh = options.refresh ?? ((jwt: string) => refreshManagedDelivery({
    jwt,
    force: true,
    ...(options.cachePath === undefined ? {} : { cachePath: options.cachePath }),
  }))
  const timer = setInterval(() => {
    const jwt = options.jwt()
    // No credential is not a failure — it is a session that has not signed in
    // yet. The next tick tries again.
    if (typeof jwt !== 'string' || jwt.length === 0) return
    void Promise.resolve(refresh(jwt)).catch(() => {
      // `server-managed-settings.md#platform-availability` — the background refresh is fail-open. Nothing is logged: a
      // transport error can carry a credentialed proxy URL.
    })
  }, intervalMs)
  // `unref` is Node/Bun-only; a browser-ish host just keeps the handle.
  ;(timer as { unref?: () => void }).unref?.()
  session.poll = timer
  return stopManagedDeliveryPolling
}

export function stopManagedDeliveryPolling(): void {
  if (!session.poll) return
  clearInterval(session.poll)
  session.poll = null
}

export function isManagedDeliveryPolling(): boolean {
  return session.poll !== null
}

export interface RefreshManagedDeliveryOptions extends Omit<ManagedDeliveryFetchOptions, 'jwt'> {
  jwt: string
  cachePath?: string
  now?: number
  /** Skip the {@link MANAGED_DELIVERY_POLL_INTERVAL_MS} floor. */
  force?: boolean
  persist?: boolean
  /**
   * The security approval decision (`server-managed-settings.md#security-approval-dialogs` through `#approval-memory`). Async because showing a
   * dialog is, and evaluated on the SALVAGED payload per `server-managed-settings.md#invalid-entries-in-delivered-settings` — a stripped
   * entry is never presented for approval and never executes.
   */
  approve?: (
    salvage: ManagedDeliverySalvageV1,
    context: { approvedDigest?: string | undefined },
  ) => Promise<ManagedDeliveryGateResultV1> | ManagedDeliveryGateResultV1
}

/**
 * Fetch, salvage, cache, publish. Single-flighted, and rate-limited to the
 * documented hourly cadence unless `force` is set, so the several
 * `ensureNessyGatewayAuth()` calls a launch makes produce one request.
 *
 * Throws {@link ManagedDeliveryFetchError} when the fetch fails. It does NOT
 * decide what a failure means: `server-managed-settings.md#fetch-and-caching-behavior` fail-open at startup and `server-managed-settings.md#enforce-fail-closed-startup`
 * fail-closed under `forceRemoteSettingsRefresh` are both callers.
 */
export async function refreshManagedDelivery(
  options: RefreshManagedDeliveryOptions,
): Promise<ManagedDeliveryStateV1> {
  if (session.inflight) return session.inflight
  const now = options.now ?? Date.now()
  if (!options.force
    && session.lastFetchAt !== 0
    && now - session.lastFetchAt < MANAGED_DELIVERY_POLL_INTERVAL_MS) {
    return session.state
  }
  const { jwt, cachePath, persist } = options
  const run = (async () => {
    const result = await fetchManagedSettings({
      jwt,
      ...(options.url === undefined ? {} : { url: options.url }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    })
    session.lastFetchAt = now
    const approve = options.approve ?? session.approve
    let gate: ManagedDeliveryGateV1 | undefined
    if (approve) {
      // Salvage first so the approval sees exactly what would be applied
      // (`server-managed-settings.md#invalid-entries-in-delivered-settings`), and read the recorded approval so an unchanged payload is not
      // re-prompted.
      const salvage = salvageDeliveredPayload(result.document)
      const previous = readManagedDeliveryCache(cachePath ?? getManagedDeliveryCachePath())
      const verdict = await approve(salvage, { approvedDigest: previous?.approvedDigest })
      gate = () => verdict
    }
    return publish(applyDeliveredDocument({
      document: result.document,
      now,
      ...(cachePath === undefined ? {} : { cachePath }),
      ...(persist === undefined ? {} : { persist }),
      ...(gate === undefined ? {} : { gate }),
    }))
  })()
  session.inflight = run
  try {
    return await run
  } catch (error) {
    // P6.246(c) — record the cause, keep the state that is still in force, and
    // RETHROW. The throw is the contract: this function does not decide what a
    // failure means, and its two callers implement the page's opposite answers
    // (fail-open at startup, fail-closed under `forceRemoteSettingsRefresh`).
    // Publishing first is what gives the doctor — and every `onManagedDeliveryChange`
    // listener — something to read, without changing either answer.
    publish(Object.freeze({
      ...session.state,
      fetchError: Object.freeze({
        cause: error instanceof Error ? error.message : String(error),
        at: now,
      }),
    }))
    throw error
  } finally {
    session.inflight = null
  }
}

/**
 * Apply the managed `env` block for the CURRENT state.
 *
 * This is the ONLY production application of a managed `env` block, which is
 * why the composed block has to arrive here rather than at a second call site.
 * The comment this replaced said the host-owned policy FILE "goes through
 * `applyManagedEnv` with `source: 'managed-file'` at its own call site" — that
 * call site did not exist. Measured on 2026-08-28: `managed-file` occurred four
 * times outside tests, all of them a type member or prose, so a file-tier `env`
 * block was parsed, validated, drop-reported and carried on the composed policy
 * without ever reaching a process environment.
 *
 * With a composition registered, the block is the per-variable merge of both
 * admin sources and each variable's withhold is decided against its own origin:
 * delivered variables keep `server-managed-settings.md#fetch-and-caching-behavior`'s hardening, file variables are never
 * withheld because `server-managed-settings.md#fetch-and-caching-behavior` scopes that hardening to the server-fetched cache.
 *
 * The composition re-reads the delivered half through
 * `getDeliveredManagedPolicy()` rather than taking `state.policy.env` from the
 * caller, so the merge has ONE definition (`composeManagedPolicySources`) with
 * two readers — the arrangement `managed-policy-resolution.ts` insists on, and
 * whose absence let the delivered policy be composed on one path and enforced
 * on another. The two inputs agree wherever the live state carries settings,
 * because that is the object `getDeliveredManagedPolicy` returns first; where it
 * does not, the composition falls back to the approval-gated cache, which is
 * `server-managed-settings.md#fetch-and-caching-behavior`'s "Cached settings apply immediately at startup" and is still withheld
 * by `state.confirmed` being false in exactly that window.
 *
 * With none registered — every host that does not call
 * `registerEnforcedManagedPolicyProvider`, and every test — this is exactly the
 * previous behaviour: the delivered payload alone, under `source:
 * 'server-cache'`, whether the payload came off disk or off the wire, because
 * `server-managed-settings.md#fetch-and-caching-behavior` scopes the hardening to the cache as a SOURCE and not to the moment of
 * reading it.
 */
export function applyManagedDeliveryEnv(
  state: ManagedDeliveryStateV1 = getManagedDeliveryState(),
  target?: Record<string, string | undefined>,
): ManagedEnvApplicationV1 {
  const composed = resolveComposedManagedEnvSources()
  if (composed !== undefined) {
    return applyComposedManagedEnv(composed, {
      confirmed: state.confirmed,
      ...(target === undefined ? {} : { target }),
    })
  }
  return applyManagedEnv(state.policy.env, {
    source: 'server-cache',
    confirmed: state.confirmed,
    ...(target === undefined ? {} : { target }),
  })
}

/**
 * Apply now and on every later state change. The second application is what
 * `server-managed-settings.md#fetch-and-caching-behavior` describes — "Once the server confirms the payload, and you approve it if it
 * needs security approval, the withheld variables apply for
 * the rest of the session" — and it happens without a restart because the
 * confirming fetch publishes a new state.
 */
export function startManagedDeliveryEnvApplication(
  target?: Record<string, string | undefined>,
): () => void {
  applyManagedDeliveryEnv(getManagedDeliveryState(), target)
  return onManagedDeliveryChange(state => {
    applyManagedDeliveryEnv(state, target)
  })
}

/**
 * The sign-in hook (`:9`). Called by `ensureNessyGatewayAuth()` on every
 * successful authentication — cached creds, env bypass, and a fresh dp login
 * alike, because all three are "the user authenticated".
 *
 * Deliberately fire-and-forget and deliberately silent on failure: `server-managed-settings.md#fetch-and-caching-behavior`
 * fetches asynchronously and `server-managed-settings.md#fetch-and-caching-behavior` continues without managed settings when the
 * fetch fails. Sign-in must not fail because an org has no settings endpoint.
 */
export function onNessyGatewayAuthenticated(jwt: string): void {
  if (!session.enabled) return
  void refreshManagedDelivery({ jwt }).catch(() => {
    // `server-managed-settings.md#fetch-and-caching-behavior` — continue without managed settings.
  })
}
