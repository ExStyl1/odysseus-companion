/**
 * F1.202 option (a) (OWNER-approved 2026-09-24) — codex's OWN ChatGPT sign-in,
 * fed from the host's ONE ChatGPT OAuth.
 *
 * ## Native-first, asked and answered
 *
 * Codex has the mechanism: `account/login/start` with
 * `{ type: "chatgptAuthTokens", accessToken, chatgptAccountId, chatgptPlanType }`
 * installs an EXTERNAL auth in the app-server, and when a request is refused
 * `401` codex asks THIS client for a fresh token through the server request
 * `account/chatgptAuthTokens/refresh` (`ChatgptAuthTokensRefreshParams` →
 * `ChatgptAuthTokensRefreshResponse`, both generated under
 * `packages/codex-protocol/generated/v2/`). Read at the pinned tag
 * `rust-v0.156.1` (`codex-protocol/manifest.json`) — STRONG tier, the source
 * the shipped binary is built from:
 *
 * - `app-server/src/request_processors/account_processor.rs`
 *   `login_chatgpt_auth_tokens_response` builds the auth with
 *   `CodexAuth::from_external_chatgpt_tokens` and installs it through
 *   `set_external_auth(ExternalAuthBridge)` — in memory, nothing is written to
 *   `auth.json` (the per-session `CODEX_HOME` stays empty of credentials).
 * - `app-server/src/external_auth.rs` `ExternalAuthBridge::refresh` sends the
 *   refresh request with a 10 s ceiling (`EXTERNAL_AUTH_REFRESH_TIMEOUT`) and,
 *   deliberately, logs only the error CODE of a refused answer ("Don't log
 *   err.message because it may contain a token").
 * - `login/src/auth/manager.rs` `from_external_access_token` parses the access
 *   token as a JWT and sets `refresh_token` to the empty string: codex never
 *   refreshes an external token itself, the client does. So the refresh answer
 *   is the HOST's job, from its own store, which is what this module is.
 * - `model-provider-info/src/lib.rs` `to_api_provider`: with auth mode
 *   `ChatgptAuthTokens` and codex's built-in `openai` provider (no `base_url`),
 *   turns go to `CHATGPT_CODEX_BASE_URL` = `https://chatgpt.com/backend-api/codex`
 *   — the subscription, which is why the session declares `model_provider =
 *   "openai"` (`config/llm-connections.ts` symbol `CODEX_CHATGPT_MODEL_PROVIDER`)
 *   and starts no loopback adapter.
 *
 * **Stated residue, from the same source:** the protocol marks this login
 * variant `[UNSTABLE] FOR OPENAI INTERNAL USE ONLY - DO NOT USE.` and gates it
 * behind `#[experimental("account/login/start.chatgptAuthTokens")]`
 * (`app-server-protocol/src/protocol/v2/account.rs`). This client already
 * declares `experimentalApi: true` at `initialize`, so it is reachable; the
 * marker means a codex lift may change or remove it, and the owner took the
 * option knowing that (F1.202 option (a)). Also from that docblock: *"The
 * access token must contain the same scopes that Codex-managed ChatGPT auth
 * tokens have."* Codex's own browser login asks for `openid profile email
 * offline_access api.connectors.read api.connectors.invoke`
 * (`login/src/server.rs` `build_authorize_url`); the host's shared OAuth
 * (`auth/chatgpt-oauth-config.ts`) asks for the first four only, so codex's
 * ChatGPT CONNECTORS are not covered by the token this card hands over. Turns
 * are what the card is for; the sitting measures whether a turn needs more.
 *
 * ## ONE sign-in, and why the credential is still per card
 *
 * The card reuses the host's existing ChatGPT OAuth — the same PKCE flow, the
 * same client id, the same `llm_oauth` store — rather than codex's own browser
 * login (`{ type: "chatgpt" }`, which would run a second OAuth server inside
 * the app-server). What it does NOT do is share one stored credential with
 * the Pi `chatgpt-plus` card: OpenAI refresh tokens ROTATE on use (codex's own
 * `login/src/auth/util.rs` names the refusal, `refresh_token_reused`), so two
 * cards refreshing one stored token independently would sign each other out.
 * Each card keeps its own slot under its own slug; the flow that fills it is
 * the one flow. Within this card, {@link refreshMutex} is the one refresher.
 *
 * ## Never a token in a log
 *
 * Every failure below is a {@link CodexChatGptAuthFailure} whose `reason` is
 * composed from fixed words and, at most, an HTTP status parsed out of the
 * refresh error — never the error text itself, which is the server's words
 * and could echo what was sent.
 */
