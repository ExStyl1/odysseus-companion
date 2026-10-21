/**
 * F1.665 — the gaps the adversarial verification found in F1.644 / F1.643
 * (`work/verify-crit/verdicts.json`, 2026-09-25).
 *
 * (a) F1.644's host check was a HAND COPY of Pi's compile that left out
 * `ajv-formats`, and its docblock said that could not change whether a compile
 * throws. It can: the SDK's `AjvJsonSchemaValidator` default instance calls
 * `addFormats`, and ajv-formats 3 registers the `formatMaximum` /
 * `formatMinimum` / `formatExclusive*` KEYWORDS by default — declared
 * `schemaType: "string"`, depending on `format`, and needing a `compare`
 * function. So a tool with one of them passed the host check and still made
 * every Pi prompt fail at session build. The check is now Pi's own call, and
 * `createToolInputValidator` below IS Pi's function, imported rather than
 * re-spelled, so the agreement is measured, not asserted.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { NessyMcpClient, toolSchemaCompileError } from '../client.ts';
import { McpClientPool, toolDescriptorStoreKey } from '../mcp-pool.ts';
import type { ToolDescriptorStore } from '../tool-descriptor-store.ts';
import type { SdkMcpServerConfig } from '../../agent/backend/types.ts';
import { createToolInputValidator } from '../../agent/pi-harness/tool-executor.ts';
import { validateStdioMcpConnection } from '../validation.ts';

type RawTool = {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
};

const objectOf = (property: Record<string, unknown>): Record<string, unknown> => ({
  type: 'object',
  properties: { d: property },
});

/** Schemas Pi's compile REFUSES and F1.644's copy accepted (the verifier's three, measured). */
const FORMAT_LIMIT_REFUSED: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
  ['a non-string formatMaximum', objectOf({ type: 'string', formatMaximum: 5 })],
  ['formatMaximum without format', objectOf({ type: 'string', formatMaximum: '2020-01-01' })],
  ['formatMinimum on a format with no compare', objectOf({ type: 'string', format: 'email', formatMinimum: 'a' })],
  ['a non-string formatExclusiveMinimum', objectOf({ type: 'string', format: 'date', formatExclusiveMinimum: 1 })],
];

/** CONTROLS — schemas both accept: a WELL-FORMED format limit, and a plain tool. */
const ACCEPTED: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
  ['a well-formed date formatMaximum', objectOf({ type: 'string', format: 'date', formatMaximum: '2030-01-01' })],
  ['a plain string property', objectOf({ type: 'string' })],
  ['an unknown format (ignored, never thrown)', objectOf({ type: 'string', format: 'nessy-custom' })],
];

/** Pi's verdict: does its session-build compile throw on these parameters? */
function piRefuses(schema: Record<string, unknown>): boolean {
  try {
    createToolInputValidator(schema, 'probe');
    return false;
  } catch {
    return true;
  }
}

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close().catch(() => {});
});

