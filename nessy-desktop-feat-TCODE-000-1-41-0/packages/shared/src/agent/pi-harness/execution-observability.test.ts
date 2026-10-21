import { describe, expect, test } from 'bun:test'
import type { ToolExecutionReceipt } from './execution-receipt.ts'
import {
  ExecutionReceiptRing,
  parseSafeExecutionReceiptInput,
  projectPiExecutionReceiptTelemetry,
  projectPiPermissionTelemetry,
  summarizeExecutionReceipt,
  type SafeExecutionReceiptInputV1,
} from './execution-observability.ts'

const session = { workspaceId: 'workspace', sessionId: 'session' }

function input(executionId: string): SafeExecutionReceiptInputV1 {
  return {
    executionId,
    semanticId: 'write',
    outcome: 'success',
    startedAt: 10,
    completedAt: 12,
    manifestGeneration: 'generation-1',
    responseEpoch: 1,
    effect: 'workspaceMutation',
    isolationProfile: 'workspace',
    environmentProfile: 'restricted',
    environmentDigest: 'a'.repeat(64),
    decisionId: `decision-${executionId}`,
  }
}

describe('execution receipt observability', () => {
  test('hydrates a bounded ring across process restarts and preserves sequence through expiry', () => {
    let now = 10
    const ring = new ExecutionReceiptRing(session, { limit: 2, maxAgeMs: 10, now: () => now })
    ring.append(input('first'))
    ring.append(input('second'))
    ring.append(input('third'))
    expect(ring.snapshot().map(value => value.sequence)).toEqual([2, 3])

    const restarted = new ExecutionReceiptRing(session, {
      limit: 2,
      maxAgeMs: 10,
      now: () => now,
      initialEntries: ring.persistedSnapshot(),
    })
    expect(restarted.snapshot().map(value => value.sequence)).toEqual([2, 3])
    restarted.append(input('after-process-restart'))
    expect(restarted.snapshot().map(value => value.sequence)).toEqual([3, 4])
    const beforeExpiry = restarted.persistedSnapshot()

    now = 21
    const expiredRestart = new ExecutionReceiptRing(session, {
      limit: 2,
      maxAgeMs: 10,
      now: () => now,
      initialEntries: beforeExpiry,
    })
    expect(expiredRestart.snapshot()).toEqual([])
    expect(expiredRestart.append(input('after-expiry')).sequence).toBe(5)
  })

  test('projects only safe metadata and rejects path or secret-bearing fields', () => {
    const receipt: ToolExecutionReceipt = {
      executionId: 'call-1',
      semanticId: 'mcp_dynamic',
      decisionId: 'decision-1',
      isolationProfile: 'plugin-mcp',
      environmentProfile: 'trusted-host',
      environmentDigest: 'b'.repeat(64),
      manifestGeneration: 'generation-1',
      responseEpoch: 7,
      effect: 'externalMutation',
      startedAt: 1,
      completedAt: 2,
      outcome: 'error',
      code: 'execution_error',
      reason: 'token=top-secret /Users/person/project',
      additionalContext: 'private hook output',
      result: { content: 'top-secret output', error: 'top-secret', isError: true, structuredContent: { token: 'top-secret' } },
      correlation: { processId: 'process-1', childIds: ['child-1'], workflowId: 'workflow-1', goalId: 'goal-1', goalRevision: 3, mcpServer: 'gitlab', mcpTool: 'get_repo' },
    }
    const projected = summarizeExecutionReceipt(receipt)
    expect(projected).toMatchObject({ environmentProfile: 'trusted-host', environmentDigest: 'b'.repeat(64), processId: 'process-1', childIds: ['child-1'], workflowId: 'workflow-1', goalId: 'goal-1', goalRevision: 3, mcpServer: 'gitlab', mcpTool: 'get_repo' })
    const wire = JSON.stringify(projected)
    for (const canary of ['top-secret', '/Users/person', 'private hook output', 'credential-secret', 'structuredContent']) {
      expect(wire).not.toContain(canary)
    }
    expect(() => parseSafeExecutionReceiptInput({ ...projected, processId: '/Users/person/project' })).toThrow('execution-receipt-id-invalid')
    expect(() => parseSafeExecutionReceiptInput({ ...projected, isolationProfile: 'workspace:/Users/person/project' })).toThrow('execution-receipt-isolation-profile-invalid')
    expect(() => parseSafeExecutionReceiptInput({ ...projected, environmentDigest: 'credential-secret' })).toThrow('execution-receipt-environment-digest-invalid')
    expect(() => parseSafeExecutionReceiptInput({ ...projected, goalRevision: undefined })).toThrow('execution-receipt-goal-reference-invalid')
    expect(() => parseSafeExecutionReceiptInput({ ...projected, goalRevision: 0 })).toThrow('execution-receipt-goal-reference-invalid')
    expect(() => parseSafeExecutionReceiptInput({ ...projected, output: 'secret' })).toThrow('execution-receipt-field-invalid')
  })

  test('projects receipt and permission telemetry without raw execution or permission data', () => {
    const mcp = projectPiExecutionReceiptTelemetry({
      ...input('mcp'),
      outcome: 'timed-out',
      startedAt: 4,
      completedAt: 9,
      mcpServer: 'server-1',
      mcpTool: 'tool-1',
      sequence: 1,
    })
    expect(mcp).toEqual({
      name: 'mcp.completed',
      outcome: 'error',
      durationMs: 5,
      semanticId: 'write',
    })

    const hook = projectPiExecutionReceiptTelemetry({
      ...input('hook'),
      semanticId: 'plugin-http-hook',
      sequence: 2,
    })
    expect(hook.name).toBe('hook.completed')
    expect(projectPiExecutionReceiptTelemetry({
      ...input('partial-mcp'),
      mcpServer: 'server-only',
      sequence: 3,
    }).name).toBe('tool.completed')

    const permission = projectPiPermissionTelemetry({
      outcome: 'deny',
      binding: { semanticId: 'Bash:write' },
      canonicalInput: { path: '/private', token: 'secret' },
      reason: 'private',
      additionalContext: 'private',
      unexpectedField: { ruleId: 'rule', scope: 'managed', sourceDigest: 'secret' },
    } as never)
    expect(permission).toEqual({
      name: 'permission.decided',
      outcome: 'denied',
      semanticId: 'Bash:write',
    })
    expect(projectPiPermissionTelemetry({ outcome: 'allow', binding: { semanticId: '/private/path' } } as never)).toBeUndefined()
    expect(JSON.stringify({ mcp, hook, permission })).not.toContain('private')
    expect(JSON.stringify({ mcp, hook, permission })).not.toContain('secret')
    expect(JSON.stringify({ mcp, hook, permission })).not.toContain('server-1')
  })
})
