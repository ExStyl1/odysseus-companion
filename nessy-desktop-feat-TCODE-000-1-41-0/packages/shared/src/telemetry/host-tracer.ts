/**
 * P6.732 — the ONE host span source, for three runtimes that each have a
 * tracing seam and none of which has a producer.
 *
 * ## What was missing, measured (P6.459)
 *
 * - **claude** ships a whole span path in the vendored binary and it is now
 *   CONFIGURED (`4a5486a54`), so its spans are the child's own.
 * - **codex** takes an optional `trace: W3cTraceContext` on every app-server
 *   JSON-RPC request — the pinned schema declares it — and we sent nothing.
 * - **Pi** DECLARES the whole span vocabulary (`pi.harness.run/turn/step/tool/
 *   hook/compaction/checkpoint`, `pi.ai.request`) and ships no exporter BY
 *   DESIGN — the host is expected to supply the context.
 *
 * So the three were waiting on the same missing thing: a host object
 * implementing the two-method `TelemetryContext`, minting W3C ids and exporting
 * finished spans. That is this module. Native-first step 1 found a seam on every
 * runtime and a producer on none; step 2 is one producer in the host.
 *
 * ## THE PI SEAM DOES NOT EXIST ON THE PATH THIS FORK USES — measured 2026-09-08
 *
 * P6.732's own brief names it: *"the host wiring seam is pi-agent-server's
 * `createAgentSession` bindings in `compat/pi-runtime-adapter.ts`"*. It is not
 * there. `context?: TelemetryContext` is declared on **`AgentHarnessOptions`**
 * (`@earendil-works/pi-agent-core/dist/harness/agent-harness.d.ts`, 1 occurrence)
 * and `AgentHarness.create` is the only thing that takes it — with a PRIVATE
 * constructor, and zero call sites in this repo. The path this fork actually
 * uses is `createAgentSession` from `@earendil-works/pi-coding-agent`, whose
 * `CreateAgentSessionOptions` has **sixteen fields and none of them is a
 * telemetry context** (`TelemetryContext` scores **0** in that `sdk.d.ts`,
 * against `sessionManager` at 2 as the control that proves the file was read),
 * and the `AgentSession` it returns exposes `readonly agent: Agent` with **0**
 * `Telemetry` members.
 *
 * So Pi's declared vocabulary cannot be exported from here until the SDK
 * forwards a context through `createAgentSession` — an SDK matter, and every
 * SDK lift in this plan happens at close-out rather than in a lane. What this
 * module gives Pi TODAY is the same thing it gives claude and codex: the HOST's
 * own root span per turn ({@link HostTracer.beginTurnSpan}), which is
 * runtime-independent because the host owns the turn boundary.
 *
 * ### That is a REFUSAL WITH A DATE, not a defect — owner QM1 = A, 2026-09-11
 *
 * The owner was asked whether to export Pi's declared per-step span vocabulary
 * and answered: no, the host root turn span is the Pi arm, and ledger row M29's
 * Pi cell reads `partial` for that reason rather than because anything is
 * unfinished. So the eight span kinds above stay unexported BY DECISION, and the
 * decision's whole content is the paragraph above it: `createAgentSession`'s
 * options carry no telemetry context, and `AgentHarness.create` — the one thing
 * that takes one — has a private constructor.
 *
 * **The reopen condition, and it is re-measured rather than assumed.** The
 * refusal reopens at the next Pi SDK lift that forwards a `TelemetryContext`
 * through `createAgentSession`. The lift to **0.84.3** has HAPPENED (2026-09-11)
 * and the reading REPRODUCES on it, which is why the refusal is unchanged rather
 * than re-opened: in `@earendil-works/pi-coding-agent/dist/core/sdk.d.ts` at
 * 0.84.3, `CreateAgentSessionOptions` still declares exactly **sixteen** fields
 * and none of them is a telemetry context — `TelemetryContext` scores **0** in
 * that file against `sessionManager` at **2** as the control proving the file was
 * read — and `agent-harness.d.ts`'s `context?: TelemetryContext` is still the
 * single occurrence behind the private constructor. Re-run those two counts at
 * the next lift: a non-zero first count is the day this section is spent.
 *
 * ## The interface is deliberately the VENDOR's, structurally
 *
 * `TelemetryContext` is `startSpan(options, callback)` and nothing else, and
 * `TelemetrySpan extends TelemetryContext` — so nesting is the callback's own
 * span, not an ambient stack. This module declares that shape STRUCTURALLY
 * rather than importing `@earendil-works/pi-telemetry`, because `shared` must
 * not take a hard dependency on the Pi SDK for a capability two other runtimes
 * use; `pi-agent-server` passes the object where the vendored type is required
 * and the compiler checks the match there.
 *
 * ## What is exported, and what is NOT
 *
 * A span carries its name, its timestamps, its status and its attributes. It
 * carries NO conversation content: the attributes are the caller's own vocabulary
 * and this module adds only ids and the resource `usage-metrics.ts` already
 * builds. The five `OTEL_LOG_*` content channels are
 * not implemented here for the same reason they are not implemented in the logs
 * exporter, and there is no flag that could widen this to prompt or tool text.
 *
 * ## Off is OFF, and it mints no orphan
 *
 * `createHostTracer` returns `undefined` unless {@link tracingOptedIn} holds AND
 * the selector names a sink this host implements. A caller with no tracer passes
 * no context, so the harness runs its own no-op and codex's `trace` field stays
 * ABSENT — the row's control, and the reason `currentTraceparent()` answers
 * `undefined` rather than a freshly minted id when no span is open: a
 * `traceparent` naming a trace nothing will export is worse than none, because a
 * backend then shows a request whose parent never arrives.
 *
 * ## What a RE-ARM does to a span that is open (P6.882)
 *
 * A managed `env` delivery can change the OTLP endpoint after boot, and
 * `bootstrap/otlp-rearm.ts` swaps the delegate behind a stable facade for each
 * exporter. A metrics batch survives that swap because it is stateless; a span
 * does not — it was opened on the old tracer and the new one has never heard of
 * it. The decision, and it is a decision rather than a discovery, because no
 * documentation covers it: **the in-flight span ENDS at the re-arm**, stamped
 * `nessy.telemetry.rearmed = true` by {@link HostTracer.closeOpenTurnSpans}, and
 * it ends `ok` — a turn cut short by an administrator's endpoint change is not a
 * failed turn, and the attribute is what tells a reader the duration is a
 * fragment rather than the turn.
 *
 * Migrating it to the new tracer was the alternative and is rejected on the
 * simple-and-transparent rule: it would have to carry ids minted by an exporter
 * that has already been drained, so half the trace would sit in the old
 * endpoint and half in the new one, joined by a parent nobody can resolve. A
 * truncated span that says it was truncated is honest; a split trace is not.
 */
