import { randomUUID } from 'node:crypto';
import {
  NESTOR_CLOUD_A2A_URL,
  NESTOR_CLOUD_AGENT_CARD_URL,
} from '../internal/drivers/nestor-cloud.ts';
import { buildNestorCloudAuthHeaders, type NestorCloudAuthHeadersOptions } from './auth.ts';
import { debug } from '../../../utils/debug.ts';
import { readWithIdleTimeout, StreamIdleTimeoutError } from '../../../llm/stream-idle.ts';
import type {
  A2APart,
  A2AStreamEvent,
  NestorAgentCard,
  NestorCloudClientPhase,
} from './types.ts';
import {
  isTerminalNestorTaskState,
  NestorCloudClientError,
  NestorCloudTerminalTaskError,
  normalizeNestorWireTaskState,
} from './types.ts';
import {
  capNestorErrorMessage,
  NestorCloudRetryableTransportError,
  readNestorErrorBodyMessage,
  RETRY_MARKER_PART,
} from './retry.ts';

export interface NestorCloudClientOptions extends NestorCloudAuthHeadersOptions {
  agentCardUrl?: string;
  postUrl?: string;
  fetchImpl?: typeof fetch;
  onPhase?: (phase: NestorCloudClientPhase) => void;
  /**
   * P6.58 silence budget for the streaming turn. Defaults to the process-wide
   * {@link resolveStreamIdleTimeoutMs} (300 000 ms, clamped to
   * [10 000, 1 800 000]); overridable so a test can drive the watchdog without
   * waiting out the production floor, which exists precisely so nobody sets a
   * budget under a thinking model's normal silence.
   */
  idleTimeoutMs?: number;
}

export interface NestorSendMessageArgs {
  text: string;
  contextId?: string;
  taskId?: string;
  metadata?: Record<string, unknown>;
  signal?: AbortSignal;
}

/**
 * `taskId` is required — a tool result addresses the task that asked for it, and
 * the handler rejects a continuation that cannot name one. `contextId` is
 * optional but must MATCH when present (a mismatched pair is `-32602`), so the
 * caller omits it rather than inventing one.
 *
 * `metadata` rides only the FIRST send of a user turn — which a parked terminal
 * tool's answer is (`CONNECTOR/src/core/turn.ts:70,192`: metadata is set from the
 * turn's args and cleared before every mid-turn continuation). Without it that
 * turn would advertise no MCP tools and no skills.
 */
export interface NestorSendToolResultsArgs {
  contextId?: string;
  taskId: string;
  results: Array<{ toolCallId: string; content?: string; error?: string }>;
  metadata?: Record<string, unknown>;
  signal?: AbortSignal;
}

export const DEFAULT_NESTOR_CLOUD_AGENT_CARD_URL = NESTOR_CLOUD_AGENT_CARD_URL;
export const DEFAULT_NESTOR_CLOUD_A2A_URL = NESTOR_CLOUD_A2A_URL;

/**
 * A2A 1.0 JSON-RPC method names — `internal/jsonrpc/jsonrpc.go:35,38`. The 0.3
 * spellings (`message/stream`, `tasks/cancel`) are not routed by the v2 handler.
 */
export const A2A_SEND_STREAMING_MESSAGE_METHOD = 'SendStreamingMessage';
export const A2A_CANCEL_TASK_METHOD = 'CancelTask';

/**
 * `a2a/core.go:156-158`. A bare `"user"` passes validation and silently
 * degrades to the agent role, so this constant is the whole guard.
 */
export const A2A_WIRE_ROLE_USER = 'ROLE_USER';

/** The protocol version this client speaks — `a2a/core.go:31`. */
export const A2A_CLIENT_PROTOCOL_VERSION = '1.0';

/** The transport binding we negotiate — `a2a/agent.go:191`. */
const A2A_JSONRPC_BINDING = 'JSONRPC';

export class NestorCloudClient {
  private readonly agentCardUrl: string;
  private readonly postUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly onPhase?: (phase: NestorCloudClientPhase) => void;
  private readonly authOptions: NestorCloudAuthHeadersOptions;
  private readonly idleTimeoutMs: number | undefined;

