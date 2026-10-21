/**
 * UB3.9 (upstream v0.14.1 "Source tools say why they are called", v0.15.1
 * `_intent` threading) — the agent's stated purpose reaches the pool and the
 * summariser, on every path that has a producer:
 *
 * - API (the upstream `api-source-intent.test.ts` port, on our four-argument
 *   `callTool`): `ApiSourcePoolClient` transports `intent` as the API tool's
 *   `_intent` argument, never overriding one the caller still carries;
 * - pool: `McpCallToolContext.intent` rides to the API client AND into
 *   `guardLargeResult`, so the summariser prompt carries the goal sentence
 *   ("The AI assistant's goal: …") MCP-source summaries never had, and the
 *   same intent lands in the API tool's `_intent` when the result is small;
 * - Claude (B1-03's chain, driven through PreToolUse → proxy): a source whose
 *   slug is active at hook time KEEPS `_intent` through the gate
 *   (`keepSourceToolIntent`), and the real proxy handler passes it as the
 *   pool intent; a source whose `_intent` the gate STRIPPED (slug absent from
 *   `activeSourceSlugs` — the mid-turn activation case) still DISPATCHES, with
 *   no intent: the proxy's `_intent` is schema-optional and the handler
 *   tolerates absence. The #1086 class must not recur.
 *
 * Codex is a stated residue (upstream v0.15.1 `pool-server.ts` carries no
 * `_intent`; neither does ours) and has no arm here by design.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { type Tool } from '@modelcontextprotocol/sdk/types.js';
import { ApiSourcePoolClient } from '../api-source-pool-client.ts';
import { McpClientPool } from '../mcp-pool.ts';
import type { PoolClient } from '../client.ts';
import { MCP_OUTPUT_TOKENS_ENV } from '../../config/mcp-output-settings.ts';
import { runPreToolUseChecks, type PermissionManagerLike } from '../../agent/core/index.ts';
import { cleanupModeState, initializeModeState } from '../../agent/mode-manager.ts';
import { createSourceProxyServers } from '../../agent/claude-agent.ts';

const INTENT = 'find the outage thread';

const KEY = { workspaceId: 'ws-ub39', sessionId: 'session-ub39' } as const;

afterEach(() => { cleanupModeState(KEY); });

/** The gate reads the manager's predicate surface for every call; none may grant here. */
const permissionManager: PermissionManagerLike = {
  isCommandWhitelisted: () => false,
  isDangerousCommand: () => false,
  getBaseCommand: command => command.split(/\s+/)[0] || command,
  extractDomainFromNetworkCommand: () => null,
  isDomainWhitelisted: () => false,
};

describe('UB3.9 · ApiSourcePoolClient intent (the upstream port, on our four-argument callTool)', () => {
  it('passes the agent intent to the API tool as `_intent`, without overriding one it already has', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const server = new McpServer({ name: 'api_test', version: '1.0.0' });
    server.registerTool(
      'lookup',
      { description: 'lookup', inputSchema: { path: z.string(), _intent: z.string().optional() } },
      async (args: Record<string, unknown>) => {
        seen.push(args);
        return { content: [{ type: 'text', text: 'ok' }] };
      },
    );
    const client = new ApiSourcePoolClient(server);
    await client.callTool('lookup', { path: '/search' }, undefined, { intent: INTENT });
    await client.callTool('lookup', { path: '/search', _intent: 'own' }, undefined, { intent: 'other' });
    await client.callTool('lookup', { path: '/search' });
    expect(seen).toEqual([
      { path: '/search', _intent: INTENT },
      { path: '/search', _intent: 'own' },
      { path: '/search' },
    ]);
    await client.close();
  });
});

