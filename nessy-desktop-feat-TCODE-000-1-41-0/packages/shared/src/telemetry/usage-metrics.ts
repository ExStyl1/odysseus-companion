/**
 * Token and cost counters, exported over OTLP/HTTP with an interval flush and a
 * shutdown drain.
 *
 * The doc contract, from `monitoring-usage.md` fetched with `curl`:
 *
 * - `:94` — `CLAUDE_CODE_ENABLE_TELEMETRY`, "Enables telemetry collection
 *   (required)". REQUIRED means required: an OTLP endpoint is ambient in many
 *   corporate shells, set for other tools, and it alone must never start an
 *   exporter. Our spelling is `NESSY_ENABLE_TELEMETRY` with the documented
 *   Claude name as a compat alias — the `isCronDisabled` posture
 *   (`session-tools-core/src/tool-defs.ts`): the Nessy name wins when both are
 *   set, values follow the repo convention (`1/true/yes/on`).
 * - `:95` — `OTEL_METRICS_EXPORTER`, "Metrics exporter types, comma-separated.
 *   Use `none` to disable", values `console`, `otlp`, `prometheus`, `none`.
 *   `none` is a hard disable, opt-in or not. P6.524 — the other three are read
 *   too: `otlp` (the default when the selector is unset) and `console` are
 *   implemented, and `prometheus` is REFUSED BY NAME rather than ignored,
 *   because a scrape exporter is an inbound listening socket on a desktop
 *   application. See {@link resolveMetricsExporters}.
 * - `:100` — `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT`, "OTLP metrics endpoint,
 *   overrides general setting".
 * - `:112` — `OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE`, "Metrics
 *   temporality preference (default: `delta`). Set to `cumulative` if your
 *   backend expects cumulative temporality".
 * - `:477` — `claude_code.token.usage`, "Number of tokens used", unit `tokens`.
 * - `:476` — `claude_code.cost.usage`, "Cost of the Claude Code session", unit
 *   `USD`. `:524` and `:542` both say "Incremented after each API request".
 * - `:547` — the token counter's `type` attribute: `"input"`, `"output"`,
 *   `"cacheRead"`, `"cacheCreation"`. `:548` adds `model`.
 * - `:104` — `OTEL_METRIC_EXPORT_INTERVAL`, "Export interval in milliseconds
 *   (default: 60000)".
 * - `monitoring-usage.md#standard-attributes`, the paragraph after the table —
 *   *"Events additionally include the following attributes. These are never
 *   attached to metrics because they would cause unbounded cardinality."* Ours
 *   carries none of them. (Cited by section and sentence since C3.292; the
 *   `:459` this line carried had moved to 480.)
 *
 * **C3.292 — and `prompt.id` is REFUSED here BY THAT SENTENCE, not omitted.**
 * The page's correlation attribute (`#event-correlation-attributes`, *"UUID v4
 * identifier linking all events produced while processing a single user
 * prompt"*) is the first entry of that event-only list, and a per-turn UUID on a
 * metric data point is the unbounded cardinality the sentence names: one new
 * series per prompt, forever. C3.197's residue note in `BaseAgent.withPromptId`
 * asked for BOTH exporters to carry it; that half of the note is wrong, and the
 * reading is what corrects it. The correlation the page promises is delivered on
 * the EVENTS stream — `pi-harness/otlp-telemetry.ts` stamps `prompt.id` from
 * {@link import('../agent/base-agent.ts').BaseAgent.promptId}, the same value
 * the hook input's `prompt_id` carries — and nothing is owed here.
 *
 * **The standard-attribute deviation — and P6.538 is the "on purpose" this
 * paragraph asked for.** `monitoring-usage.md#standard-attributes` — "All
 * metrics and events share these standard attributes" — with `session.id`
 * controlled by "`OTEL_METRICS_INCLUDE_SESSION_ID` (default: true)" and
 * `user.id` "Always included". THIS exporter still emits none of that row: a
 * conversation data point carries exactly `backend`, `model`, `type`,
 * `cost_reporting`, and a host-overhead point adds `usage_scope` and
 * `overhead_source` (P3.98/P3.122 — see {@link UsageScope}; both name a
 * MECHANISM, never a person or a session).
 *
 * **But the blanket sentence this paragraph used to carry was FALSE of the
 * machine, and P6.538 is where that was corrected.** It read "no per-user or
 * per-session identifier leaves the operator's machine". That was true of this
 * file and of `pi-harness/otlp-telemetry.ts`, and false of the claude CHILD
 * beside them: `agent/options.ts` spreads `process.env` unfiltered, and both of
 * the vendor's identity switches default to TRUE, so an operator who turned
 * telemetry on was exporting `session.id`, `user.account_uuid` and
 * `user.account_id` from every claude session while this comment read as a
 * blanket assurance. Owner decision 2026-09-05 D13 = option B: identity behind
 * the documented toggles, **DEFAULT OFF**, the vendor's own switch names where
 * they exist. {@link resolveTelemetryIdentity} is the one resolution; the claude
 * child is now pinned to it in both directions, and Pi's log exporter honours
 * the half it can answer. Widening THIS exporter's own data points is the
 * remaining half and is still a decision to be made on purpose rather than an
 * omission to be patched — see that function's docblock for what has no switch
 * at all.
 *
 * **What this deliberately does not export.** Counts and identifiers only: the
 * backend name, the model id, the token bucket, and the cost verdict. No prompt
 * text, no tool name, no tool payload, no session or workspace identifier, no
 * account. `monitoring-usage.md` states the doc's own default — "User prompt
 * content is not collected by default. Only prompt length is recorded" (cited by
 * sentence now; the `:1278` this line carried had already moved) — and every
 * content channel it describes is an opt-in `OTEL_LOG_*` flag. This fork
 * implements none of those flags: exporting conversation content off a bank
 * operator's machine is a different product decision than exporting counts, and
 * nothing in the row asks for it.
 *
 * **P6.539 — and the claude subprocess can no longer be talked into it either.**
 * "This fork implements none of those flags" was true of the host's own
 * exporters and said nothing about the vendored `claude` binary, which
 * implements all five and received them through the unfiltered `process.env`
 * spread in `agent/options.ts`. An ambient `OTEL_LOG_RAW_API_BODIES=1` therefore
 * exported the whole conversation from a claude session while this comment read
 * as a blanket assurance. All five names are now dropped from that child's
 * environment by name (`CLAUDE_TELEMETRY_CONTENT_OPT_IN_ENV_KEYS`), announced
 * one line per dropped name. Owner decision 2026-09-05 (D14), option A: a
 * working vendor capability removed on purpose. If content export is ever
 * wanted it arrives as an explicit host setting, never as an inherited variable.
 *
 * **Why DELTA temporality by default.** Each export carries only what
 * accumulated since the last one, so a batch that never leaves the process is
 * data that is simply lost. That makes the shutdown drain load-bearing rather
 * than decorative, which is the bug the row names: an exporter that drops its
 * last interval on quit. Under the `:112` `cumulative` preference the series
 * are kept across flushes instead of handed off, and each point reports the
 * running total since process start — flipping the enum without flipping the
 * accumulation would export resets a cumulative backend misreads as new
 * totals.
 */

/** AGGREGATION_TEMPORALITY_DELTA / _CUMULATIVE in the OTLP metrics proto. */
const DELTA = 1;
const CUMULATIVE = 2;

const DEFAULT_EXPORT_INTERVAL_MS = 60_000;
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_TIMER_MS = 2_147_483_647;

/** Bound on distinct (backend, model, type) series held between flushes. */
const MAX_SERIES = 500;

/** The token buckets, exactly the documented `type` values. */
export type TokenBucket = 'input' | 'output' | 'cacheRead' | 'cacheCreation';

/**
 * P3.98 + P3.122 — WHOSE TOKENS THESE ARE, AND WHY THAT IS ITS OWN DIMENSION.
 *
 * `conversation` is the turn the user asked for. `host-overhead` is a model call
 * the HOST caused, outside any turn's own accounting — the SDK's auto-mode
 * classifier is the measured one, at **110,519 characters of system prompt per
 * check, twice on the first auto-mode action**, billed to our gateway and
 * excluded from `modelUsage` entirely.
 *
 * Owner-delegated controller decision 2026-09-02 (§E1): **report it as a
 * SEPARATE line, never folded into per-turn model usage — an operator must never
 * see less than they are charged.** Both halves of that sentence are load-bearing:
 *
 * - **Separate**, because folding overhead into a model's own series would make
 *   the per-turn figures wrong in the other direction; a cost attribution that
 *   is inflated by an invisible cause is not more honest than one that is short.
 * - **Counted**, because the failure this closes is a total that is silently
 *   smaller than the bill. A naive `sum(nessy.token.usage)` over all points
 *   therefore INCLUDES overhead, and the breakdown is available by attribute —
 *   which is why the attributes are emitted only on the overhead points and the
 *   existing conversation series keep their exact identity. An operator's
 *   dashboards do not move; a new dimension appears beside them.
 *
 * See `telemetry/host-overhead-usage.ts` for the vocabulary of sources, the
 * detection, and the honest statement of what is and is not wired today.
 */