import {
  otlpFailureReason,
  otlpResourceAttributes,
  otlpTlsFetchOptions,
  parseHeaders,
  reportOtlpExportFailure,
  resolveOtlpClientTls,
  telemetryOptedOut,
  tracingOptedIn,
  type OtlpClientTls,
} from './usage-metrics.ts';
import { readFileSync } from 'node:fs';

/** `SpanOptions`, structurally — the vendored shape, not the import. */
export interface HostSpanOptions {
  name: string;
  attributes?: Record<string, HostSpanAttributeValue | undefined>;
}

export type HostSpanAttributeValue =
  | string | number | boolean
  | readonly string[] | readonly number[] | readonly boolean[];

export type HostSpanStatus =
  | { status: 'ok' }
  | { status: 'error'; error?: { name: string; message: string } };

/** `TelemetryContext`, structurally. */
export interface HostTelemetryContext {
  startSpan<T>(options: HostSpanOptions, callback: (span: HostTelemetrySpan) => T | Promise<T>): Promise<T>;
}

/** `TelemetrySpan`, structurally. */
export interface HostTelemetrySpan extends HostTelemetryContext {
  addEvent(name: string, attributes?: Record<string, HostSpanAttributeValue | undefined>): void;
  setAttributes(attributes: Record<string, HostSpanAttributeValue | undefined>): void;
  setStatus(status: HostSpanStatus): void;
}

