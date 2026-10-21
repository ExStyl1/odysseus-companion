/**
 * T2's PRIMARY GATE — the SDK really does resume a transcript we wrote, and its
 * whole tool-bearing history really does reach the model.
 *
 * `docs/superpowers/plans/2026-08-20-cross-runtime-history-carry.md`, T2, and
 * owner gate **G3-D**.
 *
 * G3-D asked for a mirror-only `sessionStore` attached as a TEST harness, so
 * T2's fixtures would stop being "what we believe the format is" and become
 * "what the SDK's own mirror emitted", with the `projectKey` assertion exact
 * instead of a re-derivation we hope matches. This file does that — and then
 * goes past it, because the mirror alone still could not answer the question
 * the whole task rests on: **does a file we author get loaded, and does the
 * model see it?**
 *
 * It runs entirely OFFLINE. The Claude SDK talks Anthropic Messages to whatever
 * `ANTHROPIC_BASE_URL` names, so the upstream here is a ~60-line loopback stub
 * that records every request body and answers a canned SSE stream. No network,
 * no credentials, no gateway. That is the same rig `codex-inject-items-e2e.test.ts`
 * uses on the Codex side, for the same reason: what needs proving is what goes
 * on the wire, and a stub is a better instrument for that than a real model.
 *
 * Four properties, each of which a weaker rig would miss:
 *
 * 1. **The SDK's own `projectKey` for a real session equals our derivation** —
 *    captured off the mirror store, which is G3-D's deliverable exactly.
 * 2. **A transcript written by `writeClaudeTranscript` RESUMES**: the SDK
 *    reports back the session id we minted rather than starting a new one.
 *    This is also the signal `ClaudeAgent.confirmRebuiltTranscriptResume`
 *    reads, so this test is the evidence that the read-back arm's comparison
 *    means what it claims.
 * 3. **The rebuilt history reaches the MODEL** — the paired `tool_use` /
 *    `tool_result`, in order, ahead of the new user message, with a fact that
 *    exists only in the tool result. A transcript the loader accepts but does
 *    not put on the wire would pass every other test in this task.
 * 4. **The negative control**: resuming an id with NO file on disk yields a
 *    DIFFERENT session id and none of the history. Without this row, property
 *    2 could be true of any resume at all.
 *
 * **Gated on `NESSY_CLAUDE_SDK_E2E=1`**, following `codex-e2e.test.ts` and A8's
 * rule: the native binary is a 272 MB optional dependency, so a committed test
 * that spawns it is a recorded local run, not a CI gate.
 *
 *   NESSY_CLAUDE_SDK_E2E=1 bun test packages/shared/src/agent/__tests__/claude-transcript-resume-e2e.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildClaudeTranscriptRecords,
  claudeProjectKeyForCwd,
  claudeTranscriptPath,
  mintClaudeSdkSessionId,
  readClaudeCliVersion,
  writeClaudeTranscript,
} from '../claude-transcript-rebuild.ts';
import type { RuntimeHandoffHistoryItem } from '../backend/types.ts';

const ENABLED = process.env.NESSY_CLAUDE_SDK_E2E === '1';

/** Lives only in a TOOL RESULT — unreachable to a model that got prose only. */
const TOOL_ONLY_FACT = 'the fixture port is 8123';
const CALL_ID = 'nessy_handoff_e2e_read';
const MODEL = 'tgpt/qwen35-397b-a17b-fp8';

interface StubHandle {
  port: number;
  bodies: string[];
  close: () => Promise<void>;
}

/** A loopback Anthropic Messages endpoint: record the request, answer a canned stream. */
async function startAnthropicStub(): Promise<StubHandle> {
  const bodies: string[] = [];
  const server: Server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const path = (req.url ?? '').replace(/\?.*$/, '');
    if (req.method === 'POST' && path.endsWith('/messages')) {
      bodies.push(Buffer.concat(chunks).toString('utf8'));
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      const id = `msg_stub_${bodies.length}`;
      const frame = (type: string, data: unknown) => res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
      frame('message_start', { type: 'message_start', message: { id, type: 'message', role: 'assistant', model: MODEL, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } });
      frame('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
      frame('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'STUB_OK' } });
      frame('content_block_stop', { type: 'content_block_stop', index: 0 });
      frame('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 2 } });
      frame('message_stop', { type: 'message_stop' });
      res.end();
      return;
    }
    // `/v1/messages/count_tokens` and everything else: a 404 the SDK degrades
    // past, exactly as our own local adapter answers it.
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: `stub: ${path}` } }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as { port: number }).port;
  return { port, bodies, close: () => new Promise<void>(resolve => server.close(() => resolve())) };
}

