/**
 * UB2.4 (R14-13; craft-agents-oss #804) — the server-side source-activation
 * auto-retry keeps going when the captured original message is empty
 * (an attachment-only turn: the model was asked about files, not words) by
 * falling back to the last persisted user message, and carries the steers the
 * aborted turn had already accepted, so a correction typed while the model
 * picked the wrong source is not lost by the activation's abort.
 *
 * Arms copied+adapted from craft-agents-oss v0.15.1
 * `source-activated-auto-retry.test.ts` (Apache-2.0). UB2.14 closed the
 * residue this header used to state: the retry is sent HIDDEN
 * (`SendMessageOptions.hidden`, the basic arm below), so it never draws a
 * second bubble; `hidden-send.test.ts` pins what a hidden send does.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { encodeSessionKey } from '@nessy-agent/shared/sessions/session-key'
import { buildActivationRetryMessage, claimAutoRetryPending, createManagedSession, lastUserMessageContent, type SessionManager } from '../SessionManager.ts'
import { createTestSessionManager } from './test-session-manager.ts'

const WORKSPACE_ID = 'ws-ub2-4'

type SourceActivatedEvent = {
  type: 'source_activated'
  sourceSlug: string
  originalMessage: string
}

describe('claimAutoRetryPending', () => {
  it('allows the first matching retry and drops later duplicates within the deadline', () => {
    const host = {
      autoRetryPending: {
        content: 'do it\n\n[github activated]',
        deadlineMs: 2000,
        committed: false,
      },
    }

    expect(claimAutoRetryPending(host, 'do it\n\n[github activated]', 1000)).toBe('send')
    expect(host.autoRetryPending?.committed).toBe(true)
    expect(claimAutoRetryPending(host, 'do it\n\n[github activated]', 1001)).toBe('drop')
  })

  it('clears stale pending slots without dropping the message', () => {
    const host = {
      autoRetryPending: {
        content: 'do it\n\n[github activated]',
        deadlineMs: 2000,
        committed: true,
      },
    }

    expect(claimAutoRetryPending(host, 'do it\n\n[github activated]', 2500)).toBe('send')
    expect(host.autoRetryPending).toBeUndefined()
  })

  it('does not over-dedup unrelated messages', () => {
    const host = {
      autoRetryPending: {
        content: 'do it\n\n[github activated]',
        deadlineMs: 2000,
        committed: false,
      },
    }

    expect(claimAutoRetryPending(host, 'never mind', 1000)).toBe('send')
    expect(host.autoRetryPending).toBeDefined()
  })
})

describe('buildActivationRetryMessage / lastUserMessageContent', () => {
  it('appends the kept steers between the original and the suffix', () => {
    const { plain, retry } = buildActivationRetryMessage('list my repos', ['use the v2 endpoint', '  ', 'and the other org'], 'github')
    expect(plain).toBe('list my repos\n\n[github activated]')
    expect(retry).toBe('list my repos\n\nuse the v2 endpoint\n\nand the other org\n\n[github activated]')
    // Blank steers are dropped, and with none the retry IS the plain shape.
    expect(buildActivationRetryMessage('list my repos', [], 'github').retry).toBe(plain)
  })

  it('lastUserMessageContent reads the newest non-empty user row', () => {
    const messages = [
      { role: 'assistant', content: 'hi' },
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'ok' },
      { role: 'user', content: '   ' },
      { role: 'user', content: 'the real question' },
    ]
    expect(lastUserMessageContent(messages)).toBe('the real question')
    expect(lastUserMessageContent([{ role: 'assistant', content: 'only a reply' }])).toBe('')
  })
})

describe('source_activated auto-retry', () => {
  let tmpRoot: string
  let sm: SessionManager

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'sm-ub2-4-'))
    sm = createTestSessionManager()
  })

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true })
  })

  function buildSession(id: string) {
    const managed = createManagedSession(
      { id, name: 'ub2-4 auto-retry test' },
      { id: WORKSPACE_ID, name: 'UB2.4', rootPath: tmpRoot, createdAt: Date.now() } as never,
      { messagesLoaded: true },
    )
    ;(sm as unknown as { sessions: Map<string, unknown> }).sessions.set(
      encodeSessionKey({ workspaceId: WORKSPACE_ID, sessionId: id }),
      managed,
    )
    return managed
  }

  /** Replace `sendMessage` with a spy that runs the REAL dedupe, records, and appends the row. */
  function spyOnSendMessage(sessionId: string, options: Array<{ hidden?: boolean } | undefined> = []) {
    const calls: string[] = []
    const managed = (
      sm as unknown as { sessions: Map<string, { messages: unknown[] }> }
    ).sessions.get(encodeSessionKey({ workspaceId: WORKSPACE_ID, sessionId }))!
    ;(sm as unknown as { sendMessage: (id: string, msg: string, a?: unknown, s?: unknown, o?: { hidden?: boolean }) => Promise<void> }).sendMessage = async (id, msg, _a, _s, opts) => {
      const m = (
        sm as unknown as { sessions: Map<string, { autoRetryPending?: { content: string; deadlineMs: number; committed: boolean }; messages: unknown[] }> }
      ).sessions.get(encodeSessionKey({ workspaceId: WORKSPACE_ID, sessionId: id }))!
      if (claimAutoRetryPending(m, msg) === 'drop') return
      calls.push(msg)
      options.push(opts)
      managed.messages.push({ id: `m-${calls.length}`, role: 'user', content: msg, timestamp: Date.now() })
    }
    return calls
  }

  async function fireSourceActivated(sessionId: string, sourceSlug: string, originalMessage: string) {
    const managed = (
      sm as unknown as { sessions: Map<string, unknown> }
    ).sessions.get(encodeSessionKey({ workspaceId: WORKSPACE_ID, sessionId }))!
    const event: SourceActivatedEvent = { type: 'source_activated', sourceSlug, originalMessage }
    await (sm as unknown as { processEvent: (m: unknown, e: unknown) => Promise<void> }).processEvent(managed, event)
  }

  it('basic re-send — fires sendMessage with the "[<slug> activated]" suffix, HIDDEN (UB2.14)', async () => {
    const sessionId = 'basic-resend'
    buildSession(sessionId)
    const options: Array<{ hidden?: boolean } | undefined> = []
    const calls = spyOnSendMessage(sessionId, options)

    await fireSourceActivated(sessionId, 'github', 'list my repos')
    await new Promise(r => setTimeout(r, 150))

    expect(calls).toEqual(['list my repos\n\n[github activated]'])
    // UB2.14 (upstream v0.15.1) — the retry restates a message the user already sees.
    expect(options).toEqual([{ hidden: true }])
  })

  it('POSITIVE — an attachment-only turn (empty capture) retries with the LAST USER MESSAGE', async () => {
    const sessionId = 'attachment-only'
    const managed = buildSession(sessionId)
    const calls = spyOnSendMessage(sessionId)

    // The attachment-only turn's own capture is empty; the user's message is in history.
    managed.messages.push({ id: 'u1', role: 'user', content: 'what is wrong in this screenshot?', timestamp: Date.now() } as never)

    await fireSourceActivated(sessionId, 'craft-my-space', '')
    await new Promise(r => setTimeout(r, 150))

    expect(calls).toEqual(['what is wrong in this screenshot?\n\n[craft-my-space activated]'])
  })

  it('POSITIVE — the steers the aborted turn accepted ride the retry', async () => {
    const sessionId = 'with-steers'
    const managed = buildSession(sessionId)
    const calls = spyOnSendMessage(sessionId)

    managed.messages.push({ id: 'u1', role: 'user', content: 'query the issues', timestamp: Date.now() } as never)
    // A steer was accepted into the running turn before the activation aborted it.
    managed.turnSteers = ['use the v2 endpoint']

    await fireSourceActivated(sessionId, 'linear', '')
    await new Promise(r => setTimeout(r, 150))

    expect(calls).toEqual(['query the issues\n\nuse the v2 endpoint\n\n[linear activated]'])
  })

  it('CONTROL — empty capture and no prior user message skips (nothing to resend)', async () => {
    const sessionId = 'empty-original'
    const managed = buildSession(sessionId)
    const calls = spyOnSendMessage(sessionId)

    await fireSourceActivated(sessionId, 'github', '')
    await new Promise(r => setTimeout(r, 150))

    expect(calls).toEqual([])
    expect(managed.autoRetryPending).toBeUndefined()
    expect(managed.autoRetryTimer).toBeUndefined()
  })

  it('CONTROL — a legitimate user follow-up preempts the retry', async () => {
    const sessionId = 'preempted'
    const managed = buildSession(sessionId)
    const calls = spyOnSendMessage(sessionId)

    await fireSourceActivated(sessionId, 'github', 'check the repo')
    managed.messages.push({ id: 'user-followup', role: 'user', content: 'actually check the issues instead', timestamp: Date.now() } as never)
    await new Promise(r => setTimeout(r, 150))

    expect(calls).toEqual([])
    expect(managed.autoRetryPending).toBeUndefined()
  })

  it('CONTROL — the mixed-version dedupe holds: exactly one commit whichever arrives first', async () => {
    const sessionId = 'race-rpc-first'
    buildSession(sessionId)
    const calls = spyOnSendMessage(sessionId)

    await fireSourceActivated(sessionId, 'github', 'do the thing')
    // A legacy renderer's duplicate RPC arrives BEFORE the 100 ms timer.
    await (sm as unknown as { sendMessage: (id: string, msg: string) => Promise<void> }).sendMessage(
      sessionId,
      'do the thing\n\n[github activated]',
    )
    await new Promise(r => setTimeout(r, 200))
    expect(calls).toEqual(['do the thing\n\n[github activated]'])

    // And the mirror: the timer commits first; the late duplicate drops.
    const sessionId2 = 'race-timer-first'
    buildSession(sessionId2)
    const calls2 = spyOnSendMessage(sessionId2)
    await fireSourceActivated(sessionId2, 'github', 'do the thing')
    await new Promise(r => setTimeout(r, 150))
    await (sm as unknown as { sendMessage: (id: string, msg: string) => Promise<void> }).sendMessage(
      sessionId2,
      'do the thing\n\n[github activated]',
    )
    expect(calls2).toEqual(['do the thing\n\n[github activated]'])
  })
})