// P6.452 M39 — the only import this module has ever needed: the operator's
// client certificate and key are PATHS, and presenting them means reading them.
import { readFileSync } from 'node:fs';

export type UsageScope = 'conversation' | 'host-overhead';

/** One turn's usage, as the session layer already has it. */
export interface UsageMetricsTurn {
  /** Which backend served the turn: `pi`, `anthropic`, `codex`, … */
  backend: string;
  /**
   * Defaults to `conversation`, so every existing caller is unchanged and a new
   * one has to say the word `host-overhead` out loud to become overhead.
   */
  scope?: UsageScope;
  /**
   * Which host-overhead source caused this, from
   * {@link HOST_OVERHEAD_SOURCES}. Meaningless — and dropped — on a
   * `conversation` turn.
   */
  overheadSource?: string;
  /** Session model, used only when the turn reports no per-model map. */
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  costUsd?: number;
  /** `reported` when `costUsd` is a figure the backend established. */
  costReporting?: 'reported' | 'unsupported';
  /** Per-model breakdown; when present it is the sole source for this turn. */
  modelUsage?: Record<string, {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
    costUsd: number;
    costReporting: 'reported' | 'partial' | 'unsupported';
  }>;
}

/**
 * P6.461 — one ADOPTION counter, as `monitoring-usage.md#metrics` publishes it.
 *
 * A discriminated union rather than a free `(name, attributes, value)` call, so
 * a caller cannot invent a metric this host has not decided to emit and cannot
 * spell an attribute the page does not define. Both members carry exactly the
 * attributes their `#metric-details` section lists and nothing else — the
 * standard attributes ride the OTLP resource, where the other two series
 * already put them.
 *
 * Names are written WITHOUT the `claude_code.` prefix here for
 * {@link FLEET_METRIC_PARITY}'s recorded reason: the prefix is precisely what
 * this fork does not use, and repeating it invites someone to paste it into a
 * query that will find nothing.
 */
export type FleetCounterEvent =
  /**
   * `session.count`, *"Count of CLI sessions started"*, unit none.
   *
   * `start_type` is the page's own attribute: *"How the session was started.
   * One of `"fresh"`, `"resume"`, `"continue"`, or `"agents_view"`."* Only
   * the first two are reachable here and that is a product fact, not an
   * omission: this fork has no `--continue` entry point and no `claude agents`
   * dashboard process, so emitting either value would describe a thing that
   * never happened.
   */
  | { metric: 'session.count'; startType: 'fresh' | 'resume' }
  /**
   * `active_time.total`, *"Total active time"*, unit `s`.
   *
   * The page splits it: *"`"user"` for keyboard interactions, `"cli"` for
   * tool execution and AI responses."* Only the `cli` half has a producer here
   * — it is the session's own processing interval, which the host already
   * brackets — and the `user` half needs a renderer signal this host does not
   * send. The half that exists is emitted under its documented attribute rather
   * than as an unlabelled total, so an operator summing the metric is summing
   * the same thing the page describes and can see which half is missing.
   */
  | { metric: 'active_time.total'; type: 'cli'; seconds: number }
  /**
   * `code_edit_tool.decision`, *"Count of code editing tool permission
   * decisions"*, unit none. Page: *"Incremented when user accepts or rejects
   * Edit, Write, or NotebookEdit tool usage."*
   *
   * P6.461's third metric, and the ONE the row's own native clause got wrong.
   * It said *"every permission decision passes `agent/core/pre-tool-use.ts`,
   * uniform on all three runtimes — so it is the cheapest of the six"*;
   * P6.880 refuted that (`runPreToolUseChecks` has zero call sites in
   * `codex-agent.ts`). The site that IS uniform is one layer up — the moment a
   * card the USER was shown is answered — which is also what the page's own
   * sentence describes.
   *
   * `source` is the page's closed set, and only the three answers a person can
   * give at a card are produced here:
   * - `user_permanent` — *"the user chose 'Yes, and don't ask again for ...'"*
   * - `user_temporary` — *"the user chose 'Yes' … for a one-time approval"*
   * - `user_reject` — *"the user chose 'No' when prompted"*
   *
   * **The three that have NO producer, named so a missing series is
   * distinguishable from an unimplemented one:** `config` and `hook` are
   * decisions taken WITHOUT a prompt, so they never reach a card and this host
   * never sees them as a decision at all; `user_abort` is the dismissal path,
   * which tears the session's pending requests down in bulk without knowing
   * which tool each one was for.
   *
   * `language` is the page's fifth attribute and it is emitted from the card's
   * own subject: on a `file_write` prompt the request's `command` field IS the
   * target path on every runtime that raises one. `unknown` is the page's own
   * word for an extension it does not recognise, so it is also the honest value
   * when a card carried no path.
   */
  | {
    metric: 'code_edit_tool.decision';
    toolName: string;
    decision: 'accept' | 'reject';
    source: 'user_permanent' | 'user_temporary' | 'user_reject';
    language: string;
  };

export interface UsageMetrics {
  /** Accumulate one turn. Never throws; telemetry cannot break a turn. */
  record(turn: UsageMetricsTurn): void;
  /**
   * P6.461 — accumulate one adoption counter. Never throws, for `record`'s
   * reason: a counter must not be able to fail a session.
   */
  count(event: FleetCounterEvent): void;
  /** Export whatever has accumulated. */
  flush(): Promise<void>;
  /** Stop the interval and drain the last batch. */
  shutdown(): Promise<void>;
}

/** One accumulated counter series: a metric, its attributes and its total. */
interface CounterSeries {
  metric: FleetCounterEvent['metric'];
  attributes: Array<{ key: string; value: { stringValue: string } }>;
  /** Integral for `session.count`, seconds for `active_time.total`. */
  value: number;
}

/**
 * The accumulator key — the metric plus its attribute values, so two events
 * with the same attributes add and two with different ones stay apart.
 */
export function counterSeriesKey(event: FleetCounterEvent): string {
  switch (event.metric) {
    case 'session.count':
      return `session.count|${event.startType}`;
    case 'active_time.total':
      return `active_time.total|${event.type}`;
    default:
      // All FOUR attributes, because the page declares all four and two
      // decisions differing in any one of them are different series.
      return `code_edit_tool.decision|${event.toolName}|${event.decision}|${event.source}|${event.language}`;
  }
}

/**
 * P6.524 — where one batch goes. A batch is built ONCE and written to each.
 *
 * Two destinations rather than two exporters: the accumulator, the series key,
 * the payload builder and the drain are identical either way, and duplicating
 * them is how the console readout would come to disagree with what the
 * collector received.
 */
interface OtlpDestination {
  kind: 'otlp';
  url: string;
  headers: Headers;
  timeoutMs: number;
  /** P6.452 M39 — the operator's client certificate, already read off disk. */
  tls?: OtlpClientTls;
}

interface ConsoleDestination {
  kind: 'console';
}

type MetricsDestination = OtlpDestination | ConsoleDestination;

interface ExporterConfig {
  destinations: readonly MetricsDestination[];
  intervalMs: number;
  temporality: 'delta' | 'cumulative';
  /** P6.452 M32 — the resource an administrator queries by. */
  resourceAttributes: Array<{ key: string; value: { stringValue: string } }>;
}

interface SeriesKey {
  backend: string;
  model: string;
  costReporting: 'reported' | 'partial' | 'unsupported';
  /** P3.98/P3.122 — part of the KEY, so overhead can never merge into a model's own series. */
  scope: UsageScope;
  overheadSource?: string;
}

interface Series extends SeriesKey {
  tokens: Record<TokenBucket, number>;
  costUsd: number;
  costReported: boolean;
}

/**
 * Build an exporter, or `undefined` when telemetry is not configured.
 *
 * Shares `OTEL_EXPORTER_OTLP_ENDPOINT`/`_HEADERS`/`_TIMEOUT` with the existing
 * log exporter (`server-core/src/pi-harness/otlp-telemetry.ts`) and appends
 * `/v1/metrics` rather than `/v1/logs`.
 */
