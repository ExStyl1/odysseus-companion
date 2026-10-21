/**
 * P6.711's claude line, and the P6.352 read override `base-agent.ts` has been
 * promising since the row landed.
 *
 * ## What was actually wrong
 *
 * `BaseAgent.mcpServerStatuses()` says in its own docblock: *"A runtime that
 * publishes its own inventory overrides this — `ClaudeAgent` with
 * `Query.mcpServerStatus()` (which also carries a failure REASON, the one field
 * the pool cannot give)"*. No such override existed. `/mcp` on a claude session
 * therefore answered from the host pool — from what we asked the child to load,
 * never from what the child believes — and the `error` the vendor publishes
 * reached nobody.
 *
 * The reconnect half is the same shape one verb further on: the SDK declares
 * `reconnectMcpServer(serverName)` (`sdk.d.ts:2592`, *"Reconnect an MCP server
 * by name. Throws on failure."*) and W9-k's host pool grew `reconnect(slug)`,
 * and on a claude session the SDK-side servers are the CHILD's — dialling them
 * through the pool would reconnect our copy and leave the child's alone.
 *
 * ## Why the two methods are exercised off the PROTOTYPE
 *
 * Both are three lines of dispatch over `this.currentQuery` and `this.config`.
 * Standing a real `ClaudeAgent` up costs a spawned CLI child and buys nothing
 * this file asserts, so the receiver is a literal with exactly the two fields
 * the methods read. `super.mcpServerStatuses()` resolves through the prototype
 * chain and is independent of the receiver, which is what makes the fallback
 * arm observable at all.
 */

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { ClaudeAgent, claudeSdkMcpStatusLines } from '../claude-agent.ts';
import type { McpReconnectResult } from '../../mcp/mcp-pool.ts';
import type { McpServerStatusLine } from '../../mcp/server-status.ts';

type Receiver = {
  currentQuery: unknown;
  config: { mcpPool?: unknown; mcpLeaserId?: string };
  debug: (message: string) => void;
};

const proto = ClaudeAgent.prototype as unknown as {
  mcpServerStatuses(this: Receiver): Promise<readonly McpServerStatusLine[] | null>;
  reconnectMcpServer(this: Receiver, slug: string): Promise<McpReconnectResult>;
};

function receiver(input: {
  query?: unknown;
  pool?: unknown;
}): Receiver {
  return {
    currentQuery: input.query ?? null,
    config: { ...(input.pool ? { mcpPool: input.pool } : {}), mcpLeaserId: 'leaser-1' },
    debug: () => {},
  };
}

describe('claudeSdkMcpStatusLines — the mapper (P6.352)', () => {
  it("carries the child's own failure REASON, and counts tools where there are tools", () => {
    const lines = claudeSdkMcpStatusLines([
      { name: 'linear', status: 'connected', tools: [{ name: 'a' }, { name: 'b' }] },
      { name: 'github', status: 'failed', error: 'ECONNREFUSED 127.0.0.1:9999' },
    ]);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toEqual({ name: 'linear', state: 'connected', toolCount: 2 });
    expect(lines[1]).toEqual({
      name: 'github',
      state: 'failed',
      toolCount: null,
      detail: 'ECONNREFUSED 127.0.0.1:9999',
    });
  });

  it('keeps an EMPTY tool array apart from an absent one', () => {
    // The boundary the row exists for. `0` on a connected server is the
    // "connected and yet useless" finding the report calls out by name; `null`
    // means nobody counted, which is every server the SDK documents `tools` as
    // unavailable for. Collapsing them prints the finding about a server that
    // was never asked.
    const [connectedEmpty, pending] = claudeSdkMcpStatusLines([
      { name: 'empty', status: 'connected', tools: [] },
      { name: 'coming-up', status: 'pending' },
    ]);
    expect(connectedEmpty?.toolCount).toBe(0);
    expect(pending?.toolCount).toBeNull();
    // ...and an absent error adds no key at all, rather than `detail: undefined`.
    expect(Object.keys(pending ?? {})).toEqual(['name', 'state', 'toolCount']);
  });
});

