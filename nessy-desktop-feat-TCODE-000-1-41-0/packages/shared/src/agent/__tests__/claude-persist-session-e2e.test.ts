/**
 * C3.69's MEASUREMENT — does `persistSession: false` actually stop the vendor
 * writing its own transcript, and what does it cost?
 *
 * A type is not a behaviour. `sdk.d.ts` declaring the option proves only that we
 * can pass it; the row's own done-means is a reading of the per-workspace
 * `CLAUDE_CONFIG_DIR` tree before and after a turn, with the setting-off arm as
 * the control showing the file appears. That is what this file does.
 *
 * It runs entirely OFFLINE, on the rig `claude-transcript-resume-e2e.test.ts`
 * established: the SDK speaks Anthropic Messages to whatever `ANTHROPIC_BASE_URL`
 * names, so the upstream here is a loopback stub that answers one canned SSE
 * stream. No network, no credentials, no gateway — and `CLAUDE_CONFIG_DIR` is a
 * fresh temp directory per ARM, so the two arms cannot see each other's files
 * and nothing from the developer's own machine is read or written.
 *
 * **Gated on `NESSY_CLAUDE_SDK_E2E=1`**, following the same rule that file
 * records: the native binary is a ~290 MB optional dependency, so a committed
 * test that spawns it is a recorded local run rather than a CI gate.
 *
 *   NESSY_CLAUDE_SDK_E2E=1 bun test ./packages/shared/src/agent/__tests__/claude-persist-session-e2e.test.ts
 *
 * ## What was measured, 2026-09-11, vendored `0.3.247` / `2.1.247`
 *
 *  - CONTROL arm (no option): after one turn the tree holds exactly one file,
 *    `projects/<projectKey>/<sdkSessionId>.jsonl`, and the `<sdkSessionId>` in
 *    its name is the `session_id` the child reported on `system`/`init`.
 *  - SWITCH arm (`persistSession: false`): the same turn completes, the child
 *    still reports a `session_id`, and NO `.jsonl` is written anywhere under the
 *    config dir.
 *  - COST arm: a second `query()` resuming the switch arm's own session id does
 *    NOT resume it, exactly as the vendor's sentence says ("cannot be resumed
 *    later") — and the refusal is harder than the sibling rig's missing-file
 *    control, which comes back under a different session id: here the child
 *    never reaches `system`/`init` at all. That is the property
 *    `ClaudeAgent.ensureLiveSession`'s respawn path would meet MID-SESSION, and
 *    it is the cost `getNeverPersistSessions` already announces for resume,
 *    rewind and search.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdtempSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolveClaudeSessionPersistence } from '../claude-session-persistence.ts';
import { MODULE_GRAPH_HOOK_BUDGET_MS } from '../../testing/module-graph-budgets.ts';

const ENABLED = process.env.NESSY_CLAUDE_SDK_E2E === '1';

const MODEL = 'tgpt/qwen35-397b-a17b-fp8';

interface StubHandle {
  port: number;
  requests: number;
  close: () => Promise<void>;
}

/** A loopback Anthropic Messages endpoint: count the request, answer a canned stream. */
async function startAnthropicStub(): Promise<StubHandle> {
  const handle: StubHandle = { port: 0, requests: 0, close: async () => {} };
  const server: Server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    for await (const _chunk of req) { /* drain */ }
    const path = (req.url ?? '').replace(/\?.*$/, '');
    if (req.method === 'POST' && path.endsWith('/messages')) {
      handle.requests += 1;
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      const id = `msg_stub_${handle.requests}`;
      const frame = (type: string, data: unknown) =>
        res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
      frame('message_start', { type: 'message_start', message: { id, type: 'message', role: 'assistant', model: MODEL, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } });
      frame('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
      frame('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'STUB_OK' } });
      frame('content_block_stop', { type: 'content_block_stop', index: 0 });
      frame('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 2 } });
      frame('message_stop', { type: 'message_stop' });
      res.end();
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: `stub: ${path}` } }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  handle.port = (server.address() as { port: number }).port;
  handle.close = () => new Promise<void>(resolve => server.close(() => resolve()));
  return handle;
}

/** Every file under `root`, as paths relative to it. Directories are not listed. */
function treeOf(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir)) {
      const absolute = join(dir, entry);
      const relative = prefix === '' ? entry : `${prefix}/${entry}`;
      if (statSync(absolute).isDirectory()) walk(absolute, relative);
      else found.push(relative);
    }
  };
  walk(root, '');
  return found.sort();
}

