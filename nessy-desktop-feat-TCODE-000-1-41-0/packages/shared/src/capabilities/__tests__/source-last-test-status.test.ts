/**
 * UB14.48 — a failed `source_test` reaches the capability summary every Sources surface renders.
 *
 * The premise, measured at HEAD before this row: `source_test` stores `connectionStatus: 'error'` and
 * `connectionError` in the source's config.json (`session-tools-core/src/handlers/source-test.ts`), and
 * no renderer file read either name — the Sources list, the management rows and the detail page all
 * render `SafeCapabilitySummary`, which carried no verdict, so a failed source painted green.
 *
 * This drives the REAL chain on a temp workspace: config.json → `buildNativeCapabilityInventory` →
 * `createCapabilityResolver` → `toUserCatalog`, with the config written in the exact shape the
 * handler's save writes (`{ ...source, lastTestedAt, connectionStatus, connectionError }`).
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildNativeCapabilityInventory } from '../native-sources.ts';
import { createCapabilityResolver, type CapabilityContext } from '../resolver.ts';
import { toUserCatalog } from '../views.ts';
import type { SafeCapabilitySummary } from '../../protocol/capabilities.ts';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

const WORKSPACE_ID = 'ws-ub1448';
const CONTEXT: CapabilityContext = {
  workspaceId: WORKSPACE_ID,
  projectTrustState: 'none',
  projectTrustRevision: '',
};

function writeSource(workspaceRoot: string, slug: string, extra: Record<string, unknown>): void {
  const dir = join(workspaceRoot, 'sources', slug);
  mkdirSync(dir, { recursive: true });
  // JSON.stringify drops `undefined`, exactly as the handler's save does for a cleared error.
  writeFileSync(join(dir, 'config.json'), JSON.stringify({
    id: `${slug}-id`,
    slug,
    name: slug,
    type: 'mcp',
    enabled: true,
    mcp: { transport: 'http', url: 'https://mcp.example.com/mcp', authType: 'none' },
    ...extra,
  }));
}

async function sourceSummaries(workspaceRoot: string): Promise<Map<string, SafeCapabilitySummary>> {
  const root = tmp('ub1448-env-');
  mkdirSync(join(root, 'config'), { recursive: true });
  mkdirSync(join(root, 'home-agents'), { recursive: true });
  const nativeInventory = buildNativeCapabilityInventory(
    { workspaceId: WORKSPACE_ID, workspaceRootPath: workspaceRoot, projectTrustState: 'none', projectTrustRevision: '' },
    {
      configDir: join(root, 'config'),
      homeAgentsSkillsDir: join(root, 'home-agents'),
      adminSkillsDirs: [], // hermetic: never scan the machine's own administrator roots
      instructionExcludes: [],
      nestedSkillRoots: [],
    },
  );
  const resolver = createCapabilityResolver({
    inputs: () => ({
      nativeInventory,
      installedPlugins: [],
      activePluginInstances: {},
      pluginCandidates: [],
      resolveActivation: () => ({ enabled: true, suppressed: false, capabilities: {} }),
      resolveTrust: () => 'trusted',
    }),
  });
  const snapshot = await resolver.resolve(CONTEXT);
  try {
    const catalog = toUserCatalog(snapshot);
    return new Map(
      catalog.capabilities
        .filter(summary => summary.kind === 'source')
        .map(summary => [summary.logicalName, summary]),
    );
  } finally {
    resolver.releaseSnapshot(snapshot.leaseId);
  }
}

describe('UB14.48 — the stored source_test verdict on SafeCapabilitySummary', () => {
  it('a stored `error` arrives as lastTestStatus `failed` with its reduced reason', async () => {
    const workspaceRoot = tmp('ub1448-ws-');
    writeSource(workspaceRoot, 'broken', {
      lastTestedAt: 1_760_000_000_000,
      connectionStatus: 'error',
      connectionError: 'HTTP 502 from https://mcp.example.com/s/abc123secret/mcp?token=Q1W2E3 (spawned /Users/alice/bin/proxy)',
    });

    const summary = (await sourceSummaries(workspaceRoot)).get('broken');
    expect(summary?.lastTestStatus).toBe('failed');
    expect(summary?.connectionError).toBe('HTTP 502 from https://mcp.example.com/… (spawned …/proxy)');
    // Nothing the reduction removed crossed the boundary anywhere in the row.
    const wire = JSON.stringify(summary);
    for (const leaked of ['abc123secret', 'Q1W2E3', '/Users/alice']) expect(wire).not.toContain(leaked);
  });

  it("source_test's soft failure (`disconnected`) is failed too, with no reason when none was stored", async () => {
    const workspaceRoot = tmp('ub1448-ws-');
    writeSource(workspaceRoot, 'soft', { connectionStatus: 'disconnected' });

    const summary = (await sourceSummaries(workspaceRoot)).get('soft');
    expect(summary?.lastTestStatus).toBe('failed');
    expect(summary).not.toHaveProperty('connectionError');
  });

  it('control — a source with no stored verdict carries neither field', async () => {
    const workspaceRoot = tmp('ub1448-ws-');
    writeSource(workspaceRoot, 'fresh', {});

    const summary = (await sourceSummaries(workspaceRoot)).get('fresh');
    expect(summary).toBeDefined();
    expect(summary).not.toHaveProperty('lastTestStatus');
    expect(summary).not.toHaveProperty('connectionError');
  });

  it('a later passing source_test clears it: `connected`, and the reason is gone', async () => {
    const workspaceRoot = tmp('ub1448-ws-');
    writeSource(workspaceRoot, 'flaky', { connectionStatus: 'error', connectionError: 'ECONNREFUSED' });
    expect((await sourceSummaries(workspaceRoot)).get('flaky')?.lastTestStatus).toBe('failed');

    // The handler's passing save: `connectionStatus: 'connected'`, `connectionError: undefined`.
    writeSource(workspaceRoot, 'flaky', { lastTestedAt: 1_760_000_000_001, connectionStatus: 'connected', connectionError: undefined });
    const summary = (await sourceSummaries(workspaceRoot)).get('flaky');
    expect(summary?.lastTestStatus).toBe('connected');
    expect(summary).not.toHaveProperty('connectionError');
  });
});
