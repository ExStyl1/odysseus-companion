/**
 * F1.239 (origin upstream-refresh research, 2026-09-23) — a Pi utility error
 * settles only ITS request, and a host timeout cancels the subprocess query.
 *
 * ## The defect, read at HEAD
 *
 * `PiAgent.handleLine`'s `error` arm looped over `pendingMiniCompletions` and
 * `pendingLlmQueries` and rejected EVERY one of them for ANY subprocess error,
 * before looking at the error's code — so one failed title generation rejected
 * a concurrent `call_llm`, and a chat-turn error rejected both. The subprocess
 * sent `mini_completion_error` with no request id at all, and `llm_query_error`'s
 * generic half without one. And `runMiniCompletion` / `queryLlm` timed out on the
 * HOST only (`LLM_QUERY_TIMEOUT_MS`), leaving the subprocess's ephemeral session
 * running with nobody waiting for it.
 *
 * ## What these arms drive
 *
 * The host's real RPC path: `runMiniCompletion` / `queryLlm` register their
 * pending entries and `send` their request (recorded here), and the subprocess's
 * answers arrive as JSONL through `PiAgent.handleLine`. The subprocess half —
 * the id on the error, the cancel message and the deadline — is pinned beside
 * the coordinator in `pi-agent-server` (`ephemeral-query-routing-real-server.test.ts`).
 */
import { afterEach, describe, expect, it, jest } from 'bun:test'
import { PiAgent } from '../pi-agent.ts'
import type { BackendConfig } from '../backend/types.ts'
import { LLM_QUERY_TIMEOUT_MS } from '../llm-tool.ts'

function createConfig(): BackendConfig {
  return {
    provider: 'pi',
    workspace: {
      id: 'ws-f1239',
      name: 'Test Workspace',
      rootPath: '/tmp/nessy-f1239',
      workspaceRootPath: '/tmp/nessy-f1239',
      sessionRootPath: '/tmp/nessy-f1239-sessions/ws-f1239',
    } as any,
    session: {
      id: 'session-f1239',
      workspaceRootPath: '/tmp/nessy-f1239',
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
    } as any,
    isHeadless: true,
  }
}

function rig() {
  const agent = new PiAgent(createConfig())
  const runtime = agent as any
  const sent: Array<Record<string, any>> = []
  // A live subprocess, as far as the two RPCs are concerned.
  runtime.subprocess = {}
  runtime.ensureSubprocess = async () => {}
  runtime.send = (cmd: Record<string, any>) => { sent.push(cmd) }
  runtime.eventQueue.enqueue = () => {}
  const line = (msg: Record<string, unknown>) => runtime.handleLine(JSON.stringify(msg))
  const idOf = (type: string, index = 0) => sent.filter(cmd => cmd.type === type)[index]?.id as string
  return { agent, sent, line, idOf }
}

/** Settle-state of a promise without awaiting it forever. */
function track<T>(promise: Promise<T>) {
  const state: { status: 'pending' | 'fulfilled' | 'rejected'; value?: T; reason?: Error } = { status: 'pending' }
  promise.then(
    value => { state.status = 'fulfilled'; state.value = value },
    reason => { state.status = 'rejected'; state.reason = reason },
  )
  return state
}
const flush = async () => { for (let i = 0; i < 5; i += 1) await Promise.resolve() }

afterEach(() => { jest.useRealTimers() })

