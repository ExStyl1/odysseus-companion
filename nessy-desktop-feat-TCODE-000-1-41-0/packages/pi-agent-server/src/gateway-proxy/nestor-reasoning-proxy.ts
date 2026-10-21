import http from 'node:http';
import { Buffer } from 'node:buffer';

import { extractReasoning, StreamingThinkSplitter } from '../../../shared/src/llm/think-splitter.ts';
import {
  readWithIdleTimeout,
  resolveStreamIdleTimeoutMs,
  StreamIdleTimeoutError,
} from '../../../shared/src/llm/stream-idle.ts';
import {
  NESTOR_GATEWAY_BASE_URL,
  NESTOR_GATEWAY_QWEN_DIALECT_V1,
  adaptToolRequestForDialect,
  isNestorGatewayQwenModel,
  isNestorGatewayUrl,
} from './tool-schema-dialect.ts';

export { NESTOR_GATEWAY_BASE_URL };

type JsonRecord = Record<string, unknown>;

export interface NestorReasoningProxyHandle {
  upstreamBaseUrl: string;
  localBaseUrl: string;
  /**
   * Whether the upstream is the verified Nessy Gateway. The proxy also runs in
   * front of BYO endpoints now (for the reasoning split), so "a proxy exists"
   * no longer means "we are on the gateway" — anything gateway-scoped (the
   * Nestor-Token swap, the 429 retry ladder) keys off THIS.
   */
  isGatewayUpstream: boolean;
  close: () => Promise<void>;
}

