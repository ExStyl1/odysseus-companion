/**
 * R59 — the headless `system/init` projection (`buildHeadlessInitView`).
 *
 * `headless.md:211`, whole line:
 *
 * > `plugin_errors` | array | plugin load-time errors, each with `plugin`,
 * > `type`, and `message`. Includes unsatisfied dependency versions and
 * > `--plugin-dir` load failures such as a missing path or invalid archive.
 * > Affected plugins are demoted and absent from `plugins`. The key is omitted
 * > when there are no errors
 *
 * `headless.md:220`, whole line:
 *
 * > `mcp_server_errors` | array | `--mcp-config` entries skipped by config
 * > validation, each with `name`, `type`, and `message`. `type` is a skip
 * > category such as `unknown_type`, `url_missing_type`, `invalid_config`, or
 * > `reserved_name`; treat values you don't recognize as a generic skip.
 * > Affected servers are absent from `mcp_servers`. The key is omitted when
 * > there are no errors, so a CI gate can fail on a non-empty array. Requires
 * > Claude Code v2.1.219 or later
 *
 * Both arrays fail SILENTLY in the direction that defeats the gate, which is
 * what these cases exist to pin:
 *
 * - Over-reporting: `plugin.user_config.unredacted_sink` is a warning about
 *   WHERE a value was substituted, not a refusal, so mapping it in would fail
 *   CI on a plugin that loaded correctly.
 * - Double-reporting: `plugin.dependency.*` is the same set as
 *   `dependencyErrors`, so a mapping by line range rather than by code emits
 *   every dependency failure twice.
 * - Under-reporting: an MCP server a plugin declared and the format adapter
 *   refused is retained as an inert catalog row, so a fix that builds only the
 *   native-Source producer reports Source skips and leaves that one invisible.
 *
 * The sensitive canary below is a fixture string, never a real credential.
 */

import { describe, expect, it } from 'bun:test';
import {
  createCapabilityResolver,
  type CapabilityContext,
  type CapabilityResolutionInputs,
  type EffectiveCapabilitySnapshot,
  type InstalledPluginInput,
} from '../resolver.ts';
import { buildHeadlessInitView, type HeadlessInitMcpHealth } from '../views.ts';
import type { PluginProjectionCandidate } from '../../plugins/projection-candidates.ts';
import type { PluginUserConfigurationDescriptor } from '../../plugins/types.ts';

const CONTEXT: CapabilityContext = {
  workspaceId: 'ws-1',
  sessionId: 'sess-1',
  projectTrustState: 'trusted',
  projectTrustRevision: 'trust-r1',
};

const INSTANCE = 'plugin://m/p@1.0.0#' + 'b'.repeat(64);
const ROOT_PATH = '/bundles/m/p/1.0.0';
/** A fixture value, not a credential. */
const TOKEN = 'SENSITIVE_TOKEN_CANARY';
const ENDPOINT = 'https://internal.example.invalid';

const FIELDS: PluginUserConfigurationDescriptor[] = [
  { key: 'API_TOKEN', valueType: 'string', required: true, sensitive: true },
  { key: 'API_ENDPOINT', valueType: 'string', required: true },
];

function optionEnvironment(over: Record<string, string | undefined> = {}): Record<string, string> {
  const base: Record<string, string | undefined> = {
    CLAUDE_PLUGIN_OPTION_API_TOKEN: TOKEN,
    CLAUDE_PLUGIN_OPTION_API_ENDPOINT: ENDPOINT,
    ...over,
  };
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) if (value !== undefined) out[key] = value;
  return out;
}

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

const CANDIDATE_BASE = {
  pluginKey: 'pk-1' as const,
  pluginInstanceId: INSTANCE,
  selectedScope: { kind: 'global' as const },
  trust: { required: false },
};

/** A remote MCP server whose secret rides `headers` — the redacted sink. */
function httpMcpCandidate(requiredEnvironmentNames?: string[]): PluginProjectionCandidate {
  return {
    ...CANDIDATE_BASE,
    userConfiguration: FIELDS,
    key: 'plug:mcp:internal',
    capabilityId: 'c-mcp',
    kind: 'mcp',
    logicalName: 'internal',
    runtimeDefinition: {
      id: 'c-mcp',
      kind: 'mcp',
      mcp: {
        serverName: 'internal',
        transport: 'http',
        url: '${user_config.API_ENDPOINT}/mcp',
        headers: { Authorization: 'Bearer ${user_config.API_TOKEN}' },
        ...(requiredEnvironmentNames ? { requiredEnvironmentNames } : {}),
      },
    },
  };
}

