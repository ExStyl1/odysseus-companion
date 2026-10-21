import type { PiTaskRecordV1, PiTaskStateV1, PiTaskStatusV1 } from '@nessy-agent/shared/sessions/types';

export type TaskStatus = PiTaskStatusV1;
export type TaskRecord = PiTaskRecordV1;
export type TaskState = PiTaskStateV1;

export type TaskCommand =
  | { action: 'create'; id: string; title: string; blockedBy?: readonly string[] }
  | { action: 'update'; id: string; title?: string; status?: Exclude<TaskStatus, 'deleted'>; blockedBy?: readonly string[]; revision?: number }
  | { action: 'delete'; id: string; revision?: number }
  | { action: 'list' };

const clone = (state: TaskState): TaskState => structuredClone(state);

function validateGraph(tasks: readonly TaskRecord[]): void {
  const byId = new Map(tasks.map(task => [task.id, task]));
  for (const task of tasks) {
    for (const dependency of task.blockedBy) {
      if (dependency === task.id) throw new Error('self-dependency');
      if (!byId.has(dependency)) throw new Error('dangling-dependency');
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) throw new Error('cycle');
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of byId.get(id)!.blockedBy) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const task of tasks) visit(task.id);
}

export function reduceTaskState(previous: TaskState, command: TaskCommand): TaskState {
  if (command.action === 'list') return clone(previous);
  if (!command.id?.trim()) throw new Error('invalid-task-id');
  const expectedRevision = 'revision' in command ? command.revision : undefined;
  if (expectedRevision !== undefined && expectedRevision !== previous.revision) throw new Error('stale-revision');
  const next = clone(previous);
  const index = next.tasks.findIndex(task => task.id === command.id);
  if (command.action === 'create') {
    if (index >= 0) throw new Error('duplicate-task');
    if (next.tombstones.includes(command.id)) throw new Error('tombstone-id-reuse');
    if (typeof command.title !== 'string' || !command.title.trim()) throw new Error('invalid-task-title');
    next.tasks = [...next.tasks, { id: command.id, title: command.title.trim(), status: 'pending', blockedBy: [...(command.blockedBy ?? [])] }];
  } else if (command.action === 'delete') {
    if (index < 0) throw new Error('unknown-task');
    next.tasks = next.tasks.filter(task => task.id !== command.id);
    next.tombstones = [...next.tombstones, command.id];
  } else {
    if (index < 0) throw new Error('unknown-task');
    if (command.title !== undefined && !command.title.trim()) throw new Error('invalid-task-title');
    const current = next.tasks[index]!;
    if (current.status === 'completed' && command.status && command.status !== 'completed') throw new Error('illegal-transition');
    next.tasks = next.tasks.map(task => task.id === command.id ? {
      ...task,
      ...(command.title === undefined ? {} : { title: command.title.trim() }),
      ...(command.status === undefined ? {} : { status: command.status }),
      ...(command.blockedBy === undefined ? {} : { blockedBy: [...command.blockedBy] }),
    } : task);
  }
  validateGraph(next.tasks);
  return { ...next, revision: previous.revision + 1 };
}
