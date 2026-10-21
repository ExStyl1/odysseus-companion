import { afterEach, describe, expect, it, mock } from 'bun:test'
import { DEFAULT_MANAGED_PI_POLICY } from '@nessy-agent/shared/agent/pi-harness/managed-policy'
import { RPC_CHANNELS, type ShellCommandResult } from '@nessy-agent/shared/protocol'
import * as sharedConfig from '@nessy-agent/shared/config'
import type { HandlerDeps } from '../handler-deps'
import type { HandlerFn, RequestContext, RpcServer } from '../../transport/types'

// R37 (`settings-reference.md#respondtobashcommands`): `runShellCommand` branches on
// `getRespondToBashCommands()`. Stub the getter at module scope through a
// mutable holder — the established pattern of
// packages/shared/src/agent/__tests__/pi-agent-guardian-consult.test.ts:16 —
// spreading the real module so every other export keeps its implementation.
// The mock is installed BEFORE the manager module is imported — now through
// the test-manager helper — so its binding resolves to it.
const shellResponseSettings = { respondToBashCommands: true }
mock.module('@nessy-agent/shared/config', () => ({
  ...sharedConfig,
  getRespondToBashCommands: () => shellResponseSettings.respondToBashCommands,
}))

const { createTestSessionManager } = await import('../../sessions/__tests__/test-session-manager.ts')
const { registerSessionsHandlers } = await import('./sessions')

afterEach(() => {
  shellResponseSettings.respondToBashCommands = true
})

function createServerHarness(sessionManager: Partial<HandlerDeps['sessionManager']>) {
  const handlers = new Map<string, HandlerFn>()

  const server: RpcServer = {
    handle(channel, handler) {
      handlers.set(channel, handler)
    },
    push() {},
    async invokeClient() {},
    hasClientCapability() { return false },
    findClientsWithCapability() { return [] },
  }

  const deps: HandlerDeps = {
    sessionManager: {
      waitForInit: async () => {},
      getSessions: () => [],
      ...sessionManager,
    } as HandlerDeps['sessionManager'],
    platform: {
      appRootPath: '',
      resourcesPath: '',
      isPackaged: false,
      appVersion: '0.0.0-test',
      isDebugMode: true,
      logger: { info() {}, warn() {}, error() {}, debug() {} },
      imageProcessor: { getMetadata: async () => null, process: async () => Buffer.from('') },
    } as unknown as HandlerDeps['platform'],
    oauthFlowStore: {
      store() {}, getByState: () => null, remove() {}, cleanup() {}, dispose() {}, size: 0,
    } as unknown as HandlerDeps['oauthFlowStore'],
  }

  registerSessionsHandlers(server, deps)

  const ctx: RequestContext = { clientId: 'client-1', workspaceId: 'workspace-1', webContentsId: null }
  return { handlers, ctx }
}

function createManagerHarness(permissionMode = 'bypassPermissions') {
  const manager = createTestSessionManager() as any
  const events: Array<{ event: Record<string, unknown>; workspaceId: string }> = []
  const sendMessageCalls: unknown[][] = []
  const managed = {
    id: 'session-1',
    workspace: {
      id: 'workspace-1',
      name: 'Workspace',
      rootPath: '/tmp/nessy-shell-workspace',
    },
    agent: null,
    messages: [],
    isProcessing: false,
    lastMessageAt: 0,
    streamingText: '',
    processingGeneration: 0,
    isFlagged: false,
    permissionMode,
    enabledSourceSlugs: [],
    workingDirectory: '/tmp/nessy-shell-workspace',
    messagesLoaded: true,
    messageQueue: [],
  } as Record<string, unknown>

  let persisted = false
  let flushedSessionId: string | null = null
  let executedWith: { command: string; cwd: string } | null = null

  manager.sessions = new Map([[managed.id, managed]])
  // D4: the enforced policy is a GETTER now, so a harness seeds the field it
  // reads. Assigning `managedPiPolicy` would throw on the prototype accessor.
  manager.managedPiPolicyCurrent = DEFAULT_MANAGED_PI_POLICY
  manager.lastTimestamp = 0
  manager.ensureMessagesLoaded = async (session: Record<string, unknown>) => {
    session.messagesLoaded = true
  }
  manager.executeDirectShellCommand = async (command: string, cwd: string) => {
    executedWith = { command, cwd }
    return {
      executed: true,
      stdout: 'hello\n',
      stderr: '',
      exitCode: 0,
      signal: null,
      truncated: false,
    }
  }
  manager.persistSession = () => {
    persisted = true
  }
  manager.flushSession = async (sessionId: string) => {
    flushedSessionId = sessionId
  }
  manager.sendEvent = (event: Record<string, unknown>, workspaceId: string) => {
    events.push({ event, workspaceId })
  }
  // The respond-by-default branch dispatches the response turn through the
  // instance's sendMessage; the harness records the call instead of running a
  // real turn.
  manager.sendMessage = async (...args: unknown[]) => {
    sendMessageCalls.push(args)
  }

  return {
    manager,
    managed,
    events,
    sendMessageCalls,
    get persisted() { return persisted },
    get flushedSessionId() { return flushedSessionId },
    get executedWith() { return executedWith },
  }
}

