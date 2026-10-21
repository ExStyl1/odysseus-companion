/**
 * F1.225 (P-WJu-5) — the HOST half: a Pi child whose run stopped at its
 * `maxTurns` cap reaches its parent MARKED, not as an ordinary finished run.
 *
 * `sub-agents.md#resume-subagents`: "When a subagent stops at its `maxTurns`
 * limit, Claude Code marks the returned output as partial. For subagents that
 * return an agent ID, Claude Code also notes in the result that Claude can
 * message the subagent to continue from where it stopped." F1.83 made the cap
 * real on Pi (the child's own loop ends with `terminalReason: 'max_agent_turns'`)
 * and F1.224 made the capped child resumable, but nothing on the child-session
 * path read that ending: `runPiChildTurn` and the background `monitor` fallback
 * returned `completed` with the last assistant text, indistinguishable from a
 * child that finished.
 *
 * The witness is the child's own transcript, like every other outcome these two
 * paths decide (`piChildTranscriptOutcome`): P2.98 writes the turn's verdict row
 * durably (`persistTurnTerminalVerdict`), so it survives a restart that the
 * runtime-only `turnTerminalReason` does not. Every row below is written by that
 * REAL writer from `turnTerminalReason`, never spelled by hand.
 *
 * The Pi half (the parent model is told) is `pi-agent-server`'s
 * `subagent-tool.test.ts` and `spawner.test.ts`.
 */
import { describe, expect, test } from 'bun:test'
import { encodeSessionKey } from '@nessy-agent/shared/sessions/session-key'
import type { PiChildBudgetsV1, PiChildSessionRecordV1 } from '@nessy-agent/shared/agent/pi-harness/child-session-port'
import { createTestSessionManager } from './test-session-manager.ts'
import { createManagedSession, setSessionPlatform } from '../SessionManager.ts'
import { createHeadlessPlatform } from '../../runtime/platform-headless.ts'

const workspace = { id: 'workspace-f1225', name: 'F1.225', rootPath: process.cwd(), createdAt: 1 }
const parentKey = { workspaceId: workspace.id, sessionId: 'parent-f1225' }
const AGENT_ID = 'agent-f1225-capped'

function budgets(): PiChildBudgetsV1 {
  return {
    depth: 1, maxDepth: 2, fanout: 1, concurrency: 1,
    tokenLimit: 100_000, costLimitUsd: 100, deadlineAt: Date.now() + 60_000, ancestry: [],
  }
}

/** One child run as the chat loop leaves it: the prompt, the reply, and — when capped — the verdict row. */
function playRun(manager: any, child: any, prompt: string, reply: string, capped: boolean): void {
  child.messages.push({ id: `u-${child.messages.length}`, role: 'user', content: prompt, timestamp: Date.now() })
  child.messages.push({ id: `a-${child.messages.length}`, role: 'assistant', content: reply, timestamp: Date.now() })
  child.turnTerminalReason = capped ? 'max_agent_turns' : undefined
  // The production writer of the durable verdict (P2.98), from the reason the
  // `complete` event parked — the row this fix reads is never hand-written here.
  manager.persistTurnTerminalVerdict(child)
}

function rig() {
  setSessionPlatform(createHeadlessPlatform())
  const manager = createTestSessionManager() as any
  const child: any = createManagedSession(
    { id: `child-f1225-${Math.random().toString(36).slice(2)}`, name: 'Child', ephemeral: true },
    workspace as never,
    { messagesLoaded: true },
  )
  child.messages = []
  const childSessionKey = { workspaceId: workspace.id, sessionId: child.id }
  manager.sessions.set(encodeSessionKey(childSessionKey), child)
  manager.persistSession = () => {}
  manager.ensureMessagesLoaded = async () => {}
  return { manager, child, childSessionKey }
}

describe('F1.225 · a foreground child run that hit maxTurns is marked', () => {
  async function runOnce(capped: boolean, history?: (manager: any, child: any) => void) {
    const { manager, child, childSessionKey } = rig()
    history?.(manager, child)
    // The send resolves once the chat loop has ended the run — here, the run it played.
    manager.sendMessage = async () => { playRun(manager, child, 'survey the repo', 'looked at src/ and', capped) }
    try {
      return await manager.runPiChildTurn(parentKey, AGENT_ID, childSessionKey, 'survey the repo', budgets())
    } finally {
      await manager.cleanup()
    }
  }

  test('a capped run is completed, keeps its text, and carries turnLimitReached', async () => {
    const result = await runOnce(true)
    expect(result.status).toBe('completed')
    expect(result.output).toBe('looked at src/ and')
    expect(result.turnLimitReached).toBe(true)
  })

  test('CONTROL: an uncapped run carries no mark at all', async () => {
    const result = await runOnce(false)
    expect(result.status).toBe('completed')
    expect(result).not.toHaveProperty('turnLimitReached')
  })

  test('CONTROL: a PREVIOUS run\'s cap does not mark the run that followed it', async () => {
    const result = await runOnce(false, (manager, child) => playRun(manager, child, 'first pass', 'partial', true))
    expect(result).not.toHaveProperty('turnLimitReached')
  })
})

describe('F1.225 · a background child settled through monitor is marked in the result the spawner receives', () => {
  function backgroundRecord(childSessionId: string): PiChildSessionRecordV1 {
    return {
      schemaVersion: 1,
      agentId: AGENT_ID,
      parentSessionKey: parentKey,
      childSessionKey: { workspaceId: workspace.id, sessionId: childSessionId },
      agent: 'capped-surveyor',
      task: 'survey the repo',
      background: true,
      restrictions: { prompt: 'p', model: 'gateway-model', tools: ['read'], thinkingLevel: 'off', worktreePolicy: 'shared', maxTurns: 1 },
      budgets: budgets(),
      status: 'running',
      output: '',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
  }

  async function monitorSettled(capped: boolean) {
    const { manager, child } = rig()
    const parent: any = createManagedSession(
      { id: parentKey.sessionId, name: 'Parent', ephemeral: true },
      workspace as never,
      { messagesLoaded: true },
    )
    parent.childSessionState = { schemaVersion: 1, revision: 1, sealedOwnerTaskIds: [], children: [backgroundRecord(child.id)] }
    manager.sessions.set(encodeSessionKey(parentKey), parent)
    playRun(manager, child, 'survey the repo', 'looked at src/ and', capped)
    child.agent = null
    // The REAL service and the REAL `runtime.monitor` fallback, the run promise already evicted.
    const service = manager.getOrCreatePiChildSessionService(parent, {} as never)
    try {
      return await service.monitor(AGENT_ID)
    } finally {
      await manager.cleanup()
    }
  }

  test('a capped background child reaches the spawner completed and marked', async () => {
    const result = await monitorSettled(true)
    expect(result.status).toBe('completed')
    expect(result.output).toBe('looked at src/ and')
    expect(result.turnLimitReached).toBe(true)
  })

  test('CONTROL: an uncapped background child reaches it unmarked', async () => {
    const result = await monitorSettled(false)
    expect(result.status).toBe('completed')
    expect(result).not.toHaveProperty('turnLimitReached')
  })
})
