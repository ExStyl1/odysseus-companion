/**
 * C5 — an LSP server keeps `env` and `workspaceFolder`, and the tuning fields we
 * do not apply stop vanishing without trace.
 *
 * `plugins-reference.md` § Environment variables gives the four LSP fields the
 * documented path placeholders resolve in — "| LSP servers | `command`, `args`,
 * `env`, `workspaceFolder` |" — and § LSP servers lists eleven optional fields.
 * The adapter read two of them (`args`, plus `extensionToLanguage` as the
 * language source).
 *
 * Measured on HEAD before this change, with a `.lsp.json` declaring all eleven:
 * `compatibility.state: 'supported'`, `deferred: []`, `diagnostics: []`, and a
 * capability carrying only `command`, `args` and `languages`. Nine declarations
 * disappeared with no machine-readable record and no message to the author.
 */
import { afterEach, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CapabilityPolicyStore } from '../../capabilities/policy-store.ts';
import { CapabilityTrustStore } from '../../capabilities/trust-store.ts';
import { normalizeClaudePluginBundle } from '../format-adapters/claude.ts';
import { PluginManagementServiceV2 } from '../management-service-v2.ts';
import { PluginStoreV2 } from '../store-v2.ts';
import type { PluginOrigin } from '../types.ts';

const ORIGIN: PluginOrigin = { source: 'local-path', resolvedAt: 0 };

const created: string[] = [];
afterEach(async () => { await installs.settle(); // F1.424 — never remove a root under an install still copying into it
  while (created.length) rmSync(created.pop()!, { recursive: true, force: true });
});

function bundleWithLsp(server: Record<string, unknown>): string {
  const root = mkdtempSync(join(tmpdir(), 'claude-lsp-fields-'));
  created.push(root);
  mkdirSync(join(root, '.claude-plugin'), { recursive: true });
  writeFileSync(
    join(root, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name: 'lsp-fields', version: '1.0.0' }),
  );
  writeFileSync(join(root, '.lsp.json'), JSON.stringify({ go: server }));
  return root;
}

const BASE_SERVER = {
  command: 'gopls',
  args: ['serve'],
  extensionToLanguage: { '.go': 'go' },
};

