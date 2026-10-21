/**
 * T9 of the plugin-install usability plan (2026-07-31, owner § 0b-3): stdio
 * plugin servers ride the capability path.
 *
 * The `connector-stdio-deferred` class was a parking lot with no exit: a stdio
 * connector server never materializes as a Source (by design — a Source config
 * cannot retain plugin bundle authority) and never started anywhere else.
 * The fix reroutes at NORMALIZATION, in the one funnel every manifest passes
 * through (`normalizeNessyPluginManifest`): a connector's stdio server becomes
 * a supervised `kind:'mcp'` capability — the exact path Claude-adapter stdio
 * entries already ride — and leaves the connector; an all-stdio connector is
 * dropped. Claude-adapter stdio behaviour stays byte-identical.
 */

import { afterEach, beforeEach, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CapabilityPolicyStore } from '../../capabilities/policy-store.ts';
import { CapabilityTrustStore } from '../../capabilities/trust-store.ts';
import { normalizeClaudePluginBundle } from '../format-adapters/claude.ts';
import { PluginManagementServiceV2 } from '../management-service-v2.ts';
import { normalizeNessyPluginManifest } from '../schema.ts';
import { PluginStoreV2 } from '../store-v2.ts';
import type { PluginOrigin } from '../types.ts';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'connector-stdio-reroute-'));
});

afterEach(async () => { await installs.settle(); // F1.424 — never remove a root under an install still copying into it
  rmSync(dir, { recursive: true, force: true });
});

const ORIGIN: PluginOrigin = {
  source: 'local-path',
  marketplaceId: 'test-marketplace',
  resolvedAt: 0,
};

function createService(): PluginManagementServiceV2 {
  return installs.track(new PluginManagementServiceV2({
    store: new PluginStoreV2({ rootDirectory: join(dir, 'plugins') }),
    policyStore: new CapabilityPolicyStore({
      globalPath: join(dir, 'capabilities.json'),
      workspacePolicyPath: workspaceId => join(dir, 'workspaces', workspaceId, 'capabilities.json'),
      workspaceIds: () => existsSync(join(dir, 'workspaces')) ? readdirSync(join(dir, 'workspaces')) : [],
    }),
    trustStore: new CapabilityTrustStore({ path: join(dir, 'capability-trust.json') }),
    fetchImpl: (async () => { throw new Error('network forbidden'); }) as unknown as typeof fetch,
    baseTempDir: join(dir, 'staging'),
    pluginDataDir: join(dir, 'plugins', 'data'),
  }));
}

describe('stdio connector servers ride the capability path (T9)', () => {
  it('reroutes a native manifest connector stdio server to a supervised mcp capability', () => {
    const result = normalizeNessyPluginManifest({
      schemaVersion: 1,
      kind: 'plugin',
      id: 'mixed-kit',
      name: 'Mixed Kit',
      version: '1.0.0',
      capabilities: [],
      connectors: [{
        id: 'suite',
        displayName: 'Suite',
        mcpServers: [
          { serverName: 'local-mcp', transport: 'stdio', command: 'node', args: ['server.js'] },
          { serverName: 'remote-mcp', transport: 'http', url: 'https://suite.example.test/mcp' },
        ],
        auth: { type: 'oauth', timing: 'ON_FIRST_USE' },
      }],
    }, { origin: ORIGIN });

    expect(result.ok).toBe(true);
    const capability = result.value?.capabilities.find(
      entry => entry.kind === 'mcp' && entry.mcp.serverName === 'local-mcp',
    );
    expect(capability).toBeDefined();
    expect(capability?.kind === 'mcp' ? capability.mcp : undefined).toEqual({
      serverName: 'local-mcp',
      transport: 'stdio',
      command: 'node',
      args: ['server.js'],
    });
    // C3: the remote server rides the capability path too — an auth-carrying
    // mcp capability — and a connector no app references does not survive
    // normalization at all.
    const remote = result.value?.capabilities.find(
      entry => entry.kind === 'mcp' && entry.mcp.serverName === 'remote-mcp',
    );
    expect(remote?.kind === 'mcp' ? remote.mcp : undefined).toEqual({
      serverName: 'remote-mcp',
      transport: 'http',
      url: 'https://suite.example.test/mcp',
      authType: 'oauth',
    });
    expect(result.value?.connectors ?? []).toEqual([]);
    expect(result.diagnostics.some(d => d.code === 'plugin.install.connector_stdio_rerouted')).toBe(true);
    expect(result.diagnostics.some(d => d.code === 'plugin.install.connector_remote_rerouted')).toBe(true);
  });

  it('drops an all-stdio connector after rerouting its servers', () => {
    const result = normalizeNessyPluginManifest({
      schemaVersion: 1,
      kind: 'plugin',
      id: 'local-kit',
      name: 'Local Kit',
      version: '1.0.0',
      capabilities: [],
      connectors: [{
        id: 'local',
        mcpServers: [{ serverName: 'local-mcp', transport: 'stdio', command: 'node', args: ['server.js'] }],
      }],
    }, { origin: ORIGIN });

    expect(result.ok).toBe(true);
    expect(result.value?.connectors).toBeUndefined();
    expect(result.value?.capabilities.some(
      entry => entry.kind === 'mcp' && entry.mcp.transport === 'stdio' && entry.mcp.serverName === 'local-mcp',
    )).toBe(true);
  });

  it('a Codex plugin with a zero-auth stdio connector server installs it as a runnable capability', async () => {
    const root = join(dir, 'codex-stdio');
    mkdirSync(join(root, '.codex-plugin'), { recursive: true });
    writeFileSync(join(root, '.codex-plugin', 'plugin.json'), JSON.stringify({
      name: 'codex-stdio-kit',
      version: '1.0.0',
      connectors: [{
        id: 'local',
        mcpServers: [{ serverName: 'local-mcp', transport: 'stdio', command: 'node', args: ['server.js'] }],
      }],
    }));

    const service = createService();
    const result = await service.install({ kind: 'local-path', path: root });

    expect(result.ok).toBe(true);
    expect(result.installed?.capabilityKinds).toContain('mcp');
    // No false "none were valid" drop warning, and no parked connector state.
    expect(result.diagnostics.some(d => d.code === 'plugin.format.codex_declarative_dropped')).toBe(false);
    expect(result.diagnostics.some(d => d.code === 'plugin.install.connector_stdio_rerouted')).toBe(true);
  });

  it('keeps Claude-adapter stdio entries byte-identical: capabilities, never connectors, never rerouted', async () => {
    const root = join(dir, 'claude-stdio');
    mkdirSync(join(root, '.claude-plugin'), { recursive: true });
    writeFileSync(join(root, '.claude-plugin', 'plugin.json'), JSON.stringify({
      name: 'claude-stdio-kit',
      version: '1.0.0',
    }));
    writeFileSync(join(root, '.mcp.json'), JSON.stringify({
      mcpServers: { local: { command: 'node', args: ['server.js'] } },
    }));

    const result = await normalizeClaudePluginBundle(root, ORIGIN);

    expect(result.ok).toBe(true);
    const capability = result.value?.capabilities.find(
      entry => entry.kind === 'mcp' && entry.mcp.serverName === 'local',
    );
    expect(capability?.kind === 'mcp' ? capability.mcp.transport : undefined).toBe('stdio');
    expect(capability?.kind === 'mcp' ? capability.mcp.command : undefined).toBe('node');
    expect(result.value?.connectors ?? []).toHaveLength(0);
    expect(result.diagnostics?.some(d => d.code === 'plugin.install.connector_stdio_rerouted')).toBe(false);
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
