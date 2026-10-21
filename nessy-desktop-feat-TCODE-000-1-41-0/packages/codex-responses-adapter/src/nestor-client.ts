/**
 * Thin POST client for a chat/completions upstream.
 *
 * The upstream is a parameter (`UpstreamTarget`), and **auth is scoped to the
 * mode**: `Nestor-Token: <jwt>` is sent ONLY to the built-in Nessy Gateway
 * (`kind: 'nestor'`, 00-context + AGENTS.md "Gateway Facts"); every other
 * endpoint gets standard `Authorization: Bearer <apiKey>` semantics and never
 * sees the gateway token. Omitting `upstream` keeps the original gateway
 * behavior byte-for-byte, which is what the codex runtime relies on.
 *
 * The base prefix is inlined here (mirrors
 * `server-core/model-fetchers/nestor.ts:NESTOR_CLI_BASE_PREFIX`) rather than
 * imported: `CodexAgent` (in `packages/shared`) runs this adapter in-process,
 * and importing server-core would form a shared → server-core → shared cycle.
 * Keeping this package free of workspace deps makes it importable from shared.
 * ponytail: one constant duplicated to break a dep cycle; if the gateway host
 * ever moves, update both this and nestor.ts.
 */
const NESTOR_CLI_BASE_PREFIX = 'https://code-completion-nestor.tcsbank.ru/api/v1/cli/';

/** `.../api/v1/cli/openai-like/v1/chat/completions` */
export const NESTOR_CHAT_URL = `${NESTOR_CLI_BASE_PREFIX}openai-like/v1/chat/completions`;

/**
 * Where the adapter sends a turn, and with which auth scheme.
 *
 * The third member arrived in G3, as the comment here long predicted. Its
 * point is that the first two both take a CHAT body and this one does not: it
 * is the passthrough case, where the SDK's own Anthropic Messages body goes
 * upstream untranslated. Measured 2026-08-14: llm-proxy answers `anthropic/*`
 * only on `/v1/messages` and returns `400 unsupported endpoint` for them on
 * chat-completions, so translation was never going to work for those models —
 * not translating is the whole feature.
 */
export type UpstreamTarget =
  /** Built-in Nessy Gateway: `NESTOR_CHAT_URL` + `Nestor-Token: <jwt>` from dp creds. */
  | { kind: 'nestor' }
  /** Any OpenAI-shaped endpoint: `${baseUrl}/chat/completions` + {@link CredentialHeader}. */
  | { kind: 'openai-compatible'; baseUrl: string; apiKey?: string; credentialHeader?: CredentialHeader }
  /**
   * An endpoint that speaks Anthropic Messages natively:
   * `${baseUrl}/v1/messages` + {@link CredentialHeader}. Takes an ANTHROPIC
   * body, never a chat one — see {@link postChat}, which refuses it.
   */
  | { kind: 'anthropic-messages'; baseUrl: string; apiKey?: string; credentialHeader?: CredentialHeader };

/**
 * P6.258 (denominator C16) — which header a BYO endpoint reads its credential
 * from.
 *
 * Both non-gateway arms sent `Authorization: Bearer` and only that, so an
 * endpoint that reads `x-api-key` — Anthropic's own scheme, and the one several
 * proxies in front of it copy — could not be connected on any runtime, however
 * correct the key was. It is a property of the ENDPOINT, so it is a property of
 * the connection rather than of a runtime, and one place decides it for all of
 * them ({@link resolveUpstreamRequest}).
 *
 * `undefined` means `authorization`, which is why no existing connection
 * changes: the field is absent everywhere it has never been set.
 *
 * Deliberately two values and not an arbitrary header name. An arbitrary name
 * is a credential-exfiltration primitive in a config file, and no endpoint we
 * have measured needs one; if a third scheme ever turns up, adding a member
 * here is a smaller change than taking one back.
 */
export type CredentialHeader = 'authorization' | 'x-api-key';

/**
 * The auth-scheme vocabulary, SCHEME ONLY. P6.258 gave it a fourth member.
 *
 * P6.585 made all four reachable on the typed sink. Until then the sink carried
 * a three-member subset, because its single registered consumer is
 * `codex-agent.ts recordUpstreamAuthScheme` — a hot-spot file the P6.258 lane
 * could not write — and the codex driver did not thread `credentialHeader`
 * either; the two went together or neither did. Both landed in one commit, so
 * the subset type is gone and the sink now reports exactly what left. There is
 * no narrower alias to widen next time: one vocabulary, one sink.
 */
