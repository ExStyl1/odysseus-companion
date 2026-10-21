/**
 * F1.410 (origin: the WJ-ff verifier on F1.265) — a mutation that threw AFTER committing
 * (`PluginMutationCommittedError`) still refreshes the live sessions, and when that refresh
 * fails the answer carries the host's per-session summary, exactly as a clean commit's does.
 *
 * `refreshAfterCommit` (the success paths) reads the F1.265 summary off the refresh error
 * (`refreshSessionsOf`) and puts it in the answer as `runtimeRefreshSessions`. The two
 * committed-error catches — the install one and the manage one — called `deps.afterMutation`
 * themselves and reported only `runtime invalidation failed: <first error>`, so a model told
 * "invalidation failed" could not tell which sessions did apply and which did not.
 *
 * CONTROL — an invalidation error that carries NO summary answers byte-identically to before.
 */
import { describe, expect, it } from 'bun:test';
import { MarketplaceProposalRegistry } from '../../marketplace/proposal-registry.ts';
import { PluginMutationCommittedError } from '../../plugins/management-types.ts';
import { createPluginManagementTools, type PluginManagementToolsDeps } from '../plugin-management-tools.ts';

/** What the host's `afterAgentPluginMutation` throws when a strict dispose failed (F1.265 + F1.407). */
function refreshFailure(): Error & { summary: unknown } {
  return Object.assign(new Error('codex-runtime-session-disposal-failed'), {
    summary: {
      applied: 1, deferred: 0, untouched: 2, reloaded: 0, failed: 1,
      failures: [{ sessionId: 'codex-idle', error: 'codex-runtime-session-disposal-failed' }],
    },
  });
}

function harness(invalidationError: Error) {
  const proposalRegistry = new MarketplaceProposalRegistry();
  const deps = {
    pluginManagement: {
      disable: async () => { throw new PluginMutationCommittedError('disable', 'local.toolkit', new Error('connector-cleanup-failed')); },
      uninstall: async () => { throw new PluginMutationCommittedError('uninstall', 'local.toolkit', new Error('managed-data-cleanup-failed')); },
    },
    marketplaceService: {
      install: async () => { throw new PluginMutationCommittedError('install', 'local.toolkit', new Error('connector-activation-failed')); },
    },
    proposalRegistry,
    clientId: 'session:ws_a:s1',
    resolveScope: () => ({ workspaceId: 'ws_a' }),
    afterMutation: async () => { throw invalidationError; },
  } as unknown as PluginManagementToolsDeps;
  const proposalId = proposalRegistry.issue({
    clientId: 'session:ws_a:s1',
    source: { kind: 'local-path', path: '/nonexistent/f1410-bundle' },
    displaySource: 'local',
    detectedFormat: 'nessy-plugin',
  } as never).proposalId;
  return { tools: createPluginManagementTools(deps), proposalId };
}

const text = (result: { content: Array<{ type: string; text?: string }> }) => result.content.map(part => part.text ?? '').join('');

const SESSIONS = '"runtimeRefreshSessions":{"applied":1,"reloaded":0,"deferred":0,"untouched":2,"failed":1,"failedSessionIds":["codex-idle"]}';

describe('F1.410 — a committed-error mutation whose refresh failed answers with the per-session summary', () => {
  it('plugin_install: the committed error, the refresh error, and the counts with the failed session named', async () => {
    const { tools, proposalId } = harness(refreshFailure());
    const result = await tools.install({ proposalId, scope: 'workspace' });
    expect(result.isError).toBe(true);
    expect(text(result)).toStartWith('[ERROR] plugin_install failed: connector-activation-failed; runtime invalidation failed: codex-runtime-session-disposal-failed')
    expect(text(result)).toContain(SESSIONS);
  });

  it('plugin_manage (disable and uninstall): the same summary on the manage catch', async () => {
    const { tools } = harness(refreshFailure());
    for (const action of ['disable', 'uninstall'] as const) {
      const result = await tools.manage({ pluginKey: 'local.toolkit', action, ...(action === 'disable' ? { scope: 'workspace' } : {}) });
      expect(result.isError).toBe(true);
      expect(text(result)).toContain(`plugin_manage:${action} failed: `);
      expect(text(result)).toContain('runtime invalidation failed: codex-runtime-session-disposal-failed');
      expect(text(result)).toContain(SESSIONS);
    }
  });
});

describe('F1.410 — CONTROL: no summary on the error, no change to the answer', () => {
  it('plugin_install and plugin_manage answer byte-identically to before', async () => {
    const { tools, proposalId } = harness(new Error('invalidation-exploded'));
    expect(text(await tools.install({ proposalId, scope: 'workspace' })))
      .toBe('[ERROR] plugin_install failed: connector-activation-failed; runtime invalidation failed: invalidation-exploded');
    expect(text(await tools.manage({ pluginKey: 'local.toolkit', action: 'uninstall' })))
      .toBe('[ERROR] plugin_manage:uninstall failed: managed-data-cleanup-failed; runtime invalidation failed: invalidation-exploded');
  });
});
