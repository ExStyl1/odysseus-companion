/**
 * F1.117 (origin WI-by, verifier 3's refinement (b) of finding #19) — can a
 * memory switch flipped MID-SESSION reach a claude child that is already running,
 * through the runtime's own mechanism? Measured on the vendored binary.
 *
 * ## The question native-first asks first
 *
 * This fork closes the child's auto memory with `CLAUDE_CODE_DISABLE_AUTO_MEMORY`
 * in the spawn ENVIRONMENT (`applyAutoMemoryOffSwitch`, `agent/options.ts`), and
 * an environment cannot reach a process that is already running. The SDK does
 * have a live route: `Query.applyFlagSettings` merges a partial `Settings` into
 * the flag layer of a running child (`sdk.d.ts`), and `Settings` carries
 * `autoMemoryEnabled`, which `settings-reference.md#automemoryenabled` says the
 * `/memory` toggle writes "during a session". If that route moved a running
 * child, the host could carry a flip without a respawn.
 *
 * ## What the binary does, measured
 *
 * The observable is the child's own system prompt: with auto memory on, the
 * `claude_code` preset carries the auto-memory instructions (the `MEMORY.md`
 * index and the per-project `/memory/` directory are named in it); with it off
 * they are absent. The stub upstream records every tool-carrying request.
 *
 * | Arm | First request | Next turn, same child |
 * | --- | --- | --- |
 * | spawned with the variable `=1` | no section | — |
 * | spawned without it | section | — |
 * | `applyFlagSettings({ autoMemoryEnabled: false })` BEFORE the first prompt | **no section** | — |
 * | the same call AFTER the first turn | section | **section, still** |
 *
 * So the key IS honoured through the live route (row three is the positive
 * control that the call reached the child and was read), and it is read ONCE:
 * after the child's first request the section is fixed for that child's life,
 * and a live flip moves nothing the model sees. Driven 2026-09-23 on 2.1.251
 * (both self-reports agree), four arms, one run each.
 *
 * ## What that decides
 *
 * The respawn is the mechanism, and it already exists: `env` is hashed into
 * `claudeLiveSessionSignature`, so a flip changes the next turn's signature and
 * `ensureLiveSession` rebuilds the child — pinned by
 * `claude-auto-memory-flip-respawn.test.ts`. What no mechanism closes is the
 * turn already in flight when the switch moves; that residue is written beside
 * the respawn in `claude-agent.ts` (`ensureLiveSession`).
 *
 * If a later SDK makes the live route reach a running child, the last arm goes
 * RED, and that red is good news: the host could then carry a flip without a
 * respawn.
 *
 * **Gated on `NESSY_CLAUDE_SDK_E2E=1`** (the native binary is an optional
 * dependency, so this is a recorded local run, not a CI gate):
 *
 *   NESSY_CLAUDE_SDK_E2E=1 bun test ./packages/shared/src/agent/__tests__/claude-auto-memory-live-flip-e2e.test.ts
 */
import { describe, expect, setDefaultTimeout, test } from 'bun:test';

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

// The budget belongs to the FILE: the first ungated arm pays the module graph.
setDefaultTimeout(60_000);

const MODEL = 'tgpt/qwen35-397b-a17b-fp8';
// 2.1.251 → 2.1.267 by F1.255 (2026-09-24), moved on a DRIVEN gated run.
// 2.1.267 → 2.1.274 by F1.1213 (2026-10-01), the same way.
// 2.1.274 → 2.1.280 by UA12.211 (2026-10-10), the same way.
const MEASURED_CLAUDE_CODE_VERSION = '2.1.280';
const VARIABLE = 'CLAUDE_CODE_DISABLE_AUTO_MEMORY';

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

/** How many times the request's system prompt names the auto-memory index. */
function memorySectionMarks(system: unknown): number {
  return JSON.stringify(system ?? '').split('MEMORY.md').length - 1;
}

