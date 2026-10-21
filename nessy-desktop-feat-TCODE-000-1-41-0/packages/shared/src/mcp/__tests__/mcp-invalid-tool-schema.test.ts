/**
 * F1.644 (+ F1.643) — one MCP tool with an unusable schema costs THAT tool, never
 * its server and never the session, and the user and the model are told which
 * tool and why.
 *
 * The contract is Claude Code's own, `mcp.md#tools-with-invalid-input-schemas`
 * (read 2026-09-25): "Claude Code runs two of the API's checks itself when it
 * loads a server's tools and excludes each tool that would fail them, so the
 * server's other tools keep working", and "When Claude Code excludes a tool, it
 * records the reason in the server's log and tells Claude which tools it
 * excluded and why, so you can ask Claude why a tool is missing."
 *
 * What WJ-bu measured (F1.595, 2026-09-24) on a credential-free rig, with a
 * server whose roots were all typed and ONE tool, `broken`, declaring a root
 * `anyOf` that is an object rather than a list: the server connected, and then
 * EVERY Pi prompt failed with 'anyOf value must be ["array"]' before any request
 * reached the model — while codex dropped `broken` alone. The throw is Pi's
 * `createPiToolExecutionPorts`, which compiles every tool's parameters with the
 * MCP SDK's AJV validator when a session is built; `createToolInputValidator`
 * below IS that compile, imported rather than re-spelled, so these tests measure
 * the function Pi runs.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { NessyMcpClient } from '../client.ts';
import { McpClientPool } from '../mcp-pool.ts';
import { formatMcpServerStatusReport } from '../server-status.ts';
import { createToolInputValidator } from '../../agent/pi-harness/tool-executor.ts';
import { registerFixtureClient } from './pool-fixture.ts';

type RawTool = { name: string; description?: string; inputSchema: Record<string, unknown> };

/** A plain, well-formed tool. */
const PLAIN: RawTool = {
  name: 'plain',
  description: 'plain tool',
  inputSchema: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
};

/** A WELL-FORMED root combinator (typed root) — F1.557's `findUser`, the brief's control. */
const FIND_USER: RawTool = {
  name: 'findUser',
  description: 'Find a user.',
  inputSchema: {
    type: 'object',
    anyOf: [
      { properties: { id: { type: 'string' } }, required: ['id'] },
      { properties: { email: { type: 'string' } }, required: ['email'] },
    ],
  },
};

/** WJ-bu's `broken`: a root `anyOf` that is an object, not a list. */
const BROKEN: RawTool = {
  name: 'broken',
  description: 'Malformed root combinator.',
  inputSchema: { type: 'object', anyOf: { properties: { id: { type: 'string' } } } },
};

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close().catch(() => {});
});

/**
 * A LOW-LEVEL SDK `Server` answering `tools/list` with `tools` verbatim — the
 * high-level `McpServer` would build the schemas itself and could never emit a
 * malformed one. Same shape as WJ-bu's `work/wjbu/combinator-mcp.ts`.
 */
async function rawServer(tools: readonly RawTool[], instructions?: string) {
  const server = new Server(
    { name: 'f1644-fixture', version: '1.0.0' },
    { capabilities: { tools: {} }, ...(instructions ? { instructions } : {}) },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: structuredClone(tools) as never }));
  server.setRequestHandler(CallToolRequestSchema, async request => ({
    content: [{ type: 'text' as const, text: `ok ${request.params.name}` }],
  }));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  closers.push(async () => { await server.close(); });
  return clientTransport;
}

async function nessyClient(tools: readonly RawTool[], instructions?: string): Promise<NessyMcpClient> {
  const transport = await rawServer(tools, instructions);
  const client = new NessyMcpClient(
    { transport: 'http', url: 'https://f1644.example.test/mcp' } as never,
    { transport } as never,
  );
  closers.push(async () => { await client.close(); });
  return client;
}

/** The parameters Pi receives: the pool strips `$schema` before handing a schema on. */
function piParameters(schema: unknown): Record<string, unknown> {
  const { $schema: _dialect, ...rest } = (schema ?? {}) as Record<string, unknown>;
  return Object.keys(rest).length > 0 ? rest : { type: 'object', properties: {} };
}

