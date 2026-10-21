import { describe, expect, it, mock } from 'bun:test'
import { ClaudeAgent } from '../claude-agent.ts'
import { AbortReason } from '../backend/types.ts'

describe('ClaudeAgent handoff interrupts', () => {
  it('uses Query.interrupt() for auth handoff instead of aborting the AbortController', async () => {
    const interrupt = mock(async () => {})
    const abort = mock((_reason?: unknown) => {})
    const debug = mock((_message: string) => {})

    const agent = Object.create(ClaudeAgent.prototype) as any

    agent.currentQuery = { interrupt }
    agent.currentQueryAbortController = { abort }
    agent.pendingSteers = [{ message: 'queued steer', messageId: 'msg-a' }]
    agent.lastAbortReason = null
    agent.debug = debug

    agent.interruptForHandoff(AbortReason.AuthRequest)
    await Promise.resolve()

    expect(interrupt).toHaveBeenCalledTimes(1)
    expect(abort).not.toHaveBeenCalled()
    expect(agent.lastAbortReason).toBe(AbortReason.AuthRequest)
    // F1.238 — KEPT for the host (it used to be nulled here, dropping the
    // user's message with no `steer_undelivered`); the host takes it next.
    expect(agent.takePendingSteers()).toEqual([{ message: 'queued steer', messageId: 'msg-a' }])
  })

  it('logs interrupt failures instead of falling back to AbortController', async () => {
    const interrupt = mock(async () => {
      throw new Error('interrupt failed')
    })
    const abort = mock((_reason?: unknown) => {})
    const debug = mock((_message: string) => {})

    const agent = Object.create(ClaudeAgent.prototype) as any

    agent.currentQuery = { interrupt }
    agent.currentQueryAbortController = { abort }
    agent.pendingSteers = []
    agent.lastAbortReason = null
    agent.debug = debug

    agent.interruptForHandoff(AbortReason.PlanSubmitted)
    await Promise.resolve()
    await Promise.resolve()

    expect(abort).not.toHaveBeenCalled()
    expect(debug).toHaveBeenCalledWith('Claude handoff interrupt failed: interrupt failed')
  })

  // UB2.1 (COR-1), arms copied+adapted from craft-agents-oss v0.15.1
  // `claude-agent-handoff.test.ts` (Apache-2.0). Interrupting while SubmitPlan or an auth
  // tool was still running made the SDK store the call as "The user doesn't want to proceed
  // with this tool use", and the agent later told the user they had declined a sign-in
  // nobody was asked about. The handoff interrupt now waits for the tool's result.
  describe('asked from inside the handing-off tool', () => {
    function handingOff() {
      const interrupt = mock(async () => {})
      const agent = Object.create(ClaudeAgent.prototype) as any
      agent.currentQuery = { interrupt }
      agent.currentQueryAbortController = { abort: mock(() => {}) }
      agent.pendingSteers = []
      agent.debug = () => {}
      agent.beginToolHandoff() // what the onPlanSubmitted / onAuthRequest tool callbacks do
      return { agent, interrupt }
    }
    const result = (toolName: string) => ({ type: 'tool_result', toolUseId: 't', toolName, result: 'ok' })

    it('interrupts once the tool result is in, not before', () => {
      const { agent, interrupt } = handingOff()
      agent.interruptForHandoff(AbortReason.AuthRequest)
      expect(interrupt).not.toHaveBeenCalled()
      expect(agent.lastAbortReason).toBe(AbortReason.AuthRequest)

      agent.releaseToolHandoffOn(result('Bash'))
      expect(interrupt).not.toHaveBeenCalled()
      agent.releaseToolHandoffOn(result('mcp__session__source_oauth_trigger'))
      expect(interrupt).toHaveBeenCalledTimes(1)
      agent.releaseToolHandoffOn(result('mcp__session__source_oauth_trigger'))
      expect(interrupt).toHaveBeenCalledTimes(1)
    })

    it('retains a steer queued during the wait for the host', () => {
      // F1.238/F1.335 — a steer that arrives while the handoff interrupt waits is KEPT for the
      // host's take (the row's control: the wait never swallows a queued user message).
      const { agent, interrupt } = handingOff()
      agent.interruptForHandoff(AbortReason.PlanSubmitted)
      agent.pendingSteers.push({ message: 'queued during the wait', messageId: 'msg-b' })
      agent.releaseToolHandoffOn(result('mcp__session__SubmitPlan'))
      expect(interrupt).toHaveBeenCalledTimes(1)
      expect(agent.takePendingSteers()).toEqual([{ message: 'queued during the wait', messageId: 'msg-b' }])
    })

    it('does not interrupt when the host never asked for it', () => {
      const { agent, interrupt } = handingOff()
      agent.releaseToolHandoffOn(result('mcp__session__SubmitPlan'))
      expect(interrupt).not.toHaveBeenCalled()
      expect(agent.toolHandoff).toBeNull()
    })

    it('interrupts anyway when the result does not arrive in time', async () => {
      const { agent, interrupt } = handingOff()
      agent.handoffResultWaitMs = 5
      agent.interruptForHandoff(AbortReason.PlanSubmitted)
      await new Promise(resolve => setTimeout(resolve, 30))
      expect(interrupt).toHaveBeenCalledTimes(1)
    })

    it('drops the deferred interrupt when the turn is force-stopped', () => {
      const { agent, interrupt } = handingOff()
      // Our Stop path is `forceAbort` (cancelProcessing → forceAbort(UserStop) → the live-turn
      // interrupt, query kept): shim the dispatch seams a bare instance has no state for and
      // pin the invariant at its real location — the handoff timer is cleared BEFORE dispatch,
      // so no interrupt fires after the Stop.
      agent.runTeardownStep = () => {}
      agent.interruptLiveTurn = () => {}
      agent.endTurnForSourceActivation = () => {}
      agent.killLiveSession = () => {}
      agent.interruptForHandoff(AbortReason.PlanSubmitted)
      expect(agent.toolHandoff?.timer).toBeTruthy()
      agent.forceAbort(AbortReason.UserStop)
      expect(agent.toolHandoff).toBeNull()
      agent.releaseToolHandoffOn(result('mcp__session__SubmitPlan'))
      expect(interrupt).not.toHaveBeenCalled()
    })
  })
})
