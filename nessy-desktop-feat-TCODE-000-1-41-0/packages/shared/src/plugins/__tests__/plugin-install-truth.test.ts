/**
 * T2 of the plugin-install usability plan (2026-07-31): the install result
 * tells the whole truth.
 *
 * The measured defect (§ 0.1): `installUnlocked` returned `ok:true` with no
 * authRequests — the result assembly filtered awaiting-auth connector sources
 * to `timing: 'ON_INSTALL'` while both format adapters hardcode
 * `ON_FIRST_USE`, and the userConfig prompt fired only on the separate enable
 * RPC. The plugin looked cleanly installed while most of its servers were not
 * usable.
 *
 * This probe installs a fixture shaped like the measured
 * `nessy-default-extension` failure — dp-backed stdio servers, ON_FIRST_USE
 * OAuth connectors, an env-requiring server, required userConfig — through the
 * REAL `PluginManagementServiceV2.install` boundary with the same connector
 * lifecycle bridge `storage-runtime.ts` wires, into temp directories only.
 */

import { afterEach, beforeEach, describe, expect, it, spyOn, setDefaultTimeout } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CapabilityPolicyStore } from '../../capabilities/policy-store.ts';
import { CapabilityTrustStore } from '../../capabilities/trust-store.ts';
import { SourceCredentialManager } from '../../sources/credential-manager.ts';
import { summarizePluginInstallSetup } from '../auth-requirements.ts';
import { PluginManagementServiceV2 } from '../management-service-v2.ts';
import { PluginStoreV2 } from '../store-v2.ts';

let dir: string;
let workspaceRoot: string;
let hasValidSpy: { mockRestore: () => void } | null = null;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'plugin-install-truth-'));
  workspaceRoot = join(dir, 'workspaces', 'ws_a');
  mkdirSync(join(workspaceRoot, 'sources'), { recursive: true });
  // No credential store is touched: every source reports unauthenticated.
  hasValidSpy = spyOn(SourceCredentialManager.prototype, 'hasValidCredentials')
    .mockResolvedValue(false);
});

afterEach(async () => { await installs.settle(); // F1.424 — never remove a root under an install still copying into it
  hasValidSpy?.mockRestore();
  rmSync(dir, { recursive: true, force: true });
});

function createService(): PluginManagementServiceV2 {
  return installs.track(new PluginManagementServiceV2({
    store: new PluginStoreV2({ rootDirectory: join(dir, 'plugins') }),
    policyStore: new CapabilityPolicyStore({
      globalPath: join(dir, 'capabilities.json'),
      workspacePolicyPath: workspaceId => join(dir, 'workspaces', workspaceId, 'capabilities.json'),
    }),
    trustStore: new CapabilityTrustStore({ path: join(dir, 'capability-trust.json') }),
    fetchImpl: (async () => { throw new Error('network forbidden'); }) as unknown as typeof fetch,
    baseTempDir: join(dir, 'staging'),
    pluginDataDir: join(dir, 'plugins', 'data'),
  }));
}

/** dp ×2 + ON_FIRST_USE oauth ×2 + env-requiring ×1 + required userConfig ×1. */
function createDefaultExtensionShapedBundle(): string {
  const root = join(dir, 'source');
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'plugin.json'), JSON.stringify({
    schemaVersion: 1,
    kind: 'plugin',
    id: 'default-extension-shaped',
    name: 'Default Extension Shaped',
    version: '1.0.0',
    capabilities: [
      { kind: 'mcp', id: 'jira', mcp: { serverName: 'jira', transport: 'stdio', command: 'dp', args: ['ai', 'mcp', 'jira'] } },
      { kind: 'mcp', id: 'gitlab', mcp: { serverName: 'gitlab', transport: 'stdio', command: 'dp', args: ['ai', 'mcp', 'gitlab'] } },
      {
        kind: 'mcp',
        id: 'metrics',
        mcp: {
          serverName: 'metrics',
          transport: 'http',
          url: 'https://metrics.example.test/mcp',
          headers: { Authorization: 'Bearer ${METRICS_TOKEN}' },
          requiredEnvironmentNames: ['METRICS_TOKEN'],
        },
      },
    ],
    connectors: [{
      id: 'tracker',
      mcpServers: [
        { serverName: 'tracker-mail', transport: 'http', url: 'https://tracker.example.test/mail' },
        { serverName: 'tracker-docs', transport: 'http', url: 'https://tracker.example.test/docs' },
      ],
      auth: { type: 'oauth', timing: 'ON_FIRST_USE' },
    }],
    nessyExtensions: {
      userConfiguration: [
        { key: 'project_key', valueType: 'string', required: true },
      ],
    },
  }));
  return root;
}

