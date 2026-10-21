/**
 * F1.155 — the name a CODEX model is handed for a pool tool, measured on the
 * shipped binary rather than read off a comment.
 *
 * ## What was wrong
 *
 * `McpPoolServer.createMcpServer`'s docblock said "Codex sees:
 * mcp__sources__nessy__search_spaces", and the MCP-W cdp fixtures derived the
 * name they asked a codex model for from that sentence. SIT-11's codex driver
 * measured the opposite three times on packaged 1.40.0: the model reported
 * `mcp__sources__…` absent from its tools and called
 * `plugin_cdp_echo_probe_echo__whoami` — no prefix, hyphens as underscores —
 * and that call worked.
 *
 * ## The rig — every hop real
 *
 * A real {@link McpPoolServer} over a real {@link McpClientPool} (one fixture
 * client filed through the real `connect`), the shipped `codex-app-server`
 * spawned through the product's own `CodexRuntimeManager` (pre-spawn SHA gate
 * included) on a `config.toml` written by the REAL `buildCodexConfigToml` with
 * the pool as `[mcp_servers.sources]`, and the REAL Responses adapter between
 * codex and a recording chat-completions upstream. So the tool list recorded
 * upstream IS what a Nessy Gateway model is handed, and the call the recorded
 * model makes goes back through the adapter's namespace re-attachment, codex's
 * router and the pool bridge to the fixture client.
 *
 * Skips where the binary is absent (a build-time download, gitignored). No
 * model, no credential, no network beyond loopback.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startAdapter } from '@nessy-agent/codex-responses-adapter';
import { startStubAdapter } from '@nessy-agent/codex-responses-adapter/stub-server';
import {
  buildCodexConfigToml,
  CODEX_API_KEY_ENV,
  CODEX_POOL_MCP_TOKEN_ENV,
} from '@nessy-agent/codex-responses-adapter/config-writer';
import { buildApprovalResponse, MCP_ELICITATION_METHOD } from '@nessy-agent/codex-agent-server';
import { AppServerClient } from '@nessy-agent/codex-agent-server/app-server-client';
import { CodexRuntimeManager } from '@nessy-agent/codex-agent-server/runtime-manager';
import { CODEX_POOL_TOOL_NAMESPACE, codexModelToolName } from '../../capabilities/mcp-wire-name.ts';
import type { PoolClient } from '../client.ts';
import { McpClientPool } from '../mcp-pool.ts';
import { McpPoolServer } from '../pool-server.ts';
import { registerFixtureClient } from './pool-fixture.ts';

const PLATFORM_DIR = `${process.platform}-${process.arch}`;
const BUNDLED_CODEX = join(
  import.meta.dir, '..', '..', '..', '..', '..',
  'apps', 'electron', 'resources', 'bin', 'codex', PLATFORM_DIR,
  process.platform === 'win32' ? 'codex-app-server.exe' : 'codex-app-server',
);
const HAVE_BIN = existsSync(BUNDLED_CODEX);

/** SIT-11's own fixture: a plugin-minted wire name WITH hyphens, and its one tool. */
const WIRE = 'plugin_cdp-echo-probe_echo';
const TOOL = 'whoami';
/** What the host records for the call — codex's raw `(server, tool)` pair. */
const HOST_ROW_NAME = `mcp__sources__${WIRE}__${TOOL}`;
const MODEL = 'tgpt/qwen35-397b-a17b-fp8';
const BUDGET_MS = 180_000;

const scratch: string[] = [];
afterAll(() => { for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true }); });

interface Recorded {
  /** Every chat-completions body the adapter sent upstream, parsed. */
  upstreamBodies: Array<{ tools?: Array<{ function?: { name?: string } }> }>;
  /** Every `callTool` the fixture client received, by its RAW tool name. */
  fixtureCalls: string[];
  /** `item/completed` items of type `mcpToolCall`, as codex reported them. */
  mcpToolCallItems: Array<Record<string, unknown>>;
  turnCompleted: boolean;
  serverRequests: string[];
}

