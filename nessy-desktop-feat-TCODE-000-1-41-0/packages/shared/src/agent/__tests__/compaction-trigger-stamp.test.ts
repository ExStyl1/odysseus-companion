/**
 * F1.241 — every "Compacted…" info says WHICH compaction it reports.
 *
 * `SessionManager` marks an Accept & Compact plan ready only on a MANUAL compaction (the
 * `/compact` the user or Accept & Compact asked for); an automatic one must never execute a
 * plan. The host cannot tell the two apart from the words — Pi's threshold compaction and
 * claude's automatic `compact_boundary` read exactly like the manual ones — so each runtime
 * stamps `compactionTrigger` from its OWN signal (native-first):
 *
 * - Pi: `compaction_end.reason` — `"manual" | "threshold" | "overflow"` in the installed
 *   `@earendil-works/pi-coding-agent` `agent-session.d.ts`; and `runSessionCommand`'s
 *   `/compact` arm, which IS the manual command.
 * - claude: `SDKCompactBoundaryMessage.compact_metadata.trigger: 'manual' | 'auto'`
 *   (`sdk.d.ts`).
 * - codex: no trigger on the wire (`thread/compacted` is `{threadId, turnId}`); the agent knows
 *   (`manualCompactionRequestedForTurn`, which its PostCompact hook already reads) and stamps it
 *   through the adapter's `isManualCompactionRequested` (F1.467, `codex-compaction-trigger.test.ts`);
 *   the adapter driven alone stays UNSTAMPED, which the host's gate (`!== 'auto'`) reads as before.
 *
 * Upstream (craft-agents-oss v0.13.4) carries the same field under the same name
 * (`compactionTrigger?: 'manual' | 'auto'` on the `info` event).
 */
import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { PiEventAdapter } from '../backend/pi/event-adapter.ts'
import { ClaudeEventAdapter } from '../backend/claude/event-adapter.ts'

function piCompactionEnd(reason: string): unknown[] {
  const adapter = new PiEventAdapter()
  return [...adapter.adaptEvent({ type: 'compaction_end', reason, result: {}, aborted: false, willRetry: false } as never)]
}

async function claudeBoundary(trigger: 'manual' | 'auto' | undefined): Promise<unknown[]> {
  const adapter = new ClaudeEventAdapter({ onDebug: undefined, mapSDKError: async () => ({ type: 'typed_error', error: {} }) } as never)
  return adapter.adapt({
    type: 'system',
    subtype: 'compact_boundary',
    session_id: 'sess-1',
    ...(trigger ? { compact_metadata: { trigger, pre_tokens: 1 } } : {}),
  } as never)
}

describe('compaction infos carry their trigger (F1.241)', () => {
  it('Pi: compaction_end.reason manual → manual; threshold and overflow → auto', () => {
    expect(piCompactionEnd('manual')).toEqual([{ type: 'info', message: 'Compacted context to fit within limits', compactionTrigger: 'manual' }])
    expect(piCompactionEnd('threshold')).toEqual([{ type: 'info', message: 'Compacted context to fit within limits', compactionTrigger: 'auto' }])
    expect(piCompactionEnd('overflow')).toMatchObject([{ type: 'info', compactionTrigger: 'auto' }])
  })

  it('claude: compact_boundary.compact_metadata.trigger; a boundary that does not say stays unstamped', async () => {
    expect(await claudeBoundary('manual')).toEqual([{ type: 'info', message: 'Compacted Conversation', compactionTrigger: 'manual' }])
    expect(await claudeBoundary('auto')).toEqual([{ type: 'info', message: 'Compacted Conversation', compactionTrigger: 'auto' }])
    const [unsaid] = await claudeBoundary(undefined) as Array<Record<string, unknown>>
    expect(unsaid).toEqual({ type: 'info', message: 'Compacted Conversation' })
    expect('compactionTrigger' in unsaid!).toBe(false)
  })

  it('Pi: the /compact session command stamps all three of its infos manual (F1.856 adds the refusal answer)', () => {
    const source = readFileSync(new URL('../pi-agent.ts', import.meta.url), 'utf8')
    const arm = source.slice(source.indexOf("if (command.kind === 'compact') {"), source.indexOf("yield { type: 'complete' };", source.indexOf("if (command.kind === 'compact') {")))
    expect(arm.length).toBeGreaterThan(0)
    // Comment-stripped: the arm's own comment names the field, and a pin that counted it went
    // green on one stamped info plus one sentence (measured: 3 where the code carries 2).
    const code = arm.replace(/\/\/.*$/gm, '')
    expect(code.split("compactionTrigger: 'manual'").length - 1).toBe(3)
    expect(code.split("type: 'info'").length - 1).toBe(3)
  })
})