describe('UB3.9 · the pool threads `McpCallToolContext.intent` to the client and the summariser', () => {
  const previousLimit = process.env[MCP_OUTPUT_TOKENS_ENV];
  let sessionDir: string | undefined;

  afterEach(() => {
    delete process.env[MCP_OUTPUT_TOKENS_ENV];
    if (previousLimit !== undefined) process.env[MCP_OUTPUT_TOKENS_ENV] = previousLimit;
    if (sessionDir !== undefined) {
      rmSync(sessionDir, { recursive: true, force: true });
      sessionDir = undefined;
    }
  });

  it('a large API-source result is summarised against the stated goal; a small one carries `_intent` in its arguments', async () => {
    // Lower the MCP output limit so ~200 tokens trip the guard: a real 25k-token
    // fixture would only test the string allocator.
    process.env[MCP_OUTPUT_TOKENS_ENV] = '64';
    sessionDir = mkdtempSync(join(tmpdir(), 'ub39-intent-'));

    const seen: Array<Record<string, unknown>> = [];
    let summaryPrompt: string | undefined;
    const server = new McpServer({ name: 'api_intent_pool', version: '1.0.0' });
    server.registerTool(
      'lookup',
      // `_intent` is DECLARED, as every real API tool's schema does
      // (api-tools.ts): the in-process server's zod validation strips
      // undeclared keys, so a fixture without it would silently un-merge the
      // transported intent and lie about the product.
      { description: 'lookup', inputSchema: { path: z.string(), _intent: z.string().optional() } },
      async (args: Record<string, unknown>) => {
        seen.push(args);
        const text = args.path === '/search' ? 'incident line\n'.repeat(120) : 'ok';
        return { content: [{ type: 'text', text }] };
      },
    );

    const pool = new McpClientPool();
    await pool.connectInProcess('weatherslug', server);

    // The LARGE arm: the guard fires, the summariser is asked, and its prompt
    // names the agent's stated goal — the sentence `large-response.ts` builds
    // from `context.intent`. Before this row the goal sentence never reached an
    // MCP-source summary at all.
    const result = await pool.callTool('mcp__weatherslug__lookup', { path: '/search' }, undefined, {
      sessionPath: sessionDir,
      summarize: async (prompt: string) => {
        summaryPrompt = prompt;
        return 'SUMMARISED';
      },
      intent: INTENT,
    });
    expect(summaryPrompt).toBeDefined();
    expect(summaryPrompt).toContain(`The AI assistant's goal: "${INTENT}"`);
    // The guard's replacement message carries the summary (plus its
    // saved-to-disk framing), so the verdict is containment, not equality.
    expect(result.content).toContain('SUMMARISED');
    expect(result.isError).toBe(false);

    // The SMALL arm: the same intent rode to the API client, so the tool's own
    // arguments carry `_intent` (the transported copy fills the stripped one).
    await pool.callTool('mcp__weatherslug__lookup', { path: '/small' }, undefined, {
      sessionPath: sessionDir,
      intent: INTENT,
    });
    expect(seen).toEqual([
      { path: '/search', _intent: INTENT },
      { path: '/small', _intent: INTENT },
    ]);

    // Negative control on the context: an absent intent routes byte-identically
    // to before — no `_intent` reaches the tool.
    await pool.callTool('mcp__weatherslug__lookup', { path: '/plain' }, undefined, { sessionPath: sessionDir });
    expect(seen).toEqual([
      { path: '/search', _intent: INTENT },
      { path: '/small', _intent: INTENT },
      { path: '/plain' },
    ]);
  });
});

