/**
 * Correlation headers for gateway requests, and the operator-supplied header
 * channel that is our `ANTHROPIC_CUSTOM_HEADERS` equivalent.
 *
 * The doc contract, quoted from pages fetched with `curl`:
 *
 * - `llm-gateway-protocol.md:77` — `x-claude-code-session-id` is "A unique
 *   identifier for the current Claude Code session. Use it to aggregate all
 *   requests from one session without parsing request bodies".
 * - `llm-gateway-protocol.md:78` and `:79` — `x-claude-code-agent-id` and
 *   `x-claude-code-parent-agent-id`, each "present only on requests from an
 *   agent Claude Code spawned inside the session".
 *
 *   **This module used to say "Nessy has no producer for either". P6.462
 *   REFUTED that on the wire, and it was refuted for one runtime of three.** The
 *   claude child is a producer — an UPSTREAM one, whose output arrives at our
 *   loopback adapter as an inbound header. Measured 2026-09-06 against the
 *   vendored native binary (`claude-cli/2.1.233`, agent-sdk 0.3.260) pointed at
 *   a recording Anthropic-Messages server, one main turn that spawned a
 *   subagent which itself spawned a second:
 *
 *   | request | headers carried |
 *   | --- | --- |
 *   | main thread (3 turns) | session id only |
 *   | subagent A | `agent-id=a06ff1cf7fdb0d6fc` |
 *   | subagent B, spawned by A | `agent-id=ad2740e22b9a4829a`, `parent-agent-id=a06ff1cf7fdb0d6fc` |
 *
 *   So `parent-agent-id` appears only on a NESTED spawn — a top-level subagent's
 *   parent is the main thread, which is the session — and a string in a binary
 *   was indeed not a wire until this was run.
 *
 *   {@link gatewaySessionFetch} now forwards both, translated into the Nessy
 *   spellings below and scoped to the verified gateway prefix like everything
 *   else here. **Pi and codex have no producer** (a Pi child session is its own
 *   subprocess with its own session id, and codex's threads never reach this
 *   fetch as separate agents), so a gateway can attribute below session level on
 *   claude and on claude alone. That difference is NAMED here rather than closed
 *   by minting an id we would have to invent, and it is pinned by
 *   `gateway-headers.host.test.ts`.
 * - `llm-gateway-protocol.md:81` — "the ID identifies an agent, not a person or
 *   a device, so don't treat the agent ID header as a user identifier". Our
 *   session id is a local storage key, not an account.
 * - `llm-gateway-protocol.md:83` — "If your developers set
 *   `ANTHROPIC_CUSTOM_HEADERS`, those headers appear on requests as well."
 * - `env-vars.md:145` — that variable's shape: "Custom headers to add to
 *   requests (`Name: Value` format, newline-separated for multiple headers)".
 *
 * Nessy spellings, because `AGENTS.md` keeps runtime symbols Nessy-specific:
 * `x-nessy-session-id`, and `NESSY_CUSTOM_HEADERS` with the documented value
 * shape unchanged.
 *
 * Two rules this module exists to hold:
 *
 * 1. **A header value is never logged.** An operator-supplied header channel is
 *    exactly where an operator puts a token, so the only thing callers can get
 *    out of here for a log line is `customHeaderNames()` — names, never values.
 * 2. **Correlation is scoped by URL prefix, not by host.** `AGENTS.md`:
 *    "Nestor-specific request rewriting must stay scoped to the verified
 *    gateway URL prefix. Custom endpoints, even on the same host with a
 *    different path, must retain normal provider auth semantics." A correlation
 *    header is such a rewrite: it must not ride onto a custom endpoint that
 *    merely shares the gateway's hostname.
 *
 * ## Two process shapes, and only one of them has a session in its environment
 *
 * `NESSY_SESSION_ID` identifies a session because a **Pi** session IS a
 * subprocess: `pi-agent.ts` writes the id into the child's env, the interceptor
 * preloads into that same child, and one process means one session.
 *
 * The **claude** runtime is the other shape. Its SDK child is a native binary
 * pointed at `http://127.0.0.1:<ephemeral>` — a per-session Anthropic-Messages
 * adapter that runs INSIDE the host — and the host then makes the upstream
 * gateway request itself. Two consequences follow, and both used to be silent:
 *
 * - `gatewayCorrelationHeaders` is unreachable from the SDK child (the loopback
 *   URL is not the gateway prefix, and correctly so: a loopback port is not a
 *   host whose audience we can verify).
 * - it is also useless in the host, because the host serves MANY sessions from
 *   ONE process, so a process-wide env var cannot name which session a request
 *   belongs to. Reading `process.env` harder was never going to work.
 *
 * {@link gatewayRequestHeaders} is the entry point for that second shape: the
 * session id is an ARGUMENT, and the audience is still the verified gateway
 * prefix and nothing else. {@link gatewaySessionFetch} wraps it in the exact
 * `typeof fetch` shape the loopback adapter accepts as `fetchImpl`, so the
 * claude path is one argument at the `startAdapter({ upstream, … })` call in
 * `agent/claude-agent.ts:startLocalAdapterRuntime` — that wiring is the piece
 * this module cannot do for itself.
 */

