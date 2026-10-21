/**
 * F1.127 — a `/recap` on a Pi chat whose agent is not running starts it, the way a cold `/btw`
 * already does.
 *
 * `PiAgent.runMiniCompletion` refused to spawn a subprocess, by design: spawning requires AND
 * publishes a capability-turn execution manifest, and title generation — its first caller — is
 * fired off-turn with no capability turn to publish it under. So on a reopened chat (history
 * present, agent never started this run) the host's `/recap` got `null` and answered
 * `recap-unavailable` on Pi while claude and codex answered. The host already runs `/recap`
 * through `withSideChannelAgent`, which holds a capability turn for the whole call, exactly as
 * it does for `/btw` — whose Pi route (`queryLlm`) has always called `ensureSubprocess`.
 *
 * Decision (controller, 2026-09-23): parity — let the cold `/recap` start the agent. The line
 * between the two callers is the one the refusal was ABOUT: a capability turn is bound
 * (`capabilityTurnRuntime` set — `/recap`) or it is not (title generation). SIT-10 (RS-104)
 * measured a DIFFERENT cold `/recap` — a chat with no messages — and it answers
 * `empty-session` on all three runtimes before any completion is asked for; that is unchanged.
 * The case this row changes is a REOPENED chat (history present, agent not started this launch).
 */
import { describe, expect, it } from 'bun:test'
import { PiAgent } from '../pi-agent.ts'
import type { BackendConfig } from '../backend/types.ts'

function createConfig(): BackendConfig {
  return {
    provider: 'pi',
    workspace: {
      id: 'ws-cold-recap',
      name: 'Cold recap',
      rootPath: '/tmp/nessy-pi-cold-recap',
      workspaceRootPath: '/tmp/nessy-pi-cold-recap',
      sessionRootPath: '/tmp/nessy-pi-cold-recap-sessions',
    } as never,
    session: { id: 'session-cold-recap', createdAt: 0, lastUsedAt: 0 } as never,
    isHeadless: true,
  }
}

interface Internals {
  subprocess: unknown
  capabilityTurnRuntime: unknown
  ensureSubprocess(): Promise<void>
  send(message: { type: string; id?: string }): void
  pendingMiniCompletions: Map<string, { resolve(value: string | null): void }>
}

/** A PiAgent whose spawn is observable: `ensureSubprocess` records the call and "starts" a child. */
function rig() {
  const agent = new PiAgent(createConfig())
  const runtime = agent as unknown as Internals
  const calls = { spawn: 0, sent: [] as string[] }
  const child = { stdin: { writable: true, write: () => true }, kill: () => {}, exitCode: null, signalCode: null }
  runtime.ensureSubprocess = async () => { calls.spawn += 1; runtime.subprocess = child }
  runtime.send = message => {
    calls.sent.push(message.type)
    if (message.type === 'mini_completion' && message.id) {
      const pending = runtime.pendingMiniCompletions.get(message.id)
      runtime.pendingMiniCompletions.delete(message.id)
      queueMicrotask(() => pending?.resolve('A one-line recap.'))
    }
  }
  return { agent, runtime, calls }
}

describe('Pi mini completion on a cold agent (F1.127)', () => {
  it('a caller holding a capability turn (the host /recap) starts the agent and gets an answer', async () => {
    const { agent, runtime, calls } = rig()
    runtime.capabilityTurnRuntime = { view: { sources: [] }, materializer: {} }
    expect(await agent.runMiniCompletion('recap this')).toBe('A one-line recap.')
    expect(calls.spawn).toBe(1)
    expect(calls.sent).toEqual(['mini_completion'])
  })

  it('an off-turn caller (title generation) still never drives a cold spawn', async () => {
    const { agent, runtime, calls } = rig()
    runtime.capabilityTurnRuntime = null
    expect(await agent.runMiniCompletion('title this')).toBeNull()
    expect(calls.spawn).toBe(0)
    expect(calls.sent).toEqual([])
  })

  it('a warm agent answers without a second spawn, turn or no turn (the unchanged path)', async () => {
    const { agent, runtime, calls } = rig()
    runtime.subprocess = { stdin: { writable: true, write: () => true }, kill: () => {}, exitCode: null, signalCode: null }
    runtime.capabilityTurnRuntime = null
    expect(await agent.runMiniCompletion('warm recap')).toBe('A one-line recap.')
    expect(calls.spawn).toBe(0)
  })
})