/**
 * P6.461 — the fleet's metric parity against `monitoring-usage.md#metrics`,
 * stated once so a dashboard author can tell a REFUSED series from an
 * unimplemented one.
 *
 * ## Why this exists as a value and not a comment
 *
 * The page publishes eight metric names. This host emits two of them, under
 * DIFFERENT names — the fork renames the whole `claude_code.*` namespace to
 * `nessy.*` — so an operator who builds a dashboard from that page finds
 * nothing, and cannot tell whether a missing series means "this host will never
 * produce it", "the exporter is misconfigured", or "nobody has written the
 * producer yet". Those are three different actions and the difference was
 * recorded nowhere.
 *
 * Kept as an exported record rather than prose so it is pinned by a test
 * (`__tests__/fleet-metric-parity.test.ts`): the emitted rows are checked
 * against the names this module actually puts on the wire, and the table is
 * checked for TOTALITY over the page's list, so a page refresh that adds a
 * ninth metric goes red instead of silently widening the gap.
 *
 * ## The three statuses
 *
 * - `emitted` — on the wire today, under `emittedAs`.
 * - `refused` — this host will not produce it, with the reason. A refusal is a
 *   decision and it is not expected to change.
 * - `owed` — documented, wanted, and not yet produced. The `note` names the
 *   host site that already has the fact, so this is a wiring gap and not a
 *   discovery one.
 *
 * Names are written WITHOUT the `claude_code.` prefix, because the prefix is
 * precisely the thing this fork does not use and repeating it here would invite
 * someone to paste it into a query.
 */
export interface FleetMetricParity {
  /** The metric `monitoring-usage.md#metrics` publishes, minus its `claude_code.` prefix. */
  documented: string;
  /** The series this host puts on the wire, or `null` when it puts none. */
  emittedAs: string | null;
  status: 'emitted' | 'refused' | 'owed';
  /** Required on every row: why, in terms an operator can act on. */
  note: string;
}

export const FLEET_METRIC_PARITY: readonly FleetMetricParity[] = Object.freeze([
  {
    documented: 'token.usage',
    emittedAs: 'nessy.token.usage',
    status: 'emitted',
    note: 'Renamed out of the `claude_code.*` namespace with the rest of the fork. Carries `backend` and `model`, plus `usage_scope` on host-overhead points only.',
  },
  {
    documented: 'cost.usage',
    emittedAs: 'nessy.cost.usage',
    status: 'emitted',
    note: 'Renamed as above. `costReporting` distinguishes a figure the backend established from one it does not support, which the page has no equivalent for.',
  },
  {
    documented: 'session.count',
    emittedAs: 'nessy.session.count',
    status: 'emitted',
    note: 'Counted once per session per process, where a stored session first gets a live agent. `start_type` carries `fresh` or `resume`; the page\'s other two values are unreachable here by construction — this fork has no `--continue` entry point and no `claude agents` dashboard process, so emitting either would describe a thing that never happened.',
  },
  {
    documented: 'code_edit_tool.decision',
    emittedAs: 'nessy.code_edit_tool.decision',
    status: 'emitted',
    // P6.461's third counter was `owed` here with a note explaining why the
    // gate it had been designed around could not carry it — `runPreToolUseChecks`
    // has zero call sites in `codex-agent.ts`, so a counter fed from it would be
    // silent on one runtime of three. `23a847d22` (2026-09-08) ANSWERED that by
    // moving the emitter one layer up rather than by widening the gate, and it
    // updated the wire without updating this record, which is the drift
    // `fleet-metric-parity.test.ts` exists to catch and did: the wire named a
    // series this row said was not emitted. Status corrected here, not on the
    // wire — the emitter is real and its site is the one the page describes.
    note: 'Emitted from `SessionManager.respondToPermission` — the moment a card the USER was shown is answered — which is what the page\'s own sentence describes, and which claude and Pi reach through the pre-tool gate\'s prompt while codex reaches it through its approval bridge. The DISCRIMINANT is the request `type` (`file_write`), identical on all three backends, rather than a list of tool names that varies per runtime; the name itself rides as the page\'s `tool_name`. All four documented attributes are emitted. `source` carries only the three answers a card can produce (`user_permanent`, `user_temporary`, `user_reject`); the page\'s other three have NO producer and say so in the event type\'s own docblock — `config` and `hook` are decisions taken without a prompt and never reach a card, and `user_abort` is the bulk dismissal path, which tears pending requests down without knowing which tool each was for.',
  },
  {
    documented: 'active_time.total',
    emittedAs: 'nessy.active_time.total',
    status: 'emitted',
    note: 'The `type=cli` half only, measured across `setProcessing`\'s two edges — the one turn boundary every runtime passes through. The `type=user` half needs a keyboard signal the renderer does not send, so it is absent and SAYS so through its own attribute: an operator filtering `type` sees one series where the page has two, rather than a total that silently means half.',
  },
  {
    documented: 'lines_of_code.count',
    emittedAs: null,
    status: 'refused',
    note: 'REFUSED: needs a per-edit added/removed diff observer. This host applies edits through the runtime and keeps no diff of its own, so producing it would mean re-deriving every edit for a counter.',
  },
  {
    documented: 'commit.count',
    emittedAs: null,
    status: 'refused',
    note: 'REFUSED: needs a git observer watching for commits the agent creates. This host does not watch the repository, and inferring commits from shell commands would count a `git commit` that failed.',
  },
  {
    documented: 'pull_request.count',
    emittedAs: null,
    status: 'refused',
    note: 'REFUSED, and for a stronger reason than its two siblings: the page counts a PR created "through a shell command or an MCP tool", which means classifying arbitrary tool calls by intent. A miscount here would report work that never happened.',
  },
]);

export function createUsageMetrics(env: Record<string, string | undefined> = process.env): UsageMetrics | undefined {
  const config = parseConfig(env);
  return config ? new HostUsageMetrics(config) : undefined;
}

class HostUsageMetrics implements UsageMetrics {
  private readonly series = new Map<string, Series>();
  /** P6.461 — the adoption counters, accumulated beside the usage series. */
  private readonly counters = new Map<string, CounterSeries>();
  private readonly startTimeUnixNano = String(BigInt(Date.now()) * 1_000_000n);
  private timer: ReturnType<typeof setInterval> | undefined;
  private inFlight: Promise<void> | undefined;
  private closed = false;

  constructor(private readonly config: ExporterConfig) {}

  record(turn: UsageMetricsTurn): void {
    if (this.closed) return;
    try {
      for (const [key, series] of collectSeries(turn)) {
        const existing = this.series.get(key);
        if (existing) {
          for (const bucket of Object.keys(series.tokens) as TokenBucket[]) {
            existing.tokens[bucket] += series.tokens[bucket];
          }
          existing.costUsd += series.costUsd;
          existing.costReported = existing.costReported || series.costReported;
        } else if (this.series.size < MAX_SERIES) {
          this.series.set(key, series);
        }
      }
      this.startInterval();
    } catch {
      // Telemetry is best-effort and must never affect agent work.
    }
  }

  count(event: FleetCounterEvent): void {
    if (this.closed) return;
    try {
      const key = counterSeriesKey(event);
      const existing = this.counters.get(key);
      // Seconds for `active_time.total`, one for a session start. A
      // non-finite or negative duration is DROPPED rather than clamped: a clock
      // that went backwards is not zero active time, it is no measurement.
      const value = event.metric === 'active_time.total' ? event.seconds : 1;
      if (!Number.isFinite(value) || value < 0) return;
      if (existing) {
        existing.value += value;
      } else if (this.counters.size < MAX_SERIES) {
        this.counters.set(key, {
          metric: event.metric,
          attributes: counterAttributes(event),
          value,
        });
      }
      this.startInterval();
    } catch {
      // Telemetry is best-effort and must never affect agent work.
    }
  }

  async flush(): Promise<void> {
    // Serialize: two concurrent flushes would each drain half the batch and post
    // partial series, and a drain racing an interval is the normal case.
    const previous = this.inFlight ?? Promise.resolve();
    const operation = previous.then(() => this.post()).catch(() => undefined);
    this.inFlight = operation;
    await operation;
    if (this.inFlight === operation) this.inFlight = undefined;
  }

  async shutdown(): Promise<void> {
    this.closed = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    // The drain. With DELTA temporality the pending batch exists nowhere else,
    // so skipping this loses every count recorded since the last interval.
    await this.flush();
  }

  private startInterval(): void {
    if (this.timer || this.closed) return;
    this.timer = setInterval(() => { void this.flush(); }, this.config.intervalMs);
    // Never keep the process alive for telemetry.
    this.timer.unref?.();
  }

  private async post(): Promise<void> {
    if (this.series.size === 0 && this.counters.size === 0) return;
    const batch = [...this.series.values()];
    const counterBatch = [...this.counters.values()];
    // DELTA hands the batch off — what is exported is cleared, and a lost batch
    // is lost. CUMULATIVE keeps the series and reports running totals since
    // process start, so a dropped export is recovered by the next one.
    if (this.config.temporality === 'delta') {
      this.series.clear();
      this.counters.clear();
    }
    const body = JSON.stringify(
      metricsPayload(batch, counterBatch, this.startTimeUnixNano, this.config.temporality, this.config.resourceAttributes),
    );
    // P6.524 — ONE batch, every destination. Built once so the console readout
    // and the collector can never be shown two different serialisations of the
    // same turns, and awaited in sequence because a console write is
    // synchronous and the collector leg is the only thing worth overlapping.
    for (const destination of this.config.destinations) {
      if (destination.kind === 'console') {
        // The `[telemetry]` prefix is this file's own diagnostic voice, so a
        // reader can filter the stream out of an otherwise busy log. The payload
        // is the OTLP body verbatim, not a prettier summary: an operator
        // debugging a collector needs to see what the collector is being sent.
        console.log(`[telemetry] metrics ${body}`);
        continue;
      }
      await this.postOtlp(destination, body);
    }
  }

