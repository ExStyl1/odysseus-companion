/**
 * Non-blocking automation-test path.
 *
 * Mirrors the tail of `SessionManager.executePromptAutomation` — the worktree
 * step and the `awaitCompletion` branch. The real method is not instantiated
 * here; it has too many file-system deps (see host-client-fallback.test.ts).
 * Keep this mirror in sync with the real tail.
 *
 * Guards #736/#943: the automations.TEST RPC must resolve as soon as the session
 * is created, NOT after the whole agent.chat loop drains — otherwise it rejects
 * at the 30s transport timeout while the run continues.
 *
 * Guards desktop-scheduled-tasks.md:34: "Enable the worktree toggle when
 * creating the task to give each run its own isolated Git worktree." The
 * isolation must be in place BEFORE either send branch, and a failure to isolate
 * must refuse the run rather than fall back to the live checkout.
 */

import { describe, it, expect } from 'bun:test'

// Mirror of the executePromptAutomation tail. `emitSessionCreated` stands in for
// this.sendEvent({ type: 'session_created' }); `enterWorktree` stands in for
// this.createSessionWorktreePort(managed).enter(); `sendMessage` stands in for
// this.sendMessage(); `onRunError` stands in for the background history write.
async function runTail(opts: {
  sessionId: string
  awaitCompletion: boolean
  worktree?: boolean
  emitSessionCreated: () => void
  enterWorktree?: () => Promise<void>
  sendMessage: () => Promise<void>
  onRunError: (err: unknown) => void
}): Promise<{ sessionId: string }> {
  opts.emitSessionCreated()

  if (opts.worktree === true) {
    try {
      await opts.enterWorktree!()
    } catch (error) {
      throw new Error(`automation-worktree-failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  if (opts.awaitCompletion === false) {
    void opts.sendMessage().catch(opts.onRunError)
    return { sessionId: opts.sessionId }
  }

  await opts.sendMessage()
  return { sessionId: opts.sessionId }
}

describe('executePromptAutomation non-blocking test path', () => {
  it('resolves with sessionId before the agent run completes when awaitCompletion=false', async () => {
    let sessionCreated = false
    let drainStarted = false
    let drainResolve!: () => void
    const drain = new Promise<void>((r) => { drainResolve = r })

    const result = await runTail({
      sessionId: 'sess-1',
      awaitCompletion: false,
      emitSessionCreated: () => { sessionCreated = true },
      sendMessage: () => { drainStarted = true; return drain },
      onRunError: () => {},
    })

    // Returned without awaiting the drain, but only after session_created.
    expect(result).toEqual({ sessionId: 'sess-1' })
    expect(sessionCreated).toBe(true)
    expect(drainStarted).toBe(true)
    drainResolve() // let the background drain finish so no unhandled promise lingers
  })

  it('routes background run failures to onRunError when awaitCompletion=false', async () => {
    let captured: unknown = null
    await runTail({
      sessionId: 'sess-2',
      awaitCompletion: false,
      emitSessionCreated: () => {},
      sendMessage: () => Promise.reject(new Error('boom')),
      onRunError: (err) => { captured = err },
    })
    await Promise.resolve() // let the .catch microtask flush
    expect((captured as Error)?.message).toBe('boom')
  })

  it('awaits the full run when awaitCompletion=true (default scheduler path)', async () => {
    let drained = false
    const result = await runTail({
      sessionId: 'sess-3',
      awaitCompletion: true,
      emitSessionCreated: () => {},
      sendMessage: async () => { drained = true },
      onRunError: () => {},
    })
    expect(result).toEqual({ sessionId: 'sess-3' })
    expect(drained).toBe(true)
  })

  it('enters the worktree before the prompt is sent, on both send branches', async () => {
    for (const awaitCompletion of [true, false]) {
      const order: string[] = []
      await runTail({
        sessionId: 'sess-4',
        awaitCompletion,
        worktree: true,
        emitSessionCreated: () => {},
        enterWorktree: async () => { order.push('enter') },
        sendMessage: async () => { order.push('send') },
        onRunError: () => {},
      })
      await Promise.resolve()
      expect(order).toEqual(['enter', 'send'])
    }
  })

  it('refuses the run when isolation was requested and could not be created', async () => {
    let sent = false
    await expect(runTail({
      sessionId: 'sess-5',
      awaitCompletion: true,
      worktree: true,
      emitSessionCreated: () => {},
      // The reason createPiWorktreeLeaseService throws when the automation
      // session inherited no project handle.
      enterWorktree: () => Promise.reject(new Error('worktree-project-required')),
      sendMessage: async () => { sent = true },
      onRunError: () => {},
    })).rejects.toThrow('automation-worktree-failed: worktree-project-required')
    // Never silently runs in the live checkout — that is the outcome the toggle
    // exists to rule out.
    expect(sent).toBe(false)
  })

  it('skips the worktree step entirely when the task did not ask for isolation', async () => {
    let entered = false
    await runTail({
      sessionId: 'sess-6',
      awaitCompletion: true,
      emitSessionCreated: () => {},
      enterWorktree: async () => { entered = true },
      sendMessage: async () => {},
      onRunError: () => {},
    })
    expect(entered).toBe(false)
  })
})
