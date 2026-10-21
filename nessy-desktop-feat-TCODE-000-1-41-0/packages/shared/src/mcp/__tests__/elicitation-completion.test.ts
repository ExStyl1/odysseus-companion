/**
 * The host half of URL-mode elicitation: the completion notification and the
 * `-32042` retry.
 *
 * The vendored SDK has shipped `ElicitationCompleteNotificationSchema` and
 * `ErrorCode.UrlElicitationRequired` since 1.29.0 and nothing in Nessy consumed
 * either, so a server that finished an out-of-band interaction was talking to
 * nobody and a server that asked us to complete one first got its error handed
 * straight to the model.
 *
 * Driven at the protocol level through a scripted transport rather than through a
 * real MCP server, because the cases that matter are malformed and hostile frames
 * a well-behaved server would never send.
 *
 * Spec: `https://modelcontextprotocol.io/specification/2025-11-25/client/elicitation`
 * (the version `LATEST_PROTOCOL_VERSION` in the vendored SDK names), fetched with
 * `curl` as `.md`.
 */

import { describe, expect, it } from 'bun:test';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { ElicitRequest, ElicitResult } from '@modelcontextprotocol/sdk/types.js';
import { NessyMcpClient } from '../client.ts';

interface ScriptedTransport extends Transport {
  /** Deliver a server-to-client frame, as a server would. */
  deliver(message: unknown): void;
  /** Every `tools/call` the client sent. */
  readonly calls: Array<Record<string, unknown>>;
}

/**
 * A transport that answers `initialize`/`tools/list` and replies to each
 * `tools/call` from a script of canned outcomes.
 */
function scriptedTransport(script: Array<{ error?: unknown; result?: unknown }>): ScriptedTransport {
  const calls: Array<Record<string, unknown>> = [];
  let index = 0;
  const transport: ScriptedTransport = {
    calls,
    async start() {},
    async close() { transport.onclose?.(); },
    deliver(message: unknown) {
      transport.onmessage?.(message as JSONRPCMessage);
    },
    async send(message: JSONRPCMessage) {
      const frame = message as unknown as Record<string, unknown>;
      const { id, method } = frame as { id?: string | number; method?: string };
      if (method === 'initialize') {
        transport.deliver({
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: LATEST_PROTOCOL_VERSION,
            capabilities: { tools: {} },
            serverInfo: { name: 'scripted', version: '1.0.0' },
          },
        });
        return;
      }
      if (method === 'tools/list') {
        transport.deliver({ jsonrpc: '2.0', id, result: { tools: [{ name: 'connect', inputSchema: { type: 'object' } }] } });
        return;
      }
      if (method === 'tools/call') {
        calls.push(frame);
        const outcome = script[index] ?? { result: { content: [] } };
        index += 1;
        transport.deliver(outcome.error !== undefined
          ? { jsonrpc: '2.0', id, error: outcome.error }
          : { jsonrpc: '2.0', id, result: outcome.result });
        return;
      }
      // notifications and anything else need no reply.
    },
  } as ScriptedTransport;
  return transport;
}

const URL_ELICITATION = {
  mode: 'url',
  elicitationId: 'elicit-1',
  url: 'https://mcp.example.test/connect?elicitationId=elicit-1',
  message: 'Authorization is required to access your files.',
};

function urlElicitationRequired(elicitations: unknown[] = [URL_ELICITATION]) {
  return { code: -32042, message: 'This request requires more information.', data: { elicitations } };
}

interface Harness {
  client: NessyMcpClient;
  transport: ScriptedTransport;
  /** Every elicitation request the handler was asked to show. */
  shown: ElicitRequest[];
}

