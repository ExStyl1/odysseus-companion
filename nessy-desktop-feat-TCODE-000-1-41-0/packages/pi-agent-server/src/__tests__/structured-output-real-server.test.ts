/**
 * R18 Task 3: Pi turn-level structured output through the REAL pi-agent-server
 * subprocess with a scripted model (openai-completions HTTP stub).
 *
 * Production seams under test: the subprocess `prompt` message carrying
 * `outputSchema`, handlePrompt's draft-07 gate BEFORE any model call, the
 * validate-and-reprompt loop, and terminal reporting on the forwarded
 * `agent_end` — subtype `error_max_structured_output_retries` + terminal
 * reason `structured_output_retry_exhausted` (three DISTINCT documented
 * identifiers; the env knob is `NESSY_MAX_STRUCTURED_OUTPUT_RETRIES`).
 * Contract: code.claude.com/docs/en/agent-sdk/structured-outputs.md.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface, type Interface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';

import { createRealServerExecutionManifest } from './real-server-execution-manifest.ts';
import { REAL_SERVER_BOOT_WAIT_MS, realServerTestBudget } from './support/real-server-clock.ts';

const here = dirname(fileURLToPath(import.meta.url));
const entrypoint = join(here, '..', 'index.ts');
const repoRoot = join(here, '..', '..', '..', '..');

type ScriptEntry = { content: string } | { status: number };

interface Stub {
  baseUrl: string;
  requests: string[];
  script: ScriptEntry[];
  close(): Promise<void>;
}

async function startStub(): Promise<Stub> {
  const requests: string[] = [];
  const script: ScriptEntry[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += String(chunk); });
    req.on('end', () => {
      requests.push(body);
      // Consume the script in order; once exhausted, repeat the last entry so
      // SDK-internal retries of a failing request stay failing.
      const entry: ScriptEntry = script.length > 1 ? script.shift()! : (script[0] ?? { content: 'ok' });
      if ('status' in entry) {
        res.writeHead(entry.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'scripted upstream failure' } }));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const base = { id: 'so', object: 'chat.completion.chunk', created: 1, model: 'so-model' };
      res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { content: entry.content }, finish_reason: null }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } })}\n\n`);
      res.end('data: [DONE]\n\n');
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('stub did not bind');
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests,
    script,
    close: () => new Promise(resolve => server.close(() => resolve())),
  };
}

const SCHEMA = {
  type: 'object',
  required: ['ok'],
  properties: { ok: { type: 'boolean' } },
};

/** The sentence `buildCallLlmRequest`'s schema renderer injects (R18). */
const SCHEMA_BLOCK_SENTENCE = 'You MUST respond with valid JSON matching this schema';

/** The LAST user message of an openai-completions request body, as text. */
function lastUserMessageContent(body: string): string {
  const parsed = JSON.parse(body) as { messages?: Array<{ role?: string; content?: unknown }> };
  const user = [...(parsed.messages ?? [])].reverse().find(message => message?.role === 'user');
  if (!user) return '';
  return typeof user.content === 'string' ? user.content : JSON.stringify(user.content ?? '');
}

