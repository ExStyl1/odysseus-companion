/**
 * P6.449 / denominator M18 — the ONE reading of what a hook run actually did.
 *
 * `hooks.md#debug-hooks`, verbatim: *"Hook execution details, including which
 * hooks matched, their exit codes, and full stdout and stderr, are written to
 * the debug log file."* That is the whole subject: which hook, what code, what
 * it printed. Three runtimes learn it three different ways and this module is
 * the single place that turns any of them into something a person reads, so a
 * hook that fails on codex and the same hook failing on claude produce the same
 * sentence.
 *
 * ## Native mechanism, asked per runtime — and the row's clause CORRECTED
 *
 * The row's native note says of claude *"writes a debug file we already open,
 * so extending the reader is cheap"*, and points at the weaker of two channels.
 * Measured in the vendored SDK, claude publishes the whole thing as TYPED
 * events: `SDKHookResponseMessage` (`sdk.d.ts:4168`) carries `hook_name`,
 * `hook_event`, `exit_code`, `outcome`, and BOTH `stdout` and `stderr` as
 * separate required fields — the page's three facts, structured — and
 * `includeHookEvents` is already switched on in this build (P3.336). Reading a
 * typed event beats scraping `~/.claude/debug/<session-id>.txt` for the same
 * data, so the debug file stays what it is today: the API-error reader's, not
 * the hook reader's.
 *
 * codex publishes `HookStartedNotification` / `HookCompletedNotification` with a
 * `HookRunSummary` (status, `entries[]` of `HookOutputEntry`), which is the same
 * shape by another name. Pi's runner is ours. So all three have a structured
 * source and none of them needs a log scraper — this module is the host seam
 * that makes the three agree, which is the half native-first does not supply on
 * its own.
 *
 * ## What the transcript says, and what it deliberately does not
 *
 * `hooks.md#exit-code-0`, verbatim: *"Stderr from a hook that exits 0 goes to
 * the debug log only, never the transcript, and Claude never sees it."* So a
 * SUCCESSFUL hook's output gets {@link HookRunReport.detail} and NO
 * {@link HookRunReport.message}: the detail is what a hook-run VIEW or a debug
 * channel renders, and the transcript stays as quiet as the page says it is.
 * Splitting the two is what lets one function serve both surfaces without
 * either one deciding the other's policy.
 *
 * A failure is the opposite case, and the page describes a lossy rendering:
 * `hooks.md#other-exit-codes`, verbatim, on a non-blocking failure — *"the
 * transcript shows a `<hook name> hook error` notice followed by the first line
 * of stderr, prefixed with `Failed with non-blocking status code:`. To capture
 * the full stderr, enable debug logging."* We keep more than the first line,
 * bounded, because the alternative here is not a terminal the user can scroll.
 */

/**
 * The runtimes a hook can run on. Named so a report can say which one it was.
 *
 * P6.643 added `host`, and it is not a fourth runtime: it is the HOST's own
 * automation system, whose hooks run identically for a session on any of the
 * three (`BaseAgent.emitAutomationEvent` is the single funnel). Labelling those
 * runs `pi` would have been the convenient lie -- the runner is Pi's file, the
 * runs are everyone's -- and a reader comparing "the same hook on claude and on
 * codex" would have seen `pi` on both and concluded the wrong thing.
 */
export type HookRunRuntime = 'pi' | 'claude' | 'codex' | 'host'

/**
 * How a hook run ended, in the vocabulary the claude SDK already uses, plus
 * `timeout` for the runners that distinguish it, and `blocked` for a hook that
 * ran and REFUSED (F1.515: codex's `HookRunStatus::Blocked` — a PermissionRequest
 * deny, an exit 2 with a reason). A refusal is a verdict, not a failure, and a
 * transcript line that said "failed" for the unattended-automation floor doing
 * its job was the defect. A runtime that reports something else maps into the
 * nearest of these at its own adapter rather than widening this union again,
 * so the report's rules stay total.
 */
export type HookRunOutcome = 'success' | 'error' | 'cancelled' | 'timeout' | 'blocked'

/** One hook run, as any of the three runtimes can describe it. */
export interface HookRunObservation {
  readonly runtime: HookRunRuntime
  /** The event that matched, e.g. `PreToolUse`. Always known. */
  readonly event: string
  /** The hook's own name when the runtime has one; the event carries it otherwise. */
  readonly name?: string
  readonly outcome: HookRunOutcome
  readonly exitCode?: number
  readonly stdout?: string
  readonly stderr?: string
  /**
   * A stream the runtime already reduced to one string. claude sends `output`
   * beside `stdout`/`stderr`; it is read only when both of those are empty, so
   * a runtime that duplicates its streams here cannot make the detail say
   * everything twice.
   */
  readonly output?: string
}