  constructor(options: NestorCloudClientOptions = {}) {
    this.agentCardUrl = options.agentCardUrl ?? DEFAULT_NESTOR_CLOUD_AGENT_CARD_URL;
    this.postUrl = options.postUrl ?? DEFAULT_NESTOR_CLOUD_A2A_URL;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.onPhase = options.onPhase;
    this.idleTimeoutMs = options.idleTimeoutMs;
    this.authOptions = {
      credsPath: options.credsPath,
      deviceId: options.deviceId,
      userAgent: options.userAgent,
    };
  }

  async loadAgentCard(signal?: AbortSignal): Promise<NestorAgentCard> {
    this.emit({ phase: 'checking-credentials' });
    const auth = buildNestorCloudAuthHeaders(this.authOptions);
    this.emit({ phase: 'fetching-agent-card' });

    let res: Response;
    try {
      res = await this.fetchImpl(this.agentCardUrl, {
        method: 'GET',
        headers: auth.headers,
        signal,
      });
    } catch (err) {
      throw this.toError('agent-card-fetch-failed', err, auth.token);
    }

    if (res.status === 401 || res.status === 403) {
      throw new NestorCloudClientError('auth-failed', `Nestor auth failed: ${res.status}`, res.status);
    }
    if (!res.ok) {
      throw new NestorCloudClientError(
        'agent-card-fetch-failed',
        `Nestor agent card fetch failed: ${res.status}`,
        res.status,
      );
    }

    const card = await res.json().catch((err) => {
      throw this.toError('agent-card-invalid', err, auth.token);
    }) as NestorAgentCard;
    validateNestorAgentCard(card, { postUrl: this.postUrl });
    return card;
  }

  async *sendMessageStream(args: NestorSendMessageArgs): AsyncGenerator<A2AStreamEvent> {
    yield* this.openStream({
      phase: 'opening-a2a-stream',
      parts: [{ text: args.text }],
      contextId: args.contextId,
      taskId: args.taskId,
      metadata: args.metadata,
      signal: args.signal,
    });
  }

  async *sendToolResultsStream(args: NestorSendToolResultsArgs): AsyncGenerator<A2AStreamEvent> {
    yield* this.openStream({
      phase: 'sending-tool-results',
      parts: args.results.map(buildToolResultPart),
      contextId: args.contextId,
      taskId: args.taskId,
      metadata: args.metadata,
      signal: args.signal,
    });
  }

  /**
   * Re-run the conversation's last request after a retryable in-band error, by
   * sending the extension's own retry request part (`retryable_error_schema.json`
   * → `retrySchema`).
   *
   * There is deliberately NO `taskId` parameter: the task that carried the error
   * is frozen at `INPUT_REQUIRED` and addressing it again is what produced the
   * error in the first place — the retry belongs to the CONTEXT, and the backend
   * opens a fresh task in it (the connector's regenerate path passes contextId
   * and metadata only, `nessy-acp-agent/src/commands/regenerate-agent-turn.command.ts:65-78`).
   * `metadata` rides along because this send is the first of its task, and the
   * turn's MCP tools and skills live there.
   */
  async *sendRetryMarkerStream(args: {
    contextId?: string;
    metadata?: Record<string, unknown>;
    signal?: AbortSignal;
  }): AsyncGenerator<A2AStreamEvent> {
    yield* this.openStream({
      phase: 'opening-a2a-stream',
      parts: [RETRY_MARKER_PART],
      contextId: args.contextId,
      metadata: args.metadata,
      signal: args.signal,
    });
  }

  async cancelTask(taskId: string, signal?: AbortSignal): Promise<void> {
    this.emit({ phase: 'checking-credentials' });
    const auth = buildNestorCloudAuthHeaders(this.authOptions);
    this.emit({ phase: 'canceling-task', taskId });

    let res: Response;
    try {
      res = await this.fetchImpl(this.postUrl, {
        method: 'POST',
        headers: {
          ...auth.headers,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: randomUUID(),
          method: A2A_CANCEL_TASK_METHOD,
          params: { id: taskId },
        }),
        signal,
      });
    } catch (err) {
      throw this.toError('cancel-failed', err, auth.token);
    }

