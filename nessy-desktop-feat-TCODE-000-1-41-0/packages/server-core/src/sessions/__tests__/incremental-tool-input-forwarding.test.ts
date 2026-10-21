/**
 * P6.581 — every incremental tool-input frame reaches the renderer.
 *
 * P6.158 taught both adapters to read the runtimes' own incremental tool-input
 * frames, so a `tool_start` for one `toolUseId` now arrives SEVERAL times with
 * a growing input. The forwarding gate in `SessionManager.processEvent` still
 * read "did this row have input before", which is true from frame 2 onward —
 * so the stored message grew and the live card the user watches did not.
 *
 * Driven through the shipped `processEvent` switch with a `sendEvent` spy, on
 * the same harness `raw-tool-io-persistence.test.ts` uses, so a fixture cannot
 * keep a broken gate green.
 */
import { describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentEvent } from '@nessy-agent/shared/agent'
import { encodeSessionKey } from '@nessy-agent/shared/sessions/session-key'
import { createTestSessionManager } from './test-session-manager.ts'

const sessionKey = { workspaceId: 'workspace-partial-input', sessionId: 'session-partial-input' }

function harness() {
  const manager = createTestSessionManager()
  const internals = manager as unknown as {
    sessions: Map<string, unknown>
    processEvent(managed: unknown, event: AgentEvent): Promise<void>
    sendEvent(event: unknown, workspaceId: string): void
    persistSession(managed: unknown, immediate?: boolean): void
    flushSession(sessionId: string, workspaceId?: string): Promise<void>
  }
  const managed: Record<string, unknown> = {
    id: sessionKey.sessionId,
    workspace: { id: sessionKey.workspaceId, rootPath: mkdtempSync(join(tmpdir(), 'nessy-partial-input-test-')) },
    workingDirectory: '/Users/partial-input-fixture/project',
    llmConnection: 'pi',
    messagesLoaded: true,
    messages: [],
    backgroundShellCommands: new Map(),
    backgroundTaskOutputs: new Map(),
    piBackgroundTaskKinds: new Map(),
    agent: { isProcessing: () => true },
  }
  internals.sessions.set(encodeSessionKey(sessionKey), managed)
  const sent: Record<string, unknown>[] = []
  internals.sendEvent = event => {
    sent.push(event as Record<string, unknown>)
  }
  internals.persistSession = () => undefined
  internals.flushSession = async () => undefined

  const feed = async (...events: AgentEvent[]) => {
    for (const event of events) await internals.processEvent(managed, event)
  }
  const toolStartsSent = () => sent.filter(event => event.type === 'tool_start')
  return { managed, feed, toolStartsSent }
}

describe('incremental tool input forwarding (P6.581)', () => {
  test('the THIRD incremental frame reaches the renderer, not only the first', async () => {
    const h = harness()

    await h.feed(
      // Frame 0 — the empty stream_event start that creates the row.
      { type: 'tool_start', toolName: 'Write', toolUseId: 'tu-grow', input: {} },
      // Frames 1..3 — the growing partial views P6.158 now emits.
      { type: 'tool_start', toolName: 'Write', toolUseId: 'tu-grow', input: { content: 'a' } },
      { type: 'tool_start', toolName: 'Write', toolUseId: 'tu-grow', input: { content: 'ab' } },
      { type: 'tool_start', toolName: 'Write', toolUseId: 'tu-grow', input: { content: 'abc' } },
    )

    const sent = h.toolStartsSent()
    // One create + three growth updates. The pre-fix gate sent two.
    expect(sent).toHaveLength(4)
    expect(sent.at(-1)!.toolInput).toEqual({ content: 'abc' })
  })

  test('an UNCHANGED repeat of the same complete input sends nothing extra', async () => {
    const h = harness()

    await h.feed(
      { type: 'tool_start', toolName: 'Read', toolUseId: 'tu-same', input: {} },
      { type: 'tool_start', toolName: 'Read', toolUseId: 'tu-same', input: { file_path: '/tmp/x.ts' } },
      // The SDK's dual-event shape can re-deliver the identical complete input.
      { type: 'tool_start', toolName: 'Read', toolUseId: 'tu-same', input: { file_path: '/tmp/x.ts' } },
    )

    expect(h.toolStartsSent()).toHaveLength(2)
  })
})
