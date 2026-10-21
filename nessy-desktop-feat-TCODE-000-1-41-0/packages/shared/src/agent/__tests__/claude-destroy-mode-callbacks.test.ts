/**
 * F1.397 (origin WJ-ff P-WJ-ff-3) — a destroyed claude agent's mode CALLBACKS
 * leave the mode manager with it; a newer agent's callbacks on the same session
 * stay.
 *
 * ## What was measured first
 *
 * `ClaudeAgent`'s constructor registers `{ onStateChange }` for its session
 * through `initializeModeState`; since F1.257 its `destroy()` keeps the HOST's
 * mode entry and nulls only its own echo (`onPermissionModeChange`), so the
 * registration stayed in `modeManager` — inert, but holding the destroyed agent
 * — until the next claude agent on the session replaced it or the session was
 * deleted. After claude → Pi there is no next claude agent. The DEFECT arm reads
 * the registration after `destroy()`, before any fix.
 *
 * ## CONTROLS
 *
 * The registration is removed only while it is still the destroyed agent's: a
 * respawned agent's callbacks survive the OLD agent's late `destroy()` (an
 * unconditional unregister would fail this arm). And the host's mode entry
 * survives both (F1.257's contract).
 */
import { describe, expect, it } from 'bun:test';
import type { BackendConfig } from '../backend/types.ts';
import { ClaudeAgent } from '../claude-agent.ts';
import { getPermissionMode, modeManager, setPermissionMode } from '../mode-manager.ts';
import { encodeSessionKey } from '../../sessions/session-key.ts';

function createConfig(sessionId: string): BackendConfig {
  return {
    provider: 'anthropic',
    workspace: {
      id: 'ws-f1397',
      name: 'F1.397 Workspace',
      rootPath: '/tmp/ws-f1397',
      workspaceRootPath: '/tmp/ws-f1397',
      sessionRootPath: '/tmp/nessy-general-agent-test-sessions/ws-f1397',
    } as never,
    session: {
      id: sessionId,
      workspaceRootPath: '/tmp/ws-f1397',
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      workingDirectory: '/tmp/project-root',
      permissionMode: 'bypassPermissions',
    } as never,
    model: 'claude-sonnet-4-5',
    isHeadless: true,
  } as BackendConfig;
}

const registered = (sessionId: string): unknown =>
  (modeManager as unknown as { callbacks: Map<string, unknown> }).callbacks.get(encodeSessionKey({ workspaceId: 'ws-f1397', sessionId }));

describe('F1.397 — a destroyed claude agent takes its own mode callbacks with it', () => {
  it('THE DEFECT — claude → Pi: after destroy() no callbacks are registered for the session, and the mode entry stays', () => {
    const agent = new ClaudeAgent(createConfig('session-f1397-switch'));
    (agent as unknown as { debug: (m: string) => void }).debug = () => {};
    expect(registered('session-f1397-switch')).toBeDefined();
    agent.destroy();
    expect({
      callbacks: registered('session-f1397-switch'),
      mode: getPermissionMode({ workspaceId: 'ws-f1397', sessionId: 'session-f1397-switch' }),
    }).toEqual({ callbacks: undefined, mode: 'bypassPermissions' });
  });

  it('CONTROL — a respawned agent\'s callbacks survive the old agent\'s LATE destroy()', () => {
    const old = new ClaudeAgent(createConfig('session-f1397-respawn'));
    const fresh = new ClaudeAgent(createConfig('session-f1397-respawn'));
    for (const agent of [old, fresh]) (agent as unknown as { debug: (m: string) => void }).debug = () => {};
    const freshCallbacks = registered('session-f1397-respawn');
    expect(freshCallbacks).toBeDefined();
    old.destroy();
    expect(registered('session-f1397-respawn')).toBe(freshCallbacks);
    // …and the fresh agent's echo still fires on a mode change.
    const echoed: string[] = [];
    (fresh as unknown as { onPermissionModeChange: ((mode: string) => void) | null }).onPermissionModeChange = mode => { echoed.push(mode); };
    setPermissionMode({ workspaceId: 'ws-f1397', sessionId: 'session-f1397-respawn' }, 'default');
    expect(echoed).toEqual(['default']);
    fresh.destroy();
  });
});
