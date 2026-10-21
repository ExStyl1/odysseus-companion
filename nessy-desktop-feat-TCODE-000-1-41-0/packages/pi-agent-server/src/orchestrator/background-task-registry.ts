export interface BackgroundTaskRegistration {
  readonly taskId: string
  readonly controller: AbortController
  /** Called after the evaluator is aborted so descendants see cancellation first. */
  readonly stopDescendants?: () => Promise<void>
  /** Resolves only after the evaluator has sealed its owner task and reached terminal state. */
  readonly settled?: Promise<unknown>
}

/** What {@link BackgroundTaskRegistry.waitForIdle} observed. */
export interface BackgroundWaitResult {
  /** True when the ceiling was reached with work still in flight. */
  timedOut: boolean
  /** Task ids still running at the ceiling. Empty unless `timedOut`. */
  outstanding: readonly string[]
  /** How many tasks the wait started with. */
  waitedFor: number
}

const SETTLEMENT_TIMEOUT_MS = 10_000

async function waitForSettlement(registration: BackgroundTaskRegistration): Promise<void> {
  if (!registration.settled) return
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      registration.settled.then(() => undefined, () => undefined),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`background-task-settlement-timeout:${registration.taskId}`)),
          SETTLEMENT_TIMEOUT_MS,
        )
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * Owns only in-process background evaluators. Durable children and processes
 * remain owned by their host services and are reached through stopDescendants.
 */
export class BackgroundTaskRegistry {
  private readonly tasks = new Map<string, BackgroundTaskRegistration>()
  private readonly stopping = new Map<string, Promise<boolean>>()
  private readonly stopped = new Set<string>()

  register(registration: BackgroundTaskRegistration): () => void {
    if (this.tasks.has(registration.taskId) || this.stopping.has(registration.taskId)) {
      throw new Error(`background-task-duplicate:${registration.taskId}`)
    }
    this.stopped.delete(registration.taskId)
    this.tasks.set(registration.taskId, registration)
    let terminal = registration.settled === undefined
    const cleanup = () => {
      if (!terminal) return
      if (this.tasks.get(registration.taskId) === registration) {
        this.tasks.delete(registration.taskId)
      }
    }
    if (registration.settled) {
      void registration.settled.then(
        () => { terminal = true; cleanup() },
        () => { terminal = true; cleanup() },
      )
    }
    return cleanup
  }

  async stop(taskId: string): Promise<boolean> {
    if (this.stopped.has(taskId)) return true
    const inFlight = this.stopping.get(taskId)
    if (inFlight) return inFlight
    const registration = this.tasks.get(taskId)
    if (!registration) return false
    const operation = (async () => {
      registration.controller.abort()
      const failures: unknown[] = []
      let terminal = registration.settled === undefined
      try {
        await registration.stopDescendants?.()
      } catch (error) {
        failures.push(error)
      }
      try {
        await waitForSettlement(registration)
        terminal = true
      } catch (error) {
        failures.push(error)
      }
      if (terminal && this.tasks.get(taskId) === registration) {
        this.tasks.delete(taskId)
      }
      if (failures.length > 0) throw new AggregateError(failures, `background-task-stop-failed:${taskId}`)
      this.stopped.add(taskId)
      while (this.stopped.size > 256) {
        const oldest = this.stopped.values().next().value
        if (oldest === undefined) break
        this.stopped.delete(oldest)
      }
      return true
    })()
    this.stopping.set(taskId, operation)
    try {
      return await operation
    } finally {
      if (this.stopping.get(taskId) === operation) this.stopping.delete(taskId)
    }
  }

  abortAll(): void {
    for (const registration of this.tasks.values()) registration.controller.abort()
    for (const taskId of [...this.tasks.keys()]) {
      void this.stop(taskId).catch(() => undefined)
    }
  }

  /**
   * WAIT for every registered evaluator to finish, bounded by `ceilingMs`.
   *
   * The non-interactive counterpart to {@link BackgroundTaskRegistry.drain}:
   * `drain` aborts first and is what interactive teardown wants, while
   * `env-vars.md:307` gives a `-p` run a bounded wait for "background
   * subagents and workflows whose result is part of the output". Nothing is
   * aborted here — the caller drains afterwards, so a timed-out task is still
   * terminated, just after the ceiling rather than instead of the wait.
   *
   * `ceilingMs <= 0` is the documented "wait indefinitely". Every other value
   * is a hard cap: the returned `outstanding` names exactly what was still
   * running, so the caller can state an outcome instead of exiting silently.
   */
  async waitForIdle(ceilingMs: number): Promise<BackgroundWaitResult> {
    const registrations = [...this.tasks.values()]
    const waitedFor = registrations.length
    if (waitedFor === 0) return { timedOut: false, outstanding: [], waitedFor: 0 }
    // A registration with no `settled` is already terminal, exactly as
    // `register` treats it.
    const finished = Promise.allSettled(
      registrations.map(registration => registration.settled ?? Promise.resolve()),
    ).then(() => undefined)
    if (ceilingMs <= 0) {
      await finished
      return { timedOut: false, outstanding: [], waitedFor }
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    const timedOut = new Promise<'timeout'>(resolve => {
      timer = setTimeout(() => resolve('timeout'), ceilingMs)
    })
    try {
      const outcome = await Promise.race([finished, timedOut])
      if (outcome !== 'timeout') return { timedOut: false, outstanding: [], waitedFor }
      // Settled registrations have already removed themselves, so what remains
      // in `tasks` is precisely what was still running at the ceiling.
      return { timedOut: true, outstanding: [...this.tasks.keys()], waitedFor }
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  /** Abort and await every evaluator/descendant tree before generation disposal. */
  async drain(): Promise<void> {
    const taskIds = [...this.tasks.keys()]
    for (const taskId of taskIds) this.tasks.get(taskId)?.controller.abort()
    const outcomes = await Promise.allSettled(taskIds.map(taskId => this.stop(taskId)))
    const failures = outcomes
      .filter((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected')
      .map(outcome => outcome.reason)
    if (failures.length > 0) {
      throw new AggregateError(failures, 'background-task-drain-failed')
    }
  }

  get activeCount(): number {
    return this.tasks.size
  }

  /** Ids of everything currently registered, for a stated wait outcome. */
  get taskIds(): readonly string[] {
    return [...this.tasks.keys()]
  }
}
