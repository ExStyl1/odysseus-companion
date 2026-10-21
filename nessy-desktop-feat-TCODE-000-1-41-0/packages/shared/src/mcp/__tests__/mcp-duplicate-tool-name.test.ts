/**
 * F1.695 — an MCP server that lists two tools with the SAME name costs the
 * second one, never every Pi prompt of the session.
 *
 * What verification round 2 found (`work/verify-crit/verdicts-r2.json`, the
 * F1.665 bypass lens, 2026-09-25): `partitionListedTools` checked each tool's
 * shape and Pi's compile but never whether its name was unique in the listing,
 * so both `x` tools were kept. The pool routes them as `mcp__s__x` and
 * `mcp__s__x_2`, but `getProxyName(slug, 'x')` answers the FIRST route for both,
 * so `getProxyToolDefs` emitted two defs named `mcp__s__x`, and
 * `finalizePiExecutionManifest` threw `Pi execution manifest duplicate piName`
 * on the subprocess spawn and on every turn — F1.644's outcome with no notice.
 * (Since F1.706 the manifest drops the later def with a debug line instead, so
 * that debug line is this file's instrument for a repeat reaching Pi.)
 *
 * The decision: the MCP spec says tool names "SHOULD be unique within a server"
 * (`server/tools`, 2025-11-25) and, like Claude's `mcp.md` (both read
 * 2026-09-25), does not say what a client does with a repeat. So the first KEPT
 * tool of a name wins, in the server's order, and every later one is skipped
 * with a reason on the four surfaces F1.644's skips already ride. "Kept" and not "listed": a first
 * `x` the host refuses for its schema does not take a healthy second `x` with it.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { NessyMcpClient, partitionListedTools } from '../client.ts';
import { McpClientPool, toolDescriptorStoreKey } from '../mcp-pool.ts';
import type { ToolDescriptorStore } from '../tool-descriptor-store.ts';
import { validateStdioMcpConnection } from '../validation.ts';
import type { SdkMcpServerConfig } from '../../agent/backend/types.ts';
import {
  finalizePiExecutionManifest,
  type PiDynamicToolDefinition,
  type PiExecutionManifestSeedV2,
} from '../../agent/pi-harness/harness-manifest.ts';
import { registerFixtureClient } from './pool-fixture.ts';

type RawTool = { name: string; description?: string; inputSchema: Record<string, unknown> };

const PLAIN: RawTool = {
  name: 'plain',
  description: 'plain tool',
  inputSchema: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
};
/** The first `x` the server lists — the one the host keeps. */
const X_FIRST: RawTool = {
  name: 'x',
  description: 'first x',
  inputSchema: { type: 'object', properties: { a: { type: 'string' } } },
};
/** A second tool with the same name and a different body — the one the host skips. */
const X_SECOND: RawTool = {
  name: 'x',
  description: 'second x',
  inputSchema: { type: 'object', properties: { b: { type: 'number' } } },
};
/** An `x` the host refuses for its schema (WJ-bu's `broken` shape). */
const X_BROKEN: RawTool = {
  name: 'x',
  description: 'broken x',
  inputSchema: { type: 'object', anyOf: { properties: { id: { type: 'string' } } } },
};

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close().catch(() => {});
});

