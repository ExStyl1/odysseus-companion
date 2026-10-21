/**
 * P6.148 — the host web search, end to end through the registry handler.
 *
 * `fetch` is stubbed rather than reached: DDG's reachability is a READING WITH
 * A DATE (P3.342, 2026-09-04) and a suite depending on it would go red on a rig
 * behind a stricter egress policy while the code was correct. Stubbing the
 * global rather than injecting a provider is deliberate — it exercises the real
 * path the model's call takes, parser included.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { handleWebSearch, resetHostWebSearchBudgets } from './web-search.ts';
import {
  getSessionToolNames,
  SESSION_TOOL_REGISTRY,
} from '../tool-defs.ts';

const REAL_FETCH = globalThis.fetch;

const DDG_HTML = `<html><body>
  <div class="result"><a class="result__a" href="/l/?uddg=https%3A%2F%2Fbun.sh%2Fdocs">Bun docs</a> The Bun runtime.</div>
  <div class="result"><a class="result__a" href="https://nodejs.org/api">Node docs</a> The Node runtime.</div>
</body></html>`;

function stubFetch(handler: (url: string) => Response | Promise<Response>): void {
  globalThis.fetch = ((input: any) => Promise.resolve(handler(String(input)))) as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = REAL_FETCH;
  resetHostWebSearchBudgets();
});

const ctx = { sessionId: 'session-under-test' } as any;

describe('handleWebSearch', () => {
  it('returns real result URLs from the key-free engine', async () => {
    const seen: string[] = [];
    stubFetch(url => {
      seen.push(url);
      return new Response(DDG_HTML, { status: 200 });
    });

    const result = await handleWebSearch(ctx, { query: 'bun runtime', count: 2 });

    expect(result.isError).toBe(false);
    expect(result.content[0]!.text).toContain('https://bun.sh/docs');
    expect(result.content[0]!.text).toContain('https://nodejs.org/api');
    expect(seen[0]).toContain('html.duckduckgo.com');
  });

  it('reports a dead engine as an ERROR naming both endpoints it tried', async () => {
    stubFetch(() => new Response('nope', { status: 503 }));

    const result = await handleWebSearch(ctx, { query: 'bun runtime' });

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toStartWith('[ERROR]');
    expect(result.content[0]!.text).toContain('ddg_html');
    expect(result.content[0]!.text).toContain('ddg_lite');
  });
});

describe('the web_search offer gate', () => {
  it('is offered where the runtime cannot reach its own search, and nowhere else', () => {
    // Default surface — a claude session that has said nothing is offered
    // nothing, so a passthrough connection keeps its native `WebSearch` alone.
    expect(getSessionToolNames().has('web_search')).toBe(false);
    // The claude arm: the host says this session's `WebSearch` is withheld.
    expect(getSessionToolNames({ hostWebSearch: true }).has('web_search')).toBe(true);
    // The codex arm: `--external-standalone-only` IS the codex handshake, and
    // codex's own `web_search` is written `disabled` (the ChatGPT card: F1.570).
    expect(getSessionToolNames({ externalStandaloneOnly: true }).has('web_search')).toBe(true);
    // Pi registers its own over the same engine — two search tools in front of
    // one model is the defect `visibility: 'not-pi'` exists to prevent.
    expect(getSessionToolNames({ projection: 'pi', hostWebSearch: true }).has('web_search'))
      .toBe(false);
  });

  it('stays in the registry so an ungated call is answered rather than lost', () => {
    // The P3.276 rule: the OFFER is gated, the classification and the dispatch
    // are not — a call that arrives anyway reaches the handler.
    expect(SESSION_TOOL_REGISTRY.get('web_search')?.executionMode).toBe('registry');
    expect(SESSION_TOOL_REGISTRY.get('web_search')?.readOnly).toBe(true);
  });
});
