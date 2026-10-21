/**
 * Phase 1 smoke spike — dev-only entrypoint.
 *
 * Drives ONE turn through a real bundled `codex-app-server` over stdio, backed
 * by the STUB Responses adapter (no Nestor, no UI, no factory). Proves the full
 * loop: handshake -> thread/start -> turn/start -> assistant text + one shell
 * command executed by codex in a temp git workspace -> approval auto-answered
 * -> turn/completed -> clean teardown. Emits Nessy `AgentEvent`s to stdout.
 *
 * Run:  bun packages/codex-agent-server/src/spike.ts
 */
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentEvent } from '@nessy-agent/core/types';
import {
  writeCodexConfig,
  validateConfigAgainstSchema,
  CODEX_API_KEY_ENV,
} from '@nessy-agent/codex-responses-adapter/config-writer';
import { startStubAdapter } from '@nessy-agent/codex-responses-adapter/stub-server';
import { AppServerClient } from './app-server-client.ts';
import { CodexRuntimeManager } from './runtime-manager.ts';

/**
 * Spike-local notification -> `AgentEvent` mapper.
 *
 * This USED to be `src/event-mapper.ts`, exported from the package `index.ts`
 * and from a `./event-mapper` subpath — a public surface with zero consumers
 * outside this file. It read like the product path and was not: the product
 * path is `CodexEventAdapter`
 * (`packages/shared/src/agent/backend/codex/event-adapter.ts`, constructed at
 * `codex-agent.ts` `private readonly eventAdapter = new CodexEventAdapter()`),
 * whose own header records that it "Promotes the Phase 1 spike mapper into a
 * typed `BaseEventAdapter` subclass". So this is that spike mapper, and it is
 * a strict subset of the adapter that superseded it (P3.119).
 *
 * It cannot simply call the real adapter: `@nessy-agent/shared` depends on THIS
 * package (`packages/shared/package.json`), so importing shared here would
 * invert the dependency. It stays here, module-local and unexported, where the
 * only thing that can reach it is the dev-only spike that needs it.
 *
 * Method + field names are the real ones from `@nessy-agent/codex-protocol`
 * `generated/v2` (rust-v0.148.0). Runtime access stays defensive so drift
 * degrades to "no event" rather than a crash.
 */
interface CommandExecutionItem {
  type: 'commandExecution';
  id: string;
  command: string;
  cwd?: string;
  status?: string;
  aggregatedOutput?: string | null;
  exitCode?: number | null;
}
interface AgentMessageItem {
  type: 'agentMessage';
  id: string;
  text: string;
}
type ThreadItemLike = CommandExecutionItem | AgentMessageItem | { type: string; id: string };

interface ItemNotification {
  item?: ThreadItemLike;
}
interface AgentMessageDeltaLike {
  delta?: string;
}

function isCommandExec(item: ThreadItemLike | undefined): item is CommandExecutionItem {
  return !!item && item.type === 'commandExecution';
}
function isAgentMessage(item: ThreadItemLike | undefined): item is AgentMessageItem {
  return !!item && item.type === 'agentMessage';
}

/** Translate one notification into zero or more `AgentEvent`s. Unknown methods return `[]`. */
function mapNotificationToEvents(method: string, params: unknown): AgentEvent[] {
  const p = (params ?? {}) as Record<string, unknown>;
  switch (method) {
    case 'item/agentMessage/delta': {
      const delta = (p as AgentMessageDeltaLike).delta;
      return delta ? [{ type: 'text_delta', text: delta }] : [];
    }
    case 'item/started': {
      const item = (p as ItemNotification).item;
      if (isCommandExec(item)) {
        return [
          {
            type: 'tool_start',
            toolName: 'shell',
            toolUseId: item.id,
            input: { command: item.command },
          },
        ];
      }
      return [];
    }
    case 'item/completed': {
      const item = (p as ItemNotification).item;
      if (isCommandExec(item)) {
        return [
          {
            type: 'tool_result',
            toolUseId: item.id,
            toolName: 'shell',
            result: item.aggregatedOutput ?? '',
            isError: typeof item.exitCode === 'number' ? item.exitCode !== 0 : false,
          },
        ];
      }
      if (isAgentMessage(item)) {
        return [{ type: 'text_complete', text: item.text }];
      }
      return [];
    }
    case 'turn/completed':
      return [{ type: 'complete' }];
    default:
      return [];
  }
}

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..');
const MODEL = 'tgpt/qwen35-397b-a17b-fp8';

function platformKey(): string {
  const arch = process.arch === 'arm64' ? 'arm64' : process.arch === 'x64' ? 'x64' : process.arch;
  return `${process.platform}-${arch}`;
}

function binaryPath(): string {
  const p = join(REPO_ROOT, 'apps', 'electron', 'resources', 'bin', 'codex', platformKey(), 'codex-app-server');
  if (!existsSync(p)) {
    throw new Error(`codex-app-server not found at ${p}. Run: node scripts/fetch-codex.mjs`);
  }
  return p;
}

function log(line: string): void {
  process.stdout.write(line + '\n');
}
function emit(event: AgentEvent): void {
  log(`AgentEvent ${JSON.stringify(event)}`);
}

const INITIALIZE_CAPABILITIES = { experimentalApi: true, requestAttestation: false };
const CLIENT_INFO = { name: 'nessy-codex-spike', title: null, version: '0.0.0' };

/**
 * Gate check: a request sent before `initialize` must be rejected. Done in a
 * throwaway subprocess so it can't corrupt the real run's connection state.
 */
