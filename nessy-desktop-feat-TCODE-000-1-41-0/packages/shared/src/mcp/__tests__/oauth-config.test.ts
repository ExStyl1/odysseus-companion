import { describe, expect, it } from 'bun:test';
import { parseMcpServersDocument } from '../project-config.ts';

/**
 * The `oauth` object of a `.mcp.json` server entry.
 *
 * `mcp.md:715`: "Set `authServerMetadataUrl` in the `oauth` object of your
 * server's config in `.mcp.json`", and `:731` "The URL must use `https://`."
 * `mcp.md:735`: "Set `oauth.scopes` to pin the scopes Claude Code requests
 * during the authorization flow. … The value is a single space-separated
 * string, matching the `scope` parameter format in RFC 6749 §3.3."
 */
describe('.mcp.json oauth object', () => {
  const parse = (server: unknown) => {
    const warnings: string[] = [];
    const servers = parseMcpServersDocument({ mcpServers: { docs: server } }, message => warnings.push(message));
    return { config: servers.docs, warnings };
  };

  it('carries both documented fields onto the server config', () => {
    const { config, warnings } = parse({
      type: 'http',
      url: 'https://mcp.example.test/mcp',
      oauth: {
        authServerMetadataUrl: 'https://auth.example.test/.well-known/openid-configuration',
        scopes: 'channels:read chat:write search:read',
      },
    });

    expect(config).toEqual({
      type: 'http',
      url: 'https://mcp.example.test/mcp',
      oauth: {
        authServerMetadataUrl: 'https://auth.example.test/.well-known/openid-configuration',
        scopes: 'channels:read chat:write search:read',
      },
    });
    expect(warnings).toEqual([]);
  });

  it('normalises the scope string to single spaces', () => {
    const { config } = parse({
      type: 'sse',
      url: 'https://mcp.example.test/sse',
      oauth: { scopes: '  channels:read   chat:write \n' },
    });

    expect(config).toMatchObject({ oauth: { scopes: 'channels:read chat:write' } });
  });

  it('a server with no oauth object is byte-identical to before', () => {
    const { config, warnings } = parse({ type: 'http', url: 'https://mcp.example.test/mcp' });

    expect(config).toEqual({ type: 'http', url: 'https://mcp.example.test/mcp' });
    expect(warnings).toEqual([]);
  });

  // The failure mode this guards: dropping a working server because an optional
  // auth hint was mistyped.
  it.each([
    ['a non-https metadata URL', { authServerMetadataUrl: 'http://auth.example.test/meta' }, 'must use https://'],
    ['an unparseable metadata URL', { authServerMetadataUrl: 'not a url' }, 'is not a valid URL'],
    ['an array of scopes', { scopes: ['channels:read'] }, 'single space-separated string'],
    ['a non-object oauth value', 'yes', 'must be an object'],
  ])('keeps the server and names the problem for %s', (_label, oauth, expected) => {
    const { config, warnings } = parse({ type: 'http', url: 'https://mcp.example.test/mcp', oauth });

    expect(config).toEqual({ type: 'http', url: 'https://mcp.example.test/mcp' });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('"docs"');
    expect(warnings[0]).toContain(expected);
  });

  it('ignores an unknown key inside oauth rather than dropping the server', () => {
    const { config, warnings } = parse({
      type: 'http',
      url: 'https://mcp.example.test/mcp',
      oauth: { scopes: 'channels:read', futureField: { nested: true } },
    });

    expect(config).toMatchObject({ oauth: { scopes: 'channels:read' } });
    expect(warnings).toEqual([]);
  });

  // `mcp.md:707`: "These flags only apply to HTTP and SSE transports. They have
  // no effect on stdio servers."
  it('does not attach oauth to a stdio server', () => {
    const { config } = parse({ command: 'server', oauth: { scopes: 'channels:read' } });

    expect(config).toEqual({ type: 'stdio', command: 'server' });
  });
});
