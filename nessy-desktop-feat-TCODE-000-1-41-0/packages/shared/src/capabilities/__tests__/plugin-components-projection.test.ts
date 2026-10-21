/**
 * U4 — plugin component inventory projection.
 *
 * `toUserCatalog` attaches a path-free `components` list to each installed
 * plugin, projected from the resolver snapshot entries that carry that plugin's
 * pluginKey. Proves: (1) present for a plugin with resolved components,
 * (2) path-free + carries the capability key for clickable kinds,
 * (3) ADDITIVE — a plugin with no resolved components omits the field.
 */

import { describe, expect, it } from 'bun:test';
import {
  createCapabilityResolver,
  type CapabilityContext,
  type CapabilityResolutionInputs,
  type InstalledPluginInput,
} from '../resolver.ts';
import { toAgentRuntime, toUserCatalog } from '../views.ts';
import {
  resolvePluginProjectionCandidates,
  type PluginProjectionCandidate,
} from '../../plugins/projection-candidates.ts';

const CONTEXT: CapabilityContext = {
  workspaceId: 'ws-1',
  sessionId: 'sess-1',
  projectKey: 'p_00000000000000000000000000000000',
  projectTrustState: 'trusted',
  projectTrustRevision: 'trust-r1',
};

const INSTANCE = 'plugin://m/p@1.0.0#' + 'b'.repeat(64);

function installedPlugin(over: Partial<InstalledPluginInput> = {}): InstalledPluginInput {
  return {
    pluginInstanceId: INSTANCE,
    pluginKey: 'pk-1',
    marketplaceId: 'm',
    pluginId: 'p',
    version: '1.0.0',
    bundleHash: 'b'.repeat(64),
    cacheRef: { marketplaceId: 'm', pluginId: 'p', version: '1.0.0', bundleHash: 'b'.repeat(64) },
    manifest: { schemaVersion: 1, kind: 'plugin', id: 'p', name: 'Plugin P', version: '1.0.0', capabilities: [] },
    origin: { source: 'marketplace', resolvedAt: 0 },
    installedAt: 1000,
    diagnostics: [],
    ...over,
  };
}

function pluginSkillCandidate(): PluginProjectionCandidate {
  return {
    pluginKey: 'pk-1',
    pluginInstanceId: INSTANCE,
    selectedScope: { kind: 'global' },
    trust: { required: false },
    key: 'plug:skill:alpha',
    capabilityId: 'c-skill',
    kind: 'skill',
    logicalName: 'alpha',
    displayName: 'Plugin Alpha',
    description: 'Plugin-projected alpha skill',
    resource: { pluginInstanceId: INSTANCE, relativePath: 'skills/alpha/SKILL.md', contentHash: 'c'.repeat(64) },
  };
}

function pluginHookCandidate(
  capabilityId: string,
  logicalName: string,
  description?: string,
): PluginProjectionCandidate {
  return {
    pluginKey: 'pk-1',
    pluginInstanceId: INSTANCE,
    selectedScope: { kind: 'global' },
    trust: { required: false },
    key: `plug:hook:${logicalName}`,
    capabilityId,
    kind: 'hook',
    logicalName,
    ...(description ? { description } : {}),
    resource: {
      pluginInstanceId: INSTANCE,
      relativePath: `hooks/${logicalName}.js`,
      contentHash: 'd'.repeat(64),
    },
    runtimeDefinition: {
      id: capabilityId,
      kind: 'hook',
      hook: {
        id: logicalName,
        event: 'PostToolUse',
        type: 'command',
        command: `node hooks/${logicalName}.js`,
      },
    },
  };
}

function makeInputs(over: Partial<CapabilityResolutionInputs> = {}): CapabilityResolutionInputs {
  return {
    nativeInventory: { records: [], blockedLayers: [] },
    installedPlugins: [installedPlugin()],
    activePluginInstances: { 'pk-1': INSTANCE },
    pluginCandidates: [pluginSkillCandidate()],
    resolveActivation: () => ({ enabled: true, suppressed: false, capabilities: {} }),
    resolveTrust: () => 'trusted',
    ...over,
  };
}

