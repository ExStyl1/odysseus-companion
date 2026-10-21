/**
 * E5a (send path) — a send keeps the live client of an api source that has not
 * moved.
 *
 * > When you reload, Claude Code keeps the live connections of plugin servers
 * > whose configuration is unchanged. (`plugins-reference.md`)
 *
 * The MCP half needs no coverage here: `mcpConnectionKey` is a sha256 over the
 * server config, so an unchanged MCP server already keeps its client. The api
 * half is the one that churned — `apiConnectionKey` keys on the INSTANCE, and
 * every send used to mint a fresh one for every api source.
 *
 * Everything under assertion is production: the REAL `BaseAgent.setSourceServers`
 * (the send path's only materialization call), the REAL
 * `materializeRuntimePoolServers`, the REAL `SourceServerBuilder`, the REAL
 * `CapabilitySnapshotMaterializer` and the REAL `McpClientPool` — instrumented
 * only by a subclass that RECORDS `connectInProcess`/`sync` and delegates, so no
 * diff or identity rule is reproduced here. Api sources are in-process
 * (`InMemoryTransport`): no subprocess, no network, no credential file, and
 * nothing that reads this host.
 *
 * Assertions are CONNECT COUNTS and INSTANCE IDENTITY. A count of rows in the
 * desired set cannot see a needless reconnect, which is the whole defect.
 */

import { describe, it, expect, afterEach } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { McpClientPool } from '../mcp-pool.ts';
import { createCapabilitySnapshotMaterializer } from '../../capabilities/materializer.ts';
import type {
  CapabilityResolver,
  EffectiveCapabilitySnapshot,
  NativeResourceRef,
} from '../../capabilities/resolver.ts';
import type { RuntimeCredentialBinding, StoredCredential } from '../../credentials/types.ts';
import type { CapabilityTurnRuntime } from '../../agent/backend/types.ts';
import { TestAgent, createMockBackendConfig } from '../../agent/__tests__/test-utils.ts';

const LEASER = 'session-leaser';

/** The real pool, instrumented. Overrides only record, then delegate. */
class RecordingPool extends McpClientPool {
  readonly apiConnects: { slug: string; instance: object }[] = [];
  readonly syncedApiMaps: Record<string, { instance: McpServer }>[] = [];

  override async connectInProcess(slug: string, mcpServer: McpServer): Promise<void> {
    this.apiConnects.push({ slug, instance: mcpServer });
    return super.connectInProcess(slug, mcpServer);
  }

  override async sync(
    mcpServers: Parameters<McpClientPool['sync']>[0],
    apiServers: Parameters<McpClientPool['sync']>[1] = {},
    options: Parameters<McpClientPool['sync']>[2] = {},
  ): Promise<string[]> {
    this.syncedApiMaps.push(apiServers as unknown as Record<string, { instance: McpServer }>);
    return super.sync(mcpServers, apiServers, options);
  }

  /** Instance the pool was handed for a slug, by sync ordinal. */
  instanceAt(syncIndex: number, slug: string): object | undefined {
    return this.syncedApiMaps[syncIndex]?.[slug]?.instance;
  }

  connectCountFor(slug: string): number {
    return this.apiConnects.filter(connect => connect.slug === slug).length;
  }
}

/** Write an api source folder and return the resource ref pinning its bytes. */
function writeApiSource(
  root: string,
  slug: string,
  overrides: Record<string, unknown> = {},
): NativeResourceRef {
  const folder = join(root, slug);
  mkdirSync(folder, { recursive: true });
  const configPath = join(folder, 'config.json');
  const config = {
    id: slug,
    name: slug,
    slug,
    enabled: true,
    provider: slug,
    type: 'api',
    api: { baseUrl: `https://example.test/${slug}`, authType: 'none' },
    ...overrides,
  };
  const text = JSON.stringify(config, null, 2);
  writeFileSync(configPath, text);
  return {
    source: 'workspace',
    scope: { kind: 'workspace', workspaceId: 'test-workspace-id' },
    resourceId: `source:${slug}`,
    absolutePath: folder,
    revision: String(statSync(configPath).mtimeMs),
    contentHash: createHash('sha256').update(Buffer.from(text)).digest('hex'),
  } as unknown as NativeResourceRef;
}

