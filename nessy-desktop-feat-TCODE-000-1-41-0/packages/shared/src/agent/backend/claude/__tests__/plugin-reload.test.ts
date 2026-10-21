/**
 * P6.412 — the SDK's own plugin reload, which this fork shipped and never
 * called.
 *
 * Measured at HEAD before this landed: `git grep -a '\.reloadPlugins('` over
 * `packages` + `apps` scored **0** call sites, against two doc-comment mentions
 * in `live-session.ts` itself — while the vendored SDK declares it at
 * `sdk.d.ts:2544`, "Reload plugins from disk and return the refreshed commands,
 * agents, plugins, and MCP server status."
 *
 * This drives {@link reloadClaudePlugins} against a stub `Query`, which is the
 * whole point of its structural single-method parameter: the contract is
 * provable without a live child.
 */

import { describe, expect, test } from 'bun:test';
import type { SDKControlReloadPluginsResponse } from '@anthropic-ai/claude-agent-sdk';
import { reloadClaudePlugins } from '../live-session.ts';

function refreshed(
  over: Partial<SDKControlReloadPluginsResponse> = {},
): SDKControlReloadPluginsResponse {
  return {
    commands: [],
    agents: [],
    plugins: [],
    mcpServers: [],
    error_count: 0,
    ...over,
  } as SDKControlReloadPluginsResponse;
}

describe('reloadClaudePlugins (P6.412)', () => {
  test('calls the runtime\'s own reload and reports the refreshed counts', async () => {
    let calls = 0;
    const outcome = await reloadClaudePlugins({
      reloadPlugins: async () => {
        calls += 1;
        return refreshed({
          plugins: [{ name: 'corp.toolkit', path: '/opt/plugins/corp' }],
          commands: [{ name: 'corp:deploy' }, { name: 'corp:rollback' }],
          agents: [{ name: 'corp-reviewer' }],
          error_count: 1,
        } as Partial<SDKControlReloadPluginsResponse>);
      },
    });
    // Native-first: the mechanism the runtime already has is CALLED, exactly
    // once, rather than a teardown being performed beside it.
    expect(calls).toBe(1);
    expect(outcome).toEqual({
      applied: true,
      plugins: 1,
      commands: 2,
      agents: 1,
      mcpServers: 0,
      // Reloaded but not cleanly — the SDK's own `error_count` is carried rather
      // than swallowed, so a caller can say so.
      errorCount: 1,
    });
  });

  test('a failed or absent reload degrades to the turn-boundary path, never to a throw', async () => {
    // A mutation is already committed by the time anybody reloads, so a reload
    // that throws must not become the mutation's error.
    const failed = await reloadClaudePlugins({
      reloadPlugins: async () => { throw new Error('control request timed out'); },
    });
    expect(failed).toEqual({ applied: false, reason: 'control request timed out' });
    // No live child: nothing holds stale paths, so nothing is reported reloaded.
    expect(await reloadClaudePlugins(null)).toEqual({ applied: false, reason: 'no live session' });
    expect(await reloadClaudePlugins(undefined)).toEqual({ applied: false, reason: 'no live session' });
  });
});