function chatSse(chunks: unknown[]): Response {
  const body = chunks.map(c => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n';
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

/** The pool, with SIT-11's fixture tool filed through the real `connect`. */
async function startPool(recorded: Pick<Recorded, 'fixtureCalls'>): Promise<McpPoolServer> {
  const pool = new McpClientPool();
  await registerFixtureClient(pool, WIRE, {
    async listTools() { return [{ name: TOOL, description: 'Answers who it is.', inputSchema: { type: 'object', properties: {} } }]; },
    async callTool(name: string) {
      recorded.fixtureCalls.push(name);
      return { content: [{ type: 'text', text: 'FIXTURE-WHOAMI' }], isError: false };
    },
    async close() {},
  } as unknown as PoolClient);
  const poolServer = new McpPoolServer(pool);
  await poolServer.start();
  return poolServer;
}

/**
 * One boot of the shipped binary on the product's own config, one thread, one
 * turn, against the Responses endpoint at `providerPort`.
 */
async function bootAndTurn(
  poolServer: McpPoolServer,
  providerPort: number,
  recorded: Pick<Recorded, 'mcpToolCallItems' | 'serverRequests'> & { turnCompleted: boolean },
): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), 'f1155-home-'));
  const workspace = mkdtempSync(join(tmpdir(), 'f1155-ws-'));
  scratch.push(home, workspace);
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, 'config.toml'), buildCodexConfigToml({
    codexHome: home,
    model: MODEL,
    adapterPort: providerPort,
    mode: 'bypassPermissions',
    sandboxGloballyEnabled: false,
    poolMcpUrl: poolServer.url,
  }));

  const manager = new CodexRuntimeManager();
  const child = manager.spawn({
    binaryPath: BUNDLED_CODEX,
    cwd: workspace,
    codexHome: home,
    env: { [CODEX_API_KEY_ENV]: 'loopback', [CODEX_POOL_MCP_TOKEN_ENV]: poolServer.bearerToken },
    platformDir: PLATFORM_DIR,
  });
  let wake: (() => void) | null = null;
  const client = new AppServerClient(child, {
    onNotification: (method, params) => {
      const item = (params as { item?: Record<string, unknown> } | null)?.item;
      if (method === 'item/completed' && item?.type === 'mcpToolCall') recorded.mcpToolCallItems.push(item);
      if (method === 'turn/completed') { recorded.turnCompleted = true; wake?.(); }
    },
    // Measured: codex asks before an MCP tool call even under
    // `bypassPermissions`, on `mcpServer/elicitation/request`. It is answered
    // with the product's OWN allow (`buildApprovalResponse`, the frame
    // `CodexAgent` sends when a person or the mode allows it); anything else is
    // refused, and every request is recorded.
    onServerRequest: ({ method, params }) => {
      recorded.serverRequests.push(method);
      return method === MCP_ELICITATION_METHOD
        ? buildApprovalResponse('elicitation', params, true)
        : { decision: 'decline' };
    },
  });
  try {
    await client.request('initialize', {
      clientInfo: { name: 'nessy-f1155', title: null, version: '0.0.0' },
      capabilities: { experimentalApi: true, requestAttestation: false },
    }, { timeoutMs: 60_000 });
    client.notify('initialized');
    const started = await client.request('thread/start', { cwd: workspace, model: MODEL }, { timeoutMs: 60_000 }) as {
      thread?: { id?: string };
    };
    const ended = new Promise<void>(resolve => { wake = resolve; });
    await client.request('turn/start', {
      threadId: started.thread?.id, input: [{ type: 'text', text: 'call the probe', text_elements: [] }],
    }, { timeoutMs: 60_000 });
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([ended, new Promise<void>(resolve => { timer = setTimeout(resolve, 90_000); })]);
    clearTimeout(timer);
  } finally {
    client.close();
    await manager.kill();
  }
}

/**
 * The GATEWAY leg: the real adapter in front of a recording chat-completions
 * upstream, which answers its FIRST request with a call to `callName` and every
 * later one with plain text, so the turn ends after the tool result returns.
 */
