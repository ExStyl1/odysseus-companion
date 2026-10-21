/**
 * F1.187 (origin WJ-h P-WJ-h-2) — WHICH hook event the vendored binary fires
 * for a Bash call that ran and exited non-zero, measured through the real hook
 * dispatch rather than read off a page.
 *
 * ## Why this is a question at all
 *
 * F1.96 moved claude's read-before-write credit for a Bash file viewer to the
 * `PostToolUse` hook, on the page's own sentence — `hooks.md`'s event table
 * reads *"`PostToolUse` | After a tool call succeeds"* with
 * *"`PostToolUseFailure` | After a tool call fails"* on the next line — and kept
 * `readCreditingToolResultSucceeded` as a defensive second half with a RESIDUE:
 * a viewer whose process exits non-zero while the runtime still reports the call
 * as a success would credit. That residue closes only if a non-zero exit is
 * routed to the FAILING twin, and nothing in this fork had ever read the twin.
 * `hooks.md#posttoolusefailure-input` says it is: *"For Bash and PowerShell, a
 * command that ran and exited produces a first line `Exit code N`"*, and *"A
 * payload may also carry a bare failure message with no exit-code line, when
 * Claude Code could not start the shell process itself"*. For claude the page is
 * the contract, and this file checks OUR reading of it against the binary we
 * ship, the way the row's control asks.
 *
 * ## The rig
 *
 * The stub upstream (the shape `claude-denied-path-search-results-e2e.test.ts`
 * uses) answers each tool-carrying request with the next Bash call in a fixed
 * script, then ends the turn. A rig hook is registered on BOTH events and
 * records which one fired for which `tool_use_id`. Every call in the script is a
 * shape the credit can meet: the three viewer-shaped commands (`cat`, `nl`, and
 * `bat` when this machine has no `bat`) are exactly the ones
 * `bareFileViewerOperand` credits; `false` and an absent binary are the row's
 * own two failure classes; `grep` with no match is the one call that exits
 * non-zero AND is not a failure to Claude Code, which is what the residue
 * paragraph is about.
 *
 * The binary is PINNED to the one we vendor and the env is scrubbed of every
 * `CLAUDE*`/`ANTHROPIC*` key, for the reason the sibling file gives: a probe
 * launched from inside a Claude Code session would otherwise measure a different
 * binary than the app ships.
 *
 * **Gated on `NESSY_CLAUDE_SDK_E2E=1`** — the native binary is an optional
 * dependency, so a committed test that spawns it is a recorded local run, not a
 * CI gate. The ungated arms below pin the bundle the recorded run was taken
 * against, so a lift reddens here and says to re-run it.
 *
 *   NESSY_CLAUDE_SDK_E2E=1 bun test ./packages/shared/src/agent/__tests__/claude-post-tool-use-failure-e2e.test.ts
 */
import { describe, expect, setDefaultTimeout, test } from 'bun:test';

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { bareFileViewerOperand, readCreditingToolResultSucceeded } from '../core/read-before-write.ts';

// The budget belongs to the FILE: the first ungated arm pays the module graph.
setDefaultTimeout(60_000);

const MODEL = 'tgpt/qwen35-397b-a17b-fp8';

/** The bundle the recorded run below was taken against (2.1.251 → 2.1.267 by F1.255, → 2.1.274 by F1.1213, → 2.1.280 by UA12.211, each on a DRIVEN gated run). */
const MEASURED_CLAUDE_CODE_VERSION = '2.1.280';

function vendoredClaudeBinary(): string | null {
  const suffix = process.platform === 'win32' ? 'claude.exe' : 'claude';
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  const pkg = `claude-agent-sdk-${process.platform}-${arch}`;
  try {
    const require_ = createRequire(import.meta.url);
    const sdkRoot = dirname(require_.resolve('@anthropic-ai/claude-agent-sdk/package.json'));
    const candidate = join(dirname(sdkRoot), pkg, suffix);
    return existsSync(candidate) ? candidate : null;
  } catch {
    return null;
  }
}

const BINARY = vendoredClaudeBinary();
const ENABLED = process.env.NESSY_CLAUDE_SDK_E2E === '1' && BINARY !== null;

/** A name no machine carries — the `bat`-absent class without depending on `bat`. */
const ABSENT_VIEWER = 'nessy-f1187-absent-viewer';
/** `bat` joins the script only where it really is absent, so the arm means what it says. */
const BAT_ABSENT = typeof Bun !== 'undefined' && Bun.which('bat') === null;

interface ScriptedCall {
  key: string;
  command: string;
}

