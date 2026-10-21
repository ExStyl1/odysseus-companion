/**
 * F1.906 (origin: SIT-aa, corrected by WJ-crit-ddd's measurement) — an API
 * source's tool must be present on the FIRST turn.
 *
 * The measured defect shape: through the real
 * `BaseAgent.setSourceServers -> materializeRuntimePoolServers -> McpClientPool`,
 * a connected API source hands `api_<slug>` exactly when the send path awaits
 * the reconcile (`awaitConnect: true`, the browse path), and hands NOTHING on
 * the send path itself (`awaitConnect: false`) whenever the source's server
 * INSTANCE is new — a session's first turn, or the first after its config.json
 * is rewritten by a credential save. The auth type is NOT the cause (the
 * corrected premise): the send path does not wait for the in-process connect,
 * and the durable descriptor cache can never serve an API source (its key
 * carries a per-process instance counter, `["api", slug, n]`), so the turn
 * reads an empty tool surface for a source that reads `connected`.
 *
 * The fix under this suite is the origin's option (a): the send path awaits
 * ONLY the in-process API connects (`pool.ensureApiSourcesConnected`), which
 * are instant by construction — `connectInProcess` runs no transport — while
 * the MCP half stays backgrounded exactly as before. What is proven:
 *
 * - The first send's own reader sees `api_<slug>` (`getTools` and
 *   `getProxyToolDefs`, the two shapes the runtimes read — claude via
 *   `createSourceProxyServers`, Pi via `getProxyToolDefs`).
 * - The MCP half is NOT awaited: a desired MCP server whose transport never
 *   finishes connecting does not delay the send path (the measured 33.7 s
 *   turn-latency scaling stays fixed).
 * - E5a stands: a second send with the same (unchanged) source instance does
 *   not reconnect it — `connectOnce`'s per-key dedupe makes the direct connect
 *   and the reconcile's attempt one chain, and a warm `clients.has` is a no-op.
 *
 * The rig is the product's own seams, as WJ-crit-ddd's probe
 * (`work/wjcritddd/f1906-probe.test.ts`) drove them: real `TestAgent`, real
 * materialization, real pool; fetch is never reached (in-process API source).
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpClientPool, type McpOpenConnectionRequest } from '../../mcp/mcp-pool.ts';
import { createCapabilitySnapshotMaterializer } from '../../capabilities/materializer.ts';
import type { PoolClient } from '../../mcp/client.ts';
import type { SdkMcpServerConfig } from '../backend/types.ts';
import type { CapabilityTurnRuntime } from '../backend/types.ts';
import { TestAgent, createMockBackendConfig } from './test-utils.ts';

const LEASER = 'f1906-leaser';

let roots: string[] = [];
let releases: Array<() => void> = [];

afterEach(async () => {
  for (const release of releases.splice(0)) release();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function writeApiSource(root: string, slug: string): { source: string; scope: { kind: 'workspace'; workspaceId: string }; resourceId: string; absolutePath: string; revision: string; contentHash: string } {
  const folder = join(root, slug);
  mkdirSync(folder, { recursive: true });
  const configPath = join(folder, 'config.json');
  const api = { baseUrl: 'http://127.0.0.1:1/', authType: 'query', queryParam: 'api_key' };
  const text = JSON.stringify({ id: slug, name: slug, slug, enabled: true, provider: slug, type: 'api', api, isAuthenticated: true, connectionStatus: 'connected' }, null, 2);
  writeFileSync(configPath, text);
  return {
    source: 'workspace',
    scope: { kind: 'workspace', workspaceId: 'test-workspace-id' },
    resourceId: `source:${slug}`,
    absolutePath: folder,
    revision: String(statSync(configPath).mtimeMs),
    contentHash: createHash('sha256').update(Buffer.from(text)).digest('hex'),
  } as never;
}

function makeTurn(sources: { slug: string; resource: unknown; credential: unknown }[]): CapabilityTurnRuntime {
  const materializer = createCapabilitySnapshotMaterializer(
    { isLeaseActive: () => true } as never,
    { leaseId: 'lease', installedPlugins: [] } as never,
    // The credential value is a fabricated string; the API client embeds it in
    // the URL it never fetches (the source is in-process — no transport).
    { resolveCredential: (binding: { expectedRevision: number }) => ({ ready: true, revision: binding.expectedRevision, value: 'F1906-FAKE-KEY' }) } as never,
  );
  return {
    view: {
      generation: 'g',
      sources: sources.map(s => ({ key: `source#${s.slug}`, logicalName: s.slug, resource: s.resource, credential: s.credential })) as CapabilityTurnRuntime['view']['sources'],
      skills: [], mcpServers: [], hooks: [], automations: [], agents: [], promptLayers: [], memory: [], permissionLayers: [], commands: [], promptCommands: [], apps: [],
    },
    materializer,
  } as CapabilityTurnRuntime;
}

/** The pool this suite drives, counting genuinely NEW in-process connects. */
class F1906Pool extends McpClientPool {
  inProcessConnects = 0;

  override async connectInProcess(slug: string, mcpServer: Parameters<McpClientPool['connectInProcess']>[1]): Promise<void> {
    // A warm source reaches here as a no-op (`clients.has` returns inside), and
    // the E5a arm counts REGISTRATIONS, not invocations.
    const clients = (this as unknown as { clients: Map<string, unknown> }).clients;
    const key = this.connectionKeyForDesired(slug, LEASER);
    const before = key ? clients.has(key) : false;
    await super.connectInProcess(slug, mcpServer);
    if (!before && key && clients.has(key)) this.inProcessConnects += 1;
  }
}

