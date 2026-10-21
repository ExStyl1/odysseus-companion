/**
 * The real codex-responses-adapter: a localhost server that translates a client's
 * request into Nestor Chat Completions and maps the chat response/stream back.
 *
 * Two front doors over ONE pipeline:
 *  - `POST /v1/responses` — Codex's Responses wire protocol (the original route).
 *  - `POST /v1/messages`  — the Anthropic Messages protocol the Claude Agent SDK
 *    speaks when `ANTHROPIC_BASE_URL` points here. Inbound is translated to a
 *    Responses body, driven through the same `toChatRequest` → `sendWithRetry` →
 *    `streamResponsesFromChat` pipeline, and translated back to Anthropic SSE.
 *
 * Binds `127.0.0.1` only. Same localhost/ephemeral-port shape the Phase 1
 * `config-writer` already points codex at. Codex always sends `stream:true`;
 * the non-stream branch exists for direct/conformance testing.
 *
 * The Phase 1 canned stub lives in `./stub-server.ts` (still used by the spike).
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { defaultCredsPath, readNestorCreds, type NestorCredsRefusal } from './nestor-auth.ts';
import { toChatRequest, extractToolNamespaces, type ModelGenerationDefaults } from './to-chat.ts';
import { sendWithRetry } from './retry.ts';
import { mapUsage, toResponsesResponse, type ChatJson } from './from-chat.ts';
import { parseChatSse, streamResponsesFromChat, type ChatChunk, type StreamResponsesOptions } from './from-chat-stream.ts';
import { openAiError, responsesErrorEvent } from './errors.ts';
import { DEFAULT_UPSTREAM, postAnthropicMessages, type UpstreamAuthScheme, type UpstreamTarget } from './nestor-client.ts';
import { AnthropicRequestError, anthropicToResponsesTranslation } from './anthropic/inbound.ts';
import { anthropicErrorBody, responsesJsonToAnthropicMessage, responsesSseToAnthropicSse } from './anthropic/outbound.ts';
import { UpstreamFieldRefusals, findRefusedRemovableFields, withoutBetaFor, withoutFields } from './anthropic/passthrough-negotiation.ts';

export type { UpstreamTarget } from './nestor-client.ts';
export { DEFAULT_UPSTREAM } from './nestor-client.ts';

export interface AdapterOptions {
  /**
   * Override the Nessy Gateway JWT (tests / non-default creds). Default: read
   * `~/.nessy/dp_auth_creds.json`. Consulted ONLY when `upstream` is nestor.
   */
  jwt?: string | null;
  /**
   * Where turns are sent, and with which auth scheme. Default:
   * `{ kind: 'nestor' }` — the built-in gateway, i.e. the codex runtime's
   * existing behavior unchanged.
   */
  upstream?: UpstreamTarget;
  /**
   * PER-REQUEST upstream, chosen by the requested model id (G3).
   *
   * A connection can hold models on two different wires at once — a Qwen served
   * over chat-completions and a `claude-*` served over Anthropic Messages are
   * the same llm-proxy connection — so the wire is a property of the MODEL, not
   * of the session. Returning `undefined` (or omitting this) falls back to
   * `upstream`, which is what every existing caller gets.
   *
   * Consulted on `/v1/messages` only: that is the route the Claude SDK uses,
   * and an `anthropic-messages` target is a PASSTHROUGH — the inbound body goes
   * up untranslated and the upstream's own response comes straight back.
   */
  upstreamForModel?: (model: string) => UpstreamTarget | undefined;
  /**
   * DA1.22 - PER-MODEL generation defaults, chosen by the requested model id.
   *
   * The sibling of {@link AdapterOptions.upstreamForModel} and for the same
   * reason: a connection holds many models and each publishes its own catalogue
   * row, so this is a property of the MODEL rather than of the session. The host
   * resolves it (`@nessy-agent/shared`'s `resolveModelGenerationDefaults`) and
   * this package applies it, because the dependency arrow only runs that way.
   *
   * Consulted on the two TRANSLATED arms only - the Responses route and the
   * translated Anthropic route, which are the two that go through
   * `toChatRequest`. The untranslated `anthropic-messages` passthrough is
   * deliberately untouched: its whole contract is that the inbound body goes up
   * as it came in, and the one rewrite it does perform is documented as the
   * exception that proves it.
   *
   * Omitting it is the pre-DA1.22 behaviour exactly: the invented
   * `temperature: 0.7` / `top_p: 0.8` for every model, and no effort default.
   */
  generationDefaultsForModel?: (model: string) => ModelGenerationDefaults | undefined;
  /** Injected upstream fetch (tests). Default: global `fetch`. */
  fetchImpl?: typeof fetch;
  /**
   * Sink for the outgoing auth SCHEME (never the value). Supplied by the host,
   * because this adapter runs in-process and its stderr reaches no buffer a
   * driver can read.
   */
  onUpstreamAuth?: (scheme: UpstreamAuthScheme) => void;
  /**
   * Sink for the ONE thing the Anthropic passthrough rewrites: a beta-gated
   * field the upstream refused by name, dropped so the turn can be retried.
   *
   * Exists because the route's own principle is that "every byte we reshape is
   * a byte we can get wrong", and a rewrite nobody can observe cannot be
   * debugged. When a user reports "context editing isn't working on my BYO
   * card", this is the only place that can say the memo fired.
   */
  onFieldNegotiation?: (info: { upstream: string; dropped: readonly string[] }) => void;
  /** Called with the winning retry rung on each turn (Phase 7 success-rate eval). */
  onRetryRung?: (rung: number) => void;
  /**
   * Keepalive cadence written into a silent stream, and the silence budget after
   * which the turn is abandoned as stalled (T3b). Defaults live in
   * `from-chat-stream.ts`; overridable so tests need not wait seconds.
   */
  heartbeatMs?: number;
  stallTimeoutSec?: number;
  /**
   * P3.98 + P3.122 — the observation point for MODEL SPEND THE HOST CAUSED.
   *
   * Some requests through this adapter are not the turn the user asked for:
   * the runtime makes them because of how we configured it, they are billed to
   * the same gateway account, and the SDK reports them in no `modelUsage` the
   * host can see. The measured instance is the Claude auto-mode classifier —
   * 110,519 characters of system prompt per check, up to twice per classified
   * action (P3.93 captured it, P3.122 costed it).
   *
   * This is the ONLY place where the inbound request and the upstream's own
   * token counts are both in scope, which is why the hook is here.
   *
   * **The adapter deliberately does not decide WHAT a request is.** This
   * package is the dependency ROOT of the pair (`@nessy-agent/shared` depends
   * on it, never the reverse — see `home-latch.ts`), and the classifier's
   * recognition marker lives in shared's `telemetry/host-overhead-usage.ts`.
   * Copying the marker down here would give one fact two homes and the copies
   * would drift silently, so the raw `system` field is handed UP by reference
   * and the host classifies it. That also keeps the adapter free of a
   * telemetry vocabulary it has no other use for.
   *
   * Called on the non-streaming translated path only, and that is a
   * MEASUREMENT rather than an omission: the classifier's hops were captured
   * off the binary as non-streaming JSON replies carrying `usage.input_tokens`
   * / `usage.output_tokens` (`claude-auto-mode-classifier-gateway-e2e.test.ts`
   * reads exactly those fields). A streaming host-overhead source would need
   * the counts pulled out of the SSE tail and is not counted today; there is
   * no such source today, and this sentence is the record if one appears.
   *
   * Best-effort by contract: the call is wrapped so a throwing sink can never
   * fail a request.
   */
  onUpstreamCall?: (call: UpstreamCallObservation) => void;
  /**
   * P3.363 — the outbound TOOL NAMES, handed up so the host can classify the
   * model target and disclose what left for it.
   *
   * NAMES ONLY, and that is the point rather than an economy: the SCHEMAS are
   * the payload under discussion, so copying them out of the body to describe
   * themselves would make the disclosure a second copy of the thing being
   * disclosed. The host's notice (`noteModelTargetToolEgress`, W5-c) said
   * "every MCP tool schema this session exposes" because it had no list; with
   * this sink it names them.
   *
   * Same doctrine as {@link AdapterOptions.onUpstreamCall}: this package is the
   * dependency ROOT of the pair and cannot import `@nessy-agent/shared`, so the
   * adapter reports and the host CLASSIFIES. Fired once per outbound turn on
   * each of the three arms that can carry tools — the Responses route, the
   * translated Anthropic route, and the untranslated Anthropic passthrough —
   * from the body about to be sent, so a request whose tools were dropped
   * upstream reports what actually went.
   *
   * Best-effort by contract: the call is wrapped so a throwing sink can never
   * fail a turn.
   *
   * ## DA2.3 - this sink stays OBSERVATION-ONLY, and that is a decision
   *
   * DA2.3 proposed a filter beside it: a host-supplied predicate, injected the
   * way {@link AdapterOptions.readWithIdleTimeout} is, dropping non-whitelisted
   * `mcp__*` tools from the body for a restricted model target. It is REFUSED,
   * and the refusal is recorded at the seam rather than in a plan because this
   * is where the next lane will look. Three readings, 2026-09-14:
   *
   * 1. On the UNTRANSLATED Anthropic passthrough the page forbids it outright -
   *    see the DA2.3 section of `anthropic/passthrough-negotiation.ts` symbol
   *    `REMOVABLE_BETA_FIELDS`, whose doctrine carries both verbatim sentences
   *    and their anchors. (Not an `@link`: that symbol is not imported here,
   *    and an unresolvable link is worse than a citation.)
   * 2. On the two arms the page WOULD permit (Responses, and the translated
   *    Anthropic route, which is the page's own non-Anthropic-upstream
   *    exception) the filter would be redundant: every `mcp__*` tool in a body
   *    that reaches this file is there because the host configured that server
   *    for the child, so the host's own tool set is strictly upstream of this
   *    package and narrowing it removes the tool before it is ever serialized.
   *    The source row itself says to build beside the observation rather than as
   *    a second mechanism; on these arms a filter here IS the second mechanism.
   * 3. There is nothing to enforce anyway: no whitelist constant exists, and
   *    DA2.2 records that minting one needs an owner decision, because DP-5
   *    exempts BYO connections while the BYO card's default endpoint is the very
   *    corporate proxy channel DP-5 restricts.
   *
   * The residue, stated: `mcp__session__*` is NOT pool-served, so it is the one
   * family a wire filter could reach that a pool filter cannot. Its narrowing is
   * decided by ODR-1 and DA2.4, not here. And Pi has no equivalent of this sink
   * at all, so on that runtime even the tool-NAMED disclosure is absent -
   * `backend/factory.ts` fires only the unnamed target notice, at backend
   * construction, where the session's MCP tool set does not exist yet.
   */
  onOutboundTools?: (info: { upstream: string; model: string; toolNames: readonly string[] }) => void;
  /**
   * C4.10 (owner answer QF3 = B, 2026-09-11) — the host's OWN idle abort for the
   * Anthropic passthrough's raw byte relay, injected rather than imported.
   *
   * The relay below forwards an upstream that may go silent without closing, and
   * `read()` on such a stream never settles. The mechanism for that already
   * exists once in this repo — `packages/shared/src/llm/stream-idle.ts` symbol
   * `readWithIdleTimeout`, a per-chunk re-armed timer that cancels the reader and
   * throws an error named `StreamIdleTimeoutError`. It cannot be imported here for the reason
   * {@link AdapterOptions.onOutboundTools} and `home-latch.ts` both state: this
   * package is the dependency ROOT of the pair (`@nessy-agent/shared` depends on
   * it, never the reverse), so an import would close a workspace cycle.
   *
   * Re-implementing the loop locally was the alternative and was refused: two
   * copies of one timing rule drift, and the budget, its clamp and the operator
   * knob (`NESSY_STREAM_IDLE_TIMEOUT_MS`) would then have two homes. So the host
   * passes its own generator and this package stays dependency-free.
   *
   * Unset — every embedder that is not our host, and every existing test — the
   * relay reads exactly as before, so this changes no default behaviour.
   */
  readWithIdleTimeout?: (reader: RelayByteStreamReader) => AsyncIterable<Uint8Array>;
}

