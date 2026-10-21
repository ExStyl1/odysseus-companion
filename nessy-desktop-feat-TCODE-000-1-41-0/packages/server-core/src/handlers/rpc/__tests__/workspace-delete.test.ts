/**
 * P6.501 — the headless purge route.
 *
 * The row's premise was corrected before this landed: `purgeProject` and
 * `deleteWorkspaceData` score 0 hits tree-wide, but `WorkspaceService.delete`
 * plus four cleanup participants, the credentials and a delete journal already
 * purge everything the row enumerates. What was missing was REACH — one caller,
 * the Electron `workspace:remove` IPC, so a headless install could not offboard
 * a project at all.
 *
 * So these assertions are about the seam, not about deleting: that the verb
 * exists, that it delegates rather than re-implementing, that it carries the
 * WHOLE result across the wire (a caller that cannot see `cleanupFailures`
 * cannot tell a complete purge from a partial one — the collapse this row
 * removed from `main/index.ts`), and that a missing id is refused BEFORE the
 * service is touched.
 */

import { describe, expect, test } from 'bun:test'
import { RPC_CHANNELS } from '@nessy-agent/shared/protocol'
import type { WorkspaceDeleteResult, WorkspaceService } from '@nessy-agent/shared/workspaces'
import type { RpcServer, HandlerFn } from '../../../transport/types'
import type { HandlerDeps } from '../../handler-deps'
import { registerWorkspaceCoreHandlers } from '../workspace'

function harness(result: WorkspaceDeleteResult) {
  const deleted: string[] = []
  const handlers = new Map<string, HandlerFn>()
  const server = {
    handle: (channel: string, handler: HandlerFn) => handlers.set(channel, handler),
    push: () => {},
    invokeClient: async () => undefined,
    hasClientCapability: () => false,
    findClientsWithCapability: () => [],
  } as RpcServer
  const service = {
    async delete(workspaceId: string) {
      deleted.push(workspaceId)
      return result
    },
  } as unknown as WorkspaceService
  registerWorkspaceCoreHandlers(server, {
    workspaceService: service,
    sessionManager: {} as HandlerDeps['sessionManager'],
    platform: {} as HandlerDeps['platform'],
    oauthFlowStore: {} as HandlerDeps['oauthFlowStore'],
  })
  const invoke = (channel: string, ...args: unknown[]) => {
    const handler = handlers.get(channel)
    if (!handler) throw new Error(`missing handler ${channel}`)
    return handler({ clientId: 'client', workspaceId: 'workspace-local', webContentsId: null }, ...args)
  }
  return { invoke, deleted, handlers }
}

const CLEAN: WorkspaceDeleteResult = { deleted: true, cleanupFailures: [] }

describe('the headless project purge', () => {
  test('registers the verb and delegates to the existing transactional delete', async () => {
    const { invoke, deleted, handlers } = harness(CLEAN)
    expect(handlers.has(RPC_CHANNELS.workspaces.DELETE)).toBe(true)
    await expect(invoke(RPC_CHANNELS.workspaces.DELETE, 'workspace-1')).resolves.toEqual(CLEAN)
    expect(deleted).toEqual(['workspace-1'])
  })

  test('carries cleanupFailures across, so a partial purge cannot read as a complete one', async () => {
    // The exact defect this row removed from `main/index.ts`, which answered
    // `result.deleted` and dropped the rest: a removal whose credential cleanup
    // failed reported plain success.
    const partial: WorkspaceDeleteResult = {
      deleted: true,
      cleanupFailures: [{ resource: 'credentials', code: 'EACCES', message: 'keychain locked' }],
    }
    const { invoke } = harness(partial)
    const result = (await invoke(RPC_CHANNELS.workspaces.DELETE, 'workspace-1')) as WorkspaceDeleteResult
    expect(result.deleted).toBe(true)
    expect(result.cleanupFailures).toHaveLength(1)
    expect(result.cleanupFailures[0]?.resource).toBe('credentials')
  })

  test('refuses a missing or blank id before the service is touched', async () => {
    const { invoke, deleted } = harness(CLEAN)
    await expect(invoke(RPC_CHANNELS.workspaces.DELETE, '   ')).rejects.toThrow(/workspace id is required/)
    await expect(invoke(RPC_CHANNELS.workspaces.DELETE)).rejects.toThrow(/workspace id is required/)
    expect(deleted).toEqual([])
  })
})