export interface HostTracer extends HostTelemetryContext {
  /**
   * The W3C `traceparent` of the span currently open for `key`, or of the
   * innermost `startSpan` callback when `key` is omitted; `undefined` when
   * neither is open.
   *
   * This is what codex's per-request `trace: W3cTraceContext` carries, so a
   * codex turn's app-server requests join the trace the host opened for the
   * turn. Absent outside a span ON PURPOSE — see the module docblock.
   */
  currentTraceparent(key?: string): string | undefined;
  /**
   * Open the HOST's own root span for a turn, and close it.
   *
   * A second shape beside {@link HostTelemetryContext.startSpan}, and the reason
   * is the vendored contract rather than convenience: `startSpan` is
   * CALLBACK-SCOPED, and a turn is not a callback here — it opens on one event
   * (`setProcessing(true)`) and closes on another, with the whole streaming loop
   * in between and no single function to wrap. Wrapping it would mean inverting
   * `SessionManager`'s turn lifecycle for telemetry, which is the tail wagging
   * the dog.
   *
   * Keyed by session, so two sessions tracing at once cannot end each other's
   * span, and idempotent in both directions: a second `begin` for the same key
   * closes the first (a turn boundary the host missed must not leak a span that
   * never ends), and an `end` with nothing open does nothing.
   */
  beginTurnSpan(key: string, options: HostSpanOptions): void;
  endTurnSpan(key: string, status?: HostSpanStatus): void;
  /**
   * P6.882 — end EVERY turn span still open, stamping `attributes` on each
   * before it closes.
   *
   * The tracer knows its own open turns; a caller does not, and the alternative
   * — asking every caller to remember the keys it opened — is the shape that
   * leaks a span the day one of them forgets. `shutdown` uses it, and so does
   * the re-arming facade, whose whole problem is a span open on a delegate that
   * is about to be replaced.
   */
  closeOpenTurnSpans(attributes?: Record<string, HostSpanAttributeValue | undefined>): void;
  /** Export whatever has finished. Never throws. */
  flush(): Promise<void>;
  /** Stop the interval and drain the last batch. */
  shutdown(): Promise<void>;
}

/** One finished span, in the shape the OTLP payload takes. */
interface FinishedSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: Array<{ key: string; value: Record<string, unknown> }>;
  events: Array<{ timeUnixNano: string; name: string; attributes: Array<{ key: string; value: Record<string, unknown> }> }>;
  status: { code: number; message?: string };
}

/**
 * Where a batch goes. `P6.524`'s two sinks, one signal further.
 *
 * `console` is FIRST-CLASS and not a debug afterthought (controller decision,
 * 2026-09-07): it is the sink an operator can turn on with no collector, and it
 * is what makes "the exporter is on and nothing arrives" distinguishable from
 * "the exporter is off".
 */
type TraceSink =
  | { kind: 'console' }
  | { kind: 'otlp'; url: string; headers: Headers; tls: OtlpClientTls | undefined; timeoutMs: number };

/**
 * C3.195 (QM1 = A, owner 2026-09-11) — the span stream's own interval, which it
 * did not have.
 *
 * This module read `OTEL_METRIC_EXPORT_INTERVAL` with a 60 000 ms default. Both
 * halves were wrong and `monitoring-usage.md#traces-beta` settles both in one
 * row of its own table: *"`OTEL_TRACES_EXPORT_INTERVAL` | Span batch export
 * interval in milliseconds (default: 5000)"*. So a METRICS key governed a TRACES
 * exporter, and the default was twelve times the documented one — a span sat in
 * the buffer for up to a minute where the contract says five seconds, and an
 * operator who set the documented key changed nothing at all.
 *
 * M41 read `covered` on the premise that nothing here batches; a span stream
 * does, which is exactly why this row re-checked it. The drain half of that
 * premise HOLDS — `shutdown` closes every open turn span and then flushes, so an
 * exit loses nothing — and it is pinned by its own case rather than assumed.
 *
 * The metrics key is NOT kept as a fallback. It is not documented to govern
 * traces, and honouring it here would mean an operator tuning metrics silently
 * retunes a second signal.
 */