export function shouldUseNestorReasoningProxy(baseUrl: string | undefined): boolean {
  return isNestorGatewayUrl(baseUrl);
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function sanitizeNestorChatRequest(body: unknown, forceQwenDialect = false): unknown {
  return adaptToolRequestForDialect(body, {
    dialect: NESTOR_GATEWAY_QWEN_DIALECT_V1,
    force: forceQwenDialect,
  });
}

function cloneChunkWithChoices(chunk: JsonRecord, choices: unknown[]): JsonRecord {
  return {
    ...chunk,
    choices,
  };
}

function withoutContent(delta: JsonRecord): JsonRecord {
  const next = { ...delta };
  delete next.content;
  return next;
}

function makeDeltaChoice(choice: JsonRecord, delta: JsonRecord): JsonRecord {
  return {
    ...choice,
    delta,
    finish_reason: null,
  };
}

function makeReasoningAndAnswerChunks(chunk: JsonRecord, splitter: StreamingThinkSplitter): JsonRecord[] {
  const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
  const reasoningChoices: JsonRecord[] = [];
  const answerChoices: JsonRecord[] = [];
  const passthroughChoices: unknown[] = [];
  let touchedContent = false;

  for (const choice of choices) {
    if (!isRecord(choice) || !isRecord(choice.delta) || typeof choice.delta.content !== 'string') {
      passthroughChoices.push(choice);
      continue;
    }

    touchedContent = true;
    const { reasoning, answer } = splitter.push(choice.delta.content);
    const baseDelta = withoutContent(choice.delta);
    if (reasoning) {
      reasoningChoices.push(makeDeltaChoice(choice, { ...baseDelta, reasoning_content: reasoning }));
    }
    if (answer) {
      answerChoices.push(makeDeltaChoice(choice, { ...baseDelta, content: answer }));
    }
  }

  const chunks: JsonRecord[] = [];
  if (reasoningChoices.length > 0) chunks.push(cloneChunkWithChoices(chunk, reasoningChoices));
  if (answerChoices.length > 0) chunks.push(cloneChunkWithChoices(chunk, answerChoices));
  // A chunk NOTHING was split out of goes through untouched — that is the common
  // case and the original object is exactly right for it.
  if (!touchedContent) {
    chunks.push(chunk);
    return chunks;
  }
  // But when SOME choices were split and others were not, the original chunk is
  // the wrong thing to send: it still carries the split choices with their raw
  // `<think>` content, so the answer would arrive twice and the reasoning tags
  // would leak into it. Only the untouched choices belong here.
  //
  // Latent today — nothing in this app requests more than one choice, so a chunk
  // never mixes the two — and written this way because the alternative is a
  // defect that waits for the day something does.
  if (passthroughChoices.length > 0) chunks.push(cloneChunkWithChoices(chunk, passthroughChoices as JsonRecord[]));
  return chunks;
}

function makeFlushChunks(chunk: JsonRecord, splitter: StreamingThinkSplitter): JsonRecord[] {
  const flushed = splitter.flush();
  const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
  const template = choices.find(isRecord) ?? { index: 0, delta: {}, finish_reason: null };
  const chunks: JsonRecord[] = [];

  if (flushed.reasoning) {
    chunks.push(cloneChunkWithChoices(chunk, [
      makeDeltaChoice(template, { reasoning_content: flushed.reasoning }),
    ]));
  }
  if (flushed.answer) {
    chunks.push(cloneChunkWithChoices(chunk, [
      makeDeltaChoice(template, { content: flushed.answer }),
    ]));
  }

  return chunks;
}

function hasFinishReason(chunk: JsonRecord): boolean {
  const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
  return choices.some(choice => isRecord(choice) && choice.finish_reason);
}

function hasContentDelta(chunk: JsonRecord): boolean {
  const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
  return choices.some(choice => isRecord(choice)
    && isRecord(choice.delta)
    && typeof choice.delta.content === 'string');
}

function makeTerminalChunk(chunk: JsonRecord): JsonRecord {
  const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
  return cloneChunkWithChoices(chunk, choices.map(choice => {
    if (!isRecord(choice) || !isRecord(choice.delta)) return choice;
    return {
      ...choice,
      delta: withoutContent(choice.delta),
    };
  }));
}

function rewriteSseLine(
  rawLine: string,
  splitter: StreamingThinkSplitter,
  /**
   * P6.58 — hands the parsed chunk back so the rewriter can keep the LAST one.
   * A stalled upstream never sends a `finish_reason`, and that chunk is what
   * releases the splitter's withheld text; without a template to hang it on,
   * an abandoned turn silently loses its own tail. A callback rather than a
   * second parse in the caller: these are per-token frames.
   */
  onChunk?: (chunk: JsonRecord) => void,
): string {
  const line = rawLine.trimEnd();
  if (!line.startsWith('data:')) {
    return line ? `${line}\n` : '';
  }

  const data = line.slice(5).trim();
  if (!data) return '\n';
  if (data === '[DONE]') return 'data: [DONE]\n\n';

  let chunk: JsonRecord;
  try {
    chunk = JSON.parse(data) as JsonRecord;
  } catch {
    return `${line}\n\n`;
  }
  onChunk?.(chunk);

  let output = '';
  const hasFinish = hasFinishReason(chunk);
  const touchedContent = hasContentDelta(chunk);

  if (hasFinish && !touchedContent) {
    for (const flushed of makeFlushChunks(chunk, splitter)) {
      output += `data: ${JSON.stringify(flushed)}\n\n`;
    }
    output += `data: ${JSON.stringify(chunk)}\n\n`;
    return output;
  }

  for (const rewritten of makeReasoningAndAnswerChunks(chunk, splitter)) {
    output += `data: ${JSON.stringify(rewritten)}\n\n`;
  }

  if (hasFinish) {
    for (const flushed of makeFlushChunks(chunk, splitter)) {
      output += `data: ${JSON.stringify(flushed)}\n\n`;
    }
    output += `data: ${JSON.stringify(makeTerminalChunk(chunk))}\n\n`;
  }

  return output;
}

class ChatCompletionSseRewriter {
  private readonly splitter = new StreamingThinkSplitter();
  private pending = '';
  private lastChunk: JsonRecord | undefined;

  push(input: string): string {
    this.pending += input;
    let output = '';

    while (true) {
      const newlineIndex = this.pending.indexOf('\n');
      if (newlineIndex === -1) break;
      const line = this.pending.slice(0, newlineIndex);
      this.pending = this.pending.slice(newlineIndex + 1);
      output += rewriteSseLine(line, this.splitter, (chunk) => { this.lastChunk = chunk; });
    }

    return output;
  }

  flush(): string {
    const tail = this.pending;
    this.pending = '';
    return tail ? rewriteSseLine(tail, this.splitter, (chunk) => { this.lastChunk = chunk; }) : '';
  }

  /**
   * P6.58 — release what the `<think>` splitter is still withholding, for a
   * turn that will never send a `finish_reason` because the upstream went
   * silent.
   *
   * The splitter holds back any trailing text it cannot yet prove is not the
   * start of a `<think>`/`</think>` marker, and only a finish-carrying chunk
   * flushes it. So on a stall the last few characters of the answer — six of
   * the eight in "partial ", measured — never reach the client. The first
   * version of the idle abort dropped them, and the test asserting the partial
   * text survives is what caught it, exactly as it did for the codex route
   * (`from-chat-stream.ts`'s `closeOpenItems`).
   *
   * The released text rides the LAST chunk's own choice template, so it carries
   * that chunk's `finish_reason` — `null` on a stalled turn. Synthesizing a
   * `"stop"` here would claim the model finished, which is the opposite of what
   * happened.
   */
  flushWithheldText(): string {
    if (!this.lastChunk) return '';
    let output = '';
    for (const flushed of makeFlushChunks(this.lastChunk, this.splitter)) {
      output += `data: ${JSON.stringify(flushed)}\n\n`;
    }
    return output;
  }
}

export function rewriteChatCompletionSseText(input: string): string {
  const rewriter = new ChatCompletionSseRewriter();
  return rewriter.push(input) + rewriter.flush();
}

/**
 * P6.58 — say out loud that the upstream went silent, in the client's own wire.
 *
 * Both stream paths below reach here on a stall. Ending the response quietly
 * would leave the caller with a truncated stream and no reason, which is the
 * hang with a shorter wait; `openai@6.44.0`'s `Stream` throws an `APIError` the
 * moment a frame carries a top-level `error` (`core/streaming.js`:
 * `if (data && data.error) throw new APIError(...)`), and `@earendil-works/pi-ai`
 * drives the chat-completions path through exactly that client. So one frame
 * turns an invisible stall into a named turn failure the user sees.
 *
 * Written on the wire rather than logged, deliberately: the proxy's stderr
 * reaches no surface the user of a packaged build can read.
 */
function writeStreamIdleError(res: http.ServerResponse, error: StreamIdleTimeoutError): void {
  const payload = {
    error: {
      message: `Nessy gateway proxy: ${error.message}; the turn was abandoned`,
      type: 'upstream_stall_timeout',
      code: 'upstream_stall_timeout',
    },
  };
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
  res.write('data: [DONE]\n\n');
}

/** Verbatim passthrough — used when this request is not one we split. */
async function pipeResponseBody(
  upstream: Response,
  res: http.ServerResponse,
  idleTimeoutMs: number,
): Promise<void> {
  const reader = upstream.body?.getReader();
  if (!reader) {
    res.end();
    return;
  }
  try {
    for await (const value of readWithIdleTimeout(reader, { idleTimeoutMs })) {
      res.write(Buffer.from(value));
    }
  } catch (error) {
    if (!(error instanceof StreamIdleTimeoutError)) throw error;
    writeStreamIdleError(res, error);
  }
  res.end();
}

async function writeRewrittenChatCompletionSse(
  upstream: Response,
  res: http.ServerResponse,
  idleTimeoutMs: number,
): Promise<void> {
  const reader = upstream.body?.getReader();
  if (!reader) {
    res.end();
    return;
  }

  const decoder = new TextDecoder();
  const rewriter = new ChatCompletionSseRewriter();

  try {
    for await (const value of readWithIdleTimeout(reader, { idleTimeoutMs })) {
      const text = decoder.decode(value, { stream: true });
      const rewritten = rewriter.push(text);
      if (rewritten) res.write(rewritten);
    }
  } catch (error) {
    if (!(error instanceof StreamIdleTimeoutError)) throw error;
    // Flush what the splitter is still withholding BEFORE the error frame — see
    // `flushWithheldText`. Order matters: decoder tail, then the pending line,
    // then the splitter's own held text.
    const partial = rewriter.push(decoder.decode())
      + rewriter.flush()
      + rewriter.flushWithheldText();
    if (partial) res.write(partial);
    writeStreamIdleError(res, error);
    res.end();
    return;
  }

  const tail = decoder.decode();
  const rewrittenTail = rewriter.push(tail) + rewriter.flush();
  if (rewrittenTail) {
    res.write(rewrittenTail);
  }
  res.end();
}

/**
 * Hop-by-hop headers (RFC 9110 §7.6.1). They describe THIS connection, not the
 * message, and a forwarding proxy must never copy one onto its own response.
 *
 * `transfer-encoding` is the one that bites. Node re-frames our response body
 * itself — the body is rewritten here, so it always goes out chunked with no
 * content-length — and copying the upstream's `transfer-encoding: chunked` on
 * top of that puts `chunked, chunked` on the wire. It accumulates one value per
 * proxy hop, and the client eventually refuses the response outright:
 * `UnsupportedTransferEncoding`.
 *
 * Whether it is even VISIBLE depends on the runtime, which is why this survived
 * review. Bun 1.3.14 strips `transfer-encoding` from `Response.headers`, so the
 * copy is a no-op and everything works; Bun 1.3.9 — the version CI pins — keeps
 * it, and the same code breaks. Do not read "it works on my machine" as
 * evidence here; the regression test below drives real sockets through two
 * chained proxies for exactly that reason.
 */
const HOP_BY_HOP_RESPONSE_HEADERS = [
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
];

function responseHeadersForProxy(upstream: Response): Headers {
  const headers = new Headers(upstream.headers);
  // The body is rewritten, so the upstream's framing and length never apply.
  headers.delete('content-length');
  headers.delete('content-encoding');
  for (const name of HOP_BY_HOP_RESPONSE_HEADERS) headers.delete(name);
  return headers;
}

/**
 * One log line per throttled/failed upstream response. The gateway advertises
 * no limits on success responses (verified 2026-08-07), so a live 429's
 * headers are the only evidence of WHICH limiter fired; x-request-id and
 * x-trace-id let the gateway owners answer that. Allow-listed fields only —
 * auth material must never reach a log. Absent fields are printed as `-`
 * rather than dropped: "the gateway sent no retry-after on the real 429" is
 * itself a finding.
 */
export function formatGatewayThrottleLog(status: number, headers: Headers): string | null {
  if (status !== 429 && status < 500) return null;
  const field = (name: string) => `${name}=${headers.get(name) ?? '-'}`;
  return [
    `upstream status=${status}`,
    field('retry-after'),
    field('x-request-id'),
    field('x-trace-id'),
    field('x-envoy-upstream-service-time'),
  ].join(' ');
}

function headersToObject(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {};
  headers.forEach((value, key) => {
    result[key] = value;
  });
  return result;
}

export function rewriteNonStreamChatResponse(body: unknown): unknown {
  if (!isRecord(body) || !Array.isArray(body.choices)) return body;
  const clone = structuredClone(body) as JsonRecord;
  const choices = clone.choices as unknown[];

  for (const choice of choices) {
    if (!isRecord(choice) || !isRecord(choice.message)) continue;
    const message = choice.message;
    if (typeof message.content !== 'string') continue;
    const { reasoning, answer } = extractReasoning(message.content);
    if (!reasoning) continue;
    const existingReasoning = typeof message.reasoning_content === 'string' ? message.reasoning_content : '';
    message.reasoning_content = existingReasoning ? `${existingReasoning}${reasoning}` : reasoning;
    message.content = answer;
  }

  return clone;
}

async function readRequestBody(req: http.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function upstreamUrlFor(req: http.IncomingMessage, upstreamBaseUrl: string): string {
  const upstream = new URL(upstreamBaseUrl);
  const requestUrl = new URL(req.url || '/', upstream.origin);
  return requestUrl.toString();
}

function upstreamHeaders(req: http.IncomingMessage, isGatewayUpstream: boolean): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    const lower = name.toLowerCase();
    if (lower === 'host' || lower === 'content-length') continue;
    headers.set(name, Array.isArray(value) ? value.join(', ') : value);
  }

  // Gateway-ONLY. The gateway authenticates with `Nestor-Token`; every other
  // upstream authenticates with the Bearer key it was given, and stripping it
  // here would 401 every BYO request.
  const authorization = headers.get('authorization');
  if (isGatewayUpstream && authorization?.toLowerCase().startsWith('bearer ')) {
    headers.set('Nestor-Token', authorization.slice('bearer '.length));
    headers.delete('authorization');
  }
  logUpstreamAuthScheme(headers);
  return headers;
}