import { refreshChatGptTokens as defaultRefreshChatGptTokens } from '../../../auth/chatgpt-oauth.ts';

/** The client request that installs the external auth. */
export const CODEX_ACCOUNT_LOGIN_START_METHOD = 'account/login/start';

/** The server request codex sends when the external token is refused. */
export const CODEX_CHATGPT_AUTH_TOKENS_REFRESH_METHOD = 'account/chatgptAuthTokens/refresh';

/** Ceiling on the login request; `AppServerClient.request` has none by default. */
export const CODEX_CHATGPT_LOGIN_TIMEOUT_MS = 15_000;

/**
 * The session fact a signed-in ChatGPT (Codex) runtime records — on the facts
 * channel, which a packaged build keeps, and with nothing of the account in it:
 * the workspace id is not a secret but it is the user's, and nothing reads it.
 */
export const CODEX_CHATGPT_SUBSCRIPTION_SIGNED_IN_FACT = '[ChatGPT subscription] codex is signed in with this '
  + 'connection\'s ChatGPT sign-in (account/login/start chatgptAuthTokens); turns run on the subscription '
  + 'through codex\'s own openai provider, and codex asks this host for a fresh token when one is refused.';

/**
 * A stored token is refreshed this long BEFORE its expiry — the same five
 * minutes `CredentialManager.isExpired` and the server-core auth status use, so
 * "expired" means one thing in this app.
 */
export const CODEX_CHATGPT_EXPIRY_SKEW_MS = 5 * 60 * 1000;

/** The shape `CredentialManager.getLlmOAuth` / `setLlmOAuth` read and write. */
export interface StoredChatGptOAuth {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  idToken?: string;
}

/** The two store calls this module makes — injected so a test never reads the real store. */
export interface ChatGptOAuthStore {
  get(slug: string): Promise<StoredChatGptOAuth | null>;
  set(slug: string, credentials: StoredChatGptOAuth): Promise<void>;
}

/** `ChatgptAuthTokensRefreshResponse`, which is also the payload of the login params. */
export interface CodexChatGptTokens {
  accessToken: string;
  chatgptAccountId: string;
  /**
   * Always `null`: the generated `LoginAccountParams` says *"When `null`, Codex
   * attempts to derive the plan type from access-token claims"*, and the host
   * has no better source than the same claim.
   */
  chatgptPlanType: string | null;
}

export interface CodexChatGptAuthFailure {
  ok: false;
  /** A user-facing sentence; composed from fixed words, never from a token. */
  reason: string;
}

export type CodexChatGptTokenResult = { ok: true; tokens: CodexChatGptTokens } | CodexChatGptAuthFailure;

export interface ResolveCodexChatGptTokensDeps {
  store: ChatGptOAuthStore;
  /** Defaults to `auth/chatgpt-oauth.ts`'s `refreshChatGptTokens`. */
  refresh?: (refreshToken: string) => Promise<{
    accessToken: string;
    idToken?: string;
    refreshToken?: string;
    expiresAt?: number;
  }>;
  now?: () => number;
}

