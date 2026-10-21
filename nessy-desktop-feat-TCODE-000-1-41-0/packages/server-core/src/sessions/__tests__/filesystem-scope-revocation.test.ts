/**
 * P6: server-owned filesystem scope receipts — the renderer submits only
 * (sessionId, receiptId); the server removes the receipt and reports safe
 * scope diagnostics through the runtime snapshot DTO.
 */

import { afterAll, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SessionFilesystemScopeRoot } from '@nessy-agent/shared/agent/session-filesystem-scope'
import { createTestSessionManager } from './test-session-manager'

const manager = createTestSessionManager()

afterAll(() => {
  manager.cleanup()
})

const WS = 'ws-scope-revoke'

describe('filesystem scope receipts (P6)', () => {
  it('revokes one receipt by id and reports false for unknown receipts', async () => {
    const session = await manager.createSession(WS, { name: 'Scope Revoke Probe' })
    const managed = (manager as unknown as {
      sessions: Map<string, { id: string; approvedFilesystemRoots?: SessionFilesystemScopeRoot[] }>
    }).sessions.values().find(candidate => candidate.id === session.id)
    expect(managed).toBeDefined()
    managed!.approvedFilesystemRoots = [
      { canonicalRoot: '/tmp/extra-a', access: 'read', receiptId: 'r-a', expires: 'session' },
      { canonicalRoot: '/tmp/extra-b', access: 'write', receiptId: 'r-b', expires: 'session' },
    ]

    await expect(manager.revokeFilesystemRoot(session.id, 'r-a', WS)).resolves.toBe(true)
    expect(managed!.approvedFilesystemRoots?.map(root => root.receiptId)).toEqual(['r-b'])

    await expect(manager.revokeFilesystemRoot(session.id, 'r-a', WS)).resolves.toBe(false)
    await expect(manager.revokeFilesystemRoot('missing-session', 'r-b', WS)).resolves.toBe(false)
    expect(managed!.approvedFilesystemRoots?.map(root => root.receiptId)).toEqual(['r-b'])
  })

  it('surfaces trusted project config diagnostics as safe codes in the runtime snapshot', async () => {
    const project = mkdtempSync(join(tmpdir(), 'scope-diagnostics-'))
    mkdirSync(join(project, '.nessy-agent'), { recursive: true })
    writeFileSync(join(project, '.nessy-agent', 'config.toml'), '[trust]\nself = true\n\n[defaults]\napi_key = "x"\n')

    const session = await manager.createSession(WS, { name: 'Scope Diagnostics Probe' })
    const managed = (manager as unknown as {
      sessions: Map<string, { id: string; projectKey?: string; workingDirectory?: string; capabilityRuntime?: { projectTrustState: string } }>
    }).sessions.values().find(candidate => candidate.id === session.id)!
    managed.projectKey = 'p_' + 'a'.repeat(32)
    managed.workingDirectory = project
    managed.capabilityRuntime = { ...(managed.capabilityRuntime ?? {}), projectTrustState: 'trusted' } as typeof managed.capabilityRuntime

    const snapshot = await manager.getPiHarnessRuntimeSnapshot({ workspaceId: WS, sessionId: session.id })
    const codes = snapshot.security.filesystemScope?.configDiagnostics?.map(diagnostic => diagnostic.code) ?? []
    expect(codes).toContain('plugin.project_config.forbidden_section')
    expect(codes).toContain('plugin.project_config.forbidden_key')
    for (const diagnostic of snapshot.security.filesystemScope?.configDiagnostics ?? []) {
      expect(['error', 'warning']).toContain(diagnostic.severity)
      expect(JSON.stringify(diagnostic)).not.toContain(project)
    }
    rmSync(project, { recursive: true, force: true })
  })
})