    if (res.status === 401 || res.status === 403) {
      throw new NestorCloudClientError('auth-failed', `Nestor auth failed: ${res.status}`, res.status);
    }
    if (!res.ok) {
      throw new NestorCloudClientError('cancel-failed', `Nestor cancel failed: ${res.status}`, res.status);
    }
  }

  private async *openStream(args: {
    phase: NestorCloudClientPhase['phase'];
    parts: A2APart[];
    contextId?: string;
    taskId?: string;
    metadata?: Record<string, unknown>;
    signal?: AbortSignal;
  }): AsyncGenerator<A2AStreamEvent> {
    this.emit({ phase: 'checking-credentials' });
    const auth = buildNestorCloudAuthHeaders(this.authOptions);
    this.emit({ phase: args.phase });

    let res: Response;
    try {
      res = await this.fetchImpl(this.postUrl, {
        method: 'POST',
        headers: {
          ...auth.headers,
          'content-type': 'application/json',
          accept: 'text/event-stream',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: randomUUID(),
          method: A2A_SEND_STREAMING_MESSAGE_METHOD,
          params: {
            message: {
              messageId: randomUUID(),
              role: A2A_WIRE_ROLE_USER,
              parts: args.parts,
              ...(args.contextId ? { contextId: args.contextId } : {}),
              ...(args.taskId ? { taskId: args.taskId } : {}),
              ...(args.metadata ? { metadata: args.metadata } : {}),
            },
          },
        }),
        signal: args.signal,
      });
    } catch (err) {
      throw this.toError('stream-failed', err, auth.token);
    }

    if (res.status === 401 || res.status === 403) {
      throw new NestorCloudClientError('auth-failed', `Nestor auth failed: ${res.status}`, res.status);
    }
    // Both retryable transport shapes are decided HERE, before a single frame is
    // read — which is what makes a verbatim resend of the caller's own arguments
    // correct. The user-limit middleware runs ahead of the A2A handler
    // (`userlimit_middleware.go:54-71`), so a 429 means the turn never started.
    if (res.status === 429) {
      throw new NestorCloudRetryableTransportError(429, await this.readRateLimitMessage(res, auth.token), true);
    }
    if (res.status >= 500) {
      throw new NestorCloudRetryableTransportError(res.status, `Nestor stream failed: ${res.status}`, false);
    }
    if (!res.ok) {
      throw new NestorCloudClientError('stream-failed', `Nestor stream failed: ${res.status}`, res.status);
    }

    try {
      yield* readSseJsonRpcResults(res, this.idleTimeoutMs);
    } catch (err) {
      // A terminal-task rejection is RECOVERABLE — `turn.ts` drops the stale
      // `taskId` and resends. Re-wrapping it as `stream-failed` would brick
      // exactly the session this detection exists to save. Its `detail` still
      // gets the redaction every other surfaced string gets, because the
      // non-recovering paths throw that text at the user.
      if (err instanceof NestorCloudTerminalTaskError) {
        throw err.detail
          ? new NestorCloudTerminalTaskError(err.taskState, redactNestorSecrets(err.detail, auth.token))
          : err;
      }
      throw this.toError('stream-failed', err, auth.token);
    }
  }

  private emit(phase: NestorCloudClientPhase): void {
    this.onPhase?.(phase);
  }

  /**
   * The 429 body is the ONLY place the backend says which limit was hit — the
   * daily token budget, the shared pool, or the generic per-identity limiter —
   * and the user is going to be shown it verbatim, so it is unwrapped from the
   * echo envelope, redacted, and bounded.
   */
  private async readRateLimitMessage(res: Response, token?: string): Promise<string> {
    const raw = await res.text().catch(() => '');
    const message = readNestorErrorBodyMessage(raw);
    if (!message) return `Nestor rate limit: ${res.status}`;
    return capNestorErrorMessage(redactNestorSecrets(message, token));
  }

  private toError(
    code: ConstructorParameters<typeof NestorCloudClientError>[0],
    err: unknown,
    token?: string,
  ): NestorCloudClientError {
    if (err instanceof NestorCloudClientError) return err;
    const raw = err instanceof Error ? err.message : String(err);
    return new NestorCloudClientError(code, redactNestorSecrets(raw, token));
  }
}

