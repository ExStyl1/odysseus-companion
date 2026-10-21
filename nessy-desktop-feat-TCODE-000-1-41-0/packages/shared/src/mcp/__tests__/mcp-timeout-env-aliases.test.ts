/**
 * P6.142 — the three documented MCP timeout names are read, and the Nessy
 * spelling wins when both are set.
 *
 * `MCP_TIMEOUT`, `MCP_TOOL_TIMEOUT` and `MCP_CONNECT_TIMEOUT_MS` are all
 * documented in `env-vars.md#variables` and were all implemented at their
 * documented defaults under `NESSY_` names that read from nowhere else — so an
 * operator who followed the page set a name this product never looked at and got
 * silence. One positive and one precedence assertion per name, and the tool
 * ceiling's positive arm is a REAL hanging call rather than a unit read, because
 * "the alias parses" and "the alias bounds a call" are different claims.
 *
 * The inherited-value exposure this trade takes on is stated at
 * `MCP_TOOL_TIMEOUT_COMPAT_ENV`: these are names a machine may already carry for
 * other software. The precedence tests below are what keeps that recoverable.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { McpClientPool } from '../mcp-pool.ts';
import { NessyMcpClient, type PoolClient } from '../client.ts';
import {
  MCP_CONNECT_BATCH_TIMEOUT_COMPAT_ENV,
  MCP_CONNECT_BATCH_TIMEOUT_ENV,
  MCP_DEFAULT_TOOL_TIMEOUT_MS,
  MCP_STARTUP_TIMEOUT_COMPAT_ENV,
  MCP_STARTUP_TIMEOUT_ENV,
  MCP_TOOL_TIMEOUT_COMPAT_ENV,
  MCP_TOOL_TIMEOUT_ENV,
  mcpConnectBatchTimeoutMsFromEnv,
  mcpDefaultToolTimeoutMsFromEnv,
  readMcpTimeoutEnv,
} from '../server-config-values.ts';
import type { SdkMcpServerConfig } from '../../agent/backend/types.ts';
import { registerFixtureClient } from './pool-fixture.ts';

const CONFIG: SdkMcpServerConfig = { type: 'http', url: 'https://alias.example.test/mcp' };

const MANAGED_NAMES = [
  MCP_STARTUP_TIMEOUT_ENV,
  MCP_STARTUP_TIMEOUT_COMPAT_ENV,
  MCP_TOOL_TIMEOUT_ENV,
  MCP_TOOL_TIMEOUT_COMPAT_ENV,
  MCP_CONNECT_BATCH_TIMEOUT_ENV,
  MCP_CONNECT_BATCH_TIMEOUT_COMPAT_ENV,
] as const;

const saved = new Map<string, string | undefined>(MANAGED_NAMES.map(name => [name, process.env[name]]));

/**
 * `delete` before assigning, on the restore path too — assigning straight to
 * `process.env.X` in Bun 1.3.14 can leave the name readable by property and
 * invisible to a spread, and every subprocess env in this tree is built by
 * spreading `process.env` (AGENTS.md, measured 2026-09-01).
 */
function setEnv(name: string, value: string | undefined): void {
  delete process.env[name];
  if (value !== undefined) process.env[name] = value;
}

const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const close of closers.splice(0)) await close().catch(() => {});
  for (const name of MANAGED_NAMES) setEnv(name, saved.get(name));
});

const sleep = (ms: number) => new Promise<void>(resolve => { setTimeout(resolve, ms); });

class TestPool extends McpClientPool {
  register(slug: string, client: PoolClient, config: SdkMcpServerConfig) {
    return registerFixtureClient(this, slug, client, config);
  }
}

