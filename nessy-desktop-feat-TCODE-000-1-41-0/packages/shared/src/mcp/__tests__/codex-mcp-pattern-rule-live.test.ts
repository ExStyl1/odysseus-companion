/**
 * F1.482 (2) — the row's CONTROL on the SHIPPED `codex-app-server`: a WHOLE-SERVER
 * deny (`mcp__<server>`) over a tool its server marks `readOnlyHint`, with codex
 * auto-review on. codex asks nothing for such a tool and its reviewer answers
 * before this host would be asked, so before F1.482 the rule was consulted
 * nowhere and the call ran. Now the rule is enumerated over the pool's own
 * catalogue (`projectCodexMcpPermissionRules` with the names the pool lists) into
 * `[mcp_servers.sources] disabled_tools`, which the binary honours.
 *
 * The rig is `codex-mcp-tool-levers-live.test.ts`'s (F1.378), trimmed to one
 * turn per arm: the real {@link McpPoolServer} over SIT-11's fixture, the
 * shipped binary through `CodexRuntimeManager`, a `config.toml` from the REAL
 * `buildCodexConfigToml` (with the credential `deniedReadPaths` every real
 * session passes, so the permission profile is the product's), and the real
 * Responses adapter in front of a recording upstream whose FIRST main request
 * calls the read-only tool and whose reviewer requests are answered `allow`.
 * The catalogue is read off the SAME pool the server answers `tools/list` from.
 *
 * Skips where the binary is absent. No model, no credential, loopback only.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startAdapter } from '@nessy-agent/codex-responses-adapter';
import {
  buildCodexConfigToml,
  CODEX_API_KEY_ENV,
  CODEX_POOL_MCP_TOKEN_ENV,
  type CodexConfigOptions,
} from '@nessy-agent/codex-responses-adapter/config-writer';
import { buildApprovalResponse, MCP_ELICITATION_METHOD } from '@nessy-agent/codex-agent-server';
import { AppServerClient } from '@nessy-agent/codex-agent-server/app-server-client';
import { CodexRuntimeManager } from '@nessy-agent/codex-agent-server/runtime-manager';
import { codexModelToolName } from '../../capabilities/mcp-wire-name.ts';
import { projectCodexMcpPermissionRules } from '../../agent/codex-permission-rule-support.ts';
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

const WIRE = 'plugin_cdp-echo-probe_echo';
const WRITE_TOOL = 'whoami';
const READ_ONLY_TOOL = 'status';
const MODEL = 'tgpt/qwen35-397b-a17b-fp8';
const BUDGET_MS = 240_000;
/** The first line of codex's bundled guardian policy — how the reviewer's request is told from the main turn. */
const REVIEWER_POLICY_OPENING = 'You are judging one planned coding-agent action.';
/** The rule under test, as the DSL compiles `mcp__plugin_cdp-echo-probe_echo`. */
const WHOLE_SERVER_DENY = {
  rules: [{ id: 'whole-server', action: 'deny', text: `mcp__${WIRE}`, matcher: { kind: 'mcp', server: WIRE } }],
};

const scratch: string[] = [];
afterAll(() => { for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true }); });

interface Recorded {
  handed: string[];
  fixtureCalls: string[];
  serverRequests: string[];
  reviewerRequests: number;
  turnCompleted: boolean;
}

