/**
 * F1.591 — Pi 0.85 changed what `AgentSession.abort()` waits for, and one reader
 * of ours still assumed the old answer.
 *
 * Measured on the lifted Pi 0.85.1 (F1.255), `dist/core/agent-session.js` against
 * the 0.84.4 copy in the bun install cache:
 *
 *  - `isIdle` is now `!this._isAgentRunActive && !this.isCompacting` (0.84.4:
 *    `!this._isAgentRunActive`), and `isCompacting` covers manual compaction,
 *    auto-compaction and branch summaries alike;
 *  - `abort()` now calls `abortCompaction()` and `abortBranchSummary()` before
 *    `agent.abort()`, then `await this.waitForIdle()` — so it now WAITS for a
 *    compaction to finish;
 *  - the idle wait is released from the compaction's own `finally`.
 *
 * The compaction awaits the `session_before_compact` handlers, and ours (the
 * lifecycle bridge's awaited `PreCompact`, R73) waits for the HOST's verdict. The
 * server's `handleAbort` answers pending host requests only AFTER `abort()`
 * returns (`clearPendingPreToolUse`), so on 0.85.1 a Stop that lands while a
 * PreCompact verdict is pending waited for the host's hook to finish — up to the
 * host's prompt-gate bound — where on 0.84.4 `abort()` returned at once and the
 * drain released the compaction into its own cancel. Pi hands every
 * `session_before_compact` handler the compaction's `signal` for exactly this;
 * the bridge now honours it (`lifecycle-bridge.ts`, the `session_before_compact`
 * handler).
 *
 * The rig is the production composition (`createPiRuntimeAdapter().createSession`,
 * the lifecycle bridge registered by it) with a host verdict that never comes,
 * which is `handleAbort`'s order: `abortCompaction()`, then `await abort()`. A
 * session built this way loads Pi's whole module graph (≈2–3 min cold on this rig).
 */
import { beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MODULE_GRAPH_BUDGET_MS, MODULE_GRAPH_HOOK_BUDGET_MS } from '../../../shared/src/testing/module-graph-budgets.ts'

// Each case builds a session, so the module graph is paid in the cases: the file-wide
// timer is the budgets module's name for that, not the hook's (F1.668).
setDefaultTimeout(MODULE_GRAPH_BUDGET_MS)

/** Far above a cancel (milliseconds once the handler lets go), far below the host's 605 s bound. */
const STOP_SETTLES_WITHIN_MS = 10_000

type Verdict = { block?: boolean; reason?: string } | undefined

let createPiRuntimeAdapter: typeof import('../compat/pi-runtime-adapter.ts').createPiRuntimeAdapter
let buildCustomEndpointModelDef: typeof import('../custom-endpoint-models.ts').buildCustomEndpointModelDef
beforeAll(async () => {
  ({ createPiRuntimeAdapter } = await import('../compat/pi-runtime-adapter.ts'))
  ;({ buildCustomEndpointModelDef } = await import('../custom-endpoint-models.ts'))
}, MODULE_GRAPH_HOOK_BUDGET_MS)

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
const within = <T>(promise: Promise<T>, ms: number) =>
  Promise.race([promise, sleep(ms).then(() => 'still pending' as const)])

interface CompactingSession {
  compact(): Promise<unknown>
  abortCompaction(): void
  abort(): Promise<void>
  readonly isCompacting: boolean
  readonly isIdle: boolean
  sessionManager: { appendMessage(message: unknown): string }
}

/**
 * A production session whose `PreCompact` verdict is held by the test, with enough
 * history for `prepareCompaction` to find something to summarise (80 000 characters
 * per message against the default 20 000-token keep window), and an endpoint that
 * nothing listens on — no request is ever answered.
 */