/** The same server with the secret in `args` — substituted, NOT refused. */
function stdioMcpCandidateWithUnredactedSink(): PluginProjectionCandidate {
  return {
    ...CANDIDATE_BASE,
    userConfiguration: FIELDS,
    key: 'plug:mcp:local',
    capabilityId: 'c-mcp-local',
    kind: 'mcp',
    logicalName: 'local',
    runtimeDefinition: {
      id: 'c-mcp-local',
      kind: 'mcp',
      mcp: {
        serverName: 'local',
        transport: 'stdio',
        command: 'local-server',
        args: ['--token', '${user_config.API_TOKEN}'],
      },
    },
  };
}

/** An MCP declaration the format adapter refused; retained as an inert row. */
function refusedMcpCandidate(): PluginProjectionCandidate {
  return {
    ...CANDIDATE_BASE,
    key: 'plug:unsupported:broken',
    capabilityId: 'c-broken',
    kind: 'unsupported-runtime',
    componentKind: 'mcp',
    logicalName: 'broken-server',
    displayName: 'broken-server',
    runtimeDefinition: {
      id: 'c-broken',
      kind: 'unsupported',
      displayName: 'broken-server',
      unsupported: {
        externalKind: 'mcp',
        reasonCode: 'plugin.deferred.claude_mcp_command_unavailable',
        executable: true,
      },
    },
  };
}

function makeInputs(over: Partial<CapabilityResolutionInputs> = {}): CapabilityResolutionInputs {
  return {
    nativeInventory: { records: [], blockedLayers: [] },
    installedPlugins: [installedPlugin()],
    activePluginInstances: { 'pk-1': INSTANCE },
    pluginCandidates: [httpMcpCandidate()],
    resolveActivation: () => ({ enabled: true, suppressed: false, capabilities: {} }),
    resolveTrust: () => 'trusted',
    pluginOptionEnvironmentFor: () => optionEnvironment(),
    pluginRuntimeContextFor: () => ({
      rootPath: ROOT_PATH,
      dataPath: '/data/m/p',
      profile: 'generic-plugin-env-v1',
    }),
    ...over,
  };
}

async function withSnapshot<T>(
  inputs: CapabilityResolutionInputs,
  project: (snapshot: EffectiveCapabilitySnapshot) => T,
): Promise<T> {
  const resolver = createCapabilityResolver({ inputs: () => inputs });
  const snapshot = await resolver.resolve(CONTEXT);
  try {
    return project(snapshot);
  } finally {
    resolver.releaseSnapshot(snapshot.leaseId);
  }
}

function headlessInit(
  inputs: CapabilityResolutionInputs,
  mcpHealth?: HeadlessInitMcpHealth,
): Promise<ReturnType<typeof buildHeadlessInitView>> {
  return withSnapshot(inputs, snapshot => buildHeadlessInitView(snapshot, mcpHealth));
}

describe('a plugin that loaded correctly produces NO errors', () => {
  it('lists the plugin with its bundle path and omits BOTH error keys entirely', async () => {
    const view = await headlessInit(makeInputs());

    expect(view.plugins).toEqual([{ name: 'Plugin P', path: ROOT_PATH }]);
    // A plugin MCP server NEVER owns the bare name (`mcp.md:365`), contested
    // or not — the reported name is the stable plugin-qualified wire name.
    expect(view.mcp_servers).toEqual([{ name: 'plugin_p_internal', status: 'pending' }]);
    // The omission is the contract: a CI gate reads presence, not length, so an
    // empty array here would fail the pipeline on a healthy run.
    expect('plugin_errors' in view).toBe(false);
    expect('mcp_server_errors' in view).toBe(false);
  });

  it('still omits plugin_errors when a secret lands in an UNREDACTED sink', async () => {
    // `plugin.user_config.unredacted_sink` fires here — the resolver's own
    // comment says "Substituted, not refused". The server starts, the plugin
    // loaded, and the run is healthy; mapping this diagnostic into
    // `plugin_errors` would fail CI on a correct plugin.
    const inputs = makeInputs({ pluginCandidates: [stdioMcpCandidateWithUnredactedSink()] });

    const codes = await withSnapshot(inputs, snapshot => snapshot.diagnostics.map(d => d.code));
    expect(codes).toContain('plugin.user_config.unredacted_sink');

    const view = await headlessInit(inputs);
    expect('plugin_errors' in view).toBe(false);
    expect(view.plugins).toEqual([{ name: 'Plugin P', path: ROOT_PATH }]);
    // A plugin MCP server NEVER owns the bare name (`mcp.md:365`), contested
    // or not — the reported name is the stable plugin-qualified wire name.
    expect(view.mcp_servers).toEqual([{ name: 'plugin_p_local', status: 'pending' }]);
    expect(JSON.stringify(view)).not.toContain(TOKEN);
  });
});