const HISTORY: RuntimeHandoffHistoryItem[] = [
  { kind: 'message', role: 'user', content: 'read config.json and tell me the port', timestamp: 1_760_000_000_000, runtime: 'pi' },
  { kind: 'message', role: 'assistant', content: 'reading it now', timestamp: 1_760_000_001_000, runtime: 'pi' },
  {
    kind: 'tool',
    callId: CALL_ID,
    name: 'Read',
    input: { file_path: '/tmp/config.json' },
    output: TOOL_ONLY_FACT,
    timestamp: 1_760_000_002_000,
    runtime: 'pi',
  },
  { kind: 'message', role: 'assistant', content: 'I have read it.', timestamp: 1_760_000_003_000, runtime: 'pi' },
];

describe.if(ENABLED)('a rebuilt transcript resumes, and the model reads it', () => {
  let stub: StubHandle;
  let configDir: string;
  let cwd: string;
  let sdk: typeof import('@anthropic-ai/claude-agent-sdk');

  beforeAll(async () => {
    stub = await startAnthropicStub();
    configDir = mkdtempSync(join(tmpdir(), 'claude-rebuild-e2e-cfg-'));
    // Realpathed here on purpose: on macOS `$TMPDIR` is a symlink into
    // `/private/var/...`, and the SDK realpaths the cwd before deriving its
    // project key. Handing the un-realpathed form to `query()` and the
    // realpathed one to our own derivation would make this test agree with
    // itself for the wrong reason.
    cwd = realpathSync(mkdtempSync(join(tmpdir(), 'claude-rebuild-e2e-cwd-')));
    sdk = await import('@anthropic-ai/claude-agent-sdk');
  });

  afterAll(async () => {
    await stub?.close();
    if (configDir) rmSync(configDir, { recursive: true, force: true });
    if (cwd) rmSync(cwd, { recursive: true, force: true });
  });

  const baseOptions = () => ({
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
  });

  interface TurnOutcome {
    /** The last `session_id` any message carried. */
    observed: string | null;
    /** The `session_id` on the `system`/`init` message, or null if the child never reached init. */
    initSessionId: string | null;
    resultSubtype: string | null;
  }

  /** Drive one turn and report the three things the read-back arm can distinguish. */
  async function runTurn(prompt: string, extra: Record<string, unknown> = {}): Promise<TurnOutcome> {
    const outcome: TurnOutcome = { observed: null, initSessionId: null, resultSubtype: null };
    for await (const message of sdk.query({ prompt, options: { ...baseOptions(), ...extra } as never })) {
      const id = (message as { session_id?: string }).session_id;
      if (id) outcome.observed = id;
      const subtype = (message as { subtype?: string }).subtype;
      if (message.type === 'system' && subtype === 'init' && id) outcome.initSessionId = id;
      if (message.type === 'result') { outcome.resultSubtype = subtype ?? null; break; }
    }
    return outcome;
  }

  /**
   * **G3-D.** A mirror-only store — `append` only, `load` answering `null`, and
   * NO `resume`, so the temp-dir redirect the SDK performs for a store-backed
   * resume never fires and local disk stays canonical.
   *
   * What it buys is one exact fact: the `projectKey` the SDK computes for a
   * real session, from the SDK itself rather than from our reading of its
   * minified source.
   */
  test('the SDK\'s own projectKey for a live session is the one we derive', async () => {
    const keys: string[] = [];
    const entryTypes: string[] = [];
    const { observed } = await runTurn('say hi', {
      sessionStore: {
        append: async (key: { projectKey: string; sessionId: string }, entries: Array<{ type: string }>) => {
          keys.push(key.projectKey);
          for (const entry of entries) entryTypes.push(entry.type);
        },
        load: async () => null,
      },
      sessionStoreFlush: 'eager',
    });

    expect(observed).toBeTruthy();
    expect(keys.length).toBeGreaterThan(0);
    expect(new Set(keys).size).toBe(1);
    // The assertion G3-D exists for, and it is an equality rather than a
    // re-derivation: the SDK said this, we compute this.
    expect(keys[0]).toBe(claudeProjectKeyForCwd(cwd));
    // The mirror's entry stream is the writer's own vocabulary, and it is what
    // `sdk-project-keys.json`'s key census was harvested from at rest.
    expect(entryTypes).toContain('user');
    expect(entryTypes).toContain('assistant');
  }, 180_000);

  /**
   * The whole task, on the wire.
   *
   * A transcript this repo authored — records, chaining, envelope and all — is
   * written to the path our own derivation chose, resumed by id, and the
   * request body the SDK sends the model is read back.
   */
  test('a transcript we wrote resumes, and its tool history reaches the model', async () => {
    const sdkSessionId = mintClaudeSdkSessionId();
    const records = buildClaudeTranscriptRecords({
      history: HISTORY,
      cwd,
      sdkSessionId,
      model: MODEL,
      version: readClaudeCliVersion(),
    });
    const filePath = claudeTranscriptPath({ configDir, cwd, sdkSessionId });
    const written = writeClaudeTranscript(filePath, records);
    expect(written.records).toBe(5);

    const before = stub.bodies.length;
    const turn = await runTurn('what was the port?', { resume: sdkSessionId });

    // (2) The resume TOOK, and this is the exact signal
    // `ClaudeAgent.confirmRebuiltTranscriptResume` reads: the child reached
    // `system`/`init` carrying the anchor we handed it. See the negative
    // control below for why it is `init` and not the session id.
    expect(turn.initSessionId).toBe(sdkSessionId);
    expect(turn.resultSubtype).toBe('success');

    const body = stub.bodies[before];
    expect(body).toBeTruthy();
    const request = JSON.parse(body!) as { messages: Array<{ role: string; content: unknown }> };
    const flat = JSON.stringify(request.messages);

    // (3) The tool pair is on the wire, joined by its call id, and the fact
    // that exists ONLY in the tool result is there with it.
    expect(flat).toContain(CALL_ID);
    expect(flat).toContain(TOOL_ONLY_FACT);
    expect(flat).toContain('tool_use');
    expect(flat).toContain('tool_result');

    // …and it is HISTORY, not an afterthought: everything carried appears
    // before the question being asked now. A history the model reads after the
    // question is not history.
    const callAt = flat.indexOf(CALL_ID);
    const resultAt = flat.indexOf(TOOL_ONLY_FACT);
    const questionAt = flat.indexOf('what was the port?');
    expect(callAt).toBeGreaterThan(-1);
    expect(callAt).toBeLessThan(resultAt);
    expect(resultAt).toBeLessThan(questionAt);

    // The intermediate assistant row crosses too — §P.2(b)'s whole point, and
    // the 61.8% of assistant rows a message-level projection would have lost.
    expect(flat).toContain('reading it now');
  }, 180_000);

  /**
   * **The negative control, and it earned its keep by falsifying the first
   * detector this task shipped.**
   *
   * AGENTS.md: *"A live case's DETECTOR is the thing most likely to be wrong,
   * and a broken detector reports a product defect."* T2's read-back arm
   * originally compared the reported `session_id` against the minted anchor, on
   * the strength of `claude-agent.ts`'s own resume-recovery comment ("we got a
   * NEW session ID but no assistant content"). This row measured the opposite:
   * resuming an id with **no transcript at all** reports back **that same id**,
   * so the comparison passed on exactly the failure it existed to catch.
   *
   * What does differ is asserted below, and the arm was rewritten onto it.
   * Keep all four assertions: dropping the "same id" one is how a future reader
   * simplifies the detector straight back into the bug.
   *
   * This is also the crash-mid-switch state R1 describes — an armed handoff and
   * an anchor whose file never landed.
   */
  test('NEGATIVE CONTROL · a resume with no transcript keeps the SAME id, never reaches init, and carries no history', async () => {
    const absent = mintClaudeSdkSessionId();
    const before = stub.bodies.length;
    const turn = await runTurn('what was the port?', { resume: absent });

    // The falsified signal, pinned so it stays falsified.
    expect(turn.observed).toBe(absent);
    // The real one: the child fails its START, before `init`.
    expect(turn.initSessionId).toBeNull();
    expect(turn.resultSubtype).toBe('error_during_execution');
    // And nothing reached the model — not even a request.
    const body = stub.bodies[before];
    expect(body).toBeUndefined();
  }, 180_000);
});

// The suite is skipped without the flag, and a skipped suite that reports
// nothing is how a gate quietly stops being one. One always-on row states the
// requirement in the file that owns it.
describe('the offline SDK gate announces itself', () => {
  test('names the env flag it is gated on', () => {
    expect(ENABLED || process.env.NESSY_CLAUDE_SDK_E2E === undefined || process.env.NESSY_CLAUDE_SDK_E2E === '0').toBe(true);
  });
});
