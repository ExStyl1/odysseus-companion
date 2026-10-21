import type {
  PiChildResult,
  PiChildSessionRecordV1,
  PiChildSessionStateV1,
  PiChildStartInput,
} from '@nessy-agent/shared/agent/pi-harness/child-session-port'
import type { SessionKey } from '@nessy-agent/shared/sessions/session-key'
import { resolveManagedPiPolicyFloor } from '@nessy-agent/shared/agent/pi-harness/managed-policy'
import { GUARDIAN_POLICY_PROMPT } from '@nessy-agent/shared/prompts/guardian'
const EMPTY_STATE: PiChildSessionStateV1 = { schemaVersion: 1, revision: 0, sealedOwnerTaskIds: [], children: [] }

interface ChildRuntime {
  start(record: PiChildSessionRecordV1): Promise<{ childSessionKey: SessionKey; transcriptId: string; worktreeLeaseId?: string; status?: PiChildSessionRecordV1['status']; output?: string; result?: string; inputTokens?: number; outputTokens?: number; costUsd?: number; webSearchesConsumed?: number; turnLimitReached?: true }>
  resume(record: PiChildSessionRecordV1, input: string): Promise<{ status: PiChildSessionRecordV1['status']; output?: string; result?: string; error?: string; inputTokens?: number; outputTokens?: number; costUsd?: number; webSearchesConsumed?: number; turnLimitReached?: true }>
  steer(record: PiChildSessionRecordV1, message: string): Promise<void>
  stop(record: PiChildSessionRecordV1): Promise<void>
  monitor?: (record: PiChildSessionRecordV1) => Promise<{ status: PiChildSessionRecordV1['status']; output?: string; result?: string; error?: string; inputTokens?: number; outputTokens?: number; costUsd?: number; webSearchesConsumed?: number; turnLimitReached?: true }>
  /**
   * What the child has produced SO FAR, for a child that has not settled.
   *
   * `record.output` is written only at a terminal transition, and a background
   * child's `start` resolves the instant it is spawned — so for the whole time a
   * fork is working, the record says `''` and `attach` served nothing. The text
   * was never missing: the child is a real session and its assistant messages
   * were already on it (measured live, 2026-07-30 — 896 characters across four
   * assistant messages while `read_child` returned 0).
   *
   * `sub-agents.md:1019` — a fork "runs in the background while you keep
   * working", and a panel that can only show results is the weaker half of that.
   *
   * Optional so a runtime that cannot look inside its children keeps today's
   * behaviour exactly. Must never throw: an unreadable child is a read that
   * returns what the record holds, not a failed control action.
   */
  readLiveOutput?: (record: PiChildSessionRecordV1) => Promise<string>
}

/**
 * Upper bound on any single child-result string. Exported so the host's
 * partial-output recovery bounds with the SAME number and the SAME function
 * (`boundUtf8`) instead of a second, drifting copy.
 *
 * P2.393 — what it protects, and which of its three uses needed a marker.
 * It bounds a transcript this process holds and ships, in BYTES; it is not an
 * implementation of any number in `tools-reference.md#output-limits`, which
 * states its figures in characters and is about the Bash tool.
 *
 * - `attach` and `searchOutput` cut with it and are HONEST by construction: the
 *   first returns a cursor advanced by exactly the bytes it served, so a
 *   truncated read is a followable read; the second returns matched lines under
 *   a declared `MAX_SEARCH_RESULTS`.
 * - `getResult` was not. Its value goes into the text `get_subagent_result`
 *   hands the parent model, with no cursor and no signal, so a child that wrote
 *   more simply looked as though it had stopped. That path now announces the
 *   cut — see {@link boundField}.
 */
export const MAX_RESULT_BYTES = 64 * 1024

/**
 * The host's refusal when this session has already spent past its
 * `--max-budget-usd` ceiling.
 *
 * The cap's producer is the backend chat loop (`pi-agent.ts`,
 * `base-agent.ts`): it ends the parent's turn with
 * `terminalReason: 'max_budget_usd'` and aborts the parent's own session. That
 * abort stops the parent and NOTHING BELOW IT — a background child is a
 * separate managed session with its own agent — so this ceiling has to be
 * stated again at the one door every child comes through.
 *
 * The literal travels to the model's side of the wire: `pi-agent.ts`'s
 * `handleChildSessionRequest` replies with `error.message` verbatim, and the Pi
 * subprocess's spawner recognises it and turns it into a sentence the model can
 * act on. The spawner RE-DECLARES this string rather than importing it —
 * server-core is host code and must never enter the subprocess bundle — and the
 * two are pinned equal by
 * `packages/pi-agent-server/src/orchestrator/spawner-budget-cap.test.ts`.
 */
export const CHILD_SESSION_BUDGET_EXHAUSTED_ERROR = 'child-session-max-budget-usd-exhausted'
/**
 * The operator's OFF SWITCH for background agents, refused here — P6.237.
 *
 * `admin-setup.md#decide-what-to-enforce` is the page; the key is the managed
 * policy's `disableAgentView`, which is also the claude SDK's own spelling
 * ("Disable agent view (`claude agents`, `--bg`, /background, the on-demand
 * daemon)"). It is enforced HERE rather than per runtime because `start()` is
 * the single admission point every background surface reaches — the background
 * CLI surface, the flag, the slash command and the on-demand supervisor — so
 * one `if` binds Pi, claude and codex identically. That is native-first step 2:
 * the host supplies it uniformly, because only one of the three runtimes has a
 * key of its own and its policy tier does not carry that key anyway
 * (`claude-managed-settings.ts`, `CLAUDE_MANAGED_GAPS.disableAgentView`).
 *
 * A distinct string from the budget cap on purpose: the two refusals are the
 * same shape and different facts, and a caller that cannot tell "your
 * administrator turned this off" from "you have spent your budget" tells the
 * user to wait for something that is never coming back.
 */
