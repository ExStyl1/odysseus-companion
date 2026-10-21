/**
 * F1.557 — end to end through the claude tool bridge: a proxied MCP tool whose
 * input schema has `anyOf`/`oneOf`/`allOf` at its ROOT keeps its parameters.
 *
 * The instrument is the one `claude-always-load-pin.test.ts` and
 * `source-proxy-instructions.test.ts` use: build the servers with the real
 * `createSourceProxyServers`, connect an in-memory MCP client to the built
 * server's own instance, and read `tools/list` — what the claude child is
 * offered — and `tools/call` — what reaches the pool. The pool is a real
 * `McpClientPool` with a fake client filed through the real `connect`
 * (`registerFixtureClient`); only its `callTool` is replaced, on the instance, to
 * record the arguments that arrive.
 *
 * MEASURED BEFORE THE FIX (2026-09-24, SDK 0.3.267, `work/wjbi/f1557-probe.ts`):
 * every root-combinator tool listed `{"type":"object","properties":{}}`, and a
 * call carrying the right arguments reached the pool as `{}` — the SDK server
 * parses a call with the tool's shape, so an empty shape STRIPPED what the model
 * sent. The plain tool listed and called exactly as the control below pins.
 *
 * The rewrite rules themselves are `mcp.md#tool-input-schemas-with-a-root-level-combinator`'s
 * and are unit-tested beside the module (`backend/claude/__tests__/mcp-root-combinator.test.ts`).
 */
import { describe, expect, it } from 'bun:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { McpClientPool } from '../../mcp/mcp-pool.ts';
import type { PoolClient } from '../../mcp/client.ts';
import { registerFixtureClient } from '../../mcp/__tests__/pool-fixture.ts';
import { createSourceProxyServers } from '../claude-agent.ts';

const TOOLS = [
  {
    name: 'plain',
    description: 'plain tool',
    inputSchema: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
  },
  {
    name: 'findUser',
    description: 'Find a user.',
    inputSchema: {
      type: 'object',
      anyOf: [
        { properties: { id: { type: 'string' } }, required: ['id'] },
        { properties: { email: { type: 'string' } }, required: ['email'] },
      ],
    },
  },
  {
    name: 'pick',
    description: 'Pick one.',
    inputSchema: {
      oneOf: [
        { type: 'object', properties: { a: { type: 'number' } }, required: ['a'] },
        { type: 'object', properties: { b: { type: 'boolean' } } },
      ],
    },
  },
  {
    name: 'both',
    description: 'Both halves.',
    inputSchema: {
      allOf: [
        { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] },
        { type: 'object', properties: { y: { type: 'integer' } } },
      ],
    },
  },
  {
    name: 'broken',
    description: 'Malformed root combinator.',
    inputSchema: { type: 'object', anyOf: { properties: { id: { type: 'string' } } } },
  },
] as unknown as Tool[];

/**
 * F1.610 — branches that DISAGREE about a shared property. The flattened schema
 * is also the in-process validator (the SDK server parses a call with the shape
 * built from it), so keeping only the first branch's definition rejected every
 * call for the other branches.
 */
const DISCRIMINATED_TOOLS = [
  {
    name: 'target',
    description: 'Target a user or a team.',
    inputSchema: {
      type: 'object',
      oneOf: [
        { properties: { kind: { type: 'string', enum: ['user'] }, id: { type: 'string' } }, required: ['kind', 'id'] },
        { properties: { kind: { type: 'string', enum: ['team'] }, slug: { type: 'string' } }, required: ['kind', 'slug'] },
      ],
    },
  },
  {
    name: 'limit',
    description: 'A limit given as a number or as a keyword.',
    inputSchema: {
      type: 'object',
      anyOf: [
        { properties: { value: { type: 'number' } }, required: ['value'] },
        { properties: { value: { type: 'string' } }, required: ['value'] },
      ],
    },
  },
] as unknown as Tool[];

