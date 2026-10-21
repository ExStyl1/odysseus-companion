/**
 * The per-session scheduler runtime (R27b Task 2).
 *
 * Owns the once-a-second check `scheduled-tasks.md:172` describes, the pending
 * queue that makes `:215` true, and the deletions `:187` and `:136` require.
 * Every decision it makes comes from `cron-scheduler.ts`; this class only holds
 * the timer, the pending set and the store.
 *
 * WHY NOT `SchedulerService` (`packages/shared/src/scheduler/scheduler-service.ts`),
 * which this repo already ships for Automations. That one aligns to the minute
 * boundary and ticks every 60 000 ms. `:172` requires a check "every second" and
 * `:181` requires one-shot tasks to fire up to 90 seconds EARLY — a minute wheel
 * can express neither. It also emits one `SchedulerTick` per WORKSPACE, while
 * these tasks are per session and per project. Its cron matcher is reused in
 * spirit (both end at croner's vixie semantics) but not in code; see
 * `cron-dialect.ts` for the measurement behind that.
 *
 * The delivery seam is deliberately narrow: `isIdle` and `deliver`. `:172`'s
 * "fires between your turns, not while Claude is mid-response" is a property of
 * the host's own between-turns gate — `SessionManager.deliverMonitorEvent` /
 * `flushPendingTaskNotifications`, built for R3 — so this service decides WHEN a
 * prompt is owed and hands it to that gate rather than growing a second one.
 */

import type { ThinkingLevel } from '@nessy-agent/shared/agent/thinking-levels'
import {
  planCronRestore,
  planCronTick,
  type CronFire,
  type SessionCronRecord,
  type SessionCronStore,
} from '@nessy-agent/shared/sessions'

/**
 * P6.376 — one owed delivery: the prompt, plus the dispatch the RECORD chose
 * rather than the one the session happens to be on when the fire lands.
 *
 * `effort` is a level and never a tier — K7's residue: on claude a tier cannot
 * travel (the SDK takes only `model`), so a tier-valued cron field would be
 * honoured on pi and codex and silently dropped on claude, which is the exact
 * class of divergence this plan exists to remove.
 */
export interface SessionCronFire {
  readonly prompt: string
  readonly model?: string
  readonly effort?: ThinkingLevel
}

/** `:172` — "The scheduler checks every second for due tasks". */
export const SESSION_CRON_TICK_MS = 1_000

/** `:130` — "one fallback wakeup about 20 minutes later". */
export const SESSION_CRON_FALLBACK_WAKEUP_MS = 20 * 60_000

/** `tools-reference.md:46` — the reschedule window, "between one minute and one hour out". */
export const SESSION_CRON_WAKEUP_MIN_MS = 60_000
export const SESSION_CRON_WAKEUP_MAX_MS = 3_600_000

/**
 * After a fallback iteration is delivered, its record is protected from the
 * expired sweep while the iteration may still reschedule. When the turn was
 * never observed running, this many consecutive IDLE ticks (one minute at the
 * production tick rate) declare the delivery dead so the record cannot linger.
 */
const AWAITING_RESCHEDULE_IDLE_GRACE_TICKS = 60

export interface SessionCronServiceOptions {
  readonly store: SessionCronStore
  /**
   * False while a turn is running. `:172` — "If Claude is busy when a task comes
   * due, the prompt waits until the current turn ends."
   */
  isIdle(): boolean
  /**
   * Hand one group of due FIRES to the host's between-turns delivery gate.
   *
   * P6.376 widened this from `readonly string[]`. The prompt is no longer the
   * whole request: a record can name the model and the effort level its runs
   * dispatch on, and those travel WITH the prompt because they are per-record
   * and one group can mix records that carry them with records that do not.
   * A fire with neither field is the resting shape and the host's own path for
   * it is unchanged.
   */
  deliver(fires: readonly SessionCronFire[]): void
  /**
   * R39 — the default `/loop` prompt, re-resolved at every DELIVERY of a record
   * marked `promptSource: 'loop-md'`, so `scheduled-tasks.md:120`'s "edits to
   * loop.md take effect on the next iteration" is literal. The STORED prompt is
   * never rewritten — it keeps the create-time resolution for `CronList`.
   */
  resolveDefaultPrompt?(): string
  /** Injectable for tests; production passes nothing and gets `Date.now`. */
  now?(): number
  /** Injectable for tests; production passes nothing and gets one second. */
  tickIntervalMs?: number
}