async function verifyPreInitRejected(bin: string, codexHome: string, cwd: string, env: Record<string, string>): Promise<void> {
  const child = spawn(bin, [], {
    cwd,
    env: { ...process.env, ...env, CODEX_HOME: codexHome },
    stdio: ['pipe', 'pipe', 'pipe'],
  }) as ChildProcessWithoutNullStreams;
  const client = new AppServerClient(child);
  try {
    await client.request('thread/start', { cwd });
    log('pre-init check: WARNING — thread/start was NOT rejected before initialize');
  } catch (err) {
    log(`pre-init check: rejected as expected -> ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    client.close();
    child.kill('SIGKILL');
  }
}

async function main(): Promise<void> {
  const bin = binaryPath();
  const codexHome = mkdtempSync(join(tmpdir(), 'codex-home-'));
  const workspace = mkdtempSync(join(tmpdir(), 'codex-ws-'));
  execFileSync('git', ['init', '-q'], { cwd: workspace });
  writeFileSync(join(workspace, 'README.md'), '# spike workspace\n');
  execFileSync('git', ['-c', 'user.email=spike@nessy', '-c', 'user.name=spike', 'add', '-A'], { cwd: workspace });
  execFileSync('git', ['-c', 'user.email=spike@nessy', '-c', 'user.name=spike', 'commit', '-qm', 'init'], { cwd: workspace });

  // exec_command is codex's real shell tool. `sandbox_permissions:
  // "require_escalated"` forces an approval request under approval_policy
  // "on-request", exercising the server->client approval round-trip.
  const stub = await startStubAdapter({
    model: MODEL,
    logRequests: true,
    toolName: 'exec_command',
    toolArguments: { cmd: 'echo hi', sandbox_permissions: 'require_escalated', justification: 'spike approval probe' },
  });
  const configPath = writeCodexConfig({ codexHome, model: MODEL, adapterPort: stub.port });
  validateConfigAgainstSchema(
    { codexHome, model: MODEL, adapterPort: stub.port },
    join(REPO_ROOT, 'packages', 'codex-protocol', 'schema', 'config-schema.json'),
  );
  log(`config.toml written + schema-validated at ${configPath} (adapter port ${stub.port})`);

  const spawnEnv = { [CODEX_API_KEY_ENV]: 'loopback' };
  await verifyPreInitRejected(bin, codexHome, workspace, spawnEnv);

  const runtime = new CodexRuntimeManager();
  const child = runtime.spawn({ binaryPath: bin, cwd: workspace, codexHome, env: spawnEnv });
  const childPid = child.pid;

  let resolveTurn!: () => void;
  let rejectTurn!: (err: Error) => void;
  const turnDone = new Promise<void>((res, rej) => {
    resolveTurn = res;
    rejectTurn = rej;
  });

  const client = new AppServerClient(child, {
    onDiagnostic: (m) => process.stderr.write(m + '\n'),
    onNotification: (method, params) => {
      const itemType = (params as { item?: { type?: string } } | undefined)?.item?.type;
      process.stderr.write(`[notif] ${method}${itemType ? ` item=${itemType}` : ''}\n`);
      for (const event of mapNotificationToEvents(method, params)) emit(event);
      if (method === 'turn/completed') resolveTurn();
      if (method === 'error') {
        const msg = (params as { message?: string } | undefined)?.message ?? JSON.stringify(params);
        rejectTurn(new Error(`server error notification: ${msg}`));
      }
    },
    onServerRequest: ({ method, params }) => {
      // Approvals are server->client requests. Auto-approve with the "accept"
      // decision (the fixed CommandExecution/FileChange approval enum — there is
      // no availableDecisions list; see 00-context addendum / spike outcome).
      if (method.endsWith('/requestApproval')) {
        const cmd = (params as { command?: string } | undefined)?.command;
        log(`approval: ${method} -> decision "accept"${cmd ? ` (command: ${cmd})` : ''}`);
        return { decision: 'accept' };
      }
      return {};
    },
  });

  const initResult = (await client.request('initialize', {
    clientInfo: CLIENT_INFO,
    capabilities: INITIALIZE_CAPABILITIES,
  })) as { codexHome?: string; platformOs?: string; platformFamily?: string };
  log(`initialize ok: codexHome=${initResult.codexHome} platformOs=${initResult.platformOs} platformFamily=${initResult.platformFamily}`);
  client.notify('initialized');

  const threadResult = (await client.request('thread/start', {
    cwd: workspace,
    model: MODEL,
  })) as { thread?: { id?: string } };
  const threadId = threadResult.thread?.id;
  if (!threadId) throw new Error(`thread/start returned no thread id: ${JSON.stringify(threadResult)}`);
  log(`thread/start ok: threadId=${threadId}`);

  await client.request('turn/start', {
    threadId,
    input: [{ type: 'text', text: 'list files', text_elements: [] }],
  });
  log('turn/start sent');

  const timeout = setTimeout(() => rejectTurn(new Error('turn timed out after 90s')), 90_000);
  let failure: Error | null = null;
  try {
    await turnDone;
    log('turn/completed observed');
  } catch (err) {
    failure = err instanceof Error ? err : new Error(String(err));
    log(`turn FAILED: ${failure.message}`);
  } finally {
    clearTimeout(timeout);
  }

  // Teardown.
  client.close();
  await runtime.kill();
  await stub.close();

  let lingering = false;
  if (childPid !== undefined) {
    try {
      process.kill(childPid, 0);
      lingering = true;
    } catch {
      lingering = false;
    }
  }
  log(`teardown: child pid ${childPid ?? '?'} lingering=${lingering}`);
  rmSync(codexHome, { recursive: true, force: true });
  rmSync(workspace, { recursive: true, force: true });
  log(`teardown: temp dirs removed (codexHome removable=${!existsSync(codexHome)}, workspace removable=${!existsSync(workspace)})`);

  if (failure || lingering) {
    process.exit(1);
  }
}

main().catch((err) => {
  process.stderr.write(`spike failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
