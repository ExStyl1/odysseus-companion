/**
 * The `/quota` read against the Nessy Gateway — client, renderer and error
 * shaping, shared by every runtime that sits behind that budget.
 *
 * Extracted from `nestor-cloud-agent.ts` (T19) when the command widened to the
 * built-in Pi Nessy Gateway connection: the daily budget this route reports is
 * the per-user `qwen35`-pool limit, and the SAME limiter meters the CLI-proxy
 * routes the Pi card talks through (`cli_proxy_handler.go:109,:205,:286-298`).
 * Two agents answering one question must not grow two renderers — the behaviour
 * here is the nestor-cloud behaviour, byte for byte, and
 * `nestor-cloud-agent-quota.test.ts` still passes UNCHANGED as the proof.
 */
import type { AgentEvent } from '@nessy-agent/core/types';
import { buildNestorCloudAuthHeaders } from '../nestor-cloud/auth.ts';
import { redactNestorSecrets } from '../nestor-cloud/client.ts';
import { NestorCloudClientError } from '../nestor-cloud/types.ts';
import { capNestorErrorMessage, readNestorErrorBodyMessage } from '../nestor-cloud/retry.ts';

/**
 * The ONE quota route the backend serves (`httpserver/handler.go:309-310`).
 * Deliberately `/api/v1/` and NOT a sibling of the a2a endpoint: quota is
 * registered outside the a2a versioning scheme (alongside `/api/v1/flags`) and
 * has no v2 variant, so the v2 wire migration does not move it. It carries no
 * `userLimitMiddleware`, i.e. reading the quota does not consume it.
 */
const NESTOR_QUOTA_PATH = '/api/v1/quota';
const NESTOR_QUOTA_URL = `https://code-completion-nestor.tcsbank.ru${NESTOR_QUOTA_PATH}`;
export const NESTOR_QUOTA_TIMEOUT_MS = 10_000;

/**
 * F1.6 (origin D1.77) — one cancellable gateway-budget read, for the two gateway
 * cards whose runtime has no budget read of its own.
 * `claude-gateway` and `codex-gateway` carry the Pi gateway card's base URL, dp
 * prefill and per-user limiter, so `/quota` on them answers with the SAME read
 * {@link describeNestorQuota} gives the Pi card (OWNER 2026-09-18 item 3). This
 * replaced DA1.17's pointer sentence: a card that can SHOW the number must not
 * also point elsewhere for it. All it adds is Stop — `/quota` answers at the
 * `BaseAgent.chat` seam outside any turn controller, so each owner calls
 * {@link abort} from its hard-stop paths (`PiAgent` spells the same inline).
 */
export class NessyGatewayQuotaRead {
  private inFlight: AbortController | null = null;
  async *describe(options: Omit<NestorQuotaReadOptions, 'cancelSignal'>): AsyncGenerator<AgentEvent> {
    const read = new AbortController();
    this.inFlight = read;
    try {
      yield* describeNestorQuota({ ...options, cancelSignal: read.signal });
    } finally {
      if (this.inFlight === read) this.inFlight = null;
    }
  }
  abort(): void { this.inFlight?.abort(); }
}

/**
 * The quota read goes to the host this CONNECTION addresses, not to a compiled-in
 * production hostname: the `Nestor-Token` rides this request, and a connection
 * pointed at another deployment would otherwise have its credential sent to a
 * third party that was never asked for. Only the ORIGIN is taken from
 * `runtime.baseUrl` — the path is fixed, because the route exists exactly once
 * and outside the a2a versioning scheme (so a `/api/v2/...` baseUrl still reads
 * `/api/v1/quota`, and so does the CLI-proxy baseUrl the Pi card carries). An
 * absent or unparseable baseUrl falls back to the constant, which is what a
 * default gateway connection resolves to anyway.
 */
export function resolveNestorQuotaUrl(baseUrl: unknown): string {
  if (typeof baseUrl !== 'string' || !baseUrl.trim()) return NESTOR_QUOTA_URL;
  try {
    return new URL(NESTOR_QUOTA_PATH, new URL(baseUrl).origin).toString();
  } catch {
    return NESTOR_QUOTA_URL;
  }
}