import { NESTOR_CLI_BASE_PREFIX } from '../auth/nestor.ts';
import { debug } from '../utils/debug.ts';

/** Our `x-claude-code-session-id` counterpart. */
export const NESSY_SESSION_ID_HEADER = 'x-nessy-session-id';

/** Our `x-claude-code-agent-id` counterpart. */
export const NESSY_AGENT_ID_HEADER = 'x-nessy-agent-id';

/** Our `x-claude-code-parent-agent-id` counterpart. */
export const NESSY_PARENT_AGENT_ID_HEADER = 'x-nessy-parent-agent-id';

/**
 * The claude-spelled names the SDK child puts on its loopback request, and the
 * Nessy name each becomes on the way upstream.
 *
 * The rename is not branding for its own sake: the request that leaves this host
 * is OURS, made by the host on the session's behalf, and stamping a
 * `x-claude-code-*` name on it would tell the gateway that the claude CLI called
 * it directly. `x-nessy-session-id` already made that choice for the session id;
 * these two follow it.
 *
 * A claude-spelled name is therefore never forwarded verbatim — see
 * {@link gatewaySessionFetch}, which deletes both on every URL, gateway or not.
 */
export const AGENT_ATTRIBUTION_HEADER_RENAMES: ReadonlyArray<readonly [inbound: string, outbound: string]> = Object.freeze([
  Object.freeze(['x-claude-code-agent-id', NESSY_AGENT_ID_HEADER] as const),
  Object.freeze(['x-claude-code-parent-agent-id', NESSY_PARENT_AGENT_ID_HEADER] as const),
]);

/**
 * Names an operator's own header lines may not carry.
 *
 * The session id was reserved because an operator line could otherwise put an id
 * of its choosing on a gateway request and the gateway would aggregate on it.
 * The two attribution names are reserved for exactly the same reason and by the
 * same argument: they are correlation ids the gateway is invited to trust, so
 * the channel an operator controls must not be able to forge one.
 */
const RESERVED_HEADER_NAMES: ReadonlySet<string> = new Set([
  NESSY_SESSION_ID_HEADER,
  NESSY_AGENT_ID_HEADER,
  NESSY_PARENT_AGENT_ID_HEADER,
]);

/** Our `ANTHROPIC_CUSTOM_HEADERS` counterpart. Same documented value shape. */
export const NESSY_CUSTOM_HEADERS_ENV = 'NESSY_CUSTOM_HEADERS';

/** RFC 7230 field-name token. A malformed name is dropped, never sent. */
const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/** A value with a control character cannot be set on a `Headers` object. */
const HEADER_VALUE_FORBIDDEN = /[\0\r\n]/;

const NO_HEADERS: Readonly<Record<string, string>> = Object.freeze({});

type EnvLike = Record<string, string | undefined>;

