import { afterEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createWorkspaceService } from '@nessy-agent/shared/workspaces'
import { WorkspaceQuiescenceCoordinator } from '../../workspaces/workspace-quiescence'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('storage runtime workspace quiescence composition', () => {
  it('constructs, injects, and exports the exact same coordinator instance', () => {
    const source = readFileSync(resolve(import.meta.dir, '../storage-runtime.ts'), 'utf8')
    expect(source.match(/new WorkspaceQuiescenceCoordinator\(\)/g)).toHaveLength(1)
    expect(source).toContain('quiescence: workspaceQuiescence')
    expect(source).toContain('workspaceQuiescence,')
  })

  it('prevents WorkspaceService filesystem mutation when a registered drain fails', async () => {
    const configDir = mkdtempSync(join(tmpdir(), 'nessy-q0-'))
    roots.push(configDir)
    const coordinator = new WorkspaceQuiescenceCoordinator()
    coordinator.registerParticipant({
      id: 'failed-runtime',
      async drain() { throw new Error('runtime drain failed') },
    })
    const service = createWorkspaceService({
      configDir,
      credentialManager: { list: async () => [], deleteWorkspaceCredentials: async () => {} },
      quiescence: coordinator,
    })
    const created = await service.create({ name: 'Drain Failure' })
    const rootPath = service.resolve(created.id).workspaceRootPath

    const result = await service.delete(created.id)

    expect(result.deleted).toBe(false)
    expect(result.cleanupFailures[0]?.code).toBe('workspace-delete-failed')
    expect(existsSync(rootPath)).toBe(true)
    expect(service.resolve(created.id).id).toBe(created.id)
  })
})
