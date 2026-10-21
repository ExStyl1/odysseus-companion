/* Copied verbatim from v0.13.4:apps/electron/src/renderer/components/app-shell/kanban/__tests__/subtask-merge.test.ts
   (craft-agents-oss, Apache-2.0) by UA3.6, 2026-10-02.
   UA12.69 adds the connection carry-through describe below: the merge passes a row's resolved
   connection (`KanbanSubtask.connection`) beside its model, so SubtaskRow's ModelChip draws the
   icon of the connection the model came from. */
import { describe, it, expect } from 'bun:test'
import { mergeSubtaskRows, type SpecNodeSummary, type SubtaskChildRow } from '../subtask-merge'
import { quickAddNodeId } from '../task-spec-form'

const child = (over: Partial<SubtaskChildRow> & { id: string }): SubtaskChildRow => ({
  title: over.id,
  runState: 'pending',
  model: 'm-child',
  ...over,
})

describe('mergeSubtaskRows', () => {
  it('without a spec, rows are the children sorted by creation time', () => {
    const rows = mergeSubtaskRows(
      undefined,
      [child({ id: 'c', createdAt: 3 }), child({ id: 'a', createdAt: 1 }), child({ id: 'b', createdAt: 2 })],
      'm-fallback'
    )
    expect(rows.map(r => r.id)).toEqual(['a', 'b', 'c'])
    expect(rows.every(r => r.sessionId === r.id)).toBe(true)
  })

  it('authored-but-never-run nodes render as synthetic pending rows (no session)', () => {
    const nodes: SpecNodeSummary[] = [
      { id: 'generate', title: 'Generate marker', model: 'm-node' },
      { id: 'verify', title: 'Verify marker received' },
    ]
    const rows = mergeSubtaskRows(nodes, [], 'm-fallback')
    expect(rows).toEqual([
      { id: 'node:generate', title: 'Generate marker', runState: 'pending', model: 'm-node' },
      { id: 'node:verify', title: 'Verify marker received', runState: 'pending', model: 'm-fallback' },
    ])
  })

  it('binds each node to its latest run child; superseded earlier-run children collapse', () => {
    const nodes: SpecNodeSummary[] = [{ id: 'generate', title: 'Generate' }]
    const rows = mergeSubtaskRows(
      nodes,
      [
        child({ id: 'old-run', taskNodeId: 'generate', runState: 'failed', createdAt: 1 }),
        child({ id: 'new-run', taskNodeId: 'generate', runState: 'done', createdAt: 2 }),
      ],
      'm'
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ sessionId: 'new-run', runState: 'done' })
  })

  it('an adopted quick-add node binds back to its original session via the qa- id', () => {
    const sessionId = '260703-agile-moor'
    const nodes: SpecNodeSummary[] = [{ id: quickAddNodeId(sessionId), title: 'Task 2' }]
    const rows = mergeSubtaskRows(nodes, [child({ id: sessionId, title: 'Task 2', runState: 'done' })], 'm')
    expect(rows).toEqual([{ id: sessionId, sessionId, title: 'Task 2', runState: 'done', model: 'm-child' }])
  })

  it('a run child supersedes the adopted quick-add session for the same qa- node', () => {
    const sessionId = '260703-agile-moor'
    const qaNode = quickAddNodeId(sessionId)
    const rows = mergeSubtaskRows(
      [{ id: qaNode, title: 'Task 2' }],
      [
        child({ id: sessionId, title: 'Task 2', runState: 'done', createdAt: 1 }),
        child({ id: 'run-child', taskNodeId: qaNode, runState: 'running', createdAt: 2 }),
      ],
      'm'
    )
    // One row for the node: the run child. The pre-run quick-add session collapses into it
    // (it is that node's earlier execution), never a duplicate "Task 2" row.
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ sessionId: 'run-child', runState: 'running' })
  })

  it('unadopted quick-adds and children of removed nodes append after the node rows', () => {
    const nodes: SpecNodeSummary[] = [{ id: 'generate', title: 'Generate' }]
    const rows = mergeSubtaskRows(
      nodes,
      [
        child({ id: 'quick-add', title: 'Task 3', createdAt: 2 }),
        child({ id: 'orphan', taskNodeId: 'removed-node', runState: 'done', createdAt: 1 }),
      ],
      'm'
    )
    expect(rows.map(r => r.id)).toEqual(['node:generate', 'orphan', 'quick-add'])
  })
})

describe('UA12.69 — rows carry the connection their model was resolved from', () => {
  const CONN = { providerType: 'pi', baseUrl: 'https://gw.example.test/v1' }

  it('POSITIVE — a pending node row and a child row carry connection onto KanbanSubtask', () => {
    const rows = mergeSubtaskRows(
      [{ id: 'main', title: 'Main', model: 'coder', connection: CONN }],
      [child({ id: 'c', connection: { providerType: 'codex-runtime' } })],
      'm',
    )
    expect(rows.find(r => r.id === 'node:main')?.connection).toEqual(CONN)
    expect(rows.find(r => r.id === 'c')?.connection).toEqual({ providerType: 'codex-runtime' })
  })

  it('NEGATIVE — nothing resolved carries no connection (the field stays absent, never an empty object)', () => {
    const rows = mergeSubtaskRows([{ id: 'main', title: 'Main', model: 'm' }], [child({ id: 'c' })], 'm')
    expect('connection' in rows.find(r => r.id === 'node:main')!).toBe(false)
    expect('connection' in rows.find(r => r.id === 'c')!).toBe(false)
  })
})