async function userCatalog(inputs: CapabilityResolutionInputs) {
  const resolver = createCapabilityResolver({ inputs: () => inputs });
  const snapshot = await resolver.resolve(CONTEXT);
  return toUserCatalog(snapshot);
}

describe('toUserCatalog — plugin component inventory (U4)', () => {
  it('projects the plugin components with kind/name/capabilityKey', async () => {
    const catalog = await userCatalog(makeInputs());
    const plugin = catalog.installedPlugins.find(p => p.pluginKey === 'pk-1');
    expect(plugin).toBeDefined();
    expect(plugin!.components).toBeDefined();
    const skill = plugin!.components!.find(c => c.kind === 'skill');
    expect(skill).toBeDefined();
    expect(skill!.name).toBe('Plugin Alpha');
    expect(skill!.description).toBe('Plugin-projected alpha skill');
    // A skill is clickable → carries the same opaque capability key catalogs use.
    expect(skill!.capabilityKey).toBe('plug:skill:alpha');
    // Toggle inputs (T3): manifest capability id + resolved enablement.
    expect(skill!.capabilityId).toBe('c-skill');
    expect(skill!.enabled).toBe(true);
    expect(skill!.unavailableReason).toBeUndefined();
  });

  it('projects immutable MCP authentication requirements without runtime descriptors', async () => {
    const catalog = await userCatalog(makeInputs({
      installedPlugins: [installedPlugin({
        manifest: {
          schemaVersion: 1, kind: 'plugin', id: 'p', name: 'Plugin P', version: '1.0.0',
          capabilities: [{
            id: 'gitlab', kind: 'mcp',
            mcp: { serverName: 'dpGitlab', transport: 'stdio', command: 'dp', args: ['ai', 'mcp', 'gitlab'] },
          }],
        },
      })],
    }));
    const plugin = catalog.installedPlugins[0]!;
    expect(plugin.authRequirements).toEqual([{
      kind: 'dp', capabilityIds: ['gitlab'], serverNames: ['dpGitlab'],
      sharedProvider: 'dp', timing: 'ON_FIRST_USE',
    }]);
    expect(JSON.stringify(plugin.authRequirements)).not.toContain('"command"');
  });

  it('projects a per-capability-disabled component with its reason', async () => {
    const catalog = await userCatalog(makeInputs({
      resolveActivation: () => ({ enabled: true, suppressed: false, capabilities: { 'c-skill': false } }),
    }));
    const skill = catalog.installedPlugins.find(p => p.pluginKey === 'pk-1')!.components!
      .find(c => c.kind === 'skill')!;
    expect(skill.enabled).toBe(false);
    expect(skill.unavailableReason).toBe('capability-disabled');
  });

  it('uses a path-free hook fallback while preserving a manifest description', async () => {
    const catalog = await userCatalog(makeInputs({
      pluginCandidates: [
        pluginHookCandidate('c-hook-fallback', 'fallback'),
        pluginHookCandidate('c-hook-described', 'described', 'Manifest hook description'),
      ],
    }));
    const hooks = catalog.installedPlugins[0]!.components!.filter(component => component.kind === 'hook');

    expect(hooks.find(hook => hook.name === 'fallback')!.description).toBe('PostToolUse · command');
    expect(hooks.find(hook => hook.name === 'described')!.description).toBe('Manifest hook description');
    expect(JSON.stringify(hooks)).not.toContain('hooks/');
  });

  it('shows a deferred MCP as disabled without exposing it to the agent or toggle actions', async () => {
    const plugin = installedPlugin({
      manifest: {
        schemaVersion: 1,
        kind: 'plugin',
        id: 'p',
        name: 'Plugin P',
        version: '1.0.0',
        capabilities: [{
          id: 'mcp.xcodebuildmcp',
          kind: 'unsupported',
          displayName: 'xcodebuildmcp',
          unsupported: {
            externalKind: 'mcp',
            reasonCode: 'plugin.deferred.codex_mcp_npx_unmaterialized',
            sourcePath: '.mcp.json.xcodebuildmcp',
            executable: true,
          },
        }],
      },
    });
    const inputs = makeInputs({
      installedPlugins: [plugin],
      pluginCandidates: resolvePluginProjectionCandidates([plugin], { kind: 'global' }),
    });
    const resolver = createCapabilityResolver({ inputs: () => inputs });
    const snapshot = await resolver.resolve(CONTEXT);
    const component = toUserCatalog(snapshot).installedPlugins[0]!.components![0]!;

    expect(component).toEqual({
      kind: 'mcp',
      name: 'xcodebuildmcp',
      enabled: false,
      unavailableReason: 'unsupported-runtime',
    });
    expect(toAgentRuntime(snapshot).mcpServers).toEqual([]);
    expect(JSON.stringify(component)).not.toContain('.mcp.json');
    resolver.releaseSnapshot(snapshot.leaseId);
  });

  it('is path-free: no absolute path or bundle hash reaches the payload', async () => {
    const catalog = await userCatalog(makeInputs());
    const json = JSON.stringify(catalog.installedPlugins);
    expect(json).not.toContain('/abs/');
    expect(json).not.toContain('SKILL.md');
    expect(json).not.toContain('skills/alpha');
    expect(json).not.toContain('c'.repeat(64)); // resource contentHash
  });

  it('is additive: a plugin with no resolved components omits the field', async () => {
    // Same installed plugin, but no candidate contributes any capability.
    const catalog = await userCatalog(makeInputs({ pluginCandidates: [] }));
    const plugin = catalog.installedPlugins.find(p => p.pluginKey === 'pk-1');
    expect(plugin).toBeDefined();
    expect(plugin!.components).toBeUndefined();
  });
});

