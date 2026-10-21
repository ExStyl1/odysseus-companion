/**
 * R27c Task 3 — `SubagentStop` carries the PARENT session's registry.
 *
 * `hooks.md:2046` — "SubagentStop hooks also receive the `background_tasks` and
 * `session_crons` arrays described under Stop input … Both arrays are scoped to
 * the parent session, not the subagent."
 *
 * This drives the real emission site rather than the projection under it,
 * because the failure mode is entirely about WHICH session the call site hands
 * over: a child's registry is empty, so getting it backwards produces a
 * well-formed payload that tells the hook "nothing is in flight" at the exact
 * moment the parent is still waiting on siblings.
 */

import { describe, expect, test } from 'bun:test'
import type { SdkAutomationInput } from '@nessy-agent/shared/automations'
import { encodeSessionKey } from '@nessy-agent/shared/sessions/session-key'
import { createTestSessionManager } from './test-session-manager.ts'

const WORKSPACE = 'workspace-subagent-scope'

function childRecord(overrides: Record<string, unknown> = {}): any {
  return {
    schemaVersion: 1,
    agentId: 'agent-child',
    parentSessionKey: { workspaceId: WORKSPACE, sessionId: 'parent' },
    childSessionKey: { workspaceId: WORKSPACE, sessionId: 'child' },
    agent: 'Explore',
    task: 'audit the adapters',
    background: false,
    restrictions: { prompt: 'p', model: 'm', tools: ['read'], worktreePolicy: 'shared', thinkingLevel: 'off' },
    budgets: { depth: 1, maxDepth: 2, fanout: 2, concurrency: 1, tokenLimit: 100, costLimitUsd: 1, deadlineAt: Date.now() + 1000, ancestry: [] },
    status: 'completed',
    output: '',
    ...overrides,
  }
}

