import { describe, expect, test } from 'bun:test'
import type { SessionToolContext, SessionMcpResourcesPort } from '../context.ts'
import { handleListMcpResources, handleReadMcpResource } from './mcp-resources.ts'

function context(mcpResources?: SessionMcpResourcesPort): SessionToolContext {
  return {
    configRoot: '/tmp/config',
    sessionId: 'session-1',
    workspacePath: '/tmp/workspace',
    sourcesPath: '/tmp/workspace/sources',
    skillsPath: '/tmp/workspace/skills',
    plansFolderPath: '/tmp/workspace/plans',
    callbacks: {} as SessionToolContext['callbacks'],
    fs: {} as SessionToolContext['fs'],
    loadSourceConfig: () => null,
    mcpResources,
  } as unknown as SessionToolContext
}

describe('handleListMcpResources', () => {
  test('returns the discovered resources and templates via the port (UB7.10)', async () => {
    const calls: Array<string | undefined> = []
    const result = await handleListMcpResources(context({
      list: async server => {
        calls.push(server)
        return {
          resources: [{ server: 'gh', uri: 'issue://123', name: 'Issue 123', mimeType: 'text/plain' }],
          resourceTemplates: [{ server: 'gh', uriTemplate: 'issue://{id}', name: 'Issue' }],
          truncated: false,
        }
      },
      read: async () => 'unused',
    }), { server: 'gh' })

    expect(calls).toEqual(['gh'])
    expect(result.content[0]?.type).toBe('text')
    const payload = JSON.parse((result.content[0] as { text: string }).text)
    expect(payload.resources).toEqual([
      { server: 'gh', uri: 'issue://123', name: 'Issue 123', mimeType: 'text/plain' },
    ])
    expect(payload.resourceTemplates).toEqual([
      { server: 'gh', uriTemplate: 'issue://{id}', name: 'Issue' },
    ])
    expect(payload.truncated).toBe(false)
  })

  test('reports unavailability when no MCP pool is bound', async () => {
    const result = await handleListMcpResources(context(undefined), {})
    expect(result.isError).toBe(true)
    expect((result.content[0] as { text: string }).text).toContain('not available')
  })
})

describe('handleReadMcpResource', () => {
  test('returns the rendered text via the port (UB7.10: agent-ready text, not raw contents)', async () => {
    const calls: Array<{ server: string; uri: string }> = []
    const result = await handleReadMcpResource(context({
      list: async () => ({ resources: [], resourceTemplates: [], truncated: false }),
      read: async (server, uri) => {
        calls.push({ server, uri })
        return 'hello from stub'
      },
    }), { server: 'stub', uri: 'file:///x.txt' })

    expect(calls).toEqual([{ server: 'stub', uri: 'file:///x.txt' }])
    expect((result.content[0] as { text: string }).text).toBe('hello from stub')
  })

  test('rejects a call missing the server or uri', async () => {
    const result = await handleReadMcpResource(context({
      list: async () => ({ resources: [], resourceTemplates: [], truncated: false }),
      read: async () => '',
    }), { server: 'stub', uri: '' })
    expect(result.isError).toBe(true)
    expect((result.content[0] as { text: string }).text).toContain('requires both')
  })
})