/**
 * What the relay needs from a byte reader, declared STRUCTURALLY for the reason
 * `stream-idle.ts` declares its own twin that way: stream types come from
 * different lib sets in different packages of this monorepo, so a named global
 * typechecks green in one and red in the next while the runtime behaviour is
 * identical. Naming what we call keeps the host's `readWithIdleTimeout`
 * assignable to {@link AdapterOptions.readWithIdleTimeout} with no cast.
 */
export interface RelayByteStreamReader {
  read(): Promise<{ done: boolean; value?: Uint8Array | undefined }>;
  cancel(reason?: unknown): Promise<void>;
}

/**
 * The host's stall, recognised by NAME rather than by `instanceof`.
 *
 * `StreamIdleTimeoutError` is declared in `@nessy-agent/shared` and this package
 * cannot import it, so the class identity is unavailable here — but its `name`
 * is an own readonly field on that class and travels with the value. Anything
 * else that reaches the catch below is an upstream that broke on its own, which
 * this route deliberately does NOT dress up as a terminal frame.
 */
function isHostStreamIdleTimeout(error: unknown): boolean {
  return !!error && typeof error === 'object' && (error as { name?: unknown }).name === 'StreamIdleTimeoutError';
}

/** Read a reader to exhaustion with no deadline — the pre-C4.10 relay, verbatim. */
async function* readWithoutDeadline(reader: RelayByteStreamReader): AsyncGenerator<Uint8Array> {
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    if (value) yield value;
  }
}

/**
 * P3.363 — fire {@link AdapterOptions.onOutboundTools} without letting it near
 * the turn. One helper for all three arms, so a future arm cannot forget the
 * try/catch that makes the sink safe.
 */
function noteOutboundTools(
  opts: AdapterOptions,
  info: { upstream: string; model: string; toolNames: readonly string[] },
): void {
  if (!opts.onOutboundTools) return;
  try {
    opts.onOutboundTools(info);
  } catch { /* observation must not fail a turn */ }
}

/**
 * One completed upstream call, as the adapter can describe it without knowing
 * what the call was FOR. See {@link AdapterOptions.onUpstreamCall}.
 */
export interface UpstreamCallObservation {
  /** The inbound Anthropic `system` field, verbatim — a string or block array. */
  system: unknown;
  /** The model actually sent upstream, after translation. */
  model: string;
  inputTokens: number;
  outputTokens: number;
}

export interface AdapterHandle {
  port: number;
  close: () => Promise<void>;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c as Buffer));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown, extraHeaders?: Record<string, string>): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', ...extraHeaders });
  res.end(payload);
}

/**
 * A quota-shaped refusal, F1.1089. Measured wording: the gateway's quota error
 * carries `insufficient_quota` (the code pi-ai's own NON_RETRYABLE list keys on,
 * and the string the DN-045 sitting's Pi row read), and OpenAI-compatible relays
 * say "quota exceeded"/"quota exhausted". A refusal like this will not succeed
 * on retry — only the header below can tell the Claude SDK that, because the
 * status stays a retryable 429 on purpose (see the passthrough comment at the
 * upstream-error branch).
 */
const QUOTA_REFUSAL_PATTERN = /insufficient[_-]?quota|quota\s+(?:exceeded|exhausted)/i;