describe('turn-level structured output (real pi-agent-server)', () => {
  let stub: Stub;
  let child: ChildProcessWithoutNullStreams;
  let lines: Interface;
  let stderr = '';
  let sessionPath: string;
  let cwd: string;
  const messages: unknown[] = [];
  let cursor = 0;
  let turn = 0;
  const manifest = createRealServerExecutionManifest({
    workspaceId: 'so-real-server-workspace',
    sessionId: 'so-real-server',
  });

  function sendMsg(payload: Record<string, unknown>): void {
    child.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  async function waitFor(predicate: (message: any) => boolean, timeoutMs = 90_000): Promise<{ match: any; slice: any[] }> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      while (cursor < messages.length) {
        const start = cursor;
        const message = messages[cursor];
        cursor += 1;
        if (predicate(message)) {
          return { match: message, slice: messages.slice(0, start + 1) as any[] };
        }
      }
      if (Date.now() > deadline) {
        throw new Error(`Timed out waiting for message\nstderr:\n${stderr}`);
      }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }

  /** Send a prompt and wait for the turn's forwarded agent_end. */
  async function runTurn(prompt: Record<string, unknown>): Promise<{ agentEnd: any; turnMessages: any[] }> {
    turn += 1;
    const from = messages.length;
    sendMsg({
      type: 'prompt',
      id: `turn-${turn}`,
      message: `turn ${turn}`,
      systemPrompt: 'SO_SYSTEM_PROMPT',
      manifestGeneration: manifest.snapshotGeneration,
      manifestHash: manifest.manifestHash,
      ...prompt,
    });
    const { match } = await waitFor(
      (m: any) => m?.type === 'event' && m.event?.type === 'agent_end',
    );
    return { agentEnd: match.event, turnMessages: messages.slice(from) as any[] };
  }

  beforeAll(async () => {
    stub = await startStub();
    sessionPath = mkdtempSync(join(tmpdir(), 'nessy-so-session-'));
    cwd = mkdtempSync(join(tmpdir(), 'nessy-so-cwd-'));
    child = spawn(process.execPath, [entrypoint], {
      cwd: repoRoot,
      // The documented retry knob, at the production boundary: the subprocess
      // inherits it from its spawn env. 2 keeps the exhaustion runs fast.
      env: { ...process.env, NO_COLOR: '1', NESSY_MAX_STRUCTURED_OUTPUT_RETRIES: '2' },
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as ChildProcessWithoutNullStreams;
    lines = createInterface({ input: child.stdout });
    child.stderr.on('data', chunk => { stderr += String(chunk); });
    lines.on('line', line => {
      try {
        messages.push(JSON.parse(line));
      } catch {
        // non-JSON diagnostics line
      }
    });

    sendMsg({
      type: 'init',
      apiKey: 'test',
      model: 'so-model',
      cwd,
      workingDirectory: cwd,
      workspaceRootPath: cwd,
      workspaceId: 'so-real-server-workspace',
      sessionId: 'so-real-server',
      sessionPath,
      plansFolderPath: join(sessionPath, 'plans'),
      thinkingLevel: 'off',
      baseUrl: stub.baseUrl,
      customEndpoint: { api: 'openai-completions' },
      customModels: ['so-model'],
      executionManifest: manifest,
      piAuth: { provider: 'custom-endpoint', credential: { type: 'api_key', key: 'test' } },
    });
    await waitFor((m: any) => m?.type === 'ready', REAL_SERVER_BOOT_WAIT_MS);
  }, realServerTestBudget(0)); // F1.607: the BOOT only; each answer below has its own budget, from after this ready

  afterAll(async () => {
    try {
      sendMsg({ type: 'shutdown' });
    } catch {
      // already gone
    }
    child?.kill();
    lines?.close();
    await stub?.close();
    rmSync(sessionPath, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  });

  it('absent schema stays byte-identical: no structured-output fields ride agent_end', async () => {
    stub.script.length = 0;
    stub.script.push({ content: 'plain answer' });
    const before = stub.requests.length;

    const { agentEnd } = await runTurn({});

    expect(stub.requests.length - before).toBe(1);
    // R18: schema injection is turn-scoped — a schema-less turn carries none.
    expect(stub.requests.at(-1)).not.toContain(SCHEMA_BLOCK_SENTENCE);
    expect('structuredOutput' in agentEnd).toBe(false);
    expect('structuredOutputSubtype' in agentEnd).toBe(false);
    expect('structuredOutputErrors' in agentEnd).toBe(false);
    expect('terminalReason' in agentEnd).toBe(false);
  }, 120_000);

  it('the first model call and the reprompt both SHOW the schema (R18)', async () => {
    // The refuted half of R18: the schema was validated but never communicated.
    // Distinctive property name so history noise cannot satisfy the probe.
    const probeSchema = {
      type: 'object',
      required: ['so_probe_field_r18'],
      properties: { so_probe_field_r18: { type: 'boolean' } },
    };
    stub.script.length = 0;
    stub.script.push({ content: 'not json' }, { content: '{"so_probe_field_r18":true}' });
    const before = stub.requests.length;

    const { agentEnd } = await runTurn({ outputSchema: probeSchema });

    expect(stub.requests.length - before).toBe(2);
    // First model call: the turn text carries the schema and its properties.
    const firstBody = stub.requests[before]!;
    expect(firstBody).toContain(SCHEMA_BLOCK_SENTENCE);
    expect(firstBody).toContain('so_probe_field_r18');
    // Reprompt: the NEW user message itself (not merely the history) carries
    // the validation errors AND the schema again.
    const repromptMessage = lastUserMessageContent(stub.requests.at(-1)!);
    expect(repromptMessage).toContain('did not match outputSchema');
    expect(repromptMessage).toContain(SCHEMA_BLOCK_SENTENCE);
    expect(repromptMessage).toContain('so_probe_field_r18');
    expect(agentEnd.structuredOutput).toEqual({ so_probe_field_r18: true });
    expect(agentEnd.structuredOutputSubtype).toBe('success');
  }, 120_000);

  it('invalid-then-valid: reprompts with the validation errors and returns .structured_output', async () => {
    stub.script.length = 0;
    stub.script.push({ content: 'not json' }, { content: '{"ok":true}' });
    const before = stub.requests.length;

    const { agentEnd } = await runTurn({ outputSchema: SCHEMA });

    expect(stub.requests.length - before).toBe(2);
    // The reprompt carries the validation errors to the model.
    expect(stub.requests.at(-1)).toContain('did not match outputSchema');
    expect(agentEnd.structuredOutput).toEqual({ ok: true });
    expect(agentEnd.structuredOutputSubtype).toBe('success');
    expect('structuredOutputErrors' in agentEnd).toBe(false);
    expect('terminalReason' in agentEnd).toBe(false);
  }, 120_000);

  it('always-invalid exhausts at the configured count with BOTH documented identifiers', async () => {
    stub.script.length = 0;
    stub.script.push({ content: 'still not json' }, { content: '{"ok":"not a boolean"}' });
    const before = stub.requests.length;

    const { agentEnd } = await runTurn({ outputSchema: SCHEMA });

    // NESSY_MAX_STRUCTURED_OUTPUT_RETRIES=2 -> exactly two model attempts.
    expect(stub.requests.length - before).toBe(2);
    expect(agentEnd.structuredOutputSubtype).toBe('error_max_structured_output_retries');
    expect(agentEnd.terminalReason).toBe('structured_output_retry_exhausted');
    expect(Array.isArray(agentEnd.structuredOutputErrors)).toBe(true);
    expect(agentEnd.structuredOutputErrors.length).toBeGreaterThan(0);
    expect('structuredOutput' in agentEnd).toBe(false);
  }, 120_000);

  it('a bad schema fails pre-model with the named error and never spawns a model call', async () => {
    stub.script.length = 0;
    stub.script.push({ content: 'must never be requested' });
    const before = stub.requests.length;

    const { agentEnd, turnMessages } = await runTurn({
      outputSchema: { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object' },
    });

    expect(stub.requests.length - before).toBe(0);
    const errorMessage = turnMessages.find((m: any) => m?.type === 'error');
    expect(errorMessage?.message).toContain('invalid structured-output schema');
    // The synthetic agent_end that unblocks the host carries no structured fields.
    expect('structuredOutput' in agentEnd).toBe(false);
    expect('structuredOutputSubtype' in agentEnd).toBe(false);
  }, 120_000);

  it('success with no structured output at all is reported as a failure via errors', async () => {
    stub.script.length = 0;
    stub.script.push({ content: ' ' });
    const before = stub.requests.length;

    const { agentEnd } = await runTurn({ outputSchema: SCHEMA });

    expect(stub.requests.length - before).toBe(1);
    expect(agentEnd.structuredOutputSubtype).toBe('success');
    expect('structuredOutput' in agentEnd).toBe(false);
    expect(agentEnd.structuredOutputErrors).toEqual(['run completed without a structured output']);
    expect('terminalReason' in agentEnd).toBe(false);
  }, 120_000);

  it('a broken retry attempt ends in the same error subtype with no validation failure recorded', async () => {
    // The model-fallback-retraction analog: a validation failure forces a
    // retry, and the retry attempt dies upstream. No valid output remains, so
    // the run ends error_max_structured_output_retries — but the errors list
    // carries the non-validation cause, not a schema mismatch.
    stub.script.length = 0;
    stub.script.push({ content: 'not json either' }, { status: 500 });
    const before = stub.requests.length;

    const { agentEnd } = await runTurn({ outputSchema: SCHEMA });

    expect(stub.requests.length - before).toBeGreaterThanOrEqual(2);
    expect(agentEnd.structuredOutputSubtype).toBe('error_max_structured_output_retries');
    expect(agentEnd.terminalReason).toBe('structured_output_retry_exhausted');
    expect(Array.isArray(agentEnd.structuredOutputErrors)).toBe(true);
    expect(agentEnd.structuredOutputErrors.length).toBeGreaterThan(0);
    for (const error of agentEnd.structuredOutputErrors) {
      expect(error).not.toContain('did not match');
      expect(error).not.toContain('must have required property');
    }
    expect('structuredOutput' in agentEnd).toBe(false);
  }, 120_000);
});
