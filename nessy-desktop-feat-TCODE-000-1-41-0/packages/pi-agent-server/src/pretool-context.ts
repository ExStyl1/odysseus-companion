import type { AgentToolResult } from '@earendil-works/pi-coding-agent';

export interface PreToolUseApproval {
  input: Record<string, unknown>;
  additionalContext?: string;
}

export function appendPreToolUseAdditionalContext<T>(
  result: AgentToolResult<T>,
  additionalContext: string | undefined,
): AgentToolResult<T> {
  const trimmed = additionalContext?.trim();
  if (!trimmed) return result;

  return {
    ...result,
    content: [
      {
        type: 'text',
        text: `<pre_tool_use_context>\n${trimmed}\n</pre_tool_use_context>\n\n`,
      },
      ...result.content,
    ],
  };
}