describe('SubagentStop registry scoping (hooks.md :2046)', () => {
  test("reports the parent's background_tasks and session_crons, not the subagent's", async () => {
    const manager = createTestSessionManager()
    const inputs: SdkAutomationInput[] = []

    // The parent is mid-flight on a sibling subagent and a background shell,
    // and holds a scheduled cron. The child has none of that.
    const parent: any = {
      id: 'parent',
      workspace: { id: WORKSPACE, rootPath: process.cwd() },
      permissionMode: 'ask',
      thinkingLevel: 'off',
      llmConnection: 'pi',
      messagesLoaded: true,
      backgroundShellCommands: new Map([['process_parent_shell', 'process_parent_shell']]),
      backgroundTaskOutputs: new Map(),
      piBackgroundTaskKinds: new Map([['task_parent_wf', 'workflow']]),
      childSessionState: {
        schemaVersion: 1,
        revision: 1,
        sealedOwnerTaskIds: [],
        children: [
          // The sibling still running — this is what the parent is waiting on.
          { agentId: 'agent-sibling', agent: 'Plan', task: 'draft the plan', status: 'running' },
          // The child that just stopped is already terminal when SubagentStop
          // fires (`emitTerminalOnce` commits the status before observing), so
          // it must NOT appear as in-flight in its own stop payload.
          childRecord(),
        ],
      },
      agentAutomationSystem: {
        async executeAgentEvent(_event: string, input: SdkAutomationInput) {
          inputs.push(input)
          return { matchedCount: 1 }
        },
      },
    }
    const child: any = {
      id: 'child',
      workspace: { id: WORKSPACE, rootPath: process.cwd() },
      messagesLoaded: true,
      backgroundShellCommands: new Map(),
      backgroundTaskOutputs: new Map(),
      childSessionState: undefined,
    }
    ;(manager as any).sessions.set(encodeSessionKey({ workspaceId: WORKSPACE, sessionId: 'parent' }), parent)
    ;(manager as any).sessions.set(encodeSessionKey({ workspaceId: WORKSPACE, sessionId: 'child' }), child)

    // A cron on the PARENT's key only.
    ;(manager as any).sessionCronServices.set(
      encodeSessionKey({ workspaceId: WORKSPACE, sessionId: 'parent' }),
      {
        list: () => [{ id: 'parentcr', schedule: '0 9 * * 1-5', recurring: true, prompt: 'check the build' }],
        stop: () => {},
      },
    )

    await (manager as any).executePiChildTerminalAutomation(parent, 'SubagentStop', childRecord())

    expect(inputs).toHaveLength(1)
    const input = inputs[0]!
    expect(input.hook_event_name).toBe('SubagentStop')
    expect(input.agent_id).toBe('agent-child')
    expect(input.agent_type).toBe('Explore')

    // The parent's in-flight work, including its still-running sibling.
    expect(input.background_tasks?.map(entry => entry.id).sort())
      .toEqual(['agent-sibling', 'process_parent_shell', 'task_parent_wf'])
    expect(input.background_tasks?.find(entry => entry.id === 'agent-sibling'))
      .toEqual({ id: 'agent-sibling', type: 'subagent', status: 'running', description: 'draft the plan', agent_type: 'Plan' })
    // The subagent that just stopped is terminal, so it is not reported as
    // in-flight in its own stop payload.
    expect(input.background_tasks?.some(entry => entry.id === 'agent-child')).toBe(false)

    // The parent's cron, which the child's (absent) service could never supply.
    expect(input.session_crons).toEqual([
      { id: 'parentcr', schedule: '0 9 * * 1-5', recurring: true, prompt: 'check the build' },
    ])

    // The child's own registry is empty in both arrays: had the call site
    // passed the child, every assertion above would read `[]`.
    const childPort = (manager as any).buildHookTaskRegistryPort(child)
    expect(childPort.backgroundTasks()).toEqual([])
    expect(childPort.sessionCrons()).toEqual([])

    ;(manager as any).sessions.clear()
    await manager.cleanup()
  })

  test('emits both arrays as present and empty when the parent has nothing in flight', async () => {
    const manager = createTestSessionManager()
    const inputs: SdkAutomationInput[] = []
    const parent: any = {
      id: 'parent-idle',
      workspace: { id: WORKSPACE, rootPath: process.cwd() },
      permissionMode: 'ask',
      thinkingLevel: 'off',
      llmConnection: 'pi',
      messagesLoaded: true,
      backgroundShellCommands: new Map(),
      backgroundTaskOutputs: new Map(),
      childSessionState: undefined,
      agentAutomationSystem: {
        async executeAgentEvent(_event: string, input: SdkAutomationInput) {
          inputs.push(input)
          return { matchedCount: 1 }
        },
      },
    }
    ;(manager as any).sessions.set(encodeSessionKey({ workspaceId: WORKSPACE, sessionId: 'parent-idle' }), parent)

    await (manager as any).executePiChildTerminalAutomation(parent, 'SubagentStop', childRecord())

    // `:2194` — present and empty, never absent. An "only include when
    // non-empty" implementation fails exactly here.
    expect(inputs[0]?.background_tasks).toEqual([])
    expect(inputs[0]?.session_crons).toEqual([])
    expect(Object.keys(inputs[0] ?? {})).toContain('background_tasks')
    expect(Object.keys(inputs[0] ?? {})).toContain('session_crons')

    ;(manager as any).sessions.clear()
    await manager.cleanup()
  })
})

/**
 * R27 reopened — `SubagentStop` carries all five of its documented fields.
 *
 * `hooks.md:2048`, whole line: "In addition to the common input fields,
 * SubagentStop hooks receive `stop_hook_active`, `agent_id`, `agent_type`,
 * `agent_transcript_path`, and `last_assistant_message`. The `agent_type` field
 * is the value used for matcher filtering. The `transcript_path` is the main
 * session's transcript, while `agent_transcript_path` is the subagent's own
 * transcript stored in a nested `subagents/` folder. The `last_assistant_message`
 * field contains the text content of the subagent's final response, so hooks can
 * access it without parsing the transcript file."
 *
 * The emission site supplied two of the five.
 */
