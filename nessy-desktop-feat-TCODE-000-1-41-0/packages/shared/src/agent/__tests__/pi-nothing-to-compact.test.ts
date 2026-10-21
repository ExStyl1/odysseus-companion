/**
 * F1.856 — Pi's REFUSAL to compact a short session is not a failed compaction.
 *
 * Measured on the 1.41.0 RC (SIT-x, SIT-y): Accept & Compact on a short Pi plan session sent
 * `/compact`, Pi answered `Nothing to compact (session too small)`, and the host received it
 * as an `error` — the same shape as a compaction that genuinely failed — so the pending plan
 * stayed awaiting, no "Plan approved…" turn followed, and the flow dead-ended.
 *
 * The chain, read at HEAD: `AgentSession.compact()` in `@earendil-works/pi-coding-agent`
 * 0.85.1 throws a plain `Error` (no code) when `prepareCompaction` finds nothing to summarise;
 * `pi-agent-server`'s `handleCompact` forwards its message verbatim as
 * `compact_result { success: false, errorMessage }`; `PiAgent.handleCompactResult` rejects with
 * that text; `runSessionCommand` threw, and `chatImpl`'s catch turned it into `error`.
 *
 * So the only signal is Pi's text, matched in ONE named constant
 * (`PI_NOTHING_TO_COMPACT_REFUSALS`). The refusal now answers a MANUAL-stamped `info` that is
 * not "Compacted…" (the host's readiness rule reads it, `pending-plan-claim.test.ts`); every
 * other rejection still throws, which the CONTROL below pins.
 */
import { describe, expect, it } from 'bun:test'
import type { AgentEvent } from '@nessy-agent/core/types'
import * as piAgentModule from '../pi-agent.ts'
import type { BackendConfig } from '../backend/types.ts'

const { PiAgent } = piAgentModule
/** Pi 0.85.1's two texts, written out so a HEAD without the constant still runs every arm. */
const REFUSALS = ['Nothing to compact (session too small)', 'Already compacted'] as const
/** F1.729 — what a manual `/compact` says BEFORE it waits on the subprocess (the host stamps it `compacting`). */
const COMPACTING = { type: 'status', message: 'Compacting context...' } as const

function createConfig(): BackendConfig {
  return {
    provider: 'pi',
    workspace: {
      id: 'ws-nothing-to-compact',
      name: 'Nothing To Compact',
      rootPath: '/tmp/nessy-general-agent-nothing-to-compact',
      workspaceRootPath: '/tmp/nessy-general-agent-nothing-to-compact',
      sessionRootPath: '/tmp/nessy-general-agent-nothing-to-compact-sessions/ws',
    } as never,
    session: {
      id: 'session-nothing-to-compact',
      workspaceRootPath: '/tmp/nessy-general-agent-nothing-to-compact',
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
    } as never,
    isHeadless: true,
    skipConfigWatcher: true,
  }
}

/** Drive the real `/compact` arm with the subprocess answering `compact_result` as given. */
async function runCompact(answer: Record<string, unknown>): Promise<{ events: AgentEvent[]; thrown?: Error }> {
  const agent = new PiAgent(createConfig())
  const internals = agent as unknown as {
    ensureSubprocess(): Promise<void>
    send(message: Record<string, unknown>): void
    handleCompactResult(message: Record<string, unknown>): void
    runSessionCommand(command: { kind: 'compact'; customInstructions?: string }): AsyncGenerator<AgentEvent>
  }
  internals.ensureSubprocess = async () => {}
  internals.send = message => {
    if (message.type === 'compact') queueMicrotask(() => internals.handleCompactResult({ id: message.id, ...answer }))
  }
  const events: AgentEvent[] = []
  try {
    for await (const event of internals.runSessionCommand({ kind: 'compact' })) events.push(event)
    return { events }
  } catch (error) {
    return { events, thrown: error as Error }
  } finally {
    agent.dispose()
  }
}

describe("Pi's nothing-to-compact refusal settles the manual compaction (F1.856)", () => {
  it.each([...REFUSALS])('%s → a manual-stamped info and completion, no error', async refusal => {
    const { events, thrown } = await runCompact({ success: false, errorMessage: refusal })
    expect(thrown).toBeUndefined()
    expect(events).toEqual([
      COMPACTING,
      { type: 'info', message: refusal, compactionTrigger: 'manual' },
      { type: 'complete' },
    ])
    // Not a "Compacted…" info: the host must not draw a compaction boundary for it.
    expect((events[1] as { message: string }).message.startsWith('Compacted')).toBe(false)
  })

  it('ONE named constant carries exactly the two texts of the installed Pi SDK', () => {
    const constant = (piAgentModule as Record<string, unknown>).PI_NOTHING_TO_COMPACT_REFUSALS
    expect(Array.isArray(constant) ? [...constant] : constant).toEqual([...REFUSALS])
  })

  it('CONTROL: a compaction that genuinely FAILED still throws (the turn ends with an error, the plan is not run)', async () => {
    const { events, thrown } = await runCompact({ success: false, errorMessage: 'Compaction failed: summary request returned 500' })
    expect(thrown?.message).toBe('Compaction failed: summary request returned 500')
    expect(events).toEqual([COMPACTING]) // F1.729 — announced, then the failure; no "Compacted…" info
    // The Pi text inside a longer failure is not the refusal either.
    const wrapped = await runCompact({ success: false, errorMessage: 'Context compaction failed: Nothing to compact (session too small)' })
    expect(wrapped.thrown).toBeDefined()
  })

  it('CONTROL: a real compaction still answers its "Compacted…" info', async () => {
    const { events, thrown } = await runCompact({ success: true, result: { summary: 's', firstKeptEntryId: 'e1', tokensBefore: 12345 } })
    expect(thrown).toBeUndefined()
    expect(events[1]).toMatchObject({ type: 'info', compactionTrigger: 'manual' })
    expect((events[1] as { message: string }).message.startsWith('Compacted')).toBe(true)
  })
})

