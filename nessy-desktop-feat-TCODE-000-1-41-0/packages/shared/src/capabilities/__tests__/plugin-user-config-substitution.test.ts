/**
 * D14 — `${user_config.KEY}` reaches every site the contract names.
 *
 * `plugins/manifest-reference.md#environment-variables`, whole line:
 *
 * > Each value is available for substitution as `${user_config.KEY}` in MCP and
 * > LSP server configs and hook commands. Non-sensitive values can also be
 * > substituted in skill and agent content. All values are exported to hook
 * > processes as `CLAUDE_PLUGIN_OPTION_<KEY>` environment variables, where
 * > `<KEY>` is the option key uppercased.
 *
 * Before this, only the hook-process export existed, so an internal plugin's MCP
 * config shipped the literal string `${user_config.TOKEN}` to the server and
 * failed to authenticate at the first tool call.
 *
 * The sensitive canary below is a fixture string, never a real credential, and
 * every assertion about it is an ABSENCE assertion outside the two sites that
 * are allowed to carry it.
 */
import { describe, expect, it } from 'bun:test';
import {
  createCapabilityResolver,
  type CapabilityContext,
  type CapabilityResolutionInputs,
  type InstalledPluginInput,
} from '../resolver.ts';
import { toAgentRuntime, toComposerCatalog, toUserCatalog } from '../views.ts';
import { materializeRuntimeSkillContent } from '../runtime-skill-content.ts';
import type { CapabilitySnapshotMaterializer } from '../materializer.ts';
import type { PluginProjectionCandidate } from '../../plugins/projection-candidates.ts';
import type { PluginUserConfigurationDescriptor } from '../../plugins/types.ts';

const CONTEXT: CapabilityContext = {
  workspaceId: 'ws-1',
  sessionId: 'sess-1',
  projectTrustState: 'trusted',
  projectTrustRevision: 'trust-r1',
};

const INSTANCE = 'plugin://m/p@1.0.0#' + 'b'.repeat(64);
/** A fixture value, not a credential. Asserted ABSENT everywhere it may not go. */
const TOKEN = 'SENSITIVE_TOKEN_CANARY';
const ENDPOINT = 'https://internal.example.invalid';
/** Non-sensitive, and a path fragment: the shape an LSP `workspaceFolder` takes. */
const SERVICE_DIR = 'services/api';

const FIELDS: PluginUserConfigurationDescriptor[] = [
  { key: 'API_TOKEN', valueType: 'string', required: true, sensitive: true },
  { key: 'API_ENDPOINT', valueType: 'string', required: true },
  { key: 'SERVICE_DIR', valueType: 'string' },
];

function optionEnvironment(over: Record<string, string> = {}): Record<string, string> {
  return {
    CLAUDE_PLUGIN_OPTION_API_TOKEN: TOKEN,
    CLAUDE_PLUGIN_OPTION_API_ENDPOINT: ENDPOINT,
    CLAUDE_PLUGIN_OPTION_SERVICE_DIR: SERVICE_DIR,
    ...over,
  };
}

function installedPlugin(): InstalledPluginInput {
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
  };
}

function candidates(): PluginProjectionCandidate[] {
  const base = {
    pluginKey: 'pk-1' as const,
    pluginInstanceId: INSTANCE,
    selectedScope: { kind: 'global' as const },
    trust: { required: false },
    userConfiguration: FIELDS,
  };
  return [
    {
      ...base,
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
        },
      },
    },
    {
      ...base,
      key: 'plug:lsp:internal',
      capabilityId: 'c-lsp',
      kind: 'lsp',
      logicalName: 'internal-lsp',
      runtimeDefinition: {
        id: 'c-lsp',
        kind: 'lsp',
        lsp: {
          id: 'internal-lsp',
          command: 'internal-lsp',
          args: ['--token', '${user_config.API_TOKEN}', '--endpoint', '${user_config.API_ENDPOINT}'],
          languages: ['typescript'],
          env: { LSP_TOKEN: '${user_config.API_TOKEN}', LSP_ENDPOINT: '${user_config.API_ENDPOINT}' },
          workspaceFolder: '${NESSY_PROJECT_DIR}/${user_config.SERVICE_DIR}',
        },
      },
    },
    {
      ...base,
      key: 'plug:skill:alpha',
      capabilityId: 'c-skill',
      kind: 'skill',
      logicalName: 'alpha',
      resource: { pluginInstanceId: INSTANCE, relativePath: 'skills/alpha/SKILL.md', contentHash: 'c'.repeat(64) },
    },
  ];
}

function makeInputs(over: Partial<CapabilityResolutionInputs> = {}): CapabilityResolutionInputs {
  return {
    nativeInventory: { records: [], blockedLayers: [] },
    installedPlugins: [installedPlugin()],
    activePluginInstances: { 'pk-1': INSTANCE },
    pluginCandidates: candidates(),
    resolveActivation: () => ({ enabled: true, suppressed: false, capabilities: {} }),
    resolveTrust: () => 'trusted',
    pluginOptionEnvironmentFor: () => optionEnvironment(),
    ...over,
  };
}

