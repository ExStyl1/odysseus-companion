/**
 * The documented task list (R20).
 *
 * One reducer owns every semantic the four tools expose, so `TaskList` can only
 * report what `TaskCreate`/`TaskUpdate` actually wrote. Splitting these — a
 * handler that writes one store while the read side reads another — is the
 * defect this series has shipped fifteen times.
 *
 * Contract source, `agent-sdk/typescript.md:2110-2160` (inputs) and `:2682-2740`
 * (outputs), plus `agent-sdk/todo-tracking.md` § "Migrate to Task tools":
 * - The HARNESS assigns the id. "The assigned task ID is not in the `TaskCreate`
 *   input. It comes back in the matching `tool_result` as `{ task: { id, subject } }`."
 * - Dependencies are ADDITIVE: the write side has only `addBlocks`/`addBlockedBy`,
 *   never a wholesale set. The read side exposes both `blocks` and `blockedBy`.
 * - `deleted` is a STATUS on `TaskUpdate`, not a separate operation — but it is
 *   NOT one of the three read-side statuses, so a deleted task leaves the list.
 * - `TaskGet` returns `null` on a miss. That is not an error.
 *
 * State is a plain JSON value on purpose: Task 3 persists it verbatim, so the
 * shape here is the on-disk shape.
 */

/** The three statuses a task can be READ as (`typescript.md:2721`). */
export type DocumentedTaskStatus = 'pending' | 'in_progress' | 'completed';

/** What `TaskUpdate.status` accepts — the three above plus the delete verb. */
export type DocumentedTaskStatusInput = DocumentedTaskStatus | 'deleted';

export interface DocumentedTaskRecord {
  id: string;
  subject: string;
  description: string;
  activeForm?: string;
  status: DocumentedTaskStatus;
  owner?: string;
  metadata?: Record<string, unknown>;
  /** Tasks this one blocks. Maintained as the reverse of `blockedBy`. */
  blocks: string[];
  /** Tasks blocking this one. Maintained as the reverse of `blocks`. */
  blockedBy: string[];
  /**
   * `status: 'deleted'` is a tombstone, not a splice: the id stays reserved so a
   * later create can never reuse it and resurrect a stale dependency edge.
   */
  deleted?: true;
}

export interface DocumentedTaskListState {
  schemaVersion: 1;
  /** Monotonic; never rewound by a delete. */
  nextId: number;
  tasks: DocumentedTaskRecord[];
}

export type DocumentedTaskCommand =
  | {
      op: 'create';
      subject: string;
      description: string;
      activeForm?: string;
      metadata?: Record<string, unknown>;
    }
  | {
      op: 'update';
      taskId: string;
      status?: DocumentedTaskStatusInput;
      subject?: string;
      description?: string;
      activeForm?: string;
      addBlocks?: string[];
      addBlockedBy?: string[];
      owner?: string;
      metadata?: Record<string, unknown>;
    }
  | { op: 'get'; taskId: string }
  | { op: 'list' };

/** `typescript.md:2682` */
export interface DocumentedTaskCreateOutput {
  task: { id: string; subject: string };
}

/** `typescript.md:2697` */
export interface DocumentedTaskUpdateOutput {
  success: boolean;
  taskId: string;
  updatedFields: string[];
  error?: string;
  statusChange?: { from: string; to: string };
}

/** `typescript.md:2716` — six keys, and `null` on a miss. */
export interface DocumentedTaskGetOutput {
  task: {
    id: string;
    subject: string;
    description: string;
    status: DocumentedTaskStatus;
    blocks: string[];
    blockedBy: string[];
  } | null;
}

/** `typescript.md:2735` — note there is no `blocks` on this side. */
export interface DocumentedTaskListOutput {
  tasks: Array<{
    id: string;
    subject: string;
    status: DocumentedTaskStatus;
    owner?: string;
    blockedBy: string[];
  }>;
}

export type DocumentedTaskResult =
  | DocumentedTaskCreateOutput
  | DocumentedTaskUpdateOutput
  | DocumentedTaskGetOutput
  | DocumentedTaskListOutput;

export function createDocumentedTaskState(): DocumentedTaskListState {
  return { schemaVersion: 1, nextId: 1, tasks: [] };
}

/**
 * `task-001`, matching the id shape the hook payload samples use (`hooks.md:2077`).
 *
 * Exported so the host store can CLAIM an id on disk with the identical shape
 * before running the command: a store that formatted ids itself would drift
 * from the reducer the moment either changed.
 */
export function formatTaskId(sequence: number): string {
  return `task-${String(sequence).padStart(3, '0')}`;
}

function visible(state: DocumentedTaskListState): DocumentedTaskRecord[] {
  return state.tasks.filter(task => !task.deleted);
}

function findVisible(state: DocumentedTaskListState, taskId: string): DocumentedTaskRecord | undefined {
  return state.tasks.find(task => task.id === taskId && !task.deleted);
}

/** Add without duplicating. The documented verb is `add*`, never "set". */
function addEdge(edges: string[], id: string): string[] {
  return edges.includes(id) ? edges : [...edges, id];
}

export interface DocumentedTaskOutcome {
  state: DocumentedTaskListState;
  result: DocumentedTaskResult;
}

function readSide(task: DocumentedTaskRecord): NonNullable<DocumentedTaskGetOutput['task']> {
  return {
    id: task.id,
    subject: task.subject,
    description: task.description,
    status: task.status,
    blocks: [...task.blocks],
    blockedBy: [...task.blockedBy],
  };
}