export interface HookRunReport {
  /**
   * What the transcript says, or `undefined` when the run needs no line there.
   * A hook the user never has to think about must not cost them a line.
   */
  readonly message?: string
  /**
   * The full text for a hook-run view or a debug channel, capped. Present
   * whenever the run printed anything at all, including on success — where the
   * transcript stays silent by the page's own rule.
   */
  readonly detail?: string
  /** `warning` is the level this host persists into a transcript. */
  readonly level: 'info' | 'warning'
  /** True when {@link HookRunReport.detail} was cut at the cap. */
  readonly truncated: boolean
}

/**
 * The bound on the detail, and why there is one at all.
 *
 * Before this, the claude arm interpolated a hook's stderr into a PERSISTED
 * transcript warning with no bound, so one runaway hook could write megabytes
 * into a session's history — a hook is an arbitrary user program and its output
 * is not a size we control. Two thousand characters is far more than the "first
 * line of stderr" the page renders and small enough that a persisted line stays
 * a line. The cut is always ANNOUNCED, because a silently truncated error
 * message is how a reader concludes the wrong thing about a failure.
 */
export const HOOK_RUN_DETAIL_MAX_CHARS = 2_000

/** The name a person would use for this hook: its own, or the event it matched. */
export function hookRunLabel(observation: HookRunObservation): string {
  const name = observation.name?.trim()
  return name && name.length > 0 ? name : observation.event
}

function cap(text: string): { text: string; truncated: boolean } {
  if (text.length <= HOOK_RUN_DETAIL_MAX_CHARS) return { text, truncated: false }
  return { text: text.slice(0, HOOK_RUN_DETAIL_MAX_CHARS), truncated: true }
}

/**
 * Both streams, each labelled, because "it failed and printed nothing" and "it
 * failed and printed to the stream you are not reading" are different facts and
 * used to be indistinguishable here.
 *
 * The claude arm read `stderr || output` and NEVER `stdout`, although the SDK
 * declares it as a required field: a hook that failed while writing only to
 * stdout produced `Hook X failed (exit 2)` with no text at all, which is the
 * exact shape of "not legible without a terminal".
 *
 * EXPORTED for the Pi arm (P6.449), which reuses the rule without the sentence.
 * Pi's hook runner is ours — `runHookCommand` in `automations/hook-command.ts`
 * — and its user-facing notice keeps the page's own wording (`<hook name> hook
 * error` followed by the first line), so it takes this join and builds its own
 * summary rather than calling {@link reportHookRun}. What the three arms have
 * to agree about is WHICH BYTES a failure is allowed to be described by; the
 * sentence is each surface's own. The parameter is structural rather than a
 * {@link HookRunObservation} for exactly that reason: a caller with no runtime
 * to declare can still ask this question.
 */
export function joinHookRunStreams(streams: {
  readonly stdout?: string
  readonly stderr?: string
  readonly output?: string
}): string {
  const stdout = streams.stdout?.trim() ?? ''
  const stderr = streams.stderr?.trim() ?? ''
  if (stdout && stderr) return `stderr: ${stderr}\nstdout: ${stdout}`
  if (stderr) return stderr
  if (stdout) return stdout
  return streams.output?.trim() ?? ''
}

/**
 * The one reading. Total over {@link HookRunOutcome}, so a new runtime plugs in
 * by producing an observation rather than by writing a fourth sentence.
 */
export function reportHookRun(observation: HookRunObservation): HookRunReport {
  const joined = joinHookRunStreams(observation)
  const { text, truncated } = cap(joined)
  const detail = text.length > 0
    ? (truncated ? `${text}… (cut at ${HOOK_RUN_DETAIL_MAX_CHARS} characters)` : text)
    : undefined
  const label = hookRunLabel(observation)

  if (observation.outcome === 'success') {
    // The page's rule, kept: a hook that succeeded says nothing in the
    // transcript however much it printed. The detail still travels, for the
    // view and the debug channel.
    return { level: 'info', truncated, ...(detail === undefined ? {} : { detail }) }
  }

  if (observation.outcome === 'cancelled') {
    // Not a failure and not a success: the hook did not finish, usually because
    // the user interrupted the turn. Worth SAYING — a cancelled PreToolUse hook
    // is why a tool did not run — and not worth persisting, because an
    // interrupt cancels every hook in flight at once.
    return {
      message: `Hook ${label} was cancelled`,
      level: 'info',
      truncated,
      ...(detail === undefined ? {} : { detail }),
    }
  }

  const exit = typeof observation.exitCode === 'number' ? ` (exit ${observation.exitCode})` : ''
  // F1.515 — a refusal says what it did; persisted like a failure, because it is
  // why the action did not happen, and a person has to be able to find that.
  const verb = observation.outcome === 'timeout' ? 'timed out' : observation.outcome === 'blocked' ? 'blocked the action' : 'failed'
  return {
    message: `Hook ${label} ${verb}${exit}${detail ? `: ${detail}` : ''}`,
    level: 'warning',
    truncated,
    ...(detail === undefined ? {} : { detail }),
  }
}