/**
 * Validates a v2 (A2A 1.0) agent card. The 0.3 top-level `url`,
 * `preferredTransport` and `protocolVersion` do NOT exist on this card
 * (`a2a/agent.go:46-89`): the endpoint, its binding and its protocol version
 * are declared per interface in `supportedInterfaces` (`a2a/agent.go:124-136`,
 * produced at `usecase_nessy.go:181-188`).
 */
export function validateNestorAgentCard(
  card: NestorAgentCard,
  options: { postUrl: string },
): void {
  if (card.capabilities?.streaming !== true) {
    throw new NestorCloudClientError('agent-card-invalid', 'Nestor agent card does not advertise streaming');
  }

  const interfaces = card.supportedInterfaces;
  if (!Array.isArray(interfaces) || interfaces.length === 0) {
    throw new NestorCloudClientError(
      'agent-card-invalid',
      'Nestor agent card is missing supportedInterfaces',
    );
  }

  const postUrl = normalizeUrl(options.postUrl);
  const matchesEndpoint = (iface: (typeof interfaces)[number]) =>
    normalizeUrl(iface.url) === postUrl && isJsonRpcTransport(iface.protocolBinding ?? iface.transport);
  // Prefer an interface we can actually speak; fall back to any endpoint match
  // only to produce the version-specific error. Order-insensitive on purpose —
  // a rollout card listing a 0.3 entry before the 1.0 one must not hard-fail.
  const selected = interfaces.find((iface) => matchesEndpoint(iface) && isSupportedProtocolVersion(iface.protocolVersion))
    ?? interfaces.find(matchesEndpoint);
  if (!selected) {
    throw new NestorCloudClientError('agent-card-invalid', 'Nestor agent card does not match selected A2A endpoint');
  }

  if (!isSupportedProtocolVersion(selected.protocolVersion)) {
    throw new NestorCloudClientError(
      'agent-card-invalid',
      `Nestor agent card advertises A2A protocol ${selected.protocolVersion ?? 'none'} at the selected endpoint; `
      + `this client speaks ${A2A_CLIENT_PROTOCOL_VERSION}`,
    );
  }
}

/**
 * The flattened v2 data part — discriminated by key presence, never by `kind`
 * (`a2a/core.go:679-704`). `content` is `validate:"required"` on the backend's
 * tool-result item, so it is always emitted, empty string included.
 */
export function buildToolResultPart(input: {
  toolCallId: string;
  content?: string;
  error?: string;
}): A2APart {
  return {
    data: {
      tool_call_id: input.toolCallId,
      content: input.content ?? '',
      ...(input.error ? { error: input.error } : {}),
    },
  };
}

/** The `error` member of a JSON-RPC response frame — `internal/jsonrpc/jsonrpc.go:122-131`. */
export interface NestorJsonRpcErrorFrame {
  code?: number;
  message?: string;
  data?: unknown;
}

/**
 * The state name the backend hides in prose: `a2asrv/agentexec.go:201-203`
 * formats `task in a terminal state %q` and `ToJSONRPCError` puts the whole
 * wrapped string into `data.error` — there is no structured field to read.
 */
const WIRE_TASK_STATE_TOKEN = /TASK_STATE_[A-Z_]+/;

/**
 * The second, STATELESS shape: the task store's own guard
 * (`pkg/agentcore/repo/a2ar/a2a_repo_task_store.go:106-107`) wraps
 * `ErrUnsupportedOperation` with `"task is already in terminal state"` and no
 * `TASK_STATE_` token at all.
 */
const TERMINAL_STATE_PHRASE = /terminal state/i;

/** JSON-RPC "task not found" — `a2asrv/handler.go:336`. */
const A2A_TASK_NOT_FOUND_CODE = -32001;

