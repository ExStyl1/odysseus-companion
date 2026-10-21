import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { A2ATaskState, NestorPendingTerminalTool } from './types.ts';

export interface NestorCloudContextBindings {
  sessionPath: string;
  endpoint: string;
  connectionSlug?: string;
  workspaceRootPath: string;
  workingDirectory: string;
  authUserId?: string;
  now?: () => number;
}

export interface NestorCloudContextSidecar {
  version: 1;
  provider: 'nestor-cloud-agent';
  endpoint: string;
  connectionSlug?: string;
  workspaceRootPath: string;
  workingDirectory: string;
  authUserId?: string;
  contextId?: string;
  activeTaskId?: string;
  activeTaskStatus?: A2ATaskState;
  lastRemoteStatus?: A2ATaskState;
  /**
   * A terminal tool call awaiting the user's answer (F5). Addressed by
   * `activeTaskId` on the continuation, so it never outlives it.
   */
  pendingTerminalTool?: NestorPendingTerminalTool;
  updatedAt: number;
}

export interface NestorCloudContextUpdate {
  contextId?: string;
  taskId?: string;
  taskStatus?: A2ATaskState;
  clearTask?: boolean;
  pendingTerminalTool?: NestorPendingTerminalTool;
  clearPendingTerminalTool?: boolean;
}

export class NestorCloudContextStore {
  readonly sidecarPath: string;
  private state: NestorCloudContextSidecar | null = null;
  private readonly now: () => number;

  constructor(private readonly bindings: NestorCloudContextBindings) {
    this.sidecarPath = join(bindings.sessionPath, 'meta', 'nestor-cloud-context.json');
    this.now = bindings.now ?? (() => Date.now());
  }

  load(): NestorCloudContextSidecar | null {
    if (!existsSync(this.sidecarPath)) {
      this.state = null;
      return null;
    }

    try {
      const parsed = JSON.parse(readFileSync(this.sidecarPath, 'utf-8')) as NestorCloudContextSidecar;
      if (!this.matchesBindings(parsed)) {
        this.state = null;
        return null;
      }
      this.state = parsed;
      return parsed;
    } catch {
      this.state = null;
      return null;
    }
  }

  get(): NestorCloudContextSidecar | null {
    return this.state ?? this.load();
  }

  async update(update: NestorCloudContextUpdate): Promise<NestorCloudContextSidecar> {
    const base = this.get() ?? this.createEmpty();
    const next: NestorCloudContextSidecar = {
      ...base,
      ...(update.contextId ? { contextId: update.contextId } : {}),
      ...(update.clearTask ? { activeTaskId: undefined } : update.taskId ? { activeTaskId: update.taskId } : {}),
      ...(update.taskStatus ? { activeTaskStatus: update.taskStatus, lastRemoteStatus: update.taskStatus } : {}),
      ...(update.pendingTerminalTool ? { pendingTerminalTool: update.pendingTerminalTool } : {}),
      updatedAt: this.now(),
    };
    if (update.clearTask) {
      delete next.activeTaskId;
    }
    // The parked call is answered by `taskId` on the continuation, so losing the
    // task loses the call with it — keeping it would produce a tool result the
    // backend has nowhere to attach.
    if (update.clearPendingTerminalTool || update.clearTask) {
      delete next.pendingTerminalTool;
    }
    this.state = next;
    await this.write(next);
    return next;
  }

  async reset(): Promise<void> {
    this.state = null;
    await rm(this.sidecarPath, { force: true });
  }

  async clearActiveTask(status?: A2ATaskState): Promise<NestorCloudContextSidecar> {
    return this.update({ clearTask: true, taskStatus: status });
  }

  createEmpty(): NestorCloudContextSidecar {
    return {
      version: 1,
      provider: 'nestor-cloud-agent',
      endpoint: this.bindings.endpoint,
      ...(this.bindings.connectionSlug ? { connectionSlug: this.bindings.connectionSlug } : {}),
      workspaceRootPath: this.bindings.workspaceRootPath,
      workingDirectory: this.bindings.workingDirectory,
      ...(this.bindings.authUserId ? { authUserId: hashAuthUserId(this.bindings.authUserId) } : {}),
      updatedAt: this.now(),
    };
  }

  private matchesBindings(state: NestorCloudContextSidecar): boolean {
    return state.version === 1
      && state.provider === 'nestor-cloud-agent'
      && state.endpoint === this.bindings.endpoint
      && state.connectionSlug === this.bindings.connectionSlug
      && state.workspaceRootPath === this.bindings.workspaceRootPath
      && state.workingDirectory === this.bindings.workingDirectory
      && state.authUserId === (this.bindings.authUserId ? hashAuthUserId(this.bindings.authUserId) : undefined);
  }

  private async write(state: NestorCloudContextSidecar): Promise<void> {
    await mkdir(dirname(this.sidecarPath), { recursive: true });
    await writeFile(this.sidecarPath, `${JSON.stringify(state, null, 2)}\n`, 'utf-8');
  }
}

export function hashAuthUserId(userId: string): string {
  return createHash('sha256').update(userId).digest('hex');
}
