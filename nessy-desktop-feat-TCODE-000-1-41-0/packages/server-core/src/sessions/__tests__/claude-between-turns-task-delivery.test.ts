/**
 * F1.492 — the HOST half: a claude background task that ends between turns reaches `processEvent`, and its end
 * reaches the model ONCE — the CLI's own delivery, never a second one from R86.
 *
 * ## What was measured (vendored `claude` 2.1.251 through `ClaudeAgent`, the `work/wjaf/` rig)
 *
 * When a background subagent ends, the CLI opens a turn OF ITS OWN carrying `<task-notification>`. R86 had been
 * delivering the same end again as a notice turn (`deliverMonitorEvent` → `sendMessage`). The rig replayed exactly
 * that — a notice written into the live input 50 ms after the between-turns `task_notification`, the user's next
 * message 200 ms after the notice's turn ended — and the boundaries slipped by one: the notice's turn received the
 * CLI's own reply (`F1492-BG-REPLY`), the notice itself was answered in a turn no slot watched, and the user's NEXT
 * turn was shown that answer (`F1492-R86-REPLY`) while its own (`F1492-SECOND-DONE`) was dropped.
 *
 * ## The arms
 *
 * - the door: `onBetweenTurnsEvent` is wired for claude sessions too (source text — the config builder is the
 *   one line this file cannot reach without building a whole agent, and it is the line that decides);
 * - the R86 gate: an agent that says it delivers the end itself (`deliversBackgroundTaskEndsItself`) gets no notice
 *   turn, and its CONTROL twin — the same events on an agent that does not say so — still gets R86's (Pi keeps it);
 * - end to end through the host: a REAL `ClaudeAgent` (SDK `query` faked, `claude-steer-fifo.test.ts`'s rig) whose
 *   door is this manager's `processEvent` — the row ends, the CLI's reply lands in the transcript, no notice is sent.
 */
import { afterAll, afterEach, describe, expect, it, mock } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as sdkPackage from '@anthropic-ai/claude-agent-sdk'
import type { AgentEvent } from '@nessy-agent/core/types'
import { createManagedSession } from '../SessionManager.ts'
import { createTestSessionManager } from './test-session-manager.ts'

const realSdk = { ...sdkPackage }
const scripts: Array<() => AsyncGenerator<unknown>> = []

function resultMessage(): unknown {
  return {
    type: 'result',
    subtype: 'success',
    result: 'ok',
    num_turns: 1,
    usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  }
}

mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  ...realSdk,
  query: (input: { prompt: unknown }) => {
    const iterator = (input.prompt as AsyncIterable<unknown>)[Symbol.asyncIterator]()
    async function* serveTurns(): AsyncGenerator<unknown> {
      for (;;) {
        const next = await iterator.next()
        if (next.done) return
        const script = scripts.shift()
        if (script) yield* script()
        else yield resultMessage()
      }
    }
    const stream = serveTurns() as AsyncGenerator<unknown> & { interrupt(): Promise<unknown> }
    stream.interrupt = async () => ({ still_queued: [] })
    return stream
  },
}))

afterAll(() => {
  mock.module('@anthropic-ai/claude-agent-sdk', () => realSdk)
})

const { ClaudeAgent } = await import('@nessy-agent/shared/agent/claude-agent')

const TASK_ID = 'a76f36bb24e7d8df5'
const roots: string[] = []
const agents: Array<{ destroy(): void }> = []

