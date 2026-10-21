/**
 * T6 Step 1 — the t-tracker incident, end to end.
 *
 * Field incident 2026-08-10: installing a marketplace plugin that declared an
 * MCP server named like a built-in dp server (`t-tracker`) made every chat
 * turn throw `Pi execution manifest MCP wireName must resolve exactly once:
 * t-tracker`. The chain: the capability resolver's OLD collision policy
 * stripped the bare wire name from every contender in a contested bucket —
 * including the builtin — while the builtin fold still materialized the
 * builtin under its bare `definition.name` regardless, so the live MCP pool
 * served `mcp__t-tracker__*` while the Pi manifest seed only knew a qualified
 * name. Seed lookup missed on every turn, and the miss was a hard throw.
 *
 * `resolver.test.ts` ("field-incident repro: an enabled builtin keeps its
 * bare name...") already pins the fix at the RESOLVER level: both servers
 * resolve, with distinct wire names. This file is the one level further
 * `resolver.test.ts` does not cover — feeding that SAME real resolved view
 * through the REAL Pi manifest seed/finalize pipeline
 * (`createPiExecutionManifestSeed` + `finalizePiExecutionManifest`), so the
 * assertion is not just "the names differ" but "the whole Pi turn-build
 * pipeline accepts both servers and produces two working proxy tools" — the
 * actual, concrete shape of the incident being closed.
 *
 * The second test proves the OTHER half of the fix (T1/N2): even after N1
 * closes the specific t-tracker collision, a residual wireName mismatch
 * between a stale pool and a fresh manifest seed (the general shape of the
 * incident, not just this one instance of it) now degrades one tool instead
 * of killing the session.
 */
import { describe, expect, it } from 'bun:test';
import {
  createCapabilityResolver,
  type CapabilityContext,
  type CapabilityResolutionInputs,
  type InstalledPluginInput,
} from '../resolver.ts';
import { toAgentRuntime } from '../views.ts';
import type { PluginProjectionCandidate } from '../../plugins/projection-candidates.ts';
import type { NativeCapabilitySourceRecord } from '../types.ts';
import {
  createPiExecutionManifestSeed,
  finalizePiExecutionManifest,
  type PiDynamicToolDefinition,
} from '../../agent/pi-harness/harness-manifest.ts';

// Same fixture shapes as `resolver.test.ts` (CONTEXT/nativeRecord/pluginCandidate/
// installedPlugin/makeInputs) — proven-valid there; duplicated here rather than
// imported because the source file exports no test-fixture helpers.
const CONTEXT: CapabilityContext = {
  workspaceId: 'ws-1',
  sessionId: 'sess-1',
  projectKey: 'p_00000000000000000000000000000000',
  projectTrustState: 'trusted',
  projectTrustRevision: 'trust-r1',
};

const SESSION_KEY = { workspaceId: CONTEXT.workspaceId, sessionId: CONTEXT.sessionId! };

function nativeRecord(over: Partial<NativeCapabilitySourceRecord> & Pick<NativeCapabilitySourceRecord, 'key' | 'kind' | 'logicalName'>): NativeCapabilitySourceRecord {
  return {
    scope: { kind: 'workspace', workspaceId: 'ws-1' },
    sourcePath: `/abs/managed/${over.key}`,
    revision: 'r1',
    contentHash: 'a'.repeat(64),
    mutable: true,
    ...over,
  };
}

function pluginCandidate(over: Partial<PluginProjectionCandidate> & Pick<PluginProjectionCandidate, 'key' | 'capabilityId' | 'kind' | 'logicalName'>): PluginProjectionCandidate {
  return {
    pluginKey: 'pk-1',
    pluginInstanceId: 'plugin://m/p@1.0.0#' + 'b'.repeat(64),
    selectedScope: { kind: 'global' },
    trust: { required: false },
    ...over,
  };
}

