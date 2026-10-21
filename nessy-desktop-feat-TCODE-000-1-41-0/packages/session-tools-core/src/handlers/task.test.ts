import { describe, expect, test } from 'bun:test';
import { handleTask } from './task.ts';
import { TaskSchema } from '../tool-defs.ts';

describe('handleTask', () => {
  test('uses only the injected host task port', async () => {
    const result = await handleTask({ taskPort: { execute: async (args: Record<string, unknown>) => ({ args }) } } as any, { action: 'list' });
    expect(result.isError).toBe(false);
    expect(result.content[0]?.text).toContain('list');
  });

  test('enforces action-specific canonical input before dispatch', () => {
    for (const input of [
      { action: 'create', id: 'a' },
      { action: 'create', id: 'a', title: '   ' },
      { action: 'update', id: 'a', title: '   ' },
      { action: 'delete' },
      { action: 'list', id: 'a' },
    ]) expect(TaskSchema.safeParse(input).success).toBe(false);
    expect(TaskSchema.safeParse({ action: 'create', id: 'a', title: 'A' }).success).toBe(true);
  });
});
