/**
 * F1.683 (re-scoped by F1.699's note) — two tools' output schemas that share a
 * top-level `$id`, or one tool's schema changed under the same `$id` and listed
 * again after `tools/list_changed`.
 *
 * The SDK `Client` compiles every `outputSchema` in ONE shared
 * `AjvJsonSchemaValidator`, whose `getValidator` returns the schema Ajv already
 * holds under that `$id` instead of compiling the new one
 * (`@modelcontextprotocol/sdk` `validation/ajv-provider.js`, `getValidator`:
 * `this._ajv.getSchema(schema.$id) ?? this._ajv.compile(schema)`). So the second
 * tool was validated against the FIRST tool's schema, and a re-listed tool kept
 * its old schema: a correct answer was refused with "Structured content does not
 * match the tool's output schema". The MCP spec does not make `$id` unique across
 * a server's tools.
 *
 * The client now hands the SDK a validator that compiles each schema in a fresh
 * Ajv, the instance `toolSchemaCompileError` already uses for the host check.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { NessyMcpClient } from '../client.ts';

type FixtureTool = {
  name: string;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  answer: Record<string, unknown>;
};

const SHARED_ID = 'urn:nessy:test:result';

const outputRequiring = (field: string): Record<string, unknown> => ({
  $id: SHARED_ID,
  type: 'object',
  properties: { [field]: { type: 'number' } },
  required: [field],
});

const tool = (name: string, field: string, answer: Record<string, unknown> = { [field]: 1 }): FixtureTool => ({
  name,
  inputSchema: { type: 'object', properties: {} },
  outputSchema: outputRequiring(field),
  answer,
});

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close().catch(() => {});
});

/** A low-level server whose tool list the test can replace between listings. */
async function fixture(initial: FixtureTool[]) {
  let tools = initial;
  const server = new Server({ name: 'f1683-fixture', version: '1.0.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map(({ answer: _answer, ...listed }) => structuredClone(listed)) as never,
  }));
  server.setRequestHandler(CallToolRequestSchema, async request => {
    const called = tools.find(entry => entry.name === request.params.name);
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(called?.answer ?? {}) }],
      structuredContent: called?.answer ?? {},
    };
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new NessyMcpClient(
    { transport: 'http', url: 'https://f1683.example.test/mcp' } as never,
    { transport: clientTransport } as never,
  );
  closers.push(async () => { await client.close(); await server.close(); });
  await client.connect();
  return { client, replaceTools: (next: FixtureTool[]) => { tools = next; } };
}

describe('F1.683 — output schemas that share an `$id` are validated each against its own tool', () => {
  it('two tools with one top-level `$id` each accept their own correct answer', async () => {
    const { client } = await fixture([tool('first', 'a'), tool('second', 'b')]);
    await client.listTools();

    await expect(client.callTool('first', {})).resolves.toBeDefined();
    // Before: validated against `first`'s schema, which requires `a`.
    await expect(client.callTool('second', {})).resolves.toBeDefined();
  });

  it('a tool listed again with a changed schema under the same `$id` is checked against the new one', async () => {
    const { client, replaceTools } = await fixture([tool('only', 'a')]);
    await client.listTools();
    await expect(client.callTool('only', {})).resolves.toBeDefined();

    replaceTools([tool('only', 'b')]);
    await client.listTools();

    // Before: the stale schema (requires `a`) was still the one Ajv held.
    await expect(client.callTool('only', {})).resolves.toBeDefined();
  });

  it('NEGATIVE — an answer that breaks its own tool\'s schema is still refused', async () => {
    const { client } = await fixture([tool('first', 'a'), tool('second', 'b', { a: 1 })]);
    await client.listTools();

    await expect(client.callTool('second', {})).rejects.toThrow('output schema');
  });
});