/**
 * F1.729 — a manual `/compact` on Pi showed no "Compacting…" label and no Stop button (SIT-i D8): the
 * SDK's own `compaction_start` lands on the subprocess event queue, which the session-command arm never
 * drains, so nothing reached the host while `requestCompact` waited. The arm now announces itself with
 * the status SessionManager stamps `compacting` (the label, `isCompacting`), before the wait.
 */
describe('a manual /compact announces itself before it waits (F1.729)', () => {
  it('the Compacting status is yielded BEFORE the subprocess answers', async () => {
    const agent = new PiAgent(createConfig())
    const internals = agent as unknown as {
      ensureSubprocess(): Promise<void>
      send(message: Record<string, unknown>): void
      handleCompactResult(message: Record<string, unknown>): void
      runSessionCommand(command: { kind: 'compact' }): AsyncGenerator<AgentEvent>
    }
    internals.ensureSubprocess = async () => {}
    let sentCompactId: unknown
    internals.send = message => { if (message.type === 'compact') sentCompactId = message.id }
    try {
      const generator = internals.runSessionCommand({ kind: 'compact' })
      const first = await generator.next()
      expect(first.value).toEqual(COMPACTING)
      expect(sentCompactId).toBeUndefined() // announced while nothing has been asked of the subprocess yet
      const pending = generator.next()
      await new Promise(resolve => setTimeout(resolve, 0))
      internals.handleCompactResult({ id: sentCompactId, success: true, result: { summary: 's', firstKeptEntryId: 'e1', tokensBefore: 10 } })
      expect((await pending).value).toMatchObject({ type: 'info', compactionTrigger: 'manual' })
    } finally {
      agent.dispose()
    }
  })

  it('CONTROL: the announcement is not a compaction result (the host must not read it as "Compacted…")', () => {
    expect(COMPACTING.message.startsWith('Compacted')).toBe(false)
    expect(COMPACTING.message.includes('Compacting')).toBe(true) // the keyword SessionManager stamps `compacting` from
  })
})

/**
 * F1.880 — the MODEL's own `/compact` (its `SlashCommand` tool) must get the same answer as the
 * user's typed one. The real route: `executeSessionTool` → session-tools-core's `handleSlashCommand`
 * → `PiAgent.dispatchSlashCommand` → `requestCompact`, with only the subprocess faked. A rejection
 * that escapes `dispatchSlashCommand` becomes `handleSlashCommand`'s `errorResponse`, so the
 * refusal used to reach the model as a failed tool call.
 */
async function runModelCompact(answer: Record<string, unknown>): Promise<{ content: string; isError: boolean }> {
  const agent = new PiAgent(createConfig())
  const internals = agent as unknown as {
    ensureSubprocess(): Promise<void>
    send(message: Record<string, unknown>): void
    handleCompactResult(message: Record<string, unknown>): void
    executeSessionTool(name: string, args: Record<string, unknown>): Promise<{ content: string; isError: boolean }>
  }
  internals.ensureSubprocess = async () => {}
  internals.send = message => {
    if (message.type === 'compact') queueMicrotask(() => internals.handleCompactResult({ id: message.id, ...answer }))
  }
  try {
    return await internals.executeSessionTool('SlashCommand', { command: 'compact' })
  } finally {
    agent.dispose()
  }
}

describe("the model's SlashCommand /compact gets Pi's refusal as an ordinary answer (F1.880)", () => {
  it.each([...REFUSALS])('%s → a successful tool result carrying the refusal text', async refusal => {
    const result = await runModelCompact({ success: false, errorMessage: refusal })
    expect(result.isError).toBe(false)
    expect(result.content).toBe(refusal)
  })

  it('CONTROL: a compaction that genuinely FAILED is still a tool error, the text quoting a refusal included', async () => {
    const failed = await runModelCompact({ success: false, errorMessage: 'Compaction failed: summary request returned 500' })
    expect(failed.isError).toBe(true)
    expect(failed.content).toContain('Compaction failed: summary request returned 500')
    const wrapped = await runModelCompact({ success: false, errorMessage: 'Context compaction failed: Nothing to compact (session too small)' })
    expect(wrapped.isError).toBe(true)
  })

  it('CONTROL: a real compaction still answers its exact "Compacted…" text, with and without the estimate', async () => {
    const plain = await runModelCompact({ success: true, result: { summary: 's', firstKeptEntryId: 'e1', tokensBefore: 12345 } })
    expect(plain).toEqual({ isError: false, content: `Compacted context to fit within limits (from ~${(12345).toLocaleString()} tokens)` })
    const estimated = await runModelCompact({
      success: true, result: { summary: 's', firstKeptEntryId: 'e1', tokensBefore: 12345, estimatedTokensAfter: 2345 },
    })
    expect(estimated).toEqual({
      isError: false,
      content: `Compacted context to fit within limits (from ~${(12345).toLocaleString()} to ~${(2345).toLocaleString()} tokens)`,
    })
    const bare = await runModelCompact({ success: true })
    expect(bare).toEqual({ isError: false, content: 'Compacted context to fit within limits' })
  })
})