async function rig(tools: Tool[] = TOOLS) {
  const client = {
    async listTools() { return tools; },
    async callTool() { return { content: [{ type: 'text', text: 'ok' }] }; },
    async close() {},
  } as unknown as PoolClient;
  const pool = new McpClientPool();
  await registerFixtureClient(pool, 'src', client);
  const received: Array<{ name: string; args: unknown }> = [];
  (pool as unknown as { callTool: (name: string, args: unknown) => Promise<{ content: string; isError: boolean }> }).callTool =
    async (name, args) => {
      received.push({ name, args });
      return { content: 'ok', isError: false };
    };
  const servers = createSourceProxyServers(pool);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const mcp = new Client({ name: 'f1557-bridge', version: '1.0.0' });
  await (servers.src as unknown as { instance: McpServer }).instance.connect(serverTransport);
  await mcp.connect(clientTransport);
  const listed = await mcp.listTools();
  const byName = new Map(listed.tools.map(entry => [entry.name, entry]));
  return { mcp, received, byName, close: () => mcp.close().catch(() => {}) };
}

describe('F1.557 · a root-combinator MCP tool keeps its parameters on claude-runtime', () => {
  it('lists the flattened parameters and says which groups belong together', async () => {
    const r = await rig();
    try {
      const anyOf = r.byName.get('findUser');
      expect(anyOf?.inputSchema.properties).toEqual({ id: { type: 'string' }, email: { type: 'string' } });
      // anyOf/oneOf: no branch's required list is enforced — it is described.
      expect(anyOf?.inputSchema.required ?? []).toEqual([]);
      expect(anyOf?.description).toBe(
        'Argument groups (this tool\'s schema is a root-level anyOf, merged into one object): pass at least one of (id) | (email).\n\nFind a user.',
      );

      const oneOf = r.byName.get('pick');
      expect(Object.keys(oneOf?.inputSchema.properties ?? {})).toEqual(['a', 'b']);
      expect(oneOf?.description?.startsWith('Argument groups (this tool\'s schema is a root-level oneOf')).toBe(true);

      // allOf: every branch's required list still applies.
      const allOf = r.byName.get('both');
      expect(Object.keys(allOf?.inputSchema.properties ?? {})).toEqual(['x', 'y']);
      expect(allOf?.inputSchema.required).toEqual(['x']);
    } finally {
      await r.close();
    }
  });

  it('delivers the arguments the model sent to the pool, for every combinator', async () => {
    const r = await rig();
    try {
      await r.mcp.callTool({ name: 'findUser', arguments: { email: 'a@b.c' } });
      await r.mcp.callTool({ name: 'pick', arguments: { a: 3 } });
      await r.mcp.callTool({ name: 'both', arguments: { x: 's', y: 2 } });
      expect(r.received).toEqual([
        { name: 'mcp__src__findUser', args: { email: 'a@b.c' } },
        { name: 'mcp__src__pick', args: { a: 3 } },
        { name: 'mcp__src__both', args: { x: 's', y: 2 } },
      ]);
    } finally {
      await r.close();
    }
  });

  it('CONTROL — a plain `properties` tool lists and calls exactly as before the row', async () => {
    const r = await rig();
    try {
      const plain = r.byName.get('plain');
      // Byte-identical to the pre-fix probe's reading of the same tool.
      expect(JSON.stringify(plain?.inputSchema)).toBe(
        '{"type":"object","properties":{"q":{"type":"string"}},"required":["q"],"$schema":"http://json-schema.org/draft-07/schema#"}',
      );
      expect(plain?.description).toBe('plain tool');
      await r.mcp.callTool({ name: 'plain', arguments: { q: 'hi' } });
      expect(r.received).toEqual([{ name: 'mcp__src__plain', args: { q: 'hi' } }]);
    } finally {
      await r.close();
    }
  });

  it('BOUNDARY — a root combinator that is not an array skips that ONE tool and leaves its siblings', async () => {
    const r = await rig();
    try {
      expect(r.byName.has('broken')).toBe(false);
      expect([...r.byName.keys()].sort()).toEqual(['both', 'findUser', 'pick', 'plain']);
    } finally {
      await r.close();
    }
  });
});