/**
 * Classifies a JSON-RPC error frame.
 *
 * Detection is deliberately CODE-AGNOSTIC — it scans the server `message` plus
 * the serialized `data` — because the same rejection reaches us under two codes
 * with two wordings (`-32602 "invalid params"` carrying the state, `-32004`
 * carrying none), and the code alone identifies neither: `-32602` is also every
 * params-validation failure (`a2asrv/handler.go:349-360`).
 *
 * `-32001` ("task not found", also raised by v2's `SubscribeToTask` —
 * `a2asrv/handler.go:336`) is a different CONDITION with the same CURE: the task
 * this send addressed is unusable, and the send has to go out again without it.
 * It is therefore mapped onto the same recovery, with an `unknown` state — the
 * backend never had a state to report. It is deliberately NOT on the backoff set
 * the connector puts it on (`nessy-acp-agent/src/adapter/a2a/a2a-errors.ts:86-87`
 * retries it like a rate limit): a task the backend has lost does not come back
 * by asking for it again on a timer, so waiting would only delay the resend that
 * actually works.
 *
 * Everything that is not a terminal-task rejection keeps the server's own
 * `message` and `data.error` text; the caller runs it through
 * {@link redactNestorSecrets} on the way out.
 */
export function toNestorStreamError(error: NestorJsonRpcErrorFrame): Error {
  const serializedData = safeStringify(error.data);
  // Carried on every terminal-task error, not just the ones that recover: the
  // recovery is shared but the CONDITIONS are not, so a path that rethrows needs
  // the backend's own sentence instead of "already terminal".
  const detail = readJsonRpcErrorDetail(error.data, serializedData);

  if (error.code === A2A_TASK_NOT_FOUND_CODE) {
    return new NestorCloudTerminalTaskError('unknown', detail || error.message);
  }

  const haystack = `${error.message ?? ''} ${serializedData}`;

  const token = haystack.match(WIRE_TASK_STATE_TOKEN)?.[0];
  if (token) {
    // A named state is authoritative: a non-terminal one means this is some
    // other rejection that merely mentions a state.
    const state = normalizeNestorWireTaskState(token);
    if (isTerminalNestorTaskState(state)) return new NestorCloudTerminalTaskError(state, detail || error.message);
  } else if (TERMINAL_STATE_PHRASE.test(haystack)) {
    // The state is genuinely unknown here — the backend never wrote it down.
    return new NestorCloudTerminalTaskError('unknown', detail || error.message);
  }

  const parts = [`A2A JSON-RPC error ${error.code ?? 'unknown'}`, error.message, detail]
    .filter((part): part is string => !!part);
  return new Error(parts.join(': '));
}

/** `data` is `map[string]any{"error": err.Error()}` in practice; anything else is serialized whole. */
function readJsonRpcErrorDetail(data: unknown, serializedData: string): string {
  if (typeof data === 'string') return data;
  if (data && typeof data === 'object') {
    const error = (data as Record<string, unknown>).error;
    if (typeof error === 'string') return error;
  }
  return serializedData;
}

function safeStringify(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return '';
  }
}

