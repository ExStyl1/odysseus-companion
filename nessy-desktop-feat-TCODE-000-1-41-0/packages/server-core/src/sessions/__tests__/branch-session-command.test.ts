/**
 * P6.881 — `/branch`, the typed spelling of an affordance that already worked.
 *
 * `2a506a6d4` established that the transcript's branch button forks in place and
 * switches you in on every runtime that branches, and that the only thing left
 * was DISCOVERABILITY. The typed form buys one more thing the button never can:
 * it is the only spelling that exists in `-p`, in `apps/cli` and in the headless
 * server, where there is no transcript to click.
 *
 * Placement is `/cd`'s, and for the same reason recorded there: a branch creates
 * a SESSION, a host object no runtime has a turn-level mechanism for, so it is
 * executed by `SessionManager.sendMessage` ahead of the turn boundary rather
 * than at the `BaseAgent.chat` seam.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { parseSessionCommand } from '@nessy-agent/shared/slash-commands/session-command'
import { createManagedSession, type SessionManager } from '../SessionManager'
import { createTestSessionManager } from './test-session-manager'

const managers: SessionManager[] = []

afterEach(() => {
  for (const manager of managers.splice(0)) manager.cleanup()
})

let seq = 0

/**
 * `ManagedSession.messages` is `PersistedMessage[]`, whose `attachments` differ
 * from the DTO's — so the shape is built inline and cast once, here, rather than
 * at every call site.
 */
type TranscriptMessage = { id: string; role: 'assistant'; content: string; timestamp: number }

function assistantMessage(id: string): TranscriptMessage {
  return { id, role: 'assistant', content: 'done', timestamp: Date.now() }
}

function fixture(over: { messages?: TranscriptMessage[]; supportsBranching?: boolean } = {}) {
  const manager = createTestSessionManager()
  managers.push(manager)
  seq += 1
  const workspaceId = `ws-branch-${seq}`
  const managed = createManagedSession({ id: `session-branch-${seq}` }, {
    id: workspaceId,
    name: 'Workspace Branch',
    rootPath: '/tmp/nessy-branch-command-workspace',
    createdAt: 1,
  }, { messagesLoaded: true, ephemeral: true })
  managed.messages = (over.messages ?? [assistantMessage('msg-final')]) as never
  // `resolveSupportsBranching` reads the LIVE agent first, which is what a real
  // session has; a runtime that cannot branch is exactly what the false arm is.
  managed.agent = { supportsBranching: over.supportsBranching ?? true } as never
  ;(manager as unknown as { sessions: Map<string, unknown> }).sessions.set(
    `${workspaceId}:${managed.id}`,
    managed,
  )
  const created: Array<Record<string, unknown>> = []
  ;(manager as unknown as {
    createSession(workspaceId: string, options: Record<string, unknown>): Promise<{ id: string; name?: string }>
  }).createSession = async (_workspaceId, options) => {
    created.push({ workspaceId: _workspaceId, ...options })
    return { id: 'child-session', name: String(options.name ?? '') }
  }
  const run = async (): Promise<void> => {
    await (manager as unknown as {
      runBranchSessionCommand(m: unknown): Promise<void>
    }).runBranchSessionCommand(managed)
  }
  const lines = (): string[] => managed.messages
    .filter(message => message.id !== 'msg-final')
    .map(message => String(message.content))
  return { managed, created, run, lines }
}

describe('/branch is a command (P6.881)', () => {
  test('the classifier answers it, and only for the whole message', () => {
    // POSITIVE + NEGATIVE in one: the command takes no argument, so
    // `/branch off this idea` is prose and belongs to the model.
    expect(parseSessionCommand('/branch')).toEqual({ kind: 'branch' })
    expect(parseSessionCommand('  /BRANCH  ')).toEqual({ kind: 'branch' })
    expect(parseSessionCommand('/branch off this idea')).toBeNull()
    expect(parseSessionCommand('please /branch')).toBeNull()
  })

  test('it forks from the LAST completed turn, inheriting the connection, and says where the branch went', async () => {
    // POSITIVE. Same `createSession` call the transcript button makes, with the
    // same inherited settings — a child on another connection would be refused
    // rather than branched.
    const { managed, created, run, lines } = fixture({
      messages: [assistantMessage('msg-old'), assistantMessage('msg-final')],
    })
    managed.name = 'Refactor the gate'
    managed.llmConnection = 'conn-a' as never
    managed.model = 'model-a'
    managed.permissionMode = 'plan'
    managed.enabledSourceSlugs = ['alpha']

    await run()

    expect(created).toHaveLength(1)
    expect(created[0]).toMatchObject({
      branchFromSessionId: managed.id,
      // The LAST completed turn, not the first: the composer sits at the end of
      // the conversation, so `/branch` typed there means "branch from here".
      branchFromMessageId: 'msg-final',
      llmConnection: 'conn-a',
      model: 'model-a',
      permissionMode: 'plan',
    })
    expect((created[0] as { name?: string }).name).toBe('Branch of Refactor the gate')
    // The reply NAMES the child, because this arm cannot switch the user in —
    // that is desktop navigation, and it does not exist in `-p`.
    const said = lines().join('\n')
    expect(said).toContain('child-session')
    expect(said).toContain('this session is unchanged')
  })

  test('a runtime that cannot branch, and a conversation with nothing to branch from, each refuse in their own words', async () => {
    // NEGATIVE 1: the refusal is the command's own sentence, never a thrown
    // send, and no session is created.
    const noBranch = fixture({ supportsBranching: false })
    await noBranch.run()
    expect(noBranch.created).toEqual([])
    expect(noBranch.lines().join('\n')).toContain('does not support branching')

    // NEGATIVE 2: an empty conversation produces a sentence rather than an empty
    // child — `getLastFinalAssistantMessageId` has nothing to answer with.
    const empty = fixture({ messages: [] })
    await empty.run()
    expect(empty.created).toEqual([])
    expect(empty.lines().join('\n')).toContain('no completed turn')
  })
})
