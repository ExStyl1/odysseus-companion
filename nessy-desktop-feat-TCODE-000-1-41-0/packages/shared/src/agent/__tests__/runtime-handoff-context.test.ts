import { describe, expect, it } from 'bun:test'
import { buildRuntimeHandoffContext } from '../base-agent.ts'
import type { RecoveryMessage } from '../backend/types.ts'
import { TestAgent, collectEvents, createMockBackendConfig, createMockCapabilityTurnRuntime } from './test-utils.ts'

const MESSAGES = [
  { type: 'user' as const, content: 'add a retry to the fetch helper' },
  { type: 'assistant' as const, content: 'Done — three retries with backoff in fetchWithRetry.' },
]

describe('buildRuntimeHandoffContext', () => {
  it('returns null with no messages', () => {
    expect(buildRuntimeHandoffContext('pi', [])).toBeNull()
    expect(buildRuntimeHandoffContext('pi', undefined)).toBeNull()
  })

  it('names the runtime it came from', () => {
    const text = buildRuntimeHandoffContext('pi', MESSAGES)!
    expect(text).toContain('<runtime_handoff_context>')
    expect(text).toContain('different runtime')
    expect(text).toContain('(pi)')
  })

  it('carries the transcript, not a summary of it', () => {
    const text = buildRuntimeHandoffContext('pi', MESSAGES)!
    expect(text).toContain('add a retry to the fetch helper')
    expect(text).toContain('fetchWithRetry')
  })

  it('bounds a long history the same way the branch seed does', () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ type: 'user' as const, content: `msg-${i}` }))
    const text = buildRuntimeHandoffContext('pi', many)!
    expect(text).not.toContain('msg-0\n')
    expect(text).toContain('msg-39')
  })

  it('truncates an oversized single message', () => {
    const text = buildRuntimeHandoffContext('pi', [{ type: 'user' as const, content: 'x'.repeat(5000) }])!
    expect(text).toContain('...[truncated]')
  })

  /**
   * P3.153 · the cap must not manufacture a path that resolves to nothing.
   *
   * `SessionManager` appends the attachment pointer AFTER a row's own words, so
   * an over-long message used to have its `[Stored at: …]` line cut at whatever
   * character offset 1 200 landed on — leaving `[Attached image: bug.png]`
   * standing over half a path. A path lives on one line, so the cap is stated
   * in lines: the kept tail starts at a line boundary and every line in it is
   * whole.
   */
  it('keeps a trailing whole line rather than cutting a path in half', () => {
    const path = `/Users/x/Library/Application Support/nessy/workspaces/w-1/sessions/s-1/attachments/${'a'.repeat(40)}-bug.png`
    const content = `${'x'.repeat(1_150)}\n\n[Attached image: bug.png]\n[Stored at: ${path}]`

    const text = buildRuntimeHandoffContext('pi', [{ type: 'user' as const, content }])!
    expect(text).toContain('...[truncated]')
    // The whole path, not a prefix of it — and the marker sits ahead of the
    // block, so the model can see which half was cut.
    expect(text).toContain(`[Stored at: ${path}]`)
    expect(text.indexOf('...[truncated]')).toBeLessThan(text.indexOf('[Attached image: bug.png]'))
    // …and the head really was cut: the message's own words did not survive whole.
    expect(text).not.toContain('x'.repeat(1_150))
  })

  /**
   * The negative control for the row above, and the reason the fix is a budget
   * rather than a reservation: a body with no line boundary in its tail has no
   * complete trailing line to protect, and inventing one by cutting it is the
   * defect itself. So that case is byte-identical to the pre-P3.153 output,
   * head length and marker included.
   */
  it('leaves a single-line oversized body truncated exactly as before', () => {
    const text = buildRuntimeHandoffContext('pi', [{ type: 'user' as const, content: 'x'.repeat(5000) }])!
    expect(text).toContain(`${'x'.repeat(1200)}...[truncated]`)
  })

  /**
   * P3.153 · the window's other half. A message older than the window takes
   * everything it introduced with it — an attachment pointer included — and
   * nothing used to say a cut had happened, so a later "the screenshot I showed
   * you" referred to something this block neither contains nor admits to
   * missing. The pointers are NOT hoisted (that shows a file with none of the
   * conversation that explains it); the loss is named instead.
   */
  it('says how many messages the window dropped, and stays quiet when it dropped none', () => {
    const many = Array.from({ length: 31 }, (_, i) => ({ type: 'user' as const, content: `msg-${i}` }))
    const text = buildRuntimeHandoffContext('pi', many)!
    expect(text).toContain('Only the last 24 of 31 messages are reproduced below; the 7 earlier ones are not, and neither are the files they named.')
    // The notice is a FACT about this block, so it appears only when the cut
    // really happened — a standing sentence would be a lie on every short
    // handoff, which is most of them.
    const short = buildRuntimeHandoffContext('pi', MESSAGES)!
    expect(short).not.toContain('are reproduced below')
    const exact = buildRuntimeHandoffContext('pi', many.slice(-24))!
    expect(exact).not.toContain('are reproduced below')
  })

  // Negative subject. The handoff element must NOT be the branch-seed element:
  // a branch tells the model to ignore everything after the cutoff, which is
  // false here and reads as an instruction to forget the history being handed
  // over. A builder that simply delegated to `buildBranchSeedContext` would
  // pass every assertion above and fail this one.
  it('does not carry the branch seed’s "ignore the parent" instruction', () => {
    const text = buildRuntimeHandoffContext('pi', MESSAGES)!
    expect(text).not.toContain('<branch_seed_context>')
    expect(text).not.toContain('Ignore and do not assume')
  })
})

