/**
 * P3.53 — the arming path for the OTLP signals the host builds once.
 *
 * Two of them when this was written, three since P6.882 added the span source.
 * The third is the one that holds STATE across a swap, and the class docblock on
 * {@link RearmingHostTracer} carries that decision.
 *
 * ## The row, and the half W2-g left
 *
 * A managed `env` block can deliver `OTEL_EXPORTER_OTLP_ENDPOINT`, which our
 * classification calls `immediate`. W2-g corrected the premise and pinned the
 * ordering: `immediate` is OUR name for
 * `server-managed-settings.md#fetch-and-caching-behavior`'s remainder rule —
 * *"Every other key in the cached `env` block, such as telemetry and
 * OpenTelemetry configuration, applies at startup as before"* — so it is a
 * STARTUP promise and both hosts keep it, applying the cached block before
 * `createStorageRuntime` runs.
 *
 * Two cases were left genuinely uncovered, and this module is them:
 *
 *  - a **first launch with no cache**, where the delivered block arrives on the
 *    sign-in hook or the hourly poll — after bootstrap. Until now the exporters
 *    had already been built from an environment with no endpoint in it, and
 *    `createStorageRuntime` had handed `undefined` to the session manager, so
 *    the administrator's endpoint could not take effect until a restart;
 *  - any later **change** to the endpoint, which reached `process.env` and not
 *    the two live objects.
 *
 * ## Why a facade rather than a rebuild
 *
 * `SessionManager` captures both objects as `private readonly` fields at
 * construction. Rebuilding them in `createStorageRuntime` would therefore not
 * reach the consumer at all — the swap has to happen BEHIND a reference that
 * never changes. So each exporter is handed over as a stable facade that
 * forwards to a delegate, and arming replaces the delegate.
 *
 * The facades are handed over **unconditionally**, including when telemetry is
 * off at boot, and that is what covers the first-launch case: a conditional
 * facade could never be turned on later, because the session manager would have
 * been given `undefined`. With no delegate every method is a no-op, so a host
 * that never opts in behaves exactly as before.
 *
 * ## The swap order is the part that must not be got wrong
 *
 * Install the new delegate FIRST, then drain the old one. Both exporters'
 * `shutdown()` awaits a final flush, so the in-flight batch is exported rather
 * than dropped, and no event emitted during that drain is lost — it goes to the
 * new delegate. Draining first would leave a window with no exporter.
 *
 * ## When it arms
 *
 * On a managed-delivery publish, and only when the `immediate` slice of the
 * environment actually changed. The key set is read from
 * `managedEnvCategoryMembers('immediate')` — the classification's own list,
 * never a copy of it here: this repo has paid repeatedly for a second
 * enumeration beside a single source of truth. A key the classification does
 * NOT call `immediate` is by definition not promised immediate application, so
 * not arming on it is the correct answer rather than a gap.
 *
 * Listeners are notified in registration order and a throw inside one is
 * swallowed by `publish`, so this cannot break the delivery flow; it registers
 * after `startManagedDeliveryEnvApplication`, which is what makes the snapshot
 * it reads the post-application environment.
 */
import { managedEnvCategoryMembers } from '@nessy-agent/shared/config/managed-env'
import { NOOP_HOST_SPAN } from '@nessy-agent/shared/telemetry/host-tracer'
import type {
  HostSpanOptions,
  HostSpanStatus,
  HostTelemetrySpan,
  HostSpanAttributeValue,
  HostTracer,
} from '@nessy-agent/shared/telemetry/host-tracer'
import type { FleetCounterEvent, UsageMetrics, UsageMetricsTurn } from '@nessy-agent/shared/telemetry/usage-metrics'
import type { PiOtlpTelemetry, PiTelemetryEmitContext } from '../pi-harness/otlp-telemetry'
import type { PiTelemetryEventV1 } from '@nessy-agent/shared/agent/pi-harness/execution-observability'

/** A facade whose delegate can be replaced without changing the reference. */
interface Rearmable<T> {
  replace(next: T | undefined): Promise<void>
}

class RearmingPiOtlpTelemetry implements PiOtlpTelemetry, Rearmable<PiOtlpTelemetry> {
  constructor(private delegate: PiOtlpTelemetry | undefined) {}

