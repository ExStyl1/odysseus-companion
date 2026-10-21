/**
 * D17 — a `/subtask` fork's answer lands in the MAIN transcript.
 *
 * `sub-agents.md:1019` — "The fork appears in a panel below your prompt and runs
 * in the background while you keep working." The panel is the live surface. The
 * transcript is the record, and it carried a fork START (a transient `info`
 * event that does not even survive a reload) and no result at all: a reviewer or
 * an incident review reading the conversation afterwards saw a fork begin and
 * nothing else.
 *
 * The terminal side is driven through the real session path — the exactly-once
 * `SubagentStop` observation `ChildSessionService.emitTerminalOnce` makes — and
 * the entry is produced by replaying the ordinary `tool_start`/`tool_result`
 * pair, so what is asserted here is what a real fork produces.
 */

import { describe, expect, test } from 'bun:test'
import { messageToStored, storedToPersistedMessage } from '@nessy-agent/core/types'
import { encodeSessionKey } from '@nessy-agent/shared/sessions/session-key'
import { forkTranscriptEntry } from '../fork-transcript-entry.ts'
import { createTestSessionManager } from './test-session-manager.ts'

const WORKSPACE = 'workspace-subtask-transcript'
const SESSION = 'session-subtask-transcript'

function forkRecord(overrides: Record<string, unknown> = {}): any {
  return {
    schemaVersion: 1,
    agentId: 'agent-fork-1',
    parentSessionKey: { workspaceId: WORKSPACE, sessionId: SESSION },
    childSessionKey: { workspaceId: WORKSPACE, sessionId: 'fork-child' },
    agent: 'fork',
    task: 'draft unit tests for the parser changes so far',
    background: true,
    backgroundTaskId: 'task-fork-abc',
    restrictions: { prompt: '', model: 'm', tools: ['read'], worktreePolicy: 'shared', fork: true },
    budgets: { depth: 0, maxDepth: 2, fanout: 2, concurrency: 1, tokenLimit: 100, costLimitUsd: 1, deadlineAt: Date.now() + 1000, ancestry: [] },
    status: 'completed',
    output: '',
    result: 'Added 4 table-driven cases; two were already covered by the DSL contract.',
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  }
}

function harness() {
  const manager = createTestSessionManager()
  const managed: any = {
    id: SESSION,
    workspace: { id: WORKSPACE, rootPath: process.cwd() },
    permissionMode: 'ask',
    llmConnection: 'pi',
    messagesLoaded: true,
    // Ephemeral so the assertion never writes into the developer's real session
    // store; `enqueuePersist` is the only step this skips, and the reload
    // assertion below covers that boundary through the same mappers it uses.
    ephemeral: true,
    messages: [],
    backgroundShellCommands: new Map(),
    backgroundTaskOutputs: new Map(),
    piBackgroundTaskKinds: new Map(),
    childSessionState: undefined,
    agent: null,
  }
  ;(manager as any).sessions.set(encodeSessionKey({ workspaceId: WORKSPACE, sessionId: SESSION }), managed)
  return { manager, managed }
}

const stop = async (manager: any, managed: any, record: unknown): Promise<void> =>
  manager.executePiChildTerminalAutomation(managed, 'SubagentStop', record)

describe("a settled /subtask fork is written to the transcript (sub-agents.md:1019)", () => {
  test("a completed fork's answer is in the transcript, and survives a reload", async () => {
    const { manager, managed } = harness()

    await stop(manager, managed, forkRecord())

    const entry = managed.messages.find((message: any) => message.role === 'tool')
    expect(entry).toBeDefined()
    expect(entry.toolName).toBe('subagent')
    expect(entry.toolStatus).toBe('completed')
    expect(entry.toolInput).toEqual({ agent: 'fork', task: 'draft unit tests for the parser changes so far' })
    expect(entry.toolResult).toContain('Added 4 table-driven cases')

    // Reload survival, at the boundary `enqueuePersist` actually crosses: the
    // message is not a transient `status` row, and the stored mappers preserve
    // the result verbatim.
    expect(entry.role).not.toBe('status')
    const reloaded = storedToPersistedMessage(messageToStored(entry))
    expect(reloaded.role).toBe('tool')
    expect(reloaded.toolResult).toBe(entry.toolResult)
    expect(reloaded.toolStatus).toBe('completed')
  })

  test('a stopped fork leaves a stated outcome, not silence', async () => {
    const { manager, managed } = harness()

    await stop(manager, managed, forkRecord({
      status: 'stopped', result: undefined, output: 'read three files, wrote none',
    }))

    const entry = managed.messages.find((message: any) => message.role === 'tool')
    expect(entry?.toolStatus).toBe('error')
    expect(entry?.toolResult).toContain('stopped before it finished')
    // The partial work is the part a review wants; the outcome line says why it
    // stops there.
    expect(entry?.toolResult).toContain('read three files, wrote none')
  })

  test('a failed fork records the reason', async () => {
    const { manager, managed } = harness()

    await stop(manager, managed, forkRecord({ status: 'failed', result: undefined, error: 'token budget exhausted' }))

    const entry = managed.messages.find((message: any) => message.role === 'tool')
    expect(entry?.toolStatus).toBe('error')
    expect(entry?.toolResult).toContain('token budget exhausted')
  })

  test('exactly one entry per fork, and none for a subagent-tool run', async () => {
    const { manager, managed } = harness()

    // A named subagent: its result already reaches the transcript as the Agent
    // tool call's own result.
    await stop(manager, managed, forkRecord({
      agent: 'Explore', restrictions: { prompt: 'p', model: 'm', tools: ['read'], worktreePolicy: 'shared' },
    }))
    // A fork the MODEL spawned through the tool — it carries an owner task, and
    // a second entry for it would double-report the same run.
    await stop(manager, managed, forkRecord({ agentId: 'agent-fork-2', ownerTaskId: 'owner-1' }))
    // A record that has not settled.
    await stop(manager, managed, forkRecord({ agentId: 'agent-fork-3', status: 'running' }))
    // The user fork.
    await stop(manager, managed, forkRecord({ agentId: 'agent-fork-4' }))

    const entries = managed.messages.filter((message: any) => message.role === 'tool')
    expect(entries.map((message: any) => message.toolUseId)).toEqual(['subtask-agent-fork-4'])
  })
})