const DEFAULT_TRACE_EXPORT_INTERVAL_MS = 5_000;
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_TIMER_MS = 2_147_483_647;
/**
 * A bound on buffered spans, `MAX_SERIES`' reason one signal over: a run that
 * traces faster than the interval exports must drop rather than grow without
 * limit, and dropping is COUNTED (`readOtlpDroppedBatches('traces')`) so the
 * gap is visible instead of silent.
 */
const MAX_BUFFERED_SPANS = 2_000;

/** OTLP `Status.StatusCode`. */
const STATUS_UNSET = 0;
const STATUS_OK = 1;
const STATUS_ERROR = 2;

/** OTLP `SpanKind.SPAN_KIND_INTERNAL` — every span this host mints is in-process. */
const SPAN_KIND_INTERNAL = 1;

export interface HostTracerConfig {
  sinks: TraceSink[];
  intervalMs: number;
  resourceAttributes: Array<{ key: string; value: { stringValue: string } }>;
}

/**
 * The traces selector, read exactly as the metrics one is.
 *
 * `monitoring-usage.md#common-configuration-variables` gives `OTEL_TRACES_EXPORTER`
 * the values `otlp`, `console`, `none` — one shorter than the metrics column,
 * because there is no Prometheus traces exporter to refuse. An unrecognised
 * value yields NO sink, which is the same answer `none` gives and is the safe
 * direction: a name we cannot read must not be resolved toward exporting.
 */
export function resolveTraceSinks(env: Record<string, string | undefined>): TraceSink[] {
  const selected = new Set(
    (env.OTEL_TRACES_EXPORTER ?? '').split(',').map(value => value.trim().toLowerCase()).filter(Boolean),
  );
  const sinks: TraceSink[] = [];
  if (selected.has('console')) sinks.push({ kind: 'console' });
  if (selected.has('otlp')) {
    const otlp = parseTraceDestination(env);
    if (otlp) sinks.push(otlp);
  }
  return sinks;
}

/**
 * The documented traces interval, exported so the two propositions that can
 * drift are testable without a timer: which KEY is read, and what the default is
 * when it is unset. See {@link DEFAULT_TRACE_EXPORT_INTERVAL_MS}.
 */
export function resolveTraceExportIntervalMs(
  env: Record<string, string | undefined> = process.env,
): number {
  return parsePositiveMs(env.OTEL_TRACES_EXPORT_INTERVAL, DEFAULT_TRACE_EXPORT_INTERVAL_MS);
}

export function createHostTracer(
  env: Record<string, string | undefined> = process.env,
): HostTracer | undefined {
  // The standard opt-out is checked first and beats every other signal, exactly
  // as `parseConfig` does for metrics.
  if (telemetryOptedOut(env)) return undefined;
  if (!tracingOptedIn(env)) return undefined;
  const sinks = resolveTraceSinks(env);
  // A selector naming only `otlp` with no reachable endpoint yields zero sinks,
  // and a tracer with nowhere to write is not a tracer: returning `undefined`
  // here is what makes the harness run its no-op and codex send no `trace`.
  if (sinks.length === 0) return undefined;
  return new BufferingHostTracer({
    sinks,
    intervalMs: resolveTraceExportIntervalMs(env),
    resourceAttributes: otlpResourceAttributes(env),
  });
}

class BufferingHostTracer implements HostTracer {
  private readonly finished: FinishedSpan[] = [];
  /** The span stack of the CURRENTLY executing `startSpan` callback chain. */
  private open: Array<{ traceId: string; spanId: string }> = [];
  /** One open HOST turn span per session key — see `beginTurnSpan`. */
  private readonly turns = new Map<string, {
    startedAt: bigint;
    startWallNano: bigint;
    record: FinishedSpan;
  }>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private inFlight: Promise<void> | undefined;
  private closed = false;

  constructor(private readonly config: HostTracerConfig) {}

  currentTraceparent(key?: string): string | undefined {
    const turn = key === undefined ? undefined : this.turns.get(key);
    const top = turn ? { traceId: turn.record.traceId, spanId: turn.record.spanId } : this.open.at(-1);
    // `traceparent` version 00, sampled. We export every span we mint, so the
    // sampled flag is the honest one — a `00` flag would tell the far side its
    // spans need not be recorded.
    return top ? `00-${top.traceId}-${top.spanId}-01` : undefined;
  }