function installedPlugin(): InstalledPluginInput {
  return {
    pluginInstanceId: 'plugin://m/p@1.0.0#' + 'b'.repeat(64),
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

function makeInputs(over: Partial<CapabilityResolutionInputs> = {}): CapabilityResolutionInputs {
  const instanceId = 'plugin://m/p@1.0.0#' + 'b'.repeat(64);
  return {
    nativeInventory: {
      records: [
        nativeRecord({ key: 'skill:ws:alpha', kind: 'skill', logicalName: 'alpha' }),
        nativeRecord({ key: 'mcp:ws:fs', kind: 'mcp', logicalName: 'fs' }),
      ],
      blockedLayers: [],
    },
    installedPlugins: [installedPlugin()],
    activePluginInstances: { 'pk-1': instanceId },
    pluginCandidates: [],
    resolveActivation: () => ({ enabled: true, suppressed: false, capabilities: {} }),
    resolveTrust: () => 'trusted',
    ...over,
  };
}

/**
 * Builtin `t-tracker` (enabled — `storage-runtime.ts:630` projects every
 * built-in dp server as a capability record regardless of its own enabled
 * state; there is no `builtinDpMcpServers.enabled` flag surfaced at THIS
 * layer to flip — `sourceEnabled: false` on the record is the resolver-level
 * equivalent the "field-incident repro" and "T4" describe blocks in
 * `resolver.test.ts` both use for "disabled") plus an installed plugin
 * declaring its OWN MCP server also named `t-tracker`. HTTP transport,
 * deliberately: T4's builtin-identity dedup only force-disables a plugin
 * whose DECLARED stdio argv tail is `dp ai mcp <sub>`, and this fixture's
 * builtin record carries no `mcpServerIdentity` at all (nothing to match
 * against either way) — so both entries stay enabled and the assertions below
 * measure N1's naming behavior, not T4's activation dedup (which has its own
 * dedicated describe block).
 */
function tTrackerCollisionInputs(): CapabilityResolutionInputs {
  const inputs = makeInputs({
    pluginCandidates: [pluginCandidate({
      key: 'plug:mcp:t-tracker',
      capabilityId: 't-tracker',
      kind: 'mcp',
      logicalName: 't-tracker',
      runtimeDefinition: {
        kind: 'mcp',
        id: 't-tracker',
        mcp: { serverName: 't-tracker', transport: 'http', url: 'https://mcp.test/plugin-t-tracker' },
      },
    })],
  });
  inputs.nativeInventory.records.push(
    nativeRecord({ key: 'mcp:builtin:t-tracker', kind: 'mcp', logicalName: 't-tracker', scope: { kind: 'builtin' } }),
  );
  return inputs;
}

function dynamicListTool(bindingName: string, capabilityKey: string, generation: string): PiDynamicToolDefinition {
  return {
    bindingName,
    description: 'List tracked items',
    inputSchema: { type: 'object', properties: {} },
    modelSchemaVersion: 1,
    bindingSchemaVersion: 1,
    provenance: { capabilityKey, generation },
  };
}

describe('plugin/builtin MCP collision — the t-tracker incident, end to end', () => {
  it('an enabled builtin and a colliding plugin both resolve, and both mint into the Pi manifest under distinct binding names', async () => {
    const inputs = tTrackerCollisionInputs();
    const resolver = createCapabilityResolver({ inputs: () => inputs });
    const snapshot = await resolver.resolve(CONTEXT);
    try {
      const view = toAgentRuntime(snapshot);

      // 1. The resolved view carries BOTH servers, with the wire names N1's
      // naming mint promises: the builtin keeps its bare name; the plugin is
      // always plugin-qualified, contested or not.
      const builtinServer = view.mcpServers.find(server => server.key === 'mcp:builtin:t-tracker');
      const pluginServer = view.mcpServers.find(server => server.key === 'plug:mcp:t-tracker');
      expect(builtinServer?.wireName).toBe('t-tracker');
      expect(pluginServer?.wireName).toBe('plugin_p_t-tracker');

      const builtinEntry = snapshot.entries.find(entry => entry.summary.key === 'mcp:builtin:t-tracker')!;
      const pluginEntry = snapshot.entries.find(entry => entry.summary.key === 'plug:mcp:t-tracker')!;
      expect(builtinEntry.summary.enabled).toBe(true);
      expect(pluginEntry.summary.enabled).toBe(true);

      // 2. Feed the SAME resolved view through the real Pi manifest seed
      // builder. Before the fix this is exactly where the field incident hit:
      // the seed either threw building itself (two sources claiming one
      // wireName) or — one layer further, in resolveDynamicTool/pi-agent.ts —
      // threw resolving a proxy tool whose wireName the seed didn't carry.
      const seed = createPiExecutionManifestSeed({ snapshot, view, sessionKey: SESSION_KEY });
      const tTrackerSources = seed.mcpSources.filter(
        source => source.capabilityKey === 'mcp:builtin:t-tracker' || source.capabilityKey === 'plug:mcp:t-tracker',
      );
      expect(new Set(tTrackerSources.map(source => source.wireName)))
        .toEqual(new Set(['t-tracker', 'plugin_p_t-tracker']));
      // Each source's capabilityKey must resolve back to its own entry, never
      // the other's — the exact invariant a wireName collision would break.
      const builtinSource = seed.mcpSources.find(source => source.wireName === 't-tracker');
      const pluginSource = seed.mcpSources.find(source => source.wireName === 'plugin_p_t-tracker');
      expect(builtinSource?.capabilityKey).toBe('mcp:builtin:t-tracker');
      expect(pluginSource?.capabilityKey).toBe('plug:mcp:t-tracker');

      // 3. Both proxy tools resolve, under two DISTINCT binding names, in one
      // manifest build — the incident, closed: before the fix the pool served
      // `t-tracker` for both servers and the seed only knew one of them, so
      // one of these two `finalizePiExecutionManifest` calls threw and killed
      // every turn of the session.
      const manifest = finalizePiExecutionManifest(seed, [
        dynamicListTool('mcp__t-tracker__list', builtinEntry.summary.key, seed.snapshotGeneration),
        dynamicListTool('mcp__plugin_p_t-tracker__list', pluginEntry.summary.key, seed.snapshotGeneration),
      ]);
      const bindingNames = manifest.tools.map(tool => tool.binding.bindingName);
      expect(bindingNames).toContain('mcp__t-tracker__list');
      expect(bindingNames).toContain('mcp__plugin_p_t-tracker__list');
      // Exactly two tools, not merely "both present": if the two wire names
      // had collided upstream, `resolveDynamicTool`'s `sources.length !== 1`
      // check would have DROPPED both (each wireName would resolve zero or
      // twice), and this count would read 0, not 2.
      expect(bindingNames.filter(name => name === 'mcp__t-tracker__list' || name === 'mcp__plugin_p_t-tracker__list'))
        .toHaveLength(2);
    } finally {
      resolver.releaseSnapshot(snapshot.leaseId);
    }
  });

  it('degrade arm: a proxy def whose wireName the seed does not carry is dropped, not fatal — the incident SHAPE itself now degrades', async () => {
    // Reuses the same real builtin+plugin resolve as above, then hands
    // finalizePiExecutionManifest a THIRD proxy definition for a "ghost"
    // server that exists in neither the resolved view nor the seed — i.e. the
    // pool advertising a name the manifest seed does not know, which is
    // exactly the stale-pool-vs-new-seed shape of the original incident, not
    // just this one t-tracker instance of it. Pre-T1 this threw
    // (`must resolve exactly once`) and killed every turn; post-T1 it drops
    // the one unresolvable tool and the manifest still builds, with the two
    // real servers' tools intact.
    const inputs = tTrackerCollisionInputs();
    const resolver = createCapabilityResolver({ inputs: () => inputs });
    const snapshot = await resolver.resolve(CONTEXT);
    try {
      const view = toAgentRuntime(snapshot);
      const seed = createPiExecutionManifestSeed({ snapshot, view, sessionKey: SESSION_KEY });
      const builtinKey = snapshot.entries.find(entry => entry.summary.key === 'mcp:builtin:t-tracker')!.summary.key;
      const pluginKey = snapshot.entries.find(entry => entry.summary.key === 'plug:mcp:t-tracker')!.summary.key;

      // No throw: this call succeeding at all (vs. the pre-T1 fatal throw) is
      // the assertion. `ghost` never appears in `seed.mcpSources` no matter
      // what capabilityKey we attach — resolveDynamicTool degrades on the
      // sources.length check before provenance is even consulted.
      const manifest = finalizePiExecutionManifest(seed, [
        dynamicListTool('mcp__t-tracker__list', builtinKey, seed.snapshotGeneration),
        dynamicListTool('mcp__plugin_p_t-tracker__list', pluginKey, seed.snapshotGeneration),
        dynamicListTool('mcp__ghost__x', 'no-such-capability', seed.snapshotGeneration),
      ]);

      const bindingNames = manifest.tools.map(tool => tool.binding.bindingName);
      expect(bindingNames).toContain('mcp__t-tracker__list');
      expect(bindingNames).toContain('mcp__plugin_p_t-tracker__list');
      expect(bindingNames).not.toContain('mcp__ghost__x');
    } finally {
      resolver.releaseSnapshot(snapshot.leaseId);
    }
  });
});