afterEach(() => {
  for (const agent of agents.splice(0)) agent.destroy()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

interface Rig {
  managed: Record<string, unknown> & { messages: Array<{ role: string; content: string }> }
  sent: string[]
  forwarded: Array<Record<string, unknown>>
  deliver(event: AgentEvent): Promise<void>
}

function createRig(agent: Record<string, unknown> | null): Rig {
  const stateRoot = mkdtempSync(join(tmpdir(), 'sm-f1-492-'))
  roots.push(stateRoot)
  const workspace = { id: 'ws-f1-492', name: 'F1.492', slug: 'f1-492', rootPath: join(stateRoot, 'workspace'), createdAt: Date.now() }
  mkdirSync(workspace.rootPath, { recursive: true })
  const manager = createTestSessionManager()
  const managed = createManagedSession({ id: 'session-f1-492' }, workspace as never, { messagesLoaded: true, ephemeral: true })
  const internals = manager as unknown as {
    sessions: Map<string, unknown>
    sendMessage(...args: unknown[]): Promise<void>
    processEvent(managed: unknown, event: AgentEvent): Promise<void>
    persistSession(managed: unknown): void
  }
  internals.sessions.set(`${workspace.id}:${managed.id}`, managed)
  internals.persistSession = () => {}
  manager.flushSession = async () => {}
  const sent: string[] = []
  internals.sendMessage = async (...args: unknown[]) => { sent.push(String(args[1])) }
  const forwarded: Array<Record<string, unknown>> = []
  manager.setEventSink(((_channel: unknown, _target: unknown, event: Record<string, unknown>) => {
    forwarded.push(event)
  }) as Parameters<typeof manager.setEventSink>[0])
  const shaped = managed as unknown as Rig['managed']
  // A session that has had its first prompt: R86 holds everything before it as first-turn context.
  shaped.messages.push({ role: 'user', content: 'start a background subagent' } as never)
  ;(shaped as Record<string, unknown>).agent = agent
  return { managed: shaped, sent, forwarded, deliver: event => internals.processEvent(managed, event) }
}

const backgrounded: AgentEvent = { type: 'task_backgrounded', toolUseId: 'toolu_f1492_agent', taskId: TASK_ID } as AgentEvent
const completed: AgentEvent = { type: 'task_completed', taskId: TASK_ID, status: 'completed', summary: 'probe bg finished' } as AgentEvent

describe('F1.492 — the host door and R86 for a claude background task that ends between turns', () => {
  it('the detached-task door is wired for claude sessions, not for Pi alone', () => {
    const source = readFileSync(join(import.meta.dir, '..', 'SessionManager.ts'), 'utf8')
    expect(source).toContain("onBetweenTurnsEvent: provider === 'pi' || provider === 'anthropic'")
    // The negative: the Pi-only spelling is gone, so a revert cannot pass beside the new one.
    expect(source).not.toContain("onBetweenTurnsEvent: provider === 'pi'\n")
  })

  it('an agent that delivers the end itself gets NO second delivery — the row still ends', async () => {
    const rig = createRig({ deliversBackgroundTaskEndsItself: true, isProcessing: () => false, redirect: () => true })

    await rig.deliver(backgrounded)
    await rig.deliver(completed)

    expect(rig.sent).toEqual([])
    expect(rig.forwarded.some(event => event.type === 'task_completed' && event.taskId === TASK_ID)).toBe(true)
    expect((rig.managed.backgroundTaskOutputs as Map<string, unknown>).has(TASK_ID)).toBe(true)
  })

  it('CONTROL — the same events on an agent that does not deliver the end itself still get R86\'s notice turn', async () => {
    const rig = createRig({ isProcessing: () => false, redirect: () => true })

    await rig.deliver(backgrounded)
    await rig.deliver(completed)

    expect(rig.sent).toHaveLength(1)
    expect(rig.sent[0]).toContain(`Background subagent task ${TASK_ID} finished (completed).`)
  })

  it('END TO END — a real ClaudeAgent\'s between-turns task end and the CLI\'s own reply reach the transcript, once', async () => {
    let rig!: Rig
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'sm-f1-492-agent-'))
    roots.push(workspaceRoot)
    const agent = new ClaudeAgent({
      provider: 'anthropic',
      providerType: 'anthropic',
      model: 'claude-sonnet-4-6',
      isHeadless: true,
      skipConfigWatcher: true,
      workspace: { id: 'ws-f1-492', name: 'F1.492', rootPath: workspaceRoot, workspaceRootPath: workspaceRoot, sessionRootPath: `${workspaceRoot}/sessions` },
      session: { id: 'session-f1-492', createdAt: Date.now(), lastUsedAt: Date.now(), workingDirectory: workspaceRoot },
      // The host's own door, as the config builder wires it: fire-and-forget into `processEvent`.
      onBetweenTurnsEvent: (event: AgentEvent) => { void rig.deliver(event) },
    } as never)
    agents.push(agent)
    rig = createRig(agent as unknown as Record<string, unknown>)

    let open!: () => void
    let release!: () => void
    const gate = new Promise<void>(resolve => { open = resolve })
    const drained = new Promise<void>(resolve => { release = resolve })
    const stream = (event: unknown) => ({ type: 'stream_event', event, parent_tool_use_id: null, session_id: 'sdk-f1-492', uuid: `s-${Math.random()}` })
    scripts.push(async function* turnThenBetween() {
      yield { type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: TASK_ID, task_type: 'local_agent', description: 'probe bg' }], uuid: 'u-1', session_id: 'sdk-f1-492' }
      yield resultMessage()
      await gate
      yield { type: 'system', subtype: 'background_tasks_changed', tasks: [], uuid: 'u-2', session_id: 'sdk-f1-492' }
      yield { type: 'system', subtype: 'task_notification', task_id: TASK_ID, status: 'completed', output_file: '', summary: 'probe bg finished', uuid: 'u-3', session_id: 'sdk-f1-492' }
      yield { type: 'system', subtype: 'init', session_id: 'sdk-f1-492', uuid: 'u-4' }
      yield stream({ type: 'message_start', message: { id: 'msg_cli_own', role: 'assistant', content: [] } })
      yield stream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'F1492-BG-REPLY' } })
      yield { type: 'assistant', parent_tool_use_id: null, session_id: 'sdk-f1-492', uuid: 'a-1', message: { id: 'msg_cli_own', role: 'assistant', content: [{ type: 'text', text: 'F1492-BG-REPLY' }] } }
      yield stream({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } })
      yield resultMessage()
      release()
    })

    // Turn 1, through the host exactly as the chat loop feeds it; its Agent call's `task_backgrounded`
    // (tool-matching's, for a claude child) is what arms R86 for this id.
    const chatImpl = (agent as unknown as { chatImpl(message: string): AsyncGenerator<AgentEvent> }).chatImpl.bind(agent)
    for await (const event of chatImpl('start a background subagent')) {
      if (event.type !== 'complete') await rig.deliver(event)
    }
    await rig.deliver(backgrounded)
    open()
    await drained
    await new Promise(resolve => setTimeout(resolve, 50))

    expect(rig.forwarded.some(event => event.type === 'task_completed' && event.taskId === TASK_ID)).toBe(true)
    expect(rig.managed.messages.filter(message => message.role === 'assistant').map(message => message.content)).toEqual(['F1492-BG-REPLY'])
    // Delivered ONCE — by the CLI. No notice turn was written into the live input beside it.
    expect(rig.sent).toEqual([])
  })
})

