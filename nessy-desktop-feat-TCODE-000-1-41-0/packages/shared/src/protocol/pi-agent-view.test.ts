import { describe, expect, test } from 'bun:test'
import {
  parsePiAgentViewControlRequestV1,
  parsePiAgentViewControlResultV1,
  parsePiAgentViewPageRequestV1,
  parsePiAgentViewPageV1,
} from './pi-agent-view'

const entry = (sessionId: string, lastActivity: number) => ({
  schemaVersion: 1,
  session: { workspaceId: 'workspace-1', sessionId },
  projectLabel: 'Safe project',
  lastActivity,
  state: 'working',
  residency: 'hot',
  reasonCode: 'runtime_ready',
  task: { total: 2, active: 1, completed: 1, blocked: 0 },
  active: { children: 1, processes: 0, workflows: 1 },
  needsInput: { kind: 'permission', requestId: 'permission-1' },
  context: { mode: 'normal', inputTokens: 10, contextWindow: 100, percent: 10, stale: false },
  capabilityGeneration: 'generation-1',
  settlement: { schemaVersion: 1, settled: false, pending: ['permission'] },
  receiptCount: 3,
})

describe('Pi Agent View protocol', () => {
  test('accepts bounded ordered pages and strict controls', () => {
    const page = parsePiAgentViewPageV1({ schemaVersion: 1, items: [entry('a', 20), entry('b', 10)], nextCursor: 'cursor_1' })
    expect(page.items.map(item => item.session.sessionId)).toEqual(['a', 'b'])
    expect(parsePiAgentViewPageRequestV1({ schemaVersion: 1, cursor: 'cursor_1', limit: 50 })).toEqual({ schemaVersion: 1, cursor: 'cursor_1', limit: 50 })
    expect(parsePiAgentViewControlRequestV1({ schemaVersion: 1, session: { workspaceId: 'workspace-1', sessionId: 'a' }, action: 'resume' }).action).toBe('resume')
    expect(parsePiAgentViewControlResultV1({ schemaVersion: 1, ok: true, session: { workspaceId: 'workspace-1', sessionId: 'a' } }).ok).toBeTrue()
  })

  test('rejects unbounded, unordered and sensitive/path-bearing projections', () => {
    expect(() => parsePiAgentViewPageRequestV1({ schemaVersion: 1, limit: 51 })).toThrow('pi-agent-view-invalid')
    expect(() => parsePiAgentViewPageV1({ schemaVersion: 1, items: [entry('a', 10), entry('b', 20)] })).toThrow('pi-agent-view-invalid')
    expect(() => parsePiAgentViewPageV1({ schemaVersion: 1, items: [{ ...entry('a', 10), projectLabel: '/private/project' }] })).toThrow('pi-agent-view-invalid')
    expect(() => parsePiAgentViewPageV1({ schemaVersion: 1, items: [{ ...entry('a', 10), rawPrompt: 'secret' }] })).toThrow('pi-agent-view-invalid')
    expect(() => parsePiAgentViewControlRequestV1({ schemaVersion: 1, session: { workspaceId: 'workspace-1', sessionId: 'a' }, action: 'restart' })).toThrow('pi-agent-view-invalid')
  })
})