export const CHILD_SESSION_AGENT_VIEW_DISABLED_ERROR = 'child-session-disabled-by-managed-policy'
/**
 * The non-verbose tier of the same cap.
 *
 * P2.393 — measured rather than assumed: this bounds a MODEL-FACING string.
 * `get_subagent_result` (`pi-agent-server/src/orchestrator/subagent-tool.ts`)
 * puts `result.result ?? result.output` straight into the text it returns to the
 * parent model, so a child that wrote more than this is read by the model as if
 * it had stopped there. That is why {@link boundResult} announces the cut: the
 * defect `config/bash-output-limits.ts` exists to prevent is a reader that
 * cannot tell truncation from completion, and this was a second path with the
 * same shape.
 *
 * The tier is chosen by the caller's own `verbose` flag, so the marker names
 * both numbers and points at the flag when there is more to be had.
 */
const DEFAULT_RESULT_BYTES = 16 * 1024
const MAX_SEARCH_RESULTS = 100

interface PendingAdmission {
  cancelled: boolean
  settled: Promise<void>
  resolveSettled: () => void
  didSettle: boolean
}

export class ChildSessionService {
  private state: PiChildSessionStateV1
  private commitTail: Promise<void> = Promise.resolve()
  private readonly startsInFlight = new Set<Promise<PiChildResult>>()
  private readonly runtimeStartsInFlight = new Set<string>()
  private readonly stopInFlight = new Map<string, Promise<void>>()
  private readonly pendingAdmissions = new Map<string, PendingAdmission>()
  private readonly ownerCompletionInFlight = new Map<string, { promise: Promise<void>; failed: boolean }>()
  private drainInFlight?: Promise<void>
  private drained = false
  private strictDrain = false
  private beforeStart?: (record: PiChildSessionRecordV1) => Promise<{ additionalContext?: string } | void> | { additionalContext?: string } | void
  private emit?: (event: 'SubagentStart' | 'SubagentStop', record: PiChildSessionRecordV1) => Promise<void> | void

  constructor(private readonly options: {
    parentSessionKey: SessionKey
    initialState?: unknown
    persist(state: PiChildSessionStateV1): Promise<void>
    runtime: ChildRuntime
    makeId?: () => string
    now?: () => number
    /**
     * Has this session already spent past its USD ceiling?
     *
     * A READER, not a value: the service is built once and outlives every turn,
     * while the verdict arrives mid-conversation. Absent = no ceiling, which is
     * byte-identical to the behaviour before P2.5.
     */
    budgetExhausted?: () => boolean
    /**
     * P6.237 — a seam for the managed `disableAgentView`, so a test can drive
     * the refusal without touching the process-scoped policy floor. Production
     * leaves it unset and `assertAgentViewEnabled` reads the floor.
     */
    disabledByPolicy?: () => boolean
    validateOwnerTaskId?: (taskId: string) => void
    ensureOwnerTaskId?: (taskId: string, title: string) => Promise<void>
    completeOwnerTaskId?: (taskId: string) => Promise<void>
    beforeStart?: (record: PiChildSessionRecordV1) => Promise<{ additionalContext?: string } | void> | { additionalContext?: string } | void
    emit?: (event: 'SubagentStart' | 'SubagentStop', record: PiChildSessionRecordV1) => Promise<void> | void
  }) {
    this.state = parseState(options.initialState)
    this.beforeStart = options.beforeStart
    this.emit = options.emit
  }

  setBeforeStart(beforeStart: NonNullable<typeof this.beforeStart>): void { this.beforeStart = beforeStart }
  setEmit(emit: NonNullable<typeof this.emit>): void { this.emit = emit }

  get(agentId: string): PiChildSessionRecordV1 | undefined {
    const record = this.state.children.find(child => child.agentId === agentId)
    return record ? structuredClone(record) : undefined
  }

  snapshot(): PiChildSessionStateV1 {
    return structuredClone(this.state)
  }

  async start(input: PiChildStartInput): Promise<PiChildResult> {
    if (this.drained || this.drainInFlight) throw new Error('child-session-service-draining')
    // Before admission, before the durable record: a child refused at the cap
    // must leave nothing behind for a later sweep to reconcile.
    this.assertAgentViewEnabled(input)
    this.assertBudgetHeadroom()
    const operation = this.startOwned(input)
    this.startsInFlight.add(operation)
    try {
      return await operation
    } finally {
      this.startsInFlight.delete(operation)
    }
  }