/**
 * Correlation headers for one outbound request.
 *
 * Empty for every URL outside the verified gateway prefix — including another
 * path on the gateway's own host — and empty when no session id is in scope.
 */
export function gatewayCorrelationHeaders(
  urlStr: string,
  env: EnvLike = process.env,
): Readonly<Record<string, string>> {
  if (!urlStr.startsWith(NESTOR_CLI_BASE_PREFIX)) return NO_HEADERS;
  const sessionId = env.NESSY_SESSION_ID?.trim();
  if (!sessionId || HEADER_VALUE_FORBIDDEN.test(sessionId)) return NO_HEADERS;
  return Object.freeze({ [NESSY_SESSION_ID_HEADER]: sessionId });
}

/**
 * Parse the documented `Name: Value` newline-separated form.
 *
 * A line without a colon, with an invalid name, or with a control character in
 * its value is dropped and reported in `invalid` **by name or line index** —
 * never by value.
 *
 * {@link RESERVED_HEADER_NAMES} — the session id and, since P6.462, the two
 * attribution ids — are dropped the same way. The interceptor already out-wrote
 * a forged session value by applying correlation last, but only in a process
 * that HAD a session id of its own to write; in every other process — the
 * multi-session host included — an operator line could put an id of its choosing
 * on a gateway request and the gateway would aggregate on it. Reserving the
 * names makes that unconditional, and a name (ours, not the operator's value) is
 * safe to report.
 */
export function parseCustomHeaders(raw: string | undefined): {
  headers: Record<string, string>;
  invalid: string[];
} {
  const headers: Record<string, string> = {};
  const invalid: string[] = [];
  if (!raw) return { headers, invalid };

  const lines = raw.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (!line.trim()) continue;
    const separator = line.indexOf(':');
    if (separator < 1) {
      invalid.push(`line ${index + 1}`);
      continue;
    }
    const name = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (!HEADER_NAME.test(name) || HEADER_VALUE_FORBIDDEN.test(value)) {
      invalid.push(HEADER_NAME.test(name) ? name : `line ${index + 1}`);
      continue;
    }
    if (RESERVED_HEADER_NAMES.has(name.toLowerCase())) {
      invalid.push(name);
      continue;
    }
    headers[name] = value;
  }
  return { headers, invalid };
}

/** Operator-supplied headers for this process, or an empty map when unset. */
export function customHeaders(env: EnvLike = process.env): Readonly<Record<string, string>> {
  const raw = env[NESSY_CUSTOM_HEADERS_ENV];
  if (!raw?.trim()) return NO_HEADERS;
  return Object.freeze(parseCustomHeaders(raw).headers);
}

/**
 * The names a log line may carry. Values stay in this process.
 *
 * Sorted so a debug line is stable across runs, and prefixed `!` for a line
 * that was dropped, so a typo is visible without printing what it carried.
 */
export function customHeaderNames(env: EnvLike = process.env): string[] {
  const raw = env[NESSY_CUSTOM_HEADERS_ENV];
  if (!raw?.trim()) return [];
  const { headers, invalid } = parseCustomHeaders(raw);
  return [...Object.keys(headers).sort(), ...invalid.map(name => `!${name}`)];
}

/** Which session an outbound request belongs to, when the process serves many. */
export interface GatewayRequestScope {
  /**
   * The session this request is being made on behalf of. Falls back to
   * `env.NESSY_SESSION_ID` so a one-session-per-process caller (Pi) needs no
   * argument; a host serving many sessions from one process MUST pass it,
   * because its own environment cannot answer the question.
   */
  sessionId?: string;
  /**
   * The agent this request was issued BY, when it was issued by one — P6.462.
   *
   * Absent on a main-thread turn, by construction rather than by omission: the
   * page scopes both attribution names to "requests from an agent Claude Code
   * spawned inside the session", and the measurement in this module's header
   * shows the child honouring exactly that.
   */
  agentId?: string;
  /**
   * The agent that spawned {@link agentId}, when there is one — so present only
   * on a NESTED spawn. A top-level subagent's parent is the main thread, which
   * the session id already names.
   */
  parentAgentId?: string;
  env?: EnvLike;
}