async function startStub(systems: unknown[]): Promise<{ port: number; close: () => Promise<void> }> {
  const server: Server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const path = (req.url ?? '').replace(/\?.*$/, '');
    if (req.method !== 'POST' || !path.endsWith('/messages')) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: `stub: ${path}` } }));
      return;
    }
    let body: { model?: string; tools?: unknown[]; system?: unknown } = {};
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as typeof body;
    } catch { /* a malformed body is still a request */ }
    // Only the agent's own turn requests carry tools; side requests (titles,
    // classifiers) do not and are not what this measures.
    if (Array.isArray(body.tools) && body.tools.length > 0) systems.push(body.system);

    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const frame = (type: string, data: unknown) => res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
    frame('message_start', { type: 'message_start', message: { id: `msg_stub_${systems.length}`, type: 'message', role: 'assistant', model: body.model ?? MODEL, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } });
    frame('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
    frame('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'done' } });
    frame('content_block_stop', { type: 'content_block_stop', index: 0 });
    frame('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 2 } });
    frame('message_stop', { type: 'message_stop' });
    res.end();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  return {
    port: (server.address() as { port: number }).port,
    close: () => new Promise<void>(resolve => server.close(() => resolve())),
  };
}

type Flip = 'none' | 'before-first-prompt' | 'after-first-turn';

interface Outcome {
  version: string | null;
  /** `MEMORY.md` marks per turn request, in order. */
  marks: number[];
}

async function runChild(opts: { spawnedOff: boolean; flip: Flip; turns: 1 | 2 }): Promise<Outcome> {
  const systems: unknown[] = [];
  const stub = await startStub(systems);
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'claude-f1117-cwd-')));
  const configDir = mkdtempSync(join(tmpdir(), 'claude-f1117-cfg-'));
  const sdk = await import('@anthropic-ai/claude-agent-sdk');
  const outcome: Outcome = { version: null, marks: [] };

  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !/^(CLAUDE|ANTHROPIC)/i.test(key)),
  ) as Record<string, string>;

  let firstTurnDone!: () => void;
  const firstTurn = new Promise<void>(resolve => { firstTurnDone = resolve; });
  type LiveQuery = { applyFlagSettings(settings: Record<string, unknown>): Promise<void> } & AsyncIterable<unknown>;
  let query: LiveQuery | undefined;

  const user = (text: string) => ({
    type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null, session_id: '',
  });
  async function* prompts() {
    // The SDK may start reading this generator before `sdk.query` has returned,
    // so the handle is waited for rather than assumed (a first draft called it
    // on `undefined` and the child was aborted).
    while (!query) await new Promise(resolve => setTimeout(resolve, 10));
    // Awaited control requests: the child has read the flag before it sees the
    // prompt, so the order below is the order the child observes.
    if (opts.flip === 'before-first-prompt') await query.applyFlagSettings({ autoMemoryEnabled: false });
    yield user('first');
    if (opts.turns === 1) return;
    await firstTurn;
    if (opts.flip === 'after-first-turn') await query.applyFlagSettings({ autoMemoryEnabled: false });
    yield user('second');
  }

  query = sdk.query({
    prompt: prompts() as never,
    options: {
      cwd,
      model: MODEL,
      settingSources: [],
      // The preset is what carries the auto-memory instructions at all; the
      // bare SDK default prompt carries none in either state.
      systemPrompt: { type: 'preset', preset: 'claude_code' },
      permissionMode: 'default',
      pathToClaudeCodeExecutable: BINARY ?? undefined,
      env: {
        ...inherited,
        CLAUDE_CONFIG_DIR: configDir,
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${stub.port}`,
        ANTHROPIC_API_KEY: 'not-needed',
        CLAUDE_CODE_OAUTH_TOKEN: '',
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        ...(opts.spawnedOff ? { [VARIABLE]: '1' } : {}),
      },
    } as never,
  }) as unknown as LiveQuery;
  const live: LiveQuery = query;

  let results = 0;
  try {
    for await (const message of live) {
      const typed = message as { type: string; subtype?: string; claude_code_version?: string };
      if (typed.type === 'system' && typed.subtype === 'init') outcome.version = typed.claude_code_version ?? null;
      if (typed.type === 'result') {
        results += 1;
        if (results === 1) firstTurnDone();
        if (results >= opts.turns) break;
      }
    }
  } finally {
    await stub.close();
  }
  outcome.marks = systems.map(memorySectionMarks);
  return outcome;
}

describe.skipIf(!ENABLED)('F1.117 — a running claude child and the auto-memory switch, vendored binary', () => {
  test('CONTROL: the section is the observable — present when spawned on, absent when spawned off', async () => {
    const on = await runChild({ spawnedOff: false, flip: 'none', turns: 1 });
    const off = await runChild({ spawnedOff: true, flip: 'none', turns: 1 });
    expect(on.version).toBe(MEASURED_CLAUDE_CODE_VERSION);
    expect(on.marks.length).toBeGreaterThan(0);
    expect(on.marks[0]).toBeGreaterThan(0);
    expect(off.marks[0]).toBe(0);
  }, 180_000);

  test('the live route IS read — a flag applied before the first prompt closes the section', async () => {
    const run = await runChild({ spawnedOff: false, flip: 'before-first-prompt', turns: 1 });
    expect(run.version).toBe(MEASURED_CLAUDE_CODE_VERSION);
    expect(run.marks[0]).toBe(0);
  }, 180_000);

  test('and it is read ONCE — the same flag after the first turn leaves the next turn\'s section in place', async () => {
    const run = await runChild({ spawnedOff: false, flip: 'after-first-turn', turns: 2 });
    expect(run.version).toBe(MEASURED_CLAUDE_CODE_VERSION);
    expect(run.marks).toHaveLength(2);
    // Turn one was built with memory on, as spawned.
    expect(run.marks[0]).toBeGreaterThan(0);
    // Turn two, same child, flag already applied: the section is still there.
    // Red here means a later SDK made the live route reach a running child.
    expect(run.marks[1]).toBeGreaterThan(0);
  }, 180_000);
});

describe('F1.117 — the bundle the recorded run names (ungated)', () => {
  test('still the bundle the recording was taken against — re-run the gated arms if this is red', () => {
    const require_ = createRequire(import.meta.url);
    const manifest = JSON.parse(readFileSync(require_.resolve('@anthropic-ai/claude-agent-sdk/package.json'), 'utf8')) as {
      claudeCodeVersion?: string;
    };
    expect(manifest.claudeCodeVersion).toBe(MEASURED_CLAUDE_CODE_VERSION);
  });
});