export class SessionCronService {
  private timer: ReturnType<typeof setInterval> | null = null
  /** Task id → the fire owed. Insertion order is delivery order. */
  private readonly pending = new Map<string, { record: SessionCronRecord; final: boolean }>()
  private readonly fireTimeCache = new Map<string, number | null>()
  /**
   * R39 — dynamic records whose FALLBACK iteration was delivered and may still
   * reschedule. While an id is here the record sits dueless in the store,
   * shielded from the expired sweep (it rides the tick plan's `pending` set);
   * `rearm`/`stopWakeup` release it, and `sweepAwaitingReschedule` ends the
   * loop once the iteration's turn is over without either.
   */
  private readonly awaitingReschedule = new Map<string, { observedBusy: boolean; idleTicks: number }>()
  private ticking = false

  constructor(private readonly options: SessionCronServiceOptions) {}

  private now(): number {
    return this.options.now?.() ?? Date.now()
  }

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => this.tick(), this.options.tickIntervalMs ?? SESSION_CRON_TICK_MS)
    // Never hold the process open for a scheduler; the session owns the
    // lifetime, not the timer.
    this.timer.unref?.()
  }

  stop(): void {
    if (!this.timer) return
    clearInterval(this.timer)
    this.timer = null
  }

  /** Everything the model can see. `CronList` reads this. */
  list(): readonly SessionCronRecord[] {
    return this.options.store.list()
  }

  create(input: {
    schedule: string
    recurring: boolean
    prompt: string
    promptSource?: 'loop-md'
    /** P6.376 — the dispatch this task's runs use. Both optional; absent = the session's. */
    model?: string
    effort?: ThinkingLevel
  }): SessionCronRecord {
    const record = this.options.store.create({ ...input, now: this.now() })
    this.start()
    return record
  }

  /**
   * R39 — start a self-paced `/loop` (`scheduled-tasks.md:62`-`:74`).
   *
   * The record is `dynamic` and `recurring` (so the seven-day expiry applies,
   * `:74`), its schedule field holds the literal `dynamic` (display only —
   * never parsed), and its FIRST `nextFireAt` is NOW: the first iteration is
   * delivered as soon as the creating turn ends, and the model schedules every
   * later wakeup itself with `ScheduleWakeup` at the end of each iteration.
   */
  startSelfPaced(input: { prompt: string; promptSource?: 'loop-md'; model?: string; effort?: ThinkingLevel }): SessionCronRecord {
    const now = this.now()
    const record = this.options.store.create({
      schedule: 'dynamic',
      recurring: true,
      prompt: input.prompt,
      now,
      dynamic: true,
      nextFireAt: now,
      ...(input.promptSource ? { promptSource: input.promptSource } : {}),
      // P6.376 — a self-paced `/loop` is the case the field was asked for:
      // it is the one that runs unattended for hours.
      ...(input.model ? { model: input.model } : {}),
      ...(input.effort ? { effort: input.effort } : {}),
    })
    this.start()
    return record
  }

  /**
   * R39 — the model's reschedule (`ScheduleWakeup` with a delay). Clamped to
   * the documented one-minute-to-one-hour window (`tools-reference.md:46`).
   * Always returns the loop to normal: the fallback marker is cleared, a stale
   * enqueued fire is dropped (a fallback that came due mid-iteration must not
   * deliver after the iteration already rescheduled), and a dueless record
   * awaiting its last chance is released.
   */
  rearm(id: string, delayMs: number): { firesAt: number } {
    const clamped = Math.min(SESSION_CRON_WAKEUP_MAX_MS, Math.max(SESSION_CRON_WAKEUP_MIN_MS, Math.floor(delayMs)))
    const firesAt = this.now() + clamped
    this.options.store.rearm(id, firesAt, false)
    this.pending.delete(id)
    this.awaitingReschedule.delete(id)
    this.start()
    return { firesAt }
  }

  /**
   * R39 — `stop: true` "cancels the pending wakeup immediately" (`:130`). The
   * record is deleted outright; `remove` already drops an enqueued fire.
   */
  stopWakeup(id: string): boolean {
    return this.remove(id) !== undefined
  }

  /**
   * Cancel by id. A cancelled task also drops any fire it had already enqueued:
   * `:128` describes stopping as clearing the pending wakeup, and delivering a
   * prompt for a task the model just cancelled would be indefensible either way.
   */
  remove(id: string): SessionCronRecord | undefined {
    const removed = this.options.store.remove(id)
    if (removed) {
      this.pending.delete(id)
      this.awaitingReschedule.delete(id)
    }
    return removed
  }

  /**
   * P6.295 arm (2) — pause without deleting.
   *
   * A paused record keeps its schedule, its prompt and its id; the tick shields
   * it (see {@link tick}), so it neither fires nor expires while paused. An
   * enqueued fire is dropped, because delivering a prompt for a task the user
   * just paused is the same indefensible thing `remove` already refuses to do.
   *
   * Returns `undefined` for an unknown id so the caller can say "no such task"
   * instead of reporting a success that changed nothing.
   */
  pause(id: string): SessionCronRecord | undefined {
    const record = this.options.store.setPaused(id, true)
    if (record) {
      this.pending.delete(id)
      this.fireTimeCache.delete(id)
    }
    return record
  }

  /**
   * P6.295 arm (2) — resume a paused task.
   *
   * The next fire is computed from the schedule at the moment of resume, exactly
   * as it would be for a task that was never paused: the no-catch-up rule
   * (`scheduled-tasks.md:215`) means a pause is not a debt, and firing once per
   * missed occurrence on resume is the precise behaviour `:215` forbids.
   * `fireTimeCache` is dropped for the id so nothing stale decides that.
   */
  resume(id: string): SessionCronRecord | undefined {
    const record = this.options.store.setPaused(id, false)
    if (record) {
      this.fireTimeCache.delete(id)
      this.start()
    }
    return record
  }

  /**
   * P6.295 arm (2) — run this task now, without waiting for its schedule.
   *
   * The fire is ENQUEUED rather than delivered: `:172`'s "fires between your
   * turns, not while Claude is mid-response" is not a property of the schedule,
   * it is a property of delivery, so a run-now during a turn waits for the turn
   * to end exactly as a due fire does. Everything else — the cursor stamp, the
   * unread counter, the dynamic fallback two-step — then happens in `flush`,
   * once, in the one place that owns it.
   *
   * NEVER `final`. A manual run must not delete a one-shot's record before its
   * own time comes: the user asked to see it now, not to cancel it. A paused
   * task can be run this way, which is the point of pausing rather than deleting
   * — the schedule is off, the task is not gone.
   */
  runNow(id: string): SessionCronRecord | undefined {
    const record = this.options.store.list().find(task => task.id === id)
    if (!record) return undefined
    this.enqueue({ record, final: false, dueAt: this.now() })
    this.start()
    this.flush(this.now())
    return record
  }

  /**
   * P6.295 arm (2) — mark this task's deliveries read, clearing its unread
   * count. `false` for an unknown id.
   */
  acknowledgeRuns(id: string): boolean {
    return this.options.store.acknowledgeRuns(id)
  }

  /**
   * `:216` — the resume sweep. Drops recurring tasks past seven days and
   * one-shots whose time has passed, and returns what it dropped so the caller
   * can say so.
   */
  restore(): { kept: readonly SessionCronRecord[]; dropped: readonly SessionCronRecord[] } {
    const plan = planCronRestore(this.options.store.list(), this.now())
    if (plan.drop.length > 0) this.options.store.replace(plan.keep)
    if (plan.keep.length > 0) this.start()
    return { kept: plan.keep, dropped: plan.drop }
  }

  /** `:216` — "Starting a fresh conversation clears all session-scoped tasks." */
  clear(): void {
    this.stop()
    this.pending.clear()
    this.awaitingReschedule.clear()
    this.fireTimeCache.clear()
    this.options.store.clear()
  }

  /**
   * One check. Exposed so tests drive it against a fixed clock rather than a
   * real second.
   */
  tick(): void {
    if (this.ticking) return
    this.ticking = true
    try {
      const now = this.now()
      this.sweepAwaitingReschedule()
      const plan = planCronTick({
        tasks: this.options.store.list(),
        now,
        // A dueless record awaiting its fallback iteration's decision rides the
        // pending set so the plan neither fires nor expires it (R39).
        //
        // P6.295 arm (2) — a PAUSED record rides the same set, and gets the same
        // two properties for one line: it does not fire, and it does not expire.
        // The second half is the deliberate one — see
        // `SessionCronRecord.paused`. Reusing this seam rather than teaching
        // `planCronTick` a third state keeps the scheduler's decision table the
        // size it was.
        pending: new Set([
          ...this.pending.keys(),
          ...this.awaitingReschedule.keys(),
          ...this.options.store.list().filter(task => task.paused).map(task => task.id),
        ]),
        fireTimeCache: this.fireTimeCache,
      })

      for (const id of plan.expired) this.options.store.remove(id)
      for (const fire of plan.fires) this.enqueue(fire)
      this.flush(now)
    } finally {
      this.ticking = false
    }
  }

  /**
   * R39, `:130`'s second step — "ends the loop when that iteration doesn't
   * reschedule either". A delivered fallback iteration keeps its record alive
   * (dueless, shielded from the expired sweep) so a `ScheduleWakeup` DURING the
   * iteration can still continue the loop. The loop is declared over at the
   * first idle tick after the iteration's turn was observed running — or after
   * a bounded idle grace when no turn ever started, so a failed delivery cannot
   * leave a zombie record.
   *
   * T8 (f) — this shield is IN MEMORY on purpose, and the consequence is
   * recorded rather than fixed: a dueless dynamic record that outlives the
   * service holding its shield (a runtime switch, a quit, a crash) is DROPPED by
   * `planCronRestore`, because `nextCronFireTime` answers `null` for it. That is
   * intended. The shield is scoped to one delivered iteration that might still
   * call `ScheduleWakeup`, and a record whose iteration's process is gone has no
   * iteration left to wait for — `:130`'s "ends the loop when that iteration
   * doesn't reschedule either" reaches the same end by a shorter route.
   * Persisting the shield would instead resurrect a loop nobody is running.
   * The counterpart note is on `planCronRestore` in `cron-scheduler.ts`.
   */
  private sweepAwaitingReschedule(): void {
    if (this.awaitingReschedule.size === 0) return
    const idle = this.options.isIdle()
    for (const [id, state] of this.awaitingReschedule) {
      if (!idle) {
        state.observedBusy = true
        continue
      }
      state.idleTicks += 1
      if (state.observedBusy || state.idleTicks >= AWAITING_RESCHEDULE_IDLE_GRACE_TICKS) {
        this.awaitingReschedule.delete(id)
        this.options.store.remove(id)
      }
    }
  }

  /**
   * Record that one fire is owed.
   *
   * `:187` — "The task fires one final time, then deletes itself". The deletion
   * used to happen HERE, at enqueue, on the reasoning that "the prompt is
   * already held in `pending`, so it still reaches the model". **T8 (e): that
   * premise is false across a teardown.** `pending` is in-memory and the gap
   * between enqueue and delivery is unbounded — `:172` holds a fire that comes
   * due mid-turn until the turn ends — so a runtime switch or a quit inside that
   * window destroyed the queue and found nothing on disk to rebuild it from. A
   * busy-then-switched one-shot lost its prompt outright, with no trace.
   *
   * So the record is MARKED rather than deleted, and `flush` deletes it at the
   * delivery. The marker is not a softer version of the old rule, it is a
   * stricter one: the crash window the deletion-at-enqueue was defending against
   * (a re-fire of an expired task) is closed by the marker too, because
   * `planCronTick` fires an `owedFire` record exactly once and `flush` removes it
   * — where an unmarked record, restored, would have gone back to consulting its
   * schedule.
   *
   * A NON-final fire is deliberately NOT stamped here. Stamping at enqueue time
   * moves the cursor to the moment the task came due, so once the fire is
   * finally delivered — possibly forty minutes later — every occurrence in
   * between is still ahead of the cursor and the task immediately fires again,
   * once per missed interval. That is the exact behaviour `:215` forbids, and it
   * is what this code did before `session-cron-service.test.ts`'s busy-turn case
   * caught it. The stamp belongs to the DELIVERY, so it lives in `flush`.
   */
  private enqueue(fire: CronFire): void {
    if (this.pending.has(fire.record.id)) return
    this.pending.set(fire.record.id, { record: fire.record, final: fire.final })
    if (fire.final) this.markOwedFire(fire.record.id)
  }

  /**
   * T8 (e) — stamp the durable "this fire is owed" marker. Written through
   * `replace` rather than a store method of its own: the store's whole surface
   * re-reads the file on every call, so the read-modify-write here is the same
   * shape `markFired` and `rearm` already use, one level up.
   */
  private markOwedFire(id: string): void {
    const tasks = this.options.store.list()
    if (!tasks.some(task => task.id === id && task.owedFire !== true)) return
    this.options.store.replace(tasks.map(task => (task.id === id ? { ...task, owedFire: true } : task)))
  }

  /**
   * Hand the group to the host, but only between turns.
   *
   * Drained BEFORE the call, the same discipline `flushPendingTaskNotifications`
   * uses: `deliver` starts a turn, and a fire arriving during that call must join
   * the next group rather than be delivered twice.
   *
   * R39 — two per-fire decisions live here because the delivery IS the fire:
   *
   * 1. A `promptSource: 'loop-md'` record delivers `resolveDefaultPrompt()`
   *    re-resolved NOW, never its stored prompt, so a loop.md edit takes effect
   *    on the next iteration (`:120`). The stored prompt is untouched.
   * 2. A dynamic record's pending wakeup is consumed and the `:130` fallback
   *    two-step advances: a normal iteration pre-arms the ONE ~20-minute
   *    fallback at delivery (a rearm or stop during the iteration replaces or
   *    deletes it, so it is observable only when the iteration ends without
   *    either); a delivery whose fallback was already armed IS the fallback
   *    iteration — nothing further is armed, the record goes dueless, and
   *    `sweepAwaitingReschedule` ends the loop unless the iteration
   *    reschedules. Without this step a delivered dynamic record would still
   *    be due and re-fire every tick.
   */
  private flush(now: number): void {
    if (this.pending.size === 0) return
    if (!this.options.isIdle()) return
    const owed = [...this.pending.values()]
    this.pending.clear()
    const fires: SessionCronFire[] = []
    for (const { record, final } of owed) {
      // The delivery IS the fire, so this is where the cursor moves (`:215`) —
      // and, T8 (e), where a final fire's record leaves the store. Removing it
      // BEFORE `deliver` is called keeps the old ordering guarantee: a throwing
      // delivery must not leave a record that fires again.
      if (final) this.options.store.remove(record.id)
      else this.options.store.markFired(record.id, now)
      if (record.dynamic && !final) {
        if (record.fallbackArmed) {
          this.options.store.rearm(record.id, undefined, true)
          this.awaitingReschedule.set(record.id, { observedBusy: false, idleTicks: 0 })
        } else {
          this.options.store.rearm(record.id, now + SESSION_CRON_FALLBACK_WAKEUP_MS, true)
        }
      }
      fires.push({
        prompt: record.promptSource === 'loop-md' && this.options.resolveDefaultPrompt
          ? this.options.resolveDefaultPrompt()
          : record.prompt,
        // P6.376 — read from the RECORD at delivery, beside the prompt, for
        // the same reason `promptSource` is resolved here: the delivery IS the
        // fire, so this is the only moment that knows which record owes it.
        ...(record.model ? { model: record.model } : {}),
        ...(record.effort ? { effort: record.effort } : {}),
      })
    }
    this.options.deliver(fires)
  }

  /** Ids waiting for the current turn to end. Diagnostics and tests. */
  pendingIds(): readonly string[] {
    return [...this.pending.keys()]
  }
}