  private async postOtlp(destination: OtlpDestination, body: string): Promise<void> {
    try {
      const response = await fetch(destination.url, {
        method: 'POST',
        headers: destination.headers,
        body,
        signal: AbortSignal.timeout(destination.timeoutMs),
        ...otlpTlsFetchOptions(destination.tls, reason => reportOtlpExportFailure({
          signal: 'metrics', endpoint: destination.url, reason,
        })),
      });
      // P6.452 M28 — the status was not read at all before this, so a collector
      // answering 401 or 404 was indistinguishable from one accepting the batch.
      if (!response.ok) {
        reportOtlpExportFailure({
          signal: 'metrics',
          status: response.status,
          endpoint: destination.url,
          reason: otlpFailureReason(response.status),
        });
      }
    } catch {
      // A dropped batch stays dropped: re-queueing under DELTA would double-count
      // on the retry that succeeded after a timeout the collector did receive.
      // It is now COUNTED, which is the part that was missing.
      reportOtlpExportFailure({ signal: 'metrics', endpoint: destination.url, reason: 'transport' });
    }
  }
}

/** Fold one turn into its (backend, model) series. Exported for tests. */
export function collectSeries(turn: UsageMetricsTurn): Array<[string, Series]> {
  const entries: Array<[string, Series]> = [];
  const map = turn.modelUsage;

  if (map && Object.keys(map).length > 0) {
    for (const [model, usage] of Object.entries(map)) {
      // The map's buckets are already disjoint (`agent-sdk/typescript.md:4102`
      // lists inputTokens and the two cache fields separately), so no subtraction.
      entries.push(series({
        backend: turn.backend,
        model,
        costReporting: usage.costReporting,
        ...scopeKey(turn),
      }, {
        input: usage.inputTokens,
        output: usage.outputTokens,
        cacheRead: usage.cacheReadTokens,
        cacheCreation: usage.cacheCreationTokens,
      }, usage.costUsd, usage.costReporting === 'reported'));
    }
    return entries;
  }

  const cacheRead = positive(turn.cacheReadTokens);
  const cacheCreation = positive(turn.cacheCreationTokens);
  // Our adapters fold the cache buckets INTO inputTokens for context display, so
  // emitting all three as-is would count cached tokens twice against a
  // documented vocabulary whose four buckets are disjoint.
  const input = Math.max(0, positive(turn.inputTokens) - cacheRead - cacheCreation);
  const reported = turn.costReporting === 'reported';
  entries.push(series({
    backend: turn.backend,
    model: turn.model?.trim() || 'unknown',
    costReporting: reported ? 'reported' : 'unsupported',
    ...scopeKey(turn),
  }, {
    input,
    output: positive(turn.outputTokens),
    cacheRead,
    cacheCreation,
  }, turn.costUsd, reported));
  return entries;
}

function series(
  key: SeriesKey,
  tokens: Record<TokenBucket, number>,
  costUsd: number | undefined,
  costReported: boolean,
): [string, Series] {
  return [
    `${key.backend}\u0000${key.model}\u0000${key.costReporting}\u0000${key.scope}\u0000${key.overheadSource ?? ''}`,
    {
      ...key,
      tokens: {
        input: positive(tokens.input),
        output: positive(tokens.output),
        cacheRead: positive(tokens.cacheRead),
        cacheCreation: positive(tokens.cacheCreation),
      },
      // A cost of zero from a backend that reports none is NOT zero spend, so it
      // never becomes a data point. See `cost-reporting.ts`.
      costUsd: costReported ? positive(costUsd) : 0,
      costReported,
    },
  ];
}