/**
 * Name the auth SCHEME this request goes out with — never the credential.
 *
 * Added because its absence forced source-diagnosis: whether the Bearer
 * survived to a BYO upstream is a property of the request that actually left,
 * and reading this function's body is not that. The same shape as the
 * `register_tools` generation line D7 needed — observability whose absence
 * turns a measurable claim into an argument.
 *
 * SCHEME ONLY. `bearer` / `nestor-token` / `none` are the entire vocabulary; a
 * credential must never reach a log, and a line that printed a prefix of one
 * would still be a credential in a log.
 *
 * Off unless `NESSY_PROXY_AUTH_DEBUG=1`, so a normal run's stderr is unchanged.
 */
function logUpstreamAuthScheme(headers: Headers): void {
  if (process.env.NESSY_PROXY_AUTH_DEBUG !== '1') return;
  const scheme = headers.has('Nestor-Token')
    ? 'nestor-token'
    : headers.get('authorization')?.toLowerCase().startsWith('bearer ')
      ? 'bearer'
      : 'none';
  process.stderr.write(`[nestor-proxy] upstream auth: ${scheme}\n`);
}

async function proxyRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  upstreamBaseUrl: string,
  fetchImpl: typeof fetch,
  isGatewayUpstream: boolean,
  forceQwenDialect: boolean,
  idleTimeoutMs: number,
): Promise<void> {
  const rawBody = await readRequestBody(req);
  const headers = upstreamHeaders(req, isGatewayUpstream);
  let body: BodyInit | undefined = rawBody.length > 0 ? new Uint8Array(rawBody) : undefined;

  // Per-request, off the body the proxy already parses: the gateway keeps
  // splitting for every model it serves (today's behavior), and off-gateway
  // only the Qwen ids that actually leak `<think>` into their answer do.
  // The connection's own dialect hint outranks the id allowlist: the user set
  // it BECAUSE their endpoint serves Qwen under a name the allowlist cannot know.
  let splitReasoning = isGatewayUpstream || forceQwenDialect;

  if (rawBody.length > 0 && headers.get('content-type')?.includes('application/json')) {
    try {
      const parsed = JSON.parse(rawBody.toString('utf8'));
      if (isRecord(parsed) && isNestorGatewayQwenModel(parsed.model)) splitReasoning = true;
      body = JSON.stringify(sanitizeNestorChatRequest(parsed, forceQwenDialect));
      headers.set('content-type', 'application/json');
    } catch {
      body = new Uint8Array(rawBody);
    }
  }

  const upstream = await fetchImpl(upstreamUrlFor(req, upstreamBaseUrl), {
    method: req.method,
    headers,
    body,
  });

  const responseHeaders = responseHeadersForProxy(upstream);
  const throttleLine = formatGatewayThrottleLog(upstream.status, responseHeaders);
  if (throttleLine) process.stderr.write(`[nestor-proxy] ${throttleLine}\n`);
  res.writeHead(upstream.status, headersToObject(responseHeaders));

  const contentType = upstream.headers.get('content-type') || '';
  if (!upstream.body) {
    res.end();
    return;
  }

  if (contentType.includes('text/event-stream')) {
    if (splitReasoning) {
      await writeRewrittenChatCompletionSse(upstream, res, idleTimeoutMs);
    } else {
      await pipeResponseBody(upstream, res, idleTimeoutMs);
    }
    return;
  }

  if (contentType.includes('application/json')) {
    const text = await upstream.text();
    if (!splitReasoning) {
      res.end(text);
      return;
    }
    try {
      res.end(JSON.stringify(rewriteNonStreamChatResponse(JSON.parse(text))));
    } catch {
      res.end(text);
    }
    return;
  }

  res.end(Buffer.from(await upstream.arrayBuffer()));
}

