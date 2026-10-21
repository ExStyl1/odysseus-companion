/**
 * The one key three telemetry streams answer to, and the three values that say
 * which stream you are looking at.
 *
 * ## Why a key at all
 *
 * This fork emits audit telemetry from three places that share no vocabulary:
 *
 * | stream | names | count |
 * | --- | --- | --- |
 * | host, Pi sessions (`server-core/pi-harness/otlp-telemetry.ts`) | `session.started`, `session.settled`, `permission.decided`, `tool.completed` | 4 |
 * | claude SDK child, once configured (P2.423) | `claude_code.*` | 25 |
 * | codex app-server child, once configured (P2.450) | `codex.*` | 14 |
 *
 * **No name appears in two of them.** So a SIEM query written against any one
 * returns silence for the other two, and a silence that cannot explain itself is
 * worse than an absent stream — it reads as "nothing happened". Each stream
 * therefore stamps its own coverage on its OTLP RESOURCE, under this one key, so
 * that one query answers "what am I NOT seeing" for every runtime.
 *
 * Neither OTel nor `monitoring-usage.md` specifies such a key; it is chosen under
 * AGENTS.md's transparent-and-simple rule and pinned by each stream's own tests.
 *
 * ## Why this module exists
 *
 * The key was written as a private literal in `claude-agent.ts`, and codex needed
 * the same one. A second literal is how two values that must be identical stop
 * being identical, so the two runtimes this repo owns now read one declaration.
 * Pi's copy still lives in `server-core` — outside this package — which is the
 * remaining seam, and it is named here rather than left to be discovered.
 */

/**
 * The resource-attribute key every Nessy telemetry stream stamps its coverage
 * under. Changing it silently splits the three streams apart, which is the exact
 * failure the key exists to prevent — change `server-core`'s copy in the same
 * commit or not at all.
 */
export const NESSY_TELEMETRY_COVERAGE_KEY = 'nessy.telemetry.coverage';

/** The claude SDK child's own event stream — 25 `claude_code.*` names. */
export const CLAUDE_SDK_TELEMETRY_COVERAGE = 'claude-sdk-events-only';

/**
 * The codex app-server child's own event stream — the fourteen `codex.*` names
 * emitted by `otel/src/events/session_telemetry.rs` at `rust-v0.150.1`:
 * `codex.api_request`, `codex.auth_recovery`, `codex.conversation_starts`,
 * `codex.plugin_install_elicitation_sent`, `codex.plugin_install_suggestion`,
 * `codex.sandbox_outcome`, `codex.sse_event`, `codex.startup_phase`,
 * `codex.tool_decision`, `codex.turn_cost`, `codex.turn_ttft`,
 * `codex.user_prompt`, `codex.websocket_connect`, `codex.websocket_request`.
 *
 * The membership MOVED under the P7.2 lift even though the count did not, which
 * is the reason it is re-derived here rather than re-stamped. `codex.turn_cost`
 * is new (upstream #40488, "Export turn cost as an OTEL metric").
 * `codex.tool_result` left this file — it is emitted from the sibling
 * `otel/src/tool_result.rs` now (`emit_tool_result`), so it is still on the
 * child's stream and still covered by this marker; only the file that names it
 * changed. A count alone would have reported no drift at all.
 *
 * `codex.usage.*` is deliberately NOT in the list at either tag: it is a span
 * ATTRIBUTE recorded on `handle_responses_span`, not an event name, and a
 * `grep` for `codex\.` that does not make that distinction reports fifteen.
 */
export const CODEX_TELEMETRY_COVERAGE = 'codex-events-only';

/**
 * Whether `raw` already declares `key`, in the documented
 * `key1=value1,key2=value2` form. Presence only — the operator's value is never
 * read, parsed or reported, because a resource-attribute string is somewhere an
 * operator may have put a team, an account or a token.
 */
export function hasResourceAttribute(raw: string, key: string): boolean {
  return raw
    .split(',')
    .some(pair => pair.slice(0, pair.indexOf('=')).trim() === key);
}

/**
 * `existing` with this stream's coverage appended, or `undefined` when it must
 * not be touched.
 *
 * Two restraints, and both are the point rather than politeness:
 *
 * - **Never over an operator's own value for the key.** If they have already
 *   declared their coverage they outrank us; we are describing their pipeline,
 *   not owning it.
 * - A trailing comma in their value would otherwise produce an empty pair, which
 *   the documented `key=value` form has no meaning for.
 *
 * The third restraint — only stamp a child that will ACTUALLY export — belongs to
 * the caller, because only the caller knows. A marker on a session that emits
 * nothing is noise, and worse, a claim that a stream exists.
 */
export function withTelemetryCoverage(existing: string, coverage: string): string | undefined {
  if (hasResourceAttribute(existing, NESSY_TELEMETRY_COVERAGE_KEY)) return undefined;
  const head = existing.trim().replace(/,+$/, '');
  const marker = `${NESSY_TELEMETRY_COVERAGE_KEY}=${coverage}`;
  return head ? `${head},${marker}` : marker;
}
