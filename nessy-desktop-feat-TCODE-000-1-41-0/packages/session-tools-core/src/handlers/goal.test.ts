import { describe, expect, test } from 'bun:test';

import type { SessionToolContext } from '../context.ts';
import { GoalGetSchema, GoalSchema, SESSION_TOOL_REGISTRY } from '../tool-defs.ts';
import { handleGoal, handleGoalGet } from './goal.ts';

describe('goal session tools', () => {
  test('use only the injected server-owned goal port', async () => {
    const calls: Record<string, unknown>[] = [];
    const ctx = { goalPort: { execute: async (args: Record<string, unknown>) => { calls.push(args); return { ok: true }; } } } as any;

    expect((await handleGoalGet(ctx)).isError).toBe(false);
    expect((await handleGoal(ctx, { action: 'cancel', id: 'goal-1', revision: 2, reason: 'user request' })).isError).toBe(false);
    expect(calls).toEqual([
      { action: 'get' },
      { action: 'cancel', id: 'goal-1', revision: 2, reason: 'user request' },
    ]);
  });

  test('fails closed without a host port and rejects authority-bearing input', async () => {
    expect((await handleGoalGet({} as any)).isError).toBe(true);
    expect(GoalGetSchema.safeParse({ permissionMode: 'allow-all' }).success).toBe(false);
    expect(GoalSchema.safeParse({ action: 'create', condition: 'Ship it', source: 'automation' }).success).toBe(false);
    expect(GoalSchema.safeParse({ action: 'complete', id: 'goal-1', revision: 1, reason: 'done', evidence: [] }).success).toBe(false);
    expect(GoalSchema.safeParse({ action: 'complete', id: 'goal-1', revision: 1, reason: 'done', evidence: ['green gate'] }).success).toBe(true);
  });

  /**
   * P2.2 — the PI shape of the port, driven through the REAL registry entries.
   *
   * `pi-agent.ts` assigns `config.goalPort` straight onto its own tool context
   * (`this._sessionToolContext.goalPort = this.config.goalPort`), so a context
   * with the port set directly is byte-for-byte what a Pi session's tool call
   * sees. The registry entries are used rather than the exported handlers so a
   * def whose `handler` was rewired would fail here.
   *
   * The Claude shape (the same port resolved lazily from the per-session
   * callback registry) is measured in
   * `shared/src/agent/__tests__/claude-scheduling-projection.test.ts`, and the
   * Codex shape (the same port reached over the host-callback bridge) in
   * `session-mcp-server/src/host-callback-bridge.test.ts`. Three resolutions,
   * one handler — which is the property that keeps the runtimes from answering
   * differently.
   */
  describe('the Pi resolution — the port assigned directly onto the context', () => {
    const call = (name: string, ctx: SessionToolContext, args: Record<string, unknown>) => {
      const def = SESSION_TOOL_REGISTRY.get(name);
      if (!def?.handler) throw new Error(`no registry handler for ${name}`);
      return def.handler(ctx, args as never);
    };

    function fakeGoalPort() {
      const seen: Record<string, unknown>[] = [];
      let goal: Record<string, unknown> | undefined;
      const port = {
        execute: async (args: Record<string, unknown>) => {
          seen.push(args);
          if (args.action === 'create') goal = { id: 'goal-9', revision: 1, status: 'active', condition: args.condition };
          if (args.action === 'cancel') goal = { ...goal, status: 'cancelled', revision: 2 };
          return { schemaVersion: 1, ...(goal ? { goal } : {}) };
        },
      };
      return { port, seen };
    }

    test('set, get and clear all reach the one host port', async () => {
      const { port, seen } = fakeGoalPort();
      const ctx = { goalPort: port } as unknown as SessionToolContext;

      const created = await call('Goal', ctx, { action: 'create', condition: 'Ship the retry' });
      expect(created.isError).toBe(false);
      expect(created.content[0]?.text).toContain('goal-9');

      const read = await call('GoalGet', ctx, {});
      expect(read.isError).toBe(false);
      expect(read.content[0]?.text).toContain('"status":"active"');

      const cleared = await call('Goal', ctx, { action: 'cancel', id: 'goal-9', revision: 1, reason: 'changed my mind' });
      expect(cleared.isError).toBe(false);
      expect(cleared.content[0]?.text).toContain('cancelled');

      expect(seen.map(args => args.action)).toEqual(['create', 'get', 'cancel']);
    });

    // The negative half: with no port assigned, both tools report the capability
    // as absent rather than throwing or inventing a goal. This is the state a
    // session on a runtime outside `SCHEDULED_DELIVERY_RUNTIMES` is left in.
    test('both tools report unavailability when no port is assigned', async () => {
      const ctx = {} as unknown as SessionToolContext;
      for (const [name, args] of [['Goal', { action: 'cancel', id: 'goal-9', revision: 1, reason: 'stop' }], ['GoalGet', {}]] as const) {
        const result = await call(name, ctx, args);
        expect(result.isError).toBe(true);
        expect(result.content.map(block => block.text).join('\n'))
          .toContain('Goal is unavailable for this backend.');
      }
    });

    /**
     * P2.2 — the handler is the validation contract, because the Claude surface
     * can only advertise the union FLATTENED (the SDK's `tool()` takes a raw
     * shape, so `complete` cannot be marked as requiring evidence there). A
     * malformed command is a recoverable result naming the field, on every
     * runtime, and it never reaches the port.
     */
    test('a command the union rejects is refused by name, before the port', async () => {
      const { port, seen } = fakeGoalPort();
      const ctx = { goalPort: port } as unknown as SessionToolContext;

      // `complete` without evidence is exactly what the flattened advertisement
      // cannot forbid and the union does.
      const result = await call('Goal', ctx, { action: 'complete', id: 'goal-9', revision: 1, reason: 'done', evidence: [] });
      expect(result.isError).toBe(true);
      expect(result.content.map(block => block.text).join('\n')).toContain('Goal input is invalid');
      expect(seen).toEqual([]);

      // Positive control: the same command WITH evidence reaches the port.
      const ok = await call('Goal', ctx, { action: 'complete', id: 'goal-9', revision: 1, reason: 'done', evidence: ['green gate'] });
      expect(ok.isError).toBe(false);
      expect(seen).toHaveLength(1);
    });

    // The attribution belt on the in-process path: `source`/`creator` are on no
    // branch of the union and the branches are `.strict()`, so a model that
    // supplies them is refused rather than silently stripped — and the host's
    // own stamp is never contradicted.
    test('a command smuggling source/creator never reaches the port', async () => {
      const { port, seen } = fakeGoalPort();
      const ctx = { goalPort: port } as unknown as SessionToolContext;

      const result = await call('Goal', ctx, { action: 'create', condition: 'Ship it', source: 'user', creator: 'desktop' });
      expect(result.isError).toBe(true);
      expect(seen).toEqual([]);

      const ok = await call('Goal', ctx, { action: 'create', condition: 'Ship it' });
      expect(ok.isError).toBe(false);
      expect(seen).toEqual([{ action: 'create', condition: 'Ship it' }]);
    });
  });
});