  // C3.292 — `PiTelemetryEmitContext` rather than `SessionKey`: the emit context
  // now carries the prompt this record belongs to, and a narrower parameter here
  // would pass it through at runtime while telling every reader it does not.
  emit(session: PiTelemetryEmitContext, event: Omit<PiTelemetryEventV1, 'workspaceHash' | 'sessionHash'>): void {
    this.delegate?.emit(session, event)
  }

  async shutdown(): Promise<void> {
    const previous = this.delegate
    this.delegate = undefined
    await previous?.shutdown()
  }

  async replace(next: PiOtlpTelemetry | undefined): Promise<void> {
    const previous = this.delegate
    // New delegate first: an event emitted while the old one drains lands here.
    this.delegate = next
    await previous?.shutdown()
  }
}

class RearmingUsageMetrics implements UsageMetrics, Rearmable<UsageMetrics> {
  constructor(private delegate: UsageMetrics | undefined) {}

  record(turn: UsageMetricsTurn): void {
    this.delegate?.record(turn)
  }

  /** P6.461 — the adoption counters, forwarded exactly as `record` is. */
  count(event: FleetCounterEvent): void {
    this.delegate?.count(event)
  }

  async flush(): Promise<void> {
    await this.delegate?.flush()
  }

  async shutdown(): Promise<void> {
    const previous = this.delegate
    this.delegate = undefined
    await previous?.shutdown()
  }

  async replace(next: UsageMetrics | undefined): Promise<void> {
    const previous = this.delegate
    this.delegate = next
    await previous?.shutdown()
  }
}

/**
 * P6.882 — the third facade, and the one whose delegate holds STATE across the
 * swap.
 *
 * The other two forward a stateless event: a metrics batch or a log record
 * belongs to whichever exporter is live when it arrives, so `replace` is a
 * pointer write and a drain. A SPAN is open across a whole turn, on the tracer
 * that minted its ids, and the new tracer has never heard of it.
 *
 * The decision (transparent + simple, since no documentation covers it): the
 * in-flight span ENDS at the re-arm, stamped `nessy.telemetry.rearmed = true`,
 * on the OUTGOING delegate — so it is exported to the endpoint that minted it,
 * with an attribute saying the duration is a fragment of a turn rather than the
 * turn. The next `endTurnSpan` for that key reaches the new delegate, where
 * nothing is open, and is the documented no-op.
 *
 * Migrating the span was the alternative and is rejected: it would put half the
 * trace in the old endpoint and half in the new one, joined by a parent nobody
 * can resolve.
 */
class RearmingHostTracer implements HostTracer, Rearmable<HostTracer> {
  constructor(private delegate: HostTracer | undefined) {}

  async startSpan<T>(
    options: HostSpanOptions,
    callback: (span: HostTelemetrySpan) => T | Promise<T>,
  ): Promise<T> {
    // With no delegate the work still runs, exactly as the tracer's own closed
    // state does it: telemetry must never be able to fail what it measures.
    if (!this.delegate) return callback(NOOP_HOST_SPAN as HostTelemetrySpan)
    return this.delegate.startSpan(options, callback)
  }

  currentTraceparent(key?: string): string | undefined {
    return this.delegate?.currentTraceparent(key)
  }

  beginTurnSpan(key: string, options: HostSpanOptions): void {
    this.delegate?.beginTurnSpan(key, options)
  }

  endTurnSpan(key: string, status?: HostSpanStatus): void {
    this.delegate?.endTurnSpan(key, status)
  }

  closeOpenTurnSpans(attributes?: Record<string, HostSpanAttributeValue | undefined>): void {
    this.delegate?.closeOpenTurnSpans(attributes)
  }

  async flush(): Promise<void> {
    await this.delegate?.flush()
  }

  async shutdown(): Promise<void> {
    const previous = this.delegate
    this.delegate = undefined
    await previous?.shutdown()
  }

  async replace(next: HostTracer | undefined): Promise<void> {
    const previous = this.delegate
    // New delegate first, for the other two facades' reason: a turn that begins
    // while the old one drains must open its span on the live tracer.
    this.delegate = next
    // …and the OLD delegate ends what it still holds open, before its drain, so
    // the truncated span is in the batch `shutdown()` flushes rather than lost.
    previous?.closeOpenTurnSpans({ 'nessy.telemetry.rearmed': true })
    await previous?.shutdown()
  }
}