/**
 * ## Why both refusals below are FUNCTIONS, and why the names stayed SHOUTED (review R6, 2026-09-17)
 *
 * Both were `const`s whose parenthetical spelled `~/.nessy/dp_auth_creds.json` verbatim, while the
 * resolver one import away — {@link defaultCredsPath} — has honoured an absolute `NESSY_HOME` since
 * DA1.5. On a relocated install the gate READ one file and NAMED another, and the same wave shipped
 * the opposite promise to the user on the credentials reference page ("that path moves with it —
 * delete the file in the directory that variable names"). The sentence is user-visible, not an
 * operator log: on the second failure in a session `attemptAuthRetry` returns false and
 * `processEvent`'s `case 'error'` appends the message verbatim as a chat error row.
 *
 * So the parenthetical is built at MESSAGE time. Not at module load, deliberately: `NESSY_HOME` and
 * the home latch can both move after this module is imported — the suite beside it relocates both
 * inside a single test body — and a value frozen at import would then name the path the process
 * started with rather than the file the gate just read.
 *
 * The NAMES are kept in their constant spelling on purpose, even though they are now calls. They are
 * cited by plan rows DA1.12 and DA1.29, by `SessionManager`'s own auth-retry comment and by
 * `SessionManager.surfaced-fault-downstream.test.ts`; a rename would cost four correction edits and
 * buy nothing, where a changed KIND is caught by the compiler at every call site.
 *
 * ---
 *
 * Message both routes' credential-gate 401s carry when there is NO usable credential (gateway mode only — see below).
 *
 * DA1.29 — this sentence is LOAD-BEARING in the same way `EXPIRED_CREDENTIALS` is, and for the same
 * reason. `packages/server-core/src/sessions/SessionManager.ts` symbol `messageLooksLikePlainAuthError`
 * matches the PAIR `nessy gateway` + `credentials not found`, so a turn that fails this gate reaches the
 * auth retry, forces a re-mint, and raises DA1.4's card with the reason instead of dying as a raw error
 * row. The typed `code` this route also sends does NOT reach that layer — measured 2026-09-17 (WB-c),
 * `credentials_expired` scores 0 occurrences in `packages/server-core` and 0 in `packages/core` — so the
 * SENTENCE is the only channel there. Keep both words when rewording: the path moves, those two do not.
 */
export function NO_CREDENTIALS(): string {
  return `Nessy Gateway credentials not found (${defaultCredsPath()})`;
}

/**
 * DA1.12 — the OTHER credential-gate 401, and the reason it is a different
 * sentence rather than a rewording of the one above.
 *
 * An expired-but-well-shaped JWT is the RE-MINT trigger the plan's Target scheme
 * clause 1 names; reported as "not found" it sends the user to the wrong remedy
 * (re-enter an API key that is fine) instead of to the one that works (sign in
 * again so the token is re-minted).
 *
 * The wording is not free-hand. It contains the substring `token is expired`,
 * which `@nessy-agent/server-core` `sessions/SessionManager.ts` symbol
 * `messageLooksLikePlainAuthError` already matches — so the existing shared
 * auth-retry seam recognises this refusal, where the not-found sentence above
 * matches neither of that heuristic's first four clauses. Reusing vocabulary the
 * host seam already reads is the native-first step; minting a private one would
 * have been a second dialect for the same event.
 *
 * The parenthetical is the resolved creds path, for the reason given above this
 * pair; the substring is not, and must survive any rewording verbatim.
 */
export function EXPIRED_CREDENTIALS(): string {
  return `Nessy Gateway authentication token is expired (${defaultCredsPath()}) — sign in again to re-mint it`;
}

/**
 * The 401 body text for a gate refusal, by reason — resolved HERE, at the moment
 * the refusal is sent, so the path it names is the path the gate just read.
 */
function credentialRefusalMessage(reason: NestorCredsRefusal): string {
  return reason === 'credentials_expired' ? EXPIRED_CREDENTIALS() : NO_CREDENTIALS();
}

/**
 * O20 / P3.201 / P2.456 / P3.115 — why `GET {base_url}/models` stays a 404.
 *
 * The register entry O20 reads: *"codex asks the loopback adapter for a model
 * catalog on every session and gets a 404, so it falls back to bundled
 * metadata — and that 404 is the seam P3.201 was looking for."* Driven against
 * the shipped `darwin-arm64 codex-app-server` (`rust-v0.148.0`, the tag
 * `codex-protocol/manifest.json` pins) — **five runs, sixteen boots,
 * 2026-09-03** — the seam is not what that reads like. Four measurements, each
 * with a control in the same run:
 *
 * ## 1. Codex never asks. The 404 is hypothetical, not observed.
 *
 * Against the home `writeCodexConfig` actually builds: **zero** `GET
 * /v1/models` in four arms, whether this route answered 404 or 200. Nothing in
 * the turn changed either — `instructions` stayed 20,751 chars, the tool list
 * stayed the same nine, `model/list` stayed codex's own five/eight.
 *
 * The gate is `OpenAiModelsManager::should_refresh_models`
 * (`models-manager/src/manager.rs`): `uses_codex_backend() ||
 * has_command_auth()`. We are ChatGPT-authed for neither, and
 * `ModelProviderInfo::has_command_auth` is `self.auth.is_some()` — the
 * `[model_providers.<key>.auth]` command-token table. Our provider block emits
 * `env_key` instead, so both operands are false and `fetch_and_update_models`
 * is never reached.
 *
 * POSITIVE CONTROL, same rig, same binary: drop `env_key` and append that
 * `auth` table and the request appears immediately — two to five
 * `GET /v1/models?client_version=0.148.0` per session. So the absence above is
 * a finding, not a broken instrument.
 *
 * **And the two cannot coexist.** With both present the binary refuses the
 * whole config at load: `model_providers.nessy_gateway: provider auth cannot be
 * combined with env_key`. Opening this seam therefore means REPLACING the
 * provider's env credential with a command that prints a token — a
 * credential-shape change in `config-writer.ts`, not an addition.
 *
 * ## 2. A pass-through catalog is REJECTED. Instructions are mandatory.
 *
 * The brief for this seam was "pass through what the gateway publishes, author
 * nothing". The binary refuses that response outright:
 *
 *     failed to refresh available models: … failed to decode models response:
 *     model `tgpt/qwen35-397b-a17b-fp8` is missing both `base_instructions`
 *     and `model_messages.instructions_template`
 *
 * — and the failure is SILENT to the user: an `ERROR` line on the child's
 * stderr, no `configWarning`, no notification, the session continuing on
 * fallback metadata. An entry carrying every field the gateway publishes
 * (`id`, `name`, `desc`, `context_window_size`) plus every field codex's serde
 * requires is still rejected for the one field nobody publishes: the agent's
 * own system prompt.
 *
 * ## 3. Supply the prompt and it REPLACES codex's, wholesale.
 *
 * With `model_messages.instructions_template` (or the legacy top-level
 * `base_instructions`) set to a sentinel, the entry is adopted —
 * `tgpt/qwen35-397b-a17b-fp8` appears in `model/list` beside codex's own
 * models, visible and hidden — and the very next turn goes upstream with
 * `instructions` **8 chars long instead of 20,751**. `construct_model_info_from_candidates`
 * takes the remote entry wholesale (`ModelInfo { slug, used_fallback_model_metadata: false, ..remote }`),
 * so the fallback that supplies codex's prompt today is no longer consulted.
 * Vendoring `models-manager/src/prompt.md` (Apache-2.0) to fill the field would
 * work and would be a NEW silent divergence: a prompt copy that must track
 * every codex bump, failing quietly and invisibly when it does not.
 *
 * ## 4. The tool-search gate is real, reachable, and an owner's call.
 *
 * P2.456 closed REFUTED on the two `Stage::Removed` feature keys, and W1-a
 * corrected it to say the real gate — `model_info.supports_search_tool` — is
 * reachable through this endpoint. Measured, with the control in the same run:
 * on an ADOPTED entry, `supports_search_tool: true` changes the turn's tool
 * list from `[…, multi_agent_v1, get_goal, create_goal, update_goal]` to
 * `[…, get_goal, create_goal, update_goal, tool_search]` — the search tool is
 * registered and `multi_agent_v1` is dropped. On a REJECTED entry (no
 * instructions) it changes nothing, which is how a lane could ship the flag and
 * measure no effect. Turning it on defers every MCP tool; O20 already records
 * that as an owner posture call, not a lane's.
 *
 * ## The verdict
 *
 * Three costs, each belonging to somebody else: a provider credential-shape
 * change (`config-writer.ts`), an authored-and-drifting copy of codex's prompt,
 * and a posture change on MCP exposure. What the seam would buy — the context
 * window — codex already takes from `model_context_window` in `config.toml`,
 * the route we already use. So this route stays a 404, and the 404 says why
 * instead of `not found: GET /v1/models`. Status is unchanged from the
 * catch-all, so no client sees a different outcome; only the reason is new.
 *
 * Corrections owed to the register, both from the source at the pinned tag:
 * O20 says the fallback carries `context_window: None`. It does not —
 * `models-manager/src/model_info.rs`'s `model_info_from_slug` carries
 * `context_window: Some(272_000)` and `max_context_window: Some(272_000)`.
 * That is **10,000 tokens above the gateway's published 262,000 serving
 * limit** (P3.88), and it is the number codex uses on exactly the path where
 * the writer withholds `model_context_window` (P3.234, auto-compaction off).
 * `auto_compact_token_limit: None` and `supports_search_tool: false` are right.
 */
