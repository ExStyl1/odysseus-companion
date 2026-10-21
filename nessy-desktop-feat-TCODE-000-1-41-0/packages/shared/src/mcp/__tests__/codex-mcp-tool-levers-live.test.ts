/**
 * F1.370 (measure) + F1.378 (the fix) — on the SHIPPED `codex-app-server`: with
 * `approvals_reviewer = "auto_review"` codex's reviewer answers an MCP tool call
 * before this host is asked, so a host DENY rule on the tool is never consulted;
 * and codex's own per-server levers, `disabled_tools` and
 * `tools.<name>.approval_mode = "prompt"`, which F1.378 projects the user's
 * exact-name `mcp__` deny/ask rules into, do what the source says they do.
 *
 * ## The prediction F1.370 was opened on (source, `rust-v0.154.0`)
 *
 * `core/src/tools/approvals.rs` `Session::request_approval`: "Approval precedence
 * is: 1. Hooks 2. If StrictAutoReview || Guardian enabled, then Guardian. Else,
 * user." This host is the "user" arm — `handleServerRequest`, then
 * `consultPermissionRules` — so with the reviewer on, no host rule runs for the
 * call. Source is the strong tier for codex; this file is the binary's answer.
 *
 * ## The rig — every hop real
 *
 * `codex-model-tool-name-live.test.ts`'s: the real {@link McpPoolServer} with
 * SIT-11's hyphenated fixture, the shipped binary through `CodexRuntimeManager`,
 * a `config.toml` from the REAL `buildCodexConfigToml`, and the real Responses
 * adapter in front of a recording upstream. The upstream answers the turn's
 * FIRST request with a call to the tool, the reviewer's request (recognised by
 * its policy's first line, {@link REVIEWER_POLICY_OPENING}) with
 * `{"outcome":"allow"}`, and anything else with plain text. The app-server's
 * own client (standing in for `CodexAgent`)
 * accepts every MCP tool-call approval it is asked — so a call that reaches the
 * fixture while the client was NEVER asked is a call no host rule saw.
 *
 * Skips where the binary is absent (a gitignored build-time download). No
 * model, no credential, no network beyond loopback.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startAdapter } from '@nessy-agent/codex-responses-adapter';
import {
  buildCodexConfigToml,
  buildCodexExecpolicyRules,
  CODEX_API_KEY_ENV,
  CODEX_POOL_MCP_TOKEN_ENV,
  CODEX_RULES_DIR,
  CODEX_RULES_FILE,
  type CodexConfigOptions,
} from '@nessy-agent/codex-responses-adapter/config-writer';
import { buildApprovalResponse, MCP_ELICITATION_METHOD } from '@nessy-agent/codex-agent-server';
import { AppServerClient } from '@nessy-agent/codex-agent-server/app-server-client';
import { CodexRuntimeManager } from '@nessy-agent/codex-agent-server/runtime-manager';
import { codexModelToolName } from '../../capabilities/mcp-wire-name.ts';
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

/** SIT-11's fixture wire, one write-ish tool and one its server marks read-only. */
const WIRE = 'plugin_cdp-echo-probe_echo';
const WRITE_TOOL = 'whoami';
const READ_ONLY_TOOL = 'status';
/** The pool's own tool names — what codex's per-server levers key on. */
const POOL_WRITE = `${WIRE}__${WRITE_TOOL}`;
const POOL_READ_ONLY = `${WIRE}__${READ_ONLY_TOOL}`;
const MODEL = 'tgpt/qwen35-397b-a17b-fp8';
const BUDGET_MS = 240_000;

/**
 * The reviewer's request, recognised by the first line of codex's bundled
 * guardian policy (`core/assets/guardian/policy_template.md` at `rust-v0.154.0`)
 * — not by the word `outcome`, which ordinary tool descriptions carry too (the
 * session server's did, and a first draft of this rig answered the MAIN turn as
 * if it were the reviewer).
 */
const REVIEWER_POLICY_OPENING = 'You are judging one planned coding-agent action.';

const scratch: string[] = [];
afterAll(() => { for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true }); });

