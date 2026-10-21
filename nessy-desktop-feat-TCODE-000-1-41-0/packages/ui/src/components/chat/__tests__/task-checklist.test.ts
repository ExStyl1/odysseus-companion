/**
 * R20 Task 5 — the checklist rendered from the task list, not from TodoWrite.
 *
 * `agent-sdk/todo-tracking.md` § "Migrate to Task tools":
 * - "`TaskCreate` adds one item, `TaskUpdate` patches one item by `taskId`".
 * - "Accumulate items across calls, or read a snapshot from a `TaskList` tool
 *   result."
 * - "The assigned task ID is not in the `TaskCreate` input. It comes back in the
 *   matching `tool_result` as `{ task: { id, subject } }`, so capture it from
 *   the result block to key your map."
 * - "The streamed `tool_use` input is the raw shape the model emitted... Read
 *   `TaskUpdate` input fields defensively, as the samples below do, rather than
 *   assuming the canonical name is always present."
 *
 * That last point is why this file tests `id`/`task_id`/`active_form` at the
 * RENDERER: the repair happens host-side and is deliberately not reflected in
 * the stream, so the renderer sees the raw keys and must cope on its own.
 */
import { describe, expect, it } from 'bun:test'
import { extractChecklistFromActivities } from '../task-checklist'
import type { ActivityItem } from '../TurnCard'

let counter = 0

function activity(overrides: Partial<ActivityItem> = {}): ActivityItem {
  return {
    id: `activity-${++counter}`,
    type: 'tool',
    status: 'completed',
    timestamp: ++counter,
    ...overrides,
  }
}

function created(subject: string, id: string, extra: Record<string, unknown> = {}): ActivityItem {
  return activity({
    toolName: 'mcp__session__TaskCreate',
    toolInput: { subject, description: 'd', ...extra },
    content: JSON.stringify({ task: { id, subject } }),
  })
}

function updated(input: Record<string, unknown>): ActivityItem {
  return activity({ toolName: 'mcp__session__TaskUpdate', toolInput: input })
}

describe('a transcript of task tool calls renders the checklist', () => {
  it('accumulates TaskCreate results and TaskUpdate inputs', () => {
    const items = extractChecklistFromActivities([
      created('Write the parser', 'task-001'),
      created('Wire the renderer', 'task-002'),
      updated({ taskId: 'task-001', status: 'completed' }),
      updated({ taskId: 'task-002', status: 'in_progress' }),
    ])

    expect(items).toEqual([
      { id: 'task-001', content: 'Write the parser', status: 'completed' },
      { id: 'task-002', content: 'Wire the renderer', status: 'in_progress' },
    ])
  })

  it('shows the active form for an in-progress item', () => {
    const items = extractChecklistFromActivities([
      created('Run the tests', 'task-001', { activeForm: 'Running the tests' }),
      updated({ taskId: 'task-001', status: 'in_progress' }),
    ])
    expect(items[0]).toEqual({
      id: 'task-001',
      content: 'Run the tests',
      status: 'in_progress',
      activeForm: 'Running the tests',
    })
  })

  it('lets a later TaskUpdate supply or replace the active form and subject', () => {
    const items = extractChecklistFromActivities([
      created('Old subject', 'task-001'),
      updated({ taskId: 'task-001', subject: 'New subject', activeForm: 'Doing it', status: 'in_progress' }),
    ])
    expect(items[0]?.content).toBe('New subject')
    expect(items[0]?.activeForm).toBe('Doing it')
  })

  it('reads the raw model key names, because the repair never reaches the stream', () => {
    const items = extractChecklistFromActivities([
      created('First', 'task-001'),
      created('Second', 'task-002'),
      created('Third', 'task-003'),
      updated({ id: 'task-001', status: 'completed' }),
      updated({ task_id: 'task-002', status: 'in_progress', active_form: 'Working on it' }),
      updated({ taskId: 'task-003', status: 'in_progress' }),
    ])

    expect(items.map(item => item.status)).toEqual(['completed', 'in_progress', 'in_progress'])
    expect(items[1]?.activeForm).toBe('Working on it')
  })

  it("drops an item whose status became 'deleted'", () => {
    const items = extractChecklistFromActivities([
      created('Keep', 'task-001'),
      created('Drop', 'task-002'),
      updated({ taskId: 'task-002', status: 'deleted' }),
    ])
    expect(items.map(item => item.id)).toEqual(['task-001'])
  })

  it('prefers a TaskList snapshot over the accumulated map', () => {
    // A snapshot is authoritative: it is the host's own view of the list,
    // including anything created before this transcript window.
    const items = extractChecklistFromActivities([
      created('Only this one is in the transcript', 'task-009'),
      activity({
        toolName: 'mcp__session__TaskList',
        toolInput: {},
        content: JSON.stringify({
          tasks: [
            { id: 'task-001', subject: 'From an earlier turn', status: 'completed', blockedBy: [] },
            { id: 'task-009', subject: 'Only this one is in the transcript', status: 'in_progress', blockedBy: ['task-001'] },
          ],
        }),
      }),
    ])

    expect(items).toEqual([
      { id: 'task-001', content: 'From an earlier turn', status: 'completed' },
      { id: 'task-009', content: 'Only this one is in the transcript', status: 'in_progress' },
    ])
  })

  it('applies updates that came AFTER the snapshot', () => {
    const items = extractChecklistFromActivities([
      activity({
        toolName: 'mcp__session__TaskList',
        toolInput: {},
        content: JSON.stringify({ tasks: [{ id: 'task-001', subject: 'Ship', status: 'pending', blockedBy: [] }] }),
      }),
      updated({ taskId: 'task-001', status: 'completed' }),
    ])
    expect(items[0]?.status).toBe('completed')
  })

  it('ignores a create whose result has not arrived yet', () => {
    const pending = activity({
      toolName: 'mcp__session__TaskCreate',
      status: 'running',
      toolInput: { subject: 'In flight', description: 'd' },
    })
    expect(extractChecklistFromActivities([pending])).toEqual([])
  })

  it('ignores an update for an unknown id rather than inventing a row', () => {
    const items = extractChecklistFromActivities([updated({ taskId: 'task-404', status: 'completed' })])
    expect(items).toEqual([])
  })

  it('survives malformed tool results', () => {
    const items = extractChecklistFromActivities([
      activity({ toolName: 'mcp__session__TaskCreate', toolInput: { subject: 'x' }, content: 'not json' }),
      activity({ toolName: 'mcp__session__TaskList', toolInput: {}, content: '{"tasks": "nope"}' }),
    ])
    expect(items).toEqual([])
  })
})

