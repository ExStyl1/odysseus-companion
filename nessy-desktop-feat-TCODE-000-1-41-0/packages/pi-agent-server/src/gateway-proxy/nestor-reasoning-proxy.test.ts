import http from 'node:http';

import { describe, expect, test } from 'bun:test';

import {
  formatGatewayThrottleLog,
  NESTOR_GATEWAY_BASE_URL,
  rewriteChatCompletionSseText,
  rewriteNonStreamChatResponse,
  sanitizeNestorChatRequest,
  shouldUseNestorReasoningProxy,
  startNestorReasoningProxy,
} from './nestor-reasoning-proxy.ts';

/** The gateway Qwen id — the one whose answers leak `<think>`, so it splits. */
const QWEN_MODEL = 'tgpt/qwen35-397b-a17b-fp8';

function dataFrames(sse: string): any[] {
  return sse
    .split('\n')
    .filter(line => line.startsWith('data: '))
    .map(line => line.slice('data: '.length).trim())
    .filter(data => data && data !== '[DONE]')
    .map(data => JSON.parse(data));
}

describe('Nestor reasoning proxy', () => {
  test('gates strictly to the verified Nestor gateway prefix', () => {
    expect(shouldUseNestorReasoningProxy(NESTOR_GATEWAY_BASE_URL)).toBe(true);
    expect(shouldUseNestorReasoningProxy(`${NESTOR_GATEWAY_BASE_URL}/`)).toBe(true);
    expect(shouldUseNestorReasoningProxy(`${NESTOR_GATEWAY_BASE_URL}/chat/completions`)).toBe(true);
    expect(shouldUseNestorReasoningProxy(`${NESTOR_GATEWAY_BASE_URL}beta`)).toBe(false);
    expect(shouldUseNestorReasoningProxy(`${NESTOR_GATEWAY_BASE_URL}-custom`)).toBe(false);
    expect(shouldUseNestorReasoningProxy('https://code-completion-nestor.tcsbank.ru/api/v1/other')).toBe(false);
    expect(shouldUseNestorReasoningProxy('http://127.0.0.1:11434/v1')).toBe(false);
  });

  test('strips tool_choice and sanitizes tool schemas', () => {
    const cleaned = sanitizeNestorChatRequest({
      model: 'tgpt/qwen35-397b-a17b-fp8',
      tool_choice: 'auto',
      tools: [{
        type: 'function',
        function: {
          name: 'run',
          parameters: {
            type: 'object',
            additionalProperties: false,
            required: ['cmd'],
            properties: {
              cmd: { type: 'string', required: ['nested'], additionalProperties: false },
            },
          },
        },
      }],
    }) as any;

    expect(cleaned.tool_choice).toBeUndefined();
    const params = cleaned.tools[0].function.parameters;
    expect(params.required).toBeUndefined();
    expect(params.additionalProperties).toBeUndefined();
    expect(params.properties.cmd.required).toBeUndefined();
    expect(params.properties.cmd.additionalProperties).toBeUndefined();
  });

  test('rewrites inline think spans in SSE deltas across frame boundaries', () => {
    const base = { id: 'c', object: 'chat.completion.chunk', model: 'm' };
    const input = [
      `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { content: '<thi' }, finish_reason: null }] })}`,
      '',
      `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { content: 'nk>plan</thi' }, finish_reason: null }] })}`,
      '',
      `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { content: 'nk>answer' }, finish_reason: null }] })}`,
      '',
      `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}`,
      '',
      'data: [DONE]',
      '',
    ].join('\n');

    const frames = dataFrames(rewriteChatCompletionSseText(input));
    const deltas = frames.flatMap(frame => frame.choices.map((choice: any) => choice.delta));
    const reasoning = deltas.map(delta => delta.reasoning_content ?? '').join('');

    expect(reasoning).toBe('plan');
    expect(deltas.some(delta => delta.content === 'answer')).toBe(true);
    expect(JSON.stringify(deltas)).not.toContain('<think>');
  });

  test('preserves terminal SSE frame when the final frame also carries content', () => {
    const base = { id: 'c', object: 'chat.completion.chunk', model: 'm' };
    const input = [
      `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { content: '<think>plan</think>answer' }, finish_reason: 'stop' }] })}`,
      '',
      'data: [DONE]',
      '',
    ].join('\n');

    const frames = dataFrames(rewriteChatCompletionSseText(input));
    const deltas = frames.flatMap(frame => frame.choices.map((choice: any) => choice.delta));

    expect(deltas.some(delta => delta.reasoning_content === 'plan')).toBe(true);
    expect(deltas.some(delta => delta.content === 'answer')).toBe(true);
    expect(frames.some(frame => frame.choices.some((choice: any) => choice.finish_reason === 'stop'))).toBe(true);
    expect(JSON.stringify(frames)).not.toContain('<think>');
  });

  test('rewrites non-stream inline think spans while preserving usage', () => {
    const output = rewriteNonStreamChatResponse({
      choices: [{ message: { content: '<think>plan</think>answer' } }],
      usage: { prompt_tokens: 1, completion_tokens: 2, reasoning_tokens: 3, total_tokens: 6 },
    }) as any;

    expect(output.choices[0].message.content).toBe('answer');
    expect(output.choices[0].message.reasoning_content).toBe('plan');
    expect(output.usage.reasoning_tokens).toBe(3);
  });
});