  beginTurnSpan(key: string, options: HostSpanOptions): void {
    if (this.closed) return;
    // A turn boundary the host missed must not leak a span with no end, so a
    // second `begin` closes the first rather than replacing it silently.
    this.endTurnSpan(key);
    const startWallNano = BigInt(Date.now()) * 1_000_000n;
    this.turns.set(key, {
      startedAt: process.hrtime.bigint(),
      record: {
        traceId: randomHex(32),
        spanId: randomHex(16),
        name: options.name,
        startTimeUnixNano: String(startWallNano),
        endTimeUnixNano: String(startWallNano),
        attributes: spanAttributes(options.attributes),
        events: [],
        status: { code: STATUS_UNSET },
      },
      startWallNano,
    });
  }

  endTurnSpan(key: string, status?: HostSpanStatus): void {
    const turn = this.turns.get(key);
    if (!turn) return;
    this.turns.delete(key);
    turn.record.endTimeUnixNano = String(turn.startWallNano + (process.hrtime.bigint() - turn.startedAt));
    turn.record.status = status?.status === 'error'
      ? { code: STATUS_ERROR, ...(status.error ? { message: `${status.error.name}: ${status.error.message}` } : {}) }
      : { code: STATUS_OK };
    this.record(turn.record);
  }

  closeOpenTurnSpans(attributes?: Record<string, HostSpanAttributeValue | undefined>): void {
    for (const [key, turn] of [...this.turns]) {
      // Stamped BEFORE the close, so the attribute is on the exported record
      // rather than on a span that has already been handed to the buffer.
      // Later wins, by key, exactly as `setAttributes` resolves a repeat.
      for (const next of spanAttributes(attributes)) {
        const existing = turn.record.attributes.findIndex(entry => entry.key === next.key);
        if (existing >= 0) turn.record.attributes[existing] = next;
        else turn.record.attributes.push(next);
      }
      this.endTurnSpan(key);
    }
  }

  async startSpan<T>(
    options: HostSpanOptions,
    callback: (span: HostTelemetrySpan) => T | Promise<T>,
  ): Promise<T> {
    if (this.closed) return callback(NOOP_HOST_SPAN as HostTelemetrySpan);
    const parent = this.open.at(-1);
    const traceId = parent?.traceId ?? randomHex(32);
    const spanId = randomHex(16);
    const startedAt = process.hrtime.bigint();
    const startWallNano = BigInt(Date.now()) * 1_000_000n;
    const record: FinishedSpan = {
      traceId,
      spanId,
      ...(parent ? { parentSpanId: parent.spanId } : {}),
      name: options.name,
      startTimeUnixNano: String(startWallNano),
      endTimeUnixNano: String(startWallNano),
      attributes: spanAttributes(options.attributes),
      events: [],
      status: { code: STATUS_UNSET },
    };
    const span: HostTelemetrySpan = {
      startSpan: (childOptions, childCallback) => this.startSpan(childOptions, childCallback),
      addEvent: (name, attributes) => {
        record.events.push({
          timeUnixNano: String(BigInt(Date.now()) * 1_000_000n),
          name,
          attributes: spanAttributes(attributes),
        });
      },
      setAttributes: attributes => {
        // Later wins, matching the vendored contract's own "set" wording, and
        // implemented by key so a second call cannot duplicate an attribute —
        // a duplicate key is a payload some collectors reject outright.
        for (const next of spanAttributes(attributes)) {
          const existing = record.attributes.findIndex(entry => entry.key === next.key);
          if (existing >= 0) record.attributes[existing] = next;
          else record.attributes.push(next);
        }
      },
      setStatus: status => {
        record.status = status.status === 'ok'
          ? { code: STATUS_OK }
          : { code: STATUS_ERROR, ...(status.error ? { message: `${status.error.name}: ${status.error.message}` } : {}) };
      },
    };

    this.open.push({ traceId, spanId });
    try {
      const result = await callback(span);
      if (record.status.code === STATUS_UNSET) record.status = { code: STATUS_OK };
      return result;
    } catch (error) {
      // A throw is an error span even when the caller never called `setStatus`.
      // The MESSAGE is the error's own and nothing else — no stack, which can
      // carry a path, and no cause chain, which can carry a payload.
      if (record.status.code !== STATUS_ERROR) {
        record.status = {
          code: STATUS_ERROR,
          message: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
        };
      }
      throw error;
    } finally {
      // The stack is popped by IDENTITY, not by length: an `await` interleaving
      // two sibling spans would otherwise pop the wrong one and re-parent every
      // span after it.
      const index = this.open.findIndex(entry => entry.spanId === spanId);
      if (index >= 0) this.open.splice(index, 1);
      record.endTimeUnixNano = String(startWallNano + (process.hrtime.bigint() - startedAt));
      this.record(record);
    }
  }