async function sessionWithPendingVerdict(): Promise<{
  session: CompactingSession
  asked: () => number
  answer: (verdict: Verdict) => void
  dispose: () => void
}> {
  const root = mkdtempSync(join(tmpdir(), 'nessy-f1591-'))
  const adapter = createPiRuntimeAdapter()
  const registry = await adapter.createRegistry()
  const baseUrl = 'http://127.0.0.1:9/v1'
  const { def } = buildCustomEndpointModelDef('f1591-model', baseUrl, undefined, undefined, 'openai-completions')
  const modelRegistry = registry.modelRegistry as unknown as {
    registerProvider(name: string, config: object): void
    find(provider: string, id: string): unknown
  }
  modelRegistry.registerProvider('custom-endpoint', { baseUrl, apiKey: 'f1591-key', api: 'openai-completions', authHeader: true, models: [def] })
  let asked = 0
  let answer: (verdict: Verdict) => void = () => {}
  const handle = await adapter.createSession({
    cwd: root,
    agentDir: join(root, 'agent'),
    registry,
    strategy: { kind: 'memory' },
    sessionOptions: { tools: [], model: modelRegistry.find('custom-endpoint', 'f1591-model') },
    requestCompactionDecision: () => {
      asked += 1
      return new Promise<Verdict>(resolve => { answer = resolve })
    },
  } as never)
  const session = handle.session as unknown as CompactingSession
  const text = 'x'.repeat(80_000)
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }
  for (let i = 0; i < 4; i++) {
    session.sessionManager.appendMessage({ role: 'user', content: [{ type: 'text', text: `q${i} ${text}` }], timestamp: Date.now() })
    session.sessionManager.appendMessage({
      role: 'assistant', content: [{ type: 'text', text: `a${i} ${text}` }],
      api: 'openai-completions', provider: 'custom-endpoint', model: 'f1591-model', usage, stopReason: 'stop', timestamp: Date.now(),
    })
  }
  return {
    session,
    asked: () => asked,
    answer: verdict => answer(verdict),
    dispose: () => {
      answer(undefined)
      handle.dispose()
      rmSync(root, { recursive: true, force: true })
    },
  }
}

async function untilAsked(asked: () => number): Promise<void> {
  const deadline = Date.now() + 30_000
  while (asked() === 0 && Date.now() < deadline) await sleep(20)
  if (asked() === 0) throw new Error('the compaction never reached session_before_compact — the rig measures nothing')
}

describe('F1.591 · a Stop during a pending PreCompact verdict, on the production composition (Pi 0.85)', () => {
  it('abortCompaction + abort settle without the host verdict, and the compaction ends as cancelled', async () => {
    const rig = await sessionWithPendingVerdict()
    try {
      const compaction = rig.session.compact().then(() => 'completed', (error: Error) => `rejected: ${error.message}`)
      await untilAsked(rig.asked)
      expect(rig.session.isCompacting).toBe(true)

      rig.session.abortCompaction()
      const stop = rig.session.abort().then(() => 'settled' as const)
      expect(await within(stop, STOP_SETTLES_WITHIN_MS)).toBe('settled')
      expect(await within(compaction, 1_000)).toBe('rejected: Compaction cancelled')
      expect({ isCompacting: rig.session.isCompacting, isIdle: rig.session.isIdle, asked: rig.asked() })
        .toEqual({ isCompacting: false, isIdle: true, asked: 1 })
    } finally {
      rig.dispose()
    }
  })

  it('CONTROL — with no Stop the compaction really waits on the verdict, and a blocking verdict still cancels it', async () => {
    const rig = await sessionWithPendingVerdict()
    try {
      const compaction = rig.session.compact().then(() => 'completed', (error: Error) => `rejected: ${error.message}`)
      await untilAsked(rig.asked)
      expect(await within(compaction, 1_000)).toBe('still pending')
      expect({ isCompacting: rig.session.isCompacting, isIdle: rig.session.isIdle }).toEqual({ isCompacting: true, isIdle: false })

      rig.answer({ block: true, reason: 'held by the test' })
      expect(await within(compaction, STOP_SETTLES_WITHIN_MS)).toBe('rejected: Compaction cancelled')
    } finally {
      rig.dispose()
    }
  })
})