describe('session runShellCommand command', () => {
  it('dispatches through the sessions command handler', async () => {
    const received: Array<{ sessionId: string; command: string }> = []
    const expected: ShellCommandResult = {
      success: true,
      executed: true,
      command: 'pwd',
      cwd: '/tmp/project',
      exitCode: 0,
      signal: null,
      stdout: '/tmp/project\n',
      stderr: '',
      output: '/tmp/project\n',
      messageId: 'message-1',
      truncated: false,
    }
    const { handlers, ctx } = createServerHarness({
      runShellCommand: async (sessionId, command) => {
        received.push({ sessionId, command })
        return expected
      },
    })

    const result = await handlers.get(RPC_CHANNELS.sessions.COMMAND)!(
      ctx,
      'session-1',
      { type: 'runShellCommand', command: 'pwd' },
    )

    expect(received).toEqual([{ sessionId: 'session-1', command: 'pwd' }])
    expect(result).toEqual(expected)
  })

  // Pre-R37 this exact shape — one command-badged message, one accepted
  // user_message event, and NO model turn — was the hardwired behaviour, and
  // this case pinned it as the default. `settings-reference.md#respondtobashcommands`
  // makes respond-by-default the contract — "By default, Claude Code adds the
  // command's output to the conversation and Claude replies to it", with
  // "**Default**: `true`" as its own bullet — so the old pin moved here under
  // the explicit `false` value: the documented
  // context-only branch (interactive-mode.md:321, pre-v2.1.186 behaviour).
  it('appends executed shell output without a response when respondToBashCommands is false', async () => {
    shellResponseSettings.respondToBashCommands = false
    const harness = createManagerHarness()

    const result = await harness.manager.runShellCommand('session-1', '  echo hello  ')
    const messages = harness.managed.messages as any[]

    expect(result.executed).toBe(true)
    expect(result.success).toBe(true)
    expect(result.command).toBe('echo hello')
    expect(result.stdout).toBe('hello\n')
    expect(harness.executedWith).toEqual({
      command: 'echo hello',
      cwd: '/tmp/nessy-shell-workspace',
    })
    expect(messages).toHaveLength(1)
    expect(messages[0]?.role).toBe('user')
    expect(messages[0]?.content).toContain('! echo hello')
    expect(messages[0]?.content).toContain('hello')
    expect(messages[0]?.badges).toEqual([{
      type: 'command',
      label: '!',
      rawText: '!',
      start: 0,
      end: 1,
    }])
    expect(harness.persisted).toBe(true)
    expect(harness.flushedSessionId).toBe('session-1')
    expect(harness.events[0]?.event).toMatchObject({
      type: 'user_message',
      sessionId: 'session-1',
      status: 'accepted',
    })
    // The false branch is context-only: no turn is dispatched.
    expect(harness.sendMessageCalls).toHaveLength(0)
  })

  it('dispatches a response turn on the existing transcript message by default', async () => {
    const harness = createManagerHarness()
    // The dispatched turn stays pending past the RPC return — runShellCommand
    // must not await it.
    let resolveTurn!: () => void
    const pendingTurn = new Promise<void>(resolve => { resolveTurn = resolve })
    harness.manager.sendMessage = (...args: unknown[]) => {
      harness.sendMessageCalls.push(args)
      return pendingTurn
    }

    const result = await harness.manager.runShellCommand('session-1', 'echo hello')
    const messages = harness.managed.messages as any[]

    expect(result.executed).toBe(true)
    // The transcript message is pushed exactly once; the turn adopts it.
    expect(messages).toHaveLength(1)
    expect(harness.sendMessageCalls).toHaveLength(1)
    const [sessionId, content, attachments, storedAttachments, options, existingMessageId, isAuthRetry, onAck, rpcContext]
      = harness.sendMessageCalls[0]!
    expect(sessionId).toBe('session-1')
    expect(content).toBe(messages[0]!.content)
    expect(attachments).toBeUndefined()
    expect(storedAttachments).toBeUndefined()
    expect(options).toEqual({ badges: messages[0]!.badges })
    expect(existingMessageId).toBe(messages[0]!.id)
    expect(existingMessageId).toBe(result.messageId)
    expect(isAuthRetry).toBeUndefined()
    expect(onAck).toBeUndefined()
    expect(rpcContext).toEqual({ workspaceId: 'workspace-1' })
    // Exactly one user_message event for the command: the accepted event from
    // runShellCommand. sendMessage's existingMessageId adoption must not
    // announce the same message a second time.
    const userMessageEvents = harness.events.filter(entry => entry.event.type === 'user_message')
    expect(userMessageEvents).toHaveLength(1)
    expect(userMessageEvents[0]!.event).toMatchObject({ status: 'accepted' })
    // Title derivation stays in runShellCommand (sendMessage only titles
    // messages it creates itself; the whole transcript would make a bad name).
    expect(harness.managed.name).toBe('! echo hello')
    resolveTurn()
  })

  it('returns the shell result even when the dispatched response turn fails', async () => {
    const harness = createManagerHarness()
    harness.manager.sendMessage = (...args: unknown[]) => {
      harness.sendMessageCalls.push(args)
      return Promise.reject(new Error('turn failed'))
    }

    const result = await harness.manager.runShellCommand('session-1', 'echo hello')

    expect(result.executed).toBe(true)
    expect(result.success).toBe(true)
    expect(harness.sendMessageCalls).toHaveLength(1)
    // Let the rejected turn promise settle — the .catch in runShellCommand
    // must swallow it (an unhandled rejection would fail this test file).
    await new Promise(resolve => setTimeout(resolve, 0))
  })

  it('blocks direct shell execution in plan mode (F1.1050: this arm drove the retired explore)', async () => {
    const harness = createManagerHarness('plan')
    harness.manager.executeDirectShellCommand = async () => {
      throw new Error('should not execute')
    }

    const result = await harness.manager.runShellCommand('session-1', 'ls')

    expect(result.executed).toBe(false)
    expect(result.blocked).toBe(true)
    expect(result.error).toContain('blocked in Plan mode')
    expect(harness.events).toHaveLength(0)
    // Blocked commands never respond, whatever respondToBashCommands says.
    expect(harness.sendMessageCalls).toHaveLength(0)
  })

  it('runs low-risk direct shell commands in auto mode without prompting', async () => {
    const harness = createManagerHarness('auto')
    harness.manager.requestDirectShellPermission = async () => {
      throw new Error('should not prompt')
    }

    const result = await harness.manager.runShellCommand('session-1', 'npm test')

    expect(result.executed).toBe(true)
    expect(harness.executedWith).toEqual({
      command: 'npm test',
      cwd: '/tmp/nessy-shell-workspace',
    })
  })

  it('prompts before risky direct shell commands in auto mode', async () => {
    const harness = createManagerHarness('auto')
    let promptCount = 0
    harness.manager.requestDirectShellPermission = async () => {
      promptCount += 1
      return false
    }
    harness.manager.executeDirectShellCommand = async () => {
      throw new Error('should not execute')
    }

    const result = await harness.manager.runShellCommand('session-1', 'rm -rf build')

    expect(promptCount).toBe(1)
    expect(result.executed).toBe(false)
    expect(result.blocked).toBe(true)
    expect(result.error).toBe('Shell command denied.')
    // A declined command has no output to respond to: the OFF shape is kept
    // under either setting.
    expect(harness.sendMessageCalls).toHaveLength(0)
  })
})