describe('an MCP server config gets the configured value', () => {
  it('substitutes into the url and the headers, so the first tool call authenticates', async () => {
    const resolver = createCapabilityResolver({ inputs: () => makeInputs() });
    const snapshot = await resolver.resolve(CONTEXT);
    const server = toAgentRuntime(snapshot).mcpServers.find(entry => entry.key === 'plug:mcp:internal');

    expect(server?.definition).toMatchObject({ type: 'http', url: `${ENDPOINT}/mcp` });
    // `errors.md:1392` names `headers` as the field that "isn't shell-parsed",
    // so it is exactly where a token belongs.
    expect(server?.descriptorHeaders).toEqual({ Authorization: `Bearer ${TOKEN}` });
    expect(snapshot.entries.find(entry => entry.summary.key === 'plug:mcp:internal')?.summary.enabled).toBe(true);
    resolver.releaseSnapshot(snapshot.leaseId);
  });

  it('keeps the value out of every renderer view and out of the generation', async () => {
    const resolver = createCapabilityResolver({ inputs: () => makeInputs() });
    const snapshot = await resolver.resolve(CONTEXT);

    expect(JSON.stringify(toComposerCatalog(snapshot))).not.toContain(TOKEN);
    expect(JSON.stringify(toUserCatalog(snapshot))).not.toContain(TOKEN);
    expect(JSON.stringify(snapshot.entries.map(entry => entry.summary))).not.toContain(TOKEN);
    expect(snapshot.generation).not.toContain(TOKEN);
    resolver.releaseSnapshot(snapshot.leaseId);
  });

  it('moves the generation when a value is rotated', async () => {
    let environment = optionEnvironment();
    const resolver = createCapabilityResolver({
      inputs: () => makeInputs({ pluginOptionEnvironmentFor: () => environment }),
    });
    const before = await resolver.resolve(CONTEXT);
    resolver.releaseSnapshot(before.leaseId);

    environment = optionEnvironment({ CLAUDE_PLUGIN_OPTION_API_TOKEN: 'ROTATED_TOKEN_CANARY' });
    const after = await resolver.resolve(CONTEXT);
    expect(after.generation).not.toBe(before.generation);
    resolver.releaseSnapshot(after.leaseId);
  });
});

describe('an LSP server config gets the configured value', () => {
  it('substitutes into the launch args', async () => {
    const resolver = createCapabilityResolver({ inputs: () => makeInputs() });
    const snapshot = await resolver.resolve(CONTEXT);
    const lsp = toAgentRuntime(snapshot).lspServers?.find(entry => entry.key === 'plug:lsp:internal');

    expect(lsp?.args).toEqual(['--token', TOKEN, '--endpoint', ENDPOINT]);
    resolver.releaseSnapshot(snapshot.leaseId);
  });

  // C5. The same sentence covers the whole LSP config, and § Environment
  // variables names the four fields a placeholder resolves in — "| LSP servers |
  // `command`, `args`, `env`, `workspaceFolder` |". These two reached no runtime
  // at all until this row: the adapter parsed them and the registration the
  // session spawns from never carried them.
  it('substitutes into env and workspaceFolder, and both reach the registration the session spawns from', async () => {
    const resolver = createCapabilityResolver({ inputs: () => makeInputs() });
    const snapshot = await resolver.resolve(CONTEXT);
    const lsp = toAgentRuntime(snapshot).lspServers?.find(entry => entry.key === 'plug:lsp:internal');

    expect(lsp?.env).toEqual({ LSP_TOKEN: TOKEN, LSP_ENDPOINT: ENDPOINT });
    expect(lsp?.workspaceFolder).toBe(`\${NESSY_PROJECT_DIR}/${SERVICE_DIR}`);
    resolver.releaseSnapshot(snapshot.leaseId);
  });

  it('keeps a configured value carried in env out of the generation', async () => {
    let environment = optionEnvironment();
    const resolver = createCapabilityResolver({
      inputs: () => makeInputs({ pluginOptionEnvironmentFor: () => environment }),
    });
    const before = await resolver.resolve(CONTEXT);
    expect(before.generation).not.toContain(TOKEN);
    resolver.releaseSnapshot(before.leaseId);

    // …while still moving when the value behind it changes, which is what
    // re-provisions the language server (`createPiLspAuthoritySignature` hashes
    // the generation).
    environment = optionEnvironment({ CLAUDE_PLUGIN_OPTION_SERVICE_DIR: 'services/other' });
    const after = await resolver.resolve(CONTEXT);
    expect(after.generation).not.toBe(before.generation);
    resolver.releaseSnapshot(after.leaseId);
  });
});

