/**
 * The Pi harness event exporter, over OTLP/HTTP logs.
 *
 * The doc contract, from `monitoring-usage.md` fetched with `curl`:
 *
 * - `:94` — `CLAUDE_CODE_ENABLE_TELEMETRY`, "Enables telemetry collection
 *   (required)". Required means required, and it is required of every signal:
 *   this exporter keyed solely on `OTEL_EXPORTER_OTLP_ENDPOINT`, which is ambient
 *   in many corporate shells for other tools, so a machine that never opted in
 *   shipped harness events. The predicate is imported from the metrics exporter —
 *   one gate, both signals — so the two can never disagree about what "opted in"
 *   means (`NESSY_ENABLE_TELEMETRY` primary, the documented Claude name as compat
 *   alias).
 * - `:96` — `OTEL_LOGS_EXPORTER`, "Logs/events exporter types, comma-separated.
 *   Use `none` to disable". Honored as a hard disable, opt-in or not. This is the
 *   logs signal's own selector: `OTEL_METRICS_EXPORTER=none` does NOT silence it,
 *   and `:78` says so explicitly — the selectors "follow normal per-key
 *   precedence".
 * - `env-vars.md#variables` — the standard opt-out vocabulary (`DO_NOT_TRACK`,
 *   `DISABLE_TELEMETRY`, `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`). Honored
 *   as a hard disable over the opt-in, through the shared `telemetryOptedOut`.
 *   Nothing read it before 2026-08-28, so a Pi user who had opted out of
 *   telemetry machine-wide still shipped harness events.
 * - `:102` — `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT`, "OTLP logs endpoint, overrides
 *   general setting". Its documented example value already ends in `/v1/logs`, so
 *   a per-signal endpoint is used with its path as given and only the general
 *   endpoint gets the signal path appended — the same rule the metrics exporter
 *   applies to `:100`.
 *
 * **What a record here can and cannot carry.** The body is one of six event names
 * from a closed set; the attributes are `schemaVersion`, two HMAC-SHA256 digests
 * of the workspace and session ids under a locally generated salt, an `outcome`
 * from a four-value enum, an integer duration, `semanticId`, and — **since
 * P6.538, and only when an operator sets the documented
 * `OTEL_METRICS_INCLUDE_SESSION_ID`** — the session's own id in the clear,
 * exported under the page's own `session.id` attribute name. Owner decision
 * 2026-09-05 D13 = option B: identity behind the documented toggles, DEFAULT
 * OFF, so with the switch unset a record is byte-identical to what shipped
 * before. The digest mode is not replaced by it: `sessionHash` is stamped either
 * way, so nothing an existing dashboard groups by moves. There is no
 * `enduser.id` counterpart here and it is not an omission — this fork holds no
 * account identity for a Pi session, so there is nothing to name. Still: no
 * prompt text, no assistant text, no tool payload, no path, no header value, no
 * account. That
 * is enforced, not documented: `validEvent` drops any record with an unexpected
 * key (`exact(input, EVENT_KEYS)`) and `SAFE_ID` admits only
 * `[A-Za-z0-9][A-Za-z0-9._:@-]*`, which no filesystem path can satisfy — `/` and
 * `\` are both outside the class. `monitoring-usage.md`'s content channels
 * (`OTEL_LOG_USER_PROMPTS`, `OTEL_LOG_ASSISTANT_RESPONSES`,
 * `OTEL_LOG_TOOL_DETAILS`, `OTEL_LOG_TOOL_CONTENT`, `OTEL_LOG_RAW_API_BODIES` —
 * FIVE, and cited by name rather than by the line numbers this sentence used to
 * carry, which had already moved) are not implemented here at all, so there is
 * no flag that could widen this to conversation content.
 *
 * **And since P6.539 that is true of the CLAUDE child too, which it was not.**
 * This paragraph only ever spoke for the stream below; the claude subprocess got
 * the host's whole environment through `agent/options.ts`'s
 * `buildClaudeSubprocessEnv`, and the binary implements all five channels, so an
 * ambient `OTEL_LOG_RAW_API_BODIES=1` in an operator's login shell exported
 * every turn of every claude session — *"Bodies include the entire conversation
 * history"* — with nothing in this product saying so. All five are now dropped
 * from that environment by name, each with its own diagnostic line. Owner
 * decision 2026-09-05 (D14): a working vendor capability removed deliberately,
 * because content export must be an explicit host setting and never an inherited
 * variable. codex is pinned the same way from the other side
 * (`log_user_prompt = false`, written unconditionally by
 * `codex-responses-adapter/src/config-writer.ts`), so no runtime of the three
 * can be talked into it by the environment.
 *
 * **Why this stream is Pi-only while its metrics sibling deliberately is not**
 * (P6.42, 2026-08-30 — asserted in three places before this, reasoned in none).
 *
 * The gate is one line in another file: `SessionManager.emitPiTelemetry`'s
 * `if (this.resolveManagedProvider(managed) !== 'pi') return`. Two comments call
 * it "by design" — the `recordUsageMetrics` call site in `SessionManager.ts` and
 * the `usageMetrics` docblock in `bootstrap/storage-runtime.ts` — and BOTH were
 * written a week later, by the usage-metrics task (`1e1ecb67d4`, 2026-07-30),
 * about code the OTLP task (`e9f6f70bc2`, 2026-07-23) had already shipped. The
 * introducing commit, its plan task ("Redacted OTLP telemetry" in
 * `docs/current-plans/pi-claude-post-parity.md`, which specifies the six event
 * names and never mentions a provider) and its tests record no reason at all. So
 * "by design" is a later observer's gloss, not the author's decision: read as
 * ORIGIN, this gate is scope hygiene rather than policy.
 *
 * Read as PRESENT EFFECT it is load-bearing, and THAT is what nobody wrote down.
 * Measured over the four `emitPiTelemetry` call sites, three cannot be reached
 * by a non-Pi session at all, each behind its own independent guard:
 * `onExecutionReceipt: provider === 'pi' ? … : undefined` plus every plugin hook
 * runner's own `!== 'pi'` early return (`tool.completed`, `mcp.completed`,
 * `hook.completed`), `piPermissionService = provider === 'pi' ? … : undefined`
 * (`permission.decided`), and `wasForegroundPiTurn = … === 'pi'`
 * (`session.settled`). Exactly ONE site is provider-independent:
 * `setProcessing`'s rising edge, which mints `session.started`.
 *
 * So removing the gate would not widen this stream to the other providers — it
 * would ship them ONE of the six names. `ModelProvider` is a four-value union,
 * so `!== 'pi'` excludes THREE: `anthropic`, `codex-runtime` and
 * `nestor-cloud-agent`. A SIEM would show every one of their sessions starting
 * and never settling, with zero `permission.decided` and zero `tool.completed`,
 * while they DO make permission decisions, through the host's own
 * provider-independent `handleAgentPermissionRequest`. An audit absence that
 * reads as "nothing happened" is worse than no stream, so the gate stays until a
 * producer exists for the other five names.
 *
 * This module cannot enforce that itself — a record never learns which runtime
 * it came from — so the coverage rides the OTLP RESOURCE instead, as
 * `nessy.telemetry.coverage = pi-sessions-only`. That is what makes the residual
 * difference honest to the OPERATOR rather than only to the next reader of this
 * file: a SIEM query that returns nothing for a claude team now carries its own
 * explanation. Neither OTel nor `monitoring-usage.md` specifies such a key;
 * chosen under AGENTS.md's transparent-and-simple rule and pinned by the exact
 * resource assertion in this module's tests.
 *
 * **Native-first (AGENTS.md), asked before anyone proposes to build.** Claude
 * already HAS this mechanism, in the binary we ship. Probed with `grep -ac` over
 * `@anthropic-ai/claude-agent-sdk-darwin-arm64/claude`:
 * `CLAUDE_CODE_ENABLE_TELEMETRY` 14, `OTEL_LOGS_EXPORTER` 22,
 * `OTEL_EXPORTER_OTLP_ENDPOINT` 13, and the three event names this row asks for
 * — `tool_decision` 6, `user_prompt` 11, `tool_result` 830 — against a nonsense
 * negative control at 0 on the same rig. `monitoring-usage.md` carries them
 * under §"Audit security events" and §"Send events to a SIEM". The claude answer
 * is therefore CONFIGURE, never BUILD: `buildClaudeSubprocessEnv` already
 * spreads `process.env`, so an operator's `OTEL_*` reaches the child. One null
 * recorded rather than invented — the gateway path writes
 * `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1'`, whose `env-vars.md` row says
 * it disables "telemetry", while `monitoring-usage.md` never names that variable
 * at all; whether it also silences the native OTLP export is settled by neither
 * page and was not measured here.
 *
 * One trap for whoever builds the missing producers (out-of-scope register O16,
 * measured 2026-08-29): a guardian DENY mints a receipt with no `guardian-*`
 * marker in `additionalContext` while a guardian ALLOW does, so a consumer that
 * FILTERS receipts on `additionalContext` silently drops every guardian denial —
 * the events an audit stream exists for. This stream does not have that defect:
 * `projectPiPermissionTelemetry` reads `receipt.outcome` and
 * `receipt.binding.semanticId` and nothing else, so a denial lands as
 * `permission.decided` with `outcome: 'denied'` either way. Keep it that way.
 */

