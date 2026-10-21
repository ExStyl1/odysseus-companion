import { describe, expect, it } from 'bun:test';
import { SPAWN_SESSION_TOOL_INPUT_SCHEMA } from '../spawn-session-tool.ts';

describe('spawn_session tool input schema', () => {
  it('accepts every permission mode override', () => {
    for (const permissionMode of ['dontAsk', 'plan', 'default', 'acceptEdits', 'auto', 'bypassPermissions'] as const) {
      const result = SPAWN_SESSION_TOOL_INPUT_SCHEMA.safeParse({ prompt: 'Run this', permissionMode });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.permissionMode).toBe(permissionMode);
      }
    }
  });

  it('F1.1050: a model is offered the six Claude modes — the retired explore is not among them', () => {
    expect(SPAWN_SESSION_TOOL_INPUT_SCHEMA.safeParse({ prompt: 'Run this', permissionMode: 'explore' }).success).toBe(false);
  });
});
