/**
 * B3 — the model-facing plugin sign-in tool is wired.
 *
 * `SessionToolContext.resolvePluginMcpServer` was declared optional
 * (`session-tools-core/src/context.ts`) and consumed by
 * `handleSourceOAuthTrigger`, but NOTHING assigned it: an exhaustive
 * `grep -ran resolvePluginMcpServer` returned the declaration and the two uses
 * and nothing else. So the model was told the trigger exists and, on calling it
 * with a plugin target, got "Plugin MCP server authentication is not available
 * in this session runtime."
 *
 * These tests drive the PRODUCTION path a Pi turn actually takes —
 * `PiAgent.routeToolCall` → `executeSessionTool` → the canonical session-tool
 * registry handler → the context `pi-agent.ts` itself builds — and never inject
 * the seam by hand. A test that hands `resolvePluginMcpServer` to the handler
 * proves the handler, which was never the broken half.
 */
import { describe, expect, it } from 'bun:test';
import { PiAgent } from '../pi-agent.ts';
import type { BackendConfig, CapabilityTurnRuntime } from '../backend/types.ts';
import type { RuntimeMcpServer } from '../../capabilities/resolver.ts';
import type { AuthRequest } from '@nessy-agent/session-tools-core';

const PLUGIN_KEY = 'mk.tracker';
const SERVER_NAME = 'tracker-mcp';

function config(sessionId: string): BackendConfig {
  return {
    provider: 'pi',
    workspace: {
      id: 'workspace-b3',
      name: 'Workspace',
      rootPath: '/tmp/b3-workspace',
      workspaceRootPath: '/tmp/b3-workspace',
      sessionRootPath: '/tmp/b3-sessions',
    } as never,
    session: { id: sessionId, createdAt: 0, lastUsedAt: 0 } as never,
    isHeadless: true,
  };
}

/**
 * A minimal `RuntimeMcpServer` fixture standing in for a plugin server. Under
 * the stable-plugin-wire-names fix (task 2, 2026-08-10), a REAL plugin server
 * would carry a qualified `wireName` (`plugin_<pluginId>_<serverName>`, minted
 * by `capabilities/resolver.ts`'s collision policy) rather than the bare
 * `SERVER_NAME` used here. The MATCH is unaffected —
 * `resolvePluginMcpServerForAuth` (`pi-agent.ts`) keys on
 * `endpointAuth.pluginKey`/`endpointAuth.serverName` alone. But `wireName` is
 * still load-bearing for this file's assertions: the resolved
 * `displayName` falls back to `wireName` when `sourceName` is absent
 * (`pi-agent.ts:1130`), and the OAuth-success text asserted below interpolates
 * that display name. Keep `wireName === SERVER_NAME` here, or set `sourceName`,
 * or those assertions change with it.
 */
function pluginServer(authType: 'oauth' | 'bearer'): RuntimeMcpServer {
  return {
    key: `mcp://plugin/${PLUGIN_KEY}/${SERVER_NAME}`,
    wireName: SERVER_NAME,
    logicalName: SERVER_NAME,
    definition: { type: 'http', url: 'https://tracker.example/mcp' } as never,
    endpointAuth: { authType, pluginKey: PLUGIN_KEY, serverName: SERVER_NAME },
  };
}

/** A plain remote server with no declared endpoint auth — no plugin slot. */
function plainServer(): RuntimeMcpServer {
  return {
    key: 'mcp://source/notes',
    wireName: 'notes',
    logicalName: 'notes',
    sourceName: 'notes',
    definition: { type: 'http', url: 'https://notes.example/mcp' } as never,
  };
}

function runtime(mcpServers: RuntimeMcpServer[]): CapabilityTurnRuntime {
  return {
    view: {
      generation: 'generation-b3',
      sources: [], skills: [], mcpServers, hooks: [], automations: [], agents: [],
      promptLayers: [], memory: [], permissionLayers: [], commands: [], promptCommands: [], apps: [],
    },
    materializer: {
      assertActive() {},
      async verifyPlugin() {},
      async resolvePath() { return '/tmp/b3-resource'; },
      async readText() { return ''; },
      resolveCredential() { throw new Error('not used by this contract'); },
    },
  } as CapabilityTurnRuntime;
}

/** Run the tool the way the Pi subprocess does: prefixed name through the router. */
async function trigger(input: {
  sessionId: string;
  servers: RuntimeMcpServer[];
  args: Record<string, unknown>;
}): Promise<{ text: string; isError: boolean; authRequests: AuthRequest[] }> {
  const agent = new PiAgent(config(input.sessionId));
  const authRequests: AuthRequest[] = [];
  agent.onAuthRequest = (request) => { authRequests.push(request as AuthRequest); };
  try {
    agent.setCapabilityTurnRuntime(runtime(input.servers));
    const result = await (agent as unknown as {
      routeToolCall(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<{ content: string; isError?: boolean }>;
    }).routeToolCall(
      'mcp__session__source_oauth_trigger',
      input.args,
      new AbortController().signal,
    );
    return { text: result.content, isError: result.isError === true, authRequests };
  } finally {
    agent.destroy();
  }
}

describe('source_oauth_trigger — plugin MCP server target', () => {
  it('opens the flow for an enabled plugin server declaring OAuth', async () => {
    const { text, isError, authRequests } = await trigger({
      sessionId: 'session-b3-open',
      servers: [plainServer(), pluginServer('oauth')],
      args: { pluginKey: PLUGIN_KEY, serverName: SERVER_NAME },
    });

    expect(isError).toBe(false);
    expect(text).toContain(`OAuth authentication requested for '${SERVER_NAME}'`);
    // The refusal this row exists to remove must not be reachable any more.
    expect(text).not.toContain('not available in this session runtime');
    expect(authRequests).toHaveLength(1);
    expect(authRequests[0]).toMatchObject({
      type: 'oauth',
      pluginServer: { pluginKey: PLUGIN_KEY, serverName: SERVER_NAME },
    });
  });

  it('refuses a server that is not in this turn\'s enabled set', async () => {
    const { text, isError, authRequests } = await trigger({
      sessionId: 'session-b3-absent',
      servers: [plainServer()],
      args: { pluginKey: PLUGIN_KEY, serverName: SERVER_NAME },
    });

    expect(isError).toBe(true);
    expect(text).toContain('not found or not enabled');
    expect(authRequests).toHaveLength(0);
  });

  it('carries the declared auth type instead of assuming OAuth', async () => {
    const { text, isError, authRequests } = await trigger({
      sessionId: 'session-b3-bearer',
      servers: [pluginServer('bearer')],
      args: { pluginKey: PLUGIN_KEY, serverName: SERVER_NAME },
    });

    expect(isError).toBe(true);
    expect(text).toContain('is not configured for OAuth authentication');
    expect(authRequests).toHaveLength(0);
  });
});
