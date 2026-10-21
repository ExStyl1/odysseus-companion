/**
 * P3.98 + P3.122 — MODEL SPEND THE HOST CAUSED, WHICH NO USAGE SURFACE COUNTED.
 *
 * `modelUsage` describes the turn the user asked for. Some model calls are not
 * that: the runtime makes them because of how WE configured it, they are billed
 * to the same gateway account, and they appear in no accounting this product
 * reports. An operator reading our cost attribution therefore sees less than
 * they are charged, and the gap grows with exactly the sessions we encourage.
 *
 * Owner-delegated controller decision 2026-09-02 (§E1): **report these as a
 * separate host-overhead line, not folded into per-turn model usage.** The
 * reporting contract lives in `usage-metrics.ts` ({@link UsageScope}); this
 * module owns the vocabulary of sources and how one is recognised on the wire.
 *
 * ## The measured source, and its size
 *
 * The Claude SDK's auto-mode classifier. Measured by P3.93's rig and costed by
 * P3.122: **110,519 characters of system prompt per check, twice on the first
 * auto-mode action** (P3.121 puts it at roughly 24.2k input tokens a hop, with a
 * median 7.5 s of added latency). It is billed to our gateway because the child
 * reaches the model through the loopback adapter like every other request, and
 * it is excluded from `modelUsage` because the SDK does not report it there.
 *
 * ## What is honest to say about it TODAY, stated rather than implied
 *
 * **In the shipped configuration the classifier is consulted on approximately
 * nothing.** P3.93 measured five arms: with our own PreToolUse hook returning
 * `allow` — what we ship — the classifier ran **zero** times, against a positive
 * control of **two** requests on the same rig with no hook. `buildClaudePre-
 * ToolUseContinue` names `allow` or `ask` on every path but two defensive
 * guards, so the fall-through that reaches the classifier is unreachable in
 * practice, and P3.139 decided to leave it that way — off, one flag away, with
 * the numbers recorded.
 *
 * So this line is expected to read ZERO until that flag moves. That is a
 * feature, not an excuse: a zero here is a **reading**, where the previous state
 * of the world was a figure that silently omitted the cost. And it is why the
 * cheap half is worth doing now — the day P3.139 is revisited, the cost shows up
 * in the operator's own metrics instead of only on the bill.
 *
 * ## What is NOT wired here, and exactly what would wire it
 *
 * The observation point is the loopback adapter's `/v1/messages` handler
 * (`packages/codex-responses-adapter/src/server.ts`, `handleMessages`) — the one
 * place where both the inbound request (which {@link classifyHostOverheadSource}
 * reads) and the upstream's own `usage` are in scope. That file belongs to
 * another lane this wave, so the call is REPORTED rather than taken: one
 * `classifyHostOverheadSource(body.system)` on the inbound body, and a
 * `usageMetrics.record(hostOverheadTurn(...))` with the upstream's token counts
 * when it answers non-null.
 *
 * Until that lands, nothing calls this — which is said out loud here so nobody
 * reads the module as evidence that the counting happens.
 *
 * ## Why detection is by PROMPT and not by model id
 *
 * The classifier asks for its own default model, `claude-sonnet-5`, which our
 * gateway does not serve, and the binary then FALLS BACK to the session's model
 * (P3.121 measured that fallback and the whole mechanism rests on it). So the
 * model id on a classifier request is, in the ordinary case, the same id the
 * conversation uses; keying on it would either miss every hop or misattribute
 * every turn. The system prompt is the thing that actually differs.
 */
import type { UsageMetricsTurn } from './usage-metrics.ts';

/**
 * The sources, as a totality-checked record rather than a union alone: adding a
 * member forces every reader that switches on it to be updated, and a source
 * nobody can name is a source nobody can filter by in a dashboard.
 *
 * The value is the `overhead_source` attribute exported for it — stable, because
 * an operator's query is written against this string.
 */
export const HOST_OVERHEAD_SOURCES = Object.freeze({
  /** The Claude SDK's auto-mode permission classifier (P3.93, P3.121, P3.122). */
  autoModeClassifier: 'auto-mode-classifier',
} as const);

export type HostOverheadSource = (typeof HOST_OVERHEAD_SOURCES)[keyof typeof HOST_OVERHEAD_SOURCES];

/**
 * The opening of the classifier's own system prompt, as the shipped binary sends
 * it — captured off the wire by `claude-auto-mode-classifier-gateway-e2e.test.ts`,
 * which holds the same literal for the same reason.
 *
 * A PREFIX of a ~110 KB prompt, matched as a substring. Deliberately not a hash
 * or an exact-length check: the prompt's tail carries our own
 * `claude-auto-mode-policy.ts` rules spliced in, so it changes whenever that
 * policy changes, and a detector that broke on our own configuration edit would
 * be a detector that silently stops detecting.
 */
export const CLAUDE_AUTO_MODE_CLASSIFIER_SYSTEM_MARKER =
  'You are a security monitor for autonomous AI coding agents';

/**
 * Flatten an Anthropic Messages `system` field to text.
 *
 * The wire allows a bare string or an array of content blocks, and the SDK has
 * used both. Anything else answers `''`, which is a non-match rather than a
 * throw: a detector on a request path must never be able to fail the request.
 */
function systemText(system: unknown): string {
  if (typeof system === 'string') return system;
  if (!Array.isArray(system)) return '';
  const parts: string[] = [];
  for (const block of system) {
    if (typeof block === 'string') { parts.push(block); continue; }
    const text = (block as { text?: unknown } | null)?.text;
    if (typeof text === 'string') parts.push(text);
  }
  return parts.join('\n');
}

/**
 * Which host-overhead source, if any, an inbound request's `system` field
 * identifies. `null` means "an ordinary conversation request", which is the
 * answer for every request this product makes on its own behalf.
 */
export function classifyHostOverheadSource(system: unknown): HostOverheadSource | null {
  const text = systemText(system);
  if (!text) return null;
  if (text.includes(CLAUDE_AUTO_MODE_CLASSIFIER_SYSTEM_MARKER)) {
    return HOST_OVERHEAD_SOURCES.autoModeClassifier;
  }
  return null;
}

/** Token counts as an upstream reports them for one host-overhead call. */
export interface HostOverheadUsage {
  backend: string;
  model: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
}

/**
 * One host-overhead call, in the shape `UsageMetrics.record` takes.
 *
 * **`costReporting` is always `unsupported`, and that is a measurement rather
 * than a shortcut.** Nothing on this path establishes a USD figure: the gateway's
 * response carries token counts and no money field, and inventing one from a
 * price table would make the operator's cost line a fiction — the same rule
 * `base-agent.ts` states for the budget ceiling ("NO PRICE TABLE IS INVENTED
 * HERE"). The tokens are real and are reported; the money is not ours to claim.
 */
export function hostOverheadTurn(source: HostOverheadSource, usage: HostOverheadUsage): UsageMetricsTurn {
  return {
    backend: usage.backend,
    scope: 'host-overhead',
    overheadSource: source,
    model: usage.model,
    ...(usage.inputTokens === undefined ? {} : { inputTokens: usage.inputTokens }),
    ...(usage.outputTokens === undefined ? {} : { outputTokens: usage.outputTokens }),
    ...(usage.cacheReadTokens === undefined ? {} : { cacheReadTokens: usage.cacheReadTokens }),
    ...(usage.cacheCreationTokens === undefined ? {} : { cacheCreationTokens: usage.cacheCreationTokens }),
    costReporting: 'unsupported',
  };
}
