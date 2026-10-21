/**
 * UA12.100 (P-UA-am-2) — on Claude, the reply the CLI writes after a background task ends IS the node's output.
 *
 * F1.492's shape: a node's turn starts a background `Agent` and answers "started it"; the host's idle door arrives
 * while the agent runs, so the settlement gate defers it (UA4.8) with the door's text. When the agent ends, the CLI
 * opens a turn of its OWN to deliver the result — its words reach the transcript through the between-turns door,
 * but no host `complete` follows (no second idle door). The gate's 5 s re-check then completes the node. Before this
 * row it completed it with the DEFERRED door's text ("started it"); the real answer stayed in the child's chat.
 *
 * Now a re-check that settles takes the session's newest final assistant message when it is NEWER than the one the
 * door saw (`ConductorSessionHost.getSessionFinalMessage`, read at the door and again at settlement). Only a message
 * written after the door can win, so the turn-scoped rule (header item 4) still never hands back an earlier turn's
 * answer.
 *
 * Arms (real `TaskRunner` + real `createSessionConductorHost` over a structural SessionManager):
 * 1. the F1.492 fixture: the node's output is the CLI turn's reply;
 * 2. negative: a re-check with no newer message keeps the door's text;
 * 3. boundary: a door that produced no text never takes an EARLIER turn's message (the newest at the door);
 * 4. the host reads the newest final message from the session's `lastFinalMessageId` and `getSessionFinalText`.
 */
import { afterAll, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CreateSessionOptions } from '@nessy-agent/shared/protocol'
import { readNodeOutput, readRunLog, saveTaskSpec, parseTaskSpec, type TaskSpec } from '@nessy-agent/shared/tasks'
import type { SessionCompletionEvent } from '../../sessions/SessionManager'
import { TaskRunner } from '../TaskRunner'
import { createSessionConductorHost, type ConductorSessionManager } from '../conductor-host'

const roots: string[] = []
afterAll(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }) })
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
const RECHECK_MS = 5

function specOf(raw: unknown): TaskSpec {
  const r = parseTaskSpec(raw)
  if (!r.success) throw new Error('bad fixture: ' + JSON.stringify(r.error.issues))
  return r.data
}

