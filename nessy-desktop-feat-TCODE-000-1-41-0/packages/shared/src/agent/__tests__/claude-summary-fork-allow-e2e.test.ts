/**
 * F1.901 (origin SIT-ac FAILS 2, sharpened by WJ-crit-bbb's P-WJ-crit-bbb-1) — an Allow on the card the SDK's
 * `agent_summary` fork raises does NOT run the command, measured on the vendored binary rather than read off it.
 *
 * ## The question
 *
 * With `Options.agentProgressSummaries: true` (this rig sets it; `claude-agent.ts` sends `false` since F1.919, which
 * this measurement fed), the vendored `claude` forks a running
 * subagent's conversation every ~30 s to write a 3-5 word progress line. The fork is told "Do not use tools", runs
 * one turn, and is given a `canUseTool` that denies everything ("No tools needed for summary"). A weak model
 * ignores the instruction and RE-EMITS the worker's pending call; our PreToolUse hook runs before that deny, so the
 * host raises a second card for one user-visible action (SIT-ac: `awaitingApprovalCount` 1 -> 2). After F1.900 that
 * card stays answerable, and the row asked whether an Allow on it — which makes our hook answer `allow` — outranks
 * the fork's own deny and runs the command a second time.
 *
 * ## The answer, and where it comes from (vendored `claude` 2.1.267, SDK 0.3.267)
 *
 * It does not. The forked-agent runner builds the fork's tool-use context with `requireCanUseTool` defaulting to
 * `true` (read out of the binary: `requireCanUseTool:p?.requireCanUseTool??!0`, the summary fork passes only an
 * `abortController` override), and the hook-decision resolver, on a hook `allow` with that flag set, logs
 * "Hook approved tool use for ${name}, but canUseTool is required" and asks the fork's `canUseTool` anyway — which
 * denies. The run below measured it: the fork's command wrote its marker ZERO times and fired no PostToolUse, while
 * the worker's own call, answered with the same Allow, wrote its marker once (the control).
 *
 * The fork's hook input is recorded too, because a later card-suppression row would key on it: `agent_id` is a
 * FRESH id (not the worker's, never announced by SubagentStart), `agent_type` is ABSENT, and `tool_use_id` is the
 * fork model's own. That shape is not specific to the summary fork — `extract_memories` and `auto_dream` go through
 * the same runner and write memory files through their own `canUseTool`, so "an `agent_id` with no `agent_type`"
 * alone must not be answered with a blanket deny.
 *
 * ## The rig
 *
 * The vendored binary against a loopback Anthropic Messages stub (the shape `claude-post-tool-use-failure-e2e.test.ts`
 * uses). The main thread launches ONE background general-purpose subagent; the subagent emits a line of text and a
 * Bash call; the rig's PreToolUse hook HOLDS that call — a pending card — so the summary timer fires; the summary
 * request, recognised by its own prompt text, is answered with a Bash call; the hook answers it with the exact value
 * `case 'prompt'` returns on an Allow click (`buildClaudePreToolUseContinue({})(undefined, true)`). The worker's hold
 * is then released with the same value. A marker file per command is the detector: one line is one execution. The
 * binary's own debug file is read for the resolver's line, the positive half of the absence.
 *
 * The binary is PINNED to the one we vendor and the env is scrubbed of every `CLAUDE*`/`ANTHROPIC*` key (a probe
 * started from inside a Claude Code session would otherwise measure another binary). **Gated on
 * `NESSY_CLAUDE_SDK_E2E=1`** — the native binary is an optional dependency, so this is a recorded local run, not a
 * CI gate; the ungated arm pins the bundle it was taken against, so a lift reddens here and says to re-run it. A
 * lift that flips the runner's default is exactly the change that would make the second card dangerous.
 *
 *   NESSY_CLAUDE_SDK_E2E=1 bun test ./packages/shared/src/agent/__tests__/claude-summary-fork-allow-e2e.test.ts
 */
import { describe, expect, setDefaultTimeout, test } from 'bun:test';

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

// The budget belongs to the FILE: the gated run imports `claude-agent.ts` and waits out the ~30 s summary timer.
setDefaultTimeout(60_000);

const MODEL = 'tgpt/qwen35-397b-a17b-fp8';

/** The bundle the recorded run below was taken against (2.1.267 → 2.1.274 by F1.1213, → 2.1.280 by UA12.211, each on a DRIVEN gated run). */
const MEASURED_CLAUDE_CODE_VERSION = '2.1.280';