/**
 * Every header the **verified gateway** should receive for one outbound
 * request: the operator's custom headers plus our correlation id.
 *
 * ### Which host receives which value
 *
 * Non-empty for `https://code-completion-nestor.tcsbank.ru/api/v1/cli/…` and
 * for nothing else. Another path on the gateway's own host, a BYO endpoint, the
 * loopback adapter's own `http://127.0.0.1:<port>` and any tool egress all get
 * `{}` — an operator header channel is where an operator puts a token, and the
 * verified gateway prefix is the only audience this module can name.
 *
 * That is deliberately NARROWER than the Pi path, where the interceptor also
 * offers operator headers to a BYO provider URL it recognises through its own
 * adapter list (`unified-network-interceptor.ts:isProviderApiUrl`). This module
 * has no such list, and inventing one here would mean choosing, from inside a
 * telemetry module, to send an operator's token to an endpoint it cannot
 * verify. The residue is stated rather than closed.
 *
 * Correlation is written LAST, and the operator channel can no longer carry the
 * name at all ({@link parseCustomHeaders}), so the id cannot be forged.
 */
export function gatewayRequestHeaders(
  urlStr: string,
  scope: GatewayRequestScope = {},
): Readonly<Record<string, string>> {
  if (!urlStr.startsWith(NESTOR_CLI_BASE_PREFIX)) return NO_HEADERS;
  const env = scope.env ?? process.env;
  const merged: Record<string, string> = { ...customHeaders(env) };

  const sessionId = scope.sessionId?.trim() || env.NESSY_SESSION_ID?.trim();
  if (sessionId && !HEADER_VALUE_FORBIDDEN.test(sessionId)) {
    merged[NESSY_SESSION_ID_HEADER] = sessionId;
  }

  // Written after the operator channel for the same reason the session id is:
  // correlation last, so the reserved names cannot be out-written even if the
  // reservation in `parseCustomHeaders` were ever relaxed.
  const agentId = scope.agentId?.trim();
  if (agentId && !HEADER_VALUE_FORBIDDEN.test(agentId)) {
    merged[NESSY_AGENT_ID_HEADER] = agentId;
    // Only alongside an agent id, never on its own: a parent with no child is
    // not a fact about this request, and the page pairs them.
    const parentAgentId = scope.parentAgentId?.trim();
    if (parentAgentId && !HEADER_VALUE_FORBIDDEN.test(parentAgentId)) {
      merged[NESSY_PARENT_AGENT_ID_HEADER] = parentAgentId;
    }
  }

  return Object.keys(merged).length === 0 ? NO_HEADERS : Object.freeze(merged);
}

/**
 * P6.180 · WILL THE OPERATOR'S CUSTOM HEADERS RIDE ON THIS SESSION'S UPSTREAM?
 *
 * The predicate {@link gatewayRequestHeaders} already applies, asked ahead of
 * the request instead of per request, so an agent can SAY what is about to
 * happen. Structurally typed rather than importing the adapter's
 * `UpstreamTarget`: `telemetry/` must not depend on the codex adapter package
 * to answer a question about a URL prefix.
 *
 * `kind: 'nestor'` is the built-in gateway, whose URL is the verified prefix by
 * construction; every other kind carries its own `baseUrl`, and only a BYO
 * endpoint that happens to sit under the verified prefix rides too — which is
 * the same test the header stamp makes, so the two can never disagree.
 */
export function operatorHeadersRideOnUpstream(
  upstream: { kind?: string; baseUrl?: string } | undefined,
): boolean {
  if (!upstream) return false;
  if (upstream.kind === 'nestor') return true;
  return typeof upstream.baseUrl === 'string' && upstream.baseUrl.startsWith(NESTOR_CLI_BASE_PREFIX);
}