async function harness(options: {
  script?: Array<{ error?: unknown; result?: unknown }>;
  /** What the user does with each elicitation; defaults to accepting. */
  answer?: (request: ElicitRequest) => ElicitResult;
  /** Delivered when the handler is asked, so a retry's wait is satisfied. */
  completeOnShow?: boolean;
  withHandler?: boolean;
}): Promise<Harness> {
  const transport = scriptedTransport(options.script ?? []);
  const shown: ElicitRequest[] = [];
  const client = new NessyMcpClient({ transport: 'http', url: 'https://mcp.example.test/mcp' }, {
    ...(options.withHandler === false ? {} : {
      elicitationHandler: async (request: ElicitRequest) => {
        shown.push(request);
        const result = options.answer?.(request) ?? { action: 'accept' as const };
        if (options.completeOnShow) {
          const id = (request.params as { elicitationId?: string }).elicitationId;
          transport.deliver({
            jsonrpc: '2.0',
            method: 'notifications/elicitation/complete',
            params: { elicitationId: id },
          });
        }
        return result;
      },
    }),
    transport,
    // Bounded so the "notification never arrives" case is a test, not a hang.
    elicitationCompletionTimeoutMs: 40,
  });
  await client.connect();
  return { client, transport, shown };
}

function state(client: NessyMcpClient) {
  const internals = client as unknown as {
    knownElicitations: Set<string>;
    completedElicitations: Set<string>;
    elicitationWaiters: Map<string, () => void>;
  };
  return {
    known: [...internals.knownElicitations],
    completed: [...internals.completedElicitations],
    waiting: [...internals.elicitationWaiters.keys()],
  };
}

/** Deliver a completion notification and let the SDK's async dispatch settle. */
async function completion(transport: ScriptedTransport, elicitationId: unknown): Promise<void> {
  transport.deliver({
    jsonrpc: '2.0',
    method: 'notifications/elicitation/complete',
    params: { elicitationId },
  });
  await new Promise(resolve => setTimeout(resolve, 0));
}

describe('notifications/elicitation/complete', () => {
  /**
   * `elicitation.md:406` — "* **MUST** ignore notifications referencing unknown
   * or already-completed IDs."
   *
   * The threat this MUST exists for is a malicious or confused server sending
   * arbitrary ids, so "ignore" has to mean no state change and no throw — not
   * merely "does not crash".
   */
  it('ignores an id this client never issued, with no state change and no throw', async () => {
    const { client, transport } = await harness({});
    expect(state(client)).toEqual({ known: [], completed: [], waiting: [] });

    for (const hostile of ['never-issued', '', null, 42, { elicitationId: 'nested' }]) {
      await completion(transport, hostile);
    }

    expect(state(client)).toEqual({ known: [], completed: [], waiting: [] });
    await client.close();
  });

  it('ignores a second notification for an id already completed', async () => {
    const { client, transport } = await harness({});
    // Establish the id the way a server does: a URL-mode elicitation/create.
    const handler = (client as unknown as { client: { _requestHandlers: Map<string, (request: unknown, extra: unknown) => Promise<unknown>> } })
      .client._requestHandlers.get('elicitation/create')!;
    await handler(
      { method: 'elicitation/create', params: URL_ELICITATION },
      { signal: new AbortController().signal },
    );
    expect(state(client).known).toEqual(['elicit-1']);

    await completion(transport, 'elicit-1');
    expect(state(client)).toEqual({ known: [], completed: ['elicit-1'], waiting: [] });

    // The replay must change nothing: no re-completion, no resurrection of the id.
    await completion(transport, 'elicit-1');
    expect(state(client)).toEqual({ known: [], completed: ['elicit-1'], waiting: [] });
    await client.close();
  });
});