describe('toUserCatalog — plugin activation direction (U4 menu-label defect)', () => {
  it('projects REAL per-scope activation so an enabled-in-workspace plugin shows "Disable"', async () => {
    // A plugin enabled at the workspace scope, unset globally, disabled in the
    // project. The safe view must carry these through verbatim so the row menu
    // offers "Disable in workspace" (not the always-"Enable" of the bug).
    const catalog = await userCatalog(makeInputs({
      resolvePluginScopeActivation: () => ({ global: 'unset', workspace: 'enabled', project: 'disabled' }),
    }));
    const plugin = catalog.installedPlugins.find(p => p.pluginKey === 'pk-1');
    expect(plugin).toBeDefined();
    expect(plugin!.activation.workspace).toBe('enabled');
    expect(plugin!.activation.global).toBe('unset');
    expect(plugin!.activation.project).toBe('disabled');
  });

  it('a managed force-enable is reported and takes Disable off the menu', async () => {
    // `settings-reference.md#enabledplugins` — "Plugins force-enabled by managed
    // settings can't be disabled this way, since managed settings override local
    // settings." The
    // resolver already overrides the user's disable, so a menu that still offered
    // the action would be a control that silently does nothing.
    const catalog = await userCatalog(makeInputs({
      resolvePluginScopeActivation: () => ({
        global: 'unset', workspace: 'disabled', project: 'ineligible', managed: 'enabled',
      }),
    }));
    const plugin = catalog.installedPlugins.find(p => p.pluginKey === 'pk-1')!;
    expect(plugin.activation.managed).toBe('enabled');
    expect(plugin.actions.canDisable).toBe(false);
    expect(plugin.actions.reasonCodes).toEqual(['managed-force-enabled']);
  });

  it('names an unorderable version pair as the reason Update is withheld (P2.159)', async () => {
    const catalog = await userCatalog(makeInputs({
      installedPlugins: [installedPlugin({ version: '0.10.2.3', updateVersionUncomparable: true })],
    }));
    const plugin = catalog.installedPlugins.find(p => p.pluginKey === 'pk-1')!;
    expect(plugin.actions.canUpdate).toBe(false);
    expect(plugin.actions.reasonCodes).toEqual(['update-version-uncomparable']);
  });

  it('says nothing for a plugin that is merely already current — the boundary', async () => {
    // `canUpdate` is false here too, and that is the ORDINARY state of almost
    // every installed plugin. Reporting a reason for it would make the note
    // meaningless; the point of the code above is that it never resolves.
    const catalog = await userCatalog(makeInputs({
      installedPlugins: [installedPlugin({ version: '0.10.0' })],
    }));
    const plugin = catalog.installedPlugins.find(p => p.pluginKey === 'pk-1')!;
    expect(plugin.actions.canUpdate).toBe(false);
    expect(plugin.actions.reasonCodes).toEqual([]);
  });

  it('a managed block leaves Disable available — only the force-enable is terminal upward', async () => {
    const catalog = await userCatalog(makeInputs({
      resolvePluginScopeActivation: () => ({
        global: 'unset', workspace: 'unset', project: 'ineligible', managed: 'disabled',
      }),
    }));
    const plugin = catalog.installedPlugins.find(p => p.pluginKey === 'pk-1')!;
    expect(plugin.activation.managed).toBe('disabled');
    expect(plugin.actions.canDisable).toBe(true);
    expect(plugin.actions.reasonCodes).toEqual([]);
  });

  it('falls back to "unset" for every scope when the reader is absent (no policy input)', async () => {
    // makeInputs() supplies no resolvePluginScopeActivation → the additive field
    // is omitted server-side and the safe view defaults each scope to 'unset'.
    const catalog = await userCatalog(makeInputs());
    const plugin = catalog.installedPlugins.find(p => p.pluginKey === 'pk-1');
    expect(plugin).toBeDefined();
    expect(plugin!.activation.workspace).toBe('unset');
    expect(plugin!.activation.global).toBe('unset');
    expect(plugin!.activation.project).toBeUndefined();
    expect(plugin!.activation.managed).toBeUndefined();
    expect(plugin!.actions.canDisable).toBe(true);
  });

  it.each([
    {
      name: 'enabled workspace policy',
      lifecycleState: 'ready' as const,
      scopes: { global: 'unset' as const, workspace: 'enabled' as const, project: 'ineligible' as const },
      activation: { enabled: true, suppressed: false },
      expected: 'active' as const,
    },
    {
      name: 'no activation policy',
      lifecycleState: 'ready' as const,
      scopes: { global: 'unset' as const, workspace: 'unset' as const, project: 'ineligible' as const },
      activation: { enabled: false, suppressed: false },
      expected: 'inactive' as const,
    },
    {
      name: 'suppressed workspace policy',
      lifecycleState: 'ready' as const,
      scopes: { global: 'unset' as const, workspace: 'disabled' as const, project: 'ineligible' as const },
      activation: { enabled: false, suppressed: true },
      expected: 'inactive' as const,
    },
    {
      name: 'non-ready lifecycle',
      lifecycleState: 'repair-required' as const,
      scopes: { global: 'unset' as const, workspace: 'enabled' as const, project: 'ineligible' as const },
      activation: { enabled: true, suppressed: false },
      expected: 'inactive' as const,
    },
  ])('projects effective activation from lifecycle and policy: $name', async ({ lifecycleState, scopes, activation, expected }) => {
    const catalog = await userCatalog(makeInputs({
      installedPlugins: [installedPlugin({ lifecycleState })],
      resolvePluginScopeActivation: () => scopes,
      resolveActivation: () => ({
        ...activation,
        capabilities: {},
      }),
    }));

    expect(catalog.installedPlugins.find(p => p.pluginKey === 'pk-1')!.activation.effective).toBe(expected);
  });
});