/**
 * P6.180 · the sentence a claude- or codex-runtime session owes an operator
 * whose custom headers will NOT ride, or `undefined` when there is nothing to
 * say.
 *
 * ## The divergence, and why it is not "fixed" by widening the scope
 *
 * Pi's interceptor offers operator headers to any URL its own adapter list
 * recognises (`unified-network-interceptor.ts`'s `isProviderApiUrl`). This
 * module deliberately has no such list — see {@link gatewayRequestHeaders}'s
 * own note: inventing one here would mean choosing, from inside a telemetry
 * module, to send an operator's token to an endpoint it cannot verify. So the
 * narrowing STANDS and what was missing is that nobody was told about it: the
 * operator set one variable, saw it work on Pi, and got silence on the other
 * two runtimes. Relaxing the scope instead is an owner question, not a lane's
 * choice, and it is recorded as one rather than taken here.
 *
 * ## What the sentence may carry
 *
 * NAMES only, never values — {@link customHeaderNames} is the module's own
 * rule, and it is what makes this safe to put on a durable, user-visible
 * channel: an operator header channel is where an operator puts a token.
 *
 * One sentence, built here rather than in each agent, so the two runtimes
 * cannot drift into describing one behaviour two ways.
 */
export function customHeadersOffGatewayNotice(
  runtimeLabel: string,
  upstream: { kind?: string; baseUrl?: string } | undefined,
  env: EnvLike = process.env,
): string | undefined {
  const names = customHeaderNames(env);
  if (names.length === 0) return undefined;
  if (operatorHeadersRideOnUpstream(upstream)) return undefined;
  return `${runtimeLabel} CUSTOM HEADERS NOT SENT — ${NESSY_CUSTOM_HEADERS_ENV} names `
    + `${names.join(', ')}, and on this runtime they ride only on the verified Nessy Gateway. `
    + 'This session talks to another endpoint, so none of them is sent; a name shown with a leading '
    + '"!" was malformed and is dropped everywhere. Pi sends them to any provider URL it recognises, '
    + 'which is why the same setting behaves differently there.';
}

/**
 * A `fetch` that stamps {@link gatewayRequestHeaders} on gateway requests and is
 * an exact pass-through everywhere else.
 *
 * This is the shape the loopback Anthropic-Messages adapter already accepts as
 * `fetchImpl`, which is why it exists: a claude-runtime session can hand one
 * down at `startAdapter(…)` and its upstream gateway turns carry the same two
 * header layers a Pi turn carries, on both deployments — the Electron main
 * process, where the interceptor is not installed at all, and the headless
 * server, where it is but has no session id to offer.
 *
 * `init.headers` wins over a `Request` input's own, matching `fetch`'s
 * precedence; nothing else about the call is touched.
 *
 * ## P6.462 · it also carries the SUBAGENT attribution across, and strips it
 *
 * The loopback adapter forwards the claude child's own
 * `x-claude-code-agent-id` / `x-claude-code-parent-agent-id` onto the outbound
 * request it builds — see `codex-responses-adapter/src/server.ts`. That package
 * is the dependency ROOT of the pair and cannot import this module, so it can
 * carry the ids but cannot know which URLs may receive them. This function is
 * the one place that does, so the decision is made exactly once:
 *
 * - on the verified gateway prefix, each is RENAMED to its Nessy spelling;
 * - on every other URL — the loopback hop, a BYO endpoint, any tool egress —
 *   both are DELETED.
 *
 * Deleting unconditionally is the point: without it, forwarding in the adapter
 * would put an internal agent id on a request to an endpoint we cannot verify,
 * which is exactly the trade {@link gatewayRequestHeaders} refuses to make for
 * the operator's own header channel.
 */