describe('the install result tells the whole truth (T2)', () => {
  it('names every non-ready server with its reason on install-with-activation', async () => {
    const service = createService();
    const result = await service.install(
      { kind: 'local-path', path: createDefaultExtensionShapedBundle() },
      { activateIn: { kind: 'workspace', workspaceId: 'ws_a' } },
    );

    expect(result.ok).toBe(true);

    // C3: the tracker servers ride the capability path — no Source
    // materializes, so no source-backed authRequests rows exist. The § 0.1
    // truth flows through `authRequirements` below (and, at runtime, through
    // the pool's needs-auth `externalAuthRequirements` feed).
    expect(result.authRequests ?? []).toEqual([]);

    // The manifest-derived requirement set: dp aggregation (one sign-in
    // unblocks N), the oauth capability group, and the env-requiring server.
    const requirements = result.installed?.authRequirements ?? [];
    expect(requirements.find(entry => entry.kind === 'dp')).toEqual({
      kind: 'dp',
      capabilityIds: ['gitlab', 'jira'],
      serverNames: ['gitlab', 'jira'],
      sharedProvider: 'dp',
      timing: 'ON_FIRST_USE',
    });
    expect(requirements.find(entry => entry.kind === 'oauth')).toEqual({
      kind: 'oauth',
      timing: 'ON_FIRST_USE',
      // C3: the requirement names the auth-carrying capability twins.
      connectorIds: ['mcp.tracker.tracker-docs', 'mcp.tracker.tracker-mail'],
      serverNames: ['tracker-docs', 'tracker-mail'],
    });
    expect(requirements.find(entry => entry.kind === 'environment')).toEqual({
      kind: 'environment',
      capabilityIds: ['metrics'],
      serverNames: ['metrics'],
      requiredNames: ['METRICS_TOKEN'],
    });

    // The userConfig dialog fires ON INSTALL: the configuration status rides
    // the install result, not only the separate enable RPC.
    expect(result.installed?.configuration?.state).toBe('needs_configuration');
    expect(result.installed?.configuration?.fields.map(field => field.key)).toEqual(['project_key']);

    // The model-relayable summary derives from the SAME set (tool-path parity).
    const setup = summarizePluginInstallSetup({
      authRequirements: requirements,
      configuration: result.installed?.configuration,
    });
    expect(setup.ready).toBe(false);
    expect(setup.dp).toEqual({ count: 2, serverNames: ['gitlab', 'jira'] });
    expect(setup.connectOnFirstUse).toEqual({ serverNames: ['tracker-docs', 'tracker-mail'] });
    expect(setup.environment).toEqual({ serverNames: ['metrics'], requiredNames: ['METRICS_TOKEN'] });
    expect(setup.userConfig).toEqual({ missingKeys: ['project_key'] });
    expect(setup.notes.some(note => note.includes('One Developer Platform sign-in unblocks 2'))).toBe(true);
  });

  it('reports nothing to do for a plugin with no auth or config needs', async () => {
    const root = join(dir, 'source-plain');
    mkdirSync(join(root, 'skills', 'review'), { recursive: true });
    writeFileSync(join(root, 'plugin.json'), JSON.stringify({
      schemaVersion: 1,
      kind: 'plugin',
      id: 'plain',
      name: 'Plain',
      version: '1.0.0',
      capabilities: [{ kind: 'skill', id: 'review', skill: { slug: 'review', path: 'skills/review/SKILL.md' } }],
    }));
    writeFileSync(join(root, 'skills', 'review', 'SKILL.md'), '# Review');

    const service = createService();
    const result = await service.install(
      { kind: 'local-path', path: root },
      { activateIn: { kind: 'workspace', workspaceId: 'ws_a' } },
    );

    expect(result.ok).toBe(true);
    expect(result.authRequests).toBeUndefined();
    expect(result.installed?.authRequirements).toBeUndefined();
    expect(result.installed?.configuration).toBeUndefined();
    const setup = summarizePluginInstallSetup({});
    expect(setup.ready).toBe(true);
    expect(setup.notes).toEqual(['All installed servers are ready to use.']);
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
