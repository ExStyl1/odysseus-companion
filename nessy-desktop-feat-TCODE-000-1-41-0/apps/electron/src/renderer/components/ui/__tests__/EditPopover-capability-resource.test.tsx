import { describe, expect, it } from 'bun:test'
import { buildManagedEditRequest } from '../managed-capability-edit'

describe('EditPopover managed capability resource', () => {
  it('submits a path-free managed resource ref', () => {
    const request = buildManagedEditRequest({
      label: 'Source guide',
      contextKey: 'source-guide',
      resource: { scope: 'source', workspaceId: 'ws-1', sourceId: 'github', file: 'guide' },
    }, { workspaceId: 'ws-1', sessionId: 'session-1' }, 'Add usage guidance')

    expect(request).toEqual({
      session: { workspaceId: 'ws-1', sessionId: 'session-1' },
      resource: { scope: 'source', workspaceId: 'ws-1', sourceId: 'github', file: 'guide' },
      contextKey: 'source-guide',
      instructions: 'Add usage guidance',
    })
    expect(JSON.stringify(request)).not.toMatch(/filePath|sourcePath|workspaceRoot|projectRoot/)
  })

  it('rejects an empty instruction', () => {
    expect(() => buildManagedEditRequest({
      label: 'Skill instructions',
      contextKey: 'skill-instructions',
      resource: { scope: 'skill', tier: 'workspace', workspaceId: 'ws-1', skillId: 'review', file: 'instructions' },
    }, { workspaceId: 'ws-1', sessionId: 'session-1' }, '   ')).toThrow('Managed edit instruction is required')
  })
})