  private async startOwned(input: PiChildStartInput): Promise<PiChildResult> {
    validateStart(input)
    const agentId = input.requestedAgentId ?? this.options.makeId?.() ?? crypto.randomUUID()
    if (input.budgets.ancestry.includes(agentId)) throw new Error('child-session-cycle')
    const admission = this.beginAdmission(agentId)
    let record!: PiChildSessionRecordV1
    try {
      if (input.ownerTaskId) await this.options.ensureOwnerTaskId?.(input.ownerTaskId, `Background orchestration: ${input.task.slice(0, 120)}`)
      if (admission.cancelled) return cancelledStartResult(agentId, input)
      if (input.ownerTaskId) this.options.validateOwnerTaskId?.(input.ownerTaskId)
      if (admission.cancelled) return cancelledStartResult(agentId, input)
      const now = this.options.now?.() ?? Date.now()
      record = {
        schemaVersion: 1,
        agentId,
        parentSessionKey: structuredClone(this.options.parentSessionKey),
        childSessionKey: { workspaceId: this.options.parentSessionKey.workspaceId, sessionId: agentId },
        agent: input.agent,
        task: input.task,
        ...(input.ownerTaskId ? { ownerTaskId: input.ownerTaskId } : {}),
        ...(input.backgroundTaskId ? { backgroundTaskId: input.backgroundTaskId } : {}),
        background: input.background,
        restrictions: structuredClone(input.restrictions),
        budgets: { ...structuredClone(input.budgets), ancestry: [...input.budgets.ancestry, input.agent] },
        // F1.224 — no run counter any more: `maxTurns` bounds each run's round
        // trips inside the child (F1.83), and `resume` below says why a capped
        // child may run again. A legacy record's `turnsUsed` is read by nothing.
        // R48: the tree WebSearch count at spawn seeds the child subprocess's
        // budget. Sanitized to a non-negative integer — it can only ever
        // NARROW the child's headroom, so a bad value is clamped, not fatal.
        ...(typeof input.webSearchesUsed === 'number' && Number.isFinite(input.webSearchesUsed) && input.webSearchesUsed > 0
          ? { webSearchesUsed: Math.floor(input.webSearchesUsed) }
          : {}),
        ...(input.capabilityView === undefined ? {} : { capabilityView: structuredClone(input.capabilityView) }),
        ...(input.capabilitySnapshotGeneration === undefined ? {} : { capabilitySnapshotGeneration: input.capabilitySnapshotGeneration }),
        status: 'starting',
        output: '',
        createdAt: now,
        updatedAt: now,
      }
      let committed = false
      await this.commit((children, sealedOwnerTaskIds) => {
        if (admission.cancelled) return children
        if (children.some(child => child.agentId === agentId)) throw new Error('child-session-id-reused')
        if (input.ownerTaskId && sealedOwnerTaskIds.has(input.ownerTaskId)) throw new Error('child-session-owner-sealed')
        const active = children.filter(child => child.status === 'starting' || child.status === 'running')
        if (children.filter(child => !isHostConsultRecord(child) && !isPluginHookAgentRecord(child)).length >= input.budgets.fanout) throw new Error('child-session-fanout-limit') // F1.1047: a plugin hook agent is not counted either
        if (active.length >= input.budgets.concurrency) throw new Error('child-session-concurrency-limit')
        committed = true
        return [...children, record]
      })
      if (!committed || admission.cancelled) {
        if (committed) await this.commit(children => children.filter(child => child.agentId !== agentId))
        return cancelledStartResult(agentId, input)
      }
    } finally {
      this.finishAdmission(agentId, admission)
    }
    this.runtimeStartsInFlight.add(agentId)
    try {
      try {
        let runtimeRecord = structuredClone(record)
        try {
          const result = await this.beforeStart?.(structuredClone(record))
          const additionalContext = result?.additionalContext?.trim()
          if (additionalContext) runtimeRecord = { ...runtimeRecord, task: `${additionalContext}\n\n${runtimeRecord.task}` }
        } catch {
          // Observational hook failures never prevent the child from starting.
        }
        const currentBeforeRuntimeStart = this.require(agentId)
        if (isTerminal(currentBeforeRuntimeStart.status)) return toResult(currentBeforeRuntimeStart)
        const started = await this.options.runtime.start(runtimeRecord)
        const stoppedDuringStart = isTerminal(this.require(agentId).status)
        await this.update(agentId, current => isTerminal(current.status) ? current : ({
          ...current,
          childSessionKey: structuredClone(started.childSessionKey),
          transcriptId: started.transcriptId,
          ...(started.worktreeLeaseId === undefined ? {} : { worktreeLeaseId: started.worktreeLeaseId }),
          status: started.status ?? 'running',
          output: started.output ?? current.output,
          ...(started.result === undefined ? {} : { result: started.result }),
          ...(started.inputTokens === undefined ? {} : { inputTokens: started.inputTokens }),
          ...(started.outputTokens === undefined ? {} : { outputTokens: started.outputTokens }),
          ...(started.costUsd === undefined ? {} : { costUsd: started.costUsd }),
          ...(started.webSearchesConsumed === undefined ? {} : { webSearchesConsumed: started.webSearchesConsumed }), ...(started.turnLimitReached ? { turnLimitReached: true as const } : {}),
          updatedAt: this.options.now?.() ?? Date.now(),
        }))
        const current = this.require(agentId)
        if (stoppedDuringStart) {
          await this.options.runtime.stop({
            ...structuredClone(current),
            childSessionKey: structuredClone(started.childSessionKey),
            transcriptId: started.transcriptId,
            ...(started.worktreeLeaseId === undefined ? {} : { worktreeLeaseId: started.worktreeLeaseId }),
          })
          return toResult(current)
        }
        await this.observe('SubagentStart', current)
        await this.emitTerminalOnce(agentId)
        return toResult(current)
      } catch (error) {
        let failed = false
        await this.update(agentId, current => {
          if (isTerminal(current.status)) return current
          failed = true
          return { ...current, status: 'failed', error: errorMessage(error), updatedAt: this.options.now?.() ?? Date.now() }
        })
        if (failed) await this.emitTerminalOnce(agentId)
        throw error
      }
    } finally {
      this.runtimeStartsInFlight.delete(agentId)
    }
  }

  async resume(agentId: string, input: string): Promise<PiChildResult> {
    if (!input.trim()) throw new Error('child-session-resume-input-required')
    // A resume spends exactly like a spawn does (`sub-agents.md:903` — it
    // "takes a fresh slot"), so the same ceiling has to bind it; leaving this
    // door open would let `resume_subagent` restart the whole fan-out past the
    // cap the spawn path just refused.
    this.assertBudgetHeadroom()
    // F1.224 — no bound on RESUMES. `sub-agents.md#supported-frontmatter-fields`:
    // `maxTurns` is the "Maximum number of agentic turns before the subagent
    // stops. When the subagent reaches the limit, Claude Code returns its output
    // marked as partial, and Claude can resume it to continue." Its unit is the
    // model round trip, which the child's own loop spends per run since F1.83;
    // this method spent the same number on STARTS too, so a `maxTurns: 1` child
    // could never be resumed. The headroom check above still bounds how many
    // runs the tree can afford, exactly as it bounds a spawn.
    await this.update(agentId, current => {
      if (current.status === 'starting' || current.status === 'running') throw new Error('child-session-already-active')
      return {
        ...current,
        status: 'running',
        error: undefined, turnLimitReached: undefined, // F1.225 — a new run is not the capped one
        terminalEventEmitted: false,
        updatedAt: this.options.now?.() ?? Date.now(),
      }
    })
    let resumed: Awaited<ReturnType<ChildRuntime['resume']>>
    try {
      resumed = await this.options.runtime.resume(structuredClone(this.require(agentId)), input)
    } catch (error) {
      let failed = false
      await this.update(agentId, current => {
        if (isTerminal(current.status)) return current
        failed = true
        return { ...current, status: 'failed', error: errorMessage(error), updatedAt: this.options.now?.() ?? Date.now() }
      })
      if (failed) await this.emitTerminalOnce(agentId)
      throw error
    }
    await this.update(agentId, current => isTerminal(current.status) ? current : ({
      ...current,
      status: resumed.status,
      output: resumed.output ?? current.output,
      ...(resumed.result === undefined ? {} : { result: resumed.result }),
      ...(resumed.error === undefined ? {} : { error: resumed.error }),
      ...(resumed.inputTokens === undefined ? {} : { inputTokens: resumed.inputTokens }),
      ...(resumed.outputTokens === undefined ? {} : { outputTokens: resumed.outputTokens }),
      ...(resumed.costUsd === undefined ? {} : { costUsd: resumed.costUsd }),
      ...(resumed.webSearchesConsumed === undefined ? {} : { webSearchesConsumed: resumed.webSearchesConsumed }), ...(resumed.turnLimitReached ? { turnLimitReached: true as const } : {}),
      updatedAt: this.options.now?.() ?? Date.now(),
    }))
    await this.emitTerminalOnce(agentId)
    return toResult(this.require(agentId))
  }

