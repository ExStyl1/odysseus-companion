import { afterEach, beforeEach, describe, expect, test, setDefaultTimeout } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CapabilityPolicyStore } from '../../capabilities/policy-store.ts';
import { CapabilityTrustStore } from '../../capabilities/trust-store.ts';
import { SourceCredentialManager } from '../../sources/credential-manager.ts';
import { createSource, loadAllSources } from '../../sources/storage.ts';
import { PluginManagementServiceV2 } from '../management-service-v2.ts';
import { PluginStoreV2, type PluginInstalledEntryV2 } from '../store-v2.ts';

const FIXTURES = join(import.meta.dir, 'fixtures', 'auth-shapes');

// Fixture provenance:
// - Figma `.mcp.json`: https://github.com/openai/plugins/blob/main/plugins/figma/.mcp.json
//   (LicenseRef-Figma-Developer-Terms).
// - GitHub `.mcp.json` and Gmail `.app.json`: matching paths in openai/plugins
//   (MIT per their plugin manifests).
// - OpenAI Developers `.mcp.json`: matching path in openai/plugins (Proprietary).
// Only the minimum declarative JSON fields are retained; no authored prose is copied.

let root: string;
let store: PluginStoreV2;
let service: PluginManagementServiceV2;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'auth-shape-conformance-'));
  store = new PluginStoreV2({ rootDirectory: join(root, 'plugins') });
  service = installs.track(new PluginManagementServiceV2({
    store,
    policyStore: new CapabilityPolicyStore({
      globalPath: join(root, 'capabilities.json'),
      workspacePolicyPath: workspaceId => join(root, 'workspaces', workspaceId, 'capabilities.json'),
    }),
    trustStore: new CapabilityTrustStore({ path: join(root, 'capability-trust.json') }),
    fetchImpl: (async () => { throw new Error('network forbidden'); }) as unknown as typeof fetch,
    baseTempDir: join(root, 'staging'),
  }));
});

afterEach(async () => { await installs.settle(); // F1.424 — never remove a root under an install still copying into it
  rmSync(root, { recursive: true, force: true });
});

async function installCodexFixture(
  fixture: string,
  companion: '.mcp.json' | '.app.json',
): Promise<{ result: Awaited<ReturnType<PluginManagementServiceV2['install']>>; entry?: PluginInstalledEntryV2 }> {
  const id = fixture.replace(/\.json$/, '');
  const bundle = join(root, id);
  mkdirSync(join(bundle, '.codex-plugin'), { recursive: true });
  writeFileSync(join(bundle, '.codex-plugin', 'plugin.json'), JSON.stringify({
    name: id,
    version: '1.0.0',
    [companion === '.mcp.json' ? 'mcpServers' : 'apps']: `./${companion}`,
  }));
  writeFileSync(join(bundle, companion), readFileSync(join(FIXTURES, fixture), 'utf8'));
  if (fixture === 'openai-developers-stdio.json') {
    mkdirSync(join(bundle, 'mcp'));
    writeFileSync(join(bundle, 'mcp', 'server.mjs'), '');
  }

  const result = await service.install({ kind: 'local-path', path: bundle });
  if (!result.installed) return { result };
  const registry = await store.readInstalledRegistry();
  return {
    result,
    entry: registry.plugins.find(candidate => (
      candidate.pluginInstanceId === result.installed!.activeInstanceId
    )),
  };
}