describe('F1.239 · a utility error settles only its own request', () => {
  it('a mini completion error with an id rejects that completion; its sibling still resolves', async () => {
    const { agent, line, idOf } = rig()
    const first = track(agent.runMiniCompletion('title one'))
    const second = track(agent.runMiniCompletion('title two'))
    await flush()
    line({ type: 'error', code: 'mini_completion_error', id: idOf('mini_completion', 0), message: 'first failed' })
    await flush()
    expect(first.status).toBe('rejected')
    expect(first.reason?.message).toBe('first failed')
    expect(second.status).toBe('pending')
    line({ type: 'mini_completion_result', id: idOf('mini_completion', 1), text: 'Second title' })
    await flush()
    expect(second).toMatchObject({ status: 'fulfilled', value: 'Second title' })
    agent.destroy()
  })

  it('an llm_query error with an id rejects that query; a concurrent query still resolves', async () => {
    const { agent, line, idOf } = rig()
    const failing = track(agent.queryLlm({ prompt: 'one' }))
    const sibling = track(agent.queryLlm({ prompt: 'two' }))
    await flush()
    const failingId = idOf('llm_query', 0)
    // The subprocess's dual emit: the generic error (auth-refresh detection) and the targeted result.
    line({ type: 'error', code: 'llm_query_error', id: failingId, message: 'upstream 500' })
    line({ type: 'llm_query_result', id: failingId, result: null, errorMessage: 'upstream 500' })
    await flush()
    expect(failing.status).toBe('rejected')
    expect(sibling.status).toBe('pending')
    line({ type: 'llm_query_result', id: idOf('llm_query', 1), result: { text: 'fine', model: 'm' } })
    await flush()
    expect(sibling.status).toBe('fulfilled')
    agent.destroy()
  })

  it('a chat-turn error leaves pending utility requests alone', async () => {
    const { agent, line, idOf } = rig()
    const title = track(agent.runMiniCompletion('title'))
    const query = track(agent.queryLlm({ prompt: 'q' }))
    await flush()
    line({ type: 'error', message: 'Prompt failed: model overloaded' })
    await flush()
    expect({ title: title.status, query: query.status }).toEqual({ title: 'pending', query: 'pending' })
    line({ type: 'mini_completion_result', id: idOf('mini_completion'), text: 'T' })
    line({ type: 'llm_query_result', id: idOf('llm_query'), result: { text: 'Q', model: 'm' } })
    await flush()
    expect({ title: title.status, query: query.status }).toEqual({ title: 'fulfilled', query: 'fulfilled' })
    agent.destroy()
  })

  it('a utility error from a subprocess build that sends no id settles the pending ones of ITS kind only (HEAD swept both kinds)', async () => {
    const { agent, line } = rig()
    const title = track(agent.runMiniCompletion('title'))
    const query = track(agent.queryLlm({ prompt: 'q' }))
    await flush()
    line({ type: 'error', code: 'mini_completion_error', message: 'legacy failure' })
    await flush()
    expect({ title: title.status, query: query.status }).toEqual({ title: 'rejected', query: 'pending' })
    agent.destroy()
  })
})

describe('F1.239 · a host timeout cancels the subprocess query', () => {
  it('runMiniCompletion: after LLM_QUERY_TIMEOUT_MS it resolves null AND tells the subprocess to cancel that id', async () => {
    jest.useFakeTimers()
    const { agent, sent, idOf } = rig()
    const title = track(agent.runMiniCompletion('title'))
    await flush()
    const id = idOf('mini_completion')
    jest.advanceTimersByTime(LLM_QUERY_TIMEOUT_MS)
    await flush()
    expect(title).toMatchObject({ status: 'fulfilled', value: null })
    expect(sent.filter(cmd => cmd.type === 'cancel_ephemeral_query')).toEqual([{ type: 'cancel_ephemeral_query', id }])
    agent.destroy()
  })

  it('queryLlm: after LLM_QUERY_TIMEOUT_MS it rejects AND tells the subprocess to cancel that id', async () => {
    jest.useFakeTimers()
    const { agent, sent, idOf } = rig()
    const query = track(agent.queryLlm({ prompt: 'q' }))
    await flush()
    const id = idOf('llm_query')
    jest.advanceTimersByTime(LLM_QUERY_TIMEOUT_MS)
    await flush()
    expect(query.status).toBe('rejected')
    expect(sent.filter(cmd => cmd.type === 'cancel_ephemeral_query')).toEqual([{ type: 'cancel_ephemeral_query', id }])
    agent.destroy()
  })

  it('CONTROL: a query answered in time sends no cancel', async () => {
    jest.useFakeTimers()
    const { agent, sent, line, idOf } = rig()
    const query = track(agent.queryLlm({ prompt: 'q' }))
    await flush()
    line({ type: 'llm_query_result', id: idOf('llm_query'), result: { text: 'Q', model: 'm' } })
    await flush()
    jest.advanceTimersByTime(LLM_QUERY_TIMEOUT_MS)
    await flush()
    expect(query.status).toBe('fulfilled')
    expect(sent.filter(cmd => cmd.type === 'cancel_ephemeral_query')).toEqual([])
    agent.destroy()
  })
})
