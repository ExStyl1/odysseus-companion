import { describe, expect, test } from 'bun:test'
import { RPC_CHANNELS } from '@nessy-agent/shared/protocol'
import type { WorkspaceInfo } from '@nessy-agent/core/types'
import type { WorkspaceService } from '@nessy-agent/shared/workspaces'
import type { RpcServer, HandlerFn } from '../../../transport/types'
import type { HandlerDeps } from '../../handler-deps'
import { registerWorkspaceCoreHandlers } from '../workspace'

function safeWorkspace(overrides: Partial<WorkspaceInfo> = {}): WorkspaceInfo {
  return {
    id: 'workspace-local',
    name: 'Local Workspace',
    iconUrl: 'workspace-icon://workspace-local',
    ...overrides,
  }
}

function harness(
  service: WorkspaceService,
  sessionManager: Partial<HandlerDeps['sessionManager']> = {},
) {
  const handlers = new Map<string, HandlerFn>()
  const server = {
    handle: (channel: string, handler: HandlerFn) => handlers.set(channel, handler),
    push: () => {},
    invokeClient: async () => undefined,
    hasClientCapability: () => false,
    findClientsWithCapability: () => [],
  } as RpcServer
  registerWorkspaceCoreHandlers(server, {
    workspaceService: service,
    sessionManager: sessionManager as HandlerDeps['sessionManager'],
    platform: {} as HandlerDeps['platform'],
    oauthFlowStore: {} as HandlerDeps['oauthFlowStore'],
  })
  const invoke = (channel: string, ...args: unknown[]) => {
    const handler = handlers.get(channel)
    if (!handler) throw new Error(`missing handler ${channel}`)
    return handler({ clientId: 'client', workspaceId: 'workspace-local', webContentsId: null }, ...args)
  }
  return { invoke }
}

describe('Workspace RPC contract', () => {
  test('accepts only a name for local creation and returns a safe DTO', async () => {
    let createInput: unknown
    const service = {
      create: async (input: unknown) => {
        createInput = input
        return safeWorkspace()
      },
    } as unknown as WorkspaceService
    const { invoke } = harness(service)

    const result = await invoke(RPC_CHANNELS.workspaces.CREATE, 'Local Workspace')

    expect(createInput).toEqual({ name: 'Local Workspace' })
    const json = JSON.stringify(result)
    expect(json).not.toContain('rootPath')
    expect(json).not.toContain('token')
  })

  test('uses dedicated remote binding actions without returning credentials', async () => {
    const calls: Array<[string, unknown]> = []
    const remote = safeWorkspace({
      id: 'workspace-remote',
      name: 'Remote Workspace',
      remoteServer: { url: 'wss://remote.example/rpc', remoteWorkspaceId: 'remote-id' },
      hasCredential: true,
    })
    const service = {
      connectRemoteWorkspace: async (input: unknown) => { calls.push(['connect', input]); return remote },
      updateRemoteWorkspace: async (input: unknown) => { calls.push(['update', input]); return remote },
      createWorkspaceOnRemote: async (input: unknown) => { calls.push(['create', input]); return remote },
    } as unknown as WorkspaceService
    const { invoke } = harness(service)

    const secret = 'distinctive-remote-secret'
    const connected = await invoke(RPC_CHANNELS.workspaces.CONNECT_REMOTE, {
      name: 'Remote Workspace', url: 'wss://remote.example/rpc', token: secret, remoteWorkspaceId: 'remote-id',
    })
    await invoke(RPC_CHANNELS.workspaces.UPDATE_REMOTE, {
      workspaceId: 'workspace-remote', url: 'wss://remote.example/rpc', remoteWorkspaceId: 'remote-id',
    })
    await invoke(RPC_CHANNELS.workspaces.CREATE_ON_REMOTE, {
      name: 'Remote Workspace', url: 'wss://remote.example/rpc', token: secret,
    })

    expect(calls.map(([kind]) => kind)).toEqual(['connect', 'update', 'create'])
    const json = JSON.stringify(connected)
    expect(json).not.toContain(secret)
    expect(json).not.toContain('rootPath')
    expect(json).toContain('"hasCredential":true')
  })

  test('lists custom commands by authenticated SessionKey without accepting a project path', async () => {
    const calls: unknown[] = []
    const { invoke } = harness({} as WorkspaceService, {
      listCustomSlashCommandSummaries: async (session: unknown) => {
        calls.push(session)
        return [{ id: 'custom:review', name: 'review', label: '/review' }]
      },
    } as Partial<HandlerDeps['sessionManager']>)

    const session = { workspaceId: 'workspace-local', sessionId: 'session-a' }
    const result = await invoke(RPC_CHANNELS.workspace.LIST_CUSTOM_SLASH_COMMANDS, session)

    expect(calls).toEqual([session])
    expect(result).toEqual([{ id: 'custom:review', name: 'review', label: '/review' }])
  })
})