  async steer(agentId: string, message: string): Promise<void> {
    if (!message.trim()) throw new Error('child-session-steer-message-required')
    const record = this.require(agentId)
    if (record.status !== 'starting' && record.status !== 'running') throw new Error('child-session-not-active')
    await this.options.runtime.steer(structuredClone(record), message)
  }

  result(agentId: string): PiChildResult {
    return toResult(this.require(agentId))
  }

  /**
   * The result at this caller's tier — bounded ONCE, from the record.
   *
   * It used to bound twice: `this.result()`/`this.monitor()` return
   * `toResult(...)`, which had already cut at {@link MAX_RESULT_BYTES}, and this
   * line cut the cut again at the narrower tier. Truncating a truncation was
   * invisible while the cut was silent; the moment {@link boundField} started
   * naming the original size, the outer marker reported the INNER cut's length
   * as the original (65 570 rather than 70 000) — a marker that lies about how
   * much is missing is worse than no marker. Bounded once, at the tier the
   * caller asked for.
   */
  async getResult(agentId: string, options?: { wait?: boolean; verbose?: boolean }): Promise<PiChildResult> {
    if (options?.wait) await this.monitor(agentId)
    return toResult(this.require(agentId), options?.verbose ? MAX_RESULT_BYTES : DEFAULT_RESULT_BYTES)
  }

  async monitor(agentId: string): Promise<PiChildResult> {
    const record = this.require(agentId)
    if (isTerminal(record.status)) {
      await this.emitTerminalOnce(agentId, true)
      return toResult(this.require(agentId))
    }
    if (!this.options.runtime.monitor) return toResult(record)
    const terminal = await this.options.runtime.monitor(structuredClone(record))
    await this.update(agentId, current => isTerminal(current.status) ? current : ({
      ...current,
      status: terminal.status,
      output: terminal.output ?? current.output,
      ...(terminal.result === undefined ? {} : { result: terminal.result }),
      ...(terminal.error === undefined ? {} : { error: terminal.error }),
      ...(terminal.inputTokens === undefined ? {} : { inputTokens: terminal.inputTokens }),
      ...(terminal.outputTokens === undefined ? {} : { outputTokens: terminal.outputTokens }),
      ...(terminal.costUsd === undefined ? {} : { costUsd: terminal.costUsd }),
      ...(terminal.webSearchesConsumed === undefined ? {} : { webSearchesConsumed: terminal.webSearchesConsumed }), ...(terminal.turnLimitReached ? { turnLimitReached: true as const } : {}),
      updatedAt: this.options.now?.() ?? Date.now(),
    }))
    await this.emitTerminalOnce(agentId)
    return toResult(this.require(agentId))
  }

  searchOutput(agentId: string, query: string): { agentId: string; cursor: number; status: PiChildSessionRecordV1['status']; results: string[] } {
    const record = this.require(agentId)
    if (!query) return { agentId, cursor: Buffer.byteLength(record.output, 'utf8'), status: record.status, results: [] }
    const matches: string[] = []
    let bytes = 0
    for (const line of record.output.split('\n')) {
      if (!line.includes(query)) continue
      const bounded = boundUtf8(line, Math.min(4096, MAX_RESULT_BYTES - bytes))
      if (!bounded || bytes + Buffer.byteLength(bounded, 'utf8') > MAX_RESULT_BYTES) break
      matches.push(bounded)
      bytes += Buffer.byteLength(bounded, 'utf8')
      if (matches.length === MAX_SEARCH_RESULTS) break
    }
    return { agentId, cursor: Buffer.byteLength(record.output, 'utf8'), status: record.status, results: matches }
  }

  /**
   * The child's output from `cursor` on — including while it is still working.
   *
   * A live child is served {@link ChildRuntime.readLiveOutput}, which is the same
   * projection a settled one gets (the child's latest assistant message, defanged
   * and bounded by the host) rather than a second, differently-shaped view: the
   * read must not change meaning at the moment the child settles.
   *
   * Residual, stated rather than hidden: that projection is the LATEST assistant
   * message, so when a working child starts a new one the served text can get
   * shorter. The cursor clamp below keeps that safe — it re-anchors to the new
   * length instead of over-reading — but a cursor-following reader skips the head
   * of the new message. Progress, not a byte-exact stream.
   *
   * Terminal reads are unchanged: `isTerminal` short-circuits before any live
   * read, so a settled child is served `record.output` exactly as before.
   */
  async attach(agentId: string, cursor = 0): Promise<{ agentId: string; cursor: number; output: string; status: PiChildSessionRecordV1['status'] }> {
    const record = this.require(agentId)
    const live = isTerminal(record.status)
      ? undefined
      : await this.options.runtime.readLiveOutput?.(record).catch(() => undefined)
    const bytes = Buffer.from(live && live.length > 0 ? live : record.output)
    const safeCursor = Math.max(0, Math.min(cursor, bytes.length))
    const output = boundUtf8(bytes.subarray(safeCursor).toString('utf8'), MAX_RESULT_BYTES)
    return { agentId, cursor: safeCursor + Buffer.byteLength(output, 'utf8'), output, status: record.status }
  }

  async stop(agentId: string): Promise<void> {
    const admission = this.pendingAdmissions.get(agentId)
    if (admission) {
      admission.cancelled = true
      await admission.settled
      if (!this.get(agentId)) return
    }
    await this.commitTail
    const pending = this.stopInFlight.get(agentId)
    if (pending) return pending
    const operation = this.stopOwned(agentId)
    this.stopInFlight.set(agentId, operation)
    try { await operation } finally {
      if (this.stopInFlight.get(agentId) === operation) this.stopInFlight.delete(agentId)
    }
  }