function positive(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * The scope half of a series key.
 *
 * `overheadSource` is carried ONLY on a host-overhead turn: on a conversation
 * turn it is meaningless, and letting it into the key there would silently split
 * one model's series in two the first time a caller set it by mistake.
 */
function scopeKey(turn: UsageMetricsTurn): Pick<SeriesKey, 'scope' | 'overheadSource'> {
  if (turn.scope !== 'host-overhead') return { scope: 'conversation' };
  const source = turn.overheadSource?.trim();
  return { scope: 'host-overhead', ...(source ? { overheadSource: source } : {}) };
}

/**
 * The opt-in. `monitoring-usage.md:94` — "Enables telemetry collection
 * (required)". `NESSY_ENABLE_TELEMETRY` is the primary spelling and the
 * documented `CLAUDE_CODE_ENABLE_TELEMETRY` a compat alias, following the
 * `isCronDisabled` precedent (`session-tools-core/src/tool-defs.ts`): the
 * Nessy name wins when both are set, and accepted values follow the repo
 * convention (`1/true/yes/on`); anything else, including unset, keeps
 * telemetry off.
 */
export function telemetryOptedIn(env: Record<string, string | undefined>): boolean {
  const truthy = (value: string | undefined): boolean =>
    ['1', 'true', 'yes', 'on'].includes((value ?? '').trim().toLowerCase());
  if (env.NESSY_ENABLE_TELEMETRY !== undefined) return truthy(env.NESSY_ENABLE_TELEMETRY);
  return truthy(env.CLAUDE_CODE_ENABLE_TELEMETRY);
}

/**
 * The opt-OUT, in the standard vocabulary — the switch this fork shipped
 * without, on every runtime.
 *
 * Measured 2026-08-28 before this existed: with the opt-in set and a collector
 * configured, `DO_NOT_TRACK=1`, `DISABLE_TELEMETRY=1` and
 * `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` each left BOTH host exporters
 * running, while `OTEL_METRICS_EXPORTER=none` / `OTEL_LOGS_EXPORTER=none`
 * silenced their own signal — so the instrument could turn an exporter off and
 * the standard names simply had no reader.
 *
 * **This is not a claude-runtime concern.** `SessionManager.recordUsageMetrics`
 * is "Deliberately NOT provider-gated" and rides the backend name as an
 * attribute, so the metrics exporter runs on Pi, anthropic and codex turns
 * alike; the sibling log exporter is Pi's own. A capability row scoring this
 * `n/a` on Pi and codex is scoring the SDK subprocess and missing the host.
 *
 * The three names, and why their value rules differ — `env-vars.md#variables`:
 *
 * - `DO_NOT_TRACK` — "Set to `1` to opt out of telemetry, with the same effect
 *   as `DISABLE_TELEMETRY` … Claude Code reads this variable as a standard
 *   boolean, so `0` leaves telemetry on, and honors it as the cross-tool
 *   convention recognized by many developer CLIs." A standard boolean, so `0`
 *   is NOT an opt-out. Accepted spellings follow this file's own convention
 *   (`1/true/yes/on`, any casing), a superset of the page's "`1` or `true`" and
 *   of the cross-industry convention's `1` — erring toward the opt-out.
 * - `DISABLE_TELEMETRY` — "Set to any non-empty value, such as `1`, to opt out
 *   of telemetry. **Setting it to `0` or `false` still opts out**, unlike most
 *   on/off variables; unset the variable to turn telemetry back on." The page
 *   lists it among the variables that "read only whether you set them at all",
 *   so `0` DOES opt out here. The two rules are genuinely different and
 *   collapsing them into one predicate would get one of the two wrong.
 * - `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` — same set-at-all rule, and
 *   `data-usage.md#telemetry-services` makes it a superset: "You can turn each
 *   off individually with the environment variables below, or disable all
 *   non-essential traffic at once by setting
 *   `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`."
 *
 * **The opt-out beats the opt-in**, deliberately: same posture as
 * `otelExporterDisabled` ("honored as a hard disable, opt-in or not"), and it
 * is what the cross-tool convention means. A fleet whose admin sets
 * `NESSY_ENABLE_TELEMETRY=1` is therefore silenced on a machine whose user
 * exports `DO_NOT_TRACK=1`; that is the capability, not a bug. Upstream's own
 * escape hatch for that tension is a NAMED opt-back-in
 * (`CLAUDE_CODE_ENABLE_FEEDBACK_SURVEY_FOR_OTEL`, "Applies when
 * `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`, `DISABLE_TELEMETRY`, or
 * `DO_NOT_TRACK` is set"), and we ship no equivalent — a new name is a product
 * decision, not a gap to paper over here.
 *
 * **Two names deliberately absent.** `DISABLE_ERROR_REPORTING` gates error
 * reports, and this fork sends none — reading it here would claim a channel we
 * do not have. And there is no `NESSY_`-prefixed opt-out: `DO_NOT_TRACK` and
 * `DISABLE_TELEMETRY` are already vendor-neutral names a corporate shell
 * exports once for every tool on the machine, and prefixing them is exactly
 * how a user's opt-out stops being honored.
 */
export function telemetryOptedOut(env: Record<string, string | undefined>): boolean {
  // "Read only whether you set them at all": any non-empty value, `0` included.
  const setAtAll = (value: string | undefined): boolean => (value ?? '').trim() !== '';
  if (setAtAll(env.DISABLE_TELEMETRY)) return true;
  if (setAtAll(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC)) return true;
  // A standard boolean, so `0`/`false`/unset leave telemetry on.
  return ['1', 'true', 'yes', 'on'].includes((env.DO_NOT_TRACK ?? '').trim().toLowerCase());
}

/**
 * `monitoring-usage.md:95` — "Metrics exporter types, comma-separated. Use
 * `none` to disable". `:96` says the same of `OTEL_LOGS_EXPORTER`:
 * "Logs/events exporter types, comma-separated. Use `none` to disable". One
 * predicate, all three signals — the selector name is the only difference, and
 * `none` anywhere in the list is a hard disable.
 *
 * `OTEL_TRACES_EXPORTER` joined the union for P6.459. It is the BETA selector
 * (`monitoring-usage.md#how-managed-settings-lock-the-otlp-destination` calls it
 * "the beta `OTEL_TRACES_EXPORTER`") and this host exports no spans of its own,
 * but it is the switch {@link tracingOptedIn} reads, and reading it through a
 * second hand-written `split(',')` is how two spellings of one rule drift.
 *
 * Exported for the log exporter in `server-core/src/pi-harness/otlp-telemetry.ts`,
 * which keyed solely on the ambient endpoint until this gate reached it.
 */
export function otelExporterDisabled(
  env: Record<string, string | undefined>,
  selector: 'OTEL_METRICS_EXPORTER' | 'OTEL_LOGS_EXPORTER' | 'OTEL_TRACES_EXPORTER',
): boolean {
  const raw = env[selector];
  if (raw === undefined) return false;
  return raw.split(',').some(entry => entry.trim().toLowerCase() === 'none');
}

/**
 * P6.459 · is this process's operator actually collecting TRACES?
 *
 * The three signals do not share a default and this is the one that is opt-in
 * per signal. `monitoring-usage.md#quick-start` says so in the shape of its own
 * example — *"# 2. Choose exporters (both are optional - configure only what
 * you need)"* — and this host exports no spans at all, so an unset
 * `OTEL_TRACES_EXPORTER` means nobody has asked for a trace stream and there is
 * nothing for a propagated context to join.
 *
 * Deliberately narrower than {@link telemetryOptedIn} on its own, because the
 * only caller turns a runtime's W3C propagation ON. Propagating a trace context
 * into every shell command of a session that is not being traced would push an
 * identifier into other people's processes for no collector to read — the
 * privacy posture in this file's header applies to trace ids exactly as it
 * applies to session ids.
 */
/**
 * P6.538 — MAY an exported record name a person or a session?
 *
 * Owner decision 2026-09-05 D13 = option B: **yes, behind the documented
 * toggles, DEFAULT OFF**, with the vendors' own switch names where they exist
 * and one host implementation where they do not. This is the resolution, and it
 * is read by three places so all three runtimes answer the same question the
 * same way: this file's metrics exporter, `pi-harness/otlp-telemetry.ts`'s log
 * exporter, and `agent/options.ts`, which projects it into the claude CHILD.
 *
 * ## The names are the vendor's; the DEFAULT is ours, and it is inverted
 *
 * `monitoring-usage.md#standard-attributes` gives both switches and their
 * upstream defaults verbatim: `session.id` — *"Unique session identifier"*,
 * controlled by *"`OTEL_METRICS_INCLUDE_SESSION_ID` (default: true)"*; and
 * `user.account_uuid` / `user.account_id`, controlled by
 * *"`OTEL_METRICS_INCLUDE_ACCOUNT_UUID` (default: true)"*. **Upstream defaults
 * both to TRUE. Here both default to FALSE**, which is the whole of D13's
 * "default off" and the reason this predicate exists rather than a bare read.
 *
 * That inversion is not cosmetic and it closes a real hole. `buildClaudeSubprocessEnv`
 * spreads `process.env` unfiltered, so on any machine where an operator had
 * turned telemetry on, the claude CHILD was exporting `session.id`,
 * `user.account_uuid` and `user.account_id` BY THE VENDOR'S DEFAULT while this
 * file's own header said *"no per-user or per-session identifier leaves the
 * operator's machine"*. That sentence was true of our exporters and false of the
 * child beside them. `agent/options.ts` now pins both names explicitly on every
 * claude child, in both directions, so the answer is the host's rather than the
 * vendor's — the same shape `config-writer.ts` uses for codex's
 * `log_user_prompt`, and for the same reason: an upstream default flip must not
 * be able to start shipping identity with nothing failing anywhere.
 *
 * ## What is NOT here, stated rather than omitted
 *
 * The page lists two attributes with no switch at all — `user.id`, *"Always
 * included"*, and `organization.id` / `user.email` / `terminal.type`, *"Always
 * included when available"*. Nothing this host can set turns those off in the
 * child's own stream. `user.id` the page describes as *"Random anonymous
 * identifier generated on first run and persisted in `~/.claude.json`. It
 * contains no personal information and is not derived from your Claude
 * account"*, so it is an installation id rather than a person; the other three
 * are only populated on an authenticated first-party session, which this fork's
 * gateway sessions are not. Neither is a switch we are declining to flip — there
 * is no switch. Recorded so the next reader does not go looking for one.
 *
 * `OTEL_METRICS_INCLUDE_VERSION` and `OTEL_METRICS_INCLUDE_ENTRYPOINT` are
 * deliberately absent from this resolution: both already default to FALSE
 * upstream, and neither names a person or a session — `app.version` and
 * `app.entrypoint` are properties of the software. Pinning them would be this
 * host deciding something D13 did not ask about.
 */
export interface TelemetryIdentitySelection {
  /** `session.id` on exported records. */
  sessionId: boolean;
  /** `user.account_uuid` + `user.account_id`, on the runtimes that have them. */
  accountUuid: boolean;
}

/** The two documented names, exported so the projection cannot spell one differently. */
export const TELEMETRY_IDENTITY_ENV = Object.freeze({
  sessionId: 'OTEL_METRICS_INCLUDE_SESSION_ID',
  accountUuid: 'OTEL_METRICS_INCLUDE_ACCOUNT_UUID',
} as const);

export function resolveTelemetryIdentity(
  env: Record<string, string | undefined>,
): TelemetryIdentitySelection {
  // A standard boolean, and UNSET is FALSE — the inversion described above.
  // `1/true/yes/on` in any casing, this file's own convention, a superset of the
  // page's `true`; anything else is off, because a value we cannot read must not
  // be resolved toward disclosure.
  const on = (name: string): boolean =>
    ['1', 'true', 'yes', 'on'].includes((env[name] ?? '').trim().toLowerCase());
  return {
    sessionId: on(TELEMETRY_IDENTITY_ENV.sessionId),
    accountUuid: on(TELEMETRY_IDENTITY_ENV.accountUuid),
  };
}

export function tracingOptedIn(env: Record<string, string | undefined>): boolean {
  // Same precedence as every other gate here: opt-out, then opt-in, then the
  // signal's own selector.
  if (telemetryOptedOut(env)) return false;
  if (!telemetryOptedIn(env)) return false;
  const raw = env.OTEL_TRACES_EXPORTER;
  if (raw === undefined || raw.trim() === '') return false;
  return !otelExporterDisabled(env, 'OTEL_TRACES_EXPORTER');
}

/**
 * P6.524 — the OTHER three values the selector can take, and what this host
 * does with each.
 *
 * `otelExporterDisabled` above reads the selector as a HARD DISABLE and nothing
 * else, which was honest while `none` was the only value we implemented and
 * dishonest the moment an operator wrote anything else: `console` did nothing,
 * and `prometheus` — a value the page lists — meant *silence*, which is
 * indistinguishable from a working pipeline whose collector is quiet.
 *
 * The page's own column, `monitoring-usage.md#common-configuration-variables`:
 * *"Metrics exporter types, comma-separated. Use `none` to disable"*, with the
 * values `console`, `otlp`, `prometheus`, `none` — and the quick start says the
 * same in a comment, *"# Options: otlp, prometheus, console, none"*. The LOGS
 * selector's column is deliberately one shorter (`console`, `otlp`, `none`):
 * there is no prometheus logs exporter to refuse, which is why this predicate
 * is metrics-only and `otelExporterDisabled` stays shared by both signals.
 *
 * **`prometheus` is REFUSED BY NAME, not implemented and not ignored** (Q-den 61
 * = option A). A Prometheus exporter is a *scrape* exporter: it opens an inbound
 * listening socket, and an inbound listening port on a desktop application has
 * its own bind-failure, port-collision and exposure story that nobody has
 * decided. So the operator is told, by name, that the value was read and
 * declined — the one outcome that is neither a lie nor a silent drop. It stays
 * available on demand.
 *
 * An unrecognised value is announced too and otherwise ignored: the spec lets
 * the list grow, and a name we cannot honour must not look honoured.
 */
export interface MetricsExporterSelection {
  /** `none` anywhere in the list. Beats every other entry, as it always did. */
  disabled: boolean;
  /** Post batches to a collector. The default when the selector is unset. */
  otlp: boolean;
  /** Write batches to this process's own console. */
  console: boolean;
  /** Values read, understood, and declined — with the reason to state. */
  refused: readonly { value: string; reason: string }[];
  /** Values in neither set. */
  unknown: readonly string[];
}

const METRICS_EXPORTER_REFUSALS: Readonly<Record<string, string>> = Object.freeze({
  prometheus: 'a Prometheus exporter is a scrape endpoint, and this desktop application opens no'
    + ' inbound listening socket; use `otlp` or `console`',
});

export function resolveMetricsExporters(
  env: Record<string, string | undefined>,
): MetricsExporterSelection {
  const raw = env.OTEL_METRICS_EXPORTER;
  // Unset is the pre-existing behaviour and must stay it: an operator who
  // configured an endpoint and never wrote a selector still gets OTLP.
  if (raw === undefined || raw.trim() === '') {
    return { disabled: false, otlp: true, console: false, refused: [], unknown: [] };
  }
  const entries = raw.split(',').map(entry => entry.trim().toLowerCase()).filter(entry => entry !== '');
  if (entries.includes('none')) {
    return { disabled: true, otlp: false, console: false, refused: [], unknown: [] };
  }
  const refused: { value: string; reason: string }[] = [];
  const unknown: string[] = [];
  for (const entry of entries) {
    if (entry === 'otlp' || entry === 'console') continue;
    const reason = METRICS_EXPORTER_REFUSALS[entry];
    if (reason) refused.push({ value: entry, reason });
    else unknown.push(entry);
  }
  return {
    disabled: false,
    otlp: entries.includes('otlp'),
    console: entries.includes('console'),
    refused,
    unknown,
  };
}

/**
 * Say the refusal ONCE per distinct value, through the same dedupe the export
 * failures use — a selector is read on every `createUsageMetrics`, and a line
 * per call would drown the log it is written to.
 *
 * Routed to `console.warn` rather than through {@link reportOtlpExportFailure}
 * on purpose: this is a CONFIGURATION verdict, not a dropped batch, and folding
 * it into the dropped-batch counter would inflate a number an administrator
 * reads as "how much telemetry was lost".
 */
export function announceMetricsExporterVerdicts(selection: MetricsExporterSelection): void {
  for (const { value, reason } of selection.refused) {
    const key = `metrics-exporter-refused:${value}`;
    if (announced.has(key)) continue;
    announced.add(key);
    console.warn(
      `[telemetry] OTEL_METRICS_EXPORTER=${value} is not supported here — ${reason}.`
      + ' No metrics are exported through it.',
    );
  }
  for (const value of selection.unknown) {
    const key = `metrics-exporter-unknown:${value}`;
    if (announced.has(key)) continue;
    announced.add(key);
    console.warn(
      `[telemetry] OTEL_METRICS_EXPORTER lists an unrecognised exporter \`${value}\` — it is ignored.`
      + ' Supported values here are `otlp`, `console` and `none`.',
    );
  }
}

// ============================================================================
// P6.452 — what BOTH host exporters owe an administrator
// ============================================================================
//
// Five denominator cells land in these two files (`usage-metrics.ts` and
// `server-core/pi-harness/otlp-telemetry.ts`) because both exporters are OURS:
// no runtime supplies them, so native-first lands on step 2 — the host supplies
// it once and identically for all three runtimes. The helpers below are
// therefore shared by both exporters rather than duplicated in each, so a fix
// to one cannot leave the other behind.

/** Which of the two host exporters a diagnostic came from. */
// P6.732 — `traces` joins the two signals here rather than counting its drops in
// a module of its own, because `readOtlpDroppedBatches` is what an operator's
// diagnostic reads and a third counter it could not see would be a silent third
// pipeline.
export type OtlpSignal = 'metrics' | 'logs' | 'traces';

/** One export failure, in terms an operator can act on and a value never. */
export interface OtlpExportFailure {
  signal: OtlpSignal;
  /** HTTP status when the collector answered, absent when the request threw. */
  status?: number;
  /** The endpoint's ORIGIN and path — never its query, and never a header. */
  endpoint: string;
  /** A short category: `unauthorized`, `not-found`, `transport`, `server`. */
  reason: string;
}

export type OtlpExportDiagnosticSink = (failure: OtlpExportFailure) => void;

const droppedBatches: Record<OtlpSignal, number> = { metrics: 0, logs: 0, traces: 0 };
const announced = new Set<string>();
let diagnosticSink: OtlpExportDiagnosticSink | undefined;

/**
 * M28 — an administrator can see that the collector is refusing us.
 *
 * Before this, `usage-metrics` swallowed every failure in a bare `catch {}` and
 * never looked at the status at all, and `otlp-telemetry` retried only on 429
 * and 5xx — so a collector answering **401 or 404 was indistinguishable from
 * success** on both. A telemetry pipeline that is silently dropping everything
 * looks exactly like a quiet week.
 *
 * The default channel is `console.warn`, once per distinct
 * signal+status+endpoint, because a collector that is refusing us refuses every
 * batch and a per-batch line would drown the log it is written to. The COUNTER
 * is not deduplicated — it is the thing that says how much was lost.
 *
 * Nothing here can carry a credential: the shape has no header and no body
 * field, and the endpoint is stripped of query and fragment by both
 * `parseConfig`s before it ever reaches a config.
 */
export function reportOtlpExportFailure(failure: OtlpExportFailure): void {
  droppedBatches[failure.signal] += 1;
  const key = `${failure.signal}:${failure.status ?? failure.reason}:${failure.endpoint}`;
  const first = !announced.has(key);
  if (first) announced.add(key);
  if (diagnosticSink) {
    diagnosticSink(failure);
    return;
  }
  if (!first) return;
  const status = failure.status === undefined ? '' : ` status=${failure.status}`;
  console.warn(
    `[telemetry] OTLP ${failure.signal} export failed (${failure.reason})${status} endpoint=${failure.endpoint}`
    + ' — batches are being dropped; further identical failures are counted, not logged.',
  );
}

/** How many batches this process has dropped on one signal. */
export function readOtlpDroppedBatches(signal: OtlpSignal): number {
  return droppedBatches[signal];
}

/** Test seam: route diagnostics somewhere assertable and reset the counters. */
export function setOtlpExportDiagnosticSink(sink?: OtlpExportDiagnosticSink): void {
  diagnosticSink = sink;
  droppedBatches.metrics = 0;
  droppedBatches.logs = 0;
  announced.clear();
}

/** Categorise an HTTP status for {@link OtlpExportFailure.reason}. */
export function otlpFailureReason(status: number): string {
  if (status === 401 || status === 403) return 'unauthorized';
  if (status === 404) return 'not-found';
  if (status === 429) return 'throttled';
  if (status >= 500) return 'server';
  return 'rejected';
}

/**
 * M32 — the resource an administrator can query by.
 *
 * `service.name` was the hardcoded literal `nessy-desktop` in both exporters,
 * and an operator's `OTEL_RESOURCE_ATTRIBUTES` — the variable
 * `monitoring-usage.md` itself tells organisations to use to *"distinguish
 * between different groups"*, with the example
 * `department=engineering,team.id=platform,cost_center=eng-123` — reached
 * neither. Both runtimes honour these names natively for their own exports
 * (binary probe: `OTEL_SERVICE_NAME` 7, `OTEL_RESOURCE_ATTRIBUTES` 12, control
 * 0), so an operator who set them saw them on the child's stream and not on
 * ours: one collector, two resources, no way to join them.
 *
 * The coverage marker is appended LAST and is **not overridable**: an operator
 * pair spelling the same key is dropped. That is deliberately the opposite of
 * `withTelemetryCoverage`, which stamps the CHILD's environment and steps aside
 * for an operator's own value — there we are describing THEIR pipeline, here we
 * are describing OUR stream, and a false coverage claim on our own exporter
 * would misdescribe exactly the residue the marker exists to keep honest.
 */
export function otlpResourceAttributes(
  env: Record<string, string | undefined>,
  coverage?: { key: string; value: string },
): Array<{ key: string; value: { stringValue: string } }> {
  const serviceName = env.OTEL_SERVICE_NAME?.trim() || 'nessy-desktop';
  const out = [attribute('service.name', serviceName)];
  const seen = new Set([
    'service.name',
    METRIC_NAMESPACE_UPSTREAM_ATTRIBUTE,
    ...(coverage ? [coverage.key] : []),
  ]);
  for (const entry of (env.OTEL_RESOURCE_ATTRIBUTES ?? '').split(',')) {
    const separator = entry.indexOf('=');
    if (separator < 1) continue;
    const key = entry.slice(0, separator).trim();
    const value = entry.slice(separator + 1).trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(attribute(key, value));
  }
  // P6.461 — the rename, stated where an operator building a dashboard actually
  // looks. The row's own rider: "the fork renames `claude_code.*` to `nessy.*`,
  // so a dashboard built from this page finds nothing." A code comment cannot
  // reach that person; the COLLECTOR can, because the resource travels with
  // every point they are already querying. One attribute, in the direction that
  // fails — someone searching for the page's namespace finds this beside metric
  // names that start with `nessy.` and has the mapping.
  //
  // Non-overridable for the same reason as the coverage marker above: it
  // describes OUR stream, and an operator pair spelling this key would be
  // describing something we know better than they do. The full six-row parity,
  // including the metrics we refuse and why, is the exported
  // `FLEET_METRIC_PARITY` record earlier in this file (rows typed by
  // `FleetMetricParity`). C3.322, 2026-09-12: this sentence and its twin in
  // `packages/server-core/src/pi-harness/otlp-telemetry.ts` both named
  // `describeFleetMetricParity`, which is declared in no file at all — a name
  // for the table that never existed, so nothing could resolve it and no guard
  // could see it. A line comment gets no `{@link}` checking either, so the
  // durable half is that the name written here is one `export` above.
  out.push(attribute(METRIC_NAMESPACE_UPSTREAM_ATTRIBUTE, 'claude_code'));
  if (coverage) out.push(attribute(coverage.key, coverage.value));
  return out;
}

/**
 * The resource key carrying P6.461's namespace mapping. Exported so the exporter
 * and its test name the same string, and so a future rename cannot silently
 * leave the attribute pointing at a namespace we no longer replace.
 */
export const METRIC_NAMESPACE_UPSTREAM_ATTRIBUTE = 'nessy.metric.namespace.upstream';

/** A client certificate pair, already read off disk. */
export interface OtlpClientTls {
  cert: string;
  key: string;
  passphrase?: string;
}

/**
 * M39 — present a client certificate to an mTLS collector.
 *
 * **PREMISE CORRECTED against the page.** The row probed
 * `OTEL_EXPORTER_OTLP_CLIENT_KEY`, which `monitoring-usage.md#mtls-authentication`
 * assigns to the **grpc** protocol row. Both host exporters speak OTLP/HTTP
 * JSON, and for `http/protobuf, http/json` the same table names
 * `CLAUDE_CODE_CLIENT_CERT`, `CLAUDE_CODE_CLIENT_KEY`, and optionally
 * `CLAUDE_CODE_CLIENT_KEY_PASSPHRASE` — which is also what
 * `network-config.md#mtls-authentication` documents. So those are the names read
 * here; the grpc pair is deliberately NOT read, because reading it would claim
 * support for a protocol these exporters do not speak.
 *
 * Read at config time, like everything else in `parseConfig`. The page's
 * hot-rotation behaviour (*"replace the files at the same paths"*, re-read on a
 * connection error) is the CHILD's and is not reproduced here — a residue, named
 * rather than implied: rotating the pair takes an app restart on the host's own
 * exporters.
 *
 * A configured-but-unreadable pair yields `undefined` plus a diagnostic, never a
 * silent plaintext fallback.
 */
export function resolveOtlpClientTls(
  env: Record<string, string | undefined>,
  readPem: (path: string) => string,
  onError?: (reason: string) => void,
): OtlpClientTls | undefined {
  const certPath = env.CLAUDE_CODE_CLIENT_CERT?.trim();
  const keyPath = env.CLAUDE_CODE_CLIENT_KEY?.trim();
  if (!certPath && !keyPath) return undefined;
  if (!certPath || !keyPath) {
    onError?.('mTLS needs both CLAUDE_CODE_CLIENT_CERT and CLAUDE_CODE_CLIENT_KEY; only one is set');
    return undefined;
  }
  try {
    const cert = readPem(certPath);
    const key = readPem(keyPath);
    const passphrase = env.CLAUDE_CODE_CLIENT_KEY_PASSPHRASE;
    return { cert, key, ...(passphrase ? { passphrase } : {}) };
  } catch {
    // The PATH is safe to name and is what an operator needs; the file's
    // CONTENT never appears here.
    onError?.(`mTLS client certificate or key could not be read (${certPath}, ${keyPath})`);
    return undefined;
  }
}

/**
 * Bun's `fetch` takes a `tls` option; Node's does not, and ignores it in
 * silence — which is the one outcome this row exists to prevent. So the option
 * is attached only where it is honoured, and the other branch says so out loud.
 */
export function otlpTlsFetchOptions(
  tls: OtlpClientTls | undefined,
  onUnsupported?: (reason: string) => void,
): Record<string, unknown> {
  if (!tls) return {};
  if (typeof (globalThis as { Bun?: unknown }).Bun === 'undefined') {
    onUnsupported?.(
      'a client certificate is configured but this process cannot present one'
      + ' (fetch here has no TLS client-credential option); exports go out without it',
    );
    return {};
  }
  return { tls: { cert: tls.cert, key: tls.key, ...(tls.passphrase ? { passphrase: tls.passphrase } : {}) } };
}

/** `monitoring-usage.md:112` — default `delta`; `cumulative` accepted. */
function parseTemporality(raw: string | undefined): 'delta' | 'cumulative' {
  return raw?.trim().toLowerCase() === 'cumulative' ? 'cumulative' : 'delta';
}

function parseConfig(env: Record<string, string | undefined>): ExporterConfig | undefined {
  // The standard opt-out is checked FIRST and beats every other signal here.
  if (telemetryOptedOut(env)) return undefined;
  // The opt-in gates everything: an ambient endpoint alone starts nothing.
  if (!telemetryOptedIn(env)) return undefined;
  // And the documented off-switch wins even over an explicit opt-in.
  const selection = resolveMetricsExporters(env);
  if (selection.disabled) return undefined;
  // P6.524 — say what was declined BEFORE deciding there is nothing to do, so a
  // selector of `prometheus` alone is a stated refusal rather than a silence
  // identical to "no endpoint configured".
  announceMetricsExporterVerdicts(selection);

  const destinations: MetricsDestination[] = [];
  if (selection.console) destinations.push({ kind: 'console' });
  const otlp = selection.otlp ? parseOtlpDestination(env) : undefined;
  if (otlp) destinations.push(otlp);
  if (destinations.length === 0) return undefined;

  return {
    destinations,
    resourceAttributes: otlpResourceAttributes(env),
    intervalMs: parsePositiveMs(env.OTEL_METRIC_EXPORT_INTERVAL, DEFAULT_EXPORT_INTERVAL_MS),
    temporality: parseTemporality(env.OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE),
  };
}

/** The collector leg: everything that needs an endpoint, and nothing that does not. */
function parseOtlpDestination(env: Record<string, string | undefined>): OtlpDestination | undefined {
  // `monitoring-usage.md:100` — the per-signal endpoint "overrides general
  // setting". Its documented example value already carries `/v1/metrics`, so a
  // per-signal endpoint is used with its path as given; only the general
  // endpoint gets the signal path appended.
  const metricsEndpoint = env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT?.trim();
  const raw = metricsEndpoint || env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (!raw?.trim()) return undefined;
  try {
    const endpoint = new URL(raw);
    if ((endpoint.protocol !== 'http:' && endpoint.protocol !== 'https:') || endpoint.username || endpoint.password) {
      return undefined;
    }
    endpoint.search = '';
    endpoint.hash = '';
    if (!metricsEndpoint) {
      endpoint.pathname = `${endpoint.pathname.replace(/\/+$/, '')}/v1/metrics`;
    }
    const headers = parseHeaders(env.OTEL_EXPORTER_OTLP_HEADERS);
    if (!headers) return undefined;
    headers.set('Content-Type', 'application/json');
    const url = endpoint.toString();
    const tls = resolveOtlpClientTls(
      env,
      path => readFileSync(path, 'utf8'),
      reason => reportOtlpExportFailure({ signal: 'metrics', endpoint: url, reason }),
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

/**
 * The documented `key=value,key=value` form, values percent-decoded.
 *
 * P6.732 — EXPORTED, so the trace exporter reads `OTEL_EXPORTER_OTLP_HEADERS`
 * with this parser rather than a second copy. A malformed value must mean the
 * same thing to both signals; two parsers is the drift this tree keeps
 * measuring.
 */
export function parseHeaders(raw: string | undefined): Headers | undefined {
  const headers = new Headers();
  if (!raw?.trim()) return headers;
  for (const entry of raw.split(',')) {
    const separator = entry.indexOf('=');
    if (separator < 1) return undefined;
    const key = entry.slice(0, separator).trim();
    if (!key) return undefined;
    try {
      headers.set(key, decodeURIComponent(entry.slice(separator + 1).trim()));
    } catch {
      return undefined;
    }
  }
  return headers;
}

function parsePositiveMs(raw: string | undefined, fallback: number): number {
  if (raw && /^[1-9]\d*$/.test(raw)) {
    const value = Number(raw);
    if (Number.isSafeInteger(value) && value <= MAX_TIMER_MS) return value;
  }
  return fallback;
}

function metricsPayload(
  batch: readonly Series[],
  counters: readonly CounterSeries[],
  startTimeUnixNano: string,
  temporality: 'delta' | 'cumulative',
  resourceAttributes: Array<{ key: string; value: { stringValue: string } }>,
) {
  const aggregationTemporality = temporality === 'cumulative' ? CUMULATIVE : DELTA;
  const timeUnixNano = String(BigInt(Date.now()) * 1_000_000n);
  const tokenPoints = batch.flatMap(entry =>
    (Object.keys(entry.tokens) as TokenBucket[])
      .filter(bucket => entry.tokens[bucket] > 0)
      .map(bucket => ({
        attributes: [
          attribute('backend', entry.backend),
          attribute('model', entry.model),
          attribute('type', bucket),
          attribute('cost_reporting', entry.costReporting),
          ...scopeAttributes(entry),
        ],
        startTimeUnixNano,
        timeUnixNano,
        asInt: String(Math.round(entry.tokens[bucket])),
      })));
  const costPoints = batch
    .filter(entry => entry.costReported && entry.costUsd > 0)
    .map(entry => ({
      attributes: [
        attribute('backend', entry.backend),
        attribute('model', entry.model),
        ...scopeAttributes(entry),
      ],
      startTimeUnixNano,
      timeUnixNano,
      asDouble: entry.costUsd,
    }));

  return {
    resourceMetrics: [{
      resource: { attributes: resourceAttributes },
      scopeMetrics: [{
        scope: { name: 'nessy.usage' },
        metrics: [
          ...(tokenPoints.length > 0 ? [{
            name: 'nessy.token.usage',
            unit: 'tokens',
            sum: { aggregationTemporality, isMonotonic: true, dataPoints: tokenPoints },
          }] : []),
          ...(costPoints.length > 0 ? [{
            name: 'nessy.cost.usage',
            unit: 'USD',
            sum: { aggregationTemporality, isMonotonic: true, dataPoints: costPoints },
          }] : []),
          // P6.461 — the adoption counters, one metric per accumulated name.
          // `session.count` carries the page's "none" unit, so the field is
          // OMITTED rather than written as an empty string: a unit of `""` is a
          // unit, and a scraper that renders it produces `nessy_session_count_`
          // with a trailing separator.
          ...counterMetrics(counters, aggregationTemporality, startTimeUnixNano, timeUnixNano),
        ],
      }],
    }],
  };
}

function attribute(key: string, stringValue: string) {
  return { key, value: { stringValue } };
}

/**
 * P6.461 — the accumulated adoption counters as OTLP metrics.
 *
 * One metric per NAME, with every attribute combination as a data point, which
 * is the shape the two usage series already have and the shape a backend
 * expects: two metrics called `nessy.session.count` in one payload is a
 * duplicate the collector may or may not merge.
 *
 * `active_time.total` is `asDouble` because it is seconds and a turn shorter
 * than a second is the ordinary case; `session.count` is `asInt` because the
 * page's own description is a count.
 */
function counterMetrics(
  counters: readonly CounterSeries[],
  aggregationTemporality: number,
  startTimeUnixNano: string,
  timeUnixNano: string,
) {
  const names: Array<{ metric: FleetCounterEvent['metric']; emittedAs: string; unit?: string }> = [
    { metric: 'session.count', emittedAs: 'nessy.session.count' },
    { metric: 'active_time.total', emittedAs: 'nessy.active_time.total', unit: 's' },
    { metric: 'code_edit_tool.decision', emittedAs: 'nessy.code_edit_tool.decision' },
  ];
  return names.flatMap(({ metric, emittedAs, unit }) => {
    const points = counters
      .filter(entry => entry.metric === metric)
      .map(entry => ({
        attributes: entry.attributes,
        startTimeUnixNano,
        timeUnixNano,
        ...(metric === 'active_time.total'
          ? { asDouble: entry.value }
          // Both counts are integral; only active time is a duration.
          : { asInt: String(Math.round(entry.value)) }),
      }));
    if (points.length === 0) return [];
    return [{
      name: emittedAs,
      ...(unit ? { unit } : {}),
      sum: { aggregationTemporality, isMonotonic: true, dataPoints: points },
    }];
  });
}

/**
 * The `language` attribute of `code_edit_tool.decision`, from the edited file's
 * path.
 *
 * `monitoring-usage.md#code-edit-tool-decision-counter` gives EXAMPLES, not an
 * enumeration — *"Programming language of the edited file, such as
 * `"TypeScript"`, `"Python"`, `"JavaScript"`, or `"Markdown"`. Returns
 * `"unknown"` for unrecognized file extensions."* — so this table is OURS, and
 * saying so is the point: an operator comparing a Nessy dashboard with a Claude
 * Code one will find the same four names and may find a fifth spelled
 * differently. The four the page names are spelled EXACTLY as it spells them;
 * everything else is this fork's own reading of the same rule.
 *
 * `unknown` is the page's own word for an unrecognised extension, which makes it
 * the honest value for a card that carried no path at all — a `file_write`
 * prompt whose `command` was empty is not a language we failed to detect.
 */
export function codeEditLanguage(filePath: string | undefined): string {
  const path = filePath?.trim();
  if (!path) return 'unknown';
  const base = path.split(/[\\/]/).pop() ?? '';
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return 'unknown';
  return CODE_EDIT_LANGUAGES[base.slice(dot + 1).toLowerCase()] ?? 'unknown';
}

/** Extension → language. See {@link codeEditLanguage} on why this list is ours. */
const CODE_EDIT_LANGUAGES: Readonly<Record<string, string>> = Object.freeze({
  // The page's own four, spelled as it spells them.
  ts: 'TypeScript', tsx: 'TypeScript', mts: 'TypeScript', cts: 'TypeScript',
  py: 'Python', pyi: 'Python',
  js: 'JavaScript', jsx: 'JavaScript', mjs: 'JavaScript', cjs: 'JavaScript',
  md: 'Markdown', mdx: 'Markdown',
  // Ours, and every one of them is a language this repository or its runtimes
  // actually edit.
  rs: 'Rust', go: 'Go', java: 'Java', kt: 'Kotlin', kts: 'Kotlin',
  swift: 'Swift', rb: 'Ruby', php: 'PHP', cs: 'C#',
  c: 'C', h: 'C', cc: 'C++', cpp: 'C++', cxx: 'C++', hpp: 'C++', hh: 'C++',
  sh: 'Shell', bash: 'Shell', zsh: 'Shell', ps1: 'PowerShell',
  json: 'JSON', jsonc: 'JSON', yaml: 'YAML', yml: 'YAML', toml: 'TOML',
  html: 'HTML', css: 'CSS', scss: 'CSS', sql: 'SQL', xml: 'XML',
});

/** One counter event's OTLP attributes — the page's set, per metric. */
function counterAttributes(event: FleetCounterEvent): Array<ReturnType<typeof attribute>> {
  switch (event.metric) {
    case 'session.count':
      return [attribute('start_type', event.startType)];
    case 'active_time.total':
      return [attribute('type', event.type)];
    default:
      return [
        attribute('tool_name', event.toolName),
        attribute('decision', event.decision),
        attribute('source', event.source),
        attribute('language', event.language),
      ];
  }
}

/**
 * P3.98/P3.122 — the overhead line's attributes, and NOTHING on a conversation
 * point.
 *
 * Deliberately asymmetric. Stamping `usage_scope="conversation"` on the existing
 * points would change the identity of every series an operator already graphs,
 * for no information: a point with no `usage_scope` is conversation usage, which
 * is what every point meant before this existed. So the total keeps including
 * overhead — a plain `sum` over the metric is still the whole bill — while the
 * breakdown is one filter away.
 *
 * Spelled `usage_scope` rather than `scope` because OTLP already gives `scope` a
 * meaning one level up (`scopeMetrics[].scope`), and two `scope`s in one payload
 * is a question nobody should have to answer twice.
 */
function scopeAttributes(entry: Series): Array<ReturnType<typeof attribute>> {
  if (entry.scope !== 'host-overhead') return [];
  return [
    attribute('usage_scope', entry.scope),
    ...(entry.overheadSource ? [attribute('overhead_source', entry.overheadSource)] : []),
  ];
}