describe('F1.610 · branches that disagree about a shared property accept every branch', () => {
  it('lists the enum discriminator with every branch value, and the differing types as alternatives', async () => {
    const r = await rig(DISCRIMINATED_TOOLS);
    try {
      expect(r.byName.get('target')?.inputSchema.properties?.kind).toEqual({ type: 'string', enum: ['user', 'team'] });
      expect(r.byName.get('limit')?.inputSchema.properties?.value).toEqual({
        anyOf: [{ type: 'number' }, { type: 'string' }],
      });
    } finally {
      await r.close();
    }
  });

  it('CONTROL — a call for EACH branch reaches the pool', async () => {
    const r = await rig(DISCRIMINATED_TOOLS);
    try {
      const calls = [
        { name: 'target', arguments: { kind: 'user', id: 'u1' } },
        { name: 'target', arguments: { kind: 'team', slug: 'core' } },
        { name: 'limit', arguments: { value: 5 } },
        { name: 'limit', arguments: { value: 'max' } },
      ];
      for (const call of calls) {
        const result = await r.mcp.callTool(call);
        expect({ name: call.name, isError: result.isError ?? false }).toEqual({ name: call.name, isError: false });
      }
      expect(r.received).toEqual(calls.map(call => ({ name: `mcp__src__${call.name}`, args: call.arguments })));
    } finally {
      await r.close();
    }
  });

  it('BOUNDARY — a value no branch allows is still refused before the pool', async () => {
    const r = await rig(DISCRIMINATED_TOOLS);
    try {
      const refused = [
        await r.mcp.callTool({ name: 'target', arguments: { kind: 'org', id: 'o1' } }),
        await r.mcp.callTool({ name: 'limit', arguments: { value: true } }),
      ];
      expect(refused.map(result => result.isError)).toEqual([true, true]);
      expect(r.received).toEqual([]);
    } finally {
      await r.close();
    }
  });
});

/**
 * F1.998 — a NUMERIC or mixed enum argument. zod 4's `z.enum` keeps only string
 * values, so before the fix `size` was offered as `{"type":"string","enum":[]}`,
 * `sort` lost its `0`, and every call carrying a numeric member was refused before
 * the pool. `version` is F1.610's numeric residue: branches that differ in a
 * numeric enum fall to an `anyOf`, which only works once each enum does.
 */
const NUMERIC_ENUM_TOOLS = [
  {
    name: 'page',
    description: 'Page through results.',
    inputSchema: {
      type: 'object',
      properties: { size: { type: 'integer', enum: [10, 20, 50] }, sort: { enum: ['asc', 'desc', 0] } },
      required: ['size'],
    },
  },
  {
    name: 'version',
    description: 'Version 1 takes a, version 2 takes b.',
    inputSchema: {
      type: 'object',
      oneOf: [
        { properties: { v: { type: 'integer', enum: [1] }, a: { type: 'string' } }, required: ['v', 'a'] },
        { properties: { v: { type: 'integer', enum: [2] }, b: { type: 'string' } }, required: ['v', 'b'] },
      ],
    },
  },
] as unknown as Tool[];

describe('F1.998 · a numeric or mixed enum argument is offered and callable on claude-runtime', () => {
  it('offers every enum value, numbers included', async () => {
    const r = await rig(NUMERIC_ENUM_TOOLS);
    try {
      const props = r.byName.get('page')?.inputSchema.properties;
      expect(props?.size).toEqual({ type: 'number', enum: [10, 20, 50] });
      expect(props?.sort).toEqual({ enum: ['asc', 'desc', 0] });
    } finally {
      await r.close();
    }
  });

  it('CONTROL — a call with a numeric member, a string member, or either numeric branch reaches the pool', async () => {
    const r = await rig(NUMERIC_ENUM_TOOLS);
    try {
      const calls = [
        { name: 'page', arguments: { size: 20, sort: 0 } },
        { name: 'page', arguments: { size: 50, sort: 'asc' } },
        { name: 'version', arguments: { v: 1, a: 'x' } },
        { name: 'version', arguments: { v: 2, b: 'y' } },
      ];
      for (const call of calls) {
        const result = await r.mcp.callTool(call);
        expect({ name: call.name, isError: result.isError ?? false }).toEqual({ name: call.name, isError: false });
      }
      expect(r.received).toEqual(calls.map(call => ({ name: `mcp__src__${call.name}`, args: call.arguments })));
    } finally {
      await r.close();
    }
  });

  it('BOUNDARY — a value outside the enum, or a number sent as a string, is still refused before the pool', async () => {
    const r = await rig(NUMERIC_ENUM_TOOLS);
    try {
      const refused = [
        await r.mcp.callTool({ name: 'page', arguments: { size: 30 } }),
        await r.mcp.callTool({ name: 'page', arguments: { size: '20' } }),
        await r.mcp.callTool({ name: 'page', arguments: { size: 10, sort: 'up' } }),
        await r.mcp.callTool({ name: 'version', arguments: { v: 3, a: 'x' } }),
      ];
      expect(refused.map(result => result.isError)).toEqual([true, true, true, true]);
      expect(r.received).toEqual([]);
    } finally {
      await r.close();
    }
  });
});
