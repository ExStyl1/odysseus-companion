/**
 * C2 of the capability-path plan: `source_oauth_trigger` grows the
 * plugin-server target — `{pluginKey, serverName}` authenticates a
 * plugin-owned MCP server's GLOBAL credential slot, routed through the host's
 * `resolvePluginMcpServer` seam. The source path is byte-identical.
 */

import { describe, expect, it } from 'bun:test';
import { handleSourceOAuthTrigger } from './source-oauth.ts';
import type { AuthRequest } from '../types.ts';
import type { SessionToolContext } from '../context.ts';

function createCtx(overrides: Partial<SessionToolContext> = {}): {
  ctx: SessionToolContext;
  authRequests: AuthRequest[];
} {
  const authRequests: AuthRequest[] = [];
  const ctx = {
    configRoot: '/tmp/unused',
    sessionId: 'session-1',
    workspacePath: '/tmp/unused/workspaces/ws_a',
    get sourcesPath() { return '/tmp/unused/sources'; },
    get skillsPath() { return '/tmp/unused/skills'; },
    plansFolderPath: '/tmp/unused/plans',
    callbacks: {
      onAuthRequest: (request: AuthRequest) => { authRequests.push(request); },
    },
    fs: {} as never,
    loadSourceConfig: () => null,
    ...overrides,
  } as unknown as SessionToolContext;
  return { ctx, authRequests };
}

describe('source_oauth_trigger plugin-server target', () => {
  it('emits an oauth auth request carrying the plugin target', async () => {
    const { ctx, authRequests } = createCtx({
      resolvePluginMcpServer: (pluginKey, serverName) => (
        pluginKey === 'mk.tracker' && serverName === 'tracker-mcp'
          ? { displayName: 'Tracker', authType: 'oauth' }
          : null
      ),
    });

    const result = await handleSourceOAuthTrigger(ctx, {
      pluginKey: 'mk.tracker',
      serverName: 'tracker-mcp',
    });

    expect(result.isError).toBeFalsy();
    expect(authRequests).toHaveLength(1);
    const request = authRequests[0]!;
    expect(request.type).toBe('oauth');
    expect(request).toMatchObject({
      sourceSlug: 'tracker-mcp',
      sourceName: 'Tracker',
      pluginServer: { pluginKey: 'mk.tracker', serverName: 'tracker-mcp' },
    });
  });

  it('refuses a half target, a double target, a non-oauth server, and a host without the seam', async () => {
    const resolve = () => ({ displayName: 'Tracker', authType: 'bearer' as const });

    const half = await handleSourceOAuthTrigger(createCtx({ resolvePluginMcpServer: resolve }).ctx, {
      pluginKey: 'mk.tracker',
    });
    expect(half.isError).toBe(true);
    expect(half.content[0]!.text).toContain('BOTH pluginKey and serverName');

    const both = await handleSourceOAuthTrigger(createCtx({ resolvePluginMcpServer: resolve }).ctx, {
      sourceSlug: 'my-tracker',
      pluginKey: 'mk.tracker',
      serverName: 'tracker-mcp',
    });
    expect(both.isError).toBe(true);
    expect(both.content[0]!.text).toContain('not both');

    const bearer = await handleSourceOAuthTrigger(createCtx({ resolvePluginMcpServer: resolve }).ctx, {
      pluginKey: 'mk.tracker',
      serverName: 'tracker-mcp',
    });
    expect(bearer.isError).toBe(true);
    expect(bearer.content[0]!.text).toContain('not configured for OAuth');

    const noSeam = await handleSourceOAuthTrigger(createCtx().ctx, {
      pluginKey: 'mk.tracker',
      serverName: 'tracker-mcp',
    });
    expect(noSeam.isError).toBe(true);
    expect(noSeam.content[0]!.text).toContain('not available in this session runtime');

    const missing = await handleSourceOAuthTrigger(
      createCtx({ resolvePluginMcpServer: () => null }).ctx,
      { pluginKey: 'mk.gone', serverName: 'gone-mcp' },
    );
    expect(missing.isError).toBe(true);
    expect(missing.content[0]!.text).toContain('not found or not enabled');
  });

  it('the source path still requires a slug and reports an unknown source as before', async () => {
    const none = await handleSourceOAuthTrigger(createCtx().ctx, {});
    expect(none.isError).toBe(true);

    const unknown = await handleSourceOAuthTrigger(createCtx().ctx, { sourceSlug: 'ghost' });
    expect(unknown.isError).toBe(true);
    expect(unknown.content[0]!.text).toContain("Source 'ghost' not found");
  });
});
