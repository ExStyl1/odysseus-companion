/**
 * Adversarial log test: a query-auth source's credential must never reach the
 * debug log. executeApiRequest logs "{method} {url}" under NESSY_DEBUG, and
 * for `auth.type === 'query'` buildUrl embeds the live credential in that URL
 * (`?api_key=…`) — this test captures the real stderr sink and asserts the
 * secret is absent, so reverting the redaction at the call site fails here.
 *
 * UA9.2 — copied from craft-agents-oss `v0.13.4:packages/shared/src/sources/__tests__/api-tools-log-redaction.test.ts`
 * (Apache-2.0). Ours restores the debug state it found (the module reads `NESSY_DEBUG` at load), and adds two arms
 * for our `executeApiRequest`: the wire still carries the credential (positive control), and a thrown fetch error
 * that quotes the credential is masked (F1.309) while one that does not is passed through unchanged.
 */

import { describe, test, expect } from 'bun:test';
import { executeApiRequest } from '../api-tools.ts';
import type { ApiConfig } from '../types.ts';
import { disableDebug, enableDebug, isDebugEnabled } from '../../utils/debug.ts';

// Assembled at runtime so no token-shaped literal sits in the tree.
const SECRET = ['sk', 'live', '9f8e7d6c5b4a', 'topsecret'].join('-');

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

function stubFetch(onCall?: (url: string) => void, fail?: Error): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string, _init?: RequestInit) => {
    onCall?.(String(url));
    if (fail) throw fail;
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

const config: ApiConfig = {
  name: 'query-auth-source',
  baseUrl: 'https://api.example.test',
  auth: { type: 'query', queryParam: 'api_key' },
};

describe('executeApiRequest debug log', () => {
  test('query-auth credential and GET param values never appear; path and param names do', async () => {
    const wire: string[] = [];
    const restoreFetch = stubFetch((url) => wire.push(url));
    const stderr = captureStderr();
    const wasEnabled = isDebugEnabled();
    enableDebug();
    let outcome;
    try {
      outcome = await executeApiRequest(config, SECRET, {
        path: '/v1/search',
        method: 'GET',
        params: { q: 'quarterly revenue' },
      });
    } finally {
      if (!wasEnabled) disableDebug();
      stderr.restore();
      restoreFetch();
    }

    const logged = stderr.text();
    // The line is still useful for debugging…
    expect(logged).toContain('GET https://api.example.test/v1/search');
    expect(logged).toContain('api_key=[REDACTED]');
    expect(logged).toContain('q=[REDACTED]');
    // …but carries no values: neither the credential nor GET param contents.
    expect(logged).not.toContain(SECRET);
    expect(logged).not.toContain('quarterly');
    // Control: the redaction is on the log copy only — the request still carries the credential.
    expect(wire).toHaveLength(1);
    expect(wire[0]).toContain(`api_key=${SECRET}`);
    expect(outcome.ok).toBe(true);
    expect(outcome.status).toBe(200);
  });

  test('a fetch error quoting the credential is masked; one that does not is passed through unchanged', async () => {
    let restoreFetch = stubFetch(undefined, new TypeError(`Header has invalid value: "${SECRET}"`));
    try {
      const error = await executeApiRequest(config, SECRET, { path: '/x', method: 'GET' }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).not.toContain(SECRET);
      expect((error as Error).name).toBe('TypeError');
    } finally {
      restoreFetch();
    }

    const plain = new Error('connection reset');
    restoreFetch = stubFetch(undefined, plain);
    try {
      await expect(executeApiRequest(config, SECRET, { path: '/x', method: 'GET' })).rejects.toBe(plain);
    } finally {
      restoreFetch();
    }
  });
});