import { createHmac, randomBytes } from 'node:crypto'
import type { PiTelemetryEventV1 } from '@nessy-agent/shared/agent/pi-harness/execution-observability'
import type { CredentialManager } from '@nessy-agent/shared/credentials'
import type { SessionKey } from '@nessy-agent/shared/sessions'
import { readFileSync } from 'node:fs'
import {
  otelExporterDisabled,
  otlpFailureReason,
  otlpResourceAttributes,
  otlpTlsFetchOptions,
  reportOtlpExportFailure,
  resolveOtlpClientTls,
  resolveTelemetryIdentity,
  telemetryOptedIn,
  telemetryOptedOut,
  type OtlpClientTls,
  type TelemetryIdentitySelection,
} from '@nessy-agent/shared/telemetry/usage-metrics'

const MAX_QUEUE = 1000
const BATCH_SIZE = 100
const DEFAULT_TIMEOUT_MS = 10_000
const MAX_TIMEOUT_MS = 2_147_483_647
const SALT = /^[0-9a-f]{64}$/
const HASH = /^[0-9a-f]{64}$/
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@-]*$/
/** What this stream covers, stated on every batch's OTLP resource. See the module docblock. */
const PI_SESSION_COVERAGE = 'pi-sessions-only'
const EVENT_NAMES = new Set<PiTelemetryEventV1['name']>([
  'session.started',
  'session.settled',
  'tool.completed',
  'permission.decided',
  'mcp.completed',
  'hook.completed',
])
const OUTCOMES = new Set<NonNullable<PiTelemetryEventV1['outcome']>>([
  'success',
  'error',
  'denied',
  'cancelled',
])
const INPUT_KEYS = new Set(['schemaVersion', 'name', 'timestamp', 'outcome', 'durationMs', 'semanticId'])
// P6.538 · `sessionId` is added HERE, deliberately and in the same commit that
// starts emitting it. `validEvent` runs `exact(input, EVENT_KEYS)` and DROPS any
// record carrying an unexpected key — silently, because telemetry is
// best-effort — so widening the producer without widening this set would turn
// the whole Pi stream off the moment the toggle was flipped, and look like a
// quiet week. Any future field owes the same pair of edits.
// C3.292 · `promptId` is added HERE for the same reason and with the same pair
// of edits the note above demands. It is an EXPORTER-filled attribute, like
// `sessionId`: no caller puts it on the event, so `INPUT_KEYS` is deliberately
// unchanged.
const EVENT_KEYS = new Set(['schemaVersion', 'name', 'timestamp', 'workspaceHash', 'sessionHash', 'sessionId', 'promptId', 'outcome', 'durationMs', 'semanticId'])