  private record(span: FinishedSpan): void {
    if (this.closed) return;
    if (this.finished.length >= MAX_BUFFERED_SPANS) {
      reportOtlpExportFailure({
        signal: 'traces',
        endpoint: 'buffer',
        reason: `span buffer full at ${MAX_BUFFERED_SPANS}; spans are being dropped`,
      });
      return;
    }
    this.finished.push(span);
    this.startInterval();
  }

  private startInterval(): void {
    if (this.timer || this.closed) return;
    this.timer = setInterval(() => { void this.flush() }, this.config.intervalMs);
    // The interval must never hold the process open: telemetry is not work.
    (this.timer as { unref?: () => void }).unref?.();
  }

  async flush(): Promise<void> {
    // Serialised for `HostUsageMetrics.flush`'s reason: two concurrent flushes
    // would each drain half the buffer and post partial traces.
    const run = async (): Promise<void> => {
      try {
        await this.post();
      } catch {
        // Telemetry is best-effort and must never affect agent work.
      }
    };
    this.inFlight = this.inFlight ? this.inFlight.then(run, run) : run();
    await this.inFlight;
  }

  async shutdown(): Promise<void> {
    if (this.timer) { clearInterval(this.timer); this.timer = undefined }
    // Close every turn span still open, so a shutdown mid-turn exports what it
    // measured rather than dropping it: a span that never ends is a trace a
    // backend shows for ever as running. UNSTAMPED, unlike a re-arm: a shutdown
    // is the end of the process, and there is no successor tracer for a reader
    // to go looking for.
    this.closeOpenTurnSpans();
    await this.flush();
    this.closed = true;
  }