/** A structural SessionManager whose child session's newest final message the test writes. */
class FakeSessionManager {
  readonly listeners = new Set<(evt: SessionCompletionEvent) => void>()
  backend = 0
  /** The child's newest final assistant message (`lastFinalMessageId` + its text). */
  final: { id: string; text: string } | undefined
  private n = 0
  async createSession(_ws: string, options: CreateSessionOptions) { return { id: `child-${options.name}-${++this.n}` } }
  announceSessionCreated() {}
  sendMessage(_s: string, _m: string, _a: unknown, _b: unknown, _o: unknown, _c: unknown, _d: unknown, onAck?: (id: string) => void): Promise<void> {
    onAck?.('m')
    return new Promise<void>(() => {})
  }
  async setSessionStatus() {}
  async setKanbanColumn() {}
  async setTaskNodeCount() {}
  async cancelProcessing() {}
  onSessionComplete(listener: (evt: SessionCompletionEvent) => void) {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  getSessions() {
    return [
      { id: 'orch', permissionMode: 'default' },
      { id: 'child-a-1', lastFinalMessageId: this.final?.id },
    ]
  }
  getSessionFinalText(sessionId: string) { return sessionId === 'child-a-1' ? this.final?.text : undefined }
  async getPiHarnessRuntimeSnapshot() { return { settlement: { settled: true } } }
  getProjectHandleService() { return undefined }
  listSessionScheduledWork() { return { crons: [], tasks: [] } }
  getBackendBackgroundActivity() { return this.backend }
  hasHostTurnDueOrRunning() { return false }
  complete(sessionId: string, evt: Partial<SessionCompletionEvent> = {}) {
    for (const l of [...this.listeners]) l({ sessionId, workspaceId: 'ws', reason: 'complete', ...evt })
  }
}

function rig(tag: string) {
  const root = mkdtempSync(join(tmpdir(), `ua12-100-${tag}-`))
  roots.push(root)
  saveTaskSpec(root, specOf({ id: tag, title: tag, goal: 'g', nodes: [{ id: 'a', prompt: 'a' }] }))
  const sm = new FakeSessionManager()
  const host = createSessionConductorHost(sm as unknown as ConductorSessionManager, { workspaceId: 'ws', workspaceRoot: root })
  const runner = new TaskRunner({ host, workspaceId: 'ws', workspaceRoot: root, settlementRecheckMs: RECHECK_MS })
  const node = () => runner.getRunState(tag, 'r1')!.nodes[0]!
  const output = () => readNodeOutput(root, tag, 'r1', 'a')?.text
  const woke = () => readRunLog(root, tag, 'r1').some(e => e.kind === 'node-woke-after-done')
  return { sm, host, runner, node, output, woke }
}

describe('UA12.100 — the Claude CLI\'s delivery-turn reply is the node\'s output', () => {
  it('F1.492 fixture: the re-check that settles after the CLI\'s own turn takes that turn\'s reply', async () => {
    const { sm, runner, node, output, woke } = rig('cli-reply')
    await runner.run('cli-reply', { runId: 'r1' })
    await sleep(0)
    sm.backend = 1 // the background Agent runs
    sm.final = { id: 'm1', text: 'STARTED THE AGENT' }
    sm.complete('child-a-1', { finalMessageId: 'm1', finalText: 'STARTED THE AGENT' })
    await sleep(RECHECK_MS * 6)
    expect(node().state).toBe('running')
    // The agent ends; the CLI opens its own turn and writes the result (between-turns door, no host `complete`).
    sm.final = { id: 'm2', text: 'THE AGENT FOUND 3 BUGS' }
    sm.backend = 0
    await sleep(RECHECK_MS * 6)
    expect(node().state).toBe('done')
    expect(output()).toBe('THE AGENT FOUND 3 BUGS')
    expect(woke()).toBe(false)
  })

  it('negative: a re-check with no newer message keeps the door\'s text', async () => {
    const { sm, runner, node, output } = rig('no-newer')
    await runner.run('no-newer', { runId: 'r1' })
    await sleep(0)
    sm.backend = 1
    sm.final = { id: 'm1', text: 'WATCHED IT' }
    sm.complete('child-a-1', { finalMessageId: 'm1', finalText: 'WATCHED IT' })
    await sleep(RECHECK_MS * 4)
    sm.backend = 0
    await sleep(RECHECK_MS * 6)
    expect(node().state).toBe('done')
    expect(output()).toBe('WATCHED IT')
  })

  it('boundary: a door that produced no text never takes an earlier turn\'s message', async () => {
    const { sm, runner, node, output } = rig('no-text')
    await runner.run('no-text', { runId: 'r1' })
    await sleep(0)
    sm.final = { id: 'm0', text: 'AN EARLIER TURN' } // written before this node's door
    sm.backend = 1
    sm.complete('child-a-1', {}) // this turn produced no final message
    await sleep(RECHECK_MS * 4)
    sm.backend = 0
    await sleep(RECHECK_MS * 6)
    expect(node().state).toBe('done')
    expect(output()).toBe('')
  })

  it('the host reads the newest final message from lastFinalMessageId and getSessionFinalText', () => {
    const { sm, host } = rig('host-read')
    const read = (host as { getSessionFinalMessage?: (id: string) => { id: string; text: string } | undefined }).getSessionFinalMessage
    expect(typeof read).toBe('function')
    expect(read!.call(host, 'child-a-1')).toBeUndefined()
    sm.final = { id: 'm7', text: 'REPLY' }
    expect(read!.call(host, 'child-a-1')).toEqual({ id: 'm7', text: 'REPLY' })
    expect(read!.call(host, 'missing')).toBeUndefined()
  })
})