/**
 * C3.292 — a completed record: the SHARED event shape plus the one attribute
 * this exporter fills that the shared type does not declare.
 *
 * `PiTelemetryEventV1` (`@nessy-agent/shared/agent/pi-harness/execution-observability`)
 * is a CALLER-facing contract — what a producer hands `emit` — and `prompt.id`
 * is never handed in: it is read off the live agent at the one emit site and
 * stamped here, exactly as `sessionId` is. Widening the caller contract for a
 * field no caller may set would invite callers to set it.
 */
type PiTelemetryRecordV1 = PiTelemetryEventV1 & { promptId?: string }

/**
 * C3.292 — who a record belongs to, and which prompt produced it.
 *
 * `monitoring-usage.md#event-correlation-attributes`: *"UUID v4 identifier
 * linking all events produced while processing a single user prompt"*, and
 * `#standard-attributes`' following paragraph makes it EVENT-only in as many
 * words — *"Events additionally include the following attributes. These are
 * never attached to metrics because they would cause unbounded cardinality."*
 * So this stream is where it belongs and the metrics exporter is where it is
 * REFUSED; `telemetry/usage-metrics.ts` carries that refusal beside its own
 * attribute set.
 *
 * Optional, and absent is the ordinary state: the id is minted at the top of
 * `BaseAgent.chat`, so anything emitted before the first user input — a
 * `session.started` on a cold session — carries no attribute rather than an id
 * for a prompt that does not exist. That is the page's *"Absent until the first
 * user input"* honoured by construction rather than by a test.
 */
