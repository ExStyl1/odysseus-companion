/**
 * P3.28's PRIMARY GATE — the upstream half, which no double can prove.
 *
 * `codex-advisor-advertisement.test.ts` pins OUR wiring against a channel we
 * write. It is green whether or not the app-server actually does anything with
 * the two requests, so on its own it is exactly the blind spot this tree has
 * been burned by: a mechanism that ships dead behind a green suite.
 *
 * The claim underneath the whole row is upstream and is one codex bump away
 * from changing:
 *
 *   `config/value/write` on `mcp_servers.<name>.args` followed by
 *   `config/mcpServer/reload` re-spawns that MCP server, and the NEXT TURN ON
 *   THE SAME THREAD carries the new tool in the model-visible tool schema.
 *
 * Three properties, each of which a weaker rig would have missed:
 *
 * 1. **The MODEL's tool schema changes, not merely `mcpServerStatus/list`.** A
 *    status surface is what the app-server believes; the Responses request body
 *    is what the model is handed. Measured on the first cut: codex projects an
 *    MCP server as ONE aggregated `mcp__<server>` tool, so a rig that looked for
 *    a top-level `extra_tool` entry found nothing and would have read as "the
 *    mechanism does not work".
 * 2. **The SAME thread.** A mechanism that only takes effect on a fresh thread
 *    would be a restart wearing a different name — the thread anchor IS the
 *    conversation on this backend (`clearHistory` drops nothing else).
 * 3. **BOTH directions.** Removing the flag must remove the tool, or a disabled
 *    advisor stays advertised, which is the invisibility rule P2.1's gate exists
 *    to enforce.
 *
 * **Gated on `NESSY_CODEX_E2E=1`, following `codex-inject-items-e2e.test.ts`.**
 * The bundled binary is ~180 MB, untracked and gitignored (fetched by
 * `scripts/fetch-codex.mjs`), so a committed test that spawns it cannot run on a
 * fresh clone or in CI. It needs no network and no credentials — the provider is
 * a loopback stub and the MCP server is written to a temp file below:
 *
 *   NESSY_CODEX_E2E=1 bun test packages/shared/src/agent/__tests__/codex-advisor-advertisement-e2e.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AppServerClient } from '@nessy-agent/codex-agent-server/app-server-client';
import { CodexRuntimeManager } from '@nessy-agent/codex-agent-server/runtime-manager';
import { writeCodexConfig, CODEX_API_KEY_ENV } from '@nessy-agent/codex-responses-adapter/config-writer';
import { startStubAdapter, type StubAdapterHandle } from '@nessy-agent/codex-responses-adapter/stub-server';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..');
const MODEL = 'tgpt/qwen35-397b-a17b-fp8';

/**
 * A stdio MCP server standing in for `session-mcp-server`, in its one relevant
 * respect: it decides its tool list from ARGV, once, at its own startup — so
 * only a re-spawn can change what it advertises. `--extra` plays the part
 * `--advisor-consult` plays in the real spec.
 *
 * Hand-rolled JSON-RPC rather than the MCP SDK: the fixture must not depend on
 * a package resolving from a temp directory outside the workspace.
 */
const STUB_MCP_SOURCE = `
const EXTRA = process.argv.includes('--extra');
let buf = '';
process.stdin.on('data', (chunk) => {
  buf += chunk.toString('utf8');
  let i;
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    let msg; try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id === undefined) continue;
    let result;
    if (msg.method === 'initialize') {
      result = { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'stub-session', version: '0.0.1' } };
    } else if (msg.method === 'tools/list') {
      const tools = [{ name: 'always_tool', description: 'always here', inputSchema: { type: 'object', properties: {} } }];
      if (EXTRA) tools.push({ name: 'extra_tool', description: 'only with --extra', inputSchema: { type: 'object', properties: {} } });
      result = { tools };
    } else if (msg.method === 'tools/call') {
      result = { content: [{ type: 'text', text: 'ok' }] };
    } else {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found' } }) + '\\n');
      continue;
    }
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\\n');
  }
});
`;