function listSide(state: DocumentedTaskListState): DocumentedTaskListOutput {
  return {
    tasks: visible(state).map(task => ({
      id: task.id,
      subject: task.subject,
      status: task.status,
      // `owner?` is optional in the documented row — absent, not null, when unset.
      ...(task.owner === undefined ? {} : { owner: task.owner }),
      blockedBy: [...task.blockedBy],
    })),
  };
}

function updateFailure(taskId: string, error: string): DocumentedTaskUpdateOutput {
  return { success: false, taskId, updatedFields: [], error };
}

function applyCreate(
  state: DocumentedTaskListState,
  command: Extract<DocumentedTaskCommand, { op: 'create' }>,
): DocumentedTaskOutcome {
  // The model may have sent an `id`. It is not in the documented input and is
  // never trusted: the harness mints the id and returns it in the result.
  const id = formatTaskId(state.nextId);
  const task: DocumentedTaskRecord = {
    id,
    subject: command.subject,
    description: command.description,
    ...(command.activeForm === undefined ? {} : { activeForm: command.activeForm }),
    status: 'pending',
    ...(command.metadata === undefined ? {} : { metadata: command.metadata }),
    blocks: [],
    blockedBy: [],
  };
  return {
    state: { ...state, nextId: state.nextId + 1, tasks: [...state.tasks, task] },
    result: { task: { id, subject: task.subject } },
  };
}

function applyUpdate(
  state: DocumentedTaskListState,
  command: Extract<DocumentedTaskCommand, { op: 'update' }>,
): DocumentedTaskOutcome {
  const target = findVisible(state, command.taskId);
  if (!target) {
    return { state, result: updateFailure(command.taskId, `Unknown task: ${command.taskId}`) };
  }

  const tasks = state.tasks.map(task => ({ ...task, blocks: [...task.blocks], blockedBy: [...task.blockedBy] }));
  const byId = new Map(tasks.map(task => [task.id, task]));
  const next = byId.get(command.taskId)!;
  const updatedFields: string[] = [];
  let statusChange: { from: string; to: string } | undefined;

  if (command.subject !== undefined && command.subject !== next.subject) {
    next.subject = command.subject;
    updatedFields.push('subject');
  }
  if (command.description !== undefined && command.description !== next.description) {
    next.description = command.description;
    updatedFields.push('description');
  }
  if (command.activeForm !== undefined && command.activeForm !== next.activeForm) {
    next.activeForm = command.activeForm;
    updatedFields.push('activeForm');
  }
  if (command.owner !== undefined && command.owner !== next.owner) {
    next.owner = command.owner;
    updatedFields.push('owner');
  }
  if (command.metadata !== undefined) {
    next.metadata = command.metadata;
    updatedFields.push('metadata');
  }

  // Additive in BOTH directions: each verb writes its own edge and the reverse
  // one, so `TaskGet` on either end reports the relationship.
  for (const blocked of command.addBlocks ?? []) {
    const other = byId.get(blocked);
    if (!other || other.deleted) continue;
    next.blocks = addEdge(next.blocks, blocked);
    other.blockedBy = addEdge(other.blockedBy, next.id);
    if (!updatedFields.includes('addBlocks')) updatedFields.push('addBlocks');
  }
  for (const blocker of command.addBlockedBy ?? []) {
    const other = byId.get(blocker);
    if (!other || other.deleted) continue;
    next.blockedBy = addEdge(next.blockedBy, blocker);
    other.blocks = addEdge(other.blocks, next.id);
    if (!updatedFields.includes('addBlockedBy')) updatedFields.push('addBlockedBy');
  }

  if (command.status !== undefined) {
    const from = next.status;
    if (command.status === 'deleted') {
      next.deleted = true;
      // Drop the edges pointing at a task nobody can read any more.
      for (const task of tasks) {
        task.blocks = task.blocks.filter(id => id !== next.id);
        task.blockedBy = task.blockedBy.filter(id => id !== next.id);
      }
      updatedFields.push('status');
      statusChange = { from, to: 'deleted' };
    } else if (command.status !== from) {
      next.status = command.status;
      updatedFields.push('status');
      statusChange = { from, to: command.status };
    }
  }

  return {
    state: { ...state, tasks },
    result: {
      success: true,
      taskId: command.taskId,
      updatedFields,
      ...(statusChange ? { statusChange } : {}),
    },
  };
}

/**
 * The single entry point. Pure: it returns the next state rather than mutating,
 * so a caller can run a command, consult a hook, and discard the result — which
 * is exactly how `TaskCreated` rolls a creation back.
 */
export function runDocumentedTaskCommand(
  state: DocumentedTaskListState,
  command: DocumentedTaskCommand,
): DocumentedTaskOutcome {
  switch (command.op) {
    case 'create':
      return applyCreate(state, command);
    case 'update':
      return applyUpdate(state, command);
    case 'get': {
      const task = findVisible(state, command.taskId);
      return { state, result: { task: task ? readSide(task) : null } };
    }
    case 'list':
      return { state, result: listSide(state) };
  }
}

/** Read-only helpers the host needs for hook payloads and the renderer. */
export function getDocumentedTask(
  state: DocumentedTaskListState,
  taskId: string,
): DocumentedTaskRecord | undefined {
  return findVisible(state, taskId);
}

export function listDocumentedTasks(state: DocumentedTaskListState): DocumentedTaskRecord[] {
  return visible(state).map(task => ({ ...task, blocks: [...task.blocks], blockedBy: [...task.blockedBy] }));
}
