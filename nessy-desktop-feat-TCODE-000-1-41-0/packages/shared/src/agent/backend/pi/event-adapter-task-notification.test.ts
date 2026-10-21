/**
 * R10 MCP auto-background: the subprocess emits `task_notification` when a
 * detached MCP call settles. The adapter must pass it through to the host
 * (SessionManager routes it into the R3 task-notification delivery) and drop
 * malformed shapes.
 */
import { describe, it, expect, beforeEach } from 'bun:test';
import { PiEventAdapter } from './event-adapter.ts';

function collect<T>(gen: Generator<T>): T[] {
  return [...gen];
}

describe('PiEventAdapter — task_notification passthrough', () => {
  let adapter: PiEventAdapter;

  beforeEach(() => {
    adapter = new PiEventAdapter();
    adapter.startTurn();
  });

  it('forwards taskId + text', () => {
    const events = collect(adapter.adaptEvent({
      type: 'task_notification',
      taskId: 'task-mcp-1',
      text: 'MCP task task-mcp-1 settled: result body',
    } as any));

    expect(events).toEqual([{
      type: 'task_notification',
      taskId: 'task-mcp-1',
      text: 'MCP task task-mcp-1 settled: result body',
    }]);
  });

  it('drops a shape without taskId or text', () => {
    expect(collect(adapter.adaptEvent({ type: 'task_notification', taskId: 'task-mcp-1' } as any))).toEqual([]);
    expect(collect(adapter.adaptEvent({ type: 'task_notification', text: 'orphan' } as any))).toEqual([]);
  });

  it('accepts the mcp kind on task_backgrounded', () => {
    const events = collect(adapter.adaptEvent({
      type: 'task_backgrounded',
      toolUseId: 'call-1',
      taskId: 'task-mcp-1',
      kind: 'mcp',
    } as any));
    expect(events).toEqual([{
      type: 'task_backgrounded',
      toolUseId: 'call-1',
      taskId: 'task-mcp-1',
      kind: 'mcp',
    }]);
  });
});
