/**
 * The local tool-call path a REMOTE Nestor agent drives, end to end.
 *
 * `local-tool-adapter.ts` is only ever reached through that path, so driving its
 * exported functions with a hand-built request would prove the functions and not
 * the path. Every case here starts from what the remote side actually sends — an
 * A2A `input-required` frame on the SSE stream — and ends at what the remote side
 * actually receives — the JSON-RPC body of the follow-up POST. In between run the
 * real `NestorCloudClient`, `NestorCloudEventAdapter`, `NestorCloudTurn`,
 * `NestorCloudToolExecutor`, the adapter under test, the permission gate and the
 * local tool runtime, wired exactly as `nestor-cloud-agent.ts` wires them.
 *
 * The transport is a stubbed `fetchImpl` and the credentials are a throwaway temp
 * file: no request ever leaves the process, and `~/.nessy/dp_auth_creds.json` is
 * neither read nor written.
 */
import { describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { NestorCloudClient } from '../client.ts';
import {
  NestorCloudToolExecutor,
  type NestorCloudToolExecutorOptions,
  type NestorPermissionManagerLike,
} from '../tool-executor.ts';
import { NestorCloudTurn } from '../turn.ts';
import { toLocalToolCall } from '../local-tool-adapter.ts';
import { normalizeNestorToolCall } from '../tool-schema.ts';
import type { A2AStreamEvent, NestorAgentCard } from '../types.ts';
import { makeTestJwt } from '../../../../auth/dp/__tests__/test-jwt.ts';

// DA1.50 · `getValidCreds` gates on `isUsableJwt`, so a credential fixture
// must DECODE. `makeTestJwt` is the existing maker; the value is fabricated and
// carries no real token.
const FIXTURE_JWT = makeTestJwt({ preferred_username: 'tester', sub: 'user-42' });

/** Unroutable by design — the stub never reaches the network, and this says so. */
const A2A_URL = 'https://nestor-cloud.invalid/api/v2/code-agent/a2a';
const CARD_URL = 'https://nestor-cloud.invalid/api/v2/code-agent/a2a/.well-known/agent-card.json';

const SESSION_KEY = { workspaceId: 'workspace-test', sessionId: 'session-test' };

interface RemoteToolRequest {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

interface DeliveredToolResult {
  tool_call_id?: unknown;
  content?: unknown;
  error?: unknown;
}

function workspace(prefix = 'nestor-cloud-e2e-'): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

function testScope(primaryRoot: string) {
  return {
    session: SESSION_KEY,
    primaryRoot,
    cwd: primaryRoot,
    additionalRoots: [],
    managedExclusions: [],
    generation: 'g-test',
  };
}

/** A throwaway creds file. The real store is never touched, read or written. */
function tempCredsPath(): string {
  const path = join(workspace('nestor-cloud-e2e-creds-'), 'dp_auth_creds.json');
  writeFileSync(path, JSON.stringify({
    jwt: FIXTURE_JWT,
    expiresAt: Date.now() + 60_000,
    username: 'user@example.com',
    userId: 'u-123',
  }));
  return path;
}

function agentCard(): NestorAgentCard {
  return {
    capabilities: { streaming: true },
    supportedInterfaces: [{ url: A2A_URL, protocolBinding: 'JSONRPC', protocolVersion: '1.0' }],
  };
}

function sse(events: A2AStreamEvent[]): Response {
  return new Response(events.map(result =>
    `data: ${JSON.stringify({ jsonrpc: '2.0', id: 'rpc-1', result })}\n\n`
  ).join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function taskStarted(): A2AStreamEvent {
  return { task: { id: 'task-1', contextId: 'ctx-1', status: { state: 'TASK_STATE_SUBMITTED' } } };
}

/** What the remote agent sends when it wants local tools run on our machine. */
function remoteToolRequest(requests: readonly RemoteToolRequest[]): A2AStreamEvent {
  return {
    statusUpdate: {
      taskId: 'task-1',
      contextId: 'ctx-1',
      status: {
        state: 'TASK_STATE_INPUT_REQUIRED',
        message: {
          messageId: 'msg-tools',
          role: 'ROLE_AGENT',
          parts: requests.map((request, index) => ({
            data: {
              data_type: 'tool_call',
              data_version: 1,
              id: request.id,
              index,
              function: { name: request.name, arguments: JSON.stringify(request.args) },
            },
          })),
        },
      },
    },
  };
}

function remoteCompleted(text: string): A2AStreamEvent {
  return {
    statusUpdate: {
      taskId: 'task-1',
      contextId: 'ctx-1',
      status: {
        state: 'TASK_STATE_COMPLETED',
        message: { messageId: 'msg-done', role: 'ROLE_AGENT', parts: [{ text }] },
      },
    },
  };
}

type JsonRpcPost = {
  method?: string;
  params?: { message?: { parts?: Array<Record<string, unknown>> } };
};

/** The tool results the remote agent received, read off the wire body we sent. */
function deliveredToolResults(post: JsonRpcPost | undefined): DeliveredToolResult[] {
  return (post?.params?.message?.parts ?? [])
    // v2 parts are discriminated by key presence, never by `kind`.
    .filter(part => 'data' in part)
    .map(part => part.data as DeliveredToolResult);
}

function remoteSession(options: {
  root: string;
  requests: readonly RemoteToolRequest[];
  permissionManager: NestorPermissionManagerLike;
  runCommand?: NestorCloudToolExecutorOptions['runCommand'];
  onPermissionRequest?: NestorCloudToolExecutorOptions['onPermissionRequest'];
  controller?: AbortController;
  finalText?: string;
}) {
  const controller = options.controller ?? new AbortController();
  const posts: JsonRpcPost[] = [];
  const frames: A2AStreamEvent[][] = [
    [taskStarted(), remoteToolRequest(options.requests)],
    [remoteCompleted(options.finalText ?? 'remote agent resumed')],
  ];
  const client = new NestorCloudClient({
    credsPath: tempCredsPath(),
    postUrl: A2A_URL,
    agentCardUrl: CARD_URL,
    fetchImpl: (async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      if (init?.method !== 'POST') return Response.json(agentCard());
      expect(String(url)).toBe(A2A_URL);
      posts.push(JSON.parse(String(init.body)) as JsonRpcPost);
      return sse(frames.shift() ?? [remoteCompleted('remote agent idle')]);
    }) as unknown as typeof fetch,
  });
  const executor = new NestorCloudToolExecutor({
    filesystemScope: testScope(options.root),
    sessionKey: SESSION_KEY,
    abortSignal: controller.signal,
    permissionManager: options.permissionManager,
    ...(options.runCommand ? { runCommand: options.runCommand } : {}),
    ...(options.onPermissionRequest ? { onPermissionRequest: options.onPermissionRequest } : {}),
  });
  const turn = new NestorCloudTurn({
    client,
    signal: controller.signal,
    executeTool: toolCall => executor.execute(toolCall),
  });
  return {
    controller,
    posts,
    executor,
    async run(message = 'do the thing') {
      const events = [];
      for await (const event of turn.run(message)) events.push(event);
      return events;
    },
  };
}

function allows(result: ReturnType<NestorPermissionManagerLike['evaluateToolCall']> = { allowed: true }) {
  return { evaluateToolCall: () => result };
}

describe('Nestor cloud local tool-call path, end to end', () => {
  it('runs the tools a remote agent asks for and delivers their results back to it', async () => {
    const root = workspace();
    writeFileSync(join(root, 'notes.md'), 'content that only exists locally');
    const session = remoteSession({
      root,
      permissionManager: allows(),
      finalText: 'thanks for the files',
      requests: [
        { id: 'call-read', name: 'read_file', args: { path: 'notes.md' } },
        { id: 'call-write', name: 'write_to_file', args: { path: 'out.txt', content: 'written for the remote agent' } },
      ],
    });

    const events = await session.run();

    // The local half really ran: the write hit the real filesystem.
    expect(readFileSync(join(root, 'out.txt'), 'utf-8')).toBe('written for the remote agent');
    // The remote half really got the results, on the wire, in request order.
    expect(session.posts).toHaveLength(2);
    expect(session.posts[0]?.method).toBe('SendStreamingMessage');
    expect(session.posts[1]?.method).toBe('SendStreamingMessage');
    expect(deliveredToolResults(session.posts[1])).toEqual([
      { tool_call_id: 'call-read', content: 'content that only exists locally' },
      { tool_call_id: 'call-write', content: `Wrote ${join(root, 'out.txt')}` },
    ]);
    // And the remote agent's answer after the results came back reaches the UI.
    expect(events).toContainEqual({
      type: 'tool_result',
      toolUseId: 'call-read',
      toolName: 'read_file',
      result: 'content that only exists locally',
      isError: false,
    });
    expect(events.filter(event => event.type === 'text_complete').map(event => event.text))
      .toEqual(['thanks for the files']);
    expect(events.at(-1)).toEqual({ type: 'complete' });
  });

  it('delivers a failing tool as an error instead of losing it', async () => {
    const root = workspace();
    const session = remoteSession({
      root,
      permissionManager: allows(),
      requests: [{
        id: 'call-read',
        name: 'read_file',
        args: { path: 'missing.txt' },
      }],
    });

    const events = await session.run();

    const delivered = deliveredToolResults(session.posts[1]);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.content).toBe('');
    expect(String(delivered[0]?.error)).toContain('no such file or directory');
    expect(events.find(event => event.type === 'tool_result')).toMatchObject({
      toolUseId: 'call-read',
      isError: true,
    });
  });

  it('gates a remote tool on the local permission subject and delivers the refusal', async () => {
    const root = workspace();
    const subjects: Array<{ toolName: string; input: Record<string, unknown> }> = [];
    let commandRan = false;
    const session = remoteSession({
      root,
      permissionManager: {
        evaluateToolCall: (toolName, input) => {
          subjects.push({ toolName, input });
          return { allowed: false, reason: 'blocked by mode' };
        },
      },
      runCommand: async () => {
        commandRan = true;
        return { stdout: 'must not run', stderr: '', exitCode: 0 };
      },
      requests: [{ id: 'call-bash', name: 'execute_command', args: { command: 'rm -rf build' } }],
    });

    await session.run();

    // The gate must judge the LOCAL tool identity. Were it handed the remote name
    // `execute_command`, every Bash rule a local agent obeys would miss, and the
    // remote agent would hold more authority than a local one.
    expect(subjects).toEqual([{ toolName: 'Bash', input: { command: 'rm -rf build' } }]);
    expect(commandRan).toBe(false);
    expect(deliveredToolResults(session.posts[1])).toEqual([
      { tool_call_id: 'call-bash', content: '', error: 'blocked by mode' },
    ]);
  });

  it('keeps an allowed remote read inside the session filesystem scope', async () => {
    const root = workspace();
    const outside = join(workspace('nestor-cloud-e2e-outside-'), 'private.txt');
    writeFileSync(outside, 'bytes the remote agent must never receive');
    const session = remoteSession({
      root,
      // The mode allows Read; containment is the scope's job, not the mode's.
      permissionManager: allows(),
      requests: [{ id: 'call-escape', name: 'read_file', args: { path: outside } }],
    });

    await session.run();

    const delivered = deliveredToolResults(session.posts[1]);
    expect(delivered[0]?.content).toBe('');
    expect(String(delivered[0]?.error)).toContain('outside the session filesystem scope');
    expect(JSON.stringify(session.posts)).not.toContain('bytes the remote agent must never receive');
  });

  it('runs search_files as a regex grep and honours file_pattern as the glob filter', async () => {
    const root = workspace();
    mkdirSync(join(root, 'src'));
    const commands: string[] = [];
    const session = remoteSession({
      root,
      permissionManager: allows(),
      runCommand: async (command) => {
        commands.push(command);
        return { stdout: 'src/a.ts:1:needle_1', stderr: '', exitCode: 0 };
      },
      requests: [{
        id: 'call-search',
        name: 'search_files',
        args: { path: 'src', regex: 'needle_\\d+', file_pattern: '*.ts' },
      }],
    });

    await session.run();

    expect(commands).toHaveLength(1);
    const command = commands[0] ?? '';
    // The backend documents `regex` as Rust regex syntax (tools.go:275-278). Routed as a fixed
    // string — which is what the pre-contract `search_files` operation did — every pattern the
    // model actually writes finds nothing, and the agent concludes the code is not there.
    expect(command).not.toContain('--fixed-strings');
    expect(command).toContain(String.raw`'needle_\d+'`);
    // `file_pattern` is a glob filter; dropping it searches the whole tree instead of the
    // extension the model asked for.
    expect(command).toContain(`'--glob' '*.ts'`);
    expect(command).toContain(join(root, 'src'));
    expect(deliveredToolResults(session.posts[1])).toEqual([
      { tool_call_id: 'call-search', content: 'src/a.ts:1:needle_1' },
    ]);
  });

  it('applies a replace_in_file SEARCH/REPLACE diff to the file on disk', async () => {
    const root = workspace();
    writeFileSync(join(root, 'notes.md'), 'alpha\nbeta\ngamma\n');
    const diff = [
      '<<<<<<< SEARCH',
      'alpha',
      '=======',
      'ALPHA',
      '>>>>>>> REPLACE',
      '<<<<<<< SEARCH',
      'gamma',
      '=======',
      '>>>>>>> REPLACE',
    ].join('\n');
    const subjects: Array<{ toolName: string; input: Record<string, unknown> }> = [];
    const session = remoteSession({
      root,
      permissionManager: {
        evaluateToolCall: (toolName, input) => {
          subjects.push({ toolName, input });
          return { allowed: true };
        },
      },
      // The read is PRODUCTION SHAPE, not scaffolding: `fd41f1405` (P6.558) made
      // `LocalToolRuntime` refuse a mutation of an existing file nobody read this
      // session, and `replace_in_file` takes that gate under its own name. A
      // remote agent that edits a file it never read is refused here too — pinned
      // by the sibling case below — so this case reads first, exactly as the
      // model must.
      requests: [
        { id: 'call-read', name: 'read_file', args: { path: 'notes.md' } },
        { id: 'call-replace', name: 'replace_in_file', args: { path: 'notes.md', diff } },
      ],
    });

    await session.run();

    // Both blocks land, in order, and an empty REPLACE section deletes.
    expect(readFileSync(join(root, 'notes.md'), 'utf-8')).toBe('ALPHA\nbeta\n\n');
    // The gate must see the diff itself: a rule that inspects what is being written has nothing
    // to read if only the path arrives.
    expect(subjects).toEqual([
      { toolName: 'Read', input: { file_path: 'notes.md' } },
      { toolName: 'Edit', input: { file_path: 'notes.md', diff } },
    ]);
    expect(deliveredToolResults(session.posts[1])).toEqual([
      { tool_call_id: 'call-read', content: 'alpha\nbeta\ngamma\n' },
      { tool_call_id: 'call-replace', content: `Updated ${join(root, 'notes.md')}` },
    ]);
  });

  it('refuses a replace_in_file on a file the remote agent never read, and names the remedy', async () => {
    // The negative half of `fd41f1405`'s gate on THIS path: without it the case
    // above would pass just as well with the read deleted, and the gate would be
    // untested where a remote model reaches it.
    const root = workspace();
    writeFileSync(join(root, 'notes.md'), 'alpha\n');
    const session = remoteSession({
      root,
      permissionManager: allows(),
      requests: [{
        id: 'call-replace',
        name: 'replace_in_file',
        args: { path: 'notes.md', diff: '<<<<<<< SEARCH\nalpha\n=======\nALPHA\n>>>>>>> REPLACE' },
      }],
    });

    await session.run();

    // Unedited on disk, and the refusal travels back as an ERROR the model can act on.
    expect(readFileSync(join(root, 'notes.md'), 'utf-8')).toBe('alpha\n');
    const [delivered] = deliveredToolResults(session.posts[1]);
    expect(delivered?.tool_call_id).toBe('call-replace');
    expect(String(delivered?.error)).toContain('has not been read in this session');
  });

  it('answers a malformed diff with the retry guidance instead of editing nothing quietly', async () => {
    const root = workspace();
    writeFileSync(join(root, 'notes.md'), 'alpha\n');
    const session = remoteSession({
      root,
      permissionManager: allows(),
      requests: [{
        id: 'call-bad-diff',
        name: 'replace_in_file',
        // The tool's own "Wrong" case: the value wrapped in a markdown fence (tools.go:230-249).
        args: {
          path: 'notes.md',
          diff: '```\n<<<<<<< SEARCH\nalpha\n=======\nbeta\n>>>>>>> REPLACE\n```',
        },
      }],
    });

    const events = await session.run();

    expect(readFileSync(join(root, 'notes.md'), 'utf-8')).toBe('alpha\n');
    const delivered = deliveredToolResults(session.posts[1]);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.content).toBe('');
    expect(String(delivered[0]?.error)).toContain('The diff must start directly with "<<<<<<< SEARCH"');
    expect(events.find(event => event.type === 'tool_result')).toMatchObject({
      toolUseId: 'call-bad-diff',
      isError: true,
    });
  });

  it('cancels an in-flight local tool and sends the remote agent nothing', async () => {
    const root = workspace();
    const controller = new AbortController();
    let observedAbort = false;
    const session = remoteSession({
      root,
      controller,
      permissionManager: allows(),
      runCommand: async (_command, _cwd, options) => new Promise((_, reject) => {
        options?.signal?.addEventListener('abort', () => {
          observedAbort = true;
          reject(new Error('aborted'));
        }, { once: true });
        // Stop pressed while the remote agent's tool call is still running.
        controller.abort();
      }),
      requests: [{ id: 'call-slow', name: 'execute_command', args: { command: 'sleep 60' } }],
    });

    const events = await session.run();

    expect(observedAbort).toBe(true);
    expect(events.find(event => event.type === 'tool_result')).toMatchObject({
      toolUseId: 'call-slow',
      isError: true,
    });
    expect(String(events.find(event => event.type === 'tool_result')?.result).toLowerCase())
      .toContain('cancel');
    // A cancelled turn must not hand the remote task a result and let it carry on;
    // the remote side is stopped through tasks/cancel instead.
    expect(session.posts).toHaveLength(1);
    expect(events.at(-1)).toEqual({ type: 'complete' });
    expect(existsSync(join(root, 'out.txt'))).toBe(false);
  });

  // The `return_text` mappings are gone: those two tools are answered by the USER,
  // not by a local operation that echoes the model's own words back at it (F5).
  it('gives the two terminal tools no local operation at all', () => {
    for (const call of [
      { id: 'ask', index: 0, name: 'ask_followup_question', arguments: '{"question":"continue?"}' },
      { id: 'plan', index: 1, name: 'plan_mode_respond', arguments: '{"response":"the plan"}' },
    ]) {
      const normalized = normalizeNestorToolCall(call);
      expect(normalized.kind, call.name).toBe('builtin');
      expect(toLocalToolCall(normalized), call.name).toBeNull();
    }
  });
});