interface TurnSource {
  slug: string;
  resource: NativeResourceRef;
  credential?: RuntimeCredentialBinding;
}

/**
 * One turn's pinned runtime, over the REAL materializer and its own lease. A
 * released lease is what production hands a closure that outlived its turn:
 * `assertActive` throws `capability-snapshot-revoked`.
 */
function makeTurn(
  sources: TurnSource[],
  credentialValue: string,
): { runtime: CapabilityTurnRuntime; release: () => void } {
  let active = true;
  const resolver = {
    isLeaseActive: () => active,
  } as unknown as CapabilityResolver;
  const materializer = createCapabilitySnapshotMaterializer(
    resolver,
    { leaseId: 'lease', installedPlugins: [] } as unknown as EffectiveCapabilitySnapshot,
    {
      resolveCredential: binding => ({
        ready: true,
        revision: binding.expectedRevision,
        value: credentialValue,
        credential: { value: credentialValue } as StoredCredential,
      }),
    },
  );
  return {
    runtime: {
      view: {
        generation: 'test-generation',
        sources: sources.map(source => ({
          key: `source#${source.slug}`,
          logicalName: source.slug,
          resource: source.resource,
          ...(source.credential ? { credential: source.credential } : {}),
        })),
        skills: [],
        mcpServers: [],
        hooks: [],
        automations: [],
        agents: [],
        promptLayers: [],
        memory: [],
        permissionLayers: [],
        commands: [],
        promptCommands: [],
        apps: [],
      } as unknown as CapabilityTurnRuntime['view'],
      materializer,
    },
    release: () => { active = false; },
  };
}

function makeAgent(pool: RecordingPool): TestAgent {
  return new TestAgent(createMockBackendConfig({ mcpPool: pool, mcpLeaserId: LEASER }));
}

/** One send: pin the turn's runtime, then run the production materialization. */
async function send(agent: TestAgent, runtime: CapabilityTurnRuntime): Promise<void> {
  agent.setCapabilityTurnRuntime(runtime);
  await agent.setSourceServers({}, {}, []);
}

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