// P2 of `docs/superpowers/plans/2026-08-20-cross-runtime-history-carry.md`:
// the one seam through which a runtime claims native delivery of the handoff.
// A per-turn query, not a class constant — a constant would make the text
// fallback unreachable on any agent that set it (audit row A6).
class HandoffSeamAgent extends TestAgent {
  /** What `shouldSuppressTextHandoff` answers this turn. */
  public suppressTextHandoff = false

  protected override shouldSuppressTextHandoff(): boolean {
    return this.suppressTextHandoff
  }

  /** Test window onto the protected stash the native paths (T1a/T2) read. */
  get stashedHandoff(): { from: string; messages: RecoveryMessage[] } | null {
    return this.pendingRuntimeHandoff
  }
}

describe('the handoff-delivery seam (shouldSuppressTextHandoff)', () => {
  function agentWithHandoff(suppress: boolean) {
    const handoff = { from: 'pi', messages: MESSAGES as RecoveryMessage[] }
    let applied = false
    const agent = new HandoffSeamAgent(createMockBackendConfig({
      // One-shot, the way SessionManager arms it: gone once marked applied.
      getRuntimeHandoffMessages: () => (applied ? null : handoff),
      markRuntimeHandoffApplied: () => { applied = true },
    }))
    // `chat()` throws `capability-turn-runtime-required` without this. These
    // three rows shipped red for want of it (P2 recorded that they were run by
    // the integrator, and they were not); fixed in T1a's commit, since T1a is
    // the first consumer of the seam they cover.
    agent.setCapabilityTurnRuntime(createMockCapabilityTurnRuntime())
    agent.suppressTextHandoff = suppress
    return { agent, handoff, wasApplied: () => applied }
  }

  // The default path must be unchanged from the pre-seam behaviour: the text
  // handoff block sits immediately ahead of the user's own message, and the
  // payload is consumed.
  //
  // Asserted as a TAIL rather than as the whole message, and the difference is
  // the reason these rows were red until T1a. `chat()` always composes the
  // pinned capability block onto the front — even with no layers at all it
  // emits `<capability-generation>…</capability-generation>` — so a byte-equal
  // assertion describes a send that cannot happen.
  it('default (false) delivers the text handoff exactly as before and marks it applied', async () => {
    const { agent, wasApplied } = agentWithHandoff(false)
    await collectEvents(agent.chat('continue please'))
    expect(agent.chatCalls).toHaveLength(1)
    expect(agent.chatCalls[0]!.message).toEndWith(
      `${buildRuntimeHandoffContext('pi', MESSAGES)!}\n\ncontinue please`,
    )
    expect(wasApplied()).toBe(true)
    expect(agent.stashedHandoff).toBeNull()
  })

  it('suppression skips the text build, leaves the payload armed, and stashes it for the native path', async () => {
    const { agent, handoff, wasApplied } = agentWithHandoff(true)
    await collectEvents(agent.chat('continue please'))
    expect(agent.chatCalls).toHaveLength(1)
    // No text crossed…
    expect(agent.chatCalls[0]!.message).not.toContain('<runtime_handoff_context>')
    expect(agent.chatCalls[0]!.message).toEndWith('continue please')
    // …the payload is NOT consumed (a failed native delivery must be able to
    // fall back to text on the next turn)…
    expect(wasApplied()).toBe(false)
    // …and the native consumer finds exactly what SessionManager armed.
    expect(agent.stashedHandoff).toEqual(handoff)
  })

  // The stash is a per-turn snapshot: a later unsuppressed turn must clear it,
  // or a native consumer would read a stale obligation.
  it('an unsuppressed turn resets the stash', async () => {
    const { agent } = agentWithHandoff(true)
    await collectEvents(agent.chat('first'))
    expect(agent.stashedHandoff).not.toBeNull()
    agent.suppressTextHandoff = false
    await collectEvents(agent.chat('second'))
    expect(agent.stashedHandoff).toBeNull()
  })
})