function platformKey(): string {
  const arch = process.arch === 'arm64' ? 'arm64' : process.arch === 'x64' ? 'x64' : process.arch;
  return `${process.platform}-${arch}`;
}

function binaryPath(): string {
  const name = process.platform === 'win32' ? 'codex-app-server.exe' : 'codex-app-server';
  return join(REPO_ROOT, 'apps', 'electron', 'resources', 'bin', 'codex', platformKey(), name);
}

/**
 * D1.226 — the switch, said out loud.
 *
 * `describe.if(false)` reports `N skip` and NO REASON, so a developer who runs
 * this file alone sees a green run over nothing and cannot tell a deliberate
 * opt-in from a suite that was deleted or from one whose gate has rotted. The
 * other gate in this live-boot family already prints its own skip (the
 * `HAVE_BIN` detector in `codex-responses-adapter`'s `sandbox-enforcement`);
 * this is that shape for the env gate, and it is the ONLY arm of this file
 * that runs while the gate is off.
 */
const CODEX_E2E = process.env.NESSY_CODEX_E2E === '1';

describe('codex advisor advertisement live — the switch is visible', () => {
  test('runs only under NESSY_CODEX_E2E=1, and says why when it does not', () => {
    if (CODEX_E2E) {
      expect(CODEX_E2E).toBe(true);
      return;
    }
    console.warn(
      '[codex-e2e] SKIPPED codex-advisor-advertisement-e2e.test.ts: NESSY_CODEX_E2E is not "1". '
      + 'NOT verified in this run: a mid-thread session-MCP re-advertisement reaching the model. Run it with '
      + '`NESSY_CODEX_E2E=1 bun test ./packages/shared/src/agent/__tests__/codex-advisor-advertisement-e2e.test.ts`, '
      + 'or `bun scripts/codex-live-suites.ts`, which sets this gate for the whole '
      + 'live-boot family. It needs the staged codex-app-server '
      + '(`node scripts/fetch-codex.mjs`) and no network and no credentials.',
    );
    expect(CODEX_E2E).toBe(false);
  });
});