describe('Claude LSP server fields', () => {
  it('keeps env and workspaceFolder, with the documented tokens rewritten', async () => {
    const result = await normalizeClaudePluginBundle(bundleWithLsp({
      ...BASE_SERVER,
      env: { GOPATH: '${CLAUDE_PLUGIN_ROOT}/go' },
      workspaceFolder: '${CLAUDE_PROJECT_DIR}/svc',
    }), ORIGIN);

    expect(result.ok).toBe(true);
    expect(result.value?.capabilities.find(capability => capability.kind === 'lsp')).toMatchObject({
      lsp: {
        id: 'go',
        command: 'gopls',
        env: { GOPATH: '${NESSY_PLUGIN_ROOT}/go' },
        workspaceFolder: '${NESSY_PROJECT_DIR}/svc',
      },
    });
    // A server declaring only the four carried fields has nothing left to defer.
    expect(result.compatibility?.deferred).toEqual([]);
    expect(result.compatibility?.state).toBe('supported');
  });

  /**
   * P6.417 — the supervisor half. SEVEN of the eight are now CARRIED, and this
   * case was the one that recorded them as dropped.
   */
  it('carries the seven supervision knobs onto the capability', async () => {
    const result = await normalizeClaudePluginBundle(bundleWithLsp({
      ...BASE_SERVER,
      transport: 'stdio',
      initializationOptions: { build: { directoryFilters: ['-vendor'] } },
      settings: { gopls: { usePlaceholders: true } },
      startupTimeout: 30000,
      shutdownTimeout: 5000,
      restartOnCrash: false,
      maxRestarts: 3,
      diagnostics: false,
    }), ORIGIN);

    expect(result.ok).toBe(true);
    // Read the capability into a local FIRST, then assert (AGENTS.md: a shape
    // asserted with an asymmetric matcher is overwritten by the matcher).
    const capability = result.value?.capabilities.find(entry => entry.kind === 'lsp');
    expect(capability?.kind === 'lsp' && capability.lsp.supervision).toEqual({
      initializationOptions: { build: { directoryFilters: ['-vendor'] } },
      settings: { gopls: { usePlaceholders: true } },
      startupTimeout: 30000,
      shutdownTimeout: 5000,
      restartOnCrash: false,
      maxRestarts: 3,
      diagnostics: false,
    });
    // `transport` is the ONE still unread, and the notice now names only it —
    // the page says Claude Code "accepts `socket` but runs every server over
    // stdio", so accepting both values IS honouring the field and there is
    // nothing to carry.
    const notice = result.diagnostics?.find(entry => entry.code === 'plugin.format.claude_lsp_fields_unread');
    expect(notice?.message).toContain('declares transport, which Nessy does not apply');
    expect(result.compatibility?.deferred).toEqual([]);
    expect(result.compatibility?.state).toBe('supported');
  });

  it('accepts socket as well as stdio, and skips a server declaring a third transport', async () => {
    // The page's two values, and its own skip rule for anything else. Both
    // directions in one case because the pair is the claim: accepting `socket`
    // is what makes refusing the rest a judgement rather than a narrowing.
    const accepted = await normalizeClaudePluginBundle(
      bundleWithLsp({ ...BASE_SERVER, transport: 'socket' }), ORIGIN,
    );
    expect(accepted.value?.capabilities.filter(entry => entry.kind === 'lsp')).toHaveLength(1);

    const refused = await normalizeClaudePluginBundle(
      bundleWithLsp({ ...BASE_SERVER, transport: 'websocket' }), ORIGIN,
    );
    expect(refused.ok).toBe(true);
    expect(refused.value?.capabilities.filter(entry => entry.kind === 'lsp')).toEqual([]);
    expect(refused.diagnostics?.some(entry =>
      entry.code === 'plugin.format.claude_capability_incomplete'
      && entry.path === '.lsp.json.go.transport')).toBe(true);
  });

  it('refuses a malformed knob BY NAME and starts the server with the default', async () => {
    // NEGATIVE. Coercing would invent a policy the author did not write, and
    // ignoring would leave them believing a knob is honoured when it is not —
    // which is this row's own failure mode, one layer in.
    const result = await normalizeClaudePluginBundle(bundleWithLsp({
      ...BASE_SERVER,
      startupTimeout: 0,
      maxRestarts: -1,
      restartOnCrash: 'yes',
      settings: 'gopls',
    }), ORIGIN);

    expect(result.ok).toBe(true);
    const refusals = (result.diagnostics ?? [])
      .filter(entry => entry.code === 'plugin.format.claude_lsp_field_invalid')
      .map(entry => entry.path)
      .sort();
    expect(refusals).toEqual([
      '.lsp.json.go.maxRestarts',
      '.lsp.json.go.restartOnCrash',
      '.lsp.json.go.settings',
      '.lsp.json.go.startupTimeout',
    ]);
    // The server still starts, with none of the four applied.
    const capability = result.value?.capabilities.find(entry => entry.kind === 'lsp');
    expect(capability?.kind === 'lsp' && capability.lsp.supervision).toBeUndefined();
    // `maxRestarts: 0` is a REAL answer — "give up immediately" — and must not
    // be swept up by the same floor that refuses a zero timeout.
    const zero = await normalizeClaudePluginBundle(
      bundleWithLsp({ ...BASE_SERVER, maxRestarts: 0 }), ORIGIN,
    );
    const zeroCapability = zero.value?.capabilities.find(entry => entry.kind === 'lsp');
    expect(zeroCapability?.kind === 'lsp' && zeroCapability.lsp.supervision).toEqual({ maxRestarts: 0 });
  });

  it('skips a server whose workspaceFolder escapes, and starts the others', async () => {
    // `plugins-reference.md` § LSP servers: "Claude Code skips a server whose
    // configuration is invalid […] and the other configured servers still
    // start." So this is a per-server refusal, not a bundle-level one.
    const root = mkdtempSync(join(tmpdir(), 'claude-lsp-fields-'));
    created.push(root);
    mkdirSync(join(root, '.claude-plugin'), { recursive: true });
    writeFileSync(
      join(root, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'lsp-fields', version: '1.0.0' }),
    );
    writeFileSync(join(root, '.lsp.json'), JSON.stringify({
      go: { ...BASE_SERVER, workspaceFolder: '${CLAUDE_PROJECT_DIR}/../../etc' },
      ts: { command: 'typescript-language-server', extensionToLanguage: { '.ts': 'typescript' } },
    }));

    const result = await normalizeClaudePluginBundle(root, ORIGIN);

    expect(result.ok).toBe(true);
    expect(result.diagnostics?.some(entry =>
      entry.code === 'plugin.format.claude_capability_incomplete'
      && entry.path === '.lsp.json.go.workspaceFolder')).toBe(true);
    expect(result.value?.capabilities
      .filter(capability => capability.kind === 'lsp')
      .map(capability => capability.lsp.id)).toEqual(['ts']);
  });
});