export type UpstreamAuthScheme = 'bearer' | 'nestor-token' | 'x-api-key' | 'none';

/** What `startAdapter`/`postChat` use when no `upstream` is supplied. */
export const DEFAULT_UPSTREAM: UpstreamTarget = { kind: 'nestor' };

export interface PostChatOptions {
  /**
   * Nestor-Token value. Read ONLY in `kind: 'nestor'` mode; never forwarded to
   * any other upstream. Optional because non-nestor modes have no gateway JWT —
   * in nestor mode the caller must supply it (`server.ts`'s 401 creds gate is
   * what guarantees that; an absent one degrades to an empty token, i.e. a
   * gateway 401, rather than throwing).
   */
  jwt?: string;
  /** Upstream endpoint + auth mode. Default: `DEFAULT_UPSTREAM` (the gateway). */
  upstream?: UpstreamTarget;
  signal?: AbortSignal;
  /** Injected in tests to capture/replace the outgoing request. */
  fetchImpl?: typeof fetch;
  /**
   * Where the auth-scheme line goes.
   *
   * The Pi reasoning proxy's twin writes to stderr and the host captures that
   * into a ring buffer a driver can read. This adapter runs IN-PROCESS, so its
   * stderr reaches no such buffer — measured 2026-08-15, `CODEX-TURN` could not
   * see a single line. The caller therefore supplies the sink; stderr remains
   * the default so the package keeps working with no wiring at all.
   */
  onUpstreamAuth?: (scheme: UpstreamAuthScheme) => void;
}

/**
 * The credential header for a BYO arm, or nothing at all when there is no key.
 *
 * One function so the two BYO arms cannot disagree — they already had two
 * identical copies of the bearer line, which is how one of them would have kept
 * the old scheme after this change.
 */
function credentialHeaderFor(apiKey?: string, header?: CredentialHeader): Record<string, string> {
  if (!apiKey) return {};
  return header === 'x-api-key'
    ? { 'x-api-key': apiKey }
    : { Authorization: `Bearer ${apiKey}` };
}

/**
 * Resolve a target (plus the nestor-only JWT) into a URL and request headers.
 * The single place that decides which auth header a mode may carry.
 */
function resolveUpstreamRequest(target: UpstreamTarget, jwt?: string): { url: string; headers: Record<string, string> } {
  switch (target.kind) {
    case 'nestor':
      return {
        url: NESTOR_CHAT_URL,
        headers: { 'content-type': 'application/json', 'Nestor-Token': jwt ?? '' },
      };
    case 'openai-compatible':
      return {
        url: `${target.baseUrl.replace(/\/+$/, '')}/chat/completions`,
        headers: {
          'content-type': 'application/json',
          ...credentialHeaderFor(target.apiKey, target.credentialHeader),
        },
      };
    case 'anthropic-messages':
      return {
        url: `${target.baseUrl.replace(/\/+$/, '')}/v1/messages`,
        headers: {
          'content-type': 'application/json',
          ...credentialHeaderFor(target.apiKey, target.credentialHeader),
        },
      };
    default: {
      const unhandled: never = target;
      throw new Error(`unsupported upstream target: ${JSON.stringify(unhandled)}`);
    }
  }
}

/**
 * POST a chat/completions body to the configured upstream with its own auth.
 *
 * REFUSES an `anthropic-messages` target rather than posting to its URL. The
 * two carry different bodies, and `resolveUpstreamRequest` will happily hand
 * back `/v1/messages` — sending a chat body there produces a confusing 400 from
 * the endpoint instead of a clear failure here. Passthrough turns go through
 * {@link postAnthropicMessages}.
 */
export function postChat(body: unknown, opts: PostChatOptions): Promise<Response> {
  const doFetch = opts.fetchImpl ?? fetch;
  const target = opts.upstream ?? DEFAULT_UPSTREAM;
  if (target.kind === 'anthropic-messages') {
    throw new Error('postChat cannot serve an anthropic-messages upstream: that target takes an Anthropic body, not a chat one');
  }
  const { url, headers } = resolveUpstreamRequest(target, opts.jwt);
  logUpstreamAuthScheme(headers, opts.onUpstreamAuth);
  return doFetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: opts.signal,
  });
}