export interface PiTelemetryEmitContext extends SessionKey {
  promptId?: string
}

export interface PiOtlpTelemetry {
  emit(session: PiTelemetryEmitContext, event: Omit<PiTelemetryEventV1, 'workspaceHash' | 'sessionHash'>): void
  shutdown(): Promise<void>
}

type TelemetryCredentialManager = Pick<CredentialManager, 'get' | 'set'>

export interface OtlpConfig {
  /**
   * P6.538 · whether this stream may name a session, resolved ONCE from the
   * documented switches by `resolveTelemetryIdentity` and shared with the
   * metrics exporter and with the claude child's environment — so an operator
   * who turns identity on gets the same answer from all three runtimes rather
   * than three different ones.
   *
   * `accountUuid` has no Pi counterpart and is carried anyway rather than
   * dropped at this boundary: the resolution is one object, and a leaf that
   * silently narrows it is how two runtimes come to disagree about what one
   * switch meant. Pi honours the half it can answer.
   */
  identity: TelemetryIdentitySelection
  url: string
  headers: Headers
  timeoutMs: number
  /** P6.452 M39 — the operator's client certificate, already read off disk. */
  tls?: OtlpClientTls
  /** P6.452 M32 — the resource an administrator queries by. */
  resourceAttributes: Array<{ key: string; value: { stringValue: string } }>
}

export async function createPiOtlpTelemetry(
  credentialManager: TelemetryCredentialManager,
): Promise<PiOtlpTelemetry | undefined> {
  const config = parseConfig()
  if (!config) return undefined

  const salt = await loadSalt(credentialManager)
  return salt ? new OtlpTelemetry(config, salt) : undefined
}

class OtlpTelemetry implements PiOtlpTelemetry {
  private readonly queue: PiTelemetryRecordV1[] = []
  private flushPromise: Promise<void> | undefined
  private flushScheduled = false
  private closed = false

  constructor(
    private readonly config: OtlpConfig,
    private readonly salt: Buffer,
  ) {}

  emit(session: PiTelemetryEmitContext, event: Omit<PiTelemetryEventV1, 'workspaceHash' | 'sessionHash'>): void {
    if (this.closed) return
    try {
      const record = this.completeEvent(session, event)
      if (!record) return
      if (this.queue.length >= MAX_QUEUE) this.queue.shift()
      this.queue.push(record)
      this.scheduleFlush()
    } catch {
      // Telemetry is best-effort and must not affect agent work.
    }
  }

  async shutdown(): Promise<void> {
    this.closed = true
    await this.flush()
  }

