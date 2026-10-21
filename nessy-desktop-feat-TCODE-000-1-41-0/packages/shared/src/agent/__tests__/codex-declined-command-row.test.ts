/**
 * F1.1268 (origin: the final CDP sitting SIT2-f, triage D-22c) — a codex command whose escalation the user DECLINED
 * showed its Bash row as completed.
 *
 * codex's own item status says what happened: `CommandExecutionStatus` and `PatchApplyStatus`
 * (`codex-protocol/generated/v2`) are `"inProgress" | "completed" | "failed" | "declined"`. A declined command never
 * ran, so it has no exit code, and the adapter decided the row's error flag from the exit code alone. The row now
 * ends as an error when codex says `declined` (or `failed`), and an empty result reads codex's own word.
 */
import { describe, expect, it } from 'bun:test';
import { CodexEventAdapter } from '../backend/codex/event-adapter.ts';

function completed(item: Record<string, unknown>): Record<string, unknown> | undefined {
  const adapter = new CodexEventAdapter();
  adapter.adapt('item/started', { item: { ...item, status: 'inProgress' } });
  return adapter.adapt('item/completed', { item })[0] as Record<string, unknown> | undefined;
}

describe('F1.1268 — a declined codex command or edit ends as an error row', () => {
  it('a declined commandExecution (no exit code, no output) is an error whose text says declined', () => {
    const row = completed({ type: 'commandExecution', id: 'c-declined', command: 'rm -rf build', status: 'declined', exitCode: null, aggregatedOutput: null });
    expect(row).toMatchObject({ type: 'tool_result', toolUseId: 'c-declined', toolName: 'Bash', isError: true, result: 'declined' });
  });

  it('a failed commandExecution with no exit code is an error too', () => {
    const row = completed({ type: 'commandExecution', id: 'c-failed', command: 'make', status: 'failed', exitCode: null, aggregatedOutput: 'spawn failed' });
    expect(row).toMatchObject({ isError: true, result: 'spawn failed' });
  });

  it('a declined fileChange is an error row', () => {
    const row = completed({ type: 'fileChange', id: 'f-declined', changes: [{ path: 'a.ts' }], status: 'declined' });
    expect(row).toMatchObject({ type: 'tool_result', toolName: 'Edit', isError: true, result: 'declined' });
  });

  it('NEGATIVE — a completed command with exit 0 (and status completed) stays a success with its output', () => {
    const row = completed({ type: 'commandExecution', id: 'c-ok', command: 'ls', status: 'completed', exitCode: 0, aggregatedOutput: 'a.ts\n' });
    expect(row).toMatchObject({ isError: false, result: 'a.ts\n' });
  });
});