async function* readSseJsonRpcResults(
  res: Response,
  idleTimeoutMs?: number,
): AsyncGenerator<A2AStreamEvent> {
  if (!res.body) {
    throw new Error('Nestor stream response has no body');
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  // P6.58 — a remote agent that stops speaking without closing the socket used
  // to hang the turn forever: `reader.read()` simply never settles, and the
  // loop below has no other exit. This relay is the end of the line — nothing
  // downstream of it owns a watchdog the way the Claude SDK owns one for its
  // own path — so the abort has to happen here. `StreamIdleTimeoutError` is
  // re-shaped into this file's own typed channel so the user is told which
  // subsystem gave up and after how long, exactly as every other stream
  // failure here is (see {@link consumeSseFrames}'s note).
  try {
    for await (const value of readWithIdleTimeout(
      reader,
      idleTimeoutMs === undefined ? {} : { idleTimeoutMs },
    )) {
      buffer += decoder.decode(value, { stream: true });
      yield* consumeSseFrames(buffer, (remaining) => {
        buffer = remaining;
      });
    }
  } catch (error) {
    if (!(error instanceof StreamIdleTimeoutError)) throw error;
    throw new NestorCloudClientError(
      'stream-failed',
      `Nestor stream stalled: no data for ${error.idleMs}ms after `
      + `${error.bytesReceived} bytes; the turn was abandoned`,
    );
  }

  buffer += decoder.decode();
  // `atEof`: the `\n\n` on this call is OURS, not the server's, so anything left
  // in the buffer is a frame the stream was cut in the middle of — see
  // {@link consumeSseFrames}.
  yield* consumeSseFrames(`${buffer}\n\n`, () => {
    buffer = '';
  }, { atEof: true });
}

/**
 * P2.204 — A FRAME THIS CANNOT READ IS NAMED, AND WHETHER IT COSTS THE TURN
 * DEPENDS ON WHO TERMINATED IT.
 *
 * `JSON.parse` used to run bare here, and the same condition — a cut socket —
 * produced two different turns: cut on a frame boundary and the stream simply
 * ends, so `NestorCloudTurn.consumeStream` flushes the adapter and the user
 * keeps the partial answer; cut mid-frame and the raw `SyntaxError` ("JSON Parse
 * error: Unexpected EOF") became the turn's error, naming no subsystem and
 * quoting the payload's first token on the way out.
 *
 *  - `atEof` — the `\n\n` was appended by {@link readSseJsonRpcResults}, so the
 *    residue is a TRUNCATED TAIL rather than a frame the server finished. It
 *    costs the residue, is named on the debug channel, and the turn ends exactly
 *    as a boundary cut does.
 *  - mid-stream — the server terminated this frame itself, so an unreadable one
 *    is a protocol failure and the stream is no longer trustworthy: it escapes,
 *    NAMED on the typed channel every other stream failure in this file uses,
 *    and everything yielded before it has already reached the caller.
 *
 * The message carries the frame's SIZE and not its bytes: `toError` passes a
 * `NestorCloudClientError` through unredacted, and a frame is model output.
 * Frames with no `data:` line (SSE comments, keep-alives) and `[DONE]` were
 * always skipped silently and still are.
 */
function* consumeSseFrames(
  buffer: string,
  setRemaining: (remaining: string) => void,
  options: { atEof?: boolean } = {},
): Generator<A2AStreamEvent> {
  let start = 0;
  for (;;) {
    const idx = buffer.indexOf('\n\n', start);
    if (idx === -1) {
      setRemaining(buffer.slice(start));
      return;
    }

    const frame = buffer.slice(start, idx);
    start = idx + 2;
    const data = frame
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n')
      .trim();
    if (!data || data === '[DONE]') continue;

    let parsed: { error?: NestorJsonRpcErrorFrame; result?: A2AStreamEvent };
    try {
      parsed = JSON.parse(data) as { error?: NestorJsonRpcErrorFrame; result?: A2AStreamEvent };
    } catch {
      if (options.atEof) {
        debug(`[NestorCloud] SSE stream ended mid-frame; discarded a truncated ${data.length}-byte tail`);
        continue;
      }
      throw new NestorCloudClientError(
        'stream-failed',
        `Nestor stream frame is not JSON-RPC (${data.length} bytes)`,
      );
    }
    if (parsed.error) {
      throw toNestorStreamError(parsed.error);
    }
    if (parsed.result) yield parsed.result;
  }
}

function normalizeUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return value.replace(/\/$/, '');
}

function isJsonRpcTransport(value: string | undefined): boolean {
  if (!value) return false;
  return value.replace(/[-_\s]/g, '').toLowerCase() === A2A_JSONRPC_BINDING.toLowerCase();
}

/** `1.0` exactly, or any `1.0.x` patch spelling. */
function isSupportedProtocolVersion(value: string | undefined): boolean {
  if (!value) return false;
  const trimmed = value.trim();
  return trimmed === A2A_CLIENT_PROTOCOL_VERSION
    || trimmed.startsWith(`${A2A_CLIENT_PROTOCOL_VERSION}.`);
}

export function redactNestorSecrets(message: string, token?: string): string {
  let redacted = message;
  if (token) {
    redacted = redacted.split(token).join('[redacted]');
  }
  redacted = redacted.replace(/Nestor-Token\s*[:=]\s*[^,\s}]+/gi, 'Nestor-Token: [redacted]');
  redacted = redacted.replace(/"Nestor-Token"\s*:\s*"[^"]+"/gi, '"Nestor-Token":"[redacted]"');
  redacted = redacted.replace(/\{[\s\S]*\}/g, '[redacted-payload]');
  return redacted;
}