  private completeEvent(
    session: PiTelemetryEmitContext,
    event: Omit<PiTelemetryEventV1, 'workspaceHash' | 'sessionHash'>,
  ): PiTelemetryRecordV1 | undefined {
    const input = record(event)
    if (!input || !exact(input, INPUT_KEYS)) return undefined
    if (typeof session.workspaceId !== 'string' || typeof session.sessionId !== 'string') return undefined
    const completed: PiTelemetryRecordV1 = {
      ...(input as Omit<PiTelemetryEventV1, 'workspaceHash' | 'sessionHash'>),
      workspaceHash: this.hash(`nessy.telemetry.workspace.v1\0${session.workspaceId}`),
      sessionHash: this.hash(`nessy.telemetry.session.v1\0${session.workspaceId}\0${session.sessionId}`),
      // P6.538 · the second, NON-ANONYMOUS mode this exporter gained, and it is
      // ADDITIVE: the digest above is still stamped, so nothing an existing
      // dashboard groups by changes. Off by default; `validEvent` refuses an id
      // that is not `SAFE_ID`-shaped, which is the same guard `semanticId` has
      // and is what keeps a path from ever arriving here as an "id".
      ...(this.config.identity.sessionId ? { sessionId: session.sessionId } : {}),
      // C3.292 · UNCONDITIONAL, unlike `sessionId` above, and that difference is
      // the decision rather than an oversight. `sessionId` sits behind
      // `OTEL_METRICS_INCLUDE_SESSION_ID` because it names a session in the
      // clear; a `prompt.id` is a v4 UUID minted per turn that names no user, no
      // account, no workspace and no content, and the page gives it no switch of
      // its own. Under owner decision 2026-09-05 D13 it is admissible on either
      // arm, so it follows the page: present whenever there is a prompt.
      ...(session.promptId ? { promptId: session.promptId } : {}),
    }
    return validEvent(completed) ? completed : undefined
  }

  private hash(value: string): string {
    return createHmac('sha256', this.salt).update(value).digest('hex')
  }

  private scheduleFlush(): void {
    if (this.flushScheduled || this.flushPromise) return
    this.flushScheduled = true
    queueMicrotask(() => {
      this.flushScheduled = false
      void this.flush()
    })
  }

  private flush(): Promise<void> {
    if (this.flushPromise) return this.flushPromise
    const operation = this.drain().catch(() => undefined)
    this.flushPromise = operation
    void operation.then(() => {
      if (this.flushPromise !== operation) return
      this.flushPromise = undefined
      if (this.queue.length > 0 && !this.closed) this.scheduleFlush()
    })
    return operation
  }

  private async drain(): Promise<void> {
    while (this.queue.length > 0) {
      const batch = this.queue.splice(0, BATCH_SIZE)
      await this.post(batch)
    }
  }

  private async post(batch: readonly PiTelemetryRecordV1[]): Promise<void> {
    const body = JSON.stringify(otlpPayload(batch, this.config.resourceAttributes))
    try {
      const response = await this.request(body)
      // P6.452 M28 — this line used to be a bare `return`, so EVERY non-429,
      // non-5xx answer counted as delivery: a collector replying 401 or 404
      // looked exactly like one accepting the batch. The retry policy is
      // unchanged (429 and 5xx only, once); what is new is that anything else
      // that is not `ok` is reported and counted instead of being swallowed.
      if (response.status !== 429 && (response.status < 500 || response.status > 599)) {
        if (!response.ok) {
          reportOtlpExportFailure({
            signal: 'logs',
            status: response.status,
            endpoint: this.config.url,
            reason: otlpFailureReason(response.status),
          })
        }
        return
      }
    } catch {
      reportOtlpExportFailure({ signal: 'logs', endpoint: this.config.url, reason: 'transport' })
      return
    }
    try {
      const retry = await this.request(body)
      if (!retry.ok) {
        reportOtlpExportFailure({
          signal: 'logs',
          status: retry.status,
          endpoint: this.config.url,
          reason: otlpFailureReason(retry.status),
        })
      }
    } catch {
      // One retry only.
      reportOtlpExportFailure({ signal: 'logs', endpoint: this.config.url, reason: 'transport' })
    }
  }

  private request(body: string): Promise<Response> {
    return fetch(this.config.url, {
      method: 'POST',
      headers: this.config.headers,
      body,
      signal: AbortSignal.timeout(this.config.timeoutMs),
      ...otlpTlsFetchOptions(this.config.tls, reason => reportOtlpExportFailure({
        signal: 'logs', endpoint: this.config.url, reason,
      })),
    })
  }
}

/**
 * Exported for the gate's own tests: the seam where an ambient endpoint either
 * does or does not become an exporter. `env` defaults to the process env, which
 * is what production passes.
 */