/** `QuotaLimit` (`httpserver/api.go:1406-1443`); every field defensive. */
interface NestorQuotaLimit {
  id?: string;
  display?: { title?: string; description?: string };
  scope?: { type?: string; values?: string[] };
  usage?: number;
  status?: { state?: string; severity?: string; message?: string };
  reset_at?: string;
}

interface NestorQuotaResponse {
  schema_version?: string;
  generated_at?: string;
  limits?: NestorQuotaLimit[];
}

/**
 * One rendered limit line.
 *
 * `usage` is a WEIGHTED-token ratio in [0,1] and absolute token counts are
 * never exposed (`userlimit.go:44-60`), so "N% remaining" is the only
 * quantitative statement available — there is no "X of Y".
 *
 * The VERDICT is the backend's `status`, never recomputed from `usage`:
 * `quota_handler.go:18` mandates that clients read `status` "instead of
 * deriving availability from quota values". `status.state`
 * (`allowed`/`warning`/`exhausted`, `userlimit.go:20,80-92`) is that authority
 * and therefore rides the HEAD of every line — `status.message` is prose that
 * may be empty, and a line that showed only the message would show nothing at
 * all when it is. The message is still printed verbatim when present.
 *
 * On `exhausted` the "% remaining" clause is dropped outright rather than
 * qualified: `usage` and `state` are not written together, so an exhausted
 * limiter really can arrive with `usage: 0`, and "100% remaining" next to it is
 * a flat contradiction the reader would resolve the wrong way.
 *
 * The two limiters additionally share one id AND one title
 * (`userlimit.go:63-64`) and are told apart only by `scope.values`
 * (`main.go:70-75`), so the scope rides the head or the two lines are
 * indistinguishable.
 */
export function formatNestorQuotaLimit(limit: NestorQuotaLimit): string {
  const title = limit.display?.title?.trim() || limit.id?.trim() || 'Quota';
  const scope = (limit.scope?.values ?? [])
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .join(', ');
  // Printed verbatim and lowercased only for stability — an unknown state
  // (the doc promises new ones may appear) must reach the user as itself
  // rather than be dropped for not matching a known enum member.
  const state = limit.status?.state?.trim().toLowerCase() || null;
  const scoped = scope ? `${title} [${scope}]` : title;
  const head = state ? `${scoped} (${state})` : scoped;

  const usage = typeof limit.usage === 'number' && Number.isFinite(limit.usage)
    ? Math.min(1, Math.max(0, limit.usage))
    : null;
  const remaining = usage === null || state === 'exhausted'
    ? null
    : `${Math.round((1 - usage) * 100)}% remaining`;
  const message = limit.status?.message?.trim() || null;

  const body = [remaining, message].filter((part): part is string => Boolean(part)).join(' — ');
  // `reset_at` is authoritative and may be absent (it exists only when the
  // concrete token-usage storage is behind the interface, `userlimit.go:72`).
  // Printed raw: it is ~11:00 Europe/Moscow, NOT the 00:00 the 429 string
  // promises (`tokenusage.go:22`), so no derived wording may restate it.
  const reset = limit.reset_at?.trim() ? ` (resets ${limit.reset_at.trim()})` : '';

  return body ? `- ${head}: ${body}${reset}` : `- ${head}${reset}`;
}

export interface NestorQuotaReadOptions {
  /** The transport seam — the one thing that keeps tests off the live gateway. */
  fetchImpl: typeof fetch;
  /** Credential file override; absent means the real `~/.nessy` store. */
  credsPath?: string;
  /** The connection's own baseUrl; only its ORIGIN is used. */
  baseUrl?: unknown;
  /**
   * The caller's teardown/Stop signal, composed with the timeout. Without one
   * the read is bound only to the 10s timeout and a user's Stop does nothing
   * for ten seconds. Its `aborted` flag is also what distinguishes a cancelled
   * read from a failed one in the catch below.
   */
  cancelSignal?: AbortSignal;
}

