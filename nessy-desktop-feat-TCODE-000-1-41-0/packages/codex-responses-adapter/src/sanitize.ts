/**
 * Local mirror of `unified-network-interceptor.ts:sanitizeOpenAiHistoryInPlace`
 * (that module is Pi-only and patches `globalThis.fetch`, so we do not import
 * it). Drops assistant `tool_calls` with an empty/missing `id`, and orphan
 * `role:"tool"` results referencing them — otherwise replayed history that lost
 * a `call_id` 400s at the gateway.
 */
export interface ChatMessage {
  role?: string;
  content?: unknown;
  tool_call_id?: string;
  tool_calls?: Array<{ id?: string; type?: string; function?: { name?: string; arguments?: string } }>;
}

export function sanitizeOpenAiHistoryInPlace(body: { messages?: ChatMessage[] }): {
  droppedToolCalls: number;
  droppedToolResults: number;
} {
  const messages = body.messages;
  if (!Array.isArray(messages)) return { droppedToolCalls: 0, droppedToolResults: 0 };

  let droppedToolCalls = 0;
  const knownIds = new Set<string>();

  for (const message of messages) {
    if (message.role === 'assistant' && Array.isArray(message.tool_calls)) {
      const cleaned = message.tool_calls.filter((tc) => {
        if (typeof tc.id !== 'string' || tc.id === '') {
          droppedToolCalls++;
          return false;
        }
        knownIds.add(tc.id);
        return true;
      });
      if (cleaned.length !== message.tool_calls.length) {
        if (cleaned.length === 0) delete message.tool_calls;
        else message.tool_calls = cleaned;
      }
    }
  }

  let droppedToolResults = 0;
  if (droppedToolCalls > 0) {
    const filtered = messages.filter((message) => {
      if (message.role !== 'tool') return true;
      const tcid = typeof message.tool_call_id === 'string' ? message.tool_call_id : '';
      if (!tcid || !knownIds.has(tcid)) {
        droppedToolResults++;
        return false;
      }
      return true;
    });
    if (filtered.length !== messages.length) body.messages = filtered;
  }

  return { droppedToolCalls, droppedToolResults };
}
