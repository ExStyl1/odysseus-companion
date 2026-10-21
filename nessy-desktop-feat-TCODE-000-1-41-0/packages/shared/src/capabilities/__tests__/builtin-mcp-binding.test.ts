/**
 * A7 option A — the ONE asymmetry the built-in projection introduces in the
 * resolver, and its positive control.
 *
 * A native `.mcp.json` record pins the document it came from, because
 * `materializeSnapshotMcpServers` reads that document to get the server's real
 * definition. A BUILT-IN record has no document: the only thing that
 * materializes its command is `foldBuiltinDpMcpServers`, and a pinned resource
 * would put the built-in's wire name into the configured map first — at which
 * point `mergeBuiltinDpMcpServers` stands the real built-in down and an enabled
 * server never starts.
 *
 * Both directions are asserted from ONE resolve, so "the builtin case is right"
 * can never be true because the whole branch stopped emitting resources.
 */

import { describe, expect, it } from 'bun:test';
import { createCapabilityResolver, type CapabilityContext, type CapabilityResolutionInputs } from '../resolver.ts';
import type { NativeCapabilitySourceRecord } from '../types.ts';

const CONTEXT: CapabilityContext = {
  workspaceId: 'ws-1',
  projectTrustState: 'none',
  projectTrustRevision: '',
};

function record(
  over: Partial<NativeCapabilitySourceRecord> & Pick<NativeCapabilitySourceRecord, 'key' | 'kind' | 'logicalName'>,
): NativeCapabilitySourceRecord {
  return {
    scope: { kind: 'workspace', workspaceId: 'ws-1' },
    sourcePath: `/abs/managed/${over.key}`,
    revision: 'r1',
    contentHash: 'a'.repeat(64),
    mutable: true,
    ...over,
  };
}

const INPUTS: CapabilityResolutionInputs = {
  nativeInventory: {
    records: [
      record({ key: 'mcp:ws:fs', kind: 'mcp', logicalName: 'fs' }),
      record({
        key: 'builtin:mcp:dpJira',
        kind: 'mcp',
        logicalName: 'dpJira',
        scope: { kind: 'builtin' },
        sourcePath: '',
        mutable: false,
        sourceEnabled: true,
        mcpServerIdentity: { transport: 'stdio', command: ['dp', 'ai', 'mcp', 'jira'] },
      }),
    ],
    blockedLayers: [],
  },
  installedPlugins: [],
  activePluginInstances: {},
  pluginCandidates: [],
  resolveActivation: () => ({ enabled: true, suppressed: false, capabilities: {} }),
  resolveTrust: () => 'trusted',
};

describe('native mcp runtime bindings', () => {
  it('pins the document for a discovered record and withholds it for a built-in', async () => {
    const resolver = createCapabilityResolver({ inputs: async () => INPUTS });
    const snapshot = await resolver.resolve(CONTEXT);
    try {
      const bindings = new Map(snapshot.entries.map(entry => [entry.summary.key, entry.runtimeBinding]));

      // Positive control: an ordinary `.mcp.json` record is UNCHANGED. Its
      // definition is read from this resource at materialization time, so
      // dropping it would silently stop every native and plugin MCP server.
      const native = bindings.get('mcp:ws:fs');
      expect(native?.kind).toBe('mcp');
      if (native?.kind !== 'mcp') throw new Error('unreachable');
      expect(native.server.resource?.absolutePath).toBe('/abs/managed/mcp:ws:fs');
      expect(native.server.sourceName).toBe('fs');

      const builtin = bindings.get('builtin:mcp:dpJira');
      expect(builtin?.kind).toBe('mcp');
      if (builtin?.kind !== 'mcp') throw new Error('unreachable');
      expect(builtin.server.resource).toBeUndefined();
      expect(builtin.server.sourceName).toBeUndefined();
      // The wire name still stands: it is how the detail page's tools listing
      // finds the built-in in the live pool
      // (`SessionManager.resolveMcpBindingFromContext`).
      expect(builtin.server.wireName).toBe('dpJira');
      // The empty command is what makes `materializeSnapshotMcpServers` skip
      // the entry outright, leaving the built-in fold as the single path.
      expect(builtin.server.definition).toEqual({ type: 'stdio', command: '' });
    } finally {
      resolver.releaseSnapshot(snapshot.leaseId);
    }
  });

  it('reports a built-in scope as the builtin origin', async () => {
    const resolver = createCapabilityResolver({ inputs: async () => INPUTS });
    const snapshot = await resolver.resolve(CONTEXT);
    try {
      const byKey = new Map(snapshot.entries.map(entry => [entry.summary.key, entry.summary]));
      expect(byKey.get('builtin:mcp:dpJira')?.origin).toBe('builtin');
      expect(byKey.get('builtin:mcp:dpJira')?.mcpTransport).toBe('stdio');
      // Positive control: the discovered record is still `native`.
      expect(byKey.get('mcp:ws:fs')?.origin).toBe('native');
    } finally {
      resolver.releaseSnapshot(snapshot.leaseId);
    }
  });
});
