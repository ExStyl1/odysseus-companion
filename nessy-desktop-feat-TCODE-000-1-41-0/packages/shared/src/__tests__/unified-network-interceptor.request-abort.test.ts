/**
 * F1.565 (P-WJax-3, 2026-09-24) — an abort of `fetch(new Request(url, { signal }))`
 * through the interceptor's ADAPTER path reaches the upstream request.
 *
 * `interceptedFetch` reads a Request input's body through `resolveRequestContext`
 * and then calls the real fetch with a STRING url and the init that helper built.
 * That init was `{ method, headers, body }` alone, so the signal was on neither
 * argument: the caller's abort cancelled nothing, the upstream stream stayed open
 * and the caller's reader never settled. An init `signal` beside a Request input
 * was dropped the same way. Only a string url with a string init body (what the
 * provider SDKs send) kept its signal, because the helper returned that init
 * as it was.
 *
 * Measured before the fix (`work/wjbk/f1565-probe.ts`, the same rig as below):
 * - through the preloaded interceptor, a Request's signal and an init signal
 *   beside a Request both left the upstream open 1.5 s after the abort;
 * - bare Bun, with no preload, closed the upstream for both;
 * - a string url with an init signal closed it through the interceptor too.
 *
 * The end-to-end rig is the F1.498 one: `bun run --preload <interceptor> <child>`
 * from a directory with no `bunfig.toml`. The upstream is a `Bun.serve` whose SSE
 * stream records its own `cancel`. The url ends in `/responses`, so the
 * `openai-responses` adapter takes it by URL in any process. The wire capture
 * shows the request went through the adapter path, not the pass-through one.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveRequestContext } from '../interceptor-request-utils.ts';

const INTERCEPTOR = join(import.meta.dir, '..', 'unified-network-interceptor.ts');

describe('F1.565 — resolveRequestContext carries the abort signal', () => {
  const body = JSON.stringify({ model: 'm', input: [] });

  it("a Request input's own signal", async () => {
    const controller = new AbortController();
    const request = new Request('https://example.com/v1/responses', { method: 'POST', body, signal: controller.signal });
    const { normalizedInit } = await resolveRequestContext(request, undefined);
    expect(normalizedInit.signal).toBeDefined();
    controller.abort();
    expect(normalizedInit.signal?.aborted).toBe(true);
  });

  it('an init signal beside a Request input wins over the Request’s own', async () => {
    const own = new AbortController();
    const given = new AbortController();
    const request = new Request('https://example.com/v1/responses', { method: 'POST', body, signal: own.signal });
    const { normalizedInit } = await resolveRequestContext(request, { signal: given.signal });
    expect(normalizedInit.signal).toBe(given.signal);
  });

  it('a string init body beside a Request input keeps the Request’s signal when init names none', async () => {
    const controller = new AbortController();
    const request = new Request('https://example.com/v1/responses', { method: 'POST', body, signal: controller.signal });
    const { bodyStr, normalizedInit } = await resolveRequestContext(request, { method: 'POST', body });
    expect(bodyStr).toBe(body);
    controller.abort();
    expect(normalizedInit.signal?.aborted).toBe(true);
  });

  it('CONTROL: a string url with a string init body returns that init as it was', async () => {
    const controller = new AbortController();
    const init: RequestInit = { method: 'POST', body, signal: controller.signal };
    const { normalizedInit } = await resolveRequestContext('https://example.com/v1/responses', init);
    expect(normalizedInit).toBe(init);
  });
});

/** The child, written out as lines (a template literal would be closed by any backtick in it). */
const CHILD_SOURCE = [
  "const target = process.env.F1565_TARGET;",
  "const mode = process.env.F1565_MODE;",
  "const headers = { 'content-type': 'application/json' };",
  "const body = JSON.stringify({ model: 'm', input: [], stream: true });",
  "const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));",
  "async function main() {",
  "  const controller = new AbortController();",
  "  let response;",
  "  if (mode === 'request') response = await fetch(new Request(target, { method: 'POST', headers, body, signal: controller.signal }));",
  "  else if (mode === 'request-plus-init-signal') response = await fetch(new Request(target, { method: 'POST', headers, body }), { signal: controller.signal });",
  "  else if (mode === 'string-url') response = await fetch(target, { method: 'POST', headers, body, signal: controller.signal });",
  "  else throw new Error('unknown mode ' + mode);",
  "  const reader = response.body.getReader();",
  "  await reader.read();",
  "  controller.abort();",
  "  const reads = [];",
  "  void (async () => {",
  "    for (;;) {",
  "      try { const next = await reader.read(); if (next.done) { reads.push('done'); return; } }",
  "      catch (error) { reads.push('rejected:' + error.name); return; }",
  "    }",
  "  })();",
  "  await sleep(1500);",
  "  process.stdout.write(JSON.stringify({ status: response.status, reader: reads.join(',') || 'pending' }) + '\\n');",
  "}",
  "main().then(() => process.exit(0), (error) => { process.stderr.write(String(error && error.stack || error)); process.exit(1); });",
  "",
].join('\n');