/**
 * Name the auth SCHEME a request goes out with — never the credential.
 *
 * The symmetric twin of the Pi reasoning proxy's line, and it exists for the
 * same reason: whether a BYO codex connection kept its `Authorization: Bearer`
 * (rather than the gateway's `Nestor-Token`) is a property of the request that
 * actually left, and reading `resolveUpstreamRequest` in the source is an
 * argument rather than a measurement.
 *
 * SCHEME ONLY — {@link UpstreamAuthScheme} is the entire vocabulary; a line that
 * printed even a prefix of a credential would still be a credential in a log.
 * Off unless `NESSY_PROXY_AUTH_DEBUG=1`, sharing the Pi instrument's switch so
 * one flag lights both paths.
 *
 * P6.258 added `x-api-key`; P6.585 made it reachable on the typed sink too.
 * Reading it off the HEADERS rather than off the target is what makes this a
 * measurement instead of an argument, and it is why the new scheme could not
 * have been forgotten here: the line reports what left.
 */
function logUpstreamAuthScheme(
  headers: Record<string, string>,
  sink?: (scheme: UpstreamAuthScheme) => void,
): void {
  if (!sink && (typeof process === 'undefined' || process.env?.NESSY_PROXY_AUTH_DEBUG !== '1')) return;
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
  const scheme: UpstreamAuthScheme = lower['nestor-token'] !== undefined
    ? 'nestor-token'
    : lower['authorization']?.toLowerCase().startsWith('bearer ')
      ? 'bearer'
      : lower['x-api-key'] !== undefined
        ? 'x-api-key'
        : 'none';
  // P6.585 — every scheme the request can carry reaches the sink. The guard that
  // used to drop `x-api-key` here existed only because the sink's type could not
  // name it; a credential DID ride, and silence on the one channel that exists to
  // say so was the residue that row closed.
  if (sink) { sink(scheme); return; }
  if (typeof process === 'undefined' || process.env?.NESSY_PROXY_AUTH_DEBUG !== '1') return;
  process.stderr.write(`[codex-adapter] upstream auth: ${scheme}\n`);
}

/**
 * POST an Anthropic Messages body STRAIGHT through to an upstream that speaks
 * it natively. No translation in either direction — the SDK's own body goes up
 * and the upstream's own response (JSON or SSE) comes back for the caller to
 * pipe.
 *
 * `anthropic-version` is forwarded rather than invented: the SDK negotiates it
 * with the endpoint and picking a value here would silently pin the protocol.
 *
 * `anthropic-beta` is forwarded for the SAME reason, and its absence used to be
 * a real defect rather than an omission. The body goes up verbatim, and parts of
 * that body exist ONLY because a beta was negotiated: measured 2026-08-17, the
 * shipped CLI sends `context_management: {...}` together with
 * `anthropic-beta: …,context-management-2025-06-27,…`, and the two are one
 * decision in its own code. Forwarding the field while dropping the header put a
 * beta-gated field on the wire with no beta declared — a request the client never
 * composed. Half a negotiation is not "not understanding the protocol"; it is
 * understanding it wrongly.
 */
export function postAnthropicMessages(
  body: unknown,
  opts: {
    upstream: Extract<UpstreamTarget, { kind: 'anthropic-messages' }>;
    /** `anthropic-version` from the inbound request, preserved verbatim. */
    anthropicVersion?: string;
    /** `anthropic-beta` from the inbound request, preserved verbatim. */
    anthropicBeta?: string;
    signal?: AbortSignal;
    fetchImpl?: typeof fetch;
  },
): Promise<Response> {
  const doFetch = opts.fetchImpl ?? fetch;
  const { url, headers } = resolveUpstreamRequest(opts.upstream);
  return doFetch(url, {
    method: 'POST',
    headers: {
      ...headers,
      ...(opts.anthropicVersion ? { 'anthropic-version': opts.anthropicVersion } : {}),
      ...(opts.anthropicBeta ? { 'anthropic-beta': opts.anthropicBeta } : {}),
    },
    body: JSON.stringify(body),
    signal: opts.signal,
  });
}