/** A live MCP server whose `slow` tool takes `workMs` and reports no progress. */
async function liveSource(workMs: number): Promise<NessyMcpClient> {
  // `McpServer`, not the low-level `Server` the two sibling timeout suites use:
  // that class is `@deprecated` in the vendored SDK ("Use `McpServer` instead for
  // the high-level API"), and the low-level shape bought this file nothing — the
  // tool it declares takes no arguments and returns one text block.
  const server = new McpServer({ name: 'alias-test', version: '1.0.0' });
  server.registerTool('slow', { description: 'Slow' }, async () => {
    await sleep(workMs);
    return { content: [{ type: 'text', text: 'done' }] };
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new NessyMcpClient(
    { transport: 'http', url: 'https://alias.example.test/mcp' } as never,
    { transport: clientTransport } as never,
  );
  closers.push(async () => { await client.close(); await server.close(); });
  return client;
}

const resolvedConnectDeadlineMs = (pool: McpClientPool): number =>
  (pool as unknown as { connectTimeoutMs: number }).connectTimeoutMs;

describe('readMcpTimeoutEnv', () => {
  it('prefers the Nessy spelling and reports which name it read', () => {
    expect(readMcpTimeoutEnv(
      { NESSY_MCP_TOOL_TIMEOUT: '5000', MCP_TOOL_TIMEOUT: '9000' },
      MCP_TOOL_TIMEOUT_ENV,
      MCP_TOOL_TIMEOUT_COMPAT_ENV,
    )).toEqual({ name: MCP_TOOL_TIMEOUT_ENV, raw: '5000' });
  });

  it('falls through a blank Nessy value to the documented spelling', () => {
    // A name present but empty is UNSET for every reader in this file, so it must
    // not shadow a real value under the other spelling.
    expect(readMcpTimeoutEnv(
      { NESSY_MCP_TOOL_TIMEOUT: '   ', MCP_TOOL_TIMEOUT: '9000' },
      MCP_TOOL_TIMEOUT_ENV,
      MCP_TOOL_TIMEOUT_COMPAT_ENV,
    )).toEqual({ name: MCP_TOOL_TIMEOUT_COMPAT_ENV, raw: '9000' });
  });

  it('reports nothing when neither spelling is set', () => {
    expect(readMcpTimeoutEnv({}, MCP_TOOL_TIMEOUT_ENV, MCP_TOOL_TIMEOUT_COMPAT_ENV)).toBeUndefined();
  });
});

describe('MCP_TOOL_TIMEOUT (documented spelling)', () => {
  it('parses exactly as the Nessy spelling does', () => {
    expect(mcpDefaultToolTimeoutMsFromEnv({ MCP_TOOL_TIMEOUT: '5000' }))
      .toBe(mcpDefaultToolTimeoutMsFromEnv({ NESSY_MCP_TOOL_TIMEOUT: '5000' }));
    expect(mcpDefaultToolTimeoutMsFromEnv({ MCP_TOOL_TIMEOUT: '5000' })).toBe(5_000);
  });

  it('loses to the Nessy spelling when both are set', () => {
    expect(mcpDefaultToolTimeoutMsFromEnv({
      NESSY_MCP_TOOL_TIMEOUT: '5000',
      MCP_TOOL_TIMEOUT: '9000',
    })).toBe(5_000);
  });

  it('leaves the documented default in place when neither is set', () => {
    expect(mcpDefaultToolTimeoutMsFromEnv({})).toBe(MCP_DEFAULT_TOOL_TIMEOUT_MS);
  });

  it('bounds a hanging tool call, and the abort names the spelling that was set', async () => {
    // The done_means: `MCP_TOOL_TIMEOUT=5000` must BOUND a call, not merely
    // parse. 1000 here rather than 5000 so the suite does not pay five seconds
    // for a bound the server's own 3s work already proves.
    setEnv(MCP_TOOL_TIMEOUT_ENV, undefined);
    setEnv(MCP_TOOL_TIMEOUT_COMPAT_ENV, '1000');
    const pool = new TestPool();
    await pool.register('srv', await liveSource(3_000), CONFIG);

    const started = Date.now();
    const result = await pool.callTool('mcp__srv__slow', {});
    const elapsed = Date.now() - started;

    expect(result.isError).toBe(true);
    expect(result.content).toContain('1000ms wall clock');
    // The name the OPERATOR set, so a reader is not sent looking for a variable
    // nobody set — the inherited-value case is exactly this one.
    expect(result.content).toContain(MCP_TOOL_TIMEOUT_COMPAT_ENV);
    expect(result.content).not.toContain(MCP_TOOL_TIMEOUT_ENV);
    expect(elapsed).toBeLessThan(2_500);
  });

  it('a hanging call under the Nessy spelling is bounded identically', async () => {
    // The positive control for the arm above: same rig, same number, other name.
    setEnv(MCP_TOOL_TIMEOUT_COMPAT_ENV, undefined);
    setEnv(MCP_TOOL_TIMEOUT_ENV, '1000');
    const pool = new TestPool();
    await pool.register('srv', await liveSource(3_000), CONFIG);

    const result = await pool.callTool('mcp__srv__slow', {});

    expect(result.isError).toBe(true);
    expect(result.content).toContain('1000ms wall clock');
    expect(result.content).toContain(MCP_TOOL_TIMEOUT_ENV);
  });
});

describe('MCP_TIMEOUT (documented spelling)', () => {
  it('sets the per-server connect deadline', () => {
    setEnv(MCP_STARTUP_TIMEOUT_ENV, undefined);
    setEnv(MCP_STARTUP_TIMEOUT_COMPAT_ENV, '40000');
    expect(resolvedConnectDeadlineMs(new McpClientPool())).toBe(40_000);
  });

  it('loses to the Nessy spelling when both are set', () => {
    setEnv(MCP_STARTUP_TIMEOUT_ENV, '11000');
    setEnv(MCP_STARTUP_TIMEOUT_COMPAT_ENV, '40000');
    expect(resolvedConnectDeadlineMs(new McpClientPool())).toBe(11_000);
  });

  it('leaves the documented 30s default in place when neither is set', () => {
    setEnv(MCP_STARTUP_TIMEOUT_ENV, undefined);
    setEnv(MCP_STARTUP_TIMEOUT_COMPAT_ENV, undefined);
    expect(resolvedConnectDeadlineMs(new McpClientPool())).toBe(30_000);
  });
});

describe('MCP_CONNECT_TIMEOUT_MS (documented spelling)', () => {
  it('caps the connect batch', () => {
    expect(mcpConnectBatchTimeoutMsFromEnv({ MCP_CONNECT_TIMEOUT_MS: '5000' })).toBe(5_000);
  });

  it('loses to the Nessy spelling when both are set', () => {
    expect(mcpConnectBatchTimeoutMsFromEnv({
      NESSY_MCP_CONNECT_TIMEOUT_MS: '2500',
      MCP_CONNECT_TIMEOUT_MS: '5000',
    })).toBe(2_500);
  });

  it('is still no cap when neither is set', () => {
    expect(mcpConnectBatchTimeoutMsFromEnv({})).toBeUndefined();
  });
});