/** The summary fork's own prompt (the binary's text), which is how the stub tells its request apart. */
const SUMMARY_PROMPT_NEEDLE = 'Describe your most recent action in 3-5 words';
const WORKER_TASK = 'F1901-WORKER-TASK: run the marker command.';
const MAIN_PROMPT = 'F1901-MAIN: launch the worker';

function vendoredClaudeBinary(): string | null {
  const suffix = process.platform === 'win32' ? 'claude.exe' : 'claude';
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  try {
    const require_ = createRequire(import.meta.url);
    const sdkRoot = dirname(require_.resolve('@anthropic-ai/claude-agent-sdk/package.json'));
    const candidate = join(dirname(sdkRoot), `claude-agent-sdk-${process.platform}-${arch}`, suffix);
    return existsSync(candidate) ? candidate : null;
  } catch {
    return null;
  }
}

const BINARY = vendoredClaudeBinary();
const ENABLED = process.env.NESSY_CLAUDE_SDK_E2E === '1' && BINARY !== null;

type Block = { type?: string; text?: string; content?: unknown };
type Message = { role?: string; content?: string | Block[] };

function textOf(message: Message): string {
  if (typeof message.content === 'string') return message.content;
  if (!Array.isArray(message.content)) return '';
  return message.content.map(block => {
    if (typeof block.text === 'string') return block.text;
    if (typeof block.content === 'string') return block.content;
    if (Array.isArray(block.content)) return (block.content as Block[]).map(inner => inner.text ?? '').join(' ');
    return '';
  }).join(' ');
}

const hasToolResult = (messages: Message[]): boolean =>
  messages.some(m => Array.isArray(m.content) && m.content.some(block => block.type === 'tool_result'));