describe('forkTranscriptEntry', () => {
  test('every terminal status produces an entry — a record of successes only is worse than none', () => {
    for (const status of ['completed', 'failed', 'stopped', 'interrupted'] as const) {
      expect(forkTranscriptEntry(forkRecord({ status, result: undefined, output: '' }))?.result).toBeTruthy()
    }
  })

  test('a completed fork that returned nothing still says so', () => {
    const entry = forkTranscriptEntry(forkRecord({ result: undefined, output: '' }))
    expect(entry?.toolStatus).toBe('completed')
    expect(entry?.result).toBe('The fork finished without returning a result.')
  })
})

/**
 * R69b — the same record, for a `context: fork` SKILL.
 *
 * `skills.md:571` — "The forked subagent runs in the background: you keep
 * working while it runs, and its result arrives in your conversation when it
 * completes." That is the DEFAULT dispatch mode, so without an entry here the
 * default leaves nothing in the conversation at all — the dead-field shape this
 * finding was refused for once already.
 */
function skillForkRecord(overrides: Record<string, unknown> = {}): any {
  return forkRecord({
    agentId: 'agent-skill-1',
    agent: 'worker',
    // A skill fork's task is the whole SKILL BODY, which is why the entry names
    // the skill instead of echoing the prompt back into the transcript.
    task: 'Research the parser change and report the three riskiest call sites.',
    backgroundTaskId: 'task-skill-abc',
    restrictions: {
      prompt: 'You are a worker agent.',
      model: 'm',
      tools: ['read'],
      worktreePolicy: 'shared',
      skillFork: { name: 'research' },
    },
    result: 'Three risky call sites: a, b, c.',
    ...overrides,
  })
}

describe("a settled background forked skill is written to the transcript (skills.md:571)", () => {
  test('the entry names the skill, not the agent type and not the prompt', async () => {
    const { manager, managed } = harness()

    await stop(manager, managed, skillForkRecord())

    const entry = managed.messages.find((message: any) => message.role === 'tool')
    expect(entry?.toolStatus).toBe('completed')
    expect(entry?.toolInput).toEqual({ agent: 'research', task: 'Forked skill: research' })
    expect(entry?.toolResult).toContain('Three risky call sites')
    // The skill body drove the CHILD; pasting it back here would undo the
    // isolation and could be 256 KiB of it.
    expect(entry?.toolResult).not.toContain('Research the parser change')
    expect(JSON.stringify(entry?.toolInput)).not.toContain('Research the parser change')
  })

  test('a FOREGROUND forked skill writes nothing, because its result already came back', async () => {
    // `:571`'s second sentence — `background: false` returns the result "in the
    // turn that invoked the skill". A transcript entry as well would report the
    // same answer twice.
    const { manager, managed } = harness()

    await stop(manager, managed, skillForkRecord({ background: false, backgroundTaskId: undefined }))
    // And a child the MODEL owns still writes nothing, skill fork or not.
    await stop(manager, managed, skillForkRecord({ agentId: 'agent-skill-2', ownerTaskId: 'owner-1' }))

    expect(managed.messages.filter((message: any) => message.role === 'tool')).toEqual([])
  })

  test('an unhappy ending says "the forked skill", and a conversation fork still says "the fork"', () => {
    expect(forkTranscriptEntry(skillForkRecord({ status: 'failed', result: undefined, error: 'budget' })))
      .toMatchObject({ skill: 'research', toolStatus: 'error' })
    expect(forkTranscriptEntry(skillForkRecord({ status: 'failed', result: undefined, error: 'budget' }))?.result)
      .toContain('The forked skill failed: budget')
    // The conversation-fork wording is unchanged, byte for byte.
    expect(forkTranscriptEntry(forkRecord({ status: 'failed', result: undefined, error: 'budget' }))?.result)
      .toBe('The fork failed: budget')
    // A conversation fork produces an ENTRY that carries no `skill`; an entry
    // that was never produced satisfies `?.skill` just as well and means the
    // opposite.
    const conversationFork = forkTranscriptEntry(forkRecord())
    expect(conversationFork).toBeDefined()
    expect(conversationFork?.skill).toBeUndefined()
  })
})
