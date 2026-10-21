/**
 * Local `/v1/responses` server.
 *
 * Phase 1 = **stub mode** only: it ignores the request body and streams a
 * canned Responses SSE sequence so we can prove the codex app-server tool loop
 * end-to-end without touching Nestor. Phase 2 replaces the streaming body with
 * the real Responses<->chat adapter (reasoning extraction, tool mapping, retry).
 *
 * The stub is deliberately stateful across a turn: the FIRST response emits an
 * assistant message plus one `shell` function call; SUBSEQUENT responses (codex
 * calling back with the tool output) emit only a final message + `completed`,
 * so the turn terminates instead of looping forever.
 *
 * ponytail: canned SSE, no model, no auth check. Upgrade path is the whole of
 * Phase 2 — do NOT grow this stub into the real adapter.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface StubAdapterHandle {
  port: number;
  close: () => Promise<void>;
}

export interface StubAdapterOptions {
  /** Model id echoed back in the canned response objects. */
  model?: string;
  /**
   * The tool codex should invoke. Default `exec_command` — codex's real PTY
   * shell tool (name `shell` with `{command:[]}` yields "unsupported call:
   * shell"; the executable tool is `exec_command` taking a `cmd` string).
   */
  toolName?: string;
  /**
   * The NAMESPACE the tool is registered under, emitted as a sibling field of
   * `name` on the `function_call` item — never concatenated into the name.
   *
   * P6.670. Five spellings were tried before this option existed (`spawn_agent`,
   * and the same name joined to `multi_agent_v1` by a dot, a double underscore,
   * a slash and a colon) and all five came back
   * `unsupported call: <the whole string>`. They were destined to, and the
   * reason is structural rather than a matter of finding the sixth delimiter.
   * Read from `github.com/openai/codex` at `rust-v0.148.0` — the tag shipped when
   * this was read, and for codex the SOURCE outranks the page:
   *
   * - `codex-rs/protocol/src/models.rs` — `enum ResponseItem` is
   *   `#[serde(tag = "type", rename_all = "snake_case")]`, and its `FunctionCall`
   *   variant declares `namespace: Option<String>` beside `name`, with
   *   `#[serde(default, skip_serializing_if = "Option::is_none")]`. So the field
   *   is optional on the wire and absent means "no namespace" — which is why
   *   this option is omitted rather than emitted empty when unset.
   * - `codex-rs/core/src/tools/router.rs` — `ToolRouter::build_tool_call` does
   *   `ToolName::new(namespace, name).with_default_namespace()`, reading the two
   *   fields and nothing else.
   * - `codex-rs/protocol/src/tool_name.rs` — `ToolName` is
   *   `{ name: String, namespace: Option<String> }` with **no string parser at
   *   all**: `impl From<&str>` calls `plain(name)`, which sets
   *   `namespace: None`, and `with_default_namespace()` then stamps
   *   `DEFAULT_FUNCTION_NAMESPACE = "functions"`. There is no `split` on any
   *   delimiter anywhere in the type.
   *
   * So every one of those five spellings became
   * `ToolName { name: "<the whole literal string>", namespace: Some("functions") }`
   * and missed the registry, which keys the agent tools on
   * `{ name: "spawn_agent", namespace: Some("multi_agent_v1") }`
   * (`core/src/tools/handlers/multi_agents_spec.rs`'s
   * `MULTI_AGENT_V1_NAMESPACE`). **There is no sixth spelling; there is a
   * sibling field.**
   *
   * The DECLARATION side is not this stub's to emit, and the row that produced
   * this option had it backwards. `LoadableToolSpec` in
   * `codex-rs/tools/src/responses_api.rs` — the `{"type":"namespace","name":…,
   * "tools":[…]}` container — derives `Serialize` and NOT `Deserialize`, so it
   * is what codex PUTS IN ITS REQUEST. This stub is the provider: it receives
   * that container (readable verbatim through {@link StubAdapterOptions.onRequestBody})
   * and only has to answer in the matching shape.
   */
  toolNamespace?: string;
  /** Arguments object for the canned function-call (default `{ cmd: 'echo hi' }`). */
  toolArguments?: Record<string, unknown>;
  /** Log each incoming request body to stderr (spike introspection). */
  logRequests?: boolean;
  /**
   * Hand each incoming request body to the caller, verbatim and in order.
   *
   * Added by T1a of
   * `docs/superpowers/plans/2026-08-20-cross-runtime-history-carry.md`: the
   * only way to prove `thread/inject_items` produces MODEL-VISIBLE history is
   * to read what the app-server actually puts on the wire, and stderr logging
   * is not something a test can assert on. Purely additive — the stub still
   * ignores the body for its own purposes.
   */
  onRequestBody?: (body: string) => void;
  /**
   * Whether the FIRST response carries a `function_call` (default `true`,
   * the spike's behaviour).
   *
   * A caller that only wants to inspect the outgoing request sets this
   * `false`: with no tool call the turn ends after one round trip and never
   * reaches codex's approval path, which has nobody to answer it in a
   * non-interactive test.
   */
  emitToolCall?: boolean;
}

/** One SSE frame: `event:` + `data:` + blank line. */
function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c as Buffer));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', () => resolve(''));
  });
}

