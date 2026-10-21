/**
 * F1.219 (origin WJ-v P-WJ-v-3) — which spelling of a pool tool codex's OWN
 * hooks match, measured on the shipped binary rather than read off the source.
 *
 * ## The question
 *
 * The host row, our rules and every host-side hook name a pool tool by codex's
 * RAW `(server, tool)` pair: `mcp__sources__plugin_cdp-echo-probe_echo__whoami`,
 * hyphens and all. The source at `openai/codex@rust-v0.154.0` says codex's own
 * hook path names it differently — `hook_tool_name` joins the SANITIZED callable
 * namespace and name (`core/src/tools/handlers/mcp.rs`) — so a matcher copied
 * from a host row would never fire there. Source is strong for codex; this file
 * is the binary's answer.
 *
 * ## The rig — every hop real
 *
 * The real pool server with SIT-11's hyphenated fixture tool, the shipped
 * `codex-app-server` through `CodexRuntimeManager`, a `config.toml` from the
 * REAL `buildCodexConfigToml` carrying a `[hooks]` table minted through the ONE
 * door (`mintHostAuthoredCodexHooks`) and trusted by the two-pass `hooks/list`
 * protocol `codex-hook-exit-contract-live.test.ts` established, and the real
 * Responses adapter in front of a recording upstream that makes one call. Three
 * `PreToolUse` groups, each writing the hook's stdin to its own marker: the host
 * spelling, {@link codexHookToolName}'s spelling, and `mcp__.*` as the positive
 * control that proves the hook path ran at all.
 *
 * ## What it means for the product, stated
 *
 * Nothing is projected into codex's `[hooks]` today (P2.414 — `CodexAgent`'s
 * hook projection mints none), so no user or plugin matcher meets this path:
 * they run host-side and see the host row. The measurement is the translation
 * the first projecting lane owes, and `codexHookToolName` is where it lives.
 *
 * Skips where the binary is absent (a gitignored build-time download).
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startAdapter } from '@nessy-agent/codex-responses-adapter';
import {
  buildCodexConfigToml,
  CODEX_API_KEY_ENV,
  CODEX_POOL_MCP_TOKEN_ENV,
  mintHostAuthoredCodexHooks,
} from '@nessy-agent/codex-responses-adapter/config-writer';
import { buildApprovalResponse, MCP_ELICITATION_METHOD } from '@nessy-agent/codex-agent-server';
import { AppServerClient } from '@nessy-agent/codex-agent-server/app-server-client';
import { CodexRuntimeManager } from '@nessy-agent/codex-agent-server/runtime-manager';
import { codexHookToolName, codexModelToolName } from '../../capabilities/mcp-wire-name.ts';
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
const HAVE_BIN = existsSync(BUNDLED_CODEX) && process.platform !== 'win32';

const WIRE = 'plugin_cdp-echo-probe_echo';
const TOOL = 'whoami';
/** The host row's spelling — what a rule, a host hook and the UI read. */
const HOST_ROW_NAME = `mcp__sources__${WIRE}__${TOOL}`;
const MODEL = 'tgpt/qwen35-397b-a17b-fp8';
const BUDGET_MS = 180_000;