export const MODELS_NOT_SERVED =
  'model catalog not served: codex requires per-model agent instructions here '
  + '(`base_instructions` or `model_messages.instructions_template`) and neither the '
  + 'Nessy Gateway nor llm-proxy publishes them, so serving this endpoint would replace '
  + "codex's own system prompt with one we authored. The measurements are in this "
  + "constant's docblock (server.ts).";

/**
 * The dp-creds gate is gateway-only: nestor is the sole mode that reads
 * `~/.nessy/dp_auth_creds.json` and the sole mode that may send `Nestor-Token`.
 * Every other upstream carries its own bearer credential, so it must not be
 * blocked by (or even touch) the gateway creds file.
 *
 * Shared by both routes so the rule cannot drift between them; each route shapes
 * the resulting 401 in its own protocol's error envelope.
 */
function resolveGatewayJwt(
  target: UpstreamTarget,
  opts: AdapterOptions,
): { ok: true; jwt?: string } | { ok: false; reason: NestorCredsRefusal } {
  if (target.kind !== 'nestor') return { ok: true };
  // DA1.7 pins this preference rather than guarding it: an injected value wins
  // over the creds file and therefore meets NEITHER the shape gate NOR the
  // expiry rule below. No production caller injects (both `startAdapter` call
  // sites pass no `jwt`, asserted by name in
  // `packages/shared/src/agent/__tests__/adapter-jwt-injection-call-sites.test.ts`),
  // and the census in `__tests__/jwt-injection-seam.test.ts` prices the guard at
  // 69 call-site edits against a pin's two files.
  if (opts.jwt !== undefined) {
    return opts.jwt ? { ok: true, jwt: opts.jwt } : { ok: false, reason: 'no_credentials' };
  }
  const creds = readNestorCreds();
  return creds.ok ? { ok: true, jwt: creds.jwt } : { ok: false, reason: creds.reason };
}

async function handleResponses(req: IncomingMessage, res: ServerResponse, opts: AdapterOptions): Promise<void> {
  const upstreamTarget = opts.upstream ?? DEFAULT_UPSTREAM;
  const gate = resolveGatewayJwt(upstreamTarget, opts);
  if (!gate.ok) {
    sendJson(res, 401, openAiError(credentialRefusalMessage(gate.reason), 'authentication_error', gate.reason));
    return;
  }
  const jwt = gate.jwt;

  let responsesBody: Record<string, unknown>;
  try {
    responsesBody = JSON.parse(await readBody(req)) as Record<string, unknown>;
  } catch {
    sendJson(res, 400, openAiError('invalid JSON request body', 'invalid_request_error'));
    return;
  }

  const chat = toChatRequest(responsesBody, opts.generationDefaultsForModel);
  // P3.363 · the Responses arm. Read off the translated body, which is what
  // actually goes upstream.
  noteOutboundTools(opts, {
    upstream: upstreamTarget.kind,
    model: chat.model,
    toolNames: (chat.tools ?? []).map(tool => tool.function.name).filter(Boolean),
  });
  const toolNamespaces = extractToolNamespaces(responsesBody);
  const responseId = `resp_${randomUUID()}`;

  // Thread client disconnect → upstream abort.
  const controller = new AbortController();
  let finished = false;
  const onClose = () => {
    if (!finished) controller.abort();
  };
  // ponytail: node:http emits req/res 'close' on client disconnect (verified);
  // bun's http server does not, so under bun a cancelled turn's upstream Nestor
  // request runs to completion (wasteful, not incorrect — codex already moved
  // on via turn/interrupt). Upgrade path: host under Bun.serve and use
  // req.signal if the adapter ever runs under bun.
  res.on('close', onClose);
  req.on('close', onClose);

  let outcome;
  try {
    outcome = await sendWithRetry(chat, { jwt, upstream: upstreamTarget, signal: controller.signal, fetchImpl: opts.fetchImpl, onUpstreamAuth: opts.onUpstreamAuth });
  } catch (err) {
    if (controller.signal.aborted) return; // client gone
    sendJson(res, 502, openAiError(`Nessy Gateway request failed: ${err instanceof Error ? err.message : String(err)}`, 'api_error'));
    return;
  }
  opts.onRetryRung?.(outcome.rung);
  const upstream = outcome.response;

  if (!upstream.ok) {
    const text = await upstream.text().catch(() => '');
    /**
     * P3.334 — the upstream STATUS passes THROUGH, the same rule the
     * `/v1/messages` arm below already applies. This line used to read
     * `400 → 400, 401|403 → 401, everything else → 502`, and every one of those
     * collapses destroyed a distinction the client acts on.
     *
     * Read from `github.com/openai/codex` at `rust-v0.148.0` (strong evidence:
     * the source the shipped binary is built from), `codex-rs/codex-api/src/
     * api_bridge.rs::map_api_error`, which classifies BY STATUS:
     *
     *  - **403** carrying `error.code == "misalignment_policy_violation"` →
     *    `CodexErr::MisalignmentPolicyViolation`; a Cloudflare-blocked 403 gets
     *    its own `user_message` (`api_error_user_message`). Collapsed to 401 the
     *    refusal loses that class — and worse, `codex-rs/core/src/client.rs:1525`
     *    intercepts a 401 BEFORE the mapper and runs `handle_unauthorized`
     *    (refresh the credential, retry the turn), so a policy refusal is
     *    answered by re-authenticating a credential that was never the problem.
     *    That a 403 here is a real refusal rather than a hypothetical is measured
     *    on THIS gateway: llm-proxy answers a runtime turn with
     *    `403 {"error":"… Security Guardrail Triggered: Malicious MCP detected …"}`
     *    (2026-08-15), which is why the claude side already carries the same
     *    ruling in as many words ("A 403 IS NOT AN AUTH FAILURE",
     *    `shared/src/agent/claude-sdk-error-mapper.ts`).
     *  - **429** → `CodexErr::UsageLimitReached`, with `plan_type`, `resets_at`
     *    and the rate-limit snapshot parsed out of the body and headers.
     *    Collapsed to 502 it arrives as a bare `UnexpectedStatus`.
     *  - **500** → `CodexErr::InternalServerError`; **503** with
     *    `error.code == "server_is_overloaded"|"slow_down"` →
     *    `CodexErr::ServerOverloaded`. Both need their own status to be reached.
     *
     * What the collapse did NOT break, contrary to the row that opened this:
     * retry. `codex-rs/codex-client/src/retry.rs::RetryOn::should_retry` retries
     * on 429 and on `status.is_server_error()`, and 502 IS a server error — so
     * the ladder ran either way. The damage is the CLASSIFICATION, and the
     * user-visible wording that follows from it.
     */
    const status = upstream.status >= 400 && upstream.status <= 599 ? upstream.status : 502;
    sendJson(res, status, openAiError(`Nessy Gateway error ${upstream.status}: ${text.slice(0, 500)}`, 'api_error', String(upstream.status)));
    return;
  }

  if (!chat.stream) {
    const json = (await upstream.json().catch(() => null)) as ChatJson | null;
    if (!json) {
      sendJson(res, 502, openAiError('Nessy Gateway returned a non-JSON body', 'api_error'));
      return;
    }
    finished = true;
    sendJson(res, 200, toResponsesResponse(json, { model: chat.model, responseId, toolNamespaces }));
    return;
  }

  // Streaming.
  if (!upstream.body) {
    sendJson(res, 502, openAiError('Nessy Gateway returned no stream body', 'api_error'));
    return;
  }
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  try {
    // Cast bridges the DOM/node ReadableStream generic friction; runtime is a Uint8Array stream.
    const bodyStream = upstream.body as unknown as ReadableStream<Uint8Array>;
    await streamResponsesFromChat(parseChatSse(bodyStream), (frame) => res.write(frame), {
      toolNamespaces,
      model: chat.model,
      responseId,
      heartbeatMs: opts.heartbeatMs,
      stallTimeoutSec: opts.stallTimeoutSec,
      // A stalled turn has already been reported terminally; aborting stops the
      // upstream from draining tokens AND suppresses the catch below (which checks
      // `signal.aborted`) so no second, contradictory error frame goes out.
      onStall: () => controller.abort(),
    });
  } catch (err) {
    if (!controller.signal.aborted) {
      res.write(responsesErrorEvent(`stream error: ${err instanceof Error ? err.message : String(err)}`));
    }
  } finally {
    finished = true;
    res.end();
  }
}