/**
 * F1.808 (SIT-p WJ-am, packaged 5896a66d2) — Pi's transcript shows the labelled 'Background task notification —
 * delivered by the app, not typed by you' line for a background end (R86's notice turn, F1.351's line), while claude's
 * showed nothing: the CLI delivers the end itself (F1.492) and its own-turn reply followed with no line above it. The
 * host now writes the same line for such a runtime — the notice R86 would have sent, never sent to the model again.
 */
describe('F1.808 — a claude background end is a labelled line in the transcript, as on Pi', () => {
  const lines = (rig: Rig) => rig.managed.messages.filter(message => (message as { taskNotification?: true }).taskNotification === true)

  it('THE ROW — an agent that delivers the end itself gets ONE notice line (persisted, sent as message_added) and no model delivery', async () => {
    const rig = createRig({ deliversBackgroundTaskEndsItself: true, isProcessing: () => false, redirect: () => true })
    await rig.deliver(backgrounded)
    await rig.deliver(completed)
    expect(rig.sent).toEqual([])
    expect(lines(rig)).toHaveLength(1)
    expect(lines(rig)[0]!.role).toBe('user')
    expect(lines(rig)[0]!.content).toContain(`Background subagent task ${TASK_ID} finished (completed).`)
    expect(rig.forwarded.filter(event => event.type === 'message_added')).toHaveLength(1)
  })

  it('CONTROL — a stopped task draws no line (the user stopped it; R86 delivers nothing for it either)', async () => {
    const rig = createRig({ deliversBackgroundTaskEndsItself: true, isProcessing: () => false, redirect: () => true })
    await rig.deliver(backgrounded)
    await rig.deliver({ ...completed, status: 'stopped' } as AgentEvent)
    expect(lines(rig)).toEqual([])
  })

  it('CONTROL — an end inside a running host turn draws no line (the turn is drawing; residue, stated)', async () => {
    const rig = createRig({ deliversBackgroundTaskEndsItself: true, isProcessing: () => true, redirect: () => true })
    ;(rig.managed as Record<string, unknown>).isProcessing = true
    await rig.deliver(backgrounded)
    await rig.deliver(completed)
    expect(lines(rig)).toEqual([])
  })

  it('CONTROL — Pi (R86 delivers it) gets no extra line here: its line is the notice turn\'s own entry', async () => {
    const rig = createRig({ isProcessing: () => false, redirect: () => true })
    await rig.deliver(backgrounded)
    await rig.deliver(completed)
    expect(rig.sent).toHaveLength(1)
    expect(lines(rig)).toEqual([])
    expect(rig.forwarded.filter(event => event.type === 'message_added')).toEqual([])
  })
})