let root = '';
let child = '';
let server: ReturnType<typeof Bun.serve> | undefined;
/** Per mode: whether the upstream saw its stream cancelled. */
const cancelled = new Map<string, boolean>();

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'nessy-f1565-'));
  child = join(root, 'child.mjs');
  writeFileSync(child, CHILD_SOURCE);
  server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(request) {
      const mode = new URL(request.url).pathname.split('/')[1] ?? '';
      cancelled.set(mode, false);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('event: response.created\ndata: {"type":"response.created","response":{"id":"r1"}}\n\n'));
          timer = setTimeout(() => { try { controller.close(); } catch { /* already cancelled */ } }, 20_000);
        },
        cancel() {
          cancelled.set(mode, true);
          if (timer) clearTimeout(timer);
        },
      });
      return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
    },
  });
});

afterAll(() => {
  server?.stop(true);
  if (root) rmSync(root, { recursive: true, force: true });
});

/** Async spawn: a synchronous one would deadlock against the in-process server. */
function runChild(mode: string): Promise<{ code: number | null; outcome: Record<string, unknown> | null; captured: number; stderr: string }> {
  const capture = join(root, `wire-${mode}.jsonl`);
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, ['run', '--preload', INTERCEPTOR, child], {
      cwd: root,
      env: {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        HOME: root,
        NESSY_CONFIG_DIR: join(root, 'config'),
        NESSY_WIRE_CAPTURE: capture,
        F1565_MODE: mode,
        F1565_TARGET: `http://127.0.0.1:${server!.port}/${mode}/v1/responses`,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (chunk) => { stdout += String(chunk); });
    proc.stderr.on('data', (chunk) => { stderr += String(chunk); });
    const timer = setTimeout(() => proc.kill('SIGKILL'), 150_000);
    proc.on('error', reject);
    proc.on('close', (code) => {
      clearTimeout(timer);
      let outcome: Record<string, unknown> | null = null;
      try { outcome = JSON.parse(stdout.trim().split('\n').at(-1) ?? '') as Record<string, unknown>; } catch { /* reported below */ }
      const captured = existsSync(capture) ? readFileSync(capture, 'utf8').split('\n').filter(Boolean).length : 0;
      resolve({ code, outcome, captured, stderr: stderr.slice(-2000) });
    });
  });
}

describe('F1.565 — an abort through the preloaded interceptor reaches the upstream', () => {
  it('fetch(new Request(url, { signal })): the upstream stream is cancelled and the reader rejects', async () => {
    const run = await runChild('request');
    expect({ code: run.code, outcome: run.outcome, stderr: run.stderr }).toEqual({
      code: 0,
      outcome: { status: 200, reader: 'rejected:AbortError' },
      stderr: '',
    });
    expect(run.captured).toBe(1);
    expect(cancelled.get('request')).toBe(true);
  }, 180_000);

  it('fetch(new Request(url), { signal }): the init signal is honoured the same way', async () => {
    const run = await runChild('request-plus-init-signal');
    expect({ code: run.code, outcome: run.outcome }).toEqual({ code: 0, outcome: { status: 200, reader: 'rejected:AbortError' } });
    expect(run.captured).toBe(1);
    expect(cancelled.get('request-plus-init-signal')).toBe(true);
  }, 180_000);

  it('CONTROL: fetch(url, { body, signal }) — the form that always kept its signal', async () => {
    const run = await runChild('string-url');
    expect({ code: run.code, outcome: run.outcome }).toEqual({ code: 0, outcome: { status: 200, reader: 'rejected:AbortError' } });
    expect(run.captured).toBe(1);
    expect(cancelled.get('string-url')).toBe(true);
  }, 180_000);
});
