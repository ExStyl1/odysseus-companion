/**
 * A tool that declares it needs a human gets one.
 *
 * Documented contract (code.claude.com/docs/en/mcp, "Require approval for a
 * specific tool"): a server sets `_meta["anthropic/requiresUserInteraction"]` to
 * the JSON boolean `true` on ONE tool's `tools/list` entry, and the client shows
 * that tool's permission prompt on EVERY call — "even in `acceptEdits`, `auto`,
 * and `bypassPermissions` permission modes" — with no "don't ask again" option,
 * and allow rules do not skip the prompt either.
 *
 * The flag only ever narrows access, so it needs no change to the deny floor.
 */

import { afterAll, describe, expect, it } from 'bun:test';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { McpClientPool } from '../../mcp/mcp-pool.ts';
import type { PoolClient } from '../../mcp/client.ts';
import type { SdkMcpServerConfig } from '../backend/types.ts';
import { runPreToolUseChecks, type PermissionManagerLike, type PreToolUseInput } from '../core/pre-tool-use.ts';
import { cleanupModeState, initializeModeState } from '../mode-manager.ts';
import type { PermissionMode } from '../mode-types.ts';
import { registerFixtureClient } from '../../mcp/__tests__/pool-fixture.ts';

const INTERACTION_TOOL = 'mcp__srv__grant_access';
const PLAIN_TOOL = 'mcp__srv__read_thing';

class TestPool extends McpClientPool {
  register(slug: string, client: PoolClient, config?: SdkMcpServerConfig) {
    return registerFixtureClient(this, slug, client, config);
  }
}

const fakeClient = (tools: Tool[]): PoolClient => ({
  listTools: async () => tools,
  callTool: async () => ({ content: [] }),
  close: async () => {},
});

const tool = (name: string, extra: Partial<Tool> = {}): Tool =>
  ({ name, description: name, inputSchema: { type: 'object', properties: {} }, ...extra } as Tool);

const permissionManager: PermissionManagerLike = {
  isCommandWhitelisted: () => true, // "previously approved" must not skip the prompt
  isDangerousCommand: () => false,
  getBaseCommand: command => command.split(/\s+/)[0] || command,
  extractDomainFromNetworkCommand: () => null,
  isDomainWhitelisted: () => false,
};

const sessionKeys: Array<{ workspaceId: string; sessionId: string }> = [];

afterAll(() => {
  for (const key of sessionKeys) cleanupModeState(key);
});

function check(toolName: string, mode: PermissionMode, interactionRequiredToolNames: string[]) {
  const sessionKey = { workspaceId: 'ws-interaction', sessionId: `session-${mode}-${toolName}` };
  sessionKeys.push(sessionKey);
  cleanupModeState(sessionKey);
  initializeModeState(sessionKey, mode);
  const ctx: PreToolUseInput = {
    toolName,
    input: {},
    sessionId: sessionKey.sessionId,
    sessionKey,
    permissionMode: mode,
    workspaceRootPath: '/fixture/workspace',
    workspaceId: 'ws-interaction',
    activeSourceSlugs: ['srv'],
    allSourceSlugs: ['srv'],
    hasSourceActivation: false,
    permissionManager,
    interactionRequiredToolNames,
  };
  return runPreToolUseChecks(ctx);
}

describe('requiresUserInteraction forces a prompt', () => {
  it('always prompts for a tool that declares requiresUserInteraction', () => {
    // Even in allow-all: the point of the flag is that the server knows a human
    // must see this call. An always-allow mode must not silently satisfy it.
    for (const mode of ['default', 'acceptEdits', 'auto', 'bypassPermissions'] as const) {
      const result = check(INTERACTION_TOOL, mode, [INTERACTION_TOOL]);
      expect(result.type, mode).toBe('prompt');
      if (result.type === 'prompt') {
        // No "don't ask again" for a flagged tool.
        expect(result.rememberForMinutes, mode).toBeUndefined();
        expect(result.commandHash, mode).toBeUndefined();
      }
    }
  });

  it('leaves a tool without the flag on its normal path', () => {
    expect(check(PLAIN_TOOL, 'bypassPermissions', [INTERACTION_TOOL]).type).toBe('allow');
  });
});

describe('McpClientPool.interactionRequiredProxyToolNames', () => {
  it('reads the documented vendor-namespaced _meta key and only the JSON boolean true', async () => {
    const pool = new TestPool();
    await pool.register('srv', fakeClient([
      tool('grant_access', { _meta: { 'anthropic/requiresUserInteraction': true } }),
      tool('read_thing'),
      // "The value must be the JSON boolean `true`; any other value is ignored."
      tool('stringy', { _meta: { 'anthropic/requiresUserInteraction': 'true' } }),
      // A bare (non-namespaced) key is not part of any contract.
      tool('bare', { _meta: { requiresUserInteraction: true } }),
    ]), { type: 'http', url: 'https://mcp.example.test/mcp' });

    expect([...pool.interactionRequiredProxyToolNames()]).toEqual([INTERACTION_TOOL]);
  });
});