export interface ResolveCodexChatGptTokensOptions {
  /**
   * The access token codex REFUSED (the refresh request path). When the store
   * still holds exactly this token, it is refreshed; when it holds another, a
   * sibling session already refreshed and the stored one is handed over as is
   * — a second refresh would burn the rotated refresh token for nothing.
   */
  rejectedAccessToken?: string;
}

/** The JWT claim namespace codex reads (`login/src/token_data.rs`, `IdClaims.auth`). */
const OPENAI_AUTH_CLAIM = 'https://api.openai.com/auth';

/**
 * The ChatGPT workspace id carried in a token's `https://api.openai.com/auth`
 * claim, or `null`. Decoded, never verified: it is a routing hint codex itself
 * reads the same way (`parse_chatgpt_jwt_claims`), and the backend verifies.
 */
export function chatgptAccountIdFromJwt(jwt: string | undefined): string | null {
  if (!jwt) return null;
  const parts = jwt.split('.');
  if (parts.length !== 3 || !parts[1]) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as unknown;
    if (!payload || typeof payload !== 'object') return null;
    const auth = (payload as Record<string, unknown>)[OPENAI_AUTH_CLAIM];
    if (!auth || typeof auth !== 'object') return null;
    const id = (auth as Record<string, unknown>).chatgpt_account_id;
    return typeof id === 'string' && id.trim() === id && id.length > 0 ? id : null;
  } catch {
    return null;
  }
}

/** The `account/login/start` params for a resolved token set. */
export function buildCodexChatGptLoginParams(tokens: CodexChatGptTokens): {
  type: 'chatgptAuthTokens';
  accessToken: string;
  chatgptAccountId: string;
  chatgptPlanType: string | null;
} {
  return {
    type: 'chatgptAuthTokens',
    accessToken: tokens.accessToken,
    chatgptAccountId: tokens.chatgptAccountId,
    chatgptPlanType: tokens.chatgptPlanType,
  };
}

/**
 * One refresher per card, process-wide. Two codex sessions on the same card
 * meeting a `401` together must not both spend the one-use refresh token.
 */
const refreshMutex = new Map<string, Promise<CodexChatGptTokenResult>>();

function isExpired(stored: StoredChatGptOAuth, now: number): boolean {
  return typeof stored.expiresAt === 'number' && now > stored.expiresAt - CODEX_CHATGPT_EXPIRY_SKEW_MS;
}

function toTokens(stored: StoredChatGptOAuth): CodexChatGptTokenResult {
  const chatgptAccountId = chatgptAccountIdFromJwt(stored.idToken) ?? chatgptAccountIdFromJwt(stored.accessToken);
  if (!chatgptAccountId) {
    return {
      ok: false,
      reason: 'The ChatGPT sign-in on this connection names no ChatGPT workspace, so codex cannot use it. Sign in again.',
    };
  }
  return { ok: true, tokens: { accessToken: stored.accessToken, chatgptAccountId, chatgptPlanType: null } };
}

/** An HTTP status out of `refreshChatGptTokens`' error, and nothing else of its text. */
function refreshFailureReason(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  const status = /\b([45]\d\d)\b/.exec(message)?.[1];
  return 'The ChatGPT sign-in on this connection could not be refreshed'
    + (status ? ` (HTTP ${status})` : '')
    + '. Sign in again.';
}

/**
 * Codex's own words about a refused sign-in, made safe to quote: every token
 * handed over is cut out verbatim, and so is anything else shaped like one (a
 * run of 24+ base64url characters), because a parser error can echo input.
 * Collapsed to one line and bounded.
 */