/** A low-level SDK `Server` answering `tools/list` verbatim (the high-level one refuses a duplicate name). */
async function rawServer(tools: readonly RawTool[]) {
  const server = new Server({ name: 'f1695-fixture', version: '1.0.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: structuredClone(tools) as never }));
  server.setRequestHandler(CallToolRequestSchema, async request => ({
    content: [{ type: 'text' as const, text: `ok ${request.params.name}` }],
  }));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  closers.push(async () => { await server.close(); });
  return clientTransport;
}

async function nessyClient(tools: readonly RawTool[]): Promise<NessyMcpClient> {
  const client = new NessyMcpClient(
    { transport: 'http', url: 'https://f1695.example.test/mcp' } as never,
    { transport: await rawServer(tools) } as never,
  );
  closers.push(async () => { await client.close(); });
  return client;
}

/**
 * The Pi manifest a session would be built from, for the defs one server
 * serves: the seed carries that server's wire name, and each def becomes a
 * dynamic tool the way `PiAgent.buildExecutionManifestForCurrentTurn` maps it.
 * `debug` collects the manifest's F1.706 duplicate-piName lines.
 */
function piManifestFor(
  wireName: string,
  defs: ReadonlyArray<{ name: string; description: string; inputSchema: Record<string, unknown> }>,
  debug: string[] = [],
) {
  const generation = 'f1695-generation';
  const seed: PiExecutionManifestSeedV2 = {
    surfaceVersion: 2,
    snapshotGeneration: generation,
    sessionKey: { workspaceId: 'workspace-f1695', sessionId: 'session-f1695' },
    provenance: [{ capabilityKey: wireName, generation }],
    mcpSources: [{ wireName, capabilityKey: wireName, generation }],
    orchestrator: { concurrency: 4, depth: 2, maxParallelTasks: 8, maxAgents: 100, tierModelMap: null, tokenBudget: null },
    staticTools: [],
  };
  const dynamic: PiDynamicToolDefinition[] = defs.map(def => ({
    bindingName: def.name,
    description: def.description,
    inputSchema: def.inputSchema,
    modelSchemaVersion: 1,
    bindingSchemaVersion: 1,
    provenance: { capabilityKey: wireName, generation },
  }));
  return finalizePiExecutionManifest(seed, dynamic, { debug: line => { debug.push(line); } });
}

describe('F1.695 — two listed tools with one name: the first kept wins, the rest are skipped with a reason', () => {
  it('POSITIVE CONTROL — the Pi manifest build reports two defs of one name (the instrument sees the defect)', () => {
    const def = { name: 'mcp__dup__x', description: 'x', inputSchema: { type: 'object', properties: {} } };
    // F1.706: the build keeps the first def and reports the later one, where it used to throw.
    const lines: string[] = [];
    expect(piManifestFor('dup', [def, { ...def, description: 'x again' }], lines).tools.map(tool => tool.description))
      .toEqual(['x']);
    expect(lines).toEqual([
      'pi-manifest: duplicate piName "mcp__dup__x" — keeping the tool already in the manifest, dropping the later one from dup',
    ]);
    const quiet: string[] = [];
    piManifestFor('dup', [def], quiet);
    expect(quiet).toEqual([]);
  });

  it('the pool serves each name once, and the Pi manifest built from what it serves reports no repeat', async () => {
    const pool = new McpClientPool({});
    await registerFixtureClient(pool, 'dup', await nessyClient([X_FIRST, PLAIN, X_SECOND]));

    const served = pool.getProxyToolDefs(['dup']);
    // At HEAD the pool served ['mcp__dup__x', 'mcp__dup__plain', 'mcp__dup__x'],
    // and this build threw 'Pi execution manifest duplicate piName: mcp__dup__x'.
    const lines: string[] = [];
    const manifest = piManifestFor('dup', served as never, lines);
    expect(lines).toEqual([]);
    expect(served.map(def => def.name)).toEqual(['mcp__dup__x', 'mcp__dup__plain']);
    expect(served.find(def => def.name === 'mcp__dup__x')?.description).toContain('first x');
    expect(manifest.tools.map(tool => tool.binding.piName)).toEqual(['mcp__dup__plain', 'mcp__dup__x']);
  });

  it('the client keeps the FIRST `x` and names the second on getSkippedTools with its reason', async () => {
    const client = await nessyClient([X_FIRST, PLAIN, X_SECOND]);
    await client.connect();

    const tools = await client.listTools();
    expect(tools.map(tool => tool.name)).toEqual(['x', 'plain']);
    expect(tools[0]!.description).toBe('first x');
    const skipped = client.getSkippedTools();
    expect(skipped.map(entry => entry.name)).toEqual(['x']);
    expect(skipped[0]!.reason).toContain('same name');
  });

  it('the user (/mcp detail) and the model (the notice) are told which tool was skipped and why', async () => {
    const pool = new McpClientPool({});
    await registerFixtureClient(pool, 'dup', await nessyClient([X_FIRST, PLAIN, X_SECOND]));

    const line = pool.serverStatuses().find(entry => entry.name === 'dup');
    expect(line?.state).toBe('connected');
    expect(line?.toolCount).toBe(2);
    expect(line?.detail).toContain('1 tool skipped');
    expect(line?.detail).toContain('"x"');
    expect(line?.detail).toContain('same name');
    const instructions = pool.getInstructions('dup');
    expect(instructions).toContain('"x"');
    expect(instructions).toContain('same name');
  });

  it('BOUNDARY — a first `x` refused for its schema does not take a healthy second `x` with it', () => {
    const { tools, skipped } = partitionListedTools([X_BROKEN, X_SECOND, PLAIN]);
    expect(tools.map(tool => [tool.name, tool.description])).toEqual([['x', 'second x'], ['plain', 'plain tool']]);
    expect(skipped).toHaveLength(1);
    expect(skipped[0]!.reason).toContain('anyOf value must be ["array"]');
  });

  it('a third tool of the same name is skipped too, each with its own entry', () => {
    const { tools, skipped } = partitionListedTools([X_FIRST, X_SECOND, { ...X_SECOND, description: 'third x' }]);
    expect(tools.map(tool => tool.description)).toEqual(['first x']);
    expect(skipped.map(entry => entry.name)).toEqual(['x', 'x']);
  });

  it('CONTROL — distinct names are unchanged: the client lists exactly what the SDK client lists, and nothing is skipped', async () => {
    const client = await nessyClient([X_FIRST, PLAIN]);
    await client.connect();
    const ours = await client.listTools();

    const sdk = new Client({ name: 'control', version: '1.0.0' });
    await sdk.connect(await rawServer([X_FIRST, PLAIN]));
    closers.push(async () => { await sdk.close(); });

    expect(ours).toEqual((await sdk.listTools()).tools);
    expect(client.getSkippedTools()).toEqual([]);
    const pool = new McpClientPool({});
    await registerFixtureClient(pool, 'clean', await nessyClient([X_FIRST, PLAIN]));
    expect(pool.serverStatuses().find(entry => entry.name === 'clean')).toEqual({ name: 'clean', state: 'connected', toolCount: 2 });
  });

  it('CONTROL — names that differ only in case are two tools, not a duplicate', () => {
    const { tools, skipped } = partitionListedTools([X_FIRST, { ...X_SECOND, name: 'X' }]);
    expect(tools.map(tool => tool.name)).toEqual(['x', 'X']);
    expect(skipped).toEqual([]);
  });
});

const STDIO_CONFIG = { type: 'stdio', command: '/bin/true', args: [] } as SdkMcpServerConfig;

function memoryStore(seed: Record<string, readonly RawTool[]> = {}): ToolDescriptorStore {
  const written: Record<string, Tool[]> = {};
  return {
    read: key => (seed[key] as Tool[] | undefined) ?? written[key],
    write: (key, tools) => { written[key] = [...tools]; },
  };
}

/** A pool whose durable store holds `record` for `alpha`, synced but never connected (F1.665's recipe). */
async function hydratedPool(record: readonly RawTool[]): Promise<McpClientPool> {
  const keyPool = new McpClientPool({ toolDescriptorStore: memoryStore() });
  await keyPool.sync({ alpha: STDIO_CONFIG }, {}, { leaserId: 'L' });
  const key = toolDescriptorStoreKey(keyPool.connectionKeyForDesired('alpha', 'L')!);
  const pool = new McpClientPool({ toolDescriptorStore: memoryStore({ [key]: record }) });
  await pool.sync({ alpha: STDIO_CONFIG }, {}, { leaserId: 'L' });
  return pool;
}

describe('F1.695 — the hydrated record and the stdio source_test take the same partition', () => {
  it('a durable descriptor record carrying two `x` tools serves one, before any connect', async () => {
    const pool = await hydratedPool([X_FIRST, PLAIN, X_SECOND]);
    expect(pool.isConnected('alpha', 'L')).toBe(false);
    const served = pool.getProxyToolDefs(['alpha'], 'L');
    expect(served.map(def => def.name)).toEqual(['mcp__alpha__x', 'mcp__alpha__plain']);
    const lines: string[] = [];
    piManifestFor('alpha', served as never, lines);
    expect(lines).toEqual([]);
  });

  /** A newline-delimited JSON-RPC stdio server listing `tools` verbatim (F1.665's recipe, no backtick). */
  function stdioServer(tools: readonly RawTool[]): string {
    return [
      "const rl = require('node:readline').createInterface({ input: process.stdin });",
      "const send = m => process.stdout.write(JSON.stringify(m) + '\\n');",
      'const TOOLS = ' + JSON.stringify(tools) + ';',
      "rl.on('line', line => {",
      '  let r; try { r = JSON.parse(line); } catch { return; }',
      "  if (r.method === 'initialize') return send({ jsonrpc: '2.0', id: r.id, result: { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'f1695-stdio', version: '1.0.0' } } });",
      "  if (r.method === 'tools/list') return send({ jsonrpc: '2.0', id: r.id, result: { tools: TOOLS } });",
      "  if (r.id !== undefined) send({ jsonrpc: '2.0', id: r.id, error: { code: -32601, message: 'not found' } });",
      '});',
    ].join('\n');
  }

  it('the stdio source_test lists each name once and names the skipped duplicate in its warning', async () => {
    const result = await validateStdioMcpConnection({
      command: 'node',
      args: ['-e', stdioServer([X_FIRST, PLAIN, X_SECOND])],
      timeout: 8000,
    });
    expect(result.success).toBe(true);
    expect(result.tools).toEqual(['x', 'plain']);
    expect(result.warning).toContain('1 tool skipped');
    expect(result.warning).toContain('"x"');
    expect(result.warning).toContain('same name');
  }, 15000);
});
