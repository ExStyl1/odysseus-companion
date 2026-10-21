import { describe, expect, it } from 'bun:test'
import { ExecutionReceiptRing } from '@nessy-agent/shared/agent/pi-harness/execution-observability'
import { createManagedSession } from './SessionManager.ts'

describe('createManagedSession', () => {
  const workspace = {
    id: 'ws_test',
    name: 'Test Workspace',
    rootPath: '/tmp/test-workspace',
    createdAt: Date.now(),
  }

  it('normalizes legacy thinkingLevel=think on restore', () => {
    const managed = createManagedSession({
      id: 'session_legacy',
      thinkingLevel: 'think' as any,
    }, workspace as any)

    expect(managed.thinkingLevel).toBe('medium')
  })

  it('drops invalid thinking levels instead of leaking them into runtime state', () => {
    const managed = createManagedSession({
      id: 'session_invalid',
      thinkingLevel: 'ultra' as any,
    }, workspace as any)

    expect(managed.thinkingLevel).toBeUndefined()
  })

  it('hydrates durable redacted execution observations without exposing the storage field', () => {
    const session = { workspaceId: workspace.id, sessionId: 'session_receipts' }
    const persisted = new ExecutionReceiptRing(session)
    persisted.append({
      executionId: 'call-1', semanticId: 'read', outcome: 'success', startedAt: 1, completedAt: 2,
      manifestGeneration: 'generation-1', responseEpoch: 1, effect: 'read', isolationProfile: 'workspace', decisionId: 'decision-1',
    })
    const managed = createManagedSession({
      id: session.sessionId,
      piExecutionObservations: persisted.persistedSnapshot(),
    } as any, workspace as any)

    expect((managed as any).piExecutionObservations).toBeUndefined()
    expect(managed.piExecutionReceipts?.snapshot().map(receipt => receipt.sequence)).toEqual([1])
    expect(managed.piExecutionReceipts?.append({
      executionId: 'call-2', semanticId: 'read', outcome: 'success', startedAt: 3, completedAt: 4,
      manifestGeneration: 'generation-1', responseEpoch: 1, effect: 'read', isolationProfile: 'workspace', decisionId: 'decision-2',
    }).sequence).toBe(2)
  })
})
