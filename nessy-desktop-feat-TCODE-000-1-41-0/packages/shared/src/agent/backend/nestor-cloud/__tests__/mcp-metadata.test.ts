import { describe, expect, it } from 'bun:test';
import { buildNestorCloudMcpToolMetadata } from '../mcp-metadata.ts';
import { buildAdvertisedMcpName, normalizeNestorToolCall } from '../tool-schema.ts';

interface FakeTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

function fakePool(options: {
  tools: Record<string, FakeTool[]>;
  connected?: (slug: string) => boolean;
  leased?: string[];
}) {
  return {
    isConnected: (slug: string) => (options.connected ?? (() => true))(slug),
    getConnectedSlugs: () => Object.keys(options.tools),
    getTools: (slug: string) => options.tools[slug] ?? [],
    slugsForLeaser: () => new Set(options.leased ?? Object.keys(options.tools)),
  };
}

describe('buildNestorCloudMcpToolMetadata', () => {
  // The backend echoes the advertised name back verbatim on the call
  // (`codeagent/agent.go:95-112`, `Name: tool.Name`), and the only inbound MCP
  // form this module (and the reference connector) parses is `server|tool`.
  it('advertises server|tool built from the RAW tool names, never the mcp__ proxy name', () => {
    const pool = fakePool({
      tools: {
        jira: [{ name: 'get_issue', description: 'Get an issue', inputSchema: { type: 'object', properties: { key: { type: 'string' } } } }],
      },
    });

    expect(buildNestorCloudMcpToolMetadata(pool as never, ['jira'])).toEqual([{
      name: 'jira|get_issue',
      description: 'Get an issue',
      parameters: { type: 'object', properties: { key: { type: 'string' } } },
    }]);
  });

  it('keeps the intended-slug filter and the leaser scope', () => {
    const pool = fakePool({
      tools: {
        jira: [{ name: 'get_issue' }],
        gitlab: [{ name: 'get_mr' }],
        inactive: [{ name: 'never' }],
      },
      connected: slug => slug !== 'inactive',
      leased: ['jira', 'inactive'],
    });

    const scoped = buildNestorCloudMcpToolMetadata(pool as never, ['jira', 'gitlab', 'inactive'], 'leaser-1');
    expect(scoped?.map(tool => tool.name)).toEqual(['jira|get_issue']);
  });

  it('falls back to all connected slugs when the session has no intended slugs', () => {
    const pool = fakePool({ tools: { jira: [{ name: 'search' }] } });

    expect(buildNestorCloudMcpToolMetadata(pool as never, [])?.map(tool => tool.name)).toEqual(['jira|search']);
  });

  // `McpToolV1` requires Type/Name/Parameters (`a2a/extensions/tool_mcp.go:13-18`) and a
  // decode failure aborts the WHOLE mcp slice for that message, so no advertised entry may
  // rely on a default the encoder might drop.
  it('always emits a description and a parameters object, and strips $schema', () => {
    const pool = fakePool({
      tools: {
        files: [
          { name: 'read', inputSchema: { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object', properties: {} } },
          { name: 'write', inputSchema: {} },
          { name: 'noschema' },
        ],
      },
    });

    expect(buildNestorCloudMcpToolMetadata(pool as never, ['files'])).toEqual([
      { name: 'files|read', description: 'Tool from files', parameters: { type: 'object', properties: {} } },
      { name: 'files|write', description: 'Tool from files', parameters: { type: 'object', properties: {} } },
      { name: 'files|noschema', description: 'Tool from files', parameters: { type: 'object', properties: {} } },
    ]);
  });

  it('returns undefined without a pool, without target slugs, and without tools', () => {
    expect(buildNestorCloudMcpToolMetadata(undefined, ['jira'])).toBeUndefined();
    expect(buildNestorCloudMcpToolMetadata(fakePool({ tools: {} }) as never, [])).toBeUndefined();
    expect(buildNestorCloudMcpToolMetadata(fakePool({ tools: { jira: [] } }) as never, ['jira'])).toBeUndefined();
  });

  // The round trip is the whole point of F3: whatever we advertise must parse back into the
  // (server, tool) pair `McpClientPool.getProxyName` resolves the real proxy name from.
  it('round-trips every advertised name back through the inbound parser', () => {
    const pool = fakePool({
      tools: {
        jira: [{ name: 'get_issue' }],
        filesystem: [{ name: 'read/file' }, { name: 'weird|tool' }],
      },
    });

    const advertised = buildNestorCloudMcpToolMetadata(pool as never, []) ?? [];
    expect(advertised.map(tool => tool.name)).toEqual(['jira|get_issue', 'filesystem|read/file', 'filesystem|weird|tool']);

    const parsed = advertised.map((tool, index) => normalizeNestorToolCall({
      id: `call-${index}`,
      index,
      name: tool.name,
      arguments: '{}',
    }));

    expect(parsed.map(call => call.kind)).toEqual(['mcp', 'mcp', 'mcp']);
    expect(parsed.map(call => [call.mcp?.server, call.mcp?.tool])).toEqual([
      ['jira', 'get_issue'],
      ['filesystem', 'read/file'],
      ['filesystem', 'weird|tool'],
    ]);
  });

  it('builds the advertised name through the same helper the parser is written against', () => {
    expect(buildAdvertisedMcpName('jira', 'get_issue')).toBe('jira|get_issue');
    expect(buildAdvertisedMcpName('filesystem', 'read/file')).toBe('filesystem|read/file');
  });
});