describe('a demoted plugin is reported once and disappears from plugins', () => {
  it('reports an unset user_config key and drops the plugin from the list', async () => {
    const view = await headlessInit(makeInputs({
      pluginOptionEnvironmentFor: () => optionEnvironment({ CLAUDE_PLUGIN_OPTION_API_TOKEN: undefined }),
    }));

    expect(view.plugin_errors).toEqual([{
      plugin: 'Plugin P',
      type: 'plugin.user_config.unset',
      message: 'Plugin configuration is not set: API_TOKEN.',
    }]);
    // `:211` — "Affected plugins are demoted and absent from `plugins`."
    expect(view.plugins).toEqual([]);
  });

  it('reports a missing required MCP environment variable', async () => {
    const view = await headlessInit(makeInputs({
      pluginCandidates: [httpMcpCandidate(['NEEDED_VAR'])],
    }));

    expect(view.plugin_errors?.map(entry => entry.type))
      .toEqual(['plugin.mcp.required_environment_missing']);
    expect(view.plugins).toEqual([]);
  });

  it('reports an unsatisfied dependency EXACTLY ONCE, not once per producer', async () => {
    // The plugin carries a dependency error on its installed record AND a
    // `plugin.dependency.dependency_unsatisfied` capability diagnostic. They are
    // the same failure; a mapping that took the whole diagnostic list would
    // report it twice and a `jq length` gate would read the wrong number.
    const inputs = makeInputs({
      installedPlugins: [installedPlugin({
        manifest: {
          schemaVersion: 1,
          kind: 'plugin',
          id: 'p',
          name: 'Plugin P',
          version: '1.0.0',
          capabilities: [],
          dependencies: [{ name: 'absent-plugin' }],
        },
      })],
    });

    const codes = await withSnapshot(inputs, snapshot => snapshot.diagnostics.map(d => d.code));
    expect(codes).toContain('plugin.dependency.dependency_unsatisfied');

    const view = await headlessInit(inputs);
    expect(view.plugin_errors).toHaveLength(1);
    expect(view.plugin_errors?.[0]).toMatchObject({
      plugin: 'Plugin P',
      type: 'dependency-unsatisfied',
    });
    expect(view.plugins).toEqual([]);
  });
});

describe('mcp_server_errors has TWO producers', () => {
  it('reports a plugin MCP server the format adapter refused, with its reason code', async () => {
    const view = await headlessInit(makeInputs({
      pluginCandidates: [httpMcpCandidate(), refusedMcpCandidate()],
    }));

    expect(view.mcp_server_errors).toEqual([{
      name: 'broken-server',
      type: 'plugin.deferred.claude_mcp_command_unavailable',
      message: 'MCP server "broken-server" declared by plugin Plugin P could not be imported and was skipped.',
    }]);
    // `:220` — "Affected servers are absent from `mcp_servers`." The surviving
    // server's name is the plugin-qualified wire name (`mcp.md:365`).
    expect(view.mcp_servers.map(server => server.name)).toEqual(['plugin_p_internal']);
    // A refused component is not a plugin LOAD error: the bundle imported, one
    // declaration inside it did not. It stays out of `plugin_errors`.
    expect('plugin_errors' in view).toBe(false);
  });

  it('reports a native Source skipped by config validation', async () => {
    const view = await headlessInit(makeInputs({
      nativeInventory: {
        records: [],
        blockedLayers: [],
        mcpConfigSkips: [{
          name: 'broken-source',
          type: 'unknown_type',
          message: 'Source "broken-source" declares no "type"; the source was skipped.',
        }],
      },
    }));

    expect(view.mcp_server_errors).toEqual([{
      name: 'broken-source',
      type: 'unknown_type',
      message: 'Source "broken-source" declares no "type"; the source was skipped.',
    }]);
  });

  it('reports both producers in one frame', async () => {
    const view = await headlessInit(makeInputs({
      pluginCandidates: [httpMcpCandidate(), refusedMcpCandidate()],
      nativeInventory: {
        records: [],
        blockedLayers: [],
        mcpConfigSkips: [{ name: '.mcp.json', type: 'invalid_config', message: 'not valid JSON' }],
      },
    }));

    expect(view.mcp_server_errors?.map(entry => entry.name).sort())
      .toEqual(['.mcp.json', 'broken-server']);
  });
});

describe('mcp_servers status', () => {
  it('reads live pool health when a runtime has already started', async () => {
    // Health is keyed by wire name, and a plugin MCP server's wire name is
    // ALWAYS the plugin-qualified form (`mcp.md:365`), never the bare
    // logical name — so the pool health fixture below names the qualified
    // form too.
    const view = await headlessInit(
      makeInputs(),
      { connected: ['plugin_p_internal'], failed: [] },
    );
    expect(view.mcp_servers).toEqual([{ name: 'plugin_p_internal', status: 'connected' }]);

    const failedView = await headlessInit(
      makeInputs(),
      { connected: [], failed: ['plugin_p_internal'] },
    );
    expect(failedView.mcp_servers).toEqual([{ name: 'plugin_p_internal', status: 'failed' }]);
  });
});
