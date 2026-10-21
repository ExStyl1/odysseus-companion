import { describe, expect, it } from 'bun:test'
import { PiAgent } from '../pi-agent.ts'
import type { BackendConfig } from '../backend/types.ts'

function createConfig(sessionOverrides?: Record<string, unknown>): BackendConfig {
  return {
    provider: 'pi',
    workspace: {
      id: 'ws-test',
      name: 'Test Workspace',
      rootPath: '/tmp/nessy-general-agent-test',
      workspaceRootPath: '/tmp/nessy-general-agent-test',
      sessionRootPath: '/tmp/nessy-general-agent-test-sessions/ws-test',
    } as any,
    session: {
      id: 'session-test',
      workspaceId: 'ws-test',
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      ...sessionOverrides,
    } as any,
    isHeadless: true,
  }
}

describe('PiAgent branching capability', () => {
  it('reports supportsBranching=true', () => {
    const agent = new PiAgent(createConfig())
    expect(agent.supportsBranching).toBe(true)
    agent.destroy()
  })

  it('throws preflight error for branched session missing the composite parent identity', async () => {
    const agent = new PiAgent(createConfig({ branchFrom: { messageId: 'msg-parent' } }))

    await expect(agent.ensureBranchReady()).rejects.toThrow(
      'Pi branch preflight failed: missing branchFrom.parent metadata'
    )

    agent.destroy()
  })

  it('passes preflight when subprocess reports a valid Pi session id', async () => {
    const agent = new PiAgent(
      createConfig({
        branchFrom: {
          parent: { workspaceId: 'ws-test', sessionId: 'parent' },
          messageId: 'msg-parent',
        },
      })
    )

    ;(agent as any).requestEnsureSessionReady = async () => 'pi-session-123'

    await expect(agent.ensureBranchReady()).resolves.toBeUndefined()
    expect(agent.getSessionId()).toBe('pi-session-123')

    agent.destroy()
  })
})