  async drain(): Promise<void> {
    if (this.drained) return
    if (this.drainInFlight) return this.drainInFlight
    const operation = this.drainOwned()
    this.drainInFlight = operation
    try {
      await operation
      this.drained = true
    } finally {
      if (this.drainInFlight === operation) this.drainInFlight = undefined
    }
  }

  private async drainOwned(): Promise<void> {
    const admissions = [...this.pendingAdmissions.values()]
    for (const admission of admissions) admission.cancelled = true
    await Promise.all(admissions.map(admission => admission.settled))
    await this.commitTail

    const failures: unknown[] = []
    this.strictDrain = true
    const stopActive = async () => {
      const active = this.state.children.filter(child => child.status === 'starting' || child.status === 'running')
      const settled = await Promise.allSettled(active.map(child => this.stop(child.agentId)))
      settled.forEach(result => {
        if (result.status === 'rejected') failures.push(result.reason)
      })
    }
    try {
      await stopActive()
      const starts = await Promise.allSettled([...this.startsInFlight])
      starts.forEach(result => {
        if (result.status === 'rejected') failures.push(result.reason)
      })
      await this.commitTail
      await stopActive()

      const residuals = this.state.children
        .filter(child => child.status === 'starting' || child.status === 'running')
        .map(child => new Error(`child-session-residual:${child.agentId}:${child.status}`))
      if (failures.length > 0 || residuals.length > 0) {
        throw new AggregateError([...failures, ...residuals], 'child-session-drain-failed')
      }
    } finally {
      this.strictDrain = false
    }
  }

  private async stopOwned(agentId: string): Promise<void> {
    const record = this.require(agentId)
    if (isTerminal(record.status)) return
    if (record.status === 'starting') {
      // A durable starting record can precede runtime publication. Make the
      // terminal decision authoritative first so start() cannot publish after
      // a best-effort stop reports "unknown runtime". If runtime.start is
      // already in flight, its stoppedDuringStart path performs the late stop.
      await this.update(agentId, current => isTerminal(current.status) ? current : ({
        ...current,
        status: 'stopped',
        updatedAt: this.options.now?.() ?? Date.now(),
      }))
      try {
        await this.options.runtime.stop(structuredClone(this.require(agentId)))
      } catch (error) {
        if (this.strictDrain && !this.runtimeStartsInFlight.has(agentId)) {
          await this.update(agentId, current => current.status === 'stopped'
            ? { ...current, status: 'starting', updatedAt: this.options.now?.() ?? Date.now() }
            : current)
          throw error
        }
      }
      await this.emitTerminalOnce(agentId)
      return
    }
    await this.options.runtime.stop(structuredClone(record))
    await this.update(agentId, current => isTerminal(current.status) ? current : ({ ...current, status: 'stopped', updatedAt: this.options.now?.() ?? Date.now() }))
    await this.emitTerminalOnce(agentId)
  }

  /**
   * Stop every child that is still `starting` or `running`, through the SAME
   * `stop` path a user stop and {@link drain} already use.
   *
   * Deliberately NOT `drain`: draining seals the service (`drained = true`), so
   * every later start would be refused as `child-session-service-draining` —
   * the wrong sentence for a spending cap, and a permanent one where the cap is
   * a ceiling the user can raise. This reuses `stop` instead, so the records
   * land on the `stopped` status the service already writes, each emits its one
   * `SubagentStop`, and no new terminal kind enters the vocabulary.
   *
   * Never throws: a stop that fails is REPORTED, not dropped, so the caller can
   * say honestly which children it could not reach.
   *
   * THREE buckets, because two of them hid the worst case. `stopped` and
   * `failed` report what the stop CALLS returned — but a child this sweep never
   * got to call `stop` on at all appears in NEITHER, and that child is the one
   * still spending. `residual` is that bucket: still `starting`/`running` after
   * the second pass, which is exactly what {@link drainOwned} raises as
   * `child-session-residual:<id>:<status>` and refuses to call a clean drain.
   *
   * Disjoint, so a caller can add the counts up. A child whose stop was REFUSED
   * stays in `failed` even while it is still running (that bucket's sentence
   * already says so); a child that is still running after a stop the service
   * believes it made is reported as `residual` rather than `stopped`, because
   * the observed state outranks the call's return value.
   */
  async stopActive(): Promise<{ stopped: string[]; failed: string[]; residual: string[] }> {
    const outcome = new Map<string, boolean>()
    const sweep = async () => {
      await this.commitTail
      const active = this.state.children
        .filter(child => child.status === 'starting' || child.status === 'running')
        .map(child => child.agentId)
      const settled = await Promise.allSettled(active.map(agentId => this.stop(agentId)))
      settled.forEach((result, index) => { outcome.set(active[index]!, result.status === 'fulfilled') })
    }
    await sweep()
    // The second pass, for the same reason `drain` makes one: a start that was
    // already past the gate can publish AFTER the first sweep read the list, and
    // a child admitted a millisecond late is exactly the one that keeps burning.
    // A stop that failed on the first pass is retried here too, and the later
    // verdict wins.
    await Promise.allSettled([...this.startsInFlight])
    await sweep()
    await this.commitTail
    const failed = [...outcome].filter(([, ok]) => !ok).map(([agentId]) => agentId)
    const refused = new Set(failed)
    const residual = this.state.children
      .filter(child => child.status === 'starting' || child.status === 'running')
      .map(child => child.agentId)
      .filter(agentId => !refused.has(agentId))
    const unreachable = new Set(residual)
    return {
      stopped: [...outcome].filter(([agentId, ok]) => ok && !unreachable.has(agentId)).map(([agentId]) => agentId),
      failed,
      residual,
    }
  }

  private assertBudgetHeadroom(): void {
    if (this.options.budgetExhausted?.()) throw new Error(CHILD_SESSION_BUDGET_EXHAUSTED_ERROR)
  }

