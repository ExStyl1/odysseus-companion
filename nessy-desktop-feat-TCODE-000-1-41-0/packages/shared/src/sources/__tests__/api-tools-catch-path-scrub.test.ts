/**
 * F1.309 (origin WJ-ee verifier F1.236-a, 2026-09-23) — `createApiTool`'s
 * catch path and its `error ${status}` body line must not hand the resolved
 * credential back, neither to the debug log nor to the MODEL.
 *
 * F1.236 took the credential out of the three request debug lines. Two routes
 * stayed: (a) the fetch itself refuses a malformed credential and its error
 * message quotes it — under bun a bearer carrying a zero-width space, smart
 * quotes or an embedded LF comes back as `Header '…' has invalid value:
 * 'Bearer <token>'` — and the handler returned that message to the model as
 * `Request failed: <message>` and logged it; (b) an API that echoes the key in
 * its 4xx body (`invalid key: <key>`) had that body returned to the model as
 * `API Error <status>: <body>` and logged. The fix masks every form of the
 * resolved credential's values out of both texts
 * (`maskKnownCredentialValues`, `agent/tool-result-secret-scan.ts`).
 *
 * WHY A CHILD — the same reason as `api-tools-debug-redaction.test.ts`:
 * `utils/debug.ts` reads `NESSY_DEBUG` once at module load and has no inverse,
 * so the calls run in a throwaway bun child started with `NESSY_DEBUG=1` and
 * the assertions read its STDERR (the logger's own sink). The fetch is the REAL
 * one: the malformed values are refused by the runtime before any byte leaves,
 * and the echo arms talk to a loopback `Bun.serve` inside the child that
 * records what the wire carried (the instrument that the mask is on the text
 * only). Every credential here is built from random bytes — none is real.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { MODULE_GRAPH_HOOK_BUDGET_MS } from '../../testing/module-graph-budgets.ts';

const API_TOOLS = resolve(import.meta.dir, '..', 'api-tools.ts');

const hex = (bytes: number): string => randomBytes(bytes).toString('hex');

/** Malformed: the runtime refuses the header and quotes it. */
const ZWSP_BEARER = `zw${hex(10)}\u200B${hex(10)}`;
const SMART_QUOTE_BEARER = `sq${hex(10)}\u201C${hex(6)}\u201D`;
const LF_HEADER = `lf${hex(10)}\n${hex(10)}`;
/** Well-formed: sent, then echoed back by the loopback API in its 401 body. */
const ECHO_BEARER = `eb${hex(16)}`;
const ECHO_QUERY = `eq${hex(16)}`;
const BASIC_PASSWORD = `bp${hex(12)}`;
const BASIC_B64 = Buffer.from(`svc-user:${BASIC_PASSWORD}`).toString('base64');
const ECHO_HEADER = `eh${hex(16)}`;

const CHILD_SOURCE = `
import { createApiTool } from ${JSON.stringify(API_TOOLS)};

const wire = [];
const server = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  fetch(req) {
    const url = new URL(req.url);
    const seen = [req.headers.get('authorization'), url.searchParams.get('api_key'), req.headers.get('x-custom-token')]
      .filter(Boolean).join(' ');
    wire.push(seen);
    return new Response('invalid credential: ' + seen, { status: 401 });
  },
});
const base = 'http://127.0.0.1:' + server.port;

const cases = [
  ['zwsp-bearer', { name: 'zw', baseUrl: base, auth: { type: 'bearer' } }, ${JSON.stringify(ZWSP_BEARER)}],
  ['smart-quote-bearer', { name: 'sq', baseUrl: base, auth: { type: 'bearer' } }, ${JSON.stringify(SMART_QUOTE_BEARER)}],
  ['lf-header', { name: 'lf', baseUrl: base, auth: { type: 'header', headerName: 'X-Custom-Token' } }, ${JSON.stringify(LF_HEADER)}],
  ['echo-bearer', { name: 'eb', baseUrl: base, auth: { type: 'bearer' } }, ${JSON.stringify(ECHO_BEARER)}],
  ['echo-query', { name: 'eq', baseUrl: base, auth: { type: 'query', queryParam: 'api_key' } }, ${JSON.stringify(ECHO_QUERY)}],
  ['echo-basic', { name: 'bb', baseUrl: base, auth: { type: 'basic' } }, { username: 'svc-user', password: ${JSON.stringify(BASIC_PASSWORD)} }],
  ['echo-multi-header', { name: 'mh', baseUrl: base, auth: { type: 'header' } }, { 'X-Custom-Token': ${JSON.stringify(ECHO_HEADER)} }],
];
const results = {};
for (const [label, config, credential] of cases) {
  const tool = createApiTool(config, credential);
  const result = await tool.handler({ path: '/items', method: 'GET' });
  results[label] = { text: result.content.map((c) => c.text).join('\\n'), isError: result.isError === true };
}
server.stop(true);
process.stdout.write('RESULTS ' + JSON.stringify(results) + '\\n');
process.stdout.write('WIRE ' + JSON.stringify(wire) + '\\n');
`;

