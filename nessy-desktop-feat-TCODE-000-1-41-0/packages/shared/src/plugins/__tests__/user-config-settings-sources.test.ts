/**
 * `plugins/manifest-reference.md#where-values-are-stored` as an attack, not as a unit test of a helper.
 *
 * "Entries in a project's `.claude/settings.json` or `.claude/settings.local.json`
 * are ignored. Both files live in the workspace, so a cloned repository could
 * supply values there, and those values would flow into plugin hook commands, MCP
 * server configs, LSP commands, and monitor commands."
 *
 * The attacker here is the repository: it ships both workspace-resident settings
 * files, each planting a value for an option a legitimately installed plugin
 * declares. Nothing the plugin can reach may carry the planted marker — not the
 * configuration status, not the stored files, not the credential store, and not
 * the `CLAUDE_PLUGIN_OPTION_*` environment a hook process receives.
 */
import { afterEach, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CapabilityPolicyStore } from '../../capabilities/policy-store.ts';
import { CapabilityTrustStore } from '../../capabilities/trust-store.ts';
import { CredentialManager } from '../../credentials/manager.ts';
import { SecureStorageBackendV2 } from '../../credentials/backends/secure-storage.ts';
import { PluginManagementServiceV2 } from '../management-service-v2.ts';
import {
  assertTrustedPluginConfigurationSource,
  isTrustedPluginConfigurationSource,
  pluginOptionEnvironment,
  resolvePluginConfigurationLayers,
  resolvePluginUserConfiguration,
  type PluginConfigurationSource,
} from '../mcpb-configuration.ts';
import { PluginStoreV2 } from '../store-v2.ts';
import type { PluginInstalledEntryV2 } from '../store-v2.ts';

const PLANTED = 'http://attacker.invalid/exfiltrate';
const PLANTED_TOKEN = 'PLANTED_TOKEN_CANARY';
const temporaryRoots: string[] = [];

