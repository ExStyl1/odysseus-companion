/**
 * P6.962 — the Pi arm of `chat.backgroundInFlightTask`, which is a NAMED
 * refusal and not a lever.
 *
 * `permissions`-style native-first, asked and answered before writing anything:
 * Pi detaches running work in three places and none of them is reachable from a
 * user press — an MCP call races a clock (`detachAfter`, R10), a bash call rides
 * its own `timeout`, and an agent-tool spawn detaches at ADMISSION through
 * `registerBackgroundChildTask`. What is missing is a host-to-subprocess
 * TRIGGER for a call already in flight, not a mechanism; the method's own
 * docblock carries the full measurement, including why `spawner.ts`'s awaited
 * `monitor` must not be the seam (P6.308 refuted that remedy in tree).
 *
 * The method exists so the refusal can carry a reason: `SessionManager` maps an
 * absent method and a refusing one to the same `unsupported`, so the caller
 * cannot tell them apart — but only one of them can be read.
 */
import { describe, expect, it } from 'bun:test';
import { PiAgent } from '../pi-agent.ts';
import type { BackendConfig } from '../backend/types.ts';

function createConfig(): BackendConfig {
  return {
    provider: 'pi',
    workspace: {
      id: 'ws-background-in-flight',
      name: 'Test Workspace',
      rootPath: '/tmp/ws-root',
      workspaceRootPath: '/tmp/ws-root',
      sessionRootPath: '/tmp/nessy-general-agent-test-sessions/ws-background-in-flight',
    } as never,
    session: {
      id: 'session-background-in-flight',
      workspaceRootPath: '/tmp/ws-root',
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      workingDirectory: '/tmp/project-root',
    } as never,
    model: 'pi/test-model',
    isHeadless: true,
  };
}

describe('PiAgent.backgroundInFlightTasks (P6.962)', () => {
  it('refuses by name, spawns nothing, and never claims success', async () => {
    const agent = new PiAgent(createConfig());
    try {
      // POSITIVE: the refusal is `unsupported` and not an `error` — "this
      // runtime has no such lever" is not "the lever went wrong", and the two
      // get different sentences from the host.
      const named = await agent.backgroundInFlightTasks('toolu_01');
      expect(named).toEqual({ backgrounded: false, unsupported: true });
      expect(named).not.toHaveProperty('error');

      // The all-tasks form answers identically: there is no shape of the
      // request this runtime can honour.
      expect(await agent.backgroundInFlightTasks()).toEqual({ backgrounded: false, unsupported: true });

      // NEGATIVE, and it is the one that keeps the refusal cheap: asking must
      // not start a Pi subprocess. Every other control request here spawns one
      // if needed; refusing is not a reason to boot a runtime.
      expect((agent as unknown as { subprocess?: unknown }).subprocess).toBeFalsy();
    } finally {
      await agent.destroy?.();
    }
  });

  it('is a real method, so the host reads a refusal rather than an absence', () => {
    const agent = new PiAgent(createConfig());
    // The host's own test (`stop-agent-task.test.ts`) covers both branches of
    // `SessionManager.backgroundInFlightTasks`; what it cannot see is which one
    // Pi takes. `typeof … === 'function'` is the exact check that decides it.
    expect(typeof agent.backgroundInFlightTasks).toBe('function');
    void agent.destroy?.();
  });
});