describe('formatGatewayThrottleLog', () => {
  test('captures throttle evidence with trace ids, never auth material', () => {
    const headers = new Headers({
      'retry-after': '17',
      'x-request-id': 'req-1',
      'x-trace-id': 'trace-1',
      'nestor-token': 'MUST-NEVER-APPEAR',
    });
    const line = formatGatewayThrottleLog(429, headers)!;
    expect(line).toContain('status=429');
    expect(line).toContain('retry-after=17');
    expect(line).toContain('x-request-id=req-1');
    expect(line).toContain('x-trace-id=trace-1');
    expect(line).not.toContain('MUST-NEVER-APPEAR');
  });

  test('stays silent for ordinary statuses', () => {
    expect(formatGatewayThrottleLog(200, new Headers())).toBeNull();
    expect(formatGatewayThrottleLog(400, new Headers())).toBeNull();
    expect(formatGatewayThrottleLog(503, new Headers())).not.toBeNull();
  });

  test('names every allow-listed field even when the gateway sends none of them', () => {
    // The gateway advertises no rate-limit headers on success (verified
    // 2026-08-07), so "which of these was absent on the live 429" is itself the
    // finding this log exists to deliver. A line that silently omitted the
    // missing fields could not answer it.
    const line = formatGatewayThrottleLog(429, new Headers())!;
    for (const field of ['retry-after', 'x-request-id', 'x-trace-id', 'x-envoy-upstream-service-time']) {
      expect(line).toContain(`${field}=-`);
    }
  });
});

/** Capture stderr for the duration of `run`, restoring it unconditionally. */
async function withCapturedStderr(run: () => Promise<void>): Promise<string> {
  const original = process.stderr.write;
  let captured = '';
  process.stderr.write = ((chunk: unknown, ...rest: unknown[]) => {
    captured += String(chunk);
    return (original as (...args: never[]) => boolean).apply(
      process.stderr,
      [chunk, ...rest] as never[],
    );
  }) as typeof process.stderr.write;
  try {
    await run();
  } finally {
    process.stderr.write = original;
  }
  return captured;
}

function stubUpstream(status: number, headers: Record<string, string>): typeof fetch {
  return (async () => new Response(
    JSON.stringify({ error: { message: 'stub' } }),
    { status, headers: { 'content-type': 'application/json', ...headers } },
  )) as unknown as typeof fetch;
}