/** Stands where an unset variable would be, so unset and empty are different. */
const UNSET = '<unset>'

/**
 * The values of every `immediate` variable, as one comparable string.
 *
 * Absent and empty are deliberately distinguished: WITHDRAWING an endpoint is a
 * change, and an exporter that kept running after its endpoint was withdrawn
 * would be the opposite of the behaviour this module exists to provide.
 */
export function immediateEnvSnapshot(
  env: Record<string, string | undefined> = process.env,
): string {
  return managedEnvCategoryMembers('immediate')
    .map(name => `${name}=${env[name] ?? UNSET}`)
    .join('\n')
}

export interface OtlpRearmingOptions {
  /** Build a fresh logs exporter from the CURRENT environment. */
  buildPiTelemetry: () => Promise<PiOtlpTelemetry | undefined>
  /** Build a fresh metrics exporter from the CURRENT environment. */
  buildUsageMetrics: () => UsageMetrics | undefined
  /**
   * P6.882 — build a fresh span source from the CURRENT environment.
   *
   * OPTIONAL, unlike its two siblings: a host that never passes one gets a
   * facade with no delegate for the life of the process, which is byte for byte
   * the behaviour every caller had before this row. Only `createStorageRuntime`
   * passes it.
   */
  buildHostTracer?: () => HostTracer | undefined
  /** `onManagedDeliveryChange`, injected so the wiring is testable without a delivery. */
  subscribe: (listener: () => void) => () => void
  /** Injected for tests; defaults to `process.env`. */
  env?: () => Record<string, string | undefined>
  /** One line when an arming actually happens. Optional — silence is the default. */
  onDiagnostic?: (message: string) => void
}

export interface OtlpRearming {
  /** Stable references. Hand THESE to the session manager, never the delegates. */
  piTelemetry: PiOtlpTelemetry
  usageMetrics: UsageMetrics
  /** P6.882 — inert (every method a no-op) until a delegate exists. */
  hostTracer: HostTracer
  /** Unsubscribe. The facades keep working; they simply stop re-arming. */
  stop(): void
  /** Resolves when every arming triggered so far has finished. Tests only. */
  settled(): Promise<void>
}

/**
 * Build both facades and keep them armed against managed-delivery changes.
 *
 * Errors from a rebuild are swallowed on purpose: telemetry is best-effort and
 * an administrator's endpoint typo must not take the host down. The previous
 * delegate is kept in that case rather than being torn down, so a bad delivery
 * degrades to "the old endpoint keeps working" instead of to silence.
 */
export async function startOtlpRearming(options: OtlpRearmingOptions): Promise<OtlpRearming> {
  const readEnv = options.env ?? (() => process.env)
  const piTelemetry = new RearmingPiOtlpTelemetry(await options.buildPiTelemetry())
  const usageMetrics = new RearmingUsageMetrics(options.buildUsageMetrics())
  const hostTracer = new RearmingHostTracer(options.buildHostTracer?.())
  let snapshot = immediateEnvSnapshot(readEnv())
  let arming: Promise<void> = Promise.resolve()

  const unsubscribe = options.subscribe(() => {
    const next = immediateEnvSnapshot(readEnv())
    if (next === snapshot) return
    snapshot = next
    // Serialized: two deliveries in flight would otherwise interleave a build
    // with a drain and could install the older of the two exporters.
    arming = arming.then(async () => {
      try {
        const logs = await options.buildPiTelemetry()
        const metrics = options.buildUsageMetrics()
        const spans = options.buildHostTracer?.()
        await piTelemetry.replace(logs)
        await usageMetrics.replace(metrics)
        await hostTracer.replace(spans)
        options.onDiagnostic?.('[managed-settings] OpenTelemetry exporters re-armed from a delivered env change')
      } catch {
        // Keep the previous delegates: a failed rebuild must not silence a
        // working exporter.
      }
    })
  })

  return { piTelemetry, usageMetrics, hostTracer, stop: unsubscribe, settled: () => arming }
}