function chatSse(chunks: unknown[]): Response {
  const body = chunks.map(c => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n';
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}
const text = (content: string) => chatSse([
  { choices: [{ delta: { content } }] },
  { choices: [{ delta: {}, finish_reason: 'stop' }] },
]);

/**
 * One boot, one turn in which the model calls the READ-ONLY tool, auto-review
 * on; `levers` is handed the pool's own catalogue and returns the config's
 * `mcpToolLevers` (or nothing, for the control).
 */
async function runTurn(
  levers: (catalogue: string[]) => CodexConfigOptions['mcpToolLevers'] | undefined,
): Promise<Recorded> {
  const recorded: Recorded = { handed: [], fixtureCalls: [], serverRequests: [], reviewerRequests: 0, turnCompleted: false };
  const pool = new McpClientPool();
  await registerFixtureClient(pool, WIRE, {
    async listTools() {
      return [
        { name: WRITE_TOOL, description: 'Answers who it is.', inputSchema: { type: 'object', properties: {} } },
        {
          name: READ_ONLY_TOOL,
          description: 'Reports a status.',
          inputSchema: { type: 'object', properties: {} },
          annotations: { readOnlyHint: true },
        },
      ];
    },
    async callTool(name: string) {
      recorded.fixtureCalls.push(name);
      return { content: [{ type: 'text', text: `FIXTURE-${name.toUpperCase()}` }], isError: false };
    },
    async close() {},
  } as unknown as PoolClient);
  const poolServer = new McpPoolServer(pool);
  await poolServer.start();
  // The catalogue, read off the same pool the server answers `tools/list` from.
  const mcpToolLevers = levers(pool.getProxyToolDefs().map(def => def.name));
  let mainRequests = 0;
  const adapter = await startAdapter({
    upstream: { kind: 'openai-compatible', baseUrl: 'https://f1-482.invalid/v1' },
    fetchImpl: (async (_url: string | URL | Request, init?: RequestInit) => {
      const raw = String(init?.body ?? 'null');
      if (raw.includes(REVIEWER_POLICY_OPENING)) {
        recorded.reviewerRequests += 1;
        return text('{"outcome":"allow","risk_level":"low","rationale":"fixture"}');
      }
      const body = JSON.parse(raw) as { tools?: Array<{ function?: { name?: string } }> };
      mainRequests += 1;
      if (mainRequests === 1) {
        recorded.handed = (body.tools ?? []).map(t => t.function?.name ?? '').filter(Boolean);
        return chatSse([
          { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_f1482', type: 'function', function: { name: codexModelToolName(WIRE, READ_ONLY_TOOL), arguments: '{}' } }] } }] },
          { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
        ]);
      }
      return text('done');
    }) as unknown as typeof fetch,
  });
  const home = mkdtempSync(join(tmpdir(), 'f1482-home-'));
  const workspace = mkdtempSync(join(tmpdir(), 'f1482-ws-'));
  scratch.push(home, workspace);
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, 'config.toml'), buildCodexConfigToml({
    codexHome: home,
    model: MODEL,
    adapterPort: adapter.port,
    mode: 'default',
    sandboxGloballyEnabled: false,
    poolMcpUrl: poolServer.url,
    approvalsReviewer: 'auto_review',
    deniedReadPaths: [join(home, 'credentials.enc')],
    ...(mcpToolLevers ? { mcpToolLevers } : {}),
  }));
  const manager = new CodexRuntimeManager();
  try {
    const child = manager.spawn({
      binaryPath: BUNDLED_CODEX,
      cwd: workspace,
      codexHome: home,
      env: { [CODEX_API_KEY_ENV]: 'loopback', [CODEX_POOL_MCP_TOKEN_ENV]: poolServer.bearerToken },
      platformDir: PLATFORM_DIR,
    });
    let wake: (() => void) | null = null;
    const client = new AppServerClient(child, {
      onNotification: (method) => {
        if (method === 'turn/completed') { recorded.turnCompleted = true; wake?.(); }
      },
      // The product's own ALLOW for every MCP tool-call approval — so a call the
      // fixture never receives was refused by codex itself.
      onServerRequest: ({ method, params }) => {
        recorded.serverRequests.push(method);
        return method === MCP_ELICITATION_METHOD ? buildApprovalResponse('elicitation', params, true) : { decision: 'decline' };
      },
    });
    try {
      await client.request('initialize', {
        clientInfo: { name: 'nessy-f1482', title: null, version: '0.0.0' },
        capabilities: { experimentalApi: true, requestAttestation: false },
      }, { timeoutMs: 60_000 });
      client.notify('initialized');
      const started = await client.request('thread/start', { cwd: workspace, model: MODEL }, { timeoutMs: 60_000 }) as {
        thread?: { id?: string };
      };
      const ended = new Promise<void>(resolve => { wake = resolve; });
      await client.request('turn/start', {
        threadId: started.thread?.id, input: [{ type: 'text', text: 'check the status', text_elements: [] }],
      }, { timeoutMs: 60_000 });
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([ended, new Promise<void>(resolve => { timer = setTimeout(resolve, 120_000); })]);
      clearTimeout(timer);
    } finally {
      client.close();
    }
  } finally {
    await manager.kill();
    await adapter.close();
    await poolServer.stop();
  }
  return recorded;
}

describe.skipIf(!HAVE_BIN)('F1.482 (2) — a whole-server deny over a read-only tool, codex auto-review on', () => {
  test('CONTROL (the rule not projected): the read-only tool is handed and RUNS — no host request, no rule consulted', async () => {
    const recorded = await runTurn(() => undefined);
    expect(recorded.turnCompleted).toBe(true);
    expect(recorded.handed).toContain(codexModelToolName(WIRE, READ_ONLY_TOOL));
    expect(recorded.serverRequests).not.toContain(MCP_ELICITATION_METHOD);
    expect(recorded.fixtureCalls).toEqual([READ_ONLY_TOOL]);
  }, BUDGET_MS);

  test('enumerated over the pool\'s catalogue: neither tool of the server is handed, and the call never reaches it', async () => {
    let carried: string[] = [];
    const recorded = await runTurn((catalogue) => {
      const projection = projectCodexMcpPermissionRules(WHOLE_SERVER_DENY, { session: [], sources: catalogue });
      carried = [...projection.sources.disabledTools];
      return { sources: projection.sources };
    });
    expect(carried).toEqual([`${WIRE}__${WRITE_TOOL}`, `${WIRE}__${READ_ONLY_TOOL}`]);
    expect(recorded.handed).not.toContain(codexModelToolName(WIRE, READ_ONLY_TOOL));
    expect(recorded.handed).not.toContain(codexModelToolName(WIRE, WRITE_TOOL));
    expect(recorded.fixtureCalls).toEqual([]);
  }, BUDGET_MS);
});
