import { describe, expect, it } from 'bun:test';
import { parseMcpServersDocument } from '../project-config.ts';

/**
 * `mcp.md:83`: "When configuring MCP servers via JSON in `.mcp.json`,
 * `~/.claude.json`, or `claude mcp add-json`, the `type` field accepts
 * `streamable-http` as an alias for `http`." (`agent-sdk/mcp.md:378` states the
 * same rule for the SDK's JSON configs and keeps the programmatic option
 * `http`-only.) The doc names ONE exact literal — no case folding, no near
 * spellings — so the boundary cases pin the rejection as firmly as the alias.
 */
describe('.mcp.json streamable-http alias', () => {
  it('parses a streamable-http entry exactly as http, with every http field intact', () => {
    const warnings: string[] = [];
    const servers = parseMcpServersDocument({
      mcpServers: {
        control_http: { type: 'http', url: 'https://control.example.test/mcp' },
        alias_streamable: {
          type: 'streamable-http',
          url: 'https://mcp.example.test/mcp',
          headers: { Authorization: 'Bearer static-token' },
          oauth: { scopes: 'read' },
          timeout: 5000,
          alwaysLoad: true,
        },
      },
    }, message => warnings.push(message));

    expect(servers.alias_streamable).toEqual({
      type: 'http',
      url: 'https://mcp.example.test/mcp',
      headers: { Authorization: 'Bearer static-token' },
      oauth: { scopes: 'read' },
      toolTimeoutMs: 5000,
      alwaysLoad: true,
    });
    // The plain-http entry in the same document is the positive control: both
    // survive, and neither produces a warning.
    expect(servers.control_http).toEqual({ type: 'http', url: 'https://control.example.test/mcp' });
    expect(warnings).toEqual([]);
  });

  it('still drops near-miss spellings with the unsupported-config warning', () => {
    // The doc names one exact literal; a case-folded or suffixed spelling is
    // NOT the alias and must keep failing the way any unknown type does.
    for (const type of ['streamable-https', 'STREAMABLE-HTTP']) {
      const warnings: string[] = [];
      const servers = parseMcpServersDocument({
        mcpServers: {
          control_http: { type: 'http', url: 'https://control.example.test/mcp' },
          near_miss: { type, url: 'https://mcp.example.test/mcp' },
        },
      }, message => warnings.push(message));

      expect(servers.near_miss).toBeUndefined();
      expect(servers.control_http).toBeDefined();
      expect(warnings).toEqual(['Ignoring .mcp.json server "near_miss": unsupported MCP server config']);
    }
  });
});