describe('F1.644 — a tool whose input schema Pi cannot compile is skipped before it reaches Pi', () => {
  it('POSITIVE CONTROL — Pi\'s own compile dies on `broken` with the message WJ-bu measured', () => {
    // Proves the instrument sees the defect: without this, "every listed tool
    // compiles" below could pass on a validator that compiles anything.
    expect(() => createToolInputValidator(piParameters(BROKEN.inputSchema), BROKEN.name))
      .toThrow('anyOf value must be ["array"]');
    expect(() => createToolInputValidator(piParameters(FIND_USER.inputSchema), FIND_USER.name)).not.toThrow();
  });

  it('lists the healthy tools, skips `broken` with its reason, and every listed tool compiles for Pi', async () => {
    const client = await nessyClient([PLAIN, FIND_USER, BROKEN]);
    await client.connect();

    const tools = await client.listTools();
    expect(tools.map(tool => tool.name)).toEqual(['plain', 'findUser']);
    // The whole point of F1.644: nothing the host lists can fail Pi's session build.
    for (const tool of tools) {
      expect(() => createToolInputValidator(piParameters(tool.inputSchema), tool.name)).not.toThrow();
    }
    const skipped = client.getSkippedTools();
    expect(skipped.map(entry => entry.name)).toEqual(['broken']);
    expect(skipped[0]!.reason).toContain('anyOf value must be ["array"]');
  });

  it('CONTROL — a well-formed server (a typed root combinator included) lists exactly what the SDK client lists', async () => {
    const client = await nessyClient([PLAIN, FIND_USER]);
    await client.connect();
    const ours = await client.listTools();

    const sdk = new Client({ name: 'control', version: '1.0.0' });
    await sdk.connect(await rawServer([PLAIN, FIND_USER]));
    closers.push(async () => { await sdk.close(); });
    const theirs = (await sdk.listTools()).tools;

    expect(ours).toEqual(theirs);
    expect(client.getSkippedTools()).toEqual([]);
  });

  it('the pool serves the healthy tools and tells the user (/mcp) and the model which tool was skipped and why', async () => {
    const pool = new McpClientPool({});
    await registerFixtureClient(pool, 'combinators', await nessyClient([PLAIN, FIND_USER, BROKEN], 'Use plain first.'));

    const served = pool.getProxyToolDefs(['combinators']).map(def => def.name);
    expect(served.some(name => name.endsWith('__plain'))).toBe(true);
    expect(served.some(name => name.endsWith('__findUser'))).toBe(true);
    expect(served.some(name => name.endsWith('__broken'))).toBe(false);

    // The user's surface — the same `detail` a failed server's reason rides.
    const line = pool.serverStatuses().find(entry => entry.name === 'combinators');
    expect(line?.state).toBe('connected');
    expect(line?.toolCount).toBe(2);
    expect(line?.detail).toContain('broken');
    expect(line?.detail).toContain('anyOf value must be ["array"]');
    expect(formatMcpServerStatusReport(pool.serverStatuses())).toContain('broken');

    // The model's surface — the server's own prose kept, the notice added.
    const instructions = pool.getInstructions('combinators');
    expect(instructions).toContain('Use plain first.');
    expect(instructions).toContain('"broken"');
    expect(instructions).not.toContain('"plain"');
  });

  it('NEGATIVE CONTROL — a clean server carries no detail and no notice', async () => {
    const pool = new McpClientPool({});
    await registerFixtureClient(pool, 'clean', await nessyClient([PLAIN, FIND_USER]));

    const line = pool.serverStatuses().find(entry => entry.name === 'clean');
    expect(line).toEqual({ name: 'clean', state: 'connected', toolCount: 2 });
    expect(pool.getInstructions('clean')).toBeUndefined();
  });
});

/** F1.595's `pick`, VERBATIM: a root `oneOf` with no root `type` — not the MCP `Tool` shape. */
const PICK: RawTool = {
  name: 'pick',
  description: 'Pick one.',
  inputSchema: {
    oneOf: [
      { type: 'object', properties: { a: { type: 'number' } }, required: ['a'] },
      { type: 'object', properties: { b: { type: 'boolean' } } },
    ],
  },
};

/** A well-formed tool with an `outputSchema`, so the SDK's output validation can be observed. */
const WITH_OUTPUT: RawTool & { outputSchema: Record<string, unknown> } = {
  name: 'withOutput',
  description: 'Returns structured content.',
  inputSchema: { type: 'object', properties: {} },
  outputSchema: { type: 'object', properties: { n: { type: 'number' } }, required: ['n'] },
};

describe('F1.643 — a tool the MCP shape refuses is skipped; the server stays connected', () => {
  it('connects a server that lists an untyped root combinator, and skips only that tool', async () => {
    // At HEAD the SDK's `Client.listTools` validated the WHOLE answer, so `pick`
    // failed the connect health check and the whole server was refused on every
    // runtime (WJ-bu measured it on Pi through the host pool).
    const client = await nessyClient([PLAIN, FIND_USER, PICK]);
    await client.connect();

    const tools = await client.listTools();
    expect(tools.map(tool => tool.name)).toEqual(['plain', 'findUser']);
    const skipped = client.getSkippedTools();
    expect(skipped.map(entry => entry.name)).toEqual(['pick']);
    expect(skipped[0]!.reason).toContain('inputSchema.type');
  });

  it('the pool keeps the server CONNECTED, serves the rest and names the skipped tool', async () => {
    const pool = new McpClientPool({});
    await registerFixtureClient(pool, 'combinators', await nessyClient([PLAIN, FIND_USER, PICK, BROKEN]));

    expect(pool.health().failed).toEqual([]);
    const served = pool.getProxyToolDefs(['combinators']).map(def => def.name);
    expect(served.some(name => name.endsWith('__plain'))).toBe(true);
    // CONTROL — the well-formed root combinator still reaches the runtimes.
    expect(served.some(name => name.endsWith('__findUser'))).toBe(true);
    expect(served.some(name => name.endsWith('__pick') || name.endsWith('__broken'))).toBe(false);

    const line = pool.serverStatuses().find(entry => entry.name === 'combinators');
    expect(line?.state).toBe('connected');
    expect(line?.toolCount).toBe(2);
    expect(line?.detail).toContain('2 tools skipped');
    expect(line?.detail).toContain('"pick"');
    expect(line?.detail).toContain('"broken"');
    expect(pool.getInstructions('combinators')).toContain('"pick"');
  });

  it('CONTROL — what `Client.listTools` did besides validating still happens: structured output is validated', async () => {
    // The tolerant path hands the kept tools to the SDK's private
    // `cacheToolMetadata`, which compiles each `outputSchema` for `callTool`.
    // The fixture answers without `structuredContent`, which the SDK refuses for
    // a tool that declares an output schema — so the refusal proves the cache.
    expect(typeof (Client.prototype as unknown as { cacheToolMetadata?: unknown }).cacheToolMetadata).toBe('function');
    const client = await nessyClient([PLAIN, WITH_OUTPUT]);
    await client.connect();
    await client.listTools();

    await expect(client.callTool('withOutput', {})).rejects.toThrow('output schema');
    // Negative control on the same client: a tool with no output schema answers.
    await expect(client.callTool('plain', { q: 'x' })).resolves.toBeDefined();
  });
});