export function parseConfig(env: Record<string, string | undefined> = process.env): OtlpConfig | undefined {
  // The standard opt-out (`DO_NOT_TRACK` / `DISABLE_TELEMETRY` /
  // `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`) beats every other signal here,
  // and it is imported from the metrics exporter for the same reason
  // `telemetryOptedIn` is: one predicate, both signals, so the two can never
  // disagree about what a user's opt-out means. This exporter is Pi's own —
  // which is why the opt-out is NOT a claude-runtime concern.
  if (telemetryOptedOut(env)) return undefined
  // `:94`. The opt-in gates everything: an ambient endpoint alone starts nothing.
  if (!telemetryOptedIn(env)) return undefined
  // `:96`. The logs selector's own `none` beats even an explicit opt-in.
  if (otelExporterDisabled(env, 'OTEL_LOGS_EXPORTER')) return undefined
  // `:102` — the per-signal endpoint "overrides general setting", and its
  // documented example already carries `/v1/logs`.
  const logsEndpoint = env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT?.trim()
  const rawEndpoint = logsEndpoint || env.OTEL_EXPORTER_OTLP_ENDPOINT
  if (!rawEndpoint?.trim()) return undefined
  try {
    const endpoint = new URL(rawEndpoint)
    if ((endpoint.protocol !== 'http:' && endpoint.protocol !== 'https:') || endpoint.username || endpoint.password) {
      return undefined
    }
    endpoint.search = ''
    endpoint.hash = ''
    if (!logsEndpoint) {
      endpoint.pathname = `${endpoint.pathname.replace(/\/+$/, '')}/v1/logs`
    }
    const headers = parseHeaders(env.OTEL_EXPORTER_OTLP_HEADERS)
    if (!headers) return undefined
    headers.set('Content-Type', 'application/json')
    const url = endpoint.toString()
    const tls = resolveOtlpClientTls(
      env,
      path => readFileSync(path, 'utf8'),
      reason => reportOtlpExportFailure({ signal: 'logs', endpoint: url, reason }),
    )
    return {
      url,
      headers,
      tls,
      // P6.461 — `otlpResourceAttributes` also stamps
      // `nessy.metric.namespace.upstream = claude_code` on every resource this
      // exporter sends. That is the rename stated where an operator building a
      // dashboard meets it: `monitoring-usage.md#metrics` publishes
      // `claude_code.*` and this fork emits `nessy.*`, so a dashboard built
      // straight from the page matches nothing and says nothing about why. The
      // six-row parity, including which of the page's metrics we refuse and the
      // reason, is the exported `FLEET_METRIC_PARITY` record (rows typed by
      // `FleetMetricParity`) in `packages/shared/src/telemetry/usage-metrics.ts`.
      // C3.322, 2026-09-12: this sentence and its twin in that same file both
      // named `describeFleetMetricParity`, a name declared in no file at all.
      resourceAttributes: otlpResourceAttributes(env, {
        key: 'nessy.telemetry.coverage',
        value: PI_SESSION_COVERAGE,
      }),
      timeoutMs: parseTimeout(env.OTEL_EXPORTER_OTLP_TIMEOUT),
      identity: resolveTelemetryIdentity(env),
    }
  } catch {
    return undefined
  }
}

function parseHeaders(raw: string | undefined): Headers | undefined {
  const headers = new Headers()
  if (!raw?.trim()) return headers
  for (const entry of raw.split(',')) {
    const separator = entry.indexOf('=')
    if (separator < 1) return undefined
    const key = entry.slice(0, separator).trim()
    if (!key) return undefined
    let value: string
    try {
      value = decodeURIComponent(entry.slice(separator + 1).trim())
    } catch {
      return undefined
    }
    try {
      headers.set(key, value)
    } catch {
      return undefined
    }
  }
  return headers
}

function parseTimeout(raw: string | undefined): number {
  if (raw && /^[1-9]\d*$/.test(raw)) {
    const value = Number(raw)
    if (Number.isSafeInteger(value) && value <= MAX_TIMEOUT_MS) return value
  }
  return DEFAULT_TIMEOUT_MS
}

async function loadSalt(credentialManager: TelemetryCredentialManager): Promise<Buffer | undefined> {
  try {
    const id = { type: 'telemetry_salt' as const }
    const stored = await credentialManager.get(id)
    if (stored && !SALT.test(stored.value)) return undefined
    const value = stored?.value ?? randomBytes(32).toString('hex')
    if (!stored) await credentialManager.set(id, { value })
    return Buffer.from(value, 'hex')
  } catch {
    return undefined
  }
}