describe('the proxy writes throttle evidence for a real upstream response', () => {
  test('logs a throttled response and stays silent on a healthy one', async () => {
    // The 429 the desktop must survive is only reproducible in production, so
    // the log line is the whole evidence trail. This drives it through the real
    // server + the real forwarding point, not just the formatter.
    const throttled = await withCapturedStderr(async () => {
      const proxy = await startNestorReasoningProxy(
        'https://upstream.invalid/v1',
        stubUpstream(429, {
          'retry-after': '31',
          'x-request-id': 'req-live',
          'x-trace-id': 'trace-live',
          'x-nestor-session': 'MUST-NEVER-APPEAR',
        }),
      );
      try {
        const res = await fetch(`${proxy.localBaseUrl}/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: 'Bearer SECRET-JWT' },
          body: JSON.stringify({ model: 'm', messages: [] }),
        });
        expect(res.status).toBe(429);
        await res.text();
      } finally {
        await proxy.close();
      }
    });

    expect(throttled).toContain('[nestor-proxy] upstream status=429');
    expect(throttled).toContain('retry-after=31');
    expect(throttled).toContain('x-request-id=req-live');
    expect(throttled).toContain('x-trace-id=trace-live');
    // Neither the request's bearer token nor any non-allow-listed header leaks.
    expect(throttled).not.toContain('SECRET-JWT');
    expect(throttled).not.toContain('MUST-NEVER-APPEAR');

    const healthy = await withCapturedStderr(async () => {
      const proxy = await startNestorReasoningProxy(
        'https://upstream.invalid/v1',
        stubUpstream(200, { 'x-request-id': 'req-ok' }),
      );
      try {
        const res = await fetch(`${proxy.localBaseUrl}/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: 'm', messages: [] }),
        });
        expect(res.status).toBe(200);
        await res.text();
      } finally {
        await proxy.close();
      }
    });

    expect(healthy).not.toContain('[nestor-proxy]');
  });
});

/**
 * C6 — the proxy now fronts BYO endpoints too, so what used to be implied by
 * "the proxy is running" has to be decided per upstream and per request.
 */