/**
 * C3.218 — the one line that makes the header proof observable on a PACKAGED
 * build, and the reason it did not exist is why the 1.36.0 release sitting could
 * not drive P6.181 to a verdict.
 *
 * The proof M2 needs is *"the upstream request captured at the gateway prefix
 * carrying the real session id and every operator header name"*, with three
 * controls: a BYO endpoint carries neither, the loopback hop carries neither,
 * and codex is driven itself. On a packaged build there was no capture point at
 * all: the correlation seam is a `fetchImpl` in the main process, so the
 * interceptor never sees it, and the request leaves over TLS to a host nothing
 * on the machine may intercept. Every arm of that proof is decided HERE — this
 * is the function that adds the headers or declines to — so this is the honest
 * place to observe it.
 *
 * NAMES AND THE SESSION ID, NEVER A VALUE. Rule 1 of this module's own header:
 * *"A header value is never logged. An operator-supplied header channel is
 * exactly where an operator puts a token."* The session id is our own local
 * correlation key, not an account, and the proof is precisely that it matches
 * the session's real id.
 *
 * Off unless `NESSY_PROXY_AUTH_DEBUG=1`, sharing the switch the codex adapter's
 * `logUpstreamAuthScheme` already uses so one flag lights every
 * name-the-request-never-the-credential instrument. It reaches a packaged
 * build's log only with `NESSY_DEBUG=1` as well, because that is what opens the
 * sink at all (AGENTS.md §Traps: a packaged build logs nothing outside debug
 * mode) — two flags, and the second one is the operator's consent to a line per
 * request.
 *
 * The OFF-GATEWAY case logs too, deliberately: controls (a) and (b) are absence
 * claims, and an instrument that only speaks when it acts cannot evidence one.
 *
 * The LINE is built by a pure function and emitted by its one-line wrapper, so a
 * test can assert what reaches a log — including that no header VALUE does —
 * without latching this process's debug switch, which has no off.
 */
export function gatewayHeaderDecisionLine(
  urlStr: string,
  scope: GatewayRequestScope,
  extra: Readonly<Record<string, string>>,
  env: EnvLike = typeof process === 'undefined' ? {} : process.env,
): string | undefined {
  if (env.NESSY_PROXY_AUTH_DEBUG !== '1') return undefined;
  const onGateway = urlStr.startsWith(NESTOR_CLI_BASE_PREFIX);
  const names = Object.keys(extra).sort();
  return `[gateway-headers] ${onGateway ? 'gateway' : 'off-gateway'} request: `
    + `${names.length === 0 ? 'no headers added' : `added ${names.join(', ')}`}`
    + `${scope.sessionId ? `, session=${scope.sessionId}` : ', no session id'}`
    + ' (names only - a header VALUE is never logged)';
}

/** Emit the line above, if the operator asked for it. */
function debugGatewayHeaderDecision(
  urlStr: string,
  scope: GatewayRequestScope,
  extra: Readonly<Record<string, string>>,
): void {
  const line = gatewayHeaderDecisionLine(urlStr, scope, extra);
  if (line) debug(line);
}

export function gatewaySessionFetch(
  sessionId: string | undefined,
  inner: typeof fetch = fetch,
): typeof fetch {
  return ((input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const urlStr = typeof input === 'string'
      ? input
      : input instanceof URL ? input.toString() : input.url;

    const source = init?.headers ?? (input instanceof Request ? input.headers : undefined);
    const headers = new Headers(source);

    const carried: string[] = [];
    const scope: GatewayRequestScope = { sessionId };
    for (const [inbound, outbound] of AGENT_ATTRIBUTION_HEADER_RENAMES) {
      const value = headers.get(inbound);
      if (value === null) continue;
      carried.push(inbound);
      if (outbound === NESSY_AGENT_ID_HEADER) scope.agentId = value;
      else scope.parentAgentId = value;
    }

    const extra = gatewayRequestHeaders(urlStr, scope);
    debugGatewayHeaderDecision(urlStr, scope, extra);
    // Nothing to add and nothing to strip: hand the ORIGINAL init through, so
    // the pass-through hop stays byte-identical rather than merely equivalent.
    if (Object.keys(extra).length === 0 && carried.length === 0) return inner(input, init);

    for (const name of carried) headers.delete(name);
    for (const [name, value] of Object.entries(extra)) headers.set(name, value);
    return inner(input, { ...init, headers });
  }) as typeof fetch;
}
