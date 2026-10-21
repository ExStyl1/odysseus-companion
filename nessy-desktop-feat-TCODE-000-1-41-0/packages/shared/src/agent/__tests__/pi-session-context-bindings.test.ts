/**
 * Construction-level guard for the host seams a Pi session's tool context must
 * expose.
 *
 * D3 shipped `source_manage` with its removal seam threaded ONLY through
 * `session-scoped-tools.ts`. Pi builds its own context (`pi-agent.ts`
 * `sessionToolContext`), so on a real Pi session `disable` worked and `remove`
 * answered "Removing a source is not available in this context." forever —
 * invisible to handler tests, which stub `ctx.removeSource` directly. Measured
 * live 2026-08-14 on the owner's profile; this test is the thing that would
 * have caught it.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const source = readFileSync(fileURLToPath(new URL('../pi-agent.ts', import.meta.url)), 'utf8');

describe('the Pi-built session tool context', () => {
  it('passes every host seam `source_manage` needs into createClaudeContext', () => {
    const call = source.slice(
      source.indexOf('createClaudeContext({'),
      source.indexOf('this._sessionToolContext.taskPort'),
    );
    expect(call).toContain('onRemoveSource');
    // Positive control: the seams that were already there are read the same way.
    expect(call).toContain('onPlanSubmitted');
    expect(call).toContain('onAuthRequest');
  });

  it('resolves the removal callback from the session-scoped registry, not a local closure', () => {
    const call = source.slice(source.indexOf('onRemoveSource'), source.indexOf('this._sessionToolContext.taskPort'));
    // SessionManager owns the three-op cleanup; Pi must not reimplement it.
    expect(call).toContain('getSessionScopedToolCallbacks');
    expect(call).toContain('removeSourceFn');
  });
});