describe.if(ENABLED)('C3.69 · persistSession: false stops the vendor transcript', () => {
  let stub: StubHandle;
  let cwd: string;
  let sdk: typeof import('@anthropic-ai/claude-agent-sdk');
  const configDirs: string[] = [];

  beforeAll(async () => {
    stub = await startAnthropicStub();
    // Realpathed for the reason the sibling rig records: on macOS `$TMPDIR` is a
    // symlink into `/private/var/...` and the SDK realpaths the cwd before
    // deriving its project key.
    cwd = realpathSync(mkdtempSync(join(tmpdir(), 'claude-persist-e2e-cwd-')));
    sdk = await import('@anthropic-ai/claude-agent-sdk');
    // The SDK import is a module-graph cost, not a test cost: on this rig the same
    // bytes have taken seconds or minutes by cache state (AGENTS.md §Traps, the
    // timer lottery), so the hook carries the shared budget rather than bun's 5 s
    // default — `lint:module-graph-hooks` reads the argument's absence as a red.
  }, MODULE_GRAPH_HOOK_BUDGET_MS);

  afterAll(async () => {
    await stub?.close();
    for (const dir of configDirs) rmSync(dir, { recursive: true, force: true });
    if (cwd) rmSync(cwd, { recursive: true, force: true });
  });

  /** A config dir of this arm's own, so the two arms cannot read each other. */
  function freshConfigDir(label: string): string {
    const dir = mkdtempSync(join(tmpdir(), `claude-persist-e2e-${label}-`));
    configDirs.push(dir);
    return dir;
  }

  function baseOptions(configDir: string): Record<string, unknown> {
    return {
      cwd,
      model: MODEL,
      // Nothing from the developer's own machine may reach this run.
      settingSources: [] as never[],
      permissionMode: 'bypassPermissions' as const,
      env: {
        ...process.env,
        CLAUDE_CONFIG_DIR: configDir,
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${stub.port}`,
        ANTHROPIC_API_KEY: 'sk-ant-stub-not-a-real-key',
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      },
    };
  }

  interface TurnOutcome {
    initSessionId: string | null;
    resultSubtype: string | null;
    /**
     * The child can also refuse a turn by THROWING out of the iterator, and a
     * rig that let that escape would report the refusal as a harness bug. The
     * COST case below needs to tell the two apart.
     */
    threw: string | null;
  }

  /** Drive one turn; report the init session id, the result subtype and any throw. */
  async function runTurn(
    configDir: string,
    prompt: string,
    extra: Record<string, unknown> = {},
  ): Promise<TurnOutcome> {
    const outcome: TurnOutcome = { initSessionId: null, resultSubtype: null, threw: null };
    try {
      for await (const message of sdk.query({
        prompt,
        options: { ...baseOptions(configDir), ...extra } as never,
      })) {
        const id = (message as { session_id?: string }).session_id;
        const subtype = (message as { subtype?: string }).subtype;
        if (message.type === 'system' && subtype === 'init' && id) outcome.initSessionId = id;
        if (message.type === 'result') { outcome.resultSubtype = subtype ?? null; break; }
      }
    } catch (error) {
      outcome.threw = error instanceof Error ? error.message : String(error);
    }
    return outcome;
  }

  const jsonlOf = (files: string[]): string[] => files.filter(name => name.endsWith('.jsonl'));

  test('CONTROL: without the option, one turn writes the vendor transcript named after the session', async () => {
    const configDir = freshConfigDir('control');
    expect(treeOf(configDir)).toEqual([]);

    const { initSessionId, resultSubtype } = await runTurn(configDir, 'say hi');

    expect(resultSubtype).toBe('success');
    expect(initSessionId).toBeTruthy();

    const transcripts = jsonlOf(treeOf(configDir));
    // The whole point of the control: this arm must show the file APPEARING, or
    // the switch arm's absence proves nothing about the option.
    expect({ count: transcripts.length }).toEqual({ count: 1 });
    expect(transcripts[0]!.startsWith('projects/')).toBe(true);
    expect(transcripts[0]!.endsWith(`/${initSessionId}.jsonl`)).toBe(true);
  }, 180_000);

  test('SWITCH: with persistSession: false the same turn writes NO transcript', async () => {
    const configDir = freshConfigDir('switch');
    expect(treeOf(configDir)).toEqual([]);

    // Passed through the production resolver rather than as a literal, so this
    // measurement is about the thing that actually ships.
    const resolved = resolveClaudeSessionPersistence({ neverPersistSetting: true, env: {} });
    expect(resolved).toEqual({ persistSession: false });

    const { initSessionId, resultSubtype } = await runTurn(configDir, 'say hi', resolved);

    // The turn still RUNS — a switch that broke the session would also produce
    // no transcript, and the two must not be confused.
    expect(resultSubtype).toBe('success');
    expect(initSessionId).toBeTruthy();

    expect({ transcripts: jsonlOf(treeOf(configDir)) }).toEqual({ transcripts: [] });
  }, 180_000);

  test('COST: a session that was never persisted cannot be resumed', async () => {
    // The vendor's own sentence — "cannot be resumed later" — measured, because
    // it is what `ClaudeAgent.ensureLiveSession`'s respawn path would meet
    // MID-SESSION, not only at a later reopen.
    //
    // Measured 2026-09-11 at 2.1.247, and it is HARDER than the sibling rig's
    // negative control for a missing transcript: that one comes back under a
    // different session id, whereas resuming a never-persisted id does not
    // reach `system`/`init` at all — the child refuses the run. Both are "did
    // not resume"; this one additionally means there is no conversation to fall
    // back into, which is why the resolver's docblock states the cost rather
    // than leaving the respawn to discover it.
    const configDir = freshConfigDir('cost');
    const first = await runTurn(configDir, 'say hi', { persistSession: false });
    expect(first.initSessionId).toBeTruthy();
    expect(jsonlOf(treeOf(configDir))).toEqual([]);

    const second = await runTurn(configDir, 'what did I just say?', {
      persistSession: false,
      resume: first.initSessionId,
    });

    // The load-bearing assertion, true under either refusal shape. `second` is
    // carried into the compared value so the runner PRINTS what the child did
    // rather than only that it was not a resume.
    expect({
      resumedTheSameSession: second.initSessionId === first.initSessionId,
      second,
    }).toEqual({ resumedTheSameSession: false, second });

    // …and the shape measured on this bundle, asserted so a future runtime that
    // starts answering with a fresh session instead is a reading someone has to
    // re-take rather than a silent change of what "cannot be resumed" costs.
    expect({ reachedInit: second.initSessionId !== null }).toEqual({ reachedInit: false });
  }, 240_000);
});