function scriptedCalls(dir: string): ScriptedCall[] {
  const seen = join(dir, 'seen.txt');
  const missing = join(dir, 'no-such-file.txt');
  return [
    { key: 'catOk', command: `cat ${seen}` },
    { key: 'nlOk', command: `nl ${seen}` },
    { key: 'catMissingFile', command: `cat ${missing}` },
    { key: 'false', command: 'false' },
    { key: 'absentBinary', command: `${ABSENT_VIEWER} ${seen}` },
    ...(BAT_ABSENT ? [{ key: 'batAbsent', command: `bat ${seen}` }] : []),
    { key: 'grepNoMatch', command: `grep NESSY_F1187_NEVER_PRESENT ${seen}` },
  ];
}

interface Fired {
  event: string;
  toolUseId: string;
  command: string;
  error?: unknown;
  isInterrupt?: unknown;
  response?: unknown;
}

async function startStub(calls: ScriptedCall[]): Promise<{ port: number; close: () => Promise<void> }> {
  let step = 0;
  const server: Server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const path = (req.url ?? '').replace(/\?.*$/, '');
    if (req.method !== 'POST' || !path.endsWith('/messages')) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: `stub: ${path}` } }));
      return;
    }
    let body: { model?: string; tools?: unknown[] } = {};
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as typeof body;
    } catch { /* a malformed body is still a request */ }
    const toolCount = Array.isArray(body.tools) ? body.tools.length : 0;

    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const frame = (type: string, data: unknown) => res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
    frame('message_start', { type: 'message_start', message: { id: `msg_stub_${step}`, type: 'message', role: 'assistant', model: body.model ?? MODEL, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } });
    if (toolCount > 0 && step < calls.length) {
      const call = calls[step]!;
      const useId = `toolu_${call.key}`;
      step += 1;
      frame('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: useId, name: 'Bash', input: {} } });
      frame('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ command: call.command, description: call.key }) } });
      frame('content_block_stop', { type: 'content_block_stop', index: 0 });
      frame('message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 5 } });
    } else {
      frame('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
      frame('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'done' } });
      frame('content_block_stop', { type: 'content_block_stop', index: 0 });
      frame('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 2 } });
    }
    frame('message_stop', { type: 'message_stop' });
    res.end();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  return {
    port: (server.address() as { port: number }).port,
    close: () => new Promise<void>(resolve => server.close(() => resolve())),
  };
}

interface RunOutcome {
  version: string | null;
  /** Keyed by the scripted call's key: every event that fired for it, in order. */
  fired: Record<string, Fired[]>;
  calls: ScriptedCall[];
}

async function runScript(): Promise<RunOutcome> {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'claude-f1187-cwd-')));
  writeFileSync(join(cwd, 'seen.txt'), 'a line the viewer prints\n', 'utf8');
  const calls = scriptedCalls(cwd);
  const stub = await startStub(calls);
  const configDir = mkdtempSync(join(tmpdir(), 'claude-f1187-cfg-'));
  const sdk = await import('@anthropic-ai/claude-agent-sdk');

  const outcome: RunOutcome = { version: null, fired: {}, calls };
  const record = async (input: unknown) => {
    const hook = input as {
      hook_event_name?: string; tool_use_id?: string; tool_input?: { command?: string };
      error?: unknown; is_interrupt?: unknown; tool_response?: unknown;
    };
    const key = (hook.tool_use_id ?? '').replace(/^toolu_/, '');
    (outcome.fired[key] ??= []).push({
      event: hook.hook_event_name ?? '',
      toolUseId: hook.tool_use_id ?? '',
      command: hook.tool_input?.command ?? '',
      error: hook.error,
      isInterrupt: hook.is_interrupt,
      response: hook.tool_response,
    });
    return { continue: true };
  };

  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !/^(CLAUDE|ANTHROPIC)/i.test(key)),
  ) as Record<string, string>;

  const query = sdk.query({
    prompt: 'run the scripted commands',
    options: {
      cwd,
      model: MODEL,
      settingSources: [],
      permissionMode: 'default',
      pathToClaudeCodeExecutable: BINARY ?? undefined,
      allowedTools: ['Bash'],
      hooks: {
        PostToolUse: [{ hooks: [record] }],
        PostToolUseFailure: [{ hooks: [record] }],
      },
      env: {
        ...inherited,
        CLAUDE_CONFIG_DIR: configDir,
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${stub.port}`,
        ANTHROPIC_API_KEY: 'not-needed',
        CLAUDE_CODE_OAUTH_TOKEN: '',
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      },
    } as never,
  });

  try {
    for await (const message of query) {
      const typed = message as { type: string; subtype?: string; claude_code_version?: string };
      if (typed.type === 'system' && typed.subtype === 'init') outcome.version = typed.claude_code_version ?? null;
      if (typed.type === 'result') break;
    }
  } finally {
    await stub.close();
  }
  return outcome;
}

/** One run serves both gated arms: a turn through the binary is the file's whole cost. */
let sharedRun: Promise<RunOutcome> | undefined;
const runOnce = (): Promise<RunOutcome> => (sharedRun ??= runScript());

/** The one event each call produced, or a marker naming why there is not exactly one. */
function onlyEvent(outcome: RunOutcome, key: string): string {
  const fired = outcome.fired[key] ?? [];
  if (fired.length !== 1) return `${fired.length} events: ${fired.map(f => f.event).join(',')}`;
  return fired[0]!.event;
}

function firstErrorLine(outcome: RunOutcome, key: string): string {
  const error = outcome.fired[key]?.[0]?.error;
  return typeof error === 'string' ? (error.split('\n')[0] ?? '') : `<${typeof error}>`;
}

describe.skipIf(!ENABLED)('F1.187 — which event a Bash call fires, on the vendored binary', () => {
  test('a viewer that ran and exited 0 fires PostToolUse; every non-zero viewer fires the FAILING twin', async () => {
    const run = await runOnce();

    // Control 1: the child that answered is the bundle this measurement names.
    expect(run.version).toBe(MEASURED_CLAUDE_CODE_VERSION);
    // Control 2: every scripted call reached a post-event — so an event missing
    // below is a routing answer, not a turn that ended early.
    for (const call of run.calls) expect(run.fired[call.key]?.length ?? 0).toBeGreaterThan(0);

    expect({
      catOk: onlyEvent(run, 'catOk'),
      nlOk: onlyEvent(run, 'nlOk'),
      catMissingFile: onlyEvent(run, 'catMissingFile'),
      false: onlyEvent(run, 'false'),
      absentBinary: onlyEvent(run, 'absentBinary'),
      ...(BAT_ABSENT ? { batAbsent: onlyEvent(run, 'batAbsent') } : {}),
    }).toEqual({
      catOk: 'PostToolUse',
      nlOk: 'PostToolUse',
      catMissingFile: 'PostToolUseFailure',
      false: 'PostToolUseFailure',
      absentBinary: 'PostToolUseFailure',
      ...(BAT_ABSENT ? { batAbsent: 'PostToolUseFailure' } : {}),
    });

    // The failing twin carries the page's `error: string`, first line `Exit code N`.
    expect(firstErrorLine(run, 'false')).toBe('Exit code 1');
    expect(firstErrorLine(run, 'catMissingFile')).toBe('Exit code 1');
    expect(firstErrorLine(run, 'absentBinary')).toBe('Exit code 127');

    // The success twin's real response shape is one the defensive predicate
    // reads as a success — so the predicate cannot be what refuses a good read.
    const catResponse = run.fired.catOk?.[0]?.response;
    expect(readCreditingToolResultSucceeded(catResponse)).toBe(true);
    // And the viewer-shaped commands really are the ones the credit reads.
    expect(bareFileViewerOperand(run.fired.catOk?.[0]?.command ?? '')).toBeDefined();
    expect(bareFileViewerOperand(run.fired.catMissingFile?.[0]?.command ?? '')).toBeDefined();
  }, 180_000);

  test('the residue class exists: `grep` with no match exits 1 and is still PostToolUse', async () => {
    const run = await runOnce();
    expect(run.version).toBe(MEASURED_CLAUDE_CODE_VERSION);
    // Claude Code reads `grep`'s exit 1 as "no match", not as a failure — the
    // one shape where the EVENT says success while the process said non-zero.
    // None of the four credited viewers is in that class (the arm above), and
    // `grep` is not a viewer, so it credits nothing either way; this arm keeps
    // the residue paragraph of `readCreditingToolResultSucceeded` measured
    // rather than hypothetical.
    expect(onlyEvent(run, 'grepNoMatch')).toBe('PostToolUse');
    expect(bareFileViewerOperand(run.fired.grepNoMatch?.[0]?.command ?? '')).toBeUndefined();
  }, 180_000);
});

describe('F1.187 — the bundle the recorded run names (ungated)', () => {
  test('control: the vendored SDK manifest is readable', () => {
    const require_ = createRequire(import.meta.url);
    const manifest = JSON.parse(readFileSync(require_.resolve('@anthropic-ai/claude-agent-sdk/package.json'), 'utf8')) as {
      claudeCodeVersion?: string;
    };
    expect(typeof manifest.claudeCodeVersion).toBe('string');
  });

  test('still the bundle the recording was taken against — re-run the gated arms if this is red', () => {
    const require_ = createRequire(import.meta.url);
    const manifest = JSON.parse(readFileSync(require_.resolve('@anthropic-ai/claude-agent-sdk/package.json'), 'utf8')) as {
      claudeCodeVersion?: string;
    };
    expect(manifest.claudeCodeVersion).toBe(MEASURED_CLAUDE_CODE_VERSION);
  });
});