describe('F1.906 — the first send sees its API source tool', () => {
  it('the send-path reader sees api_<slug> the moment setSourceServers returns', async () => {
    const root = mkdtempSync(join(tmpdir(), 'f1906-first-'));
    roots.push(root);
    const resource = writeApiSource(root, 'sitq');
    const pool = new F1906Pool();
    const agent = new TestAgent(createMockBackendConfig({ mcpPool: pool, mcpLeaserId: LEASER }));
    agent.setCapabilityTurnRuntime(makeTurn([
      { slug: 'sitq', resource, credential: { id: 'cred-q', expectedRevision: 1 } },
    ]));
    // THE SEND PATH'S OWN CALL, verbatim posture: desired set registered, the
    // reconcile backgrounded.
    await agent.setSourceServers({}, {}, ['sitq'], { awaitConnect: false });
    // The turn's tool surface, read the way Pi reads it — and `getTools`, the
    // cache claude's `createSourceProxyServers` reads through.
    const defs = pool.getProxyToolDefs([...pool.slugsForLeaser(LEASER)], LEASER).map(def => def.name);
    expect(defs).toContain('mcp__sitq__api_sitq');
    expect(pool.getTools('sitq', LEASER).map(tool => tool.name)).toContain('api_sitq');
    agent.destroy();
    await pool.disconnectAll();
  });

  it('CONTROL — a reader after the background reconcile lands sees the tool (the pre-fix behaviour)', async () => {
    // The origin's control: a SECOND session's send-time reader sees
    // `api_<slug>` — by then the background reconcile has connected the source.
    const root = mkdtempSync(join(tmpdir(), 'f1906-second-'));
    roots.push(root);
    const resource = writeApiSource(root, 'sitq');
    const pool = new McpClientPool();
    const agent = new TestAgent(createMockBackendConfig({ mcpPool: pool, mcpLeaserId: LEASER }));
    agent.setCapabilityTurnRuntime(makeTurn([
      { slug: 'sitq', resource, credential: { id: 'cred-q', expectedRevision: 1 } },
    ]));
    await agent.setSourceServers({}, {}, ['sitq'], { awaitConnect: false });
    // A later reader: the reconcile settles, the tools arrive.
    for (let waited = 0; pool.getTools('sitq', LEASER).length === 0 && waited < 2_000; waited += 20) {
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    expect(pool.getTools('sitq', LEASER).map(tool => tool.name)).toContain('api_sitq');
    agent.destroy();
    await pool.disconnectAll();
  });

  it('the MCP half stays backgrounded: a server whose transport never connects does not delay the send', async () => {
    const root = mkdtempSync(join(tmpdir(), 'f1906-mcp-'));
    roots.push(root);
    const resource = writeApiSource(root, 'sitq');
    // A pool whose MCP transports hang until released; the connect deadline
    // (focused-test seam) bounds the background reconcile, never the send.
    const pool = new F1906Pool({ connectTimeoutMs: 200 });
    const hang = new Promise<PoolClient>(() => {});
    (pool as unknown as { openConnection?: (request: McpOpenConnectionRequest) => Promise<PoolClient | undefined> }).openConnection =
      () => hang;
    const agent = new TestAgent(createMockBackendConfig({ mcpPool: pool, mcpLeaserId: LEASER }));
    const mcpConfig = { type: 'http', url: 'https://f1906.example.test/mcp' } as SdkMcpServerConfig;
    agent.setCapabilityTurnRuntime(makeTurn([
      { slug: 'sitq', resource, credential: { id: 'cred-q', expectedRevision: 1 } },
    ]));
    const started = Date.now();
    await agent.setSourceServers(
      { 'f1906-mcp': mcpConfig },
      {},
      ['sitq', 'f1906-mcp'],
      { awaitConnect: false },
    );
    const elapsed = Date.now() - started;
    // The API tool is present NOW…
    expect(pool.getTools('sitq', LEASER).map(tool => tool.name)).toContain('api_sitq');
    // …the MCP server is not connected yet (its transport is still hanging),…
    expect(pool.getTools('f1906-mcp', LEASER)).toEqual([]);
    // …and the send path did not wait for its deadline.
    expect(elapsed).toBeLessThan(200);
    agent.destroy();
    await pool.disconnectAll().catch(() => {});
  });

  it('E5a — a second send with the unchanged source instance does not reconnect it', async () => {
    const root = mkdtempSync(join(tmpdir(), 'f1906-e5a-'));
    roots.push(root);
    const resource = writeApiSource(root, 'sitq');
    const pool = new F1906Pool();
    const agent = new TestAgent(createMockBackendConfig({ mcpPool: pool, mcpLeaserId: LEASER }));
    const turn = makeTurn([
      { slug: 'sitq', resource, credential: { id: 'cred-q', expectedRevision: 1 } },
    ]);
    agent.setCapabilityTurnRuntime(turn);
    await agent.setSourceServers({}, {}, ['sitq'], { awaitConnect: false });
    expect(pool.getTools('sitq', LEASER).length).toBeGreaterThan(0);
    const afterFirstSend = pool.inProcessConnects;
    // The SAME instance (the source has not moved — E5a's retention posture).
    await agent.setSourceServers({}, {}, ['sitq'], { awaitConnect: false });
    expect(pool.inProcessConnects).toBe(afterFirstSend);
    expect(pool.getTools('sitq', LEASER).length).toBeGreaterThan(0);
    agent.destroy();
    await pool.disconnectAll();
  });
});
