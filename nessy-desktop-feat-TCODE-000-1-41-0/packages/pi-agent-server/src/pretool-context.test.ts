import { describe, expect, it } from 'bun:test';
import { appendPreToolUseAdditionalContext } from './pretool-context.ts';

describe('PreToolUse additional context delivery', () => {
  it('adds hook context to model-visible tool result content', () => {
    const result = appendPreToolUseAdditionalContext(
      {
        content: [{ type: 'text', text: 'tool output' }],
        details: { ok: true },
      },
      'Prefer the safer argument rewrite.',
    );

    expect(result.content).toEqual([
      {
        type: 'text',
        text: '<pre_tool_use_context>\nPrefer the safer argument rewrite.\n</pre_tool_use_context>\n\n',
      },
      { type: 'text', text: 'tool output' },
    ]);
    expect(result.details).toEqual({ ok: true });
  });
});
