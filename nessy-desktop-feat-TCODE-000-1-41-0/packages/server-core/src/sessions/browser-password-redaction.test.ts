/**
 * UB1.16 — copied from craft-agents-oss `v0.15.1:packages/server-core/src/sessions/browser-password-redaction.test.ts`
 * (Apache-2.0) and adapted onto OUR SessionManager divergences: the stored tool
 * message carries BOTH `toolInput` (the path-formatted projection) and
 * `rawToolInput` (the raw input, ours), so the harness seeds both and the arms
 * assert BOTH are redacted — the row's ADAPT (b).
 */
import { describe, expect, it } from 'bun:test'
import type { AgentEvent } from '@nessy-agent/core/types'
import type { SessionEvent } from '@nessy-agent/shared/protocol'
import { SessionManager, createManagedSession } from './SessionManager.ts'

type ManagedSession = ReturnType<typeof createManagedSession>
type EventHarness = {
  processEvent(managed: ManagedSession, event: AgentEvent): Promise<void>
  sendEvent(event: SessionEvent, workspaceId?: string): void
  persistSession(managed: ManagedSession): void
  monotonic(): number
}

/** The real tool_result handling, without agents, disk writes or the developer's config. */
function harness(toolInput: Record<string, unknown>, toolName = 'mcp__session__browser_tool') {
  const manager = Object.create(SessionManager.prototype) as unknown as EventHarness
  // Instance fields the processEvent head and the tool_result path read (ours, beyond upstream's).
  ;(manager as unknown as Record<string, unknown>).compactCommandTurns = new Map()
  const events: SessionEvent[] = []
  let persisted = 0
  manager.sendEvent = event => { events.push(event) }
  manager.persistSession = () => { persisted += 1 }
  manager.monotonic = () => Date.now()
  const managed = createManagedSession({ id: 'password-redaction' }, {
    id: 'workspace', name: 'Test', rootPath: '/unused-password-redaction', createdAt: Date.now(),
  } as never)
  managed.messages.push({
    id: 'tool-msg', role: 'tool', content: '', timestamp: 1,
    toolName, toolUseId: 'tu-1', toolInput, rawToolInput: toolInput, toolStatus: 'executing',
  } as never)
  const result = (text: string) => manager.processEvent(managed, { type: 'tool_result', toolUseId: 'tu-1', toolName, result: text, isError: false } as AgentEvent)
  return { managed, events, result, persisted: () => persisted }
}

/** How Claude stores an MCP tool result: its content blocks as pretty-printed JSON. */
const claudeResult = (text: string) => JSON.stringify([{ type: 'text', text }], null, 2)

const REDACTED = { command: 'fill @e1 user@example.com; fill @e2 [password: 7 characters]; click @e3' }

describe('browser_tool password fills in tool_result', () => {
  it('redacts the stored input (both projections), persists it and sends it to the renderer', async () => {
    const { managed, events, result, persisted } = harness({ command: 'fill @e1 user@example.com; fill @e2 hunter2; click @e3' })
    await result(claudeResult('Filled element @e1 with "user@example.com"\nFilled password field @e2 (7 characters)\nClicked element @e3'))

    expect(managed.messages[0]!.toolInput).toEqual(REDACTED)
    expect((managed.messages[0] as { rawToolInput?: unknown }).rawToolInput).toEqual(REDACTED)
    expect(managed.messages[0]!.toolStatus).toBe('completed')
    expect(JSON.stringify(managed.messages)).not.toContain('hunter2')
    expect(persisted()).toBe(1)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ type: 'tool_result', toolUseId: 'tu-1', toolInput: REDACTED })
  })

  it('redacts an array-mode input from a plain-text (Pi) result', async () => {
    const { managed, events, result } = harness({ command: ['fill', '@e2', 'hunter2'] }, 'browser_tool')
    await result('Filled password field @e2 (7 characters)\nActive element after: input')

    expect(managed.messages[0]!.toolInput).toEqual({ command: ['fill', '@e2', '[password: 7 characters]'] })
    expect(events[0]).toMatchObject({ toolInput: { command: ['fill', '@e2', '[password: 7 characters]'] } })
  })

  it('leaves other fills alone and sends no input', async () => {
    const input = { command: 'fill @e1 user@example.com' }
    const { managed, events, result } = harness(input)
    await result(claudeResult('Filled element @e1 with "user@example.com"'))

    expect(managed.messages[0]!.toolInput).toBe(input)
    expect(events).toHaveLength(1)
    expect(events[0]).not.toHaveProperty('toolInput')
  })

  it('does not touch other tools whose output mentions a password fill', async () => {
    const input = { command: 'fill @e2 notes.txt' }
    const { managed, events, result } = harness(input, 'Bash')
    await result('Filled password field @e2 (7 characters)')

    expect(managed.messages[0]!.toolInput).toBe(input)
    expect(events[0]).not.toHaveProperty('toolInput')
  })

  it('keeps the placeholder when the same result arrives twice', async () => {
    const { managed, events, result } = harness({ command: 'fill @e2 hunter2' })
    const text = claudeResult('Filled password field @e2 (7 characters)')
    await result(text)
    await result(text)

    expect(managed.messages[0]!.toolInput).toEqual({ command: 'fill @e2 [password: 7 characters]' })
    expect(events).toHaveLength(1)
  })
})