/**
 * The only two `incomplete_details.reason` values the vendored Anthropic translator
 * can name: `outbound.ts` maps them to `stop_reason: "max_tokens"` / `"refusal"`.
 * Every other reason falls through to its `end_turn` default.
 */
const ANTHROPIC_MAPPED_INCOMPLETE_REASONS = new Set(['max_output_tokens', 'content_filter']);

/**
 * Rewrite a `response.incomplete` the Anthropic translator cannot name into the
 * `response.failed` it turns into an `error` event.
 *
 * `upstream_stall_timeout` and `adapter_eof` are truncations, but `outbound.ts:326-333`
 * knows only the two reasons above and defaults everything else to `end_turn` — so a
 * turn the watchdog abandoned after 90 s of silence would reach the SDK as a finished
 * one. Rewriting HERE (this bridge is ours) rather than in the vendored consumer keeps
 * that file re-syncable, and keeps the codex route on `response.incomplete`, which is
 * its native frame for the same condition.
 */
function failUnmappedIncomplete(frame: string): string {
  if (!frame.startsWith('event: response.incomplete\n')) return frame;
  const dataAt = frame.indexOf('data: ');
  if (dataAt === -1) return frame;
  let parsed: { response?: Record<string, unknown> };
  try {
    parsed = JSON.parse(frame.slice(dataAt + 6)) as { response?: Record<string, unknown> };
  } catch {
    return frame;
  }
  const details = parsed.response?.incomplete_details;
  const reason = details && typeof details === 'object' ? (details as { reason?: unknown }).reason : undefined;
  if (typeof reason !== 'string' || ANTHROPIC_MAPPED_INCOMPLETE_REASONS.has(reason)) return frame;
  // Neutral wording: this route also serves BYO endpoints, not just the gateway.
  const error = { status: 502, message: `upstream turn did not complete: ${reason}` };
  return `event: response.failed\ndata: ${JSON.stringify({
    type: 'response.failed',
    response: { ...parsed.response, status: 'failed', error, last_error: error },
  })}\n\n`;
}

/**
 * Serialize the Responses SSE the shared pipeline WRITES into a byte stream the
 * vendored Anthropic translator can READ.
 *
 * `streamResponsesFromChat` pushes complete frames into a callback; the vendored
 * `responsesSseToAnthropicSse` pulls frames off a `ReadableStream`. Bridging by
 * serialize-then-reparse costs one extra JSON round-trip per frame and leaves the
 * logic of BOTH modules untouched — the vendored file keeps its upstream's behaviour
 * (so it can be re-synced), and the codex path keeps the exact emitter it was
 * validated against in Phase 1.
 *
 * It is also the ONE place a frame may be rewritten for the Anthropic consumer's
 * benefit (see `failUnmappedIncomplete`); the codex route sees the emitter's frames
 * verbatim.
 */
function responsesSseStream(
  chunks: AsyncIterable<ChatChunk>,
  opts: StreamResponsesOptions,
  isAborted: () => boolean,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      // Detached on purpose: enqueues are consumed by the translator's reader as
      // they are produced, exactly like the /responses route writes them to the
      // socket as they are produced.
      void (async () => {
        const enqueue = (frame: string) => {
          try {
            controller.enqueue(encoder.encode(failUnmappedIncomplete(frame)));
          } catch {
            // Consumer went away and tore the controller down; the read loop is ending.
          }
        };
        try {
          await streamResponsesFromChat(chunks, enqueue, opts);
        } catch (err) {
          // Hand the translator a terminal `response.failed`, which it maps to an
          // Anthropic `error` event — a mid-stream upstream failure must reach the
          // client as an error, not as a silently truncated turn.
          if (!isAborted()) {
            const message = err instanceof Error ? err.message : String(err);
            enqueue(`event: response.failed\ndata: ${JSON.stringify({
              type: 'response.failed',
              response: { error: { status: 502, message: `upstream stream error: ${message}` } },
            })}\n\n`);
          }
        } finally {
          try {
            controller.close();
          } catch {
            // Already closed or cancelled.
          }
        }
      })();
    },
  });
}

/**
 * Forward an Anthropic Messages turn to an upstream that speaks it natively and
 * return its answer verbatim.
 *
 * Nothing here understands the protocol, and that is the point: the SDK
 * negotiated the body and the version, and the upstream answers in the same
 * dialect, so every byte we reshape is a byte we can get wrong. Status,
 * content-type and body all pass straight through — a `text/event-stream`
 * response streams because it is piped, not because anything re-encodes it.
 *
 * Errors stay Anthropic-shaped, since the SDK is the only client of this route.
 *
 * ONE exception to "nothing here understands the protocol", and it is reactive:
 * when the upstream answers 400 and NAMES a beta-gated field the client added
 * (today only `context_management`), that field is dropped and the turn is
 * retried once — see `./anthropic/passthrough-negotiation.ts` for why removal
 * waits for a refusal instead of happening up front.
 */
/**
 * Name the field the passthrough just took off the wire — never the value.
 *
 * Shares `NESSY_PROXY_AUTH_DEBUG=1` with the auth-scheme line for the same
 * reason it exists: one flag should light the whole "what did we actually send"
 * picture, and two switches for two halves of one question is how one of them
 * ends up permanently off.
 */
function logFieldNegotiation(
  upstream: string,
  dropped: readonly string[],
  sink?: (info: { upstream: string; dropped: readonly string[] }) => void,
): void {
  if (sink) { sink({ upstream, dropped }); return; }
  if (typeof process === 'undefined' || process.env?.NESSY_PROXY_AUTH_DEBUG !== '1') return;
  process.stderr.write(`[codex-adapter] upstream refused ${dropped.join(', ')}; retrying without it\n`);
}

