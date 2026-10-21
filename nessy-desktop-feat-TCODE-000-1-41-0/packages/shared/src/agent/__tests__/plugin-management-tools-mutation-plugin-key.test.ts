/**
 * F1.582 (origin WJ-be proposed row 5, 2026-09-24) — every committed mutation the AGENT makes through
 * `plugin_install` / `plugin_manage` hands `afterMutation` the plugin it acted on, so the host can put it in the
 * capability invalidation's reason and a turn that invalidation stops says WHICH plugin was removed.
 *
 * F1.493 (1) made a stopped turn say why ("This turn was stopped because a capability it was using was withdrawn:
 * <reason>"), and a user's RPC mutation already reads `plugin uninstall (<pluginKey>)`. The agent's own mutation
 * reached the host through this hook as `(reason, target, effect)` only, so the same note read
 * `plugin_manage:uninstall` with no plugin in it.
 *
 * The REASON stays the bare action on purpose: `SessionManager.afterAgentPluginMutation` derives the effect and the
 * scope from `reason.endsWith(':uninstall')` and friends, so the key rides beside it as its own argument.
 *
 * CONTROL — `prune` has no single subject (`plugins/cli-reference.md#plugin-prune` takes no plugin argument), so it
 * passes no key and its reason is unchanged.
 */
import { describe, expect, it } from 'bun:test';
import { MarketplaceProposalRegistry } from '../../marketplace/proposal-registry.ts';
import { PluginMutationCommittedError } from '../../plugins/management-types.ts';
import { createPluginManagementTools, type PluginManagementToolsDeps } from '../plugin-management-tools.ts';

interface HookCall { reason: string; pluginKey: unknown }

function harness(options: { committedErrors?: boolean } = {}) {
  const calls: HookCall[] = [];
  const proposalRegistry = new MarketplaceProposalRegistry();
  const committed = (action: 'install' | 'disable' | 'uninstall') =>
    new PluginMutationCommittedError(action, 'local.toolkit', new Error(`${action}-cleanup-failed`));
  const deps = {
    pluginManagement: {
      enable: async () => ({ pluginKey: 'local.toolkit' }),
      disable: async () => { if (options.committedErrors) throw committed('disable'); return { pluginKey: 'local.toolkit' }; },
      uninstall: async () => { if (options.committedErrors) throw committed('uninstall'); return {}; },
      repair: async () => ({ ok: true, installed: { pluginKey: 'local.toolkit' }, diagnostics: [] }),
      pruneDependencies: async () => ({ removed: [{ pluginKey: 'local.dep' }] }),
    },
    marketplaceService: {
      install: async () => {
        if (options.committedErrors) throw committed('install');
        return { ok: true, installed: { pluginKey: 'local.toolkit' }, diagnostics: [] };
      },
    },
    proposalRegistry,
    clientId: 'session:ws_a:s1',
    resolveScope: () => ({ workspaceId: 'ws_a' }),
    afterMutation: (reason: string, _target: unknown, _effect: unknown, ...rest: unknown[]) => {
      calls.push({ reason, pluginKey: rest[0] });
    },
  } as unknown as PluginManagementToolsDeps;
  const proposalId = () => proposalRegistry.issue({
    clientId: 'session:ws_a:s1',
    source: { kind: 'local-path', path: '/nonexistent/f1582-bundle' },
    displaySource: 'local',
    detectedFormat: 'nessy-plugin',
  } as never).proposalId;
  return { tools: createPluginManagementTools(deps), calls, proposalId };
}

describe('F1.582 — the agent\'s committed plugin mutation names its plugin to the host', () => {
  it('install, enable, disable, repair and uninstall each hand afterMutation the plugin key', async () => {
    const { tools, calls, proposalId } = harness();
    await tools.install({ proposalId: proposalId(), scope: 'workspace' });
    await tools.manage({ pluginKey: 'local.toolkit', action: 'enable', scope: 'workspace' });
    await tools.manage({ pluginKey: 'local.toolkit', action: 'disable', scope: 'workspace' });
    await tools.manage({ pluginKey: 'local.toolkit', action: 'repair' });
    await tools.manage({ pluginKey: 'local.toolkit', action: 'uninstall' });
    expect(calls).toEqual([
      { reason: 'plugin_install', pluginKey: 'local.toolkit' },
      { reason: 'plugin_manage:enable', pluginKey: 'local.toolkit' },
      { reason: 'plugin_manage:disable', pluginKey: 'local.toolkit' },
      { reason: 'plugin_manage:repair', pluginKey: 'local.toolkit' },
      { reason: 'plugin_manage:uninstall', pluginKey: 'local.toolkit' },
    ]);
  });

  it('a mutation that threw AFTER committing still names its plugin (the error carries it)', async () => {
    const { tools, calls, proposalId } = harness({ committedErrors: true });
    await tools.install({ proposalId: proposalId(), scope: 'workspace' });
    await tools.manage({ pluginKey: 'local.toolkit', action: 'disable', scope: 'workspace' });
    await tools.manage({ pluginKey: 'local.toolkit', action: 'uninstall' });
    expect(calls).toEqual([
      { reason: 'plugin_install', pluginKey: 'local.toolkit' },
      { reason: 'plugin_manage:disable', pluginKey: 'local.toolkit' },
      { reason: 'plugin_manage:uninstall', pluginKey: 'local.toolkit' },
    ]);
  });

  it('CONTROL — prune has no single subject: no key, and the reason is the bare action', async () => {
    const { tools, calls } = harness();
    await tools.manage({ action: 'prune' });
    expect(calls).toEqual([{ reason: 'plugin_manage:prune', pluginKey: undefined }]);
  });
});
