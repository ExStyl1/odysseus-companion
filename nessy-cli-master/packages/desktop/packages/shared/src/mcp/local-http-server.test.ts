import { afterEach, describe, expect, it } from 'bun:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  cleanupSessionScopedTools,
  getSessionScopedTools,
  mergeSessionScopedToolCallbacks,
  unregisterSessionScopedToolCallbacks,
} from '../agent/session-scoped-tools.ts';
import { LocalMcpHttpServer } from './local-http-server.ts';

const sessionId = 'local-http-server-test';

afterEach(() => {
  unregisterSessionScopedToolCallbacks(sessionId);
  cleanupSessionScopedTools(sessionId);
});

describe('LocalMcpHttpServer', () => {
  it('serves session desktop tools over Streamable HTTP', async () => {
    const actions: string[] = [];
    mergeSessionScopedToolCallbacks(sessionId, {
      desktopActionFn: async (action) => {
        actions.push(action.action);
      },
    });

    const server = new LocalMcpHttpServer(
      getSessionScopedTools(sessionId, process.cwd(), 'workspace-test'),
    );
    const client = new Client({
      name: 'local-http-server-test',
      version: '1.0.0',
    });

    try {
      const url = await server.start();
      await client.connect(new StreamableHTTPClientTransport(new URL(url)));

      const listed = await client.listTools();
      expect(listed.tools.some((tool) => tool.name === 'desktop_tool')).toBe(
        true,
      );

      const result = await client.callTool({
        name: 'desktop_tool',
        arguments: { action: 'show_workspace' },
      });
      expect(result.isError).not.toBe(true);
      expect(actions).toEqual(['show_workspace']);
    } finally {
      await client.close().catch(() => {});
      await server.stop();
    }
  });
});