async function pipeAnthropicPassthrough(
  req: IncomingMessage,
  res: ServerResponse,
  body: unknown,
  upstream: Extract<UpstreamTarget, { kind: 'anthropic-messages' }>,
  opts: AdapterOptions,
  refusals: UpstreamFieldRefusals,
): Promise<void> {
  const controller = new AbortController();
  let finished = false;
  const onClose = () => { if (!finished) controller.abort(); };
  res.on('close', onClose);
  req.on('close', onClose);

  // P3.363 · the PASSTHROUGH arm, and the one that most needs saying: this body
  // is never translated, so nothing else in this file has looked at its tools.
  // Read from the inbound Anthropic shape (`tools[].name`) before the body is
  // piped, and before `withoutFields` may drop anything.
  noteOutboundTools(opts, {
    upstream: upstream.kind,
    model: typeof (body as { model?: unknown })?.model === 'string' ? (body as { model: string }).model : '',
    toolNames: Array.isArray((body as { tools?: unknown })?.tools)
      ? ((body as { tools: unknown[] }).tools)
        .map(tool => (tool as { name?: unknown })?.name)
        .filter((name): name is string => typeof name === 'string' && name.length > 0)
      : [],
  });

  const inboundBeta = typeof req.headers['anthropic-beta'] === 'string'
    ? req.headers['anthropic-beta']
    : undefined;
  // A dropped field takes its beta with it — see `withoutBetaFor`. The two are
  // one decision in the client's own code and must stay one here.
  const post = (payload: unknown, dropped: readonly string[]): Promise<Response> => postAnthropicMessages(payload, {
    upstream,
    anthropicVersion: typeof req.headers['anthropic-version'] === 'string'
      ? req.headers['anthropic-version']
      : undefined,
    anthropicBeta: withoutBetaFor(inboundBeta, dropped),
    signal: controller.signal,
    fetchImpl: opts.fetchImpl,
  });

  // Fields this upstream refused earlier in the session are omitted up front, so
  // only the first turn pays the extra round trip.
  let dropped = refusals.known(upstream.baseUrl);
  let sent = withoutFields(body, dropped);

  let upstreamRes: Response;
  try {
    upstreamRes = await post(sent, dropped);
  } catch (err) {
    if (controller.signal.aborted) return; // client gone
    finished = true;
    sendJson(res, 502, anthropicErrorBody(502, `upstream request failed: ${err instanceof Error ? err.message : String(err)}`));
    return;
  }

  if (upstreamRes.status === 400) {
    // A 400 means the upstream processed nothing, so reading the body here costs
    // no stream and retrying cannot double-apply anything.
    const errorText = await upstreamRes.text().catch(() => '');
    // Same check every other await in this function makes: the client may have
    // hung up while the error body was being read, and writing to a closed
    // response is the one thing a failure path must not turn into a second one.
    if (controller.signal.aborted) return;
    const refused = findRefusedRemovableFields(sent, errorText);
    if (refused.length === 0) {
      // Not ours to fix: hand back the upstream's own bytes, unchanged.
      finished = true;
      res.writeHead(400, { 'content-type': upstreamRes.headers.get('content-type') ?? 'application/json' });
      res.end(errorText);
      return;
    }
    refusals.remember(upstream.baseUrl, refused);
    dropped = [...dropped, ...refused];
    sent = withoutFields(sent, refused);
    logFieldNegotiation(upstream.baseUrl, refused, opts.onFieldNegotiation);
    try {
      upstreamRes = await post(sent, dropped);
    } catch (err) {
      if (controller.signal.aborted) return; // client gone
      finished = true;
      sendJson(res, 502, anthropicErrorBody(502, `upstream request failed after dropping ${refused.join(', ')}: ${err instanceof Error ? err.message : String(err)}`));
      return;
    }
  }

  res.writeHead(upstreamRes.status, {
    'content-type': upstreamRes.headers.get('content-type') ?? 'application/json',
    // The SDK reads this stream incrementally; a proxy buffering it would turn
    // a streamed turn into a single late blob.
    ...(upstreamRes.headers.get('content-type')?.includes('event-stream')
      ? { 'cache-control': 'no-cache', connection: 'keep-alive' }
      : {}),
  });

  if (!upstreamRes.body) {
    finished = true;
    res.end(await upstreamRes.text().catch(() => ''));
    return;
  }

  // P6.58 — NO idle abort here, and that is deliberate rather than an omission.
  //
  // A `read()` on an upstream that goes silent without closing never settles, so
  // this loop cannot end itself.
  //
  // THIS COMMENT SAID THE ARMING CONDITION BACKWARDS until P6.115: the sentence
  // it replaced named a NON-first-party base URL as the arming condition and
  // called this loopback one, inverting the predicate the binary actually has:
  //
  //   function a0a(e){if(!Y1p())return!1;return q1p(e)&&q1p(Jn())}
  //   function q1p(e){return s0a(e)||e==="bedrock"&&J1p()}
  //   function s0a(e){return e==="firstParty"&&Mf()||e==="anthropicAws"&&!process.env.ANTHROPIC_AWS_BASE_URL}
  //   function Mf(){if(V._CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL)return!0;return Mit()}
  //   function Mit(){let e=process.env.ANTHROPIC_BASE_URL;if(!e)return!0;return Vxe(e)}
  //   function Vxe(e){try{let t=new URL(e).host;return["api.anthropic.com"].includes(t)}catch{return!1}}
  //
  // The watchdog arms for a base URL that IS `api.anthropic.com`. This loopback
  // never is, so it is OFF here — and `CLAUDE_ENABLE_BYTE_WATCHDOG=1` cannot turn
  // it on, it only forces the gate above a test that still fails. The minified
  // names are not the pin: `B6b` and `F6b`, which this comment used to cite,
  // scored zero in the vendored 2.1.233 — and at the vendored 2.1.247 they score
  // 4/4 and 12/12 (lines/occurrences, re-measured 2026-09-12, C3.252/C3.294)
  // WITHOUT having come back: read at their offsets, every hit is noise inside a
  // minified export-alias table or a base64 CA certificate. A three-character
  // minified needle cannot be counted raw in either direction, which is the
  // whole reason this comment stopped citing them.
  //
  // WHAT ACTUALLY ENDS A STALLED TURN HERE, measured with a real run (P6.114):
  // about nine minutes — 544 907 ms — with `API Error: The operation timed out.`
  // Neither `API_TIMEOUT_MS` nor `API_FORCE_IDLE_TIMEOUT` shortens it on this
  // route, though `API_TIMEOUT_MS` does bound the phase before headers. So the
  // relay is still left without an idle abort of its own, but for a STATED BOUND
  // rather than for a watchdog that was never armed — native-first still holds,
  // because the surviving native mechanism is a transport timeout, which is
  // configuration rather than construction.
  //
  // THE RESIDUE IS CLOSED — C4.10 (owner answer QF3 = B, 2026-09-11). The
  // paragraph above stands as the reading: the SDK's byte watchdog is not armed
  // on this route and the only surviving bound is its ~9-minute transport
  // timeout. The owner took the wiring, so the relay now runs under the HOST's
  // own idle abort when the host injects it
  // ({@link AdapterOptions.readWithIdleTimeout} — injected, not imported,
  // because this package is the dependency leaf), and a trip is announced as an
  // Anthropic `error` event instead of as silence.
  const reader = (upstreamRes.body as unknown as ReadableStream<Uint8Array>).getReader();
  const isEventStream = (upstreamRes.headers.get('content-type') ?? '').includes('event-stream');
  const relay = opts.readWithIdleTimeout?.(reader) ?? readWithoutDeadline(reader);
  try {
    for await (const value of relay) res.write(Buffer.from(value));
  } catch (err) {
    // TWO failures reach here and they are not the same event.
    //
    // An upstream that broke on its own leaves a truncated stream, which is the
    // honest outcome — there is no terminal frame we could invent that would not
    // be a lie about what the model said.
    //
    // An idle abort is OUR action, so naming it is not an invention but a
    // report: we stopped reading, and the client would otherwise see the same
    // silence it has been seeing. `timeout_error` is the documented Anthropic
    // taxonomy for 504 (`anthropicErrorType`), and the message is the host's own
    // — `stream idle: no bytes for <n>ms`.
    //
    // Only on an event-stream: a non-SSE body has no frame to carry an error,
    // and the client is reading JSON that will simply be short.
    if (isEventStream && isHostStreamIdleTimeout(err)) {
      const body = anthropicErrorBody(504, err instanceof Error ? err.message : 'stream idle');
      res.write(`event: error\ndata: ${JSON.stringify(body)}\n\n`);
    }
  } finally {
    finished = true;
    res.end();
  }
}