describe('the -32042 retry', () => {
  /**
   * `elicitation.md:424`/`:426` — the error names "a list of elicitations that
   * are required to complete before the original can be retried", and `:407`
   * makes waiting for the completion notification before retrying a client MAY.
   * `:392` is why the wait is not optional once we do retry: an `accept` "does not
   * mean that the interaction is complete".
   */
  it('retries once after the named elicitation completes', async () => {
    const { client, transport, shown } = await harness({
      script: [{ error: urlElicitationRequired() }, { result: { content: [{ type: 'text', text: 'done' }] } }],
      completeOnShow: true,
    });

    const result = await client.callTool('connect', {});

    expect(result).toEqual({ content: [{ type: 'text', text: 'done' }] });
    // The user saw the server's own URL-mode elicitation, through the same handler
    // an `elicitation/create` goes through.
    expect(shown).toHaveLength(1);
    expect(shown[0]!.params).toMatchObject({ mode: 'url', elicitationId: 'elicit-1' });
    // Exactly one retry, and nothing left waiting.
    expect(transport.calls).toHaveLength(2);
    expect(state(client)).toEqual({ known: [], completed: ['elicit-1'], waiting: [] });
    await client.close();
  });

  it('never retries an elicitation the user refused', async () => {
    for (const action of ['decline', 'cancel'] as const) {
      const { client, transport, shown } = await harness({
        script: [{ error: urlElicitationRequired() }, { result: { content: [] } }],
        answer: () => ({ action }),
        completeOnShow: true,
      });

      await expect(client.callTool('connect', {})).rejects.toThrow('This request requires more information.');
      expect(shown).toHaveLength(1);
      // One call only: the refusal is a decision, not a transient failure.
      expect(transport.calls).toHaveLength(1);
      // And nothing is left waiting on an id the retry will never use.
      expect(state(client).waiting).toEqual([]);
      await client.close();
    }
  });

  it('does not retry when the completion notification never arrives', async () => {
    const { client, transport } = await harness({
      script: [{ error: urlElicitationRequired() }, { result: { content: [] } }],
      completeOnShow: false,
    });

    await expect(client.callTool('connect', {})).rejects.toThrow('This request requires more information.');
    expect(transport.calls).toHaveLength(1);
    expect(state(client).waiting).toEqual([]);
    await client.close();
  });

  it('does not retry a payload that breaks the spec, or with no handler to ask', async () => {
    // `:428` — "Any elicitations returned in the error **MUST** be URL mode
    // elicitations and have an `elicitationId` property."
    const malformed: unknown[][] = [
      [{ mode: 'url', url: 'https://mcp.example.test/x' }],            // no elicitationId
      [{ mode: 'form', elicitationId: 'e', url: 'https://x.test' }],   // not URL mode
      [{ mode: 'url', elicitationId: 'e' }],                            // no url
      [{ mode: 'url', elicitationId: 'e', url: 'https://x.test' }, { mode: 'url', elicitationId: 'e', url: 'https://x.test' }], // duplicate id
      [],                                                               // empty list
    ];
    for (const elicitations of malformed) {
      const { client, transport, shown } = await harness({
        script: [{ error: urlElicitationRequired(elicitations) }, { result: { content: [] } }],
        completeOnShow: true,
      });
      await expect(client.callTool('connect', {})).rejects.toThrow('This request requires more information.');
      expect(shown).toEqual([]);
      expect(transport.calls).toHaveLength(1);
      await client.close();
    }

    // No elicitation handler means no way to obtain the consent `:725` requires
    // before a URL is opened, so the server's error surfaces unchanged.
    const bare = await harness({
      script: [{ error: urlElicitationRequired() }, { result: { content: [] } }],
      withHandler: false,
    });
    await expect(bare.client.callTool('connect', {})).rejects.toThrow('This request requires more information.');
    expect(bare.transport.calls).toHaveLength(1);
    await bare.client.close();
  });

  it('surfaces a second -32042 instead of retrying again', async () => {
    const { client, transport } = await harness({
      script: [{ error: urlElicitationRequired() }, { error: urlElicitationRequired() }],
      completeOnShow: true,
    });

    await expect(client.callTool('connect', {})).rejects.toThrow('This request requires more information.');
    // Retried once, and the retry's own -32042 propagated rather than looping.
    expect(transport.calls).toHaveLength(2);
    await client.close();
  });

  it('leaves an unrelated error untouched', async () => {
    const { client, transport, shown } = await harness({
      script: [{ error: { code: -32603, message: 'internal boom' } }],
    });

    await expect(client.callTool('connect', {})).rejects.toThrow('internal boom');
    expect(shown).toEqual([]);
    expect(transport.calls).toHaveLength(1);
    await client.close();
  });
});
