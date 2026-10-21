/**
 * Minimal JSON-RPC 2.0 client over the codex app-server's newline-delimited
 * stdio transport. Mirrors the Pi transport shape (`pi-agent.ts` spawn/send/
 * handleLine) but speaks real JSON-RPC: request/response correlation by `id`,
 * notification dispatch by `method`, and server->client request handling (for
 * approvals).
 *
 * Wire note (00-context): the codex app-server omits the `"jsonrpc"` field on
 * the wire, so we neither send nor require it.
 */
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface, type Interface } from 'node:readline';
import { CODEX_CONFIG_WARNING_METHOD, describeCodexConfigWarning } from './config-warning.ts';
import { CODEX_WARNING_METHOD, describeCodexServerWarning } from './server-warning.ts';

type Json = Record<string, unknown>;

export interface ServerRequestContext {
  method: string;
  params: unknown;
}

export interface AppServerClientHandlers {
  /** Server->client notification (no id). */
  onNotification?: (method: string, params: unknown) => void;
  /**
   * Server->client request (has id). Return the `result` value; the client
   * frames the JSON-RPC response. Throw to send a JSON-RPC error.
   */
  onServerRequest?: (ctx: ServerRequestContext) => Promise<unknown> | unknown;
  /** Transport-level or parse diagnostics. */
  onDiagnostic?: (message: string) => void;
  /**
   * P6.459 arm (2) — the W3C `traceparent` of the host span this request is
   * part of, or `undefined` when the host has none open.
   *
   * A RESOLVER rather than a value, because the answer changes per turn: the
   * host's span opens and closes around a turn while this client lives for the
   * whole session. See {@link AppServerClient.request} for what is sent and,
   * more importantly, for what is NOT.
   */
  resolveTraceparent?: () => string | undefined;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
}

export class AppServerClient {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly readline: Interface;
  private closed = false;

  constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly handlers: AppServerClientHandlers = {},
  ) {
    this.readline = createInterface({ input: child.stdout });
    this.readline.on('line', (line) => this.handleLine(line));
    child.stderr.on('data', (chunk: Buffer) => {
      this.handlers.onDiagnostic?.(`[app-server stderr] ${chunk.toString('utf8').trimEnd()}`);
    });
    // P6.269 — the missing half of the two this class needs. `timeoutMs` above
    // covers a server that IGNORES a method; nothing covered a server that
    // DIES. When the child exits, stdout merely ends: readline closes, no line
    // arrives, and every pending entry stays pending forever. So killing the
    // app-server between a user message and its answer left the turn waiting
    // with no status, no error and no `complete` — the same shape P2.138
    // measured for the probe, reached by the other route.
    //
    // `exit` and not `close`: `exit` fires when the process itself is gone,
    // which is the fact a pending request needs, while `close` additionally
    // waits for every stdio stream to end and can lag or, with an inherited
    // descriptor, never arrive.
    child.on('exit', (code, signal) => this.failPendingOnExit(code, signal));
  }

  /**
   * End every in-flight request because the app-server is gone.
   *
   * NAMES THE EXIT CODE, because that is the one fact a user can act on: a
   * non-zero code is the binary refusing something, `SIGKILL` is usually the
   * machine reclaiming memory, and "the session stopped answering" is neither.
   *
   * Sets {@link closed}, so a later `write` reports "stdin not writable"
   * through the diagnostic channel instead of throwing on a dead pipe — and so
   * a subsequent `close()` is a no-op rather than a second round of rejections.
   *
   * A normally-completing turn is untouched by construction: its response
   * arrives first, its pending entry is deleted on arrival, and a normal
   * teardown runs `close()` before the child exits — either way this finds an
   * empty map and rejects nothing.
   */
  private failPendingOnExit(code: number | null, signal: NodeJS.Signals | null): void {
    const cause = code !== null
      ? `exit code ${code}`
      : signal !== null ? `signal ${signal}` : 'an unknown cause';
    this.closed = true;
    this.readline.close();
    if (this.pending.size === 0) return;
    const message = `app-server exited with ${cause} before answering`;
    this.handlers.onDiagnostic?.(message);
    for (const [, pending] of this.pending) {
      pending.reject(new Error(message));
    }
    this.pending.clear();
  }

  /**
   * Send a request and resolve with its `result` (or reject on error).
   *
   * ## `timeoutMs` — P2.138, and why it is OPT-IN
   *
   * Without it a request settles on exactly two events: a matching response, or
   * {@link close}. An app-server that IGNORES a method rather than erroring on
   * it therefore leaves the promise pending FOREVER — and the caller most
   * exposed to that is the one probing an OPTIONAL method on the spawn critical
   * path (`configRequirements/read`, between `initialized` and `thread/start`).
   * Its own contract is "a runtime that cannot answer this optional question
   * must still start", and a hang breaks that contract in the worse of the two
   * directions: a throw degrades, a hang does not.
   *
   * MEASURED on the pre-fix path, and the reason `close()` is no rescue: the
   * `AppServerClient` built inside `CodexAgent.createRuntime` is not assigned to
   * `this.client` until AFTER the probe (`codex-agent.ts:906`, probe at `:842`),
   * and `teardownRuntime` — the only route to `close()` — reads `this.client`
   * (`:3059`). So stop could not end it, `destroy()` could not end it, and even
   * killing the child would not: nothing rejects a pending entry when stdout
   * merely ends. The `runtimeSetup` promise every later turn awaits stays
   * pending, and the user sees their own message and then nothing — no status,
   * no error, no `complete`.
   *
   * OPT-IN rather than a default, deliberately. This request family carries
   * genuinely long operations (`plugin/install`, `thread/compact/start`,
   * `turn/start`), and a blanket ceiling would turn a slow success into a
   * manufactured failure. So the caller that knows its own bound passes one;
   * everything else keeps the behaviour it had, byte for byte.
   *
   * The timer is CLEARED on either settlement and the pending entry is DELETED
   * on expiry, so a timed-out request leaks neither a handle nor a map entry, and
   * a late response is then reported as `response for unknown id` rather than
   * resolving a promise the caller has stopped waiting on.
   */
  request(method: string, params?: unknown, options?: { timeoutMs?: number }): Promise<unknown> {
    const id = this.nextId++;
    const payload: Json = { id, method };
    if (params !== undefined) payload.params = params;
    const traceparent = this.resolveTraceparent();
    if (traceparent) payload.trace = { traceparent };
    return new Promise((resolve, reject) => {
      const timeoutMs = options?.timeoutMs;
      let timer: ReturnType<typeof setTimeout> | undefined;
      this.pending.set(id, {
        resolve: (value) => { if (timer !== undefined) clearTimeout(timer); resolve(value); },
        reject: (err) => { if (timer !== undefined) clearTimeout(timer); reject(err); },
      });
      if (timeoutMs !== undefined && timeoutMs > 0) {
        timer = setTimeout(() => {
          this.pending.delete(id);
          // Deliberately NO `code`. A caller that probes an optional method
          // separates a DEFINITIVE refusal from a transient failure on that
          // field, and a request that never came back is transient by
          // definition — the server may well know the method and be wedged.
          // Measured on the shipped binary (`codex-app-server` 0.148.0,
          // 2026-08-27): an unknown method is refused in ~1 ms, and a real
          // `configRequirements/read` answers in 1-5 ms, so nothing that
          // reaches this timer is a refusal this client could have read.
          reject(new Error(`app-server request ${method} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }
      this.write(payload);
    });
  }

  /**
   * P6.459 arm (2) — the request-level trace carrier, and the reason it is
   * ABSENT far more often than present.
   *
   * ## What the field is, read from the source rather than a page
   *
   * `codex-rs/protocol/src/protocol.rs` `struct W3cTraceContext` at
   * `rust-v0.150.1`:
   * `pub struct W3cTraceContext { traceparent: Option<String>, tracestate:
   * Option<String> }`, both `#[serde(default, skip_serializing_if =
   * "Option::is_none")]` — so a `trace` object carrying only `traceparent`
   * deserializes, and `tracestate` is not owed. `JSONRPCRequest` carries it as
   * `pub trace: Option<W3cTraceContext>` and the app-server CONSUMES it:
   * `app-server/src/app_server_tracing.rs:45-52` lifts `request.trace`, and
   * `attach_parent_context` (`:129-140`) makes it the parent of the span the
   * app-server opens for the request — so a host turn span and codex's own
   * spans land in ONE trace instead of two.
   *
   * ## Why the request field and not the env var
   *
   * The same function has an env fallback — `traceparent_context_from_env()`
   * (`otel/src/trace_context.rs:122-127`) — and it is a `OnceLock` initialized
   * once per PROCESS (`:22`). Our app-server child outlives every turn in the
   * session, so a `TRACEPARENT` in its environment would parent every turn of
   * that session to whichever span happened to be open at spawn. The per-request
   * field is the only one that can be per-turn, which is what the row needs.
   *
   * ## The absence is the control
   *
   * Nothing is minted here. With tracing off `createHostTracer` returns
   * `undefined`, no span opens, `currentTraceparent` answers `undefined` and the
   * `trace` key is ABSENT from the payload — because a `traceparent` naming a
   * trace nothing will export makes a backend show a request whose parent never
   * arrives. codex reads it the same way: `app_server_tracing.rs:46` discards a
   * `trace` object whose `traceparent` is missing.
   *
   * A resolver that THROWS must not kill a turn: telemetry is best-effort
   * everywhere else in this tree, and a request that fails to send because a
   * span lookup raised would be a far worse bug than a missing parent.
   */
  private resolveTraceparent(): string | undefined {
    try {
      return this.handlers.resolveTraceparent?.() || undefined;
    } catch {
      return undefined;
    }
  }

  /** Send a fire-and-forget notification (no id). */
  notify(method: string, params?: unknown): void {
    const payload: Json = { method };
    if (params !== undefined) payload.params = params;
    this.write(payload);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.readline.close();
    for (const [, pending] of this.pending) {
      pending.reject(new Error('app-server client closed'));
    }
    this.pending.clear();
  }

  private write(payload: Json): void {
    if (this.closed || !this.child.stdin.writable) {
      this.handlers.onDiagnostic?.('cannot write: stdin not writable');
      return;
    }
    this.child.stdin.write(JSON.stringify(payload) + '\n');
  }

  private handleLine(line: string): void {
    if (!line.trim()) return;
    let msg: Json;
    try {
      msg = JSON.parse(line) as Json;
    } catch {
      this.handlers.onDiagnostic?.(`invalid JSON line: ${line.slice(0, 200)}`);
      return;
    }

    const hasId = msg.id !== undefined && msg.id !== null;
    const method = typeof msg.method === 'string' ? msg.method : undefined;

    // Response to one of our requests: has id, no method.
    if (hasId && method === undefined) {
      const id = Number(msg.id);
      const pending = this.pending.get(id);
      if (!pending) {
        this.handlers.onDiagnostic?.(`response for unknown id ${String(msg.id)}`);
        return;
      }
      this.pending.delete(id);
      if ('error' in msg && msg.error) {
        const err = msg.error as { message?: string; code?: number };
        // The message is unchanged; the CODE is additionally preserved on the
        // Error so a caller can tell a definitive refusal from a transient
        // failure. Nothing read the code before, so a rejection reads exactly as
        // it always did — but "the method does not exist" and "the thread was
        // busy" are opposite decisions for a caller that probes an optional
        // method, and the code is the only non-textual way to separate them.
        //
        // P2.138 MEASURED which code this actually is, because the set named
        // here was assumed rather than observed: on the shipped binary
        // (`codex-app-server` 0.148.0, 2026-08-27) an unknown method comes back
        // as `-32600` "Invalid request: unknown variant `<method>`", NOT as
        // `-32601`/`-32602`. The classifier lives in the caller
        // (`codex-config-requirements.ts`) and now reads all three; this client
        // stays a transport and judges nothing (this app-server has no
        // "Method not found" string at all: an unrecognised method fails as a
        // serde `unknown variant` on the `ClientRequest` enum).
        const failure = new Error(err.message ?? `JSON-RPC error ${err.code ?? ''}`.trim()) as Error & { code?: number };
        if (typeof err.code === 'number') failure.code = err.code;
        pending.reject(failure);
      } else {
        pending.resolve(msg.result);
      }
      return;
    }

    // Server->client request: has id AND method.
    if (hasId && method !== undefined) {
      void this.dispatchServerRequest(msg.id, method, msg.params);
      return;
    }

    // Notification: method, no id.
    if (method !== undefined) {
      // P3.81 — the notifications this transport reads on its way past.
      //
      // Not a contradiction of "this client stays a transport and judges
      // nothing" above: that line is about JSON-RPC error CODES, where judging
      // would change what a caller's promise does. Nothing here changes control
      // flow. The notification is forwarded byte-identically to
      // `onNotification`, and a second line goes to the diagnostic channel this
      // client already owns for stderr, unparseable lines and unknown ids.
      //
      // It is read HERE because this is the only point every server->client
      // notification passes through on the product path, and because the thing
      // being reported — `CODEX_HOME/rules/nessy.rules` failing to parse, which
      // drops EVERY projected deny floor and Always-Allow grant at once — was
      // otherwise dropped on the floor. Emitted BEFORE the forward so a throwing
      // `onNotification` cannot swallow it. See `config-warning.ts` for the
      // measurement and for why this reports rather than refuses.
      if (method === CODEX_CONFIG_WARNING_METHOD) {
        this.handlers.onDiagnostic?.(describeCodexConfigWarning(msg.params));
      }
      // P2.408 — the SIBLING channel, and the reason it is read here too: the
      // plain `warning` says the config was obeyed and the resulting session is
      // unstable, where `configWarning` says the config failed to load. Same
      // no-control-flow contract as above (forward is byte-identical, the
      // diagnostic goes out first so a throwing `onNotification` cannot swallow
      // it), and the diagnostic is only HALF the surfacing: this channel's one
      // measured class lands before any turn exists, so the operator-visible
      // half has to defer and lives in `CodexAgent`. See `server-warning.ts`.
      if (method === CODEX_WARNING_METHOD) {
        this.handlers.onDiagnostic?.(describeCodexServerWarning(msg.params));
      }
      this.handlers.onNotification?.(method, msg.params);
      return;
    }

    this.handlers.onDiagnostic?.(`unrecognized message: ${line.slice(0, 200)}`);
  }

  private async dispatchServerRequest(id: unknown, method: string, params: unknown): Promise<void> {
    if (!this.handlers.onServerRequest) {
      // No handler: reply with a method-not-found error so the server isn't left hanging.
      this.write({ id, error: { code: -32601, message: `no handler for ${method}` } });
      return;
    }
    try {
      const result = await this.handlers.onServerRequest({ method, params });
      this.write({ id, result: result ?? {} });
    } catch (err) {
      this.write({ id, error: { code: -32000, message: err instanceof Error ? err.message : String(err) } });
    }
  }
}