function validEvent(value: PiTelemetryRecordV1): boolean {
  const input = record(value)
  return !!input
    && exact(input, EVENT_KEYS)
    && input.schemaVersion === 1
    && typeof input.name === 'string'
    && EVENT_NAMES.has(input.name as PiTelemetryEventV1['name'])
    && integer(input.timestamp)
    && typeof input.workspaceHash === 'string'
    && HASH.test(input.workspaceHash)
    && typeof input.sessionHash === 'string'
    && HASH.test(input.sessionHash)
    && (input.sessionId === undefined || (typeof input.sessionId === 'string' && input.sessionId.length <= 256 && SAFE_ID.test(input.sessionId)))
    // C3.292 · the same guard `sessionId` and `semanticId` get. A v4 UUID is
    // `SAFE_ID`-shaped; a path is not, and cannot become one by being called an
    // "id".
    && (input.promptId === undefined || (typeof input.promptId === 'string' && input.promptId.length <= 256 && SAFE_ID.test(input.promptId)))
    && (input.outcome === undefined || (typeof input.outcome === 'string' && OUTCOMES.has(input.outcome as NonNullable<PiTelemetryEventV1['outcome']>)))
    && (input.durationMs === undefined || integer(input.durationMs))
    && (input.semanticId === undefined || (typeof input.semanticId === 'string' && input.semanticId.length <= 256 && SAFE_ID.test(input.semanticId)))
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function exact(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every(key => allowed.has(key))
}

function integer(value: unknown): boolean {
  return Number.isSafeInteger(value) && (value as number) >= 0
}

function otlpPayload(
  events: readonly PiTelemetryRecordV1[],
  // P6.452 M32 — `service.name` was the hardcoded literal `nessy-desktop` and
  // an operator's `OTEL_RESOURCE_ATTRIBUTES` reached nothing here. Both now
  // arrive built, with `nessy.telemetry.coverage` appended last and NOT
  // overridable by an operator pair — see `otlpResourceAttributes`. P6.42's
  // reason for the marker is unchanged: `SessionManager.emitPiTelemetry` gates
  // on the Pi provider, so an anthropic, codex-runtime or nestor-cloud-agent
  // session contributes NOTHING here, and a SIEM cannot tell that from a quiet
  // week.
  resourceAttributes: Array<{ key: string; value: { stringValue: string } }>,
) {
  return {
    resourceLogs: [{
      resource: { attributes: resourceAttributes },
      scopeLogs: [{
        scope: { name: 'nessy.pi-harness' },
        logRecords: events.map(event => ({
          timeUnixNano: String(BigInt(event.timestamp) * 1_000_000n),
          body: { stringValue: event.name },
          attributes: [
            attribute('schemaVersion', '1'),
            attribute('workspaceHash', event.workspaceHash),
            attribute('sessionHash', event.sessionHash),
            // P6.538 · the PAGE's own attribute name, not one of ours:
            // `monitoring-usage.md#standard-attributes` lists `session.id` —
            // "Unique session identifier". A backend that already groups claude
            // exports by that key groups these the same way, which is the whole
            // point of adopting the vendor's spelling rather than inventing
            // `nessy.session.id` beside it.
            ...(event.sessionId === undefined ? [] : [attribute('session.id', event.sessionId)]),
            // C3.292 · the PAGE's own attribute name again, not one of ours:
            // `monitoring-usage.md#event-correlation-attributes` spells it
            // `prompt.id`, and the hook input field that must match it
            // (`hooks.md`'s `prompt_id`, filled by `BaseAgent.withPromptId`)
            // says so itself — "Matches the `prompt.id` attribute on
            // OpenTelemetry events, so you can correlate hook output with
            // telemetry for a single prompt." A different spelling here would
            // make that sentence false in this product.
            ...(event.promptId === undefined ? [] : [attribute('prompt.id', event.promptId)]),
            ...(event.outcome === undefined ? [] : [attribute('outcome', event.outcome)]),
            ...(event.durationMs === undefined ? [] : [attribute('durationMs', String(event.durationMs))]),
            ...(event.semanticId === undefined ? [] : [attribute('semanticId', event.semanticId)]),
          ],
        })),
      }],
    }],
  }
}

function attribute(key: string, stringValue: string) {
  return { key, value: { stringValue } }
}
