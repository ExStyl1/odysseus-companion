/**
 * UB9.8 — the `task_progress` half of craft-agents-oss `v0.15.1:packages/shared/src/agent/backend/claude/task-notification.ts`
 * (Apache-2.0; first in v0.15.0). Upstream's `classifyClaudeTaskNotification` is not ported: our adapter reads a
 * `task_notification` inline (`ClaudeEventAdapter`, its `task_notification` branch), and both doors already share
 * that one reading (the between-turns door adapts the message through the same adapter).
 *
 * One classifier, two doors: the in-turn adapter (`ClaudeEventAdapter`, its `task_progress` branch) and the
 * between-turns door (`ClaudeAgent.noteBetweenTurnsMessage`) both read the SDK message through it, so their
 * validation cannot drift.
 */

/** What a running task is doing, from the SDK's `task_progress` system message. */
export interface ClaudeTaskActivity {
  taskId: string;
  toolUseId?: string;
  /**
   * One-line status: the agent's progress summary (`agentProgressSummaries`, OFF here since F1.901/F1.919, so in
   * practice absent for an agent) or an MCP task's own status.
   */
  summary?: string;
  lastToolName?: string;
  toolUses?: number;
}

/**
 * Read the SDK's `task_progress` shape (vendored `sdk.d.ts` `SDKTaskProgressMessage`). Null for anything else,
 * and for a progress message with no task id.
 */
export function classifyClaudeTaskProgress(message: unknown): ClaudeTaskActivity | null {
  const candidate = message as {
    type?: unknown;
    subtype?: unknown;
    task_id?: unknown;
    tool_use_id?: unknown;
    summary?: unknown;
    last_tool_name?: unknown;
    usage?: { tool_uses?: unknown } | null;
  } | null | undefined;

  if (candidate?.type !== 'system' || candidate.subtype !== 'task_progress') return null;
  if (typeof candidate.task_id !== 'string' || candidate.task_id.length === 0) return null;
  const toolUses = candidate.usage?.tool_uses;
  return {
    taskId: candidate.task_id,
    ...(typeof candidate.tool_use_id === 'string' && candidate.tool_use_id ? { toolUseId: candidate.tool_use_id } : {}),
    ...(typeof candidate.summary === 'string' && candidate.summary.trim() ? { summary: candidate.summary.trim() } : {}),
    ...(typeof candidate.last_tool_name === 'string' && candidate.last_tool_name ? { lastToolName: candidate.last_tool_name } : {}),
    ...(typeof toolUses === 'number' && Number.isFinite(toolUses) ? { toolUses } : {}),
  };
}
