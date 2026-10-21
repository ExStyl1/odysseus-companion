/**
 * DA2.3 — the outbound-tools sink is OBSERVATION, and this file is what makes
 * that a fact rather than a comment.
 *
 * `AdapterOptions.onOutboundTools` had three fire sites and ZERO tests
 * (measured 2026-09-14: `git grep -an onOutboundTools` over `packages/**` names
 * six files and none of them under a `__tests__` directory). That mattered more
 * once DA2.3 REFUSED to build a filter beside it, because the refusal makes the
 * sink the whole of this seam: a silent regression here would delete the only
 * disclosure this host has of its MCP tool schemas leaving for an external
 * vendor, and nothing would go red.
 *
 * So each case asserts BOTH halves together — the names are reported, AND the
 * body that actually went upstream still carries every tool it arrived with.
 * The second half is the refusal, pinned: the day someone drops a tool here,
 * these fail and the DA2.3 sections of `server.ts` (symbol `onOutboundTools`)
 * and `anthropic/passthrough-negotiation.ts` (symbol `REMOVABLE_BETA_FIELDS`)
 * are what they will be sent to read.
 *
 * The PASSTHROUGH arm is the one that most needs saying: its body is never
 * translated, so nothing else in `server.ts` has looked at its tools, and it is
 * the arm `llm-gateway-protocol.md#feature-pass-through` is literally about
 * ("inspect without modifying").
 */
import { test, expect, describe } from 'bun:test';
import { startAdapter } from '../server.ts';

const MODEL = 'claude-sonnet-4-5-20250929';
const PASSTHROUGH = { kind: 'anthropic-messages', baseUrl: 'https://llm-proxy.test', apiKey: 'sk-wire' } as const;

/** One MCP tool, one native tool — so "names only, `mcp__` filtered later" is visible. */
const INBOUND_TOOLS = [
  { name: 'mcp__dpGitlab__list_projects', description: 'd', input_schema: { type: 'object', properties: {} } },
  { name: 'Read', description: 'd', input_schema: { type: 'object', properties: {} } },
];

interface Seen { body: any }

function recordingUpstream(seen: Seen[], reply: () => Response): typeof fetch {
  return (async (_url: string | URL | Request, init?: RequestInit) => {
    seen.push({ body: JSON.parse(String(init?.body ?? 'null')) });
    return reply();
  }) as unknown as typeof fetch;
}

const anthropicOk = () => new Response(
  JSON.stringify({ id: 'msg_1', type: 'message', content: [{ type: 'text', text: 'ok' }] }),
  { status: 200, headers: { 'content-type': 'application/json' } },
);
const chatOk = () => new Response(
  JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], usage: {} }),
  { status: 200, headers: { 'content-type': 'application/json' } },
);

async function postMessages(port: number, body: unknown): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function messagesRequest(): Record<string, unknown> {
  return { model: MODEL, max_tokens: 64, messages: [{ role: 'user', content: 'hi' }], stream: false, tools: INBOUND_TOOLS };
}

describe('DA2.3 — onOutboundTools observes, and withholds nothing', () => {
  test('the UNTRANSLATED passthrough arm reports the names and forwards every tool', async () => {
    const seen: Seen[] = [];
    const reported: Array<{ upstream: string; model: string; toolNames: readonly string[] }> = [];
    const adapter = await startAdapter({
      upstream: { kind: 'openai-compatible', baseUrl: 'https://llm-proxy.test' },
      upstreamForModel: () => PASSTHROUGH,
      fetchImpl: recordingUpstream(seen, anthropicOk),
      onOutboundTools: info => { reported.push(info); },
    });
    try {
      expect((await postMessages(adapter.port, messagesRequest())).status).toBe(200);
      expect(reported).toHaveLength(1);
      expect(reported[0]!.upstream).toBe('anthropic-messages');
      expect(reported[0]!.toolNames).toEqual(['mcp__dpGitlab__list_projects', 'Read']);
      // The refusal, pinned: the body upstream saw is the body the client sent.
      expect(seen).toHaveLength(1);
      expect(seen[0]!.body.tools).toEqual(INBOUND_TOOLS);
    } finally {
      await adapter.close();
    }
  });

  test('the TRANSLATED anthropic arm reports the names and forwards every tool', async () => {
    const seen: Seen[] = [];
    const reported: Array<{ upstream: string; model: string; toolNames: readonly string[] }> = [];
    const adapter = await startAdapter({
      jwt: 'j',
      fetchImpl: recordingUpstream(seen, chatOk),
      onOutboundTools: info => { reported.push(info); },
    });
    try {
      expect((await postMessages(adapter.port, messagesRequest())).status).toBe(200);
      expect(reported).toHaveLength(1);
      expect(reported[0]!.toolNames).toEqual(['mcp__dpGitlab__list_projects', 'Read']);
      // Translated, so the shape moves; the SET of tool names must not.
      expect(seen).toHaveLength(1);
      expect((seen[0]!.body.tools ?? []).map((t: any) => t.function?.name ?? t.name))
        .toEqual(['mcp__dpGitlab__list_projects', 'Read']);
    } finally {
      await adapter.close();
    }
  });

  test('THE BOUNDARY — a turn with no tools reports an empty list rather than nothing', async () => {
    // Without this the two cases above cannot tell "the sink fires per turn"
    // from "the sink fires when tools are present", and the host's dedup key
    // carries a `+tools` tier that depends on the difference.
    const reported: Array<{ toolNames: readonly string[] }> = [];
    const adapter = await startAdapter({
      jwt: 'j',
      fetchImpl: recordingUpstream([], chatOk),
      onOutboundTools: info => { reported.push(info); },
    });
    try {
      await postMessages(adapter.port, { model: MODEL, max_tokens: 64, messages: [{ role: 'user', content: 'hi' }], stream: false });
      expect(reported).toHaveLength(1);
      expect(reported[0]!.toolNames).toEqual([]);
    } finally {
      await adapter.close();
    }
  });

  test('a THROWING sink never fails the turn', async () => {
    const adapter = await startAdapter({
      jwt: 'j',
      fetchImpl: recordingUpstream([], chatOk),
      onOutboundTools: () => { throw new Error('sink exploded'); },
    });
    try {
      expect((await postMessages(adapter.port, messagesRequest())).status).toBe(200);
    } finally {
      await adapter.close();
    }
  });
});
