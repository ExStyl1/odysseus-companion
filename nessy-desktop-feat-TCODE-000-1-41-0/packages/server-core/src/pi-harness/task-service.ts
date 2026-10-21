import type { SessionKey } from '@nessy-agent/shared/sessions/session-key';
import {
  openTaskStore,
  resolveTaskListId,
  type TaskStore,
} from '@nessy-agent/shared/sessions/task-store';
import type {
  DocumentedTaskCommand,
  DocumentedTaskResult,
} from '@nessy-agent/session-tools-core';
import { reduceTaskState, type TaskCommand, type TaskState } from './vendor/rpiv-interactions/task-reducer.ts';

const empty = (): TaskState => ({ schemaVersion: 1, revision: 0, tasks: [], tombstones: [] });

/** What a task hook needs to describe the task it is deciding on. */
export interface TaskEventPayload {
  taskId: string;
  subject?: string;
  description?: string;
}

/**
 * R20: a hook may refuse a creation or a completion. `blocked` carries the
 * stderr the model is shown; `stop` is the `{continue:false}` hard stop.
 */
export interface TaskEventDecision {
  blocked?: boolean;
  reason?: string;
  stop?: boolean;
  stopReason?: string;
}

export type TaskEventName = 'TaskCreated' | 'TaskCompleted';

export type TaskEventEmitter = (
  event: TaskEventName,
  payload: TaskEventPayload,
) => void | Promise<void | TaskEventDecision | undefined>;

export class TaskService {
  private state: TaskState;
  /**
   * The R20 documented list. File-backed and shareable across sessions, so it
   * is deliberately NOT the legacy in-memory `state` above: the two tool
   * surfaces are mutually exclusive (`NESSY_ENABLE_TASKS`), and only one of
   * them is model-facing at a time.
   */
  private documented: TaskStore | undefined;

  constructor(
    readonly sessionKey: SessionKey,
    private readonly persist?: (state: TaskState) => void | Promise<void>,
    private readonly emit?: TaskEventEmitter,
    initial: TaskState = empty(),
    documentedStore?: TaskStore,
  ) {
    this.state = structuredClone(initial);
    this.documented = documentedStore;
  }

  /** Opened lazily so a session that never uses the tools writes no directory. */
  private store(): TaskStore {
    this.documented ??= openTaskStore(resolveTaskListId(this.sessionKey.sessionId));
    return this.documented;
  }

  async execute(command: TaskCommand): Promise<TaskState> {
    const previous = this.state;
    const candidate = reduceTaskState(this.state, command);
    await this.persist?.(structuredClone(candidate));
    this.state = candidate;
    const wasCompleted = command.action === 'update' && previous.tasks.find(task => task.id === command.id)?.status === 'completed';
    const event = command.action === 'create' ? 'TaskCreated' : command.action === 'update' && command.status === 'completed' && !wasCompleted ? 'TaskCompleted' : undefined;
    const eventTaskId = command.action === 'create' || command.action === 'update' ? command.id : undefined;
    if (event && eventTaskId) { try { await this.emit?.(event, { taskId: eventTaskId }); } catch {} }
    return structuredClone(this.state);
  }

  /**
   * The R20 channel. The hook runs BEFORE the write is kept, which is what makes
   * `hooks.md:708` literal: exit 2 "Rolls back the task creation" / "Prevents
   * the task from being marked as completed". A hook that fires after a commit
   * could only ever undo, and an undo is observable.
   */
  async executeDocumented(command: DocumentedTaskCommand): Promise<DocumentedTaskResult> {
    const store = this.store();
    if (command.op === 'get' || command.op === 'list') return store.run(command).result;

    if (command.op === 'create') {
      // Consult the hook with the id the create WOULD get, and only persist if
      // it allows. `store.run` is the only thing that writes, so nothing has to
      // be undone when the hook refuses — the creation simply never happens,
      // and the id is not consumed.
      const probe = store.snapshot();
      await this.gate('TaskCreated', {
        taskId: `task-${String(probe.nextId).padStart(3, '0')}`,
        subject: command.subject,
        description: command.description,
      });
      return store.run(command).result;
    }

    if (command.status === 'completed') {
      const current = store.snapshot().tasks.find(task => task.id === command.taskId && !task.deleted);
      // Only a real transition INTO completed fires the event.
      if (current && current.status !== 'completed') {
        await this.gate('TaskCompleted', {
          taskId: command.taskId,
          subject: current.subject,
          description: current.description,
        });
      }
    }
    return store.run(command).result;
  }

  /**
   * `hooks.md:2117` — TaskCompleted also fires "when an agent team teammate
   * finishes its turn with in-progress tasks", i.e. with no tool call at all.
   * A refusal here has nothing to prevent (the task is not being completed), so
   * it is consulted and its veto simply leaves the task in progress.
   */
  async notifyTurnEnd(): Promise<void> {
    for (const task of this.store().snapshot().tasks) {
      if (task.deleted || task.status !== 'in_progress') continue;
      try {
        await this.gate('TaskCompleted', {
          taskId: task.id,
          subject: task.subject,
          description: task.description,
        });
      } catch {
        // The veto is the point: nothing was being changed, so there is nothing
        // to roll back and the turn-end sweep continues to the next task.
      }
    }
  }

  /** Run the hook and throw the documented tool error when it refuses. */
  private async gate(event: TaskEventName, payload: TaskEventPayload): Promise<void> {
    const decision = await this.decide(event, payload);
    if (!decision) return;
    if (decision.stop) {
      throw new TaskHookRefusalError(decision.stopReason ?? decision.reason ?? 'Stopped by hook.');
    }
    if (decision.blocked) {
      throw new TaskHookRefusalError(decision.reason ?? 'Blocked by hook.');
    }
  }

  private async decide(event: TaskEventName, payload: TaskEventPayload): Promise<TaskEventDecision | undefined> {
    try {
      return (await this.emit?.(event, payload)) ?? undefined;
    } catch {
      // A broken hook must not break the agent flow, matching every other
      // automation emission site.
      return undefined;
    }
  }

  snapshot(): TaskState { return structuredClone(this.state); }

  /** The documented list, for the runtime snapshot and the renderer. */
  documentedSnapshot() { return this.store().snapshot(); }
}

/**
 * A hook refused the operation. `hooks.md:2904`: for `TaskCreated` "the reason
 * is returned to Claude as a tool error and the turn continues, regardless of
 * `continueOnBlock`" — so this surfaces through the tool handler's error path,
 * not as a successful result carrying `success: false`.
 */
export class TaskHookRefusalError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'TaskHookRefusalError';
  }
}
