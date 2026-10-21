/**
 * F1.236 — an API source's request must not write its credential into the
 * debug log.
 *
 * The handler inside `createApiTool` logged the request URL right after
 * `buildUrl` had appended the query-auth parameter, then `JSON.stringify` of
 * every request header (the bearer value, the Basic `user:password`, a custom
 * header credential), then the first 200 characters of a raw body. Debug is on
 * under `NESSY_DEBUG=1`, in a dev build and under `NESSY_IS_PACKAGED=false`
 * (`utils/debug.ts` → stderr, and main.log through electron-log in the main
 * process), so each of those lines was a credential in a log file or a
 * service manager's journal.
 *
 * WHY A CHILD. `utils/debug.ts` reads `NESSY_DEBUG` once, at module load, and
 * its `enableDebug()` has no inverse — turning debug on in this process would
 * leave it on for every later file bun runs in the same process. So the calls
 * run in a throwaway bun child started with `NESSY_DEBUG=1`, and the assertions
 * read the child's STDERR, which is the logger's own sink in a non-Electron
 * process (`output` → `process.stderr.write`). No stub of the sink, so what is
 * asserted is what the real logger wrote. `fetch` is stubbed INSIDE the child
 * (no network), and the stub reports what the wire received on stdout — the
 * control that the redaction is on the log copy only, and the request still
 * carries the credential it must carry.
 *
 * F1.312 (WJ-au, 2026-09-24) — test hygiene, measured against a reverted-fix
 * copy of `api-tools.ts` (the three F1.236 debug lines restored):
 * - every needle is looked for in the WHOLE of the child's stderr, not only in
 *   lines tagged `[api-tools]`: a logged value that carries a newline continues
 *   on an untagged line, and a tag filter drops exactly that continuation. The
 *   raw body below puts its secret on such a continuation line on purpose.
 * - every needle found is collected into ONE assertion, so a regression names
 *   all of them in one failure instead of stopping at the first.
 * - `BASIC_PASSWORD` is a GUARD needle, not F1.236 evidence: the F1.236 defect
 *   logged the Basic pair only base64-encoded (`BASIC_B64` is its live needle),
 *   so this one is absent from the reverted-fix log too. It stays for the other
 *   leak shape — the `{ username, password }` credential itself reaching a log.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { redactUrlForLog } from '../api-tools.ts';
import { MODULE_GRAPH_HOOK_BUDGET_MS } from '../../testing/module-graph-budgets.ts';

const API_TOOLS = resolve(import.meta.dir, '..', 'api-tools.ts');

const QUERY_SECRET = 'QUERYSECRET-a1b2c3';
const BEARER_SECRET = 'BEARERSECRET-d4e5f6';
const BASIC_PASSWORD = 'BASICPASS-g7h8i9';
const BASIC_B64 = Buffer.from(`svc-user:${BASIC_PASSWORD}`).toString('base64');
const HEADER_SECRET = 'HEADERSECRET-j0k1l2';
const RAW_BODY_SECRET = 'RAWBODYSECRET-m3n4o5';

const CHILD_SOURCE = `
import { createApiTool } from ${JSON.stringify(API_TOOLS)};

const wire = [];
globalThis.fetch = async (url, init) => {
  wire.push({ url: String(url), headers: init?.headers ?? {} });
  return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
};

const calls = [
  [{ name: 'q-src', baseUrl: 'https://api.example.test/v1', auth: { type: 'query', queryParam: 'api_key' } },
   ${JSON.stringify(QUERY_SECRET)},
   { path: '/items', method: 'GET', params: { q: 'hello' } }],
  [{ name: 'b-src', baseUrl: 'https://api.example.test/v2/', auth: { type: 'bearer' } },
   ${JSON.stringify(BEARER_SECRET)},
   { path: '/notes', method: 'POST', params: { _rawBody: ${JSON.stringify('first line\n' + RAW_BODY_SECRET + ' payload')}, _contentType: 'text/plain' } }],
  [{ name: 'basic-src', baseUrl: 'https://api.example.test', auth: { type: 'basic' } },
   { username: 'svc-user', password: ${JSON.stringify(BASIC_PASSWORD)} },
   { path: '/whoami', method: 'GET' }],
  [{ name: 'h-src', baseUrl: 'https://api.example.test', auth: { type: 'header' } },
   { 'X-Custom-Token': ${JSON.stringify(HEADER_SECRET)} },
   { path: '/things', method: 'PUT', params: { a: 1 } }],
];
for (const [config, credential, args] of calls) {
  const tool = createApiTool(config, credential);
  await tool.handler(args);
}
process.stdout.write('WIRE ' + JSON.stringify(wire) + '\\n');
`;

let dir = '';
let stderr = '';
let stdout = '';
let exitCode: number | null = null;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'api-tools-redaction-'));
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
  // 19.02 s to 51.47 s on 2026-10-16/17 (scripts/module-graph-hook-costs.txt),
  // the largest 0.43 of the hand-written 120 000 this replaced. It is killed
  // 30 s inside the hook budget, so a hang fails here with its own stderr.
  let killed = false;
  const killer = setTimeout(() => { killed = true; child.kill(); }, MODULE_GRAPH_HOOK_BUDGET_MS - 30_000);
  [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
  exitCode = await child.exited;
  clearTimeout(killer);
  if (killed) throw new Error(`child killed at its ${MODULE_GRAPH_HOOK_BUDGET_MS - 30_000} ms deadline:\n${stderr.slice(-4000)}`);
}, MODULE_GRAPH_HOOK_BUDGET_MS);

afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

function apiToolLines(): string[] {
  return stderr.split('\n').filter((line) => line.includes('[api-tools]'));
}

describe('F1.236 — createApiTool debug lines carry no credential', () => {
  test('instrument: the child ran every call and the real logger wrote to its sink', () => {
    expect(exitCode).toBe(0);
    // One "Creating flexible tool" line per call proves debug was on in the child.
    expect(apiToolLines().filter((l) => l.includes('Creating flexible tool')).length).toBe(4);
    // And the wire still carried every credential — the redaction is on the log copy only.
    const wireLine = stdout.split('\n').find((l) => l.startsWith('WIRE '));
    expect(wireLine).toBeDefined();
    const wire = JSON.parse(wireLine!.slice('WIRE '.length)) as Array<{ url: string; headers: Record<string, string> }>;
    expect(wire.length).toBe(4);
    expect(wire[0]!.url).toContain(`api_key=${QUERY_SECRET}`);
    expect(wire[1]!.headers.Authorization).toBe(`Bearer ${BEARER_SECRET}`);
    expect(wire[2]!.headers.Authorization).toBe(`Basic ${BASIC_B64}`);
    expect(wire[3]!.headers['X-Custom-Token']).toBe(HEADER_SECRET);
  });

  test('no secret — query key, bearer, Basic pair, custom header, raw body — reaches the log', () => {
    // The whole stderr, not the tagged lines: a continuation line carries no tag (F1.312).
    const live = { QUERY_SECRET, BEARER_SECRET, BASIC_B64, HEADER_SECRET, RAW_BODY_SECRET };
    const guard = { BASIC_PASSWORD };
    const leaked = Object.entries({ ...live, ...guard })
      .filter(([, secret]) => stderr.includes(secret))
      .map(([name]) => name);
    expect(leaked).toEqual([]);
    // The redacted URL keeps the query parameter NAMES; only their values are replaced.
    expect(stderr).toContain('/v1/items?api_key=[REDACTED]&q=[REDACTED]');
  });

  test('control: the method, the path and the header NAMES reach the log with or without the redaction', () => {
    const log = apiToolLines().join('\n');
    expect(log).toContain('q-src: GET https://api.example.test/v1/items?');
    expect(log).toContain('b-src: POST https://api.example.test/v2/notes');
    expect(log).toContain('basic-src: GET https://api.example.test/whoami');
    expect(log).toContain('h-src: PUT https://api.example.test/things');
    for (const name of ['Authorization', 'Content-Type', 'X-Custom-Token']) {
      expect(log).toContain(name);
    }
  });
});

describe('F1.236 — redactUrlForLog boundaries', () => {
  test('userinfo and fragment drop, repeated names collapse, a URL without a query is unchanged', () => {
    expect(redactUrlForLog('https://u:pw-SECRET@h.test/a/b?k=1&k=2&t=SECRET#frag')).toBe(
      'https://h.test/a/b?k=[REDACTED]&t=[REDACTED]',
    );
    expect(redactUrlForLog('https://h.test/a/b')).toBe('https://h.test/a/b');
  });

  test('an unparseable input yields the placeholder, never its own bytes', () => {
    expect(redactUrlForLog('not a url ?api_key=SECRET')).toBe('[unparseable-url]');
  });
});