/**
 * Read the budget and yield the events that answer `/quota`.
 *
 * Never throws: a budget read that fails must not end the turn as an error, so
 * every failure becomes one `info`, with the reason put through
 * {@link redactNestorSecrets} — the token is in the request headers and a
 * transport error is free to quote them back.
 *
 * LEVEL policy (owner decision, T17 review): `warning` is reserved for an AUTH
 * failure (401/403), the one outcome the user can act on — re-signing in. A
 * transport error, a 5xx, or an unparseable body is a blip, and the renderer
 * treats `warning` as a standing banner: a momentary gateway hiccup must not
 * leave one behind. Those, and every successful render, are plain transient
 * `info`.
 */
export async function* describeNestorQuota(
  options: NestorQuotaReadOptions,
): AsyncGenerator<AgentEvent> {
  const timeout = AbortSignal.timeout(NESTOR_QUOTA_TIMEOUT_MS);
  const signal = options.cancelSignal
    ? AbortSignal.any([timeout, options.cancelSignal])
    : timeout;
  let token: string | undefined;
  // Destructured so the call keeps the ORIGINAL receiver (this = undefined):
  // `options.fetchImpl(...)` binds `this` to the options object, and a
  // browser/renderer `fetch` reached that way throws "Illegal invocation".
  const { fetchImpl } = options;
  try {
    const auth = buildNestorCloudAuthHeaders(options.credsPath ? { credsPath: options.credsPath } : {});
    token = auth.token;
    const response = await fetchImpl(resolveNestorQuotaUrl(options.baseUrl), {
      method: 'GET',
      headers: { ...auth.headers, Accept: 'application/json' },
      signal,
    });
    if (!response.ok) {
      // The envelope is unwrapped BEFORE redaction, exactly as the 429 path
      // does it (T14): `redactNestorSecrets` replaces any `{…}` run wholesale,
      // so redacting the raw `{"message":"failed to read quota status"}` body
      // would hand the user "[redacted-payload]" and destroy the one sentence
      // that says what happened. Capped, because the body is the gateway's to
      // choose and nothing else bounds it.
      const detail = readNestorErrorBodyMessage(await response.text().catch(() => ''));
      const redacted = detail ? capNestorErrorMessage(redactNestorSecrets(detail, token)) : '';
      const head = `Quota is unavailable: the gateway answered HTTP ${response.status}.`;
      const authFailure = response.status === 401 || response.status === 403;
      yield {
        type: 'info',
        ...(authFailure ? { level: 'warning' as const } : {}),
        message: redacted ? `${head} ${redacted}` : head,
      };
      return;
    }
    const snapshot = await response.json() as NestorQuotaResponse;
    const limits = Array.isArray(snapshot?.limits) ? snapshot.limits : [];
    if (limits.length === 0) {
      // A disabled limiter returns an EMPTY list (`quota_handler.go:36-41`).
      // That is "no quota applies", the opposite of exhausted — deriving
      // "you are out" from an empty array is the failure this line prevents.
      yield { type: 'info', message: 'No quota limits apply to your account.' };
      return;
    }
    yield {
      type: 'info',
      message: ['Quota:', ...limits.map(formatNestorQuotaLimit)].join('\n'),
    };
  } catch (err) {
    if (options.cancelSignal?.aborted) {
      // The user stopped it. Same shape as every other outcome — an info,
      // never a throw — because a cancelled budget read is not a turn error.
      yield { type: 'info', message: 'Quota read was cancelled.' };
      return;
    }
    const reason = err instanceof Error ? err.message : String(err);
    // Missing/expired dp credentials are the auth failure the level policy
    // reserves `warning` for: the user can act (re-sign-in), and on the Pi
    // gateway card the JWT expires independently of the connection, so this
    // path is reachable in ordinary use — unlike a transient transport blip.
    const missingToken = err instanceof NestorCloudClientError && err.code === 'missing-token';
    yield {
      type: 'info',
      ...(missingToken ? { level: 'warning' as const } : {}),
      message: capNestorErrorMessage(redactNestorSecrets(`Quota is unavailable: ${reason}`, token)),
    };
  }
}
