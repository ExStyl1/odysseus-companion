/**
 * Cross-phase core-adapter lifecycle contract (A7 / W1).
 *
 * Runs ONE normalized external-format fixture through the full unified
 * lifecycle other phases will reuse unchanged:
 *
 *   immutable install -> scoped policy activation -> resolver lease
 *   -> installed capability activation -> invalidation
 *
 * The fixture format is a PARAMETER (`FIXTURE_DIR` below), not a hardcoded
 * branch: nothing in this file or in the production code it exercises reads
 * `adapterId`/`origin`/`format` to decide behavior. Swapping the fixture for
 * a Claude/native one later should not require touching this file's
 * assertions, only its fixture path and identity constants.
 */
import { afterEach, beforeEach, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createCapabilityResolver,
  type CapabilityContext,
  type CapabilityResolutionInputs,
} from '../../capabilities/resolver.ts';
import { CapabilityPolicyStore } from '../../capabilities/policy-store.ts';
import { CapabilityTrustStore } from '../../capabilities/trust-store.ts';
import { PluginManagementServiceV2 } from '../management-service-v2.ts';
import { PluginStoreV2 } from '../store-v2.ts';
import { resolvePluginProjectionCandidates } from '../projection-candidates.ts';
import type { PluginInstalledEntryV2 } from '../store-v2.ts';

// The single parameter naming which normalized external-format fixture this
// run of the contract exercises. A7 runs it against the existing Codex core
// fixture reused from A1/A4; a later phase can point this at a different
// adapter's fixture without changing anything below.
const FIXTURE_DIR = join(import.meta.dir, 'fixtures', 'format-adapters', 'codex-core');
const PROJECT_KEY = `p_${'a'.repeat(32)}` as const;

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'core-adapter-lifecycle-'));
});

afterEach(async () => { await installs.settle(); // F1.424 — never remove a root under an install still copying into it
  rmSync(dir, { recursive: true, force: true });
});