describe.if(CODEX_E2E)('a session-MCP re-advertisement reaches the model mid-thread', () => {
  let stub: StubAdapterHandle;
  let manager: CodexRuntimeManager;
  let client: AppServerClient;
  let codexHome = '';
  let workspace = '';
  let stubMcp = '';
  let threadId: string | undefined;
  const bodies: Array<{ tools?: Array<{ name?: string }> }> = [];

  /**
   * `turn/start` is fire-and-forget — it answers before the app-server has
   * spoken to the provider — so the request body arrives AFTER the RPC resolves.
   */
  async function nextBody(before: number, timeoutMs = 60_000) {
    const deadline = Date.now() + timeoutMs;
    while (bodies.length <= before) {
      if (Date.now() > deadline) throw new Error(`the loopback provider received no request within ${timeoutMs}ms of turn/start`);
      await new Promise(r => setTimeout(r, 25));
    }
    return bodies[before]!;
  }

  /**
   * The DETECTOR, and the one that had to be corrected: codex hands the model a
   * single aggregated `mcp__session` tool whose schema enumerates the server's
   * tools, not one top-level entry per tool.
   */
  function sessionToolSchema(body: { tools?: Array<{ name?: string }> }): string {
    const tool = (body.tools ?? []).find(t => t?.name === 'mcp__session');
    expect(tool).toBeDefined();
    return JSON.stringify(tool);
  }

  async function turnToolSchema(prompt: string): Promise<string> {
    const before = bodies.length;
    await client.request('turn/start', { threadId, input: [{ type: 'text', text: prompt, text_elements: [] }] });
    return sessionToolSchema(await nextBody(before));
  }

  async function setExtra(extra: boolean): Promise<void> {
    await client.request('config/value/write', {
      keyPath: 'mcp_servers.session.args',
      value: extra ? [stubMcp, '--extra'] : [stubMcp],
      mergeStrategy: 'replace',
    });
    await client.request('config/mcpServer/reload', undefined);
    // The reload TRIGGERS re-initialization rather than awaiting it (measured:
    // it answers in 3-32 ms even with a 3 s/response server configured), so the
    // re-spawned child needs a moment before the next turn reads its inventory.
    await new Promise(r => setTimeout(r, 1_000));
  }

  beforeAll(async () => {
    const bin = binaryPath();
    if (!existsSync(bin)) {
      throw new Error(`codex-app-server not found at ${bin}. Run: node scripts/fetch-codex.mjs`);
    }
    codexHome = mkdtempSync(join(tmpdir(), 'codex-advisor-home-'));
    workspace = mkdtempSync(join(tmpdir(), 'codex-advisor-ws-'));
    stubMcp = join(codexHome, 'stub-mcp.mjs');
    writeFileSync(stubMcp, STUB_MCP_SOURCE);
    execFileSync('git', ['init', '-q'], { cwd: workspace });
    writeFileSync(join(workspace, 'README.md'), '# advisor advertisement fixture\n');
    execFileSync('git', ['-c', 'user.email=e2e@nessy', '-c', 'user.name=e2e', 'add', '-A'], { cwd: workspace });
    execFileSync('git', ['-c', 'user.email=e2e@nessy', '-c', 'user.name=e2e', 'commit', '-qm', 'init'], { cwd: workspace });

    stub = await startStubAdapter({
      model: MODEL,
      // One round trip per turn: a tool call would reach codex's approval path,
      // which has nobody to answer it here.
      emitToolCall: false,
      onRequestBody: (raw) => {
        try { bodies.push(JSON.parse(raw)); } catch { /* not JSON — ignored */ }
      },
    });
    // The shipped writer rather than a hand-rolled TOML, so the run exercises
    // the `[mcp_servers.session]` block the product actually emits.
    writeCodexConfig({
      codexHome,
      model: MODEL,
      adapterPort: stub.port,
      sessionMcp: { command: process.execPath, args: [stubMcp] },
    });

    manager = new CodexRuntimeManager();
    const child = manager.spawn({
      binaryPath: bin,
      cwd: workspace,
      codexHome,
      env: { [CODEX_API_KEY_ENV]: 'loopback' },
      platformDir: platformKey(),
    });
    client = new AppServerClient(child);
    await client.request('initialize', {
      clientInfo: { name: 'nessy-codex-advisor-e2e', title: null, version: '0.0.0' },
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
    client.notify('initialized');
    const started = await client.request('thread/start', { cwd: workspace, model: MODEL }) as { thread?: { id?: string } };
    threadId = started.thread?.id;
    expect(threadId).toBeTruthy();
  }, 120_000);

  afterAll(async () => {
    try { client?.close(); } catch { /* already closed */ }
    await manager?.kill().catch(() => {});
    await stub?.close();
    if (codexHome) rmSync(codexHome, { recursive: true, force: true });
    if (workspace) rmSync(workspace, { recursive: true, force: true });
  });

  test('the flag added mid-thread reaches the model, and removing it takes it away', async () => {
    // Baseline. `always_tool` is the positive control: it proves the detector
    // reads a real inventory, so a later "extra_tool absent" is the flag and not
    // a rig that stopped seeing tools at all.
    const before = await turnToolSchema('hello one');
    expect(before).toContain('always_tool');
    expect(before).not.toContain('extra_tool');

    await setExtra(true);
    const after = await turnToolSchema('hello two');
    expect(after).toContain('always_tool');
    expect(after).toContain('extra_tool');

    // The thread never changed — no restart, no fork, no new conversation.
    await setExtra(false);
    const reverted = await turnToolSchema('hello three');
    expect(reverted).toContain('always_tool');
    expect(reverted).not.toContain('extra_tool');
  }, 180_000);
});