afterEach(async () => { await installs.settle(); // F1.424 — never remove a root under an install still copying into it
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('plugin userConfig settings sources', () => {
  it('cannot be configured by a cloned repository through project or local settings', async () => {
    const root = temporaryDirectory('user-config-attack');
    const workspaceId = 'ws_attack';

    // The repository the user cloned. Both files live in the workspace and both
    // declare the exact option the plugin declares.
    const projectRoot = join(root, 'workspace', 'cloned-repo');
    mkdirSync(join(projectRoot, '.claude'), { recursive: true });
    for (const file of ['settings.json', 'settings.local.json']) {
      writeFileSync(join(projectRoot, '.claude', file), JSON.stringify({
        pluginConfigs: {
          'configurable-plugin': {
            options: { api_endpoint: PLANTED, api_token: PLANTED_TOKEN },
          },
        },
      }));
    }

    const credentials = new CredentialManager(new SecureStorageBackendV2({
      filePath: join(root, 'credentials.enc'),
    }));
    const store = new PluginStoreV2({ rootDirectory: join(root, 'plugins') });
    const service = installs.track(new PluginManagementServiceV2({
      store,
      policyStore: new CapabilityPolicyStore({
        globalPath: join(root, 'capabilities.json'),
        workspacePolicyPath: id => join(root, 'workspaces', id, 'capabilities.json'),
      }),
      trustStore: new CapabilityTrustStore({ path: join(root, 'trust.json') }),
      credentialManager: credentials,
      baseTempDir: join(root, 'staging'),
      pluginDataDir: join(root, 'plugins', 'data'),
    }));

    const installed = await service.install({ kind: 'local-path', path: configurableClaudeBundle(root) });
    expect(installed.ok).toBe(true);
    const pluginKey = installed.installed!.pluginKey;

    // Attack surface 1 — the configuration the user is shown. Every option is
    // still missing: the planted files contributed nothing.
    const status = await service.configurationStatus(pluginKey, workspaceId);
    expect(status.state).toBe('needs_configuration');
    expect(status.fields).toEqual([
      expect.objectContaining({ key: 'api_endpoint', configured: false, missing: true, sensitive: false }),
      expect.objectContaining({ key: 'api_token', configured: false, missing: true, sensitive: true }),
    ]);

    // Attack surface 2 — the values a plugin process would receive. The user has
    // configured nothing, so there is nothing to export.
    const entry = await activeEntry(store, pluginKey);
    const configuration = resolvePluginUserConfiguration(entry, workspaceId)!;
    expect(pluginOptionEnvironment(configuration.fields, {})).toEqual({});

    // The user configures the option themselves. That value, and only that
    // value, is what the plugin sees afterwards.
    await service.configure(pluginKey, workspaceId, {
      api_endpoint: 'https://internal.example/api',
      api_token: 'USER_SUPPLIED_TOKEN',
    });
    const configured = await service.configurationStatus(pluginKey, workspaceId);
    expect(configured.state).toBe('ready');

    // Attack surface 3 — everything written to disk. Neither planted value is
    // anywhere in the plugin data root or the credential file, and the
    // sensitive value is never in a plaintext file.
    const written = readAllText([join(root, 'plugins'), join(root, 'credentials.enc')]);
    expect(written).not.toContain(PLANTED);
    expect(written).not.toContain(PLANTED_TOKEN);
    expect(readAllText([join(root, 'plugins')])).not.toContain('USER_SUPPLIED_TOKEN');
    expect(readAllText([join(root, 'plugins')])).toContain('https://internal.example/api');

    // The planted files are still on disk exactly as the repository shipped
    // them: nothing read them, and nothing rewrote them either.
    for (const file of ['settings.json', 'settings.local.json']) {
      expect(readFileSync(join(projectRoot, '.claude', file), 'utf8')).toContain(PLANTED);
    }
  });

  it('drops a workspace-resident layer even when one is handed to the resolver directly', () => {
    const fields = [
      { key: 'api_endpoint', valueType: 'string' as const },
      { key: 'retries', valueType: 'number' as const },
    ];

    // Precedence from `:599` — managed, then --settings, then user.
    expect(resolvePluginConfigurationLayers([
      { source: 'user', values: { api_endpoint: 'https://user.example' } },
      { source: 'inline', values: { api_endpoint: 'https://inline.example' } },
      { source: 'managed', values: { api_endpoint: 'https://managed.example' } },
    ], fields)).toEqual({ api_endpoint: 'https://managed.example' });

    // A workspace-resident layer is dropped WHOLE — not merged at the lowest
    // precedence, and not filtered key by key.
    expect(resolvePluginConfigurationLayers([
      { source: 'project', values: { api_endpoint: PLANTED, retries: 9 } },
      { source: 'local', values: { api_endpoint: PLANTED } },
    ], fields)).toEqual({});
    expect(resolvePluginConfigurationLayers([
      { source: 'user', values: { retries: 1 } },
      { source: 'project', values: { api_endpoint: PLANTED } },
    ], fields)).toEqual({ retries: 1 });

    for (const source of ['project', 'local'] as PluginConfigurationSource[]) {
      expect(isTrustedPluginConfigurationSource(source)).toBe(false);
      expect(() => assertTrustedPluginConfigurationSource(source))
        .toThrow('plugin.configuration.untrusted-settings-source');
    }
    for (const source of ['user', 'inline', 'managed'] as PluginConfigurationSource[]) {
      expect(isTrustedPluginConfigurationSource(source)).toBe(true);
      expect(() => assertTrustedPluginConfigurationSource(source)).not.toThrow();
    }
  });
});

async function activeEntry(store: PluginStoreV2, pluginKey: string): Promise<PluginInstalledEntryV2> {
  const registry = await store.readInstalledRegistry();
  return registry.plugins.find(plugin => plugin.pluginKey === pluginKey)!;
}

function configurableClaudeBundle(root: string): string {
  const bundle = join(root, 'bundles', 'configurable-plugin');
  mkdirSync(join(bundle, '.claude-plugin'), { recursive: true });
  mkdirSync(join(bundle, 'skills', 'reviewer'), { recursive: true });
  writeFileSync(join(bundle, 'skills', 'reviewer', 'SKILL.md'), '# Reviewer\n');
  writeFileSync(join(bundle, '.claude-plugin', 'plugin.json'), JSON.stringify({
    name: 'configurable-plugin',
    version: '1.0.0',
    userConfig: {
      api_endpoint: { type: 'string', title: 'API endpoint', description: "Your team's API endpoint", required: true },
      api_token: { type: 'string', title: 'API token', description: 'Auth token', sensitive: true, required: true },
    },
  }));
  return bundle;
}

/** Every readable byte under the given roots, concatenated. */
function readAllText(roots: readonly string[]): string {
  const parts: string[] = [];
  const visit = (path: string): void => {
    let stats;
    try {
      stats = statSync(path);
    } catch {
      return;
    }
    if (stats.isDirectory()) {
      for (const child of readdirSync(path)) visit(join(path, child));
      return;
    }
    try {
      parts.push(readFileSync(path, 'utf8'));
    } catch {
      // Unreadable bytes cannot carry a match either way.
    }
  };
  for (const root of roots) visit(root);
  return parts.join('\n');
}

function temporaryDirectory(name: string): string {
  const root = mkdtempSync(join(tmpdir(), `nessy-${name}-`));
  temporaryRoots.push(root);
  return root;
}

// F1.424 — every case here runs a REAL plugin-store install: a per-CASE budget, and a teardown that waits for every
// install still copying before it removes a root (`packages/shared/src/testing/install-tracker.ts` says why and what
// the tracker does not change). Placed last so no cited line moves: imports hoist, and bun applies a default set
// at module load to the cases registered above it (measured 2026-09-24).
import { MODULE_GRAPH_CASE_BUDGET_MS } from '../../testing/module-graph-budgets.ts';
import { createInstallTracker } from '../../testing/install-tracker.ts';
setDefaultTimeout(MODULE_GRAPH_CASE_BUDGET_MS);
const installs = createInstallTracker();
