import { describe, expect, it } from 'bun:test'
import { RPC_CHANNELS } from '@nessy-agent/shared/protocol'
import type { HandlerFn, RequestContext, RpcServer } from '../../transport/types'
import type { HandlerDeps } from '../handler-deps'
import { registerSessionsHandlers } from './sessions'

describe('session custom slash command send boundary', () => {
  it('resolves the command server-side and sends only its label to renderer-visible history', async () => {
    const handlers = new Map<string, HandlerFn>()
    const calls: unknown[][] = []
    const models: unknown[][] = []
    const server = {
      handle: (channel: string, handler: HandlerFn) => handlers.set(channel, handler),
      push() {},
      async invokeClient() {},
      hasClientCapability: () => false,
      findClientsWithCapability: () => [],
    } as RpcServer
    const sessionManager = {
      waitForInit: async () => undefined,
      getSessions: () => [],
      resolveCustomSlashCommand: async () => ({
        id: 'custom:review',
        name: 'review',
        label: '/review',
        model: 'tgpt/reviewer',
        body: 'distinctive-server-only-body',
        path: '/private/project/.nessy-agent/commands/review.md',
        source: 'nessy-agent',
      }),
      updateSessionModel: async (...args: unknown[]) => { models.push(args) },
      sendMessage: async (...args: unknown[]) => {
        calls.push(args)
        const onAck = args[7] as ((messageId: string) => void) | undefined
        onAck?.('message-a')
      },
    } as unknown as HandlerDeps['sessionManager']
    registerSessionsHandlers(server, {
      sessionManager,
      platform: {
        logger: { info() {}, warn() {}, error() {}, debug() {} },
      },
      oauthFlowStore: {},
    } as unknown as HandlerDeps)

    const ctx: RequestContext = {
      clientId: 'client-a',
      workspaceId: 'workspace-a',
      webContentsId: null,
    }
    const result = await handlers.get(RPC_CHANNELS.sessions.SEND_MESSAGE)!(
      ctx,
      'session-a',
      'renderer-controlled-message',
      undefined,
      undefined,
      undefined,
      'custom:review',
    )

    expect(result).toEqual({ accepted: true, messageId: 'message-a' })
    expect(models).toEqual([['session-a', 'workspace-a', 'tgpt/reviewer']])
    // Visible message = namespaced label + the preserved invocation tail (args).
    expect(calls[0]?.[1]).toBe('/review renderer-controlled-message')
    // No literal $ARGUMENTS token in the body -> the model body is unchanged.
    expect(calls[0]?.[9]).toBe('distinctive-server-only-body')
    expect(JSON.stringify(calls[0]?.slice(0, 9))).not.toContain('distinctive-server-only-body')
    expect(JSON.stringify(calls)).not.toContain('/private/project')
  })

  it('expands the documented placeholder table in one pass; user arguments are never re-scanned', async () => {
    const handlers = new Map<string, HandlerFn>()
    const calls: unknown[][] = []
    const server = {
      handle: (channel: string, handler: HandlerFn) => handlers.set(channel, handler),
      push() {},
      async invokeClient() {},
      hasClientCapability: () => false,
      findClientsWithCapability: () => [],
    } as RpcServer
    const sessionManager = {
      waitForInit: async () => undefined,
      getSessions: () => [],
      resolveCustomSlashCommand: async () => ({
        id: 'custom:plugin:pk:summarize',
        name: 'summarize',
        label: '/linear-helper:summarize',
        body: 'Summarize: $ARGUMENTS\n\nLegacy: {{args}}\n\nKeep ${HOME} literal.',
        path: 'commands/summarize.md',
        source: 'plugin',
      }),
      updateSessionModel: async () => undefined,
      sendMessage: async (...args: unknown[]) => {
        calls.push(args)
        const onAck = args[7] as ((messageId: string) => void) | undefined
        onAck?.('message-b')
      },
    } as unknown as HandlerDeps['sessionManager']
    registerSessionsHandlers(server, {
      sessionManager,
      platform: {
        logger: { info() {}, warn() {}, error() {}, debug() {} },
      },
      oauthFlowStore: {},
    } as unknown as HandlerDeps)

    const ctx: RequestContext = {
      clientId: 'client-a',
      workspaceId: 'workspace-a',
      webContentsId: null,
    }

    await handlers.get(RPC_CHANNELS.sessions.SEND_MESSAGE)!(
      ctx, 'session-a', 'the $ARGUMENTS and {{args}} tokens', undefined, undefined, undefined, 'custom:plugin:pk:summarize',
    )
    expect(calls[0]?.[1]).toBe('/linear-helper:summarize the $ARGUMENTS and {{args}} tokens')
    expect(calls[0]?.[9]).toBe([
      'Summarize: the $ARGUMENTS and {{args}} tokens',
      '',
      'Legacy: the $ARGUMENTS and {{args}} tokens',
      '',
      'Keep ${HOME} literal.',
    ].join('\n'))

    await handlers.get(RPC_CHANNELS.sessions.SEND_MESSAGE)!(
      ctx, 'session-a', '', undefined, undefined, undefined, 'custom:plugin:pk:summarize',
    )
    expect(calls[1]?.[1]).toBe('/linear-helper:summarize')
    expect(calls[1]?.[9]).toBe('Summarize: \n\nLegacy: \n\nKeep ${HOME} literal.')
  })
})