  /**
   * P6.237 — the managed `disableAgentView`, refused legibly rather than as a
   * silent no-op.
   *
   * Scoped to `input.background`. The key's own subject on every runtime that
   * has one is the BACKGROUND surface ("`claude agents`, `--bg`, /background,
   * the on-demand daemon"), not delegation as such, so a foreground subagent —
   * which returns into the same turn and is visible in it — is untouched. An
   * administrator who wants that gone has `allowedAgentKeys` and the agent
   * vocabulary; taking it here would be a broader product posture than the key
   * names, and a lane does not decide one.
   *
   * The policy is read through the process-scoped floor rather than injected by
   * the constructing caller: `resolveManagedPiPolicyFloor` is the same reader
   * `handlers/rpc/settings.ts`, `claude-agent.ts` and
   * `claude-auto-mode-policy.ts` already use, so a policy change lands here
   * without a second wiring point to keep in sync. `disabledByPolicy` stays an
   * option so a test can drive the refusal without a global.
   */
  private assertAgentViewEnabled(input: PiChildStartInput): void {
    if (!input.background) return
    const disabled = this.options.disabledByPolicy?.()
      ?? resolveManagedPiPolicyFloor()?.disableAgentView === true
    if (disabled) throw new Error(CHILD_SESSION_AGENT_VIEW_DISABLED_ERROR)
  }

  async stopTask(taskId: string): Promise<void> {
    const records = this.state.children.filter(child => child.background && child.backgroundTaskId === taskId && ['starting', 'running'].includes(child.status))
    if (records.length === 0) throw new Error(`unknown-task-id:${taskId}`)
    await Promise.all(records.map(record => this.stop(record.agentId)))
  }

  async sealOwnerTask(ownerTaskId: string): Promise<void> {
    this.options.validateOwnerTaskId?.(ownerTaskId)
    await this.commitState(state => state.sealedOwnerTaskIds.includes(ownerTaskId)
      ? state
      : { ...state, sealedOwnerTaskIds: [...state.sealedOwnerTaskIds, ownerTaskId].sort() })
    await this.completeOwnerTask(ownerTaskId, true)
  }

  private require(agentId: string): PiChildSessionRecordV1 {
    const record = this.state.children.find(child => child.agentId === agentId)
    if (!record) throw new Error(`unknown-agent-id:${agentId}`)
    return record
  }

  private beginAdmission(agentId: string): PendingAdmission {
    if (this.pendingAdmissions.has(agentId) || this.state.children.some(child => child.agentId === agentId)) {
      throw new Error('child-session-id-reused')
    }
    let resolveSettled!: () => void
    const admission: PendingAdmission = {
      cancelled: false,
      settled: new Promise<void>(resolve => { resolveSettled = resolve }),
      resolveSettled: () => resolveSettled(),
      didSettle: false,
    }
    this.pendingAdmissions.set(agentId, admission)
    return admission
  }

  private finishAdmission(agentId: string, admission: PendingAdmission): void {
    if (this.pendingAdmissions.get(agentId) === admission) this.pendingAdmissions.delete(agentId)
    if (admission.didSettle) return
    admission.didSettle = true
    admission.resolveSettled()
  }

  private async update(agentId: string, apply: (record: PiChildSessionRecordV1) => PiChildSessionRecordV1): Promise<void> {
    await this.commit(children => children.map(record => record.agentId === agentId ? apply(record) : record))
  }

  private async emitTerminalOnce(agentId: string, retryOwnerCompletion = false): Promise<void> {
    let claimed = false
    await this.update(agentId, current => {
      if (!isTerminal(current.status) || current.terminalEventEmitted) return current
      claimed = true
      return { ...current, terminalEventEmitted: true }
    })
    const record = this.require(agentId)
    if (claimed) await this.observe('SubagentStop', record)
    if (record.ownerTaskId) await this.completeOwnerTask(record.ownerTaskId, retryOwnerCompletion)
  }

  private async completeOwnerTask(ownerTaskId: string, retry = false): Promise<void> {
    if (!this.state.sealedOwnerTaskIds.includes(ownerTaskId)) return
    const linked = () => this.state.children.filter(child => child.ownerTaskId === ownerTaskId)
    if (linked().length === 0) return
    if (linked().every(child => child.ownerTaskCompletionEmitted)) return
    if (!linked().every(child => isTerminal(child.status))) return
    const pending = this.ownerCompletionInFlight.get(ownerTaskId)
    if (pending && (!retry || !pending.failed)) return pending.promise
    if (pending) this.ownerCompletionInFlight.delete(ownerTaskId)
    const operation = (async () => {
      const current = linked()
      if (current.every(child => child.ownerTaskCompletionEmitted) || !current.every(child => isTerminal(child.status))) return
      await this.options.completeOwnerTaskId?.(ownerTaskId)
      await this.commit(children => children.map(child => child.ownerTaskId === ownerTaskId ? { ...child, ownerTaskCompletionEmitted: true } : child))
    })()
    const entry = { promise: Promise.resolve(), failed: false }
    entry.promise = operation.catch(error => { entry.failed = true; throw error })
    this.ownerCompletionInFlight.set(ownerTaskId, entry)
    try { await entry.promise } finally {
      if (!entry.failed && this.ownerCompletionInFlight.get(ownerTaskId) === entry) this.ownerCompletionInFlight.delete(ownerTaskId)
    }
  }

  private async observe(event: 'SubagentStart' | 'SubagentStop', record: PiChildSessionRecordV1): Promise<void> {
    try { await this.emit?.(event, structuredClone(record)) } catch {}
  }

  private async commit(apply: (children: PiChildSessionRecordV1[], sealedOwnerTaskIds: ReadonlySet<string>) => PiChildSessionRecordV1[]): Promise<void> {
    await this.commitState(state => ({ ...state, children: apply(state.children, new Set(state.sealedOwnerTaskIds)) }))
  }

  private async commitState(apply: (state: PiChildSessionStateV1) => PiChildSessionStateV1): Promise<void> {
    const operation = this.commitTail.then(async () => {
      const next = apply(structuredClone(this.state))
      const candidate: PiChildSessionStateV1 = { ...next, schemaVersion: 1, revision: this.state.revision + 1 }
      await this.options.persist(structuredClone(candidate))
      this.state = candidate
    })
    this.commitTail = operation.catch(() => {})
    await operation
  }
}

function isTerminal(status: PiChildSessionRecordV1['status']): boolean {
  return status === 'completed' || status === 'failed' || status === 'stopped' || status === 'interrupted'
}