describe('core adapter lifecycle contract', () => {
  it('runs a normalized fixture through immutable install -> scoped policy -> resolver lease -> activation -> invalidation with no provider-named runtime branches', async () => {
    const store = new PluginStoreV2({ rootDirectory: join(dir, 'plugins') });
    const policy = new CapabilityPolicyStore({
      globalPath: join(dir, 'capabilities.json'),
      workspacePolicyPath: workspaceId => join(dir, 'workspaces', workspaceId, 'capabilities.json'),
    });
    const trustStore = new CapabilityTrustStore({ path: join(dir, 'capability-trust.json') });
    const service = installs.track(new PluginManagementServiceV2({
      store,
      policyStore: policy,
      trustStore,
      fetchImpl: (async () => { throw new Error('network forbidden'); }) as unknown as typeof fetch,
      baseTempDir: join(dir, 'staging'),
    }));

    // --- 1. Immutable install: one content-addressed cache tree, no
    // enabled/activation state written onto the registry entry itself. ---
    const installed = await service.install({ kind: 'local-path', path: FIXTURE_DIR });
    expect(installed.ok).toBe(true);
    const pluginKey = installed.installed!.pluginKey;
    const instanceId = installed.installed!.activeInstanceId;
    expect(installed.compatibility?.state).toBe('supported');

    const registryEntry = (await store.readInstalledRegistry()).plugins.find(
      p => p.pluginInstanceId === instanceId,
    )!;
    // The registry stays activation-free: no enabled/lifecycle flag on the entry.
    expect(JSON.stringify(registryEntry)).not.toMatch(/enabledScopes|lifecycleState/);
    // Never a workspace/project bundle copy: the immutable cache path is the
    // ONLY on-disk location for this instance's bundle.
    const bundleRoot = store.cachePathFor(registryEntry.cacheRef);
    expect(bundleRoot).toContain(join('plugins', 'cache'));

    // --- 2. Scoped policy: enable the SAME immutable instance independently
    // at global, workspace and project scope without copying anything. ---
    policy.recordGlobal({ pluginKey, enabled: true });
    policy.recordWorkspace('ws_a', { pluginKey, enabled: true });
    policy.recordProjectOverride('ws_b', PROJECT_KEY, { pluginKey, enabled: false });

    expect(policy.resolve({ pluginKey }).enabled).toBe(true);
    expect(policy.resolve({ pluginKey }, { workspaceId: 'ws_a' }).enabled).toBe(true);
    // The project override is independent — it does not affect ws_a, and it
    // does not touch the cache/bundle in any way.
    expect(policy.resolve({ pluginKey }, { workspaceId: 'ws_b', projectKey: PROJECT_KEY }).enabled).toBe(false);
    expect(policy.resolve({ pluginKey }, { workspaceId: 'ws_a' }).enabled).toBe(true); // unaffected by ws_b's project override

    // --- 3. Resolver lease: a session captures a leased snapshot generation/
    // instance identity, never the plugin payload. Installed capabilities need
    // no second trust grant. ---
    function candidatesFor(entries: PluginInstalledEntryV2[], workspaceId: string) {
      return resolvePluginProjectionCandidates(entries, { kind: 'workspace', workspaceId });
    }

    function buildInputs(workspaceId: string): CapabilityResolutionInputs {
      return {
        nativeInventory: { records: [], blockedLayers: [] },
        installedPlugins: [registryEntry],
        activePluginInstances: { [pluginKey]: instanceId },
        acquirePluginInstanceLease: id => store.acquireInstanceLease(id),
        pluginCandidates: candidatesFor([registryEntry], workspaceId),
        resolveActivation: target => policy.resolve(
          { pluginKey: target.pluginKey, pluginInstanceId: target.pluginInstanceId },
          { workspaceId },
        ),
        resolveTrust: key => trustStore.resolve(key),
      };
    }

    let invalidated: Array<{ scope: unknown; reason: string; effect: string; revokedLeaseIds: string[] }> = [];
    const resolver = createCapabilityResolver({
      inputs: (context: CapabilityContext) => buildInputs(context.workspaceId),
      onInvalidate: event => { invalidated.push(event); },
    });

    const contextA: CapabilityContext = {
      workspaceId: 'ws_a',
      projectTrustState: 'none',
      projectTrustRevision: '',
    };
    const snapshotA = await resolver.resolve(contextA);
    // A session captures a leased snapshot generation/instance identity —
    // metadata and content-hash REFS only, never the materialized plugin
    // payload (actual bundled file bytes/content).
    expect(typeof snapshotA.generation).toBe('string');
    expect(snapshotA.generation.length).toBeGreaterThan(0);
    expect(typeof snapshotA.leaseId).toBe('string');
    expect(JSON.stringify(snapshotA)).not.toMatch(/Hello Skill|minimal authored skill body/);
    expect(resolver.isLeaseActive(snapshotA.leaseId)).toBe(true);
    expect(resolver.referencedInstances().has(instanceId)).toBe(true);

    const installedCapability = snapshotA.entries.find(e => e.summary.origin === 'plugin')!;
    expect(installedCapability.summary.trustState).toBe('not-required');
    expect(installedCapability.summary.enabled).toBe(true);

    // --- 5. Invalidation: a scope mutation invalidates only the affected
    // runtime view; another scope (ws_b) is unaffected. ---
    resolver.releaseSnapshot(snapshotA.leaseId);
    expect(resolver.isLeaseActive(snapshotA.leaseId)).toBe(false);

    const contextB: CapabilityContext = {
      workspaceId: 'ws_b',
      projectTrustState: 'none',
      projectTrustRevision: '',
    };
    const snapshotAAgain = await resolver.resolve(contextA);
    const snapshotB = await resolver.resolve(contextB);

    resolver.invalidate({ kind: 'workspace', workspaceId: 'ws_a' }, 'policy changed', 'revoke-active-snapshot');
    expect(resolver.isLeaseActive(snapshotAAgain.leaseId)).toBe(false);
    // The other scope's lease is untouched by ws_a's invalidation.
    expect(resolver.isLeaseActive(snapshotB.leaseId)).toBe(true);
    expect(invalidated).toEqual([{
      scope: { kind: 'workspace', workspaceId: 'ws_a' },
      reason: 'policy changed',
      effect: 'revoke-active-snapshot',
      revokedLeaseIds: [snapshotAAgain.leaseId],
    }]);

    resolver.releaseSnapshot(snapshotAAgain.leaseId);
    resolver.releaseSnapshot(snapshotB.leaseId);
    expect(resolver.leaseCount()).toBe(0);
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
