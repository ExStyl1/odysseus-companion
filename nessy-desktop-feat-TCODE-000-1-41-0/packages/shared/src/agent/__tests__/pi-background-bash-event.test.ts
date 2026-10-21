import { describe, expect, it } from 'bun:test';
import { PiEventAdapter } from '../backend/pi/event-adapter.ts';

describe('PiEventAdapter background bash events', () => {
  it('passes synthetic shell_backgrounded events through to the renderer contract', () => {
    const adapter = new PiEventAdapter();
    const events = Array.from(adapter.adaptEvent({
      type: 'shell_backgrounded',
      toolUseId: 'toolu_bg_1',
      shellId: 'shell_test_1',
      command: 'npm run dev',
    } as any));

    expect(events).toEqual([{
      type: 'shell_backgrounded',
      toolUseId: 'toolu_bg_1',
      shellId: 'shell_test_1',
      command: 'npm run dev',
    }]);
  });

  it('passes synthetic background subagent task events through to the renderer contract', () => {
    const adapter = new PiEventAdapter();
    const backgrounded = Array.from(adapter.adaptEvent({
      type: 'task_backgrounded',
      toolUseId: 'toolu_subagent_bg',
      taskId: 'subagent-bg-1',
      kind: 'workflow',
    } as any));

    expect(backgrounded).toEqual([{
      type: 'task_backgrounded',
      toolUseId: 'toolu_subagent_bg',
      taskId: 'subagent-bg-1',
      kind: 'workflow',
    }]);

    const completed = Array.from(adapter.adaptEvent({
      type: 'task_completed',
      taskId: 'subagent-bg-1',
      status: 'stopped',
      summary: 'Stopped task subagent-bg-1',
    } as any));

    expect(completed).toEqual([{
      type: 'task_completed',
      taskId: 'subagent-bg-1',
      status: 'stopped',
      summary: 'Stopped task subagent-bg-1',
    }]);
  });
});
