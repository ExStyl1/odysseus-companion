/**
 * What the Anthropic passthrough may take OFF the wire — and only after the
 * upstream itself has refused it by name.
 *
 * ## The measurement this exists for
 *
 * The shipped Claude CLI (`@anthropic-ai/claude-agent-sdk-darwin-arm64` 0.3.218)
 * puts a BETA-GATED field on every thinking turn:
 *
 *     context_management: { edits: [ { type: "clear_thinking_20251015", keep: "all" } ] }
 *
 * and declares it in the request's `anthropic-beta` header alongside eight other
 * betas. Its emitter is `hasThinking`-gated (`if(t)return{edits:[{type:
 * "clear_thinking_20251015",keep:"all"}]}`) and the body spread is
 * `...at && re && Nn.includes(F0t) && {context_management:at}`, where `F0t` is
 * `Tw("context_management","context-management-2025-06-27")` — i.e. the field
 * rides with its beta or not at all.
 *
 * An upstream that does not implement that beta answers `400 … Extra inputs are
 * not permitted`, and the whole turn dies before the model sees it.
 *
 * ## Why the removal is REACTIVE and not a blanket strip
 *
 * `pipeAnthropicPassthrough`'s own principle is that "every byte we reshape is a
 * byte we can get wrong". Stripping this field unconditionally would silently
 * disable context editing against an upstream that supports it — a real Anthropic
 * endpoint behind a BYO connection — and we would never know, because the
 * degradation is invisible: the turn still succeeds, it just carries thinking
 * blocks forever.
 *
 * So nothing is removed speculatively. A field leaves the body only when
 *
 *   1. the upstream answered **400** (which means it processed nothing, so a
 *      retry cannot double-apply anything), and
 *   2. the error text **names the field**, and
 *   3. the field is on the short list below — optional, beta-gated, and losing
 *      it costs an optimization rather than the turn's meaning.
 *
 * The refusal is then remembered per upstream URL for the life of the adapter,
 * so only the first turn of a session pays the extra round trip.
 */

/**
 * Top-level Messages fields the passthrough is allowed to drop after a refusal.
 *
 * Deliberately tiny, and each entry has to answer two questions: is it BETA-GATED
 * (so an upstream that has not opted in is right to reject it), and does the turn
 * still MEAN the same thing without it?
 *
 * - `context_management` — beta `context-management-2025-06-27`. Without it the
 *   CLI keeps thinking blocks in the transcript instead of clearing them; the
 *   conversation is identical, the context is larger.
 *
 * `messages`, `system`, `tools`, `model`, `max_tokens`, `thinking`, `metadata`,
 * `stream` and friends are NOT candidates and never will be: an upstream naming
 * one of those is describing a request we must not silently rewrite.
 *
 * ## DA2.3 - the NAMED policy exception, and it is a REFUSAL
 *
 * `tools` is on that never-list for an UPSTREAM-REFUSAL reason. DA2.3 asked
 * whether it should also come off for a POLICY reason - dropping
 * non-whitelisted `mcp__*` tools from the outbound body when the model target
 * is an external vendor. The answer is no on this route, and the note lives
 * here because this is the doctrine a future lane will read before touching
 * `tools`:
 *
 * 1. **The page forbids it on this arm.**
 *    `llm-gateway-protocol.md#feature-pass-through`: "A gateway that rewrites
 *    or redacts request bodies for content inspection breaks the pairing the
 *    same way stripping does, so inspect without modifying."
 *    `llm-gateway-protocol.md#forward-as-open-lists` conditions its rule on an
 *    Anthropic-format upstream and grants one exception - "a non-Anthropic
 *    upstream such as Amazon Bedrock or Google Cloud's Agent Platform, where
 *    bridging the schema difference is the gateway's job" - which is the
 *    TRANSLATED arm, where the body is rewritten anyway. This file serves the
 *    UNTRANSLATED passthrough, which is the arm both sentences are literally
 *    about. (Both quoted verbatim off the page on 2026-09-14.)
 * 2. **On the two arms the page would permit, the filter would be redundant.**
 *    Every `mcp__*` tool in an outbound body is there because the HOST
 *    configured that server for the child - `claude-agent.ts` symbol
 *    `createSourceProxyServers` builds the SDK's server map from the leased
 *    slugs of `McpClientPool`, and codex's `[mcp_servers.sources]` block is
 *    that same pool on loopback. The host's own tool set is strictly UPSTREAM
 *    of this package on every arm, so a filter here would be a second mechanism
 *    for a job the pool already does.
 * 3. **The one residue is routed elsewhere, deliberately.** `mcp__session__*`
 *    is not pool-served, so it is the only family a wire filter could reach
 *    that the pool cannot. The plan decides its narrowing with ODR-1 and
 *    DA2.4, not here.
 *
 * So this package keeps OBSERVING (`AdapterOptions.onOutboundTools`) and
 * withholds nothing, and `tools` stays on the never-list for both reasons.
 */
export const REMOVABLE_BETA_FIELDS: Readonly<Record<string, string>> = Object.freeze({
  context_management: 'context-management-2025-06-27',
});