async function runGatewayTurn(callName: string): Promise<Recorded> {
  const recorded: Recorded = { upstreamBodies: [], fixtureCalls: [], mcpToolCallItems: [], turnCompleted: false, serverRequests: [] };
  const poolServer = await startPool(recorded);
  const adapter = await startAdapter({
    upstream: { kind: 'openai-compatible', baseUrl: 'https://f1-155.invalid/v1' },
    fetchImpl: (async (_url: string | URL | Request, init?: RequestInit) => {
      recorded.upstreamBodies.push(JSON.parse(String(init?.body ?? 'null')));
      if (recorded.upstreamBodies.length === 1) {
        return chatSse([
          { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_f1155', type: 'function', function: { name: callName, arguments: '{}' } }] } }] },
          { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
        ]);
      }
      return chatSse([
        { choices: [{ delta: { content: 'done' } }] },
        { choices: [{ delta: {}, finish_reason: 'stop' }] },
      ]);
    }) as unknown as typeof fetch,
  });
  try {
    await bootAndTurn(poolServer, adapter.port, recorded);
  } finally {
    await adapter.close();
    await poolServer.stop();
  }
  return recorded;
}

/**
 * The RESPONSES wire codex itself emits, before any adapter touches it: the
 * in-tree stub provider records the raw request body and answers with text.
 */
async function captureCodexResponsesTools(): Promise<Array<Record<string, unknown>>> {
  const recorded = { fixtureCalls: [] as string[], mcpToolCallItems: [], serverRequests: [] as string[], turnCompleted: false };
  const bodies: string[] = [];
  const poolServer = await startPool(recorded);
  const stub = await startStubAdapter({ emitToolCall: false, onRequestBody: b => bodies.push(b) });
  try {
    await bootAndTurn(poolServer, stub.port, recorded);
  } finally {
    await stub.close();
    await poolServer.stop();
  }
  const first = bodies[0] ? JSON.parse(bodies[0]) as { tools?: Array<Record<string, unknown>> } : undefined;
  return first?.tools ?? [];
}

function handedToolNames(recorded: Recorded): string[] {
  return (recorded.upstreamBodies[0]?.tools ?? []).map(t => t.function?.name ?? '').filter(Boolean);
}

describe.skipIf(!HAVE_BIN)('F1.155 — the pool tool name a codex model is handed, on the shipped binary', () => {
  /**
   * The failing arm this row was opened on, kept as the NEGATIVE: the
   * docblock's "Codex sees: mcp__sources__…" asserted as written went red
   * (`Expected to contain: "mcp__sources__plugin_cdp-echo-probe_echo__whoami"`,
   * received the flattened list with `plugin_cdp_echo_probe_echo__whoami`).
   */
  test('the gateway model is handed codexModelToolName(), not the host row name, and calling it reaches the pool tool', async () => {
    const expected = codexModelToolName(WIRE, TOOL);
    // Written out once by hand, so the helper cannot pass by agreeing with itself.
    expect(expected).toBe('plugin_cdp_echo_probe_echo__whoami');

    const recorded = await runGatewayTurn(expected);
    const handed = handedToolNames(recorded);
    expect(handed).toContain(expected);
    expect(handed).not.toContain(HOST_ROW_NAME);
    // No spelling of the pool tool carries a prefix on this leg.
    expect(handed.filter(name => name.includes(TOOL))).toEqual([expected]);

    // The name is CALLABLE: the adapter re-attached the namespace, codex routed
    // the call to `[mcp_servers.sources]`, the bridge restored the pool name,
    // and the fixture received its own raw tool name.
    expect(recorded.turnCompleted).toBe(true);
    expect(recorded.serverRequests).toEqual([MCP_ELICITATION_METHOD]);
    expect(recorded.fixtureCalls).toEqual([TOOL]);
    // …and codex reports the call by the RAW pair the host row is built from.
    expect(recorded.mcpToolCallItems).toHaveLength(1);
    expect(recorded.mcpToolCallItems[0]).toMatchObject({ server: 'sources', tool: `${WIRE}__${TOOL}` });
    expect(`mcp__${String(recorded.mcpToolCallItems[0]!.server)}__${String(recorded.mcpToolCallItems[0]!.tool)}`).toBe(HOST_ROW_NAME);
  }, BUDGET_MS);

  test('codex emits the tool under CODEX_POOL_TOOL_NAMESPACE, BESIDE the name, never joined into it', async () => {
    const tools = await captureCodexResponsesTools();
    const namespaces = tools.filter(tool => tool.type === 'namespace');
    const pool = namespaces.find(tool => tool.name === CODEX_POOL_TOOL_NAMESPACE) as
      { tools?: Array<{ name?: string }> } | undefined;
    expect(pool).toBeDefined();
    expect((pool!.tools ?? []).map(tool => tool.name)).toEqual([codexModelToolName(WIRE, TOOL)]);
    // No top-level tool spells the pool tool at all, joined or not.
    const topLevel = tools.filter(tool => tool.type !== 'namespace').map(tool => String(tool.name ?? ''));
    expect(topLevel.filter(name => name.includes(TOOL))).toEqual([]);
  }, BUDGET_MS);
});