const scratch: string[] = [];
afterAll(() => { for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function chatSse(chunks: unknown[]): Response {
  const body = chunks.map(c => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n';
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

type Notification = { method: string; params: Record<string, any> };

/** One boot of the shipped binary on `toml`; `run` drives it. */
async function boot(
  toml: string, home: string, workspace: string, poolServer: McpPoolServer,
  run: (client: AppServerClient, notes: Notification[]) => Promise<void>,
): Promise<void> {
  writeFileSync(join(home, 'config.toml'), toml);
  const manager = new CodexRuntimeManager();
  const child = manager.spawn({
    binaryPath: BUNDLED_CODEX,
    cwd: workspace,
    codexHome: home,
    env: { [CODEX_API_KEY_ENV]: 'loopback', [CODEX_POOL_MCP_TOKEN_ENV]: poolServer.bearerToken },
    platformDir: PLATFORM_DIR,
  });
  const notes: Notification[] = [];
  const client = new AppServerClient(child, {
    onNotification: (method, params) => { notes.push({ method, params: (params ?? {}) as Record<string, any> }); },
    // The tool call's own approval (F1.218) is answered with the product's allow.
    onServerRequest: ({ method, params }) => method === MCP_ELICITATION_METHOD
      ? buildApprovalResponse('elicitation', params, true)
      : { decision: 'decline' },
  });
  try {
    await client.request('initialize', {
      clientInfo: { name: 'nessy-f1219', title: null, version: '0.0.0' },
      capabilities: { experimentalApi: true, requestAttestation: false },
    }, { timeoutMs: 60_000 });
    client.notify('initialized');
    await run(client, notes);
  } finally {
    client.close();
    await manager.kill();
  }
}

describe.skipIf(!HAVE_BIN)('F1.219 — codex native hooks match the SANITIZED pool tool name, on the shipped binary', () => {
  test('a host-spelled matcher does not fire, the codexHookToolName one does, and the payload names the sanitized tool', async () => {
    // Written out once by hand, so the helper cannot pass by agreeing with itself.
    expect(codexHookToolName(WIRE, TOOL)).toBe('mcp__sources__plugin_cdp_echo_probe_echo__whoami');

    const home = mkdtempSync(join(tmpdir(), 'f1219-home-'));
    const workspace = mkdtempSync(join(tmpdir(), 'f1219-ws-'));
    scratch.push(home, workspace);
    mkdirSync(home, { recursive: true });
    const marker = {
      host: join(home, 'host-spelling.json'),
      hook: join(home, 'hook-spelling.json'),
      control: join(home, 'any-mcp.json'),
    };
    const hooks = (state?: Record<string, string>) => mintHostAuthoredCodexHooks(
      { origin: 'f1219NativeMatcherRig', revocation: { kind: 'next-runtime-build' } },
      {
        PreToolUse: [
          { matcher: HOST_ROW_NAME, hooks: [{ command: `sh -c 'cat > ${marker.host}'`, timeoutSec: 10 }] },
          { matcher: codexHookToolName(WIRE, TOOL), hooks: [{ command: `sh -c 'cat > ${marker.hook}'`, timeoutSec: 10 }] },
          { matcher: 'mcp__.*', hooks: [{ command: `sh -c 'cat > ${marker.control}'`, timeoutSec: 10 }] },
        ],
        ...(state ? { state } : {}),
      },
    );

    const pool = new McpClientPool();
    await registerFixtureClient(pool, WIRE, {
      async listTools() { return [{ name: TOOL, description: 'Answers who it is.', inputSchema: { type: 'object', properties: {} } }]; },
      async callTool() { return { content: [{ type: 'text', text: 'FIXTURE-WHOAMI' }], isError: false }; },
      async close() {},
    } as unknown as PoolClient);
    const poolServer = new McpPoolServer(pool);
    await poolServer.start();
    let upstreamCalls = 0;
    const adapter = await startAdapter({
      upstream: { kind: 'openai-compatible', baseUrl: 'https://f1-219.invalid/v1' },
      fetchImpl: (async () => {
        upstreamCalls += 1;
        return upstreamCalls === 1
          ? chatSse([
            { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_f1219', type: 'function', function: { name: codexModelToolName(WIRE, TOOL), arguments: '{}' } }] } }] },
            { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
          ])
          : chatSse([{ choices: [{ delta: { content: 'done' } }] }, { choices: [{ delta: {}, finish_reason: 'stop' }] }]);
      }) as unknown as typeof fetch,
    });
    const config = (state?: Record<string, string>) => buildCodexConfigToml({
      codexHome: home,
      model: MODEL,
      adapterPort: adapter.port,
      mode: 'bypassPermissions',
      sandboxGloballyEnabled: false,
      poolMcpUrl: poolServer.url,
      hooks: hooks(state),
    });

    let listedMatchers: string[] = [];
    let turnCompleted = false;
    let hookRuns: Array<{ event?: string; status?: string }> = [];
    try {
      // Pass one: the trust key and hash are the BINARY's, published by `hooks/list`.
      let state: Record<string, string> = {};
      await boot(config(), home, workspace, poolServer, async (client) => {
        const listed = await client.request('hooks/list', { cwds: [workspace] }, { timeoutMs: 60_000 }) as {
          data?: Array<{ hooks?: Array<{ key: string; currentHash: string; matcher?: string }> }>;
        };
        const entries = listed.data?.[0]?.hooks ?? [];
        listedMatchers = entries.map(entry => entry.matcher ?? '');
        state = Object.fromEntries(entries.map(entry => [entry.key, entry.currentHash]));
      });
      // Pass two: the same table, trusted, and one turn that calls the pool tool.
      await boot(config(state), home, workspace, poolServer, async (client, notes) => {
        const started = await client.request('thread/start', { cwd: workspace, model: MODEL }, { timeoutMs: 60_000 }) as {
          thread?: { id?: string };
        };
        await client.request('turn/start', {
          threadId: started.thread?.id, input: [{ type: 'text', text: 'call the probe', text_elements: [] }],
        }, { timeoutMs: 60_000 });
        const deadline = Date.now() + 90_000;
        while (Date.now() < deadline && !notes.some(n => n.method === 'turn/completed')) {
          await new Promise(resolve => setTimeout(resolve, 200));
        }
        turnCompleted = notes.some(n => n.method === 'turn/completed');
        hookRuns = notes.filter(n => n.method === 'hook/completed')
          .map(n => ({ event: n.params.run?.eventName, status: n.params.run?.status }));
      });
    } finally {
      await adapter.close();
      await poolServer.stop();
    }

    // All three groups reached the binary, host spelling included — so an absent
    // marker below is a matcher that did not match, not a group that was dropped.
    expect(listedMatchers).toEqual([HOST_ROW_NAME, codexHookToolName(WIRE, TOOL), 'mcp__.*']);
    expect(turnCompleted).toBe(true);
    // CONTROL: the hook path ran for this call.
    expect(existsSync(marker.control)).toBe(true);
    expect(hookRuns.filter(run => run.event === 'preToolUse')).toEqual([
      { event: 'preToolUse', status: 'completed' },
      { event: 'preToolUse', status: 'completed' },
    ]);
    // The finding: the host spelling never fires on codex's own hook path…
    expect(existsSync(marker.host)).toBe(false);
    // …the sanitized spelling does, and the payload says why.
    expect(existsSync(marker.hook)).toBe(true);
    const payload = JSON.parse(readFileSync(marker.hook, 'utf8')) as { tool_name?: string; hook_event_name?: string };
    expect(payload.hook_event_name).toBe('PreToolUse');
    expect(payload.tool_name).toBe(codexHookToolName(WIRE, TOOL));
  }, BUDGET_MS);
});