describe('MCP authentication shape conformance', () => {
  test('qualifies frozen Codex OAuth, bearer-env, app-only, and local stdio shapes', async () => {
    const figma = await installCodexFixture('figma-oauth.json', '.mcp.json');
    expect(figma.result.ok).toBe(true);
    expect(figma.result.installed?.authRequirements).toEqual([{
      kind: 'oauth',
      // C3: the requirement names the auth-carrying capability twin.
      connectorIds: ['mcp.figma.figma'],
      serverNames: ['figma'],
      timing: 'ON_FIRST_USE',
    }]);
    expect(JSON.stringify(figma.result.installed)).not.toContain('https://mcp.figma.com/mcp');

    // C3: the installed manifest carries the auth-carrying capability twin and
    // nothing left for the Source projection.
    const figmaTwin = figma.entry!.manifest.capabilities.find(capability => capability.kind === 'mcp');
    expect(figmaTwin?.kind === 'mcp' ? figmaTwin.mcp.authType : undefined).toBe('oauth');
    expect(figma.entry!.manifest.connectors ?? []).toEqual([]);

    // Pre-C5 installs left connector-origin source DIRECTORIES on disk; the
    // surviving T5 keying still serves those rows for the migration chain.
    // Recreate that on-disk shape directly (the materializer is deleted).
    const workspaceRoot = join(root, 'workspace');
    mkdirSync(join(workspaceRoot, 'sources'), { recursive: true });
    await createSource(workspaceRoot, {
      name: 'figma',
      provider: 'connector:figma',
      type: 'mcp',
      mcp: {
        transport: 'http',
        url: 'https://mcp.figma.com/mcp',
        authType: 'oauth',
        oauthResource: 'https://mcp.figma.com/mcp',
      },
      enabled: true,
      icon: '🔌',
      connectorOrigin: {
        pluginKey: figma.entry!.pluginKey,
        connectorId: 'figma',
        serverName: 'figma',
        authTiming: 'ON_FIRST_USE',
      },
    });
    const figmaSource = loadAllSources(workspaceRoot)[0]!;
    expect(figmaSource.config.mcp).toEqual({
      transport: 'http',
      url: 'https://mcp.figma.com/mcp',
      authType: 'oauth',
      oauthResource: 'https://mcp.figma.com/mcp',
    });
    // T5 (owner § 0b-1): the connector credential keys GLOBALLY on the
    // connector's stable identity — one OAuth per server across workspaces.
    expect(new SourceCredentialManager().getCredentialId(figmaSource)).toEqual({
      type: 'source_oauth',
      workspaceId: '@connector-global',
      sourceId: `${figma.entry!.pluginKey}#figma#figma`,
    });
    expect(JSON.stringify(figmaSource.config)).not.toMatch(/accessToken|refreshToken|clientSecret|"value"/);

    const github = await installCodexFixture('github-bearer.json', '.mcp.json');
    expect(github.result.ok).toBe(true);
    expect(github.result.installed?.authRequirements).toEqual([{
      kind: 'environment',
      capabilityIds: ['mcp.github'],
      serverNames: ['github'],
      requiredNames: ['GITHUB_PAT_TOKEN'],
    }]);
    expect(github.result.installed?.authRequirements?.some(requirement => requirement.kind === 'oauth')).toBe(false);

    const gmail = await installCodexFixture('gmail-app-only.json', '.app.json');
    expect(gmail.result.ok).toBe(false);
    expect(gmail.result.diagnostics).toContainEqual(expect.objectContaining({
      severity: 'error',
      code: 'plugin.install.app_connector_metadata_missing',
    }));

    const openai = await installCodexFixture('openai-developers-stdio.json', '.mcp.json');
    expect(openai.result.ok).toBe(true);
    expect(openai.result.installed?.authRequirements).toBeUndefined();
    expect(openai.entry?.manifest.capabilities).toContainEqual(expect.objectContaining({
      kind: 'mcp',
      mcp: expect.objectContaining({
        serverName: 'openai-api-key-local-confirmation',
        transport: 'stdio',
        command: 'node',
      }),
    }));
  });

  test('qualifies legacy DP, generic OAuth, and no-auth servers by descriptors, not names', async () => {
    const bundle = join(root, 'legacy-auth');
    mkdirSync(bundle);
    writeFileSync(join(bundle, 'nessy-extension.json'), JSON.stringify({
      id: 'legacy-auth',
      name: 'Legacy auth',
      version: '1.0.0',
      mcpServers: {
        codeSearch: { command: 'dp', args: ['ai', 'mcp', 'search'] },
        dpNamedButLocal: { command: 'node', args: ['./local.mjs'] },
        gitlab: { httpUrl: 'https://gitlab.example.test/mcp', oauth: {} },
        time: { httpUrl: 'https://time.example.test/mcp' },
      },
    }));

    const installed = await service.install({ kind: 'local-path', path: bundle });
    expect(installed.ok).toBe(true);
    expect(installed.installed?.authRequirements).toEqual([
      {
        kind: 'dp',
        capabilityIds: ['codeSearch'],
        serverNames: ['codeSearch'],
        sharedProvider: 'dp',
        timing: 'ON_FIRST_USE',
      },
      {
        kind: 'oauth',
        // C3: the requirement names the auth-carrying capability twin.
        connectorIds: ['mcp.gitlab.gitlab'],
        serverNames: ['gitlab'],
        timing: 'ON_FIRST_USE',
      },
    ]);
    expect(JSON.stringify(installed.installed)).not.toContain('https://gitlab.example.test/mcp');
    expect(installed.installed?.authRequirements?.some(requirement => (
      'serverNames' in requirement && requirement.serverNames.includes('time')
    ))).toBe(false);
    expect(installed.installed?.authRequirements?.some(requirement => (
      'serverNames' in requirement && requirement.serverNames.includes('dpNamedButLocal')
    ))).toBe(false);
  });
});

// F1.424 — every case here runs a REAL plugin-store install: a per-CASE budget, and a teardown that waits for every
// install still copying before it removes a root (`packages/shared/src/testing/install-tracker.ts` says why and what
// the tracker does not change). Placed last so no cited line moves: imports hoist, and bun applies a default set
// at module load to the cases registered above it (measured 2026-09-24).
import { MODULE_GRAPH_CASE_BUDGET_MS } from '../../testing/module-graph-budgets.ts';
import { createInstallTracker } from '../../testing/install-tracker.ts';
setDefaultTimeout(MODULE_GRAPH_CASE_BUDGET_MS);
const installs = createInstallTracker();
