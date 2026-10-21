import type { HarnessToolDescriptor } from './harness-tool-descriptor.ts'

interface QueueEntry<T> {
  descriptor: HarnessToolDescriptor
  task: () => Promise<T>
  resolve: (value: T) => void
  reject: (reason: unknown) => void
  signal?: AbortSignal
  abort?: () => void
}

export type ToolUseConcurrencyEnvRecord = Record<string, string | undefined>

/** The Nessy spelling of the parallel tool-use ceiling. */
export const MAX_TOOL_USE_CONCURRENCY_ENV = 'NESSY_MAX_TOOL_USE_CONCURRENCY'

/** The documented Claude spelling, accepted as a compat alias. */
export const MAX_TOOL_USE_CONCURRENCY_COMPAT_ENV = 'CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY'

/**
 * `env-vars.md#variables`, verbatim: "`CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY` |
 * Maximum number of read-only tools and subagents that can execute in parallel
 * (default: 10). Higher values increase parallelism but consume more resources".
 */
export const MAX_TOOL_USE_CONCURRENCY_DEFAULT = 10

/** `/^\d+$/` after trim — the plain-digits shape the sibling count readers use. */
function parsePlainPositiveInteger(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined
  const trimmed = raw.trim()
  if (!/^\d+$/.test(trimmed)) return undefined
  const value = Number(trimmed)
  return Number.isSafeInteger(value) && value >= 1 ? value : undefined
}

/**
 * P6.490 — the Pi reader for `CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY`, at the one
 * place on this runtime that can enforce it.
 *
 * ## Why HERE, and not on the orchestrator config the row pointed at
 *
 * The row named `DEFAULT_PI_ORCHESTRATOR_CONFIG.concurrency: 16` as the seam and
 * asked for the "16-vs-10 default mismatch" to be decided. Measured at HEAD,
 * there is no mismatch to decide: that 16 is `workflows.md`'s OWN documented
 * number for a different limit — "Up to 16 concurrent agents, fewer when Claude
 * Code has fewer CPUs available, including inside a CPU-limited container" —
 * carried verbatim by `computeEffectiveConcurrency` in the pi-agent-server
 * spawner. Lowering it to 10 would have conflated two documented ceilings and
 * silently narrowed the workflow one, which is the same error the row already
 * warns about for `maxParallelTasks: 100`.
 *
 * Four DIFFERENT documented limits sit near each other; keeping them apart is
 * most of this row's value:
 *
 * | Limit | Page | Where it lives |
 * | --- | --- | --- |
 * | read-only tools + subagents in parallel, 10 | `env-vars.md#variables` | HERE |
 * | concurrent workflow agents, 16 | `workflows.md` | `spawner.ts` `computeEffectiveConcurrency` |
 * | concurrent subagents, 20 | `sub-agents.md` | `config/subagent-limits.ts` `maxConcurrentSubagents` |
 * | parallel tasks in one `subagent` call, 100 | ours | `subagent-tool.ts` `maxParallelTasks` |
 *
 * Native mechanism: none — Pi is our own harness. The vendored Pi SDK's only
 * knob is `session.agent.toolExecution`, a binary `'parallel' | 'sequential'`
 * that `compat/pi-runtime-adapter.ts` pins to `'parallel'`, so it can say
 * whether to run tools at once but not how many. {@link ToolScheduler} is the
 * component that already counts them, which is what makes this a reader rather
 * than a new mechanism.
 *
 * Unset, the documented 10 applies: before this row the scheduler started every
 * eligible queued call at once, so the ceiling is a NARROWING, never a
 * loosening. A malformed or non-positive value falls back to the default rather
 * than to "no bound", the same fail-closed direction the Bash ceiling reader
 * takes.
 */
export function resolveMaxToolUseConcurrency(
  env: ToolUseConcurrencyEnvRecord = process.env,
): number {
  const raw = env[MAX_TOOL_USE_CONCURRENCY_ENV] !== undefined
    ? env[MAX_TOOL_USE_CONCURRENCY_ENV]
    : env[MAX_TOOL_USE_CONCURRENCY_COMPAT_ENV]
  return parsePlainPositiveInteger(raw) ?? MAX_TOOL_USE_CONCURRENCY_DEFAULT
}

export class ToolScheduler {
  private readonly queue: QueueEntry<unknown>[] = []
  private readonly activeScopes = new Set<string>()
  private active = 0
  private exclusive = false

  /**
   * The ceiling is read ONCE, at construction, and one scheduler is built per
   * capability generation in the Pi subprocess — so an operator's value takes
   * effect on the next session rather than mid-turn, and a turn's own calls
   * cannot be scheduled against two different ceilings.
   */
  constructor(private readonly maxConcurrency: number = resolveMaxToolUseConcurrency()) {}

  run<T>(descriptor: HarnessToolDescriptor, task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const entry: QueueEntry<T> = { descriptor, task, resolve, reject, signal }
      if (signal?.aborted) {
        reject(aborted())
        return
      }
      if (signal) {
        entry.abort = () => {
          const index = this.queue.indexOf(entry as QueueEntry<unknown>)
          if (index < 0) return
          this.queue.splice(index, 1)
          reject(aborted())
          this.pump()
        }
        signal.addEventListener('abort', entry.abort, { once: true })
      }
      this.queue.push(entry as QueueEntry<unknown>)
      this.pump()
    })
  }

  private pump(): void {
    if (this.exclusive) return
    let started = false
    for (let index = 0; index < this.queue.length;) {
      // P6.490 — the documented parallel-tool ceiling. A blocked entry stays at
      // the head of the queue and `start`'s own `finally` pumps again, so this
      // DEFERS work rather than refusing it: the model's batch still runs, ten
      // at a time. The exclusive branch below is unaffected — it already
      // requires `active === 0`.
      if (this.active >= this.maxConcurrency) break
      const entry = this.queue[index]!
      if (entry.descriptor.scheduling === 'exclusive') break
      const scope = schedulingScope(entry.descriptor)
      if (scope && this.activeScopes.has(scope)) {
        index += 1
        continue
      }
      this.queue.splice(index, 1)
      this.start(entry, scope, false)
      started = true
    }
    if (!started && this.queue[0]?.descriptor.scheduling === 'exclusive' && this.active === 0) {
      const entry = this.queue.shift()!
      this.start(entry, undefined, true)
    }
  }

  private start(entry: QueueEntry<unknown>, scope: string | undefined, exclusive: boolean): void {
    entry.signal?.removeEventListener('abort', entry.abort!)
    this.active += 1
    this.exclusive = exclusive
    if (scope) this.activeScopes.add(scope)
    void entry.task().then(entry.resolve, entry.reject).finally(() => {
      this.active -= 1
      this.exclusive = false
      if (scope) this.activeScopes.delete(scope)
      this.pump()
    })
  }
}

function schedulingScope(descriptor: HarnessToolDescriptor): string | undefined {
  if (descriptor.scheduling !== 'serialByScope') return undefined
  if (!descriptor.mutationScope) throw new Error(`Missing mutation scope for ${descriptor.id}`)
  return descriptor.mutationScope
}

function aborted(): Error {
  const error = new Error('Tool execution cancelled')
  error.name = 'AbortError'
  return error
}