/**
 * P6.643 - one recorded hook run.
 *
 * The row: *"the host hook-run VIEW (P6.449's last deliverable) needs a
 * per-session run store keyed by `hook_id`; `reportHookRun` is the formatter it
 * would use and nothing stores the runs."* {@link reportHookRun} above turns a
 * run into a sentence and forgets it; three arms call it and the sentence goes
 * to the transcript or to a debug line. So `/hooks` could say what WILL run and
 * nothing could say what DID.
 */
export interface HookRunRecord {
  /** The grouping key - see {@link hookRunKey} for what "hook id" means here. */
  readonly key: string
  readonly event: string
  /** {@link hookRunLabel} of the observation. */
  readonly label: string
  readonly runtime: HookRunRuntime
  readonly outcome: HookRunOutcome
  /** Wall-clock ms when the run was recorded. */
  readonly at: number
  /** The one reading, so the store and the transcript cannot word it differently. */
  readonly report: HookRunReport
}

/**
 * The identity a run is grouped under.
 *
 * The row says "keyed by `hook_id`", and the nearest thing this product has to
 * one is `HookBindingView.name` - *"the matcher's own name - `<plugin>/<hook-id>`
 * for an imported hook"* - which is exactly what {@link hookRunLabel} returns
 * when the runtime supplies a name. The EVENT is part of the key rather than
 * only a field: one command bound to two events is two things a user reads
 * separately, and collapsing them would make a `PreToolUse` failure and a
 * `Stop` failure share a five-deep window.
 *
 * Runtime is deliberately NOT in the key. A session runs on one runtime at a
 * time, and after a runtime switch the same hook's history should stay one
 * history rather than splitting in two.
 */
export function hookRunKey(observation: HookRunObservation): string {
  return `${observation.event} ${hookRunLabel(observation)}`
}

/** Runs kept per hook. Five is a window, not an archive - see {@link HookRunStore}. */
export const HOOK_RUN_STORE_MAX_PER_HOOK = 5

/** Distinct hooks kept. Beyond this the least recently RUN hook is dropped. */
export const HOOK_RUN_STORE_MAX_HOOKS = 50

/**
 * P6.643 - the per-session hook-run store.
 *
 * **Bounded in two directions, because one bound is not enough.** A per-hook
 * window alone lets a session that fires a thousand DISTINCT hooks grow without
 * limit; a total cap alone lets one chatty hook evict every other hook's
 * history, which is the one a user is most likely to be looking for. So: the
 * last {@link HOOK_RUN_STORE_MAX_PER_HOOK} runs of each hook, and at most
 * {@link HOOK_RUN_STORE_MAX_HOOKS} hooks, evicting the least recently run. A
 * hook is an arbitrary user program run on every tool call - the same reason
 * {@link HOOK_RUN_DETAIL_MAX_CHARS} exists one function up.
 *
 * **In memory and not persisted, stated rather than discovered.** A run history
 * is a debugging aid for the session you are in; persisting it would put an
 * arbitrary program's output - already capped but not sanitised beyond the
 * runner's own redaction - into a file that outlives the question. A restart
 * starts the history empty, which is the harmless direction.
 *
 * {@link HookRunStore.record} is the only writer and it FORMATS through
 * {@link reportHookRun}, so the store cannot describe a run differently from the
 * transcript. It returns the report, so a caller that already needed one pays
 * nothing to also store it.
 */
export class HookRunStore {
  private readonly runs = new Map<string, HookRunRecord[]>()

  constructor(
    private readonly maxPerHook: number = HOOK_RUN_STORE_MAX_PER_HOOK,
    private readonly maxHooks: number = HOOK_RUN_STORE_MAX_HOOKS,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Format the run and keep it. Returns the same report {@link reportHookRun} would. */
  record(observation: HookRunObservation): HookRunReport {
    const report = reportHookRun(observation)
    const key = hookRunKey(observation)
    const entry: HookRunRecord = {
      key,
      event: observation.event,
      label: hookRunLabel(observation),
      runtime: observation.runtime,
      outcome: observation.outcome,
      at: this.now(),
      report,
    }
    const existing = this.runs.get(key)
    // Re-inserting moves the key to the end of `Map`'s insertion order, which is
    // what makes "the least recently RUN hook" the first key below.
    if (existing) this.runs.delete(key)
    const next = [...(existing ?? []), entry].slice(-this.maxPerHook)
    this.runs.set(key, next)
    while (this.runs.size > this.maxHooks) {
      const oldest = this.runs.keys().next()
      if (oldest.done) break
      this.runs.delete(oldest.value)
    }
    return report
  }

  /** Every hook that ran, most recently run first, each with its own window oldest-first. */
  groups(): readonly { key: string; event: string; label: string; runs: readonly HookRunRecord[] }[] {
    return [...this.runs.entries()]
      .reverse()
      .map(([key, runs]) => ({ key, event: runs[0]!.event, label: runs[0]!.label, runs }))
  }

  /** True when nothing has run yet - the caller decides what to say about it. */
  get isEmpty(): boolean {
    return this.runs.size === 0
  }
}