async function startStub(dir: string, kinds: string[]): Promise<{ port: number; close: () => Promise<void> }> {
  let forkCalls = 0;
  const server: Server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const path = (req.url ?? '').replace(/\?.*$/, '');
    if (req.method !== 'POST' || !path.endsWith('/messages')) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: `stub: ${path}` } }));
      return;
    }
    let body: { model?: string; messages?: Message[] } = {};
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as typeof body;
    } catch { /* a malformed body is still a request */ }
    const messages = body.messages ?? [];
    const all = messages.map(textOf).join('\n');
    const kind = all.includes(SUMMARY_PROMPT_NEEDLE) ? 'summary'
      : all.includes(WORKER_TASK) ? 'worker'
        : all.includes(MAIN_PROMPT) ? 'main' : 'other';
    kinds.push(kind);

    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const frame = (type: string, data: unknown) => res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
    frame('message_start', { type: 'message_start', message: { id: `msg_f1901_${kinds.length}`, type: 'message', role: 'assistant', model: body.model ?? MODEL, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } });
    let index = 0;
    const text = (value: string) => {
      frame('content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } });
      frame('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text: value } });
      frame('content_block_stop', { type: 'content_block_stop', index });
      index += 1;
    };
    const tool = (id: string, name: string, input: unknown) => {
      frame('content_block_start', { type: 'content_block_start', index, content_block: { type: 'tool_use', id, name, input: {} } });
      frame('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } });
      frame('content_block_stop', { type: 'content_block_stop', index });
      index += 1;
    };
    let stop = 'tool_use';
    if (kind === 'summary') {
      // What SIT-ac's gateway model did: ignore "Do not use tools" and re-emit the pending command.
      forkCalls += 1;
      text('Running the marker command.');
      tool(`toolu_f1901_fork_${forkCalls}`, 'Bash', { command: `echo fork >> ${join(dir, 'fork-marker.txt')}`, description: 'fork marker' });
    } else if (kind === 'worker' && !hasToolResult(messages)) {
      // A text block AND the call: the summary runner skips a transcript under three messages.
      text('I will run the marker command now.');
      tool('toolu_f1901_worker', 'Bash', { command: `echo worker >> ${join(dir, 'worker-marker.txt')}`, description: 'worker marker' });
    } else if (kind === 'main' && !hasToolResult(messages)) {
      tool('toolu_f1901_agent', 'Agent', {
        description: 'marker worker',
        prompt: WORKER_TASK,
        subagent_type: 'general-purpose',
        run_in_background: true,
      });
    } else {
      text('done');
      stop = 'end_turn';
    }
    frame('message_delta', { type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 5 } });
    frame('message_stop', { type: 'message_stop' });
    res.end();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  return {
    port: (server.address() as { port: number }).port,
    close: () => new Promise<void>(resolve => server.close(() => resolve())),
  };
}

type HookInput = Record<string, unknown> & { tool_use_id?: string; tool_input?: { command?: string } };

interface RunOutcome {
  version: string | null;
  workerWrites: number;
  forkWrites: number;
  subagentIds: string[];
  workerCall: HookInput | undefined;
  forkCall: HookInput | undefined;
  /** Every tool_use_id a PostToolUse or PostToolUseFailure fired for. */
  postFired: string[];
  /** The value our hook returned for the fork's call: `case 'prompt'`'s Allow. */
  forkAnswer: unknown;
  debugLog: string;
  requestKinds: string[];
}

const lineCount = (path: string): number =>
  existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(Boolean).length : 0;

async function runOnceUncached(): Promise<RunOutcome> {
  // The exact Allow `case 'prompt'` returns (`continueWith(undefined, true)` on an unrewritten input).
  const { buildClaudePreToolUseContinue } = await import('../claude-agent.ts');
  const allowAfterCard = () => buildClaudePreToolUseContinue({})(undefined, true);

  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'claude-f1901-cwd-')));
  const configDir = mkdtempSync(join(tmpdir(), 'claude-f1901-cfg-'));
  const debugFile = join(configDir, 'claude-debug.txt');
  const requestKinds: string[] = [];
  const stub = await startStub(dir, requestKinds);
  const sdk = await import('@anthropic-ai/claude-agent-sdk');

  const outcome: RunOutcome = {
    version: null, workerWrites: 0, forkWrites: 0, subagentIds: [], workerCall: undefined, forkCall: undefined,
    postFired: [], forkAnswer: undefined, debugLog: '', requestKinds,
  };
  let markForkAnswered!: () => void;
  const forkAnswered = new Promise<void>(resolve => { markForkAnswered = resolve; });
  let markWorkerRan!: () => void;
  const workerRan = new Promise<void>(resolve => { markWorkerRan = resolve; });
  const budget = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !/^(CLAUDE|ANTHROPIC)/i.test(key)),
  ) as Record<string, string>;

  // Streaming input: a string prompt closes the child at the first `result` and takes the background worker with it.
  async function* prompt(): AsyncGenerator<unknown> {
    yield { type: 'user', message: { role: 'user', content: MAIN_PROMPT }, parent_tool_use_id: null, session_id: '' };
    await Promise.race([Promise.all([forkAnswered, workerRan]), budget(150_000)]);
    await budget(3_000); // let the worker's turn and the fork settle before the child's stdin closes
  }

  const recordPost = async (input: unknown) => {
    const hook = input as HookInput;
    if (hook.tool_use_id) outcome.postFired.push(hook.tool_use_id);
    if (hook.tool_use_id === 'toolu_f1901_worker') markWorkerRan();
    return { continue: true };
  };

  const query = sdk.query({
    prompt: prompt() as never,
    options: {
      cwd: dir,
      model: MODEL,
      settingSources: [],
      permissionMode: 'default',
      pathToClaudeCodeExecutable: BINARY ?? undefined,
      agentProgressSummaries: true,
      // Allow-all at the query level: if the fork's call reached THIS callback instead of the fork's own, it would run.
      canUseTool: async (_toolName: string, input: Record<string, unknown>) => ({ behavior: 'allow', updatedInput: input }),
      hooks: {
        SubagentStart: [{ hooks: [async (input: unknown) => {
          const id = (input as { agent_id?: unknown }).agent_id;
          if (typeof id === 'string') outcome.subagentIds.push(id);
          return { continue: true };
        }] }],
        PostToolUse: [{ hooks: [recordPost] }],
        PostToolUseFailure: [{ hooks: [recordPost] }],
        PreToolUse: [{ hooks: [async (input: unknown) => {
          const hook = input as HookInput;
          const command = hook.tool_input?.command ?? '';
          if (command.includes('worker-marker')) {
            outcome.workerCall = hook;
            // The worker's card stays pending until the fork's card has been answered — SIT-ac's order.
            await Promise.race([forkAnswered, budget(90_000)]);
            return allowAfterCard();
          }
          if (command.includes('fork-marker')) {
            outcome.forkCall ??= hook;
            const answer = allowAfterCard();
            outcome.forkAnswer ??= answer;
            setTimeout(markForkAnswered, 3_000); // time for the resolver to run the command, if it would
            return answer;
          }
          return allowAfterCard();
        }] }],
      },
      env: {
        ...inherited,
        CLAUDE_CONFIG_DIR: configDir,
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${stub.port}`,
        ANTHROPIC_API_KEY: 'not-needed',
        CLAUDE_CODE_OAUTH_TOKEN: '',
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        // The binary's own debug file (see `session-debug-log.ts` for the enable chain), read for the resolver's line.
        DEBUG_SDK: '1',
        CLAUDE_CODE_DEBUG_LOGS_DIR: debugFile,
      },
    } as never,
  });

  try {
    for await (const message of query) {
      const typed = message as { type: string; subtype?: string; claude_code_version?: string };
      if (typed.type === 'system' && typed.subtype === 'init') outcome.version = typed.claude_code_version ?? null;
    }
  } finally {
    await stub.close();
  }
  outcome.workerWrites = lineCount(join(dir, 'worker-marker.txt'));
  outcome.forkWrites = lineCount(join(dir, 'fork-marker.txt'));
  outcome.debugLog = existsSync(debugFile) ? readFileSync(debugFile, 'utf8') : '';
  return outcome;
}

let sharedRun: Promise<RunOutcome> | undefined;
const runOnce = (): Promise<RunOutcome> => (sharedRun ??= runOnceUncached());

describe.skipIf(!ENABLED)('F1.901 — an Allow on the summary fork\'s card, on the vendored binary', () => {
  test('the fork\'s re-emitted command does NOT run on our Allow; the worker\'s own call runs once', async () => {
    const run = await runOnce();

    // Control 1: the child that answered is the bundle this measurement names.
    expect(run.version).toBe(MEASURED_CLAUDE_CODE_VERSION);
    // Control 2: the scenario happened — the summary fork asked, re-emitted the call and our hook answered it Allow.
    expect(run.requestKinds).toContain('summary');
    expect(run.forkCall?.tool_input?.command).toContain('fork-marker');
    expect(run.forkAnswer).toEqual({
      continue: true,
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' },
    });
    // Control 3 (the positive half on the same rig): the worker's call, answered with the SAME Allow, ran once.
    expect(run.workerWrites).toBe(1);
    expect(run.postFired).toContain('toolu_f1901_worker');

    // THE MEASUREMENT: the fork's command never ran and never reached a post-event.
    expect(run.forkWrites).toBe(0);
    expect(run.postFired.filter(id => id.startsWith('toolu_f1901_fork_'))).toEqual([]);
    // And why, in the binary's own words: a hook allow inside the fork still has to pass the fork's canUseTool.
    expect(run.debugLog).toContain('Hook approved tool use for Bash, but canUseTool is required');
    expect(run.debugLog).toContain('Forked agent [agent_summary]');
  }, 240_000);

  test('the fork\'s hook input: a fresh agent_id, no agent_type, its own tool_use_id', async () => {
    const run = await runOnce();
    expect(run.version).toBe(MEASURED_CLAUDE_CODE_VERSION);
    const worker = run.workerCall;
    const fork = run.forkCall;
    expect(worker).toBeDefined();
    expect(fork).toBeDefined();
    // The worker is an Agent-tool subagent: announced by SubagentStart, typed.
    expect(run.subagentIds).toContain(String(worker?.agent_id));
    expect(worker?.agent_type).toBe('general-purpose');
    // The fork is NOT that subagent, and nothing types it — the shape every forked helper shares.
    expect(typeof fork?.agent_id).toBe('string');
    expect(fork?.agent_id).not.toBe(worker?.agent_id);
    expect(run.subagentIds).not.toContain(String(fork?.agent_id));
    expect(Object.keys(fork ?? {})).not.toContain('agent_type');
    expect(fork?.tool_use_id).not.toBe(worker?.tool_use_id);
  }, 240_000);
});

describe('F1.901 — the bundle the recorded run names (ungated)', () => {
  test('still the bundle the recording was taken against — re-run the gated arms if this is red', () => {
    const require_ = createRequire(import.meta.url);
    const manifest = JSON.parse(readFileSync(require_.resolve('@anthropic-ai/claude-agent-sdk/package.json'), 'utf8')) as {
      claudeCodeVersion?: string;
    };
    expect(manifest.claudeCodeVersion).toBe(MEASURED_CLAUDE_CODE_VERSION);
  });
});