/**
 * The parts of an error body that DESCRIBE the error, as opposed to echoing the
 * request that caused it.
 *
 * A plain `errorText.includes(field)` is wrong in a way that is easy to miss and
 * was caught by probe rather than by reasoning: an upstream that answers
 * `400 max_tokens must be > 0` while ECHOING the offending request body contains
 * the string `context_management` too, so the naive match drops a field the
 * upstream never complained about — and remembers the refusal for the rest of
 * the session, silently costing the user context editing against an endpoint
 * that supports it.
 *
 * So when the body parses as JSON, only error-DESCRIBING positions are searched:
 * FastAPI/pydantic's `detail[].loc` (llm-proxy's shape — its message is
 * "Extra inputs are not permitted" with `loc: ["body", "<field>"]`) and the
 * message strings of both that shape and Anthropic's own
 * `{error:{type,message}}`. Pydantic's `input` echo, which carries the whole
 * rejected value, is deliberately NOT searched.
 *
 * A body that is not JSON falls back to the whole text: a plain-text 400 has no
 * structure to be precise about, and refusing to act on it would leave the
 * common case unhandled to avoid an uncommon one.
 */
function errorMentions(errorText: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(errorText);
  } catch {
    return errorText;
  }
  const mentions: string[] = [];
  const visitMessage = (value: unknown): void => {
    if (typeof value === 'string') mentions.push(value);
  };
  const visitEntry = (entry: unknown): void => {
    if (typeof entry === 'string') { mentions.push(entry); return; }
    if (typeof entry !== 'object' || entry === null) return;
    const record = entry as Record<string, unknown>;
    if (Array.isArray(record.loc)) mentions.push(...record.loc.map(String));
    visitMessage(record.msg);
    visitMessage(record.message);
  };
  if (typeof parsed === 'object' && parsed !== null) {
    const root = parsed as Record<string, unknown>;
    const detail = root.detail;
    if (Array.isArray(detail)) for (const entry of detail) visitEntry(entry);
    else visitEntry(detail);
    visitEntry(root.error);
    visitMessage(root.message);
  }
  return mentions.join('\n');
}

/**
 * Which removable fields did this upstream just refuse?
 *
 * Returns only names that are BOTH present as a top-level key of the body we
 * actually sent AND named in the error-describing part of the upstream's answer.
 * An upstream that answers a generic "invalid request body" gets nothing
 * removed — we do not guess which field it meant.
 */
export function findRefusedRemovableFields(sentBody: unknown, errorText: string): string[] {
  if (!errorText || typeof sentBody !== 'object' || sentBody === null || Array.isArray(sentBody)) return [];
  const body = sentBody as Record<string, unknown>;
  const mentions = errorMentions(errorText);
  return Object.keys(REMOVABLE_BETA_FIELDS).filter((field) => field in body && mentions.includes(field));
}

/**
 * Drop the beta tokens that authorized `fields` from an `anthropic-beta` header.
 *
 * The field and its beta are ONE decision in the client's own code — the CLI's
 * body spread is `...at && re && Nn.includes(F0t) && {context_management:at}`,
 * where `F0t` pairs the field name with `context-management-2025-06-27`. Having
 * fixed the half where we forwarded the field with its beta deleted, the retry
 * must not create the mirror image: declaring a beta for a field that is no
 * longer in the body is a second request the client never composed, and an
 * upstream that validates unknown betas would reject the retry for a new reason.
 *
 * Every other token is preserved verbatim, including spacing-insensitive
 * matching, because they belong to features we are not touching.
 */
export function withoutBetaFor(header: string | undefined, fields: readonly string[]): string | undefined {
  if (!header || fields.length === 0) return header;
  const drop = new Set(fields.map((field) => REMOVABLE_BETA_FIELDS[field]).filter(Boolean));
  if (drop.size === 0) return header;
  const kept = header.split(',').map((token) => token.trim()).filter((token) => token && !drop.has(token));
  return kept.length > 0 ? kept.join(',') : undefined;
}

/** A copy of `body` without `fields`. Non-object bodies pass through untouched. */
export function withoutFields(body: unknown, fields: readonly string[]): unknown {
  if (fields.length === 0) return body;
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return body;
  const next: Record<string, unknown> = { ...(body as Record<string, unknown>) };
  for (const field of fields) delete next[field];
  return next;
}

/**
 * Per-adapter memory of which fields an upstream URL has refused.
 *
 * Scoped to one adapter instance (one session) rather than to the module: a
 * process-wide cache would let one session's upstream teach another session's
 * upstream a lesson it never gave, and the saving — one round trip per session —
 * is not worth that.
 */
export class UpstreamFieldRefusals {
  private readonly byUpstream = new Map<string, Set<string>>();

  /** Fields to omit up front, because this upstream already refused them. */
  known(upstreamUrl: string): string[] {
    const set = this.byUpstream.get(upstreamUrl);
    return set ? [...set] : [];
  }

  remember(upstreamUrl: string, fields: readonly string[]): void {
    if (fields.length === 0) return;
    let set = this.byUpstream.get(upstreamUrl);
    if (!set) {
      set = new Set<string>();
      this.byUpstream.set(upstreamUrl, set);
    }
    for (const field of fields) set.add(field);
  }
}