export async function startNestorReasoningProxy(
  upstreamBaseUrl: string,
  fetchImpl: typeof fetch = fetch,
  forceQwenDialect = false,
  /**
   * P6.58 silence budget. Defaults to the process-wide
   * {@link resolveStreamIdleTimeoutMs} (300 000 ms, clamped to [10 000,
   * 1 800 000]); overridable so a test can drive the watchdog without waiting
   * out the production floor, which exists precisely so nobody sets a budget
   * under a thinking model's normal silence.
   */
  idleTimeoutMs: number = resolveStreamIdleTimeoutMs(),
): Promise<NestorReasoningProxyHandle> {
  const upstream = new URL(upstreamBaseUrl);
  const isGatewayUpstream = isNestorGatewayUrl(upstreamBaseUrl);
  const server = http.createServer((req, res) => {
    proxyRequest(req, res, upstreamBaseUrl, fetchImpl, isGatewayUpstream, forceQwenDialect, idleTimeoutMs).catch(error => {
      const message = error instanceof Error ? error.message : String(error);
      // F1.854 — a failure AFTER `proxyRequest` sent the upstream's status (a
      // body that errors mid-stream) cannot be answered with a 502 any more: a
      // second `writeHead` throws ERR_HTTP_HEADERS_SENT inside this handler, the
      // rejection escapes, and the Pi child's `unhandledRejection` handler exits
      // 1, losing the turn. Destroy the response instead, so the client's read
      // fails like any dropped upstream connection and the turn ends with an
      // ordinary error. Before the headers, the 502 below is unchanged.
      if (res.headersSent) {
        res.destroy(error instanceof Error ? error : new Error(message));
        return;
      }
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message } }));
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.listen(0, '127.0.0.1', resolve);
    server.on('error', reject);
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Nestor reasoning proxy failed to bind to 127.0.0.1');
  }

  return {
    upstreamBaseUrl,
    localBaseUrl: `http://127.0.0.1:${address.port}${upstream.pathname.replace(/\/+$/, '')}`,
    isGatewayUpstream,
    close: () => new Promise(resolve => server.close(() => resolve())),
  };
}
