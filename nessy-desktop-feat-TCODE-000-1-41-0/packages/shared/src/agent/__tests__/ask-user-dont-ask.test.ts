/**
 * R7 Task 4 — agent-sdk/user-input.md: "`AskUserQuestion` … reach[es] the
 * callback even when an allow rule matches. In `dontAsk` mode these calls are
 * denied instead, without invoking the callback."
 */
import { describe, expect, it } from 'bun:test';
import { PiAgent } from '../pi-agent.ts';
import type { BackendConfig } from '../backend/types.ts';

function createConfig(): BackendConfig {
  return {
    provider: 'pi',
    workspace: {
      id: 'ws-ask-dontask',
      name: 'Test Workspace',
      rootPath: '/tmp/ws-root',
      workspaceRootPath: '/tmp/ws-root',
      sessionRootPath: '/tmp/nessy-general-agent-test-sessions/ws-ask-dontask',
    } as any,
    session: {
      id: 'session-ask-dontask',
      workspaceRootPath: '/tmp/ws-root',
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      workingDirectory: '/tmp/project-root',
    } as any,
    model: 'pi/test-model',
    isHeadless: true,
  };
}

describe('ask_user in dontAsk mode', () => {
  it('denies outright without invoking the approval callback', async () => {
    const agent = new PiAgent(createConfig());
    try {
      agent.setPermissionMode('dontAsk');
      let published = 0;
      agent.onPermissionRequest = () => { published += 1; };

      await expect((agent as any).requestAskUserPermission(
        { question: 'Which path?', options: ['a', 'b'], allowFreeText: false },
        'req-dontask-1',
      )).rejects.toThrow(/unavailable/);
      expect(published).toBe(0);

      // Batched calls hit the same gate before any callback.
      await expect((agent as any).requestAskUserPermission(
        {
          question: 'Which path?',
          options: ['a', 'b'],
          allowFreeText: true,
          questions: [{
            question: 'Which path?',
            header: 'Path',
            options: [{ label: 'a' }, { label: 'b' }],
            multiSelect: false,
          }],
        },
        'req-dontask-2',
      )).rejects.toThrow(/unavailable/);
      expect(published).toBe(0);
    } finally {
      await agent.destroy?.();
    }
  });
});
