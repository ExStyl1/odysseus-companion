/**
 * UA12.63 — `createApiTool`'s handler takes ONE fetch path: `executeApiRequest`
 * (the same path the Pages action bridge's API executor takes), so the agent
 * tool and the bridge cannot drift (P-UAad-2). The row's control — the two
 * redaction suites stay green, and a spy shows the tool calls
 * `executeApiRequest` — is realized here the way this repo pins intra-module
 * wiring: an ESM internal binding cannot be spied without `mock.module`
 * amputating the module for every later suite (AGENTS.md), so the route is
 * pinned (a) structurally, on the handler's source, and (b) by the observable
 * the inline path alone had — its `raw body (…), N chars` debug line, absent
 * once the fetch runs in `executeApiRequest`. The behaviour arms at the end
 * are the net that keeps the handler's own contracts (error wording, F1.309
 * masking, the too-large refusal) identical through the re-route.
 */

import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createApiTool, type ApiCredentialSource } from '../api-tools.ts';
import { MAX_DOWNLOAD_SIZE } from '../../utils/binary-detection.ts';
import type { ApiConfig } from '../types.ts';
import { disableDebug, enableDebug, isDebugEnabled } from '../../utils/debug.ts';

const API_TOOLS = resolve(import.meta.dir, '..', 'api-tools.ts');
const SOURCE = readFileSync(API_TOOLS, 'utf-8');

// Assembled at runtime so no token-shaped literal sits in the tree.
const SECRET = ['sk', 'live', 'a7b8c9d0e1f2', 'topsecret'].join('-');

function makeBearerConfig(): ApiConfig {
  return { name: 'route-src', baseUrl: 'https://api.example.test', auth: { type: 'bearer', authScheme: 'Bearer' } };
}

interface MinimalTool {
  handler: (args: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>;
}

function captureStderr(): { restore: () => void; text: () => string } {
  const original = process.stderr.write.bind(process.stderr);
  let captured = '';
  process.stderr.write = ((chunk: string | Uint8Array) => {
    captured += typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk);
    return true;
  }) as typeof process.stderr.write;
  return {
    restore: () => {
      process.stderr.write = original;
    },
    text: () => captured,
  };
}

function stubFetch(run: (url: string, init: RequestInit | undefined) => Promise<Response>): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: unknown, init: RequestInit | undefined) => run(String(url), init)) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

describe('UA12.63 — the tool handler routes through executeApiRequest', () => {
  test('source pin: the handler calls executeApiRequest and has no inline fetch', () => {
    const begin = SOURCE.indexOf('export function createApiTool');
    const end = SOURCE.indexOf('export function createApiServer');
    expect(begin).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(begin);
    const handler = SOURCE.slice(begin, end);
    expect(handler).toContain('await executeApiRequest(config, resolvedCredential');
    expect(handler).not.toContain('await fetch(');
    // The scrub path stays: large/binary responses still go through guardLargeResult.
    expect(handler).toContain('guardLargeResult(outcome.buffer');
  });

  test("the inline path's raw-body debug line is gone, and the wire still carries the raw body", async () => {
    const rawBody = `first line\n${SECRET} payload`;
    let wireBody: unknown;
    const restoreFetch = stubFetch(async (_url, init) => {
      wireBody = init?.body;
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const stderr = captureStderr();
    const wasEnabled = isDebugEnabled();
    enableDebug();
    let result;
    try {
      const tool = createApiTool(makeBearerConfig(), SECRET) as unknown as MinimalTool;
      result = await tool.handler({
        path: '/notes',
        method: 'POST',
        params: { _rawBody: rawBody, _contentType: 'text/plain' },
      });
    } finally {
      if (!wasEnabled) disableDebug();
      stderr.restore();
      restoreFetch();
    }

    // The wire is untouched — redaction was always on the log copy only.
    expect(wireBody).toBe(rawBody);
    expect(result.content[0]!.text).toBe('{}');
    // The route: `executeApiRequest` never logs the raw body, where the inline path did.
    expect(stderr.text()).not.toContain('raw body (');
    expect(stderr.text()).not.toContain(SECRET);
  });

  test('behaviour net: a 500 echo, a fetch refusal, a too-large refusal and a 200 keep their wording', async () => {
    const tool = createApiTool(makeBearerConfig(), SECRET) as unknown as MinimalTool;

    // 4xx/5xx body: `API Error <status>: <masked body>`.
    let restore = stubFetch(async () => new Response(`invalid key: ${SECRET}`, { status: 500 }));
    try {
      const result = await tool.handler({ path: '/x', method: 'GET' });
      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toContain('API Error 500');
      expect(result.content[0]!.text).not.toContain(SECRET);
    } finally {
      restore();
    }

    // Fetch refusal: F1.309 masks the credential the message quotes; the handler wraps it.
    restore = stubFetch(async () => {
      throw new TypeError(`Header has invalid value: "${SECRET}"`);
    });
    try {
      const result = await tool.handler({ path: '/x', method: 'GET' });
      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toContain('Request failed:');
      expect(result.content[0]!.text).not.toContain(SECRET);
    } finally {
      restore();
    }

    // Over-cap Content-Length: refused before the body loads, static wording.
    restore = stubFetch(async () => new Response('ignored', { status: 200, headers: { 'content-length': String(MAX_DOWNLOAD_SIZE + 1) } }));
    try {
      const result = await tool.handler({ path: '/big', method: 'GET' });
      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toContain('Response too large:');
      expect(result.content[0]!.text).toContain('streaming download tool');
    } finally {
      restore();
    }

    // 200: the body text inline.
    restore = stubFetch(async () => new Response('{"ok":1}', { status: 200, headers: { 'content-type': 'application/json' } }));
    try {
      const result = await tool.handler({ path: '/ok', method: 'GET' });
      expect(result.isError).toBeUndefined();
      expect(result.content[0]!.text).toBe('{"ok":1}');
    } finally {
      restore();
    }
  });

  test('the credential getter still resolves once per request, and the freshest value reaches the wire', async () => {
    let currentToken = 'token-A';
    let resolves = 0;
    const getter = async () => {
      resolves += 1;
      return currentToken;
    };
    const tool = createApiTool(makeBearerConfig(), getter as ApiCredentialSource) as unknown as MinimalTool;
    let lastAuthorization = '';
    const restoreFetch = stubFetch(async (_url, init) => {
      lastAuthorization = (init?.headers as Record<string, string>)['Authorization'] ?? '';
      return new Response('{}', { status: 200 });
    });
    try {
      await tool.handler({ path: '/ping', method: 'GET' });
      expect(lastAuthorization).toBe('Bearer token-A');
      currentToken = 'token-B';
      await tool.handler({ path: '/ping', method: 'GET' });
      expect(lastAuthorization).toBe('Bearer token-B');
      // Once per request — the handler resolves and passes the value resolved,
      // so the re-routed path does not resolve a second time inside executeApiRequest.
      expect(resolves).toBe(2);
    } finally {
      restoreFetch();
    }
  });
});