interface Recorded {
  upstreamBodies: Array<{ tools?: Array<{ function?: { name?: string } }> }>;
  /** Every `callTool` the fixture received, by its RAW tool name. */
  fixtureCalls: string[];
  /** Every server→client request method, in order. */
  serverRequests: string[];
  /** Every notification method, in order. */
  notifications: string[];
  /** How many upstream requests carried the reviewer's contract. */
  reviewerRequests: number;
  turnCompleted: boolean;
}

function chatSse(chunks: unknown[]): Response {
  const body = chunks.map(c => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n';
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function text(content: string): Response {
  return chatSse([
    { choices: [{ delta: { content } }] },
    { choices: [{ delta: {}, finish_reason: 'stop' }] },
  ]);
}

async function startPool(recorded: Recorded): Promise<McpPoolServer> {
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
  return poolServer;
}

/**
 * One boot, one thread, one turn in which the model calls `callTool` (a pool
 * tool, by the name a codex model is handed) under `extra` config options.
 */
async function runTurn(
  callTool: string,
  extra: Partial<CodexConfigOptions>,
  call: { args?: Record<string, unknown>; denyPrefixes?: string[][] } = {},
): Promise<Recorded & { workspace: string }> {
  const recorded: Recorded = {
    upstreamBodies: [], fixtureCalls: [], serverRequests: [], notifications: [], reviewerRequests: 0, turnCompleted: false,
  };
  const poolServer = await startPool(recorded);
  let mainRequests = 0;
  const adapter = await startAdapter({
    upstream: { kind: 'openai-compatible', baseUrl: 'https://f1-378.invalid/v1' },
    fetchImpl: (async (_url: string | URL | Request, init?: RequestInit) => {
      const raw = String(init?.body ?? 'null');
      if (raw.includes(REVIEWER_POLICY_OPENING)) {
        recorded.reviewerRequests += 1;
        return text('{"outcome":"allow","risk_level":"low","rationale":"fixture"}');
      }
      recorded.upstreamBodies.push(JSON.parse(raw));
      mainRequests += 1;
      if (mainRequests === 1) {
        return chatSse([
          { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_f1378', type: 'function', function: { name: callTool, arguments: JSON.stringify(call.args ?? {}) } }] } }] },
          { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
        ]);
      }
      return text('done');
    }) as unknown as typeof fetch,
  });
  const home = mkdtempSync(join(tmpdir(), 'f1378-home-'));
  const workspace = mkdtempSync(join(tmpdir(), 'f1378-ws-'));
  scratch.push(home, workspace);
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, 'config.toml'), buildCodexConfigToml({
    codexHome: home,
    model: MODEL,
    adapterPort: adapter.port,
    mode: 'default',
    sandboxGloballyEnabled: false,
    poolMcpUrl: poolServer.url,
    ...extra,
  }));
  // F1.387's control: a bash deny prefix, projected the way `writeCodexConfig`
  // projects it (P2.141b, `decision="forbidden"` in `rules/nessy.rules`).
  if (call.denyPrefixes) {
    mkdirSync(join(home, CODEX_RULES_DIR), { recursive: true });
    writeFileSync(join(home, CODEX_RULES_DIR, CODEX_RULES_FILE), buildCodexExecpolicyRules([], call.denyPrefixes));
  }
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
        recorded.notifications.push(method);
        if (method === 'turn/completed') { recorded.turnCompleted = true; wake?.(); }
      },
      // The product's own ALLOW for every MCP tool-call approval — so a call the
      // fixture never receives was refused by codex itself, not by this client.
      onServerRequest: ({ method, params }) => {
        recorded.serverRequests.push(method);
        return method === MCP_ELICITATION_METHOD
          ? buildApprovalResponse('elicitation', params, true)
          : { decision: 'decline' };
      },
    });
    try {
      await client.request('initialize', {
        clientInfo: { name: 'nessy-f1378', title: null, version: '0.0.0' },
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
  return { ...recorded, workspace };
}

const handed = (recorded: Recorded): string[] =>
  (recorded.upstreamBodies[0]?.tools ?? []).map(t => t.function?.name ?? '').filter(Boolean);

const WRITE_MODEL_NAME = codexModelToolName(WIRE, WRITE_TOOL);
const READ_ONLY_MODEL_NAME = codexModelToolName(WIRE, READ_ONLY_TOOL);

describe.skipIf(!HAVE_BIN)('F1.370 — with auto-review on, codex\'s reviewer answers an MCP call before this host is asked', () => {
  test('CONTROL (auto-review off): the host IS asked, and the call runs on its allow', async () => {
    const recorded = await runTurn(WRITE_MODEL_NAME, {});
    expect(recorded.turnCompleted).toBe(true);
    expect(recorded.serverRequests).toEqual([MCP_ELICITATION_METHOD]);
    expect(recorded.fixtureCalls).toEqual([WRITE_TOOL]);
    expect(recorded.reviewerRequests).toBe(0);
  }, BUDGET_MS);

  test('auto-review on: the call RUNS on the reviewer\'s allow and this host is never asked — a host deny rule is consulted nowhere', async () => {
    const recorded = await runTurn(WRITE_MODEL_NAME, { approvalsReviewer: 'auto_review' });
    expect(recorded.turnCompleted).toBe(true);
    expect(recorded.reviewerRequests).toBeGreaterThan(0);
    expect(recorded.notifications).toContain('item/autoApprovalReview/started');
    expect(recorded.serverRequests).not.toContain(MCP_ELICITATION_METHOD);
    expect(recorded.fixtureCalls).toEqual([WRITE_TOOL]);
  }, BUDGET_MS);
});

describe.skipIf(!HAVE_BIN)('F1.378 — codex\'s own levers hold where the host is not asked', () => {
  test('disabled_tools (a deny rule) removes the tool: not handed to the model, never reaches the fixture, reviewer on', async () => {
    const recorded = await runTurn(WRITE_MODEL_NAME, {
      approvalsReviewer: 'auto_review',
      mcpToolLevers: { sources: { disabledTools: [POOL_WRITE] } },
    });
    expect(handed(recorded)).not.toContain(WRITE_MODEL_NAME);
    // Positive control on the same boot: the sibling tool is still handed.
    expect(handed(recorded)).toContain(READ_ONLY_MODEL_NAME);
    expect(recorded.fixtureCalls).toEqual([]);
  }, BUDGET_MS);

  test('CONTROL: a tool its server marks read-only runs with NO approval at all — no rule is consulted', async () => {
    const recorded = await runTurn(READ_ONLY_MODEL_NAME, {});
    expect(recorded.turnCompleted).toBe(true);
    expect(recorded.serverRequests).toEqual([]);
    expect(recorded.fixtureCalls).toEqual([READ_ONLY_TOOL]);
  }, BUDGET_MS);

  test('approval_mode = "prompt" (an ask rule) makes codex ask this host about that same read-only tool', async () => {
    const recorded = await runTurn(READ_ONLY_MODEL_NAME, {
      mcpToolLevers: { sources: { promptTools: [POOL_READ_ONLY] } },
    });
    expect(recorded.turnCompleted).toBe(true);
    expect(recorded.serverRequests).toEqual([MCP_ELICITATION_METHOD]);
    expect(recorded.fixtureCalls).toEqual([READ_ONLY_TOOL]);
  }, BUDGET_MS);
});

describe.skipIf(!HAVE_BIN)('F1.387 CONTROL — the native half that survives the reviewer: a bash deny prefix', () => {
  test('without the rule, auto-review on: the command runs (no sandbox, nothing to ask about)', async () => {
    const recorded = await runTurn('exec_command', { approvalsReviewer: 'auto_review' }, { args: { cmd: 'touch F1387_MARKER' } });
    expect(recorded.turnCompleted).toBe(true);
    expect(existsSync(join(recorded.workspace, 'F1387_MARKER'))).toBe(true);
  }, BUDGET_MS);

  test('with deny ["touch"] projected as decision="forbidden": refused before any approval — no reviewer, no host', async () => {
    const recorded = await runTurn('exec_command', { approvalsReviewer: 'auto_review' }, {
      args: { cmd: 'touch F1387_MARKER' },
      denyPrefixes: [['touch']],
    });
    expect(recorded.turnCompleted).toBe(true);
    expect(existsSync(join(recorded.workspace, 'F1387_MARKER'))).toBe(false);
    expect(recorded.reviewerRequests).toBe(0);
    expect(recorded.serverRequests).toEqual([]);
  }, BUDGET_MS);
});