  private async post(): Promise<void> {
    if (this.finished.length === 0) return;
    const batch = this.finished.splice(0, this.finished.length);
    const body = JSON.stringify(tracePayload(batch, this.config.resourceAttributes));
    // ONE batch, every destination — P6.524's rule, so the console readout and
    // the collector can never be shown two different serialisations.
    for (const sink of this.config.sinks) {
      if (sink.kind === 'console') {
        console.log(body);
        continue;
      }
      try {
        const response = await fetch(sink.url, {
          method: 'POST',
          headers: sink.headers,
          body,
          signal: AbortSignal.timeout(sink.timeoutMs),
          ...otlpTlsFetchOptions(sink.tls, reason => reportOtlpExportFailure({
            signal: 'traces', endpoint: sink.url, reason,
          })),
        });
        if (!response.ok) {
          reportOtlpExportFailure({
            signal: 'traces',
            endpoint: sink.url,
            reason: otlpFailureReason(response.status),
            status: response.status,
          });
        }
      } catch (error) {
        reportOtlpExportFailure({
          signal: 'traces',
          endpoint: sink.url,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
}

/**
 * A tracer that is present but exports nothing, for the closed state.
 *
 * Returned only after `shutdown`, so a span opened during teardown runs its
 * callback rather than throwing — telemetry must not be able to fail the work it
 * measures.
 */
export const NOOP_HOST_SPAN = {
  startSpan: <T,>(_options: HostSpanOptions, callback: (span: HostTelemetrySpan) => T | Promise<T>) =>
    Promise.resolve(callback(NOOP_HOST_SPAN as HostTelemetrySpan)),
  addEvent: () => {},
  setAttributes: () => {},
  setStatus: () => {},
};

function randomHex(length: number): string {
  const bytes = new Uint8Array(length / 2);
  crypto.getRandomValues(bytes);
  return [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * OTLP `KeyValue`s from the vendored `SpanAttributes`.
 *
 * `undefined` values are DROPPED rather than exported as null: the vendored type
 * admits `undefined` for an unset attribute, and a key with no value is a
 * payload some collectors reject.
 */
function spanAttributes(
  attributes: Record<string, HostSpanAttributeValue | undefined> | undefined,
): Array<{ key: string; value: Record<string, unknown> }> {
  if (!attributes) return [];
  const out: Array<{ key: string; value: Record<string, unknown> }> = [];
  for (const [key, value] of Object.entries(attributes)) {
    const encoded = encodeAttributeValue(value);
    if (encoded) out.push({ key, value: encoded });
  }
  return out;
}

function encodeAttributeValue(value: HostSpanAttributeValue | undefined): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'string') return { stringValue: value };
  if (typeof value === 'boolean') return { boolValue: value };
  if (typeof value === 'number') {
    // An integer goes out as `intValue` (a STRING in OTLP/JSON, which is the
    // spec's own encoding for 64-bit values) and anything else as `doubleValue`.
    // A non-finite number is dropped: `NaN` is not JSON and a collector that
    // receives it rejects the whole batch, not the one attribute.
    if (!Number.isFinite(value)) return undefined;
    return Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value };
  }
  if (Array.isArray(value)) {
    const values = value.map(entry => encodeAttributeValue(entry as HostSpanAttributeValue)).filter(Boolean);
    return { arrayValue: { values } };
  }
  return undefined;
}

function tracePayload(
  batch: readonly FinishedSpan[],
  resourceAttributes: Array<{ key: string; value: { stringValue: string } }>,
) {
  return {
    resourceSpans: [{
      resource: { attributes: resourceAttributes },
      scopeSpans: [{
        scope: { name: 'nessy.harness' },
        spans: batch.map(span => ({
          traceId: span.traceId,
          spanId: span.spanId,
          ...(span.parentSpanId ? { parentSpanId: span.parentSpanId } : {}),
          name: span.name,
          kind: SPAN_KIND_INTERNAL,
          startTimeUnixNano: span.startTimeUnixNano,
          endTimeUnixNano: span.endTimeUnixNano,
          attributes: span.attributes,
          ...(span.events.length ? { events: span.events } : {}),
          status: span.status,
        })),
      }],
    }],
  };
}

/**
 * `monitoring-usage.md:100`'s rule, one signal over:
 * `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` "overrides general setting" and carries
 * its own path, so only the general endpoint gets `/v1/traces` appended.
 */
function parseTraceDestination(env: Record<string, string | undefined>): TraceSink | undefined {
  const tracesEndpoint = env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT?.trim();
  const raw = tracesEndpoint || env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (!raw?.trim()) return undefined;
  try {
    const endpoint = new URL(raw);
    if ((endpoint.protocol !== 'http:' && endpoint.protocol !== 'https:') || endpoint.username || endpoint.password) {
      return undefined;
    }
    endpoint.search = '';
    endpoint.hash = '';
    if (!tracesEndpoint) {
      endpoint.pathname = `${endpoint.pathname.replace(/\/+$/, '')}/v1/traces`;
    }
    const headers = parseHeaders(env.OTEL_EXPORTER_OTLP_HEADERS);
    if (!headers) return undefined;
    headers.set('Content-Type', 'application/json');
    const url = endpoint.toString();
    const tls = resolveOtlpClientTls(
      env,
      path => readFileSync(path, 'utf8'),
      reason => reportOtlpExportFailure({ signal: 'traces', endpoint: url, reason }),
    );
    return {
      kind: 'otlp',
      url,
      headers,
      tls,
      timeoutMs: parsePositiveMs(env.OTEL_EXPORTER_OTLP_TIMEOUT, DEFAULT_TIMEOUT_MS),
    };
  } catch {
    return undefined;
  }
}

function parsePositiveMs(raw: string | undefined, fallback: number): number {
  if (raw && /^[1-9]\d*$/.test(raw)) {
    const value = Number(raw);
    if (Number.isSafeInteger(value) && value <= MAX_TIMER_MS) return value;
  }
  return fallback;
}
