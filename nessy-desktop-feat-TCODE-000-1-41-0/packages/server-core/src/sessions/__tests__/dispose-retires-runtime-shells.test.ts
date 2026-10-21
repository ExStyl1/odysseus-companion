/**
 * UA12.192 — a background shell a RUNTIME minted (a Claude SDK task id, a codex app-server terminal id) leaves
 * `backgroundShellCommands` when that runtime is disposed.
 *
 * Since UA12.192 a Claude background Bash joins the map (v0.14.0's `local_bash` arm → `shell_backgrounded`). The CLI
 * takes it down with itself — interactive-mode.md#how-backgrounding-works: "Background tasks are automatically cleaned
 * up when Claude Code exits" — and so does codex's app-server (codex-agent.ts `backgroundWorkCount`: a dispose "kills
 * the app-server, the terminal and its output"). But the map entry stayed: the busy predicate latched, and every
 * strict drain (runtime switch, rewind, deletion, project mutation) ran `killShell` on it AFTER the dispose, where
 * no backend lever is left and the Pi store refuses a non-Pi handle — `session-shell-drain-failed`.
 *
 * Arms: the runtime-minted entry is retired with a `shell_killed` (positive); a Pi supervisor handle stays — the
 * supervisor's own records and L7's reconciliation own it (negative); a Pi session's disposal retires nothing, whatever
 * a handle's shape (negative); and a disposal that no longer owns the agent (a newer runtime already published)
 * retires nothing (boundary).
 */
import { describe, expect, test } from 'bun:test'
import { encodeSessionKey } from '@nessy-agent/shared/sessions/session-key'

import { createTestSessionManager } from './test-session-manager.ts'

const PI_HANDLE = `process_${'a1'.repeat(16)}`
const CLAUDE_TASK = 'b7k2x9q1'
const CODEX_TERMINAL = '4242'

function fakeAgent(): Record<string, unknown> {
  return { dispose() {}, setAutomationSystem() {}, setCapabilityTurnRuntime() {}, drainAutomationEvents: async () => {} }
}

/** The session's configured runtime, as `resolveManagedProvider` reports it (ModelProvider values). */
const RUNTIME = { claude: 'anthropic', codex: 'codex-runtime', pi: 'pi' } as const

function harness(provider: keyof typeof RUNTIME) {
  const agent = fakeAgent()
  const session = {
    id: `session-ua12-192-${provider}`,
    activeProvider: provider === 'pi' ? 'pi' : undefined,
    permissionMode: 'default',
    isProcessing: false,
    processingGeneration: 1,
    messages: [],
    messageQueue: [],
    backgroundShellCommands: new Map<string, string>([
      [provider === 'codex' ? CODEX_TERMINAL : CLAUDE_TASK, 'sleep 120'],
      [PI_HANDLE, 'npm run dev'],
    ]),
    workspace: { id: 'workspace-ua12-192', rootPath: process.cwd() },
    workingDirectory: process.cwd(),
    agent,
  }
  const manager = createTestSessionManager() as any
  manager.persistSession = () => undefined
  manager.emitPiHarnessInvalidation = () => undefined
  manager.resolveManagedProvider = () => RUNTIME[provider]
  manager.sessions.set(encodeSessionKey({ workspaceId: session.workspace.id, sessionId: session.id }), session)
  const killed: string[] = []
  manager.sendEvent = (event: any) => { if (event?.type === 'shell_killed') killed.push(event.shellId) }
  return { manager, session, agent, killed }
}

describe('UA12.192 — a disposed runtime takes the shells it minted out of the session\'s map', () => {
  for (const provider of ['claude', 'codex'] as const) {
    test(`${provider}: the runtime's own shell is retired with shell_killed; the Pi handle stays`, async () => {
      const { manager, session, killed } = harness(provider)
      const minted = provider === 'codex' ? CODEX_TERMINAL : CLAUDE_TASK
      await manager.disposeManagedAgentRuntime(session, 'idle-agent reaper').catch(() => undefined)
      expect(session.agent).toBeNull()
      expect([...session.backgroundShellCommands.keys()]).toEqual([PI_HANDLE])
      expect(killed).toEqual([minted])
    })
  }

  test('NEGATIVE: a Pi runtime\'s disposal retires nothing — every shell of a Pi session is the supervisor\'s', async () => {
    const { manager, session, killed } = harness('pi')
    await manager.disposeManagedAgentRuntime(session, 'idle-agent reaper').catch(() => undefined)
    expect(session.agent).toBeNull()
    expect([...session.backgroundShellCommands.keys()].sort()).toEqual([CLAUDE_TASK, PI_HANDLE].sort())
    expect(killed).toEqual([])
  })

  test('BOUNDARY: a disposal that no longer owns the agent (a newer runtime published) retires nothing', async () => {
    const { manager, session, agent, killed } = harness('claude')
    const newer = fakeAgent()
    // `expectedAgent` names the old runtime while the session already holds a newer one: the disposal is a no-op.
    session.agent = newer
    await manager.disposeManagedAgentRuntime(session, 'idle-agent reaper', false, agent).catch(() => undefined)
    expect(session.agent).toBe(newer)
    expect([...session.backgroundShellCommands.keys()].sort()).toEqual([CLAUDE_TASK, PI_HANDLE].sort())
    expect(killed).toEqual([])
  })
})