/**
 * The canonical OpenAI Responses streaming sequence for a single turn.
 * `withToolCall` gates whether we append a `function_call` item (first turn) or
 * end after the assistant message (subsequent turns).
 */
function* cannedStream(opts: {
  responseId: string;
  model: string;
  text: string;
  withToolCall: boolean;
  toolName: string;
  toolNamespace?: string;
  toolArguments: Record<string, unknown>;
}): Generator<string> {
  const { responseId, model, text } = opts;
  const msgId = `msg_${responseId}`;
  const output: unknown[] = [];

  const baseResponse = (status: string) => ({
    id: responseId,
    object: 'response',
    status,
    model,
    output,
  });

  yield sse('response.created', { type: 'response.created', response: baseResponse('in_progress') });

  // Assistant message item.
  yield sse('response.output_item.added', {
    type: 'response.output_item.added',
    output_index: 0,
    item: { type: 'message', id: msgId, status: 'in_progress', role: 'assistant', content: [] },
  });
  yield sse('response.content_part.added', {
    type: 'response.content_part.added',
    item_id: msgId,
    output_index: 0,
    content_index: 0,
    part: { type: 'output_text', text: '', annotations: [] },
  });
  yield sse('response.output_text.delta', {
    type: 'response.output_text.delta',
    item_id: msgId,
    output_index: 0,
    content_index: 0,
    delta: text,
  });
  yield sse('response.output_text.done', {
    type: 'response.output_text.done',
    item_id: msgId,
    output_index: 0,
    content_index: 0,
    text,
  });
  yield sse('response.content_part.done', {
    type: 'response.content_part.done',
    item_id: msgId,
    output_index: 0,
    content_index: 0,
    part: { type: 'output_text', text, annotations: [] },
  });
  const messageItem = {
    type: 'message',
    id: msgId,
    status: 'completed',
    role: 'assistant',
    content: [{ type: 'output_text', text, annotations: [] }],
  };
  output.push(messageItem);
  yield sse('response.output_item.done', {
    type: 'response.output_item.done',
    output_index: 0,
    item: messageItem,
  });

  if (opts.withToolCall) {
    const fcId = `fc_${responseId}`;
    const callId = `call_${responseId}`;
    const args = JSON.stringify(opts.toolArguments);
    // Spread, so an unset namespace leaves the key ABSENT rather than `null` or
    // `''`. That mirrors the wire contract exactly: the Rust field carries
    // `skip_serializing_if = "Option::is_none"`, and `with_default_namespace`
    // treats `Some("")` the same as `None` — but an explicit `null` would not
    // deserialize into `Option<String>` the way an omitted key does.
    const namespaceField = opts.toolNamespace ? { namespace: opts.toolNamespace } : {};
    yield sse('response.output_item.added', {
      type: 'response.output_item.added',
      output_index: 1,
      item: { type: 'function_call', id: fcId, call_id: callId, name: opts.toolName, ...namespaceField, arguments: '', status: 'in_progress' },
    });
    yield sse('response.function_call_arguments.delta', {
      type: 'response.function_call_arguments.delta',
      item_id: fcId,
      output_index: 1,
      delta: args,
    });
    yield sse('response.function_call_arguments.done', {
      type: 'response.function_call_arguments.done',
      item_id: fcId,
      output_index: 1,
      arguments: args,
    });
    const fcItem = { type: 'function_call', id: fcId, call_id: callId, name: opts.toolName, ...namespaceField, arguments: args, status: 'completed' };
    output.push(fcItem);
    yield sse('response.output_item.done', {
      type: 'response.output_item.done',
      output_index: 1,
      item: fcItem,
    });
  }

  yield sse('response.completed', {
    type: 'response.completed',
    response: {
      ...baseResponse('completed'),
      usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
    },
  });
}

/** Start the stub adapter on an ephemeral 127.0.0.1 port. */
export function startStubAdapter(options: StubAdapterOptions = {}): Promise<StubAdapterHandle> {
  const model = options.model ?? 'tgpt/qwen35-397b-a17b-fp8';
  const toolName = options.toolName ?? 'exec_command';
  // No default: `exec_command` is a top-level tool, and codex stamps
  // `functions` on anything that arrives without one. A default here would put
  // a namespace on every canned call in every existing caller.
  const toolNamespace = options.toolNamespace;
  const toolArguments = options.toolArguments ?? { cmd: 'echo hi' };
  let callCount = 0;

  const server: Server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? '';
    if (req.method === 'POST' && url.replace(/\?.*$/, '').endsWith('/responses')) {
      const body = await readBody(req);
      if (options.logRequests) {
        process.stderr.write(`[stub-adapter] POST ${url} #${callCount + 1}\n${body}\n`);
      }
      options.onRequestBody?.(body);
      callCount += 1;
      const withToolCall = callCount === 1 && (options.emitToolCall ?? true);
      const responseId = `resp_${callCount}`;
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      for (const frame of cannedStream({
        responseId,
        model,
        text: withToolCall ? 'spike ok' : 'done',
        withToolCall,
        toolName,
        toolNamespace,
        toolArguments,
      })) {
        res.write(frame);
      }
      res.end();
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'stub adapter: only POST /v1/responses is supported' }));
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        port,
        close: () =>
          new Promise<void>((res) => {
            server.close(() => res());
          }),
      });
    });
  });
}