describe('SubagentStop documented payload (hooks.md :2048)', () => {
  function parentSession(inputs: SdkAutomationInput[], agent?: unknown): any {
    return {
      id: 'parent',
      workspace: { id: WORKSPACE, rootPath: process.cwd() },
      permissionMode: 'ask',
      messagesLoaded: true,
      backgroundShellCommands: new Map(),
      backgroundTaskOutputs: new Map(),
      childSessionState: undefined,
      ...(agent ? { agent } : {}),
      agentAutomationSystem: {
        async executeAgentEvent(_event: string, input: SdkAutomationInput) {
          inputs.push(input)
          return { matchedCount: 1 }
        },
      },
    }
  }

  test('supplies agent_transcript_path, last_assistant_message and stop_hook_active', async () => {
    const manager = createTestSessionManager()
    const inputs: SdkAutomationInput[] = []
    // The streak the field reads is the SAME one `recordHookBlockFeedback`
    // maintains, so a stub that reports a live SubagentStop streak is exactly
    // the "already continuing as a result of a stop hook" state.
    const blocks: unknown[] = []
    const parent = parentSession(inputs, {
      stopHookActive: (event: string) => event === 'SubagentStop',
      recordHookBlockFeedback: (event: string, result: unknown) => { blocks.push([event, result]) },
    })
    ;(manager as any).sessions.set(encodeSessionKey({ workspaceId: WORKSPACE, sessionId: 'parent' }), parent)

    await (manager as any).executePiChildTerminalAutomation(parent, 'SubagentStop', childRecord({
      result: 'Analysis complete. Found 3 potential issues.',
      output: 'streamed text',
    }))

    const input = inputs[0]!
    expect(input.agent_id).toBe('agent-child')
    expect(input.agent_type).toBe('Explore')
    expect(input.stop_hook_active).toBe(true)
    expect(input.last_assistant_message).toBe('Analysis complete. Found 3 potential issues.')
    // The subagent's OWN transcript, not the parent's: the child session key.
    expect(input.agent_transcript_path).toContain('child')
    expect(input.agent_transcript_path).toEndWith('session.jsonl')
    expect(blocks).toHaveLength(1)

    ;(manager as any).sessions.clear()
    await manager.cleanup()
  })

  test('stop_hook_active is false with no live streak, and reads the streak the agent keeps', async () => {
    const manager = createTestSessionManager()
    const inputs: SdkAutomationInput[] = []
    const asked: string[] = []
    const parent = parentSession(inputs, {
      stopHookActive: (event: string) => { asked.push(event); return false },
      recordHookBlockFeedback: () => {},
    })
    ;(manager as any).sessions.set(encodeSessionKey({ workspaceId: WORKSPACE, sessionId: 'parent' }), parent)

    await (manager as any).executePiChildTerminalAutomation(parent, 'SubagentStop', childRecord())

    expect(asked).toEqual(['SubagentStop'])
    expect(inputs[0]?.stop_hook_active).toBe(false)
    // Present, not absent: the doc's example carries `false` explicitly.
    expect(Object.keys(inputs[0] ?? {})).toContain('stop_hook_active')

    ;(manager as any).sessions.clear()
    await manager.cleanup()
  })

  test('last_assistant_message falls back to partial output, and is absent when there is none', async () => {
    const manager = createTestSessionManager()
    const inputs: SdkAutomationInput[] = []
    const parent = parentSession(inputs)
    ;(manager as any).sessions.set(encodeSessionKey({ workspaceId: WORKSPACE, sessionId: 'parent' }), parent)

    // An interrupted child has no `result`, only the assistant text it managed
    // to emit before the deadline.
    await (manager as any).executePiChildTerminalAutomation(parent, 'SubagentStop', childRecord({
      status: 'interrupted', output: 'half an answer',
    }))
    expect(inputs[0]?.last_assistant_message).toBe('half an answer')

    // Nothing at all: absent, not empty — there is no final response for the
    // field to "contain the text content of".
    await (manager as any).executePiChildTerminalAutomation(parent, 'SubagentStop', childRecord({
      status: 'failed', output: '', error: 'boom',
    }))
    expect(Object.keys(inputs[1] ?? {})).not.toContain('last_assistant_message')

    ;(manager as any).sessions.clear()
    await manager.cleanup()
  })
})
