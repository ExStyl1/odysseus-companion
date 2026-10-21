/**
 * F1.1257 (origin: the final CDP sitting SIT2-b, triage D-10, the F1.968 neighbour) — a disposed Claude runtime's
 * background-task chips leave the bar.
 *
 * Claude's chips are a REPLACE-semantics feed: `background_tasks_replaced` carries the CLI's whole live set (P6.109),
 * and nothing else ends an agent or workflow row the feed drew. When the host disposes the runtime (the idle reaper,
 * the ceiling, a runtime or plugin refresh, a teardown) the CLI takes its background tasks down with it —
 * interactive-mode.md#how-backgrounding-works: "Background tasks are automatically cleaned up when Claude Code exits" —
 * and sends no last feed, so four stale chips stayed. UA12.192 already retires the runtime-minted SHELLS
 * (`shell_killed`); this sends the empty set for the feed's rows. The renderer's rule for an empty set
 * (`reconcileReplacedBackgroundTasks`) holds the live agent rows for their end report and keeps every shell row —
 * pinned in `apps/electron/src/renderer/lib/__tests__/background-task-rows.test.ts`.
 *
 * Arms: a claude runtime disposed outside app exit sends `background_tasks_replaced` with `[]` (positive); the app's
 * own exit teardown sends nothing (the window is going), a codex or Pi runtime sends nothing (no such feed), and a
 * disposal that no longer owns the agent sends nothing (negatives / boundary).
 */
import { describe, expect, test } from 'bun:test'
import { encodeSessionKey } from '@nessy-agent/shared/sessions/session-key'

import { createTestSessionManager } from './test-session-manager.ts'

function fakeAgent(): Record<string, unknown> {
  return { dispose() {}, setAutomationSystem() {}, setCapabilityTurnRuntime() {}, drainAutomationEvents: async () => {} }
}

const RUNTIME = { claude: 'anthropic', codex: 'codex-runtime', pi: 'pi' } as const

function harness(provider: keyof typeof RUNTIME) {
  const agent = fakeAgent()
  const session = {
    id: `session-f1-1257-${provider}`,
    activeProvider: provider === 'pi' ? 'pi' : undefined,
    permissionMode: 'default',
    isProcessing: false,
    processingGeneration: 1,
    messages: [],
    messageQueue: [],
    backgroundShellCommands: new Map<string, string>(),
    workspace: { id: 'workspace-f1-1257', rootPath: process.cwd() },
    workingDirectory: process.cwd(),
    agent,
  }
  const manager = createTestSessionManager() as any
  manager.persistSession = () => undefined
  manager.emitPiHarnessInvalidation = () => undefined
  manager.resolveManagedProvider = () => RUNTIME[provider]
  manager.sessions.set(encodeSessionKey({ workspaceId: session.workspace.id, sessionId: session.id }), session)
  const replaced: unknown[] = []
  manager.sendEvent = (event: any) => { if (event?.type === 'background_tasks_replaced') replaced.push(event) }
  return { manager, session, agent, replaced }
}

describe('F1.1257 — a disposed claude runtime clears its background-task feed', () => {
  test('claude, outside app exit: one background_tasks_replaced with an empty set, for this session', async () => {
    const { manager, session, replaced } = harness('claude')
    await manager.disposeManagedAgentRuntime(session, 'idle-agent reaper').catch(() => undefined)
    expect(session.agent).toBeNull()
    expect(replaced).toEqual([{ type: 'background_tasks_replaced', sessionId: session.id, tasks: [] }])
  })

  test('NEGATIVE: the app-exit teardown sends nothing', async () => {
    const { manager, session, replaced } = harness('claude')
    await manager.disposeManagedAgentRuntime(session, 'session manager cleanup').catch(() => undefined)
    expect(session.agent).toBeNull()
    expect(replaced).toEqual([])
  })

  for (const provider of ['codex', 'pi'] as const) {
    test(`NEGATIVE: a ${provider} runtime has no such feed and sends nothing`, async () => {
      const { manager, session, replaced } = harness(provider)
      await manager.disposeManagedAgentRuntime(session, 'idle-agent reaper').catch(() => undefined)
      expect(replaced).toEqual([])
    })
  }

  test('BOUNDARY: a disposal that no longer owns the agent sends nothing', async () => {
    const { manager, session, agent, replaced } = harness('claude')
    session.agent = fakeAgent()
    await manager.disposeManagedAgentRuntime(session, 'idle-agent reaper', false, agent).catch(() => undefined)
    expect(replaced).toEqual([])
  })
})
