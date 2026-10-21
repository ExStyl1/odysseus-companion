/**
 * F1.386 — on the SHIPPED `codex-app-server`, with `approvals_reviewer =
 * "auto_review"`: the host-authored `PermissionRequest` hook refuses a FLOORED
 * automation edit before codex's reviewer is asked, and leaves every other call
 * to the reviewer.
 *
 * ## The rig — every hop real
 *
 * The shipped binary through `CodexRuntimeManager`; a `config.toml` from the
 * REAL `buildCodexConfigToml` with the REAL session MCP server
 * (`packages/session-mcp-server/src/index.ts`, run by this bun) as
 * `[mcp_servers.session]`; the hook plan minted by the builder
 * `CodexAgent.unattendedAutomationFloorHookProjection` calls
 * ({@link codexAutomationFloorHookPlan}) and trusted by the REAL one-boot trust
 * pass ({@link trustCodexHostAuthoredHooks}: `hooks/list`, then
 * `config/batchWrite` of `hooks.state` with `reloadUserConfig`); the real
 * Responses adapter in front of a recording upstream that makes ONE call to the
 * session's `automation_update` and answers the reviewer's request (recognised
 * by its policy's first line) with `{"outcome":"allow"}`.
 *
 * So a refused edit is refused by the hook alone: the reviewer would have
 * allowed it, and the client (standing in for `CodexAgent`) is never asked.
 *
 * Skips where the binary is absent (a gitignored build-time download) or on
 * Windows (the hook runs through `$SHELL -lc`).
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startAdapter } from '@nessy-agent/codex-responses-adapter';
import { buildCodexConfigToml, CODEX_API_KEY_ENV } from '@nessy-agent/codex-responses-adapter/config-writer';
import { MCP_ELICITATION_METHOD } from '@nessy-agent/codex-agent-server';
import { AppServerClient } from '@nessy-agent/codex-agent-server/app-server-client';
import { CodexRuntimeManager } from '@nessy-agent/codex-agent-server/runtime-manager';
import {
  codexAutomationFloorHookCommand,
  codexAutomationFloorHookPlan,
  trustCodexHostAuthoredHooks,
} from '../../agent/backend/codex/automation-floor-hook.ts';

const PLATFORM_DIR = `${process.platform}-${process.arch}`;
const REPO = join(import.meta.dir, '..', '..', '..', '..', '..');
const BUNDLED_CODEX = join(REPO, 'apps', 'electron', 'resources', 'bin', 'codex', PLATFORM_DIR,
  process.platform === 'win32' ? 'codex-app-server.exe' : 'codex-app-server');
const SESSION_SERVER = join(REPO, 'packages', 'session-mcp-server', 'src', 'index.ts');
const HAVE_BIN = existsSync(BUNDLED_CODEX) && process.platform !== 'win32';
const MODEL = 'tgpt/qwen35-397b-a17b-fp8';
const BUDGET_MS = 600_000;

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

const AUTOMATIONS = {
  version: 2,
  automations: {
    SchedulerTick: [
      { id: 'dormant-bypass', name: 'Weekly purge', cron: '0 5 * * 0', permissionMode: 'bypassPermissions', enabled: false, actions: [{ type: 'prompt', prompt: 'old' }] },
    ],
  },
};

interface Recorded {
  handedTools: string[];
  serverRequests: string[];
  notifications: Array<{ method: string; params: Record<string, unknown> }>;
  reviewerRequests: number;
  turnCompleted: boolean;
  trusted: number;
  automationsAfter: unknown;
}

function chatSse(chunks: unknown[]): Response {
  const body = chunks.map(c => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n';
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}
const text = (content: string) => chatSse([
  { choices: [{ delta: { content } }] },
  { choices: [{ delta: {}, finish_reason: 'stop' }] },
]);

/** One boot, one thread, one turn that calls `automation_update` with `patch`. */
async function runTurn(patch: Record<string, unknown>, withHook: boolean): Promise<Recorded> {
  const recorded: Recorded = {
    handedTools: [], serverRequests: [], notifications: [], reviewerRequests: 0, turnCompleted: false, trusted: 0, automationsAfter: null,
  };
  const home = mkdtempSync(join(tmpdir(), 'f1386-home-'));
  const workspace = mkdtempSync(join(tmpdir(), 'f1386-ws-'));
  const configDir = mkdtempSync(join(tmpdir(), 'f1386-cfg-'));
  scratch.push(home, workspace, configDir);
  mkdirSync(join(workspace, 'plans'), { recursive: true });
  writeFileSync(join(workspace, 'automations.json'), JSON.stringify(AUTOMATIONS));

  let mainRequests = 0;
  const adapter = await startAdapter({
    upstream: { kind: 'openai-compatible', baseUrl: 'https://f1-386.invalid/v1' },
    fetchImpl: (async (_url: string | URL | Request, init?: RequestInit) => {
      const raw = String(init?.body ?? 'null');
      if (raw.includes(REVIEWER_POLICY_OPENING)) {
        recorded.reviewerRequests += 1;
        return text('{"outcome":"allow","risk_level":"low","rationale":"fixture"}');
      }
      const body = JSON.parse(raw) as { tools?: Array<{ function?: { name?: string } }> };
      mainRequests += 1;
      if (mainRequests === 1) {
        recorded.handedTools = (body.tools ?? []).map(t => t.function?.name ?? '').filter(Boolean);
        const name = recorded.handedTools.find(n => n.endsWith('automation_update')) ?? 'automation_update';
        return chatSse([
          { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_f1386', type: 'function', function: { name, arguments: JSON.stringify({ automationId: 'dormant-bypass', patch }) } }] } }] },
          { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
        ]);
      }
      return text('done');
    }) as unknown as typeof fetch,
  });

  const sessionMcp = {
    command: process.execPath,
    args: [SESSION_SERVER, '--session-id', 'f1386', '--workspace-root', workspace,
      '--plans-folder', join(workspace, 'plans'), '--config-root', configDir, '--external-standalone-only'],
    env: { NESSY_CONFIG_DIR: configDir },
  };
  // The hook runs the SOURCE entry point here (the product runs the bundled
  // `dist/index.js`), whose module graph costs minutes cold on this rig
  // (127 s measured 2026-09-24, `user 0.59`: I/O, not compute) — so the rig,
  // not the product, widens the two deadlines.
  const hooks = withHook ? codexAutomationFloorHookPlan(sessionMcp.command, SESSION_SERVER, workspace, 240) : undefined;
  const toml = buildCodexConfigToml({
    codexHome: home,
    model: MODEL,
    adapterPort: adapter.port,
    mode: 'default',
    sandboxGloballyEnabled: false,
    approvalsReviewer: 'auto_review',
    sessionMcp,
    ...(hooks ? { hooks } : {}),
  });
  // `startup_timeout_sec` is a key of the `[mcp_servers.session]` table the
  // writer deliberately leaves unwritten (P6.548), inserted by the rig right
  // after that table's `args` line so it lands in the right table.
  const argsLine = toml.split('\n').find(line => line.startsWith('args = [') && line.includes(SESSION_SERVER));
  if (!argsLine) throw new Error('rig: no [mcp_servers.session] args line');
  writeFileSync(join(home, 'config.toml'), toml.replace(argsLine, `${argsLine}\nstartup_timeout_sec = 600`));

  const manager = new CodexRuntimeManager();
  try {
    const child = manager.spawn({
      binaryPath: BUNDLED_CODEX, cwd: workspace, codexHome: home,
      env: { [CODEX_API_KEY_ENV]: 'loopback' }, platformDir: PLATFORM_DIR,
    });
    let wake: (() => void) | null = null;
    const client = new AppServerClient(child, {
      onNotification: (method, params) => {
        recorded.notifications.push({ method, params: (params ?? {}) as Record<string, unknown> });
        if (method === 'turn/completed') { recorded.turnCompleted = true; wake?.(); }
      },
      onServerRequest: ({ method }) => {
        recorded.serverRequests.push(method);
        return method === MCP_ELICITATION_METHOD ? { action: 'decline', content: null } : { decision: 'decline' };
      },
    });
    try {
      await client.request('initialize', {
        clientInfo: { name: 'nessy-f1386', title: null, version: '0.0.0' },
        capabilities: { experimentalApi: true, requestAttestation: false },
      }, { timeoutMs: 60_000 });
      client.notify('initialized');
      if (withHook) {
        recorded.trusted = await trustCodexHostAuthoredHooks(
          client, workspace, [codexAutomationFloorHookCommand(sessionMcp.command, SESSION_SERVER, workspace)], () => {});
      }
      const started = await client.request('thread/start', { cwd: workspace, model: MODEL }, { timeoutMs: 60_000 }) as {
        thread?: { id?: string };
      };
      // The session server runs from SOURCE here and its module graph costs
      // minutes cold on this rig, while codex sends the first model request as
      // soon as the turn starts — so the rig waits for codex's own startup
      // verdict on `session` before starting the turn, and fails loudly on
      // `failed` rather than measuring a tool list that is still loading.
      const deadline = Date.now() + 300_000;
      let startup: Record<string, unknown> | undefined;
      while (Date.now() < deadline) {
        startup = recorded.notifications.find(n => n.method === 'mcpServer/startupStatus/updated'
          && n.params.name === 'session' && (n.params.status === 'ready' || n.params.status === 'failed'))?.params;
        if (startup) break;
        await new Promise(resolve => setTimeout(resolve, 250));
      }
      if (startup?.status !== 'ready') throw new Error(`rig: the session MCP server did not start: ${JSON.stringify(startup ?? null)}`);
      const ended = new Promise<void>(resolve => { wake = resolve; });
      await client.request('turn/start', {
        threadId: started.thread?.id, input: [{ type: 'text', text: 'update the automation', text_elements: [] }],
      }, { timeoutMs: 60_000 });
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([ended, new Promise<void>(resolve => { timer = setTimeout(resolve, 180_000); })]);
      clearTimeout(timer);
    } finally {
      client.close();
    }
  } finally {
    await manager.kill();
    await adapter.close();
  }
  recorded.automationsAfter = JSON.parse(readFileSync(join(workspace, 'automations.json'), 'utf-8'));
  return recorded;
}

const stored = (recorded: Recorded) =>
  ((recorded.automationsAfter as typeof AUTOMATIONS).automations.SchedulerTick[0]) as Record<string, unknown>;

describe.skipIf(!HAVE_BIN)('F1.386 — the unattended-automation floor fails closed under auto-review, on the shipped binary', () => {
  test('CONTROL (no hook): the reviewer allows re-enabling a bypass-mode automation, and the edit LANDS', async () => {
    const recorded = await runTurn({ enabled: true }, false);
    expect(recorded.turnCompleted).toBe(true);
    expect(recorded.handedTools.some(name => name.endsWith('automation_update'))).toBe(true);
    expect(recorded.reviewerRequests).toBeGreaterThan(0);
    expect(recorded.serverRequests).not.toContain(MCP_ELICITATION_METHOD);
    expect(stored(recorded).enabled).toBe(true);
  }, BUDGET_MS);

  test('the hook refuses the same floored edit before the reviewer is asked; nothing changes', async () => {
    const recorded = await runTurn({ enabled: true }, true);
    expect(recorded.trusted).toBe(1);
    expect(recorded.turnCompleted).toBe(true);
    expect(recorded.reviewerRequests).toBe(0);
    expect(recorded.serverRequests).not.toContain(MCP_ELICITATION_METHOD);
    expect(stored(recorded).enabled).toBe(false);
    const hookRuns = recorded.notifications.filter(n => n.method === 'hook/completed');
    expect(JSON.stringify(hookRuns)).toContain('refused rather than reviewed');
  }, BUDGET_MS);

  test('CONTROL (hook on): a non-floored edit gets no hook verdict — the reviewer answers and the edit lands', async () => {
    const recorded = await runTurn({ name: 'Weekly purge (renamed)' }, true);
    expect(recorded.trusted).toBe(1);
    expect(recorded.turnCompleted).toBe(true);
    expect(recorded.reviewerRequests).toBeGreaterThan(0);
    expect(stored(recorded).name).toBe('Weekly purge (renamed)');
  }, BUDGET_MS);
});
