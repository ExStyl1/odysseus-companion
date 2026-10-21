import { describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { hashAuthUserId, NestorCloudContextStore } from '../context-store.ts';

function session() {
  const sessionPath = mkdtempSync(join(tmpdir(), 'nestor-cloud-context-'));
  writeFileSync(join(sessionPath, 'session.jsonl'), '{"type":"message"}\n');
  return sessionPath;
}

function store(sessionPath = session(), overrides: Partial<ConstructorParameters<typeof NestorCloudContextStore>[0]> = {}) {
  return new NestorCloudContextStore({
    sessionPath,
    endpoint: 'https://code-completion-nestor.tcsbank.ru/api/v2/code-agent/a2a',
    connectionSlug: 'nessy-cloud-agent',
    workspaceRootPath: '/workspace',
    workingDirectory: '/workspace/app',
    authUserId: 'user-1',
    now: () => 1783340000000,
    ...overrides,
  });
}

describe('NestorCloudContextStore', () => {
  it('stores first-turn contextId and reuses it on backend restart', async () => {
    const sessionPath = session();
    const first = store(sessionPath);
    await first.update({ contextId: 'ctx-1', taskId: 'task-1', taskStatus: 'working' });

    const second = store(sessionPath);
    expect(second.load()).toMatchObject({
      contextId: 'ctx-1',
      activeTaskId: 'task-1',
      activeTaskStatus: 'working',
    });
  });

  it('uses active taskId for cancel and clears it after final status', async () => {
    const ctx = store();
    await ctx.update({ contextId: 'ctx-1', taskId: 'task-1', taskStatus: 'working' });
    await ctx.clearActiveTask('completed');

    expect(ctx.get()).toMatchObject({
      contextId: 'ctx-1',
      lastRemoteStatus: 'completed',
    });
    expect(ctx.get()?.activeTaskId).toBeUndefined();
  });

  it('resets remote context for branch/import/user-token binding changes', async () => {
    const sessionPath = session();
    await store(sessionPath).update({ contextId: 'ctx-1', taskId: 'task-1', taskStatus: 'working' });

    expect(store(sessionPath, { workingDirectory: '/workspace/branch' }).load()).toBeNull();
    expect(store(sessionPath, { authUserId: 'user-2' }).load()).toBeNull();
    expect(store(sessionPath, { connectionSlug: 'other-cloud-agent' }).load()).toBeNull();
  });

  it('persists only backend context sidecar without modifying session.jsonl', async () => {
    const sessionPath = session();
    const before = readFileSync(join(sessionPath, 'session.jsonl'), 'utf-8');
    const ctx = store(sessionPath);

    await ctx.update({ contextId: 'ctx-1', taskId: 'task-1', taskStatus: 'submitted' });

    expect(existsSync(join(sessionPath, 'meta', 'nestor-cloud-context.json'))).toBe(true);
    expect(readFileSync(join(sessionPath, 'session.jsonl'), 'utf-8')).toBe(before);
    const saved = JSON.parse(readFileSync(ctx.sidecarPath, 'utf-8'));
    expect(saved.authUserId).toBe(hashAuthUserId('user-1'));
    expect(JSON.stringify(saved)).not.toContain('Nestor-Token');
    expect(JSON.stringify(saved)).not.toContain('jwt');
  });

  it('terminal-task retry state clears activeTaskId while preserving contextId', async () => {
    const ctx = store();
    await ctx.update({ contextId: 'ctx-1', taskId: 'task-1', taskStatus: 'working' });
    await ctx.update({ clearTask: true, taskStatus: 'completed' });

    expect(ctx.get()?.contextId).toBe('ctx-1');
    expect(ctx.get()?.activeTaskId).toBeUndefined();
  });

  it('parks a terminal tool call across a restart and clears it once answered', async () => {
    const sessionPath = session();
    const first = store(sessionPath);
    await first.update({ contextId: 'ctx-1', taskId: 'task-1', taskStatus: 'input-required' });
    await first.update({ pendingTerminalTool: { toolCallId: 'call-ask', name: 'ask_followup_question' } });

    const restarted = store(sessionPath);
    expect(restarted.load()).toMatchObject({
      activeTaskId: 'task-1',
      pendingTerminalTool: { toolCallId: 'call-ask', name: 'ask_followup_question' },
    });

    await restarted.update({ clearPendingTerminalTool: true });
    expect(restarted.get()?.pendingTerminalTool).toBeUndefined();
    expect(store(sessionPath).load()?.pendingTerminalTool).toBeUndefined();
    // Clearing the parked question must not take the task with it.
    expect(restarted.get()?.activeTaskId).toBe('task-1');
  });

  it('drops the parked terminal tool when the task it belongs to is cleared', async () => {
    const ctx = store();
    await ctx.update({ contextId: 'ctx-1', taskId: 'task-1', taskStatus: 'input-required' });
    await ctx.update({ pendingTerminalTool: { toolCallId: 'call-ask', name: 'ask_followup_question' } });
    await ctx.update({ clearTask: true, taskStatus: 'completed' });

    expect(ctx.get()?.activeTaskId).toBeUndefined();
    // The parked call is addressable only by taskId, so it cannot outlive it.
    expect(ctx.get()?.pendingTerminalTool).toBeUndefined();
    expect(ctx.get()?.contextId).toBe('ctx-1');
  });

  it('corrupt or mismatched sidecar data resets remote context while preserving transcript', () => {
    const sessionPath = session();
    const ctx = store(sessionPath);
    mkdirSync(join(sessionPath, 'meta'), { recursive: true });
    writeFileSync(ctx.sidecarPath, '{not json');

    expect(ctx.load()).toBeNull();
    expect(readFileSync(join(sessionPath, 'session.jsonl'), 'utf-8')).toBe('{"type":"message"}\n');
  });
});