describe('E5a — a send keeps the live client of an unchanged api source', () => {
  it('reconnects 0 when nothing moved, and exactly the moved source when one does', async () => {
    const root = mkdtempSync(join(tmpdir(), 'e5a-send-'));
    const alpha = writeApiSource(root, 'alpha');
    const beta = writeApiSource(root, 'beta');
    const pool = new RecordingPool({});
    const agent = makeAgent(pool);

    // Turn 1 — warm the pool.
    await send(agent, makeTurn([
      { slug: 'alpha', resource: alpha },
      { slug: 'beta', resource: beta },
    ], 'unused').runtime);
    expect(pool.connectCountFor('alpha')).toBe(1);
    expect(pool.connectCountFor('beta')).toBe(1);

    // Turn 2 — a fresh materialization with NOTHING changed. The pool must be
    // handed the instances it is already holding, and connect nothing.
    await send(agent, makeTurn([
      { slug: 'alpha', resource: alpha },
      { slug: 'beta', resource: beta },
    ], 'unused').runtime);
    expect(pool.syncedApiMaps.length).toBe(2);
    expect(pool.connectCountFor('alpha')).toBe(1);
    expect(pool.connectCountFor('beta')).toBe(1);
    expect(pool.instanceAt(1, 'alpha')).toBe(pool.instanceAt(0, 'alpha')!);
    expect(pool.instanceAt(1, 'beta')).toBe(pool.instanceAt(0, 'beta')!);

    // Turn 3 — alpha's configuration moves. Only alpha reconnects, and beta is
    // still the exact client identity it has held since the first send.
    const movedAlpha = writeApiSource(root, 'alpha', { tagline: 'moved' });
    await send(agent, makeTurn([
      { slug: 'alpha', resource: movedAlpha },
      { slug: 'beta', resource: beta },
    ], 'unused').runtime);
    expect(pool.connectCountFor('alpha')).toBe(2);
    expect(pool.connectCountFor('beta')).toBe(1);
    expect(pool.instanceAt(2, 'alpha')).not.toBe(pool.instanceAt(0, 'alpha')!);
    expect(pool.instanceAt(2, 'beta')).toBe(pool.instanceAt(0, 'beta')!);

    agent.destroy();
    await pool.disconnectAll();
  });

  it('reconnects a credentialed source when its revision rotates, though the config file is untouched', async () => {
    const root = mkdtempSync(join(tmpdir(), 'e5a-send-cred-'));
    const gamma = writeApiSource(root, 'gamma', {
      api: { baseUrl: 'https://example.test/gamma', authType: 'bearer' },
      isAuthenticated: true,
    });
    const stable = writeApiSource(root, 'stable');
    const pool = new RecordingPool({});
    const agent = makeAgent(pool);
    const turn = (revision: number) => makeTurn([
      { slug: 'gamma', resource: gamma, credential: { id: 'cred-gamma', expectedRevision: revision } as unknown as RuntimeCredentialBinding },
      { slug: 'stable', resource: stable },
    ], `not-a-real-token-r${revision}`).runtime;

    await send(agent, turn(1));
    expect(pool.connectCountFor('gamma')).toBe(1);
    expect(pool.connectCountFor('stable')).toBe(1);

    // Same bytes on disk, rotated credential revision.
    await send(agent, turn(2));
    expect(pool.connectCountFor('gamma')).toBe(2);
    expect(pool.connectCountFor('stable')).toBe(1);
    expect(pool.instanceAt(1, 'gamma')).not.toBe(pool.instanceAt(0, 'gamma')!);
    expect(pool.instanceAt(1, 'stable')).toBe(pool.instanceAt(0, 'stable')!);

    agent.destroy();
    await pool.disconnectAll();
  });

  it('a retained api server reads its credential through the CURRENT turn, not the released lease that built it', async () => {
    const root = mkdtempSync(join(tmpdir(), 'e5a-send-rebind-'));
    const delta = writeApiSource(root, 'delta', {
      api: { baseUrl: 'https://example.test/delta', authType: 'bearer' },
      isAuthenticated: true,
    });
    const pool = new RecordingPool({});
    const agent = makeAgent(pool);
    const binding = { id: 'cred-delta', expectedRevision: 7 } as unknown as RuntimeCredentialBinding;

    const seenAuthorization: (string | null)[] = [];
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      const headers = new Headers((init?.headers ?? {}) as Record<string, string>);
      seenAuthorization.push(headers.get('authorization'));
      return new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;

    // Turn 1 builds the instance; turn 2 retains it (same config, same revision).
    const first = makeTurn([{ slug: 'delta', resource: delta, credential: binding }], 'token-turn-1');
    await send(agent, first.runtime);
    const second = makeTurn([{ slug: 'delta', resource: delta, credential: binding }], 'token-turn-2');
    await send(agent, second.runtime);
    expect(pool.connectCountFor('delta')).toBe(1);
    expect(pool.instanceAt(1, 'delta')).toBe(pool.instanceAt(0, 'delta')!);

    // Turn 1's lease is released, which is what the end of a turn does.
    first.release();

    const call = await pool.callTool(
      'mcp__delta__api_delta',
      { path: '/ping', method: 'GET', _intent: 'gate' },
      undefined,
      { leaserId: LEASER },
    );
    expect(call.isError).toBeFalsy();
    // The retained instance used turn 2's credential, not turn 1's, and did not
    // fail on turn 1's dead lease.
    expect(seenAuthorization).toEqual(['Bearer token-turn-2']);

    // POSITIVE CONTROL on the same rig: release the CURRENT turn's lease and the
    // very same retained instance does fail, so the arm above is a live pass
    // rather than a rig that cannot see a dead lease at all.
    second.release();
    const afterRelease = await pool.callTool(
      'mcp__delta__api_delta',
      { path: '/ping', method: 'GET', _intent: 'control' },
      undefined,
      { leaserId: LEASER },
    );
    expect(String(afterRelease.content)).toContain('capability-snapshot-revoked');
    expect(seenAuthorization.length).toBe(1);

    agent.destroy();
    await pool.disconnectAll();
  });
});