describe('legacy TodoWrite transcripts still render', () => {
  const todoActivity = activity({
    toolName: 'TodoWrite',
    toolInput: {
      todos: [
        { content: 'First', status: 'completed' },
        { content: 'Second', status: 'in_progress', activeForm: 'Doing second' },
      ],
    },
  })

  it('a transcript with only TodoWrite activities renders from them', () => {
    expect(extractChecklistFromActivities([todoActivity])).toEqual([
      { content: 'First', status: 'completed' },
      { content: 'Second', status: 'in_progress', activeForm: 'Doing second' },
    ])
  })

  it('the newest TodoWrite wins, as before', () => {
    const older = activity({
      toolName: 'TodoWrite',
      timestamp: 1,
      toolInput: { todos: [{ content: 'Stale', status: 'pending' }] },
    })
    const newer = activity({
      toolName: 'TodoWrite',
      timestamp: 2,
      toolInput: { todos: [{ content: 'Fresh', status: 'pending' }] },
    })
    expect(extractChecklistFromActivities([newer, older]).map(item => item.content)).toEqual(['Fresh'])
  })

  it('task activities take precedence in a mixed transcript', () => {
    // A session that migrated mid-transcript must show the live list, not the
    // frozen TodoWrite snapshot that preceded it.
    const items = extractChecklistFromActivities([todoActivity, created('Migrated', 'task-001')])
    expect(items).toEqual([{ id: 'task-001', content: 'Migrated', status: 'pending' }])
  })

  it('an empty transcript yields nothing', () => {
    expect(extractChecklistFromActivities([])).toEqual([])
    expect(extractChecklistFromActivities([activity({ toolName: 'Read' })])).toEqual([])
  })
})

describe('the background-task namespace is untouched', () => {
  it('TaskOutput/TaskStop and backgrounded Task activities are not checklist items', () => {
    // Six tools share a `Task` prefix across two unrelated subsystems; only the
    // four task-list tools belong here.
    const items = extractChecklistFromActivities([
      activity({ toolName: 'Task', toolInput: { description: 'a subagent' }, isBackground: true, taskId: 'bg-1' }),
      activity({ toolName: 'TaskOutput', toolInput: { taskId: 'bg-1' } }),
      activity({ toolName: 'TaskStop', toolInput: { taskId: 'bg-1' } }),
      activity({ toolName: 'Agent', toolInput: { description: 'a subagent' } }),
    ])
    expect(items).toEqual([])
  })
})