function cancelledStartResult(agentId: string, input: PiChildStartInput): PiChildResult {
  return {
    agentId,
    ...(input.ownerTaskId ? { ownerTaskId: input.ownerTaskId } : {}),
    ...(input.backgroundTaskId ? { backgroundTaskId: input.backgroundTaskId } : {}),
    status: 'stopped',
    output: '',
  }
}

function parseState(value: unknown): PiChildSessionStateV1 {
  if (value === undefined) return structuredClone(EMPTY_STATE)
  if (!value || typeof value !== 'object' || (value as { schemaVersion?: unknown }).schemaVersion !== 1
    || !Number.isInteger((value as { revision?: unknown }).revision)
    || !Array.isArray((value as { sealedOwnerTaskIds?: unknown }).sealedOwnerTaskIds)
    || !Array.isArray((value as { children?: unknown }).children)) {
    throw new Error('child-session-state-invalid')
  }
  return structuredClone(value as PiChildSessionStateV1)
}

function validateStart(input: PiChildStartInput): void {
  if (!input.agent.trim() || !input.task.trim()) throw new Error('child-session-agent-task-required')
  if (input.restrictions.worktreePolicy !== 'shared' && input.restrictions.worktreePolicy !== 'isolated-worktree') {
    throw new Error('child-session-worktree-policy-invalid')
  }
  const budgetValues = [input.budgets.depth, input.budgets.maxDepth, input.budgets.fanout, input.budgets.concurrency, input.budgets.tokenLimit]
  if (budgetValues.some(value => !Number.isInteger(value) || value < 1)
    || input.budgets.depth > input.budgets.maxDepth
    || input.budgets.ancestry.includes(input.agent)
    || !Number.isFinite(input.budgets.costLimitUsd) || input.budgets.costLimitUsd < 0
    || !Number.isFinite(input.budgets.deadlineAt) || input.budgets.deadlineAt <= (Date.now() - 1)) {
    throw new Error('child-session-budgets-invalid')
  }
}

function toResult(record: PiChildSessionRecordV1, maxBytes: number = MAX_RESULT_BYTES): PiChildResult {
  return boundResult({
    agentId: record.agentId,
    ...(record.ownerTaskId ? { ownerTaskId: record.ownerTaskId } : {}),
    ...(record.backgroundTaskId ? { backgroundTaskId: record.backgroundTaskId } : {}),
    ...(record.worktreeLeaseId ? { worktreeLeaseId: record.worktreeLeaseId } : {}),
    status: record.status,
    output: record.output,
    ...(record.result === undefined ? {} : { result: record.result }),
    ...(record.error === undefined ? {} : { error: record.error }),
    ...(record.inputTokens === undefined ? {} : { inputTokens: record.inputTokens }),
    ...(record.outputTokens === undefined ? {} : { outputTokens: record.outputTokens }),
    ...(record.costUsd === undefined ? {} : { costUsd: record.costUsd }),
    ...(record.webSearchesConsumed === undefined ? {} : { webSearchesConsumed: record.webSearchesConsumed }), ...(record.turnLimitReached ? { turnLimitReached: true as const } : {}),
  }, maxBytes)
}

/**
 * Bound one model-facing field and SAY SO when it was cut.
 *
 * The marker is RESERVED OUT OF `maxBytes`, not added to it, so the field still
 * satisfies the cap exactly as it did before — a pin asserting
 * `byteLength <= 65_536` caught the additive version on its first run, and it
 * was right to: this is a host-survival byte cap with no published number
 * behind it, unlike `buildBashFailureExcerpt`'s excerpt, whose size the page
 * promises and whose apology therefore cannot be allowed to eat it.
 *
 * The marker names no KEPT count on purpose — that number depends on the
 * marker's own length, which depends on the number. It names the cap and the
 * true original size, which is what a reader needs to know it is looking at a
 * fragment. A cap too small to hold the marker gets no marker rather than a
 * truncated one.
 */
function boundField(value: string, maxBytes: number): string {
  const originalBytes = Buffer.byteLength(value, 'utf8')
  if (originalBytes <= maxBytes) return value
  const more = maxBytes < MAX_RESULT_BYTES
    ? `; ask again with verbose: true for up to ${MAX_RESULT_BYTES} bytes`
    : ''
  const marker = `\n[truncated to fit ${maxBytes} bytes; ${originalBytes} bytes total${more}]`
  const markerBytes = Buffer.byteLength(marker, 'utf8')
  if (markerBytes >= maxBytes) return boundUtf8(value, maxBytes)
  return `${boundUtf8(value, maxBytes - markerBytes)}${marker}`
}

function boundResult(result: PiChildResult, maxBytes: number): PiChildResult {
  return {
    ...result,
    output: boundField(result.output, maxBytes),
    ...(result.result === undefined ? {} : { result: boundField(result.result, maxBytes) }),
    ...(result.error === undefined ? {} : { error: boundField(result.error, maxBytes) }),
  }
}