/**
 * `POST /v1/messages` — the Anthropic Messages protocol, served off the same
 * pipeline as `/v1/responses`: inbound Anthropic → Responses body → chat request →
 * upstream → Responses events → outbound Anthropic SSE/JSON.
 *
 * Errors are Anthropic-shaped throughout (`anthropicErrorBody`), and upstream error
 * text is worded neutrally — this route serves BYO endpoints as well as the gateway.
 */
/**
 * P6.462 · the two headers that say WHICH agent inside the session made this
 * request, carried from the child's loopback call onto the upstream one.
 *
 * MEASURED, because "a string in a binary is not a wire": the vendored native
 * binary (`claude-cli/2.1.233`, agent-sdk 0.3.260) pointed at a recording
 * Anthropic-Messages server, 2026-09-06 — a subagent's request carried
 * `x-claude-code-agent-id`, a subagent spawned BY that subagent carried its own
 * plus `x-claude-code-parent-agent-id` naming the first, and every main-thread
 * turn carried neither. So the child honours the page's "present only on
 * requests from an agent Claude Code spawned inside the session", and until this
 * row we dropped both on the floor: no request was attributable below session
 * level even though the producer was already there.
 *
 * ## Why this carries the ids and does not decide anything about them
 *
 * This package is the dependency ROOT of the pair and cannot import
 * `@nessy-agent/shared`, so it cannot know which URLs may receive a correlation
 * id. `gatewaySessionFetch` — the `fetchImpl` both product call sites install —
 * owns that rule already: it RENAMES each to its Nessy spelling on the verified
 * gateway prefix and DELETES both on every other URL. Carrying them here keeps
 * one audience rule in one place instead of a second copy in this package.
 *
 * Applied on `/v1/messages` only, and to BOTH of its arms — the passthrough and
 * the translated one — because the claude runtime uses the translated arm
 * against the OpenAI-wire gateway, which is precisely the upstream that wants
 * the attribution.
 */
const INBOUND_AGENT_ATTRIBUTION_HEADERS = ['x-claude-code-agent-id', 'x-claude-code-parent-agent-id'] as const;

function withInboundAgentAttribution(
  inner: typeof fetch | undefined,
  inbound: IncomingMessage['headers'],
): typeof fetch | undefined {
  const carried: Array<[string, string]> = [];
  for (const name of INBOUND_AGENT_ATTRIBUTION_HEADERS) {
    const value = inbound[name];
    if (typeof value === 'string' && value.trim()) carried.push([name, value.trim()]);
  }
  // No attribution on this request — a main-thread turn — so the caller keeps
  // the exact `fetchImpl` it had, wrapper and all.
  if (carried.length === 0) return inner;
  const base = inner ?? fetch;
  return ((input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    for (const [name, value] of carried) headers.set(name, value);
    return base(input, { ...init, headers });
  }) as typeof fetch;
}

async function handleMessages(
  req: IncomingMessage,
  res: ServerResponse,
  baseOpts: AdapterOptions,
  refusals: UpstreamFieldRefusals,
): Promise<void> {
  const opts: AdapterOptions = {
    ...baseOpts,
    fetchImpl: withInboundAgentAttribution(baseOpts.fetchImpl, req.headers),
  };
  const upstreamTarget = opts.upstream ?? DEFAULT_UPSTREAM;
  const gate = resolveGatewayJwt(upstreamTarget, opts);
  if (!gate.ok) {
    // Only reachable in gateway mode, so naming the gateway here is accurate.
    // The Anthropic error envelope carries `type` + `message` and no `code`
    // field at all (`anthropic/outbound.ts` symbol `anthropicErrorBody`), so on
    // THIS route the distinction between the two refusals is carried by the
    // sentence and by nothing else.
    sendJson(res, 401, anthropicErrorBody(401, credentialRefusalMessage(gate.reason)));
    return;
  }

  let raw: unknown;
  try {
    raw = JSON.parse(await readBody(req));
  } catch {
    sendJson(res, 400, anthropicErrorBody(400, 'invalid JSON request body'));
    return;
  }

  /**
   * PASSTHROUGH (G3). Decided BEFORE translation, because for these models
   * translation is the bug: llm-proxy serves `anthropic/*` on `/v1/messages`
   * only and answers `400 unsupported endpoint` on chat-completions. The
   * inbound body is already exactly what the upstream wants, so it goes up
   * untouched and its response comes back untouched — SSE included, by piping.
   */
  const requestedModel = typeof (raw as { model?: unknown })?.model === 'string'
    ? (raw as { model: string }).model
    : '';
  const perModel = requestedModel ? opts.upstreamForModel?.(requestedModel) : undefined;
  if (perModel?.kind === 'anthropic-messages') {
    await pipeAnthropicPassthrough(req, res, raw, perModel, opts, refusals);
    return;
  }

  let responsesBody: Record<string, unknown>;
  try {
    responsesBody = anthropicToResponsesTranslation(raw).body;
  } catch (err) {
    if (!(err instanceof AnthropicRequestError)) throw err; // unexpected → the route's 500
    sendJson(res, 400, anthropicErrorBody(400, err.message));
    return;
  }

  const chat = toChatRequest(responsesBody, opts.generationDefaultsForModel);
  // P3.363 · the translated Anthropic arm.
  noteOutboundTools(opts, {
    upstream: upstreamTarget.kind,
    model: chat.model,
    toolNames: (chat.tools ?? []).map(tool => tool.function.name).filter(Boolean),
  });
  const model = chat.model;
  const responseId = `resp_${randomUUID()}`;
  // No `toolNamespaces`: the Anthropic tool schema has no namespace concept, so the
  // inbound translation never emits a `namespace`-type tool for one to be read from.

  // Thread client disconnect → upstream abort (same shape as handleResponses).
  const controller = new AbortController();
  let finished = false;
  /**
   * The abort was the CLIENT going away, as opposed to our own stall watchdog
   * aborting the upstream. The two must not be conflated: the watchdog aborts only
   * AFTER it has written the turn's terminal frames, so a loop that stopped
   * forwarding on `signal.aborted` alone would swallow exactly those frames and hand
   * the SDK a stream with no terminator at all.
   */
  let clientGone = false;
  const onClose = () => {
    if (finished) return;
    clientGone = true;
    controller.abort();
  };
  res.on('close', onClose);
  req.on('close', onClose);

  let outcome;
  try {
    outcome = await sendWithRetry(chat, { jwt: gate.jwt, upstream: upstreamTarget, signal: controller.signal, fetchImpl: opts.fetchImpl, onUpstreamAuth: opts.onUpstreamAuth });
  } catch (err) {
    if (controller.signal.aborted) return; // client gone
    sendJson(res, 502, anthropicErrorBody(502, `upstream request failed: ${err instanceof Error ? err.message : String(err)}`));
    return;
  }
  opts.onRetryRung?.(outcome.rung);
  const upstream = outcome.response;

  if (!upstream.ok) {
    const text = await upstream.text().catch(() => '');
    // The upstream status passes THROUGH. Anthropic clients key retry/backoff
    // off the status — 429 and 529 are retryable, 502 is not — so collapsing
    // would disable it. The `/responses` route collapsed it to 400/401/502
    // until P3.334; both arms now apply the same rule, for reasons recorded at
    // that site.
    const status = upstream.status >= 400 && upstream.status <= 599 ? upstream.status : 502;
    // F1.1089 — EXCEPT a quota refusal, which will not succeed on any retry.
    // Measured 2026-10-11 on the shipped binary (0.3.280, work/l5e/
    // claude-retry-probe.ts): a 429 with no `x-should-retry` header was
    // attempted 8 times (exponential backoff, 837→33961 ms) before "no more
    // retries left"; the SAME 429 with `x-should-retry: false` got ONE attempt
    // and surfaced the quota error in 602 ms. The header travels only when the
    // upstream body is quota-shaped — a plain rate limit keeps the retryable
    // headerless 429 the passthrough above is for.
    const quotaHeaders = status === 429 && QUOTA_REFUSAL_PATTERN.test(text)
      ? { 'x-should-retry': 'false' }
      : undefined;
    sendJson(res, status, anthropicErrorBody(status, `upstream error ${upstream.status}: ${text.slice(0, 500)}`), quotaHeaders);
    return;
  }

  if (!chat.stream) {
    const json = (await upstream.json().catch(() => null)) as ChatJson | null;
    if (!json) {
      sendJson(res, 502, anthropicErrorBody(502, 'upstream returned a non-JSON body'));
      return;
    }
    finished = true;
    // P3.98 + P3.122 — hand the completed call up before answering. The counts
    // come from the upstream's own `usage`, mapped by the same `mapUsage` the
    // response body uses, so the number an operator reads and the number the
    // client is told are the same number. Never able to fail the request.
    if (opts.onUpstreamCall) {
      try {
        const counts = mapUsage(json.usage);
        opts.onUpstreamCall({
          system: (raw as { system?: unknown } | null)?.system,
          model,
          inputTokens: counts.input_tokens,
          outputTokens: counts.output_tokens,
        });
      } catch { /* telemetry is best-effort and must not affect the turn */ }
    }
    sendJson(res, 200, responsesJsonToAnthropicMessage(toResponsesResponse(json, { model, responseId }), model));
    return;
  }

  // Streaming.
  if (!upstream.body) {
    sendJson(res, 502, anthropicErrorBody(502, 'upstream returned no stream body'));
    return;
  }
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  // Cast bridges the DOM/node ReadableStream generic friction; runtime is a Uint8Array stream.
  const bodyStream = upstream.body as unknown as ReadableStream<Uint8Array>;
  const anthropicStream = responsesSseToAnthropicSse(
    // `truncationFrame: 'incomplete'` is what turns an upstream
    // `finish_reason: "length"` into `stop_reason: "max_tokens"`. Opt-in: the
    // codex route keeps the default `'completed'`.
    responsesSseStream(parseChatSse(bodyStream), {
      model,
      responseId,
      truncationFrame: 'incomplete',
      heartbeatMs: opts.heartbeatMs,
      stallTimeoutSec: opts.stallTimeoutSec,
      onStall: () => controller.abort(),
    }, () => controller.signal.aborted),
    model,
  );
  const reader = anthropicStream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done || clientGone) break;
      res.write(value);
    }
  } catch (err) {
    if (!clientGone) {
      const body = anthropicErrorBody(500, `stream error: ${err instanceof Error ? err.message : String(err)}`);
      res.write(`event: error\ndata: ${JSON.stringify(body)}\n\n`);
    }
  } finally {
    finished = true;
    void reader.cancel().catch(() => {});
    res.end();
  }
}