describe('a skill body gets the NON-SENSITIVE value and never the secret', () => {
  const body = [
    'Call ${user_config.API_ENDPOINT}/health first.',
    'Authenticate with ${user_config.API_TOKEN}.',
  ].join('\n');

  function materializer(): CapabilitySnapshotMaterializer {
    return { readText: async () => body } as unknown as CapabilitySnapshotMaterializer;
  }

  it('substitutes the non-sensitive value and leaves the sensitive one literal', async () => {
    const resolver = createCapabilityResolver({ inputs: () => makeInputs() });
    const snapshot = await resolver.resolve(CONTEXT);
    const skill = toAgentRuntime(snapshot).skills.find(entry => entry.key === 'plug:skill:alpha')!;

    // `:577` — "Non-sensitive values can also be substituted in skill and agent
    // content." The handle carries the non-sensitive value only.
    expect(skill.pluginUserConfig).toEqual({ API_ENDPOINT: ENDPOINT, SERVICE_DIR });

    const content = await materializeRuntimeSkillContent(materializer(), skill);
    expect(content).toContain(`Call ${ENDPOINT}/health first.`);
    // The secret stays a placeholder. This is the containment: a skill body
    // reaches the model, the persisted invocation record and the transcript.
    expect(content).toContain('Authenticate with ${user_config.API_TOKEN}.');
    expect(content).not.toContain(TOKEN);
    resolver.releaseSnapshot(snapshot.leaseId);
  });
});

describe('an unset key does not silently authenticate as nobody', () => {
  it('refuses the MCP capability and names the field, never a value', async () => {
    const resolver = createCapabilityResolver({
      inputs: () => makeInputs({
        pluginOptionEnvironmentFor: () => ({ CLAUDE_PLUGIN_OPTION_API_ENDPOINT: ENDPOINT }),
      }),
    });
    const snapshot = await resolver.resolve(CONTEXT);
    const entry = snapshot.entries.find(candidate => candidate.summary.key === 'plug:mcp:internal')!;

    expect(entry.summary.enabled).toBe(false);
    expect(entry.summary.unavailableReason).toBe('user-config-missing');
    const diagnostic = entry.summary.diagnostics.find(row => row.code === 'plugin.user_config.unset');
    expect(diagnostic?.message).toContain('API_TOKEN');
    resolver.releaseSnapshot(snapshot.leaseId);
  });

  it('refuses the LSP capability on the same rule', async () => {
    const resolver = createCapabilityResolver({
      inputs: () => makeInputs({ pluginOptionEnvironmentFor: () => undefined }),
    });
    const snapshot = await resolver.resolve(CONTEXT);

    expect(snapshot.entries.find(entry => entry.summary.key === 'plug:lsp:internal')?.summary.unavailableReason)
      .toBe('user-config-missing');
    resolver.releaseSnapshot(snapshot.leaseId);
  });

  it('leaves a skill body placeholder literal rather than refusing the skill', async () => {
    // A skill body is instruction prose, so the literal degrades to a sentence
    // the model can read. The two sites where the same placeholder would become
    // a credential refuse instead — see the two cases above.
    const resolver = createCapabilityResolver({
      inputs: () => makeInputs({ pluginOptionEnvironmentFor: () => undefined }),
    });
    const snapshot = await resolver.resolve(CONTEXT);
    const skill = snapshot.entries.find(entry => entry.summary.key === 'plug:skill:alpha')!;

    expect(skill.summary.enabled).toBe(true);
    expect(skill.summary.unavailableReason).toBeUndefined();
    resolver.releaseSnapshot(snapshot.leaseId);
  });

  it('starts the server once the value is configured', async () => {
    let environment: Record<string, string> | undefined;
    const resolver = createCapabilityResolver({
      inputs: () => makeInputs({ pluginOptionEnvironmentFor: () => environment }),
    });
    const refused = await resolver.resolve(CONTEXT);
    expect(refused.entries.find(entry => entry.summary.key === 'plug:mcp:internal')?.summary.enabled).toBe(false);
    resolver.releaseSnapshot(refused.leaseId);

    environment = optionEnvironment();
    const ready = await resolver.resolve(CONTEXT);
    expect(ready.entries.find(entry => entry.summary.key === 'plug:mcp:internal')?.summary.enabled).toBe(true);
    resolver.releaseSnapshot(ready.leaseId);
  });
});

describe('a plugin that declares no options is untouched', () => {
  it('leaves the runtime definition identical', async () => {
    const resolver = createCapabilityResolver({
      inputs: () => makeInputs({
        pluginCandidates: candidates().map(candidate => {
          const { userConfiguration: _unused, ...rest } = candidate;
          return rest;
        }),
        pluginOptionEnvironmentFor: () => undefined,
      }),
    });
    const snapshot = await resolver.resolve(CONTEXT);
    const server = toAgentRuntime(snapshot).mcpServers.find(entry => entry.key === 'plug:mcp:internal');

    expect(server?.definition).toMatchObject({ url: '${user_config.API_ENDPOINT}/mcp' });
    expect(snapshot.entries.find(entry => entry.summary.key === 'plug:mcp:internal')?.summary.enabled).toBe(true);
    resolver.releaseSnapshot(snapshot.leaseId);
  });
});