describe('ClaudeAgent.mcpServerStatuses — the child answers, not the pool (P6.352)', () => {
  it('asks the live child, and reports what IT believes', async () => {
    const poolCalls: string[] = [];
    const self = receiver({
      query: {
        mcpServerStatus: async () => [
          { name: 'github', status: 'failed', error: 'handshake timed out' },
        ],
      },
      pool: {
        serverStatuses: (leaser: string) => {
          poolCalls.push(leaser);
          return [{ name: 'github', state: 'connected', toolCount: 7 }];
        },
      },
    });

    const lines = await proto.mcpServerStatuses.call(self);
    expect(lines).toEqual([{ name: 'github', state: 'failed', toolCount: null, detail: 'handshake timed out' }]);
    // The control that makes the assertion mean something: the pool disagreed,
    // was present, and was not consulted.
    expect(poolCalls).toEqual([]);
  });

  it('falls back to the pool BETWEEN turns, rather than answering "no inventory"', async () => {
    // The negative arm. `currentQuery` is null whenever no turn is running, and
    // the session still has servers — `null` there prints the runtime's
    // "nothing to report" sentence about a session that has plenty.
    const self = receiver({
      query: null,
      pool: { serverStatuses: () => [{ name: 'linear', state: 'connected', toolCount: 3 }] },
    });
    expect(await proto.mcpServerStatuses.call(self)).toEqual([
      { name: 'linear', state: 'connected', toolCount: 3 },
    ]);
  });

  it('falls back when the control request THROWS, instead of printing an empty report', async () => {
    const self = receiver({
      query: { mcpServerStatus: async () => { throw new Error('control channel closed'); } },
      pool: { serverStatuses: () => [{ name: 'linear', state: 'connected', toolCount: 3 }] },
    });
    expect(await proto.mcpServerStatuses.call(self)).toEqual([
      { name: 'linear', state: 'connected', toolCount: 3 },
    ]);
  });

  it('F1.656 — a connected server the child reports without a reason carries the pool\'s skipped-tools detail', async () => {
    // The pool dropped `bad` before the proxy (F1.643/F1.644), so the child never
    // saw it and `McpServerStatus` has no field for it: the pool's line is the only record.
    const skipped = '1 tool skipped: "bad" (input schema rejected)';
    const self = receiver({
      query: {
        mcpServerStatus: async () => [
          { name: 'linear', status: 'connected', tools: [{ name: 'a' }, { name: 'b' }] },
          { name: 'notion', status: 'connected', tools: [{ name: 'c' }] },
        ],
      },
      pool: {
        serverStatuses: () => [
          { name: 'linear', state: 'connected', toolCount: 9, detail: skipped },
          { name: 'notion', state: 'connected', toolCount: 1 },
        ],
      },
    });
    expect(await proto.mcpServerStatuses.call(self)).toEqual([
      // The count stays the child's (2, not the pool's 9): only the detail is merged.
      { name: 'linear', state: 'connected', toolCount: 2, detail: skipped },
      { name: 'notion', state: 'connected', toolCount: 1 },
    ]);
  });

  it('F1.656 control — the child\'s own error is kept unchanged, and a pool failure reason is not merged', async () => {
    const self = receiver({
      query: {
        mcpServerStatus: async () => [
          { name: 'github', status: 'failed', error: 'handshake timed out' },
          { name: 'linear', status: 'connected', tools: [{ name: 'a' }] },
        ],
      },
      pool: {
        serverStatuses: () => [
          { name: 'github', state: 'connected', toolCount: 4, detail: '1 tool skipped: "x" (bad)' },
          // A pool FAILURE reason is about the host's copy, not the child's connected server.
          { name: 'linear', state: 'failed', toolCount: null, detail: 'ECONNREFUSED 127.0.0.1:9999' },
        ],
      },
    });
    expect(await proto.mcpServerStatuses.call(self)).toEqual([
      { name: 'github', state: 'failed', toolCount: null, detail: 'handshake timed out' },
      { name: 'linear', state: 'connected', toolCount: 1 },
    ]);
  });
});

describe('ClaudeAgent.reconnectMcpServer — the runtime\'s own verb (P6.711)', () => {
  it('dials through the SDK when a child is live, and does NOT touch the pool', async () => {
    const asked: string[] = [];
    const poolCalls: string[] = [];
    const self = receiver({
      query: { reconnectMcpServer: async (name: string) => { asked.push(name); } },
      pool: { reconnect: async (slug: string) => { poolCalls.push(slug); return { ok: true }; } },
    });

    expect(await proto.reconnectMcpServer.call(self, 'github')).toEqual({ ok: true });
    expect(asked).toEqual(['github']);
    // The whole point: the SDK-side servers are the child's, so a pool redial
    // would reconnect our copy and leave the child's untouched.
    expect(poolCalls).toEqual([]);
  });

  it('turns the vendor\'s documented THROW into the panel\'s verdict', async () => {
    // `sdk.d.ts:2592` promises "Throws on failure", and every failure here is
    // something the panel renders rather than an exception it can catch.
    const self = receiver({
      query: { reconnectMcpServer: async () => { throw new Error('no such server'); } },
    });
    expect(await proto.reconnectMcpServer.call(self, 'ghost')).toEqual({
      ok: false,
      reason: 'failed',
      detail: 'no such server',
    });
  });

  it('uses the pool between turns, and refuses legibly with neither', async () => {
    const poolCalls: Array<[string, string | undefined]> = [];
    const withPool = receiver({
      query: null,
      pool: {
        reconnect: async (slug: string, leaser?: string) => {
          poolCalls.push([slug, leaser]);
          return { ok: false, reason: 'no-config' } as const;
        },
      },
    });
    expect(await proto.reconnectMcpServer.call(withPool, 'linear')).toEqual({ ok: false, reason: 'no-config' });
    // The leaser travels, so a session cannot restart another session's server
    // by naming the same slug — the pool's own identity rule.
    expect(poolCalls).toEqual([['linear', 'leaser-1']]);

    const bare = receiver({ query: null });
    expect(await proto.reconnectMcpServer.call(bare, 'linear')).toEqual({ ok: false, reason: 'unknown-server' });
  });
});

describe('the promise `base-agent.ts` makes about this file', () => {
  it('is now true — the override it names exists', () => {
    // The docblock at `BaseAgent.mcpServerStatuses` names two overrides by
    // class. Landing a reconnect verb beside a comment describing a read
    // override nobody wrote would make the file's own comment LESS true, which
    // is the residue W9-k's hand-off asked the next holder to close one way or
    // the other. This is that check, and it fails if either half is removed.
    const base = readFileSync(join(import.meta.dir, '..', 'base-agent.ts'), 'utf8');
    const agent = readFileSync(join(import.meta.dir, '..', 'claude-agent.ts'), 'utf8');
    expect(base).toContain('`ClaudeAgent`');
    expect(base).toContain('Query.mcpServerStatus()');
    // `7a62a7103` (P6.750) made the override PUBLIC — the MCP panel reads it
    // through the same host seam as `reconnectMcpServer` — so the literal is no
    // longer `protected override`. What this line pins is what the docblock
    // promises: the override EXISTS. Its visibility is decided and commented
    // beside the base declaration, not here.
    expect(agent).toContain('override async mcpServerStatuses()');
    expect(agent).toContain('async reconnectMcpServer(slug: string)');
  });
});