/** A low-level SDK `Server` answering `tools/list` verbatim (the high-level one builds its own schemas). */
async function nessyClient(tools: readonly RawTool[]): Promise<NessyMcpClient> {
  const server = new Server({ name: 'f1665-fixture', version: '1.0.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: structuredClone(tools) as never }));
  server.setRequestHandler(CallToolRequestSchema, async request => ({
    content: [{ type: 'text' as const, text: `ok ${request.params.name}` }],
  }));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  closers.push(async () => { await server.close(); });
  const client = new NessyMcpClient(
    { transport: 'http', url: 'https://f1665.example.test/mcp' } as never,
    { transport: clientTransport } as never,
  );
  closers.push(async () => { await client.close(); });
  return client;
}

const PLAIN: RawTool = {
  name: 'plain',
  description: 'plain tool',
  inputSchema: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
};

describe('F1.665 (a) — the host check is exactly Pi\'s compile, formats included', () => {
  it('POSITIVE CONTROL — Pi\'s own compile refuses every format-limit fixture and accepts every control', () => {
    for (const [, schema] of FORMAT_LIMIT_REFUSED) expect(piRefuses(schema)).toBe(true);
    for (const [, schema] of ACCEPTED) expect(piRefuses(schema)).toBe(false);
  });

  for (const [label, schema] of [...FORMAT_LIMIT_REFUSED, ...ACCEPTED]) {
    it(`agrees with Pi on ${label}`, () => {
      expect(toolSchemaCompileError(schema) !== undefined).toBe(piRefuses(schema));
    });
  }

  it('agrees with Pi on a tool whose $id is a registered meta-schema URI (Pi accepts it; F1.644\'s copy skipped it)', () => {
    const schema = { $id: 'http://json-schema.org/draft-07/schema', type: 'object', properties: {} };
    expect(piRefuses(schema)).toBe(false);
    expect(toolSchemaCompileError(schema)).toBeUndefined();
  });

  it('a listed tool with a non-string formatMaximum is skipped with its reason; the healthy tool is kept', async () => {
    const client = await nessyClient([PLAIN, { name: 'dated', inputSchema: FORMAT_LIMIT_REFUSED[0]![1] }]);
    await client.connect();

    const tools = await client.listTools();
    expect(tools.map(tool => tool.name)).toEqual(['plain']);
    const skipped = client.getSkippedTools();
    expect(skipped.map(entry => entry.name)).toEqual(['dated']);
    expect(skipped[0]!.reason).toContain('formatMaximum');
  });

  it('an OUTPUT schema with a non-string formatMaximum costs that tool, not the server (the SDK\'s cacheToolMetadata compiles it with formats)', async () => {
    const client = await nessyClient([
      PLAIN,
      { name: 'reports', inputSchema: { type: 'object', properties: {} }, outputSchema: FORMAT_LIMIT_REFUSED[0]![1] },
    ]);
    // At F1.644 this connect threw 'MCP connection failed health check' — the
    // whole server refused on every runtime.
    await client.connect();
    expect((await client.listTools()).map(tool => tool.name)).toEqual(['plain']);
    expect(client.getSkippedTools().map(entry => entry.name)).toEqual(['reports']);
  });
});

/** WJ-bu's `broken` (F1.644): a root `anyOf` that is an object, not a list. */
const BROKEN: RawTool = {
  name: 'broken',
  inputSchema: { type: 'object', anyOf: { properties: { id: { type: 'string' } } } },
};

/** F1.595's `pick` (F1.643): a root `oneOf` with no root `type` — not the MCP `Tool` shape. */
const PICK: RawTool = {
  name: 'pick',
  inputSchema: { oneOf: [{ type: 'object', properties: { a: { type: 'number' } } }] },
};

const STDIO_CONFIG = { type: 'stdio', command: '/bin/true', args: [] } as SdkMcpServerConfig;

function memoryStore(seed: Record<string, readonly RawTool[]> = {}): ToolDescriptorStore {
  const written: Record<string, Tool[]> = {};
  return {
    read: key => (seed[key] as Tool[] | undefined) ?? written[key],
    write: (key, tools) => { written[key] = [...tools]; },
  };
}

/** A pool whose durable store holds `record` for `alpha`, synced but never connected. */
async function hydratedPool(record: readonly RawTool[]): Promise<McpClientPool> {
  // The key derivation is the pool's own (mcp-pool-descriptor-cache.test.ts's recipe).
  const keyPool = new McpClientPool({ toolDescriptorStore: memoryStore() });
  await keyPool.sync({ alpha: STDIO_CONFIG }, {}, { leaserId: 'L' });
  const key = toolDescriptorStoreKey(keyPool.connectionKeyForDesired('alpha', 'L')!);
  const pool = new McpClientPool({ toolDescriptorStore: memoryStore({ [key]: record }) });
  await pool.sync({ alpha: STDIO_CONFIG }, {}, { leaserId: 'L' });
  return pool;
}

describe('F1.665 (b) — a descriptor record from the durable store is re-partitioned before it is served', () => {
  it('a pre-F1.644 record carrying malformed tools serves only the healthy one (no connect needed)', async () => {
    // Before 627ce3d25 the pool wrote the RAW tools/list answer, so exactly the
    // servers F1.644 fixed can hold `broken` on disk, and a first turn (or a
    // connect that then fails) was served from it straight into Pi's compile.
    const pool = await hydratedPool([
      PLAIN,
      BROKEN,
      { name: 'dated', inputSchema: FORMAT_LIMIT_REFUSED[0]![1] },
      PICK,
    ]);
    expect(pool.isConnected('alpha', 'L')).toBe(false);
    const served = pool.getProxyToolDefs(['alpha'], 'L');
    expect(served.map(def => def.name)).toEqual(['mcp__alpha__plain']);
    for (const def of served) {
      expect(piRefuses(def.inputSchema as Record<string, unknown>)).toBe(false);
    }
  });

  it('CONTROL — a clean record hydrates unchanged, before any connect', async () => {
    const pool = await hydratedPool([PLAIN, { name: 'dated', inputSchema: ACCEPTED[0]![1] }]);
    expect(pool.isConnected('alpha', 'L')).toBe(false);
    expect(pool.getProxyToolDefs(['alpha'], 'L').map(def => def.name)).toEqual(['mcp__alpha__plain', 'mcp__alpha__dated']);
  });
});

/**
 * A newline-delimited JSON-RPC stdio MCP server listing `tools` verbatim, as a
 * `node -e` program. Built by concatenation: a backtick inside a generated
 * program is the trap AGENTS.md records for preload templates.
 */
function stdioServer(tools: readonly RawTool[]): string {
  return [
    "const rl = require('node:readline').createInterface({ input: process.stdin });",
    "const send = m => process.stdout.write(JSON.stringify(m) + '\\n');",
    'const TOOLS = ' + JSON.stringify(tools) + ';',
    "rl.on('line', line => {",
    '  let r; try { r = JSON.parse(line); } catch { return; }',
    "  if (r.method === 'initialize') return send({ jsonrpc: '2.0', id: r.id, result: { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'f1665-stdio', version: '1.0.0' } } });",
    "  if (r.method === 'tools/list') return send({ jsonrpc: '2.0', id: r.id, result: { tools: TOOLS } });",
    "  if (r.id !== undefined) send({ jsonrpc: '2.0', id: r.id, error: { code: -32601, message: 'not found' } });",
    '});',
  ].join('\n');
}

describe('F1.665 (c) — the stdio source_test validator lists tolerantly and warns', () => {
  it('a stdio server listing an untyped root combinator and a Pi-uncompilable tool still validates; the skips are one warning line', async () => {
    // At F1.643 this called the SDK's `Client.listTools`, which checks the whole
    // answer at once: `pick` failed the probe, and source_test marked the source
    // `error` and refused to auto-enable it — while the pool would connect it.
    const result = await validateStdioMcpConnection({
      command: 'node',
      args: ['-e', stdioServer([PLAIN, PICK, BROKEN])],
      timeout: 8000,
    });
    expect(result.error).toBeUndefined();
    expect(result.success).toBe(true);
    expect(result.tools).toEqual(['plain']);
    expect(result.warning).toContain('2 tools skipped');
    expect(result.warning).toContain('"pick"');
    expect(result.warning).toContain('"broken"');
  }, 15000);

  it('CONTROL — a clean stdio server validates with its tools and no warning', async () => {
    const result = await validateStdioMcpConnection({
      command: 'node',
      args: ['-e', stdioServer([PLAIN])],
      timeout: 8000,
    });
    expect(result.success).toBe(true);
    expect(result.tools).toEqual(['plain']);
    expect(result.warning).toBeUndefined();
  }, 15000);
});