let dir = '';
let stderr = '';
let results: Record<string, { text: string; isError: boolean }> = {};
let wire: string[] = [];
let exitCode: number | null = null;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'api-tools-catch-scrub-'));
  const script = join(dir, 'child.ts');
  writeFileSync(script, CHILD_SOURCE);
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (typeof v === 'string') env[k] = v;
  delete env.NESSY_CLI_JSON_ONLY;
  env.NESSY_DEBUG = '1';
  env.NESSY_CONFIG_DIR = join(dir, 'config');
  // cwd = the temp dir, so the repo root's bunfig preloads do not run in the child.
  const child = Bun.spawn([process.execPath, script], { cwd: dir, env, stdout: 'pipe', stderr: 'pipe' });
  // UB12.31 — the child pays the `api-tools.ts` graph: whole-file totals of
  // 16.96 s to 88.41 s on 2026-10-16/17 (scripts/module-graph-hook-costs.txt),
  // the largest 0.74 of the hand-written 120 000 this replaced. It is killed
  // 30 s inside the hook budget, so a hang fails here with its own stderr.
  let killed = false;
  const killer = setTimeout(() => { killed = true; child.kill(); }, MODULE_GRAPH_HOOK_BUDGET_MS - 30_000);
  let stdout = '';
  [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
  exitCode = await child.exited;
  clearTimeout(killer);
  if (killed) throw new Error(`child killed at its ${MODULE_GRAPH_HOOK_BUDGET_MS - 30_000} ms deadline:\n${stderr.slice(-4000)}`);
  const line = (prefix: string) => stdout.split('\n').find((l) => l.startsWith(prefix))?.slice(prefix.length);
  results = JSON.parse(line('RESULTS ') ?? '{}');
  wire = JSON.parse(line('WIRE ') ?? '[]');
}, MODULE_GRAPH_HOOK_BUDGET_MS);

afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

const apiToolLog = (): string => stderr.split('\n').filter((l) => l.includes('[api-tools]')).join('\n');

/** The whole value, and each printable run of it long enough to identify it. */
const fragments = (secret: string): string[] =>
  [secret, ...secret.split(/[^\x21-\x7e]+/u).filter((part) => part.length >= 8)];

const CASES: Array<[label: string, secrets: string[]]> = [
  ['zwsp-bearer', [ZWSP_BEARER]],
  ['smart-quote-bearer', [SMART_QUOTE_BEARER]],
  ['lf-header', [LF_HEADER]],
  ['echo-bearer', [ECHO_BEARER]],
  ['echo-query', [ECHO_QUERY]],
  ['echo-basic', [BASIC_PASSWORD, BASIC_B64]],
  ['echo-multi-header', [ECHO_HEADER]],
];

describe('F1.309 — the catch path and the error body carry no credential', () => {
  test('instrument: every call ran, debug was on, and the wire still carried the well-formed credentials', () => {
    expect(exitCode).toBe(0);
    expect(Object.keys(results).sort()).toEqual(CASES.map(([label]) => label).sort());
    expect(apiToolLog()).toContain('Creating flexible tool');
    const seen = wire.join('\n');
    expect(seen).toContain(ECHO_BEARER);
    expect(seen).toContain(ECHO_QUERY);
    expect(seen).toContain(BASIC_B64);
    expect(seen).toContain(ECHO_HEADER);
  });

  for (const [label, secrets] of CASES) {
    test(`${label}: absent from the tool result the model reads`, () => {
      const text = results[label]?.text ?? '';
      expect(results[label]?.isError).toBe(true);
      for (const secret of secrets) for (const part of fragments(secret)) expect(text).not.toContain(part);
    });

    test(`${label}: absent from the debug log`, () => {
      const log = apiToolLog();
      for (const secret of secrets) for (const part of fragments(secret)) expect(log).not.toContain(part);
    });
  }

  test('negative control: the failure is still reported, and says where a value was taken out', () => {
    for (const label of ['zwsp-bearer', 'smart-quote-bearer', 'lf-header']) {
      expect(results[label]?.text).toStartWith('Request failed: ');
    }
    for (const label of ['echo-bearer', 'echo-query', 'echo-basic', 'echo-multi-header']) {
      expect(results[label]?.text).toStartWith('API Error 401: invalid credential: ');
      expect(results[label]?.text).toContain('[REDACTED:credential]');
    }
    expect(apiToolLog()).toContain('eb error 401: invalid credential: ');
  });
});
