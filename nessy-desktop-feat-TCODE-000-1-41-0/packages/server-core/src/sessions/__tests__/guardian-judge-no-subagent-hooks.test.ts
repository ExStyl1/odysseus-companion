/**
 * F1.1038 (controller decision 2026-09-28 under the owner-delegated rule,
 * DECISIONS-2 Q2) — a host consult fires none of the parent's `SubagentStart` /
 * `SubagentStop` hooks.
 *
 * ## The door (DN-127's finding)
 *
 * `ChildSessionService.start` calls `beforeStart` — the host's
 * `executePiChildStartAutomation` — for every child record, Guardian judge
 * records included, and a `SubagentStart` hook's `additionalContext` is
 * prepended to the child's TASK (`${additionalContext}\n\n${task}`). So a
 * plugin's `SubagentStart` hook could put its own words in front of the judge's
 * input — the class F1.876/F1.889 closed for skills and MCP and F1.941 for the
 * judge's own hooks — and the parent's `SubagentStart` and `SubagentStop` hooks
 * ran once per judge lookup.
 *
 * ## The decision's basis
 *
 * Claude's own permission classifier is not a subagent and fires no subagent
 * hooks. (Codex's generated `HookEventName` does list `subagentStart` and
 * `subagentStop`, so that half of the decision's basis does not hold; whether
 * codex fires them for its own guardian reviewer was not read.) A judge is the
 * host consulting a model, not the user's agent delegating work.
 *
 * ## The rig
 *
 * The REAL `executePiChildStartAutomation` / `executePiChildTerminalAutomation`
 * on a real `SessionManager`, the parent's automation system a recording double
 * whose `SubagentStart` answers `additionalContext` — the instrument is which
 * events reached it and what the start hook handed back for the task.
 */
import { describe, expect, it, setDefaultTimeout } from 'bun:test'
import { GUARDIAN_POLICY_PROMPT } from '@nessy-agent/shared/prompts/guardian'
import { encodeSessionKey } from '@nessy-agent/shared/sessions/session-key'
import { createTestSessionManager } from './test-session-manager.ts'

// The SessionManager module graph dominates this file's wall time; the bodies are milliseconds.
setDefaultTimeout(120_000)

const WORKSPACE = 'workspace-f1038'
const judgeRestrictions = { prompt: `${GUARDIAN_POLICY_PROMPT}\n\nJudge this.`, model: 'gateway-fast', tools: ['read', 'grep', 'find', 'ls'], worktreePolicy: 'shared', thinkingLevel: 'off', permissionMode: 'plan', skillKeys: [], mcpServerKeys: [] }
const subagentRestrictions = { prompt: 'You are scout, a read-only explorer.', model: 'gateway-fast', tools: ['read', 'grep', 'find', 'ls'], worktreePolicy: 'shared', thinkingLevel: 'off' }

function record(agentId: string, restrictions: Record<string, unknown>) {
  return {
    agentId, agent: 'scout', task: 'Judge the following planned action', background: false, status: 'completed', result: 'allow',
    childSessionKey: { workspaceId: WORKSPACE, sessionId: `${agentId}-session` }, restrictions,
  }
}

function session(id: string, extra: Record<string, unknown> = {}) {
  return { id, workspace: { id: WORKSPACE, rootPath: process.cwd() }, messages: [], messagesLoaded: true, backgroundShellCommands: new Map(), ...extra }
}

/** Drive one child's start and terminal automation from `parent`; report what the parent's hooks saw. */
async function drive(parent: any, child: any, register: any[] = []) {
  const manager = createTestSessionManager() as any
  const events: string[] = []
  const feedback: string[] = []
  parent.agentAutomationSystem = {
    async executeAgentEvent(event: string) {
      events.push(event)
      return event === 'SubagentStart'
        ? { matchedCount: 1, decision: { type: 'decision', additionalContext: 'f1038-plugin-words' } }
        : { matchedCount: 1 }
    },
  }
  parent.agent = { recordHookBlockFeedback: (event: string) => { feedback.push(event) } }
  for (const other of [parent, ...register]) {
    manager.sessions.set(encodeSessionKey({ workspaceId: WORKSPACE, sessionId: other.id }), other)
  }
  try {
    const started = await manager.executePiChildStartAutomation(parent, child)
    await manager.executePiChildTerminalAutomation(parent, 'SubagentStop', child)
    return { events, feedback, started }
  } finally {
    manager.sessions.clear()
    await manager.cleanup()
  }
}

describe('F1.1038 — a host consult fires no SubagentStart or SubagentStop hook', () => {
  it('CONTROL: an ordinary subagent child fires the parent\'s SubagentStart (its text reaches the task) and SubagentStop', async () => {
    const run = await drive(session('parent'), record('scout-1', subagentRestrictions))

    expect(run.events).toEqual(['SubagentStart', 'SubagentStop'])
    expect(run.started).toEqual({ additionalContext: 'f1038-plugin-words' })
    expect(run.feedback).toEqual(['SubagentStop'])
  })

  it('a Guardian judge child fires neither, hands no text to its task, and leaves the parent\'s SubagentStop streak alone', async () => {
    const run = await drive(session('parent'), record('judge-1', judgeRestrictions))

    expect(run.events).toEqual([])
    expect(run.started).toBeUndefined()
    expect(run.feedback).toEqual([])
  })

  it('a session BENEATH a judge (the judge is its parent) fires neither of the judge\'s subagent hooks', async () => {
    const judge = session('judge-session', {
      piChildRestrictions: judgeRestrictions,
      piParentSessionKey: { workspaceId: WORKSPACE, sessionId: 'parent' },
    })
    const run = await drive(judge, record('beneath-1', subagentRestrictions), [session('parent')])

    expect(run.events).toEqual([])
    expect(run.started).toBeUndefined()
    expect(run.feedback).toEqual([])
  })
})