describe('gateway-keyed vs model-keyed behaviour', () => {
  /** Captures what the upstream actually received. */
  function recordingUpstream(): { calls: Array<{ url: string; headers: Headers; body: string }>; fetch: typeof fetch } {
    const calls: Array<{ url: string; headers: Headers; body: string }> = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({
        url: String(url),
        headers: new Headers(init?.headers),
        body: typeof init?.body === 'string' ? init.body : '',
      });
      return new Response(
        JSON.stringify({ choices: [{ message: { content: '<think>plan</think>answer' } }] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof fetch;
    return { calls, fetch: fetchImpl };
  }

  async function post(localBaseUrl: string, model: string): Promise<any> {
    const res = await fetch(`${localBaseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer BYO-KEY' },
      body: JSON.stringify({ model, messages: [], tool_choice: 'auto' }),
    });
    return res.json();
  }

  test('a BYO upstream keeps its Bearer key — the Nestor-Token swap is gateway-only', async () => {
    const upstream = recordingUpstream();
    const proxy = await startNestorReasoningProxy('https://llm-proxy.t-tech.team/v1', upstream.fetch);
    try {
      expect(proxy.isGatewayUpstream).toBe(false);
      await post(proxy.localBaseUrl, 'tgpt/qwen35-397b-a17b-fp8');

      // THE load-bearing assertion: swapping here would 401 every BYO request.
      expect(upstream.calls[0]!.headers.get('authorization')).toBe('Bearer BYO-KEY');
      expect(upstream.calls[0]!.headers.get('nestor-token')).toBeNull();
    } finally {
      await proxy.close();
    }
  });

  test('a Qwen model on a BYO upstream still gets the split and the dialect', async () => {
    const upstream = recordingUpstream();
    const proxy = await startNestorReasoningProxy('https://llm-proxy.t-tech.team/v1', upstream.fetch);
    try {
      const body = await post(proxy.localBaseUrl, 'tgpt/qwen35-397b-a17b-fp8');

      expect(body.choices[0].message.content).toBe('answer');
      expect(body.choices[0].message.reasoning_content).toBe('plan');
      // Dialect fired too: tool_choice is stripped for these two ids.
      expect(JSON.parse(upstream.calls[0]!.body).tool_choice).toBeUndefined();
    } finally {
      await proxy.close();
    }
  });

  test('a non-Qwen model on the same BYO upstream is passed through untouched', async () => {
    const upstream = recordingUpstream();
    const proxy = await startNestorReasoningProxy('https://llm-proxy.t-tech.team/v1', upstream.fetch);
    try {
      const body = await post(proxy.localBaseUrl, 'openrouter/google/gemini-3-pro');

      // No split: the raw `<think>` span survives, because this model does not
      // leak one and rewriting it would be us inventing a problem.
      expect(body.choices[0].message.content).toBe('<think>plan</think>answer');
      expect(body.choices[0].message.reasoning_content).toBeUndefined();
      // No dialect either — strict schemas work unadapted through llm-proxy.
      expect(JSON.parse(upstream.calls[0]!.body).tool_choice).toBe('auto');
    } finally {
      await proxy.close();
    }
  });

  test('names the outgoing auth SCHEME, and never the credential', async () => {
    // The instrument BYO-QWEN's half 2 needs: whether the Bearer survived is a
    // property of the request that left, and reading `upstreamHeaders` in the
    // source is not that measurement.
    const written: string[] = []
    const realWrite = process.stderr.write.bind(process.stderr)
    process.stderr.write = ((chunk: unknown) => { written.push(String(chunk)); return true }) as typeof process.stderr.write
    process.env.NESSY_PROXY_AUTH_DEBUG = '1'
    try {
      const byo = await startNestorReasoningProxy('https://llm-proxy.t-tech.team/v1', recordingUpstream().fetch);
      await post(byo.localBaseUrl, 'tgpt/qwen35-397b-a17b-fp8');
      await byo.close();

      const gateway = await startNestorReasoningProxy(NESTOR_GATEWAY_BASE_URL, recordingUpstream().fetch);
      await post(gateway.localBaseUrl, 'tgpt/qwen35-397b-a17b-fp8');
      await gateway.close();
    } finally {
      process.stderr.write = realWrite
      delete process.env.NESSY_PROXY_AUTH_DEBUG
    }

    const lines = written.filter(l => l.includes('[nestor-proxy] upstream auth:'))
    expect(lines.some(l => l.includes('upstream auth: bearer'))).toBe(true)
    expect(lines.some(l => l.includes('upstream auth: nestor-token'))).toBe(true)
    // THE line that makes this safe to ship: the key itself never appears.
    expect(written.join('').includes('BYO-KEY')).toBe(false)
  });

  test('stays silent unless the debug flag is set', async () => {
    // A normal run's stderr must be unchanged — the ring buffer that carries it
    // is 8KB and shared with real diagnostics.
    const written: string[] = []
    const realWrite = process.stderr.write.bind(process.stderr)
    process.stderr.write = ((chunk: unknown) => { written.push(String(chunk)); return true }) as typeof process.stderr.write
    delete process.env.NESSY_PROXY_AUTH_DEBUG
    try {
      const proxy = await startNestorReasoningProxy('https://llm-proxy.t-tech.team/v1', recordingUpstream().fetch);
      await post(proxy.localBaseUrl, 'tgpt/qwen35-397b-a17b-fp8');
      await proxy.close();
    } finally {
      process.stderr.write = realWrite
    }
    expect(written.filter(l => l.includes('upstream auth:'))).toEqual([])
  });

  test('the gateway upstream swaps the token and splits for ANY model (no regression)', async () => {
    const upstream = recordingUpstream();
    const proxy = await startNestorReasoningProxy(NESTOR_GATEWAY_BASE_URL, upstream.fetch);
    try {
      expect(proxy.isGatewayUpstream).toBe(true);
      const body = await post(proxy.localBaseUrl, 'tgpt/some-other-model');

      expect(upstream.calls[0]!.headers.get('nestor-token')).toBe('BYO-KEY');
      expect(upstream.calls[0]!.headers.get('authorization')).toBeNull();
      expect(body.choices[0].message.content).toBe('answer');
      expect(body.choices[0].message.reasoning_content).toBe('plan');
    } finally {
      await proxy.close();
    }
  });
})

/**
 * Every other case in this file hands the proxy a stubbed `fetch` that returns
 * a synthetic `Response`. That is why the hop-by-hop bug shipped: a synthetic
 * `Response` never carries `transfer-encoding`, so the header the proxy was
 * wrongly copying did not exist in any test. These two drive a REAL HTTP
 * upstream over a real socket, which is the only place the defect is visible.
 */
describe('a real socket upstream — hop-by-hop headers must not be forwarded', () => {
  /** An SSE upstream that streams `<think>` spans, chunked, like the gateway. */
  async function startSseUpstream(): Promise<{ baseUrl: string; close: () => Promise<void> }> {
    const server = http.createServer((req, res) => {
      req.resume();
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      const base = { id: 'chatcmpl-hop', object: 'chat.completion.chunk', model: QWEN_MODEL };
      for (const content of ['<thi', 'nk>plan</thi', 'nk>clean answer']) {
        res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { content }, finish_reason: null }] })}\n\n`);
      }
      res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
      res.end('data: [DONE]\n\n');
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('SSE upstream did not bind a TCP port');
    return {
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      close: () => new Promise(resolve => server.close(() => resolve())),
    };
  }

  function postSse(localBaseUrl: string): Promise<Response> {
    return fetch(`${localBaseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: QWEN_MODEL, stream: true, messages: [] }),
    });
  }

  test('strips the upstream connection headers instead of restating them', async () => {
    const upstream = await startSseUpstream();
    const proxy = await startNestorReasoningProxy(upstream.baseUrl);
    try {
      const res = await postSse(proxy.localBaseUrl);
      expect(res.status).toBe(200);

      // Node frames our rewritten body itself. Restating the upstream's own
      // framing here is what put `chunked, chunked` on the wire.
      expect(res.headers.get('transfer-encoding')).not.toContain(',');
      for (const hopByHop of ['connection', 'keep-alive', 'trailer', 'upgrade']) {
        expect(res.headers.get(hopByHop)).toBeNull();
      }
      // The end-to-end headers still have to survive.
      expect(res.headers.get('content-type')).toContain('text/event-stream');
      await res.text();
    } finally {
      await proxy.close();
      await upstream.close();
    }
  });

  test('two chained proxies still deliver the split stream', async () => {
    // The accumulation case, and the one CI actually hit: the real server test
    // runs the child's own proxy in front of the harness's, so a per-hop
    // `transfer-encoding` reached the client as `chunked, chunked, chunked` and
    // Bun refused the response with `UnsupportedTransferEncoding` — no thinking
    // deltas, no answer text, a turn that ended empty.
    const upstream = await startSseUpstream();
    const inner = await startNestorReasoningProxy(upstream.baseUrl);
    const outer = await startNestorReasoningProxy(inner.localBaseUrl);
    try {
      const res = await postSse(outer.localBaseUrl);
      expect(res.status).toBe(200);
      const frames = dataFrames(await res.text());
      const joined = (key: string) => frames
        .map(frame => frame.choices?.[0]?.delta?.[key])
        .filter((value: unknown): value is string => typeof value === 'string')
        .join('');

      expect(joined('reasoning_content')).toBe('plan');
      expect(joined('content')).toBe('clean answer');
    } finally {
      await outer.close();
      await inner.close();
      await upstream.close();
    }
  });
});

describe('a chunk that mixes split and unsplit choices', () => {
  /**
   * LATENT, AND FIXED ANYWAY. Nothing in this app asks for more than one choice,
   * so a chunk never mixes the two today. The fallback branch used to re-emit the
   * ORIGINAL chunk whenever any choice was passed through — and the original still
   * carries the split choices with their raw `<think>` content, so the answer
   * would arrive twice and the reasoning tags would leak into it.
   *
   * Written as a test rather than left as a comment because "unreachable today"
   * is a statement about today: `n > 1` is one request field away, and the defect
   * would then arrive as garbled output with no obvious cause.
   */
  test('emits only the untouched choices in the passthrough chunk, never the raw original', () => {
    const chunk = {
      id: 'c1',
      object: 'chat.completion.chunk',
      choices: [
        // Splittable: carries reasoning and answer in one string.
        { index: 0, delta: { content: '<think>plan</think>answer' } },
        // Not splittable: no string content, so it passes through untouched.
        { index: 1, delta: { role: 'assistant' } },
      ],
    }
    // A second chunk carrying `finish_reason`, because the streaming splitter
    // holds the answer until the turn ends rather than guessing at a boundary —
    // the first draft of this test asserted the answer on the opening chunk and
    // was measuring the splitter's buffering, not the fix.
    const finish = {
      id: 'c1',
      object: 'chat.completion.chunk',
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    }
    const out = rewriteChatCompletionSseText(
      `data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify(finish)}\n\n`,
    )

    // The reasoning is separated and the answer is clean.
    expect(out).toContain('"reasoning_content":"plan"')
    expect(out).toContain('"content":"answer"')
    // THE ASSERTION THIS EXISTS FOR: no chunk carries the unsplit original.
    expect(out).not.toContain('<think>')
    expect(out).not.toContain('</think>')
    // And the answer is said once, not once split plus once raw.
    expect(out.split('"content":"answer"').length - 1).toBe(1)
    // The untouched choice still survives — dropping it would be the opposite defect.
    expect(out).toContain('"role":"assistant"')
  })
})

/**
 * P6.58 — A STALLED UPSTREAM ENDS THE TURN, VISIBLY.
 *
 * The defect: `await reader.read()` on a socket the upstream stopped writing to
 * never settles, so the proxy holds the response open forever and Pi waits on
 * it forever. Neither side errors, so there is nothing for a user to report
 * except "it is thinking".
 *
 * The budget is passed in rather than taken from the process, because the
 * production floor is 10 000 ms — deliberately, so nobody sets a budget under a
 * thinking model's normal silence — and a suite cannot wait it out. What the
 * floor protects is pinned in `shared/src/llm/__tests__/stream-idle.test.ts`.
 */
describe('a stalled upstream stream', () => {
  /** An SSE upstream that writes `chunks` then goes silent WITHOUT closing. */
  function stallingSseUpstream(chunks: readonly string[]): typeof fetch {
    return (async () => new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          const encoder = new TextEncoder();
          for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
          // …and never closes.
        },
      }),
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    )) as unknown as typeof fetch;
  }

  const IDLE_MS = 150;

  async function readStalled(
    upstreamBaseUrl: string,
    chunks: readonly string[],
    model: string = QWEN_MODEL,
  ): Promise<{ body: string; elapsedMs: number }> {
    const proxy = await startNestorReasoningProxy(
      upstreamBaseUrl,
      stallingSseUpstream(chunks),
      false,
      IDLE_MS,
    );
    try {
      const started = Date.now();
      const res = await fetch(`${proxy.localBaseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model, messages: [], stream: true }),
      });
      // THE assertion the whole row is about: this settles at all. Before the
      // idle abort it never did, and the test would hang instead of failing.
      const body = await res.text();
      return { body, elapsedMs: Date.now() - started };
    } finally {
      await proxy.close();
    }
  }

  test('the split path ends the response with a named error the client raises', async () => {
    const chunk = JSON.stringify({
      id: 'c1',
      object: 'chat.completion.chunk',
      choices: [{ index: 0, delta: { content: 'partial ' } }],
    });
    const { body, elapsedMs } = await readStalled(NESTOR_GATEWAY_BASE_URL, [`data: ${chunk}\n\n`]);

    // (1) NOT two empty outputs — and the WHOLE partial answer, not the prefix
    // the `<think>` splitter had already let through. It withholds a trailing
    // window that might be the start of a marker (measured: it emitted only
    // "pa" of "partial " before `flushWithheldText` existed), and only a
    // finish-carrying chunk releases it — which a stalled turn never sends.
    expect(dataFrames(body).flatMap((frame: any) => (frame.choices ?? [])
      .map((choice: any) => choice?.delta?.content)
      .filter((content: unknown) => typeof content === 'string')).join(''))
      .toBe('partial ');
    // (2) It waited the budget rather than firing on the first quiet moment.
    expect(elapsedMs).toBeGreaterThanOrEqual(IDLE_MS);
    // (3) The user is told. `openai@6.44.0`'s stream reader throws an APIError
    // on a frame with a top-level `error`, which is what turns an invisible
    // stall into a failed turn Pi surfaces.
    const error = dataFrames(body).find(frame => frame.error);
    expect(error).toBeDefined();
    expect(error.error.type).toBe('upstream_stall_timeout');
    expect(error.error.message).toContain('stream idle');
    // …and the stream is properly terminated, not merely cut.
    expect(body.trimEnd().endsWith('data: [DONE]')).toBe(true);
  });

  test('the verbatim passthrough path gets the same treatment', async () => {
    // A BYO, non-Qwen upstream takes `pipeResponseBody` instead of the splitter,
    // and the two loops were separately written — so the gap was in both.
    const chunk = JSON.stringify({
      id: 'c1',
      object: 'chat.completion.chunk',
      choices: [{ index: 0, delta: { content: 'raw' } }],
    });
    // `gpt-4o`, deliberately: a Qwen id would be split even on a BYO upstream,
    // which is what the first draft of this test measured instead.
    const { body, elapsedMs } = await readStalled(
      'https://byo.invalid/v1',
      [`data: ${chunk}\n\n`],
      'gpt-4o',
    );

    // Verbatim: the bytes are forwarded untouched, so the whole frame is there.
    expect(body).toContain('"content":"raw"');
    expect(elapsedMs).toBeGreaterThanOrEqual(IDLE_MS);
    const error = dataFrames(body).find(frame => frame.error);
    expect(error?.error?.type).toBe('upstream_stall_timeout');
  });

  test('a stream that keeps speaking, then closes, is untouched', async () => {
    // The control. Same rig, same budget — the only difference is that this
    // upstream closes, so a watchdog that fired on cadence rather than silence
    // would corrupt this one too.
    const chunk = JSON.stringify({
      id: 'c1',
      object: 'chat.completion.chunk',
      choices: [{ index: 0, delta: { content: 'hello' } }],
    });
    const closing = (async () => new Response(
      `data: ${chunk}\n\ndata: [DONE]\n\n`,
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    )) as unknown as typeof fetch;
    const proxy = await startNestorReasoningProxy('https://byo.invalid/v1', closing, false, IDLE_MS);
    try {
      const res = await fetch(`${proxy.localBaseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'gpt-4o', messages: [], stream: true }),
      });
      const body = await res.text();
      expect(body).toContain('hello');
      expect(body).not.toContain('upstream_stall_timeout');
    } finally {
      await proxy.close();
    }
  });
});

/**
 * F1.854 — an upstream that fails AFTER the proxy has already sent its headers.
 *
 * `proxyRequest` answers `res.writeHead(upstream.status, …)` before it reads the
 * body, and both body loops rethrow every error that is not the idle watchdog's.
 * The server's catch used to answer every failure with `res.writeHead(502)` —
 * which throws `ERR_HTTP_HEADERS_SENT` when the headers are already out, inside a
 * `.catch` handler, so it became an UNHANDLED REJECTION. The Pi subprocess's own
 * `unhandledRejection` handler (`index.ts`) exits 1 on any, so one mid-stream
 * upstream failure lost the whole turn ('Pi subprocess exited unexpectedly').
 * Measured by SIT-y on the RC (`Cannot writeHead headers after they are sent to
 * the client`), and reproduced here without the app: both body paths raised that
 * rejection, and the client's read never settled at all — the response was
 * neither ended nor destroyed, so the listener below is the crash and the client
 * timeout is the hang.
 *
 * The listener stands in for `index.ts`'s: a rejection it records is a process
 * exit in the shipped child.
 */
describe('an upstream that fails after the headers were sent', () => {
  const CLIENT_TIMEOUT_MS = 3_000;

  /** An SSE upstream that writes one frame, then errors its body mid-stream. */
  function failingMidBodyUpstream(content: string): typeof fetch {
    return (async () => new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          const chunk = JSON.stringify({
            id: 'c1',
            object: 'chat.completion.chunk',
            choices: [{ index: 0, delta: { content } }],
          });
          controller.enqueue(new TextEncoder().encode(`data: ${chunk}\n\n`));
          setTimeout(() => controller.error(new Error('upstream reset mid-body')), 20);
        },
      }),
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    )) as unknown as typeof fetch;
  }

  async function readThroughProxy(
    upstreamBaseUrl: string,
    fetchImpl: typeof fetch,
    model: string,
  ): Promise<{
    status: number;
    contentType: string | null;
    body?: string;
    readError?: unknown;
    elapsedMs: number;
    rejections: unknown[];
  }> {
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => { rejections.push(reason); };
    process.on('unhandledRejection', onRejection);
    const proxy = await startNestorReasoningProxy(upstreamBaseUrl, fetchImpl, false, 5_000);
    try {
      const started = Date.now();
      const res = await fetch(`${proxy.localBaseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model, messages: [], stream: true }),
        signal: AbortSignal.timeout(CLIENT_TIMEOUT_MS),
      });
      let body: string | undefined;
      let readError: unknown;
      try {
        body = await res.text();
      } catch (error) {
        readError = error;
      }
      const elapsedMs = Date.now() - started;
      // A rejection raised by the server's catch lands a tick after the client
      // sees the stream end; give it that tick before reading the listener.
      await new Promise(resolve => setTimeout(resolve, 50));
      return {
        status: res.status,
        contentType: res.headers.get('content-type'),
        ...(body === undefined ? {} : { body }),
        ...(readError === undefined ? {} : { readError }),
        elapsedMs,
        rejections,
      };
    } finally {
      process.off('unhandledRejection', onRejection);
      await proxy.close();
    }
  }

  function expectTerminatedWithoutCrash(result: Awaited<ReturnType<typeof readThroughProxy>>): void {
    // (1) THE crash: no rejection escapes the server's catch.
    expect(result.rejections.map(reason => (reason instanceof Error ? reason.message : String(reason))))
      .toEqual([]);
    // (2) The client sees the stream END as a failure — promptly, not by giving
    // up on its own timeout, and never as a body that merely stopped early and
    // reads like a complete answer.
    expect(result.status).toBe(200);
    expect(result.readError).toBeDefined();
    expect((result.readError as Error | undefined)?.name).not.toBe('TimeoutError');
    expect(result.elapsedMs).toBeLessThan(CLIENT_TIMEOUT_MS);
  }

  test('the split path ends the response instead of answering a second writeHead', async () => {
    const result = await readThroughProxy(
      NESTOR_GATEWAY_BASE_URL,
      failingMidBodyUpstream('partial '),
      QWEN_MODEL,
    );
    expectTerminatedWithoutCrash(result);
  });

  test('the verbatim passthrough path gets the same treatment', async () => {
    // `gpt-4o` on a BYO upstream takes `pipeResponseBody`, the other loop.
    const result = await readThroughProxy(
      'https://byo.invalid/v1',
      failingMidBodyUpstream('raw'),
      'gpt-4o',
    );
    expectTerminatedWithoutCrash(result);
  });

  test('CONTROL: a failure BEFORE the headers still answers 502 with the error body', async () => {
    // Same rig and listener; the only difference is that the upstream call
    // itself fails, so nothing has been written and the 502 is still the answer.
    const refused = (async () => {
      throw new Error('connect ECONNREFUSED 127.0.0.1:1');
    }) as unknown as typeof fetch;
    const result = await readThroughProxy('https://byo.invalid/v1', refused, 'gpt-4o');
    expect(result.rejections).toEqual([]);
    expect(result.status).toBe(502);
    expect(result.contentType).toBe('application/json');
    expect(result.readError).toBeUndefined();
    expect(JSON.parse(result.body ?? '')).toEqual({ error: { message: 'connect ECONNREFUSED 127.0.0.1:1' } });
  });
});