export function scrubCodexChatGptAuthText(text: string, tokens?: Partial<CodexChatGptTokens>): string {
  let out = text;
  const secret = tokens?.accessToken;
  if (secret) out = out.split(secret).join('[redacted]');
  return out
    .replace(/[A-Za-z0-9_-]{24,}(?:\.[A-Za-z0-9_-]+)*/g, '[redacted]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}

/**
 * The tokens to hand codex for `slug`: the stored ones when they are still
 * good, a refreshed set when they have expired — or, on the refresh-request
 * path, when codex refused exactly the one the store holds.
 */
export async function resolveCodexChatGptTokens(
  slug: string,
  deps: ResolveCodexChatGptTokensDeps,
  options: ResolveCodexChatGptTokensOptions = {},
): Promise<CodexChatGptTokenResult> {
  const now = deps.now ?? Date.now;
  const stored = await deps.store.get(slug);
  if (!stored?.accessToken) {
    return { ok: false, reason: 'This connection is not signed in to ChatGPT. Sign in again.' };
  }
  const refused = options.rejectedAccessToken !== undefined && stored.accessToken === options.rejectedAccessToken;
  if (!refused && !isExpired(stored, now())) return toTokens(stored);

  const inFlight = refreshMutex.get(slug);
  if (inFlight) return inFlight;
  const refreshing = (async (): Promise<CodexChatGptTokenResult> => {
    // Re-read inside the lock: a refresher that finished between the read
    // above and this line has already rotated the token.
    const current = await deps.store.get(slug);
    if (!current?.accessToken) {
      return { ok: false, reason: 'This connection is not signed in to ChatGPT. Sign in again.' };
    }
    const stillRefused = options.rejectedAccessToken !== undefined && current.accessToken === options.rejectedAccessToken;
    if (!stillRefused && !isExpired(current, now())) return toTokens(current);
    if (!current.refreshToken) {
      return { ok: false, reason: 'The ChatGPT sign-in on this connection has expired and cannot be renewed. Sign in again.' };
    }
    let next: Awaited<ReturnType<NonNullable<ResolveCodexChatGptTokensDeps['refresh']>>>;
    try {
      next = await (deps.refresh ?? defaultRefreshChatGptTokens)(current.refreshToken);
    } catch (error) {
      return { ok: false, reason: refreshFailureReason(error) };
    }
    const renewed: StoredChatGptOAuth = {
      accessToken: next.accessToken,
      refreshToken: next.refreshToken ?? current.refreshToken,
      ...(next.expiresAt !== undefined ? { expiresAt: next.expiresAt } : {}),
      ...(next.idToken ?? current.idToken ? { idToken: next.idToken ?? current.idToken } : {}),
    };
    await deps.store.set(slug, renewed);
    return toTokens(renewed);
  })();
  refreshMutex.set(slug, refreshing);
  try {
    return await refreshing;
  } finally {
    if (refreshMutex.get(slug) === refreshing) refreshMutex.delete(slug);
  }
}

/**
 * The answer to `account/chatgptAuthTokens/refresh`: fresh tokens, or a throw
 * whose message is the token-free reason — `AppServerClient` turns a throw into
 * a JSON-RPC error, which codex reports by CODE only.
 *
 * `previousAccountId` is codex's hint for a multi-workspace client; this card
 * holds exactly one sign-in, so it is read only to refuse a mismatch honestly
 * rather than to answer with a different workspace than the one codex asked
 * about.
 */
export async function answerCodexChatGptAuthTokensRefresh(
  slug: string,
  params: unknown,
  lastHandedAccessToken: string | undefined,
  deps: ResolveCodexChatGptTokensDeps,
): Promise<CodexChatGptTokens> {
  const result = await resolveCodexChatGptTokens(slug, deps, lastHandedAccessToken !== undefined
    ? { rejectedAccessToken: lastHandedAccessToken }
    : {});
  if (!result.ok) throw new Error(result.reason);
  const previous = params && typeof params === 'object'
    ? (params as { previousAccountId?: unknown }).previousAccountId
    : undefined;
  if (typeof previous === 'string' && previous.length > 0 && previous !== result.tokens.chatgptAccountId) {
    throw new Error('The ChatGPT sign-in on this connection now names a different workspace than codex was using. Start a new session.');
  }
  return result.tokens;
}
