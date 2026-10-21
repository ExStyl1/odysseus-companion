import { describe, expect, test } from 'bun:test'
import { parsePiHarnessRuntimeControlRequestV1, parsePiHarnessRuntimeControlResultV1, parsePiHarnessRuntimeEventV1, parsePiHarnessRuntimeSnapshotV1 } from './pi-harness-runtime'

const snapshot = () => ({ schemaVersion: 1, session: { workspaceId: 'w', sessionId: 's' }, provider: 'pi', available: true, generatedAt: 1, manifest: { surfaceVersion: 2, generation: 'g', manifestHash: 'h', provenance: [], contextProfile: 'normal', responseEpoch: 1 }, worktrees: [], executionReceipts: [], checkpoints: [], processes: [], context: { sourceCount: 0, skillCount: 0, mcpServerCount: 0, hookCount: 0, promptLayerCount: 0, memoryCount: 0 }, compaction: { isCompacting: false, pendingPlan: false }, security: { projectTrustState: 'trusted', risk: 'none', permissionSource: 'session-mode', pendingPermissions: [], isolationProfiles: [], hookCount: 0 }, settlement: { schemaVersion: 1, settled: true, pending: [] } })

describe('Pi harness runtime protocol', () => {
  test('accepts bounded invalidations and strict controls', () => {
    const wire = { type: 'pi_harness_runtime_invalidated', sessionId: 's', schemaVersion: 1, session: { workspaceId: 'w', sessionId: 's' }, changedDomains: ['processes', 'runtime'] }
    expect(parsePiHarnessRuntimeEventV1(wire).changedDomains).toEqual(['processes', 'runtime'])
    expect(() => parsePiHarnessRuntimeEventV1({ ...wire, sessionId: 'other' })).toThrow('pi-harness-runtime-invalid')
    expect(() => parsePiHarnessRuntimeEventV1({ ...wire, extra: true })).toThrow('pi-harness-runtime-invalid')
    expect(parsePiHarnessRuntimeControlRequestV1({ schemaVersion: 1, session: { workspaceId: 'w', sessionId: 's' }, action: 'stop_process', handle: 'process_123' }).action).toBe('stop_process')
    expect(parsePiHarnessRuntimeControlRequestV1({ schemaVersion: 1, session: { workspaceId: 'w', sessionId: 's' }, action: 'read_child', agentId: 'agent_123', cursor: 0 }).action).toBe('read_child')
  })

  test('rejects unknown versions and oversized values', () => {
    expect(() => parsePiHarnessRuntimeEventV1({ type: 'pi_harness_runtime_invalidated', sessionId: 's', schemaVersion: 2, session: { workspaceId: 'w', sessionId: 's' }, changedDomains: ['runtime'] })).toThrow('pi-harness-runtime-invalid')
    expect(() => parsePiHarnessRuntimeControlRequestV1({ schemaVersion: 1, session: { workspaceId: 'w', sessionId: 's' }, action: 'steer_child', agentId: 'a', message: 'x'.repeat(4097) })).toThrow('pi-harness-runtime-invalid')
  })

  test('validates bounded control results before renderer exposure', () => {
    expect(parsePiHarnessRuntimeControlResultV1({ schemaVersion: 1, ok: true, output: '', nextCursor: 3 })).toEqual({ schemaVersion: 1, ok: true, output: '', nextCursor: 3 })
    expect(parsePiHarnessRuntimeControlResultV1({ schemaVersion: 1, ok: false, error: 'denied' })).toEqual({ schemaVersion: 1, ok: false, error: 'denied' })
    expect(() => parsePiHarnessRuntimeControlResultV1({ schemaVersion: 1, ok: true, output: 'x'.repeat(64 * 1024 + 1) })).toThrow('pi-harness-runtime-invalid')
    expect(() => parsePiHarnessRuntimeControlResultV1({ schemaVersion: 1, ok: false, error: 'denied', nextCursor: 1 })).toThrow('pi-harness-runtime-invalid')
    expect(() => parsePiHarnessRuntimeControlResultV1({ schemaVersion: 1, ok: true, extra: true })).toThrow('pi-harness-runtime-invalid')
  })

  test('validates typed answer shapes, unknown keys and snapshot bounds', () => {
    expect(parsePiHarnessRuntimeControlRequestV1({ schemaVersion: 1, session: { workspaceId: 'w', sessionId: 's' }, action: 'answer_ask', requestId: 'r', answer: { type: 'option', value: 'yes', optionIndex: 0 } }).action).toBe('answer_ask')
    expect(() => parsePiHarnessRuntimeControlRequestV1({ schemaVersion: 1, session: { workspaceId: 'w', sessionId: 's' }, action: 'answer_ask', requestId: 'r', answer: { type: 'free_text', value: 'yes', extra: true } })).toThrow('pi-harness-runtime-invalid')
    expect(parsePiHarnessRuntimeSnapshotV1(snapshot()).provider).toBe('pi')
    expect(() => parsePiHarnessRuntimeSnapshotV1({ ...snapshot(), processes: Array.from({ length: 51 }, () => ({})) })).toThrow('pi-harness-runtime-invalid')
    expect(() => parsePiHarnessRuntimeSnapshotV1({ ...snapshot(), extra: true })).toThrow('pi-harness-runtime-invalid')
    expect(() => parsePiHarnessRuntimeSnapshotV1({ ...snapshot(), childState: { revision: 1, sealedOwnerTaskIds: [], children: [{ agentId: 'a', agent: 3, status: 'running', background: false }] } })).toThrow('pi-harness-runtime-invalid')
    expect(() => parsePiHarnessRuntimeSnapshotV1({ ...snapshot(), processes: [{ handle: 'p', semanticId: 'bash', startedAt: 1, deadlineAt: 2, status: 'unknown', exitCode: null, signal: null, isolationProfile: 'workspace', nextCursor: 0 }] })).toThrow('pi-harness-runtime-invalid')
    expect(() => parsePiHarnessRuntimeSnapshotV1({ ...snapshot(), provider: 'anthropic', available: true })).toThrow('pi-harness-runtime-invalid')
    expect(() => parsePiHarnessRuntimeSnapshotV1({ ...snapshot(), settlement: { schemaVersion: 1, settled: true, pending: ['child'] } })).toThrow('pi-harness-runtime-invalid')
    expect(parsePiHarnessRuntimeSnapshotV1({ ...snapshot(), settlement: { schemaVersion: 1, settled: false, pending: ['workflow_evaluator', 'child'] } }).settlement.pending).toEqual(['workflow_evaluator', 'child'])
  })

  /**
   * R53c — the per-subagent `effort`/`model` of `statusline.md`'s
   * `subagentStatusLine` row body. Appended LAST to a WIRE type, so the pair
   * that matters is: a new summary carries them through the strict parser, and
   * a summary from a host that predates them still parses.
   */
  test('carries a child summary effort and model, and still accepts one that has neither', () => {
    const withFields = parsePiHarnessRuntimeSnapshotV1({
      ...snapshot(),
      childState: { revision: 1, sealedOwnerTaskIds: [], children: [{ agentId: 'a', agent: 'scout', status: 'running', background: false, effort: 'xhigh', model: 'claude-opus-4-8' }] },
    })
    expect(withFields.childState?.children[0]).toMatchObject({ effort: 'xhigh', model: 'claude-opus-4-8' })

    const legacy = parsePiHarnessRuntimeSnapshotV1({
      ...snapshot(),
      childState: { revision: 1, sealedOwnerTaskIds: [], children: [{ agentId: 'a', agent: 'scout', status: 'running', background: false }] },
    })
    expect(legacy.childState?.children[0]).toEqual({ agentId: 'a', agent: 'scout', status: 'running', background: false })

    // The effort is an enum on the wire, not free text: a level we do not run
    // must not reach a row that claims to say what ran.
    expect(() => parsePiHarnessRuntimeSnapshotV1({
      ...snapshot(),
      childState: { revision: 1, sealedOwnerTaskIds: [], children: [{ agentId: 'a', agent: 'scout', status: 'running', background: false, effort: 'ultra' }] },
    })).toThrow('pi-harness-runtime-invalid')
  })

  test('validates the bounded goal projection and stale-safe controls', () => {
    const goal = {
      id: 'goal-1', revision: 3, status: 'active', source: 'user', creator: 'desktop', condition: 'Ship verified change',
      budgets: { turnLimit: 32, tokenLimit: 250000, costLimitUsd: 20, elapsedLimitMs: 7200000 },
      accounting: { turns: 2, tokens: 100, costUsd: 0.2, elapsedMs: 1000, resumeCount: 0 },
      lastEvaluation: { source: 'evaluator', verdict: 'not_complete', reason: 'tests pending', evidence: [], evaluatedAt: 2 },
      createdAt: 1, updatedAt: 2,
    } as const
    expect(parsePiHarnessRuntimeSnapshotV1({ ...snapshot(), goal }).goal).toEqual(goal)
    expect(() => parsePiHarnessRuntimeSnapshotV1({ ...snapshot(), goal: { ...goal, secret: 'raw' } })).toThrow('pi-harness-runtime-invalid')
    expect(() => parsePiHarnessRuntimeSnapshotV1({ ...snapshot(), goal: { ...goal, revision: 0 } })).toThrow('pi-harness-runtime-invalid')

    const create = parsePiHarnessRuntimeControlRequestV1({
      schemaVersion: 1, session: { workspaceId: 'w', sessionId: 's' }, action: 'goal_create', condition: 'Ship verified change', budgets: { turnLimit: 4 },
    })
    expect(create).toMatchObject({ action: 'goal_create', budgets: { turnLimit: 4 } })
    expect(parsePiHarnessRuntimeControlRequestV1({
      schemaVersion: 1, session: { workspaceId: 'w', sessionId: 's' }, action: 'goal_create', condition: 'x'.repeat(8_192),
    }).action).toBe('goal_create')
    expect(() => parsePiHarnessRuntimeControlRequestV1({
      schemaVersion: 1, session: { workspaceId: 'w', sessionId: 's' }, action: 'goal_create', condition: 'x'.repeat(8_193),
    })).toThrow('pi-harness-runtime-invalid')
    expect(() => parsePiHarnessRuntimeControlRequestV1({
      schemaVersion: 1, session: { workspaceId: 'w', sessionId: 's' }, action: 'goal_create', condition: 'Ship', source: 'agent',
    })).toThrow('pi-harness-runtime-invalid')
    expect(() => parsePiHarnessRuntimeControlRequestV1({
      schemaVersion: 1, session: { workspaceId: 'w', sessionId: 's' }, action: 'goal_complete', goalId: 'goal-1', revision: 3, reason: 'done', evidence: [],
    })).toThrow('pi-harness-runtime-invalid')
  })

  test('accepts the P6 filesystem scope summary and outside_root pending type (Q1.4)', () => {
    const scoped = {
      ...snapshot(),
      security: {
        ...snapshot().security,
        pendingPermissions: [{ requestId: 'r1', type: 'outside_root', source: 'session-permission' }],
        filesystemScope: {
          primaryRoot: '/ext/project',
          hasProject: true,
          additionalRoots: [{ receiptId: 'r-a', canonicalRoot: '/ext/other', access: 'read', expires: 'session' }],
          configDiagnostics: [{ severity: 'error', code: 'plugin.project_config.forbidden_key' }],
        },
      },
    }
    const parsed = parsePiHarnessRuntimeSnapshotV1(scoped)
    expect(parsed.security.filesystemScope?.primaryRoot).toBe('/ext/project')
    expect(parsed.security.filesystemScope?.additionalRoots[0]?.receiptId).toBe('r-a')
    expect(parsed.security.filesystemScope?.configDiagnostics?.[0]?.code).toBe('plugin.project_config.forbidden_key')
    expect(parsed.security.pendingPermissions[0]?.type).toBe('outside_root')
    expect(() => parsePiHarnessRuntimeSnapshotV1({
      ...scoped,
      security: { ...scoped.security, filesystemScope: { ...scoped.security.filesystemScope, extra: true } },
    })).toThrow('pi-harness-runtime-invalid')
  })

  test('accepts ordered redacted receipts and rejects path or body fields', () => {
    const receipt = {
      sequence: 1, executionId: 'call-1', semanticId: 'mcp_dynamic', outcome: 'success',
      startedAt: 1, completedAt: 2, manifestGeneration: 'generation-1', responseEpoch: 1,
      effect: 'externalMutation', isolationProfile: 'workspace:sandbox-exec:host-read:write-workspace+scratch+managed-data', decisionId: 'decision-1',
      environmentProfile: 'explicit', environmentDigest: 'a'.repeat(64),
      processId: 'process-1', childIds: ['child-1'], goalId: 'goal-1', goalRevision: 3, mcpServer: 'gitlab', mcpTool: 'get_repo',
    } as const
    expect(parsePiHarnessRuntimeSnapshotV1({ ...snapshot(), executionReceipts: [receipt] }).executionReceipts[0]).toEqual(receipt)
    expect(() => parsePiHarnessRuntimeSnapshotV1({ ...snapshot(), executionReceipts: [{ ...receipt, output: 'secret' }] })).toThrow('pi-harness-runtime-invalid')
    expect(() => parsePiHarnessRuntimeSnapshotV1({ ...snapshot(), executionReceipts: [{ ...receipt, processId: '/private/path' }] })).toThrow('pi-harness-runtime-invalid')
    expect(() => parsePiHarnessRuntimeSnapshotV1({ ...snapshot(), executionReceipts: [{ ...receipt, environmentDigest: 'secret-value' }] })).toThrow('pi-harness-runtime-invalid')
    expect(() => parsePiHarnessRuntimeSnapshotV1({ ...snapshot(), executionReceipts: [{ ...receipt, goalRevision: undefined }] })).toThrow('pi-harness-runtime-invalid')
    expect(() => parsePiHarnessRuntimeSnapshotV1({ ...snapshot(), executionReceipts: [{ ...receipt, goalRevision: 0 }] })).toThrow('pi-harness-runtime-invalid')
    expect(() => parsePiHarnessRuntimeSnapshotV1({ ...snapshot(), executionReceipts: [receipt, { ...receipt, executionId: 'call-2' }] })).toThrow('pi-harness-runtime-invalid')
  })

  test('accepts safe checkpoint metadata and rejects paths or malformed digests', () => {
    const checkpoint = {
      id: 'checkpoint-1', adapter: 'file', toolName: 'format', fileName: 'a.ts', existed: true,
      preimageDigest: 'a'.repeat(64), postimageDigest: 'b'.repeat(64), currentDigest: 'b'.repeat(64),
      postimageExists: true, currentExists: true, outcome: 'applied', changed: true, conflict: false,
      createdAt: '2026-07-22T00:00:00.000Z', completedAt: '2026-07-22T00:00:01.000Z',
    } as const
    expect(parsePiHarnessRuntimeSnapshotV1({ ...snapshot(), checkpoints: [checkpoint] }).checkpoints[0]).toEqual(checkpoint)
    expect(() => parsePiHarnessRuntimeSnapshotV1({ ...snapshot(), checkpoints: [{ ...checkpoint, filePath: '/private/a.ts' }] })).toThrow('pi-harness-runtime-invalid')
    expect(() => parsePiHarnessRuntimeSnapshotV1({ ...snapshot(), checkpoints: [{ ...checkpoint, currentDigest: 'not-a-digest' }] })).toThrow('pi-harness-runtime-invalid')
  })
})