/** Truncate to `maxBytes` UTF-8 bytes without splitting a multi-byte character. */
export function boundUtf8(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return ''
  const bytes = Buffer.from(value)
  if (bytes.length <= maxBytes) return value
  let end = maxBytes
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1
  return bytes.subarray(0, end).toString('utf8')
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * F1.739 — is this child record a HOST CONSULT (a guardian safety-judge run)
 * rather than a subagent? The fanout half of the per-parent backstop in
 * `startOwned` skips it, and nothing else reads it.
 *
 * Why: `fanout` counts every child the parent EVER had, finished ones too, and
 * for an Agent-tool spawn it is `orchestrator.maxAgents` (default 100). Since
 * F1.256 every judge consult is admitted and leaves a durable record, so about a
 * hundred judged actions refused every later SUBAGENT `child-session-fanout-limit`
 * while the judges, whose own fanout is unbounded, stayed admitted.
 *
 * Decided (transparent/simple): NOT COUNTED rather than pruned — every record,
 * and so every judge transcript, is kept, and no new port operation is needed.
 * `concurrency` still counts a RUNNING judge: that is live work.
 *
 * Identity without a record-schema change: `PiChildSessionRecordV1` has no kind
 * or role field, and the judge's role is already on its record. The host judge
 * port (`SessionManager.createGuardianJudgePort`) starts the built-in `scout`
 * with `guardianJudgeDef`'s system prompt, {@link GUARDIAN_POLICY_PROMPT}, as
 * `restrictions.prompt`, and the port's `start` only APPENDS to that prompt
 * (skill invocations, memory). A model never chooses a child's prompt — it comes
 * from a definition — and a workspace definition carrying the same text has a
 * `definitionKey`, so it is still counted; so is a conversation fork. It survives
 * a restart and needs no migration.
 *
 * Residue: if the guardian prompt text changes, a judge record written under the
 * OLD text is counted again — the pre-fix behaviour, never a widening.
 * `guardian-judge-subagent-limit.test.ts` drives the real judge port, so a change
 * to how the judge's prompt is built goes red there; the REAL adapter `start`
 * is driven to this predicate by `guardian-judge-mcp-free.test.ts` (F1.755).
 */
export function isHostConsultRecord(record: Pick<PiChildSessionRecordV1, 'restrictions'>): boolean { // F1.920: the host also asks it of a child's own `piChildRestrictions`
  return record.restrictions.definitionKey === undefined
    && record.restrictions.fork !== true
    && typeof record.restrictions.prompt === 'string'
    && record.restrictions.prompt.startsWith(GUARDIAN_POLICY_PROMPT)
}

/**
 * F1.1047 — is this child record a PLUGIN HOOK AGENT run (a hook's `type:
 * "agent"`, spawned by `SessionManager.pluginAgentHookRunner`) rather than a
 * subagent the model asked for? Like {@link isHostConsultRecord}, the fanout
 * half of the per-parent backstop in `startOwned` skips it, and nothing else
 * reads it.
 *
 * Why: since F1.740 every hook fire is admitted and leaves a durable record, and
 * the Agent-tool spawn's `fanout` (`orchestrator.maxAgents`, default 100) counts
 * every child the parent ever had, so about a hundred hook fires refused the
 * model's own subagents `child-session-fanout-limit`. hooks.md, the section on
 * how agent hooks work: an agent hook spawns a subagent each time it fires, and
 * the page names no cap on those runs; the limit exists to bound the MODEL's
 * fan-out (DECISIONS-2 Q14). Not counted rather than pruned, as for judges:
 * every record and transcript is kept. `concurrency` still counts a RUNNING hook
 * agent: that is live work.
 *
 * Identity without a record-schema change: both halves are host-set by the
 * runner and neither is chosen by a model. The id prefix is minted by the host
 * (a model's spawns get the Pi spawner's own ids); the prompt prefix alone is
 * not enough, since a workspace definition could copy its text. An older record
 * written by the runner already carries both, so it needs no migration.
 */
export const PLUGIN_HOOK_AGENT_ID_PREFIX = 'plugin-hook-agent-'
export const PLUGIN_HOOK_AGENT_PROMPT_PREFIX = 'Plugin hook agent invocation.'
export function isPluginHookAgentRecord(record: Pick<PiChildSessionRecordV1, 'agentId' | 'restrictions'>): boolean {
  return record.agentId.startsWith(PLUGIN_HOOK_AGENT_ID_PREFIX)
    && isPluginHookAgentRestrictions(record.restrictions)
}

/**
 * F1.1040 (DECISIONS-2 Q4) — the RESTRICTIONS half of
 * {@link isPluginHookAgentRecord}: the child's prompt is LED by the runner's
 * {@link PLUGIN_HOOK_AGENT_PROMPT_PREFIX}. `SessionManager.hostConsultRefusalFor`
 * asks it of a session's own `piChildRestrictions` (and each ancestor's) to
 * refuse the hook verifier's permission requests with no card, as it refuses a
 * judge's. It asks the prompt only because the child session carries its
 * restrictions and not its record's id (the record's `childSessionKey` is a
 * placeholder until the synchronous hook run returns). Still host-set: a model's
 * named spawn is led by the safety core (`composeChildPrompt`), a fork's prompt
 * is empty, and a refusal only ever NARROWS. It does not join
 * {@link isHostConsultRecord}, whose other readers (fan-out, the agent panel,
 * the managed-hooks lock, subagent hooks) Q4 did not decide.
 */
export function isPluginHookAgentRestrictions(restrictions: Pick<PiChildSessionRecordV1['restrictions'], 'prompt'> | undefined): boolean {
  return typeof restrictions?.prompt === 'string' && restrictions.prompt.startsWith(PLUGIN_HOOK_AGENT_PROMPT_PREFIX)
}

/**
 * F1.1147 (origin DN-217, 2026-09-28) — the error codes with which
 * {@link ChildSessionService.start} REFUSES a child at admission: the session
 * is draining, its managed policy turns subagents off, its spend budget is
 * spent, or the child would exceed the inherited `fanout` / `concurrency`
 * ceiling. Each is a decision, not a crash.
 */
const CHILD_SESSION_ADMISSION_REFUSALS: ReadonlySet<string> = new Set([
  'child-session-service-draining',
  CHILD_SESSION_AGENT_VIEW_DISABLED_ERROR,
  CHILD_SESSION_BUDGET_EXHAUSTED_ERROR,
  'child-session-fanout-limit',
  'child-session-concurrency-limit',
])

/**
 * F1.1147 — the `(outcome, isolationProfile, code)` receipt for a plugin hook
 * agent whose child start threw. A refusal at admission is a `denied`,
 * `not-started` receipt carrying the service's own code (e.g.
 * `child-session-fanout-limit`), like the runner's other pre-start refusals; it
 * used to be an `error` with `execution-error`, the same receipt a crashed
 * child leaves, so the two could not be told apart. Any other throw is still
 * that execution error, and an aborted request is still `cancelled`.
 */
export function pluginHookAgentStartFailureReceipt(
  aborted: boolean,
  error: unknown,
): ['cancelled' | 'error' | 'denied', string, string] {
  if (aborted) return ['cancelled', 'host-child-session', 'aborted']
  const code = error instanceof Error ? error.message : undefined
  return code !== undefined && CHILD_SESSION_ADMISSION_REFUSALS.has(code)
    ? ['denied', 'not-started', code]
    : ['error', 'host-child-session', 'execution-error']
}