describe('UB3.9 · B1-03 — a Claude source call survives the gate with its `_intent` stripped', () => {
  const TOOL_DEF = {
    name: 'lookup',
    description: 'lookup',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
  } as Tool;

  function fakePoolRecording(recorder: (call: { args: Record<string, unknown>; context: Record<string, unknown> }) => void): PoolClient {
    return {
      async listTools() { return [TOOL_DEF]; },
      async callTool(_name: string, args: Record<string, unknown>, _signal: unknown, context: Record<string, unknown>) {
        recorder({ args, context });
        return { content: [{ type: 'text', text: 'ok' }], isError: false };
      },
      async close() {},
    } as unknown as PoolClient;
  }

  function gate(keepSourceToolIntent: boolean, activeSourceSlugs: string[]) {
    cleanupModeState(KEY);
    initializeModeState(KEY, 'bypassPermissions');
    return runPreToolUseChecks({
      toolName: 'mcp__weather__lookup',
      input: { path: '/search', _intent: INTENT },
      sessionId: KEY.sessionId,
      sessionKey: KEY,
      permissionMode: 'bypassPermissions',
      workspaceRootPath: '/tmp/ub39-ws',
      workspaceId: KEY.workspaceId,
      permissionManager,
      workingDirectory: '/tmp/ub39-ws',
      activeSourceSlugs,
      allSourceSlugs: ['weather'],
      hasSourceActivation: false,
      ...(keepSourceToolIntent ? { keepSourceToolIntent: true } : {}),
    });
  }

  async function drivenProxy(recorder: (call: { args: Record<string, unknown>; context: Record<string, unknown> }) => void) {
    // `registerClient` is protected (DA3.16): the one-line subclass is the pin
    // test's own shape — this fixture never syncs, so no connection identity
    // is read afterwards.
    class TestPool extends McpClientPool {
      async register(slug: string, client: PoolClient) {
        return this.registerClient(slug, client);
      }
    }
    const pool = new TestPool();
    await pool.register('weather', fakePoolRecording(recorder));
    const servers = createSourceProxyServers(pool);
    return (servers.weather as unknown as { instance: McpServer }).instance;
  }

  async function callProxy(server: McpServer, args: Record<string, unknown>): Promise<{ isError: unknown; texts: string[] }> {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'ub39-claude-arm', version: '1.0.0' });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const result = (await client.callTool({ name: 'lookup', arguments: args })) as { isError?: boolean; content: Array<{ type: string; text?: string }> };
      return {
        isError: result.isError,
        texts: (result.content as Array<{ type: string; text?: string }>)
          .filter(block => block.type === 'text')
          .map(block => block.text ?? ''),
      };
    } finally {
      await client.close().catch(() => {});
    }
  }

  it('positive: the active source keeps `_intent` through the gate, and the real proxy passes it to the pool', async () => {
    const checked = gate(true, ['weather']);
    expect(checked.type).toBe('modify');
    const gatedInput = (checked as { type: 'modify'; input: Record<string, unknown> }).input;
    expect(gatedInput._intent).toBe(INTENT);

    const calls: Array<{ args: Record<string, unknown>; context: Record<string, unknown> }> = [];
    const server = await drivenProxy(call => calls.push(call));
    const result = await callProxy(server, gatedInput);
    expect(result.isError).toBeFalsy();
    expect(result.texts).toContain('ok');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.context.intent).toBe(INTENT);
    // The proxy took `_intent` back out: the pool's args never carry it.
    expect(calls[0]?.args._intent).toBeUndefined();
  });

  it("negative (the #1086 class): a source absent from activeSourceSlugs at hook time reads as the activation card — and a call whose `_intent` is missing anyway still dispatches", async () => {
    // Part (i), the hook-time-absent reading: the slug is not active, so the
    // gate's own step 2 asks for activation (a card, never a failed dispatch)
    // — the strip in 5f is not even reached on this pass.
    const checked = gate(true, []);
    expect(checked.type).toBe('source_activation_needed');
    expect((checked as { sourceSlug: string }).sourceSlug).toBe('weather');

    // Part (ii), the tolerance itself: an input whose `_intent` is gone — what
    // the boundary arm proves the gate produces without the opt-in, and what a
    // model that simply omitted the optional field produces — drives the REAL
    // proxy and dispatches with no intent at all.
    const strippedInput = { path: '/search' };

    const calls: Array<{ args: Record<string, unknown>; context: Record<string, unknown> }> = [];
    const server = await drivenProxy(call => calls.push(call));
    const result = await callProxy(server, strippedInput);
    // THE assertion: dispatch happened and succeeded with no intent at all.
    expect(result.isError).toBeFalsy();
    expect(result.texts).toContain('ok');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.context.intent).toBeUndefined();
  });

  it('boundary: without the opt-in the gate strips as before — every existing caller keeps HEAD behaviour', async () => {
    const checked = gate(false, ['weather']);
    expect(checked.type).toBe('modify');
    const input = (checked as { type: 'modify'; input: Record<string, unknown> }).input;
    expect('_intent' in input).toBe(false);
  });
});