/**
 * What a `deferred` row costs, driven through the service the RPC calls.
 *
 * `management-service-v2.ts:572` turns `compatibility.state === 'partial'` into
 * `requiresConfirmation` — on `repair`/`update`, not on first install, which
 * returns no such field (`:196`). The same branch calls
 * `policyStore.purgePlugin`, so the plugin is switched OFF, and
 * `PluginsPage.tsx:405` then renders the confirm-enable action. That is the
 * price of the channel: an update that silently disables a working language
 * server until the user confirms it again. It is worth paying when the user
 * loses a component, and not when a knob goes unread.
 */
describe('updating a Claude LSP plugin', () => {
  function service(): { service: PluginManagementServiceV2; root: string } {
    const root = mkdtempSync(join(tmpdir(), 'claude-lsp-install-'));
    created.push(root);
    return {
      root,
      service: installs.track(new PluginManagementServiceV2({
        store: new PluginStoreV2({ rootDirectory: join(root, 'plugins') }),
        policyStore: new CapabilityPolicyStore({
          globalPath: join(root, 'capabilities.json'),
          workspacePolicyPath: workspaceId => join(root, 'workspaces', workspaceId, 'capabilities.json'),
          workspaceIds: () => [],
        }),
        trustStore: new CapabilityTrustStore({ path: join(root, 'capability-trust.json') }),
        fetchImpl: (async () => { throw new Error('network forbidden'); }) as unknown as typeof fetch,
        baseTempDir: join(root, 'staging'),
      })),
    };
  }

  it('asks for no confirmation for a server declaring supervision knobs', async () => {
    const managed = service().service;
    const installed = await managed.install({
      kind: 'local-path',
      path: bundleWithLsp({ ...BASE_SERVER, startupTimeout: 120000, restartOnCrash: false }),
    });
    expect(installed.ok).toBe(true);
    // P6.417 — this asserted the unread-fields notice was carried through the
    // install. It is NOT here any more and that is the row landing: both knobs
    // this bundle declares are now honoured, so there is nothing unread to
    // record. `transport` is the only field that still produces the notice, and
    // the adapter suite above covers it.
    expect(installed.diagnostics?.map(entry => entry.code))
      .not.toContain('plugin.format.claude_lsp_fields_unread');

    const updated = await managed.update(installed.installed!.pluginKey);

    expect(updated.ok).toBe(true);
    // The two official-catalogue plugins that declare one of these fields —
    // `jdtls-lsp` and `kotlin-lsp`, both `startupTimeout` — were switched off by
    // their own update until this row.
    expect(updated.requiresConfirmation).toBeUndefined();
    expect(updated.compatibility?.state).toBe('supported');
  });

  it('still asks for confirmation when a declared server is dropped', async () => {
    // The positive control for the assertion above: the confirm step is intact,
    // it just no longer fires for a knob. Here the user really does lose the
    // `go` server that the bundle advertises.
    const root = mkdtempSync(join(tmpdir(), 'claude-lsp-fields-'));
    created.push(root);
    mkdirSync(join(root, '.claude-plugin'), { recursive: true });
    writeFileSync(
      join(root, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'lsp-fields', version: '1.0.0' }),
    );
    writeFileSync(join(root, '.lsp.json'), JSON.stringify({
      go: { ...BASE_SERVER, workspaceFolder: '${CLAUDE_PROJECT_DIR}/../../etc' },
      ts: { command: 'typescript-language-server', extensionToLanguage: { '.ts': 'typescript' } },
    }));

    const managed = service().service;
    const installed = await managed.install({ kind: 'local-path', path: root });
    expect(installed.ok).toBe(true);

    const updated = await managed.update(installed.installed!.pluginKey);

    expect(updated.ok).toBe(true);
    expect(updated.compatibility?.state).toBe('partial');
    expect(updated.requiresConfirmation).toBe(true);
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