/** Start the adapter on an ephemeral 127.0.0.1 port. */
export function startAdapter(options: AdapterOptions = {}): Promise<AdapterHandle> {
  // One per adapter, i.e. one per session: what THIS upstream refused, learned
  // from its own 400s. Deliberately not module-scoped — see the class's doc.
  const refusals = new UpstreamFieldRefusals();
  const server: Server = createServer((req, res) => {
    const path = (req.url ?? '').replace(/\?.*$/, '');
    // UA12.172 — only this adapter's own loopback clients, before any route: see {@link foreignRequestRefusal}.
    const refusal = foreignRequestRefusal(req, (server.address() as AddressInfo | null)?.port);
    if (refusal !== undefined) {
      sendJson(res, 403, path.endsWith('/messages') ? anthropicErrorBody(403, refusal, 'permission_error') : openAiError(refusal, 'permission_error'));
      return;
    }
    /** Last-resort 500 in the route's own error envelope. */
    const guard = (shape: (message: string) => unknown) => (err: unknown) => {
      if (!res.headersSent) {
        sendJson(res, 500, shape(`adapter error: ${err instanceof Error ? err.message : String(err)}`));
      } else {
        res.end();
      }
    };
    if (req.method === 'POST' && path.endsWith('/responses')) {
      void handleResponses(req, res, options).catch(guard((m) => openAiError(m, 'api_error')));
      return;
    }
    // The Claude Agent SDK posts to `/v1/messages?beta=true`; the query is already
    // stripped above, so the match is on path exactly as the gateway protocol
    // documents it.
    if (req.method === 'POST' && path.endsWith('/messages')) {
      void handleMessages(req, res, options, refusals).catch(guard((m) => anthropicErrorBody(500, m)));
      return;
    }
    // `GET /v1/models` is deliberately unserved, and this branch exists so the
    // refusal carries its reason instead of the catch-all's `not found`.
    // Status is 404 either way — no client sees a different outcome, and the
    // client that would ask (codex) does not ask at all. The four measurements
    // behind the decision, and the three costs opening it would incur, are on
    // `MODELS_NOT_SERVED` above.
    if (req.method === 'GET' && path.endsWith('/models')) {
      sendJson(res, 404, openAiError(MODELS_NOT_SERVED, 'invalid_request_error'));
      return;
    }
    // `/v1/messages/count_tokens` is deliberately unimplemented: a 404 is the
    // documented graceful fallback — Claude Code then estimates context usage
    // locally. Shaped as an Anthropic error so the SDK's parser recognizes it.
    if (path.endsWith('/messages/count_tokens')) {
      sendJson(res, 404, anthropicErrorBody(404, 'count_tokens is not implemented; the client estimates context usage locally'));
      return;
    }
    sendJson(res, 404, openAiError(`not found: ${req.method} ${path}`, 'invalid_request_error'));
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        port,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

/**
 * UA12.172 (DECISIONS-1.42.0.md #20, option (b)) — why a request is NOT from this adapter's own loopback clients, or
 * `undefined` when it is. The adapter spends the user's gateway access for whoever reaches its ephemeral port, and a
 * browser page that learns the port can reach it by DNS rebinding (its own hostname resolved to 127.0.0.1, so the
 * request's `Host` is that hostname) or by a CORS-simple cross-origin POST (`text/plain`, no preflight, an `Origin`
 * header). So a request is refused (403) when it carries ANY `Origin`, or when its `Host` is not exactly
 * `127.0.0.1:<this port>` — the only spelling both clients are given (`config-writer.ts` `base_url`, `claude-agent.ts`
 * `ANTHROPIC_BASE_URL`). Measured 2026-10-09 against a recording server in the adapter's place: the shipped
 * `codex-app-server` 0.159.3 and the bundled Claude Code 2.1.274 each sent `Host: 127.0.0.1:<port>` and no `Origin`.
 *
 * Not taken, stated: a per-adapter bearer (option (a)) — it needs plumbing through both runtimes, and a same-user process
 * can read the gateway credential file anyway; this check is about browsers, not local processes.
 */
function foreignRequestRefusal(req: IncomingMessage, port: number | undefined): string | undefined {
  if (req.headers.origin !== undefined) {
    return 'refused: the local model adapter does not serve requests that carry an Origin header (a browser page)';
  }
  if (port === undefined || req.headers.host !== `127.0.0.1:${port}`) {
    return `refused: the local model adapter serves only Host 127.0.0.1:${port ?? '<port>'}`;
  }
  return undefined;
}
